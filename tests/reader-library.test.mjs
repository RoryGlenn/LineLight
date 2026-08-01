import assert from "node:assert/strict";
import test from "node:test";

import { IDBFactory } from "fake-indexeddb";

import {
  ACTIVE_DOCUMENT_ID_KEY,
  DOCUMENT_STORE,
  LEGACY_ACTIVE_DOCUMENT_KEY,
  STATE_STORE,
  calculateLibraryProgress,
  createReaderLibrary,
  filterLibraryEntries,
} from "../app/reader-library.mjs";

function document(id, title = `Book ${id}`) {
  return {
    id,
    title,
    author: "LineLight",
    kind: "txt",
    paragraphs: ["One short sentence.", "A second sentence follows."],
  };
}

function openDatabase(indexedDB, name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

test("migrates the legacy active document into the private library", async () => {
  const indexedDB = new IDBFactory();
  const databaseName = "legacy-library";
  const legacyDocument = document("legacy", "Saved before migration");
  const legacyDatabase = await openDatabase(
    indexedDB,
    databaseName,
    1,
    (database) => database.createObjectStore(DOCUMENT_STORE),
  );
  const legacyTransaction = legacyDatabase.transaction(
    DOCUMENT_STORE,
    "readwrite",
  );
  legacyTransaction
    .objectStore(DOCUMENT_STORE)
    .put(legacyDocument, LEGACY_ACTIVE_DOCUMENT_KEY);
  await transactionDone(legacyTransaction);
  legacyDatabase.close();

  const library = createReaderLibrary({
    indexedDB,
    databaseName,
    now: () => 1234,
  });
  const snapshot = await library.load();

  assert.equal(snapshot.activeDocumentId, "legacy");
  assert.deepEqual(snapshot.entries, [
    {
      id: "legacy",
      title: "Saved before migration",
      author: "LineLight",
      kind: "txt",
      wordCount: 7,
      createdAt: 1234,
      lastOpenedAt: 1234,
    },
  ]);
  assert.deepEqual(await library.getDocument("legacy"), legacyDocument);

  const migratedDatabase = await openDatabase(indexedDB, databaseName, 2);
  const readTransaction = migratedDatabase.transaction(
    [DOCUMENT_STORE, STATE_STORE],
    "readonly",
  );
  const legacyRequest = readTransaction
    .objectStore(DOCUMENT_STORE)
    .get(LEGACY_ACTIVE_DOCUMENT_KEY);
  const activeRequest = readTransaction
    .objectStore(STATE_STORE)
    .get(ACTIVE_DOCUMENT_ID_KEY);
  await transactionDone(readTransaction);
  assert.equal(legacyRequest.result, undefined);
  assert.equal(activeRequest.result, "legacy");
  migratedDatabase.close();
});

test("adds, opens, renames, and removes independent documents", async () => {
  const indexedDB = new IDBFactory();
  let timestamp = 100;
  const library = createReaderLibrary({
    indexedDB,
    databaseName: "document-lifecycle",
    now: () => {
      timestamp += 1;
      return timestamp;
    },
  });

  await library.addDocument(document("one", "First"));
  await library.addDocument(document("two", "Second"));
  let snapshot = await library.load();
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.id),
    ["two", "one"],
  );
  assert.equal(snapshot.activeDocumentId, "two");

  const opened = await library.openDocument("one");
  assert.equal(opened.document.id, "one");
  snapshot = await library.load();
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.id),
    ["one", "two"],
  );
  assert.equal(snapshot.activeDocumentId, "one");

  const renamed = await library.renameDocument("one", "Renamed");
  assert.equal(renamed.document.title, "Renamed");
  assert.equal((await library.getDocument("one")).title, "Renamed");

  await library.removeDocument("one");
  snapshot = await library.load();
  assert.deepEqual(snapshot.entries.map((entry) => entry.id), ["two"]);
  assert.equal(snapshot.activeDocumentId, null);
  assert.equal(await library.getDocument("one"), null);
});

test("filters lightweight library metadata and calculates saved progress", () => {
  const entries = [
    { title: "Ocean", author: "Ava", kind: "epub" },
    { title: "Mountain", author: "Rory", kind: "pdf" },
  ];

  assert.deepEqual(filterLibraryEntries(entries, "rory"), [entries[1]]);
  assert.deepEqual(filterLibraryEntries(entries, " EPUB "), [entries[0]]);
  assert.equal(calculateLibraryProgress(49, 100), 50);
  assert.equal(calculateLibraryProgress(0, 100, false), 0);
  assert.equal(calculateLibraryProgress(200, 100), 100);
});
