// Core service worker — cache-first for app shell, network-first for API
const CACHE_NAME = "core-v1";
const APP_SHELL = [
  "/",
  "/public/manifest.json",
];

// Install: cache app shell
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for shell/static
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Skip non-GET, SSE, and cross-origin
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (e.request.headers.get("accept") === "text/event-stream") return;

  // API calls: network-first, cache fallback for reads
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          // Cache successful GET responses for offline fallback
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // App shell & static: cache-first, network fallback
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
