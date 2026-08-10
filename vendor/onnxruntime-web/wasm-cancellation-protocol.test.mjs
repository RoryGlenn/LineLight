import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { requestWasmRunCancellation } from './run-cancellation.bundle.mjs';

const workerSource = String.raw`
  const { parentPort } = require('node:worker_threads');
  const sharedBuffer = new SharedArrayBuffer(8);
  const mailbox = new Uint32Array(sharedBuffer);
  const generation = 73;
  Atomics.store(mailbox, 0, generation);
  parentPort.postMessage({
    type: 'start',
    generation,
    sharedBuffer,
    activeGenerationIndex: 0,
    cancellationGenerationIndex: 1,
  });

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && Atomics.load(mailbox, 1) !== generation) {}
  parentPort.postMessage({
    type: 'observed',
    canceled: Atomics.load(mailbox, 1) === generation,
  });
`;

test('a controller on another agent cancels the active generation', async (t) => {
  const owner = new Worker(workerSource, { eval: true });
  t.after(() => owner.terminate());

  const [start] = await once(owner, 'message');
  assert.equal(requestWasmRunCancellation(start), true);
  const [observed] = await once(owner, 'message');
  assert.deepEqual(observed, { type: 'observed', canceled: true });
});

test('a delayed controller cannot cancel a later generation', () => {
  const sharedBuffer = new SharedArrayBuffer(8);
  const mailbox = new Uint32Array(sharedBuffer);
  Atomics.store(mailbox, 0, 74);
  const staleStart = {
    type: 'start',
    generation: 73,
    sharedBuffer,
    activeGenerationIndex: 0,
    cancellationGenerationIndex: 1,
  };

  assert.equal(requestWasmRunCancellation(staleStart), false);
  assert.equal(Atomics.load(mailbox, 1), 0);
});

test('the controller cannot redirect the write to another Wasm cell', () => {
  const sharedBuffer = new SharedArrayBuffer(16);
  const mailbox = new Uint32Array(sharedBuffer);
  Atomics.store(mailbox, 0, 73);
  const forgedStart = {
    type: 'start',
    generation: 73,
    sharedBuffer,
    activeGenerationIndex: 0,
    cancellationGenerationIndex: 3,
  };

  assert.equal(requestWasmRunCancellation(forgedStart), false);
  assert.equal(Atomics.load(mailbox, 3), 0);
});

test('an ArrayBuffer cannot be forged into a cancellation mailbox', () => {
  const plainBuffer = new ArrayBuffer(8);
  const mailbox = new Uint32Array(plainBuffer);
  mailbox[0] = 73;

  assert.equal(
    requestWasmRunCancellation({
      type: 'start',
      generation: 73,
      sharedBuffer: plainBuffer,
      activeGenerationIndex: 0,
      cancellationGenerationIndex: 1,
    }),
    false,
  );
  assert.equal(mailbox[1], 0);
});
