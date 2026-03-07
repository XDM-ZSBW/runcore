// Core Nerve — Service Worker
// Caches app shell, handles push notifications

const CACHE_NAME = "nerve-v1";
const SHELL = ["/nerve"];

// Install: cache the app shell
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(SHELL))
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

// Fetch: cache-first for shell, network-only for API
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // API calls always go to network
  if (url.pathname.startsWith("/api/")) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.ok && e.request.method === "GET") {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});

// Push: show notification when server sends one
self.addEventListener("push", (e) => {
  if (!e.data) return;

  let payload;
  try {
    payload = e.data.json();
  } catch {
    payload = { title: "Core", body: e.data.text() };
  }

  const options = {
    body: payload.body || "",
    icon: "/public/nerve/icon-192.svg",
    badge: "/public/nerve/icon-192.svg",
    vibrate: [100, 50, 100],
    data: payload.data || {},
    actions: [{ action: "open", title: "Open" }],
    tag: "nerve-" + (payload.data?.state ? Object.values(payload.data.state).join("-") : "update"),
    renotify: true,
  };

  e.waitUntil(self.registration.showNotification(payload.title || "Core", options));
});

// Notification click: open the nerve PWA
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes("/nerve") && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow("/nerve");
    })
  );
});
