import { env as transformersEnv } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { phonemize } from "phonemizer";
import {
  KOKORO_VOICE_CACHE_NAME,
  LEGACY_OFFLINE_MODEL_URLS,
  OFFLINE_MODEL_BYTES,
  OFFLINE_MODEL_DTYPE,
  OFFLINE_MODEL_ID,
  OFFLINE_MODEL_LOCAL_PATH,
  OFFLINE_MODEL_URLS,
  OFFLINE_VOICES,
  OFFLINE_VOICE_BYTES,
  OFFLINE_VOICE_CACHE_URLS,
  OFFLINE_VOICE_SOURCE_URLS,
  OFFLINE_WASM_MAX_THREADS,
  TRANSFORMERS_CACHE_NAME,
  type OfflineVoiceId,
} from "./offline-speech-config";
import {
  buildWordPhonemeBatch,
  buildPhonemeWeightedBoundaries,
  countBatchedWordPhonemes,
  extractTimedWords,
} from "./offline-speech-utils.mjs";

type RequestMessage =
  | {
      id: number;
      type: "synthesize";
      text: string;
      voice: OfflineVoiceId;
      rate: number;
      device?: KokoroDevice;
    }
  | { id: number; type: "install"; device?: KokoroDevice }
  | { id: number; type: "cancel" };

type WorkerScope = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<RequestMessage>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

type KokoroDevice = "webgpu" | "wasm";

class WebGpuUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "WebGPU could not run the offline voice model.",
    );
    this.name = "WebGpuUnavailableError";
  }
}

const workerScope = globalThis as unknown as WorkerScope;
const canceledRequests = new Set<number>();
let tts: KokoroTTS | null = null;
let activeDevice: KokoroDevice = "wasm";
let operationQueue = Promise.resolve();
const verifiedOfflineVoices = new Set<OfflineVoiceId>();

function postProgress(
  id: number,
  progress: number,
  label: string,
) {
  workerScope.postMessage({
    id,
    type: "progress",
    progress: Math.min(100, Math.max(0, Math.round(progress))),
    label,
  });
}

