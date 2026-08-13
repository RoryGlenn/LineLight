import assert from "node:assert/strict";
import test from "node:test";

import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import {
  ACTIVE_DOCUMENT_ID_KEY,
  DOCUMENT_STORE,
  LEGACY_ACTIVE_DOCUMENT_KEY,
  LIBRARY_STORE,
  NAVIGATION_STORE,
  PDF_PAGE_DOCUMENT_INDEX,
  PDF_PAGE_STORE,
  PDF_SOURCE_STORE,
  PREPARED_NARRATION_MANIFEST_STORE,
  PREPARED_NARRATION_METADATA_STORE,
  PREPARED_NARRATION_DOCUMENT_INDEX,
  PREPARED_NARRATION_RECENT_INDEX,
  PREPARED_NARRATION_STORE,
  AUDIOBOOK_DOCUMENT_INDEX,
  AUDIOBOOK_MANIFEST_STORE,
  AUDIOBOOK_PROFILE_INDEX,
  AUDIOBOOK_SOURCE_STORE,
  AUDIOBOOK_TRANSCRIPT_STORE,
  READER_DATABASE_VERSION,
  STATE_STORE,
  calculateLibraryProgress,
  createReaderLibrary,
  filterLibraryEntries,
} from "../app/reader-library.mjs";
import {
  PREPARED_NARRATION_AUDIO_MIME_TYPE,
  PREPARED_NARRATION_BOOK_RETENTION,
  PREPARED_NARRATION_IDENTITY_ENCODING,
  PREPARED_NARRATION_RECENT_MAX_ENTRIES,
  PREPARED_NARRATION_RECENT_RETENTION,
  PREPARED_NARRATION_SCHEMA_VERSION,
  createPreparedNarrationManifest,
  createPreparedNarrationProfileKey,
} from "../app/prepared-narration.mjs";
import {
  AUDIOBOOK_ALIGNMENT_MODEL_REVISION,
  AUDIOBOOK_ALIGNMENT_SCHEMA_VERSION,
  createAudiobookManifest,
} from "../app/audiobook-alignment.mjs";

function document(id, title = `Book ${id}`) {
  return {
    id,
    title,
    author: "LineLight",
    kind: "txt",
    paragraphs: ["One short sentence.", "A second sentence follows."],
  };
}

function preparedNarrationChunk(documentId, overrides = {}) {
  const chunk = {
    schemaVersion: PREPARED_NARRATION_SCHEMA_VERSION,
    documentId,
    profileKey: createPreparedNarrationProfileKey({
      modelRevision: "revision-one",
      modelDtype: "fp16",
      voice: "af_heart",
      rate: 1,
    }),
    startIndex: 0,
    nextIndex: 4,
    textFingerprint: "a".repeat(64),
    audioData: new ArrayBuffer(64),
    audioByteLength: 64,
    audioEncoding: PREPARED_NARRATION_IDENTITY_ENCODING,
    sourceAudioByteLength: 64,
    mimeType: PREPARED_NARRATION_AUDIO_MIME_TYPE,
    audioDurationSeconds: 1.5,
    boundaries: [
      {
        audioOffsetSeconds: 0.05,
        durationSeconds: 0.3,
        text: "One",
        textOffset: 0,
        wordLength: 3,
        tokenIndex: 0,
      },
    ],
    device: "wasm",
    modelDtype: "fp16",
    synthesisMilliseconds: 400,
    wasmThreads: 4,
    retention: PREPARED_NARRATION_RECENT_RETENTION,
    createdAt: 100,
    ...overrides,
  };
  if (!overrides.boundaries) {
    chunk.boundaries = chunk.boundaries.map((boundary) => ({
      ...boundary,
      tokenIndex: chunk.startIndex,
    }));
  }
  return chunk;
}

function preparedNarrationManifest(documentId, overrides = {}) {
  const profileKey = overrides.profileKey ?? createPreparedNarrationProfileKey({
    modelRevision: "revision-one",
    modelDtype: "fp16",
    voice: "af_heart",
    rate: 1,
  });
  return createPreparedNarrationManifest({
    documentId,
    documentFingerprint: "d".repeat(64),
    profileKey,
    modelRevision: "revision-one",
    modelDtype: "fp16",
    voice: "af_heart",
    rate: 1,
    totalTokens: 7,
    now: 100,
    ...overrides,
  });
}

