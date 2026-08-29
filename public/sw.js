// remote-agents service worker — app-shell caching for instant + offline launch.
//
// Strategy:
//  - App shell (the HTML at "/"): cache-first with background revalidation. An
//    installed app paints immediately, while the next launch gets the refreshed
//    UI. First-ever visits still wait for the network because no shell exists.
//  - Vendored assets (/vendor, /icons, manifest): cache-first (they're static /
//    versioned), refreshed in the background.
//  - /api/* is NEVER cached here — it's dynamic, authenticated, and streamed.
//    Offline thread reading is handled in the app layer (IndexedDB), not here.
//
// Bump CACHE_VERSION to force a refresh of the precached shell.

const CACHE_VERSION = "remote-agents-v18";

// A reverse proxy in front of us (Cloudflare, a tunnel, nginx) answers with a
// real HTTP response when the machine behind it is down — 502, or Cloudflare's
// own 52x/53x error page. That is a *resolved* fetch, so `.catch()` never sees
// it and we would render the proxy's "tunnel not responding" page instead of
// falling back. Treat any 5xx as the host being unreachable; a 4xx is a genuine
// answer (a rejected token, say) and must pass through untouched.
function hostUnreachable(res) {
  return !res || res.type === "error" || res.status >= 500;
}

const SHELL = [
  "/",
  "/vendor/marked.min.js",
  "/vendor/purify.min.js",
  "/vendor/highlight.min.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/provider-codex.svg",
  "/icons/provider-claude.svg",
  "/icons/provider-grok.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);

    // Per-item rather than addAll(): one asset failing must not leave us with no
    // cached shell at all, which is precisely what the offline fallback needs.
    await Promise.all(SHELL.map((path) => cache.add(path).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);

    // Never drop the previous version's shell unless this one actually has one —
    // otherwise a half-failed install leaves the app with nothing to boot from.
    if (await cache.match("/")) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    }

    await self.clients.claim();
  })());
});

// "Your agent finished" push. iOS only delivers these to a home-screen install,
// and requires that every push shows a notification (userVisibleOnly), so there
// is no silent path. Tapping one opens (or focuses) that thread.
self.addEventListener("push", (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Remote Agents", body: event.data?.text?.() || "" };
  }

  const threadId = payload.threadId || "";
  const provider = payload.provider || "codex";
  const url = threadId ? `/?thread=${encodeURIComponent(threadId)}&provider=${encodeURIComponent(provider)}` : "/";

  event.waitUntil(
    self.registration.showNotification(payload.title || "Remote Agents", {
      body: payload.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // One live notification per thread — a finished turn replaces its predecessor.
      tag: `thread:${provider}:${threadId}`,
      renotify: true,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  const url = event.notification.data?.url || "/";
  event.notification.close();

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    for (const client of windows) {
      if ("navigate" in client) {
        await client.navigate(url).catch(() => {});
        return client.focus();
      }
    }

    return self.clients.openWindow(url);
  })());
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
    event.respondWith(navigationCacheFirst(req, event));
  } else if (isShellAsset) {
    event.respondWith(cacheFirst(req));
  }
});

// Instant installed-app shell. Refresh in the background and key to "/" so a
// "?t=token" launch, ordinary launch, and offline launch all share one shell.
async function navigationCacheFirst(req, event) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match("/");

  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) {
        cache.put("/", res.clone());
      }

      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network.then(() => {}));
    return cached;
  }

  // Nothing cached means this really is the first visit. Preserve genuine 4xx
  // responses (for example a rejected pairing token), but never prefer a
  // tunnel/proxy 5xx over an app shell because there is no shell to use yet.
  const response = await network;
  return hostUnreachable(response) ? Response.error() : response;
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
