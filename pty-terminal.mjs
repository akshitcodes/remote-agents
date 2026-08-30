import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const WORKER_PATH = fileURLToPath(new URL("./terminal-worker.mjs", import.meta.url));
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_SESSIONS = 8;
const MAX_DEVICE_SESSIONS = 3;
const DETACHED_TTL_MS = 60 * 60 * 1000;
const MAX_SOCKET_BACKLOG = 1024 * 1024;

function terminalError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function id() {
  return randomBytes(18).toString("base64url");
}

function defaultWorkerFactory() {
  // Do not inherit inspector, test-runner, --input-type, or loader flags from
  // the bridge. The PTY worker is a separate runtime boundary with one fixed
  // entrypoint; inherited execArgv can make Node reject that entrypoint.
  return fork(WORKER_PATH, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] });
}

function sendSocket(socket, frame) {
  if (socket.readyState !== 1) { return false; }
  if (socket.bufferedAmount > MAX_SOCKET_BACKLOG) {
    socket.close(1013, "terminal client is too slow");
    return false;
  }
  socket.send(JSON.stringify(frame));
  return true;
}

export class PtyTerminalManager extends EventEmitter {
  constructor({
    workerFactory = defaultWorkerFactory,
    maxOutputBytes = MAX_OUTPUT_BYTES,
    maxSessions = MAX_SESSIONS,
    maxDeviceSessions = MAX_DEVICE_SESSIONS,
    detachedTtlMs = DETACHED_TTL_MS,
    requestTimeoutMs = 8000,
  } = {}) {
    super();
    this.workerFactory = workerFactory;
    this.maxOutputBytes = maxOutputBytes;
    this.maxSessions = maxSessions;
    this.maxDeviceSessions = maxDeviceSessions;
    this.detachedTtlMs = detachedTtlMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.worker = null;
    this.workerState = "stopped";
    this.unavailableReason = null;
    this.readyPromise = null;
    this.requests = new Map();
    this.sessions = new Map();
    this.sessionsByKey = new Map();
    this.requestSequence = 0;
  }

  async capability() {
    try {
      await this.ensureWorker();
      return { available: true, backend: "pty" };
    } catch (error) {
      return { available: false, backend: "one-shot-fallback", reason: error.message };
    }
  }

