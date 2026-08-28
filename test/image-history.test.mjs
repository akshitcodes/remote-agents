import assert from "node:assert/strict";
import test from "node:test";

import { feedLines, newParseState } from "../codex-rollout.mjs";

test("Codex rollout replay retains image-only and mixed user prompts", () => {
  const state = newParseState();
  feedLines(state, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "", images: ["data:image/png;base64,..."], local_images: [] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "inspect", images: [], local_images: ["/tmp/a.png"] } }),
  ]);

  assert.deepEqual(state.turns[0].items[0].content, [{ type: "image" }]);
  assert.deepEqual(state.turns[0].items[1].content, [
    { type: "text", text: "inspect" },
    { type: "localImage" },
  ]);
});

test("Codex rollout replay preserves provider terminal errors", () => {
  const state = newParseState();
  feedLines(state, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-limit",
        error: { message: "Your workspace is out of credits. Add credits to continue.", codex_error_info: "usage_limit_exceeded" },
      },
    }),
  ]);

  assert.deepEqual(state.turns[0].items[0], {
    id: "turn-error:turn-limit",
    type: "turnError",
    terminalId: "codex:turn-limit",
    code: "usage_limit_exceeded",
    message: "Your workspace is out of credits. Add credits to continue.",
  });
});

test("Codex rollout replay reads current response-item messages", () => {
  const state = newParseState();
  feedLines(state, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", id: "context", role: "user", content: [{ type: "input_text", text: "<environment_context>hidden</environment_context>" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", id: "user-1", role: "user", content: [{ type: "input_text", text: "Can you inspect this?" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", id: "user-image", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,..." }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", id: "agent-1", role: "assistant", content: [{ type: "output_text", text: "Yes, here is the result." }], phase: "final_answer" } }),
  ]);

  assert.deepEqual(state.turns[0].items, [
    { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Can you inspect this?" }] },
    { id: "user-image", type: "userMessage", content: [{ type: "image" }] },
    { id: "agent-1", type: "agentMessage", text: "Yes, here is the result." },
  ]);
});

test("Codex rollout replay deduplicates mixed legacy and response-item messages", () => {
  const state = newParseState();
  feedLines(state, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Same prompt" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", id: "user-mirror", role: "user", content: [{ type: "input_text", text: "Same prompt" }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Same answer" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", id: "agent-mirror", role: "assistant", content: [{ type: "output_text", text: "Same answer" }] } }),
  ]);

  assert.equal(state.turns[0].items.filter((item) => item.type === "userMessage").length, 1);
  assert.equal(state.turns[0].items.filter((item) => item.type === "agentMessage").length, 1);
});
