const DOWNLOAD_ATTEMPTS = 2;
// Keep only one unfinished range so a browser/process interruption loses at
// most the current chunk. Callers can opt into bounded parallelism explicitly.
const DEFAULT_RANGE_CONCURRENCY = 1;
const MAX_RANGE_CONCURRENCY = 4;
const RANGE_CACHE_VERSION = "1";
const RANGE_CACHE_PARAMETER = "__linelight_offline_range";
const RANGE_VERSION_HEADER = "x-linelight-range-version";
const RANGE_START_HEADER = "x-linelight-range-start";
const RANGE_END_HEADER = "x-linelight-range-end";
const RANGE_TOTAL_HEADER = "x-linelight-range-total";

class OfflineAssetStorageError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "OfflineAssetStorageError";
  }
}

class OfflineRangeAssemblyError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "OfflineRangeAssemblyError";
  }
}

function abortReason(signal) {
  if (!signal?.aborted) return undefined;
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal) {
  const reason = abortReason(signal);
  if (reason !== undefined) throw reason;
}

function isAbortError(cause, signal) {
  return Boolean(
    signal?.aborted ||
      (cause &&
        typeof cause === "object" &&
        "name" in cause &&
        cause.name === "AbortError"),
  );
}

function storageError(label, cause) {
  const quotaExceeded =
    cause &&
    typeof cause === "object" &&
    "name" in cause &&
    cause.name === "QuotaExceededError";
  return new OfflineAssetStorageError(
    quotaExceeded
      ? `The browser does not have enough site storage for ${label.toLowerCase()}. Free more site storage and try again.`
      : `The browser could not store ${label.toLowerCase()}. Check site storage permissions and try again.`,
    cause,
  );
}

async function deleteCachedEntry(cache, key) {
  if (typeof cache.delete !== "function") return;
  await cache.delete(key);
}

async function discardCachedEntry(cache, key) {
  try {
    await deleteCachedEntry(cache, key);
  } catch {
    // A later Cache.put() can still replace an invalid staging entry.
  }
}

async function putCachedResponse({
  cache,
  cacheUrl,
  label,
  response,
  signal,
}) {
  try {
    await cache.put(cacheUrl, response);
  } catch (cause) {
    if (isAbortError(cause, signal)) throw abortReason(signal) ?? cause;
    if (cause instanceof OfflineRangeAssemblyError) throw cause;
    throw storageError(label, cause);
  }

  throwIfAborted(signal);
  const retained = await cache.match(cacheUrl);
  throwIfAborted(signal);
  if (!retained) {
    throw new OfflineAssetStorageError(
      `The browser did not retain ${label.toLowerCase()}. Check site storage permissions and try again.`,
    );
  }
  return retained;
}

function rangeCacheUrl(cacheUrl, { end, start, total }) {
  try {
    const url = new URL(cacheUrl);
    url.hash = "";
    url.searchParams.set(
      RANGE_CACHE_PARAMETER,
      `${RANGE_CACHE_VERSION}:${start}-${end}:${total}`,
    );
    return url.href;
  } catch {
    const separator = cacheUrl.includes("?") ? "&" : "?";
    return (
      `${cacheUrl}${separator}${RANGE_CACHE_PARAMETER}=` +
      `${RANGE_CACHE_VERSION}%3A${start}-${end}%3A${total}`
    );
  }
}

