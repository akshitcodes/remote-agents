import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeProvider, claudeSwapUsage } from "../providers/claude.mjs";
import { CodexProvider } from "../providers/codex.mjs";
import { GrokProvider, grokBillingUsage } from "../providers/grok.mjs";
import { canonicalRateLimits, UsageStateStore } from "../usage-state.mjs";

test("Codex direct rate-limit responses normalize to the shared UI contract", () => {
  const normalized = canonicalRateLimits({
    primary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: 2000 },
    secondary: null,
    credits: { hasCredits: true, balance: "5" },
  });

  assert.equal(normalized.rateLimits.primary.usedPercent, 48);
  assert.equal(normalized.rateLimitResetCredits.balance, "5");
});

test("last successful limits survive a transient refresh failure and restart", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-state-"));
  const file = join(root, "usage.json");
  const first = new UsageStateStore({ file, now: () => 1000 });
  first.merge("codex", { account: { email: "a@example.com" }, rateLimits: { primary: { usedPercent: 48 } } });

  const restarted = new UsageStateStore({ file, now: () => 2000 });
  const result = restarted.merge("codex", { account: null, rateLimits: null, usage: null });

  assert.equal(result.rateLimits.rateLimits.primary.usedPercent, 48);
  assert.equal(result._meta.sources.rateLimits, "last-known");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).codex.values.account.email, "a@example.com");
});

test("partial native events cannot erase measured limits, including the secondary window", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-state-"));
  const store = new UsageStateStore({ file: join(root, "usage.json"), now: () => 1000 });
  store.merge("claude", {
    account: { email: "a@example.com" },
    rateLimits: { rateLimits: {
      primary: { usedPercent: 84, windowDurationMins: 300 },
      secondary: { usedPercent: 67, windowDurationMins: 10080 },
    } },
  });

  const result = store.merge("claude", {
    rateLimits: { primary: { usedPercent: null, windowDurationMins: 300, status: "allowed" } },
  });

  assert.equal(result.rateLimits.rateLimits.primary.usedPercent, 84);
  assert.equal(result.rateLimits.rateLimits.secondary.usedPercent, 67);
  assert.equal(result._meta.sources.rateLimits, "last-known");
});

test("last-known limits are not carried across a known account switch", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-state-"));
  const store = new UsageStateStore({ file: join(root, "usage.json"), now: () => 1000 });
  store.merge("claude", { account: { accountLabel: "Account-1" }, rateLimits: { primary: { usedPercent: 84 } } });

  const switched = store.merge("claude", { account: { accountLabel: "Account-2" } });

  assert.equal(switched.rateLimits, null);
  assert.equal(switched._meta.sources.rateLimits, "unavailable");
});

test("Claude cswap status maps active-account 5h and 7d limits", () => {
  const result = claudeSwapUsage({
    active: {
      number: 2,
      email: "akshit@example.com",
      organizationName: "Adbrew",
      usageStatus: "ok",
      usageFetchedAt: "2026-08-23T20:18:53Z",
      usageAgeSeconds: 124,
      usage: {
        fiveHour: { pct: 84, resetsAt: "2026-08-23T23:50:00Z" },
        sevenDay: { pct: 67, resetsAt: "2026-08-24T20:00:00Z" },
      },
    },
    totalManagedAccounts: 3,
  });

  assert.equal(result.account.accountLabel, "Account-2");
  assert.equal(result.rateLimits.rateLimits.primary.usedPercent, 84);
  assert.equal(result.rateLimits.rateLimits.secondary.usedPercent, 67);
  assert.equal(result.rateLimits.totalManagedAccounts, 3);
  assert.equal(result.usage, null);
});

test("Claude usage invokes the configured cswap-compatible command", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-usage-"));
  const command = join(root, "cswap-fixture");
  writeFileSync(command, `#!/bin/sh
cat <<'JSON'
{"active":{"number":2,"email":"a@example.com","usageStatus":"ok","usage":{"fiveHour":{"pct":84},"sevenDay":{"pct":67}}},"totalManagedAccounts":3}
JSON
`);
  chmodSync(command, 0o700);
  const provider = new ClaudeProvider(() => {}, { usageCommand: command });

  const result = await provider.usage();

  assert.equal(result.rateLimits.rateLimits.primary.usedPercent, 84);
  assert.equal(result.rateLimits.rateLimits.secondary.usedPercent, 67);
  clearInterval(provider.reaper);
});

