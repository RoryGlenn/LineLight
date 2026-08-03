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
