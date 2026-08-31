import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeProvider } from "../providers/claude.mjs";

function fakeSession(provider, onWrite) {
  const session = {
    child: { stdin: { write: () => onWrite(session) } },
    ready: Promise.resolve(),
    busy: false,
    dead: false,
    ctx: provider.newCtx("thread-claude", false),
    emitThreadId: "thread-claude",
    sessionId: "thread-claude",
    lastUsed: Date.now(),
    turnDone: null,
    _resolveTurnDone: null,
    turnAccepted: null,
    _resolveTurnAccepted: null,
    _rejectTurnAccepted: null,
    acceptTimer: null,
    stderr: "",
  };
  return session;
}

test("Claude send is accepted only after a real message_start", async () => {
  const provider = new ClaudeProvider(() => {});
  let wrote = false;
  const session = fakeSession(provider, (current) => {
    wrote = true;
    setImmediate(() => provider.handleAnthropicEvent({ type: "message_start", message: { id: "msg-1" } }, current.ctx, current));
  });
  provider.ensureSession = async () => session;

  const result = await provider.send({ threadId: "thread-claude", text: "hello", cwd: "/tmp" });

  assert.equal(wrote, true);
  assert.deepEqual(result, { ok: true, threadId: "thread-claude" });
});

test("Claude writes image blocks into the accepted stream-json user frame", async () => {
  const provider = new ClaudeProvider(() => {});
  const root = mkdtempSync(join(tmpdir(), "codex-phone-claude-frame-"));
  const path = join(root, "image.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  writeFileSync(path, png);
  const session = fakeSession(provider, () => {});
  session.child.stdin.write = (value) => {
    session._written = value;
    setImmediate(() => provider.handleAnthropicEvent({ type: "message_start", message: { id: "msg-image" } }, session.ctx, session));
  };
  provider.ensureSession = async () => session;

  await provider.send({ threadId: "thread-claude", text: "look", attachments: [{ path, mimeType: "image/png" }], cwd: root });
  const frame = JSON.parse(session._written);

  assert.equal(frame.message.content[1].type, "image");
  assert.equal(frame.message.content[1].source.media_type, "image/png");
  assert.equal(frame.message.content[1].source.data, png.toString("base64"));
});

test("Claude resume conflict rejects the HTTP send before it is ledger-accepted", async () => {
  const provider = new ClaudeProvider(() => {});
  const session = fakeSession(provider, (current) => {
    setImmediate(() => provider.handleStreamLine(JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      result: "Session abc is currently running as a background agent (bg)",
    }), current));
  });
  provider.ensureSession = async () => session;

  await assert.rejects(
    provider.send({ threadId: "thread-claude", text: "hello", cwd: "/tmp" }),
    (error) => error.status === 409 && error.code === "thread_locked_elsewhere",
  );
});

test("Claude releases its process after a terminal result", () => {
  const provider = new ClaudeProvider(() => {});
  let killed = false;
  const session = fakeSession(provider, () => {});
  session.child.kill = () => { killed = true; };
  session.busy = true;
  session.turnDone = Promise.resolve();
  session._resolveTurnDone = () => {};
  provider.sessions.set(session.emitThreadId, session);

  provider.handleStreamLine(JSON.stringify({ type: "result", subtype: "success", result: "OK" }), session);

  assert.equal(session.dead, true);
  assert.equal(killed, true);
  assert.equal(provider.sessions.has(session.emitThreadId), false);
});

test("Claude cannot silently report success without any assistant output", () => {
  const events = [];
  const provider = new ClaudeProvider((event, data) => events.push({ event, data }));
  const session = fakeSession(provider, () => {});
  session.child.kill = () => {};
  session.busy = true;
  session.ctx.turnId = "message-empty";
  provider.sessions.set(session.emitThreadId, session);

  provider.handleStreamLine(JSON.stringify({ type: "result", subtype: "success", result: "" }), session);

  const terminal = events.find(({ data }) => data?.method === "turn/failed");
  assert.deepEqual(terminal?.data?.params?.error, {
    message: "Claude ended without returning a response",
    code: "empty_provider_result",
  });
  assert.equal(session.dead, true);
});

