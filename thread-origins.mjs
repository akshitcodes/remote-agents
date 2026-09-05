import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Sessions created from this UI, recorded at creation time. Codex stamps our
// clientInfo into the rollout's originator on its own, but Claude and Grok
// session files carry no originator at all — this ledger is what makes
// "created from the UI" exact for them instead of a guess.
export const MAX_ORIGIN_RECORDS = 1000;

function key(provider, threadId) {
  return `${provider || "codex"}\n${threadId}`;
}

export class ThreadOrigins {
  constructor({ file } = {}) {
    this.file = file || null;
    this.records = new Map();
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) { return; }

    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));

      for (const raw of parsed?.uiThreads ?? []) {
        if (!raw?.threadId) { continue; }
        const provider = String(raw.provider || "codex");
        const threadId = String(raw.threadId);
        this.records.set(key(provider, threadId), { provider, threadId, createdAt: Number(raw.createdAt) || 0 });
      }
    } catch {
      // A damaged ledger must not prevent the bridge from starting. Worst case
      // some UI-created sessions classify as native, which only ever *shows*
      // them — the fail-open direction.
    }
  }

  save() {
    if (!this.file) { return; }

    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, uiThreads: [...this.records.values()] }, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  markUi(provider, threadId) {
    if (!threadId) { return; }

    const k = key(provider, String(threadId));

    if (this.records.has(k)) { return; }

    this.records.set(k, { provider: String(provider || "codex"), threadId: String(threadId), createdAt: Date.now() });

    // Bound the file. Dropping the oldest records only ever reclassifies old
    // UI sessions as native, which keeps them visible.
    while (this.records.size > MAX_ORIGIN_RECORDS) {
      let oldest = null;
      for (const [k2, record] of this.records) {
        if (!oldest || record.createdAt < this.records.get(oldest).createdAt) { oldest = k2; }
      }
      this.records.delete(oldest);
    }

    this.save();
  }

  // A Claude/Grok session starts life as a bridge draft id and becomes a real
  // session id on the first send. The UI mark has to follow it.
  adopt(provider, fromThreadId, toThreadId) {
    if (!fromThreadId || !toThreadId) { return; }

    if (this.records.delete(key(provider, String(fromThreadId)))) {
      this.records.set(key(provider, String(toThreadId)), {
        provider: String(provider || "codex"),
        threadId: String(toThreadId),
        createdAt: Date.now(),
      });
      this.save();
    }
  }

  isUi(provider, threadId) {
    return this.records.has(key(provider, String(threadId ?? "")));
  }
}
