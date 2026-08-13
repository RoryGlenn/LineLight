import {
  TIMED_MEDIA_SCHEMA_VERSION,
  isTimedMediaManifest,
  matchesTimedMediaDocument,
  sanitizeTimedMediaFilename,
} from "./timed-media.mjs";

export const PREPARED_NARRATION_EXPORT_SCHEMA_VERSION = 1;
export const PREPARED_NARRATION_EXPORT_MAX_PART_SECONDS = 15 * 60;
export const PREPARED_NARRATION_EXPORT_MAX_PART_BYTES = 64 * 1024 * 1024;

function readAscii(view, offset, length) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

/**
 * Read the format and data span of a RIFF/WAVE buffer without assuming that
 * the data chunk immediately follows a 16-byte fmt chunk.
 *
 * @param {ArrayBuffer} audioData
 */
export function parseWaveAudio(audioData) {
  if (!(audioData instanceof ArrayBuffer) || audioData.byteLength < 44) {
    throw new TypeError("Narration export needs a complete WAV chunk.");
  }
  const view = new DataView(audioData);
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    throw new TypeError("Narration export received non-WAV audio.");
  }

  let format = null;
  let dataOffset = -1;
  let dataByteLength = -1;
  for (let offset = 12; offset + 8 <= view.byteLength; ) {
    const chunkId = readAscii(view, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    if (bodyOffset + chunkLength > view.byteLength) {
      throw new TypeError("Narration WAV has an incomplete chunk.");
    }
    if (chunkId === "fmt " && chunkLength >= 16) {
      format = {
        audioFormat: view.getUint16(bodyOffset, true),
        channels: view.getUint16(bodyOffset + 2, true),
        sampleRate: view.getUint32(bodyOffset + 4, true),
        byteRate: view.getUint32(bodyOffset + 8, true),
        blockAlign: view.getUint16(bodyOffset + 12, true),
        bitsPerSample: view.getUint16(bodyOffset + 14, true),
      };
    } else if (chunkId === "data") {
      dataOffset = bodyOffset;
      dataByteLength = chunkLength;
      break;
    }
    offset = bodyOffset + chunkLength + (chunkLength % 2);
  }
  if (!format || dataOffset < 0 || dataByteLength <= 0) {
    throw new TypeError("Narration WAV is missing format or audio data.");
  }
  if (
    ![1, 3].includes(format.audioFormat) ||
    format.channels <= 0 ||
    format.sampleRate <= 0 ||
    format.blockAlign <= 0 ||
    dataByteLength % format.blockAlign !== 0
  ) {
    throw new TypeError("Narration WAV uses an unsupported sample format.");
  }
  return {
    ...format,
    dataOffset,
    dataByteLength,
    durationSeconds: dataByteLength / format.byteRate,
  };
}

function waveFormatsMatch(left, right) {
  return [
    "audioFormat",
    "channels",
    "sampleRate",
    "byteRate",
    "blockAlign",
    "bitsPerSample",
  ].every((field) => left[field] === right[field]);
}

/**
 * Assemble one bounded WAV part as a Blob. The caller controls the part bound;
 * this function never creates a whole-book ArrayBuffer.
 *
 * @param {ArrayBuffer[]} audioChunks
 */
export function createWavePartBlob(audioChunks) {
  if (!audioChunks.length) {
    throw new TypeError("A narration WAV part needs at least one chunk.");
  }
  const parsed = audioChunks.map(parseWaveAudio);
  const format = parsed[0];
  if (!parsed.every((candidate) => waveFormatsMatch(format, candidate))) {
    throw new TypeError("Narration WAV chunks use incompatible formats.");
  }
  const dataByteLength = parsed.reduce(
    (total, candidate) => total + candidate.dataByteLength,
    0,
  );
  if (dataByteLength > 0xffffffff - 36) {
    throw new RangeError("This narration WAV part is too large.");
  }

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format.audioFormat, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.byteRate, true);
  view.setUint16(32, format.blockAlign, true);
  view.setUint16(34, format.bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataByteLength, true);

  const bodies = audioChunks.map(
    (audioData, index) =>
      new Uint8Array(
        audioData,
        parsed[index].dataOffset,
        parsed[index].dataByteLength,
      ),
  );
  return {
    blob: new Blob([header, ...bodies], { type: "audio/wav" }),
    byteLength: 44 + dataByteLength,
    durationSeconds: dataByteLength / format.byteRate,
    format,
  };
}

/**
 * Group ordered chunks into chapter-like bounded parts.
 *
 * @param {Array<Record<string, any>>} chunks
 * @param {{ maxPartSeconds?: number, maxPartBytes?: number }} [options]
 */
