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
//
// There is a second, better source. A thread you renamed in the Codex app keeps
// that name where no file on disk exposes it: threads.name is NULL for every
// local thread, the rollout carries no rename record, and the string appears in
// none of Codex's four databases — yet app-server's thread/list returns
// "iron man model (2)", exactly as the CLI's own resume picker shows it. So the
// rename is only reachable by asking app-server.
//
// Asking it is also what this bridge deliberately stopped doing for reads,
// because a stuck MCP server made app-server stop answering and took the whole
// session list down with it. So names are fetched *off* the critical path: the
// list is always served from rollout files at full speed, a refresh runs at most
// once every REFRESH_MS in the background, and its result is cached to disk. If
// app-server hangs or dies the only cost is slightly stale names.

import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { codexBinary } from "./providers/codex.mjs";

const CODEX_HOME = join(homedir(), ".codex");
const TTL_MS = 10000;

// Renames change rarely, and each refresh costs an app-server process.
const REFRESH_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;
const NAME_LIMIT = 400;
const NAMES_FILE = join(homedir(), ".codex-phone", "thread-names.json");

let cache = { at: 0, titles: new Map() };
let names = null; // id -> name, loaded from disk on first use
let namesAt = 0;
let refreshing = false;

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

function loadNamesFromDisk() {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(NAMES_FILE, "utf8"))));
  } catch {
    return new Map(); // absent or corrupt: we simply have no names yet
  }
}

function saveNamesToDisk(map) {
  try {
    mkdirSync(dirname(NAMES_FILE), { recursive: true });
    writeFileSync(NAMES_FILE, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // A cache we cannot persist just gets refetched next start.
  }
}

// One short-lived app-server, asked a single question. The child is tracked and
// killed by pid — never by name — because the user has a live Codex Desktop
// app-server on this machine that must not be touched.
function fetchNames() {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (result) => {
      if (settled) { return; }

      settled = true;
      try { child?.kill("SIGTERM"); } catch {}
      resolve(result);
    };

    try {
      // No MCP servers. config.toml declares eleven, and app-server starts them
      // all on launch — the exact thing that used to wedge it and take the
      // session list down. thread/list only reads local state, so this probe has
      // no use for them: it removes the failure mode rather than timing it out,
      // and is measurably faster for it (927ms vs 1660ms locally).
      child = spawn(codexBinary(), ["app-server", "-c", "mcp_servers={}"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => finish(null), FETCH_TIMEOUT_MS);
    let buf = "";

    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));

    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();

      for (const line of lines) {
        if (!line.trim()) { continue; }

        let msg;

        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/list", params: { limit: NAME_LIMIT } }) + "\n");
          continue;
        }

        if (msg.id !== 2) { continue; }

        clearTimeout(timer);

        if (msg.error) { finish(null); return; }

        const found = new Map();

        for (const t of msg.result?.threads ?? msg.result?.data ?? []) {
          const name = String(t?.name ?? "").replace(/\s+/g, " ").trim();

          if (t?.id && name) { found.set(t.id, name.slice(0, 200)); }
        }

        finish(found);
        return;
      }
    });

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "codex-phone", version: "1" } } }) + "\n");
  });
}

// Fire-and-forget: nothing waits on this, so a wedged app-server cannot slow a
// list down. Deliberately not awaited by titleFor.
function refreshNames() {
  if (refreshing || Date.now() - namesAt < REFRESH_MS) { return; }

  refreshing = true;
  namesAt = Date.now(); // stamped up front so a hang cannot cause a spawn storm

  fetchNames()
    .then((found) => {
      // Only replace on a real answer; an empty result is indistinguishable
      // from a failure and must not wipe good names.
      if (found?.size) {
        names = found;
        saveNamesToDisk(found);
      }
    })
    .finally(() => { refreshing = false; });
}

export function titleFor(threadId) {
  if (!threadId) { return ""; }

  if (names === null) { names = loadNamesFromDisk(); }

  refreshNames();

  if (Date.now() - cache.at >= TTL_MS) {
    cache = { at: Date.now(), titles: load() };
  }

  // A name you chose beats a title Codex generated, which beats the opening
  // message the caller falls back to.
  return names.get(threadId) || cache.titles.get(threadId) || "";
}
