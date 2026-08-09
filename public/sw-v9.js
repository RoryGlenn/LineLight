// Content-hashed assets share one cache across service-worker revisions. A
// deployment manifest and per-window leases let a later worker remove retired
// hashes only after every client that can still request them has gone away.
const CACHE_NAME = "linelight-assets-v1";
const RUNTIME_STATE_CACHE_NAME = "linelight-runtime-state-v1";
const RUNTIME_STATE_URL = new URL(
  "/__linelight_runtime_state_v1__",
  self.location.origin,
).href;
const RUNTIME_MANIFEST_PATH = "/runtime-assets.json";
const RUNTIME_STATE_VERSION = 1;
const MAX_DEPLOYMENT_ASSETS = 512;
const RETAIN_RUNTIME_ASSETS = "linelight:retain-runtime-assets";
const RELEASE_RUNTIME_ASSETS = "linelight:release-runtime-assets";
const GET_RUNTIME_ASSET_DIAGNOSTICS =
  "linelight:get-runtime-asset-diagnostics";
const RUNTIME_ASSET_DIAGNOSTICS = "linelight:runtime-asset-diagnostics";

let runtimeOperationQueue = Promise.resolve();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  // Cleanup is deliberately client-initiated during an idle lifecycle event.
  // Activation only claims pages, so narration startup never waits for a cache
  // scan or a multi-megabyte asset deletion.
  event.waitUntil(self.clients.claim());
});

function enqueueRuntimeOperation(operation) {
  const result = runtimeOperationQueue.catch(() => undefined).then(operation);
  runtimeOperationQueue = result.catch(() => undefined);
  return result;
}

function isDeploymentId(value) {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value)
  );
}

function normalizeRuntimeAsset(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, self.location.origin);
    url.hash = "";
    if (
      url.origin !== self.location.origin ||
      !url.pathname.startsWith("/assets/")
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function normalizeRuntimeAssets(values) {
  if (!Array.isArray(values) || values.length > MAX_DEPLOYMENT_ASSETS) {
    return null;
  }
  const assets = Array.from(
    new Set(values.map(normalizeRuntimeAsset).filter(Boolean)),
  ).sort();
  return assets.length ? assets : null;
}

function normalizeDeploymentManifest(value) {
  if (
    !value ||
    value.version !== RUNTIME_STATE_VERSION ||
    !isDeploymentId(value.deploymentId)
  ) {
    return null;
  }
  const assets = normalizeRuntimeAssets(value.assets);
  if (!assets) return null;
  return {
    deploymentId: value.deploymentId,
    assets,
  };
}

function emptyRuntimeState() {
  return {
    version: RUNTIME_STATE_VERSION,
    currentDeploymentId: null,
    currentLoadedAt: 0,
    deployments: {},
    clients: {},
  };
}

function normalizeRuntimeState(value) {
  if (!value || value.version !== RUNTIME_STATE_VERSION) {
    return emptyRuntimeState();
  }

  const deployments = {};
  for (const [deploymentId, rawAssets] of Object.entries(
    value.deployments ?? {},
  )) {
    const assets = isDeploymentId(deploymentId)
      ? normalizeRuntimeAssets(rawAssets)
      : null;
    if (assets) deployments[deploymentId] = assets;
  }

  const clients = {};
  for (const [clientId, lease] of Object.entries(value.clients ?? {})) {
    if (
      typeof clientId !== "string" ||
      !lease ||
      !isDeploymentId(lease.deploymentId) ||
      !deployments[lease.deploymentId]
    ) {
      continue;
    }
    clients[clientId] = {
      deploymentId: lease.deploymentId,
      loadedAt: Number.isFinite(Number(lease.loadedAt))
        ? Number(lease.loadedAt)
        : 0,
    };
  }

  const currentDeploymentId = isDeploymentId(value.currentDeploymentId)
    && deployments[value.currentDeploymentId]
    ? value.currentDeploymentId
    : null;
  return {
    version: RUNTIME_STATE_VERSION,
    currentDeploymentId,
    currentLoadedAt: currentDeploymentId &&
      Number.isFinite(Number(value.currentLoadedAt))
      ? Number(value.currentLoadedAt)
      : 0,
    deployments,
    clients,
  };
}

async function readRuntimeState() {
  try {
    const cache = await caches.open(RUNTIME_STATE_CACHE_NAME);
    const response = await cache.match(RUNTIME_STATE_URL);
    if (!response) return emptyRuntimeState();
    return normalizeRuntimeState(await response.json());
  } catch {
    // Without durable ownership metadata, retaining too much is safer than
    // deleting an asset that an open client may still need.
    return null;
  }
}

async function writeRuntimeState(state) {
  const serialized = JSON.stringify(state);
  const cache = await caches.open(RUNTIME_STATE_CACHE_NAME);
  await cache.put(
    RUNTIME_STATE_URL,
    new Response(serialized, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
    }),
  );
  const retained = await cache.match(RUNTIME_STATE_URL);
  if (!retained || (await retained.text()) !== serialized) {
    throw new Error("Runtime asset ownership could not be retained.");
  }
}

