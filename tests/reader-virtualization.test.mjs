import assert from "node:assert/strict";
import test from "node:test";

import {
  createFocusParagraphRenderStore,
  createPdfPageRenderStore,
  estimateParagraphHeight,
  findPageIndexForWord,
  selectVirtualizedIndices,
  selectVirtualizedRanges,
} from "../app/reader-virtualization.mjs";

test("keeps rendering bounded around visible and active PDF pages", () => {
  assert.deepEqual(selectVirtualizedIndices([10], 359, 10, 2), [8, 9, 10, 11, 12]);
  assert.deepEqual(selectVirtualizedIndices([0], 359, 0, 2), [0, 1, 2]);
  assert.deepEqual(
    selectVirtualizedIndices([100], 359, 250, 2),
    [98, 99, 100, 101, 102, 248, 249, 250, 251, 252],
  );
});

test("keeps viewport and distant active ranges mounted in document order", () => {
  assert.deepEqual(selectVirtualizedRanges(8, 10, 359, 250, 2), [
    { start: 6, end: 12 },
    { start: 248, end: 252 },
  ]);
  assert.deepEqual(selectVirtualizedRanges(8, 10, 359, 11, 2), [
    { start: 6, end: 13 },
  ]);
});

test("resolves global words to their containing PDF page", () => {
  const starts = [0, 220, 510, 510, 760];
  assert.equal(findPageIndexForWord(starts, 0), 0);
  assert.equal(findPageIndexForWord(starts, 509), 1);
  assert.equal(findPageIndexForWord(starts, 510), 3);
  assert.equal(findPageIndexForWord(starts, 9_000), 4);
});

test("notifies only PDF shells whose render state changes at a page boundary", () => {
  const store = createPdfPageRenderStore(359, 10, 2);
  const notifications = [];
  const unsubscribe = Array.from({ length: 359 }, (_, pageIndex) =>
    store.subscribe(pageIndex, () => notifications.push(pageIndex)),
  );

  assert.deepEqual(store.getRenderedPageIndices(), [8, 9, 10, 11, 12]);
  assert.deepEqual(store.setActivePageIndex(11), [8, 13]);
  assert.deepEqual(store.getRenderedPageIndices(), [9, 10, 11, 12, 13]);
  assert.deepEqual(notifications, [8, 13]);

  notifications.length = 0;
  assert.deepEqual(store.setActivePageIndex(11), []);
  assert.deepEqual(notifications, []);
  unsubscribe.forEach((removeListener) => removeListener());
});

test("adds visible PDF pages without invalidating unrelated shells", () => {
  const store = createPdfPageRenderStore(20, 10, 1);
  const notifications = [];
  const remove = [0, 1].map((pageIndex) =>
    store.subscribe(pageIndex, () => notifications.push(pageIndex)),
  );

  assert.deepEqual(store.setPageVisible(0, true), [0, 1]);
  assert.deepEqual(notifications, [0, 1]);
  assert.deepEqual(store.getRenderedPageIndices(), [0, 1, 9, 10, 11]);
  remove.forEach((unsubscribe) => unsubscribe());
});

test("notifies only Focus shells whose render state changes at a paragraph boundary", () => {
  const store = createFocusParagraphRenderStore(240, 100, 1);
  const notifications = [];
  const unsubscribe = Array.from({ length: 240 }, (_, paragraphIndex) =>
    store.subscribe(paragraphIndex, () => notifications.push(paragraphIndex)),
  );

  assert.deepEqual(store.getRenderedParagraphIndices(), [99, 100, 101]);
  assert.deepEqual(store.setActiveParagraphIndex(101), [99, 102]);
  assert.deepEqual(store.getRenderedParagraphIndices(), [100, 101, 102]);
  assert.deepEqual(notifications, [99, 102]);

  notifications.length = 0;
  assert.deepEqual(store.setActiveParagraphIndex(101), []);
  assert.deepEqual(notifications, []);
  unsubscribe.forEach((removeListener) => removeListener());
});

test("estimates stable space for virtualized Focus paragraphs", () => {
  const short = estimateParagraphHeight(40, 20, 1.5, 70, 1.4);
  const long = estimateParagraphHeight(800, 20, 1.5, 70, 1.4);
  assert.ok(short >= 58);
  assert.ok(long > short * 5);
});
