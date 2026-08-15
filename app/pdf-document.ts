import pdfDocumentWorkerUrl from "./pdf-document.worker.ts?worker&url";
import {
  discardStalePdfMessage,
  isCurrentPdfSession,
} from "./pdf-document-protocol.mjs";
import type {
  PdfWorkerMessage,
  PdfWorkerRequest,
  StoredPdfManifest,
  StoredPdfPage,
} from "./pdf-document-types";

type PdfWorkerStartRequest = PdfWorkerRequest extends infer Request
  ? Request extends { type: "import" | "open" }
    ? Omit<Request, "jobId" | "revision">
    : never
  : never;

export type PdfDocumentCallbacks = {
  onPage?: (
    document: StoredPdfManifest,
    page: StoredPdfPage,
    first: boolean,
  ) => void;
  onBitmap?: (message: Extract<PdfWorkerMessage, { type: "bitmap" }>) => void;
  onComplete?: (document: StoredPdfManifest) => void;
  onProgress?: (
    message: Extract<PdfWorkerMessage, { type: "progress" }>,
  ) => void;
  onRenderFallback?: (reason: string) => void;
  onReset?: (reason: "stored-repair") => void;
  onError?: (
    message: string,
    outcome?: Extract<PdfWorkerMessage, { type: "error" }>["outcome"],
  ) => void;
};

export type PdfDocumentSession = {
  jobId: number;
  revision: string;
  document: StoredPdfManifest;
  page: StoredPdfPage;
};

let nextPdfJobId = 1;

function createRevision() {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class PdfDocumentClient {
  #callbacks: PdfDocumentCallbacks;
  #worker: Worker | null = null;
  #jobId = 0;
  #revision = "";
  #firstPage:
    | {
        resolve: (session: PdfDocumentSession) => void;
        reject: (reason?: unknown) => void;
        settled: boolean;
      }
    | undefined;

  constructor(callbacks: PdfDocumentCallbacks = {}) {
    this.#callbacks = callbacks;
  }

  get jobId() {
    return this.#jobId;
  }

  get revision() {
    return this.#revision;
  }

  #start(request: PdfWorkerStartRequest) {
    this.cancel("This PDF operation was replaced.");
    const jobId = nextPdfJobId++;
    const revision = createRevision();
    this.#jobId = jobId;
    this.#revision = revision;
    const worker = new Worker(pdfDocumentWorkerUrl, {
      name: `linelight-pdf-${jobId}`,
      type: "module",
    });
    this.#worker = worker;
    const firstPage = new Promise<PdfDocumentSession>((resolve, reject) => {
      this.#firstPage = { resolve, reject, settled: false };
    });
    worker.addEventListener("message", (event: MessageEvent<PdfWorkerMessage>) => {
      const message = event.data;
      if (
        worker !== this.#worker ||
        !isCurrentPdfSession(
          { jobId: this.#jobId, revision: this.#revision },
          message,
        )
      ) {
        discardStalePdfMessage(message);
        return;
      }
      if (message.type === "page") {
        this.#callbacks.onPage?.(
          message.document,
          message.page,
          message.first,
        );
        if (message.first && this.#firstPage && !this.#firstPage.settled) {
          this.#firstPage.settled = true;
          this.#firstPage.resolve({
            jobId,
            revision,
            document: message.document,
            page: message.page,
          });
        }
      } else if (message.type === "bitmap") {
        this.#callbacks.onBitmap?.(message);
      } else if (message.type === "reset") {
        this.#callbacks.onReset?.(message.reason);
      } else if (message.type === "complete") {
        this.#callbacks.onComplete?.(message.document);
      } else if (message.type === "progress") {
        this.#callbacks.onProgress?.(message);
      } else if (message.type === "render-fallback") {
        this.#callbacks.onRenderFallback?.(message.reason);
      } else if (message.type === "error") {
        if (this.#firstPage && !this.#firstPage.settled) {
          this.#firstPage.settled = true;
          this.#firstPage.reject(new Error(message.message));
        }
        this.#callbacks.onError?.(message.message, message.outcome);
      }
    });
    worker.addEventListener("error", (event) => {
      if (worker !== this.#worker) return;
      event.preventDefault();
      const message = event.message || "The private PDF worker stopped unexpectedly.";
      if (this.#firstPage && !this.#firstPage.settled) {
        this.#firstPage.settled = true;
        this.#firstPage.reject(new Error(message));
      }
      this.#callbacks.onError?.(message);
    });
    worker.postMessage({ ...request, jobId, revision } as PdfWorkerRequest);
    return firstPage;
  }

  import(source: File, documentId: string, title: string, scale: number) {
    return this.#start({
      type: "import",
      source,
      documentId,
      title,
      scale,
    });
  }

  open(documentId: string, scale: number) {
    return this.#start({ type: "open", documentId, scale });
  }

  requestRender(
    pageNumber: number,
    scale: number,
    options: { enabled?: boolean; visible?: boolean; distance?: number } = {},
  ) {
    if (!this.#worker) return;
    this.#worker.postMessage({
      type: "render",
      jobId: this.#jobId,
      revision: this.#revision,
      pageNumber,
      scale,
      ...options,
    } satisfies PdfWorkerRequest);
  }

  cancel(message = "The PDF operation was cancelled.") {
    const worker = this.#worker;
    if (!worker) return;
    worker.postMessage({
      type: "cancel",
      jobId: this.#jobId,
      revision: this.#revision,
    } satisfies PdfWorkerRequest);
    worker.terminate();
    this.#worker = null;
    if (this.#firstPage && !this.#firstPage.settled) {
      this.#firstPage.settled = true;
      this.#firstPage.reject(new DOMException(message, "AbortError"));
    }
  }

  dispose() {
    this.cancel();
    this.#callbacks = {};
  }
}
