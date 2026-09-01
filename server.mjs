// codex-phone — self-hosted mobile UI for your Codex and Claude CLI sessions.
// Bridges provider CLIs to a phone-friendly web page over HTTP + SSE. Each
// request selects a provider ("codex" default, or "claude").
//
// This module exports startServer(); the runnable entry point is bin/codex-phone.mjs.

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { readConfig } from "./config.mjs";
import { renderIndexHtml } from "./onboarding.mjs";
import { remoteAgentsHome } from "./app-home.mjs";
import * as watch from "./watch.mjs";
import { findRollout } from "./codex-rollout.mjs";
import { CodexProvider } from "./providers/codex.mjs";
import { ClaudeProvider } from "./providers/claude.mjs";
import { GrokProvider } from "./providers/grok.mjs";
import { rankRecentThreads, sortRecentThreads } from "./recent-threads.mjs";
import { validateDispatchSettings, validateNewThreadModel, validateThreadSettingsPatch } from "./dispatch-settings.mjs";
import * as push from "./push.mjs";
import { SendLedger } from "./send-ledger.mjs";
import { ThreadSubscriptions } from "./thread-subscriptions.mjs";
import { pruneAttachments, readAttachment, resolveAttachmentIds, storeAttachment } from "./attachments.mjs";
import { UsageStateStore } from "./usage-state.mjs";
import { usageRetryTrigger, userProgressFromThread, UsageRetryPolicyStore, UsageRetryRunner, UsageRetryStore } from "./usage-retry.mjs";
import { captureReplyStart, notificationBody, notificationTitle } from "./notification-content.mjs";
import { localBridgeProof, localControlProofMatches, validLocalProofNonce } from "./local-proof.mjs";
import { TerminalRunner } from "./terminal-runner.mjs";
import { TerminalSecurity } from "./terminal-security.mjs";
import { PtyTerminalManager } from "./pty-terminal.mjs";
import QRCode from "qrcode";
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
let PUBLIC_ORIGIN = null;
let USABLE_PROVIDER_NAMES = new Set(["codex", "claude", "grok"]);
const COOKIE_NAME = "cxp_session";
const BROWSER_COOKIE_NAME = "cxp_browser";
const TERMINAL_UNLOCK_COOKIE_NAME = "cxp_terminal";
const APP_HOME = remoteAgentsHome();
const AUTH_WINDOW_MS = 60_000;
const AUTH_FAILURE_LIMIT = 5;
const AUTH_MAX_BACKOFF_SECONDS = 60;
const authFailures = new Map();
const threadSubscriptions = new ThreadSubscriptions({ file: join(APP_HOME, "thread-subscriptions.json") });
const threadSettingsStore = new ThreadSettingsStore({ file: join(APP_HOME, "thread-settings.json") });
const usageState = new UsageStateStore({ file: join(APP_HOME, "usage-state.json") });
const usageRetryStore = new UsageRetryStore({ file: join(APP_HOME, "usage-retries.json") });
const usageRetryPolicies = new UsageRetryPolicyStore({ file: join(APP_HOME, "usage-retry-policy.json") });
const terminalRunner = new TerminalRunner();
const ptyTerminals = new PtyTerminalManager();
const terminalSecurity = new TerminalSecurity({
  file: join(APP_HOME, "terminal-security.json"),
  onInvalidate: (event) => {
    ptyTerminals.revoke(event);
    terminalRunner.revokeOwners(event.deviceIds, { all: event.all });
  },
});
const localTerminalAdminNonces = new Map();
let localTerminalBrowserHandoffCount = 0;
const globalUsageInterests = new Map();
const PROJECT_RUN_CANDIDATE_LIMIT = 30;
let threadSettings = null;

// PWA assets available after the pairing cookie is established.
const PWA_FILES = {
  "/sw.js": { file: "sw.js", type: "application/javascript; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/favicon.ico": { file: "icons/icon-192.png", type: "image/png" },
  "/icons/provider-codex.svg": { file: "icons/provider-codex.svg", type: "image/svg+xml" },
  "/icons/provider-claude.svg": { file: "icons/provider-claude.svg", type: "image/svg+xml" },
  "/icons/provider-grok.svg": { file: "icons/provider-grok.svg", type: "image/svg+xml" },
  "/terminal.js": { file: "terminal.js", type: "application/javascript; charset=utf-8", noCache: true },
  "/terminal.css": { file: "terminal.css", type: "text/css; charset=utf-8", noCache: true },
};

// ---------- SSE fan-out ----------

const sseClients = new Set(); // http responses subscribed to events

// Turns this bridge is running, as "provider:threadId". We are told when these
// start and end, so for them the session-file heuristic is a guess about
// something we already know for certain — see trackActiveTurn.
const activeTurns = new Set();
const recentBridgeTerminals = new Map(); // provider:thread -> completion observed from our owner
const BRIDGE_TERMINAL_TTL_MS = 15 * 60 * 1000;

function turnKey(provider, threadId) { return (provider || "codex") + ":" + threadId; }

// A bridge-owned turn already has an authoritative provider event stream.
// Feeding the same turn's session-file mutations into clients creates a second
// producer for identical items and races live deltas against transcript replay.
// External/file updates resume after the provider terminal removes ownership.
export function shouldEmitExternalUpdate(provider, threadId, turns = activeTurns) {
  return !turns.has(turnKey(provider, threadId));
}

// Bridge lifecycle events are authoritative for turns the bridge owns. Claude
// can accept a prompt and then exit without appending an assistant terminal
// record, leaving the session file's final user marker looking active. Suppress
// only when the terminal belongs to that exact marker; a later external prompt
// has a different marker and remains visible as running.
export function resolveThreadRunState({ owned = false, observed = null, bridgeTerminal = null, turnId = null } = {}) {
  if (owned) {
    return { running: true, confidence: "bridge", source: "bridge", turnId };
  }

  const terminalMatchesMarker = !!(
    observed?.running
    && observed.activeMarkerId
    && bridgeTerminal?.activeMarkerId
    && observed.activeMarkerId === bridgeTerminal.activeMarkerId
  );

  if (terminalMatchesMarker) {
    return { running: false, confidence: "bridge_terminal", source: "bridge", turnId: null };
  }

  return {
    running: !!observed?.running,
    confidence: observed?.confidence ?? "unknown",
    source: "session_file",
    turnId: null,
    ...(observed?.terminalOutcome ? {
      terminalId: observed.terminalId ?? null,
      terminalOutcome: observed.terminalOutcome,
      terminalError: observed.terminalError ?? null,
    } : {}),
  };
}

export function canResumeInterruptedRuntime(provider, runtime) {
  if (!runtime || runtime.running || provider?.supportsInterruptedResume?.() !== true) { return false; }
  return runtime.terminalOutcome === "aborted"
    || ["stale_timeout", "historical_stale"].includes(runtime.confidence);
}

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
    recentBridgeTerminals.delete(key);
    activeTurns.add(key);
  } else if (method === "turn/completed" || method === "turn/failed" || method === "turn/aborted") {
    if (activeTurns.has(key)) {
      const observed = watch.runningDetails(provider, [threadId])[threadId];
      recentBridgeTerminals.set(key, {
        at: Date.now(),
        activeMarkerId: observed?.activeMarkerId ?? null,
      });
    }
    activeTurns.delete(key);

    const cutoff = Date.now() - BRIDGE_TERMINAL_TTL_MS;
    for (const [terminalKey, terminal] of recentBridgeTerminals) {
      if ((terminal?.at ?? 0) < cutoff) { recentBridgeTerminals.delete(terminalKey); }
    }
  } else if (method === "thread/adopted" && params.sessionId) {
    // The turn streamed under a draft id; carry it onto the real one.
    if (activeTurns.delete(key)) { activeTurns.add(turnKey(provider, params.sessionId)); }
  }
}

function broadcast(event, data) {
  trackActiveTurn(event, data);
  trackForPush(event, data);

  if (event === "notify" && data?.method === "account/rateLimits/updated" && data.provider) {
    try { usageState.merge(data.provider, { rateLimits: data.params?.rateLimits }); } catch (error) {
      console.error("failed to persist provider usage state:", error);
    }
  }

  if (event === "notify" && data?.method === "account/changing" && data.provider) {
    try { usageState.invalidate(data.provider); } catch (error) {
      console.error("failed to clear usage for changed provider account:", error);
    }
  }

  if (event === "notify" && data?.method === "account/changed" && data.provider) {
    try {
      usageState.invalidate(data.provider);
      usageState.merge(data.provider, { account: data.params?.account, rateLimits: data.params?.rateLimits });
      for (const entry of usageRetryStore.wake(data.provider)) { publishUsageRetry(entry); }
      queueMicrotask(() => usageRetryRunner.tick().catch((error) => console.error("usage retry after account change failed:", error)));
    } catch (error) {
      console.error("failed to apply changed provider account:", error);
    }
  }

  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const res of sseClients) {
    res.write(frame);
  }

  maybeAutoQueueUsageResume(event, data);
}

// ---------- "agent finished" push ----------
//
// Every provider frame passes through broadcast(), so the reply text and the
// end-of-turn signal are both already here — no provider changes needed. We keep
// the last agent message per thread to use as the notification body, and the
// thread's title from the last list response for the headline.

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

