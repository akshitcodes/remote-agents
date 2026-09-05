import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("usage and settings live at the bottom of the sidebar", () => {
  assert.match(html, /<div class="sidebar-foot">\s*<button id="usageFootBtn">[\s\S]{0,400}<button id="appSettingsBtn"/);
  assert.match(html, /\$\("usageFootBtn"\)\.onclick = openUsageSheet;/);
  assert.match(html, /\$\("appSettingsBtn"\)\.onclick = \(\) => openSettingsWindow\(\);/);
  assert.match(html, /\.sidebar-foot \{ position: sticky; bottom: 0;/);
});

test("settings is a full-screen two-pane window, not a sheet", () => {
  assert.match(html, /<div id="settingsWindow" role="dialog" aria-modal="true"[^>]*hidden>/);
  assert.match(html, /<nav class="settings-side" id="settingsSide"[\s\S]{0,200}<div class="settings-main" id="settingsMain">/);
  assert.match(html, /#settingsWindow \{ position: fixed; inset: 0; z-index: 90;/);
  // It must outrank the onboarding overlay, the highest thing that existed.
  const onboardZ = Number(html.match(/\.onboard \{[^}]*z-index: (\d+)/)[1]);
  const settingsZ = Number(html.match(/#settingsWindow \{[^}]*z-index: (\d+)/)[1]);
  assert.ok(settingsZ > onboardZ, `settings z-index ${settingsZ} must beat onboarding ${onboardZ}`);
  // The sheet version is gone, not merely unused.
  assert.doesNotMatch(html, /openAppSettingsSheet/);
});

test("the settings window traps the app behind it and restores focus on close", () => {
  assert.match(html, /\$\("app"\)\.setAttribute\("inert", ""\);\s*\n\s*renderSettings\(\);/);
  assert.match(html, /function closeSettingsWindow\(\)[\s\S]{0,400}\$\("app"\)\.removeAttribute\("inert"\);[\s\S]{0,200}state\.settingsReturnFocus\?\.focus\?\.\(\)/);
  assert.match(html, /event\.key === "Escape" && !\$\("settingsWindow"\)\.hidden/);
});

test("sections are grouped, and this-session settings only exist while a chat is open", () => {
  assert.match(html, /const SETTINGS_SECTIONS = \[/);
  assert.match(html, /\{ key: "hidden", group: "App", title: "Hidden sessions" \}/);
  assert.match(html, /\{ key: "session", group: "Current session", title: "This session", needsThread: true \}/);
  assert.match(html, /SETTINGS_SECTIONS\.filter\(\(section\) => !section\.needsThread \|\| state\.active\)/);
  // Narrow screens use the section list as the first screen.
  assert.match(html, /#settingsWindow\.on-detail \.settings-main \{ display: block; \}/);
});

test("the global auto-resume default is readable and writable without any thread", () => {
  assert.match(server, /if \(!provider && !threadId\) \{ return json\(res, 200, \{ globalEnabled: usageRetryPolicies\.value\.globalEnabled === true \}\); \}/);
  assert.match(html, /api\("\/api\/usage-retry-policy"\)/);
  assert.match(html, /\.\.\.\(thread \? \{ provider: thread\.provider \|\| state\.provider, threadId: thread\.id \} : \{\}\)/);
});
