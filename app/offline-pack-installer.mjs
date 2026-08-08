/**
 * Fetch one pinned offline asset and verify that Cache Storage retained it.
 * Keeping this separate from model initialization lets first-launch download
 * succeed even when a browser's accelerated inference backend is unavailable.
 */
export async function ensureCachedOfflineAsset({
  cache,
  cacheUrl,
  fetchAsset = fetch,
  label,
  onDownloadProgress,
  sourceUrl,
}) {
  if (await cache.match(cacheUrl)) return false;

  let response;
  try {
    response = await fetchAsset(sourceUrl);
  } catch (cause) {
    throw new Error(
      `${label} could not be downloaded. Check the connection and try again.`,
      { cause },
    );
  }

  if (!response?.ok) {
    throw new Error(
      `${label} could not be downloaded (HTTP ${response?.status ?? "unknown"}).`,
    );
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

  try {
    await cache.put(cacheUrl, response);
  } catch (cause) {
    throw new Error(
      `The browser could not store ${label.toLowerCase()}. Free at least 100 MB of site storage and try again.`,
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
