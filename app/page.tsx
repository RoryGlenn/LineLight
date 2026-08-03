"use client";

import {
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import JSZip from "jszip";
import { PdfPageView, type PdfPageLayout } from "./pdf-page-view";
import {
  buildSentenceStartIndices,
  buildSpeechChunk,
  findAdjacentSentenceStart,
  findBufferedSeekOffset,
  findTimedBoundaryIndex,
  isRetryableSpeechError,
  speechFailureMessage,
} from "./speech-utils.mjs";
import {
  AzureSpeechError,
  synthesizeAzureSpeech,
  type AzureSpeechResult,
} from "./azure-speech";
import {
  OFFLINE_PACK_BYTES,
  OFFLINE_SPEECH_CHUNK_CHARACTERS,
  OFFLINE_SPEECH_LOOKAHEAD_CHUNKS,
  OFFLINE_VOICES,
  type OfflineVoiceId,
} from "./offline-speech-config";
import {
  OfflineSpeechError,
  disposeOfflineSpeechWorker,
  installOfflineVoicePack,
  isOfflineVoicePackInstalled,
  removeOfflineVoicePack,
  synthesizeOfflineSpeech,
  type OfflineSpeechResult,
} from "./offline-speech";
import { createSpeechPrefetchQueue } from "./speech-prefetch.mjs";
import { DEFAULT_NARRATION_ENGINE } from "./narration-defaults.mjs";
import {
  DEFAULT_READER_LAYOUT,
  createReaderLayoutStyle,
  normalizeReaderLayout,
  selectFocusWindowTokens,
} from "./reader-layout.mjs";
import {
  addReaderDocument,
  calculateLibraryProgress,
  countDocumentWords,
  filterLibraryEntries,
  getReaderNavigation,
  getReaderDocument,
  loadReaderLibrary,
  openReaderDocument,
  removeReaderDocument,
  renameReaderDocument,
  saveReaderNavigation,
  sortLibraryEntries,
} from "./reader-library.mjs";
import {
  MAX_POSITION_HISTORY,
  createPositionSnapshot,
  findDocumentMatches,
  isMeaningfulPositionJump,
  pushPositionHistory,
  resolveStoredPosition,
} from "./reader-navigation.mjs";

type DocumentKind = "demo" | "pdf" | "epub" | "txt";
type HighlightMode = "both" | "word" | "sentence";
type ReadingTheme = "cream" | "white" | "dark";
type ReadingFont = "serif" | "sans" | "system";
type ReaderViewMode = "focus" | "page";
type FocusLineCount = 0 | 1 | 3 | 5;
type NarrationEngine = "device" | "offline" | "azure";
type OfflinePackState =
  | "checking"
  | "missing"
  | "installing"
  | "ready"
  | "removing"
  | "error";

type OfflineRuntimeInfo = {
  audioDurationSeconds: number;
  device: "webgpu" | "wasm";
  synthesisMilliseconds: number;
  wasmThreads: number | null;
};

type BufferedSeekState = {
  audio: HTMLAudioElement;
  sessionId: number;
  startIndex: number;
  nextIndex: number;
  boundaries: Array<{
    audioOffsetSeconds: number;
    tokenIndex: number;
  }>;
};

type ReaderDocument = {
  id: string;
  title: string;
  author: string;
  kind: DocumentKind;
  paragraphs: string[];
  pdfData?: Uint8Array;
  pdfPages?: PdfPageLayout[];
};

type LibraryEntry = {
  id: string;
  title: string;
  author: string;
  kind: DocumentKind;
  wordCount: number;
  createdAt: number;
  lastOpenedAt: number;
};

type WordToken = {
  index: number;
  text: string;
  start: number;
  end: number;
  paragraphIndex: number;
  sentenceIndex: number;
};

type StoredReaderPosition = {
  tokenIndex: number;
  anchorText: string;
  contextBefore: string[];
  contextAfter: string[];
  snippet: string;
  createdAt: number;
};

type ReaderBookmark = StoredReaderPosition & {
  id: string;
  name: string;
};

type ReaderNavigationState = {
  version: number;
  bookmarks: ReaderBookmark[];
  history: StoredReaderPosition[];
};

type Segment = {
  text: string;
  tokenIndex?: number;
  focusTokenIndex?: number;
  sentenceIndex: number;
};

type DocumentModel = {
  fullText: string;
  tokens: WordToken[];
  paragraphs: Segment[][];
};

type ReaderSettings = {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  wordSpacing: number;
  paragraphSpacing: number;
  maxLineWidth: number;
  focusLines: FocusLineCount;
  font: ReadingFont;
  theme: ReadingTheme;
  highlightMode: HighlightMode;
  follow: boolean;
  ruler: boolean;
  rate: number;
  narrationEngine: NarrationEngine;
  voiceURI: string;
  offlineVoice: OfflineVoiceId;
  azureVoice: string;
};

type AzureVoiceOption = {
  value: string;
  label: string;
  description: string;
};

const DEMO_DOCUMENT: ReaderDocument = {
  id: "gentle-start",
  title: "A Gentle Start",
  author: "LineLight",
  kind: "demo",
  paragraphs: [
    "Reading is not a race. It is a place to arrive, one sentence at a time.",
    "Begin by letting your eyes rest on the highlighted word. The voice will keep your place while the page stays quiet around it. You can pause whenever you need to, replay a sentence, or slow the pace down.",
    "If your attention wanders, nothing has gone wrong. Press Return to narration and the page will bring the current sentence back into view. Your progress is saved on this device, so the next session can begin where this one ends.",
    "A comfortable reading rhythm is personal. Adjust the type, spacing, colors, and focus tools until the page feels easier to hold in your mind.",
  ],
};

const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 21,
  lineHeight: 1.78,
  letterSpacing: DEFAULT_READER_LAYOUT.letterSpacing,
  wordSpacing: DEFAULT_READER_LAYOUT.wordSpacing,
  paragraphSpacing: DEFAULT_READER_LAYOUT.paragraphSpacing,
  maxLineWidth: DEFAULT_READER_LAYOUT.maxLineWidth,
  focusLines: DEFAULT_READER_LAYOUT.focusLines as FocusLineCount,
  font: "serif",
  theme: "cream",
  highlightMode: "both",
  follow: true,
  ruler: false,
  rate: 1,
  narrationEngine: DEFAULT_NARRATION_ENGINE,
  voiceURI: "",
  offlineVoice: "af_heart",
  azureVoice: "en-US-AvaMultilingualNeural",
};

const AZURE_VOICES: AzureVoiceOption[] = [
  {
    value: "en-US-AvaMultilingualNeural",
    label: "Ava",
    description: "US English · warm",
  },
  {
    value: "en-US-AndrewMultilingualNeural",
    label: "Andrew",
    description: "US English · calm",
  },
  {
    value: "en-GB-SoniaNeural",
    label: "Sonia",
    description: "UK English · clear",
  },
  {
    value: "en-GB-RyanNeural",
    label: "Ryan",
    description: "UK English · steady",
  },
];

const AZURE_SPEECH_CHUNK_CHARACTERS = 700;
const OFFLINE_PACK_SIZE_LABEL = `${Math.round(
  OFFLINE_PACK_BYTES / 1_000_000,
)} MB`;

const WORD_PATTERN = /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*|[^\s]/gu;
const IS_WORD = /^[\p{L}\p{N}]/u;
function buildDocumentModel(paragraphs: string[]): DocumentModel {
  const fullText = paragraphs.join("\n\n");
  const tokens: WordToken[] = [];
  const renderedParagraphs: Segment[][] = [];
  let documentOffset = 0;
  let sentenceIndex = 0;

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const segments: Segment[] = [];
    let previousEnd = 0;

    for (const match of paragraph.matchAll(WORD_PATTERN)) {
      const localStart = match.index ?? 0;
      const text = match[0];
      const isWord = IS_WORD.test(text);
      const nearbyTokenIndex = isWord
        ? tokens.length
        : Math.max(0, tokens.length - 1);
      if (localStart > previousEnd) {
        segments.push({
          text: paragraph.slice(previousEnd, localStart),
          focusTokenIndex: nearbyTokenIndex,
          sentenceIndex,
        });
      }

      if (isWord) {
        const tokenIndex = tokens.length;
        const start = documentOffset + localStart;
        tokens.push({
          index: tokenIndex,
          text,
          start,
          end: start + text.length,
          paragraphIndex,
          sentenceIndex,
        });
        segments.push({
          text,
          tokenIndex,
          focusTokenIndex: tokenIndex,
          sentenceIndex,
        });
      } else {
        segments.push({
          text,
          focusTokenIndex: nearbyTokenIndex,
          sentenceIndex,
        });
      }

      if (/[.!?]/.test(text)) sentenceIndex += 1;
      previousEnd = localStart + text.length;
    }

    if (previousEnd < paragraph.length) {
      segments.push({
        text: paragraph.slice(previousEnd),
        focusTokenIndex: Math.max(0, tokens.length - 1),
        sentenceIndex,
      });
    }

    renderedParagraphs.push(segments);
    documentOffset +=
      paragraph.length + (paragraphIndex < paragraphs.length - 1 ? 2 : 0);
  });

  return { fullText, tokens, paragraphs: renderedParagraphs };
}

function findWordAtCharacter(tokens: WordToken[], character: number) {
  let low = 0;
  let high = tokens.length - 1;
  let best = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (tokens[middle].start <= character) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (tokens[best]?.end <= character && tokens[best + 1]) return best + 1;
  return best;
}

function cleanText(value: string) {
  return value
    .replace(/\u00ad/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function filenameWithoutExtension(name: string) {
  return name.replace(/\.[^.]+$/, "");
}

function countWords(value: string) {
  let count = 0;
  for (const match of value.matchAll(WORD_PATTERN)) {
    if (IS_WORD.test(match[0])) count += 1;
  }
  return count;
}

async function parsePdf(file: File): Promise<ReaderDocument> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const sourceData = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: sourceData.slice() }).promise;
  const paragraphs: string[] = [];
  const pdfPages: PdfPageLayout[] = [];
  let globalWordCount = 0;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    let pageText = "";
    const items: PdfPageLayout["items"] = [];

    content.items.forEach((item) => {
      if (!("str" in item)) return;
      const itemWordCount = countWords(item.str);
      const transformed = pdfjs.Util.transform(
        viewport.transform,
        item.transform,
      );
      const fontSize = Math.max(1, Math.hypot(transformed[2], transformed[3]));
      const textStyle = content.styles[item.fontName];
      const ascent =
        textStyle?.ascent ??
        (textStyle?.descent ? 1 + textStyle.descent : 0.82);
      const angle =
        (Math.atan2(transformed[1], transformed[0]) * 180) / Math.PI;

      if (item.str && itemWordCount) {
        items.push({
          text: item.str,
          left: transformed[4],
          top: transformed[5] - fontSize * ascent,
          width: Math.max(Math.abs(item.width * viewport.scale), 1),
          height: fontSize,
          fontSize,
          angle,
          wordStart: globalWordCount,
          wordCount: itemWordCount,
        });
      }
      globalWordCount += itemWordCount;
      pageText += item.str;
      pageText += "hasEOL" in item && item.hasEOL ? "\n" : " ";
    });

    pdfPages.push({
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      items,
    });

    const cleaned = cleanText(pageText);
    if (cleaned) {
      const pageParagraphs = cleaned
        .split(/\n{2,}|\n(?=[A-Z0-9“"'])/)
        .map(cleanText)
        .filter(Boolean);
      paragraphs.push(...(pageParagraphs.length ? pageParagraphs : [cleaned]));
    }
  }

  const wordCount = countWords(paragraphs.join(" "));
  if (wordCount < 8) {
    await pdf.destroy();
    throw new Error(
      "This PDF looks like a scan and has very little selectable text. OCR support is planned for the next version.",
    );
  }

  const pageCount = pdf.numPages;
  await pdf.destroy();
  return {
    id: `pdf-${Date.now()}`,
    title: filenameWithoutExtension(file.name),
    author: `${pageCount} page PDF`,
    kind: "pdf",
    paragraphs,
    pdfData: sourceData,
    pdfPages,
  };
}

function resolveZipPath(basePath: string, target: string) {
  const parts = `${basePath}/${target}`.split("/");
  const resolved: string[] = [];
  parts.forEach((part) => {
    if (!part || part === ".") return;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  });
  return resolved.join("/");
}

async function parseEpub(file: File): Promise<ReaderDocument> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const container = await zip.file("META-INF/container.xml")?.async("string");

  if (!container) throw new Error("This EPUB is missing its book manifest.");

  const parser = new DOMParser();
  const containerXml = parser.parseFromString(container, "application/xml");
  const rootfile = containerXml
    .querySelector("rootfile")
    ?.getAttribute("full-path");
  if (!rootfile) throw new Error("The EPUB reading order could not be found.");

  const packageText = await zip.file(rootfile)?.async("string");
  if (!packageText) throw new Error("The EPUB package could not be opened.");

  const packageXml = parser.parseFromString(packageText, "application/xml");
  const basePath = rootfile.includes("/")
    ? rootfile.slice(0, rootfile.lastIndexOf("/"))
    : "";
  const manifest = new Map<string, string>();
  packageXml.querySelectorAll("manifest item").forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest.set(id, resolveZipPath(basePath, decodeURI(href)));
  });

  const paragraphs: string[] = [];
  const spineIds = Array.from(packageXml.querySelectorAll("spine itemref"))
    .map((item) => item.getAttribute("idref"))
    .filter((value): value is string => Boolean(value));

  for (const id of spineIds) {
    const path = manifest.get(id);
    if (!path) continue;
    const chapterText = await zip.file(path)?.async("string");
    if (!chapterText) continue;
    const chapter = parser.parseFromString(
      chapterText,
      "application/xhtml+xml",
    );
    chapter
      .querySelectorAll("script, style, nav, svg")
      .forEach((element) => element.remove());
    const blocks = Array.from(
      chapter.querySelectorAll("h1, h2, h3, h4, p, blockquote, li"),
    )
      .map((element) => cleanText(element.textContent ?? ""))
      .filter((text) => text.length > 0);
    paragraphs.push(...blocks);
  }

  if (!paragraphs.length) {
    throw new Error("No readable text was found in this EPUB.");
  }

  const title =
    cleanText(
      packageXml.querySelector("metadata title, dc\\:title")?.textContent ?? "",
    ) || filenameWithoutExtension(file.name);
  const author =
    cleanText(
      packageXml.querySelector("metadata creator, dc\\:creator")?.textContent ??
        "",
    ) || "EPUB book";

  return {
    id: `epub-${Date.now()}`,
    title,
    author,
    kind: "epub",
    paragraphs,
  };
}

