import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isUsageLimitError, latestUnresolvedUsageStop, usageCapacityKey, usageRetryTrigger, userProgressFromThread, userProgressThroughTurn, UsageRetryPolicyStore, UsageRetryRunner, UsageRetryStore, usageAvailability } from "../usage-retry.mjs";
import { UsageStateStore } from "../usage-state.mjs";

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
    progressGuard: input.progressGuard ?? null,
  });
}

test("a manual usage resume is anchored to the turn that actually hit the limit", () => {
  const thread = {
    thread: {
      turns: [
        { id: "turn-before", items: [{ type: "userMessage", id: "user-1" }] },
        { id: "turn-limit", items: [{ type: "userMessage", id: "user-2" }] },
        { id: "turn-manual", items: [{ type: "userMessage", id: "user-3" }] },
      ],
    },
  };
  assert.deepEqual(userProgressThroughTurn(thread, "codex:turn-limit"), { userCount: 2, lastUserId: "user-2" });
  assert.equal(userProgressFromThread(thread).userCount, 3);
  assert.equal(userProgressThroughTurn(thread, "codex:missing"), null);
});

test("latest usage stop is provider-neutral and stale stops are not resumable", () => {
  const claude = { thread: { turns: [{ items: [
    { type: "userMessage", content: [{ type: "text", text: "work" }] },
    { type: "turnError", terminalId: "claude:error-record-1", message: "You've hit your monthly spend limit" },
  ] }] } };
  assert.deepEqual(latestUnresolvedUsageStop(claude, "claude"), {
    provider: "claude",
    triggerId: "claude:error-record-1",
    terminalId: "error-record-1",
    progressGuard: { userCount: 1, lastUserId: null },
  });

  claude.thread.turns.push({ items: [{ type: "userMessage", content: [{ type: "text", text: "continued manually" }] }] });
  assert.equal(latestUnresolvedUsageStop(claude, "claude"), null);
});

test("latest Codex usage stop preserves native turn identity", () => {
  const codex = { thread: { turns: [{ id: "turn-limit", items: [
    { type: "userMessage", id: "user-1" },
    { type: "turnError", terminalId: "codex:turn-limit", code: "usage_limit_exceeded", message: "limit" },
  ] }] } };
  assert.deepEqual(latestUnresolvedUsageStop(codex, "codex"), {
    provider: "codex",
    triggerId: "codex:turn-limit",
    terminalId: "turn-limit",
    progressGuard: { userCount: 1, lastUserId: "user-1" },
  });
});

test("a newer provider turn resolves an older usage stop without a new user message", () => {
  const codex = { thread: { turns: [
    { id: "turn-limit", items: [
      { type: "userMessage", id: "user-1" },
      { type: "turnError", terminalId: "codex:turn-limit", code: "usage_limit_exceeded", message: "limit" },
    ] },
    // Native Codex resume starts an empty-input turn, so userCount does not
    // advance even though the old usage stop has already been consumed.
    { id: "turn-resumed", items: [{ type: "agentMessage", text: "working" }] },
  ] } };

  assert.equal(latestUnresolvedUsageStop(codex, "codex"), null);
});

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
  }), { provider: "codex", threadId: "thread-1", triggerId: "codex:turn-1", terminalId: "turn-1" });
  assert.deepEqual(usageRetryTrigger("external", {
    provider: "claude", threadId: "thread-2", terminalId: "terminal-2", terminalOutcome: "failed",
    terminalError: { message: "You've hit your monthly spend limit" }, observedChange: true,
  }), { provider: "claude", threadId: "thread-2", triggerId: "terminal-2", terminalId: "terminal-2" });
  assert.deepEqual(usageRetryTrigger("external", {
    provider: "codex", threadId: "thread-3", terminalId: "terminal-3", terminalOutcome: "failed",
    terminalError: { code: "usage_limit_exceeded", message: "Your workspace is out of credits. Add credits to continue." }, observedChange: true,
  }), { provider: "codex", threadId: "thread-3", triggerId: "terminal-3", terminalId: "terminal-3" });
  assert.equal(usageRetryTrigger("notify", { provider: "codex", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } }), null);
  assert.equal(usageRetryTrigger("external", { provider: "claude", threadId: "thread-2", terminalOutcome: "failed", terminalError: { message: "usage limit reached" } }), null);
  assert.deepEqual(usageRetryTrigger("external", {
    provider: "claude", threadId: "thread-2", terminalId: "old", terminalOutcome: "failed",
    terminalError: { message: "usage limit reached" }, observedChange: false,
  }), { provider: "claude", threadId: "thread-2", triggerId: "old", terminalId: "old" });
});

