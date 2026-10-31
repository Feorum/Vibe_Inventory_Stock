// Relative URLs and a scope-specific cache also work at /Vibe_Inventory_Stock/.
const PREFIX = `varka-google:${self.registration.scope}:`;
const CACHE = `${PREFIX}shell-v6`;
const ASSETS = [
  "./",
  "./index.html",
  "./legacy.html",
  "./workspace.js",
  "./workspace.css",
  "./workspace-model.js",
  "./locales.js",
  "./style.css",
  "./app.js",
  "./model.js",
  "./transport.js",
  "./features.js",
  "./ui.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
];
const urls = ASSETS.map((path) => new URL(path, self.registration.scope).href);
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(urls))
      .then(() => self.skipWaiting()),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(PREFIX) && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    !url.href.startsWith(self.registration.scope)
  )
    return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(async () =>
        (await caches.match(event.request, { ignoreSearch: true })) ||
        caches.match(new URL("./", self.registration.scope).href),
      ),
    );
  } else if (urls.includes(url.href)) {
    event.respondWith(
      caches
        .open(CACHE)
        .then(
          async (cache) =>
            (await cache.match(event.request)) || fetch(event.request),
        ),
    );
  }
  // Google responses, credentials, and writes are never cached here.
});
