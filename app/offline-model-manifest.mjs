export const OFFLINE_MODEL_ID =
  "onnx-community/Kokoro-82M-v1.0-ONNX";
// The official fp16 graph is materially faster than q8 on both WebGPU and
// threaded WASM while preserving Kokoro's reviewed voice quality.
export const OFFLINE_MODEL_DTYPE = "fp16";
export const OFFLINE_WEBGPU_MODEL_DTYPE = "fp16";
export const OFFLINE_WEBGPU_MODEL_BASENAME = "model_fp16";
export const OFFLINE_WEBGPU_MODEL_FILE =
  `onnx/${OFFLINE_WEBGPU_MODEL_BASENAME}.onnx`;
export const OFFLINE_WEBGPU_MODEL_BYTES = 163_234_740;
export const OFFLINE_LEGACY_Q8_MODEL_FILE = "onnx/model_quantized.onnx";
export const OFFLINE_LEGACY_Q8_MODEL_BYTES = 92_361_116;
// WebGPU is attempted only after a worker confirms that the browser can return
// an adapter. Runtime failures fall through to a fresh WASM worker.
export const OFFLINE_MODEL_RUNTIME = "webgpu";
// ONNX implements additional WASM threads as nested workers. They are safe only
// when the page is cross-origin isolated, so this is a ceiling rather than an
// unconditional thread count.
export const OFFLINE_WASM_THREADS = 8;
export const OFFLINE_WASM_FALLBACK_THREADS = 1;
export const OFFLINE_WASM_PROXY = false;
export const OFFLINE_WEBGPU_ADAPTER_TIMEOUT_MS = 500;
export const OFFLINE_RUNTIME_CACHE_NAME = "linelight-assets-v1";
export const OFFLINE_MODEL_REVISION =
  "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const OFFLINE_MODEL_ROUTE_BASE = "/offline-model/";
export const OFFLINE_MODEL_LOCAL_PATH =
  `${OFFLINE_MODEL_ROUTE_BASE}${OFFLINE_MODEL_REVISION}/`;

export const OFFLINE_MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  OFFLINE_WEBGPU_MODEL_FILE,
];

export const OFFLINE_VOICE_IDS = [
  "af_heart",
  "af_bella",
  "am_michael",
  "bf_emma",
  "bm_george",
];

export const OFFLINE_MODEL_ROUTE_PREFIX =
  `${OFFLINE_MODEL_LOCAL_PATH}${OFFLINE_MODEL_ID}/`;
export const OFFLINE_WEBGPU_MODEL_URL =
  `${OFFLINE_MODEL_ROUTE_PREFIX}${OFFLINE_WEBGPU_MODEL_FILE}`;
export const OFFLINE_LEGACY_Q8_MODEL_URL =
  `${OFFLINE_MODEL_ROUTE_PREFIX}${OFFLINE_LEGACY_Q8_MODEL_FILE}`;
export const OFFLINE_FP16_READY_MARKER_VERSION = "fp16-ready-v1";
export const OFFLINE_FP16_READY_MARKER_URL =
  `${OFFLINE_MODEL_ROUTE_PREFIX}__linelight_${OFFLINE_FP16_READY_MARKER_VERSION}`;

/**
 * Bound WebGPU capability detection so a browser or driver that never settles
 * its adapter request cannot hold narration startup. A late adapter result is
 * deliberately ignored for this worker; the shared fp16 artifact remains
 * available to the threaded WASM fallback, and a later page load may probe
 * WebGPU again.
 *
 * @param {{
 *   requestAdapter: () => Promise<{
 *     features?: { has(feature: string): boolean },
 *   } | null>,
 *   timeoutMs?: number,
 *   setTimeoutFn?: typeof globalThis.setTimeout,
 *   clearTimeoutFn?: typeof globalThis.clearTimeout,
 * }} options
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
    .then(
      (adapter) => Boolean(adapter?.features?.has("shader-f16")),
      () => false,
    );
  const deadline = new Promise((resolve) => {
    timeoutId = setTimeoutFn(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([capability, deadline]);
  } finally {
    if (timeoutId !== undefined) clearTimeoutFn(timeoutId);
  }
}

/**
 * Keep a complete legacy q8 model usable until the preferred fp16 artifact has
 * downloaded and passed runtime validation.
 *
 * @param {{
 *   legacyQ8Available?: boolean,
 *   preferFp16?: boolean,
 * }} state
 * @returns {"fp16" | "q8"}
 */
export function selectOfflineModelDtype({
  legacyQ8Available = false,
  preferFp16 = false,
} = {}) {
  if (legacyQ8Available && !preferFp16) return "q8";
  return OFFLINE_MODEL_DTYPE;
}

const ALLOWED_OFFLINE_MODEL_FILES = new Set([
  ...OFFLINE_MODEL_FILES,
  // Keep the previous q8 route pinned during migration so an interrupted fp16
  // upgrade never turns the old stored model into an untrusted fetch target.
  OFFLINE_LEGACY_Q8_MODEL_FILE,
  ...OFFLINE_VOICE_IDS.map((voice) => `voices/${voice}.bin`),
]);

/**
 * Select the first backend in LineLight's runtime capability ladder.
 *
 * @param {{
 *   crossOriginIsolated?: boolean;
 *   forceSingleThreadWasm?: boolean;
 *   hardwareConcurrency?: number;
 *   preferWebGpu?: boolean;
 *   webGpuAvailable?: boolean;
 * }} capabilities
 */
export function selectOfflineSpeechBackend({
  crossOriginIsolated = false,
  forceSingleThreadWasm = false,
  hardwareConcurrency = 1,
  preferWebGpu = true,
  webGpuAvailable = false,
} = {}) {
  if (preferWebGpu && webGpuAvailable) {
    return {
      device: "webgpu",
      wasmThreads: null,
    };
  }

  const availableThreads = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(hardwareConcurrency))
    : 1;
  const wasmThreads =
    crossOriginIsolated && !forceSingleThreadWasm
      ? Math.min(
          OFFLINE_WASM_THREADS,
          // Kokoro's fp16 graph reaches real-time throughput only near eight
          // threads on desktop CPUs. Keep two logical cores free for PDF/UI
          // work instead of halving the available pool.
          Math.max(1, availableThreads - 2),
        )
      : OFFLINE_WASM_FALLBACK_THREADS;

  return {
    device: "wasm",
    wasmThreads,
  };
}

/**
 * Return the next backend after a runtime failure. A null WASM thread count
 * means that the fresh worker may use the isolated multithreaded tier.
 *
 * @param {{ device: "webgpu" | "wasm"; wasmThreads: number | null }} backend
 * @returns {{ device: "wasm"; wasmThreads: number | null } | null}
 */
export function nextOfflineSpeechBackend(backend) {
  if (backend.device === "webgpu") {
    return { device: "wasm", wasmThreads: null };
  }
  if ((backend.wasmThreads ?? 1) > 1) {
    return { device: "wasm", wasmThreads: 1 };
  }
  return null;
}

/**
 * Keep the current page off a failed WebGPU device without losing a later
 * single-thread WASM recovery request.
 *
 * @param {{ device?: "webgpu" | "wasm", wasmThreads?: number }} preference
 * @param {boolean} webGpuDisabledForSession
 * @returns {{ device?: "webgpu" | "wasm", wasmThreads?: number }}
 */
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

/**
 * Resolve an allowlisted first-party model path to its pinned upstream file.
 * Returning null keeps the Worker route from becoming an open proxy.
 *
 * @param {string} pathname
 */
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
