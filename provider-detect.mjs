// Provider discovery and readiness — one source of truth for the CLI and server.
//
// Readiness is deliberately three-state. A provider CLI we cannot interrogate is
// NOT the same as one that is signed out, and treating the two alike is what
// blocked setup on machines where the auth probe was slow or the credentials
// live somewhere we had not looked:
//
//   missing     no binary found anywhere we know to look
//   signed_out  the CLI told us, in words, that nobody is signed in
//   unknown     installed, but nothing proved either way — proceed, warn
//   ready       we have positive evidence of a signed-in account
//
// Evidence is gathered cheapest-first: credential stores on disk (and the macOS
// Keychain, where Claude Code actually keeps its OAuth tokens) cannot hang, so
// they run before any subprocess. The CLI probe then only ever *improves* the
// verdict. The authority on whether a provider truly works is the real session
// attempt; this module exists to guide setup, not to gate it.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { readConfig } from "./config.mjs";

const HOME = homedir();
const IS_WINDOWS = platform() === "win32";
const IS_MAC = platform() === "darwin";

// Probing auth touches disk, keychains and sometimes the network, and every one
// of those is slow the first time a CLI runs on a fresh machine. 8s was not
// enough; a probe that is killed mid-flight looks exactly like a failure.
const DEFAULT_AUTH_PROBE_TIMEOUT_MS = 20000;
const CHEAP_PROBE_TIMEOUT_MS = 5000;

export function authProbeTimeoutMs() {
  const override = Number(process.env.REMOTE_AGENTS_AUTH_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_AUTH_PROBE_TIMEOUT_MS;
}

// Where the install methods actually put these binaries. `which` alone is not
// enough: launchd gives services a minimal PATH, so a binary that setup found
// from an interactive shell would be invisible to the service that follows.
export function searchDirs() {
  // An escape hatch for layouts we do not know (Nix profiles, corporate images,
  // bespoke prefixes): replaces the built-in list, while PATH is still honoured.
  const override = String(process.env.REMOTE_AGENTS_BIN_DIRS ?? "").trim();

  if (override) {
    const fromPath = String(process.env.PATH || "").split(IS_WINDOWS ? ";" : ":").filter(Boolean);
    return [...new Set([...fromPath, ...override.split(IS_WINDOWS ? ";" : ":").filter(Boolean)])];
  }

  const dirs = [
    join(HOME, ".local", "bin"),          // official install.sh for claude/grok/codex
    "/opt/homebrew/bin",                  // homebrew, Apple silicon
    "/usr/local/bin",                     // homebrew (Intel), plain npm prefix
    join(HOME, ".npm-global", "bin"),
    join(HOME, ".bun", "bin"),
    join(HOME, ".volta", "bin"),
    join(HOME, ".asdf", "shims"),
    join(HOME, "Library", "pnpm"),
    join(HOME, ".yarn", "bin"),
    join(HOME, ".cargo", "bin"),
    join(HOME, ".codex", "bin"),
    "/opt/local/bin",
    "/usr/bin",
    "/bin",
  ];

  if (IS_WINDOWS) {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    if (appData) { dirs.unshift(join(appData, "npm")); }
    if (localAppData) { dirs.unshift(join(localAppData, "Programs")); }
  }

  const fromPath = String(process.env.PATH || "").split(IS_WINDOWS ? ";" : ":").filter(Boolean);
  return [...new Set([...fromPath, ...dirs])];
}

// PATH for every provider subprocess we spawn, so a service started by launchd
// resolves the same binaries the user's shell does.
export function augmentedPath() {
  return searchDirs().join(IS_WINDOWS ? ";" : ":");
}

function isExecutableFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

// Name candidates a single logical command can have on disk.
function binaryNames(name) {
  return IS_WINDOWS ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
}

export function findBinary(name, extraCandidates = []) {
  for (const dir of searchDirs()) {
    for (const leaf of binaryNames(name)) {
      const full = join(dir, leaf);
      if (isExecutableFile(full)) { return full; }
    }
  }

  // Bundled copies inside a desktop app are a last resort: a real CLI install is
  // the one the user updates and signs in to, so it must win when both exist.
  for (const candidate of extraCandidates) {
    if (isExecutableFile(candidate)) { return candidate; }
  }

  return null;
}

function runProbe(bin, args, timeout) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout,
    env: { ...process.env, PATH: augmentedPath() },
  });

  // spawnSync reports a killed-by-timeout child through `signal`, and leaves
  // `status` null. Without this the caller cannot tell "said no" from "never
  // answered" — the distinction the whole three-state model rests on.
  const timedOut = result.error?.code === "ETIMEDOUT" || (result.status === null && !!result.signal);

  return {
    status: result.status,
    timedOut,
    failedToStart: !!result.error && result.error.code !== "ETIMEDOUT",
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
  };
}