function audiobookManifest(documentId, audioId = "audio-one") {
  return createAudiobookManifest({
    documentId,
    documentFingerprint: "e".repeat(64),
    title: `Book ${documentId}`,
    author: "LineLight",
    totalTokens: 7,
    audioId,
    files: [
      {
        name: "Chapter 1.mp3",
        type: "audio/mpeg",
        size: 11,
        durationSeconds: 24,
      },
    ],
    now: 200,
  });
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

  const migratedDatabase = await openDatabase(
    indexedDB,
    databaseName,
    READER_DATABASE_VERSION,
  );
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

  const outlinedDocument = {
    ...document("one", "First"),
    outline: [
      {
        id: "chapter-one",
        title: "Chapter one",
        pageNumber: 2,
        tokenIndex: 3,
        items: [],
      },
    ],
  };
  await library.addDocument(outlinedDocument);
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
  assert.deepEqual(
    (await library.getDocument("one")).outline,
    outlinedDocument.outline,
  );
  await library.saveDocument({
    ...outlinedDocument,
    paragraphs: ["A shorter migrated PDF model"],
    outline: [
      ...outlinedDocument.outline,
      {
        id: "chapter-two",
        title: "Chapter two",
        pageNumber: 4,
        tokenIndex: 6,
        items: [],
      },
    ],
  });
  assert.equal((await library.getDocument("one")).outline.length, 2);
  assert.equal(
    (await library.load()).entries.find((entry) => entry.id === "one")
      .wordCount,
    5,
  );

  const renamed = await library.renameDocument("one", "Renamed");
  assert.equal(renamed.document.title, "Renamed");
  assert.equal((await library.getDocument("one")).title, "Renamed");

  const navigation = {
    version: 1,
    bookmarks: [{ id: "bookmark-one", name: "Return here", tokenIndex: 3 }],
    history: [{ tokenIndex: 0 }],
  };
  await library.saveNavigation("one", navigation);
  assert.deepEqual(await library.getNavigation("one"), navigation);

  await library.removeDocument("one");
  snapshot = await library.load();
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.id),
    ["two"],
  );
  assert.equal(snapshot.activeDocumentId, null);
  assert.equal(await library.getDocument("one"), null);
  assert.deepEqual(await library.getNavigation("one"), {
    version: 1,
    bookmarks: [],
    history: [],
  });
});

test("persists exact prepared narration and cleans it up with its book", async () => {
  const indexedDB = new IDBFactory();
  const library = createReaderLibrary({
    indexedDB,
    keyRange: IDBKeyRange,
    databaseName: "prepared-narration-lifecycle",
  });
  const firstChunk = preparedNarrationChunk("one");
  const secondChunk = preparedNarrationChunk("two", {
    textFingerprint: "b".repeat(64),
  });

  assert.equal(await library.savePreparedNarrationChunk(firstChunk), false);
  await library.addDocument(document("one"));
  await library.addDocument(document("two"));
  assert.equal(await library.savePreparedNarrationChunk(firstChunk), true);
  assert.equal(await library.savePreparedNarrationChunk(secondChunk), true);

  const expected = {
    documentId: firstChunk.documentId,
    profileKey: firstChunk.profileKey,
    startIndex: firstChunk.startIndex,
    nextIndex: firstChunk.nextIndex,
    textFingerprint: firstChunk.textFingerprint,
  };
  const restored = await library.getPreparedNarrationChunk(expected);
  assert.equal(restored.audioData.byteLength, firstChunk.audioData.byteLength);
  assert.deepEqual(restored.boundaries, firstChunk.boundaries);
  assert.equal(
    await library.getPreparedNarrationChunk({
      ...expected,
      textFingerprint: "c".repeat(64),
    }),
    null,
  );

  await library.removeDocument("one");
  assert.equal(await library.getPreparedNarrationChunk(expected), null);
  assert.notEqual(
    await library.getPreparedNarrationChunk({
      documentId: secondChunk.documentId,
      profileKey: secondChunk.profileKey,
      startIndex: secondChunk.startIndex,
      nextIndex: secondChunk.nextIndex,
      textFingerprint: secondChunk.textFingerprint,
    }),
    null,
  );

  await library.removePreparedNarration("two");
  assert.equal(
    await library.getPreparedNarrationChunk({
      documentId: secondChunk.documentId,
      profileKey: secondChunk.profileKey,
      startIndex: secondChunk.startIndex,
      nextIndex: secondChunk.nextIndex,
      textFingerprint: secondChunk.textFingerprint,
    }),
    null,
  );
  assert.notEqual(await library.getDocument("two"), null);
});

