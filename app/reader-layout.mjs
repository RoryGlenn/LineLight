export const FOCUS_LINE_COUNTS = Object.freeze([0, 1, 3, 5]);

export const READER_LAYOUT_LIMITS = Object.freeze({
  letterSpacing: Object.freeze({ min: 0, max: 0.12 }),
  wordSpacing: Object.freeze({ min: 0, max: 0.3 }),
  paragraphSpacing: Object.freeze({ min: 0.8, max: 2.5 }),
  maxLineWidth: Object.freeze({ min: 42, max: 90 }),
});

export const DEFAULT_READER_LAYOUT = Object.freeze({
  letterSpacing: 0,
  wordSpacing: 0,
  paragraphSpacing: 1.45,
  maxLineWidth: 72,
  focusLines: 0,
});

function clampedNumber(value, fallback, limits, decimalPlaces = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  const clamped = Math.min(Math.max(numericValue, limits.min), limits.max);
  const precision = 10 ** decimalPlaces;
  return Math.round(clamped * precision) / precision;
}

/**
 * Normalize persisted reading-layout values against the supported rendering
 * range. Old or corrupt preferences fall back without blocking the reader.
 *
 * @param {unknown} value
 */
export function normalizeReaderLayout(value) {
  const candidate =
    value && typeof value === "object"
      ? /** @type {Record<string, unknown>} */ (value)
      : {};
  const requestedFocusLines = Number(candidate.focusLines);

  return {
    letterSpacing: clampedNumber(
      candidate.letterSpacing,
      DEFAULT_READER_LAYOUT.letterSpacing,
      READER_LAYOUT_LIMITS.letterSpacing,
    ),
    wordSpacing: clampedNumber(
      candidate.wordSpacing,
      DEFAULT_READER_LAYOUT.wordSpacing,
      READER_LAYOUT_LIMITS.wordSpacing,
    ),
    paragraphSpacing: clampedNumber(
      candidate.paragraphSpacing,
      DEFAULT_READER_LAYOUT.paragraphSpacing,
      READER_LAYOUT_LIMITS.paragraphSpacing,
    ),
    maxLineWidth: clampedNumber(
      candidate.maxLineWidth,
      DEFAULT_READER_LAYOUT.maxLineWidth,
      READER_LAYOUT_LIMITS.maxLineWidth,
      0,
    ),
    focusLines: FOCUS_LINE_COUNTS.includes(requestedFocusLines)
      ? requestedFocusLines
      : DEFAULT_READER_LAYOUT.focusLines,
  };
}

/**
 * Build the CSS custom properties used by reflowed Focus view.
 *
 * @param {unknown} value
 */
export function createReaderLayoutStyle(value) {
  const layout = normalizeReaderLayout(value);
  return {
    "--reader-letter-spacing": `${layout.letterSpacing.toFixed(2)}em`,
    "--reader-word-spacing": `${layout.wordSpacing.toFixed(2)}em`,
    "--reader-paragraph-spacing": `${layout.paragraphSpacing.toFixed(2)}em`,
    "--reader-measure": `${layout.maxLineWidth}ch`,
  };
}

/**
 * Select the tokens belonging to the requested number of rendered lines,
 * centered on the active token where possible.
 *
 * @param {Array<{ tokenIndex: number, top: number }>} tokenPositions
 * @param {number} activeTokenIndex
 * @param {number} requestedLineCount
 * @param {number} [lineTolerance]
 */
export function selectFocusWindowTokens(
  tokenPositions,
  activeTokenIndex,
  requestedLineCount,
  lineTolerance = 2,
) {
  const lineCount = FOCUS_LINE_COUNTS.includes(Number(requestedLineCount))
    ? Number(requestedLineCount)
    : DEFAULT_READER_LAYOUT.focusLines;
  const positions = tokenPositions
    .filter(
      (position) =>
        Number.isFinite(position?.tokenIndex) && Number.isFinite(position?.top),
    )
    .map((position) => ({
      tokenIndex: Math.trunc(position.tokenIndex),
      top: position.top,
    }))
    .sort(
      (left, right) =>
        left.top - right.top || left.tokenIndex - right.tokenIndex,
    );

  if (!positions.length) return [];
  if (lineCount === 0) {
    return positions
      .map((position) => position.tokenIndex)
      .sort((left, right) => left - right);
  }

  /** @type {Array<{ top: number, tokenIndices: number[] }>} */
  const lines = [];
  positions.forEach((position) => {
    const currentLine = lines.at(-1);
    if (
      !currentLine ||
      Math.abs(position.top - currentLine.top) > lineTolerance
    ) {
      lines.push({ top: position.top, tokenIndices: [position.tokenIndex] });
      return;
    }
    currentLine.tokenIndices.push(position.tokenIndex);
  });

  const activeLineIndex = lines.findIndex((line) =>
    line.tokenIndices.includes(Math.trunc(activeTokenIndex)),
  );
  if (activeLineIndex === -1) return [];

  const visibleLineCount = Math.min(lineCount, lines.length);
  const centeredStart = activeLineIndex - Math.floor(visibleLineCount / 2);
  const start = Math.min(
    Math.max(0, centeredStart),
    lines.length - visibleLineCount,
  );

  return lines
    .slice(start, start + visibleLineCount)
    .flatMap((line) => line.tokenIndices)
    .sort((left, right) => left - right);
}