test("Claude synthetic no-response output is a visible failed turn, not an answer", () => {
  const events = [];
  const provider = new ClaudeProvider((event, data) => events.push({ event, data }));
  const session = fakeSession(provider, () => {});
  session.child.kill = () => {};
  session.busy = true;
  provider.sessions.set(session.emitThreadId, session);

  provider.handleStreamLine(JSON.stringify({
    type: "assistant",
    message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
  }), session);
  provider.handleStreamLine(JSON.stringify({ type: "result", subtype: "success", result: "No response requested." }), session);

  assert.ok(!events.some(({ data }) => data?.method === "item/completed"));
  const terminal = events.find(({ data }) => data?.method === "turn/failed");
  assert.deepEqual(terminal?.data?.params?.error, {
    message: "Claude classified this prompt as a meta event and did not run it",
    code: "no_response_requested",
  });
});

test("Claude synthetic no-response metadata cannot override real streamed output", () => {
  const events = [];
  const provider = new ClaudeProvider((event, data) => events.push({ event, data }));
  const session = fakeSession(provider, () => {});
  session.child.kill = () => {};
  session.busy = true;
  provider.sessions.set(session.emitThreadId, session);

  provider.handleAnthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "Real answer" } }, session.ctx, session);
  provider.handleStreamLine(JSON.stringify({
    type: "assistant",
    message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
  }), session);
  provider.handleStreamLine(JSON.stringify({ type: "result", subtype: "success", result: "No response requested." }), session);

  assert.ok(events.some(({ data }) => data?.method === "turn/completed"));
  assert.ok(!events.some(({ data }) => data?.method === "turn/failed"));
});

test("a streamed Claude response remains a successful terminal result", () => {
  const events = [];
  const provider = new ClaudeProvider((event, data) => events.push({ event, data }));
  const session = fakeSession(provider, () => {});
  session.child.kill = () => {};
  session.busy = true;
  session.ctx.turnId = "message-text";
  provider.sessions.set(session.emitThreadId, session);

  provider.handleAnthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }, session.ctx, session);
  provider.handleStreamLine(JSON.stringify({ type: "result", subtype: "success", result: "" }), session);

  assert.ok(events.some(({ data }) => data?.method === "turn/completed"));
  assert.ok(!events.some(({ data }) => data?.method === "turn/failed"));
});

test("Claude partial assistant envelopes keep the native logical block identity", () => {
  const events = [];
  const provider = new ClaudeProvider((event, data) => events.push({ event, data }));
  const session = fakeSession(provider, () => {});

  provider.handleAnthropicEvent({ type: "message_start", message: { id: "msg-split" } }, session.ctx, session);
  provider.handleAnthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, session.ctx, session);
  provider.handleAnthropicEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "considering" } }, session.ctx, session);
  provider.handleAnthropicEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, session.ctx, session);
  provider.handleAnthropicEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } }, session.ctx, session);
  provider.handleStreamLine(JSON.stringify({
    type: "assistant",
    message: { id: "msg-split", content: [{ type: "text", text: "Answer" }] },
  }), session);

  const completed = events.filter(({ data }) => data?.method === "item/completed").map(({ data }) => data.params.item);
  assert.deepEqual(completed, [{ type: "agentMessage", id: "msg-split:1", text: "Answer" }]);
  assert.ok(!completed.some((item) => item.id === "msg-split:0"));
});

test("Claude synthetic API errors are not emitted as assistant answers", () => {
  const events = [];
  const provider = new ClaudeProvider((event, data) => events.push({ event, data }));
  const session = fakeSession(provider, () => {});

  provider.handleStreamLine(JSON.stringify({
    type: "assistant",
    uuid: "rate-limit-row",
    isApiErrorMessage: true,
    error: "rate_limit",
    message: {
      id: "synthetic-message",
      content: [{ type: "text", text: "You've hit your monthly spend limit." }],
    },
  }), session);

  assert.ok(!events.some(({ data }) => data?.method === "item/completed"));
  assert.equal(session.ctx.sawAssistantOutput, false);
});

