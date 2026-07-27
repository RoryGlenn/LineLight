export const OFFLINE_MODEL_ID =
  "onnx-community/Kokoro-82M-v1.0-ONNX";
export const OFFLINE_MODEL_REVISION = "main";
export const OFFLINE_MODEL_DTYPE = "q8";
export const OFFLINE_MODEL_BYTES = 92_361_116;
export const OFFLINE_VOICE_BYTES = 522_240;
export const OFFLINE_SPEECH_CHUNK_CHARACTERS = 180;

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

const MODEL_ROOT = `https://huggingface.co/${OFFLINE_MODEL_ID}/resolve/${OFFLINE_MODEL_REVISION}`;

export const OFFLINE_MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx",
] as const;

export const OFFLINE_MODEL_URLS = OFFLINE_MODEL_FILES.map(
  (file) => `${MODEL_ROOT}/${file}`,
);

export const OFFLINE_VOICE_URLS = OFFLINE_VOICES.map(
  (voice) => `${MODEL_ROOT}/voices/${voice.value}.bin`,
);

export const OFFLINE_PACK_BYTES =
  OFFLINE_MODEL_BYTES + OFFLINE_VOICE_BYTES * OFFLINE_VOICES.length;

export const TRANSFORMERS_CACHE_NAME = "transformers-cache";
export const KOKORO_VOICE_CACHE_NAME = "kokoro-voices";
