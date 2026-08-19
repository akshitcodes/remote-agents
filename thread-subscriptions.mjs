import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MODES = new Set(["once", "follow"]);
const MAX_RULES_PER_ENDPOINT = 50;
const MAX_RULES_TOTAL = 200;

function key(endpoint, provider, threadId) {
  return `${endpoint}\n${provider || "codex"}\n${threadId}`;
}

function cleanRule(rule) {
  if (!rule?.endpoint || !rule?.threadId || !MODES.has(rule.mode)) { return null; }

  return {
    endpoint: String(rule.endpoint),
    provider: String(rule.provider || "codex"),
    threadId: String(rule.threadId),
    mode: rule.mode,
    lastTerminalId: rule.lastTerminalId ? String(rule.lastTerminalId) : null,
    createdAt: Number(rule.createdAt) || Date.now(),
  };
}

export class ThreadSubscriptions {
  constructor({ file } = {}) {
    this.file = file || null;
    this.rules = new Map();
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) { return; }

    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));

      for (const raw of parsed?.rules ?? []) {
        const rule = cleanRule(raw);
        if (rule) { this.rules.set(key(rule.endpoint, rule.provider, rule.threadId), rule); }
      }
    } catch {
      // A damaged preference file must not prevent the bridge from starting.
    }
  }

  save() {
    if (!this.file) { return; }

    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, rules: [...this.rules.values()] }, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  set({ endpoint, provider = "codex", threadId, mode, terminalId = null } = {}) {
    if (!endpoint || !threadId) {
      throw Object.assign(new Error("endpoint and threadId are required"), { status: 400 });
    }

    const k = key(String(endpoint), String(provider), String(threadId));

    if (mode === "off") {
      this.rules.delete(k);
      this.save();
      return { mode: "off", provider, threadId };
    }

    if (!MODES.has(mode)) {
      throw Object.assign(new Error("mode must be once, follow, or off"), { status: 400 });
    }

    const previous = this.rules.get(k);

    if (!previous) {
      const endpointRules = [...this.rules.values()].filter((rule) => rule.endpoint === String(endpoint)).length;
      if (endpointRules >= MAX_RULES_PER_ENDPOINT || this.rules.size >= MAX_RULES_TOTAL) {
        throw Object.assign(new Error("notification subscription limit reached; turn off an older task first"), { status: 409 });
      }
    }

    const rule = {
      endpoint: String(endpoint),
      provider: String(provider),
      threadId: String(threadId),
      mode,
      // Changing once -> follow must not make the already-finished turn new.
      lastTerminalId: previous?.lastTerminalId ?? (terminalId ? String(terminalId) : null),
      createdAt: previous?.createdAt ?? Date.now(),
    };

    this.rules.set(k, rule);
    this.save();
    return { mode: rule.mode, provider: rule.provider, threadId: rule.threadId };
  }

  get({ endpoint, provider = "codex", threadId } = {}) {
    return this.rules.get(key(String(endpoint || ""), String(provider), String(threadId || ""))) ?? null;
  }

  list(endpoint) {
    return [...this.rules.values()]
      .filter((rule) => rule.endpoint === endpoint)
      .map(({ provider, threadId, mode }) => ({ provider, threadId, mode }));
  }

  removeEndpoint(endpoint) {
    let changed = false;

    for (const [k, rule] of this.rules) {
      if (rule.endpoint === endpoint) {
        this.rules.delete(k);
        changed = true;
      }
    }

    if (changed) { this.save(); }
    return changed;
  }

  pruneEndpoints(keep) {
    let changed = false;

    for (const [k, rule] of this.rules) {
      if (!keep(rule.endpoint)) {
        this.rules.delete(k);
        changed = true;
      }
    }

    if (changed) { this.save(); }
    return changed;
  }

  interests() {
    const unique = new Map();

    for (const rule of this.rules.values()) {
      unique.set(`${rule.provider}:${rule.threadId}`, { provider: rule.provider, id: rule.threadId });
    }

    return [...unique.values()];
  }

  // Advances every matching device cursor before returning deliveries. That
  // makes terminal processing idempotent across duplicate polls and restarts.
  observe({ provider = "codex", threadId, terminalId, outcome = "completed" } = {}) {
    if (!threadId || !terminalId) { return []; }

    const deliveries = [];
    let changed = false;

    for (const [k, rule] of this.rules) {
      if (rule.provider !== provider || rule.threadId !== threadId || rule.lastTerminalId === terminalId) { continue; }

      rule.lastTerminalId = String(terminalId);
      deliveries.push({ ...rule, outcome });
      changed = true;

      if (rule.mode === "once") { this.rules.delete(k); }
    }

    if (changed) { this.save(); }
    return deliveries;
  }

  // A completion seen on-screen or already notified by the ordinary bridge
  // push advances the cursor without consuming a one-shot external follow.
  acknowledge({ provider = "codex", threadId, terminalId } = {}) {
    if (!threadId || !terminalId) { return false; }
    let changed = false;

    for (const rule of this.rules.values()) {
      if (rule.provider === provider && rule.threadId === threadId && rule.lastTerminalId !== terminalId) {
        rule.lastTerminalId = String(terminalId);
        changed = true;
      }
    }

    if (changed) { this.save(); }
    return changed;
  }
}
