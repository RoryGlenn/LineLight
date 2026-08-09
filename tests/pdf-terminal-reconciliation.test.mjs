import assert from "node:assert/strict";
import test from "node:test";

import { reconcilePdfTerminalOutcome } from "../app/pdf-terminal-reconciliation.mjs";

test("a delayed terminal error cannot replace a newly opened document", async () => {
  let generation = 7;
  let releaseLibrary;
  const library = new Promise((resolve) => {
    releaseLibrary = resolve;
  });
  const calls = [];
  const reconciliation = reconcilePdfTerminalOutcome({
    documentId: "old-pdf",
    generation,
    getDocument: async () => {
      calls.push("get-document");
      return { id: "old-pdf" };
    },
    getGeneration: () => generation,
    loadLibrary: () => library,
    onDiscarded: () => calls.push("discarded"),
    onLibrary: () => calls.push("library"),
    onRecovered: () => calls.push("recovered"),
    outcome: "legacy-restored",
  });

  generation = 8;
  releaseLibrary({ entries: [{ id: "new-pdf" }] });
  assert.equal(await reconciliation, "stale");
  assert.deepEqual(calls, []);
});

test("a current confirmed legacy recovery reconciles library then document", async () => {
  const calls = [];
  const result = await reconcilePdfTerminalOutcome({
    documentId: "legacy-pdf",
    generation: 4,
    getDocument: async () => ({ id: "legacy-pdf", paragraphs: ["Restored"] }),
    getGeneration: () => 4,
    loadLibrary: async () => ({ entries: [{ id: "legacy-pdf" }] }),
    onDiscarded: () => calls.push("discarded"),
    onLibrary: (snapshot) => calls.push(`library:${snapshot.entries.length}`),
    onRecovered: (document) => calls.push(`recovered:${document.id}`),
    outcome: "legacy-restored",
  });
  assert.equal(result, "recovered");
  assert.deepEqual(calls, ["library:1", "recovered:legacy-pdf"]);
});

test("missing or corrupt legacy source preserves its readable Focus paragraphs", async () => {
  const legacy = {
    id: "legacy-without-source",
    title: "Readable legacy PDF",
    author: "PDF",
    kind: "pdf",
    paragraphs: ["This existing extracted paragraph remains readable."],
  };
  let recovered = null;
  const result = await reconcilePdfTerminalOutcome({
    documentId: legacy.id,
    generation: 9,
    getDocument: async () => legacy,
    getGeneration: () => 9,
    loadLibrary: async () => ({ entries: [{ id: legacy.id }] }),
    onDiscarded: () => assert.fail("legacy text must not be discarded"),
    onLibrary: () => {},
    onRecovered: (document) => {
      recovered = document;
    },
    outcome: "legacy-restored",
  });
  assert.equal(result, "recovered");
  assert.deepEqual(recovered.paragraphs, legacy.paragraphs);
});
