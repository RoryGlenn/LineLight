"use client";

import {
  memo,
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";
import { derivePdfPageWordStarts } from "./pdf-outline.mjs";
import {
  PDF_PAGE_OVERSCAN,
  findPageIndexForWord,
  selectVirtualizedIndices,
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
};

export type PdfPageLayout = {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextItemLayout[];
};

type HighlightMode = "both" | "word" | "sentence";

type PdfPageViewProps = {
  data: Uint8Array;
  pages: PdfPageLayout[];
  activeWord: number;
  activeSentence: number;
  tokenSentences: number[];
  highlightMode: HighlightMode;
  registerWord: (index: number, element: HTMLSpanElement | null) => void;
  onSelectWord: (index: number) => void;
  onRenderError: (message: string) => void;
};

const WORD_PATTERN =
  /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*|[^\s]/gu;
const IS_WORD = /^[\p{L}\p{N}]/u;

const PdfTextItem = memo(function PdfTextItem({
  item,
  page,
  activeWord,
  activeSentence,
  tokenSentences,
  registerWord,
  onSelectWord,
}: {
  item: PdfTextItemLayout;
  page: PdfPageLayout;
  activeWord: number;
  activeSentence: number;
  tokenSentences: number[];
  registerWord: PdfPageViewProps["registerWord"];
  onSelectWord: PdfPageViewProps["onSelectWord"];
}) {
  const segments: Array<{
    text: string;
    wordIndex?: number;
  }> = [];
  let previousEnd = 0;
  let wordOffset = 0;

  for (const match of item.text.matchAll(WORD_PATTERN)) {
    const start = match.index ?? 0;
    if (start > previousEnd) {
      segments.push({ text: item.text.slice(previousEnd, start) });
    }
    const text = match[0];
    if (IS_WORD.test(text)) {
      segments.push({
        text,
        wordIndex: item.wordStart + wordOffset,
      });
      wordOffset += 1;
    } else {
      segments.push({ text });
    }
    previousEnd = start + text.length;
  }

  if (previousEnd < item.text.length) {
    segments.push({ text: item.text.slice(previousEnd) });
  }

  const estimatedWidth = Math.max(
    item.fontSize * 0.52 * Math.max(item.text.length, 1),
    1,
  );
  const horizontalScale = Math.min(
    3,
    Math.max(0.35, item.width / estimatedWidth),
  );
  const style = {
    left: `${(item.left / page.width) * 100}%`,
    top: `${(item.top / page.height) * 100}%`,
    width: `${(item.width / page.width) * 100}%`,
    height: `${(item.height / page.height) * 100}%`,
    "--pdf-font-size": (item.fontSize / page.width) * 100,
    "--pdf-text-scale": horizontalScale,
    "--pdf-text-angle": `${item.angle}deg`,
  } as CSSProperties;

  return (
    <span className="pdf-text-item" style={style}>
      <span className="pdf-item-text">
        {segments.map((segment, segmentIndex) => {
          if (segment.wordIndex === undefined) {
            return (
              <span key={segmentIndex} aria-hidden="true">
                {segment.text}
              </span>
            );
          }

          const sentenceIndex = tokenSentences[segment.wordIndex] ?? -1;
          const isActive = segment.wordIndex === activeWord;
          const isCurrentSentence = sentenceIndex === activeSentence;
          return (
            <span
              className={[
                "pdf-spoken-word",
                isCurrentSentence ? "sentence-active" : "",
                isActive ? "word-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={segmentIndex}
              ref={(element) => registerWord(segment.wordIndex!, element)}
              onClick={() => onSelectWord(segment.wordIndex!)}
              aria-label={segment.text}
            >
              {segment.text}
            </span>
          );
        })}
      </span>
    </span>
  );
});

function PdfRenderedPage({
  documentProxy,
  page,
  activeWord,
  activeSentence,
  tokenSentences,
  registerWord,
  onSelectWord,
  onRenderError,
}: {
  documentProxy: PDFDocumentProxy | null;
  page: PdfPageLayout;
  activeWord: number;
  activeSentence: number;
  tokenSentences: number[];
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
      <div className="pdf-text-layer">
        {page.items.map((item, itemIndex) => (
          <PdfTextItem
            item={item}
            page={page}
            activeWord={activeWord}
            activeSentence={activeSentence}
            tokenSentences={tokenSentences}
            registerWord={registerWord}
            onSelectWord={onSelectWord}
            key={`${page.pageNumber}-${itemIndex}`}
          />
        ))}
      </div>
      {!isRendered && (
        <div className="pdf-page-loading" role="status">
          <span aria-hidden="true">•••</span>
          Drawing page {page.pageNumber}
        </div>
      )}
    </>
  );
}

export function PdfPageView({
  data,
  pages,
  activeWord,
  activeSentence,
  tokenSentences,
  highlightMode,
  registerWord,
  onSelectWord,
  onRenderError,
}: PdfPageViewProps) {
  const pageShellRefs = useRef<Map<number, HTMLElement>>(new Map());
  const [documentProxy, setDocumentProxy] =
    useState<PDFDocumentProxy | null>(null);
  const [visiblePageIndices, setVisiblePageIndices] = useState<Set<number>>(
    () => new Set([0]),
  );
  const pageWordStarts = useMemo(
    () => derivePdfPageWordStarts(pages),
    [pages],
  );
  const activePageIndex = findPageIndexForWord(pageWordStarts, activeWord);
  const renderedPageIndices = useMemo(
    () =>
      new Set(
        selectVirtualizedIndices(
          visiblePageIndices,
          pages.length,
          activePageIndex,
          PDF_PAGE_OVERSCAN,
        ),
      ),
    [activePageIndex, pages.length, visiblePageIndices],
  );

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
        setVisiblePageIndices((current) => {
          const next = new Set(current);
          let changed = false;
          for (const entry of entries) {
            const pageIndex = Number(
              (entry.target as HTMLElement).dataset.pdfPageIndex,
            );
            if (!Number.isInteger(pageIndex)) continue;
            if (entry.isIntersecting && !next.has(pageIndex)) {
              next.add(pageIndex);
              changed = true;
            } else if (!entry.isIntersecting && next.delete(pageIndex)) {
              changed = true;
            }
          }
          return changed ? next : current;
        });
      },
      { rootMargin: "120% 0px" },
    );
    for (const shell of pageShellRefs.current.values()) observer.observe(shell);
    return () => observer.disconnect();
  }, [pages]);

  const registerPageShell = useCallback(
    (pageIndex: number, element: HTMLElement | null) => {
      if (element) pageShellRefs.current.set(pageIndex, element);
      else pageShellRefs.current.delete(pageIndex);
    },
    [],
  );

  return (
    <article
      className={`pdf-page-view highlight-${highlightMode}`}
      aria-label="Original PDF pages"
    >
      <header className="pdf-view-intro">
        <p>Original page view</p>
        <h2>Read in the document’s own layout</h2>
        <span>Narration and highlighting stay synchronized across every page.</span>
      </header>

      <div className="pdf-pages">
        {pages.map((page, pageIndex) => {
          const shouldRender = renderedPageIndices.has(pageIndex);
          return (
            <section
              className="pdf-page-block"
              id={`pdf-page-${page.pageNumber}`}
              data-pdf-page-index={pageIndex}
              ref={(element) => registerPageShell(pageIndex, element)}
              key={page.pageNumber}
            >
              <div
                className="pdf-page"
                style={{ aspectRatio: `${page.width} / ${page.height}` }}
              >
                {shouldRender ? (
                  <PdfRenderedPage
                    documentProxy={documentProxy}
                    page={page}
                    activeWord={activeWord}
                    activeSentence={activeSentence}
                    tokenSentences={tokenSentences}
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
        })}
      </div>
    </article>
  );
}
