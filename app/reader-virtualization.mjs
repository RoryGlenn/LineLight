export const PDF_PAGE_OVERSCAN = 2;
export const FOCUS_PARAGRAPH_OVERSCAN = 4;

/**
 * Expand the currently visible and active items into one small render window.
 * Lightweight placeholder elements can remain mounted outside this window so
 * native scrolling and document destinations keep working.
 *
 * @param {Iterable<number>} visibleIndices
 * @param {number} itemCount
 * @param {number} activeIndex
 * @param {number} overscan
 */
export function selectVirtualizedIndices(
  visibleIndices,
  itemCount,
  activeIndex,
  overscan,
) {
  const count = Math.max(0, Math.trunc(itemCount));
  if (!count) return [];

  const seeds = new Set();
  for (const index of visibleIndices ?? []) {
    if (Number.isInteger(index) && index >= 0 && index < count) {
      seeds.add(index);
    }
  }
  if (Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < count) {
    seeds.add(activeIndex);
  }
  if (!seeds.size) seeds.add(0);

  const radius = Math.max(0, Math.trunc(overscan));
  const selected = new Set();
  for (const seed of seeds) {
    const start = Math.max(0, seed - radius);
    const end = Math.min(count - 1, seed + radius);
    for (let index = start; index <= end; index += 1) {
      selected.add(index);
    }
  }
  return Array.from(selected).sort((left, right) => left - right);
}

/**
 * Keep the 359 lightweight PDF page shells structurally stable while allowing
 * only pages entering or leaving the render window to update. Subscribers are
 * keyed by page, so an active-page boundary does not notify every shell.
 *
 * @param {number} pageCount
 * @param {number} initialActivePageIndex
 * @param {number} [overscan]
 */
export function createPdfPageRenderStore(
  pageCount,
  initialActivePageIndex,
  overscan = PDF_PAGE_OVERSCAN,
) {
  const count = Math.max(0, Math.trunc(pageCount));
  let activePageIndex = Math.min(
    Math.max(0, Math.trunc(initialActivePageIndex) || 0),
    Math.max(0, count - 1),
  );
  const visiblePageIndices = new Set();
  let renderedPageIndices = new Set(
    selectVirtualizedIndices(
      visiblePageIndices,
      count,
      activePageIndex,
      overscan,
    ),
  );
  /** @type {Map<number, Set<() => void>>} */
  const listeners = new Map();

  const recompute = () => {
    const next = new Set(
      selectVirtualizedIndices(
        visiblePageIndices,
        count,
        activePageIndex,
        overscan,
      ),
    );
    const changed = new Set();
    for (const index of renderedPageIndices) {
      if (!next.has(index)) changed.add(index);
    }
    for (const index of next) {
      if (!renderedPageIndices.has(index)) changed.add(index);
    }
    renderedPageIndices = next;
    for (const index of changed) {
      for (const listener of listeners.get(index) ?? []) listener();
    }
    return Array.from(changed).sort((left, right) => left - right);
  };

  return {
    getActivePageIndex() {
      return activePageIndex;
    },
    getRenderedPageIndices() {
      return Array.from(renderedPageIndices).sort(
        (left, right) => left - right,
      );
    },
    isPageRendered(pageIndex) {
      return renderedPageIndices.has(pageIndex);
    },
    setActivePageIndex(pageIndex) {
      const next = Math.min(
        Math.max(0, Math.trunc(pageIndex) || 0),
        Math.max(0, count - 1),
      );
      if (next === activePageIndex) return [];
      activePageIndex = next;
      return recompute();
    },
    setPageVisible(pageIndex, visible) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= count) {
        return [];
      }
      const changed = visible
        ? !visiblePageIndices.has(pageIndex)
        : visiblePageIndices.has(pageIndex);
      if (!changed) return [];
      if (visible) visiblePageIndices.add(pageIndex);
      else visiblePageIndices.delete(pageIndex);
      return recompute();
    },
    subscribe(pageIndex, listener) {
      const pageListeners = listeners.get(pageIndex) ?? new Set();
      pageListeners.add(listener);
      listeners.set(pageIndex, pageListeners);
      return () => {
        pageListeners.delete(listener);
        if (!pageListeners.size) listeners.delete(pageIndex);
      };
    },
  };
}

/**
 * Resolve a global word index to the page whose start is the last one not
 * greater than that word. Empty PDF pages inherit the previous word start.
 *
 * @param {number[]} pageWordStarts
 * @param {number} wordIndex
 */
export function findPageIndexForWord(pageWordStarts, wordIndex) {
  if (!pageWordStarts.length) return 0;
  const target = Math.max(0, Math.trunc(wordIndex));
  let low = 0;
  let high = pageWordStarts.length - 1;
  let best = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if ((pageWordStarts[middle] ?? 0) <= target) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Give unrendered Focus paragraphs stable space until their measured height is
 * known. The estimate intentionally favors a little extra room to reduce
 * scroll jumps as a paragraph enters the render window.
 *
 * @param {number} characterCount
 * @param {number} fontSize
 * @param {number} lineHeight
 * @param {number} maxLineWidth
 * @param {number} paragraphSpacing
 */
export function estimateParagraphHeight(
  characterCount,
  fontSize,
  lineHeight,
  maxLineWidth,
  paragraphSpacing,
) {
  const charactersPerLine = Math.max(24, Number(maxLineWidth) * 0.82);
  const lines = Math.max(1, Math.ceil(Number(characterCount) / charactersPerLine));
  return Math.ceil(
    lines * Math.max(1, Number(fontSize)) * Math.max(1, Number(lineHeight)) +
      Math.max(0, Number(paragraphSpacing)) * Math.max(1, Number(fontSize)),
  );
}
