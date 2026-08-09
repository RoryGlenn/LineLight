// Hashed assets are immutable, so keep one stable cache across service-worker
// revisions. The finite pre-v9 versioned caches remain readable for tabs that
// still refer to their previous deployment's worker or WASM hash; future
// deployments reuse this stable cache instead of adding another generation.
const CACHE_NAME = "linelight-assets-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function normalizeAssetResponse(request, response) {
  const pathname = new URL(request.url).pathname;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (pathname.endsWith(".js")) {
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  }
  if (pathname.endsWith(".wasm")) {
    headers.set("Content-Type", "application/wasm");
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (
    event.request.mode === "navigate" ||
    event.request.destination === "document" ||
    requestUrl.origin !== self.location.origin ||
    requestUrl.pathname.startsWith("/api/") ||
    requestUrl.pathname.startsWith("/offline-model/")
  ) {
    return;
  }

  let finishCacheLifetime;
  const cacheLifetime = new Promise((resolve) => {
    finishCacheLifetime = resolve;
  });
  event.waitUntil(cacheLifetime);
  const finishCaching = () => {
    finishCacheLifetime();
  };

  event.respondWith(
    (async () => {
      const immutableAsset = requestUrl.pathname.startsWith("/assets/");
      if (immutableAsset) {
        const cached = await caches
          .match(event.request)
          .catch(() => undefined);
        if (cached) {
          finishCaching();
          return normalizeAssetResponse(event.request, cached);
        }
      }
      try {
        const fetched = await fetch(event.request);
        const response = normalizeAssetResponse(event.request, fetched);
        if (response.ok) {
          try {
            const cacheCopy = response.clone();
            void (async () => {
              const cache = await caches.open(CACHE_NAME);
              await cache.put(event.request, cacheCopy);
            })()
              .catch(() => {
                // Caching is optional; the network response remains valid.
              })
              .finally(() => {
                finishCaching();
              });
          } catch {
            // A response that cannot be cloned is still safe to return.
            finishCaching();
          }
        } else {
          finishCaching();
        }
        return response;
      } catch {
        finishCaching();
        return (
          (await caches.match(event.request).catch(() => undefined)) ??
          Response.error()
        );
      }
    })(),
  );
});
