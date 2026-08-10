export const PDF_SHARPNESS_SCHEMA_VERSION = 2;
export const PDF_SHARPNESS_MAX_LONG_TASK_MS = 50;
export const PDF_SHARPNESS_PREVIEW_SCALE = 1.25;
export const PDF_SHARPNESS_RASTER_TRANSITIONS = Object.freeze([
  "preview-satisfied-target",
  "preview-to-sharp-upgrade",
]);
export const PDF_SHARPNESS_MAX_BITMAP_COUNT = 8;
export const PDF_SHARPNESS_MAX_BITMAP_PIXELS = 33_554_432;
export const PDF_SHARPNESS_MAX_COMPOSED_CANVASES = 2;
export const PDF_SHARPNESS_MAX_RASTER_PIXELS = 16_777_216;
export const PDF_SHARPNESS_MAX_RASTER_DIMENSION = 8_192;
export const PDF_SHARPNESS_REFERENCE_MIN_WHITE_RATIO = 0.5;
export const PDF_SHARPNESS_REFERENCE_MIN_INK_PIXELS = 100;
export const PDF_SHARPNESS_REFERENCE_MAX_INK_RATIO = 0.2;
export const PDF_SHARPNESS_REFERENCE_MIN_INK_ROW_BANDS = 2;
export const PDF_SHARPNESS_REFERENCE_MIN_INK_SPAN_RATIO = 0.2;
const PDF_SHARPNESS_RASTER_SCALE_STEP = 0.25;
const PDF_SHARPNESS_SCALE_EPSILON = 1e-7;

export const PDF_SHARPNESS_SOURCE_FILES = Object.freeze([
  "app/pdf-document-model.mjs",
  "app/pdf-document-protocol.mjs",
  "app/pdf-document-types.ts",
  "app/pdf-document.ts",
  "app/pdf-document.worker.ts",
  "app/pdf-fallback-scheduler.mjs",
  "app/pdf-page-store.mjs",
  "app/pdf-page-view.tsx",
  "app/pdf-parser.worker.ts",
  "app/pdf-raster-scheduler.mjs",
  "app/pdf-raster-scale.mjs",
  "app/reader-virtualization.mjs",
  "docs/codebase-index.md",
  "docs/evidence/issue-68/README.md",
  "scripts/generate-pdf-highlight-fixture.mjs",
  "scripts/pdf-sharpness-evidence.mjs",
  "scripts/run-pdf-highlight-browser-regression.mjs",
  "scripts/run-pdf-sharpness-browser-regression.mjs",
  "tests/pdf-document-model.test.mjs",
  "tests/pdf-fallback-scheduler.test.mjs",
  "tests/pdf-page-store.test.mjs",
  "tests/pdf-raster-lifecycle.test.mjs",
  "tests/pdf-raster-scale.test.mjs",
  "tests/pdf-sharpness-browser-harness.test.mjs",
  "tests/reader-virtualization.test.mjs",
]);

export const PDF_SHARPNESS_MATRIX = Object.freeze([
  {
    id: "desktop-dpr1-zoom100",
    kind: "desktop",
    width: 1100,
    height: 900,
    baseDevicePixelRatio: 1,
    browserZoom: 1,
    pinchZoom: 1,
  },
  {
    id: "desktop-dpr1-zoom125",
    kind: "desktop",
    width: 1100,
    height: 900,
    baseDevicePixelRatio: 1,
    browserZoom: 1.25,
    pinchZoom: 1,
  },
  {
    id: "desktop-dpr2-zoom100",
    kind: "desktop",
    width: 1440,
    height: 1000,
    baseDevicePixelRatio: 2,
    browserZoom: 1,
    pinchZoom: 1,
  },
  {
    id: "desktop-dpr2-zoom125",
    kind: "desktop",
    width: 1440,
    height: 1000,
    baseDevicePixelRatio: 2,
    browserZoom: 1.25,
    pinchZoom: 1,
  },
  {
    id: "mobile-dpr3-zoom100",
    kind: "mobile",
    width: 390,
    height: 844,
    baseDevicePixelRatio: 3,
    browserZoom: 1,
    pinchZoom: 1,
  },
  {
    id: "mobile-dpr3-pinch200",
    kind: "mobile",
    width: 390,
    height: 844,
    baseDevicePixelRatio: 3,
    browserZoom: 1,
    pinchZoom: 2,
  },
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function emptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

function validLongTasks(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (task) =>
        finite(task?.duration) &&
        Number(task.duration) >= 0 &&
        Number(task.duration) <= PDF_SHARPNESS_MAX_LONG_TASK_MS,
    )
  );
}

function validAlignment(value, configurationId) {
  return (
    value?.configurationId === configurationId &&
    value?.passed === true &&
    value?.activeWordInsideHighlight === true &&
    value?.narrationAdvanced === true &&
    nonNegativeInteger(value?.activeWordBefore) &&
    nonNegativeInteger(value?.activeWordAfter) &&
    value.activeWordAfter !== value.activeWordBefore &&
    nonNegativeInteger(value?.highlightRectangles) &&
    value.highlightRectangles > 0 &&
    Array.isArray(value?.spoken) &&
    value.spoken.length > 0 &&
    value.spoken.every(
      (entry) =>
        nonNegativeInteger(entry?.characters) &&
        entry.characters > 0 &&
        !Object.hasOwn(entry ?? {}, "text"),
    )
  );
}

function validBitmapStats(value) {
  return (
    nonNegativeInteger(value?.count) &&
    nonNegativeInteger(value?.pixels)
  );
}

function closeTo(actual, expected, tolerance = 0.02) {
  return finite(actual) && Math.abs(Number(actual) - expected) <= tolerance;
}

function withinPixels(actual, expected, tolerance = 2) {
  return finite(actual) && Math.abs(Number(actual) - expected) <= tolerance;
}

function expectedRasterTarget(sharp, viewport) {
  const values = [
    sharp?.cssWidth,
    sharp?.cssHeight,
    sharp?.pageWidth,
    sharp?.pageHeight,
    viewport?.devicePixelRatio,
    viewport?.visualViewportScale,
  ];
  if (values.some((value) => !finite(value) || Number(value) <= 0)) {
    return null;
  }
  const pageWidth = Number(sharp.pageWidth);
  const pageHeight = Number(sharp.pageHeight);
  const physicalPixelRatio =
    Number(viewport.devicePixelRatio) *
    Number(viewport.visualViewportScale);
  const requiredScale = Math.max(
    Number(sharp.cssWidth) / pageWidth,
    Number(sharp.cssHeight) / pageHeight,
  ) * physicalPixelRatio;
  const requestedScale =
    Math.ceil(
      (Math.max(1, requiredScale) - PDF_SHARPNESS_SCALE_EPSILON) /
        PDF_SHARPNESS_RASTER_SCALE_STEP,
    ) * PDF_SHARPNESS_RASTER_SCALE_STEP;
  const maximumScale = Math.max(
    Number.EPSILON,
    Math.min(
      PDF_SHARPNESS_MAX_RASTER_DIMENSION / pageWidth,
      PDF_SHARPNESS_MAX_RASTER_DIMENSION / pageHeight,
      Math.sqrt(
        PDF_SHARPNESS_MAX_RASTER_PIXELS / (pageWidth * pageHeight),
      ),
    ),
  );
  let scale = Math.min(requestedScale, maximumScale);
  const dimensions = (candidate) => ({
    height: Math.max(1, Math.ceil(pageHeight * candidate)),
    width: Math.max(1, Math.ceil(pageWidth * candidate)),
  });
  const fits = (candidate) =>
    candidate.width <= PDF_SHARPNESS_MAX_RASTER_DIMENSION &&
    candidate.height <= PDF_SHARPNESS_MAX_RASTER_DIMENSION &&
    candidate.width * candidate.height <= PDF_SHARPNESS_MAX_RASTER_PIXELS;
  let target = dimensions(scale);
  if (!fits(target)) {
    let lower = 0;
    let upper = scale;
    for (let index = 0; index < 64; index += 1) {
      const middle = (lower + upper) / 2;
      if (fits(dimensions(middle))) lower = middle;
      else upper = middle;
    }
    scale = lower;
    target = dimensions(scale);
  }
  return {
    capped: scale + PDF_SHARPNESS_SCALE_EPSILON < requestedScale,
    height: target.height,
    scale,
    width: target.width,
  };
}

