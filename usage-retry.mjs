// Durable one-shot "resume when usage returns" work.
//
// A usage limit is not an ordinary send failure: retrying before the provider
// has capacity wastes a turn, while retrying after an ambiguous send can post
// the same continuation twice. Entries therefore remain durable intent until a
// fresh provider usage read proves capacity, then use the ordinary send ledger.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CHECKABLE_STATES = new Set(["waiting_usage", "waiting_thread", "checking"]);
const PENDING_STATES = new Set([...CHECKABLE_STATES, "dispatching"]);
const BLOCKING_STATES = new Set([...PENDING_STATES, "uncertain"]);
const USAGE_LIMIT_CODES = new Set([
  "credit_balance_exhausted",
  "credits_exhausted",
  "insufficient_quota",
  "monthly_spend_limit",
  "quota_exceeded",
  "rate_limit",
  "rate_limit_exceeded",
  "usage_exhausted",
  "usage_limit_exceeded",
]);
const USAGE_LIMIT_TEXT = /(?:usage|spend|rate|quota|credits?)[\s_-]*(?:limit|exhausted|exceeded|depleted)|(?:limit|quota|credits?)[\s_-]+(?:was\s+)?(?:reached|exhausted|exceeded|depleted)|monthly\s+spend|(?:out\s+of|no)\s+(?:usage|credits?|quota)|(?:usage|credits?|quota)\s+(?:is\s+|are\s+)?(?:not\s+left|unavailable|depleted)/i;

function retryError(message, code = "invalid_usage_retry", status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function clip(value, max) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= max ? text : null;
}

function numericEpoch(value) {
  const epoch = Number(value);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
}

function publicError(error) {
  return {
    message: String(error?.message ?? error ?? "unknown error").slice(0, 2000),
    code: error?.code ?? null,
    status: Number.isFinite(error?.status) ? error.status : null,
  };
}

export function usageAvailability(snapshot) {
  // Persisted usage is useful for display, but it must never authorize an
  // unattended send. This bit is supplied only by a provider probe performed
  // for this check, so account switches and transient provider failures fail
  // closed instead of using yesterday's capacity.
  if (snapshot?._capacityFresh !== true) {
    return { available: false, reason: "Waiting for a fresh provider usage check", resetAt: null };
  }

  const limits = snapshot?.rateLimits?.rateLimits ?? snapshot?.rateLimits ?? {};
  const windows = [limits.primary, limits.secondary].filter((value) => value && typeof value === "object");

  if (!windows.length) {
    return { available: false, reason: "Usage is not available yet", resetAt: null };
  }

  const currentEpoch = Date.now() / 1000;
  const currentWindows = windows.filter((limit) => !numericEpoch(limit.resetsAt) || numericEpoch(limit.resetsAt) > currentEpoch);
  const exhausted = currentWindows.filter((limit) => {
    const remaining = Number(limit.remainingPercent);
    const used = Number(limit.usedPercent);
    return (Number.isFinite(remaining) && remaining <= 0) || (Number.isFinite(used) && used >= 100);
  });

  if (exhausted.length) {
    // More than one window may be exhausted. The display is only a hint; the
    // next live poll, not this timestamp, authorizes sending.
    const resetAt = exhausted.map((limit) => numericEpoch(limit.resetsAt)).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
    return { available: false, reason: "Provider reports no remaining usage", resetAt };
  }

  const measured = currentWindows.some((limit) => Number.isFinite(Number(limit.remainingPercent)) || Number.isFinite(Number(limit.usedPercent)));
  return measured
    ? { available: true, reason: null, resetAt: null }
    : { available: false, reason: "Usage is not measured yet", resetAt: null };
}

