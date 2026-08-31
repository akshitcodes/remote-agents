import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isUsageLimitError, usageRetryTrigger, UsageRetryPolicyStore, UsageRetryRunner, UsageRetryStore, usageAvailability } from "../usage-retry.mjs";

function fixture(t, name = "retries.json") {
  const dir = mkdtempSync(join(tmpdir(), "remote-agents-usage-retry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

function create(store, input = {}) {
  return store.create({
    id: input.id || "resume-1",
    provider: input.provider || "codex",
    threadId: input.threadId || "thread-1",
    requestId: input.requestId || "request-1",
    text: "Continue.",
    dispatch: { model: "gpt-test", effort: "medium", mode: "auto" },
    triggerId: Object.hasOwn(input, "triggerId") ? input.triggerId : "terminal-1",
  });
}

test("capacity requires a fresh provider check and every measured window to have room", () => {
  const futureReset = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(usageAvailability({ rateLimits: { primary: { usedPercent: 20 } } }).available, false);
  assert.equal(usageAvailability({ _capacityFresh: true, rateLimits: { primary: { usedPercent: 20 } } }).available, true);
  const exhausted = usageAvailability({
    _capacityFresh: true,
    rateLimits: { rateLimits: { primary: { usedPercent: 20 }, secondary: { remainingPercent: 0, resetsAt: futureReset } } },
  });
  assert.equal(exhausted.available, false);
  assert.equal(exhausted.resetAt, futureReset);
  assert.equal(usageAvailability({
    _capacityFresh: true,
    rateLimits: { rateLimits: { primary: { usedPercent: 20 }, secondary: { usedPercent: 100, resetsAt: 1 } } },
  }).available, true);
});

test("only a terminal provider usage error with stable identity triggers auto-resume", () => {
  assert.deepEqual(usageRetryTrigger("notify", {
    provider: "codex",
    method: "turn/failed",
    params: { threadId: "thread-1", turn: { id: "turn-1", error: { message: "TTR usage limit reached" } } },
  }), { provider: "codex", threadId: "thread-1", triggerId: "codex:turn-1" });
  assert.deepEqual(usageRetryTrigger("external", {
    provider: "claude", threadId: "thread-2", terminalId: "terminal-2", terminalOutcome: "failed",
    terminalError: { message: "You've hit your monthly spend limit" }, observedChange: true,
  }), { provider: "claude", threadId: "thread-2", triggerId: "terminal-2" });
  assert.deepEqual(usageRetryTrigger("external", {
    provider: "codex", threadId: "thread-3", terminalId: "terminal-3", terminalOutcome: "failed",
    terminalError: { code: "usage_limit_exceeded", message: "Your workspace is out of credits. Add credits to continue." }, observedChange: true,
  }), { provider: "codex", threadId: "thread-3", triggerId: "terminal-3" });
  assert.equal(usageRetryTrigger("notify", { provider: "codex", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } }), null);
  assert.equal(usageRetryTrigger("external", { provider: "claude", threadId: "thread-2", terminalOutcome: "failed", terminalError: { message: "usage limit reached" } }), null);
  assert.equal(usageRetryTrigger("external", { provider: "claude", threadId: "thread-2", terminalId: "old", terminalOutcome: "failed", terminalError: { message: "usage limit reached" }, observedChange: false }), null);
});

test("usage exhaustion prefers provider codes and supports legacy provider wording", () => {
  assert.equal(isUsageLimitError({ code: "usage_limit_exceeded", message: "localized provider message" }), true);
  assert.equal(isUsageLimitError({ error: "rate_limit", message: "localized provider message" }), true);
  assert.equal(isUsageLimitError({ message: "Your workspace is out of credits. Add credits to continue." }), true);
  assert.equal(isUsageLimitError({ message: "No usage left for this account." }), true);
  assert.equal(isUsageLimitError({ code: "authentication_error", message: "Please sign in again." }), false);
});

test("global policy defaults off and a chat can override or inherit it", (t) => {
  const file = fixture(t, "policy.json");
  const store = new UsageRetryPolicyStore({ file });
  assert.deepEqual(store.get("claude", "thread-1"), { globalEnabled: false, threadOverride: null, enabled: false });
  store.setThread("claude", "thread-1", true);
  assert.equal(store.get("claude", "thread-1").enabled, true);
  assert.deepEqual(store.interests(), [{ provider: "claude", id: "thread-1" }]);
  store.setGlobal(true);
  store.setThread("claude", "thread-1", false);
  assert.equal(store.get("claude", "thread-1").enabled, false);
  assert.deepEqual(store.interests(), []);
  store.setThread("claude", "thread-1", null);
  assert.deepEqual(new UsageRetryPolicyStore({ file }).get("claude", "thread-1"), {
    globalEnabled: true, threadOverride: null, enabled: true,
  });
});

test("duplicate terminal events and concurrent manual scheduling cannot create two pending sends", (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  const first = create(store);
  const duplicateTrigger = create(store, { id: "resume-2", requestId: "request-2", triggerId: "terminal-1" });
  const manualWhilePending = create(store, { id: "resume-3", requestId: "request-3", triggerId: null });
  assert.equal(duplicateTrigger.id, first.id);
  assert.equal(manualWhilePending.id, first.id);
  assert.equal(store.list({ provider: "codex", threadId: "thread-1" }).length, 1);
});

test("different provider observations and uncertain delivery still block a second Continue", (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  const first = create(store, { id: "notify", requestId: "notify-request", triggerId: "codex:turn-1" });
  const externalRace = create(store, { id: "external", requestId: "external-request", triggerId: "rollout-terminal-1" });
  assert.equal(externalRace.id, first.id, "different observations of one stop collapse while intent is pending");

  store.update(first.id, { state: "uncertain", nextCheckAt: null });
  const manual = create(store, { id: "manual", requestId: "manual-request", triggerId: null });
  assert.equal(manual.id, first.id, "uncertain delivery blocks a second automatic or manual Continue");
  assert.equal(store.list({ provider: "codex", threadId: "thread-1", activeOnly: true })[0].state, "uncertain");

  store.cancel(first.id);
  const afterDismiss = create(store, { id: "after-dismiss", requestId: "after-dismiss-request", triggerId: null });
  assert.equal(afterDismiss.id, "after-dismiss", "explicit dismissal permits a new retry after the user checks the thread");
});

test("an account change wakes only pending retries for that provider", (t) => {
  let now = 1000;
  const store = new UsageRetryStore({ file: fixture(t), now: () => now });
  create(store, { id: "codex-pending", provider: "codex", requestId: "codex-request" });
  create(store, { id: "claude-pending", provider: "claude", requestId: "claude-request", triggerId: "claude-terminal" });
  store.update("codex-pending", { nextCheckAt: 99_000 });
  store.update("claude-pending", { nextCheckAt: 99_000 });
  now = 2000;

  const changed = store.wake("codex");

  assert.deepEqual(changed.map((entry) => entry.id), ["codex-pending"]);
  assert.equal(store.get("codex-pending").nextCheckAt, 2000);
  assert.equal(store.get("claude-pending").nextCheckAt, 99_000);
});

test("a newer turn supersedes an older pending usage resume but not one already dispatching", (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  create(store, { id: "waiting", requestId: "waiting-request" });
  create(store, { id: "other-thread", threadId: "thread-2", requestId: "other-request", triggerId: "terminal-2" });

  const changed = store.supersedeThread("codex", "thread-1", { turnId: "newer-turn" });
  assert.deepEqual(changed.map((entry) => entry.id), ["waiting"]);
  assert.equal(store.get("waiting").state, "superseded");
  assert.equal(store.get("waiting").supersededByTurnId, "newer-turn");
  assert.equal(store.get("waiting").nextCheckAt, null);
  assert.equal(store.get("other-thread").state, "waiting_usage");

  const dispatching = create(store, { id: "dispatching", requestId: "dispatch-request", triggerId: "terminal-3" });
  store.update(dispatching.id, { state: "dispatching", nextCheckAt: null });
  assert.deepEqual(store.supersedeThread("codex", "thread-1", { turnId: "own-turn" }), []);
  assert.equal(store.get(dispatching.id).state, "dispatching");
});

test("runner rechecks the active account, waits for idle, and sends exactly once", async (t) => {
  let now = 1000;
  const store = new UsageRetryStore({ file: fixture(t), now: () => now });
  create(store);
  let usageRound = 0;
  let runtimeRound = 0;
  let sends = 0;
  const runner = new UsageRetryRunner({
    store, now: () => now, pollMs: 60,
    readUsage: async (provider, threadId) => {
      assert.equal(provider, "codex");
      assert.equal(threadId, "thread-1");
      usageRound += 1;
      return usageRound === 1
        ? { _capacityFresh: true, account: { email: "full@example.com" }, rateLimits: { primary: { usedPercent: 100, resetsAt: 9999 } } }
        : { _capacityFresh: true, account: { email: "switched@example.com" }, rateLimits: { primary: { usedPercent: 5 } } };
    },
    readRuntime: async () => ({ running: runtimeRound++ === 0 }),
    send: async (entry) => { sends += 1; assert.equal(entry.requestId, "request-1"); },
  });

  assert.equal((await runner.check("resume-1")).state, "waiting_usage");
  now += 60;
  assert.equal((await runner.check("resume-1")).state, "waiting_thread");
  now += 60;
  assert.equal((await runner.check("resume-1")).state, "accepted");
  assert.equal((await runner.check("resume-1")).state, "accepted");
  assert.equal(sends, 1);
  assert.equal(store.get("resume-1").account.email, "switched@example.com");
});

test("a bridge restart during dispatch becomes durable uncertainty and never sends", async (t) => {
  const file = fixture(t);
  const store = new UsageRetryStore({ file });
  create(store);
  store.update("resume-1", { state: "dispatching", nextCheckAt: null });
  const restarted = new UsageRetryStore({ file });
  assert.equal(restarted.get("resume-1").state, "uncertain");
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].state, "uncertain");
  let sends = 0;
  const runner = new UsageRetryRunner({
    store: restarted,
    readUsage: async () => ({ _capacityFresh: true, rateLimits: { primary: { usedPercent: 0 } } }),
    readRuntime: async () => ({ running: false }),
    send: async () => { sends += 1; },
  });
  await runner.tick();
  assert.equal(sends, 0);
});

