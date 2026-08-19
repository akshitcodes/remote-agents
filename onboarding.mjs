// Server-rendered first-pair guidance. Kept separate from provider startup so
// platform rendering can be checked without loading any agent CLI adapters.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(moduleDir, "public", "index.html"), "utf8");

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

export function renderIndexHtml(userAgent = "") {
  return indexHtml.replace("<!-- PLATFORM_ONBOARDING -->", onboardingHtml(userAgent));
}
