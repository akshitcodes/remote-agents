import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Sessions the user hid by hand. Distinct from the origin filter on purpose:
// origin answers "who created this", which is a fact, while this answers "I
// don't want to see this", which is a decision. A manual hide therefore beats
// every other rule — including a star — so hiding always does what it says.
export const MAX_HIDDEN_THREADS = 2000;

function key(provider, threadId) {
  return `${provider || "codex"}\n${threadId}`;
}

function cleanRecord(row) {
  if (!row?.threadId) { return null; }

  return {
    provider: String(row.provider || "codex"),
    threadId: String(row.threadId),
    // Kept so the settings list can name a session that is no longer in any
    // page the list endpoints return.
    title: String(row.title ?? "").slice(0, 200),
    cwd: String(row.cwd ?? "").slice(0, 400),
    hiddenAt: Number(row.hiddenAt) || Date.now(),
  };
}

export class HiddenThreads {
  constructor({ file } = {}) {
    this.file = file || null;
    this.records = new Map();
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) { return; }

    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));

      for (const raw of parsed?.hidden ?? []) {
        const record = cleanRecord(raw);
        if (record) { this.records.set(key(record.provider, record.threadId), record); }
      }
    } catch {
      // A damaged file must not prevent the bridge from starting. Losing hides
      // only ever shows more, which is the safe direction.
    }
  }

  save() {
    if (!this.file) { return; }

    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, hidden: [...this.records.values()] }, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  set({ provider = "codex", threadId, hidden = true, title = "", cwd = "" } = {}) {
    if (!threadId) {
      throw Object.assign(new Error("threadId is required"), { status: 400 });
    }

    const k = key(String(provider), String(threadId));

    if (!hidden) {
      if (this.records.delete(k)) { this.save(); }
      return this.list();
    }

    if (this.records.has(k)) { return this.list(); }

    if (this.records.size >= MAX_HIDDEN_THREADS) {
      throw Object.assign(new Error(`you can hide up to ${MAX_HIDDEN_THREADS} sessions; unhide one first`), {
        status: 409,
        code: "hidden_limit_reached",
      });
    }

    this.records.set(k, cleanRecord({ provider, threadId, title, cwd, hiddenAt: Date.now() }));
    this.save();
    return this.list();
  }

  has(provider, threadId) {
    return this.records.has(key(String(provider || "codex"), String(threadId ?? "")));
  }

  // Most recently hidden first: the one you just hid by mistake is the one you
  // are most likely to come looking for.
  list() {
    return [...this.records.values()].sort((a, b) => b.hiddenAt - a.hiddenAt);
  }
}
