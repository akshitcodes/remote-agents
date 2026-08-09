// codex-phone — self-hosted mobile UI for your Codex and Claude CLI sessions.
// Bridges provider CLIs to a phone-friendly web page over HTTP + SSE. Each
// request selects a provider ("codex" default, or "claude").
//
// This module exports startServer(); the runnable entry point is bin/codex-phone.mjs.

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import * as watch from "./watch.mjs";
import { CodexProvider } from "./providers/codex.mjs";
import { ClaudeProvider } from "./providers/claude.mjs";
import { GrokProvider } from "./providers/grok.mjs";
import * as push from "./push.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- config (set by startServer) ----------

let HOST = "127.0.0.1";
let PORT = 8484;
let TOKEN = "";
const COOKIE_NAME = "cxp_session";

// PWA assets served without the session cookie (no secrets in them).
const PWA_FILES = {
  "/sw.js": { file: "sw.js", type: "application/javascript; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/favicon.ico": { file: "icons/icon-192.png", type: "image/png" },
};

// ---------- SSE fan-out ----------

const sseClients = new Set(); // http responses subscribed to events

function broadcast(event, data) {
  trackForPush(event, data);
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const res of sseClients) {
    res.write(frame);
  }
}

// ---------- "agent finished" push ----------
//
// Every provider frame passes through broadcast(), so the reply text and the
// end-of-turn signal are both already here — no provider changes needed. We keep
// the last agent message per thread to use as the notification body, and the
// thread's title from the last list response for the headline.

const PROVIDER_LABELS = { codex: "Codex", claude: "Claude", grok: "Grok" };
const lastAgentText = new Map(); // "provider:threadId" -> most recent reply text
const threadTitles = new Map(); // "provider:threadId" -> name/preview
const adoptedIds = new Map(); // "provider:draftId" -> the real session id
const recentlyPushed = new Map(); // dedupe key -> timestamp
const presence = new Map(); // clientId -> { provider, ids:[], visible, at }

// "Unread only": a turn you are watching on screen right now needs no push. A
// client reports what it has open and whether it is visible; the report goes
// stale on its own, so a backgrounded or closed app stops suppressing.
const PRESENCE_TTL_MS = 75000;

export function notePresence({ clientId, provider, ids, visible }) {
  if (!clientId) {
    throw Object.assign(new Error("clientId is required"), { status: 400 });
  }

  presence.set(clientId, {
    provider: provider || "codex",
    ids: Array.isArray(ids) ? ids.filter(Boolean) : [],
    visible: !!visible,
    at: Date.now(),
  });

  refreshInterest();
  return { ok: true };
}

// How far into each watched thread the app has already been told about, so a
// moving thread costs only what the agent just wrote.
//
// Sending the whole thread on every change is what makes this unusable on a
// phone: a long session is ~1MB, and re-fetching that every second is slower
// than the interval itself, so it never looks live. These logs are append-only
// records of completed work, so the delta is always *new items* — never
// rewritten ones — and position is a stable identity even where the items
// themselves have no id (Claude's have gaps and duplicates).
const sentItems = new Map(); // "provider:threadId" -> items already delivered

async function emitExternal({ provider, threadId, running, changed }) {
  const key = metaKey(provider, threadId);

  if (!changed) {
    broadcast("external", { provider, threadId, running });
    return;
  }

  let payload = { provider, threadId, running };

  try {
    const p = providers[provider];
    const res = await p?.readThread(threadId);
    const items = (res?.thread?.turns ?? []).flatMap((t) => t.items ?? []);

    // First sighting establishes the baseline: the app just read the thread
    // itself, so replaying its history back at it would only duplicate it.
    const already = sentItems.get(key) ?? items.length;

    if (items.length > already) {
      payload = { ...payload, from: already, items: items.slice(already) };
    }

    sentItems.set(key, items.length);
  } catch {
    // Couldn't re-read it — the bare ping still tells the app to refresh.
  }

  broadcast("external", payload);
}

