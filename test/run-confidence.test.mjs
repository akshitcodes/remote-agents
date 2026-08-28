import assert from "node:assert/strict";
import test from "node:test";

import { classifyRunningState, observeProviderTail } from "../watch.mjs";
import { resolveThreadRunState, shouldEmitExternalUpdate } from "../server.mjs";

test("missing tail markers remain explicitly heuristic", () => {
  assert.deepEqual(classifyRunningState(null, 1_000), {
    running: true,
    confidence: "heuristic",
  });
  assert.deepEqual(classifyRunningState(null, 120_000), {
    running: false,
    confidence: "heuristic",
  });
});

test("only explicit completion is classified as a marker-backed idle state", () => {
  assert.deepEqual(classifyRunningState(false, 1_000), {
    running: false,
    confidence: "marker",
  });
  assert.deepEqual(classifyRunningState(true, 1_000), {
    running: true,
    confidence: "marker",
  });
});

test("a stale start marker is not promoted to confirmed completion", () => {
  assert.deepEqual(classifyRunningState(true, 3 * 60 * 1000), {
    running: true,
    confidence: "stalled",
  });
  assert.deepEqual(classifyRunningState(true, 11 * 60 * 1000), {
    running: false,
    confidence: "stale_timeout",
  });
  assert.deepEqual(classifyRunningState(true, 31 * 60 * 1000), {
    running: false,
    confidence: "historical_stale",
  });
});

test("Codex, Claude, and Grok expose exact terminal cursors", () => {
  const codex = observeProviderTail("codex", [JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } })]);
  const claude = observeProviderTail("claude", [JSON.stringify({ type: "assistant", uuid: "message-1", message: { stop_reason: "end_turn" } })]);
  const grok = observeProviderTail("grok", [
    JSON.stringify({ type: "user", prompt_index: 7, content: "Do it" }),
    JSON.stringify({ type: "assistant", content: "Finished", tool_calls: [] }),
  ]);

  assert.deepEqual(codex, { running: false, terminalId: "codex:turn-1", terminalOutcome: "completed", terminalText: "", terminalError: null });
  assert.deepEqual(claude, { running: false, terminalId: "claude:message-1", terminalOutcome: "completed", terminalText: "", terminalError: null });
  assert.equal(grok.running, false);
  assert.equal(grok.terminalOutcome, "completed");
  assert.match(grok.terminalId, /^grok:7:/);
});

test("provider terminal errors retain their exact message and machine code", () => {
  const codex = observeProviderTail("codex", [JSON.stringify({
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "turn-limit",
      error: { message: "Your workspace is out of credits. Add credits to continue.", codex_error_info: "usage_limit_exceeded" },
    },
  })]);
  const claude = observeProviderTail("claude", [JSON.stringify({
    type: "assistant",
    uuid: "message-limit",
    message: { stop_reason: "max_tokens", content: [{ type: "text", text: "Maximum output reached" }] },
  })]);

  assert.equal(codex.terminalOutcome, "failed");
  assert.deepEqual(codex.terminalError, { message: "Your workspace is out of credits. Add credits to continue.", code: "usage_limit_exceeded" });
  assert.equal(claude.terminalOutcome, "failed");
  assert.deepEqual(claude.terminalError, { message: "Maximum output reached", code: null });
});

test("a Codex turn_aborted marker clears a preceding task_started state", () => {
  const observation = observeProviderTail("codex", [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-aborted" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-aborted", reason: "interrupted" } }),
  ]);

  assert.deepEqual(observation, {
    running: false,
    terminalId: "codex:turn-aborted",
    terminalOutcome: "aborted",
    terminalText: "",
    terminalError: null,
  });
});

test("tool traffic is not mistaken for a completed turn", () => {
  assert.equal(observeProviderTail("claude", [JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use" } })]), null);
  assert.equal(observeProviderTail("grok", [JSON.stringify({ type: "assistant", content: "Calling", tool_calls: [{ id: "tool" }] })]), null);
});

test("a bridge terminal overrides only its exact stale Claude prompt marker", () => {
  const firstPrompt = observeProviderTail("claude", [JSON.stringify({
    type: "user",
    uuid: "prompt-1",
    message: { role: "user", content: "Follow up" },
  })]);
  const terminal = { at: Date.now(), activeMarkerId: firstPrompt.activeMarkerId };

  assert.deepEqual(resolveThreadRunState({ observed: { ...firstPrompt, confidence: "marker" }, bridgeTerminal: terminal }), {
    running: false,
    confidence: "bridge_terminal",
    source: "bridge",
    turnId: null,
  });

  const laterPrompt = observeProviderTail("claude", [JSON.stringify({
    type: "user",
    uuid: "prompt-2",
    message: { role: "user", content: "A genuinely new turn" },
  })]);

  assert.equal(resolveThreadRunState({
    observed: { ...laterPrompt, confidence: "marker" },
    bridgeTerminal: terminal,
  }).running, true);
});

test("an owned turn remains running even if an older terminal marker exists", () => {
  assert.deepEqual(resolveThreadRunState({
    owned: true,
    observed: { running: false, confidence: "marker" },
    bridgeTerminal: { at: Date.now(), activeMarkerId: "claude-user:old" },
    turnId: "turn-live",
  }), {
    running: true,
    confidence: "bridge",
    source: "bridge",
    turnId: "turn-live",
  });
});

test("session-file updates cannot race a bridge-owned provider stream", () => {
  const turns = new Set(["claude:thread-live"]);

  assert.equal(shouldEmitExternalUpdate("claude", "thread-live", turns), false);
  assert.equal(shouldEmitExternalUpdate("claude", "thread-external", turns), true);
  turns.delete("claude:thread-live");
  assert.equal(shouldEmitExternalUpdate("claude", "thread-live", turns), true);
});
