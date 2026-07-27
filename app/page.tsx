"use client";

import {
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import JSZip from "jszip";
import {
  PdfPageView,
  type PdfPageLayout,
} from "./pdf-page-view";

type DocumentKind = "demo" | "pdf" | "epub" | "txt";
type HighlightMode = "both" | "word" | "sentence";
type ReadingTheme = "cream" | "white" | "dark";
type ReadingFont = "serif" | "sans" | "system";
type ReaderViewMode = "focus" | "page";

type ReaderDocument = {
  id: string;
  title: string;
  author: string;
  kind: DocumentKind;
  paragraphs: string[];
  pdfData?: Uint8Array;
  pdfPages?: PdfPageLayout[];
};

type WordToken = {
  index: number;
  text: string;
  start: number;
  end: number;
  paragraphIndex: number;
  sentenceIndex: number;
};

type Segment = {
  text: string;
  tokenIndex?: number;
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
  font: ReadingFont;
  theme: ReadingTheme;
  highlightMode: HighlightMode;
  follow: boolean;
  ruler: boolean;
  rate: number;
  voiceURI: string;
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
  font: "serif",
  theme: "cream",
  highlightMode: "both",
  follow: true,
  ruler: false,
  rate: 1,
  voiceURI: "",
};

const WORD_PATTERN =
  /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*|[^\s]/gu;
const IS_WORD = /^[\p{L}\p{N}]/u;
const READER_DB = "guided-reader-library";
const DOCUMENT_STORE = "documents";
const ACTIVE_DOCUMENT_KEY = "active-document";

function openReaderDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(READER_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DOCUMENT_STORE)) {
        request.result.createObjectStore(DOCUMENT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveReaderDocument(documentToSave: ReaderDocument) {
  const database = await openReaderDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
    transaction
      .objectStore(DOCUMENT_STORE)
      .put(documentToSave, ACTIVE_DOCUMENT_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function loadReaderDocument() {
  const database = await openReaderDatabase();
  const documentFromStorage = await new Promise<ReaderDocument | undefined>(
    (resolve, reject) => {
      const request = database
        .transaction(DOCUMENT_STORE, "readonly")
        .objectStore(DOCUMENT_STORE)
        .get(ACTIVE_DOCUMENT_KEY);
      request.onsuccess = () =>
        resolve(request.result as ReaderDocument | undefined);
      request.onerror = () => reject(request.error);
    },
  );
  database.close();
  return documentFromStorage;
}

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
      if (localStart > previousEnd) {
        segments.push({
          text: paragraph.slice(previousEnd, localStart),
          sentenceIndex,
        });
      }

      const text = match[0];
      if (IS_WORD.test(text)) {
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
        segments.push({ text, tokenIndex, sentenceIndex });
      } else {
        segments.push({ text, sentenceIndex });
      }

      if (/[.!?]/.test(text)) sentenceIndex += 1;
      previousEnd = localStart + text.length;
    }

    if (previousEnd < paragraph.length) {
      segments.push({
        text: paragraph.slice(previousEnd),
        sentenceIndex,
      });
    }

    renderedParagraphs.push(segments);
    documentOffset += paragraph.length + (paragraphIndex < paragraphs.length - 1 ? 2 : 0);
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
      const fontSize = Math.max(
        1,
        Math.hypot(transformed[2], transformed[3]),
      );
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
  const container = await zip
    .file("META-INF/container.xml")
    ?.async("string");

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
    const chapter = parser.parseFromString(chapterText, "application/xhtml+xml");
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
    paragraphs: text.split(/\n{2,}/).map(cleanText).filter(Boolean),
  };
}

function formatTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export default function Home() {
  const [readerDocument, setReaderDocument] =
    useState<ReaderDocument>(DEMO_DOCUMENT);
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [viewMode, setViewMode] = useState<ReaderViewMode>("focus");
  const [activeWord, setActiveWord] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [followPaused, setFollowPaused] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
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
  const programmaticScrollRef = useRef(false);
  const activeWordRef = useRef(0);

  useEffect(() => {
    activeWordRef.current = activeWord;
  }, [activeWord]);

  useEffect(() => {
    let restoreTimer: number | undefined;
    let cancelled = false;
    try {
      const savedSettings = localStorage.getItem("guided-reader-settings");
      const savedProgress = localStorage.getItem(
        `guided-reader-progress-${DEMO_DOCUMENT.id}`,
      );
      restoreTimer = window.setTimeout(() => {
        if (savedSettings) {
          setSettings((current) => ({
            ...current,
            ...(JSON.parse(savedSettings) as Partial<ReaderSettings>),
          }));
        }
        if (savedProgress) setActiveWord(Number(savedProgress) || 0);
      }, 0);
    } catch {
      // Local storage is optional; the reader still works without it.
    }

    loadReaderDocument()
      .then((storedDocument) => {
        if (!storedDocument || cancelled) return;
        let storedProgress = 0;
        try {
          storedProgress =
            Number(
              localStorage.getItem(
                `guided-reader-progress-${storedDocument.id}`,
              ),
            ) || 0;
        } catch {
          // The document can still be restored without its progress.
        }
        setReaderDocument(storedDocument);
        setActiveWord(storedProgress);
        activeWordRef.current = storedProgress;
        if (
          storedDocument.kind === "pdf" &&
          storedDocument.pdfData?.length &&
          storedDocument.pdfPages?.length
        ) {
          try {
            const savedView = localStorage.getItem(
              `guided-reader-view-${storedDocument.id}`,
            );
            setViewMode(savedView === "focus" ? "focus" : "page");
          } catch {
            setViewMode("page");
          }
        }
      })
      .catch(() => undefined);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
    return () => {
      cancelled = true;
      if (restoreTimer) window.clearTimeout(restoreTimer);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("guided-reader-settings", JSON.stringify(settings));
    } catch {
      // Ignore private-browsing storage limitations.
    }
  }, [settings]);

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
      localStorage.setItem(
        `guided-reader-view-${readerDocument.id}`,
        viewMode,
      );
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

  const stopSpeech = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    clearFallbackTimer();
    utteranceRef.current = null;
    setIsPlaying(false);
  }, [clearFallbackTimer]);

  useEffect(() => stopSpeech, [stopSpeech]);

  const scrollToActiveWord = useCallback((behavior: ScrollBehavior = "smooth") => {
    const word = wordRefs.current.get(activeWordRef.current);
    if (!word) return;
    programmaticScrollRef.current = true;
    word.scrollIntoView({ behavior, block: "center", inline: "nearest" });
    window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, behavior === "smooth" ? 700 : 80);
  }, []);

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
  }, [activeWord, followPaused, isPlaying, scrollToActiveWord, settings.follow]);

  const startSpeech = useCallback(
    (startIndex = activeWordRef.current) => {
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
      window.speechSynthesis.cancel();
      clearFallbackTimer();
      setActiveWord(safeIndex);
      activeWordRef.current = safeIndex;

      const offset = model.tokens[safeIndex].start;
      const utterance = new SpeechSynthesisUtterance(
        model.fullText.slice(offset),
      );
      utterance.rate = settings.rate;
      utterance.pitch = 1;
      const selectedVoice = voices.find(
        (voice) => voice.voiceURI === settings.voiceURI,
      );
      if (selectedVoice) utterance.voice = selectedVoice;

      speechOffsetRef.current = offset;
      boundarySeenRef.current = false;
      utteranceRef.current = utterance;

      utterance.onstart = () => {
        setIsPlaying(true);
        setNotice("");
      };
      utterance.onboundary = (event) => {
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
        utteranceRef.current = null;
        setIsPlaying(false);
      };
      utterance.onerror = (event) => {
        clearFallbackTimer();
        utteranceRef.current = null;
        setIsPlaying(false);
        if (event.error !== "canceled" && event.error !== "interrupted") {
          setNotice("The selected voice stopped unexpectedly. Try another voice.");
        }
      };

      window.speechSynthesis.speak(utterance);

      const interval = Math.max(130, 60_000 / (180 * settings.rate));
      fallbackTimerRef.current = window.setInterval(() => {
        if (boundarySeenRef.current || window.speechSynthesis.paused) return;
        setActiveWord((current) => {
          const next = Math.min(current + 1, model.tokens.length - 1);
          activeWordRef.current = next;
          return next;
        });
      }, interval);
    },
    [
      clearFallbackTimer,
      model.fullText,
      model.tokens,
      settings.rate,
      settings.voiceURI,
      speechAvailable,
      voices,
    ],
  );

  const togglePlayback = useCallback(() => {
    if (!speechAvailable) {
      setNotice(
        "Narration is not available in this browser. Try Safari on iPhone or Chrome on desktop.",
      );
      return;
    }
    if (isPlaying) {
      window.speechSynthesis.pause();
      setIsPlaying(false);
      return;
    }
    if (utteranceRef.current && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      setIsPlaying(true);
      return;
    }
    startSpeech();
  }, [isPlaying, speechAvailable, startSpeech]);

  const moveBySentence = useCallback(
    (direction: -1 | 1) => {
      if (!activeToken) return;
      const targetSentence =
        direction === 1
          ? activeToken.sentenceIndex + 1
          : Math.max(0, activeToken.sentenceIndex - 1);
      const target = model.tokens.find(
        (token) => token.sentenceIndex === targetSentence,
      );
      if (!target) return;
      stopSpeech();
      setActiveWord(target.index);
      activeWordRef.current = target.index;
      window.setTimeout(() => scrollToActiveWord("smooth"), 0);
    },
    [activeToken, model.tokens, scrollToActiveWord, stopSpeech],
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
  }, [moveBySentence, returnToNarration, togglePlayback]);

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

        await saveReaderDocument(imported).catch(() => undefined);
        stopSpeech();
        setReaderDocument(imported);
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

  const readerStyle = {
    "--reader-size": `${settings.fontSize}px`,
    "--reader-leading": settings.lineHeight,
  } as CSSProperties;

  const currentVoice =
    voices.find((voice) => voice.voiceURI === settings.voiceURI) ?? voices[0];

  const changeViewMode = (mode: ReaderViewMode) => {
    if (mode === viewMode) return;
    wordRefs.current.clear();
    setViewMode(mode);
    setFollowPaused(false);
    window.setTimeout(() => scrollToActiveWord("smooth"), 80);
  };

  return (
    <main
      className={`app-shell theme-${settings.theme}`}
      style={readerStyle}
    >
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

        <nav className="library-nav" aria-label="Reading library">
          <p className="nav-label">Your library</p>
          <button className="nav-item nav-item-active" type="button">
            <span className="nav-symbol" aria-hidden="true">
              ▤
            </span>
            <span>Now reading</span>
          </button>
          <button
            className="nav-item"
            type="button"
            onClick={() => setShowImport(true)}
          >
            <span className="nav-symbol" aria-hidden="true">
              ⤒
            </span>
            <span>Imports</span>
          </button>
        </nav>

        <section className="book-card" aria-label="Current book">
          <div className="book-cover" aria-hidden="true">
            <span>{readerDocument.kind === "demo" ? "GR" : readerDocument.kind.toUpperCase()}</span>
          </div>
          <div className="book-card-copy">
            <p>{readerDocument.title}</p>
            <span>{readerDocument.author}</span>
            <div className="mini-progress" aria-hidden="true">
              <span style={{ width: `${progress}%` }} />
            </div>
            <small>{progress}% complete</small>
          </div>
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
              className="text-button"
              type="button"
              onClick={() => setShowSettings(true)}
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
            if (isPlaying && settings.follow && !programmaticScrollRef.current) {
              setFollowPaused(true);
            }
          }}
          onTouchMove={() => {
            if (isPlaying && settings.follow && !programmaticScrollRef.current) {
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
                stopSpeech();
                setActiveWord(index);
                activeWordRef.current = index;
              }}
              onRenderError={setNotice}
            />
          ) : (
            <article
              className={`reading-page font-${settings.font} highlight-${settings.highlightMode}`}
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
                            stopSpeech();
                            setActiveWord(segment.tokenIndex!);
                            activeWordRef.current = segment.tokenIndex!;
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

        <section className="player" aria-label="Narration controls">
          <div className="player-progress">
            <div>
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>

          <div className="player-content">
            <div className="now-playing">
              <div className="now-playing-mark" aria-hidden="true">
                {isPlaying ? "≋" : "¶"}
              </div>
              <div>
                <p>{isPlaying ? "Reading now" : "Ready to read"}</p>
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
                aria-label={isPlaying ? "Pause narration" : "Play narration"}
              >
                {isPlaying ? "Ⅱ" : "▶"}
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
                  {[0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map(
                    (rate) => (
                      <option key={rate} value={rate}>
                        {rate}×
                      </option>
                    ),
                  )}
                </select>
              </label>
              <div className="time-remaining">
                <span>{formatTime(remainingSeconds)} left</span>
              </div>
            </div>
          </div>
        </section>
      </section>

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
              <h3>{isImporting ? "Preparing your book…" : "Drop a file here"}</h3>
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
                    Line spacing <strong>{settings.lineHeight.toFixed(2)}</strong>
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
                <label className="select-setting stacked">
                  <span>Voice</span>
                  <select
                    value={currentVoice?.voiceURI ?? ""}
                    onChange={(event) => {
                      stopSpeech();
                      setSettings((current) => ({
                        ...current,
                        voiceURI: event.target.value,
                      }));
                    }}
                  >
                    {voices.length ? (
                      voices.map((voice) => (
                        <option key={voice.voiceURI} value={voice.voiceURI}>
                          {voice.name} · {voice.lang}
                        </option>
                      ))
                    ) : (
                      <option value="">System voice</option>
                    )}
                  </select>
                </label>

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
