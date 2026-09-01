import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BridgeTurnState } from "../bridge-turn-state.mjs";

test("an active bridge-owned turn becomes an exact interruption after restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "bridge-turn-state-")), "turns.json");
  let now = 1000;
  const first = new BridgeTurnState({ file, now: () => now });
  first.started({ provider: "codex", threadId: "thread-a", turnId: "turn-a" });

  now = 2000;
  const restarted = new BridgeTurnState({ file, now: () => now });
  assert.deepEqual(restarted.get("codex", "thread-a"), {
    provider: "codex",
    threadId: "thread-a",
    turnId: "turn-a",
    state: "interrupted",
    reason: "bridge_restarted",
    interruptedAt: 2000,
    at: 2000,
  });
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].state, "interrupted");
});

test("normal completion removes the durable active-turn record", () => {
  const file = join(mkdtempSync(join(tmpdir(), "bridge-turn-state-")), "turns.json");
  const state = new BridgeTurnState({ file, now: () => 1000 });
  state.started({ provider: "claude", threadId: "thread-b", turnId: "turn-b" });
  state.finished("claude", "thread-b");
  assert.equal(state.get("claude", "thread-b"), null);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
});

test("adopting a draft thread carries lifecycle ownership to its real id", () => {
  const file = join(mkdtempSync(join(tmpdir(), "bridge-turn-state-")), "turns.json");
  const state = new BridgeTurnState({ file, now: () => 1000 });
  state.started({ provider: "codex", threadId: "draft", turnId: "turn-c" });
  state.adopted({ provider: "codex", fromThreadId: "draft", threadId: "real" });
  assert.equal(state.get("codex", "draft"), null);
  assert.equal(state.get("codex", "real")?.turnId, "turn-c");
});
