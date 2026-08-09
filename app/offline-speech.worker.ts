import { env as transformersEnv } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import ortWasmUrl from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import {
  KOKORO_VOICE_CACHE_NAME,
  LEGACY_OFFLINE_MODEL_URLS,
  OFFLINE_LEGACY_Q8_MODEL_CACHE_URLS,
  OFFLINE_MODEL_BYTES,
  OFFLINE_MODEL_DTYPE,
  OFFLINE_MODEL_FILES,
  OFFLINE_MODEL_ID,
  OFFLINE_MODEL_LOCAL_PATH,
  OFFLINE_MODEL_RANGE_CHUNK_BYTES,
  OFFLINE_MODEL_URLS,
  OFFLINE_VOICES,
  OFFLINE_VOICE_BYTES,
  OFFLINE_VOICE_CACHE_URLS,
  OFFLINE_VOICE_SOURCE_URLS,
  OFFLINE_WASM_PROXY,
  OFFLINE_WASM_THREADS,
  TRANSFORMERS_CACHE_NAME,
  type OfflineVoiceId,
} from "./offline-speech-config";
import {
  OFFLINE_LEGACY_Q8_MODEL_BYTES,
  OFFLINE_LEGACY_Q8_MODEL_URL,
  OFFLINE_FP16_READY_MARKER_URL,
  OFFLINE_FP16_READY_MARKER_VERSION,
  OFFLINE_RUNTIME_CACHE_NAME,
  OFFLINE_WEBGPU_MODEL_BYTES,
  OFFLINE_WEBGPU_MODEL_DTYPE,
  OFFLINE_WEBGPU_MODEL_FILE,
  OFFLINE_WEBGPU_MODEL_URL,
  OFFLINE_WEBGPU_ADAPTER_TIMEOUT_MS,
  probeWebGpuAdapter,
  selectOfflineModelDtype,
  selectOfflineSpeechBackend,
} from "./offline-model-manifest.mjs";
import {
  ensureCachedOfflineAsset,
  isCachedOfflineAssetComplete,
} from "./offline-pack-installer.mjs";
import {
  commitOfflineModelReadyMarker,
  createOfflineModelCacheAdapter,
  deleteOfflineModelArtifactEntries,
  retainOfflineRuntimeAssets,
} from "./offline-model-cache.mjs";
import {
  buildWordPhonemeBatch,
  buildPhonemeWeightedBoundaries,
  countBatchedWordPhonemes,
  extractTimedWords,
  generateUsableOfflineAudio,
  isOfflineBackendRuntimeFailure,
  measureOfflineAudioLeadIn,
} from "./offline-speech-utils.mjs";
import { phonemize } from "./phonemizer-runtime";

type RequestMessage =
  | {
      id: number;
      type: "synthesize";
      text: string;
      voice: OfflineVoiceId;
      rate: number;
      device?: KokoroDevice;
      wasmThreads?: number;
    }
  | {
      id: number;
      type: "initialize";
      voice: OfflineVoiceId;
      warm?: boolean;
      device?: KokoroDevice;
      wasmThreads?: number;
    }
  | {
      id: number;
      type: "install";
      voice: OfflineVoiceId;
      device?: KokoroDevice;
      wasmThreads?: number;
    }
  | { id: number; type: "cancel" };

type WorkerScope = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<RequestMessage>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

type KokoroDevice = "webgpu" | "wasm";

type OfflineBackend = {
  device: KokoroDevice;
  modelDtype:
    | typeof OFFLINE_MODEL_DTYPE
    | typeof OFFLINE_WEBGPU_MODEL_DTYPE
    | "q8";
  wasmThreads: number | null;
};

type OfflineSpeechStage =
  | "downloading"
  | "verifying"
  | "initializing"
  | "warming"
  | "loaded"
  | "ready"
  | "synthesizing";

class BackendUnavailableError extends Error {
  backend: OfflineBackend;

  constructor(backend: OfflineBackend, cause?: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "The selected offline voice backend could not run the model.",
    );
    this.name = "BackendUnavailableError";
    this.backend = backend;
  }
}

const workerScope = globalThis as unknown as WorkerScope;
const wasmModelIndex = OFFLINE_MODEL_FILES.findIndex((file) =>
  file.endsWith(".onnx"),
);
const wasmModelUrl = OFFLINE_MODEL_URLS[wasmModelIndex];

let modelCachePromise: Promise<Cache> | null = null;
function getModelCache() {
  modelCachePromise ??= caches.open(TRANSFORMERS_CACHE_NAME).catch((error) => {
    modelCachePromise = null;
    throw error;
  });
  return modelCachePromise;
}

