import assert from "node:assert/strict";
import test from "node:test";

import {
  PREPARED_NARRATION_AUDIO_MIME_TYPE,
  PREPARED_NARRATION_BOOK_RETENTION,
  PREPARED_NARRATION_GZIP_ENCODING,
  PREPARED_NARRATION_IDENTITY_ENCODING,
  PREPARED_NARRATION_RECENT_RETENTION,
  PREPARED_NARRATION_SCHEMA_VERSION,
  advancePreparedNarrationManifest,
  createPreparedNarrationManifest,
  createPreparedNarrationProfileKey,
  decodePreparedNarrationAudio,
  encodePreparedNarrationAudio,
  estimatePreparedNarrationStorage,
  fingerprintPreparedNarrationText,
  isPreparedNarrationChunk,
  isPreparedNarrationManifest,
  matchesPreparedNarrationChunk,
  matchesPreparedNarrationManifest,
} from "../app/prepared-narration.mjs";

function floatWav(sampleCount = 64) {
  const buffer = new ArrayBuffer(44 + sampleCount * 4);
  const view = new DataView(buffer);
  for (const [offset, text] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ]) {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  }
  view.setUint32(4, 36 + sampleCount * 4, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  view.setUint32(40, sampleCount * 4, true);
  return buffer;
}

function chunk(overrides = {}) {
  return {
    schemaVersion: PREPARED_NARRATION_SCHEMA_VERSION,
    documentId: "book-one",
    profileKey: createPreparedNarrationProfileKey({
      modelRevision: "revision-one",
      modelDtype: "fp16",
      voice: "af_heart",
      rate: 0.9,
    }),
    startIndex: 12,
    nextIndex: 15,
    textFingerprint: "a".repeat(64),
    audioData: floatWav(),
    audioByteLength: 300,
    audioEncoding: PREPARED_NARRATION_IDENTITY_ENCODING,
    sourceAudioByteLength: 300,
    mimeType: PREPARED_NARRATION_AUDIO_MIME_TYPE,
    audioDurationSeconds: 1.25,
    boundaries: [
      {
        audioOffsetSeconds: 0.05,
        durationSeconds: 0.3,
        text: "Read",
        textOffset: 0,
        wordLength: 4,
        tokenIndex: 12,
      },
    ],
    device: "webgpu",
    modelDtype: "fp16",
    synthesisMilliseconds: 250,
    wasmThreads: null,
    retention: PREPARED_NARRATION_RECENT_RETENTION,
    createdAt: 1234,
    ...overrides,
  };
}

test("keys prepared narration by exact model, voice, and generated pace", () => {
  const base = {
    modelRevision: "revision-one",
    modelDtype: "fp16",
    voice: "af_heart",
    rate: 0.9,
  };
  const key = createPreparedNarrationProfileKey(base);

  assert.equal(key, createPreparedNarrationProfileKey({ ...base, rate: 0.9 }));
  assert.notEqual(
    key,
    createPreparedNarrationProfileKey({ ...base, voice: "af_bella" }),
  );
  assert.notEqual(
    key,
    createPreparedNarrationProfileKey({ ...base, modelDtype: "q8" }),
  );
  assert.notEqual(
    key,
    createPreparedNarrationProfileKey({ ...base, rate: 1 }),
  );
  assert.notEqual(
    createPreparedNarrationProfileKey({ ...base, rate: 0.901 }),
    createPreparedNarrationProfileKey({ ...base, rate: 0.904 }),
  );
  assert.throws(
    () => createPreparedNarrationProfileKey({ ...base, rate: 3 }),
    /valid voice profile/,
  );
});

test("fingerprints exact bounded narration text without retaining it", async () => {
  assert.equal(
    await fingerprintPreparedNarrationText("Read this exact passage."),
    "7af0158b81660c2b8d68a1be399db12d1b3ef6b4492964f89088bfc13f3d75a6",
  );
  assert.notEqual(
    await fingerprintPreparedNarrationText("Read this exact passage."),
    await fingerprintPreparedNarrationText("Read this changed passage."),
  );
});