async function parseText(file: File): Promise<ReaderDocument> {
  const text = cleanText(await file.text());
  if (!text) throw new Error("This text file is empty.");
  return {
    id: `txt-${Date.now()}`,
    title: filenameWithoutExtension(file.name),
    author: "Text document",
    kind: "txt",
    paragraphs: text
      .split(/\n{2,}/)
      .map(cleanText)
      .filter(Boolean),
  };
}

function formatTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function storedProgressFor(documentId: string) {
  try {
    const stored = localStorage.getItem(`guided-reader-progress-${documentId}`);
    if (stored === null) return null;
    const progress = Number(stored);
    return Number.isFinite(progress) ? Math.max(0, progress) : null;
  } catch {
    return null;
  }
}

function initialViewFor(document: ReaderDocument): ReaderViewMode {
  if (
    document.kind !== "pdf" ||
    !document.pdfData?.length ||
    !document.pdfPages?.length
  ) {
    return "focus";
  }

  try {
    return localStorage.getItem(`guided-reader-view-${document.id}`) === "focus"
      ? "focus"
      : "page";
  } catch {
    return "page";
  }
}

function clampStoredProgress(document: ReaderDocument) {
  const storedProgress = storedProgressFor(document.id) ?? 0;
  return Math.min(
    storedProgress,
    Math.max(0, countDocumentWords(document) - 1),
  );
}

function isStoredReaderPosition(value: unknown): value is StoredReaderPosition {
  if (!value || typeof value !== "object") return false;
  const position = value as Partial<StoredReaderPosition>;
  return (
    Number.isFinite(position.tokenIndex) &&
    typeof position.anchorText === "string" &&
    Array.isArray(position.contextBefore) &&
    Array.isArray(position.contextAfter) &&
    typeof position.snippet === "string" &&
    Number.isFinite(position.createdAt)
  );
}

function cleanNavigationState(value: unknown): ReaderNavigationState {
  if (!value || typeof value !== "object") {
    return { version: 1, bookmarks: [], history: [] };
  }
  const navigation = value as Partial<ReaderNavigationState>;
  return {
    version: 1,
    bookmarks: Array.isArray(navigation.bookmarks)
      ? navigation.bookmarks.filter(
          (bookmark): bookmark is ReaderBookmark =>
            isStoredReaderPosition(bookmark) &&
            typeof bookmark.id === "string" &&
            typeof bookmark.name === "string" &&
            Boolean(bookmark.name.trim()),
        )
      : [],
    history: Array.isArray(navigation.history)
      ? navigation.history
          .filter(isStoredReaderPosition)
          .slice(-MAX_POSITION_HISTORY)
      : [],
  };
}

