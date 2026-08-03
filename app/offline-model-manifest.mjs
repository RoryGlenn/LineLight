export const OFFLINE_MODEL_ID =
  "onnx-community/Kokoro-82M-v1.0-ONNX";
export const OFFLINE_MODEL_DTYPE = "q8";
export const OFFLINE_MODEL_RUNTIME = "wasm";
export const OFFLINE_WASM_THREADS = 1;
export const OFFLINE_WASM_PROXY = false;
export const OFFLINE_MODEL_REVISION =
  "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const OFFLINE_MODEL_ROUTE_BASE = "/offline-model/";
export const OFFLINE_MODEL_LOCAL_PATH =
  `${OFFLINE_MODEL_ROUTE_BASE}${OFFLINE_MODEL_REVISION}/`;

export const OFFLINE_MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx",
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

const ALLOWED_OFFLINE_MODEL_FILES = new Set([
  ...OFFLINE_MODEL_FILES,
  ...OFFLINE_VOICE_IDS.map((voice) => `voices/${voice}.bin`),
]);

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
