// Public demo only. No private API, homepage, uploads, or authentication traffic.
const CACHE = "space-public-demo-__MOCK_RELEASE__";
const BOOT = __MOCK_BOOT_ASSETS__;
const BASE = "/demoappnew/";
const isAsset = url => url.origin === self.location.origin && url.pathname.startsWith(BASE + "assets/") && /-[\w-]+\.(js|css)$/.test(url.pathname);
const isDocument = url => url.origin === self.location.origin && [BASE, BASE + "index.html"].includes(url.pathname);
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Reuse the browser HTTP cache after the workspace is already interactive.
    await Promise.allSettled(BOOT.map(async url => {
      const response = await fetch(url, { cache: "force-cache", credentials: "omit" });
      if (response.ok) await cache.put(url, response);
    }));
    const document = await fetch(BASE, { cache: "no-cache", credentials: "omit" });
    if (document.ok) await cache.put(BASE, document);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("space-public-demo-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (isAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request, { credentials: "omit" });
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    })());
  } else if (event.request.mode === "navigate" && isDocument(url)) {
    // HTML always checks the deployment. Cached HTML is only an offline fallback.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(event.request, { cache: "no-cache", credentials: "omit" });
        if (response.ok) await cache.put(BASE, response.clone());
        return response;
      } catch (error) {
        return (await cache.match(BASE)) ?? Promise.reject(error);
      }
    })());
  }
});