export default function Home() {
  const [readerDocument, setReaderDocument] =
    useState<ReaderDocument>(DEMO_DOCUMENT);
  const [libraryEntries, setLibraryEntries] = useState<LibraryEntry[]>([]);
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryReady, setLibraryReady] = useState(false);
  const [libraryBusyId, setLibraryBusyId] = useState<string | null>(null);
  const [renamingDocumentId, setRenamingDocumentId] = useState<string | null>(
    null,
  );
  const [renameDraft, setRenameDraft] = useState("");
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [readerLayoutRevision, setReaderLayoutRevision] = useState(0);
  const [viewMode, setViewMode] = useState<ReaderViewMode>("focus");
  const [activeWord, setActiveWord] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPreparingSpeech, setIsPreparingSpeech] = useState(false);
  const [followPaused, setFollowPaused] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [offlinePackState, setOfflinePackState] =
    useState<OfflinePackState>("checking");
  const [offlineInstallProgress, setOfflineInstallProgress] = useState(0);
  const [offlineInstallLabel, setOfflineInstallLabel] = useState(
    "Checking the included voice…",
  );
  const [offlineRuntimeInfo, setOfflineRuntimeInfo] =
    useState<OfflineRuntimeInfo | null>(null);
  const [settingsRestored, setSettingsRestored] = useState(false);
  const [bookmarks, setBookmarks] = useState<ReaderBookmark[]>([]);
  const [positionHistory, setPositionHistory] = useState<
    StoredReaderPosition[]
  >([]);
  const [navigationReady, setNavigationReady] = useState(false);
  const [bookmarkName, setBookmarkName] = useState("");
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(
    null,
  );
  const [bookmarkRenameDraft, setBookmarkRenameDraft] = useState("");
  const [documentSearch, setDocumentSearch] = useState("");
  const speechAvailable =
    typeof window === "undefined" ||
    ("speechSynthesis" in window && "SpeechSynthesisUtterance" in window);

  const model = useMemo(
    () => buildDocumentModel(readerDocument.paragraphs),
    [readerDocument],
  );
  const activeToken = model.tokens[activeWord] ?? model.tokens[0];
  const activeSentence = activeToken?.sentenceIndex ?? 0;
  const tokenSentences = useMemo(
    () => model.tokens.map((token) => token.sentenceIndex),
    [model.tokens],
  );
  const visibleLibraryEntries = useMemo(
    () => filterLibraryEntries(libraryEntries, librarySearch) as LibraryEntry[],
    [libraryEntries, librarySearch],
  );
  const sentenceStarts = useMemo(
    () => buildSentenceStartIndices(model.tokens),
    [model.tokens],
  );
  const bookmarkRows = useMemo(
    () =>
      bookmarks.map((bookmark) => ({
        bookmark,
        resolvedIndex: resolveStoredPosition(bookmark, model.tokens),
      })),
    [bookmarks, model.tokens],
  );
  const documentSearchMatches = useMemo(
    () =>
      findDocumentMatches(
        model.tokens,
        model.fullText,
        documentSearch,
      ) as StoredReaderPosition[],
    [documentSearch, model.fullText, model.tokens],
  );
  const currentPosition = useMemo(
    () =>
      createPositionSnapshot(
        model.tokens,
        activeWord,
        0,
      ) as StoredReaderPosition | null,
    [activeWord, model.tokens],
  );
  const supportsPageView =
    readerDocument.kind === "pdf" &&
    Boolean(readerDocument.pdfData?.length && readerDocument.pdfPages?.length);
  const progress = model.tokens.length
    ? Math.round(((activeWord + 1) / model.tokens.length) * 100)
    : 0;
  const remainingSeconds =
    ((model.tokens.length - activeWord) / (180 * settings.rate)) * 60;

  const readerRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<Map<number, HTMLSpanElement>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const speechOffsetRef = useRef(0);
  const boundarySeenRef = useRef(false);
  const fallbackTimerRef = useRef<number | null>(null);
  const speechStartTimerRef = useRef<number | null>(null);
  const bufferedAudioRef = useRef<HTMLAudioElement | null>(null);
  const bufferedSeekStateRef = useRef<BufferedSeekState | null>(null);
  const bufferedAudioUrlsRef = useRef<Map<HTMLAudioElement, string>>(new Map());
  const bufferedAnimationFrameRef = useRef<number | null>(null);
  const bufferedAbortRef = useRef<AbortController | null>(null);
  const bufferedPrefetchDisposeRef = useRef<(() => void) | null>(null);
  const speechSessionRef = useRef(0);
  const automaticOfflineInstallAttemptedRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const activeWordRef = useRef(0);
  const bookmarksRef = useRef<ReaderBookmark[]>([]);
  const positionHistoryRef = useRef<StoredReaderPosition[]>([]);
  const navigationSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    activeWordRef.current = activeWord;
  }, [activeWord]);

  useEffect(() => {
    const container = readerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    let cancelled = false;
    const refreshLayout = () => {
      if (!cancelled) setReaderLayoutRevision((current) => current + 1);
    };
    const observer = new ResizeObserver(refreshLayout);
    observer.observe(container);
    window.addEventListener("resize", refreshLayout);
    void document.fonts?.ready.then(refreshLayout);

    return () => {
      cancelled = true;
      observer.disconnect();
      window.removeEventListener("resize", refreshLayout);
    };
  }, []);

  useLayoutEffect(() => {
    const readingPage =
      readerRef.current?.querySelector<HTMLElement>(".reading-page");
    if (!readingPage) return;
    const focusSegments =
      readingPage.querySelectorAll<HTMLElement>("[data-focus-token]");

    if (viewMode !== "focus" || settings.focusLines === 0) {
      focusSegments.forEach((element) =>
        element.classList.remove("focus-window-visible"),
      );
      return;
    }

    const tokenPositions = Array.from(wordRefs.current.entries())
      .filter(([, element]) => readingPage.contains(element))
      .map(([tokenIndex, element]) => ({
        tokenIndex,
        top: element.getBoundingClientRect().top,
      }));
    const visibleTokens = new Set(
      selectFocusWindowTokens(
        tokenPositions,
        activeWord,
        settings.focusLines,
      ),
    );
    if (!visibleTokens.size) visibleTokens.add(activeWord);

    focusSegments.forEach((element) => {
      const tokenIndex = Number(element.dataset.focusToken);
      element.classList.toggle(
        "focus-window-visible",
        visibleTokens.has(tokenIndex),
      );
    });
  }, [
    activeWord,
    model.tokens.length,
    readerDocument.id,
    readerLayoutRevision,
    settings.focusLines,
    settings.font,
    settings.fontSize,
    settings.letterSpacing,
    settings.lineHeight,
    settings.maxLineWidth,
    settings.paragraphSpacing,
    settings.wordSpacing,
    viewMode,
  ]);

  useEffect(() => {
    let cancelled = false;
    bookmarksRef.current = [];
    positionHistoryRef.current = [];

    const loadNavigation = async () => {
      await Promise.resolve();
      if (cancelled) return;
      setNavigationReady(false);
      setBookmarks([]);
      setPositionHistory([]);
      setBookmarkName("");
      setEditingBookmarkId(null);
      setBookmarkRenameDraft("");
      setDocumentSearch("");

      try {
        const savedNavigation = await getReaderNavigation(readerDocument.id);
        if (cancelled) return;
        const navigation = cleanNavigationState(savedNavigation);
        bookmarksRef.current = navigation.bookmarks;
        positionHistoryRef.current = navigation.history;
        setBookmarks(navigation.bookmarks);
        setPositionHistory(navigation.history);
      } catch {
        if (!cancelled) {
          setNotice(
            "Saved bookmarks could not be opened. Reading can continue without them.",
          );
        }
      } finally {
        if (!cancelled) setNavigationReady(true);
      }
    };
    void loadNavigation();

    return () => {
      cancelled = true;
    };
  }, [readerDocument.id]);

  useEffect(() => {
    let restoreTimer: number | undefined;
    let cancelled = false;
    try {
      const savedSettings = localStorage.getItem("guided-reader-settings");
      const savedProgress = localStorage.getItem(
        `guided-reader-progress-${DEMO_DOCUMENT.id}`,
      );
      restoreTimer = window.setTimeout(() => {
        if (cancelled) return;
        try {
          if (savedSettings) {
            const storedSettings = JSON.parse(
              savedSettings,
            ) as Partial<ReaderSettings>;
            const storedLayout = normalizeReaderLayout(storedSettings);
            setSettings((current) => ({
              ...current,
              ...storedSettings,
              ...storedLayout,
              focusLines: storedLayout.focusLines as FocusLineCount,
            }));
          }
        } catch {
          // Invalid saved preferences should not block the included voice.
        }
        if (savedProgress) setActiveWord(Number(savedProgress) || 0);
        setSettingsRestored(true);
      }, 0);
    } catch {
      // Local storage is optional; the reader still works without it.
      restoreTimer = window.setTimeout(() => {
        if (!cancelled) setSettingsRestored(true);
      }, 0);
    }

    loadReaderLibrary()
      .then(async (snapshot) => {
        if (cancelled) return;
        setLibraryEntries(snapshot.entries as LibraryEntry[]);
        if (!snapshot.activeDocumentId) return;
        const storedDocument = (await getReaderDocument(
          snapshot.activeDocumentId,
        )) as ReaderDocument | null;
        if (!storedDocument || cancelled) return;
        const storedProgress = clampStoredProgress(storedDocument);
        setReaderDocument(storedDocument);
        setActiveWord(storedProgress);
        activeWordRef.current = storedProgress;
        setViewMode(initialViewFor(storedDocument));
      })
      .catch(() => {
        if (!cancelled) {
          setNotice(
            "LineLight could not open the private library. The starter document is still available.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLibraryReady(true);
      });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    isOfflineVoicePackInstalled()
      .then((installed) => {
        if (!cancelled) {
          setOfflinePackState(installed ? "ready" : "missing");
        }
      })
      .catch(() => {
        if (!cancelled) setOfflinePackState("missing");
      });

    return () => {
      cancelled = true;
      if (restoreTimer) window.clearTimeout(restoreTimer);
      disposeOfflineSpeechWorker();
    };
  }, []);

  useEffect(() => {
    if (!settingsRestored) return;
    try {
      localStorage.setItem("guided-reader-settings", JSON.stringify(settings));
    } catch {
      // Ignore private-browsing storage limitations.
    }
  }, [settings, settingsRestored]);

  useEffect(() => {
    try {
      localStorage.setItem(
        `guided-reader-progress-${readerDocument.id}`,
        String(activeWord),
      );
    } catch {
      // Ignore private-browsing storage limitations.
    }
  }, [activeWord, readerDocument.id]);

  useEffect(() => {
    try {
      localStorage.setItem(`guided-reader-view-${readerDocument.id}`, viewMode);
    } catch {
      // View preference is optional.
    }
  }, [readerDocument.id, viewMode]);

  useEffect(() => {
    if (!speechAvailable) return;

    const loadVoices = () => setVoices(window.speechSynthesis.getVoices());
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
    };
  }, [speechAvailable]);

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current) {
      window.clearInterval(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  const clearSpeechStartTimer = useCallback(() => {
    if (speechStartTimerRef.current) {
      window.clearTimeout(speechStartTimerRef.current);
      speechStartTimerRef.current = null;
    }
  }, []);

  const releaseBufferedAudio = useCallback((audio: HTMLAudioElement) => {
    audio.onplay = null;
    audio.onpause = null;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();

    const audioUrl = bufferedAudioUrlsRef.current.get(audio);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    bufferedAudioUrlsRef.current.delete(audio);
    if (bufferedAudioRef.current === audio) {
      bufferedAudioRef.current = null;
    }
    if (bufferedSeekStateRef.current?.audio === audio) {
      bufferedSeekStateRef.current = null;
    }
  }, []);

  const clearBufferedPlayback = useCallback(() => {
    bufferedPrefetchDisposeRef.current?.();
    bufferedPrefetchDisposeRef.current = null;
    bufferedAbortRef.current?.abort();
    bufferedAbortRef.current = null;

    if (bufferedAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(bufferedAnimationFrameRef.current);
      bufferedAnimationFrameRef.current = null;
    }

    for (const audio of Array.from(bufferedAudioUrlsRef.current.keys())) {
      releaseBufferedAudio(audio);
    }
    bufferedAudioRef.current = null;
    bufferedSeekStateRef.current = null;
  }, [releaseBufferedAudio]);

  const stopSpeech = useCallback(() => {
    speechSessionRef.current += 1;
    clearSpeechStartTimer();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    clearFallbackTimer();
    clearBufferedPlayback();
    utteranceRef.current = null;
    setIsPlaying(false);
    setIsPreparingSpeech(false);
  }, [clearBufferedPlayback, clearFallbackTimer, clearSpeechStartTimer]);

  useEffect(() => stopSpeech, [stopSpeech]);

  const downloadOfflineVoice = useCallback(
    async (automatic = false) => {
      if (offlinePackState === "installing") return;

      stopSpeech();
      setOfflinePackState("installing");
      setOfflineInstallProgress(0);
      setOfflineInstallLabel("Preparing LineLight's included offline voice…");
      setNotice(
        automatic
          ? "Preparing LineLight's included offline voice in the background…"
          : "",
      );

      try {
        await navigator.storage?.persist?.().catch(() => false);
        await installOfflineVoicePack({
          onProgress: ({ progress, label }) => {
            setOfflineInstallProgress(progress);
            setOfflineInstallLabel(label);
          },
        });

        if (!(await isOfflineVoicePackInstalled())) {
          throw new OfflineSpeechError(
            "The included voice finished loading, but the browser did not keep every file. Check storage permissions and try again.",
          );
        }

        setOfflinePackState("ready");
        setOfflineInstallProgress(100);
        setOfflineInstallLabel("The included offline voices are ready.");
        setNotice(
          "LineLight's included natural voice is ready. Narration text now stays on this device.",
        );
      } catch (error) {
        setOfflinePackState("error");
        const message =
          error instanceof Error
            ? error.message
            : "The included offline voice could not be prepared.";
        const displayMessage = automatic
          ? "The included offline voice is not available yet. Reconnect and select Offline natural to try again."
          : message;
        setOfflineInstallLabel(displayMessage);
        if (automatic && speechAvailable) {
          setSettings((current) =>
            current.narrationEngine === "offline"
              ? { ...current, narrationEngine: "device" }
              : current,
          );
          setNotice(`${displayMessage} Using the device voice instead.`);
        } else {
          setNotice(displayMessage);
        }
      }
    },
    [offlinePackState, speechAvailable, stopSpeech],
  );

  useEffect(() => {
    if (
      !settingsRestored ||
      settings.narrationEngine !== "offline" ||
      offlinePackState !== "missing" ||
      automaticOfflineInstallAttemptedRef.current
    ) {
      return;
    }

    automaticOfflineInstallAttemptedRef.current = true;
    void downloadOfflineVoice(true);
  }, [
    downloadOfflineVoice,
    offlinePackState,
    settings.narrationEngine,
    settingsRestored,
  ]);

  const deleteOfflineVoice = useCallback(async () => {
    stopSpeech();
    setOfflinePackState("removing");
    setOfflineInstallLabel("Removing the included offline voice…");

    try {
      await removeOfflineVoicePack();
      setOfflinePackState("missing");
      setOfflineRuntimeInfo(null);
      setOfflineInstallProgress(0);
      setOfflineInstallLabel("Included offline voice removed.");
      setSettings((current) =>
        current.narrationEngine === "offline"
          ? { ...current, narrationEngine: "device" }
          : current,
      );
      setNotice(
        "The included offline voice was removed. Select Offline natural to restore it at any time.",
      );
    } catch {
      setOfflinePackState("error");
      setOfflineInstallLabel(
        "The browser could not remove every offline voice file.",
      );
    }
  }, [stopSpeech]);

  const scrollToActiveWord = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const word = wordRefs.current.get(activeWordRef.current);
      if (!word) return;
      programmaticScrollRef.current = true;
      word.scrollIntoView({ behavior, block: "center", inline: "nearest" });
      window.setTimeout(
        () => {
          programmaticScrollRef.current = false;
        },
        behavior === "smooth" ? 700 : 80,
      );
    },
    [],
  );

  const queueNavigationSave = useCallback(
    (
      documentId: string,
      nextBookmarks: ReaderBookmark[],
      nextHistory: StoredReaderPosition[],
    ) => {
      navigationSaveQueueRef.current = navigationSaveQueueRef.current
        .catch(() => undefined)
        .then(() =>
          saveReaderNavigation(documentId, {
            version: 1,
            bookmarks: nextBookmarks,
            history: nextHistory,
          }),
        )
        .catch(() => {
          setNotice(
            "This bookmark change could not be saved. Close other LineLight tabs and try again.",
          );
        });
    },
    [],
  );

  const commitNavigation = useCallback(
    (nextBookmarks: ReaderBookmark[], nextHistory: StoredReaderPosition[]) => {
      bookmarksRef.current = nextBookmarks;
      positionHistoryRef.current = nextHistory;
      setBookmarks(nextBookmarks);
      setPositionHistory(nextHistory);
      queueNavigationSave(readerDocument.id, nextBookmarks, nextHistory);
    },
    [queueNavigationSave, readerDocument.id],
  );

  const jumpToPosition = useCallback(
    (
      targetIndex: number,
      { recordHistory = true, closePanel = false } = {},
    ) => {
      if (!model.tokens.length) return false;
      const safeIndex = Math.min(
        Math.max(0, Math.trunc(targetIndex)),
        model.tokens.length - 1,
      );
      const currentIndex = activeWordRef.current;
      if (
        recordHistory &&
        isMeaningfulPositionJump(currentIndex, safeIndex, model.tokens.length)
      ) {
        const departure = createPositionSnapshot(
          model.tokens,
          currentIndex,
        ) as StoredReaderPosition | null;
        if (departure) {
          const nextHistory = pushPositionHistory(
            positionHistoryRef.current,
            departure,
          ) as StoredReaderPosition[];
          commitNavigation(bookmarksRef.current, nextHistory);
        }
      }

      stopSpeech();
      setActiveWord(safeIndex);
      activeWordRef.current = safeIndex;
      setFollowPaused(false);
      if (closePanel) setShowBookmarks(false);
      window.setTimeout(() => scrollToActiveWord("smooth"), 0);
      return true;
    },
    [commitNavigation, model.tokens, scrollToActiveWord, stopSpeech],
  );

  const openStoredPosition = useCallback(
    (position: StoredReaderPosition, label: string) => {
      const targetIndex = resolveStoredPosition(position, model.tokens);
      if (targetIndex === null) {
        setNotice(
          `${label} could not be matched safely in the current document.`,
        );
        return;
      }
      jumpToPosition(targetIndex, { closePanel: true });
      setNotice(`${label} opened. Press Play to narrate from here.`);
    },
    [jumpToPosition, model.tokens],
  );

  const backToPreviousPosition = useCallback(() => {
    const nextHistory = [...positionHistoryRef.current];
    let previousPosition: StoredReaderPosition | undefined;
    let targetIndex: number | null = null;
    while (nextHistory.length && targetIndex === null) {
      previousPosition = nextHistory.pop();
      targetIndex = previousPosition
        ? resolveStoredPosition(previousPosition, model.tokens)
        : null;
    }
    commitNavigation(bookmarksRef.current, nextHistory);
    if (targetIndex === null) {
      setNotice("No earlier saved position could be matched in this document.");
      return;
    }
    jumpToPosition(targetIndex, { recordHistory: false, closePanel: true });
    setNotice(
      "Returned to the previous position. Press Play to narrate from here.",
    );
  }, [commitNavigation, jumpToPosition, model.tokens]);

  const addBookmark = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const normalizedName = bookmarkName.trim();
      if (!normalizedName) {
        setNotice("Enter a name for this bookmark.");
        return;
      }
      const position = createPositionSnapshot(
        model.tokens,
        activeWordRef.current,
      ) as StoredReaderPosition | null;
      if (!position) return;
      const id =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const nextBookmarks = [
        ...bookmarksRef.current,
        { ...position, id, name: normalizedName },
      ];
      commitNavigation(nextBookmarks, positionHistoryRef.current);
      setBookmarkName("");
      setNotice(`Saved bookmark “${normalizedName}” on this device.`);
    },
    [bookmarkName, commitNavigation, model.tokens],
  );

  const renameBookmark = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!editingBookmarkId) return;
      const normalizedName = bookmarkRenameDraft.trim();
      if (!normalizedName) {
        setNotice("Enter a name for this bookmark.");
        return;
      }
      const nextBookmarks = bookmarksRef.current.map((bookmark) =>
        bookmark.id === editingBookmarkId
          ? { ...bookmark, name: normalizedName }
          : bookmark,
      );
      commitNavigation(nextBookmarks, positionHistoryRef.current);
      setEditingBookmarkId(null);
      setBookmarkRenameDraft("");
      setNotice(`Renamed bookmark to “${normalizedName}”.`);
    },
    [bookmarkRenameDraft, commitNavigation, editingBookmarkId],
  );

  const removeBookmark = useCallback(
    (bookmark: ReaderBookmark) => {
      const nextBookmarks = bookmarksRef.current.filter(
        (candidate) => candidate.id !== bookmark.id,
      );
      commitNavigation(nextBookmarks, positionHistoryRef.current);
      if (editingBookmarkId === bookmark.id) {
        setEditingBookmarkId(null);
        setBookmarkRenameDraft("");
      }
      setNotice(`Removed bookmark “${bookmark.name}”.`);
    },
    [commitNavigation, editingBookmarkId],
  );

  useEffect(() => {
    if (!settings.follow || followPaused || !isPlaying) return;
    const word = wordRefs.current.get(activeWord);
    const container = readerRef.current;
    if (!word || !container) return;
    const wordRect = word.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const safeTop = containerRect.top + containerRect.height * 0.35;
    const safeBottom = containerRect.top + containerRect.height * 0.65;
    if (wordRect.top < safeTop || wordRect.bottom > safeBottom) {
      scrollToActiveWord("smooth");
    }
  }, [
    activeWord,
    followPaused,
    isPlaying,
    scrollToActiveWord,
    settings.follow,
  ]);

  const startDeviceSpeech = useCallback(
    (
      startIndex = activeWordRef.current,
      preserveInitialNotice = false,
      fallbackContext = "",
    ) => {
      if (!speechAvailable || !model.tokens.length) {
        setNotice(
          "Narration is not available in this browser. Safari on iPhone and Chrome on desktop are supported.",
        );
        return;
      }

      const safeIndex = Math.min(
        Math.max(0, startIndex),
        model.tokens.length - 1,
      );
      const sessionId = speechSessionRef.current + 1;
      speechSessionRef.current = sessionId;
      window.speechSynthesis.cancel();
      clearBufferedPlayback();
      clearSpeechStartTimer();
      clearFallbackTimer();
      setIsPreparingSpeech(false);
      setActiveWord(safeIndex);
      activeWordRef.current = safeIndex;
      const selectedVoice = voices.find(
        (voice) => voice.voiceURI === settings.voiceURI,
      );
      const initialVoiceURI = selectedVoice?.voiceURI ?? "";

      if (settings.voiceURI && !selectedVoice) {
        setSettings((current) => ({ ...current, voiceURI: "" }));
      }

      function scheduleChunk(
        chunkStartIndex: number,
        voiceURI: string,
        retryCount: number,
        preserveNotice: boolean,
        delay: number,
      ) {
        if (speechSessionRef.current !== sessionId) return;
        clearSpeechStartTimer();
        speechStartTimerRef.current = window.setTimeout(() => {
          speechStartTimerRef.current = null;
          speakChunk(chunkStartIndex, voiceURI, retryCount, preserveNotice);
        }, delay);
      }

      function speakChunk(
        chunkStartIndex: number,
        voiceURI: string,
        retryCount: number,
        preserveNotice: boolean,
      ) {
        if (speechSessionRef.current !== sessionId) return;

        const chunk = buildSpeechChunk(
          model.fullText,
          model.tokens,
          chunkStartIndex,
        );
        if (!chunk) {
          setIsPlaying(false);
          return;
        }

        const utterance = new SpeechSynthesisUtterance(chunk.text);
        utterance.rate = settings.rate;
        utterance.pitch = 1;
        const voice = voices.find(
          (candidate) => candidate.voiceURI === voiceURI,
        );
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }

        speechOffsetRef.current = chunk.startChar;
        boundarySeenRef.current = false;
        utteranceRef.current = utterance;

        utterance.onstart = () => {
          if (speechSessionRef.current !== sessionId) return;
          setIsPlaying(true);
          if (!preserveNotice) setNotice("");
        };
        utterance.onboundary = (event) => {
          if (speechSessionRef.current !== sessionId) return;
          if (event.name && event.name !== "word") return;
          boundarySeenRef.current = true;
          const nextWord = findWordAtCharacter(
            model.tokens,
            speechOffsetRef.current + event.charIndex,
          );
          activeWordRef.current = nextWord;
          setActiveWord(nextWord);
        };
        utterance.onend = () => {
          clearFallbackTimer();
          if (speechSessionRef.current !== sessionId) return;
          utteranceRef.current = null;

          if (chunk.nextIndex < model.tokens.length) {
            activeWordRef.current = chunk.nextIndex;
            setActiveWord(chunk.nextIndex);
            scheduleChunk(chunk.nextIndex, voiceURI, 0, false, 45);
            return;
          }

          setIsPlaying(false);
        };
        utterance.onerror = (event) => {
          clearFallbackTimer();
          if (speechSessionRef.current !== sessionId) return;
          utteranceRef.current = null;

          if (event.error === "canceled") {
            setIsPlaying(false);
            return;
          }

          const resumeIndex = Math.max(chunk.startIndex, activeWordRef.current);

          if (voiceURI) {
            setSettings((current) =>
              current.voiceURI === voiceURI
                ? { ...current, voiceURI: "" }
                : current,
            );
            setNotice(
              [
                fallbackContext,
                `${voice?.name ?? "The selected voice"} failed in Brave. Continuing with System default.`,
              ]
                .filter(Boolean)
                .join(" "),
            );
            scheduleChunk(resumeIndex, "", 0, true, 180);
            return;
          }

          if (isRetryableSpeechError(event.error) && retryCount < 1) {
            setNotice(
              [
                fallbackContext,
                "Narration paused briefly while LineLight reconnects to Ubuntu's speech service.",
              ]
                .filter(Boolean)
                .join(" "),
            );
            scheduleChunk(resumeIndex, "", retryCount + 1, true, 350);
            return;
          }

          setIsPlaying(false);
          setNotice(
            [
              fallbackContext,
              speechFailureMessage(event.error, voices.length > 0),
            ]
              .filter(Boolean)
              .join(" "),
          );
        };

        window.speechSynthesis.speak(utterance);

        const interval = Math.max(130, 60_000 / (180 * settings.rate));
        fallbackTimerRef.current = window.setInterval(() => {
          if (boundarySeenRef.current || window.speechSynthesis.paused) return;
          setActiveWord((current) => {
            const next = Math.min(current + 1, chunk.nextIndex - 1);
            activeWordRef.current = next;
            return next;
          });
        }, interval);
      }

      setIsPlaying(true);
      scheduleChunk(safeIndex, initialVoiceURI, 0, preserveInitialNotice, 80);
    },
    [
      clearBufferedPlayback,
      clearFallbackTimer,
      clearSpeechStartTimer,
      model.fullText,
      model.tokens,
      settings.rate,
      settings.voiceURI,
      speechAvailable,
      voices,
    ],
  );

  const startBufferedSpeech = useCallback(
    (
      engine: Exclude<NarrationEngine, "device">,
      startIndex = activeWordRef.current,
    ) => {
      if (!model.tokens.length) return;
      const isOffline = engine === "offline";

      if (isOffline && offlinePackState !== "ready") {
        if (offlinePackState === "missing" || offlinePackState === "error") {
          automaticOfflineInstallAttemptedRef.current = true;
          void downloadOfflineVoice(true);
        }
        setIsPlaying(false);
        setIsPreparingSpeech(false);
        setShowSettings(true);
        setNotice(
          offlinePackState === "installing"
            ? "LineLight is still preparing the included offline voice."
            : "Preparing LineLight's included offline voice before narration starts…",
        );
        return;
      }

      const safeIndex = Math.min(
        Math.max(0, startIndex),
        model.tokens.length - 1,
      );
      const sessionId = speechSessionRef.current + 1;
      speechSessionRef.current = sessionId;

      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      clearSpeechStartTimer();
      clearFallbackTimer();
      clearBufferedPlayback();

      const abortController = new AbortController();
      bufferedAbortRef.current = abortController;

      setActiveWord(safeIndex);
      activeWordRef.current = safeIndex;
      setIsPlaying(false);
      setIsPreparingSpeech(true);
      setNotice(
        isOffline
          ? "Preparing a natural voice on this device…"
          : "Preparing a natural voice…",
      );

      type SpeechChunk = NonNullable<ReturnType<typeof buildSpeechChunk>>;
      type PreparedAudio = {
        audio: HTMLAudioElement;
        synthesis: AzureSpeechResult | OfflineSpeechResult;
      };

      const clearBoundaryAnimation = () => {
        if (bufferedAnimationFrameRef.current !== null) {
          window.cancelAnimationFrame(bufferedAnimationFrameRef.current);
          bufferedAnimationFrameRef.current = null;
        }
      };

      const buildChunk = (chunkStartIndex: number) =>
        buildSpeechChunk(
          model.fullText,
          model.tokens,
          chunkStartIndex,
          isOffline
            ? OFFLINE_SPEECH_CHUNK_CHARACTERS
            : AZURE_SPEECH_CHUNK_CHARACTERS,
        );

      const prepareChunkNow = async (
        chunk: SpeechChunk,
      ): Promise<PreparedAudio> => {
        if (abortController.signal.aborted) {
          throw new DOMException(
            "Speech preparation was canceled.",
            "AbortError",
          );
        }

        const synthesis = isOffline
          ? await synthesizeOfflineSpeech({
              text: chunk.text,
              voice: settings.offlineVoice,
              rate: settings.rate,
              signal: abortController.signal,
            })
          : await synthesizeAzureSpeech({
              text: chunk.text,
              voice: settings.azureVoice,
              signal: abortController.signal,
            });

        if (abortController.signal.aborted) {
          throw new DOMException(
            "Speech preparation was canceled.",
            "AbortError",
          );
        }

        const audio = new Audio();
        const audioUrl = URL.createObjectURL(
          new Blob([synthesis.audioData], {
            type: isOffline ? "audio/wav" : "audio/mpeg",
          }),
        );
        audio.preload = "auto";
        audio.defaultPlaybackRate = isOffline ? 1 : settings.rate;
        audio.playbackRate = isOffline ? 1 : settings.rate;
        bufferedAudioUrlsRef.current.set(audio, audioUrl);
        audio.src = audioUrl;
        audio.load();

        return { audio, synthesis };
      };
      let preparationTail = Promise.resolve();
      const prepareChunk = (chunk: SpeechChunk) => {
        const prepared = preparationTail.then(() => prepareChunkNow(chunk));
        preparationTail = prepared.then(
          () => undefined,
          () => undefined,
        );
        return prepared;
      };

      const continueWithDeviceVoice = (error: unknown, resumeIndex: number) => {
        if (
          speechSessionRef.current !== sessionId ||
          abortController.signal.aborted
        ) {
          return;
        }

        const message = isOffline
          ? error instanceof OfflineSpeechError
            ? error.message
            : "The offline voice could not continue."
          : error instanceof AzureSpeechError
            ? error.message
            : "The natural voice could not continue.";
        clearBufferedPlayback();
        setIsPreparingSpeech(false);
        setIsPlaying(false);

        if (!speechAvailable) {
          setNotice(`${message} No device voice is available as a fallback.`);
          return;
        }

        setNotice(`${message} Continuing with the private device voice.`);
        window.setTimeout(() => {
          if (speechSessionRef.current !== sessionId) return;
          startDeviceSpeech(resumeIndex, true, message);
        }, 120);
      };

      const prefetchQueue = createSpeechPrefetchQueue({
        startIndex: safeIndex,
        endIndex: model.tokens.length,
        lookahead: isOffline ? OFFLINE_SPEECH_LOOKAHEAD_CHUNKS : 1,
        buildChunk,
        getNextIndex: (chunk: SpeechChunk) => chunk.nextIndex,
        prepareChunk,
      });
      const disposePrefetch = () => prefetchQueue.dispose();
      bufferedPrefetchDisposeRef.current = disposePrefetch;

      const finishBufferedSpeech = () => {
        disposePrefetch();
        if (bufferedPrefetchDisposeRef.current === disposePrefetch) {
          bufferedPrefetchDisposeRef.current = null;
        }
        bufferedAudioRef.current = null;
        bufferedAbortRef.current = null;
        setIsPlaying(false);
        setIsPreparingSpeech(false);
      };

      const playPreparedChunk = async (
        chunk: SpeechChunk,
        prepared: PreparedAudio,
      ): Promise<void> => {
        if (
          speechSessionRef.current !== sessionId ||
          abortController.signal.aborted
        ) {
          releaseBufferedAudio(prepared.audio);
          return;
        }

        clearBoundaryAnimation();
        const { audio, synthesis } = prepared;
        bufferedAudioRef.current = audio;
        if (isOffline && "device" in synthesis) {
          setOfflineRuntimeInfo({
            audioDurationSeconds: synthesis.audioDurationSeconds,
            device: synthesis.device,
            synthesisMilliseconds: synthesis.synthesisMilliseconds,
            wasmThreads: synthesis.wasmThreads,
          });
        }
        setActiveWord(chunk.startIndex);
        activeWordRef.current = chunk.startIndex;

        const timedWords = synthesis.boundaries.map((boundary) => ({
          ...boundary,
          tokenIndex: findWordAtCharacter(
            model.tokens,
            chunk.startChar + boundary.textOffset,
          ),
        }));
        bufferedSeekStateRef.current = {
          audio,
          sessionId,
          startIndex: chunk.startIndex,
          nextIndex: chunk.nextIndex,
          boundaries: timedWords,
        };

        const updateBoundary = () => {
          if (
            speechSessionRef.current !== sessionId ||
            audio.paused ||
            audio.ended
          ) {
            bufferedAnimationFrameRef.current = null;
            return;
          }

          const boundaryIndex = findTimedBoundaryIndex(
            timedWords,
            audio.currentTime + 0.025,
          );
          if (boundaryIndex >= 0) {
            const nextWord = timedWords[boundaryIndex].tokenIndex;
            if (nextWord !== activeWordRef.current) {
              activeWordRef.current = nextWord;
              setActiveWord(nextWord);
            }
          }
          bufferedAnimationFrameRef.current =
            window.requestAnimationFrame(updateBoundary);
        };

        audio.onplay = () => {
          if (speechSessionRef.current !== sessionId) return;
          setIsPreparingSpeech(false);
          setIsPlaying(true);
          setNotice("");
          clearBoundaryAnimation();
          bufferedAnimationFrameRef.current =
            window.requestAnimationFrame(updateBoundary);
        };
        audio.onpause = () => {
          clearBoundaryAnimation();
          if (speechSessionRef.current === sessionId && !audio.ended) {
            setIsPlaying(false);
          }
        };
        audio.onerror = () => {
          continueWithDeviceVoice(
            isOffline
              ? new OfflineSpeechError(
                  "The offline voice audio could not be played.",
                )
              : new AzureSpeechError(
                  "The natural voice audio could not be played.",
                  "audio_failed",
                ),
            Math.max(chunk.startIndex, activeWordRef.current),
          );
        };
        audio.onended = async () => {
          clearBoundaryAnimation();
          if (
            speechSessionRef.current !== sessionId ||
            abortController.signal.aborted
          ) {
            return;
          }

          releaseBufferedAudio(audio);
          const nextStatus = prefetchQueue.peekStatus();
          if (!nextStatus) {
            finishBufferedSpeech();
            return;
          }

          if (nextStatus === "pending") {
            setIsPlaying(false);
            setIsPreparingSpeech(true);
            setNotice("Preparing the next passage…");
          }

          try {
            const nextChunk = await prefetchQueue.take();
            if (!nextChunk) {
              finishBufferedSpeech();
              return;
            }
            await playPreparedChunk(nextChunk.chunk, nextChunk.prepared);
          } catch (error) {
            continueWithDeviceVoice(
              error,
              Math.max(chunk.nextIndex, activeWordRef.current),
            );
          }
        };

        try {
          await audio.play();
        } catch (error) {
          if (
            error instanceof DOMException &&
            error.name === "NotAllowedError"
          ) {
            setIsPreparingSpeech(false);
            setIsPlaying(false);
            setNotice(
              "Natural voice is ready. Press Play once more to hear it.",
            );
            return;
          }
          continueWithDeviceVoice(
            error,
            Math.max(chunk.startIndex, activeWordRef.current),
          );
        }
      };

      void prefetchQueue
        .take()
        .then((firstChunk) => {
          if (!firstChunk) {
            throw new OfflineSpeechError("There is no text left to narrate.");
          }
          return playPreparedChunk(firstChunk.chunk, firstChunk.prepared);
        })
        .catch((error: unknown) => {
          continueWithDeviceVoice(error, safeIndex);
        });
    },
    [
      clearBufferedPlayback,
      clearFallbackTimer,
      clearSpeechStartTimer,
      downloadOfflineVoice,
      model.fullText,
      model.tokens,
      offlinePackState,
      releaseBufferedAudio,
      settings.azureVoice,
      settings.offlineVoice,
      settings.rate,
      speechAvailable,
      startDeviceSpeech,
    ],
  );

  const startSpeech = useCallback(
    (startIndex = activeWordRef.current) => {
      if (settings.narrationEngine !== "device") {
        startBufferedSpeech(settings.narrationEngine, startIndex);
        return;
      }
      startDeviceSpeech(startIndex);
    },
    [settings.narrationEngine, startBufferedSpeech, startDeviceSpeech],
  );

  const togglePlayback = useCallback(() => {
    if (isPreparingSpeech) {
      stopSpeech();
      setNotice("Narration stopped.");
      return;
    }

    if (isPlaying) {
      if (bufferedAudioRef.current) {
        bufferedAudioRef.current.pause();
      } else if (speechAvailable) {
        window.speechSynthesis.pause();
      }
      setIsPlaying(false);
      return;
    }

    const bufferedAudio = bufferedAudioRef.current;
    if (
      bufferedAudio &&
      bufferedAudio.src &&
      !bufferedAudio.ended &&
      bufferedAudio.paused
    ) {
      void bufferedAudio.play().catch(() => {
        setNotice(
          "Brave blocked audio playback. Allow sound for this site, then press Play again.",
        );
      });
      return;
    }

    if (utteranceRef.current && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      setIsPlaying(true);
      return;
    }
    startSpeech();
  }, [isPlaying, isPreparingSpeech, speechAvailable, startSpeech, stopSpeech]);

  const moveBySentence = useCallback(
    (direction: -1 | 1) => {
      const targetIndex = findAdjacentSentenceStart(
        sentenceStarts,
        activeWordRef.current,
        direction,
      );
      if (targetIndex === null) return;

      const bufferedSeekState = bufferedSeekStateRef.current;
      if (
        bufferedSeekState &&
        bufferedSeekState.sessionId === speechSessionRef.current &&
        bufferedSeekState.audio === bufferedAudioRef.current
      ) {
        const audioOffset = findBufferedSeekOffset(
          bufferedSeekState,
          targetIndex,
        );
        if (audioOffset !== null) {
          try {
            bufferedSeekState.audio.currentTime = audioOffset;
            setActiveWord(targetIndex);
            activeWordRef.current = targetIndex;
            window.setTimeout(() => scrollToActiveWord("smooth"), 0);
            return;
          } catch {
            // Fall back to stopping and repositioning if media seeking fails.
          }
        }
      }

      stopSpeech();
      setActiveWord(targetIndex);
      activeWordRef.current = targetIndex;
      window.setTimeout(() => scrollToActiveWord("smooth"), 0);
    },
    [scrollToActiveWord, sentenceStarts, stopSpeech],
  );

  const replayUnit = useCallback(
    (unit: "word" | "sentence" | "paragraph") => {
      if (!activeToken) return;
      let target = activeToken.index;
      if (unit === "sentence") {
        target =
          model.tokens.find(
            (token) => token.sentenceIndex === activeToken.sentenceIndex,
          )?.index ?? target;
      }
      if (unit === "paragraph") {
        target =
          model.tokens.find(
            (token) => token.paragraphIndex === activeToken.paragraphIndex,
          )?.index ?? target;
      }
      stopSpeech();
      startSpeech(target);
    },
    [activeToken, model.tokens, startSpeech, stopSpeech],
  );

  const returnToNarration = useCallback(() => {
    setFollowPaused(false);
    scrollToActiveWord("smooth");
  }, [scrollToActiveWord]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "SELECT" ||
        target?.tagName === "TEXTAREA"
      ) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setShowImport(true);
        return;
      }
      if (event.altKey && event.key === "ArrowLeft") {
        if (positionHistoryRef.current.length) {
          event.preventDefault();
          backToPreviousPosition();
        }
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveBySentence(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveBySentence(1);
      } else if (event.key.toLowerCase() === "r") {
        returnToNarration();
      } else if (event.key.toLowerCase() === "f") {
        setSettings((current) => ({ ...current, follow: !current.follow }));
      } else if (event.key === "[") {
        setSettings((current) => ({
          ...current,
          rate: Math.max(0.5, Number((current.rate - 0.1).toFixed(1))),
        }));
      } else if (event.key === "]") {
        setSettings((current) => ({
          ...current,
          rate: Math.min(2, Number((current.rate + 0.1).toFixed(1))),
        }));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    backToPreviousPosition,
    moveBySentence,
    returnToNarration,
    togglePlayback,
  ]);

  const openLibraryDocument = useCallback(
    async (documentId: string) => {
      if (documentId === readerDocument.id) {
        setShowSidebar(false);
        return;
      }

      setLibraryBusyId(documentId);
      setNotice("");
      try {
        const opened = (await openReaderDocument(documentId)) as {
          document: ReaderDocument | null;
          entry: LibraryEntry | null;
        };
        if (!opened.document || !opened.entry) {
          throw new Error("This document is no longer in the library.");
        }

        stopSpeech();
        wordRefs.current.clear();
        const storedProgress = clampStoredProgress(opened.document);
        setReaderDocument(opened.document);
        setActiveWord(storedProgress);
        activeWordRef.current = storedProgress;
        setViewMode(initialViewFor(opened.document));
        setFollowPaused(false);
        setLibraryEntries(
          (current) =>
            sortLibraryEntries([
              opened.entry!,
              ...current.filter((entry) => entry.id !== documentId),
            ]) as LibraryEntry[],
        );
        setShowSidebar(false);
        window.setTimeout(() => {
          if (storedProgress > 0) scrollToActiveWord("auto");
          else readerRef.current?.scrollTo({ top: 0, behavior: "auto" });
        }, 80);
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "This document could not be opened.",
        );
      } finally {
        setLibraryBusyId(null);
      }
    },
    [readerDocument.id, scrollToActiveWord, stopSpeech],
  );

  const submitDocumentRename = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!renamingDocumentId) return;
      const documentId = renamingDocumentId;
      setLibraryBusyId(documentId);
      try {
        const renamed = (await renameReaderDocument(
          documentId,
          renameDraft,
        )) as {
          document: ReaderDocument;
          entry: LibraryEntry;
        };
        setLibraryEntries(
          (current) =>
            sortLibraryEntries(
              current.map((entry) =>
                entry.id === documentId ? renamed.entry : entry,
              ),
            ) as LibraryEntry[],
        );
        if (readerDocument.id === documentId) {
          setReaderDocument(renamed.document);
        }
        setRenamingDocumentId(null);
        setRenameDraft("");
        setNotice(`Renamed to ${renamed.document.title}.`);
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "This document could not be renamed.",
        );
      } finally {
        setLibraryBusyId(null);
      }
    },
    [readerDocument.id, renameDraft, renamingDocumentId],
  );

  const deleteLibraryDocument = useCallback(
    async (entryToDelete: LibraryEntry) => {
      if (
        !window.confirm(
          `Remove “${entryToDelete.title}” from this device? This cannot be undone.`,
        )
      ) {
        return;
      }

      const wasActive = readerDocument.id === entryToDelete.id;
      const remainingEntries = libraryEntries.filter(
        (entry) => entry.id !== entryToDelete.id,
      );
      setLibraryBusyId(entryToDelete.id);
      try {
        if (wasActive) stopSpeech();
        await removeReaderDocument(entryToDelete.id);
        try {
          localStorage.removeItem(`guided-reader-progress-${entryToDelete.id}`);
          localStorage.removeItem(`guided-reader-view-${entryToDelete.id}`);
        } catch {
          // IndexedDB removal still succeeds if local storage is unavailable.
        }
        setLibraryEntries(remainingEntries);
        if (renamingDocumentId === entryToDelete.id) {
          setRenamingDocumentId(null);
          setRenameDraft("");
        }

        if (wasActive && remainingEntries.length) {
          const nextDocument = (await openReaderDocument(
            remainingEntries[0].id,
          )) as {
            document: ReaderDocument | null;
            entry: LibraryEntry | null;
          };
          if (!nextDocument.document || !nextDocument.entry) {
            throw new Error("The next document could not be opened.");
          }
          wordRefs.current.clear();
          const storedProgress = clampStoredProgress(nextDocument.document);
          setReaderDocument(nextDocument.document);
          setActiveWord(storedProgress);
          activeWordRef.current = storedProgress;
          setViewMode(initialViewFor(nextDocument.document));
          setLibraryEntries(
            (current) =>
              sortLibraryEntries(
                current.map((entry) =>
                  entry.id === nextDocument.entry!.id
                    ? nextDocument.entry!
                    : entry,
                ),
              ) as LibraryEntry[],
          );
          window.setTimeout(() => scrollToActiveWord("auto"), 80);
        } else if (wasActive) {
          const starterProgress = clampStoredProgress(DEMO_DOCUMENT);
          wordRefs.current.clear();
          setReaderDocument(DEMO_DOCUMENT);
          setActiveWord(starterProgress);
          activeWordRef.current = starterProgress;
          setViewMode("focus");
          readerRef.current?.scrollTo({ top: 0, behavior: "auto" });
        }

        setNotice(`${entryToDelete.title} was removed from this device.`);
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "This document could not be removed.",
        );
      } finally {
        setLibraryBusyId(null);
      }
    },
    [
      libraryEntries,
      readerDocument.id,
      renamingDocumentId,
      scrollToActiveWord,
      stopSpeech,
    ],
  );

  const importFile = useCallback(
    async (file?: File) => {
      if (!file) return;
      const extension = file.name.split(".").pop()?.toLowerCase();
      if (!["pdf", "epub", "txt"].includes(extension ?? "")) {
        setNotice("Choose a PDF, EPUB, or TXT file.");
        return;
      }

      setIsImporting(true);
      setNotice("");
      try {
        let imported: ReaderDocument;
        if (extension === "pdf") imported = await parsePdf(file);
        else if (extension === "epub") imported = await parseEpub(file);
        else imported = await parseText(file);

        const libraryEntry = (await addReaderDocument(
          imported,
        )) as LibraryEntry;
        stopSpeech();
        wordRefs.current.clear();
        setReaderDocument(imported);
        setLibraryEntries(
          (current) =>
            sortLibraryEntries([
              libraryEntry,
              ...current.filter((entry) => entry.id !== imported.id),
            ]) as LibraryEntry[],
        );
        setActiveWord(0);
        activeWordRef.current = 0;
        setViewMode(
          imported.kind === "pdf" &&
            imported.pdfData?.length &&
            imported.pdfPages?.length
            ? "page"
            : "focus",
        );
        setFollowPaused(false);
        setShowImport(false);
        setShowSidebar(false);
        window.setTimeout(() => {
          readerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
        }, 0);
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "This file could not be opened.",
        );
      } finally {
        setIsImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [stopSpeech],
  );

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    void importFile(event.target.files?.[0]);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void importFile(event.dataTransfer.files?.[0]);
  };

  const progressForLibraryEntry = (entry: LibraryEntry) => {
    if (entry.id === readerDocument.id) return progress;
    const storedProgress = storedProgressFor(entry.id);
    return calculateLibraryProgress(
      storedProgress ?? 0,
      entry.wordCount,
      storedProgress !== null,
    );
  };

  const readerStyle = {
    "--reader-size": `${settings.fontSize}px`,
    "--reader-leading": settings.lineHeight,
    ...createReaderLayoutStyle(settings),
  } as CSSProperties;

  const resetReadingLayout = () => {
    setSettings((current) => ({
      ...current,
      fontSize: DEFAULT_SETTINGS.fontSize,
      lineHeight: DEFAULT_SETTINGS.lineHeight,
      letterSpacing: DEFAULT_READER_LAYOUT.letterSpacing,
      wordSpacing: DEFAULT_READER_LAYOUT.wordSpacing,
      paragraphSpacing: DEFAULT_READER_LAYOUT.paragraphSpacing,
      maxLineWidth: DEFAULT_READER_LAYOUT.maxLineWidth,
      focusLines: DEFAULT_READER_LAYOUT.focusLines as FocusLineCount,
    }));
  };

  const changeViewMode = (mode: ReaderViewMode) => {
    if (mode === viewMode) return;
    wordRefs.current.clear();
    setViewMode(mode);
    setFollowPaused(false);
    window.setTimeout(() => scrollToActiveWord("smooth"), 80);
  };

  return (
    <main className={`app-shell theme-${settings.theme}`} style={readerStyle}>
      <aside className={`sidebar ${showSidebar ? "sidebar-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            ll
          </div>
          <div>
            <p className="brand-name">LineLight</p>
            <p className="brand-note">Your quiet reading space</p>
          </div>
          <button
            className="mobile-close"
            type="button"
            onClick={() => setShowSidebar(false)}
            aria-label="Close library"
          >
            ×
          </button>
        </div>

        <button
          className="import-button"
          type="button"
          onClick={() => setShowImport(true)}
        >
          <span aria-hidden="true">＋</span>
          Import a book
        </button>

        <section className="library-section" aria-labelledby="library-title">
          <div className="library-heading">
            <p className="nav-label" id="library-title">
              Your library
            </p>
            <span>{libraryEntries.length} saved</span>
          </div>

          {libraryEntries.length > 1 && (
            <input
              className="library-search"
              type="search"
              value={librarySearch}
              onChange={(event) => setLibrarySearch(event.target.value)}
              placeholder="Search books"
              aria-label="Search your library"
            />
          )}

          {!libraryReady && (
            <p className="library-empty" role="status">
              Opening your private library…
            </p>
          )}

          {libraryReady && libraryEntries.length === 0 && (
            <p className="library-empty">
              Imported books will stay here. The starter document is ready
              whenever you need it.
            </p>
          )}

          <div className="library-books">
            {visibleLibraryEntries.map((entry) => {
              const entryProgress = progressForLibraryEntry(entry);
              const isActive = entry.id === readerDocument.id;
              const isBusy = libraryBusyId === entry.id;
              const isRenaming = renamingDocumentId === entry.id;

              return (
                <article
                  className={`library-book ${
                    isActive ? "library-book-active" : ""
                  }`}
                  key={entry.id}
                >
                  {isRenaming ? (
                    <form
                      className="library-rename"
                      onSubmit={submitDocumentRename}
                    >
                      <label htmlFor={`rename-${entry.id}`}>Book title</label>
                      <input
                        id={`rename-${entry.id}`}
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        maxLength={160}
                        autoFocus
                      />
                      <div>
                        <button type="submit" disabled={isBusy}>
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingDocumentId(null);
                            setRenameDraft("");
                          }}
                          disabled={isBusy}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <button
                        className="library-book-open"
                        type="button"
                        onClick={() => void openLibraryDocument(entry.id)}
                        disabled={isBusy}
                        aria-current={isActive ? "page" : undefined}
                      >
                        <span className="book-cover" aria-hidden="true">
                          <span>{entry.kind.toUpperCase()}</span>
                        </span>
                        <span className="book-card-copy">
                          <span className="library-book-title">
                            {entry.title}
                          </span>
                          <span className="library-book-author">
                            {entry.author}
                          </span>
                          <span className="mini-progress" aria-hidden="true">
                            <span style={{ width: `${entryProgress}%` }} />
                          </span>
                          <small>
                            {isBusy ? "Opening…" : `${entryProgress}% complete`}
                          </small>
                        </span>
                      </button>
                      <div className="library-book-actions">
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingDocumentId(entry.id);
                            setRenameDraft(entry.title);
                          }}
                          aria-label={`Rename ${entry.title}`}
                          title="Rename"
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteLibraryDocument(entry)}
                          aria-label={`Remove ${entry.title}`}
                          title="Remove"
                        >
                          ×
                        </button>
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </div>

          {libraryReady &&
            libraryEntries.length > 0 &&
            visibleLibraryEntries.length === 0 && (
              <p className="library-empty">No saved books match that search.</p>
            )}
        </section>

        <div className="privacy-note">
          <span aria-hidden="true">⌂</span>
          <p>
            <strong>Private by design</strong>
            Files and progress stay on this device.
          </p>
        </div>

        <button
          className="sidebar-settings"
          type="button"
          onClick={() => {
            setShowSettings(true);
            setShowSidebar(false);
          }}
        >
          <span aria-hidden="true">Aa</span>
          Reading settings
        </button>
      </aside>

      {showSidebar && (
        <button
          className="page-scrim mobile-scrim"
          aria-label="Close library"
          type="button"
          onClick={() => setShowSidebar(false)}
        />
      )}

      <section className="workspace">
        <header className="topbar">
          <div className="title-group">
            <button
              className="menu-button"
              type="button"
              onClick={() => setShowSidebar(true)}
              aria-label="Open library"
            >
              ☰
            </button>
            <div>
              <p className="eyebrow">
                {readerDocument.kind === "demo"
                  ? "A quiet place to begin"
                  : `${readerDocument.kind.toUpperCase()} · ${
                      viewMode === "page" && supportsPageView
                        ? "Original page view"
                        : "Focus view"
                    }`}
              </p>
              <h1>{readerDocument.title}</h1>
            </div>
          </div>
          {supportsPageView && (
            <div className="view-switcher" role="group" aria-label="PDF view">
              <button
                type="button"
                className={viewMode === "focus" ? "selected" : ""}
                onClick={() => changeViewMode("focus")}
                aria-pressed={viewMode === "focus"}
              >
                <span aria-hidden="true">Aa</span>
                Focus
              </button>
              <button
                type="button"
                className={viewMode === "page" ? "selected" : ""}
                onClick={() => changeViewMode("page")}
                aria-pressed={viewMode === "page"}
              >
                <span aria-hidden="true">▧</span>
                Page
              </button>
            </div>
          )}
          <div className="top-actions">
            <span className="saved-status">
              <span aria-hidden="true">✓</span> Saved locally
            </span>
            <button
              className="text-button bookmark-button"
              type="button"
              onClick={() => {
                setShowSettings(false);
                setShowBookmarks(true);
              }}
              aria-expanded={showBookmarks}
              aria-controls="bookmarks-panel"
            >
              <span aria-hidden="true">⌑</span>
              <span className="desktop-label">
                Bookmarks{bookmarks.length ? ` (${bookmarks.length})` : ""}
              </span>
            </button>
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setShowBookmarks(false);
                setShowSettings(true);
              }}
            >
              <span aria-hidden="true">Aa</span>
              <span className="desktop-label">Reading settings</span>
            </button>
          </div>
        </header>

        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice("")}
              aria-label="Dismiss message"
            >
              ×
            </button>
          </div>
        )}

        <div
          className="reader-scroll"
          ref={readerRef}
          onWheel={() => {
            if (
              isPlaying &&
              settings.follow &&
              !programmaticScrollRef.current
            ) {
              setFollowPaused(true);
            }
          }}
          onTouchMove={() => {
            if (
              isPlaying &&
              settings.follow &&
              !programmaticScrollRef.current
            ) {
              setFollowPaused(true);
            }
          }}
        >
          {supportsPageView &&
          viewMode === "page" &&
          readerDocument.pdfData &&
          readerDocument.pdfPages ? (
            <PdfPageView
              data={readerDocument.pdfData}
              pages={readerDocument.pdfPages}
              activeWord={activeWord}
              activeSentence={activeSentence}
              tokenSentences={tokenSentences}
              highlightMode={settings.highlightMode}
              registerWord={(index, element) => {
                if (element) wordRefs.current.set(index, element);
                else wordRefs.current.delete(index);
              }}
              onSelectWord={(index) => {
                jumpToPosition(index);
              }}
              onRenderError={setNotice}
            />
          ) : (
            <article
              className={[
                "reading-page",
                `font-${settings.font}`,
                `highlight-${settings.highlightMode}`,
                settings.focusLines > 0 ? "focus-window-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="chapter-heading">
                <span className="chapter-rule" aria-hidden="true" />
                <p>
                  {readerDocument.kind === "demo"
                    ? "A reading sample"
                    : "Imported document"}
                </p>
                <h2>{readerDocument.title}</h2>
              </div>

              <div className="reading-copy">
                {model.paragraphs.map((paragraph, paragraphIndex) => (
                  <p key={`${readerDocument.id}-${paragraphIndex}`}>
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
                          ref={(element) => {
                            if (element) {
                              wordRefs.current.set(
                                segment.tokenIndex!,
                                element,
                              );
                            } else {
                              wordRefs.current.delete(segment.tokenIndex!);
                            }
                          }}
                          onClick={() => {
                            jumpToPosition(segment.tokenIndex!);
                          }}
                        >
                          {segment.text}
                        </span>
                      );
                    })}
                  </p>
                ))}
              </div>

              <footer className="document-end">
                <span aria-hidden="true">✦</span>
                <p>End of document</p>
              </footer>
            </article>
          )}
        </div>

        {settings.ruler && <div className="reading-ruler" aria-hidden="true" />}

        {(followPaused || positionHistory.length > 0) && (
          <div className="position-action-stack">
            {followPaused && (
              <button
                className="return-button"
                type="button"
                onClick={returnToNarration}
              >
                <span aria-hidden="true">◎</span>
                Return to narration
                <kbd>R</kbd>
              </button>
            )}
            {positionHistory.length > 0 && (
              <button
                className="history-back-button"
                type="button"
                onClick={backToPreviousPosition}
                aria-keyshortcuts="Alt+ArrowLeft"
              >
                <span aria-hidden="true">↩</span>
                Back to previous position
                <kbd>Alt ←</kbd>
              </button>
            )}
          </div>
        )}

        <section className="player" aria-label="Narration controls">
          <div className="player-progress">
            <div>
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>

          <div className="player-content">
            <div className="now-playing">
              <div className="now-playing-mark" aria-hidden="true">
                {isPreparingSpeech ? "…" : isPlaying ? "≋" : "¶"}
              </div>
              <div>
                <p>
                  {isPreparingSpeech
                    ? "Preparing natural voice"
                    : isPlaying
                      ? "Reading now"
                      : "Ready to read"}
                </p>
                <span>
                  {activeToken?.text ?? "Start"} · {progress}%
                </span>
              </div>
            </div>

            <div className="transport">
              <button
                type="button"
                className="transport-small"
                onClick={() => moveBySentence(-1)}
                aria-label="Previous sentence"
                title="Previous sentence"
              >
                <span aria-hidden="true">↶</span>
                <small>sentence</small>
              </button>
              <button
                type="button"
                className="play-button"
                onClick={togglePlayback}
                aria-label={
                  isPreparingSpeech
                    ? "Cancel narration"
                    : isPlaying
                      ? "Pause narration"
                      : "Play narration"
                }
              >
                {isPreparingSpeech ? "■" : isPlaying ? "Ⅱ" : "▶"}
              </button>
              <button
                type="button"
                className="transport-small"
                onClick={() => moveBySentence(1)}
                aria-label="Next sentence"
                title="Next sentence"
              >
                <span aria-hidden="true">↷</span>
                <small>sentence</small>
              </button>
            </div>

            <div className="player-meta">
              <label className="speed-control">
                <span>Speed</span>
                <select
                  value={settings.rate}
                  onChange={(event) => {
                    const rate = Number(event.target.value);
                    stopSpeech();
                    setSettings((current) => ({ ...current, rate }));
                  }}
                >
                  {[0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}×
                    </option>
                  ))}
                </select>
              </label>
              <div className="time-remaining">
                <span>{formatTime(remainingSeconds)} left</span>
              </div>
            </div>
          </div>
        </section>
      </section>

      {showBookmarks && (
        <div
          className="bookmarks-layer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bookmarks-title"
        >
          <button
            className="page-scrim"
            type="button"
            aria-label="Close bookmarks and history"
            onClick={() => setShowBookmarks(false)}
          />
          <section className="bookmarks-panel" id="bookmarks-panel">
            <header>
              <div>
                <p>{readerDocument.title}</p>
                <h2 id="bookmarks-title">Bookmarks &amp; history</h2>
              </div>
              <button
                type="button"
                onClick={() => setShowBookmarks(false)}
                aria-label="Close bookmarks and history"
              >
                ×
              </button>
            </header>

            <div className="bookmarks-scroll">
              <p className="navigation-rule">
                Opening a bookmark, search result, or previous position stops
                narration. Press Play when you are ready to continue from the
                new place.
              </p>

              <button
                className="previous-position-button"
                type="button"
                onClick={backToPreviousPosition}
                disabled={!positionHistory.length}
              >
                <span aria-hidden="true">↩</span>
                <span>
                  <strong>Back to previous position</strong>
                  {positionHistory.length
                    ? `${positionHistory.length} recent ${
                        positionHistory.length === 1 ? "jump" : "jumps"
                      } available`
                    : "A long-distance jump will appear here"}
                </span>
              </button>

              <section
                className="bookmark-section"
                aria-labelledby="save-bookmark-title"
              >
                <div className="bookmark-section-heading">
                  <h3 id="save-bookmark-title">Save this position</h3>
                  <span>{progress}%</span>
                </div>
                <p className="current-position-snippet">
                  {currentPosition?.snippet ?? "No readable text here yet."}
                </p>
                <form className="add-bookmark-form" onSubmit={addBookmark}>
                  <label htmlFor="bookmark-name">Bookmark name</label>
                  <div>
                    <input
                      id="bookmark-name"
                      value={bookmarkName}
                      onChange={(event) => setBookmarkName(event.target.value)}
                      placeholder="For example, Key idea"
                      maxLength={80}
                      disabled={!navigationReady || !model.tokens.length}
                    />
                    <button
                      type="submit"
                      disabled={!navigationReady || !model.tokens.length}
                    >
                      Add
                    </button>
                  </div>
                </form>
              </section>

              <section
                className="bookmark-section"
                aria-labelledby="saved-bookmarks-title"
              >
                <div className="bookmark-section-heading">
                  <h3 id="saved-bookmarks-title">Saved bookmarks</h3>
                  <span>{bookmarks.length}</span>
                </div>
                {!navigationReady ? (
                  <p className="bookmark-empty" role="status">
                    Opening saved bookmarks…
                  </p>
                ) : bookmarkRows.length ? (
                  <div className="bookmark-list">
                    {bookmarkRows.map(({ bookmark, resolvedIndex }) => {
                      const bookmarkProgress =
                        resolvedIndex === null || !model.tokens.length
                          ? null
                          : Math.round(
                              ((resolvedIndex + 1) / model.tokens.length) * 100,
                            );
                      const isEditing = editingBookmarkId === bookmark.id;
                      return (
                        <article className="bookmark-card" key={bookmark.id}>
                          {isEditing ? (
                            <form
                              className="bookmark-rename-form"
                              onSubmit={renameBookmark}
                            >
                              <label htmlFor={`bookmark-${bookmark.id}`}>
                                Bookmark name
                              </label>
                              <input
                                id={`bookmark-${bookmark.id}`}
                                value={bookmarkRenameDraft}
                                onChange={(event) =>
                                  setBookmarkRenameDraft(event.target.value)
                                }
                                maxLength={80}
                                autoFocus
                              />
                              <div>
                                <button type="submit">Save</button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingBookmarkId(null);
                                    setBookmarkRenameDraft("");
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          ) : (
                            <>
                              <button
                                className="bookmark-open"
                                type="button"
                                disabled={resolvedIndex === null}
                                onClick={() =>
                                  openStoredPosition(
                                    bookmark,
                                    `Bookmark “${bookmark.name}”`,
                                  )
                                }
                              >
                                <span className="bookmark-title-row">
                                  <strong>{bookmark.name}</strong>
                                  <small>
                                    {bookmarkProgress === null
                                      ? "Position unavailable"
                                      : `${bookmarkProgress}%`}
                                  </small>
                                </span>
                                <span className="bookmark-snippet">
                                  {bookmark.snippet}
                                </span>
                              </button>
                              <div className="bookmark-actions">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingBookmarkId(bookmark.id);
                                    setBookmarkRenameDraft(bookmark.name);
                                  }}
                                  aria-label={`Rename bookmark ${bookmark.name}`}
                                >
                                  Rename
                                </button>
                                <button
                                  type="button"
                                  onClick={() => removeBookmark(bookmark)}
                                  aria-label={`Remove bookmark ${bookmark.name}`}
                                >
                                  Remove
                                </button>
                              </div>
                            </>
                          )}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="bookmark-empty">
                    Name the current position to start a bookmark list for this
                    document.
                  </p>
                )}
              </section>

              <section
                className="bookmark-section document-find"
                aria-labelledby="find-document-title"
              >
                <div className="bookmark-section-heading">
                  <h3 id="find-document-title">Find in this document</h3>
                  {documentSearch.trim().length >= 2 && (
                    <span>{documentSearchMatches.length}</span>
                  )}
                </div>
                <label htmlFor="document-search">Word or phrase</label>
                <input
                  id="document-search"
                  type="search"
                  value={documentSearch}
                  onChange={(event) => setDocumentSearch(event.target.value)}
                  placeholder="Search reading text"
                />
                {documentSearch.trim().length >= 2 &&
                  (documentSearchMatches.length ? (
                    <ol className="document-search-results">
                      {documentSearchMatches.map((match) => {
                        const matchProgress = model.tokens.length
                          ? Math.round(
                              ((match.tokenIndex + 1) / model.tokens.length) *
                                100,
                            )
                          : 0;
                        return (
                          <li key={match.tokenIndex}>
                            <button
                              type="button"
                              onClick={() => {
                                jumpToPosition(match.tokenIndex, {
                                  closePanel: true,
                                });
                                setNotice(
                                  "Search result opened. Press Play to narrate from here.",
                                );
                              }}
                            >
                              <span>{match.snippet}</span>
                              <small>{matchProgress}%</small>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="bookmark-empty" role="status">
                      No matching text in this document.
                    </p>
                  ))}
              </section>
            </div>
          </section>
        </div>
      )}

      {showImport && (
        <div
          className="modal-layer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-title"
        >
          <button
            className="page-scrim"
            type="button"
            aria-label="Close import"
            onClick={() => !isImporting && setShowImport(false)}
          />
          <section className="import-modal">
            <button
              className="modal-close"
              type="button"
              onClick={() => setShowImport(false)}
              disabled={isImporting}
              aria-label="Close import"
            >
              ×
            </button>
            <p className="modal-kicker">Add to your private library</p>
            <h2 id="import-title">Import something to read</h2>
            <p className="modal-intro">
              Choose a text-based PDF, EPUB, or TXT file. It is processed in
              your browser and is not uploaded to a server. PDFs include both
              the original page layout and a calmer Focus view.
            </p>

            <div
              className={`drop-zone ${isImporting ? "drop-zone-busy" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
            >
              <span className="drop-icon" aria-hidden="true">
                {isImporting ? "…" : "↥"}
              </span>
              <h3>
                {isImporting ? "Preparing your book…" : "Drop a file here"}
              </h3>
              <p>or choose one from this device</p>
              <button
                type="button"
                className="choose-file"
                disabled={isImporting}
                onClick={() => fileInputRef.current?.click()}
              >
                Choose a file
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.epub,.txt,application/pdf,application/epub+zip,text/plain"
                onChange={handleFileInput}
              />
            </div>

            <div className="format-row">
              <span>PDF</span>
              <span>EPUB</span>
              <span>TXT</span>
            </div>
            <p className="scan-note">
              Scanned PDFs need OCR, which is planned for a later version.
            </p>
          </section>
        </div>
      )}

      {showSettings && (
        <div
          className="settings-layer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
        >
          <button
            className="page-scrim"
            type="button"
            aria-label="Close reading settings"
            onClick={() => setShowSettings(false)}
          />
          <section className="settings-panel">
            <header>
              <div>
                <p>Make the page yours</p>
                <h2 id="settings-title">Reading settings</h2>
              </div>
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                aria-label="Close reading settings"
              >
                ×
              </button>
            </header>

            <div className="settings-scroll">
              <fieldset>
                <legend>Text style</legend>
                <div className="segmented three">
                  {(
                    [
                      ["serif", "Reading"],
                      ["sans", "Clear"],
                      ["system", "System"],
                    ] as [ReadingFont, string][]
                  ).map(([value, label]) => (
                    <button
                      type="button"
                      className={settings.font === value ? "selected" : ""}
                      onClick={() =>
                        setSettings((current) => ({ ...current, font: value }))
                      }
                      key={value}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <label className="range-setting">
                  <span>
                    Text size <strong>{settings.fontSize}px</strong>
                  </span>
                  <input
                    type="range"
                    min="17"
                    max="32"
                    step="1"
                    value={settings.fontSize}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        fontSize: Number(event.target.value),
                      }))
                    }
                  />
                </label>

                <label className="range-setting">
                  <span>
                    Line spacing{" "}
                    <strong>{settings.lineHeight.toFixed(2)}</strong>
                  </span>
                  <input
                    type="range"
                    min="1.4"
                    max="2.15"
                    step="0.05"
                    value={settings.lineHeight}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        lineHeight: Number(event.target.value),
                      }))
                    }
                  />
                </label>
              </fieldset>

              <fieldset>
                <legend>Text layout</legend>
                <p className="setting-note">
                  These controls reflow Focus view. Original PDF pages keep
                  their source layout.
                </p>

                <label className="range-setting">
                  <span>
                    Letter spacing
                    <strong>{settings.letterSpacing.toFixed(2)}em</strong>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="0.12"
                    step="0.01"
                    value={settings.letterSpacing}
                    aria-valuetext={`${settings.letterSpacing.toFixed(2)} em`}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        letterSpacing: Number(event.target.value),
                      }))
                    }
                  />
                </label>

                <label className="range-setting">
                  <span>
                    Word spacing
                    <strong>{settings.wordSpacing.toFixed(2)}em</strong>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="0.3"
                    step="0.02"
                    value={settings.wordSpacing}
                    aria-valuetext={`${settings.wordSpacing.toFixed(2)} em`}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        wordSpacing: Number(event.target.value),
                      }))
                    }
                  />
                </label>

                <label className="range-setting">
                  <span>
                    Paragraph spacing
                    <strong>{settings.paragraphSpacing.toFixed(2)}em</strong>
                  </span>
                  <input
                    type="range"
                    min="0.8"
                    max="2.5"
                    step="0.05"
                    value={settings.paragraphSpacing}
                    aria-valuetext={`${settings.paragraphSpacing.toFixed(2)} em`}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        paragraphSpacing: Number(event.target.value),
                      }))
                    }
                  />
                </label>

                <label className="range-setting">
                  <span>
                    Maximum line width
                    <strong>{settings.maxLineWidth} characters</strong>
                  </span>
                  <input
                    type="range"
                    min="42"
                    max="90"
                    step="2"
                    value={settings.maxLineWidth}
                    aria-valuetext={`${settings.maxLineWidth} characters`}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        maxLineWidth: Number(event.target.value),
                      }))
                    }
                  />
                </label>

                <button
                  className="reset-layout-button"
                  type="button"
                  onClick={resetReadingLayout}
                >
                  Reset layout and focus
                </button>
              </fieldset>

              <fieldset>
                <legend>Page color</legend>
                <div className="theme-choices">
                  {(
                    [
                      ["cream", "Warm cream", "#fff9ec"],
                      ["white", "Paper white", "#ffffff"],
                      ["dark", "Evening", "#262420"],
                    ] as [ReadingTheme, string, string][]
                  ).map(([value, label, color]) => (
                    <button
                      type="button"
                      className={settings.theme === value ? "selected" : ""}
                      onClick={() =>
                        setSettings((current) => ({ ...current, theme: value }))
                      }
                      key={value}
                    >
                      <span style={{ background: color }} aria-hidden="true" />
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend>Reading focus</legend>
                <label className="select-setting">
                  <span>Highlight</span>
                  <select
                    value={settings.highlightMode}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        highlightMode: event.target.value as HighlightMode,
                      }))
                    }
                  >
                    <option value="both">Word and sentence</option>
                    <option value="word">Spoken word only</option>
                    <option value="sentence">Current sentence only</option>
                  </select>
                </label>

                <div className="focus-line-setting">
                  <div className="focus-line-heading">
                    <strong>Visible focus lines</strong>
                    <span>
                      {settings.focusLines === 0
                        ? "All lines"
                        : `${settings.focusLines} ${
                            settings.focusLines === 1 ? "line" : "lines"
                          }`}
                    </span>
                  </div>
                  <div
                    className="segmented four"
                    role="group"
                    aria-label="Visible focus lines"
                    aria-describedby="focus-lines-description"
                  >
                    {(
                      [
                        [0, "All"],
                        [1, "1 line"],
                        [3, "3 lines"],
                        [5, "5 lines"],
                      ] as [FocusLineCount, string][]
                    ).map(([value, label]) => (
                      <button
                        type="button"
                        className={
                          settings.focusLines === value ? "selected" : ""
                        }
                        aria-pressed={settings.focusLines === value}
                        onClick={() =>
                          setSettings((current) => ({
                            ...current,
                            focusLines: value,
                          }))
                        }
                        key={value}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="setting-note" id="focus-lines-description">
                    Focus view softens lines outside this window while keeping
                    the full document available to assistive technology.
                  </p>
                </div>

                <label className="switch-row">
                  <span>
                    <strong>Follow narration</strong>
                    Keep the spoken word in the center of the page.
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.follow}
                    onChange={(event) => {
                      setFollowPaused(false);
                      setSettings((current) => ({
                        ...current,
                        follow: event.target.checked,
                      }));
                    }}
                  />
                </label>

                <label className="switch-row">
                  <span>
                    <strong>Reading ruler</strong>
                    Add a gentle line below the active sentence.
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.ruler}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        ruler: event.target.checked,
                      }))
                    }
                  />
                </label>
              </fieldset>

              <fieldset>
                <legend>Narration</legend>
                <div
                  className="segmented three narration-source"
                  aria-label="Narration source"
                >
                  {(
                    [
                      ["offline", "Offline natural"],
                      ["device", "Device"],
                      ["azure", "Online natural"],
                    ] as [NarrationEngine, string][]
                  ).map(([value, label]) => (
                    <button
                      type="button"
                      className={
                        settings.narrationEngine === value ? "selected" : ""
                      }
                      aria-pressed={settings.narrationEngine === value}
                      onClick={() => {
                        stopSpeech();
                        setSettings((current) => ({
                          ...current,
                          narrationEngine: value,
                        }));
                      }}
                      key={value}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {settings.narrationEngine === "azure" ? (
                  <>
                    <label className="select-setting stacked">
                      <span>Natural voice</span>
                      <select
                        value={settings.azureVoice}
                        onChange={(event) => {
                          stopSpeech();
                          setSettings((current) => ({
                            ...current,
                            azureVoice: event.target.value,
                          }));
                        }}
                      >
                        {AZURE_VOICES.map((voice) => (
                          <option key={voice.value} value={voice.value}>
                            {voice.label} · {voice.description}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="online-voice-note">
                      Sends only short narration passages to Azure for speech;
                      one may be prepared ahead. Imported files and reading
                      progress remain on this device.
                    </p>
                  </>
                ) : settings.narrationEngine === "offline" ? (
                  <div className="offline-voice-settings">
                    {offlinePackState === "ready" ? (
                      <>
                        <label className="select-setting stacked">
                          <span>Offline natural voice</span>
                          <select
                            value={settings.offlineVoice}
                            onChange={(event) => {
                              stopSpeech();
                              setSettings((current) => ({
                                ...current,
                                offlineVoice: event.target
                                  .value as OfflineVoiceId,
                              }));
                            }}
                          >
                            {OFFLINE_VOICES.map((voice) => (
                              <option key={voice.value} value={voice.value}>
                                {voice.label} · {voice.description}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="offline-pack-ready">
                          <span>
                            <strong>Stored on this device</strong>
                            Five voices are available without internet.
                            {offlineRuntimeInfo && (
                              <small>
                                {offlineRuntimeInfo.device === "webgpu"
                                  ? "WebGPU accelerated"
                                  : `WebAssembly · ${
                                      offlineRuntimeInfo.wasmThreads ?? 1
                                    } ${
                                      offlineRuntimeInfo.wasmThreads === 1
                                        ? "thread"
                                        : "threads"
                                    }`}
                                {" · generated "}
                                {offlineRuntimeInfo.audioDurationSeconds.toFixed(
                                  1,
                                )}
                                {"s of audio in "}
                                {(
                                  offlineRuntimeInfo.synthesisMilliseconds /
                                  1000
                                ).toFixed(1)}
                                s
                              </small>
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={() => void deleteOfflineVoice()}
                          >
                            Remove
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="offline-pack-download">
                        <span className="offline-pack-icon" aria-hidden="true">
                          ↓
                        </span>
                        <div>
                          <strong>Included offline voice</strong>
                          <p>
                            LineLight stores about {OFFLINE_PACK_SIZE_LABEL} on
                            this device for five natural English voices.
                          </p>
                        </div>

                        {(offlinePackState === "installing" ||
                          offlinePackState === "removing") && (
                          <div
                            className="offline-pack-progress"
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={offlineInstallProgress}
                          >
                            <span
                              style={{
                                width: `${offlineInstallProgress}%`,
                              }}
                            />
                          </div>
                        )}

                        <p className="offline-pack-status" aria-live="polite">
                          {offlinePackState === "checking"
                            ? "Checking the included voice…"
                            : offlinePackState === "missing"
                              ? "Preparing automatically while connected…"
                              : offlineInstallLabel}
                        </p>
                        <button
                          type="button"
                          className="voice-pack-button"
                          disabled={
                            offlinePackState === "checking" ||
                            offlinePackState === "installing" ||
                            offlinePackState === "removing"
                          }
                          onClick={() => void downloadOfflineVoice()}
                        >
                          {offlinePackState === "installing"
                            ? `${offlineInstallProgress}% prepared`
                            : offlinePackState === "removing"
                              ? "Removing…"
                              : offlinePackState === "error"
                                ? "Try preparing again"
                                : "Prepare offline voices now"}
                        </button>
                      </div>
                    )}
                    <p className="online-voice-note offline-voice-note">
                      LineLight includes this voice and stores it locally on
                      first launch. After preparation, speech is generated on
                      this device and narration text never leaves it. Word
                      highlighting follows an audio-synchronized phoneme
                      estimate because Kokoro does not provide exact word
                      timestamps.{" "}
                      <a
                        href="/offline-voice-license.txt"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open-source license
                      </a>
                      .
                    </p>
                  </div>
                ) : (
                  <label className="select-setting stacked">
                    <span>Device voice</span>
                    <select
                      value={
                        voices.some(
                          (voice) => voice.voiceURI === settings.voiceURI,
                        )
                          ? settings.voiceURI
                          : ""
                      }
                      onChange={(event) => {
                        stopSpeech();
                        setSettings((current) => ({
                          ...current,
                          voiceURI: event.target.value,
                        }));
                      }}
                    >
                      <option value="">System default</option>
                      {voices.map((voice) => (
                        <option key={voice.voiceURI} value={voice.voiceURI}>
                          {voice.name} · {voice.lang}
                          {voice.localService ? " · local" : " · online"}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <div className="replay-grid">
                  <button type="button" onClick={() => replayUnit("word")}>
                    Replay word
                  </button>
                  <button type="button" onClick={() => replayUnit("sentence")}>
                    Replay sentence
                  </button>
                  <button type="button" onClick={() => replayUnit("paragraph")}>
                    Replay paragraph
                  </button>
                </div>
              </fieldset>

              <button
                className="reset-button"
                type="button"
                onClick={() => {
                  stopSpeech();
                  setSettings(DEFAULT_SETTINGS);
                  setFollowPaused(false);
                }}
              >
                Restore calm defaults
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
