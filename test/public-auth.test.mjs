import assert from "node:assert/strict";
import test from "node:test";

import { configureServer, createTerminalDeviceHandoff, handleRequest, resetAuthRateLimits, startLocalTerminalBrowserHandoff } from "../server.mjs";
import { localBridgeProof } from "../local-proof.mjs";

const TOKEN = "portable-test-token-with-at-least-32-characters";

class MockResponse {
  constructor() {
    this.headers = new Map();
    this.statusCode = 200;
    this.headersSent = false;
    this.body = "";
  }

  setHeader(name, value) { this.headers.set(String(name).toLowerCase(), String(value)); }
  getHeader(name) { return this.headers.get(String(name).toLowerCase()) ?? null; }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) { this.setHeader(name, value); }
    this.headersSent = true;
  }
  write(chunk) { this.body += String(chunk ?? ""); }
  end(chunk) { this.body += chunk == null ? "" : String(chunk); this.headersSent = true; }
}

async function request(path, { headers = {}, remoteAddress = "127.0.0.1", method = "GET", body = null } = {}) {
  const req = {
    method,
    url: path,
    headers: { host: "127.0.0.1:9491", ...headers },
    socket: { remoteAddress, encrypted: false },
  };
  if (body != null) {
    const listeners = {};
    req.on = (event, handler) => { listeners[event] = handler; };
    queueMicrotask(() => {
      listeners.data?.(Buffer.from(body));
      listeners.end?.();
    });
  }
  const res = new MockResponse();
  await handleRequest(req, res);
  return res;
}

function fixture() {
  resetAuthRateLimits();
  configureServer({ host: "127.0.0.1", port: 0, token: TOKEN });
}

test("saved legacy pairing identities remain valid after upgrade", () => {
  assert.doesNotThrow(() => configureServer({ host: "127.0.0.1", port: 0, token: "legacy-token" }));
  assert.throws(
    () => configureServer({ host: "127.0.0.1", port: 0, token: "too-short" }),
    /at least 12 characters/,
  );
});