test("atomically resumes prepared narration and removes one exact profile", async () => {
  const indexedDB = new IDBFactory();
  let timestamp = 300;
  const library = createReaderLibrary({
    indexedDB,
    keyRange: IDBKeyRange,
    databaseName: "prepared-narration-manifest-lifecycle",
    now: () => ++timestamp,
  });
  await library.addDocument(document("one"));
  const manifest = preparedNarrationManifest("one");
  assert.equal(await library.savePreparedNarrationManifest(manifest), true);

  const firstChunk = preparedNarrationChunk("one", {
    nextIndex: 4,
    retention: PREPARED_NARRATION_BOOK_RETENTION,
  });
  let progress = await library.commitPreparedNarrationChunk(
    manifest,
    firstChunk,
  );
  assert.equal(progress.status, "preparing");
  assert.equal(progress.nextIndex, 4);
  assert.equal(progress.completedChunks, 1);

  const restoredProgress = await library.getPreparedNarrationManifest({
    documentId: manifest.documentId,
    documentFingerprint: manifest.documentFingerprint,
    profileKey: manifest.profileKey,
    totalTokens: manifest.totalTokens,
  });
  assert.equal(restoredProgress.nextIndex, 4);
  assert.deepEqual(
    (await library.listPreparedNarrationChunkMetadata("one", manifest.profileKey))
      .map((chunk) => [chunk.startIndex, chunk.nextIndex]),
    [[0, 4]],
  );
  assert.equal(
    (await library.findPreparedNarrationChunk("one", manifest.profileKey, 2))
      .startIndex,
    0,
  );

  const secondChunk = preparedNarrationChunk("one", {
    profileKey: manifest.profileKey,
    startIndex: 4,
    nextIndex: 7,
    retention: PREPARED_NARRATION_BOOK_RETENTION,
  });
  progress = await library.commitPreparedNarrationChunk(
    restoredProgress,
    secondChunk,
  );
  assert.equal(progress.status, "ready");
  assert.equal(progress.nextIndex, 7);

  const otherProfile = preparedNarrationManifest("one", {
    profileKey: createPreparedNarrationProfileKey({
      modelRevision: "revision-one",
      modelDtype: "fp16",
      voice: "af_bella",
      rate: 1,
    }),
    voice: "af_bella",
  });
  assert.equal(await library.savePreparedNarrationManifest(otherProfile), true);
  assert.equal((await library.listPreparedNarrationManifests("one")).length, 2);

  await library.removePreparedNarration("one", manifest.profileKey);
  assert.equal(
    await library.getPreparedNarrationManifest({
      documentId: "one",
      profileKey: manifest.profileKey,
    }),
    null,
  );
  assert.equal(
    (await library.listPreparedNarrationManifests("one"))[0].profileKey,
    otherProfile.profileKey,
  );
});

