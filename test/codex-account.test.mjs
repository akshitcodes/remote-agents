import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexAccountObserver, readCodexAccountIdentity } from "../codex-account.mjs";
import { CodexProvider } from "../providers/codex.mjs";

function jwt(claims) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

test("Codex auth identity keeps only stable non-secret account fields", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "remote-agents-codex-account-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.json");
  const value = {
    tokens: {
      account_id: "account-a",
      access_token: "must-not-leak",
      refresh_token: "must-not-leak-either",
      id_token: jwt({ sub: "user-a", email: "a@example.com" }),
    },
  };
  writeFileSync(path, JSON.stringify(value));
  const identity = readCodexAccountIdentity(path);
  assert.deepEqual(identity, { key: "user-a::account-a", accountId: "account-a", userId: "user-a", email: "a@example.com" });
  assert.doesNotMatch(JSON.stringify(identity), /must-not-leak/);
});

test("Codex account observer ignores transient reads and same-account token refreshes", () => {
  const a = { key: "user-a::account-a", accountId: "account-a", userId: "user-a", email: "a@example.com" };
  const b = { key: "user-b::account-b", accountId: "account-b", userId: "user-b", email: "b@example.com" };
  const reads = [a, null, { ...a }, b];
  let readIndex = 0;
  const changes = [];
  const observer = new CodexAccountObserver({
    readIdentity: () => readIndex < reads.length ? reads[readIndex++] : b,
    onChange: (change) => changes.push(change),
    intervalMs: 60_000,
  });

  observer.start();
  assert.equal(observer.check(), null);
  assert.equal(observer.check(), null);
  assert.deepEqual(observer.check(), { previous: a, current: b });
  assert.equal(changes.length, 1);
  observer.stop();
});

test("first valid login after startup rotates a process that began signed out", () => {
  const identity = { key: "user-a::account-a", accountId: "account-a", userId: "user-a", email: "a@example.com" };
  const reads = [null, identity];
  let readIndex = 0;
  const changes = [];
  const observer = new CodexAccountObserver({
    readIdentity: () => readIndex < reads.length ? reads[readIndex++] : identity,
    onChange: (change) => changes.push(change),
    intervalMs: 60_000,
  });

  assert.equal(observer.start(), null);
  assert.deepEqual(observer.check(), { previous: null, current: identity });
  assert.deepEqual(changes, [{ previous: null, current: identity }]);
  observer.stop();
});

test("account switching rotates control and idle holders without stopping a live turn", async () => {
  const events = [];
  const provider = new CodexProvider((event, data) => events.push({ event, data }), {
    accountObserver: { start() {}, stop() {} },
    accountReleaseGraceMs: 10,
  });
  let controlStops = 0;
  provider.child = { accountGeneration: 0, exitCode: null, signalCode: null, kill() { controlStops += 1; } };
  const idleClient = { accountGeneration: 0, child: {} };
  const liveClient = { accountGeneration: 0, child: {} };
  provider.resumedThreads.add("idle");
  provider.resumedThreads.add("live");
  provider.threadClients.set("idle", idleClient);
  provider.threadClients.set("live", liveClient);
  provider.activeTurns.set("live", "turn-live");
  const stopped = [];
  provider.stopThreadClient = async (client) => { stopped.push(client); };
  provider.startThreadClient = (threadId) => ({ threadId, accountGeneration: provider.accountGeneration, child: {}, ready: Promise.resolve(), resumePromise: null });
  provider.clientRpc = async () => ({});

  provider.handleAccountIdentityChange({
    previous: { key: "user-a::account-a", accountId: "account-a", userId: "user-a", email: "a@example.com" },
    current: { key: "user-b::account-b", accountId: "account-b", userId: "user-b", email: "b@example.com" },
  });
  assert.equal(controlStops, 1);
  assert.deepEqual(stopped, []);
  assert.equal(provider.resumedThreads.has("live"), true);
  assert.equal(provider.activeTurns.get("live"), "turn-live");
  assert.ok(events.some(({ data }) => data?.method === "account/changing"));

  await provider.ensureResumed("idle");
  assert.deepEqual(stopped, [idleClient]);
  assert.equal(provider.threadClients.get("idle").accountGeneration, 1);

  provider.handleNotification({ method: "turn/completed", params: { threadId: "live", turn: { id: "turn-live" } } }, liveClient);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(stopped, [idleClient, liveClient]);
  assert.equal(provider.resumedThreads.has("live"), false);
});