test("unauthenticated responses reveal no app, version, thread, or path data", async () => {
  fixture();
  const response = await request("/");
  const body = response.body;

  assert.equal(response.statusCode, 401);
  assert.equal(response.getHeader("x-remote-agents"), null);
  assert.equal(response.getHeader("x-content-type-options"), "nosniff");
  assert.equal(response.getHeader("x-frame-options"), "DENY");
  assert.match(response.getHeader("content-security-policy"), /frame-ancestors 'none'/);
  assert.doesNotMatch(body, /Remote Agents|remote-agents|version|thread|Users\//i);

  const manifest = await request("/manifest.webmanifest");
  assert.equal(manifest.statusCode, 401, "PWA assets are private until the pairing cookie exists");
});

test("vendored math fonts use a font MIME type", async () => {
  fixture();
  const response = await request("/math-fonts/KaTeX_Main-Regular.woff2", { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.getHeader("content-type"), "font/woff2");
  const unknown = await request("/math-fonts/not-a-katex-font.woff2", { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(unknown.statusCode, 404);
});

test("the terminal document can be embedded only by the authenticated same origin app", async () => {
  fixture();
  const response = await request("/terminal?provider=codex&threadId=thread-embedded", {
    headers: { authorization: `Bearer ${TOKEN}`, "sec-fetch-dest": "iframe" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.getHeader("x-frame-options"), "SAMEORIGIN");
  assert.match(response.getHeader("content-security-policy"), /frame-ancestors 'self'/);
  assert.doesNotMatch(response.getHeader("content-security-policy"), /frame-ancestors 'none'/);
});

test("the loopback setup challenge proves token knowledge without returning the token", async () => {
  fixture();
  const nonce = "a".repeat(64);
  const response = await request(`/internal/local-proof?nonce=${nonce}`);
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.proof, localBridgeProof(TOKEN, nonce));
  assert.doesNotMatch(response.body, new RegExp(TOKEN));

  const remote = await request(`/internal/local-proof?nonce=${nonce}`, { remoteAddress: "203.0.113.12" });
  assert.equal(remote.statusCode, 404);
  const malformed = await request("/internal/local-proof?nonce=short");
  assert.equal(malformed.statusCode, 404);
});

test("terminal browser handoffs use a separate one-use loopback listener", async () => {
  let enrollments = 0;
  let browserBootstraps = 0;
  const handoff = await startLocalTerminalBrowserHandoff({
    provider: "claude",
    threadId: "thread-local-setup",
    browserSecret: "browser-identity-with-at-least-32-bytes",
    ttlMs: 2_000,
    createEnrollment: () => {
      enrollments += 1;
      return { origin: "https://agents.example.test", secret: "passkey-enrollment-secret" };
    },
    createBrowserBootstrap: ({ context, browserSecret, enrollmentSecret, ttlMs }) => {
      browserBootstraps += 1;
      assert.deepEqual(context, { provider: "claude", threadId: "thread-local-setup" });
      assert.equal(browserSecret, "browser-identity-with-at-least-32-bytes");
      assert.equal(enrollmentSecret, "passkey-enrollment-secret");
      assert.equal(ttlMs, undefined);
      return { origin: "https://agents.example.test", secret: "one-use" };
    },
  });
  const handoffUrl = new URL(handoff.url);
  assert.equal(handoffUrl.hostname, "127.0.0.1");
  assert.notEqual(handoffUrl.port, "9491", "the tunnel-facing bridge port must not serve redemption");

  const consumed = await fetch(handoff.url, { redirect: "manual" });
  assert.equal(consumed.status, 302);
  assert.equal(enrollments, 1);
  assert.equal(browserBootstraps, 1);
  assert.equal(consumed.headers.get("location"), "https://agents.example.test/api/terminal/handoff?handoff=one-use");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(fetch(handoff.url, { redirect: "manual" }));
  assert.equal(enrollments, 1);
});

test("an unlocked device can create an independent one-use enrollment handoff", () => {
  const inputs = [];
  const result = createTerminalDeviceHandoff({
    provider: "codex",
    threadId: "thread-phone",
    targetBrowserSecret: "independent-phone-browser-secret-with-32-bytes",
    createEnrollment: () => ({ origin: "https://agents.example.test", secret: "phone-enrollment", code: "1234-5678", expiresAt: 999 }),
    createBrowserBootstrap: (input) => {
      inputs.push(input);
      return { origin: "https://agents.example.test", secret: "phone-handoff" };
    },
  });
  assert.deepEqual(inputs, [{
    browserSecret: "independent-phone-browser-secret-with-32-bytes",
    enrollmentSecret: "phone-enrollment",
    context: { provider: "codex", threadId: "thread-phone" },
  }]);
  assert.deepEqual(result, {
    url: "https://agents.example.test/api/terminal/handoff?handoff=phone-handoff",
    code: "1234-5678",
    expiresAt: 999,
  });
});

test("an expired terminal browser handoff cannot create an enrollment", async () => {
  let enrollments = 0;
  const handoff = await startLocalTerminalBrowserHandoff({
    provider: "claude",
    threadId: "thread-expired-setup",
    browserSecret: "browser-identity-with-at-least-32-bytes",
    ttlMs: 15,
    createEnrollment: () => {
      enrollments += 1;
      return { origin: "https://agents.example.test", secret: "should-not-exist" };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(fetch(handoff.url, { redirect: "manual" }));
  assert.equal(enrollments, 0);
});

test("terminal handoff transfers pairing to the configured HTTPS origin once", async () => {
  resetAuthRateLimits();
  configureServer({ host: "127.0.0.1", port: 0, token: TOKEN, publicOrigin: "https://agents.example.test" });
  const handoff = await startLocalTerminalBrowserHandoff({
    provider: "codex",
    threadId: "thread-cross-origin",
    browserSecret: "existing-browser-identity-with-at-least-32-bytes",
    ttlMs: 2_000,
    createEnrollment: () => ({ origin: "https://agents.example.test", secret: "one-use-enrollment-secret" }),
  });

  const local = await fetch(handoff.url, { redirect: "manual" });
  const publicTarget = new URL(local.headers.get("location"));
  assert.equal(publicTarget.origin, "https://agents.example.test");
  assert.equal(publicTarget.pathname, "/api/terminal/handoff");
  assert.ok(publicTarget.searchParams.get("handoff"));
  assert.equal(publicTarget.hash, "");
  assert.doesNotMatch(local.headers.get("location"), new RegExp(TOKEN));

  const insecure = await request(publicTarget.pathname + publicTarget.search, {
    headers: { host: "agents.example.test" },
  });
  assert.equal(insecure.statusCode, 401);
  assert.equal(insecure.getHeader("set-cookie"), null);

  const wrongHost = await request(publicTarget.pathname + publicTarget.search, {
    headers: { host: "other.example.test", "x-forwarded-proto": "https" },
  });
  assert.equal(wrongHost.statusCode, 401);
  assert.equal(wrongHost.getHeader("set-cookie"), null);

  const spoofedProxy = await request(publicTarget.pathname + publicTarget.search, {
    headers: { host: "agents.example.test", "x-forwarded-proto": "https" },
    remoteAddress: "203.0.113.12",
  });
  assert.equal(spoofedProxy.statusCode, 401);
  assert.equal(spoofedProxy.getHeader("set-cookie"), null);

  const subresource = await request(publicTarget.pathname + publicTarget.search, {
    headers: { host: "agents.example.test", "x-forwarded-proto": "https", "sec-fetch-dest": "image" },
  });
  assert.equal(subresource.statusCode, 401);
  assert.equal(subresource.getHeader("set-cookie"), null);

  const redeemed = await request(publicTarget.pathname + publicTarget.search, {
    headers: { host: "agents.example.test", "x-forwarded-proto": "https" },
  });
  assert.equal(redeemed.statusCode, 302);
  assert.equal(redeemed.getHeader("location"), "https://agents.example.test/terminal?provider=codex&threadId=thread-cross-origin#enroll=one-use-enrollment-secret");
  assert.match(redeemed.getHeader("set-cookie"), /cxp_session=/);
  assert.match(redeemed.getHeader("set-cookie"), /cxp_browser=existing-browser-identity/);
  assert.equal((redeemed.getHeader("set-cookie").match(/SameSite=Lax/g) ?? []).length, 2);
  assert.equal((redeemed.getHeader("set-cookie").match(/HttpOnly/g) ?? []).length, 2);
  assert.equal((redeemed.getHeader("set-cookie").match(/Secure/g) ?? []).length, 2);
  assert.doesNotMatch(redeemed.getHeader("location"), new RegExp(TOKEN));

  const replay = await request(publicTarget.pathname + publicTarget.search, {
    headers: { host: "agents.example.test", "x-forwarded-proto": "https" },
  });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.getHeader("set-cookie"), null);

  const authenticatedReplay = await request(publicTarget.pathname + publicTarget.search, {
    headers: { host: "agents.example.test", "x-forwarded-proto": "https", authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(authenticatedReplay.statusCode, 302);
  assert.equal(authenticatedReplay.getHeader("location"), "/terminal");
});

test("terminal handoff preserves a browser identity already established at the target origin", async () => {
  resetAuthRateLimits();
  configureServer({ host: "127.0.0.1", port: 0, token: TOKEN, publicOrigin: "https://agents.example.test" });
  const handoff = await startLocalTerminalBrowserHandoff({
    provider: "claude",
    threadId: "thread-existing-target",
    browserSecret: "source-origin-browser-identity-with-32-bytes",
    createEnrollment: () => ({ origin: "https://agents.example.test", secret: "target-enrollment-secret" }),
  });
  const local = await fetch(handoff.url, { redirect: "manual" });
  const publicTarget = new URL(local.headers.get("location"));
  const redeemed = await request(publicTarget.pathname + publicTarget.search, {
    headers: {
      host: "agents.example.test",
      "x-forwarded-proto": "https",
      cookie: "cxp_browser=target-origin-browser-identity-with-32-bytes",
    },
  });
  assert.equal(redeemed.statusCode, 302);
  assert.match(redeemed.getHeader("set-cookie"), /cxp_browser=target-origin-browser-identity-with-32-bytes/);
  assert.doesNotMatch(redeemed.getHeader("set-cookie"), /source-origin-browser-identity/);
});

test("an expired public terminal handoff cannot establish browser cookies", async () => {
  resetAuthRateLimits();
  configureServer({ host: "127.0.0.1", port: 0, token: TOKEN, publicOrigin: "https://agents.example.test" });
  const handoff = await startLocalTerminalBrowserHandoff({
    provider: "codex",
    threadId: "thread-expired-public-handoff",
    browserSecret: "existing-browser-identity-with-at-least-32-bytes",
    ttlMs: 2_000,
    browserBootstrapTtlMs: 10,
    createEnrollment: () => ({ origin: "https://agents.example.test", secret: "expired-enrollment-secret" }),
  });
  const local = await fetch(handoff.url, { redirect: "manual" });
  const publicTarget = new URL(local.headers.get("location"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const expired = await request(publicTarget.pathname + publicTarget.search, {
    headers: { host: "agents.example.test", "x-forwarded-proto": "https" },
  });
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.getHeader("set-cookie"), null);
});

test("an unauthenticated browser cannot mint a local terminal handoff", async () => {
  fixture();
  const response = await request("/api/terminal/local-handoff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "claude", threadId: "thread-local-setup" }),
  });
  assert.equal(response.statusCode, 401);
});

test("an authenticated browser gets a one-use canonical terminal handoff", async () => {
  resetAuthRateLimits();
  configureServer({ host: "127.0.0.1", port: 0, token: TOKEN, publicOrigin: "https://localhost" });
  const response = await request("/api/terminal/browser-handoff", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ provider: "codex", threadId: "thread-local-entry" }),
  });
  assert.equal(response.statusCode, 200);
  const target = new URL(JSON.parse(response.body).url);
  assert.equal(target.origin, "https://localhost");
  assert.equal(target.pathname, "/api/terminal/handoff");
  assert.ok(target.searchParams.get("handoff"));

  const redeemed = await request(target.pathname + target.search, {
    headers: { host: "localhost", "x-forwarded-proto": "https" },
  });
  assert.equal(redeemed.statusCode, 302);
  assert.equal(redeemed.getHeader("location"), "https://localhost/terminal?provider=codex&threadId=thread-local-entry");
  assert.match(redeemed.getHeader("set-cookie"), /cxp_session=/);
});

test("an authenticated client can reconcile an unrecorded send without retrying it", async () => {
  fixture();
  const response = await request("/api/send/status?provider=codex&method=steer&threadId=test-thread&requestId=definitely-missing", {
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { state: "not_found" });
});

test("bad token attempts receive exponential rate limiting and block even a later correct token", async () => {
  fixture();
  const headers = { authorization: "Bearer definitely-wrong", "x-forwarded-for": "203.0.113.41" };
  const statuses = [];

  for (let i = 0; i < 5; i++) {
    statuses.push((await request("/api/threads", { headers })).statusCode);
  }

  assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
  const blocked = await request("/", {
    headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "203.0.113.41" },
  });
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.getHeader("retry-after")) >= 1);
});

test("authenticated iOS and Android requests get their exact install guidance", async () => {
  fixture();
  const auth = { authorization: `Bearer ${TOKEN}` };
  const ios = await request("/", {
    headers: { ...auth, "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" },
  });
  const iosBody = ios.body;
  assert.equal(ios.statusCode, 200);
  assert.match(iosBody, /data-platform="ios"/);
  assert.match(iosBody, /Share/);
  assert.match(iosBody, /Add to Home Screen/);

  const android = await request("/", {
    headers: { ...auth, "user-agent": "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36" },
  });
  const androidBody = android.body;
  assert.equal(android.statusCode, 200);
  assert.match(androidBody, /data-platform="android"/);
  assert.match(androidBody, /id="installOnboarding"[^>]*hidden/);
  assert.match(androidBody, /Install app/);
  assert.match(androidBody, /beforeinstallprompt/);
});

test("the authenticated app exposes only providers that passed CLI and login preflight", async () => {
  resetAuthRateLimits();
  configureServer({ host: "127.0.0.1", port: 0, token: TOKEN, usableProviders: ["claude"] });
  const auth = { authorization: `Bearer ${TOKEN}` };
  const shell = await request("/", { headers: auth });

  assert.equal(shell.statusCode, 200);
  assert.match(shell.body, /let AVAILABLE_PROVIDER_NAMES = \["claude"\]/);
  assert.match(shell.body, /Object\.fromEntries\(AVAILABLE_PROVIDER_NAMES/);
  assert.match(shell.body, /button\.dataset\.provider === "all" \|\| PROVIDER_LABELS\[button\.dataset\.provider\]/);

  const providers = await request("/api/providers", { headers: auth });
  assert.equal(providers.statusCode, 200);
  assert.deepEqual(JSON.parse(providers.body), { providers: ["claude"] });

  const deadCodex = await request("/api/models?provider=codex", { headers: auth });
  assert.equal(deadCodex.statusCode, 400);
  assert.match(deadCodex.body, /unknown provider: codex/);
});
