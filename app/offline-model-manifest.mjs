export const OFFLINE_MODEL_ID = "Supertone/supertonic-3";
export const OFFLINE_MODEL_REVISION =
  "3cadd1ee6394adea1bd021217a0e650ede09a323";
export const OFFLINE_MODEL_DTYPE = "fp32";
export const OFFLINE_MODEL_RUNTIME = "webgpu";
export const OFFLINE_OUTPUT_SAMPLE_RATE = 44_100;

// Exact immutable asset sizes are checked before Cache Storage entries count
// as installed. ONNX files use resumable ranges; the two setup files remain
// ordinary bounded cache entries.
export const OFFLINE_MODEL_ASSETS = Object.freeze([
  Object.freeze({
    file: "onnx/duration_predictor.onnx",
    bytes: 3_700_147,
    rangeBacked: true,
  }),
  Object.freeze({
    file: "onnx/text_encoder.onnx",
    bytes: 36_416_150,
    rangeBacked: true,
  }),
  Object.freeze({
    file: "onnx/vector_estimator.onnx",
    bytes: 256_534_781,
    rangeBacked: true,
  }),
  Object.freeze({
    file: "onnx/vocoder.onnx",
    bytes: 101_424_195,
    rangeBacked: true,
  }),
  Object.freeze({
    file: "onnx/tts.json",
    bytes: 8_253,
    rangeBacked: false,
  }),
  Object.freeze({
    file: "onnx/unicode_indexer.json",
    bytes: 277_676,
    rangeBacked: false,
  }),
]);

export const OFFLINE_VOICE_ASSETS = Object.freeze([
  Object.freeze({ id: "F1", file: "voice_styles/F1.json", bytes: 292_046 }),
  Object.freeze({ id: "F2", file: "voice_styles/F2.json", bytes: 292_423 }),
  Object.freeze({ id: "F3", file: "voice_styles/F3.json", bytes: 290_794 }),
  Object.freeze({ id: "F4", file: "voice_styles/F4.json", bytes: 291_808 }),
  Object.freeze({ id: "F5", file: "voice_styles/F5.json", bytes: 291_479 }),
  Object.freeze({ id: "M1", file: "voice_styles/M1.json", bytes: 291_748 }),
  Object.freeze({ id: "M2", file: "voice_styles/M2.json", bytes: 292_055 }),
  Object.freeze({ id: "M3", file: "voice_styles/M3.json", bytes: 290_198 }),
  Object.freeze({ id: "M4", file: "voice_styles/M4.json", bytes: 291_522 }),
  Object.freeze({ id: "M5", file: "voice_styles/M5.json", bytes: 291_469 }),
]);

export const OFFLINE_MODEL_FILES = OFFLINE_MODEL_ASSETS.map(
  (asset) => asset.file,
);
export const OFFLINE_VOICE_IDS = OFFLINE_VOICE_ASSETS.map(
  (asset) => asset.id,
);
export const OFFLINE_MODEL_BYTES = OFFLINE_MODEL_ASSETS.reduce(
  (total, asset) => total + asset.bytes,
  0,
);
export const OFFLINE_VOICE_BYTES = OFFLINE_VOICE_ASSETS.reduce(
  (total, asset) => total + asset.bytes,
  0,
);

// ONNX creates nested workers only for the WASM backend. Eight remains a
// desktop ceiling; non-isolated browsers use the single-thread fallback.
export const OFFLINE_WASM_THREADS = 8;
export const OFFLINE_WASM_FALLBACK_THREADS = 1;
export const OFFLINE_WASM_PROXY = false;
export const OFFLINE_WEBGPU_ADAPTER_TIMEOUT_MS = 500;
export const OFFLINE_RUNTIME_CACHE_NAME = "linelight-assets-v1";
export const OFFLINE_MODEL_ROUTE_BASE = "/offline-model/";
export const OFFLINE_MODEL_LOCAL_PATH =
  `${OFFLINE_MODEL_ROUTE_BASE}${OFFLINE_MODEL_REVISION}/`;
export const OFFLINE_MODEL_ROUTE_PREFIX =
  `${OFFLINE_MODEL_LOCAL_PATH}${OFFLINE_MODEL_ID}/`;

