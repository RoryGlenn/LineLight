export const PREPARED_NARRATION_SCHEMA_VERSION = 2;
export const PREPARED_NARRATION_AUDIO_MIME_TYPE = "audio/wav";
export const PREPARED_NARRATION_IDENTITY_ENCODING = "identity";
export const PREPARED_NARRATION_GZIP_ENCODING = "gzip";
export const PREPARED_NARRATION_RECENT_RETENTION = "recent";
export const PREPARED_NARRATION_BOOK_RETENTION = "prepared";
export const PREPARED_NARRATION_RECENT_MAX_ENTRIES = 24;
export const PREPARED_NARRATION_RECENT_MAX_BYTES = 48 * 1024 * 1024;
export const PREPARED_NARRATION_CHUNK_CHARACTERS = 360;
export const PREPARED_NARRATION_ESTIMATED_BYTES_PER_SECOND = 96_000;
export const PREPARED_NARRATION_ESTIMATED_COMPRESSION_RATIO = 0.78;

function isNonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function isNonNegativeFiniteNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function isPreparedBoundary(boundary) {
  return Boolean(
    boundary &&
      typeof boundary === "object" &&
      isNonNegativeFiniteNumber(boundary.audioOffsetSeconds) &&
      isNonNegativeFiniteNumber(boundary.durationSeconds) &&
      typeof boundary.text === "string" &&
      Number.isInteger(boundary.textOffset) &&
      boundary.textOffset >= 0 &&
      Number.isInteger(boundary.wordLength) &&
      boundary.wordLength > 0 &&
      Number.isInteger(boundary.tokenIndex) &&
      boundary.tokenIndex >= 0,
  );
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/**
 * Produce a stable key for narration whose generated audio is interchangeable.
 * The model dtype keeps incompatible q8 and fp16 output in separate profiles.
 *
 * @param {{ modelRevision: string, modelDtype: string, voice: string, rate: number }} profile
 */
export function createPreparedNarrationProfileKey({
  modelRevision,
  modelDtype,
  voice,
  rate,
}) {
  if (
    !isNonEmptyString(modelRevision) ||
    !isNonEmptyString(modelDtype) ||
    !isNonEmptyString(voice) ||
    !Number.isFinite(rate) ||
    rate < 0.5 ||
    rate > 2
  ) {
    throw new TypeError("Prepared narration needs a valid voice profile.");
  }
  return JSON.stringify([
    PREPARED_NARRATION_SCHEMA_VERSION,
    modelRevision,
    modelDtype,
    voice,
    Number(rate),
  ]);
}

/**
 * Fingerprint only the bounded text belonging to one audio chunk. This binds a
 * stored chunk to exact source content without persisting the whole passage a
 * second time. Word timing records may still carry their bounded source words.
 *
 * @param {string} text
 * @param {SubtleCrypto | undefined} [subtle]
 */
export async function fingerprintPreparedNarrationText(
  text,
  subtle = globalThis.crypto?.subtle,
) {
  if (typeof text !== "string" || !subtle) {
    throw new TypeError("Prepared narration text cannot be fingerprinted.");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Compress one independently playable WAV chunk for durable whole-book
 * preparation. Browsers without CompressionStream retain the original WAV;
 * playback and export use the explicit encoding field instead of guessing.
 *
 * @param {ArrayBuffer} audioData
 * @param {typeof CompressionStream | undefined} [Compression]
 */
export async function encodePreparedNarrationAudio(
  audioData,
  Compression = globalThis.CompressionStream,
) {
  if (!(audioData instanceof ArrayBuffer) || audioData.byteLength <= 44) {
    throw new TypeError("Prepared narration audio must be a complete WAV.");
  }
  if (!Compression) {
    return {
      audioData,
      audioByteLength: audioData.byteLength,
      audioEncoding: PREPARED_NARRATION_IDENTITY_ENCODING,
      sourceAudioByteLength: audioData.byteLength,
    };
  }

  let compressed;
  try {
    compressed = await new Response(
      new Blob([audioData]).stream().pipeThrough(new Compression("gzip")),
    ).arrayBuffer();
  } catch {
    return {
      audioData,
      audioByteLength: audioData.byteLength,
      audioEncoding: PREPARED_NARRATION_IDENTITY_ENCODING,
      sourceAudioByteLength: audioData.byteLength,
    };
  }
  if (compressed.byteLength >= audioData.byteLength) {
    return {
      audioData,
      audioByteLength: audioData.byteLength,
      audioEncoding: PREPARED_NARRATION_IDENTITY_ENCODING,
      sourceAudioByteLength: audioData.byteLength,
    };
  }
  return {
    audioData: compressed,
    audioByteLength: compressed.byteLength,
    audioEncoding: PREPARED_NARRATION_GZIP_ENCODING,
    sourceAudioByteLength: audioData.byteLength,
  };
}

/**
 * Restore the playable WAV bytes for a stored chunk.
 *
 * @param {unknown} value
 * @param {typeof DecompressionStream | undefined} [Decompression]
 */
export async function decodePreparedNarrationAudio(
  value,
  Decompression = globalThis.DecompressionStream,
) {
  if (!isPreparedNarrationChunk(value)) {
    throw new TypeError("This prepared narration chunk is invalid.");
  }
  const chunk = /** @type {Record<string, any>} */ (value);
  if (chunk.audioEncoding === PREPARED_NARRATION_IDENTITY_ENCODING) {
    return chunk.audioData;
  }
  if (!Decompression) {
    throw new Error("This browser cannot open compressed prepared narration.");
  }
  const restored = await new Response(
    new Blob([chunk.audioData])
      .stream()
      .pipeThrough(new Decompression("gzip")),
  ).arrayBuffer();
  if (restored.byteLength !== chunk.sourceAudioByteLength) {
    throw new Error("Prepared narration audio is incomplete.");
  }
  return restored;
}

/**
 * Estimate conservative browser storage for generated 24 kHz float32 audio.
 * This is deliberately presented as an estimate; quota is checked again for
 * every committed chunk.
 *
 * @param {{ remainingTokens: number, rate: number }} input
 */
export function estimatePreparedNarrationStorage({ remainingTokens, rate }) {
  const safeTokens = Math.max(0, Math.trunc(Number(remainingTokens) || 0));
  const safeRate = Math.min(2, Math.max(0.5, Number(rate) || 1));
  const durationSeconds = safeTokens / (3 * safeRate);
  const estimatedBytes = Math.ceil(
    durationSeconds *
      PREPARED_NARRATION_ESTIMATED_BYTES_PER_SECOND *
      PREPARED_NARRATION_ESTIMATED_COMPRESSION_RATIO *
      1.15,
  );
  return { durationSeconds, estimatedBytes };
}

/**
 * Create the durable, resumable manifest for one exact book/voice/pace.
 *
 * @param {{
 *   documentId: string,
 *   documentFingerprint: string,
 *   profileKey: string,
 *   modelRevision: string,
 *   modelDtype: string,
 *   voice: string,
 *   rate: number,
 *   totalTokens: number,
 *   now?: number,
 * }} input
 */
export function createPreparedNarrationManifest(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const manifest = {
    schemaVersion: PREPARED_NARRATION_SCHEMA_VERSION,
    kind: "offline-prepared-narration",
    documentId: input.documentId,
    documentFingerprint: input.documentFingerprint,
    profileKey: input.profileKey,
    modelRevision: input.modelRevision,
    modelDtype: input.modelDtype,
    voice: input.voice,
    rate: input.rate,
    chunkCharacters: PREPARED_NARRATION_CHUNK_CHARACTERS,
    totalTokens: input.totalTokens,
    nextIndex: 0,
    completedChunks: 0,
    storedBytes: 0,
    status: "paused",
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  if (!isPreparedNarrationManifest(manifest)) {
    throw new TypeError("Prepared narration needs a valid book manifest.");
  }
  return manifest;
}

/** @param {unknown} value */
export function isPreparedNarrationManifest(value) {
  if (!value || typeof value !== "object") return false;
  const manifest = /** @type {Record<string, any>} */ (value);
  return Boolean(
    manifest.schemaVersion === PREPARED_NARRATION_SCHEMA_VERSION &&
      manifest.kind === "offline-prepared-narration" &&
      isNonEmptyString(manifest.documentId) &&
      isSha256(manifest.documentFingerprint) &&
      isNonEmptyString(manifest.profileKey) &&
      isNonEmptyString(manifest.modelRevision) &&
      ["fp16", "q8"].includes(manifest.modelDtype) &&
      isNonEmptyString(manifest.voice) &&
      Number.isFinite(manifest.rate) &&
      manifest.rate >= 0.5 &&
      manifest.rate <= 2 &&
      manifest.chunkCharacters === PREPARED_NARRATION_CHUNK_CHARACTERS &&
      Number.isInteger(manifest.totalTokens) &&
      manifest.totalTokens > 0 &&
      Number.isInteger(manifest.nextIndex) &&
      manifest.nextIndex >= 0 &&
      manifest.nextIndex <= manifest.totalTokens &&
      Number.isInteger(manifest.completedChunks) &&
      manifest.completedChunks >= 0 &&
      isNonNegativeFiniteNumber(manifest.storedBytes) &&
      ["preparing", "paused", "ready", "error"].includes(manifest.status) &&
      (manifest.status !== "ready" ||
        manifest.nextIndex === manifest.totalTokens) &&
      (manifest.error === null || typeof manifest.error === "string") &&
      isNonNegativeFiniteNumber(manifest.createdAt) &&
      isNonNegativeFiniteNumber(manifest.updatedAt),
  );
}

/**
 * Confirm a saved manifest still describes the exact current document/profile.
 *
 * @param {unknown} value
 * @param {{ documentId: string, documentFingerprint: string, profileKey: string, totalTokens: number }} expected
 */
export function matchesPreparedNarrationManifest(value, expected) {
  if (!isPreparedNarrationManifest(value)) return false;
  const manifest = /** @type {Record<string, any>} */ (value);
  return (
    manifest.documentId === expected.documentId &&
    manifest.documentFingerprint === expected.documentFingerprint &&
    manifest.profileKey === expected.profileKey &&
    manifest.totalTokens === expected.totalTokens
  );
}

/**
 * Atomically-derived next manifest after one chunk has been committed.
 *
 * @param {unknown} value
 * @param {unknown} chunkValue
 * @param {number} [now]
 */
export function advancePreparedNarrationManifest(
  value,
  chunkValue,
  now = Date.now(),
) {
  if (!isPreparedNarrationManifest(value) || !isPreparedNarrationChunk(chunkValue)) {
    throw new TypeError("Prepared narration progress is invalid.");
  }
  const manifest = /** @type {Record<string, any>} */ (value);
  const chunk = /** @type {Record<string, any>} */ (chunkValue);
  if (
    chunk.documentId !== manifest.documentId ||
    chunk.profileKey !== manifest.profileKey ||
    chunk.startIndex !== manifest.nextIndex ||
    chunk.nextIndex > manifest.totalTokens ||
    chunk.retention !== PREPARED_NARRATION_BOOK_RETENTION
  ) {
    throw new Error("Prepared narration chunks must commit in book order.");
  }
  const ready = chunk.nextIndex === manifest.totalTokens;
  return {
    ...manifest,
    nextIndex: chunk.nextIndex,
    completedChunks: manifest.completedChunks + 1,
    storedBytes: manifest.storedBytes + chunk.audioByteLength,
    status: ready ? "ready" : "preparing",
    error: null,
    updatedAt: now,
  };
}

/**
 * Validate a durable prepared-audio record before writing or playback.
 *
 * @param {unknown} value
 */
export function isPreparedNarrationChunk(value) {
  if (!value || typeof value !== "object") return false;
  const chunk = /** @type {Record<string, any>} */ (value);
  return Boolean(
    chunk.schemaVersion === PREPARED_NARRATION_SCHEMA_VERSION &&
      isNonEmptyString(chunk.documentId) &&
      isNonEmptyString(chunk.profileKey) &&
      Number.isInteger(chunk.startIndex) &&
      chunk.startIndex >= 0 &&
      Number.isInteger(chunk.nextIndex) &&
      chunk.nextIndex > chunk.startIndex &&
      isSha256(chunk.textFingerprint) &&
      chunk.audioData instanceof ArrayBuffer &&
      chunk.audioData.byteLength > 16 &&
      chunk.audioByteLength === chunk.audioData.byteLength &&
      [
        PREPARED_NARRATION_IDENTITY_ENCODING,
        PREPARED_NARRATION_GZIP_ENCODING,
      ].includes(chunk.audioEncoding) &&
      Number.isInteger(chunk.sourceAudioByteLength) &&
      chunk.sourceAudioByteLength > 44 &&
      (chunk.audioEncoding !== PREPARED_NARRATION_IDENTITY_ENCODING ||
        chunk.sourceAudioByteLength === chunk.audioByteLength) &&
      chunk.mimeType === PREPARED_NARRATION_AUDIO_MIME_TYPE &&
      Number.isFinite(chunk.audioDurationSeconds) &&
      chunk.audioDurationSeconds > 0 &&
      Array.isArray(chunk.boundaries) &&
      chunk.boundaries.every(
        (boundary) =>
          isPreparedBoundary(boundary) &&
          boundary.tokenIndex >= chunk.startIndex &&
          boundary.tokenIndex < chunk.nextIndex,
      ) &&
      ["webgpu", "wasm"].includes(chunk.device) &&
      ["fp16", "q8"].includes(chunk.modelDtype) &&
      isNonNegativeFiniteNumber(chunk.synthesisMilliseconds) &&
      (chunk.wasmThreads === null ||
        (Number.isInteger(chunk.wasmThreads) && chunk.wasmThreads > 0)) &&
      [
        PREPARED_NARRATION_RECENT_RETENTION,
        PREPARED_NARRATION_BOOK_RETENTION,
      ].includes(chunk.retention) &&
      isNonNegativeFiniteNumber(chunk.createdAt),
  );
}

/**
 * Confirm that a valid stored record belongs to the exact requested chunk.
 *
 * @param {unknown} value
 * @param {{
 *   documentId: string,
 *   profileKey: string,
 *   startIndex: number,
 *   nextIndex: number,
 *   textFingerprint: string,
 * }} expected
 */
export function matchesPreparedNarrationChunk(value, expected) {
  if (!isPreparedNarrationChunk(value)) return false;
  const chunk = /** @type {Record<string, any>} */ (value);
  return (
    chunk.documentId === expected.documentId &&
    chunk.profileKey === expected.profileKey &&
    chunk.startIndex === expected.startIndex &&
    chunk.nextIndex === expected.nextIndex &&
    chunk.textFingerprint === expected.textFingerprint
  );
}
