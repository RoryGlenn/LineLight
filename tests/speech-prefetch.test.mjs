import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createBoundedSpeechAudioCache,
  createSpeechPrefetchQueue,
} from "../app/speech-prefetch.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("starts only the current chunk before filling bounded lookahead", async () => {
  const preparations = [];
  const queue = createSpeechPrefetchQueue({
    startIndex: 0,
    endIndex: 6,
    lookahead: 2,
    buildChunk: (index) => ({ startIndex: index, nextIndex: index + 1 }),
    getNextIndex: (chunk) => chunk.nextIndex,
    prepareChunk: (chunk, context) => {
      const pending = deferred();
      preparations.push({ chunk, context, pending });
      return pending.promise;
    },
  });

  // The first chunk is deliberately short and must finish before adaptive
  // sizing can build future chunks.
  await Promise.resolve();
  assert.deepEqual(
    preparations.map(({ chunk }) => chunk.startIndex),
    [0],
  );
  assert.equal(preparations[0].context.speculative, false);
  assert.equal(queue.size, 1);

  preparations[0].pending.resolve("audio-0");
  await new Promise((resolve) => setImmediate(resolve));
  const first = await queue.take();
  assert.equal(first.prepared, "audio-0");
  assert.deepEqual(
    preparations.map(({ chunk }) => chunk.startIndex),
    [0, 1, 2],
  );
  assert.equal(preparations[1].context.speculative, true);
  assert.equal(first.waited, false);
  assert.equal(queue.size, 2);

  preparations[1].pending.resolve("audio-1");
  const secondPromise = queue.take();
  const second = await secondPromise;
  await Promise.resolve();
  assert.deepEqual(
    preparations.map(({ chunk }) => chunk.startIndex),
    [0, 1, 2, 3],
  );
  assert.equal(second.prepared, "audio-1");
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

test("pause cancels speculative work and resume retries from that chunk", async () => {
  const preparations = [];
  const queue = createSpeechPrefetchQueue({
    startIndex: 0,
    endIndex: 3,
    lookahead: 1,
    buildChunk: (index) => ({ startIndex: index, nextIndex: index + 1 }),
    getNextIndex: (chunk) => chunk.nextIndex,
    prepareChunk: (chunk, { signal, speculative }) => {
      const pending = deferred();
      signal.addEventListener(
        "abort",
        () => pending.reject(new DOMException("canceled", "AbortError")),
        { once: true },
      );
      preparations.push({ chunk, pending, signal, speculative });
      return pending.promise;
    },
  });

  await Promise.resolve();
  const current = queue.take();
  preparations[0].pending.resolve("audio-0");
  await current;
  await Promise.resolve();
  assert.equal(preparations[1].chunk.startIndex, 1);
  assert.equal(preparations[1].speculative, true);

  assert.equal(queue.pause(), 1);
  assert.equal(queue.paused, true);
  assert.equal(preparations[1].signal.aborted, true);
  assert.equal(queue.size, 0);

  queue.resume();
  await Promise.resolve();
  assert.equal(queue.paused, false);
  assert.equal(preparations[2].chunk.startIndex, 1);
  preparations[2].pending.resolve("audio-1");
  queue.dispose();
});

test("pause can retain one active lookahead for a warm resume", async () => {
  const preparations = [];
  const queue = createSpeechPrefetchQueue({
    startIndex: 0,
    endIndex: 3,
    lookahead: 1,
    buildChunk: (index) => ({ startIndex: index, nextIndex: index + 1 }),
    getNextIndex: (chunk) => chunk.nextIndex,
    prepareChunk: (chunk, { signal, speculative }) => {
      const pending = deferred();
      preparations.push({ chunk, pending, signal, speculative });
      return pending.promise;
    },
  });

  await Promise.resolve();
  const current = queue.take();
  preparations[0].pending.resolve("audio-0");
  await current;
  await Promise.resolve();

  assert.equal(queue.pause({ cancelPending: false }), 0);
  assert.equal(preparations[1].signal.aborted, false);
  preparations[1].pending.resolve("audio-1");
  await Promise.resolve();
  queue.resume();
  const retained = await queue.take();
  assert.equal(retained.prepared, "audio-1");
  queue.dispose();
});

