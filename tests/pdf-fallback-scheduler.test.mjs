import assert from "node:assert/strict";
import test from "node:test";

import { createPdfFallbackScheduler } from "../app/pdf-fallback-scheduler.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("serializes fallback renders and prioritizes the nearest visible page", async () => {
  const scheduler = createPdfFallbackScheduler();
  const starts = [];
  const firstRelease = deferred();
  const first = scheduler.schedule({
    key: "page-1",
    visible: true,
    distance: 0,
    async run() {
      starts.push("page-1");
      await firstRelease.promise;
      return "one";
    },
  });
  const far = scheduler.schedule({
    key: "page-8",
    distance: 7,
    async run() {
      starts.push("page-8");
      return "far";
    },
  });
  const near = scheduler.schedule({
    key: "page-2",
    visible: true,
    distance: 0,
    async run() {
      starts.push("page-2");
      return "near";
    },
  });

  await Promise.resolve();
  assert.deepEqual(starts, ["page-1"]);
  firstRelease.resolve();
  assert.equal(await first.promise, "one");
  assert.equal(await near.promise, "near");
  assert.equal(await far.promise, "far");
  assert.deepEqual(starts, ["page-1", "page-2", "page-8"]);
  assert.deepEqual(scheduler.getState(), { activeKey: null, queuedKeys: [] });
});

test("drops queued work when its page becomes invisible", async () => {
  const scheduler = createPdfFallbackScheduler();
  const release = deferred();
  const first = scheduler.schedule({
    key: "page-1",
    run: () => release.promise,
  });
  let secondStarted = false;
  const second = scheduler.schedule({
    key: "page-2",
    run() {
      secondStarted = true;
    },
  });
  second.cancel();
  await assert.rejects(second.promise, { name: "AbortError" });
  release.resolve();
  await first.promise;
  assert.equal(secondStarted, false);
});

test("aborts active work before starting the next page", async () => {
  const scheduler = createPdfFallbackScheduler();
  const first = scheduler.schedule({
    key: "page-1",
    run(signal) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const second = scheduler.schedule({
    key: "page-2",
    run: async () => "recovered",
  });
  first.cancel();
  await assert.rejects(first.promise);
  assert.equal(await second.promise, "recovered");
  scheduler.dispose();
});