test("compresses and restores independently playable prepared WAV chunks", async () => {
  const original = floatWav(8_000);
  const encoded = await encodePreparedNarrationAudio(original);
  assert.ok(
    [
      PREPARED_NARRATION_GZIP_ENCODING,
      PREPARED_NARRATION_IDENTITY_ENCODING,
    ].includes(encoded.audioEncoding),
  );
  const stored = chunk({
    ...encoded,
    retention: PREPARED_NARRATION_BOOK_RETENTION,
  });
  const restored = await decodePreparedNarrationAudio(stored);
  assert.deepEqual(new Uint8Array(restored), new Uint8Array(original));
  class BrokenCompressionStream {
    constructor() {
      throw new Error("compression unavailable");
    }
  }
  const fallback = await encodePreparedNarrationAudio(
    original,
    BrokenCompressionStream,
  );
  assert.equal(fallback.audioEncoding, PREPARED_NARRATION_IDENTITY_ENCODING);
  assert.equal(fallback.audioData, original);
});

test("tracks resumable whole-book preparation without marking partial work ready", () => {
  const profileKey = createPreparedNarrationProfileKey({
    modelRevision: "revision-one",
    modelDtype: "fp16",
    voice: "af_heart",
    rate: 1,
  });
  const manifest = createPreparedNarrationManifest({
    documentId: "book-one",
    documentFingerprint: "d".repeat(64),
    profileKey,
    modelRevision: "revision-one",
    modelDtype: "fp16",
    voice: "af_heart",
    rate: 1,
    totalTokens: 30,
    now: 10,
  });
  assert.equal(isPreparedNarrationManifest(manifest), true);
  assert.equal(manifest.status, "paused");
  assert.equal(
    matchesPreparedNarrationManifest(manifest, {
      documentId: "book-one",
      documentFingerprint: "d".repeat(64),
      profileKey,
      totalTokens: 30,
    }),
    true,
  );

  const first = chunk({
    profileKey,
    startIndex: 0,
    nextIndex: 15,
    boundaries: [
      {
        audioOffsetSeconds: 0,
        durationSeconds: 0.2,
        text: "Read",
        textOffset: 0,
        wordLength: 4,
        tokenIndex: 0,
      },
    ],
    retention: PREPARED_NARRATION_BOOK_RETENTION,
  });
  const partial = advancePreparedNarrationManifest(manifest, first, 20);
  assert.equal(partial.status, "preparing");
  assert.equal(partial.nextIndex, 15);

  const finalChunk = chunk({
    profileKey,
    startIndex: 15,
    nextIndex: 30,
    boundaries: [
      {
        audioOffsetSeconds: 0,
        durationSeconds: 0.2,
        text: "Finish",
        textOffset: 0,
        wordLength: 6,
        tokenIndex: 15,
      },
    ],
    retention: PREPARED_NARRATION_BOOK_RETENTION,
  });
  const ready = advancePreparedNarrationManifest(partial, finalChunk, 30);
  assert.equal(ready.status, "ready");
  assert.equal(ready.nextIndex, 30);
  assert.throws(
    () => advancePreparedNarrationManifest(manifest, finalChunk),
    /book order/,
  );
});

test("estimates preparation storage from remaining words and selected pace", () => {
  const normal = estimatePreparedNarrationStorage({
    remainingTokens: 900,
    rate: 1,
  });
  const faster = estimatePreparedNarrationStorage({
    remainingTokens: 900,
    rate: 2,
  });
  assert.equal(normal.durationSeconds, 300);
  assert.equal(faster.durationSeconds, 150);
  assert.ok(normal.estimatedBytes > faster.estimatedBytes);
});

test("accepts only complete, synchronized prepared-audio records", () => {
  const valid = chunk();
  const expected = {
    documentId: valid.documentId,
    profileKey: valid.profileKey,
    startIndex: valid.startIndex,
    nextIndex: valid.nextIndex,
    textFingerprint: valid.textFingerprint,
  };

  assert.equal(isPreparedNarrationChunk(valid), true);
  assert.equal(matchesPreparedNarrationChunk(valid, expected), true);
  assert.equal(
    matchesPreparedNarrationChunk(valid, {
      ...expected,
      textFingerprint: "b".repeat(64),
    }),
    false,
  );
  assert.equal(isPreparedNarrationChunk(chunk({ audioData: new ArrayBuffer(8) })), false);
  assert.equal(isPreparedNarrationChunk(chunk({ audioByteLength: 63 })), false);
  assert.equal(isPreparedNarrationChunk(chunk({ retention: "forever" })), false);
  assert.equal(isPreparedNarrationChunk(chunk({ nextIndex: 12 })), false);
  assert.equal(
    isPreparedNarrationChunk(
      chunk({ boundaries: [{ audioOffsetSeconds: Number.NaN }] }),
    ),
    false,
  );
});
