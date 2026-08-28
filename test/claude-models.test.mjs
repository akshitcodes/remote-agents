import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeProvider } from "../providers/claude.mjs";
import { ThreadSettingsService, ThreadSettingsStore } from "../thread-settings.mjs";

function fixtureDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "codex-phone-claude-models-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function claudeBinary(t, root) {
  const path = join(root, "claude-fixture");
  writeFileSync(path, `#!/bin/sh
cat <<'EOF'
  --effort <level> (low, medium, high, xhigh, max)
  --model <model> Alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a full model ID.
  --permission-mode <mode> (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "plan")
EOF
`);
  chmodSync(path, 0o755);
  return path;
}

function assertCodexModelShape(model) {
  assert.equal(typeof model.id, "string");
  assert.equal(typeof model.displayName, "string");
  assert.equal(typeof model.description, "string");
  assert.equal(typeof model.hidden, "boolean");
  assert.ok(Array.isArray(model.supportedReasoningEfforts));
  assert.equal(typeof model.defaultReasoningEffort, "string");

  for (const effort of model.supportedReasoningEfforts) {
    assert.equal(typeof effort.reasoningEffort, "string");
    assert.equal(typeof effort.description, "string");
  }
}

test("Claude models match the Codex picker shape and include recursive transcript IDs", async (t) => {
  const root = fixtureDir(t);
  const nested = join(root, "project", "session", "subagents");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "agent.jsonl"), [
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-5" }, effort: "high" }),
    JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5" }, effort: "medium" }),
  ].join("\n") + "\n");

  const provider = new ClaudeProvider(() => {}, { projectsDir: root, binary: claudeBinary(t, root) });
  const { data } = await provider.models();

  assert.ok(data.some((model) => model.id === "claude-opus-5" && model.source === "transcript"));
  assert.ok(data.some((model) => model.id === "claude-sonnet-5" && model.source === "transcript"));
  data.forEach(assertCodexModelShape);
  assert.deepEqual(
    data[0].supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    ["provider-default", "low", "medium", "high", "xhigh", "max"],
  );
});

test("Claude model discovery falls back to CLI-documented aliases without transcript history", async (t) => {
  const root = fixtureDir(t);
  const provider = new ClaudeProvider(() => {}, { projectsDir: root, binary: claudeBinary(t, root) });
  const { data } = await provider.models();

  assert.deepEqual(data.map((model) => model.id), ["provider-default", "fable", "opus", "sonnet"]);
  assert.equal(data[0].isDefault, true);
  assert.equal(data[0].source, "provider_default");
  assert.ok(data.slice(1).every((model) => model.source === "cli_help"));
});

test("a real Claude full ID round-trips unchanged through per-thread settings", async (t) => {
  const dir = fixtureDir(t);
  const store = new ThreadSettingsStore({ file: join(dir, "thread-settings.json") });
  const service = new ThreadSettingsService({ store, readers: { claude: () => ({
    model: "claude-opus-5", effort: "high", mode: "auto", modeExposed: true,
    source: "claude_transcript",
  }) } });

  service.remember("claude", "thread-real-model", {
    model: "claude-opus-5",
    effort: "high",
    mode: "auto",
  });
  const resolved = await service.resolve("claude", "thread-real-model", {
    models: [{ id: "opus" }],
  });

  assert.equal(resolved.model, "claude-opus-5");
  assert.equal(resolved.modelAvailability, "unlisted");
  assert.equal(resolved.sources.model, "claude_transcript");

  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /if \(providerRecordedSelection \|\| selection\?\.threadOnly\) \{ addCurrentThreadModel\(displayedModel, displayedEffort, availability\); \}/);
  assert.match(html, /displayName: model/);
  assert.match(html, /\$\("modelName"\)\.textContent = m\?\.displayName \|\| state\.model \|\| "—"/);
});
