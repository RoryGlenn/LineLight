import {
  env as ortEnv,
  InferenceSession,
  setWasmRunCancellationObserver,
  Tensor,
  type WasmRunCancellationEvent,
} from "onnxruntime-web";
import ortWasmUrl from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import {
  OFFLINE_MODEL_ASSET_BYTES,
  OFFLINE_MODEL_ASSETS,
  OFFLINE_MODEL_CACHE_NAME,
  OFFLINE_MODEL_DTYPE,
  OFFLINE_MODEL_FILES,
  OFFLINE_MODEL_RANGE_CHUNK_BYTES,
  OFFLINE_MODEL_URLS,
  OFFLINE_VOICES,
  OFFLINE_VOICE_ASSET_BYTES,
  OFFLINE_VOICE_ASSETS,
  OFFLINE_VOICE_CACHE_NAME,
  OFFLINE_VOICE_CACHE_URLS,
  OFFLINE_VOICE_SOURCE_URLS,
  OFFLINE_WASM_PROXY,
  OFFLINE_WASM_THREADS,
  type OfflineVoiceId,
} from "./offline-speech-config";
import {
  OFFLINE_MODEL_READY_MARKER_URL,
  OFFLINE_MODEL_READY_MARKER_VERSION,
  OFFLINE_LEGACY_MODEL_ID,
  OFFLINE_RUNTIME_CACHE_NAME,
  OFFLINE_WEBGPU_ADAPTER_TIMEOUT_MS,
  probeWebGpuAdapter,
  selectOfflineSpeechBackend,
} from "./offline-model-manifest.mjs";
import {
  ensureCachedOfflineAsset,
  getCachedOfflineAssetResponse,
  isCachedOfflineAssetComplete,
} from "./offline-pack-installer.mjs";
import {
  commitOfflineModelReadyMarker,
  deleteOfflineModelEntriesByIdentifier,
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
  shouldRetryOfflineSpeechBackend,
} from "./offline-speech-utils.mjs";
import { phonemize } from "./phonemizer-runtime";
import {
  SUPERTONIC_SYNTHESIS_STEPS,
  createSupertonicRuntime,
  createSupertonicVoiceStyle,
} from "./supertonic-runtime.mjs";

