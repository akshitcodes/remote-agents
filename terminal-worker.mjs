// Crash-isolated PTY owner. This process contains the optional native node-pty
// addon; a native failure can take down terminal sessions, but not the bridge or
// any Codex/Claude/Grok holder process.

import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const terminals = new Map();
let pty;

function ensureSpawnHelperExecutable() {
  if (platform() === "win32") { return; }
  const entry = fileURLToPath(import.meta.resolve("node-pty"));
  const root = resolve(dirname(entry), "..");
  const candidates = [
    join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(root, "build", "Release", "spawn-helper"),
  ];
  for (const helper of candidates) {
    if (!existsSync(helper)) { continue; }
    try { accessSync(helper, constants.X_OK); }
    catch { chmodSync(helper, 0o755); }
    return;
  }
}

function reply(requestId, ok, value = {}) {
  process.send?.({ type: "response", requestId, ok, ...value });
}

function shell() {
  if (platform() === "win32") {
    return { file: process.env.COMSPEC || "powershell.exe", args: [] };
  }
  if (platform() === "darwin") { return { file: "/bin/zsh", args: ["-l"] }; }
  return { file: process.env.SHELL || "/bin/bash", args: ["-l"] };
}

function dimensions(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

async function initialize() {
  try {
    ensureSpawnHelperExecutable();
    const imported = await import("node-pty");
    pty = imported.spawn ? imported : imported.default;
    if (typeof pty?.spawn !== "function") { throw new Error("node-pty did not expose spawn()"); }
    process.send?.({ type: "ready" });
  } catch (error) {
    process.send?.({
      type: "unavailable",
      message: `Interactive terminal backend is unavailable: ${error.message}. The command fallback remains available after passkey verification.`,
    });
  }
}

function createTerminal(message) {
  const spec = shell();
  const terminal = pty.spawn(spec.file, spec.args, {
    name: "xterm-256color",
    cols: dimensions(message.cols, 100, 20, 300),
    rows: dimensions(message.rows, 30, 5, 120),
    cwd: message.cwd,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
  terminals.set(message.sessionId, terminal);
  terminal.onData((data) => process.send?.({ type: "output", sessionId: message.sessionId, data }));
  terminal.onExit(({ exitCode, signal }) => {
    terminals.delete(message.sessionId);
    process.send?.({ type: "exit", sessionId: message.sessionId, exitCode, signal });
  });
  reply(message.requestId, true, { pid: terminal.pid });
}

function closeTerminal(sessionId) {
  const terminal = terminals.get(sessionId);
  if (!terminal) { return; }
  terminals.delete(sessionId);
  try { terminal.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    try { terminal.kill("SIGKILL"); } catch {}
  }, 2000).unref?.();
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") { return; }
  try {
    if (message.type === "create") {
      if (!pty) { return reply(message.requestId, false, { error: "interactive terminal backend is unavailable" }); }
      return createTerminal(message);
    }
    const terminal = terminals.get(message.sessionId);
    if (message.type === "input") {
      if (terminal) { terminal.write(String(message.data ?? "")); }
      return;
    }
    if (message.type === "resize") {
      if (terminal) {
        terminal.resize(
          dimensions(message.cols, 100, 20, 300),
          dimensions(message.rows, 30, 5, 120),
        );
      }
      return;
    }
    if (message.type === "close") {
      closeTerminal(message.sessionId);
      return;
    }
  } catch (error) {
    if (message.requestId) { reply(message.requestId, false, { error: error.message }); }
    else { process.send?.({ type: "error", sessionId: message.sessionId, error: error.message }); }
  }
});

function shutdown() {
  for (const id of terminals.keys()) { closeTerminal(id); }
  setTimeout(() => process.exit(0), 100).unref?.();
}

process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await initialize();
