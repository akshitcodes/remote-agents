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

// How long after its last write a thread with no explicit end-of-turn marker is
// still assumed to be working. Only used for providers that don't log one.
const ASSUME_ACTIVE_MS = 25000;

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

    const verdict = decide(record);

    if (verdict !== undefined) {
      return verdict;
    }
  }

  return null;
}

// Codex logs an explicit task_started / task_complete pair per turn.
function codexRunning(lines) {
  return parseFromEnd(lines, (r) => {
    const type = r?.payload?.type;

    if (type === "task_started") { return true; }
    if (type === "task_complete") { return false; }

    return undefined;
  });
}

// Claude ends a turn with an assistant message whose stop_reason is end_turn.
// Everything between that and the user's prompt is tool_use / tool_result
// traffic, which we skip over.
function claudeRunning(lines) {
  return parseFromEnd(lines, (r) => {
    if (r?.type === "assistant") {
      const reason = r?.message?.stop_reason;

      if (reason && reason !== "tool_use") { return false; }

      return undefined;
    }

    if (r?.type === "user" && !r.toolUseResult) {
      const content = r?.message?.content;
      const isToolResult = Array.isArray(content) && content.some((c) => c?.type === "tool_result");

      if (!isToolResult) { return true; }
    }

    return undefined;
  });
}

// Returns true/false, or null when this provider leaves no usable marker and the
// caller should fall back to "was it written to recently".
function runningFromFile(provider, path, stat) {
  const cacheKey = `${path}:${stat.mtimeMs}:${stat.size}`;
  let marker;

  // Only the marker is cached: it depends purely on the file's bytes. Staleness
  // depends on the clock, so it has to be re-applied every time or a stalled
  // thread would stay "running" forever behind an unchanging cache key.
  if (runCache.has(cacheKey)) {
    marker = runCache.get(cacheKey);
  } else {
    marker = null;

    if (provider === "codex" || provider === "claude") {
      const lines = tailLines(path, stat.size);
      marker = provider === "codex" ? codexRunning(lines) : claudeRunning(lines);
    }

    runCache.set(cacheKey, marker);

    if (runCache.size > 200) {
      runCache.clear();
    }
  }

  const silentFor = Date.now() - stat.mtimeMs;

  if (marker === null) {
    return silentFor < ASSUME_ACTIVE_MS;
  }

  return marker && silentFor <= STALE_AFTER_MS;
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
const PARSER_SCHEMA = "1";
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
    const running = runningFromFile(provider, path, stat);

    // A thread that stops mid-turn (the CLI was killed) never writes its end
    // marker, so re-evaluate quietly once it has been silent for a while.
    if (!moved && prev && prev.running === running) {
      continue;
    }

    seen.set(k, { mtimeMs: stat.mtimeMs, size: stat.size, running });

    // Skip the very first observation: it only tells us the state at open, and
    // the client already fetched the thread itself. Running state still goes
    // out, since that is exactly what the client cannot know on its own.
    onUpdate({ provider, threadId: id, running, changed: !!prev && moved });
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
