import {
  KOKORO_VOICE_CACHE_NAME,
  LEGACY_OFFLINE_MODEL_URLS,
  OFFLINE_LEGACY_Q8_MODEL_CACHE_URLS,
  OFFLINE_MODEL_BYTES,
  OFFLINE_MODEL_FILES,
  OFFLINE_MODEL_ID,
  OFFLINE_MODEL_RANGE_CHUNK_BYTES,
  OFFLINE_MODEL_URLS,
  OFFLINE_PACK_BYTES,
  OFFLINE_VOICES,
  OFFLINE_VOICE_BYTES,
  OFFLINE_VOICE_CACHE_URLS,
  TRANSFORMERS_CACHE_NAME,
  type OfflineVoiceId,
} from "./offline-speech-config";
import {
  OFFLINE_FP16_READY_MARKER_URL,
  OFFLINE_FP16_READY_MARKER_VERSION,
  OFFLINE_LEGACY_Q8_MODEL_BYTES,
  OFFLINE_MODEL_DTYPE,
  OFFLINE_WEBGPU_MODEL_DTYPE,
  constrainOfflineBackendPreference,
  nextOfflineSpeechBackend,
} from "./offline-model-manifest.mjs";
import {
  deleteOfflineModelEntriesByIdentifier,
  hasOfflineModelReadyMarker,
} from "./offline-model-cache.mjs";
import {
  getCachedOfflineAssetRetainedBytes,
  isCachedOfflineAssetComplete,
} from "./offline-pack-installer.mjs";
import {
  assessOfflineModelAvailability,
  mapOfflineInstallProgress,
} from "./offline-preparation.mjs";

export type OfflineSpeechDevice = "webgpu" | "wasm";
export type OfflineSpeechModelDtype =
  | typeof OFFLINE_MODEL_DTYPE
  | typeof OFFLINE_WEBGPU_MODEL_DTYPE
  | "q8";
export type OfflineSpeechStage =
  | "downloading"
  | "verifying"
  | "initializing"
  | "warming"
  | "loaded"
  | "ready"
  | "synthesizing";

export type OfflineWordBoundary = {
  audioOffsetSeconds: number;
  durationSeconds: number;
  text: string;
  textOffset: number;
  wordLength: number;
};

export type OfflineSpeechResult = {
  audioData: ArrayBuffer;
  audioDurationSeconds: number;
  boundaries: OfflineWordBoundary[];
  device: OfflineSpeechDevice;
  modelDtype: OfflineSpeechModelDtype;
  synthesisMilliseconds: number;
  wasmThreads: number | null;
};

export type OfflineInstallProgress = {
  progress: number;
  label: string;
  stage?: OfflineSpeechStage;
  elapsedMilliseconds?: number;
  device?: OfflineSpeechDevice;
  modelDtype?: OfflineSpeechModelDtype;
  wasmThreads?: number | null;
};

export type OfflineSpeechReadinessState =
  | "idle"
  | "downloading"
  | "verifying"
  | "initializing"
  | "warming"
  | "loaded"
  | "ready"
  | "error";

export type OfflineSpeechTimings = {
  cacheVerificationMilliseconds: number;
  modelInitializationMilliseconds: number;
  totalMilliseconds: number;
  warmupMilliseconds: number;
};

export type OfflineSpeechReadiness = {
  state: OfflineSpeechReadinessState;
  device: OfflineSpeechDevice | null;
  modelDtype: OfflineSpeechModelDtype | null;
  wasmThreads: number | null;
  timings: OfflineSpeechTimings | null;
  error: string | null;
};

export type OfflineVoicePackStatus = {
  installed: boolean;
  upgradeRequired: boolean;
};

type OfflineSpeechInitializationResult = Omit<
  OfflineSpeechReadiness,
  "error"
> & {
  state: "loaded" | "ready";
  device: OfflineSpeechDevice;
  modelDtype: OfflineSpeechModelDtype;
  timings: OfflineSpeechTimings;
};

type WorkerBackend = {
  device: OfflineSpeechDevice;
  modelDtype: OfflineSpeechModelDtype;
  wasmThreads: number | null;
};

