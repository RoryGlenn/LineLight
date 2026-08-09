import assert from "node:assert/strict";
import test from "node:test";

import {
  PDF_TEXT_MODEL_VERSION,
  buildPdfTextModel,
  mergePdfSentenceLineRects,
  migrateStoredPdfTextModel,
  pdfDocumentNeedsTextModelMigration,
  pdfTextParagraphs,
} from "../app/pdf-text-model.mjs";

test("keeps displayed PDF words reversibly mapped to narration tokens", () => {
  const model = buildPdfTextModel(
    [
      { text: "I like my friend", hasEOL: true },
      { text: "Tiarnán de Burca’s definition.", hasEOL: false },
    ],
    20,
  );

  assert.equal(model.wordCount, 8);
  assert.deepEqual(model.items[0].wordIndices, [20, 21, 22, 23]);
  assert.deepEqual(model.items[1].wordIndices, [24, 25, 26, 27]);
  assert.equal(
    pdfTextParagraphs(model.text).join(" "),
    "I like my friend Tiarnán de Burca’s definition.",
  );
});

test("speaks line-end hyphenation once while retaining both glyph ranges", () => {
  const model = buildPdfTextModel(
    [
      { text: "An extraordi-", hasEOL: true },
      { text: "nary outcome", hasEOL: false },
    ],
    7,
  );

  assert.match(model.text, /An extraordinary outcome/u);
  assert.equal(model.wordCount, 3);
  assert.deepEqual(model.items[0].wordIndices, [7, 8]);
  assert.deepEqual(model.items[1].wordIndices, [8, 9]);
  assert.deepEqual(
    model.items.flatMap((item) => item.words)
      .filter((word) => word.tokenIndex === 8)
      .map((word) => word.text),
    ["extraordi", "nary"],
  );
});

test("removes soft hyphens without shifting the displayed token mapping", () => {
  const model = buildPdfTextModel([
    { text: "A co\u00adoperate example", hasEOL: false },
  ]);

  assert.match(model.text, /A cooperate example/u);
  assert.equal(model.wordCount, 3);
  assert.deepEqual(model.items[0].wordIndices, [0, 1, 1, 2]);
});

test("retains a semantic hyphen while joining its uppercase continuation", () => {
  const model = buildPdfTextModel([
    { text: "Man-", hasEOL: true },
    { text: "Month matters", hasEOL: false },
  ]);

  assert.match(model.text, /Man-Month matters/u);
  assert.equal(model.wordCount, 2);
  assert.deepEqual(model.items[0].wordIndices, [0]);
  assert.deepEqual(model.items[1].wordIndices, [0, 1]);
});

test("does not join a truncated lowercase word to an uppercase page footer", () => {
  const model = buildPdfTextModel([
    { text: "professional and professio-", hasEOL: true },
    { text: "WHAT’S NEXT?", hasEOL: false },
  ]);

  assert.match(model.text, /professio-\nWHAT’S NEXT/u);
  assert.equal(model.wordCount, 5);
  assert.deepEqual(model.items[0].wordIndices, [0, 1, 2]);
  assert.deepEqual(model.items[1].wordIndices, [3, 4]);
});

test("rebuilds a legacy stored PDF from private bytes and preserves identity", async () => {
  const legacy = {
    id: "pdf-kept",
    title: "Kept title",
    author: "Kept author",
    kind: "pdf",
    paragraphs: ["extraordi nary"],
    pdfData: new Uint8Array([1, 2, 3]),
    pdfPages: [{ items: [{ wordStart: 0, wordCount: 2 }] }],
  };
  let reparsedSource;
  let saved;
  const result = await migrateStoredPdfTextModel(legacy, {
    reparse: async (source) => {
      reparsedSource = source;
      return {
        id: "discarded-reparse-id",
        paragraphs: ["extraordinary"],
        pdfPages: [{ items: [{ wordIndices: [0] }] }],
        outline: [],
      };
    },
    save: async (document) => {
      saved = document;
    },
  });

  assert.equal(pdfDocumentNeedsTextModelMigration(legacy), true);
  assert.deepEqual(reparsedSource, legacy.pdfData);
  assert.notEqual(reparsedSource, legacy.pdfData);
  assert.equal(result.migrated, true);
  assert.equal(result.document.id, legacy.id);
  assert.equal(result.document.title, legacy.title);
  assert.deepEqual(result.document.paragraphs, ["extraordinary"]);
  assert.equal(result.document.pdfTextModelVersion, PDF_TEXT_MODEL_VERSION);
  assert.equal(saved, result.document);
});

