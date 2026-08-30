// Per-thread Codex account selection without changing the user's global login.
//
// codex-auth keeps managed credential snapshots under CODEX_HOME/accounts and
// switches globally by copying one of them over CODEX_HOME/auth.json. Remote
// Agents must not do that: Codex Desktop, VS Code, and unrelated bridge turns
// all share that file. Instead, an explicitly pinned thread gets a small
// account-specific CODEX_HOME. Conversation state, writer locks, skills, and
// configuration remain shared with the canonical Codex home.

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { readCodexAccountIdentity } from "./codex-account.mjs";

const SHARED_PROFILE_ID = "shared";
const SHARED_DIRECTORIES = [
  "archived_sessions",
  "memories",
  "mcp-oauth-locks",
  "plugins",
  "sessions",
  "shell_snapshots",
  "skills",
  "thread-writer-locks",
];
const SHARED_FILES = ["AGENTS.md"];
const COPIED_CONFIG_FILES = ["config.toml", "keybindings.json"];

function profileError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

function atomicCopy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temp = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  copyFileSync(source, temp);
  chmodSync(temp, 0o600);
  renameSync(temp, destination);
}

function refreshTime(path) {
  const value = readJson(path, null)?.last_refresh;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function accountProfileId(accountKey) {
  return `account-${createHash("sha256").update(accountKey).digest("hex").slice(0, 24)}`;
}

function displayLabel(account) {
  const alias = String(account?.alias ?? "").trim();
  const name = String(account?.account_name ?? "").trim();
  const email = String(account?.email ?? "").trim();
  return alias || name || email || "Codex account";
}

function publicManagedAccount(account) {
  return {
    id: accountProfileId(account.account_key),
    kind: "managed",
    label: displayLabel(account),
    email: String(account.email ?? "").trim() || null,
    plan: String(account.plan ?? "").trim() || null,
    alias: String(account.alias ?? "").trim() || null,
  };
}

export function resolveCodexHome(value = process.env.CODEX_HOME) {
  const configured = String(value ?? "").trim();
  return configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".codex");
}

export class CodexThreadAccounts {
  constructor({
    sharedHome = resolveCodexHome(),
    appHome,
    platform = process.platform,
  } = {}) {
    if (!appHome) { throw new Error("Codex account profiles require appHome"); }
    this.sharedHome = resolve(sharedHome);
    this.appHome = resolve(appHome);
    this.platform = platform;
    this.registryPath = join(this.sharedHome, "accounts", "registry.json");
    this.assignmentFile = join(this.appHome, "codex-thread-accounts.json");
    this.runtimeRoot = join(this.appHome, "codex-account-homes");
    this.assignments = new Map();
    this.loadAssignments();
  }

  loadAssignments() {
    const stored = readJson(this.assignmentFile, {});
    const rows = stored?.threads && typeof stored.threads === "object" ? stored.threads : {};
    for (const [threadId, profileId] of Object.entries(rows)) {
      if (threadId && typeof profileId === "string" && profileId !== SHARED_PROFILE_ID) {
        this.assignments.set(threadId, profileId);
      }
    }
  }

  persistAssignments() {
    atomicJson(this.assignmentFile, { version: 1, threads: Object.fromEntries(this.assignments) });
  }

  registry() {
    const value = readJson(this.registryPath, null);
    const accounts = Array.isArray(value?.accounts)
      ? value.accounts.filter((account) => typeof account?.account_key === "string" && account.account_key)
      : [];
    return { activeAccountKey: value?.active_account_key ?? null, accounts };
  }

  managedAccounts() {
    const seen = new Set();
    return this.registry().accounts
      .filter((account) => {
        const id = accountProfileId(account.account_key);
        if (seen.has(id)) { return false; }
        seen.add(id);
        return true;
      })
      .map(publicManagedAccount)
      .sort((a, b) => (a.label || a.email || "").localeCompare(b.label || b.email || ""));
  }

  listAccounts() {
    const identity = readCodexAccountIdentity(join(this.sharedHome, "auth.json"));
    const registry = this.registry();
    const active = registry.accounts.find((account) => account.account_key === registry.activeAccountKey)
      ?? registry.accounts.find((account) => account.email && account.email === identity?.email);
    return [{
      id: SHARED_PROFILE_ID,
      kind: "shared",
      label: "Shared Codex login",
      email: identity?.email ?? (String(active?.email ?? "").trim() || null),
      plan: String(active?.plan ?? "").trim() || null,
      alias: null,
    }, ...this.managedAccounts()];
  }

  selectedProfileId(threadId) {
    return this.assignments.get(String(threadId ?? "")) ?? SHARED_PROFILE_ID;
  }

  setThreadProfile(threadId, profileId) {
    const id = String(threadId ?? "").trim();
    const selected = String(profileId ?? "").trim();
    if (!id || id.length > 300) { throw profileError("threadId is required", "invalid_thread_account"); }
    if (!selected) { throw profileError("account profile is required", "invalid_thread_account"); }
    // Validate both registry membership and the credential snapshot before
    // persisting the selection. A task must never appear pinned successfully
    // only to fail later on its first send because the snapshot was missing or
    // belonged to another account.
    if (selected !== SHARED_PROFILE_ID) { this.managedRecord(selected); }
    if (selected === SHARED_PROFILE_ID) { this.assignments.delete(id); }
    else { this.assignments.set(id, selected); }
    this.persistAssignments();
    return selected;
  }

