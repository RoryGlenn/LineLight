"use client";

import {
  memo,
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  createFocusParagraphRenderStore,
  estimateParagraphHeight,
  FOCUS_PARAGRAPH_OVERSCAN,
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
  className: string;
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

type FocusParagraphRenderStore = ReturnType<
  typeof createFocusParagraphRenderStore
>;

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

const FocusParagraphShell = memo(function FocusParagraphShell({
  characterCount,
  documentId,
  fontSize,
  lineHeight,
  maxLineWidth,
  paragraph,
  paragraphIndex,
  paragraphSpacing,
  registerHighlight,
  registerParagraphShell,
  registerWord,
  renderStore,
  onSelectWord,
}: {
  characterCount: number;
  documentId: string;
  fontSize: number;
  lineHeight: number;
  maxLineWidth: number;
  paragraph: FocusSegment[];
  paragraphIndex: number;
  paragraphSpacing: number;
  registerHighlight: FocusHighlightRegistration;
  registerParagraphShell: (
    paragraphIndex: number,
    element: HTMLDivElement | null,
  ) => void;
  registerWord: FocusDocumentViewProps["registerWord"];
  renderStore: FocusParagraphRenderStore;
  onSelectWord: FocusDocumentViewProps["onSelectWord"];
}) {
  const subscribe = useCallback(
    (listener: () => void) => renderStore.subscribe(paragraphIndex, listener),
    [paragraphIndex, renderStore],
  );
  const getSnapshot = useCallback(
    () => renderStore.isParagraphRendered(paragraphIndex),
    [paragraphIndex, renderStore],
  );
  const shouldRender = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const shellRef = useRef<HTMLDivElement>(null);
  const sentenceGroups = useMemo(
    () => groupParagraphSentences(paragraph),
    [paragraph],
  );
  const setShellRef = useCallback(
    (element: HTMLDivElement | null) => {
      shellRef.current = element;
      registerParagraphShell(paragraphIndex, element);
    },
    [paragraphIndex, registerParagraphShell],
  );

  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return;
    const shell = shellRef.current;
    if (!shell) return;
    shell.dataset.focusShellRenderCount = String(
      (Number(shell.dataset.focusShellRenderCount) || 0) + 1,
    );
  });

  const placeholderHeight = estimateParagraphHeight(
    characterCount,
    fontSize,
    lineHeight,
    maxLineWidth,
    paragraphSpacing,
  );
  const style = shouldRender
    ? undefined
    : ({ height: `${placeholderHeight}px` } as CSSProperties);
  const paragraphKey = `${documentId}:${paragraphIndex}`;

  return (
    <div
      className="focus-paragraph-shell"
      data-focus-paragraph-index={paragraphIndex}
      data-focus-paragraph-rendered={shouldRender ? "true" : "false"}
      id={`focus-paragraph-${paragraphIndex}`}
      ref={setShellRef}
      style={style}
    >
      {shouldRender && (
        <p>
          <span
            className="focus-paragraph-region"
            data-focus-paragraph={paragraphIndex}
            ref={(element) =>
              registerHighlight(
                "paragraph",
                paragraphIndex,
                paragraphKey,
                element,
              )
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
                        ref={(element) =>
                          registerWord(segment.tokenIndex!, element)
                        }
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
      )}
    </div>
  );
});

const FocusParagraphShells = memo(function FocusParagraphShells({
  documentId,
  fontSize,
  lineHeight,
  maxLineWidth,
  paragraphSpacing,
  paragraphs,
  registerHighlight,
  registerWord,
  renderStore,
  onSelectWord,
}: {
  documentId: string;
  fontSize: number;
  lineHeight: number;
  maxLineWidth: number;
  paragraphSpacing: number;
  paragraphs: FocusSegment[][];
  registerHighlight: FocusHighlightRegistration;
  registerWord: FocusDocumentViewProps["registerWord"];
  renderStore: FocusParagraphRenderStore;
  onSelectWord: FocusDocumentViewProps["onSelectWord"];
}) {
  const paragraphShellRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const shellListRef = useRef<HTMLDivElement>(null);
  const characterCounts = useMemo(
    () =>
      paragraphs.map((paragraph) =>
        paragraph.reduce((total, segment) => total + segment.text.length, 0),
      ),
    [paragraphs],
  );

  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return;
    const shellList = shellListRef.current;
    if (!shellList) return;
    shellList.dataset.focusShellMapRenderCount = String(
      (Number(shellList.dataset.focusShellMapRenderCount) || 0) + 1,
    );
  });

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const paragraphIndex = Number(
            (entry.target as HTMLElement).dataset.focusParagraphIndex,
          );
          renderStore.setParagraphVisible(paragraphIndex, entry.isIntersecting);
        }
      },
      { rootMargin: "900px 0px" },
    );
    for (const shell of paragraphShellRefs.current.values()) {
      observer.observe(shell);
    }
    return () => observer.disconnect();
  }, [paragraphs, renderStore]);

  const registerParagraphShell = useCallback(
    (paragraphIndex: number, element: HTMLDivElement | null) => {
      if (element) paragraphShellRefs.current.set(paragraphIndex, element);
      else paragraphShellRefs.current.delete(paragraphIndex);
    },
    [],
  );

  return (
    <div className="reading-copy focus-paragraphs" ref={shellListRef}>
      {paragraphs.map((paragraph, paragraphIndex) => (
        <FocusParagraphShell
          characterCount={characterCounts[paragraphIndex]}
          documentId={documentId}
          fontSize={fontSize}
          lineHeight={lineHeight}
          maxLineWidth={maxLineWidth}
          paragraph={paragraph}
          paragraphIndex={paragraphIndex}
          paragraphSpacing={paragraphSpacing}
          registerHighlight={registerHighlight}
          registerParagraphShell={registerParagraphShell}
          registerWord={registerWord}
          renderStore={renderStore}
          onSelectWord={onSelectWord}
          key={`${documentId}-${paragraphIndex}`}
        />
      ))}
    </div>
  );
});

export function FocusDocumentView({
  activeParagraphIndex,
  activeHighlightIndex,
  className,
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
  const overscan = focusLines > 0 ? 1 : FOCUS_PARAGRAPH_OVERSCAN;
  const renderStore = useMemo(
    () =>
      createFocusParagraphRenderStore(
        paragraphs.length,
        0,
        overscan,
      ),
    [overscan, paragraphs.length],
  );

  useLayoutEffect(() => {
    renderStore.setActiveParagraphIndex(activeParagraphIndex);
  }, [activeParagraphIndex, renderStore]);

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

      <FocusParagraphShells
        documentId={documentId}
        fontSize={fontSize}
        lineHeight={lineHeight}
        maxLineWidth={maxLineWidth}
        paragraphSpacing={paragraphSpacing}
        paragraphs={paragraphs}
        registerHighlight={registerHighlight}
        registerWord={registerWord}
        renderStore={renderStore}
        onSelectWord={onSelectWord}
      />

      <footer className="document-end">
        <span aria-hidden="true">✦</span>
        <p>End of document</p>
      </footer>
    </article>
  );
}
