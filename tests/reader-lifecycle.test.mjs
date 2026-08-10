import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isReaderLifecycleRestoreCurrent } from "../app/reader-lifecycle.mjs";

const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);

test("keeps startup restoration bound to its original lifecycle generation", () => {
  assert.equal(
    isReaderLifecycleRestoreCurrent({
      currentGeneration: 4,
      restoreGeneration: 4,
    }),
    true,
  );
  assert.equal(
    isReaderLifecycleRestoreCurrent({
      currentGeneration: 5,
      restoreGeneration: 4,
    }),
    false,
  );
  assert.equal(
    isReaderLifecycleRestoreCurrent({
      cancelled: true,
      currentGeneration: 4,
      restoreGeneration: 4,
    }),
    false,
  );
});

test("reports a genuine restore failure but suppresses a replaced restore", async () => {
  let currentGeneration = 4;
  let expectedRestoreGeneration = currentGeneration;
  const restoreIsCurrent = () =>
    isReaderLifecycleRestoreCurrent({
      currentGeneration,
      restoreGeneration: expectedRestoreGeneration,
    });
  const startRestore = (replacementDuringOpen) => {
    currentGeneration += 1;
    const failure = Promise.reject(new Error("stored PDF failed"));
    expectedRestoreGeneration = currentGeneration;
    if (replacementDuringOpen) currentGeneration += 1;
    return failure;
  };

  await assert.rejects(startRestore(false), /stored PDF failed/u);
  assert.equal(restoreIsCurrent(), true);

  currentGeneration = 8;
  expectedRestoreGeneration = currentGeneration;
  await assert.rejects(startRestore(true), /stored PDF failed/u);
  assert.equal(restoreIsCurrent(), false);
});

test("checks startup restoration after library, metadata, and document awaits", () => {
  const restoreEffect = pageSource.slice(
    pageSource.indexOf("let expectedRestoreGeneration = readerLifecycleGenerationRef.current"),
    pageSource.indexOf("if (\"serviceWorker\" in navigator)"),
  );
  assert.match(
    restoreEffect,
    /loadReaderLibrary\(\)[\s\S]*?if \(!restoreIsCurrent\(\)\) return;/u,
  );
  assert.match(
    restoreEffect,
    /await openReaderDocumentMetadata\(activeEntry\.id\);\s*if \(!restoreIsCurrent\(\)\) return;/u,
  );
  assert.match(
    restoreEffect,
    /if \(!restoreIsCurrent\(\)\) return;\s*const restorePromise = startPdfRuntime[\s\S]*?expectedRestoreGeneration = readerLifecycleGenerationRef\.current;\s*await restorePromise;\s*if \(!restoreIsCurrent\(\)\) return;/u,
  );
  assert.match(
    restoreEffect,
    /await getReaderDocument\([\s\S]*?if \(!storedDocument \|\| !restoreIsCurrent\(\)\) return;/u,
  );
  assert.match(
    restoreEffect,
    /\.catch\(\(\) => \{\s*if \(restoreIsCurrent\(\)\)/u,
  );
});
