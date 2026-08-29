// Durable idempotency for operations that may reach an agent before the phone
// receives the HTTP response. A restart during dispatch is deliberately kept as
// "uncertain": automatically replaying it could post the same message twice.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function publicError(error) {
  return {
    message: String(error?.message ?? error),
    code: error?.code ?? null,
    status: error?.status ?? 500,
  };
}

export class SendLedger {
  constructor({ file, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    if (!file) { throw new Error("send ledger file required"); }

    this.file = file;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
    this.inFlight = new Map();
    this.load();
  }

  load() {
    let rows = [];

    try { rows = JSON.parse(readFileSync(this.file, "utf8")); } catch { return; }

    if (!Array.isArray(rows)) { return; }

    for (const row of rows) {
      if (row?.key && row?.at && this.now() - row.at <= this.ttlMs) {
        this.entries.set(row.key, row);
      }
    }
  }

  key(provider, method, requestId) {
    return `${provider || "codex"}:${method}:${requestId}`;
  }

  status({ provider, method, requestId, threadId } = {}) {
    if (typeof requestId !== "string" || !requestId || requestId.length > 200) {
      throw Object.assign(new Error("invalid requestId"), { status: 400, code: "invalid_request_id" });
    }

    const key = this.key(provider, method, requestId);
    const entry = this.entries.get(key);

    if (!entry || (threadId && entry.threadId !== threadId)) {
      return { state: "not_found" };
    }

    // A durable dispatching record without its in-memory operation means the
    // bridge restarted between journal and outcome. It is the same ambiguity as
    // an explicitly uncertain provider acknowledgement.
    const state = entry.state === "dispatching" && !this.inFlight.has(key)
      ? "uncertain"
      : entry.state;

    return {
      state,
      error: entry.error ?? null,
      result: state === "accepted" ? entry.result : undefined,
    };
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;

    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) { this.entries.delete(key); }
    }
  }

  persist() {
    this.prune();
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.entries.values()]), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async run({ provider, method, requestId, threadId }, operation) {
    if (!requestId) { return operation(); }

    if (typeof requestId !== "string" || requestId.length > 200) {
      throw Object.assign(new Error("invalid requestId"), { status: 400, code: "invalid_request_id" });
    }

    const key = this.key(provider, method, requestId);
    const live = this.inFlight.get(key);

    if (live) { return live; }

    const previous = this.entries.get(key);

    if (previous?.state === "accepted") { return previous.result; }

    if (previous?.state === "dispatching" || previous?.state === "uncertain") {
      throw Object.assign(
        new Error("the bridge restarted while this message was being delivered; check the thread before retrying"),
        { status: 409, code: "delivery_uncertain" },
      );
    }

    const at = this.now();
    this.entries.set(key, {
      key,
      provider: provider || "codex",
      method,
      requestId,
      threadId: threadId ?? null,
      state: "dispatching",
      at,
    });
    // If this write fails, the provider is never called. That is a safe failure.
    this.persist();

    const promise = Promise.resolve().then(operation);
    this.inFlight.set(key, promise);

    try {
      const result = await promise;
      this.entries.set(key, {
        key,
        provider: provider || "codex",
        method,
        requestId,
        threadId: threadId ?? null,
        state: "accepted",
        result,
        at: this.now(),
      });

      try { this.persist(); } catch (error) {
        // The operation is already accepted; never turn a journal failure into a
        // retry signal that could duplicate it. Keep the in-memory fact and log.
        console.error("failed to persist accepted send operation:", error);
      }

      return result;
    } catch (error) {
      // Once `operation` has started, only an explicit client/provider refusal
      // proves that no message was accepted. An untyped exception or 5xx can
      // happen after stdin/RPC delivery but before our acknowledgement; making
      // those retryable is how one user action becomes two provider prompts.
      const uncertain = error?.code === "delivery_uncertain"
        || error?.status == null
        || error.status >= 500;
      this.entries.set(key, {
        key,
        provider: provider || "codex",
        method,
        requestId,
        threadId: threadId ?? null,
        state: uncertain ? "uncertain" : "failed",
        error: publicError(error),
        at: this.now(),
      });

      try { this.persist(); } catch {}
      throw error;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
