// Durable one-shot "resume when usage returns" work.
//
// A usage limit is not an ordinary send failure: retrying before the provider
// has capacity wastes a turn, while retrying after an ambiguous send can post
// the same continuation twice. Entries therefore remain durable intent until a
// fresh provider usage read proves capacity, then use the ordinary send ledger.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CHECKABLE_STATES = new Set(["waiting_usage", "waiting_thread", "waiting_provider", "checking"]);
const PENDING_STATES = new Set([...CHECKABLE_STATES, "dispatching"]);
const BLOCKING_STATES = new Set([...PENDING_STATES, "uncertain"]);
const ACCEPTED_REARM_WINDOW_MS = 10 * 60_000;
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

export function userProgressFromThread(full) {
  const users = (full?.thread?.turns ?? [])
    .flatMap((turn) => turn.items ?? [])
    .filter((item) => item?.type === "userMessage");
  const last = users.at(-1);
  return {
    userCount: users.length,
    lastUserId: last?.id ? String(last.id).slice(0, 300) : null,
  };
}

export function userProgressThroughTurn(full, terminalId) {
  const expected = String(terminalId ?? "").trim().replace(/^[^:]+:/, "");
  if (!expected) { return null; }
  const turns = full?.thread?.turns ?? [];
  let userCount = 0;
  let lastUserId = null;

  for (const turn of turns) {
    for (const item of turn?.items ?? []) {
      if (item?.type !== "userMessage") { continue; }
      userCount += 1;
      lastUserId = item.id ? String(item.id).slice(0, 300) : null;
    }
    if (String(turn?.id ?? "") === expected) { return { userCount, lastUserId }; }
  }
  return null;
}

function progressRelation(guard, current) {
  const before = Number(guard?.userCount);
  const after = Number(current?.userCount);
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || before < 0 || after < before) { return "unreadable"; }
  if (after > before) { return "advanced"; }
  if (guard?.lastUserId && current?.lastUserId && guard.lastUserId !== current.lastUserId) { return "unreadable"; }
  return "same";
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

  const envelope = snapshot?.rateLimits ?? {};
  const limits = envelope?.rateLimits ?? envelope;
  const providerExhaustion = String(envelope.rateLimitReachedType ?? limits.rateLimitReachedType ?? "").trim();
  const spendControlReached = envelope.spendControlReached === true || limits.spendControlReached === true;
  const windows = [limits.primary, limits.secondary].filter((value) => value && typeof value === "object");
  const futureResets = windows.map((limit) => numericEpoch(limit.resetsAt))
    .filter((resetAt) => resetAt && resetAt > Date.now() / 1000)
    .sort((a, b) => a - b);
  if (providerExhaustion || spendControlReached) {
    return { available: false, reason: "Provider reports no remaining usage", resetAt: futureResets[0] ?? null };
  }

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

function accountIdentity(account) {
  return String(account?.accountId ?? account?.email ?? account?.accountLabel ?? "unknown").trim().toLowerCase();
}

// Deliberately excludes fetch timestamps. A new poll of unchanged provider data
// is not new evidence that a turn rejected for usage will now succeed.
export function usageCapacityKey(snapshot) {
  const envelope = snapshot?.rateLimits ?? {};
  const limits = envelope?.rateLimits ?? envelope;
  const windowKey = (window) => window && typeof window === "object" ? {
    usedPercent: Number.isFinite(Number(window.usedPercent)) ? Number(window.usedPercent) : null,
    // remainingPercent is a provider/UI derivation of usedPercent on some paths.
    // Hash one canonical value so raw and persisted snapshots compare equally.
    remainingPercent: Number.isFinite(Number(window.usedPercent))
      ? Math.max(0, 100 - Number(window.usedPercent))
      : Number.isFinite(Number(window.remainingPercent)) ? Number(window.remainingPercent) : null,
    resetsAt: numericEpoch(window.resetsAt),
  } : null;
  return JSON.stringify({
    account: accountIdentity(snapshot?.account),
    primary: windowKey(limits.primary),
    secondary: windowKey(limits.secondary),
    rateLimitReachedType: String(envelope.rateLimitReachedType ?? limits.rateLimitReachedType ?? "").trim() || null,
    spendControlReached: envelope.spendControlReached === true || limits.spendControlReached === true,
  });
}

