import assert from "node:assert/strict";
import test from "node:test";

import { buildDocumentModel } from "../app/document-model.mjs";
import {
  appendPdfDocumentChunk,
  buildPdfDocumentChunk,
  coalescePdfRenderRequests,
  createPdfModelCursor,
  createProgressiveDocumentModel,
  pdfRenderRequestKey,
  prioritizePdfRenderRequests,
} from "../app/pdf-document-model.mjs";
import {
  canStartPdfInitialRaster,
  canStartPdfPage,
  discardStalePdfMessage,
  isCurrentPdfSession,
  isPdfCancellationForSession,
  resolvePdfTerminalOutcome,
  waitForPdfDocumentReady,
  waitForPdfParserWorkerReady,
} from "../app/pdf-document-protocol.mjs";
import { createPdfRasterScheduler } from "../app/pdf-raster-scheduler.mjs";

test("assembles page chunks into the shared semantic reader model", () => {
  const pageParagraphs = [
    ["First sentence. The first page continues."],
    ["Second page opens.", "Its second paragraph stays separate."],
    ["The final page closes the example."],
  ];
  let cursor = createPdfModelCursor();
  const progressive = createProgressiveDocumentModel();

  for (const paragraphs of pageParagraphs) {
    const chunk = buildPdfDocumentChunk(paragraphs, cursor);
    assert.equal(chunk.wordStart, progressive.tokens.length);
    appendPdfDocumentChunk(progressive, chunk);
    cursor = chunk.nextCursor;
  }

  const complete = buildDocumentModel(pageParagraphs.flat(), {
    paragraphsStartSentences: true,
  });
  assert.equal(progressive.fullText, complete.fullText);
  assert.deepEqual(progressive.tokens, complete.tokens);
  assert.deepEqual(progressive.paragraphs, complete.paragraphs);
  assert.deepEqual(
    progressive.paragraphCharacterCounts,
    pageParagraphs.flat().map((paragraph) => paragraph.length),
  );
  assert.deepEqual(
    progressive.tokenSentences,
    complete.tokens.map((token) => token.sentenceIndex),
  );
  assert.deepEqual(
    progressive.tokenParagraphs,
    complete.tokens.map((token) => token.paragraphIndex),
  );
  assert.deepEqual(progressive.sentenceStarts, [0, 2, 6, 9, 14]);
});

test("prioritizes visible raster work and gives every request a revision key", () => {
  const requests = [
    { pageNumber: 40, sequence: 0, distance: 12 },
    { pageNumber: 3, sequence: 1, visible: true, distance: 0 },
    { pageNumber: 2, sequence: 2, visible: true, distance: 1 },
    { pageNumber: 4, sequence: 3, distance: 2 },
  ];
  assert.deepEqual(
    prioritizePdfRenderRequests(requests).map((request) => request.pageNumber),
    [3, 2, 4, 40],
  );
  assert.notEqual(
    pdfRenderRequestKey({
      documentId: "book",
      revision: "old",
      pageNumber: 1,
      scale: 1.5,
    }),
    pdfRenderRequestKey({
      documentId: "book",
      revision: "new",
      pageNumber: 1,
      scale: 1.5,
    }),
  );
});

test("coalesces a page to its newest scale without losing visibility priority", () => {
  const queued = coalescePdfRenderRequests(
    [
      {
        pageNumber: 4,
        scale: 1.25,
        sequence: 1,
        visible: true,
        distance: 0,
      },
      { pageNumber: 9, scale: 1.25, sequence: 2, distance: 5 },
    ],
    {
      pageNumber: 4,
      scale: 2,
      sequence: 3,
      visible: false,
      distance: 8,
    },
  );
  assert.deepEqual(
    queued.find((request) => request.pageNumber === 4),
    {
      pageNumber: 4,
      scale: 2,
      sequence: 3,
      visible: true,
      distance: 0,
    },
  );
  assert.equal(queued.filter((request) => request.pageNumber === 4).length, 1);
});

test("shares the in-flight page-one raster and serializes a newer scale", async () => {
  const releases = [];
  const starts = [];
  const scheduler = createPdfRasterScheduler(
    (pageNumber, scale) =>
      new Promise((resolve) => {
        starts.push(`${pageNumber}:${scale}`);
        releases.push(resolve);
      }),
  );
  const first = scheduler.run(1, 1.5);
  const duplicate = scheduler.run(1, 1.5);
  const higherScale = scheduler.run(1, 2);
  await Promise.resolve();
  assert.deepEqual(starts, ["1:1.5"]);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ["1:1.5", "1:2"]);
  releases.shift()();
  await Promise.all([first, duplicate, higherScale]);
  assert.equal(scheduler.getInFlightKey(), null);
});

