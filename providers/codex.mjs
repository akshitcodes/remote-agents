// codex-phone — Codex provider.
//
// Spawns `codex app-server` (JSON-RPC over stdio) and bridges it to the
// normalized event/item model. This is the original bridge behavior, moved
// verbatim into a provider class. Codex emits the normalized shapes natively,
// so notifications are passed through unchanged.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

import * as rollout from "../codex-rollout.mjs";
import { remoteAgentsHome } from "../app-home.mjs";
import { CodexThreadAccounts, SHARED_PROFILE_ID } from "../codex-profiles.mjs";
import { readConfig } from "../config.mjs";
import { augmentedPath, codexAppBinary, findBinary } from "../provider-detect.mjs";

const PAGE_SIZE = 25;
const DEFAULT_IDLE_RELEASE_MS = 60_000;
const PROFILE_CLIENT_IDLE_MS = 5 * 60_000;
const PROFILE_START_TIMEOUT_MS = 30_000;
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
let resolvedBinary = null;

export function codexBinary() {
  if (resolvedBinary) { return resolvedBinary; }

  const configured = readConfig().codexBinary;

  // A bare name is not enough: launchd starts services with a minimal PATH, so
  // the binary an interactive shell finds must be resolved to an absolute path.
  if (configured && existsSync(configured)) {
    resolvedBinary = configured;
  } else {
    resolvedBinary = findBinary("codex", [codexAppBinary()]) ?? "codex";
  }

  console.error(`[codex] using ${resolvedBinary}`);

  return resolvedBinary;
}

import { BaseProvider, makeLineReader } from "./base.mjs";
import { CodexAccountObserver } from "../codex-account.mjs";

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

function rpcTransportError(error, method) {
  const uncertain = method === "turn/start" || method === "turn/steer";
  return Object.assign(new Error(`codex app-server write failed: ${error?.message ?? error}`), uncertain
    ? { status: 504, code: "delivery_uncertain" }
    : { status: 503, code: "provider_unavailable" });
}

function bareTurnId(value) {
  return String(value ?? "").trim().replace(/^codex:/, "");
}