function parseJsonish(text) {
  const value = String(text ?? "");
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end < start) { return null; }

  try { return JSON.parse(value.slice(start, end + 1)); } catch { return null; }
}

function fileHasContent(path) {
  try { return statSync(path).size > 2; } catch { return false; }
}

function envKeySet(...names) {
  return names.some((name) => String(process.env[name] ?? "").trim().length > 0);
}

// Reads only the item's attributes, never the secret: no `-w`, so macOS answers
// from the metadata and never raises the "allow access" dialog that would hang
// an unattended probe.
function keychainItemExists(service) {
  if (!IS_MAC) { return false; }

  const result = spawnSync("security", ["find-generic-password", "-s", service], {
    encoding: "utf8",
    timeout: CHEAP_PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return result.status === 0;
}

export function codexAppBinary() {
  const override = String(process.env.REMOTE_AGENTS_CODEX_APP ?? "").trim();
  return override || "/Applications/ChatGPT.app/Contents/Resources/codex";
}

const SIGNED_OUT = /\bnot (?:logged in|signed in|authenticated)\b|\blogged out\b|\bsigned out\b|\bplease (?:log|sign) ?in\b|\b(?:sign|log) ?in required\b|\bauthentication required\b|\bno credentials\b/i;

export const PROVIDERS = [
  {
    name: "codex",
    label: "Codex",
    configKey: "codexBinary",
    binary: "codex",
    // The ChatGPT desktop app ships its own copy; prefer a real CLI install but
    // fall back to the bundle so app-only users are not told to install again.
    // Overridable because the app is not always in /Applications.
    extraCandidates: () => [codexAppBinary()],
    installCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    altInstallCommand: "npm i -g @openai/codex",
    loginCommand: "codex login",
    credentialEvidence() {
      if (envKeySet("OPENAI_API_KEY")) { return "an OPENAI_API_KEY is set"; }
      const auth = join(HOME, ".codex", "auth.json");
      return fileHasContent(auth) ? "credentials found in ~/.codex/auth.json" : null;
    },
    probe: ["login", "status"],
    interpret({ output }) {
      if (SIGNED_OUT.test(output)) { return { state: "signed_out" }; }
      if (/logged in|authenticated|using ChatGPT|API key/i.test(output)) {
        return { state: "ready", detail: output.split("\n").find(Boolean)?.trim() };
      }
      return null;
    },
  },
  {
    name: "claude",
    label: "Claude",
    configKey: "claudeBinary",
    binary: "claude",
    extraCandidates: () => [],
    installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    altInstallCommand: "npm i -g @anthropic-ai/claude-code",
    loginCommand: "claude auth login",
    credentialEvidence() {
      if (envKeySet("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")) { return "an Anthropic key is set in the environment"; }
      // On macOS the OAuth tokens live in the login Keychain, not on disk. Only
      // looking for a credentials file is why a signed-in Mac read as unknown.
      if (keychainItemExists("Claude Code-credentials")) { return "credentials found in the macOS Keychain"; }
      const file = join(HOME, ".claude", ".credentials.json");
      return fileHasContent(file) ? "credentials found in ~/.claude/.credentials.json" : null;
    },
    probe: ["auth", "status"],
    interpret({ output }) {
      const parsed = parseJsonish(output);
      if (parsed?.loggedIn === true) {
        const who = [parsed.email, parsed.orgName].filter(Boolean).join(" · ");
        return { state: "ready", detail: who || undefined };
      }
      if (parsed?.loggedIn === false) { return { state: "signed_out" }; }
      if (SIGNED_OUT.test(output)) { return { state: "signed_out" }; }
      if (/logged.?in/i.test(output)) { return { state: "ready" }; }
      return null;
    },
  },
  {
    name: "grok",
    label: "Grok",
    configKey: "grokBinary",
    binary: "grok",
    extraCandidates: () => [],
    installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
    altInstallCommand: null,
    loginCommand: "grok login",
    credentialEvidence() {
      if (envKeySet("XAI_API_KEY", "GROK_API_KEY")) { return "an xAI key is set in the environment"; }
      const auth = join(HOME, ".grok", "auth.json");
      return fileHasContent(auth) ? "credentials found in ~/.grok/auth.json" : null;
    },
    probe: ["models"],
    interpret({ output }) {
      if (SIGNED_OUT.test(output)) { return { state: "signed_out" }; }
      if (/you are logged in|available models:|grok-/i.test(output)) { return { state: "ready" }; }
      return null;
    },
  },
];

function describe(row) {
  switch (row.state) {
    case "missing": return "not installed";
    case "signed_out": return "installed, but not signed in";
    case "ready": return row.detail ? `ready — ${row.detail}` : "installed and signed in";
    default: return row.reason ? `installed; sign-in unverified (${row.reason})` : "installed; sign-in unverified";
  }
}

// `probe: false` skips every subprocess — a fast path for callers that only need
// to know which providers exist (the server's provider list, for instance).
export function detectProvider(spec, { cfg = {}, probe = true } = {}) {
  const configured = String(cfg[spec.configKey] ?? "").trim();
  const bin = configured
    ? (isExecutableFile(configured) ? configured : findBinary(spec.binary, spec.extraCandidates()))
    : findBinary(spec.binary, spec.extraCandidates());

  const base = {
    name: spec.name,
    label: spec.label,
    installCommand: spec.installCommand,
    altInstallCommand: spec.altInstallCommand,
    loginCommand: spec.loginCommand,
  };

  if (!bin) {
    const row = { ...base, path: null, installed: false, state: "missing" };
    return { ...row, detail: describe(row), usable: false, confirmed: false };
  }

  const evidence = spec.credentialEvidence();
  let state = evidence ? "ready" : "unknown";
  let detail;
  let reason = evidence ? undefined : "no stored credentials found";

  if (probe) {
    const result = runProbe(bin, spec.probe, authProbeTimeoutMs());
    const verdict = spec.interpret(result);

    if (verdict) {
      state = verdict.state;
      detail = verdict.detail;
      reason = undefined;
    } else if (!evidence) {
      // Nothing said yes, nothing said no. Say which, precisely, so the user is
      // not left guessing whether the CLI is broken or just quiet.
      reason = result.timedOut
        ? `\`${spec.binary} ${spec.probe.join(" ")}\` did not answer within ${Math.round(authProbeTimeoutMs() / 1000)}s`
        : result.failedToStart
          ? `\`${spec.binary}\` could not be run`
          : "the CLI did not report a sign-in state";
    }
  }

  const row = { ...base, path: bin, installed: true, state, detail, reason };

  return {
    ...row,
    detail: describe(row),
    // Only a proven sign-out or a missing binary is disqualifying. "Unknown"
    // stays selectable: the real session attempt is the authority, and it
    // reports a far better error than a guess made at setup time ever could.
    usable: state === "ready" || state === "unknown",
    confirmed: state === "ready",
  };
}

export function detectProviders(options = {}) {
  const rows = PROVIDERS.map((spec) => detectProvider(spec, options));

  return {
    rows,
    installed: rows.filter((row) => row.installed),
    usable: rows.filter((row) => row.usable),
    confirmed: rows.filter((row) => row.confirmed),
  };
}

// What, if anything, should stop setup. Kept pure and separate from printing so
// the policy can be stated once and tested: only facts block. "Installed but we
// could not read the sign-in state" is not a fact about the user's account, and
// the session attempt reports the real reason far better than a setup-time guess.
export function setupBlocker(result) {
  if (!result.installed.length) {
    return "No provider CLI is installed. Install Codex, Claude, or Grok using a command above, then re-run this command.";
  }

  if (!result.usable.length) {
    const out = result.installed.filter((row) => row.state === "signed_out");
    return `Installed, but signed out of ${out.map((row) => row.label).join(", ")}. Run \`${out[0].loginCommand}\`, then re-run this command.`;
  }

  return null;
}

// Absolute paths worth persisting so the launchd service resolves the same
// binaries the interactive shell did, even if PATH differs.
export function resolvedBinaries(rows) {
  const out = {};

  for (const spec of PROVIDERS) {
    const row = rows.find((candidate) => candidate.name === spec.name);
    if (row?.path && row.path.includes("/")) { out[spec.configKey] = row.path; }
  }

  return out;
}

// Cached absolute path for a provider command, for the hot path where a session
// is being spawned. Config wins (a user override), then discovery; the bare name
// remains a last resort so an unusual install still gets a real spawn error
// rather than a silent absence.
const binaryCache = new Map();

export function providerBinary(name) {
  if (binaryCache.has(name)) { return binaryCache.get(name); }

  const spec = PROVIDERS.find((candidate) => candidate.name === name);
  const configured = spec ? String(readConfigSafe()[spec.configKey] ?? "").trim() : "";
  const resolved = (configured && isExecutableFile(configured))
    ? configured
    : findBinary(name, spec?.extraCandidates?.() ?? []) ?? name;

  binaryCache.set(name, resolved);
  return resolved;
}

function readConfigSafe() {
  try { return readConfig(); } catch { return {}; }
}
