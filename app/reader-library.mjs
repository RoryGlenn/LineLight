import {
  PREPARED_NARRATION_RECENT_MAX_BYTES,
  PREPARED_NARRATION_RECENT_MAX_ENTRIES,
  PREPARED_NARRATION_RECENT_RETENTION,
  advancePreparedNarrationManifest,
  isPreparedNarrationChunk,
  isPreparedNarrationManifest,
  matchesPreparedNarrationChunk,
  matchesPreparedNarrationManifest,
} from "./prepared-narration.mjs";
import {
  isAudiobookManifest,
  isAudiobookTranscriptWindow,
} from "./audiobook-alignment.mjs";

export const READER_DATABASE_NAME = "guided-reader-library";
export const READER_DATABASE_VERSION = 7;
export const DOCUMENT_STORE = "documents";
export const LIBRARY_STORE = "library";
export const STATE_STORE = "state";
export const NAVIGATION_STORE = "navigation";
export const PDF_SOURCE_STORE = "pdf-sources";
export const PDF_PAGE_STORE = "pdf-pages";
export const PDF_PAGE_DOCUMENT_INDEX = "documentId";
export const PREPARED_NARRATION_STORE = "prepared-narration";
export const PREPARED_NARRATION_METADATA_STORE =
  "prepared-narration-metadata";
export const PREPARED_NARRATION_MANIFEST_STORE =
  "prepared-narration-manifests";
export const PREPARED_NARRATION_DOCUMENT_INDEX = "documentId";
export const PREPARED_NARRATION_RECENT_INDEX =
  "documentRetentionCreatedAtBytes";
export const AUDIOBOOK_MANIFEST_STORE = "audiobook-manifests";
export const AUDIOBOOK_SOURCE_STORE = "audiobook-sources";
export const AUDIOBOOK_TRANSCRIPT_STORE = "audiobook-transcripts";
export const AUDIOBOOK_DOCUMENT_INDEX = "documentId";
export const AUDIOBOOK_PROFILE_INDEX = "documentAudioId";
export const LEGACY_ACTIVE_DOCUMENT_KEY = "active-document";
export const ACTIVE_DOCUMENT_ID_KEY = "active-document-id";

const WORD_PATTERN = /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;

/**
 * @param {{ paragraphs?: string[] }} document
 */
export function countDocumentWords(document) {
  if (Number.isFinite(document?.wordCount)) {
    return Math.max(0, Math.trunc(document.wordCount));
  }
  let count = 0;
  for (const paragraph of document.paragraphs ?? []) {
    count += Array.from(paragraph.matchAll(WORD_PATTERN)).length;
  }
  return count;
}

/**
 * @param {{
 *   id: string,
 *   title: string,
 *   author: string,
 *   kind: string,
 *   paragraphs?: string[],
 * }} document
 * @param {number} timestamp
 * @param {{ createdAt?: number } | undefined} existing
 */
export function createLibraryEntry(document, timestamp, existing) {
  return {
    id: document.id,
    title: document.title,
    author: document.author,
    kind: document.kind,
    wordCount: countDocumentWords(document),
    createdAt: existing?.createdAt ?? timestamp,
    lastOpenedAt: timestamp,
  };
}

/**
 * @template {{ title: string, lastOpenedAt: number }} T
 * @param {T[]} entries
 * @returns {T[]}
 */
export function sortLibraryEntries(entries) {
  return [...entries].sort(
    (left, right) =>
      right.lastOpenedAt - left.lastOpenedAt ||
      left.title.localeCompare(right.title),
  );
}

/**
 * @template {{ title: string, author: string, kind: string }} T
 * @param {T[]} entries
 * @param {string} query
 * @returns {T[]}
 */
export function filterLibraryEntries(entries, query) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return entries;
  return entries.filter((entry) =>
    [entry.title, entry.author, entry.kind].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery),
    ),
  );
}

export function calculateLibraryProgress(
  activeWord,
  wordCount,
  hasSavedProgress = true,
) {
  if (!hasSavedProgress || !wordCount) return 0;
  const safeWord = Number.isFinite(activeWord)
    ? Math.min(Math.max(0, activeWord), wordCount - 1)
    : 0;
  return Math.round(((safeWord + 1) / wordCount) * 100);
}

/** @param {IDBRequest} request */
function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** @param {IDBTransaction} transaction */
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(undefined);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function isStoredDocument(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      typeof value.title === "string" &&
      Array.isArray(value.paragraphs),
  );
}

/**
 * Keep automatically retained WAV chunks useful without letting routine
 * playback grow into an unbounded hidden download. Explicit whole-book
 * preparation uses a different retention value and is not pruned here.
 *
 * @param {IDBObjectStore} store
 * @param {IDBObjectStore | null} metadataStore
 * @param {string} documentId
 * @param {typeof IDBKeyRange | undefined} keyRangeFactory
 */
function pruneRecentPreparedNarration(
  store,
  metadataStore,
  documentId,
  keyRangeFactory,
) {
  const index = store.index(PREPARED_NARRATION_RECENT_INDEX);
  const range = keyRangeFactory?.bound(
    [documentId, PREPARED_NARRATION_RECENT_RETENTION, 0, 0],
    [
      documentId,
      PREPARED_NARRATION_RECENT_RETENTION,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ],
  );
  const request = index.openKeyCursor(range);
  const recent = [];

  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      const indexKey = cursor.key;
      if (
        Array.isArray(indexKey) &&
        indexKey[0] === documentId &&
        indexKey[1] === PREPARED_NARRATION_RECENT_RETENTION
      ) {
        recent.push({
          byteLength: indexKey[3],
          primaryKey: cursor.primaryKey,
        });
      }
      cursor.continue();
      return;
    }

    let totalBytes = recent.reduce(
      (total, entry) => total + entry.byteLength,
      0,
    );
    let excessEntries = Math.max(
      0,
      recent.length - PREPARED_NARRATION_RECENT_MAX_ENTRIES,
    );
    for (const entry of recent) {
      if (
        excessEntries <= 0 &&
        totalBytes <= PREPARED_NARRATION_RECENT_MAX_BYTES
      ) {
        break;
      }
      store.delete(entry.primaryKey);
      metadataStore?.delete(entry.primaryKey);
      totalBytes -= entry.byteLength;
      excessEntries -= 1;
    }
  };
}

function preparedNarrationMetadata(chunk) {
  const metadata = { ...chunk };
  delete metadata.audioData;
  return metadata;
}

function deleteIndexedRecords(store, indexName, key, predicate = () => true) {
  const request = store.index(indexName).getAllKeys(key);
  request.onsuccess = () => {
    for (const primaryKey of request.result) {
      if (predicate(primaryKey)) store.delete(primaryKey);
    }
  };
}

