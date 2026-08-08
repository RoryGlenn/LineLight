"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FOCUS_PARAGRAPH_OVERSCAN,
  estimateParagraphHeight,
  selectVirtualizedIndices,
} from "./reader-virtualization.mjs";

type FocusSegment = {
  text: string;
  tokenIndex?: number;
  focusTokenIndex?: number;
  sentenceIndex: number;
};

type FocusDocumentViewProps = {
  activeParagraphIndex: number;
  activeSentence: number;
  activeWord: number;
  className: string;
  documentId: string;
  documentKind: string;
  fontSize: number;
  focusLines: number;
  lineHeight: number;
  maxLineWidth: number;
  paragraphSpacing: number;
  paragraphs: FocusSegment[][];
  registerWord: (index: number, element: HTMLSpanElement | null) => void;
  onSelectWord: (index: number) => void;
  title: string;
};

export function FocusDocumentView({
  activeParagraphIndex,
  activeSentence,
  activeWord,
  className,
  documentId,
  documentKind,
  fontSize,
  focusLines,
  lineHeight,
  maxLineWidth,
  paragraphSpacing,
  paragraphs,
  registerWord,
  onSelectWord,
  title,
}: FocusDocumentViewProps) {
  const paragraphShellRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [visibleParagraphIndices, setVisibleParagraphIndices] = useState<
    Set<number>
  >(() => new Set([activeParagraphIndex]));
  const overscan = focusLines > 0 ? 1 : FOCUS_PARAGRAPH_OVERSCAN;
  const renderedParagraphIndices = useMemo(
    () =>
      new Set(
        selectVirtualizedIndices(
          visibleParagraphIndices,
          paragraphs.length,
          activeParagraphIndex,
          overscan,
        ),
      ),
    [activeParagraphIndex, overscan, paragraphs.length, visibleParagraphIndices],
  );
  const characterCounts = useMemo(
    () =>
      paragraphs.map((paragraph) =>
        paragraph.reduce((total, segment) => total + segment.text.length, 0),
      ),
    [paragraphs],
  );

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        setVisibleParagraphIndices((current) => {
          const next = new Set(current);
          let changed = false;
          for (const entry of entries) {
            const paragraphIndex = Number(
              (entry.target as HTMLElement).dataset.focusParagraphIndex,
            );
            if (!Number.isInteger(paragraphIndex)) continue;
            if (entry.isIntersecting && !next.has(paragraphIndex)) {
              next.add(paragraphIndex);
              changed = true;
            } else if (
              !entry.isIntersecting &&
              next.delete(paragraphIndex)
            ) {
              changed = true;
            }
          }
          return changed ? next : current;
        });
      },
      { rootMargin: "900px 0px" },
    );
    for (const shell of paragraphShellRefs.current.values()) {
      intersectionObserver.observe(shell);
    }
    return () => {
      intersectionObserver.disconnect();
    };
  }, [documentId, paragraphs.length]);

  const registerParagraphShell = useCallback(
    (paragraphIndex: number, element: HTMLDivElement | null) => {
      if (element) paragraphShellRefs.current.set(paragraphIndex, element);
      else paragraphShellRefs.current.delete(paragraphIndex);
    },
    [],
  );

  return (
    <article className={className}>
      <div className="chapter-heading">
        <span className="chapter-rule" aria-hidden="true" />
        <p>{documentKind === "demo" ? "A reading sample" : "Imported document"}</p>
        <h2>{title}</h2>
      </div>

      <div className="reading-copy">
        {paragraphs.map((paragraph, paragraphIndex) => {
          const shouldRender = renderedParagraphIndices.has(paragraphIndex);
          const placeholderHeight = estimateParagraphHeight(
            characterCounts[paragraphIndex],
            fontSize,
            lineHeight,
            maxLineWidth,
            paragraphSpacing,
          );
          const style = shouldRender
            ? undefined
            : ({ height: `${placeholderHeight}px` } as CSSProperties);

          return (
            <div
              className="focus-paragraph-shell"
              data-focus-paragraph-index={paragraphIndex}
              id={`focus-paragraph-${paragraphIndex}`}
              ref={(element) => registerParagraphShell(paragraphIndex, element)}
              style={style}
              key={`${documentId}-${paragraphIndex}`}
            >
              {shouldRender && (
                <p>
                  {paragraph.map((segment, segmentIndex) => {
                    const isCurrentSentence =
                      segment.sentenceIndex === activeSentence;
                    if (segment.tokenIndex === undefined) {
                      return (
                        <span
                          className={
                            isCurrentSentence ? "sentence-active" : undefined
                          }
                          data-focus-token={segment.focusTokenIndex}
                          key={`${paragraphIndex}-${segmentIndex}`}
                        >
                          {segment.text}
                        </span>
                      );
                    }
                    const isActive = segment.tokenIndex === activeWord;
                    return (
                      <span
                        className={[
                          "spoken-word",
                          isCurrentSentence ? "sentence-active" : "",
                          isActive ? "word-active" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        id={isActive ? "active-spoken-word" : undefined}
                        data-focus-token={segment.focusTokenIndex}
                        key={`${paragraphIndex}-${segmentIndex}`}
                        ref={(element) =>
                          registerWord(segment.tokenIndex!, element)
                        }
                        onClick={() => onSelectWord(segment.tokenIndex!)}
                      >
                        {segment.text}
                      </span>
                    );
                  })}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <footer className="document-end">
        <span aria-hidden="true">✦</span>
        <p>End of document</p>
      </footer>
    </article>
  );
}