// Transformers.js v3 accepts a Cache-compatible adapter. Model requests are
// reconstructed from durable ranges, while setup files retain normal Cache
// Storage behavior. Returning a complete virtual response from match() keeps
// Transformers from writing a second full model entry after reading it.
transformersEnv.useCustomCache = true;
transformersEnv.customCache = createOfflineModelCacheAdapter({
  aliases: OFFLINE_MODEL_FILES.flatMap((file, index) =>
    file.endsWith(".onnx")
      ? []
      : [{
          cacheUrl: OFFLINE_MODEL_URLS[index],
          fallbackCacheUrls: [LEGACY_OFFLINE_MODEL_URLS[index]],
        }],
  ),
  baseUrl: globalThis.location.origin,
  getCache: getModelCache,
  models: [
    ...(wasmModelUrl
      ? [{
          cacheUrl: wasmModelUrl,
          expectedBytes: OFFLINE_MODEL_BYTES,
          fallbackCacheUrls:
            wasmModelIndex >= 0
              ? [LEGACY_OFFLINE_MODEL_URLS[wasmModelIndex]]
              : [],
        }]
      : []),
    {
      cacheUrl: OFFLINE_LEGACY_Q8_MODEL_URL,
      expectedBytes: OFFLINE_LEGACY_Q8_MODEL_BYTES,
      fallbackCacheUrls: OFFLINE_LEGACY_Q8_MODEL_CACHE_URLS.filter(
        (cacheUrl) => cacheUrl !== OFFLINE_LEGACY_Q8_MODEL_URL,
      ),
    },
  ],
  rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
});

const wasmBackend = transformersEnv.backends.onnx.wasm;
if (wasmBackend) {
  // Transformers.js otherwise points this runtime at jsDelivr. Keeping the
  // emitted ORT binary on LineLight's origin makes an installed voice genuinely
  // offline and lets the service worker retain the immutable asset.
  wasmBackend.wasmPaths = { wasm: ortWasmUrl };
  wasmBackend.numThreads = 1;
  wasmBackend.proxy = OFFLINE_WASM_PROXY;
}
const canceledRequests = new Set<number>();
const requestAbortControllers = new Map<number, AbortController>();
const lastProgressByRequest = new Map<
  number,
  { label: string; progress: number }
>();
let tts: KokoroTTS | null = null;
let activeBackend: OfflineBackend = {
  device: "wasm",
  modelDtype: OFFLINE_MODEL_DTYPE,
  wasmThreads: 1,
};
let modelIsWarm = false;
const warmedOfflineVoices = new Set<OfflineVoiceId>();
let operationQueue = Promise.resolve();
const verifiedOfflineAssets = new Set<string>();
let webGpuAdapterAvailablePromise: Promise<boolean> | null = null;

function hasWebGpuAdapter() {
  if (webGpuAdapterAvailablePromise) return webGpuAdapterAvailablePromise;

  const gpu = (
    globalThis.navigator as Navigator & {
      gpu?: {
        requestAdapter(options?: {
          powerPreference?: "high-performance" | "low-power";
        }): Promise<{
          features?: { has(feature: string): boolean };
        } | null>;
      };
    }
  ).gpu;
  if (!gpu) {
    webGpuAdapterAvailablePromise = Promise.resolve(false);
    return webGpuAdapterAvailablePromise;
  }

  webGpuAdapterAvailablePromise = probeWebGpuAdapter({
    requestAdapter: () =>
      gpu.requestAdapter({ powerPreference: "high-performance" }),
    timeoutMs: OFFLINE_WEBGPU_ADAPTER_TIMEOUT_MS,
  });
  return webGpuAdapterAvailablePromise;
}

async function hasWasmModelArtifact() {
  if (wasmModelIndex < 0 || !wasmModelUrl) return false;
  try {
    const cache = await getModelCache();
    return (
      (await isCachedOfflineAssetComplete({
        cache,
        cacheUrl: wasmModelUrl,
        expectedBytes: OFFLINE_MODEL_BYTES,
        rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
      })) ||
      (await isCachedOfflineAssetComplete({
        cache,
        cacheUrl: LEGACY_OFFLINE_MODEL_URLS[wasmModelIndex],
        expectedBytes: OFFLINE_MODEL_BYTES,
        rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
      }))
    );
  } catch {
    return false;
  }
}

async function hasLegacyQ8ModelArtifact({ strict = false } = {}) {
  try {
    const cache = await getModelCache();
    const matches = await Promise.all(
      OFFLINE_LEGACY_Q8_MODEL_CACHE_URLS.map((cacheUrl) =>
        isCachedOfflineAssetComplete({
          cache,
          cacheUrl,
          expectedBytes: OFFLINE_LEGACY_Q8_MODEL_BYTES,
          rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
        }),
      ),
    );
    return matches.some(Boolean);
  } catch (error) {
    if (strict) throw error;
    return false;
  }
}