test("Claude acknowledgement timeout is uncertain without killing the live turn", async () => {
  const provider = new ClaudeProvider(() => {}, { acceptTimeoutMs: 10 });
  let killed = false;
  const session = fakeSession(provider, () => {});
  session.child.kill = () => { killed = true; };
  provider.ensureSession = async () => session;

  await assert.rejects(
    provider.send({ threadId: "thread-claude", text: "hello", cwd: "/tmp" }),
    (error) => error.status === 504 && error.code === "delivery_uncertain",
  );

  assert.equal(session.busy, true);
  assert.equal(session.dead, false);
  assert.equal(killed, false);

  await assert.rejects(
    provider.send({ threadId: "thread-claude", text: "second", cwd: "/tmp" }),
    (error) => error.status === 409 && error.code === "turn_in_progress",
  );
});

test("Claude Stop refuses to claim success when this bridge has no active turn", async () => {
  const provider = new ClaudeProvider(() => {});

  await assert.rejects(
    provider.interrupt({ threadId: "running-somewhere-else", requireActive: true }),
    (error) => error.status === 409 && error.code === "not_our_turn",
  );

  const idle = fakeSession(provider, () => {});
  provider.sessions.set(idle.emitThreadId, idle);

  await assert.rejects(
    provider.interrupt({ threadId: idle.emitThreadId, requireActive: true }),
    (error) => error.status === 409 && error.code === "not_our_turn",
  );
});

test("Claude transcript images retain a bridge attachment reference", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-phone-claude-history-"));
  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(project, "thread-image.jsonl"), JSON.stringify({
    type: "user",
    message: {
      content: [
        { type: "text", text: "inspect" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "encoded-image" } },
      ],
    },
  }) + "\n");
  const provider = new ClaudeProvider(() => {}, {
    projectsDir: root,
    attachmentLookup: (data) => data === "encoded-image" ? { id: "stored.png", mimeType: "image/png" } : null,
  });

  const result = await provider.readThread("thread-image");

  assert.deepEqual(result.thread.turns[0].items[0].content, [
    { type: "text", text: "inspect" },
    { type: "image", attachment: { id: "stored.png", mimeType: "image/png" } },
  ]);
});

test("Claude replay keeps split records distinct and renders provider errors once", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-phone-claude-split-history-"));
  const project = join(root, "project");
  mkdirSync(project);
  const rows = [
    { type: "user", uuid: "user-1", message: { content: [{ type: "text", text: "review" }] } },
    { type: "assistant", uuid: "thinking-row", message: { id: "shared-message", content: [{ type: "thinking", thinking: "analysis" }] } },
    { type: "assistant", uuid: "text-row", message: { id: "shared-message", content: [{ type: "text", text: "answer" }] } },
    {
      type: "assistant",
      uuid: "rate-limit-row",
      isApiErrorMessage: true,
      error: "rate_limit",
      message: { id: "synthetic", content: [{ type: "text", text: "You've hit your monthly spend limit." }] },
    },
  ];
  writeFileSync(join(project, "thread-split.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const provider = new ClaudeProvider(() => {}, { projectsDir: root });

  const result = await provider.readThread("thread-split");
  const items = result.thread.turns.flatMap((turn) => turn.items);

  assert.deepEqual(items.map((item) => ({ type: item.type, id: item.id, terminalId: item.terminalId })), [
    { type: "userMessage", id: undefined, terminalId: undefined },
    { type: "reasoning", id: "thinking-row:0", terminalId: undefined },
    { type: "agentMessage", id: "text-row:0", terminalId: undefined },
    { type: "turnError", id: undefined, terminalId: "claude:rate-limit-row" },
  ]);
  assert.equal(items.at(-1).code, "rate_limit");
});
