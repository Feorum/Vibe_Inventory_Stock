const SHELL = "daily-stock-shell-v1";
const DATA = "daily-stock-data-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/tokens.css",
  "/manifest.webmanifest",
  "/icons/ui.svg",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("daily-stock-") && ![SHELL, DATA].includes(key),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function inventoryResponse(request) {
  const cache = await caches.open(DATA);
  try {
    const response = await fetch(request, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) await cache.put(request, response.clone());
    // An expired session must never fall back to previously authenticated data.
    if (response.status === 401) await caches.delete(DATA);
    return response;
  } catch {
    const saved = await cache.match(request);
    if (!saved)
      return Response.json(
        {
          error:
            "No saved inventory on this device. Reconnect to the shop server.",
        },
        { status: 503 },
      );
    const headers = new Headers(saved.headers);
    headers.set("X-Inventory-Offline", "1");
    return new Response(saved.body, { status: saved.status, headers });
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET")
    return;
  if (["/api/items", "/api/movements"].includes(url.pathname)) {
    event.respondWith(inventoryResponse(event.request));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches
        .open(SHELL)
        .then(
          async (cache) =>
            (await cache.match(event.request)) || fetch(event.request),
        ),
    );
  }
});
