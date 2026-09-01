import assert from "node:assert/strict";
import test from "node:test";

import { confirmCanonicalNonDelivery, reconcileUserIntent } from "../server.mjs";

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

test("canonical reconciliation fails closed for stale cursors, mismatches, and image-only prompts", async () => {
  const p = provider([user("u1", "earlier"), user("u2", "different")]);
  assert.equal((await reconcileUserIntent(p, "thread", { userCount: 1, lastUserId: "wrong" }, "different")).state, "unconfirmed");
  assert.equal((await reconcileUserIntent(p, "thread", { userCount: 1, lastUserId: "u1" }, "not present")).state, "unconfirmed");
  assert.equal((await reconcileUserIntent(p, "thread", { userCount: 1, lastUserId: "u1" }, "")).state, "unconfirmed");
  assert.equal((await reconcileUserIntent(p, "thread", { userCount: 2, lastUserId: "u2" }, "different")).state, "unconfirmed");
});

test("canonical reconciliation never searches past the immediate next user message", async () => {
  const p = provider([user("u1", "earlier"), user("u2", "different"), user("u3", "continue")]);
  const result = await reconcileUserIntent(p, "thread", { userCount: 1, lastUserId: "u1" }, "continue");
  assert.equal(result.state, "unconfirmed");
});

test("unchanged canonical progress proves non-delivery only after a confirmed idle state", () => {
  const reconciliation = { state: "unconfirmed", progress: { userCount: 1, lastUserId: "u1" } };
  const baseline = { userCount: 1, lastUserId: "u1" };
  assert.equal(confirmCanonicalNonDelivery(reconciliation, baseline, { running: false, confidence: "marker" }), true);
  assert.equal(confirmCanonicalNonDelivery(reconciliation, baseline, { running: true, confidence: "bridge" }), false);
  assert.equal(confirmCanonicalNonDelivery(reconciliation, baseline, { running: false, confidence: "historical_stale" }), false);
  assert.equal(confirmCanonicalNonDelivery({ ...reconciliation, progress: { userCount: 2, lastUserId: "u2" } }, baseline, { running: false, confidence: "marker" }), false);
});
