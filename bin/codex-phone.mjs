#!/usr/bin/env node
// remote-agents CLI — run the bridge or manage always-on autostart.
//
//   remote-agents                 start the server (foreground) + print pairing QR
//   remote-agents setup           set up autostart and stable Tailscale HTTPS
//   remote-agents install         alias for setup
//   remote-agents uninstall       remove autostart
//   remote-agents start|stop|status   control the autostart service
//   remote-agents url             print pairing URLs again
//
// Flags (serve): --host <ip> (default 0.0.0.0), --port <n> (default: chosen once),
//                --token <secret> (default: generated once, saved to ~/.codex-phone)

import { spawn, spawnSync } from "node:child_process";
import { connect, createServer as createNetServer } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import select, { Separator } from "@inquirer/select";
import { fileURLToPath } from "node:url";

import { dataPath, readConfig, writeConfig } from "../config.mjs";
import { augmentedPath, detectProviders, resolvedBinaries, setupBlocker } from "../provider-detect.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = fileURLToPath(import.meta.url);
const LABEL = "com.remoteagents.bridge";
const TRANSPORTS = new Set(["funnel", "serve", "cloudflare"]);
const APP_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
function normalizeTransport(value) {
  // The portability prototype used `tailscale` to mean private Serve. Preserve
  // that saved choice on upgrade; new installs default to public Funnel.
  return value === "tailscale" ? "serve" : value;
}

function transportName(value) {
  switch (normalizeTransport(value)) {
    case "funnel": return "Tailscale Funnel (reachable from anywhere)";
    case "serve": return "Tailscale Serve (only your Tailscale devices)";
    case "cloudflare": return "Cloudflare named tunnel + Access";
    default: return "not configured";
  }
}

// ---------- config / token ----------

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function chooseFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function resolveConfig(args = {}) {
  const cfg = readConfig();
  let changed = false;

  if (args.token) {
    if (args.token.length < 32) {
      throw new Error("--token must contain at least 32 characters; the generated default uses 256 random bits");
    }

    cfg.token = args.token;
    changed = true;
  }

  if (!cfg.token) {
    cfg.token = randomBytes(32).toString("base64url");
    changed = true;
  }

  if (args.port) {
    const port = validPort(args.port);

    if (!port) {
      throw new Error("--port must be an integer from 1 to 65535");
    }

    cfg.port = port;
    changed = true;
  }

  if (!validPort(cfg.port)) {
    cfg.port = await chooseFreePort();
    changed = true;
  }

  if (args.host) {
    cfg.host = args.host;
    changed = true;
  }

  let requestedPublicUrl;

  if (args.publicUrl) {
    const url = new URL(args.publicUrl);

    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("--public-url must be an https:// origin without credentials, a path, query, or fragment");
    }

    // Do not persist a new origin until the authenticated app has answered
    // there. A typo must not silently strand an already-installed PWA.
    requestedPublicUrl = url.origin;
  }

  if (changed) {
    writeConfig(cfg);
  }

  return { ...cfg, host: cfg.host || "0.0.0.0", port: cfg.port, token: cfg.token, requestedPublicUrl };
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--host") { args.host = argv[++i]; }
    else if (a === "--port") { args.port = argv[++i]; }
    else if (a === "--token") { args.token = argv[++i]; }
    else if (a === "--name") { args.name = argv[++i]; }
    else if (a === "--hostname") { args.hostname = argv[++i]; }
    else if (a === "--public-url") { args.publicUrl = argv[++i]; }
    else if (a === "--transport") { args.transport = argv[++i]; }
    else if (a === "--service") { args.service = true; }
    else if (a === "--access-protected") { args.accessProtected = true; }
    else if (a === "--replace-origin") { args.replaceOrigin = true; }
    else if (a.startsWith("--")) { throw new Error(`unknown option: ${a}`); }
  }

  return args;
}

