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