async function selectBackend({
  preferredDevice,
  preferredWasmThreads,
  preferFp16 = false,
}: {
  preferredDevice?: KokoroDevice;
  preferredWasmThreads?: number;
  preferFp16?: boolean;
}) {
  const preferWebGpu = preferredDevice !== "wasm";
  // The fp16 and retained-q8 inspections read independent Cache Storage keys.
  const [fp16Available, legacyQ8Available] = await Promise.all([
    hasWasmModelArtifact(),
    hasLegacyQ8ModelArtifact(),
  ]);
  const modelDtype = selectOfflineModelDtype({
    legacyQ8Available,
    preferFp16,
  });
  const useLegacyQ8 = modelDtype === "q8";
  const webGpuAvailable =
    preferWebGpu &&
    !useLegacyQ8 &&
    fp16Available &&
    (await hasWebGpuAdapter());
  const selectedBackend = selectOfflineSpeechBackend({
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    forceSingleThreadWasm: preferredWasmThreads === 1,
    hardwareConcurrency: globalThis.navigator.hardwareConcurrency,
    preferWebGpu,
    webGpuAvailable,
  }) as {
    device: KokoroDevice;
    wasmThreads: number | null;
  };
  const backend: OfflineBackend = {
    ...selectedBackend,
    modelDtype: useLegacyQ8
      ? "q8"
      : selectedBackend.device === "webgpu"
        ? OFFLINE_WEBGPU_MODEL_DTYPE
        : OFFLINE_MODEL_DTYPE,
  };

  if (useLegacyQ8) backend.device = "wasm";

  if (
    backend.device === "wasm" &&
    preferredWasmThreads &&
    globalThis.crossOriginIsolated === true
  ) {
    backend.wasmThreads = Math.min(
      OFFLINE_WASM_THREADS,
      Math.max(1, Math.floor(preferredWasmThreads)),
    );
  }
  return backend;
}

async function selectInstallBackend({
  preferredDevice,
  preferredWasmThreads,
}: {
  preferredDevice?: KokoroDevice;
  preferredWasmThreads?: number;
}) {
  const preferWebGpu = preferredDevice !== "wasm";
  const selectedBackend = selectOfflineSpeechBackend({
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    forceSingleThreadWasm: preferredWasmThreads === 1,
    hardwareConcurrency: globalThis.navigator.hardwareConcurrency,
    preferWebGpu,
    webGpuAvailable: preferWebGpu && (await hasWebGpuAdapter()),
  }) as {
    device: KokoroDevice;
    wasmThreads: number | null;
  };
  return {
    ...selectedBackend,
    modelDtype:
      selectedBackend.device === "webgpu"
        ? OFFLINE_WEBGPU_MODEL_DTYPE
        : OFFLINE_MODEL_DTYPE,
  } as OfflineBackend;
}

function configureBackend(backend: OfflineBackend) {
  if (!wasmBackend) return;
  wasmBackend.numThreads =
    backend.device === "wasm"
      ? (backend.wasmThreads ?? 1)
      : 1;
  wasmBackend.proxy = OFFLINE_WASM_PROXY;
}

function postProgress(
  id: number,
  progress: number,
  label: string,
  details: {
    backend?: OfflineBackend;
    elapsedMilliseconds?: number;
    stage?: OfflineSpeechStage;
  } = {},
) {
  const normalizedProgress = Math.min(
    100,
    Math.max(0, Math.round(progress)),
  );
  const previous = lastProgressByRequest.get(id);
  if (
    previous?.progress === normalizedProgress &&
    previous.label === label
  ) {
    return;
  }
  lastProgressByRequest.set(id, {
    label,
    progress: normalizedProgress,
  });
  workerScope.postMessage({
    id,
    type: "progress",
    progress: normalizedProgress,
    label,
    ...details,
  });
}

async function disposeModel() {
  if (!tts) return;
  await tts.model.dispose();
  tts = null;
  modelIsWarm = false;
  warmedOfflineVoices.clear();
}

