import { PDF_RASTER_MAX_PIXELS } from "./pdf-raster-scale.mjs";

export const PDF_BITMAP_CACHE_MAX_PIXELS = PDF_RASTER_MAX_PIXELS * 2;

/**
 * A paged external store keeps large text-content records and raster handles
 * outside React state. Consumers subscribe to one numeric revision and select
 * only the currently virtualized range.
 */
function scheduleStoreNotification(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(callback);
    return;
  }
  callback();
}

export function createPdfPageStore({
  maxBitmaps = 8,
  maxBitmapPixels = PDF_BITMAP_CACHE_MAX_PIXELS,
  scheduleNotification = scheduleStoreNotification,
} = {}) {
  /** @type {Map<number, any>} */
  const pages = new Map();
  /** @type {Array<{pageNumber:number,width:number,height:number,wordStart:number}>} */
  const summaries = [];
  /** @type {Map<number, any>} */
  const bitmaps = new Map();
  /** @type {Map<number, number>} */
  const bitmapPins = new Map();
  const listeners = new Set();
  let version = 0;
  let notificationPending = false;

  const deliverNotification = () => {
    notificationPending = false;
    // React can replace an external-store subscription while handling a
    // notification. Iterating the live Set would then visit that re-added
    // listener again during the same publish and can exceed React's nested
    // update limit. Each listener present at publish time receives one update.
    for (const listener of [...listeners]) listener();
  };

  const notify = () => {
    version += 1;
    // PDF workers can deliver hundreds of page or bitmap updates in a burst.
    // Keep the snapshot exact while limiting React to one render notification
    // for the current animation frame.
    if (notificationPending) return;
    notificationPending = true;
    try {
      scheduleNotification(deliverNotification);
    } catch (error) {
      notificationPending = false;
      throw error;
    }
  };

  const evictBitmaps = () => {
    const countLimit = Math.max(1, Math.trunc(maxBitmaps));
    const pixelLimit = Math.max(1, Math.trunc(maxBitmapPixels));
    const totalPixels = () =>
      [...bitmaps.values()].reduce(
        (sum, bitmap) =>
          sum +
          Math.max(0, Number(bitmap?.width) || 0) *
            Math.max(0, Number(bitmap?.height) || 0),
        0,
      );
    let changed = false;
    while (bitmaps.size > countLimit || totalPixels() > pixelLimit) {
      const oldestUnpinned = [...bitmaps.keys()].find(
        (pageNumber) => !bitmapPins.has(pageNumber),
      );
      if (oldestUnpinned === undefined) break;
      bitmaps.get(oldestUnpinned)?.bitmap?.close?.();
      bitmaps.delete(oldestUnpinned);
      changed = true;
    }
    return changed;
  };

  return {
    appendPage(page) {
      if (!page || pages.has(page.pageNumber)) return false;
      pages.set(page.pageNumber, page);
      summaries.push({
        pageNumber: page.pageNumber,
        width: page.layout.width,
        height: page.layout.height,
        wordStart: page.model.wordStart,
      });
      summaries.sort((left, right) => left.pageNumber - right.pageNumber);
      notify();
      return true;
    },
    setBitmap(pageNumber, bitmap) {
      const current = bitmaps.get(pageNumber);
      if (
        current &&
        Number(current.width) >= Number(bitmap?.width) &&
        Number(current.height) >= Number(bitmap?.height)
      ) {
        bitmap?.bitmap?.close?.();
        return false;
      }
      current?.bitmap?.close?.();
      bitmaps.delete(pageNumber);
      bitmaps.set(pageNumber, bitmap);
      evictBitmaps();
      notify();
      return bitmaps.has(pageNumber);
    },
    pinBitmap(pageNumber) {
      bitmapPins.set(pageNumber, (bitmapPins.get(pageNumber) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (bitmapPins.get(pageNumber) ?? 1) - 1;
        if (remaining > 0) bitmapPins.set(pageNumber, remaining);
        else bitmapPins.delete(pageNumber);
        if (evictBitmaps()) notify();
      };
    },
    getBitmap(pageNumber) {
      return bitmaps.get(pageNumber);
    },
    getBitmapStats() {
      return {
        count: bitmaps.size,
        pixels: [...bitmaps.values()].reduce(
          (sum, bitmap) =>
            sum +
            Math.max(0, Number(bitmap?.width) || 0) *
              Math.max(0, Number(bitmap?.height) || 0),
          0,
        ),
      };
    },
    getPage(pageNumber) {
      return pages.get(pageNumber);
    },
    getPageRange(start, end) {
      const first = Math.max(0, Math.trunc(start));
      const last = Math.min(summaries.length - 1, Math.trunc(end));
      if (last < first) return [];
      return summaries
        .slice(first, last + 1)
        .map((summary) => pages.get(summary.pageNumber))
        .filter(Boolean);
    },
    getSummaries() {
      return summaries;
    },
    getSnapshot() {
      return version;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      for (const rendered of bitmaps.values()) rendered.bitmap?.close?.();
      bitmaps.clear();
      bitmapPins.clear();
      pages.clear();
      summaries.splice(0);
      notify();
    },
    dispose() {
      this.clear();
      listeners.clear();
    },
  };
}
