import assert from "node:assert/strict";
import test from "node:test";

import { captureReplyStart, notificationBody, notificationTitle } from "../notification-content.mjs";

test("streamed notification previews retain the beginning of the final answer", () => {
  const beginning = "First, verify the database calls before changing the query. ";
  let captured = captureReplyStart("", beginning);

  captured = captureReplyStart(captured, "x".repeat(500));

  assert.equal(captured.startsWith(beginning), true);
  assert.equal(captured.length, 400);
  assert.equal(notificationBody(captured).startsWith("First, verify the database calls"), true);
});

test("notification title is only the normalized thread name", () => {
  assert.equal(notificationTitle("  Review AI   recommendations\nplan  "), "Review AI recommendations plan");
  assert.doesNotMatch(notificationTitle("Review AI recommendations"), /Codex|Claude|Grok|finished|failed/);
  assert.equal(notificationTitle(""), "Thread update");
});

test("notification bodies use the response start and preserve failure context", () => {
  const reply = "Opening summary. " + "later ".repeat(100);

  assert.equal(notificationBody(reply), reply.replace(/\s+/g, " ").trim().slice(0, 180));
  assert.equal(notificationBody("ignored", { failed: true, errorText: "Provider unavailable" }), "Provider unavailable");
  assert.equal(notificationBody("", { failed: true }), "Turn failed");
});