// The session-file watcher follows only what someone actually has open — the
// same reports that drive unread-only push, reused so nothing extra is polled.
function refreshInterest() {
  const now = Date.now();
  const wanted = [];

  for (const [clientId, p] of presence) {
    if (now - p.at > PRESENCE_TTL_MS) {
      presence.delete(clientId);
      continue;
    }

    for (const id of p.ids) {
      wanted.push({ provider: p.provider, id });
    }
  }

  watch.setInterest(wanted);

  const live = new Set(wanted.map((w) => metaKey(w.provider, w.id)));

  for (const k of sentItems.keys()) {
    if (!live.has(k)) { sentItems.delete(k); }
  }
}

function isOnScreen(provider, candidateIds) {
  const now = Date.now();

  for (const [clientId, p] of presence) {
    if (now - p.at > PRESENCE_TTL_MS) {
      presence.delete(clientId);
      continue;
    }

    if (p.visible && p.provider === (provider || "codex") && p.ids.some((id) => candidateIds.includes(id))) {
      return true;
    }
  }

  return false;
}

function metaKey(provider, threadId) {
  return `${provider || "codex"}:${threadId}`;
}

function rememberThreadTitles(provider, rows) {
  for (const t of rows ?? []) {
    if (t?.id) {
      threadTitles.set(metaKey(provider, t.id), t.name || t.preview || "");
    }
  }
}

function trackForPush(event, data) {
  if (event !== "notify" || !push.count()) {
    return;
  }

  const { method, params = {}, provider } = data ?? {};
  const threadId = params.threadId;

  if (!method || !threadId) {
    return;
  }

  const key = metaKey(provider, threadId);

  // A new session streams under its draft id until it is adopted; remember the
  // real id so the notification's title lookup and deep link both work.
  if (method === "thread/adopted" && params.sessionId) {
    adoptedIds.set(key, params.sessionId);
    return;
  }

  if (method === "item/agentMessage/delta") {
    lastAgentText.set(key, ((lastAgentText.get(key) ?? "") + (params.delta ?? "")).slice(-400));
    return;
  }

  if (method === "item/completed" && params.item?.type === "agentMessage") {
    lastAgentText.set(key, String(params.item.text ?? "").slice(-400));
    return;
  }

  if (method !== "turn/completed" && method !== "turn/failed") {
    return;
  }

  const failed = method === "turn/failed";
  const errorText = String(params.turn?.error?.message ?? "");

  // A turn you stopped yourself is not news.
  if (failed && /cancel/i.test(errorText)) {
    return;
  }

  // Providers can emit a terminal frame more than once per turn.
  const dedupe = `${key}:${params.turn?.id ?? ""}:${method}`;
  const now = Date.now();

  for (const [k, at] of recentlyPushed) {
    if (now - at > 60000) { recentlyPushed.delete(k); }
  }

  if (recentlyPushed.has(dedupe)) {
    return;
  }

  recentlyPushed.set(dedupe, now);

  const label = PROVIDER_LABELS[provider] || "Agent";
  const realId = adoptedIds.get(key) || threadId;

  // Already reading it? Then it is not unread — say nothing.
  if (isOnScreen(provider, [threadId, realId])) {
    lastAgentText.delete(key);
    return;
  }

  const reply = (lastAgentText.get(key) ?? "").trim().replace(/\s+/g, " ");
  const body = failed
    ? (errorText || "Turn failed")
    : (reply.slice(0, 180) || "Turn finished");

  lastAgentText.delete(key);

  (async () => {
    let title = threadTitles.get(metaKey(provider, realId)) || "";

    // A thread the client never listed (e.g. one just created) has no title yet.
    if (!title) {
      title = await lookupThreadTitle(provider, realId);
    }

    await push.send({
      title: `${label}${failed ? " · failed" : " finished"}${title ? " · " + title.slice(0, 60) : ""}`,
      body,
      threadId: realId,
      provider: provider || "codex",
    });
  })().catch(() => {});
}