test("stores resumable audiobook alignment and cleans only the selected book", async () => {
  const indexedDB = new IDBFactory();
  const library = createReaderLibrary({
    indexedDB,
    keyRange: IDBKeyRange,
    databaseName: "audiobook-alignment-lifecycle",
  });
  const one = audiobookManifest("one", "narrator-one");
  const two = audiobookManifest("two", "narrator-two");
  const source = new Blob(["hello audio"], { type: "audio/mpeg" });

  assert.equal(await library.attachAudiobook(one, [source]), false);
  await library.addDocument(document("one"));
  await library.addDocument(document("two"));
  assert.equal(await library.attachAudiobook(one, [source]), true);
  assert.equal(await library.attachAudiobook(two, [source]), true);
  assert.equal(await library.attachAudiobook(one, [source]), true);
  assert.equal(
    (await library.getAudiobookSource("one", one.audioId, 0)).blob.size,
    source.size,
  );

  const transcriptWindow = {
    schemaVersion: AUDIOBOOK_ALIGNMENT_SCHEMA_VERSION,
    documentId: "one",
    audioId: one.audioId,
    partIndex: 0,
    windowIndex: 0,
    startSeconds: 0,
    endSeconds: 24,
    text: "One short sentence",
    segments: [
      {
        startSeconds: 0.4,
        endSeconds: 2.2,
        text: "One short sentence",
      },
    ],
    modelRevision: AUDIOBOOK_ALIGNMENT_MODEL_REVISION,
    createdAt: 250,
  };
  const aligning = {
    ...one,
    status: "aligning",
    nextWindowIndex: 1,
    processedWindows: 1,
    updatedAt: 251,
  };
  assert.equal(
    await library.commitAudiobookTranscriptWindow(aligning, transcriptWindow),
    true,
  );
  assert.equal(
    (await library.listAudiobookTranscriptWindows("one", one.audioId)).length,
    1,
  );

  const corrected = {
    ...aligning,
    anchors: [
      {
        id: "manual-one",
        partIndex: 0,
        timeSeconds: 1.25,
        tokenIndex: 0,
        confidence: 1,
        source: "manual",
        granularity: "sentence",
      },
    ],
    status: "paused",
    updatedAt: 252,
  };
  assert.equal(await library.saveAudiobookManifest(corrected), true);
  assert.equal(
    (await library.getAudiobookManifest("one", one.audioId)).anchors[0].source,
    "manual",
  );

  await library.removeAudiobook("one", one.audioId);
  assert.equal(await library.getAudiobookManifest("one", one.audioId), null);
  assert.equal(await library.getAudiobookSource("one", one.audioId, 0), null);
  assert.notEqual(await library.getAudiobookManifest("two", two.audioId), null);

  await library.removeDocument("two");
  assert.equal(await library.getAudiobookManifest("two", two.audioId), null);
  assert.equal(await library.getAudiobookSource("two", two.audioId, 0), null);
});

test("bounds incidental narration without pruning an explicitly prepared book", async () => {
  const indexedDB = new IDBFactory();
  const library = createReaderLibrary({
    indexedDB,
    keyRange: IDBKeyRange,
    databaseName: "bounded-prepared-narration",
  });
  await library.addDocument(document("one"));

  const preparedChunk = preparedNarrationChunk("one", {
    profileKey: createPreparedNarrationProfileKey({
      modelRevision: "revision-one",
      modelDtype: "fp16",
      voice: "af_bella",
      rate: 1,
    }),
    retention: PREPARED_NARRATION_BOOK_RETENTION,
  });
  await library.savePreparedNarrationChunk(preparedChunk);

  for (let index = 0; index <= PREPARED_NARRATION_RECENT_MAX_ENTRIES; index += 1) {
    await library.savePreparedNarrationChunk(
      preparedNarrationChunk("one", {
        startIndex: index,
        nextIndex: index + 1,
        createdAt: 1_000 + index,
      }),
    );
  }

  const expected = (chunk) => ({
    documentId: chunk.documentId,
    profileKey: chunk.profileKey,
    startIndex: chunk.startIndex,
    nextIndex: chunk.nextIndex,
    textFingerprint: chunk.textFingerprint,
  });
  assert.equal(
    await library.getPreparedNarrationChunk(
      expected(preparedNarrationChunk("one", { nextIndex: 1 })),
    ),
    null,
  );
  assert.notEqual(
    await library.getPreparedNarrationChunk(
      expected(
        preparedNarrationChunk("one", {
          startIndex: PREPARED_NARRATION_RECENT_MAX_ENTRIES,
          nextIndex: PREPARED_NARRATION_RECENT_MAX_ENTRIES + 1,
        }),
      ),
    ),
    null,
  );
  assert.notEqual(
    await library.getPreparedNarrationChunk(expected(preparedChunk)),
    null,
  );
});

