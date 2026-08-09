const WORD_PATTERN =
  /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;
const IS_WORD = /^[\p{L}\p{N}]/u;
const LINE_END_HYPHEN = /(?<=\p{L})-[ \t]*\n[ \t]*(?=\p{L})/gu;

export const PDF_TEXT_MODEL_VERSION = 1;

/** @param {unknown} document */
export function pdfDocumentNeedsTextModelMigration(document) {
  if (!document || typeof document !== "object") return false;
  const candidate = /** @type {Record<string, unknown>} */ (document);
  return (
    candidate.kind === "pdf" &&
    candidate.pdfTextModelVersion !== PDF_TEXT_MODEL_VERSION
  );
}

/**
 * Rebuild a legacy persisted PDF from its private, stored source bytes. The
 * caller owns PDF.js parsing and storage so this migration stays deterministic,
 * testable, and unable to reach the network.
 *
 * @param {Record<string, any>} document
 * @param {{
 *   reparse: (source: Uint8Array) => Promise<Record<string, any>>,
 *   save: (document: Record<string, any>) => Promise<unknown>,
 * }} operations
 */
export async function migrateStoredPdfTextModel(document, operations) {
  if (!pdfDocumentNeedsTextModelMigration(document)) {
    return { document, migrated: false, reason: "current" };
  }
  const storedSource = document.pdfData;
  if (!storedSource || !Number(storedSource.length)) {
    return { document, migrated: false, reason: "missing-source" };
  }

  const rebuilt = await operations.reparse(
    storedSource instanceof Uint8Array
      ? storedSource.slice()
      : new Uint8Array(storedSource),
  );
  const migrated = {
    ...document,
    paragraphs: rebuilt.paragraphs,
    pdfPages: rebuilt.pdfPages,
    outline: rebuilt.outline,
    pdfTextModelVersion: PDF_TEXT_MODEL_VERSION,
  };
  await operations.save(migrated);
  return { document: migrated, migrated: true, reason: "rebuilt" };
}

/**
 * Keep a PDF's displayed glyph fragments reversible while producing the
 * normalized text used by narration. PDF.js text items are deliberately not
 * rewritten: every visible word range receives the logical token index that
 * contains its source characters.
 *
 * @param {Array<{ text: string, hasEOL?: boolean }>} items
 * @param {number} [globalWordStart]
 */
export function buildPdfTextModel(items, globalWordStart = 0) {
  let source = "";
  /** @type {Array<{ itemIndex: number, offset: number } | null>} */
  const origins = [];

  items.forEach((item, itemIndex) => {
    const text = String(item.text ?? "");
    source += text;
    for (let offset = 0; offset < text.length; offset += 1) {
      origins.push({ itemIndex, offset });
    }
    const separator = item.hasEOL ? "\n" : " ";
    source += separator;
    origins.push(null);
  });

  const removed = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\u00ad") removed[index] = 1;
  }
  for (const match of source.matchAll(LINE_END_HYPHEN)) {
    const start = match.index ?? 0;
    const continuation = source[start + match[0].length] ?? "";
    const precedingFragment =
      source.slice(0, start).match(/[\p{L}\p{N}]+$/u)?.[0] ?? "";
    // Lowercase continuations are discretionary print hyphens. Uppercase
    // continuations can be real compounds or names (Man-Month,
    // Collins-Sussman), but only join them when the preceding fragment is also
    // title-cased. This avoids joining a truncated page-ending word to an
    // uppercase running footer or heading in PDF extraction order.
    const lowercaseContinuation = /^\p{Ll}$/u.test(continuation);
    const titleCasedCompound =
      /^\p{Lu}/u.test(continuation) && /^\p{Lu}/u.test(precedingFragment);
    if (!lowercaseContinuation && !titleCasedCompound) continue;
    const removalStart = lowercaseContinuation ? start : start + 1;
    for (
      let index = removalStart;
      index < start + match[0].length;
      index += 1
    ) {
      removed[index] = 1;
    }
  }

  let normalizedText = "";
  /** @type {Array<{ itemIndex: number, offset: number } | null>} */
  const normalizedOrigins = [];
  for (let index = 0; index < source.length; index += 1) {
    if (removed[index]) continue;
    normalizedText += source[index];
    normalizedOrigins.push(origins[index]);
  }

  /** @type {Array<Array<{
   *   start: number,
   *   end: number,
   *   text: string,
   *   tokenIndex: number | null,
   * }>>} */
  const displayWords = items.map((item) =>
    Array.from(String(item.text ?? "").matchAll(WORD_PATTERN), (match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      text: match[0],
      tokenIndex: null,
    })),
  );

  const normalizedWords = Array.from(normalizedText.matchAll(WORD_PATTERN));
  normalizedWords.forEach((word, wordOffset) => {
    const start = word.index ?? 0;
    const end = start + word[0].length;
    const tokenIndex = globalWordStart + wordOffset;
    const touchedFragments = new Set();

    for (let index = start; index < end; index += 1) {
      const origin = normalizedOrigins[index];
      if (!origin) continue;
      const fragments = displayWords[origin.itemIndex] ?? [];
      const fragmentIndex = fragments.findIndex(
        (fragment) =>
          origin.offset >= fragment.start && origin.offset < fragment.end,
      );
      if (fragmentIndex >= 0) {
        touchedFragments.add(`${origin.itemIndex}:${fragmentIndex}`);
      }
    }

    for (const key of touchedFragments) {
      const [itemIndex, fragmentIndex] = key.split(":").map(Number);
      displayWords[itemIndex][fragmentIndex].tokenIndex = tokenIndex;
    }
  });

  return {
    text: normalizedText,
    wordCount: normalizedWords.length,
    items: displayWords.map((fragments) => ({
      words: fragments.filter((fragment) => fragment.tokenIndex !== null),
      wordIndices: fragments.flatMap((fragment) =>
        fragment.tokenIndex === null ? [] : [fragment.tokenIndex],
      ),
    })),
  };
}

