import assert from "node:assert/strict";
import test from "node:test";

import { rankRecentThreads, sortRecentThreads } from "../recent-threads.mjs";

test("recent work puts running tasks first, then sorts idle tasks by recency", () => {
  const rows = rankRecentThreads([
    [{ id: "new-idle", provider: "codex", updatedAt: 500, running: false }],
    [{ id: "old-running", provider: "claude", updatedAt: 10, running: true }],
    [{ id: "mid-idle", provider: "grok", updatedAt: 200, running: false }],
  ]);

  assert.deepEqual(rows.map((row) => row.id), ["old-running", "new-idle", "mid-idle"]);
});

test("recent work is capped at ten rows across providers", () => {
  const groups = [
    Array.from({ length: 6 }, (_, index) => ({ id: `c-${index}`, provider: "codex", updatedAt: 100 - index })),
    Array.from({ length: 6 }, (_, index) => ({ id: `g-${index}`, provider: "grok", updatedAt: 200 - index })),
  ];
  const rows = rankRecentThreads(groups);

  assert.equal(rows.length, 10);
  assert.deepEqual(rows.slice(0, 2).map((row) => row.id), ["g-0", "g-1"]);
});

test("recent work ignores failed-provider placeholders and orders ties deterministically", () => {
  const rows = rankRecentThreads([
    null,
    [{ id: "b", provider: "claude", updatedAt: 5 }, { id: "a", provider: "claude", updatedAt: 5 }],
  ]);

  assert.deepEqual(rows.map((row) => row.id), ["a", "b"]);
});

test("the more-sessions section can use ordinary recency without active promotion", () => {
  const rows = sortRecentThreads([
    { id: "old-running", provider: "codex", updatedAt: 1, running: true },
    { id: "new-idle", provider: "claude", updatedAt: 20, running: false },
  ], { runningFirst: false });

  assert.deepEqual(rows.map((row) => row.id), ["new-idle", "old-running"]);
});
