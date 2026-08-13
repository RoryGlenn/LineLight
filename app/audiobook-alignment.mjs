import {
  TIMED_MEDIA_CONFIDENT_THRESHOLD,
  TIMED_MEDIA_SCHEMA_VERSION,
  isTimedMediaAnchor,
  isTimedMediaManifest,
  normalizeTimedMediaAnchors,
  sanitizeTimedMediaFilename,
} from "./timed-media.mjs";

export const AUDIOBOOK_ALIGNMENT_SCHEMA_VERSION = 1;
export const AUDIOBOOK_ALIGNMENT_WINDOW_SECONDS = 30;
export const AUDIOBOOK_ALIGNMENT_WINDOW_OVERLAP_SECONDS = 3;
export const AUDIOBOOK_ALIGNMENT_MAX_PART_SECONDS = 20 * 60;
export const AUDIOBOOK_ALIGNMENT_MAX_PART_BYTES = 128 * 1024 * 1024;
export const AUDIOBOOK_ALIGNMENT_MODEL_ID =
  "onnx-community/whisper-tiny.en";
export const AUDIOBOOK_ALIGNMENT_MODEL_REVISION =
  "2575352d61be1bf7225cf8f8b268a4678025fc58";
export const AUDIOBOOK_ALIGNMENT_MODEL_ESTIMATED_BYTES = 52 * 1024 * 1024;

const AUDIOBOOK_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "m4b",
  "mp3",
  "ogg",
  "opus",
  "wav",
  "webm",
]);
const DRM_EXTENSIONS = new Set(["aa", "aax"]);
const NORMALIZED_WORD_PATTERN = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

function extension(filename) {
  return String(filename ?? "").split(".").at(-1)?.toLowerCase() ?? "";
}

/**
 * Validate only DRM-free formats the browser can plausibly decode. Audible
 * AA/AAX is rejected explicitly; LineLight never attempts DRM circumvention.
 *
 * @param {{ name?: string, type?: string, size?: number }} file
 */
export function classifyAudiobookFile(file) {
  const fileExtension = extension(file?.name);
  if (DRM_EXTENSIONS.has(fileExtension)) {
    return {
      supported: false,
      reason: "Protected Audible AA/AAX files are not supported.",
    };
  }
  const supported =
    AUDIOBOOK_EXTENSIONS.has(fileExtension) && Number(file?.size) > 0;
  return {
    supported,
    reason: supported
      ? null
      : "Choose DRM-free MP3, M4A/M4B, AAC, WAV, FLAC, Ogg, Opus, or WebM audio.",
  };
}

/**
 * Sort files in natural chapter order without reading their audio bytes.
 *
 * @param {Array<{ name: string }>} files
 */
export function sortAudiobookFiles(files) {
  return [...files].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

/**
 * Build bounded, overlapping ASR windows for independently stored audio parts.
 *
 * @param {Array<{ partIndex: number, durationSeconds: number }>} parts
 * @param {{ windowSeconds?: number, overlapSeconds?: number }} [options]
 */
export function buildAudiobookAlignmentWindows(parts, options = {}) {
  const windowSeconds = Math.max(
    5,
    Number(options.windowSeconds) || AUDIOBOOK_ALIGNMENT_WINDOW_SECONDS,
  );
  const overlapSeconds = Math.min(
    windowSeconds / 3,
    Math.max(
      0,
      Number(options.overlapSeconds) ||
        AUDIOBOOK_ALIGNMENT_WINDOW_OVERLAP_SECONDS,
    ),
  );
  const step = windowSeconds - overlapSeconds;
  const windows = [];
  for (const part of parts) {
    if (
      !Number.isInteger(part.partIndex) ||
      part.partIndex < 0 ||
      !Number.isFinite(part.durationSeconds) ||
      part.durationSeconds <= 0
    ) {
      throw new TypeError("Audiobook alignment needs valid audio durations.");
    }
    let windowIndex = 0;
    for (let startSeconds = 0; startSeconds < part.durationSeconds; startSeconds += step) {
      const endSeconds = Math.min(
        part.durationSeconds,
        startSeconds + windowSeconds,
      );
      windows.push({
        partIndex: part.partIndex,
        windowIndex,
        startSeconds,
        endSeconds,
      });
      windowIndex += 1;
      if (endSeconds === part.durationSeconds) break;
    }
  }
  return windows;
}

/** @param {unknown} text */
export function normalizeAlignmentWords(text) {
  return Array.from(
    String(text ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .matchAll(NORMALIZED_WORD_PATTERN),
    (match) => match[0].replace(/[’]/gu, "'"),
  );
}

function lcsLength(left, right) {
  let previous = new Uint16Array(right.length + 1);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = new Uint16Array(right.length + 1);
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current[rightIndex + 1] =
        left[leftIndex] === right[rightIndex]
          ? previous[rightIndex] + 1
          : Math.max(previous[rightIndex + 1], current[rightIndex]);
    }
    previous = current;
  }
  return previous[right.length];
}

