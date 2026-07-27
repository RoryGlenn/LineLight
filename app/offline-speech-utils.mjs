const WORD_PATTERN =
  /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;
const PRONOUNCED_SYMBOL_PATTERN = /[\p{L}\p{M}]/gu;

/**
 * Find words and their offsets inside a synthesis passage.
 *
 * @param {string} text
 */
export function extractTimedWords(text) {
  const matches = Array.from(text.matchAll(WORD_PATTERN));

  return matches.map((match, index) => {
    const textOffset = match.index ?? 0;
    const word = match[0];
    const nextOffset = matches[index + 1]?.index ?? text.length;

    return {
      text: word,
      textOffset,
      wordLength: word.length,
      trailingText: text.slice(textOffset + word.length, nextOffset),
    };
  });
}

/**
 * Count the IPA letters and combining marks that represent pronounced sounds.
 *
 * @param {string} phonemes
 */
export function countPronouncedSymbols(phonemes) {
  const withoutProsodyMarks = phonemes.replace(/[ˈˌːˑ]/gu, "");
  return Math.max(
    1,
    Array.from(
      withoutProsodyMarks.matchAll(PRONOUNCED_SYMBOL_PATTERN),
    ).length,
  );
}

function punctuationPauseUnits(trailingText) {
  if (/[.!?]/u.test(trailingText)) return 4.5;
  if (/[\n\r]/u.test(trailingText)) return 3.5;
  if (/[;:]/u.test(trailingText)) return 3;
  if (/[,—–]/u.test(trailingText)) return 2;
  return 0;
}

/**
 * Build an estimated word timeline from the waveform's real duration and a
 * phoneme count for every source word. Kokoro's public ONNX export does not
 * expose forced-alignment timestamps, so this keeps highlighting synchronized
 * without pretending the estimates are exact model boundaries.
 *
 * @param {string} text
 * @param {number} audioDurationSeconds
 * @param {number[]} phonemeCounts
 */
export function buildPhonemeWeightedBoundaries(
  text,
  audioDurationSeconds,
  phonemeCounts,
) {
  const words = extractTimedWords(text);
  if (!words.length || audioDurationSeconds <= 0) return [];

  const weightedWords = words.map((word, index) => ({
    ...word,
    phonemeUnits: Math.max(1, Number(phonemeCounts[index]) || word.text.length),
    pauseUnits: punctuationPauseUnits(word.trailingText),
  }));
  const totalUnits = weightedWords.reduce(
    (sum, word) => sum + word.phonemeUnits + word.pauseUnits,
    0,
  );
  const leadingSilence = Math.min(0.08, audioDurationSeconds * 0.025);
  const trailingSilence = Math.min(0.06, audioDurationSeconds * 0.02);
  const timedDuration = Math.max(
    0,
    audioDurationSeconds - leadingSilence - trailingSilence,
  );
  const secondsPerUnit = timedDuration / totalUnits;
  let elapsedUnits = 0;

  return weightedWords.map((word) => {
    const boundary = {
      audioOffsetSeconds:
        leadingSilence + elapsedUnits * secondsPerUnit,
      durationSeconds: word.phonemeUnits * secondsPerUnit,
      text: word.text,
      textOffset: word.textOffset,
      wordLength: word.wordLength,
    };
    elapsedUnits += word.phonemeUnits + word.pauseUnits;
    return boundary;
  });
}
