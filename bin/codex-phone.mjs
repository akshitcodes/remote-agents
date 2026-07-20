#!/usr/bin/env node
// remote-agents CLI — run the bridge or manage always-on autostart.
//
//   remote-agents                 start the server (foreground) + print pairing QR
//   remote-agents install         set up autostart (launchd / systemd / Task Scheduler)
//   remote-agents uninstall       remove autostart
//   remote-agents start|stop|status   control the autostart service
//   remote-agents url             print pairing URLs again
//
// Flags (serve): --host <ip> (default 0.0.0.0), --port <n> (default 8484),
//                --token <secret> (default: generated once, saved to ~/.codex-phone)

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, networkInterfaces, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "../server.mjs";
import qrcode from "qrcode-terminal";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = fileURLToPath(import.meta.url);
const NODE = process.execPath;

const CONFIG_DIR = join(homedir(), ".codex-phone");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const LABEL = "com.codexphone.server";

// ---------- config / token ----------

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function resolveConfig(args) {
  const cfg = loadConfig();
  let changed = false;

  if (args.token) {
    cfg.token = args.token;
    changed = true;
  }

  if (!cfg.token) {
    cfg.token = randomBytes(9).toString("base64url");
    changed = true;
  }

  if (args.port) {
    cfg.port = Number(args.port);
    changed = true;
  }

  if (changed) {
    saveConfig(cfg);
  }

  return { host: args.host || "0.0.0.0", port: cfg.port || 8484, token: cfg.token };
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--host") { args.host = argv[++i]; }
    else if (a === "--port") { args.port = argv[++i]; }
    else if (a === "--token") { args.token = argv[++i]; }
  }

  return args;
}

// ---------- network discovery ----------

function tailscaleIP() {
  const candidates = ["tailscale"];

  if (platform() === "darwin") {
    candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  }

  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ["ip", "-4"], { encoding: "utf8", timeout: 4000 });
      const ip = (r.stdout || "").split("\n").map((l) => l.trim()).find((l) => /^100\./.test(l));

      if (ip) {
        return ip;
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

function lanIP() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) {
        return a.address;
      }
    }
  }

  return null;
}

function pairingLinks(port, token) {
  const links = [];
  const ts = tailscaleIP();
  const lan = lanIP();

  if (ts) {
    links.push({ label: "Anywhere (Tailscale)", url: `http://${ts}:${port}/?t=${token}` });
  }

  if (lan) {
    links.push({ label: "Same Wi-Fi (LAN)", url: `http://${lan}:${port}/?t=${token}` });
  }

  links.push({ label: "This computer", url: `http://127.0.0.1:${port}/?t=${token}` });
  return links;
}

function printLinks(port, token) {
  const links = pairingLinks(port, token);
  const primary = links[0];

  console.log("\n  Scan on your phone:\n");
  qrcode.generate(primary.url, { small: true });
  console.log("  Open one of these, then Add to Home Screen:\n");

  for (const l of links) {
    console.log(`    ${l.label.padEnd(22)} ${l.url}`);
  }

  if (!tailscaleIP()) {
    console.log("\n  Tip: install Tailscale on this machine + your phone for access from anywhere (not just same Wi-Fi).");
  }

  console.log("");
}

// Autostart launchers (launchd/systemd) run with a minimal PATH that omits
// Homebrew/npm/user bin dirs, so `codex`/`claude` wouldn't be found. Prepend the
// common locations so spawning the provider CLIs works regardless of launcher.
function augmentPath() {
  if (platform() === "win32") {
    return;
  }

  const extra = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".npm-global", "bin"), "/usr/bin", "/bin"];
  const cur = (process.env.PATH || "").split(":").filter(Boolean);
  process.env.PATH = [...new Set([...cur, ...extra])].join(":");
}

// ---------- serve ----------

async function serve(args) {
  augmentPath();
  const { host, port, token } = resolveConfig(args);

  try {
    await startServer({ host, port, token });
  } catch (e) {
    if (e.code === "EADDRINUSE") {
      console.error(`\n  Port ${port} is already in use. Another codex-phone may be running (try: codex-phone status),\n  or pass a different --port.\n`);
      process.exit(1);
    }

    throw e;
  }

  console.log(`\n  codex-phone is running (bound ${host}:${port}).`);
  printLinks(port, token);
}

// ---------- autostart: platform back-ends ----------