function scoreCandidate(transcriptWords, bookWords, start, length) {
  const slice = bookWords.slice(start, start + length);
  if (!slice.length) return 0;
  const orderedMatches = lcsLength(transcriptWords, slice);
  return orderedMatches / Math.max(transcriptWords.length, slice.length);
}

/**
 * Align bounded local transcript segments to the book token stream. Confidence
 * is sequence evidence, not audio-duration guesswork. Weak matches remain
 * explicit unmatched regions and never become playback anchors.
 *
 * @param {Array<{ id?: string, partIndex: number, startSeconds: number, endSeconds: number, text: string }>} segments
 * @param {Array<{ index: number, text: string }>} tokens
 * @param {{ minimumScore?: number, confidentThreshold?: number }} [options]
 */
export function alignAudiobookTranscriptSegments(
  segments,
  tokens,
  options = {},
) {
  const minimumScore = Math.min(
    1,
    Math.max(0, Number(options.minimumScore) || 0.5),
  );
  const confidentThreshold = Math.min(
    1,
    Math.max(
      minimumScore,
      Number(options.confidentThreshold) || TIMED_MEDIA_CONFIDENT_THRESHOLD,
    ),
  );
  const bookWords = tokens.map((token) => normalizeAlignmentWords(token.text)[0] ?? "");
  const positionsByWord = new Map();
  for (let index = 0; index < bookWords.length; index += 1) {
    const word = bookWords[index];
    if (!word) continue;
    const positions = positionsByWord.get(word) ?? [];
    positions.push(index);
    positionsByWord.set(word, positions);
  }

  const orderedSegments = [...segments].sort(
    (left, right) =>
      left.partIndex - right.partIndex ||
      left.startSeconds - right.startSeconds,
  );
  const results = [];
  const anchors = [];
  let searchFloor = 0;
  let unmatchedRun = 0;
  let longestUnmatchedRun = 0;

  for (let segmentIndex = 0; segmentIndex < orderedSegments.length; segmentIndex += 1) {
    const segment = orderedSegments[segmentIndex];
    const transcriptWords = normalizeAlignmentWords(segment.text);
    const candidateVotes = new Map();
    if (transcriptWords.length >= 2) {
      for (let wordIndex = 0; wordIndex < transcriptWords.length; wordIndex += 1) {
        const positions = positionsByWord.get(transcriptWords[wordIndex]) ?? [];
        if (positions.length > 500) continue;
        for (const position of positions) {
          if (position < Math.max(0, searchFloor - 40)) continue;
          if (position > searchFloor + 6_000) break;
          const start = Math.max(0, position - wordIndex);
          candidateVotes.set(start, (candidateVotes.get(start) ?? 0) + 1);
        }
      }
    }
    candidateVotes.set(searchFloor, (candidateVotes.get(searchFloor) ?? 0) + 1);
    const candidates = Array.from(candidateVotes.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 24)
      .map(([start]) => start);

    let best = { score: 0, start: searchFloor, length: transcriptWords.length };
    for (const start of candidates) {
      for (const scale of [0.8, 0.9, 1, 1.1, 1.2]) {
        const length = Math.max(1, Math.round(transcriptWords.length * scale));
        const score = scoreCandidate(transcriptWords, bookWords, start, length);
        const backwardsPenalty = start + length < searchFloor ? 0.2 : 0;
        if (score - backwardsPenalty > best.score) {
          best = { score: score - backwardsPenalty, start, length };
        }
      }
    }

    const confidence = Math.max(0, Math.min(1, best.score));
    const matched =
      transcriptWords.length >= 2 && confidence >= minimumScore;
    const tokenIndex = matched ? (tokens[best.start]?.index ?? null) : null;
    const result = {
      id: segment.id ?? `segment-${segment.partIndex}-${segmentIndex}`,
      partIndex: segment.partIndex,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      text: segment.text,
      tokenIndex,
      confidence,
      status: matched
        ? confidence >= confidentThreshold
          ? "confident"
          : "tentative"
        : "unmatched",
    };
    results.push(result);
    if (matched && tokenIndex !== null) {
      searchFloor = Math.max(searchFloor, best.start + best.length);
      unmatchedRun = 0;
      if (confidence >= confidentThreshold) {
        anchors.push({
          id: `automatic-${segment.partIndex}-${segmentIndex}`,
          partIndex: segment.partIndex,
          timeSeconds: segment.startSeconds,
          tokenIndex,
          confidence,
          source: "automatic",
          granularity: "phrase",
        });
      }
    } else {
      unmatchedRun += 1;
      longestUnmatchedRun = Math.max(longestUnmatchedRun, unmatchedRun);
    }
  }

  const confidentSegments = results.filter(
    (result) => result.status === "confident",
  ).length;
  const matchedSegments = results.filter(
    (result) => result.status !== "unmatched",
  ).length;
  const confidence = results.length ? confidentSegments / results.length : 0;
  return {
    segments: results,
    anchors,
    summary: {
      confidence,
      confidentSegments,
      matchedSegments,
      totalSegments: results.length,
      longestUnmatchedRun,
      mismatchLikely:
        results.length >= 4 &&
        (confidence < 0.5 || longestUnmatchedRun >= 4),
    },
  };
}

