import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewSource = await readFile(
  new URL("../app/pdf-page-view.tsx", import.meta.url),
  "utf8",
);
const workerSource = await readFile(
  new URL("../app/pdf-document.worker.ts", import.meta.url),
  "utf8",
);

test("binds sharp raster ownership to actual viewport visibility", () => {
  assert.match(viewSource, /viewportStart: range\.start/u);
  assert.match(viewSource, /viewportEnd: range\.end/u);
  assert.match(viewSource, /distanceFromViewport\(/u);
  assert.match(viewSource, /data-pdf-page-visible=/u);
  assert.match(viewSource, /if \(!visible\) \{\s+canvas\.width = 0;/u);
  assert.match(viewSource, /if \(!visible\) return;\s+return pinBitmap/u);
  assert.match(
    viewSource,
    /enabled: directive\.enabled,\s+visible: directive\.visible,\s+distance: directive\.distance/u,
  );
  assert.match(
    viewSource,
    /requestRenderRef\.current\(pageRecord\.pageNumber, 0, \{\s+enabled: false/u,
  );
  assert.match(
    viewSource,
    /Number\(bitmap\.scale\) >= requestedScaleRef\.current/u,
  );
  assert.match(
    viewSource,
    /publishedDirectiveRef\.current === directiveKey/u,
  );
});

test("keys fallback state by revision and cancels serialized DOM renders", () => {
  assert.match(
    viewSource,
    /`\$\{firstPage\.documentId\}:\$\{firstPage\.revision\}`/u,
  );
  assert.match(viewSource, /createPdfFallbackScheduler\(\)/u);
  assert.match(viewSource, /fallbackScheduler\.schedule\(\{/u);
  assert.match(viewSource, /signal\.addEventListener\("abort", cancelRender\)/u);
  assert.match(viewSource, /PDF_FALLBACK_MAX_ATTEMPTS/u);
  assert.match(workerSource, /renderPdfPageOrFallback/u);
  assert.match(workerSource, /retry visible pages cooperatively/u);
  assert.match(workerSource, /reconcilePdfActiveRenderRequest\(/u);
  assert.match(
    workerSource,
    /context\.renderFallbackActive = activation\.fallbackActive/u,
  );
  assert.match(
    workerSource,
    /if \(context\.renderFallbackActive\) \{\s+renderQueue = updatePdfRenderQueue/u,
  );
  assert.match(workerSource, /cancelledRenderSequences\.add\(/u);
  assert.match(
    workerSource,
    /context\.renderRequestSequence === currentActive\.sequence/u,
  );
});
