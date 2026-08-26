// Flags are read from the installed CLI, not assumed from the one on the machine
// this was written on.
//
// The help fragments below are the real thing, captured from
// @anthropic-ai/claude-code 2.1.0 and 2.1.238 and from grok 1.0.5. A reported
// failure ran exactly this sequence on 2.1.0:
//
//   --permission-mode auto  -> error: option '--permission-mode <mode>' argument
//                              'auto' is invalid. Allowed choices are
//                              acceptEdits, bypassPermissions, default, ...
//   --effort low            -> error: unknown option '--effort'
//
// Neither degrades: the CLI refuses to start, so the send fails.

import assert from "node:assert/strict";
import test from "node:test";

import { capabilitiesFor, clearCapabilityCache, parseCliHelp, pickChoice, supportsFlag, UNKNOWN_CAPABILITIES } from "../cli-capabilities.mjs";
import { claudeSessionArgs } from "../providers/claude.mjs";
import { GrokProvider, grokModelsFromAcp, grokSessionArgs, permissionArgsFor, verifyGrokSessionSettings } from "../providers/grok.mjs";

const CLAUDE_2_1_0 = `
  --model <model>                       Model for the current session
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits",
                                        "bypassPermissions", "default",
                                        "delegate", "dontAsk", "plan")
  --resume [value]                      Resume a conversation by session ID
`;

const CLAUDE_2_1_238 = `
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
`;

const GROK_1_0_5 = `
  -m, --model <MODEL>
          Model ID to use
      --permission-mode <MODE>
          Permission mode
          [possible values: default, acceptEdits, auto, dontAsk, bypassPermissions, plan]
      --reasoning-effort <EFFORT>
          Reasoning effort for reasoning models
      --always-approve
          Approve every action
`;

const old = () => parseCliHelp(CLAUDE_2_1_0);
const current = () => parseCliHelp(CLAUDE_2_1_238);

test("capability probes do not block the bridge and cache each help command separately", async () => {
  clearCapabilityCache();
  const started = Date.now();
  const effortProbe = capabilitiesFor(process.execPath, {
    args: ["-e", "setTimeout(() => console.log('--effort'), 100)"],
    timeoutMs: 1000,
    label: "fixture",
  });

  assert.ok(Date.now() - started < 50, "starting a help probe must not block the event loop");
  const effort = await effortProbe;
  const permission = await capabilitiesFor(process.execPath, {
    args: ["-e", "console.log('--permission-mode')"],
    timeoutMs: 1000,
    label: "fixture",
  });

  assert.ok(effort.flags.has("--effort"));
  assert.ok(!effort.flags.has("--permission-mode"));
  assert.ok(permission.flags.has("--permission-mode"));
  assert.ok(!permission.flags.has("--effort"));
});

test("help is parsed in both the commander and clap layouts", () => {
  assert.deepEqual([...old().choices.get("--permission-mode")].sort(),
    ["acceptEdits", "bypassPermissions", "default", "delegate", "dontAsk", "plan"]);
  assert.deepEqual([...current().choices.get("--permission-mode")].sort(),
    ["acceptEdits", "auto", "bypassPermissions", "dontAsk", "manual", "plan"]);

  const grok = parseCliHelp(GROK_1_0_5);
  assert.ok(grok.choices.get("--permission-mode").has("bypassPermissions"));
  assert.ok(grok.flags.has("--reasoning-effort"));
  assert.ok(grok.flags.has("--always-approve"));
});

test("choice lists stay attached to their option row, not flags mentioned in prose", () => {
  const parsed = parseCliHelp(`
  --output-format <format>  Output format (only works with --print)
                            (choices: "text", "json", "stream-json")
  --print                   Print and exit
  --permission-mode <mode>  Permission mode (choices: "manual", "plan")
`);
  assert.deepEqual([...parsed.choices.get("--output-format")], ["text", "json", "stream-json"]);
  assert.equal(parsed.choices.has("--print"), false);
  assert.deepEqual([...parsed.choices.get("--permission-mode")], ["manual", "plan"]);
});