async function emitExternal({ provider, threadId, running, runConfidence, terminalId, terminalOutcome, terminalText, terminalError, changed }) {
  const key = metaKey(provider, threadId);
  const terminal = { terminalId, terminalOutcome, terminalError, observedChange: changed === true };

  if (!shouldEmitExternalUpdate(provider, threadId)) { return; }

  if (!changed) {
    trackExternalCompletion({ provider, threadId, terminalId, terminalOutcome, terminalError, reply: terminalText }).catch(() => {});
    broadcast("external", { provider, threadId, running, runConfidence, ...terminal });
    return;
  }

  // A bell-only interest needs run-state and an exact terminal cursor, not a
  // full transcript diff. Large Codex rollouts can exceed 1 GB and parsing one
  // synchronously would stall every HTTP/SSE/provider operation on the bridge.
  if (!hasRecentPresence(provider, [threadId])) {
    trackExternalCompletion({ provider, threadId, terminalId, terminalOutcome, terminalError, reply: terminalText }).catch(() => {});
    broadcast("external", { provider, threadId, running, runConfidence, ...terminal });
    return;
  }

  const since = Date.now() - (lastRead.get(key) ?? 0);

  if (reading.has(key) || since < MIN_READ_MS) {
    // Coalesce: report liveness now (without `changed`, so the app doesn't fall
    // back to re-reading the whole thread) and pick the content up shortly.
    broadcast("external", { provider, threadId, running, runConfidence, ...terminal });

    if (!trailing.has(key)) {
      trailing.set(key, setTimeout(() => {
        trailing.delete(key);
        emitExternal({ provider, threadId, running, runConfidence, terminalId, terminalOutcome, terminalText, terminalError, changed: true });
      }, Math.max(0, MIN_READ_MS - since) + 100));
    }

    return;
  }

  reading.add(key);
  let payload = { provider, threadId, running, runConfidence, ...terminal, result: "unchanged" };
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

  trackExternalCompletion({ provider, threadId, terminalId, terminalOutcome, terminalError, reply: reply || terminalText }).catch(() => {});
  broadcast("external", payload);
}

// Sending or steering a message is not safely repeatable, and a phone on a
// flaky connection cannot tell "never arrived" from "arrived, reply lost".
// Retrying the second case posts the message twice. So each operation carries a
// client-generated requestId, and a replay of one already accepted returns the
// original outcome instead of sending again.
const sendLedger = new SendLedger({ file: join(APP_HOME, "send-ledger.json") });

export function providerOperation(provider, method) {
  const name = method === "resume" ? "resumeInterrupted" : method;
  const operation = provider?.[name];
  if (typeof operation !== "function") {
    throw Object.assign(new Error(`${provider?.name || "provider"} does not support ${method}`), {
      status: 409,
      code: `${method}_unsupported`,
    });
  }
  return operation.bind(provider);
}