test("upgrades v3 libraries with paged PDF stores without cloning legacy documents", async () => {
  const indexedDB = new IDBFactory();
  const databaseName = "pdf-v4-upgrade";
  const legacyPdf = {
    id: "legacy-pdf",
    title: "Legacy PDF",
    author: "10 page PDF",
    kind: "pdf",
    paragraphs: ["Legacy extracted text"],
    pdfData: new Uint8Array([37, 80, 68, 70]),
  };
  const legacyWithoutSource = {
    ...legacyPdf,
    id: "legacy-pdf-without-source",
    title: "Legacy PDF without source",
    paragraphs: ["Readable Focus text survives without original bytes."],
    pdfData: undefined,
  };
  const legacyWithCorruptSource = {
    ...legacyPdf,
    id: "legacy-pdf-corrupt-source",
    title: "Legacy PDF with corrupt source",
    paragraphs: ["Readable Focus text survives corrupt original bytes."],
    pdfData: new Uint8Array([0, 1, 2, 3]),
  };
  const legacyDatabase = await openDatabase(
    indexedDB,
    databaseName,
    3,
    (database) => {
      database.createObjectStore(DOCUMENT_STORE);
      database.createObjectStore(LIBRARY_STORE, { keyPath: "id" });
      database.createObjectStore(STATE_STORE);
      database.createObjectStore(NAVIGATION_STORE);
    },
  );
  const write = legacyDatabase.transaction(
    [DOCUMENT_STORE, LIBRARY_STORE, STATE_STORE],
    "readwrite",
  );
  write.objectStore(DOCUMENT_STORE).put(legacyPdf, legacyPdf.id);
  for (const document of [legacyPdf, legacyWithoutSource, legacyWithCorruptSource]) {
    write.objectStore(DOCUMENT_STORE).put(document, document.id);
    write.objectStore(LIBRARY_STORE).put({
      id: document.id,
      title: document.title,
      author: document.author,
      kind: document.kind,
      wordCount: 3,
      createdAt: 1,
      lastOpenedAt: 1,
    });
  }
  write.objectStore(STATE_STORE).put(legacyPdf.id, ACTIVE_DOCUMENT_ID_KEY);
  await transactionDone(write);
  legacyDatabase.close();

  const library = createReaderLibrary({ indexedDB, databaseName });
  await library.load();
  assert.deepEqual(await library.getDocument(legacyPdf.id), legacyPdf);
  assert.deepEqual(
    await library.getDocument(legacyWithoutSource.id),
    legacyWithoutSource,
  );
  assert.deepEqual(
    await library.getDocument(legacyWithCorruptSource.id),
    legacyWithCorruptSource,
  );

  const upgraded = await openDatabase(
    indexedDB,
    databaseName,
    READER_DATABASE_VERSION,
  );
  assert.equal(upgraded.objectStoreNames.contains(PDF_SOURCE_STORE), true);
  assert.equal(upgraded.objectStoreNames.contains(PDF_PAGE_STORE), true);
  assert.equal(
    upgraded.objectStoreNames.contains(PREPARED_NARRATION_STORE),
    true,
  );
  for (const storeName of [
    PREPARED_NARRATION_METADATA_STORE,
    PREPARED_NARRATION_MANIFEST_STORE,
    AUDIOBOOK_MANIFEST_STORE,
    AUDIOBOOK_SOURCE_STORE,
    AUDIOBOOK_TRANSCRIPT_STORE,
  ]) {
    assert.equal(upgraded.objectStoreNames.contains(storeName), true);
  }
  const read = upgraded.transaction(PDF_PAGE_STORE, "readonly");
  assert.equal(
    read
      .objectStore(PDF_PAGE_STORE)
      .indexNames.contains(PDF_PAGE_DOCUMENT_INDEX),
    true,
  );
  await transactionDone(read);
  const preparedRead = upgraded.transaction(
    PREPARED_NARRATION_STORE,
    "readonly",
  );
  assert.equal(
    preparedRead
      .objectStore(PREPARED_NARRATION_STORE)
      .indexNames.contains(PREPARED_NARRATION_DOCUMENT_INDEX),
    true,
  );
  assert.equal(
    preparedRead
      .objectStore(PREPARED_NARRATION_STORE)
      .indexNames.contains(PREPARED_NARRATION_RECENT_INDEX),
    true,
  );
  await transactionDone(preparedRead);
  const preparedManifestRead = upgraded.transaction(
    PREPARED_NARRATION_MANIFEST_STORE,
    "readonly",
  );
  assert.equal(
    preparedManifestRead
      .objectStore(PREPARED_NARRATION_MANIFEST_STORE)
      .indexNames.contains(PREPARED_NARRATION_DOCUMENT_INDEX),
    true,
  );
  await transactionDone(preparedManifestRead);
  const audiobookRead = upgraded.transaction(
    [AUDIOBOOK_MANIFEST_STORE, AUDIOBOOK_SOURCE_STORE],
    "readonly",
  );
  assert.equal(
    audiobookRead
      .objectStore(AUDIOBOOK_MANIFEST_STORE)
      .indexNames.contains(AUDIOBOOK_DOCUMENT_INDEX),
    true,
  );
  assert.equal(
    audiobookRead
      .objectStore(AUDIOBOOK_SOURCE_STORE)
      .indexNames.contains(AUDIOBOOK_PROFILE_INDEX),
    true,
  );
  await transactionDone(audiobookRead);
  upgraded.close();
});

