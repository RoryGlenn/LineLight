"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  estimateParagraphHeight,
  FOCUS_PARAGRAPH_OVERSCAN,
  selectVirtualizedRanges,
} from "./reader-virtualization.mjs";

type HighlightScope = "sentence" | "paragraph";
type FocusHighlightKind = HighlightScope;

type FocusSegment = {
  text: string;
  tokenIndex?: number;
  focusTokenIndex?: number;
  sentenceIndex: number;
};

type FocusDocumentViewProps = {
  activeParagraphIndex: number;
  activeHighlightIndex: number;
  characterCounts?: number[];
  className: string;
  contentVersion: number;
  documentId: string;
  documentKind: string;
  fontSize: number;
  focusLines: number;
  highlightScope: HighlightScope;
  lineHeight: number;
  maxLineWidth: number;
  paragraphSpacing: number;
  paragraphs: FocusSegment[][];
  registerWord: (index: number, element: HTMLSpanElement | null) => void;
  onSelectWord: (index: number) => void;
  title: string;
};

type FocusHighlightRegistration = (
  kind: FocusHighlightKind,
  index: number,
  key: string,
  element: HTMLSpanElement | null,
) => void;

function groupParagraphSentences(paragraph: FocusSegment[]) {
  const groups: Array<{ sentenceIndex: number; segments: FocusSegment[] }> = [];
  for (const segment of paragraph) {
    const current = groups.at(-1);
    if (!current || current.sentenceIndex !== segment.sentenceIndex) {
      groups.push({ sentenceIndex: segment.sentenceIndex, segments: [segment] });
    } else {
      current.segments.push(segment);
    }
  }
  return groups;
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

const FocusParagraph = memo(function FocusParagraph({
  documentId,
  paragraph,
  paragraphIndex,
  paragraphCount,
  registerHighlight,
  registerShell,
  registerWord,
  onSelectWord,
}: {
  documentId: string;
  paragraph: FocusSegment[];
  paragraphIndex: number;
  paragraphCount: number;
  registerHighlight: FocusHighlightRegistration;
  registerShell: (paragraphIndex: number, element: HTMLDivElement | null) => void;
  registerWord: FocusDocumentViewProps["registerWord"];
  onSelectWord: FocusDocumentViewProps["onSelectWord"];
}) {
  const sentenceGroups = useMemo(
    () => groupParagraphSentences(paragraph),
    [paragraph],
  );
  const paragraphKey = `${documentId}:${paragraphIndex}`;
  return (
    <div
      className="focus-paragraph-shell"
      data-focus-paragraph-index={paragraphIndex}
      data-focus-paragraph-rendered="true"
      id={`focus-paragraph-${paragraphIndex}`}
      role="article"
      aria-posinset={paragraphIndex + 1}
      aria-setsize={paragraphCount}
      tabIndex={0}
      ref={(element) => registerShell(paragraphIndex, element)}
    >
      <p>
        <span
          className="focus-paragraph-region"
          data-focus-paragraph={paragraphIndex}
          ref={(element) =>
            registerHighlight("paragraph", paragraphIndex, paragraphKey, element)
          }
        >
          {sentenceGroups.map((group, groupIndex) => {
            const sentenceKey = `${paragraphKey}:${group.sentenceIndex}:${groupIndex}`;
            return (
              <span
                className="focus-sentence-region"
                data-focus-sentence={group.sentenceIndex}
                key={sentenceKey}
                ref={(element) =>
                  registerHighlight(
                    "sentence",
                    group.sentenceIndex,
                    sentenceKey,
                    element,
                  )
                }
              >
                {group.segments.map((segment, segmentIndex) => {
                  const key = `${sentenceKey}:${segmentIndex}`;
                  if (segment.tokenIndex === undefined) {
                    return (
                      <span data-focus-token={segment.focusTokenIndex} key={key}>
                        {segment.text}
                      </span>
                    );
                  }
                  return (
                    <span
                      className="spoken-word"
                      data-focus-token={segment.focusTokenIndex}
                      key={key}
                      ref={(element) => registerWord(segment.tokenIndex!, element)}
                      onClick={() => onSelectWord(segment.tokenIndex!)}
                    >
                      {segment.text}
                    </span>
                  );
                })}
              </span>
            );
          })}
        </span>
      </p>
    </div>
  );
});

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

function FocusParagraphRange({
  activeParagraphIndex,
  characterCounts: suppliedCharacterCounts,
  contentVersion,
  documentId,
  fontSize,
  focusLines,
  lineHeight,
  maxLineWidth,
  paragraphSpacing,
  paragraphs,
  registerHighlight,
  registerWord,
  onSelectWord,
}: {
  activeParagraphIndex: number;
  characterCounts?: number[];
  contentVersion: number;
  documentId: string;
  fontSize: number;
  focusLines: number;
  lineHeight: number;
  maxLineWidth: number;
  paragraphSpacing: number;
  paragraphs: FocusSegment[][];
  registerHighlight: FocusHighlightRegistration;
  registerWord: FocusDocumentViewProps["registerWord"];
  onSelectWord: FocusDocumentViewProps["onSelectWord"];
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const shellRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [measuredHeights, setMeasuredHeights] = useState<Map<number, number>>(
    () => new Map(),
  );
  const overscan = focusLines > 0 ? 1 : FOCUS_PARAGRAPH_OVERSCAN;
  const [range, setRange] = useState({
    start: 0,
    end: 0,
  });
  const calculatedCharacterCounts = useMemo(
    () =>
      suppliedCharacterCounts ??
      paragraphs.map((paragraph) =>
        paragraph.reduce((total, segment) => total + segment.text.length, 0),
      ),
    [paragraphs, suppliedCharacterCounts],
  );
  const offsets = useMemo(() => {
    void contentVersion;
    const next = [0];
    for (let index = 0; index < paragraphs.length; index += 1) {
      const estimated = estimateParagraphHeight(
        calculatedCharacterCounts[index] ?? 0,
        fontSize,
        lineHeight,
        maxLineWidth,
        paragraphSpacing,
      );
      next.push(next.at(-1)! + (measuredHeights.get(index) ?? estimated));
    }
    return next;
  }, [
    calculatedCharacterCounts,
    contentVersion,
    fontSize,
    lineHeight,
    maxLineWidth,
    measuredHeights,
    paragraphSpacing,
    paragraphs.length,
  ]);
  const mountedRanges = selectVirtualizedRanges(
    range.start,
    range.end,
    paragraphs.length,
    activeParagraphIndex,
    overscan,
  ) as Array<{ start: number; end: number }>;
  const mountedRangesKey = mountedRanges
    .map((mountedRange) => `${mountedRange.start}:${mountedRange.end}`)
    .join(",");

  useEffect(() => {
    const list = listRef.current;
    const root = list?.closest<HTMLElement>(".reader-scroll");
    if (!list || !root) return;
    let scrollFrame = 0;
    const updateRange = () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        const listTop =
          list.getBoundingClientRect().top - root.getBoundingClientRect().top +
          root.scrollTop;
        const startOffset = Math.max(0, root.scrollTop - listTop);
        const endOffset = startOffset + root.clientHeight;
        const visibleStart = findOffsetIndex(offsets, startOffset);
        const visibleEnd = findOffsetIndex(offsets, endOffset);
        setRange({
          start: visibleStart,
          end: Math.min(paragraphs.length - 1, visibleEnd),
        });
      });
    };
    const observer = new ResizeObserver((entries) => {
      const updates: Array<[number, number]> = [];
      for (const entry of entries) {
        const index = Number(
          (entry.target as HTMLElement).dataset.focusParagraphIndex,
        );
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (Math.abs((measuredHeights.get(index) ?? 0) - height) > 1) {
          updates.push([index, height]);
        }
      }
      if (updates.length) {
        setMeasuredHeights((current) => {
          const next = new Map(current);
          for (const [index, height] of updates) next.set(index, height);
          return next;
        });
      }
    });
    for (const shell of shellRefs.current.values()) observer.observe(shell);
    root.addEventListener("scroll", updateRange, { passive: true });
    updateRange();
    return () => {
      cancelAnimationFrame(scrollFrame);
      observer.disconnect();
      root.removeEventListener("scroll", updateRange);
    };
  }, [
    contentVersion,
    measuredHeights,
    mountedRangesKey,
    offsets,
    overscan,
    paragraphs.length,
  ]);

  const registerShell = useCallback(
    (paragraphIndex: number, element: HTMLDivElement | null) => {
      if (element) shellRefs.current.set(paragraphIndex, element);
      else shellRefs.current.delete(paragraphIndex);
    },
    [],
  );
  if (!paragraphs.length) {
    return <div className="reading-copy focus-paragraphs" ref={listRef} />;
  }
  const rangeRows: Array<
    | { kind: "spacer"; height: number; key: string }
    | {
        kind: "paragraph";
        paragraph: FocusSegment[];
        paragraphIndex: number;
        key: string;
      }
  > = [];
  let rangeCursor = 0;
  for (const mountedRange of mountedRanges) {
    const spacerHeight =
      (offsets[mountedRange.start] ?? 0) - (offsets[rangeCursor] ?? 0);
    if (spacerHeight > 0) {
      rangeRows.push({
        kind: "spacer",
        height: spacerHeight,
        key: `spacer-${rangeCursor}-${mountedRange.start}`,
      });
    }
    for (
      let paragraphIndex = mountedRange.start;
      paragraphIndex <= mountedRange.end;
      paragraphIndex += 1
    ) {
      rangeRows.push({
        kind: "paragraph",
        paragraph: paragraphs[paragraphIndex],
        paragraphIndex,
        key: `${documentId}-${paragraphIndex}`,
      });
    }
    rangeCursor = mountedRange.end + 1;
  }
  const trailingHeight =
    (offsets.at(-1) ?? 0) - (offsets[rangeCursor] ?? 0);
  if (trailingHeight > 0) {
    rangeRows.push({
      kind: "spacer",
      height: trailingHeight,
      key: `spacer-${rangeCursor}-end`,
    });
  }
  const descriptionId = `focus-range-description-${documentId}`;
  return (
    <div
      className="reading-copy focus-paragraphs"
      data-focus-range={mountedRangesKey}
      role="feed"
      aria-describedby={descriptionId}
      ref={listRef}
    >
      <p
        className="reader-visually-hidden"
        id={descriptionId}
        aria-live="polite"
      >
        Showing paragraphs {range.start + 1} through {range.end + 1} of{" "}
        {paragraphs.length}. More paragraphs load as you scroll.
      </p>
      {rangeRows.map((row) =>
        row.kind === "spacer" ? (
          <div
            aria-hidden="true"
            className="focus-range-spacer"
            key={row.key}
            style={{ height: row.height }}
          />
        ) : (
          <FocusParagraph
            documentId={documentId}
            paragraph={row.paragraph}
            paragraphCount={paragraphs.length}
            paragraphIndex={row.paragraphIndex}
            registerHighlight={registerHighlight}
            registerShell={registerShell}
            registerWord={registerWord}
            onSelectWord={onSelectWord}
            key={row.key}
          />
        ),
      )}
      {range.end >= paragraphs.length - 1 && (
        <p className="reader-visually-hidden">End of document.</p>
      )}
    </div>
  );
}