async function assertOfflineFilesAvailable(
  voice: OfflineVoiceId,
  backend: OfflineBackend = activeBackend,
) {
  const [modelCache, voiceCache] = await Promise.all([
    caches.open(TRANSFORMERS_CACHE_NAME),
    caches.open(KOKORO_VOICE_CACHE_NAME),
  ]);
  const selectedVoiceUrl = OFFLINE_VOICE_CACHE_URLS.find((url) =>
    url.endsWith(`/voices/${voice}.bin`),
  );
  const modelMatches = await Promise.all(
    OFFLINE_MODEL_URLS.map(async (url, index) => {
      const file = OFFLINE_MODEL_FILES[index];
      const useLegacyQ8 =
        backend.modelDtype === "q8" && file.endsWith(".onnx");
      const selectedUrl =
        useLegacyQ8
          ? OFFLINE_LEGACY_Q8_MODEL_URL
          : backend.device === "webgpu" && file.endsWith(".onnx")
          ? OFFLINE_WEBGPU_MODEL_URL
          : url;
      const legacyUrl =
        selectedUrl === url
          ? LEGACY_OFFLINE_MODEL_URLS[index]
          : undefined;
      if (file.endsWith(".onnx")) {
        const expectedBytes = useLegacyQ8
          ? OFFLINE_LEGACY_Q8_MODEL_BYTES
          : backend.device === "webgpu"
            ? OFFLINE_WEBGPU_MODEL_BYTES
            : OFFLINE_MODEL_BYTES;
        const candidateUrls = useLegacyQ8
          ? OFFLINE_LEGACY_Q8_MODEL_CACHE_URLS
          : [selectedUrl, ...(legacyUrl ? [legacyUrl] : [])];
        const candidates = await Promise.all(
          candidateUrls.map((cacheUrl) =>
            isCachedOfflineAssetComplete({
              cache: modelCache,
              cacheUrl,
              expectedBytes,
              rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
            }),
          ),
        );
        return candidates.some(Boolean);
      }
      return Boolean(
        (await modelCache.match(selectedUrl)) ??
          (legacyUrl ? await modelCache.match(legacyUrl) : undefined),
      );
    }),
  );
  const voiceMatch = selectedVoiceUrl
    ? await voiceCache.match(selectedVoiceUrl)
    : undefined;
  let voiceComplete = false;
  if (voiceMatch) {
    const declaredLength = voiceMatch.headers.get("content-length");
    voiceComplete = declaredLength === null
      ? (await voiceMatch.clone().arrayBuffer()).byteLength ===
        OFFLINE_VOICE_BYTES
      : Number(declaredLength) === OFFLINE_VOICE_BYTES;
  }

  if (modelMatches.some((match) => !match) || !voiceComplete) {
    throw new Error(
      "The included offline voice is incomplete. Reconnect to the internet and prepare it again.",
    );
  }
}

async function loadModel(
  id: number,
  {
    preferredDevice,
    preferredWasmThreads,
    preferFp16 = false,
    selectedBackend: suppliedBackend,
  }: {
    preferredDevice?: KokoroDevice;
    preferredWasmThreads?: number;
    preferFp16?: boolean;
    selectedBackend?: OfflineBackend;
  },
) {
  const selectedBackend =
    suppliedBackend ??
    (await selectBackend({
      preferredDevice,
      preferredWasmThreads,
      preferFp16,
    }));
  if (
    tts &&
    activeBackend.device === selectedBackend.device &&
    activeBackend.modelDtype === selectedBackend.modelDtype &&
    activeBackend.wasmThreads === selectedBackend.wasmThreads
  ) {
    postProgress(id, 62, "The included voice model is loaded.", {
      backend: activeBackend,
      stage: "initializing",
    });
    return tts;
  }
  if (tts) await disposeModel();
  configureBackend(selectedBackend);
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
    const expectedModelBytes =
      selectedBackend.modelDtype === "q8"
        ? OFFLINE_LEGACY_Q8_MODEL_BYTES
        : selectedBackend.device === "webgpu"
        ? OFFLINE_WEBGPU_MODEL_BYTES
        : OFFLINE_MODEL_BYTES;
    const modelFraction =
      knownTotal > 0
        ? knownLoaded / Math.max(knownTotal, expectedModelBytes)
        : (event.progress ?? 0) / 100;
    const modelProgress = 8 + Math.min(1, modelFraction) * 54;
    const fileLabel = event.file?.includes("onnx/")
      ? "Loading the included neural voice model…"
      : "Preparing the included voice model…";
    postProgress(id, Math.min(62, modelProgress), fileLabel, {
      backend: selectedBackend,
      stage: "initializing",
    });
  };

  const createModel = async (backend: OfflineBackend) => {
    if (backend.device === "wasm") {
      return KokoroTTS.from_pretrained(OFFLINE_MODEL_ID, {
        dtype: backend.modelDtype,
        device: "wasm",
        progress_callback: progressCallback,
      });
    }

    return KokoroTTS.from_pretrained(OFFLINE_MODEL_ID, {
      dtype: OFFLINE_WEBGPU_MODEL_DTYPE,
      device: "webgpu",
      progress_callback: progressCallback,
    });
  };

  try {
    tts = await createModel(selectedBackend);
    activeBackend = selectedBackend;
  } catch (error) {
    await disposeModel().catch(() => undefined);
    if (
      selectedBackend.device === "webgpu" ||
      isOfflineBackendRuntimeFailure(error)
    ) {
      throw new BackendUnavailableError(selectedBackend, error);
    }
    throw error;
  }
  postProgress(id, 62, "The included voice model is loaded.", {
    backend: activeBackend,
    stage: "initializing",
  });
  return tts;
}

