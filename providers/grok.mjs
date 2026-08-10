// codex-phone — Grok provider.
//
// Bridges the `grok` CLI to the same normalized event/item model Codex/Claude
// emit, so the existing chat renderer is reused unchanged.
//
//   - listThreads / readThread / projects  read ~/.grok/sessions/**
//   - send   drives a persistent `grok agent stdio` ACP process per open
//            thread, translating session updates into normalized notify events.
//   - models is a static list; usage is best-effort from result lines.
//
// Approvals: headless ACP auto-approves via requestPermission. Manual mode
// never truly gated in headless (matches prior behavior).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Readable, Writable } from "node:stream";

import { ClientSideConnection, ndJsonStream } from "@zed-industries/agent-client-protocol";

import { BaseProvider, toEpochSec } from "./base.mjs";

const SESSIONS_DIR = join(homedir(), ".grok", "sessions");
const HEAD_BYTES = 65536;
const PAGE_SIZE = 25;

// File-mutating Grok tools (history + stream tool_use names).
const FILE_TOOLS = new Set(["search_replace", "write", "Write", "Edit", "MultiEdit", "str_replace"]);

// Shell-style tools that become commandExecution items.
const SHELL_TOOLS = new Set(["run_terminal_command", "Bash", "bash"]);

const MODELS = [
  {
    id: "grok-4.5",
    displayName: "Grok 4.5",
    description: "xAI's frontier model for agentic coding and reasoning.",
    isDefault: true,
  },
];

const EFFORTS = [
  { reasoningEffort: "low", description: "Quick, fast implementations." },
  { reasoningEffort: "medium", description: "Balanced effort with standard implementation and testing." },
  { reasoningEffort: "high", description: "Highest implementation quality with extensive reasoning (default)." },
];

// Our UI mode keys → whether to auto-approve tools. Grok also supports
// --permission-mode (default|acceptEdits|auto|dontAsk|bypassPermissions|plan);
// we use --always-approve for full bypass and --permission-mode for the rest.
function permissionArgsFor(value) {
  switch (value) {
    case "bypass":
    case "full":
    case "danger-full-access":
      return ["--always-approve"];
    case "plan":
    case "chat":
    case "read-only":
      return ["--permission-mode", "plan"];
    case "acceptEdits":
    case "agent":
    case "workspace-write":
      return ["--permission-mode", "acceptEdits"];
    case "manual":
    case "default":
    default:
      // No --always-approve: Grok handles approvals itself. Phone-side
      // interactive interception is not wired for headless grok.
      return [];
  }
}

// Read only the first bytes of a (potentially huge) transcript.
function readHead(path, bytes = HEAD_BYTES) {
  let fd;

  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, read);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

// Flatten a message.content value (string | block[]) into a block array.
function toBlocks(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (Array.isArray(content)) {
    return content;
  }

  return [];
}

// Parse tool arguments that may arrive as a JSON string (history) or object (stream).
function parseToolInput(block) {
  if (block && block.input != null && typeof block.input === "object") {
    return block.input;
  }

  const raw = block?.arguments ?? block?.input;

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  if (raw && typeof raw === "object") {
    return raw;
  }

  return {};
}

// Grok shell tool_result content is often a JSON envelope with output_for_prompt
// and exit_code. Fall back to the raw string / block join.
function toolResultText(content) {
  let text = "";

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.map((b) => (typeof b === "string" ? b : b.text ?? "")).join("");
  } else if (content != null) {
    text = String(content);
  }

  if (!text) {
    return "";
  }

  const trimmed = text.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const o = JSON.parse(trimmed);

      if (o && typeof o === "object" && !Array.isArray(o)) {
        if (typeof o.output_for_prompt === "string") {
          return o.output_for_prompt;
        }

        if (typeof o.output === "string") {
          return o.output;
        }

        if (Array.isArray(o.output)) {
          // byte array form occasionally used for short shell output
          try {
            return Buffer.from(o.output).toString("utf8");
          } catch {
            // fall through
          }
        }
      }
    } catch {
      // not JSON — return as-is
    }
  }

  return text;
}

function toolResultExitCode(content, isError) {
  if (typeof content === "string") {
    const trimmed = content.trim();

    if (trimmed.startsWith("{")) {
      try {
        const o = JSON.parse(trimmed);

        if (o && typeof o.exit_code === "number") {
          return o.exit_code;
        }
      } catch {
        // ignore
      }
    }
  }

  return isError ? 1 : 0;
}

