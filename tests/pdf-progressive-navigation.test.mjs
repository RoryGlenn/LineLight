import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptCurrentPdfPosition,
  isProgressivePdfHydrating,
  loadedPdfPageNumber,
  resolveProgressivePdfTarget,
  shouldDeferPdfProgressWrite,
} from "../app/pdf-progressive-navigation.mjs";

const readyManifest = {
  pdfImportStatus: "ready",
  pdfPageCount: 359,
  wordCount: 122_000,
};

test("keeps a ready stored PDF hydrating until page and token records stream", () => {
  assert.equal(isProgressivePdfHydrating(readyManifest, 1, 340), true);
  assert.equal(
    isProgressivePdfHydrating(readyManifest, 359, 122_000),
    false,
  );
});

test("retains a late outline index instead of clamping it to page one", () => {
  const pageOneTokens = Array.from({ length: 300 }, (_, index) => ({
    text: `word-${index}`,
  }));
  assert.deepEqual(
    resolveProgressivePdfTarget({
      requestedIndex: 95_000,
      tokens: pageOneTokens,
    }),
    { status: "waiting", index: null },
  );
  const completeTokens = Array.from({ length: 95_001 }, (_, index) => ({
    text: `word-${index}`,
  }));
  assert.deepEqual(
    resolveProgressivePdfTarget({
      requestedIndex: 95_000,
      tokens: completeTokens,
    }),
    { status: "resolved", index: 95_000 },
  );
});

test("waits for a bookmark's trailing context before resolving repeats", () => {
  const position = {
    tokenIndex: 4,
    anchorText: "chapter",
    contextBefore: ["the", "late"],
    contextAfter: ["target", "wins"],
  };
  const prefix = ["chapter", "starts", "the", "late", "chapter"].map(
    (text) => ({ text }),
  );
  assert.deepEqual(
    resolveProgressivePdfTarget({
      position,
      requestedIndex: position.tokenIndex,
      tokens: prefix,
    }),
    { status: "waiting", index: null },
  );
  const withContext = [...prefix, { text: "target" }, { text: "wins" }];
  assert.deepEqual(
    resolveProgressivePdfTarget({
      position,
      requestedIndex: position.tokenIndex,
      tokens: withContext,
    }),
    { status: "resolved", index: 4 },
  );
});

test("only restored progress may clamp when a changed PDF completes", () => {
  const tokens = [{ text: "one" }, { text: "two" }];
  assert.deepEqual(
    resolveProgressivePdfTarget({
      complete: true,
      requestedIndex: 20,
      tokens,
    }),
    { status: "unavailable", index: null },
  );
  assert.deepEqual(
    resolveProgressivePdfTarget({
      clampOnComplete: true,
      complete: true,
      requestedIndex: 20,
      tokens,
    }),
    { status: "resolved", index: 1 },
  );
});

test("maps late targets to loaded pages and suppresses transient zero progress", () => {
  const summaries = [
    { pageNumber: 1, wordStart: 0 },
    { pageNumber: 2, wordStart: 300 },
    { pageNumber: 3, wordStart: 650 },
  ];
  assert.equal(loadedPdfPageNumber(summaries, 700), 3);
  assert.equal(loadedPdfPageNumber(summaries, 700, 9), 9);
  const pending = { documentId: "pdf-book", targetIndex: 700 };
  assert.equal(shouldDeferPdfProgressWrite(pending, "pdf-book", 0), true);
  assert.equal(shouldDeferPdfProgressWrite(pending, "pdf-book", 700), false);
  assert.equal(shouldDeferPdfProgressWrite(pending, "other", 0), false);
});

test("explicit playback accepts the visible word and cancels a pending restore", () => {
  const pendingTarget = {
    documentId: "pdf-book",
    preserveProgress: true,
    tokenIndex: 95_000,
  };
  const pendingRestore = { documentId: "pdf-book", targetIndex: 95_000 };
  assert.deepEqual(
    acceptCurrentPdfPosition(
      pendingTarget,
      pendingRestore,
      "pdf-book",
      42,
    ),
    {
      accepted: true,
      pendingRestore: null,
      pendingTarget: null,
      progressIndex: 42,
    },
  );
  assert.equal(
    resolveProgressivePdfTarget({
      requestedIndex: pendingTarget.tokenIndex,
      tokens: Array.from({ length: 95_001 }, (_, index) => ({
        text: `word-${index}`,
      })),
      complete: true,
    }).index,
    95_000,
  );
  // The page callback reads the cleared ref, so the resolved old target is no
  // longer eligible to move narration away from the accepted visible word.
});
