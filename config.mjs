// Shared persistent state for remote-agents.
//
// Keep one configuration mechanism for the CLI, server, providers and push.
// REMOTE_AGENTS_HOME exists for isolated tests and advanced relocations; normal
// installs continue to use the established ~/.codex-phone directory.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function configDir() {
  const override = process.env.REMOTE_AGENTS_HOME;

  if (!override) {
    return join(homedir(), ".codex-phone");
  }

  return isAbsolute(override) ? override : resolve(override);
}

export function dataPath(name) {
  return join(configDir(), name);
}

export function readJson(name, fallback = {}) {
  const path = dataPath(name);

  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(name, value) {
  const dir = configDir();
  const path = dataPath(name);
  const temp = join(dir, `.${name}.${process.pid}.tmp`);

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Tighten older installations too: this directory contains the pairing token,
  // VAPID private key and browser push endpoints.
  try { chmodSync(dir, 0o700); } catch {}

  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);

  try { chmodSync(path, 0o600); } catch {}
  return path;
}

export function readConfig() {
  const path = dataPath("config.json");

  if (!existsSync(path)) {
    return {};
  }

  try {
    const value = JSON.parse(readFileSync(path, "utf8"));

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected a JSON object");
    }

    return value;
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}; refusing to replace the saved pairing identity`);
  }
}

export function writeConfig(value) {
  return writeJson("config.json", value);
}
