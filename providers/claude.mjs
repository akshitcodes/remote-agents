// codex-phone — Claude provider.
//
// Bridges the `claude` CLI to the same normalized event/item model Codex emits,
// so the existing chat renderer is reused unchanged.
//
//   - listThreads / readThread / projects  read ~/.claude/projects/**/*.jsonl
//   - send   drives a `claude -p --input-format stream-json` process for the
//            active turn and translates its envelope into normalized events.
//            The process is closed at terminal result because current Claude
//            builds accept a later stdin frame but may not stream its result.
//   - models scans real assistant transcript records and adds documented latest
//            aliases as a small fallback; usage is partial (5h window).
//
// Interactive approvals: in "agent" mode the bridge attaches a PreToolUse hook
// (via --settings). The hook auto-allows safe tools and, for sensitive ones
// (Bash + file edits), calls back to the bridge and blocks until the phone
// answers — surfacing the same approval banner Codex uses.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { createReadStream, readdirSync, statSync, openSync, readSync, closeSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { augmentedPath, providerBinary } from "../provider-detect.mjs";
import { capabilitiesFor, pickChoice, supportsFlag, UNKNOWN_CAPABILITIES } from "../cli-capabilities.mjs";
import { storedAttachmentForBase64 } from "../attachments.mjs";
import { BaseProvider, toEpochSec, makeLineReader } from "./base.mjs";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const HEAD_BYTES = 65536; // enough to reach the first user line + cwd
// Enough to reach the newest ai-title record without reading a whole transcript.
const TITLE_TAIL_BYTES = 64 * 1024;
const PAGE_SIZE = 25;
const execFileAsync = promisify(execFile);

// Bookkeeping line types in the transcript that are not conversation content.
const CONTENT_TYPES = new Set(["user", "assistant"]);

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Tools that require the user's approval in "agent" mode. Everything else
// (Read, Grep, Glob, WebFetch, …) is auto-allowed by the hook without a prompt.
const SENSITIVE_TOOLS = new Set(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch"]);
const APPROVAL_TIMEOUT_MS = 240000;
const THREAD_CONFLICT_CODE = "thread_locked_elsewhere";

export function claudeTurnError(message) {
  const text = String(message ?? "");

  if (/Session\s+\S+\s+is currently running as a background agent\s*\(bg\)/i.test(text)) {
    return {
      message: "this thread is open on your Mac; close it there to continue",
      code: THREAD_CONFLICT_CODE,
    };
  }

  if (/Unknown --(?:effort|model) value|ignoring it and using the default/i.test(text)) {
    return {
      message: `Claude rejected an exact model or effort setting: ${text.trim()}`,
      code: "provider_settings_unconfirmed",
    };
  }

  return { message: text };
}

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

const PROVIDER_DEFAULT = "provider-default";

const MODEL_FAMILY_ORDER = new Map([
  ["opus", 0],
  ["sonnet", 1],
  ["fable", 2],
  ["haiku", 3],
]);

function claudeModelFamily(id) {
  if (MODEL_FAMILY_ORDER.has(id)) { return id; }
  return /^claude-(opus|sonnet|fable|haiku)-/.exec(id)?.[1] ?? null;
}

function isClaudeModelId(value) {
  return typeof value === "string"
    && value.length <= 200
    && /^claude-[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9]+\])?$/.test(value);
}

function displayVersion(id, family) {
  const raw = id.slice(`claude-${family}-`.length);
  const match = /^(\d+)(?:-(\d+))?(?:-(\d{8}))?(.*)$/.exec(raw);

  if (!match) { return raw.replaceAll("-", " "); }

  const version = match[2] ? `${match[1]}.${match[2]}` : match[1];
  const date = match[3] ? ` (${match[3]})` : "";
  const rest = match[4] ? match[4].replaceAll("-", " ") : "";
  return `${version}${date}${rest}`.trim();
}

function observedModelDescription(family) {
  switch (family) {
    case "opus":
      return "Pinned Opus model observed in local Claude transcript history.";
    case "sonnet":
      return "Pinned Sonnet model observed in local Claude transcript history.";
    case "fable":
      return "Pinned Fable model observed in local Claude transcript history.";
    case "haiku":
      return "Pinned Haiku model observed in local Claude transcript history.";
    default:
      return "Model observed in local Claude transcript history.";
  }
}

