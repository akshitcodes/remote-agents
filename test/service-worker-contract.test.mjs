import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("installed navigation paints the cached shell before background refresh", () => {
  assert.match(worker, /navigationCacheFirst\(req, event\)/);
  assert.match(worker, /const cached = await cache\.match\("\/"\)/);
  assert.match(worker, /if \(cached\) \{\s*event\.waitUntil\(network\.then\(\(\) => \{\}\)\);\s*return cached;/s);
  assert.doesNotMatch(worker, /NAV_TIMEOUT_MS|navigationNetworkFirst/);
});

test("terminal browser handoff bypasses every deployed app-shell cache", () => {
  assert.match(server, /url\.pathname === "\/api\/terminal\/handoff"/);
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
});
