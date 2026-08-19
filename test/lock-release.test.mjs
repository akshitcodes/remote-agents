import assert from "node:assert/strict";
import test from "node:test";

import { claudeTurnError } from "../providers/claude.mjs";
import { mapThreadConflict } from "../providers/codex.mjs";
import { releaseThreadLock } from "../server.mjs";

test("release refuses while the server tracks an active turn", async () => {
  let released = false;
  const provider = {
    name: "codex",
    async releaseThread() { released = true; },
  };
  const activeTurns = new Set(["codex:thread-a"]);

  await assert.rejects(
    releaseThreadLock(provider, "thread-a", activeTurns),
    (error) => error.status === 409 && error.code === "turn_in_progress",
  );
  assert.equal(released, false);
});

test("release delegates when no turn is active", async () => {
  const provider = {
    name: "codex",
    async releaseThread({ threadId }) { return { threadId, state: "free" }; },
  };

  assert.deepEqual(await releaseThreadLock(provider, "thread-a", new Set()), {
    threadId: "thread-a",
    state: "free",
  });
});

test("Codex writer conflicts have a stable client code", () => {
  const error = Object.assign(new Error("rpc failed"), {
    rpc: { data: { detail: "thread-store conflict: thread-a already has an active writer" } },
  });
  const mapped = mapThreadConflict(error);

  assert.equal(mapped.status, 409);
  assert.equal(mapped.code, "thread_locked_elsewhere");
  assert.equal(mapped.message, "this thread is open on your Mac; close it there to continue");

  const currentShape = mapThreadConflict(new Error("thread thread-a already has an active writer"));
  assert.equal(currentShape.code, "thread_locked_elsewhere");
});

test("Claude background-agent refusals use the same stable code", () => {
  assert.deepEqual(claudeTurnError("Session abc is currently running as a background agent (bg)"), {
    message: "this thread is open on your Mac; close it there to continue",
    code: "thread_locked_elsewhere",
  });
});