export function claudeModelAliasesFromHelp(help) {
  const block = /--model\s+<[^>]+>([\s\S]*?)(?=\n\s{0,4}(?:-[a-zA-Z],\s*)?--[a-z]|$)/.exec(String(help ?? ""))?.[1] ?? "";
  const aliasExample = /alias[^\n]*\(e\.g\.\s*([^)]+)\)/i.exec(block)?.[1] ?? "";
  return [...aliasExample.matchAll(/["']([a-z][a-z0-9._-]*)["']/gi)]
    .map((match) => match[1])
    .filter((id, index, all) => !id.startsWith("claude-") && all.indexOf(id) === index);
}

function providerDefaultModel() {
  return {
    id: PROVIDER_DEFAULT,
    displayName: "Claude default",
    description: "Let this installed Claude Code build choose its own current default model.",
    isDefault: true,
    source: "provider_default",
  };
}

export function buildClaudeModelList(observedIds = [], aliases = []) {
  const observed = [...new Set(observedIds)].filter(isClaudeModelId).map((id) => {
    const family = claudeModelFamily(id);
    const familyName = family ? family[0].toUpperCase() + family.slice(1) : "Model";
    return {
      id,
      family,
      displayName: family ? `Claude ${familyName} ${displayVersion(id, family)}` : id,
      description: observedModelDescription(family),
      source: "transcript",
    };
  });

  observed.sort((a, b) => {
    const family = (MODEL_FAMILY_ORDER.get(a.family) ?? 99) - (MODEL_FAMILY_ORDER.get(b.family) ?? 99);
    return family || b.id.localeCompare(a.id, undefined, { numeric: true });
  });

  const byFamily = new Map();
  for (const model of observed) {
    const rows = byFamily.get(model.family) ?? [];
    rows.push(model);
    byFamily.set(model.family, rows);
  }

  const data = [providerDefaultModel()];
  for (const id of aliases) {
    const family = claudeModelFamily(id) ?? id;
    const familyName = family[0].toUpperCase() + family.slice(1);
    data.push({
      id,
      displayName: `Claude ${familyName} (latest)`,
      description: `Model alias advertised by this installed Claude Code build.`,
      source: "cli_help",
    });
    data.push(...(byFamily.get(family) ?? []));
    byFamily.delete(family);
  }

  for (const family of ["haiku", ...byFamily.keys()]) {
    data.push(...(byFamily.get(family) ?? []));
    byFamily.delete(family);
  }

  return data.map(({ family, ...model }) => model);
}

export function listClaudeTranscriptPaths(root = PROJECTS_DIR) {
  const paths = [];
  const pending = [root];

  while (pending.length) {
    const dir = pending.pop();
    let entries;

    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { pending.push(path); }
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) { paths.push(path); }
    }
  }

  return paths.sort();
}

export async function observedClaudeModelIds(paths) {
  const models = new Set();

  for (const path of paths) {
    try {
      const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

      for await (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const model = row?.type === "assistant" ? row.message?.model : null;
        if (isClaudeModelId(model)) { models.add(model); }
      }
    } catch {
      // A concurrently removed or unreadable transcript should not make the
      // whole provider list unavailable.
    }
  }

  return [...models];
}

// Our permission modes -> the values Claude's --permission-mode accepts, in
// order of preference. More than one is listed because the accepted set moves
// between releases: 2.1.0 offered `default` and `delegate` but not `auto`, while
// 2.1.238 offers `auto` and `manual` but no longer lists `default`. Asking for a
// value the installed build rejects makes the CLI refuse to start.
function permissionModePreferences(value) {
  switch (value) {
    case "plan":
    case "chat":
    case "read-only":
      return ["plan"];
    case "bypass":
    case "full":
    case "danger-full-access":
      return ["bypassPermissions"];
    case "acceptEdits":
    case "agent":
    case "workspace-write":
      return ["acceptEdits"];
    // Claude's own safety check runs each action and pauses on anything risky —
    // the mode the desktop/VS Code client defaults to. No phone-side hook here:
    // gating every command would just turn this back into Manual.
    case "auto":
    case "on-request":
      return ["auto"];
    case "dontAsk":
      return ["dontAsk"];
    // Ask about everything, which is what this bridge's Manual mode means. 2.1.238
    // calls it `manual`; older builds call the same behaviour `default`, and
    // 2.1.238 still accepts `default` even though it no longer advertises it.
    // Prefer the value this particular build advertises; both names represent
    // the same bridge Manual contract.
    case "manual":
    case "default":
    default:
      return ["default", "manual"];
  }
}

export function claudeCapabilities(bin = providerBinary("claude")) {
  return capabilitiesFor(bin, { label: "claude" });
}

function claudeEfforts(caps) {
  const advertised = [...(caps.choices.get("--effort") ?? [])];
  return [
    { reasoningEffort: PROVIDER_DEFAULT, description: "Let Claude Code choose its own default effort." },
    ...advertised.map((reasoningEffort) => ({ reasoningEffort, description: `Effort advertised by this installed Claude Code build.` })),
  ];
}

function claudePermissionModes(caps) {
  if (!caps.readable) { return []; }
  const advertised = caps.choices.get("--permission-mode") ?? new Set();
  const modes = [];
  if (advertised.has("manual") || advertised.has("default")) { modes.push("manual"); }
  if (advertised.has("auto")) { modes.push("auto"); }
  if (advertised.has("acceptEdits")) { modes.push("acceptEdits"); }
  if (advertised.has("plan")) { modes.push("plan"); }
  if (advertised.has("bypassPermissions")) { modes.push("bypass"); }
  return modes;
}