// Pull a displayable user prompt out of Grok's often-wrapped user content.
function extractUserText(text) {
  if (!text) {
    return "";
  }

  const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);

  if (query) {
    return query[1].trim();
  }

  const trimmed = text.trim();

  // Skip injected system/user_info wrappers that are not real prompts.
  if (trimmed.startsWith("<")) {
    return "";
  }

  return trimmed;
}

// Map a Grok tool_use / tool_call block to a normalized item.
function toolUseToItem(block) {
  const name = block.name ?? "";
  const input = parseToolInput(block);
  const id = block.id;

  if (SHELL_TOOLS.has(name)) {
    return { type: "commandExecution", id, command: input.command ?? "", status: "running" };
  }

  if (FILE_TOOLS.has(name)) {
    const path = input.file_path ?? input.path ?? input.notebook_path ?? "";
    let diff = "";

    if (name === "write" || name === "Write") {
      diff = String(input.content ?? "")
        .split("\n")
        .map((l) => "+" + l)
        .join("\n");
    } else if (name === "search_replace" || name === "Edit" || name === "str_replace") {
      const del = String(input.old_string ?? "").split("\n").map((l) => "-" + l).join("\n");
      const add = String(input.new_string ?? "").split("\n").map((l) => "+" + l).join("\n");
      diff = del + "\n" + add;
    } else if (name === "MultiEdit" && Array.isArray(input.edits)) {
      diff = input.edits
        .map((e) => {
          const del = String(e.old_string ?? "").split("\n").map((l) => "-" + l).join("\n");
          const add = String(e.new_string ?? "").split("\n").map((l) => "+" + l).join("\n");
          return del + "\n" + add;
        })
        .join("\n\n");
    }

    return { type: "fileChange", id, changes: [{ path, diff }] };
  }

  if (name === "use_tool") {
    const tool = input.tool_name ?? input.tool ?? name;
    const server = input.server ?? (typeof tool === "string" && tool.includes("__") ? tool.split("__")[0] : "mcp");
    return { type: "mcpToolCall", id, server, tool };
  }

  const server = name.includes("__") ? name.split("__")[0] : "tool";
  return { type: "mcpToolCall", id, server, tool: name };
}

export class GrokProvider extends BaseProvider {
  constructor(emit) {
    super(emit, "grok");

    // Persistent ACP sessions: threadId and (once known) native sessionId
    // both point at the same session object.
    this.sessions = new Map();
    this.summaryCache = new Map(); // sessionDir path -> { mtime, summary }
    this.drafts = new Map(); // draft id -> cwd (recovered on send)
    this.endpoint = null; // { host, port } — stored for future approval hooks
    this.spawnCount = 0; // test observability: process reuse across turns

    // usage enrichment from result lines
    this.sessionCost = 0;
    this.lastUsage = null;
    this.lastModelUsage = null;

    // Idle reaper: drop warm sessions idle > 10 minutes.
    this.reaper = setInterval(() => {
      const now = Date.now();

      for (const s of new Set(this.sessions.values())) {
        if (!s.busy && now - (s.lastUsed || 0) > 10 * 60 * 1000) {
          this.closeSession(s);
        }
      }
    }, 60 * 1000);

    this.reaper.unref?.();
  }

  async init() {}

  setEndpoint({ host, port } = {}) {
    // No PreToolUse-style hook for grok yet; keep the endpoint in case we add one.
    const hookHost = !host || host === "0.0.0.0" ? "127.0.0.1" : host;
    this.endpoint = { host: hookHost, port };
  }

  // ---------- session scanning ----------

