// remote-agents service worker — app-shell caching for instant + offline launch.
//
// Strategy:
//  - App shell (the HTML at "/"): network-first with a fast timeout, falling back
//    to cache. Online you always get the latest UI (no stale-update lag); on a
//    slow or dead connection the cached shell boots instantly.
//  - Vendored assets (/vendor, /icons, manifest): cache-first (they're static /
//    versioned), refreshed in the background.
//  - /api/* is NEVER cached here — it's dynamic, authenticated, and streamed.
//    Offline thread reading is handled in the app layer (IndexedDB), not here.
//
// Bump CACHE_VERSION to force a refresh of the precached shell.

const CACHE_VERSION = "remote-agents-v2";
const NAV_TIMEOUT_MS = 2500;

const SHELL = [
  "/",
  "/vendor/marked.min.js",
  "/vendor/purify.min.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Let the page trigger an immediate activation after an update.
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") {
    return;
  }

  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  // Dynamic + streamed + authenticated — always hit the network.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/")) {
    return;
  }

  const isShellAsset =
    url.pathname.startsWith("/vendor/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest";

  if (req.mode === "navigate") {
    event.respondWith(navigationNetworkFirst(req));
  } else if (isShellAsset) {
    event.respondWith(cacheFirst(req));
  }
});

// Fresh-when-online shell. Race the network against a short timeout; whichever
// wins renders, and a successful network response refreshes the cached shell
// (keyed to "/" so a "?t=token" launch and an offline launch both match).
async function navigationNetworkFirst(req) {
  const cache = await caches.open(CACHE_VERSION);

  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) {
        cache.put("/", res.clone());
      }

      return res;
    })
    .catch(() => null);

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  const winner = await Promise.race([network, timeout]);

  if (winner) {
    return winner;
  }

  // Network too slow or offline — serve the cached shell, let the fetch finish
  // updating the cache for next time.
  return (await cache.match("/")) || (await network) || Response.error();
}

// Static, versioned assets: serve cache, fill + refresh from network.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);

  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) {
        cache.put(req, res.clone());
      }

      return res;
    })
    .catch(() => null);

  return cached || (await network) || Response.error();
}