function isPreV9CacheName(name) {
  const match = /^linelight-v(\d+)$/u.exec(name);
  if (!match) return false;
  const version = Number(match[1]);
  return Number.isInteger(version) && version >= 0 && version < 9;
}

async function liveWindowClientIds(releasedClientIds = new Set()) {
  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  return new Set(
    clients
      .map((client) => client.id)
      .filter((clientId) => clientId && !releasedClientIds.has(clientId)),
  );
}

async function migrateProtectedAssets({
  legacyCacheNames,
  protectedAssets,
  stableCache,
}) {
  const legacyCaches = await Promise.all(
    legacyCacheNames.map((name) => caches.open(name)),
  );
  for (const assetUrl of protectedAssets) {
    if (await stableCache.match(assetUrl)) continue;
    for (const legacyCache of legacyCaches) {
      const response = await legacyCache.match(assetUrl);
      if (!response) continue;
      await stableCache.put(assetUrl, response.clone());
      if (!(await stableCache.match(assetUrl))) {
        throw new Error("A live runtime asset could not be migrated.");
      }
      break;
    }
  }
}

async function deleteRetiredStableAssets(stableCache, protectedAssets) {
  const requests = await stableCache.keys();
  for (const request of requests) {
    const assetUrl = normalizeRuntimeAsset(request.url);
    if (!assetUrl || protectedAssets.has(assetUrl)) continue;
    const deleted = await stableCache.delete(request);
    if (!deleted && (await stableCache.match(request))) {
      throw new Error("A retired runtime asset could not be removed.");
    }
  }
}

async function deleteLegacyCaches(legacyCacheNames) {
  for (const name of legacyCacheNames) {
    const deleted = await caches.delete(name);
    if (!deleted && (await caches.keys()).includes(name)) {
      throw new Error("A retired service-worker cache could not be removed.");
    }
  }
}

async function cleanupRuntimeAssets(
  state,
  { releasedClientIds = new Set() } = {},
) {
  const liveClientIds = await liveWindowClientIds(releasedClientIds);

  for (const clientId of Object.keys(state.clients)) {
    if (!liveClientIds.has(clientId)) delete state.clients[clientId];
  }
  await writeRuntimeState(state);

  // A pre-protocol tab can request any retained hash. Keep every generation
  // until that unknown client closes rather than guessing from observed fetches.
  const hasUnknownClient = Array.from(liveClientIds).some(
    (clientId) => !state.clients[clientId],
  );
  if (hasUnknownClient || !state.currentDeploymentId) {
    return { blockedByUnknownClient: hasUnknownClient, state };
  }

  const protectedDeploymentIds = new Set([state.currentDeploymentId]);
  for (const clientId of liveClientIds) {
    const deploymentId = state.clients[clientId]?.deploymentId;
    if (!deploymentId || !state.deployments[deploymentId]) {
      return { blockedByUnknownClient: true, state };
    }
    protectedDeploymentIds.add(deploymentId);
  }

  const protectedAssets = new Set();
  for (const deploymentId of protectedDeploymentIds) {
    for (const assetUrl of state.deployments[deploymentId] ?? []) {
      protectedAssets.add(assetUrl);
    }
  }
  if (!protectedAssets.size) {
    return { blockedByUnknownClient: true, state };
  }

  const cacheNames = await caches.keys();
  const legacyCacheNames = cacheNames.filter(isPreV9CacheName);
  const stableCache = await caches.open(CACHE_NAME);
  await migrateProtectedAssets({
    legacyCacheNames,
    protectedAssets,
    stableCache,
  });
  await deleteRetiredStableAssets(stableCache, protectedAssets);
  await deleteLegacyCaches(legacyCacheNames);

  for (const deploymentId of Object.keys(state.deployments)) {
    if (!protectedDeploymentIds.has(deploymentId)) {
      delete state.deployments[deploymentId];
    }
  }
  await writeRuntimeState(state);
  return { blockedByUnknownClient: false, state };
}

