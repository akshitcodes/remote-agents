import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("usage and settings live at the bottom of the sidebar", () => {
  assert.match(html, /<div class="sidebar-foot">\s*<button id="usageFootBtn">[\s\S]{0,400}<button id="appSettingsBtn"/);
  assert.match(html, /\$\("usageFootBtn"\)\.onclick = openUsageSheet;/);
  assert.match(html, /\$\("appSettingsBtn"\)\.onclick = \(\) => openAppSettingsSheet\(\);/);
  // Sticky inside the scrolling list, so it pins once the list can scroll.
  assert.match(html, /\.sidebar-foot \{ position: sticky; bottom: 0;/);
});

test("the settings window separates app sections from this-session settings", () => {
  assert.match(html, /async function openAppSettingsSheet\(section = "general"\)/);
  assert.match(html, /\["general", "General"\],\s*\["usage", "Usage & limits"\],/);
  // Thread-scoped settings appear only while a session is open, as links to
  // their existing owners rather than duplicated controls.
  assert.match(html, /\.\.\.\(thread \? \[\["session", "This session"\]\] : \[\]\)/);
  assert.match(html, /\$\("settingsTaskOpen"\)\?\.addEventListener\("click", \(\) => openTaskSettingsSheet\(\)\)/);
  assert.match(html, /\$\("settingsNotifyOpen"\)\?\.addEventListener\("click", \(\) => state\.active && openTaskNotificationSheet\(state\.active\)\)/);
});

test("the agent-sessions checkbox and the settings toggle share one mutation path", () => {
  assert.match(html, /function setShowAgentSessions\(checked\)/);
  assert.match(html, /\$\("agentToggleInput"\)\.onchange = \(\) => setShowAgentSessions\(\$\("agentToggleInput"\)\.checked\);/);
  assert.match(html, /agentToggle\.onclick = \(\) => \{\s*setShowAgentSessions\(!state\.showAgentSessions\);/);
});

test("the global auto-resume default is readable and writable without any thread", () => {
  // Read: bare GET returns only the global flag.
  assert.match(server, /if \(!provider && !threadId\) \{ return json\(res, 200, \{ globalEnabled: usageRetryPolicies\.value\.globalEnabled === true \}\); \}/);
  assert.match(html, /await api\("\/api\/usage-retry-policy"\)/);
  // Write: thread identifiers are attached only when a chat is open, so the
  // bridge can arm its pending stop immediately — never invented otherwise.
  assert.match(html, /\.\.\.\(thread \? \{ provider: thread\.provider \|\| state\.provider, threadId: thread\.id \} : \{\}\)/);
});
