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
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";
import { derivePdfPageWordStarts } from "./pdf-outline.mjs";
import { mergePdfHighlightLineRects } from "./pdf-text-model.mjs";
import {
  createPdfPageRenderStore,
  findPageIndexForWord,
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
  items: PdfTextItemLayout[];
};

type HighlightScope = "sentence" | "paragraph";
type HighlightKind = HighlightScope;

type PdfPageViewProps = {
  data: Uint8Array;
  pages: PdfPageLayout[];
  activeWord: number;
  activeHighlightIndex: number;
  tokenSentences: number[];
  tokenParagraphs: number[];
  highlightScope: HighlightScope;
  registerWord: (index: number, element: HTMLSpanElement | null) => void;
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

type MeasuredSentenceRect = {
  key: string;
  sentenceIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

type MeasuredParagraphRect = {
  key: string;
  paragraphIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

type PdfTextGeometry = {
  words: MeasuredWordRect[];
  sentences: MeasuredSentenceRect[];
  paragraphs: MeasuredParagraphRect[];
};

type HighlightRegistration = (
  kind: HighlightKind,
  index: number,
  key: string,
  element: HTMLSpanElement | null,
) => void;

const WORD_PATTERN =
  /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;

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

function measureTextGeometry(
  container: HTMLElement,
  textDivs: HTMLElement[],
  page: PdfPageLayout,
  tokenSentences: number[],
  tokenParagraphs: number[],
): PdfTextGeometry {
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
  const pixelSentenceSegments: Array<{
    sentenceIndex: number;
    paragraphIndex: number;
    left: number;
    top: number;
    width: number;
    height: number;
    angle: number;
  }> = [];
  const primaryWords = new Set<number>();

  textDivs.forEach((textDiv, textDivIndex) => {
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
    if (!layout || !textDiv.firstChild) return;

    const matches = Array.from(text.matchAll(WORD_PATTERN));
    const wordIndices =
      layout.wordIndices?.length === matches.length
        ? layout.wordIndices
        : matches.map((_, index) => layout!.wordStart + index);

    matches.forEach((match, matchIndex) => {
      const wordIndex = wordIndices[matchIndex];
      if (!Number.isFinite(wordIndex)) return;
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const sentenceIndex = tokenSentences[wordIndex] ?? -1;
      const paragraphIndex = tokenParagraphs[wordIndex] ?? -1;
      const range = document.createRange();
      range.setStart(textDiv.firstChild!, start);
      range.setEnd(textDiv.firstChild!, end);
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
      sentenceRange.setStart(
        textDiv.firstChild!,
        matchIndex === 0 ? 0 : start,
      );
      sentenceRange.setEnd(textDiv.firstChild!, sentenceSegmentEnd);
      for (const rectangle of sentenceRange.getClientRects()) {
        if (rectangle.width <= 0 || rectangle.height <= 0) continue;
        pixelSentenceSegments.push({
          sentenceIndex,
          paragraphIndex,
          left: rectangle.left - containerRect.left,
          top: rectangle.top - containerRect.top,
          width: rectangle.width,
          height: rectangle.height,
          angle: layout!.angle,
        });
      }
      sentenceRange.detach();
    });
  });

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
  const sentenceLines = mergePdfHighlightLineRects(
    pixelSentenceSegments.map(({ sentenceIndex, ...rectangle }) => ({
      ...rectangle,
      scopeIndex: sentenceIndex,
    })),
  );
  const sentences = sentenceLines.map((line, index) => ({
    key: `${line.scopeIndex}:${index}:${line.left.toFixed(2)}:${line.top.toFixed(2)}`,
    sentenceIndex: line.scopeIndex,
    left: (line.left / containerRect.width) * 100,
    top: (line.top / containerRect.height) * 100,
    width: (line.width / containerRect.width) * 100,
    height: (line.height / containerRect.height) * 100,
  }));
  const paragraphLines = mergePdfHighlightLineRects(
    pixelSentenceSegments.map(({ paragraphIndex, ...rectangle }) => ({
      ...rectangle,
      scopeIndex: paragraphIndex,
    })),
  );
  const paragraphs = paragraphLines.map((line, index) => ({
    key: `${line.scopeIndex}:${index}:${line.left.toFixed(2)}:${line.top.toFixed(2)}`,
    paragraphIndex: line.scopeIndex,
    left: (line.left / containerRect.width) * 100,
    top: (line.top / containerRect.height) * 100,
    width: (line.width / containerRect.width) * 100,
    height: (line.height / containerRect.height) * 100,
  }));

  return { words, sentences, paragraphs };
}

function PdfMeasuredTextLayer({
  documentProxy,
  page,
  tokenSentences,
  tokenParagraphs,
  registerHighlight,
  registerWord,
  onSelectWord,
  onRenderError,
}: {
  documentProxy: PDFDocumentProxy | null;
  page: PdfPageLayout;
  tokenSentences: number[];
  tokenParagraphs: number[];
  registerHighlight: HighlightRegistration;
  registerWord: PdfPageViewProps["registerWord"];
  onSelectWord: PdfPageViewProps["onSelectWord"];
  onRenderError: PdfPageViewProps["onRenderError"];
}) {
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<PdfTextGeometry>({
    words: [],
    sentences: [],
    paragraphs: [],
  });

  useEffect(() => {
    if (!documentProxy) return;
    let cancelled = false;
    let pageProxy: PDFPageProxy | undefined;
    let textLayer: {
      cancel(): void;
      render(): Promise<unknown>;
      textDivs: HTMLElement[];
    } | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let animationFrame = 0;
    const container = textLayerRef.current;

    const renderText = async () => {
      try {
        if (!container) return;
        const pdfjs = await import("pdfjs-dist");
        pageProxy = await documentProxy.getPage(page.pageNumber);
        const [textContent, fontsReady] = await Promise.all([
          pageProxy.getTextContent(),
          document.fonts?.ready ?? Promise.resolve(),
        ]);
        if (cancelled) return;
        const viewport = pageProxy.getViewport({ scale: 1 });
        const updateScale = () => {
          const parentWidth = container.parentElement?.clientWidth ?? 0;
          const scale = parentWidth > 0 ? parentWidth / viewport.width : 1;
          container.style.setProperty("--total-scale-factor", String(scale));
        };
        updateScale();
        textLayer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container,
          viewport,
        });
        await textLayer.render();
        textLayer.textDivs.forEach((textDiv, textDivIndex) => {
          textDiv.dataset.pdfTextDiv = String(textDivIndex);
        });
        await fontsReady;
        if (cancelled) return;

        const measure = () => {
          cancelAnimationFrame(animationFrame);
          animationFrame = requestAnimationFrame(() => {
            updateScale();
            animationFrame = requestAnimationFrame(() => {
              if (!cancelled && textLayer) {
                setGeometry(
                  measureTextGeometry(
                    container,
                    textLayer.textDivs,
                    page,
                    tokenSentences,
                    tokenParagraphs,
                  ),
                );
              }
            });
          });
        };
        measure();
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(measure);
          if (container.parentElement) {
            resizeObserver.observe(container.parentElement);
          }
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
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      textLayer?.cancel();
      pageProxy?.cleanup();
    };
  }, [documentProxy, onRenderError, page, tokenParagraphs, tokenSentences]);

  return (
    <div className="pdf-text-layer">
      <div className="pdf-text-content" ref={textLayerRef} aria-hidden="true" />
      <div className="pdf-highlight-layer">
        {geometry.paragraphs.map((rectangle) => (
          <span
            className="pdf-paragraph-overlay"
            data-pdf-paragraph={rectangle.paragraphIndex}
            key={rectangle.key}
            ref={(element) =>
              registerHighlight(
                "paragraph",
                rectangle.paragraphIndex,
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
            data-pdf-sentence={rectangle.sentenceIndex}
            key={rectangle.key}
            ref={(element) =>
              registerHighlight(
                "sentence",
                rectangle.sentenceIndex,
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
              if (rectangle.primary) {
                registerWord(rectangle.wordIndex, element);
              }
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

const PdfRenderedPage = memo(function PdfRenderedPage({
  documentProxy,
  page,
  tokenSentences,
  tokenParagraphs,
  registerHighlight,
  registerWord,
  onSelectWord,
  onRenderError,
}: {
  documentProxy: PDFDocumentProxy | null;
  page: PdfPageLayout;
  tokenSentences: number[];
  tokenParagraphs: number[];
  registerHighlight: HighlightRegistration;
  registerWord: PdfPageViewProps["registerWord"];
  onSelectWord: PdfPageViewProps["onSelectWord"];
  onRenderError: PdfPageViewProps["onRenderError"];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isRendered, setIsRendered] = useState(false);

  useEffect(() => {
    if (!documentProxy) return;
    let cancelled = false;
    let pageProxy: PDFPageProxy | undefined;
    let renderTask: RenderTask | undefined;
    const canvas = canvasRef.current;

    const renderPage = async () => {
      try {
        pageProxy = await documentProxy.getPage(page.pageNumber);
        if (cancelled) return;
        const outputScale = Math.min(
          2,
          Math.max(1.25, window.devicePixelRatio || 1),
        );
        const viewport = pageProxy.getViewport({ scale: outputScale });
        const context = canvas?.getContext("2d", { alpha: false });
        if (!canvas || !context) return;

        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        renderTask = pageProxy.render({
          canvas,
          canvasContext: context,
          viewport,
        });
        await renderTask.promise;
        if (!cancelled) setIsRendered(true);
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

    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      pageProxy?.cleanup();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [documentProxy, onRenderError, page.pageNumber]);

  return (
    <>
      <canvas ref={canvasRef} aria-hidden="true" />
      <PdfMeasuredTextLayer
        documentProxy={documentProxy}
        page={page}
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
          Drawing page {page.pageNumber}
        </div>
      )}
    </>
  );
});

type PdfPageRenderStore = ReturnType<typeof createPdfPageRenderStore>;

const PdfPageShell = memo(function PdfPageShell({
  documentProxy,
  page,
  pageIndex,
  renderStore,
  tokenSentences,
  tokenParagraphs,
  registerHighlight,
  registerPageShell,
  registerWord,
  onSelectWord,
  onRenderError,
}: {
  documentProxy: PDFDocumentProxy | null;
  page: PdfPageLayout;
  pageIndex: number;
  renderStore: PdfPageRenderStore;
  tokenSentences: number[];
  tokenParagraphs: number[];
  registerHighlight: HighlightRegistration;
  registerPageShell: (pageIndex: number, element: HTMLElement | null) => void;
  registerWord: PdfPageViewProps["registerWord"];
  onSelectWord: PdfPageViewProps["onSelectWord"];
  onRenderError: PdfPageViewProps["onRenderError"];
}) {
  const subscribe = useCallback(
    (listener: () => void) => renderStore.subscribe(pageIndex, listener),
    [pageIndex, renderStore],
  );
  const getSnapshot = useCallback(
    () => renderStore.isPageRendered(pageIndex),
    [pageIndex, renderStore],
  );
  const shouldRender = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const shellRef = useRef<HTMLElement>(null);
  const setShellRef = useCallback(
    (element: HTMLElement | null) => {
      shellRef.current = element;
      registerPageShell(pageIndex, element);
    },
    [pageIndex, registerPageShell],
  );
  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return;
    const shell = shellRef.current;
    if (!shell) return;
    const previous = Number(shell.dataset.pdfShellRenderCount) || 0;
    shell.dataset.pdfShellRenderCount = String(previous + 1);
  });

  return (
    <section
      className="pdf-page-block"
      id={`pdf-page-${page.pageNumber}`}
      data-pdf-page-index={pageIndex}
      data-pdf-page-rendered={shouldRender ? "true" : "false"}
      ref={setShellRef}
    >
      <div
        className="pdf-page"
        style={{ aspectRatio: `${page.width} / ${page.height}` }}
      >
        {shouldRender ? (
          <PdfRenderedPage
            documentProxy={documentProxy}
            page={page}
            tokenSentences={tokenSentences}
            tokenParagraphs={tokenParagraphs}
            registerHighlight={registerHighlight}
            registerWord={registerWord}
            onSelectWord={onSelectWord}
            onRenderError={onRenderError}
          />
        ) : (
          <div className="pdf-page-placeholder" aria-hidden="true">
            <span>Page {page.pageNumber}</span>
          </div>
        )}
      </div>
      <p className="pdf-page-number">Page {page.pageNumber}</p>
    </section>
  );
});

const PdfPageShells = memo(function PdfPageShells({
  data,
  pages,
  renderStore,
  tokenSentences,
  tokenParagraphs,
  registerHighlight,
  registerWord,
  onSelectWord,
  onRenderError,
}: {
  data: Uint8Array;
  pages: PdfPageLayout[];
  renderStore: PdfPageRenderStore;
  tokenSentences: number[];
  tokenParagraphs: number[];
  registerHighlight: HighlightRegistration;
  registerWord: PdfPageViewProps["registerWord"];
  onSelectWord: PdfPageViewProps["onSelectWord"];
  onRenderError: PdfPageViewProps["onRenderError"];
}) {
  const pageShellRefs = useRef<Map<number, HTMLElement>>(new Map());
  const [documentProxy, setDocumentProxy] =
    useState<PDFDocumentProxy | null>(null);
  const shellListRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return;
    const shellList = shellListRef.current;
    if (!shellList) return;
    const previous = Number(shellList.dataset.pdfShellMapRenderCount) || 0;
    shellList.dataset.pdfShellMapRenderCount = String(previous + 1);
  });

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;

    const loadDocument = async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        loadingTask = pdfjs.getDocument({ data: data.slice() });
        const loadedDocument = await loadingTask.promise;
        if (!cancelled) setDocumentProxy(loadedDocument);
      } catch {
        if (!cancelled) {
          onRenderError(
            "The original PDF pages could not be opened. Focus view is still available.",
          );
        }
      }
    };

    void loadDocument();
    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [data, onRenderError]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageIndex = Number(
            (entry.target as HTMLElement).dataset.pdfPageIndex,
          );
          renderStore.setPageVisible(pageIndex, entry.isIntersecting);
        }
      },
      { rootMargin: "120% 0px" },
    );
    for (const shell of pageShellRefs.current.values()) observer.observe(shell);
    return () => observer.disconnect();
  }, [pages, renderStore]);

  const registerPageShell = useCallback(
    (pageIndex: number, element: HTMLElement | null) => {
      if (element) pageShellRefs.current.set(pageIndex, element);
      else pageShellRefs.current.delete(pageIndex);
    },
    [],
  );

  return (
    <div className="pdf-pages" ref={shellListRef}>
      {pages.map((page, pageIndex) => (
        <PdfPageShell
          documentProxy={documentProxy}
          page={page}
          pageIndex={pageIndex}
          renderStore={renderStore}
          tokenSentences={tokenSentences}
          tokenParagraphs={tokenParagraphs}
          registerHighlight={registerHighlight}
          registerPageShell={registerPageShell}
          registerWord={registerWord}
          onSelectWord={onSelectWord}
          onRenderError={onRenderError}
          key={page.pageNumber}
        />
      ))}
    </div>
  );
});

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
  data,
  pages,
  activeWord,
  activeHighlightIndex,
  tokenSentences,
  tokenParagraphs,
  highlightScope,
  registerWord,
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

  const pageWordStarts = useMemo(
    () => derivePdfPageWordStarts(pages),
    [pages],
  );
  const activePageIndex = findPageIndexForWord(pageWordStarts, activeWord);
  const pageRenderStore = useMemo(
    () => createPdfPageRenderStore(pages.length, 0),
    [pages],
  );

  useLayoutEffect(() => {
    pageRenderStore.setActivePageIndex(activePageIndex);
  }, [activePageIndex, pageRenderStore]);

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
    >
      <header className="pdf-view-intro">
        <p>Original page view</p>
        <h2>Read in the document’s own layout</h2>
        <span>Narration and highlighting stay synchronized across every page.</span>
      </header>

      <PdfPageShells
        data={data}
        pages={pages}
        renderStore={pageRenderStore}
        tokenSentences={tokenSentences}
        tokenParagraphs={tokenParagraphs}
        registerHighlight={registerHighlight}
        registerWord={registerWord}
        onSelectWord={onSelectWord}
        onRenderError={onRenderError}
      />
    </article>
  );
}