function artifactIsBound(artifact) {
  return (
    artifact &&
    nonEmptyString(artifact.path) &&
    nonNegativeInteger(artifact.bytes) &&
    artifact.bytes > 0 &&
    SHA256_PATTERN.test(artifact.sha256 ?? "")
  );
}

function artifactBasename(artifact) {
  return String(artifact?.path ?? "").split(/[\\/]/u).at(-1) ?? "";
}

export function validatePdfSharpnessEvidence(evidence) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (evidence?.schemaVersion !== PDF_SHARPNESS_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${PDF_SHARPNESS_SCHEMA_VERSION}`);
  }
  if (evidence?.issue !== 68) fail("issue must be 68");

  const source = evidence?.source;
  if (!COMMIT_PATTERN.test(source?.commit ?? "")) {
    fail("source.commit must be a full 40-character commit");
  }
  if (!COMMIT_PATTERN.test(source?.tree ?? "")) {
    fail("source.tree must be a full 40-character tree");
  }
  if (!emptyArray(source?.preflightStatus)) {
    fail("source tree was dirty before the build");
  }
  if (!emptyArray(source?.postBuildStatus)) {
    fail("source tree was dirty after the build");
  }
  if (
    source?.postBuildCommit !== source?.commit ||
    source?.postBuildTree !== source?.tree
  ) {
    fail("source commit or tree changed while the artifact was built");
  }
  const sourceFiles = source?.files &&
      typeof source.files === "object" &&
      !Array.isArray(source.files)
    ? Object.entries(source.files)
    : [];
  const sourceFileKeys = sourceFiles.map(([file]) => file).sort();
  const expectedSourceFileKeys = [...PDF_SHARPNESS_SOURCE_FILES].sort();
  if (
    sourceFileKeys.length !== expectedSourceFileKeys.length ||
    sourceFileKeys.join("\n") !== expectedSourceFileKeys.join("\n")
  ) {
    fail("source.files must bind the exact reviewed file set");
  }
  for (const [file, hash] of sourceFiles) {
    if (!file || !SHA256_PATTERN.test(hash ?? "")) {
      fail(`source file ${file || "<missing>"} lacks a SHA-256 binding`);
    }
  }

  const build = evidence?.build;
  if (
    build?.fresh !== true ||
    build?.sourceCommit !== source?.commit ||
    build?.sourceTree !== source?.tree
  ) {
    fail("built artifact is not bound to the clean source commit and tree");
  }
  if (!nonEmptyString(build?.localManifest?.deploymentId)) {
    fail("local runtime manifest deploymentId is required");
  }
  if (
    build?.localManifest?.deploymentId !== build?.servedManifest?.deploymentId ||
    build?.localManifest?.sha256 !== build?.servedManifest?.sha256 ||
    !SHA256_PATTERN.test(build?.localManifest?.sha256 ?? "") ||
    !SHA256_PATTERN.test(build?.servedManifest?.sha256 ?? "")
  ) {
    fail("served runtime manifest does not exactly match the built artifact");
  }

  const fixture = evidence?.fixture;
  if (
    !SHA256_PATTERN.test(fixture?.sha256 ?? "") ||
    !nonEmptyString(fixture?.path) ||
    !nonNegativeInteger(fixture?.bytes) ||
    !(fixture?.bytes > 0)
  ) {
    fail("fixture must include non-empty SHA-256-bound PDF bytes");
  }

  const expectedIds = PDF_SHARPNESS_MATRIX.map((entry) => entry.id);
  const runs = Array.isArray(evidence?.matrix) ? evidence.matrix : [];
  if (!Array.isArray(evidence?.matrix)) {
    fail("matrix must be an array");
  }
  if (runs.length !== expectedIds.length) {
    fail(`matrix must contain ${expectedIds.length} runs`);
  }
  if (runs.map((run) => run.id).join(",") !== expectedIds.join(",")) {
    fail("matrix IDs/order do not match the required desktop/mobile matrix");
  }
  let strictRasterUpgradeCount = 0;
  for (const [index, run] of runs.entries()) {
    const expected = PDF_SHARPNESS_MATRIX[index];
    if (!expected) continue;
    if (
      run?.importedSource?.sha256 !== fixture?.sha256 ||
      run?.importedSource?.size !== fixture?.bytes
    ) {
      fail(`${expected.id} did not hash the selected PDF bytes in the browser`);
    }
    const expectedDpr = expected.baseDevicePixelRatio * expected.browserZoom;
    if (!closeTo(run?.viewport?.devicePixelRatio, expectedDpr)) {
      fail(`${expected.id} devicePixelRatio did not reflect DPR and browser zoom`);
    }
    if (!closeTo(run?.viewport?.visualViewportScale, expected.pinchZoom)) {
      fail(`${expected.id} visualViewport scale did not reflect pinch zoom`);
    }
    if (run?.viewport?.mobile !== (expected.kind === "mobile")) {
      fail(`${expected.id} used the wrong mobile emulation mode`);
    }
    const expectedTransition = expected.browserZoom > 1
      ? "browser-zoom"
      : expected.pinchZoom > 1
        ? "visual-viewport-pinch"
        : "normal";
    if (
      run?.viewport?.transition !== expectedTransition ||
      !closeTo(
        run?.viewport?.beforeDevicePixelRatio,
        expected.baseDevicePixelRatio,
      ) ||
      !closeTo(run?.viewport?.beforeVisualViewportScale, 1)
    ) {
      fail(`${expected.id} did not exercise the required live zoom transition`);
    }
    if (
      !withinPixels(run?.viewport?.beforeLayoutWidth, expected.width) ||
      !withinPixels(run?.viewport?.beforeLayoutHeight, expected.height) ||
      !withinPixels(
        run?.viewport?.layoutWidth,
        Math.round(expected.width / expected.browserZoom),
      ) ||
      !withinPixels(
        run?.viewport?.layoutHeight,
        Math.round(expected.height / expected.browserZoom),
      )
    ) {
      fail(`${expected.id} did not preserve the expected browser-zoom layout transition`);
    }

    const comparison = run?.comparison;
    if (
      comparison?.sourceSha256 !== fixture?.sha256 ||
      !artifactIsBound(comparison?.referenceScreenshot) ||
      !artifactIsBound(comparison?.lineLightScreenshot) ||
      comparison?.paired !== true
    ) {
      fail(`${expected.id} lacks a bound original-PDF/LineLight comparison pair`);
    }
    if (!Number.isInteger(comparison?.targetPage) || comparison.targetPage < 1) {
      fail(`${expected.id} comparison does not identify the reviewed PDF page`);
    }
    const referenceReadiness = comparison?.referenceReadiness;
    const pageBounds = referenceReadiness?.pageBounds;
    if (
      referenceReadiness?.renderedPage !== true ||
      referenceReadiness?.proof !== "white-page-with-rendered-ink" ||
      !Number.isInteger(referenceReadiness?.attempts) ||
      referenceReadiness.attempts < 1 ||
      !Number.isInteger(referenceReadiness?.width) ||
      !Number.isInteger(referenceReadiness?.height) ||
      referenceReadiness.width < 1 ||
      referenceReadiness.height < 1 ||
      !nonNegativeInteger(pageBounds?.x) ||
      !nonNegativeInteger(pageBounds?.y) ||
      !Number.isInteger(pageBounds?.width) ||
      !Number.isInteger(pageBounds?.height) ||
      pageBounds.width < 1 ||
      pageBounds.height < 1 ||
      pageBounds.x + pageBounds.width > referenceReadiness.width ||
      pageBounds.y + pageBounds.height > referenceReadiness.height ||
      !Number.isInteger(referenceReadiness?.pagePixels) ||
      referenceReadiness.pagePixels < 1 ||
      referenceReadiness.pagePixels > pageBounds.width * pageBounds.height ||
      !nonNegativeInteger(referenceReadiness?.pageWhitePixels) ||
      referenceReadiness.pageWhitePixels > referenceReadiness.pagePixels ||
      !finite(referenceReadiness?.pageWhiteRatio) ||
      referenceReadiness.pageWhiteRatio <
        PDF_SHARPNESS_REFERENCE_MIN_WHITE_RATIO ||
      !closeTo(
        referenceReadiness.pageWhiteRatio,
        referenceReadiness.pageWhitePixels / referenceReadiness.pagePixels,
        1e-6,
      ) ||
      !nonNegativeInteger(referenceReadiness?.inkPixels) ||
      referenceReadiness.inkPixels < PDF_SHARPNESS_REFERENCE_MIN_INK_PIXELS ||
      referenceReadiness.inkPixels > referenceReadiness.pagePixels ||
      !finite(referenceReadiness?.inkRatio) ||
      referenceReadiness.inkRatio > PDF_SHARPNESS_REFERENCE_MAX_INK_RATIO ||
      !closeTo(
        referenceReadiness.inkRatio,
        referenceReadiness.inkPixels / referenceReadiness.pagePixels,
        1e-6,
      ) ||
      !Number.isInteger(referenceReadiness?.inkRowBands) ||
      referenceReadiness.inkRowBands <
        PDF_SHARPNESS_REFERENCE_MIN_INK_ROW_BANDS ||
      !finite(referenceReadiness?.inkSpanRatio) ||
      referenceReadiness.inkSpanRatio <
        PDF_SHARPNESS_REFERENCE_MIN_INK_SPAN_RATIO ||
      referenceReadiness.inkSpanRatio > 1
    ) {
      fail(`${expected.id} original PDF reference lacks rendered-page pixel proof`);
    }

    const preview = run?.raster?.preview;
    if (
      preview?.observed !== true ||
      preview?.workerObserved !== true ||
      preview?.connectedCanvas !== true ||
      preview?.distance !== 1 ||
      !Number.isInteger(preview?.actualWidth) ||
      !Number.isInteger(preview?.actualHeight) ||
      preview.actualWidth < 1 ||
      preview.actualHeight < 1 ||
      !Number.isInteger(preview?.bitmapEventId) ||
      preview.bitmapEventId < 1 ||
      !Number.isInteger(preview?.compositionId) ||
      preview.compositionId < 1 ||
      !finite(preview?.scale) ||
      Number(preview.scale) <= 0 ||
      preview.scale > PDF_SHARPNESS_PREVIEW_SCALE + 1e-7 ||
      !finite(preview?.composedAt)
    ) {
      fail(`${expected.id} did not preserve the adjacent 1.25x preview policy`);
    }
    const sharp = run?.raster?.sharp;
    const independentlyExpected = expectedRasterTarget(sharp, run?.viewport);
    if (
      !independentlyExpected ||
      !finite(sharp?.actualWidth) ||
      !finite(sharp?.actualHeight) ||
      !finite(sharp?.cssWidth) ||
      !finite(sharp?.cssHeight) ||
      !finite(sharp?.pageWidth) ||
      !finite(sharp?.pageHeight) ||
      !finite(sharp?.targetWidth) ||
      !finite(sharp?.targetHeight) ||
      !finite(sharp?.targetScale) ||
      !finite(sharp?.composedAt) ||
      !Number.isInteger(sharp?.bitmapEventId) ||
      sharp.bitmapEventId < 1 ||
      !Number.isInteger(sharp?.compositionId) ||
      sharp.compositionId < 1 ||
      !nonNegativeInteger(sharp?.actualWidth) ||
      !nonNegativeInteger(sharp?.actualHeight) ||
      !nonNegativeInteger(sharp?.targetWidth) ||
      !nonNegativeInteger(sharp?.targetHeight) ||
      sharp.actualWidth === 0 ||
      sharp.actualHeight === 0 ||
      sharp.cssWidth <= 0 ||
      sharp.cssHeight <= 0 ||
      sharp.pageWidth <= 0 ||
      sharp.pageHeight <= 0 ||
      sharp.actualWidth !== independentlyExpected?.width ||
      sharp.actualHeight !== independentlyExpected?.height ||
      sharp.targetWidth !== independentlyExpected?.width ||
      sharp.targetHeight !== independentlyExpected?.height ||
      !closeTo(sharp.targetScale, independentlyExpected?.scale, 1e-6) ||
      typeof sharp?.targetCapped !== "boolean" ||
      sharp.targetCapped !== independentlyExpected?.capped ||
      sharp.actualWidth > PDF_SHARPNESS_MAX_RASTER_DIMENSION ||
      sharp.actualHeight > PDF_SHARPNESS_MAX_RASTER_DIMENSION ||
      sharp.actualWidth * sharp.actualHeight > PDF_SHARPNESS_MAX_RASTER_PIXELS
    ) {
      fail(`${expected.id} sharp backing did not reach its computed capped target`);
    }
    const expectedPreviewScale = Math.min(
      Number(independentlyExpected?.scale),
      PDF_SHARPNESS_PREVIEW_SCALE,
    );
    const expectedPreviewWidth = Math.ceil(
      Number(sharp?.pageWidth) * expectedPreviewScale,
    );
    const expectedPreviewHeight = Math.ceil(
      Number(sharp?.pageHeight) * expectedPreviewScale,
    );
    if (
      !closeTo(preview?.scale, expectedPreviewScale, 1e-7) ||
      preview?.actualWidth !== expectedPreviewWidth ||
      preview?.actualHeight !== expectedPreviewHeight
    ) {
      fail(`${expected.id} preview backing did not match its worker scale`);
    }
    const transition = run?.raster?.transition;
    const previewSatisfiedTarget =
      transition === PDF_SHARPNESS_RASTER_TRANSITIONS[0] &&
      run?.raster?.previewBeforeSharp === false &&
      preview?.actualWidth === independentlyExpected?.width &&
      preview?.actualHeight === independentlyExpected?.height &&
      preview?.bitmapEventId === sharp?.bitmapEventId &&
      preview?.compositionId === sharp?.compositionId &&
      preview?.composedAt === sharp?.composedAt;
    const previewUpgradedToSharp =
      transition === PDF_SHARPNESS_RASTER_TRANSITIONS[1] &&
      run?.raster?.previewBeforeSharp === true &&
      Number(preview?.scale) + 1e-7 < Number(independentlyExpected?.scale) &&
      preview?.actualWidth <= independentlyExpected?.width &&
      preview?.actualHeight <= independentlyExpected?.height &&
      (preview?.actualWidth < independentlyExpected?.width ||
        preview?.actualHeight < independentlyExpected?.height) &&
      preview?.bitmapEventId < sharp?.bitmapEventId &&
      preview?.compositionId < sharp?.compositionId &&
      Number(preview?.composedAt) <= Number(sharp?.composedAt);
    if (!previewSatisfiedTarget && !previewUpgradedToSharp) {
      fail(`${expected.id} preview-to-sharp transition proof is inconsistent`);
    }
    if (previewUpgradedToSharp) strictRasterUpgradeCount += 1;
    if (
      sharp?.source !== "worker-bitmap" ||
      run?.raster?.noResolutionRegression !== true ||
      run?.raster?.noLateLowOverwrite !== true
    ) {
      fail(`${expected.id} preview-to-sharp upgrade ordering regressed`);
    }

    if (
      !Number.isInteger(run?.visibleFirst?.targetPage) ||
      run?.visibleFirst?.firstComposedPage !== run?.visibleFirst?.targetPage ||
      run?.visibleFirst?.firstWorkerBitmapPage !== run?.visibleFirst?.targetPage ||
      !emptyArray(run?.visibleFirst?.staleNonVisibleCompositions) ||
      !emptyArray(run?.visibleFirst?.staleWorkerBitmaps)
    ) {
      fail(`${expected.id} did not render the current viewport first`);
    }
    if (
      run?.release?.canvasWidth !== 0 ||
      run?.release?.canvasHeight !== 0 ||
      run?.release?.renderSource !== null
    ) {
      fail(`${expected.id} retained an offscreen canvas backing`);
    }
    if (
      !finite(run?.canvasBudget?.maximumCount) ||
      !finite(run?.canvasBudget?.maximumPixels) ||
      !nonNegativeInteger(run?.canvasBudget?.maximumCount) ||
      !nonNegativeInteger(run?.canvasBudget?.maximumPixels) ||
      run?.canvasBudget?.maximumCount < 1 ||
      run?.canvasBudget?.maximumPixels < 1 ||
      run?.canvasBudget?.maximumPixels <
        sharp.actualWidth * sharp.actualHeight ||
      run?.canvasBudget?.maximumCount > PDF_SHARPNESS_MAX_COMPOSED_CANVASES ||
      run?.canvasBudget?.maximumPixels > PDF_SHARPNESS_MAX_BITMAP_PIXELS
    ) {
      fail(`${expected.id} exceeded the visible composed-canvas budget`);
    }
    if (!validLongTasks(run?.longTasks)) {
      fail(`${expected.id} recorded a Long Task over ${PDF_SHARPNESS_MAX_LONG_TASK_MS}ms`);
    }
    if (!emptyArray(run?.runtimeErrors)) {
      fail(`${expected.id} recorded a browser runtime error`);
    }
    if (!validAlignment(run?.alignment, expected.id)) {
      fail(`${expected.id} highlight/narration alignment evidence failed`);
    }
    if (
      run?.release?.shellRetained !== true ||
      run?.release?.textOverlayRetained !== true
    ) {
      fail(`${expected.id} did not retain its offscreen text/highlight shell`);
    }
  }
  if (strictRasterUpgradeCount < 1) {
    fail("matrix did not prove any strict preview-to-sharp raster upgrade");
  }

  const budget = evidence?.bitmapBudget;
  if (
    budget?.limits?.count !== PDF_SHARPNESS_MAX_BITMAP_COUNT ||
    budget?.limits?.pixels !== PDF_SHARPNESS_MAX_BITMAP_PIXELS ||
    !validBitmapStats(budget?.peak) ||
    budget?.peak?.count > PDF_SHARPNESS_MAX_BITMAP_COUNT ||
    budget?.peak?.pixels > PDF_SHARPNESS_MAX_BITMAP_PIXELS ||
    !validBitmapStats(budget?.steadyState) ||
    budget?.steadyState?.count > PDF_SHARPNESS_MAX_BITMAP_COUNT ||
    budget?.steadyState?.pixels > PDF_SHARPNESS_MAX_BITMAP_PIXELS ||
    budget?.pinnedOverflowObserved !== true ||
    !validBitmapStats(budget?.pinnedPeak) ||
    !(
      budget?.pinnedPeak?.count > PDF_SHARPNESS_MAX_BITMAP_COUNT ||
      budget?.pinnedPeak?.pixels > PDF_SHARPNESS_MAX_BITMAP_PIXELS
    ) ||
    !validBitmapStats(budget?.afterUnpin) ||
    budget?.afterUnpin?.count > PDF_SHARPNESS_MAX_BITMAP_COUNT ||
    budget?.afterUnpin?.pixels > PDF_SHARPNESS_MAX_BITMAP_PIXELS ||
    !Array.isArray(budget?.mixedSizes) ||
    budget.mixedSizes.length <= PDF_SHARPNESS_MAX_BITMAP_COUNT ||
    budget.mixedSizes.some(
      (size) =>
        !nonNegativeInteger(size?.width) ||
        !nonNegativeInteger(size?.height) ||
        size.width === 0 ||
        size.height === 0,
    ) ||
    !nonNegativeInteger(budget?.closedBitmaps) ||
    budget.closedBitmaps === 0 ||
    budget?.passed !== true
  ) {
    fail("count-plus-pixel bitmap budget probe failed");
  }

  const fallback = evidence?.fallback;
  const invisibleCancellation = fallback?.invisibleCancellation;
  const stagingEvents = Array.isArray(fallback?.stagingEvents)
    ? fallback.stagingEvents
    : [];
  const renderAttemptId = invisibleCancellation?.renderAttemptId;
  const cancelledPage = invisibleCancellation?.page;
  const stagingStartEvents = stagingEvents.filter(
    (event) => event?.type === "staging-start",
  );
  const cancelledStagingStart = stagingStartEvents.find(
    (event) => event?.renderAttemptId === renderAttemptId,
  );
  const continuationDelayEvents = stagingEvents.filter(
    (event) =>
      event?.type === "continuation-delay" &&
      event?.renderAttemptId === renderAttemptId,
  );
  const continuationDelayEvent = continuationDelayEvents[0];
  const viewportExitRequestEvents = stagingEvents.filter(
    (event) =>
      event?.type === "viewport-exit-request" &&
      event?.renderAttemptId === renderAttemptId,
  );
  const viewportExitRequestEvent = viewportExitRequestEvents[0];
  const viewportExitEvents = stagingEvents.filter(
    (event) =>
      event?.type === "viewport-exit" &&
      event?.renderAttemptId === renderAttemptId,
  );
  const viewportExitEvent = viewportExitEvents[0];
  const continuationResumeEvents = stagingEvents.filter(
    (event) =>
      event?.type === "continuation-resume" &&
      event?.renderAttemptId === renderAttemptId,
  );
  const continuationResumeEvent = continuationResumeEvents[0];
  const lateComposesForAttempt = stagingEvents.filter(
    (event) =>
      event?.type === "visible-compose" &&
      event?.renderAttemptId === renderAttemptId &&
      finite(viewportExitEvent?.at) &&
      event?.at > viewportExitEvent.at,
  );
  const uniqueStagingIdentities =
    stagingStartEvents.length > 0 &&
    stagingStartEvents.every(
      (event) =>
        Number.isInteger(event?.renderAttemptId) &&
        event.renderAttemptId > 0,
    ) &&
    new Set(
      stagingStartEvents.map((event) => event.renderAttemptId),
    ).size === stagingStartEvents.length;
  const composeIdentitiesMatch = stagingEvents
    .filter((event) => event?.type === "visible-compose")
    .every(
      (event) =>
        Number.isInteger(event?.renderAttemptId) &&
        event.renderAttemptId > 0 &&
        event?.pageMatchesAttempt === true &&
        event?.page === event?.sourcePage,
    );
  const recordedViewportExit = invisibleCancellation?.viewportExit;
  const recordedViewportExitRequest =
    invisibleCancellation?.viewportExitRequest;
  const signalRegistrationEvents = stagingEvents.filter(
    (event) => event?.type === "abort-signal-registered",
  );
  const retry = fallback?.retry;
  const failedAttemptId = retry?.failedAttemptId;
  const retryAttemptId = retry?.retryAttemptId;
  const failedStart = stagingStartEvents.find(
    (event) => event?.renderAttemptId === failedAttemptId,
  );
  const failedFinishEvents = stagingEvents.filter(
    (event) =>
      event?.type === "staging-finish" &&
      event?.outcome === "injected-failure",
  );
  const failedFinish = failedFinishEvents.find(
    (event) => event?.renderAttemptId === failedAttemptId,
  );
  const retryStart = stagingStartEvents.find(
    (event) => event?.renderAttemptId === retryAttemptId,
  );
  const retryCompose = stagingEvents.find(
    (event) =>
      event?.type === "visible-compose" &&
      event?.renderAttemptId === retryAttemptId,
  );
  const failedAttemptComposes = stagingEvents.filter(
    (event) =>
      event?.type === "visible-compose" &&
      event?.renderAttemptId === failedAttemptId,
  );
  const retryTargetKey = `${retry?.targetWidth}x${retry?.targetHeight}`;
  const failedSignalRegistrations = signalRegistrationEvents.filter(
    (event) => event?.abortSignalId === retry?.failedAbortSignalId,
  );
  const retrySignalRegistrations = signalRegistrationEvents.filter(
    (event) => event?.abortSignalId === retry?.retryAbortSignalId,
  );
  const injectionArmEvents = stagingEvents.filter(
    (event) => event?.type === "injection-armed",
  );
  const injectionArmEvent = injectionArmEvents[0];
  const retryIdentityBound =
    Number.isInteger(retry?.failedAbortSignalId) &&
    retry.failedAbortSignalId > 0 &&
    Number.isInteger(retry?.retryAbortSignalId) &&
    retry.retryAbortSignalId > 0 &&
    retry.retryAbortSignalId !== retry.failedAbortSignalId &&
    Number.isInteger(failedAttemptId) &&
    failedAttemptId > 0 &&
    Number.isInteger(retryAttemptId) &&
    retryAttemptId > 0 &&
    retryAttemptId !== failedAttemptId &&
    Number.isInteger(retry?.page) &&
    retry.page > 0 &&
    nonEmptyString(retry?.documentKey) &&
    nonEmptyString(retry?.revision) &&
    finite(retry?.injectionArmedAt) &&
    retry?.injectionPageDerivation ===
      "validated-adjacent-unsatisfied-page" &&
    retry?.pageDerivation === "sole-visible-unsatisfied-page" &&
    Number.isInteger(retry?.targetWidth) &&
    retry.targetWidth > 0 &&
    Number.isInteger(retry?.targetHeight) &&
    retry.targetHeight > 0 &&
    retry?.targetKey === retryTargetKey &&
    failedSignalRegistrations.length === 1 &&
    retrySignalRegistrations.length === 1 &&
    injectionArmEvents.length === 1 &&
    failedFinishEvents.length === 1 &&
    injectionArmEvent?.documentKey === retry.documentKey &&
    injectionArmEvent?.revision === retry.revision &&
    injectionArmEvent?.page === retry.page &&
    injectionArmEvent?.pageDerivation === retry.injectionPageDerivation &&
    injectionArmEvent?.at === retry.injectionArmedAt &&
    injectionArmEvent?.at <= failedStart?.at &&
    [failedStart, failedFinish, retryStart, retryCompose].every(
      (event) =>
        event?.page === retry.page &&
        event?.abortSignalId === (
          event?.renderAttemptId === failedAttemptId
            ? retry.failedAbortSignalId
            : retry.retryAbortSignalId
        ) &&
        event?.pageDerivation === retry.pageDerivation &&
        event?.documentKey === retry.documentKey &&
        event?.revision === retry.revision &&
        event?.targetWidth === retry.targetWidth &&
        event?.targetHeight === retry.targetHeight &&
        event?.targetKey === retry.targetKey,
    ) &&
    [failedStart, retryStart].every(
      (event) =>
        event?.abortSignalCandidateCount === 1 &&
        finite(event?.abortSignalRegisteredAt) &&
        Array.isArray(event?.candidatePages) &&
        event.candidatePages.length === 1 &&
        event.candidatePages[0] === retry.page,
    ) &&
    failedSignalRegistrations[0]?.at ===
      failedStart?.abortSignalRegisteredAt &&
    failedSignalRegistrations[0]?.at <= failedStart?.at &&
    retrySignalRegistrations[0]?.at === retryStart?.abortSignalRegisteredAt &&
    retrySignalRegistrations[0]?.at <= retryStart?.at &&
    failedFinish?.outcome === "injected-failure" &&
    failedStart?.at <= failedFinish?.at &&
    failedFinish?.at === retry?.failedAt &&
    failedFinish?.at < retryStart?.at &&
    retryStart?.at === retry?.retryStartedAt &&
    retryStart?.at <= retryCompose?.at &&
    retryCompose?.at === retry?.composedAt &&
    retryCompose?.pageMatchesAttempt === true &&
    failedAttemptComposes.length === 0;
  const cancellationTerminal = invisibleCancellation?.cancellationTerminal;
  const cancellationTerminalEvents = stagingEvents.filter(
    (event) =>
      event?.type === "staging-finish" &&
      event?.renderAttemptId === renderAttemptId,
  );
  const cancellationTerminalEvent = cancellationTerminalEvents.find(
    (event) => event?.outcome === "cancelled",
  );
  const cancelRequestEvents = stagingEvents.filter(
    (event) =>
      event?.type === "cancel-request" &&
      event?.renderAttemptId === renderAttemptId,
  );
  const cancelRequestEvent = cancelRequestEvents[0];
  const cancellationSignalId = invisibleCancellation?.abortSignalId;
  const cancellationSignalRegistrations = signalRegistrationEvents.filter(
    (event) => event?.abortSignalId === cancellationSignalId,
  );
  const continuationArmEvents = stagingEvents.filter(
    (event) => event?.type === "continuation-armed",
  );
  const continuationArmEvent = continuationArmEvents[0];
  const cancellationIdentityBound =
    Number.isInteger(cancellationSignalId) &&
    cancellationSignalId > 0 &&
    cancellationSignalId !== retry?.failedAbortSignalId &&
    cancellationSignalId !== retry?.retryAbortSignalId &&
    nonEmptyString(invisibleCancellation?.documentKey) &&
    nonEmptyString(invisibleCancellation?.revision) &&
    finite(invisibleCancellation?.continuationArmedAt) &&
    invisibleCancellation?.continuationArmPageDerivation ===
      "next-page-from-sole-visible-page" &&
    cancelledStagingStart?.abortSignalCandidateCount === 1 &&
    cancelledStagingStart?.abortSignalId === cancellationSignalId &&
    finite(cancelledStagingStart?.abortSignalRegisteredAt) &&
    cancellationSignalRegistrations.length === 1 &&
    cancellationSignalRegistrations[0]?.at ===
      cancelledStagingStart?.abortSignalRegisteredAt &&
    cancellationSignalRegistrations[0]?.at <= cancelledStagingStart?.at &&
    continuationArmEvents.length === 1 &&
    continuationArmEvent?.documentKey ===
      invisibleCancellation.documentKey &&
    continuationArmEvent?.revision === invisibleCancellation.revision &&
    continuationArmEvent?.page === cancelledPage &&
    continuationArmEvent?.pageDerivation ===
      invisibleCancellation.continuationArmPageDerivation &&
    Array.isArray(continuationArmEvent?.candidatePages) &&
    continuationArmEvent.candidatePages.length === 1 &&
    continuationArmEvent.candidatePages[0] === cancelledPage &&
    continuationArmEvent?.armedAt === continuationArmEvent?.at &&
    continuationArmEvent?.at ===
      invisibleCancellation.continuationArmedAt &&
    continuationArmEvent?.at <= cancelledStagingStart?.at &&
    continuationDelayEvents.length === 1 &&
    viewportExitRequestEvents.length === 1 &&
    viewportExitEvents.length === 1 &&
    continuationResumeEvents.length === 1 &&
    cancellationTerminalEvents.length === 1 &&
    continuationDelayEvent?.armedAt === continuationArmEvent?.at &&
    cancellationTerminalEvent?.outcome === "cancelled" &&
    cancellationTerminalEvent?.documentKey ===
    invisibleCancellation.documentKey &&
    cancellationTerminalEvent?.revision === invisibleCancellation.revision &&
    cancellationTerminalEvent?.page === cancelledPage &&
    cancellationTerminalEvent?.pageDerivation ===
      invisibleCancellation.pageDerivation &&
    cancellationTerminalEvent?.targetWidth ===
      cancelledStagingStart?.targetWidth &&
    cancellationTerminalEvent?.targetHeight ===
      cancelledStagingStart?.targetHeight &&
    cancellationTerminalEvent?.targetKey === cancelledStagingStart?.targetKey &&
    cancelRequestEvents.length === 1 &&
    continuationDelayEvent?.at <= viewportExitRequestEvent?.at &&
    viewportExitRequestEvent?.at <= cancelRequestEvent?.at &&
    cancelRequestEvent?.at <= cancellationTerminalEvent?.at &&
    cancellationTerminalEvent?.at <= viewportExitEvent?.at &&
    viewportExitEvent?.at < continuationResumeEvent?.at &&
    viewportExitEvent?.cancelRequestedAt === cancelRequestEvent?.at &&
    cancellationTerminalEvent?.cancelRequestedAt === cancelRequestEvent?.at &&
    cancellationTerminalEvent?.abortSignalId === cancellationSignalId &&
    cancellationTerminal?.at === cancellationTerminalEvent?.at &&
    cancellationTerminal?.abortSignalId === cancellationSignalId &&
    cancellationTerminal?.outcome === cancellationTerminalEvent?.outcome &&
    cancellationTerminal?.renderAttemptId === renderAttemptId &&
    cancellationTerminal?.documentKey === invisibleCancellation.documentKey &&
    cancellationTerminal?.revision === invisibleCancellation.revision &&
    cancellationTerminal?.page === cancelledPage &&
    cancellationTerminal?.cancelRequestedAt === cancelRequestEvent?.at;
  const matchingIdentity = [
    cancelledStagingStart,
    continuationDelayEvent,
    viewportExitRequestEvent,
    viewportExitEvent,
    continuationResumeEvent,
    cancelRequestEvent,
    cancellationTerminalEvent,
  ].every(
    (event) =>
      event?.renderAttemptId === renderAttemptId &&
      event?.page === cancelledPage &&
      event?.pageDerivation === "sole-visible-unsatisfied-page" &&
      event?.documentKey === invisibleCancellation?.documentKey &&
      event?.revision === invisibleCancellation?.revision,
  );
  const matchingCancellationSignal = [
    cancelledStagingStart,
    continuationDelayEvent,
    viewportExitRequestEvent,
    viewportExitEvent,
    continuationResumeEvent,
    cancelRequestEvent,
    cancellationTerminalEvent,
  ].every((event) => event?.abortSignalId === cancellationSignalId);
  if (
    !artifactIsBound(fallback?.artifact) ||
    fallback?.signaledBeforeDocumentReady !== true ||
    fallback?.workerQueueClosed !== true ||
    fallback?.maximumConcurrentStaging !== 1 ||
    fallback?.injectedFailures !== 1 ||
    fallback?.importedSource?.sha256 !== fixture?.sha256 ||
    fallback?.importedSource?.size !== fixture?.bytes ||
    fallback?.retrySucceeded !== true ||
    !retryIdentityBound ||
    !cancellationIdentityBound ||
    !Number.isInteger(renderAttemptId) ||
    renderAttemptId < 1 ||
    cancelledPage !== 3 ||
    invisibleCancellation?.pageDerivation !==
      "sole-visible-unsatisfied-page" ||
    !matchingIdentity ||
    !matchingCancellationSignal ||
    !uniqueStagingIdentities ||
    !composeIdentitiesMatch ||
    !Array.isArray(cancelledStagingStart?.candidatePages) ||
    cancelledStagingStart.candidatePages.length !== 1 ||
    cancelledStagingStart.candidatePages[0] !== cancelledPage ||
    invisibleCancellation?.completedAfterExit !== false ||
    invisibleCancellation?.canvasPresentAfterExit !== true ||
    invisibleCancellation?.canvasWidthAfterExit !== 0 ||
    invisibleCancellation?.canvasHeightAfterExit !== 0 ||
    invisibleCancellation?.continuationDelayObserved !== true ||
    invisibleCancellation?.continuationResumeObserved !== true ||
    !finite(invisibleCancellation?.continuationDelayAt) ||
    !finite(invisibleCancellation?.exitRequestedAt) ||
    !finite(invisibleCancellation?.exitedAt) ||
    !finite(invisibleCancellation?.continuationResumeAt) ||
    !finite(invisibleCancellation?.continuationResumedAfterMs) ||
    invisibleCancellation.continuationResumedAfterMs < 950 ||
    invisibleCancellation.continuationDelayAt >
      invisibleCancellation.exitRequestedAt ||
    invisibleCancellation.exitRequestedAt > invisibleCancellation.exitedAt ||
    invisibleCancellation.exitedAt >= invisibleCancellation.continuationResumeAt ||
    !emptyArray(invisibleCancellation?.lateComposes) ||
    lateComposesForAttempt.length !== 0 ||
    invisibleCancellation?.textOverlayRetainedAfterExit !== true ||
    !emptyArray(fallback?.runtimeErrors) ||
    stagingEvents.length === 0 ||
    !/scheduleNext/iu.test(continuationDelayEvent?.callbackName ?? "") ||
    !finite(continuationDelayEvent?.armedAt) ||
    continuationDelayEvent.armedAt > continuationDelayEvent?.at ||
    !finite(continuationDelayEvent?.delay) ||
    continuationDelayEvent.delay < 1_000 ||
    !finite(cancelledStagingStart?.at) ||
    cancelledStagingStart.at > continuationDelayEvent?.at ||
    continuationDelayEvent?.at !== invisibleCancellation?.continuationDelayAt ||
    viewportExitRequestEvent?.at !== invisibleCancellation?.exitRequestedAt ||
    viewportExitEvent?.at !== invisibleCancellation?.exitedAt ||
    continuationResumeEvent?.at !== invisibleCancellation?.continuationResumeAt ||
    continuationResumeEvent?.afterMs !==
      invisibleCancellation?.continuationResumedAfterMs ||
    viewportExitEvent?.visible !== false ||
    viewportExitEvent?.canvasPresent !== true ||
    viewportExitEvent?.canvasWidth !== 0 ||
    viewportExitEvent?.canvasHeight !== 0 ||
    viewportExitEvent?.cancelRequestedAt !== cancelRequestEvent?.at ||
    viewportExitRequestEvent?.destinationPage !== 5 ||
    viewportExitRequestEvent?.visibleBeforeRequest !== true ||
    !Number.isInteger(viewportExitEvent?.textOverlayCount) ||
    viewportExitEvent.textOverlayCount < 1 ||
    recordedViewportExit?.renderAttemptId !== renderAttemptId ||
    recordedViewportExit?.documentKey !== invisibleCancellation?.documentKey ||
    recordedViewportExit?.revision !== invisibleCancellation?.revision ||
    recordedViewportExit?.page !== cancelledPage ||
    recordedViewportExit?.pageDerivation !==
      "sole-visible-unsatisfied-page" ||
    recordedViewportExit?.at !== viewportExitEvent?.at ||
    recordedViewportExit?.cancelRequestedAt !== cancelRequestEvent?.at ||
    recordedViewportExit?.visible !== viewportExitEvent?.visible ||
    recordedViewportExit?.canvasPresent !== viewportExitEvent?.canvasPresent ||
    recordedViewportExit?.canvasWidth !== viewportExitEvent?.canvasWidth ||
    recordedViewportExit?.canvasHeight !== viewportExitEvent?.canvasHeight ||
    recordedViewportExit?.textOverlayCount !== viewportExitEvent?.textOverlayCount ||
    recordedViewportExitRequest?.abortSignalId !== cancellationSignalId ||
    recordedViewportExitRequest?.renderAttemptId !== renderAttemptId ||
    recordedViewportExitRequest?.documentKey !==
      invisibleCancellation?.documentKey ||
    recordedViewportExitRequest?.revision !== invisibleCancellation?.revision ||
    recordedViewportExitRequest?.page !== cancelledPage ||
    recordedViewportExitRequest?.pageDerivation !==
      "sole-visible-unsatisfied-page" ||
    recordedViewportExitRequest?.at !== viewportExitRequestEvent?.at ||
    recordedViewportExitRequest?.destinationPage !== 5 ||
    recordedViewportExitRequest?.visibleBeforeRequest !== true ||
    fallback?.workerFallbackEvent?.type !== "render-fallback" ||
    fallback?.noLateLowOverwrite !== true
  ) {
    fail("serialized fallback cancellation/retry evidence failed");
  }
  if (!validLongTasks(fallback?.longTasks)) {
    fail(`fallback recorded a Long Task over ${PDF_SHARPNESS_MAX_LONG_TASK_MS}ms`);
  }

  const network = evidence?.network;
  const networkTargets = Array.isArray(network?.targets) ? network.targets : [];
  const networkRequests = Array.isArray(network?.requests)
    ? network.requests
    : [];
  const nonPageRequests = Array.isArray(network?.nonPageRequests)
    ? network.nonPageRequests
    : [];
  const targetBootstrapSettlements = Array.isArray(
    network?.targetBootstrapSettlements,
  )
    ? network.targetBootstrapSettlements
    : [];
  const targetBySession = new Map(
    networkTargets.map((target) => [target?.sessionId, target]),
  );
  const normalPhaseIds = new Set(PDF_SHARPNESS_MATRIX.map(({ id }) => id));
  const documentWorker = (target) =>
    /pdf-document\.worker-[^/]+\.js(?:$|[?#])/u.test(target?.url ?? "");
  const parserWorker = (target) =>
    /pdf-parser\.worker-[^/]+\.js(?:$|[?#])/u.test(target?.url ?? "");
  const blobWrapper = (target) =>
    target?.phase === "forced-main-fallback" &&
    String(target?.url).startsWith("blob:");
  const targetChain = (target) => [target, ...(target?.ancestry ?? [])];
  const requestIdentity = (sessionId, requestId) =>
    `${sessionId ?? "page"}:${requestId}`;
  const requestByIdentity = new Map(
    networkRequests.map((request) => [
      requestIdentity(request?.sessionId, request?.requestId),
      request,
    ]),
  );
  const targetSetupComplete = (target) => {
    const expectedCommands = [
      "network-enable",
      "runtime-enable",
      "cache-disable",
      "auto-attach",
      ...(target?.waitingForDebugger === true ? ["resume"] : []),
    ];
    return (
      target?.attachComplete === true &&
      target?.resumed === true &&
      Array.isArray(target?.commands) &&
      target.commands.map(({ name }) => name).join(",") ===
        expectedCommands.join(",") &&
      target.commands.every(({ status }) => status === "completed")
    );
  };
  const validBootstrapSettlement = (settlement) => {
    const target = targetBySession.get(settlement?.targetSessionId);
    const request = requestByIdentity.get(
      requestIdentity(settlement?.requestSessionId, settlement?.requestId),
    );
    return (
      targetSetupComplete(target) &&
      target?.type === "worker" &&
      settlement?.targetType === "worker" &&
      settlement?.targetDetachedAtSettlement === false &&
      settlement?.targetId === target?.targetId &&
      settlement?.targetParentSessionId === target?.parentSessionId &&
      settlement?.phase === target?.phase &&
      settlement?.terminalReason === "target-attached" &&
      settlement?.method === "GET" &&
      settlement?.resourceType === "Script" &&
      request?.method === settlement.method &&
      request?.type === settlement.resourceType &&
      request?.phase === settlement.phase &&
      request?.sessionId === settlement.requestSessionId &&
      request?.url === settlement.url &&
      request?.bootstrapTargetSessionId === target?.sessionId &&
      target?.parentSessionId === request?.sessionId &&
      target?.url === request?.url &&
      target?.bootstrapRequestKey ===
        requestIdentity(request?.sessionId, request?.requestId)
    );
  };
  const computedCoverageTargets = {
    forcedBlobWrapper: networkTargets.filter(blobWrapper),
    forcedParserWorker: networkTargets.filter(
      (target) =>
        target?.phase === "forced-main-fallback" &&
        parserWorker(target) &&
        targetChain(target).some(blobWrapper),
    ),
    normalDocumentWorker: networkTargets.filter(
      (target) => normalPhaseIds.has(target?.phase) && documentWorker(target),
    ),
    normalParserWorker: networkTargets.filter(
      (target) =>
        normalPhaseIds.has(target?.phase) &&
        parserWorker(target) &&
        targetChain(target).some(documentWorker),
    ),
  };
  const bootstrapRequestIdentities = targetBootstrapSettlements.map(
    (settlement) => requestIdentity(
      settlement?.requestSessionId,
      settlement?.requestId,
    ),
  );
  const bootstrapTargetSessions = targetBootstrapSettlements.map(
    (settlement) => settlement?.targetSessionId,
  );
  const normalBootstrapTargets = [
    ...computedCoverageTargets.normalDocumentWorker,
    ...computedCoverageTargets.normalParserWorker,
  ];
  const bootstrapCoverageComplete =
    targetBootstrapSettlements.length > 0 &&
    targetBootstrapSettlements.every(validBootstrapSettlement) &&
    new Set(bootstrapRequestIdentities).size ===
      bootstrapRequestIdentities.length &&
    new Set(bootstrapTargetSessions).size === bootstrapTargetSessions.length &&
    normalBootstrapTargets.every((target) =>
      bootstrapTargetSessions.includes(target.sessionId),
    );
  const coverageTargets = network?.coverageTargets;
  const coverageNames = [
    "normalDocumentWorker",
    "normalParserWorker",
    "forcedBlobWrapper",
    "forcedParserWorker",
  ];
  const coverageComplete = coverageNames.every(
    (name) =>
      Array.isArray(coverageTargets?.[name]) &&
      coverageTargets[name].length > 0 &&
      coverageTargets[name].map(({ sessionId }) => sessionId).sort().join(",") ===
        computedCoverageTargets[name]
          .map(({ sessionId }) => sessionId)
          .sort()
          .join(","),
  );
  const requestCounts = network?.nonPageRequestCounts;
  const requestBelongsTo = (request, predicate) =>
    targetChain(targetBySession.get(request?.sessionId)).some(predicate);
  const computedRequestCounts = {
    forcedBlobWrapper: nonPageRequests.filter(
      (request) => requestBelongsTo(request, blobWrapper),
    ).length,
    forcedParserWorker: nonPageRequests.filter(
      (request) =>
        parserWorker(targetBySession.get(request?.sessionId)) &&
        requestBelongsTo(request, blobWrapper),
    ).length,
    normalDocumentWorker: nonPageRequests.filter(
      (request) =>
        normalPhaseIds.has(targetBySession.get(request?.sessionId)?.phase) &&
        requestBelongsTo(request, documentWorker),
    ).length,
    normalParserWorker: nonPageRequests.filter(
      (request) =>
        normalPhaseIds.has(targetBySession.get(request?.sessionId)?.phase) &&
        parserWorker(targetBySession.get(request?.sessionId)),
    ).length,
    total: nonPageRequests.length,
  };
  const requestCoverageComplete = [...coverageNames, "total"].every(
    (name) =>
      nonNegativeInteger(requestCounts?.[name]) &&
      requestCounts[name] > 0 &&
      requestCounts[name] === computedRequestCounts[name],
  );
  const matrixCoverage = network?.matrixCoverage;
  const matrixCoverageKeys = matrixCoverage &&
      typeof matrixCoverage === "object" &&
      !Array.isArray(matrixCoverage)
    ? Object.keys(matrixCoverage)
    : [];
  const matrixCoverageComplete =
    matrixCoverageKeys.join(",") === expectedIds.join(",") &&
    PDF_SHARPNESS_MATRIX.every(({ id }) => {
      const reported = matrixCoverage?.[id];
      const documentTargets = networkTargets.filter(
        (target) => target?.phase === id && documentWorker(target),
      );
      const parserTargets = networkTargets.filter(
        (target) =>
          target?.phase === id &&
          parserWorker(target) &&
          targetChain(target).some(documentWorker),
      );
      const documentRequestCount = nonPageRequests.filter(
        (request) =>
          targetBySession.get(request?.sessionId)?.phase === id &&
          requestBelongsTo(request, documentWorker),
      ).length;
      const parserRequestCount = nonPageRequests.filter(
        (request) =>
          targetBySession.get(request?.sessionId)?.phase === id &&
          parserWorker(targetBySession.get(request?.sessionId)) &&
          targetChain(targetBySession.get(request?.sessionId)).some(
            documentWorker,
          ),
      ).length;
      const documentBootstrapSettlementCount =
        targetBootstrapSettlements.filter((settlement) => {
          const target = targetBySession.get(settlement?.targetSessionId);
          return target?.phase === id && documentWorker(target);
        }).length;
      const parserBootstrapSettlementCount =
        targetBootstrapSettlements.filter((settlement) => {
          const target = targetBySession.get(settlement?.targetSessionId);
          return target?.phase === id && parserWorker(target);
        }).length;
      const sessionIds = (targets) =>
        targets.map(({ sessionId }) => sessionId).sort().join(",");
      return (
        documentTargets.length > 0 &&
        parserTargets.length > 0 &&
        documentRequestCount > 0 &&
        parserRequestCount > 0 &&
        documentBootstrapSettlementCount === documentTargets.length &&
        parserBootstrapSettlementCount === parserTargets.length &&
        Array.isArray(reported?.documentTargets) &&
        Array.isArray(reported?.parserTargets) &&
        sessionIds(reported.documentTargets) === sessionIds(documentTargets) &&
        sessionIds(reported.parserTargets) === sessionIds(parserTargets) &&
        reported?.documentBootstrapSettlementCount ===
          documentBootstrapSettlementCount &&
        reported?.documentRequestCount === documentRequestCount &&
        reported?.parserBootstrapSettlementCount ===
          parserBootstrapSettlementCount &&
        reported?.parserRequestCount === parserRequestCount
      );
    });
  const expectedFixedPointLabels = [
    ...PDF_SHARPNESS_MATRIX.map(({ id }) => id),
    "forced-main-fallback",
    "final-network-privacy",
  ];
  const fixedPoints = Array.isArray(network?.networkFixedPoints)
    ? network.networkFixedPoints
    : [];
  const finalFixedPoint = fixedPoints.at(-1);
  if (
    network?.sourceSha256 !== fixture?.sha256 ||
    network?.sourceStayedLocal !== true ||
    network?.serviceWorkerBypassed !== true ||
    network?.referenceScheme !== "file:" ||
    network?.sourceRequest !== null ||
    !nonNegativeInteger(network?.localRequestCount) ||
    network.localRequestCount === 0 ||
    !nonNegativeInteger(network?.completedRequestCount) ||
    network.completedRequestCount === 0 ||
    network?.inflightRequestCount !== 0 ||
    !emptyArray(network?.externalRequests) ||
    !emptyArray(network?.failures) ||
    !emptyArray(network?.attachErrors) ||
    !Array.isArray(network?.targets) ||
    network.targets.length === 0 ||
    network.targets.some(
      (target) =>
        !nonEmptyString(target?.sessionId) ||
        !nonEmptyString(target?.targetId) ||
        !nonEmptyString(target?.phase) ||
        !nonEmptyString(target?.type) ||
        typeof target?.url !== "string" ||
        !Array.isArray(target?.ancestry) ||
        !targetSetupComplete(target),
    ) ||
    !Array.isArray(network?.requests) ||
    network.requests.length !== network.localRequestCount ||
    network.requests.some(
      (request) =>
        !nonEmptyString(request?.method) ||
        !nonEmptyString(request?.phase) ||
        !nonEmptyString(request?.requestId) ||
        !nonEmptyString(request?.type) ||
        typeof request?.url !== "string" ||
        !(request?.sessionId === null || nonEmptyString(request.sessionId)),
    ) ||
    !Array.isArray(network?.nonPageRequests) ||
    network.nonPageRequests.length === 0 ||
    network.nonPageRequests.some(
      (request) =>
        !nonEmptyString(request?.sessionId) ||
        !nonEmptyString(request?.url),
    ) ||
    !nonNegativeInteger(requestCounts?.total) ||
    requestCounts.total !== network.nonPageRequests.length ||
    !coverageComplete ||
    !requestCoverageComplete ||
    !bootstrapCoverageComplete ||
    !matrixCoverageComplete ||
    !Array.isArray(network?.networkFixedPoints) ||
    fixedPoints.map(({ label }) => label).join(",") !==
      expectedFixedPointLabels.join(",") ||
    fixedPoints.some(
      (point) =>
        point?.attachErrorCount !== 0 ||
        point?.attachmentReady !== true ||
        !nonNegativeInteger(point?.attachPromiseCount) ||
        !nonNegativeInteger(point?.completedRequestCount) ||
        point.completedRequestCount === 0 ||
        point?.inflightRequestCount !== 0 ||
        !nonNegativeInteger(point?.requestCount) ||
        point.requestCount === 0 ||
        point.completedRequestCount > point.requestCount ||
        !nonNegativeInteger(point?.targetCount) ||
        point.targetCount === 0 ||
        point.attachPromiseCount < point.targetCount ||
        !nonNegativeInteger(point?.targetBootstrapSettlementCount) ||
        point.targetBootstrapSettlementCount >
          targetBootstrapSettlements.length ||
        point?.pendingAttachCount !== 0 ||
        point?.serviceWorkerBypassed !== true,
    ) ||
    finalFixedPoint?.requestCount !== network.localRequestCount ||
    finalFixedPoint?.completedRequestCount !== network.completedRequestCount ||
    finalFixedPoint?.targetBootstrapSettlementCount !==
      targetBootstrapSettlements.length
  ) {
    fail("PDF source or recursively attached worker network evidence failed");
  }

  const artifacts = evidence?.artifacts;
  if (
    artifacts?.sourceCommit !== source?.commit ||
    artifacts?.sourceTree !== source?.tree ||
    artifacts?.deploymentId !== build?.localManifest?.deploymentId
  ) {
    fail("recorded artifacts are not bound to the exact source and deployment");
  }
  const screenshots = Array.isArray(artifacts?.screenshots)
    ? artifacts.screenshots
    : [];
  const expectedScreenshotEntries = [
    ...runs.flatMap((run) => [
      {
        artifact: run?.comparison?.referenceScreenshot,
        filename: `reference-${run?.id}.png`,
      },
      {
        artifact: run?.comparison?.lineLightScreenshot,
        filename: `linelight-${run?.id}.png`,
      },
    ]),
    {
      artifact: fallback?.artifact,
      filename: "fallback-visible-retry.png",
    },
  ];
  const expectedScreenshotArtifacts = expectedScreenshotEntries.map(
    ({ artifact }) => artifact,
  );
  const exactExpectedFilenames = expectedScreenshotEntries.every(
    ({ artifact, filename }) =>
      artifactIsBound(artifact) && artifactBasename(artifact) === filename,
  );
  const screenshotPaths = screenshots.map((artifact) => artifact?.path);
  const uniqueScreenshotPaths =
    screenshotPaths.every(nonEmptyString) &&
    new Set(screenshotPaths).size === screenshotPaths.length;
  const exactManifestReferences = screenshots.every(
    (artifact, index) => {
      const expectedArtifact = expectedScreenshotArtifacts[index];
      return (
        artifact?.path === expectedArtifact?.path &&
        artifact?.bytes === expectedArtifact?.bytes &&
        artifact?.sha256 === expectedArtifact?.sha256
      );
    },
  );
  if (
    !Array.isArray(artifacts?.screenshots) ||
    screenshots.length !== expectedScreenshotArtifacts.length ||
    !exactExpectedFilenames ||
    !uniqueScreenshotPaths ||
    !exactManifestReferences
  ) {
    fail("artifact manifest does not exactly enumerate the reviewed screenshots");
  }
  for (const artifact of screenshots) {
    if (!artifactIsBound(artifact)) fail("a screenshot artifact is not SHA-256-bound");
  }
  const teardown = evidence?.teardown;
  if (
    !emptyArray(teardown?.errors) ||
    teardown?.app?.present !== true ||
    teardown?.app?.cdpPresent !== true ||
    teardown?.app?.cdpClosed !== true ||
    teardown?.app?.processClosed !== true ||
    teardown?.app?.profileRemoved !== true ||
    teardown?.app?.error !== null ||
    teardown?.reference?.present !== true ||
    teardown?.reference?.cdpPresent !== true ||
    teardown?.reference?.cdpClosed !== true ||
    teardown?.reference?.processClosed !== true ||
    teardown?.reference?.profileRemoved !== true ||
    teardown?.reference?.error !== null ||
    teardown?.server?.present !== true ||
    teardown?.server?.processClosed !== true ||
    teardown?.server?.error !== null ||
    teardown?.cdpClosed !== true ||
    teardown?.browserClosed !== true ||
    teardown?.referenceBrowserClosed !== true ||
    teardown?.serverClosed !== true ||
    teardown?.profilesRemoved !== true
  ) {
    fail("owned browser/server/CDP resources did not tear down cleanly");
  }

  return failures;
}