type WorkerRequestPayload =
  | { type: "install"; voice: OfflineVoiceId }
  | { type: "initialize"; voice: OfflineVoiceId; warm?: boolean }
  | {
      type: "synthesize";
      text: string;
      voice: OfflineVoiceId;
      rate: number;
    }
  | { type: "cancel" };

type WorkerRequest = WorkerRequestPayload & {
  id: number;
  device?: OfflineSpeechDevice;
  wasmThreads?: number;
};

type WorkerProgressMessage = {
  id: number;
  type: "progress";
  progress: number;
  label: string;
  stage?: OfflineSpeechStage;
  elapsedMilliseconds?: number;
  backend?: WorkerBackend;
};

type WorkerSuccessMessage = {
  id: number;
  type: "success";
  result: unknown;
};

type WorkerErrorMessage = {
  id: number;
  type: "error";
  message: string;
  code?: "backend_failed";
  backend?: WorkerBackend;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (progress: OfflineInstallProgress) => void;
  removeAbortListener?: () => void;
  message: WorkerRequestPayload;
  attemptedBackends: Set<string>;
  lastProgress: number;
};

export class OfflineSpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineSpeechError";
  }
}

let worker: Worker | null = null;
let nextRequestId = 1;
// A runtime failure can indicate a transient device-loss or driver event. Keep
// the current page on the proven WASM fallback, but let a later page load probe
// WebGPU again instead of permanently stranding the reader on the slower tier.
let webGpuDisabledForSession = false;
let backendPreference: {
  device?: OfflineSpeechDevice;
  wasmThreads?: number;
} = {};
const pendingRequests = new Map<number, PendingRequest>();
const readinessListeners = new Set<
  (readiness: OfflineSpeechReadiness) => void
>();
let readiness: OfflineSpeechReadiness = {
  state: "idle",
  device: null,
  modelDtype: null,
  wasmThreads: null,
  timings: null,
  error: null,
};
let initializedVoice: OfflineVoiceId | null = null;
const OFFLINE_PACK_LOCK_NAME = "linelight-offline-voice-pack-v1";

async function withOfflinePackLock<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lockManager = globalThis.navigator?.locks;
  if (!lockManager) return operation();
  return lockManager.request(
    OFFLINE_PACK_LOCK_NAME,
    { mode: "exclusive", signal },
    operation,
  );
}

function effectiveBackendPreference() {
  return constrainOfflineBackendPreference(
    backendPreference,
    webGpuDisabledForSession,
  );
}

function updateReadiness(
  update: Partial<OfflineSpeechReadiness>,
) {
  readiness = { ...readiness, ...update };
  for (const listener of readinessListeners) {
    listener({ ...readiness });
  }
}

function backendKey(backend: WorkerBackend) {
  return `${backend.device}:${backend.wasmThreads ?? "gpu"}`;
}

function reportProgress(
  pending: PendingRequest,
  progress: OfflineInstallProgress,
) {
  const stagedProgress =
    pending.message.type === "install"
      ? mapOfflineInstallProgress(progress.stage, progress.progress)
      : progress.progress;
  const normalizedProgress = Math.min(
    100,
    Math.max(pending.lastProgress, Math.round(stagedProgress)),
  );
  pending.lastProgress = normalizedProgress;
  const normalized = {
    progress: normalizedProgress,
    label: progress.label,
    stage: progress.stage,
    elapsedMilliseconds: progress.elapsedMilliseconds,
    device: progress.device,
    modelDtype: progress.modelDtype,
    wasmThreads: progress.wasmThreads,
  };
  pending.onProgress?.(normalized);
  if (
    (pending.message.type === "install" ||
      pending.message.type === "initialize") &&
    progress.stage &&
    progress.stage !== "synthesizing"
  ) {
    updateReadiness({
      state: progress.stage,
      device: progress.device ?? readiness.device,
      modelDtype: progress.modelDtype ?? readiness.modelDtype,
      wasmThreads:
        progress.wasmThreads === undefined
          ? readiness.wasmThreads
          : progress.wasmThreads,
      error: null,
    });
  }
}