async function retainClientRuntimeAssets(event) {
  const clientId = event.source?.id;
  const manifest = normalizeDeploymentManifest(event.data?.manifest);
  const observedAssets = normalizeRuntimeAssets(event.data?.observedAssets);
  if (!clientId || !manifest || !observedAssets) return;
  const deploymentAssets = new Set(manifest.assets);
  if (observedAssets.some((assetUrl) => !deploymentAssets.has(assetUrl))) {
    // This page and the unversioned manifest came from different deployments.
    // Leave the client unknown so it conservatively blocks cleanup.
    return;
  }

  const loadedAt = Number(event.data?.loadedAt);
  const safeLoadedAt = Number.isFinite(loadedAt) && loadedAt >= 0
    ? loadedAt
    : 0;
  const state = await readRuntimeState();
  if (!state) return;
  state.deployments[manifest.deploymentId] = manifest.assets;
  state.clients[clientId] = {
    deploymentId: manifest.deploymentId,
    loadedAt: safeLoadedAt,
  };
  if (
    !state.currentDeploymentId ||
    safeLoadedAt >= state.currentLoadedAt
  ) {
    state.currentDeploymentId = manifest.deploymentId;
    state.currentLoadedAt = safeLoadedAt;
  }
  await writeRuntimeState(state);
  await cleanupRuntimeAssets(state);
}

async function releaseClientRuntimeAssets(event) {
  const clientId = event.source?.id;
  if (!clientId) return;
  const state = await readRuntimeState();
  if (!state) return;
  delete state.clients[clientId];
  await writeRuntimeState(state);
  await cleanupRuntimeAssets(state, {
    releasedClientIds: new Set([clientId]),
  });
}

async function responseBytes(response) {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength >= 0) {
      return contentLength;
    }
  }
  return (await response.clone().arrayBuffer()).byteLength;
}

async function runtimeAssetDiagnostics() {
  try {
    const cacheNames = await caches.keys();
    const runtimeCacheNames = cacheNames.filter(
      (name) => name === CACHE_NAME || isPreV9CacheName(name),
    );
    let retainedAssets = 0;
    let retainedBytes = 0;
    for (const cacheName of runtimeCacheNames) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        if (!normalizeRuntimeAsset(request.url)) continue;
        const response = await cache.match(request);
        if (!response) continue;
        retainedAssets += 1;
        retainedBytes += await responseBytes(response);
      }
    }
    return {
      type: RUNTIME_ASSET_DIAGNOSTICS,
      available: true,
      retainedAssets,
      retainedBytes,
      legacyCaches: runtimeCacheNames.filter(isPreV9CacheName).length,
    };
  } catch {
    return {
      type: RUNTIME_ASSET_DIAGNOSTICS,
      available: false,
      retainedAssets: 0,
      retainedBytes: 0,
      legacyCaches: 0,
    };
  }
}

self.addEventListener("message", (event) => {
  if (event.data?.type === RETAIN_RUNTIME_ASSETS) {
    event.waitUntil(
      enqueueRuntimeOperation(() => retainClientRuntimeAssets(event)).catch(
        () => undefined,
      ),
    );
    return;
  }
  if (event.data?.type === RELEASE_RUNTIME_ASSETS) {
    event.waitUntil(
      enqueueRuntimeOperation(() => releaseClientRuntimeAssets(event)).catch(
        () => undefined,
      ),
    );
    return;
  }
  if (event.data?.type === GET_RUNTIME_ASSET_DIAGNOSTICS) {
    event.waitUntil(
      (async () => {
        await enqueueRuntimeOperation(async () => {
          const state = await readRuntimeState();
          if (state) await cleanupRuntimeAssets(state);
        }).catch(() => undefined);
        const diagnostics = await runtimeAssetDiagnostics();
        const responsePort = event.ports?.[0];
        if (responsePort) responsePort.postMessage(diagnostics);
        else event.source?.postMessage?.(diagnostics);
      })(),
    );
  }
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
        if (
          response.ok &&
          requestUrl.pathname !== RUNTIME_MANIFEST_PATH
        ) {
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