/**
 * Mix decoded channels and resample a bounded window for Whisper's 16 kHz
 * input without sending the full audiobook through a worker message.
 *
 * @param {Float32Array[]} channels
 * @param {number} sourceRate
 * @param {number} [targetRate]
 */
export function resampleAudiobookWindow(
  channels,
  sourceRate,
  targetRate = 16_000,
) {
  if (
    !Array.isArray(channels) ||
    !channels.length ||
    channels.some((channel) => !(channel instanceof Float32Array)) ||
    !Number.isFinite(sourceRate) ||
    sourceRate <= 0 ||
    !Number.isFinite(targetRate) ||
    targetRate <= 0
  ) {
    throw new TypeError("Audiobook alignment needs decoded PCM audio.");
  }
  const inputLength = Math.min(...channels.map((channel) => channel.length));
  const mono = new Float32Array(inputLength);
  for (let index = 0; index < inputLength; index += 1) {
    let sample = 0;
    for (const channel of channels) sample += channel[index];
    mono[index] = sample / channels.length;
  }
  if (sourceRate === targetRate) return mono;
  const outputLength = Math.max(
    1,
    Math.round((inputLength * targetRate) / sourceRate),
  );
  const output = new Float32Array(outputLength);
  const scale = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * scale;
    const lower = Math.min(inputLength - 1, Math.floor(sourcePosition));
    const upper = Math.min(inputLength - 1, lower + 1);
    const fraction = sourcePosition - lower;
    output[index] = mono[lower] * (1 - fraction) + mono[upper] * fraction;
  }
  return output;
}

/**
 * Create the local audiobook record before alignment begins.
 *
 * @param {{
 *   documentId: string,
 *   documentFingerprint: string,
 *   title: string,
 *   author: string,
 *   totalTokens: number,
 *   audioId: string,
 *   files: Array<{ name: string, type: string, size: number, durationSeconds: number }>,
 *   now?: number,
 * }} input
 */
