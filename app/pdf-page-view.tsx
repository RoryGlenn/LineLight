"use client";

import {
  memo,
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import pdfJsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";
import type { StoredPdfPage } from "./pdf-document-types";
import { createPdfFallbackScheduler } from "./pdf-fallback-scheduler.mjs";
import { createPdfPageStore } from "./pdf-page-store.mjs";
import {
  constrainPdfRasterScale,
  isPdfRasterSufficient,
  pdfPageRasterDirectiveKey,
  resolvePdfPageRasterDirective,
  resolvePdfRasterTarget,
} from "./pdf-raster-scale.mjs";
import { mergePdfHighlightLineRects } from "./pdf-text-model.mjs";
import {
  distanceFromViewport,
  findPageIndexForWord,
  selectVirtualizedRanges,
} from "./reader-virtualization.mjs";

export type PdfTextItemLayout = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  angle: number;
  wordStart: number;
  wordCount: number;
  wordIndices?: number[];
  textDivIndex?: number;
};

export type PdfPageLayout = {
  pageNumber: number;
  width: number;
  height: number;
  rotation?: number;
  rawDims?: {
    pageHeight: number;
    pageWidth: number;
    pageX: number;
    pageY: number;
  };
  items: PdfTextItemLayout[];
};

type PdfBitmap = {
  bitmap: ImageBitmap;
  height: number;
  scale: number;
  width: number;
};

type PdfRasterTarget = {
  capped: boolean;
  height: number;
  scale: number;
  width: number;
};

type PdfFallbackScheduler = ReturnType<typeof createPdfFallbackScheduler>;

type HighlightScope = "sentence" | "paragraph";
type HighlightKind = HighlightScope;

type PdfPageViewProps = {
  store: ReturnType<typeof createPdfPageStore>;
  fallbackSource?: Blob;
  renderFallback: boolean;
  activeWord: number;
  activeHighlightIndex: number;
  tokenSentences: number[];
  tokenParagraphs: number[];
  highlightScope: HighlightScope;
  registerWord: (index: number, element: HTMLSpanElement | null) => void;
  requestRender: (
    pageNumber: number,
    scale: number,
    options?: { enabled?: boolean; visible?: boolean; distance?: number },
  ) => void;
  onSelectWord: (index: number) => void;
  onRenderError: (message: string) => void;
};

type MeasuredWordRect = {
  key: string;
  wordIndex: number;
  text: string;
  angle: number;
  left: number;
  top: number;
  width: number;
  height: number;
  sourceDivIndex: number;
  sourceStart: number;
  sourceEnd: number;
  primary: boolean;
};

type MeasuredScopeRect = {
  key: string;
  scopeIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

type PdfTextGeometry = {
  words: MeasuredWordRect[];
  sentences: MeasuredScopeRect[];
  paragraphs: MeasuredScopeRect[];
};

type HighlightRegistration = (
  kind: HighlightKind,
  index: number,
  key: string,
  element: HTMLSpanElement | null,
) => void;

const WORD_PATTERN = /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;
const PDF_RANGE_OVERSCAN = 2;
const PDF_PAGE_GAP = 38;
const PDF_PAGE_CHROME = 22;
const PDF_DOM_MEASURE_BUDGET_MS = 8;
const PDF_FALLBACK_RETRY_DELAY_MS = 250;
const PDF_FALLBACK_MAX_ATTEMPTS = 2;

function isPdfRenderCancellation(error: unknown) {
  return (
    error instanceof Error &&
    ["AbortError", "RenderingCancelledException"].includes(error.name)
  );
}

function throwIfPdfRenderAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new DOMException("The PDF fallback render was cancelled.", "AbortError");
  }
}

