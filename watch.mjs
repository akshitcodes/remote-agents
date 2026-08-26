// codex-phone — follow a thread that something *else* is driving.
//
// The bridge only streams turns it started itself: every event comes from a CLI
// process it spawned. A turn you start in a terminal, in an IDE, or from Codex
// Desktop belongs to a different process, and the only trace it leaves on this
// machine is that CLI's own session file. Nothing here watched those files, so
// an already-running thread could only ever be shown as a snapshot — which is
// why it looked frozen until you closed and reopened it.
//
// This polls the session files of the threads someone actually has on screen
// (one stat per second, for typically one file) and reports two things: that the
// thread moved, and whether a turn is still in flight. The app refetches on the
// ping. That is far cheaper and less fragile than re-deriving three different
// streaming formats from their on-disk logs.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const POLL_MS = 1000;

// How long after its last write a thread whose turn markers we cannot read is
// still assumed to be working.
//
// This is reached more often than "providers that don't log a marker" suggests:
// it also catches any log whose most recent marker sits further back than
// TAIL_BYTES, which is every long turn on a large rollout. In that state this
// value is the *only* thing deciding the badge, so it must outlast an ordinary
// quiet stretch — a single slow tool call or a long model think easily passes
// 25s, and reporting such a thread "stopped" invites re-sending into a live
// turn. Turns this bridge runs itself no longer come through here at all; the
// server records those directly.
const ASSUME_ACTIVE_MS = 90000;

// A turn that is interrupted — you hit escape, the CLI was killed, the machine
// slept — never writes its end marker, so its log is left looking mid-turn
// forever. Past this much silence, stop believing the marker: an agent can go
// quiet for a while during one long tool call, but not this long.
const STALE_AFTER_MS = 10 * 60 * 1000;

// Enough of the file's end to find the most recent turn marker without reading
// a multi-megabyte log on every poll.
const TAIL_BYTES = 96 * 1024;

const paths = new Map(); // "provider:id" -> resolved session file (or null)
const seen = new Map(); // "provider:id" -> { mtimeMs, size, running }
const runCache = new Map(); // "path:mtimeMs:size" -> running

let interest = new Map(); // "provider:id" -> { provider, id }
let timer = null;
let onUpdate = () => {};

function key(provider, id) {
  return `${provider || "codex"}:${id}`;
}

// ---------- locating a provider's session file ----------

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Codex nests rollouts under sessions/<year>/<month>/<day>/ and embeds the
// thread id in the filename.
function findCodexRollout(id) {
  const root = join(homedir(), ".codex", "sessions");
  const stack = [root];

  while (stack.length) {
    const dir = stack.pop();

    for (const entry of safeReaddir(dir)) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.includes(id) && entry.name.endsWith(".jsonl")) {
        return full;
      }
    }
  }

  return null;
}

