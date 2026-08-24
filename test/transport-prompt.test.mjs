// The transport question is the one setup decision that is awkward to undo, so
// it is answered with a keyboard menu. Two things are worth guarding: that every
// option maps to a transport setup can actually obey, and that the keys work.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { TRANSPORT_CHOICES } from "../bin/codex-phone.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/ask-transport.mjs", import.meta.url));
const HAS_EXPECT = existsSync("/usr/bin/expect");

test("every option names a transport setup understands", () => {
  // A prompt offering a value the rest of setup rejects would be a dead end.
  const understood = new Set(["funnel", "serve", "cloudflare"]);

  for (const choice of TRANSPORT_CHOICES) {
    assert.ok(understood.has(choice.value), `${choice.value} is not a transport setup accepts`);
    assert.ok(choice.name.length > 10, `${choice.value} needs a human-readable label`);
    assert.ok(choice.description?.length > 30, `${choice.value} needs its trade-off spelled out`);
  }

  assert.equal(TRANSPORT_CHOICES.length, understood.size, "every transport should be offered");
  assert.equal(new Set(TRANSPORT_CHOICES.map((c) => c.value)).size, TRANSPORT_CHOICES.length);
  assert.equal(TRANSPORT_CHOICES[0].value, "funnel", "the recommended option comes first");
});

// Driving a terminal menu needs a pty; `expect` is present on macOS by default.
function press(...keys) {
  const sends = keys.map((key) => {
    const code = { down: "\\033\\[B", up: "\\033\\[A", enter: "\\r" }[key] ?? key;
    return `send "${code}"\n  sleep 0.3`;
  }).join("\n  ");

  const result = spawnSync("/usr/bin/expect", ["-c", `
set timeout 25
spawn node ${FIXTURE}
expect "Who should be able to reach this Mac?"
sleep 0.5
  ${sends}
expect -re {ANSWER=([a-z]+)} { puts "PICKED:$expect_out(1,string)" }
`], { encoding: "utf8", timeout: 40000 });

  return /PICKED:([a-z]+)/.exec(`${result.stdout}${result.stderr}`)?.[1] ?? null;
}

test("arrow keys move the selection and Enter accepts it", { skip: HAS_EXPECT ? false : "needs /usr/bin/expect" }, () => {
  assert.equal(press("enter"), "funnel", "Enter alone takes the recommended default");
  assert.equal(press("down", "enter"), "serve");
  // Two presses must land on the third option: the separator is decoration and
  // must never be selectable.
  assert.equal(press("down", "down", "enter"), "cloudflare");
  assert.equal(press("up", "enter"), "cloudflare", "up from the first option wraps to the last");
});

test("number keys still work, for anyone who prefers typing", { skip: HAS_EXPECT ? false : "needs /usr/bin/expect" }, () => {
  assert.equal(press("2", "enter"), "serve");
  assert.equal(press("3", "enter"), "cloudflare");
});

test("Ctrl-C at the prompt cancels without changing anything", { skip: HAS_EXPECT ? false : "needs /usr/bin/expect" }, () => {
  const result = spawnSync("/usr/bin/expect", ["-c", `
set timeout 25
spawn node ${FIXTURE}
expect "Who should be able to reach this Mac?"
sleep 0.4
send "\\003"
expect "Setup cancelled"
catch wait outcome
puts "STATUS:[lindex $outcome 3]"
`], { encoding: "utf8", timeout: 40000 });

  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /Setup cancelled\. Nothing was changed\./);
  assert.match(output, /STATUS:130/, "an interrupted prompt should exit 130, not look like success");
});