// Best-effort title for a thread we have not seen in a list response.
async function lookupThreadTitle(provider, threadId) {
  const p = pickProvider(provider);

  if (!p) {
    return "";
  }

  try {
    const listed = await p.listThreads({});
    rememberThreadTitles(provider, listed.data);
    return threadTitles.get(metaKey(provider, threadId)) || "";
  } catch {
    return "";
  }
}

// Each provider gets an emit callback that tags every frame with its name.
function makeEmit(name) {
  return function emit(event, data) {
    broadcast(event, { ...data, provider: name });
  };
}

// ---------- provider registry ----------

const providers = {
  codex: new CodexProvider(makeEmit("codex")),
  claude: new ClaudeProvider(makeEmit("claude")),
  grok: new GrokProvider(makeEmit("grok")),
};

function pickProvider(name) {
  return providers[name || "codex"] ?? null;
}

// ---------- http helpers ----------

function isAuthed(req) {
  const cookies = req.headers.cookie ?? "";

  if (cookies.split(/;\s*/).some((c) => c === `${COOKIE_NAME}=${TOKEN}`)) {
    return true;
  }

  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;

      if (data.length > 2e6) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Resolve the provider for a GET (from query) or POST (from body); 400 if unknown.
function providerFromQuery(res, url) {
  const name = url.searchParams.get("provider") || "codex";
  const p = pickProvider(name);

  if (!p) {
    json(res, 400, { error: `unknown provider: ${name}` });
    return null;
  }

  return p;
}

function providerFromBody(res, body) {
  const name = body.provider || "codex";
  const p = pickProvider(name);

  if (!p) {
    json(res, 400, { error: `unknown provider: ${name}` });
    return null;
  }

  return p;
}

// Read a file for the viewer, scoped to the thread's project. "Project" means
// the thread's cwd AND every git worktree of the same repository — an agent that
// works in a worktree writes files that are genuinely part of your project, and
// blocking those helped nobody. Set `fileAccess: "anywhere"` in
// ~/.codex-phone/config.json to drop the scope check entirely (the pairing token
// already lets anyone drive an agent in Full Access, so this is your call).
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const WORKTREE_TTL_MS = 30000;
const worktreeCache = new Map(); // cwd -> { roots:[], at }

function projectRoots(realCwd) {
  const cached = worktreeCache.get(realCwd);

  if (cached && Date.now() - cached.at < WORKTREE_TTL_MS) {
    return cached.roots;
  }

  const roots = new Set([realCwd]);

  try {
    const out = execFileSync("git", ["-C", realCwd, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });

    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        const p = line.slice("worktree ".length).trim();

        try {
          roots.add(realpathSync(p));
        } catch {
          // worktree recorded but no longer on disk
        }
      }
    }
  } catch {
    // not a git repo, or git unavailable — the cwd alone stays in scope
  }

  const list = [...roots];
  worktreeCache.set(realCwd, { roots: list, at: Date.now() });
  return list;
}

function fileAccessMode() {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".codex-phone", "config.json"), "utf8")).fileAccess || "project";
  } catch {
    return "project";
  }
}

function readProjectFile(cwd, p) {
  if (!cwd || !p) {
    throw Object.assign(new Error("cwd and path are required"), { status: 400 });
  }

  const abs = isAbsolute(p) ? p : resolve(cwd, p);

  let realCwd;
  let realFile;

  try {
    realCwd = realpathSync(cwd);
  } catch {
    throw Object.assign(new Error("project directory not found"), { status: 400 });
  }

  try {
    realFile = realpathSync(abs);
  } catch {
    throw Object.assign(new Error("file not found"), { status: 404 });
  }

  if (fileAccessMode() !== "anywhere") {
    const roots = projectRoots(realCwd);
    const inScope = roots.some((root) => realFile === root || realFile.startsWith(root + sep));

    if (!inScope) {
      throw Object.assign(new Error("file is outside this project and its worktrees"), { status: 403 });
    }
  }

  const st = statSync(realFile);

  if (!st.isFile()) {
    throw Object.assign(new Error("not a file"), { status: 400 });
  }

  const truncated = st.size > MAX_FILE_BYTES;
  const buf = readFileSync(realFile);
  const slice = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf;
  const binary = slice.subarray(0, 8000).includes(0);

  return {
    path: realFile,
    name: basename(realFile),
    size: st.size,
    truncated,
    binary,
    content: binary ? "" : slice.toString("utf8"),
  };
}