function normalizedCacheUrl(cacheUrl) {
  const fallbackOrigin =
    typeof globalThis.location?.origin === "string"
      ? globalThis.location.origin
      : "https://linelight.invalid";
  try {
    const url = new URL(cacheUrl, fallbackOrigin);
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function cacheEntryUrl(entry) {
  if (typeof entry === "string") return entry;
  return entry?.url;
}

function isRangeEntryForAsset(entry, cacheUrl) {
  const entryUrl = normalizedCacheUrl(cacheEntryUrl(entry));
  const assetUrl = normalizedCacheUrl(cacheUrl);
  if (
    !entryUrl ||
    !assetUrl ||
    !entryUrl.searchParams.has(RANGE_CACHE_PARAMETER)
  ) {
    return false;
  }
  entryUrl.searchParams.delete(RANGE_CACHE_PARAMETER);
  assetUrl.searchParams.delete(RANGE_CACHE_PARAMETER);
  return entryUrl.href === assetUrl.href;
}

function buildRangeSpecs(expectedBytes, rangeChunkBytes, cacheUrl) {
  const ranges = [];
  for (let start = 0; start < expectedBytes; start += rangeChunkBytes) {
    const end = Math.min(
      expectedBytes - 1,
      start + rangeChunkBytes - 1,
    );
    ranges.push({
      bytes: end - start + 1,
      cacheUrl: rangeCacheUrl(cacheUrl, {
        end,
        start,
        total: expectedBytes,
      }),
      end,
      start,
      total: expectedBytes,
    });
  }
  return ranges;
}

function hasRangeConfiguration(expectedBytes, rangeChunkBytes) {
  return Boolean(
    Number.isSafeInteger(expectedBytes) &&
      expectedBytes > 0 &&
      Number.isSafeInteger(rangeChunkBytes) &&
      rangeChunkBytes > 0,
  );
}

function hasExpectedContentLength(response, expectedBytes) {
  if (!response) return false;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    return true;
  }
  return response.headers.get("content-length") === String(expectedBytes);
}

function isRetainedRange(response, range) {
  return Boolean(
    response?.status === 200 &&
      response.headers.get(RANGE_VERSION_HEADER) === RANGE_CACHE_VERSION &&
      response.headers.get(RANGE_START_HEADER) === String(range.start) &&
      response.headers.get(RANGE_END_HEADER) === String(range.end) &&
      response.headers.get(RANGE_TOTAL_HEADER) === String(range.total) &&
      response.headers.get("content-length") === String(range.bytes),
  );
}

async function findRetainedRanges(cache, ranges) {
  return Promise.all(
    ranges.map(async (range) => {
      const response = await cache.match(range.cacheUrl);
      if (isRetainedRange(response, range)) return true;
      if (response) await discardCachedEntry(cache, range.cacheUrl);
      return false;
    }),
  );
}

async function removeRetainedRanges(cache, ranges) {
  await Promise.allSettled(
    ranges.map((range) => deleteCachedEntry(cache, range.cacheUrl)),
  );
}

async function removeObsoleteRetainedRanges(
  cache,
  cacheUrl,
  retainedRanges = [],
) {
  if (typeof cache.keys !== "function") return;
  const retainedUrls = new Set(
    retainedRanges.map((range) => normalizedCacheUrl(range.cacheUrl)?.href),
  );
  let entries;
  try {
    entries = await cache.keys();
  } catch {
    return;
  }
  await Promise.allSettled(
    entries
      .filter((entry) => {
        const entryUrl = cacheEntryUrl(entry);
        return (
          isRangeEntryForAsset(entryUrl, cacheUrl) &&
          !retainedUrls.has(normalizedCacheUrl(entryUrl)?.href)
        );
      })
      .map((entry) => deleteCachedEntry(cache, entry)),
  );
}

async function removeAllRetainedRanges(cache, cacheUrl, ranges) {
  await removeRetainedRanges(cache, ranges);
  await removeObsoleteRetainedRanges(cache, cacheUrl);
}

function normalizedRangeConcurrency(rangeConcurrency, rangeCount) {
  const requested = Number.isFinite(rangeConcurrency)
    ? Math.floor(rangeConcurrency)
    : DEFAULT_RANGE_CONCURRENCY;
  return Math.min(
    rangeCount,
    MAX_RANGE_CONCURRENCY,
    Math.max(1, requested),
  );
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // A failed response is already being discarded.
  }
}

