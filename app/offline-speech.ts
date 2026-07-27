import {
  KOKORO_VOICE_CACHE_NAME,
  OFFLINE_MODEL_ID,
  OFFLINE_MODEL_URLS,
  OFFLINE_VOICE_URLS,
  TRANSFORMERS_CACHE_NAME,
  type OfflineVoiceId,
} from "./offline-speech-config";

export type OfflineWordBoundary = {
  audioOffsetSeconds: number;
  durationSeconds: number;
  text: string;
  textOffset: number;
  wordLength: number;
};

export type OfflineSpeechResult = {
  audioData: ArrayBuffer;
  boundaries: OfflineWordBoundary[];
  device: "webgpu" | "wasm";
};

export type OfflineInstallProgress = {
  progress: number;
  label: string;
};

type WorkerRequestPayload =
  | { type: "install" }
  | {
      type: "synthesize";
      text: string;
      voice: OfflineVoiceId;
    }
  | { type: "cancel" };

type WorkerRequest = WorkerRequestPayload & {
  id: number;
  device?: "webgpu" | "wasm";
};

type WorkerProgressMessage = {
  id: number;
  type: "progress";
  progress: number;
  label: string;
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
  code?: "webgpu_failed";
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (progress: OfflineInstallProgress) => void;
  removeAbortListener?: () => void;
  message: WorkerRequestPayload;
  attemptedWasm: boolean;
};

export class OfflineSpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineSpeechError";
  }
}

let worker: Worker | null = null;
let nextRequestId = 1;
let forceWasm = false;
const pendingRequests = new Map<number, PendingRequest>();

function terminateWorker(reason = "Offline narration was stopped.") {
  worker?.terminate();
  worker = null;

  for (const pending of pendingRequests.values()) {
    pending.removeAbortListener?.();
    pending.reject(new DOMException(reason, "AbortError"));
  }
  pendingRequests.clear();
}

function getWorker() {
  if (worker) return worker;

  worker = new Worker(
    new URL("./offline-speech.worker.ts", import.meta.url),
    {
      type: "module",
      name: "linelight-offline-voice",
    },
  );

  worker.addEventListener(
    "message",
    (
      event: MessageEvent<
        WorkerProgressMessage | WorkerSuccessMessage | WorkerErrorMessage
      >,
    ) => {
      const message = event.data;
      const pending = pendingRequests.get(message.id);
      if (!pending) return;

      if (message.type === "progress") {
        pending.onProgress?.({
          progress: message.progress,
          label: message.label,
        });
        return;
      }

      if (
        message.type === "error" &&
        message.code === "webgpu_failed" &&
        !pending.attemptedWasm
      ) {
        pending.attemptedWasm = true;
        forceWasm = true;
        pending.onProgress?.({
          progress: 92,
          label: "WebGPU was unavailable. Switching to compatibility mode…",
        });
        worker?.terminate();
        worker = null;
        getWorker().postMessage({
          ...pending.message,
          id: message.id,
          device: "wasm",
        } satisfies WorkerRequest);
        return;
      }

      pendingRequests.delete(message.id);
      pending.removeAbortListener?.();
      if (message.type === "success") {
        pending.resolve(message.result);
      } else {
        pending.reject(new OfflineSpeechError(message.message));
      }
    },
  );

  worker.addEventListener("error", () => {
    terminateWorker("The offline voice worker stopped unexpectedly.");
  });

  return worker;
}

function requestWorker<T>(
  message: WorkerRequestPayload,
  {
    signal,
    onProgress,
  }: {
    signal?: AbortSignal;
    onProgress?: (progress: OfflineInstallProgress) => void;
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
      getWorker().postMessage({ id, type: "cancel" } satisfies WorkerRequest);
      reject(
        new DOMException("Offline narration was canceled.", "AbortError"),
      );
    };

    const pending: PendingRequest = {
      resolve: (value) => resolve(value as T),
      reject,
      onProgress,
      message,
      attemptedWasm: forceWasm,
      removeAbortListener: signal
        ? () => signal.removeEventListener("abort", handleAbort)
        : undefined,
    };
    pendingRequests.set(id, pending);
    signal?.addEventListener("abort", handleAbort, { once: true });

    getWorker().postMessage({
      ...message,
      id,
      device: forceWasm ? "wasm" : undefined,
    } as WorkerRequest);
  });
}

async function cacheContainsEvery(
  cacheName: string,
  urls: readonly string[],
) {
  const cache = await caches.open(cacheName);
  const matches = await Promise.all(urls.map((url) => cache.match(url)));
  return matches.every(Boolean);
}

export async function isOfflineVoicePackInstalled() {
  if (typeof caches === "undefined") return false;

  try {
    const [hasModel, hasVoices] = await Promise.all([
      cacheContainsEvery(TRANSFORMERS_CACHE_NAME, OFFLINE_MODEL_URLS),
      cacheContainsEvery(KOKORO_VOICE_CACHE_NAME, OFFLINE_VOICE_URLS),
    ]);
    return hasModel && hasVoices;
  } catch {
    return false;
  }
}

export function installOfflineVoicePack({
  signal,
  onProgress,
}: {
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
  return requestWorker<{ device: "webgpu" | "wasm" }>(
    { type: "install" },
    { signal, onProgress },
  );
}

export function synthesizeOfflineSpeech({
  text,
  voice,
  signal,
}: {
  text: string;
  voice: OfflineVoiceId;
  signal?: AbortSignal;
}) {
  return requestWorker<OfflineSpeechResult>(
    { type: "synthesize", text, voice },
    { signal },
  );
}

async function deleteMatchingEntries(
  cacheName: string,
  modelIdentifier: string,
) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((request) => request.url.includes(modelIdentifier))
      .map((request) => cache.delete(request)),
  );
}

export async function removeOfflineVoicePack() {
  terminateWorker("The offline voice pack was removed.");
  forceWasm = false;
  if (typeof caches === "undefined") return;

  await Promise.all([
    deleteMatchingEntries(TRANSFORMERS_CACHE_NAME, OFFLINE_MODEL_ID),
    deleteMatchingEntries(KOKORO_VOICE_CACHE_NAME, OFFLINE_MODEL_ID),
  ]);
}

export function disposeOfflineSpeechWorker() {
  terminateWorker();
}
