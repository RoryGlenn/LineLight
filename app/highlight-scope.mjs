export const DEFAULT_HIGHLIGHT_SCOPE = "sentence";

const HIGHLIGHT_SCOPES = new Set(["sentence", "paragraph"]);

export const HIGHLIGHT_SCOPE_OPTIONS = Object.freeze([
  Object.freeze({
    value: "sentence",
    label: "Sentence",
    description:
      "Keep one thought visually steady while narration moves through it.",
  }),
  Object.freeze({
    value: "paragraph",
    label: "Paragraph",
    description:
      "Keep the wider passage visually steady when more context feels helpful.",
  }),
]);

/**
 * Accept only the two reader-facing scopes. Legacy word-level choices become
 * sentence scope because exact-token tracking is now interaction-only.
 *
 * @param {unknown} value
 * @returns {"sentence" | "paragraph"}
 */
export function normalizeHighlightScope(value) {
  return value === "paragraph" ? "paragraph" : DEFAULT_HIGHLIGHT_SCOPE;
}

/**
 * Remove the retired `highlightMode` key while deterministically restoring a
 * canonical scope. A valid current key wins; all historic both/word/sentence
 * choices migrate to sentence. `paragraph` is only accepted from the current
 * canonical key so a malformed or future legacy value cannot change scope.
 *
 * @param {Record<string, unknown>} [storedSettings]
 */
export function migrateReaderHighlightSettings(storedSettings = {}) {
  const {
    highlightMode: legacyHighlightMode,
    highlightScope: storedHighlightScope,
    ...remainingSettings
  } = storedSettings;
  const candidate = HIGHLIGHT_SCOPES.has(storedHighlightScope)
    ? storedHighlightScope
    : legacyHighlightMode === "sentence"
      ? legacyHighlightMode
      : DEFAULT_HIGHLIGHT_SCOPE;
  return {
    ...remainingSettings,
    highlightScope: normalizeHighlightScope(candidate),
  };
}

/**
 * Resolve the active visual region without changing the exact active token.
 *
 * @param {Array<{ paragraphIndex: number, sentenceIndex: number }>} tokens
 * @param {number} activeTokenIndex
 * @param {unknown} scope
 */
export function deriveActiveHighlightIndex(tokens, activeTokenIndex, scope) {
  const safeIndex = Math.min(
    Math.max(0, Math.trunc(activeTokenIndex) || 0),
    Math.max(0, tokens.length - 1),
  );
  const token = tokens[safeIndex] ?? tokens[0];
  if (!token) return -1;
  return normalizeHighlightScope(scope) === "paragraph"
    ? token.paragraphIndex
    : token.sentenceIndex;
}