async function preferredRuntimeDevice(): Promise<KokoroDevice> {
  const gpu = (
    navigator as Navigator & {
      gpu?: {
        requestAdapter(options?: {
          powerPreference?: "low-power" | "high-performance";
        }): Promise<unknown | null>;
      };
    }
  ).gpu;
  if (!gpu) return "wasm";

  try {
    const adapter = await gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    return adapter ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

async function disposeModel() {
  if (!tts) return;
  await tts.model.dispose();
  tts = null;
}

async function assertOfflineFilesAvailable(voice: OfflineVoiceId) {
  const [modelCache, voiceCache] = await Promise.all([
    caches.open(TRANSFORMERS_CACHE_NAME),
    caches.open(KOKORO_VOICE_CACHE_NAME),
  ]);
  const selectedVoiceUrl = OFFLINE_VOICE_CACHE_URLS.find((url) =>
    url.endsWith(`/voices/${voice}.bin`),
  );
  const modelMatches = await Promise.all(
    OFFLINE_MODEL_URLS.map(async (url, index) =>
      Boolean(
        (await modelCache.match(url)) ??
          (await modelCache.match(LEGACY_OFFLINE_MODEL_URLS[index])),
      ),
    ),
  );
  const voiceMatch = selectedVoiceUrl
    ? await voiceCache.match(selectedVoiceUrl)
    : undefined;

  if (modelMatches.some((match) => !match) || !voiceMatch) {
    throw new Error(
      "The included offline voice is incomplete. Reconnect to the internet and prepare it again.",
    );
  }
}

async function loadModel(
  id: number,
  {
    preferredDevice,
  }: {
    preferredDevice?: KokoroDevice;
  },
) {
  if (tts) return tts;

  const selectedDevice =
    preferredDevice ?? (await preferredRuntimeDevice());
  const wasmBackend = transformersEnv.backends.onnx.wasm;
  if (
    selectedDevice === "wasm" &&
    globalThis.crossOriginIsolated &&
    wasmBackend
  ) {
    wasmBackend.numThreads = Math.min(
      OFFLINE_WASM_MAX_THREADS,
      Math.max(1, Math.floor((navigator.hardwareConcurrency || 1) / 2)),
    );
  }
  transformersEnv.localModelPath = new URL(
    OFFLINE_MODEL_LOCAL_PATH,
    globalThis.location.origin,
  ).href;
  transformersEnv.allowLocalModels = true;
  transformersEnv.allowRemoteModels = false;
  const loadedByFile = new Map<string, number>();
  const totalByFile = new Map<string, number>();

  const progressCallback = (event: {
    status: string;
    file?: string;
    loaded?: number;
    total?: number;
    progress?: number;
  }) => {
    if (event.file && Number.isFinite(event.loaded)) {
      loadedByFile.set(event.file, event.loaded ?? 0);
    }
    if (event.file && Number.isFinite(event.total) && event.total) {
      totalByFile.set(event.file, event.total);
    }

    const knownTotal = Array.from(totalByFile.values()).reduce(
      (sum, value) => sum + value,
      0,
    );
    const knownLoaded = Array.from(loadedByFile.values()).reduce(
      (sum, value) => sum + value,
      0,
    );
    const modelProgress =
      knownTotal > 0
        ? (knownLoaded / Math.max(knownTotal, OFFLINE_MODEL_BYTES)) * 92
        : (event.progress ?? 0) * 0.92;
    const fileLabel = event.file?.includes("onnx/")
      ? "Loading the included neural voice model…"
      : "Preparing the included voice model…";
    postProgress(id, Math.min(92, modelProgress), fileLabel);
  };

  const createModel = (device: KokoroDevice) =>
    KokoroTTS.from_pretrained(OFFLINE_MODEL_ID, {
      dtype: OFFLINE_MODEL_DTYPE,
      device,
      progress_callback: progressCallback,
    });

  try {
    tts = await createModel(selectedDevice);
    activeDevice = selectedDevice;
  } catch (error) {
    if (selectedDevice !== "webgpu") throw error;
    await disposeModel().catch(() => undefined);
    throw new WebGpuUnavailableError(error);
  }
  return tts;
}

async function installVoices(id: number) {
  const voiceCache = await caches.open(KOKORO_VOICE_CACHE_NAME);

  for (let index = 0; index < OFFLINE_VOICE_SOURCE_URLS.length; index += 1) {
    const sourceUrl = OFFLINE_VOICE_SOURCE_URLS[index];
    const cacheUrl = OFFLINE_VOICE_CACHE_URLS[index];
    const cached = await voiceCache.match(cacheUrl);
    if (!cached) {
      const response = await fetch(sourceUrl);
      if (!response.ok) {
        throw new Error(
          `The included ${OFFLINE_VOICES[index].label} voice could not be prepared.`,
        );
      }
      await voiceCache.put(cacheUrl, response);
    }

    const voiceProgress =
      ((index + 1) * OFFLINE_VOICE_BYTES) /
      (OFFLINE_VOICE_SOURCE_URLS.length * OFFLINE_VOICE_BYTES);
    postProgress(
      id,
      92 + voiceProgress * 6,
      `Adding included ${OFFLINE_VOICES[index].label}…`,
    );
  }
}

function voiceLanguage(voice: OfflineVoiceId) {
  return voice.startsWith("b") ? "en" : "en-us";
}

async function phonemeCountsForText(
  text: string,
  voice: OfflineVoiceId,
) {
  const language = voiceLanguage(voice);
  const words = extractTimedWords(text);
  if (!words.length) return [];

  const phonemeEntries = await phonemize(
    buildWordPhonemeBatch(words),
    language,
  );
  return countBatchedWordPhonemes(words, phonemeEntries);
}

async function generateSpeech(
  id: number,
  text: string,
  voice: OfflineVoiceId,
  rate: number,
  offlineOnly: boolean,
  preferredDevice?: KokoroDevice,
) {
  if (offlineOnly && !verifiedOfflineVoices.has(voice)) {
    await assertOfflineFilesAvailable(voice);
    verifiedOfflineVoices.add(voice);
  }
  const model = await loadModel(id, {
    preferredDevice,
  });

  try {
    const startedAt = performance.now();
    const [audio, phonemeCounts] = await Promise.all([
      model.generate(text, {
        voice,
        speed: Math.min(2, Math.max(0.5, rate || 1)),
      }),
      phonemeCountsForText(text, voice),
    ]);
    const synthesisMilliseconds = performance.now() - startedAt;
    const durationSeconds = audio.audio.length / audio.sampling_rate;
    return {
      audioData: audio.toWav(),
      audioDurationSeconds: durationSeconds,
      boundaries: buildPhonemeWeightedBoundaries(
        text,
        durationSeconds,
        phonemeCounts,
      ),
      device: activeDevice,
      synthesisMilliseconds,
      wasmThreads:
        activeDevice === "wasm"
          ? (transformersEnv.backends.onnx.wasm?.numThreads ?? 1)
          : null,
    };
  } catch (error) {
    if (activeDevice !== "webgpu") throw error;
    await disposeModel().catch(() => undefined);
    throw new WebGpuUnavailableError(error);
  }
}

async function handleRequest(message: RequestMessage) {
  if (message.type === "cancel") {
    canceledRequests.add(message.id);
    return;
  }

  const { id } = message;
  if (canceledRequests.delete(id)) return;

  try {
    let result: unknown;
    if (message.type === "install") {
      postProgress(id, 0, "Preparing LineLight's included offline voice…");
      await loadModel(id, {
        preferredDevice: message.device,
      });
      await installVoices(id);
      postProgress(id, 98, "Testing the voice on this device…");
      await generateSpeech(
        id,
        "LineLight is ready.",
        OFFLINE_VOICES[0].value,
        1,
        true,
        message.device,
      );
      transformersEnv.allowLocalModels = true;
      transformersEnv.allowRemoteModels = false;
      postProgress(id, 100, "Offline voices are ready.");
      result = { device: activeDevice };
    } else {
      if (!message.text.trim()) {
        throw new Error("There is no text left to narrate.");
      }
      result = await generateSpeech(
        id,
        message.text,
        message.voice,
        message.rate,
        true,
        message.device,
      );
    }

    if (canceledRequests.delete(id)) return;
    if (
      typeof result === "object" &&
      result &&
      "audioData" in result &&
      result.audioData instanceof ArrayBuffer
    ) {
      workerScope.postMessage(
        { id, type: "success", result },
        [result.audioData],
      );
    } else {
      workerScope.postMessage({ id, type: "success", result });
    }
  } catch (error) {
    if (canceledRequests.delete(id)) return;
    workerScope.postMessage({
      id,
      type: "error",
      code:
        error instanceof WebGpuUnavailableError
          ? "webgpu_failed"
          : undefined,
      message:
        error instanceof Error
          ? error.message
          : "The offline voice could not continue.",
    });
  }
}

workerScope.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "cancel") {
    canceledRequests.add(message.id);
    return;
  }
  operationQueue = operationQueue.then(() => handleRequest(message));
});
