import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/terminal.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../public/terminal.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

test("terminal offers locally buffered command mode and real interactive mode", () => {
  assert.match(html, /data-terminal-mode="command"/);
  assert.match(html, /data-terminal-mode="interactive"/);
  assert.match(js, /matchMedia\("\(max-width: 600px\)"\)\.matches \? "command" : "interactive"/);
  assert.match(js, /localStorage\.setItem\(TERMINAL_MODE_KEY, mode\)/);
  assert.match(js, /async function runFallback[\s\S]*?\/api\/terminal\/run/);
  assert.match(js, /terminal\.onData\(\(data\) => \{[\s\S]*?type: "input"/);
  assert.match(js, /closeInteractiveSocket\(\);[\s\S]*?terminalMode = "command"/);
});

test("terminal enrollment routes new devices through the canonical origin", () => {
  assert.match(html, /id="addDevice"/);
  assert.match(html, /id="deviceDialog"/);
  assert.match(js, /\/api\/terminal\/device-handoff/);
  assert.match(js, /status\.access\.origin && location\.origin !== status\.access\.origin/);
  assert.match(js, /routeToCanonicalOrigin\(status\.access\.origin\)/);
  assert.match(js, /if \(!status\.access\.enabled\)/);
  assert.doesNotMatch(js, /!status\.access\.enabled \|\| \(!status\.access\.enrolled/);
  assert.match(server, /"POST \/api\/terminal\/device-handoff"/);
  assert.match(server, /terminalSecurity\.requireUnlock/);
});