function terminateWorker(reason = "Offline narration was stopped.") {
  worker?.terminate();
  worker = null;
  initializedVoice = null;

  for (const pending of pendingRequests.values()) {
    pending.removeAbortListener?.();
    pending.reject(new DOMException(reason, "AbortError"));
  }
  pendingRequests.clear();
  updateReadiness({
    state: "idle",
    device: null,
    modelDtype: null,
    wasmThreads: null,
    timings: null,
    error: null,
  });
}

function failWorker(target: Worker, message: string) {
  if (worker !== target) return;
  target.terminate();
  worker = null;
  initializedVoice = null;
  const error = new OfflineSpeechError(message);

  for (const pending of pendingRequests.values()) {
    pending.removeAbortListener?.();
    pending.reject(error);
  }
  pendingRequests.clear();
  updateReadiness({
    state: "error",
    timings: null,
    error: message,
  });
}

export async function getOfflineVoicePackBytes() {
  return OFFLINE_PACK_BYTES;
}

export async function getOfflineVoicePackRetainedBytes() {
  if (typeof caches === "undefined") return 0;

  try {
    const [modelCache, voiceCache] = await Promise.all([
      caches.open(TRANSFORMERS_CACHE_NAME),
      caches.open(KOKORO_VOICE_CACHE_NAME),
    ]);
    const modelIndex = OFFLINE_MODEL_FILES.findIndex((file) =>
      file.endsWith(".onnx"),
    );
    const currentModelBytes =
      modelIndex < 0
        ? 0
        : await getCachedOfflineAssetRetainedBytes({
            cache: modelCache,
            cacheUrl: OFFLINE_MODEL_URLS[modelIndex],
            expectedBytes: OFFLINE_MODEL_BYTES,
            rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
          });
    const legacyModelComplete =
      modelIndex >= 0 &&
      (await isCachedOfflineAssetComplete({
        cache: modelCache,
        cacheUrl: LEGACY_OFFLINE_MODEL_URLS[modelIndex],
        expectedBytes: OFFLINE_MODEL_BYTES,
        rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
      }));
    const retainedVoiceBytes = await Promise.all(
      OFFLINE_VOICE_CACHE_URLS.map((cacheUrl) =>
        getCachedOfflineAssetRetainedBytes({
          cache: voiceCache,
          cacheUrl,
          expectedBytes: OFFLINE_VOICE_BYTES,
        }),
      ),
    );

    return Math.min(
      OFFLINE_PACK_BYTES,
      Math.max(
        currentModelBytes,
        legacyModelComplete ? OFFLINE_MODEL_BYTES : 0,
      ) + retainedVoiceBytes.reduce((total, bytes) => total + bytes, 0),
    );
  } catch {
    // A conservative fresh-install preflight is safer when Cache Storage
    // cannot be inspected.
    return 0;
  }
}