test("gates background pages until durable page one and its raster settle", () => {
  const milestones = {
    pageOnePersisted: false,
    pageOnePosted: false,
    pageOneRasterSettled: false,
  };
  assert.equal(canStartPdfInitialRaster(milestones), false);
  assert.equal(canStartPdfPage(1, milestones), true);
  assert.equal(canStartPdfPage(2, milestones), false);
  milestones.pageOnePersisted = true;
  assert.equal(canStartPdfInitialRaster(milestones), false);
  assert.equal(canStartPdfPage(2, milestones), false);
  milestones.pageOnePosted = true;
  assert.equal(canStartPdfInitialRaster(milestones), true);
  assert.equal(canStartPdfPage(2, milestones), false);
  milestones.pageOneRasterSettled = true;
  assert.equal(canStartPdfPage(2, milestones), true);
});

test("rejects stale results and cancellation without leaking image bitmaps", () => {
  const active = { jobId: 8, revision: "current" };
  assert.equal(
    isCurrentPdfSession(active, { jobId: 8, revision: "current" }),
    true,
  );
  assert.equal(
    isCurrentPdfSession(active, { jobId: 7, revision: "current" }),
    false,
  );
  assert.equal(
    isPdfCancellationForSession(active, {
      type: "cancel",
      jobId: 8,
      revision: "stale",
    }),
    false,
  );
  assert.equal(
    isPdfCancellationForSession(active, {
      type: "cancel",
      jobId: 8,
      revision: "current",
    }),
    true,
  );

  let closed = 0;
  discardStalePdfMessage({
    type: "bitmap",
    bitmap: { close: () => closed++ },
  });
  discardStalePdfMessage({ type: "page" });
  assert.equal(closed, 1);
});

test("waits for a stored PDF parser instead of reporting render fallback early", async () => {
  let release;
  const context = {
    document: null,
    documentReady: new Promise((resolve) => {
      release = () => {
        context.document = { numPages: 359 };
        resolve(context.document);
      };
    }),
  };
  let settled = false;
  const waiting = waitForPdfDocumentReady(context).then((document) => {
    settled = true;
    return document;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  assert.deepEqual(await waiting, { numPages: 359 });
});

test("waits for the nested PDF.js protocol before supplying its worker port", async () => {
  const port = new EventTarget();
  const ready = waitForPdfParserWorkerReady(port, { timeoutMs: 100 });
  port.dispatchEvent(
    new MessageEvent("message", {
      data: {
        sourceName: "worker",
        targetName: "main",
        action: "ready",
      },
    }),
  );
  await ready;

  const failedPort = new EventTarget();
  const failed = waitForPdfParserWorkerReady(failedPort, { timeoutMs: 100 });
  failedPort.dispatchEvent(new Event("error"));
  await assert.rejects(failed, /could not start/);

  const bootstrapPort = new EventTarget();
  const bootstrapFailed = waitForPdfParserWorkerReady(bootstrapPort, {
    timeoutMs: 100,
  });
  bootstrapPort.dispatchEvent(
    new MessageEvent("message", {
      data: {
        sourceName: "linelight-parser-bootstrap",
        targetName: "main",
        action: "bootstrap-error",
        data: { message: "module rejected" },
      },
    }),
  );
  await assert.rejects(bootstrapFailed, /module rejected/);
});

test("reports discard and legacy recovery only after confirmed cleanup", () => {
  assert.equal(
    resolvePdfTerminalOutcome({
      cleanup: "discard",
      cleanupConfirmed: true,
      pageOnePersisted: true,
    }),
    "discarded",
  );
  assert.equal(
    resolvePdfTerminalOutcome({
      cleanup: "legacy-restore",
      cleanupConfirmed: true,
      pageOnePersisted: true,
    }),
    "legacy-restored",
  );
  assert.equal(
    resolvePdfTerminalOutcome({
      cleanup: "discard",
      cleanupConfirmed: false,
      pageOnePersisted: true,
    }),
    "resumable",
  );
  assert.equal(
    resolvePdfTerminalOutcome({
      cleanup: "legacy-restore",
      cleanupConfirmed: false,
      pageOnePersisted: false,
    }),
    "uncommitted",
  );
  const legacy = {
    id: "legacy",
    kind: "pdf",
    paragraphs: ["Existing Focus text"],
  };
  assert.equal(
    resolvePdfTerminalOutcome({
      cleanup: "legacy-restore",
      cleanupConfirmed: false,
      legacyExpected: true,
      pageOnePersisted: false,
      survivingDocument: legacy,
    }),
    "legacy-restored",
  );
  assert.equal(
    resolvePdfTerminalOutcome({
      cleanup: null,
      cleanupConfirmed: false,
      pageOnePersisted: false,
      survivingDocument: {
        id: "partial",
        kind: "pdf",
        paragraphs: [],
        pdfStorageVersion: 1,
      },
    }),
    "resumable",
  );
});
