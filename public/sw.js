/* Scorers Window — network-first (overlay must not stick on old JS) */
const CACHE = "scorers-window-v36";
const ASSETS = ["/", "/index.html", "/css/app.css", "/js/app.js", "/js/hub.js", "/js/overlay.js", "/js/demo.js", "/manifest.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache API or use stale JS for overlay score updates
  if (url.pathname.startsWith("/api/") || url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith("sw.js")) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (e.request.method === "GET" && res.ok && !url.pathname.startsWith("/api/")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (e.request.method === "GET" && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