function findClaudeSession(id) {
  const root = join(homedir(), ".claude", "projects");

  for (const entry of safeReaddir(root)) {
    if (entry.isDirectory()) {
      const candidate = join(root, entry.name, `${id}.jsonl`);

      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

// Grok keys sessions by url-encoded cwd, then one directory per session.
function findGrokHistory(id) {
  const root = join(homedir(), ".grok", "sessions");

  for (const entry of safeReaddir(root)) {
    if (entry.isDirectory()) {
      const candidate = join(root, entry.name, id, "chat_history.jsonl");

      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolvePath(provider, id) {
  const k = key(provider, id);

  if (paths.has(k)) {
    const cached = paths.get(k);

    if (cached && existsSync(cached)) {
      return cached;
    }
  }

  let found = null;

  try {
    if (provider === "claude") {
      found = findClaudeSession(id);
    } else if (provider === "grok") {
      found = findGrokHistory(id);
    } else {
      found = findCodexRollout(id);
    }
  } catch {
    found = null;
  }

  paths.set(k, found);
  return found;
}

// ---------- is a turn still in flight? ----------

function tailLines(path, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const length = size - start;

  if (length <= 0) {
    return [];
  }

  const buf = Buffer.allocUnsafe(length);
  let fd;

  try {
    fd = openSync(path, "r");
    readSync(fd, buf, 0, length, start);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { closeSync(fd); }
  }

  const lines = buf.toString("utf8").split("\n").filter(Boolean);

  // The first line is probably cut in half by the offset.
  return start > 0 ? lines.slice(1) : lines;
}

function parseFromEnd(lines, decide) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let record;

    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    const verdict = decide(record, lines[i]);

    if (verdict !== undefined) {
      return verdict;
    }
  }

  return null;
}

// Codex logs task_started and then either task_complete or turn_aborted.
function recordId(prefix, record, line) {
  const native = record?.id ?? record?.uuid ?? record?.message?.id ?? record?.payload?.turn_id;
  return native ? `${prefix}:${native}` : `${prefix}:${createHash("sha1").update(line).digest("hex").slice(0, 16)}`;
}

function contentText(content) {
  if (typeof content === "string") { return content; }
  if (!Array.isArray(content)) { return ""; }
  return content.map((part) => part?.text ?? "").filter(Boolean).join("\n");
}

function terminalError(error, fallback = "") {
  if (!error && !fallback) { return null; }

  const message = typeof error === "string"
    ? error
    : String(error?.message ?? error?.error ?? fallback ?? "");

  if (!message.trim()) { return null; }

  return {
    message: message.trim().slice(0, 4000),
    code: typeof error === "object" ? (error?.codex_error_info ?? error?.code ?? null) : null,
  };
}

function codexObservation(lines) {
  return parseFromEnd(lines, (r) => {
    const type = r?.payload?.type;

    if (type === "task_started") { return { running: true }; }
    if (type === "turn_aborted") {
      return {
        running: false,
        terminalId: recordId("codex", r, JSON.stringify(r)),
        terminalOutcome: "aborted",
        terminalText: "",
        terminalError: null,
      };
    }
    if (type === "task_complete") {
      const error = terminalError(r.payload?.error);
      return {
        running: false,
        terminalId: recordId("codex", r, JSON.stringify(r)),
        terminalOutcome: error ? "failed" : "completed",
        terminalText: String(r.payload?.last_agent_message ?? ""),
        terminalError: error,
      };
    }

    return undefined;
  });
}

// Claude ends a turn with an assistant message whose stop_reason is end_turn.
// Everything between that and the user's prompt is tool_use / tool_result
// traffic, which we skip over.
function claudeObservation(lines) {
  return parseFromEnd(lines, (r, line) => {
    if (r?.type === "assistant") {
      const reason = r?.message?.stop_reason;

      if (reason && reason !== "tool_use") {
        const text = contentText(r.message?.content);
        const error = reason === "end_turn" ? null : terminalError(null, text || `Claude stopped: ${reason}`);
        return {
          running: false,
          terminalId: recordId("claude", r, line),
          terminalOutcome: error ? "failed" : "completed",
          terminalText: text,
          terminalError: error,
        };
      }

      return undefined;
    }

    if (r?.type === "user" && !r.toolUseResult) {
      const content = r?.message?.content;
      const isToolResult = Array.isArray(content) && content.some((c) => c?.type === "tool_result");

      if (!isToolResult) { return { running: true }; }
    }

    return undefined;
  });
}

// Grok history has no explicit turn-completed envelope, but a real prompt is
// tagged with prompt_index and the final assistant record has no tool calls.
// Synthetic reminders are ignored. Tool-calling assistant records do not end a
// turn; the later plain assistant response does.
function grokObservation(lines) {
  let terminal = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let record;

    try { record = JSON.parse(lines[i]); } catch { continue; }

    if (!terminal && record?.type === "assistant") {
      const hasToolCalls = Array.isArray(record.tool_calls) && record.tool_calls.length > 0;
      const hasContent = typeof record.content === "string" ? !!record.content.trim() : Array.isArray(record.content) && record.content.length > 0;

      if (!hasToolCalls && hasContent) { terminal = { record, line: lines[i] }; }
      continue;
    }

    if (record?.type === "user" && Number.isInteger(record.prompt_index) && !record.synthetic_reason) {
      if (!terminal) { return { running: true }; }

      // Grok assistant records have no native message id. Include prompt_index
      // so two turns that happen to return identical text still notify twice.
      return {
        running: false,
        terminalId: `grok:${record.prompt_index}:${createHash("sha1").update(terminal.line).digest("hex").slice(0, 16)}`,
        terminalOutcome: "completed",
        terminalText: contentText(terminal.record.content),
      };
    }
  }

  if (!terminal) { return null; }
  // Without the prompt_index there is no collision-safe turn identity. Keep
  // the run-state exact, but do not manufacture a notification cursor.
  return { running: false };
}

export function observeProviderTail(provider, lines) {
  if (provider === "claude") { return claudeObservation(lines); }
  if (provider === "grok") { return grokObservation(lines); }
  return codexObservation(lines);
}

// Returns true/false, or null when this provider leaves no usable marker and the
// caller should fall back to "was it written to recently".
function runningDetailFromFile(provider, path, stat) {
  const cacheKey = `${path}:${stat.mtimeMs}:${stat.size}`;
  let observation;

  // Only the marker is cached: it depends purely on the file's bytes. Staleness
  // depends on the clock, so it has to be re-applied every time or a stalled
  // thread would stay "running" forever behind an unchanging cache key.
  if (runCache.has(cacheKey)) {
    observation = runCache.get(cacheKey);
  } else {
    observation = null;

    const lines = tailLines(path, stat.size);

    observation = observeProviderTail(provider, lines);

    runCache.set(cacheKey, observation);

    if (runCache.size > 200) {
      runCache.clear();
    }
  }

  const silentFor = Date.now() - stat.mtimeMs;

  const state = classifyRunningState(observation?.running ?? null, silentFor);

  if (!state.running && state.confidence === "marker" && observation?.terminalId) {
    state.terminalId = observation.terminalId;
    state.terminalOutcome = observation.terminalOutcome ?? "completed";
    state.terminalText = observation.terminalText ?? "";
    state.terminalError = observation.terminalError ?? null;
  }

  return state;
}

export function classifyRunningState(marker, silentFor) {
  if (marker === null) {
    return { running: silentFor < ASSUME_ACTIVE_MS, confidence: "heuristic" };
  }

  if (marker && silentFor > STALE_AFTER_MS) {
    return { running: false, confidence: "stale_timeout" };
  }

  return { running: marker, confidence: "marker" };
}

function runningFromFile(provider, path, stat) {
  return runningDetailFromFile(provider, path, stat).running;
}

// Identity of a thread's log *and* of the code that parses it.
//
// Item positions are only meaningful within one generation. A log that is
// rotated, compacted, truncated-then-regrown, or replaced by a different file at
// the same path reuses positions that a client already holds, which would splice
// unrelated content into its transcript. Comparing size alone misses a same-size
// rewrite, so this pins the inode and fingerprints the head of the file. The
// schema tag is bumped whenever a parser changes what items a record produces,
// since that also invalidates every position a client is holding.
const PARSER_SCHEMA = "2";
const FINGERPRINT_BYTES = 8192;

export function generationOf(provider, id) {
  const path = resolvePath(provider, id);

  if (!path) { return null; }

  let fd;

  try {
    const stat = statSync(path);
    const length = Math.min(FINGERPRINT_BYTES, stat.size);
    const buf = Buffer.allocUnsafe(length);

    if (length > 0) {
      fd = openSync(path, "r");
      readSync(fd, buf, 0, length, 0);
    }

    const head = createHash("sha1").update(buf).digest("hex").slice(0, 12);
    return `${PARSER_SCHEMA}:${stat.dev}:${stat.ino}:${head}`;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { closeSync(fd); }
  }
}

// Point-in-time answer for a set of threads, for the session list.
export function runningStates(provider, ids) {
  const out = {};

  for (const id of ids ?? []) {
    const path = resolvePath(provider, id);

    if (!path) { continue; }

    try {
      out[id] = runningFromFile(provider, path, statSync(path));
    } catch {
      // the file went away — nothing to report
    }
  }

  return out;
}

// Same point-in-time answer, but preserves whether the result came from an
// explicit provider marker or a time-based guess. Guesses may decorate the UI;
// they must never authorize dispatching a queued follow-up.
export function runningDetails(provider, ids) {
  const out = {};

  for (const id of ids ?? []) {
    const path = resolvePath(provider, id);

    if (!path) { continue; }

    try {
      out[id] = runningDetailFromFile(provider, path, statSync(path));
    } catch {}
  }

  return out;
}

// ---------- the poll loop ----------

// Watch exactly the threads clients currently have open.
export function setInterest(list) {
  const next = new Map();

  for (const { provider, id } of list ?? []) {
    if (id) {
      next.set(key(provider, id), { provider: provider || "codex", id });
    }
  }

  interest = next;

  for (const k of [...seen.keys()]) {
    if (!interest.has(k)) { seen.delete(k); }
  }
}

function poll() {
  for (const [k, { provider, id }] of interest) {
    const path = resolvePath(provider, id);

    if (!path) { continue; }

    let stat;

    try {
      stat = statSync(path);
    } catch {
      continue;
    }

    const prev = seen.get(k);
    const moved = !prev || prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size;
    const detail = runningDetailFromFile(provider, path, stat);
    const { running, confidence, terminalId, terminalOutcome, terminalText, terminalError } = detail;

    // A thread that stops mid-turn (the CLI was killed) never writes its end
    // marker, so re-evaluate quietly once it has been silent for a while.
    if (!moved && prev && prev.running === running && prev.confidence === confidence && prev.terminalId === terminalId) {
      continue;
    }

    seen.set(k, { mtimeMs: stat.mtimeMs, size: stat.size, running, confidence, terminalId });

    // Skip the very first observation: it only tells us the state at open, and
    // the client already fetched the thread itself. Running state still goes
    // out, since that is exactly what the client cannot know on its own.
    onUpdate({ provider, threadId: id, running, runConfidence: confidence, terminalId, terminalOutcome, terminalText, terminalError, changed: !!prev && moved });
  }
}

export function start(handler) {
  onUpdate = handler || (() => {});

  if (!timer) {
    timer = setInterval(poll, POLL_MS);
    timer.unref?.();
  }
}

export function stop() {
  clearInterval(timer);
  timer = null;
}
