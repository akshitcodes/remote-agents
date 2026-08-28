// Read Codex threads from their own rollout logs, instead of asking
// codex app-server for them.
//
// Every other provider reads its session files directly; Codex was the only one
// that went out to a separate process, and that process needs things reading a
// transcript does not: an auth token, a model cache, and every MCP server in
// ~/.codex/config.toml. When one of those stalls — an MCP server stuck retrying
// an OAuth refresh, say — app-server stops answering and the phone cannot even
// list sessions, let alone follow a running one. The rollout file has no such
// dependencies: it is append-only, already on disk, and written by whichever
// Codex is actually doing the work (CLI, Desktop, or the IDE extension).
//
// app-server stays in the *write* path, where it is genuinely required.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { titleFor } from "./codex-titles.mjs";
import { storedAttachmentForPath } from "./attachments.mjs";

const SESSIONS = join(homedir(), ".codex", "sessions");

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Rollouts live under sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<id>.jsonl.
export function listRolloutFiles() {
  const out = [];
  const stack = [SESSIONS];

  while (stack.length) {
    let entries = [];

    const dir = stack.pop();

    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          out.push({ path: full, mtimeMs: statSync(full).mtimeMs });
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  }

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Enough of the head to find session_meta and the first user message, without
// reading a multi-megabyte log just to render one row.
const HEAD_BYTES = 256 * 1024;
const summaryCache = new Map(); // path -> immutable metadata from the rollout head

export function summarize(file) {
  const cached = summaryCache.get(file.path);

  if (cached && (cached.preview || cached.observedMtimeMs === file.mtimeMs)) {
    const { observedMtimeMs: _observedMtimeMs, ...stable } = cached;
    return {
      ...stable,
      name: titleFor(cached.id) || cached.preview,
      updatedAt: Math.floor(file.mtimeMs / 1000),
    };
  }

  let head = "";
  let fd;

  // Read only the head — these logs run to megabytes and a row needs the first
  // couple of records.
  try {
    const length = Math.min(HEAD_BYTES, statSync(file.path).size);
    const buf = Buffer.allocUnsafe(length);
    fd = openSync(file.path, "r");
    readSync(fd, buf, 0, length, 0);
    head = buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { closeSync(fd); }
  }

  let meta = null;
  let preview = "";

  for (const line of head.split("\n")) {
    const rec = parse(line);

    if (!rec) { continue; }

    if (rec.type === "session_meta" && !meta) { meta = rec.payload ?? {}; }

    if (!preview && rec.type === "event_msg" && rec.payload?.type === "user_message") {
      preview = String(rec.payload.message ?? "").trim().slice(0, 200);
    }

    if (meta && preview) { break; }
  }

  if (!meta?.id && !meta?.session_id) { return null; }

  const id = meta.id ?? meta.session_id;
  const spawn = meta.source?.subagent?.thread_spawn ?? {};
  const parentThreadId = meta.parent_thread_id ?? spawn.parent_thread_id ?? null;
  const threadSource = meta.thread_source ?? (parentThreadId ? "subagent" : "user");

  const summary = {
    id,
    provider: "codex",
    cwd: meta.cwd ?? "",
    // Codex's own name for the thread when it has one; the opening message is
    // only a stand-in until it does.
    name: titleFor(id) || preview,
    preview,
    updatedAt: Math.floor(file.mtimeMs / 1000),
    gitInfo: meta.git?.branch ? { branch: meta.git.branch } : null,
    threadSource,
    parentThreadId,
    subagentDepth: Number.isFinite(Number(spawn.depth)) ? Number(spawn.depth) : null,
    agentNickname: meta.agent_nickname ?? spawn.agent_nickname ?? null,
    agentPath: meta.agent_path ?? spawn.agent_path ?? null,
  };

  const { name: _name, updatedAt: _updatedAt, ...stable } = summary;
  summaryCache.set(file.path, { ...stable, observedMtimeMs: file.mtimeMs });

  if (summaryCache.size > 2000) {
    summaryCache.delete(summaryCache.keys().next().value);
  }

  return summary;
}

// ---------- records -> the items the UI renders ----------

function textOf(output) {
  if (typeof output === "string") { return output; }

  if (Array.isArray(output)) {
    return output.map((c) => c?.text ?? "").filter(Boolean).join("\n");
  }

  return "";
}

// A tool call and its output are separate records, often far apart, so calls are
// kept by call_id until their output shows up.
function commandLabel(payload) {
  if (payload.type === "custom_tool_call") {
    return String(payload.input ?? payload.name ?? "command");
  }

  const args = payload.arguments;

  if (typeof args === "string" && args.trim().startsWith("{")) {
    return `${payload.name} ${args}`;
  }

  return String(payload.name ?? "command");
}

// Builds the same shapes renderItem() consumes, straight from the log.
export function newParseState() {
  return {
    turns: [],
    pending: new Map(), // call_id -> the commandExecution awaiting its output
    current: null,
    n: 0,
  };
}

// Feeds more log lines into an existing parse, so a growing thread is only ever
// parsed once.
export function feedLines(st, lines) {
  const turns = st.turns;
  const pending = st.pending;

  const id = () => `item-${++st.n}`;

  const turn = () => {
    if (!st.current) {
      st.current = { items: [] };
      turns.push(st.current);
    }

    return st.current;
  };

  const push = (item) => {
    turn().items.push(item);
    return item;
  };

  for (const line of lines) {
    const rec = parse(line);

    if (!rec) { continue; }

    const p = rec.payload ?? {};

    if (rec.type === "event_msg") {
      switch (p.type) {
        case "task_started":
          st.current = { items: [] };
          turns.push(st.current);
          break;

        case "task_complete":
          if (p.error) {
            const message = typeof p.error === "string" ? p.error : String(p.error.message ?? p.error.error ?? "Turn failed");
            push({
              id: `turn-error:${p.turn_id ?? ++st.n}`,
              type: "turnError",
              terminalId: p.turn_id ? `codex:${p.turn_id}` : null,
              code: typeof p.error === "object" ? (p.error.codex_error_info ?? p.error.code ?? null) : null,
              message,
            });
          }

          break;

        case "user_message":
          {
            const content = [];

            if (String(p.message ?? "").trim()) { content.push({ type: "text", text: String(p.message) }); }
            for (const _ of p.images ?? []) { content.push({ type: "image" }); }
            for (const path of p.local_images ?? []) {
              const match = storedAttachmentForPath(path);
              content.push({ type: "localImage", ...(match ? { attachment: match } : {}) });
            }

            if (content.length) { push({ id: id(), type: "userMessage", content }); }
          }

          break;

        case "agent_message":
          if (String(p.message ?? "").trim()) {
            push({ id: id(), type: "agentMessage", text: String(p.message) });
          }

          break;

        case "agent_reasoning":
          if (String(p.text ?? "").trim()) {
            push({ id: id(), type: "reasoning", content: String(p.text) });
          }

          break;

        case "mcp_tool_call_end":
          push({
            id: id(),
            type: "mcpToolCall",
            server: p.invocation?.server ?? "mcp",
            tool: p.invocation?.tool ?? "tool",
          });
          break;

        case "patch_apply_end": {
          const changes = Object.entries(p.changes ?? {}).map(([path, c]) => ({
            path,
            diff: c?.unified_diff ?? "",
          }));

          if (changes.length) {
            push({ id: id(), type: "fileChange", changes });
          }

          break;
        }

        default:
          break;
      }

      continue;
    }

    if (rec.type !== "response_item") { continue; }

    if (p.type === "custom_tool_call" || p.type === "function_call") {
      const item = push({ id: id(), type: "commandExecution", command: commandLabel(p), status: "running" });

      if (p.call_id) { pending.set(p.call_id, item); }

      continue;
    }

    if (p.type === "custom_tool_call_output" || p.type === "function_call_output") {
      const item = pending.get(p.call_id);

      if (item) {
        item.aggregatedOutput = textOf(p.output);
        item.status = "completed";
        pending.delete(p.call_id);
      }
    }
  }

  return turns;
}

export function itemsFromLines(lines) {
  const st = newParseState();
  feedLines(st, lines);
  return st.turns;
}

// Parsing a 27MB rollout takes seconds, and a thread being followed is re-read
// every few seconds. These logs only ever grow, so keep the parse and feed it
// the appended bytes instead of starting over.
const parsed = new Map(); // path -> { offset, state, at }
const MAX_PARSED = 4;

// Read in slices: these logs reach a gigabyte, and one Buffer.toString() over
// that throws outright (V8 caps strings near 512MB). Chunking also keeps peak
// memory at one slice instead of the whole file.
const CHUNK_BYTES = 16 * 1024 * 1024;

function readFrom(path, start, end) {
  const length = end - start;

  if (length <= 0) { return ""; }

  const buf = Buffer.allocUnsafe(length);
  let fd;

  try {
    fd = openSync(path, "r");
    readSync(fd, buf, 0, length, start);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) { closeSync(fd); }
  }

  return buf.toString("utf8");
}