const MODEL_DOWNLOAD_PROGRESS = [2, 5, 8, 92] as const;
function modelAssetLabel(file: string) {
  return file.endsWith(".onnx")
    ? "The included neural voice model"
    : "The included voice setup";
}

async function installModelFiles(
  id: number,
  backend: OfflineBackend,
  signal?: AbortSignal,
) {
  const modelCache = await caches.open(TRANSFORMERS_CACHE_NAME);

  for (let index = 0; index < OFFLINE_MODEL_URLS.length; index += 1) {
    const defaultSourceUrl = OFFLINE_MODEL_URLS[index];
    const defaultFile = OFFLINE_MODEL_FILES[index];
    const isModelFile = defaultFile.endsWith(".onnx");
    const sourceUrl =
      backend.device === "webgpu" && isModelFile
        ? OFFLINE_WEBGPU_MODEL_URL
        : defaultSourceUrl;
    const legacyUrl =
      sourceUrl === defaultSourceUrl
        ? LEGACY_OFFLINE_MODEL_URLS[index]
        : undefined;
    const file =
      backend.device === "webgpu" && isModelFile
        ? OFFLINE_WEBGPU_MODEL_FILE
        : defaultFile;
    const targetProgress = MODEL_DOWNLOAD_PROGRESS[index] ?? 92;
    const expectedModelBytes =
      backend.device === "webgpu"
        ? OFFLINE_WEBGPU_MODEL_BYTES
        : OFFLINE_MODEL_BYTES;
    const cached = isModelFile
      ? (await isCachedOfflineAssetComplete({
          cache: modelCache,
          cacheUrl: sourceUrl,
          expectedBytes: expectedModelBytes,
          rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
        })) ||
        Boolean(
          legacyUrl &&
            (await isCachedOfflineAssetComplete({
              cache: modelCache,
              cacheUrl: legacyUrl,
              expectedBytes: expectedModelBytes,
              rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
            })),
        )
      : Boolean(
          (await modelCache.match(sourceUrl)) ??
            (legacyUrl ? await modelCache.match(legacyUrl) : undefined),
        );

    if (!cached) {
      const startProgress =
        index === 0 ? 0 : (MODEL_DOWNLOAD_PROGRESS[index - 1] ?? 0);
      const downloadLabel = file.endsWith(".onnx")
        ? "Downloading the included neural voice model…"
        : "Downloading the included voice setup…";
      postProgress(
        id,
        startProgress,
        downloadLabel,
        { backend, stage: "downloading" },
      );
      await ensureCachedOfflineAsset({
        cache: modelCache,
        cacheUrl: sourceUrl,
        expectedBytes: isModelFile ? expectedModelBytes : undefined,
        label: modelAssetLabel(file),
        onDownloadProgress: ({
          loaded,
          total,
        }: {
          loaded: number;
          total: number | null;
        }) => {
          if (!total) return;
          const fileProgress = Math.min(1, loaded / total);
          postProgress(
            id,
            startProgress + fileProgress * (targetProgress - startProgress),
            downloadLabel,
            { backend, stage: "downloading" },
          );
        },
        rangeBacked: isModelFile,
        rangeChunkBytes: isModelFile
          ? OFFLINE_MODEL_RANGE_CHUNK_BYTES
          : undefined,
        signal,
        sourceUrl,
      });
    }

    postProgress(
      id,
      targetProgress,
      file.endsWith(".onnx")
        ? "Included neural voice model downloaded."
        : "Included voice setup downloaded.",
      { backend, stage: "downloading" },
    );
  }
}

