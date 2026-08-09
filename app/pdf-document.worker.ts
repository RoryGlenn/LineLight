import * as pdfjs from "pdfjs-dist";
import pdfParserWorkerUrl from "./pdf-parser.worker.ts?worker&url";
import {
  addReaderPdfPageOne,
  appendReaderPdfPage,
  completeReaderPdfDocument,
  discardReaderPdfDocument,
  getReaderDocument,
  getReaderPdfPage,
  getReaderPdfPageBatch,
  getReaderPdfSource,
  restoreReaderLegacyPdfDocument,
} from "./reader-library.mjs";
import {
  PDF_DOCUMENT_STORAGE_VERSION,
  buildPdfDocumentChunk,
  coalescePdfRenderRequests,
  createPdfModelCursor,
  prioritizePdfRenderRequests,
} from "./pdf-document-model.mjs";
import { buildPdfOutline } from "./pdf-outline.mjs";
import {
  PDF_TEXT_MODEL_VERSION,
  buildPdfTextModel,
  pdfTextParagraphs,
} from "./pdf-text-model.mjs";
import type {
  PdfWorkerMessage,
  PdfWorkerRequest,
  StoredPdfManifest,
  StoredPdfPage,
} from "./pdf-document-types";
import type { PdfPageLayout } from "./pdf-page-view";
import { createPdfRasterScheduler } from "./pdf-raster-scheduler.mjs";
import { applyPdfWorkerFilter } from "./pdf-worker-filters.mjs";
import {
  canStartPdfPage,
  isCurrentPdfSession,
  isPdfCancellationForSession,
  resolvePdfTerminalOutcome,
  waitForPdfDocumentReady,
  waitForPdfParserWorkerReady,
} from "./pdf-document-protocol.mjs";

type WorkerScope = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<PdfWorkerRequest>) => void,
  ): void;
  postMessage(message: PdfWorkerMessage, transfer?: Transferable[]): void;
};

type ActiveContext = {
  jobId: number;
  revision: string;
  documentId: string;
  loadingTask: pdfjs.PDFDocumentLoadingTask | null;
  document: pdfjs.PDFDocumentProxy | null;
  documentReady: Promise<pdfjs.PDFDocumentProxy> | null;
  parserPort: Worker | null;
  parserWorker: pdfjs.PDFWorker | null;
  parserAbort: AbortController;
  renderTask: pdfjs.RenderTask | null;
  rasterScheduler: ReturnType<typeof createPdfRasterScheduler>;
  cancelled: boolean;
};

type RenderRequest = Extract<PdfWorkerRequest, { type: "render" }> & {
  sequence: number;
};

const workerScope = globalThis as unknown as WorkerScope;
let active: ActiveContext | null = null;
let renderSequence = 0;
let renderQueue: RenderRequest[] = [];
let drainingRenders = false;
let fallbackReportedForRevision = "";

class PdfImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfImportValidationError";
  }
}