export function createAudiobookManifest(input) {
  const parts = input.files.map((file, partIndex) => ({
    partIndex,
    filename: sanitizeTimedMediaFilename(file.name, `part-${partIndex + 1}`),
    mimeType: file.type || "application/octet-stream",
    durationSeconds: file.durationSeconds,
    sourceByteLength: file.size,
    startIndex: 0,
    nextIndex: input.totalTokens,
  }));
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  return {
    schemaVersion: TIMED_MEDIA_SCHEMA_VERSION,
    audiobookSchemaVersion: AUDIOBOOK_ALIGNMENT_SCHEMA_VERSION,
    kind: "audiobook-alignment",
    documentId: input.documentId,
    documentFingerprint: input.documentFingerprint,
    title: input.title,
    author: input.author,
    totalTokens: input.totalTokens,
    audioId: input.audioId,
    modelId: AUDIOBOOK_ALIGNMENT_MODEL_ID,
    modelRevision: AUDIOBOOK_ALIGNMENT_MODEL_REVISION,
    parts,
    anchors: [],
    status: "attached",
    nextPartIndex: 0,
    nextWindowIndex: 0,
    processedWindows: 0,
    totalWindows: buildAudiobookAlignmentWindows(parts).length,
    alignmentConfidence: 0,
    mismatchLikely: false,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** @param {unknown} value */
export function isAudiobookManifest(value) {
  if (!isTimedMediaManifest(value)) return false;
  const manifest = /** @type {Record<string, any>} */ (value);
  return Boolean(
    manifest.kind === "audiobook-alignment" &&
      manifest.audiobookSchemaVersion === AUDIOBOOK_ALIGNMENT_SCHEMA_VERSION &&
      typeof manifest.audioId === "string" &&
      Boolean(manifest.audioId) &&
      manifest.modelId === AUDIOBOOK_ALIGNMENT_MODEL_ID &&
      manifest.modelRevision === AUDIOBOOK_ALIGNMENT_MODEL_REVISION &&
      manifest.parts.every(
        (part) =>
          Number.isFinite(part.sourceByteLength) && part.sourceByteLength > 0,
      ) &&
      ["attached", "aligning", "paused", "ready", "error"].includes(
        manifest.status,
      ) &&
      Number.isInteger(manifest.nextPartIndex) &&
      manifest.nextPartIndex >= 0 &&
      Number.isInteger(manifest.nextWindowIndex) &&
      manifest.nextWindowIndex >= 0 &&
      Number.isInteger(manifest.processedWindows) &&
      manifest.processedWindows >= 0 &&
      Number.isInteger(manifest.totalWindows) &&
      manifest.totalWindows >= manifest.processedWindows &&
      Number.isFinite(manifest.alignmentConfidence) &&
      manifest.alignmentConfidence >= 0 &&
      manifest.alignmentConfidence <= 1 &&
      typeof manifest.mismatchLikely === "boolean" &&
      (manifest.error === null || typeof manifest.error === "string") &&
      Number.isFinite(manifest.createdAt) &&
      Number.isFinite(manifest.updatedAt),
  );
}

/** @param {unknown} value */
export function isAudiobookTranscriptWindow(value) {
  if (!value || typeof value !== "object") return false;
  const window = /** @type {Record<string, any>} */ (value);
  return Boolean(
    window.schemaVersion === AUDIOBOOK_ALIGNMENT_SCHEMA_VERSION &&
      typeof window.documentId === "string" &&
      Boolean(window.documentId) &&
      typeof window.audioId === "string" &&
      Boolean(window.audioId) &&
      Number.isInteger(window.partIndex) &&
      window.partIndex >= 0 &&
      Number.isInteger(window.windowIndex) &&
      window.windowIndex >= 0 &&
      Number.isFinite(window.startSeconds) &&
      window.startSeconds >= 0 &&
      Number.isFinite(window.endSeconds) &&
      window.endSeconds > window.startSeconds &&
      typeof window.text === "string" &&
      Array.isArray(window.segments) &&
      window.segments.every(
        (segment) =>
          segment &&
          typeof segment === "object" &&
          Number.isFinite(segment.startSeconds) &&
          Number.isFinite(segment.endSeconds) &&
          segment.endSeconds >= segment.startSeconds &&
          typeof segment.text === "string",
      ) &&
      window.modelRevision === AUDIOBOOK_ALIGNMENT_MODEL_REVISION &&
      Number.isFinite(window.createdAt),
  );
}

/**
 * Merge automatic results with durable manual corrections and derive an honest
 * manifest summary.
 *
 * @param {unknown} manifestValue
 * @param {{ anchors: unknown[], summary: { confidence: number, mismatchLikely: boolean }, complete: boolean, nextPartIndex: number, nextWindowIndex: number, processedWindows: number, now?: number }} update
 */
export function updateAudiobookAlignmentManifest(manifestValue, update) {
  if (!isAudiobookManifest(manifestValue)) {
    throw new TypeError("This audiobook manifest is invalid.");
  }
  const manifest = /** @type {Record<string, any>} */ (manifestValue);
  const manual = manifest.anchors.filter(
    (anchor) => isTimedMediaAnchor(anchor) && anchor.source === "manual",
  );
  const anchors = normalizeTimedMediaAnchors([...update.anchors, ...manual]);
  return {
    ...manifest,
    anchors,
    status: update.complete ? "ready" : "aligning",
    nextPartIndex: update.nextPartIndex,
    nextWindowIndex: update.nextWindowIndex,
    processedWindows: update.processedWindows,
    alignmentConfidence: update.summary.confidence,
    mismatchLikely: update.summary.mismatchLikely,
    error: null,
    updatedAt: Number.isFinite(update.now) ? update.now : Date.now(),
  };
}
