import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexThreadAccounts, SHARED_PROFILE_ID } from "../codex-profiles.mjs";

function jwt(claims) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function auth(user, account, email, secret) {
  return {
    tokens: {
      account_id: account,
      access_token: secret,
      refresh_token: `${secret}-refresh`,
      id_token: jwt({ sub: user, email }),
    },
    last_refresh: "2026-08-29T00:00:00.000Z",
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "remote-agents-codex-profiles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sharedHome = join(root, "codex");
  const appHome = join(root, "app");
  const accountsDir = join(sharedHome, "accounts");
  mkdirSync(accountsDir, { recursive: true });
  const records = [
    { account_key: "user-a::account-a", email: "a@example.com", alias: "Primary", plan: "pro" },
    { account_key: "user-b::account-b", email: "b@example.com", alias: "Work", plan: "team" },
  ];
  writeFileSync(join(accountsDir, "registry.json"), JSON.stringify({
    schema_version: 3,
    active_account_key: records[0].account_key,
    accounts: records,
  }));
  for (const [index, record] of records.entries()) {
    const filename = `${Buffer.from(record.account_key).toString("base64url")}.auth.json`;
    writeFileSync(join(accountsDir, filename), JSON.stringify(auth(`user-${index ? "b" : "a"}`, `account-${index ? "b" : "a"}`, record.email, `secret-${index}`)));
  }
  writeFileSync(join(sharedHome, "auth.json"), JSON.stringify(auth("user-a", "account-a", "a@example.com", "global-secret")));
  writeFileSync(join(sharedHome, "config.toml"), "model = \"provider-default\"\n");
  for (const name of ["sessions", "archived_sessions", "thread-writer-locks", "skills", "memories", "mcp-oauth-locks", "plugins", "shell_snapshots"]) {
    mkdirSync(join(sharedHome, name), { recursive: true });
  }
  return { sharedHome, appHome };
}

test("Codex account list exposes only opaque profile metadata and defaults every thread to shared", (t) => {
  const paths = fixture(t);
  const accounts = new CodexThreadAccounts(paths);
  const state = accounts.publicThreadState("thread-a");

  assert.equal(state.selectedProfileId, SHARED_PROFILE_ID);
  assert.equal(state.accounts[0].label, "Shared Codex login");
  assert.equal(state.accounts.length, 3);
  assert.match(state.accounts[1].id, /^account-[a-f0-9]{24}$/);
  assert.doesNotMatch(JSON.stringify(state), /account_key|access_token|refresh_token|global-secret|secret-0/);
});

test("a pinned Codex account is durable and prepares a private credential home with shared thread state", (t) => {
  const paths = fixture(t);
  const accounts = new CodexThreadAccounts(paths);
  const profile = accounts.managedAccounts().find((candidate) => candidate.email === "b@example.com");
  accounts.setThreadProfile("thread-b", profile.id);

  const restarted = new CodexThreadAccounts(paths);
  assert.equal(restarted.selectedProfileId("thread-b"), profile.id);
  const context = restarted.contextForThread("thread-b");
  assert.equal(context.profileId, profile.id);
  assert.equal(context.expectedIdentity.email, "b@example.com");
  assert.equal(context.env.CODEX_SQLITE_HOME, paths.sharedHome);
  assert.equal(statSync(context.env.CODEX_HOME).mode & 0o777, 0o700);
  assert.equal(statSync(join(context.env.CODEX_HOME, "auth.json")).mode & 0o777, 0o600);
  assert.equal(realpathSync(join(context.env.CODEX_HOME, "sessions")), realpathSync(join(paths.sharedHome, "sessions")));
  assert.equal(realpathSync(join(context.env.CODEX_HOME, "mcp-oauth-locks")), realpathSync(join(paths.sharedHome, "mcp-oauth-locks")));
  assert.equal(readFileSync(join(context.env.CODEX_HOME, "config.toml"), "utf8"), "model = \"provider-default\"\n");

  restarted.setThreadProfile("thread-b", SHARED_PROFILE_ID);
  assert.equal(new CodexThreadAccounts(paths).selectedProfileId("thread-b"), SHARED_PROFILE_ID);
});

test("a newer pinned runtime credential is synchronized only to its matching codex-auth snapshot", (t) => {
  const paths = fixture(t);
  writeFileSync(join(paths.sharedHome, "AGENTS.md"), "shared instructions\n");
  const accounts = new CodexThreadAccounts(paths);
  const profile = accounts.managedAccounts().find((candidate) => candidate.email === "b@example.com");
  const context = accounts.contextForProfile(profile.id);
  assert.equal(realpathSync(join(context.env.CODEX_HOME, "AGENTS.md")), realpathSync(join(paths.sharedHome, "AGENTS.md")));
  const runtimeAuth = auth("user-b", "account-b", "b@example.com", "new-private-token");
  runtimeAuth.last_refresh = "2026-08-30T00:00:00.000Z";
  writeFileSync(join(context.env.CODEX_HOME, "auth.json"), JSON.stringify(runtimeAuth));
  const globalBefore = readFileSync(join(paths.sharedHome, "auth.json"), "utf8");

  assert.equal(accounts.syncRuntimeProfile(profile.id), true);
  assert.equal(readFileSync(join(paths.sharedHome, "auth.json"), "utf8"), globalBefore);
  const refreshed = accounts.contextForProfile(profile.id);
  assert.equal(readFileSync(join(refreshed.env.CODEX_HOME, "auth.json"), "utf8"), JSON.stringify(runtimeAuth));
  assert.equal(accounts.syncRuntimeProfile(profile.id), false);
});

test("a newer codex-auth snapshot refreshes a stale pinned runtime before its next process starts", (t) => {
  const paths = fixture(t);
  const accounts = new CodexThreadAccounts(paths);
  const profile = accounts.managedAccounts().find((candidate) => candidate.email === "b@example.com");
  const first = accounts.contextForProfile(profile.id);
  const snapshot = join(
    paths.sharedHome,
    "accounts",
    `${Buffer.from("user-b::account-b").toString("base64url")}.auth.json`,
  );
  const refreshed = auth("user-b", "account-b", "b@example.com", "codex-auth-refreshed-token");
  refreshed.last_refresh = "2026-08-31T00:00:00.000Z";
  writeFileSync(snapshot, JSON.stringify(refreshed));

  const next = accounts.contextForProfile(profile.id);
  assert.equal(next.env.CODEX_HOME, first.env.CODEX_HOME);
  assert.equal(readFileSync(join(next.env.CODEX_HOME, "auth.json"), "utf8"), JSON.stringify(refreshed));
  assert.doesNotMatch(readFileSync(join(paths.sharedHome, "auth.json"), "utf8"), /codex-auth-refreshed-token/);
});

test("missing and mismatched managed account snapshots fail closed", (t) => {
  const paths = fixture(t);
  const accounts = new CodexThreadAccounts(paths);
  const profile = accounts.managedAccounts().find((candidate) => candidate.email === "b@example.com");
  const filename = `${Buffer.from("user-b::account-b").toString("base64url")}.auth.json`;
  writeFileSync(join(paths.sharedHome, "accounts", filename), JSON.stringify(auth("other", "account-b", "b@example.com", "wrong")));

  assert.throws(
    () => accounts.contextForProfile(profile.id),
    (error) => error.code === "codex_account_snapshot_mismatch" && error.status === 409,
  );
  assert.throws(
    () => accounts.setThreadProfile("thread-mismatch", profile.id),
    (error) => error.code === "codex_account_snapshot_mismatch" && error.status === 409,
  );
  assert.equal(accounts.selectedProfileId("thread-mismatch"), SHARED_PROFILE_ID);
  assert.throws(
    () => accounts.setThreadProfile("thread-c", "account-does-not-exist"),
    (error) => error.code === "codex_account_unavailable" && error.status === 409,
  );
});
