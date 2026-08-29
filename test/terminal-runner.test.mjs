import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { TerminalRunner } from "../terminal-runner.mjs";

function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = (signal) => {
    child.exitCode = signal === "SIGTERM" ? 143 : 137;
    queueMicrotask(() => child.emit("exit", child.exitCode, signal));
    return true;
  };
  return child;
}

test("terminal commands are project-scoped and expose incremental output", async () => {
  let invocation;
  const runner = new TerminalRunner({ spawnImpl: (file, args, options) => {
    invocation = { file, args, options };
    return fakeSpawn();
  } });
  const started = runner.start({ cwd: process.cwd(), command: "pwd" });
  const job = runner.jobs.get(started.id);
  job.stdout = job.child.stdout;
  job.child.stdout.write("first\n");
  job.child.stderr.write("second\n");
  await new Promise((resolve) => setImmediate(resolve));

  const first = runner.get(started.id, 0);
  assert.equal(invocation.options.cwd, process.cwd());
  assert.match(invocation.args.at(-1), /pwd/);
  assert.equal(first.output, "first\nsecond\n");
  assert.equal(runner.get(started.id, first.nextOffset).output, "");

  job.child.exitCode = 0;
  job.child.emit("exit", 0, null);
  assert.equal(runner.get(started.id).state, "completed");
  assert.equal(runner.get(started.id).exitCode, 0);
});

test("terminal rejects missing directories and bounds retained output", async () => {
  const runner = new TerminalRunner({ maxOutput: 8, spawnImpl: () => fakeSpawn() });
  assert.throws(() => runner.start({ cwd: "relative", command: "pwd" }), (error) => error.code === "invalid_terminal_cwd");

  const started = runner.start({ cwd: process.cwd(), command: "printf 1234567890" });
  const job = runner.jobs.get(started.id);
  job.child.stdout.write("1234567890");
  await new Promise((resolve) => setImmediate(resolve));
  const status = runner.get(started.id, 0);
  assert.equal(status.output, "34567890");
  assert.equal(status.truncated, true);
});

test("terminal Stop terminates only the selected command", async () => {
  const runner = new TerminalRunner({ spawnImpl: () => fakeSpawn() });
  const first = runner.start({ cwd: process.cwd(), command: "sleep 10" });
  const second = runner.start({ cwd: process.cwd(), command: "echo safe" });

  assert.equal(runner.stop(first.id).state, "stopping");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.get(first.id).state, "stopped");
  assert.equal(runner.get(second.id).state, "running");
});
