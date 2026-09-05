import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_PROJECTS_PER_PROVIDER, ProjectStore } from "../project-store.mjs";

function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), "codex-phone-projects-")), "projects.json");
  return { file, store: new ProjectStore({ file }) };
}

test("a provider scan is remembered per provider and survives a restart", () => {
  const { file, store } = fixture();
  store.remember("codex", [{ path: "/a/one", name: "one", count: 3, lastUsed: 20 }]);
  store.remember("claude", [{ path: "/a/two", name: "two", count: 1, lastUsed: 30 }]);

  assert.deepEqual(store.list("codex").map((p) => p.path), ["/a/one"]);
  assert.deepEqual(store.list("claude").map((p) => p.path), ["/a/two"]);
  assert.deepEqual(new ProjectStore({ file }).list("codex").map((p) => p.path), ["/a/one"]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});

test("the busiest projects are the ones kept when the cap is reached", () => {
  const { store } = fixture();
  const many = Array.from({ length: MAX_PROJECTS_PER_PROVIDER + 5 }, (_, index) => ({
    path: `/p/${index}`, name: String(index), count: index, lastUsed: index,
  }));

  const kept = store.remember("codex", many);

  assert.equal(kept.length, MAX_PROJECTS_PER_PROVIDER);
  assert.equal(kept[0].path, `/p/${MAX_PROJECTS_PER_PROVIDER + 4}`);
  assert.equal(kept.some((p) => p.path === "/p/0"), false);
});

test("an empty scan is ignored so an unreachable CLI cannot wipe the cache", () => {
  const { store } = fixture();
  store.remember("codex", [{ path: "/a/one", count: 2, lastUsed: 5 }]);

  assert.deepEqual(store.remember("codex", []).map((p) => p.path), ["/a/one"]);
  assert.deepEqual(store.list("codex").map((p) => p.path), ["/a/one"]);
});

test("a fresh scan drops folders the provider no longer reports", () => {
  const { store } = fixture();
  store.remember("codex", [{ path: "/a/gone", count: 9, lastUsed: 1 }, { path: "/a/kept", count: 1, lastUsed: 2 }]);
  store.remember("codex", [{ path: "/a/kept", count: 2, lastUsed: 3 }]);

  assert.deepEqual(store.list("codex").map((p) => p.path), ["/a/kept"]);
});

test("rows without a usable path are dropped and names are derived when missing", () => {
  const { store } = fixture();
  const kept = store.remember("codex", [{ path: "  " }, { count: 1 }, { path: "/a/deep/folder", count: 1 }]);

  assert.deepEqual(kept.map((p) => [p.path, p.name]), [["/a/deep/folder", "folder"]]);
});

test("a damaged cache file never stops the bridge from starting", () => {
  const { file } = fixture();
  writeFileSync(file, "{ not json");
  assert.deepEqual(new ProjectStore({ file }).list("codex"), []);
});

test("all() reports every requested provider, including ones never scanned", () => {
  const { store } = fixture();
  store.remember("codex", [{ path: "/a/one", count: 1, lastUsed: 1 }]);

  assert.deepEqual(store.all(["codex", "grok"]), { codex: store.list("codex"), grok: [] });
});
