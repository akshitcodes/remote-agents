import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);

  assert.notEqual(start, -1, `${name} must exist in the production UI`);

  const brace = html.indexOf("{", start);
  let depth = 0;

  for (let index = brace; index < html.length; index += 1) {
    if (html[index] === "{") { depth += 1; }
    if (html[index] === "}") { depth -= 1; }

    if (depth === 0) {
      return Function(`"use strict"; return (${html.slice(start, index + 1)});`)();
    }
  }

  throw new Error(`unterminated ${name}`);
}

const rankLiveThreads = extractFunction("rankLiveThreads");
const partitionStarredThreads = extractFunction("partitionStarredThreads");

test("a newly running task is promoted immediately from below the fold", () => {
  const threads = [
    { id: "a", provider: "codex", updatedAt: 600 },
    { id: "b", provider: "claude", updatedAt: 500 },
    { id: "c", provider: "grok", updatedAt: 400 },
    { id: "d", provider: "codex", updatedAt: 300 },
    { id: "e", provider: "claude", updatedAt: 700 },
    { id: "f", provider: "grok", updatedAt: 100 },
  ];

  const ranked = rankLiveThreads(threads, new Set(["claude:e"]));

  assert.deepEqual(ranked.map((thread) => thread.id), ["e", "a", "b", "c", "d", "f"]);
});

test("multiple running tasks stay together at the top in live recency order", () => {
  const threads = [
    { id: "a", provider: "codex", updatedAt: 600 },
    { id: "c", provider: "grok", updatedAt: 800 },
    { id: "e", provider: "claude", updatedAt: 700 },
    { id: "f", provider: "grok", updatedAt: 100 },
  ];

  const ranked = rankLiveThreads(threads, new Set(["claude:e", "grok:c"]));

  assert.deepEqual(ranked.map((thread) => thread.id), ["c", "e", "a", "f"]);
});

test("a completed task leaves the running group without displacing active work", () => {
  const threads = [
    { id: "completed", provider: "claude", updatedAt: 900 },
    { id: "still-running", provider: "codex", updatedAt: 700 },
    { id: "idle", provider: "grok", updatedAt: 800 },
  ];

  const ranked = rankLiveThreads(threads, new Set(["codex:still-running"]));

  assert.deepEqual(ranked.map((thread) => thread.id), ["still-running", "completed", "idle"]);
});

test("a running subagent promotes its parent task", () => {
  const threads = [
    { id: "new-idle", provider: "claude", updatedAt: 900 },
    {
      id: "parent",
      provider: "codex",
      updatedAt: 100,
      subagents: [{ id: "child", provider: "codex", updatedAt: 100 }],
    },
  ];

  const ranked = rankLiveThreads(threads, new Set(["codex:child"]));

  assert.deepEqual(ranked.map((thread) => thread.id), ["parent", "new-idle"]);
});

test("live ranking does not mutate the cached input order", () => {
  const threads = [
    { id: "idle", provider: "codex", updatedAt: 20 },
    { id: "running", provider: "grok", updatedAt: 10 },
  ];

  rankLiveThreads(threads, new Set(["grok:running"]));

  assert.deepEqual(threads.map((thread) => thread.id), ["idle", "running"]);
});

test("starred sessions pin above the list without disturbing the rest of the order", () => {
  const threads = [
    { id: "a", provider: "codex", updatedAt: 600 },
    { id: "b", provider: "claude", updatedAt: 500 },
    { id: "c", provider: "codex", updatedAt: 400 },
    { id: "d", provider: "grok", updatedAt: 300 },
  ];

  const { starred, rest } = partitionStarredThreads(threads, new Set(["codex:c", "grok:d"]));

  assert.deepEqual(starred.map((t) => t.id), ["c", "d"]);
  assert.deepEqual(rest.map((t) => t.id), ["a", "b"]);
});

test("a running favourite outranks an idle one inside the pinned block", () => {
  const threads = [
    { id: "idle", provider: "codex", updatedAt: 900 },
    { id: "running", provider: "claude", updatedAt: 100 },
    { id: "plain", provider: "grok", updatedAt: 800 },
  ];
  const running = new Set(["claude:running"]);

  const { starred, rest } = partitionStarredThreads(
    threads,
    new Set(["codex:idle", "claude:running"]),
    (rows) => rankLiveThreads(rows, running),
  );

  assert.deepEqual(starred.map((t) => t.id), ["running", "idle"]);
  assert.deepEqual(rest.map((t) => t.id), ["plain"]);
});

test("a provider-less row is treated as codex, matching how stars are keyed", () => {
  const { starred, rest } = partitionStarredThreads([{ id: "legacy", updatedAt: 1 }], new Set(["codex:legacy"]));

  assert.deepEqual(starred.map((t) => t.id), ["legacy"]);
  assert.deepEqual(rest, []);
});

test("no favourites leaves every row in the ordinary list", () => {
  const threads = [{ id: "a", provider: "codex", updatedAt: 2 }, { id: "b", provider: "codex", updatedAt: 1 }];
  const { starred, rest } = partitionStarredThreads(threads, new Set());

  assert.deepEqual(starred, []);
  assert.deepEqual(rest.map((t) => t.id), ["a", "b"]);
});