class OffscreenCanvasFactory {
  create(width: number, height: number) {
    if (typeof OffscreenCanvas === "undefined") {
      throw new Error("OffscreenCanvas is unavailable.");
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    return {
      canvas,
      context: context ? createFilteredCanvasContext(context) : null,
    };
  }

  reset(
    canvasAndContext: { canvas: OffscreenCanvas | null },
    width: number,
    height: number,
  ) {
    if (!canvasAndContext.canvas) throw new Error("Canvas is unavailable.");
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: {
    canvas: OffscreenCanvas | null;
    context: OffscreenCanvasRenderingContext2D | null;
  }) {
    if (canvasAndContext.canvas) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
    }
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

// PDF.js normally represents these effects with DOM-backed SVG filters. The
// document worker registers equivalent pixel transforms so Alpha/Luminosity
// soft masks (including their alpha transfer map) stay off the Window thread.
// General drawing transfer functions can affect every canvas operation rather
// than only image composition, so those pages are rejected before rasterizing
// and use the bounded visible-page fallback instead of dropping an effect.
type WorkerFilter =
  | { kind: "alpha"; map?: Uint8Array | Uint8ClampedArray | null }
  | { kind: "luminosity"; map?: Uint8Array | Uint8ClampedArray | null };

const workerFilters = new Map<string, WorkerFilter>();
let nextWorkerFilterId = 1;

function registerWorkerFilter(filter: WorkerFilter) {
  const token = `url(#linelight-pdf-worker-filter-${nextWorkerFilterId++})`;
  workerFilters.set(token, filter);
  return token;
}

class WorkerFilterFactory {
  private tokens: string[] = [];

  private add(filter: WorkerFilter) {
    const token = registerWorkerFilter(filter);
    this.tokens.push(token);
    return token;
  }

  addFilter() {
    return "none";
  }
  addHCMFilter() {
    return "none";
  }
  addAlphaFilter(map?: Uint8Array | Uint8ClampedArray | null) {
    return this.add({ kind: "alpha", map });
  }
  addLuminosityFilter(map?: Uint8Array | Uint8ClampedArray | null) {
    return this.add({ kind: "luminosity", map });
  }
  addHighlightHCMFilter() {
    return "none";
  }
  destroy() {
    for (const token of this.tokens) workerFilters.delete(token);
    this.tokens = [];
  }
}

function createFilteredCanvasContext(
  context: OffscreenCanvasRenderingContext2D,
) {
  let activeFilter: WorkerFilter | null = null;
  const filterStack: Array<WorkerFilter | null> = [];
  const propertyOverrides = new Map<PropertyKey, unknown>();
  const save = () => {
    filterStack.push(activeFilter);
    context.save();
  };
  const restore = () => {
    activeFilter = filterStack.pop() ?? null;
    context.restore();
  };
  const drawImage = (...arguments_: unknown[]) => {
    if (!activeFilter) {
      return Reflect.apply(context.drawImage, context, arguments_);
    }
    const source = arguments_[0] as {
      width?: number;
      height?: number;
      displayWidth?: number;
      displayHeight?: number;
    };
    const width = Math.max(
      1,
      Math.trunc(source.width ?? source.displayWidth ?? 1),
    );
    const height = Math.max(
      1,
      Math.trunc(source.height ?? source.displayHeight ?? 1),
    );
    const filteredCanvas = new OffscreenCanvas(width, height);
    const filteredContext = filteredCanvas.getContext("2d");
    if (!filteredContext) {
      throw new Error("The PDF filter canvas could not be created.");
    }
    filteredContext.drawImage(source as CanvasImageSource, 0, 0);
    const pixels = filteredContext.getImageData(0, 0, width, height);
    applyPdfWorkerFilter(pixels, activeFilter);
    filteredContext.putImageData(pixels, 0, 0);
    return Reflect.apply(
      context.drawImage,
      context,
      [filteredCanvas, ...arguments_.slice(1)],
    );
  };
  return new Proxy(context, {
    get(target, property) {
      if (propertyOverrides.has(property)) {
        return propertyOverrides.get(property);
      }
      if (property === "filter") {
        const token = [...workerFilters.entries()].find(
          ([, filter]) => filter === activeFilter,
        )?.[0];
        return token ?? target.filter;
      }
      if (property === "save") return save;
      if (property === "restore") return restore;
      if (property === "drawImage") return drawImage;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "filter") {
        const filter = workerFilters.get(String(value));
        activeFilter = filter ?? null;
        target.filter = filter ? "none" : String(value);
        return true;
      }
      if (typeof value === "function" || String(property).startsWith("_")) {
        propertyOverrides.set(property, value);
        return true;
      }
      return Reflect.set(target, property, value, target);
    },
    deleteProperty(_target, property) {
      propertyOverrides.delete(property);
      return true;
    },
  });
}

function post(message: PdfWorkerMessage, transfer?: Transferable[]) {
  workerScope.postMessage(message, transfer);
}

function mark(context: ActiveContext, stage: string) {
  performance.mark(
    `linelight:pdf:${context.documentId}:${context.revision}:${stage}`,
  );
}

function assertCurrent(context: ActiveContext) {
  if (context.cancelled || active !== context) {
    throw new DOMException("The PDF operation was cancelled.", "AbortError");
  }
}

function yieldToMessages() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function disposeContext(context: ActiveContext | null) {
  if (!context) return;
  context.cancelled = true;
  context.renderTask?.cancel();
  context.renderTask = null;
  await context.loadingTask?.destroy().catch(() => undefined);
  if (context.document) {
    await context.document.destroy().catch(() => undefined);
  }
  context.parserWorker?.destroy();
  context.parserAbort.abort();
  context.parserPort?.terminate();
  context.document = null;
  context.documentReady = null;
  context.loadingTask = null;
  context.parserWorker = null;
  context.parserPort = null;
}

async function replaceContext(
  jobId: number,
  revision: string,
  documentId: string,
) {
  const previous = active;
  active = null;
  await disposeContext(previous);
  renderQueue = [];
  const context: ActiveContext = {
    jobId,
    revision,
    documentId,
    loadingTask: null,
    document: null,
    documentReady: null,
    parserPort: null,
    parserWorker: null,
    parserAbort: new AbortController(),
    renderTask: null,
    rasterScheduler: null as unknown as ReturnType<
      typeof createPdfRasterScheduler
    >,
    cancelled: false,
  };
  context.rasterScheduler = createPdfRasterScheduler(
    (pageNumber: number, scale: number) =>
      performPdfPageRender(context, pageNumber, scale),
  );
  active = context;
  return context;
}

async function loadPdf(context: ActiveContext, source: Blob) {
  mark(context, "source-read-start");
  const bytes = new Uint8Array(await source.arrayBuffer());
  assertCurrent(context);
  mark(context, "source-read-end");
  const parserPort = new Worker(pdfParserWorkerUrl, { type: "module" });
  context.parserPort = parserPort;
  mark(context, "parser-worker-start");
  try {
    await waitForPdfParserWorkerReady(parserPort, {
      signal: context.parserAbort.signal,
    });
  } catch (error) {
    parserPort.terminate();
    context.parserPort = null;
    throw error;
  }
  assertCurrent(context);
  mark(context, "parser-worker-ready");
  const parserWorker = pdfjs.PDFWorker.create({ port: parserPort });
  context.parserWorker = parserWorker;
  context.loadingTask = pdfjs.getDocument({
    data: bytes,
    worker: parserWorker,
    CanvasFactory: OffscreenCanvasFactory,
    FilterFactory: WorkerFilterFactory,
    disableFontFace: true,
    isOffscreenCanvasSupported: typeof OffscreenCanvas !== "undefined",
  });
  const document = await context.loadingTask.promise;
  assertCurrent(context);
  context.document = document;
  mark(context, "document-ready");
  return document;
}

function createPageRecord(
  context: ActiveContext,
  pageNumber: number,
  page: pdfjs.PDFPageProxy,
  content: Awaited<ReturnType<pdfjs.PDFPageProxy["getTextContent"]>>,
  cursor: ReturnType<typeof createPdfModelCursor>,
) {
  const viewport = page.getViewport({ scale: 1 });
  const entries = content.items
    .map((item, textDivIndex) => ({ item, textDivIndex }))
    .filter(
      (
        entry,
      ): entry is {
        item: Extract<(typeof content.items)[number], { str: string }>;
        textDivIndex: number;
      } => "str" in entry.item,
    );
  const textModel = buildPdfTextModel(
    entries.map(({ item }) => ({ text: item.str, hasEOL: item.hasEOL })),
    cursor.wordIndex,
  );
  const items: PdfPageLayout["items"] = [];
  entries.forEach(({ item, textDivIndex }, itemIndex) => {
    const wordIndices = textModel.items[itemIndex]?.wordIndices ?? [];
    if (!item.str || !wordIndices.length) return;
    const transformed = pdfjs.Util.transform(viewport.transform, item.transform);
    const fontSize = Math.max(1, Math.hypot(transformed[2], transformed[3]));
    const textStyle = content.styles[item.fontName];
    const ascent =
      textStyle?.ascent ??
      (textStyle?.descent ? 1 + textStyle.descent : 0.82);
    items.push({
      text: item.str,
      left: transformed[4],
      top: transformed[5] - fontSize * ascent,
      width: Math.max(Math.abs(item.width * viewport.scale), 1),
      height: fontSize,
      fontSize,
      angle: (Math.atan2(transformed[1], transformed[0]) * 180) / Math.PI,
      wordStart: Math.min(...wordIndices),
      wordCount: new Set(wordIndices).size,
      wordIndices,
      textDivIndex,
    });
  });
  const paragraphs = pdfTextParagraphs(textModel.text);
  const model = buildPdfDocumentChunk(paragraphs, cursor);
  if (model.tokens.length !== textModel.wordCount) {
    throw new Error(
      `PDF page ${pageNumber} produced inconsistent narration tokens.`,
    );
  }
  const record: StoredPdfPage = {
    documentId: context.documentId,
    revision: context.revision,
    pageNumber,
    layout: {
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      rotation: viewport.rotation,
      rawDims: viewport.rawDims as {
        pageHeight: number;
        pageWidth: number;
        pageX: number;
        pageY: number;
      },
      items,
    },
    model,
    textContent: content as unknown as StoredPdfPage["textContent"],
  };
  return record;
}

function canRenderOffscreen() {
  return (
    typeof OffscreenCanvas !== "undefined" &&
    typeof OffscreenCanvas.prototype.transferToImageBitmap === "function" &&
    typeof ImageBitmap !== "undefined"
  );
}

async function hasUnsupportedWorkerFilters(page: pdfjs.PDFPageProxy) {
  const operatorList = await page.getOperatorList();
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operator = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];
    if (
      operator === pdfjs.OPS.beginGroup &&
      args?.[0]?.smask &&
      !["Alpha", "Luminosity"].includes(args[0].smask.subtype)
    ) {
      return true;
    }
    if (operator !== pdfjs.OPS.setGState) continue;
    const states = args?.[0];
    if (!Array.isArray(states)) continue;
    for (const state of states) {
      if (!Array.isArray(state) || state[0] !== "TR" || state[1] === null) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function reportRenderFallback(context: ActiveContext, reason: string) {
  if (fallbackReportedForRevision === context.revision) return;
  fallbackReportedForRevision = context.revision;
  post({
    type: "render-fallback",
    jobId: context.jobId,
    revision: context.revision,
    reason,
  });
}

async function performPdfPageRender(
  context: ActiveContext,
  pageNumber: number,
  scale: number,
) {
  assertCurrent(context);
  const document = await waitForPdfDocumentReady(context);
  assertCurrent(context);
  if (!document) {
    throw new Error("The PDF parser did not become ready for rendering.");
  }
  if (!canRenderOffscreen()) {
    reportRenderFallback(
      context,
      "OffscreenCanvas is unavailable; LineLight will use cooperative visible-page rendering.",
    );
    return;
  }
  const page = await document.getPage(pageNumber);
  assertCurrent(context);
  if (await hasUnsupportedWorkerFilters(page)) {
    reportRenderFallback(
      context,
      "This PDF page uses filters that require the browser DOM; LineLight will render visible pages cooperatively.",
    );
    page.cleanup();
    return;
  }
  const safeScale = Math.min(2, Math.max(1, Number(scale) || 1));
  const viewport = page.getViewport({ scale: safeScale });
  const canvas = new OffscreenCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  const rawCanvasContext = canvas.getContext("2d", { alpha: false });
  const canvasContext = rawCanvasContext
    ? createFilteredCanvasContext(rawCanvasContext)
    : null;
  if (!canvasContext) throw new Error("The PDF canvas could not be created.");
  mark(context, `page-${pageNumber}-raster-start`);
  const renderTask = page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: canvasContext as unknown as CanvasRenderingContext2D,
    viewport,
  });
  context.renderTask = renderTask;
  renderTask.onContinue = (continueRendering: () => void) => {
    setTimeout(continueRendering, 0);
  };
  await renderTask.promise;
  context.renderTask = null;
  assertCurrent(context);
  const bitmap = canvas.transferToImageBitmap();
  mark(context, `page-${pageNumber}-raster-end`);
  post(
    {
      type: "bitmap",
      jobId: context.jobId,
      revision: context.revision,
      pageNumber,
      scale: safeScale,
      width: canvas.width,
      height: canvas.height,
      bitmap,
    },
    [bitmap],
  );
  page.cleanup();
}

