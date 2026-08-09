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

/** Create the keyed subscription core shared by PDF and Focus shell stores. */
function createRenderWindowStore(itemCount, initialActiveIndex, overscan) {
  const count = Math.max(0, Math.trunc(itemCount));
  let activeIndex = Math.min(
    Math.max(0, Math.trunc(initialActiveIndex) || 0),
    Math.max(0, count - 1),
  );
  const visibleIndices = new Set();
  let renderedIndices = new Set(
    selectVirtualizedIndices(
      visibleIndices,
      count,
      activeIndex,
      overscan,
    ),
  );
  /** @type {Map<number, Set<() => void>>} */
  const listeners = new Map();

  const recompute = () => {
    const next = new Set(
      selectVirtualizedIndices(
        visibleIndices,
        count,
        activeIndex,
        overscan,
      ),
    );
    const changed = new Set();
    for (const index of renderedIndices) {
      if (!next.has(index)) changed.add(index);
    }
    for (const index of next) {
      if (!renderedIndices.has(index)) changed.add(index);
    }
    renderedIndices = next;
    for (const index of changed) {
      for (const listener of listeners.get(index) ?? []) listener();
    }
    return Array.from(changed).sort((left, right) => left - right);
  };

  return {
    getActiveIndex() {
      return activeIndex;
    },
    getRenderedIndices() {
      return Array.from(renderedIndices).sort(
        (left, right) => left - right,
      );
    },
    isRendered(index) {
      return renderedIndices.has(index);
    },
    setActiveIndex(index) {
      const next = Math.min(
        Math.max(0, Math.trunc(index) || 0),
        Math.max(0, count - 1),
      );
      if (next === activeIndex) return [];
      activeIndex = next;
      return recompute();
    },
    setVisible(index, visible) {
      if (!Number.isInteger(index) || index < 0 || index >= count) {
        return [];
      }
      const changed = visible
        ? !visibleIndices.has(index)
        : visibleIndices.has(index);
      if (!changed) return [];
      if (visible) visibleIndices.add(index);
      else visibleIndices.delete(index);
      return recompute();
    },
    subscribe(index, listener) {
      const itemListeners = listeners.get(index) ?? new Set();
      itemListeners.add(listener);
      listeners.set(index, itemListeners);
      return () => {
        itemListeners.delete(listener);
        if (!itemListeners.size) listeners.delete(index);
      };
    },
  };
}

/**
 * Keep the lightweight PDF page shells structurally stable while allowing
 * only pages entering or leaving the render window to update.
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
  const store = createRenderWindowStore(
    pageCount,
    initialActivePageIndex,
    overscan,
  );
  return {
    getActivePageIndex: store.getActiveIndex,
    getRenderedPageIndices: store.getRenderedIndices,
    isPageRendered: store.isRendered,
    setActivePageIndex: store.setActiveIndex,
    setPageVisible: store.setVisible,
    subscribe: store.subscribe,
  };
}

/**
 * Keep Focus paragraph shells stable while notifying only paragraphs entering
 * or leaving the bounded render window.
 *
 * @param {number} paragraphCount
 * @param {number} initialActiveParagraphIndex
 * @param {number} [overscan]
 */
export function createFocusParagraphRenderStore(
  paragraphCount,
  initialActiveParagraphIndex,
  overscan = FOCUS_PARAGRAPH_OVERSCAN,
) {
  const store = createRenderWindowStore(
    paragraphCount,
    initialActiveParagraphIndex,
    overscan,
  );
  return {
    getActiveParagraphIndex: store.getActiveIndex,
    getRenderedParagraphIndices: store.getRenderedIndices,
    isParagraphRendered: store.isRendered,
    setActiveParagraphIndex: store.setActiveIndex,
    setParagraphVisible: store.setVisible,
    subscribe: store.subscribe,
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
