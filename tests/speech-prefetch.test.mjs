import assert from "node:assert/strict";
import test from "node:test";

import { createSpeechPrefetchQueue } from "../app/speech-prefetch.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("keeps a bounded rolling lookahead", async () => {
  const preparations = [];
  const queue = createSpeechPrefetchQueue({
    startIndex: 0,
    endIndex: 6,
    lookahead: 2,
    buildChunk: (index) => ({ startIndex: index, nextIndex: index + 1 }),
    getNextIndex: (chunk) => chunk.nextIndex,
    prepareChunk: (chunk) => {
      const pending = deferred();
      preparations.push({ chunk, pending });
      return pending.promise;
    },
  });

  // The current chunk and two future chunks begin preparation immediately.
  await Promise.resolve();
  assert.deepEqual(
    preparations.map(({ chunk }) => chunk.startIndex),
    [0, 1, 2],
  );
  assert.equal(queue.size, 3);

  preparations[0].pending.resolve("audio-0");
  await new Promise((resolve) => setImmediate(resolve));
  const first = await queue.take();
  assert.equal(first.prepared, "audio-0");
  assert.equal(first.waited, false);
  assert.equal(queue.size, 2);

  preparations[1].pending.resolve("audio-1");
  const secondPromise = queue.take();
  await Promise.resolve();
  assert.deepEqual(
    preparations.map(({ chunk }) => chunk.startIndex),
    [0, 1, 2, 3],
  );
  assert.equal((await secondPromise).prepared, "audio-1");
  assert.equal(queue.size, 2);

  queue.dispose();
  preparations[2].pending.resolve("audio-2");
  preparations[3].pending.resolve("audio-3");
  assert.equal(queue.size, 0);
  assert.equal(await queue.take(), null);
});

test("reports whether playback had to wait for preparation", async () => {
  const pending = deferred();
  const queue = createSpeechPrefetchQueue({
    startIndex: 0,
    endIndex: 1,
    lookahead: 0,
    buildChunk: () => ({ nextIndex: 1 }),
    getNextIndex: (chunk) => chunk.nextIndex,
    prepareChunk: () => pending.promise,
  });

  const resultPromise = queue.take();
  pending.resolve("audio");
  const result = await resultPromise;

  assert.equal(result.waited, true);
  assert.equal(result.prepared, "audio");
  assert.equal(queue.exhausted, true);
});

test("rethrows preparation failures when their chunk is consumed", async () => {
  const queue = createSpeechPrefetchQueue({
    startIndex: 0,
    endIndex: 1,
    lookahead: 0,
    buildChunk: () => ({ nextIndex: 1 }),
    getNextIndex: (chunk) => chunk.nextIndex,
    prepareChunk: async () => {
      throw new Error("synthesis failed");
    },
  });

  await assert.rejects(queue.take(), /synthesis failed/);
});