test("a provider-native queued turn cancels stale-holder recycling after an account switch", async () => {
  const provider = new CodexProvider(() => {}, {
    accountObserver: { start() {}, stop() {} },
    accountReleaseGraceMs: 20,
  });
  const client = { accountGeneration: 0, child: {} };
  provider.accountGeneration = 1;
  provider.resumedThreads.add("queued");
  provider.threadClients.set("queued", client);
  provider.activeTurns.set("queued", "turn-one");
  const stopped = [];
  provider.stopThreadClient = async (value) => { stopped.push(value); };

  provider.handleNotification({
    method: "turn/completed",
    params: { threadId: "queued", turn: { id: "turn-one" } },
  }, client);
  provider.handleNotification({
    method: "turn/started",
    params: { threadId: "queued", turn: { id: "turn-two" } },
  }, client);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(stopped, []);
  assert.equal(provider.resumedThreads.has("queued"), true);
  assert.equal(provider.activeTurns.get("queued"), "turn-two");
});

test("usage from a preserved old-account turn cannot poison the new account cache", () => {
  const events = [];
  const provider = new CodexProvider((event, data) => events.push({ event, data }), { accountObserver: { start() {}, stop() {} } });
  provider.accountGeneration = 2;
  provider.cache.account = { rateLimits: { primary: { usedPercent: 10 } } };

  provider.handleNotification({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 100 } } } }, { accountGeneration: 1 });

  assert.equal(provider.cache.account.rateLimits.primary.usedPercent, 10);
  assert.equal(events.length, 0);
});

test("automatic resumes are not awakened until the fresh process confirms the switched account", async () => {
  const events = [];
  let processStops = 0;
  const child = { accountGeneration: 1, exitCode: null, signalCode: null, kill() { processStops += 1; } };
  const provider = new CodexProvider((event, data) => events.push({ event, data }), { accountObserver: { start() {}, stop() {} } });
  provider.accountGeneration = 1;
  provider.child = child;
  provider.pendingAccountChange = {
    generation: 1,
    previous: { key: "user-a::account-a", email: "a@example.com" },
    current: { key: "user-b::account-b", email: "b@example.com" },
  };
  provider.usage = async () => ({ account: { email: "a@example.com" }, rateLimits: { primary: { usedPercent: 100 } } });

  await provider.confirmAccountChange(child);

  assert.equal(processStops, 1);
  assert.equal(provider.pendingAccountChange.generation, 1);
  assert.ok(!events.some(({ data }) => data?.method === "account/changed"));
});

test("changing a live thread account preserves the turn and applies the selection only afterward", async () => {
  let selected = "shared";
  const accountProfiles = {
    selectedProfileId: () => selected,
    setThreadProfile: (_threadId, profileId) => { selected = profileId; return selected; },
    publicThreadState: (_threadId, effectiveProfileId) => ({
      accounts: [], selectedProfileId: selected, effectiveProfileId,
      switchPending: !!effectiveProfileId && effectiveProfileId !== selected,
    }),
  };
  const provider = new CodexProvider(() => {}, { accountObserver: { start() {}, stop() {} }, accountProfiles });
  const holder = { profileId: "shared", child: {} };
  provider.resumedThreads.add("thread-live");
  provider.threadClients.set("thread-live", holder);
  provider.activeTurns.set("thread-live", "turn-live");
  let releases = 0;
  provider.releaseThread = async () => { releases += 1; };

  const live = await provider.setThreadAccount({ threadId: "thread-live", profileId: "account-work" });
  assert.equal(live.switchPending, true);
  assert.equal(releases, 0);
  assert.equal(provider.activeTurns.get("thread-live"), "turn-live");

  provider.activeTurns.delete("thread-live");
  await provider.setThreadAccount({ threadId: "thread-live", profileId: "account-work" });
  assert.equal(releases, 1);
});

test("global Codex login changes do not rotate a holder pinned to another account", async () => {
  const provider = new CodexProvider(() => {}, { accountObserver: { start() {}, stop() {} }, accountReleaseGraceMs: 5 });
  provider.child = { accountGeneration: 0, exitCode: null, signalCode: null, kill() {} };
  const holder = { profileId: "account-work", accountGeneration: null, child: {} };
  provider.resumedThreads.add("thread-pinned");
  provider.threadClients.set("thread-pinned", holder);
  let stops = 0;
  provider.stopThreadClient = async () => { stops += 1; };

  provider.handleAccountIdentityChange({
    previous: { key: "user-a::account-a", email: "a@example.com" },
    current: { key: "user-b::account-b", email: "b@example.com" },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(stops, 0);
  assert.equal(provider.resumedThreads.has("thread-pinned"), true);
});
