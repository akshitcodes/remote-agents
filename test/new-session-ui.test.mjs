import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("a new session always asks for the agent instead of assuming the open one", () => {
  // The open thread's agent is a default, not an assumption: the picker is on
  // screen and every installed provider is offered.
  assert.match(html, /let provider = \(state\.active \? activeProvider\(\) : state\.provider\) \|\| AVAILABLE_PROVIDER_NAMES\[0\];/);
  assert.match(html, /AVAILABLE_PROVIDER_NAMES\.map\(\(name\) => `[\s\S]{0,400}data-new-provider=/);
  assert.match(html, /function selectProvider\(name\)/);
  // The old flow branched into a silent provider and a separate second sheet.
  assert.doesNotMatch(html, /openNewSheet/);
});

test("agent and project live on one screen, with the project list under the agent picker", () => {
  assert.match(html, /<div class="new-session-layout">[\s\S]{0,700}id="newProviderSeg"[\s\S]{0,300}id="newProjectList"[\s\S]{0,400}id="createBtn"/);
});

test("the project list paints from the durable cache before any provider scan", () => {
  // The cached read must come first, and the live scan must only refresh it.
  assert.match(html, /const cached = await api\("\/api\/projects\/known"\);/);
  assert.match(html, /async function refreshProjects\(name\)/);
  assert.match(html, /await api\("\/api\/projects\?provider=" \+ encodeURIComponent\(name\)\)/);
  assert.match(html, /if \(name === provider\) \{ renderProjects\(\); \}/);
  // Most-used first, which is what puts the folder you want at the top.
  assert.match(html, /function sortNewSessionProjects\(projects\)/);
  assert.match(html, /Number\(b\.count \?\? 0\) - Number\(a\.count \?\? 0\)/);
});

test("choosing an agent never swaps the open thread's model catalog", () => {
  // initModels replaces state.models/state.model globally; using it here would
  // clobber the composer of the thread still open behind the sheet.
  assert.match(html, /async function newSessionModel\(provider\)/);
  assert.match(html, /if \(provider === state\.modelsProvider && state\.model\) \{ return state\.model; \}/);
  assert.doesNotMatch(html, /openNewSession[\s\S]{0,4000}await initModels\(/);
});

test("the bridge remembers project folders durably and serves them without a provider call", () => {
  assert.match(server, /"GET \/api\/projects\/known"/);
  assert.match(server, /projectStore\.remember\(p\.name, listed\?\.projects\)/);
  assert.match(server, /new ProjectStore\(\{ file: join\(APP_HOME, "projects\.json"\) \}\)/);
  // The cached route must not reach a provider, or it is not instant.
  const start = server.indexOf('"GET /api/projects/known"');
  const known = server.slice(start, server.indexOf("\n  },", start));
  assert.doesNotMatch(known, /await |providerFromQuery/);
  assert.match(known, /projectStore\.all\(names\)/);
  // Boot warms the cache so the first new-session screen is already useful.
  assert.match(server, /\.then\(\(\) => p\.projects\(\)\)\s*\n\s*\.then\(\(listed\) => projectStore\.remember\(p\.name, listed\?\.projects\)\)/);
});
