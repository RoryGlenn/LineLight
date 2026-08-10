import type { PdfOutlineItem } from "./document-outline";
import type { PdfPageLayout } from "./pdf-page-view";

export type PdfModelChunk = {
  characterStart: number;
  fullText: string;
  paragraphStart: number;
  paragraphs: string[];
  renderedParagraphs: Array<
    Array<{
      text: string;
      tokenIndex?: number;
      focusTokenIndex?: number;
      sentenceIndex: number;
    }>
  >;
  sentenceStarts: number[];
  tokenParagraphs: number[];
  tokenSentences: number[];
  tokens: Array<{
    index: number;
    text: string;
    start: number;
    end: number;
    paragraphIndex: number;
    sentenceIndex: number;
  }>;
  wordStart: number;
  nextCursor: {
    characterOffset: number;
    paragraphIndex: number;
    sentenceIndex: number;
    wordIndex: number;
  };
};

export type SerializablePdfTextContent = {
  items: Array<Record<string, unknown>>;
  styles: Record<string, Record<string, unknown>>;
  lang?: string | null;
};

export type StoredPdfPage = {
  documentId: string;
  revision: string;
  pageNumber: number;
  layout: PdfPageLayout;
  model: PdfModelChunk;
  textContent: SerializablePdfTextContent;
};

export type StoredPdfManifest = {
  id: string;
  title: string;
  author: string;
  kind: "pdf";
  paragraphs: [];
  outline?: PdfOutlineItem[];
  pdfCompletedPages: number;
  pdfImportStatus: "importing" | "ready";
  pdfPageCount: number;
  pdfRevision: string;
  pdfStorageVersion: 1;
  pdfTextModelVersion: number;
  wordCount: number;
  pdfLegacyRecovery?: Record<string, unknown> & {
    id: string;
    title: string;
    author: string;
    kind: "pdf";
    paragraphs: string[];
  };
};

export type PdfWorkerRequest =
  | {
      type: "import";
      jobId: number;
      revision: string;
      documentId: string;
      title: string;
      source: File;
      scale: number;
    }
  | {
      type: "open";
      jobId: number;
      revision: string;
      documentId: string;
      scale: number;
    }
  | {
      type: "render";
      jobId: number;
      revision: string;
      pageNumber: number;
      scale: number;
      enabled?: boolean;
      visible?: boolean;
      distance?: number;
    }
  | { type: "cancel"; jobId: number; revision: string };

export type PdfWorkerMessage =
  | {
      type: "reset";
      jobId: number;
      revision: string;
      reason: "stored-repair";
    }
  | {
      type: "page";
      jobId: number;
      revision: string;
      document: StoredPdfManifest;
      page: StoredPdfPage;
      first: boolean;
    }
  | {
      type: "bitmap";
      jobId: number;
      revision: string;
      pageNumber: number;
      scale: number;
      width: number;
      height: number;
      bitmap: ImageBitmap;
    }
  | {
      type: "progress";
      jobId: number;
      revision: string;
      completedPages: number;
      pageCount: number;
      stage: string;
    }
  | {
      type: "complete";
      jobId: number;
      revision: string;
      document: StoredPdfManifest;
    }
  | {
      type: "render-fallback";
      jobId: number;
      revision: string;
      reason: string;
    }
  | {
      type: "error";
      jobId: number;
      revision: string;
      message: string;
      outcome?:
        | "resumable"
        | "discarded"
        | "legacy-restored"
        | "uncommitted";
    };
