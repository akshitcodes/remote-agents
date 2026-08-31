import assert from "node:assert/strict";
import test from "node:test";

import { requireReachableTerminalOrigin } from "../server.mjs";

test("terminal setup keeps the user in-app when the saved Tailscale origin is offline", async () => {
  await assert.rejects(
    requireReachableTerminalOrigin("https://bridge.example.ts.net", async () => { throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); }),
    (error) => error.code === "terminal_origin_unreachable"
      && error.status === 409
      && /Open Tailscale and connect/.test(error.message),
  );
});

test("terminal setup accepts a resolving HTTPS origin and rejects insecure origins", async () => {
  assert.equal(await requireReachableTerminalOrigin("https://agents.example.test/path", async () => ({ address: "203.0.113.10" })), "https://agents.example.test");
  await assert.rejects(
    requireReachableTerminalOrigin("http://agents.example.test", async () => ({ address: "203.0.113.10" })),
    (error) => error.code === "terminal_origin_unavailable",
  );
});
