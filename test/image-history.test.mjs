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
