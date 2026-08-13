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
  OFFLINE_DEFAULT_VOICE as OFFLINE_DEFAULT_VOICE_VALUE,
  OFFLINE_VOICE_ASSETS,
  OFFLINE_VOICE_BYTES,
  OFFLINE_VOICE_IDS,
  OFFLINE_VOICE_URLS,
  OFFLINE_WASM_PROXY,
  OFFLINE_WASM_THREADS,
  normalizeOfflineVoiceId as normalizeOfflineVoiceIdValue,
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
export const OFFLINE_VOICE_CACHE_NAME = "linelight-offline-voices-v5";
export const OFFLINE_RETIRED_VOICE_CACHE_NAMES = [
  "linelight-offline-voices-v4",
  "linelight-offline-voices-v3",
  "linelight-offline-voices-v2",
] as const;
export const OFFLINE_VOICES = [
  {
    value: "F4",
    label: "Female",
    description: "Warm, conversational studio voice · native 44.1 kHz",
  },
  {
    value: "M2",
    label: "Male",
    description: "Deep, grounded studio voice · native 44.1 kHz",
  },
] as const;

export type OfflineVoiceId = (typeof OFFLINE_VOICES)[number]["value"];

export const OFFLINE_DEFAULT_VOICE =
  OFFLINE_DEFAULT_VOICE_VALUE as OfflineVoiceId;

export function normalizeOfflineVoiceId(value: unknown): OfflineVoiceId {
  return normalizeOfflineVoiceIdValue(value) as OfflineVoiceId;
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