// Add --permission-mode only when this build advertises a value with the exact
// bridge meaning. Permission behavior is never silently omitted or widened.
function pushPermissionMode(args, caps, modeKey) {
  const preferences = permissionModePreferences(modeKey);
  const chosen = caps.readable ? pickChoice(caps, "--permission-mode", preferences) : null;

  if (!chosen) {
    throw Object.assign(new Error(
      `This Claude Code version cannot apply the selected ${modeKey ?? "manual"} permission mode. Update Claude Code, then retry.`,
    ), { status: 409, code: "provider_cli_incompatible" });
  }

  args.push("--permission-mode", chosen);
}

export function claudeSessionArgs({ emitThreadId, model, effort, modeKey, isDraft, hookPath, endpoint, hookSecret, nodePath = process.execPath, caps = UNKNOWN_CAPABILITIES }) {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  if (!isDraft) { args.push("--resume", emitThreadId); }
  if (model && model !== PROVIDER_DEFAULT) { args.push("--model", model); }
  // --effort only exists from Claude Code 2.1.x onwards; older builds fail with
  // `unknown option '--effort'` and never start.
  if (effort && effort !== PROVIDER_DEFAULT) {
    const advertised = caps.readable ? caps.choices.get("--effort") : null;
    if (supportsFlag(caps, "--effort") && advertised?.has(effort)) {
      args.push("--effort", effort);
    } else {
      throw Object.assign(new Error(
        `This Claude Code version cannot apply reasoning effort ${effort}. Update Claude Code, then retry.`,
      ), { status: 409, code: "provider_cli_incompatible" });
    }
  }

  const interactive = hookPath && endpoint && (modeKey === "manual" || modeKey === "default" || modeKey == null);
  if (interactive) {
    pushPermissionMode(args, caps, "default");
    const url = `http://${endpoint.host}:${endpoint.port}/internal/claude-approval`;
    const settings = {
      hooks: {
        PreToolUse: [{
          matcher: "*",
          hooks: [{
            type: "command",
            command: `"${nodePath}" "${hookPath}" ${url} ${hookSecret}`,
          }],
        }],
      },
    };
    args.push("--settings", JSON.stringify(settings));
  } else {
    pushPermissionMode(args, caps, modeKey);
  }

  return args;
}

