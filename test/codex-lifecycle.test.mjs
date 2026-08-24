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

test("warm retries a previously observed external lock", async () => {
  const provider = new CodexProvider(() => {}, { idleReleaseMs: 1000 });
  let holderStarts = 0;
  provider.conflictedThreads.add("thread-retry");
  provider.startThreadClient = (threadId) => {
    holderStarts += 1;
    return { threadId, child: {}, ready: Promise.resolve(), resumePromise: null };
  };
  provider.clientRpc = async (_client, method) => {
    assert.equal(method, "thread/resume");
    return {};
  };

  const result = await provider.warmThread({ threadId: "thread-retry" });

  assert.equal(holderStarts, 1);
  assert.equal(result.state, "held");
  assert.equal(provider.conflictedThreads.has("thread-retry"), false);
  provider.cancelIdleRelease("thread-retry");
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

test("reconnected clients steer and interrupt with the holder's authoritative turn id", async () => {
  const provider = new CodexProvider(() => {}, { idleReleaseMs: 1000 });
  const calls = [];
  provider.activeTurns.set("thread-owned", "turn-current");
  provider.threadClients.set("thread-owned", {});
  provider.clientRpc = async (_client, method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };

  await provider.steer({
    threadId: "thread-owned",
    text: "change direction",
    requestId: "client-message-1",
  });
  await provider.interrupt({ threadId: "thread-owned" });

  assert.equal(provider.activeTurnId("thread-owned"), "turn-current");
  assert.deepEqual(calls[0], {
    method: "turn/steer",
    params: {
      threadId: "thread-owned",
      input: [{ type: "text", text: "change direction" }],
      expectedTurnId: "turn-current",
      clientUserMessageId: "client-message-1",
    },
  });
  assert.deepEqual(calls[1], {
    method: "turn/interrupt",
    params: { threadId: "thread-owned", turnId: "turn-current" },
  });
});

test("Codex steer rejects a replacement turn instead of steering work the user did not see", async () => {
  const provider = new CodexProvider(() => {});
  provider.activeTurns.set("thread-owned", "turn-new");
  provider.threadClients.set("thread-owned", {});

  await assert.rejects(
    provider.steer({ threadId: "thread-owned", text: "for turn old", expectedTurnId: "turn-old" }),
    (error) => error.status === 409 && error.code === "turn_changed",
  );
});

test("Codex native queue reconciles by client id and supports edit and cancel", async () => {
  const provider = new CodexProvider(() => {});
  provider.ready = async () => {};
  const calls = [];
  let listed = [];
  provider.rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/queue/list") { return { data: listed, nextCursor: null }; }
    if (method === "thread/queue/add") {
      const queuedSubmission = { id: "queued-1", clientUserMessageId: params.clientUserMessageId, input: params.input };
      listed = [queuedSubmission];
      return { queuedSubmission };
    }
    return {};
  };

  const first = await provider.queue({ threadId: "external", text: "follow up", requestId: "client-queue-1" });
  const replay = await provider.queue({ threadId: "external", text: "follow up", requestId: "client-queue-1" });
  await provider.queueUpdate({ threadId: "external", queuedSubmissionId: "queued-1", text: "edited" });
  await provider.queueDelete({ threadId: "external", queuedSubmissionId: "queued-1" });

  assert.equal(first.queuedSubmission.id, "queued-1");
  assert.equal(replay.reconciled, true);
  assert.equal(calls.filter((call) => call.method === "thread/queue/add").length, 1);
  assert.deepEqual(calls.at(-2), {
    method: "thread/queue/update",
    params: { threadId: "external", queuedSubmissionId: "queued-1", input: [{ type: "text", text: "edited" }] },
  });
  assert.deepEqual(calls.at(-1), {
    method: "thread/queue/delete",
    params: { threadId: "external", queuedSubmissionId: "queued-1" },
  });
});

test("Codex native queue reconciles an accepted add whose response was lost", async () => {
  const provider = new CodexProvider(() => {});
  provider.ready = async () => {};
  let listCalls = 0;
  provider.rpc = async (method, params) => {
    if (method === "thread/queue/list") {
      listCalls += 1;
      return listCalls === 1
        ? { data: [] }
        : { data: [{ id: "queued-after-timeout", clientUserMessageId: "stable-client-id", input: params.input }] };
    }
    if (method === "thread/queue/add") { throw new Error("rpc timeout: thread/queue/add"); }
    throw new Error(`unexpected method ${method}`);
  };

  const result = await provider.queue({ threadId: "external", text: "only once", requestId: "stable-client-id" });

  assert.equal(result.reconciled, true);
  assert.equal(result.queuedSubmission.id, "queued-after-timeout");
  assert.equal(listCalls, 2);
});

test("Codex native queue validates list, edit, and delete identifiers", async () => {
  const provider = new CodexProvider(() => {});

  await assert.rejects(provider.queueList({}), (error) => error.status === 400 && error.code === "invalid_queue_request");
  await assert.rejects(provider.queueUpdate({ threadId: "t", text: "x" }), (error) => error.status === 400 && error.code === "invalid_queue_request");
  await assert.rejects(provider.queueDelete({ threadId: "t" }), (error) => error.status === 400 && error.code === "invalid_queue_request");
});

test("concurrent Codex native queue retries share one add operation", async () => {
  const provider = new CodexProvider(() => {});
  provider.ready = async () => {};
  let addCalls = 0;
  provider.rpc = async (method, params) => {
    if (method === "thread/queue/list") { return { data: [], nextCursor: null }; }
    if (method === "thread/queue/add") {
      addCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { queuedSubmission: { id: "one-add", clientUserMessageId: params.clientUserMessageId } };
    }
    throw new Error(`unexpected method ${method}`);
  };

  const body = { threadId: "external", text: "same message", requestId: "same-client-id" };
  const [first, second] = await Promise.all([provider.queue(body), provider.queue(body)]);

  assert.equal(addCalls, 1);
  assert.equal(first.queuedSubmission.id, "one-add");
  assert.equal(second.queuedSubmission.id, "one-add");
});
