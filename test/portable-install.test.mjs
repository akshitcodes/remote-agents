import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  downloadAndOpenTailscaleInstaller,
  ensureTailscaleReady,
  originChangeMessage,
  providerPreflight,
  rememberTransport,
  resolveConfig,
  runTailscaleSetupCommand,
  serviceStateIsRunning,
  tailscalePreflight,
  configureTailscale,
  verifyCloudflareEntry,
  verifyHttpsApp,
} from "../bin/codex-phone.mjs";

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeCommand(t, body, name = "command") {
  const dir = tempDir(t, "remote-agents-command-");
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

test("fresh config creates a strong stable identity and reuses it", async (t) => {
  const previous = process.env.REMOTE_AGENTS_HOME;
  process.env.REMOTE_AGENTS_HOME = tempDir(t, "remote-agents-config-");
  t.after(() => {
    if (previous === undefined) { delete process.env.REMOTE_AGENTS_HOME; } else { process.env.REMOTE_AGENTS_HOME = previous; }
  });

  const first = await resolveConfig({ port: 9490 });
  const second = await resolveConfig();

  assert.ok(first.token.length >= 43, "generated token contains at least 256 random bits in base64url form");
  assert.equal(second.token, first.token);
  assert.equal(second.port, first.port);
  assert.equal(second.host, first.host);
});

test("HTTPS verification tolerates a slow first attempt and requires the authenticated marker", async () => {
  let attempts = 0;
  const result = await verifyHttpsApp("https://phone.example", { token: "x".repeat(43) }, {
    timeoutMs: 200,
    requestTimeoutMs: 100,
    retryMs: 1,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) { throw new Error("certificate is still being issued"); }
      return new Response("ok", { status: 200, headers: { "x-remote-agents": "bridge" } });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);

  const wrongApp = await verifyHttpsApp("https://phone.example", { token: "x".repeat(43) }, {
    timeoutMs: 100,
    fetchImpl: async () => new Response("other", { status: 200 }),
  });
  assert.equal(wrongApp.ok, false);
  assert.match(wrongApp.message, /not the authenticated Remote Agents app/);
});

test("Tailscale preflight parses JSON and verifies MagicDNS even when a warning line comes first", (t) => {
  const previous = process.env.REMOTE_AGENTS_TAILSCALE_BIN;
  process.env.REMOTE_AGENTS_TAILSCALE_BIN = fakeCommand(t, `printf '%s\\n' 'version mismatch warning' '{"BackendState":"Running","Self":{"DNSName":"mac.example.ts.net."},"CurrentTailnet":{"MagicDNSEnabled":true}}'`);
  t.after(() => {
    if (previous === undefined) { delete process.env.REMOTE_AGENTS_TAILSCALE_BIN; } else { process.env.REMOTE_AGENTS_TAILSCALE_BIN = previous; }
  });

  assert.deepEqual(tailscalePreflight(), {
    installed: true,
    connected: true,
    state: "connected",
    detail: "connected as mac.example.ts.net",
    dnsName: "mac.example.ts.net",
    magicDnsEnabled: true,
    bin: process.env.REMOTE_AGENTS_TAILSCALE_BIN,
  });
});

test("MagicDNS disabled is reported before changing Funnel state", async (t) => {
  const previous = process.env.REMOTE_AGENTS_TAILSCALE_BIN;
  process.env.REMOTE_AGENTS_TAILSCALE_BIN = fakeCommand(t, `printf '%s\\n' '{"BackendState":"Running","Self":{"DNSName":"mac.example.ts.net."},"CurrentTailnet":{"MagicDNSEnabled":false}}'`);
  t.after(() => {
    if (previous === undefined) { delete process.env.REMOTE_AGENTS_TAILSCALE_BIN; } else { process.env.REMOTE_AGENTS_TAILSCALE_BIN = previous; }
  });
  let configured = false;
  const result = await configureTailscale({ port: 9440, token: "x".repeat(43) }, {
    commandRunner: async () => { configured = true; return { status: 0 }; },
  });

  assert.equal(configured, false);
  assert.equal(result.state, "magic_dns_disabled");
  assert.match(result.detail, /MagicDNS is disabled/);
  assert.match(result.remediation, /admin console.*DNS.*enable MagicDNS/i);
});

test("first-use Funnel waits for browser approval and times out actionably", async (t) => {
  const finishes = fakeCommand(t, `node -e 'setTimeout(() => {}, 30)'`);
  const started = Date.now();
  let waitOutput = "";
  const patient = await runTailscaleSetupCommand(finishes, [], {
    timeoutMs: 3000,
    waitNoticeMs: 50,
    writeStdout: (chunk) => { waitOutput += chunk; },
    writeStderr: () => {},
  });
  assert.equal(patient.status, 0);
  assert.equal(patient.timedOut, false);
  assert.ok(Date.now() - started >= 20, "the CLI waits for the approval command instead of treating it as hung");
  assert.match(waitOutput, /Still waiting for Tailscale.*Funnel opened an approval tab/);

  const slow = fakeCommand(t, `node -e 'setTimeout(() => {}, 200)'`);
  const completed = await runTailscaleSetupCommand(slow, [], {
    timeoutMs: 10,
    writeStdout: () => {},
    writeStderr: () => {},
  });
  assert.equal(completed.timedOut, true);

  const previous = process.env.REMOTE_AGENTS_TAILSCALE_BIN;
  process.env.REMOTE_AGENTS_TAILSCALE_BIN = fakeCommand(t, `printf '%s\\n' '{"BackendState":"Running","Self":{"DNSName":"mac.example.ts.net."},"CurrentTailnet":{"MagicDNSEnabled":true}}'`);
  t.after(() => {
    if (previous === undefined) { delete process.env.REMOTE_AGENTS_TAILSCALE_BIN; } else { process.env.REMOTE_AGENTS_TAILSCALE_BIN = previous; }
  });

  const result = await configureTailscale({ port: 9441, token: "x".repeat(43) }, {
    approvalTimeoutMs: 25,
    commandRunner: async (_bin, _args, options) => ({ status: null, timedOut: true, timeoutMs: options.timeoutMs }),
  });
  assert.equal(result.state, "funnel_approval_timeout");
  assert.match(result.detail, /25 milliseconds|1 seconds|within 1 seconds/i);
  assert.match(result.remediation, /approval tab.*approve enabling Funnel.*re-run/i);
  assert.match(result.remediation, /No phone QR/);
});

test("Tailscale stopped is distinct from not installed and has exact recovery", (t) => {
  const previous = process.env.REMOTE_AGENTS_TAILSCALE_BIN;
  process.env.REMOTE_AGENTS_TAILSCALE_BIN = fakeCommand(t, `printf '%s\\n' 'Tailscale is stopped' >&2; exit 1`);
  t.after(() => {
    if (previous === undefined) { delete process.env.REMOTE_AGENTS_TAILSCALE_BIN; } else { process.env.REMOTE_AGENTS_TAILSCALE_BIN = previous; }
  });

  const result = tailscalePreflight();
  assert.equal(result.installed, true);
  assert.equal(result.connected, false);
  assert.equal(result.state, "stopped");
  assert.match(result.detail, /installed but stopped/);
  assert.match(result.remediation, /Open the Tailscale app/);
});

test("the guided macOS journey installs, opens login, and resumes without a rerun", async () => {
  let state = {
    installed: false,
    connected: false,
    state: "not_installed",
    detail: "Tailscale is not installed.",
  };
  const opened = [];
  const commands = [];
  let cleaned = false;

  const result = await ensureTailscaleReady({
    platformName: "darwin",
    isInteractive: true,
    preflight: () => ({ ...state }),
    chooseInstall: async () => "installer",
    install: async () => {
      state = { installed: true, connected: false, state: "signed_out", bin: "/Applications/Tailscale" };
      return { ok: true, cleanup: () => { cleaned = true; } };
    },
    openTarget: (name, target) => { opened.push([name, target]); return true; },
    commandRunner: async (bin, args, options) => {
      commands.push([bin, args, options.waitMessage]);
      state = {
        installed: true,
        connected: true,
        state: "connected",
        dnsName: "remote-agents-mac.example.ts.net",
        magicDnsEnabled: true,
        bin,
      };
      return { status: 0 };
    },
    sleepImpl: async () => {},
  });

  assert.equal(result.connected, true);
  assert.deepEqual(opened, [["Tailscale", undefined]]);
  assert.deepEqual(commands[0].slice(0, 2), ["/Applications/Tailscale", ["login"]]);
  assert.match(commands[0][2], /setup is still active/);
  assert.equal(cleaned, true);
});

test("deferring Tailscale exits before download or service setup", async () => {
  let installed = false;
  const result = await ensureTailscaleReady({
    platformName: "darwin",
    isInteractive: true,
    preflight: () => ({ installed: false, connected: false, state: "not_installed" }),
    chooseInstall: async () => "cancel",
    install: async () => { installed = true; return { ok: true }; },
  });

  assert.equal(result.state, "installation_deferred");
  assert.equal(installed, false);
});

test("the official installer is signature-checked before macOS opens it", async (t) => {
  const dir = tempDir(t, "remote-agents-installer-");
  const calls = [];
  const result = await downloadAndOpenTailscaleInstaller({
    makeTempDir: () => dir,
    commandRunner: async (bin, args) => { calls.push([bin, args]); return { status: 0 }; },
    signatureRunner: () => ({
      status: 0,
      stdout: "1. Developer ID Installer: Tailscale Inc. (W5364U7YZB)",
      stderr: "",
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0][0], "curl");
  assert.match(calls[0][1].at(-1), /pkgs\.tailscale\.com\/stable\/Tailscale-latest-macos\.pkg/);
  assert.deepEqual(calls[1], ["open", [join(dir, "Tailscale.pkg")]]);
});

test("an untrusted installer is deleted and never opened", async (t) => {
  const dir = tempDir(t, "remote-agents-untrusted-installer-");
  const calls = [];
  const result = await downloadAndOpenTailscaleInstaller({
    makeTempDir: () => dir,
    commandRunner: async (bin, args) => { calls.push([bin, args]); return { status: 0 }; },
    signatureRunner: () => ({ status: 0, stdout: "Developer ID Installer: Someone Else", stderr: "" }),
  });

  assert.equal(result.state, "installer_signature_invalid");
  assert.deepEqual(calls.map(([bin]) => bin), ["curl"]);
  assert.equal(existsSync(dir), false);
});

// Confine provider discovery to a fake machine: the detector also looks in real
// system directories, so without this these cases pass or fail depending on what
// the developer running them happens to have installed.
function confineProviderSearch(t, dirs) {
  const saved = {
    PATH: process.env.PATH,
    DIRS: process.env.REMOTE_AGENTS_BIN_DIRS,
    APP: process.env.REMOTE_AGENTS_CODEX_APP,
  };

  process.env.PATH = [...dirs, "/usr/bin", "/bin"].join(":");
  process.env.REMOTE_AGENTS_BIN_DIRS = dirs.join(":") || "/nonexistent";
  process.env.REMOTE_AGENTS_CODEX_APP = "/nonexistent/ChatGPT.app/codex";

  t.after(() => {
    process.env.PATH = saved.PATH;
    for (const [key, value] of [["REMOTE_AGENTS_BIN_DIRS", saved.DIRS], ["REMOTE_AGENTS_CODEX_APP", saved.APP]]) {
      if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
    }
  });
}

test("provider preflight reports every missing CLI and refuses to invent readiness", (t) => {
  confineProviderSearch(t, [tempDir(t, "remote-agents-empty-path-")]);

  const result = providerPreflight({ codexBinary: "/definitely/missing/codex" });
  assert.equal(result.usable.length, 0);
  assert.deepEqual(result.rows.map((row) => [row.name, row.installed, row.usable]), [
    ["codex", false, false],
    ["claude", false, false],
    ["grok", false, false],
  ]);
  assert.deepEqual(result.rows.map((row) => [row.name, row.installCommand, row.loginCommand]), [
    ["codex", "curl -fsSL https://chatgpt.com/codex/install.sh | sh", "codex login"],
    ["claude", "curl -fsSL https://claude.ai/install.sh | bash", "claude auth login"],
    ["grok", "curl -fsSL https://x.ai/cli/install.sh | bash", "grok login"],
  ]);
});

test("a Claude-only machine marks only Claude usable", (t) => {
  const claude = fakeCommand(t, `printf '%s\\n' '{"loggedIn":true}'`, "claude");
  confineProviderSearch(t, [join(claude, "..")]);

  const result = providerPreflight({ codexBinary: "/definitely/missing/codex" });
  assert.deepEqual(result.usable.map((row) => row.name), ["claude"]);
  assert.deepEqual(result.rows.map((row) => [row.name, row.usable]), [
    ["codex", false],
    ["claude", true],
    ["grok", false],
  ]);
});

test("origin-change refusal explains the phone impact and explicit replacement path", () => {
  const message = originChangeMessage("https://old.example.ts.net", "https://new.example.ts.net");
  assert.match(message, /public web address changed/);
  assert.match(message, /separate login and notification subscription/);
  assert.match(message, /--replace-origin/);
  assert.match(message, /reinstall the phone app/);
});

test("--replace-origin is required and then persists the newly verified address", (t) => {
  const previous = process.env.REMOTE_AGENTS_HOME;
  process.env.REMOTE_AGENTS_HOME = tempDir(t, "remote-agents-origin-");
  t.after(() => {
    if (previous === undefined) { delete process.env.REMOTE_AGENTS_HOME; } else { process.env.REMOTE_AGENTS_HOME = previous; }
  });

  rememberTransport("funnel", "https://old.example.ts.net", { allowOriginChange: true });
  assert.throws(() => rememberTransport("funnel", "https://new.example.ts.net"), /--replace-origin/);
  const replaced = rememberTransport("funnel", "https://new.example.ts.net", { allowOriginChange: true });
  assert.equal(replaced.publicUrl, "https://new.example.ts.net");
  assert.ok(replaced.transportVerifiedAt);
});

test("a Cloudflare Access login never substitutes for authenticated app verification", async () => {
  const redirect = async () => new Response("", {
    status: 302,
    headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
  });
  const result = await verifyCloudflareEntry("https://agents.example.com", { token: "x".repeat(43) }, { fetchImpl: redirect });

  assert.equal(result.ok, false);
  assert.match(result.message, /authenticated Remote Agents app behind it was not verified/);
});

test("the supervised service starts only the local bridge and cannot race setup transport", () => {
  const source = readFileSync(new URL("../bin/codex-phone.mjs", import.meta.url), "utf8");
  const serveStart = source.indexOf("async function serve(args)");
  const serviceBranch = source.indexOf("if (args.service)", serveStart);
  const transportChoice = source.indexOf("await chooseTransport", serveStart);

  assert.ok(serviceBranch > serveStart && serviceBranch < transportChoice);
  assert.match(source, /<string>serve<\/string><string>--service<\/string>/);
  assert.match(source, /ExecStart=\$\{stableNodePath\(\)\} \$\{CLI_PATH\} serve --service/);
  assert.match(source, /bridgeAlreadyRunning[\s\S]*Keeping it alive so active agent turns are not interrupted/);
});

test("repeat setup preserves running macOS and Linux services but not merely loaded ones", () => {
  assert.equal(serviceStateIsRunning("running (pid 123)"), true);
  assert.equal(serviceStateIsRunning("active"), true);
  assert.equal(serviceStateIsRunning("loaded (not running)"), false);
  assert.equal(serviceStateIsRunning("inactive"), false);
  assert.equal(serviceStateIsRunning("not installed"), false);
});

test("the published package allowlist includes current and portable runtime modules", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const required = [
    "usage-state.mjs",
    "notification-content.mjs",
    "provider-detect.mjs",
    "config.mjs",
    "onboarding.mjs",
  ];

  for (const file of required) {
    assert.ok(pkg.files.includes(file), `${file} must be included in the npm package`);
  }
});