export function planPreparedNarrationExportParts(chunks, options = {}) {
  const maxPartSeconds = Math.max(
    1,
    Number(options.maxPartSeconds) ||
      PREPARED_NARRATION_EXPORT_MAX_PART_SECONDS,
  );
  const maxPartBytes = Math.max(
    45,
    Number(options.maxPartBytes) || PREPARED_NARRATION_EXPORT_MAX_PART_BYTES,
  );
  const ordered = [...chunks].sort(
    (left, right) => left.startIndex - right.startIndex,
  );
  const parts = [];
  let current = [];
  let durationSeconds = 0;
  let sourceBytes = 0;

  const commit = () => {
    if (!current.length) return;
    parts.push({
      partIndex: parts.length,
      chunks: current,
      durationSeconds,
      sourceBytes,
      startIndex: current[0].startIndex,
      nextIndex: current.at(-1).nextIndex,
    });
    current = [];
    durationSeconds = 0;
    sourceBytes = 0;
  };

  let expectedStart = 0;
  for (const chunk of ordered) {
    if (
      !Number.isInteger(chunk.startIndex) ||
      chunk.startIndex !== expectedStart ||
      !Number.isInteger(chunk.nextIndex) ||
      chunk.nextIndex <= chunk.startIndex ||
      !Number.isFinite(chunk.audioDurationSeconds) ||
      chunk.audioDurationSeconds <= 0 ||
      !Number.isFinite(chunk.sourceAudioByteLength) ||
      chunk.sourceAudioByteLength <= 44
    ) {
      throw new TypeError("Prepared narration export needs continuous chunks.");
    }
    if (
      chunk.audioDurationSeconds > maxPartSeconds ||
      chunk.sourceAudioByteLength > maxPartBytes
    ) {
      throw new RangeError(
        "One prepared narration chunk exceeds the WAV part bound.",
      );
    }
    const wouldExceed =
      current.length > 0 &&
      (durationSeconds + chunk.audioDurationSeconds > maxPartSeconds ||
        sourceBytes + chunk.sourceAudioByteLength > maxPartBytes);
    if (wouldExceed) commit();
    current.push(chunk);
    durationSeconds += chunk.audioDurationSeconds;
    sourceBytes += chunk.sourceAudioByteLength;
    expectedStart = chunk.nextIndex;
  }
  commit();
  return parts;
}

/**
 * Build the portable sidecar after part boundaries are known.
 *
 * @param {{
 *   documentId: string,
 *   documentFingerprint: string,
 *   title: string,
 *   author: string,
 *   totalTokens: number,
 *   modelRevision: string,
 *   modelDtype: string,
 *   voice: string,
 *   rate: number,
 *   profileKey: string,
 *   parts: Array<Record<string, any>>,
 *   now?: number,
 * }} input
 */
export function createPreparedNarrationExportManifest(input) {
  const baseName = sanitizeTimedMediaFilename(input.title, "LineLight book");
  const partWidth = Math.max(3, String(input.parts.length).length);
  const parts = [];
  const anchors = [];
  for (const plan of input.parts) {
    let chunkOffset = 0;
    for (const chunk of plan.chunks) {
      for (let index = 0; index < chunk.boundaries.length; index += 1) {
        const boundary = chunk.boundaries[index];
        anchors.push({
          id: `prepared-${plan.partIndex}-${chunk.startIndex}-${index}`,
          partIndex: plan.partIndex,
          timeSeconds: chunkOffset + boundary.audioOffsetSeconds,
          tokenIndex: boundary.tokenIndex,
          confidence: 1,
          source: "prepared",
          granularity: "word",
        });
      }
      chunkOffset += chunk.audioDurationSeconds;
    }
    parts.push({
      partIndex: plan.partIndex,
      filename:
        `${baseName} - part ${String(plan.partIndex + 1).padStart(
          partWidth,
          "0",
        )}.wav`,
      mimeType: "audio/wav",
      durationSeconds: plan.durationSeconds,
      startIndex: plan.startIndex,
      nextIndex: plan.nextIndex,
    });
  }
  return {
    schemaVersion: TIMED_MEDIA_SCHEMA_VERSION,
    exportSchemaVersion: PREPARED_NARRATION_EXPORT_SCHEMA_VERSION,
    kind: "prepared-narration-export",
    documentId: input.documentId,
    documentFingerprint: input.documentFingerprint,
    title: input.title,
    author: input.author,
    totalTokens: input.totalTokens,
    modelRevision: input.modelRevision,
    modelDtype: input.modelDtype,
    voice: input.voice,
    rate: input.rate,
    profileKey: input.profileKey,
    parts,
    anchors,
    createdAt: Number.isFinite(input.now) ? input.now : Date.now(),
  };
}

