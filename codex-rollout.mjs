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

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function summarize(file) {
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

  return {
    id: meta.id ?? meta.session_id,
    provider: "codex",
    cwd: meta.cwd ?? "",
    name: preview,
    preview,
    updatedAt: Math.floor(file.mtimeMs / 1000),
    gitInfo: meta.git?.branch ? { branch: meta.git.branch } : null,
  };
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
export function itemsFromLines(lines) {
  const turns = [];
  const pending = new Map(); // call_id -> item
  let current = null;
  let n = 0;

  const id = () => `item-${++n}`;

  const turn = () => {
    if (!current) {
      current = { items: [] };
      turns.push(current);
    }

    return current;
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
          current = { items: [] };
          turns.push(current);
          break;

        case "user_message":
          if (String(p.message ?? "").trim()) {
            push({ id: id(), type: "userMessage", content: [{ type: "text", text: String(p.message) }] });
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

export function readRollout(path) {
  let raw = "";

  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { thread: { turns: [] } };
  }

  return { thread: { turns: itemsFromLines(raw.split("\n").filter(Boolean)) } };
}

export function findRollout(id) {
  for (const file of listRolloutFiles()) {
    if (file.path.includes(id)) {
      return file.path;
    }
  }

  return null;
}

export function rolloutExists(id) {
  const p = findRollout(id);
  return p && existsSync(p) ? p : null;
}
