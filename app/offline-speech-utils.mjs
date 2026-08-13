const WORD_PATTERN =
  /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;
const PRONOUNCED_SYMBOL_PATTERN = /[\p{L}\p{M}]/gu;

/**
 * Identify failures that should advance the ONNX backend ladder. WebGPU model
 * operations treat every exception as backend-specific in the worker; this
 * classifier also catches ordinary WASM runtime failures whose names omit the
 * words ONNX or WASM.
 *
 * @param {unknown} error
 */
export function isOfflineBackendRuntimeFailure(error) {
  const name = error instanceof Error ? error.name : "";
  let message = error instanceof Error ? error.message : String(error);
  if (error && typeof error === "object") {
    try {
      message = `${message} ${JSON.stringify(error)}`;
    } catch {
      // String(error) remains available for non-serializable runtime values.
    }
  }
  return /(?:adapter|allocat(?:e|ion).*memory|backend|bad_alloc|compileerror|compute\s*pipeline|device\s*lost|failed\s+to\s+create\s+(?:a\s+)?session|gpu|kernel|linkerror|memory\s+access\s+out\s+of\s+bounds|onnx|operationerror|operator|ort\b|out\s+of\s+memory|runtimeerror|runtime\s*session|shader|tensor|wasm|webassembly)/iu.test(
    `${name} ${message}`,
  );
}

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

/**
 * Build one eSpeak request that still returns one output entry per source word.
 * Semicolons are sentence boundaries to eSpeak, so the phonemizer preserves the
 * entry boundaries without paying its call overhead once per word.
 *
 * @param {Array<{ text: string }>} words
 */
export function buildWordPhonemeBatch(words) {
  return words.map((word) => word.text).join("; ");
}

/**
 * Convert a batched phonemizer response into one weight per source word.
 * Fall back to source-character weights if eSpeak ever merges or omits an
 * entry; approximate highlighting is preferable to repeating the expensive
 * per-word phonemizer calls.
 *
 * @param {Array<{ text: string }>} words
 * @param {string[]} phonemeEntries
 */
export function countBatchedWordPhonemes(words, phonemeEntries) {
  if (phonemeEntries.length === words.length) {
    return phonemeEntries.map(countPronouncedSymbols);
  }

  return words.map((word) =>
    Math.max(1, Array.from(word.text.matchAll(/[\p{L}\p{N}]/gu)).length),
  );
}

/**
 * Reject empty, silent, or non-finite model output before it is serialized as
 * a WAV. Some ONNX backends can complete successfully while returning NaN
 * samples, which media elements otherwise treat as playable silence.
 *
 * @param {ArrayLike<number> | undefined | null} samples
 * @param {number} samplingRate
 */
export function hasUsableOfflineAudio(samples, samplingRate) {
  if (
    !samples ||
    samples.length === 0 ||
    !Number.isFinite(samplingRate) ||
    samplingRate <= 0
  ) {
    return false;
  }

  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number(samples[index]);
    if (!Number.isFinite(sample)) return false;
    peak = Math.max(peak, Math.abs(sample));
  }
  return peak > 0.000001;
}

/**
 * Add a lexical-free context token when inference returns invalid audio.
 * The leading comma is not a spoken word, while it changes the tokenizer shape
 * that can occasionally produce non-finite WASM output for short fragments.
 *
 * @param {string} text
 */
export function buildOfflineAudioRecoveryText(text) {
  return `, ${text.trimStart()}`;
}

const OFFLINE_AUDIO_RECOVERY_PREFIXES = Object.freeze([
  ",",
  "...",
]);

/**
 * Build a bounded set of lexical-free tokenizer shapes for a waveform that
 * failed validation. Punctuation changes the token/style shape without adding
 * a spoken word. Keep the original first, prefer the previously proven
 * comma recovery, then use three ASCII stops to select a genuinely different
 * token-count/style row. A Set keeps exact candidate strings unique if
 * strategies ever converge.
 *
 * @param {string} text
 */
