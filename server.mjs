// codex-phone — self-hosted mobile UI for your Codex and Claude CLI sessions.
// Bridges provider CLIs to a phone-friendly web page over HTTP + SSE. Each
// request selects a provider ("codex" default, or "claude").
//
// This module exports startServer(); the runnable entry point is bin/codex-phone.mjs.

import { execFileSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { readConfig } from "./config.mjs";
import { renderIndexHtml } from "./onboarding.mjs";
import { remoteAgentsHome } from "./app-home.mjs";
import * as watch from "./watch.mjs";
import { findRollout } from "./codex-rollout.mjs";
import { CodexProvider } from "./providers/codex.mjs";
import { ClaudeProvider } from "./providers/claude.mjs";
import { GrokProvider } from "./providers/grok.mjs";
import { rankRecentThreads, sortRecentThreads } from "./recent-threads.mjs";
import { validateDispatchSettings, validateNewThreadModel } from "./dispatch-settings.mjs";
import * as push from "./push.mjs";
import { SendLedger } from "./send-ledger.mjs";
import { ThreadSubscriptions } from "./thread-subscriptions.mjs";
import { pruneAttachments, readAttachment, resolveAttachmentIds, storeAttachment } from "./attachments.mjs";
import {
  readClaudeTranscriptThreadSettings,
  readCodexDbThreadSettings,
  readCodexRolloutThreadSettings,
  readGrokSessionThreadSettings,
  ThreadSettingsService,
  ThreadSettingsStore,
} from "./thread-settings.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- config (set by startServer) ----------

let HOST = "127.0.0.1";
let PORT = 0;
let TOKEN = "";
const COOKIE_NAME = "cxp_session";
const APP_HOME = remoteAgentsHome();
const AUTH_WINDOW_MS = 60_000;
const AUTH_FAILURE_LIMIT = 5;
const AUTH_MAX_BACKOFF_SECONDS = 60;
const authFailures = new Map();
const threadSubscriptions = new ThreadSubscriptions({ file: join(APP_HOME, "thread-subscriptions.json") });
const threadSettingsStore = new ThreadSettingsStore({ file: join(APP_HOME, "thread-settings.json") });
let threadSettings = null;

// PWA assets available after the pairing cookie is established.
const PWA_FILES = {
  "/sw.js": { file: "sw.js", type: "application/javascript; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/favicon.ico": { file: "icons/icon-192.png", type: "image/png" },
  "/icons/provider-codex.svg": { file: "icons/provider-codex.svg", type: "image/svg+xml" },
  "/icons/provider-claude.svg": { file: "icons/provider-claude.svg", type: "image/svg+xml" },
  "/icons/provider-grok.svg": { file: "icons/provider-grok.svg", type: "image/svg+xml" },
};

// ---------- SSE fan-out ----------

const sseClients = new Set(); // http responses subscribed to events

// Turns this bridge is running, as "provider:threadId". We are told when these
// start and end, so for them the session-file heuristic is a guess about
// something we already know for certain — see trackActiveTurn.
const activeTurns = new Set();
const recentBridgeTerminals = new Map(); // provider:thread -> completion observed from our owner

function turnKey(provider, threadId) { return (provider || "codex") + ":" + threadId; }

// Keep the safety decision next to the authoritative turn set, not in the UI.
// The optional set makes this exact route path testable without starting a turn.
export async function releaseThreadLock(provider, threadId, turns = activeTurns) {
  if (!threadId) {
    throw Object.assign(new Error("threadId required"), { status: 400 });
  }

  if (turns.has(turnKey(provider?.name, threadId))) {
    throw Object.assign(new Error("the thread is working; wait for the turn to finish before releasing it"), {
      status: 409,
      code: "turn_in_progress",
    });
  }

  if (typeof provider?.releaseThread !== "function") {
    throw Object.assign(new Error("write-lock controls are only available for Codex"), { status: 400 });
  }

  return provider.releaseThread({ threadId });
}

// A session file only reveals a turn is under way if the marker that says so is
// still inside the tail window that gets read. On a large rollout it is not:
// runningStates then falls back to "was this file written to very recently",
// which goes false during any ordinary pause — a long tool call, a slow model
// think — and the thread looks stopped while it is working. That misreport is
// worse than cosmetic: it invites you to re-send a message into a live turn. Our
// own turns never need guessing, so record them and let them override.
function trackActiveTurn(event, data) {
  if (event !== "notify") { return; }

  const { method, params = {}, provider } = data ?? {};
  const threadId = params.threadId;

  if (!method || !threadId) { return; }

  const key = turnKey(provider, threadId);

  if (method === "turn/started") {
    activeTurns.add(key);
  } else if (method === "turn/completed" || method === "turn/failed" || method === "turn/aborted") {
    if (activeTurns.has(key)) { recentBridgeTerminals.set(key, Date.now()); }
    activeTurns.delete(key);

    const cutoff = Date.now() - 60000;
    for (const [terminalKey, at] of recentBridgeTerminals) {
      if (at < cutoff) { recentBridgeTerminals.delete(terminalKey); }
    }
  } else if (method === "thread/adopted" && params.sessionId) {
    // The turn streamed under a draft id; carry it onto the real one.
    if (activeTurns.delete(key)) { activeTurns.add(turnKey(provider, params.sessionId)); }
  }
}

function broadcast(event, data) {
  trackActiveTurn(event, data);
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

// A long session is enormous — one real Codex thread is 11,078 items and 27MB,
// mostly command output — and sending all of it to a phone to show the last
// screenful is hopeless on cellular. Serve the end of the thread and let the app
// page backwards, the way every chat app does.
const THREAD_PAGE_ITEMS = 150;

function tailOfThread(full, before) {
  const turns = full?.thread?.turns ?? [];
  const flat = turns.flatMap((t) => t.items ?? []);
  const end = before == null ? flat.length : Math.max(0, before);
  const start = Math.max(0, end - THREAD_PAGE_ITEMS);

  return {
    ...full,
    thread: {
      ...full?.thread,
      // One turn: the split point is an item index, and re-deriving turn
      // boundaries for a slice would only be decoration.
      turns: [{ items: flat.slice(start, end) }],
    },
    itemWindow: { start, end, total: flat.length, hasMore: start > 0 },
  };
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
// What each watched thread looked like last time we told a client about it.
//
// An earlier design sent "everything past index N", assuming a change is always
// an appended item. That is wrong: every provider's parser *mutates* an earlier
// commandExecution when its output record arrives (codex-rollout.mjs:253,
// claude.mjs:517, grok.mjs:713). The item count does not move, so no delta was
// sent and a command stayed "running" with no output on the phone forever.
//
// So the stream carries operations — append and replace — and a cheap signature
// per position is kept to notice in-place changes.
const snapshots = new Map(); // "provider:threadId" -> { total, sigs: Map(index -> string) }

// Only positions a client could still have on screen are worth tracking; the
// window it was served is 150.
const SIG_WINDOW = 400;

function signature(item) {
  return [
    item?.type ?? "",
    (item?.text ?? "").length,
    (item?.aggregatedOutput ?? "").length,
    item?.status ?? "",
    item?.exitCode ?? "",
    (item?.changes?.length ?? 0),
  ].join("|");
}

function snapshotOf(items, generation, revision) {
  const sigs = new Map();
  const from = Math.max(0, items.length - SIG_WINDOW);

  for (let i = from; i < items.length; i++) {
    sigs.set(i, signature(items[i]));
  }

  return { total: items.length, sigs, generation, revision };
}

// Called when a client is handed a thread, so the very first change afterwards
// is measured against what it actually received. Without this the first growth
// established the baseline and was itself thrown away.
//
// The reply carries {generation, revision}: generation says which file and
// parser these positions belong to, revision orders this response against the
// deltas that follow it — a delta arriving mid-fetch must not be undone by the
// older response landing afterwards.
function seedSnapshot(provider, threadId, items) {
  const key = metaKey(provider, threadId);
  const generation = watch.generationOf(provider, threadId);
  const revision = (snapshots.get(key)?.revision ?? 0) + 1;
  snapshots.set(key, snapshotOf(items, generation, revision));
  return { generation, revision };
}

function diffAgainstSnapshot(prev, items) {
  const ops = [];

  for (let i = Math.max(0, items.length - SIG_WINDOW); i < items.length; i++) {
    if (i >= prev.total) {
      ops.push({ op: "append", index: i, item: items[i] });
      continue;
    }

    const before = prev.sigs.get(i);

    // Outside the tracked window we cannot tell, and the client has almost
    // certainly scrolled past it anyway.
    if (before !== undefined && before !== signature(items[i])) {
      ops.push({ op: "replace", index: i, item: items[i] });
    }
  }

  return ops;
}

// Reading a thread is NOT free, and for Codex it is not even local: it is a
// JSON-RPC round trip to codex app-server that returns the entire thread. Doing
// that once a second per open thread saturates the pipe — the bridge sat at 75%
// CPU and app-server stopped answering at all. So: one read at a time per
// thread, no more often than this, with a trailing read so the last chunk of a
// turn is never left behind.
const MIN_READ_MS = 4000;
const reading = new Set();
const lastRead = new Map();
const trailing = new Map();

async function emitExternal({ provider, threadId, running, runConfidence, terminalId, terminalOutcome, terminalText, changed }) {
  const key = metaKey(provider, threadId);

  if (!changed) {
    trackExternalCompletion({ provider, threadId, terminalId, terminalOutcome, reply: terminalText }).catch(() => {});
    broadcast("external", { provider, threadId, running, runConfidence });
    return;
  }

  // A bell-only interest needs run-state and an exact terminal cursor, not a
  // full transcript diff. Large Codex rollouts can exceed 1 GB and parsing one
  // synchronously would stall every HTTP/SSE/provider operation on the bridge.
  if (!hasRecentPresence(provider, [threadId])) {
    trackExternalCompletion({ provider, threadId, terminalId, terminalOutcome, reply: terminalText }).catch(() => {});
    broadcast("external", { provider, threadId, running, runConfidence });
    return;
  }

  const since = Date.now() - (lastRead.get(key) ?? 0);

  if (reading.has(key) || since < MIN_READ_MS) {
    // Coalesce: report liveness now (without `changed`, so the app doesn't fall
    // back to re-reading the whole thread) and pick the content up shortly.
    broadcast("external", { provider, threadId, running, runConfidence });

    if (!trailing.has(key)) {
      trailing.set(key, setTimeout(() => {
        trailing.delete(key);
        emitExternal({ provider, threadId, running, runConfidence, terminalId, terminalOutcome, terminalText, changed: true });
      }, Math.max(0, MIN_READ_MS - since) + 100));
    }

    return;
  }

  reading.add(key);
  let payload = { provider, threadId, running, runConfidence, result: "unchanged" };
  let reply = "";

  try {
    const p = providers[provider];
    const res = await p?.readThread(threadId);
    const items = (res?.thread?.turns ?? []).flatMap((t) => t.items ?? []);
    reply = [...items].reverse().find((item) => item?.type === "agentMessage" && String(item.text ?? "").trim())?.text ?? "";
    const prev = snapshots.get(key);
    const generation = watch.generationOf(provider, threadId);

    if (!prev) {
      // Nobody has been handed this thread yet, so there is nothing to diff
      // against. Record where it stands; the client's own read seeds the rest.
      snapshots.set(key, snapshotOf(items, generation, 1));
    } else if (generation && prev.generation && generation !== prev.generation) {
      // Different file, or a parser that now reads it differently. Every index
      // the client holds refers to something else now.
      const revision = prev.revision + 1;
      payload = { ...payload, result: "reset", generation, revision };
      snapshots.set(key, snapshotOf(items, generation, revision));
    } else {
      const ops = diffAgainstSnapshot(prev, items);
      const shrank = items.length < prev.total;
      const revision = prev.revision + (shrank || ops.length ? 1 : 0);

      if (shrank) {
        payload = { ...payload, result: "reset", generation, revision };
      } else if (ops.length) {
        payload = { ...payload, result: "ops", ops, generation, revision };
      }

      snapshots.set(key, snapshotOf(items, generation, revision));
    }
  } catch {
    // Say so explicitly rather than leaving the app to infer it from a missing
    // field — that inference was silently doing nothing.
    payload = { ...payload, result: "error" };
  } finally {
    reading.delete(key);
    lastRead.set(key, Date.now());
  }

  trackExternalCompletion({ provider, threadId, terminalId, terminalOutcome, reply: reply || terminalText }).catch(() => {});
  broadcast("external", payload);
}

// Sending or steering a message is not safely repeatable, and a phone on a
// flaky connection cannot tell "never arrived" from "arrived, reply lost".
// Retrying the second case posts the message twice. So each operation carries a
// client-generated requestId, and a replay of one already accepted returns the
// original outcome instead of sending again.
const sendLedger = new SendLedger({ file: join(APP_HOME, "send-ledger.json") });

async function sendOnce(provider, body, method = "send") {
  const requestId = body?.requestId;
  const patch = {};
  let dispatch = null;

  if (method === "send") {
    let listed;
    try {
      listed = (await provider.models())?.data ?? [];
    } catch (error) {
      throw Object.assign(new Error(`Could not verify ${provider.name} models before sending: ${error?.message ?? error}`), {
        status: 503,
        code: "model_verification_failed",
      });
    }

    const recorded = body?.threadId
      ? await threadSettings.resolve(provider.name, body.threadId)
      : null;
    dispatch = validateDispatchSettings(provider.name, body, listed, recorded);
  }

  for (const key of ["model", "effort", "mode"]) {
    if (key === "mode" && body?.mode === "provider-exact") { continue; }
    if (body?.[key] != null) { patch[key] = body[key]; }
  }

  if (body?.threadId && Object.keys(patch).length) {
    // Persist the exact next-turn selection before anything can reach a
    // provider. If this write fails, the turn is not dispatched.
    threadSettings.remember(provider.name, body.threadId, patch, { pending: true });
  }

  const deliver = async () => {
    const providerBody = { ...body, attachments: resolveAttachmentIds(body?.attachmentIds ?? []) };
    if (dispatch?.mode === "provider-exact") { providerBody.preserveProviderPolicy = true; }
    delete providerBody.attachmentIds;
    const result = await provider[method](providerBody);
    return dispatch && result && typeof result === "object"
      ? { ...result, dispatch: { ...dispatch, accepted: true } }
      : result;
  };

  if (!requestId) {
    return deliver();
  }

  return sendLedger.run({
    provider: provider.name,
    method,
    requestId,
    threadId: body?.threadId,
  }, () => {
    // This runs only after the idempotency record is durable and only when a
    // provider operation will actually be attempted (not on a dedup replay or
    // an uncertain-after-restart refusal).
    if (method === "send") {
      broadcast("send-stage", {
        provider: provider.name,
        threadId: body?.threadId,
        requestId,
        stage: "accepted",
      });
    }

    return deliver();
  });
}

// The session-file watcher follows only what someone actually has open — the
// same reports that drive unread-only push, reused so nothing extra is polled.
function refreshInterest() {
  const now = Date.now();
  threadSubscriptions.pruneEndpoints((endpoint) => push.has(endpoint));
  const wanted = threadSubscriptions.interests();

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

  for (const k of snapshots.keys()) {
    if (!live.has(k)) { snapshots.delete(k); }
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

function hasRecentPresence(provider, candidateIds) {
  const now = Date.now();

  for (const p of presence.values()) {
    if (now - p.at <= PRESENCE_TTL_MS && p.provider === (provider || "codex") && p.ids.some((id) => candidateIds.includes(id))) {
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

    rememberThreadTitles(provider, t?.subagents);
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

async function trackExternalCompletion({ provider = "codex", threadId, terminalId, terminalOutcome, reply = "" } = {}) {
  if (!threadId || !terminalId) { return; }
  const key = metaKey(provider, threadId);
  const ownedAt = recentBridgeTerminals.get(key) ?? 0;

  // The ordinary provider event already sends the existing global completion
  // push for a bridge-owned turn. The file watcher sees the same terminal record
  // moments later; advance subscription cursors, but do not buzz twice.
  if (activeTurns.has(turnKey(provider, threadId)) || Date.now() - ownedAt < 60000 || isOnScreen(provider, [threadId])) {
    threadSubscriptions.acknowledge({ provider, threadId, terminalId });
    return;
  }

  if (ownedAt) { recentBridgeTerminals.delete(key); }

  const deliveries = threadSubscriptions.observe({
    provider,
    threadId,
    terminalId,
    outcome: terminalOutcome || "completed",
  });

  if (!deliveries.length) { return; }

  refreshInterest();

  let title = threadTitles.get(key) || "";
  if (!title) { title = await lookupThreadTitle(provider, threadId); }

  const failed = terminalOutcome === "failed";
  const body = String(reply ?? "").trim().replace(/\s+/g, " ").slice(0, 180) || (failed ? "Turn failed" : "Turn finished");
  const label = PROVIDER_LABELS[provider] || "Agent";

  await push.send({
    title: `${label}${failed ? " · failed" : " finished"}${title ? " · " + title.slice(0, 60) : ""}`,
    body,
    threadId,
    provider,
  }, { endpoints: deliveries.map((delivery) => delivery.endpoint) });
}

// Each provider gets an emit callback that tags every frame with its name.
function makeEmit(name) {
  return function emit(event, data) {
    if (event === "notify" && data?.method === "thread/adopted" && data.params?.threadId && data.params?.sessionId) {
      threadSettings?.adopt(name, data.params.threadId, data.params.sessionId);
    }

    broadcast(event, { ...data, provider: name });
  };
}

// ---------- provider registry ----------

const providers = {
  codex: new CodexProvider(makeEmit("codex")),
  claude: new ClaudeProvider(makeEmit("claude")),
  grok: new GrokProvider(makeEmit("grok")),
};

function readCodexThreadSettings(threadId) {
  const database = readCodexDbThreadSettings(threadId);
  const rolloutSettings = readCodexRolloutThreadSettings(findRollout(threadId));
  if (!database) { return rolloutSettings; }
  if (!rolloutSettings) { return database; }
  return {
    ...database,
    model: database.model ?? rolloutSettings.model,
    effort: database.effort ?? rolloutSettings.effort,
    source: database.model == null || database.effort == null
      ? "codex_db+rollout"
      : database.source,
  };
}

threadSettings = new ThreadSettingsService({
  store: threadSettingsStore,
  readers: {
    codex: readCodexThreadSettings,
    claude: (threadId) => readClaudeTranscriptThreadSettings(providers.claude.findTranscriptPath(threadId)),
    grok: (threadId) => readGrokSessionThreadSettings(providers.grok.findSession(threadId)),
  },
});

function pickProvider(name) {
  return providers[name || "codex"] ?? null;
}

// ---------- http helpers ----------

function isAuthed(req) {
  const cookies = req.headers.cookie ?? "";

  if (cookies.split(/;\s*/).some((c) => c.startsWith(`${COOKIE_NAME}=`) && tokenMatches(c.slice(`${COOKIE_NAME}=`.length)))) {
    return true;
  }

  const auth = req.headers.authorization ?? "";
  return auth.startsWith("Bearer ") && tokenMatches(auth.slice("Bearer ".length));
}

function requestClientKey(req) {
  const address = req.socket.remoteAddress ?? "unknown";
  const loopback = address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
  const forwardedValues = loopback ? String(req.headers["x-forwarded-for"] ?? "").split(",").map((value) => value.trim()).filter(Boolean) : [];
  // A local reverse proxy appends the actual peer to any client-supplied chain.
  // Taking the last value prevents an attacker choosing arbitrary rate-limit
  // buckets by sending its own first X-Forwarded-For value.
  const forwarded = forwardedValues.at(-1) ?? "";
  return forwarded || address;
}

function hasAuthCredential(req, url) {
  return url.searchParams.has("t") || !!req.headers.authorization || String(req.headers.cookie ?? "").includes(`${COOKIE_NAME}=`);
}

function authBlock(req, now = Date.now()) {
  const entry = authFailures.get(requestClientKey(req));
  if (!entry?.blockedUntil || entry.blockedUntil <= now) { return null; }
  return Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
}

function recordAuthFailure(req, now = Date.now()) {
  if (authFailures.size >= 4096) {
    for (const [candidate, entry] of authFailures) {
      if (now - entry.firstAt > AUTH_WINDOW_MS && entry.blockedUntil <= now) { authFailures.delete(candidate); }
    }
    while (authFailures.size >= 4096) { authFailures.delete(authFailures.keys().next().value); }
  }

  const key = requestClientKey(req);
  const previous = authFailures.get(key);
  const failures = !previous || now - previous.firstAt > AUTH_WINDOW_MS ? 1 : previous.failures + 1;
  const firstAt = !previous || now - previous.firstAt > AUTH_WINDOW_MS ? now : previous.firstAt;
  const backoffSeconds = failures >= AUTH_FAILURE_LIMIT
    ? Math.min(AUTH_MAX_BACKOFF_SECONDS, 2 ** (failures - AUTH_FAILURE_LIMIT + 1))
    : 0;
  const entry = { failures, firstAt, blockedUntil: backoffSeconds ? now + backoffSeconds * 1000 : 0 };
  authFailures.set(key, entry);
  return backoffSeconds;
}

function clearAuthFailures(req) {
  authFailures.delete(requestClientKey(req));
}

export function resetAuthRateLimits() {
  authFailures.clear();
}

function rejectAuth(req, res, url, { attempted = hasAuthCredential(req, url) } = {}) {
  let retryAfter = attempted ? authBlock(req) : null;
  if (!retryAfter && attempted) { retryAfter = recordAuthFailure(req) || null; }

  if (retryAfter) {
    res.setHeader("retry-after", String(retryAfter));
    return json(res, 429, { error: "too_many_attempts" });
  }

  return json(res, 401, { error: "unauthorized" });
}

function securityHeaders(req, res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const secure = req.socket.encrypted || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
  if (secure) { res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains"); }
}

function tokenMatches(candidate) {
  if (!TOKEN || typeof candidate !== "string") {
    return false;
  }

  const actual = Buffer.from(TOKEN);
  const supplied = Buffer.from(candidate);
  return actual.length === supplied.length && timingSafeEqual(actual, supplied);
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) { return; }

      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      bytes += chunk.length;
      tooLarge = bytes > maxBytes;
      if (!tooLarge) { chunks.push(chunk); }
    });
    req.on("end", () => {
      if (tooLarge) {
        return reject(Object.assign(new Error("body too large"), { status: 413, code: "body_too_large" }));
      }

      try {
        const data = Buffer.concat(chunks).toString("utf8");
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
  return readConfig().fileAccess || "project";
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

async function listThreadsWithState(p, { search, cursor } = {}) {
  const listed = await p.listThreads({ search, cursor });
  rememberThreadTitles(p.name, listed.data);

  // Whether each thread is mid-turn, read off the CLI's own session file, so
  // the list badges turns this bridge never started (and turns that were
  // already under way before the app was opened).
  const threadIds = (listed.data ?? []).flatMap((t) => [t.id, ...(t.subagents ?? []).map((child) => child.id)]);
  const running = watch.runningDetails(p.name, threadIds);

  for (const t of listed.data ?? []) {
    for (const child of t.subagents ?? []) {
      const childOwned = activeTurns.has(turnKey(p.name, child.id));
      child.running = childOwned || !!running[child.id]?.running;
      child.runConfidence = childOwned ? "bridge" : (running[child.id]?.confidence ?? "unknown");
    }

    // A task is active when its own turn or any grouped subagent is active.
    const owned = activeTurns.has(turnKey(p.name, t.id));
    const activeChild = (t.subagents ?? []).some((child) => child.running);
    t.running = owned || !!running[t.id]?.running || activeChild;
    t.runConfidence = owned ? "bridge" : (activeChild ? "subagent" : (running[t.id]?.confidence ?? "unknown"));
  }

  return listed;
}

function decodeRecentCursor(value) {
  if (!value) { return {}; }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw Object.assign(new Error("invalid recent cursor"), { status: 400 });
  }
}

function encodeRecentCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function recentProviderUnavailable(value) {
  return !!value && typeof value === "object" && value.unavailable === true;
}

const routes = {
  "POST /api/attachment": async (req, res) => {
    const body = await readBody(req);
    json(res, 200, storeAttachment(body));
  },

  "GET /api/attachment": async (_req, res, url) => {
    const attachment = readAttachment(url.searchParams.get("id"));
    res.writeHead(200, {
      "content-type": attachment.mimeType,
      "content-length": attachment.data.length,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    });
    res.end(attachment.data);
  },

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

    const listed = await listThreadsWithState(p, {
      search: url.searchParams.get("search"),
      cursor: url.searchParams.get("cursor"),
    });
    json(res, 200, listed);
  },

  "GET /api/threads/recent": async (_req, res, url) => {
    const search = url.searchParams.get("search");
    const cursorState = decodeRecentCursor(url.searchParams.get("cursor"));
    const entries = Object.entries(providers).filter(([name]) => cursorState[name] !== false && !recentProviderUnavailable(cursorState[name]));
    const settled = await Promise.allSettled(entries.map(([name, p]) => listThreadsWithState(p, {
      search,
      cursor: typeof cursorState[name] === "string" ? cursorState[name] : null,
    })));
    const groups = [];
    // Preserve partial-sync truth throughout this pagination chain. Starting a
    // fresh refresh has no cursor, so it naturally retries failed providers.
    const unavailableProviders = Object.entries(cursorState)
      .filter(([, value]) => recentProviderUnavailable(value))
      .map(([name]) => name);
    const nextState = { ...cursorState };

    settled.forEach((result, index) => {
      const providerName = entries[index][0];

      if (result.status === "fulfilled") {
        groups.push(result.value.data ?? []);
        nextState[providerName] = result.value.nextCursor ?? false;
      } else {
        unavailableProviders.push(providerName);
        // A refresh starts a new pagination chain and retries this provider.
        // Within one chain, drop a persistent failure so Load more terminates.
        nextState[providerName] = { unavailable: true };
      }
    });

    const continuation = !!url.searchParams.get("cursor");
    const ranked = continuation ? [] : rankRecentThreads(groups, { limit: 10 });
    const featured = new Set(ranked.map((thread) => `${thread.provider}:${thread.id}`));
    const more = sortRecentThreads(groups.flat().filter((thread) => !featured.has(`${thread.provider}:${thread.id}`)), { runningFirst: false });
    const hasMore = Object.values(nextState).some((providerCursor) => typeof providerCursor === "string");

    json(res, 200, {
      data: ranked.concat(more),
      featuredCount: ranked.length,
      nextCursor: hasMore ? encodeRecentCursor(nextState) : null,
      unavailableProviders,
    });
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
    const endpoint = String(body?.endpoint ?? "");
    threadSubscriptions.removeEndpoint(endpoint);
    refreshInterest();
    json(res, 200, push.unsubscribe(endpoint));
  },

  "POST /api/thread/notifications/status": async (req, res) => {
    if (!isAuthed(req)) {
      return json(res, 401, { error: "unauthorized" });
    }

    const body = await readBody(req);
    const endpoint = String(body?.endpoint ?? "");
    json(res, 200, { enabled: push.has(endpoint), rules: endpoint ? threadSubscriptions.list(endpoint) : [] });
  },

  "POST /api/thread/notifications": async (req, res) => {
    if (!isAuthed(req)) {
      return json(res, 401, { error: "unauthorized" });
    }

    const body = await readBody(req);
    const endpoint = String(body?.endpoint ?? "");
    const provider = String(body?.provider || "codex");
    const threadId = String(body?.threadId ?? "");
    const mode = String(body?.mode ?? "off");

    if (mode !== "off" && !push.has(endpoint)) {
      return json(res, 409, { error: "enable notifications on this device first", code: "push_not_subscribed" });
    }

    try {
      const terminalId = watch.runningDetails(provider, [threadId])[threadId]?.terminalId ?? null;
      const rule = threadSubscriptions.set({ endpoint, provider, threadId, mode, terminalId });
      refreshInterest();
      json(res, 200, rule);
    } catch (e) {
      json(res, e.status ?? 500, { error: String(e.message ?? e) });
    }
  },

  "GET /api/thread": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    const id = url.searchParams.get("id");
    const full = await p.readThread(id);
    const before = Number(url.searchParams.get("before")) || null;
    const owned = activeTurns.has(turnKey(p.name, id));
    const observed = watch.runningDetails(p.name, [id])[id];
    const runtime = {
      running: owned || !!observed?.running,
      confidence: owned ? "bridge" : (observed?.confidence ?? "unknown"),
      source: owned ? "bridge" : "session_file",
    };

    // Seed the delta baseline from exactly what this client is being given, so
    // the next change is measured against it. Paging backwards is not a new
    // baseline — it doesn't move the client's view of the live tail.
    const cursor = before == null
      ? seedSnapshot(p.name, id, (full?.thread?.turns ?? []).flatMap((t) => t.items ?? []))
      : { generation: snapshots.get(metaKey(p.name, id))?.generation ?? null, revision: snapshots.get(metaKey(p.name, id))?.revision ?? 0 };

    json(res, 200, { ...tailOfThread(full, before), ...cursor, runtime });
  },

  "GET /api/models": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    json(res, 200, await p.models());
  },

  "GET /api/thread/settings": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) { return; }

    const threadId = url.searchParams.get("threadId");

    if (!threadId) {
      return json(res, 400, { error: "threadId required" });
    }

    // Provider settings must stay readable even if model discovery is slow or
    // unavailable. The client already has that independent list and compares it.
    json(res, 200, await threadSettings.resolve(p.name, threadId));
  },

  "POST /api/thread/settings": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) { return; }

    if (!body?.threadId) {
      return json(res, 400, { error: "threadId required" });
    }

    const patch = {};
    for (const key of ["model", "effort", "mode"]) {
      if (body[key] !== undefined) { patch[key] = body[key]; }
    }

    json(res, 200, { ok: true, stored: threadSettings.remember(p.name, body.threadId, patch, { pending: body.pending !== false }) });
  },

  "GET /api/usage": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    json(res, 200, await p.usage({ refresh: url.searchParams.get("refresh") === "1" }));
  },

  "GET /api/approvals": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) { return; }

    json(res, 200, { data: p.pendingApprovalsList?.() ?? [] });
  },

  "GET /api/projects": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    json(res, 200, await p.projects());
  },

  "GET /api/thread/lock": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    if (typeof p.lockStatus !== "function") {
      return json(res, 400, { error: "write-lock controls are only available for Codex" });
    }

    json(res, 200, p.lockStatus(url.searchParams.get("threadId")));
  },

  "POST /api/thread/lock/warm": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) {
      return;
    }

    if (typeof p.warmThread !== "function") {
      return json(res, 400, { error: "write-lock controls are only available for Codex" });
    }

    json(res, 200, await p.warmThread(body));
  },

  "POST /api/thread/lock/release": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) {
      return;
    }

    json(res, 200, await releaseThreadLock(p, body.threadId));
  },

  "POST /api/thread/new": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) {
      return;
    }

    let listed;
    try {
      listed = (await p.models())?.data ?? [];
    } catch (error) {
      throw Object.assign(new Error(`Could not verify ${p.name} models before creating the session: ${error?.message ?? error}`), {
        status: 503,
        code: "model_verification_failed",
      });
    }
    body.model = validateNewThreadModel(p.name, body.model, listed);
    json(res, 200, await p.newThread(body));
  },

  "POST /api/message": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) {
      return;
    }

    json(res, 200, await sendOnce(p, body));
  },

  "POST /api/steer": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) {
      return;
    }

    json(res, 200, await sendOnce(p, body, "steer"));
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