export function readRollout(path) {
  let size = 0;

  try {
    size = statSync(path).size;
  } catch {
    return { thread: { turns: [] } };
  }

  let entry = parsed.get(path);

  // Shrunk or rewritten (rotation, truncation) — the cached parse is worthless.
  if (entry && entry.offset > size) { entry = null; }

  if (!entry) {
    entry = { offset: 0, state: newParseState() };
    parsed.set(path, entry);
  }

  while (entry.offset < size) {
    const end = Math.min(entry.offset + CHUNK_BYTES, size);
    const chunk = readFrom(path, entry.offset, end);

    if (!chunk) { break; }

    // A trailing partial line waits for the rest of itself to be written.
    const cut = chunk.lastIndexOf("\n");

    if (cut < 0) {
      // A whole chunk with no line break is one colossal record; step past it
      // rather than stalling here re-reading the same bytes forever.
      if (end >= size) { break; }

      entry.offset = end;
      continue;
    }

    feedLines(entry.state, chunk.slice(0, cut).split("\n").filter(Boolean));
    entry.offset += Buffer.byteLength(chunk.slice(0, cut + 1), "utf8");
  }

  entry.at = Date.now();

  if (parsed.size > MAX_PARSED) {
    const oldest = [...parsed.entries()].sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0))[0];

    if (oldest) { parsed.delete(oldest[0]); }
  }

  return { thread: { turns: entry.state.turns } };
}

export function findRollout(id) {
  for (const file of listRolloutFiles()) {
    if (file.path.includes(id)) {
      return file.path;
    }
  }

  return null;
}

// Resume cost is mostly proportional to the rollout app-server must replay.
// Keep this as metadata only: callers need an honest progress label, not the
// file contents a second time.
export function rolloutSize(id) {
  const path = findRollout(id);

  if (!path) { return null; }

  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export function rolloutExists(id) {
  const p = findRollout(id);
  return p && existsSync(p) ? p : null;
}
