import {
  OFFLINE_DEFAULT_VOICE,
  OFFLINE_MODEL_ASSETS,
  OFFLINE_MODEL_CACHE_NAME,
  OFFLINE_MODEL_ID,
  OFFLINE_MODEL_RANGE_CHUNK_BYTES,
  OFFLINE_MODEL_URLS,
  OFFLINE_PACK_BYTES,
  OFFLINE_VOICE_ASSETS,
  OFFLINE_VOICE_CACHE_NAME,
  OFFLINE_VOICE_CACHE_URLS,
  type OfflineVoiceId,
} from "./offline-speech-config";
import {
  OFFLINE_MODEL_READY_MARKER_URL,
  OFFLINE_MODEL_READY_MARKER_VERSION,
  OFFLINE_LEGACY_MODEL_ID,
  OFFLINE_MODEL_DTYPE,
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
  mapOfflineInstallProgress,
} from "./offline-preparation.mjs";
import { createOfflineRunCancellationController } from "./offline-run-cancellation.mjs";
import { describeWorkerStartupFailure } from "./worker-startup-diagnostics.mjs";
import offlineSpeechWorkerUrl from "./offline-speech.worker.ts?worker&url";

export type OfflineSpeechDevice = "webgpu" | "wasm";
export type OfflineSpeechModelDtype = typeof OFFLINE_MODEL_DTYPE;
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

type WorkerWasmRunStartMessage = {
  id: number;
  type: "wasm-run-start";
  generation: number;
  sharedBuffer: SharedArrayBuffer;
  activeGenerationIndex: number;
  cancellationGenerationIndex: number;
  sessionGeneration: number;
};

type WorkerWasmRunEndMessage = {
  id: number;
  type: "wasm-run-end";
  generation: number;
  sessionGeneration: number;
};

type WorkerCanceledMessage = {
  id: number;
  type: "canceled";
  cooperative: boolean;
  sessionGeneration: number;
};

type WorkerResponseMessage =
  | WorkerProgressMessage
  | WorkerSuccessMessage
  | WorkerErrorMessage
  | WorkerWasmRunStartMessage
  | WorkerWasmRunEndMessage
  | WorkerCanceledMessage;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (progress: OfflineInstallProgress) => void;
  removeAbortListener?: () => void;
  message: WorkerRequestPayload;
  attemptedBackends: Set<string>;
  lastProgress: number;
  workerEpoch: number;
};

export class OfflineSpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineSpeechError";
  }
}

let worker: Worker | null = null;
let activeWorkerEpoch = 0;
let nextWorkerEpoch = 1;
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
const OFFLINE_PACK_LOCK_NAME = "linelight-offline-voice-pack-v2";
const runCancellationController = createOfflineRunCancellationController({
  onTimeout: recoverWorkerAfterCancellationTimeout,
});

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
  const terminatedEpoch = activeWorkerEpoch;
  worker?.terminate();
  worker = null;
  activeWorkerEpoch = 0;
  initializedVoice = null;
  if (terminatedEpoch) runCancellationController.resetEpoch(terminatedEpoch);

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
  const failedEpoch = activeWorkerEpoch;
  target.terminate();
  worker = null;
  activeWorkerEpoch = 0;
  initializedVoice = null;
  if (failedEpoch) runCancellationController.resetEpoch(failedEpoch);
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

function recoverWorkerAfterCancellationTimeout({
  workerEpoch,
}: {
  id: number;
  workerEpoch: number;
}) {
  if (!worker || activeWorkerEpoch !== workerEpoch) return;

  const timedOutWorker = worker;
  const retryRequests = Array.from(pendingRequests.entries());
  timedOutWorker.terminate();
  worker = null;
  activeWorkerEpoch = 0;
  initializedVoice = null;
  runCancellationController.resetEpoch(workerEpoch);

  if (!retryRequests.length) {
    updateReadiness({
      state: "idle",
      device: null,
      modelDtype: null,
      wasmThreads: null,
      timings: null,
      error: null,
    });
    return;
  }

  updateReadiness({
    state: "initializing",
    timings: null,
    error: null,
  });
  const recoveryWorker = getWorker();
  const recoveryEpoch = activeWorkerEpoch;
  for (const [id, pending] of retryRequests) {
    pending.workerEpoch = recoveryEpoch;
    runCancellationController.register(id, recoveryEpoch);
    recoveryWorker.postMessage({
      ...pending.message,
      ...effectiveBackendPreference(),
      id,
    } satisfies WorkerRequest);
  }
}