export function isUsageLimitError(error) {
  if (error?.status === 429) { return true; }
  const rawCode = error?.code ?? error?.error ?? error?.codex_error_info;
  const code = String(rawCode ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (USAGE_LIMIT_CODES.has(code)) { return true; }
  const text = String(error?.message ?? error ?? "");
  return USAGE_LIMIT_TEXT.test(text);
}

export function usageRetryTrigger(event, data) {
  if (event === "external" && data?.observedChange === true && data?.terminalOutcome === "failed" && isUsageLimitError(data.terminalError)) {
    return data.terminalId ? {
      provider: data.provider,
      threadId: data.threadId,
      triggerId: String(data.terminalId),
    } : null;
  }

  if (event !== "notify" || !["turn/failed", "turn/completed", "turn/aborted"].includes(data?.method)) { return null; }
  const error = data.params?.error ?? data.params?.turn?.error;
  if (!isUsageLimitError(error)) { return null; }
  const threadId = data.params?.threadId;
  const terminalId = data.params?.turn?.id ?? data.params?.turnId;
  return threadId && terminalId ? {
    provider: data.provider,
    threadId,
    triggerId: `${data.provider}:${terminalId}`,
  } : null;
}

export class UsageRetryStore {
  constructor({ file, now = () => Date.now() } = {}) {
    if (!file) { throw new Error("usage retry file required"); }
    this.file = file;
    this.now = now;
    this.entries = new Map();
    this.load();
  }

  load() {
    let rows;
    try { rows = JSON.parse(readFileSync(this.file, "utf8")); } catch { return; }
    if (!Array.isArray(rows)) { return; }
    let repaired = false;

    for (const row of rows) {
      if (!row?.id || !row.provider || !row.threadId || !row.requestId) { continue; }
      // A bridge cannot know whether an in-flight send survived its crash.
      // Surface it as uncertain and never resume it automatically.
      if (row.state === "dispatching") {
        row.state = "uncertain";
        row.error = { message: "Bridge restarted while sending; check the thread before retrying", code: "delivery_uncertain", status: 504 };
        repaired = true;
      }
      this.entries.set(row.id, row);
    }
    if (repaired) { this.persist(); }
  }

  persist() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.entries.values()], null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, this.file);
  }

  list({ provider, threadId, activeOnly = false } = {}) {
    return [...this.entries.values()]
      .filter((entry) => (!provider || entry.provider === provider) && (!threadId || entry.threadId === threadId) && (!activeOnly || BLOCKING_STATES.has(entry.state)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => structuredClone(entry));
  }

  create(input = {}) {
    const id = clip(input.id, 160);
    const provider = clip(input.provider, 40);
    const threadId = clip(input.threadId, 300);
    const requestId = clip(input.requestId, 200);
    const text = clip(input.text, 16000);
    if (!id || !provider || !threadId || !requestId || !text) {
      throw retryError("id, provider, threadId, requestId, and text are required");
    }

    const triggerId = clip(input.triggerId, 300);
    const duplicate = [...this.entries.values()].find((entry) =>
      entry.provider === provider && entry.threadId === threadId
      && ((triggerId && entry.triggerId === triggerId) || BLOCKING_STATES.has(entry.state))
    );
    if (duplicate) { return structuredClone(duplicate); }

    const existing = this.entries.get(id);
    if (existing) { return structuredClone(existing); }
    const now = this.now();
    const entry = {
      id, provider, threadId, requestId, text,
      triggerId,
      dispatch: structuredClone(input.dispatch ?? {}),
      state: "waiting_usage",
      createdAt: now,
      updatedAt: now,
      nextCheckAt: now,
      lastCheckedAt: null,
      resetAt: null,
      account: null,
      error: null,
      attempts: 0,
    };
    this.entries.set(id, entry);
    this.persist();
    return structuredClone(entry);
  }

  get(id) {
    const entry = this.entries.get(String(id ?? ""));
    return entry ? structuredClone(entry) : null;
  }

  update(id, patch = {}) {
    const entry = this.entries.get(String(id ?? ""));
    if (!entry) { throw retryError("usage resume request not found", "usage_retry_not_found", 404); }
    Object.assign(entry, structuredClone(patch), { updatedAt: this.now() });
    this.persist();
    return structuredClone(entry);
  }

  cancel(id) {
    const entry = this.entries.get(String(id ?? ""));
    if (!entry) { throw retryError("usage resume request not found", "usage_retry_not_found", 404); }
    if (entry.state === "dispatching") {
      throw retryError("Continue is already being sent and can no longer be cancelled", "usage_retry_dispatching", 409);
    }
    return this.update(id, { state: "cancelled", nextCheckAt: null, error: null });
  }

  supersedeThread(provider, threadId, { turnId = null } = {}) {
    const changed = [];
    for (const entry of this.entries.values()) {
      if (entry.provider !== provider || entry.threadId !== threadId || !CHECKABLE_STATES.has(entry.state)) { continue; }
      entry.state = "superseded";
      entry.nextCheckAt = null;
      entry.error = null;
      entry.supersededByTurnId = clip(turnId, 300);
      entry.updatedAt = this.now();
      changed.push(structuredClone(entry));
    }
    if (changed.length) { this.persist(); }
    return changed;
  }

  due() {
    const now = this.now();
    return [...this.entries.values()]
      .filter((entry) => CHECKABLE_STATES.has(entry.state) && Number(entry.nextCheckAt) <= now)
      .map((entry) => structuredClone(entry));
  }

  wake(provider) {
    const now = this.now();
    const changed = [];
    for (const entry of this.entries.values()) {
      if (entry.provider !== provider || !CHECKABLE_STATES.has(entry.state)) { continue; }
      entry.nextCheckAt = now;
      entry.updatedAt = now;
      changed.push(structuredClone(entry));
    }
    if (changed.length) { this.persist(); }
    return changed;
  }
}