function relativeStyle(rectangle: {
  left: number;
  top: number;
  width: number;
  height: number;
}) {
  return {
    left: `${rectangle.left}%`,
    top: `${rectangle.top}%`,
    width: `${rectangle.width}%`,
    height: `${rectangle.height}%`,
  } as CSSProperties;
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function measureTextGeometry(
  container: HTMLElement,
  textDivs: HTMLElement[],
  page: PdfPageLayout,
  tokenSentences: number[],
  tokenParagraphs: number[],
  cancelled: () => boolean,
): Promise<PdfTextGeometry> {
  const containerRect = container.getBoundingClientRect();
  if (containerRect.width <= 0 || containerRect.height <= 0) {
    return { words: [], sentences: [], paragraphs: [] };
  }

  const indexedItems = new Map(
    page.items
      .filter((item) => Number.isInteger(item.textDivIndex))
      .map((item) => [item.textDivIndex!, item]),
  );
  let legacyItemIndex = 0;
  let sliceStartedAt = performance.now();
  const yieldIfNeeded = async () => {
    if (performance.now() - sliceStartedAt < PDF_DOM_MEASURE_BUDGET_MS) return;
    await nextAnimationFrame();
    sliceStartedAt = performance.now();
  };
  const pixelWords: Array<
    Omit<MeasuredWordRect, "left" | "top" | "width" | "height"> & {
      left: number;
      top: number;
      width: number;
      height: number;
      sentenceIndex: number;
      paragraphIndex: number;
    }
  > = [];
  const pixelScopeSegments: Array<{
    sentenceIndex: number;
    paragraphIndex: number;
    left: number;
    top: number;
    width: number;
    height: number;
    angle: number;
  }> = [];
  const primaryWords = new Set<number>();

  for (let textDivIndex = 0; textDivIndex < textDivs.length; textDivIndex += 1) {
    if (cancelled()) return { words: [], sentences: [], paragraphs: [] };
    const textDiv = textDivs[textDivIndex];
    const text = textDiv.textContent ?? "";
    let layout = indexedItems.get(textDivIndex);
    if (!layout && Array.from(text.matchAll(WORD_PATTERN)).length) {
      while (legacyItemIndex < page.items.length) {
        const candidate = page.items[legacyItemIndex++];
        if (candidate.text === text) {
          layout = candidate;
          break;
        }
      }
    }
    if (!layout || !textDiv.firstChild) continue;

    const matches = Array.from(text.matchAll(WORD_PATTERN));
    const wordIndices =
      layout.wordIndices?.length === matches.length
        ? layout.wordIndices
        : matches.map((_, index) => layout!.wordStart + index);

    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      const match = matches[matchIndex];
      const wordIndex = wordIndices[matchIndex];
      if (!Number.isFinite(wordIndex)) continue;
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const sentenceIndex = tokenSentences[wordIndex] ?? -1;
      const paragraphIndex = tokenParagraphs[wordIndex] ?? -1;
      const range = document.createRange();
      range.setStart(textDiv.firstChild, start);
      range.setEnd(textDiv.firstChild, end);
      const rectangles = Array.from(range.getClientRects()).filter(
        (rectangle) => rectangle.width > 0 && rectangle.height > 0,
      );
      range.detach();

      rectangles.forEach((rectangle, rectangleIndex) => {
        const primary = !primaryWords.has(wordIndex);
        primaryWords.add(wordIndex);
        pixelWords.push({
          key: `${textDivIndex}:${start}:${rectangleIndex}`,
          wordIndex,
          text: match[0],
          angle: layout!.angle,
          left: rectangle.left - containerRect.left,
          top: rectangle.top - containerRect.top,
          width: rectangle.width,
          height: rectangle.height,
          sourceDivIndex: textDivIndex,
          sourceStart: start,
          sourceEnd: end,
          primary,
          sentenceIndex,
          paragraphIndex,
        });
      });

      const nextMatch = matches[matchIndex + 1];
      const nextWordIndex = wordIndices[matchIndex + 1];
      const nextSentenceIndex = Number.isFinite(nextWordIndex)
        ? tokenSentences[nextWordIndex]
        : undefined;
      let sentenceSegmentEnd = text.length;
      if (nextMatch) {
        const nextStart = nextMatch.index ?? end;
        if (nextSentenceIndex === sentenceIndex) {
          sentenceSegmentEnd = nextStart;
        } else {
          const trailing = text.slice(end, nextStart);
          const punctuation = trailing.match(/^[.!?…,:;\)\]}'”’"]*/u)?.[0] ?? "";
          sentenceSegmentEnd = end + punctuation.length;
        }
      }
      const sentenceRange = document.createRange();
      sentenceRange.setStart(textDiv.firstChild, matchIndex === 0 ? 0 : start);
      sentenceRange.setEnd(textDiv.firstChild, sentenceSegmentEnd);
      for (const rectangle of sentenceRange.getClientRects()) {
        if (rectangle.width <= 0 || rectangle.height <= 0) continue;
        pixelScopeSegments.push({
          sentenceIndex,
          paragraphIndex,
          left: rectangle.left - containerRect.left,
          top: rectangle.top - containerRect.top,
          width: rectangle.width,
          height: rectangle.height,
          angle: layout.angle,
        });
      }
      sentenceRange.detach();
      await yieldIfNeeded();
    }
  }

  const words = pixelWords.map((word) => ({
    key: word.key,
    wordIndex: word.wordIndex,
    text: word.text,
    angle: word.angle,
    left: (word.left / containerRect.width) * 100,
    top: (word.top / containerRect.height) * 100,
    width: (word.width / containerRect.width) * 100,
    height: (word.height / containerRect.height) * 100,
    sourceDivIndex: word.sourceDivIndex,
    sourceStart: word.sourceStart,
    sourceEnd: word.sourceEnd,
    primary: word.primary,
  }));
  const buildScopeRects = (
    key: "sentenceIndex" | "paragraphIndex",
  ): MeasuredScopeRect[] =>
    mergePdfHighlightLineRects(
      pixelScopeSegments.map((rectangle) => ({
        angle: rectangle.angle,
        height: rectangle.height,
        left: rectangle.left,
        scopeIndex: rectangle[key],
        top: rectangle.top,
        width: rectangle.width,
      })),
    ).map((line, index) => ({
      key: `${line.scopeIndex}:${index}:${line.left.toFixed(2)}:${line.top.toFixed(2)}`,
      scopeIndex: line.scopeIndex,
      left: (line.left / containerRect.width) * 100,
      top: (line.top / containerRect.height) * 100,
      width: (line.width / containerRect.width) * 100,
      height: (line.height / containerRect.height) * 100,
    }));

  return {
    words,
    sentences: buildScopeRects("sentenceIndex"),
    paragraphs: buildScopeRects("paragraphIndex"),
  };
}

