import {
  AUDIOBOOK_ALIGNMENT_MODEL_ID,
  AUDIOBOOK_ALIGNMENT_MODEL_REVISION,
} from "./audiobook-alignment.mjs";

export const AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_BASE = "/alignment-model/";
export const AUDIOBOOK_ALIGNMENT_MODEL_LOCAL_PATH =
  `${AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_BASE}` +
  `${AUDIOBOOK_ALIGNMENT_MODEL_REVISION}/`;
export const AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_PREFIX =
  `${AUDIOBOOK_ALIGNMENT_MODEL_LOCAL_PATH}${AUDIOBOOK_ALIGNMENT_MODEL_ID}/`;
export const AUDIOBOOK_ALIGNMENT_MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];

const ALLOWED_ALIGNMENT_MODEL_FILES = new Set(
  AUDIOBOOK_ALIGNMENT_MODEL_FILES,
);

/**
 * Resolve only pinned Whisper files used by the local q8 ASR worker. Returning
 * null prevents this same-origin route from becoming an arbitrary proxy.
 *
 * @param {string} pathname
 */
export function resolveAudiobookAlignmentModelRequest(pathname) {
  if (!pathname.startsWith(AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_PREFIX)) {
    return null;
  }
  const file = pathname.slice(AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_PREFIX.length);
  if (!ALLOWED_ALIGNMENT_MODEL_FILES.has(file)) return null;
  return {
    file,
    upstreamUrl:
      `https://huggingface.co/${AUDIOBOOK_ALIGNMENT_MODEL_ID}/resolve/` +
      `${AUDIOBOOK_ALIGNMENT_MODEL_REVISION}/${file}`,
  };
}
