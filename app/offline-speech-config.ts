import {
  OFFLINE_MODEL_ASSETS,
  OFFLINE_MODEL_BYTES,
  OFFLINE_MODEL_DTYPE,
  OFFLINE_MODEL_FILES,
  OFFLINE_MODEL_ID,
  OFFLINE_MODEL_LOCAL_PATH,
  OFFLINE_MODEL_REVISION,
  OFFLINE_MODEL_RUNTIME,
  OFFLINE_MODEL_URLS,
  OFFLINE_VOICE_ASSETS,
  OFFLINE_VOICE_BYTES,
  OFFLINE_VOICE_IDS,
  OFFLINE_VOICE_URLS,
  OFFLINE_WASM_PROXY,
  OFFLINE_WASM_THREADS,
} from "./offline-model-manifest.mjs";

export {
  OFFLINE_MODEL_ASSETS,
  OFFLINE_MODEL_BYTES,
  OFFLINE_MODEL_DTYPE,
  OFFLINE_MODEL_FILES,
  OFFLINE_MODEL_ID,
  OFFLINE_MODEL_LOCAL_PATH,
  OFFLINE_MODEL_REVISION,
  OFFLINE_MODEL_RUNTIME,
  OFFLINE_MODEL_URLS,
  OFFLINE_VOICE_ASSETS,
  OFFLINE_VOICE_BYTES,
  OFFLINE_VOICE_IDS,
  OFFLINE_VOICE_URLS,
  OFFLINE_WASM_PROXY,
  OFFLINE_WASM_THREADS,
};

export const OFFLINE_MODEL_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;
export const OFFLINE_MODEL_CACHE_NAME = "linelight-offline-model-v2";
export const OFFLINE_VOICE_CACHE_NAME = "linelight-offline-voices-v2";
export const OFFLINE_DEFAULT_VOICE = "F2";

export const OFFLINE_VOICES = [
  {
    value: "F1",
    label: "Studio F1",
    description: "Female style · native 44.1 kHz",
  },
  {
    value: "F2",
    label: "Studio F2",
    description: "Female style · native 44.1 kHz",
  },
  {
    value: "F3",
    label: "Studio F3",
    description: "Female style · native 44.1 kHz",
  },
  {
    value: "F4",
    label: "Studio F4",
    description: "Female style · native 44.1 kHz",
  },
  {
    value: "F5",
    label: "Studio F5",
    description: "Female style · native 44.1 kHz",
  },
  {
    value: "M1",
    label: "Studio M1",
    description: "Male style · native 44.1 kHz",
  },
  {
    value: "M2",
    label: "Studio M2",
    description: "Male style · native 44.1 kHz",
  },
  {
    value: "M3",
    label: "Studio M3",
    description: "Male style · native 44.1 kHz",
  },
  {
    value: "M4",
    label: "Studio M4",
    description: "Male style · native 44.1 kHz",
  },
  {
    value: "M5",
    label: "Studio M5",
    description: "Male style · native 44.1 kHz",
  },
] as const;

export type OfflineVoiceId = (typeof OFFLINE_VOICES)[number]["value"];

export function normalizeOfflineVoiceId(value: unknown): OfflineVoiceId {
  if (
    typeof value === "string" &&
    OFFLINE_VOICES.some((voice) => voice.value === value)
  ) {
    return value as OfflineVoiceId;
  }
  if (typeof value === "string" && /^(?:[ab]m|m)_/u.test(value)) return "M1";
  return OFFLINE_DEFAULT_VOICE;
}

export const OFFLINE_MODEL_ASSET_BYTES = OFFLINE_MODEL_ASSETS.map(
  (asset) => asset.bytes,
);
export const OFFLINE_VOICE_ASSET_BYTES = OFFLINE_VOICE_ASSETS.map(
  (asset) => asset.bytes,
);
export const OFFLINE_VOICE_SOURCE_URLS = [...OFFLINE_VOICE_URLS];
export const OFFLINE_VOICE_CACHE_URLS = [...OFFLINE_VOICE_URLS];
export const OFFLINE_PACK_BYTES = OFFLINE_MODEL_BYTES + OFFLINE_VOICE_BYTES;