test("persists a resumable PDF page-by-page and enforces its revision", async () => {
  const indexedDB = new IDBFactory();
  let timestamp = 900;
  const library = createReaderLibrary({
    indexedDB,
    databaseName: "paged-pdf-lifecycle",
    now: () => ++timestamp,
  });
  const source = new Blob(["%PDF-test-source"], { type: "application/pdf" });
  const manifest = {
    id: "large-pdf",
    title: "Large PDF",
    author: "359 page PDF",
    kind: "pdf",
    paragraphs: [],
    pdfCompletedPages: 1,
    pdfImportStatus: "importing",
    pdfPageCount: 359,
    pdfRevision: "revision-a",
    pdfStorageVersion: 1,
    pdfTextModelVersion: 2,
    wordCount: 24,
  };
  const page = (pageNumber, revision = manifest.pdfRevision) => ({
    documentId: manifest.id,
    revision,
    pageNumber,
    layout: {
      pageNumber,
      width: 612,
      height: 792,
      items: [],
    },
    model: {
      wordStart: pageNumber === 1 ? 0 : 24,
      tokens: [],
      renderedParagraphs: [],
    },
    textContent: { items: [], styles: {} },
  });

  const entry = await library.addPdfDocumentPageOne(
    manifest,
    source,
    page(1),
  );
  assert.equal(entry.wordCount, 24);
  assert.equal((await library.getPdfSource(manifest.id)).size, source.size);
  assert.deepEqual(
    (await library.getPdfPages(manifest.id)).map((stored) => stored.pageNumber),
    [1],
  );
  assert.equal((await library.getDocument(manifest.id)).pdfImportStatus, "importing");

  await assert.rejects(
    library.appendPdfDocumentPage(
      manifest.id,
      "stale-revision",
      page(2, "stale-revision"),
      { completedPages: 2, wordCount: 50 },
    ),
  );
  assert.deepEqual(
    (await library.getPdfPages(manifest.id)).map((stored) => stored.pageNumber),
    [1],
  );

  await library.appendPdfDocumentPage(
    manifest.id,
    manifest.pdfRevision,
    page(2),
    { completedPages: 2, wordCount: 50 },
  );
  let stored = await library.getDocument(manifest.id);
  assert.equal(stored.pdfCompletedPages, 2);
  assert.equal(stored.wordCount, 50);
  assert.equal((await library.getPdfPage(manifest.id, 1)).pageNumber, 1);
  assert.deepEqual(
    (await library.getPdfPageBatch(manifest.id, 1, 2)).map(
      (storedPage) => storedPage.pageNumber,
    ),
    [1, 2],
  );

  // A cancelled import deliberately remains a resumable `importing` entry.
  // Restarting it replaces every staging page so a shorter replacement cannot
  // retain stale records from the abandoned revision.
  const resumedManifest = {
    ...manifest,
    pdfPageCount: 1,
    pdfRevision: "revision-b",
  };
  await library.addPdfDocumentPageOne(
    resumedManifest,
    new Blob(["%PDF-resumed"], { type: "application/pdf" }),
    page(1, resumedManifest.pdfRevision),
  );
  assert.deepEqual(
    (await library.getPdfPages(manifest.id)).map((storedPage) => [
      storedPage.pageNumber,
      storedPage.revision,
    ]),
    [[1, "revision-b"]],
  );

  stored = await library.completePdfDocument(
    manifest.id,
    resumedManifest.pdfRevision,
    { outline: [], wordCount: 24 },
  );
  assert.equal(stored.pdfImportStatus, "ready");
  assert.equal(stored.pdfCompletedPages, 1);
  assert.equal(
    (await library.load()).entries.find((item) => item.id === manifest.id)
      .wordCount,
    24,
  );

  const openedEntry = await library.openDocumentMetadata(manifest.id);
  assert.equal(openedEntry.id, manifest.id);
  assert.equal((await library.load()).activeDocumentId, manifest.id);

  await library.removeDocument(manifest.id);
  assert.equal(await library.getDocument(manifest.id), null);
  assert.equal(await library.getPdfSource(manifest.id), null);
  assert.deepEqual(await library.getPdfPages(manifest.id), []);
});