function PdfMeasuredTextLayer({
  pageRecord,
  tokenSentences,
  tokenParagraphs,
  registerHighlight,
  registerWord,
  onSelectWord,
  onRenderError,
}: {
  pageRecord: StoredPdfPage;
  tokenSentences: number[];
  tokenParagraphs: number[];
  registerHighlight: HighlightRegistration;
  registerWord: PdfPageViewProps["registerWord"];
  onSelectWord: PdfPageViewProps["onSelectWord"];
  onRenderError: PdfPageViewProps["onRenderError"];
}) {
  const textLayerRef = useRef<HTMLDivElement>(null);
  const measurementGenerationRef = useRef(0);
  const [geometry, setGeometry] = useState<PdfTextGeometry>({
    words: [],
    sentences: [],
    paragraphs: [],
  });

  useEffect(() => {
    let cancelled = false;
    let textLayer:
      | { cancel(): void; render(): Promise<unknown>; textDivs: HTMLElement[] }
      | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let animationFrame = 0;
    const container = textLayerRef.current;
    const page = pageRecord.layout;

    const renderText = async () => {
      try {
        if (!container) return;
        const pdfjs = await import("pdfjs-dist");
        if (cancelled) return;
        const rawDims = page.rawDims ?? {
          pageHeight: page.height,
          pageWidth: page.width,
          pageX: 0,
          pageY: 0,
        };
        const viewport = {
          rawDims,
          rotation: page.rotation ?? 0,
          scale: 1,
        };
        const updateScale = () => {
          const parentWidth = container.parentElement?.clientWidth ?? 0;
          const scale = parentWidth > 0 ? parentWidth / page.width : 1;
          container.style.setProperty("--total-scale-factor", String(scale));
        };
        updateScale();
        textLayer = new pdfjs.TextLayer({
          textContentSource: pageRecord.textContent as never,
          container,
          viewport: viewport as never,
        });
        await textLayer.render();
        textLayer.textDivs.forEach((textDiv, textDivIndex) => {
          textDiv.dataset.pdfTextDiv = String(textDivIndex);
        });
        await (document.fonts?.ready ?? Promise.resolve());
        if (cancelled) return;

        const measure = () => {
          const generation = ++measurementGenerationRef.current;
          cancelAnimationFrame(animationFrame);
          animationFrame = requestAnimationFrame(() => {
            updateScale();
            animationFrame = requestAnimationFrame(() => {
              if (!cancelled && textLayer) {
                void measureTextGeometry(
                  container,
                  textLayer.textDivs,
                  page,
                  tokenSentences,
                  tokenParagraphs,
                  () =>
                    cancelled ||
                    measurementGenerationRef.current !== generation,
                ).then((nextGeometry) => {
                  if (
                    !cancelled &&
                    measurementGenerationRef.current === generation
                  ) {
                    setGeometry(nextGeometry);
                  }
                });
              }
            });
          });
        };
        measure();
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(measure);
          if (container.parentElement) resizeObserver.observe(container.parentElement);
        }
      } catch (error) {
        if (
          !cancelled &&
          (!(error instanceof Error) || error.name !== "AbortException")
        ) {
          onRenderError(
            "The PDF text layer could not be measured. Focus view is still available.",
          );
        }
      }
    };

    void renderText();
    return () => {
      cancelled = true;
      measurementGenerationRef.current += 1;
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      textLayer?.cancel();
      container?.replaceChildren();
    };
  }, [onRenderError, pageRecord, tokenParagraphs, tokenSentences]);

  return (
    <div className="pdf-text-layer">
      <div className="pdf-text-content" ref={textLayerRef} aria-hidden="true" />
      <div className="pdf-highlight-layer">
        {geometry.paragraphs.map((rectangle) => (
          <span
            className="pdf-paragraph-overlay"
            data-pdf-paragraph={rectangle.scopeIndex}
            key={rectangle.key}
            ref={(element) =>
              registerHighlight(
                "paragraph",
                rectangle.scopeIndex,
                rectangle.key,
                element,
              )
            }
            style={relativeStyle(rectangle)}
            aria-hidden="true"
          />
        ))}
        {geometry.sentences.map((rectangle) => (
          <span
            className="pdf-sentence-overlay"
            data-pdf-sentence={rectangle.scopeIndex}
            key={rectangle.key}
            ref={(element) =>
              registerHighlight(
                "sentence",
                rectangle.scopeIndex,
                rectangle.key,
                element,
              )
            }
            style={relativeStyle(rectangle)}
            aria-hidden="true"
          />
        ))}
        {geometry.words.map((rectangle) => (
          <span
            className="pdf-word-overlay"
            data-pdf-word={rectangle.wordIndex}
            data-pdf-text-div={rectangle.sourceDivIndex}
            data-pdf-text-start={rectangle.sourceStart}
            data-pdf-text-end={rectangle.sourceEnd}
            key={rectangle.key}
            ref={(element) => {
              if (rectangle.primary) registerWord(rectangle.wordIndex, element);
            }}
            style={relativeStyle(rectangle)}
            onClick={() => onSelectWord(rectangle.wordIndex)}
            aria-label={rectangle.text}
            aria-hidden="true"
          />
        ))}
      </div>
    </div>
  );
}

