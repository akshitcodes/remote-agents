import assert from "node:assert/strict";
import test from "node:test";

import { classifyRunningState, observeProviderTail } from "../watch.mjs";

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
  assert.deepEqual(classifyRunningState(true, 11 * 60 * 1000), {
    running: false,
    confidence: "stale_timeout",
  });
});

test("Codex, Claude, and Grok expose exact terminal cursors", () => {
  const codex = observeProviderTail("codex", [JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } })]);
  const claude = observeProviderTail("claude", [JSON.stringify({ type: "assistant", uuid: "message-1", message: { stop_reason: "end_turn" } })]);
  const grok = observeProviderTail("grok", [
    JSON.stringify({ type: "user", prompt_index: 7, content: "Do it" }),
    JSON.stringify({ type: "assistant", content: "Finished", tool_calls: [] }),
  ]);

  assert.deepEqual(codex, { running: false, terminalId: "codex:turn-1", terminalOutcome: "completed", terminalText: "" });
  assert.deepEqual(claude, { running: false, terminalId: "claude:message-1", terminalOutcome: "completed", terminalText: "" });
  assert.equal(grok.running, false);
  assert.equal(grok.terminalOutcome, "completed");
  assert.match(grok.terminalId, /^grok:7:/);
});

test("tool traffic is not mistaken for a completed turn", () => {
  assert.equal(observeProviderTail("claude", [JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use" } })]), null);
  assert.equal(observeProviderTail("grok", [JSON.stringify({ type: "assistant", content: "Calling", tool_calls: [{ id: "tool" }] })]), null);
});
