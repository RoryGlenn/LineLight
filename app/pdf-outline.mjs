export const MAX_PDF_OUTLINE_ITEMS = 2_000;
export const MAX_PDF_OUTLINE_DEPTH = 12;

/**
 * Recover per-page word starts from persisted PDF text-layer items. Empty
 * pages inherit the next available reading position without inventing text.
 *
 * @param {Array<{ items?: Array<{ wordStart?: number, wordCount?: number }> }>} pages
 */
export function derivePdfPageWordStarts(pages) {
  let nextWordStart = 0;
  return pages.map((page) => {
    const wordItems = (page.items ?? []).filter(
      (item) =>
        Number.isFinite(item.wordStart) && Number.isFinite(item.wordCount),
    );
    const pageWordStart = wordItems.length
      ? Math.min(...wordItems.map((item) => item.wordStart))
      : nextWordStart;
    nextWordStart = wordItems.reduce(
      (largestEnd, item) =>
        Math.max(largestEnd, item.wordStart + item.wordCount),
      pageWordStart,
    );
    return pageWordStart;
  });
}

function cleanOutlineTitle(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function isPdfReference(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Number.isInteger(value.num) &&
      Number.isInteger(value.gen),
  );
}

/**
 * Resolve either a named or direct PDF destination to a zero-based page index.
 * External links and malformed destinations intentionally return null.
 *
 * @param {{
 *   getDestination: (name: string) => Promise<unknown[] | null>,
 *   getPageIndex: (reference: { num: number, gen: number }) => Promise<number>,
 * }} pdfDocument
 * @param {unknown} destination
 * @returns {Promise<number | null>}
 */
export async function resolvePdfDestinationPageIndex(
  pdfDocument,
  destination,
) {
  try {
    const explicitDestination =
      typeof destination === "string"
        ? await pdfDocument.getDestination(destination)
        : destination;
    if (!Array.isArray(explicitDestination) || !explicitDestination.length) {
      return null;
    }

    const pageReference = explicitDestination[0];
    if (Number.isInteger(pageReference)) return pageReference;
    if (!isPdfReference(pageReference)) return null;
    const pageIndex = await pdfDocument.getPageIndex(pageReference);
    return Number.isInteger(pageIndex) ? pageIndex : null;
  } catch {
    return null;
  }
}

/**
 * Convert PDF.js outline nodes into the small serializable tree stored with a
 * LineLight document.
 *
 * @param {unknown} rawOutline
 * @param {{
 *   getDestination: (name: string) => Promise<unknown[] | null>,
 *   getPageIndex: (reference: { num: number, gen: number }) => Promise<number>,
 * }} pdfDocument
 * @param {number[]} pageWordStarts
 * @param {number} totalWordCount
 */
export async function buildPdfOutline(
  rawOutline,
  pdfDocument,
  pageWordStarts,
  totalWordCount,
) {
  if (!Array.isArray(rawOutline) || !rawOutline.length) return [];
  let remainingItems = MAX_PDF_OUTLINE_ITEMS;

  /**
   * @param {unknown[]} nodes
   * @param {number[]} parentPath
   * @param {number} depth
   */
  async function visit(nodes, parentPath, depth) {
    if (depth > MAX_PDF_OUTLINE_DEPTH || remainingItems <= 0) return [];
    const output = [];

    for (let index = 0; index < nodes.length; index += 1) {
      if (remainingItems <= 0) break;
      const node = nodes[index];
      if (!node || typeof node !== "object") continue;
      remainingItems -= 1;
      const path = [...parentPath, index];
      const title = cleanOutlineTitle(node.title);
      const childNodes = Array.isArray(node.items) ? node.items : [];
      const items = await visit(childNodes, path, depth + 1);
      const pageIndex = node.dest
        ? await resolvePdfDestinationPageIndex(pdfDocument, node.dest)
        : null;
      const validPageIndex =
        pageIndex !== null &&
        pageIndex >= 0 &&
        pageIndex < pageWordStarts.length
          ? pageIndex
          : null;
      const tokenIndex =
        validPageIndex !== null && totalWordCount > 0
          ? Math.min(
              Math.max(0, pageWordStarts[validPageIndex] ?? 0),
              totalWordCount - 1,
            )
          : null;

      if (!title) {
        output.push(...items);
        continue;
      }
      if (validPageIndex === null && !items.length) continue;

      output.push({
        id: `pdf-outline-${path.join("-")}`,
        title,
        pageNumber: validPageIndex === null ? null : validPageIndex + 1,
        tokenIndex,
        items,
      });
    }

    return output;
  }

  return visit(rawOutline, [], 0);
}

/**
 * Return the deepest/latest outline destination at or before the active word.
 *
 * @param {unknown} outline
 * @param {number} activeTokenIndex
 */
export function findActivePdfOutlineItemId(outline, activeTokenIndex) {
  if (!Array.isArray(outline) || !Number.isFinite(activeTokenIndex)) return null;
  let activeItemId = null;
  let activeItemToken = -1;

  function visit(items) {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (
        typeof item.id === "string" &&
        Number.isFinite(item.tokenIndex) &&
        item.tokenIndex <= activeTokenIndex &&
        item.tokenIndex >= activeItemToken
      ) {
        activeItemId = item.id;
        activeItemToken = item.tokenIndex;
      }
      if (Array.isArray(item.items)) visit(item.items);
    }
  }

  visit(outline);
  return activeItemId;
}

/**
 * Find the collapsible parent rows that contain a selected outline item.
 *
 * @param {unknown} outline
 * @param {string | null} targetId
 */
export function findPdfOutlineAncestorIds(outline, targetId) {
  if (!Array.isArray(outline) || !targetId) return [];

  function visit(items, ancestors) {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (item.id === targetId) return ancestors;
      if (Array.isArray(item.items)) {
        const result = visit(item.items, [...ancestors, item.id]);
        if (result) return result;
      }
    }
    return null;
  }

  return visit(outline, []) ?? [];
}