function isNativeUsageLimitTurn(turn) {
  if (turn?.status !== "failed") { return false; }
  const code = String(turn?.error?.codexErrorInfo ?? turn?.error?.codex_error_info ?? "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
  return code === "usagelimitexceeded";
}

function writeJsonLine(stream, payload, { label = "codex app-server", onError = null } = {}) {
  const fail = (error) => {
    if (onError) { onError(error); }
    else if (error?.code !== "EPIPE") { console.error(`[codex] ${label} write failed:`, error); }
  };

  if (!stream || stream.destroyed || stream.writableEnded) {
    fail(Object.assign(new Error(`${label} is not writable`), { code: "EPIPE" }));
    return false;
  }

  try {
    stream.write(JSON.stringify(payload) + "\n", (error) => {
      if (error) { fail(error); }
    });
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}

function observeStdinErrors(child, label) {
  // A child can exit between the liveness check and stream.write(). Without an
  // error listener, Node promotes that ordinary EPIPE race into an uncaught
  // exception and kills the entire bridge.
  child.stdin?.on("error", (error) => {
    if (error?.code !== "EPIPE") { console.error(`[codex] ${label} stdin failed:`, error); }
  });
}

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

  const page = limit == null ? rows.slice(offset) : rows.slice(offset, offset + limit);
  const nextCursor = limit != null && rows.length > offset + limit ? String(offset + limit) : null;
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
  constructor(emit, {
    idleReleaseMs = DEFAULT_IDLE_RELEASE_MS,
    rpcTimeoutMs = 180_000,
    accountObserver = null,
    accountPollMs = 1000,
    accountReleaseGraceMs = 1000,
    accountProfiles = null,
    profileStartTimeoutMs = PROFILE_START_TIMEOUT_MS,
  } = {}) {
    super(emit, "codex");

    this.child = null;
    this.rpcId = 0;
    this.pendingRequests = new Map(); // our request id -> {resolve, reject}
    this.pendingApprovals = new Map(); // UI request id -> {method, params, rpcId, client}
    this.resumedThreads = new Set();
    this.conflictedThreads = new Set(); // only an observed writer conflict puts a thread here
    this.threadClients = new Map(); // one app-server process per held writer lease
    this.profileClients = new Map(); // one short-lived control process per explicitly pinned account
    this.activeTurns = new Map(); // thread id -> turn id owned by our holder process
    this.queueRequests = new Map(); // native queue additions deduplicated within this bridge process
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
    this.accountGeneration = 0;
    this.accountReleaseGraceMs = accountReleaseGraceMs;
    this.pendingAccountChange = null;
    this.accountProfiles = accountProfiles ?? new CodexThreadAccounts({ appHome: remoteAgentsHome() });
    this.profileStartTimeoutMs = profileStartTimeoutMs;
    this.accountObserver = accountObserver ?? new CodexAccountObserver({
      intervalMs: accountPollMs,
      onChange: (change) => this.handleAccountIdentityChange(change),
    });
  }

  async init() {
    this.accountObserver.start();
    this.startChild();
  }

  handleChildLine(line, source = this.child) {
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
        clearTimeout(p.timer);
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

    this.handleNotification(msg, source);
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

  handleNotification(msg, source = null) {
    if (!msg.method) { return; }

    // Managed per-thread processes must never replace the shared account usage
    // shown in the top-level Usage sheet. Their limits are read explicitly for
    // that thread's auto-resume checks instead.
    if (msg.method === "account/rateLimits/updated" && source?.profileId && source.profileId !== SHARED_PROFILE_ID) {
      return;
    }

    // A turn already running during an account switch is allowed to finish,
    // but its usage belongs to the previous account and must not repopulate the
    // new account's freshly-cleared usage state.
    if (msg.method === "account/rateLimits/updated"
        && source?.accountGeneration != null
        && source.accountGeneration !== this.accountGeneration) {
      return;
    }

    if (msg.method === "account/rateLimits/updated" && this.cache.account) {
      this.cache.account.rateLimits = msg.params?.rateLimits ?? this.cache.account.rateLimits;
    }

    const threadId = msg.params?.threadId;
    const turnId = msg.params?.turn?.id ?? msg.params?.turnId;
    const threadClient = threadId && source?.threadId === threadId ? source : null;

    if (msg.method === "turn/started" && threadId) {
      this.cancelIdleRelease(threadId);
      // Some protocol versions omit the id here. Unknown is still active: the
      // safety invariant is never to release merely because optional metadata
      // was absent.
      this.activeTurns.set(threadId, turnId || this.activeTurns.get(threadId) || "__unknown__");
      if (threadClient) {
        threadClient.latestTurnState = { id: turnId ?? null, status: "inProgress" };
      }
    } else if ((msg.method === "turn/completed" || msg.method === "turn/failed" || msg.method === "turn/aborted") && threadId) {
      if (this.startingTurns.has(threadId)) { this.finishedStartingTurns.add(threadId); }
      this.activeTurns.delete(threadId);
      if (threadClient) {
        threadClient.latestTurnState = {
          id: turnId ?? threadClient.latestTurnState?.id ?? null,
          status: msg.method === "turn/aborted"
            ? "interrupted"
            : msg.method === "turn/failed" ? "failed" : "completed",
          error: msg.params?.turn?.error ?? msg.params?.error ?? null,
        };
      }
      const client = this.threadClients.get(threadId);
      if (this.clientUsesSharedAccount(client)
          && client?.accountGeneration != null
          && client.accountGeneration !== this.accountGeneration) {
        // Give a provider-native queued turn time to announce its start. That
        // notification cancels this timer, so an account switch can never race
        // a queued continuation by killing its holder between turns.
        this.scheduleIdleRelease(threadId, this.accountReleaseGraceMs);
      } else {
        this.scheduleIdleRelease(threadId);
      }
    }

    this.notify(msg.method, msg.params ?? {});
  }

  respondToServer(id, result, error) {
    const payload = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result };

    writeJsonLine(this.child?.stdin, payload, { label: "control response" });
  }

  startChild() {
    const child = spawn(codexBinary(), ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: augmentedPath() } });
    child.accountGeneration = this.accountGeneration;
    this.child = child;
    this.feed = makeLineReader((line) => this.handleChildLine(line, child));
    observeStdinErrors(child, "control app-server");

    // A missing/unlaunchable `codex` must not crash the bridge (Claude may still
    // work). Mark unavailable and stop respawning until the process is restarted.
    child.on("error", (e) => {
      this.unavailable = e.code === "ENOENT"
        ? "The `codex` CLI was not found on PATH. Install it and restart codex-phone."
        : `codex failed to start: ${e.message}`;
      console.error(`[codex] ${this.unavailable}`);

      for (const [, p] of this.pendingRequests) {
        clearTimeout(p.timer);
        p.reject(new Error(this.unavailable));
      }

      this.pendingRequests.clear();
      this.initializePromise = null;
    });

    child.stdout.on("data", (d) => {
      this.feed(d);
    });

    child.stderr.on("data", (d) => {
      process.stderr.write(`[codex] ${d}`);
    });

    child.on("exit", (code) => {
      // Don't hot-loop respawning a binary that isn't there.
      if (this.unavailable) {
        return;
      }

      console.error(`codex app-server exited (${code}); restarting in 1s`);

      for (const [, p] of this.pendingRequests) {
        clearTimeout(p.timer);
        const uncertain = p.method === "turn/start" || p.method === "turn/steer";
        p.reject(Object.assign(new Error("codex app-server exited"), uncertain
          ? { status: 504, code: "delivery_uncertain" }
          : {}));
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
      if (this.child === child) { this.child = null; }
      this.emit("bridge", { state: "restarting" });
      setTimeout(() => {
        if (!this.child && !this.unavailable) { this.startChild(); }
      }, 1000);
    });

    this.initializePromise = this.rpc("initialize", {
      clientInfo: { name: "codex-phone", title: "Codex Phone", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    }).then((res) => {
      writeJsonLine(child.stdin, { jsonrpc: "2.0", method: "initialized", params: {} }, { label: "control initialized" });
      this.emit("bridge", { state: "ready" });
      return res;
    });
    this.initializePromise.then(() => this.confirmAccountChange(child)).catch(() => {});
  }

  handleAccountIdentityChange({ previous, current }) {
    this.accountGeneration += 1;
    this.pendingAccountChange = { previous, current, generation: this.accountGeneration };
    this.cache.models = null;
    this.cache.account = null;
    this.notify("account/changing", {
      generation: this.accountGeneration,
      previous: previous ? { accountId: previous.accountId, userId: previous.userId, email: previous.email } : null,
      current: { accountId: current.accountId, userId: current.userId, email: current.email },
    });

    const child = this.child;
    if (child && child.exitCode == null && child.signalCode == null && child.accountGeneration !== this.accountGeneration) {
      child.kill("SIGTERM");
    } else if (!child) {
      this.startChild();
    }
  }

  clientUsesSharedAccount(client) {
    return !client?.profileId || client.profileId === SHARED_PROFILE_ID;
  }

  async confirmAccountChange(child) {
    const change = this.pendingAccountChange;
    if (!change || child !== this.child || child.accountGeneration !== change.generation) { return; }

    try {
      const snapshot = await this.usage({ refresh: true });
      if (this.pendingAccountChange?.generation !== change.generation || child !== this.child) { return; }
      const expectedEmail = String(change.current.email ?? "").trim().toLowerCase();
      const actualEmail = String(snapshot.account?.email ?? "").trim().toLowerCase();
      if (expectedEmail && actualEmail !== expectedEmail) {
        console.error("[codex] fresh app-server did not confirm the selected account; retrying safely");
        if (child.exitCode == null && child.signalCode == null) { child.kill("SIGTERM"); }
        return;
      }
      this.pendingAccountChange = null;
      this.notify("account/changed", {
        generation: change.generation,
        previous: change.previous ? { accountId: change.previous.accountId, userId: change.previous.userId, email: change.previous.email } : null,
        current: { accountId: change.current.accountId, userId: change.current.userId, email: change.current.email },
        account: snapshot.account ?? null,
        rateLimits: snapshot.rateLimits ?? null,
      });
    } catch (error) {
      console.error("[codex] could not confirm switched account:", error);
    }
  }

  rpc(method, params) {
    const id = ++this.rpcId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          const uncertain = method === "turn/start" || method === "turn/steer";
          reject(Object.assign(new Error(`rpc timeout: ${method}`), uncertain
            ? { status: 504, code: "delivery_uncertain" }
            : {}));
        }
      }, this.rpcTimeoutMs);
      const rejectWrite = (error) => {
        const pending = this.pendingRequests.get(id);
        if (!pending) { return; }
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(rpcTransportError(error, method));
      };
      this.pendingRequests.set(id, { resolve, reject, method, timer });
      writeJsonLine(this.child?.stdin, { jsonrpc: "2.0", id, method, params }, {
        label: `control ${method}`,
        onError: rejectWrite,
      });
    });
  }

  async ready() {
    if (!this.initializePromise) {
      throw new Error("codex app-server not running");
    }

    await this.initializePromise;
  }

  startThreadClient(threadId = null, accountContext = null, { profileControl = false } = {}) {
    const context = accountContext ?? (threadId
      ? this.accountProfiles.contextForThread(threadId)
      : this.accountProfiles.contextForProfile(SHARED_PROFILE_ID));
    const child = spawn(codexBinary(), ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...context.env, PATH: augmentedPath() },
    });
    const client = {
      child,
      threadId,
      key: `${profileControl ? "profile" : "thread"}-${++this.clientSequence}`,
      rpcId: 0,
      pending: new Map(),
      intentionalExit: false,
      resumePromise: null,
      profileId: context.profileId,
      expectedIdentity: context.expectedIdentity ?? null,
      accountGeneration: context.profileId === SHARED_PROFILE_ID ? this.accountGeneration : null,
      profileControl,
      profileIdleTimer: null,
      latestTurnState: null,
    };
    observeStdinErrors(child, `${client.key} app-server`);
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

      this.handleNotification(msg, client);
    });

    child.stdout.on("data", (data) => feed(data));
    child.stderr.on("data", (data) => process.stderr.write(`[codex:${client.threadId || "new"}] ${data}`));
    child.on("error", (error) => {
      for (const [, pending] of client.pending) {
        clearTimeout(pending.timer);
        const uncertain = pending.method === "turn/start" || pending.method === "turn/steer";
        pending.reject(Object.assign(error, uncertain ? { status: 504, code: "delivery_uncertain" } : {}));
      }
      client.pending.clear();
    });
    child.on("exit", (code) => {
      for (const [, pending] of client.pending) {
        clearTimeout(pending.timer);
        const uncertain = pending.method === "turn/start" || pending.method === "turn/steer";
        pending.reject(Object.assign(new Error(`codex thread app-server exited (${code})`), uncertain
          ? { status: 504, code: "delivery_uncertain" }
          : {}));
      }
      client.pending.clear();

      for (const [id, approval] of this.pendingApprovals) {
        if (approval.client === client) {
          clearTimeout(approval.timer);
          this.pendingApprovals.delete(id);
        }
      }

      const id = client.threadId;

      if (client.profileControl && this.profileClients.get(client.profileId) === client) {
        this.profileClients.delete(client.profileId);
      }

      if (client.profileId && client.profileId !== SHARED_PROFILE_ID) {
        try { this.accountProfiles.syncRuntimeProfile(client.profileId); }
        catch (error) { console.error(`[codex:${client.profileId}] could not preserve refreshed credentials:`, error); }
      }

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
      capabilities: { experimentalApi: true },
    }).then(async (result) => {
      writeJsonLine(child.stdin, { jsonrpc: "2.0", method: "initialized", params: {} }, { label: `${client.key} initialized` });
      if (context.profileId !== SHARED_PROFILE_ID) {
        const native = await this.clientRpc(client, "account/read", {});
        const expectedEmail = String(context.expectedIdentity?.email ?? "").trim().toLowerCase();
        const actualEmail = String(native?.account?.email ?? "").trim().toLowerCase();
        if (!expectedEmail || actualEmail !== expectedEmail) {
          throw Object.assign(new Error("Codex did not confirm the selected thread account"), {
            status: 409,
            code: "codex_thread_account_mismatch",
          });
        }
      }
      return result;
    });
    return client;
  }

  scheduleProfileClientRelease(client) {
    if (!client?.profileControl) { return; }
    if (client.profileIdleTimer) { clearTimeout(client.profileIdleTimer); }
    client.profileIdleTimer = setTimeout(() => {
      if (this.profileClients.get(client.profileId) !== client) { return; }
      this.stopThreadClient(client).catch(() => {});
    }, PROFILE_CLIENT_IDLE_MS);
    client.profileIdleTimer.unref?.();
  }

  async awaitProfileReady(client) {
    let timer;
    try {
      return await Promise.race([
        client.ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("Codex account check timed out during startup"), {
            status: 504,
            code: "codex_account_start_timeout",
          })), this.profileStartTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) { clearTimeout(timer); }
    }
  }

  async profileClient(profileId) {
    let client = this.profileClients.get(profileId);
    if (client && client.child.exitCode == null && client.child.signalCode == null) {
      if (client.profileIdleTimer) { clearTimeout(client.profileIdleTimer); }
      try {
        await this.awaitProfileReady(client);
        return client;
      } catch (error) {
        if (this.profileClients.get(profileId) === client) { this.profileClients.delete(profileId); }
        await this.stopThreadClient(client);
        throw error;
      }
    }
    const context = this.accountProfiles.contextForProfile(profileId);
    client = this.startThreadClient(null, context, { profileControl: true });
    this.profileClients.set(profileId, client);
    try {
      await this.awaitProfileReady(client);
      return client;
    } catch (error) {
      if (this.profileClients.get(profileId) === client) { this.profileClients.delete(profileId); }
      await this.stopThreadClient(client);
      throw error;
    }
  }

  clientRpc(client, method, params) {
    const id = ++client.rpcId;
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
      client.pending.set(id, { resolve, reject, timer, method });
      writeJsonLine(client.child?.stdin, { jsonrpc: "2.0", id, method, params }, {
        label: `${client.key ?? "thread"} ${method}`,
        onError: (error) => {
          const pending = client.pending.get(id);
          if (!pending) { return; }
          client.pending.delete(id);
          clearTimeout(timer);
          reject(rpcTransportError(error, method));
        },
      });
    });
  }

  respondToClient(client, id, result, error) {
    const payload = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result };
    writeJsonLine(client.child?.stdin, payload, { label: `${client.key ?? "thread"} response` });
  }

  async stopThreadClient(client) {
    if (!client || client.child.exitCode != null || client.child.signalCode != null) { return; }

    client.intentionalExit = true;
    if (client.profileIdleTimer) { clearTimeout(client.profileIdleTimer); }
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

  scheduleIdleRelease(threadId, delayMs = this.idleReleaseMs) {
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
    }, delayMs);
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

    const accountContext = this.accountProfiles.contextForThread(threadId);
    let client = this.threadClients.get(threadId);

    if (this.resumedThreads.has(threadId)
        && (client?.profileId ?? SHARED_PROFILE_ID) !== accountContext.profileId) {
      await this.releaseThread({ threadId, reason: "thread-account-changed" });
      client = null;
    }

    if (this.resumedThreads.has(threadId)
        && this.clientUsesSharedAccount(client)
        && client?.accountGeneration != null
        && client.accountGeneration !== this.accountGeneration) {
      await this.releaseThread({ threadId, reason: "account-changed" });
      client = null;
    }

    if (this.resumedThreads.has(threadId)) { return false; }

    if (client?.resumePromise) {
      try {
        await client.resumePromise;
      } catch (error) {
        throw mapThreadConflict(error);
      }

      return false;
    }

    client = this.startThreadClient(threadId, accountContext);
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
      const result = await this.clientRpc(client, "thread/resume", params);
      const latest = result?.thread?.turns?.at(-1) ?? null;
      client.latestTurnState = latest ? {
        id: latest.id ?? null,
        status: latest.status ?? null,
        error: latest.error ?? null,
      } : null;
      return result;
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

    // The account can change during a large thread's cold resume. Never start
    // the next turn through a holder that finished resuming with stale auth.
    const selectedAfterResume = this.accountProfiles.selectedProfileId(threadId);
    if ((client.profileId ?? SHARED_PROFILE_ID) !== selectedAfterResume
        || (this.clientUsesSharedAccount(client)
          && client.accountGeneration != null
          && client.accountGeneration !== this.accountGeneration)) {
      await this.stopThreadClient(client);
      this.threadClients.delete(threadId);
      return this.ensureResumed(threadId, { approvalPolicy, sandbox, requestId });
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
  async listThreads({ search, cursor, limit } = {}) {
    const offset = Number(cursor) || 0;
    const summaries = rollout.listRolloutFiles().map((file) => rollout.summarize(file)).filter(Boolean);
    return groupCodexSummaries(summaries, { search, offset, limit });
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

    return this.modelCatalog(this.cache.models);
  }

  modelCatalog(result) {
    const inputModalities = [...new Set((result?.data ?? []).flatMap((model) => model.inputModalities ?? []))];
    return {
      ...result,
      capabilities: {
        source: "app_server",
        provenance: {
          models: "app_server_model_list",
          efforts: "app_server_model_list",
          inputModalities: "app_server_model_list",
          permissionModes: "bridge_presets_over_app_server_policy",
          controls: "app_server_rpc",
        },
        permissionModes: ["read-only", "auto", "full"],
        inputModalities,
        nativeQueue: true,
        nativeSteer: true,
        nativeInterrupt: true,
      },
    };
  }

  async modelsForThread(threadId) {
    const profileId = this.accountProfiles.selectedProfileId(threadId);
    if (profileId === SHARED_PROFILE_ID) { return this.models(); }
    const client = await this.profileClient(profileId);
    try {
      if (!client.models) { client.models = await this.clientRpc(client, "model/list", {}); }
      return this.modelCatalog(client.models);
    } finally {
      this.scheduleProfileClientRelease(client);
    }
  }

  async usage({ refresh } = {}) {
    await this.ready();

    if (!this.cache.account || refresh) {
      const [account, rateLimits] = await Promise.allSettled([
        this.rpc("account/read", {}),
        this.rpc("account/rateLimits/read", {}),
      ]);

      const previous = this.cache.account ?? {};
      this.cache.account = {
        account: account.status === "fulfilled" ? account.value.account : previous.account ?? null,
        rateLimits: rateLimits.status === "fulfilled" ? rateLimits.value : previous.rateLimits ?? null,
        usage: null,
        _fresh: {
          account: account.status === "fulfilled",
          rateLimits: rateLimits.status === "fulfilled",
        },
      };
    }

    return this.cache.account;
  }

  async usageForThread(threadId, { refresh = true } = {}) {
    // Probe through the same holder that will dispatch this thread. Consulting a
    // separate selected-profile control process while an older holder owns the
    // writer lease can authorize a send with account B and execute it as A.
    const [account, rateLimits] = await Promise.allSettled([
      this.accountRpcForThread(threadId, "account/read", {}),
      this.accountRpcForThread(threadId, "account/rateLimits/read", {}),
    ]);
    return {
      account: account.status === "fulfilled" ? account.value.account : null,
      rateLimits: rateLimits.status === "fulfilled" ? rateLimits.value : null,
      usage: null,
      _fresh: {
        account: account.status === "fulfilled",
        rateLimits: rateLimits.status === "fulfilled",
      },
    };
  }

  threadAccountState(threadId) {
    const client = this.threadClients.get(threadId);
    const effectiveProfileId = client ? (client.profileId ?? SHARED_PROFILE_ID) : null;
    return this.accountProfiles.publicThreadState(threadId, effectiveProfileId);
  }

  async setThreadAccount({ threadId, profileId } = {}) {
    const selectedProfileId = this.accountProfiles.setThreadProfile(threadId, profileId);
    const client = this.threadClients.get(threadId);
    const running = this.activeTurns.has(threadId) || this.startingTurns.has(threadId);
    if (client && (client.profileId ?? SHARED_PROFILE_ID) !== selectedProfileId && !running) {
      await this.releaseThread({ threadId, reason: "thread-account-changed" });
    }
    return this.threadAccountState(threadId);
  }

  async accountRpcForThread(threadId, method, params) {
    const holder = this.threadClients.get(threadId);
    const profileId = this.accountProfiles.selectedProfileId(threadId);
    if (holder && holder.child.exitCode == null && holder.child.signalCode == null) {
      const holderProfileId = holder.profileId ?? SHARED_PROFILE_ID;
      if (holderProfileId !== profileId) {
        throw Object.assign(new Error("the selected Codex account will apply after the current turn finishes"), {
          status: 409,
          code: "codex_thread_account_switch_pending",
        });
      }
      return this.clientRpc(holder, method, params);
    }

    if (profileId === SHARED_PROFILE_ID) {
      await this.ready();
      return this.rpc(method, params);
    }

    const client = await this.profileClient(profileId);
    try {
      return await this.clientRpc(client, method, params);
    } finally {
      this.scheduleProfileClientRelease(client);
    }
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
      preserveProviderPolicy = false, summary, requestId, resume = false,
      resumeReason = "interrupted", expectedPreviousTurnId = null,
    } = body;

    if (!threadId || (!resume && !String(text ?? "").trim() && !attachments.length)) {
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
    }

    const client = this.threadClients.get(threadId);
    const previousTurn = resume ? client?.latestTurnState : null;

    // `thread/resume` already returns the provider's populated turn history.
    // Use that result (or live notifications on an already-held client) as the
    // dispatch-time gate instead of replaying a huge rollout a second time via
    // `thread/read(includeTurns:true)` before acquiring the writer.
    const resumeAllowed = !resume
      || (resumeReason === "usage"
        ? isNativeUsageLimitTurn(previousTurn)
          && (!expectedPreviousTurnId || bareTurnId(previousTurn?.id) === bareTurnId(expectedPreviousTurnId))
        : previousTurn?.status === "interrupted");
    if (!resumeAllowed) {
      this.startingTurns.delete(threadId);
      this.finishedStartingTurns.delete(threadId);
      try { await this.releaseThread({ threadId, reason: "resume-rejected" }); } catch {}
      const usageResume = resumeReason === "usage";
      throw Object.assign(new Error(usageResume
        ? "Codex does not report the expected usage-limited latest turn"
        : "Codex does not report an interrupted latest turn"), {
        status: 409,
        code: usageResume ? "no_usage_limited_turn" : "no_interrupted_turn",
      });
    }

    if (requestId) {
      this.emit("send-stage", { threadId, requestId, stage: "starting_turn" });
    }

    const params = { threadId, input: resume ? [] : codexUserInput(text, attachments) };

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

    return resume ? { ...(result ?? {}), previousTurnId: previousTurn?.id ?? null } : result;
  }

  async resumeInterrupted({ threadId, turnId, requestId } = {}) {
    if (!threadId) {
      throw Object.assign(new Error("threadId required"), { status: 400, code: "invalid_thread" });
    }
    if (this.activeTurns.has(threadId) || this.startingTurns.has(threadId)) {
      throw Object.assign(new Error("a turn is already in progress"), { status: 409, code: "turn_in_progress" });
    }
    const result = await this.send({ threadId, requestId, resume: true });
    return { ...result, resumed: true, previousTurnId: result.previousTurnId ?? turnId ?? null };
  }

  async resumeUsageLimited({
    threadId, turnId, requestId, model, effort, summary,
    approvalPolicy, sandbox, preserveProviderPolicy,
  } = {}) {
    if (!threadId || !turnId) {
      throw Object.assign(new Error("threadId and turnId required"), { status: 400, code: "invalid_usage_resume" });
    }
    if (this.activeTurns.has(threadId) || this.startingTurns.has(threadId)) {
      throw Object.assign(new Error("a turn is already in progress"), { status: 409, code: "turn_in_progress" });
    }
    const result = await this.send({
      threadId, requestId, model, effort, summary, approvalPolicy, sandbox, preserveProviderPolicy,
      resume: true,
      resumeReason: "usage",
      expectedPreviousTurnId: turnId,
    });
    return { ...result, resumed: true, previousTurnId: result.previousTurnId ?? bareTurnId(turnId) };
  }

  async latestTurnState(threadId) {
    if (!threadId) { return null; }
    await this.ready();
    const native = await this.rpc("thread/read", { threadId, includeTurns: true });
    const latest = native?.thread?.turns?.at(-1) ?? null;
    return latest ? { id: latest.id ?? null, status: latest.status ?? null, error: latest.error ?? null } : null;
  }

  supportsInterruptedResume() {
    return true;
  }

  activeTurnId(threadId) {
    const turnId = this.activeTurns.get(threadId);
    return turnId && turnId !== "__unknown__" ? turnId : null;
  }

  async steer({ threadId, text, attachments = [], expectedTurnId, requestId } = {}) {
    if (!String(text ?? "").trim() && !attachments.length) {
      throw Object.assign(new Error("message content required"), { status: 409, code: "empty_input" });
    }

    const activeTurnId = this.activeTurns.get(threadId);

    if (!activeTurnId) {
      const code = expectedTurnId ? "not_our_turn" : "no_active_turn";
      const message = expectedTurnId ? "the active turn is not owned by this bridge" : "no active turn";
      throw Object.assign(new Error(message), { status: 409, code });
    }

    const knownTurnId = activeTurnId !== "__unknown__" ? activeTurnId : null;

    // A reconnect may have no id, but a supplied id is an optimistic-concurrency
    // guard: never inject guidance into a replacement turn the user did not see.
    if (expectedTurnId && knownTurnId && expectedTurnId !== knownTurnId) {
      throw Object.assign(new Error("the running turn changed before steering"), { status: 409, code: "turn_changed" });
    }

    const expected = knownTurnId ?? expectedTurnId;
    if (!expected) {
      throw Object.assign(new Error("the active turn id is not available yet"), { status: 409, code: "not_steerable" });
    }

    try {
      const client = this.threadClients.get(threadId);

      if (!client) {
        throw Object.assign(new Error("the active turn is not owned by this bridge"), { status: 409, code: "not_our_turn" });
      }

      return await this.clientRpc(client, "turn/steer", {
        threadId,
        input: codexUserInput(text, attachments),
        expectedTurnId: expected,
        clientUserMessageId: requestId ?? null,
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

    const expected = turnId ?? this.activeTurnId(threadId);
    if (!expected) {
      throw Object.assign(new Error("the active turn id is not available yet"), { status: 409, code: "no_active_turn" });
    }

    return this.clientRpc(client, "turn/interrupt", { threadId, turnId: expected });
  }

  async queue({ threadId, text, attachments = [], requestId } = {}) {
    if (!threadId || (!String(text ?? "").trim() && !attachments.length) || !requestId) {
      throw Object.assign(new Error("threadId, message content, and requestId required"), { status: 400, code: "invalid_queue_request" });
    }

    const key = `${threadId}:${requestId}`;
    const inFlight = this.queueRequests.get(key);

    if (inFlight) { return inFlight; }

    const operation = this.queueOnce({ threadId, text, attachments, requestId });
    this.queueRequests.set(key, operation);

    try {
      return await operation;
    } finally {
      this.queueRequests.delete(key);
    }
  }

  async queueOnce({ threadId, text, attachments, requestId }) {
    const input = codexUserInput(text, attachments);

    // The provider-native client id is our durable idempotency key. Reconcile
    // before adding so a bridge restart after acceptance cannot enqueue twice.
    const existing = await this.findQueuedSubmission(threadId, requestId);
    if (existing) { return { queuedSubmission: existing, reconciled: true }; }

    try {
      const result = await this.accountRpcForThread(threadId, "thread/queue/add", { threadId, input, clientUserMessageId: requestId });
      if (!result?.queuedSubmission?.id) {
        throw Object.assign(new Error("Codex queued the message without returning its id"), { status: 502, code: "invalid_provider_response" });
      }
      return result;
    } catch (error) {
      // A lost local RPC response is reconcilable by the provider-native client
      // id. Never enqueue a duplicate merely because the reply was ambiguous.
      try {
        const queuedSubmission = await this.findQueuedSubmission(threadId, requestId);
        if (queuedSubmission) { return { queuedSubmission, reconciled: true }; }
      } catch {}
      throw error;
    }
  }

  async findQueuedSubmission(threadId, clientUserMessageId) {
    let cursor = null;
    const seen = new Set();

    do {
      const page = await this.queueList({ threadId, cursor, limit: 100 });
      const found = page.data?.find((entry) => entry.clientUserMessageId === clientUserMessageId);

      if (found) { return found; }

      cursor = page.nextCursor ?? null;

      if (cursor && seen.has(cursor)) {
        throw Object.assign(new Error("Codex queue pagination repeated a cursor"), { status: 502, code: "invalid_provider_response" });
      }

      if (cursor) { seen.add(cursor); }
    } while (cursor);

    return null;
  }

  async queueList({ threadId, cursor = null, limit = 100 } = {}) {
    if (!threadId) {
      throw Object.assign(new Error("threadId required"), { status: 400, code: "invalid_queue_request" });
    }

    return this.accountRpcForThread(threadId, "thread/queue/list", {
      threadId,
      cursor,
      limit: Math.min(100, Math.max(1, Number(limit) || 100)),
    });
  }

  async queueUpdate({ threadId, queuedSubmissionId, text, attachments = [] } = {}) {
    if (!threadId || !queuedSubmissionId || (!String(text ?? "").trim() && !attachments.length)) {
      throw Object.assign(new Error("threadId, queuedSubmissionId, and message content required"), { status: 400, code: "invalid_queue_request" });
    }

    return this.accountRpcForThread(threadId, "thread/queue/update", {
      threadId,
      queuedSubmissionId,
      input: codexUserInput(text, attachments),
    });
  }

  async queueDelete({ threadId, queuedSubmissionId } = {}) {
    if (!threadId || !queuedSubmissionId) {
      throw Object.assign(new Error("threadId and queuedSubmissionId required"), { status: 400, code: "invalid_queue_request" });
    }

    return this.accountRpcForThread(threadId, "thread/queue/delete", { threadId, queuedSubmissionId });
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