export class UsageRetryRunner {
  constructor({ store, now = () => Date.now(), readUsage, readRuntime, send, onUpdate = () => {}, pollMs = 60_000 } = {}) {
    if (!store || !readUsage || !readRuntime || !send) { throw new Error("usage retry runner requires store, readUsage, readRuntime, and send"); }
    this.store = store;
    this.now = now;
    this.readUsage = readUsage;
    this.readRuntime = readRuntime;
    this.send = send;
    this.onUpdate = onUpdate;
    this.pollMs = pollMs;
    this.inFlight = new Set();
  }

  publish(entry) {
    this.onUpdate(entry);
    return entry;
  }

  async check(id) {
    if (this.inFlight.has(id)) { return this.store.get(id); }
    this.inFlight.add(id);

    try {
      let entry = this.store.get(id);
      if (!entry || !CHECKABLE_STATES.has(entry.state)) { return entry; }
      const now = this.now();
      entry = this.store.update(id, { state: "checking", lastCheckedAt: now, error: null });
      this.publish(entry);

      let usage;
      try {
        usage = await this.readUsage(entry.provider);
      } catch (error) {
        const current = this.store.get(id);
        if (!current || !CHECKABLE_STATES.has(current.state)) { return current; }
        return this.publish(this.store.update(id, {
          state: "waiting_usage",
          nextCheckAt: now + this.pollMs,
          error: publicError(error),
        }));
      }

      entry = this.store.get(id);
      if (!entry || !CHECKABLE_STATES.has(entry.state)) { return entry; }

      const capacity = usageAvailability(usage);
      if (!capacity.available) {
        return this.publish(this.store.update(id, {
          state: "waiting_usage",
          nextCheckAt: now + this.pollMs,
          resetAt: capacity.resetAt,
          account: usage?.account ?? null,
          error: capacity.reason ? { message: capacity.reason, code: "usage_unavailable", status: null } : null,
        }));
      }

      let runtime;
      try {
        runtime = await this.readRuntime(entry.provider, entry.threadId);
      } catch (error) {
        const current = this.store.get(id);
        if (!current || !CHECKABLE_STATES.has(current.state)) { return current; }
        return this.publish(this.store.update(id, {
          state: "waiting_thread",
          nextCheckAt: now + this.pollMs,
          error: publicError(error),
        }));
      }
      entry = this.store.get(id);
      if (!entry || !CHECKABLE_STATES.has(entry.state)) { return entry; }
      if (runtime?.running) {
        return this.publish(this.store.update(id, {
          state: "waiting_thread",
          nextCheckAt: now + this.pollMs,
          resetAt: null,
          account: usage?.account ?? null,
          error: null,
        }));
      }

      entry = this.store.update(id, {
        state: "dispatching",
        nextCheckAt: null,
        resetAt: null,
        account: usage?.account ?? null,
        error: null,
        attempts: Number(entry.attempts ?? 0) + 1,
      });
      this.publish(entry);

      try {
        await this.send(entry);
        return this.publish(this.store.update(id, { state: "accepted", nextCheckAt: null, error: null }));
      } catch (error) {
        if (isUsageLimitError(error)) {
          return this.publish(this.store.update(id, {
            state: "waiting_usage",
            nextCheckAt: this.now() + this.pollMs,
            error: publicError(error),
          }));
        }
        // A turn that appeared after the idle check has already resumed the
        // thread. Re-arming this fallback would send an extra Continue after
        // that newer work ends. This also closes the race where turn/started
        // arrived while this entry was briefly `dispatching`.
        if (error?.code === "turn_in_progress") {
          return this.publish(this.store.update(id, {
            state: "superseded",
            nextCheckAt: null,
            error: null,
          }));
        }
        if (["thread_locked_elsewhere", "not_our_turn"].includes(error?.code)) {
          return this.publish(this.store.update(id, {
            state: "waiting_thread",
            nextCheckAt: this.now() + this.pollMs,
            error: publicError(error),
          }));
        }
        const uncertain = error?.code === "delivery_uncertain" || error?.status == null || error?.status >= 500;
        return this.publish(this.store.update(id, {
          state: uncertain ? "uncertain" : "failed",
          nextCheckAt: null,
          error: publicError(error),
        }));
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  async tick() {
    const rows = this.store.due();
    await Promise.all(rows.map((entry) => this.check(entry.id)));
    return rows.length;
  }
}

export class UsageRetryPolicyStore {
  constructor({ file } = {}) {
    if (!file) { throw new Error("usage retry policy file required"); }
    this.file = file;
    this.value = { globalEnabled: false, threads: {} };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.value.globalEnabled = parsed.globalEnabled === true;
        if (parsed.threads && typeof parsed.threads === "object" && !Array.isArray(parsed.threads)) {
          this.value.threads = Object.fromEntries(Object.entries(parsed.threads).filter(([, enabled]) => typeof enabled === "boolean"));
        }
      }
    } catch {}
  }

  key(provider, threadId) {
    const p = clip(provider, 40);
    const id = clip(threadId, 300);
    if (!p || !id) { throw retryError("provider and threadId are required"); }
    return `${p}:${id}`;
  }

  persist() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temp, JSON.stringify(this.value, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, this.file);
  }

  get(provider, threadId) {
    const override = this.value.threads[this.key(provider, threadId)];
    return {
      globalEnabled: this.value.globalEnabled,
      threadOverride: typeof override === "boolean" ? override : null,
      enabled: typeof override === "boolean" ? override : this.value.globalEnabled,
    };
  }

  setGlobal(enabled) {
    if (typeof enabled !== "boolean") { throw retryError("enabled must be a boolean"); }
    this.value.globalEnabled = enabled;
    this.persist();
    return { globalEnabled: enabled };
  }

  isGlobalEnabled() {
    return this.value.globalEnabled;
  }

  interests() {
    const rows = [];
    for (const [key, enabled] of Object.entries(this.value.threads)) {
      if (!enabled) { continue; }
      const split = key.indexOf(":");
      if (split > 0) { rows.push({ provider: key.slice(0, split), id: key.slice(split + 1) }); }
    }
    return rows;
  }

  setThread(provider, threadId, enabled) {
    const key = this.key(provider, threadId);
    if (enabled == null) { delete this.value.threads[key]; }
    else if (typeof enabled === "boolean") { this.value.threads[key] = enabled; }
    else { throw retryError("enabled must be true, false, or null"); }
    this.persist();
    return this.get(provider, threadId);
  }
}