function getWorker() {
  if (worker) return worker;

  const createdWorker = new Worker(
    new URL("./offline-speech.worker.ts", import.meta.url),
    {
      type: "module",
      name: "linelight-offline-voice",
    },
  );
  worker = createdWorker;

  createdWorker.addEventListener(
    "message",
    (
      event: MessageEvent<
        WorkerProgressMessage | WorkerSuccessMessage | WorkerErrorMessage
      >,
    ) => {
      if (worker !== createdWorker) return;
      const message = event.data;
      const pending = pendingRequests.get(message.id);
      if (!pending) return;

      if (message.type === "progress") {
        reportProgress(pending, {
          progress: message.progress,
          label: message.label,
          stage: message.stage,
          elapsedMilliseconds: message.elapsedMilliseconds,
          device: message.backend?.device,
          modelDtype: message.backend?.modelDtype,
          wasmThreads: message.backend?.wasmThreads,
        });
        return;
      }

      if (
        message.type === "error" &&
        message.code === "backend_failed" &&
        message.backend
      ) {
        const failedBackendKey = backendKey(message.backend);
        const nextBackend = nextOfflineSpeechBackend(message.backend);
        if (
          nextBackend &&
          !pending.attemptedBackends.has(failedBackendKey)
        ) {
          if (message.backend.device === "webgpu") {
            webGpuDisabledForSession = true;
          }
          backendPreference = {
            device: nextBackend.device,
            wasmThreads: nextBackend.wasmThreads ?? undefined,
          };
          const retryRequests = Array.from(pendingRequests.entries());
          initializedVoice = null;
          updateReadiness({
            state: "initializing",
            device: "wasm",
            modelDtype: message.backend.modelDtype,
            wasmThreads: nextBackend.wasmThreads ?? null,
            timings: null,
            error: null,
          });
          for (const [, retryPending] of retryRequests) {
            retryPending.attemptedBackends.add(failedBackendKey);
            retryPending.lastProgress = 0;
            reportProgress(retryPending, {
              progress: 1,
              label:
                nextBackend.wasmThreads === 1
                  ? "Switching to single-thread compatibility mode…"
                  : "Switching to the local compatibility runtime…",
              stage: "initializing",
              device: "wasm",
              modelDtype: message.backend.modelDtype,
              wasmThreads: nextBackend.wasmThreads ?? null,
            });
          }
          createdWorker.terminate();
          if (worker === createdWorker) worker = null;
          const fallbackWorker = getWorker();
          for (const [id, retryPending] of retryRequests) {
            fallbackWorker.postMessage({
              ...retryPending.message,
              ...effectiveBackendPreference(),
              id,
            } satisfies WorkerRequest);
          }
          return;
        }
      }

      pendingRequests.delete(message.id);
      pending.removeAbortListener?.();
      if (message.type === "success") {
        if (
          typeof message.result === "object" &&
          message.result &&
          "device" in message.result &&
          (message.result.device === "webgpu" ||
            message.result.device === "wasm")
        ) {
          const result = message.result as {
            device: OfflineSpeechDevice;
            modelDtype?: OfflineSpeechModelDtype;
            wasmThreads?: number | null;
          };
          backendPreference = {
            device: result.device,
            wasmThreads: result.wasmThreads ?? undefined,
          };
          if (result.device === "webgpu") webGpuDisabledForSession = false;
        }
        pending.resolve(message.result);
      } else {
        initializedVoice = null;
        updateReadiness({
          state: "error",
          error: message.message,
        });
        pending.reject(new OfflineSpeechError(message.message));
      }
    },
  );

  createdWorker.addEventListener("error", (event) => {
    event.preventDefault();
    failWorker(
      createdWorker,
      event.message || "The offline voice worker stopped unexpectedly.",
    );
  });
  createdWorker.addEventListener("messageerror", () => {
    failWorker(
      createdWorker,
      "The browser could not read a response from the offline voice worker.",
    );
  });

  return createdWorker;
}

export function preloadOfflineSpeechRuntime() {
  getWorker();
}

function requestWorker<T>(
  message: WorkerRequestPayload,
  {
    signal,
    onProgress,
    preserveWorkerOnAbort = false,
  }: {
    signal?: AbortSignal;
    onProgress?: (progress: OfflineInstallProgress) => void;
    preserveWorkerOnAbort?: boolean;
  } = {},
) {
  if (signal?.aborted) {
    return Promise.reject(
      new DOMException("Offline narration was canceled.", "AbortError"),
    );
  }

  const id = nextRequestId;
  nextRequestId += 1;

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      const pending = pendingRequests.get(id);
      if (!pending) return;
      pendingRequests.delete(id);
      pending.removeAbortListener?.();
      if (preserveWorkerOnAbort) {
        // A speculative inference may already be inside synchronous ONNX WASM,
        // where Worker.terminate() cannot preempt the runtime promptly anyway.
        // Ignore its eventual result and keep the loaded model for the seek or
        // restart request queued behind it.
        reject(
          new DOMException("Offline narration was canceled.", "AbortError"),
        );
        return;
      }
      // Model loading, warm-up, and ONNX inference are not cooperatively
      // abortable. Completed download ranges are durable, so replacing the
      // worker promptly stops every stage without throwing progress away.
      terminateWorker("Offline narration was canceled.");
      reject(
        new DOMException("Offline narration was canceled.", "AbortError"),
      );
    };

    const pending: PendingRequest = {
      resolve: (value) => resolve(value as T),
      reject,
      onProgress,
      message,
      attemptedBackends: new Set(),
      lastProgress: 0,
      removeAbortListener: signal
        ? () => signal.removeEventListener("abort", handleAbort)
        : undefined,
    };
    pendingRequests.set(id, pending);
    signal?.addEventListener("abort", handleAbort, { once: true });

    getWorker().postMessage({
      ...message,
      ...effectiveBackendPreference(),
      id,
    } as WorkerRequest);
  });
}

