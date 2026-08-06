// codex-phone — Codex provider.
//
// Spawns `codex app-server` (JSON-RPC over stdio) and bridges it to the
// normalized event/item model. This is the original bridge behavior, moved
// verbatim into a provider class. Codex emits the normalized shapes natively,
// so notifications are passed through unchanged.

import { spawn } from "node:child_process";
import { basename } from "node:path";

import { BaseProvider, makeLineReader } from "./base.mjs";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

function sandboxPolicyFor(name) {
  switch (name) {
    case "read-only": return { type: "readOnly" };
    case "danger-full-access": return { type: "dangerFullAccess" };
    case "workspace-write":
    default: return { type: "workspaceWrite" };
  }
}

export class CodexProvider extends BaseProvider {
  constructor(emit) {
    super(emit, "codex");

    this.child = null;
    this.rpcId = 0;
    this.pendingRequests = new Map(); // our request id -> {resolve, reject}
    this.pendingApprovals = new Map(); // server->client request id -> {method, params}
    this.resumedThreads = new Set();
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
        this.pendingApprovals.set(String(msg.id), { method: msg.method, params: msg.params });
        this.emit("approval", { requestId: String(msg.id), method: msg.method, params: msg.params });
      } else {
        this.respondToServer(msg.id, null, { code: -32601, message: `codex-phone cannot handle ${msg.method}` });
      }

      return;
    }

    // Notification — fan out to the UI (and keep some caches warm)
    if (msg.method) {
      if (msg.method === "account/rateLimits/updated" && this.cache.account) {
        this.cache.account.rateLimits = msg.params?.rateLimits ?? this.cache.account.rateLimits;
      }

      this.notify(msg.method, msg.params ?? {});
    }
  }

  respondToServer(id, result, error) {
    const payload = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result };

    this.child?.stdin.write(JSON.stringify(payload) + "\n");
  }

  startChild() {
    this.child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
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
      this.pendingApprovals.clear();
      this.resumedThreads.clear();
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
          reject(new Error(`rpc timeout: ${method}`));
        }
      }, 180000);
    });
  }

  async ready() {
    if (!this.initializePromise) {
      throw new Error("codex app-server not running");
    }

    await this.initializePromise;
  }

  // Resume a thread, applying the permission mode at the SESSION level (as the
  // official Codex client does), not only per-turn. `sandbox` here is the
  // SandboxMode string ("read-only" | "workspace-write" | "danger-full-access"),
  // which is what thread/resume expects (turn/start takes a sandboxPolicy object).
  async ensureResumed(threadId, { approvalPolicy, sandbox } = {}) {
    if (this.resumedThreads.has(threadId)) {
      return;
    }

    const params = { threadId };

    if (approvalPolicy) {
      params.approvalPolicy = approvalPolicy;
    }

    if (sandbox) {
      params.sandbox = sandbox;
    }

    await this.rpc("thread/resume", params);
    this.resumedThreads.add(threadId);
  }

  async listThreads({ search, cursor } = {}) {
    await this.ready();
    const params = { limit: 25 };
    params.sortKey = "recency_at";

    if (cursor) {
      params.cursor = cursor;
    }

    if (search) {
      params.searchTerm = search;
    }

    const res = await this.rpc("thread/list", params);
    const data = (res.data ?? []).map((t) => ({ ...t, provider: "codex" }));
    return { ...res, data };
  }

  async readThread(id) {
    await this.ready();
    return this.rpc("thread/read", { threadId: id, includeTurns: true });
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
    await this.ready();

    if (!cwd) {
      throw Object.assign(new Error("cwd required"), { status: 400 });
    }

    const params = { cwd };

    if (model) {
      params.model = model;
    }

    const result = await this.rpc("thread/start", params);
    const threadId = result.thread?.id ?? result.threadId ?? result.id;
    this.resumedThreads.add(threadId);
    return result;
  }

  async send(body = {}) {
    await this.ready();
    const { threadId, text, model, effort, approvalPolicy, sandbox, summary } = body;

    if (!threadId || !text) {
      throw Object.assign(new Error("threadId and text required"), { status: 400 });
    }

    await this.ensureResumed(threadId, { approvalPolicy, sandbox });

    const params = { threadId, input: [{ type: "text", text }] };

    if (model) {
      params.model = model;
    }

    if (effort) {
      params.effort = effort;
    }

    if (summary) {
      params.summary = summary;
    }

    if (approvalPolicy) {
      params.approvalPolicy = approvalPolicy;
    }

    if (sandbox) {
      params.sandboxPolicy = sandboxPolicyFor(sandbox);
    }

    return this.rpc("turn/start", params);
  }

  async interrupt({ threadId, turnId } = {}) {
    await this.ready();
    return this.rpc("turn/interrupt", { threadId, turnId });
  }

  async rename({ threadId, name } = {}) {
    await this.ready();
    await this.ensureResumed(threadId);
    return this.rpc("thread/name/set", { threadId, name });
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

    const legacy = pending.method === "execCommandApproval" || pending.method === "applyPatchApproval";
    // decision from UI: "approve" | "session" | "deny"
    let value;

    if (legacy) {
      value = decision === "deny" ? "denied" : "approved";
    } else {
      value = decision === "deny" ? "reject" : decision === "session" ? "acceptForSession" : "accept";
    }

    const id = Number.isNaN(Number(requestId)) ? requestId : Number(requestId);
    this.respondToServer(id, { decision: value });
    return { ok: true };
  }
}

export default CodexProvider;
