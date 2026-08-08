import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateParagraphHeight,
  findPageIndexForWord,
  selectVirtualizedIndices,
} from "../app/reader-virtualization.mjs";

test("keeps rendering bounded around visible and active PDF pages", () => {
  assert.deepEqual(selectVirtualizedIndices([10], 359, 10, 2), [8, 9, 10, 11, 12]);
  assert.deepEqual(selectVirtualizedIndices([0], 359, 0, 2), [0, 1, 2]);
  assert.deepEqual(
    selectVirtualizedIndices([100], 359, 250, 2),
    [98, 99, 100, 101, 102, 248, 249, 250, 251, 252],
  );
});

test("resolves global words to their containing PDF page", () => {
  const starts = [0, 220, 510, 510, 760];
  assert.equal(findPageIndexForWord(starts, 0), 0);
  assert.equal(findPageIndexForWord(starts, 509), 1);
  assert.equal(findPageIndexForWord(starts, 510), 3);
  assert.equal(findPageIndexForWord(starts, 9_000), 4);
});

test("estimates stable space for virtualized Focus paragraphs", () => {
  const short = estimateParagraphHeight(40, 20, 1.5, 70, 1.4);
  const long = estimateParagraphHeight(800, 20, 1.5, 70, 1.4);
  assert.ok(short >= 58);
  assert.ok(long > short * 5);
});
