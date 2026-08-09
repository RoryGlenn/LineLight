// web/lib/wasm/run-cancellation.ts
var observer;
var setWasmRunCancellationObserver = (value) => {
  observer = value;
};
var requestWasmRunCancellation = (event) => {
  if (event.type !== "start" || typeof SharedArrayBuffer === "undefined" || !(event.sharedBuffer instanceof SharedArrayBuffer) || event.activeGenerationIndex === void 0 || event.cancellationGenerationIndex === void 0) {
    return false;
  }
  try {
    const mailbox = new Uint32Array(event.sharedBuffer);
    if (!Number.isInteger(event.generation) || event.generation <= 0 || event.generation > 4294967295 || !Number.isInteger(event.activeGenerationIndex) || !Number.isInteger(event.cancellationGenerationIndex) || event.activeGenerationIndex < 0 || event.cancellationGenerationIndex < 0 || event.cancellationGenerationIndex !== event.activeGenerationIndex + 1 || event.activeGenerationIndex >= mailbox.length || event.cancellationGenerationIndex >= mailbox.length || Atomics.load(mailbox, event.activeGenerationIndex) !== event.generation) {
      return false;
    }
    Atomics.store(mailbox, event.cancellationGenerationIndex, event.generation);
    return true;
  } catch {
    return false;
  }
};
var notifyObserver = (event) => {
  try {
    observer?.(event);
  } catch {
  }
};
var beginWasmRunCancellation = (wasm, runOptionsHandle) => {
  if (!observer || typeof SharedArrayBuffer === "undefined") {
    return void 0;
  }
  const buffer = wasm.HEAPU32.buffer;
  if (!(buffer instanceof SharedArrayBuffer)) {
    return void 0;
  }
  const mailboxByteOffset = wasm._OrtGetRunCancellationMailbox();
  if (mailboxByteOffset <= 0 || mailboxByteOffset % Uint32Array.BYTES_PER_ELEMENT !== 0 || mailboxByteOffset / Uint32Array.BYTES_PER_ELEMENT + 1 >= wasm.HEAPU32.length) {
    return void 0;
  }
  const rawGeneration = wasm._OrtBeginRunCancellation(runOptionsHandle);
  const generation = rawGeneration < 0 ? rawGeneration + 4294967296 : rawGeneration;
  if (generation === 0) {
    return void 0;
  }
  const activeGenerationIndex = mailboxByteOffset / Uint32Array.BYTES_PER_ELEMENT;
  notifyObserver({
    type: "start",
    generation,
    sharedBuffer: buffer,
    activeGenerationIndex,
    cancellationGenerationIndex: activeGenerationIndex + 1
  });
  return { generation, runOptionsHandle, wasm };
};
var endWasmRunCancellation = (active) => {
  if (!active) {
    return false;
  }
  const { generation, runOptionsHandle, wasm } = active;
  const cancellationObserved = wasm._OrtEndRunCancellation(runOptionsHandle, generation) !== 0;
  notifyObserver({ type: "end", generation });
  return cancellationObserved;
};
var WasmRunCancellationError = class extends Error {
  constructor() {
    super("The active WebAssembly inference run was canceled.");
    this.code = "ERR_ORT_WASM_RUN_CANCELED";
    this.name = "AbortError";
  }
};
export {
  WasmRunCancellationError,
  beginWasmRunCancellation,
  endWasmRunCancellation,
  requestWasmRunCancellation,
  setWasmRunCancellationObserver
};
