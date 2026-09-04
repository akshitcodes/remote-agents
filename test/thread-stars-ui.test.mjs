import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("favourites pin in their own container so Load more cannot skip sessions", () => {
  assert.match(html, /<div id="pinnedRows"><\/div>\s*<div id="rows"><\/div>/);
  // renderRows' append offset is a count of DOM rows inside #rows. If the pinned
  // block ever moves in there, that offset silently drops sessions per page.
  assert.match(html, /const start = append \? rows\.querySelectorAll\("\.row"\)\.length : 0;/);
  assert.match(html, /function renderPinnedRows\(\)[\s\S]*?\$\("pinnedRows"\)/);
  assert.match(html, /function buildThreadRow\(t, threadProject\)/);
});

test("the featured divider position is corrected for rows lifted into the pinned block", () => {
  assert.match(html, /const starredInFeatured = rows\.slice\(0, state\.featuredCount\)/);
  assert.match(html, /state\.featuredCount = Math\.max\(0, state\.featuredCount - starredInFeatured\);/);
});

test("a search keeps favourites in their own results instead of hiding them", () => {
  assert.match(html, /if \(search\) \{\s*state\.starredThreads = \[\];\s*return;\s*\}/);
  assert.match(html, /const pinned = \$\("search"\)\.value\.trim\(\) \? \[\] : state\.starredThreads;/);
});

test("the agent filter stays literal and reports the favourites it is hiding", () => {
  assert.match(html, /function hiddenStarCount\(\)/);
  assert.match(html, /starred session\$\{hidden === 1 \? "" : "s"\} hidden by the current agent filter/);
  // No client-side exemption that would smuggle an out-of-scope row onto the list.
  assert.match(html, /if \(listView === "recent" && providerScope !== "all"\) \{/);
});

test("right-click and long-press both open the session actions sheet, favourite first", () => {
  assert.match(html, /\$\("listView"\)\.addEventListener\("contextmenu"/);
  assert.match(html, /rowHoldTimer = setTimeout\(/);
  assert.match(html, /function openThreadActionsSheet\(thread\)/);
  // The favourite toggle must be the first option in the sheet.
  assert.match(html, /<h2>Session<\/h2>[\s\S]{0,200}id="starAction"/);
  assert.match(html, /Add to favourites/);
  assert.match(html, /Remove from favourites/);
});

test("a long press cannot also open the thread, and a drag stays a scroll", () => {
  assert.match(html, /suppressRowClick = false;\s*cancelRowHold\(\);/);
  assert.match(html, /addEventListener\("click", \(event\) => \{[\s\S]*?suppressRowClick[\s\S]*?\}, true\)/);
  assert.match(html, /Math\.abs\(event\.clientX - rowHoldOrigin\.x\) > 10/);
});

test("the bridge owns the star set and hydrates pins that aged off the page", () => {
  assert.match(server, /"GET \/api\/thread\/stars"/);
  assert.match(server, /"POST \/api\/thread\/stars"/);
  assert.match(server, /async function listPinnedThreadsWithState\(p, threadIds\)/);
  // Pins belong to page one only, and must never be paid for during a search.
  assert.match(server, /const pinned = continuation \|\| search \? \[\] : await hydrateMissingPins\(/);
  // Run state stays a single shared implementation across every listing path.
  assert.match(server, /function applyThreadRunState\(p, rows, running\)/);
  assert.doesNotMatch(server, /const childOwned = activeTurns\.has/);
});