test("Grok-style indentation terminates each option block", () => {
  const parsed = parseCliHelp(`
      --model <MODEL>
          Model ID to use
      --reasoning-effort <EFFORT>
          Reasoning effort (low, medium, high)
      --always-approve
          Approve every action
`);
  assert.equal(parsed.choices.has("--model"), false);
  assert.deepEqual([...parsed.choices.get("--reasoning-effort")], ["low", "medium", "high"]);
  assert.equal(parsed.choices.has("--always-approve"), false);
});

test("an explicit effort fails closed on a build that has never heard of it", () => {
  assert.equal(supportsFlag(old(), "--effort"), false);
  assert.equal(supportsFlag(current(), "--effort"), true);

  assert.throws(
    () => claudeSessionArgs({ emitThreadId: "t", model: "opus", effort: "high", modeKey: "bypass", caps: old() }),
    (error) => error.code === "provider_cli_incompatible" && /reasoning effort high/.test(error.message),
  );
});

test("Auto is never silently replaced with a different permission contract", () => {
  assert.throws(
    () => claudeSessionArgs({ emitThreadId: "t", model: "opus", modeKey: "auto", caps: old() }),
    (error) => error.code === "provider_cli_incompatible" && /selected auto permission mode/.test(error.message),
  );

  const newer = claudeSessionArgs({ emitThreadId: "t", model: "opus", modeKey: "auto", caps: current() });
  assert.deepEqual(newer.slice(newer.indexOf("--permission-mode"), newer.indexOf("--permission-mode") + 2),
    ["--permission-mode", "auto"]);
});

test("Manual maps to a value each build accepts, keeping the approval hook", () => {
  // 2.1.238 renamed this mode to `manual`; 2.1.0 only knows it as `default`.
  for (const [label, caps, expected] of [["2.1.0", old(), "default"], ["2.1.238", current(), "manual"]]) {
    const args = claudeSessionArgs({
      emitThreadId: "t", model: "opus", modeKey: "manual", caps,
      hookPath: "/tmp/hook.mjs", endpoint: { host: "127.0.0.1", port: 8484 }, hookSecret: "s", nodePath: "/usr/bin/node",
    });

    assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
      ["--permission-mode", expected], label);
    assert.match(args[args.indexOf("--settings") + 1], /claude-approval/, label);
  }
});

test("a build that accepts no exact permission value fails closed", () => {
  const stripped = parseCliHelp(`--model <model> Model\n--permission-mode <mode> (choices: "somethingElse")`);
  assert.throws(
    () => claudeSessionArgs({ emitThreadId: "t", model: "opus", modeKey: "plan", caps: stripped }),
    (error) => error.code === "provider_cli_incompatible" && /selected plan permission mode/.test(error.message),
  );
});

test("unreadable help never guesses an exact provider setting", () => {
  // Low-level probes retain unknown rather than inventing unsupported flags,
  // while the provider boundary refuses an exact mode it cannot prove.
  assert.equal(supportsFlag(UNKNOWN_CAPABILITIES, "--effort"), true);
  assert.equal(pickChoice(UNKNOWN_CAPABILITIES, "--permission-mode", ["auto", "default"]), "auto");

  assert.throws(
    () => claudeSessionArgs({ emitThreadId: "t", model: "provider-default", effort: "provider-default", modeKey: "auto" }),
    (error) => error.code === "provider_cli_incompatible",
  );
});