async function downloadRange({
  cache,
  fetchAsset,
  label,
  range,
  signal,
  sourceUrl,
}) {
  let downloadCause;
  let downloadStatus;

  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    let partResponse;
    try {
      partResponse = await fetchAsset(sourceUrl, {
        cache: "no-store",
        headers: { Range: `bytes=${range.start}-${range.end}` },
        signal,
      });
      if (partResponse?.status !== 206) {
        downloadStatus = partResponse?.status ?? "unknown";
        downloadCause = undefined;
        await cancelResponseBody(partResponse);
        continue;
      }

      const contentRange =
        `bytes ${range.start}-${range.end}/${range.total}`;
      if (partResponse.headers.get("content-range") !== contentRange) {
        throw new Error(
          `Expected ${contentRange}, received ${partResponse.headers.get("content-range") ?? "no content range"}.`,
        );
      }

      // Cache Storage cannot retain a 206 response. Materialize only this
      // bounded range, verify it, and store it as a private 200 response.
      // Completed ranges are released from JS memory before another retry or
      // final model assembly begins.
      const candidate = await partResponse.blob();
      throwIfAborted(signal);
      if (candidate.size !== range.bytes) {
        throw new Error(
          `Expected ${range.bytes} bytes, received ${candidate.size}.`,
        );
      }

      const headers = new Headers(partResponse.headers);
      headers.delete("content-range");
      headers.set("content-length", String(range.bytes));
      headers.set(RANGE_VERSION_HEADER, RANGE_CACHE_VERSION);
      headers.set(RANGE_START_HEADER, String(range.start));
      headers.set(RANGE_END_HEADER, String(range.end));
      headers.set(RANGE_TOTAL_HEADER, String(range.total));
      await putCachedResponse({
        cache,
        cacheUrl: range.cacheUrl,
        label,
        response: new Response(candidate, {
          headers,
          status: 200,
          statusText: "OK",
        }),
        signal,
      });
      return;
    } catch (cause) {
      if (isAbortError(cause, signal)) throw abortReason(signal) ?? cause;
      if (cause instanceof OfflineAssetStorageError) throw cause;
      downloadCause = cause;
      await discardCachedEntry(cache, range.cacheUrl);
    }
  }

  if (downloadStatus !== undefined && downloadCause === undefined) {
    throw new Error(
      `${label} could not be downloaded (HTTP ${downloadStatus}).`,
    );
  }
  throw new Error(
    `${label} could not be downloaded completely. Check the connection and try again.`,
    { cause: downloadCause },
  );
}

async function downloadMissingRanges({
  cache,
  fetchAsset,
  label,
  missingRanges,
  onRangeStored,
  rangeConcurrency,
  signal,
  sourceUrl,
}) {
  if (missingRanges.length === 0) return;
  let cursor = 0;
  let failed = false;
  let failure;
  const workerCount = normalizedRangeConcurrency(
    rangeConcurrency,
    missingRanges.length,
  );

  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed) {
      const range = missingRanges[cursor];
      cursor += 1;
      if (!range) return;
      try {
        await downloadRange({
          cache,
          fetchAsset,
          label,
          range,
          signal,
          sourceUrl,
        });
        onRangeStored(range);
      } catch (cause) {
        if (!failed) {
          failed = true;
          failure =
            cause ??
            new Error(`${label} range download failed unexpectedly.`);
        }
      }
    }
  });

  await Promise.all(workers);
  if (failed) throw failure;
}

function cachedRangeStream({ cache, label, ranges, signal }) {
  let currentBytes = 0;
  let currentRange;
  let currentReader;
  let rangeIndex = 0;

  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          throwIfAborted(signal);
          if (!currentReader) {
            currentRange = ranges[rangeIndex];
            if (!currentRange) {
              controller.close();
              return;
            }
            const response = await cache.match(currentRange.cacheUrl);
            if (!isRetainedRange(response, currentRange) || !response.body) {
              await discardCachedEntry(cache, currentRange.cacheUrl);
              throw new OfflineRangeAssemblyError(
                `${label} download progress could not be restored. Try the download again.`,
              );
            }
            currentBytes = 0;
            currentReader = response.body.getReader();
          }

          let readResult;
          try {
            readResult = await currentReader.read();
          } catch (cause) {
            if (!isAbortError(cause, signal)) {
              await discardCachedEntry(cache, currentRange.cacheUrl);
            }
            throw cause;
          }
          const { done, value } = readResult;
          if (done) {
            if (currentBytes !== currentRange.bytes) {
              await discardCachedEntry(cache, currentRange.cacheUrl);
              throw new OfflineRangeAssemblyError(
                `${label} download progress was incomplete. Try the download again.`,
              );
            }
            currentReader = undefined;
            currentRange = undefined;
            rangeIndex += 1;
            continue;
          }

          currentBytes += value.byteLength;
          if (currentBytes > currentRange.bytes) {
            await currentReader.cancel();
            await discardCachedEntry(cache, currentRange.cacheUrl);
            throw new OfflineRangeAssemblyError(
              `${label} download progress was invalid. Try the download again.`,
            );
          }
          controller.enqueue(value);
          return;
        }
      } catch (cause) {
        controller.error(cause);
      }
    },
    async cancel(reason) {
      await currentReader?.cancel(reason);
    },
  });
}

