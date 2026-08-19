import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  originChangeMessage,
  providerPreflight,
  rememberTransport,
  resolveConfig,
  runTailscaleSetupCommand,
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

test("provider preflight reports every missing CLI and refuses to invent readiness", (t) => {
  const previousPath = process.env.PATH;
  process.env.PATH = tempDir(t, "remote-agents-empty-path-");
  t.after(() => { process.env.PATH = previousPath; });

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
  const previousPath = process.env.PATH;
  const claude = fakeCommand(t, `printf '%s\\n' '{"loggedIn":true}'`, "claude");
  process.env.PATH = `${join(claude, "..")}:/usr/bin:/bin`;
  t.after(() => { process.env.PATH = previousPath; });

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
});
