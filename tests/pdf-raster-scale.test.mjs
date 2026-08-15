import assert from "node:assert/strict";
import test from "node:test";

import {
  constrainPdfRasterScale,
  isPdfRasterSufficient,
  pdfPageRasterDirectiveKey,
  resolvePdfPageRasterDirective,
  resolvePdfPageRasterRequest,
  resolvePdfRasterTarget,
} from "../app/pdf-raster-scale.mjs";

test("matches responsive PDF pages to their occupied physical pixels", () => {
  const desktop = resolvePdfRasterTarget({
    pageWidth: 432,
    pageHeight: 648,
    cssWidth: 898,
    cssHeight: 1348,
    devicePixelRatio: 1,
  });
  assert.deepEqual(desktop, {
    capped: false,
    width: 972,
    height: 1458,
    scale: 2.25,
  });

  const retina = resolvePdfRasterTarget({
    pageWidth: 432,
    pageHeight: 648,
    cssWidth: 898,
    cssHeight: 1348,
    devicePixelRatio: 2,
  });
  assert.equal(retina.scale, 4.25);
  assert.ok(retina.width >= 898 * 2);
  assert.ok(retina.height >= 1348 * 2);
});

test("accounts for mobile DPR and visual viewport zoom", () => {
  const mobile = resolvePdfRasterTarget({
    pageWidth: 432,
    pageHeight: 648,
    cssWidth: 368,
    cssHeight: 552,
    devicePixelRatio: 3,
  });
  assert.equal(mobile.scale, 2.75);
  assert.ok(mobile.width >= 368 * 3);
  assert.ok(mobile.height >= 552 * 3);

  const zoomed = resolvePdfRasterTarget({
    pageWidth: 432,
    pageHeight: 648,
    cssWidth: 368,
    cssHeight: 552,
    devicePixelRatio: 3,
    visualViewportScale: 2,
  });
  assert.equal(zoomed.scale, 5.25);
  assert.ok(zoomed.width >= 368 * 3 * 2);
  assert.ok(zoomed.height >= 552 * 3 * 2);
});

test("uses the larger axis for rotated and aspect-mismatched page boxes", () => {
  const rotated = resolvePdfRasterTarget({
    pageWidth: 800,
    pageHeight: 600,
    cssWidth: 400,
    cssHeight: 300,
    devicePixelRatio: 2,
  });
  assert.equal(rotated.scale, 1);
  assert.deepEqual(
    { width: rotated.width, height: rotated.height },
    { width: 800, height: 600 },
  );

  const aspectMismatch = resolvePdfRasterTarget({
    pageWidth: 600,
    pageHeight: 800,
    cssWidth: 900,
    cssHeight: 1000,
  });
  assert.equal(aspectMismatch.scale, 1.5);
  assert.ok(aspectMismatch.width >= 900);
  assert.ok(aspectMismatch.height >= 1000);
});

test("bounds full-page raster allocation by area and dimension", () => {
  assert.deepEqual(
    constrainPdfRasterScale({
      pageWidth: 1000,
      pageHeight: 1000,
      scale: 10,
      maxPixels: 4_000_000,
      maxDimension: 8192,
    }),
    { capped: true, width: 2000, height: 2000, scale: 2 },
  );

  const giantPage = constrainPdfRasterScale({
    pageWidth: 20_000,
    pageHeight: 20_000,
    scale: 1,
  });
  assert.equal(giantPage.capped, true);
  assert.ok(giantPage.scale < 1);
  assert.ok(giantPage.width <= 8192);
  assert.ok(giantPage.height <= 8192);
  assert.ok(giantPage.width * giantPage.height <= 16_777_216);

  const rounded = constrainPdfRasterScale({
    pageWidth: 3,
    pageHeight: 3,
    scale: 2,
    maxPixels: 10,
    maxDimension: 10,
  });
  assert.equal(rounded.capped, true);
  assert.ok(rounded.width * rounded.height <= 10);
  assert.ok(rounded.width <= 10);
  assert.ok(rounded.height <= 10);
});

test("a capped bitmap satisfies repeated targets without a rerender loop", () => {
  const input = {
    pageWidth: 1000,
    pageHeight: 1000,
    cssWidth: 4000,
    cssHeight: 4000,
    devicePixelRatio: 2,
    maxPixels: 4_000_000,
    maxDimension: 8192,
  };
  const first = resolvePdfRasterTarget(input);
  const repeated = resolvePdfRasterTarget(input);
  assert.deepEqual(repeated, first);
  assert.equal(first.capped, true);
  assert.equal(isPdfRasterSufficient(first, repeated), true);
});

