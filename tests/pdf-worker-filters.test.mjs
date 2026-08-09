import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPdfWorkerFilter,
  isPdfWorkerFilterSupported,
} from "../app/pdf-worker-filters.mjs";

test("converts luminosity masks to alpha with the PDF.js sRGB weights", () => {
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 128,
  ]);
  applyPdfWorkerFilter(pixels, { kind: "luminosity" });
  assert.deepEqual([...pixels], [
    255, 0, 0, 77,
    0, 255, 0, 150,
    0, 0, 255, 14,
  ]);
});

test("applies alpha and RGB transfer tables without changing other channels", () => {
  const invert = Uint8Array.from({ length: 256 }, (_, value) => 255 - value);
  const alphaPixels = new Uint8ClampedArray([10, 20, 30, 40]);
  applyPdfWorkerFilter(alphaPixels, { kind: "alpha", map: invert });
  assert.deepEqual([...alphaPixels], [10, 20, 30, 215]);

  const colorPixels = new Uint8ClampedArray([10, 20, 30, 40]);
  applyPdfWorkerFilter(colorPixels, { kind: "transfer", maps: [invert] });
  assert.deepEqual([...colorPixels], [245, 235, 225, 40]);
  assert.equal(isPdfWorkerFilterSupported({ kind: "luminosity" }), true);
  assert.equal(isPdfWorkerFilterSupported({ kind: "unsupported" }), false);
});
