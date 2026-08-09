import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_HIGHLIGHT_SCOPE,
  HIGHLIGHT_SCOPE_OPTIONS,
  deriveActiveHighlightIndex,
  migrateReaderHighlightSettings,
  normalizeHighlightScope,
} from "../app/highlight-scope.mjs";

test("offers only sentence and paragraph as reader-facing highlight scopes", () => {
  assert.equal(DEFAULT_HIGHLIGHT_SCOPE, "sentence");
  assert.deepEqual(
    HIGHLIGHT_SCOPE_OPTIONS.map(({ value, label }) => ({ value, label })),
    [
      { value: "sentence", label: "Sentence" },
      { value: "paragraph", label: "Paragraph" },
    ],
  );
  assert.ok(
    HIGHLIGHT_SCOPE_OPTIONS.every((option) =>
      /visually steady/iu.test(option.description),
    ),
  );
});

test("migrates every legacy highlight value deterministically", () => {
  for (const legacy of ["both", "word", "sentence", "invalid", undefined]) {
    const migrated = migrateReaderHighlightSettings({
      theme: "dark",
      highlightMode: legacy,
    });
    assert.deepEqual(migrated, {
      theme: "dark",
      highlightScope: "sentence",
    });
    assert.equal("highlightMode" in migrated, false);
  }

  assert.deepEqual(migrateReaderHighlightSettings({ highlightMode: "paragraph" }), {
    highlightScope: "sentence",
  });
  assert.deepEqual(
    migrateReaderHighlightSettings({
      highlightScope: "paragraph",
      highlightMode: "word",
    }),
    { highlightScope: "paragraph" },
  );
  assert.deepEqual(
    migrateReaderHighlightSettings({
      highlightScope: "invalid",
      highlightMode: "paragraph",
    }),
    { highlightScope: "sentence" },
  );
});

test("normalizes invalid current values to sentence scope", () => {
  assert.equal(normalizeHighlightScope("sentence"), "sentence");
  assert.equal(normalizeHighlightScope("paragraph"), "paragraph");
  assert.equal(normalizeHighlightScope("both"), "sentence");
  assert.equal(normalizeHighlightScope(null), "sentence");
});

test("derives sentence or paragraph scope without changing the token index", () => {
  const tokens = [
    { sentenceIndex: 3, paragraphIndex: 1 },
    { sentenceIndex: 4, paragraphIndex: 1 },
    { sentenceIndex: 5, paragraphIndex: 2 },
  ];
  assert.equal(deriveActiveHighlightIndex(tokens, 1, "sentence"), 4);
  assert.equal(deriveActiveHighlightIndex(tokens, 1, "paragraph"), 1);
  assert.equal(deriveActiveHighlightIndex(tokens, 99, "paragraph"), 2);
  assert.equal(deriveActiveHighlightIndex([], 0, "sentence"), -1);
});
