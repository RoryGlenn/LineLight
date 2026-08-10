import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { build } from "esbuild";

class FakeWorker {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.listeners = new Map();
    this.messages = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  dispatchMessage(data) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data });
    }
  }
}

async function bundleOfflineSpeechModule() {
  const result = await build({
    bundle: true,
    entryPoints: ["app/offline-speech.ts"],
    format: "esm",
    platform: "browser",
    plugins: [
      {
        name: "fake-worker-url",
        setup(esbuild) {
          esbuild.onResolve({ filter: /\?worker&url$/ }, () => ({
            namespace: "fake-worker-url",
            path: "offline-speech-worker",
          }));
          esbuild.onLoad(
            { filter: /.*/, namespace: "fake-worker-url" },
            () => ({
              contents: 'export default "offline-speech.worker.test.js";',
              loader: "js",
            }),
          );
        },
      },
    ],
    sourcemap: false,
    write: false,
  });
  assert.equal(result.outputFiles.length, 1);
  const encoded = Buffer.from(result.outputFiles[0].contents).toString(
    "base64",
  );
  return import(`data:text/javascript;base64,${encoded}`);
}

function synthesisResult(text) {
  return {
    audioData: new TextEncoder().encode(text).buffer,
    audioDurationSeconds: 1,
    boundaries: [],
    device: "wasm",
    modelDtype: "fp16",
    synthesisMilliseconds: 10,
    wasmThreads: 4,
  };
}

async function waitFor(predicate, timeoutMilliseconds = 2_000) {
  const deadline = performance.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for the worker recovery state.");
    }
    await delay(10);
  }
}

test(
  "a cancellation watchdog replaces the worker and replays only live requests",
  { timeout: 5_000 },
  async (t) => {
    FakeWorker.instances = [];
    const originalWorker = globalThis.Worker;
    const originalLocation = Object.getOwnPropertyDescriptor(
      globalThis,
      "location",
    );
    const originalCaches = Object.getOwnPropertyDescriptor(
      globalThis,
      "caches",
    );
    let cacheOperations = 0;

    globalThis.Worker = FakeWorker;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://linelight.test/reader"),
    });
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: {
        open() {
          cacheOperations += 1;
          throw new Error("worker recovery must reuse the installed cache");
        },
      },
    });

    t.after(() => {
      globalThis.Worker = originalWorker;
      if (originalLocation) {
        Object.defineProperty(globalThis, "location", originalLocation);
      } else {
        delete globalThis.location;
      }
      if (originalCaches) {
        Object.defineProperty(globalThis, "caches", originalCaches);
      } else {
        delete globalThis.caches;
      }
    });

    const speech = await bundleOfflineSpeechModule();
    t.after(() => speech.disposeOfflineSpeechWorker());

    const seed = speech.synthesizeOfflineSpeech({
      text: "seed",
      voice: "af_heart",
      rate: 1,
    });
    const firstWorker = FakeWorker.instances[0];
    assert.ok(firstWorker);
    assert.deepEqual(firstWorker.options, {
      name: "linelight-offline-voice",
      type: "module",
    });
    assert.equal(firstWorker.messages[0].id, 1);
    firstWorker.dispatchMessage({
      id: 1,
      type: "success",
      result: synthesisResult("seed"),
    });
    await seed;
    assert.deepEqual(speech.getOfflineSpeechReadiness(), {
      state: "ready",
      device: "wasm",
      modelDtype: "fp16",
      wasmThreads: 4,
      timings: null,
      error: null,
    });

    const canceledController = new AbortController();
    const canceled = speech.synthesizeOfflineSpeech({
      text: "discarded speculative passage",
      voice: "af_heart",
      rate: 1,
      signal: canceledController.signal,
      preserveWorkerOnAbort: true,
    });
    const preserved = speech.synthesizeOfflineSpeech({
      text: "preserved target passage",
      voice: "af_heart",
      rate: 1,
    });
    let preservedSettled = false;
    void preserved.finally(() => {
      preservedSettled = true;
    });

    const mailbox = new Uint32Array(new SharedArrayBuffer(12));
    Atomics.store(mailbox, 0, 41);
    firstWorker.dispatchMessage({
      id: 2,
      type: "wasm-run-start",
      generation: 41,
      sharedBuffer: mailbox.buffer,
      activeGenerationIndex: 0,
      cancellationGenerationIndex: 1,
      sessionGeneration: 7,
    });
    canceledController.abort();
    await assert.rejects(canceled, { name: "AbortError" });
    assert.equal(Atomics.load(mailbox, 1), 41);
    assert.deepEqual(firstWorker.messages.at(-1), { id: 2, type: "cancel" });

    await waitFor(() => FakeWorker.instances.length === 2);
    const recoveryWorker = FakeWorker.instances[1];
    assert.equal(firstWorker.terminated, true);
    assert.equal(recoveryWorker.terminated, false);
    assert.deepEqual(
      recoveryWorker.messages.map(({ id, text, type }) => ({ id, text, type })),
      [
        {
          id: 3,
          text: "preserved target passage",
          type: "synthesize",
        },
      ],
    );
    assert.deepEqual(speech.getOfflineSpeechReadiness(), {
      state: "initializing",
      device: "wasm",
      modelDtype: "fp16",
      wasmThreads: 4,
      timings: null,
      error: null,
    });

    firstWorker.dispatchMessage({
      id: 3,
      type: "success",
      result: synthesisResult("stale"),
    });
    await delay(0);
    assert.equal(preservedSettled, false);

    recoveryWorker.dispatchMessage({
      id: 3,
      type: "success",
      result: synthesisResult("preserved"),
    });
    const result = await preserved;
    assert.equal(new TextDecoder().decode(result.audioData), "preserved");
    assert.equal(cacheOperations, 0);
    assert.deepEqual(speech.getOfflineSpeechReadiness(), {
      state: "ready",
      device: "wasm",
      modelDtype: "fp16",
      wasmThreads: 4,
      timings: null,
      error: null,
    });
  },
);
