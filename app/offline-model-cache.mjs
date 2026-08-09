import {
  getCachedOfflineAssetResponse,
} from "./offline-pack-installer.mjs";

const READY_MARKER_HEADER = "x-linelight-offline-model-ready";

function cacheKeyUrl(key, baseUrl) {
  if (typeof key === "string") return new URL(key, baseUrl).href;
  if (key instanceof URL) return key.href;
  if (key instanceof Request) return key.url;
  return "";
}

/**
 * Strictly remove one canonical model key and every retained range for that
 * key. A failed or false Cache.delete result is a failed migration commit, not
 * best-effort cleanup.
 *
 * @param {{ cache: Cache, cacheUrl: string, baseUrl: string }} options
 */
export async function deleteOfflineModelArtifactEntries({
  cache,
  cacheUrl,
  baseUrl,
}) {
  const target = new URL(cacheUrl, baseUrl);
  target.hash = "";
  const matchesTarget = (request) => {
    const candidate = new URL(request.url);
    candidate.hash = "";
    return (
      candidate.href === target.href ||
      (candidate.origin === target.origin &&
        candidate.pathname === target.pathname &&
        candidate.searchParams.has("__linelight_offline_range"))
    );
  };
  const targets = (await cache.keys()).filter(matchesTarget);
  const deleted = await Promise.all(
    targets.map((request) => cache.delete(request)),
  );
  if (deleted.some((value) => !value)) {
    throw new Error("The stored compatibility model could not be removed.");
  }
  if ((await cache.keys()).some(matchesTarget)) {
    throw new Error("The stored compatibility model is still in use.");
  }
}

/**
 * Strictly remove every pack entry containing the pinned model identifier.
 * This covers setup, model ranges, voices, and the validation receipt.
 *
 * @param {{ cache: Cache, modelIdentifier: string }} options
 */
export async function deleteOfflineModelEntriesByIdentifier({
  cache,
  modelIdentifier,
}) {
  const matchingEntries = async () =>
    (await cache.keys()).filter((request) =>
      request.url.includes(modelIdentifier),
    );
  const entries = await matchingEntries();
  const deleted = await Promise.all(
    entries.map((request) => cache.delete(request)),
  );
  if (deleted.some((value) => !value) || (await matchingEntries()).length) {
    throw new Error("The stored offline voice could not be completely removed.");
  }
}

/**
 * A complete model file is only downloaded data. This tiny receipt is the
 * durable distinction between downloaded and runtime-validated fp16 data.
 *
 * @param {{ cache: Cache, cacheUrl: string, value: string }} options
 */
export async function hasOfflineModelReadyMarker({
  cache,
  cacheUrl,
  value,
}) {
  const response = await cache.match(cacheUrl);
  if (!response) return false;
  if (response.headers.get(READY_MARKER_HEADER) !== value) return false;
  return (await response.text()) === value;
}

/**
 * Commit and verify the fp16 validation receipt before an install can report
 * ready across a reload.
 *
 * @param {{ cache: Cache, cacheUrl: string, value: string }} options
 */
export async function commitOfflineModelReadyMarker({
  cache,
  cacheUrl,
  value,
}) {
  await cache.put(
    cacheUrl,
    new Response(value, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        [READY_MARKER_HEADER]: value,
      },
    }),
  );
  if (
    !(await hasOfflineModelReadyMarker({ cache, cacheUrl, value }))
  ) {
    throw new Error("The offline voice validation could not be retained.");
  }
}

/**
 * Explicitly retain the hashed worker and ONNX runtime before a pack commits.
 * This closes the first-visit window where the service worker may not control
 * the page yet even though model installation itself succeeds.
 *
 * @param {{
 *   assets: ReadonlyArray<{
 *     cacheUrl: string,
 *     expectedContentType?: string,
 *     label: string,
 *   }>,
 *   cache: Cache,
 *   fetchAsset?: typeof globalThis.fetch,
 * }} options
 */
export async function retainOfflineRuntimeAssets({
  assets,
  cache,
  fetchAsset = globalThis.fetch.bind(globalThis),
}) {
  for (const asset of assets) {
    const hasExpectedType = (response) =>
      !asset.expectedContentType ||
      response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes(asset.expectedContentType);
    let response = await cache.match(asset.cacheUrl);
    if (!response?.ok || !hasExpectedType(response)) {
      response = await fetchAsset(asset.cacheUrl, { cache: "force-cache" });
      if (!response.ok || !hasExpectedType(response)) {
        throw new Error(`${asset.label} could not be stored for offline use.`);
      }
      await cache.put(asset.cacheUrl, response.clone());
    }
    const retained = await cache.match(asset.cacheUrl);
    if (!retained?.ok || !hasExpectedType(retained)) {
      throw new Error(`${asset.label} could not be verified for offline use.`);
    }
  }
}

/**
 * Build the small Cache API surface Transformers.js v3 needs. Large model
 * matches are reconstructed from retained ranges and model puts are ignored,
 * preventing the library from creating a duplicate full-model entry.
 *
 * @param {{
 *   aliases?: ReadonlyArray<{
 *     cacheUrl: string,
 *     fallbackCacheUrls: ReadonlyArray<string>,
 *   }>,
 *   baseUrl: string,
 *   getCache: () => Promise<Cache>,
 *   models: ReadonlyArray<{
 *     cacheUrl: string,
 *     expectedBytes: number,
 *     fallbackCacheUrls?: ReadonlyArray<string>,
 *     label?: string,
 *   }>,
 *   rangeChunkBytes: number,
 * }} options
 */
export function createOfflineModelCacheAdapter({
  aliases = [],
  baseUrl,
  getCache,
  models,
  rangeChunkBytes,
}) {
  const normalizedModels = models.map((model) => ({
    ...model,
    absoluteUrl: new URL(model.cacheUrl, baseUrl).href,
    fallbackCacheUrls: model.fallbackCacheUrls ?? [],
  }));
  const normalizedAliases = aliases.map((alias) => ({
    ...alias,
    absoluteUrl: new URL(alias.cacheUrl, baseUrl).href,
  }));
  const modelForKey = (key) => {
    const url = cacheKeyUrl(key, baseUrl);
    return normalizedModels.find((model) => model.absoluteUrl === url);
  };
  const aliasForKey = (key) => {
    const url = cacheKeyUrl(key, baseUrl);
    return normalizedAliases.find((alias) => alias.absoluteUrl === url);
  };

  return {
    async match(key) {
      const cache = await getCache();
      const model = modelForKey(key);
      if (model) {
        for (const cacheUrl of [
          model.cacheUrl,
          ...model.fallbackCacheUrls,
        ]) {
          const response = await getCachedOfflineAssetResponse({
            cache,
            cacheUrl,
            expectedBytes: model.expectedBytes,
            label: model.label ?? "The included neural voice model",
            rangeChunkBytes,
          });
          if (response) return response;
        }
        return undefined;
      }
      const alias = aliasForKey(key);
      if (alias) {
        for (const cacheUrl of [
          alias.cacheUrl,
          ...alias.fallbackCacheUrls,
        ]) {
          const response = await cache.match(cacheUrl);
          if (response) return response;
        }
        return undefined;
      }
      return cache.match(key);
    },
    async put(key, response) {
      if (modelForKey(key)) return;
      const cache = await getCache();
      await cache.put(key, response);
    },
  };
}