// ---------- routes ----------

const routes = {
  "GET /api/file": async (req, res, url) => {
    if (!isAuthed(req)) {
      return json(res, 401, { error: "unauthorized" });
    }

    try {
      json(res, 200, readProjectFile(url.searchParams.get("cwd"), url.searchParams.get("path")));
    } catch (e) {
      json(res, e.status ?? 500, { error: String(e.message ?? e) });
    }
  },

  "GET /api/threads": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    const listed = await p.listThreads({ search: url.searchParams.get("search"), cursor: url.searchParams.get("cursor") });
    rememberThreadTitles(p.name, listed.data);

    // Whether each thread is mid-turn, read off the CLI's own session file, so
    // the list badges turns this bridge never started (and turns that were
    // already under way before the app was opened).
    const running = watch.runningStates(p.name, (listed.data ?? []).map((t) => t.id));

    for (const t of listed.data ?? []) {
      t.running = !!running[t.id];
    }

    json(res, 200, listed);
  },

  // Web Push: the key the browser needs to subscribe, plus (un)subscribe.
  "GET /api/push/key": async (req, res) => {
    if (!isAuthed(req)) {
      return json(res, 401, { error: "unauthorized" });
    }

    json(res, 200, { key: push.publicKey(), subscribers: push.count() });
  },

  "POST /api/push/subscribe": async (req, res) => {
    if (!isAuthed(req)) {
      return json(res, 401, { error: "unauthorized" });
    }

    const body = await readBody(req);

    try {
      json(res, 200, push.subscribe(body?.subscription));
    } catch (e) {
      json(res, e.status ?? 500, { error: String(e.message ?? e) });
    }
  },

  // What this device is looking at, so a turn on screen does not also buzz.
  "POST /api/presence": async (req, res) => {
    if (!isAuthed(req)) {
      return json(res, 401, { error: "unauthorized" });
    }

    const body = await readBody(req);

    try {
      json(res, 200, notePresence(body));
    } catch (e) {
      json(res, e.status ?? 500, { error: String(e.message ?? e) });
    }
  },

  "POST /api/push/unsubscribe": async (req, res) => {
    if (!isAuthed(req)) {
      return json(res, 401, { error: "unauthorized" });
    }

    const body = await readBody(req);
    json(res, 200, push.unsubscribe(body?.endpoint));
  },

  "GET /api/thread": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    json(res, 200, await p.readThread(url.searchParams.get("id")));
  },

  "GET /api/models": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    json(res, 200, await p.models());
  },

  "GET /api/usage": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    json(res, 200, await p.usage({ refresh: url.searchParams.get("refresh") === "1" }));
  },

  "GET /api/projects": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    json(res, 200, await p.projects());
  },

  "POST /api/thread/new": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) {
      return;
    }

    json(res, 200, await p.newThread(body));
  },

  "POST /api/message": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) {
      return;
    }

    json(res, 200, await p.send(body));
  },

  "POST /api/interrupt": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) {
      return;
    }

    json(res, 200, await p.interrupt(body));
  },

  "POST /api/approval": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) {
      return;
    }

    json(res, 200, await p.respondApproval(body));
  },

  "POST /api/rename": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) {
      return;
    }

    if (typeof p.rename !== "function") {
      return json(res, 400, { error: "rename not supported for this provider" });
    }

    json(res, 200, await p.rename(body));
  },

  "POST /api/archive": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) {
      return;
    }

    if (typeof p.archive !== "function") {
      return json(res, 400, { error: "archive not supported for this provider" });
    }

    json(res, 200, await p.archive(body));
  },

  "GET /api/events": async (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("event: bridge\ndata: {\"state\":\"connected\"}\n\n");
    sseClients.add(res);

    const keepalive = setInterval(() => res.write(": ping\n\n"), 25000);

    req.on("close", () => {
      clearInterval(keepalive);
      sseClients.delete(res);
    });
  },
};

