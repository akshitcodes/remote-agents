// `npm install -g` invokes the CLI through a symlink in the prefix's bin/.
// A main-module guard that compares paths without resolving symlinks makes the
// installed command print nothing and exit 0 — indistinguishable from a broken
// install. Spawn through a real symlink so that can never regress silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the CLI produces output when invoked through a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "ra-symlink-"));
  const link = join(dir, "remote-agents");

  try {
    symlinkSync(resolve("bin/codex-phone.mjs"), link);
    const run = spawnSync(process.execPath, [link, "--help"], {
      encoding: "utf8",
      env: { ...process.env, REMOTE_AGENTS_HOME: join(dir, "home") },
    });

    assert.equal(run.status, 0, `exited ${run.status}: ${run.stderr}`);
    assert.ok(run.stdout.trim().length > 0, "no stdout when invoked via symlink");
    assert.match(run.stdout, /remote-agents/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