test("preserves legacy PDF recovery until migration commits and cleans terminal staging", async () => {
  const indexedDB = new IDBFactory();
  const library = createReaderLibrary({
    indexedDB,
    databaseName: "pdf-migration-recovery",
    now: () => 77,
  });
  const legacy = {
    id: "legacy-recovery",
    title: "Readable legacy PDF",
    author: "PDF",
    kind: "pdf",
    paragraphs: ["The existing readable text remains recoverable."],
    pdfData: new Uint8Array([37, 80, 68, 70]),
  };
  await library.addDocument(legacy);
  const staged = {
    id: legacy.id,
    title: legacy.title,
    author: legacy.author,
    kind: "pdf",
    paragraphs: [],
    pdfCompletedPages: 1,
    pdfImportStatus: "importing",
    pdfPageCount: 2,
    pdfRevision: "migration-a",
    pdfStorageVersion: 1,
    pdfTextModelVersion: 2,
    wordCount: 4,
    pdfLegacyRecovery: legacy,
  };
  const page = {
    documentId: legacy.id,
    revision: staged.pdfRevision,
    pageNumber: 1,
    layout: { pageNumber: 1, width: 600, height: 800, items: [] },
    model: { wordStart: 0, tokens: [], renderedParagraphs: [] },
    textContent: { items: [], styles: {} },
  };
  await library.addPdfDocumentPageOne(
    staged,
    new Blob(["%PDF-staged"], { type: "application/pdf" }),
    page,
  );
  assert.deepEqual(
    (await library.getDocument(legacy.id)).pdfLegacyRecovery,
    legacy,
  );
  assert.equal(
    await library.restoreLegacyPdfDocument(legacy.id, staged.pdfRevision),
    true,
  );
  assert.deepEqual(await library.getDocument(legacy.id), legacy);
  assert.equal(await library.getPdfSource(legacy.id), null);
  assert.deepEqual(await library.getPdfPages(legacy.id), []);

  await library.addPdfDocumentPageOne(
    staged,
    new Blob(["%PDF-staged-again"], { type: "application/pdf" }),
    page,
  );
  await assert.rejects(
    library.discardPdfDocument(legacy.id, "stale-migration"),
  );
  assert.ok(await library.getDocument(legacy.id));
  assert.equal(
    await library.discardPdfDocument(legacy.id, staged.pdfRevision),
    true,
  );
  assert.equal(await library.getDocument(legacy.id), null);
  assert.equal(await library.getPdfSource(legacy.id), null);
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
