// codex-phone — Claude provider.
//
// Bridges the `claude` CLI to the same normalized event/item model Codex emits,
// so the existing chat renderer is reused unchanged.
//
//   - listThreads / readThread / projects  read ~/.claude/projects/**/*.jsonl
//   - send   drives a persistent `claude -p --input-format stream-json` process
//            per open thread, writing each user turn to stdin and translating
//            the stream-json envelope into normalized notify events.
//   - models is a static list; usage is partial (5h window, usedPercent null).
//
// Interactive approvals: in "agent" mode the bridge attaches a PreToolUse hook
// (via --settings). The hook auto-allows safe tools and, for sensitive ones
// (Bash + file edits), calls back to the bridge and blocks until the phone
// answers — surfacing the same approval banner Codex uses.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { BaseProvider, toEpochSec, makeLineReader } from "./base.mjs";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const HEAD_BYTES = 65536; // enough to reach the first user line + cwd
const PAGE_SIZE = 25;

// Bookkeeping line types in the transcript that are not conversation content.
const CONTENT_TYPES = new Set(["user", "assistant"]);

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Tools that require the user's approval in "agent" mode. Everything else
// (Read, Grep, Glob, WebFetch, …) is auto-allowed by the hook without a prompt.
const SENSITIVE_TOOLS = new Set(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch"]);
const APPROVAL_TIMEOUT_MS = 240000;

// The PreToolUse hook script, written to a temp file at startup. It receives the
// tool call on stdin; safe tools are allowed locally, sensitive ones are posted
// to the bridge which blocks until the phone answers. Self-contained (no repo imports).
const HOOK_SCRIPT = `import { readFileSync } from "node:fs";
import { request } from "node:http";

const [, , url, secret] = process.argv;
const SENSITIVE = new Set(${JSON.stringify([...SENSITIVE_TOOLS])});

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason || "" } }));
  process.exit(0);
}

let input = {};

try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  decide("allow");
}

if (!SENSITIVE.has(input.tool_name)) {
  decide("allow");
}

const payload = JSON.stringify({ secret, tool_name: input.tool_name, tool_input: input.tool_input, session_id: input.session_id });
const u = new URL(url);
const req = request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
  let body = "";
  res.on("data", (c) => { body += c; });
  res.on("end", () => {
    try {
      const d = JSON.parse(body);
      decide(d.decision === "deny" ? "deny" : "allow", d.reason);
    } catch {
      decide("deny", "codex-phone: bad approval response");
    }
  });
});
req.on("error", () => decide("deny", "codex-phone: bridge unreachable"));
req.write(payload);
req.end();
`;

const MODELS = [
  { id: "opus", displayName: "Claude Opus", description: "Most capable — deep reasoning and hard problems.", isDefault: true },
  { id: "sonnet", displayName: "Claude Sonnet", description: "Balanced speed and capability for everyday work." },
  { id: "fable", displayName: "Claude Fable", description: "Fast, strong general-purpose model." },
  { id: "haiku", displayName: "Claude Haiku", description: "Fastest and lightest for simple tasks." },
];

const EFFORTS = [
  { reasoningEffort: "low", description: "Minimal thinking; fastest replies." },
  { reasoningEffort: "medium", description: "Moderate thinking for routine work." },
  { reasoningEffort: "high", description: "Thorough thinking (default)." },
  { reasoningEffort: "xhigh", description: "Extended thinking for hard problems." },
  { reasoningEffort: "max", description: "Maximum thinking budget." },
];

// Our permission modes -> Claude --permission-mode. The CLI accepts
// acceptEdits | auto | bypassPermissions | manual | dontAsk | plan. Accepts the
// UI mode keys plus legacy/Codex aliases for safety.
function permissionModeFor(value) {
  switch (value) {
    case "plan":
    case "chat":
    case "read-only":
      return "plan";
    case "bypass":
    case "full":
    case "danger-full-access":
      return "bypassPermissions";
    case "acceptEdits":
    case "agent":
    case "workspace-write":
      return "acceptEdits";
    // Claude's own safety check runs each action and pauses on anything risky —
    // the mode the desktop/VS Code client defaults to. No phone-side hook here:
    // gating every command would just turn this back into Manual.
    case "auto":
    case "on-request":
      return "auto";
    case "dontAsk":
      return "dontAsk";
    case "manual":
    case "default":
    default:
      return "default";
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

// Stringify a tool_result content value (string | block[]).
function toolResultText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : b.text ?? "")).join("");
  }

  return "";
}

