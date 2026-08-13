import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIOBOOK_ALIGNMENT_MAX_PART_BYTES,
  AUDIOBOOK_ALIGNMENT_MAX_PART_SECONDS,
  AUDIOBOOK_ALIGNMENT_MODEL_REVISION,
  alignAudiobookTranscriptSegments,
  buildAudiobookAlignmentWindows,
  classifyAudiobookFile,
  createAudiobookManifest,
  isAudiobookManifest,
  isAudiobookTranscriptWindow,
  normalizeAlignmentWords,
  resampleAudiobookWindow,
  sortAudiobookFiles,
  updateAudiobookAlignmentManifest,
} from "../app/audiobook-alignment.mjs";

function tokens(text) {
  return normalizeAlignmentWords(text).map((word, index) => ({
    index,
    text: word,
  }));
}

function attachedManifest(overrides = {}) {
  return createAudiobookManifest({
    documentId: "book-one",
    documentFingerprint: "a".repeat(64),
    title: "Book One",
    author: "LineLight",
    totalTokens: 100,
    audioId: "audio-one",
    files: [
      {
        name: "chapter-1.mp3",
        type: "audio/mpeg",
        size: 10_000,
        durationSeconds: 60,
      },
    ],
    now: 10,
    ...overrides,
  });
}

test("accepts DRM-free audiobook formats, rejects Audible DRM, and sorts chapters naturally", () => {
  assert.equal(
    classifyAudiobookFile({ name: "chapter.m4b", size: 100 }).supported,
    true,
  );
  assert.match(
    classifyAudiobookFile({ name: "protected.aax", size: 100 }).reason,
    /not supported/,
  );
  assert.deepEqual(
    sortAudiobookFiles([
      { name: "chapter 10.mp3" },
      { name: "chapter 2.mp3" },
      { name: "chapter 1.mp3" },
    ]).map((file) => file.name),
    ["chapter 1.mp3", "chapter 2.mp3", "chapter 10.mp3"],
  );
});

test("segments long chapter audio into bounded overlapping resumable windows", () => {
  assert.equal(AUDIOBOOK_ALIGNMENT_MAX_PART_SECONDS, 20 * 60);
  assert.equal(AUDIOBOOK_ALIGNMENT_MAX_PART_BYTES, 128 * 1024 * 1024);
  assert.deepEqual(
    buildAudiobookAlignmentWindows(
      [{ partIndex: 0, durationSeconds: 65 }],
      { windowSeconds: 30, overlapSeconds: 3 },
    ),
    [
      { partIndex: 0, windowIndex: 0, startSeconds: 0, endSeconds: 30 },
      { partIndex: 0, windowIndex: 1, startSeconds: 27, endSeconds: 57 },
      { partIndex: 0, windowIndex: 2, startSeconds: 54, endSeconds: 65 },
    ],
  );
});

test("aligns same-edition phrases while exposing introductions and omissions", () => {
  const book = tokens(
    "the first sentence begins our story today the second sentence keeps moving forward " +
      "the third sentence closes this short chapter gently",
  );
  const alignment = alignAudiobookTranscriptSegments(
    [
      {
        partIndex: 0,
        startSeconds: 0,
        endSeconds: 4,
        text: "publisher audio presents an unrelated introduction",
      },
      {
        partIndex: 0,
        startSeconds: 4,
        endSeconds: 9,
        text: "The first sentence begins our story today.",
      },
      {
        partIndex: 0,
        startSeconds: 9,
        endSeconds: 14,
        text: "The third sentence closes this short chapter gently.",
      },
    ],
    book,
  );
  assert.equal(alignment.segments[0].status, "unmatched");
  assert.equal(alignment.segments[1].status, "confident");
  assert.equal(alignment.segments[1].tokenIndex, 0);
  assert.equal(alignment.segments[2].status, "confident");
  assert.equal(alignment.segments[2].tokenIndex, 13);
  assert.deepEqual(
    alignment.anchors.map((anchor) => anchor.tokenIndex),
    [0, 13],
  );
});

test("flags a sustained edition mismatch instead of fabricating anchors", () => {
  const alignment = alignAudiobookTranscriptSegments(
    [0, 1, 2, 3].map((index) => ({
      partIndex: 0,
      startSeconds: index * 5,
      endSeconds: index * 5 + 5,
      text: `unrelated spoken credits number ${index}`,
    })),
    tokens("the actual book contains entirely different language throughout"),
  );
  assert.equal(alignment.anchors.length, 0);
  assert.equal(alignment.summary.mismatchLikely, true);
  assert.equal(alignment.summary.longestUnmatchedRun, 4);
});

test("resamples bounded decoded windows to mono 16 kHz", () => {
  const left = new Float32Array([0, 1, 0, -1]);
  const right = new Float32Array([0, 0.5, 0, -0.5]);
  const output = resampleAudiobookWindow([left, right], 32_000, 16_000);
  assert.equal(output.length, 2);
  assert.deepEqual(Array.from(output), [0, 0]);
  assert.throws(() => resampleAudiobookWindow([], 16_000), /decoded PCM/);
});

test("validates resumable audiobook manifests and preserves manual anchors", () => {
  const manifest = attachedManifest();
  assert.equal(isAudiobookManifest(manifest), true);
  const manual = {
    id: "manual-one",
    partIndex: 0,
    timeSeconds: 7,
    tokenIndex: 20,
    confidence: 1,
    source: "manual",
    granularity: "sentence",
  };
  const withManual = { ...manifest, anchors: [manual] };
  const updated = updateAudiobookAlignmentManifest(withManual, {
    anchors: [
      {
        id: "automatic-one",
        partIndex: 0,
        timeSeconds: 7,
        tokenIndex: 18,
        confidence: 0.9,
        source: "automatic",
        granularity: "phrase",
      },
    ],
    summary: { confidence: 0.8, mismatchLikely: false },
    complete: false,
    nextPartIndex: 0,
    nextWindowIndex: 1,
    processedWindows: 1,
    now: 20,
  });
  assert.deepEqual(updated.anchors, [manual]);
  assert.equal(updated.status, "aligning");

  assert.equal(
    isAudiobookTranscriptWindow({
      schemaVersion: 1,
      documentId: "book-one",
      audioId: "audio-one",
      partIndex: 0,
      windowIndex: 0,
      startSeconds: 0,
      endSeconds: 30,
      text: "local transcript",
      segments: [
        { startSeconds: 0, endSeconds: 4, text: "local transcript" },
      ],
      modelRevision: AUDIOBOOK_ALIGNMENT_MODEL_REVISION,
      createdAt: 20,
    }),
    true,
  );
});
