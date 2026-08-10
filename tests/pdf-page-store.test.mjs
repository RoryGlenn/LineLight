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

test("notifies a resubscribing listener only once per store update", () => {
  const store = createPdfPageStore();
  let notifications = 0;
  let unsubscribe = () => {};
  const listener = () => {
    notifications += 1;
    unsubscribe();
    unsubscribe = store.subscribe(listener);
  };
  unsubscribe = store.subscribe(listener);

  assert.equal(store.appendPage(page(1)), true);
  assert.equal(notifications, 1);
  assert.equal(store.getSnapshot(), 1);

  assert.equal(store.appendPage(page(2)), true);
  assert.equal(notifications, 2);
  assert.equal(store.getSnapshot(), 2);
  unsubscribe();
});

test("coalesces a burst of worker page updates into one render notification", () => {
  const scheduledNotifications = [];
  const store = createPdfPageStore({
    scheduleNotification: (callback) => scheduledNotifications.push(callback),
  });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);

  for (let pageNumber = 1; pageNumber <= 359; pageNumber += 1) {
    assert.equal(store.appendPage(page(pageNumber)), true);
  }

  assert.equal(store.getSnapshot(), 359);
  assert.equal(scheduledNotifications.length, 1);
  assert.equal(notifications, 0);
  scheduledNotifications.shift()();
  assert.equal(notifications, 1);

  assert.equal(store.setBitmap(1, { bitmap: { close() {} } }), undefined);
  assert.equal(scheduledNotifications.length, 1);
  scheduledNotifications.shift()();
  assert.equal(notifications, 2);
  unsubscribe();
});

test("bounds raster memory and closes replaced, evicted, and cleared bitmaps", () => {
  const store = createPdfPageStore({ maxBitmaps: 2 });
  const closed = [];
  const bitmap = (name, scale = 1) => ({
    bitmap: { close: () => closed.push(name) },
    height: 100 * scale,
    scale,
    width: 100 * scale,
  });
  store.setBitmap(1, bitmap("one"));
  store.setBitmap(1, bitmap("one-replaced", 2));
  store.setBitmap(2, bitmap("two"));
  store.setBitmap(3, bitmap("three"));
  assert.deepEqual(closed, ["one", "one-replaced"]);
  assert.equal(store.getBitmap(1), undefined);
  store.clear();
  assert.deepEqual(closed, ["one", "one-replaced", "two", "three"]);
});

test("keeps a sharper bitmap when a lower-resolution result arrives late", () => {
  const store = createPdfPageStore();
  const closed = [];
  let notifications = 0;
  store.subscribe(() => notifications++);
  const bitmap = (name, scale) => ({
    bitmap: { close: () => closed.push(name) },
    height: 800 * scale,
    scale,
    width: 600 * scale,
  });

  assert.equal(store.setBitmap(1, bitmap("sharp", 2)), true);
  assert.equal(store.setBitmap(1, bitmap("late-preview", 1.25)), false);
  assert.equal(store.setBitmap(1, bitmap("duplicate", 2)), false);
  assert.equal(store.getBitmap(1).scale, 2);
  assert.equal(notifications, 1);
  assert.deepEqual(closed, ["late-preview", "duplicate"]);

  assert.equal(store.setBitmap(1, bitmap("sharper", 3)), true);
  assert.equal(store.getBitmap(1).scale, 3);
  assert.equal(notifications, 2);
  assert.deepEqual(closed, ["late-preview", "duplicate", "sharp"]);
  store.clear();
});

test("bounds mixed-size bitmaps by both count and total pixels", () => {
  const store = createPdfPageStore({
    maxBitmaps: 3,
    maxBitmapPixels: 25_000,
  });
  const closed = [];
  const bitmap = (name, width, height) => ({
    bitmap: { close: () => closed.push(name) },
    height,
    scale: 1,
    width,
  });

  store.setBitmap(1, bitmap("ten-thousand", 100, 100));
  store.setBitmap(2, bitmap("six-thousand", 100, 60));
  store.setBitmap(3, bitmap("twelve-thousand", 120, 100));
  assert.equal(store.getBitmap(1), undefined);
  assert.deepEqual(store.getBitmapStats(), { count: 2, pixels: 18_000 });
  assert.deepEqual(closed, ["ten-thousand"]);

  store.setBitmap(4, bitmap("four-thousand", 80, 50));
  store.setBitmap(5, bitmap("one-thousand", 40, 25));
  assert.equal(store.getBitmap(2), undefined);
  assert.deepEqual(store.getBitmapStats(), { count: 3, pixels: 17_000 });
  assert.deepEqual(closed, ["ten-thousand", "six-thousand"]);
  store.clear();
});

test("allows only pinned overflow and evicts it as soon as a pin releases", () => {
  const store = createPdfPageStore({
    maxBitmaps: 1,
    maxBitmapPixels: 10_000,
  });
  const closed = [];
  const bitmap = (name) => ({
    bitmap: { close: () => closed.push(name) },
    height: 100,
    scale: 1,
    width: 100,
  });
  const unpinOne = store.pinBitmap(1);
  const unpinTwo = store.pinBitmap(2);
  store.setBitmap(1, bitmap("one"));
  store.setBitmap(2, bitmap("two"));
  assert.deepEqual(store.getBitmapStats(), { count: 2, pixels: 20_000 });
  assert.deepEqual(closed, []);

  unpinOne();
  assert.equal(store.getBitmap(1), undefined);
  assert.deepEqual(store.getBitmapStats(), { count: 1, pixels: 10_000 });
  assert.deepEqual(closed, ["one"]);
  unpinTwo();
  store.clear();
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
