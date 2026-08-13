import assert from "node:assert/strict";
import test from "node:test";

import {
  createPreparedNarrationExportManifest,
  createWavePartBlob,
  exportPreparedNarration,
  matchesPreparedNarrationExport,
  matchesPreparedNarrationExportAudioParts,
  parseWaveAudio,
  planPreparedNarrationExportParts,
} from "../app/prepared-narration-export.mjs";
import { encodePcm16Wave } from "../app/supertonic-runtime.mjs";

function floatWav(sampleCount = 24_000, sampleRate = 24_000) {
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
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  view.setUint32(40, sampleCount * 4, true);
  return buffer;
}

function chunk(index, overrides = {}) {
  return {
    startIndex: index * 10,
    nextIndex: (index + 1) * 10,
    audioDurationSeconds: 1,
    sourceAudioByteLength: 96_044,
    boundaries: [
      {
        audioOffsetSeconds: 0.1,
        durationSeconds: 0.2,
        tokenIndex: index * 10,
      },
    ],
    ...overrides,
  };
}

function manifestInput(parts) {
  return {
    documentId: "book-one",
    documentFingerprint: "a".repeat(64),
    title: 'Book: One / "Final"',
    author: "LineLight",
    totalTokens: 40,
    modelRevision: "revision-one",
    modelDtype: "fp16",
    voice: "af_heart",
    rate: 1,
    profileKey: "profile-one",
    parts,
    now: 100,
  };
}

test("parses and joins compatible float WAV chunks without a whole-book buffer", async () => {
  const first = floatWav();
  const second = floatWav(12_000);
  assert.equal(parseWaveAudio(first).durationSeconds, 1);
  const joined = createWavePartBlob([first, second]);
  assert.equal(joined.durationSeconds, 1.5);
  assert.equal(parseWaveAudio(await joined.blob.arrayBuffer()).durationSeconds, 1.5);
  assert.throws(
    () => createWavePartBlob([first, floatWav(12_000, 16_000)]),
    /incompatible formats/,
  );
});

test("preserves native 44.1 kHz PCM in downloaded narration parts", async () => {
  const first = encodePcm16Wave(new Float32Array(44_100).fill(0.1));
  const second = encodePcm16Wave(new Float32Array(22_050).fill(-0.1));
  const joined = createWavePartBlob([first, second]);
  const parsed = parseWaveAudio(await joined.blob.arrayBuffer());

  assert.equal(parsed.audioFormat, 1);
  assert.equal(parsed.sampleRate, 44_100);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.durationSeconds, 1.5);
});

test("plans continuous ordered export parts under duration and byte bounds", () => {
  const parts = planPreparedNarrationExportParts(
    [chunk(2), chunk(0), chunk(1), chunk(3)],
    { maxPartSeconds: 2.1, maxPartBytes: 250_000 },
  );
  assert.deepEqual(
    parts.map((part) => part.chunks.map((entry) => entry.startIndex)),
    [
      [0, 10],
      [20, 30],
    ],
  );
  assert.throws(
    () =>
      planPreparedNarrationExportParts([chunk(0), chunk(2)], {
        maxPartSeconds: 10,
      }),
    /continuous chunks/,
  );
  assert.throws(
    () =>
      planPreparedNarrationExportParts(
        [chunk(0, { sourceAudioByteLength: 300_000 })],
        { maxPartBytes: 250_000 },
      ),
    /exceeds the WAV part bound/,
  );
});

test("creates ordered portable filenames and rejects another book fingerprint", () => {
  const plans = planPreparedNarrationExportParts(
    [chunk(0), chunk(1), chunk(2), chunk(3)],
    { maxPartSeconds: 2.1 },
  );
  const manifest = createPreparedNarrationExportManifest(manifestInput(plans));
  assert.deepEqual(
    manifest.parts.map((part) => part.filename),
    ["Book One Final - part 001.wav", "Book One Final - part 002.wav"],
  );
  assert.deepEqual(
    manifest.anchors.map((entry) => [entry.partIndex, entry.timeSeconds]),
    [
      [0, 0.1],
      [0, 1.1],
      [1, 0.1],
      [1, 1.1],
    ],
  );
  assert.equal(
    matchesPreparedNarrationExport(manifest, {
      documentId: "book-one",
      documentFingerprint: "a".repeat(64),
      totalTokens: 40,
    }),
    true,
  );
  assert.equal(
    matchesPreparedNarrationExport(manifest, {
      documentId: "book-one",
      documentFingerprint: "b".repeat(64),
      totalTokens: 40,
    }),
    false,
  );
  assert.equal(
    matchesPreparedNarrationExport(
      {
        ...manifest,
        parts: manifest.parts.map((part, index) =>
          index === 0 ? { ...part, startIndex: 1 } : part,
        ),
      },
      {
        documentId: "book-one",
        documentFingerprint: "a".repeat(64),
        totalTokens: 40,
      },
    ),
    false,
  );
  assert.equal(
    matchesPreparedNarrationExportAudioParts(manifest, [
      {
        name: manifest.parts[0].filename,
        durationSeconds: manifest.parts[0].durationSeconds + 0.25,
      },
      {
        name: manifest.parts[1].filename,
        durationSeconds: manifest.parts[1].durationSeconds - 0.25,
      },
    ]),
    true,
  );
  assert.equal(
    matchesPreparedNarrationExportAudioParts(manifest, [
      {
        name: manifest.parts[0].filename,
        durationSeconds: manifest.parts[0].durationSeconds,
      },
      {
        name: manifest.parts[1].filename,
        durationSeconds: manifest.parts[1].durationSeconds + 1,
      },
    ]),
    false,
  );
});

test("exports only one bounded part at a time and cancellation preserves source chunks", async () => {
  const chunks = [chunk(0), chunk(1), chunk(2), chunk(3)];
  const saved = [];
  let activeLoads = 0;
  let maximumLoads = 0;
  const manifest = await exportPreparedNarration({
    chunks,
    loadAudio: async () => {
      activeLoads += 1;
      maximumLoads = Math.max(maximumLoads, activeLoads);
      await Promise.resolve();
      activeLoads -= 1;
      return floatWav();
    },
    saveFile: async (filename, data, details) => {
      saved.push({ filename, size: data.size, ...details });
    },
    manifest: manifestInput(undefined),
    maxPartSeconds: 2.1,
  });
  assert.equal(maximumLoads, 1);
  assert.deepEqual(saved.map((entry) => entry.kind), ["audio", "audio", "manifest"]);
  assert.equal(manifest.parts.length, 2);

  const controller = new AbortController();
  const canceledSaved = [];
  await assert.rejects(
    exportPreparedNarration({
      chunks,
      loadAudio: async () => floatWav(),
      saveFile: async (filename, data, details) => {
        canceledSaved.push({ filename, size: data.size, ...details });
        controller.abort();
      },
      manifest: manifestInput(undefined),
      maxPartSeconds: 2.1,
      signal: controller.signal,
    }),
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(canceledSaved.length, 1);
  assert.equal(chunks.length, 4);
});
