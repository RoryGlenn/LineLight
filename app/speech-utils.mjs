export const SPEECH_CHUNK_CHARACTERS = 180;

/**
 * Build a small, silent PCM WAV used only to open the browser's audio output
 * path while natural narration is being generated. The samples stay at zero;
 * the non-muted media element is what prevents Chromium from deferring its
 * expensive first audio-device startup until after synthesis.
 *
 * @param {{ durationSeconds?: number, sampleRate?: number }} [options]
 */
export function createSilentPcmWav({
  durationSeconds = 15,
  sampleRate = 8_000,
} = {}) {
  const safeDuration = Math.min(
    30,
    Math.max(0.1, Number(durationSeconds) || 15),
  );
  const safeSampleRate = Math.min(
    48_000,
    Math.max(8_000, Math.floor(Number(sampleRate) || 8_000)),
  );
  const sampleCount = Math.max(
    1,
    Math.round(safeDuration * safeSampleRate),
  );
  const bytesPerSample = 2;
  const dataBytes = sampleCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, safeSampleRate, true);
  view.setUint32(28, safeSampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  return buffer;
}

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
