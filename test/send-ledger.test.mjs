import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SendLedger } from "../send-ledger.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "codex-phone-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "ledger.json");
}

test("concurrent retries share one provider operation", async (t) => {
  const ledger = new SendLedger({ file: fixture(t) });
  let calls = 0;
  let finish;
  const operation = () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  };
  const input = { provider: "codex", method: "send", requestId: "same", threadId: "t1" };
  const a = ledger.run(input, operation);
  const b = ledger.run(input, operation);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  finish({ turnId: "turn-1" });
  assert.deepEqual(await a, { turnId: "turn-1" });
  assert.deepEqual(await b, { turnId: "turn-1" });
});

test("accepted result survives a bridge restart", async (t) => {
  const file = fixture(t);
  const input = { provider: "claude", method: "send", requestId: "persisted", threadId: "t2" };
  const first = new SendLedger({ file });

  assert.deepEqual(await first.run(input, async () => ({ accepted: true })), { accepted: true });

  const restarted = new SendLedger({ file });
  let called = false;
  const result = await restarted.run(input, async () => { called = true; });

  assert.deepEqual(result, { accepted: true });
  assert.equal(called, false);
});

test("a restart during dispatch is reported as uncertain, never replayed", async (t) => {
  const file = fixture(t);
  const input = { provider: "codex", method: "send", requestId: "uncertain", threadId: "t3" };
  const first = new SendLedger({ file });
  const key = first.key(input.provider, input.method, input.requestId);
  first.entries.set(key, { key, ...input, state: "dispatching", at: Date.now() });
  first.persist();

  const restarted = new SendLedger({ file });
  let called = false;

  await assert.rejects(
    restarted.run(input, async () => { called = true; }),
    (error) => error.status === 409 && error.code === "delivery_uncertain",
  );
  assert.equal(called, false);
});

test("a known provider failure can be retried with the same request id", async (t) => {
  const ledger = new SendLedger({ file: fixture(t) });
  const input = { provider: "codex", method: "send", requestId: "retry", threadId: "t4" };
  let calls = 0;

  await assert.rejects(ledger.run(input, async () => {
    calls += 1;
    throw Object.assign(new Error("locked"), { status: 409, code: "thread_locked_elsewhere" });
  }));

  assert.deepEqual(await ledger.run(input, async () => {
    calls += 1;
    return { accepted: true };
  }), { accepted: true });
  assert.equal(calls, 2);
});

test("a provider delivery timeout stays uncertain across restarts and is never replayed", async (t) => {
  const file = fixture(t);
  const input = { provider: "claude", method: "send", requestId: "timed-out", threadId: "t5" };
  const first = new SendLedger({ file });

  await assert.rejects(
    first.run(input, async () => {
      throw Object.assign(new Error("acknowledgement timed out"), { status: 504, code: "delivery_uncertain" });
    }),
    (error) => error.code === "delivery_uncertain",
  );

  const restarted = new SendLedger({ file });
  let called = false;
  await assert.rejects(
    restarted.run(input, async () => { called = true; }),
    (error) => error.status === 409 && error.code === "delivery_uncertain",
  );
  assert.equal(called, false);
});

test("an untyped provider exit is uncertain and can never be replayed", async (t) => {
  const file = fixture(t);
  const input = { provider: "codex", method: "send", requestId: "provider-exit", threadId: "t-exit" };
  const first = new SendLedger({ file });

  await assert.rejects(
    first.run(input, async () => { throw new Error("provider process exited"); }),
    /provider process exited/,
  );
  assert.equal(first.status(input).state, "uncertain");

  const restarted = new SendLedger({ file });
  let called = false;
  await assert.rejects(
    restarted.run(input, async () => { called = true; }),
    (error) => error.code === "delivery_uncertain",
  );
  assert.equal(called, false);
});

test("delivery status distinguishes absent, accepted, failed, and restart-uncertain requests", async (t) => {
  const file = fixture(t);
  const ledger = new SendLedger({ file });
  const base = { provider: "codex", method: "steer", threadId: "thread-status" };

  assert.deepEqual(ledger.status({ ...base, requestId: "missing" }), { state: "not_found" });

  await ledger.run({ ...base, requestId: "accepted" }, async () => ({ turnId: "turn-1" }));
  assert.deepEqual(ledger.status({ ...base, requestId: "accepted" }), {
    state: "accepted",
    error: null,
    result: { turnId: "turn-1" },
  });

  await assert.rejects(
    ledger.run({ ...base, requestId: "failed" }, async () => {
      throw Object.assign(new Error("known refusal"), { status: 409, code: "known_refusal" });
    }),
  );
  assert.equal(ledger.status({ ...base, requestId: "failed" }).state, "failed");

  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.push({ key: "codex:steer:interrupted", ...base, requestId: "interrupted", state: "dispatching", at: Date.now() });
  writeFileSync(file, JSON.stringify(saved));
  const restarted = new SendLedger({ file });
  assert.equal(restarted.status({ ...base, requestId: "interrupted" }).state, "uncertain");
});