type RequestMessage =
  | {
      id: number;
      type: "synthesize";
      text: string;
      voice: OfflineVoiceId;
      rate: number;
      device?: OfflineDevice;
      wasmThreads?: number;
    }
  | {
      id: number;
      type: "initialize";
      voice: OfflineVoiceId;
      warm?: boolean;
      device?: OfflineDevice;
      wasmThreads?: number;
    }
  | {
      id: number;
      type: "install";
      voice: OfflineVoiceId;
      device?: OfflineDevice;
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

type ActiveCancellationOwner = {
  id: number;
  sessionGeneration: number;
};

type OfflineDevice = "webgpu" | "wasm";

type OfflineBackend = {
  device: OfflineDevice;
  modelDtype: typeof OFFLINE_MODEL_DTYPE;
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

let modelCachePromise: Promise<Cache> | null = null;
function getModelCache() {
  modelCachePromise ??= caches.open(OFFLINE_MODEL_CACHE_NAME).catch((error) => {
    modelCachePromise = null;
    throw error;
  });
  return modelCachePromise;
}

const wasmBackend = ortEnv.wasm;
if (wasmBackend) {
  // Keep the emitted ORT binary on LineLight's origin so an installed voice is
  // genuinely offline and the service worker can retain the immutable asset.
  wasmBackend.wasmPaths = { wasm: ortWasmUrl };
  wasmBackend.numThreads = 1;
  wasmBackend.proxy = OFFLINE_WASM_PROXY;
}
const canceledRequests = new Set<number>();
const queuedRequests = new Set<number>();
const requestAbortControllers = new Map<number, AbortController>();
const cancellationOwners = new Map<number, ActiveCancellationOwner>();
const lastProgressByRequest = new Map<
  number,
  { label: string; progress: number }
>();
let tts: ReturnType<typeof createSupertonicRuntime> | null = null;
const loadedVoiceStyles = new Map<
  OfflineVoiceId,
  ReturnType<typeof createSupertonicVoiceStyle>
>();
let activeBackend: OfflineBackend = {
  device: "wasm",
  modelDtype: OFFLINE_MODEL_DTYPE,
  wasmThreads: 1,
};
let modelIsWarm = false;
const warmedOfflineVoices = new Set<OfflineVoiceId>();
let operationQueue = Promise.resolve();
let activeRequestId: number | null = null;
let modelSessionGeneration = 0;
const verifiedOfflineAssets = new Set<string>();
let webGpuAdapterAvailablePromise: Promise<boolean> | null = null;

function supportsCooperativeCancellation() {
  return (
    activeBackend.device === "wasm" &&
    (activeBackend.wasmThreads ?? 1) > 1
  );
}

setWasmRunCancellationObserver((event: WasmRunCancellationEvent) => {
  if (event.type === "start") {
    if (
      activeRequestId === null ||
      !supportsCooperativeCancellation() ||
      !event.sharedBuffer ||
      event.activeGenerationIndex === undefined ||
      event.cancellationGenerationIndex === undefined
    ) {
      return;
    }
    cancellationOwners.set(event.generation, {
      id: activeRequestId,
      sessionGeneration: modelSessionGeneration,
    });
    workerScope.postMessage({
      id: activeRequestId,
      type: "wasm-run-start",
      generation: event.generation,
      sharedBuffer: event.sharedBuffer,
      activeGenerationIndex: event.activeGenerationIndex,
      cancellationGenerationIndex: event.cancellationGenerationIndex,
      sessionGeneration: modelSessionGeneration,
    });
    return;
  }

  const owner = cancellationOwners.get(event.generation);
  if (!owner) return;
  cancellationOwners.delete(event.generation);
  workerScope.postMessage({
    id: owner.id,
    type: "wasm-run-end",
    generation: event.generation,
    sessionGeneration: owner.sessionGeneration,
  });
});

function isCooperativeCancellationError(error: unknown) {
  return (
    error instanceof Error &&
    error.name === "AbortError" &&
    "code" in error &&
    error.code === "ERR_ORT_WASM_RUN_CANCELED"
  );
}

function postCanceled(id: number, cooperative: boolean) {
  workerScope.postMessage({
    id,
    type: "canceled",
    cooperative,
    sessionGeneration: modelSessionGeneration,
  });
}

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

async function hasCompleteModelPack() {
  try {
    const cache = await getModelCache();
    const matches = await Promise.all(
      OFFLINE_MODEL_ASSETS.map((asset, index) =>
        isCachedOfflineAssetComplete({
          cache,
          cacheUrl: OFFLINE_MODEL_URLS[index],
          expectedBytes: asset.bytes,
          rangeChunkBytes: asset.rangeBacked
            ? OFFLINE_MODEL_RANGE_CHUNK_BYTES
            : undefined,
        }),
      ),
    );
    return matches.every(Boolean);
  } catch {
    return false;
  }
}

async function selectBackend({
  preferredDevice,
  preferredWasmThreads,
}: {
  preferredDevice?: OfflineDevice;
  preferredWasmThreads?: number;
}) {
  const preferWebGpu = preferredDevice !== "wasm";
  const webGpuAvailable =
    preferWebGpu &&
    (await hasCompleteModelPack()) &&
    (await hasWebGpuAdapter());
  const selectedBackend = selectOfflineSpeechBackend({
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    forceSingleThreadWasm: preferredWasmThreads === 1,
    hardwareConcurrency: globalThis.navigator.hardwareConcurrency,
    preferWebGpu,
    webGpuAvailable,
  }) as {
    device: OfflineDevice;
    wasmThreads: number | null;
  };
  const backend: OfflineBackend = {
    ...selectedBackend,
    modelDtype: OFFLINE_MODEL_DTYPE,
  };

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
  preferredDevice?: OfflineDevice;
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
    device: OfflineDevice;
    wasmThreads: number | null;
  };
  return {
    ...selectedBackend,
    modelDtype: OFFLINE_MODEL_DTYPE,
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
  await tts.dispose();
  tts = null;
  loadedVoiceStyles.clear();
  modelIsWarm = false;
  warmedOfflineVoices.clear();
}

async function assertOfflineFilesAvailable(
  voice: OfflineVoiceId,
) {
  const [modelCache, voiceCache] = await Promise.all([
    caches.open(OFFLINE_MODEL_CACHE_NAME),
    caches.open(OFFLINE_VOICE_CACHE_NAME),
  ]);
  const voiceIndex = OFFLINE_VOICE_ASSETS.findIndex(
    (asset) => asset.id === voice,
  );
  const selectedVoiceUrl = OFFLINE_VOICE_CACHE_URLS[voiceIndex];
  const modelMatches = await Promise.all(
    OFFLINE_MODEL_ASSETS.map((asset, index) =>
      isCachedOfflineAssetComplete({
        cache: modelCache,
        cacheUrl: OFFLINE_MODEL_URLS[index],
        expectedBytes: asset.bytes,
        rangeChunkBytes: asset.rangeBacked
          ? OFFLINE_MODEL_RANGE_CHUNK_BYTES
          : undefined,
      }),
    ),
  );
  const voiceComplete =
    voiceIndex >= 0 &&
    await isCachedOfflineAssetComplete({
      cache: voiceCache,
      cacheUrl: selectedVoiceUrl,
      expectedBytes: OFFLINE_VOICE_ASSET_BYTES[voiceIndex],
    });

  if (modelMatches.some((match) => !match) || !voiceComplete) {
    throw new Error(
      "The included offline voice is incomplete. Reconnect to the internet and prepare it again.",
    );
  }
}

async function cachedModelResponse(index: number) {
  const asset = OFFLINE_MODEL_ASSETS[index];
  const cache = await getModelCache();
  const response = asset.rangeBacked
    ? await getCachedOfflineAssetResponse({
        cache,
        cacheUrl: OFFLINE_MODEL_URLS[index],
        expectedBytes: asset.bytes,
        label: "The included studio voice model",
        rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
      })
    : await cache.match(OFFLINE_MODEL_URLS[index]);
  if (!response) {
    throw new Error("The included offline voice model is incomplete.");
  }
  return response;
}

async function loadVoiceStyle(voice: OfflineVoiceId) {
  const existing = loadedVoiceStyles.get(voice);
  if (existing) return existing;
  const voiceIndex = OFFLINE_VOICE_ASSETS.findIndex(
    (asset) => asset.id === voice,
  );
  const response = voiceIndex >= 0
    ? await (await caches.open(OFFLINE_VOICE_CACHE_NAME)).match(
        OFFLINE_VOICE_CACHE_URLS[voiceIndex],
      )
    : undefined;
  if (!response) {
    throw new Error("The selected offline voice style is incomplete.");
  }
  const style = createSupertonicVoiceStyle(await response.json(), Tensor);
  loadedVoiceStyles.set(voice, style);
  return style;
}

async function loadModel(
  id: number,
  {
    preferredDevice,
    preferredWasmThreads,
    selectedBackend: suppliedBackend,
  }: {
    preferredDevice?: OfflineDevice;
    preferredWasmThreads?: number;
    selectedBackend?: OfflineBackend;
  },
) {
  const selectedBackend =
    suppliedBackend ??
    (await selectBackend({
      preferredDevice,
      preferredWasmThreads,
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
  const createdSessions: InferenceSession[] = [];

  try {
    const configIndex = OFFLINE_MODEL_FILES.indexOf("onnx/tts.json");
    const indexerIndex = OFFLINE_MODEL_FILES.indexOf(
      "onnx/unicode_indexer.json",
    );
    if (configIndex < 0 || indexerIndex < 0) {
      throw new Error("The included voice setup is incomplete.");
    }
    const [config, indexer] = await Promise.all([
      cachedModelResponse(configIndex).then((response) => response.json()),
      cachedModelResponse(indexerIndex).then((response) => response.json()),
    ]);
    const modelDefinitions = [
      ["durationPredictor", "onnx/duration_predictor.onnx"],
      ["textEncoder", "onnx/text_encoder.onnx"],
      ["vectorEstimator", "onnx/vector_estimator.onnx"],
      ["vocoder", "onnx/vocoder.onnx"],
    ] as const;
    const sessions = {} as Record<
      (typeof modelDefinitions)[number][0],
      InferenceSession
    >;
    const totalModelBytes = modelDefinitions.reduce((total, [, file]) => {
      const asset = OFFLINE_MODEL_ASSETS.find((entry) => entry.file === file);
      return total + (asset?.bytes ?? 0);
    }, 0);
    let loadedModelBytes = 0;
    for (const [key, file] of modelDefinitions) {
      const index = OFFLINE_MODEL_FILES.indexOf(file);
      const asset = OFFLINE_MODEL_ASSETS[index];
      if (index < 0 || !asset) {
        throw new Error("The included neural voice model is incomplete.");
      }
      postProgress(
        id,
        8 + (loadedModelBytes / totalModelBytes) * 54,
        `Loading ${modelAssetLabel(file).toLowerCase()}…`,
        { backend: selectedBackend, stage: "initializing" },
      );
      const bytes = new Uint8Array(
        await (await cachedModelResponse(index)).arrayBuffer(),
      );
      const session = await InferenceSession.create(bytes, {
        executionProviders: [selectedBackend.device],
        graphOptimizationLevel: "all",
      });
      createdSessions.push(session);
      sessions[key] = session;
      loadedModelBytes += asset.bytes;
    }
    tts = createSupertonicRuntime({
      config: config as Record<string, unknown>,
      indexer: indexer as number[],
      sessions,
      Tensor,
    });
    activeBackend = selectedBackend;
    modelSessionGeneration += 1;
  } catch (error) {
    await Promise.allSettled(
      createdSessions.map((session) => session.release()),
    );
    tts = null;
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
  const modelCache = await caches.open(OFFLINE_MODEL_CACHE_NAME);
  const totalBytes = OFFLINE_MODEL_ASSET_BYTES.reduce(
    (total, bytes) => total + bytes,
    0,
  );
  let completedBytes = 0;

  for (let index = 0; index < OFFLINE_MODEL_ASSETS.length; index += 1) {
    const asset = OFFLINE_MODEL_ASSETS[index];
    const sourceUrl = OFFLINE_MODEL_URLS[index];
    const startProgress = (completedBytes / totalBytes) * 92;
    const targetProgress =
      ((completedBytes + asset.bytes) / totalBytes) * 92;
    const cached = await isCachedOfflineAssetComplete({
      cache: modelCache,
      cacheUrl: sourceUrl,
      expectedBytes: asset.bytes,
      rangeChunkBytes: asset.rangeBacked
        ? OFFLINE_MODEL_RANGE_CHUNK_BYTES
        : undefined,
    });

    if (!cached) {
      const downloadLabel = asset.file.endsWith(".onnx")
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
        expectedBytes: asset.bytes,
        label: modelAssetLabel(asset.file),
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
        rangeBacked: asset.rangeBacked,
        rangeChunkBytes: asset.rangeBacked
          ? OFFLINE_MODEL_RANGE_CHUNK_BYTES
          : undefined,
        signal,
        sourceUrl,
      });
    }

    postProgress(
      id,
      targetProgress,
      asset.file.endsWith(".onnx")
        ? "Included neural voice model downloaded."
        : "Included voice setup downloaded.",
      { backend, stage: "downloading" },
    );
    completedBytes += asset.bytes;
  }
}

async function installVoices(id: number, signal?: AbortSignal) {
  const voiceCache = await caches.open(OFFLINE_VOICE_CACHE_NAME);

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
      expectedBytes: OFFLINE_VOICE_ASSET_BYTES[index],
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

async function removeLegacyOfflineVoicePack() {
  await Promise.allSettled(
    ["transformers-cache", "kokoro-voices"].map(async (cacheName) => {
      const cache = await caches.open(cacheName);
      await deleteOfflineModelEntriesByIdentifier({
        cache,
        modelIdentifier: OFFLINE_LEGACY_MODEL_ID,
      });
    }),
  );
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

async function initializeSpeech(
  id: number,
  voice: OfflineVoiceId,
  preferredDevice?: OfflineDevice,
  preferredWasmThreads?: number,
  warm = true,
) {
  const totalStartedAt = performance.now();
  postProgress(id, 2, "Verifying the downloaded offline voice…", {
    stage: "verifying",
  });
  const verificationStartedAt = performance.now();
  const selectedBackend = await selectBackend({
    preferredDevice,
    preferredWasmThreads,
  });
  await assertOfflineFilesAvailable(voice);
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
      const style = await loadVoiceStyle(voice);
      await generateUsableOfflineAudio(
        "Ready.",
        (warmText) =>
          model.generate(warmText, {
            style,
            speed: 1,
            steps: SUPERTONIC_SYNTHESIS_STEPS,
          }),
      );
    } catch (error) {
      if (isCooperativeCancellationError(error)) throw error;
      if (shouldRetryOfflineSpeechBackend(error, activeBackend.device)) {
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
  preferredDevice?: OfflineDevice,
  preferredWasmThreads?: number,
  signal?: AbortSignal,
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
    await assertOfflineFilesAvailable(voice);
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
    const style = await loadVoiceStyle(voice);
    audio = await generateUsableOfflineAudio(text, (generationText) =>
      model.generate(generationText, {
        style,
        speed: Math.min(2, Math.max(0.5, rate || 1)),
        steps: SUPERTONIC_SYNTHESIS_STEPS,
        signal,
        onProgress: (completed, total) => {
          postProgress(
            id,
            68 + (completed / total) * 26,
            "Generating narration audio…",
            { backend: activeBackend, stage: "synthesizing" },
          );
        },
      }),
    );
  } catch (error) {
    if (isCooperativeCancellationError(error)) throw error;
    if (shouldRetryOfflineSpeechBackend(error, activeBackend.device)) {
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
        "en-us",
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
    postCanceled(id, false);
    return;
  }

  const abortController = new AbortController();
  requestAbortControllers.set(id, abortController);
  activeRequestId = id;
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
      await installModelFiles(id, installBackend, abortController.signal);
      await installVoices(id, abortController.signal);
      postProgress(id, 99, "Verifying the included offline voices…", {
        backend: installBackend,
        stage: "verifying",
      });
      await assertOfflineFilesAvailable(message.voice);
      result = await initializeSpeech(
        id,
        message.voice,
        installBackend.device,
        installBackend.wasmThreads ?? undefined,
        true,
      );
      await retainOfflineSpeechRuntime();
      await commitOfflineModelReadyMarker({
        cache: await getModelCache(),
        cacheUrl: OFFLINE_MODEL_READY_MARKER_URL,
        value: OFFLINE_MODEL_READY_MARKER_VERSION,
      });
      await removeLegacyOfflineVoicePack();
    } else if (message.type === "initialize") {
      const warm = message.warm !== false;
      result = await initializeSpeech(
        id,
        message.voice,
        message.device,
        message.wasmThreads,
        warm,
      );
      if (warm) {
        await retainOfflineSpeechRuntime().catch(() => undefined);
      }
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
        message.wasmThreads,
        abortController.signal,
      );
      void retainOfflineSpeechRuntime().catch(() => undefined);
    }

    if (canceledRequests.delete(id) || abortController.signal.aborted) {
      postCanceled(id, false);
      return;
    }
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
    if (isCooperativeCancellationError(error)) {
      canceledRequests.delete(id);
      postCanceled(id, true);
      return;
    }
    if (canceledRequests.delete(id) || abortController.signal.aborted) {
      postCanceled(id, false);
      return;
    }
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
    if (activeRequestId === id) activeRequestId = null;
    requestAbortControllers.delete(id);
    lastProgressByRequest.delete(id);
  }
}

workerScope.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "cancel") {
    const abortController = requestAbortControllers.get(message.id);
    if (queuedRequests.has(message.id) || abortController) {
      canceledRequests.add(message.id);
      abortController?.abort();
    }
    return;
  }
  queuedRequests.add(message.id);
  operationQueue = operationQueue.then(async () => {
    queuedRequests.delete(message.id);
    await handleRequest(message);
  });
});