// Read only the first bytes of a (potentially huge) transcript.
// Claude session files carry no originator, but agent-made sessions still leave
// marks: sidechain records (the Task tool), agent-name records (named agents),
// and a cwd inside a mktemp folder (a harness driving claude headlessly — no
// human works in /var/folders). UI-created sessions are identified separately
// by the bridge's own origin ledger; everything else classifies as native so an
// unclassifiable session is shown, never hidden.
// records carry an entrypoint: humans arrive as "cli", "claude-vscode", or
// "claude-desktop"; every SDK/print-mode run — agents dispatching claude -p —
// arrives as "sdk-cli". The bridge itself also drives claude -p, so its own
// sessions look sdk-driven here; the origin ledger re-marks those as "ui" and
// wins over this classification.
export function claudeOrigin({ cwd, sidechain = false, agentName = false, entrypoint = null } = {}) {
  if (sidechain || agentName) { return "agent"; }
  if (String(entrypoint ?? "").startsWith("sdk")) { return "agent"; }
  if (/^\/(?:private\/)?(?:var\/folders|tmp)\//.test(String(cwd ?? ""))) { return "agent"; }
  return "native";
}

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

// Claude's own name for a session.
//
// Claude Code writes `{"type":"ai-title","aiTitle":"...","sessionId":"..."}`
// into the transcript and shows that in its UI, so the phone should too — the
// alternative is the raw opening prompt, which for an IDE session is a context
// dump rather than anything a human would recognise.
//
// The record appears early and is then re-emitted, occasionally with a refined
// title. The last one is what Claude itself displays, so this reads a bounded
// tail rather than trusting the first — unbounded would mean reading whole
// multi-megabyte transcripts just to build a list.
function readTailTitle(path, bytes = TITLE_TAIL_BYTES) {
  let fd;

  try {
    const size = statSync(path).size;

    if (!size) { return ""; }

    fd = openSync(path, "r");

    const want = Math.min(bytes, size);
    const buf = Buffer.alloc(want);
    const read = readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString("utf8", 0, read).split("\n");

    // Backwards: the newest title wins.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"ai-title"')) {
        continue;
      }

      try {
        const title = String(JSON.parse(lines[i]).aiTitle ?? "").replace(/\s+/g, " ").trim();

        if (title) {
          return title.slice(0, 200);
        }
      } catch {
        continue; // a torn first line from the windowed read
      }
    }

    return "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

export function claudeSwapUsage(payload) {
  const active = payload?.active;
  const usage = active?.usage;

  if (!active || !usage || active.usageStatus === "unavailable") { return null; }

  const window = (value, minutes) => value && typeof value.pct === "number"
    ? { usedPercent: value.pct, windowDurationMins: minutes, resetsAt: toEpochSec(value.resetsAt) }
    : null;
  const primary = window(usage.fiveHour, 300);
  const secondary = window(usage.sevenDay, 10080);

  if (!primary && !secondary) { return null; }

  return {
    account: {
      type: "claude",
      accountId: active.organizationUuid ?? null,
      email: active.email ?? null,
      planType: "Claude",
      organizationName: active.organizationName ?? null,
      accountLabel: active.alias || (active.number ? `Account-${active.number}` : null),
    },
    rateLimits: {
      rateLimits: { primary, secondary },
      fetchedAt: toEpochSec(active.usageFetchedAt),
      ageSeconds: active.usageAgeSeconds ?? null,
      totalManagedAccounts: payload.totalManagedAccounts ?? null,
    },
    usage: null,
  };
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
// A short human account of what a tool call is for.
//
// Claude Code shows one of these above every tool call — "Sync stickiness after
// manual scroll restores" over the bash line — and on a phone that sentence is
// worth more than the command itself, which can be read by expanding the row.
// Only Bash and the subagent tool carry an author-written `description`; for the
// rest the intent lives in their arguments, so it is composed here. Returning ""
// is normal and means the caller falls back to showing the raw call.
function toolSummary(name, input = {}) {
  const file = (p) => basename(String(p ?? "")) || String(p ?? "");
  const quote = (s) => `"${String(s ?? "")}"`;
  const where = input.path ? ` in ${file(input.path)}` : "";

  switch (name) {
    // Written by the model specifically to be read by a human.
    case "Bash":
    case "Task":
    case "Agent":
      return String(input.description ?? "").trim();
    case "Read":
      return input.file_path ? `Read ${file(input.file_path)}` : "";
    case "Grep":
      return input.pattern ? `Search ${quote(input.pattern)}${where}` : "";
    case "Glob":
      return input.pattern ? `Find ${input.pattern}${where}` : "";
    case "WebFetch":
      return String(input.prompt ?? "").trim() || (input.url ? `Fetch ${input.url}` : "");
    case "WebSearch":
      return String(input.query ?? "").trim();
    case "TodoWrite":
      return "Updated the plan";
    default:
      return "";
  }
}

function toolUseToItem(block) {
  const name = block.name ?? "";
  const input = block.input ?? {};
  const description = toolSummary(name, input);

  if (name === "Bash") {
    return { type: "commandExecution", id: block.id, command: input.command ?? "", description, status: "running" };
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

    return { type: "fileChange", id: block.id, changes: [{ path, diff }], description };
  }

  // Everything else — Read, Grep, Glob, WebFetch, real MCP tools — shares one
  // shape. Without a description these render as "tool · Read", which says
  // nothing; with one they read like Claude's own transcript.
  const server = name.includes("__") ? name.split("__")[1] : "tool";
  return { type: "mcpToolCall", id: block.id, server, tool: name, description };
}

const DEFAULT_ACCEPT_TIMEOUT_MS = 60_000;

export function claudeUserContent(text, attachments = []) {
  const content = [];

  if (String(text ?? "").trim()) { content.push({ type: "text", text: String(text) }); }

  for (const attachment of attachments) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.mimeType,
        data: readFileSync(attachment.path).toString("base64"),
      },
    });
  }

  return content;
}