function useFallbackDocument(
  source: Blob | undefined,
  enabled: boolean,
  documentKey: string,
  onRenderError: (message: string) => void,
) {
  const [loaded, setLoaded] = useState<{
    documentKey: string;
    document: PDFDocumentProxy;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !source) return;
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    const load = async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfJsWorkerUrl;
        const bytes = new Uint8Array(await source.arrayBuffer());
        if (cancelled) return;
        loadingTask = pdfjs.getDocument({ data: bytes });
        const document = await loadingTask.promise;
        if (!cancelled) setLoaded({ documentKey, document });
      } catch {
        if (!cancelled) {
          onRenderError(
            "The original PDF pages could not be opened. Focus view is still available.",
          );
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [documentKey, enabled, onRenderError, source]);
  return enabled && source && loaded?.documentKey === documentKey
    ? loaded.document
    : null;
}

function usePdfRasterTarget(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  page: PdfPageLayout,
) {
  const [target, setTarget] = useState<PdfRasterTarget | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let resolutionQuery: MediaQueryList | undefined;
    const visualViewport = window.visualViewport;
    const refresh = () => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const next = resolvePdfRasterTarget({
        pageWidth: page.width,
        pageHeight: page.height,
        cssWidth: bounds.width,
        cssHeight: bounds.height,
        devicePixelRatio: window.devicePixelRatio || 1,
        visualViewportScale: visualViewport?.scale ?? 1,
      }) as PdfRasterTarget;
      setTarget((current) =>
        current &&
        current.capped === next.capped &&
        current.height === next.height &&
        current.scale === next.scale &&
        current.width === next.width
          ? current
          : next,
      );
    };
    const bindResolutionQuery = () => {
      resolutionQuery?.removeEventListener("change", handleResolutionChange);
      resolutionQuery = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      );
      resolutionQuery.addEventListener("change", handleResolutionChange);
    };
    function handleResolutionChange() {
      bindResolutionQuery();
      refresh();
    }
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(refresh);
    resizeObserver?.observe(canvas);
    window.addEventListener("resize", refresh);
    visualViewport?.addEventListener("resize", refresh);
    bindResolutionQuery();
    refresh();
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", refresh);
      visualViewport?.removeEventListener("resize", refresh);
      resolutionQuery?.removeEventListener("change", handleResolutionChange);
    };
  }, [canvasRef, page.height, page.width]);

  return target;
}