// Map a Claude tool_use block to a normalized item.
function toolUseToItem(block) {
  const name = block.name ?? "";
  const input = block.input ?? {};

  if (name === "Bash") {
    return { type: "commandExecution", id: block.id, command: input.command ?? "", status: "running" };
  }

  if (FILE_TOOLS.has(name)) {
    const path = input.file_path ?? input.notebook_path ?? "";
    let diff = "";

    if (name === "Write") {
      diff = String(input.content ?? "")
        .split("\n")
        .map((l) => "+" + l)
        .join("\n");
    } else if (name === "Edit") {
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

    return { type: "fileChange", id: block.id, changes: [{ path, diff }] };
  }

  const server = name.includes("__") ? name.split("__")[1] : "tool";
  return { type: "mcpToolCall", id: block.id, server, tool: name };
}

export class ClaudeProvider extends BaseProvider {
  constructor(emit) {
    super(emit, "claude");

    // Persistent warm sessions: threadId and (once known) native sessionId
    // both point at the same session object.
    this.sessions = new Map();
    this.summaryCache = new Map(); // path -> { mtime, summary }
    this.drafts = new Map(); // draft id -> cwd (recovered on send)
    this.lastRateLimit = null; // last rate_limit_info seen (for usage())
    this.spawnCount = 0; // test observability: process reuse across turns

    // interactive approvals
    this.endpoint = null; // { host, port }
    this.hookSecret = randomBytes(16).toString("hex");
    this.hookPath = null; // temp file, written on setEndpoint
    this.pendingApprovals = new Map(); // id -> { resolve, timer }

    // usage enrichment
    this.sessionCost = 0; // cumulative $ this server run
    this.lastUsage = null; // last result.usage
    this.lastModelUsage = null; // last result.modelUsage

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
    const hookHost = !host || host === "0.0.0.0" ? "127.0.0.1" : host;
    this.endpoint = { host: hookHost, port };

    try {
      this.hookPath = join(tmpdir(), `cxp-claude-hook-${process.pid}.mjs`);
      writeFileSync(this.hookPath, HOOK_SCRIPT);
    } catch {
      this.hookPath = null;
    }
  }

  // Called by the PreToolUse hook (over loopback). Verifies the secret, raises
  // an approval on the phone, and resolves to { decision } when answered.
  handleHookRequest(body = {}) {
    if (!body || body.secret !== this.hookSecret) {
      return Promise.resolve({ decision: "deny", reason: "bad secret" });
    }

    const tool = body.tool_name;
    const input = body.tool_input ?? {};
    const requestId = "clj-" + randomBytes(6).toString("hex");

    const isFile = FILE_TOOLS.has(tool);
    const method = isFile ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
    const command = tool === "Bash" ? input.command : `${tool} ${JSON.stringify(input)}`.slice(0, 300);
    const params = { threadId: body.session_id, tool_name: tool };

    if (isFile) {
      params.changes = [{ path: input.file_path || input.notebook_path || "(file)" }];
    } else {
      params.command = command;
    }

    this.emit("approval", { requestId, method, params });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(requestId);
        resolve({ decision: "deny", reason: "approval timed out" });
      }, APPROVAL_TIMEOUT_MS);
      this.pendingApprovals.set(requestId, { resolve, timer });
    });
  }

  respondApproval({ requestId, decision } = {}) {
    const pending = this.pendingApprovals.get(String(requestId));

    if (!pending) {
      return { ok: false, error: "no such pending approval" };
    }

    this.pendingApprovals.delete(String(requestId));
    clearTimeout(pending.timer);
    pending.resolve({ decision: decision === "deny" ? "deny" : "allow" });
    return { ok: true };
  }

  // ---------- transcript scanning ----------

  listTranscriptFiles() {
    const files = [];

    if (!existsSync(PROJECTS_DIR)) {
      return files;
    }

    let dirs;

    try {
      dirs = readdirSync(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const dir of dirs) {
      if (!dir.isDirectory()) {
        continue;
      }

      const dirPath = join(PROJECTS_DIR, dir.name);
      let entries;

      try {
        entries = readdirSync(dirPath);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.endsWith(".jsonl")) {
          files.push({ path: join(dirPath, entry), id: entry.slice(0, -".jsonl".length) });
        }
      }
    }

    return files;
  }

  summaryFor(file) {
    let mtime = 0;

    try {
      mtime = statSync(file.path).mtimeMs;
    } catch {
      return null;
    }

    const cached = this.summaryCache.get(file.path);

    if (cached && cached.mtime === mtime) {
      return cached.summary;
    }

    const head = readHead(file.path);
    let cwd = null;
    let preview = "";

    for (const line of head.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      let obj;

      try {
        obj = JSON.parse(line);
      } catch {
        continue; // truncated last line from the head read
      }

      if (!cwd && obj.cwd) {
        cwd = obj.cwd;
      }

      if (!preview && obj.type === "user") {
        const blocks = toBlocks(obj.message?.content);
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ").trim();

        if (text && !text.startsWith("<")) {
          preview = text.slice(0, 300);
        }
      }

      if (cwd && preview) {
        break;
      }
    }

    const summary = {
      id: file.id,
      preview: preview || "(no prompt)",
      name: null,
      cwd,
      gitInfo: null,
      updatedAt: Math.floor(mtime / 1000),
      provider: "claude",
    };

    this.summaryCache.set(file.path, { mtime, summary });
    return summary;
  }

  buildSummaries() {
    const summaries = [];

    for (const file of this.listTranscriptFiles()) {
      const s = this.summaryFor(file);

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

  findTranscriptPath(id) {
    for (const file of this.listTranscriptFiles()) {
      if (file.id === id) {
        return file.path;
      }
    }

    return null;
  }

  async readThread(id) {
    const path = this.findTranscriptPath(id);

    if (!path) {
      throw Object.assign(new Error("thread not found"), { status: 404 });
    }

    // Full read is required here (single file). Read whole file synchronously.
    let raw = "";

    try {
      raw = readFileSync(path, "utf8");
    } catch {
      raw = "";
    }
    const turns = [];
    const toolById = new Map(); // tool_use_id -> commandExecution item
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

      if (!CONTENT_TYPES.has(obj.type)) {
        continue;
      }

      const blocks = toBlocks(obj.message?.content);

      if (obj.type === "user") {
        const textBlocks = blocks.filter((b) => b.type === "text" && (b.text ?? "").trim() && !(b.text ?? "").trim().startsWith("<"));
        const resultBlocks = blocks.filter((b) => b.type === "tool_result");

        if (textBlocks.length) {
          current = { items: [] };
          turns.push(current);
          current.items.push({ type: "userMessage", content: textBlocks.map((b) => ({ type: "text", text: b.text })) });
        }

        for (const rb of resultBlocks) {
          const item = toolById.get(rb.tool_use_id);

          if (item && item.type === "commandExecution") {
            item.aggregatedOutput = toolResultText(rb.content);
            item.exitCode = rb.is_error ? 1 : 0;
            item.status = "completed";
          }
        }

        continue;
      }

      // assistant
      const turn = ensureTurn();

      for (const block of blocks) {
        if (block.type === "text") {
          if ((block.text ?? "").trim()) {
            turn.items.push({ type: "agentMessage", id: obj.message?.id, text: block.text });
          }
        } else if (block.type === "thinking") {
          if ((block.thinking ?? "").trim()) {
            turn.items.push({ type: "reasoning", id: obj.message?.id, summary: [block.thinking] });
          }
        } else if (block.type === "tool_use") {
          const item = toolUseToItem(block);
          turn.items.push(item);

          if (item.type === "commandExecution") {
            toolById.set(block.id, item);
          }
        }
      }
    }

    // Prewarm the stream-json process so the first send on this thread is warm.
    try {
      if (!this.sessions.has(id)) {
        this.ensureSession(id, {
          cwd: this.cwdForSession(id),
          model: undefined,
          effort: undefined,
          modeKey: undefined,
          isDraft: false,
        });
      }
    } catch {
      // ignore prewarm failures
    }

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
    const info = this.lastRateLimit;
    const primary = info
      ? {
          usedPercent: null,
          windowDurationMins: 300,
          resetsAt: toEpochSec(info.resetsAt),
          status: info.status ?? null,
          overageStatus: info.overageStatus ?? null,
          isUsingOverage: info.isUsingOverage ?? null,
        }
      : null;

    // Token totals from the most recent turn's result.usage.
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
      account: { type: "chatgpt", email: null, planType: "claude" },
      rateLimits: primary ? { rateLimits: { primary } } : null,
      usage,
    };
  }

  async newThread({ cwd } = {}) {
    if (!cwd) {
      throw Object.assign(new Error("cwd required"), { status: 400 });
    }

    const id = "draft-" + randomBytes(6).toString("hex");
    this.drafts.set(id, cwd);
    return { thread: { id, cwd, name: null, preview: "New session", provider: "claude", draft: true } };
  }

  // Recover the working directory for a turn: explicit cwd wins, then the
  // draft record, then the session's own transcript, then $HOME as a last resort.
  cwdForSession(threadId, explicit) {
    if (explicit) {
      return explicit;
    }

    if (threadId && this.drafts.has(threadId)) {
      return this.drafts.get(threadId);
    }

    const path = threadId ? this.findTranscriptPath(threadId) : null;

    if (path) {
      for (const line of readHead(path).split("\n")) {
        try {
          const o = JSON.parse(line);

          if (o && typeof o.cwd === "string") {
            return o.cwd;
          }
        } catch {
          // skip non-JSON / partial lines
        }
      }
    }

    return homedir() || process.cwd();
  }

  // ---------- live turn (persistent stream-json session pool) ----------

  // Normalize model/effort/modeKey for pool key matching (undefined == no override).
  modelModeMatch(session, model, effort, modeKey) {
    const m = model || undefined;
    const e = effort || undefined;
    const k = modeKey || undefined;
    return session.model === m && session.effort === e && session.modeKey === k;
  }

  newCtx(emitThreadId, isDraft) {
    return {
      emitThreadId,
      isDraft,
      adopted: false,
      sessionId: null,
      turnId: null,
      streamMsgId: null,
      blockKinds: new Map(), // block index -> "text" | "thinking" | "tool_use"
      toolKinds: new Map(), // tool_use_id -> "cmd" | "file" | "mcp"
      toolCommands: new Map(), // tool_use_id -> command string
      sawResult: false,
    };
  }

  // Clear per-turn fields; keep emitThreadId / isDraft / adopted / sessionId.
  resetTurn(ctx) {
    ctx.turnId = null;
    ctx.streamMsgId = null;
    ctx.blockKinds = new Map();
    ctx.toolKinds = new Map();
    ctx.toolCommands = new Map();
    ctx.sawResult = false;
  }

  async ensureSession(emitThreadId, { cwd, model, effort, modeKey, isDraft }) {
    const existing = this.sessions.get(emitThreadId);

    if (existing && !existing.dead && this.modelModeMatch(existing, model, effort, modeKey)) {
      existing.lastUsed = Date.now();
      return existing;
    }

    if (existing) {
      this.closeSession(existing);
    }

    const resolvedModel = model || undefined;
    const resolvedEffort = effort || undefined;
    const resolvedModeKey = modeKey || undefined;

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];

    if (!isDraft) {
      args.push("--resume", emitThreadId);
    }

    if (resolvedModel) {
      args.push("--model", resolvedModel);
    }

    if (resolvedEffort) {
      args.push("--effort", resolvedEffort);
    }

    // Interactive approvals for "manual" mode: run in default permission mode but
    // gate sensitive tools through the PreToolUse hook (which asks the phone).
    // acceptEdits/plan/bypass run non-interactively with their native mode.
    const interactive =
      this.hookPath && this.endpoint && (resolvedModeKey === "manual" || resolvedModeKey === "default" || resolvedModeKey == null);

    if (interactive) {
      args.push("--permission-mode", "default");
      const url = `http://${this.endpoint.host}:${this.endpoint.port}/internal/claude-approval`;
      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `"${process.execPath}" "${this.hookPath}" ${url} ${this.hookSecret}`,
                },
              ],
            },
          ],
        },
      };
      args.push("--settings", JSON.stringify(settings));
    } else {
      args.push("--permission-mode", permissionModeFor(resolvedModeKey));
    }

    let child;

    try {
      child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      throw Object.assign(new Error("failed to spawn claude: " + (e.message ?? e)), { status: 500 });
    }

    this.spawnCount += 1;

    const session = {
      child,
      cwd,
      model: resolvedModel,
      effort: resolvedEffort,
      modeKey: resolvedModeKey,
      sessionId: null,
      emitThreadId,
      ready: null,
      busy: false,
      dead: false,
      lastUsed: Date.now(),
      feed: null,
      ctx: this.newCtx(emitThreadId, isDraft),
      turnDone: null,
      _resolveTurnDone: null,
    };

    // Store under emitThreadId before returning so concurrent callers share it.
    this.sessions.set(emitThreadId, session);

    session.feed = makeLineReader((line) => this.handleStreamLine(line, session));
    child.stdout.on("data", (d) => session.feed(d));

    child.stderr.on("data", (d) => {
      process.stderr.write(`[claude] ${d}`);
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

        if (session._resolveTurnDone) {
          session._resolveTurnDone();
          session._resolveTurnDone = null;
        }
      }
    };

    child.on("error", (e) => {
      const msg =
        e.code === "ENOENT"
          ? "The `claude` CLI was not found on PATH. Install Claude Code and restart codex-phone."
          : String(e.message ?? e);
      onDead(msg);
    });

    child.on("exit", (code) => {
      onDead(code ? `claude exited with code ${code}` : "claude exited");
    });

    // Claude has no separate init handshake — the process is usable immediately;
    // the first stdin write drives system/init.
    session.ready = Promise.resolve();

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

  async send(body = {}) {
    const { threadId, text, model, effort, mode, sandbox, cwd, draft } = body;

    if (!text) {
      throw Object.assign(new Error("text required"), { status: 400 });
    }

    const isDraft = !!draft || !threadId || String(threadId).startsWith("draft-") || threadId === "new";
    const emitThreadId = threadId || "draft-" + randomBytes(6).toString("hex");
    const resolvedCwd = this.cwdForSession(threadId, cwd);
    const modeKey = mode ?? sandbox;

    const session = await this.ensureSession(emitThreadId, {
      cwd: resolvedCwd,
      model,
      effort,
      modeKey,
      isDraft,
    });

    await session.ready;

    // Serialize turns on the same warm session.
    if (session.busy && session.turnDone) {
      await session.turnDone;
    }

    if (session.busy) {
      throw Object.assign(new Error("a turn is already running"), { status: 409 });
    }

    if (session.dead) {
      throw Object.assign(new Error("session is dead"), { status: 500 });
    }

    this.resetTurn(session.ctx);
    session.busy = true;
    session.turnDone = new Promise((r) => {
      session._resolveTurnDone = r;
    });

    // Do NOT emit turn/started here — the translation already emits it from
    // message_start (handleAnthropicEvent), same as the cold-spawn path.
    const frame = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });

    try {
      session.child.stdin.write(frame + "\n");
    } catch (e) {
      session.busy = false;

      if (session._resolveTurnDone) {
        session._resolveTurnDone();
        session._resolveTurnDone = null;
      }

      throw Object.assign(new Error("failed to write to claude stdin: " + (e.message ?? e)), { status: 500 });
    }

    session.lastUsed = Date.now();
    return { ok: true, threadId: emitThreadId };
  }

  handleStreamLine(line, session) {
    const ctx = session.ctx;
    let obj;

    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }

    const tid = ctx.emitThreadId;

    if (obj.type === "system" && obj.subtype === "init") {
      if (obj.session_id) {
        ctx.sessionId = obj.session_id;
        session.sessionId = obj.session_id;
        this.sessions.set(obj.session_id, session);

        if (ctx.isDraft && !ctx.adopted) {
          ctx.adopted = true;
          this.drafts.delete(tid);
          this.notify("thread/adopted", { threadId: tid, sessionId: obj.session_id });
        }
      }

      return;
    }

    if (obj.type === "rate_limit_event") {
      this.lastRateLimit = obj.rate_limit_info ?? null;
      const info = obj.rate_limit_info ?? {};
      this.notify("account/rateLimits/updated", {
        threadId: tid,
        rateLimits: { primary: { usedPercent: null, windowDurationMins: 300, resetsAt: toEpochSec(info.resetsAt), status: info.status ?? null } },
      });
      return;
    }

    if (obj.type === "stream_event") {
      this.handleAnthropicEvent(obj.event ?? {}, ctx);
      return;
    }

    if (obj.type === "assistant") {
      this.handleAssistantMessage(obj.message ?? {}, ctx);
      return;
    }

    if (obj.type === "user") {
      this.handleUserMessage(obj.message ?? {}, ctx);
      return;
    }

    if (obj.type === "result") {
      ctx.sawResult = true;
      const total = this.tokensFromUsage(obj.usage);

      if (total != null) {
        this.notify("thread/tokenUsage/updated", { threadId: tid, tokenUsage: { total: { totalTokens: total } } });
      }

      // Enrich usage(): accumulate spend and remember the last token/model breakdown.
      if (typeof obj.total_cost_usd === "number") {
        this.sessionCost += obj.total_cost_usd;
      }

      this.lastUsage = obj.usage ?? this.lastUsage;
      this.lastModelUsage = obj.modelUsage ?? this.lastModelUsage;

      const failed = obj.subtype && obj.subtype !== "success";
      this.notify(failed ? "turn/failed" : "turn/completed", {
        threadId: tid,
        turn: { id: ctx.turnId, status: failed ? "failed" : "completed", error: failed ? { message: String(obj.result ?? obj.subtype) } : undefined },
      });

      // End the turn at the session level so the warm process can accept another.
      session.busy = false;
      session.lastUsed = Date.now();

      if (session._resolveTurnDone) {
        session._resolveTurnDone();
        session._resolveTurnDone = null;
      }

      return;
    }
  }

  handleAnthropicEvent(event, ctx) {
    const tid = ctx.emitThreadId;

    switch (event.type) {
      case "message_start": {
        const id = event.message?.id;
        ctx.streamMsgId = id;

        if (!ctx.turnId) {
          ctx.turnId = id || "turn";
          this.notify("turn/started", { threadId: tid, turn: { id: ctx.turnId } });
        }

        ctx.blockKinds = new Map();
        break;
      }

      case "content_block_start": {
        const kind = event.content_block?.type;
        ctx.blockKinds.set(event.index, kind);
        break;
      }

      case "content_block_delta": {
        const kind = ctx.blockKinds.get(event.index);
        const itemId = `${ctx.streamMsgId}:${event.index}`;
        const delta = event.delta ?? {};

        if (delta.type === "text_delta" && kind === "text") {
          this.notify("item/agentMessage/delta", { threadId: tid, itemId, delta: delta.text ?? "" });
        } else if (delta.type === "thinking_delta" && kind === "thinking") {
          this.notify("item/reasoning/summaryTextDelta", { threadId: tid, itemId, delta: delta.thinking ?? "" });
        }

        // input_json_delta: tool input streams here; rendered from the
        // assembled assistant message instead, so nothing to emit.
        break;
      }

      default:
        break;
    }
  }

  handleAssistantMessage(message, ctx) {
    const tid = ctx.emitThreadId;
    const content = Array.isArray(message.content) ? message.content : [];

    content.forEach((block, i) => {
      const itemId = `${message.id}:${i}`;

      if (block.type === "text") {
        if ((block.text ?? "").trim()) {
          this.notify("item/completed", { threadId: tid, item: { type: "agentMessage", id: itemId, text: block.text } });
        }
      } else if (block.type === "thinking") {
        if ((block.thinking ?? "").trim()) {
          this.notify("item/completed", { threadId: tid, item: { type: "reasoning", id: itemId, summary: [block.thinking] } });
        }
      } else if (block.type === "tool_use") {
        const item = toolUseToItem(block);

        if (item.type === "commandExecution") {
          ctx.toolKinds.set(block.id, "cmd");
          ctx.toolCommands.set(block.id, item.command);
          this.notify("item/started", { threadId: tid, item: { type: "commandExecution", id: block.id, command: item.command, status: "running" } });
        } else if (item.type === "fileChange") {
          ctx.toolKinds.set(block.id, "file");
          this.notify("item/completed", { threadId: tid, item });
        } else {
          ctx.toolKinds.set(block.id, "mcp");
          this.notify("item/started", { threadId: tid, item });
        }
      }
    });

    const total = this.tokensFromUsage(message.usage);

    if (total != null) {
      this.notify("thread/tokenUsage/updated", { threadId: tid, tokenUsage: { total: { totalTokens: total } } });
    }
  }

  handleUserMessage(message, ctx) {
    const tid = ctx.emitThreadId;
    const content = Array.isArray(message.content) ? message.content : [];

    for (const block of content) {
      if (block.type !== "tool_result") {
        continue;
      }

      const kind = ctx.toolKinds.get(block.tool_use_id);

      if (kind === "cmd") {
        const output = toolResultText(block.content);

        if (output) {
          this.notify("item/commandExecution/outputDelta", { threadId: tid, itemId: block.tool_use_id, delta: output });
        }

        this.notify("item/completed", {
          threadId: tid,
          item: {
            type: "commandExecution",
            id: block.tool_use_id,
            command: ctx.toolCommands.get(block.tool_use_id) ?? "",
            aggregatedOutput: output,
            exitCode: block.is_error ? 1 : 0,
            status: "completed",
          },
        });
      }
    }
  }

  tokensFromUsage(usage) {
    if (!usage) {
      return null;
    }

    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreate = usage.cache_creation_input_tokens ?? 0;
    const total = input + output + cacheRead + cacheCreate;
    return total > 0 ? total : null;
  }

  // Prefer a control interrupt on stdin; fall back to killing the child (next
  // send respawns warm). Correct Stop matters more than keeping warmth after Stop.
  // Empirically: control_request / type:interrupt are best-effort; kill is reliable.
  async interrupt({ threadId } = {}) {
    const session = this.sessions.get(threadId);

    if (!session || session.dead) {
      return { ok: true };
    }

    if (session.busy && session.child?.stdin?.writable) {
      try {
        session.child.stdin.write(
          JSON.stringify({ type: "control_request", request: { subtype: "interrupt" } }) + "\n",
        );
      } catch {
        // ignore write errors; fall through to kill
      }

      // Brief wait for a clean result path.
      if (session.turnDone) {
        await Promise.race([
          session.turnDone,
          new Promise((r) => setTimeout(r, 1500)),
        ]);
      }
    }

    if (session.busy && !session.dead) {
      // Fall back: kill the process. Do not pre-set dead so onDead fails the turn.
      try {
        session.child?.kill("SIGTERM");
      } catch {
        // ignore
      }

      if (session.turnDone) {
        await Promise.race([
          session.turnDone,
          new Promise((r) => setTimeout(r, 1000)),
        ]);
      }

      // Safety net if exit handler did not run.
      if (session.busy) {
        this.notify("turn/failed", {
          threadId: session.emitThreadId,
          turn: { status: "failed", error: { message: "cancelled" } },
        });
        session.busy = false;

        if (session._resolveTurnDone) {
          session._resolveTurnDone();
          session._resolveTurnDone = null;
        }
      }
    }

    return { ok: true };
  }
}

export default ClaudeProvider;
