import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ThreadSubscriptions } from "../thread-subscriptions.mjs";

function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), "codex-phone-subs-")), "rules.json");
  return { file, subscriptions: new ThreadSubscriptions({ file }) };
}

test("a new subscription baselines the current terminal instead of replaying it", () => {
  const { subscriptions } = fixture();
  subscriptions.set({ endpoint: "device-a", provider: "codex", threadId: "parent", mode: "once", terminalId: "done-1" });

  assert.deepEqual(subscriptions.observe({ provider: "codex", threadId: "parent", terminalId: "done-1" }), []);
  const deliveries = subscriptions.observe({ provider: "codex", threadId: "parent", terminalId: "done-2" });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].endpoint, "device-a");
  assert.equal(subscriptions.list("device-a").length, 0);
});

test("follow is per-device, deduplicated, and durable across restart", () => {
  const { file, subscriptions } = fixture();
  subscriptions.set({ endpoint: "device-a", provider: "claude", threadId: "task", mode: "follow" });
  subscriptions.set({ endpoint: "device-b", provider: "claude", threadId: "task", mode: "follow" });

  assert.equal(subscriptions.observe({ provider: "claude", threadId: "task", terminalId: "done-1" }).length, 2);
  assert.deepEqual(subscriptions.observe({ provider: "claude", threadId: "task", terminalId: "done-1" }), []);

  const restarted = new ThreadSubscriptions({ file });
  assert.deepEqual(restarted.observe({ provider: "claude", threadId: "task", terminalId: "done-1" }), []);
  assert.deepEqual(restarted.observe({ provider: "claude", threadId: "task", terminalId: "done-2" }).map((d) => d.endpoint).sort(), ["device-a", "device-b"]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});

test("unsubscribing a device removes its rules and watcher interest", () => {
  const { subscriptions } = fixture();
  subscriptions.set({ endpoint: "device-a", provider: "grok", threadId: "one", mode: "follow" });
  subscriptions.set({ endpoint: "device-b", provider: "grok", threadId: "two", mode: "follow" });

  assert.equal(subscriptions.removeEndpoint("device-a"), true);
  assert.deepEqual(subscriptions.list("device-a"), []);
  assert.deepEqual(subscriptions.interests(), [{ provider: "grok", id: "two" }]);
});

test("expired push endpoints cannot leave permanent background watchers", () => {
  const { subscriptions } = fixture();
  subscriptions.set({ endpoint: "alive", provider: "codex", threadId: "one", mode: "follow" });
  subscriptions.set({ endpoint: "expired", provider: "codex", threadId: "two", mode: "follow" });
  assert.equal(subscriptions.pruneEndpoints((endpoint) => endpoint === "alive"), true);
  assert.deepEqual(subscriptions.interests(), [{ provider: "codex", id: "one" }]);
});

test("a suppressed completion advances the cursor without consuming once", () => {
  const { subscriptions } = fixture();
  subscriptions.set({ endpoint: "device", provider: "codex", threadId: "task", mode: "once", terminalId: "old" });
  assert.equal(subscriptions.acknowledge({ provider: "codex", threadId: "task", terminalId: "seen-on-screen" }), true);
  assert.equal(subscriptions.list("device")[0].mode, "once");
  assert.deepEqual(subscriptions.observe({ provider: "codex", threadId: "task", terminalId: "seen-on-screen" }), []);
  assert.equal(subscriptions.observe({ provider: "codex", threadId: "task", terminalId: "next-external" }).length, 1);
});

test("per-device subscription count is bounded", () => {
  const { subscriptions } = fixture();
  for (let index = 0; index < 50; index++) {
    subscriptions.set({ endpoint: "device", provider: "codex", threadId: `task-${index}`, mode: "follow" });
  }
  assert.throws(() => subscriptions.set({ endpoint: "device", provider: "codex", threadId: "task-overflow", mode: "follow" }), /limit reached/);
});

test("invalid rules are rejected and off is idempotent", () => {
  const { subscriptions } = fixture();
  assert.throws(() => subscriptions.set({ endpoint: "device", threadId: "task", mode: "sometimes" }), /once, follow, or off/);
  assert.throws(() => subscriptions.set({ mode: "follow" }), /required/);
  assert.deepEqual(subscriptions.set({ endpoint: "device", provider: "codex", threadId: "task", mode: "off" }), {
    mode: "off", provider: "codex", threadId: "task",
  });
});
