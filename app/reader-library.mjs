export const READER_DATABASE_NAME = "guided-reader-library";
export const READER_DATABASE_VERSION = 4;
export const DOCUMENT_STORE = "documents";
export const LIBRARY_STORE = "library";
export const STATE_STORE = "state";
export const NAVIGATION_STORE = "navigation";
export const PDF_SOURCE_STORE = "pdf-sources";
export const PDF_PAGE_STORE = "pdf-pages";
export const PDF_PAGE_DOCUMENT_INDEX = "documentId";
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

export function createReaderLibrary({
  indexedDB: databaseFactory = globalThis.indexedDB,
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
    appendPdfDocumentPage,
    completePdfDocument,
    discardPdfDocument,
    getDocument,
    getNavigation,
    getPdfPage,
    getPdfPageBatch,
    getPdfPages,
    getPdfSource,
    load,
    openDocument,
    openDocumentMetadata,
    removeDocument,
    renameDocument,
    restoreLegacyPdfDocument,
    saveDocument,
    saveNavigation,
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
export const openReaderDocument = (documentId) =>
  browserLibrary.openDocument(documentId);
export const openReaderDocumentMetadata = (documentId) =>
  browserLibrary.openDocumentMetadata(documentId);
export const renameReaderDocument = (documentId, title) =>
  browserLibrary.renameDocument(documentId, title);
export const removeReaderDocument = (documentId) =>
  browserLibrary.removeDocument(documentId);
export const saveReaderDocument = (document) =>
  browserLibrary.saveDocument(document);
export const getReaderNavigation = (documentId) =>
  browserLibrary.getNavigation(documentId);
export const saveReaderNavigation = (documentId, navigation) =>
  browserLibrary.saveNavigation(documentId, navigation);
