// remote-agents service worker — app-shell caching for instant + offline launch.
//
// Strategy:
//  - App shell (the HTML at "/") and vendored assets (/vendor, /icons, manifest)
//    use stale-while-revalidate: serve the cached copy instantly, refresh in the
//    background when online. Offline, the cached shell still boots the app.
//  - /api/* is NEVER cached here — it's dynamic, authenticated, and streamed.
//    Offline thread reading is handled in the app layer (IndexedDB), not here.
//
// Bump CACHE_VERSION to force a refresh of the precached shell.

const CACHE_VERSION = "remote-agents-v1";

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

  const isNav = req.mode === "navigate";
  const isShellAsset =
    url.pathname.startsWith("/vendor/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest";

  if (isNav || isShellAsset) {
    event.respondWith(staleWhileRevalidate(req, isNav));
  }
});

// Serve cached instantly, revalidate in the background. Navigations are keyed to
// "/" so a launch with a "?t=token" query still matches the cached shell, and an
// offline launch falls back to that shell.
async function staleWhileRevalidate(req, isNav) {
  const cache = await caches.open(CACHE_VERSION);
  const key = isNav ? "/" : req;
  const cached = await cache.match(key);

  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) {
        cache.put(key, res.clone());
      }

      return res;
    })
    .catch(() => null);

  return cached || (await network) || (await cache.match("/")) || Response.error();
}
