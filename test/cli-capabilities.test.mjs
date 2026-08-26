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

import { parseCliHelp, pickChoice, supportsFlag, UNKNOWN_CAPABILITIES } from "../cli-capabilities.mjs";
import { claudeSessionArgs } from "../providers/claude.mjs";
import { grokSessionArgs, permissionArgsFor } from "../providers/grok.mjs";

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

test("--effort is omitted on a build that has never heard of it", () => {
  assert.equal(supportsFlag(old(), "--effort"), false);
  assert.equal(supportsFlag(current(), "--effort"), true);

  const args = claudeSessionArgs({ emitThreadId: "t", model: "opus", effort: "high", modeKey: "bypass", caps: old() });
  assert.ok(!args.includes("--effort"), "an unsupported --effort must never be sent");
  // The rest of the request still goes through: losing an effort setting is a
  // far better outcome than a CLI that will not start.
  assert.ok(args.includes("--model") && args.includes("opus"));
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
    ["--permission-mode", "bypassPermissions"]);
});

test("Auto falls back to the closest mode the build accepts", () => {
  // 2.1.0 has no `auto`; `default` also pauses on risky actions.
  const older = claudeSessionArgs({ emitThreadId: "t", model: "opus", modeKey: "auto", caps: old() });
  assert.deepEqual(older.slice(older.indexOf("--permission-mode"), older.indexOf("--permission-mode") + 2),
    ["--permission-mode", "default"]);

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

test("a build that accepts no value we can mean gets no --permission-mode", () => {
  // Better the CLI's own default than a refusal to start.
  const stripped = parseCliHelp(`--model <model> Model\n--permission-mode <mode> (choices: "somethingElse")`);
  const args = claudeSessionArgs({ emitThreadId: "t", model: "opus", modeKey: "plan", caps: stripped });

  assert.ok(!args.includes("--permission-mode"));
  assert.ok(args.includes("--model"));
});

test("unreadable help keeps the behaviour this bridge was written against", () => {
  // A CLI we could not interrogate is not evidence that a flag is missing.
  assert.equal(supportsFlag(UNKNOWN_CAPABILITIES, "--effort"), true);
  assert.equal(pickChoice(UNKNOWN_CAPABILITIES, "--permission-mode", ["auto", "default"]), "auto");

  const args = claudeSessionArgs({ emitThreadId: "t", model: "opus", effort: "high", modeKey: "auto" });
  assert.ok(args.includes("--effort"));
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
    ["--permission-mode", "auto"]);
});

test("Grok drops an unsupported effort flag and finds another way to bypass", () => {
  const noEffort = parseCliHelp(`-m, --model <MODEL>\n  --permission-mode <MODE>\n  [possible values: default, bypassPermissions, plan]`);

  const args = grokSessionArgs({ model: "grok-4.5", effort: "high", modeKey: "bypass", caps: noEffort });
  assert.ok(!args.includes("--reasoning-effort"));
  // No --always-approve in this build, so the shared flag carries the intent.
  assert.deepEqual(args, ["agent", "--model", "grok-4.5", "--permission-mode", "bypassPermissions", "stdio"]);

  const full = parseCliHelp(GROK_1_0_5);
  assert.deepEqual(grokSessionArgs({ model: "grok-4.5", effort: "high", modeKey: "bypass", caps: full }),
    ["agent", "--model", "grok-4.5", "--reasoning-effort", "high", "--always-approve", "stdio"]);
  assert.deepEqual(permissionArgsFor("plan", full), ["--permission-mode", "plan"]);
});
