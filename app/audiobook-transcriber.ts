import alignmentWorkerUrl from "./audiobook-alignment.worker.ts?worker&url";

export type AudiobookTranscriberProgress = {
  progress: number | null;
  label: string;
};

export type AudiobookTranscriptResult = {
  text: string;
  segments: Array<{
    startSeconds: number;
    endSeconds: number;
    text: string;
  }>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (progress: AudiobookTranscriberProgress) => void;
  removeAbortListener?: () => void;
};

type WorkerResponse =
  | {
      id: number;
      type: "progress";
      progress: number | null;
      label: string;
    }
  | { id: number; type: "success"; result: unknown }
  | { id: number; type: "error"; message: string };

let worker: Worker | null = null;
let requestId = 1;
const pending = new Map<number, PendingRequest>();

function rejectAll(reason: unknown) {
  for (const request of pending.values()) {
    request.removeAbortListener?.();
    request.reject(reason);
  }
  pending.clear();
}

export function disposeAudiobookTranscriber(reason?: unknown) {
  worker?.terminate();
  worker = null;
  rejectAll(
    reason ?? new DOMException("Audiobook alignment was canceled.", "AbortError"),
  );
}

function getWorker() {
  if (worker) return worker;
  const nextWorker = new Worker(alignmentWorkerUrl, { type: "module" });
  nextWorker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return;
    if (message.type === "progress") {
      request.onProgress?.({
        progress: message.progress,
        label: message.label,
      });
      return;
    }
    pending.delete(message.id);
    request.removeAbortListener?.();
    if (message.type === "success") request.resolve(message.result);
    else request.reject(new Error(message.message));
  });
  nextWorker.addEventListener("error", () => {
    if (worker === nextWorker) worker = null;
    nextWorker.terminate();
    rejectAll(new Error("The local audiobook alignment worker stopped."));
  });
  worker = nextWorker;
  return nextWorker;
}

function requestWorker<T>(
  message: Record<string, unknown>,
  {
    signal,
    onProgress,
    transfer = [],
  }: {
    signal?: AbortSignal;
    onProgress?: (progress: AudiobookTranscriberProgress) => void;
    transfer?: Transferable[];
  } = {},
) {
  if (signal?.aborted) {
    return Promise.reject(
      new DOMException("Audiobook alignment was canceled.", "AbortError"),
    );
  }
  const id = requestId;
  requestId += 1;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      disposeAudiobookTranscriber(
        new DOMException("Audiobook alignment was canceled.", "AbortError"),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      onProgress,
      removeAbortListener: () =>
        signal?.removeEventListener("abort", onAbort),
    });
    getWorker().postMessage({ ...message, id }, transfer);
  });
}

export function prepareAudiobookTranscriber(options: {
  signal?: AbortSignal;
  onProgress?: (progress: AudiobookTranscriberProgress) => void;
} = {}) {
  return requestWorker<{ modelRevision: string }>(
    { type: "prepare" },
    options,
  );
}

export function transcribeAudiobookWindow({
  audio,
  windowStartSeconds,
  windowEndSeconds,
  signal,
  onProgress,
}: {
  audio: Float32Array;
  windowStartSeconds: number;
  windowEndSeconds: number;
  signal?: AbortSignal;
  onProgress?: (progress: AudiobookTranscriberProgress) => void;
}) {
  return requestWorker<AudiobookTranscriptResult>(
    {
      type: "transcribe",
      audio,
      windowStartSeconds,
      windowEndSeconds,
    },
    { signal, onProgress, transfer: [audio.buffer] },
  );
}
