#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv.length !== 4) {
  throw new Error("usage: runtime-export-smoke.mjs MODULE_MJS MODULE_WASM");
}

const modulePath = path.resolve(process.argv[2]);
const wasmPath = path.resolve(process.argv[3]);
const { default: createModule } = await import(pathToFileURL(modulePath));
const wasmBinary = await readFile(wasmPath);
const runtime = await createModule({ numThreads: 2, wasmBinary });

for (const name of [
  "_OrtGetRunCancellationMailbox",
  "_OrtBeginRunCancellation",
  "_OrtIsRunCancellationRequested",
  "_OrtEndRunCancellation",
]) {
  assert.equal(typeof runtime[name], "function", `${name} is callable`);
}

const mailboxByteOffset = runtime._OrtGetRunCancellationMailbox();
assert.ok(mailboxByteOffset > 0);
assert.equal(mailboxByteOffset % Uint32Array.BYTES_PER_ELEMENT, 0);
assert.ok(runtime.HEAPU32.buffer instanceof SharedArrayBuffer);
const mailbox = new Uint32Array(runtime.HEAPU32.buffer);
const activeIndex = mailboxByteOffset / Uint32Array.BYTES_PER_ELEMENT;

const firstRunOptions = runtime._OrtCreateRunOptions(2, 0, false, 0);
assert.ok(firstRunOptions > 0);
const firstGeneration = runtime._OrtBeginRunCancellation(firstRunOptions) >>> 0;
assert.ok(firstGeneration > 0);
assert.equal(Atomics.load(mailbox, activeIndex), firstGeneration);
assert.equal(runtime._OrtIsRunCancellationRequested(firstGeneration), 0);
Atomics.store(mailbox, activeIndex + 1, firstGeneration);
assert.equal(runtime._OrtIsRunCancellationRequested(firstGeneration), 1);
assert.equal(runtime._OrtEndRunCancellation(firstRunOptions, firstGeneration), 0);
assert.equal(Atomics.load(mailbox, activeIndex), 0);
assert.equal(runtime._OrtReleaseRunOptions(firstRunOptions), 0);

const secondRunOptions = runtime._OrtCreateRunOptions(2, 0, false, 0);
assert.ok(secondRunOptions > 0);
const secondGeneration = runtime._OrtBeginRunCancellation(secondRunOptions) >>> 0;
assert.ok(secondGeneration > 0);
assert.notEqual(secondGeneration, firstGeneration);
assert.equal(runtime._OrtIsRunCancellationRequested(secondGeneration), 0);
assert.equal(runtime._OrtEndRunCancellation(secondRunOptions, secondGeneration), 0);
assert.equal(runtime._OrtReleaseRunOptions(secondRunOptions), 0);

process.stdout.write(
  `${JSON.stringify({
    activeIndex,
    firstGeneration,
    mailboxCells: 3,
    secondGeneration,
    sharedMemory: true,
    wrapperExports: 4,
  })}\n`,
);