  ensureWorker() {
    if (this.workerState === "ready" && this.worker) { return Promise.resolve(); }
    if (this.workerState === "unavailable") { return Promise.reject(terminalError(this.unavailableReason, "terminal_pty_unavailable", 503)); }
    if (this.readyPromise) { return this.readyPromise; }

    this.workerState = "starting";
    const worker = this.workerFactory();
    this.worker = worker;
    worker.stderr?.on("data", (chunk) => process.stderr.write(`[terminal-worker] ${chunk}`));
    worker.on("message", (message) => this.handleWorkerMessage(worker, message));
    worker.on("error", (error) => this.handleWorkerFailure(worker, error));
    worker.on("exit", (code, signal) => this.handleWorkerFailure(worker, new Error(`terminal worker exited (${code ?? signal ?? "unknown"})`)));

    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.worker === worker && this.workerState === "starting") {
          this.unavailableReason = "terminal worker did not become ready";
          this.workerState = "unavailable";
          reject(terminalError(this.unavailableReason, "terminal_pty_unavailable", 503));
        }
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.once(`ready:${worker.pid ?? "worker"}`, () => { clearTimeout(timer); resolve(); });
      this.once(`unavailable:${worker.pid ?? "worker"}`, (error) => { clearTimeout(timer); reject(error); });
    }).finally(() => { this.readyPromise = null; });
    return this.readyPromise;
  }

  handleWorkerMessage(worker, message) {
    if (worker !== this.worker || !message || typeof message !== "object") { return; }
    const eventKey = worker.pid ?? "worker";
    if (message.type === "ready") {
      this.workerState = "ready";
      this.unavailableReason = null;
      this.emit(`ready:${eventKey}`);
      return;
    }
    if (message.type === "unavailable") {
      this.workerState = "unavailable";
      this.unavailableReason = message.message || "interactive terminal backend is unavailable";
      this.emit(`unavailable:${eventKey}`, terminalError(this.unavailableReason, "terminal_pty_unavailable", 503));
      return;
    }
    if (message.type === "response") {
      const pending = this.requests.get(message.requestId);
      if (!pending) { return; }
      this.requests.delete(message.requestId);
      clearTimeout(pending.timer);
      message.ok ? pending.resolve(message) : pending.reject(terminalError(message.error || "terminal worker request failed", "terminal_worker_error", 503));
      return;
    }
    const session = this.sessions.get(message.sessionId);
    if (!session) { return; }
    if (message.type === "output") {
      this.appendOutput(session, String(message.data ?? ""));
      sendSocket(session.socket, { type: "output", seq: session.outputSeq, data: String(message.data ?? "") });
      return;
    }
    if (message.type === "exit") {
      session.state = "exited";
      session.exitCode = message.exitCode ?? null;
      sendSocket(session.socket, { type: "exit", exitCode: session.exitCode, signal: message.signal ?? null });
      this.removeSession(session);
      return;
    }
    if (message.type === "error") {
      sendSocket(session.socket, { type: "error", message: message.error || "terminal backend error" });
    }
  }

  handleWorkerFailure(worker, error) {
    if (worker !== this.worker) { return; }
    this.worker = null;
    const wasStarting = this.workerState === "starting";
    this.workerState = "stopped";
    this.unavailableReason = null;
    const eventKey = worker.pid ?? "worker";
    if (wasStarting) { this.emit(`unavailable:${eventKey}`, terminalError(error.message, "terminal_worker_crashed", 503)); }
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(terminalError("terminal worker stopped", "terminal_worker_crashed", 503));
    }
    this.requests.clear();
    for (const session of [...this.sessions.values()]) {
      sendSocket(session.socket, { type: "error", message: "Terminal backend stopped. Provider agents are unaffected." });
      try { session.socket?.close(1011, "terminal backend stopped"); } catch {}
      this.removeSession(session, { notifyWorker: false });
    }
    this.emit("worker-exit", error);
  }

  request(type, fields) {
    if (!this.worker || this.workerState !== "ready") {
      return Promise.reject(terminalError("terminal worker is unavailable", "terminal_pty_unavailable", 503));
    }
    const requestId = `pty-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(terminalError("terminal worker request timed out", "terminal_worker_timeout", 504));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.requests.set(requestId, { resolve, reject, timer });
      this.worker.send({ type, requestId, ...fields });
    });
  }

  sessionKey(deviceId, context) {
    return `${deviceId}:${context.provider}:${context.threadId}`;
  }

  async attach(socket, { deviceId, context, cols, rows } = {}) {
    await this.ensureWorker();
    const key = this.sessionKey(deviceId, context);
    let session = this.sessionsByKey.get(key);
    if (!session) {
      if (this.sessions.size >= this.maxSessions) { throw terminalError("too many terminal sessions are open", "terminal_session_limit", 409); }
      const owned = [...this.sessions.values()].filter((value) => value.deviceId === deviceId).length;
      if (owned >= this.maxDeviceSessions) { throw terminalError("this device already has too many terminal sessions", "terminal_device_session_limit", 409); }
      session = {
        id: id(),
        key,
        deviceId,
        context: structuredClone(context),
        cwd: context.cwd,
        output: "",
        outputSeq: 0,
        state: "starting",
        exitCode: null,
        socket: null,
        detachedTimer: null,
        lastResizeAt: 0,
      };
      this.sessions.set(session.id, session);
      this.sessionsByKey.set(key, session);
      try {
        await this.request("create", { sessionId: session.id, cwd: session.cwd, cols, rows });
        session.state = "running";
      } catch (error) {
        this.removeSession(session, { notifyWorker: false });
        throw error;
      }
    }

    if (session.detachedTimer) { clearTimeout(session.detachedTimer); session.detachedTimer = null; }
    if (session.socket && session.socket !== socket) {
      try { session.socket.close(4001, "terminal opened in another tab"); } catch {}
    }
    session.socket = socket;
    sendSocket(socket, {
      type: "ready",
      sessionId: session.id,
      cwd: session.cwd,
      replay: session.output,
      seq: session.outputSeq,
      state: session.state,
    });
    return session;
  }

  appendOutput(session, data) {
    session.outputSeq += 1;
    session.output += data;
    if (Buffer.byteLength(session.output) > this.maxOutputBytes) {
      session.output = Buffer.from(session.output).subarray(-this.maxOutputBytes).toString("utf8");
    }
  }

  input(session, data, sequence) {
    if (!session || session.state !== "running") { throw terminalError("terminal session is not running", "terminal_session_closed", 409); }
    const text = String(data ?? "");
    if (!text || Buffer.byteLength(text) > 8192) { throw terminalError("terminal input is empty or too large", "terminal_input_invalid"); }
    this.worker?.send({ type: "input", sessionId: session.id, data: text });
    sendSocket(session.socket, { type: "ack", seq: Number(sequence) || 0 });
  }

  resize(session, cols, rows) {
    if (!session || session.state !== "running") { return; }
    const now = Date.now();
    if (now - session.lastResizeAt < 50) { return; }
    session.lastResizeAt = now;
    const safeCols = Math.min(300, Math.max(20, Number(cols) || 100));
    const safeRows = Math.min(120, Math.max(5, Number(rows) || 30));
    this.worker?.send({ type: "resize", sessionId: session.id, cols: safeCols, rows: safeRows });
  }

  detach(session, socket) {
    if (!session || session.socket !== socket) { return; }
    session.socket = null;
    session.detachedTimer = setTimeout(() => this.closeSession(session.id, "detached terminal expired"), this.detachedTtlMs);
    session.detachedTimer.unref?.();
  }

  closeSession(sessionId, reason = "terminal closed") {
    const session = this.sessions.get(sessionId);
    if (!session) { return false; }
    sendSocket(session.socket, { type: "closed", reason });
    try { session.socket?.close(1000, reason); } catch {}
    this.removeSession(session);
    return true;
  }

  removeSession(session, { notifyWorker = true } = {}) {
    if (!session) { return; }
    if (session.detachedTimer) { clearTimeout(session.detachedTimer); }
    this.sessions.delete(session.id);
    if (this.sessionsByKey.get(session.key) === session) { this.sessionsByKey.delete(session.key); }
    if (notifyWorker) { this.worker?.send({ type: "close", sessionId: session.id }); }
  }

  revoke({ deviceIds = [], all = false, reason = "terminal access revoked" } = {}) {
    const ids = new Set(deviceIds);
    for (const session of [...this.sessions.values()]) {
      if (all || ids.has(session.deviceId)) { this.closeSession(session.id, reason); }
    }
  }

  shutdown() {
    for (const session of [...this.sessions.values()]) { this.closeSession(session.id, "bridge shutting down"); }
    this.worker?.kill?.("SIGTERM");
    this.worker = null;
    this.workerState = "stopped";
  }
}

export const ptyTerminalInternals = {
  MAX_OUTPUT_BYTES,
  MAX_SESSIONS,
  MAX_DEVICE_SESSIONS,
  DETACHED_TTL_MS,
};
