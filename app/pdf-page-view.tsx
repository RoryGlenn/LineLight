"use client";

import {
  type CSSProperties,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

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

function PdfTextItem({
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
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const [renderedPages, setRenderedPages] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let documentProxy: PDFDocumentProxy | undefined;

    const renderPages = async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        const loadingTask = pdfjs.getDocument({ data: data.slice() });
        documentProxy = await loadingTask.promise;
        const outputScale = Math.min(
          2,
          Math.max(1.35, window.devicePixelRatio || 1),
        );

        for (const pageLayout of pages) {
          if (cancelled || !documentProxy) break;
          const page = await documentProxy.getPage(pageLayout.pageNumber);
          const viewport = page.getViewport({ scale: outputScale });
          const canvas = canvasRefs.current.get(pageLayout.pageNumber);
          const context = canvas?.getContext("2d", { alpha: false });
          if (!canvas || !context) continue;

          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({
            canvas,
            canvasContext: context,
            viewport,
          }).promise;

          if (!cancelled) {
            setRenderedPages(pageLayout.pageNumber);
          }
        }
      } catch {
        if (!cancelled) {
          onRenderError(
            "The original PDF pages could not be drawn. Focus view is still available.",
          );
        }
      }
    };

    void renderPages();
    return () => {
      cancelled = true;
      void documentProxy?.destroy();
    };
  }, [data, onRenderError, pages]);

  return (
    <article
      className={`pdf-page-view highlight-${highlightMode}`}
      aria-label="Original PDF pages"
    >
      <header className="pdf-view-intro">
        <p>Original page view</p>
        <h2>Read in the document’s own layout</h2>
        <span>
          Narration and highlighting stay synchronized across every page.
        </span>
      </header>

      <div className="pdf-pages">
        {pages.map((page) => (
          <section className="pdf-page-block" key={page.pageNumber}>
            <div
              className="pdf-page"
              style={{ aspectRatio: `${page.width} / ${page.height}` }}
            >
              <canvas
                ref={(canvas) => {
                  if (canvas) {
                    canvasRefs.current.set(page.pageNumber, canvas);
                  } else {
                    canvasRefs.current.delete(page.pageNumber);
                  }
                }}
                aria-hidden="true"
              />
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
              {renderedPages < page.pageNumber && (
                <div className="pdf-page-loading" role="status">
                  <span aria-hidden="true">•••</span>
                  Drawing page {page.pageNumber}
                </div>
              )}
            </div>
            <p className="pdf-page-number">Page {page.pageNumber}</p>
          </section>
        ))}
      </div>
    </article>
  );
}
