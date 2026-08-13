// Supertonic browser inference is adapted from Supertone Inc.'s MIT-licensed
// reference implementation at commit 7e2804f96016a7028cb1ed627353c61c1e9dd281.
// LineLight keeps the runtime dependency-injected so the dedicated worker owns
// ONNX sessions and tests can verify text/audio contracts without model files.

export const SUPERTONIC_SAMPLE_RATE = 44_100;
export const SUPERTONIC_SYNTHESIS_STEPS = 12;
export const SUPERTONIC_MAX_SEGMENT_CHARACTERS = 300;
const SUPERTONIC_SEGMENT_SILENCE_SECONDS = 0.3;
const MAX_GENERATED_AUDIO_SECONDS = 90;

const SUPERTONIC_LANGUAGES = new Set([
  "ar",
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fi",
  "fr",
  "hi",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "lt",
  "lv",
  "na",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
  "tr",
  "uk",
  "vi",
]);

function abortReason(signal) {
  if (!signal?.aborted) return undefined;
  return signal.reason ?? new DOMException("Offline narration was canceled.", "AbortError");
}

function throwIfAborted(signal) {
  const reason = abortReason(signal);
  if (reason !== undefined) throw reason;
}

function product(values) {
  return values.reduce((total, value) => total * value, 1);
}

function flattenNumbers(value, output = []) {
  if (Array.isArray(value)) {
    for (const entry of value) flattenNumbers(entry, output);
    return output;
  }
  if (!Number.isFinite(value)) {
    throw new TypeError("The offline voice style contains invalid values.");
  }
  output.push(value);
  return output;
}

function validateStyleTensor(value, expectedDims, label) {
  if (
    !value ||
    !Array.isArray(value.dims) ||
    value.dims.length !== expectedDims.length ||
    value.dims.some((dimension, index) => dimension !== expectedDims[index])
  ) {
    throw new TypeError(`${label} has an unexpected shape.`);
  }
  const data = Float32Array.from(flattenNumbers(value.data));
  if (data.length !== product(expectedDims)) {
    throw new TypeError(`${label} is incomplete.`);
  }
  return data;
}

/**
 * Convert one pinned Supertonic voice-style JSON file into ONNX tensors.
 *
 * @param {unknown} value
 * @param {new (type: string, data: ArrayBufferView, dims: number[]) => unknown} Tensor
 */
export function createSupertonicVoiceStyle(value, Tensor) {
  if (!value || typeof value !== "object" || typeof Tensor !== "function") {
    throw new TypeError("The offline voice style is unavailable.");
  }
  const style = /** @type {Record<string, any>} */ (value);
  const ttlDims = [1, 50, 256];
  const dpDims = [1, 8, 16];
  return {
    ttl: new Tensor(
      "float32",
      validateStyleTensor(style.style_ttl, ttlDims, "The text voice style"),
      ttlDims,
    ),
    dp: new Tensor(
      "float32",
      validateStyleTensor(style.style_dp, dpDims, "The duration voice style"),
      dpDims,
    ),
  };
}

/**
 * Normalize prose using the model's reviewed browser preprocessing contract.
 *
 * @param {string} source
 * @param {string} [language]
 */