export function createReaderLibrary({
  indexedDB: databaseFactory = globalThis.indexedDB,
  keyRange: keyRangeFactory = globalThis.IDBKeyRange,
  databaseName = READER_DATABASE_NAME,
  now = () => Date.now(),
} = {}) {
  function openDatabase() {
    if (!databaseFactory) {
      return Promise.reject(
        new Error("This browser cannot store a private reading library."),
      );
    }

    return new Promise((resolve, reject) => {
      const request = databaseFactory.open(
        databaseName,
        READER_DATABASE_VERSION,
      );
      request.onupgradeneeded = (event) => {
        const database = request.result;
        const upgradeTransaction = request.transaction;
        if (!upgradeTransaction) return;

        const documents = database.objectStoreNames.contains(DOCUMENT_STORE)
          ? upgradeTransaction.objectStore(DOCUMENT_STORE)
          : database.createObjectStore(DOCUMENT_STORE);
        const library = database.objectStoreNames.contains(LIBRARY_STORE)
          ? upgradeTransaction.objectStore(LIBRARY_STORE)
          : database.createObjectStore(LIBRARY_STORE, { keyPath: "id" });
        const state = database.objectStoreNames.contains(STATE_STORE)
          ? upgradeTransaction.objectStore(STATE_STORE)
          : database.createObjectStore(STATE_STORE);
        if (!database.objectStoreNames.contains(NAVIGATION_STORE)) {
          database.createObjectStore(NAVIGATION_STORE);
        }
        if (!database.objectStoreNames.contains(PDF_SOURCE_STORE)) {
          database.createObjectStore(PDF_SOURCE_STORE);
        }
        if (!database.objectStoreNames.contains(PDF_PAGE_STORE)) {
          const pdfPages = database.createObjectStore(PDF_PAGE_STORE, {
            keyPath: ["documentId", "pageNumber"],
          });
          pdfPages.createIndex(
            PDF_PAGE_DOCUMENT_INDEX,
            "documentId",
            { unique: false },
          );
        }
        const preparedNarration = database.objectStoreNames.contains(
          PREPARED_NARRATION_STORE,
        )
          ? upgradeTransaction.objectStore(PREPARED_NARRATION_STORE)
          : database.createObjectStore(
            PREPARED_NARRATION_STORE,
            { keyPath: ["documentId", "profileKey", "startIndex"] },
          );
        if (
          !preparedNarration.indexNames.contains(
            PREPARED_NARRATION_DOCUMENT_INDEX,
          )
        ) {
          preparedNarration.createIndex(
            PREPARED_NARRATION_DOCUMENT_INDEX,
            "documentId",
            { unique: false },
          );
        }
        if (
          !preparedNarration.indexNames.contains(
            PREPARED_NARRATION_RECENT_INDEX,
          )
        ) {
          preparedNarration.createIndex(
            PREPARED_NARRATION_RECENT_INDEX,
            ["documentId", "retention", "createdAt", "audioByteLength"],
            { unique: false },
          );
        }
        const preparedMetadata = database.objectStoreNames.contains(
          PREPARED_NARRATION_METADATA_STORE,
        )
          ? upgradeTransaction.objectStore(PREPARED_NARRATION_METADATA_STORE)
          : database.createObjectStore(PREPARED_NARRATION_METADATA_STORE, {
            keyPath: ["documentId", "profileKey", "startIndex"],
          });
        if (
          !preparedMetadata.indexNames.contains(
            PREPARED_NARRATION_DOCUMENT_INDEX,
          )
        ) {
          preparedMetadata.createIndex(
            PREPARED_NARRATION_DOCUMENT_INDEX,
            "documentId",
            { unique: false },
          );
        }
        const preparedManifests = database.objectStoreNames.contains(
          PREPARED_NARRATION_MANIFEST_STORE,
        )
          ? upgradeTransaction.objectStore(PREPARED_NARRATION_MANIFEST_STORE)
          : database.createObjectStore(PREPARED_NARRATION_MANIFEST_STORE, {
            keyPath: ["documentId", "profileKey"],
          });
        if (
          !preparedManifests.indexNames.contains(
            PREPARED_NARRATION_DOCUMENT_INDEX,
          )
        ) {
          preparedManifests.createIndex(
            PREPARED_NARRATION_DOCUMENT_INDEX,
            "documentId",
            { unique: false },
          );
        }

        const audiobookManifests = database.objectStoreNames.contains(
          AUDIOBOOK_MANIFEST_STORE,
        )
          ? upgradeTransaction.objectStore(AUDIOBOOK_MANIFEST_STORE)
          : database.createObjectStore(AUDIOBOOK_MANIFEST_STORE, {
            keyPath: ["documentId", "audioId"],
          });
        if (!audiobookManifests.indexNames.contains(AUDIOBOOK_DOCUMENT_INDEX)) {
          audiobookManifests.createIndex(
            AUDIOBOOK_DOCUMENT_INDEX,
            "documentId",
            { unique: false },
          );
        }

        const audiobookSources = database.objectStoreNames.contains(
          AUDIOBOOK_SOURCE_STORE,
        )
          ? upgradeTransaction.objectStore(AUDIOBOOK_SOURCE_STORE)
          : database.createObjectStore(AUDIOBOOK_SOURCE_STORE, {
            keyPath: ["documentId", "audioId", "partIndex"],
          });
        if (!audiobookSources.indexNames.contains(AUDIOBOOK_DOCUMENT_INDEX)) {
          audiobookSources.createIndex(
            AUDIOBOOK_DOCUMENT_INDEX,
            "documentId",
            { unique: false },
          );
        }
        if (!audiobookSources.indexNames.contains(AUDIOBOOK_PROFILE_INDEX)) {
          audiobookSources.createIndex(
            AUDIOBOOK_PROFILE_INDEX,
            ["documentId", "audioId"],
            { unique: false },
          );
        }

        const audiobookTranscripts = database.objectStoreNames.contains(
          AUDIOBOOK_TRANSCRIPT_STORE,
        )
          ? upgradeTransaction.objectStore(AUDIOBOOK_TRANSCRIPT_STORE)
          : database.createObjectStore(AUDIOBOOK_TRANSCRIPT_STORE, {
            keyPath: [
              "documentId",
              "audioId",
              "partIndex",
              "windowIndex",
            ],
          });
        if (
          !audiobookTranscripts.indexNames.contains(AUDIOBOOK_DOCUMENT_INDEX)
        ) {
          audiobookTranscripts.createIndex(
            AUDIOBOOK_DOCUMENT_INDEX,
            "documentId",
            { unique: false },
          );
        }
        if (
          !audiobookTranscripts.indexNames.contains(AUDIOBOOK_PROFILE_INDEX)
        ) {
          audiobookTranscripts.createIndex(
            AUDIOBOOK_PROFILE_INDEX,
            ["documentId", "audioId"],
            { unique: false },
          );
        }

        if (event.oldVersion > 0 && event.oldVersion < 7) {
          // Prepared narration schema 2 adds explicit compression and token
          // timing fields. Older derived audio is safely invalidated rather
          // than guessed into the new format.
          preparedNarration.clear();
          preparedMetadata.clear();
          preparedManifests.clear();
        }

        if (event.oldVersion < 2) {
          const legacyRequest = documents.get(LEGACY_ACTIVE_DOCUMENT_KEY);
          legacyRequest.onsuccess = () => {
            const document = legacyRequest.result;
            if (!isStoredDocument(document)) return;
            const timestamp = now();
            documents.put(document, document.id);
            documents.delete(LEGACY_ACTIVE_DOCUMENT_KEY);
            library.put(createLibraryEntry(document, timestamp));
            state.put(document.id, ACTIVE_DOCUMENT_ID_KEY);
          };
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("Close other LineLight tabs and try again."));
    });
  }

  async function load() {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [LIBRARY_STORE, STATE_STORE],
        "readonly",
      );
      const entriesRequest = transaction.objectStore(LIBRARY_STORE).getAll();
      const activeRequest = transaction
        .objectStore(STATE_STORE)
        .get(ACTIVE_DOCUMENT_ID_KEY);
      const [entries, activeDocumentId] = await Promise.all([
        requestValue(entriesRequest),
        requestValue(activeRequest),
        transactionDone(transaction),
      ]);
      return {
        entries: sortLibraryEntries(entries),
        activeDocumentId:
          typeof activeDocumentId === "string" ? activeDocumentId : null,
      };
    } finally {
      database.close();
    }
  }

  async function getDocument(documentId) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(DOCUMENT_STORE, "readonly");
      const document = await requestValue(
        transaction.objectStore(DOCUMENT_STORE).get(documentId),
      );
      await transactionDone(transaction);
      return isStoredDocument(document) ? document : null;
    } finally {
      database.close();
    }
  }

  async function addDocument(document) {
    const database = await openDatabase();
    try {
      const timestamp = now();
      const entry = createLibraryEntry(document, timestamp);
      const transaction = database.transaction(
        [DOCUMENT_STORE, LIBRARY_STORE, STATE_STORE],
        "readwrite",
      );
      transaction.objectStore(DOCUMENT_STORE).put(document, document.id);
      transaction.objectStore(LIBRARY_STORE).put(entry);
      transaction
        .objectStore(STATE_STORE)
        .put(document.id, ACTIVE_DOCUMENT_ID_KEY);
      await transactionDone(transaction);
      return entry;
    } finally {
      database.close();
    }
  }

  async function addPdfDocumentPageOne(document, source, page) {
    if (
      !isStoredDocument(document) ||
      document.kind !== "pdf" ||
      document.pdfStorageVersion !== 1 ||
      !(source instanceof Blob) ||
      !page ||
      page.documentId !== document.id ||
      page.revision !== document.pdfRevision ||
      page.pageNumber !== 1
    ) {
      throw new Error("This PDF import cannot be saved.");
    }
    const database = await openDatabase();
    try {
      const timestamp = now();
      const entry = createLibraryEntry(document, timestamp);
      const transaction = database.transaction(
        [
          DOCUMENT_STORE,
          LIBRARY_STORE,
          STATE_STORE,
          PDF_SOURCE_STORE,
          PDF_PAGE_STORE,
        ],
        "readwrite",
      );
      transaction.objectStore(DOCUMENT_STORE).put(document, document.id);
      transaction.objectStore(LIBRARY_STORE).put(entry);
      transaction
        .objectStore(STATE_STORE)
        .put(document.id, ACTIVE_DOCUMENT_ID_KEY);
      transaction.objectStore(PDF_SOURCE_STORE).put(source, document.id);
      const pdfPages = transaction.objectStore(PDF_PAGE_STORE);
      const priorPageKeysRequest = pdfPages
        .index(PDF_PAGE_DOCUMENT_INDEX)
        .getAllKeys(document.id);
      priorPageKeysRequest.onsuccess = () => {
        for (const key of priorPageKeysRequest.result) pdfPages.delete(key);
        pdfPages.put(page);
      };
      await transactionDone(transaction);
      return entry;
    } finally {
      database.close();
    }
  }

  async function appendPdfDocumentPage(documentId, revision, page, progress) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [DOCUMENT_STORE, LIBRARY_STORE, PDF_PAGE_STORE],
        "readwrite",
      );
      const documents = transaction.objectStore(DOCUMENT_STORE);
      const library = transaction.objectStore(LIBRARY_STORE);
      const documentRequest = documents.get(documentId);
      let updatedDocument = null;
      documentRequest.onsuccess = () => {
        const document = documentRequest.result;
        if (
          !isStoredDocument(document) ||
          document.kind !== "pdf" ||
          document.pdfStorageVersion !== 1 ||
          document.pdfRevision !== revision ||
          page?.documentId !== documentId ||
          page?.revision !== revision
        ) {
          transaction.abort();
          return;
        }
        updatedDocument = {
          ...document,
          pdfCompletedPages: Math.max(
            document.pdfCompletedPages ?? 0,
            progress.completedPages ?? page.pageNumber,
          ),
          wordCount: Math.max(
            document.wordCount ?? 0,
            progress.wordCount ?? 0,
          ),
        };
        transaction.objectStore(PDF_PAGE_STORE).put(page);
        documents.put(updatedDocument, documentId);
        const entryRequest = library.get(documentId);
        entryRequest.onsuccess = () => {
          if (!entryRequest.result) return;
          library.put({
            ...entryRequest.result,
            wordCount: updatedDocument.wordCount,
          });
        };
      };
      await transactionDone(transaction);
      if (!updatedDocument) {
        throw new Error("This PDF import was superseded.");
      }
      return updatedDocument;
    } finally {
      database.close();
    }
  }

  async function completePdfDocument(documentId, revision, completion) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [DOCUMENT_STORE, LIBRARY_STORE],
        "readwrite",
      );
      const documents = transaction.objectStore(DOCUMENT_STORE);
      const library = transaction.objectStore(LIBRARY_STORE);
      const documentRequest = documents.get(documentId);
      let completedDocument = null;
      documentRequest.onsuccess = () => {
        const document = documentRequest.result;
        if (
          !isStoredDocument(document) ||
          document.kind !== "pdf" ||
          document.pdfStorageVersion !== 1 ||
          document.pdfRevision !== revision
        ) {
          transaction.abort();
          return;
        }
        const durableDocument = { ...document };
        delete durableDocument.pdfLegacyRecovery;
        completedDocument = {
          ...durableDocument,
          outline: completion.outline ?? [],
          pdfCompletedPages: document.pdfPageCount,
          pdfImportStatus: "ready",
          wordCount: Math.max(0, Math.trunc(completion.wordCount ?? 0)),
        };
        documents.put(completedDocument, documentId);
        const entryRequest = library.get(documentId);
        entryRequest.onsuccess = () => {
          if (!entryRequest.result) return;
          library.put({
            ...entryRequest.result,
            wordCount: completedDocument.wordCount,
          });
        };
      };
      await transactionDone(transaction);
      if (!completedDocument) {
        throw new Error("This PDF import was superseded.");
      }
      return completedDocument;
    } finally {
      database.close();
    }
  }

  async function getPdfSource(documentId) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(PDF_SOURCE_STORE, "readonly");
      const source = await requestValue(
        transaction.objectStore(PDF_SOURCE_STORE).get(documentId),
      );
      await transactionDone(transaction);
      return source instanceof Blob ? source : null;
    } finally {
      database.close();
    }
  }

  async function getPdfPages(documentId) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(PDF_PAGE_STORE, "readonly");
      const pages = await requestValue(
        transaction
          .objectStore(PDF_PAGE_STORE)
          .index(PDF_PAGE_DOCUMENT_INDEX)
          .getAll(documentId),
      );
      await transactionDone(transaction);
      return pages.sort((left, right) => left.pageNumber - right.pageNumber);
    } finally {
      database.close();
    }
  }

  async function getPdfPage(documentId, pageNumber) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(PDF_PAGE_STORE, "readonly");
      const page = await requestValue(
        transaction
          .objectStore(PDF_PAGE_STORE)
          .get([documentId, Math.max(1, Math.trunc(pageNumber))]),
      );
      await transactionDone(transaction);
      return page ?? null;
    } finally {
      database.close();
    }
  }

  async function getPdfPageBatch(documentId, startPage, count = 12) {
    const database = await openDatabase();
    try {
      const first = Math.max(1, Math.trunc(startPage));
      const size = Math.min(24, Math.max(1, Math.trunc(count)));
      const transaction = database.transaction(PDF_PAGE_STORE, "readonly");
      const store = transaction.objectStore(PDF_PAGE_STORE);
      const pages = await Promise.all(
        Array.from({ length: size }, (_, offset) =>
          requestValue(store.get([documentId, first + offset])),
        ),
      );
      await transactionDone(transaction);
      return pages.filter(Boolean);
    } finally {
      database.close();
    }
  }

  async function restoreLegacyPdfDocument(documentId, revision) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [
          DOCUMENT_STORE,
          LIBRARY_STORE,
          PDF_SOURCE_STORE,
          PDF_PAGE_STORE,
        ],
        "readwrite",
      );
      const documents = transaction.objectStore(DOCUMENT_STORE);
      const request = documents.get(documentId);
      let restored = false;
      request.onsuccess = () => {
        const staged = request.result;
        const recovery = staged?.pdfLegacyRecovery;
        if (
          !isStoredDocument(staged) ||
          staged.pdfRevision !== revision ||
          !isStoredDocument(recovery)
        ) {
          transaction.abort();
          return;
        }
        restored = true;
        documents.put(recovery, documentId);
        const library = transaction.objectStore(LIBRARY_STORE);
        const entryRequest = library.get(documentId);
        entryRequest.onsuccess = () => {
          library.put(
            createLibraryEntry(recovery, now(), entryRequest.result),
          );
        };
        transaction.objectStore(PDF_SOURCE_STORE).delete(documentId);
        const pages = transaction.objectStore(PDF_PAGE_STORE);
        const keysRequest = pages
          .index(PDF_PAGE_DOCUMENT_INDEX)
          .getAllKeys(documentId);
        keysRequest.onsuccess = () => {
          for (const key of keysRequest.result) pages.delete(key);
        };
      };
      await transactionDone(transaction);
      return restored;
    } finally {
      database.close();
    }
  }

  async function discardPdfDocument(documentId, revision) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [
          DOCUMENT_STORE,
          LIBRARY_STORE,
          STATE_STORE,
          PDF_SOURCE_STORE,
          PDF_PAGE_STORE,
        ],
        "readwrite",
      );
      const documents = transaction.objectStore(DOCUMENT_STORE);
      const request = documents.get(documentId);
      let discarded = false;
      request.onsuccess = () => {
        const document = request.result;
        if (
          !isStoredDocument(document) ||
          document.kind !== "pdf" ||
          document.pdfRevision !== revision
        ) {
          transaction.abort();
          return;
        }
        discarded = true;
        documents.delete(documentId);
        transaction.objectStore(LIBRARY_STORE).delete(documentId);
        transaction.objectStore(PDF_SOURCE_STORE).delete(documentId);
        const pages = transaction.objectStore(PDF_PAGE_STORE);
        const keysRequest = pages
          .index(PDF_PAGE_DOCUMENT_INDEX)
          .getAllKeys(documentId);
        keysRequest.onsuccess = () => {
          for (const key of keysRequest.result) pages.delete(key);
        };
        const state = transaction.objectStore(STATE_STORE);
        const activeRequest = state.get(ACTIVE_DOCUMENT_ID_KEY);
        activeRequest.onsuccess = () => {
          if (activeRequest.result === documentId) {
            state.delete(ACTIVE_DOCUMENT_ID_KEY);
          }
        };
      };
      await transactionDone(transaction);
      return discarded;
    } finally {
      database.close();
    }
  }

  async function saveDocument(document) {
    if (!isStoredDocument(document)) {
      throw new Error("This document cannot be saved.");
    }
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [DOCUMENT_STORE, LIBRARY_STORE],
        "readwrite",
      );
      transaction.objectStore(DOCUMENT_STORE).put(document, document.id);
      const library = transaction.objectStore(LIBRARY_STORE);
      const entryRequest = library.get(document.id);
      entryRequest.onsuccess = () => {
        if (!entryRequest.result) return;
        library.put({
          ...entryRequest.result,
          title: document.title,
          author: document.author,
          wordCount: countDocumentWords(document),
        });
      };
      await transactionDone(transaction);
      return document;
    } finally {
      database.close();
    }
  }

  async function openDocument(documentId) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [DOCUMENT_STORE, LIBRARY_STORE, STATE_STORE],
        "readwrite",
      );
      const documents = transaction.objectStore(DOCUMENT_STORE);
      const library = transaction.objectStore(LIBRARY_STORE);
      const state = transaction.objectStore(STATE_STORE);
      let document = null;
      let entry = null;
      const documentRequest = documents.get(documentId);
      documentRequest.onsuccess = () => {
        if (!isStoredDocument(documentRequest.result)) return;
        document = documentRequest.result;
        const entryRequest = library.get(documentId);
        entryRequest.onsuccess = () => {
          const timestamp = now();
          entry = createLibraryEntry(
            documentRequest.result,
            timestamp,
            entryRequest.result,
          );
          library.put(entry);
          state.put(documentId, ACTIVE_DOCUMENT_ID_KEY);
        };
      };
      await transactionDone(transaction);
      return { document, entry };
    } finally {
      database.close();
    }
  }

  async function openDocumentMetadata(documentId) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [LIBRARY_STORE, STATE_STORE],
        "readwrite",
      );
      const library = transaction.objectStore(LIBRARY_STORE);
      const entryRequest = library.get(documentId);
      let entry = null;
      entryRequest.onsuccess = () => {
        if (!entryRequest.result) return;
        entry = { ...entryRequest.result, lastOpenedAt: now() };
        library.put(entry);
        transaction
          .objectStore(STATE_STORE)
          .put(documentId, ACTIVE_DOCUMENT_ID_KEY);
      };
      await transactionDone(transaction);
      return entry;
    } finally {
      database.close();
    }
  }

  async function renameDocument(documentId, title) {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error("Enter a title for this document.");

    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [DOCUMENT_STORE, LIBRARY_STORE],
        "readwrite",
      );
      const documents = transaction.objectStore(DOCUMENT_STORE);
      const library = transaction.objectStore(LIBRARY_STORE);
      let updatedDocument = null;
      let updatedEntry = null;
      let documentResult;
      let entryResult;
      let completedRequests = 0;
      const updateRecords = () => {
        completedRequests += 1;
        if (completedRequests < 2 || !isStoredDocument(documentResult)) return;
        updatedDocument = { ...documentResult, title: normalizedTitle };
        updatedEntry = {
          ...(entryResult ?? createLibraryEntry(documentResult, now())),
          title: normalizedTitle,
        };
        documents.put(updatedDocument, documentId);
        library.put(updatedEntry);
      };
      const documentRequest = documents.get(documentId);
      documentRequest.onsuccess = () => {
        documentResult = documentRequest.result;
        updateRecords();
      };
      const entryRequest = library.get(documentId);
      entryRequest.onsuccess = () => {
        entryResult = entryRequest.result;
        updateRecords();
      };
      await transactionDone(transaction);
      if (!updatedDocument || !updatedEntry) {
        throw new Error("This document is no longer in the library.");
      }
      return { document: updatedDocument, entry: updatedEntry };
    } finally {
      database.close();
    }
  }

  async function removeDocument(documentId) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [
          DOCUMENT_STORE,
          LIBRARY_STORE,
          STATE_STORE,
          NAVIGATION_STORE,
          PDF_SOURCE_STORE,
          PDF_PAGE_STORE,
          PREPARED_NARRATION_STORE,
          PREPARED_NARRATION_METADATA_STORE,
          PREPARED_NARRATION_MANIFEST_STORE,
          AUDIOBOOK_MANIFEST_STORE,
          AUDIOBOOK_SOURCE_STORE,
          AUDIOBOOK_TRANSCRIPT_STORE,
        ],
        "readwrite",
      );
      transaction.objectStore(DOCUMENT_STORE).delete(documentId);
      transaction.objectStore(LIBRARY_STORE).delete(documentId);
      transaction.objectStore(NAVIGATION_STORE).delete(documentId);
      transaction.objectStore(PDF_SOURCE_STORE).delete(documentId);
      const pdfPages = transaction.objectStore(PDF_PAGE_STORE);
      const pageKeysRequest = pdfPages
        .index(PDF_PAGE_DOCUMENT_INDEX)
        .getAllKeys(documentId);
      pageKeysRequest.onsuccess = () => {
        for (const key of pageKeysRequest.result) pdfPages.delete(key);
      };
      for (const storeName of [
        PREPARED_NARRATION_STORE,
        PREPARED_NARRATION_METADATA_STORE,
        PREPARED_NARRATION_MANIFEST_STORE,
      ]) {
        deleteIndexedRecords(
          transaction.objectStore(storeName),
          PREPARED_NARRATION_DOCUMENT_INDEX,
          documentId,
        );
      }
      for (const storeName of [
        AUDIOBOOK_MANIFEST_STORE,
        AUDIOBOOK_SOURCE_STORE,
        AUDIOBOOK_TRANSCRIPT_STORE,
      ]) {
        deleteIndexedRecords(
          transaction.objectStore(storeName),
          AUDIOBOOK_DOCUMENT_INDEX,
          documentId,
        );
      }
      const state = transaction.objectStore(STATE_STORE);
      const activeRequest = state.get(ACTIVE_DOCUMENT_ID_KEY);
      activeRequest.onsuccess = () => {
        if (activeRequest.result === documentId) {
          state.delete(ACTIVE_DOCUMENT_ID_KEY);
        }
      };
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async function getNavigation(documentId) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(NAVIGATION_STORE, "readonly");
      const navigation = await requestValue(
        transaction.objectStore(NAVIGATION_STORE).get(documentId),
      );
      await transactionDone(transaction);
      if (!navigation || typeof navigation !== "object") {
        return { version: 1, bookmarks: [], history: [] };
      }
      return {
        version: 1,
        bookmarks: Array.isArray(navigation.bookmarks)
          ? navigation.bookmarks
          : [],
        history: Array.isArray(navigation.history) ? navigation.history : [],
      };
    } finally {
      database.close();
    }
  }

  async function getPreparedNarrationChunk(expected) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        PREPARED_NARRATION_STORE,
        "readonly",
      );
      const record = await requestValue(
        transaction.objectStore(PREPARED_NARRATION_STORE).get([
          expected.documentId,
          expected.profileKey,
          expected.startIndex,
        ]),
      );
      await transactionDone(transaction);
      return matchesPreparedNarrationChunk(record, expected) ? record : null;
    } finally {
      database.close();
    }
  }

  async function getPreparedNarrationManifest(expected) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        PREPARED_NARRATION_MANIFEST_STORE,
        "readonly",
      );
      const record = await requestValue(
        transaction.objectStore(PREPARED_NARRATION_MANIFEST_STORE).get([
          expected.documentId,
          expected.profileKey,
        ]),
      );
      await transactionDone(transaction);
      if (!isPreparedNarrationManifest(record)) return null;
      if (
        expected.documentFingerprint &&
        !matchesPreparedNarrationManifest(record, expected)
      ) {
        return null;
      }
      return record;
    } finally {
      database.close();
    }
  }

  async function listPreparedNarrationManifests(documentId) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        PREPARED_NARRATION_MANIFEST_STORE,
        "readonly",
      );
      const records = await requestValue(
        transaction
          .objectStore(PREPARED_NARRATION_MANIFEST_STORE)
          .index(PREPARED_NARRATION_DOCUMENT_INDEX)
          .getAll(documentId),
      );
      await transactionDone(transaction);
      return records
        .filter(isPreparedNarrationManifest)
        .sort((left, right) => right.updatedAt - left.updatedAt);
    } finally {
      database.close();
    }
  }

  async function listPreparedNarrationChunkMetadata(documentId, profileKey) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        PREPARED_NARRATION_METADATA_STORE,
        "readonly",
      );
      const records = await requestValue(
        transaction
          .objectStore(PREPARED_NARRATION_METADATA_STORE)
          .index(PREPARED_NARRATION_DOCUMENT_INDEX)
          .getAll(documentId),
      );
      await transactionDone(transaction);
      return records
        .filter(
          (record) =>
            record?.profileKey === profileKey &&
            Number.isInteger(record.startIndex) &&
            Number.isInteger(record.nextIndex) &&
            record.nextIndex > record.startIndex &&
            Array.isArray(record.boundaries) &&
            Number.isFinite(record.audioDurationSeconds) &&
            Number.isInteger(record.sourceAudioByteLength),
        )
        .sort((left, right) => left.startIndex - right.startIndex);
    } finally {
      database.close();
    }
  }

  async function findPreparedNarrationChunk(documentId, profileKey, tokenIndex) {
    const metadata = await listPreparedNarrationChunkMetadata(
      documentId,
      profileKey,
    );
    const match = metadata.find(
      (chunk) =>
        chunk.startIndex <= tokenIndex && tokenIndex < chunk.nextIndex,
    );
    if (!match) return null;
    return getPreparedNarrationChunk({
      documentId,
      profileKey,
      startIndex: match.startIndex,
      nextIndex: match.nextIndex,
      textFingerprint: match.textFingerprint,
    });
  }

  async function savePreparedNarrationManifest(manifest) {
    if (!isPreparedNarrationManifest(manifest)) {
      throw new TypeError("This prepared narration manifest is invalid.");
    }
    const database = await openDatabase();
    try {
      let saved = false;
      const transaction = database.transaction(
        [DOCUMENT_STORE, PREPARED_NARRATION_MANIFEST_STORE],
        "readwrite",
      );
      const documentRequest = transaction
        .objectStore(DOCUMENT_STORE)
        .get(manifest.documentId);
      documentRequest.onsuccess = () => {
        if (!isStoredDocument(documentRequest.result)) return;
        transaction
          .objectStore(PREPARED_NARRATION_MANIFEST_STORE)
          .put(manifest);
        saved = true;
      };
      await transactionDone(transaction);
      return saved;
    } finally {
      database.close();
    }
  }

  async function commitPreparedNarrationChunk(manifest, chunk) {
    if (
      !isPreparedNarrationManifest(manifest) ||
      !isPreparedNarrationChunk(chunk)
    ) {
      throw new TypeError("This prepared narration progress is invalid.");
    }
    // Validate ordering before opening a transaction so malformed writes do
    // not partially replace a valid profile.
    advancePreparedNarrationManifest(manifest, chunk, now());

    const database = await openDatabase();
    try {
      let committedManifest = null;
      const transaction = database.transaction(
        [
          DOCUMENT_STORE,
          PREPARED_NARRATION_STORE,
          PREPARED_NARRATION_METADATA_STORE,
          PREPARED_NARRATION_MANIFEST_STORE,
        ],
        "readwrite",
      );
      const documents = transaction.objectStore(DOCUMENT_STORE);
      const manifests = transaction.objectStore(
        PREPARED_NARRATION_MANIFEST_STORE,
      );
      const documentRequest = documents.get(manifest.documentId);
      documentRequest.onsuccess = () => {
        if (!isStoredDocument(documentRequest.result)) return;
        const currentRequest = manifests.get([
          manifest.documentId,
          manifest.profileKey,
        ]);
        currentRequest.onsuccess = () => {
          const current = currentRequest.result;
          if (
            !isPreparedNarrationManifest(current) ||
            current.documentFingerprint !== manifest.documentFingerprint ||
            current.totalTokens !== manifest.totalTokens ||
            current.nextIndex !== manifest.nextIndex
          ) {
            transaction.abort();
            return;
          }
          committedManifest = advancePreparedNarrationManifest(
            current,
            chunk,
            now(),
          );
          transaction.objectStore(PREPARED_NARRATION_STORE).put(chunk);
          transaction
            .objectStore(PREPARED_NARRATION_METADATA_STORE)
            .put(preparedNarrationMetadata(chunk));
          manifests.put(committedManifest);
        };
      };
      await transactionDone(transaction);
      return committedManifest;
    } finally {
      database.close();
    }
  }

  async function savePreparedNarrationChunk(chunk) {
    if (!isPreparedNarrationChunk(chunk)) {
      throw new TypeError("This prepared narration chunk is invalid.");
    }
    const database = await openDatabase();
    try {
      let saved = false;
      const transaction = database.transaction(
        [
          DOCUMENT_STORE,
          PREPARED_NARRATION_STORE,
          PREPARED_NARRATION_METADATA_STORE,
        ],
        "readwrite",
      );
      const documentRequest = transaction
        .objectStore(DOCUMENT_STORE)
        .get(chunk.documentId);
      documentRequest.onsuccess = () => {
        if (!isStoredDocument(documentRequest.result)) return;
        const preparedNarration = transaction.objectStore(
          PREPARED_NARRATION_STORE,
        );
        const putRequest = preparedNarration.put(chunk);
        const metadata = transaction.objectStore(
          PREPARED_NARRATION_METADATA_STORE,
        );
        metadata.put(preparedNarrationMetadata(chunk));
        putRequest.onsuccess = () => {
          if (chunk.retention === PREPARED_NARRATION_RECENT_RETENTION) {
            pruneRecentPreparedNarration(
              preparedNarration,
              metadata,
              chunk.documentId,
              keyRangeFactory,
            );
          }
        };
        saved = true;
      };
      await transactionDone(transaction);
      return saved;
    } finally {
      database.close();
    }
  }

  async function removePreparedNarration(documentId, profileKey = null) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [
          PREPARED_NARRATION_STORE,
          PREPARED_NARRATION_METADATA_STORE,
          PREPARED_NARRATION_MANIFEST_STORE,
        ],
        "readwrite",
      );
      for (const storeName of [
        PREPARED_NARRATION_STORE,
        PREPARED_NARRATION_METADATA_STORE,
        PREPARED_NARRATION_MANIFEST_STORE,
      ]) {
        deleteIndexedRecords(
          transaction.objectStore(storeName),
          PREPARED_NARRATION_DOCUMENT_INDEX,
          documentId,
          (key) => !profileKey || (Array.isArray(key) && key[1] === profileKey),
        );
      }
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async function attachAudiobook(manifest, sources) {
    if (!isAudiobookManifest(manifest)) {
      throw new TypeError("This audiobook manifest is invalid.");
    }
    if (
      !Array.isArray(sources) ||
      sources.length !== manifest.parts.length ||
      sources.some(
        (source, partIndex) =>
          !(source instanceof Blob) ||
          source.size !== manifest.parts[partIndex].sourceByteLength,
      )
    ) {
      throw new TypeError("This audiobook source is incomplete.");
    }
    const database = await openDatabase();
    try {
      let saved = false;
      const transaction = database.transaction(
        [
          DOCUMENT_STORE,
          AUDIOBOOK_MANIFEST_STORE,
          AUDIOBOOK_SOURCE_STORE,
          AUDIOBOOK_TRANSCRIPT_STORE,
        ],
        "readwrite",
      );
      const documentRequest = transaction
        .objectStore(DOCUMENT_STORE)
        .get(manifest.documentId);
      documentRequest.onsuccess = () => {
        if (!isStoredDocument(documentRequest.result)) return;
        const sourceStore = transaction.objectStore(AUDIOBOOK_SOURCE_STORE);
        const transcriptStore = transaction.objectStore(
          AUDIOBOOK_TRANSCRIPT_STORE,
        );
        const profileKey = [manifest.documentId, manifest.audioId];
        const sourceKeysRequest = sourceStore
          .index(AUDIOBOOK_PROFILE_INDEX)
          .getAllKeys(profileKey);
        sourceKeysRequest.onsuccess = () => {
          const transcriptKeysRequest = transcriptStore
            .index(AUDIOBOOK_PROFILE_INDEX)
            .getAllKeys(profileKey);
          transcriptKeysRequest.onsuccess = () => {
            for (const key of sourceKeysRequest.result) {
              sourceStore.delete(key);
            }
            for (const key of transcriptKeysRequest.result) {
              transcriptStore.delete(key);
            }
            for (
              let partIndex = 0;
              partIndex < sources.length;
              partIndex += 1
            ) {
              const part = manifest.parts[partIndex];
              sourceStore.put({
                documentId: manifest.documentId,
                audioId: manifest.audioId,
                partIndex,
                filename: part.filename,
                mimeType: part.mimeType,
                durationSeconds: part.durationSeconds,
                sourceByteLength: part.sourceByteLength,
                blob: sources[partIndex],
              });
            }
            transaction.objectStore(AUDIOBOOK_MANIFEST_STORE).put(manifest);
            saved = true;
          };
        };
      };
      await transactionDone(transaction);
      return saved;
    } finally {
      database.close();
    }
  }

  async function getAudiobookManifest(documentId, audioId) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        AUDIOBOOK_MANIFEST_STORE,
        "readonly",
      );
      const record = await requestValue(
        transaction
          .objectStore(AUDIOBOOK_MANIFEST_STORE)
          .get([documentId, audioId]),
      );
      await transactionDone(transaction);
      return isAudiobookManifest(record) ? record : null;
    } finally {
      database.close();
    }
  }

  async function listAudiobookManifests(documentId) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        AUDIOBOOK_MANIFEST_STORE,
        "readonly",
      );
      const records = await requestValue(
        transaction
          .objectStore(AUDIOBOOK_MANIFEST_STORE)
          .index(AUDIOBOOK_DOCUMENT_INDEX)
          .getAll(documentId),
      );
      await transactionDone(transaction);
      return records
        .filter(isAudiobookManifest)
        .sort((left, right) => right.updatedAt - left.updatedAt);
    } finally {
      database.close();
    }
  }

  async function getAudiobookSource(documentId, audioId, partIndex) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        AUDIOBOOK_SOURCE_STORE,
        "readonly",
      );
      const record = await requestValue(
        transaction
          .objectStore(AUDIOBOOK_SOURCE_STORE)
          .get([documentId, audioId, partIndex]),
      );
      await transactionDone(transaction);
      return record?.blob instanceof Blob ? record : null;
    } finally {
      database.close();
    }
  }

  async function listAudiobookTranscriptWindows(documentId, audioId) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        AUDIOBOOK_TRANSCRIPT_STORE,
        "readonly",
      );
      const records = await requestValue(
        transaction
          .objectStore(AUDIOBOOK_TRANSCRIPT_STORE)
          .index(AUDIOBOOK_PROFILE_INDEX)
          .getAll([documentId, audioId]),
      );
      await transactionDone(transaction);
      return records
        .filter(isAudiobookTranscriptWindow)
        .sort(
          (left, right) =>
            left.partIndex - right.partIndex ||
            left.windowIndex - right.windowIndex,
        );
    } finally {
      database.close();
    }
  }

  async function saveAudiobookManifest(manifest) {
    if (!isAudiobookManifest(manifest)) {
      throw new TypeError("This audiobook manifest is invalid.");
    }
    const database = await openDatabase();
    try {
      let saved = false;
      const transaction = database.transaction(
        [DOCUMENT_STORE, AUDIOBOOK_MANIFEST_STORE],
        "readwrite",
      );
      const documentRequest = transaction
        .objectStore(DOCUMENT_STORE)
        .get(manifest.documentId);
      documentRequest.onsuccess = () => {
        if (!isStoredDocument(documentRequest.result)) return;
        transaction.objectStore(AUDIOBOOK_MANIFEST_STORE).put(manifest);
        saved = true;
      };
      await transactionDone(transaction);
      return saved;
    } finally {
      database.close();
    }
  }

  async function commitAudiobookTranscriptWindow(manifest, window) {
    if (
      !isAudiobookManifest(manifest) ||
      !isAudiobookTranscriptWindow(window) ||
      manifest.documentId !== window.documentId ||
      manifest.audioId !== window.audioId
    ) {
      throw new TypeError("This audiobook alignment progress is invalid.");
    }
    const database = await openDatabase();
    try {
      let saved = false;
      const transaction = database.transaction(
        [
          AUDIOBOOK_MANIFEST_STORE,
          AUDIOBOOK_SOURCE_STORE,
          AUDIOBOOK_TRANSCRIPT_STORE,
        ],
        "readwrite",
      );
      const manifests = transaction.objectStore(AUDIOBOOK_MANIFEST_STORE);
      const currentRequest = manifests.get([
        manifest.documentId,
        manifest.audioId,
      ]);
      currentRequest.onsuccess = () => {
        const current = currentRequest.result;
        if (
          !isAudiobookManifest(current) ||
          manifest.processedWindows < current.processedWindows ||
          manifest.processedWindows > current.processedWindows + 1
        ) {
          transaction.abort();
          return;
        }
        const sourceRequest = transaction
          .objectStore(AUDIOBOOK_SOURCE_STORE)
          .get([manifest.documentId, manifest.audioId, window.partIndex]);
        sourceRequest.onsuccess = () => {
          if (!(sourceRequest.result?.blob instanceof Blob)) {
            transaction.abort();
            return;
          }
          transaction.objectStore(AUDIOBOOK_TRANSCRIPT_STORE).put(window);
          manifests.put(manifest);
          saved = true;
        };
      };
      await transactionDone(transaction);
      return saved;
    } finally {
      database.close();
    }
  }

  async function removeAudiobook(documentId, audioId) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [
          AUDIOBOOK_MANIFEST_STORE,
          AUDIOBOOK_SOURCE_STORE,
          AUDIOBOOK_TRANSCRIPT_STORE,
        ],
        "readwrite",
      );
      transaction
        .objectStore(AUDIOBOOK_MANIFEST_STORE)
        .delete([documentId, audioId]);
      for (const storeName of [
        AUDIOBOOK_SOURCE_STORE,
        AUDIOBOOK_TRANSCRIPT_STORE,
      ]) {
        deleteIndexedRecords(
          transaction.objectStore(storeName),
          AUDIOBOOK_PROFILE_INDEX,
          [documentId, audioId],
        );
      }
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async function saveNavigation(documentId, navigation) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(NAVIGATION_STORE, "readwrite");
      transaction.objectStore(NAVIGATION_STORE).put(
        {
          version: 1,
          bookmarks: Array.isArray(navigation?.bookmarks)
            ? navigation.bookmarks
            : [],
          history: Array.isArray(navigation?.history) ? navigation.history : [],
        },
        documentId,
      );
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  return {
    addDocument,
    addPdfDocumentPageOne,
    attachAudiobook,
    appendPdfDocumentPage,
    commitAudiobookTranscriptWindow,
    commitPreparedNarrationChunk,
    completePdfDocument,
    discardPdfDocument,
    findPreparedNarrationChunk,
    getAudiobookManifest,
    getAudiobookSource,
    getDocument,
    getNavigation,
    getPdfPage,
    getPdfPageBatch,
    getPdfPages,
    getPdfSource,
    getPreparedNarrationChunk,
    getPreparedNarrationManifest,
    listAudiobookManifests,
    listAudiobookTranscriptWindows,
    listPreparedNarrationChunkMetadata,
    listPreparedNarrationManifests,
    load,
    openDocument,
    openDocumentMetadata,
    removeDocument,
    removeAudiobook,
    removePreparedNarration,
    renameDocument,
    restoreLegacyPdfDocument,
    saveDocument,
    saveAudiobookManifest,
    saveNavigation,
    savePreparedNarrationChunk,
    savePreparedNarrationManifest,
  };
}