export async function getOfflineVoicePackBytes() {
  return OFFLINE_PACK_BYTES;
}

export async function getOfflineVoicePackRetainedBytes() {
  if (typeof caches === "undefined") return 0;

  try {
    const [modelCache, voiceCache] = await Promise.all([
      caches.open(OFFLINE_MODEL_CACHE_NAME),
      caches.open(OFFLINE_VOICE_CACHE_NAME),
    ]);
    const retainedModelBytes = await Promise.all(
      OFFLINE_MODEL_ASSETS.map((asset, index) =>
        getCachedOfflineAssetRetainedBytes({
          cache: modelCache,
          cacheUrl: OFFLINE_MODEL_URLS[index],
          expectedBytes: asset.bytes,
          rangeChunkBytes: asset.rangeBacked
            ? OFFLINE_MODEL_RANGE_CHUNK_BYTES
            : undefined,
        }),
      ),
    );
    const retainedVoiceBytes = await Promise.all(
      OFFLINE_VOICE_ASSETS.map((asset, index) =>
        getCachedOfflineAssetRetainedBytes({
          cache: voiceCache,
          cacheUrl: OFFLINE_VOICE_CACHE_URLS[index],
          expectedBytes: asset.bytes,
        }),
      ),
    );

    return Math.min(
      OFFLINE_PACK_BYTES,
      retainedModelBytes.reduce((total, bytes) => total + bytes, 0) +
        retainedVoiceBytes.reduce((total, bytes) => total + bytes, 0),
    );
  } catch {
    // A conservative fresh-install preflight is safer when Cache Storage
    // cannot be inspected.
    return 0;
  }
}

