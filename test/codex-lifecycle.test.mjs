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

test("an account change during a cold resume recycles before starting work", async () => {
  const provider = new CodexProvider(() => {}, { idleReleaseMs: 1000, accountObserver: { start() {}, stop() {} } });
  let finishFirstResume;
  const firstResume = new Promise((resolve) => { finishFirstResume = resolve; });
  const clients = [];
  const stopped = [];
  provider.startThreadClient = (threadId) => {
    const client = { threadId, accountGeneration: provider.accountGeneration, child: {}, ready: Promise.resolve(), resumePromise: null };
    clients.push(client);
    return client;
  };
  provider.clientRpc = async (client, method) => {
    assert.equal(method, "thread/resume");
    if (client === clients[0]) { await firstResume; }
    return {};
  };
  provider.stopThreadClient = async (client) => { stopped.push(client); };

  const resuming = provider.ensureResumed("large-thread");
  await new Promise((resolve) => setImmediate(resolve));
  provider.accountGeneration = 1;
  finishFirstResume();

  assert.equal(await resuming, true);
  assert.equal(clients.length, 2);
  assert.deepEqual(stopped, [clients[0]]);
  assert.equal(provider.threadClients.get("large-thread"), clients[1]);
  assert.equal(clients[1].accountGeneration, 1);
  provider.cancelIdleRelease("large-thread");
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

test("a closed Codex stdin rejects RPCs instead of crashing the bridge", async () => {
  const provider = new CodexProvider(() => {});
  const closedStdin = {
    destroyed: false,
    writableEnded: false,
    write() { throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); },
  };
  provider.child = { stdin: closedStdin };

  await assert.rejects(
    provider.rpc("model/list", {}),
    (error) => error.status === 503 && error.code === "provider_unavailable",
  );
  assert.equal(provider.pendingRequests.size, 0);

  const client = { key: "thread-epipe", rpcId: 0, pending: new Map(), child: { stdin: closedStdin } };
  await assert.rejects(
    provider.clientRpc(client, "turn/start", { threadId: "thread-epipe" }),
    (error) => error.status === 504 && error.code === "delivery_uncertain",
  );
  assert.equal(client.pending.size, 0);
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

test("Codex native queue uses the pinned account process instead of the shared control process", async () => {
  const accountProfiles = {
    selectedProfileId: () => "account-work",
    contextForProfile: () => ({ profileId: "account-work", env: {}, expectedIdentity: { email: "work@example.com" } }),
  };
  const provider = new CodexProvider(() => {}, { accountProfiles, accountObserver: { start() {}, stop() {} } });
  const client = { profileId: "account-work", child: { exitCode: null, signalCode: null } };
  provider.profileClient = async () => client;
  provider.scheduleProfileClientRelease = () => {};
  let sharedCalls = 0;
  provider.rpc = async () => { sharedCalls += 1; };
  const calls = [];
  provider.clientRpc = async (_client, method, params) => {
    calls.push({ method, params });
    if (method === "thread/queue/list") { return { data: [], nextCursor: null }; }
    if (method === "thread/queue/add") { return { queuedSubmission: { id: "pinned-queue" } }; }
    return {};
  };

  const result = await provider.queue({ threadId: "thread-pinned", text: "continue", requestId: "request-pinned" });
  assert.equal(result.queuedSubmission.id, "pinned-queue");
  assert.equal(sharedCalls, 0);
  assert.deepEqual(calls.map(({ method }) => method), ["thread/queue/list", "thread/queue/add"]);
});

test("a pending account switch cannot queue a turn through the old account holder", async () => {
  const accountProfiles = { selectedProfileId: () => "account-new" };
  const provider = new CodexProvider(() => {}, { accountProfiles, accountObserver: { start() {}, stop() {} } });
  provider.threadClients.set("thread-switching", {
    profileId: "account-old",
    child: { exitCode: null, signalCode: null },
  });
  let writes = 0;
  provider.clientRpc = async () => { writes += 1; };

  await assert.rejects(
    provider.queueList({ threadId: "thread-switching" }),
    (error) => error.status === 409 && error.code === "codex_thread_account_switch_pending",
  );
  assert.equal(writes, 0);
});

test("a wedged pinned-account control process times out and is discarded", async () => {
  const accountProfiles = {
    contextForProfile: () => ({ profileId: "account-work", env: {}, expectedIdentity: { email: "work@example.com" } }),
    syncRuntimeProfile: () => false,
  };
  const provider = new CodexProvider(() => {}, {
    accountProfiles,
    accountObserver: { start() {}, stop() {} },
    profileStartTimeoutMs: 5,
  });
  let resolveReady;
  const client = {
    profileId: "account-work",
    profileControl: true,
    child: { exitCode: null, signalCode: null },
    ready: new Promise((resolve) => { resolveReady = resolve; }),
  };
  provider.startThreadClient = () => client;
  let stopped = 0;
  provider.stopThreadClient = async () => { stopped += 1; resolveReady(); };

  await assert.rejects(provider.profileClient("account-work"), (error) => error.code === "codex_account_start_timeout");
  assert.equal(stopped, 1);
  assert.equal(provider.profileClients.has("account-work"), false);
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