  managedRecord(profileId) {
    const account = this.registry().accounts.find((candidate) => accountProfileId(candidate.account_key) === profileId);
    if (!account) { throw profileError("That Codex account is no longer available", "codex_account_unavailable", 409); }
    const filename = `${Buffer.from(account.account_key, "utf8").toString("base64url")}.auth.json`;
    const path = join(this.sharedHome, "accounts", filename);
    if (!existsSync(path)) { throw profileError("The selected Codex account snapshot is missing", "codex_account_snapshot_missing", 409); }
    const accountsRoot = realpathSync(join(this.sharedHome, "accounts"));
    const source = realpathSync(path);
    if (dirname(source) !== accountsRoot) { throw profileError("The selected Codex account snapshot is invalid", "codex_account_snapshot_invalid", 409); }
    const identity = readCodexAccountIdentity(source);
    if (!identity || identity.key !== account.account_key) {
      throw profileError("The selected Codex account snapshot does not match its registry entry", "codex_account_snapshot_mismatch", 409);
    }
    return { account, source, identity };
  }

  ensureSharedDirectory(runtimeHome, name) {
    const source = join(this.sharedHome, name);
    if (!existsSync(source) || !lstatSync(source).isDirectory()) { return; }
    const destination = join(runtimeHome, name);
    if (existsSync(destination)) {
      let actual;
      try { actual = realpathSync(destination); } catch {}
      if (actual !== realpathSync(source)) {
        throw profileError(`Codex account runtime path is not shared safely: ${name}`, "codex_account_runtime_conflict", 500);
      }
      return;
    }
    symlinkSync(source, destination, this.platform === "win32" ? "junction" : "dir");
  }

  ensureSharedFile(runtimeHome, name) {
    const source = join(this.sharedHome, name);
    if (!existsSync(source) || !lstatSync(source).isFile()) { return; }
    const destination = join(runtimeHome, name);
    if (existsSync(destination)) {
      let actual;
      try { actual = realpathSync(destination); } catch {}
      if (actual !== realpathSync(source)) {
        throw profileError(`Codex account runtime file is not shared safely: ${name}`, "codex_account_runtime_conflict", 500);
      }
      return;
    }
    symlinkSync(source, destination, "file");
  }

  prepareManagedProfile(profileId) {
    const { account, source, identity } = this.managedRecord(profileId);
    const runtimeHome = join(this.runtimeRoot, profileId);
    mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    chmodSync(runtimeHome, 0o700);
    const runtimeAuth = join(runtimeHome, "auth.json");
    if (!existsSync(runtimeAuth)) {
      atomicCopy(source, runtimeAuth);
    } else {
      const runtimeIdentity = readCodexAccountIdentity(runtimeAuth);
      if (!runtimeIdentity || runtimeIdentity.key !== identity.key) {
        throw profileError("The private Codex account runtime is invalid; remove and reassign this account", "codex_account_runtime_invalid", 409);
      }
      // codex-auth may have refreshed this account while it was globally
      // active. A pinned process is startup-bound, so import that newer token
      // generation before spawning it. Never replace a newer private refresh
      // with an older registry snapshot.
      if (refreshTime(source) > refreshTime(runtimeAuth)) {
        atomicCopy(source, runtimeAuth);
      }
    }
    for (const name of COPIED_CONFIG_FILES) {
      const sourceFile = join(this.sharedHome, name);
      if (existsSync(sourceFile)) { atomicCopy(sourceFile, join(runtimeHome, name)); }
    }
    for (const name of SHARED_DIRECTORIES) { this.ensureSharedDirectory(runtimeHome, name); }
    for (const name of SHARED_FILES) { this.ensureSharedFile(runtimeHome, name); }
    return {
      profileId,
      kind: "managed",
      label: displayLabel(account),
      expectedIdentity: identity,
      env: {
        CODEX_HOME: runtimeHome,
        CODEX_SQLITE_HOME: String(process.env.CODEX_SQLITE_HOME ?? this.sharedHome),
      },
    };
  }

  contextForProfile(profileId) {
    if (!profileId || profileId === SHARED_PROFILE_ID) {
      return {
        profileId: SHARED_PROFILE_ID,
        kind: "shared",
        label: "Shared Codex login",
        expectedIdentity: readCodexAccountIdentity(join(this.sharedHome, "auth.json")),
        env: {},
      };
    }
    return this.prepareManagedProfile(profileId);
  }

  contextForThread(threadId) {
    return this.contextForProfile(this.selectedProfileId(threadId));
  }

  syncRuntimeProfile(profileId) {
    if (!profileId || profileId === SHARED_PROFILE_ID) { return false; }
    const { source, identity } = this.managedRecord(profileId);
    const runtimeAuth = join(this.runtimeRoot, profileId, "auth.json");
    if (!existsSync(runtimeAuth)) { return false; }
    const runtimeIdentity = readCodexAccountIdentity(runtimeAuth);
    if (!runtimeIdentity || runtimeIdentity.key !== identity.key) {
      throw profileError("The private Codex account runtime changed identity; credentials were not synchronized", "codex_account_runtime_mismatch", 409);
    }
    // Both codex-auth and Codex may refresh this account. Keep the newest
    // credential generation so a slower process exit cannot overwrite a later
    // refresh with a stale token set.
    if (refreshTime(runtimeAuth) <= refreshTime(source)) { return false; }
    atomicCopy(runtimeAuth, source);
    return true;
  }

  publicThreadState(threadId, effectiveProfileId = null) {
    const selectedProfileId = this.selectedProfileId(threadId);
    return {
      accounts: this.listAccounts(),
      selectedProfileId,
      effectiveProfileId,
      switchPending: !!effectiveProfileId && effectiveProfileId !== selectedProfileId,
    };
  }
}

export { SHARED_PROFILE_ID };
