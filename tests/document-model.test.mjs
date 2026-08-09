import assert from "node:assert/strict";
import test from "node:test";

import { buildDocumentModel } from "../app/document-model.mjs";
import {
  createPositionSnapshot,
  resolveStoredPosition,
} from "../app/reader-navigation.mjs";
import { buildSentenceStartIndices } from "../app/speech-utils.mjs";

test("TXT and EPUB paragraph starts retain their existing sentence behavior", () => {
  const model = buildDocumentModel([
    "A punctuation-free paragraph",
    "continues in the next block",
  ]);

  assert.deepEqual(
    model.tokens.map((token) => token.sentenceIndex),
    [0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(buildSentenceStartIndices(model.tokens), [0]);
});

test("PDF structural paragraphs can start punctuation-free sentences", () => {
  const model = buildDocumentModel(
    ["The Staff Engineer’s Path", "Tanya Reilly", "Chapter 1"],
    { paragraphsStartSentences: true },
  );

  assert.deepEqual(
    model.tokens.map((token) => token.sentenceIndex),
    [0, 0, 0, 0, 1, 1, 2, 2],
  );
  assert.deepEqual(buildSentenceStartIndices(model.tokens), [0, 4, 6]);
});

test("terminal punctuation remains the sentence boundary for every format", () => {
  const model = buildDocumentModel(["First sentence.", "Second sentence."]);

  assert.deepEqual(
    model.tokens.map((token) => token.sentenceIndex),
    [0, 0, 1, 1],
  );
  assert.deepEqual(buildSentenceStartIndices(model.tokens), [0, 2]);
});

test("legacy PDF progress recovers by context after dehyphenation shifts indices", () => {
  const legacy = buildDocumentModel(["An extraordi nary outcome follows"]);
  const migrated = buildDocumentModel(["An extraordinary outcome follows"], {
    paragraphsStartSentences: true,
  });
  const savedPosition = createPositionSnapshot(legacy.tokens, 4, 0);

  assert.equal(savedPosition?.anchorText, "follows");
  assert.equal(resolveStoredPosition(savedPosition, migrated.tokens), 3);
});
