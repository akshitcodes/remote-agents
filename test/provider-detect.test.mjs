// Provider readiness on machines that are not this one.
//
// Every case here is a machine shape that shipped broken: a provider whose auth
// probe is slow, one that keeps credentials somewhere we did not look, one
// installed outside the service's PATH. The old detector answered "sign-in could
// not be confirmed" to all three and then refused to run.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

let uniq = 0;

// HOME and the search dirs are read when the module initialises, so each machine
// shape needs its own instance.
async function onMachine({ home, path, bins = {}, files = {}, timeoutMs = 1500 }, run) {
  const saved = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    T: process.env.REMOTE_AGENTS_AUTH_TIMEOUT_MS,
    APP: process.env.REMOTE_AGENTS_CODEX_APP,
    DIRS: process.env.REMOTE_AGENTS_BIN_DIRS,
  };
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });

  for (const [name, script] of Object.entries(bins)) {
    const file = join(binDir, name);
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }

  for (const [relative, body] of Object.entries(files)) {
    const file = join(home, relative);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, body);
  }

  process.env.HOME = home;
  // /usr/bin:/bin is what launchd hands a service, and the fake CLIs below are
  // shell scripts that need it. A case passing `path` is simulating exactly that.
  process.env.PATH = path ?? `${binDir}:/usr/bin:/bin`;
  process.env.REMOTE_AGENTS_AUTH_TIMEOUT_MS = String(timeoutMs);
  // These machines are not this one: no ChatGPT desktop app to fall back to.
  process.env.REMOTE_AGENTS_CODEX_APP = join(home, "no-chatgpt-app");
  // Confine discovery to this fake machine: the built-in list names real system
  // directories, and a CLI installed on the host must not leak into a case.
  process.env.REMOTE_AGENTS_BIN_DIRS = [binDir, join(home, ".local", "bin")].join(":");

  try {
    const detect = await import(`../provider-detect.mjs?case=${++uniq}`);
    return await run(detect, binDir);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    for (const [key, value] of [["REMOTE_AGENTS_AUTH_TIMEOUT_MS", saved.T], ["REMOTE_AGENTS_CODEX_APP", saved.APP], ["REMOTE_AGENTS_BIN_DIRS", saved.DIRS]]) {
      if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
    }
  }
}