function getWorker() {
  if (worker) return worker;

  const resolvedWorkerUrl = new URL(
    offlineSpeechWorkerUrl,
    globalThis.location.href,
  ).href;
  const createdWorker = new Worker(resolvedWorkerUrl, {
    type: "module",
    name: "linelight-offline-voice",
  });
  const createdWorkerEpoch = nextWorkerEpoch;
  nextWorkerEpoch += 1;
  worker = createdWorker;
  activeWorkerEpoch = createdWorkerEpoch;

  createdWorker.addEventListener(
    "message",
    (
      event: MessageEvent<WorkerResponseMessage>,
    ) => {
      if (worker !== createdWorker) return;
      const message = event.data;
      if (message.type === "wasm-run-start") {
        runCancellationController.observeStart(
          message,
          createdWorkerEpoch,
        );
        return;
      }
      if (message.type === "wasm-run-end") {
        runCancellationController.observeEnd(message, createdWorkerEpoch);
        return;
      }
      if (message.type === "canceled") {
        runCancellationController.complete(message.id, createdWorkerEpoch);
        const canceledPending = pendingRequests.get(message.id);
        if (canceledPending) {
          pendingRequests.delete(message.id);
          canceledPending.removeAbortListener?.();
          canceledPending.reject(
            new DOMException("Offline narration was canceled.", "AbortError"),
          );
        }
        return;
      }

      if (message.type === "progress") {
        const pending = pendingRequests.get(message.id);
        if (!pending) return;
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

      // Success or error is terminal even when an aborted page request has
      // already been removed from pendingRequests. A run can finish just before
      // its cancel message is delivered; acknowledging that terminal response
      // prevents the cancellation watchdog from replacing a healthy warm
      // worker after the fact.
      runCancellationController.complete(message.id, createdWorkerEpoch);
      const pending = pendingRequests.get(message.id);
      if (!pending) return;

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
            device: nextBackend.device as OfflineSpeechDevice,
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
          runCancellationController.resetEpoch(createdWorkerEpoch);
          if (worker === createdWorker) {
            worker = null;
            activeWorkerEpoch = 0;
          }
          const fallbackWorker = getWorker();
          const fallbackWorkerEpoch = activeWorkerEpoch;
          for (const [id, retryPending] of retryRequests) {
            retryPending.workerEpoch = fallbackWorkerEpoch;
            runCancellationController.register(id, fallbackWorkerEpoch);
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
      describeWorkerStartupFailure({
        workerUrl: resolvedWorkerUrl,
        message: event.message,
        error: event.error,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      }),
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
        runCancellationController.request(id, pending.workerEpoch);
        if (worker && activeWorkerEpoch === pending.workerEpoch) {
          worker.postMessage({ id, type: "cancel" } satisfies WorkerRequest);
        }
        reject(
          new DOMException("Offline narration was canceled.", "AbortError"),
        );
        return;
      }
      // Installation and model-loading phases remain replaceable operations.
      // Completed download ranges are durable, so replacing their worker stops
      // promptly without throwing verified progress away.
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
      workerEpoch: 0,
      removeAbortListener: signal
        ? () => signal.removeEventListener("abort", handleAbort)
        : undefined,
    };
    pendingRequests.set(id, pending);
    signal?.addEventListener("abort", handleAbort, { once: true });

    const targetWorker = getWorker();
    pending.workerEpoch = activeWorkerEpoch;
    runCancellationController.register(id, activeWorkerEpoch);
    targetWorker.postMessage({
      ...message,
      ...effectiveBackendPreference(),
      id,
    } as WorkerRequest);
  });
}

async function cacheContainsOfflineModelVariant() {
  const cache = await caches.open(OFFLINE_MODEL_CACHE_NAME);
  const modelMatches = await Promise.all(
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
  const modelValidated = await hasOfflineModelReadyMarker({
    cache,
    cacheUrl: OFFLINE_MODEL_READY_MARKER_URL,
    value: OFFLINE_MODEL_READY_MARKER_VERSION,
  });
  return {
    installed: modelMatches.every(Boolean) && modelValidated,
    upgradeRequired: false,
  };
}

async function cacheContainsOfflineVoices() {
  const cache = await caches.open(OFFLINE_VOICE_CACHE_NAME);
  const matches = await Promise.all(
    OFFLINE_VOICE_ASSETS.map((asset, index) =>
      isCachedOfflineAssetComplete({
        cache,
        cacheUrl: OFFLINE_VOICE_CACHE_URLS[index],
        expectedBytes: asset.bytes,
      }),
    ),
  );
  return matches.every(Boolean);
}

export async function getOfflineVoicePackStatus(): Promise<OfflineVoicePackStatus> {
  if (typeof caches === "undefined") {
    return { installed: false, upgradeRequired: false };
  }

  try {
    const [modelAvailability, hasVoices] = await Promise.all([
      cacheContainsOfflineModelVariant(),
      cacheContainsOfflineVoices(),
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
  voice = OFFLINE_DEFAULT_VOICE,
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
  // Each explicit install probes the full capability ladder again unless this
  // page already observed a real WebGPU runtime failure.
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
      deleteMatchingEntries(OFFLINE_MODEL_CACHE_NAME, OFFLINE_MODEL_ID),
      deleteMatchingEntries(OFFLINE_VOICE_CACHE_NAME, OFFLINE_MODEL_ID),
      deleteMatchingEntries("transformers-cache", OFFLINE_LEGACY_MODEL_ID),
      deleteMatchingEntries("kokoro-voices", OFFLINE_LEGACY_MODEL_ID),
    ]).then(() => undefined),
  );
}

export function disposeOfflineSpeechWorker() {
  terminateWorker();
}