test("an old pre-dispatch model failure is repaired without risking a duplicate Continue", (t) => {
  const file = fixture(t);
  writeFileSync(file, JSON.stringify([{
    id: "old-model-failure",
    provider: "codex",
    threadId: "thread-1",
    requestId: "request-1",
    text: "Continue.",
    dispatch: { model: "gpt-test", effort: "medium", mode: "auto" },
    state: "failed",
    attempts: 0,
    nextCheckAt: null,
    error: { code: "model_verification_failed", status: 503, message: "codex app-server exited" },
  }]));

  const repaired = new UsageRetryStore({ file, now: () => 1234 });
  assert.equal(repaired.get("old-model-failure").state, "waiting_provider");
  assert.equal(repaired.get("old-model-failure").nextCheckAt, 1234);

  repaired.update("old-model-failure", { state: "failed", attempts: 1, nextCheckAt: null });
  const attempted = new UsageRetryStore({ file, now: () => 9999 });
  assert.equal(attempted.get("old-model-failure").state, "failed");
});

test("old pre-dispatch settings projection failures are safely re-armed", (t) => {
  const file = fixture(t);
  writeFileSync(file, JSON.stringify([{
    id: "old-permission-failure",
    provider: "codex",
    threadId: "thread-1",
    requestId: "request-1",
    text: "Continue.",
    dispatch: { model: "gpt-test", effort: "medium", mode: "full" },
    state: "failed",
    attempts: 0,
    nextCheckAt: null,
    error: { code: "permission_mode_mismatch", status: 409, message: "low-level fields were dropped" },
  }]));

  const repaired = new UsageRetryStore({ file, now: () => 4321 });
  assert.equal(repaired.get("old-permission-failure").state, "waiting_provider");
  assert.equal(repaired.get("old-permission-failure").nextCheckAt, 4321);

  repaired.update("old-permission-failure", { state: "failed", attempts: 1, nextCheckAt: null });
  const potentiallyAttempted = new UsageRetryStore({ file, now: () => 9999 });
  assert.equal(potentiallyAttempted.get("old-permission-failure").state, "failed");
});

