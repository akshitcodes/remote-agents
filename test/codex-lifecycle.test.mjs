import assert from "node:assert/strict";
import test from "node:test";

import { CodexProvider } from "../providers/codex.mjs";

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test("an idle held Codex lease is released automatically", async () => {
  const events = [];
  const provider = new CodexProvider((event, data) => events.push({ event, data }), { idleReleaseMs: 10 });
  const client = { child: {} };
  let stops = 0;
  provider.resumedThreads.add("thread-a");
  provider.threadClients.set("thread-a", client);
  provider.stopThreadClient = async (value) => { assert.equal(value, client); stops += 1; };

  provider.scheduleIdleRelease("thread-a");
  await delay(30);

  assert.equal(stops, 1);
  assert.equal(provider.resumedThreads.has("thread-a"), false);
  assert.equal(provider.lockStatus("thread-a").state, "free");
});

test("idle release never stops a turn that is still active", async () => {
  const provider = new CodexProvider(() => {}, { idleReleaseMs: 10 });
  let stops = 0;
  provider.resumedThreads.add("thread-b");
  provider.threadClients.set("thread-b", { child: {} });
  provider.activeTurns.set("thread-b", "turn-b");
  provider.stopThreadClient = async () => { stops += 1; };

  provider.scheduleIdleRelease("thread-b");
  await delay(25);
  assert.equal(stops, 0);
  assert.equal(provider.resumedThreads.has("thread-b"), true);

  provider.activeTurns.delete("thread-b");
  await delay(25);
  assert.equal(stops, 1);
});

test("two concurrent sends cannot start parallel turns", async () => {
  const provider = new CodexProvider(() => {}, { idleReleaseMs: 1000 });
  let resume;
  provider.ensureResumed = () => new Promise((resolve) => { resume = resolve; });
  provider.clientRpc = async () => ({ turn: { id: "turn-c" } });
  provider.threadClients.set("thread-c", {});

  const first = provider.send({ threadId: "thread-c", text: "first" });
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    provider.send({ threadId: "thread-c", text: "second" }),
    (error) => error.status === 409 && error.code === "turn_in_progress",
  );

  resume(false);
  assert.deepEqual(await first, { turn: { id: "turn-c" } });
  assert.equal(provider.activeTurns.get("thread-c"), "turn-c");
});

test("a turn-started notification without an id still blocks idle release", () => {
  const provider = new CodexProvider(() => {}, { idleReleaseMs: 1000 });
  provider.resumedThreads.add("thread-d");
  provider.threadClients.set("thread-d", { child: {} });
  provider.scheduleIdleRelease("thread-d");

  provider.handleNotification({ method: "turn/started", params: { threadId: "thread-d" } });

  assert.equal(provider.activeTurns.get("thread-d"), "__unknown__");
  assert.equal(provider.idleReleaseTimers.has("thread-d"), false);
});

test("a send waits for an in-flight lease release before resuming", async () => {
  const provider = new CodexProvider(() => {}, { idleReleaseMs: 1000 });
  const oldClient = { child: {} };
  let finishRelease;
  let newStarts = 0;
  provider.resumedThreads.add("thread-e");
  provider.threadClients.set("thread-e", oldClient);
  provider.stopThreadClient = () => new Promise((resolve) => { finishRelease = resolve; });
  provider.startThreadClient = (threadId) => {
    newStarts += 1;
    return { threadId, child: {}, ready: Promise.resolve(), resumePromise: null };
  };
  provider.clientRpc = async () => ({});

  const release = provider.releaseThread({ threadId: "thread-e" });
  await new Promise((resolve) => setImmediate(resolve));
  const resume = provider.ensureResumed("thread-e");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(newStarts, 0);
  finishRelease();
  await release;
  assert.equal(await resume, true);
  assert.equal(newStarts, 1);
  assert.notEqual(provider.threadClients.get("thread-e"), oldClient);
});

test("rename re-arms idle release after its lease operation", async () => {
  const provider = new CodexProvider(() => {}, { idleReleaseMs: 1000 });
  provider.resumedThreads.add("thread-f");
  provider.threadClients.set("thread-f", { child: {} });
  provider.clientRpc = async () => ({ ok: true });

  assert.deepEqual(await provider.rename({ threadId: "thread-f", name: "new name" }), { ok: true });
  assert.equal(provider.idleReleaseTimers.has("thread-f"), true);
  provider.cancelIdleRelease("thread-f");
});

test("a turn-start RPC timeout is delivery-uncertain", async () => {
  const provider = new CodexProvider(() => {}, { rpcTimeoutMs: 5 });
  const client = { rpcId: 0, pending: new Map(), child: { stdin: { write() {} } } };

  await assert.rejects(
    provider.clientRpc(client, "turn/start", { threadId: "thread-g" }),
    (error) => error.status === 504 && error.code === "delivery_uncertain",
  );
});

test("completion before turn-start response does not resurrect an active turn", async () => {
  const provider = new CodexProvider(() => {}, { idleReleaseMs: 1000 });
  provider.ensureResumed = async () => false;
  provider.threadClients.set("thread-h", {});
  provider.clientRpc = async () => {
    provider.handleNotification({ method: "turn/started", params: { threadId: "thread-h", turn: { id: "turn-h" } } });
    provider.handleNotification({ method: "turn/completed", params: { threadId: "thread-h", turn: { id: "turn-h" } } });
    return { turn: { id: "turn-h" } };
  };

  await provider.send({ threadId: "thread-h", text: "quick" });
  assert.equal(provider.activeTurns.has("thread-h"), false);
  assert.equal(provider.startingTurns.has("thread-h"), false);
  provider.cancelIdleRelease("thread-h");
});
