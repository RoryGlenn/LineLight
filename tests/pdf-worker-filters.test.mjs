import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPdfWorkerFilter,
  isPdfWorkerFilterSupported,
} from "../app/pdf-worker-filters.mjs";

test("converts luminosity masks to alpha with the PDF.js SVG matrix", () => {
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 128,
  ]);
  applyPdfWorkerFilter(pixels, { kind: "luminosity" });
  assert.deepEqual([...pixels], [
    255, 0, 0, 76,
    0, 255, 0, 150,
    0, 0, 255, 28,
  ]);
});

test("applies a soft-mask alpha transfer table without changing RGB", () => {
  const invert = Uint8Array.from({ length: 256 }, (_, value) => 255 - value);
  const alphaPixels = new Uint8ClampedArray([10, 20, 30, 40]);
  applyPdfWorkerFilter(alphaPixels, { kind: "alpha", map: invert });
  assert.deepEqual([...alphaPixels], [10, 20, 30, 215]);
  assert.equal(isPdfWorkerFilterSupported({ kind: "luminosity" }), true);
  assert.equal(isPdfWorkerFilterSupported({ kind: "transfer" }), false);
});
