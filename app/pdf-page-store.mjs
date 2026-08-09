/**
 * A paged external store keeps large text-content records and raster handles
 * outside React state. Consumers subscribe to one numeric revision and select
 * only the currently virtualized range.
 */
export function createPdfPageStore({ maxBitmaps = 8 } = {}) {
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

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  const evictBitmaps = () => {
    const limit = Math.max(1, Math.trunc(maxBitmaps));
    let changed = false;
    while (bitmaps.size > limit) {
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
      bitmaps.get(pageNumber)?.bitmap?.close?.();
      bitmaps.delete(pageNumber);
      bitmaps.set(pageNumber, bitmap);
      evictBitmaps();
      notify();
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