async function installVoices(id: number, signal?: AbortSignal) {
  const voiceCache = await caches.open(KOKORO_VOICE_CACHE_NAME);

  for (let index = 0; index < OFFLINE_VOICE_SOURCE_URLS.length; index += 1) {
    const sourceUrl = OFFLINE_VOICE_SOURCE_URLS[index];
    const cacheUrl = OFFLINE_VOICE_CACHE_URLS[index];
    const startProgress =
      92 + (index * 6) / OFFLINE_VOICE_SOURCE_URLS.length;
    const targetProgress =
      92 + ((index + 1) * 6) / OFFLINE_VOICE_SOURCE_URLS.length;
    const downloadLabel =
      `Adding included ${OFFLINE_VOICES[index].label}…`;
    await ensureCachedOfflineAsset({
      cache: voiceCache,
      cacheUrl,
      expectedBytes: OFFLINE_VOICE_BYTES,
      label: `The included ${OFFLINE_VOICES[index].label} voice`,
      onDownloadProgress: ({
        loaded,
        total,
      }: {
        loaded: number;
        total: number | null;
      }) => {
        if (!total) return;
        const voiceProgress = Math.min(1, loaded / total);
        postProgress(
          id,
          startProgress + voiceProgress * (targetProgress - startProgress),
          downloadLabel,
          { stage: "downloading" },
        );
      },
      signal,
      sourceUrl,
    });

    postProgress(
      id,
      targetProgress,
      downloadLabel,
      { stage: "downloading" },
    );
  }
}

async function removeUnusedModelArtifact() {
  if (activeBackend.modelDtype === "q8") return;
  const modelCache = await caches.open(TRANSFORMERS_CACHE_NAME);
  await Promise.all(
    OFFLINE_LEGACY_Q8_MODEL_CACHE_URLS.map((cacheUrl) =>
      deleteOfflineModelArtifactEntries({
        baseUrl: globalThis.location.origin,
        cache: modelCache,
        cacheUrl,
      }),
    ),
  );
  if (await hasLegacyQ8ModelArtifact({ strict: true })) {
    throw new Error(
      "The faster offline voice is ready, but the stored compatibility model could not be removed. Try the update again.",
    );
  }
}

async function retainOfflineSpeechRuntime() {
  await retainOfflineRuntimeAssets({
    cache: await caches.open(OFFLINE_RUNTIME_CACHE_NAME),
    assets: [
      {
        cacheUrl: globalThis.location.href,
        expectedContentType: "javascript",
        label: "The offline voice worker",
      },
      {
        cacheUrl: new URL(ortWasmUrl, globalThis.location.origin).href,
        expectedContentType: "application/wasm",
        label: "The offline voice runtime",
      },
    ],
  });
}

async function ensureRequestedFallbackFiles(
  id: number,
  voice: OfflineVoiceId,
  preferredDevice: KokoroDevice | undefined,
  preferredWasmThreads: number | undefined,
  signal: AbortSignal,
) {
  if (preferredDevice !== "wasm") return;
  if (
    (await hasWasmModelArtifact()) ||
    (await hasLegacyQ8ModelArtifact())
  ) {
    return;
  }

  const backend = await selectInstallBackend({
    preferredDevice: "wasm",
    preferredWasmThreads,
  });
  postProgress(id, 2, "Preparing the local compatibility model…", {
    backend,
    stage: "downloading",
  });
  // Keep the last complete artifact recoverable until its replacement has
  // downloaded and warmed successfully. Cleanup runs only after that commit.
  await installModelFiles(id, backend, signal);
  await installVoices(id, signal);
  await assertOfflineFilesAvailable(voice, backend);
}

async function removeObsoleteModelArtifacts() {
  try {
    const cache = await getModelCache();
    const currentPaths = new Set(
      [
        wasmModelUrl,
        OFFLINE_WEBGPU_MODEL_URL,
        ...OFFLINE_LEGACY_Q8_MODEL_CACHE_URLS,
        wasmModelIndex >= 0
          ? LEGACY_OFFLINE_MODEL_URLS[wasmModelIndex]
          : undefined,
      ]
        .filter((url): url is string => Boolean(url))
        .map((url) => new URL(url, globalThis.location.origin).pathname),
    );
    const keys = await cache.keys();
    await Promise.allSettled(
      keys
        .filter((request) => {
          const url = new URL(request.url);
          return (
            url.pathname.includes(`/${OFFLINE_MODEL_ID}/`) &&
            url.pathname.endsWith(".onnx") &&
            !currentPaths.has(url.pathname)
          );
        })
        .map((request) => cache.delete(request)),
    );
  } catch {
    // Obsolete data must not turn an otherwise valid installation into an error.
  }
}

