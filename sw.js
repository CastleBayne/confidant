// Lets the app open with no internet connection. When online, app files are
// fetched fresh (bypassing the browser's HTTP cache) so updates arrive on
// the next launch. Model files are cached separately by WebLLM.
const VERSION = 10;
const CACHE = `confidant-app-v${VERSION}`;
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
  "speech.js",
  "llm-worker.js",
  "vendor/web-llm/index.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("confidant-app-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// The vendored engine never changes between releases, so serve it from cache.
// Everything else: network first, cache if offline or slow.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      if (cached && url.pathname.includes("/vendor/")) return cached;
      const network = fetch(e.request, { cache: "no-cache" }).then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      });
      if (!cached) return network;
      const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
      return Promise.race([network.catch(() => cached), timeout]);
    }));
});