async function renderPdfPage(
  context: ActiveContext,
  pageNumber: number,
  scale: number,
) {
  const safeScale = Math.min(2, Math.max(1, Number(scale) || 1));
  await context.rasterScheduler.run(pageNumber, safeScale);
}

async function drainRenderQueue(context: ActiveContext) {
  if (drainingRenders || active !== context) return;
  drainingRenders = true;
  try {
    while (renderQueue.length && active === context && !context.cancelled) {
      const [next, ...remaining] = prioritizePdfRenderRequests(renderQueue);
      renderQueue = remaining.filter(
        (request) => request.pageNumber !== next.pageNumber,
      );
      await renderPdfPage(context, next.pageNumber, next.scale).catch((error) => {
        if (error instanceof Error && error.name === "RenderingCancelledException") {
          return;
        }
        throw error;
      });
      await yieldToMessages();
    }
  } finally {
    drainingRenders = false;
  }
}

function manifestFor(
  context: ActiveContext,
  identity: { title: string; author?: string },
  pageCount: number,
  wordCount: number,
  legacyRecovery?: StoredPdfManifest["pdfLegacyRecovery"],
): StoredPdfManifest {
  return {
    id: context.documentId,
    title: identity.title,
    author: identity.author ?? `${pageCount} page PDF`,
    kind: "pdf",
    paragraphs: [],
    pdfCompletedPages: 1,
    pdfImportStatus: "importing",
    pdfPageCount: pageCount,
    pdfRevision: context.revision,
    pdfStorageVersion: PDF_DOCUMENT_STORAGE_VERSION,
    pdfTextModelVersion: PDF_TEXT_MODEL_VERSION,
    wordCount,
    ...(legacyRecovery ? { pdfLegacyRecovery: legacyRecovery } : {}),
  };
}

