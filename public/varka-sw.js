const SHELL = "varka-shell-v4";
const DATA = "varka-data-v2";
const ASSETS = [
  "/",
  "/index.html",
  "/varka.js",
  "/varka.css",
  "/locales.js",
  "/styles.css",
  "/tokens.css",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
];
let generation = 0;
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(ASSETS))
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
            .filter(
              (key) =>
                (key.startsWith("varka-") || key.startsWith("daily-stock-")) &&
                ![SHELL, DATA].includes(key),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
async function dataResponse(request) {
  const epoch = generation;
  try {
    const response = await fetch(request, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401) {
      generation++;
      await caches.delete(DATA);
    } else if (response.ok && epoch === generation)
      await (await caches.open(DATA)).put(request, response.clone());
    return response;
  } catch {
    const saved = await caches.match(request, { cacheName: DATA });
    if (!saved)
      return Response.json(
        {
          error: "No saved data on this device. Reconnect to the café server.",
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
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api/varka/session" && event.request.method !== "GET") {
    event.respondWith(
      (async () => {
        const response = await fetch(event.request);
        if (response.ok) {
          generation++;
          await caches.delete(DATA);
        }
        return response;
      })(),
    );
    return;
  }
  if (event.request.method !== "GET") return;
  if (
    [
      "/api/varka/bootstrap",
      "/api/varka/information",
      "/api/varka/history",
    ].includes(url.pathname) &&
    !url.search
  ) {
    event.respondWith(dataResponse(event.request));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate")
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
  else if (ASSETS.includes(url.pathname))
    event.respondWith(
      caches
        .open(SHELL)
        .then(
          async (cache) =>
            (await cache.match(event.request)) || fetch(event.request),
        ),
    );
});
