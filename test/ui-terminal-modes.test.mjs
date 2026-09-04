import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import jsQR from "jsqr";
import QRCode from "qrcode";

const html = readFileSync(new URL("../public/terminal.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../public/terminal.js", import.meta.url), "utf8");
const appHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
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

test("desktop terminal opens as a resizable in-app panel while mobile remains full-screen", () => {
  assert.match(appHtml, /id="terminalPanel"/);
  assert.match(appHtml, /id="terminalFrame"[^>]*allow="publickey-credentials-get; publickey-credentials-create"/);
  assert.match(appHtml, /function openTerminalPanel\(thread = state\.active\)/);
  assert.match(appHtml, /if \(matchMedia\("\(min-width: 960px\)"\)\.matches\)/);
  assert.match(appHtml, /terminal-dock-right/);
  assert.match(appHtml, /function resizeTerminalPanel\(event\)/);
  assert.match(js, /document\.body\.classList\.toggle\("embedded", embedded\)/);
  assert.match(server, /res\.setHeader\("x-frame-options", "SAMEORIGIN"\)/);
  assert.match(server, /frame-ancestors 'self'/);
  assert.match(server, /!\["document", "iframe"\]\.includes\(fetchDestination\)/);
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

test("an untrusted mobile device can scan a constrained one-use enrollment QR", () => {
  assert.match(html, /id="scanQr"/);
  assert.match(html, /id="scannerVideo"[^>]*playsinline/);
  assert.match(js, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(js, /script\.src = "\/vendor\/jsqr\.js"/);
  assert.match(js, /target\.origin !== location\.origin/);
  assert.match(js, /target\.pathname === "\/api\/terminal\/handoff"/);
  assert.match(js, /target\.searchParams\.get\("handoff"\)/);
  assert.match(js, /scannerStream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(server, /assetName === "jsqr\.js"[\s\S]*?JSQR_BROWSER_FILE/);
});

test("the mobile decoder reads the bridge's generated enrollment URL", () => {
  const url = "https://agents.example.test/api/terminal/handoff?handoff=one-use-secret";
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const quiet = 4;
  const scale = 5;
  const width = (qr.modules.size + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < qr.modules.size; y += 1) {
    for (let x = 0; x < qr.modules.size; x += 1) {
      if (!qr.modules.get(x, y)) { continue; }
      for (let py = 0; py < scale; py += 1) {
        for (let px = 0; px < scale; px += 1) {
          const offset = (((y + quiet) * scale + py) * width + ((x + quiet) * scale + px)) * 4;
          pixels[offset] = 0;
          pixels[offset + 1] = 0;
          pixels[offset + 2] = 0;
        }
      }
    }
  }
  assert.equal(jsQR(pixels, width, width)?.data, url);
});