test("does not reparse current PDFs or legacy records missing source bytes", async () => {
  let calls = 0;
  const operations = {
    reparse: async () => {
      calls += 1;
      return {};
    },
    save: async () => {
      calls += 1;
    },
  };
  const current = {
    kind: "pdf",
    pdfTextModelVersion: PDF_TEXT_MODEL_VERSION,
    pdfData: new Uint8Array([1]),
  };
  const missing = { kind: "pdf", paragraphs: [] };

  assert.equal(
    (await migrateStoredPdfTextModel(current, operations)).reason,
    "current",
  );
  assert.equal(
    (await migrateStoredPdfTextModel(missing, operations)).reason,
    "missing-source",
  );
  assert.equal(calls, 0);
});

test("preserves punctuation-free PDF title lines as paragraph boundaries", () => {
  assert.deepEqual(
    pdfTextParagraphs("The Staff Engineer’s Path\nTanya Reilly\n\nChapter 1"),
    ["The Staff Engineer’s Path", "Tanya Reilly", "Chapter 1"],
  );
});

test("visual fixture: sentence overlays are continuous per printed line", () => {
  const rectangles = [
    { sentenceIndex: 3, left: 10, top: 10, width: 20, height: 9, angle: 0 },
    { sentenceIndex: 3, left: 34, top: 10.2, width: 15, height: 8.8, angle: 0 },
    { sentenceIndex: 3, left: 53, top: 10, width: 27, height: 9, angle: 0 },
    { sentenceIndex: 3, left: 10, top: 23, width: 18, height: 9, angle: 0 },
    { sentenceIndex: 3, left: 32, top: 23, width: 12, height: 9, angle: 0 },
  ];

  assert.deepEqual(mergePdfSentenceLineRects(rectangles), [
    {
      sentenceIndex: 3,
      left: 10,
      top: 10,
      width: 70,
      height: 9,
      vertical: false,
    },
    {
      sentenceIndex: 3,
      left: 10,
      top: 23,
      width: 34,
      height: 9,
      vertical: false,
    },
  ]);
});

test("visual fixture: multi-font and ligature ranges keep measured bounds", () => {
  const rectangles = [
    { sentenceIndex: 4, left: 5, top: 7, width: 12.4, height: 8, angle: 0 },
    { sentenceIndex: 4, left: 18.7, top: 6.5, width: 3.2, height: 9, angle: 0 },
    { sentenceIndex: 4, left: 23, top: 7, width: 18, height: 8, angle: 0 },
  ];

  assert.deepEqual(mergePdfSentenceLineRects(rectangles), [
    {
      sentenceIndex: 4,
      left: 5,
      top: 6.5,
      width: 36,
      height: 9,
      vertical: false,
    },
  ]);
});

test("visual fixture: aligned multi-column text remains separate", () => {
  const rectangles = [
    { sentenceIndex: 5, left: 10, top: 10, width: 20, height: 8, angle: 0 },
    { sentenceIndex: 5, left: 34, top: 10, width: 15, height: 8, angle: 0 },
    { sentenceIndex: 5, left: 140, top: 10, width: 20, height: 8, angle: 0 },
  ];

  assert.deepEqual(mergePdfSentenceLineRects(rectangles), [
    {
      sentenceIndex: 5,
      left: 10,
      top: 10,
      width: 39,
      height: 8,
      vertical: false,
    },
    {
      sentenceIndex: 5,
      left: 140,
      top: 10,
      width: 20,
      height: 8,
      vertical: false,
    },
  ]);
});

test("visual fixture: rotated words merge along their vertical line", () => {
  const rectangles = [
    { sentenceIndex: 6, left: 200, top: 10, width: 9, height: 18, angle: 90 },
    { sentenceIndex: 6, left: 200.2, top: 31, width: 8.8, height: 15, angle: 90 },
  ];

  assert.deepEqual(mergePdfSentenceLineRects(rectangles), [
    {
      sentenceIndex: 6,
      left: 200,
      top: 10,
      width: 9,
      height: 36,
      vertical: true,
    },
  ]);
});