async function sendOnce(provider, body, method = "send") {
  const requestId = body?.requestId;
  const patch = {};
  let dispatch = null;
  // Resolve the adapter method before journaling dispatch. A bridge programming
  // or capability error at this point is a definite non-delivery, never an
  // ambiguous provider acknowledgement.
  const operate = providerOperation(provider, method);

  if (method === "send") { dispatch = await validateSendDispatch(provider, body); }

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
    const result = await operate(providerBody);
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

async function validateSendDispatch(provider, body) {
  let listed;
  let capabilities;
  try {
    const catalog = body?.threadId && typeof provider.modelsForThread === "function"
      ? await provider.modelsForThread(body.threadId)
      : await provider.models();
    listed = catalog?.data ?? [];
    capabilities = catalog?.capabilities ?? null;
  } catch (error) {
    throw Object.assign(new Error(`Could not verify ${provider.name} models before sending: ${error?.message ?? error}`), {
      status: 503,
      code: "model_verification_failed",
    });
  }

  const recorded = body?.threadId
    ? await threadSettings.resolve(provider.name, body.threadId)
    : null;
  return validateDispatchSettings(provider.name, body, listed, recorded, capabilities);
}

// The session-file watcher follows only what someone actually has open — the
// same reports that drive unread-only push, reused so nothing extra is polled.
function refreshInterest() {
  const now = Date.now();
  threadSubscriptions.pruneEndpoints((endpoint) => push.has(endpoint));
  const wanted = [...threadSubscriptions.interests(), ...usageRetryPolicies.interests(), ...globalUsageInterests.values()];

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
    lastAgentText.set(key, captureReplyStart(lastAgentText.get(key), params.delta));
    return;
  }

  if (method === "item/completed" && params.item?.type === "agentMessage") {
    lastAgentText.set(key, captureReplyStart("", params.item.text));
    return;
  }

  if (method !== "turn/completed" && method !== "turn/failed") {
    return;
  }

  const failed = method === "turn/failed";
  const rawError = params.error ?? params.turn?.error;
  const errorText = String(typeof rawError === "string" ? rawError : (rawError?.message ?? ""));

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

  const realId = adoptedIds.get(key) || threadId;

  // Already reading it? Then it is not unread — say nothing.
  if (isOnScreen(provider, [threadId, realId])) {
    lastAgentText.delete(key);
    return;
  }

  const body = notificationBody(lastAgentText.get(key), { failed, errorText });

  lastAgentText.delete(key);

  (async () => {
    let title = threadTitles.get(metaKey(provider, realId)) || "";

    // A thread the client never listed (e.g. one just created) has no title yet.
    if (!title) {
      title = await lookupThreadTitle(provider, realId);
    }

    await push.send({
      title: notificationTitle(title),
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

async function trackExternalCompletion({ provider = "codex", threadId, terminalId, terminalOutcome, terminalError, reply = "" } = {}) {
  if (!threadId || !terminalId) { return; }
  const key = metaKey(provider, threadId);
  const ownedAt = recentBridgeTerminals.get(key)?.at ?? 0;

  // An interrupted turn is terminal for run-state purposes, but it is not a
  // successful completion and should not consume a one-shot completion alert
  // or send a misleading "finished" notification.
  if (terminalOutcome === "aborted") {
    threadSubscriptions.acknowledge({ provider, threadId, terminalId });
    return;
  }

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
  const body = notificationBody(reply, { failed, errorText: terminalError?.message });

  await push.send({
    title: notificationTitle(title),
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

function usableProviderEntries() {
  return Object.entries(providers).filter(([name]) => USABLE_PROVIDER_NAMES.has(name));
}

function scopedProviderEntries(scope) {
  if (!scope || scope === "all") { return usableProviderEntries(); }
  return usableProviderEntries().filter(([name]) => name === scope);
}

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
  const selected = name || "codex";
  return USABLE_PROVIDER_NAMES.has(selected) ? providers[selected] ?? null : null;
}

function publicUsageRetry(entry) {
  if (!entry) { return null; }
  const { dispatch, progressGuard, ...publicEntry } = entry;
  return publicEntry;
}

function publishUsageRetry(entry) {
  broadcast("usage-retry", { entry: publicUsageRetry(entry) });
}

function maybeAutoQueueUsageResume(event, data) {
  // Do not recursively inspect the status events emitted by the retry runner.
  if (event === "usage-retry") { return; }
  const threadId = data?.params?.threadId ?? data?.threadId;
  const provider = data?.provider;

  // A usage-limit retry is only a fallback for a stopped turn. If any newer
  // turn starts manually, from another client, or through a provider-native
  // queue, that newer work has already resumed the thread and the old
  // "Continue." must never fire after it. A retry dispatched by this runner is
  // already in `dispatching`, so the store deliberately does not supersede it
  // when its own turn/started event arrives.
  const newerTurnStarted = provider && threadId && (
    (event === "notify" && data.method === "turn/started")
    || (event === "external" && data.running === true && ["marker", "stalled"].includes(data.runConfidence))
  );
  if (newerTurnStarted) {
    const turnId = data?.params?.turn?.id ?? data?.params?.turnId ?? data?.activeMarkerId ?? null;
    for (const entry of usageRetryStore.supersedeThread(provider, threadId, { turnId })) {
      publishUsageRetry(entry);
    }
  }

  if (usageRetryPolicies.isGlobalEnabled() && provider && threadId) {
    const key = metaKey(provider, threadId);
    if (event === "notify" && data.method === "turn/started") {
      globalUsageInterests.set(key, { provider, id: threadId });
      refreshInterest();
    } else if ((event === "notify" && ["turn/completed", "turn/failed", "turn/aborted"].includes(data.method))
        || (event === "external" && data.terminalId && !data.running)) {
      globalUsageInterests.delete(key);
      refreshInterest();
    }
  }
  const trigger = usageRetryTrigger(event, data);
  if (!trigger || !usageRetryPolicies.get(trigger.provider, trigger.threadId).enabled) { return; }
  // Start the transcript snapshot in this same provider event callback. Moving
  // it to a later microtask leaves a window in which a manual Continue can land
  // before the baseline and then look like old history.
  autoQueueUsageResume(trigger).catch((error) => {
    console.error("could not queue usage resume:", error);
  });
}

async function refreshGlobalUsageInterests() {
  if (!usageRetryPolicies.isGlobalEnabled()) {
    if (globalUsageInterests.size) { globalUsageInterests.clear(); refreshInterest(); }
    return;
  }

  for (const [, provider] of usableProviderEntries()) {
    try {
      const listed = await provider.listThreads({ limit: PROJECT_RUN_CANDIDATE_LIMIT });
      const ids = (listed.data ?? []).flatMap((thread) => [thread.id, ...(thread.subagents ?? []).map((child) => child.id)]).filter(Boolean);
      const states = watch.runningDetails(provider.name, ids);
      for (const id of ids) {
        if (states[id]?.running) { globalUsageInterests.set(metaKey(provider.name, id), { provider: provider.name, id }); }
      }
    } catch (error) {
      console.error(`could not refresh ${provider.name} global auto-resume interests:`, error?.message ?? error);
    }
  }
  refreshInterest();
}

async function threadDispatchBody(provider, threadId) {
  const resolved = await threadSettings.resolve(provider.name, threadId);
  const body = {
    provider: provider.name,
    threadId,
    model: resolved.model,
    effort: resolved.effort,
    mode: resolved.mode,
  };
  if (provider.name === "codex" && resolved.modeKnown === false) {
    body.mode = "provider-exact";
    body.approvalPolicy = resolved.approvalPolicy;
    body.sandbox = resolved.sandboxPolicy;
  } else if (provider.name === "codex") {
    const presets = {
      "read-only": { approvalPolicy: "untrusted", sandbox: "read-only" },
      auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      full: { approvalPolicy: "never", sandbox: "danger-full-access" },
    };
    Object.assign(body, presets[resolved.mode] ?? {});
  }
  return body;
}

async function exactThreadDispatch(provider, threadId) {
  const body = await threadDispatchBody(provider, threadId);
  const dispatch = await validateSendDispatch(provider, body);
  return { ...body, ...dispatch };
}

async function threadUserProgress(provider, threadId) {
  const full = await provider.readThread(threadId);
  return userProgressFromThread(full);
}

function userMessageText(item) {
  if (!item || item.type !== "userMessage") { return ""; }
  if (typeof item.text === "string") { return item.text.trim(); }
  return (Array.isArray(item.content) ? item.content : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export async function reconcileUserIntent(provider, threadId, baseline, text) {
  const full = await provider.readThread(threadId);
  const users = (full?.thread?.turns ?? []).flatMap((turn) => turn.items ?? []).filter((item) => item?.type === "userMessage");
  const before = Number(baseline?.userCount);
  if (!Number.isSafeInteger(before) || before < 0 || before >= users.length) {
    return { state: "unconfirmed", progress: userProgressFromThread(full) };
  }
  if (baseline?.lastUserId && before > 0 && String(users[before - 1]?.id ?? "") !== String(baseline.lastUserId)) {
    return { state: "unconfirmed", progress: userProgressFromThread(full) };
  }
  const expected = String(text ?? "").trim();
  if (!expected) { return { state: "unconfirmed", progress: userProgressFromThread(full) }; }
  // Only the immediate next canonical user message can satisfy this attempt.
  // A wider search makes repeated prompts such as "continue" falsely prove a
  // later failed send merely because an older identical message exists.
  const next = users[before];
  if (!next) { return { state: "unconfirmed", progress: userProgressFromThread(full) }; }
  const matched = userMessageText(next) === expected;
  // User messages are append-only. Once a different canonical message occupies
  // the position immediately after this attempt's verified cursor, the missing
  // attempt cannot arrive later without violating transcript order. This is
  // stronger proof of non-delivery than an unchanged transcript: a later send
  // has already crossed the exact boundary where this one would have appeared.
  return { state: matched ? "accepted" : "superseded", progress: userProgressFromThread(full) };
}

export function confirmCanonicalNonDelivery(reconciliation, baseline, runtime) {
  if (reconciliation?.state === "superseded") { return true; }
  if (reconciliation?.state !== "unconfirmed" || runtime?.running) { return false; }
  if (!["marker", "bridge_terminal", "provider"].includes(runtime?.confidence)) { return false; }
  const before = Number(baseline?.userCount);
  return Number.isSafeInteger(before)
    && reconciliation.progress?.userCount === before
    && String(reconciliation.progress?.lastUserId ?? "") === String(baseline?.lastUserId ?? "");
}

const autoQueueUsageLocks = new Map();

async function autoQueueUsageResumeInner({ provider: providerName, threadId, triggerId, terminalId = null }) {
  if (!usageRetryPolicies.get(providerName, threadId).enabled) { return null; }
  const prior = terminalId ? usageRetryStore.findByDispatchedTurn(providerName, threadId, terminalId) : null;
  if (prior) {
    let progressGuard;
    try {
      progressGuard = await threadUserProgress(pickProvider(providerName), threadId);
    } catch (error) {
      // Delivery was already accepted. A transient transcript read cannot turn
      // that fact into failure or justify another automatic send.
      const unreadable = usageRetryStore.update(prior.id, {
        error: { message: `Could not verify thread progress: ${error?.message ?? error}`, code: "thread_progress_unavailable", status: error?.status ?? null },
      });
      publishUsageRetry(unreadable);
      return unreadable;
    }
    const waiting = usageRetryStore.rearmDispatchedTurn(providerName, threadId, terminalId, {
      requestId: `usage-resume:${randomUUID()}`,
      triggerId,
      progressGuard,
      nextCheckAt: Date.now() + 60_000,
    });
    if (waiting) { publishUsageRetry(waiting); }
    return waiting;
  }
  if (usageRetryStore.list({ provider: providerName, threadId, activeOnly: true }).length) { return null; }
  if (usageRetryStore.list({ provider: providerName, threadId }).some((entry) => entry.triggerId === triggerId)) { return null; }
  const provider = pickProvider(providerName);
  if (!provider) { return null; }
  let progressGuard;
  try {
    progressGuard = await threadUserProgress(provider, threadId);
  } catch (error) {
    const failed = createUsageRetry(provider, { threadId, text: "Continue." }, { triggerId });
    const terminal = usageRetryStore.update(failed.id, {
      state: "failed",
      nextCheckAt: null,
      error: { message: `Could not verify thread progress: ${error?.message ?? error}`, code: "thread_progress_unavailable", status: error?.status ?? null },
    });
    publishUsageRetry(terminal);
    return terminal;
  }
  let body;
  try {
    body = await exactThreadDispatch(provider, threadId);
  } catch (error) {
    if (error?.code !== "model_verification_failed" && error?.status != null && error.status < 500) {
      const failed = usageRetryStore.create({
        id: randomUUID(), provider: provider.name, threadId, triggerId,
        requestId: `usage-resume:${randomUUID()}`, text: "Continue.", dispatch: {},
      });
      const terminal = usageRetryStore.update(failed.id, {
        state: "failed",
        nextCheckAt: null,
        error: { message: `Could not verify exact thread settings: ${error?.message ?? error}`, code: error?.code ?? "settings_unavailable", status: error?.status ?? null },
      });
      publishUsageRetry(terminal);
      return terminal;
    }

    // Model discovery happens before any message can reach Codex. A control
    // process exit here is safely retryable and must not discard the user's
    // auto-resume intent. Capture the provider-recorded settings without using
    // them until a later model catalog proves the exact combination.
    body = await threadDispatchBody(provider, threadId);
    const queued = createUsageRetry(provider, body, { triggerId, progressGuard });
    const waiting = usageRetryStore.update(queued.id, {
      state: "waiting_provider",
      nextCheckAt: Date.now() + 60_000,
      error: { message: `Codex is temporarily unavailable: ${error?.message ?? error}`, code: error?.code ?? "provider_unavailable", status: error?.status ?? null },
    });
    publishUsageRetry(waiting);
    return waiting;
  }
  const entry = createUsageRetry(provider, body, { triggerId, progressGuard });
  publishUsageRetry(entry);
  scheduleUsageRetryCheck(entry.id);
  return entry;
}

async function autoQueueUsageResume(trigger) {
  const key = metaKey(trigger?.provider, trigger?.threadId);
  const previous = autoQueueUsageLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => autoQueueUsageResumeInner(trigger));
  autoQueueUsageLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (autoQueueUsageLocks.get(key) === current) { autoQueueUsageLocks.delete(key); }
  }
}

function createUsageRetry(provider, body, { triggerId = null, progressGuard = null } = {}) {
  const dispatch = {
    model: body.model,
    effort: body.effort,
    mode: body.mode,
    approvalPolicy: body.approvalPolicy ?? null,
    sandbox: body.sandbox ?? null,
    cwd: body.cwd ?? null,
    draft: false,
  };
  return usageRetryStore.create({
    id: randomUUID(),
    provider: provider.name,
    threadId: body.threadId,
    requestId: `usage-resume:${randomUUID()}`,
    text: body.text || "Continue.",
    dispatch,
    triggerId,
    progressGuard,
  });
}

const usageRetryRunner = new UsageRetryRunner({
  store: usageRetryStore,
  readUsage: async (providerName, threadId) => {
    const provider = pickProvider(providerName);
    if (!provider) { throw Object.assign(new Error("provider is unavailable"), { status: 409, code: "provider_unavailable" }); }
    const threadSpecific = threadId && typeof provider.usageForThread === "function";
    const live = await boundedUsageRefresh(threadSpecific
      ? provider.usageForThread(threadId, { refresh: true })
      : provider.usage({ refresh: true }));
    const selectedProfileId = threadSpecific && typeof provider.threadAccountState === "function"
      ? provider.threadAccountState(threadId).selectedProfileId
      : "shared";
    const snapshot = selectedProfileId === "shared" ? usageState.merge(provider.name, live) : live;
    return { ...snapshot, _capacityFresh: live?._fresh?.rateLimits === true && live?._fresh?.account === true };
  },
  readRuntime: async (providerName, threadId) => {
    const provider = pickProvider(providerName);
    if (!provider) { throw Object.assign(new Error("provider is unavailable"), { status: 409, code: "provider_unavailable" }); }
    return threadRuntime(provider, threadId);
  },
  readProgress: async (providerName, threadId) => {
    const provider = pickProvider(providerName);
    if (!provider) { throw Object.assign(new Error("provider is unavailable"), { status: 409, code: "provider_unavailable" }); }
    return threadUserProgress(provider, threadId);
  },
  reconcileDelivery: async (entry) => {
    const provider = pickProvider(entry.provider);
    if (!provider) { throw Object.assign(new Error("provider is unavailable"), { status: 409, code: "provider_unavailable" }); }
    const ledger = sendLedger.status({
      provider: entry.provider,
      method: "send",
      requestId: entry.requestId,
      threadId: entry.threadId,
    });
    if (ledger.state === "accepted") { return { state: "accepted" }; }

    // The provider transcript is canonical even when the HTTP acknowledgement
    // and send ledger outcome were lost. Match only the immediate message after
    // the saved cursor, so an older or later "Continue." cannot be mistaken for
    // this attempt.
    const canonical = await reconcileUserIntent(provider, entry.threadId, entry.progressGuard, entry.text);
    if (canonical.state === "accepted") { return { state: "accepted" }; }
    const before = Number(entry.progressGuard?.userCount);
    const after = Number(canonical.progress?.userCount);
    if (Number.isSafeInteger(before) && Number.isSafeInteger(after) && after > before) {
      return { state: "superseded" };
    }
    // send-ledger writes `dispatching` synchronously before invoking a provider.
    // Therefore not_found/failed plus an unchanged canonical transcript proves
    // this attempt did not become a provider message and can be safely re-armed.
    if (["not_found", "failed"].includes(ledger.state)) { return { state: "retryable" }; }
    return { state: "unconfirmed" };
  },
  prepare: async (entry) => {
    const provider = pickProvider(entry.provider);
    if (!provider) { throw Object.assign(new Error("provider is unavailable"), { status: 409, code: "provider_unavailable" }); }
    // Rebuild the complete current snapshot. validateSendDispatch deliberately
    // returns only model/effort/mode; replacing the durable dispatch with that
    // projection used to drop Codex approvalPolicy+sandbox, so the second
    // validation correctly rejected every automatic Continue.
    return exactThreadDispatch(provider, entry.threadId);
  },
  send: async (entry) => {
    const provider = pickProvider(entry.provider);
    if (!provider) { throw Object.assign(new Error("provider is unavailable"), { status: 409, code: "provider_unavailable" }); }
    return sendOnce(provider, {
      provider: entry.provider,
      threadId: entry.threadId,
      text: entry.text,
      requestId: entry.requestId,
      ...(entry.dispatch ?? {}),
    });
  },
  onUpdate: publishUsageRetry,
});

function scheduleUsageRetryCheck(id) {
  queueMicrotask(() => {
    usageRetryRunner.check(id).catch((error) => console.error("usage retry check failed:", error));
  });
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

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie ?? "").split(/;\s*/)) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index) === name) {
      try {
        return decodeURIComponent(part.slice(index + 1));
      } catch {
        // A public request can contain arbitrary cookie bytes. Treat malformed
        // percent encoding as a missing identity instead of throwing out of an
        // HTTP or WebSocket event callback and terminating the bridge.
        return null;
      }
    }
  }
  return null;
}

function secureRequest(req) {
  return req.socket.encrypted || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

function trustedHttpsRequest(req) {
  return !!req.socket.encrypted || (isLoopback(req) && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https");
}

function cookieHeader(name, value, { maxAge = 31536000, sameSite = "Strict", httpOnly = true, secure = true } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=${sameSite}${httpOnly ? "; HttpOnly" : ""}${secure ? "; Secure" : ""}`;
}

function appendCookies(res, values) {
  const previous = res.getHeader?.("set-cookie");
  const list = previous == null ? [] : Array.isArray(previous) ? previous : [previous];
  res.setHeader("set-cookie", list.concat(values));
}

function ensureBrowserIdentity(req, res) {
  const existing = cookieValue(req, BROWSER_COOKIE_NAME);
  if (existing && existing.length >= 32) { return existing; }
  const created = randomBytes(32).toString("base64url");
  appendCookies(res, [cookieHeader(BROWSER_COOKIE_NAME, created, { sameSite: "Lax", secure: secureRequest(req) })]);
  return created;
}

function exactTerminalOrigin(req) {
  const supplied = String(req.headers.origin ?? "");
  if (!PUBLIC_ORIGIN || !supplied || supplied === "null") { return false; }
  try { return new URL(supplied).origin === PUBLIC_ORIGIN; } catch { return false; }
}

function requireTerminalOrigin(req) {
  if (!exactTerminalOrigin(req)) {
    throw Object.assign(new Error("terminal request origin was rejected"), { status: 403, code: "terminal_origin_rejected" });
  }
}

function terminalBrowser(req) {
  const value = cookieValue(req, BROWSER_COOKIE_NAME);
  if (!value) { throw Object.assign(new Error("terminal browser identity is missing; reload the app"), { status: 401, code: "terminal_browser_required" }); }
  return value;
}

function terminalUnlock(req) {
  return cookieValue(req, TERMINAL_UNLOCK_COOKIE_NAME);
}

function setTerminalUnlock(req, res, value, maxAgeMs) {
  appendCookies(res, [cookieHeader(TERMINAL_UNLOCK_COOKIE_NAME, value, {
    maxAge: Math.max(1, Math.floor(maxAgeMs / 1000)),
    secure: secureRequest(req),
  })]);
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
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data), "cache-control": "no-store" });
  res.end(data);
}

const USAGE_REFRESH_TIMEOUT_MS = 10000;

function boundedUsageRefresh(operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Usage refresh timed out")), USAGE_REFRESH_TIMEOUT_MS);
    timer.unref?.();
  });

  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
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

function readTextBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (value) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes <= maxBytes) { chunks.push(chunk); }
    });
    req.on("end", () => bytes > maxBytes
      ? reject(Object.assign(new Error("body too large"), { status: 413, code: "body_too_large" }))
      : resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
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

function threadRuntime(provider, threadId) {
  const owned = activeTurns.has(turnKey(provider.name, threadId));
  const observed = watch.runningDetails(provider.name, [threadId])[threadId];
  const runtime = resolveThreadRunState({
    owned,
    observed,
    bridgeTerminal: recentBridgeTerminals.get(turnKey(provider.name, threadId)),
    turnId: owned ? (provider.activeTurnId?.(threadId) ?? null) : null,
  });
  if (canResumeInterruptedRuntime(provider, runtime)) {
    runtime.canResumeInterrupted = true;
  }
  return runtime;
}

export async function resolveProviderRuntime(provider, threadId, runtime) {
  if (!runtime?.running || !["stalled", "heuristic"].includes(runtime.confidence)
      || typeof provider?.latestTurnState !== "function") {
    return runtime;
  }

  try {
    const latest = await provider.latestTurnState(threadId);
    if (latest?.status === "interrupted") {
      return {
        running: false,
        confidence: "provider",
        source: "provider",
        turnId: null,
        terminalId: latest.id ? `codex:${latest.id}` : null,
        terminalOutcome: "aborted",
        terminalError: null,
        canResumeInterrupted: provider.supportsInterruptedResume?.() === true,
      };
    }
    if (["completed", "failed"].includes(latest?.status)) {
      return {
        running: false,
        confidence: "provider",
        source: "provider",
        turnId: null,
        terminalId: latest.id ? `codex:${latest.id}` : null,
        terminalOutcome: latest.status,
        terminalError: null,
      };
    }
    if (["inProgress", "running"].includes(latest?.status)) {
      return { ...runtime, running: true, confidence: "provider", source: "provider", turnId: latest.id ?? null };
    }
  } catch {
    // Transcript reads remain available even when Codex app-server is unhealthy.
    // Keep the explicitly degraded file observation instead of hiding the thread.
  }
  return runtime;
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

function findThreadSummary(rows, threadId) {
  for (const row of rows ?? []) {
    if (row?.id === threadId) { return row; }
    const child = findThreadSummary(row?.subagents, threadId);
    if (child) { return child; }
  }
  return null;
}

async function resolveTerminalContext(providerName, threadId) {
  const provider = pickProvider(providerName);
  if (!provider || !threadId) {
    throw Object.assign(new Error("provider and threadId are required"), { status: 400, code: "terminal_context_invalid" });
  }
  const listed = await provider.listThreads({ limit: null });
  const thread = findThreadSummary(listed?.data, threadId);
  if (!thread?.cwd) {
    throw Object.assign(new Error("this thread does not report a project directory"), { status: 409, code: "terminal_context_unavailable" });
  }
  let cwd;
  try { cwd = realpathSync(thread.cwd); } catch {
    throw Object.assign(new Error("the thread project directory no longer exists"), { status: 409, code: "terminal_context_unavailable" });
  }
  if (!statSync(cwd).isDirectory()) {
    throw Object.assign(new Error("the thread project path is not a directory"), { status: 409, code: "terminal_context_unavailable" });
  }
  return { provider: provider.name, threadId, cwd, title: thread.name || thread.preview || "Project terminal" };
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

async function listThreadsWithState(p, { search, cursor, limit } = {}) {
  const listed = await p.listThreads({ search, cursor, limit });
  rememberThreadTitles(p.name, listed.data);

  // Whether each thread is mid-turn, read off the CLI's own session file, so
  // the list badges turns this bridge never started (and turns that were
  // already under way before the app was opened).
  const threadIds = (listed.data ?? []).flatMap((t) => [t.id, ...(t.subagents ?? []).map((child) => child.id)]);
  const running = watch.runningDetails(p.name, threadIds);

  for (const t of listed.data ?? []) {
    for (const child of t.subagents ?? []) {
      const childOwned = activeTurns.has(turnKey(p.name, child.id));
      const childState = resolveThreadRunState({
        owned: childOwned,
        observed: running[child.id],
        bridgeTerminal: recentBridgeTerminals.get(turnKey(p.name, child.id)),
      });
      child.running = childState.running;
      child.runConfidence = childState.confidence;
    }

    // A task is active when its own turn or any grouped subagent is active.
    const owned = activeTurns.has(turnKey(p.name, t.id));
    const activeChild = (t.subagents ?? []).some((child) => child.running);
    const taskState = resolveThreadRunState({
      owned,
      observed: running[t.id],
      bridgeTerminal: recentBridgeTerminals.get(turnKey(p.name, t.id)),
    });
    t.running = taskState.running || activeChild;
    t.runConfidence = activeChild && !taskState.running ? "subagent" : taskState.confidence;
  }

  return listed;
}

async function listProjectThreadsWithState(p, { search } = {}) {
  const listed = await p.listThreads({ search, limit: null });
  rememberThreadTitles(p.name, listed.data);
  const candidates = [...(listed.data ?? [])]
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
    .slice(0, PROJECT_RUN_CANDIDATE_LIMIT);
  const candidateIds = candidates.flatMap((thread) => [thread.id, ...(thread.subagents ?? []).map((child) => child.id)]);
  const running = watch.runningDetails(p.name, candidateIds);

  for (const thread of listed.data ?? []) {
    for (const child of thread.subagents ?? []) {
      const owned = activeTurns.has(turnKey(p.name, child.id));
      const state = resolveThreadRunState({ owned, observed: running[child.id], bridgeTerminal: recentBridgeTerminals.get(turnKey(p.name, child.id)) });
      child.running = state.running;
      child.runConfidence = state.confidence;
    }

    const owned = activeTurns.has(turnKey(p.name, thread.id));
    const activeChild = (thread.subagents ?? []).some((child) => child.running);
    const state = resolveThreadRunState({ owned, observed: running[thread.id], bridgeTerminal: recentBridgeTerminals.get(turnKey(p.name, thread.id)) });
    thread.running = state.running || activeChild;
    thread.runConfidence = activeChild && !state.running ? "subagent" : state.confidence;
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

export function startLocalTerminalBrowserHandoff({
  provider,
  threadId,
  browserSecret,
  ttlMs = 60_000,
  browserBootstrapTtlMs,
  createEnrollment = () => terminalSecurity.createEnrollment(),
  createBrowserBootstrap = (input) => terminalSecurity.createBrowserBootstrap(input),
} = {}) {
  if (typeof browserSecret !== "string" || browserSecret.length < 32) {
    throw Object.assign(new Error("terminal browser handoff is incomplete"), { status: 409, code: "terminal_handoff_invalid" });
  }
  if (localTerminalBrowserHandoffCount >= 8) {
    throw Object.assign(new Error("too many terminal setup windows are already open"), { status: 429, code: "terminal_setup_busy" });
  }
  localTerminalBrowserHandoffCount += 1;
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + ttlMs;

  return new Promise((resolveHandoff, rejectHandoff) => {
    let consumed = false;
    let released = false;
    const releaseSlot = () => {
      if (released) { return; }
      released = true;
      localTerminalBrowserHandoffCount = Math.max(0, localTerminalBrowserHandoffCount - 1);
    };
    const local = createServer((request, response) => {
      let requestUrl;
      try { requestUrl = new URL(request.url, "http://127.0.0.1"); } catch { requestUrl = null; }
      const supplied = String(requestUrl?.searchParams.get("handoff") ?? "");
      const expected = Buffer.from(secret);
      const actual = Buffer.from(supplied);
      const valid = request.method === "GET"
        && requestUrl?.pathname === "/terminal-enable"
        && !consumed
        && Date.now() <= expiresAt
        && actual.length === expected.length
        && timingSafeEqual(actual, expected);

      if (!valid) {
        response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
        return response.end('{"error":"not found"}');
      }

      consumed = true;
      try {
        const enrollment = createEnrollment();
        const bootstrap = createBrowserBootstrap({
          browserSecret,
          enrollmentSecret: enrollment.secret,
          context: { provider, threadId },
          ttlMs: browserBootstrapTtlMs,
        });
        const target = new URL("/api/terminal/handoff", bootstrap.origin ?? enrollment.origin);
        target.searchParams.set("handoff", bootstrap.secret);
        response.writeHead(302, { location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer", connection: "close" });
        response.end();
      } catch (error) {
        const data = JSON.stringify({ error: error.message, code: error.code });
        response.writeHead(error.status ?? 500, { "content-type": "application/json", "content-length": Buffer.byteLength(data), "cache-control": "no-store" });
        response.end(data);
      } finally {
        setImmediate(() => local.close());
      }
    });

    const timer = setTimeout(() => local.close(), ttlMs);
    timer.unref?.();
    local.on("close", () => { clearTimeout(timer); releaseSlot(); });
    local.once("error", (error) => { releaseSlot(); rejectHandoff(error); });
    local.listen(0, "127.0.0.1", () => {
      const address = local.address();
      const port = typeof address === "object" && address ? address.port : null;
      if (!port) {
        local.close();
        return rejectHandoff(new Error("could not open local terminal setup"));
      }
      local.unref?.();
      resolveHandoff({
        url: `http://127.0.0.1:${port}/terminal-enable?handoff=${encodeURIComponent(secret)}`,
        expiresAt,
        close: () => { if (local.listening) { local.close(); } },
      });
    });
  });
}

