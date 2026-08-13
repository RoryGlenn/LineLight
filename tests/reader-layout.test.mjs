import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_READER_LAYOUT,
  createReaderLayoutStyle,
  deriveReadingRulerGeometry,
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

test("positions the reading ruler below the active rendered line", () => {
  assert.deepEqual(
    deriveReadingRulerGeometry({
      activeRect: {
        top: 200,
        right: 440,
        bottom: 220,
        left: 390,
        height: 20,
      },
      workspaceRect: { top: 0, right: 1000, bottom: 800, left: 0 },
      viewportRect: { top: 68, right: 1000, bottom: 800, left: 0 },
      surfaceRect: { top: 120, right: 800, bottom: 760, left: 200 },
      lineHeight: 32,
    }),
    { left: 200, top: 226, width: 600 },
  );
});

test("clips the ruler width to the visible reading surface", () => {
  assert.deepEqual(
    deriveReadingRulerGeometry({
      activeRect: {
        top: 300,
        right: 500,
        bottom: 314,
        left: 460,
        height: 14,
      },
      workspaceRect: { top: 20, right: 940, bottom: 820, left: 100 },
      viewportRect: { top: 80, right: 900, bottom: 800, left: 120 },
      surfaceRect: { top: 100, right: 950, bottom: 780, left: 80 },
      lineHeight: 1,
    }),
    { left: 20, top: 298, width: 780 },
  );
});

test("hides the reading ruler when the active word is outside the viewport", () => {
  const shared = {
    workspaceRect: { top: 0, right: 1000, bottom: 800, left: 0 },
    viewportRect: { top: 68, right: 1000, bottom: 800, left: 0 },
    surfaceRect: { top: 100, right: 800, bottom: 1000, left: 200 },
  };

  assert.equal(
    deriveReadingRulerGeometry({
      ...shared,
      activeRect: {
        top: 820,
        right: 440,
        bottom: 840,
        left: 390,
        height: 20,
      },
    }),
    null,
  );
  assert.equal(
    deriveReadingRulerGeometry({
      ...shared,
      activeRect: {
        top: Number.NaN,
        right: 440,
        bottom: 220,
        left: 390,
        height: 20,
      },
    }),
    null,
  );
});
