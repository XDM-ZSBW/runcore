// Self-unregistering service worker.
// The previous SW caused latency on every fetch (TypeError on cache miss)
// and served stale API responses. Since Core runs on localhost, caching
// adds no value. This version cleans up and gets out of the way.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.claim())
  );
});