/** @param {unknown} value */
export function isPreparedNarrationExportManifest(value) {
  if (!isTimedMediaManifest(value)) return false;
  const manifest = /** @type {Record<string, any>} */ (value);
  let expectedStart = 0;
  for (const part of manifest.parts) {
    if (part.startIndex !== expectedStart) return false;
    expectedStart = part.nextIndex;
  }
  return Boolean(
    manifest.kind === "prepared-narration-export" &&
      manifest.exportSchemaVersion ===
        PREPARED_NARRATION_EXPORT_SCHEMA_VERSION &&
      typeof manifest.modelRevision === "string" &&
      ["fp32", "fp16", "q8"].includes(manifest.modelDtype) &&
      typeof manifest.voice === "string" &&
      Number.isFinite(manifest.rate) &&
      manifest.rate >= 0.5 &&
      manifest.rate <= 2 &&
      typeof manifest.profileKey === "string" &&
      expectedStart === manifest.totalTokens &&
      Number.isFinite(manifest.createdAt),
  );
}

/**
 * Re-import validation rejects another edition before applying any timing map.
 *
 * @param {unknown} value
 * @param {{ documentId: string, documentFingerprint: string, totalTokens: number }} expected
 */
export function matchesPreparedNarrationExport(value, expected) {
  return (
    isPreparedNarrationExportManifest(value) &&
    matchesTimedMediaDocument(value, expected)
  );
}

/**
 * Confirm that locally selected WAV parts are the exact ordered audio files
 * described by a sidecar. Browser metadata can differ by a few milliseconds,
 * so duration matching uses a small explicit tolerance instead of exact floats.
 *
 * @param {unknown} value
 * @param {Array<{ name?: string, filename?: string, durationSeconds: number }>} audioParts
 * @param {number} [durationToleranceSeconds]
 */
export function matchesPreparedNarrationExportAudioParts(
  value,
  audioParts,
  durationToleranceSeconds = 0.5,
) {
  if (
    !isPreparedNarrationExportManifest(value) ||
    !Array.isArray(audioParts) ||
    value.parts.length !== audioParts.length
  ) {
    return false;
  }
  const tolerance = Math.max(
    0,
    Number(durationToleranceSeconds) || 0,
  );
  return value.parts.every((part, index) => {
    const audioPart = audioParts[index];
    return (
      (audioPart?.name ?? audioPart?.filename) === part.filename &&
      Number.isFinite(audioPart?.durationSeconds) &&
      Math.abs(audioPart.durationSeconds - part.durationSeconds) <= tolerance
    );
  });
}

function abortIfNeeded(signal) {
  if (signal?.aborted) {
    throw new DOMException("Narration export was canceled.", "AbortError");
  }
}

/**
 * Export parts sequentially so at most one bounded part is assembled at once.
 *
 * @param {{
 *   chunks: Array<Record<string, any>>,
 *   loadAudio: (chunk: Record<string, any>, signal?: AbortSignal) => Promise<ArrayBuffer>,
 *   saveFile: (filename: string, data: Blob, details: { kind: "audio" | "manifest", partIndex?: number }) => Promise<void>,
 *   manifest: Omit<Parameters<typeof createPreparedNarrationExportManifest>[0], "parts">,
 *   signal?: AbortSignal,
 *   maxPartSeconds?: number,
 *   maxPartBytes?: number,
 *   onProgress?: (value: { completedParts: number, totalParts: number }) => void,
 * }} input
 */
export async function exportPreparedNarration(input) {
  const plans = planPreparedNarrationExportParts(input.chunks, {
    maxPartSeconds: input.maxPartSeconds,
    maxPartBytes: input.maxPartBytes,
  });
  const manifest = createPreparedNarrationExportManifest({
    ...input.manifest,
    parts: plans,
  });

  for (const plan of plans) {
    abortIfNeeded(input.signal);
    const audioChunks = [];
    for (const chunk of plan.chunks) {
      abortIfNeeded(input.signal);
      audioChunks.push(await input.loadAudio(chunk, input.signal));
    }
    abortIfNeeded(input.signal);
    const part = createWavePartBlob(audioChunks);
    await input.saveFile(manifest.parts[plan.partIndex].filename, part.blob, {
      kind: "audio",
      partIndex: plan.partIndex,
    });
    input.onProgress?.({
      completedParts: plan.partIndex + 1,
      totalParts: plans.length,
    });
  }

  abortIfNeeded(input.signal);
  const manifestName =
    `${sanitizeTimedMediaFilename(input.manifest.title, "LineLight book")}` +
    ".linelight-timing.json";
  await input.saveFile(
    manifestName,
    new Blob([JSON.stringify(manifest, null, 2)], {
      type: "application/json",
    }),
    { kind: "manifest" },
  );
  return manifest;
}
