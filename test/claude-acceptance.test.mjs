import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