function machine(t) {
  const home = mkdtempSync(join(tmpdir(), "ra-machine-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

const HANGS = "#!/bin/sh\nsleep 30\n";
const SAYS = (text, code = 0) => `#!/bin/sh\ncat <<'EOF'\n${text}\nEOF\nexit ${code}\n`;

test("a slow auth probe stays usable instead of reading as a failure", async (t) => {
  await onMachine({ home: machine(t), bins: { grok: HANGS } }, (detect) => {
    const row = detect.detectProviders().rows.find((r) => r.name === "grok");

    assert.equal(row.installed, true);
    assert.equal(row.state, "unknown");
    // The whole point: setup must not be blocked by a probe that never answered.
    assert.equal(row.usable, true);
    assert.equal(row.confirmed, false);
    assert.match(row.detail, /did not answer within \ds/);
  });
});

test("a CLI that says it is signed out is not usable, and is not guesswork", async (t) => {
  await onMachine({ home: machine(t), bins: { grok: SAYS("Not logged in. Run `grok login`.", 1) } }, (detect) => {
    const row = detect.detectProviders().rows.find((r) => r.name === "grok");

    assert.equal(row.state, "signed_out");
    assert.equal(row.usable, false);
    assert.equal(row.detail, "installed, but not signed in");
  });
});

test("a signed-in CLI is confirmed, and reports which account", async (t) => {
  const claude = SAYS(JSON.stringify({ loggedIn: true, email: "someone@example.com", orgName: "Example" }));

  await onMachine({ home: machine(t), bins: { claude } }, (detect) => {
    const row = detect.detectProviders().rows.find((r) => r.name === "claude");

    assert.equal(row.state, "ready");
    assert.equal(row.confirmed, true);
    assert.match(row.detail, /someone@example\.com/);
  });
});

test("an explicit signed-out answer overrides stored credentials", async (t) => {
  // A stale credentials file must not outvote the CLI itself.
  await onMachine({
    home: machine(t),
    bins: { grok: SAYS("Please sign in to continue", 1) },
    files: { ".grok/auth.json": JSON.stringify({ token: "stale" }) },
  }, (detect) => {
    assert.equal(detect.detectProviders().rows.find((r) => r.name === "grok").state, "signed_out");
  });
});

test("stored credentials carry a provider whose CLI never answers", async (t) => {
  await onMachine({
    home: machine(t),
    bins: { codex: HANGS },
    files: { ".codex/auth.json": JSON.stringify({ tokens: { access_token: "x" } }) },
  }, (detect) => {
    const row = detect.detectProviders().rows.find((r) => r.name === "codex");

    assert.equal(row.state, "ready");
    assert.equal(row.usable, true);
  });
});

test("a provider is found outside PATH, as a launchd service would need", async (t) => {
  const home = machine(t);
  // ~/.local/bin is where the official install.sh puts these, and is exactly
  // what launchd's minimal PATH leaves out.
  const local = join(home, ".local", "bin");
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, "grok"), SAYS("Available models: grok-4"));
  chmodSync(join(local, "grok"), 0o755);

  await onMachine({ home, path: "/usr/bin:/bin" }, (detect) => {
    const row = detect.detectProviders().rows.find((r) => r.name === "grok");

    assert.equal(row.installed, true);
    assert.equal(row.path, join(local, "grok"));
    assert.equal(row.state, "ready");
  });
});

test("nothing installed is reported as nothing installed, with two ways to fix it", async (t) => {
  await onMachine({ home: machine(t), path: "/nonexistent-path-for-tests" }, (detect) => {
    const result = detect.detectProviders();

    assert.equal(result.installed.length, 0);
    assert.equal(result.usable.length, 0);
    for (const row of result.rows) {
      assert.equal(row.state, "missing");
      assert.ok(row.installCommand, `${row.name} needs an install command`);
      assert.ok(row.loginCommand, `${row.name} needs a login command`);
    }
    // npm is the fallback for anyone the shell installer does not suit.
    assert.ok(result.rows.find((r) => r.name === "claude").altInstallCommand.includes("npm"));
  });
});

test("skipping the probe never spawns anything, and still finds binaries", async (t) => {
  await onMachine({ home: machine(t), bins: { grok: HANGS }, timeoutMs: 60000 }, (detect) => {
    const started = Date.now();
    const row = detect.detectProvider(detect.PROVIDERS.find((p) => p.name === "grok"), { probe: false });

    assert.equal(row.installed, true);
    assert.equal(row.state, "unknown");
    // If it had spawned the hanging binary this would be 60s, not milliseconds.
    assert.ok(Date.now() - started < 2000, "probe:false must not spawn the CLI");
  });
});

test("a user-configured binary path is preferred, and a stale one falls back", async (t) => {
  const home = machine(t);
  const custom = join(home, "custom");
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(custom, "grok"), SAYS("Available models: grok-4"));
  chmodSync(join(custom, "grok"), 0o755);

  await onMachine({ home, bins: { grok: SAYS("Available models: grok-4") } }, (detect, binDir) => {
    const spec = detect.PROVIDERS.find((p) => p.name === "grok");

    assert.equal(detect.detectProvider(spec, { cfg: { grokBinary: join(custom, "grok") } }).path, join(custom, "grok"));
    // A path that no longer exists must not make a working install invisible.
    assert.equal(detect.detectProvider(spec, { cfg: { grokBinary: "/gone/grok" } }).path, join(binDir, "grok"));
  });
});

test("resolved paths are absolute, so the service agrees with the shell", async (t) => {
  await onMachine({ home: machine(t), bins: { grok: SAYS("Available models: grok-4") } }, (detect, binDir) => {
    const resolved = detect.resolvedBinaries(detect.detectProviders().rows);

    assert.equal(resolved.grokBinary, join(binDir, "grok"));
    for (const value of Object.values(resolved)) { assert.ok(value.startsWith("/"), `${value} must be absolute`); }
  });
});

// The regression that shipped: a Mac with Claude installed and working was told
// "No provider CLI is ready" and setup exited. Only facts may block.
test("an unreadable sign-in does not block setup", async (t) => {
  await onMachine({ home: machine(t), bins: { claude: HANGS } }, (detect) => {
    const result = detect.detectProviders();

    assert.equal(result.rows.find((r) => r.name === "claude").state, "unknown");
    assert.equal(detect.setupBlocker(result), null);
  });
});

test("setup is blocked when nothing is installed, and says how to install", async (t) => {
  await onMachine({ home: machine(t), path: "/nonexistent-for-tests" }, (detect) => {
    const blocker = detect.setupBlocker(detect.detectProviders());

    assert.match(blocker, /No provider CLI is installed/);
    assert.match(blocker, /Codex, Claude, or Grok/);
  });
});

test("setup is blocked when every installed CLI says it is signed out, naming the fix", async (t) => {
  await onMachine({
    home: machine(t),
    bins: { grok: SAYS("Not logged in", 1), claude: SAYS(JSON.stringify({ loggedIn: false })) },
  }, (detect) => {
    const blocker = detect.setupBlocker(detect.detectProviders());

    assert.match(blocker, /signed out of Claude, Grok/);
    assert.match(blocker, /claude auth login/);
  });
});

test("one signed-out provider does not block the others", async (t) => {
  await onMachine({
    home: machine(t),
    bins: { grok: SAYS("Not logged in", 1), claude: SAYS(JSON.stringify({ loggedIn: true })) },
  }, (detect) => {
    const result = detect.detectProviders();

    assert.equal(detect.setupBlocker(result), null);
    assert.deepEqual(result.usable.map((row) => row.name), ["claude"]);
  });
});