function macAgent() {
  const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  const logDir = join(CONFIG_DIR, "logs");

  return {
    install() {
      mkdirSync(dirname(plist), { recursive: true });
      mkdirSync(logDir, { recursive: true });
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${NODE}</string><string>${CLI_PATH}</string><string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${join(logDir, "out.log")}</string>
  <key>StandardErrorPath</key><string>${join(logDir, "err.log")}</string>
</dict></plist>`;
      writeFileSync(plist, xml);
      spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
      spawnSync("launchctl", ["bootstrap", domain, plist], { stdio: "inherit" });
      spawnSync("launchctl", ["kickstart", `${domain}/${LABEL}`], { stdio: "ignore" });
    },
    uninstall() {
      spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });

      if (existsSync(plist)) {
        rmSync(plist);
      }
    },
    start() { spawnSync("launchctl", ["bootstrap", domain, plist], { stdio: "ignore" }); spawnSync("launchctl", ["kickstart", `${domain}/${LABEL}`], { stdio: "ignore" }); },
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
  const unit = join(unitDir, "codex-phone.service");

  function sc(...a) { return spawnSync("systemctl", ["--user", ...a], { stdio: "inherit" }); }

  return {
    install() {
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(unit, `[Unit]
Description=codex-phone
After=network.target

[Service]
ExecStart=${NODE} ${CLI_PATH} serve
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`);
      sc("daemon-reload");
      sc("enable", "--now", "codex-phone.service");
      console.log("\n  Tip: run `loginctl enable-linger $USER` so it also runs before you log in.");
    },
    uninstall() {
      sc("disable", "--now", "codex-phone.service");

      if (existsSync(unit)) {
        rmSync(unit);
      }

      sc("daemon-reload");
    },
    start() { sc("start", "codex-phone.service"); },
    stop() { sc("stop", "codex-phone.service"); },
    status() {
      const r = spawnSync("systemctl", ["--user", "is-active", "codex-phone.service"], { encoding: "utf8" });
      return (r.stdout || "").trim() || "unknown";
    },
  };
}

function windowsAgent() {
  const tn = "codex-phone";
  const tr = `\"${NODE}\" \"${CLI_PATH}\" serve`;

  return {
    install() {
      spawnSync("schtasks", ["/create", "/tn", tn, "/sc", "onlogon", "/rl", "limited", "/tr", tr, "/f"], { stdio: "inherit" });
      spawnSync("schtasks", ["/run", "/tn", tn], { stdio: "ignore" });
      console.log("\n  Note: Windows Task Scheduler starts it at logon but won't auto-restart on crash.");
    },
    uninstall() { spawnSync("schtasks", ["/delete", "/tn", tn, "/f"], { stdio: "inherit" }); },
    start() { spawnSync("schtasks", ["/run", "/tn", tn], { stdio: "inherit" }); },
    stop() { spawnSync("schtasks", ["/end", "/tn", tn], { stdio: "inherit" }); },
    status() {
      const r = spawnSync("schtasks", ["/query", "/tn", tn], { encoding: "utf8" });
      return r.status === 0 ? "installed" : "not installed";
    },
  };
}

function agent() {
  switch (platform()) {
    case "darwin": return macAgent();
    case "linux": return linuxAgent();
    case "win32": return windowsAgent();
    default: return null;
  }
}

function warnIfEphemeral() {
  if (/[/\\](_npx|npm-cache|\.npm)[/\\]/.test(CLI_PATH)) {
    console.log("\n  ⚠  You're running via a temporary npx download, so autostart would point at a path that disappears.");
    console.log("     Install it persistently first:  npm install -g github:<you>/remote-agents");
    console.log("     Then run:  remote-agents install\n");
    return true;
  }

  return false;
}

// ---------- dispatch ----------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const cfg = loadConfig();
  const port = cfg.port || 8484;
  const token = cfg.token || "(run once to generate)";

  if (!cmd || cmd === "serve" || cmd === "run") {
    return serve(args);
  }

  const a = agent();

  if (["install", "uninstall", "start", "stop", "status"].includes(cmd) && !a) {
    console.error(`  Autostart isn't supported on this platform (${platform()}). Run \`codex-phone\` in a terminal or your own supervisor.`);
    process.exit(1);
  }

  switch (cmd) {
    case "install":
      if (warnIfEphemeral()) { process.exit(1); }

      resolveConfig(args); // ensure token exists before the service starts
      a.install();
      console.log(`\n  Installed. codex-phone will start automatically and stay running.`);
      printLinks(port, cfg.token);
      break;

    case "uninstall":
      a.uninstall();
      console.log("  Autostart removed.");
      break;

    case "start":
      a.start();
      console.log("  Started.");
      printLinks(port, token);
      break;

    case "stop":
      a.stop();
      console.log("  Stopped.");
      break;

    case "status":
      console.log(`  ${a.status()}`);
      printLinks(port, token);
      break;

    case "url":
      printLinks(port, token);
      break;

    default:
      console.log("usage: remote-agents [serve|install|uninstall|start|stop|status|url]");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