/**
 * Normalize whitespace only after glyph-to-token mapping has been captured.
 * Paragraph starts are retained because they also provide sentence boundaries
 * for title pages and other punctuation-free PDF structures.
 *
 * @param {string} value
 */
export function pdfTextParagraphs(value) {
  const cleaned = String(value ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return [];

  const paragraphs = cleaned
    .split(/\n{2,}|\n(?=[A-Z0-9“"'])/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : [cleaned];
}

/**
 * Group measured word rectangles into continuous visual sentence lines. Large
 * gaps split otherwise aligned rectangles so two columns never become one
 * highlight bar. Rotation is handled on the visual axis rather than assuming
 * all PDF text is horizontal.
 *
 * @param {Array<{
 *   sentenceIndex: number,
 *   left: number,
 *   top: number,
 *   width: number,
 *   height: number,
 *   angle?: number,
 * }>} rectangles
 */
export function mergePdfSentenceLineRects(rectangles) {
  const groups = new Map();
  for (const rectangle of rectangles) {
    if (!Number.isFinite(rectangle.sentenceIndex)) continue;
    const angle = ((Number(rectangle.angle) || 0) % 180 + 180) % 180;
    const vertical = angle > 45 && angle < 135;
    const key = `${rectangle.sentenceIndex}:${vertical ? "v" : "h"}`;
    const group = groups.get(key) ?? [];
    group.push({ ...rectangle, vertical });
    groups.set(key, group);
  }

  const merged = [];
  for (const group of groups.values()) {
    const lines = [];
    for (const rectangle of group) {
      const crossStart = rectangle.vertical ? rectangle.left : rectangle.top;
      const crossSize = rectangle.vertical
        ? rectangle.width
        : rectangle.height;
      const crossEnd = crossStart + crossSize;
      const center = crossStart + crossSize / 2;
      let line = lines.find((candidate) => {
        const overlap =
          Math.min(candidate.crossEnd, crossEnd) -
          Math.max(candidate.crossStart, crossStart);
        return (
          overlap >= Math.min(candidate.crossSize, crossSize) * 0.25 ||
          Math.abs(candidate.center - center) <=
            Math.max(candidate.crossSize, crossSize) * 0.55
        );
      });
      if (!line) {
        line = {
          center,
          crossStart,
          crossEnd,
          crossSize,
          rectangles: [],
        };
        lines.push(line);
      }
      line.rectangles.push(rectangle);
      line.crossStart = Math.min(line.crossStart, crossStart);
      line.crossEnd = Math.max(line.crossEnd, crossEnd);
      line.crossSize = line.crossEnd - line.crossStart;
      line.center = (line.crossStart + line.crossEnd) / 2;
    }

    for (const line of lines) {
      const sorted = line.rectangles.toSorted((left, right) =>
        left.vertical ? left.top - right.top : left.left - right.left,
      );
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const left = Math.min(...run.map((rectangle) => rectangle.left));
        const top = Math.min(...run.map((rectangle) => rectangle.top));
        const right = Math.max(
          ...run.map((rectangle) => rectangle.left + rectangle.width),
        );
        const bottom = Math.max(
          ...run.map((rectangle) => rectangle.top + rectangle.height),
        );
        merged.push({
          sentenceIndex: run[0].sentenceIndex,
          left,
          top,
          width: right - left,
          height: bottom - top,
          vertical: run[0].vertical,
        });
        run = [];
      };

      for (const rectangle of sorted) {
        const previous = run.at(-1);
        if (previous) {
          const previousEnd = previous.vertical
            ? previous.top + previous.height
            : previous.left + previous.width;
          const nextStart = rectangle.vertical
            ? rectangle.top
            : rectangle.left;
          const lineThickness = Math.max(
            previous.vertical ? previous.width : previous.height,
            rectangle.vertical ? rectangle.width : rectangle.height,
          );
          if (nextStart - previousEnd > Math.max(4, lineThickness * 3)) {
            flush();
          }
        }
        run.push(rectangle);
      }
      flush();
    }
  }

  return merged.toSorted(
    (left, right) =>
      left.sentenceIndex - right.sentenceIndex ||
      left.top - right.top ||
      left.left - right.left,
  );
}

export function isPdfWord(value) {
  return IS_WORD.test(value);
}
