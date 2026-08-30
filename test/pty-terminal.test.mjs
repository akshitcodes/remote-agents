import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PtyTerminalManager } from "../pty-terminal.mjs";

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.pid = 1234;
    this.stderr = new EventEmitter();
    this.sent = [];
    setImmediate(() => this.emit("message", { type: "ready" }));
  }
  send(message) {
    this.sent.push(message);
    if (message.type === "create") {
      setImmediate(() => this.emit("message", { type: "response", requestId: message.requestId, ok: true, pid: 99 }));
    }
  }
  kill() {}
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.frames = [];
  }
  send(value) { this.frames.push(JSON.parse(value)); }
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
}

test("PTY sessions are isolated by device and survive a socket reconnect", async () => {
  const worker = new FakeWorker();
  const manager = new PtyTerminalManager({ workerFactory: () => worker, detachedTtlMs: 10_000 });
  const context = { provider: "codex", threadId: "thread-1", cwd: "/tmp/project" };
  const firstSocket = new FakeSocket();
  const session = await manager.attach(firstSocket, { deviceId: "device-1", context, cols: 80, rows: 24 });
  assert.equal(firstSocket.frames[0].type, "ready");

  worker.emit("message", { type: "output", sessionId: session.id, data: "hello\r\n" });
  assert.equal(firstSocket.frames.at(-1).data, "hello\r\n");
  manager.input(session, "pwd\r", 7);
  assert.equal(worker.sent.at(-1).type, "input");
  assert.equal(firstSocket.frames.at(-1).type, "ack");

  manager.detach(session, firstSocket);
  const secondSocket = new FakeSocket();
  const reattached = await manager.attach(secondSocket, { deviceId: "device-1", context, cols: 100, rows: 30 });
  assert.equal(reattached.id, session.id);
  assert.equal(secondSocket.frames[0].replay, "hello\r\n");

  manager.revoke({ deviceIds: ["device-1"], reason: "revoked" });
  assert.equal(secondSocket.closed.reason, "revoked");
  assert.equal(manager.sessions.size, 0);
});

test("a terminal worker crash closes terminals without escaping the manager", async () => {
  const worker = new FakeWorker();
  const manager = new PtyTerminalManager({ workerFactory: () => worker });
  const socket = new FakeSocket();
  await manager.attach(socket, {
    deviceId: "device-1",
    context: { provider: "claude", threadId: "thread-2", cwd: "/tmp/project" },
  });
  worker.emit("exit", 1, null);
  assert.equal(manager.sessions.size, 0);
  assert.equal(socket.closed.reason, "terminal backend stopped");
});