test("cancel wins a race with a slow usage probe and dispatching cannot pretend to cancel", async (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  create(store);
  let releaseUsage;
  let sends = 0;
  const runner = new UsageRetryRunner({
    store,
    readUsage: () => new Promise((resolve) => { releaseUsage = resolve; }),
    readRuntime: async () => ({ running: false }),
    send: async () => { sends += 1; },
  });
  const checking = runner.check("resume-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get("resume-1").state, "checking");
  store.cancel("resume-1");
  releaseUsage({ _capacityFresh: true, rateLimits: { primary: { usedPercent: 0 } } });
  assert.equal((await checking).state, "cancelled");
  assert.equal(sends, 0);

  const second = create(store, { id: "resume-2", requestId: "request-2", triggerId: "terminal-2" });
  store.update(second.id, { state: "dispatching" });
  assert.throws(() => store.cancel(second.id), (error) => error.code === "usage_retry_dispatching");
});

test("a confirmed usage rejection returns to the queue but an ambiguous send never retries", async (t) => {
  const usageFile = fixture(t, "usage.json");
  const store = new UsageRetryStore({ file: usageFile });
  create(store);
  let sendError = Object.assign(new Error("usage limit reached"), { status: 429, code: "rate_limit" });
  const runner = new UsageRetryRunner({
    store,
    readUsage: async () => ({ _capacityFresh: true, rateLimits: { primary: { usedPercent: 1 } } }),
    readRuntime: async () => ({ running: false }),
    send: async () => { throw sendError; },
  });
  assert.equal((await runner.check("resume-1")).state, "waiting_usage");
  sendError = Object.assign(new Error("response lost"), { status: 504, code: "delivery_uncertain" });
  assert.equal((await runner.check("resume-1")).state, "uncertain");
  assert.equal(store.get("resume-1").attempts, 2);
});

test("a transient exact-settings check stays queued and never attempts delivery", async (t) => {
  let now = 1000;
  const store = new UsageRetryStore({ file: fixture(t), now: () => now });
  create(store);
  let prepared = 0;
  let sends = 0;
  const runner = new UsageRetryRunner({
    store, now: () => now, pollMs: 60,
    readUsage: async () => ({ _capacityFresh: true, rateLimits: { primary: { usedPercent: 1 } } }),
    readRuntime: async () => ({ running: false }),
    prepare: async (entry) => {
      prepared += 1;
      if (prepared === 1) {
        throw Object.assign(new Error("codex app-server exited"), { status: 503, code: "model_verification_failed" });
      }
      return entry.dispatch;
    },
    send: async () => { sends += 1; },
  });

  const waiting = await runner.check("resume-1");
  assert.equal(waiting.state, "waiting_provider");
  assert.equal(waiting.attempts, 0);
  assert.equal(sends, 0);
  now += 60;
  assert.equal((await runner.check("resume-1")).state, "accepted");
  assert.equal(sends, 1);
});

test("a turn that wins the post-idle dispatch race supersedes auto-resume", async (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  create(store);
  let sends = 0;
  const runner = new UsageRetryRunner({
    store,
    readUsage: async () => ({ _capacityFresh: true, rateLimits: { primary: { usedPercent: 1 } } }),
    readRuntime: async () => ({ running: false }),
    send: async () => {
      sends += 1;
      throw Object.assign(new Error("a turn is already in progress"), { status: 409, code: "turn_in_progress" });
    },
  });

  assert.equal((await runner.check("resume-1")).state, "superseded");
  assert.equal((await runner.check("resume-1")).state, "superseded");
  assert.equal(sends, 1);
});
