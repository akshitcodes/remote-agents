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
        this.records.set(key(provider, threadId), {
          provider,
          threadId,
          // "created" was stamped by POST /api/thread/new; "manual" is the user
          // correcting a misclassification by hand. Only the latter is worth
          // listing back to them.
          source: raw.source === "manual" ? "manual" : "created",
          title: String(raw.title ?? "").slice(0, 200),
          cwd: String(raw.cwd ?? "").slice(0, 400),
          createdAt: Number(raw.createdAt) || 0,
        });
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

  markUi(provider, threadId, { source = "created", title = "", cwd = "" } = {}) {
    if (!threadId) { return; }

    const k = key(provider, String(threadId));

    // A hand-made correction is stronger than the creation stamp, so it may
    // upgrade an existing record; the reverse would silently drop the label
    // the user chose.
    if (this.records.has(k) && !(source === "manual" && this.records.get(k).source !== "manual")) { return; }

    this.records.set(k, {
      provider: String(provider || "codex"),
      threadId: String(threadId),
      source: source === "manual" ? "manual" : "created",
      title: String(title ?? "").slice(0, 200),
      cwd: String(cwd ?? "").slice(0, 400),
      createdAt: Date.now(),
    });

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

  // Undo. Removing the entry hands classification back to the provider
  // metadata, which is what the user is asking for when they say a session is
  // not theirs after all.
  clearUi(provider, threadId) {
    if (this.records.delete(key(provider, String(threadId ?? "")))) { this.save(); return true; }
    return false;
  }

  // Only hand-made corrections. Listing every session ever created from the UI
  // would bury the handful the user actually reclassified.
  listManual() {
    return [...this.records.values()]
      .filter((record) => record.source === "manual")
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}
