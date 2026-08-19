// codex-phone — Codex provider.
//
// Spawns `codex app-server` (JSON-RPC over stdio) and bridges it to the
// normalized event/item model. This is the original bridge behavior, moved
// verbatim into a provider class. Codex emits the normalized shapes natively,
// so notifications are passed through unchanged.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { remoteAgentsHome } from "../app-home.mjs";
import * as rollout from "../codex-rollout.mjs";

const PAGE_SIZE = 25;
const DEFAULT_IDLE_RELEASE_MS = 60_000;
const APPROVAL_TIMEOUT_MS = 240_000;

// Which `codex` to talk to.
//
// Every Codex on this machine shares one state directory (~/.codex: sessions,
// auth, model cache), but they are not interchangeable. Codex Desktop ships its
// own build and writes that state in its own format; an older `codex` on PATH
// then fails to parse it and dies during startup — "failed to load models cache:
// missing field `base_instructions`" — taking every RPC down with it, while the
// desktop app carries on working. Observed here: app 0.147.0-alpha.6.5 vs
// Homebrew 0.145.0, with sessions recording the former.
//
// So prefer the binary that is actually writing the sessions we read.
const APP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";
let resolvedBinary = null;

export function codexBinary() {
  if (resolvedBinary) { return resolvedBinary; }

  const configured = readConfig().codexBinary;

  if (configured) {
    resolvedBinary = configured;
  } else if (existsSync(APP_CODEX)) {
    resolvedBinary = APP_CODEX;
  } else {
    resolvedBinary = "codex";
  }

  if (resolvedBinary !== "codex") {
    console.error(`[codex] using ${resolvedBinary}`);
  }

  return resolvedBinary;
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(remoteAgentsHome(), "config.json"), "utf8"));
  } catch {
    return {};
  }
}

import { BaseProvider, makeLineReader } from "./base.mjs";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

const STEER_ERROR_CODES = {
  NoActiveTurn: "no_active_turn",
  ExpectedTurnMismatch: "turn_mismatch",
  ActiveTurnNotSteerable: "not_steerable",
  EmptyInput: "empty_input",
};

export function groupCodexSummaries(summaries, { search = "", offset = 0, limit = PAGE_SIZE } = {}) {
  const q = String(search ?? "").trim().toLowerCase();
  const children = new Map();
  const byId = new Map((summaries ?? []).filter(Boolean).map((summary) => [summary.id, summary]));
  const grouped = new Set();

  for (const summary of summaries ?? []) {
    if (summary?.threadSource !== "subagent" || !summary.parentThreadId) { continue; }
    let parent = byId.get(summary.parentThreadId);
    const visited = new Set([summary.id]);

    while (parent?.threadSource === "subagent" && parent.parentThreadId && !visited.has(parent.id)) {
      visited.add(parent.id);
      parent = byId.get(parent.parentThreadId);
    }

    // A deleted/missing parent must not make a usable child task disappear.
    if (!parent || parent.threadSource === "subagent") { continue; }

    const group = children.get(parent.id) ?? [];
    group.push(summary);
    children.set(parent.id, group);
    grouped.add(summary.id);
  }

  const rows = [];

  for (const summary of summaries ?? []) {
    if (!summary || grouped.has(summary.id)) { continue; }

    const subagents = (children.get(summary.id) ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
    const searchable = [summary.preview, summary.name, summary.cwd]
      .concat(subagents.flatMap((child) => [child.preview, child.name, child.agentNickname, child.agentPath]))
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (!q || searchable.includes(q)) { rows.push({ ...summary, subagents }); }
  }

  const page = rows.slice(offset, offset + limit);
  const nextCursor = rows.length > offset + limit ? String(offset + limit) : null;
  return { data: page, nextCursor };
}

function steerErrorTag(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    return Object.hasOwn(STEER_ERROR_CODES, value) ? value : null;
  }

  if (typeof value !== "object") {
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (Object.hasOwn(STEER_ERROR_CODES, key)) {
      return key;
    }

    const found = steerErrorTag(nested);

    if (found) {
      return found;
    }
  }

  return null;
}