test("an initial pause preserves the current chunk and defers lookahead", async () => {
  const preparations = [];
  const queue = createSpeechPrefetchQueue({
    startIndex: 0,
    endIndex: 3,
    lookahead: 1,
    buildChunk: (index) => ({ startIndex: index, nextIndex: index + 1 }),
    getNextIndex: (chunk) => chunk.nextIndex,
    prepareChunk: async (chunk, context) => {
      preparations.push({ chunk, context });
      return `audio-${chunk.startIndex}`;
    },
  });

  assert.equal(queue.pause(), 0);
  const first = await queue.take();
  assert.equal(first.prepared, "audio-0");
  assert.deepEqual(
    preparations.map(({ chunk }) => chunk.startIndex),
    [0],
  );

  queue.resume();
  await Promise.resolve();
  assert.deepEqual(
    preparations.map(({ chunk }) => chunk.startIndex),
    [0, 1],
  );
  assert.equal(preparations[1].context.speculative, true);
  queue.dispose();
});

test("the page waits for playing before it resumes speculative narration", async () => {
  const pageSource = await readFile("app/page.tsx", "utf8");
  const onPlayStart = pageSource.indexOf("audio.onplay = () => {");
  const onPlayingStart = pageSource.indexOf("audio.onplaying = () => {");
  const onPauseStart = pageSource.indexOf("audio.onpause = () => {");

  assert.ok(onPlayStart >= 0);
  assert.ok(onPlayingStart > onPlayStart);
  assert.ok(onPauseStart > onPlayingStart);
  assert.doesNotMatch(
    pageSource.slice(onPlayStart, onPlayingStart),
    /prefetchControls\.resume\(\)/u,
  );
  assert.match(
    pageSource.slice(onPlayingStart, onPauseStart),
    /if \(audio\.paused \|\| audio\.ended\) return;/u,
  );
  assert.match(
    pageSource.slice(onPlayingStart, onPauseStart),
    /prefetchControls\.resume\(\)/u,
  );
  assert.equal(
    pageSource.match(/prefetchControls\??\.resume\(\)/gu)?.length,
    1,
  );
  assert.match(pageSource, /audio\.onplaying = null;/u);
});