export function createTerminalDeviceHandoff({
  provider,
  threadId,
  targetBrowserSecret = randomBytes(32).toString("base64url"),
  createEnrollment = () => terminalSecurity.createEnrollment(),
  createBrowserBootstrap = (input) => terminalSecurity.createBrowserBootstrap(input),
} = {}) {
  const enrollment = createEnrollment();
  const bootstrap = createBrowserBootstrap({
    // A newly trusted phone must get its own browser identity. Reusing the
    // authorizing Mac's identity would couple revocation and passkey records.
    browserSecret: targetBrowserSecret,
    enrollmentSecret: enrollment.secret,
    context: { provider, threadId },
  });
  const target = new URL("/api/terminal/handoff", bootstrap.origin ?? enrollment.origin);
  target.searchParams.set("handoff", bootstrap.secret);
  return { url: target.toString(), code: enrollment.code, expiresAt: enrollment.expiresAt };
}

export async function requireReachableTerminalOrigin(origin, resolveHost = lookup) {
  let url;
  try { url = new URL(origin); } catch {
    throw Object.assign(new Error("The saved terminal address is invalid. Re-run Remote Agents setup."), { status: 409, code: "terminal_origin_unavailable" });
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw Object.assign(new Error("Terminal passkeys require a stable HTTPS app address."), { status: 409, code: "terminal_origin_unavailable" });
  }
  try {
    await resolveHost(url.hostname);
  } catch {
    const tailscale = url.hostname.endsWith(".ts.net");
    throw Object.assign(new Error(tailscale
      ? "The saved Tailscale address is offline. Open Tailscale and connect, then try again."
      : "The saved app address is offline. Restore its tunnel or re-run Remote Agents setup, then try again."), {
      status: 409,
      code: "terminal_origin_unreachable",
    });
  }
  return url.origin;
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
    const providerScope = url.searchParams.get("provider") || "all";
    const providerEntries = scopedProviderEntries(providerScope);

    if (!providerEntries.length) {
      return json(res, 400, { error: "provider is unavailable" });
    }

    const decodedCursor = decodeRecentCursor(url.searchParams.get("cursor"));
    const cursorState = Object.fromEntries(providerEntries.map(([name]) => [name, decodedCursor[name]]));
    const entries = providerEntries.filter(([name]) => cursorState[name] !== false && !recentProviderUnavailable(cursorState[name]));
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

  "GET /api/threads/projects": async (_req, res, url) => {
    const providerScope = url.searchParams.get("provider") || "all";
    const providerEntries = scopedProviderEntries(providerScope);

    if (!providerEntries.length) {
      return json(res, 400, { error: "provider is unavailable" });
    }

    const search = url.searchParams.get("search");
    const settled = await Promise.allSettled(providerEntries.map(([, p]) => listProjectThreadsWithState(p, { search })));
    const rows = [];
    const unavailableProviders = [];

    settled.forEach((result, index) => {
      if (result.status === "fulfilled") { rows.push(...(result.value.data ?? [])); }
      else { unavailableProviders.push(providerEntries[index][0]); }
    });

    json(res, 200, {
      data: rows,
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
    const runtime = await resolveProviderRuntime(p, id, threadRuntime(p, id));

    // Seed the delta baseline from exactly what this client is being given, so
    // the next change is measured against it. Paging backwards is not a new
    // baseline — it doesn't move the client's view of the live tail.
    const cursor = before == null
      ? seedSnapshot(p.name, id, (full?.thread?.turns ?? []).flatMap((t) => t.items ?? []))
      : { generation: snapshots.get(metaKey(p.name, id))?.generation ?? null, revision: snapshots.get(metaKey(p.name, id))?.revision ?? 0 };

    json(res, 200, { ...tailOfThread(full, before), ...cursor, runtime, userProgress: userProgressFromThread(full) });
  },

  "GET /api/thread/runtime": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) { return; }

    const threadId = url.searchParams.get("threadId");

    if (!threadId) {
      return json(res, 400, { error: "threadId required", code: "invalid_runtime_request" });
    }

    json(res, 200, { runtime: await resolveProviderRuntime(p, threadId, threadRuntime(p, threadId)) });
  },

  "GET /api/send/status": async (_req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) { return; }

    const method = url.searchParams.get("method");
    if (!["send", "steer", "resume"].includes(method)) {
      return json(res, 400, { error: "method must be send, steer, or resume", code: "invalid_send_status_request" });
    }

    json(res, 200, sendLedger.status({
      provider: p.name,
      method,
      requestId: url.searchParams.get("requestId"),
      threadId: url.searchParams.get("threadId") || null,
    }));
  },

  "POST /api/send/reconcile": async (req, res) => {
    const body = await readBody(req, 1024 * 1024);
    const p = pickProvider(body.provider);
    if (!p) { return json(res, 400, { error: "unknown provider", code: "unknown_provider" }); }
    if (!body.threadId || !body.baseline || typeof body.text !== "string" || !Number.isSafeInteger(Number(body.baseline.userCount))) {
      return json(res, 400, { error: "threadId, baseline, and text required", code: "invalid_reconcile_request" });
    }
    const reconciliation = await reconcileUserIntent(p, body.threadId, body.baseline, body.text);
    const runtime = await resolveProviderRuntime(p, body.threadId, threadRuntime(p, body.threadId));
    json(res, 200, confirmCanonicalNonDelivery(reconciliation, body.baseline, runtime)
      ? { ...reconciliation, state: "not_sent" }
      : reconciliation);
  },

  "GET /api/models": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    const threadId = url.searchParams.get("threadId");
    json(res, 200, threadId && typeof p.modelsForThread === "function"
      ? await p.modelsForThread(threadId)
      : await p.models());
  },

  "GET /api/thread/settings": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) { return; }

    const threadId = url.searchParams.get("threadId");

    if (!threadId) {
      return json(res, 400, { error: "threadId required" });
    }

    // Keep transcript/settings reads independent of provider startup and model
    // discovery. The client already loaded the provider catalog separately;
    // any repair it proposes comes back through the validated POST boundary.
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

    let catalog;
    try {
      catalog = typeof p.modelsForThread === "function"
        ? await p.modelsForThread(body.threadId)
        : await p.models();
    } catch (error) {
      throw Object.assign(new Error(`Could not verify ${p.name} models before saving settings: ${error?.message ?? error}`), {
        status: 503,
        code: "model_verification_failed",
      });
    }
    const recorded = await threadSettings.resolve(p.name, body.threadId);
    const validated = validateThreadSettingsPatch(p.name, patch, catalog?.data ?? [], recorded, catalog?.capabilities ?? null);
    json(res, 200, { ok: true, stored: threadSettings.remember(p.name, body.threadId, validated, { pending: body.pending !== false }) });
  },

  "GET /api/usage": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) {
      return;
    }

    try {
      const live = await boundedUsageRefresh(p.usage({ refresh: url.searchParams.get("refresh") === "1" }));
      json(res, 200, usageState.merge(p.name, live));
    } catch (error) {
      const fallback = usageState.merge(p.name, {});

      if (fallback.rateLimits) {
        fallback._meta.refreshError = true;
        fallback._meta.refreshErrorMessage = String(error?.message ?? error);
        return json(res, 200, fallback);
      }

      throw error;
    }
  },

  "GET /api/usage/snapshot": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) { return; }

    json(res, 200, usageState.merge(p.name, {}));
  },

  "GET /api/codex/thread-account": async (_req, res, url) => {
    const provider = pickProvider("codex");
    const threadId = url.searchParams.get("threadId");
    if (!provider || typeof provider.threadAccountState !== "function") {
      return json(res, 409, { error: "Codex is unavailable", code: "provider_unavailable" });
    }
    if (!threadId) {
      return json(res, 400, { error: "threadId is required", code: "invalid_thread_account" });
    }
    json(res, 200, provider.threadAccountState(threadId));
  },

  "POST /api/codex/thread-account": async (req, res) => {
    const provider = pickProvider("codex");
    if (!provider || typeof provider.setThreadAccount !== "function") {
      return json(res, 409, { error: "Codex is unavailable", code: "provider_unavailable" });
    }
    const body = await readBody(req);
    const state = await provider.setThreadAccount(body);
    for (const entry of usageRetryStore.list({ provider: "codex", threadId: body?.threadId, activeOnly: true })) {
      scheduleUsageRetryCheck(entry.id);
    }
    json(res, 200, state);
  },

  "GET /api/usage-retries": async (_req, res, url) => {
    const provider = url.searchParams.get("provider") || undefined;
    const threadId = url.searchParams.get("threadId") || undefined;
    json(res, 200, { data: usageRetryStore.list({ provider, threadId }).map(publicUsageRetry) });
  },

  "POST /api/usage-retries": async (req, res) => {
    const body = await readBody(req);
    const provider = providerFromBody(res, body);
    if (!provider) { return; }
    if (!body?.threadId || !body?.text) {
      return json(res, 400, { error: "threadId and text are required", code: "invalid_usage_retry" });
    }

    const existing = usageRetryStore.list({ provider: provider.name, threadId: body.threadId, activeOnly: true })[0];
    if (existing) { return json(res, 200, { entry: publicUsageRetry(existing), existing: true }); }

    // Capture exactly the currently selected turn settings, then re-validate
    // them at dispatch time. A delayed resume must fail closed rather than let
    // any provider silently choose a newer default model or permission mode.
    const progressGuard = await threadUserProgress(provider, body.threadId);
    const dispatch = await validateSendDispatch(provider, body);
    const entry = createUsageRetry(provider, { ...body, ...dispatch }, { progressGuard });
    publishUsageRetry(entry);
    scheduleUsageRetryCheck(entry.id);
    json(res, 201, { entry: publicUsageRetry(entry) });
  },

  "POST /api/usage-retries/cancel": async (req, res) => {
    const body = await readBody(req);
    const entry = usageRetryStore.cancel(body?.id);
    publishUsageRetry(entry);
    json(res, 200, { entry: publicUsageRetry(entry) });
  },

  "POST /api/usage-retries/check": async (req, res) => {
    const body = await readBody(req);
    const entry = await usageRetryRunner.check(body?.id);
    if (!entry) { return json(res, 404, { error: "usage resume request not found", code: "usage_retry_not_found" }); }
    json(res, 200, { entry: publicUsageRetry(entry) });
  },

  "GET /api/usage-retry-policy": async (_req, res, url) => {
    const provider = url.searchParams.get("provider");
    const threadId = url.searchParams.get("threadId");
    if (!provider || !threadId) { return json(res, 400, { error: "provider and threadId are required", code: "invalid_usage_retry" }); }
    if (!pickProvider(provider)) { return json(res, 400, { error: `unknown provider: ${provider}`, code: "invalid_usage_retry" }); }
    json(res, 200, usageRetryPolicies.get(provider, threadId));
  },

  "POST /api/usage-retry-policy": async (req, res) => {
    const body = await readBody(req);
    if (body?.scope === "global") {
      usageRetryPolicies.setGlobal(body.enabled);
      queueMicrotask(() => refreshGlobalUsageInterests());
      return json(res, 200, body.provider && body.threadId
        ? usageRetryPolicies.get(body.provider, body.threadId)
        : { globalEnabled: body.enabled });
    }
    if (body?.scope !== "thread") { return json(res, 400, { error: "scope must be global or thread", code: "invalid_usage_retry" }); }
    if (!pickProvider(body.provider)) { return json(res, 400, { error: `unknown provider: ${body.provider}`, code: "invalid_usage_retry" }); }
    const policy = usageRetryPolicies.setThread(body.provider, body.threadId, body.enabled);
    refreshInterest();
    json(res, 200, policy);
  },

  "GET /api/terminal/security/status": async (req, res) => {
    const browserSecret = terminalBrowser(req);
    const access = terminalSecurity.status({ browserSecret, unlockToken: terminalUnlock(req) });
    const backend = await ptyTerminals.capability();
    json(res, 200, { access, backend });
  },

  // A paired browser may ask for a one-click setup handoff. Redemption is
  // served from a separate ephemeral listener bound only to 127.0.0.1, not
  // from the bridge port forwarded by Funnel/cloudflared.
  "POST /api/terminal/local-handoff": async (req, res) => {
    if (!PUBLIC_ORIGIN) {
      return json(res, 409, { error: "Configure a stable HTTPS app address before enabling terminal access", code: "terminal_origin_unavailable" });
    }
    const body = await readBody(req, 16 * 1024);
    const provider = String(body?.provider ?? "");
    const threadId = String(body?.threadId ?? "");
    if (!USABLE_PROVIDER_NAMES.has(provider) || !threadId || threadId.length > 500) {
      return json(res, 400, { error: "provider and threadId are required", code: "terminal_context_invalid" });
    }
    await requireReachableTerminalOrigin(PUBLIC_ORIGIN);
    const browserSecret = ensureBrowserIdentity(req, res);
    json(res, 200, await startLocalTerminalBrowserHandoff({ provider, threadId, browserSecret }));
  },

  // A terminal opened from localhost or a LAN address must still perform
  // WebAuthn on the configured HTTPS origin. Transfer the paired browser via a
  // one-use capability instead of weakening the exact RP/origin check or
  // placing the bridge's permanent pairing token in a URL.
  "POST /api/terminal/browser-handoff": async (req, res) => {
    if (!PUBLIC_ORIGIN) {
      return json(res, 409, { error: "Configure a stable HTTPS app address before opening terminal access", code: "terminal_origin_unavailable" });
    }
    const body = await readBody(req, 16 * 1024);
    const provider = String(body?.provider ?? "");
    const threadId = String(body?.threadId ?? "");
    if (!USABLE_PROVIDER_NAMES.has(provider) || !threadId || threadId.length > 500) {
      return json(res, 400, { error: "provider and threadId are required", code: "terminal_context_invalid" });
    }
    await requireReachableTerminalOrigin(PUBLIC_ORIGIN);
    const bootstrap = terminalSecurity.createBrowserBootstrap({
      browserSecret: ensureBrowserIdentity(req, res),
      context: { provider, threadId },
    });
    const target = new URL("/api/terminal/handoff", bootstrap.origin ?? PUBLIC_ORIGIN);
    target.searchParams.set("handoff", bootstrap.secret);
    json(res, 200, { url: target.toString() });
  },

  // An already unlocked terminal device can authorize another browser without
  // returning to the CLI. The link is short-lived and one-use; redemption
  // gives the new browser its own identity and then starts passkey enrollment.
  "POST /api/terminal/device-handoff": async (req, res) => {
    requireTerminalOrigin(req);
    const browserSecret = terminalBrowser(req);
    terminalSecurity.requireUnlock(terminalUnlock(req), browserSecret);
    const body = await readBody(req, 16 * 1024);
    const provider = String(body?.provider ?? "");
    const threadId = String(body?.threadId ?? "");
    if (!USABLE_PROVIDER_NAMES.has(provider) || !threadId || threadId.length > 500) {
      return json(res, 400, { error: "provider and threadId are required", code: "terminal_context_invalid" });
    }
    await requireReachableTerminalOrigin(PUBLIC_ORIGIN);
    const handoff = createTerminalDeviceHandoff({ provider, threadId });
    handoff.qr = await QRCode.toString(handoff.url, {
      type: "svg", margin: 1, width: 240, errorCorrectionLevel: "M",
      color: { dark: "#edf1f7", light: "#11161e" },
    });
    json(res, 200, handoff);
  },

  "POST /api/terminal/register/options": async (req, res) => {
    requireTerminalOrigin(req);
    const body = await readBody(req, 64 * 1024);
    json(res, 200, await terminalSecurity.registrationOptions({
      capability: body?.capability,
      browserSecret: terminalBrowser(req),
      label: body?.label,
    }));
  },

  "POST /api/terminal/register/verify": async (req, res) => {
    requireTerminalOrigin(req);
    const body = await readBody(req, 256 * 1024);
    const result = await terminalSecurity.verifyRegistration({
      ceremonyId: body?.ceremonyId,
      response: body?.response,
      browserSecret: terminalBrowser(req),
    });
    setTerminalUnlock(req, res, result.unlockToken, result.idleExpiresIn);
    json(res, 200, { device: result.device });
  },

  "POST /api/terminal/auth/options": async (req, res) => {
    requireTerminalOrigin(req);
    json(res, 200, await terminalSecurity.authenticationOptions({ browserSecret: terminalBrowser(req) }));
  },

  "POST /api/terminal/auth/verify": async (req, res) => {
    requireTerminalOrigin(req);
    const body = await readBody(req, 256 * 1024);
    const result = await terminalSecurity.verifyAuthentication({
      ceremonyId: body?.ceremonyId,
      response: body?.response,
      browserSecret: terminalBrowser(req),
    });
    setTerminalUnlock(req, res, result.unlockToken, result.idleExpiresIn);
    json(res, 200, { device: result.device });
  },

  "POST /api/terminal/ticket": async (req, res) => {
    requireTerminalOrigin(req);
    const body = await readBody(req, 64 * 1024);
    const context = await resolveTerminalContext(body?.provider, body?.threadId);
    json(res, 200, { ...terminalSecurity.issueTicket({
      unlockToken: terminalUnlock(req),
      browserSecret: terminalBrowser(req),
      context,
    }), context });
  },

  // The one-shot runner is retained for machines where the optional PTY addon
  // cannot load. It is not an auth fallback: every shell path requires the same
  // passkey unlock and server-derived project context.
  "POST /api/terminal/run": async (req, res) => {
    requireTerminalOrigin(req);
    const browserSecret = terminalBrowser(req);
    const { device } = terminalSecurity.requireUnlock(terminalUnlock(req), browserSecret);
    const body = await readBody(req, 64 * 1024);
    const context = await resolveTerminalContext(body?.provider, body?.threadId);
    json(res, 202, terminalRunner.start({ cwd: context.cwd, command: body?.command, owner: device.id }));
  },

  "GET /api/terminal/status": async (req, res, url) => {
    const browserSecret = terminalBrowser(req);
    const { device } = terminalSecurity.requireUnlock(terminalUnlock(req), browserSecret);
    json(res, 200, terminalRunner.get(url.searchParams.get("id"), url.searchParams.get("offset"), device.id));
  },

  "POST /api/terminal/stop": async (req, res) => {
    requireTerminalOrigin(req);
    const browserSecret = terminalBrowser(req);
    const { device } = terminalSecurity.requireUnlock(terminalUnlock(req), browserSecret);
    const body = await readBody(req, 64 * 1024);
    json(res, 200, terminalRunner.stop(body?.id, device.id));
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

  "POST /api/resume": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);
    if (!p) { return; }
    if (p.supportsInterruptedResume?.() !== true || typeof p.resumeInterrupted !== "function") {
      return json(res, 409, { error: "native interrupted-turn resume is only available for Codex", code: "resume_unsupported" });
    }
    json(res, 200, await sendOnce(p, body, "resume"));
  },

  "POST /api/steer": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) {
      return;
    }

    json(res, 200, await sendOnce(p, body, "steer"));
  },

  "POST /api/queue": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) { return; }

    json(res, 200, await p.queue({
      ...body,
      attachments: resolveAttachmentIds(body?.attachmentIds ?? []),
    }));
  },

  "GET /api/queue": async (req, res, url) => {
    const p = providerFromQuery(res, url);

    if (!p) { return; }

    json(res, 200, await p.queueList({
      threadId: url.searchParams.get("threadId"),
      cursor: url.searchParams.get("cursor") || null,
      limit: Number(url.searchParams.get("limit")) || 100,
    }));
  },

  "POST /api/queue/update": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) { return; }

    json(res, 200, await p.queueUpdate({
      ...body,
      attachments: resolveAttachmentIds(body?.attachmentIds ?? []),
    }));
  },

  "POST /api/queue/delete": async (req, res) => {
    const body = await readBody(req);
    const p = providerFromBody(res, body);

    if (!p) { return; }

    json(res, 200, await p.queueDelete(body));
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

  // A setup process uses this challenge to prove the saved local port belongs
  // to the bridge without sending its long-lived pairing token to an unknown
  // listener. The nonce is single-use client randomness; the HMAC never reveals
  // the token. Keep the endpoint loopback-only and deliberately unbranded.
  if (url.pathname === "/internal/local-proof" && req.method === "GET") {
    const nonce = url.searchParams.get("nonce");
    if (!isLoopback(req) || !validLocalProofNonce(nonce)) {
      return json(res, 404, { error: "not found" });
    }
    return json(res, 200, { proof: localBridgeProof(TOKEN, nonce) });
  }

  if (url.pathname === "/internal/terminal-admin" && req.method === "POST") {
    if (!isLoopback(req)) { return json(res, 404, { error: "not found" }); }
    try {
      const raw = await readTextBody(req);
      const nonce = String(req.headers["x-remote-agents-nonce"] ?? "");
      const proof = String(req.headers["x-remote-agents-proof"] ?? "");
      if (!localControlProofMatches(TOKEN, nonce, raw, proof)) { return json(res, 404, { error: "not found" }); }
      const now = Date.now();
      for (const [seen, at] of localTerminalAdminNonces) {
        if (now - at > 60_000) { localTerminalAdminNonces.delete(seen); }
      }
      if (localTerminalAdminNonces.has(nonce)) { return json(res, 409, { error: "terminal administration request was already used", code: "local_control_replay" }); }
      localTerminalAdminNonces.set(nonce, now);
      const body = raw ? JSON.parse(raw) : {};
      if (body.action === "enable") { return json(res, 200, terminalSecurity.createEnrollment()); }
      if (body.action === "devices") { return json(res, 200, terminalSecurity.listDevices()); }
      if (body.action === "revoke") { return json(res, 200, terminalSecurity.revokeDevice(String(body.deviceId ?? ""))); }
      if (body.action === "disable") { return json(res, 200, terminalSecurity.disable()); }
      return json(res, 400, { error: "unknown terminal administration action" });
    } catch (error) {
      return json(res, error.status ?? 500, { error: error.message, code: error.code });
    }
  }

  // The localhost-only setup listener redirects here after proving that this
  // browser is running on the bridge Mac. The capability is short-lived,
  // stored only as a hash, and consumed before cookies are issued. This lets a
  // paired browser move from an old/local origin to the configured HTTPS origin
  // without ever putting the bridge's permanent token in a URL.
  // This intentionally lives below /api/: every deployed service worker
  // already bypasses that namespace, so an older cached worker cannot replace
  // this redirect with the offline app shell and consume the one-use secret.
  if (url.pathname === "/api/terminal/handoff" && req.method === "GET") {
    const expectedOrigin = PUBLIC_ORIGIN ? new URL(PUBLIC_ORIGIN) : null;
    const exactHost = expectedOrigin && String(req.headers.host ?? "") === expectedOrigin.host;
    const fetchDestination = String(req.headers["sec-fetch-dest"] ?? "");
    const blocked = authBlock(req);
    if (blocked) {
      res.setHeader("retry-after", String(blocked));
      return json(res, 429, { error: "too_many_attempts" });
    }
    if (!expectedOrigin || !trustedHttpsRequest(req) || !exactHost || (fetchDestination && fetchDestination !== "document")) {
      return rejectAuth(req, res, url, { attempted: true });
    }
    const bootstrap = terminalSecurity.consumeBrowserBootstrap(url.searchParams.get("handoff") ?? "");
    if (!bootstrap) {
      if (isAuthed(req)) {
        res.writeHead(302, { location: "/terminal", "cache-control": "no-store", "referrer-policy": "no-referrer" });
        return res.end();
      }
      return rejectAuth(req, res, url, { attempted: true });
    }

    clearAuthFailures(req);
    const target = new URL("/terminal", PUBLIC_ORIGIN);
    target.searchParams.set("provider", bootstrap.context.provider);
    target.searchParams.set("threadId", bootstrap.context.threadId);
    if (bootstrap.enrollmentSecret) {
      target.hash = `enroll=${encodeURIComponent(bootstrap.enrollmentSecret)}`;
    }
    const browserIdentity = cookieValue(req, BROWSER_COOKIE_NAME) || bootstrap.browserSecret;
    res.writeHead(302, {
      "set-cookie": [
        cookieHeader(COOKIE_NAME, TOKEN, { sameSite: "Lax", secure: true }),
        cookieHeader(BROWSER_COOKIE_NAME, browserIdentity, { sameSite: "Lax", secure: true }),
      ],
      location: target.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    return res.end();
  }

  // Internal endpoint for the Claude PreToolUse hook (loopback only, secret-auth
  // inside the provider). No session cookie — the hook has no browser context.
  if (url.pathname === "/internal/claude-approval" && req.method === "POST") {
    if (!isLoopback(req)) {
      return json(res, 403, { error: "loopback only" });
    }

    if (!USABLE_PROVIDER_NAMES.has("claude")) {
      return json(res, 404, { error: "not found" });
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
      const secure = secureRequest(req);
      const browserIdentity = cookieValue(req, BROWSER_COOKIE_NAME) || randomBytes(32).toString("base64url");
      res.writeHead(302, {
        "set-cookie": [
          cookieHeader(COOKIE_NAME, TOKEN, { sameSite: "Lax", secure }),
          cookieHeader(BROWSER_COOKIE_NAME, browserIdentity, { sameSite: "Lax", secure }),
        ],
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
    ensureBrowserIdentity(req, res);

    const body = renderIndexHtml(req.headers["user-agent"] ?? "", [...USABLE_PROVIDER_NAMES]);
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

  if (req.method === "GET" && (url.pathname === "/terminal" || url.pathname === "/terminal.html")) {
    ensureBrowserIdentity(req, res);
    const file = join(__dirname, "public", "terminal.html");
    if (!existsSync(file)) { return json(res, 404, { error: "not found" }); }
    // xterm computes cell geometry with inline style properties. Keep scripts
    // self-only and allow inline CSS solely in this isolated terminal document.
    res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(file));
  }

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
    } else if (entry.noCache) {
      headers["cache-control"] = "no-store";
    } else {
      headers["cache-control"] = "max-age=86400";
    }

    res.writeHead(200, headers);
    return res.end(readFileSync(file));
  }

  // Math fonts deliberately use a non-service-worker path. During a guarded
  // deploy the new HTML can be observed before this server process restarts;
  // an old server must return an uncached 404, not let the worker retain a font
  // under the old JavaScript MIME type.
  if (req.method === "GET" && url.pathname.startsWith("/math-fonts/")) {
    const name = basename(url.pathname);
    const file = join(__dirname, "public", "vendor", name);
    if (/^KaTeX_[A-Za-z0-9-]+\.woff2$/.test(name) && existsSync(file)) {
      res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=86400" });
      return res.end(readFileSync(file));
    }
    return json(res, 404, { error: "not found" });
  }

  // Vendored static assets. basename() prevents traversal; an explicit MIME
  // map keeps the terminal stylesheet from being served as executable script.
  if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
    const file = join(__dirname, "public", "vendor", basename(url.pathname));

    if (existsSync(file)) {
      const body = readFileSync(file);
      const type = ({
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".woff2": "font/woff2",
      })[extname(file).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "max-age=86400" });
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
const terminalWebSockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });

function rejectUpgrade(socket, status = 403, message = "Forbidden") {
  try { socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
}

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/api/terminal/ws") { return rejectUpgrade(socket, 404, "Not Found"); }
    if (!tokenMatches(cookieValue(req, COOKIE_NAME)) || !cookieValue(req, BROWSER_COOKIE_NAME) || !exactTerminalOrigin(req)) {
      return rejectUpgrade(socket);
    }
    terminalWebSockets.handleUpgrade(req, socket, head, (webSocket) => {
      terminalWebSockets.emit("connection", webSocket, req);
    });
  } catch {
    // Upgrade handlers run outside the normal HTTP route try/catch. Never let
    // hostile headers or WebSocket parser failures escape into the bridge.
    return rejectUpgrade(socket, 400, "Bad Request");
  }
});