const browserLibrary = createReaderLibrary();

export const loadReaderLibrary = () => browserLibrary.load();
export const getReaderDocument = (documentId) =>
  browserLibrary.getDocument(documentId);
export const addReaderDocument = (document) =>
  browserLibrary.addDocument(document);
export const addReaderPdfPageOne = (document, source, page) =>
  browserLibrary.addPdfDocumentPageOne(document, source, page);
export const appendReaderPdfPage = (documentId, revision, page, progress) =>
  browserLibrary.appendPdfDocumentPage(documentId, revision, page, progress);
export const completeReaderPdfDocument = (documentId, revision, completion) =>
  browserLibrary.completePdfDocument(documentId, revision, completion);
export const discardReaderPdfDocument = (documentId, revision) =>
  browserLibrary.discardPdfDocument(documentId, revision);
export const restoreReaderLegacyPdfDocument = (documentId, revision) =>
  browserLibrary.restoreLegacyPdfDocument(documentId, revision);
export const getReaderPdfSource = (documentId) =>
  browserLibrary.getPdfSource(documentId);
export const getReaderPdfPages = (documentId) =>
  browserLibrary.getPdfPages(documentId);
export const getReaderPdfPage = (documentId, pageNumber) =>
  browserLibrary.getPdfPage(documentId, pageNumber);
