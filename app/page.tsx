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
import {
  DocumentOutline,
  type PdfOutlineItem,
} from "./document-outline";
import { buildDocumentModel } from "./document-model.mjs";
import { parseEpubFile } from "./epub-parser.mjs";
import { FocusDocumentView } from "./focus-document-view";
import {
  DEFAULT_HIGHLIGHT_SCOPE,
  HIGHLIGHT_SCOPE_OPTIONS,
  deriveActiveHighlightIndex,
  migrateReaderHighlightSettings,
} from "./highlight-scope.mjs";
import { PdfPageView, type PdfPageLayout } from "./pdf-page-view";
import { PdfDocumentClient } from "./pdf-document";
import { createPdfPageStore } from "./pdf-page-store.mjs";
import {
  appendPdfDocumentChunk,
  createProgressiveDocumentModel,
} from "./pdf-document-model.mjs";
import {
  acceptCurrentPdfPosition,
  isProgressivePdfHydrating,
  loadedPdfPageNumber,
  requiredPdfPositionTokenCount,
  resolveProgressivePdfTarget,
  shouldDeferPdfProgressWrite,
} from "./pdf-progressive-navigation.mjs";
import { reconcilePdfTerminalOutcome } from "./pdf-terminal-reconciliation.mjs";
import type {
  PdfWorkerMessage,
  StoredPdfManifest,
} from "./pdf-document-types";
import { findActivePdfOutlineItemId } from "./pdf-outline.mjs";
import {
  buildSentenceStartIndices,
  buildSpeechChunk,
  createSilentPcmWav,
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
  OFFLINE_DEFAULT_VOICE,
  OFFLINE_MODEL_DTYPE,
  OFFLINE_MODEL_REVISION,
  OFFLINE_PACK_BYTES,
  OFFLINE_VOICES,
  normalizeOfflineVoiceId,
  type OfflineVoiceId,
} from "./offline-speech-config";
import {
  OFFLINE_FIRST_CHUNK_CHARACTERS,
  OFFLINE_INSTALL_IDLE_DELAY_MS,
  OFFLINE_WARM_IDLE_TIMEOUT_MS,
  adaptOfflineSpeechChunkCharacters,
  evaluateOfflineStorageHeadroom,
  mapOfflineNarrationPhaseProgress,
  shouldAbortOfflineWarmRestore,
  shouldDisposeOfflineWorkerForImport,
  shouldRestoreOfflineWorkerAfterImport,
  shouldScheduleOfflinePreparation,
} from "./offline-preparation.mjs";
import {
  OfflineSpeechError,
  disposeOfflineSpeechWorker,
  getOfflineVoicePackBytes,
  getOfflineVoicePackRetainedBytes,
  getOfflineVoicePackStatus,
  getOfflineSpeechReadiness,
  initializeOfflineSpeech,
  installOfflineVoicePack,
  preloadOfflineSpeechRuntime,
  removeOfflineVoicePack,
  synthesizeOfflineSpeech,
  type OfflineSpeechResult,
} from "./offline-speech";
import {
  createBoundedSpeechAudioCache,
  createSpeechPrefetchQueue,
} from "./speech-prefetch.mjs";
import {
  DEFAULT_NARRATION_ENGINE,
  NARRATION_PREFERENCE_VERSION,
  allowsDeviceFallback,
  restoreNarrationPreference,
} from "./narration-defaults.mjs";
import { normalizeNarrationReadiness } from "./narration-readiness.mjs";
import {
  PREPARED_NARRATION_AUDIO_MIME_TYPE,
  PREPARED_NARRATION_BOOK_RETENTION,
  PREPARED_NARRATION_CHUNK_CHARACTERS,
  PREPARED_NARRATION_IDENTITY_ENCODING,
  PREPARED_NARRATION_RECENT_RETENTION,
  PREPARED_NARRATION_SCHEMA_VERSION,
  createPreparedNarrationManifest,
  createPreparedNarrationProfileKey,
  decodePreparedNarrationAudio,
  encodePreparedNarrationAudio,
  estimatePreparedNarrationStorage,
  fingerprintPreparedNarrationText,
} from "./prepared-narration.mjs";
import {
  exportPreparedNarration,
  isPreparedNarrationExportManifest,
  matchesPreparedNarrationExport,
  matchesPreparedNarrationExportAudioParts,
} from "./prepared-narration-export.mjs";
import {
  AUDIOBOOK_ALIGNMENT_MODEL_ESTIMATED_BYTES,
  AUDIOBOOK_ALIGNMENT_MODEL_REVISION,
  AUDIOBOOK_ALIGNMENT_SCHEMA_VERSION,
  AUDIOBOOK_ALIGNMENT_MAX_PART_BYTES,
  AUDIOBOOK_ALIGNMENT_MAX_PART_SECONDS,
  alignAudiobookTranscriptSegments,
  buildAudiobookAlignmentWindows,
  classifyAudiobookFile,
  createAudiobookManifest,
  resampleAudiobookWindow,
  sortAudiobookFiles,
  updateAudiobookAlignmentManifest,
} from "./audiobook-alignment.mjs";
import {
  disposeAudiobookTranscriber,
  prepareAudiobookTranscriber,
  transcribeAudiobookWindow,
} from "./audiobook-transcriber";
import {
  findTimedMediaAnchorAtTime,
  findTimedMediaPositionForToken,
  normalizeTimedMediaAnchors,
} from "./timed-media.mjs";
import {
  PODCAST_HOST_PRESET,
  applyNarratorPreset,
  isNarratorPresetActive,
} from "./narrator-presets.mjs";
import {
  DEFAULT_READER_LAYOUT,
  createReaderLayoutStyle,
  deriveReadingRulerGeometry,
  normalizeReaderLayout,
  selectFocusWindowTokens,
} from "./reader-layout.mjs";
import {
  addReaderDocument,
  attachReaderAudiobook,
  calculateLibraryProgress,
  commitReaderAudiobookTranscriptWindow,
  commitReaderPreparedNarrationChunk,
  countDocumentWords,
  filterLibraryEntries,
  getReaderNavigation,
  getReaderAudiobookSource,
  getReaderDocument,
  getReaderPdfSource,
  getReaderPreparedNarrationChunk,
  listReaderPreparedNarrationChunkMetadata,
  listReaderPreparedNarrationManifests,
  listReaderAudiobookManifests,
  listReaderAudiobookTranscriptWindows,
  loadReaderLibrary,
  openReaderDocument,
  openReaderDocumentMetadata,
  removeReaderDocument,
  removeReaderAudiobook,
  removeReaderPreparedNarration,
  renameReaderDocument,
  saveReaderDocument,
  saveReaderNavigation,
  saveReaderAudiobookManifest,
  saveReaderPreparedNarrationChunk,
  saveReaderPreparedNarrationManifest,
  sortLibraryEntries,
} from "./reader-library.mjs";
import { isReaderLifecycleRestoreCurrent } from "./reader-lifecycle.mjs";
import {
  MAX_POSITION_HISTORY,
  createPositionSnapshot,
  findDocumentMatches,
  isMeaningfulPositionJump,
  pushPositionHistory,
  resolveStoredPosition,
} from "./reader-navigation.mjs";
import {
  configureServiceWorker,
  getRuntimeAssetStorageDiagnostics,
} from "./service-worker-registration.mjs";

type DocumentKind = "demo" | "pdf" | "epub" | "txt";
type HighlightScope = "sentence" | "paragraph";
type ReadingTheme = "cream" | "white" | "dark";
type ReadingFont = "serif" | "sans" | "system";
type ReaderViewMode = "focus" | "page";
type SidebarView = "library" | "contents";
type FocusLineCount = 0 | 1 | 3 | 5;
type NarrationEngine = "device" | "offline" | "azure" | "audiobook";
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
  reusedAudio: boolean;
  synthesisMilliseconds: number;
  wasmThreads: number | null;
};

