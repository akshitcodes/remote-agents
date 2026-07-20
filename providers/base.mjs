// codex-phone — provider interface + shared helpers.
//
// A provider bridges one backend CLI (Codex, Claude, ...) to the normalized
// event/item model the web UI speaks. Every provider is constructed with an
// `emit(event, data)` callback supplied by the server; the server injects the
// provider name onto every emitted frame before broadcasting it to SSE clients.
//
// Interface (all async unless noted):
//   init()                                     start any long-lived process
//   listThreads({ search, cursor })            -> { data:[ThreadSummary], nextCursor }
//   readThread(id)                             -> { thread: { turns:[{ items:[Item] }] } }
//   newThread({ cwd, model })                  -> { thread: { id, ... } }
//   send(body)                                 stream events via this.emit()
//   interrupt({ threadId, turnId })
//   models()                                   -> { data:[Model] }
//   usage({ refresh })                         -> { account, rateLimits, usage }  (may be partial)
//   projects()                                 -> { projects:[{ path, name, count, lastUsed }] }
//
// Streaming events (server tags each with `provider`):
//   emit("notify",   { method, params })       params always carry `threadId`
//   emit("approval", { requestId, method, params })
//   emit("bridge",   { state })

export class BaseProvider {
  constructor(emit, name) {
    this.emit = typeof emit === "function" ? emit : () => {};
    this.name = name;
  }

  notify(method, params) {
    this.emit("notify", { method, params: params ?? {} });
  }

  async init() {}

  async listThreads() {
    return { data: [], nextCursor: null };
  }

  async readThread() {
    return { thread: { turns: [] } };
  }

  async newThread() {
    throw new Error("newThread not supported");
  }

  async send() {
    throw new Error("send not supported");
  }

  async interrupt() {
    return { ok: true };
  }

  async models() {
    return { data: [] };
  }

  async usage() {
    return { account: null, rateLimits: null, usage: null };
  }

  async projects() {
    return { projects: [] };
  }

  // Called once after the HTTP server is listening, so a provider that needs a
  // callback URL (e.g. a permission hook) knows where to reach the bridge.
  setEndpoint() {}

  // Resolve a pending approval raised by this provider. decision is one of
  // "approve" | "session" | "deny" (from the UI).
  respondApproval() {
    return { ok: false, error: "approvals not supported" };
  }
}

// Normalize a value that CLIs sometimes provide as either epoch seconds, epoch
// milliseconds, or an ISO string into epoch seconds (what the UI expects).
export function toEpochSec(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === "number") {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }

  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return null;
  }

  return Math.floor(parsed / 1000);
}

// Stateful newline-delimited JSON splitter for a child process stdout stream.
// Returns a function you feed chunks; it invokes `onLine` per complete line.
export function makeLineReader(onLine) {
  let buf = "";

  return function feed(chunk) {
    buf += chunk;
    let i;

    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);

      if (line.trim()) {
        onLine(line);
      }
    }
  };
}
