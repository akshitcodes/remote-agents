// Detect semantic Codex account changes without retaining credential material.
//
// Codex clients read ~/.codex/auth.json when their app-server process starts.
// Account switchers replace that file, but an already-running app-server keeps
// its old account. Poll the tiny local file so atomic renames, in-place copies,
// and missed filesystem notifications all converge on the same behavior.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

function decodeClaims(token) {
  try {
    const payload = String(token ?? "").split(".")[1];
    return payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : {};
  } catch {
    return {};
  }
}

export function codexAuthPath() {
  const configured = String(process.env.CODEX_HOME ?? "").trim();
  const root = configured
    ? (isAbsolute(configured) ? configured : resolve(configured))
    : join(homedir(), ".codex");
  return join(root, "auth.json");
}

export function readCodexAccountIdentity(path = codexAuthPath()) {
  try {
    const auth = JSON.parse(readFileSync(path, "utf8"));
    const tokens = auth?.tokens;
    if (!tokens || typeof tokens !== "object") { return null; }

    const claims = decodeClaims(tokens.id_token ?? tokens.access_token);
    const providerClaims = claims?.["https://api.openai.com/auth"] ?? {};
    const accountId = String(tokens.account_id ?? providerClaims.chatgpt_account_id ?? "").trim() || null;
    const userId = String(providerClaims.chatgpt_user_id ?? claims.sub ?? "").trim() || null;
    const email = String(claims.email ?? providerClaims.email ?? "").trim() || null;
    if (!accountId && !userId) { return null; }

    return {
      key: `${userId ?? "unknown-user"}::${accountId ?? "unknown-account"}`,
      accountId,
      userId,
      email,
    };
  } catch {
    // An in-place credential copy can be briefly incomplete. Keep the last
    // confirmed identity and retry on the next poll instead of reporting a
    // logout or rotating processes on malformed data.
    return null;
  }
}

export class CodexAccountObserver {
  constructor({ path = codexAuthPath(), intervalMs = 1000, readIdentity = readCodexAccountIdentity, onChange = () => {} } = {}) {
    this.path = path;
    this.intervalMs = intervalMs;
    this.readIdentity = readIdentity;
    this.onChange = onChange;
    this.identity = null;
    this.started = false;
    this.timer = null;
  }

  start() {
    if (this.started) { return this.identity; }
    this.started = true;
    this.identity = this.readIdentity(this.path);
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref?.();
    return this.identity;
  }

  check() {
    const next = this.readIdentity(this.path);
    if (!next) { return null; }
    const previous = this.identity;
    this.identity = next;
    if (!previous || previous.key !== next.key) {
      this.onChange({ previous, current: next });
      return { previous, current: next };
    }
    return null;
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); }
    this.timer = null;
    this.started = false;
  }
}