const PdfRenderedPage = memo(function PdfRenderedPage({
  bitmap,
  distance,
  fallbackDocument,
  fallbackScheduler,
  pageRecord,
  tokenSentences,
  tokenParagraphs,
  registerHighlight,
  registerWord,
  requestRender,
  pinBitmap,
  visible,
  workerFallbackActive,
  onSelectWord,
  onRenderError,
}: {
  bitmap?: PdfBitmap;
  distance: number;
  fallbackDocument: PDFDocumentProxy | null;
  fallbackScheduler: PdfFallbackScheduler;
  pageRecord: StoredPdfPage;
  tokenSentences: number[];
  tokenParagraphs: number[];
  registerHighlight: HighlightRegistration;
  registerWord: PdfPageViewProps["registerWord"];
  requestRender: PdfPageViewProps["requestRender"];
  pinBitmap: (pageNumber: number) => () => void;
  visible: boolean;
  workerFallbackActive: boolean;
  onSelectWord: PdfPageViewProps["onSelectWord"];
  onRenderError: PdfPageViewProps["onRenderError"];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loadingRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  const requestRenderRef = useRef(requestRender);
  const publishedDirectiveRef = useRef("");
  const requestedScaleRef = useRef(0);
  const fallbackRenderedRef = useRef({
    height: 0,
    targetKey: "",
    width: 0,
  });
  const fallbackAttemptRef = useRef({ attempts: 0, targetKey: "" });
  const [fallbackRetry, setFallbackRetry] = useState(0);
  const rasterTarget = usePdfRasterTarget(canvasRef, pageRecord.layout);
  const bitmapSatisfiesRasterTarget = Boolean(
    rasterTarget && isPdfRasterSufficient(bitmap, rasterTarget),
  );
  const targetKey = rasterTarget
    ? `${rasterTarget.width}x${rasterTarget.height}@${rasterTarget.scale}`
    : "";

  useLayoutEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useLayoutEffect(() => {
    requestRenderRef.current = requestRender;
  }, [requestRender]);

  useEffect(() => {
    if (!visible) return;
    return pinBitmap(pageRecord.pageNumber);
  }, [pageRecord.pageNumber, pinBitmap, visible]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!visible) {
      canvas.width = 0;
      canvas.height = 0;
      delete canvas.dataset.pdfRenderSource;
      delete canvas.dataset.pdfRasterScale;
      fallbackRenderedRef.current = { height: 0, targetKey: "", width: 0 };
      return;
    }
    if (!bitmap) return;
    if (
      canvas.dataset.pdfRenderSource === "main-fallback" &&
      canvas.width >= bitmap.width &&
      canvas.height >= bitmap.height
    ) {
      return;
    }
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    context.drawImage(bitmap.bitmap, 0, 0);
    canvas.dataset.pdfRenderSource = "worker-bitmap";
    canvas.dataset.pdfRasterScale = String(bitmap.scale);
    if (loadingRef.current) loadingRef.current.style.display = "none";
  }, [bitmap, visible]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!visible || !rasterTarget) {
      delete canvas.dataset.pdfRasterTargetScale;
      delete canvas.dataset.pdfRasterTargetWidth;
      delete canvas.dataset.pdfRasterTargetHeight;
      delete canvas.dataset.pdfRasterCapped;
      return;
    }
    canvas.dataset.pdfRasterTargetScale = String(rasterTarget.scale);
    canvas.dataset.pdfRasterTargetWidth = String(rasterTarget.width);
    canvas.dataset.pdfRasterTargetHeight = String(rasterTarget.height);
    canvas.dataset.pdfRasterCapped = String(rasterTarget.capped);
  }, [rasterTarget, visible]);

  useEffect(
    () => () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      delete canvas.dataset.pdfRenderSource;
      delete canvas.dataset.pdfRasterScale;
      delete canvas.dataset.pdfRasterTargetScale;
      delete canvas.dataset.pdfRasterTargetWidth;
      delete canvas.dataset.pdfRasterTargetHeight;
      delete canvas.dataset.pdfRasterCapped;
      canvas.width = 0;
      canvas.height = 0;
    },
    [],
  );

  useEffect(
    () => () => {
      requestRenderRef.current(pageRecord.pageNumber, 0, {
        enabled: false,
        visible: false,
        distance: Number.MAX_SAFE_INTEGER,
      });
    },
    [pageRecord.pageNumber],
  );

  useEffect(() => {
    if (bitmap && Number(bitmap.scale) >= requestedScaleRef.current) {
      requestedScaleRef.current = 0;
    }
    const directive = resolvePdfPageRasterDirective({
      bitmap,
      visible,
      distance,
      fallbackActive: workerFallbackActive,
      pageWidth: pageRecord.layout.width,
      pageHeight: pageRecord.layout.height,
      target: rasterTarget,
    });
    if (!directive) return;
    const directiveKey = pdfPageRasterDirectiveKey(directive);
    if (publishedDirectiveRef.current === directiveKey) return;
    publishedDirectiveRef.current = directiveKey;
    requestedScaleRef.current = directive.enabled ? directive.scale : 0;
    requestRender(pageRecord.pageNumber, directive.scale, {
      enabled: directive.enabled,
      visible: directive.visible,
      distance: directive.distance,
    });
  }, [
    bitmap,
    distance,
    pageRecord.layout.height,
    pageRecord.layout.width,
    pageRecord.pageNumber,
    rasterTarget,
    requestRender,
    visible,
    workerFallbackActive,
  ]);

  useEffect(() => {
    if (!visible) {
      fallbackAttemptRef.current = { attempts: 0, targetKey: "" };
      return;
    }
    if (!rasterTarget || !fallbackDocument) return;
    if (
      bitmapSatisfiesRasterTarget ||
      fallbackRenderedRef.current.targetKey === targetKey
    ) {
      return;
    }
    if (fallbackAttemptRef.current.targetKey !== targetKey) {
      fallbackAttemptRef.current = { attempts: 0, targetKey };
    }
    const attempt = fallbackAttemptRef.current.attempts + 1;
    fallbackAttemptRef.current = { attempts: attempt, targetKey };

    let cancelled = false;
    let retryTimeout: number | undefined;
    const visibleCanvas = canvasRef.current;
    if (!visibleCanvas) return;
    const ticket = fallbackScheduler.schedule({
      key: `${pageRecord.documentId}:${pageRecord.revision}:${pageRecord.pageNumber}`,
      visible: true,
      distance,
      async run(signal: AbortSignal) {
        let pageProxy: PDFPageProxy | undefined;
        let renderTask: RenderTask | undefined;
        let stagingCanvas: HTMLCanvasElement | undefined;
        const cancelRender = () => renderTask?.cancel();
        signal.addEventListener("abort", cancelRender);
        try {
          throwIfPdfRenderAborted(signal);
          pageProxy = await fallbackDocument.getPage(pageRecord.pageNumber);
          throwIfPdfRenderAborted(signal);
          const baseViewport = pageProxy.getViewport({ scale: 1 });
          const safeTarget = constrainPdfRasterScale({
            pageWidth: baseViewport.width,
            pageHeight: baseViewport.height,
            scale: rasterTarget.scale,
          });
          const viewport = pageProxy.getViewport({ scale: safeTarget.scale });
          stagingCanvas = document.createElement("canvas");
          stagingCanvas.width = Math.ceil(viewport.width);
          stagingCanvas.height = Math.ceil(viewport.height);
          const context = stagingCanvas.getContext("2d", { alpha: false });
          if (!context) {
            throw new Error("The PDF fallback canvas could not be created.");
          }
          renderTask = pageProxy.render({
            canvas: stagingCanvas,
            canvasContext: context,
            viewport,
          });
          renderTask.onContinue = (continueRendering: () => void) => {
            if (signal.aborted) renderTask?.cancel();
            else requestAnimationFrame(continueRendering);
          };
          await renderTask.promise;
          throwIfPdfRenderAborted(signal);
          return { canvas: stagingCanvas, scale: safeTarget.scale };
        } catch (error) {
          if (stagingCanvas) {
            stagingCanvas.width = 0;
            stagingCanvas.height = 0;
          }
          throw error;
        } finally {
          signal.removeEventListener("abort", cancelRender);
          pageProxy?.cleanup();
        }
      },
    });

    const handleFallbackFailure = (error: unknown) => {
      if (cancelled || isPdfRenderCancellation(error)) return;
      if (attempt < PDF_FALLBACK_MAX_ATTEMPTS) {
        retryTimeout = window.setTimeout(
          () => setFallbackRetry((value) => value + 1),
          PDF_FALLBACK_RETRY_DELAY_MS,
        );
        return;
      }
      onRenderError(
        "The original PDF page could not be drawn after a retry. Focus view is still available.",
      );
    };

    void ticket.promise.then(
      ({ canvas: stagingCanvas, scale }: { canvas: HTMLCanvasElement; scale: number }) => {
        try {
          if (cancelled || !visibleRef.current) return;
          const visibleContext = visibleCanvas.getContext("2d", { alpha: false });
          if (!visibleContext) {
            throw new Error("The visible PDF canvas could not be created.");
          }
          visibleCanvas.width = stagingCanvas.width;
          visibleCanvas.height = stagingCanvas.height;
          visibleContext.drawImage(stagingCanvas, 0, 0);
          fallbackRenderedRef.current = {
            height: stagingCanvas.height,
            targetKey,
            width: stagingCanvas.width,
          };
          fallbackAttemptRef.current = { attempts: 0, targetKey };
          visibleCanvas.dataset.pdfRenderSource = "main-fallback";
          visibleCanvas.dataset.pdfRasterScale = String(scale);
          if (loadingRef.current) loadingRef.current.style.display = "none";
        } catch (error) {
          handleFallbackFailure(error);
        } finally {
          stagingCanvas.width = 0;
          stagingCanvas.height = 0;
        }
      },
      handleFallbackFailure,
    );

    return () => {
      cancelled = true;
      if (retryTimeout !== undefined) window.clearTimeout(retryTimeout);
      ticket.cancel();
    };
  }, [
    bitmapSatisfiesRasterTarget,
    distance,
    fallbackDocument,
    fallbackRetry,
    fallbackScheduler,
    onRenderError,
    pageRecord.documentId,
    pageRecord.pageNumber,
    pageRecord.revision,
    rasterTarget,
    targetKey,
    visible,
  ]);

  return (
    <>
      <canvas ref={canvasRef} aria-hidden="true" />
      <PdfMeasuredTextLayer
        pageRecord={pageRecord}
        tokenSentences={tokenSentences}
        tokenParagraphs={tokenParagraphs}
        registerHighlight={registerHighlight}
        registerWord={registerWord}
        onSelectWord={onSelectWord}
        onRenderError={onRenderError}
      />
      {visible && (
        <div className="pdf-page-loading" ref={loadingRef} role="status">
          <span aria-hidden="true">•••</span>
          Drawing page {pageRecord.pageNumber}
        </div>
      )}
    </>
  );
});