async function initializeSpeech(
  id: number,
  voice: OfflineVoiceId,
  preferredDevice?: KokoroDevice,
  preferredWasmThreads?: number,
  warm = true,
  preferFp16 = false,
) {
  const totalStartedAt = performance.now();
  postProgress(id, 2, "Verifying the downloaded offline voice…", {
    stage: "verifying",
  });
  const verificationStartedAt = performance.now();
  const selectedBackend = await selectBackend({
    preferredDevice,
    preferredWasmThreads,
    preferFp16,
  });
  await assertOfflineFilesAvailable(voice, selectedBackend);
  verifiedOfflineAssets.add(
    `${selectedBackend.device}:${selectedBackend.modelDtype}:${selectedBackend.wasmThreads ?? "gpu"}:${voice}`,
  );
  const cacheVerificationMilliseconds =
    performance.now() - verificationStartedAt;

  postProgress(id, 8, "Initializing the offline voice runtime…", {
    backend: selectedBackend,
    elapsedMilliseconds: performance.now() - totalStartedAt,
    stage: "initializing",
  });
  const modelStartedAt = performance.now();
  const model = await loadModel(id, {
    preferredDevice: selectedBackend.device,
    preferredWasmThreads: selectedBackend.wasmThreads ?? undefined,
    preferFp16,
    selectedBackend,
  });
  const modelInitializationMilliseconds =
    performance.now() - modelStartedAt;

  const warmupStartedAt = performance.now();
  if (warm && (!modelIsWarm || !warmedOfflineVoices.has(voice))) {
    postProgress(id, 76, "Warming the offline voice…", {
      backend: activeBackend,
      elapsedMilliseconds: performance.now() - totalStartedAt,
      stage: "warming",
    });
    try {
      await generateUsableOfflineAudio(
        "Ready.",
        (warmText) =>
          model.generate(warmText, {
            voice,
            speed: 1,
          }),
      );
    } catch (error) {
      if (
        activeBackend.device === "webgpu" ||
        isOfflineBackendRuntimeFailure(error)
      ) {
        await disposeModel().catch(() => undefined);
        throw new BackendUnavailableError(activeBackend, error);
      }
      throw error;
    }
    modelIsWarm = true;
    warmedOfflineVoices.add(voice);
  }
  const warmupMilliseconds = performance.now() - warmupStartedAt;
  const totalMilliseconds = performance.now() - totalStartedAt;
  const result = {
    state: warm ? ("ready" as const) : ("loaded" as const),
    device: activeBackend.device,
    modelDtype: activeBackend.modelDtype,
    wasmThreads: activeBackend.wasmThreads,
    timings: {
      cacheVerificationMilliseconds,
      modelInitializationMilliseconds,
      totalMilliseconds,
      warmupMilliseconds,
    },
  };
  postProgress(
    id,
    warm ? 100 : 94,
    warm
      ? "Offline natural voice is ready."
      : "The included voice model is loaded.",
    {
      backend: activeBackend,
      elapsedMilliseconds: totalMilliseconds,
      stage: warm ? "ready" : "loaded",
    },
  );
  return result;
}

async function generateSpeech(
  id: number,
  text: string,
  voice: OfflineVoiceId,
  rate: number,
  offlineOnly: boolean,
  preferredDevice?: KokoroDevice,
  preferredWasmThreads?: number,
) {
  postProgress(id, 2, "Checking the included offline voice…", {
    stage: "verifying",
  });
  postProgress(id, 7, "Preparing the included voice model…", {
    stage: "initializing",
  });
  const selectedBackend = await selectBackend({
    preferredDevice,
    preferredWasmThreads,
  });
  const verificationKey =
    `${selectedBackend.device}:${selectedBackend.modelDtype}:${selectedBackend.wasmThreads ?? "gpu"}:${voice}`;
  if (offlineOnly && !verifiedOfflineAssets.has(verificationKey)) {
    await assertOfflineFilesAvailable(voice, selectedBackend);
    verifiedOfflineAssets.add(verificationKey);
  }
  const model = await loadModel(id, {
    preferredDevice,
    preferredWasmThreads,
    selectedBackend,
  });

  postProgress(id, 68, "Generating narration audio…", {
    backend: activeBackend,
    stage: "synthesizing",
  });
  const startedAt = performance.now();
  let audio;
  try {
    audio = await generateUsableOfflineAudio(text, (generationText) =>
      model.generate(generationText, {
        voice,
        speed: Math.min(2, Math.max(0.5, rate || 1)),
      }),
    );
  } catch (error) {
    if (
      activeBackend.device === "webgpu" ||
      isOfflineBackendRuntimeFailure(error)
    ) {
      await disposeModel().catch(() => undefined);
      throw new BackendUnavailableError(activeBackend, error);
    }
    throw error;
  }
  const synthesisMilliseconds = performance.now() - startedAt;
  modelIsWarm = true;
  warmedOfflineVoices.add(voice);
  const durationSeconds = audio.audio.length / audio.sampling_rate;
  const audioData = audio.toWav();
  const timedWords = extractTimedWords(text);
  let phonemeCounts: number[] = [];
  if (timedWords.length) {
    try {
      const phonemeEntries = await phonemize(
        buildWordPhonemeBatch(timedWords),
        voice.startsWith("b") ? "en-gb" : "en-us",
      );
      phonemeCounts = countBatchedWordPhonemes(
        timedWords,
        phonemeEntries,
      );
    } catch {
      // Boundary construction retains its source-length fallback if the
      // auxiliary pronunciation pass is unavailable. Audio remains usable.
    }
  }
  const boundaries = buildPhonemeWeightedBoundaries(
    text,
    durationSeconds,
    phonemeCounts,
    {
      leadingSilenceSeconds: measureOfflineAudioLeadIn(
        audio.audio,
        audio.sampling_rate,
      ),
    },
  );
  postProgress(id, 94, "Narration audio is generated.", {
    backend: activeBackend,
    elapsedMilliseconds: synthesisMilliseconds,
    stage: "synthesizing",
  });
  return {
    audioData,
    audioDurationSeconds: durationSeconds,
    boundaries,
    device: activeBackend.device,
    modelDtype: activeBackend.modelDtype,
    synthesisMilliseconds,
    wasmThreads:
      activeBackend.device === "wasm"
        ? activeBackend.wasmThreads
        : null,
  };
}