function messageManifest(document: StoredPdfManifest) {
  const safeDocument = { ...document };
  delete safeDocument.pdfLegacyRecovery;
  return safeDocument;
}

async function processSource(
  request: Extract<PdfWorkerRequest, { type: "import" | "open" }>,
  source: Blob,
  identity: { title: string; author?: string },
  legacyRecovery?: StoredPdfManifest["pdfLegacyRecovery"],
) {
  const context = await replaceContext(
    request.jobId,
    request.revision,
    request.documentId,
  );
  let pageOnePersisted = false;
  try {
    context.documentReady = loadPdf(context, source);
    const document = await context.documentReady;
    let cursor = createPdfModelCursor();
    const pageWordStarts: number[] = [];
    let manifest: StoredPdfManifest | null = null;
    const milestones = {
      pageOnePersisted: false,
      pageOneRasterSettled: false,
    };
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      assertCurrent(context);
      if (!canStartPdfPage(pageNumber, milestones)) {
        throw new Error("PDF background work started before page one settled.");
      }
      pageWordStarts.push(cursor.wordIndex);
      mark(context, `page-${pageNumber}-text-start`);
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      assertCurrent(context);
      const record = createPageRecord(
        context,
        pageNumber,
        page,
        content,
        cursor,
      );
      cursor = record.model.nextCursor;
      mark(context, `page-${pageNumber}-text-end`);
      if (pageNumber === 1) {
        manifest = manifestFor(
          context,
          identity,
          document.numPages,
          cursor.wordIndex,
          legacyRecovery,
        );
        const entry = await addReaderPdfPageOne(manifest, source, record);
        assertCurrent(context);
        manifest = { ...manifest, wordCount: entry.wordCount };
        milestones.pageOnePersisted = true;
        pageOnePersisted = true;
        mark(context, "page-1-persisted");
        post({
          type: "page",
          jobId: context.jobId,
          revision: context.revision,
          document: messageManifest(manifest),
          page: record,
          first: true,
        });
        await renderPdfPage(context, 1, request.scale);
        milestones.pageOneRasterSettled = true;
        renderQueue = renderQueue.filter(
          (queued) => queued.pageNumber !== 1,
        );
        mark(context, "page-1-posted");
      } else {
        manifest = (await appendReaderPdfPage(
          context.documentId,
          context.revision,
          record,
          { completedPages: pageNumber, wordCount: cursor.wordIndex },
        )) as StoredPdfManifest;
        assertCurrent(context);
        post({
          type: "page",
          jobId: context.jobId,
          revision: context.revision,
          document: messageManifest(manifest),
          page: record,
          first: false,
        });
      }
      post({
        type: "progress",
        jobId: context.jobId,
        revision: context.revision,
        completedPages: pageNumber,
        pageCount: document.numPages,
        stage: pageNumber === 1 ? "first-page-ready" : "extracting",
      });
      page.cleanup();
      await yieldToMessages();
      await drainRenderQueue(context);
    }
    if (cursor.wordIndex < 8) {
      throw new PdfImportValidationError(
        "This PDF looks like a scan and has very little selectable text. OCR support is planned for the next version.",
      );
    }
    assertCurrent(context);
    const rawOutline = await document.getOutline().catch(() => []);
    const outline = await buildPdfOutline(
      rawOutline,
      document,
      pageWordStarts,
      cursor.wordIndex,
    );
    const completed = (await completeReaderPdfDocument(
      context.documentId,
      context.revision,
      { outline, wordCount: cursor.wordIndex },
    )) as StoredPdfManifest;
    assertCurrent(context);
    mark(context, "complete");
    post({
      type: "complete",
      jobId: context.jobId,
      revision: context.revision,
      document: completed,
    });
  } catch (error) {
    if (context.cancelled || active !== context) return;
    let cleanup: "discard" | "legacy-restore" | null = null;
    let cleanupConfirmed = false;
    if (legacyRecovery) {
      cleanup = "legacy-restore";
      cleanupConfirmed = await restoreReaderLegacyPdfDocument(
        context.documentId,
        context.revision,
      ).catch(() => false);
    } else if (error instanceof PdfImportValidationError) {
      cleanup = "discard";
      cleanupConfirmed = await discardReaderPdfDocument(
        context.documentId,
        context.revision,
      ).catch(() => false);
    }
    const survivingDocument = cleanupConfirmed
      ? null
      : await getReaderDocument(context.documentId).catch(() => null);
    const outcome = resolvePdfTerminalOutcome({
      cleanup,
      cleanupConfirmed,
      pageOnePersisted,
      survivingDocument,
      legacyExpected: Boolean(legacyRecovery),
    }) as Extract<PdfWorkerMessage, { type: "error" }>["outcome"];
    const cleanupWarning =
      cleanup && !cleanupConfirmed
        ? " LineLight could not confirm local cleanup, so the staged import remains resumable."
        : "";
    post({
      type: "error",
      jobId: context.jobId,
      revision: context.revision,
      message:
        (error instanceof Error
          ? error.message
          : "This PDF could not be opened.") + cleanupWarning,
      outcome,
    });
  }
}