function assembledResponseHeaders(firstRange, expectedBytes) {
  const headers = new Headers(firstRange.headers);
  headers.delete(RANGE_VERSION_HEADER);
  headers.delete(RANGE_START_HEADER);
  headers.delete(RANGE_END_HEADER);
  headers.delete(RANGE_TOTAL_HEADER);
  headers.set("content-length", String(expectedBytes));
  return headers;
}

/**
 * Return whether an asset has either its normal final cache entry or every
 * verified range needed by range-backed storage.
 *
 * @param {{
 *   cache: Cache,
 *   cacheUrl: string,
 *   expectedBytes: number,
 *   rangeChunkBytes?: number,
 * }} options
 */
export async function isCachedOfflineAssetComplete({
  cache,
  cacheUrl,
  expectedBytes,
  rangeChunkBytes,
}) {
  const hasRanges = hasRangeConfiguration(expectedBytes, rangeChunkBytes);
  const finalResponse = await cache.match(cacheUrl);
  if (hasExpectedContentLength(finalResponse, expectedBytes)) {
    if (hasRanges) {
      await removeAllRetainedRanges(
        cache,
        cacheUrl,
        buildRangeSpecs(expectedBytes, rangeChunkBytes, cacheUrl),
      );
    }
    return true;
  }
  if (finalResponse) await discardCachedEntry(cache, cacheUrl);
  if (!hasRanges) return false;
  const ranges = buildRangeSpecs(
    expectedBytes,
    rangeChunkBytes,
    cacheUrl,
  );
  await removeObsoleteRetainedRanges(cache, cacheUrl, ranges);
  const retainedRanges = await findRetainedRanges(cache, ranges);
  return retainedRanges.every(Boolean);
}

/**
 * Return the verified bytes already retained for an asset. A complete normal
 * cache entry counts once; otherwise each valid staged range counts toward a
 * resumable download without requiring its body to be loaded into memory.
 *
 * @param {{
 *   cache: Cache,
 *   cacheUrl: string,
 *   expectedBytes: number,
 *   rangeChunkBytes?: number,
 * }} options
 */
export async function getCachedOfflineAssetRetainedBytes({
  cache,
  cacheUrl,
  expectedBytes,
  rangeChunkBytes,
}) {
  const hasRanges = hasRangeConfiguration(expectedBytes, rangeChunkBytes);
  const finalResponse = await cache.match(cacheUrl);
  if (hasExpectedContentLength(finalResponse, expectedBytes)) {
    if (hasRanges) {
      await removeAllRetainedRanges(
        cache,
        cacheUrl,
        buildRangeSpecs(expectedBytes, rangeChunkBytes, cacheUrl),
      );
    }
    return expectedBytes;
  }
  if (finalResponse) await discardCachedEntry(cache, cacheUrl);
  if (!hasRanges) return 0;

  const ranges = buildRangeSpecs(
    expectedBytes,
    rangeChunkBytes,
    cacheUrl,
  );
  await removeObsoleteRetainedRanges(cache, cacheUrl, ranges);
  const retainedRanges = await findRetainedRanges(cache, ranges);
  return ranges.reduce(
    (total, range, index) =>
      total + (retainedRanges[index] ? range.bytes : 0),
    0,
  );
}

/**
 * Return a normal cached response when present, otherwise build a fresh 200
 * response that streams a complete retained range set without duplicating it
 * in Cache Storage. Returns undefined while any required range is absent.
 *
 * @param {{
 *   cache: Cache,
 *   cacheUrl: string,
 *   expectedBytes: number,
 *   label?: string,
 *   rangeChunkBytes: number,
 *   signal?: AbortSignal,
 * }} options
 */
export async function getCachedOfflineAssetResponse({
  cache,
  cacheUrl,
  expectedBytes,
  label = "The offline asset",
  rangeChunkBytes,
  signal,
}) {
  throwIfAborted(signal);
  const finalResponse = await cache.match(cacheUrl);
  throwIfAborted(signal);
  if (hasExpectedContentLength(finalResponse, expectedBytes)) {
    if (hasRangeConfiguration(expectedBytes, rangeChunkBytes)) {
      await removeAllRetainedRanges(
        cache,
        cacheUrl,
        buildRangeSpecs(expectedBytes, rangeChunkBytes, cacheUrl),
      );
      throwIfAborted(signal);
    }
    return finalResponse;
  }
  if (finalResponse) await discardCachedEntry(cache, cacheUrl);
  if (!hasRangeConfiguration(expectedBytes, rangeChunkBytes)) {
    return undefined;
  }

  const ranges = buildRangeSpecs(
    expectedBytes,
    rangeChunkBytes,
    cacheUrl,
  );
  await removeObsoleteRetainedRanges(cache, cacheUrl, ranges);
  const retainedRanges = await findRetainedRanges(cache, ranges);
  throwIfAborted(signal);
  if (!retainedRanges.every(Boolean)) return undefined;

  const firstRange = await cache.match(ranges[0].cacheUrl);
  throwIfAborted(signal);
  if (!isRetainedRange(firstRange, ranges[0])) return undefined;
  return new Response(
    cachedRangeStream({ cache, label, ranges, signal }),
    {
      headers: assembledResponseHeaders(firstRange, expectedBytes),
      status: 200,
      statusText: "OK",
    },
  );
}

