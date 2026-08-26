import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { codexUserInput } from "../providers/codex.mjs";
import { claudeUserContent } from "../providers/claude.mjs";
import { GrokProvider, grokPromptContent } from "../providers/grok.mjs";
import { parseCliHelp } from "../cli-capabilities.mjs";

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("Codex prompt preserves text and trusted local image paths", () => {
  assert.deepEqual(codexUserInput("inspect this", [{ path: "/tmp/image.png" }]), [
    { type: "text", text: "inspect this" },
    { type: "localImage", path: "/tmp/image.png" },
  ]);
  assert.deepEqual(codexUserInput("", [{ path: "/tmp/image.png" }]), [
    { type: "localImage", path: "/tmp/image.png" },
  ]);
});

test("Claude prompt emits an Anthropic base64 image content block", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-phone-claude-image-"));
  const path = join(root, "image.png");
  writeFileSync(path, PNG_1PX);

  assert.deepEqual(claudeUserContent("inspect this", [{ path, mimeType: "image/png" }]), [
    { type: "text", text: "inspect this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX.toString("base64") } },
  ]);
});

test("Grok ACP image blocks are ready when the provider advertises image input", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-phone-grok-image-"));
  const path = join(root, "image.png");
  writeFileSync(path, PNG_1PX);

  assert.deepEqual(grokPromptContent("inspect this", [{ path, mimeType: "image/png" }]), [
    { type: "text", text: "inspect this" },
    { type: "image", mimeType: "image/png", data: PNG_1PX.toString("base64") },
  ]);
});

test("Grok explicitly rejects images instead of silently dropping them", async () => {
  const provider = new GrokProvider(() => {}, {
    capabilityFetcher: async () => ({
      agentCapabilities: { promptCapabilities: { image: false } },
      _meta: { modelState: { currentModelId: "grok-test", availableModels: [{ modelId: "grok-test", name: "Grok Test", _meta: { reasoningEfforts: [{ value: "high", default: true }] } }] } },
    }),
    cliCapabilityFetcher: async () => parseCliHelp("--always-approve\n--reasoning-effort <EFFORT>"),
  });

  await assert.rejects(
    provider.send({ threadId: "thread-grok", text: "inspect", attachments: [{ path: "/tmp/image.png" }] }),
    (error) => error.status === 409 && error.code === "images_unsupported",
  );
  await assert.rejects(
    provider.steer({ attachments: [{ path: "/tmp/image.png" }] }),
    (error) => error.status === 409 && error.code === "images_unsupported",
  );
});

test("Grok interrupt resolves only after cancellation reaches terminal state", async () => {
  const provider = new GrokProvider(() => {});
  let resolveTurn;
  let cancelled = false;
  const session = {
    busy: true,
    sessionId: "native-grok",
    conn: {
      cancel: async ({ sessionId }) => {
        assert.equal(sessionId, "native-grok");
        cancelled = true;
        setImmediate(() => { session.busy = false; resolveTurn(); });
      },
    },
    turnDone: new Promise((resolve) => { resolveTurn = resolve; }),
  };
  provider.sessions.set("thread-grok", session);

  assert.deepEqual(await provider.interrupt({ threadId: "thread-grok", requireActive: true }), { ok: true });
  assert.equal(cancelled, true);
  assert.equal(session.busy, false);
});

test("Grok cancel-before-send refuses when this bridge does not own the active prompt", async () => {
  const provider = new GrokProvider(() => {});

  await assert.rejects(
    provider.interrupt({ threadId: "running-somewhere-else", requireActive: true }),
    (error) => error.status === 409 && error.code === "not_our_turn",
  );
});
