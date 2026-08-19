import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeProvider, claudeSessionArgs } from "../providers/claude.mjs";
import { CodexProvider, sandboxPolicyFor } from "../providers/codex.mjs";
import { grokSessionArgs, parseGrokModels } from "../providers/grok.mjs";

test("Codex turn/start receives the exact model, effort, approval, and sandbox snapshot", async () => {
  const provider = new CodexProvider(() => {});
  let call = null;
  provider.ensureResumed = async (threadId) => {
    provider.threadClients.set(threadId, { threadId });
    provider.resumedThreads.add(threadId);
    return false;
  };
  provider.clientRpc = async (_client, method, params) => {
    call = { method, params };
    return { turn: { id: "turn-exact" } };
  };

  await provider.send({
    threadId: "thread-exact",
    text: "hello",
    model: "gpt-5.6-sol",
    effort: "ultra",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });

  assert.equal(call.method, "turn/start");
  assert.equal(call.params.model, "gpt-5.6-sol");
  assert.equal(call.params.effort, "ultra");
  assert.equal(call.params.approvalPolicy, "on-request");
  assert.equal(call.params.sandboxPolicy.type, "workspaceWrite");
});

test("Codex preserves managed policies and maps the disabled alias to full access", () => {
  const managed = { type: "managed", network: "restricted" };
  assert.equal(sandboxPolicyFor(managed), managed);
  assert.deepEqual(sandboxPolicyFor("disabled"), { type: "dangerFullAccess" });
});

test("Codex preserves a provider-managed policy by sending no unsupported override", async () => {
  const provider = new CodexProvider(() => {});
  let resumeOptions = null;
  let turnParams = null;
  provider.ensureResumed = async (threadId, options) => {
    resumeOptions = options;
    provider.threadClients.set(threadId, { threadId });
    provider.resumedThreads.add(threadId);
    return false;
  };
  provider.clientRpc = async (_client, method, params) => {
    if (method === "turn/start") { turnParams = params; }
    return { turn: { id: "turn-managed" } };
  };
  await provider.send({
    threadId: "thread-managed", text: "hello", model: "gpt-5.6-sol", effort: "medium",
    approvalPolicy: "never", sandbox: { type: "managed", network: "restricted" },
    preserveProviderPolicy: true,
  });
  assert.equal(resumeOptions.approvalPolicy, undefined);
  assert.equal(resumeOptions.sandbox, undefined);
  assert.equal(turnParams.approvalPolicy, undefined);
  assert.equal(turnParams.sandboxPolicy, undefined);
  assert.equal(turnParams.model, "gpt-5.6-sol");
  assert.equal(turnParams.effort, "medium");
});

test("Claude CLI args carry exact model, effort, and native permission mode", () => {
  const args = claudeSessionArgs({
    emitThreadId: "claude-thread",
    model: "claude-opus-5",
    effort: "xhigh",
    modeKey: "auto",
    isDraft: false,
  });
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "claude-opus-5"]);
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "xhigh"]);
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), ["--permission-mode", "auto"]);
});

test("Claude Manual keeps exact settings while routing approvals through the hook", () => {
  const args = claudeSessionArgs({
    emitThreadId: "claude-thread",
    model: "opus",
    effort: "high",
    modeKey: "manual",
    isDraft: false,
    hookPath: "/tmp/hook.mjs",
    endpoint: { host: "127.0.0.1", port: 8484 },
    hookSecret: "secret",
    nodePath: "/usr/bin/node",
  });
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), ["--permission-mode", "default"]);
  assert.match(args[args.indexOf("--settings") + 1], /claude-approval/);
  assert.ok(args.includes("opus"));
  assert.ok(args.includes("high"));
});

test("Grok CLI args carry exact model, effort, and permission behavior", () => {
  assert.deepEqual(grokSessionArgs({ model: "grok-4.5", effort: "high", modeKey: "bypass" }), [
    "agent", "--model", "grok-4.5", "--reasoning-effort", "high", "--always-approve", "stdio",
  ]);
  assert.throws(
    () => grokSessionArgs({ model: "grok-4.5", effort: "high", modeKey: "manual" }),
    /not supported/,
  );
});

test("Grok model picker follows the installed CLI catalog and default", () => {
  const models = parseGrokModels(`You are logged in with grok.com.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n`);
  assert.deepEqual(models.map(({ id, isDefault }) => ({ id, isDefault })), [
    { id: "grok-4.6", isDefault: true },
    { id: "grok-4.5", isDefault: false },
  ]);
});