async function assembleCachedRanges({
  cache,
  cacheUrl,
  expectedBytes,
  label,
  ranges,
  signal,
}) {
  const response = await getCachedOfflineAssetResponse({
    cache,
    cacheUrl,
    expectedBytes,
    label,
    rangeChunkBytes: ranges[0].bytes,
    signal,
  });
  if (!response) {
    throw new OfflineRangeAssemblyError(
      `${label} download progress could not be restored. Try the download again.`,
    );
  }
  await putCachedResponse({
    cache,
    cacheUrl,
    label,
    response,
    signal,
  });
}

async function downloadRangedAsset({
  cache,
  cacheUrl,
  expectedBytes,
  fetchAsset,
  label,
  onDownloadProgress,
  rangeBacked,
  rangeChunkBytes,
  rangeConcurrency,
  signal,
  sourceUrl,
}) {
  const ranges = buildRangeSpecs(
    expectedBytes,
    rangeChunkBytes,
    cacheUrl,
  );
  await removeObsoleteRetainedRanges(cache, cacheUrl, ranges);
  const retainedRanges = await findRetainedRanges(cache, ranges);
  throwIfAborted(signal);
  let loaded = ranges.reduce(
    (total, range, index) =>
      total + (retainedRanges[index] ? range.bytes : 0),
    0,
  );
  onDownloadProgress?.({
    done: false,
    loaded,
    total: expectedBytes,
  });

  const missingRanges = ranges.filter(
    (_range, index) => !retainedRanges[index],
  );
  await downloadMissingRanges({
    cache,
    fetchAsset,
    label,
    missingRanges,
    onRangeStored(range) {
      loaded += range.bytes;
      if (loaded < expectedBytes) {
        onDownloadProgress?.({
          done: false,
          loaded,
          total: expectedBytes,
        });
      }
    },
    rangeConcurrency,
    signal,
    sourceUrl,
  });

  throwIfAborted(signal);
  if (rangeBacked) {
    const retained = await isCachedOfflineAssetComplete({
      cache,
      cacheUrl,
      expectedBytes,
      rangeChunkBytes,
    });
    throwIfAborted(signal);
    if (!retained) {
      throw new OfflineAssetStorageError(
        `The browser did not retain ${label.toLowerCase()}. Check site storage permissions and try again.`,
      );
    }
    onDownloadProgress?.({
      done: true,
      loaded: expectedBytes,
      total: expectedBytes,
    });
    return;
  }
  await assembleCachedRanges({
    cache,
    cacheUrl,
    expectedBytes,
    label,
    ranges,
    signal,
  });
  await removeRetainedRanges(cache, ranges);
  onDownloadProgress?.({
    done: true,
    loaded: expectedBytes,
    total: expectedBytes,
  });
}