test("a stored offline model loads after the reader paints and Play reuses it", async () => {
  const pageSource = await readFile("app/page.tsx", "utf8");

  assert.match(
    pageSource,
    /!libraryReady[\s\S]*offlinePackState !== "ready"[\s\S]*scheduleOfflineWarmRestore\([\s\S]*settings\.offlineVoice/u,
  );
  assert.match(
    pageSource,
    /cancelOfflineWarmRestore\(\{ abortActive: false \}\)/u,
  );
  assert.match(
    pageSource,
    /offlineWarmRestoreAbortRef\.current === scheduledController/u,
  );
  assert.match(pageSource, /warm: false/u);
});

test("natural narration primes audio output and cleans it at every exit", async () => {
  const pageSource = await readFile("app/page.tsx", "utf8");
  const start = pageSource.indexOf("const startBufferedSpeech");
  const clear = pageSource.indexOf("clearBufferedPlayback();", start);
  const prime = pageSource.indexOf("primeNarrationAudioOutput();", clear);
  const prepare = pageSource.indexOf(
    "const abortController = new AbortController();",
    prime,
  );
  const onPlaying = pageSource.indexOf("audio.onplaying = () =>", prepare);
  const notAllowed = pageSource.indexOf(
    'error.name === "NotAllowedError"',
    onPlaying,
  );

  assert.ok(start >= 0);
  assert.ok(clear > start);
  assert.ok(prime > clear);
  assert.ok(prepare > prime);
  assert.match(
    pageSource.slice(onPlaying, notAllowed),
    /releaseNarrationAudioPrime\(\)/u,
  );
  assert.match(
    pageSource.slice(notAllowed, pageSource.indexOf("prefetchQueue", notAllowed)),
    /releaseNarrationAudioPrime\(\)/u,
  );
  assert.match(
    pageSource,
    /const clearBufferedPlayback[\s\S]*releaseNarrationAudioPrime\(\)/u,
  );
  assert.match(pageSource, /audio\.loop = true/u);
});

test("discarding speculative narration preserves the loaded offline model", async () => {
  const pageSource = await readFile("app/page.tsx", "utf8");
  const speechSource = await readFile("app/offline-speech.ts", "utf8");

  assert.match(pageSource, /preserveWorkerOnAbort: speculative/u);
  assert.match(
    speechSource,
    /if \(preserveWorkerOnAbort\)[\s\S]*Ignore its eventual result/u,
  );
});

test("clears cached q8 audio only after an fp16 update commits", async () => {
  const pageSource = await readFile("app/page.tsx", "utf8");
  const install = pageSource.indexOf("await installOfflineVoicePack({");
  const status = pageSource.indexOf(
    "const installedStatus = await getOfflineVoicePackStatus();",
    install,
  );
  const clear = pageSource.indexOf(
    "offlineAudioCacheRef.current?.clear();",
    status,
  );
  const ready = pageSource.indexOf(
    'setOfflinePackState("ready");',
    status,
  );

  assert.ok(install >= 0);
  assert.ok(status > install);
  assert.ok(clear > status);
  assert.ok(clear < ready);
});

test("discard callback releases speculative audio completed after cancellation", async () => {
  const preparations = [];
  const discarded = [];
  const queue = createSpeechPrefetchQueue({
    startIndex: 0,
    endIndex: 2,
    lookahead: 1,
    buildChunk: (index) => ({ startIndex: index, nextIndex: index + 1 }),
    getNextIndex: (chunk) => chunk.nextIndex,
    prepareChunk: (chunk) => {
      const pending = deferred();
      preparations.push({ chunk, pending });
      return pending.promise;
    },
    discardPrepared: (prepared, chunk) => {
      discarded.push({ prepared, startIndex: chunk.startIndex });
    },
  });

  await Promise.resolve();
  const current = queue.take();
  preparations[0].pending.resolve("audio-0");
  await current;
  await Promise.resolve();

  queue.pause();
  preparations[1].pending.resolve("audio-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(discarded, [{ prepared: "audio-1", startIndex: 1 }]);
  queue.dispose();
});

test("dispose aborts the active current preparation for seek or restart", async () => {
  let preparationSignal;
  const pending = deferred();
  const queue = createSpeechPrefetchQueue({
    startIndex: 4,
    endIndex: 8,
    lookahead: 1,
    buildChunk: (index) => ({ startIndex: index, nextIndex: index + 1 }),
    getNextIndex: (chunk) => chunk.nextIndex,
    prepareChunk: (_chunk, { signal }) => {
      preparationSignal = signal;
      signal.addEventListener(
        "abort",
        () => pending.reject(new DOMException("canceled", "AbortError")),
        { once: true },
      );
      return pending.promise;
    },
  });

  await Promise.resolve();
  const current = queue.take();
  queue.dispose();
  assert.equal(preparationSignal.aborted, true);
  assert.equal(await current, null);
});

test("generated-audio cache reuses recent results and refreshes LRU order", () => {
  const cache = createBoundedSpeechAudioCache({
    maxBytes: 10,
    maxEntries: 2,
  });

  assert.equal(cache.set("first", "audio-1", 4), true);
  assert.equal(cache.set("second", "audio-2", 4), true);
  assert.equal(cache.get("first"), "audio-1");
  assert.equal(cache.set("third", "audio-3", 4), true);

  assert.equal(cache.get("second"), undefined);
  assert.equal(cache.get("first"), "audio-1");
  assert.equal(cache.get("third"), "audio-3");
  assert.equal(cache.size, 2);
  assert.equal(cache.byteLength, 8);
});

test("generated-audio cache enforces byte bounds and can be cleared", () => {
  const cache = createBoundedSpeechAudioCache({
    maxBytes: 7,
    maxEntries: 4,
  });

  cache.set("first", { id: 1 }, 4);
  cache.set("second", { id: 2 }, 4);
  assert.equal(cache.get("first"), undefined);
  assert.deepEqual(cache.get("second"), { id: 2 });
  assert.equal(cache.set("oversized", { id: 3 }, 8), false);
  assert.equal(cache.size, 1);
  assert.equal(cache.byteLength, 4);

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.byteLength, 0);
});