test("uses safe defaults and compares actual backing dimensions", () => {
  const fallback = resolvePdfRasterTarget({
    pageWidth: Number.NaN,
    pageHeight: 0,
    cssWidth: -1,
    cssHeight: Number.POSITIVE_INFINITY,
    devicePixelRatio: 0,
    visualViewportScale: Number.NaN,
  });
  assert.deepEqual(fallback, {
    capped: false,
    width: 1,
    height: 1,
    scale: 1,
  });

  const target = { width: 1200, height: 1600 };
  assert.equal(
    isPdfRasterSufficient({ width: 1200, height: 1600 }, target),
    true,
  );
  assert.equal(
    isPdfRasterSufficient({ width: 1199, height: 1600 }, target),
    false,
  );
  assert.equal(isPdfRasterSufficient(undefined, target), false);
});

test("requests sharp rasters only for visible pages and cheap adjacent previews", () => {
  const target = resolvePdfRasterTarget({
    pageWidth: 600,
    pageHeight: 800,
    cssWidth: 900,
    cssHeight: 1200,
    devicePixelRatio: 2,
  });
  assert.deepEqual(
    resolvePdfPageRasterRequest({
      visible: true,
      distance: 0,
      pageWidth: 600,
      pageHeight: 800,
      target,
    }),
    { ...target, distance: 0, visible: true },
  );

  const preview = resolvePdfPageRasterRequest({
    visible: false,
    distance: 1,
    pageWidth: 600,
    pageHeight: 800,
    target,
  });
  assert.equal(preview.visible, false);
  assert.equal(preview.distance, 1);
  assert.equal(preview.scale, 1.25);
  assert.deepEqual(
    { width: preview.width, height: preview.height },
    { width: 750, height: 1000 },
  );

  assert.equal(
    resolvePdfPageRasterRequest({
      visible: false,
      distance: 2,
      pageWidth: 600,
      pageHeight: 800,
      target,
    }),
    null,
  );
});

test("a late preview does not republish an already-requested sharp raster", () => {
  const target = resolvePdfRasterTarget({
    pageWidth: 600,
    pageHeight: 800,
    cssWidth: 900,
    cssHeight: 1200,
    devicePixelRatio: 2,
  });
  const requested = resolvePdfPageRasterDirective({
    distance: 0,
    pageWidth: 600,
    pageHeight: 800,
    target,
    visible: true,
  });
  const afterLatePreview = resolvePdfPageRasterDirective({
    bitmap: { width: 750, height: 1000, scale: 1.25 },
    distance: 0,
    pageWidth: 600,
    pageHeight: 800,
    target,
    visible: true,
  });
  assert.deepEqual(afterLatePreview, requested);
  assert.equal(
    pdfPageRasterDirectiveKey(afterLatePreview),
    pdfPageRasterDirectiveKey(requested),
  );

  const completed = resolvePdfPageRasterDirective({
    bitmap: target,
    distance: 0,
    pageWidth: 600,
    pageHeight: 800,
    target,
    visible: true,
  });
  assert.equal(completed.enabled, false);
  assert.equal(pdfPageRasterDirectiveKey(completed), "disabled");
});

test("publishes near-page downgrades and far-page queue cancellation", () => {
  const target = { capped: false, width: 1800, height: 2400, scale: 3 };
  const near = resolvePdfPageRasterDirective({
    distance: 1,
    pageWidth: 600,
    pageHeight: 800,
    target,
    visible: false,
  });
  assert.equal(near.enabled, true);
  assert.equal(near.scale, 1.25);
  assert.equal(near.distance, 1);

  const far = resolvePdfPageRasterDirective({
    distance: 2,
    pageWidth: 600,
    pageHeight: 800,
    target,
    visible: false,
  });
  assert.deepEqual(far, {
    distance: 2,
    enabled: false,
    scale: 0,
    visible: false,
  });

  const fallback = resolvePdfPageRasterDirective({
    distance: 0,
    fallbackActive: true,
    pageWidth: 600,
    pageHeight: 800,
    target,
    visible: true,
  });
  assert.deepEqual(fallback, {
    distance: 0,
    enabled: false,
    scale: 3,
    visible: true,
  });
});
