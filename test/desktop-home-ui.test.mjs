import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("the task settings control reads as task-scoped, not app-scoped", () => {
  // Three dots: app settings now own the gear, so this had to stop competing
  // with them for the same meaning.
  assert.match(html, /<button id="settingsBtn"[^>]*aria-label="Task actions"[^>]*title="Actions for this task"/);
  assert.match(html, /id="settingsBtn"[\s\S]{0,400}<circle cx="5" cy="12"[\s\S]{0,200}<circle cx="19" cy="12"/);
});

test("desktop keeps the session list in the sidebar with nothing selected", () => {
  // The whole workspace grid is keyed off body.thread-open, so that class now
  // means "two-pane workspace" rather than "a thread is open".
  assert.match(html, /document\.body\.classList\.toggle\("thread-open", home \|\| !!state\.active\);/);
  assert.match(html, /const home = isWorkspace\(\) && !state\.active;/);
  assert.match(html, /const WORKSPACE_QUERY = window\.matchMedia\("\(min-width: 960px\)"\);/);
  // Crossing the breakpoint has to re-decide the layout.
  assert.match(html, /WORKSPACE_QUERY\.addEventListener\("change", syncWorkspaceChrome\);/);
  // Leaving a thread on desktop returns to the home view, not a bare list.
  assert.match(html, /document\.body\.classList\.remove\("thread-open"\);\s*\n\s*syncWorkspaceChrome\(\);/);
});

test("the desktop landing view is a ready-to-type new chat with agent and folder pickers", () => {
  assert.match(html, /<div id="homeView"><div class="home-card" id="homeCard"><\/div><\/div>/);
  assert.match(html, /body\.home-view #homeView \{ display: grid; \}/);
  // The real transcript and composer must not paint underneath it.
  assert.match(html, /body\.home-view #transcript, body\.home-view #composerWrap, body\.home-view #approval \{ display: none !important; \}/);
  assert.match(html, /id="homeProviderCtl"/);
  assert.match(html, /id="homeCwdCtl"/);
  assert.match(html, /id="homeSend"/);
});

test("the first message goes through the ordinary send path, not a shortcut", () => {
  // Creating the thread then reusing send() keeps every readiness guard,
  // queue rule and fail-closed dispatch check that the composer already has.
  assert.match(html, /async function startHomeSession\(\)[\s\S]{0,1600}await openThread\(\{[\s\S]{0,400}\}\);[\s\S]{0,200}\$\("input"\)\.value = text;\s*\n\s*await send\(\);/);
  assert.match(html, /const model = await newSessionModel\(provider\);/);
});

test("the default folder is bridge-owned, validated, and falls back sensibly", () => {
  assert.match(server, /"GET \/api\/settings\/default-cwd"/);
  assert.match(server, /"POST \/api\/settings\/default-cwd"/);
  // A relative or missing path is refused at write time rather than failing
  // later when a session is actually being created.
  assert.match(server, /if \(requested && !isAbsolute\(requested\)\) \{/);
  assert.match(server, /if \(requested && !existsSync\(requested\)\) \{/);
  // Explicit pick, then the configured default, then the busiest folder.
  assert.match(html, /return homeDraft\.cwd \|\| homeDraft\.defaultCwd \|\| homeDraft\.projects\?\.\[homeProvider\(\)\]\?\.\[0\]\?\.path \|\| "";/);
  assert.match(html, /data-setting="default-cwd"/);
});