type PdfPageSummary = {
  pageNumber: number;
  width: number;
  height: number;
  wordStart: number;
};

function calculateOffsets(pages: PdfPageSummary[], width: number) {
  const offsets = [0];
  for (const page of pages) {
    const height = width > 0
      ? (width * page.height) / page.width
      : page.height;
    offsets.push(offsets.at(-1)! + height + PDF_PAGE_CHROME + PDF_PAGE_GAP);
  }
  return offsets;
}

function findOffsetIndex(offsets: number[], target: number) {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= target) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function usePdfRange(
  pages: PdfPageSummary[],
  activePageIndex: number,
  listRef: React.RefObject<HTMLDivElement | null>,
  storeVersion: number,
  documentKey: string,
) {
  const [measuredWidth, setMeasuredWidth] = useState({
    documentKey,
    width: 0,
  });
  const [measuredRange, setMeasuredRange] = useState({
    documentKey,
    start: 0,
    end: 0,
  });
  const width =
    measuredWidth.documentKey === documentKey ? measuredWidth.width : 0;
  const range =
    measuredRange.documentKey === documentKey
      ? measuredRange
      : { documentKey, start: 0, end: 0 };
  const offsets = useMemo(
    () => {
      void storeVersion;
      return calculateOffsets(pages, width);
    },
    [pages, storeVersion, width],
  );

  useEffect(() => {
    const list = listRef.current;
    const root = list?.closest<HTMLElement>(".reader-scroll");
    if (!list || !root) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const listTop =
          list.getBoundingClientRect().top - root.getBoundingClientRect().top +
          root.scrollTop;
        const startOffset = Math.max(0, root.scrollTop - listTop);
        const endOffset = startOffset + root.clientHeight;
        const visibleStart = findOffsetIndex(offsets, startOffset);
        const visibleEnd = findOffsetIndex(offsets, endOffset);
        setMeasuredRange({
          documentKey,
          start: visibleStart,
          end: Math.min(pages.length - 1, visibleEnd),
        });
      });
    };
    const observer = new ResizeObserver(() => {
      setMeasuredWidth({ documentKey, width: list.clientWidth });
      update();
    });
    observer.observe(list);
    setMeasuredWidth({ documentKey, width: list.clientWidth });
    root.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      root.removeEventListener("scroll", update);
    };
  }, [documentKey, listRef, offsets, pages.length, storeVersion]);

  return {
    offsets,
    ranges: selectVirtualizedRanges(
      range.start,
      range.end,
      pages.length,
      activePageIndex,
      PDF_RANGE_OVERSCAN,
    ) as Array<{ start: number; end: number }>,
    viewportStart: range.start,
    viewportEnd: range.end,
  };
}

