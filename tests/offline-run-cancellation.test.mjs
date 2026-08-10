import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createOfflineRunCancellationController,
  requestOfflineWasmRunCancellation,
} from "../app/offline-run-cancellation.mjs";

function createMailbox(generation = 41) {
  const sharedBuffer = new SharedArrayBuffer(32);
  const mailbox = new Uint32Array(sharedBuffer);
  Atomics.store(mailbox, 2, generation);
  return {
    mailbox,
    run: {
      id: 7,
      generation,
      sharedBuffer,
      activeGenerationIndex: 2,
      cancellationGenerationIndex: 3,
    },
  };
}

function createFakeTimers() {
  const callbacks = new Map();
  let nextHandle = 1;
  return {
    callbacks,
    scheduleTimeout(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    clearScheduledTimeout(handle) {
      callbacks.delete(handle);
    },
    runAll() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
  };
}

test("writes only the adjacent cancellation generation for an active run", () => {
  const { mailbox, run } = createMailbox();
  assert.equal(requestOfflineWasmRunCancellation(run), true);
  assert.equal(Atomics.load(mailbox, 2), 41);
  assert.equal(Atomics.load(mailbox, 3), 41);

  assert.equal(
    requestOfflineWasmRunCancellation({
      ...run,
      cancellationGenerationIndex: 5,
    }),
    false,
  );
  assert.equal(Atomics.load(mailbox, 5), 0);
  assert.equal(
    requestOfflineWasmRunCancellation({
      ...run,
      sharedBuffer: new ArrayBuffer(32),
    }),
    false,
  );
});

test("cancels a run that starts after the page abort request", () => {
  const timers = createFakeTimers();
  const controller = createOfflineRunCancellationController(timers);
  const { mailbox, run } = createMailbox();

  assert.equal(controller.register(7, 3), true);
  assert.equal(controller.request(7, 3), false);
  assert.equal(timers.callbacks.size, 0);
  assert.equal(controller.snapshot(7).watchdogActive, false);
  assert.equal(controller.observeStart(run, 3), true);
  assert.equal(timers.callbacks.size, 1);
  assert.equal(controller.snapshot(7).watchdogActive, true);
  assert.equal(Atomics.load(mailbox, 3), 41);
});

test("a cancellation with no cooperative start never arms worker recovery", () => {
  const timers = createFakeTimers();
  const timeouts = [];
  const controller = createOfflineRunCancellationController({
    ...timers,
    now: () => 90,
    onTimeout: (details) => timeouts.push(details),
  });

  controller.register(7, 3);
  assert.equal(controller.request(7, 3), false);
  assert.deepEqual(controller.snapshot(7), {
    workerEpoch: 3,
    cancelRequested: true,
    requestedAtMilliseconds: 90,
    activeGeneration: null,
    watchdogActive: false,
  });
  assert.equal(timers.callbacks.size, 0);
  timers.runAll();
  assert.deepEqual(timeouts, []);
  assert.equal(controller.complete(7, 3), true);
});

test("retains cancellation through run end until a terminal acknowledgement", () => {
  const timers = createFakeTimers();
  const timeouts = [];
  const controller = createOfflineRunCancellationController({
    ...timers,
    now: () => 125,
    onTimeout: (details) => timeouts.push(details),
  });
  const { run } = createMailbox();

  controller.register(7, 3);
  controller.observeStart(run, 3);
  assert.equal(controller.request(7, 3), true);
  assert.equal(controller.observeEnd({ id: 7, generation: 41 }, 3), true);
  assert.deepEqual(controller.snapshot(7), {
    workerEpoch: 3,
    cancelRequested: true,
    requestedAtMilliseconds: 125,
    activeGeneration: null,
    watchdogActive: true,
  });

  timers.runAll();
  assert.deepEqual(timeouts, [
    {
      id: 7,
      workerEpoch: 3,
      requestedAtMilliseconds: 125,
      activeGeneration: null,
    },
  ]);
  assert.equal(controller.complete(7, 3), true);
  assert.equal(controller.snapshot(7), null);
});

test("rejects stale worker epochs and stale generation ends", () => {
  const timers = createFakeTimers();
  const controller = createOfflineRunCancellationController(timers);
  const { mailbox, run } = createMailbox();

  controller.register(7, 4);
  controller.request(7, 4);
  assert.equal(controller.observeStart(run, 3), false);
  assert.equal(Atomics.load(mailbox, 3), 0);
  assert.equal(controller.observeStart(run, 4), true);
  assert.equal(
    controller.observeEnd({ id: 7, generation: 40 }, 4),
    false,
  );
  assert.equal(controller.snapshot(7).activeGeneration, 41);
  assert.equal(controller.complete(7, 3), false);
  assert.equal(controller.complete(7, 4), true);
});

test("terminal success clears the watchdog and duplicate completion is inert", () => {
  const timers = createFakeTimers();
  const timeouts = [];
  const controller = createOfflineRunCancellationController({
    ...timers,
    onTimeout: (details) => timeouts.push(details),
  });
  const { run } = createMailbox();

  controller.register(9, 2);
  controller.observeStart({ ...run, id: 9 }, 2);
  controller.request(9, 2);
  assert.equal(timers.callbacks.size, 1);
  assert.equal(controller.complete(9, 2), true);
  assert.equal(timers.callbacks.size, 0);
  assert.equal(controller.complete(9, 2), false);
  timers.runAll();
  assert.deepEqual(timeouts, []);
});

test("resetting a replaced worker epoch cannot clear the new worker state", () => {
  const timers = createFakeTimers();
  const controller = createOfflineRunCancellationController(timers);

  controller.register(7, 1);
  controller.register(8, 2);
  assert.equal(controller.resetEpoch(1), 1);
  assert.equal(controller.snapshot(7), null);
  assert.equal(controller.snapshot(8).workerEpoch, 2);
});

test("the worker publishes the bridge only for multithreaded WASM", async () => {
  const workerSource = await readFile("app/offline-speech.worker.ts", "utf8");
  const pageSource = await readFile("app/offline-speech.ts", "utf8");

  assert.match(
    workerSource,
    /activeBackend\.device === "wasm"[\s\S]*\(activeBackend\.wasmThreads \?\? 1\) > 1/u,
  );
  assert.match(
    workerSource,
    /if \([\s\S]*!supportsCooperativeCancellation\(\)[\s\S]*return;/u,
  );
  assert.match(
    workerSource,
    /if \(isCooperativeCancellationError\(error\)\) throw error;[\s\S]*shouldRetryOfflineSpeechBackend/u,
  );
  assert.match(
    workerSource,
    /if \(queuedRequests\.has\(message\.id\) \|\| abortController\)/u,
  );
  assert.doesNotMatch(pageSource, /from "onnxruntime-web"/u);
});

test("terminal responses acknowledge late cancellation without reviving an aborted promise", async () => {
  const pageSource = await readFile("app/offline-speech.ts", "utf8");
  const terminalAcknowledgement = pageSource.indexOf(
    "runCancellationController.complete(message.id, createdWorkerEpoch)",
    pageSource.indexOf('if (message.type === "progress")'),
  );
  const pendingLookup = pageSource.indexOf(
    "const pending = pendingRequests.get(message.id)",
    terminalAcknowledgement,
  );
  const missingPendingReturn = pageSource.indexOf(
    "if (!pending) return",
    pendingLookup,
  );

  assert.ok(terminalAcknowledgement >= 0);
  assert.ok(pendingLookup > terminalAcknowledgement);
  assert.ok(missingPendingReturn > pendingLookup);
});
