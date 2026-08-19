import assert from "node:assert/strict";
import test from "node:test";

import { configureServer, handleRequest, resetAuthRateLimits } from "../server.mjs";

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

async function request(path, { headers = {}, remoteAddress = "127.0.0.1" } = {}) {
  const req = {
    method: "GET",
    url: path,
    headers: { host: "127.0.0.1:9491", ...headers },
    socket: { remoteAddress, encrypted: false },
  };
  const res = new MockResponse();
  await handleRequest(req, res);
  return res;
}

function fixture() {
  resetAuthRateLimits();
  configureServer({ host: "127.0.0.1", port: 0, token: TOKEN });
}

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
  assert.match(androidBody, /Install app/);
  assert.match(androidBody, /beforeinstallprompt/);
});
