import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const marker = html.indexOf("// BEGIN thread-settings-selection");
const sourceStart = html.indexOf("\n", marker) + 1;
const sourceEnd = html.indexOf("// END thread-settings-selection", sourceStart);
const source = marker >= 0 && sourceEnd >= 0 ? html.slice(sourceStart, sourceEnd) : "";
assert.ok(source, "thread settings selection source must remain extractable");
const context = vm.createContext({});
vm.runInContext(`${source}\nthis.selectThreadSettingsPair = selectThreadSettingsPair;`, context);
const select = context.selectThreadSettingsPair;

const models = [
  {
    id: "current",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
  },
  {
    id: "other",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
  },
];
const fallback = { model: "current", effort: "medium" };

test("new thread uses the provider catalog default instead of blocking first send", () => {
  assert.deepEqual(
    structuredClone(select({ model: null, effort: null, providerConfirmed: null }, models, fallback)),
    { model: "current", effort: "medium", recovery: false, threadOnly: false },
  );
});

test("provider policy without a recorded model pair still uses provider defaults", () => {
  assert.equal(select({ model: null, effort: null, providerConfirmed: { model: null, effort: null } }, models, fallback).model, "current");
});

test("provider effort without a model is paired only with a supporting provider default", () => {
  assert.deepEqual(
    structuredClone(select({ model: null, effort: "low", providerConfirmed: { model: null, effort: "low" } }, models, fallback)),
    { model: "current", effort: "low", recovery: false, threadOnly: false },
  );
  assert.equal(select({ model: null, effort: "high", providerConfirmed: { model: null, effort: "high" } }, models, fallback), null);
});

test("a provider-recorded model without effort chooses that model's own default", () => {
  assert.deepEqual(
    structuredClone(select({ model: "other", effort: null, providerConfirmed: { model: "other", effort: null } }, models, fallback)),
    { model: "other", effort: "high", recovery: false, threadOnly: false },
  );
});

test("a historical provider-owned pair remains usable as a thread-only model", () => {
  assert.deepEqual(
    structuredClone(select({ model: "historic", effort: "xhigh", providerConfirmed: { model: "historic", effort: "xhigh" } }, models, fallback)),
    { model: "historic", effort: "xhigh", recovery: false, threadOnly: true },
  );
});

test("a poisoned saved pair recovers the provider-confirmed pair atomically", () => {
  assert.deepEqual(
    structuredClone(select({ model: "provider-default", effort: "provider-default", providerConfirmed: { model: "current", effort: "medium" } }, models, fallback)),
    { model: "current", effort: "medium", recovery: true, threadOnly: false },
  );
});

test("arbitrary bridge-only or cross-model pairs remain blocked", () => {
  assert.equal(select({ model: "invented", effort: "high", providerConfirmed: null }, models, fallback), null);
  assert.equal(select({ model: "current", effort: "high", providerConfirmed: null }, models, fallback), null);
});