function isLoopback(req) {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  securityHeaders(req, res);

  // Internal endpoint for the Claude PreToolUse hook (loopback only, secret-auth
  // inside the provider). No session cookie — the hook has no browser context.
  if (url.pathname === "/internal/claude-approval" && req.method === "POST") {
    if (!isLoopback(req)) {
      return json(res, 403, { error: "loopback only" });
    }

    try {
      const body = await readBody(req);
      const result = await providers.claude.handleHookRequest(body);
      return json(res, 200, result);
    } catch (e) {
      return json(res, 200, { decision: "deny", reason: String(e.message ?? e) });
    }
  }

  if (url.pathname === "/") {
    if (url.searchParams.has("t")) {
      const blocked = authBlock(req);
      if (blocked) {
        res.setHeader("retry-after", String(blocked));
        return json(res, 429, { error: "too_many_attempts" });
      }

      if (!tokenMatches(url.searchParams.get("t"))) {
        return rejectAuth(req, res, url, { attempted: true });
      }

      clearAuthFailures(req);
      const secure = req.socket.encrypted || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
      res.writeHead(302, {
        "set-cookie": `${COOKIE_NAME}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure ? "; Secure" : ""}`,
        location: "/",
        "referrer-policy": "no-referrer",
      });
      return res.end();
    }

    const blocked = hasAuthCredential(req, url) ? authBlock(req) : null;
    if (blocked) {
      res.setHeader("retry-after", String(blocked));
      return json(res, 429, { error: "too_many_attempts" });
    }

    if (!isAuthed(req)) {
      return rejectAuth(req, res, url);
    }

    clearAuthFailures(req);

    const body = renderIndexHtml(req.headers["user-agent"] ?? "");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "cache-control": "no-cache",
      "x-remote-agents": "bridge",
    });
    return res.end(body);
  }

  const blocked = hasAuthCredential(req, url) ? authBlock(req) : null;
  if (blocked) {
    res.setHeader("retry-after", String(blocked));
    return json(res, 429, { error: "too_many_attempts" });
  }

  if (!isAuthed(req)) {
    return rejectAuth(req, res, url);
  }

  clearAuthFailures(req);

  // PWA assets are authenticated too. Manifest and service-worker requests on
  // the paired same-origin app carry its cookie; exposing them before pairing
  // would unnecessarily identify the internet-facing service.
  if (req.method === "GET" && (PWA_FILES[url.pathname] || url.pathname.startsWith("/icons/"))) {
    const iconName = basename(url.pathname);
    const entry = PWA_FILES[url.pathname] ?? { file: join("icons", iconName), type: extname(iconName).toLowerCase() === ".svg" ? "image/svg+xml" : "image/png" };
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

    json(res, e.status ?? 500, { error: String(e.message ?? e), code: e.code, rpc: e.rpc });
  }
}

const server = createServer(handleRequest);

// Start the bridge. Resolves once listening. Caller owns host/port/token
// resolution and any user-facing output (pairing URL, QR).
export function configureServer({ host = "0.0.0.0", port = 0, token } = {}) {
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("A pairing token of at least 16 characters is required");
  }

  HOST = host;
  PORT = Number(port);
  TOKEN = token;
}

export function startServer(options = {}) {
  configureServer(options);

  pruneAttachments();
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
      PORT = server.address().port;

      for (const p of Object.values(providers)) {
        p.setEndpoint?.({ host: HOST, port: PORT });
      }

      resolve({ server, host: HOST, port: PORT, token: TOKEN });
    });
  });
}
