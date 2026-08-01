export const READER_DATABASE_NAME = "guided-reader-library";
export const READER_DATABASE_VERSION = 2;
export const DOCUMENT_STORE = "documents";
export const LIBRARY_STORE = "library";
export const STATE_STORE = "state";
export const LEGACY_ACTIVE_DOCUMENT_KEY = "active-document";
export const ACTIVE_DOCUMENT_ID_KEY = "active-document-id";

const WORD_PATTERN = /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;

/**
 * @param {{ paragraphs?: string[] }} document
 */
export function countDocumentWords(document) {
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
        [DOCUMENT_STORE, LIBRARY_STORE, STATE_STORE],
        "readwrite",
      );
      transaction.objectStore(DOCUMENT_STORE).delete(documentId);
      transaction.objectStore(LIBRARY_STORE).delete(documentId);
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

  return {
    addDocument,
    getDocument,
    load,
    openDocument,
    removeDocument,
    renameDocument,
  };
}

const browserLibrary = createReaderLibrary();

export const loadReaderLibrary = () => browserLibrary.load();
export const getReaderDocument = (documentId) =>
  browserLibrary.getDocument(documentId);
export const addReaderDocument = (document) =>
  browserLibrary.addDocument(document);
export const openReaderDocument = (documentId) =>
  browserLibrary.openDocument(documentId);
export const renameReaderDocument = (documentId, title) =>
  browserLibrary.renameDocument(documentId, title);
export const removeReaderDocument = (documentId) =>
  browserLibrary.removeDocument(documentId);