function toggleRegisteredElements(
  elements: Map<number, Map<string, HTMLSpanElement>>,
  index: number,
  active: boolean,
) {
  for (const element of elements.get(index)?.values() ?? []) {
    element.classList.toggle("scope-active", active);
  }
}

export function PdfPageView({
  store,
  fallbackSource,
  renderFallback,
  activeWord,
  activeHighlightIndex,
  tokenSentences,
  tokenParagraphs,
  highlightScope,
  registerWord,
  requestRender,
  onSelectWord,
  onRenderError,
}: PdfPageViewProps) {
  const highlightElements = useRef<
    Record<HighlightKind, Map<number, Map<string, HTMLSpanElement>>>
  >({ sentence: new Map(), paragraph: new Map() });
  const activeHighlightIndexRef = useRef(activeHighlightIndex);
  const highlightScopeRef = useRef(highlightScope);
  const previousHighlightRef = useRef({
    index: activeHighlightIndex,
    scope: highlightScope,
  });
  const listRef = useRef<HTMLDivElement>(null);
  const storeVersion = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const summaries = store.getSummaries() as PdfPageSummary[];
  const firstPage = summaries[0]
    ? (store.getPage(summaries[0].pageNumber) as StoredPdfPage | undefined)
    : undefined;
  const documentKey = firstPage
    ? `${firstPage.documentId}:${firstPage.revision}`
    : "pdf-empty";
  const fallbackScheduler = useMemo(() => {
    void documentKey;
    return createPdfFallbackScheduler();
  }, [documentKey]);
  useEffect(
    () => () => fallbackScheduler.dispose(),
    [fallbackScheduler],
  );
  const pageWordStarts = summaries.map((page) => page.wordStart);
  const activePageIndex = findPageIndexForWord(pageWordStarts, activeWord);
  const range = usePdfRange(
    summaries,
    activePageIndex,
    listRef,
    storeVersion,
    documentKey,
  );
  const rangeRows: Array<
    | { kind: "spacer"; height: number; key: string }
    | {
        kind: "page";
        page: StoredPdfPage;
        pageIndex: number;
        visible: boolean;
        distance: number;
        key: string;
      }
  > = [];
  let rangeCursor = 0;
  for (const mountedRange of range.ranges) {
    const spacerHeight =
      (range.offsets[mountedRange.start] ?? 0) -
      (range.offsets[rangeCursor] ?? 0);
    if (spacerHeight > 0) {
      rangeRows.push({
        kind: "spacer",
        height: spacerHeight,
        key: `${documentKey}:spacer-${rangeCursor}-${mountedRange.start}`,
      });
    }
    for (
      let pageIndex = mountedRange.start;
      pageIndex <= mountedRange.end;
      pageIndex += 1
    ) {
      const summary = summaries[pageIndex];
      const page = summary
        ? (store.getPage(summary.pageNumber) as StoredPdfPage | undefined)
        : undefined;
      if (!page) continue;
      const distance = distanceFromViewport(
        pageIndex,
        range.viewportStart,
        range.viewportEnd,
      );
      rangeRows.push({
        kind: "page",
        page,
        pageIndex,
        visible: distance === 0,
        distance,
        key: `${documentKey}:page-${page.pageNumber}`,
      });
    }
    rangeCursor = mountedRange.end + 1;
  }
  const trailingHeight =
    (range.offsets.at(-1) ?? 0) - (range.offsets[rangeCursor] ?? 0);
  if (trailingHeight > 0) {
    rangeRows.push({
      kind: "spacer",
      height: trailingHeight,
      key: `${documentKey}:spacer-${rangeCursor}-end`,
    });
  }
  const fallbackDocument = useFallbackDocument(
    fallbackSource,
    renderFallback,
    documentKey,
    onRenderError,
  );

  const registerHighlight = useCallback<HighlightRegistration>(
    (kind, index, key, element) => {
      const registry = highlightElements.current[kind];
      let entries = registry.get(index);
      if (element) {
        if (!entries) {
          entries = new Map();
          registry.set(index, entries);
        }
        entries.set(key, element);
        element.classList.toggle(
          "scope-active",
          kind === highlightScopeRef.current &&
            index === activeHighlightIndexRef.current,
        );
      } else if (entries) {
        entries.delete(key);
        if (!entries.size) registry.delete(index);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    activeHighlightIndexRef.current = activeHighlightIndex;
    highlightScopeRef.current = highlightScope;
    const previous = previousHighlightRef.current;
    if (
      previous.scope !== highlightScope ||
      previous.index !== activeHighlightIndex
    ) {
      toggleRegisteredElements(
        highlightElements.current[previous.scope],
        previous.index,
        false,
      );
    }
    toggleRegisteredElements(
      highlightElements.current[highlightScope],
      activeHighlightIndex,
      true,
    );
    previousHighlightRef.current = {
      index: activeHighlightIndex,
      scope: highlightScope,
    };
  }, [activeHighlightIndex, highlightScope]);

  return (
    <article
      className={`pdf-page-view highlight-${highlightScope}`}
      aria-label="Original PDF pages"
      data-pdf-render-fallback={renderFallback ? "true" : "false"}
    >
      <header className="pdf-view-intro">
        <p>Original page view</p>
        <h2>Read in the document’s own layout</h2>
        <span>Narration and highlighting stay synchronized across every page.</span>
      </header>

      <div
        className="pdf-pages"
        data-pdf-range={range.ranges
          .map((mountedRange) => `${mountedRange.start}:${mountedRange.end}`)
          .join(",")}
        ref={listRef}
      >
        {rangeRows.map((row) =>
          row.kind === "spacer" ? (
            <div
              aria-hidden="true"
              className="pdf-range-spacer"
              key={row.key}
              style={{ height: row.height }}
            />
          ) : (
          <section
            className="pdf-page-block"
            id={`pdf-page-${row.page.pageNumber}`}
            data-pdf-page-index={row.pageIndex}
            data-pdf-page-rendered="true"
            data-pdf-page-visible={row.visible ? "true" : "false"}
            data-pdf-page-distance={row.distance}
            key={row.key}
          >
            <div
              className="pdf-page"
              style={{
                aspectRatio: `${row.page.layout.width} / ${row.page.layout.height}`,
              }}
            >
              <PdfRenderedPage
                bitmap={store.getBitmap(row.page.pageNumber) as
                  | PdfBitmap
                  | undefined}
                distance={row.distance}
                fallbackDocument={fallbackDocument}
                fallbackScheduler={fallbackScheduler}
                pageRecord={row.page}
                tokenSentences={tokenSentences}
                tokenParagraphs={tokenParagraphs}
                registerHighlight={registerHighlight}
                registerWord={registerWord}
                requestRender={requestRender}
                pinBitmap={store.pinBitmap}
                visible={row.visible}
                workerFallbackActive={renderFallback}
                onSelectWord={onSelectWord}
                onRenderError={onRenderError}
              />
            </div>
            <p className="pdf-page-number">Page {row.page.pageNumber}</p>
          </section>
          ),
        )}
      </div>
    </article>
  );
}
