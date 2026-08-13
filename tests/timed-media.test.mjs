import assert from "node:assert/strict";
import test from "node:test";

import {
  TIMED_MEDIA_SCHEMA_VERSION,
  findTimedMediaAnchorAtTime,
  findTimedMediaPositionForToken,
  isTimedMediaManifest,
  matchesTimedMediaDocument,
  normalizeTimedMediaAnchors,
  sanitizeTimedMediaFilename,
} from "../app/timed-media.mjs";

function anchor(overrides = {}) {
  return {
    id: "automatic-0",
    partIndex: 0,
    timeSeconds: 4,
    tokenIndex: 10,
    confidence: 0.92,
    source: "automatic",
    granularity: "phrase",
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    schemaVersion: TIMED_MEDIA_SCHEMA_VERSION,
    kind: "prepared-narration-export",
    documentId: "book-one",
    documentFingerprint: "a".repeat(64),
    title: "Book One",
    author: "Reader",
    totalTokens: 20,
    parts: [
      {
        partIndex: 0,
        filename: "Book One - part 001.wav",
        mimeType: "audio/wav",
        durationSeconds: 12,
        startIndex: 0,
        nextIndex: 20,
      },
    ],
    anchors: [anchor()],
    ...overrides,
  };
}

test("sanitizes portable media filenames and reserved device names", () => {
  assert.equal(
    sanitizeTimedMediaFilename('  A <Book>: "One" / Final.  '),
    "A Book One Final",
  );
  assert.equal(sanitizeTimedMediaFilename("CON", "book"), "book");
  assert.equal(sanitizeTimedMediaFilename("\u0000../"), "linelight");
});

test("manual timed-media anchors replace automatic anchors at one position", () => {
  const automatic = anchor();
  const manual = anchor({
    id: "manual-0",
    tokenIndex: 12,
    confidence: 1,
    source: "manual",
  });
  assert.deepEqual(normalizeTimedMediaAnchors([automatic, manual]), [manual]);
});

test("time lookup ignores weak alignment and token lookup interpolates only between anchors", () => {
  const anchors = [
    anchor({ id: "a", timeSeconds: 2, tokenIndex: 10 }),
    anchor({
      id: "weak",
      timeSeconds: 4,
      tokenIndex: 20,
      confidence: 0.4,
    }),
    anchor({ id: "b", timeSeconds: 8, tokenIndex: 30 }),
  ];
  assert.equal(findTimedMediaAnchorAtTime(anchors, 0, 5).id, "a");
  const interpolated = findTimedMediaPositionForToken(anchors, 20);
  assert.equal(interpolated.partIndex, 0);
  assert.equal(interpolated.timeSeconds, 5);
  assert.equal(interpolated.interpolated, true);

  const crossPart = findTimedMediaPositionForToken(
    [anchors[0], anchor({ id: "next", partIndex: 1, tokenIndex: 30 })],
    20,
  );
  assert.equal(crossPart.interpolated, false);

  const unmatchedGap = findTimedMediaPositionForToken(
    [
      anchor({ id: "early", timeSeconds: 2, tokenIndex: 10 }),
      anchor({ id: "late", timeSeconds: 202, tokenIndex: 610 }),
    ],
    300,
  );
  assert.equal(unmatchedGap.interpolated, false);
});

test("validates timed-media manifests against the exact local document", () => {
  const valid = manifest();
  assert.equal(isTimedMediaManifest(valid), true);
  assert.equal(
    matchesTimedMediaDocument(valid, {
      documentId: "book-one",
      documentFingerprint: "a".repeat(64),
      totalTokens: 20,
    }),
    true,
  );
  assert.equal(
    matchesTimedMediaDocument(valid, {
      documentId: "book-one",
      documentFingerprint: "b".repeat(64),
      totalTokens: 20,
    }),
    false,
  );
  assert.equal(
    isTimedMediaManifest(
      manifest({ parts: [{ ...valid.parts[0], partIndex: 2 }] }),
    ),
    false,
  );
  assert.equal(
    isTimedMediaManifest(
      manifest({ anchors: [anchor({ tokenIndex: 20 })] }),
    ),
    false,
  );
  assert.equal(
    isTimedMediaManifest(
      manifest({ anchors: [anchor({ timeSeconds: 13 })] }),
    ),
    false,
  );
});