terminalWebSockets.on("connection", (socket, req) => {
  const browserSecret = cookieValue(req, BROWSER_COOKIE_NAME);
  let session = null;
  let authenticated = false;
  let authenticating = false;
  let inputWindowAt = Date.now();
  let inputBytes = 0;
  const authTimer = setTimeout(() => socket.close(4401, "terminal authentication timed out"), 5000);
  authTimer.unref?.();

  socket.on("message", async (payload, isBinary) => {
    if (isBinary || payload.length > 16 * 1024) { return socket.close(4400, "invalid terminal frame"); }
    let frame;
    try { frame = JSON.parse(payload.toString("utf8")); } catch { return socket.close(4400, "invalid terminal frame"); }

    if (!authenticated) {
      if (authenticating) { return socket.close(4401, "terminal authentication already in progress"); }
      if (frame?.type !== "auth" || typeof frame.ticket !== "string") { return socket.close(4401, "terminal ticket required"); }
      authenticating = true;
      let ticket;
      try { ticket = terminalSecurity.consumeTicket(frame.ticket, browserSecret); } catch { return socket.close(4403, "terminal ticket rejected"); }
      authenticated = true;
      clearTimeout(authTimer);
      try {
        session = await ptyTerminals.attach(socket, {
          deviceId: ticket.deviceId,
          context: ticket.context,
          cols: frame.cols,
          rows: frame.rows,
        });
        // Revocation can race the asynchronous native PTY spawn. If it happened
        // before the manager registered this session, the invalidation callback
        // could not see it; recheck here. A later revocation sees and closes it.
        terminalSecurity.requireDevice(ticket.deviceId);
        if (socket.readyState !== 1) { ptyTerminals.detach(session, socket); }
      } catch (error) {
        if (session) { ptyTerminals.closeSession(session.id, "terminal access rejected"); }
        try { socket.send(JSON.stringify({ type: "error", message: error.message, code: error.code })); } catch {}
        socket.close(1011, "terminal backend unavailable");
      }
      return;
    }

    if (!session) { return socket.close(1011, "terminal session unavailable"); }
    try {
      if (frame.type === "input") {
        const now = Date.now();
        if (now - inputWindowAt >= 1000) { inputWindowAt = now; inputBytes = 0; }
        inputBytes += Buffer.byteLength(String(frame.data ?? ""));
        if (inputBytes > 64 * 1024) { return socket.close(4429, "terminal input rate exceeded"); }
        ptyTerminals.input(session, frame.data, frame.seq);
      } else if (frame.type === "resize") {
        ptyTerminals.resize(session, frame.cols, frame.rows);
      } else if (frame.type === "close") {
        ptyTerminals.closeSession(session.id, "closed by user");
      } else {
        socket.close(4400, "unknown terminal frame");
      }
    } catch (error) {
      try { socket.send(JSON.stringify({ type: "error", message: error.message, code: error.code })); } catch {}
    }
  });

  socket.on("close", () => {
    clearTimeout(authTimer);
    if (session) { ptyTerminals.detach(session, socket); }
  });
  socket.on("error", () => {});
});

