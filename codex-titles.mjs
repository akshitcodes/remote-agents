// The human-readable name Codex gives a thread.
//
// It is not in the rollout log. The log only has the conversation, so the best
// a reader can do from it alone is show the first user message — which is what
// this bridge used to do, and why the phone showed "# Context from my IDE
// setup: ## Open tabs:" for a thread Codex itself calls "Connect Mac to
// DigitalOcean SSH". Codex keeps the title in its own state database and
// generates a better one after the thread gets going, so the first message is
// only ever a fallback.
//
// Read-only, and every failure degrades to "no title" rather than throwing:
// this is a nicety on top of a list that must keep working. The database is
// live — Codex Desktop writes to it while we read — so it is opened read-only
// and re-read on a short interval rather than held open.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CODEX_HOME = join(homedir(), ".codex");
const TTL_MS = 10000;

let cache = { at: 0, titles: new Map() };

// The filename carries a schema generation (state_5.sqlite), so the highest
// number is the one this Codex build is actually using.
function stateDbPath() {
  try {
    const files = readdirSync(CODEX_HOME).filter((f) => /^state_(\d+)\.sqlite$/.test(f));

    if (!files.length) { return null; }

    files.sort((a, b) => Number(/(\d+)/.exec(b)[1]) - Number(/(\d+)/.exec(a)[1]));

    const path = join(CODEX_HOME, files[0]);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

function load() {
  const titles = new Map();
  const path = stateDbPath();

  if (!path) { return titles; }

  let db;

  try {
    db = new DatabaseSync(path, { readOnly: true });

    // first_user_message matters as much as the title: Codex seeds `title` with
    // the opening message and only replaces it once it has generated a real
    // one. Where the two are still identical there is no title yet, and the
    // caller's own (truncated) preview reads better than the raw message.
    for (const row of db.prepare("SELECT id, title, first_user_message FROM threads").all()) {
      const title = String(row.title ?? "").trim();

      if (!title || title === String(row.first_user_message ?? "").trim()) { continue; }

      titles.set(row.id, title.replace(/\s+/g, " ").slice(0, 200));
    }
  } catch {
    // A locked, missing, or newer-schema database just means no titles.
    return cache.titles;
  } finally {
    try { db?.close(); } catch {}
  }

  return titles;
}

export function titleFor(threadId) {
  if (!threadId) { return ""; }

  if (Date.now() - cache.at >= TTL_MS) {
    cache = { at: Date.now(), titles: load() };
  }

  return cache.titles.get(threadId) ?? "";
}
