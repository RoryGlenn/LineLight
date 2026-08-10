export const PDF_SHARPNESS_SCHEMA_VERSION = 1;
export const PDF_SHARPNESS_MAX_LONG_TASK_MS = 50;
export const PDF_SHARPNESS_PREVIEW_SCALE = 1.25;
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

function artifactIsBound(artifact) {
  return (
    artifact &&
    nonEmptyString(artifact.path) &&
    nonNegativeInteger(artifact.bytes) &&
    artifact.bytes > 0 &&
    SHA256_PATTERN.test(artifact.sha256 ?? "")
  );
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
  if (!sourceFiles.length) fail("source.files must bind reviewed files");
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
      !finite(preview?.scale) ||
      Number(preview.scale) <= 0 ||
      preview.scale > PDF_SHARPNESS_PREVIEW_SCALE + 1e-7 ||
      !finite(preview?.composedAt)
    ) {
      fail(`${expected.id} did not preserve the adjacent 1.25x preview policy`);
    }
    const sharp = run?.raster?.sharp;
    if (
      !finite(sharp?.actualWidth) ||
      !finite(sharp?.actualHeight) ||
      !finite(sharp?.targetWidth) ||
      !finite(sharp?.targetHeight) ||
      !finite(sharp?.targetScale) ||
      !finite(sharp?.composedAt) ||
      Number(sharp?.composedAt) <= Number(preview?.composedAt) ||
      !nonNegativeInteger(sharp?.actualWidth) ||
      !nonNegativeInteger(sharp?.actualHeight) ||
      !nonNegativeInteger(sharp?.targetWidth) ||
      !nonNegativeInteger(sharp?.targetHeight) ||
      sharp.actualWidth === 0 ||
      sharp.actualHeight === 0 ||
      sharp.actualWidth < sharp.targetWidth ||
      sharp.actualHeight < sharp.targetHeight ||
      typeof sharp?.targetCapped !== "boolean" ||
      sharp.actualWidth > PDF_SHARPNESS_MAX_RASTER_DIMENSION ||
      sharp.actualHeight > PDF_SHARPNESS_MAX_RASTER_DIMENSION ||
      sharp.actualWidth * sharp.actualHeight > PDF_SHARPNESS_MAX_RASTER_PIXELS
    ) {
      fail(`${expected.id} sharp backing did not reach its computed capped target`);
    }
    if (
      sharp?.source !== "worker-bitmap" ||
      run?.raster?.previewBeforeSharp !== true ||
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
    if (
      run?.release?.shellRetained !== true ||
      run?.release?.textOverlayRetained !== true
    ) {
      fail(`${expected.id} did not retain its offscreen text/highlight shell`);
    }
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
  const continuationDelayEvent = stagingEvents.find(
    (event) =>
      event?.type === "continuation-delay" &&
      event?.renderAttemptId === renderAttemptId,
  );
  const viewportExitEvent = stagingEvents.find(
    (event) =>
      event?.type === "viewport-exit" &&
      event?.renderAttemptId === renderAttemptId,
  );
  const continuationResumeEvent = stagingEvents.find(
    (event) =>
      event?.type === "continuation-resume" &&
      event?.renderAttemptId === renderAttemptId,
  );
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
  const matchingIdentity = [
    cancelledStagingStart,
    continuationDelayEvent,
    viewportExitEvent,
    continuationResumeEvent,
  ].every(
    (event) =>
      event?.renderAttemptId === renderAttemptId &&
      event?.page === cancelledPage &&
      event?.pageDerivation === "sole-visible-unsatisfied-page",
  );
  if (
    !artifactIsBound(fallback?.artifact) ||
    fallback?.signaledBeforeDocumentReady !== true ||
    fallback?.workerQueueClosed !== true ||
    fallback?.maximumConcurrentStaging !== 1 ||
    fallback?.injectedFailures !== 1 ||
    fallback?.importedSource?.sha256 !== fixture?.sha256 ||
    fallback?.importedSource?.size !== fixture?.bytes ||
    fallback?.retrySucceeded !== true ||
    !Number.isInteger(renderAttemptId) ||
    renderAttemptId < 1 ||
    cancelledPage !== 3 ||
    invisibleCancellation?.pageDerivation !==
      "sole-visible-unsatisfied-page" ||
    !matchingIdentity ||
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
    !finite(invisibleCancellation?.exitedAt) ||
    !finite(invisibleCancellation?.continuationResumeAt) ||
    !finite(invisibleCancellation?.continuationResumedAfterMs) ||
    invisibleCancellation.continuationResumedAfterMs < 950 ||
    invisibleCancellation.continuationDelayAt > invisibleCancellation.exitedAt ||
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
    viewportExitEvent?.at !== invisibleCancellation?.exitedAt ||
    continuationResumeEvent?.at !== invisibleCancellation?.continuationResumeAt ||
    continuationResumeEvent?.afterMs !==
      invisibleCancellation?.continuationResumedAfterMs ||
    viewportExitEvent?.visible !== false ||
    viewportExitEvent?.canvasPresent !== true ||
    viewportExitEvent?.canvasWidth !== 0 ||
    viewportExitEvent?.canvasHeight !== 0 ||
    !Number.isInteger(viewportExitEvent?.textOverlayCount) ||
    viewportExitEvent.textOverlayCount < 1 ||
    recordedViewportExit?.renderAttemptId !== renderAttemptId ||
    recordedViewportExit?.page !== cancelledPage ||
    recordedViewportExit?.pageDerivation !==
      "sole-visible-unsatisfied-page" ||
    recordedViewportExit?.at !== viewportExitEvent?.at ||
    recordedViewportExit?.visible !== viewportExitEvent?.visible ||
    recordedViewportExit?.canvasPresent !== viewportExitEvent?.canvasPresent ||
    recordedViewportExit?.canvasWidth !== viewportExitEvent?.canvasWidth ||
    recordedViewportExit?.canvasHeight !== viewportExitEvent?.canvasHeight ||
    recordedViewportExit?.textOverlayCount !== viewportExitEvent?.textOverlayCount ||
    fallback?.workerFallbackEvent?.type !== "render-fallback" ||
    fallback?.noLateLowOverwrite !== true
  ) {
    fail("serialized fallback cancellation/retry evidence failed");
  }
  if (!validLongTasks(fallback?.longTasks)) {
    fail(`fallback recorded a Long Task over ${PDF_SHARPNESS_MAX_LONG_TASK_MS}ms`);
  }

  if (
    evidence?.alignment?.passed !== true ||
    evidence?.alignment?.activeWordInsideHighlight !== true ||
    evidence?.alignment?.narrationAdvanced !== true ||
    !nonNegativeInteger(evidence?.alignment?.activeWordBefore) ||
    !nonNegativeInteger(evidence?.alignment?.activeWordAfter) ||
    evidence.alignment.activeWordAfter === evidence.alignment.activeWordBefore ||
    !nonNegativeInteger(evidence?.alignment?.highlightRectangles) ||
    evidence.alignment.highlightRectangles === 0 ||
    !Array.isArray(evidence?.alignment?.spoken) ||
    evidence.alignment.spoken.length === 0 ||
    evidence.alignment.spoken.some(
      (entry) =>
        !nonNegativeInteger(entry?.characters) ||
        entry.characters === 0 ||
        Object.hasOwn(entry ?? {}, "text"),
    )
  ) {
    fail("highlight/narration alignment evidence failed");
  }

  const network = evidence?.network;
  const networkTargets = Array.isArray(network?.targets) ? network.targets : [];
  const nonPageRequests = Array.isArray(network?.nonPageRequests)
    ? network.nonPageRequests
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
  const expectedFixedPointLabels = [
    ...PDF_SHARPNESS_MATRIX.map(({ id }) => id),
    "forced-main-fallback",
  ];
  if (
    network?.sourceSha256 !== fixture?.sha256 ||
    network?.sourceStayedLocal !== true ||
    network?.referenceScheme !== "file:" ||
    network?.sourceRequest !== null ||
    !nonNegativeInteger(network?.localRequestCount) ||
    network.localRequestCount === 0 ||
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
        !Array.isArray(target?.ancestry),
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
    !Array.isArray(network?.attachFixedPoints) ||
    network.attachFixedPoints.map(({ label }) => label).join(",") !==
      expectedFixedPointLabels.join(",") ||
    network.attachFixedPoints.some(
      (point) =>
        !nonNegativeInteger(point?.attachPromiseCount) ||
        !nonNegativeInteger(point?.targetCount) ||
        point.targetCount === 0 ||
        point.attachPromiseCount < point.targetCount ||
        point?.pendingAttachCount !== 0,
    )
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
  const expectedScreenshotHashes = [
    ...runs.flatMap((run) => [
      run?.comparison?.referenceScreenshot?.sha256,
      run?.comparison?.lineLightScreenshot?.sha256,
    ]),
    fallback?.artifact?.sha256,
  ];
  if (
    !Array.isArray(artifacts?.screenshots) ||
    screenshots.length !== expectedScreenshotHashes.length ||
    screenshots.map((artifact) => artifact?.sha256).join(",") !==
      expectedScreenshotHashes.join(",")
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