type PreparedNarrationManifest = {
  schemaVersion: number;
  kind: "offline-prepared-narration";
  documentId: string;
  documentFingerprint: string;
  profileKey: string;
  modelRevision: string;
  modelDtype: "fp32" | "fp16" | "q8";
  voice: OfflineVoiceId;
  rate: number;
  chunkCharacters: number;
  totalTokens: number;
  nextIndex: number;
  completedChunks: number;
  storedBytes: number;
  status: "preparing" | "paused" | "ready" | "error";
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

type PreparedNarrationChunkMetadata = {
  documentId: string;
  profileKey: string;
  startIndex: number;
  nextIndex: number;
  textFingerprint: string;
  sourceAudioByteLength: number;
  audioDurationSeconds: number;
  boundaries: Array<{
    audioOffsetSeconds: number;
    durationSeconds: number;
    text: string;
    textOffset: number;
    wordLength: number;
    tokenIndex: number;
  }>;
};

type PreparedNarrationJobState =
  | "idle"
  | "preparing"
  | "pausing"
  | "removing"
  | "error";

type PreparedNarrationExportManifest = {
  schemaVersion: number;
  exportSchemaVersion: number;
  kind: "prepared-narration-export";
  documentId: string;
  documentFingerprint: string;
  title: string;
  author: string;
  totalTokens: number;
  modelRevision: string;
  modelDtype: "fp32" | "fp16" | "q8";
  voice: string;
  rate: number;
  profileKey: string;
  parts: Array<{
    partIndex: number;
    filename: string;
    mimeType: string;
    durationSeconds: number;
    startIndex: number;
    nextIndex: number;
  }>;
  anchors: Array<{
    id: string;
    partIndex: number;
    timeSeconds: number;
    tokenIndex: number;
    confidence: number;
    source: "prepared";
    granularity: "word";
  }>;
  createdAt: number;
};

type LocalWritableFile = {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
};

type LocalFileHandle = {
  createWritable: () => Promise<LocalWritableFile>;
};

type LocalDirectoryHandle = {
  getFileHandle: (
    name: string,
    options: { create: boolean },
  ) => Promise<LocalFileHandle>;
};

type TimedMediaAnchor = {
  id: string;
  partIndex: number;
  timeSeconds: number;
  tokenIndex: number;
  confidence: number;
  source: "automatic" | "manual" | "imported" | "prepared";
  granularity: "phrase" | "sentence" | "word";
};

type AudiobookManifest = {
  schemaVersion: number;
  audiobookSchemaVersion: number;
  kind: "audiobook-alignment";
  documentId: string;
  documentFingerprint: string;
  title: string;
  author: string;
  totalTokens: number;
  audioId: string;
  modelId: string;
  modelRevision: string;
  parts: Array<{
    partIndex: number;
    filename: string;
    mimeType: string;
    durationSeconds: number;
    sourceByteLength: number;
    startIndex: number;
    nextIndex: number;
  }>;
  anchors: TimedMediaAnchor[];
  status: "attached" | "aligning" | "paused" | "ready" | "error";
  nextPartIndex: number;
  nextWindowIndex: number;
  processedWindows: number;
  totalWindows: number;
  alignmentConfidence: number;
  mismatchLikely: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

type AudiobookTranscriptWindow = {
  schemaVersion: number;
  documentId: string;
  audioId: string;
  partIndex: number;
  windowIndex: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
  segments: Array<{
    startSeconds: number;
    endSeconds: number;
    text: string;
  }>;
  modelRevision: string;
  createdAt: number;
};

type AudiobookPlaybackState = {
  audio: HTMLAudioElement;
  audioId: string;
  manifest: AudiobookManifest;
  partIndex: number;
  sessionId: number;
};

type OfflineAudioCache = {
  clear: () => void;
  get: (key: string) => OfflineSpeechResult | undefined;
  set: (
    key: string,
    value: OfflineSpeechResult,
    byteLength: number,
  ) => boolean;
};

type NarrationReadiness = {
  progress: number;
  label: string;
};

type BufferedPrefetchControls = {
  dispose: () => void;
  pause: () => number;
  resume: () => void;
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

type NarrationAudioPrime = {
  audio: HTMLAudioElement;
  audioUrl: string;
};

type ReaderDocument = {
  id: string;
  title: string;
  author: string;
  kind: DocumentKind;
  paragraphs: string[];
  pdfData?: Uint8Array;
  pdfPages?: PdfPageLayout[];
  pdfTextModelVersion?: number;
  pdfStorageVersion?: number;
  pdfRevision?: string;
  pdfPageCount?: number;
  pdfCompletedPages?: number;
  pdfImportStatus?: "importing" | "ready";
  wordCount?: number;
  pdfRuntime?: ProgressivePdfRuntime;
  pdfRuntimeVersion?: number;
  outline?: PdfOutlineItem[];
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

type PendingPdfTarget = {
  behavior: ScrollBehavior;
  clampOnComplete: boolean;
  closePanel: boolean;
  documentId: string;
  label?: string;
  pageNumber?: number | null;
  position?: StoredReaderPosition;
  preserveProgress: boolean;
  scroll: boolean;
  scrollTarget: "page" | "word";
  tokenIndex: number;
};

type PendingPdfProgressRestore = {
  documentId: string;
  targetIndex: number;
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

type ProgressivePdfRuntime = {
  client: PdfDocumentClient;
  revision: string;
  model: DocumentModel & {
    paragraphCharacterCounts: number[];
    sentenceStarts: number[];
    tokenParagraphs: number[];
    tokenSentences: number[];
  };
  store: ReturnType<typeof createPdfPageStore>;
  fallbackSource?: Blob;
  manifest: StoredPdfManifest;
  publishFrame: number | null;
  renderFallback: boolean;
  version: number;
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
  highlightScope: HighlightScope;
  follow: boolean;
  ruler: boolean;
  rate: number;
  narrationEngine: NarrationEngine;
  narrationPreferenceVersion: number;
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
  highlightScope: DEFAULT_HIGHLIGHT_SCOPE,
  follow: true,
  ruler: false,
  rate: 1,
  narrationEngine: DEFAULT_NARRATION_ENGINE,
  narrationPreferenceVersion: NARRATION_PREFERENCE_VERSION,
  voiceURI: "",
  offlineVoice: OFFLINE_DEFAULT_VOICE,
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
const OFFLINE_AUDIO_CACHE_BYTES = 12 * 1024 * 1024;
const OFFLINE_AUDIO_CACHE_ENTRIES = 6;
const OFFLINE_PACK_SIZE_LABEL =
  `${Math.round(OFFLINE_PACK_BYTES / 1_000_000)} MB`;

function formatStorageBytes(bytes: number) {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

function readLocalAudioDuration(file: File) {
  return new Promise<number>((resolve, reject) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    const cleanup = () => {
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error(`${file.name} has no readable audio duration.`));
        return;
      }
      resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      reject(
        new Error(
          `${file.name} could not be decoded by this browser. Convert it to DRM-free MP3, M4A, or WAV.`,
        ),
      );
    };
    audio.src = url;
    audio.load();
  });
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

async function parseEpub(file: File): Promise<ReaderDocument> {
  return (await parseEpubFile(file)) as ReaderDocument;
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
  const hasProgressivePages = Boolean(
    document.pdfRuntime?.store.getSummaries().length,
  );
  if (
    document.kind !== "pdf" ||
    (!hasProgressivePages && !document.pdfData?.length) ||
    (!hasProgressivePages && !document.pdfPages?.length)
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
  const [narrationReadiness, setNarrationReadiness] =
    useState<NarrationReadiness>({
      progress: 0,
      label: "Preparing narration…",
    });
  const [followPaused, setFollowPaused] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [sidebarSelection, setSidebarSelection] = useState<{
    documentId: string;
    view: SidebarView;
  }>({ documentId: DEMO_DOCUMENT.id, view: "library" });
  const sidebarView =
    sidebarSelection.documentId === readerDocument.id
      ? sidebarSelection.view
      : readerDocument.kind === "pdf"
        ? "contents"
        : "library";
  const [isImporting, setIsImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [offlinePackState, setOfflinePackState] =
    useState<OfflinePackState>("checking");
  const [offlineInstallProgress, setOfflineInstallProgress] = useState(0);
  const [offlineInstallLabel, setOfflineInstallLabel] = useState(
    "Checking the included voice…",
  );
  const [offlineUpgradeRequired, setOfflineUpgradeRequired] = useState(false);
  const [offlineRuntimeInfo, setOfflineRuntimeInfo] =
    useState<OfflineRuntimeInfo | null>(null);
  const [documentFingerprint, setDocumentFingerprint] = useState<string | null>(
    null,
  );
  const [preparedNarrationManifest, setPreparedNarrationManifest] =
    useState<PreparedNarrationManifest | null>(null);
  const [preparedNarrationMetadata, setPreparedNarrationMetadata] = useState<
    PreparedNarrationChunkMetadata[]
  >([]);
  const [preparedNarrationProfileCount, setPreparedNarrationProfileCount] =
    useState(0);
  const [preparedNarrationJobState, setPreparedNarrationJobState] =
    useState<PreparedNarrationJobState>("idle");
  const [preparedNarrationMessage, setPreparedNarrationMessage] = useState("");
  const [preparedExportState, setPreparedExportState] = useState<
    "idle" | "exporting" | "error"
  >("idle");
  const [preparedExportProgress, setPreparedExportProgress] = useState(0);
  const [preparedExportMessage, setPreparedExportMessage] = useState("");
  const [validatedTimingManifest, setValidatedTimingManifest] =
    useState<PreparedNarrationExportManifest | null>(null);
  const [audiobookManifest, setAudiobookManifest] =
    useState<AudiobookManifest | null>(null);
  const [audiobookProfileCount, setAudiobookProfileCount] = useState(0);
  const [audiobookJobState, setAudiobookJobState] = useState<
    "idle" | "attaching" | "aligning" | "pausing" | "removing" | "error"
  >("idle");
  const [audiobookProgress, setAudiobookProgress] = useState(0);
  const [audiobookMessage, setAudiobookMessage] = useState("");
  const [audiobookPlaybackPosition, setAudiobookPlaybackPosition] = useState({
    partIndex: 0,
    timeSeconds: 0,
    durationSeconds: 0,
  });
  const [audiobookPlaybackActive, setAudiobookPlaybackActive] =
    useState(false);
  const [runtimeAssetStorageBytes, setRuntimeAssetStorageBytes] = useState<
    number | null
  >(null);
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

  const model: DocumentModel = useMemo(() => {
    if (readerDocument.pdfRuntime) return readerDocument.pdfRuntime.model;
    return buildDocumentModel(readerDocument.paragraphs, {
      paragraphsStartSentences: readerDocument.kind === "pdf",
    }) as DocumentModel;
  }, [readerDocument.kind, readerDocument.paragraphs, readerDocument.pdfRuntime]);
  const activeToken = model.tokens[activeWord] ?? model.tokens[0];
  const activeParagraphIndex = activeToken?.paragraphIndex ?? 0;
  const activeHighlightIndex = deriveActiveHighlightIndex(
    model.tokens,
    activeWord,
    settings.highlightScope,
  );
  const documentOutline = useMemo(
    () => readerDocument.outline ?? [],
    [readerDocument.outline],
  );
  const activeOutlineItemId = useMemo(
    () => findActivePdfOutlineItemId(documentOutline, activeWord),
    [activeWord, documentOutline],
  );
  const tokenSentences = readerDocument.pdfRuntime?.model.tokenSentences ??
    model.tokens.map((token) => token.sentenceIndex);
  const tokenParagraphs = readerDocument.pdfRuntime?.model.tokenParagraphs ??
    model.tokens.map((token) => token.paragraphIndex);
  const visibleLibraryEntries = useMemo(
    () => filterLibraryEntries(libraryEntries, librarySearch) as LibraryEntry[],
    [libraryEntries, librarySearch],
  );
  const sentenceStarts = readerDocument.pdfRuntime?.model.sentenceStarts ??
    buildSentenceStartIndices(model.tokens);
  const bookmarkRows = useMemo(
    () => {
      void readerDocument.pdfRuntimeVersion;
      const runtime = readerDocument.pdfRuntime;
      const runtimeIsStreaming = runtime
        ? isProgressivePdfHydrating(
            runtime.manifest,
            runtime.store.getSummaries().length,
            runtime.model.tokens.length,
          )
        : false;
      return bookmarks.map((bookmark) => {
        const contextNotLoaded =
          runtimeIsStreaming &&
          model.tokens.length < requiredPdfPositionTokenCount(bookmark);
        return {
          bookmark,
          canOpenWhileLoading: contextNotLoaded,
          resolvedIndex: contextNotLoaded
            ? null
            : resolveStoredPosition(bookmark, model.tokens),
        };
      });
    },
    [
      bookmarks,
      model.tokens,
      readerDocument.pdfRuntime,
      readerDocument.pdfRuntimeVersion,
    ],
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
    () => {
      void readerDocument.pdfRuntimeVersion;
      return createPositionSnapshot(
        model.tokens,
        activeWord,
        0,
      ) as StoredReaderPosition | null;
    },
    [activeWord, model.tokens, readerDocument.pdfRuntimeVersion],
  );
  const supportsPageView =
    readerDocument.kind === "pdf" &&
    Boolean(
      readerDocument.pdfRuntime?.store.getSummaries().length ||
        (readerDocument.pdfData?.length && readerDocument.pdfPages?.length),
    );
  const podcastHostPresetActive = isNarratorPresetActive(settings);
  const progress = model.tokens.length
    ? Math.round(((activeWord + 1) / model.tokens.length) * 100)
    : 0;
  const activeVoiceReadiness =
    offlinePackState === "installing"
      ? normalizeNarrationReadiness(
          offlineInstallProgress,
          offlineInstallLabel,
        )
      : isPreparingSpeech
        ? narrationReadiness
        : null;
  const remainingSeconds =
    ((model.tokens.length - activeWord) / (180 * settings.rate)) * 60;
  const preparedNarrationProgress = preparedNarrationManifest
    ? Math.round(
        (preparedNarrationManifest.nextIndex /
          preparedNarrationManifest.totalTokens) *
          100,
      )
    : 0;
  const preparedNarrationEstimate = estimatePreparedNarrationStorage({
    remainingTokens:
      model.tokens.length - (preparedNarrationManifest?.nextIndex ?? 0),
    rate: settings.rate,
  });
  const canPrepareCurrentDocument =
    model.tokens.length > 0 &&
    (readerDocument.kind !== "pdf" ||
      readerDocument.pdfImportStatus === "ready");

  const readerRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<Map<number, HTMLSpanElement>>(new Map());
  const readingRulerRef = useRef<HTMLDivElement>(null);
  const readingRulerFrameRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timingManifestInputRef = useRef<HTMLInputElement>(null);
  const audiobookInputRef = useRef<HTMLInputElement>(null);
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
  const bufferedPrefetchControlsRef =
    useRef<BufferedPrefetchControls | null>(null);
  const narrationAudioPrimeRef = useRef<NarrationAudioPrime | null>(null);
  const speechSessionRef = useRef(0);
  const automaticOfflineInstallAttemptedRef = useRef(false);
  const offlineInstallAbortRef = useRef<AbortController | null>(null);
  const preparedNarrationAbortRef = useRef<AbortController | null>(null);
  const preparedNarrationJobPromiseRef = useRef<Promise<void> | null>(null);
  const preparedExportAbortRef = useRef<AbortController | null>(null);
  const audiobookAlignmentAbortRef = useRef<AbortController | null>(null);
  const audiobookAlignmentJobPromiseRef = useRef<Promise<void> | null>(null);
  const audiobookPlaybackRef = useRef<AudiobookPlaybackState | null>(null);
  const pendingOfflineStartIndexRef = useRef<number | null>(null);
  const offlineWarmRestoreAbortRef = useRef<AbortController | null>(null);
  const offlineWarmRestoreIdleRef = useRef<number | null>(null);
  const offlineWarmRestoreTimeoutRef = useRef<number | null>(null);
  const offlineWarmRestoreStartedRef = useRef(false);
  const offlineAudioCacheRef = useRef<OfflineAudioCache | null>(null);
  if (offlineAudioCacheRef.current === null) {
    offlineAudioCacheRef.current = createBoundedSpeechAudioCache({
      maxBytes: OFFLINE_AUDIO_CACHE_BYTES,
      maxEntries: OFFLINE_AUDIO_CACHE_ENTRIES,
    }) as OfflineAudioCache;
  }
  const programmaticScrollRef = useRef(false);
  const activeWordRef = useRef(0);
  const renderedActiveWordRef = useRef(0);
  const bookmarksRef = useRef<ReaderBookmark[]>([]);
  const positionHistoryRef = useRef<StoredReaderPosition[]>([]);
  const navigationSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activePdfRuntimeRef = useRef<ProgressivePdfRuntime | null>(null);
  const pendingPdfTargetRef = useRef<PendingPdfTarget | null>(null);
  const pendingPdfProgressRestoreRef =
    useRef<PendingPdfProgressRestore | null>(null);
  const pdfTargetScrollGenerationRef = useRef(0);
  const readerLifecycleGenerationRef = useRef(0);

  const positionReadingRuler = useCallback(() => {
    const ruler = readingRulerRef.current;
    if (!ruler) return;
    const reader = readerRef.current;
    const workspace = ruler.parentElement;
    const activeElement = wordRefs.current.get(activeWordRef.current);
    if (!reader || !workspace || !activeElement?.isConnected) {
      ruler.dataset.visible = "false";
      return;
    }

    const surface =
      activeElement.closest<HTMLElement>(".reading-copy, .pdf-page") ?? reader;
    const computedLineHeight = Number.parseFloat(
      window.getComputedStyle(activeElement).lineHeight,
    );
    const geometry = deriveReadingRulerGeometry({
      activeRect: activeElement.getBoundingClientRect(),
      workspaceRect: workspace.getBoundingClientRect(),
      viewportRect: reader.getBoundingClientRect(),
      surfaceRect: surface.getBoundingClientRect(),
      lineHeight: computedLineHeight,
    });
    if (!geometry) {
      ruler.dataset.visible = "false";
      return;
    }

    ruler.style.setProperty("--reading-ruler-left", `${geometry.left}px`);
    ruler.style.setProperty("--reading-ruler-top", `${geometry.top}px`);
    ruler.style.setProperty("--reading-ruler-width", `${geometry.width}px`);
    ruler.dataset.visible = "true";
  }, []);

  const scheduleReadingRulerPosition = useCallback(() => {
    if (readingRulerFrameRef.current !== null) return;
    readingRulerFrameRef.current = window.requestAnimationFrame(() => {
      readingRulerFrameRef.current = null;
      positionReadingRuler();
    });
  }, [positionReadingRuler]);

  const acceptVisiblePdfPosition = useCallback(() => {
    const runtime = activePdfRuntimeRef.current;
    if (!runtime) return false;
    const documentId = runtime.manifest.id;
    const accepted = acceptCurrentPdfPosition(
      pendingPdfTargetRef.current,
      pendingPdfProgressRestoreRef.current,
      documentId,
      activeWordRef.current,
    );
    if (!accepted.accepted) return false;
    pendingPdfTargetRef.current = accepted.pendingTarget;
    pendingPdfProgressRestoreRef.current = accepted.pendingRestore;
    pdfTargetScrollGenerationRef.current += 1;
    try {
      localStorage.setItem(
        `guided-reader-progress-${documentId}`,
        String(accepted.progressIndex),
      );
    } catch {
      // The in-memory position still wins when local storage is unavailable.
    }
    return true;
  }, []);

  const schedulePdfTargetScroll = useCallback(
    (
      runtime: ProgressivePdfRuntime,
      targetIndex: number,
      pageNumber: number | null | undefined,
      destination: PendingPdfTarget["scrollTarget"],
      behavior: ScrollBehavior,
    ) => {
      const generation = ++pdfTargetScrollGenerationRef.current;
      const deadline = performance.now() + 5_000;
      const attempt = () => {
        if (
          generation !== pdfTargetScrollGenerationRef.current ||
          activePdfRuntimeRef.current !== runtime ||
          activeWordRef.current !== targetIndex
        ) {
          return;
        }
        const word = wordRefs.current.get(targetIndex);
        const page = pageNumber
          ? document.getElementById(`pdf-page-${pageNumber}`)
          : null;
        const target = destination === "page" ? page ?? word : word ?? page;
        if (!target && performance.now() < deadline) {
          requestAnimationFrame(attempt);
          return;
        }
        if (!target) return;
        programmaticScrollRef.current = true;
        target.scrollIntoView({
          behavior,
          block: destination === "page" ? "start" : "center",
          inline: "nearest",
        });
        window.setTimeout(
          () => {
            if (generation === pdfTargetScrollGenerationRef.current) {
              programmaticScrollRef.current = false;
            }
          },
          behavior === "smooth" ? 700 : 80,
        );
      };
      requestAnimationFrame(attempt);
    },
    [],
  );

  const disposePdfRuntime = useCallback(
    (runtime?: ProgressivePdfRuntime | null) => {
      const target = runtime ?? activePdfRuntimeRef.current;
      if (!target) return;
      if (activePdfRuntimeRef.current === target) {
        activePdfRuntimeRef.current = null;
      }
      if (pendingPdfTargetRef.current?.documentId === target.manifest.id) {
        pendingPdfTargetRef.current = null;
      }
      pdfTargetScrollGenerationRef.current += 1;
      programmaticScrollRef.current = false;
      if (target.publishFrame !== null) cancelAnimationFrame(target.publishFrame);
      target.client.dispose();
      target.store.dispose();
    },
    [],
  );

  const startPdfRuntime = useCallback(
    async ({
      documentId,
      title,
      author,
      source,
      restoredWord = 0,
      readyView = "page",
    }: {
      documentId: string;
      title: string;
      author: string;
      source?: File;
      restoredWord?: number;
      readyView?: ReaderViewMode;
    }) => {
      const lifecycleGeneration = ++readerLifecycleGenerationRef.current;
      disposePdfRuntime();
      const safeRestoredWord = Math.max(0, Math.trunc(restoredWord));
      pendingPdfTargetRef.current =
        safeRestoredWord > 0
          ? {
              behavior: "auto",
              clampOnComplete: true,
              closePanel: false,
              documentId,
              preserveProgress: true,
              scroll: true,
              scrollTarget: readyView === "page" ? "page" : "word",
              tokenIndex: safeRestoredWord,
            }
          : null;
      pendingPdfProgressRestoreRef.current =
        safeRestoredWord > 0
          ? { documentId, targetIndex: safeRestoredWord }
          : null;
      const runtime: ProgressivePdfRuntime = {
        client: null as unknown as PdfDocumentClient,
        revision: "",
        model: createProgressiveDocumentModel() as ProgressivePdfRuntime["model"],
        store: createPdfPageStore({ maxBitmaps: 8 }),
        fallbackSource: source,
        manifest: {
          id: documentId,
          title,
          author,
          kind: "pdf",
          paragraphs: [],
          pdfCompletedPages: 0,
          pdfImportStatus: "importing",
          pdfPageCount: 0,
          pdfRevision: "",
          pdfStorageVersion: 1,
          pdfTextModelVersion: 0,
          wordCount: 0,
        },
        publishFrame: null,
        renderFallback: false,
        version: 0,
      };

      const publish = (immediate = false) => {
        if (activePdfRuntimeRef.current !== runtime) return;
        const update = () => {
          runtime.publishFrame = null;
          if (activePdfRuntimeRef.current !== runtime) return;
          setReaderDocument({
            ...runtime.manifest,
            paragraphs: [],
            pdfRuntime: runtime,
            pdfRuntimeVersion: runtime.version,
          });
        };
        if (immediate) {
          if (runtime.publishFrame !== null) {
            cancelAnimationFrame(runtime.publishFrame);
            runtime.publishFrame = null;
          }
          update();
        } else if (runtime.publishFrame === null) {
          runtime.publishFrame = requestAnimationFrame(update);
        }
      };

      const resolvePendingTarget = (complete = false) => {
        const pending = pendingPdfTargetRef.current;
        if (!pending || pending.documentId !== documentId) return null;
        const requestedIndex = Math.max(0, Math.trunc(pending.tokenIndex));
        const resolution = resolveProgressivePdfTarget({
          clampOnComplete: pending.clampOnComplete,
          complete,
          position: pending.position,
          requestedIndex,
          tokens: runtime.model.tokens,
        });
        const targetIndex = resolution.index;

        if (targetIndex === null) {
          if (resolution.status === "unavailable") {
            pendingPdfTargetRef.current = null;
            if (pending.preserveProgress) {
              pendingPdfProgressRestoreRef.current = null;
            }
            if (pending.label) {
              setNotice(
                `${pending.label} could not be matched safely in the current document.`,
              );
            }
          }
          return null;
        }

        pendingPdfTargetRef.current = null;
        if (pending.preserveProgress) {
          pendingPdfProgressRestoreRef.current = {
            documentId,
            targetIndex,
          };
        }
        setActiveWord(targetIndex);
        activeWordRef.current = targetIndex;
        setFollowPaused(false);
        if (pending.closePanel) setShowBookmarks(false);
        if (pending.label) {
          setNotice(`${pending.label} opened. Press Play to narrate from here.`);
        }

        const summaries = runtime.store.getSummaries() as Array<{
          pageNumber: number;
          wordStart: number;
        }>;
        const resolvedPageNumber = loadedPdfPageNumber(
          summaries,
          targetIndex,
          pending.pageNumber,
        );
        return {
          behavior: pending.behavior,
          pageNumber: resolvedPageNumber,
          scroll: pending.scroll,
          scrollTarget: pending.scrollTarget,
          targetIndex,
        };
      };

      const client = new PdfDocumentClient({
        onPage(document, page, first) {
          if (activePdfRuntimeRef.current !== runtime) return;
          if (runtime.store.getPage(page.pageNumber)) {
            return;
          }
          appendPdfDocumentChunk(runtime.model, page.model);
          runtime.store.appendPage(page);
          runtime.manifest = document;
          runtime.revision = document.pdfRevision;
          runtime.version += 1;
          if (first) {
            setViewMode(readyView);
          }
          const resolvedTarget = resolvePendingTarget();
          publish(first);
          if (resolvedTarget?.scroll) {
            schedulePdfTargetScroll(
              runtime,
              resolvedTarget.targetIndex,
              resolvedTarget.pageNumber,
              resolvedTarget.scrollTarget,
              resolvedTarget.behavior,
            );
          }
          if (first) {
            setLibraryEntries((current) => {
              const existing = current.find((entry) => entry.id === document.id);
              const timestamp = Date.now();
              return sortLibraryEntries([
                {
                  id: document.id,
                  title: document.title,
                  author: document.author,
                  kind: "pdf",
                  wordCount: document.wordCount,
                  createdAt: existing?.createdAt ?? timestamp,
                  lastOpenedAt: timestamp,
                },
                ...current.filter((entry) => entry.id !== document.id),
              ]) as LibraryEntry[];
            });
          }
        },
        onBitmap(message: Extract<PdfWorkerMessage, { type: "bitmap" }>) {
          if (activePdfRuntimeRef.current !== runtime) {
            message.bitmap.close();
            return;
          }
          runtime.store.setBitmap(message.pageNumber, {
            bitmap: message.bitmap,
            height: message.height,
            scale: message.scale,
            width: message.width,
          });
        },
        onComplete(document) {
          if (activePdfRuntimeRef.current !== runtime) return;
          runtime.manifest = document;
          runtime.version += 1;
          const resolvedTarget = resolvePendingTarget(true);
          setLibraryEntries((current) =>
            sortLibraryEntries(
              current.map((entry) =>
                entry.id === document.id
                  ? { ...entry, wordCount: document.wordCount }
                  : entry,
              ),
            ) as LibraryEntry[],
          );
          publish(true);
          if (resolvedTarget?.scroll) {
            schedulePdfTargetScroll(
              runtime,
              resolvedTarget.targetIndex,
              resolvedTarget.pageNumber,
              resolvedTarget.scrollTarget,
              resolvedTarget.behavior,
            );
          }
        },
        onRenderFallback(reason) {
          if (activePdfRuntimeRef.current !== runtime) return;
          runtime.renderFallback = true;
          runtime.version += 1;
          setNotice(reason);
          publish(true);
          if (!runtime.fallbackSource) {
            void getReaderPdfSource(documentId).then((storedSource) => {
              if (
                storedSource &&
                activePdfRuntimeRef.current === runtime &&
                !runtime.fallbackSource
              ) {
                runtime.fallbackSource = storedSource;
                runtime.version += 1;
                publish(true);
              }
            });
          }
        },
        onReset() {
          if (activePdfRuntimeRef.current !== runtime) return;
          const previousTarget = activeWordRef.current;
          const pendingTarget = pendingPdfTargetRef.current;
          if (pendingTarget?.documentId === documentId) {
            pendingPdfTargetRef.current = {
              ...pendingTarget,
              preserveProgress: true,
            };
            pendingPdfProgressRestoreRef.current = {
              documentId,
              targetIndex: pendingTarget.tokenIndex,
            };
          } else if (
            previousTarget > 0 &&
            pendingTarget?.documentId !== documentId
          ) {
            pendingPdfTargetRef.current = {
              behavior: "auto",
              clampOnComplete: true,
              closePanel: false,
              documentId,
              preserveProgress: true,
              scroll: true,
              scrollTarget: readyView === "page" ? "page" : "word",
              tokenIndex: previousTarget,
            };
            pendingPdfProgressRestoreRef.current = {
              documentId,
              targetIndex: previousTarget,
            };
          }
          runtime.store.clear();
          runtime.model = createProgressiveDocumentModel() as ProgressivePdfRuntime["model"];
          runtime.manifest = {
            ...runtime.manifest,
            outline: [],
            pdfCompletedPages: 0,
            pdfImportStatus: "importing",
            wordCount: 0,
          };
          runtime.version += 1;
          wordRefs.current.clear();
          setActiveWord(0);
          activeWordRef.current = 0;
          publish(true);
        },
        onError(message, outcome) {
          if (activePdfRuntimeRef.current !== runtime) return;
          setNotice(message);
          if (!outcome || outcome === "resumable") return;
          const pendingTarget =
            pendingPdfTargetRef.current?.documentId === documentId
              ? pendingPdfTargetRef.current
              : null;
          const pendingRestore =
            pendingPdfProgressRestoreRef.current?.documentId === documentId
              ? pendingPdfProgressRestoreRef.current
              : null;
          disposePdfRuntime(runtime);
          wordRefs.current.clear();
          setActiveWord(0);
          activeWordRef.current = 0;
          void reconcilePdfTerminalOutcome({
            documentId,
            generation: lifecycleGeneration,
            getDocument: getReaderDocument,
            getGeneration: () => readerLifecycleGenerationRef.current,
            loadLibrary: loadReaderLibrary,
            onLibrary(snapshot: { entries: LibraryEntry[] }) {
              setLibraryEntries(snapshot.entries as LibraryEntry[]);
            },
            onRecovered(recovered: ReaderDocument) {
                const recoveredModel = buildDocumentModel(
                  recovered.paragraphs,
                  { paragraphsStartSentences: true },
                ) as DocumentModel;
                const requestedIndex =
                  pendingTarget?.tokenIndex ?? pendingRestore?.targetIndex ?? 0;
                const resolvedIndex = pendingTarget?.position
                  ? resolveStoredPosition(
                      pendingTarget.position,
                      recoveredModel.tokens,
                    )
                  : Math.min(
                      Math.max(0, Math.trunc(requestedIndex)),
                      Math.max(0, recoveredModel.tokens.length - 1),
                    );
                const nextIndex = resolvedIndex ?? 0;
                if (pendingTarget?.preserveProgress || pendingRestore) {
                  pendingPdfProgressRestoreRef.current = {
                    documentId,
                    targetIndex: nextIndex,
                  };
                }
                setReaderDocument(recovered);
                setActiveWord(nextIndex);
                activeWordRef.current = nextIndex;
                setViewMode("focus");
            },
            onDiscarded() {
              if (
                pendingPdfProgressRestoreRef.current?.documentId === documentId
              ) {
                pendingPdfProgressRestoreRef.current = null;
              }
              try {
                localStorage.removeItem(`guided-reader-progress-${documentId}`);
              } catch {
                // IndexedDB cleanup still succeeds if local storage is unavailable.
              }
              setReaderDocument(DEMO_DOCUMENT);
              setViewMode("focus");
            },
            outcome,
          });
        },
      });
      runtime.client = client;
      activePdfRuntimeRef.current = runtime;
      setReaderDocument({
        ...runtime.manifest,
        paragraphs: [],
        pdfRuntime: runtime,
        pdfRuntimeVersion: 0,
      });
      setActiveWord(0);
      activeWordRef.current = 0;
      setViewMode("focus");
      const firstPage = source
        ? await client.import(
            source,
            documentId,
            title,
            Math.min(2, Math.max(1.25, window.devicePixelRatio || 1)),
          )
        : await client.open(
            documentId,
            Math.min(2, Math.max(1.25, window.devicePixelRatio || 1)),
          );
      if (activePdfRuntimeRef.current !== runtime) {
        throw new DOMException("The PDF operation was replaced.", "AbortError");
      }
      runtime.revision = firstPage.revision;
      return runtime;
    },
    [disposePdfRuntime, schedulePdfTargetScroll],
  );

  useEffect(() => () => disposePdfRuntime(), [disposePdfRuntime]);

  useLayoutEffect(() => {
    activeWordRef.current = activeWord;
    const previous = wordRefs.current.get(renderedActiveWordRef.current);
    if (previous) {
      delete previous.dataset.activeToken;
      if (previous.id === "active-spoken-word") previous.removeAttribute("id");
    }
    const current = wordRefs.current.get(activeWord);
    if (current) {
      current.dataset.activeToken = "true";
      current.id = "active-spoken-word";
    }
    renderedActiveWordRef.current = activeWord;
    positionReadingRuler();
  }, [activeWord, positionReadingRuler, readerDocument.id, viewMode]);

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
    if (viewMode !== "focus" || settings.focusLines === 0) {
      return;
    }

    const focusSegments =
      readingPage.querySelectorAll<HTMLElement>("[data-focus-token]");

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

  useLayoutEffect(() => {
    if (!settings.ruler) return;
    positionReadingRuler();
  }, [
    activeWord,
    positionReadingRuler,
    readerDocument.id,
    readerLayoutRevision,
    settings.font,
    settings.fontSize,
    settings.letterSpacing,
    settings.lineHeight,
    settings.maxLineWidth,
    settings.paragraphSpacing,
    settings.ruler,
    settings.wordSpacing,
    viewMode,
  ]);

  useEffect(() => {
    if (!settings.ruler) return;
    const reader = readerRef.current;
    if (!reader) return;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleReadingRulerPosition);
    observer?.observe(reader);
    reader.addEventListener("scroll", scheduleReadingRulerPosition, {
      passive: true,
    });
    window.addEventListener("resize", scheduleReadingRulerPosition);
    scheduleReadingRulerPosition();

    return () => {
      observer?.disconnect();
      reader.removeEventListener("scroll", scheduleReadingRulerPosition);
      window.removeEventListener("resize", scheduleReadingRulerPosition);
      if (readingRulerFrameRef.current !== null) {
        window.cancelAnimationFrame(readingRulerFrameRef.current);
        readingRulerFrameRef.current = null;
      }
    };
  }, [scheduleReadingRulerPosition, settings.ruler]);

  useEffect(() => {
    let cancelled = false;
    preparedExportAbortRef.current?.abort();
    bookmarksRef.current = [];
    positionHistoryRef.current = [];

    const loadNavigation = async () => {
      await Promise.resolve();
      if (cancelled) return;
      setValidatedTimingManifest(null);
      setPreparedExportMessage("");
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
      preparedNarrationAbortRef.current?.abort();
    };
  }, [readerDocument.id]);

  useEffect(() => {
    let cancelled = false;
    const canPrepare =
      model.tokens.length > 0 &&
      (readerDocument.kind !== "pdf" ||
        readerDocument.pdfImportStatus === "ready");
    if (!canPrepare) {
      queueMicrotask(() => {
        if (cancelled) return;
        setDocumentFingerprint(null);
        setPreparedNarrationManifest(null);
        setPreparedNarrationMetadata([]);
        setPreparedNarrationProfileCount(0);
        setPreparedNarrationMessage("");
      });
      return () => {
        cancelled = true;
      };
    }

    const loadPreparedNarration = async () => {
      try {
        if (readerDocument.kind === "demo") {
          // Keep the built-in sample out of the private library while giving
          // its prepared audio a durable document owner in IndexedDB.
          await saveReaderDocument(DEMO_DOCUMENT);
          if (cancelled) return;
        }
        const fingerprint = await fingerprintPreparedNarrationText(
          model.fullText,
        );
        if (cancelled) return;
        setDocumentFingerprint(fingerprint);
        const manifests = (await listReaderPreparedNarrationManifests(
          readerDocument.id,
        )) as PreparedNarrationManifest[];
        if (cancelled) return;

        const compatible = manifests.filter(
          (manifest) =>
            manifest.documentFingerprint === fingerprint &&
            manifest.totalTokens === model.tokens.length &&
            manifest.modelRevision === OFFLINE_MODEL_REVISION,
        );
        setPreparedNarrationProfileCount(compatible.length);
        for (const incompatible of manifests.filter(
          (manifest) =>
            manifest.documentFingerprint !== fingerprint ||
            manifest.totalTokens !== model.tokens.length ||
            manifest.modelRevision !== OFFLINE_MODEL_REVISION,
        )) {
          void removeReaderPreparedNarration(
            readerDocument.id,
            incompatible.profileKey,
          ).catch(() => undefined);
        }

        const currentDtype = getOfflineSpeechReadiness().modelDtype;
        const selected = compatible
          .filter(
            (manifest) =>
              manifest.voice === settings.offlineVoice &&
              manifest.rate === settings.rate,
          )
          .sort(
            (left, right) =>
              Number(right.modelDtype === currentDtype) -
                Number(left.modelDtype === currentDtype) ||
              Number(right.status === "ready") -
                Number(left.status === "ready") ||
              right.updatedAt - left.updatedAt,
        )[0] ?? null;
        if (cancelled) return;
        if (!selected) {
          setPreparedNarrationManifest(null);
          setPreparedNarrationMetadata([]);
          setPreparedNarrationMessage("");
          return;
        }
        const metadata = (await listReaderPreparedNarrationChunkMetadata(
          readerDocument.id,
          selected.profileKey,
        )) as PreparedNarrationChunkMetadata[];
        if (cancelled) return;
        setPreparedNarrationManifest(selected);
        setPreparedNarrationMetadata(metadata);
        setPreparedNarrationMessage(
          selected.status === "ready"
            ? `${metadata.length} offline chunks are ready after reload.`
            : `Prepared through word ${selected.nextIndex.toLocaleString()} of ${selected.totalTokens.toLocaleString()}.`,
        );
      } catch {
        if (!cancelled) {
          setDocumentFingerprint(null);
          setPreparedNarrationManifest(null);
          setPreparedNarrationMetadata([]);
          setPreparedNarrationProfileCount(0);
          setPreparedNarrationMessage(
            "Prepared narration storage is unavailable in this browser.",
          );
        }
      }
    };
    void loadPreparedNarration();

    return () => {
      cancelled = true;
      preparedNarrationAbortRef.current?.abort();
    };
  }, [
    model.fullText,
    model.tokens.length,
    readerDocument.id,
    readerDocument.kind,
    readerDocument.pdfImportStatus,
    settings.offlineVoice,
    settings.rate,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!documentFingerprint || readerDocument.kind === "demo") {
      queueMicrotask(() => {
        if (cancelled) return;
        setAudiobookManifest(null);
        setAudiobookProfileCount(0);
        setAudiobookMessage("");
      });
      return () => {
        cancelled = true;
      };
    }
    const loadAudiobooks = async () => {
      try {
        const manifests = (await listReaderAudiobookManifests(
          readerDocument.id,
        )) as AudiobookManifest[];
        if (cancelled) return;
        const compatible = manifests.filter(
          (manifest) =>
            manifest.documentFingerprint === documentFingerprint &&
            manifest.totalTokens === model.tokens.length,
        );
        setAudiobookProfileCount(compatible.length);
        for (const incompatible of manifests.filter(
          (manifest) =>
            manifest.documentFingerprint !== documentFingerprint ||
            manifest.totalTokens !== model.tokens.length,
        )) {
          void removeReaderAudiobook(
            readerDocument.id,
            incompatible.audioId,
          ).catch(() => undefined);
        }
        const selected = compatible[0] ?? null;
        setAudiobookManifest(selected);
        if (selected) {
          setAudiobookProgress(
            selected.totalWindows
              ? Math.round(
                  (selected.processedWindows / selected.totalWindows) * 100,
                )
              : selected.status === "ready"
                ? 100
                : 0,
          );
          setAudiobookMessage(
            selected.status === "ready"
              ? selected.mismatchLikely
                ? "Alignment finished, but this may be a different edition. Weak regions remain unsynced."
                : `Audiobook sync is ready with ${Math.round(
                    selected.alignmentConfidence * 100,
                  )}% high-confidence phrase coverage.`
              : `Audiobook attached. ${selected.processedWindows} of ${selected.totalWindows} alignment windows are stored.`,
          );
        } else {
          setAudiobookProgress(0);
          setAudiobookMessage("");
        }
      } catch {
        if (!cancelled) {
          setAudiobookManifest(null);
          setAudiobookProfileCount(0);
          setAudiobookMessage(
            "Local audiobook storage is unavailable in this browser.",
          );
        }
      }
    };
    void loadAudiobooks();
    return () => {
      cancelled = true;
      audiobookAlignmentAbortRef.current?.abort();
    };
  }, [
    documentFingerprint,
    model.tokens.length,
    readerDocument.id,
    readerDocument.kind,
  ]);

  useEffect(() => {
    let restoreTimer: number | undefined;
    let cancelled = false;
    let disposeServiceWorker = () => {};
    let expectedRestoreGeneration = readerLifecycleGenerationRef.current;
    const restoreIsCurrent = () =>
      isReaderLifecycleRestoreCurrent({
        cancelled,
        currentGeneration: readerLifecycleGenerationRef.current,
        restoreGeneration: expectedRestoreGeneration,
      });
    try {
      const savedSettings = localStorage.getItem("guided-reader-settings");
      const savedProgress = localStorage.getItem(
        `guided-reader-progress-${DEMO_DOCUMENT.id}`,
      );
      restoreTimer = window.setTimeout(() => {
        if (cancelled) return;
        try {
          if (savedSettings) {
            const parsedSettings = JSON.parse(savedSettings) as Record<
              string,
              unknown
            >;
            const storedSettings = migrateReaderHighlightSettings(
              parsedSettings,
            ) as Partial<ReaderSettings>;
            const storedLayout = normalizeReaderLayout(parsedSettings);
            const narrationPreference =
              restoreNarrationPreference(parsedSettings);
            setSettings((current) => ({
              ...current,
              ...storedSettings,
              ...storedLayout,
              ...narrationPreference,
              focusLines: storedLayout.focusLines as FocusLineCount,
              offlineVoice: normalizeOfflineVoiceId(
                parsedSettings.offlineVoice,
              ),
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
        if (!restoreIsCurrent()) return;
        const entries = snapshot.entries as LibraryEntry[];
        setLibraryEntries(entries);
        if (!snapshot.activeDocumentId) return;
        const activeEntry = entries.find(
          (entry) => entry.id === snapshot.activeDocumentId,
        );
        if (activeEntry?.kind === "pdf") {
          await openReaderDocumentMetadata(activeEntry.id);
          if (!restoreIsCurrent()) return;
          let readyView: ReaderViewMode = "page";
          try {
            if (
              localStorage.getItem(`guided-reader-view-${activeEntry.id}`) ===
              "focus"
            ) {
              readyView = "focus";
            }
          } catch {
            // The page view remains the default when preferences are unavailable.
          }
          if (!restoreIsCurrent()) return;
          const restorePromise = startPdfRuntime({
            documentId: activeEntry.id,
            title: activeEntry.title,
            author: activeEntry.author,
            restoredWord: storedProgressFor(activeEntry.id) ?? 0,
            readyView,
          });
          expectedRestoreGeneration = readerLifecycleGenerationRef.current;
          await restorePromise;
          if (!restoreIsCurrent()) return;
          return;
        }
        const storedDocument = (await getReaderDocument(
          snapshot.activeDocumentId,
        )) as ReaderDocument | null;
        if (!storedDocument || !restoreIsCurrent()) return;
        const storedProgress = clampStoredProgress(storedDocument);
        setReaderDocument(storedDocument);
        setActiveWord(storedProgress);
        activeWordRef.current = storedProgress;
        setViewMode(initialViewFor(storedDocument));
      })
      .catch(() => {
        if (restoreIsCurrent()) {
          setNotice(
            "LineLight could not open the private library. The starter document is still available.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLibraryReady(true);
      });

    if ("serviceWorker" in navigator) {
      configureServiceWorker(navigator.serviceWorker, {
        development: import.meta.env.DEV,
      })
        .then((dispose) => {
          if (cancelled) dispose();
          else disposeServiceWorker = dispose;
        })
        .catch(() => undefined);
    }

    getOfflineVoicePackStatus()
      .then(({ installed, upgradeRequired }) => {
        if (!cancelled) {
          setOfflinePackState(installed ? "ready" : "missing");
          setOfflineUpgradeRequired(upgradeRequired);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOfflinePackState("missing");
          setOfflineUpgradeRequired(false);
        }
      });

    return () => {
      cancelled = true;
      if (restoreTimer) window.clearTimeout(restoreTimer);
      disposeServiceWorker();
      disposeOfflineSpeechWorker();
    };
  }, [startPdfRuntime]);

  useEffect(() => {
    if (
      !showSettings ||
      settings.narrationEngine !== "offline" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }
    let cancelled = false;
    getRuntimeAssetStorageDiagnostics(navigator.serviceWorker)
      .then((diagnostics) => {
        if (!cancelled) {
          setRuntimeAssetStorageBytes(
            diagnostics.available ? diagnostics.retainedBytes : null,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setRuntimeAssetStorageBytes(null);
      });
    return () => {
      cancelled = true;
    };
  }, [offlinePackState, settings.narrationEngine, showSettings]);

  useEffect(() => {
    if (
      !settingsRestored ||
      settings.narrationEngine !== "offline" ||
      offlinePackState !== "ready" ||
      isImporting
    ) {
      return;
    }

    // Fetch and retain the content-hashed worker while the app is online. The
    // model stays unloaded until initialization, but an installed pack can now
    // start after the network disappears or the app shell is upgraded.
    preloadOfflineSpeechRuntime();
  }, [
    isImporting,
    offlinePackState,
    settings.narrationEngine,
    settingsRestored,
  ]);

  useEffect(() => {
    if (!settingsRestored) return;
    try {
      localStorage.setItem("guided-reader-settings", JSON.stringify(settings));
    } catch {
      // Ignore private-browsing storage limitations.
    }
  }, [settings, settingsRestored]);

  useEffect(() => {
    const pendingRestore = pendingPdfProgressRestoreRef.current;
    if (
      shouldDeferPdfProgressWrite(
        pendingRestore,
        readerDocument.id,
        activeWord,
      )
    ) {
      return;
    }
    if (pendingRestore?.documentId === readerDocument.id) {
      pendingPdfProgressRestoreRef.current = null;
    }
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
    audio.onplaying = null;
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

  const releaseNarrationAudioPrime = useCallback(() => {
    const prime = narrationAudioPrimeRef.current;
    if (!prime) return;
    narrationAudioPrimeRef.current = null;
    prime.audio.pause();
    prime.audio.removeAttribute("src");
    prime.audio.load();
    URL.revokeObjectURL(prime.audioUrl);
  }, []);

  const primeNarrationAudioOutput = useCallback(() => {
    releaseNarrationAudioPrime();
    const audio = new Audio();
    const audioUrl = URL.createObjectURL(
      new Blob([createSilentPcmWav()], { type: "audio/wav" }),
    );
    const prime = { audio, audioUrl };
    narrationAudioPrimeRef.current = prime;
    audio.preload = "auto";
    audio.loop = true;
    // Keep the element non-muted so Chromium opens the real output path. The
    // PCM samples themselves are zero, so this remains inaudible.
    audio.muted = false;
    audio.volume = 0.01;
    audio.src = audioUrl;
    audio.load();
    void audio.play().catch(() => {
      // A non-trusted automatic start may be rejected. Narration generation is
      // still valid, and Stop can race the play promise with an AbortError.
      if (narrationAudioPrimeRef.current === prime) {
        releaseNarrationAudioPrime();
      }
    });
  }, [releaseNarrationAudioPrime]);

  const clearBufferedPlayback = useCallback(() => {
    releaseNarrationAudioPrime();
    bufferedPrefetchControlsRef.current?.dispose();
    bufferedPrefetchControlsRef.current = null;
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
    audiobookPlaybackRef.current = null;
    setAudiobookPlaybackActive(false);
  }, [releaseBufferedAudio, releaseNarrationAudioPrime]);

  const cancelOfflineWarmRestore = useCallback(
    (
      { abortActive = true }: { abortActive?: boolean } = {},
    ) => {
    if (
      offlineWarmRestoreIdleRef.current !== null &&
      typeof window !== "undefined" &&
      "cancelIdleCallback" in window
    ) {
      window.cancelIdleCallback(offlineWarmRestoreIdleRef.current);
    }
    offlineWarmRestoreIdleRef.current = null;
    if (
      offlineWarmRestoreTimeoutRef.current !== null &&
      typeof window !== "undefined"
    ) {
      window.clearTimeout(offlineWarmRestoreTimeoutRef.current);
    }
    offlineWarmRestoreTimeoutRef.current = null;
    if (
      shouldAbortOfflineWarmRestore({
        abortActive,
        started: offlineWarmRestoreStartedRef.current,
      })
    ) {
      offlineWarmRestoreAbortRef.current?.abort();
      offlineWarmRestoreAbortRef.current = null;
      offlineWarmRestoreStartedRef.current = false;
    }
  }, []);

  const scheduleOfflineWarmRestore = useCallback(
    (voice: OfflineVoiceId) => {
      if (offlineWarmRestoreAbortRef.current) {
        return offlineWarmRestoreAbortRef.current;
      }

      const abortController = new AbortController();
      offlineWarmRestoreAbortRef.current = abortController;
      offlineWarmRestoreStartedRef.current = false;
      const restore = () => {
        offlineWarmRestoreIdleRef.current = null;
        offlineWarmRestoreTimeoutRef.current = null;
        if (abortController.signal.aborted) return;
        offlineWarmRestoreStartedRef.current = true;
        void initializeOfflineSpeech({
          voice,
          signal: abortController.signal,
          warm: false,
        })
          .catch(() => undefined)
          .finally(() => {
            if (offlineWarmRestoreAbortRef.current === abortController) {
              offlineWarmRestoreAbortRef.current = null;
              offlineWarmRestoreStartedRef.current = false;
            }
          });
      };

      const scheduleTimeout = window.setTimeout.bind(window);
      if ("requestIdleCallback" in window) {
        offlineWarmRestoreIdleRef.current = window.requestIdleCallback(
          restore,
          { timeout: OFFLINE_WARM_IDLE_TIMEOUT_MS },
        );
      } else {
        offlineWarmRestoreTimeoutRef.current = scheduleTimeout(restore, 0);
      }
      return abortController;
    },
    [],
  );

  const stopSpeech = useCallback(
    (
      { preservePendingOfflineStart = false }: {
        preservePendingOfflineStart?: boolean;
      } = {},
    ) => {
      if (!preservePendingOfflineStart) {
        pendingOfflineStartIndexRef.current = null;
      }
      cancelOfflineWarmRestore();
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
    },
    [
      cancelOfflineWarmRestore,
      clearBufferedPlayback,
      clearFallbackTimer,
      clearSpeechStartTimer,
    ],
  );

  useEffect(() => stopSpeech, [stopSpeech]);

  useEffect(() => {
    if (
      !libraryReady ||
      !settingsRestored ||
      settings.narrationEngine !== "offline" ||
      offlinePackState !== "ready" ||
      isImporting ||
      offlineWarmRestoreAbortRef.current ||
      getOfflineSpeechReadiness().state === "ready"
    ) {
      return;
    }

    // Once the document has painted, load the stored model in its worker. A
    // later Play can join initialization already in flight instead of paying
    // the whole cold-start cost after the click.
    const scheduledController = scheduleOfflineWarmRestore(
      settings.offlineVoice,
    );
    return () => {
      // Import can schedule its replacement before this effect's cleanup runs.
      // Never let an old cleanup cancel the newly-owned controller.
      if (
        offlineWarmRestoreAbortRef.current === scheduledController
      ) {
        cancelOfflineWarmRestore();
      }
    };
  }, [
    cancelOfflineWarmRestore,
    isImporting,
    libraryReady,
    offlinePackState,
    scheduleOfflineWarmRestore,
    settings.narrationEngine,
    settings.offlineVoice,
    settingsRestored,
  ]);

  const downloadOfflineVoice = useCallback(
    async (automatic = false) => {
      if (
        offlinePackState === "installing" ||
        offlineInstallAbortRef.current
      ) {
        return;
      }

      const abortController = new AbortController();
      offlineInstallAbortRef.current = abortController;
      stopSpeech({ preservePendingOfflineStart: true });
      setOfflinePackState("installing");
      setOfflineInstallProgress(0);
      setOfflineInstallLabel("Preparing LineLight's included offline voice…");
      setNotice(
        automatic
          ? "Preparing LineLight's included offline voice in the background…"
          : "",
      );

      try {
        const [storageEstimate, packBytes, retainedPackBytes] =
          await Promise.all([
            navigator.storage?.estimate?.(),
            getOfflineVoicePackBytes(),
            getOfflineVoicePackRetainedBytes(),
          ]);
        const storageHeadroom = evaluateOfflineStorageHeadroom(
          packBytes,
          storageEstimate,
          retainedPackBytes,
        );
        if (storageHeadroom.sufficient === false) {
          throw new OfflineSpeechError(
            `The included offline voice needs about ${Math.ceil(
              storageHeadroom.requiredBytes / 1_000_000,
            )} MB of free site storage while it is prepared. Free space and try again.`,
          );
        }
        await navigator.storage?.persist?.().catch(() => false);
        await installOfflineVoicePack({
          voice: settings.offlineVoice,
          signal: abortController.signal,
          onProgress: ({ progress, label }) => {
            setOfflineInstallProgress(progress);
            setOfflineInstallLabel(label);
          },
        });

        const installedStatus = await getOfflineVoicePackStatus();
        if (
          !installedStatus.installed ||
          installedStatus.upgradeRequired
        ) {
          throw new OfflineSpeechError(
            "The included voice finished loading, but the browser did not keep every file. Check storage permissions and try again.",
          );
        }

        // Never let audio retained from a previous model mask the newly
        // validated native-44.1 kHz runtime after migration commits.
        offlineAudioCacheRef.current?.clear();
        setOfflinePackState("ready");
        setOfflineUpgradeRequired(false);
        setOfflineInstallProgress(100);
        setOfflineInstallLabel("The included offline voices are ready.");
        setNotice(
          "LineLight's included natural voice is ready. Narration text now stays on this device.",
        );
      } catch (error) {
        const recoveredStatus = await getOfflineVoicePackStatus();
        const storedPackAvailable = recoveredStatus.installed;
        setOfflineUpgradeRequired(recoveredStatus.upgradeRequired);
        if (error instanceof DOMException && error.name === "AbortError") {
          automaticOfflineInstallAttemptedRef.current = false;
          setOfflinePackState(
            storedPackAvailable ? "ready" : "missing",
          );
          setOfflineInstallProgress(0);
          setOfflineInstallLabel(
            "Offline voice preparation paused while the document opens.",
          );
          return;
        }
        setOfflinePackState(
          storedPackAvailable ? "ready" : "error",
        );
        const message =
          error instanceof Error
            ? error.message
            : "The included offline voice could not be prepared.";
        const displayMessage = message;
        setOfflineInstallLabel(displayMessage);
        setNotice(
          storedPackAvailable
            ? recoveredStatus.upgradeRequired
              ? `${displayMessage} The stored compatibility voice is still available offline.`
              : "The included offline voice is stored and ready."
            : automatic
            ? `${displayMessage} Offline natural remains selected.`
            : displayMessage,
        );
      } finally {
        if (offlineInstallAbortRef.current === abortController) {
          offlineInstallAbortRef.current = null;
        }
      }
    },
    [
      offlinePackState,
      settings.offlineVoice,
      stopSpeech,
    ],
  );

  useEffect(() => {
    if (!shouldScheduleOfflinePreparation({
      attempted: automaticOfflineInstallAttemptedRef.current,
      engine: settings.narrationEngine,
      importing: isImporting,
      packState: offlinePackState,
      settingsRestored,
    })) {
      return;
    }

    let idleCallbackId: number | null = null;
    const delayId = window.setTimeout(() => {
      const prepare = () => {
        automaticOfflineInstallAttemptedRef.current = true;
        void downloadOfflineVoice(true);
      };
      if ("requestIdleCallback" in window) {
        idleCallbackId = window.requestIdleCallback(prepare, { timeout: 1_000 });
      } else {
        prepare();
      }
    }, OFFLINE_INSTALL_IDLE_DELAY_MS);

    return () => {
      window.clearTimeout(delayId);
      if (idleCallbackId !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleCallbackId);
      }
    };
  }, [
    downloadOfflineVoice,
    isImporting,
    offlinePackState,
    settings.narrationEngine,
    settingsRestored,
  ]);

  const deleteOfflineVoice = useCallback(async () => {
    pendingOfflineStartIndexRef.current = null;
    stopSpeech();
    offlineAudioCacheRef.current?.clear();
    setOfflinePackState("removing");
    setOfflineInstallLabel("Removing the included offline voice…");

    try {
      await removeOfflineVoicePack();
      automaticOfflineInstallAttemptedRef.current = false;
      setOfflinePackState("missing");
      setOfflineUpgradeRequired(false);
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

  const prepareWholeBookNarration = useCallback(() => {
    if (preparedNarrationJobPromiseRef.current) return;
    const run = async () => {
      if (
        !model.tokens.length ||
        (readerDocument.kind === "pdf" &&
          readerDocument.pdfImportStatus !== "ready")
      ) {
        setPreparedNarrationMessage(
          "Wait for the imported book to finish loading before preparing it.",
        );
        return;
      }
      if (!documentFingerprint) {
        setPreparedNarrationMessage(
          "LineLight is still checking this book. Try again in a moment.",
        );
        return;
      }
      if (offlinePackState !== "ready") {
        setPreparedNarrationMessage(
          "Prepare the included offline voices first, then prepare this book.",
        );
        void downloadOfflineVoice(false);
        return;
      }

      stopSpeech();
      cancelOfflineWarmRestore({ abortActive: false });
      const abortController = new AbortController();
      preparedNarrationAbortRef.current = abortController;
      setPreparedNarrationJobState("preparing");
      setPreparedNarrationMessage("Loading the selected offline voice…");

      let currentManifest: PreparedNarrationManifest | null = null;
      try {
        const runtime = await initializeOfflineSpeech({
          voice: settings.offlineVoice,
          signal: abortController.signal,
          warm: false,
          onProgress: ({ label }) => setPreparedNarrationMessage(label),
        });
        const modelDtype = runtime.modelDtype;
        if (modelDtype !== OFFLINE_MODEL_DTYPE) {
          throw new OfflineSpeechError(
            "The active offline model cannot create a durable voice profile.",
          );
        }
        const profileKey = createPreparedNarrationProfileKey({
          modelRevision: OFFLINE_MODEL_REVISION,
          modelDtype,
          voice: settings.offlineVoice,
          rate: settings.rate,
        });
        const manifests = (await listReaderPreparedNarrationManifests(
          readerDocument.id,
        )) as PreparedNarrationManifest[];
        currentManifest = manifests.find(
          (manifest) =>
            manifest.profileKey === profileKey &&
            manifest.documentFingerprint === documentFingerprint &&
            manifest.totalTokens === model.tokens.length,
        ) ?? null;
        const manifestWasNew = currentManifest === null;
        if (currentManifest?.status === "ready") {
          setPreparedNarrationManifest(currentManifest);
          setPreparedNarrationJobState("idle");
          setPreparedNarrationMessage("This exact voice and pace are ready offline.");
          return;
        }
        currentManifest = (currentManifest ??
          createPreparedNarrationManifest({
            documentId: readerDocument.id,
            documentFingerprint,
            profileKey,
            modelRevision: OFFLINE_MODEL_REVISION,
            modelDtype,
            voice: settings.offlineVoice,
            rate: settings.rate,
            totalTokens: model.tokens.length,
          })) as PreparedNarrationManifest;

        const storage = estimatePreparedNarrationStorage({
          remainingTokens: model.tokens.length - currentManifest.nextIndex,
          rate: settings.rate,
        });
        const storageEstimate = await navigator.storage?.estimate?.();
        if (
          Number.isFinite(storageEstimate?.quota) &&
          Number.isFinite(storageEstimate?.usage) &&
          storage.estimatedBytes >
            (storageEstimate!.quota! - storageEstimate!.usage!) * 0.9
        ) {
          throw new DOMException(
            `This voice needs about ${formatStorageBytes(storage.estimatedBytes)} more site storage. Free browser storage and resume.`,
            "QuotaExceededError",
          );
        }
        await navigator.storage?.persist?.().catch(() => false);
        currentManifest = {
          ...currentManifest,
          status: "preparing",
          error: null,
          updatedAt: Date.now(),
        };
        if (!(await saveReaderPreparedNarrationManifest(currentManifest))) {
          throw new Error("This book is no longer in the private library.");
        }
        if (manifestWasNew) {
          setPreparedNarrationProfileCount((current) => current + 1);
        }
        setPreparedNarrationManifest(currentManifest);
        setPreparedNarrationMessage(
          `Estimated remaining storage: ${formatStorageBytes(storage.estimatedBytes)}.`,
        );

        while (currentManifest.nextIndex < model.tokens.length) {
          if (abortController.signal.aborted) {
            throw new DOMException("Preparation paused.", "AbortError");
          }
          const chunk = buildSpeechChunk(
            model.fullText,
            model.tokens,
            currentManifest.nextIndex,
            PREPARED_NARRATION_CHUNK_CHARACTERS,
          );
          if (!chunk) break;
          setPreparedNarrationMessage(
            `Generating word ${chunk.startIndex.toLocaleString()} of ${model.tokens.length.toLocaleString()}…`,
          );
          const generated = await synthesizeOfflineSpeech({
            text: chunk.text,
            voice: settings.offlineVoice,
            rate: settings.rate,
            signal: abortController.signal,
            onProgress: ({ label }) => setPreparedNarrationMessage(label),
          });
          if (generated.modelDtype !== currentManifest.modelDtype) {
            throw new OfflineSpeechError(
              "The offline model changed during preparation. Resume to start a compatible profile.",
            );
          }
          const textFingerprint = await fingerprintPreparedNarrationText(
            chunk.text,
          );
          const encoded = await encodePreparedNarrationAudio(
            generated.audioData,
          );
          const boundaries = generated.boundaries.map((boundary) => ({
            ...boundary,
            tokenIndex: findWordAtCharacter(
              model.tokens,
              chunk.startChar + boundary.textOffset,
            ),
          }));
          const record = {
            schemaVersion: PREPARED_NARRATION_SCHEMA_VERSION,
            documentId: readerDocument.id,
            profileKey: currentManifest.profileKey,
            startIndex: chunk.startIndex,
            nextIndex: chunk.nextIndex,
            textFingerprint,
            audioData: encoded.audioData,
            audioByteLength: encoded.audioByteLength,
            audioEncoding: encoded.audioEncoding,
            sourceAudioByteLength: encoded.sourceAudioByteLength,
            mimeType: PREPARED_NARRATION_AUDIO_MIME_TYPE,
            audioDurationSeconds: generated.audioDurationSeconds,
            boundaries,
            device: generated.device,
            modelDtype: generated.modelDtype,
            synthesisMilliseconds: generated.synthesisMilliseconds,
            wasmThreads: generated.wasmThreads,
            retention: PREPARED_NARRATION_BOOK_RETENTION,
            createdAt: Date.now(),
          };
          const committed = (await commitReaderPreparedNarrationChunk(
            currentManifest,
            record,
          )) as PreparedNarrationManifest | null;
          if (!committed) {
            throw new Error("This prepared narration profile was superseded.");
          }
          currentManifest = committed;
          setPreparedNarrationManifest(committed);
          setPreparedNarrationMetadata((current) => [
            ...current.filter(
              (metadata) => metadata.startIndex !== record.startIndex,
            ),
            {
              documentId: record.documentId,
              profileKey: record.profileKey,
              startIndex: record.startIndex,
              nextIndex: record.nextIndex,
              textFingerprint: record.textFingerprint,
              sourceAudioByteLength: record.sourceAudioByteLength,
              audioDurationSeconds: record.audioDurationSeconds,
              boundaries: record.boundaries,
            },
          ].sort((left, right) => left.startIndex - right.startIndex));
          const estimate = await navigator.storage?.estimate?.();
          if (
            Number.isFinite(estimate?.quota) &&
            Number.isFinite(estimate?.usage) &&
            estimate!.usage! >= estimate!.quota! * 0.98
          ) {
            throw new DOMException(
              "Browser storage is nearly full. Existing chunks are safe; free space and resume.",
              "QuotaExceededError",
            );
          }
        }

        setPreparedNarrationJobState("idle");
        setPreparedNarrationMessage(
          `${currentManifest.completedChunks} chunks are ready offline after reload.`,
        );
        setNotice("This book is prepared for offline narration.");
      } catch (error) {
        const paused =
          abortController.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError");
        if (currentManifest && currentManifest.status !== "ready") {
          const message = paused
            ? null
            : error instanceof Error
              ? error.message
              : "Prepared narration stopped unexpectedly.";
          const savedManifest = {
            ...currentManifest,
            status: paused ? "paused" as const : "error" as const,
            error: message,
            updatedAt: Date.now(),
          };
          await saveReaderPreparedNarrationManifest(savedManifest).catch(
            () => false,
          );
          setPreparedNarrationManifest(savedManifest);
        }
        setPreparedNarrationJobState(paused ? "idle" : "error");
        const message = paused
          ? "Preparation paused. Completed chunks are safe."
          : error instanceof Error
            ? error.message
            : "Prepared narration stopped unexpectedly.";
        setPreparedNarrationMessage(message);
        if (!paused) setNotice(message);
      } finally {
        if (preparedNarrationAbortRef.current === abortController) {
          preparedNarrationAbortRef.current = null;
        }
      }
    };

    const job = run();
    preparedNarrationJobPromiseRef.current = job;
    void job.finally(() => {
      if (preparedNarrationJobPromiseRef.current === job) {
        preparedNarrationJobPromiseRef.current = null;
      }
    });
  }, [
    cancelOfflineWarmRestore,
    documentFingerprint,
    downloadOfflineVoice,
    model.fullText,
    model.tokens,
    offlinePackState,
    readerDocument.id,
    readerDocument.kind,
    readerDocument.pdfImportStatus,
    settings.offlineVoice,
    settings.rate,
    stopSpeech,
  ]);

  const pausePreparedNarration = useCallback(() => {
    if (!preparedNarrationAbortRef.current) return;
    setPreparedNarrationJobState("pausing");
    setPreparedNarrationMessage("Pausing after the current safe boundary…");
    preparedNarrationAbortRef.current.abort();
  }, []);

  const removePreparedNarrationProfile = useCallback(async () => {
    const profileKey = preparedNarrationManifest?.profileKey;
    if (!profileKey) return;
    preparedNarrationAbortRef.current?.abort();
    await preparedNarrationJobPromiseRef.current?.catch(() => undefined);
    stopSpeech();
    setPreparedNarrationJobState("removing");
    try {
      await removeReaderPreparedNarration(readerDocument.id, profileKey);
      setPreparedNarrationManifest(null);
      setPreparedNarrationMetadata([]);
      setPreparedNarrationProfileCount((current) => Math.max(0, current - 1));
      setPreparedNarrationMessage("Selected prepared voice and pace removed.");
    } finally {
      setPreparedNarrationJobState("idle");
    }
  }, [preparedNarrationManifest?.profileKey, readerDocument.id, stopSpeech]);

  const removeAllPreparedNarration = useCallback(async () => {
    preparedNarrationAbortRef.current?.abort();
    await preparedNarrationJobPromiseRef.current?.catch(() => undefined);
    stopSpeech();
    setPreparedNarrationJobState("removing");
    try {
      await removeReaderPreparedNarration(readerDocument.id);
      setPreparedNarrationManifest(null);
      setPreparedNarrationMetadata([]);
      setPreparedNarrationProfileCount(0);
      setPreparedNarrationMessage("All prepared narration for this book was removed.");
    } finally {
      setPreparedNarrationJobState("idle");
    }
  }, [readerDocument.id, stopSpeech]);

  const exportPreparedBook = useCallback(() => {
    if (
      preparedExportAbortRef.current ||
      preparedNarrationManifest?.status !== "ready" ||
      !documentFingerprint
    ) {
      return;
    }
    const run = async () => {
      const abortController = new AbortController();
      preparedExportAbortRef.current = abortController;
      setPreparedExportState("exporting");
      setPreparedExportProgress(0);
      setPreparedExportMessage("Choose where to save the WAV parts…");

      let directory: LocalDirectoryHandle | null = null;
      const picker = (
        window as typeof window & {
          showDirectoryPicker?: (options: {
            mode: "readwrite";
          }) => Promise<LocalDirectoryHandle>;
        }
      ).showDirectoryPicker;
      if (picker) {
        try {
          directory = await picker({ mode: "readwrite" });
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            setPreparedExportState("idle");
            setPreparedExportMessage("Export canceled before any files were written.");
            preparedExportAbortRef.current = null;
            return;
          }
          throw error;
        }
      }

      try {
        const chunks = (await listReaderPreparedNarrationChunkMetadata(
          readerDocument.id,
          preparedNarrationManifest.profileKey,
        )) as PreparedNarrationChunkMetadata[];
        if (
          !chunks.length ||
          chunks[0].startIndex !== 0 ||
          chunks.at(-1)?.nextIndex !== model.tokens.length
        ) {
          throw new Error(
            "Prepared narration is incomplete. Resume preparation before exporting.",
          );
        }
        const saveFile = async (filename: string, data: Blob) => {
          if (abortController.signal.aborted) {
            throw new DOMException("Export canceled.", "AbortError");
          }
          if (directory) {
            const handle = await directory.getFileHandle(filename, {
              create: true,
            });
            const writable = await handle.createWritable();
            await writable.write(data);
            await writable.close();
            return;
          }
          const url = URL.createObjectURL(data);
          const link = document.createElement("a");
          link.href = url;
          link.download = filename;
          link.hidden = true;
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
        };
        const manifest = (await exportPreparedNarration({
          chunks,
          loadAudio: async (chunk) => {
            const metadata = chunk as PreparedNarrationChunkMetadata;
            const record = await getReaderPreparedNarrationChunk({
              documentId: readerDocument.id,
              profileKey: preparedNarrationManifest.profileKey,
              startIndex: metadata.startIndex,
              nextIndex: metadata.nextIndex,
              textFingerprint: metadata.textFingerprint,
            });
            if (!record) {
              throw new Error(
                "A prepared audio chunk is missing. Resume preparation before exporting.",
              );
            }
            return decodePreparedNarrationAudio(record);
          },
          saveFile,
          manifest: {
            documentId: readerDocument.id,
            documentFingerprint,
            title: readerDocument.title,
            author: readerDocument.author,
            totalTokens: model.tokens.length,
            modelRevision: preparedNarrationManifest.modelRevision,
            modelDtype: preparedNarrationManifest.modelDtype,
            voice: preparedNarrationManifest.voice,
            rate: preparedNarrationManifest.rate,
            profileKey: preparedNarrationManifest.profileKey,
          },
          signal: abortController.signal,
          onProgress: ({ completedParts, totalParts }) => {
            setPreparedExportProgress(
              Math.round((completedParts / totalParts) * 100),
            );
            setPreparedExportMessage(
              `Saved WAV part ${completedParts} of ${totalParts}.`,
            );
          },
        })) as PreparedNarrationExportManifest;
        setValidatedTimingManifest(manifest);
        setPreparedExportProgress(100);
        setPreparedExportState("idle");
        setPreparedExportMessage(
          `Saved ${manifest.parts.length} bounded WAV ${
            manifest.parts.length === 1 ? "part" : "parts"
          } and the timing sidecar.`,
        );
      } catch (error) {
        const canceled =
          abortController.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError");
        setPreparedExportState(canceled ? "idle" : "error");
        setPreparedExportMessage(
          canceled
            ? "Export canceled. Prepared source audio was not changed."
            : error instanceof Error
              ? error.message
              : "Prepared narration could not be exported.",
        );
      } finally {
        if (preparedExportAbortRef.current === abortController) {
          preparedExportAbortRef.current = null;
        }
      }
    };
    void run();
  }, [
    documentFingerprint,
    model.tokens.length,
    preparedNarrationManifest,
    readerDocument.author,
    readerDocument.id,
    readerDocument.title,
  ]);

  const cancelPreparedExport = useCallback(() => {
    preparedExportAbortRef.current?.abort();
  }, []);

  const importTimingManifest = useCallback(
    async (file?: File) => {
      if (!file) return;
      try {
        if (file.size > 16 * 1024 * 1024) {
          throw new Error("This timing sidecar is unexpectedly large.");
        }
        const parsed: unknown = JSON.parse(await file.text());
        if (!isPreparedNarrationExportManifest(parsed)) {
          throw new Error("This is not a supported LineLight timing sidecar.");
        }
        if (
          !documentFingerprint ||
          !matchesPreparedNarrationExport(parsed, {
            documentId: readerDocument.id,
            documentFingerprint,
            totalTokens: model.tokens.length,
          })
        ) {
          throw new Error(
            "This timing sidecar belongs to a different book or edition.",
          );
        }
        const manifest = parsed as PreparedNarrationExportManifest;
        const attachedAudioNamesMatch = Boolean(
          audiobookManifest &&
            audiobookManifest.parts.length === manifest.parts.length &&
            audiobookManifest.parts.every(
              (part, index) =>
                part.filename === manifest.parts[index].filename,
            ),
        );
        const matchesAttachedAudio = Boolean(
          audiobookManifest &&
            matchesPreparedNarrationExportAudioParts(
              manifest,
              audiobookManifest.parts,
            ),
        );
        if (attachedAudioNamesMatch && !matchesAttachedAudio) {
          throw new Error(
            "The timing sidecar filenames match, but the attached audio durations differ.",
          );
        }
        setValidatedTimingManifest(manifest);
        if (audiobookManifest && matchesAttachedAudio) {
          const synchronized: AudiobookManifest = {
            ...audiobookManifest,
            anchors: manifest.anchors,
            status: "ready",
            nextPartIndex: audiobookManifest.parts.length,
            nextWindowIndex: 0,
            processedWindows: audiobookManifest.totalWindows,
            alignmentConfidence: 1,
            mismatchLikely: false,
            error: null,
            updatedAt: Date.now(),
          };
          await saveReaderAudiobookManifest(synchronized);
          setAudiobookManifest(synchronized);
          setAudiobookProgress(100);
          setAudiobookMessage(
            "Timing sidecar, WAV filenames, and durations matched. Audiobook sync is ready.",
          );
        }
        setPreparedExportState("idle");
        setPreparedExportMessage(
          matchesAttachedAudio
            ? "Timing sidecar verified and applied to the attached WAV files."
            : `Timing sidecar verified for ${manifest.parts.length} WAV ${
                manifest.parts.length === 1 ? "part" : "parts"
              }.`,
        );
      } catch (error) {
        setValidatedTimingManifest(null);
        setPreparedExportState("error");
        setPreparedExportMessage(
          error instanceof Error
            ? error.message
            : "This timing sidecar could not be opened.",
        );
      } finally {
        if (timingManifestInputRef.current) {
          timingManifestInputRef.current.value = "";
        }
      }
    },
    [
      audiobookManifest,
      documentFingerprint,
      model.tokens.length,
      readerDocument.id,
    ],
  );

  const attachAudiobookFiles = useCallback(
    async (selectedFiles?: FileList | File[]) => {
      const files = sortAudiobookFiles(
        Array.from(selectedFiles ?? []) as File[],
      ) as File[];
      if (!files.length) return;
      setAudiobookJobState("attaching");
      setAudiobookProgress(0);
      setAudiobookMessage("Checking local audiobook chapters…");
      try {
        if (!documentFingerprint || readerDocument.kind === "demo") {
          throw new Error("Import a book before attaching its audiobook.");
        }
        for (const file of files) {
          const classification = classifyAudiobookFile(file);
          if (!classification.supported) {
            throw new Error(`${file.name}: ${classification.reason}`);
          }
        }
        const sourceBytes = files.reduce((total, file) => total + file.size, 0);
        const describedFiles: Array<{
          name: string;
          type: string;
          size: number;
          durationSeconds: number;
        }> = [];
        for (let index = 0; index < files.length; index += 1) {
          setAudiobookMessage(
            `Reading chapter metadata ${index + 1} of ${files.length}…`,
          );
          const durationSeconds = await readLocalAudioDuration(files[index]);
          describedFiles.push({
            name: files[index].name,
            type: files[index].type,
            size: files[index].size,
            durationSeconds,
          });
          setAudiobookProgress(
            Math.round(((index + 1) / files.length) * 35),
          );
        }
        const timingSidecarNamesMatch = Boolean(
          validatedTimingManifest &&
            validatedTimingManifest.parts.length === describedFiles.length &&
            validatedTimingManifest.parts.every(
              (part, index) => part.filename === describedFiles[index].name,
            ),
        );
        const willUseTimingSidecar = Boolean(
          validatedTimingManifest &&
            matchesPreparedNarrationExportAudioParts(
              validatedTimingManifest,
              describedFiles,
            ),
        );
        if (timingSidecarNamesMatch && !willUseTimingSidecar) {
          throw new Error(
            "The timing sidecar filenames match, but the selected audio durations differ.",
          );
        }
        const requiredBytes =
          sourceBytes +
          (willUseTimingSidecar ? 0 : AUDIOBOOK_ALIGNMENT_MODEL_ESTIMATED_BYTES);
        const storage = await navigator.storage?.estimate?.();
        if (
          Number.isFinite(storage?.quota) &&
          Number.isFinite(storage?.usage) &&
          requiredBytes > (storage!.quota! - storage!.usage!) * 0.9
        ) {
          throw new DOMException(
            `Attaching and aligning this audiobook may need ${formatStorageBytes(requiredBytes)} of site storage. Free browser storage and try again.`,
            "QuotaExceededError",
          );
        }
        await navigator.storage?.persist?.().catch(() => false);
        const audioId = globalThis.crypto?.randomUUID?.() ??
          `audiobook-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let manifest = createAudiobookManifest({
          documentId: readerDocument.id,
          documentFingerprint,
          title: readerDocument.title,
          author: readerDocument.author,
          totalTokens: model.tokens.length,
          audioId,
          files: describedFiles,
        }) as AudiobookManifest;
        if (willUseTimingSidecar && validatedTimingManifest) {
          manifest = {
            ...manifest,
            anchors: validatedTimingManifest.anchors,
            status: "ready",
            nextPartIndex: manifest.parts.length,
            nextWindowIndex: 0,
            processedWindows: manifest.totalWindows,
            alignmentConfidence: 1,
            mismatchLikely: false,
            updatedAt: Date.now(),
          };
        }
        if (!(await attachReaderAudiobook(manifest, files))) {
          throw new Error("This book is no longer in the private library.");
        }
        setAudiobookManifest(manifest);
        setAudiobookProfileCount((current) => current + 1);
        setAudiobookProgress(manifest.status === "ready" ? 100 : 0);
        setAudiobookJobState("idle");
        setSettings((current) => ({
          ...current,
          narrationEngine: "audiobook",
        }));
        setAudiobookMessage(
          manifest.status === "ready"
            ? "Exported WAV timing matched exactly. Audiobook sync is ready without speech recognition."
            : `Stored ${files.length} local ${
                files.length === 1 ? "audio file" : "chapter files"
              }. Start local alignment when ready.`,
        );
      } catch (error) {
        setAudiobookJobState("error");
        setAudiobookMessage(
          error instanceof Error
            ? error.message
            : "This audiobook could not be attached.",
        );
      } finally {
        if (audiobookInputRef.current) audiobookInputRef.current.value = "";
      }
    },
    [
      documentFingerprint,
      model.tokens.length,
      readerDocument.author,
      readerDocument.id,
      readerDocument.kind,
      readerDocument.title,
      validatedTimingManifest,
    ],
  );

  const alignAttachedAudiobook = useCallback(() => {
    if (!audiobookManifest || audiobookAlignmentJobPromiseRef.current) return;
    const manifestAtStart = audiobookManifest;
    const abortController = new AbortController();
    audiobookAlignmentAbortRef.current = abortController;
    let audioContext: AudioContext | null = null;
    const run = async () => {
      setAudiobookJobState("aligning");
      setAudiobookMessage(
        "Loading the private speech-recognition model on this device…",
      );
      let currentManifest = manifestAtStart;
      try {
        audioContext = new AudioContext();
        const oversizedPart = currentManifest.parts.find(
          (part) =>
            part.sourceByteLength > AUDIOBOOK_ALIGNMENT_MAX_PART_BYTES ||
            part.durationSeconds > AUDIOBOOK_ALIGNMENT_MAX_PART_SECONDS,
        );
        if (oversizedPart) {
          throw new Error(
            `${oversizedPart.filename} is too large for bounded local alignment. Split it into chapters under ${Math.round(
              AUDIOBOOK_ALIGNMENT_MAX_PART_SECONDS / 60,
            )} minutes and ${formatStorageBytes(
              AUDIOBOOK_ALIGNMENT_MAX_PART_BYTES,
            )}, then attach those files in order.`,
          );
        }
        if (currentManifest.processedWindows === 0) {
          const storage = await navigator.storage?.estimate?.();
          if (
            Number.isFinite(storage?.quota) &&
            Number.isFinite(storage?.usage) &&
            AUDIOBOOK_ALIGNMENT_MODEL_ESTIMATED_BYTES >
              (storage!.quota! - storage!.usage!) * 0.9
          ) {
            throw new DOMException(
              `Local alignment needs about ${formatStorageBytes(
                AUDIOBOOK_ALIGNMENT_MODEL_ESTIMATED_BYTES,
              )} for its speech-recognition model. Free browser storage and resume.`,
              "QuotaExceededError",
            );
          }
        }
        const windows = buildAudiobookAlignmentWindows(
          currentManifest.parts,
        ) as Array<{
          partIndex: number;
          windowIndex: number;
          startSeconds: number;
          endSeconds: number;
        }>;
        const existing = (await listReaderAudiobookTranscriptWindows(
          currentManifest.documentId,
          currentManifest.audioId,
        )) as AudiobookTranscriptWindow[];
        const storedKeys = new Set(
          existing.map(
            (window) => `${window.partIndex}:${window.windowIndex}`,
          ),
        );
        const firstMissing = windows.find(
          (window) =>
            !storedKeys.has(`${window.partIndex}:${window.windowIndex}`),
        );
        currentManifest = {
          ...currentManifest,
          status: "aligning",
          processedWindows: storedKeys.size,
          nextPartIndex: firstMissing?.partIndex ?? currentManifest.parts.length,
          nextWindowIndex: firstMissing?.windowIndex ?? 0,
          error: null,
          updatedAt: Date.now(),
        };
        await saveReaderAudiobookManifest(currentManifest);
        setAudiobookManifest(currentManifest);
        if (firstMissing) {
          await prepareAudiobookTranscriber({
            signal: abortController.signal,
            onProgress: ({ progress, label }) => {
              setAudiobookMessage(label);
              if (progress !== null && !storedKeys.size) {
                setAudiobookProgress(Math.round(progress * 0.08));
              }
            },
          });
        }

        let decodedPartIndex = -1;
        let decodedPart: AudioBuffer | null = null;
        for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
          const window = windows[windowIndex];
          const key = `${window.partIndex}:${window.windowIndex}`;
          if (storedKeys.has(key)) continue;
          if (abortController.signal.aborted) {
            throw new DOMException("Alignment paused.", "AbortError");
          }
          if (decodedPartIndex !== window.partIndex) {
            decodedPart = null;
            const source = await getReaderAudiobookSource(
              currentManifest.documentId,
              currentManifest.audioId,
              window.partIndex,
            );
            if (!source?.blob) {
              throw new Error("A local audiobook chapter is missing.");
            }
            setAudiobookMessage(
              `Decoding ${currentManifest.parts[window.partIndex].filename} locally…`,
            );
            decodedPart = await audioContext.decodeAudioData(
              await source.blob.arrayBuffer(),
            );
            decodedPartIndex = window.partIndex;
          }
          if (!decodedPart) {
            throw new Error("This audiobook chapter could not be decoded.");
          }
          const startSample = Math.max(
            0,
            Math.floor(window.startSeconds * decodedPart.sampleRate),
          );
          const endSample = Math.min(
            decodedPart.length,
            Math.ceil(window.endSeconds * decodedPart.sampleRate),
          );
          const channels = Array.from(
            { length: decodedPart.numberOfChannels },
            (_, channel) =>
              decodedPart!.getChannelData(channel).subarray(
                startSample,
                endSample,
              ),
          );
          const pcm = resampleAudiobookWindow(
            channels,
            decodedPart.sampleRate,
          );
          setAudiobookMessage(
            `Aligning chapter ${window.partIndex + 1}, window ${
              window.windowIndex + 1
            }…`,
          );
          const transcript = await transcribeAudiobookWindow({
            audio: pcm,
            windowStartSeconds: window.startSeconds,
            windowEndSeconds: window.endSeconds,
            signal: abortController.signal,
          });
          const record: AudiobookTranscriptWindow = {
            schemaVersion: AUDIOBOOK_ALIGNMENT_SCHEMA_VERSION,
            documentId: currentManifest.documentId,
            audioId: currentManifest.audioId,
            partIndex: window.partIndex,
            windowIndex: window.windowIndex,
            startSeconds: window.startSeconds,
            endSeconds: window.endSeconds,
            text: transcript.text,
            segments: transcript.segments,
            modelRevision: AUDIOBOOK_ALIGNMENT_MODEL_REVISION,
            createdAt: Date.now(),
          };
          storedKeys.add(key);
          const nextMissing = windows
            .slice(windowIndex + 1)
            .find(
              (candidate) =>
                !storedKeys.has(
                  `${candidate.partIndex}:${candidate.windowIndex}`,
                ),
            );
          const progressed = {
            ...currentManifest,
            status: "aligning" as const,
            processedWindows: storedKeys.size,
            nextPartIndex:
              nextMissing?.partIndex ?? currentManifest.parts.length,
            nextWindowIndex: nextMissing?.windowIndex ?? 0,
            error: null,
            updatedAt: Date.now(),
          };
          await commitReaderAudiobookTranscriptWindow(progressed, record);
          currentManifest = progressed;
          setAudiobookManifest(progressed);
          setAudiobookProgress(
            Math.round((storedKeys.size / windows.length) * 100),
          );
        }
        decodedPart = null;

        const transcriptWindows = (await listReaderAudiobookTranscriptWindows(
          currentManifest.documentId,
          currentManifest.audioId,
        )) as AudiobookTranscriptWindow[];
        const alignedSegments = transcriptWindows.flatMap((window) => {
          const nextWindow = transcriptWindows.find(
            (candidate) =>
              candidate.partIndex === window.partIndex &&
              candidate.windowIndex === window.windowIndex + 1,
          );
          return window.segments
            .filter(
              (segment) =>
                !nextWindow ||
                (segment.startSeconds + segment.endSeconds) / 2 <
                  nextWindow.startSeconds,
            )
            .map((segment, segmentIndex) => ({
              id: `asr-${window.partIndex}-${window.windowIndex}-${segmentIndex}`,
              partIndex: window.partIndex,
              startSeconds: segment.startSeconds,
              endSeconds: segment.endSeconds,
              text: segment.text,
            }));
        });
        const alignment = alignAudiobookTranscriptSegments(
          alignedSegments,
          model.tokens.map((token) => ({
            index: token.index,
            text: token.text,
          })),
        );
        const completed = updateAudiobookAlignmentManifest(
          currentManifest,
          {
            anchors: alignment.anchors,
            summary: alignment.summary,
            complete: true,
            nextPartIndex: currentManifest.parts.length,
            nextWindowIndex: 0,
            processedWindows: windows.length,
          },
        ) as AudiobookManifest;
        await saveReaderAudiobookManifest(completed);
        setAudiobookManifest(completed);
        setAudiobookProgress(100);
        setAudiobookJobState("idle");
        setAudiobookMessage(
          completed.mismatchLikely
            ? "Alignment completed, but the audiobook may be a different edition. Only strong phrase matches will move the reading highlight."
            : `Alignment ready. ${alignment.summary.confidentSegments} of ${alignment.summary.totalSegments} spoken phrases matched confidently; weak regions remain unsynced.`,
        );
      } catch (error) {
        const paused =
          abortController.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError");
        const failedManifest: AudiobookManifest = {
          ...currentManifest,
          status: paused ? "paused" : "error",
          error: paused
            ? null
            : error instanceof Error
              ? error.message
              : "Local audiobook alignment stopped unexpectedly.",
          updatedAt: Date.now(),
        };
        await saveReaderAudiobookManifest(failedManifest).catch(() => false);
        setAudiobookManifest(failedManifest);
        setAudiobookJobState(paused ? "idle" : "error");
        setAudiobookMessage(
          paused
            ? "Alignment paused. Completed windows are safe and resumable."
            : failedManifest.error ?? "Local alignment stopped.",
        );
      } finally {
        disposeAudiobookTranscriber();
        await audioContext?.close().catch(() => undefined);
        if (audiobookAlignmentAbortRef.current === abortController) {
          audiobookAlignmentAbortRef.current = null;
        }
      }
    };
    const job = run();
    audiobookAlignmentJobPromiseRef.current = job;
    void job.finally(() => {
      if (audiobookAlignmentJobPromiseRef.current === job) {
        audiobookAlignmentJobPromiseRef.current = null;
      }
    });
  }, [audiobookManifest, model.tokens]);

  const pauseAudiobookAlignment = useCallback(() => {
    if (!audiobookAlignmentAbortRef.current) return;
    setAudiobookJobState("pausing");
    setAudiobookMessage("Pausing after the current local audio boundary…");
    audiobookAlignmentAbortRef.current.abort();
    disposeAudiobookTranscriber();
  }, []);

  const syncCurrentSentenceToAudiobook = useCallback(async () => {
    const playback = audiobookPlaybackRef.current;
    if (!playback || !audiobookManifest) {
      setAudiobookMessage(
        "Play or pause the attached audiobook at the matching sentence first.",
      );
      return;
    }
    const active = model.tokens[activeWordRef.current];
    if (!active) return;
    const sentenceStart = model.tokens.find(
      (token) => token.sentenceIndex === active.sentenceIndex,
    )?.index ?? active.index;
    const manualAnchor: TimedMediaAnchor = {
      id: globalThis.crypto?.randomUUID?.() ?? `manual-${Date.now()}`,
      partIndex: playback.partIndex,
      timeSeconds: playback.audio.currentTime,
      tokenIndex: sentenceStart,
      confidence: 1,
      source: "manual",
      granularity: "sentence",
    };
    const anchors = normalizeTimedMediaAnchors([
      ...audiobookManifest.anchors.filter(
        (anchor) =>
          anchor.source === "manual" ||
          (anchor.partIndex !== manualAnchor.partIndex ||
            Math.abs(anchor.timeSeconds - manualAnchor.timeSeconds) > 2),
      ),
      manualAnchor,
    ]) as TimedMediaAnchor[];
    const corrected: AudiobookManifest = {
      ...audiobookManifest,
      anchors,
      updatedAt: Date.now(),
    };
    await saveReaderAudiobookManifest(corrected);
    setAudiobookManifest(corrected);
    audiobookPlaybackRef.current = { ...playback, manifest: corrected };
    setAudiobookMessage(
      "Manual sentence sync saved on this device. It overrides nearby automatic timing.",
    );
  }, [audiobookManifest, model.tokens]);

  const removeAttachedAudiobook = useCallback(async () => {
    if (!audiobookManifest) return;
    audiobookAlignmentAbortRef.current?.abort();
    await audiobookAlignmentJobPromiseRef.current?.catch(() => undefined);
    stopSpeech();
    setAudiobookJobState("removing");
    try {
      await removeReaderAudiobook(
        readerDocument.id,
        audiobookManifest.audioId,
      );
      setAudiobookManifest(null);
      setAudiobookProfileCount((current) => Math.max(0, current - 1));
      setAudiobookProgress(0);
      setAudiobookMessage(
        "Attached audio, transcript windows, and sync anchors were removed.",
      );
      setSettings((current) =>
        current.narrationEngine === "audiobook"
          ? { ...current, narrationEngine: "offline" }
          : current,
      );
    } finally {
      setAudiobookJobState("idle");
    }
  }, [audiobookManifest, readerDocument.id, stopSpeech]);

  const removeAllAttachedAudiobooks = useCallback(async () => {
    audiobookAlignmentAbortRef.current?.abort();
    await audiobookAlignmentJobPromiseRef.current?.catch(() => undefined);
    stopSpeech();
    setAudiobookJobState("removing");
    try {
      const manifests = (await listReaderAudiobookManifests(
        readerDocument.id,
      )) as AudiobookManifest[];
      for (const manifest of manifests) {
        await removeReaderAudiobook(readerDocument.id, manifest.audioId);
      }
      setAudiobookManifest(null);
      setAudiobookProfileCount(0);
      setAudiobookProgress(0);
      setAudiobookMessage("All attached audiobooks for this book were removed.");
      setSettings((current) =>
        current.narrationEngine === "audiobook"
          ? { ...current, narrationEngine: "offline" }
          : current,
      );
    } finally {
      setAudiobookJobState("idle");
    }
  }, [readerDocument.id, stopSpeech]);

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

  const registerRenderedWord = useCallback(
    (index: number, element: HTMLSpanElement | null) => {
      if (element) {
        wordRefs.current.set(index, element);
        if (index === activeWordRef.current) {
          element.dataset.activeToken = "true";
          element.id = "active-spoken-word";
          scheduleReadingRulerPosition();
        }
      } else {
        wordRefs.current.delete(index);
        if (index === activeWordRef.current) {
          scheduleReadingRulerPosition();
        }
      }
    },
    [scheduleReadingRulerPosition],
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
      {
        behavior = "smooth",
        closePanel = false,
        label,
        pageNumber,
        position,
        recordHistory = true,
        scroll = true,
        scrollTarget = viewMode === "page" ? "page" : "word",
      }: {
        behavior?: ScrollBehavior;
        closePanel?: boolean;
        label?: string;
        pageNumber?: number | null;
        position?: StoredReaderPosition;
        recordHistory?: boolean;
        scroll?: boolean;
        scrollTarget?: PendingPdfTarget["scrollTarget"];
      } = {},
    ) => {
      const requestedIndex = Math.max(0, Math.trunc(targetIndex));
      const runtime = activePdfRuntimeRef.current;
      const runtimeIsCurrent =
        runtime !== null && readerDocument.pdfRuntime === runtime;
      const runtimeIsStreaming = Boolean(
        runtimeIsCurrent &&
          runtime &&
          isProgressivePdfHydrating(
            runtime.manifest,
            runtime.store.getSummaries().length,
            runtime.model.tokens.length,
          ),
      );
      const positionNeedsMoreContext = Boolean(
        position &&
          model.tokens.length < requiredPdfPositionTokenCount(position),
      );
      const resolvedPosition =
        position && !positionNeedsMoreContext
          ? resolveStoredPosition(position, model.tokens)
          : null;
      const resolvedIndex = position ? resolvedPosition : requestedIndex;
      const shouldWait =
        runtimeIsStreaming &&
        (positionNeedsMoreContext ||
          resolvedIndex === null ||
          resolvedIndex >= model.tokens.length);
      if (!model.tokens.length && !shouldWait) return false;

      const currentIndex = activeWordRef.current;
      if (
        recordHistory &&
        isMeaningfulPositionJump(
          currentIndex,
          resolvedIndex ?? requestedIndex,
          runtime?.manifest.wordCount || model.tokens.length,
        )
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
      if (shouldWait && runtime) {
        const pendingRestore = pendingPdfProgressRestoreRef.current;
        const preserveProgress =
          pendingRestore?.documentId === readerDocument.id;
        if (preserveProgress) {
          pendingPdfProgressRestoreRef.current = {
            documentId: readerDocument.id,
            targetIndex: requestedIndex,
          };
        }
        pendingPdfTargetRef.current = {
          behavior,
          clampOnComplete: false,
          closePanel,
          documentId: readerDocument.id,
          label,
          pageNumber,
          position,
          preserveProgress,
          scroll,
          scrollTarget,
          tokenIndex: requestedIndex,
        };
        pdfTargetScrollGenerationRef.current += 1;
        setFollowPaused(false);
        if (closePanel) setShowBookmarks(false);
        setNotice(
          `${label ?? "That position"} is still loading. LineLight will open it as soon as its page is ready.`,
        );
        return true;
      }

      if (resolvedIndex === null) return false;
      const safeIndex = Math.min(
        resolvedIndex,
        Math.max(0, model.tokens.length - 1),
      );
      if (pendingPdfTargetRef.current?.documentId === readerDocument.id) {
        pendingPdfTargetRef.current = null;
      }
      const pendingRestore = pendingPdfProgressRestoreRef.current;
      if (pendingRestore?.documentId === readerDocument.id) {
        pendingPdfProgressRestoreRef.current = {
          documentId: readerDocument.id,
          targetIndex: safeIndex,
        };
      }
      setActiveWord(safeIndex);
      activeWordRef.current = safeIndex;
      setFollowPaused(false);
      if (closePanel) setShowBookmarks(false);
      if (scroll && runtimeIsCurrent && runtime) {
        const summaries = runtime.store.getSummaries() as Array<{
          pageNumber: number;
          wordStart: number;
        }>;
        const resolvedPageNumber = loadedPdfPageNumber(
          summaries,
          safeIndex,
          pageNumber,
        );
        schedulePdfTargetScroll(
          runtime,
          safeIndex,
          resolvedPageNumber,
          scrollTarget,
          behavior,
        );
      } else if (scroll) {
        window.setTimeout(() => scrollToActiveWord(behavior), 0);
      }
      return true;
    },
    [
      commitNavigation,
      model.tokens,
      readerDocument.id,
      readerDocument.pdfRuntime,
      schedulePdfTargetScroll,
      scrollToActiveWord,
      stopSpeech,
      viewMode,
    ],
  );

  const selectRenderedWord = useCallback(
    (index: number) => {
      jumpToPosition(index);
    },
    [jumpToPosition],
  );

  const openOutlineItem = useCallback(
    (item: PdfOutlineItem) => {
      const label = `${item.title}${
        item.pageNumber === null ? "" : ` · page ${item.pageNumber}`
      }`;
      if (
        item.tokenIndex === null ||
        !jumpToPosition(item.tokenIndex, {
          label,
          pageNumber: item.pageNumber,
          scrollTarget:
            viewMode === "page" && item.pageNumber !== null ? "page" : "word",
        })
      ) {
        return;
      }
      setShowSidebar(false);
      if (item.tokenIndex < model.tokens.length) {
        setNotice(`${label} opened. Press Play to narrate from here.`);
      }
    },
    [jumpToPosition, model.tokens.length, viewMode],
  );

  const openStoredPosition = useCallback(
    (position: StoredReaderPosition, label: string) => {
      const runtime = activePdfRuntimeRef.current;
      const runtimeIsStreaming = Boolean(
        runtime &&
          readerDocument.pdfRuntime === runtime &&
          isProgressivePdfHydrating(
            runtime.manifest,
            runtime.store.getSummaries().length,
            runtime.model.tokens.length,
          ),
      );
      const contextNotLoaded =
        runtimeIsStreaming &&
        model.tokens.length < requiredPdfPositionTokenCount(position);
      const targetIndex = contextNotLoaded
        ? null
        : resolveStoredPosition(position, model.tokens);
      if (targetIndex === null) {
        if (
          runtimeIsStreaming &&
          jumpToPosition(position.tokenIndex, {
            closePanel: true,
            label,
            position,
          })
        ) {
          return;
        }
        setNotice(`${label} could not be matched safely in the current document.`);
        return;
      }
      jumpToPosition(targetIndex, { closePanel: true, label });
      setNotice(`${label} opened. Press Play to narrate from here.`);
    },
    [jumpToPosition, model.tokens, readerDocument.pdfRuntime],
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
      engine: "offline" | "azure",
      startIndex = activeWordRef.current,
    ) => {
      if (!model.tokens.length) return;
      const isOffline = engine === "offline";
      const safeIndex = Math.min(
        Math.max(0, startIndex),
        model.tokens.length - 1,
      );
      const preparedRange =
        isOffline &&
        preparedNarrationManifest &&
        preparedNarrationManifest.documentId === readerDocument.id &&
        preparedNarrationManifest.voice === settings.offlineVoice &&
        preparedNarrationManifest.rate === settings.rate
          ? preparedNarrationMetadata.find(
              (metadata) =>
                metadata.startIndex <= safeIndex &&
                safeIndex < metadata.nextIndex,
            ) ?? null
          : null;
      const queueStartIndex = preparedRange?.startIndex ?? safeIndex;
      let initialPreparedSeekIndex = preparedRange ? safeIndex : null;

      if (isOffline && offlinePackState !== "ready" && !preparedRange) {
        pendingOfflineStartIndexRef.current = safeIndex;
        if (offlinePackState === "missing" || offlinePackState === "error") {
          automaticOfflineInstallAttemptedRef.current = true;
          void downloadOfflineVoice(false);
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

      // If idle initialization is already running, let this Play request queue
      // behind it and reuse the model. If it has not started yet, cancel only
      // the scheduled callback so synthesis can begin immediately.
      cancelOfflineWarmRestore({ abortActive: false });
      const sessionId = speechSessionRef.current + 1;
      speechSessionRef.current = sessionId;

      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      clearSpeechStartTimer();
      clearFallbackTimer();
      clearBufferedPlayback();
      // Open Chromium's media-output path inside this trusted action while the
      // natural voice is generated. Without it, the first real Audio element
      // can spend another ~1.8 seconds starting the device after synthesis.
      primeNarrationAudioOutput();

      const abortController = new AbortController();
      bufferedAbortRef.current = abortController;

      setActiveWord(safeIndex);
      activeWordRef.current = safeIndex;
      setIsPlaying(false);
      setIsPreparingSpeech(true);
      setNarrationReadiness(
        normalizeNarrationReadiness(
          1,
          isOffline
            ? "Starting the included offline voice…"
            : "Connecting to the natural voice…",
        ),
      );
      setNotice(
        isOffline
          ? "Starting a natural voice on this device…"
          : "Preparing a natural voice…",
      );

      let waitingChunkStart: number | null = queueStartIndex;
      const expectedOfflineModelDtype = isOffline
        ? getOfflineSpeechReadiness().modelDtype ??
          OFFLINE_MODEL_DTYPE
        : null;
      const expectedOfflineProfileKey = preparedRange
        ? preparedNarrationManifest!.profileKey
        : expectedOfflineModelDtype
          ? createPreparedNarrationProfileKey({
            modelRevision: OFFLINE_MODEL_REVISION,
            modelDtype: expectedOfflineModelDtype,
            voice: settings.offlineVoice,
            rate: settings.rate,
          })
          : null;
      const reportNarrationReadiness = (
        chunkStart: number,
        nextProgress: number,
        label: string,
      ) => {
        if (
          speechSessionRef.current !== sessionId ||
          abortController.signal.aborted ||
          waitingChunkStart !== chunkStart
        ) {
          return;
        }
        setNarrationReadiness((current) =>
          normalizeNarrationReadiness(
            nextProgress,
            label,
            current.progress,
          ),
        );
      };

      type SpeechChunk = NonNullable<ReturnType<typeof buildSpeechChunk>>;
      type PreparedAudio = {
        audio: HTMLAudioElement;
        reusedAudio: boolean;
        synthesis: AzureSpeechResult | OfflineSpeechResult;
      };

      const clearBoundaryAnimation = () => {
        if (bufferedAnimationFrameRef.current !== null) {
          window.cancelAnimationFrame(bufferedAnimationFrameRef.current);
          bufferedAnimationFrameRef.current = null;
        }
      };

      let offlineChunkCharacters = preparedRange
        ? PREPARED_NARRATION_CHUNK_CHARACTERS
        : OFFLINE_FIRST_CHUNK_CHARACTERS;

      const buildChunk = (chunkStartIndex: number) =>
        buildSpeechChunk(
          model.fullText,
          model.tokens,
          chunkStartIndex,
          isOffline
            ? offlineChunkCharacters
            : AZURE_SPEECH_CHUNK_CHARACTERS,
        );

      const prepareChunkNow = async (
        chunk: SpeechChunk,
        {
          signal,
          speculative = false,
        }: { signal: AbortSignal; speculative?: boolean },
      ): Promise<PreparedAudio> => {
        if (abortController.signal.aborted || signal.aborted) {
          throw new DOMException(
            "Speech preparation was canceled.",
            "AbortError",
          );
        }

        let reusedAudio = false;
        let synthesis: AzureSpeechResult | OfflineSpeechResult;
        if (isOffline) {
          if (!expectedOfflineProfileKey) {
            throw new OfflineSpeechError(
              "The offline voice profile is unavailable.",
            );
          }
          const cacheKey = JSON.stringify([
            expectedOfflineProfileKey,
            chunk.startIndex,
            chunk.nextIndex,
            chunk.text,
          ]);
          let cachedSynthesis = offlineAudioCacheRef.current?.get(cacheKey);
          let textFingerprint: string | null = null;
          if (!cachedSynthesis) {
            try {
              textFingerprint = await fingerprintPreparedNarrationText(
                chunk.text,
              );
              const durableSynthesis =
                await getReaderPreparedNarrationChunk({
                  documentId: readerDocument.id,
                  profileKey: expectedOfflineProfileKey,
                  startIndex: chunk.startIndex,
                  nextIndex: chunk.nextIndex,
                  textFingerprint,
                });
              if (durableSynthesis) {
                const playableAudio = await decodePreparedNarrationAudio(
                  durableSynthesis,
                );
                cachedSynthesis = {
                  ...durableSynthesis,
                  audioData: playableAudio,
                } as OfflineSpeechResult;
                offlineAudioCacheRef.current?.set(
                  cacheKey,
                  cachedSynthesis,
                  playableAudio.byteLength,
                );
              }
            } catch {
              // Durable reuse is optional. Live local synthesis remains
              // available if browser storage or Web Crypto is unavailable.
            }
          }
          if (cachedSynthesis) {
            reusedAudio = true;
            synthesis = cachedSynthesis;
            reportNarrationReadiness(
              chunk.startIndex,
              94,
              "Reusing prepared narration audio…",
            );
          } else {
            if (abortController.signal.aborted || signal.aborted) {
              throw new DOMException(
                "Speech preparation was canceled.",
                "AbortError",
              );
            }
            reportNarrationReadiness(
              chunk.startIndex,
              4,
              "Loading the included voice and generating narration…",
            );
            const generatedSynthesis = await synthesizeOfflineSpeech({
              text: chunk.text,
              voice: settings.offlineVoice,
              rate: settings.rate,
              signal,
              preserveWorkerOnAbort: speculative,
              onProgress: ({ progress, label, stage }) => {
                const narrationPhase =
                  stage === "synthesizing"
                    ? "synthesizing"
                    : "initializing";
                reportNarrationReadiness(
                  chunk.startIndex,
                  mapOfflineNarrationPhaseProgress(
                    narrationPhase,
                    progress,
                  ),
                  label,
                );
              },
            });
            synthesis = generatedSynthesis;
            if (!abortController.signal.aborted && !signal.aborted) {
              const generatedProfileKey =
                createPreparedNarrationProfileKey({
                  modelRevision: OFFLINE_MODEL_REVISION,
                  modelDtype: generatedSynthesis.modelDtype,
                  voice: settings.offlineVoice,
                  rate: settings.rate,
                });
              const generatedCacheKey = JSON.stringify([
                generatedProfileKey,
                chunk.startIndex,
                chunk.nextIndex,
                chunk.text,
              ]);
              offlineAudioCacheRef.current?.set(
                generatedCacheKey,
                generatedSynthesis,
                generatedSynthesis.audioData.byteLength,
              );
              try {
                textFingerprint ??=
                  await fingerprintPreparedNarrationText(chunk.text);
                const durableBoundaries = generatedSynthesis.boundaries.map(
                  (boundary) => ({
                    ...boundary,
                    tokenIndex: findWordAtCharacter(
                      model.tokens,
                      chunk.startChar + boundary.textOffset,
                    ),
                  }),
                );
                void saveReaderPreparedNarrationChunk({
                  schemaVersion: PREPARED_NARRATION_SCHEMA_VERSION,
                  documentId: readerDocument.id,
                  profileKey: generatedProfileKey,
                  startIndex: chunk.startIndex,
                  nextIndex: chunk.nextIndex,
                  textFingerprint,
                  audioData: generatedSynthesis.audioData,
                  audioByteLength: generatedSynthesis.audioData.byteLength,
                  audioEncoding: PREPARED_NARRATION_IDENTITY_ENCODING,
                  sourceAudioByteLength:
                    generatedSynthesis.audioData.byteLength,
                  mimeType: PREPARED_NARRATION_AUDIO_MIME_TYPE,
                  audioDurationSeconds:
                    generatedSynthesis.audioDurationSeconds,
                  boundaries: durableBoundaries,
                  device: generatedSynthesis.device,
                  modelDtype: generatedSynthesis.modelDtype,
                  synthesisMilliseconds:
                    generatedSynthesis.synthesisMilliseconds,
                  wasmThreads: generatedSynthesis.wasmThreads,
                  retention: PREPARED_NARRATION_RECENT_RETENTION,
                  createdAt: Date.now(),
                }).catch(() => undefined);
              } catch {
                // Playback must not fail when opportunistic persistence is
                // unavailable. Explicit preparation will report such errors.
              }
            }
          }
        } else {
          reportNarrationReadiness(
            chunk.startIndex,
            34,
            "Generating narration audio…",
          );
          synthesis = await synthesizeAzureSpeech({
            text: chunk.text,
            voice: settings.azureVoice,
            signal,
          });
        }

        if (abortController.signal.aborted || signal.aborted) {
          throw new DOMException(
            "Speech preparation was canceled.",
            "AbortError",
          );
        }

        if (isOffline && !preparedRange) {
          const offlineSynthesis = synthesis as OfflineSpeechResult;
          offlineChunkCharacters = adaptOfflineSpeechChunkCharacters({
            currentCharacters: offlineChunkCharacters,
            synthesisMilliseconds: offlineSynthesis.synthesisMilliseconds,
            audioDurationSeconds: offlineSynthesis.audioDurationSeconds,
          });
        }

        reportNarrationReadiness(
          chunk.startIndex,
          95,
          "Loading narration audio…",
        );

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
        const markAudioReady = () => {
          reportNarrationReadiness(
            chunk.startIndex,
            100,
            "Narration is fully loaded and ready.",
          );
        };
        audio.addEventListener("canplay", markAudioReady, { once: true });
        audio.load();
        if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
          markAudioReady();
        }

        return { audio, reusedAudio, synthesis };
      };

      const handleBufferedSpeechFailure = (
        error: unknown,
        resumeIndex: number,
      ) => {
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

        if (!allowsDeviceFallback(engine)) {
          setNotice(
            `${message} Offline natural remains selected. Press Play to try again.`,
          );
          return;
        }

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
        startIndex: queueStartIndex,
        endIndex: model.tokens.length,
        lookahead: 1,
        buildChunk,
        getNextIndex: (chunk: SpeechChunk) => chunk.nextIndex,
        prepareChunk: prepareChunkNow,
        discardPrepared: (prepared: PreparedAudio) => {
          releaseBufferedAudio(prepared.audio);
        },
      });
      // Give the first Blob decode and audio.play() exclusive priority. The
      // current non-speculative preparation remains active while paused, and
      // audio.onplaying resumes the one-chunk lookahead only after sound starts.
      prefetchQueue.pause();
      const prefetchControls: BufferedPrefetchControls = {
        dispose: () => prefetchQueue.dispose(),
        pause: () => {
          const runtime = getOfflineSpeechReadiness();
          const canCancelActiveInference =
            isOffline &&
            runtime.device === "wasm" &&
            (runtime.wasmThreads ?? 1) > 1;
          // Abort only lookahead synthesis that the threaded-WASM mailbox can
          // interrupt. Safe WebGPU/W1/Azure fallback keeps its in-flight result,
          // and every backend retains audio that has already become ready.
          return prefetchQueue.pause({
            cancelPending: canCancelActiveInference,
          });
        },
        resume: () => prefetchQueue.resume(),
      };
      bufferedPrefetchControlsRef.current = prefetchControls;

      const finishBufferedSpeech = () => {
        prefetchControls.dispose();
        if (bufferedPrefetchControlsRef.current === prefetchControls) {
          bufferedPrefetchControlsRef.current = null;
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
        const { audio, reusedAudio, synthesis } = prepared;
        bufferedAudioRef.current = audio;
        if (isOffline && "device" in synthesis) {
          setOfflineRuntimeInfo({
            audioDurationSeconds: synthesis.audioDurationSeconds,
            device: synthesis.device,
            reusedAudio,
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
        if (
          initialPreparedSeekIndex !== null &&
          chunk.startIndex <= initialPreparedSeekIndex &&
          initialPreparedSeekIndex < chunk.nextIndex
        ) {
          const audioOffset = findBufferedSeekOffset(
            bufferedSeekStateRef.current,
            initialPreparedSeekIndex,
          );
          if (audioOffset !== null) {
            audio.currentTime = audioOffset;
            activeWordRef.current = initialPreparedSeekIndex;
            setActiveWord(initialPreparedSeekIndex);
          }
          initialPreparedSeekIndex = null;
        }

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
          waitingChunkStart = null;
          setIsPreparingSpeech(false);
          setIsPlaying(true);
          setNotice("");
          clearBoundaryAnimation();
          bufferedAnimationFrameRef.current =
            window.requestAnimationFrame(updateBoundary);
        };
        audio.onplaying = () => {
          if (speechSessionRef.current !== sessionId) return;
          if (audio.paused || audio.ended) return;
          releaseNarrationAudioPrime();
          // `play` fires as soon as the media element becomes unpaused. Wait
          // for decoded audio to reach the output path before giving ONNX the
          // CPU for speculative work.
          prefetchControls.resume();
        };
        audio.onpause = () => {
          clearBoundaryAnimation();
          if (speechSessionRef.current === sessionId && !audio.ended) {
            prefetchControls.pause();
            setIsPlaying(false);
          }
        };
        audio.onerror = () => {
          handleBufferedSpeechFailure(
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
            waitingChunkStart = chunk.nextIndex;
            setIsPlaying(false);
            setIsPreparingSpeech(true);
            setNarrationReadiness(
              normalizeNarrationReadiness(
                3,
                "Preparing the next passage…",
              ),
            );
            setNotice("Preparing the next passage…");
          }

          try {
            const nextChunk = await prefetchQueue.take();
            if (!nextChunk) {
              finishBufferedSpeech();
              return;
            }
            if (
              waitingChunkStart === nextChunk.chunk.startIndex &&
              nextChunk.prepared.audio.readyState >=
                HTMLMediaElement.HAVE_FUTURE_DATA
            ) {
              reportNarrationReadiness(
                nextChunk.chunk.startIndex,
                100,
                "Narration is fully loaded and ready.",
              );
            }
            await playPreparedChunk(nextChunk.chunk, nextChunk.prepared);
          } catch (error) {
            handleBufferedSpeechFailure(
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
            releaseNarrationAudioPrime();
            prefetchControls.pause();
            setIsPreparingSpeech(false);
            setIsPlaying(false);
            setNotice(
              "Natural voice is ready. Press Play once more to hear it.",
            );
            return;
          }
          handleBufferedSpeechFailure(
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
          handleBufferedSpeechFailure(error, safeIndex);
        });
    },
    [
      clearBufferedPlayback,
      clearFallbackTimer,
      clearSpeechStartTimer,
      cancelOfflineWarmRestore,
      downloadOfflineVoice,
      model.fullText,
      model.tokens,
      offlinePackState,
      preparedNarrationManifest,
      preparedNarrationMetadata,
      primeNarrationAudioOutput,
      readerDocument.id,
      releaseBufferedAudio,
      releaseNarrationAudioPrime,
      settings.azureVoice,
      settings.offlineVoice,
      settings.rate,
      speechAvailable,
      startDeviceSpeech,
    ],
  );

  const startAudiobookPlayback = useCallback(
    (startIndex = activeWordRef.current) => {
      if (!audiobookManifest) {
        setShowSettings(true);
        setNotice("Attach a DRM-free local audiobook before selecting Audiobook.");
        return;
      }
      let position = findTimedMediaPositionForToken(
        audiobookManifest.anchors,
        startIndex,
      ) as (TimedMediaAnchor & { interpolated: boolean }) | null;
      if (
        position &&
        !position.interpolated &&
        Math.abs(position.tokenIndex - startIndex) > 80
      ) {
        position = null;
      }
      const sessionId = speechSessionRef.current + 1;
      speechSessionRef.current = sessionId;
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      clearSpeechStartTimer();
      clearFallbackTimer();
      clearBufferedPlayback();
      primeNarrationAudioOutput();
      setIsPreparingSpeech(true);
      setNarrationReadiness(
        normalizeNarrationReadiness(10, "Opening the local audiobook…"),
      );
      setIsPlaying(false);
      setNotice(
        position
          ? "Opening the locally attached audiobook…"
          : "No reliable sync exists near this sentence. Playing from the audiobook start without moving the text highlight.",
      );

      const playPart = async (partIndex: number, timeSeconds: number) => {
        if (speechSessionRef.current !== sessionId) return;
        const source = await getReaderAudiobookSource(
          audiobookManifest.documentId,
          audiobookManifest.audioId,
          partIndex,
        );
        if (speechSessionRef.current !== sessionId) return;
        if (!source?.blob) {
          throw new Error("This local audiobook chapter is missing.");
        }
        setNarrationReadiness(
          normalizeNarrationReadiness(70, "Loading the local audio chapter…"),
        );
        const audio = new Audio();
        const audioUrl = URL.createObjectURL(source.blob);
        bufferedAudioUrlsRef.current.set(audio, audioUrl);
        audio.preload = "auto";
        audio.defaultPlaybackRate = settings.rate;
        audio.playbackRate = settings.rate;
        audio.src = audioUrl;
        audio.load();
        bufferedAudioRef.current = audio;
        bufferedSeekStateRef.current = null;
        const playback: AudiobookPlaybackState = {
          audio,
          audioId: audiobookManifest.audioId,
          manifest: audiobookManifest,
          partIndex,
          sessionId,
        };
        audiobookPlaybackRef.current = playback;
        setAudiobookPlaybackActive(true);

        audio.onloadedmetadata = () => {
          if (speechSessionRef.current !== sessionId) return;
          audio.currentTime = Math.min(
            Math.max(0, timeSeconds),
            Math.max(0, audio.duration - 0.01),
          );
          setAudiobookPlaybackPosition({
            partIndex,
            timeSeconds: audio.currentTime,
            durationSeconds: audio.duration,
          });
        };
        audio.ontimeupdate = () => {
          if (speechSessionRef.current !== sessionId) return;
          setAudiobookPlaybackPosition({
            partIndex,
            timeSeconds: audio.currentTime,
            durationSeconds: Number.isFinite(audio.duration)
              ? audio.duration
              : audiobookManifest.parts[partIndex].durationSeconds,
          });
          const anchor = findTimedMediaAnchorAtTime(
            audiobookPlaybackRef.current?.manifest.anchors ?? [],
            partIndex,
            audio.currentTime,
          ) as TimedMediaAnchor | null;
          if (anchor && anchor.tokenIndex !== activeWordRef.current) {
            activeWordRef.current = anchor.tokenIndex;
            setActiveWord(anchor.tokenIndex);
          }
        };
        audio.onplay = () => {
          if (speechSessionRef.current !== sessionId) return;
          setIsPreparingSpeech(false);
          setIsPlaying(true);
          releaseNarrationAudioPrime();
        };
        audio.onpause = () => {
          if (speechSessionRef.current === sessionId && !audio.ended) {
            setIsPlaying(false);
          }
        };
        audio.onerror = () => {
          if (speechSessionRef.current !== sessionId) return;
          clearBufferedPlayback();
          setIsPreparingSpeech(false);
          setIsPlaying(false);
          setNotice("This audiobook chapter could not be played locally.");
        };
        audio.onended = () => {
          if (speechSessionRef.current !== sessionId) return;
          const nextPartIndex = partIndex + 1;
          releaseBufferedAudio(audio);
          audiobookPlaybackRef.current = null;
          if (nextPartIndex >= audiobookManifest.parts.length) {
            setAudiobookPlaybackActive(false);
            setIsPlaying(false);
            setIsPreparingSpeech(false);
            return;
          }
          setIsPreparingSpeech(true);
          void playPart(nextPartIndex, 0).catch((error: unknown) => {
            if (speechSessionRef.current !== sessionId) return;
            setIsPreparingSpeech(false);
            setIsPlaying(false);
            setNotice(
              error instanceof Error
                ? error.message
                : "The next audiobook chapter could not be opened.",
            );
          });
        };
        if (speechSessionRef.current !== sessionId) {
          releaseBufferedAudio(audio);
          return;
        }
        await audio.play();
      };

      void playPart(position?.partIndex ?? 0, position?.timeSeconds ?? 0).catch(
        (error: unknown) => {
          if (speechSessionRef.current !== sessionId) return;
          clearBufferedPlayback();
          setIsPreparingSpeech(false);
          setIsPlaying(false);
          setNotice(
            error instanceof DOMException && error.name === "NotAllowedError"
              ? "The audiobook is ready. Allow sound, then press Play again."
              : error instanceof Error
                ? error.message
                : "The local audiobook could not be opened.",
          );
        },
      );
    },
    [
      audiobookManifest,
      clearBufferedPlayback,
      clearFallbackTimer,
      clearSpeechStartTimer,
      primeNarrationAudioOutput,
      releaseBufferedAudio,
      releaseNarrationAudioPrime,
      settings.rate,
    ],
  );

  useEffect(() => {
    if (pendingOfflineStartIndexRef.current === null) {
      return;
    }
    if (offlinePackState === "missing") {
      queueMicrotask(() => {
        automaticOfflineInstallAttemptedRef.current = true;
        void downloadOfflineVoice(false);
      });
      return;
    }
    if (offlinePackState !== "ready") return;
    const startIndex = pendingOfflineStartIndexRef.current;
    pendingOfflineStartIndexRef.current = null;
    if (settings.narrationEngine === "offline") {
      queueMicrotask(() => startBufferedSpeech("offline", startIndex));
    }
  }, [
    downloadOfflineVoice,
    offlinePackState,
    settings.narrationEngine,
    startBufferedSpeech,
  ]);

  const startSpeech = useCallback(
    (startIndex = activeWordRef.current) => {
      if (settings.narrationEngine === "audiobook") {
        startAudiobookPlayback(startIndex);
        return;
      }
      if (settings.narrationEngine !== "device") {
        startBufferedSpeech(settings.narrationEngine, startIndex);
        return;
      }
      startDeviceSpeech(startIndex);
    },
    [
      settings.narrationEngine,
      startAudiobookPlayback,
      startBufferedSpeech,
      startDeviceSpeech,
    ],
  );

  const togglePlayback = useCallback(() => {
    acceptVisiblePdfPosition();
    if (isPreparingSpeech) {
      stopSpeech();
      setNotice("Narration stopped.");
      return;
    }

    if (isPlaying) {
      if (bufferedAudioRef.current) {
        bufferedPrefetchControlsRef.current?.pause();
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
      const prefetchControls = bufferedPrefetchControlsRef.current;
      void bufferedAudio.play().catch(() => {
        if (bufferedAudioRef.current !== bufferedAudio) return;
        prefetchControls?.pause();
        setIsPlaying(false);
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
  }, [
    acceptVisiblePdfPosition,
    isPlaying,
    isPreparingSpeech,
    speechAvailable,
    startSpeech,
    stopSpeech,
  ]);

  const seekBufferedPlayback = useCallback(
    (targetIndex: number, resumePlayback = false) => {
      const bufferedSeekState = bufferedSeekStateRef.current;
      if (
        !bufferedSeekState ||
        bufferedSeekState.sessionId !== speechSessionRef.current ||
        bufferedSeekState.audio !== bufferedAudioRef.current
      ) {
        return false;
      }

      const audioOffset = findBufferedSeekOffset(
        bufferedSeekState,
        targetIndex,
      );
      if (audioOffset === null) return false;

      try {
        bufferedSeekState.audio.currentTime = audioOffset;
        setActiveWord(targetIndex);
        activeWordRef.current = targetIndex;
        window.setTimeout(() => scrollToActiveWord("smooth"), 0);
        if (resumePlayback && bufferedSeekState.audio.paused) {
          const prefetchControls = bufferedPrefetchControlsRef.current;
          void bufferedSeekState.audio.play().catch(() => {
            if (bufferedAudioRef.current !== bufferedSeekState.audio) return;
            prefetchControls?.pause();
            setIsPlaying(false);
            setNotice(
              "Brave blocked audio playback. Allow sound for this site, then press Play again.",
            );
          });
        }
        return true;
      } catch {
        return false;
      }
    },
    [scrollToActiveWord],
  );

  const moveBySentence = useCallback(
    (direction: -1 | 1) => {
      acceptVisiblePdfPosition();
      const targetIndex = findAdjacentSentenceStart(
        sentenceStarts,
        activeWordRef.current,
        direction,
      );
      if (targetIndex === null) return;

      if (seekBufferedPlayback(targetIndex)) return;

      const restartAfterMove = isPlaying;
      stopSpeech();
      setActiveWord(targetIndex);
      activeWordRef.current = targetIndex;
      window.setTimeout(() => scrollToActiveWord("smooth"), 0);
      if (restartAfterMove) startSpeech(targetIndex);
    },
    [
      acceptVisiblePdfPosition,
      isPlaying,
      scrollToActiveWord,
      seekBufferedPlayback,
      sentenceStarts,
      startSpeech,
      stopSpeech,
    ],
  );

  const replayUnit = useCallback(
    (unit: "word" | "sentence" | "paragraph") => {
      acceptVisiblePdfPosition();
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
      if (seekBufferedPlayback(target, true)) return;
      stopSpeech();
      startSpeech(target);
    },
    [
      acceptVisiblePdfPosition,
      activeToken,
      model.tokens,
      seekBufferedPlayback,
      startSpeech,
      stopSpeech,
    ],
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

      readerLifecycleGenerationRef.current += 1;
      setLibraryBusyId(documentId);
      setNotice("");
      try {
        const selectedEntry = libraryEntries.find(
          (entry) => entry.id === documentId,
        );
        if (!selectedEntry) {
          throw new Error("This document is no longer in the library.");
        }
        if (selectedEntry.kind === "pdf") {
          const openedEntry = (await openReaderDocumentMetadata(
            documentId,
          )) as LibraryEntry | null;
          if (!openedEntry) {
            throw new Error("This document is no longer in the library.");
          }
          stopSpeech();
          wordRefs.current.clear();
          let readyView: ReaderViewMode = "page";
          try {
            if (
              localStorage.getItem(`guided-reader-view-${documentId}`) ===
              "focus"
            ) {
              readyView = "focus";
            }
          } catch {
            // The page view remains the default when preferences are unavailable.
          }
          const restoredWord = storedProgressFor(documentId) ?? 0;
          await startPdfRuntime({
            documentId,
            title: openedEntry.title,
            author: openedEntry.author,
            restoredWord,
            readyView,
          });
          setFollowPaused(false);
          setShowSidebar(false);
          if (restoredWord === 0) {
            readerRef.current?.scrollTo({ top: 0, behavior: "auto" });
          }
          return;
        }
        const opened = (await openReaderDocument(documentId)) as {
          document: ReaderDocument | null;
          entry: LibraryEntry | null;
        };
        if (!opened.document || !opened.entry) {
          throw new Error("This document is no longer in the library.");
        }

        stopSpeech();
        disposePdfRuntime(readerDocument.pdfRuntime);
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
    [
      libraryEntries,
      disposePdfRuntime,
      readerDocument.id,
      readerDocument.pdfRuntime,
      scrollToActiveWord,
      startPdfRuntime,
      stopSpeech,
    ],
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
          const runtime = activePdfRuntimeRef.current;
          if (runtime && runtime === readerDocument.pdfRuntime) {
            runtime.manifest = {
              ...runtime.manifest,
              title: renamed.document.title,
            };
            runtime.version += 1;
            setReaderDocument({
              ...renamed.document,
              paragraphs: [],
              pdfRuntime: runtime,
              pdfRuntimeVersion: runtime.version,
            });
          } else {
            setReaderDocument(renamed.document);
          }
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
    [
      readerDocument.id,
      readerDocument.pdfRuntime,
      renameDraft,
      renamingDocumentId,
    ],
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
        if (wasActive) {
          readerLifecycleGenerationRef.current += 1;
          stopSpeech();
          disposePdfRuntime(readerDocument.pdfRuntime);
        }
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
          if (remainingEntries[0].kind === "pdf") {
            const nextEntry = (await openReaderDocumentMetadata(
              remainingEntries[0].id,
            )) as LibraryEntry | null;
            if (!nextEntry) {
              throw new Error("The next document could not be opened.");
            }
            wordRefs.current.clear();
            const restoredWord = storedProgressFor(nextEntry.id) ?? 0;
            await startPdfRuntime({
              documentId: nextEntry.id,
              title: nextEntry.title,
              author: nextEntry.author,
              restoredWord,
            });
            setLibraryEntries((current) =>
              sortLibraryEntries([
                nextEntry,
                ...current.filter((entry) => entry.id !== nextEntry.id),
              ]) as LibraryEntry[],
            );
            if (restoredWord === 0) {
              readerRef.current?.scrollTo({ top: 0, behavior: "auto" });
            }
            setNotice(`${entryToDelete.title} was removed from this device.`);
            return;
          }
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
      disposePdfRuntime,
      readerDocument.id,
      readerDocument.pdfRuntime,
      renamingDocumentId,
      scrollToActiveWord,
      startPdfRuntime,
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

      readerLifecycleGenerationRef.current += 1;

      const restoreOfflineWorker =
        settings.narrationEngine === "offline" &&
        shouldRestoreOfflineWorkerAfterImport({
          packState: offlinePackState,
          readinessState: getOfflineSpeechReadiness().state,
          restorePending: offlineWarmRestoreAbortRef.current !== null,
        });
      const restoreOfflineVoice = settings.offlineVoice;
      stopSpeech();
      offlineInstallAbortRef.current?.abort();
      if (shouldDisposeOfflineWorkerForImport(offlinePackState)) {
        disposeOfflineSpeechWorker();
      }
      if (offlinePackState === "installing") {
        automaticOfflineInstallAttemptedRef.current = false;
        setOfflinePackState("missing");
        setOfflineInstallProgress(0);
        setOfflineInstallLabel(
          "Offline voice preparation paused while the document opens.",
        );
      }
      setIsImporting(true);
      setNotice("");
      try {
        if (extension === "pdf") {
          const documentId = `pdf-${Date.now()}`;
          wordRefs.current.clear();
          await startPdfRuntime({
            documentId,
            title: filenameWithoutExtension(file.name),
            author: "PDF document",
            source: file,
          });
          setFollowPaused(false);
          setShowImport(false);
          setShowSidebar(false);
          window.setTimeout(() => {
            readerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
          }, 0);
          return;
        }

        const imported =
          extension === "epub" ? await parseEpub(file) : await parseText(file);
        disposePdfRuntime();
        const libraryEntry = (await addReaderDocument(imported)) as LibraryEntry;
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
        setViewMode("focus");
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
        if (restoreOfflineWorker) {
          scheduleOfflineWarmRestore(restoreOfflineVoice);
        }
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [
      offlinePackState,
      disposePdfRuntime,
      scheduleOfflineWarmRestore,
      settings.narrationEngine,
      settings.offlineVoice,
      startPdfRuntime,
      stopSpeech,
    ],
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
            aria-label="Close navigation"
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

        {readerDocument.kind === "pdf" && (
          <div
            className="sidebar-view-tabs"
            role="group"
            aria-label="Choose navigation view"
          >
            <button
              type="button"
              className={sidebarView === "library" ? "selected" : ""}
              aria-pressed={sidebarView === "library"}
              onClick={() =>
                setSidebarSelection({
                  documentId: readerDocument.id,
                  view: "library",
                })
              }
            >
              Library
            </button>
            <button
              type="button"
              className={sidebarView === "contents" ? "selected" : ""}
              aria-pressed={sidebarView === "contents"}
              onClick={() =>
                setSidebarSelection({
                  documentId: readerDocument.id,
                  view: "contents",
                })
              }
            >
              Contents
            </button>
          </div>
        )}

        {(readerDocument.kind !== "pdf" || sidebarView === "library") && (
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
        )}

        {readerDocument.kind === "pdf" && sidebarView === "contents" && (
          <DocumentOutline
            key={`${readerDocument.id}-${activeOutlineItemId ?? "none"}`}
            items={documentOutline}
            activeItemId={activeOutlineItemId}
            onNavigate={openOutlineItem}
          />
        )}

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
          aria-label="Close navigation"
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
              aria-label="Open navigation"
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
          readerDocument.pdfRuntime ? (
            <PdfPageView
              key={readerDocument.id}
              store={readerDocument.pdfRuntime.store}
              fallbackSource={readerDocument.pdfRuntime.fallbackSource}
              renderFallback={readerDocument.pdfRuntime.renderFallback}
              activeWord={activeWord}
              activeHighlightIndex={activeHighlightIndex}
              tokenSentences={tokenSentences}
              tokenParagraphs={tokenParagraphs}
              highlightScope={settings.highlightScope}
              registerWord={registerRenderedWord}
              requestRender={(pageNumber, scale, options) =>
                readerDocument.pdfRuntime?.client.requestRender(
                  pageNumber,
                  scale,
                  options,
                )
              }
              onSelectWord={selectRenderedWord}
              onRenderError={setNotice}
            />
          ) : (
            <FocusDocumentView
              key={readerDocument.id}
              activeParagraphIndex={activeParagraphIndex}
              activeHighlightIndex={activeHighlightIndex}
              characterCounts={
                readerDocument.pdfRuntime?.model.paragraphCharacterCounts
              }
              className={[
                "reading-page",
                `font-${settings.font}`,
                `highlight-${settings.highlightScope}`,
                settings.focusLines > 0 ? "focus-window-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              documentId={readerDocument.id}
              contentVersion={readerDocument.pdfRuntimeVersion ?? 0}
              documentKind={readerDocument.kind}
              fontSize={settings.fontSize}
              focusLines={settings.focusLines}
              highlightScope={settings.highlightScope}
              lineHeight={settings.lineHeight}
              maxLineWidth={settings.maxLineWidth}
              paragraphSpacing={settings.paragraphSpacing}
              paragraphs={model.paragraphs}
              registerWord={registerRenderedWord}
              onSelectWord={selectRenderedWord}
              title={readerDocument.title}
            />
          )}
        </div>

        {settings.ruler && (
          <div
            className="reading-ruler"
            data-visible="false"
            ref={readingRulerRef}
            aria-hidden="true"
          />
        )}

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

        <section
          className={`player ${
            activeVoiceReadiness ? "player-preparing-voice" : ""
          }`}
          aria-label="Narration controls"
        >
          <div className="player-progress">
            <div>
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>

          <div className="player-content">
            <div className="now-playing">
              <div
                className={`now-playing-mark ${
                  activeVoiceReadiness ? "voice-readiness-mark" : ""
                }`}
                aria-hidden={activeVoiceReadiness ? undefined : true}
                role={activeVoiceReadiness ? "progressbar" : undefined}
                aria-label={
                  activeVoiceReadiness
                    ? "Narration voice readiness"
                    : undefined
                }
                aria-valuemin={activeVoiceReadiness ? 0 : undefined}
                aria-valuemax={activeVoiceReadiness ? 100 : undefined}
                aria-valuenow={activeVoiceReadiness?.progress}
                aria-valuetext={
                  activeVoiceReadiness
                    ? `${activeVoiceReadiness.progress}% — ${activeVoiceReadiness.label}`
                    : undefined
                }
                title={activeVoiceReadiness?.label}
              >
                {activeVoiceReadiness
                  ? `${activeVoiceReadiness.progress}%`
                  : isPlaying
                    ? "≋"
                    : "¶"}
              </div>
              <div className="now-playing-copy">
                <p aria-live={activeVoiceReadiness ? "polite" : undefined}>
                  {activeVoiceReadiness
                    ? activeVoiceReadiness.label
                    : isPlaying
                      ? "Reading now"
                      : "Ready to read"}
                </p>
                <span>
                  {activeVoiceReadiness
                    ? `${activeVoiceReadiness.progress}% ready`
                    : `${activeToken?.text ?? "Start"} · ${progress}%`}
                </span>
                {activeVoiceReadiness && (
                  <div className="voice-readiness-track" aria-hidden="true">
                    <i
                      style={{
                        width: `${activeVoiceReadiness.progress}%`,
                      }}
                    />
                  </div>
                )}
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
                    {bookmarkRows.map(
                      ({ bookmark, canOpenWhileLoading, resolvedIndex }) => {
                      const bookmarkProgress =
                        resolvedIndex === null && !canOpenWhileLoading
                          ? null
                          : Math.round(
                              (((resolvedIndex ?? bookmark.tokenIndex) + 1) /
                                Math.max(
                                  1,
                                  readerDocument.pdfRuntime?.manifest
                                    .wordCount ?? model.tokens.length,
                                )) *
                                100,
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
                                disabled={
                                  resolvedIndex === null && !canOpenWhileLoading
                                }
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
                                      : canOpenWhileLoading
                                        ? `${bookmarkProgress}% · loading`
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
                      },
                    )}
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
                  <span>Highlight scope</span>
                  <select
                    value={settings.highlightScope}
                    aria-describedby="highlight-scope-description"
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        highlightScope: event.target.value as HighlightScope,
                      }))
                    }
                  >
                    {HIGHLIGHT_SCOPE_OPTIONS.map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p
                  className="setting-description"
                  id="highlight-scope-description"
                >
                  {
                    HIGHLIGHT_SCOPE_OPTIONS.find(
                      (option) => option.value === settings.highlightScope,
                    )?.description
                  }
                </p>

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
                <div className="narrator-presets" aria-label="Narrator presets">
                  <button
                    type="button"
                    className={`narrator-preset ${
                      podcastHostPresetActive
                        ? "narrator-preset-selected"
                        : ""
                    }`}
                    aria-pressed={podcastHostPresetActive}
                    aria-describedby="podcast-host-description"
                    onClick={() => {
                      stopSpeech();
                      setSettings(
                        (current) =>
                          applyNarratorPreset(current) as ReaderSettings,
                      );
                      setNotice(
                        "Podcast host selected. It uses LineLight's warm female voice at a conversational pace.",
                      );
                    }}
                  >
                    <span className="narrator-preset-mark" aria-hidden="true">
                      ≋
                    </span>
                    <span className="narrator-preset-copy">
                      <strong>{PODCAST_HOST_PRESET.label}</strong>
                      <small id="podcast-host-description">
                        {PODCAST_HOST_PRESET.description}. An original LineLight
                        preset, not an imitation of a real person.
                      </small>
                    </span>
                    <span className="narrator-preset-action" aria-hidden="true">
                      {podcastHostPresetActive ? "Selected" : "Use preset"}
                    </span>
                  </button>
                </div>
                <div
                  className="segmented four narration-source"
                  aria-label="Narration source"
                >
                  {(
                    [
                      ["offline", "Offline natural"],
                      ["device", "Device"],
                      ["azure", "Online natural"],
                      ["audiobook", "Audiobook"],
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

                {settings.narrationEngine === "audiobook" ? (
                  <div className="audiobook-settings">
                    <div className="audiobook-card">
                      <div>
                        <strong>Attach your DRM-free audiobook</strong>
                        <p>
                          Audio stays in this browser. Choose one or more MP3,
                          M4A/M4B, AAC, WAV, FLAC, Ogg, Opus, or WebM chapter
                          files in playback order. Audible AA/AAX is not
                          supported and LineLight does not bypass DRM.
                        </p>
                      </div>
                      <div className="prepared-narration-actions">
                        <button
                          type="button"
                          disabled={
                            !canPrepareCurrentDocument ||
                            audiobookJobState === "attaching" ||
                            audiobookJobState === "aligning" ||
                            audiobookJobState === "removing"
                          }
                          onClick={() => audiobookInputRef.current?.click()}
                        >
                          {audiobookJobState === "attaching"
                            ? "Attaching…"
                            : "Attach audio files"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            timingManifestInputRef.current?.click()
                          }
                        >
                          Verify timing sidecar
                        </button>
                        <input
                          ref={audiobookInputRef}
                          type="file"
                          hidden
                          multiple
                          accept=".mp3,.m4a,.m4b,.aac,.wav,.flac,.ogg,.opus,.webm,audio/*"
                          onChange={(event) =>
                            void attachAudiobookFiles(event.target.files ?? [])
                          }
                        />
                        <input
                          ref={timingManifestInputRef}
                          type="file"
                          hidden
                          accept=".json,application/json"
                          onChange={(event) =>
                            void importTimingManifest(
                              event.target.files?.[0],
                            )
                          }
                        />
                      </div>
                      {audiobookManifest && (
                        <>
                          <div
                            className="prepared-narration-progress"
                            role="progressbar"
                            aria-label="Audiobook alignment progress"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={audiobookProgress}
                          >
                            <span style={{ width: `${audiobookProgress}%` }} />
                          </div>
                          <div className="audiobook-summary">
                            <strong>
                              {audiobookManifest.parts.length}{" "}
                              {audiobookManifest.parts.length === 1
                                ? "audio file"
                                : "chapter files"}
                            </strong>
                            <span>
                              {formatStorageBytes(
                                audiobookManifest.parts.reduce(
                                  (total, part) =>
                                    total + part.sourceByteLength,
                                  0,
                                ),
                              )}{" "}
                              stored locally
                            </span>
                          </div>
                        </>
                      )}
                      <p className="prepared-narration-status" aria-live="polite">
                        {audiobookMessage ||
                          "Attach the matching audiobook, then align it locally or use a verified LineLight timing sidecar."}
                      </p>
                      {audiobookManifest && (
                        <div className="prepared-narration-actions">
                          {audiobookJobState === "aligning" ||
                          audiobookJobState === "pausing" ? (
                            <button
                              type="button"
                              disabled={audiobookJobState === "pausing"}
                              onClick={pauseAudiobookAlignment}
                            >
                              {audiobookJobState === "pausing"
                                ? "Pausing…"
                                : "Pause alignment"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={
                                audiobookManifest.status === "ready" ||
                                audiobookJobState === "removing"
                              }
                              onClick={alignAttachedAudiobook}
                            >
                              {audiobookManifest.processedWindows
                                ? "Resume local alignment"
                                : "Align locally"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              void syncCurrentSentenceToAudiobook()
                            }
                          >
                            Sync this sentence here
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeAttachedAudiobook()}
                          >
                            Remove this audiobook
                          </button>
                          {audiobookProfileCount > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                void removeAllAttachedAudiobooks()
                              }
                            >
                              Remove all audiobooks
                            </button>
                          )}
                        </div>
                      )}
                      {audiobookPlaybackActive && (
                        <label className="audiobook-scrubber">
                          <span>
                            Chapter {audiobookPlaybackPosition.partIndex + 1}{" "}
                            · {Math.floor(audiobookPlaybackPosition.timeSeconds / 60)}:
                            {String(
                              Math.floor(audiobookPlaybackPosition.timeSeconds % 60),
                            ).padStart(2, "0")}
                          </span>
                          <input
                            type="range"
                            min={0}
                            max={Math.max(
                              0.1,
                              audiobookPlaybackPosition.durationSeconds,
                            )}
                            step={0.1}
                            value={Math.min(
                              audiobookPlaybackPosition.timeSeconds,
                              audiobookPlaybackPosition.durationSeconds || 0,
                            )}
                            onChange={(event) => {
                              const playback = audiobookPlaybackRef.current;
                              if (!playback) return;
                              playback.audio.currentTime = Number(
                                event.target.value,
                              );
                            }}
                          />
                        </label>
                      )}
                    </div>
                    <p className="online-voice-note offline-voice-note">
                      Local alignment downloads a pinned ~{Math.round(
                        AUDIOBOOK_ALIGNMENT_MODEL_ESTIMATED_BYTES / 1_000_000,
                      )} MB speech-recognition model once, processes one
                      bounded chapter and 30-second window at a time, and keeps
                      transcripts, anchors, audio, and reading text on this
                      device. Split files longer than {Math.round(
                        AUDIOBOOK_ALIGNMENT_MAX_PART_SECONDS / 60,
                      )} minutes before alignment. Low-confidence or
                      different-edition passages deliberately stay unsynced.
                    </p>
                  </div>
                ) : settings.narrationEngine === "azure" ? (
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
                            One female and one male voice are available without
                            internet.
                            {offlineUpgradeRequired && (
                              <small>
                                A faster, quality-preserving voice update is
                                available when this device is online.
                              </small>
                            )}
                            {offlineRuntimeInfo && (
                              <small>
                                Last narration ·{" "}
                                {offlineRuntimeInfo.device === "webgpu"
                                  ? "WebGPU accelerated"
                                  : `WebAssembly · ${
                                      offlineRuntimeInfo.wasmThreads ?? 1
                                    } ${
                                      offlineRuntimeInfo.wasmThreads === 1
                                        ? "thread"
                                        : "threads"
                                    }`}
                                {offlineRuntimeInfo.reusedAudio ? (
                                  <> · reused prepared audio</>
                                ) : (
                                  <>
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
                                  </>
                                )}
                              </small>
                            )}
                          </span>
                          <div className="offline-pack-actions">
                            {offlineUpgradeRequired && (
                              <button
                                type="button"
                                onClick={() => void downloadOfflineVoice()}
                              >
                                Update
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void deleteOfflineVoice()}
                            >
                              Remove
                            </button>
                          </div>
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
                    <div className="prepared-narration-card">
                        <div>
                          <strong>Render audio from this text</strong>
                          <p>
                            Generate this exact offline voice and pace once,
                            then press Play to hear it follow the highlighted
                            text—even after a reload. Estimated remaining storage:{" "}
                            {formatStorageBytes(
                              preparedNarrationEstimate.estimatedBytes,
                            )}.
                          </p>
                        </div>
                        {preparedNarrationManifest && (
                          <div
                            className="prepared-narration-progress"
                            role="progressbar"
                            aria-label="Prepared narration progress"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={preparedNarrationProgress}
                          >
                            <span
                              style={{
                                width: `${preparedNarrationProgress}%`,
                              }}
                            />
                          </div>
                        )}
                        <p className="prepared-narration-status" aria-live="polite">
                          {preparedNarrationMessage ||
                            (canPrepareCurrentDocument
                              ? "Not prepared for this voice and pace."
                              : "Finish importing this book before preparing it.")}
                        </p>
                        <div className="prepared-narration-actions">
                          {preparedNarrationJobState === "preparing" ||
                          preparedNarrationJobState === "pausing" ? (
                            <>
                              <button
                                type="button"
                                disabled={
                                  preparedNarrationJobState === "pausing"
                                }
                                onClick={pausePreparedNarration}
                              >
                                {preparedNarrationJobState === "pausing"
                                  ? "Pausing…"
                                  : "Pause"}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void removePreparedNarrationProfile()
                                }
                              >
                                Cancel &amp; remove
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={
                                !canPrepareCurrentDocument ||
                                offlinePackState !== "ready" ||
                                preparedNarrationJobState === "removing" ||
                                preparedNarrationManifest?.status === "ready"
                              }
                              onClick={prepareWholeBookNarration}
                            >
                              {preparedNarrationManifest?.nextIndex
                                ? "Resume preparation"
                                : readerDocument.kind === "demo"
                                  ? "Render demo audio"
                                  : "Render book audio"}
                            </button>
                          )}
                          {preparedNarrationManifest &&
                            preparedNarrationJobState !== "preparing" &&
                            preparedNarrationJobState !== "pausing" && (
                              <button
                                type="button"
                                onClick={() =>
                                  void removePreparedNarrationProfile()
                                }
                              >
                                Remove this voice &amp; pace
                              </button>
                            )}
                          {preparedNarrationProfileCount > 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                void removeAllPreparedNarration()
                              }
                            >
                              Remove all prepared audio
                            </button>
                          )}
                        </div>
                        <div className="prepared-export-card">
                          <div>
                            <strong>WAV + synced text</strong>
                            <p>
                              Export bounded WAV parts for the selected
                              LineLight offline voice, plus a JSON timing
                              sidecar that maps every spoken word back to this
                              exact edition. Device/browser voices cannot be
                              captured reliably.
                            </p>
                          </div>
                          {preparedExportState === "exporting" && (
                            <div
                              className="prepared-narration-progress"
                              role="progressbar"
                              aria-label="WAV export progress"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={preparedExportProgress}
                            >
                              <span
                                style={{ width: `${preparedExportProgress}%` }}
                              />
                            </div>
                          )}
                          <p className="prepared-narration-status" aria-live="polite">
                            {preparedExportMessage ||
                              "Prepare this voice and pace before exporting."}
                          </p>
                          <div className="prepared-narration-actions">
                            {preparedExportState === "exporting" ? (
                              <button
                                type="button"
                                onClick={cancelPreparedExport}
                              >
                                Cancel export
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={
                                  preparedNarrationManifest?.status !== "ready"
                                }
                                onClick={exportPreparedBook}
                              >
                                Export WAV + timing
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                timingManifestInputRef.current?.click()
                              }
                            >
                              Verify timing sidecar
                            </button>
                            <input
                              ref={timingManifestInputRef}
                              type="file"
                              hidden
                              accept=".json,application/json"
                              onChange={(event) =>
                                void importTimingManifest(
                                  event.target.files?.[0],
                                )
                              }
                            />
                          </div>
                          {validatedTimingManifest && (
                            <small>
                              Verified locally · {validatedTimingManifest.parts.length}{" "}
                              {validatedTimingManifest.parts.length === 1
                                ? "part"
                                : "parts"}
                            </small>
                          )}
                        </div>
                    </div>
                    {runtimeAssetStorageBytes !== null && (
                      <small className="offline-pack-status">
                        Retained runtime files use{" "}
                        {(runtimeAssetStorageBytes / 1_000_000).toFixed(1)} MB
                        of site storage.
                      </small>
                    )}
                    <p className="online-voice-note offline-voice-note">
                      LineLight includes this voice and stores it locally on
                      first launch. After preparation, speech is generated on
                      this device and narration text never leaves it. Word
                      highlighting follows an audio-synchronized estimate
                      weighted by word length and punctuation because the
                      local model does not provide exact word timestamps.{" "}
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