export const getReaderPdfPageBatch = (documentId, startPage, count) =>
  browserLibrary.getPdfPageBatch(documentId, startPage, count);
export const getReaderPreparedNarrationChunk = (expected) =>
  browserLibrary.getPreparedNarrationChunk(expected);
export const getReaderPreparedNarrationManifest = (expected) =>
  browserLibrary.getPreparedNarrationManifest(expected);
export const listReaderPreparedNarrationManifests = (documentId) =>
  browserLibrary.listPreparedNarrationManifests(documentId);
export const listReaderPreparedNarrationChunkMetadata = (
  documentId,
  profileKey,
) => browserLibrary.listPreparedNarrationChunkMetadata(documentId, profileKey);
export const findReaderPreparedNarrationChunk = (
  documentId,
  profileKey,
  tokenIndex,
) => browserLibrary.findPreparedNarrationChunk(
  documentId,
  profileKey,
  tokenIndex,
);
export const openReaderDocument = (documentId) =>
  browserLibrary.openDocument(documentId);
export const openReaderDocumentMetadata = (documentId) =>
  browserLibrary.openDocumentMetadata(documentId);
export const renameReaderDocument = (documentId, title) =>
  browserLibrary.renameDocument(documentId, title);
export const removeReaderDocument = (documentId) =>
  browserLibrary.removeDocument(documentId);