function commandExists(bin) {
  return spawnSync(platform() === "win32" ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;
}

export function tailscaleBinary() {
  const override = String(process.env.REMOTE_AGENTS_TAILSCALE_BIN ?? "").trim();
  if (override) { return override.includes("/") ? (existsSync(override) ? override : null) : (commandExists(override) ? override : null); }

  // Prefer the app's CLI on macOS. A separately installed Homebrew client can
  // be one release behind the daemon and prepend warnings to otherwise valid
  // output; the app binary always matches its own backend.
  const candidates = platform() === "darwin" ? [APP_TAILSCALE, "tailscale"] : ["tailscale"];

  return candidates.find((bin) => bin.includes("/") ? existsSync(bin) : commandExists(bin)) ?? null;
}

function noisyJson(value) {
  const text = String(value ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) { return null; }

  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function commandOutput(result) {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.trim();
}

function runProbe(bin, args, timeout = 8000) {
  return spawnSync(bin, args, { encoding: "utf8", timeout, env: process.env });
}

export function tailscalePreflight() {
  const bin = tailscaleBinary();

  if (!bin) {
    return {
      installed: false,
      connected: false,
      state: "not_installed",
      detail: "Tailscale is not installed.",
      remediation: "Install it from https://tailscale.com/download, open it, and sign in.",
    };
  }

  const result = runProbe(bin, ["status", "--json"], 8000);
  const parsed = noisyJson(result.stdout) ?? noisyJson(result.stderr);
  const backend = String(parsed?.BackendState ?? "").trim();
  const dnsName = String(parsed?.Self?.DNSName ?? "").replace(/\.$/, "");
  const magicDnsEnabled = parsed?.CurrentTailnet?.MagicDNSEnabled === true;
  const combined = commandOutput(result);
  const connected = result.status === 0 && backend === "Running" && !!dnsName;

  if (connected) {
    return {
      installed: true,
      connected: true,
      state: "connected",
      detail: `connected as ${dnsName}`,
      dnsName,
      magicDnsEnabled,
      bin,
    };
  }

  const stopped = /tailscale is stopped|stopped/i.test(combined) || /stopped/i.test(backend);
  const signedOut = /needslogin|no state|logged out|not logged in|sign.?in/i.test(`${backend}\n${combined}`);
  const state = stopped ? "stopped" : signedOut ? "signed_out" : "not_connected";
  const reason = stopped
    ? "Tailscale is installed but stopped."
    : signedOut
      ? "Tailscale is installed but not signed in."
      : `Tailscale is installed but not connected${backend ? ` (state: ${backend})` : ""}.`;

  return {
    installed: true,
    connected: false,
    state,
    detail: reason,
    remediation: "Open the Tailscale app on this Mac, sign in if asked, and switch it on; then re-run this command.",
    bin,
  };
}

export function providerPreflight(cfg = readConfig()) {
  return detectProviders({ cfg });
}

function printProviderPreflight(result) {
  console.log("\n  Provider CLIs:");

  for (const row of result.rows) {
    const mark = row.confirmed ? "\u2713" : row.installed ? "\u2022" : "!";
    console.log(`    ${mark} ${row.label}: ${row.detail}`);

    if (!row.installed) {
      console.log(`      Install: ${row.installCommand}`);
      if (row.altInstallCommand) { console.log(`      Or:      ${row.altInstallCommand}`); }
      console.log(`      Sign in: ${row.loginCommand}`);
    } else if (row.state === "signed_out") {
      console.log(`      Sign in: ${row.loginCommand}`);
    } else if (row.state === "unknown") {
      // Unverified is not broken. Say so plainly, and say what to run if it is.
      console.log(`      Keeping it enabled. If sending fails, run: ${row.loginCommand}`);
    }
  }

  const names = (rows) => rows.map((row) => row.label).join(", ");
  console.log(`  Ready to use: ${result.usable.length ? names(result.usable) : "none"}`);
  if (result.usable.length > result.confirmed.length) {
    console.log(`  Sign-in confirmed for: ${result.confirmed.length ? names(result.confirmed) : "none"}`);
  }
}

// Setup is blocked only by something we can state as a fact: no provider CLI is
// installed at all. An installed CLI whose sign-in we could not read is carried
// forward, because the session attempt reports the real reason far better than a
// probe guessing at setup time — and refusing here strands a working machine.
function requireUsableProvider(cfg) {
  const result = providerPreflight(cfg);
  printProviderPreflight(result);

  const blocker = setupBlocker(result);
  if (blocker) { throw new Error(blocker); }

  // Remember where the binaries actually are. launchd hands services a minimal
  // PATH, so the absolute path found here is what makes the service agree with
  // the shell that just ran setup.
  try {
    const resolved = resolvedBinaries(result.rows);
    if (Object.keys(resolved).length) { writeConfig({ ...readConfig(), ...resolved }); }
  } catch {}

  return result;
}

function portReachable(port) {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port, timeout: 1200 }, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

// ---------- secure phone transport ----------

function printTransportRanking(selected = "funnel") {
  console.log("\n  Who should be able to reach this Mac?");
  console.log(`    1. A phone anywhere with the private pairing link${selected === "funnel" ? " (selected)" : ""} — recommended; the phone installs nothing extra.`);
  console.log(`    2. Only devices signed in to my Tailscale account${selected === "serve" ? " (selected)" : ""} — private; every phone needs Tailscale.`);
  console.log(`    3. People allowed by my Cloudflare Access policy${selected === "cloudflare" ? " (selected)" : ""} — advanced; requires your own domain.`);
}

function interactive() {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

// The options, separate from the prompt, so a test can assert every value is one
// setup actually understands: a typo here would be a prompt that cannot be obeyed.
export const TRANSPORT_CHOICES = [
  {
    name: "A phone anywhere with the private pairing link",
    value: "funnel",
    description: "Recommended. Public HTTPS address, guarded by your pairing token; the phone installs nothing extra.",
  },
  {
    name: "Only devices signed in to my Tailscale account",
    value: "serve",
    description: "Most private. Never exposed to the internet, but every phone you use must install and sign in to Tailscale.",
  },
  {
    name: "People allowed by my Cloudflare Access policy",
    value: "cloudflare",
    description: "Advanced. Needs a domain you own and a Cloudflare account; useful if you already run Cloudflare Access.",
  },
];

// Arrow keys, number keys and Enter, with each option's trade-off visible while
// it is highlighted. Choosing who can reach your machine is the one decision in
// setup that is hard to undo later, so it should not be answered blind.
export async function askTransport() {
  const [recommended, private_, advanced] = TRANSPORT_CHOICES;

  try {
    return await select({
      message: "Who should be able to reach this Mac?",
      default: "funnel",
      choices: [recommended, private_, new Separator(), advanced],
      theme: { prefix: " ", helpMode: "always" },
    });
  } catch (error) {
    // Ctrl-C at a prompt is a decision to stop, not a crash to report.
    if (error?.name === "ExitPromptError") {
      console.log("\n  Setup cancelled. Nothing was changed.");
      process.exit(130);
    }

    throw error;
  }
}

async function chooseTransport(cfg, args) {
  let selected = normalizeTransport(args.transport || cfg.transport);
  let rankingShown = false;

  if (selected && !TRANSPORTS.has(selected)) {
    throw new Error("--transport must be funnel, serve, or cloudflare");
  }

  let picked = false;

  if (!selected && interactive()) {
    selected = await askTransport();
    picked = true;
    rankingShown = true;
  }

  selected ||= "funnel";
  if (!rankingShown) {
    printTransportRanking(selected);
  } else {
    console.log(`\n  Selected: ${transportName(selected)}`);
  }

  if (picked) {
    // They answered the prompt; do not tell them they supplied nothing.
    console.log("  Saving this choice; change it later with --transport.");
  } else if (!args.transport && !cfg.transport) {
    console.log("  No choice supplied; using and saving the recommended anywhere-from-phone default.");
  } else if (args.transport) {
    console.log(`  Explicit choice: --transport ${selected}`);
  } else {
    console.log(`  Reusing saved choice: ${selected}`);
  }

  if (cfg.transport !== selected) {
    writeConfig({ ...readConfig(), transport: selected });
  }

  return selected;
}

export function pairingUrl(cfg) {
  if (!cfg.publicUrl || new URL(cfg.publicUrl).protocol !== "https:") {
    throw new Error("a verified stable HTTPS origin is required before printing a phone QR");
  }

  return `${cfg.publicUrl.replace(/\/$/, "")}/?t=${encodeURIComponent(cfg.token)}`;
}

async function printPairing(cfg, { verification = "Authenticated app answered through stable HTTPS." } = {}) {
  const { default: qrcode } = await import("qrcode-terminal");
  const url = pairingUrl(cfg);
  console.log(`\n  ${verification}`);
  console.log("  Scan this QR on your phone:\n");
  qrcode.generate(url, { small: true });
  console.log(`    ${url}`);
  console.log(`\n  Connection: ${transportName(cfg.transport)}`);
  console.log("  This exact origin, port, and pairing token are saved and will be reused.");
  console.log(`  Local diagnostic only: http://127.0.0.1:${cfg.port}/ (not a phone install URL)\n`);
}

function printTailscaleRecovery(preflight, transport = "funnel") {
  console.error(`\n  No phone QR was printed: ${preflight.detail || preflight.message || preflight}`);
  console.error(`  ${preflight.remediation || "Open Tailscale on this Mac, connect it, and re-run the same command."}`);
  if (normalizeTransport(transport) === "serve") {
    console.error("  Private mode also requires Tailscale on the phone, signed into the same account.");
  } else {
    console.error("  The recommended anywhere mode does not require Tailscale on the phone.");
  }
  console.error("  The saved token and port will be reused when you retry.");
  console.error("  A LAN http:// address is intentionally not offered: PWA install and push would not work.\n");
}

export async function verifyHttpsApp(base, cfg, {
  timeoutMs = 75000,
  requestTimeoutMs = 45000,
  retryMs = 1500,
  fetchImpl = fetch,
} = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastMessage = "HTTPS check did not complete";
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    const remaining = Math.max(1, deadline - Date.now());
    let response;

    try {
      response = await fetchImpl(`${base.replace(/\/$/, "")}/`, {
        headers: { authorization: `Bearer ${cfg.token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remaining)),
      });
    } catch (error) {
      lastMessage = `HTTPS check failed (${error.message})`;
    }

    if (response?.status === 200 && response.headers.get("x-remote-agents") === "bridge") {
      return { ok: true, attempts, elapsedMs: Date.now() - started };
    }

    if (response) {
      lastMessage = `HTTPS check returned ${response.status}, not the authenticated Remote Agents app`;
      // A concrete non-server-error response is not certificate warm-up. It is
      // the wrong app, token, or route, so waiting longer cannot make it safe.
      if (response.status < 500) { break; }
    }

    const wait = Math.min(retryMs, deadline - Date.now());
    if (wait > 0) { await new Promise((resolve) => setTimeout(resolve, wait)); }
  }

  return { ok: false, message: lastMessage, attempts, elapsedMs: Date.now() - started };
}

export async function verifyCloudflareEntry(base, cfg, { fetchImpl = fetch } = {}) {
  const app = await verifyHttpsApp(base, cfg, { fetchImpl });

  if (app.ok) {
    return { ok: true, verification: "Authenticated app answered through stable Cloudflare HTTPS." };
  }

  let response;

  try {
    response = await fetchImpl(`${base.replace(/\/$/, "")}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    return { ok: false, message: error.message };
  }

  const location = response.headers.get("location") || "";
  let accessLogin = false;

  try {
    const redirect = new URL(location, base);
    accessLogin = redirect.hostname.endsWith(".cloudflareaccess.com") || redirect.pathname.startsWith("/cdn-cgi/access/");
  } catch {}

  if (response.status >= 300 && response.status < 400 && accessLogin) {
    return {
      ok: false,
      message: "Cloudflare Access answered, but the authenticated Remote Agents app behind it was not verified; no QR can be shown yet",
    };
  }

  return { ok: false, message: `hostname returned ${response.status} without the Remote Agents marker or a Cloudflare Access login` };
}

export function runTailscaleSetupCommand(bin, args, {
  timeoutMs = 120000,
  waitNoticeMs = 15000,
  spawnImpl = spawn,
  writeStdout = (chunk) => process.stdout.write(chunk),
  writeStderr = (chunk) => process.stderr.write(chunk),
} = {}) {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    let forceTimer;
    const child = spawnImpl(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    const finish = (result) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearInterval(waitTimer);
      resolve({ ...result, output: output.trim(), timedOut });
    };
    const remember = (writer) => (chunk) => {
      const text = String(chunk ?? "");
      output = (output + text).slice(-65536);
      writer(text);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeoutMs);
    const waitTimer = setInterval(() => {
      writeStdout("  Still waiting for Tailscale to finish. If Funnel opened an approval tab, approve it there…\n");
    }, waitNoticeMs);

    child.stdout?.on("data", remember(writeStdout));
    child.stderr?.on("data", remember(writeStderr));
    child.on("error", (error) => finish({ status: null, error }));
    child.on("close", (code, signal) => finish({ status: code, signal }));
  });
}

export function rememberTransport(transport, publicUrl, { allowOriginChange = false } = {}) {
  const current = readConfig();

  if (current.publicUrl && current.publicUrl !== publicUrl && !allowOriginChange) {
    throw new Error(originChangeMessage(current.publicUrl, publicUrl));
  }

  const next = { ...current, transport, publicUrl, transportVerifiedAt: new Date().toISOString() };
  writeConfig(next);
  return next;
}

export function originChangeMessage(oldUrl, newUrl) {
  return `The public web address changed from ${oldUrl} to ${newUrl}. Phones installed from the old address keep a separate login and notification subscription, so silently switching would make the app look broken. If this name change is intentional, re-run with --replace-origin, then reinstall the phone app and enable notifications again.`;
}

// Autostart launchers (launchd/systemd) run with a minimal PATH that omits
// Homebrew/npm/user bin dirs, so `codex`/`claude` wouldn't be found. Prepend the
// common locations so spawning the provider CLIs works regardless of launcher.
function augmentPath() {
  if (platform() === "win32") {
    return;
  }

  process.env.PATH = augmentedPath();
}

// ---------- serve ----------

async function startLocalBridge(cfg, providerResult = providerPreflight(cfg)) {
  const { host, port, token } = cfg;
  const { startServer } = await import("../server.mjs");

  try {
    await startServer({
      host,
      port,
      token,
      usableProviders: providerResult.usable.map((row) => row.name),
    });
  } catch (e) {
    if (e.code === "EADDRINUSE") {
      console.error(`\n  Port ${port} is already in use. Another remote-agents bridge may be running.\n  Run \`remote-agents status\` or pass a different --port.\n`);
      process.exit(1);
    }

    throw e;
  }

  console.log(`\n  remote-agents is running (bound ${host}:${port}).`);
}

async function serve(args) {
  augmentPath();
  const cfg = await resolveConfig(args);

  // Supervised restarts own only the local bridge. The explicit setup/foreground
  // process owns reachability checks, Funnel/Serve changes, and QR output; this
  // avoids two processes racing to configure transport during first install.
  if (args.service) {
    await startLocalBridge(cfg);
    return;
  }

  const transport = await chooseTransport(cfg, args);
  const providerResult = requireUsableProvider(cfg);

  if (transport !== "cloudflare") {
    const preflight = tailscalePreflight();
    if (!preflight.connected) {
      printTailscaleRecovery(preflight, transport);
      process.exitCode = 1;
      return;
    }
    console.log(`\n  Tailscale: ${preflight.detail}`);
  }

  await startLocalBridge(cfg, providerResult);

  if (transport === "cloudflare") {
    console.error("\n  Cloudflare is the advanced option and is not provisioned automatically.");
    console.error("  Create a named tunnel, route your hostname to this local port, and protect it");
    console.error("  with a Cloudflare Access self-hosted application. Then run:");
    console.error(`    remote-agents tunnel --name NAME --hostname agents.example.com --access-protected`);
    console.error("  No QR is printed until that stable, access-controlled origin is available.\n");
    return;
  }

  const result = await configureTailscale(readConfig(), { transport, allowOriginChange: args.replaceOrigin });

  if (!result.ok) {
    printTailscaleRecovery(result, transport);
    process.exitCode = 1;
    return;
  }

  await printPairing(result.config);
}

// ---------- Cloudflare named tunnel (advanced option) ----------

// Quick tunnels are deliberately unsupported: their origin changes and they do
// not carry this app's SSE live stream. A named tunnel needs one-time setup:
//   cloudflared tunnel login
//   cloudflared tunnel create <name>
//   cloudflared tunnel route dns <name> <hostname>
async function tunnel(args) {
  const cfg = await resolveConfig(args);
  const { port, token } = cfg;

  if (!args.name || !args.hostname || !args.accessProtected) {
    console.error("\n  Cloudflare requires a named tunnel, a stable hostname, and Access protection.");
    console.error("  First create the tunnel/DNS route and a Cloudflare Access self-hosted app");
    console.error("  with an Allow policy for that hostname. Then run:");
    console.error("    remote-agents tunnel --name NAME --hostname agents.example.com --access-protected\n");
    process.exit(1);
  }

  if (!commandExists("cloudflared")) {
    console.error("\n  cloudflared is not installed. Install it, then re-run:");
    console.error(platform() === "darwin" ? "    brew install cloudflared\n" : "    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n");
    process.exit(1);
  }

  if (!(await portReachable(port))) {
    console.error(`\n  Nothing is listening on localhost:${port}. Start the server first:`);
    console.error("    remote-agents start        (background service)");
    console.error("    remote-agents              (foreground)\n");
    process.exit(1);
  }

  const cfArgs = ["tunnel", "run", "--url", `http://localhost:${port}`, args.name];
  const publicUrl = `https://${args.hostname}`;

  if (cfg.publicUrl && cfg.publicUrl !== publicUrl && !args.replaceOrigin) {
    throw new Error(originChangeMessage(cfg.publicUrl, publicUrl));
  }

  console.log(`\n  Starting named Cloudflare tunnel ${args.name} → localhost:${port}…`);
  console.log("  Waiting for the stable HTTPS hostname to return the authenticated app.");

  const child = spawn("cloudflared", cfArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let announced = false;

  async function announce() {
    if (announced) { return; }

    const check = await verifyCloudflareEntry(publicUrl, { ...cfg, token });

    if (!check.ok) { return; }

    announced = true;
    await printPairing(
      rememberTransport("cloudflare", publicUrl, { allowOriginChange: args.replaceOrigin }),
      { verification: check.verification },
    );
  }

  child.stdout.on("data", (d) => process.stdout.write(d));
  child.stderr.on("data", (d) => process.stderr.write(d));
  const checkTimer = setInterval(() => announce().catch(() => {}), 2000);
  checkTimer.unref?.();

  child.on("exit", (code) => {
    clearInterval(checkTimer);

    if (!announced) {
      console.error("\n  No QR was printed because the hostname never returned the authenticated app.");
      console.error("  Check the tunnel's public-hostname route and Cloudflare Access policy.\n");
    }

    console.log(`\n  cloudflared exited (${code ?? 0}).`);
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => { child.kill("SIGINT"); });
}

export async function configureTailscale(cfg, {
  transport = normalizeTransport(cfg.transport) || "funnel",
  allowOriginChange = false,
  approvalTimeoutMs = 120000,
  commandRunner = runTailscaleSetupCommand,
  verify = verifyHttpsApp,
} = {}) {
  transport = normalizeTransport(transport);
  if (!new Set(["funnel", "serve"]).has(transport)) {
    return { ok: false, detail: `Unsupported Tailscale mode: ${transport}` };
  }

  const preflight = tailscalePreflight();
  if (!preflight.connected) { return { ok: false, ...preflight }; }

  if (!preflight.magicDnsEnabled) {
    return {
      ok: false,
      state: "magic_dns_disabled",
      detail: "MagicDNS is disabled for this tailnet. Funnel needs the tailnet's stable .ts.net name before Remote Agents can verify HTTPS.",
      remediation: "Open the Tailscale admin console, go to DNS, enable MagicDNS, then re-run this command. MagicDNS is enabled by default on new tailnets.",
    };
  }

  console.log("  MagicDNS: enabled for this tailnet.");

  const publicUrl = `https://${preflight.dnsName}`;

  // Check the currently derived address before changing Serve/Funnel state.
  // A renamed/re-registered node must never silently strand installed phones.
  if (cfg.publicUrl && cfg.publicUrl !== publicUrl && !allowOriginChange) {
    return {
      ok: false,
      detail: originChangeMessage(cfg.publicUrl, publicUrl),
      remediation: "Restore the previous Tailscale machine name, or follow the explicit --replace-origin path above.",
      state: "origin_changed",
    };
  }

  if (normalizeTransport(cfg.transport) === transport && cfg.publicUrl === publicUrl) {
    const savedCheck = await verify(cfg.publicUrl, cfg);

    if (savedCheck.ok) {
      return { ok: true, url: cfg.publicUrl, config: cfg, reused: true };
    }
  }

  const command = transport === "funnel"
    ? ["funnel", "--bg", String(cfg.port)]
    : ["serve", "--bg", "--yes", `http://127.0.0.1:${cfg.port}`];
  if (transport === "funnel") {
    console.log("\n  Enabling Tailscale Funnel. On a tailnet using Funnel for the first time,");
    console.log("  Tailscale opens an approval page in your browser. Approve enabling Funnel");
    console.log("  in that tab; this command will keep waiting. Funnel is available on every");
    console.log("  Tailscale plan, including the free plan.");
  }

  const served = await commandRunner(preflight.bin, command, { timeoutMs: approvalTimeoutMs });

  if (served.timedOut) {
    return {
      ok: false,
      state: "funnel_approval_timeout",
      detail: `Tailscale did not finish enabling ${transport === "funnel" ? "Funnel" : "Serve"} within ${Math.ceil(approvalTimeoutMs / 1000)} seconds.`,
      remediation: transport === "funnel"
        ? "Return to the Tailscale approval tab, approve enabling Funnel, then re-run this command. No phone QR was created."
        : "Confirm Tailscale is connected, then re-run this command. No phone QR was created.",
    };
  }

  if (served.status !== 0) {
    const detail = served.output || served.error?.message || "tailscale serve failed";
    return { ok: false, detail, remediation: "Open Tailscale, confirm it is connected, and retry." };
  }

  console.log(`  ${transport === "funnel" ? "Funnel" : "Serve"} is configured. Waiting for the public HTTPS address to issue`);
  console.log("  its certificate and return this authenticated app (up to 75 seconds; the");
  console.log("  first request can take about 28 seconds)…");
  const check = await verify(publicUrl, cfg);

  if (!check.ok) {
    return {
      ok: false,
      detail: `${transport === "funnel" ? "Tailscale Funnel" : "Tailscale Serve"} was configured, but ${check.message}`,
      remediation: "Keep the bridge running, confirm Tailscale is connected, and retry; first-time certificate issuance can take about 30 seconds.",
    };
  }

  const saved = rememberTransport(transport, publicUrl, { allowOriginChange });
  return { ok: true, url: publicUrl, config: saved };
}

async function tailscale(args) {
  const cfg = await resolveConfig(args);

  if (!(await portReachable(cfg.port))) {
    console.error(`\n  Nothing is listening on localhost:${cfg.port}. Start the bridge first:`);
    console.error("    remote-agents start        (background service)");
    console.error("    remote-agents              (foreground)\n");
    process.exit(1);
  }

  const transport = normalizeTransport(args.transport || cfg.transport) || "funnel";
  const result = await configureTailscale(cfg, { transport, allowOriginChange: args.replaceOrigin });

  if (!result.ok) {
    printTailscaleRecovery(result, transport);
    process.exit(1);
  }

  console.log(`\n  ${transportName(transport)} is ready at ${result.url}`);
  await printPairing(result.config);
}

// ---------- autostart: platform back-ends ----------

function stableNodePath() {
  const candidates = [
    CLI_PATH.startsWith("/opt/homebrew/") && "/opt/homebrew/bin/node",
    CLI_PATH.startsWith("/usr/local/") && "/usr/local/bin/node",
    process.execPath,
  ].filter(Boolean);
  return candidates.find(existsSync) || process.execPath;
}

function servicePath() {
  const inherited = (process.env.PATH || "").split(":").filter(Boolean);
  const common = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".npm-global", "bin"), "/usr/bin", "/bin"];
  return [...new Set([...inherited, ...common])].join(":");
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function macAgent() {
  const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  const logDir = dataPath("logs");
  const node = stableNodePath();
  const configHome = process.env.REMOTE_AGENTS_HOME;

  return {
    install() {
      mkdirSync(dirname(plist), { recursive: true });
      mkdirSync(logDir, { recursive: true });
      const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xmlEscape(node)}</string><string>${xmlEscape(CLI_PATH)}</string><string>serve</string><string>--service</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xmlEscape(servicePath())}</string>
    ${configHome ? `<key>REMOTE_AGENTS_HOME</key><string>${xmlEscape(configHome)}</string>` : ""}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(join(logDir, "out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(logDir, "err.log"))}</string>
</dict></plist>`;
      writeFileSync(plist, plistXml, { mode: 0o600 });
      spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
      const loaded = spawnSync("launchctl", ["bootstrap", domain, plist], { stdio: "inherit" });

      if (loaded.status !== 0) {
        throw new Error(`launchctl bootstrap failed (${loaded.status ?? "unknown status"})`);
      }

      const started = spawnSync("launchctl", ["kickstart", `${domain}/${LABEL}`], { stdio: "inherit" });

      if (started.status !== 0) {
        throw new Error(`launchctl kickstart failed (${started.status ?? "unknown status"})`);
      }
    },
    uninstall() {
      spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });

      if (existsSync(plist)) {
        rmSync(plist);
      }
    },
    start() {
      if (!existsSync(plist)) { throw new Error("service is not installed; run remote-agents setup"); }
      const loaded = spawnSync("launchctl", ["bootstrap", domain, plist], { stdio: "ignore" });
      const started = spawnSync("launchctl", ["kickstart", `${domain}/${LABEL}`], { stdio: "inherit" });

      if (loaded.status !== 0 && started.status !== 0) {
        throw new Error("launchctl could not start the service");
      }
    },
    stop() { spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" }); },
    status() {
      const r = spawnSync("launchctl", ["print", `${domain}/${LABEL}`], { encoding: "utf8" });
      const pid = (r.stdout || "").match(/pid = (\d+)/);
      return r.status === 0 ? (pid ? `running (pid ${pid[1]})` : "loaded (not running)") : "not installed";
    },
  };
}

function linuxAgent() {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const unit = join(unitDir, "remote-agents.service");

  function sc(...a) { return spawnSync("systemctl", ["--user", ...a], { stdio: "inherit" }); }

  return {
    install() {
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(unit, `[Unit]
Description=remote-agents
After=network.target

[Service]
ExecStart=${stableNodePath()} ${CLI_PATH} serve --service
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`);
      sc("daemon-reload");
      sc("enable", "--now", "remote-agents.service");
      console.log("\n  Tip: run `loginctl enable-linger $USER` so it also runs before you log in.");
    },
    uninstall() {
      sc("disable", "--now", "remote-agents.service");

      if (existsSync(unit)) {
        rmSync(unit);
      }

      sc("daemon-reload");
    },
    start() { sc("start", "remote-agents.service"); },
    stop() { sc("stop", "remote-agents.service"); },
    status() {
      const r = spawnSync("systemctl", ["--user", "is-active", "remote-agents.service"], { encoding: "utf8" });
      return (r.stdout || "").trim() || "unknown";
    },
  };
}

function agent() {
  switch (platform()) {
    case "darwin": return macAgent();
    case "linux": return linuxAgent();
    default: return null;
  }
}

function warnIfEphemeral() {
  if (/[/\\](_npx|npm-cache|\.npm)[/\\]/.test(CLI_PATH)) {
    console.log("\n  ⚠  You're running via a temporary npx download, so autostart would point at a path that disappears.");
    console.log("     Install it persistently first:  npm install -g github:<you>/remote-agents");
    console.log("     Then run:  remote-agents setup\n");
    return true;
  }

  return false;
}

// ---------- dispatch ----------

async function waitForPort(port, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    if (await portReachable(port)) { return true; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

async function diagnostics(a, cfg, { verifyOrigin = true } = {}) {
  const service = a?.status?.() ?? "unsupported";
  const local = validPort(cfg.port) ? await portReachable(cfg.port) : false;
  const tailscale = tailscalePreflight();
  const providers = providerPreflight(cfg);
  let originReachable = null;
  let originMessage = "no verified public address is saved";

  if (cfg.publicUrl) {
    originMessage = cfg.transportVerifiedAt
      ? `saved and previously verified at ${cfg.transportVerifiedAt}`
      : "saved, but no successful verification time is recorded";

    if (verifyOrigin && cfg.token) {
      const check = await verifyHttpsApp(cfg.publicUrl, cfg, { timeoutMs: 12000, requestTimeoutMs: 10000, retryMs: 1000 });
      originReachable = check.ok;
      if (!check.ok) { originMessage += `; not reachable now (${check.message})`; }
    }
  }

  return { service, local, tailscale, providers, originReachable, originMessage };
}

function printDiagnostics(cfg, report) {
  console.log("\n  Remote Agents status");
  console.log(`    Service manager: ${report.service}`);
  console.log(`    Local bridge: ${report.local ? `running on port ${cfg.port}` : validPort(cfg.port) ? `not listening on saved port ${cfg.port}` : "not configured"}`);
  console.log(`    Transport: ${transportName(cfg.transport)}`);
  console.log(`    Tailscale: ${report.tailscale.connected ? report.tailscale.detail : `${report.tailscale.detail} ${report.tailscale.remediation}`}`);
  if (report.tailscale.connected) {
    console.log(`    MagicDNS: ${report.tailscale.magicDnsEnabled ? "enabled" : "disabled — enable it in the Tailscale admin console under DNS"}`);
  }
  console.log(`    Public address: ${cfg.publicUrl || "not configured"}`);
  console.log(`    Origin verification: ${report.originMessage}`);
  if (report.originReachable !== null) {
    console.log(`    Public address reachable now: ${report.originReachable ? "yes" : "no"}`);
  }
  printProviderPreflight(report.providers);
}

async function setup(a, args) {
  if (warnIfEphemeral()) { process.exit(1); }

  augmentPath();
  const cfg = await resolveConfig(args);
  const transport = await chooseTransport(cfg, args);
  requireUsableProvider(cfg);

  if (transport !== "cloudflare") {
    const preflight = tailscalePreflight();
    if (!preflight.connected) {
      printTailscaleRecovery(preflight, transport);
      process.exitCode = 1;
      return;
    }
    console.log(`\n  Tailscale: ${preflight.detail}`);
  }

  const serviceState = a.status();

  if (await portReachable(cfg.port) && !serviceState.startsWith("running")) {
    throw new Error(`port ${cfg.port} is already in use by another process; choose a different --port`);
  }

  a.install();

  if (!(await waitForPort(cfg.port))) {
    throw new Error(`the service was installed but did not begin listening on port ${cfg.port}; check ${dataPath("logs/err.log")}`);
  }

  console.log("\n  Installed. remote-agents will start at login and restart after a crash.");

  if (transport === "cloudflare") {
    writeConfig({ ...readConfig(), transport: "cloudflare" });
    console.error("\n  The local bridge is ready, but no phone QR was printed yet.");
    console.error("  Finish the advanced Cloudflare option:");
    console.error("    1. Create a named tunnel and route a hostname on your domain to this bridge.");
    console.error("    2. Create a self-hosted Cloudflare Access app with an Allow policy for you.");
    console.error("    3. Run:");
    console.error("       remote-agents tunnel --name NAME --hostname agents.example.com --access-protected");
    console.error("  That command withholds the QR until the hostname returns this authenticated app.\n");
    process.exitCode = 1;
    return;
  }

  const ts = await configureTailscale({ ...cfg, transport }, { transport, allowOriginChange: args.replaceOrigin });

  if (ts.ok) {
    console.log(`  ${transportName(transport)} is ready at ${ts.url}`);
  } else {
    printTailscaleRecovery(ts, transport);
    process.exitCode = 1;
    return;
  }

  await printPairing(ts.config);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!cmd || cmd === "serve" || cmd === "run") {
    return serve(args);
  }

  if (cmd === "tunnel") {
    return tunnel(args);
  }

  if (cmd === "tailscale") {
    return tailscale(args);
  }

  const a = agent();

  if (["setup", "install", "uninstall", "start", "stop", "status"].includes(cmd) && !a) {
    console.error(`  Autostart isn't supported on this platform (${platform()}). Run \`remote-agents\` in a terminal or use a tested supervisor.`);
    console.error("  Windows requires a dedicated service-supervision and provider-path port; see PORTABLE_PLAN.md.");
    process.exit(1);
  }

  switch (cmd) {
    case "setup":
    case "install":
      await setup(a, args);
      break;

    case "uninstall":
      a.uninstall();
      console.log("  Autostart removed.");
      break;

    case "start":
      {
      const cfg = await resolveConfig(args);
      a.start();
      if (!(await waitForPort(cfg.port))) { throw new Error(`service did not listen on port ${cfg.port}`); }
      console.log("  Started.");
      const current = readConfig();
      const check = current.publicUrl ? await verifyHttpsApp(current.publicUrl, current) : { ok: false, message: "no verified HTTPS origin is saved" };

      if (check.ok) {
        await printPairing(current);
      } else {
        console.error(`  No phone QR: ${check.message}. Run \`remote-agents tailscale\`.`);
      }
      break;
      }

    case "stop":
      a.stop();
      console.log("  Stopped.");
      break;

    case "status":
      {
        const current = readConfig();
        printDiagnostics(current, await diagnostics(a, current));
      }
      break;

    case "url":
      {
        const current = await resolveConfig(args);
        printDiagnostics(current, await diagnostics(a, current, { verifyOrigin: false }));
        const candidate = current.requestedPublicUrl || current.publicUrl;

        if (!candidate) {
          throw new Error("No verified public address is configured. Run `remote-agents setup` (recommended) or `remote-agents tailscale --transport funnel` while the bridge is running.");
        }

        console.log("\n  Verifying the authenticated app through HTTPS before showing a QR (allowing up to 75 seconds for first-time certificate issuance)…");
        const check = await verifyHttpsApp(candidate, current);

        if (!check.ok) {
          throw new Error(`no QR printed: ${check.message}`);
        }

        const saved = current.requestedPublicUrl
          ? rememberTransport(args.transport || current.transport || "cloudflare", candidate, { allowOriginChange: args.replaceOrigin })
          : readConfig();
        await printPairing(saved);
      }
      break;

    default:
      console.log("usage: remote-agents [serve|setup|tailscale|tunnel|uninstall|start|stop|status|url]");
      console.log("       default: --transport funnel; private: --transport serve; advanced: --transport cloudflare");
  }
}

// npm install -g puts a SYMLINK at bin/<name>, so process.argv[1] is the link,
// not this file. resolve() does not follow symlinks, so comparing the two paths
// directly made main() never run for an installed package: the CLI printed
// nothing and exited 0, which reads as "broken" rather than "misconfigured".
function isThisModuleMain(entry) {
  if (!entry) { return false; }

  try {
    return realpathSync(resolve(entry)) === realpathSync(CLI_PATH);
  } catch {
    return resolve(entry) === CLI_PATH;
  }
}

if (isThisModuleMain(process.argv[1])) {
  main().catch((e) => {
    console.error(`\n  Error: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