async function cacheContainsEvery(
  cacheName: string,
  urls: readonly string[],
  expectedBytes: number,
) {
  const cache = await caches.open(cacheName);
  const matches = await Promise.all(
    urls.map((cacheUrl) =>
      isCachedOfflineAssetComplete({
        cache,
        cacheUrl,
        expectedBytes,
      }),
    ),
  );
  return matches.every(Boolean);
}

async function cacheContainsOfflineModelVariant() {
  const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
  const setupMatches = await Promise.all(
    OFFLINE_MODEL_FILES.map(async (file, index) => {
      if (file.endsWith(".onnx")) return true;
      return Boolean(
        (await cache.match(OFFLINE_MODEL_URLS[index])) ??
          (await cache.match(LEGACY_OFFLINE_MODEL_URLS[index])),
      );
    }),
  );
  const wasmModelIndex = OFFLINE_MODEL_FILES.findIndex((file) =>
    file.endsWith(".onnx"),
  );
  const hasWasmModel =
    wasmModelIndex >= 0 &&
    ((await isCachedOfflineAssetComplete({
      cache,
      cacheUrl: OFFLINE_MODEL_URLS[wasmModelIndex],
      expectedBytes: OFFLINE_MODEL_BYTES,
      rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
    })) ||
      (await isCachedOfflineAssetComplete({
        cache,
        cacheUrl: LEGACY_OFFLINE_MODEL_URLS[wasmModelIndex],
        expectedBytes: OFFLINE_MODEL_BYTES,
        rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
      })));
  const legacyModelMatches = await Promise.all(
    OFFLINE_LEGACY_Q8_MODEL_CACHE_URLS.map((cacheUrl) =>
      isCachedOfflineAssetComplete({
        cache,
        cacheUrl,
        expectedBytes: OFFLINE_LEGACY_Q8_MODEL_BYTES,
        rangeChunkBytes: OFFLINE_MODEL_RANGE_CHUNK_BYTES,
      }),
    ),
  );
  const legacyModelComplete = legacyModelMatches.some(Boolean);
  const preferredModelValidated = await hasOfflineModelReadyMarker({
    cache,
    cacheUrl: OFFLINE_FP16_READY_MARKER_URL,
    value: OFFLINE_FP16_READY_MARKER_VERSION,
  });
  return {
    ...assessOfflineModelAvailability({
      legacyModelComplete,
      preferredModelComplete: hasWasmModel,
      preferredModelValidated,
      setupComplete: setupMatches.every(Boolean),
    }),
    legacyModelComplete,
    preferredModelComplete: hasWasmModel,
    preferredModelValidated,
  };
}

export async function getOfflineVoicePackStatus(): Promise<OfflineVoicePackStatus> {
  if (typeof caches === "undefined") {
    return { installed: false, upgradeRequired: false };
  }

  try {
    const [modelAvailability, hasVoices] = await Promise.all([
      cacheContainsOfflineModelVariant(),
      cacheContainsEvery(
        KOKORO_VOICE_CACHE_NAME,
        OFFLINE_VOICE_CACHE_URLS,
        OFFLINE_VOICE_BYTES,
      ),
    ]);
    return {
      installed: modelAvailability.installed && hasVoices,
      upgradeRequired: modelAvailability.upgradeRequired && hasVoices,
    };
  } catch {
    return { installed: false, upgradeRequired: false };
  }
}

export async function isOfflineVoicePackInstalled() {
  return (await getOfflineVoicePackStatus()).installed;
}

export function getOfflineSpeechReadiness() {
  return {
    ...readiness,
    timings: readiness.timings ? { ...readiness.timings } : null,
  };
}

