// Caches the app itself so it opens with no internet connection.
// Model files are cached separately by WebLLM and aren't touched here.
const CACHE = "confidant-app-v5";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "store.js",
  "models.js",
  "voice.js",
  "writing.js",
  "docx.js",
  "llm-worker.js",
  "vendor/web-llm/index.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("confidant-app-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// Serve from cache right away, then refresh the cached copy in the background
// so updates show up on the next launch.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const network = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      if (cached) {
        e.waitUntil(network);
        return cached;
      }
      return network;
    }));
});