async function downloadWholeAsset({
  cache,
  cacheUrl,
  expectedBytes,
  fetchAsset,
  label,
  onDownloadProgress,
  signal,
  sourceUrl,
}) {
  let downloadedBody;
  let downloadCause;
  let downloadHeaders;
  let downloadStatus;
  let loaded = 0;
  let total = null;

  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    try {
      let response = await fetchAsset(sourceUrl, {
        cache: "no-store",
        signal,
      });
      if (!response?.ok) {
        downloadStatus = response?.status ?? "unknown";
        downloadCause = undefined;
        await cancelResponseBody(response);
        continue;
      }

      const contentLength = Number(response.headers.get("content-length"));
      total =
        Number.isFinite(contentLength) && contentLength > 0
          ? contentLength
          : null;
      loaded = 0;
      onDownloadProgress?.({ done: false, loaded, total });

      if (onDownloadProgress && response.body) {
        const trackedBody = response.body.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              loaded += chunk.byteLength;
              if (total === null || loaded < total) {
                onDownloadProgress({ done: false, loaded, total });
              }
              controller.enqueue(chunk);
            },
          }),
        );
        response = new Response(trackedBody, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Chromium-based browsers can report a Cache.put() NetworkError while
      // it consumes a live response. Complete the small asset download first,
      // then commit the browser-managed Blob in a separate transaction.
      const responseBody = await response.blob();
      throwIfAborted(signal);
      if (total !== null && responseBody.size !== total) {
        throw new Error(
          `Expected ${total} bytes, received ${responseBody.size}.`,
        );
      }
      if (
        Number.isSafeInteger(expectedBytes) &&
        expectedBytes > 0 &&
        responseBody.size !== expectedBytes
      ) {
        throw new Error(
          `Expected ${expectedBytes} bytes, received ${responseBody.size}.`,
        );
      }
      downloadedBody = responseBody;
      loaded = responseBody.size;
      downloadHeaders = new Headers(response.headers);
      downloadHeaders.set("content-length", String(responseBody.size));
      break;
    } catch (cause) {
      if (isAbortError(cause, signal)) throw abortReason(signal) ?? cause;
      downloadCause = cause;
    }
  }

  if (!downloadedBody || !downloadHeaders) {
    if (downloadStatus !== undefined && downloadCause === undefined) {
      throw new Error(
        `${label} could not be downloaded (HTTP ${downloadStatus}).`,
      );
    }
    throw new Error(
      `${label} could not be downloaded completely. Check the connection and try again.`,
      { cause: downloadCause },
    );
  }

  await putCachedResponse({
    cache,
    cacheUrl,
    label,
    response: new Response(downloadedBody, {
      headers: downloadHeaders,
      status: 200,
      statusText: "OK",
    }),
    signal,
  });
  onDownloadProgress?.({
    done: true,
    loaded,
    total: total ?? loaded,
  });
}

/**
 * Fetch one pinned offline asset and verify that Cache Storage retained it.
 * Large range-addressable assets retain each completed range so interrupted
 * installs can resume without keeping the entire model in JS memory.
 *
 * @param {{
 *   cache: Cache,
 *   cacheUrl: string,
 *   expectedBytes?: number,
 *   fetchAsset?: typeof fetch,
 *   label: string,
 *   onDownloadProgress?: (progress: {
 *     done: boolean,
 *     loaded: number,
 *     total: number | null,
 *   }) => void,
 *   rangeBacked?: boolean,
 *   rangeChunkBytes?: number,
 *   rangeConcurrency?: number,
 *   signal?: AbortSignal,
 *   sourceUrl: string,
 * }} options
 */
export async function ensureCachedOfflineAsset({
  cache,
  cacheUrl,
  expectedBytes,
  fetchAsset = fetch,
  label,
  onDownloadProgress,
  rangeBacked = false,
  rangeChunkBytes,
  rangeConcurrency,
  signal,
  sourceUrl,
}) {
  throwIfAborted(signal);
  const useRanges = hasRangeConfiguration(
    expectedBytes,
    rangeChunkBytes,
  );
  const cached = await cache.match(cacheUrl);
  throwIfAborted(signal);
  if (hasExpectedContentLength(cached, expectedBytes)) {
    if (useRanges) {
      await removeAllRetainedRanges(
        cache,
        cacheUrl,
        buildRangeSpecs(expectedBytes, rangeChunkBytes, cacheUrl),
      );
    }
    return false;
  }
  if (cached) await discardCachedEntry(cache, cacheUrl);
  if (
    rangeBacked &&
    useRanges &&
    (await isCachedOfflineAssetComplete({
      cache,
      cacheUrl,
      expectedBytes,
      rangeChunkBytes,
    }))
  ) {
    throwIfAborted(signal);
    return false;
  }

  if (useRanges) {
    await downloadRangedAsset({
      cache,
      cacheUrl,
      expectedBytes,
      fetchAsset,
      label,
      onDownloadProgress,
      rangeBacked,
      rangeChunkBytes,
      rangeConcurrency,
      signal,
      sourceUrl,
    });
  } else {
    await downloadWholeAsset({
      cache,
      cacheUrl,
      expectedBytes,
      fetchAsset,
      label,
      onDownloadProgress,
      signal,
      sourceUrl,
    });
  }

  return true;
}
