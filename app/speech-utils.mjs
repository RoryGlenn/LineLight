export const SPEECH_CHUNK_CHARACTERS = 180;

/**
 * Build a short utterance that prefers to stop at a sentence boundary.
 *
 * Chromium-based browsers are more reliable when speech is sent in small
 * pieces instead of as the entire remaining document.
 *
 * @param {string} fullText
 * @param {Array<{ start: number, end: number, sentenceIndex: number }>} tokens
 * @param {number} startIndex
 * @param {number} [maxCharacters]
 */
export function buildSpeechChunk(
  fullText,
  tokens,
  startIndex,
  maxCharacters = SPEECH_CHUNK_CHARACTERS,
) {
  if (!fullText || !tokens.length) return null;

  const safeIndex = Math.min(Math.max(0, startIndex), tokens.length - 1);
  const startChar = tokens[safeIndex].start;
  let hardEnd = safeIndex + 1;

  while (
    hardEnd < tokens.length &&
    tokens[hardEnd].end - startChar <= maxCharacters
  ) {
    hardEnd += 1;
  }

  let nextIndex = hardEnd;
  for (
    let candidate = safeIndex + 1;
    candidate <= hardEnd && candidate < tokens.length;
    candidate += 1
  ) {
    if (
      tokens[candidate].sentenceIndex !==
      tokens[candidate - 1].sentenceIndex
    ) {
      nextIndex = candidate;
    }
  }

  const endChar =
    nextIndex < tokens.length ? tokens[nextIndex].start : fullText.length;

  return {
    startIndex: safeIndex,
    nextIndex,
    startChar,
    text: fullText.slice(startChar, endChar).trimEnd(),
  };
}

/**
 * Find the most recent Azure word boundary reached by an audio element.
 *
 * @param {Array<{ audioOffsetSeconds: number }>} boundaries
 * @param {number} currentTime
 */
export function findTimedBoundaryIndex(boundaries, currentTime) {
  let low = 0;
  let high = boundaries.length - 1;
  let best = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (boundaries[middle].audioOffsetSeconds <= currentTime) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

/**
 * Build a compact, ordered list of the first token in each sentence.
 *
 * @param {Array<{ index: number, sentenceIndex: number }>} tokens
 */
export function buildSentenceStartIndices(tokens) {
  const starts = [];
  let previousSentence = null;

  for (const token of tokens) {
    if (token.sentenceIndex === previousSentence) continue;
    starts.push(token.index);
    previousSentence = token.sentenceIndex;
  }

  return starts;
}

/**
 * Find the sentence start immediately before or after the sentence containing
 * the active token. Previous navigation clamps at the beginning; next
 * navigation returns null at the end.
 *
 * @param {number[]} sentenceStarts
 * @param {number} activeTokenIndex
 * @param {-1 | 1} direction
 */
export function findAdjacentSentenceStart(
  sentenceStarts,
  activeTokenIndex,
  direction,
) {
  if (!sentenceStarts.length) return null;

  let low = 0;
  let high = sentenceStarts.length - 1;
  let currentSentence = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (sentenceStarts[middle] <= activeTokenIndex) {
      currentSentence = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const targetSentence = currentSentence + direction;
  if (targetSentence < 0) return sentenceStarts[0];
  return sentenceStarts[targetSentence] ?? null;
}

/**
 * Return the audio offset for a token when it can be reached by seeking the
 * currently buffered chunk. Boundaries are ordered by token index.
 *
 * @param {{
 *   startIndex: number,
 *   nextIndex: number,
 *   boundaries: Array<{ tokenIndex: number, audioOffsetSeconds: number }>,
 * }} chunk
 * @param {number} targetIndex
 */
export function findBufferedSeekOffset(chunk, targetIndex) {
  if (
    targetIndex < chunk.startIndex ||
    targetIndex >= chunk.nextIndex ||
    !chunk.boundaries.length
  ) {
    return null;
  }

  let low = 0;
  let high = chunk.boundaries.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = chunk.boundaries[middle];
    if (boundary.tokenIndex === targetIndex) {
      return boundary.audioOffsetSeconds;
    }
    if (boundary.tokenIndex < targetIndex) low = middle + 1;
    else high = middle - 1;
  }

  return null;
}

const RETRYABLE_SPEECH_ERRORS = new Set([
  "interrupted",
  "audio-busy",
  "network",
  "synthesis-failed",
  "language-unavailable",
  "voice-unavailable",
  "text-too-long",
]);

/**
 * @param {string} error
 */
export function isRetryableSpeechError(error) {
  return RETRYABLE_SPEECH_ERRORS.has(error);
}

/**
 * Convert browser speech error codes into useful, Ubuntu-friendly guidance.
 *
 * @param {string} error
 * @param {boolean} [hasAvailableVoices]
 */
export function speechFailureMessage(error, hasAvailableVoices = true) {
  if (
    !hasAvailableVoices &&
    ["synthesis-failed", "language-unavailable", "voice-unavailable"].includes(
      error,
    )
  ) {
    return "Brave cannot find an Ubuntu speech voice. Enable or install one, then reload LineLight.";
  }

  switch (error) {
    case "not-allowed":
      return "Brave blocked narration. Press Play again and allow audio for this site.";
    case "synthesis-unavailable":
      return "Brave cannot find a speech engine on Ubuntu. Enable or install an Ubuntu voice, then reload LineLight.";
    case "audio-hardware":
      return "Ubuntu cannot find an audio output device. Check your sound output, then press Play again.";
    case "audio-busy":
      return "Ubuntu's audio output is busy. Close the other audio app, then press Play again.";
    case "network":
      return "This voice lost its network connection. Choose System default or another local voice.";
    default:
      return "Narration could not continue in Brave. Choose System default or another local voice.";
  }
}