  // Each entry: { path: sessionDir, id: sessionUuid, cwd: decodedCwd }
  listSessionDirs() {
    const sessions = [];

    if (!existsSync(SESSIONS_DIR)) {
      return sessions;
    }

    let cwdDirs;

    try {
      cwdDirs = readdirSync(SESSIONS_DIR, { withFileTypes: true });
    } catch {
      return sessions;
    }

    for (const cwdDir of cwdDirs) {
      if (!cwdDir.isDirectory()) {
        continue;
      }

      // Skip non-cwd bookkeeping (e.g. nothing currently, but be defensive).
      let cwd;

      try {
        cwd = decodeURIComponent(cwdDir.name);
      } catch {
        continue;
      }

      // Cwd keys are URL-encoded absolute paths (start with / or drive letter).
      if (!cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd)) {
        continue;
      }

      const cwdPath = join(SESSIONS_DIR, cwdDir.name);
      let entries;

      try {
        entries = readdirSync(cwdPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        // Session ids look like UUIDs (grok uses UUID v7-style ids).
        const id = entry.name;

        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          continue;
        }

        const sessionPath = join(cwdPath, id);
        const historyPath = join(sessionPath, "chat_history.jsonl");
        const summaryPath = join(sessionPath, "summary.json");

        if (!existsSync(historyPath) && !existsSync(summaryPath)) {
          continue;
        }

        sessions.push({ path: sessionPath, id, cwd, historyPath, summaryPath });
      }
    }