function usageCapacityResetAt(snapshot) {
  const envelope = snapshot?.rateLimits ?? {};
  const limits = envelope?.rateLimits ?? envelope;
  return [limits.primary, limits.secondary]
    .map((limit) => numericEpoch(limit?.resetsAt))
    .filter((resetAt) => resetAt && resetAt > Date.now() / 1000)
    .sort((a, b) => a - b)[0] ?? null;
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
  if (event === "external" && data?.terminalOutcome === "failed" && isUsageLimitError(data.terminalError)) {
    return data.terminalId ? {
      provider: data.provider,
      threadId: data.threadId,
      triggerId: String(data.terminalId),
      terminalId: String(data.terminalId),
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
    terminalId: String(terminalId),
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
      // Entries created before native Codex usage resume were ordinary text
      // sends. Preserve that behavior across upgrades instead of reinterpreting
      // an already-durable intent.
      if (!row.method) { row.method = "send"; repaired = true; }
      // A bridge cannot know whether an in-flight send survived its crash.
      // Surface it as uncertain, then reconcile against durable provider state
      // before taking any action; uncertainty never authorizes a blind resend.
      if (row.state === "dispatching") {
        row.state = "uncertain";
        row.nextCheckAt = this.now();
        row.error = { message: "Bridge restarted while sending; verifying the provider transcript automatically", code: "delivery_uncertain", status: 504 };
        repaired = true;
      } else if (row.state === "uncertain" && !Number.isFinite(Number(row.nextCheckAt))) {
        // Upgrade permanent/manual uncertainty into an automatically checked
        // state. This never authorizes a resend; reconciliation must first
        // prove acceptance, supersession, or a pre-provider failure.
        row.nextCheckAt = this.now();
        repaired = true;
      }
      // A previous build did not record transcript progress. It cannot safely
      // distinguish a still-needed Continue from one already supplied by the
      // user while the bridge was down, so never dispatch that legacy intent.
      if (CHECKABLE_STATES.has(row.state) && !row.progressGuard) {
        row.state = "failed";
        row.nextCheckAt = null;
        row.error = { message: "Auto-resume must be armed again after this update", code: "progress_guard_missing", status: 409 };
        repaired = true;
      }
      // Older builds incorrectly made some pre-dispatch settings/probe failures
      // terminal. Probe failures are safe only at attempts=0. A permission-mode
      // mismatch is also safe after the old runner incremented attempts because
      // sendOnce's local validation raised it before calling the provider.
      const safelyPreDispatch = row.error?.code === "permission_mode_mismatch"
        || (Number(row.attempts ?? 0) === 0
          && ["model_verification_failed", "model_unavailable", "effort_unavailable"].includes(row.error?.code));
      if (row.state === "failed" && safelyPreDispatch && row.progressGuard) {
        row.state = "waiting_provider";
        row.nextCheckAt = this.now();
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

  findByDispatchedTurn(provider, threadId, turnId) {
    const expected = clip(turnId, 300);
    if (!expected) { return null; }
    const candidates = [...this.entries.values()].filter((candidate) =>
      candidate.provider === provider && candidate.threadId === threadId
      && candidate.state === "accepted"
    ).sort((a, b) => b.updatedAt - a.updatedAt);
    // Provider ids are not comparable across every source (a native turn id vs
    // a watched-record id), and some providers omit one entirely. Prefer an
    // exact match, then conservatively fold the terminal into the newest
    // accepted auto-resume. Delaying is safer than creating duplicate Continue.
    const entry = candidates.find((candidate) => candidate.dispatchedTurnId === expected)
      ?? candidates.find((candidate) => this.now() - candidate.updatedAt <= ACCEPTED_REARM_WINDOW_MS);
    return entry ? structuredClone(entry) : null;
  }

  rearmDispatchedTurn(provider, threadId, turnId, {
    requestId, triggerId, terminalId, method, progressGuard, nextCheckAt,
  } = {}) {
    const prior = this.findByDispatchedTurn(provider, threadId, turnId);
    if (!prior) { return null; }
    const blocking = [...this.entries.values()].find((candidate) =>
      candidate.id !== prior.id && candidate.provider === provider && candidate.threadId === threadId
      && BLOCKING_STATES.has(candidate.state)
    );
    if (blocking) { return structuredClone(blocking); }
    const nextRequestId = clip(requestId, 200);
    if (!nextRequestId || !progressGuard) { throw retryError("requestId and progressGuard are required to re-arm usage resume"); }
    return this.update(prior.id, {
      state: "waiting_usage",
      requestId: nextRequestId,
      triggerId: clip(triggerId, 300),
      terminalId: clip(terminalId, 300) ?? prior.terminalId ?? null,
      method: method === "resumeUsage" ? "resumeUsage" : "send",
      progressGuard,
      nextCheckAt: Number(nextCheckAt) || this.now(),
      rejectedCapacityKey: prior.capacityKey ?? null,
      rejectedResetAt: prior.capacityResetAt ?? null,
      dispatchedTurnId: null,
      error: { message: "The provider still reports this account is out of usage", code: "usage_still_exhausted", status: 429 },
    });
  }

  create(input = {}) {
    const id = clip(input.id, 160);
    const provider = clip(input.provider, 40);
    const threadId = clip(input.threadId, 300);
    const requestId = clip(input.requestId, 200);
    const text = clip(input.text, 16000);
    const method = input.method === "resumeUsage" ? "resumeUsage" : "send";
    const terminalId = clip(input.terminalId, 300);
    if (!id || !provider || !threadId || !requestId || (method === "send" && !text) || (method === "resumeUsage" && !terminalId)) {
      throw retryError("id, provider, threadId, requestId, and a valid resume intent are required");
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
      id, provider, threadId, requestId, text, method, terminalId,
      triggerId,
      dispatch: structuredClone(input.dispatch ?? {}),
      progressGuard: input.progressGuard ? structuredClone(input.progressGuard) : null,
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
      throw retryError("The automatic resume is already being sent and can no longer be cancelled", "usage_retry_dispatching", 409);
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

  uncertainDue() {
    const now = this.now();
    return [...this.entries.values()]
      .filter((entry) => entry.state === "uncertain" && Number(entry.nextCheckAt) <= now)
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
  constructor({ store, now = () => Date.now(), readUsage, readRuntime, readProgress = async () => null, reconcileDelivery = async () => ({ state: "unconfirmed" }), prepare = async (entry) => entry.dispatch, send, onUpdate = () => {}, pollMs = 60_000 } = {}) {
    if (!store || !readUsage || !readRuntime || !send) { throw new Error("usage retry runner requires store, readUsage, readRuntime, and send"); }
    this.store = store;
    this.now = now;
    this.readUsage = readUsage;
    this.readRuntime = readRuntime;
    this.readProgress = readProgress;
    this.reconcileDelivery = reconcileDelivery;
    this.prepare = prepare;
    this.send = send;
    this.onUpdate = onUpdate;
    this.pollMs = pollMs;
    this.inFlight = new Set();
  }

  async reconcile(id) {
    if (this.inFlight.has(id)) { return this.store.get(id); }
    this.inFlight.add(id);
    try {
      let entry = this.store.get(id);
      if (!entry || entry.state !== "uncertain") { return entry; }
      let result;
      try {
        result = await this.reconcileDelivery(entry);
      } catch (error) {
        const current = this.store.get(id);
        if (!current || current.state !== "uncertain") { return current; }
        return this.publish(this.store.update(id, {
          nextCheckAt: this.now() + this.pollMs,
          error: { ...publicError(error), message: `Still verifying automatic resume delivery: ${error?.message ?? error}` },
        }));
      }
      entry = this.store.get(id);
      if (!entry || entry.state !== "uncertain") { return entry; }
      if (result?.state === "accepted") {
        return this.publish(this.store.update(id, { state: "accepted", nextCheckAt: null, error: null }));
      }
      if (result?.state === "superseded") {
        return this.publish(this.store.update(id, { state: "superseded", nextCheckAt: null, error: null }));
      }
      if (result?.state === "rearm") {
        return this.publish(this.store.update(id, {
          state: "waiting_usage",
          triggerId: clip(result.triggerId, 300) ?? entry.triggerId,
          terminalId: clip(result.terminalId, 300) ?? entry.terminalId,
          progressGuard: result.progressGuard ?? entry.progressGuard,
          nextCheckAt: this.now(),
          attempts: Math.max(0, Number(entry.attempts ?? 1) - 1),
          error: null,
        }));
      }
      if (result?.state === "retryable") {
        return this.publish(this.store.update(id, {
          state: "waiting_usage",
          nextCheckAt: this.now(),
          attempts: Math.max(0, Number(entry.attempts ?? 1) - 1),
          error: null,
        }));
      }
      return this.publish(this.store.update(id, {
        nextCheckAt: this.now() + this.pollMs,
        error: { message: "Verifying automatic resume delivery; it will not be repeated without proof", code: "delivery_reconciling", status: null },
      }));
    } finally {
      this.inFlight.delete(id);
    }
  }

  publish(entry) {
    this.onUpdate(entry);
    return entry;
  }

  async check(id) {
    if (this.store.get(id)?.state === "uncertain") { return this.reconcile(id); }
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
        usage = await this.readUsage(entry.provider, entry.threadId, entry);
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
      const capacityKey = usageCapacityKey(usage);

      // Live turn/started events are an optimization, not the safety boundary.
      // A bridge restart or an externally-owned turn can make us miss that
      // event. Any durable user-message change since the usage failure means
      // the user already resumed the thread, so this fallback is obsolete.
      if (entry.progressGuard) {
        let progress;
        try {
          progress = await this.readProgress(entry.provider, entry.threadId);
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
        const relation = progressRelation(entry.progressGuard, progress);
        if (relation === "unreadable") {
          return this.publish(this.store.update(id, {
            state: "waiting_thread",
            nextCheckAt: now + this.pollMs,
            error: { message: "Thread progress could not be verified yet", code: "thread_progress_unavailable", status: null },
          }));
        }
        if (relation === "advanced") {
          return this.publish(this.store.update(id, {
            state: "superseded",
            nextCheckAt: null,
            error: null,
          }));
        }
      }

      const unchangedCapacity = entry.rejectedCapacityKey && entry.rejectedCapacityKey === capacityKey;
      const resetPassed = numericEpoch(entry.rejectedResetAt) && numericEpoch(entry.rejectedResetAt) * 1000 <= now;
      if (unchangedCapacity && !resetPassed) {
        return this.publish(this.store.update(id, {
          state: "waiting_usage",
          nextCheckAt: now + this.pollMs,
          resetAt: entry.rejectedResetAt ?? capacity.resetAt,
          account: usage?.account ?? null,
          error: { message: "Waiting for this account's usage state to change", code: "usage_unchanged", status: null },
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

      try {
        const dispatch = await this.prepare(entry);
        const current = this.store.get(id);
        if (!current || !CHECKABLE_STATES.has(current.state)) { return current; }
        entry = this.store.update(id, { dispatch: dispatch ?? current.dispatch, error: null });
      } catch (error) {
        const current = this.store.get(id);
        if (!current || !CHECKABLE_STATES.has(current.state)) { return current; }
        const transient = error?.code === "model_verification_failed" || error?.status == null || error?.status >= 500;
        return this.publish(this.store.update(id, {
          state: transient ? "waiting_provider" : "failed",
          nextCheckAt: transient ? now + this.pollMs : null,
          error: publicError(error),
        }));
      }

      entry = this.store.update(id, {
        state: "dispatching",
        nextCheckAt: null,
        resetAt: null,
        account: usage?.account ?? null,
        capacityKey,
        capacityResetAt: usageCapacityResetAt(usage),
        error: null,
        attempts: Number(entry.attempts ?? 0) + 1,
      });
      this.publish(entry);

      try {
        const result = await this.send(entry);
        const dispatchedTurnId = clip(result?.turn?.id ?? result?.turnId, 300);
        return this.publish(this.store.update(id, { state: "accepted", nextCheckAt: null, error: null, dispatchedTurnId }));
      } catch (error) {
        if (isUsageLimitError(error)) {
          let progress;
          try {
            progress = await this.readProgress(entry.provider, entry.threadId);
          } catch (progressError) {
            return this.publish(this.store.update(id, {
              state: "failed",
              nextCheckAt: null,
              error: publicError(progressError),
            }));
          }
          return this.publish(this.store.update(id, {
            state: "waiting_usage",
            nextCheckAt: this.now() + this.pollMs,
            error: publicError(error),
            progressGuard: progress,
            rejectedCapacityKey: entry.capacityKey ?? null,
            rejectedResetAt: entry.capacityResetAt ?? null,
          }));
        }
        if (error?.code === "model_verification_failed") {
          return this.publish(this.store.update(id, {
            state: "waiting_provider",
            nextCheckAt: this.now() + this.pollMs,
            attempts: Math.max(0, Number(entry.attempts ?? 1) - 1),
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
          nextCheckAt: uncertain ? this.now() + this.pollMs : null,
          error: publicError(error),
        }));
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  async tick() {
    const rows = this.store.due();
    const uncertain = this.store.uncertainDue();
    await Promise.all([
      ...rows.map((entry) => this.check(entry.id)),
      ...uncertain.map((entry) => this.reconcile(entry.id)),
    ]);
    return rows.length + uncertain.length;
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