test("usage exhaustion prefers provider codes and supports legacy provider wording", () => {
  assert.equal(isUsageLimitError({ code: "usage_limit_exceeded", message: "localized provider message" }), true);
  assert.equal(isUsageLimitError({ error: "rate_limit", message: "localized provider message" }), true);
  assert.equal(isUsageLimitError({ message: "Your workspace is out of credits. Add credits to continue." }), true);
  assert.equal(isUsageLimitError({ message: "No usage left for this account." }), true);
  assert.equal(isUsageLimitError({ code: "authentication_error", message: "Please sign in again." }), false);
});

test("provider-level exhaustion blocks dispatch even when percentage windows show room", () => {
  const snapshot = {
    _capacityFresh: true,
    account: { email: "workspace@example.com" },
    rateLimits: { rateLimits: {
      primary: { usedPercent: 20, resetsAt: 9999 },
      secondary: { usedPercent: 10, resetsAt: 99999 },
      rateLimitReachedType: "workspace_owner_credits_depleted",
    } },
  };
  assert.equal(usageAvailability(snapshot).available, false);
  assert.equal(usageCapacityKey(snapshot), usageCapacityKey(structuredClone(snapshot)));
});

test("shared usage normalization preserves provider exhaustion metadata", (t) => {
  const state = new UsageStateStore({ file: fixture(t, "usage-state.json") });
  const merged = state.merge("codex", {
    account: { email: "workspace@example.com" },
    rateLimits: {
      primary: { usedPercent: 20, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      secondary: { usedPercent: 10 },
      rateLimitReachedType: "workspace_owner_credits_depleted",
      spendControlReached: true,
    },
  });
  const snapshot = { ...merged, _capacityFresh: true };
  assert.equal(usageAvailability(snapshot).available, false);
  assert.match(usageCapacityKey(snapshot), /workspace_owner_credits_depleted/);
  assert.match(usageCapacityKey(snapshot), /"spendControlReached":true/);
});

test("raw and normalized snapshots produce the same capacity fingerprint", (t) => {
  const raw = {
    account: { email: "same@example.com" },
    rateLimits: { primary: { usedPercent: 20, resetsAt: 12345 }, secondary: null },
  };
  const state = new UsageStateStore({ file: fixture(t, "canonical-capacity.json") });
  const normalized = state.merge("codex", raw);
  assert.equal(usageCapacityKey(raw), usageCapacityKey(normalized));
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

test("durable transcript progress supersedes a retry when the live turn-start event was missed", async (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  create(store, { progressGuard: { userCount: 3, lastUserId: "before-limit" } });
  let sends = 0;
  const runner = new UsageRetryRunner({
    store,
    readUsage: async () => ({ _capacityFresh: true, rateLimits: { primary: { usedPercent: 1 } } }),
    readProgress: async () => ({ userCount: 4, lastUserId: "manual-continue" }),
    readRuntime: async () => ({ running: false }),
    send: async () => { sends += 1; },
  });

  assert.equal((await runner.check("resume-1")).state, "superseded");
  assert.equal(sends, 0);
});

test("manual progress supersedes even while rejected capacity is unchanged", async (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  create(store, { progressGuard: { userCount: 3, lastUserId: "before-limit" } });
  const unchanged = { _capacityFresh: true, account: { email: "same@example.com" }, rateLimits: { primary: { usedPercent: 5 } } };
  store.update("resume-1", { rejectedCapacityKey: usageCapacityKey(unchanged) });
  let sends = 0;
  const runner = new UsageRetryRunner({
    store,
    readUsage: async () => unchanged,
    readProgress: async () => ({ userCount: 4, lastUserId: "manual-message" }),
    readRuntime: async () => ({ running: false }),
    send: async () => { sends += 1; },
  });

  assert.equal((await runner.check("resume-1")).state, "superseded");
  assert.equal(sends, 0);
});

test("matching durable transcript progress allows one resume", async (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  create(store, { progressGuard: { userCount: 3, lastUserId: "before-limit" } });
  let sends = 0;
  const runner = new UsageRetryRunner({
    store,
    readUsage: async () => ({ _capacityFresh: true, rateLimits: { primary: { usedPercent: 1 } } }),
    readProgress: async () => ({ userCount: 3, lastUserId: "before-limit" }),
    readRuntime: async () => ({ running: false }),
    send: async () => { sends += 1; return { turn: { id: "auto-turn-1" } }; },
  });

  assert.equal((await runner.check("resume-1")).state, "accepted");
  assert.equal(sends, 1);
  assert.equal(store.get("resume-1").dispatchedTurnId, "auto-turn-1");
  assert.equal(store.findByDispatchedTurn("codex", "thread-1", "auto-turn-1").id, "resume-1");
});

test("an accepted auto-resume that immediately hits usage is re-armed as one intent", (t) => {
  const store = new UsageRetryStore({ file: fixture(t), now: () => 1000 });
  create(store, { progressGuard: { userCount: 3, lastUserId: "before" } });
  store.update("resume-1", {
    state: "accepted",
    dispatchedTurnId: "auto-turn-1",
    capacityKey: "account-a:window-1",
  });

  const rearmed = store.rearmDispatchedTurn("codex", "thread-1", "auto-turn-1", {
    requestId: "request-2",
    triggerId: "codex:auto-turn-1",
    progressGuard: { userCount: 4, lastUserId: "auto-continue" },
    nextCheckAt: 61_000,
  });

  assert.equal(rearmed.id, "resume-1");
  assert.equal(rearmed.state, "waiting_usage");
  assert.equal(rearmed.requestId, "request-2", "a later attempt must not replay the accepted send-ledger id");
  assert.equal(rearmed.rejectedCapacityKey, "account-a:window-1");
  assert.equal(store.list({ provider: "codex", threadId: "thread-1" }).length, 1);
});

test("an id-less provider acknowledgement still collapses its next usage failure", (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  create(store, { progressGuard: { userCount: 1, lastUserId: "before" } });
  store.update("resume-1", { state: "accepted", capacityKey: "account-a:window-1", dispatchedTurnId: null });

  const rearmed = store.rearmDispatchedTurn("codex", "thread-1", "provider-terminal-id", {
    requestId: "request-2",
    triggerId: "codex:provider-terminal-id",
    progressGuard: { userCount: 2, lastUserId: "auto-continue" },
  });

  assert.equal(rearmed.id, "resume-1");
  assert.equal(rearmed.state, "waiting_usage");
  assert.equal(rearmed.rejectedCapacityKey, "account-a:window-1");
});

test("re-arm reuses an existing blocking intent instead of creating a second send", (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  create(store, { progressGuard: { userCount: 1, lastUserId: "before" } });
  store.update("resume-1", { state: "accepted", capacityKey: "account-a:window-1", dispatchedTurnId: "turn-1" });
  create(store, { id: "already-waiting", requestId: "request-2", triggerId: "watch-record", progressGuard: { userCount: 2 } });

  const result = store.rearmDispatchedTurn("codex", "thread-1", "turn-1", {
    requestId: "request-3",
    triggerId: "codex:turn-1",
    progressGuard: { userCount: 2, lastUserId: "continue" },
  });

  assert.equal(result.id, "already-waiting");
  assert.equal(store.list({ provider: "codex", threadId: "thread-1", activeOnly: true }).length, 1);
});

test("normalized provider transcripts produce a stable count-only guard when IDs are absent", () => {
  assert.deepEqual(userProgressFromThread({ thread: { turns: [
    { items: [{ type: "userMessage", content: [{ type: "text", text: "one" }] }, { type: "agentMessage", text: "answer" }] },
    { items: [{ type: "userMessage", content: [{ type: "text", text: "two" }] }] },
  ] } }), { userCount: 2, lastUserId: null });
});

test("unreadable or shrinking transcript progress waits and never sends", async (t) => {
  for (const [label, readProgress] of [
    ["throws", async () => { throw new Error("temporarily unreadable"); }],
    ["shrinks", async () => ({ userCount: 2, lastUserId: null })],
  ]) {
    const store = new UsageRetryStore({ file: fixture(t, `${label}.json`) });
    create(store, { id: label, requestId: `${label}-request`, progressGuard: { userCount: 3, lastUserId: null } });
    let sends = 0;
    const runner = new UsageRetryRunner({
      store,
      readUsage: async () => ({ _capacityFresh: true, rateLimits: { primary: { usedPercent: 1 } } }),
      readProgress,
      readRuntime: async () => ({ running: false }),
      send: async () => { sends += 1; },
    });
    assert.equal((await runner.check(label)).state, "waiting_thread");
    assert.equal(sends, 0);
  }
});

test("cancel or supersede during slow settings preparation cannot resurrect a retry", async (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  create(store, { progressGuard: { userCount: 1, lastUserId: null } });
  let releasePrepare;
  let sends = 0;
  const runner = new UsageRetryRunner({
    store,
    readUsage: async () => ({ _capacityFresh: true, rateLimits: { primary: { usedPercent: 1 } } }),
    readProgress: async () => ({ userCount: 1, lastUserId: null }),
    readRuntime: async () => ({ running: false }),
    prepare: () => new Promise((resolve) => { releasePrepare = resolve; }),
    send: async () => { sends += 1; },
  });
  const checking = runner.check("resume-1");
  while (!releasePrepare) { await new Promise((resolve) => setImmediate(resolve)); }
  store.cancel("resume-1");
  releasePrepare({ model: "gpt-test", effort: "medium", mode: "auto" });
  assert.equal((await checking).state, "cancelled");
  assert.equal(sends, 0);
});

test("a confirmed usage rejection refreshes the guard before a later retry", async (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  create(store, { progressGuard: { userCount: 1, lastUserId: null } });
  let progressReads = 0;
  let sends = 0;
  const runner = new UsageRetryRunner({
    store,
    readUsage: async () => ({ _capacityFresh: true, rateLimits: { primary: { usedPercent: sends ? 2 : 1 } } }),
    readProgress: async () => progressReads++ === 0
      ? { userCount: 1, lastUserId: null }
      : { userCount: 2, lastUserId: null },
    readRuntime: async () => ({ running: false }),
    send: async () => {
      sends += 1;
      if (sends === 1) { throw Object.assign(new Error("usage limit"), { status: 429, code: "rate_limit" }); }
    },
  });
  assert.equal((await runner.check("resume-1")).state, "waiting_usage");
  assert.deepEqual(store.get("resume-1").progressGuard, { userCount: 2, lastUserId: null });
  assert.equal((await runner.check("resume-1")).state, "accepted");
  assert.equal(sends, 2);
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

test("an obsolete native usage turn is superseded instead of polled forever", async (t) => {
  const store = new UsageRetryStore({ file: fixture(t) });
  create(store, { progressGuard: { userCount: 1, lastUserId: "before" } });
  const runner = new UsageRetryRunner({
    store,
    readUsage: async () => ({ _capacityFresh: true, rateLimits: { primary: { usedPercent: 1 } } }),
    readProgress: async () => ({ userCount: 1, lastUserId: "before" }),
    readRuntime: async () => ({ running: false }),
    send: async () => { throw Object.assign(new Error("expected turn is no longer resumable"), { code: "no_usage_limited_turn", status: 409 }); },
  });

  assert.equal((await runner.check("resume-1")).state, "superseded");
  assert.equal(store.get("resume-1").nextCheckAt, null);
  assert.equal((await runner.check("resume-1")).state, "superseded");
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

test("an interrupted resume is reconciled automatically without replaying it", async (t) => {
  const store = new UsageRetryStore({ file: fixture(t), now: () => 1000 });
  const entry = create(store, { progressGuard: { userCount: 3, lastUserId: "before" } });
  store.update(entry.id, { state: "uncertain", nextCheckAt: 1000 });
  let sends = 0;
  const runner = new UsageRetryRunner({
    store, now: () => 1000, readUsage: async () => { throw new Error("must not probe usage before delivery is reconciled"); },
    readRuntime: async () => ({ running: false }), send: async () => { sends += 1; },
    reconcileDelivery: async () => ({ state: "accepted" }),
  });
  assert.equal((await runner.tick()), 1);
  assert.equal(store.get(entry.id).state, "accepted");
  assert.equal(sends, 0);
});

test("an interrupted resume with a newer manual message is superseded automatically", async (t) => {
  const store = new UsageRetryStore({ file: fixture(t), now: () => 1000 });
  const entry = create(store, { progressGuard: { userCount: 3, lastUserId: "before" } });
  store.update(entry.id, { state: "uncertain", nextCheckAt: 1000 });
  const runner = new UsageRetryRunner({
    store, now: () => 1000, readUsage: async () => { throw new Error("must not probe usage before delivery is reconciled"); },
    readRuntime: async () => ({ running: false }), send: async () => {},
    reconcileDelivery: async () => ({ state: "superseded" }),
  });
  await runner.tick();
  assert.equal(store.get(entry.id).state, "superseded");
});

test("a legacy pending resume without transcript guard is failed closed on upgrade", (t) => {
  const file = fixture(t);
  writeFileSync(file, JSON.stringify([{
    id: "legacy", provider: "codex", threadId: "thread-1", requestId: "request-1",
    text: "Continue.", dispatch: {}, state: "waiting_usage", nextCheckAt: 1, attempts: 0,
  }]));
  const upgraded = new UsageRetryStore({ file, now: () => 1234 });
  assert.equal(upgraded.get("legacy").state, "failed");
  assert.equal(upgraded.get("legacy").error.code, "progress_guard_missing");
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
    progressGuard: { userCount: 1, lastUserId: null },
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
    // The old runner incremented this before sendOnce performed its second
    // local validation, even though the provider was never called.
    attempts: 1,
    nextCheckAt: null,
    error: { code: "permission_mode_mismatch", status: 409, message: "low-level fields were dropped" },
    progressGuard: { userCount: 1, lastUserId: null },
  }]));

  const repaired = new UsageRetryStore({ file, now: () => 4321 });
  assert.equal(repaired.get("old-permission-failure").state, "waiting_provider");
  assert.equal(repaired.get("old-permission-failure").nextCheckAt, 4321);

  assert.equal(repaired.get("old-permission-failure").attempts, 1);
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
  assert.equal((await runner.check("resume-1")).state, "waiting_usage", "unchanged capacity cannot cause another send");
  assert.equal(store.get("resume-1").attempts, 1);
  store.update("resume-1", { rejectedCapacityKey: null });
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
