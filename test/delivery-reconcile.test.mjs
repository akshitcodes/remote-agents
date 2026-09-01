import assert from "node:assert/strict";
import test from "node:test";

import { confirmCanonicalNonDelivery, reconcileUsageRetryDelivery, reconcileUserIntent } from "../server.mjs";

function provider(items) {
  return { readThread: async () => ({ thread: { turns: [{ items }] } }) };
}

const user = (id, text) => ({ id, type: "userMessage", content: [{ type: "text", text }] });

test("canonical reconciliation accepts only an exact user message after the saved cursor", async () => {
  const result = await reconcileUserIntent(provider([
    user("u1", "earlier"),
    { id: "a1", type: "agentMessage", text: "answer" },
    user("u2", "the attempted prompt"),
  ]), "thread", { userCount: 1, lastUserId: "u1" }, "the attempted prompt");

  assert.equal(result.state, "accepted");
  assert.deepEqual(result.progress, { userCount: 2, lastUserId: "u2" });
});

test("canonical reconciliation fails closed for stale cursors and image-only prompts", async () => {
  const p = provider([user("u1", "earlier"), user("u2", "different")]);
  assert.equal((await reconcileUserIntent(p, "thread", { userCount: 1, lastUserId: "wrong" }, "different")).state, "unconfirmed");
  assert.equal((await reconcileUserIntent(p, "thread", { userCount: 1, lastUserId: "u1" }, "")).state, "unconfirmed");
  assert.equal((await reconcileUserIntent(p, "thread", { userCount: 2, lastUserId: "u2" }, "different")).state, "unconfirmed");
});

test("a different immediate next message proves the attempted send was superseded", async () => {
  const p = provider([user("u1", "earlier"), user("u2", ".")]);
  const result = await reconcileUserIntent(p, "thread", { userCount: 1, lastUserId: "u1" }, "the attempted prompt");

  assert.equal(result.state, "superseded");
  assert.deepEqual(result.progress, { userCount: 2, lastUserId: "u2" });
  assert.equal(confirmCanonicalNonDelivery(result, { userCount: 1, lastUserId: "u1" }, { running: true, confidence: "stalled" }), true);
});

test("canonical reconciliation never searches past the immediate next user message", async () => {
  const p = provider([user("u1", "earlier"), user("u2", "different"), user("u3", "continue")]);
  const result = await reconcileUserIntent(p, "thread", { userCount: 1, lastUserId: "u1" }, "continue");
  assert.equal(result.state, "superseded");
});

test("unchanged canonical progress proves non-delivery only after a confirmed idle state", () => {
  const reconciliation = { state: "unconfirmed", progress: { userCount: 1, lastUserId: "u1" } };
  const baseline = { userCount: 1, lastUserId: "u1" };
  assert.equal(confirmCanonicalNonDelivery(reconciliation, baseline, { running: false, confidence: "marker" }), true);
  assert.equal(confirmCanonicalNonDelivery(reconciliation, baseline, { running: true, confidence: "bridge" }), false);
  assert.equal(confirmCanonicalNonDelivery(reconciliation, baseline, { running: false, confidence: "historical_stale" }), false);
  assert.equal(confirmCanonicalNonDelivery({ ...reconciliation, progress: { userCount: 2, lastUserId: "u2" } }, baseline, { running: false, confidence: "marker" }), false);
});

test("native Codex usage resume reconciles by exact provider turn identity", async () => {
  const entry = {
    method: "resumeUsage",
    threadId: "thread",
    terminalId: "codex:usage-turn",
    progressGuard: { userCount: 1, lastUserId: "u1" },
  };
  const unchanged = {
    latestTurnState: async () => ({
      id: "usage-turn",
      status: "failed",
      error: { codexErrorInfo: "usageLimitExceeded", message: "usage limit reached" },
    }),
  };
  assert.equal((await reconcileUsageRetryDelivery(unchanged, entry, { state: "failed" })).state, "retryable");
  assert.equal((await reconcileUsageRetryDelivery(unchanged, entry, { state: "dispatching" })).state, "unconfirmed");

  const advanced = {
    latestTurnState: async () => ({ id: "new-turn", status: "completed", error: null }),
  };
  assert.equal((await reconcileUsageRetryDelivery(advanced, entry, { state: "dispatching" })).state, "superseded");
});

test("a crashed native resume that immediately exhausts usage is re-armed on the new failed turn", async () => {
  const p = {
    latestTurnState: async () => ({
      id: "new-usage-turn",
      status: "failed",
      error: { codexErrorInfo: "usageLimitExceeded", message: "usage limit reached" },
    }),
    readThread: async () => ({ thread: { turns: [{ items: [user("u1", "original prompt")] }] } }),
  };
  const result = await reconcileUsageRetryDelivery(p, {
    method: "resumeUsage",
    threadId: "thread",
    terminalId: "old-usage-turn",
  }, { state: "dispatching" });

  assert.deepEqual(result, {
    state: "rearm",
    triggerId: "codex:new-usage-turn",
    terminalId: "new-usage-turn",
    progressGuard: { userCount: 1, lastUserId: "u1" },
  });
});