export const OFFLINE_MODEL_URLS = OFFLINE_MODEL_ASSETS.map(
  (asset) => `${OFFLINE_MODEL_ROUTE_PREFIX}${asset.file}`,
);
export const OFFLINE_VOICE_URLS = OFFLINE_VOICE_ASSETS.map(
  (asset) => `${OFFLINE_MODEL_ROUTE_PREFIX}${asset.file}`,
);

export const OFFLINE_MODEL_READY_MARKER_VERSION =
  "supertonic-3-44100-ready-v1";
export const OFFLINE_MODEL_READY_MARKER_URL =
  `${OFFLINE_MODEL_ROUTE_PREFIX}__linelight_${OFFLINE_MODEL_READY_MARKER_VERSION}`;

// The old Kokoro identifiers are used only for post-commit cleanup. They are
// deliberately not accepted by resolveOfflineModelRequest.
export const OFFLINE_LEGACY_MODEL_ID =
  "onnx-community/Kokoro-82M-v1.0-ONNX";

/**
 * Bound WebGPU capability detection so a browser or driver that never settles
 * cannot hold narration startup. Supertonic uses portable float32 graphs and
 * therefore does not require the optional shader-f16 feature.
 */
export async function probeWebGpuAdapter({
  requestAdapter,
  timeoutMs = OFFLINE_WEBGPU_ADAPTER_TIMEOUT_MS,
  setTimeoutFn = globalThis.setTimeout.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout.bind(globalThis),
}) {
  let timeoutId;
  const capability = Promise.resolve()
    .then(requestAdapter)
    .then((adapter) => Boolean(adapter), () => false);
  const deadline = new Promise((resolve) => {
    timeoutId = setTimeoutFn(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([capability, deadline]);
  } finally {
    if (timeoutId !== undefined) clearTimeoutFn(timeoutId);
  }
}

/** The studio pack has one reviewed model representation on every backend. */
export function selectOfflineModelDtype() {
  return OFFLINE_MODEL_DTYPE;
}

const ALLOWED_OFFLINE_MODEL_FILES = new Set([
  ...OFFLINE_MODEL_FILES,
  ...OFFLINE_VOICE_ASSETS.map((voice) => voice.file),
]);

export function selectOfflineSpeechBackend({
  crossOriginIsolated = false,
  forceSingleThreadWasm = false,
  hardwareConcurrency = 1,
  preferWebGpu = true,
  webGpuAvailable = false,
} = {}) {
  if (preferWebGpu && webGpuAvailable) {
    return { device: "webgpu", wasmThreads: null };
  }
  const availableThreads = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(hardwareConcurrency))
    : 1;
  const wasmThreads =
    crossOriginIsolated && !forceSingleThreadWasm
      ? Math.min(OFFLINE_WASM_THREADS, Math.max(1, availableThreads - 2))
      : OFFLINE_WASM_FALLBACK_THREADS;
  return { device: "wasm", wasmThreads };
}

export function nextOfflineSpeechBackend(backend) {
  if (backend.device === "webgpu") {
    return { device: "wasm", wasmThreads: null };
  }
  if ((backend.wasmThreads ?? 1) > 1) {
    return { device: "wasm", wasmThreads: 1 };
  }
  return null;
}

export function constrainOfflineBackendPreference(
  preference = {},
  webGpuDisabledForSession = false,
) {
  if (!webGpuDisabledForSession) return { ...preference };
  return {
    device: "wasm",
    ...(preference.device === "wasm" &&
    Number.isFinite(preference.wasmThreads)
      ? { wasmThreads: preference.wasmThreads }
      : {}),
  };
}

/** Resolve only immutable, allowlisted first-party model paths. */
export function resolveOfflineModelRequest(pathname) {
  if (!pathname.startsWith(OFFLINE_MODEL_ROUTE_PREFIX)) return null;
  const file = pathname.slice(OFFLINE_MODEL_ROUTE_PREFIX.length);
  if (!ALLOWED_OFFLINE_MODEL_FILES.has(file)) return null;
  return {
    file,
    upstreamUrl:
      `https://huggingface.co/${OFFLINE_MODEL_ID}/resolve/` +
      `${OFFLINE_MODEL_REVISION}/${file}`,
  };
}