export function preprocessSupertonicText(source, language = "en") {
  if (typeof source !== "string" || !source.trim()) {
    throw new TypeError("Offline narration needs text to speak.");
  }
  if (!SUPERTONIC_LANGUAGES.has(language)) {
    throw new TypeError("The selected offline narration language is unsupported.");
  }

  let text = source
    .normalize("NFKD")
    .replace(
      /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+/gu,
      "",
    );
  const replacements = new Map([
    ["–", "-"],
    ["‑", "-"],
    ["—", "-"],
    ["_", " "],
    ["“", '"'],
    ["”", '"'],
    ["‘", "'"],
    ["’", "'"],
    ["´", "'"],
    ["`", "'"],
    ["[", " "],
    ["]", " "],
    ["|", " "],
    ["/", " "],
    ["#", " "],
    ["→", " "],
    ["←", " "],
    ["@", " at "],
    ["e.g.,", "for example, "],
    ["i.e.,", "that is, "],
  ]);
  for (const [needle, replacement] of replacements) {
    text = text.replaceAll(needle, replacement);
  }
  text = text
    .replace(/[♥☆♡©\\]/gu, "")
    .replace(/\s+([,.!?;:'])/gu, "$1")
    .replace(/"{2,}/gu, '"')
    .replace(/'{2,}/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/u.test(text)) text += ".";
  return `<${language}>${text}</${language}>`;
}

/**
 * Split a bounded reader passage at natural punctuation before the model's
 * 300-character single-inference limit.
 *
 * @param {string} source
 * @param {number} [maxCharacters]
 */
export function splitSupertonicText(
  source,
  maxCharacters = SUPERTONIC_MAX_SEGMENT_CHARACTERS,
) {
  if (typeof source !== "string") {
    throw new TypeError("Offline narration text must be a string.");
  }
  const text = source.replace(/\s+/gu, " ").trim();
  if (!text) return [];
  const limit = Math.max(32, Math.floor(maxCharacters));
  const segments = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    let splitAt = -1;
    for (const pattern of [/[.!?;:]\s/gu, /[,—-]\s/gu, /\s/gu]) {
      for (const match of window.matchAll(pattern)) {
        if ((match.index ?? 0) >= Math.floor(limit * 0.55)) {
          splitAt = (match.index ?? 0) + match[0].length;
        }
      }
      if (splitAt > 0) break;
    }
    if (splitAt <= 0) splitAt = limit;
    segments.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) segments.push(remaining);
  return segments;
}

/**
 * Encode mono floating-point samples as native 44.1 kHz PCM-16 WAV.
 *
 * @param {Float32Array | number[]} samples
 * @param {number} [sampleRate]
 */
export function encodePcm16Wave(samples, sampleRate = SUPERTONIC_SAMPLE_RATE) {
  if (
    (!Array.isArray(samples) && !(samples instanceof Float32Array)) ||
    !samples.length ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8_000
  ) {
    throw new TypeError("Offline narration audio is invalid.");
  }
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number(samples[index]);
    if (!Number.isFinite(sample)) {
      throw new TypeError("Offline narration audio contains invalid samples.");
    }
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      44 + index * 2,
      Math.round(clamped < 0 ? clamped * 32_768 : clamped * 32_767),
      true,
    );
  }
  return buffer;
}

class SupertonicAudio {
  /** @param {Float32Array} audio */
  constructor(audio, samplingRate) {
    this.audio = audio;
    this.sampling_rate = samplingRate;
  }

  toWav() {
    return encodePcm16Wave(this.audio, this.sampling_rate);
  }
}

function gaussianRandom(random) {
  const first = Math.max(0.0001, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function asFloat32Data(tensor, label) {
  if (!tensor?.data || !ArrayBuffer.isView(tensor.data)) {
    throw new Error(`${label} returned invalid audio model data.`);
  }
  return tensor.data instanceof Float32Array
    ? tensor.data
    : Float32Array.from(tensor.data);
}

/**
 * Create a private Supertonic inference runtime around four already-loaded
 * ONNX sessions.
 *
 * @param {{
 *   config: Record<string, any>,
 *   indexer: number[],
 *   sessions: {
 *     durationPredictor: { run(feeds: Record<string, unknown>): Promise<Record<string, any>>, release?(): Promise<void> | void },
 *     textEncoder: { run(feeds: Record<string, unknown>): Promise<Record<string, any>>, release?(): Promise<void> | void },
 *     vectorEstimator: { run(feeds: Record<string, unknown>): Promise<Record<string, any>>, release?(): Promise<void> | void },
 *     vocoder: { run(feeds: Record<string, unknown>): Promise<Record<string, any>>, release?(): Promise<void> | void },
 *   },
 *   Tensor: new (type: string, data: ArrayBufferView, dims: number[]) => unknown,
 *   random?: () => number,
 * }} options
 */
export function createSupertonicRuntime({
  config,
  indexer,
  sessions,
  Tensor,
  random = Math.random,
}) {
  const sampleRate = Number(config?.ae?.sample_rate);
  const baseChunkSize = Number(config?.ae?.base_chunk_size);
  const chunkCompress = Number(config?.ttl?.chunk_compress_factor);
  const latentDim = Number(config?.ttl?.latent_dim);
  if (
    sampleRate !== SUPERTONIC_SAMPLE_RATE ||
    !Number.isInteger(baseChunkSize) ||
    baseChunkSize <= 0 ||
    !Number.isInteger(chunkCompress) ||
    chunkCompress <= 0 ||
    !Number.isInteger(latentDim) ||
    latentDim <= 0 ||
    !Array.isArray(indexer) ||
    !indexer.length ||
    typeof Tensor !== "function"
  ) {
    throw new TypeError("The included 44.1 kHz voice configuration is invalid.");
  }

  const textProcessor = (text) => {
    const normalized = preprocessSupertonicText(text, "en");
    const codePoints = Array.from(normalized, (character) =>
      character.codePointAt(0),
    );
    const ids = BigInt64Array.from(codePoints, (codePoint) =>
      BigInt(codePoint < indexer.length ? indexer[codePoint] : -1),
    );
    const mask = new Float32Array(ids.length).fill(1);
    return {
      textIds: new Tensor("int64", ids, [1, ids.length]),
      textMask: new Tensor("float32", mask, [1, 1, ids.length]),
    };
  };

  const synthesizeSegment = async (
    text,
    style,
    { speed, steps, signal, onStep },
  ) => {
    throwIfAborted(signal);
    const { textIds, textMask } = textProcessor(text);
    const durationResult = await sessions.durationPredictor.run({
      text_ids: textIds,
      style_dp: style.dp,
      text_mask: textMask,
    });
    throwIfAborted(signal);
    const durationValues = asFloat32Data(
      durationResult.duration,
      "The duration predictor",
    );
    const duration = durationValues[0] / speed;
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > MAX_GENERATED_AUDIO_SECONDS
    ) {
      throw new Error("The offline voice predicted an invalid audio duration.");
    }

    const encoded = await sessions.textEncoder.run({
      text_ids: textIds,
      style_ttl: style.ttl,
      text_mask: textMask,
    });
    throwIfAborted(signal);
    const textEmbedding = encoded.text_emb;
    if (!textEmbedding) {
      throw new Error("The offline voice text encoder returned no embedding.");
    }

    const chunkSize = baseChunkSize * chunkCompress;
    const waveformLength = Math.floor(duration * sampleRate);
    const latentLength = Math.ceil(waveformLength / chunkSize);
    const expandedLatentDim = latentDim * chunkCompress;
    const latentSize = expandedLatentDim * latentLength;
    let latent = new Float32Array(latentSize);
    for (let index = 0; index < latent.length; index += 1) {
      latent[index] = gaussianRandom(random);
    }
    const latentMaskData = new Float32Array(latentLength).fill(1);
    const latentMask = new Tensor(
      "float32",
      latentMaskData,
      [1, 1, latentLength],
    );
    const totalStep = new Tensor(
      "float32",
      new Float32Array([steps]),
      [1],
    );
    for (let step = 0; step < steps; step += 1) {
      throwIfAborted(signal);
      const denoised = await sessions.vectorEstimator.run({
        noisy_latent: new Tensor(
          "float32",
          latent,
          [1, expandedLatentDim, latentLength],
        ),
        text_emb: textEmbedding,
        style_ttl: style.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new Tensor(
          "float32",
          new Float32Array([step]),
          [1],
        ),
        total_step: totalStep,
      });
      latent = new Float32Array(
        asFloat32Data(denoised.denoised_latent, "The denoiser"),
      );
      if (latent.length !== latentSize) {
        throw new Error("The offline voice denoiser returned an invalid shape.");
      }
      onStep?.();
    }
    throwIfAborted(signal);
    const vocoded = await sessions.vocoder.run({
      latent: new Tensor(
        "float32",
        latent,
        [1, expandedLatentDim, latentLength],
      ),
    });
    const samples = asFloat32Data(vocoded.wav_tts, "The vocoder");
    if (samples.length < waveformLength) {
      throw new Error("The offline voice produced incomplete audio.");
    }
    return {
      duration,
      samples: new Float32Array(samples.slice(0, waveformLength)),
    };
  };

  return {
    sampleRate,

    /**
     * @param {string} text
     * @param {{ style: { ttl: unknown, dp: unknown }, speed?: number, steps?: number, signal?: AbortSignal, onProgress?: (completed: number, total: number) => void }} options
     */
    async generate(text, {
      style,
      speed = 1,
      steps = SUPERTONIC_SYNTHESIS_STEPS,
      signal,
      onProgress,
    }) {
      if (!style?.ttl || !style?.dp) {
        throw new TypeError("The selected offline voice style is unavailable.");
      }
      const normalizedSpeed = Math.min(2, Math.max(0.5, Number(speed) || 1));
      const normalizedSteps = Math.min(12, Math.max(5, Math.floor(steps)));
      const segments = splitSupertonicText(text);
      if (!segments.length) {
        throw new TypeError("Offline narration needs text to speak.");
      }
      const totalSteps = normalizedSteps * segments.length;
      let completedSteps = 0;
      const results = [];
      for (const segment of segments) {
        results.push(
          await synthesizeSegment(segment, style, {
            speed: normalizedSpeed,
            steps: normalizedSteps,
            signal,
            onStep: () => {
              completedSteps += 1;
              onProgress?.(completedSteps, totalSteps);
            },
          }),
        );
      }
      const silenceLength = Math.floor(
        SUPERTONIC_SEGMENT_SILENCE_SECONDS * sampleRate,
      );
      const totalSamples =
        results.reduce((total, result) => total + result.samples.length, 0) +
        Math.max(0, results.length - 1) * silenceLength;
      const combined = new Float32Array(totalSamples);
      let offset = 0;
      for (let index = 0; index < results.length; index += 1) {
        combined.set(results[index].samples, offset);
        offset += results[index].samples.length;
        if (index < results.length - 1) offset += silenceLength;
      }
      return new SupertonicAudio(combined, sampleRate);
    },

    async dispose() {
      await Promise.allSettled(
        Object.values(sessions).map((session) => session.release?.()),
      );
    },
  };
}