function mapSteerError(error) {
  const tag = steerErrorTag(error?.rpc);

  if (!tag) {
    return error;
  }

  const code = STEER_ERROR_CODES[tag];
  return Object.assign(new Error(error.message), { status: 409, code, rpc: error.rpc });
}

const THREAD_CONFLICT_CODE = "thread_locked_elsewhere";

function hasThreadConflict(value, seen = new Set()) {
  if (typeof value === "string") {
    return /thread(?:-store conflict:)?[^\n]*already has an active writer/i.test(value);
  }

  if (!value || typeof value !== "object" || seen.has(value)) {
    return false;
  }

  seen.add(value);
  return Object.values(value).some((nested) => hasThreadConflict(nested, seen));
}

export function mapThreadConflict(error) {
  if (!hasThreadConflict(error?.message) && !hasThreadConflict(error?.rpc)) {
    return error;
  }

  return Object.assign(new Error("this thread is open on your Mac; close it there to continue"), {
    status: 409,
    code: THREAD_CONFLICT_CODE,
    rpc: error?.rpc,
  });
}

export function sandboxPolicyFor(name) {
  if (name && typeof name === "object") { return name; }
  switch (name) {
    case "read-only": return { type: "readOnly" };
    case "disabled":
    case "danger-full-access": return { type: "dangerFullAccess" };
    case "workspace-write":
    default: return { type: "workspaceWrite" };
  }
}

export function codexUserInput(text, attachments = []) {
  const input = [];

  if (String(text ?? "").trim()) { input.push({ type: "text", text: String(text) }); }

  for (const attachment of attachments) {
    input.push({ type: "localImage", path: attachment.path });
  }

  return input;
}

export class CodexProvider extends BaseProvider {
  constructor(emit, { idleReleaseMs = DEFAULT_IDLE_RELEASE_MS, rpcTimeoutMs = 180_000 } = {}) {
    super(emit, "codex");

    this.child = null;
    this.rpcId = 0;
    this.pendingRequests = new Map(); // our request id -> {resolve, reject}
    this.pendingApprovals = new Map(); // UI request id -> {method, params, rpcId, client}
    this.resumedThreads = new Set();
    this.conflictedThreads = new Set(); // only an observed writer conflict puts a thread here
    this.threadClients = new Map(); // one app-server process per held writer lease
    this.activeTurns = new Map(); // thread id -> turn id owned by our holder process
    this.startingTurns = new Set(); // closes the gap between turn/start and turn/started
    this.finishedStartingTurns = new Set(); // terminal notification beat turn/start RPC response
    this.releasingThreads = new Map(); // thread id -> release promise; sends await it
    this.idleReleaseMs = idleReleaseMs;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.idleReleaseTimers = new Map();
    this.clientSequence = 0;
    this.initializePromise = null;
    this.cache = { models: null, account: null };
    this.feed = null;
  }

  async init() {
    this.startChild();
  }

  handleChildLine(line) {
    let msg;

    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pendingRequests.get(msg.id);

      if (p) {
        this.pendingRequests.delete(msg.id);
        msg.error ? p.reject(Object.assign(new Error(msg.error.message || "rpc error"), { rpc: msg.error })) : p.resolve(msg.result);
      }

      return;
    }

    // Server -> client request (approvals, tool input, auth refresh)
    if (msg.id !== undefined && msg.method) {
      if (APPROVAL_METHODS.has(msg.method)) {
        this.rememberApproval(msg, { child: this.child, key: "control" });
      } else {
        this.respondToServer(msg.id, null, { code: -32601, message: `codex-phone cannot handle ${msg.method}` });
      }

      return;
    }