export function FocusDocumentView({
  activeParagraphIndex,
  activeHighlightIndex,
  characterCounts,
  className,
  contentVersion,
  documentId,
  documentKind,
  fontSize,
  focusLines,
  highlightScope,
  lineHeight,
  maxLineWidth,
  paragraphSpacing,
  paragraphs,
  registerWord,
  onSelectWord,
  title,
}: FocusDocumentViewProps) {
  const highlightElements = useRef<
    Record<FocusHighlightKind, Map<number, Map<string, HTMLSpanElement>>>
  >({ sentence: new Map(), paragraph: new Map() });
  const activeHighlightIndexRef = useRef(activeHighlightIndex);
  const highlightScopeRef = useRef(highlightScope);
  const previousHighlightRef = useRef({
    index: activeHighlightIndex,
    scope: highlightScope,
  });

  const registerHighlight = useCallback<FocusHighlightRegistration>(
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
    <article className={className}>
      <div className="chapter-heading">
        <span className="chapter-rule" aria-hidden="true" />
        <p>{documentKind === "demo" ? "A reading sample" : "Imported document"}</p>
        <h2>{title}</h2>
      </div>

      <FocusParagraphRange
        activeParagraphIndex={activeParagraphIndex}
        characterCounts={characterCounts}
        contentVersion={contentVersion}
        documentId={documentId}
        fontSize={fontSize}
        focusLines={focusLines}
        lineHeight={lineHeight}
        maxLineWidth={maxLineWidth}
        paragraphSpacing={paragraphSpacing}
        paragraphs={paragraphs}
        registerHighlight={registerHighlight}
        registerWord={registerWord}
        onSelectWord={onSelectWord}
      />

      <footer className="document-end" aria-hidden="true">
        <span aria-hidden="true">✦</span>
        <p>End of document</p>
      </footer>
    </article>
  );
}
