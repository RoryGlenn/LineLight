export const READER_NAVIGATION_VERSION = 1;
export const MAX_POSITION_HISTORY = 20;
export const POSITION_CONTEXT_WORDS = 6;
export const MIN_LONG_JUMP_WORDS = 12;

function normalizedTokenText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase();
}

function clampTokenIndex(tokenIndex, tokenCount) {
  if (!tokenCount) return null;
  const numericIndex = Number(tokenIndex);
  if (!Number.isFinite(numericIndex)) return 0;
  return Math.min(Math.max(0, Math.trunc(numericIndex)), tokenCount - 1);
}

/**
 * @param {Array<{ text: string }>} tokens
 * @param {number} tokenIndex
 * @param {number} [createdAt]
 */
export function createPositionSnapshot(
  tokens,
  tokenIndex,
  createdAt = Date.now(),
) {
  const safeIndex = clampTokenIndex(tokenIndex, tokens.length);
  if (safeIndex === null) return null;
  const contextStart = Math.max(0, safeIndex - POSITION_CONTEXT_WORDS);
  const contextEnd = Math.min(
    tokens.length,
    safeIndex + POSITION_CONTEXT_WORDS + 1,
  );
  const contextBefore = tokens
    .slice(contextStart, safeIndex)
    .map((token) => token.text);
  const contextAfter = tokens
    .slice(safeIndex + 1, contextEnd)
    .map((token) => token.text);
  const snippetWords = tokens
    .slice(Math.max(0, safeIndex - 4), Math.min(tokens.length, safeIndex + 7))
    .map((token) => token.text);

  return {
    tokenIndex: safeIndex,
    anchorText: tokens[safeIndex]?.text ?? "",
    contextBefore,
    contextAfter,
    snippet: `${safeIndex > 4 ? "… " : ""}${snippetWords.join(" ")}${
      safeIndex + 7 < tokens.length ? " …" : ""
    }`,
    createdAt,
  };
}

function contextScore(position, tokens, candidateIndex) {
  let score = 4;
  const before = Array.isArray(position.contextBefore)
    ? position.contextBefore
    : [];
  const after = Array.isArray(position.contextAfter)
    ? position.contextAfter
    : [];

  before.forEach((text, index) => {
    const tokenIndex = candidateIndex - before.length + index;
    if (
      tokenIndex >= 0 &&
      normalizedTokenText(tokens[tokenIndex]?.text) ===
        normalizedTokenText(text)
    ) {
      score += index === before.length - 1 ? 3 : 1;
    }
  });
  after.forEach((text, index) => {
    const tokenIndex = candidateIndex + index + 1;
    if (
      tokenIndex < tokens.length &&
      normalizedTokenText(tokens[tokenIndex]?.text) ===
        normalizedTokenText(text)
    ) {
      score += index === 0 ? 3 : 1;
    }
  });
  return score;
}

/**
 * Resolve a saved position against current document tokens. Nearby context
 * disambiguates repeated words, while distance from the original token index
 * breaks otherwise safe ties.
 *
 * @param {{
 *   tokenIndex?: number,
 *   anchorText?: string,
 *   contextBefore?: string[],
 *   contextAfter?: string[],
 * }} position
 * @param {Array<{ text: string }>} tokens
 */
export function resolveStoredPosition(position, tokens) {
  if (!position || !tokens.length) return null;
  const savedIndex = clampTokenIndex(position.tokenIndex ?? 0, tokens.length);
  if (savedIndex === null) return null;
  const anchor = normalizedTokenText(position.anchorText);
  if (!anchor) return savedIndex;

  const candidates = [];
  tokens.forEach((token, index) => {
    if (normalizedTokenText(token.text) === anchor) {
      candidates.push({
        index,
        score: contextScore(position, tokens, index),
        distance: Math.abs(index - savedIndex),
      });
    }
  });
  if (!candidates.length) return null;
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.distance - right.distance ||
      left.index - right.index,
  );

  const best = candidates[0];
  const runnerUp = candidates[1];
  if (
    candidates.length > 1 &&
    best.score < 7 &&
    runnerUp &&
    best.score === runnerUp.score
  ) {
    return null;
  }
  return best.index;
}

export function isMeaningfulPositionJump(fromIndex, toIndex, tokenCount) {
  if (!Number.isFinite(fromIndex) || !Number.isFinite(toIndex)) return false;
  const threshold = Math.max(
    MIN_LONG_JUMP_WORDS,
    Math.ceil(Math.max(0, tokenCount) * 0.04),
  );
  return Math.abs(toIndex - fromIndex) >= threshold;
}

/**
 * @template T extends { tokenIndex?: number, anchorText?: string }
 * @param {T[]} history
 * @param {T} position
 * @param {number} [limit]
 * @returns {T[]}
 */
export function pushPositionHistory(
  history,
  position,
  limit = MAX_POSITION_HISTORY,
) {
  const last = history.at(-1);
  const duplicate =
    last &&
    last.tokenIndex === position.tokenIndex &&
    normalizedTokenText(last.anchorText) ===
      normalizedTokenText(position.anchorText);
  const next = duplicate
    ? [...history.slice(0, -1), position]
    : [...history, position];
  return next.slice(-Math.max(1, limit));
}

/**
 * @param {Array<{ text: string, start: number }>} tokens
 * @param {string} fullText
 * @param {string} query
 * @param {number} [limit]
 */
export function findDocumentMatches(tokens, fullText, query, limit = 20) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length < 2 || !tokens.length) return [];
  const normalizedText = fullText.toLocaleLowerCase();
  const matches = [];
  let searchFrom = 0;

  while (matches.length < limit) {
    const characterIndex = normalizedText.indexOf(normalizedQuery, searchFrom);
    if (characterIndex === -1) break;
    const tokenIndex = tokens.findIndex(
      (token, index) =>
        token.start <= characterIndex &&
        (tokens[index + 1]?.start ?? fullText.length + 1) > characterIndex,
    );
    const safeIndex =
      tokenIndex === -1
        ? tokens.findIndex((token) => token.start >= characterIndex)
        : tokenIndex;
    if (safeIndex >= 0 && matches.at(-1)?.tokenIndex !== safeIndex) {
      const snapshot = createPositionSnapshot(tokens, safeIndex, 0);
      if (snapshot) matches.push(snapshot);
    }
    searchFrom = characterIndex + Math.max(1, normalizedQuery.length);
  }

  return matches;
}

export function emptyReaderNavigation() {
  return {
    version: READER_NAVIGATION_VERSION,
    bookmarks: [],
    history: [],
  };
}
