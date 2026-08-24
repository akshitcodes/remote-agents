// Server-rendered first-pair guidance. Kept separate from provider startup so
// platform rendering can be checked without loading any agent CLI adapters.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = join(moduleDir, "public", "index.html");

export function createIndexShellReader(path, read = readFileSync) {
  let lastGood = read(path, "utf8");

  return () => {
    try {
      lastGood = read(path, "utf8");
    } catch {
      // An npm upgrade may replace package files while an owned turn is live.
      // Keep serving the last complete shell instead of crashing the bridge.
    }

    return lastGood;
  };
}

const readIndexShell = createIndexShellReader(indexHtmlPath);

export function onboardingHtml(userAgent = "") {
  const ios = /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && /Mobile/.test(userAgent));
  const android = /Android/.test(userAgent);
  const platform = ios ? "ios" : android ? "android" : "other";
  const instructions = ios
    ? `<p>On iPhone or iPad, open this page in Safari. Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</p>
       <p class="onboard-note">Open Remote Agents from its new Home Screen icon to finish setup and enable notifications.</p>`
    : android
      ? `<p>On Android Chrome, tap <strong>Install app</strong> below. Chrome will open its native install prompt.</p>
         <button type="button" class="onboard-primary" id="installPwaBtn" disabled>Waiting for Chrome…</button>
         <p class="onboard-note" id="installPwaHint">If the button stays disabled, use Chrome's menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>`
      : `<p>Install this app from your browser's menu, then open the installed app to enable notifications.</p>`;

  return `<section id="installOnboarding" class="onboard" data-platform="${platform}" aria-labelledby="installOnboardingTitle">
    <div class="onboard-card">
      <div class="onboard-kicker">One last step</div>
      <h1 id="installOnboardingTitle">Install Remote Agents</h1>
      ${instructions}
      <button type="button" class="onboard-secondary" id="dismissInstallBtn">Not now</button>
    </div>
  </section>`;
}

export function renderIndexHtml(userAgent = "", usableProviders = ["codex", "claude", "grok"]) {
  const allowed = [...new Set(usableProviders)].filter((name) => ["codex", "claude", "grok"].includes(name));
  // UI-only updates must not require restarting the bridge, because a restart
  // can terminate a turn the bridge owns. Inject onboarding/provider state into
  // a fresh shell on each navigation instead of caching it at process startup.
  return readIndexShell()
    .replace("<!-- PLATFORM_ONBOARDING -->", onboardingHtml(userAgent))
    .replace('/* USABLE_PROVIDERS */ ["codex", "claude", "grok"]', JSON.stringify(allowed));
}
