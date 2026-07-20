// codex-phone — self-hosted mobile UI for your Codex and Claude CLI sessions.
// Bridges provider CLIs to a phone-friendly web page over HTTP + SSE. Each
// request selects a provider ("codex" default, or "claude").
//
// This module exports startServer(); the runnable entry point is bin/codex-phone.mjs.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexProvider } from "./providers/codex.mjs";
import { ClaudeProvider } from "./providers/claude.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- config (set by startServer) ----------

let HOST = "127.0.0.1";
let PORT = 8484;
let TOKEN = "";
const COOKIE_NAME = "cxp_session";

// ---------- SSE fan-out ----------

const sseClients = new Set(); // http responses subscribed to events

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const res of sseClients) {
    res.write(frame);
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

// ---------- routes ----------

const routes = {
  "GET /api/threads": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    json(res, 200, await p.listThreads({ search: url.searchParams.get("search"), cursor: url.searchParams.get("cursor") }));
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
