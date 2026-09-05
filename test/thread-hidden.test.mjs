import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HiddenThreads, MAX_HIDDEN_THREADS } from "../thread-hidden.mjs";

function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), "codex-phone-hidden-")), "hidden.json");
  return { file, hidden: new HiddenThreads({ file }) };
}

test("hiding is per provider, durable, and idempotent", () => {
  const { file, hidden } = fixture();
  hidden.set({ provider: "claude", threadId: "one", title: "A review" });
  hidden.set({ provider: "claude", threadId: "one", title: "A review" });

  assert.equal(hidden.list().length, 1);
  assert.equal(hidden.has("claude", "one"), true);
  assert.equal(hidden.has("codex", "one"), false);

  const restarted = new HiddenThreads({ file });
  assert.equal(restarted.has("claude", "one"), true);
  assert.equal(restarted.list()[0].title, "A review");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});

test("unhiding removes the record and is idempotent", () => {
  const { hidden } = fixture();
  hidden.set({ provider: "codex", threadId: "one" });

  assert.deepEqual(hidden.set({ provider: "codex", threadId: "one", hidden: false }), []);
  assert.deepEqual(hidden.set({ provider: "codex", threadId: "one", hidden: false }), []);
  assert.equal(hidden.has("codex", "one"), false);
});

test("the list is newest first, so a mistaken hide is the easiest to undo", () => {
  const { hidden } = fixture();
  hidden.set({ provider: "codex", threadId: "old" });
  hidden.records.get("codex\nold").hiddenAt = 1;
  hidden.set({ provider: "codex", threadId: "new" });

  assert.deepEqual(hidden.list().map((r) => r.threadId), ["new", "old"]);
});

test("a hidden session keeps a title so settings can name it once it ages off every page", () => {
  const { hidden } = fixture();
  hidden.set({ provider: "grok", threadId: "x", title: "Terminal handoff security review", cwd: "/Users/dev/code" });

  const [record] = hidden.list();
  assert.equal(record.title, "Terminal handoff security review");
  assert.equal(record.cwd, "/Users/dev/code");
});

test("the store is bounded and refuses rather than dropping a decision", () => {
  const { hidden } = fixture();
  for (let index = 0; index < MAX_HIDDEN_THREADS; index += 1) {
    hidden.set({ provider: "codex", threadId: `t-${index}` });
  }
  assert.throws(() => hidden.set({ provider: "codex", threadId: "overflow" }), /up to 2000 sessions/);
  assert.equal(hidden.has("codex", "t-0"), true);
});

test("a hide without a thread is rejected, and a damaged file never blocks startup", () => {
  const { file, hidden } = fixture();
  assert.throws(() => hidden.set({ provider: "codex" }), /threadId is required/);
  writeFileSync(file, "{ not json");
  assert.deepEqual(new HiddenThreads({ file }).list(), []);
});

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("a manual hide beats every other rule, including a star", () => {
  // Ordered on purpose: a hide is a decision, the origin filter is a rule.
  assert.match(server, /if \(hiddenThreads\.has\(thread\.provider, thread\.id\)\) \{ manuallyHiddenCount \+= 1; continue; \}\s*\n\s*if \(!includeAgents && thread\.origin === "agent" && !threadStars\.has/);
  assert.match(server, /"GET \/api\/thread\/hidden"/);
  assert.match(server, /"POST \/api\/thread\/hidden"/);
  // Both list views report what they withheld.
  assert.equal((server.match(/manuallyHiddenCount,/g) ?? []).length, 2);
});

test("hide and unhide are reachable from the row context menu", () => {
  assert.match(html, /id="rowHideAction"/);
  assert.match(html, /\$\{hidden \? "Unhide session" : "Hide session"\}/);
  assert.match(html, /\$\("rowHideAction"\)\.onclick = \(\) => \{ closeControlPopover\(\); setThreadHidden\(target, !hidden\); \};/);
  // The menu reads local state rather than asking the bridge on every open.
  assert.match(html, /hiddenThreadKeys: new Set\(\)/);
  assert.match(html, /async function loadHiddenThreads\(\)/);
});

test("hidden sessions are listed and reversible in settings", () => {
  assert.match(html, /\[data-unhide\]/);
  assert.match(html, /setThreadHidden\(\{ provider: button\.dataset\.unhide, id: button\.dataset\.unhideId \}, false\)/);
  // The title is stored server-side so a hidden session can still be named
  // after it ages off every page the list endpoints return.
  assert.match(html, /title: thread\.name \|\| thread\.preview \|\| "",/);
  assert.match(html, /Nothing hidden by hand\./);
});

test("a starred session that is manually hidden is not hydrated back onto the page", () => {
  // The hidden session is filtered out of the page, so the pin hydrator would
  // otherwise see it as missing and fetch it straight back in.
  assert.match(server, /if \(hiddenThreads\.has\(star\.provider, star\.threadId\)\) \{ continue; \}/);
});