    return sessions;
  }

  previewFromHistoryHead(historyPath) {
    if (!historyPath || !existsSync(historyPath)) {
      return "";
    }

    const head = readHead(historyPath);

    for (const line of head.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      let obj;

      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type !== "user") {
        continue;
      }

      if (obj.synthetic_reason) {
        continue;
      }

      const blocks = toBlocks(obj.content ?? obj.message?.content);
      const text = blocks
        .filter((b) => b.type === "text" || typeof b.text === "string")
        .map((b) => b.text ?? "")
        .join(" ");
      const extracted = extractUserText(text);

      if (extracted) {
        return extracted.slice(0, 300);
      }
    }

    return "";
  }

  summaryFor(session) {
    let mtime = 0;

    try {
      const stampPath = existsSync(session.historyPath) ? session.historyPath : session.summaryPath;
      mtime = statSync(stampPath).mtimeMs;
    } catch {
      return null;
    }

    const cached = this.summaryCache.get(session.path);

    if (cached && cached.mtime === mtime) {
      return cached.summary;
    }

    let preview = "";
    let name = null;
    let cwd = session.cwd;

    // Prefer summary.json metadata when present (title + authoritative cwd).
    if (existsSync(session.summaryPath)) {
      try {
        const meta = JSON.parse(readFileSync(session.summaryPath, "utf8"));
        const infoCwd = meta.info?.cwd;

        if (typeof infoCwd === "string" && infoCwd) {
          cwd = infoCwd;
        }

        // Grok names the session itself, and that name is what its own UI
        // shows — so it belongs in the row title rather than being discarded in
        // favour of the opening prompt. It stays a preview fallback too, for
        // sessions whose history head cannot be read.
        const generated = String(meta.generated_title || meta.session_summary || "").replace(/\s+/g, " ").trim();

        if (generated) {
          name = generated.slice(0, 200);
        }

        if (!preview) {
          preview = generated.slice(0, 300);
        }

        if (meta.updated_at) {
          const fromIso = toEpochSec(meta.updated_at);

          if (fromIso != null) {
            // Prefer file mtime for recency sort consistency with claude; keep as mtime.
          }
        }
      } catch {
        // ignore corrupt summary
      }
    }

    // Prefer the first real user prompt when we can cheaply read it.
    const fromHistory = this.previewFromHistoryHead(session.historyPath);

    if (fromHistory) {
      preview = fromHistory;
    }

    if (!preview) {
      // Last resort: first line of cwd-level prompt_history for this session id.
      const phPath = join(SESSIONS_DIR, encodeURIComponent(session.cwd), "prompt_history.jsonl");

      // session.cwd may not match the encoded dir name if summary overrode cwd —
      // also try the parent of session.path.
      const candidates = [
        join(session.path, "..", "prompt_history.jsonl"),
        phPath,
      ];

      for (const p of candidates) {
        if (!existsSync(p)) {
          continue;
        }

        try {
          for (const line of readHead(p, 256000).split("\n")) {
            if (!line.trim()) {
              continue;
            }

            let row;

            try {
              row = JSON.parse(line);
            } catch {
              continue;
            }

            if (row.session_id === session.id && typeof row.prompt === "string" && row.prompt.trim() && !row.is_bash) {
              preview = row.prompt.trim().slice(0, 300);
              break;
            }
          }
        } catch {
          // ignore
        }

        if (preview) {
          break;
        }
      }
    }

    const summary = {
      id: session.id,
      preview: preview || "(no prompt)",
      name,
      cwd,
      gitInfo: null,
      updatedAt: Math.floor(mtime / 1000),
      provider: "grok",
    };

    this.summaryCache.set(session.path, { mtime, summary });
    return summary;
  }

  buildSummaries() {
    const summaries = [];

    for (const session of this.listSessionDirs()) {
      const s = this.summaryFor(session);

      if (s) {
        summaries.push(s);
      }
    }

    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  async listThreads({ search, cursor } = {}) {
    let all = this.buildSummaries();

    if (search) {
      const q = search.toLowerCase();
      all = all.filter((s) => (s.preview ?? "").toLowerCase().includes(q) || (s.cwd ?? "").toLowerCase().includes(q));
    }

    const offset = Number(cursor) || 0;
    const page = all.slice(offset, offset + PAGE_SIZE);
    const next = offset + PAGE_SIZE;
    const nextCursor = next < all.length ? String(next) : null;
    return { data: page, nextCursor };
  }

  findSession(id) {
    for (const session of this.listSessionDirs()) {
      if (session.id === id) {
        return session;
      }
    }

    return null;
  }

  async readThread(id) {
    const session = this.findSession(id);

    if (!session) {
      throw Object.assign(new Error("thread not found"), { status: 404 });
    }

    const path = session.historyPath;

    if (!path || !existsSync(path)) {
      return { thread: { turns: [] } };
    }

    let raw = "";

    try {
      raw = readFileSync(path, "utf8");
    } catch {
      raw = "";
    }

    const turns = [];
    const toolById = new Map(); // tool call id -> commandExecution item
    let current = null;

    function ensureTurn() {
      if (!current) {
        current = { items: [] };
        turns.push(current);
      }

      return current;
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      let obj;

      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const type = obj.type;

      if (type === "system") {
        continue;
      }

      if (type === "user") {
        if (obj.synthetic_reason) {
          continue;
        }

        const blocks = toBlocks(obj.content);
        const textBlocks = blocks.filter((b) => (b.type === "text" || b.text != null) && (b.text ?? "").trim());
        const joined = textBlocks.map((b) => b.text ?? "").join("\n");
        const extracted = extractUserText(joined);

        // Also accept plain prompts that are not XML-wrapped (headless sessions).
        const display = extracted || (joined.trim().startsWith("<") ? "" : joined.trim());

        if (display) {
          current = { items: [] };
          turns.push(current);
          current.items.push({ type: "userMessage", content: [{ type: "text", text: display }] });
        }

        continue;
      }

      if (type === "reasoning") {
        const turn = ensureTurn();
        const parts = [];

        if (Array.isArray(obj.summary)) {
          for (const s of obj.summary) {
            if (typeof s === "string" && s.trim()) {
              parts.push(s);
            } else if (s && typeof s.text === "string" && s.text.trim()) {
              parts.push(s.text);
            }
          }
        }

        if (parts.length) {
          turn.items.push({ type: "reasoning", id: obj.id, summary: parts });
        }

        continue;
      }

      if (type === "assistant") {
        const turn = ensureTurn();
        const content = obj.content;

        if (typeof content === "string" && content.trim()) {
          turn.items.push({ type: "agentMessage", id: obj.id, text: content });
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && (block.text ?? "").trim()) {
              turn.items.push({ type: "agentMessage", id: obj.id, text: block.text });
            } else if (block.type === "thinking" && (block.thinking ?? "").trim()) {
              turn.items.push({ type: "reasoning", id: obj.id, summary: [block.thinking] });
            } else if (block.type === "tool_use") {
              const item = toolUseToItem(block);
              turn.items.push(item);

              if (item.type === "commandExecution") {
                toolById.set(block.id, item);
              }
            }
          }
        }

        // Grok history stores tool calls beside string content (not always as content blocks).
        if (Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls) {
            const item = toolUseToItem(tc);
            turn.items.push(item);

            if (item.type === "commandExecution") {
              toolById.set(tc.id, item);
            }
          }
        }

        continue;
      }

      if (type === "tool_result") {
        const item = toolById.get(obj.tool_call_id);

        if (item && item.type === "commandExecution") {
          item.aggregatedOutput = toolResultText(obj.content);
          item.exitCode = toolResultExitCode(obj.content, !!obj.is_error);
          item.status = "completed";
        }

        continue;
      }
    }

    // Deliberately no prewarm — same reason as Claude and Codex. Loading a
    // session attaches a second controller to a thread that may be live in a
    // terminal, and viewing a transcript should never touch the session it is
    // showing. The first send pays the spawn instead.
    return { thread: { turns } };
  }

  async projects() {
    const byCwd = new Map();

    for (const s of this.buildSummaries()) {
      if (!s.cwd) {
        continue;
      }

      const cur = byCwd.get(s.cwd) ?? { path: s.cwd, name: basename(s.cwd), count: 0, lastUsed: 0, branch: null };
      cur.count += 1;
      cur.lastUsed = Math.max(cur.lastUsed, s.updatedAt ?? 0);
      byCwd.set(s.cwd, cur);
    }

    const projects = [...byCwd.values()].sort((a, b) => b.lastUsed - a.lastUsed);
    return { projects };
  }

  async models() {
    const data = MODELS.map((m) => ({
      ...m,
      supportedReasoningEfforts: EFFORTS,
      defaultReasoningEffort: "high",
      hidden: false,
    }));
    return { data };
  }

  async usage() {
    let usage = null;

    if (this.lastUsage) {
      const u = this.lastUsage;
      const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      const models = this.lastModelUsage
        ? Object.entries(this.lastModelUsage).map(([id, m]) => ({
            model: id,
            tokens: (m.inputTokens ?? 0) + (m.outputTokens ?? 0),
            costUSD: m.costUSD ?? null,
          }))
        : [];
      usage = {
        sessionCostUSD: Math.round(this.sessionCost * 10000) / 10000,
        lastInputTokens: input,
        lastOutputTokens: u.output_tokens ?? 0,
        models,
      };
    } else if (this.sessionCost > 0) {
      usage = { sessionCostUSD: Math.round(this.sessionCost * 10000) / 10000, models: [] };
    }

    return {
      account: { planType: "grok" },
      rateLimits: null,
      usage,
    };
  }

  async newThread({ cwd } = {}) {
    if (!cwd) {
      throw Object.assign(new Error("cwd required"), { status: 400 });
    }

    const id = "draft-" + randomBytes(6).toString("hex");
    this.drafts.set(id, cwd);
    return { thread: { id, cwd, name: null, preview: "New session", provider: "grok", draft: true } };
  }

  // Recover the working directory for a turn: explicit cwd wins, then the
  // draft record, then the session's own summary/transcript, then $HOME.
  cwdForSession(threadId, explicit) {
    if (explicit) {
      return explicit;
    }

    if (threadId && this.drafts.has(threadId)) {
      return this.drafts.get(threadId);
    }

    const session = threadId ? this.findSession(threadId) : null;

    if (session) {
      if (session.cwd) {
        return session.cwd;
      }

      if (existsSync(session.summaryPath)) {
        try {
          const meta = JSON.parse(readFileSync(session.summaryPath, "utf8"));

          if (meta.info?.cwd) {
            return meta.info.cwd;
          }
        } catch {
          // ignore
        }
      }
    }

    return homedir() || process.cwd();
  }

  // ---------- live turn (persistent ACP session pool) ----------

  // Normalize model/effort for pool key matching (undefined == no override).
  modelEffortMatch(session, model, effort) {
    const m = model || undefined;
    const e = effort || undefined;
    return session.model === m && session.effort === e;
  }

  async ensureSession(emitThreadId, { cwd, model, effort, isDraft }) {
    const existing = this.sessions.get(emitThreadId);

    if (existing && !existing.dead && this.modelEffortMatch(existing, model, effort)) {
      existing.lastUsed = Date.now();
      return existing;
    }

    if (existing) {
      await this.closeSession(existing);
    }

    const resolvedModel = model || undefined;
    const resolvedEffort = effort || undefined;
    const args = ["agent"];

    if (resolvedModel) {
      args.push("--model", resolvedModel);
    }

    if (resolvedEffort) {
      args.push("--reasoning-effort", resolvedEffort);
    }

    args.push("stdio");

    let child;

    try {
      child = spawn("grok", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      throw Object.assign(new Error("failed to spawn grok: " + (e.message ?? e)), { status: 500 });
    }

    this.spawnCount += 1;

    const session = {
      child,
      conn: null,
      sessionId: null,
      cwd,
      model: resolvedModel,
      effort: resolvedEffort,
      ready: null,
      loadingHistory: false,
      busy: false,
      turn: null,
      turnDone: null, // Promise that resolves when the in-flight turn finishes
      lastUsed: Date.now(),
      emitThreadId,
      dead: false,
      mode: null,
    };

    // Store under emitThreadId before awaiting so concurrent callers share ready.
    this.sessions.set(emitThreadId, session);

    child.stderr.on("data", (d) => {
      process.stderr.write(`[grok] ${d}`);
    });

    const onDead = (msg) => {
      if (session.dead) {
        return;
      }

      session.dead = true;
      this.sessions.delete(emitThreadId);

      if (session.sessionId) {
        this.sessions.delete(session.sessionId);
      }

      if (session.busy) {
        this.notify("turn/failed", {
          threadId: session.emitThreadId,
          turn: { status: "failed", error: { message: msg } },
        });
        session.busy = false;
        session.turn = null;

        if (session._resolveTurnDone) {
          session._resolveTurnDone();
          session._resolveTurnDone = null;
        }
      }
    };

    child.on("error", (e) => {
      const msg = e.code === "ENOENT"
        ? "The `grok` CLI was not found on PATH. Install Grok and restart codex-phone."
        : String(e.message ?? e);
      onDead(msg);
    });

    child.on("exit", (code) => {
      onDead(code ? `grok exited with code ${code}` : "grok exited");
    });

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout);
    const stream = ndJsonStream(input, output);
    const conn = new ClientSideConnection(() => this.makeClientHandlers(session), stream);
    session.conn = conn;

    session.ready = (async () => {
      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
      });

      if (isDraft) {
        const r = await conn.newSession({ cwd, mcpServers: [] });
        session.sessionId = r.sessionId;
        this.sessions.set(r.sessionId, session);
        this.drafts.delete(emitThreadId);
        this.notify("thread/adopted", { threadId: emitThreadId, sessionId: r.sessionId });
      } else {
        session.loadingHistory = true;

        try {
          await conn.loadSession({ sessionId: emitThreadId, cwd, mcpServers: [] });
          session.sessionId = emitThreadId;
          this.sessions.set(emitThreadId, session);
        } finally {
          session.loadingHistory = false;
        }
      }

      session.lastUsed = Date.now();
    })();

    // Surface ready failures as dead sessions.
    session.ready.catch((err) => {
      onDead(String(err?.message ?? err));
    });

    return session;
  }

  closeSession(session) {
    if (!session) {
      return;
    }

    session.dead = true;
    this.sessions.delete(session.emitThreadId);

    if (session.sessionId) {
      this.sessions.delete(session.sessionId);
    }

    try {
      session.child?.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  newTurnState(turnId, threadId) {
    return {
      turnId,
      threadId,
      lastKind: null,
      blockSeq: 0,
      textItemId: null,
      thoughtItemId: null,
      textAccum: "",
      thoughtAccum: "",
      toolKinds: new Map(),
      toolCommands: new Map(),
      toolOutLen: new Map(),
      sawEnd: false,
    };
  }

  makeClientHandlers(session) {
    return {
      sessionUpdate: async ({ update }) => this.onSessionUpdate(session, update),
      requestPermission: async (p) => this.onRequestPermission(session, p),
      readTextFile: async ({ path }) => ({ content: readFileSync(path, "utf8") }),
      writeTextFile: async ({ path, content }) => {
        writeFileSync(path, content);
        return {};
      },
    };
  }

  onRequestPermission(_session, p) {
    const opts = p.options || [];
    const pick = opts.find((o) =>
      /allow|approve|yes|once|always/i.test((o.optionId || "") + (o.name || "") + (o.kind || ""))
    ) || opts[0];
    return { outcome: { outcome: "selected", optionId: pick?.optionId } };
  }

  onSessionUpdate(session, update) {
    if (!session.turn || session.loadingHistory) {
      return;
    }

    const t = session.turn;
    const tid = t.threadId;
    const kind = update.sessionUpdate;

    switch (kind) {
      case "user_message_chunk":
        return;

      case "agent_message_chunk": {
        const text = update.content?.text ?? "";

        if (!text) {
          return;
        }

        if (t.lastKind !== "text") {
          this.finalizeBlock(session);
          t.blockSeq++;
          t.textItemId = t.turnId + ":t" + t.blockSeq;
          t.textAccum = "";
          t.lastKind = "text";
        }

        t.textAccum += text;
        this.notify("item/agentMessage/delta", { threadId: tid, itemId: t.textItemId, delta: text });
        return;
      }

      case "agent_thought_chunk": {
        const text = update.content?.text ?? "";

        if (!text) {
          return;
        }

        if (t.lastKind !== "thought") {
          this.finalizeBlock(session);
          t.blockSeq++;
          t.thoughtItemId = t.turnId + ":r" + t.blockSeq;
          t.thoughtAccum = "";
          t.lastKind = "thought";
        }

        t.thoughtAccum += text;
        this.notify("item/reasoning/summaryTextDelta", { threadId: tid, itemId: t.thoughtItemId, delta: text });
        return;
      }

      case "tool_call": {
        this.finalizeBlock(session);
        t.lastKind = null;
        const id = update.toolCallId;
        const toolKind = update._meta?.["x.ai/tool"]?.kind ?? update.kind;

        if (toolKind === "execute") {
          const command = update.rawInput?.command ?? update.title ?? "";
          t.toolKinds.set(id, "cmd");
          t.toolCommands.set(id, command);
          t.toolOutLen.set(id, 0);
          this.notify("item/started", {
            threadId: tid,
            item: { type: "commandExecution", id, command, status: "running" },
          });
        } else if (toolKind === "edit") {
          const input = update.rawInput ?? {};
          const path = input.file_path ?? input.path ?? update.locations?.[0]?.path ?? "";
          let diff = "";

          if (input.content != null && input.old_string == null) {
            // full write
            diff = String(input.content)
              .split("\n")
              .map((l) => "+" + l)
              .join("\n");
          } else if (input.old_string != null || input.new_string != null) {
            const del = String(input.old_string ?? "").split("\n").map((l) => "-" + l).join("\n");
            const add = String(input.new_string ?? "").split("\n").map((l) => "+" + l).join("\n");
            diff = del + "\n" + add;
          }

          t.toolKinds.set(id, "file");
          this.notify("item/completed", {
            threadId: tid,
            item: { type: "fileChange", id, changes: [{ path, diff }] },
          });
        } else {
          const tool = update.title ?? update._meta?.["x.ai/tool"]?.name ?? "tool";
          const server = String(tool).includes("__") ? String(tool).split("__")[0] : "tool";
          t.toolKinds.set(id, "mcp");
          this.notify("item/started", {
            threadId: tid,
            item: { type: "mcpToolCall", id, server, tool },
          });
        }

        return;
      }

      case "tool_call_update": {
        const id = update.toolCallId;
        const toolKind = t.toolKinds.get(id);
        const status = update.status;
        const out = (update.content || []).map((c) => c?.content?.text ?? "").join("");

        if (toolKind === "cmd") {
          const prev = t.toolOutLen.get(id) ?? 0;

          if (out.length > prev) {
            this.notify("item/commandExecution/outputDelta", {
              threadId: tid,
              itemId: id,
              delta: out.slice(prev),
            });
            t.toolOutLen.set(id, out.length);
          }

          if (status === "completed" || status === "failed") {
            this.notify("item/completed", {
              threadId: tid,
              item: {
                type: "commandExecution",
                id,
                command: t.toolCommands.get(id) ?? "",
                aggregatedOutput: out,
                exitCode: update.rawOutput?.exit_code ?? (status === "failed" ? 1 : 0),
                status: "completed",
              },
            });
          }
        } else if (toolKind === "mcp" && (status === "completed" || status === "failed")) {
          this.notify("item/completed", {
            threadId: tid,
            item: { type: "mcpToolCall", id, server: "tool", tool: id, status: "completed" },
          });
        }

        // file kind already completed at tool_call — ignore updates.
        return;
      }

      default:
        // plan, available_commands_update, current_mode_update, etc.
        return;
    }
  }

  finalizeBlock(session) {
    const t = session.turn;

    if (!t) {
      return;
    }

    if (t.lastKind === "text" && t.textItemId && (t.textAccum || "").trim()) {
      this.notify("item/completed", {
        threadId: t.threadId,
        item: { type: "agentMessage", id: t.textItemId, text: t.textAccum },
      });
      t.textItemId = null;
      t.textAccum = "";
    }

    if (t.lastKind === "thought" && t.thoughtItemId && (t.thoughtAccum || "").trim()) {
      this.notify("item/completed", {
        threadId: t.threadId,
        item: { type: "reasoning", id: t.thoughtItemId, summary: [t.thoughtAccum] },
      });
      t.thoughtItemId = null;
      t.thoughtAccum = "";
    }
  }

  finishTurn(session, res) {
    this.finalizeBlock(session);
    const cancelled = res?.stopReason === "cancelled";
    const failed = res?.stopReason === "refusal";
    const tid = session.emitThreadId;
    const turnId = session.turn?.turnId;

    if (cancelled) {
      this.notify("turn/failed", {
        threadId: tid,
        turn: { status: "failed", error: { message: "Turn cancelled" } },
      });
    } else if (failed) {
      this.notify("turn/failed", {
        threadId: tid,
        turn: { status: "failed", error: { message: "refusal" } },
      });
    } else {
      this.notify("turn/completed", {
        threadId: tid,
        turn: { id: turnId, status: "completed" },
      });
    }

    session.busy = false;
    session.turn = null;
    session.lastUsed = Date.now();

    if (session._resolveTurnDone) {
      session._resolveTurnDone();
      session._resolveTurnDone = null;
    }
  }

  failTurn(session, err) {
    this.finalizeBlock(session);
    this.notify("turn/failed", {
      threadId: session.emitThreadId,
      turn: { status: "failed", error: { message: String(err?.message ?? err) } },
    });
    session.busy = false;
    session.turn = null;
    session.lastUsed = Date.now();

    if (session._resolveTurnDone) {
      session._resolveTurnDone();
      session._resolveTurnDone = null;
    }
  }

  async send(body = {}) {
    const { threadId, text, model, effort, mode, sandbox, cwd, draft } = body;

    if (!text) {
      throw Object.assign(new Error("text required"), { status: 400 });
    }

    const isDraft = !!draft || !threadId || String(threadId).startsWith("draft-") || threadId === "new";
    const emitThreadId = threadId || ("draft-" + randomBytes(6).toString("hex"));
    const resolvedCwd = this.cwdForSession(threadId, cwd);
    const modeKey = mode ?? sandbox;

    const session = await this.ensureSession(emitThreadId, {
      cwd: resolvedCwd,
      model,
      effort,
      isDraft,
    });

    session.mode = modeKey;
    await session.ready;

    // Serialize turns on the same warm session (frontend usually enqueues; this
    // is the safe path if two sends race). Wait for the previous turn to finish.
    if (session.busy && session.turnDone) {
      await session.turnDone;
    }

    if (session.busy) {
      throw Object.assign(new Error("a turn is already running"), { status: 409 });
    }

    if (session.dead) {
      throw Object.assign(new Error("session is dead"), { status: 500 });
    }

    const turnId = "turn-" + randomBytes(6).toString("hex");
    session.busy = true;
    session.turn = this.newTurnState(turnId, session.emitThreadId);
    session.turnDone = new Promise((resolve) => {
      session._resolveTurnDone = resolve;
    });

    this.notify("turn/started", { threadId: session.emitThreadId, turn: { id: turnId } });

    const sid = session.sessionId;
    session.conn
      .prompt({ sessionId: sid, prompt: [{ type: "text", text }] })
      .then((res) => this.finishTurn(session, res))
      .catch((err) => this.failTurn(session, err));

    return { ok: true, threadId: emitThreadId };
  }

  async steer() {
    // ACP has prompt and cancel, but no primitive that injects into a live turn.
    throw Object.assign(new Error("Grok does not support native steering"), { status: 409, code: "steer_unsupported" });
  }

  async interrupt({ threadId } = {}) {
    const session = this.sessions.get(threadId);

    if (session && session.busy && session.sessionId && session.conn) {
      session.conn.cancel({ sessionId: session.sessionId }).catch(() => {});
    }

    return { ok: true };
  }
}

export default GrokProvider;