async function handleRequest(
  message: Exclude<RequestMessage, { type: "cancel" }>,
) {
  const { id } = message;
  if (canceledRequests.delete(id)) {
    lastProgressByRequest.delete(id);
    return;
  }

  const abortController = new AbortController();
  requestAbortControllers.set(id, abortController);
  try {
    let result: unknown;
    if (message.type === "install") {
      postProgress(id, 0, "Preparing LineLight's included offline voice…", {
        stage: "downloading",
      });
      const installBackend = await selectInstallBackend({
        preferredDevice: message.device,
        preferredWasmThreads: message.wasmThreads,
      });
      await removeObsoleteModelArtifacts();
      await installModelFiles(id, installBackend, abortController.signal);
      await installVoices(id, abortController.signal);
      postProgress(id, 99, "Verifying the included offline voices…", {
        backend: installBackend,
        stage: "verifying",
      });
      await assertOfflineFilesAvailable(
        message.voice,
        installBackend,
      );
      transformersEnv.allowLocalModels = true;
      transformersEnv.allowRemoteModels = false;
      result = await initializeSpeech(
        id,
        message.voice,
        installBackend.device,
        installBackend.wasmThreads ?? undefined,
        true,
        true,
      );
      await retainOfflineSpeechRuntime();
      await removeUnusedModelArtifact();
      await commitOfflineModelReadyMarker({
        cache: await getModelCache(),
        cacheUrl: OFFLINE_FP16_READY_MARKER_URL,
        value: OFFLINE_FP16_READY_MARKER_VERSION,
      });
    } else if (message.type === "initialize") {
      const warm = message.warm !== false;
      await ensureRequestedFallbackFiles(
        id,
        message.voice,
        message.device,
        message.wasmThreads,
        abortController.signal,
      );
      result = await initializeSpeech(
        id,
        message.voice,
        message.device,
        message.wasmThreads,
        warm,
      );
      // A background model load has not validated synthesis yet. Keep the
      // legacy q8 artifact until a warm probe or real narration succeeds so an
      // interrupted fp16 migration always retains a recoverable voice.
      if (warm) {
        await retainOfflineSpeechRuntime().catch(() => undefined);
        await removeUnusedModelArtifact().catch(() => undefined);
      }
    } else {
      if (!message.text.trim()) {
        throw new Error("There is no text left to narrate.");
      }
      await ensureRequestedFallbackFiles(
        id,
        message.voice,
        message.device,
        message.wasmThreads,
        abortController.signal,
      );
      result = await generateSpeech(
        id,
        message.text,
        message.voice,
        message.rate,
        true,
        message.device,
        message.wasmThreads,
      );
      void retainOfflineSpeechRuntime().catch(() => undefined);
      await removeUnusedModelArtifact().catch(() => undefined);
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
        error instanceof BackendUnavailableError
          ? "backend_failed"
          : undefined,
      backend:
        error instanceof BackendUnavailableError
          ? error.backend
          : undefined,
      message:
        error instanceof Error
          ? error.message
          : "The offline voice could not continue.",
    });
  } finally {
    requestAbortControllers.delete(id);
    lastProgressByRequest.delete(id);
  }
}

workerScope.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "cancel") {
    canceledRequests.add(message.id);
    requestAbortControllers.get(message.id)?.abort();
    return;
  }
  operationQueue = operationQueue.then(() => handleRequest(message));
});