// Start the bridge. Resolves once listening. Caller owns host/port/token
// resolution and any user-facing output (pairing URL, QR).
export function configureServer({ host = "0.0.0.0", port = 0, token, publicOrigin = null, usableProviders } = {}) {
  // Older codex-phone installs generated 12-character pairing identities.
  // Continue accepting those saved identities so an upgrade does not strand an
  // already-installed phone. New generated and explicit CLI tokens remain at
  // least 32 characters (enforced by resolveConfig in the CLI).
  if (typeof token !== "string" || token.length < 12) {
    throw new Error("A pairing token of at least 12 characters is required");
  }

  HOST = host;
  PORT = Number(port);
  TOKEN = token;
  PUBLIC_ORIGIN = publicOrigin ? new URL(publicOrigin).origin : null;
  terminalSecurity.configureOrigin(PUBLIC_ORIGIN);

  const names = usableProviders == null ? Object.keys(providers) : [...new Set(usableProviders)];
  const unknown = names.filter((name) => !providers[name]);
  if (unknown.length) {
    throw new Error(`Unknown usable provider: ${unknown.join(", ")}`);
  }
  USABLE_PROVIDER_NAMES = new Set(names);
}

export function startServer(options = {}) {
  configureServer(options);

  pruneAttachments();
  push.init();

  // Turns nobody here started still move their session file; tell the app so it
  // can follow along instead of showing a snapshot.
  watch.start(emitExternal);
  setInterval(refreshInterest, 30000).unref?.();
  setInterval(() => usageRetryRunner.tick().catch((error) => console.error("usage retry tick failed:", error)), 10000).unref?.();
  queueMicrotask(() => usageRetryRunner.tick().catch((error) => console.error("initial usage retry tick failed:", error)));
  setInterval(() => refreshGlobalUsageInterests(), 60000).unref?.();
  queueMicrotask(() => refreshGlobalUsageInterests());

  for (const [, p] of usableProviderEntries()) {
    Promise.resolve(p.init()).catch((e) => console.error(`provider ${p.name} init failed:`, e));
  }

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, HOST, () => {
      PORT = server.address().port;

      for (const [, p] of usableProviderEntries()) {
        p.setEndpoint?.({ host: HOST, port: PORT });
      }

      resolve({ server, host: HOST, port: PORT, token: TOKEN });
    });
  });
}