export const removeReaderPreparedNarration = (documentId, profileKey) =>
  browserLibrary.removePreparedNarration(documentId, profileKey);
export const saveReaderDocument = (document) =>
  browserLibrary.saveDocument(document);
export const getReaderNavigation = (documentId) =>
  browserLibrary.getNavigation(documentId);
export const saveReaderNavigation = (documentId, navigation) =>
  browserLibrary.saveNavigation(documentId, navigation);
export const saveReaderPreparedNarrationChunk = (chunk) =>
  browserLibrary.savePreparedNarrationChunk(chunk);
export const saveReaderPreparedNarrationManifest = (manifest) =>
  browserLibrary.savePreparedNarrationManifest(manifest);
export const commitReaderPreparedNarrationChunk = (manifest, chunk) =>
  browserLibrary.commitPreparedNarrationChunk(manifest, chunk);
export const attachReaderAudiobook = (manifest, sources) =>
  browserLibrary.attachAudiobook(manifest, sources);
export const getReaderAudiobookManifest = (documentId, audioId) =>
  browserLibrary.getAudiobookManifest(documentId, audioId);
export const listReaderAudiobookManifests = (documentId) =>
  browserLibrary.listAudiobookManifests(documentId);
export const getReaderAudiobookSource = (documentId, audioId, partIndex) =>
  browserLibrary.getAudiobookSource(documentId, audioId, partIndex);
export const listReaderAudiobookTranscriptWindows = (documentId, audioId) =>
  browserLibrary.listAudiobookTranscriptWindows(documentId, audioId);
export const saveReaderAudiobookManifest = (manifest) =>
  browserLibrary.saveAudiobookManifest(manifest);
export const commitReaderAudiobookTranscriptWindow = (manifest, window) =>
  browserLibrary.commitAudiobookTranscriptWindow(manifest, window);
export const removeReaderAudiobook = (documentId, audioId) =>
  browserLibrary.removeAudiobook(documentId, audioId);