export function buildOfflineAudioRecoveryTexts(text) {
  const trimmedText = text.trimStart();
  return Array.from(
    new Set([
      text,
      buildOfflineAudioRecoveryText(text),
      ...OFFLINE_AUDIO_RECOVERY_PREFIXES.slice(1).map(
        (prefix) => `${prefix} ${trimmedText}`,
      ),
    ]),
  );
}

export class InvalidOfflineAudioError extends Error {
  constructor() {
    super("The offline voice runtime generated invalid audio samples.");
    this.name = "InvalidOfflineAudioError";
  }
}

/**
 * Decide whether a thrown synthesis failure belongs to the ONNX backend
 * ladder. Invalid waveform exhaustion is a deterministic request result, not
 * a crashed runtime: replaying the same graph in a fresh worker or at a
 * different WASM thread count is expensive and does not repair that token
 * shape.
 *
 * @param {unknown} error
 * @param {"webgpu" | "wasm"} device
 */
export function shouldRetryOfflineSpeechBackend(error, device) {
  if (error instanceof InvalidOfflineAudioError) return false;
  return device === "webgpu" || isOfflineBackendRuntimeFailure(error);
}

/**
 * Validate every model result before playback. If inference produces non-finite or
 * silent samples for a short tokenizer shape, try a bounded, deduplicated set
 * of lexical-free punctuation contexts. No corrupt waveform is ever accepted.
 *
 * @template {{ audio: ArrayLike<number>, sampling_rate: number }} T
 * @param {string} text
 * @param {(text: string) => Promise<T>} generate
 * @returns {Promise<T>}
 */
export async function generateUsableOfflineAudio(text, generate) {
  for (const candidate of buildOfflineAudioRecoveryTexts(text)) {
    const result = await generate(candidate);
    if (hasUsableOfflineAudio(result.audio, result.sampling_rate)) {
      return result;
    }
  }
  throw new InvalidOfflineAudioError();
}

/**
 * Measure the waveform onset used for approximate word highlighting. Recovery
 * punctuation can add a short silent lead-in, so a fixed 80 ms estimate would
 * highlight the first word noticeably before it is spoken.
 *
 * @param {ArrayLike<number>} samples
 * @param {number} samplingRate
 * @param {number} [threshold]
 */
export function measureOfflineAudioLeadIn(
  samples,
  samplingRate,
  threshold,
) {
  if (!samples?.length || !Number.isFinite(samplingRate) || samplingRate <= 0) {
    return 0;
  }
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.abs(Number(samples[index]));
    if (Number.isFinite(sample)) peak = Math.max(peak, sample);
  }
  const audibleThreshold = Number.isFinite(threshold)
    ? Math.max(0, threshold)
    : Math.max(0.005, peak * 0.01);
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(Number(samples[index])) >= audibleThreshold) {
      return index / samplingRate;
    }
  }
  return 0;
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
 * phoneme count for every source word. The speech graph does not expose
 * forced-alignment timestamps, so this keeps highlighting synchronized
 * without pretending the estimates are exact model boundaries.
 *
 * @param {string} text
 * @param {number} audioDurationSeconds
 * @param {number[]} phonemeCounts
 * @param {{ leadingSilenceSeconds?: number }} [timing]
 */
export function buildPhonemeWeightedBoundaries(
  text,
  audioDurationSeconds,
  phonemeCounts,
  timing = {},
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
  const defaultLeadingSilence = Math.min(
    0.08,
    audioDurationSeconds * 0.025,
  );
  const measuredLeadingSilence = Number(timing.leadingSilenceSeconds);
  const leadingSilence = Number.isFinite(measuredLeadingSilence)
    ? Math.min(
        Math.max(0, measuredLeadingSilence),
        audioDurationSeconds * 0.5,
      )
    : defaultLeadingSilence;
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
