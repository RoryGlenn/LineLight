const DOWNLOAD_ATTEMPTS = 2;

/**
 * Fetch one pinned offline asset and verify that Cache Storage retained it.
 * Keeping this separate from model initialization lets first-launch download
 * succeed even when a browser's accelerated inference backend is unavailable.
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
 *   rangeChunkBytes?: number,
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
  rangeChunkBytes,
  sourceUrl,
}) {
  if (await cache.match(cacheUrl)) return false;

  let response;
  let downloadedBody;
  let downloadCause;
  let downloadStatus;

  if (
    Number.isFinite(expectedBytes) &&
    expectedBytes > 0 &&
    Number.isFinite(rangeChunkBytes) &&
    rangeChunkBytes > 0
  ) {
    const parts = [];
    let responseHeaders;
    onDownloadProgress?.({ done: false, loaded: 0, total: expectedBytes });

    for (let start = 0; start < expectedBytes; start += rangeChunkBytes) {
      const end = Math.min(expectedBytes - 1, start + rangeChunkBytes - 1);
      const expectedPartBytes = end - start + 1;
      let part;

      for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
        try {
          const partResponse = await fetchAsset(sourceUrl, {
            cache: "no-store",
            headers: { Range: `bytes=${start}-${end}` },
          });
          if (partResponse?.status !== 206) {
            downloadStatus = partResponse?.status ?? "unknown";
            downloadCause = undefined;
            continue;
          }

          const contentRange =
            `bytes ${start}-${end}/${expectedBytes}`;
          if (partResponse.headers.get("content-range") !== contentRange) {
            throw new Error(
              `Expected ${contentRange}, received ${partResponse.headers.get("content-range") ?? "no content range"}.`,
            );
          }

          const candidate = await partResponse.blob();
          if (candidate.size !== expectedPartBytes) {
            throw new Error(
              `Expected ${expectedPartBytes} bytes, received ${candidate.size}.`,
            );
          }
          part = candidate;
          responseHeaders = partResponse.headers;
          break;
        } catch (cause) {
          downloadCause = cause;
        }
      }

      if (!part) break;
      parts.push(part);
      const loaded = end + 1;
      onDownloadProgress?.({
        done: loaded === expectedBytes,
        loaded,
        total: expectedBytes,
      });
    }

    if (parts.length === Math.ceil(expectedBytes / rangeChunkBytes)) {
      downloadedBody = new Blob(parts, {
        type: responseHeaders?.get("content-type") ?? "",
      });
      const headers = new Headers(responseHeaders);
      headers.delete("content-range");
      headers.set("content-length", String(expectedBytes));
      response = new Response(null, {
        status: 200,
        statusText: "OK",
        headers,
      });
    }
  } else {
    for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        response = await fetchAsset(sourceUrl, { cache: "no-store" });
        if (!response?.ok) {
          downloadStatus = response?.status ?? "unknown";
          downloadCause = undefined;
          continue;
        }

        if (onDownloadProgress && response.body) {
          const contentLength = Number(response.headers.get("content-length"));
          const total =
            Number.isFinite(contentLength) && contentLength > 0
              ? contentLength
              : null;
          let loaded = 0;
          let completed = false;

          const reportProgress = (done = false) => {
            if (completed) return;
            if (done) completed = true;
            onDownloadProgress({
              done,
              loaded,
              total: total ?? (done ? loaded : null),
            });
          };

          reportProgress();
          const trackedBody = response.body.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                loaded += chunk.byteLength;
                reportProgress(total !== null && loaded >= total);
                controller.enqueue(chunk);
              },
              flush() {
                reportProgress(true);
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
        // it consumes a live response. Complete the download first, then
        // commit the browser-managed Blob in a separate cache transaction.
        downloadedBody = await response.blob();
        break;
      } catch (cause) {
        downloadCause = cause;
      }
    }
  }

  if (!downloadedBody || !response) {
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

  const cachedResponse = new Response(downloadedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  try {
    await cache.put(cacheUrl, cachedResponse);
  } catch (cause) {
    const quotaExceeded =
      cause &&
      typeof cause === "object" &&
      "name" in cause &&
      cause.name === "QuotaExceededError";
    throw new Error(
      quotaExceeded
        ? `The browser does not have enough site storage for ${label.toLowerCase()}. Free at least 200 MB and try again.`
        : `The browser could not store ${label.toLowerCase()}. Check site storage permissions and try again.`,
      { cause },
    );
  }

  if (!(await cache.match(cacheUrl))) {
    throw new Error(
      `The browser did not retain ${label.toLowerCase()}. Check site storage permissions and try again.`,
    );
  }

  return true;
}
