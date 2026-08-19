import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { permissionArgsFor as grokPermissionArgsFor } from "../providers/grok.mjs";

import {
  claudeModeKey,
  codexModeKey,
  readClaudeTranscriptThreadSettings,
  readCodexDbThreadSettings,
  readCodexRolloutThreadSettings,
  readGrokSessionThreadSettings,
  ThreadSettingsService,
  ThreadSettingsStore,
} from "../thread-settings.mjs";
import { validateDispatchSettings } from "../dispatch-settings.mjs";

function fixtureDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "cxp-thread-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Codex settings are read from an immutable read-only fixture database", (t) => {
  const dir = fixtureDir(t);
  const dbPath = join(dir, "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      model TEXT,
      reasoning_effort TEXT,
      approval_mode TEXT,
      sandbox_policy TEXT
    );
  `);
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run(
    "thread-db",
    "gpt-5.5",
    "medium",
    "never",
    JSON.stringify({ type: "disabled" }),
  );
  db.close();
  chmodSync(dbPath, 0o400);

  assert.deepEqual(readCodexDbThreadSettings("thread-db", { dbPath }), {
    model: "gpt-5.5",
    effort: "medium",
    mode: "full",
    modeExposed: true,
    approvalPolicy: "never",
    sandboxPolicy: { type: "disabled" },
    source: "codex_db",
  });
});

test("Codex rollout settings are used as the missing-DB fallback", (t) => {
  const dir = fixtureDir(t);
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, [
    JSON.stringify({
      type: "turn_context",
      payload: {
        model: "gpt-old",
        effort: "low",
        approval_policy: "on-request",
        sandbox_policy: { type: "workspace-write" },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: {
          model: "gpt-new",
          reasoning_effort: "high",
          approval_policy: "never",
          permission_profile: { type: "disabled" },
        },
      },
    }),
  ].join("\n") + "\n");

  assert.deepEqual(readCodexRolloutThreadSettings(path), {
    model: "gpt-new",
    effort: "high",
    mode: "full",
    modeExposed: true,
    source: "codex_rollout",
  });
});

test("provider permission values map only to exact existing mode keys", () => {
  assert.equal(codexModeKey("never", { type: "disabled" }), "full");
  assert.equal(codexModeKey("never", { type: "danger-full-access" }), "full");
  assert.equal(codexModeKey("on-request", { type: "workspace-write" }), "auto");
  assert.equal(codexModeKey("untrusted", { type: "read-only" }), "read-only");
  assert.equal(codexModeKey("never", { type: "workspace-write" }), null);
  assert.equal(claudeModeKey("default"), "manual");
  assert.equal(claudeModeKey("bypassPermissions"), "bypass");
  assert.equal(claudeModeKey("dontAsk"), null);
  assert.throws(() => grokPermissionArgsFor("manual"), /not supported/);
  assert.deepEqual(grokPermissionArgsFor("bypass"), ["--always-approve"]);
});

test("an authoritative model absent from the provider list is preserved and marked unlisted", async (t) => {
  const dir = fixtureDir(t);
  const store = new ThreadSettingsStore({ file: join(dir, "settings.json") });
  const service = new ThreadSettingsService({
    store,
    readers: {
      codex: () => ({ model: "gpt-5.5", effort: "medium", mode: "full", modeExposed: true, source: "codex_db" }),
    },
  });

  const resolved = await service.resolve("codex", "thread-unknown-model", {
    models: [{ id: "gpt-5.6-sol" }],
  });
  assert.equal(resolved.model, "gpt-5.5");
  assert.equal(resolved.modelAvailability, "unlisted");
});

test("provider values win over a conflicting stored pick field by field", async (t) => {
  const dir = fixtureDir(t);
  const store = new ThreadSettingsStore({ file: join(dir, "settings.json") });
  store.set("codex", "thread-precedence", { model: "stored-model", effort: "low", mode: "auto" });
  const service = new ThreadSettingsService({
    store,
    readers: {
      codex: () => ({ model: "gpt-real", effort: "high", mode: "full", modeExposed: true, source: "codex_db" }),
    },
  });

  const resolved = await service.resolve("codex", "thread-precedence", { models: [{ id: "gpt-real" }] });
  assert.equal(resolved.model, "gpt-real");
  assert.equal(resolved.effort, "high");
  assert.equal(resolved.mode, "full");
  assert.deepEqual(resolved.sources, {
    model: "codex_db",
    effort: "codex_db",
    mode: "codex_db",
  });
});

test("a provider-missing fact falls back to the bridge store without replacing exposed facts", async (t) => {
  const dir = fixtureDir(t);
  const store = new ThreadSettingsStore({ file: join(dir, "settings.json") });
  store.set("grok", "thread-partial", { model: "stored-model", effort: "low", mode: "bypass" });
  const service = new ThreadSettingsService({
    store,
    readers: {
      grok: () => ({ model: "grok-real", effort: "high", mode: null, modeExposed: false, source: "grok_session" }),
    },
  });

  const resolved = await service.resolve("grok", "thread-partial", { models: [{ id: "grok-real" }] });
  assert.equal(resolved.model, "grok-real");
  assert.equal(resolved.effort, "high");
  assert.equal(resolved.mode, "bypass");
  assert.equal(resolved.sources.mode, "bridge_store");
});

test("an unmappable provider permission combination preserves the exact provider policy", async (t) => {
  const dir = fixtureDir(t);
  const store = new ThreadSettingsStore({ file: join(dir, "settings.json") });
  store.set("codex", "thread-unknown-mode", { mode: "full" });
  const service = new ThreadSettingsService({
    store,
    readers: {
      codex: () => ({
        model: null, effort: null, mode: null, modeExposed: true,
        approvalPolicy: "never",
        sandboxPolicy: { type: "managed", network: "restricted" },
        source: "codex_db",
      }),
    },
  });

  const resolved = await service.resolve("codex", "thread-unknown-mode");
  assert.equal(resolved.mode, null);
  assert.equal(resolved.modeKnown, false);
  assert.equal(resolved.sources.mode, "codex_db");
  assert.equal(resolved.approvalPolicy, "never");
  assert.deepEqual(resolved.sandboxPolicy, { type: "managed", network: "restricted" });
});

test("bridge settings survive a simulated restart with private atomic storage", (t) => {
  const dir = fixtureDir(t);
  const file = join(dir, "settings.json");
  const first = new ThreadSettingsStore({ file, now: () => 1234 });
  first.set("grok", "thread-durable", { model: "grok-4.5", effort: "medium", mode: "bypass" });

  const restarted = new ThreadSettingsStore({ file, now: () => 5678 });
  assert.deepEqual(restarted.get("grok", "thread-durable"), {
    provider: "grok",
    threadId: "thread-durable",
    model: "grok-4.5",
    effort: "medium",
    mode: "bypass",
    pending: { model: false, effort: false, mode: false },
    updatedAt: 1234,
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8").includes("thread-durable"), true);
});

test("an explicit next-turn override survives restart and wins field-by-field", async (t) => {
  const dir = fixtureDir(t);
  const file = join(dir, "settings.json");
  const first = new ThreadSettingsStore({ file, now: () => 1234 });
  first.set("codex", "thread-next", { model: "gpt-next", effort: "high" }, { pending: true });

  const restarted = new ThreadSettingsStore({ file, now: () => 5678 });
  const service = new ThreadSettingsService({
    store: restarted,
    readers: {
      codex: () => ({ model: "gpt-current", effort: "low", mode: "auto", modeExposed: true, source: "codex_db" }),
    },
  });
  const pending = await service.resolve("codex", "thread-next");
  assert.equal(pending.model, "gpt-next");
  assert.equal(pending.effort, "high");
  assert.equal(pending.mode, "auto");
  assert.equal(pending.sources.model, "bridge_override");
  assert.equal(pending.sources.mode, "codex_db");

  // Provider acceptance does not erase a sticky phone/laptop choice: the
  // controls describe what the next web send will request, even if another
  // client later runs this thread with a different model.
  const nextSend = await service.resolve("codex", "thread-next");
  assert.equal(nextSend.model, "gpt-next");
  assert.equal(nextSend.effort, "high");
  assert.equal(nextSend.sources.model, "bridge_override");
});

test("an echoed pending value retains provider provenance for historical-model validation", async (t) => {
  const dir = fixtureDir(t);
  const store = new ThreadSettingsStore({ file: join(dir, "settings.json") });
  store.set("codex", "thread-history", { model: "gpt-history", effort: "medium" }, { pending: true });
  const service = new ThreadSettingsService({
    store,
    readers: {
      codex: () => ({
        model: "gpt-history", effort: "medium", mode: "full", modeExposed: true,
        source: "codex_db", approvalPolicy: "never", sandboxPolicy: { type: "disabled" },
      }),
    },
  });
  const resolved = await service.resolve("codex", "thread-history");
  assert.equal(resolved.sources.model, "bridge_override");
  assert.deepEqual(resolved.providerConfirmed, {
    model: "gpt-history", effort: "medium", mode: "full", modeExposed: true, source: "codex_db",
  });
  assert.deepEqual(validateDispatchSettings("codex", {
    model: "gpt-history", effort: "medium", mode: "full",
    approvalPolicy: "never", sandbox: "disabled",
  }, [], resolved), { model: "gpt-history", effort: "medium", mode: "full" });
});

test("clearing a pending mode lets the provider-owned policy resurface", async (t) => {
  const dir = fixtureDir(t);
  const store = new ThreadSettingsStore({ file: join(dir, "settings.json") });
  store.set("codex", "thread-managed", { mode: "full" }, { pending: true });
  store.set("codex", "thread-managed", { mode: null }, { pending: true });
  const service = new ThreadSettingsService({
    store,
    readers: { codex: () => ({
      model: null, effort: null, mode: null, modeExposed: true, source: "codex_db",
      approvalPolicy: "never", sandboxPolicy: { type: "managed" },
    }) },
  });
  const resolved = await service.resolve("codex", "thread-managed");
  assert.equal(resolved.mode, null);
  assert.equal(resolved.modeKnown, false);
  assert.equal(resolved.sources.mode, "codex_db");
});

test("Claude and Grok fixture transcripts expose only the settings they genuinely record", (t) => {
  const dir = fixtureDir(t);
  const claudePath = join(dir, "claude.jsonl");
  writeFileSync(claudePath, [
    JSON.stringify({ type: "user", permissionMode: "auto" }),
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-5" }, effort: "high" }),
  ].join("\n") + "\n");
  assert.deepEqual(readClaudeTranscriptThreadSettings(claudePath), {
    model: "claude-opus-5",
    effort: "high",
    mode: "auto",
    modeExposed: true,
    source: "claude_transcript",
  });

  const summaryPath = join(dir, "summary.json");
  writeFileSync(summaryPath, JSON.stringify({
    current_model_id: "grok-4.5",
    reasoning_effort: "medium",
    sandbox_profile: "off",
  }));
  assert.deepEqual(readGrokSessionThreadSettings({ summaryPath }), {
    model: "grok-4.5",
    effort: "medium",
    mode: null,
    modeExposed: false,
    source: "grok_session",
  });
});