async function openStoredPdf(
  request: Extract<PdfWorkerRequest, { type: "open" }>,
) {
  const stored = (await getReaderDocument(request.documentId)) as
    | StoredPdfManifest
    | (StoredPdfManifest & { pdfData?: Uint8Array })
    | null;
  if (!stored || stored.kind !== "pdf") {
    throw new Error("This PDF is no longer in the private library.");
  }
  if (stored.pdfStorageVersion !== PDF_DOCUMENT_STORAGE_VERSION) {
    const legacyBytes = (stored as { pdfData?: Uint8Array }).pdfData;
    if (!legacyBytes?.length) {
      post({
        type: "error",
        jobId: request.jobId,
        revision: request.revision,
        message:
          "The original PDF source is unavailable. LineLight kept the existing readable Focus text.",
        outcome: "legacy-restored",
      });
      return;
    }
    const source = new Blob([new Uint8Array(legacyBytes).buffer], {
      type: "application/pdf",
    });
    await processSource(
      request,
      source,
      {
        title: stored.title,
        author: stored.author,
      },
      stored as StoredPdfManifest["pdfLegacyRecovery"],
    );
    return;
  }
  const source = await getReaderPdfSource(request.documentId);
  if (!source) throw new Error("The stored PDF source is incomplete.");
  if (stored.pdfImportStatus !== "ready") {
    await processSource(
      request,
      source,
      {
        title: stored.title,
        author: stored.author,
      },
      stored.pdfLegacyRecovery,
    );
    return;
  }
  const context = await replaceContext(
    request.jobId,
    request.revision,
    request.documentId,
  );
  const repairStoredDocument = async (exposedPages: boolean) => {
    if (exposedPages) {
      post({
        type: "reset",
        jobId: context.jobId,
        revision: context.revision,
        reason: "stored-repair",
      });
    }
    await processSource(request, source, {
      title: stored.title,
      author: stored.author,
    });
  };
  const firstPage = (await getReaderPdfPage(
    request.documentId,
    1,
  )) as StoredPdfPage | null;
  assertCurrent(context);
  if (!firstPage) {
    await repairStoredDocument(false);
    return;
  }
  const sessionDocument = { ...stored, pdfRevision: request.revision };
  context.documentReady = loadPdf(context, source);
  post({
    type: "page",
    jobId: context.jobId,
    revision: context.revision,
    document: sessionDocument,
    page: { ...firstPage, revision: request.revision },
    first: true,
  });
  post({
    type: "progress",
    jobId: context.jobId,
    revision: context.revision,
    completedPages: 1,
    pageCount: stored.pdfPageCount,
    stage: "first-page-ready",
  });
  const document = await context.documentReady;
  if (stored.pdfPageCount !== document.numPages) {
    await repairStoredDocument(true);
    return;
  }
  await renderPdfPage(context, 1, request.scale);
  for (let startPage = 2; startPage <= document.numPages; startPage += 12) {
    const pages = (await getReaderPdfPageBatch(
      request.documentId,
      startPage,
      Math.min(12, document.numPages - startPage + 1),
    )) as StoredPdfPage[];
    if (pages.length !== Math.min(12, document.numPages - startPage + 1)) {
      await repairStoredDocument(true);
      return;
    }
    for (const page of pages) {
      assertCurrent(context);
      post({
        type: "page",
        jobId: context.jobId,
        revision: context.revision,
        document: sessionDocument,
        page: { ...page, revision: request.revision },
        first: false,
      });
    }
    await yieldToMessages();
    await drainRenderQueue(context);
  }
  post({
    type: "complete",
    jobId: context.jobId,
    revision: context.revision,
    document: sessionDocument,
  });
}

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  if (request.type === "cancel") {
    if (isPdfCancellationForSession(active, request)) {
      const context = active;
      active = null;
      void disposeContext(context);
    }
    return;
  }
  if (request.type === "render") {
    if (
      !active ||
      !isCurrentPdfSession(active, request)
    ) {
      return;
    }
    renderQueue = coalescePdfRenderRequests(renderQueue, {
      ...request,
      sequence: renderSequence++,
    });
    void drainRenderQueue(active).catch((error) => {
      if (!active) return;
      post({
        type: "error",
        jobId: active.jobId,
        revision: active.revision,
        message:
          error instanceof Error
            ? error.message
            : "The PDF page could not be rendered.",
      });
    });
    return;
  }
  if (request.type === "import") {
    void processSource(request, request.source, { title: request.title });
    return;
  }
  void openStoredPdf(request).catch((error) => {
    void getReaderDocument(request.documentId)
      .catch(() => null)
      .then((survivingDocument) => {
        const outcome = resolvePdfTerminalOutcome({
          cleanup: null,
          cleanupConfirmed: false,
          pageOnePersisted: false,
          survivingDocument,
          legacyExpected:
            survivingDocument?.kind === "pdf" &&
            survivingDocument.pdfStorageVersion !==
              PDF_DOCUMENT_STORAGE_VERSION,
        }) as Extract<PdfWorkerMessage, { type: "error" }>["outcome"];
        post({
          type: "error",
          jobId: request.jobId,
          revision: request.revision,
          message:
            error instanceof Error
              ? error.message
              : "This PDF could not be opened.",
          outcome,
        });
      });
  });
});
