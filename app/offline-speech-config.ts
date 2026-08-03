import {
  OFFLINE_MODEL_DTYPE,
  OFFLINE_MODEL_FILES,
  OFFLINE_MODEL_ID,
  OFFLINE_MODEL_LOCAL_PATH,
  OFFLINE_MODEL_REVISION,
  OFFLINE_MODEL_RUNTIME,
  OFFLINE_VOICE_IDS,
} from "./offline-model-manifest.mjs";

export {
  OFFLINE_MODEL_DTYPE,
  OFFLINE_MODEL_FILES,
  OFFLINE_MODEL_ID,
  OFFLINE_MODEL_LOCAL_PATH,
  OFFLINE_MODEL_REVISION,
  OFFLINE_MODEL_RUNTIME,
};

export const OFFLINE_MODEL_BYTES = 92_361_116;
export const OFFLINE_VOICE_BYTES = 522_240;
export const OFFLINE_SPEECH_CHUNK_CHARACTERS = 360;
export const OFFLINE_SPEECH_LOOKAHEAD_CHUNKS = 3;
export const OFFLINE_WASM_MAX_THREADS = 8;

export const OFFLINE_VOICES = [
  {
    value: "af_heart",
    label: "Heart",
    description: "US English · warm",
  },
  {
    value: "af_bella",
    label: "Bella",
    description: "US English · expressive",
  },
  {
    value: "am_michael",
    label: "Michael",
    description: "US English · calm",
  },
  {
    value: "bf_emma",
    label: "Emma",
    description: "UK English · clear",
  },
  {
    value: "bm_george",
    label: "George",
    description: "UK English · steady",
  },
] as const;

export type OfflineVoiceId = (typeof OFFLINE_VOICES)[number]["value"];

const LOCAL_MODEL_ROOT = `${OFFLINE_MODEL_LOCAL_PATH}${OFFLINE_MODEL_ID}`;
const KOKORO_VOICE_CACHE_ROOT =
  `https://huggingface.co/${OFFLINE_MODEL_ID}/resolve/main`;
const LEGACY_MODEL_CACHE_ROOT = KOKORO_VOICE_CACHE_ROOT;

export const OFFLINE_MODEL_URLS = OFFLINE_MODEL_FILES.map(
  (file) => `${LOCAL_MODEL_ROOT}/${file}`,
);

export const LEGACY_OFFLINE_MODEL_URLS = OFFLINE_MODEL_FILES.map(
  (file) => `${LEGACY_MODEL_CACHE_ROOT}/${file}`,
);

export const OFFLINE_VOICE_SOURCE_URLS = OFFLINE_VOICE_IDS.map(
  (voice) => `${LOCAL_MODEL_ROOT}/voices/${voice}.bin`,
);

// kokoro-js currently looks up voice files under this exact cache key.
export const OFFLINE_VOICE_CACHE_URLS = OFFLINE_VOICE_IDS.map(
  (voice) => `${KOKORO_VOICE_CACHE_ROOT}/voices/${voice}.bin`,
);

export const OFFLINE_PACK_BYTES =
  OFFLINE_MODEL_BYTES + OFFLINE_VOICE_BYTES * OFFLINE_VOICES.length;

export const TRANSFORMERS_CACHE_NAME = "transformers-cache";
export const KOKORO_VOICE_CACHE_NAME = "kokoro-voices";