export function subscribeOfflineSpeechReadiness(
  listener: (readiness: OfflineSpeechReadiness) => void,
) {
  readinessListeners.add(listener);
  listener(getOfflineSpeechReadiness());
  return () => readinessListeners.delete(listener);
}

function applyInitializationResult(
  result: OfflineSpeechInitializationResult,
  voice: OfflineVoiceId,
) {
  initializedVoice = voice;
  updateReadiness({
    state: result.state,
    device: result.device,
    modelDtype: result.modelDtype,
    wasmThreads: result.wasmThreads,
    timings: result.timings,
    error: null,
  });
  return result;
}

export async function initializeOfflineSpeech({
  voice,
  signal,
  onProgress,
  warm = true,
}: {
  voice: OfflineVoiceId;
  signal?: AbortSignal;
  onProgress?: (progress: OfflineInstallProgress) => void;
  warm?: boolean;
}) {
  if (readiness.state === "ready" && initializedVoice === voice) {
    return getOfflineSpeechReadiness() as OfflineSpeechInitializationResult;
  }
  updateReadiness({
    state: "initializing",
    error: null,
  });
  const result = await requestWorker<OfflineSpeechInitializationResult>(
    { type: "initialize", voice, warm },
    { signal, onProgress },
  );
  return applyInitializationResult(result, voice);
}

export async function installOfflineVoicePack({
  voice = OFFLINE_VOICES[0].value,
  signal,
  onProgress,
}: {
  voice?: OfflineVoiceId;
  signal?: AbortSignal;
  onProgress?: (progress: OfflineInstallProgress) => void;
} = {}) {
  if (typeof caches === "undefined") {
    return Promise.reject(
      new OfflineSpeechError(
        "This browser cannot store the offline voice pack.",
      ),
    );
  }
  updateReadiness({
    state: "downloading",
    error: null,
  });
  // A q8 compatibility run records a WASM preference. An explicit fp16 update
  // should probe the full capability ladder again, unless this page already
  // observed a real WebGPU runtime failure.
  backendPreference = webGpuDisabledForSession
    ? { device: "wasm" }
    : {};
  try {
    const result = await withOfflinePackLock(
      () =>
        requestWorker<OfflineSpeechInitializationResult>(
          { type: "install", voice },
          { signal, onProgress },
        ),
      signal,
    );
    return applyInitializationResult(result, voice);
  } catch (error) {
    backendPreference = webGpuDisabledForSession
      ? { device: "wasm" }
      : {};
    throw error;
  }
}

export async function synthesizeOfflineSpeech({
  text,
  voice,
  rate,
  signal,
  onProgress,
  preserveWorkerOnAbort = false,
}: {
  text: string;
  voice: OfflineVoiceId;
  rate: number;
  signal?: AbortSignal;
  onProgress?: (progress: OfflineInstallProgress) => void;
  preserveWorkerOnAbort?: boolean;
}) {
  const result = await requestWorker<OfflineSpeechResult>(
    { type: "synthesize", text, voice, rate },
    { signal, onProgress, preserveWorkerOnAbort },
  );
  initializedVoice = voice;
  updateReadiness({
    state: "ready",
    device: result.device,
    modelDtype: result.modelDtype,
    wasmThreads: result.wasmThreads,
    error: null,
  });
  return result;
}

async function deleteMatchingEntries(
  cacheName: string,
  modelIdentifier: string,
) {
  const cache = await caches.open(cacheName);
  await deleteOfflineModelEntriesByIdentifier({ cache, modelIdentifier });
}

export async function removeOfflineVoicePack() {
  terminateWorker("The offline voice pack was removed.");
  backendPreference = {};
  webGpuDisabledForSession = false;
  if (typeof caches === "undefined") return;

  await withOfflinePackLock(() =>
    Promise.all([
      deleteMatchingEntries(TRANSFORMERS_CACHE_NAME, OFFLINE_MODEL_ID),
      deleteMatchingEntries(KOKORO_VOICE_CACHE_NAME, OFFLINE_MODEL_ID),
    ]).then(() => undefined),
  );
}

export function disposeOfflineSpeechWorker() {
  terminateWorker();
}