test("Grok native billing maps weekly account usage and credit balances", () => {
  const result = grokBillingUsage({
    config: {
      creditUsagePercent: 69,
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-08-21T09:22:23Z", end: "2026-08-28T09:22:23Z" },
      prepaidBalance: { val: 1250 },
      onDemandCap: { val: 5000 },
      onDemandUsed: { val: 300 },
      isUnifiedBillingUser: true,
    },
    subscription_tier: "SuperGrok",
  });

  assert.equal(result.account.planType, "SuperGrok");
  assert.equal(result.rateLimits.rateLimits.primary.usedPercent, 69);
  assert.equal(result.rateLimits.rateLimits.primary.windowDurationMins, 10080);
  assert.equal(result.rateLimits.billing.prepaidBalanceUSD, 12.5);
  assert.equal(result.usage, null);
});

test("Codex refresh preserves each previously successful field independently", async () => {
  const provider = new CodexProvider(() => {});
  provider.ready = async () => {};
  let round = 1;
  provider.rpc = async (method) => {
    if (round === 1) {
      if (method === "account/read") { return { account: { email: "a@example.com" } }; }
      if (method === "account/rateLimits/read") { return { primary: { usedPercent: 48 } }; }
      throw new Error(`unexpected RPC: ${method}`);
    }
    if (method === "account/read") { return { account: { email: "new@example.com" } }; }
    throw new Error("temporary RPC failure");
  };

  await provider.usage({ refresh: true });
  round = 2;
  const refreshed = await provider.usage({ refresh: true });

  assert.equal(refreshed.account.email, "new@example.com");
  assert.equal(refreshed.rateLimits.primary.usedPercent, 48);
  assert.equal(refreshed.usage, null);
  provider.child?.kill?.();
});

test("Grok billing checks deduplicate, cache, and honor explicit refresh", async () => {
  let calls = 0;
  const provider = new GrokProvider(() => {}, { billingFetcher: async () => {
    calls += 1;
    return { config: { creditUsagePercent: 12, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } };
  } });

  const [first, second] = await Promise.all([provider.usage(), provider.usage()]);
  const cached = await provider.usage();
  const refreshed = await provider.usage({ refresh: true });

  assert.equal(calls, 2);
  assert.equal(first.rateLimits.rateLimits.primary.usedPercent, 12);
  assert.deepEqual(second, first);
  assert.deepEqual(cached, first);
  assert.deepEqual(refreshed, first);
  clearInterval(provider.reaper);
});

test("Grok billing failure reaches the server fallback when no memory cache exists", async () => {
  const provider = new GrokProvider(() => {}, { billingFetcher: async () => {
    throw new Error("billing unavailable");
  } });

  await assert.rejects(provider.usage({ refresh: true }), /billing unavailable/);
  clearInterval(provider.reaper);
});

test("missing Grok executable rejects the native billing check without crashing", async () => {
  const provider = new GrokProvider(() => {}, { binary: "/definitely-no-grok-here" });

  try {
    await assert.rejects(provider.fetchBillingNative(), /ENOENT|spawn grok/);
  } finally {
    clearInterval(provider.reaper);
  }
});

test("Grok model discovery uses the resolved executable outside the service PATH", async () => {
  const root = mkdtempSync(join(tmpdir(), "grok-models-"));
  const binary = join(root, "grok");
  writeFileSync(binary, "#!/bin/sh\nprintf 'Default model: grok-4.6\\n  * grok-4.6 (default)\\n'\n");
  chmodSync(binary, 0o755);
  const provider = new GrokProvider(() => {}, { binary });

  try {
    const result = await provider.models();
    assert.equal(result.data[0].id, "grok-4.6");
  } finally {
    clearInterval(provider.reaper);
  }
});