// ---------- server ----------

const indexHtml = readFileSync(join(__dirname, "public", "index.html"));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Internal endpoint for the Claude PreToolUse hook (loopback only, secret-auth
  // inside the provider). No session cookie — the hook has no browser context.
  if (url.pathname === "/internal/claude-approval" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const result = await providers.claude.handleHookRequest(body);
      return json(res, 200, result);
    } catch (e) {
      return json(res, 200, { decision: "deny", reason: String(e.message ?? e) });
    }
  }

  if (url.pathname === "/") {
    if (url.searchParams.get("t") === TOKEN) {
      res.writeHead(302, {
        "set-cookie": `${COOKIE_NAME}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
        location: "/",
      });
      return res.end();
    }

    if (!isAuthed(req)) {
      res.writeHead(401, { "content-type": "text/html" });
      return res.end("<h3 style='font-family:sans-serif'>401 — open this page via your pairing link (with ?t=...)</h3>");
    }

    res.writeHead(200, { "content-type": "text/html" });
    return res.end(indexHtml);
  }

  // PWA assets (service worker, manifest, icons, favicon) are served pre-auth —
  // they carry no secrets and the browser/SW may request them without the cookie.
  if (req.method === "GET" && (PWA_FILES[url.pathname] || url.pathname.startsWith("/icons/"))) {
    const entry = PWA_FILES[url.pathname] ?? { file: join("icons", basename(url.pathname)), type: "image/png" };
    const file = join(__dirname, "public", entry.file);

    if (!existsSync(file)) {
      return json(res, 404, { error: "not found" });
    }

    const headers = { "content-type": entry.type };

    if (url.pathname === "/sw.js") {
      headers["cache-control"] = "no-cache";
      headers["service-worker-allowed"] = "/";
    } else {
      headers["cache-control"] = "max-age=86400";
    }

    res.writeHead(200, headers);
    return res.end(readFileSync(file));
  }

  if (!isAuthed(req)) {
    return json(res, 401, { error: "unauthorized" });
  }

  // Vendored static assets (marked, DOMPurify). basename() prevents traversal.
  if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
    const file = join(__dirname, "public", "vendor", basename(url.pathname));

    if (existsSync(file)) {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "max-age=86400" });
      return res.end(body);
    }

    return json(res, 404, { error: "not found" });
  }

  const handler = routes[`${req.method} ${url.pathname}`];

  if (!handler) {
    return json(res, 404, { error: "not found" });
  }

  try {
    await handler(req, res, url);
  } catch (e) {
    if (res.headersSent) {
      return;
    }

    json(res, e.status ?? 500, { error: String(e.message ?? e), rpc: e.rpc });
  }
});

// Start the bridge. Resolves once listening. Caller owns host/port/token
// resolution and any user-facing output (pairing URL, QR).
export function startServer({ host = "0.0.0.0", port = 8484, token } = {}) {
  HOST = host;
  PORT = Number(port);
  TOKEN = token || "";

  push.init();

  // Turns nobody here started still move their session file; tell the app so it
  // can follow along instead of showing a snapshot.
  watch.start(emitExternal);
  setInterval(refreshInterest, 30000).unref?.();

  for (const p of Object.values(providers)) {
    Promise.resolve(p.init()).catch((e) => console.error(`provider ${p.name} init failed:`, e));
  }

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, HOST, () => {
      for (const p of Object.values(providers)) {
        p.setEndpoint?.({ host: HOST, port: PORT });
      }

      resolve({ server, host: HOST, port: PORT, token: TOKEN });
    });
  });
}
