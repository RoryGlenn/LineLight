import assert from "node:assert/strict";
import test from "node:test";

import { createPdfPageStore } from "../app/pdf-page-store.mjs";

function page(pageNumber) {
  return {
    pageNumber,
    layout: { pageNumber, width: 600, height: 800, items: [] },
    model: { wordStart: (pageNumber - 1) * 20 },
  };
}

test("selects only a bounded page range from the external store", () => {
  const store = createPdfPageStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  for (let pageNumber = 1; pageNumber <= 359; pageNumber += 1) {
    assert.equal(store.appendPage(page(pageNumber)), true);
  }
  assert.equal(store.appendPage(page(1)), false);
  assert.equal(notifications, 359);
  assert.equal(store.getSummaries().length, 359);
  assert.deepEqual(
    store.getPageRange(100, 104).map((record) => record.pageNumber),
    [101, 102, 103, 104, 105],
  );
  unsubscribe();
});

test("bounds raster memory and closes replaced, evicted, and cleared bitmaps", () => {
  const store = createPdfPageStore({ maxBitmaps: 2 });
  const closed = [];
  const bitmap = (name) => ({
    bitmap: { close: () => closed.push(name) },
    height: 100,
    scale: 1,
    width: 100,
  });
  store.setBitmap(1, bitmap("one"));
  store.setBitmap(1, bitmap("one-replaced"));
  store.setBitmap(2, bitmap("two"));
  store.setBitmap(3, bitmap("three"));
  assert.deepEqual(closed, ["one", "one-replaced"]);
  assert.equal(store.getBitmap(1), undefined);
  store.clear();
  assert.deepEqual(closed, ["one", "one-replaced", "two", "three"]);
});

test("pins mounted page bitmaps and evicts them only after unmount", () => {
  const store = createPdfPageStore({ maxBitmaps: 2 });
  const closed = [];
  const bitmap = (name) => ({
    bitmap: { close: () => closed.push(name) },
    height: 100,
    scale: 1,
    width: 100,
  });
  const unpinPageOne = store.pinBitmap(1);
  store.setBitmap(1, bitmap("one"));
  store.setBitmap(2, bitmap("two"));
  store.setBitmap(3, bitmap("three"));
  assert.ok(store.getBitmap(1), "the mounted page remains drawable");
  assert.equal(store.getBitmap(2), undefined);
  assert.deepEqual(closed, ["two"]);

  store.setBitmap(4, bitmap("four"));
  assert.ok(store.getBitmap(1));
  assert.equal(store.getBitmap(3), undefined);
  unpinPageOne();
  store.setBitmap(5, bitmap("five"));
  assert.equal(store.getBitmap(1), undefined);
  assert.deepEqual(closed, ["two", "three", "one"]);
  store.clear();
});
