import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_READER_LAYOUT,
  createReaderLayoutStyle,
  normalizeReaderLayout,
  selectFocusWindowTokens,
} from "../app/reader-layout.mjs";

test("restores safe defaults and clamps persisted layout preferences", () => {
  assert.deepEqual(normalizeReaderLayout(null), DEFAULT_READER_LAYOUT);
  assert.deepEqual(
    normalizeReaderLayout({
      letterSpacing: -1,
      wordSpacing: 10,
      paragraphSpacing: 0,
      maxLineWidth: 500,
      focusLines: 2,
    }),
    {
      letterSpacing: 0,
      wordSpacing: 0.3,
      paragraphSpacing: 0.8,
      maxLineWidth: 90,
      focusLines: 0,
    },
  );
  assert.equal(normalizeReaderLayout({ focusLines: 5 }).focusLines, 5);
});

test("renders minimum and maximum supported layout values as valid CSS", () => {
  assert.deepEqual(
    createReaderLayoutStyle({
      letterSpacing: 0,
      wordSpacing: 0,
      paragraphSpacing: 0.8,
      maxLineWidth: 42,
    }),
    {
      "--reader-letter-spacing": "0.00em",
      "--reader-word-spacing": "0.00em",
      "--reader-paragraph-spacing": "0.80em",
      "--reader-measure": "42ch",
    },
  );
  assert.deepEqual(
    createReaderLayoutStyle({
      letterSpacing: 0.12,
      wordSpacing: 0.3,
      paragraphSpacing: 2.5,
      maxLineWidth: 90,
    }),
    {
      "--reader-letter-spacing": "0.12em",
      "--reader-word-spacing": "0.30em",
      "--reader-paragraph-spacing": "2.50em",
      "--reader-measure": "90ch",
    },
  );
});

test("selects one, three, or five physical lines around the active token", () => {
  const positions = Array.from({ length: 14 }, (_, tokenIndex) => ({
    tokenIndex,
    top: Math.floor(tokenIndex / 2) * 32 + (tokenIndex % 2) * 0.25,
  }));

  assert.deepEqual(selectFocusWindowTokens(positions, 6, 1), [6, 7]);
  assert.deepEqual(selectFocusWindowTokens(positions, 6, 3), [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(
    selectFocusWindowTokens(positions, 6, 5),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
});

test("keeps the requested focus window full at document boundaries", () => {
  const positions = Array.from({ length: 12 }, (_, tokenIndex) => ({
    tokenIndex,
    top: Math.floor(tokenIndex / 2) * 30,
  }));

  assert.deepEqual(
    selectFocusWindowTokens(positions, 0, 3),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    selectFocusWindowTokens(positions, 11, 3),
    [6, 7, 8, 9, 10, 11],
  );
  assert.deepEqual(
    selectFocusWindowTokens(positions, 5, 0),
    positions.map((position) => position.tokenIndex),
  );
});