test("Grok fails closed on unsupported effort and positions root permission flags correctly", () => {
  const noEffort = parseCliHelp(`-m, --model <MODEL>\n  --permission-mode <MODE>\n  [possible values: default, bypassPermissions, plan]`);

  assert.throws(
    () => grokSessionArgs({ model: "grok-4.5", effort: "high", modeKey: "bypass", caps: noEffort }),
    (error) => error.code === "provider_cli_incompatible" && /reasoning effort high/.test(error.message),
  );

  assert.deepEqual(grokSessionArgs({ model: "grok-4.5", modeKey: "bypass", caps: noEffort }),
    ["--permission-mode", "bypassPermissions", "agent", "--model", "grok-4.5", "stdio"]);

  const full = parseCliHelp(GROK_1_0_5);
  assert.deepEqual(grokSessionArgs({ model: "grok-4.5", effort: "high", modeKey: "bypass", caps: full }),
    ["agent", "--model", "grok-4.5", "--reasoning-effort", "high", "--always-approve", "stdio"]);
  assert.deepEqual(permissionArgsFor("plan", full), ["--permission-mode", "plan"]);
});

test("Grok models and per-model efforts come from ACP metadata without bridge guesses", () => {
  const models = grokModelsFromAcp({
    agentCapabilities: { promptCapabilities: { image: false }, loadSession: true },
    _meta: {
      modelState: {
        currentModelId: "grok-new",
        availableModels: [
          {
            modelId: "grok-new", name: "Grok New", description: "Provider description",
            _meta: { reasoningEffort: "high", reasoningEfforts: [
              { value: "ultra", description: "Provider ultra", default: false },
              { value: "high", description: "Provider high", default: true },
            ] },
          },
          { modelId: "grok-fast", name: "Grok Fast", _meta: { supportsReasoningEffort: false } },
        ],
      },
    },
  });

  assert.deepEqual(models[0].supportedReasoningEfforts.map((effort) => effort.reasoningEffort), ["ultra", "high"]);
  assert.equal(models[0].defaultReasoningEffort, "high");
  assert.equal(models[0].isDefault, true);
  assert.deepEqual(models[0].inputModalities, ["text"]);
  assert.deepEqual(models[1].supportedReasoningEfforts.map((effort) => effort.reasoningEffort), ["provider-default"]);
});

test("Grok dispatch settings are checked against the provider's session echo", () => {
  const setup = {
    models: { currentModelId: "grok-4.6" },
    _meta: { "x.ai/sessionConfig": { options: [
      { id: "high", category: "mode", selected: false },
      { id: "medium", category: "mode", selected: true },
    ] } },
  };

  assert.deepEqual(verifyGrokSessionSettings(setup, { model: "grok-4.6", effort: "medium" }), {
    model: "grok-4.6", effort: "medium",
  });
  assert.throws(() => verifyGrokSessionSettings(setup, { model: "grok-4.5", effort: "medium" }),
    (error) => error.code === "provider_settings_unconfirmed" && /Nothing was sent/.test(error.message));
  assert.throws(() => verifyGrokSessionSettings(setup, { model: "grok-4.6", effort: "high" }),
    (error) => error.code === "provider_settings_unconfirmed" && /Nothing was sent/.test(error.message));
});

test("a transient Grok ACP refresh keeps the last native capability snapshot", async (t) => {
  let probes = 0;
  const initialized = {
    agentCapabilities: { promptCapabilities: { image: false }, loadSession: true },
    _meta: { modelState: { currentModelId: "grok-4.6", availableModels: [{
      modelId: "grok-4.6", name: "Grok 4.6",
      _meta: { reasoningEfforts: [
        { value: "high", default: true },
        { value: "medium", default: false },
      ] },
    }] } },
  };
  const provider = new GrokProvider(() => {}, {
    binary: process.execPath,
    capabilityFetcher: async () => {
      probes += 1;
      if (probes === 1) { return initialized; }
      throw new Error("temporary ACP failure");
    },
    cliCapabilityFetcher: async () => parseCliHelp(GROK_1_0_5),
  });
  t.after(() => clearInterval(provider.reaper));

  const first = await provider.models();
  provider.modelCache.at = 0;
  const stale = await provider.models();

  assert.deepEqual(stale.data, first.data);
  assert.equal(stale.capabilities.stale, true);
  assert.match(stale.capabilities.refreshError, /temporary ACP failure/);
  assert.equal(probes, 2);
});
