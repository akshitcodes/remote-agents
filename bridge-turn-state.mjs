// Durable lifecycle for turns owned by this bridge process.
//
// An active row left behind at process startup is not ambiguous: this process
// cannot still own that provider stream. Preserve that exact restart cause so
// the UI can offer recovery immediately instead of waiting for a stale-file
// timeout and guessing that the provider "may" have exited.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class BridgeTurnState {
  constructor({ file, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!file) { throw new Error("bridge turn state file required"); }
    this.file = file;
    this.now = now;
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.load();
  }

  load() {
    let rows = [];
    try { rows = JSON.parse(readFileSync(this.file, "utf8")); } catch { return; }
    if (!Array.isArray(rows)) { return; }

    const now = this.now();
    for (const row of rows) {
      if (!row?.provider || !row?.threadId || !row?.at || now - row.at > this.ttlMs) { continue; }
      const interrupted = row.state === "active"
        ? { ...row, state: "interrupted", reason: "bridge_restarted", interruptedAt: now, at: now }
        : row;
      this.entries.set(this.key(interrupted.provider, interrupted.threadId), interrupted);
    }

    if (rows.some((row) => row?.state === "active")) { this.persist(); }
  }

  key(provider, threadId) { return `${provider || "codex"}:${threadId}`; }

  get(provider, threadId) {
    return this.entries.get(this.key(provider, threadId)) ?? null;
  }

  started({ provider = "codex", threadId, turnId = null } = {}) {
    if (!threadId) { return; }
    const at = this.now();
    this.entries.set(this.key(provider, threadId), { provider, threadId, turnId, state: "active", at });
    this.persist();
  }

  adopted({ provider = "codex", fromThreadId, threadId } = {}) {
    if (!fromThreadId || !threadId || fromThreadId === threadId) { return; }
    const entry = this.entries.get(this.key(provider, fromThreadId));
    if (!entry) { return; }
    this.entries.delete(this.key(provider, fromThreadId));
    this.entries.set(this.key(provider, threadId), { ...entry, threadId, at: this.now() });
    this.persist();
  }

  finished(provider, threadId) {
    if (!threadId || !this.entries.delete(this.key(provider, threadId))) { return; }
    this.persist();
  }

  persist() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, row] of this.entries) {
      if ((row?.at ?? 0) < cutoff) { this.entries.delete(key); }
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.entries.values()]), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