    this.handleNotification(msg);
  }

  rememberApproval(msg, client) {
    const requestId = `${client.key}:${msg.id}`;
    const threadId = msg.params?.threadId ?? msg.params?.conversationId ?? client.threadId;
    const params = threadId && !msg.params?.threadId ? { ...msg.params, threadId } : msg.params;

    if (!threadId) {
      console.warn(`[codex] approval ${msg.method} has no thread identifier; it will remain hidden and auto-deny safely`);
    }

    const timer = setTimeout(() => {
      if (!this.pendingApprovals.has(requestId)) { return; }

      try { this.respondApproval({ requestId, decision: "deny" }); } catch {}
      this.notify("approval/expired", { requestId, threadId });
    }, APPROVAL_TIMEOUT_MS);
    timer.unref?.();
    this.pendingApprovals.set(requestId, { method: msg.method, params, rpcId: msg.id, client, timer });
    this.emit("approval", { requestId, method: msg.method, params });
  }

  handleNotification(msg) {
    if (!msg.method) { return; }

    if (msg.method === "account/rateLimits/updated" && this.cache.account) {
      this.cache.account.rateLimits = msg.params?.rateLimits ?? this.cache.account.rateLimits;
    }

    const threadId = msg.params?.threadId;
    const turnId = msg.params?.turn?.id ?? msg.params?.turnId;

    if (msg.method === "turn/started" && threadId) {
      this.cancelIdleRelease(threadId);
      // Some protocol versions omit the id here. Unknown is still active: the
      // safety invariant is never to release merely because optional metadata
      // was absent.
      this.activeTurns.set(threadId, turnId || this.activeTurns.get(threadId) || "__unknown__");
    } else if ((msg.method === "turn/completed" || msg.method === "turn/failed" || msg.method === "turn/aborted") && threadId) {
      if (this.startingTurns.has(threadId)) { this.finishedStartingTurns.add(threadId); }
      this.activeTurns.delete(threadId);
      this.scheduleIdleRelease(threadId);
    }

    this.notify(msg.method, msg.params ?? {});
  }

  respondToServer(id, result, error) {
    const payload = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result };

    this.child?.stdin.write(JSON.stringify(payload) + "\n");
  }

  startChild() {
    this.child = spawn(codexBinary(), ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.feed = makeLineReader((line) => this.handleChildLine(line));

    // A missing/unlaunchable `codex` must not crash the bridge (Claude may still
    // work). Mark unavailable and stop respawning until the process is restarted.
    this.child.on("error", (e) => {
      this.unavailable = e.code === "ENOENT"
        ? "The `codex` CLI was not found on PATH. Install it and restart codex-phone."
        : `codex failed to start: ${e.message}`;
      console.error(`[codex] ${this.unavailable}`);

      for (const [, p] of this.pendingRequests) {
        p.reject(new Error(this.unavailable));
      }

      this.pendingRequests.clear();
      this.initializePromise = null;
    });

    this.child.stdout.on("data", (d) => {
      this.feed(d);
    });

    this.child.stderr.on("data", (d) => {
      process.stderr.write(`[codex] ${d}`);
    });

    this.child.on("exit", (code) => {
      // Don't hot-loop respawning a binary that isn't there.
      if (this.unavailable) {
        return;
      }

      console.error(`codex app-server exited (${code}); restarting in 1s`);

      for (const [, p] of this.pendingRequests) {
        p.reject(new Error("codex app-server exited"));
      }

      this.pendingRequests.clear();

      for (const [id, approval] of this.pendingApprovals) {
        if (approval.client?.key === "control") {
          clearTimeout(approval.timer);
          this.pendingApprovals.delete(id);
        }
      }

      this.cache.models = null;
      this.cache.account = null;
      this.initializePromise = null;
      this.emit("bridge", { state: "restarting" });
      setTimeout(() => this.startChild(), 1000);
    });

    this.initializePromise = this.rpc("initialize", {
      clientInfo: { name: "codex-phone", title: "Codex Phone", version: "0.2.0" },
    }).then((res) => {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
      this.emit("bridge", { state: "ready" });
      return res;
    });
  }

  rpc(method, params) {
    const id = ++this.rpcId;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          const uncertain = method === "turn/start" || method === "turn/steer";
          reject(Object.assign(new Error(`rpc timeout: ${method}`), uncertain
            ? { status: 504, code: "delivery_uncertain" }
            : {}));
        }
      }, this.rpcTimeoutMs);
    });
  }

  async ready() {
    if (!this.initializePromise) {
      throw new Error("codex app-server not running");
    }

    await this.initializePromise;
  }

  startThreadClient(threadId = null) {
    const child = spawn(codexBinary(), ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    const client = {
      child,
      threadId,
      key: `thread-${++this.clientSequence}`,
      rpcId: 0,
      pending: new Map(),
      intentionalExit: false,
      resumePromise: null,
    };
    const feed = makeLineReader((line) => {
      let msg;

      try { msg = JSON.parse(line); } catch { return; }

      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const pending = client.pending.get(msg.id);

        if (pending) {
          client.pending.delete(msg.id);
          clearTimeout(pending.timer);
          msg.error
            ? pending.reject(Object.assign(new Error(msg.error.message || "rpc error"), { rpc: msg.error }))
            : pending.resolve(msg.result);
        }

        return;
      }

      if (msg.id !== undefined && msg.method) {
        if (APPROVAL_METHODS.has(msg.method)) {
          this.rememberApproval(msg, client);
        } else {
          this.respondToClient(client, msg.id, null, { code: -32601, message: `codex-phone cannot handle ${msg.method}` });
        }

        return;
      }

      this.handleNotification(msg);
    });

    child.stdout.on("data", (data) => feed(data));
    child.stderr.on("data", (data) => process.stderr.write(`[codex:${client.threadId || "new"}] ${data}`));
    child.on("error", (error) => {
      for (const [, pending] of client.pending) { clearTimeout(pending.timer); pending.reject(error); }
      client.pending.clear();
    });
    child.on("exit", (code) => {
      for (const [, pending] of client.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`codex thread app-server exited (${code})`));
      }
      client.pending.clear();

      for (const [id, approval] of this.pendingApprovals) {
        if (approval.client === client) {
          clearTimeout(approval.timer);
          this.pendingApprovals.delete(id);
        }
      }

      const id = client.threadId;

      if (id && this.threadClients.get(id) === client) {
        this.cancelIdleRelease(id);
        const wasHeld = this.resumedThreads.delete(id);
        this.threadClients.delete(id);
        this.startingTurns.delete(id);

        if (this.activeTurns.delete(id)) {
          this.notify("turn/failed", { threadId: id, error: { message: "thread app-server exited" } });
        }

        if (wasHeld) { this.emit("lock", { threadId: id, state: "free" }); }
      }

      if (!client.intentionalExit) {
        console.error(`codex thread app-server exited (${code})${id ? ` for ${id}` : ""}`);
      }
    });

    client.ready = this.clientRpc(client, "initialize", {
      clientInfo: { name: "codex-phone-thread", title: "Codex Phone", version: "0.2.0" },
    }).then((result) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
      return result;
    });
    return client;
  }

  clientRpc(client, method, params) {
    const id = ++client.rpcId;
    client.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (client.pending.has(id)) {
          client.pending.delete(id);
          const uncertain = method === "turn/start" || method === "turn/steer";
          reject(Object.assign(new Error(`rpc timeout: ${method}`), uncertain
            ? { status: 504, code: "delivery_uncertain" }
            : {}));
        }
      }, this.rpcTimeoutMs);
      client.pending.set(id, { resolve, reject, timer });
    });
  }

  respondToClient(client, id, result, error) {
    const payload = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result };
    client.child?.stdin.write(JSON.stringify(payload) + "\n");
  }

  async stopThreadClient(client) {
    if (!client || client.child.exitCode != null || client.child.signalCode != null) { return; }

    client.intentionalExit = true;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) { return; }

        done = true;
        resolve();
      };
      const hardStop = setTimeout(() => {
        client.child.kill("SIGKILL");
        // A broken child implementation or missed exit event must not leave an
        // HTTP release request hanging forever.
        setTimeout(finish, 1000).unref?.();
      }, 2000);

      client.child.once("exit", () => {
        clearTimeout(hardStop);
        finish();
      });
      client.child.kill("SIGTERM");
    });
  }

  cancelIdleRelease(threadId) {
    const timer = this.idleReleaseTimers.get(threadId);

    if (timer) { clearTimeout(timer); }

    this.idleReleaseTimers.delete(threadId);
  }

  scheduleIdleRelease(threadId) {
    if (!threadId || !this.resumedThreads.has(threadId)) { return; }

    this.cancelIdleRelease(threadId);
    const timer = setTimeout(async () => {
      this.idleReleaseTimers.delete(threadId);

      try {
        await this.releaseThread({ threadId, reason: "idle" });
      } catch (error) {
        // A completion notification and the provider's active map can cross in
        // flight. If it is still working, retry later; never force the holder.
        if (error?.code === "turn_in_progress") {
          this.scheduleIdleRelease(threadId);
        } else {
          console.error(`[codex:${threadId}] idle release failed:`, error);
        }
      }
    }, this.idleReleaseMs);
    timer.unref?.();
    this.idleReleaseTimers.set(threadId, timer);
  }

  // Resume a thread, applying the permission mode at the SESSION level (as the
  // official Codex client does), not only per-turn. `sandbox` here is the
  // SandboxMode string ("read-only" | "workspace-write" | "danger-full-access"),
  // which is what thread/resume expects (turn/start takes a sandboxPolicy object).
  async ensureResumed(threadId, { approvalPolicy, sandbox, requestId } = {}) {
    this.cancelIdleRelease(threadId);

    // A release kills the holder process asynchronously. Treat it as a lease
    // state, not as an implementation detail: a send arriving in this window
    // waits, then creates a fresh holder instead of writing into a dying child.
    const releasing = this.releasingThreads.get(threadId);

    if (releasing) { await releasing; }

    if (this.resumedThreads.has(threadId)) {
      return false;
    }

    let client = this.threadClients.get(threadId);

    if (client?.resumePromise) {
      try {
        await client.resumePromise;
      } catch (error) {
        throw mapThreadConflict(error);
      }

      return false;
    }

    client = this.startThreadClient(threadId);
    this.threadClients.set(threadId, client);

    const params = { threadId };
    const rolloutBytes = rollout.rolloutSize(threadId);

    if (approvalPolicy) {
      params.approvalPolicy = approvalPolicy;
    }

    if (sandbox) {
      params.sandbox = sandbox;
    }

    if (requestId) {
      this.emit("send-stage", { threadId, requestId, stage: "resuming", cold: true, rolloutBytes });
    }

    client.resumePromise = (async () => {
      await client.ready;
      return this.clientRpc(client, "thread/resume", params);
    })();

    try {
      await client.resumePromise;
    } catch (e) {
      const mapped = mapThreadConflict(e);

      await this.stopThreadClient(client);
      this.threadClients.delete(threadId);

      if (mapped.code === THREAD_CONFLICT_CODE) {
        this.conflictedThreads.add(threadId);
        this.emit("lock", { threadId, state: "elsewhere" });
      }

      throw mapped;
    }

    client.resumePromise = null;
    this.resumedThreads.add(threadId);
    this.conflictedThreads.delete(threadId);
    this.emit("lock", { threadId, state: "held" });
    return true;
  }

  lockStatus(threadId) {
    if (!threadId) {
      throw Object.assign(new Error("threadId required"), { status: 400 });
    }

    if (this.resumedThreads.has(threadId)) {
      return { threadId, state: "held", label: "You have it" };
    }

    if (this.conflictedThreads.has(threadId)) {
      return { threadId, state: "elsewhere", label: "Open elsewhere", code: THREAD_CONFLICT_CODE, holder: "your Mac" };
    }

    // This means only "no holder known": app-server cannot see leases held by
    // Desktop or VS Code until one of our own resume attempts is refused.
    return { threadId, state: "free", label: "Not held here" };
  }

  async warmThread({ threadId, approvalPolicy, sandbox } = {}) {
    await this.ensureResumed(threadId, { approvalPolicy, sandbox });
    this.scheduleIdleRelease(threadId);
    return this.lockStatus(threadId);
  }

  async releaseThread({ threadId } = {}) {
    this.cancelIdleRelease(threadId);

    const existingRelease = this.releasingThreads.get(threadId);

    if (existingRelease) { return existingRelease; }

    if (this.activeTurns.has(threadId) || this.startingTurns.has(threadId)) {
      throw Object.assign(new Error("the thread is working; wait for the turn to finish before releasing it"), {
        status: 409,
        code: "turn_in_progress",
      });
    }

    if (!this.resumedThreads.has(threadId)) {
      return this.lockStatus(threadId);
    }

    // The installed protocol's `thread/unsubscribe` stops notifications but
    // keeps the writer lease, and it rejects `thread/close`. A dedicated holder
    // process makes the only guaranteed release mechanism (holder exit) local
    // to this thread instead of dropping every warm thread in the bridge.
    const client = this.threadClients.get(threadId);

    if (!client) {
      throw Object.assign(new Error("the thread holder process is missing; the bridge cannot confirm release"), { status: 500 });
    }

    const release = (async () => {
      await this.stopThreadClient(client);
      this.threadClients.delete(threadId);
      this.resumedThreads.delete(threadId);
      this.conflictedThreads.delete(threadId);
      return { ...this.lockStatus(threadId), releaseMethod: "holder_process_exit" };
    })();
    this.releasingThreads.set(threadId, release);

    try {
      return await release;
    } finally {
      if (this.releasingThreads.get(threadId) === release) {
        this.releasingThreads.delete(threadId);
      }
    }
  }

  // Reading comes from the rollout logs, not app-server. Listing and reading a
  // transcript need no auth, no model cache and no MCP servers, but app-server
  // needs all three to start — so routing reads through it made the whole app
  // hang whenever one of them stalled. See codex-rollout.mjs.
  async listThreads({ search, cursor } = {}) {
    const offset = Number(cursor) || 0;
    const summaries = rollout.listRolloutFiles().map((file) => rollout.summarize(file)).filter(Boolean);
    return groupCodexSummaries(summaries, { search, offset });
  }

  async readThread(id) {
    const path = rollout.findRollout(id);

    if (!path) {
      throw Object.assign(new Error("thread not found"), { status: 404 });
    }

    // Deliberately no prewarm here. Resuming a thread makes app-server replay
    // its history as live notifications, which the app renders on top of the
    // transcript it has just drawn — the same duplicate-message bug Grok has a
    // guard for. Opening a thread is now purely a file read; the resume happens
    // on the first send, which is the only thing that needs it.
    return rollout.readRollout(path);
  }

  async models() {
    await this.ready();

    if (!this.cache.models) {
      this.cache.models = await this.rpc("model/list", {});
    }

    return this.cache.models;
  }

  async usage({ refresh } = {}) {
    await this.ready();

    if (!this.cache.account || refresh) {
      const [account, rateLimits, usage] = await Promise.allSettled([
        this.rpc("account/read", {}),
        this.rpc("account/rateLimits/read", {}),
        this.rpc("account/usage/read", {}),
      ]);

      this.cache.account = {
        account: account.status === "fulfilled" ? account.value.account : null,
        rateLimits: rateLimits.status === "fulfilled" ? rateLimits.value : null,
        usage: usage.status === "fulfilled" ? usage.value : null,
      };
    }

    return this.cache.account;
  }

  async projects() {
    await this.ready();
    const list = await this.rpc("thread/list", { limit: 100 });
    const byCwd = new Map();

    for (const t of list.data ?? []) {
      if (!t.cwd) {
        continue;
      }

      const cur = byCwd.get(t.cwd) ?? { path: t.cwd, name: basename(t.cwd), count: 0, lastUsed: 0, branch: t.gitInfo?.branch ?? null };
      cur.count += 1;
      cur.lastUsed = Math.max(cur.lastUsed, t.updatedAt ?? 0);
      byCwd.set(t.cwd, cur);
    }

    const projects = [...byCwd.values()].sort((a, b) => b.lastUsed - a.lastUsed);
    return { projects };
  }

  async newThread({ cwd, model } = {}) {
    if (!cwd) {
      throw Object.assign(new Error("cwd required"), { status: 400 });
    }

    const params = { cwd };

    if (model) {
      params.model = model;
    }

    const client = this.startThreadClient();
    let result;

    try {
      await client.ready;
      result = await this.clientRpc(client, "thread/start", params);
    } catch (error) {
      await this.stopThreadClient(client);
      throw error;
    }

    const threadId = result.thread?.id ?? result.threadId ?? result.id;

    if (!threadId) {
      await this.stopThreadClient(client);
      throw Object.assign(new Error("Codex started a thread without returning its id"), { status: 502, code: "invalid_provider_response" });
    }

    client.threadId = threadId;
    this.threadClients.set(threadId, client);
    this.resumedThreads.add(threadId);
    this.conflictedThreads.delete(threadId);
    this.emit("lock", { threadId, state: "held" });
    this.scheduleIdleRelease(threadId);
    return result;
  }

  async send(body = {}) {
    const {
      threadId, text, attachments = [], model, effort, approvalPolicy, sandbox,
      preserveProviderPolicy = false, summary, requestId,
    } = body;

    if (!threadId || (!String(text ?? "").trim() && !attachments.length)) {
      throw Object.assign(new Error("threadId and message content required"), { status: 400 });
    }

    if (this.activeTurns.has(threadId) || this.startingTurns.has(threadId)) {
      throw Object.assign(new Error("a turn is already in progress"), { status: 409, code: "turn_in_progress" });
    }

    // Claim before the potentially slow resume so two phones cannot both pass
    // the idle check and start parallel turns.
    this.startingTurns.add(threadId);

    let cold;

    try {
      cold = await this.ensureResumed(threadId, {
        approvalPolicy: preserveProviderPolicy ? undefined : approvalPolicy,
        sandbox: preserveProviderPolicy ? undefined : sandbox,
        requestId,
      });
    } catch (error) {
      this.startingTurns.delete(threadId);
      this.finishedStartingTurns.delete(threadId);
      throw error;
    }

    if (requestId) {
      this.emit("send-stage", { threadId, requestId, stage: "resumed", cold });
      this.emit("send-stage", { threadId, requestId, stage: "starting_turn" });
    }

    const params = { threadId, input: codexUserInput(text, attachments) };

    if (model) {
      params.model = model;
    }

    if (effort) {
      params.effort = effort;
    }

    if (summary) {
      params.summary = summary;
    }

    if (approvalPolicy && !preserveProviderPolicy) {
      params.approvalPolicy = approvalPolicy;
    }

    if (sandbox && !preserveProviderPolicy) {
      params.sandboxPolicy = sandboxPolicyFor(sandbox);
    }

    const client = this.threadClients.get(threadId);
    let result;
    try {
      result = await this.clientRpc(client, "turn/start", params);
    } catch (e) {
      const mapped = mapThreadConflict(e);

      if (mapped.code === THREAD_CONFLICT_CODE) {
        await this.stopThreadClient(client);
        this.threadClients.delete(threadId);
        this.resumedThreads.delete(threadId);
        this.conflictedThreads.add(threadId);
        this.emit("lock", { threadId, state: "elsewhere" });
      } else if (this.resumedThreads.has(threadId)) {
        this.scheduleIdleRelease(threadId);
      }

      this.startingTurns.delete(threadId);
      this.finishedStartingTurns.delete(threadId);
      throw mapped;
    }

    const turnId = result?.turn?.id ?? result?.turnId;
    const alreadyFinished = this.finishedStartingTurns.delete(threadId);
    this.startingTurns.delete(threadId);

    // A successful turn/start is authoritative even when this protocol build
    // omits the id. Completion/failed/aborted will clear the sentinel.
    if (!alreadyFinished) { this.activeTurns.set(threadId, turnId || "__unknown__"); }

    if (requestId) {
      this.emit("send-stage", { threadId, requestId, stage: "turn_started", turnId: turnId ?? null });
    }

    return result;
  }

  async steer({ threadId, text, attachments = [], expectedTurnId } = {}) {
    if (!String(text ?? "").trim() && !attachments.length) {
      throw Object.assign(new Error("message content required"), { status: 409, code: "empty_input" });
    }

    const activeTurnId = this.activeTurns.get(threadId);

    if (!activeTurnId) {
      const code = expectedTurnId ? "not_our_turn" : "no_active_turn";
      const message = expectedTurnId ? "the active turn is not owned by this bridge" : "no active turn";
      throw Object.assign(new Error(message), { status: 409, code });
    }

    const expected = expectedTurnId ?? activeTurnId;

    try {
      const client = this.threadClients.get(threadId);
      return await this.clientRpc(client, "turn/steer", {
        threadId,
        input: codexUserInput(text, attachments),
        expectedTurnId: expected,
      });
    } catch (e) {
      throw mapSteerError(e);
    }
  }

  async interrupt({ threadId, turnId } = {}) {
    const client = this.threadClients.get(threadId);

    if (!client) {
      throw Object.assign(new Error("the active turn is not owned by this bridge"), { status: 409, code: "not_our_turn" });
    }

    return this.clientRpc(client, "turn/interrupt", { threadId, turnId });
  }

  async rename({ threadId, name } = {}) {
    await this.ensureResumed(threadId);

    try {
      return await this.clientRpc(this.threadClients.get(threadId), "thread/name/set", { threadId, name });
    } finally {
      if (!this.activeTurns.has(threadId) && !this.startingTurns.has(threadId)) {
        this.scheduleIdleRelease(threadId);
      }
    }
  }

  async archive({ threadId } = {}) {
    await this.ready();
    return this.rpc("thread/archive", { threadId });
  }

  respondApproval({ requestId, decision } = {}) {
    const pending = this.pendingApprovals.get(String(requestId));

    if (!pending) {
      throw Object.assign(new Error("no such pending approval"), { status: 404 });
    }

    this.pendingApprovals.delete(String(requestId));
    clearTimeout(pending.timer);

    const legacy = pending.method === "execCommandApproval" || pending.method === "applyPatchApproval";
    // decision from UI: "approve" | "session" | "deny"
    let value;

    if (legacy) {
      value = decision === "deny" ? "denied" : "approved";
    } else {
      value = decision === "deny" ? "reject" : decision === "session" ? "acceptForSession" : "accept";
    }

    this.respondToClient(pending.client, pending.rpcId, { decision: value });
    return { ok: true };
  }

  pendingApprovalsList() {
    return [...this.pendingApprovals.entries()].map(([requestId, pending]) => ({
      requestId,
      method: pending.method,
      params: pending.params,
    }));
  }
}

export default CodexProvider;
