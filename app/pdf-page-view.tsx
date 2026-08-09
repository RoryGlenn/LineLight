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
import { createPdfPageStore } from "./pdf-page-store.mjs";
import { mergePdfHighlightLineRects } from "./pdf-text-model.mjs";
import {
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
    options?: { visible?: boolean; distance?: number },
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
  onRenderError: (message: string) => void,
) {
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
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
        if (!cancelled) setDocumentProxy(document);
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
      setDocumentProxy(null);
      void loadingTask?.destroy();
    };
  }, [enabled, onRenderError, source]);
  return documentProxy;
}

const PdfRenderedPage = memo(function PdfRenderedPage({
  bitmap,
  fallbackDocument,
  pageRecord,
  tokenSentences,
  tokenParagraphs,
  registerHighlight,
  registerWord,
  requestRender,
  pinBitmap,
  onSelectWord,
  onRenderError,
}: {
  bitmap?: PdfBitmap;
  fallbackDocument: PDFDocumentProxy | null;
  pageRecord: StoredPdfPage;
  tokenSentences: number[];
  tokenParagraphs: number[];
  registerHighlight: HighlightRegistration;
  registerWord: PdfPageViewProps["registerWord"];
  requestRender: PdfPageViewProps["requestRender"];
  pinBitmap: (pageNumber: number) => () => void;
  onSelectWord: PdfPageViewProps["onSelectWord"];
  onRenderError: PdfPageViewProps["onRenderError"];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestedRef = useRef("");
  const [isRendered, setIsRendered] = useState(false);

  useEffect(
    () => pinBitmap(pageRecord.pageNumber),
    [pageRecord.pageNumber, pinBitmap],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bitmap) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    context.drawImage(bitmap.bitmap, 0, 0);
    canvas.dataset.pdfRenderSource = "worker-bitmap";
    requestedRef.current = "";
    setIsRendered(true);
    return () => {
      delete canvas.dataset.pdfRenderSource;
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [bitmap]);

  useEffect(() => {
    if (bitmap || fallbackDocument) return;
    const scale = Math.min(2, Math.max(1.25, window.devicePixelRatio || 1));
    const key = `${pageRecord.pageNumber}:${scale}`;
    if (requestedRef.current === key) return;
    requestedRef.current = key;
    requestRender(pageRecord.pageNumber, scale, { visible: true, distance: 0 });
  }, [bitmap, fallbackDocument, pageRecord.pageNumber, requestRender]);

  useEffect(() => {
    if (bitmap || !fallbackDocument) return;
    let cancelled = false;
    let pageProxy: PDFPageProxy | undefined;
    let renderTask: RenderTask | undefined;
    const canvas = canvasRef.current;
    const render = async () => {
      try {
        pageProxy = await fallbackDocument.getPage(pageRecord.pageNumber);
        if (cancelled || !canvas) return;
        const scale = Math.min(2, Math.max(1.25, window.devicePixelRatio || 1));
        const viewport = pageProxy.getViewport({ scale });
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        renderTask = pageProxy.render({ canvas, canvasContext: context, viewport });
        renderTask.onContinue = (continueRendering: () => void) => {
          requestAnimationFrame(continueRendering);
        };
        await renderTask.promise;
        if (!cancelled) {
          canvas.dataset.pdfRenderSource = "main-fallback";
          setIsRendered(true);
        }
      } catch (error) {
        if (
          !cancelled &&
          (!(error instanceof Error) ||
            error.name !== "RenderingCancelledException")
        ) {
          onRenderError(
            "The original PDF page could not be drawn. Focus view is still available.",
          );
        }
      }
    };
    void render();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      pageProxy?.cleanup();
      if (canvas) {
        delete canvas.dataset.pdfRenderSource;
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [bitmap, fallbackDocument, onRenderError, pageRecord.pageNumber]);

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
      {!isRendered && (
        <div className="pdf-page-loading" role="status">
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
) {
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 0 });
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
        setRange({
          start: visibleStart,
          end: Math.min(pages.length - 1, visibleEnd),
        });
      });
    };
    const observer = new ResizeObserver(() => {
      setWidth(list.clientWidth);
      update();
    });
    observer.observe(list);
    setWidth(list.clientWidth);
    root.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      root.removeEventListener("scroll", update);
    };
  }, [listRef, offsets, pages.length, storeVersion]);

  return {
    offsets,
    ranges: selectVirtualizedRanges(
      range.start,
      range.end,
      pages.length,
      activePageIndex,
      PDF_RANGE_OVERSCAN,
    ) as Array<{ start: number; end: number }>,
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
  const pageWordStarts = summaries.map((page) => page.wordStart);
  const activePageIndex = findPageIndexForWord(pageWordStarts, activeWord);
  const range = usePdfRange(
    summaries,
    activePageIndex,
    listRef,
    storeVersion,
  );
  const rangeRows: Array<
    | { kind: "spacer"; height: number; key: string }
    | { kind: "page"; page: StoredPdfPage; key: string }
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
        key: `spacer-${rangeCursor}-${mountedRange.start}`,
      });
    }
    for (const page of store.getPageRange(
      mountedRange.start,
      mountedRange.end,
    ) as StoredPdfPage[]) {
      rangeRows.push({ kind: "page", page, key: `page-${page.pageNumber}` });
    }
    rangeCursor = mountedRange.end + 1;
  }
  const trailingHeight =
    (range.offsets.at(-1) ?? 0) - (range.offsets[rangeCursor] ?? 0);
  if (trailingHeight > 0) {
    rangeRows.push({
      kind: "spacer",
      height: trailingHeight,
      key: `spacer-${rangeCursor}-end`,
    });
  }
  const fallbackDocument = useFallbackDocument(
    fallbackSource,
    renderFallback,
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
            data-pdf-page-index={row.page.pageNumber - 1}
            data-pdf-page-rendered="true"
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
                fallbackDocument={fallbackDocument}
                pageRecord={row.page}
                tokenSentences={tokenSentences}
                tokenParagraphs={tokenParagraphs}
                registerHighlight={registerHighlight}
                registerWord={registerWord}
                requestRender={requestRender}
                pinBitmap={store.pinBitmap}
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