export class ClaudeProvider extends BaseProvider {
  constructor(emit, { acceptTimeoutMs = DEFAULT_ACCEPT_TIMEOUT_MS, binary = null, projectsDir = PROJECTS_DIR, usageCommand = "cswap", attachmentLookup = storedAttachmentForBase64 } = {}) {
    super(emit, "claude");

    // Active sessions: threadId and (once known) native sessionId both point at
    // the same session object. A process is retained only through its live turn
    // so steering remains possible; terminal results release it.
    this.sessions = new Map();
    this.acceptTimeoutMs = acceptTimeoutMs;
    this.projectsDir = projectsDir;
    this.binary = binary ?? providerBinary("claude");
    this.usageCommand = usageCommand;
    this.attachmentLookup = attachmentLookup;
    this.summaryCache = new Map(); // path -> { mtime, summary }
    this.modelCache = null; // { signature, data }
    this.drafts = new Map(); // draft id -> cwd (recovered on send)
    this.lastRateLimit = null; // last rate_limit_info seen (for usage())
    this.spawnCount = 0; // test observability: process reuse across turns

    // interactive approvals
    this.endpoint = null; // { host, port }
    this.hookSecret = randomBytes(16).toString("hex");
    this.hookPath = null; // temp file, written on setEndpoint
    this.pendingApprovals = new Map(); // id -> { resolve, timer }

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
      this.pendingApprovals.set(requestId, { resolve, timer, method, params });
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

  pendingApprovalsList() {
    return [...this.pendingApprovals.entries()].map(([requestId, pending]) => ({
      requestId,
      method: pending.method,
      params: pending.params,
    }));
  }

  // ---------- transcript scanning ----------

  listTranscriptFiles() {
    const files = [];

    if (!existsSync(this.projectsDir)) {
      return files;
    }

    let dirs;

    try {
      dirs = readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const dir of dirs) {
      if (!dir.isDirectory()) {
        continue;
      }

      const dirPath = join(this.projectsDir, dir.name);
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
    let sidechain = false;
    let agentName = false;
    let entrypoint = null;

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

      if (obj.isSidechain === true) { sidechain = true; }
      if (obj.type === "agent-name") { agentName = true; }
      if (!entrypoint && obj.entrypoint) { entrypoint = obj.entrypoint; }

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
      origin: claudeOrigin({ cwd, sidechain, agentName, entrypoint }),
      preview: preview || "(no prompt)",
      name: readTailTitle(file.path) || null,
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

  async listThreads({ search, cursor, limit = PAGE_SIZE } = {}) {
    let all = this.buildSummaries();

    if (search) {
      const q = search.toLowerCase();
      all = all.filter((s) => (s.preview ?? "").toLowerCase().includes(q) || (s.cwd ?? "").toLowerCase().includes(q));
    }

    const offset = Number(cursor) || 0;
    const page = limit == null ? all.slice(offset) : all.slice(offset, offset + limit);
    const next = limit == null ? all.length : offset + limit;
    const nextCursor = limit != null && next < all.length ? String(next) : null;
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
        const imageBlocks = blocks.filter((b) => b.type === "image");
        const resultBlocks = blocks.filter((b) => b.type === "tool_result");

        if (textBlocks.length || imageBlocks.length) {
          current = { items: [] };
          turns.push(current);
          current.items.push({
            type: "userMessage",
            content: [
              ...textBlocks.map((b) => ({ type: "text", text: b.text })),
              ...imageBlocks.map((block) => {
                const match = block.source?.type === "base64"
                  ? this.attachmentLookup(block.source.data)
                  : null;
                return { type: "image", ...(match ? { attachment: match } : {}) };
              }),
            ],
          });
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

      // Claude persists provider failures as synthetic assistant records. They
      // are terminal state, not an assistant answer: rendering both this text
      // and the terminal failure draws the same error twice.
      if (obj.isApiErrorMessage === true) {
        const message = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();

        if (message) {
          turn.items.push({
            type: "turnError",
            message,
            code: obj.error ?? null,
            terminalId: `claude:${obj.uuid ?? obj.message?.id ?? "provider-error"}`,
          });
        }

        continue;
      }

      // Claude 2.1.250 writes one logical assistant message as several JSONL
      // records that share message.id but have distinct record UUIDs. The
      // record UUID is the stable replay identity; reusing each record's local
      // block index makes unrelated thinking and text records collide at :0.
      for (const [blockIndex, block] of blocks.entries()) {
        const replayId = `${obj.uuid ?? obj.message?.id ?? "assistant"}:${blockIndex}`;

        if (block.type === "text") {
          if ((block.text ?? "").trim()) {
            turn.items.push({ type: "agentMessage", id: replayId, text: block.text });
          }
        } else if (block.type === "thinking") {
          if ((block.thinking ?? "").trim()) {
            turn.items.push({ type: "reasoning", id: replayId, summary: [block.thinking] });
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
    const bin = this.binary;
    const caps = await claudeCapabilities(bin);
    const paths = listClaudeTranscriptPaths(this.projectsDir);
    const signature = `${caps.text}\n` + paths.map((path) => {
      try {
        const stat = statSync(path);
        return `${path}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${path}:missing`;
      }
    }).join("\n");

    if (this.modelCache?.signature === signature) {
      return { data: this.modelCache.data, capabilities: this.modelCache.capabilities };
    }

    const observed = await observedClaudeModelIds(paths);
    const efforts = claudeEfforts(caps);
    const data = buildClaudeModelList(observed, claudeModelAliasesFromHelp(caps.text)).map((m) => ({
      ...m,
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: PROVIDER_DEFAULT,
      inputModalities: ["text", "image"],
      hidden: false,
    }));
    const capabilities = {
      source: caps.readable ? "cli_help+transcript" : "provider_default_only",
      provenance: {
        models: caps.readable ? "cli_help+transcript" : "transcript+provider_default",
        efforts: caps.readable ? "cli_help" : "provider_default",
        permissionModes: caps.readable ? "cli_help" : "unavailable",
        inputModalities: "tested_stream_json_adapter",
      },
      permissionModes: claudePermissionModes(caps),
      inputModalities: ["text", "image"],
    };
    this.modelCache = { signature, data, capabilities };
    return { data, capabilities };
  }

  async usage() {
    let commandError = null;
    try {
      const { stdout } = await execFileAsync(this.usageCommand, ["status", "--json"], {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: augmentedPath() },
      });
      const fromSwap = claudeSwapUsage(JSON.parse(stdout));
      if (fromSwap) { return { ...fromSwap, _fresh: { account: true, rateLimits: true } }; }
    } catch (error) {
      commandError = error;
      // claude-swap is optional. Fall back to the last native rate-limit event
      // observed by this bridge; the server retains the last good snapshot.
    }

    const info = this.lastRateLimit;
    const resetAt = toEpochSec(info?.resetsAt);
    const primary = info && (!resetAt || resetAt > Date.now() / 1000)
      ? {
          usedPercent: null,
          windowDurationMins: 300,
          resetsAt: resetAt,
          status: info.status ?? null,
          overageStatus: info.overageStatus ?? null,
          isUsingOverage: info.isUsingOverage ?? null,
        }
      : null;

    if (!primary && commandError) {
      throw new Error(`Claude usage check failed: ${commandError.code || commandError.message || "unknown error"}`);
    }

    return {
      account: { type: "claude", email: null, planType: "Claude" },
      rateLimits: primary ? { rateLimits: { primary } } : null,
      usage: null,
      _fresh: { account: false, rateLimits: false },
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
      blockTexts: new Map(), // block index -> text assembled from native deltas
      completedBlocks: new Set(),
      assistantEnvelopeSeq: 0,
      toolKinds: new Map(), // tool_use_id -> "cmd" | "file" | "mcp"
      toolCommands: new Map(), // tool_use_id -> command string
      // tool_use_id -> the model's own one-line account of the call, needed
      // again when the result arrives and the completed item is rebuilt.
      toolDescriptions: new Map(),
      sawResult: false,
      sawAssistantOutput: false,
      syntheticNoResponse: false,
    };
  }

  // Clear per-turn fields; keep emitThreadId / isDraft / adopted / sessionId.
  resetTurn(ctx) {
    ctx.turnId = null;
    ctx.streamMsgId = null;
    ctx.blockKinds = new Map();
    ctx.blockTexts = new Map();
    ctx.completedBlocks = new Set();
    ctx.assistantEnvelopeSeq = 0;
    ctx.toolKinds = new Map();
    ctx.toolCommands = new Map();
    ctx.toolDescriptions = new Map();
    ctx.sawResult = false;
    ctx.sawAssistantOutput = false;
    ctx.syntheticNoResponse = false;
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
    // Resolve once, so the flags we choose describe the build we then run.
    const bin = this.binary;

    const args = claudeSessionArgs({
      emitThreadId,
      model: resolvedModel,
      effort: resolvedEffort,
      modeKey: resolvedModeKey,
      isDraft,
      hookPath: this.hookPath,
      endpoint: this.endpoint,
      hookSecret: this.hookSecret,
      caps: await claudeCapabilities(bin),
    });

    let child;

    try {
      child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: augmentedPath() } });
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
      turnAccepted: null,
      _resolveTurnAccepted: null,
      _rejectTurnAccepted: null,
      acceptTimer: null,
      stderr: "",
    };

    // Store under emitThreadId before returning so concurrent callers share it.
    this.sessions.set(emitThreadId, session);

    session.feed = makeLineReader((line) => this.handleStreamLine(line, session));
    child.stdout.on("data", (d) => session.feed(d));

    child.stderr.on("data", (d) => {
      session.stderr = (session.stderr + d.toString()).slice(-8000);
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
        const error = claudeTurnError(session.stderr || msg);
        const knownConflict = error.code === THREAD_CONFLICT_CODE;
        const failure = Object.assign(new Error(error.message), knownConflict
          ? { status: 409, code: error.code }
          : {
              // stdin accepted the user frame but the process died before the
              // message_start acknowledgement. It may already be in Claude's
              // transcript, so exposing an ordinary Retry could deliver it a
              // second time.
              status: 504,
              code: "delivery_uncertain",
            });

        if (session._rejectTurnAccepted) {
          this.clearAcceptTimer(session);
          session._rejectTurnAccepted(failure);
          session._resolveTurnAccepted = null;
          session._rejectTurnAccepted = null;
        }

        this.notify("turn/failed", {
          threadId: session.emitThreadId,
          error,
          turn: { status: "failed", error },
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

    this.clearAcceptTimer(session);
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

  clearAcceptTimer(session) {
    if (session?.acceptTimer) {
      clearTimeout(session.acceptTimer);
      session.acceptTimer = null;
    }
  }

  async send(body = {}) {
    const { threadId, text, attachments = [], model, effort, mode, sandbox, cwd, draft } = body;

    if (!String(text ?? "").trim() && !attachments.length) {
      throw Object.assign(new Error("message content required"), { status: 400 });
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

    if (session.busy) {
      // Never wait indefinitely for an acknowledgement-timeout turn. It may be
      // live but temporarily silent, so killing it would be unsafe; report the
      // state and let the durable phone queue wait for canonical completion.
      throw Object.assign(new Error("a turn is already running"), { status: 409, code: "turn_in_progress" });
    }

    if (session.dead) {
      throw Object.assign(new Error("session is dead"), { status: 500 });
    }

    this.resetTurn(session.ctx);
    session.stderr = "";
    session.busy = true;
    session.turnDone = new Promise((r) => {
      session._resolveTurnDone = r;
    });
    session.turnAccepted = new Promise((resolve, reject) => {
      session._resolveTurnAccepted = resolve;
      session._rejectTurnAccepted = reject;
    });
    session.acceptTimer = setTimeout(() => {
      session.acceptTimer = null;
      const reject = session._rejectTurnAccepted;
      session._resolveTurnAccepted = null;
      session._rejectTurnAccepted = null;
      reject?.(Object.assign(
        new Error("Claude did not acknowledge this message in time; it may still have been delivered, so check the thread before retrying"),
        { status: 504, code: "delivery_uncertain" },
      ));
    }, this.acceptTimeoutMs);
    session.acceptTimer.unref?.();

    // Do NOT emit turn/started here — the translation already emits it from
    // message_start (handleAnthropicEvent), same as the cold-spawn path.
    const frame = JSON.stringify({
      type: "user",
      message: { role: "user", content: claudeUserContent(text, attachments) },
    });

    try {
      session.child.stdin.write(frame + "\n");
    } catch (e) {
      session.busy = false;
      this.clearAcceptTimer(session);

      if (session._resolveTurnDone) {
        session._resolveTurnDone();
        session._resolveTurnDone = null;
      }

      session._resolveTurnAccepted = null;
      session._rejectTurnAccepted = null;

      throw Object.assign(new Error("failed to write to claude stdin: " + (e.message ?? e)), { status: 500 });
    }

    session.lastUsed = Date.now();
    // Writing stdin only proves that the bridge handed bytes to a process. A
    // resume conflict arrives asynchronously, so commit the durable send only
    // after Claude actually begins the message (or explicitly rejects it).
    await session.turnAccepted;
    return { ok: true, threadId: emitThreadId };
  }

  async steer({ threadId, text, attachments = [] } = {}) {
    if (!String(text ?? "").trim() && !attachments.length) {
      throw Object.assign(new Error("message content required"), { status: 409, code: "empty_input" });
    }

    const session = this.sessions.get(threadId);

    // Native steering only exists on the persistent process that owns the live
    // turn. Spawning/resuming here would create a new turn instead.
    if (!session || session.dead || !session.child?.stdin?.writable) {
      throw Object.assign(new Error("the active turn is not owned by this bridge"), { status: 409, code: "not_our_turn" });
    }

    if (!session.busy) {
      throw Object.assign(new Error("no active turn"), { status: 409, code: "no_active_turn" });
    }

    const frame = JSON.stringify({
      type: "user",
      message: { role: "user", content: claudeUserContent(text, attachments) },
    });

    try {
      // A second user frame is absorbed by the current turn at a tool boundary.
      // Do not reset or replace any of send()'s in-flight turn bookkeeping.
      session.child.stdin.write(frame + "\n");
    } catch (e) {
      throw Object.assign(new Error("failed to steer claude: " + (e.message ?? e)), { status: 409, code: "not_our_turn" });
    }

    session.lastUsed = Date.now();
    return { ok: true, threadId: session.emitThreadId };
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
      this.handleAnthropicEvent(obj.event ?? {}, ctx, session);
      return;
    }

    if (obj.type === "assistant") {
      // Synthetic API errors are reported once by the result/exit path. They
      // must never also masquerade as normal assistant content in the live UI.
      const syntheticNoResponse = obj.message?.model === "<synthetic>"
        && (obj.message?.content ?? []).some((block) => block?.type === "text" && /^no response requested\.?$/i.test(String(block.text ?? "").trim()));
      if (syntheticNoResponse) {
        ctx.syntheticNoResponse = true;
      } else if (obj.isApiErrorMessage !== true) {
        this.handleAssistantMessage(obj.message ?? {}, ctx);
      }
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
      const providerSettingError = claudeTurnError(session.stderr);
      const resultText = typeof obj.result === "string" ? obj.result.trim() : "";
      const syntheticNoResponse = !ctx.sawAssistantOutput && (ctx.syntheticNoResponse
        || /^no response requested\.?$/i.test(resultText));
      const emptySuccess = (!obj.subtype || obj.subtype === "success")
        && !ctx.sawAssistantOutput
        && !resultText;
      const failed = (obj.subtype && obj.subtype !== "success")
        || providerSettingError.code === "provider_settings_unconfirmed"
        || syntheticNoResponse
        || emptySuccess;
      const error = failed
        ? (syntheticNoResponse
            ? {
                message: "Claude classified this prompt as a meta event and did not run it",
                code: "no_response_requested",
              }
            : emptySuccess
            ? {
                message: "Claude ended without returning a response",
                code: "empty_provider_result",
              }
            : providerSettingError.code === "provider_settings_unconfirmed"
            ? providerSettingError
            : claudeTurnError(obj.result ?? obj.subtype))
        : undefined;

      if (failed && session._rejectTurnAccepted) {
        this.clearAcceptTimer(session);
        session._rejectTurnAccepted(Object.assign(new Error(error.message), {
          status: error.code === THREAD_CONFLICT_CODE ? 409 : 500,
          code: error.code,
        }));
      } else {
        this.clearAcceptTimer(session);
        session._resolveTurnAccepted?.();
      }

      session._resolveTurnAccepted = null;
      session._rejectTurnAccepted = null;
      this.notify(failed ? "turn/failed" : "turn/completed", {
        threadId: tid,
        error,
        turn: { id: ctx.turnId, status: failed ? "failed" : "completed", error },
      });

      // End the turn at the session level so the warm process can accept another.
      session.busy = false;
      session.lastUsed = Date.now();

      if (session._resolveTurnDone) {
        session._resolveTurnDone();
        session._resolveTurnDone = null;
      }

      // Claude 2.1.226 can write a second prompt/answer to the transcript while
      // emitting no second stream/result envelope. Reusing that process would
      // make the phone stay busy forever. Keep it for the active turn (and
      // native steer), then release it; the next explicit send safely resumes.
      this.closeSession(session);

      return;
    }
  }

  handleAnthropicEvent(event, ctx, session) {
    const tid = ctx.emitThreadId;

    switch (event.type) {
      case "message_start": {
        const id = event.message?.id;
        ctx.streamMsgId = id;

        if (!ctx.turnId) {
          ctx.turnId = id || "turn";
          this.notify("turn/started", { threadId: tid, turn: { id: ctx.turnId } });
        }

        session?._resolveTurnAccepted?.();

        if (session) {
          this.clearAcceptTimer(session);
          session._resolveTurnAccepted = null;
          session._rejectTurnAccepted = null;
        }

        ctx.blockKinds = new Map();
        ctx.blockTexts = new Map();
        ctx.completedBlocks = new Set();
        ctx.assistantEnvelopeSeq = 0;
        break;
      }

      case "content_block_start": {
        const kind = event.content_block?.type;
        ctx.blockKinds.set(event.index, kind);
        const initial = kind === "text" ? event.content_block?.text : kind === "thinking" ? event.content_block?.thinking : null;
        if (typeof initial === "string") { ctx.blockTexts.set(event.index, initial); }
        if (["text", "thinking", "tool_use"].includes(kind)) { ctx.sawAssistantOutput = true; }
        break;
      }

      case "content_block_delta": {
        const kind = ctx.blockKinds.get(event.index);
        const itemId = `${ctx.streamMsgId}:${event.index}`;
        const delta = event.delta ?? {};

        if (delta.type === "text_delta" && kind === "text") {
          ctx.blockTexts.set(event.index, (ctx.blockTexts.get(event.index) ?? "") + (delta.text ?? ""));
          this.notify("item/agentMessage/delta", { threadId: tid, itemId, delta: delta.text ?? "" });
        } else if (delta.type === "thinking_delta" && kind === "thinking") {
          ctx.blockTexts.set(event.index, (ctx.blockTexts.get(event.index) ?? "") + (delta.thinking ?? ""));
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
    const envelopeSeq = ctx.assistantEnvelopeSeq++;

    if (content.some((block) => ["text", "thinking", "tool_use"].includes(block?.type))) {
      ctx.sawAssistantOutput = true;
    }

    content.forEach((block, i) => {
      const kind = block?.type;
      const candidates = message.id && message.id === ctx.streamMsgId
        ? [...ctx.blockKinds.entries()].filter(([, candidateKind]) => candidateKind === kind).map(([index]) => index)
        : [];
      const value = kind === "text" ? block.text : kind === "thinking" ? block.thinking : null;
      const exact = typeof value === "string"
        ? candidates.find((index) => ctx.blockTexts.get(index) === value)
        : undefined;
      const unused = candidates.find((index) => !ctx.completedBlocks.has(index));
      const typeOrdinal = content.slice(0, i).filter((candidate) => candidate?.type === kind).length;
      const streamIndex = exact ?? unused ?? candidates[typeOrdinal];
      const itemId = streamIndex != null
        ? `${message.id}:${streamIndex}`
        : `${message.id ?? "assistant"}:assembled:${envelopeSeq}:${i}`;

      if (streamIndex != null) { ctx.completedBlocks.add(streamIndex); }

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
          ctx.toolDescriptions.set(block.id, item.description ?? "");
          this.notify("item/started", { threadId: tid, item });
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
            description: ctx.toolDescriptions.get(block.tool_use_id) ?? "",
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
  async interrupt({ threadId, requireActive = false } = {}) {
    const session = this.sessions.get(threadId);

    if (requireActive && (!session || session.dead || !session.busy)) {
      throw Object.assign(new Error("the active Claude turn is not owned by this bridge"), {
        status: 409,
        code: "not_our_turn",
      });
    }

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
