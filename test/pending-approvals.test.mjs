import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeProvider } from "../providers/claude.mjs";
import { CodexProvider } from "../providers/codex.mjs";

test("Codex exposes enough pending approval data to recover the phone UI", () => {
  const provider = new CodexProvider(() => {});
  provider.pendingApprovals.set("approval-1", {
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", command: "npm test" },
    rpcId: 7,
    client: {},
  });

  assert.deepEqual(provider.pendingApprovalsList(), [{
    requestId: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", command: "npm test" },
  }]);
});

test("Codex scopes legacy conversationId approvals to the correct thread", () => {
  const provider = new CodexProvider(() => {});
  const emitted = [];
  provider.emit = (event, data) => emitted.push({ event, data });
  provider.rememberApproval({ id: 8, method: "execCommandApproval", params: { conversationId: "thread-legacy", command: "npm test" } }, { key: "control" });

  assert.equal(provider.pendingApprovalsList()[0].params.threadId, "thread-legacy");
  assert.equal(emitted[0].data.params.threadId, "thread-legacy");
  clearTimeout(provider.pendingApprovals.get("control:8").timer);
});

test("Claude exposes pending approvals and removes them after a response", async () => {
  const provider = new ClaudeProvider(() => {});
  let answer;
  const timer = setTimeout(() => {}, 10_000);
  timer.unref?.();
  provider.pendingApprovals.set("approval-2", {
    method: "PreToolUse:Bash",
    params: { threadId: "thread-2", command: "npm test" },
    timer,
    resolve: (value) => { answer = value; },
  });

  assert.deepEqual(provider.pendingApprovalsList(), [{
    requestId: "approval-2",
    method: "PreToolUse:Bash",
    params: { threadId: "thread-2", command: "npm test" },
  }]);
  assert.deepEqual(provider.respondApproval({ requestId: "approval-2", decision: "approve" }), { ok: true });
  assert.deepEqual(answer, { decision: "allow" });
  assert.deepEqual(provider.pendingApprovalsList(), []);
});
