import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_STARS, ThreadStars } from "../thread-stars.mjs";

function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), "codex-phone-stars-")), "stars.json");
  return { file, stars: new ThreadStars({ file }) };
}

test("stars are per thread, provider scoped, and durable across a bridge restart", () => {
  const { file, stars } = fixture();
  stars.set({ provider: "codex", threadId: "one" });
  stars.set({ provider: "claude", threadId: "one" });

  assert.equal(stars.has("codex", "one"), true);
  assert.equal(stars.has("claude", "one"), true);
  assert.equal(stars.has("grok", "one"), false);

  const restarted = new ThreadStars({ file });
  assert.deepEqual(restarted.list().map((s) => `${s.provider}:${s.threadId}`), ["codex:one", "claude:one"]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});

test("the cap refuses the overflow instead of evicting an existing star", () => {
  const { stars } = fixture();
  for (let index = 0; index < MAX_STARS; index += 1) {
    stars.set({ provider: "codex", threadId: `task-${index}` });
  }

  assert.throws(() => stars.set({ provider: "codex", threadId: "overflow" }), /up to 10 sessions/);
  // The refusal must not have cost the user a star they had already chosen.
  assert.equal(stars.list().length, MAX_STARS);
  assert.equal(stars.has("codex", "task-0"), true);
  assert.equal(stars.has("codex", "overflow"), false);
});

test("re-starring is idempotent and does not consume cap headroom", () => {
  const { stars } = fixture();
  for (let index = 0; index < MAX_STARS; index += 1) {
    stars.set({ provider: "codex", threadId: `task-${index}` });
  }

  assert.doesNotThrow(() => stars.set({ provider: "codex", threadId: "task-0" }));
  assert.equal(stars.list().length, MAX_STARS);
});

test("unstarring frees a slot and is idempotent", () => {
  const { stars } = fixture();
  stars.set({ provider: "codex", threadId: "one" });

  assert.deepEqual(stars.set({ provider: "codex", threadId: "one", starred: false }), []);
  assert.deepEqual(stars.set({ provider: "codex", threadId: "one", starred: false }), []);
  assert.equal(stars.has("codex", "one"), false);
});

test("a damaged or partially invalid file never stops the bridge from starting", () => {
  const { file } = fixture();
  writeFileSync(file, "{ not json");
  assert.deepEqual(new ThreadStars({ file }).list(), []);

  writeFileSync(file, JSON.stringify({ version: 1, stars: [{ provider: "codex" }, { provider: "codex", threadId: "kept" }] }));
  assert.deepEqual(new ThreadStars({ file }).list().map((s) => s.threadId), ["kept"]);
});

test("a star without a thread is rejected", () => {
  const { stars } = fixture();
  assert.throws(() => stars.set({ provider: "codex" }), /threadId is required/);
});
