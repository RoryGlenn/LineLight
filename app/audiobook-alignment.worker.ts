import { env as transformersEnv, pipeline } from "@huggingface/transformers";
import ortWasmUrl from
  "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import {
  AUDIOBOOK_ALIGNMENT_MODEL_ID,
  AUDIOBOOK_ALIGNMENT_MODEL_REVISION,
} from "./audiobook-alignment.mjs";
import { AUDIOBOOK_ALIGNMENT_MODEL_LOCAL_PATH } from
  "./audiobook-alignment-model.mjs";

type PrepareRequest = { id: number; type: "prepare" };
type TranscribeRequest = {
  id: number;
  type: "transcribe";
  audio: Float32Array;
  windowStartSeconds: number;
  windowEndSeconds: number;
};
type RequestMessage = PrepareRequest | TranscribeRequest;
type WorkerScope = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<RequestMessage>) => void,
  ): void;
  postMessage(message: unknown): void;
};
type PipelineProgress = {
  status?: string;
  progress?: number;
  file?: string;
};
type TranscriptChunk = {
  text?: unknown;
  timestamp?: unknown;
};
type TranscriptResult = {
  text?: unknown;
  chunks?: unknown;
};
type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<TranscriptResult>;

const workerScope = globalThis as unknown as WorkerScope;
transformersEnv.allowLocalModels = true;
transformersEnv.allowRemoteModels = false;
transformersEnv.localModelPath = AUDIOBOOK_ALIGNMENT_MODEL_LOCAL_PATH;
transformersEnv.useBrowserCache = true;
const wasmBackend = transformersEnv.backends.onnx.wasm;
if (wasmBackend) {
  wasmBackend.wasmPaths = { wasm: ortWasmUrl };
  wasmBackend.numThreads = Math.max(
    1,
    Math.min(4, Math.floor((globalThis.navigator?.hardwareConcurrency ?? 2) / 2)),
  );
  wasmBackend.proxy = false;
}

let transcriberPromise: Promise<Transcriber> | null = null;
const createPipeline = pipeline as unknown as (
  task: string,
  model: string,
  options: Record<string, unknown>,
) => Promise<Transcriber>;

function reportProgress(id: number, update: PipelineProgress) {
  const progress = Number(update.progress);
  workerScope.postMessage({
    id,
    type: "progress",
    progress: Number.isFinite(progress)
      ? Math.max(0, Math.min(100, Math.round(progress)))
      : null,
    label:
      update.status === "ready"
        ? "Local alignment model is ready."
        : update.status === "progress"
          ? "Downloading the local alignment model…"
          : "Loading the local alignment model…",
  });
}

function getTranscriber(id: number) {
  transcriberPromise ??= createPipeline(
    "automatic-speech-recognition",
    AUDIOBOOK_ALIGNMENT_MODEL_ID,
    {
      device: "wasm",
      dtype: "q8",
      revision: AUDIOBOOK_ALIGNMENT_MODEL_REVISION,
      progress_callback: (update: PipelineProgress) =>
        reportProgress(id, update),
    },
  );
  return transcriberPromise;
}

function cleanTimestamp(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1])
  ) {
    return null;
  }
  return [Math.max(0, Number(value[0])), Math.max(0, Number(value[1]))];
}

async function handleRequest(message: RequestMessage) {
  try {
    const transcriber = await getTranscriber(message.id);
    if (message.type === "prepare") {
      workerScope.postMessage({
        id: message.id,
        type: "success",
        result: { modelRevision: AUDIOBOOK_ALIGNMENT_MODEL_REVISION },
      });
      return;
    }
    const result = await transcriber(message.audio, {
      language: "english",
      task: "transcribe",
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 0,
    });
    const text = typeof result.text === "string" ? result.text.trim() : "";
    const chunks = Array.isArray(result.chunks)
      ? (result.chunks as TranscriptChunk[])
      : [];
    const segments = chunks.flatMap((chunk) => {
      const timestamp = cleanTimestamp(chunk.timestamp);
      const segmentText =
        typeof chunk.text === "string" ? chunk.text.trim() : "";
      if (!timestamp || !segmentText) return [];
      return [{
        startSeconds: Math.min(
          message.windowEndSeconds,
          message.windowStartSeconds + timestamp[0],
        ),
        endSeconds: Math.min(
          message.windowEndSeconds,
          message.windowStartSeconds + timestamp[1],
        ),
        text: segmentText,
      }];
    });
    if (!segments.length && text) {
      segments.push({
        startSeconds: message.windowStartSeconds,
        endSeconds: message.windowEndSeconds,
        text,
      });
    }
    workerScope.postMessage({
      id: message.id,
      type: "success",
      result: { text, segments },
    });
  } catch {
    transcriberPromise = null;
    workerScope.postMessage({
      id: message.id,
      type: "error",
      message:
        "The local audiobook alignment model could not process this audio window.",
    });
  }
}

workerScope.addEventListener("message", (event) => {
  void handleRequest(event.data);
});
