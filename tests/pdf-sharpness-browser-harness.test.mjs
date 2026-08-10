import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { deflateSync } from "node:zlib";

import {
  PDF_SHARPNESS_MATRIX,
  PDF_SHARPNESS_MAX_BITMAP_COUNT,
  PDF_SHARPNESS_MAX_BITMAP_PIXELS,
  PDF_SHARPNESS_MAX_RASTER_PIXELS,
  PDF_SHARPNESS_SCHEMA_VERSION,
  PDF_SHARPNESS_SOURCE_FILES,
  validatePdfSharpnessEvidence,
} from "../scripts/pdf-sharpness-evidence.mjs";
import {
  FALLBACK_IMPORT_DIAGNOSTIC_STAGES,
  FALLBACK_IMPORT_DIAGNOSTIC_STEPS,
  REFERENCE_CAPTURE_DIAGNOSTIC_CANDIDATES,
  REFERENCE_CAPTURE_DIAGNOSTIC_CONFIGURATIONS,
  REFERENCE_CAPTURE_DIAGNOSTIC_STAGES,
  REFERENCE_CAPTURE_DIAGNOSTIC_STEPS,
  analyzeReferencePixels,
  analyzeReferenceTarget,
  asyncBrowserExpression,
  advanceCdpFixedPointStability,
  buildCdpNetworkFixedPointDiagnostic,
  buildFallbackWorkerModuleSource,
  buildFallbackImportDiagnosticReport,
  buildFirstNetworkDiagnosticReport,
  buildReferenceCaptureDiagnosticReport,
  classifyCdpDiagnosticUrl,
  classifyPdfRasterTransition,
  completeCdpNetworkRequest,
  createFallbackImportDiagnosticProgress,
  createReferenceCaptureDiagnosticProgress,
  decodePngScreenshot,
  dispatchPausedServiceWorkerCommands,
  dispatchToCdpSession,
  hasCdpPhasePdfBootstrapCoverage,
  isCdpAttachmentStateHealthy,
  isCdpFixedPointDiagnosticHealthy,
  isFallbackImportNetworkDiagnosticHealthy,
  isCdpServiceWorkerBootstrapRequest,
  isCdpTargetBootstrapRequest,
  isCdpTargetSetupComplete,
  matchesPdfFallbackInjection,
  markFallbackImportDiagnosticStage,
  markReferenceCaptureDiagnosticStage,
  navigateReferenceCaptureDiagnosticPage,
  planPdfVirtualScroll,
  probePdfBitmapBudget,
  recordCdpNetworkRequest,
  reconcileCdpServiceWorkerBootstraps,
  reconcileCdpTargetBootstrapRequests,
  referenceViewportContract,
  runBoundedDiagnosticOperation,
  selectPdfLongTasksForWindow,
  selectPdfFallbackAbortCandidate,
  selectPdfFallbackScenarioEvents,
  sendToCdpSession,
  settleCdpCommandDispatches,
  summarizePdfFallbackCancellationDiagnostic,
  summarizePdfModelCompletion,
  summarizeFallbackImportLifecycle,
  summarizeFallbackDiagnosticProgress,
  summarizeFallbackDiagnosticSetup,
  validateCdpInitialTargetBaseline,
} from
  "../scripts/run-pdf-sharpness-browser-regression.mjs";

const execFileAsync = promisify(execFile);
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const SHA = "c".repeat(64);
const DEPLOYMENT = "issue-68-test-deployment";
const diagnosticIdentity = (...parts) => createHash("sha256")
  .update(JSON.stringify(parts))
  .digest("hex");
const DOCUMENT_KEY = "issue-68-document:issue-68-revision";
const REVISION = "issue-68-revision";
const FAILED_ABORT_SIGNAL_ID = 1;
const RETRY_ABORT_SIGNAL_ID = 2;
const CANCELLATION_ABORT_SIGNAL_ID = 3;
const passingFallbackDiagnosticProgress = () => ({
  history: [...FALLBACK_IMPORT_DIAGNOSTIC_STAGES],
  terminalStage: FALLBACK_IMPORT_DIAGNOSTIC_STAGES.at(-1),
});
const completedCdpTargetSetup = ({
  cdpIdStart = 1,
  serviceWorker = false,
  startedAt = 10,
} = {}) => {
  const dispatchTimes = serviceWorker
    ? [startedAt, startedAt + 1, startedAt + 2, startedAt + 3, startedAt + 4]
    : [startedAt, startedAt + 1, startedAt + 4, startedAt + 6, startedAt + 8];
  const resultTimes = serviceWorker
    ? [startedAt + 6, startedAt + 7, startedAt + 8, startedAt + 9,
      startedAt + 5]
    : [startedAt + 2, startedAt + 3, startedAt + 5, startedAt + 7,
      startedAt + 9];
  const resultOrder = serviceWorker ? [2, 3, 4, 5, 1] : [1, 2, 3, 4, 5];
  const deadlineAt = serviceWorker ? startedAt + 100 : null;
  const definitions = [
    ["network-enable", "Network.enable"],
    ["runtime-enable", "Runtime.enable"],
    ["cache-disable", "Network.setCacheDisabled"],
    ["auto-attach", "Target.setAutoAttach"],
    ["resume", "Runtime.runIfWaitingForDebugger"],
  ];
  return {
    commandDeadlineAt: deadlineAt,
    commands: definitions.map(([name, method], index) => ({
      cdpId: cdpIdStart + index,
      deadlineAt,
      dispatchedAt: dispatchTimes[index],
      dispatchSequence: index + 1,
      method,
      name,
      resultAt: resultTimes[index],
      resultSequence: resultOrder[index],
      status: "completed",
    })),
    lifecycleStrategy: serviceWorker
      ? "setup-dispatched-before-resume"
      : "setup-completed-before-resume",
    resumeDispatchedAt: dispatchTimes[4],
  };
};
const PUBLIC_PDF_FIXTURE =
  "tests/fixtures/pdf-highlights/issue-60-geometry.pdf";
const PUBLIC_PDF_FIXTURE_BYTES = 4_745;
const PUBLIC_PDF_FIXTURE_SHA256 =
  "1addfceae4b869eec37dae4755d576ccd0fd7e1ce505dc856da3b96acbf3f06c";

const passingReferenceDiagnosticSource = () => ({
  commit: COMMIT,
  files: Object.fromEntries(
    PDF_SHARPNESS_SOURCE_FILES.map((file) => [file, SHA]),
  ),
  postCaptureCommit: COMMIT,
  postCaptureStatus: [],
  postCaptureTree: TREE,
  preflightStatus: [],
  tree: TREE,
});

const passingReferenceAnalysis = () => ({
  height: 900,
  inkPixels: 9_106,
  inkRatio: 0.014523125996810207,
  inkRowBands: 4,
  inkSpanRatio: 0.6855263157894737,
  pageBounds: { height: 841, width: 774, x: 306, y: 59 },
  pagePixels: 627_000,
  pageWhitePixels: 614_930,
  pageWhiteRatio: 0.980749601275917,
  proof: "white-page-with-rendered-ink",
  renderedPage: true,
  runnerUpWhiteArea: 14_947,
  segmentationVersion: 2,
  substantialComponents: [{
    pageBounds: { height: 841, width: 774, x: 306, y: 59 },
    whiteArea: 637_220,
  }],
  substantialComponentCount: 1,
  width: 1_100,
  winnerDominanceRatio: 42.63196628085903,
  winnerWhiteArea: 637_220,
});

const emptyReferenceAnalysis = (width, height) => ({
  height,
  inkPixels: 0,
  inkRatio: 0,
  inkRowBands: 0,
  inkSpanRatio: 0,
  pageBounds: null,
  pagePixels: 0,
  pageWhitePixels: 0,
  pageWhiteRatio: 0,
  proof: "white-page-with-rendered-ink",
  renderedPage: false,
  runnerUpWhiteArea: 0,
  segmentationVersion: 2,
  substantialComponents: [],
  substantialComponentCount: 0,
  width,
  winnerDominanceRatio: null,
  winnerWhiteArea: 0,
});

const passingReferenceTarget = (
  analysis = passingReferenceAnalysis(),
  requestedPage = 2,
) => {
  const selected = analysis.substantialComponents[0];
  const cropWidth = selected.pageBounds.width;
  const cropHeight = selected.pageBounds.height;
  return {
    anchorLimit: Math.max(80, Math.ceil(analysis.height * 0.25)),
    components: analysis.substantialComponents.map((component) => ({
      bounds: { ...component.pageBounds },
      whiteArea: component.whiteArea,
    })),
    cropBounds: { ...selected.pageBounds },
    policy: "unique-top-anchored-substantial-component",
    readiness: {
      ...analysis,
      height: cropHeight,
      pageBounds: { height: cropHeight, width: cropWidth, x: 0, y: 0 },
      runnerUpWhiteArea: 0,
      substantialComponents: [{
        pageBounds: { height: cropHeight, width: cropWidth, x: 0, y: 0 },
        whiteArea: selected.whiteArea,
      }],
      width: cropWidth,
      winnerDominanceRatio: null,
    },
    requestedPage,
    selectedComponentIndex: 0,
    selectionVersion: 1,
    sourceHeight: analysis.height,
    sourceWidth: analysis.width,
  };
};

const emptyReferenceTarget = (analysis, requestedPage) => ({
  anchorLimit: Math.max(80, Math.ceil(analysis.height * 0.25)),
  components: [],
  cropBounds: null,
  policy: "unique-top-anchored-substantial-component",
  readiness: null,
  requestedPage,
  selectedComponentIndex: null,
  selectionVersion: 1,
  sourceHeight: analysis.height,
  sourceWidth: analysis.width,
});

const referenceViewport = ({ dpr, height, width }) => ({
  devicePixelRatio: dpr,
  innerHeight: height,
  innerWidth: width,
  screenHeight: height,
  screenWidth: width,
  visualViewportHeight: height,
  visualViewportScale: 1,
  visualViewportWidth: width,
});

const passingReferenceCaptureMechanics = ({ dpr, height, width }) => ({
  baseline: {
    checked: true,
    frameId: "fresh-main-frame",
    frameTreeMainOnly: true,
    frameUrlClass: "about-blank",
    locationClass: "about-blank",
    pageCount: 1,
    pageUrlClass: "about",
    readyStateComplete: true,
    targetCount: 1,
    workerCount: 0,
  },
  configuredViewport: referenceViewport({ dpr, height, width }),
  navigation: {
    dispatchSequence: 1,
    errorText: null,
    finalSequence: 4,
    frameId: "fresh-main-frame",
    isDownload: false,
    lifecycleLoad: {
      frameId: "fresh-main-frame",
      loaderId: "new-pdf-loader",
      name: "load",
      sequence: 2,
    },
    loadEvent: { sequence: 3 },
    loaderId: "new-pdf-loader",
    newDocument: true,
    responseSequence: 4,
  },
  viewer: {
    contentType: "text/html",
    pdfEmbedPresent: true,
    protocol: "chrome-extension:",
    readyStateComplete: true,
    viewport: referenceViewport({ dpr, height, width }),
  },
});

function artifact(name, digit) {
  return {
    bytes: 1024,
    path: `outputs/issue-68/${name}`,
    sha256: String(digit).repeat(64),
  };
}

function cleanDiagnosticTeardown() {
  return {
    app: {
      cdpClosed: true,
      error: null,
      present: true,
      processClosed: true,
      profileRemoved: true,
    },
    browserClosed: true,
    cdpClosed: true,
    errors: [],
    profilesRemoved: true,
    reference: {
      cdpClosed: true,
      error: null,
      present: false,
      processClosed: true,
      profileRemoved: true,
    },
    referenceBrowserClosed: true,
    server: {
      error: null,
      present: true,
      processClosed: true,
    },
    serverClosed: true,
  };
}

function passingFallbackImportCapture() {
  const documentId = "pdf-current-public-fixture";
  const revision = "fallback-import-revision";
  const documentKey = `${documentId}:${revision}`;
  const jobId = 7;
  const workerInstanceId = 2;
  let eventId = 10;
  const event = (value) => ({
    at: eventId,
    eventId: eventId++,
    jobId,
    revision,
    workerInstanceId,
    ...value,
  });
  const workerEvents = [
    event({
      direction: "to-worker",
      documentKey,
      type: "import",
    }),
    event({
      direction: "from-worker",
      documentKey,
      pageCount: 6,
      pageNumber: 1,
      type: "page",
    }),
    event({ direction: "from-worker", type: "render-fallback" }),
    event({
      completedPages: 1,
      direction: "from-worker",
      pageCount: 6,
      type: "progress",
    }),
  ];
  for (let pageNumber = 2; pageNumber <= 6; pageNumber += 1) {
    workerEvents.push(
      event({
        direction: "from-worker",
        documentKey,
        pageCount: 6,
        pageNumber,
        type: "page",
      }),
      event({
        completedPages: pageNumber,
        direction: "from-worker",
        pageCount: 6,
        type: "progress",
      }),
    );
  }
  workerEvents.push(
    event({ direction: "from-worker", documentKey, pageCount: 6, type: "complete" }),
  );
  return {
    boundary: {
      sourceFileStart: 0,
      startedAt: 1,
      workerEventStart: 0,
      workerLifecycleStart: 0,
    },
    dom: {
      fallbackActive: true,
      fileInputDisabled: false,
      fileInputPresent: true,
      importDialogPresent: false,
      loadingPageCount: 0,
      mountedPageCount: 3,
      noticeCategory: "render-fallback",
      noticePresent: true,
      pageOneCanvasHeight: 990,
      pageOneCanvasSource: "main-fallback",
      pageOneCanvasWidth: 765,
      pageOnePresent: true,
      pageOneVisible: true,
      pageOneWordOverlayCount: 24,
      pageViewPresent: true,
    },
    libraryAfter: {
      activeDocumentIdentityHash: diagnosticIdentity(documentId),
      activeDocumentPresent: true,
      available: true,
      documentCount: 2,
      entryCount: 2,
      pageCount: 12,
      pdfEntryCount: 2,
      sourceCount: 2,
    },
    libraryBefore: {
      activeDocumentIdentityHash: diagnosticIdentity("pdf-restored-fixture"),
      activeDocumentPresent: true,
      available: true,
      documentCount: 1,
      entryCount: 1,
      pageCount: 6,
      pdfEntryCount: 1,
      sourceCount: 1,
    },
    importRequestObserved: true,
    networkBoundary: {
      attachPromiseCount: 3,
      requestCount: 10,
      settlementCount: 2,
      targetCount: 3,
    },
    outcome: "import-chain-reached",
    snapshot: {
      errors: [],
      fallback: { signalAt: 12 },
      notices: [{ at: 13, text: "OffscreenCanvas is unavailable; cooperative visible-page rendering." }],
      sourceFiles: [{
        at: 11,
        eventId: 1,
        sha256: PUBLIC_PDF_FIXTURE_SHA256,
        size: PUBLIC_PDF_FIXTURE_BYTES,
      }],
      workerEvents,
      workerLifecycle: [
        {
          at: 8,
          forceFallback: true,
          type: "constructed",
          urlClass: "pdf-document-worker",
          workerInstanceId,
          wrapped: true,
        },
        {
          at: 10,
          documentKey,
          jobId,
          messageType: "import",
          revision,
          type: "post-message",
          urlClass: "pdf-document-worker",
          workerInstanceId,
        },
        {
          at: 11,
          documentKey,
          jobId,
          messageType: "page",
          pageNumber: 1,
          revision,
          type: "first-message",
          urlClass: "pdf-document-worker",
          workerInstanceId,
        },
      ],
    },
  };
}

function passingFallbackNetworkDiagnostic() {
  const serviceWorker = {
    ancestry: [],
    attachComplete: true,
    ...completedCdpTargetSetup({ cdpIdStart: 10, serviceWorker: true }),
    identityHash: diagnosticIdentity(
      "service-worker-session",
      "service-worker-target",
    ),
    phase: "fallback-diagnostic-setup",
    resumed: true,
    sessionId: "service-worker-session",
    targetId: "service-worker-target",
    type: "service_worker",
    urlClass: "app-asset",
    waitingForDebugger: true,
  };
  const setupDocument = {
    ancestry: [],
    attachComplete: true,
    ...completedCdpTargetSetup({ cdpIdStart: 20 }),
    identityHash: diagnosticIdentity(
      "setup-document-session",
      "setup-document-target",
    ),
    parentSessionId: null,
    phase: "fallback-diagnostic-setup",
    resumed: true,
    sessionId: "setup-document-session",
    targetId: "setup-document-target",
    type: "worker",
    urlClass: "pdf-document-worker",
    waitingForDebugger: true,
  };
  const setupParser = {
    ancestry: [{
      phase: setupDocument.phase,
      sessionId: setupDocument.sessionId,
      type: setupDocument.type,
      urlClass: setupDocument.urlClass,
    }],
    attachComplete: true,
    ...completedCdpTargetSetup({ cdpIdStart: 30 }),
    identityHash: diagnosticIdentity(
      "setup-parser-session",
      "setup-parser-target",
    ),
    parentSessionId: setupDocument.sessionId,
    phase: "fallback-diagnostic-setup",
    resumed: true,
    sessionId: "setup-parser-session",
    targetId: "setup-parser-target",
    type: "worker",
    urlClass: "pdf-parser-worker",
    waitingForDebugger: true,
  };
  const oldTargets = [serviceWorker, setupDocument, setupParser];
  const blobTarget = {
    ancestry: [],
    attachComplete: true,
    ...completedCdpTargetSetup({ cdpIdStart: 50 }),
    identityHash: diagnosticIdentity("fallback-blob-session", "fallback-blob-target"),
    parentSessionId: null,
    phase: "fallback-import-diagnostic",
    resumed: true,
    sessionId: "fallback-blob-session",
    targetId: "fallback-blob-target",
    type: "worker",
    urlClass: "blob",
    waitingForDebugger: true,
  };
  const parserTarget = {
    ancestry: [{
      phase: "fallback-import-diagnostic",
      sessionId: blobTarget.sessionId,
      type: "worker",
      urlClass: "blob",
    }],
    attachComplete: true,
    ...completedCdpTargetSetup({ cdpIdStart: 60 }),
    identityHash: diagnosticIdentity("fallback-parser-session", "fallback-parser-target"),
    parentSessionId: blobTarget.sessionId,
    phase: "fallback-import-diagnostic",
    resumed: true,
    sessionId: "fallback-parser-session",
    targetId: "fallback-parser-target",
    type: "worker",
    urlClass: "pdf-parser-worker",
    waitingForDebugger: true,
  };
  const appWorkerTarget = {
    ancestry: [],
    attachComplete: true,
    ...completedCdpTargetSetup({ cdpIdStart: 70 }),
    identityHash: diagnosticIdentity(
      "fallback-app-worker-session",
      "fallback-app-worker-target",
    ),
    parentSessionId: null,
    phase: "fallback-import-diagnostic",
    resumed: true,
    sessionId: "fallback-app-worker-session",
    targetId: "fallback-app-worker-target",
    type: "worker",
    urlClass: "app-asset",
    waitingForDebugger: true,
  };
  blobTarget.workerInstanceId = 2;
  const targets = [...oldTargets, blobTarget, appWorkerTarget, parserTarget];
  const settlement = ({ requestId, requestSessionId, target }) => ({
    identityHash: diagnosticIdentity(
      requestSessionId,
      requestId,
      target.sessionId,
      target.targetId,
    ),
    method: "GET",
    phase: target.phase,
    requestId,
    requestSessionId,
    resourceType: "Script",
    targetDetachedAtSettlement: false,
    targetId: target.targetId,
    targetParentSessionId: target.parentSessionId,
    targetSessionId: target.sessionId,
    targetType: "worker",
    terminalReason: "target-attached",
    urlClass: target.urlClass,
  });
  const targetBootstrapSettlements = [
    settlement({
      requestId: "setup-document-request",
      requestSessionId: null,
      target: setupDocument,
    }),
    settlement({
      requestId: "setup-parser-request",
      requestSessionId: setupDocument.sessionId,
      target: setupParser,
    }),
    settlement({
      requestId: "fallback-blob-request",
      requestSessionId: null,
      target: blobTarget,
    }),
    settlement({
      requestId: "fallback-app-worker-request",
      requestSessionId: null,
      target: appWorkerTarget,
    }),
    settlement({
      requestId: "fallback-parser-request",
      requestSessionId: blobTarget.sessionId,
      target: parserTarget,
    }),
  ];
  return {
    attachErrors: [],
    counts: {
      attachErrorCount: 0,
      attachPromiseCount: targets.length,
      completedRequestCount: 20,
      externalRequestCount: 0,
      inflightRequestCount: 0,
      networkFailureCount: 0,
      pendingAttachCount: 0,
      requestCount: 20,
      serviceWorkerBootstrapObservationCount: 1,
      targetBootstrapSettlementCount: targetBootstrapSettlements.length,
      targetCount: targets.length,
    },
    inflightRequests: [],
    initialTargetBaseline: {
      checked: true,
      pageCount: 1,
      pageUrlClass: "about",
      targetCount: 1,
      workerCount: 0,
    },
    label: "fallback-import-diagnostic",
    outcome: "fixed-point-reached",
    pendingAttaches: [],
    serviceWorkerBypassed: true,
    serviceWorkerBootstrapObservations: [{
      identityHash: diagnosticIdentity(
        serviceWorker.sessionId,
        "service-worker-request",
        serviceWorker.sessionId,
        serviceWorker.targetId,
      ),
      earlierRequestCount: 0,
      method: "GET",
      phase: serviceWorker.phase,
      requestId: "service-worker-request",
      requestIsFirst: true,
      requestSequence: 1,
      requestSessionId: serviceWorker.sessionId,
      requestStartedAt: serviceWorker.resumeDispatchedAt + 1,
      resourceType: "Script",
      resumeDispatchedAt: serviceWorker.resumeDispatchedAt,
      sessionFailureCount: 0,
      sessionRequestCount: 1,
      targetDetachedAtObservation: false,
      targetId: serviceWorker.targetId,
      targetSessionId: serviceWorker.sessionId,
      targetType: "service_worker",
      targetUrlMatched: true,
      terminalAt: serviceWorker.resumeDispatchedAt + 2,
      terminalReason: "loading-finished",
      urlClass: serviceWorker.urlClass,
    }],
    targetBootstrapSettlements,
    targets,
    wait: {
      recentSamples: [1, 2, 3].map((stableSamples) => ({
        attachErrorCount: 0,
        attachmentReady: true,
        incompleteTargetCount: 0,
        inflightRequestCount: 0,
        pendingAttachCount: 0,
        requestCount: 20,
        serviceWorkerBypassed: true,
        stableSamples,
        targetCount: targets.length,
      })),
      requiredStableSamples: 3,
      stableSamples: 3,
    },
  };
}

test("builds the forced fallback worker with one static dependency import", async () => {
  const source = buildFallbackWorkerModuleSource(
    "https://local.test/assets/pdf-document.worker.js",
    2,
  );
  const staticImport =
    'import "https://local.test/assets/pdf-document.worker.js";';
  assert.equal(source.split("\n")[0], staticImport);
  assert.equal(source.match(/^import\s+/gmu)?.length, 1);
  assert.doesNotMatch(source, /\bawait\s+import\s*\(/u);
  assert.doesNotMatch(source, /\bimport\s*\(/u);
  assert.match(source, /globalThis\.Worker = new Proxy\(NativeNestedWorker/u);
  assert.match(
    source,
    /const resolved = new URL\(url, "https:\/\/local\.test\/assets\/pdf-document\.worker\.js"\);/u,
  );
  assert.match(
    source,
    /Reflect\.construct\(target, \[resolved, \.\.\.rest\], newTarget\)/u,
  );
  const proxyBody = source.slice(
    source.indexOf("const NativeNestedWorker"),
    source.indexOf("try { Object.defineProperty"),
  );
  assert.doesNotMatch(proxyBody, /catch|ready|replay/u);
  assert.ok(
    source.indexOf("NativeNestedWorker") > source.indexOf(staticImport),
  );
  assert.ok(source.indexOf("OffscreenCanvas") > source.indexOf(staticImport));
  assert.ok(
    source.indexOf("__linelight_issue68_worker__") >
      source.indexOf("OffscreenCanvas"),
  );
  assert.match(source, /__linelight_issue68_worker__', 2\);/u);
  assert.throws(
    () => buildFallbackWorkerModuleSource("", 2),
    /Fallback worker identity is invalid/u,
  );
  assert.throws(
    () => buildFallbackWorkerModuleSource("https://local.test/worker.js", 0),
    /Fallback worker identity is invalid/u,
  );
  assert.throws(
    () => buildFallbackWorkerModuleSource("/relative-worker.js", 2),
    /Fallback worker identity is invalid/u,
  );

  const nativeFailure = new Error("native-constructor-sentinel");
  const zeroArgumentFailure = new Error("native-zero-argument-sentinel");
  class NativeWorker {
    static surface = "native-worker-surface";

    constructor(url, options) {
      if (arguments.length === 0) throw zeroArgumentFailure;
      if (url.pathname === "/native-failure.js") throw nativeFailure;
      this.options = options;
      this.url = url;
    }
  }
  const sentinelCalls = [];
  const context = {
    OffscreenCanvas: class OffscreenCanvas {},
    URL,
    Worker: NativeWorker,
    console: {
      debug: (...args) => sentinelCalls.push(args),
    },
  };
  runInNewContext(source.split("\n").slice(1).join("\n"), context);
  const WrappedWorker = context.Worker;
  const options = { type: "module" };
  const rootRelative = new WrappedWorker("/assets/pdf-parser.worker.js", options);
  const relative = new WrappedWorker("pdf-parser.worker.js", options);
  const absolute = new WrappedWorker("https://other.test/parser.js", options);
  const urlObject = new URL("https://third.test/parser.js");
  const fromUrlObject = new WrappedWorker(urlObject, options);
  assert.equal(rootRelative.url.href, "https://local.test/assets/pdf-parser.worker.js");
  assert.equal(relative.url.href, "https://local.test/assets/pdf-parser.worker.js");
  assert.equal(absolute.url.href, "https://other.test/parser.js");
  assert.equal(fromUrlObject.url.href, urlObject.href);
  assert.equal(rootRelative.options, options);
  assert.equal(WrappedWorker.surface, NativeWorker.surface);
  assert.equal(WrappedWorker.prototype, NativeWorker.prototype);
  assert.ok(rootRelative instanceof NativeWorker);
  assert.throws(() => WrappedWorker("/assets/parser.js"), TypeError);
  assert.throws(() => new WrappedWorker(), (error) => error === zeroArgumentFailure);
  assert.throws(
    () => new WrappedWorker("/native-failure.js"),
    (error) => error === nativeFailure,
  );
  class DerivedWorker extends WrappedWorker {}
  const derived = new DerivedWorker("/assets/derived-parser.js", options);
  assert.ok(derived instanceof DerivedWorker);
  assert.ok(derived instanceof NativeWorker);
  assert.equal(derived.url.href, "https://local.test/assets/derived-parser.js");
  assert.equal(context.OffscreenCanvas, undefined);
  assert.deepEqual(sentinelCalls, [["__linelight_issue68_worker__", 2]]);

  const runnerSource = await readFile(
    new URL("../scripts/run-pdf-sharpness-browser-regression.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    runnerSource,
    /const source = buildFallbackWorkerModuleSource\(\s*resolved,\s*workerInstanceId\s*\);/u,
  );
  assert.doesNotMatch(runnerSource, /await\s+import\s*\(/u);
});

test("binds fallback import completion to the exact post-change worker chain", () => {
  const capture = passingFallbackImportCapture();
  capture.snapshot.workerEvents.unshift({
    at: 5,
    direction: "to-worker",
    documentKey: "pdf-restored:restore-revision",
    eventId: 5,
    jobId: 6,
    revision: "restore-revision",
    type: "open",
    workerInstanceId: 1,
  });
  const summary = summarizeFallbackImportLifecycle(capture, {
    bytes: PUBLIC_PDF_FIXTURE_BYTES,
    sha256: PUBLIC_PDF_FIXTURE_SHA256,
  });
  assert.equal(summary.importCompleted, true);
  assert.equal(summary.importRequestCount, 1);
  assert.equal(summary.laterStartCount, 0);
  assert.deepEqual(summary.chain.pageNumbers, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(summary.chain.progressPages, [1, 2, 3, 4, 5, 6]);
  assert.equal(summary.worker.wrapped, true);
  assert.equal(summary.worker.postBound, true);
  assert.equal(summary.dom.pageOneWordOverlayCount, 24);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /fallback-import-revision/u);
  assert.doesNotMatch(serialized, /pdf-current-public-fixture/u);
});

test("binds one wrapped import post to six pages and its exact parser child", () => {
  const capture = passingFallbackImportCapture();
  const summary = summarizeFallbackImportLifecycle(capture, {
    bytes: PUBLIC_PDF_FIXTURE_BYTES,
    sha256: PUBLIC_PDF_FIXTURE_SHA256,
  });
  const network = passingFallbackNetworkDiagnostic();
  const importBlob = network.targets.find(
    (target) => target.urlClass === "blob" && target.workerInstanceId === 2,
  );
  const importParsers = network.targets.filter(
    (target) =>
      target.urlClass === "pdf-parser-worker" &&
      target.parentSessionId === importBlob?.sessionId,
  );
  const importPosts = capture.snapshot.workerLifecycle.filter(
    (event) =>
      event.type === "post-message" &&
      event.messageType === "import" &&
      event.workerInstanceId === summary.importIdentity.workerInstanceId,
  );

  assert.equal(summary.importCompleted, true);
  assert.equal(summary.importRequestCount, 1);
  assert.equal(importPosts.length, 1);
  assert.equal(summary.worker.firstMessageType, "page");
  assert.equal(summary.chain.pageEventCount, 6);
  assert.deepEqual(summary.chain.pageNumbers, [1, 2, 3, 4, 5, 6]);
  assert.equal(summary.chain.progressEventCount, 6);
  assert.deepEqual(summary.chain.progressPages, [1, 2, 3, 4, 5, 6]);
  assert.equal(summary.chain.fallbackEventCount, 1);
  assert.equal(summary.chain.completeEventCount, 1);
  assert.equal(summary.laterStartCount, 0);
  assert.equal(importParsers.length, 1);
  assert.equal(
    isFallbackImportNetworkDiagnosticHealthy(
      network,
      capture.networkBoundary,
      summary.importIdentity.workerInstanceId,
    ),
    true,
  );
});

test("fallback import lifecycle mutations fail closed", () => {
  const mutations = [
    (capture) => {
      capture.snapshot.workerEvents.push({
        at: 100,
        direction: "to-worker",
        documentKey: "restored-late:late-revision",
        eventId: 100,
        jobId: 8,
        revision: "late-revision",
        type: "open",
      });
    },
    (capture) => {
      capture.snapshot.workerEvents.find(
        (event) => event.type === "page" && event.pageNumber === 6,
      ).documentKey = "wrong-document:wrong-revision";
    },
    (capture) => {
      capture.snapshot.workerEvents.find(
        (event) => event.type === "progress" && event.completedPages === 6,
      ).revision = "stale-revision";
    },
    (capture) => {
      capture.snapshot.workerEvents.find(
        (event) => event.type === "complete",
      ).documentKey = "wrong-document:wrong-revision";
    },
    (capture) => {
      capture.snapshot.workerEvents = capture.snapshot.workerEvents.filter(
        (event) => event.type !== "render-fallback",
      );
    },
    (capture) => {
      capture.snapshot.sourceFiles[0].sha256 = "d".repeat(64);
    },
    (capture) => {
      capture.snapshot.workerLifecycle.push({
        category: "worker-error",
        type: "error",
        workerInstanceId: 2,
      });
    },
    (capture) => {
      capture.snapshot.workerLifecycle.push({
        at: 12,
        type: "terminated",
        workerInstanceId: 2,
      });
    },
    (capture) => {
      capture.libraryAfter.activeDocumentIdentityHash =
        capture.libraryBefore.activeDocumentIdentityHash;
    },
    (capture) => {
      capture.dom.fallbackActive = false;
    },
    (capture) => {
      capture.dom.pageOneWordOverlayCount = 0;
    },
    (capture) => {
      capture.outcome = "import-request-timeout";
    },
    (capture) => {
      capture.importRequestObserved = false;
    },
    (capture) => {
      capture.snapshot.workerLifecycle.push(
        structuredClone(capture.snapshot.workerLifecycle[0]),
      );
    },
    (capture) => {
      capture.snapshot.workerLifecycle = capture.snapshot.workerLifecycle.filter(
        (event) => event.type !== "post-message",
      );
    },
    (capture) => {
      capture.snapshot.workerLifecycle.push(
        structuredClone(
          capture.snapshot.workerLifecycle.find(
            (event) => event.type === "post-message",
          ),
        ),
      );
    },
    (capture) => {
      capture.snapshot.workerLifecycle = capture.snapshot.workerLifecycle.filter(
        (event) => event.type !== "first-message",
      );
    },
    (capture) => {
      capture.snapshot.workerLifecycle.push(
        structuredClone(
          capture.snapshot.workerLifecycle.find(
            (event) => event.type === "first-message",
          ),
        ),
      );
    },
    (capture) => {
      capture.snapshot.workerLifecycle.find(
        (event) => event.type === "first-message",
      ).workerInstanceId = 99;
    },
    (capture) => {
      capture.snapshot.workerLifecycle.find(
        (event) => event.type === "first-message",
      ).jobId = 99;
    },
    (capture) => {
      capture.snapshot.workerLifecycle.find(
        (event) => event.type === "first-message",
      ).revision = "wrong-revision";
    },
    (capture) => {
      capture.snapshot.workerLifecycle.find(
        (event) => event.type === "first-message",
      ).documentKey = "wrong-document:wrong-revision";
    },
    (capture) => {
      capture.snapshot.workerLifecycle.find(
        (event) => event.type === "first-message",
      ).at = 9;
    },
    (capture) => {
      capture.snapshot.workerLifecycle.find(
        (event) => event.type === "first-message",
      ).pageNumber = 2;
    },
    (capture) => {
      capture.dom.noticeCategory = "document-open-failed";
    },
    (capture) => {
      capture.dom.pageOneCanvasSource = null;
    },
    (capture) => {
      const duplicate = structuredClone(
        capture.snapshot.workerEvents.find(
          (event) => event.direction === "to-worker" && event.type === "import",
        ),
      );
      duplicate.at = 100;
      duplicate.eventId = 100;
      capture.snapshot.workerEvents.push(duplicate);
    },
    ...["page", "progress", "complete", "render-fallback"].map(
      (type) => (capture) => {
        const duplicate = structuredClone(
          capture.snapshot.workerEvents.find(
            (event) => event.direction === "from-worker" && event.type === type,
          ),
        );
        duplicate.at = 100;
        duplicate.eventId = 100;
        capture.snapshot.workerEvents.push(duplicate);
      },
    ),
    ...["page", "progress", "complete", "render-fallback"].map(
      (type) => (capture) => {
        capture.snapshot.workerEvents.find(
          (event) => event.type === type,
        ).workerInstanceId = 99;
      },
    ),
  ];
  for (const mutate of mutations) {
    const capture = passingFallbackImportCapture();
    mutate(capture);
    assert.equal(
      summarizeFallbackImportLifecycle(capture, {
        bytes: PUBLIC_PDF_FIXTURE_BYTES,
        sha256: PUBLIC_PDF_FIXTURE_SHA256,
      }).importCompleted,
      false,
    );
  }
});

test("requires a clean fallback blob/parser CDP lifecycle after the setup boundary", () => {
  const diagnostic = passingFallbackNetworkDiagnostic();
  const boundary = passingFallbackImportCapture().networkBoundary;
  assert.equal(
    diagnostic.targetBootstrapSettlements.some(
      (entry) =>
        entry.phase === "fallback-import-diagnostic" &&
        entry.urlClass === "app-asset",
    ),
    true,
  );
  assert.equal(
    isFallbackImportNetworkDiagnosticHealthy(diagnostic, boundary, 2),
    true,
  );
  const mutations = [
    (value) => { value.counts.attachErrorCount = 1; },
    (value) => { value.counts.inflightRequestCount = 1; },
    (value) => { value.counts.externalRequestCount = 1; },
    (value) => { value.targets.at(-1).attachComplete = false; },
    (value) => { value.targets.at(-1).parentSessionId = "wrong-parent"; },
    (value) => { value.targetBootstrapSettlements = []; },
    (value) => {
      const blobSettlement = value.targetBootstrapSettlements.find(
        (entry) => entry.urlClass === "blob",
      );
      value.targetBootstrapSettlements = value.targetBootstrapSettlements.filter(
        (entry) => entry !== blobSettlement,
      );
      value.counts.targetBootstrapSettlementCount -= 1;
    },
    (value) => {
      const blobSettlement = value.targetBootstrapSettlements.find(
        (entry) => entry.urlClass === "blob",
      );
      value.targetBootstrapSettlements.push(structuredClone(blobSettlement));
      value.counts.targetBootstrapSettlementCount += 1;
    },
    (value) => {
      const parserSettlement = value.targetBootstrapSettlements.find(
        (entry) =>
          entry.phase === "fallback-import-diagnostic" &&
          entry.urlClass === "pdf-parser-worker",
      );
      value.targetBootstrapSettlements = value.targetBootstrapSettlements.filter(
        (entry) => entry !== parserSettlement,
      );
      value.counts.targetBootstrapSettlementCount -= 1;
    },
    (value) => {
      const parserSettlement = value.targetBootstrapSettlements.find(
        (entry) =>
          entry.phase === "fallback-import-diagnostic" &&
          entry.urlClass === "pdf-parser-worker",
      );
      value.targetBootstrapSettlements.push(structuredClone(parserSettlement));
      value.counts.targetBootstrapSettlementCount += 1;
    },
    (value) => {
      const blobSettlement = value.targetBootstrapSettlements.find(
        (entry) => entry.urlClass === "blob",
      );
      blobSettlement.requestSessionId = "wrong-root-parent";
      blobSettlement.identityHash = diagnosticIdentity(
        blobSettlement.requestSessionId,
        blobSettlement.requestId,
        blobSettlement.targetSessionId,
        blobSettlement.targetId,
      );
    },
    (value) => {
      const blobSettlement = value.targetBootstrapSettlements.find(
        (entry) => entry.urlClass === "blob",
      );
      blobSettlement.targetSessionId = "wrong-blob-session";
      blobSettlement.identityHash = diagnosticIdentity(
        blobSettlement.requestSessionId,
        blobSettlement.requestId,
        blobSettlement.targetSessionId,
        blobSettlement.targetId,
      );
    },
    (value) => {
      const parserSettlement = value.targetBootstrapSettlements.find(
        (entry) => entry.urlClass === "pdf-parser-worker" &&
          entry.phase === "fallback-import-diagnostic",
      );
      parserSettlement.requestSessionId = "wrong-parser-parent";
      parserSettlement.targetParentSessionId = "wrong-parser-parent";
      parserSettlement.identityHash = diagnosticIdentity(
        parserSettlement.requestSessionId,
        parserSettlement.requestId,
        parserSettlement.targetSessionId,
        parserSettlement.targetId,
      );
    },
    (value) => {
      const blobSettlement = value.targetBootstrapSettlements.find(
        (entry) => entry.urlClass === "blob",
      );
      blobSettlement.targetId = "wrong-blob-target";
      blobSettlement.identityHash = diagnosticIdentity(
        blobSettlement.requestSessionId,
        blobSettlement.requestId,
        blobSettlement.targetSessionId,
        blobSettlement.targetId,
      );
    },
    (value) => {
      value.targetBootstrapSettlements.find(
        (entry) => entry.urlClass === "blob",
      ).urlClass = "pdf-document-worker";
    },
    (value) => {
      value.targets.find(
        (target) =>
          target.phase === "fallback-import-diagnostic" &&
          target.urlClass === "pdf-parser-worker",
      ).ancestry[0].sessionId = "forged-parser-ancestor";
    },
    (value) => {
      const appSettlement = value.targetBootstrapSettlements.find(
        (entry) =>
          entry.phase === "fallback-import-diagnostic" &&
          entry.urlClass === "app-asset",
      );
      appSettlement.identityHash = "0".repeat(64);
    },
    (value) => {
      const appSettlement = value.targetBootstrapSettlements.find(
        (entry) =>
          entry.phase === "fallback-import-diagnostic" &&
          entry.urlClass === "app-asset",
      );
      appSettlement.targetType = "service_worker";
    },
    (value) => {
      const appSettlement = value.targetBootstrapSettlements.find(
        (entry) =>
          entry.phase === "fallback-import-diagnostic" &&
          entry.urlClass === "app-asset",
      );
      appSettlement.phase = "wrong-phase";
    },
    (value) => {
      const appSettlement = value.targetBootstrapSettlements.find(
        (entry) =>
          entry.phase === "fallback-import-diagnostic" &&
          entry.urlClass === "app-asset",
      );
      appSettlement.method = "POST";
    },
    (value) => {
      const appSettlement = value.targetBootstrapSettlements.find(
        (entry) =>
          entry.phase === "fallback-import-diagnostic" &&
          entry.urlClass === "app-asset",
      );
      appSettlement.resourceType = "Other";
    },
    (value) => {
      const appSettlement = value.targetBootstrapSettlements.find(
        (entry) =>
          entry.phase === "fallback-import-diagnostic" &&
          entry.urlClass === "app-asset",
      );
      appSettlement.terminalReason = "loading-finished";
    },
    (value) => {
      const appSettlement = value.targetBootstrapSettlements.find(
        (entry) =>
          entry.phase === "fallback-import-diagnostic" &&
          entry.urlClass === "app-asset",
      );
      appSettlement.targetDetachedAtSettlement = true;
    },
    (value) => {
      const blobSettlement = value.targetBootstrapSettlements.find(
        (entry) => entry.urlClass === "blob",
      );
      const appSettlement = value.targetBootstrapSettlements.find(
        (entry) =>
          entry.phase === "fallback-import-diagnostic" &&
          entry.urlClass === "app-asset",
      );
      appSettlement.requestId = blobSettlement.requestId;
      appSettlement.identityHash = diagnosticIdentity(
        appSettlement.requestSessionId,
        appSettlement.requestId,
        appSettlement.targetSessionId,
        appSettlement.targetId,
      );
    },
    (value) => {
      value.targetBootstrapSettlements.push({
        ...structuredClone(value.targetBootstrapSettlements.at(-1)),
        identityHash: diagnosticIdentity(
          null,
          "orphan-request",
          "orphan-session",
          "orphan-target",
        ),
        requestId: "orphan-request",
        requestSessionId: null,
        targetId: "orphan-target",
        targetParentSessionId: null,
        targetSessionId: "orphan-session",
        urlClass: "blob",
      });
      value.counts.targetBootstrapSettlementCount += 1;
    },
    (value) => { value.targets = value.targets.filter((target) => target.urlClass !== "blob"); },
    (value) => { value.wait.stableSamples = 2; },
    (value) => { value.targets.at(-1).identityHash = "0".repeat(64); },
    (value) => { value.targets.at(-1).commands[0].dispatchSequence = 2; },
    (value) => { value.counts.targetCount += 1; },
    (value) => { value.serviceWorkerBootstrapObservations = []; },
    (value) => { value.initialTargetBaseline.workerCount = 1; },
    (value) => { value.targetBootstrapSettlements.at(-1).method = "POST"; },
    (value) => { value.wait.recentSamples.at(-1).requestCount -= 1; },
    (value) => { value.targets.find((target) => target.urlClass === "blob").workerInstanceId = null; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(diagnostic);
    mutate(value);
    assert.equal(
      isFallbackImportNetworkDiagnosticHealthy(value, boundary, 2),
      false,
    );
  }
  assert.equal(
    isFallbackImportNetworkDiagnosticHealthy(diagnostic, boundary, 3),
    false,
  );
  assert.equal(
    isFallbackImportNetworkDiagnosticHealthy(
      diagnostic,
      { ...boundary, targetCount: boundary.targetCount + 1 },
      2,
    ),
    false,
  );
  assert.equal(
    isFallbackImportNetworkDiagnosticHealthy(
      diagnostic,
      { ...boundary, settlementCount: boundary.settlementCount + 1 },
      2,
    ),
    false,
  );
});

test("rejects a fallback parser attached to a different wrapped worker", () => {
  const diagnostic = passingFallbackNetworkDiagnostic();
  const boundary = passingFallbackImportCapture().networkBoundary;
  const parserTarget = diagnostic.targets.find(
    (target) =>
      target.phase === "fallback-import-diagnostic" &&
      target.urlClass === "pdf-parser-worker",
  );
  const parserSettlement = diagnostic.targetBootstrapSettlements.find(
    (entry) =>
      entry.phase === "fallback-import-diagnostic" &&
      entry.urlClass === "pdf-parser-worker",
  );
  const restoredBlob = {
    ancestry: [],
    attachComplete: true,
    ...completedCdpTargetSetup({ cdpIdStart: 80 }),
    identityHash: diagnosticIdentity(
      "restored-blob-session",
      "restored-blob-target",
    ),
    parentSessionId: null,
    phase: "fallback-import-diagnostic",
    resumed: true,
    sessionId: "restored-blob-session",
    targetId: "restored-blob-target",
    type: "worker",
    urlClass: "blob",
    waitingForDebugger: true,
    workerInstanceId: 1,
  };
  diagnostic.targets.push(restoredBlob);
  parserTarget.parentSessionId = restoredBlob.sessionId;
  parserTarget.ancestry = [{
    phase: restoredBlob.phase,
    sessionId: restoredBlob.sessionId,
    type: restoredBlob.type,
    urlClass: restoredBlob.urlClass,
  }];
  parserSettlement.requestSessionId = restoredBlob.sessionId;
  parserSettlement.targetParentSessionId = restoredBlob.sessionId;
  parserSettlement.identityHash = diagnosticIdentity(
    parserSettlement.requestSessionId,
    parserSettlement.requestId,
    parserSettlement.targetSessionId,
    parserSettlement.targetId,
  );
  diagnostic.targetBootstrapSettlements.push({
    identityHash: diagnosticIdentity(
      null,
      "restored-blob-request",
      restoredBlob.sessionId,
      restoredBlob.targetId,
    ),
    method: "GET",
    phase: restoredBlob.phase,
    requestId: "restored-blob-request",
    requestSessionId: null,
    resourceType: "Script",
    targetDetachedAtSettlement: false,
    targetId: restoredBlob.targetId,
    targetParentSessionId: null,
    targetSessionId: restoredBlob.sessionId,
    targetType: "worker",
    terminalReason: "target-attached",
    urlClass: "blob",
  });
  diagnostic.counts.attachPromiseCount += 1;
  diagnostic.counts.completedRequestCount += 1;
  diagnostic.counts.requestCount += 1;
  diagnostic.counts.targetBootstrapSettlementCount += 1;
  diagnostic.counts.targetCount += 1;
  for (const sample of diagnostic.wait.recentSamples) {
    sample.requestCount += 1;
    sample.targetCount += 1;
  }

  assert.equal(
    isFallbackImportNetworkDiagnosticHealthy(diagnostic, boundary, 2),
    false,
  );
});

test("rejects a second parser child for the exact fallback import worker", () => {
  const diagnostic = passingFallbackNetworkDiagnostic();
  const boundary = passingFallbackImportCapture().networkBoundary;
  const importBlob = diagnostic.targets.find(
    (target) => target.urlClass === "blob" && target.workerInstanceId === 2,
  );
  const secondParser = {
    ancestry: [{
      phase: importBlob.phase,
      sessionId: importBlob.sessionId,
      type: importBlob.type,
      urlClass: importBlob.urlClass,
    }],
    attachComplete: true,
    ...completedCdpTargetSetup({ cdpIdStart: 90 }),
    identityHash: diagnosticIdentity(
      "second-parser-session",
      "second-parser-target",
    ),
    parentSessionId: importBlob.sessionId,
    phase: "fallback-import-diagnostic",
    resumed: true,
    sessionId: "second-parser-session",
    targetId: "second-parser-target",
    type: "worker",
    urlClass: "pdf-parser-worker",
    waitingForDebugger: true,
  };
  diagnostic.targets.push(secondParser);
  diagnostic.targetBootstrapSettlements.push({
    identityHash: diagnosticIdentity(
      importBlob.sessionId,
      "second-parser-request",
      secondParser.sessionId,
      secondParser.targetId,
    ),
    method: "GET",
    phase: secondParser.phase,
    requestId: "second-parser-request",
    requestSessionId: importBlob.sessionId,
    resourceType: "Script",
    targetDetachedAtSettlement: false,
    targetId: secondParser.targetId,
    targetParentSessionId: importBlob.sessionId,
    targetSessionId: secondParser.sessionId,
    targetType: "worker",
    terminalReason: "target-attached",
    urlClass: "pdf-parser-worker",
  });
  diagnostic.counts.attachPromiseCount += 1;
  diagnostic.counts.completedRequestCount += 1;
  diagnostic.counts.requestCount += 1;
  diagnostic.counts.targetBootstrapSettlementCount += 1;
  diagnostic.counts.targetCount += 1;
  for (const sample of diagnostic.wait.recentSamples) {
    sample.requestCount += 1;
    sample.targetCount += 1;
  }

  assert.equal(
    isFallbackImportNetworkDiagnosticHealthy(diagnostic, boundary, 2),
    false,
  );
});

test("builds a noncanonical privacy-safe reference-capture diagnostic", () => {
  const outputDirectory = path.join(
    os.tmpdir(),
    "issue-68-reference-capture-diagnostic",
  );
  const progress = createReferenceCaptureDiagnosticProgress();
  for (const stage of REFERENCE_CAPTURE_DIAGNOSTIC_STAGES) {
    markReferenceCaptureDiagnosticStage(progress, stage);
  }
  const candidates = REFERENCE_CAPTURE_DIAGNOSTIC_CANDIDATES.map(
    (name, index) => {
      const analysis = passingReferenceAnalysis();
      return {
        analysis,
        attempt: index + 4,
        bytes: 43_448,
        path: path.relative(path.resolve("."), path.join(outputDirectory, name)),
        referenceTarget: passingReferenceTarget(analysis, 2),
        sha256: "d".repeat(64),
      };
    },
  );
  const input = {
    capture: {
      ...passingReferenceCaptureMechanics({ dpr: 1, height: 900, width: 1_100 }),
      attempts: 5,
      candidates,
      captureErrorCount: 0,
      configurationId: PDF_SHARPNESS_MATRIX[0].id,
      referenceScheme: "file:",
      targetPage: 2,
    },
    fixture: {
      bytes: PUBLIC_PDF_FIXTURE_BYTES,
      path: PUBLIC_PDF_FIXTURE,
      sha256: PUBLIC_PDF_FIXTURE_SHA256,
    },
    outputDirectory,
    progress,
    recordedAt: "2026-08-10T00:00:00.000Z",
    referenceConfigurationId: PDF_SHARPNESS_MATRIX[0].id,
    runnerFailure: null,
    source: passingReferenceDiagnosticSource(),
    teardown: {
      errorCount: 0,
      reference: {
        cdpClosed: true,
        error: null,
        present: true,
        processClosed: true,
        profileRemoved: true,
      },
    },
  };
  const report = buildReferenceCaptureDiagnosticReport(input);
  assert.equal(report.diagnostic, true);
  assert.equal(report.diagnosticSchemaVersion, 2);
  assert.equal(report.completed, true);
  assert.equal(report.capture.stableByteIdentical, true);
  assert.equal(report.execution.sequenceComplete, true);
  assert.equal(report.mode, "reference-capture");
  assert.deepEqual(report.failures, []);
  assert.equal(report.artifacts.candidates.length, 2);
  assert.equal(report.artifacts.candidates[0].analysis.renderedPage, true);
  assert.deepEqual(
    report.artifacts.candidates.map(({ artifact: value }) => value.path),
    [...REFERENCE_CAPTURE_DIAGNOSTIC_CANDIDATES],
  );
  assert.equal("passed" in report, false);
  assert.equal("schemaVersion" in report, false);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(outputDirectory, "u"));
  assert.doesNotMatch(
    JSON.stringify(report),
    /fresh-main-frame|new-pdf-loader|chrome-extension:/u,
  );

  const mutations = [
    (value) => { value.fixture.bytes -= 1; },
    (value) => { value.source.files[PDF_SHARPNESS_SOURCE_FILES[0]] = null; },
    (value) => { value.source.postCaptureStatus = ["private/path.pdf"]; },
    (value) => { value.progress.history.pop(); },
    (value) => { value.referenceConfigurationId = "unknown-configuration"; },
    (value) => { value.capture.configurationId = "mobile-dpr3-zoom100"; },
    (value) => { value.capture.referenceScheme = "https:"; },
    (value) => { value.capture.targetPage = 3; },
    (value) => { value.capture.baseline.locationClass = "other"; },
    (value) => { value.capture.navigation.loaderId = ""; },
    (value) => { value.capture.navigation.frameId = "different-frame"; },
    (value) => { value.capture.navigation.isDownload = true; },
    (value) => { value.capture.navigation.errorText = "private path"; },
    (value) => { value.capture.navigation.newDocument = false; },
    (value) => { value.capture.navigation.loadEvent.sequence = 1; },
    (value) => {
      value.capture.navigation.lifecycleLoad.loaderId = "stale-loader";
    },
    (value) => {
      value.capture.navigation.lifecycleLoad.frameId = "stale-frame";
    },
    (value) => { value.capture.configuredViewport.devicePixelRatio = 2; },
    (value) => { value.capture.configuredViewport.innerWidth = 1; },
    (value) => { value.capture.configuredViewport.innerHeight = 2; },
    (value) => { value.capture.configuredViewport.visualViewportWidth = 3; },
    (value) => { value.capture.configuredViewport.visualViewportHeight = 4; },
    (value) => { value.capture.viewer.viewport.innerWidth = 1_099; },
    (value) => { value.capture.viewer.protocol = "https:"; },
    (value) => { value.capture.viewer.contentType = "text/plain"; },
    (value) => { value.capture.candidates.pop(); },
    (value) => { value.capture.captureErrorCount = value.capture.attempts - 1; },
    (value) => { value.capture.candidates[1].sha256 = "e".repeat(64); },
    (value) => { value.capture.candidates[1].analysis.inkPixels += 1; },
    (value) => {
      value.capture.candidates[1].referenceTarget.requestedPage += 1;
    },
    (value) => {
      value.capture.candidates[1].referenceTarget.components.push(
        structuredClone(
          value.capture.candidates[1].referenceTarget.components[0],
        ),
      );
    },
    (value) => {
      value.capture.candidates[1].referenceTarget.cropBounds.x += 1;
    },
    (value) => {
      value.capture.candidates[1].referenceTarget.readiness.inkPixels = 0;
    },
    (value) => {
      delete value.capture.candidates[1].analysis.segmentationVersion;
    },
    (value) => {
      value.capture.candidates[1].analysis.winnerDominanceRatio += 1;
    },
    (value) => { value.capture.candidates[1].attempt = 4; },
    (value) => { value.teardown.reference.profileRemoved = false; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(input);
    mutate(value);
    const failed = buildReferenceCaptureDiagnosticReport(value);
    assert.ok(failed.failures.length > 0);
    assert.equal(failed.completed, false);
  }

  const mobileObservation = structuredClone(input);
  mobileObservation.referenceConfigurationId = "mobile-dpr3-zoom100";
  Object.assign(mobileObservation.capture, {
    ...passingReferenceCaptureMechanics({ dpr: 3, height: 844, width: 390 }),
    configurationId: "mobile-dpr3-zoom100",
    targetPage: 3,
  });
  mobileObservation.capture.configuredViewport = {
    devicePixelRatio: 3,
    innerHeight: 2_121,
    innerWidth: 980,
    screenHeight: 844,
    screenWidth: 390,
    visualViewportHeight: 844,
    visualViewportScale: 1,
    visualViewportWidth: 390,
  };
  mobileObservation.capture.viewer.viewport = {
    devicePixelRatio: 3,
    innerHeight: 2_121,
    innerWidth: 980,
    screenHeight: 844,
    screenWidth: 390,
    visualViewportHeight: 844 * 980 / 390,
    visualViewportScale: 390 / 980,
    visualViewportWidth: 980,
  };
  for (const candidate of mobileObservation.capture.candidates) {
    candidate.analysis = emptyReferenceAnalysis(1_170, 2_532);
    candidate.referenceTarget = emptyReferenceTarget(candidate.analysis, 3);
  }
  const mobileReport = buildReferenceCaptureDiagnosticReport(
    mobileObservation,
  );
  assert.equal(mobileReport.completed, true);
  assert.deepEqual(mobileReport.failures, []);
  assert.equal(mobileReport.configuration.mobile, true);
  assert.equal(mobileReport.configuration.targetPage, 3);
  assert.equal(
    mobileReport.artifacts.candidates[0].analysis.renderedPage,
    false,
  );
  assert.equal(
    referenceViewportContract(
      {
        devicePixelRatio: 3,
        layoutHeight: 844,
        layoutWidth: 390,
        mobile: true,
        visualViewportScale: 1,
      },
      mobileObservation.capture.configuredViewport,
      mobileObservation.capture.viewer.viewport,
    ),
    true,
  );
  for (const field of [
    "innerWidth",
    "innerHeight",
    "visualViewportWidth",
    "visualViewportHeight",
  ]) {
    const forgedMobile = structuredClone(mobileObservation);
    forgedMobile.capture.configuredViewport[field] = 1;
    const failed = buildReferenceCaptureDiagnosticReport(forgedMobile);
    assert.equal(failed.completed, false);
    assert.ok(failed.failures.length > 0);
  }

  const forgedMobileLayout = structuredClone(mobileObservation);
  const forgedInnerWidth = 10_000;
  const forgedInnerHeight = forgedInnerWidth * 844 / 390;
  Object.assign(forgedMobileLayout.capture.configuredViewport, {
    innerHeight: forgedInnerHeight,
    innerWidth: forgedInnerWidth,
  });
  Object.assign(forgedMobileLayout.capture.viewer.viewport, {
    innerHeight: forgedInnerHeight,
    innerWidth: forgedInnerWidth,
    visualViewportHeight: forgedInnerHeight,
    visualViewportScale: 390 / forgedInnerWidth,
    visualViewportWidth: forgedInnerWidth,
  });
  const forgedMobileLayoutReport = buildReferenceCaptureDiagnosticReport(
    forgedMobileLayout,
  );
  assert.equal(forgedMobileLayoutReport.completed, false);
  assert.ok(forgedMobileLayoutReport.failures.length > 0);

  const fractionalMobileLayout = structuredClone(mobileObservation);
  fractionalMobileLayout.capture.configuredViewport.innerHeight += 0.5;
  fractionalMobileLayout.capture.viewer.viewport.innerHeight += 0.5;
  const fractionalMobileLayoutReport = buildReferenceCaptureDiagnosticReport(
    fractionalMobileLayout,
  );
  assert.equal(fractionalMobileLayoutReport.completed, false);
  assert.ok(fractionalMobileLayoutReport.failures.length > 0);

  const impossibleStableAnalyses = [
    (analysis) => {
      analysis.winnerWhiteArea = analysis.runnerUpWhiteArea;
      analysis.winnerDominanceRatio = 1;
    },
    (analysis) => {
      analysis.substantialComponentCount = 0;
      analysis.winnerWhiteArea = 0;
      analysis.runnerUpWhiteArea = 0;
      analysis.winnerDominanceRatio = null;
    },
    (analysis) => {
      analysis.inkRowBands = 1;
    },
  ];
  for (const mutate of impossibleStableAnalyses) {
    const value = structuredClone(input);
    for (const candidate of value.capture.candidates) {
      mutate(candidate.analysis);
    }
    const failed = buildReferenceCaptureDiagnosticReport(value);
    assert.equal(failed.completed, false);
    assert.ok(failed.failures.length > 0);
    assert.deepEqual(failed.artifacts.candidates, []);
  }

  const correlatedComponentOverflow = structuredClone(input);
  for (const candidate of correlatedComponentOverflow.capture.candidates) {
    const overflowComponent = {
      pageBounds: { height: 600, width: 1_000, x: 0, y: 250 },
      whiteArea: 500_000,
    };
    candidate.analysis.substantialComponents.push(overflowComponent);
    candidate.analysis.substantialComponentCount = 2;
    candidate.analysis.runnerUpWhiteArea = overflowComponent.whiteArea;
    candidate.analysis.winnerDominanceRatio =
      candidate.analysis.winnerWhiteArea / overflowComponent.whiteArea;
    candidate.referenceTarget = passingReferenceTarget(candidate.analysis, 2);
  }
  const componentOverflowReport = buildReferenceCaptureDiagnosticReport(
    correlatedComponentOverflow,
  );
  assert.equal(componentOverflowReport.completed, false);
  assert.ok(componentOverflowReport.failures.length > 0);
  assert.deepEqual(componentOverflowReport.artifacts.candidates, []);

  const impossibleConnectedComponentArea = structuredClone(input);
  for (const candidate of impossibleConnectedComponentArea.capture.candidates) {
    const impossibleComponent = {
      pageBounds: { height: 674, width: 300, x: 0, y: 226 },
      whiteArea: 1,
    };
    candidate.analysis.substantialComponents.push(impossibleComponent);
    candidate.analysis.substantialComponentCount = 2;
    candidate.analysis.runnerUpWhiteArea = impossibleComponent.whiteArea;
    candidate.analysis.winnerDominanceRatio =
      candidate.analysis.winnerWhiteArea / impossibleComponent.whiteArea;
    candidate.referenceTarget = passingReferenceTarget(candidate.analysis, 2);
  }
  const impossibleComponentReport = buildReferenceCaptureDiagnosticReport(
    impossibleConnectedComponentArea,
  );
  assert.equal(impossibleComponentReport.completed, false);
  assert.ok(impossibleComponentReport.failures.length > 0);
  assert.deepEqual(impossibleComponentReport.artifacts.candidates, []);

  const diagnosticRunnerMutations = [
    (candidate) => {
      const readiness = candidate.referenceTarget.readiness;
      const minimumWidth = Math.max(120, Math.ceil(readiness.width * 0.25));
      const minimumHeight = Math.max(80, Math.ceil(readiness.height * 0.25));
      const maximumNonSubstantial = Math.max(
        (minimumWidth - 1) * readiness.height,
        readiness.width * (minimumHeight - 1),
      );
      readiness.runnerUpWhiteArea = maximumNonSubstantial + 1;
      readiness.winnerDominanceRatio =
        readiness.winnerWhiteArea / readiness.runnerUpWhiteArea;
    },
    (candidate) => {
      const listed = {
        pageBounds: { height: 674, width: 600, x: 0, y: 226 },
        whiteArea: 200_000,
      };
      candidate.analysis.substantialComponents.push(listed);
      candidate.analysis.substantialComponentCount = 2;
      candidate.analysis.runnerUpWhiteArea = 1;
      candidate.analysis.winnerDominanceRatio =
        candidate.analysis.winnerWhiteArea;
      candidate.referenceTarget = passingReferenceTarget(candidate.analysis, 2);
    },
    (candidate) => {
      const tiedArea = 400_000;
      const tied = {
        pageBounds: { height: 674, width: 600, x: 0, y: 226 },
        whiteArea: tiedArea,
      };
      candidate.analysis.substantialComponents[0].whiteArea = tiedArea;
      candidate.analysis.substantialComponents.push(tied);
      candidate.analysis.substantialComponentCount = 2;
      candidate.analysis.winnerWhiteArea = tiedArea;
      candidate.analysis.runnerUpWhiteArea = 1;
      candidate.analysis.winnerDominanceRatio = tiedArea;
      candidate.analysis.pageWhitePixels = 350_000;
      candidate.analysis.pageWhiteRatio =
        candidate.analysis.pageWhitePixels / candidate.analysis.pagePixels;
      candidate.referenceTarget = passingReferenceTarget(candidate.analysis, 2);
    },
  ];
  for (const mutateRunner of diagnosticRunnerMutations) {
    const value = structuredClone(input);
    for (const candidate of value.capture.candidates) mutateRunner(candidate);
    const failed = buildReferenceCaptureDiagnosticReport(value);
    assert.equal(failed.completed, false);
    assert.ok(failed.failures.length > 0);
    assert.deepEqual(failed.artifacts.candidates, []);
  }

  const diagnosticDominanceIdentity = structuredClone(input);
  for (const candidate of diagnosticDominanceIdentity.capture.candidates) {
    candidate.analysis.winnerDominanceRatio += 5e-10;
  }
  const diagnosticDominanceReport = buildReferenceCaptureDiagnosticReport(
    diagnosticDominanceIdentity,
  );
  assert.equal(diagnosticDominanceReport.completed, false);
  assert.ok(diagnosticDominanceReport.failures.length > 0);
  assert.deepEqual(diagnosticDominanceReport.artifacts.candidates, []);

  for (const mutateTargetReadiness of [
    (readiness) => {
      const insetY = Math.max(2, Math.floor(readiness.pageBounds.height * 0.01));
      readiness.inkRowBands =
        Math.ceil((readiness.pageBounds.height - insetY * 2) / 3) + 1;
    },
    (readiness) => {
      readiness.inkPixels =
        readiness.pagePixels - readiness.pageWhitePixels + 1;
      readiness.inkRatio = readiness.inkPixels / readiness.pagePixels;
    },
    (readiness) => {
      readiness.inkSpanRatio = 0.6500001;
    },
    (readiness) => {
      readiness.pageWhitePixels =
        readiness.winnerWhiteArea -
          (readiness.pageBounds.width * readiness.pageBounds.height -
            readiness.pagePixels) - 1;
      readiness.pageWhiteRatio =
        readiness.pageWhitePixels / readiness.pagePixels;
    },
    (readiness) => {
      readiness.pageWhiteRatio += 5e-10;
    },
    (readiness) => {
      readiness.inkRatio += 5e-10;
    },
    (readiness) => {
      const insetX = Math.max(2, Math.floor(readiness.pageBounds.width * 0.01));
      const interiorWidth = readiness.pageBounds.width - insetX * 2;
      const spanPixels = Math.round(readiness.inkSpanRatio * interiorWidth);
      readiness.inkSpanRatio = (spanPixels + 5e-8) / interiorWidth;
    },
  ]) {
    const value = structuredClone(input);
    for (const candidate of value.capture.candidates) {
      mutateTargetReadiness(candidate.referenceTarget.readiness);
    }
    const failed = buildReferenceCaptureDiagnosticReport(value);
    assert.equal(failed.completed, false);
    assert.ok(failed.failures.length > 0);
    assert.deepEqual(failed.artifacts.candidates, []);
  }


  const diagnosticFalseInkStates = [
    () => ({ bands: 0, ink: 50, span: 0 }),
    () => ({ bands: 0, ink: 0, span: 1 }),
    ({ height }) => ({ bands: 0, ink: 2 * height + 1, span: 3 }),
    () => ({ bands: 2, ink: 6, span: 1 }),
    ({ height }) => ({
      bands: 2,
      ink: (height - 2) * 3 + 5,
      span: 3,
    }),
  ];
  for (const createInkState of diagnosticFalseInkStates) {
    const value = structuredClone(input);
    for (const candidate of value.capture.candidates) {
      const readiness = candidate.referenceTarget.readiness;
      const insetX = Math.max(2, Math.floor(readiness.pageBounds.width * 0.01));
      const insetY = Math.max(2, Math.floor(readiness.pageBounds.height * 0.01));
      const interiorWidth = readiness.pageBounds.width - insetX * 2;
      const interiorHeight = readiness.pageBounds.height - insetY * 2;
      const state = createInkState({ height: interiorHeight });
      readiness.inkPixels = state.ink;
      readiness.inkRatio = state.ink / readiness.pagePixels;
      readiness.inkRowBands = state.bands;
      readiness.inkSpanRatio = state.span / interiorWidth;
      readiness.renderedPage = false;
    }
    const failed = buildReferenceCaptureDiagnosticReport(value);
    assert.equal(failed.completed, false);
    assert.ok(failed.failures.length > 0);
    assert.deepEqual(failed.artifacts.candidates, []);
  }

  const tiedObservation = structuredClone(input);
  for (const candidate of tiedObservation.capture.candidates) {
    const components = [
      {
        pageBounds: { height: 300, width: 300, x: 100, y: 59 },
        whiteArea: 36_000,
      },
      {
        pageBounds: { height: 300, width: 300, x: 500, y: 100 },
        whiteArea: 36_000,
      },
    ];
    Object.assign(candidate.analysis, {
      inkPixels: 0,
      inkRatio: 0,
      inkRowBands: 0,
      inkSpanRatio: 0,
      pageBounds: null,
      pagePixels: 0,
      pageWhitePixels: 0,
      pageWhiteRatio: 0,
      renderedPage: false,
      runnerUpWhiteArea: 36_000,
      substantialComponents: components,
      substantialComponentCount: 2,
      winnerDominanceRatio: 1,
      winnerWhiteArea: 36_000,
    });
    candidate.referenceTarget = {
      anchorLimit: 225,
      components: components.map((component) => ({
        bounds: { ...component.pageBounds },
        whiteArea: component.whiteArea,
      })),
      cropBounds: null,
      policy: "unique-top-anchored-substantial-component",
      readiness: null,
      requestedPage: 2,
      selectedComponentIndex: null,
      selectionVersion: 1,
      sourceHeight: 900,
      sourceWidth: 1_100,
    };
  }
  const tiedReport = buildReferenceCaptureDiagnosticReport(tiedObservation);
  assert.equal(tiedReport.completed, true);
  assert.deepEqual(tiedReport.failures, []);
  assert.equal(
    tiedReport.artifacts.candidates[0].analysis.renderedPage,
    false,
  );

  const repositoryOutput = structuredClone(input);
  repositoryOutput.outputDirectory = path.join(
    path.resolve("."),
    "outputs/reference-diagnostic",
  );
  const repositoryReport = buildReferenceCaptureDiagnosticReport(
    repositoryOutput,
  );
  assert.equal(repositoryReport.completed, false);
  assert.ok(repositoryReport.failures.length > 0);

  const privateProfile = structuredClone(input);
  privateProfile.capture.profileDirectory =
    "/tmp/private-profile-secret-token";
  privateProfile.capture.candidates[0].referenceTarget.rawUrl =
    "file:///tmp/private.pdf?secret=token";
  const privateProfileBytes = JSON.stringify(
    buildReferenceCaptureDiagnosticReport(privateProfile),
  );
  assert.doesNotMatch(privateProfileBytes, /private-profile|private\.pdf|secret/u);

  const firstFailure = structuredClone(input);
  firstFailure.runnerFailure = new Error(
    "private /tmp/profile-a document paragraph secret=alpha",
  );
  firstFailure.progress.history = REFERENCE_CAPTURE_DIAGNOSTIC_STAGES.slice(
    0,
    9,
  );
  firstFailure.progress.terminalStage = firstFailure.progress.history.at(-1);
  const secondFailure = structuredClone(firstFailure);
  secondFailure.runnerFailure = new Error(
    "different https://example.test/?token=beta private text",
  );
  const firstBytes = JSON.stringify(
    buildReferenceCaptureDiagnosticReport(firstFailure),
  );
  const secondBytes = JSON.stringify(
    buildReferenceCaptureDiagnosticReport(secondFailure),
  );
  assert.equal(firstBytes, secondBytes);
  assert.doesNotMatch(
    firstBytes,
    /profile-a|paragraph|secret|example\.test|token=beta|private text/u,
  );
});

test("enforces the exact reference-capture diagnostic stage order", () => {
  const progress = createReferenceCaptureDiagnosticProgress();
  assert.equal(
    markReferenceCaptureDiagnosticStage(
      progress,
      REFERENCE_CAPTURE_DIAGNOSTIC_STAGES[0],
    ),
    REFERENCE_CAPTURE_DIAGNOSTIC_STAGES[0],
  );
  assert.throws(
    () => markReferenceCaptureDiagnosticStage(
      progress,
      REFERENCE_CAPTURE_DIAGNOSTIC_STAGES[2],
    ),
    /stage ordering is invalid/u,
  );
});

test("binds reference navigation to one new loader and both load signals", async () => {
  const listeners = new Map();
  const cdp = {
    on(method, listener) {
      listeners.set(method, listener);
    },
    send(method) {
      assert.equal(method, "Page.navigate");
      queueMicrotask(() => {
        listeners.get("Page.lifecycleEvent")?.({
          frameId: "fresh-main-frame",
          loaderId: "new-pdf-loader",
          name: "load",
        });
        listeners.get("Page.loadEventFired")?.({});
      });
      return Promise.resolve({
        frameId: "fresh-main-frame",
        loaderId: "new-pdf-loader",
      });
    },
  };
  const result = await navigateReferenceCaptureDiagnosticPage(
    cdp,
    "file:///public-fixture.pdf#page=3",
    100,
  );
  assert.equal(result.newDocument, true);
  assert.equal(result.lifecycleLoad.loaderId, result.loaderId);
  assert.equal(result.lifecycleLoad.frameId, result.frameId);
  assert.ok(result.lifecycleLoad.sequence > result.dispatchSequence);
  assert.ok(result.loadEvent.sequence > result.dispatchSequence);

  const staleListeners = new Map();
  const stale = {
    on(method, listener) {
      staleListeners.set(method, listener);
    },
    send() {
      queueMicrotask(() => {
        staleListeners.get("Page.lifecycleEvent")?.({
          frameId: "fresh-main-frame",
          loaderId: "stale-loader",
          name: "load",
        });
        staleListeners.get("Page.loadEventFired")?.({});
      });
      return Promise.resolve({
        frameId: "fresh-main-frame",
        loaderId: "new-pdf-loader",
      });
    },
  };
  await assert.rejects(
    navigateReferenceCaptureDiagnosticPage(
      stale,
      "file:///public-fixture.pdf#page=3",
      1,
    ),
    /new loader's load lifecycle/u,
  );
});

test("builds a noncanonical privacy-safe fallback import diagnostic", () => {
  const outputDirectory = path.join(os.tmpdir(), "issue-68-fallback-diagnostic");
  const capture = passingFallbackImportCapture();
  capture.screenshot = {
    ...artifact("linelight-fallback-import-diagnostic.png", 8),
    path: path.relative(
      path.resolve("."),
      path.join(outputDirectory, "linelight-fallback-import-diagnostic.png"),
    ),
  };
  const setupDocumentIdentity = capture.libraryBefore.activeDocumentIdentityHash;
  const input = {
    build: { localManifest: { deploymentId: DEPLOYMENT } },
    capture,
    diagnosticProgress: passingFallbackDiagnosticProgress(),
    fixture: {
      bytes: PUBLIC_PDF_FIXTURE_BYTES,
      path: PUBLIC_PDF_FIXTURE,
      sha256: PUBLIC_PDF_FIXTURE_SHA256,
    },
    networkDiagnostic: passingFallbackNetworkDiagnostic(),
    outputDirectory,
    recordedAt: "2026-08-10T00:00:00.000Z",
    runnerFailure: null,
    setup: {
      completeEventCount: 1,
      documentIdentityHash: setupDocumentIdentity,
      fileSelected: true,
      library: capture.libraryBefore,
      librarySnapshotCompleted: true,
      navigationCompleted: true,
      networkFixedPointReached: true,
      pageEventCount: 6,
      source: {
        bytes: PUBLIC_PDF_FIXTURE_BYTES,
        sha256: PUBLIC_PDF_FIXTURE_SHA256,
      },
      sourceSelectionCount: 1,
    },
    source: { commit: COMMIT, tree: TREE },
    teardown: cleanDiagnosticTeardown(),
  };
  const report = buildFallbackImportDiagnosticReport(input);
  assert.equal(report.diagnostic, true);
  assert.equal(report.completed, true);
  assert.equal(report.importCompleted, true);
  assert.equal(report.networkSettled, true);
  assert.equal(report.execution.sequenceComplete, true);
  assert.equal(report.execution.errorCategory, "none");
  assert.equal(report.mode, "fallback-import-lifecycle");
  assert.deepEqual(report.failures, []);
  assert.equal(report.setup.bound, true);
  assert.equal(
    report.artifacts.screenshots[0].path,
    "linelight-fallback-import-diagnostic.png",
  );
  assert.equal("passed" in report, false);
  assert.equal("schemaVersion" in report, false);

  const privateFailure = structuredClone(input);
  privateFailure.capture.snapshot.errors = [
    "private text /tmp/private-profile https://example.test/?token=secret",
  ];
  privateFailure.capture.snapshot.notices = [{
    text: "private paragraph from a local PDF",
  }];
  const privateReport = buildFallbackImportDiagnosticReport(privateFailure);
  const serialized = JSON.stringify(privateReport);
  assert.doesNotMatch(serialized, /private text|private-profile|token=secret|private paragraph/u);
  assert.doesNotMatch(serialized, /"passed"|"schemaVersion"/u);

  const mutations = [
    (value) => { value.fixture.bytes -= 1; },
    (value) => { value.setup.pageEventCount = 5; },
    (value) => { value.diagnosticProgress.history.pop(); },
    (value) => {
      value.diagnosticProgress.history[4] = "fallback-chain-started";
    },
    (value) => { value.capture.snapshot.fallback.signalAt = null; },
    (value) => { value.capture.screenshot.path = "substituted.png"; },
    (value) => { value.networkDiagnostic.counts.inflightRequestCount = 1; },
    (value) => { value.teardown.app.profileRemoved = false; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(input);
    mutate(value);
    const failed = buildFallbackImportDiagnosticReport(value);
    assert.ok(failed.failures.length > 0);
  }

  const firstRawFailure = structuredClone(input);
  firstRawFailure.runnerFailure = new Error(
    "private /tmp/first-profile?secret=alpha",
  );
  firstRawFailure.diagnosticProgress.history =
    FALLBACK_IMPORT_DIAGNOSTIC_STAGES.slice(0, 7);
  firstRawFailure.diagnosticProgress.terminalStage =
    FALLBACK_IMPORT_DIAGNOSTIC_STAGES[6];
  const secondRawFailure = structuredClone(firstRawFailure);
  secondRawFailure.runnerFailure = new Error(
    "different private document text https://example.test/?secret=beta",
  );
  const firstFailureBytes = JSON.stringify(
    buildFallbackImportDiagnosticReport(firstRawFailure),
  );
  const secondFailureBytes = JSON.stringify(
    buildFallbackImportDiagnosticReport(secondRawFailure),
  );
  assert.equal(firstFailureBytes, secondFailureBytes);
  assert.doesNotMatch(
    firstFailureBytes,
    /first-profile|secret|private document|example\.test/u,
  );
});

test("uses executable async browser evaluation for private library snapshots", async () => {
  const expression = asyncBrowserExpression(
    "return await Promise.resolve({ available: true });",
  );
  const execute = new Function(`return ${expression};`);
  assert.deepEqual(await execute(), { available: true });
  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  assert.match(
    source,
    /readPrivateLibraryDiagnostic[\s\S]*asyncBrowserExpression\(`/u,
  );
});

test("tracks exact fallback diagnostic stages and preserves partial setup facts", () => {
  const progress = createFallbackImportDiagnosticProgress();
  for (const stage of FALLBACK_IMPORT_DIAGNOSTIC_STAGES) {
    assert.equal(markFallbackImportDiagnosticStage(progress, stage), stage);
  }
  assert.deepEqual(
    summarizeFallbackDiagnosticProgress(progress, null),
    {
      errorCategory: "none",
      history: [...FALLBACK_IMPORT_DIAGNOSTIC_STAGES],
      sequenceComplete: true,
      terminalStage: FALLBACK_IMPORT_DIAGNOSTIC_STAGES.at(-1),
    },
  );
  assert.throws(
    () => markFallbackImportDiagnosticStage(
      createFallbackImportDiagnosticProgress(),
      "baseline-started",
    ),
    /stage ordering is invalid/u,
  );

  const partial = summarizeFallbackDiagnosticSetup({
    completeEventCount: 1,
    documentIdentityHash: "d".repeat(64),
    fileSelected: true,
    library: {
      activeDocumentIdentityHash: "private-local-id",
      activeDocumentPresent: true,
      available: true,
      documentCount: 1,
      entryCount: 1,
      pageCount: 6,
      pdfEntryCount: 1,
      sourceCount: 1,
    },
    librarySnapshotCompleted: true,
    navigationCompleted: true,
    networkFixedPointReached: false,
    pageEventCount: 6,
    source: {
      bytes: PUBLIC_PDF_FIXTURE_BYTES,
      sha256: "e".repeat(64),
    },
    sourceSelectionCount: 1,
  });
  assert.equal(partial.bound, false);
  assert.equal(partial.completeEventCount, 1);
  assert.equal(partial.pageEventCount, 6);
  assert.equal(partial.source.bytes, PUBLIC_PDF_FIXTURE_BYTES);
  assert.equal(partial.source.sha256, "e".repeat(64));
  assert.equal(partial.documentIdentityHash, "d".repeat(64));
  assert.equal(partial.library.activeDocumentIdentityHash, null);
  assert.deepEqual(partial.conditions, {
    fileSelected: true,
    libraryBound: false,
    librarySnapshotCompleted: true,
    modelBound: true,
    navigationCompleted: true,
    networkFixedPointReached: false,
    sourceBound: false,
  });
});

function passingCanonicalReference(configuration, targetPage, index) {
  const width = configuration.width * configuration.baseDevicePixelRatio;
  const height = configuration.height * configuration.baseDevicePixelRatio;
  const pageWidth = Math.floor(width * 0.6);
  const pageHeight = Math.floor(height * 0.7);
  const pageBounds = { height: pageHeight, width: pageWidth, x: 10, y: 10 };
  const winnerWhiteArea = Math.floor(pageWidth * pageHeight * 0.9);
  const insetX = Math.max(2, Math.floor(pageWidth * 0.01));
  const insetY = Math.max(2, Math.floor(pageHeight * 0.01));
  const pagePixels = (pageWidth - insetX * 2) * (pageHeight - insetY * 2);
  const pageWhitePixels = Math.floor(pagePixels * 0.9);
  const inkPixels = Math.max(100, Math.floor(pagePixels * 0.01));
  const interiorWidth = pageWidth - insetX * 2;
  const component = { pageBounds, whiteArea: winnerWhiteArea };
  const readiness = {
    attempts: 2,
    height,
    inkPixels,
    inkRatio: inkPixels / pagePixels,
    inkRowBands: 4,
    inkSpanRatio: Math.round(interiorWidth * 0.65) / interiorWidth,
    pageBounds,
    pagePixels,
    pageWhitePixels,
    pageWhiteRatio: pageWhitePixels / pagePixels,
    proof: "white-page-with-rendered-ink",
    renderedPage: true,
    runnerUpWhiteArea: 1_000,
    segmentationVersion: 2,
    substantialComponents: [component],
    substantialComponentCount: 1,
    width,
    winnerDominanceRatio: winnerWhiteArea / 1_000,
    winnerWhiteArea,
  };
  const layoutWidth = Math.round(
    configuration.width / configuration.browserZoom,
  );
  const layoutHeight = Math.round(
    configuration.height / configuration.browserZoom,
  );
  const dpr = configuration.baseDevicePixelRatio * configuration.browserZoom;
  const innerWidth = configuration.kind === "mobile" ? 980 : layoutWidth;
  const innerHeight = configuration.kind === "mobile"
    ? Math.round(innerWidth * layoutHeight / layoutWidth)
    : layoutHeight;
  const configuredScale = configuration.pinchZoom;
  const viewerScale = configuredScale * layoutWidth / innerWidth;
  const viewport = (scale) => ({
    devicePixelRatio: dpr,
    innerHeight,
    innerWidth,
    screenHeight: layoutHeight,
    screenWidth: layoutWidth,
    visualViewportHeight: layoutHeight / scale,
    visualViewportScale: scale,
    visualViewportWidth: layoutWidth / scale,
  });
  const sessionIdentityHash = diagnosticIdentity(
    configuration.id,
    "reference-session",
    index,
  );
  const frameIdentityHash = diagnosticIdentity(configuration.id, "frame");
  const loaderIdentityHash = diagnosticIdentity(configuration.id, "loader");
  readiness.captureLifecycle = {
    baseline: {
      checked: true,
      frameIdentityHash,
      frameTreeMainOnly: true,
      frameUrlClass: "about-blank",
      locationClass: "about-blank",
      pageCount: 1,
      pageUrlClass: "about",
      readyStateComplete: true,
      targetCount: 1,
      workerCount: 0,
    },
    configurationId: configuration.id,
    configuredViewport: viewport(configuredScale),
    navigation: {
      dispatchSequence: 1,
      finalSequence: 4,
      frameIdentityHash,
      isDownload: false,
      lifecycleFrameIdentityHash: frameIdentityHash,
      lifecycleLoadSequence: 3,
      lifecycleLoaderIdentityHash: loaderIdentityHash,
      lifecycleName: "load",
      loaderIdentityHash,
      loadEventFiredSequence: 4,
      newDocument: true,
      responseSequence: 2,
    },
    proof: "fresh-owned-reference-loader",
    requestedPage: targetPage,
    sessionIdentityHash,
    viewer: {
      contentTypeClass: "html",
      pdfEmbedPresent: false,
      protocolClass: "extension",
      readyStateComplete: true,
      viewport: viewport(viewerScale),
    },
    viewportProof: "native-viewer-relational-v1",
  };
  const targetReadiness = {
    ...readiness,
    attempts: undefined,
    captureLifecycle: undefined,
    height: pageHeight,
    pageBounds: { height: pageHeight, width: pageWidth, x: 0, y: 0 },
    runnerUpWhiteArea: 0,
    substantialComponents: [{
      pageBounds: { height: pageHeight, width: pageWidth, x: 0, y: 0 },
      whiteArea: winnerWhiteArea,
    }],
    width: pageWidth,
    winnerDominanceRatio: null,
  };
  return {
    readiness,
    referenceTarget: {
      anchorLimit: Math.max(80, Math.ceil(height * 0.25)),
      components: [{ bounds: pageBounds, whiteArea: winnerWhiteArea }],
      cropBounds: pageBounds,
      policy: "unique-top-anchored-substantial-component",
      readiness: targetReadiness,
      requestedPage: targetPage,
      selectedComponentIndex: 0,
      selectionVersion: 1,
      sourceHeight: height,
      sourceWidth: width,
    },
    sessionIdentityHash,
  };
}

function passingEvidence() {
  const fixture = {
    bytes: 4096,
    path: "tests/fixtures/pdf-highlights/issue-60-geometry.pdf",
    sha256: SHA,
  };
  const matrix = PDF_SHARPNESS_MATRIX.map((configuration, index) => {
    const referenceScreenshot = artifact(
      `reference-${configuration.id}.png`,
      index + 1,
    );
    const lineLightScreenshot = artifact(
      `linelight-${configuration.id}.png`,
      index + 2,
    );
    const pageWidth = 600;
    const pageHeight = 800;
    const cssWidth = configuration.id === "desktop-dpr1-zoom100"
      ? 720
      : configuration.kind === "mobile"
        ? 300
        : 600;
    const cssHeight = (cssWidth * pageHeight) / pageWidth;
    const physicalRatio =
      configuration.baseDevicePixelRatio *
      configuration.browserZoom *
      configuration.pinchZoom;
    const targetScale = Math.ceil(
      Math.max(
        1,
        Math.max(cssWidth / pageWidth, cssHeight / pageHeight) * physicalRatio,
      ) / 0.25,
    ) * 0.25;
    const targetWidth = Math.ceil(pageWidth * targetScale);
    const targetHeight = Math.ceil(pageHeight * targetScale);
    const previewScale = Math.min(targetScale, 1.25);
    const previewWidth = Math.ceil(pageWidth * previewScale);
    const previewHeight = Math.ceil(pageHeight * previewScale);
    const previewSatisfiedTarget = previewScale === targetScale;
    const sharpCompositionId = previewSatisfiedTarget ? 1 : 2;
    const sharpComposedAt = previewSatisfiedTarget ? 10 : 20;
    const composedPageIds = configuration.kind === "mobile"
      ? [2, 3, 4]
      : [1, 2];
    const composedPages = composedPageIds.map((page, index) => ({
      geometry: {
        bottom: 180 + index * 120,
        left: 20,
        right: 620,
        top: 80 + index * 120,
      },
      geometryVisible: true,
      height: targetHeight,
      page,
      pixels: targetWidth * targetHeight,
      visible: true,
      width: targetWidth,
    }));
    const composedPixels = composedPages.reduce(
      (sum, page) => sum + page.pixels,
      0,
    );
    const canvasFrame = {
      at: 50,
      composedCount: composedPages.length,
      composedPages,
      composedPixels,
      geometryVisiblePages: [...composedPageIds],
      readerViewport: { bottom: 700, left: 0, right: 700, top: 0 },
      visiblePages: [...composedPageIds],
    };
    const priorityTarget = 4;
    const priorityCached = previewSatisfiedTarget;
    const priorityBitmapEventId = priorityCached ? 80 : 102;
    const reference = passingCanonicalReference(configuration, 2, index);
    const priorityRequest = priorityCached
      ? null
      : {
          activityId: 110,
          distance: 0,
          enabled: true,
          eventId: 101,
          height: null,
          identityHash: diagnosticIdentity(configuration.id, "render", 101),
          pageNumber: priorityTarget,
          scale: targetScale,
          type: "render",
          visible: true,
          width: null,
        };
    const priorityBitmap = priorityCached
      ? null
      : {
          activityId: 120,
          distance: null,
          enabled: null,
          eventId: 102,
          height: targetHeight,
          identityHash: diagnosticIdentity(configuration.id, "bitmap", 102),
          pageNumber: priorityTarget,
          scale: targetScale,
          type: "bitmap",
          visible: null,
          width: targetWidth,
        };
    return {
      alignment: {
        activeWordAfter: 2,
        activeWordBefore: 1,
        activeWordInsideHighlight: true,
        configurationId: configuration.id,
        highlightRectangles: 1,
        narrationAdvanced: true,
        passed: true,
        spoken: [{ characters: 23 }],
      },
      canvasBudget: {
        maximumCount: composedPages.length,
        maximumCountFrame: structuredClone(canvasFrame),
        maximumPixels: composedPixels,
        maximumPixelsFrame: structuredClone(canvasFrame),
      },
      comparison: {
        lineLightScreenshot,
        paired: true,
        referenceReadiness: reference.readiness,
        referenceScreenshot,
        referenceTarget: reference.referenceTarget,
        sourceSha256: SHA,
        targetPage: 2,
      },
      id: configuration.id,
      importedSource: { sha256: SHA, size: fixture.bytes },
      longTasks: [{ duration: 50, name: "self", startTime: 1 }],
      raster: {
        noLateLowOverwrite: true,
        noResolutionRegression: true,
        preview: {
          actualHeight: previewHeight,
          actualWidth: previewWidth,
          bitmapEventId: 1,
          composedAt: 10,
          compositionId: 1,
          connectedCanvas: true,
          distance: 1,
          observed: true,
          scale: previewScale,
          workerObserved: true,
        },
        previewBeforeSharp: !previewSatisfiedTarget,
        sharp: {
          actualHeight: targetHeight,
          actualWidth: targetWidth,
          bitmapEventId: sharpCompositionId,
          composedAt: sharpComposedAt,
          compositionId: sharpCompositionId,
          cssHeight,
          cssWidth,
          pageHeight,
          pageWidth,
          source: "worker-bitmap",
          targetCapped: false,
          targetHeight,
          targetScale,
          targetWidth,
        },
        transition: previewSatisfiedTarget
          ? "preview-satisfied-target"
          : "preview-to-sharp-upgrade",
      },
      release: {
        canvasHeight: 0,
        canvasWidth: 0,
        renderSource: null,
        shellRetained: true,
        textOverlayRetained: true,
      },
      runtimeErrors: [],
      viewport: {
        beforeDevicePixelRatio: configuration.baseDevicePixelRatio,
        beforeLayoutHeight: configuration.height,
        beforeLayoutWidth: configuration.width,
        beforeVisualViewportScale: 1,
        devicePixelRatio:
          configuration.baseDevicePixelRatio * configuration.browserZoom,
        mobile: configuration.kind === "mobile",
        layoutHeight: Math.round(configuration.height / configuration.browserZoom),
        layoutWidth: Math.round(configuration.width / configuration.browserZoom),
        transition: configuration.browserZoom > 1
          ? "browser-zoom"
          : configuration.pinchZoom > 1
            ? "visual-viewport-pinch"
            : "normal",
        visualViewportScale: configuration.pinchZoom,
      },
      visibleFirst: {
        firstComposedPage: priorityTarget,
        firstPostScrollBitmapPage: priorityCached ? 5 : priorityTarget,
        firstPostScrollCompositionPage: priorityTarget,
        firstPostScrollVisibleRequestPage:
          priorityCached ? null : priorityTarget,
        firstWorkerBitmapPage: priorityTarget,
        scrollAction: {
          activityId: 100,
          at: 100,
          drawBoundary: 89,
          drawInvocationBoundary: 89,
          eventId: 100,
          readerViewportAfter: { bottom: 700, left: 0, right: 700, top: 0 },
          readerViewportBefore: { bottom: 700, left: 0, right: 700, top: 0 },
          scrollTopAfter: 2_000,
          scrollTopBefore: 1_000,
          targetGeometryAfter: { bottom: 650, left: 20, right: 620, top: 50 },
          targetGeometryBefore: {
            bottom: 1_600,
            left: 20,
            right: 620,
            top: 800,
          },
          targetPage: priorityTarget,
          type: "rapid-scroll-action",
        },
        nonTargetBitmaps: [{
          activityId: priorityCached ? 120 : 140,
          distance: null,
          enabled: null,
          eventId: 103,
          height: previewHeight,
          identityHash: diagnosticIdentity(configuration.id, "bitmap", 103),
          pageNumber: 5,
          scale: previewScale,
          type: "bitmap",
          visible: null,
          width: previewWidth,
        }],
        staleNonVisibleCompositions: [],
        staleWorkerBitmaps: [],
        targetAfter: {
          canvasHeight: targetHeight,
          canvasWidth: targetWidth,
          distance: 0,
          renderSource: "worker-bitmap",
          scale: targetScale,
          targetHeight,
          targetScale,
          targetWidth,
          visible: true,
        },
        targetBefore: {
          canvasHeight: 0,
          canvasWidth: 0,
          distance: 1,
          latestBitmapActivityId: 80,
          latestBitmapEventId: 80,
          latestBitmapHeight: priorityCached ? targetHeight : previewHeight,
          latestBitmapScale: priorityCached ? targetScale : previewScale,
          latestBitmapWidth: priorityCached ? targetWidth : previewWidth,
          targetHeight: null,
          targetScale: null,
          targetWidth: null,
          visible: false,
        },
        targetBitmapAfterVisibleRequest: priorityBitmap,
        targetBitmapCount: priorityCached ? 0 : 1,
        targetBitmaps: priorityCached ? [] : [structuredClone(priorityBitmap)],
        targetComposition: {
          activityId: priorityCached ? 110 : 130,
          at: 110,
          bitmapEventId: priorityBitmapEventId,
          compositionId: 90,
          drawInvocationId: 90,
          geometry: { bottom: 650, left: 20, right: 620, top: 50 },
          geometryVisible: true,
          height: targetHeight,
          page: priorityTarget,
          readerViewport: { bottom: 700, left: 0, right: 700, top: 0 },
          scale: targetScale,
          source: "worker-bitmap",
          visible: true,
          visiblePages: [priorityTarget],
          width: targetWidth,
        },
        targetPage: priorityTarget,
        targetPath: priorityCached ? "cached-target" : "render-required",
        targetRenderRequestCount: priorityCached ? 0 : 1,
        targetRenderRequests:
          priorityCached ? [] : [structuredClone(priorityRequest)],
        targetVisibleRequest: priorityRequest,
      },
    };
  });
  const fallbackArtifact = artifact("fallback-visible-retry.png", 9);
  const cancellationTerminal = {
    abortSignalId: CANCELLATION_ABORT_SIGNAL_ID,
    at: 145,
    cancelRequestedAt: 140,
    documentKey: DOCUMENT_KEY,
    outcome: "cancelled",
    page: 3,
    pageDerivation: "sole-visible-unsatisfied-page",
    renderAttemptId: 7,
    revision: REVISION,
    targetHeight: 800,
    targetKey: "600x800",
    targetWidth: 600,
    type: "staging-finish",
  };
  return {
    artifacts: {
      deploymentId: DEPLOYMENT,
      screenshots: [
        ...matrix.flatMap((run) => [
          run.comparison.referenceScreenshot,
          run.comparison.lineLightScreenshot,
        ]),
        fallbackArtifact,
      ],
      sourceCommit: COMMIT,
      sourceTree: TREE,
    },
    bitmapBudget: {
      afterUnpin: { count: 8, pixels: 32_000_000 },
      closedBitmaps: 10,
      limits: {
        count: PDF_SHARPNESS_MAX_BITMAP_COUNT,
        pixels: PDF_SHARPNESS_MAX_BITMAP_PIXELS,
      },
      passed: true,
      peak: { count: 8, pixels: 32_000_000 },
      pinnedOverflowObserved: true,
      pinnedPeak: { count: 9, pixels: 37_000_000 },
      mixedSizes: Array.from({ length: 10 }, (_, index) => ({
        height: 1000 + index,
        width: 1000 + index,
      })),
      steadyState: { count: 8, pixels: 32_000_000 },
    },
    build: {
      fresh: true,
      localManifest: { deploymentId: DEPLOYMENT, sha256: SHA },
      servedManifest: { deploymentId: DEPLOYMENT, sha256: SHA },
      sourceCommit: COMMIT,
      sourceTree: TREE,
    },
    fallback: {
      artifact: fallbackArtifact,
      importedSource: { sha256: SHA, size: fixture.bytes },
      injectedFailures: 1,
      invisibleCancellation: {
        abortSignalId: CANCELLATION_ABORT_SIGNAL_ID,
        canvasHeightAfterExit: 0,
        canvasPresentAfterExit: true,
        canvasWidthAfterExit: 0,
        cancellationTerminal,
        completedAfterExit: false,
        continuationArmedAt: 80,
        continuationArmPageDerivation: "next-page-from-sole-visible-page",
        continuationDelayAt: 100,
        continuationDelayObserved: true,
        continuationMinimumElapsedAt: 1100,
        continuationMinimumElapsedObserved: true,
        continuationResumeAt: 1100,
        continuationResumeObserved: true,
        continuationResumedAfterMs: 1000,
        continuationReleaseRequestedAt: 150,
        documentKey: DOCUMENT_KEY,
        exitRequestedAt: 130,
        exitedAt: 150,
        lateComposes: [],
        page: 3,
        pageDerivation: "sole-visible-unsatisfied-page",
        renderAttemptId: 7,
        revision: REVISION,
        textOverlayRetainedAfterExit: true,
        viewportExit: {
          abortSignalId: CANCELLATION_ABORT_SIGNAL_ID,
          at: 150,
          cancelRequestedAt: 140,
          canvasHeight: 0,
          canvasPresent: true,
          canvasWidth: 0,
          documentKey: DOCUMENT_KEY,
          page: 3,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 7,
          revision: REVISION,
          textOverlayCount: 12,
          type: "viewport-exit",
          visible: false,
        },
        viewportExitRequest: {
          abortSignalId: CANCELLATION_ABORT_SIGNAL_ID,
          at: 130,
          destinationPage: 5,
          documentKey: DOCUMENT_KEY,
          page: 3,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 7,
          revision: REVISION,
          type: "viewport-exit-request",
          visibleBeforeRequest: true,
        },
      },
      longTasks: [{ duration: 50, name: "self", startTime: 1 }],
      maximumConcurrentStaging: 1,
      noLateLowOverwrite: true,
      retry: {
        composedAt: 20,
        documentKey: DOCUMENT_KEY,
        failedAbortSignalId: FAILED_ABORT_SIGNAL_ID,
        failedAttemptId: 1,
        failedAt: 11,
        injectionArmedAt: 8,
        injectionPageDerivation: "validated-adjacent-unsatisfied-page",
        page: 2,
        pageDerivation: "sole-visible-unsatisfied-page",
        retryAttemptId: 2,
        retryAbortSignalId: RETRY_ABORT_SIGNAL_ID,
        retryStartedAt: 12,
        revision: REVISION,
        targetHeight: 800,
        targetKey: "600x800",
        targetWidth: 600,
      },
      retrySucceeded: true,
      runtimeErrors: [],
      signaledBeforeDocumentReady: true,
      stagingEvents: [
        {
          at: 8,
          documentKey: DOCUMENT_KEY,
          page: 2,
          pageDerivation: "validated-adjacent-unsatisfied-page",
          revision: REVISION,
          type: "injection-armed",
        },
        {
          abortSignalId: FAILED_ABORT_SIGNAL_ID,
          at: 9,
          type: "abort-signal-registered",
        },
        {
          abortSignalCandidateCount: 1,
          abortSignalId: FAILED_ABORT_SIGNAL_ID,
          abortSignalRegisteredAt: 9,
          at: 10,
          candidatePages: [2],
          documentKey: DOCUMENT_KEY,
          page: 2,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 1,
          revision: REVISION,
          targetHeight: 800,
          targetKey: "600x800",
          targetWidth: 600,
          type: "staging-start",
        },
        {
          abortSignalId: FAILED_ABORT_SIGNAL_ID,
          at: 11,
          cancelRequestedAt: null,
          documentKey: DOCUMENT_KEY,
          outcome: "injected-failure",
          page: 2,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 1,
          revision: REVISION,
          targetHeight: 800,
          targetKey: "600x800",
          targetWidth: 600,
          type: "staging-finish",
        },
        {
          abortSignalId: RETRY_ABORT_SIGNAL_ID,
          at: 11.5,
          type: "abort-signal-registered",
        },
        {
          abortSignalCandidateCount: 1,
          abortSignalId: RETRY_ABORT_SIGNAL_ID,
          abortSignalRegisteredAt: 11.5,
          at: 12,
          candidatePages: [2],
          documentKey: DOCUMENT_KEY,
          page: 2,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 2,
          revision: REVISION,
          targetHeight: 800,
          targetKey: "600x800",
          targetWidth: 600,
          type: "staging-start",
        },
        {
          abortSignalId: RETRY_ABORT_SIGNAL_ID,
          at: 20,
          documentKey: DOCUMENT_KEY,
          page: 2,
          pageDerivation: "sole-visible-unsatisfied-page",
          pageMatchesAttempt: true,
          renderAttemptId: 2,
          revision: REVISION,
          sourcePage: 2,
          targetHeight: 800,
          targetKey: "600x800",
          targetWidth: 600,
          type: "visible-compose",
        },
        {
          armedAt: 80,
          at: 80,
          candidatePages: [3],
          documentKey: DOCUMENT_KEY,
          page: 3,
          pageDerivation: "next-page-from-sole-visible-page",
          revision: REVISION,
          type: "continuation-armed",
        },
        {
          abortSignalId: CANCELLATION_ABORT_SIGNAL_ID,
          at: 89,
          type: "abort-signal-registered",
        },
        {
          abortSignalCandidateCount: 1,
          abortSignalId: CANCELLATION_ABORT_SIGNAL_ID,
          abortSignalRegisteredAt: 89,
          at: 90,
          candidatePages: [3],
          documentKey: DOCUMENT_KEY,
          page: 3,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 7,
          revision: REVISION,
          targetHeight: 800,
          targetKey: "600x800",
          targetWidth: 600,
          type: "staging-start",
        },
        {
          abortSignalId: CANCELLATION_ABORT_SIGNAL_ID,
          at: 100,
          armedAt: 80,
          callbackName: "bound _scheduleNext",
          delay: 1000,
          documentKey: DOCUMENT_KEY,
          page: 3,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 7,
          revision: REVISION,
          type: "continuation-delay",
        },
        {
          abortSignalId: CANCELLATION_ABORT_SIGNAL_ID,
          at: 130,
          destinationPage: 5,
          documentKey: DOCUMENT_KEY,
          page: 3,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 7,
          revision: REVISION,
          type: "viewport-exit-request",
          visibleBeforeRequest: true,
        },
        {
          abortSignalId: CANCELLATION_ABORT_SIGNAL_ID,
          at: 140,
          documentKey: DOCUMENT_KEY,
          page: 3,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 7,
          revision: REVISION,
          type: "cancel-request",
        },
        cancellationTerminal,
        {
          abortSignalId: CANCELLATION_ABORT_SIGNAL_ID,
          at: 150,
          cancelRequestedAt: 140,
          canvasHeight: 0,
          canvasPresent: true,
          canvasWidth: 0,
          documentKey: DOCUMENT_KEY,
          page: 3,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 7,
          revision: REVISION,
          textOverlayCount: 12,
          type: "viewport-exit",
          visible: false,
        },
        {
          abortSignalId: CANCELLATION_ABORT_SIGNAL_ID,
          afterMs: 1000,
          at: 1100,
          documentKey: DOCUMENT_KEY,
          page: 3,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 7,
          revision: REVISION,
          type: "continuation-minimum-elapsed",
        },
        {
          abortSignalId: CANCELLATION_ABORT_SIGNAL_ID,
          afterMs: 1000,
          at: 1100,
          documentKey: DOCUMENT_KEY,
          page: 3,
          pageDerivation: "sole-visible-unsatisfied-page",
          releaseRequestedAt: 150,
          renderAttemptId: 7,
          revision: REVISION,
          type: "continuation-resume",
        },
      ],
      workerFallbackEvent: { type: "render-fallback" },
      workerQueueClosed: true,
    },
    fixture,
    issue: 68,
    matrix,
    network: (() => {
      let nextCdpId = 1;
      const completedTargetSetup = (type, startedAt) => {
        const serviceWorker = type === "service_worker";
        const dispatchTimes = serviceWorker
          ? [startedAt, startedAt + 1, startedAt + 2, startedAt + 3,
            startedAt + 4]
          : [startedAt, startedAt + 1, startedAt + 4, startedAt + 6,
            startedAt + 8];
        const resultTimes = serviceWorker
          ? [startedAt + 6, startedAt + 7, startedAt + 8, startedAt + 9,
            startedAt + 5]
          : [startedAt + 2, startedAt + 3, startedAt + 5, startedAt + 7,
            startedAt + 9];
        const resultOrder = serviceWorker ? [2, 3, 4, 5, 1] : [1, 2, 3, 4, 5];
        const deadlineAt = serviceWorker ? startedAt + 100 : null;
        const definitions = [
          ["network-enable", "Network.enable"],
          ["runtime-enable", "Runtime.enable"],
          ["cache-disable", "Network.setCacheDisabled"],
          ["auto-attach", "Target.setAutoAttach"],
          ["resume", "Runtime.runIfWaitingForDebugger"],
        ];
        return {
          commandDeadlineAt: deadlineAt,
          commands: definitions.map(([name, method], index) => ({
            cdpId: nextCdpId++,
            deadlineAt,
            dispatchedAt: dispatchTimes[index],
            dispatchSequence: index + 1,
            method,
            name,
            resultAt: resultTimes[index],
            resultSequence: resultOrder[index],
            status: "completed",
          })),
          lifecycleStrategy: serviceWorker
            ? "setup-dispatched-before-resume"
            : "setup-completed-before-resume",
          resumeDispatchedAt: dispatchTimes[4],
        };
      };
      const normalPairs = PDF_SHARPNESS_MATRIX.map(({ id }, index) => {
        const documentTarget = {
          ancestry: [],
          attachComplete: true,
          bootstrapRequestKey: null,
          detached: false,
          ...completedTargetSetup("worker", 1_000 + index * 100),
          parentSessionId: null,
          phase: id,
          resumed: true,
          sessionId: `normal-document-session-${index}`,
          targetId: `normal-document-target-${index}`,
          type: "worker",
          url: "http://127.0.0.1/assets/pdf-document.worker-test.js",
          waitingForDebugger: true,
        };
        const parserTarget = {
          ancestry: [documentTarget],
          attachComplete: true,
          bootstrapRequestKey: null,
          detached: false,
          ...completedTargetSetup("worker", 1_050 + index * 100),
          parentSessionId: documentTarget.sessionId,
          phase: id,
          resumed: true,
          sessionId: `normal-parser-session-${index}`,
          targetId: `normal-parser-target-${index}`,
          type: "worker",
          url: "http://127.0.0.1/assets/pdf-parser.worker-test.js",
          waitingForDebugger: true,
        };
        return { documentTarget, id, parserTarget };
      });
      const forcedWrapper = {
        ancestry: [],
        attachComplete: true,
        bootstrapRequestKey: null,
        detached: false,
        ...completedTargetSetup("worker", 2_000),
        parentSessionId: null,
        phase: "forced-main-fallback",
        resumed: true,
        sessionId: "forced-wrapper-session",
        targetId: "forced-wrapper-target",
        type: "worker",
        url: "blob:http://127.0.0.1/forced-wrapper",
        waitingForDebugger: true,
      };
      const forcedParser = {
        ancestry: [forcedWrapper],
        attachComplete: true,
        bootstrapRequestKey: null,
        detached: false,
        ...completedTargetSetup("worker", 2_050),
        parentSessionId: forcedWrapper.sessionId,
        phase: "forced-main-fallback",
        resumed: true,
        sessionId: "forced-parser-session",
        targetId: "forced-parser-target",
        type: "worker",
        url: "http://127.0.0.1/assets/pdf-parser.worker-test.js",
        waitingForDebugger: true,
      };
      const serviceWorker = {
        ancestry: [],
        attachComplete: true,
        bootstrapRequestKey: null,
        detached: false,
        ...completedTargetSetup("service_worker", 900),
        parentSessionId: null,
        phase: PDF_SHARPNESS_MATRIX[0].id,
        resumed: true,
        serviceWorkerBootstrapRequestKey: null,
        sessionId: "service-worker-session",
        targetId: "service-worker-target",
        type: "service_worker",
        url: "http://127.0.0.1/sw.js",
        waitingForDebugger: true,
      };
      const targets = [
        serviceWorker,
        ...normalPairs.flatMap(({ documentTarget, parserTarget }) => [
          documentTarget,
          parserTarget,
        ]),
        forcedWrapper,
        forcedParser,
      ];
      const targetBootstrapSettlements = [];
      const bootstrapRequests = normalPairs.flatMap(
        ({ documentTarget, id, parserTarget }, index) => {
          const documentRequest = {
            bootstrapTargetSessionId: documentTarget.sessionId,
            method: "GET",
            phase: id,
            requestId: `normal-document-request-${index}`,
            sessionId: null,
            type: "Script",
            url: documentTarget.url,
          };
          const parserRequest = {
            bootstrapTargetSessionId: parserTarget.sessionId,
            method: "GET",
            phase: id,
            requestId: `normal-parser-request-${index}`,
            sessionId: documentTarget.sessionId,
            type: "Script",
            url: parserTarget.url,
          };
          for (const [request, target] of [
            [documentRequest, documentTarget],
            [parserRequest, parserTarget],
          ]) {
            target.bootstrapRequestKey =
              `${request.sessionId ?? "page"}:${request.requestId}`;
            targetBootstrapSettlements.push({
              method: request.method,
              phase: request.phase,
              requestId: request.requestId,
              requestSessionId: request.sessionId,
              resourceType: request.type,
              targetDetachedAtSettlement: false,
              targetId: target.targetId,
              targetParentSessionId: target.parentSessionId,
              targetSessionId: target.sessionId,
              targetType: target.type,
              terminalReason: "target-attached",
              url: request.url,
            });
          }
          return [documentRequest, parserRequest];
        },
      );
      const runtimeRequests = [
        ...normalPairs.map(({ id, parserTarget }, index) => ({
          method: "GET",
          phase: id,
          requestId: `normal-runtime-request-${index}`,
          sessionId: parserTarget.sessionId,
          type: "Fetch",
          url: `http://127.0.0.1/assets/worker-request-${index}.bin`,
        })),
        ...[forcedWrapper, forcedParser].map((target, index) => ({
          method: "GET",
          phase: target.phase,
          requestId: `forced-runtime-request-${index}`,
          sessionId: target.sessionId,
          type: "Fetch",
          url: `http://127.0.0.1/assets/forced-request-${index}.bin`,
        })),
      ];
      const serviceWorkerRequest = {
        method: "GET",
        phase: serviceWorker.phase,
        requestId: "service-worker-bootstrap-request",
        serviceWorkerTargetSessionId: serviceWorker.sessionId,
        sessionId: serviceWorker.sessionId,
        startedAt: 905,
        terminalAt: 910,
        terminalReason: "loading-finished",
        type: "Script",
        url: serviceWorker.url,
      };
      serviceWorker.serviceWorkerBootstrapRequestKey =
        `${serviceWorker.sessionId}:${serviceWorkerRequest.requestId}`;
      const requests = [
        serviceWorkerRequest,
        ...bootstrapRequests,
        ...runtimeRequests,
      ];
      requests.forEach((request, index) => {
        request.sequence = index + 1;
        request.startedAt ??= 3_000 + index * 2;
        request.terminalAt ??= request.startedAt + 1;
        request.terminalReason ??= request.bootstrapTargetSessionId
          ? "target-attached"
          : "loading-finished";
      });
      const serviceWorkerBootstrapObservations = [{
        method: serviceWorkerRequest.method,
        phase: serviceWorkerRequest.phase,
        requestId: serviceWorkerRequest.requestId,
        requestSequence: serviceWorkerRequest.sequence,
        requestSessionId: serviceWorkerRequest.sessionId,
        requestStartedAt: serviceWorkerRequest.startedAt,
        resourceType: serviceWorkerRequest.type,
        resumeDispatchedAt: serviceWorker.resumeDispatchedAt,
        targetId: serviceWorker.targetId,
        targetDetachedAtObservation: false,
        targetSessionId: serviceWorker.sessionId,
        targetType: serviceWorker.type,
        terminalAt: serviceWorkerRequest.terminalAt,
        terminalReason: serviceWorkerRequest.terminalReason,
        url: serviceWorkerRequest.url,
      }];
      const nonPageRequests = requests.filter(
        (request) => request.sessionId !== null,
      );
      const requestCount = requests.length;
      return {
        attachErrors: [],
        networkFixedPoints: [
          ...PDF_SHARPNESS_MATRIX.map(({ id }) => id),
          "forced-main-fallback",
          "final-network-privacy",
        ].map((label) => ({
          attachErrorCount: 0,
          attachmentReady: true,
          attachPromiseCount: targets.length,
          completedRequestCount: requestCount,
          documentBootstrapSettlementCount:
            PDF_SHARPNESS_MATRIX.some(({ id }) => id === label) ? 1 : 0,
          inflightRequestCount: 0,
          label,
          pendingAttachCount: 0,
          parserBootstrapSettlementCount:
            PDF_SHARPNESS_MATRIX.some(({ id }) => id === label) ? 1 : 0,
          requestCount,
          serviceWorkerBypassed: true,
          serviceWorkerBootstrapObservationCount: 1,
          targetBootstrapSettlementCount:
            targetBootstrapSettlements.length,
          targetCount: targets.length,
        })),
        completedRequestCount: requestCount,
        coverageTargets: {
          forcedBlobWrapper: [forcedWrapper],
          forcedParserWorker: [forcedParser],
          normalDocumentWorker: normalPairs.map(
            ({ documentTarget }) => documentTarget,
          ),
          normalParserWorker: normalPairs.map(
            ({ parserTarget }) => parserTarget,
          ),
        },
        externalRequests: [],
        failures: [],
        initialTargetBaseline: {
          checked: true,
          pageCount: 1,
          pageUrlClass: "about",
          targetCount: 1,
          workerCount: 0,
        },
        inflightRequestCount: 0,
        localRequestCount: requestCount,
        matrixCoverage: Object.fromEntries(
          normalPairs.map(({ documentTarget, id, parserTarget }) => [
            id,
            {
              documentBootstrapSettlementCount: 1,
              documentRequestCount: 2,
              documentTargets: [documentTarget],
              parserBootstrapSettlementCount: 1,
              parserRequestCount: 1,
              parserTargets: [parserTarget],
            },
          ]),
        ),
        nonPageRequestCounts: {
          forcedBlobWrapper: 2,
          forcedParserWorker: 1,
          normalDocumentWorker: normalPairs.length * 2,
          normalParserWorker: normalPairs.length,
          total: nonPageRequests.length,
        },
        nonPageRequests,
        referenceScheme: "file:",
        requests,
        serviceWorkerBypassed: true,
        serviceWorkerBootstrapObservations,
        sourceRequest: null,
        sourceSha256: SHA,
        sourceStayedLocal: true,
        targetBootstrapSettlements,
        targets,
      };
    })(),
    schemaVersion: PDF_SHARPNESS_SCHEMA_VERSION,
    source: {
      commit: COMMIT,
      files: Object.fromEntries(
        PDF_SHARPNESS_SOURCE_FILES.map((file) => [file, SHA]),
      ),
      postBuildCommit: COMMIT,
      postBuildStatus: [],
      postBuildTree: TREE,
      preflightStatus: [],
      tree: TREE,
    },
    teardown: {
      app: {
        cdpClosed: true,
        cdpPresent: true,
        error: null,
        present: true,
        processClosed: true,
        profileRemoved: true,
      },
      browserClosed: true,
      cdpClosed: true,
      errors: [],
      profilesRemoved: true,
      reference: {
        cdpClosed: true,
        cdpPresent: true,
        error: null,
        present: true,
        processClosed: true,
        profileRemoved: true,
      },
      referenceBrowserClosed: true,
      referenceBrowsersClosed: true,
      referenceSessions: matrix.map((run) => ({
        cdpClosed: true,
        cdpPresent: true,
        configurationId: run.id,
        errorPresent: false,
        present: true,
        processClosed: true,
        profileRemoved: true,
        sessionIdentityHash:
          run.comparison.referenceReadiness.captureLifecycle
            .sessionIdentityHash,
      })),
      server: { error: null, present: true, processClosed: true },
      serverClosed: true,
    },
  };
}

function makeAdjacentReferenceComponentTheGlobalWinner(run) {
  const readiness = run.comparison.referenceReadiness;
  const referenceTarget = run.comparison.referenceTarget;
  const selected = readiness.substantialComponents[0];
  const adjacentBounds = {
    ...selected.pageBounds,
    y: referenceTarget.anchorLimit + 1,
  };
  const adjacent = {
    pageBounds: adjacentBounds,
    whiteArea: selected.whiteArea + 1,
  };
  readiness.pageBounds = adjacentBounds;
  readiness.runnerUpWhiteArea = selected.whiteArea;
  readiness.substantialComponents = [selected, adjacent];
  readiness.substantialComponentCount = 2;
  readiness.winnerDominanceRatio = adjacent.whiteArea / selected.whiteArea;
  readiness.winnerWhiteArea = adjacent.whiteArea;
  referenceTarget.components = [
    referenceTarget.components[0],
    { bounds: adjacentBounds, whiteArea: adjacent.whiteArea },
  ];
}

function forgeCorrelatedReferenceComponentAreaOverflow(run) {
  const readiness = run.comparison.referenceReadiness;
  const target = run.comparison.referenceTarget;
  const winner = readiness.substantialComponents[0];
  const additional = [1, 2].map((offset) => ({
    pageBounds: {
      ...winner.pageBounds,
      x: winner.pageBounds.x + offset,
      y: target.anchorLimit + offset,
    },
    whiteArea: winner.whiteArea - offset,
  }));
  readiness.substantialComponents.push(...additional);
  readiness.substantialComponentCount = 3;
  readiness.runnerUpWhiteArea = additional[0].whiteArea;
  readiness.winnerDominanceRatio =
    readiness.winnerWhiteArea / readiness.runnerUpWhiteArea;
  target.components.push(...additional.map((component) => ({
    bounds: { ...component.pageBounds },
    whiteArea: component.whiteArea,
  })));
}

function forgeImpossibleConnectedReferenceComponent(run) {
  const readiness = run.comparison.referenceReadiness;
  const target = run.comparison.referenceTarget;
  const impossible = {
    pageBounds: {
      ...readiness.substantialComponents[0].pageBounds,
      x: 20,
      y: target.anchorLimit + 1,
    },
    whiteArea: 1,
  };
  readiness.substantialComponents.push(impossible);
  readiness.substantialComponentCount = 2;
  readiness.runnerUpWhiteArea = impossible.whiteArea;
  readiness.winnerDominanceRatio =
    readiness.winnerWhiteArea / readiness.runnerUpWhiteArea;
  target.components.push({
    bounds: { ...impossible.pageBounds },
    whiteArea: impossible.whiteArea,
  });
}

function forgeListedReferenceRunner(run, { tied = false } = {}) {
  const readiness = run.comparison.referenceReadiness;
  const target = run.comparison.referenceTarget;
  const winner = readiness.substantialComponents[0];
  const listed = {
    pageBounds: {
      ...winner.pageBounds,
      x: 20,
      y: target.anchorLimit + 1,
    },
    whiteArea: tied ? winner.whiteArea : winner.whiteArea - 1,
  };
  readiness.substantialComponents.push(listed);
  readiness.substantialComponentCount = 2;
  readiness.runnerUpWhiteArea = 1;
  readiness.winnerDominanceRatio = readiness.winnerWhiteArea;
  target.components.push({
    bounds: { ...listed.pageBounds },
    whiteArea: listed.whiteArea,
  });
}

test("accepts complete Issue 68 sharpness evidence", () => {
  const evidence = passingEvidence();
  assert.deepEqual(
    evidence.matrix.map((run) => run.raster.transition),
    [
      "preview-satisfied-target",
      "preview-satisfied-target",
      "preview-to-sharp-upgrade",
      "preview-to-sharp-upgrade",
      "preview-to-sharp-upgrade",
      "preview-to-sharp-upgrade",
    ],
  );
  assert.deepEqual(validatePdfSharpnessEvidence(evidence), []);
});

test("binds the requested top page when an adjacent page is the global winner", () => {
  const evidence = passingEvidence();
  makeAdjacentReferenceComponentTheGlobalWinner(evidence.matrix[0]);
  assert.notDeepEqual(
    evidence.matrix[0].comparison.referenceReadiness.pageBounds,
    evidence.matrix[0].comparison.referenceTarget.cropBounds,
  );
  assert.deepEqual(validatePdfSharpnessEvidence(evidence), []);
});

test("classifies target-satisfying previews without manufacturing an upgrade", () => {
  const sharp = { targetHeight: 990, targetScale: 1.25, targetWidth: 765 };
  assert.equal(
    classifyPdfRasterTransition(
      { height: 990, scale: 1.25, width: 765 },
      sharp,
    ),
    "preview-satisfied-target",
  );
  assert.equal(
    classifyPdfRasterTransition(
      { height: 792, scale: 1, width: 612 },
      sharp,
    ),
    "preview-to-sharp-upgrade",
  );
});

test("binds raster transitions to import and monotonic event identities", async () => {
  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  assert.match(source, /compositionId: state\.draws\.length \+ 1/u);
  assert.equal(source.match(/eventId: workerEvents\.length \+ 1/gu)?.length, 2);
  assert.match(
    source,
    /event\.jobId === \$\{modelCompletion\.importJobId\}/u,
  );
  assert.match(
    source,
    /event\.revision === \$\{JSON\.stringify\(modelCompletion\.revision\)\}/u,
  );
  assert.match(source, /readRasterTransitionDiagnostic/u);
  assert.match(
    source,
    /draw\.compositionId > \$\{previewComposition\.compositionId\}/u,
  );
  assert.doesNotMatch(
    source,
    /draw\.at > \$\{previewComposition\.at\}/u,
  );
});

test("filters fallback proof to the current imported document and signals", () => {
  const stale = {
    abortSignalId: 1,
    documentKey: "restored:revision",
    revision: "restored-revision",
  };
  const current = {
    abortSignalId: 2,
    documentKey: DOCUMENT_KEY,
    revision: REVISION,
  };
  const { events, maximumConcurrentStaging } = selectPdfFallbackScenarioEvents(
    [
      { ...stale, at: 90, type: "staging-start" },
      { abortSignalId: 1, at: 101, type: "abort-signal-registered" },
      { ...stale, at: 102, type: "staging-start" },
      { abortSignalId: 2, at: 103, type: "abort-signal-registered" },
      { ...current, at: 104, type: "staging-start" },
      { ...current, at: 105, type: "staging-finish" },
    ],
    { documentKey: DOCUMENT_KEY, revision: REVISION, startedAt: 100 },
  );
  assert.deepEqual(
    events.map((event) => [event.abortSignalId, event.type]),
    [
      [2, "abort-signal-registered"],
      [2, "staging-start"],
      [2, "staging-finish"],
    ],
  );
  assert.equal(maximumConcurrentStaging, 1);
});

test("records fixed-point diagnostics without private URL or payload data", () => {
  const appUrl = "http://127.0.0.1:4173/";
  const privateText = "private-reader-sentence";
  const privateProfile = "/tmp/linelight-private-profile/Default";
  const diagnosticCapturedAt = Date.now();
  const pendingPromise = Promise.resolve();
  const requestKey = "worker-session:private-request-id";
  const workerUrl =
    `${appUrl}assets/pdf-document.worker-test.js?text=${privateText}`;
  const parserUrl =
    `${appUrl}assets/pdf-parser.worker-test.js?profile=${privateProfile}`;
  const networkState = {
    attachErrors: [{
      command: "resume",
      error: `Could not resume target: ${privateProfile}?text=${privateText}`,
      sessionId: "worker-session",
      targetId: "worker-target",
      type: "worker",
      url: parserUrl,
    }],
    attachPromises: [pendingPromise],
    byId: new Map([[requestKey, {
      method: "GET",
      phase: "desktop-dpr1-zoom100",
      requestId: "private-request-id",
      sessionId: "worker-session",
      type: "Script",
      url: parserUrl,
    }]]),
    completedRequestCount: 4,
    inflightRequests: new Set([requestKey]),
    pendingAttachMetadata: new Map([[pendingPromise, {
      commands: [
        { name: "network-enable", status: "completed" },
        { name: "runtime-enable", status: "pending" },
      ],
      parentSessionId: null,
      phase: "desktop-dpr1-zoom100",
      sessionId: "worker-session",
      targetId: "worker-target",
      type: "worker",
      url: parserUrl,
    }]]),
    pendingAttachPromises: new Set([pendingPromise]),
    recentActivity: [{
      at: diagnosticCapturedAt - 20,
      command: "runtime-enable",
      kind: "attach-command-start",
      phase: "desktop-dpr1-zoom100",
      sessionId: "worker-session",
      targetId: "worker-target",
      type: "worker",
      url: parserUrl,
    }],
    requests: [{ method: "GET", url: workerUrl }],
    serviceWorkerBypassed: false,
    targetBootstrapSettlements: [{
      method: "GET",
      phase: "desktop-dpr1-zoom100",
      requestId: "document-bootstrap-request",
      requestSessionId: null,
      resourceType: "Script",
      targetDetachedAtSettlement: false,
      targetId: "document-target",
      targetParentSessionId: null,
      targetSessionId: "document-session",
      targetType: "worker",
      terminalReason: "target-attached",
      url: workerUrl,
    }],
    targets: [
      {
        detached: false,
        parentSessionId: null,
        phase: "desktop-dpr1-zoom100",
        sessionId: "document-session",
        targetId: "document-target",
        type: "worker",
        url: workerUrl,
        waitingForDebugger: false,
      },
      {
        detached: true,
        parentSessionId: "document-session",
        phase: "desktop-dpr1-zoom100",
        sessionId: "worker-session",
        targetId: "worker-target",
        type: "worker",
        url: parserUrl,
        waitingForDebugger: true,
      },
    ],
  };
  const diagnosticWaitState = {
    capturedAtMs: diagnosticCapturedAt,
    elapsedMs: 10_001,
    recentSamples: [{
      attachErrorCount: 1,
      attachmentReady: false,
      elapsedMs: 9_950,
      incompleteTargetCount: 2,
      inflightRequestCount: 1,
      pendingAttachCount: 1,
      requestCount: 1,
      serviceWorkerBypassed: false,
      stableSamples: 0,
      targetCount: 2,
    }],
    stableSamples: 0,
    timeoutMs: 10_000,
  };
  const diagnostic = buildCdpNetworkFixedPointDiagnostic(
    networkState,
    appUrl,
    "desktop-dpr1-zoom100",
    "timeout",
    diagnosticWaitState,
  );
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    "attachErrors",
    "counts",
    "inflightRequests",
    "initialTargetBaseline",
    "label",
    "outcome",
    "pendingAttaches",
    "recentActivity",
    "serviceWorkerBootstrapObservations",
    "serviceWorkerBypassed",
    "targetBootstrapSettlements",
    "targets",
    "wait",
  ]);
  assert.equal(diagnostic.inflightRequests[0].urlClass,
    "pdf-parser-worker");
  assert.equal(diagnostic.pendingAttaches[0].urlClass,
    "pdf-parser-worker");
  assert.deepEqual(
    diagnostic.pendingAttaches[0].commands.map(
      ({ name, status }) => ({ name, status }),
    ),
    [
      { name: "network-enable", status: "completed" },
      { name: "runtime-enable", status: "pending" },
    ],
  );
  assert.equal(diagnostic.targets[0].urlClass,
    "pdf-document-worker");
  assert.equal(diagnostic.targets[1].urlClass,
    "pdf-parser-worker");
  assert.equal(diagnostic.targets[1].detached, true);
  assert.equal(diagnostic.targets[1].ancestry[0].urlClass,
    "pdf-document-worker");
  assert.equal(diagnostic.recentActivity[0].command, "runtime-enable");
  assert.equal(
    diagnostic.targetBootstrapSettlements[0].urlClass,
    "pdf-document-worker",
  );
  assert.equal(diagnostic.wait.elapsedMs, 10_001);
  assert.equal(diagnostic.serviceWorkerBypassed, false);
  assert.equal(diagnostic.initialTargetBaseline, null);
  assert.deepEqual(diagnostic.serviceWorkerBootstrapObservations, []);
  assert.equal(diagnostic.wait.recentSamples[0].inflightRequestCount, 1);
  assert.match(diagnostic.inflightRequests[0].identityHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(diagnostic.counts, {
    attachErrorCount: 1,
    attachPromiseCount: 1,
    completedRequestCount: 4,
    externalRequestCount: 0,
    inflightRequestCount: 1,
    networkFailureCount: 0,
    pendingAttachCount: 1,
    requestCount: 1,
    serviceWorkerBootstrapObservationCount: 0,
    targetBootstrapSettlementCount: 1,
    targetCount: 2,
  });
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /private-reader-sentence/u);
  assert.doesNotMatch(serialized, /linelight-private-profile/u);
  assert.doesNotMatch(serialized, /\?/u);
  assert.doesNotMatch(serialized, /"url":|"path":|"error":|body|documentText/u);

  networkState.attachErrors[0].error =
    "Could not resume target: entirely-different-private-error";
  networkState.attachErrors[0].url = `${appUrl}assets/pdf-parser.worker-next.js?new=secret`;
  networkState.byId.get(requestKey).url =
    `${appUrl}assets/pdf-parser.worker-next.js?new=secret`;
  networkState.pendingAttachMetadata.get(pendingPromise).url =
    `${appUrl}assets/pdf-parser.worker-next.js?new=secret`;
  networkState.recentActivity[0].url =
    `${appUrl}assets/pdf-parser.worker-next.js?new=secret`;
  networkState.requests[0].url =
    `${appUrl}assets/pdf-document.worker-next.js?new=secret`;
  networkState.targets[0].url =
    `${appUrl}assets/pdf-document.worker-next.js?new=secret`;
  networkState.targetBootstrapSettlements[0].url =
    `${appUrl}assets/pdf-document.worker-next.js?new=secret`;
  networkState.targets[1].url =
    `${appUrl}assets/pdf-parser.worker-next.js?new=secret`;
  const changedPrivateInputs = buildCdpNetworkFixedPointDiagnostic(
    networkState,
    appUrl,
    "desktop-dpr1-zoom100",
    "timeout",
    diagnosticWaitState,
  );
  assert.deepEqual(changedPrivateInputs, diagnostic);

  assert.deepEqual(
    [
      `${appUrl}`,
      `${appUrl}assets/app.js`,
      workerUrl,
      parserUrl,
      `blob:${appUrl}private-id`,
      "about:blank",
      "data:text/plain,private",
      "https://example.test/private?token=secret",
      "http://127.0.0.1:9999/internal?secret=true",
    ].map((url) => classifyCdpDiagnosticUrl(url, appUrl)),
    [
      "page",
      "app-asset",
      "pdf-document-worker",
      "pdf-parser-worker",
      "blob",
      "about",
      "data",
      "external",
      "other-local",
    ],
  );

  const outputDirectory = path.join(
    os.tmpdir(),
    "issue-68-network-diagnostic",
  );
  const screenshot = {
    ...artifact("linelight-desktop-dpr1-zoom100.png", 9),
    path: path.relative(
      path.resolve("."),
      path.join(outputDirectory, "linelight-desktop-dpr1-zoom100.png"),
    ),
  };
  const cleanDiagnosticTeardown = {
    app: {
      cdpClosed: true,
      error: null,
      present: true,
      processClosed: true,
      profileRemoved: true,
    },
    browserClosed: true,
    cdpClosed: true,
    errors: [],
    profilesRemoved: true,
    reference: {
      cdpClosed: true,
      error: null,
      present: false,
      processClosed: true,
      profileRemoved: true,
    },
    referenceBrowserClosed: true,
    server: {
      error: null,
      present: true,
      processClosed: true,
    },
    serverClosed: true,
  };
  const healthyDiagnostic = structuredClone(diagnostic);
  healthyDiagnostic.attachErrors = [];
  healthyDiagnostic.counts.attachErrorCount = 0;
  healthyDiagnostic.counts.attachPromiseCount = 3;
  healthyDiagnostic.counts.completedRequestCount = 3;
  healthyDiagnostic.counts.externalRequestCount = 0;
  healthyDiagnostic.counts.inflightRequestCount = 0;
  healthyDiagnostic.counts.networkFailureCount = 0;
  healthyDiagnostic.counts.pendingAttachCount = 0;
  healthyDiagnostic.counts.requestCount = 3;
  healthyDiagnostic.inflightRequests = [];
  healthyDiagnostic.initialTargetBaseline = {
    checked: true,
    pageCount: 1,
    pageUrlClass: "about",
    targetCount: 1,
    workerCount: 0,
  };
  healthyDiagnostic.outcome = "fixed-point-reached";
  healthyDiagnostic.pendingAttaches = [];
  healthyDiagnostic.serviceWorkerBypassed = true;
  healthyDiagnostic.targets = healthyDiagnostic.targets.map(
    (target, index) => ({
      ...target,
      attachComplete: true,
      ...completedCdpTargetSetup({
        cdpIdStart: 100 + index * 10,
        startedAt: 100 + index * 20,
      }),
      resumed: true,
      waitingForDebugger: true,
    }),
  );
  const serviceWorkerSetup = completedCdpTargetSetup({
    cdpIdStart: 200,
    serviceWorker: true,
    startedAt: 500,
  });
  const serviceWorkerTarget = {
    ancestry: [],
    attachComplete: true,
    ...serviceWorkerSetup,
    detached: false,
    identityHash: diagnosticIdentity("service-worker-session", "service-worker-target"),
    parentSessionId: null,
    phase: "desktop-dpr1-zoom100",
    resumed: true,
    sessionId: "service-worker-session",
    targetId: "service-worker-target",
    type: "service_worker",
    urlClass: "app-asset",
    waitingForDebugger: true,
  };
  healthyDiagnostic.targets.push(serviceWorkerTarget);
  healthyDiagnostic.targetBootstrapSettlements = [
    healthyDiagnostic.targetBootstrapSettlements[0],
    {
      identityHash: diagnosticIdentity(
        "document-session",
        "parser-bootstrap-request",
        "worker-session",
        "worker-target",
      ),
      method: "GET",
      phase: "desktop-dpr1-zoom100",
      requestId: "parser-bootstrap-request",
      requestSessionId: "document-session",
      resourceType: "Script",
      targetDetachedAtSettlement: false,
      targetId: "worker-target",
      targetParentSessionId: "document-session",
      targetSessionId: "worker-session",
      targetType: "worker",
      terminalReason: "target-attached",
      urlClass: "pdf-parser-worker",
    },
  ];
  healthyDiagnostic.counts.targetBootstrapSettlementCount = 2;
  healthyDiagnostic.serviceWorkerBootstrapObservations = [{
    earlierRequestCount: 0,
    identityHash: diagnosticIdentity(
      "service-worker-session",
      "service-worker-bootstrap-request",
      "service-worker-session",
      "service-worker-target",
    ),
    method: "GET",
    phase: "desktop-dpr1-zoom100",
    requestId: "service-worker-bootstrap-request",
    requestIsFirst: true,
    requestSequence: 3,
    requestSessionId: "service-worker-session",
    requestStartedAt: serviceWorkerSetup.resumeDispatchedAt + 1,
    resourceType: "Script",
    resumeDispatchedAt: serviceWorkerSetup.resumeDispatchedAt,
    sessionFailureCount: 0,
    sessionRequestCount: 1,
    targetId: "service-worker-target",
    targetDetachedAtObservation: false,
    targetSessionId: "service-worker-session",
    targetType: "service_worker",
    targetUrlMatched: true,
    terminalAt: serviceWorkerSetup.resumeDispatchedAt + 2,
    terminalReason: "loading-finished",
    urlClass: "app-asset",
  }];
  healthyDiagnostic.counts.serviceWorkerBootstrapObservationCount = 1;
  healthyDiagnostic.counts.targetCount = 3;
  healthyDiagnostic.wait.recentSamples = [1, 2, 3].map(
    (stableSamples) => ({
      attachErrorCount: 0,
      attachmentReady: true,
      elapsedMs: 9_700 + stableSamples * 75,
      incompleteTargetCount: 0,
      inflightRequestCount: 0,
      pendingAttachCount: 0,
      requestCount: healthyDiagnostic.counts.requestCount,
      serviceWorkerBypassed: true,
      stableSamples,
      targetCount: healthyDiagnostic.counts.targetCount,
    }),
  );
  healthyDiagnostic.wait.stableSamples = 3;
  assert.equal(isCdpFixedPointDiagnosticHealthy(healthyDiagnostic), true);
  const naturallyDetachedServiceWorker = structuredClone(healthyDiagnostic);
  naturallyDetachedServiceWorker.targets.find(
    (target) => target.type === "service_worker",
  ).detached = true;
  assert.equal(
    isCdpFixedPointDiagnosticHealthy(naturallyDetachedServiceWorker),
    true,
  );
  const report = buildFirstNetworkDiagnosticReport({
    build: { localManifest: { deploymentId: DEPLOYMENT } },
    fixture: {
      bytes: PUBLIC_PDF_FIXTURE_BYTES,
      path: PUBLIC_PDF_FIXTURE,
      sha256: PUBLIC_PDF_FIXTURE_SHA256,
    },
    networkDiagnostic: healthyDiagnostic,
    outputDirectory,
    runnerFailure: null,
    scenario: {
      comparison: { lineLightScreenshot: screenshot },
      id: "desktop-dpr1-zoom100",
    },
    source: { commit: COMMIT, tree: TREE },
    teardown: cleanDiagnosticTeardown,
  });
  assert.equal(report.diagnostic, true);
  assert.equal(report.diagnosticSchemaVersion, 1);
  assert.equal(report.completed, true);
  assert.equal(report.fixedPointReached, true);
  assert.deepEqual(Object.keys(report).sort(), [
    "artifacts",
    "build",
    "completed",
    "diagnostic",
    "diagnosticSchemaVersion",
    "failures",
    "fixedPointReached",
    "fixture",
    "mode",
    "network",
    "recordedAt",
    "scenario",
    "source",
    "teardown",
  ]);
  assert.deepEqual(report.artifacts.screenshots, [screenshot]);
  assert.equal("passed" in report, false);
  assert.equal("schemaVersion" in report, false);
  assert.deepEqual(report.failures, []);

  for (const [name, mutate] of [
    ["attach error", (value) => {
      value.attachErrors.push({
        category: "setup",
        command: "network-enable",
        identityHash: SHA,
        sessionId: "worker-session",
        targetId: "worker-target",
        type: "service_worker",
        urlClass: "app-asset",
      });
      value.counts.attachErrorCount = 1;
    }],
    ["incomplete target", (value) => {
      value.targets[0].attachComplete = false;
    }],
    ["timed-out target command", (value) => {
      value.targets[0].commands[0].status = "failed";
    }],
    ["service worker bypass disabled", (value) => {
      value.serviceWorkerBypassed = false;
    }],
    ["dirty initial target baseline", (value) => {
      value.initialTargetBaseline.workerCount = 1;
      value.initialTargetBaseline.targetCount = 2;
    }],
    ["service worker resumed before setup dispatch", (value) => {
      const target = value.targets.find(
        (entry) => entry.type === "service_worker",
      );
      target.resumeDispatchedAt = target.commands[0].dispatchedAt - 1;
      target.commands.at(-1).dispatchedAt = target.resumeDispatchedAt;
      value.serviceWorkerBootstrapObservations[0].resumeDispatchedAt =
        target.resumeDispatchedAt;
    }],
    ["missing service worker command", (value) => {
      value.targets.find(
        (entry) => entry.type === "service_worker",
      ).commands.pop();
    }],
    ["failed service worker command", (value) => {
      value.targets.find(
        (entry) => entry.type === "service_worker",
      ).commands[0].status = "failed";
    }],
    ["late service worker command", (value) => {
      const target = value.targets.find(
        (entry) => entry.type === "service_worker",
      );
      target.commands[0].resultAt = target.commandDeadlineAt + 1;
    }],
    ["service worker command completed before resume", (value) => {
      const target = value.targets.find(
        (entry) => entry.type === "service_worker",
      );
      target.commands[0].resultAt = target.resumeDispatchedAt - 1;
    }],
    ["nonconsecutive service worker command IDs", (value) => {
      const target = value.targets.find(
        (entry) => entry.type === "service_worker",
      );
      target.commands[2].cdpId += 10;
    }],
    ["duplicate global target command ID", (value) => {
      const firstId = value.targets.find(
        (entry) => entry.type === "worker",
      ).commands[0].cdpId;
      const serviceWorker = value.targets.find(
        (entry) => entry.type === "service_worker",
      );
      serviceWorker.commands.forEach((command, index) => {
        command.cdpId = firstId + index;
      });
    }],
    ["reversed command dispatch timestamp", (value) => {
      const target = value.targets.find((entry) => entry.type === "worker");
      target.commands[1].dispatchedAt = target.commands[0].dispatchedAt - 1;
    }],
    ["reversed command result timestamp", (value) => {
      const target = value.targets.find((entry) => entry.type === "worker");
      const firstResultAt = target.commands[0].resultAt;
      target.commands[0].resultAt = target.commands[1].resultAt;
      target.commands[1].resultAt = firstResultAt;
    }],
    ["missing service worker bootstrap request", (value) => {
      value.serviceWorkerBootstrapObservations[0].requestId = null;
    }],
    ["wrong service worker bootstrap target", (value) => {
      value.serviceWorkerBootstrapObservations[0].targetUrlMatched = false;
    }],
    ["nonterminal service worker bootstrap", (value) => {
      value.serviceWorkerBootstrapObservations[0].terminalReason =
        "loading-failed";
    }],
    ["service worker event before resume barrier", (value) => {
      const observation = value.serviceWorkerBootstrapObservations[0];
      observation.requestStartedAt = observation.resumeDispatchedAt - 1;
      observation.earlierRequestCount = 1;
    }],
    ["detached service worker target", (value) => {
      value.serviceWorkerBootstrapObservations[0]
        .targetDetachedAtObservation = true;
    }],
    ["external request counted", (value) => {
      value.counts.externalRequestCount = 1;
    }],
    ["service worker network failure", (value) => {
      value.counts.networkFailureCount = 1;
      value.serviceWorkerBootstrapObservations[0].sessionFailureCount = 1;
    }],
    ["service worker cannot settle PDF coverage", (value) => {
      const serviceWorker = value.targets.find(
        (entry) => entry.type === "service_worker",
      );
      const parserSettlement = value.targetBootstrapSettlements.find(
        (entry) => entry.urlClass === "pdf-parser-worker",
      );
      parserSettlement.targetId = serviceWorker.targetId;
      parserSettlement.targetSessionId = serviceWorker.sessionId;
      parserSettlement.targetType = serviceWorker.type;
      parserSettlement.identityHash = diagnosticIdentity(
        parserSettlement.requestSessionId,
        parserSettlement.requestId,
        parserSettlement.targetSessionId,
        parserSettlement.targetId,
      );
    }],
    ["missing parser bootstrap settlement", (value) => {
      value.targetBootstrapSettlements.pop();
      value.counts.targetBootstrapSettlementCount -= 1;
    }],
    ["unhealthy stable sample", (value) => {
      value.wait.recentSamples.at(-1).attachmentReady = false;
    }],
    ["wrong first-scenario phase", (value) => {
      const laterPhase = "mobile-dpr3-zoom100";
      value.label = laterPhase;
      for (const target of value.targets) {
        target.phase = laterPhase;
        for (const ancestor of target.ancestry) {
          ancestor.phase = laterPhase;
        }
      }
      for (const settlement of value.targetBootstrapSettlements) {
        settlement.phase = laterPhase;
      }
      for (const observation of value.serviceWorkerBootstrapObservations) {
        observation.phase = laterPhase;
      }
    }],
    ["missing bootstrap request ID", (value) => {
      const settlement = value.targetBootstrapSettlements[0];
      settlement.requestId = null;
      settlement.identityHash = diagnosticIdentity(
        settlement.requestSessionId,
        settlement.requestId,
        settlement.targetSessionId,
        settlement.targetId,
      );
    }],
    ["missing target ID", (value) => {
      const target = value.targets[0];
      const settlement = value.targetBootstrapSettlements[0];
      target.targetId = null;
      target.identityHash = diagnosticIdentity(target.sessionId, target.targetId);
      settlement.targetId = null;
      settlement.identityHash = diagnosticIdentity(
        settlement.requestSessionId,
        settlement.requestId,
        settlement.targetSessionId,
        settlement.targetId,
      );
    }],
    ["missing target session ID", (value) => {
      const target = value.targets[1];
      const settlement = value.targetBootstrapSettlements[1];
      target.sessionId = null;
      target.identityHash = diagnosticIdentity(target.sessionId, target.targetId);
      settlement.targetSessionId = null;
      settlement.identityHash = diagnosticIdentity(
        settlement.requestSessionId,
        settlement.requestId,
        settlement.targetSessionId,
        settlement.targetId,
      );
    }],
    ["duplicate target ID", (value) => {
      const target = value.targets[1];
      const settlement = value.targetBootstrapSettlements[1];
      target.targetId = value.targets[0].targetId;
      target.identityHash = diagnosticIdentity(target.sessionId, target.targetId);
      settlement.targetId = target.targetId;
      settlement.identityHash = diagnosticIdentity(
        settlement.requestSessionId,
        settlement.requestId,
        settlement.targetSessionId,
        settlement.targetId,
      );
    }],
    ["substituted target identity hash", (value) => {
      value.targets[0].identityHash = SHA;
    }],
    ["duplicate bootstrap settlement", (value) => {
      value.targetBootstrapSettlements.push({
        ...value.targetBootstrapSettlements[0],
      });
      value.counts.targetBootstrapSettlementCount += 1;
    }],
    ["unbound parser parent", (value) => {
      const parser = value.targets.find(
        (target) => target.urlClass === "pdf-parser-worker",
      );
      const settlement = value.targetBootstrapSettlements.find(
        (entry) => entry.urlClass === "pdf-parser-worker",
      );
      parser.ancestry = [];
      parser.parentSessionId = null;
      settlement.requestSessionId = null;
      settlement.targetParentSessionId = null;
      settlement.identityHash = diagnosticIdentity(
        settlement.requestSessionId,
        settlement.requestId,
        settlement.targetSessionId,
        settlement.targetId,
      );
    }],
    ["extra attach promise", (value) => {
      value.counts.attachPromiseCount += 1;
    }],
    ["excessive stability counter", (value) => {
      value.wait.stableSamples = 100;
      value.wait.recentSamples.forEach((sample, index) => {
        sample.stableSamples = 98 + index;
      });
    }],
  ]) {
    const unhealthyDiagnostic = structuredClone(healthyDiagnostic);
    mutate(unhealthyDiagnostic);
    assert.equal(
      isCdpFixedPointDiagnosticHealthy(unhealthyDiagnostic),
      name === "wrong first-scenario phase",
      `${name} helper result was unexpected`,
    );
    const unhealthyReport = buildFirstNetworkDiagnosticReport({
      build: report.build,
      fixture: report.fixture,
      networkDiagnostic: unhealthyDiagnostic,
      outputDirectory,
      runnerFailure: null,
      scenario: {
        comparison: { lineLightScreenshot: screenshot },
        id: "desktop-dpr1-zoom100",
      },
      source: report.source,
      teardown: cleanDiagnosticTeardown,
    });
    assert.equal(
      unhealthyReport.fixedPointReached,
      false,
      `${name} snapshot passed`,
    );
    assert.ok(unhealthyReport.failures.length > 0, `${name} exited green`);
    assert.match(
      unhealthyReport.failures.join("\n"),
      /did not reach a fixed point/u,
    );
  }

  const missingScreenshot = buildFirstNetworkDiagnosticReport({
    build: report.build,
    fixture: report.fixture,
    networkDiagnostic: report.network,
    outputDirectory,
    runnerFailure: null,
    scenario: {
      comparison: {},
      id: "desktop-dpr1-zoom100",
    },
    source: report.source,
    teardown: cleanDiagnosticTeardown,
  });
  assert.equal(missingScreenshot.completed, false);
  assert.match(
    missingScreenshot.failures.join("\n"),
    /screenshot manifest is not exact/u,
  );
  const substitutedScreenshot = buildFirstNetworkDiagnosticReport({
    build: report.build,
    fixture: report.fixture,
    networkDiagnostic: report.network,
    outputDirectory,
    runnerFailure: null,
    scenario: {
      comparison: {
        lineLightScreenshot: {
          ...screenshot,
          path: path.relative(
            path.resolve("."),
            path.join(
              os.tmpdir(),
              "other-output",
              path.basename(screenshot.path),
            ),
          ),
        },
      },
      id: "desktop-dpr1-zoom100",
    },
    source: report.source,
    teardown: cleanDiagnosticTeardown,
  });
  assert.equal(substitutedScreenshot.completed, false);
  assert.match(
    substitutedScreenshot.failures.join("\n"),
    /screenshot manifest is not exact/u,
  );

  const wrongScenario = buildFirstNetworkDiagnosticReport({
    build: report.build,
    fixture: report.fixture,
    networkDiagnostic: report.network,
    outputDirectory,
    runnerFailure: null,
    scenario: {
      comparison: { lineLightScreenshot: screenshot },
      id: "desktop-dpr2-zoom100",
    },
    source: report.source,
    teardown: cleanDiagnosticTeardown,
  });
  assert.equal(wrongScenario.completed, false);
  assert.equal(wrongScenario.fixedPointReached, false);
  assert.equal(wrongScenario.scenario.screenshot, null);

  const repositoryOutput = buildFirstNetworkDiagnosticReport({
    build: report.build,
    fixture: report.fixture,
    networkDiagnostic: report.network,
    outputDirectory: path.join(path.resolve("."), "outputs", "diagnostic"),
    runnerFailure: null,
    scenario: {
      comparison: { lineLightScreenshot: screenshot },
      id: "desktop-dpr1-zoom100",
    },
    source: report.source,
    teardown: cleanDiagnosticTeardown,
  });
  assert.equal(repositoryOutput.completed, false);
  assert.equal(repositoryOutput.artifacts.screenshots.length, 0);

  const privateFixturePath = "/tmp/private-reader-document.pdf";
  const privateFixtureReport = buildFirstNetworkDiagnosticReport({
    build: report.build,
    fixture: {
      bytes: 4096,
      path: privateFixturePath,
      sha256: SHA,
    },
    networkDiagnostic: report.network,
    outputDirectory,
    runnerFailure: null,
    scenario: {
      comparison: { lineLightScreenshot: screenshot },
      id: "desktop-dpr1-zoom100",
    },
    source: report.source,
    teardown: cleanDiagnosticTeardown,
  });
  assert.equal(privateFixtureReport.completed, false);
  assert.equal(privateFixtureReport.fixture, null);
  assert.match(
    privateFixtureReport.failures.join("\n"),
    /fixture is not the exact public fixture/u,
  );
  assert.doesNotMatch(
    JSON.stringify(privateFixtureReport),
    /private-reader-document/u,
  );
  for (const [name, fixture] of [
    ["size", { ...report.fixture, bytes: PUBLIC_PDF_FIXTURE_BYTES + 1 }],
    ["hash", { ...report.fixture, sha256: SHA }],
  ]) {
    const substitutedFixtureReport = buildFirstNetworkDiagnosticReport({
      build: report.build,
      fixture,
      networkDiagnostic: report.network,
      outputDirectory,
      runnerFailure: null,
      scenario: {
        comparison: { lineLightScreenshot: screenshot },
        id: "desktop-dpr1-zoom100",
      },
      source: report.source,
      teardown: cleanDiagnosticTeardown,
    });
    assert.equal(
      substitutedFixtureReport.completed,
      false,
      `${name} substitution passed`,
    );
    assert.equal(substitutedFixtureReport.fixture, null);
  }

  const privateTeardown = structuredClone(cleanDiagnosticTeardown);
  privateTeardown.app.error =
    `Could not remove ${privateProfile}?text=${privateText}`;
  privateTeardown.errors = [
    `Browser cleanup failed for ${privateProfile}?text=${privateText}`,
  ];
  const privateFailureReport = buildFirstNetworkDiagnosticReport({
    build: report.build,
    fixture: report.fixture,
    networkDiagnostic: report.network,
    outputDirectory,
    runnerFailure: new Error(
      `Fixed point failed for ${privateProfile}?text=${privateText}`,
    ),
    scenario: {
      comparison: { lineLightScreenshot: screenshot },
      id: "desktop-dpr1-zoom100",
    },
    source: report.source,
    teardown: privateTeardown,
  });
  const serializedPrivateFailure = JSON.stringify(privateFailureReport);
  assert.equal(privateFailureReport.completed, false);
  assert.equal(privateFailureReport.teardown.app.errorPresent, true);
  assert.equal(privateFailureReport.teardown.errorCount, 1);
  assert.doesNotMatch(serializedPrivateFailure, /private-reader-sentence/u);
  assert.doesNotMatch(serializedPrivateFailure, /linelight-private-profile/u);
  assert.doesNotMatch(serializedPrivateFailure, /Could not remove/u);
  assert.doesNotMatch(serializedPrivateFailure, /Fixed point failed/u);

  const timeoutReport = buildFirstNetworkDiagnosticReport({
    build: report.build,
    fixture: report.fixture,
    networkDiagnostic: diagnostic,
    outputDirectory,
    runnerFailure: new Error(
      `Timed out at ${privateProfile}?text=${privateText}`,
    ),
    scenario: {
      comparison: { lineLightScreenshot: screenshot },
      id: "desktop-dpr1-zoom100",
    },
    source: report.source,
    teardown: cleanDiagnosticTeardown,
  });
  assert.equal(timeoutReport.completed, true);
  assert.equal(timeoutReport.fixedPointReached, false);
  assert.equal(timeoutReport.network, diagnostic);
  assert.equal("passed" in timeoutReport, false);
  assert.match(
    timeoutReport.failures.join("\n"),
    /did not reach a fixed point/u,
  );
  assert.doesNotMatch(
    JSON.stringify(timeoutReport),
    /linelight-private-profile/u,
  );
});

test("keeps CDP requests bound to the exact flattened session", () => {
  const appUrl = "http://127.0.0.1:4173/";
  const networkState = {
    attachErrors: [],
    attachPromises: [],
    byId: new Map(),
    completedRequestCount: 0,
    inflightRequests: new Set(),
    pendingAttachMetadata: new Map(),
    pendingAttachPromises: new Set(),
    phase: "desktop-dpr1-zoom100",
    recentActivity: [],
    requests: [],
    targets: [{
      detached: true,
      parentSessionId: null,
      phase: "desktop-dpr1-zoom100",
      sessionId: "current-session",
      targetId: "current-target",
      type: "worker",
      url: `${appUrl}assets/pdf-parser.worker-test.js?secret=true`,
      waitingForDebugger: false,
    }],
  };
  const event = {
    request: {
      method: "GET",
      url: `${appUrl}assets/pdf-parser.worker-test.js?secret=true`,
    },
    requestId: "shared-request-id",
    type: "Script",
  };
  recordCdpNetworkRequest(networkState, event, "current-session");
  const wrongSession = completeCdpNetworkRequest(
    networkState,
    { requestId: event.requestId },
    "restored-session",
  );
  assert.equal(wrongSession, null);
  assert.equal(networkState.completedRequestCount, 0);
  assert.deepEqual(
    [...networkState.inflightRequests],
    ["current-session:shared-request-id"],
  );

  const detachedDiagnostic = buildCdpNetworkFixedPointDiagnostic(
    networkState,
    appUrl,
    "desktop-dpr1-zoom100",
    "timeout",
  );
  assert.equal(detachedDiagnostic.counts.inflightRequestCount, 1);
  assert.equal(detachedDiagnostic.inflightRequests[0].requestId,
    "shared-request-id");
  assert.equal(detachedDiagnostic.inflightRequests[0].sessionId,
    "current-session");
  assert.equal(detachedDiagnostic.targets[0].targetId, "current-target");
  assert.equal(detachedDiagnostic.targets[0].detached, true);

  const exactSession = completeCdpNetworkRequest(
    networkState,
    { requestId: event.requestId },
    "current-session",
  );
  assert.equal(exactSession?.requestId, "shared-request-id");
  assert.equal(networkState.inflightRequests.size, 0);
  assert.equal(networkState.completedRequestCount, 1);
});

test("settles exact worker bootstraps one-to-one in either event order", () => {
  const requestEvent = {
    request: {
      method: "GET",
      url: "http://127.0.0.1/assets/pdf-parser.worker-test.js",
    },
    requestId: "bootstrap-request",
    type: "Script",
  };
  const target = {
    attachComplete: true,
    bootstrapRequestKey: null,
    ...completedCdpTargetSetup({ cdpIdStart: 100, startedAt: 100 }),
    detached: false,
    parentSessionId: "document-session",
    phase: "desktop-dpr1-zoom100",
    resumed: true,
    sessionId: "parser-session",
    targetId: "parser-target",
    type: "worker",
    url: requestEvent.request.url,
    waitingForDebugger: true,
  };
  const createState = () => ({
    byId: new Map(),
    completedRequestCount: 0,
    inflightRequests: new Set(),
    phase: "desktop-dpr1-zoom100",
    requests: [],
    targetBootstrapSettlements: [],
    targets: [],
  });

  const requestFirst = createState();
  recordCdpNetworkRequest(requestFirst, requestEvent, "document-session");
  assert.deepEqual(reconcileCdpTargetBootstrapRequests(requestFirst), []);
  requestFirst.targets.push(structuredClone(target));
  const requestFirstSettlements =
    reconcileCdpTargetBootstrapRequests(requestFirst);
  assert.equal(requestFirstSettlements.length, 1);
  assert.equal(requestFirst.inflightRequests.size, 0);
  assert.equal(requestFirst.completedRequestCount, 1);
  assert.equal(requestFirst.requests.length, 1);
  assert.equal(requestFirstSettlements[0].terminalReason, "target-attached");
  assert.equal(
    requestFirst.requests[0].bootstrapTargetSessionId,
    target.sessionId,
  );
  const lateNetworkTerminal = completeCdpNetworkRequest(
    requestFirst,
    { requestId: requestEvent.requestId },
    "document-session",
  );
  assert.equal(lateNetworkTerminal, null);
  assert.equal(requestFirst.completedRequestCount, 1);
  assert.equal(requestFirst.targetBootstrapSettlements.length, 1);

  const attachFirst = createState();
  attachFirst.targets.push(structuredClone(target));
  assert.deepEqual(reconcileCdpTargetBootstrapRequests(attachFirst), []);
  recordCdpNetworkRequest(attachFirst, requestEvent, "document-session");
  assert.equal(reconcileCdpTargetBootstrapRequests(attachFirst).length, 1);
  assert.equal(attachFirst.inflightRequests.size, 0);

  const matchingRequest = {
    method: "GET",
    phase: target.phase,
    sessionId: target.parentSessionId,
    type: "Script",
    url: target.url,
  };
  assert.equal(isCdpTargetBootstrapRequest(matchingRequest, target), true);
  assert.equal(isCdpTargetSetupComplete(target), true);
  assert.equal(isCdpAttachmentStateHealthy({
    attachErrors: [],
    serviceWorkerBypassed: true,
    targets: [target],
  }), false);
  for (const [name, request, changedTarget] of [
    ["URL", { ...matchingRequest, url: `${target.url}?wrong=1` }, target],
    ["session", { ...matchingRequest, sessionId: "wrong-session" }, target],
    ["method", { ...matchingRequest, method: "POST" }, target],
    ["resource type", { ...matchingRequest, type: "Fetch" }, target],
    ["target type", matchingRequest, { ...target, type: "service_worker" }],
    ["unattached", matchingRequest, { ...target, attachComplete: false }],
    ["failed resume", matchingRequest, { ...target, resumed: false }],
  ]) {
    assert.equal(
      isCdpTargetBootstrapRequest(request, changedTarget),
      false,
      `${name} mismatch settled`,
    );
  }
});

test("requires a clean pre-navigation CDP target baseline", () => {
  assert.deepEqual(
    validateCdpInitialTargetBaseline([
      { targetId: "initial-page", type: "page", url: "about:blank" },
    ]),
    {
      checked: true,
      pageCount: 1,
      pageUrlClass: "about",
      targetCount: 1,
      workerCount: 0,
    },
  );
  for (const [name, targets] of [
    ["missing page", []],
    ["nonblank page", [
      { targetId: "initial-page", type: "page", url: "http://127.0.0.1/" },
    ]],
    ["extra page", [
      { targetId: "initial-page", type: "page", url: "about:blank" },
      { targetId: "second-page", type: "page", url: "about:blank" },
    ]],
    ["unexpected target type", [
      { targetId: "initial-page", type: "page", url: "about:blank" },
      { targetId: "unexpected", type: "other", url: "about:blank" },
    ]],
    ...["worker", "shared_worker", "service_worker"].map((type) => [
      `preexisting ${type}`,
      [
        { targetId: "initial-page", type: "page", url: "about:blank" },
        { targetId: `${type}-target`, type, url: "http://127.0.0.1/worker.js" },
      ],
    ]),
  ]) {
    assert.throws(
      () => validateCdpInitialTargetBaseline(targets),
      /one clean about:blank page and no preexisting worker targets/u,
      name,
    );
  }
});

test("requires exact current-phase PDF bootstrap settlements", () => {
  const appUrl = "http://127.0.0.1/";
  const phase = "desktop-dpr1-zoom100";
  const documentTarget = {
    phase,
    sessionId: "document-session",
    url: `${appUrl}assets/pdf-document.worker-test.js`,
  };
  const parserTarget = {
    phase,
    sessionId: "parser-session",
    url: `${appUrl}assets/pdf-parser.worker-test.js`,
  };
  const state = {
    targetBootstrapSettlements: [documentTarget, parserTarget].map(
      (target) => ({ phase, targetSessionId: target.sessionId }),
    ),
    targets: [documentTarget, parserTarget],
  };
  assert.equal(
    hasCdpPhasePdfBootstrapCoverage(state, appUrl, phase),
    true,
  );
  state.targetBootstrapSettlements.pop();
  assert.equal(
    hasCdpPhasePdfBootstrapCoverage(state, appUrl, phase),
    false,
  );
  assert.equal(
    hasCdpPhasePdfBootstrapCoverage(state, appUrl, "forced-main-fallback"),
    true,
  );
});

test("dispatches paused service-worker setup before one shared deadline", async () => {
  const sent = [];
  const cdp = {
    nextId: 1,
    pending: new Map(),
    webSocket: {
      send(payload) {
        sent.push(JSON.parse(payload));
      },
    },
  };
  const commands = [];
  let settlementStarted = false;
  const result = await dispatchPausedServiceWorkerCommands(
    (name, method, params) => {
      assert.equal(settlementStarted, false);
      const command = {
        cdpId: null,
        deadlineAt: null,
        dispatchedAt: Date.now(),
        dispatchSequence: commands.length + 1,
        method,
        name,
      };
      commands.push(command);
      const dispatch = dispatchToCdpSession(
        cdp,
        method,
        params,
        "service-worker-session",
      );
      command.cdpId = dispatch.id;
      return { ...dispatch, command };
    },
    async (dispatches, deadlineAt) => {
      settlementStarted = true;
      assert.equal(sent.length, 5);
      assert.deepEqual(
        sent.map(({ id, method }) => [id, method]),
        [
          [1, "Network.enable"],
          [2, "Runtime.enable"],
          [3, "Network.setCacheDisabled"],
          [4, "Target.setAutoAttach"],
          [5, "Runtime.runIfWaitingForDebugger"],
        ],
      );
      assert.ok(dispatches.every(
        (dispatch) => dispatch.command.deadlineAt === deadlineAt,
      ));
      for (const id of [5, 1, 2, 3, 4]) {
        const pending = cdp.pending.get(id);
        cdp.pending.delete(id);
        pending.resolve({ id });
      }
      return settleCdpCommandDispatches(cdp, dispatches, deadlineAt);
    },
    1_000,
  );
  assert.equal(cdp.pending.size, 0);
  assert.equal(result.dispatches.length, 5);
  assert.equal(result.resumeDispatchedAt, commands[4].dispatchedAt);
  assert.ok(result.deadlineAt > result.resumeDispatchedAt);
  assert.ok(commands.slice(0, 4).every(
    (command) => command.dispatchedAt <= commands[4].dispatchedAt,
  ));

  const partialCdp = {
    nextId: 1,
    pending: new Map(),
    webSocket: { send() {} },
  };
  const partialCommands = [];
  let partialDispatches = [];
  await assert.rejects(
    dispatchPausedServiceWorkerCommands(
      (name, method, params) => {
        const command = {
          cdpId: null,
          deadlineAt: null,
          dispatchedAt: Date.now(),
          dispatchSequence: partialCommands.length + 1,
          method,
          name,
        };
        partialCommands.push(command);
        const dispatch = dispatchToCdpSession(
          partialCdp,
          method,
          params,
          "partial-service-worker-session",
        );
        command.cdpId = dispatch.id;
        return { ...dispatch, command };
      },
      (dispatches, deadlineAt) => {
        partialDispatches = dispatches;
        for (const id of [1, 5]) {
          const pending = partialCdp.pending.get(id);
          partialCdp.pending.delete(id);
          pending.resolve({ id });
        }
        return settleCdpCommandDispatches(
          partialCdp,
          dispatches,
          deadlineAt,
        );
      },
      5,
    ),
    /Timed out waiting for CDP/u,
  );
  assert.equal(partialCdp.pending.size, 0);
  const partialOutcomes = await Promise.allSettled(
    partialDispatches.map((dispatch) => dispatch.promise),
  );
  assert.equal(
    partialOutcomes.filter(({ status }) => status === "fulfilled").length,
    2,
  );
  assert.equal(
    partialOutcomes.filter(({ status }) => status === "rejected").length,
    3,
  );
});

test("observes the exact first terminal service-worker bootstrap", () => {
  const setup = completedCdpTargetSetup({
    cdpIdStart: 300,
    serviceWorker: true,
    startedAt: 1_000,
  });
  const target = {
    attachComplete: true,
    ...setup,
    detached: false,
    phase: "desktop-dpr1-zoom100",
    resumed: true,
    serviceWorkerBootstrapRequestKey: null,
    sessionId: "service-worker-session",
    targetId: "service-worker-target",
    type: "service_worker",
    url: "http://127.0.0.1/assets/service-worker.js",
    waitingForDebugger: true,
  };
  const request = {
    method: "GET",
    phase: target.phase,
    requestId: "service-worker-request",
    sequence: 1,
    sessionId: target.sessionId,
    startedAt: target.resumeDispatchedAt + 1,
    terminalAt: target.resumeDispatchedAt + 2,
    terminalReason: "loading-finished",
    type: "Script",
    url: target.url,
  };
  assert.equal(isCdpServiceWorkerBootstrapRequest(request, target), true);
  const state = {
    attachErrors: [],
    failures: [],
    requests: [request],
    responseFailures: [],
    serviceWorkerBypassed: true,
    serviceWorkerBootstrapObservations: [],
    targets: [target],
  };
  const observations = reconcileCdpServiceWorkerBootstraps(state);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].requestId, request.requestId);
  assert.equal(target.serviceWorkerBootstrapRequestKey,
    `${target.sessionId}:${request.requestId}`);
  assert.equal(request.serviceWorkerTargetSessionId, target.sessionId);
  assert.equal(isCdpAttachmentStateHealthy(state), true);
  target.detached = true;
  assert.equal(isCdpAttachmentStateHealthy(state), true);
  target.detached = false;
  assert.deepEqual(reconcileCdpServiceWorkerBootstraps(state), []);

  for (const [name, changedRequest, changedTarget] of [
    ["URL", { ...request, url: `${request.url}?wrong=1` }, target],
    ["session", { ...request, sessionId: "wrong-session" }, target],
    ["method", { ...request, method: "POST" }, target],
    ["resource type", { ...request, type: "Fetch" }, target],
    ["target type", request, { ...target, type: "worker" }],
    ["detached target", request, { ...target, detached: true }],
    ["unattached target", request, { ...target, attachComplete: false }],
    ["failed target", request, {
      ...target,
      commands: target.commands.map((command, index) => index === 0
        ? { ...command, status: "failed" }
        : command),
    }],
    ["pre-resume event", {
      ...request,
      startedAt: target.resumeDispatchedAt - 1,
    }, target],
    ["nonterminal request", {
      ...request,
      terminalAt: null,
      terminalReason: null,
    }, target],
  ]) {
    assert.equal(
      isCdpServiceWorkerBootstrapRequest(changedRequest, changedTarget),
      false,
      `${name} mismatch qualified`,
    );
  }

  const earlierRequest = {
    ...request,
    requestId: "earlier-service-worker-request",
    sequence: 0,
    startedAt: target.resumeDispatchedAt - 1,
  };
  assert.deepEqual(reconcileCdpServiceWorkerBootstraps({
    requests: [earlierRequest, { ...request }],
    serviceWorkerBootstrapObservations: [],
    targets: [{ ...target, serviceWorkerBootstrapRequestKey: null }],
  }), []);
});

test("bounds every flattened child-target CDP command", async () => {
  const cdp = {
    nextId: 1,
    pending: new Map(),
    webSocket: { send() {} },
  };
  await assert.rejects(
    sendToCdpSession(
      cdp,
      "Network.enable",
      {},
      "service-worker-session",
      1,
    ),
    /Timed out waiting for CDP Network\.enable/u,
  );
  assert.equal(cdp.pending.size, 0);
  assert.equal(cdp.nextId, 2);
});

test("requires three unchanged quiet CDP samples for a fixed point", () => {
  const quiet = {
    attachmentReady: true,
    inflightRequestCount: 0,
    pendingAttachCount: 0,
    requestCount: 4,
    targetCount: 2,
  };
  let stability = {
    requestCount: -1,
    stableSamples: 0,
    targetCount: -1,
  };
  stability = advanceCdpFixedPointStability(stability, quiet);
  assert.deepEqual(stability, {
    fixedPointReached: false,
    requestCount: 4,
    stableSamples: 0,
    targetCount: 2,
  });
  stability = advanceCdpFixedPointStability(stability, quiet);
  assert.equal(stability.stableSamples, 1);
  stability = advanceCdpFixedPointStability(stability, quiet);
  assert.equal(stability.stableSamples, 2);
  stability = advanceCdpFixedPointStability(stability, quiet);
  assert.equal(stability.stableSamples, 3);
  assert.equal(stability.fixedPointReached, true);

  const almostStable = { ...stability, stableSamples: 2 };
  assert.equal(advanceCdpFixedPointStability(almostStable, {
    ...quiet,
    attachmentReady: false,
  }).stableSamples, 0);
  assert.equal(advanceCdpFixedPointStability(almostStable, {
    ...quiet,
    pendingAttachCount: 1,
  }).stableSamples, 0);
  assert.equal(advanceCdpFixedPointStability(almostStable, {
    ...quiet,
    inflightRequestCount: 1,
  }).stableSamples, 0);
  assert.equal(advanceCdpFixedPointStability(almostStable, {
    ...quiet,
    requestCount: 5,
  }).stableSamples, 0);
  assert.equal(advanceCdpFixedPointStability(almostStable, {
    ...quiet,
    targetCount: 3,
  }).stableSamples, 0);
});

test("keeps fallback probes armed through restored and wrong-page staging", async () => {
  const armed = {
    documentKey: DOCUMENT_KEY,
    page: 2,
    revision: REVISION,
  };
  const attempts = [
    {
      documentKey: "restored-document:restored-revision",
      page: 2,
      revision: "restored-revision",
    },
    {
      documentKey: DOCUMENT_KEY,
      page: 1,
      revision: REVISION,
    },
    {
      documentKey: DOCUMENT_KEY,
      page: 2,
      revision: REVISION,
    },
  ];
  assert.deepEqual(
    attempts.map((attempt) => matchesPdfFallbackInjection(armed, attempt)),
    [false, false, true],
  );

  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  assert.match(
    source,
    /if \(matchesArmedFallbackInjection\(failNextFallback, attempt\)\) \{\s*failNextFallback = null;/u,
  );
  assert.match(
    source,
    /latestImport\?\.documentKey !== documentKey/u,
  );
  assert.match(
    source,
    /latestImport\?\.jobId !== fallbackProofIdentity\.importJobId/u,
  );
});

test("retires restored fallback signals before binding current staging", async () => {
  const restoredController = new AbortController();
  const currentController = new AbortController();
  const restored = {
    bound: false,
    retired: false,
    signal: restoredController.signal,
    signalId: 1,
  };
  const current = {
    bound: false,
    retired: false,
    signal: currentController.signal,
    signalId: 2,
  };
  restoredController.abort();
  const afterRestoreAbort = selectPdfFallbackAbortCandidate([
    restored,
    current,
  ]);
  assert.equal(afterRestoreAbort.candidateCount, 1);
  assert.equal(afterRestoreAbort.candidate, current);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  assert.deepEqual(
    selectPdfFallbackAbortCandidate([{
      bound: false,
      retired: false,
      signal: alreadyAborted.signal,
      signalId: 3,
    }]),
    { candidate: null, candidateCount: 0 },
  );

  const multipleLive = selectPdfFallbackAbortCandidate([
    current,
    {
      bound: false,
      retired: false,
      signal: new AbortController().signal,
      signalId: 4,
    },
  ]);
  assert.equal(multipleLive.candidate, null);
  assert.equal(multipleLive.candidateCount, 2);

  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  assert.match(source, /typeof listener === "function" &&\s*!this\.aborted/u);
  assert.match(source, /reason: 'aborted-before-staging'/u);
  assert.match(
    source,
    /selectFallbackAbortCandidate\(fallbackAbortCandidates\)/u,
  );
});

test("holds the exact cancelled continuation through release and one second", async () => {
  const evidence = passingEvidence();
  const cancellation = evidence.fallback.invisibleCancellation;
  assert.ok(
    cancellation.cancellationTerminal.at < cancellation.exitedAt &&
    cancellation.exitedAt <= cancellation.continuationResumeAt,
  );
  assert.deepEqual(validatePdfSharpnessEvidence(evidence), []);

  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  assert.match(source, /type: "continuation-minimum-elapsed"/u);
  assert.match(
    source,
    /held\.minimumElapsed[\s\S]*held\.releaseRequestedAt[\s\S]*nativeRequestAnimationFrame\(held\.callback\)/u,
  );
  assert.match(
    source,
    /markFallbackViewportExit[\s\S]*matchingCancelRequests\.length !== 1[\s\S]*matchingTerminals\.length !== 1/u,
  );
});

test("sanitizes partial fallback cancellation timeout state", () => {
  const privateDocument = "private-document-name:private-revision";
  const privateRevision = "private-revision";
  const expected = {
    abortSignalId: 3,
    documentKey: privateDocument,
    page: 3,
    renderAttemptId: 7,
    revision: privateRevision,
    stage: "minimum-elapsed",
  };
  const raw = {
    dom: {
      blockPresent: true,
      canvasHeight: 0,
      canvasPresent: true,
      canvasWidth: 0,
      textOverlayCount: 12,
      visible: false,
    },
    events: [
      {
        abortSignalId: 3,
        at: 100,
        documentKey: privateDocument,
        page: 3,
        renderAttemptId: 7,
        revision: privateRevision,
        type: "continuation-delay",
      },
      {
        at: 101,
        documentKey: "different-private-document",
        page: 4,
        revision: "different-private-revision",
        type: "continuation-armed",
      },
    ],
    held: {
      abortSignalId: 3,
      minimumElapsed: true,
      releaseRequestedAt: null,
      renderAttemptId: 7,
      resumed: false,
    },
    rawError: "secret local path /tmp/private-reader-profile",
  };
  const diagnostic = summarizePdfFallbackCancellationDiagnostic(raw, expected);
  assert.equal(diagnostic.counts["continuation-delay"], 1);
  assert.equal(diagnostic.events[0].documentMatches, true);
  assert.equal(diagnostic.events[0].revisionMatches, true);
  assert.equal(diagnostic.held.minimumElapsed, true);
  assert.equal(diagnostic.stage, "minimum-elapsed");
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /private|secret|\/tmp\//u);
  assert.equal(
    JSON.stringify(summarizePdfFallbackCancellationDiagnostic(
      { ...raw, rawError: "a wholly different private failure" },
      expected,
    )),
    serialized,
  );
});

test("sanitizes every held fallback lifecycle failure stage", async () => {
  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  for (const stage of [
    "viewport-exit-request",
    "page-traversal",
    "cancellation-ready",
    "viewport-exit-confirmation",
    "minimum-elapsed",
    "continuation-resume",
  ]) {
    assert.match(source, new RegExp(`cancellationStage = "${stage}"`, "u"));
  }
  assert.match(
    source,
    /cancellationStage = "viewport-exit-request";[\s\S]*try \{[\s\S]*markFallbackViewportExitRequest[\s\S]*scrollPageIntoView\(cdp, 5\)[\s\S]*markFallbackViewportExit[\s\S]*continuation-minimum-elapsed[\s\S]*continuation-resume[\s\S]*catch \{[\s\S]*readFallbackCancellationTimeoutDiagnostic/u,
  );
});

test("marks priority in the same task as the final mounted target scroll", async () => {
  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  assert.match(
    source,
    /scrollPageIntoView\(cdp, intermediatePage\);[\s\S]*waitForPageShell\(cdp, priorityTarget\);[\s\S]*beginPriorityScroll\([^)]*priorityTarget[^)]*\)/u,
  );
  assert.match(source, /adjacent preview to settle before priority action/u);
  assert.doesNotMatch(
    source,
    /mountPdfPageByTraversal\(cdp, priorityTarget\)|beginPriorityProbe|markPriorityScrollAction/u,
  );
  assert.match(
    source,
    /bitmapEventByObject\.set\(message\.bitmap, workerEvent\.eventId\)[\s\S]*bitmapEventByObject\.get\(args\[0\]\)/u,
  );
  assert.match(
    source,
    /activityId: \+\+activitySequence[\s\S]*drawInvocationId: \+\+drawInvocationSequence[\s\S]*priorityProbe: currentPriorityProbe[\s\S]*queueMicrotask/u,
  );
  assert.match(
    source,
    /drawInvocationBoundary: drawInvocationSequence[\s\S]*currentPriorityProbe = \{[\s\S]*block\.scrollIntoView\(\{ behavior: 'instant', block: 'center' \}\);[\s\S]*action\.readerViewportAfter = rectangle\(reader\);[\s\S]*action\.scrollTopAfter = Number\(reader\?\.scrollTop\);[\s\S]*action\.targetGeometryAfter = rectangle\(block\)/u,
  );
  assert.doesNotMatch(
    source,
    /beginPriorityScroll[\s\S]*scrollIntoView\(\{ behavior: 'auto'/u,
  );
  assert.match(
    source,
    /invocation\.priorityProbe[\s\S]*invocation\.drawInvocationId >[\s\S]*scrollAction\.drawInvocationBoundary/u,
  );
  assert.match(
    source,
    /staleBitmapCutoffActivityId = cachedTargetSatisfied[\s\S]*targetComposition\?\.activityId[\s\S]*targetBitmapAfterVisibleRequest\?\.activityId/u,
  );
});

test("owns and tears down one fresh reference session per matrix configuration", async () => {
  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  const captureSource = source.slice(
    source.indexOf("async function captureReferenceScreenshots("),
    source.indexOf("function samplesForPage("),
  );
  assert.match(
    captureSource,
    /for \(const configuration of PDF_SHARPNESS_MATRIX\)[\s\S]*startBrowser\(browserExecutable, true\)[\s\S]*readReferenceCaptureDiagnosticBaseline\(cdp\)[\s\S]*Page\.setLifecycleEventsEnabled[\s\S]*applyMatrixConfiguration\(cdp, configuration, true\)[\s\S]*readReferenceCaptureDiagnosticViewport\(cdp\)[\s\S]*navigateReferenceCaptureDiagnosticPage[\s\S]*waitForReferenceCaptureDiagnosticViewer[\s\S]*waitForRenderedReferenceScreenshot/u,
  );
  assert.match(
    captureSource,
    /finally \{[\s\S]*closeOwnedBrowser\(cdp, browser\)[\s\S]*referenceShutdowns\.push/u,
  );
  assert.match(
    captureSource,
    /screenshots\.set\(configuration\.id, \{[\s\S]*captureLifecycle: lifecycle[\s\S]*terminalError = operationError/u,
  );
  assert.doesNotMatch(
    captureSource,
    /requestedUrl\.hash[\s\S]*startBrowser\(browserExecutable, true\)/u,
  );
});

test("uses composition and bitmap sequence when timer samples tie", () => {
  const evidence = passingEvidence();
  const upgraded = evidence.matrix[2].raster;
  upgraded.sharp.composedAt = upgraded.preview.composedAt;
  assert.deepEqual(validatePdfSharpnessEvidence(evidence), []);
});

test("selects drained Long Tasks by entry start time", () => {
  const malformed = { duration: 1, name: "self", startTime: null };
  assert.deepEqual(
    selectPdfLongTasksForWindow([
      { duration: 1, name: "self", startTime: 9.99 },
      { duration: 1, name: "self", startTime: 10 },
      { duration: 1, name: "self", startTime: 19.99 },
      { duration: 1, name: "self", startTime: 20 },
      malformed,
    ], { finishedAt: 20, startedAt: 10 }),
    [
      { duration: 1, name: "self", startTime: 10 },
      { duration: 1, name: "self", startTime: 19.99 },
      malformed,
    ],
  );
});

test("drains the Long Task observer before scenario snapshots", async () => {
  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  assert.match(source, /longTaskObserver\.takeRecords\(\)/u);
  assert.match(source, /finishScenario[\s\S]*finishedAt = performance\.now\(\);[\s\S]*drainLongTasks\(\)/u);
  assert.match(source, /state\.snapshot = \(\) => \{\s*drainLongTasks\(\)/u);
  assert.doesNotMatch(source, /longTaskStart|longTaskEnd/u);
});

test("independently validates a safety-capped physical-pixel target", () => {
  const evidence = passingEvidence();
  const run = evidence.matrix.at(-1);
  Object.assign(run.raster.sharp, {
    actualHeight: 4096,
    actualWidth: 4096,
    cssHeight: 10_000,
    cssWidth: 10_000,
    pageHeight: 10_000,
    pageWidth: 10_000,
    targetCapped: true,
    targetHeight: 4096,
    targetScale: 0.4096,
    targetWidth: 4096,
  });
  Object.assign(run.raster.preview, {
    actualHeight: 4096,
    actualWidth: 4096,
    composedAt: 10,
    compositionId: 1,
    scale: 0.4096,
  });
  run.raster.previewBeforeSharp = false;
  run.raster.sharp.bitmapEventId = 1;
  run.raster.sharp.composedAt = 10;
  run.raster.sharp.compositionId = 1;
  run.raster.transition = "preview-satisfied-target";
  const cappedFrame = {
    at: 50,
    composedCount: 1,
    composedPages: [{
      geometry: { bottom: 200, left: 20, right: 620, top: 80 },
      geometryVisible: true,
      height: 4096,
      page: 1,
      pixels: PDF_SHARPNESS_MAX_RASTER_PIXELS,
      visible: true,
      width: 4096,
    }],
    composedPixels: PDF_SHARPNESS_MAX_RASTER_PIXELS,
    geometryVisiblePages: [1],
    readerViewport: { bottom: 700, left: 0, right: 700, top: 0 },
    visiblePages: [1],
  };
  run.canvasBudget.maximumCount = 1;
  run.canvasBudget.maximumCountFrame = structuredClone(cappedFrame);
  run.canvasBudget.maximumPixels = PDF_SHARPNESS_MAX_RASTER_PIXELS;
  run.canvasBudget.maximumPixelsFrame = structuredClone(cappedFrame);
  assert.deepEqual(validatePdfSharpnessEvidence(evidence), []);

  run.raster.sharp.targetCapped = false;
  assert.match(
    validatePdfSharpnessEvidence(evidence).join("\n"),
    /computed capped target/u,
  );
});

test("requires at least one strict preview-to-sharp upgrade in the matrix", () => {
  const evidence = passingEvidence();
  for (const run of evidence.matrix) {
    if (run.raster.transition !== "preview-to-sharp-upgrade") continue;
    const physicalRatio =
      run.viewport.devicePixelRatio * run.viewport.visualViewportScale;
    Object.assign(run.raster.sharp, {
      actualHeight: 800,
      actualWidth: 600,
      bitmapEventId: 1,
      composedAt: 10,
      compositionId: 1,
      cssHeight: 400 / physicalRatio,
      cssWidth: 300 / physicalRatio,
      pageHeight: 800,
      pageWidth: 600,
      targetCapped: false,
      targetHeight: 800,
      targetScale: 1,
      targetWidth: 600,
    });
    Object.assign(run.raster.preview, {
      actualHeight: 800,
      actualWidth: 600,
      bitmapEventId: 1,
      composedAt: 10,
      compositionId: 1,
      scale: 1,
    });
    run.raster.previewBeforeSharp = false;
    run.raster.transition = "preview-satisfied-target";
  }
  assert.match(
    validatePdfSharpnessEvidence(evidence).join("\n"),
    /did not prove any strict preview-to-sharp raster upgrade/u,
  );
});

test("rejects each material Issue 68 acceptance regression", async (t) => {
  const cases = [
    ["legacy evidence schema", (value) => {
      value.schemaVersion = 2;
    }, /schemaVersion must be 3/u],
    ["live zoom transition", (value) => {
      value.matrix[1].viewport.transition = "normal";
    }, /live zoom transition/u],
    ["undersampled backing", (value) => {
      value.matrix[0].raster.sharp.actualWidth =
        value.matrix[0].raster.sharp.targetWidth - 1;
    }, /computed capped target/u],
    ["oversized backing", (value) => {
      value.matrix[0].raster.sharp.actualWidth += 1;
    }, /computed capped target/u],
    ["incorrect capped target", (value) => {
      value.matrix[0].raster.sharp.targetCapped = true;
    }, /computed capped target/u],
    ["non-quarter-step target", (value) => {
      value.matrix[2].raster.sharp.targetScale += 0.125;
    }, /computed capped target/u],
    ["self-reported raster target", (value) => {
      value.matrix[5].raster.sharp.targetWidth = 600;
    }, /computed capped target/u],
    ["independent CSS raster dimensions", (value) => {
      value.matrix[2].raster.sharp.cssWidth = 300;
      value.matrix[2].raster.sharp.cssHeight = 400;
    }, /computed capped target/u],
    ["preview policy", (value) => {
      value.matrix[0].raster.preview.scale = 1.5;
    }, /adjacent 1\.25x preview/u],
    ["connected preview composition", (value) => {
      value.matrix[0].raster.preview.connectedCanvas = false;
    }, /adjacent 1\.25x preview/u],
    ["independent preview scale", (value) => {
      value.matrix[0].raster.preview.scale = 1;
    }, /preview backing/u],
    ["independent preview dimensions", (value) => {
      value.matrix[0].raster.preview.actualWidth -= 1;
    }, /preview backing|transition proof/u],
    ["satisfied target reuses composition", (value) => {
      value.matrix[0].raster.sharp.composedAt = 20;
      value.matrix[0].raster.sharp.compositionId = 2;
      value.matrix[0].raster.sharp.bitmapEventId = 2;
    }, /transition proof/u],
    ["larger target cannot collapse into preview", (value) => {
      const raster = value.matrix[2].raster;
      raster.transition = "preview-satisfied-target";
      raster.previewBeforeSharp = false;
      raster.sharp.composedAt = raster.preview.composedAt;
      raster.sharp.compositionId = raster.preview.compositionId;
      raster.sharp.bitmapEventId = raster.preview.bitmapEventId;
    }, /transition proof/u],
    ["upgrade composition sequence", (value) => {
      value.matrix[2].raster.sharp.compositionId =
        value.matrix[2].raster.preview.compositionId;
    }, /transition proof/u],
    ["upgrade bitmap sequence", (value) => {
      value.matrix[2].raster.sharp.bitmapEventId =
        value.matrix[2].raster.preview.bitmapEventId;
    }, /transition proof/u],
    ["preview composition order", (value) => {
      value.matrix[0].raster.preview.composedAt = 25;
    }, /transition proof/u],
    ["blank reference viewer", (value) => {
      value.matrix[0].comparison.referenceReadiness.renderedPage = false;
      value.matrix[0].comparison.referenceReadiness.inkPixels = 0;
      value.matrix[0].comparison.referenceReadiness.inkRatio = 0;
    }, /rendered-page pixel proof/u],
    ["missing reference segmentation version", (value) => {
      delete value.matrix[0].comparison.referenceReadiness.segmentationVersion;
    }, /rendered-page pixel proof/u],
    ["forged reference proof", (value) => {
      value.matrix[0].comparison.referenceReadiness.proof =
        "white-page-with-any-ink";
    }, /rendered-page pixel proof/u],
    ["missing reference winner area", (value) => {
      delete value.matrix[0].comparison.referenceReadiness.winnerWhiteArea;
    }, /rendered-page pixel proof/u],
    ["missing reference runner-up area", (value) => {
      delete value.matrix[0].comparison.referenceReadiness.runnerUpWhiteArea;
    }, /rendered-page pixel proof/u],
    ["missing reference substantial count", (value) => {
      delete value.matrix[0].comparison.referenceReadiness
        .substantialComponentCount;
    }, /rendered-page pixel proof/u],
    ["missing reference dominance", (value) => {
      delete value.matrix[0].comparison.referenceReadiness
        .winnerDominanceRatio;
    }, /rendered-page pixel proof/u],
    ["forged reference substantial count", (value) => {
      value.matrix[0].comparison.referenceReadiness.substantialComponentCount = 0;
    }, /rendered-page pixel proof/u],
    ["forged reference winner area", (value) => {
      const readiness = value.matrix[0].comparison.referenceReadiness;
      readiness.winnerWhiteArea = readiness.runnerUpWhiteArea;
      readiness.winnerDominanceRatio = 1;
    }, /rendered-page pixel proof/u],
    ["forged reference dominance", (value) => {
      value.matrix[0].comparison.referenceReadiness.winnerDominanceRatio += 1;
    }, /rendered-page pixel proof/u],
    ["reference full inset page pixels", (value) => {
      const readiness = value.matrix[0].comparison.referenceReadiness;
      readiness.pagePixels -= 1;
      readiness.pageWhiteRatio =
        readiness.pageWhitePixels / readiness.pagePixels;
      readiness.inkRatio = readiness.inkPixels / readiness.pagePixels;
    }, /rendered-page pixel proof/u],
    ["reference full interior white capacity", (value) => {
      const readiness = value.matrix[0].comparison.referenceReadiness;
      readiness.pageWhitePixels =
        readiness.winnerWhiteArea -
          (readiness.pageBounds.width * readiness.pageBounds.height -
            readiness.pagePixels) - 1;
      readiness.pageWhiteRatio =
        readiness.pageWhitePixels / readiness.pagePixels;
    }, /rendered-page pixel proof/u],
    ["reference full exact white ratio", (value) => {
      value.matrix[0].comparison.referenceReadiness.pageWhiteRatio += 9e-7;
    }, /rendered-page pixel proof/u],
    ["reference full exact ink ratio", (value) => {
      value.matrix[0].comparison.referenceReadiness.inkRatio += 9e-7;
    }, /rendered-page pixel proof/u],
    ["reference full exact dominance ratio", (value) => {
      value.matrix[0].comparison.referenceReadiness.winnerDominanceRatio +=
        5e-10;
    }, /rendered-page pixel proof/u],
    ["missing requested reference target", (value) => {
      delete value.matrix[0].comparison.referenceTarget;
    }, /requested top page/u],
    ["adjacent reference winner substituted for target", (value) => {
      makeAdjacentReferenceComponentTheGlobalWinner(value.matrix[0]);
      const target = value.matrix[0].comparison.referenceTarget;
      target.selectedComponentIndex = 1;
      target.cropBounds = { ...target.components[1].bounds };
    }, /requested top page/u],
    ["reference target component order", (value) => {
      makeAdjacentReferenceComponentTheGlobalWinner(value.matrix[0]);
      value.matrix[0].comparison.referenceTarget.components.reverse();
    }, /requested top page/u],
    ["reference target phantom component", (value) => {
      const target = value.matrix[0].comparison.referenceTarget;
      target.components.push(structuredClone(target.components[0]));
    }, /requested top page/u],
    ["reference correlated component area overflow", (value) => {
      forgeCorrelatedReferenceComponentAreaOverflow(value.matrix[0]);
    }, /requested top page/u],
    ["reference impossible connected component area", (value) => {
      forgeImpossibleConnectedReferenceComponent(value.matrix[0]);
    }, /requested top page/u],
    ["reference full runner exceeds omitted-component maximum", (value) => {
      const readiness = value.matrix[0].comparison.referenceReadiness;
      const minimumWidth = Math.max(120, Math.ceil(readiness.width * 0.25));
      const minimumHeight = Math.max(80, Math.ceil(readiness.height * 0.25));
      readiness.runnerUpWhiteArea = Math.max(
        (minimumWidth - 1) * readiness.height,
        readiness.width * (minimumHeight - 1),
      ) + 1;
      readiness.winnerDominanceRatio =
        readiness.winnerWhiteArea / readiness.runnerUpWhiteArea;
    }, /requested top page/u],
    ["reference target runner exceeds omitted-component maximum", (value) => {
      const readiness = value.matrix[0].comparison.referenceTarget.readiness;
      const minimumWidth = Math.max(120, Math.ceil(readiness.width * 0.25));
      const minimumHeight = Math.max(80, Math.ceil(readiness.height * 0.25));
      readiness.runnerUpWhiteArea = Math.max(
        (minimumWidth - 1) * readiness.height,
        readiness.width * (minimumHeight - 1),
      ) + 1;
      readiness.winnerDominanceRatio =
        readiness.winnerWhiteArea / readiness.runnerUpWhiteArea;
    }, /requested top page/u],
    ["reference listed runner exceeds reported runner", (value) => {
      forgeListedReferenceRunner(value.matrix[0]);
    }, /requested top page/u],
    ["reference listed winner tie is hidden by runner", (value) => {
      forgeListedReferenceRunner(value.matrix[0], { tied: true });
    }, /requested top page/u],
    ["reference target anchor ambiguity", (value) => {
      makeAdjacentReferenceComponentTheGlobalWinner(value.matrix[0]);
      const run = value.matrix[0];
      const target = run.comparison.referenceTarget;
      target.components[1].bounds.y = target.components[0].bounds.y + 1;
      run.comparison.referenceReadiness.substantialComponents[1]
        .pageBounds.y = target.components[1].bounds.y;
      run.comparison.referenceReadiness.pageBounds.y =
        target.components[1].bounds.y;
    }, /requested top page/u],
    ["reference target crop metrics", (value) => {
      value.matrix[0].comparison.referenceTarget.readiness.renderedPage = false;
    }, /requested top page/u],
    ["reference target crop inset pixels", (value) => {
      value.matrix[0].comparison.referenceTarget.readiness.pagePixels += 1;
    }, /requested top page/u],
    ["reference target crop white ratio", (value) => {
      value.matrix[0].comparison.referenceTarget.readiness.pageWhiteRatio +=
        0.01;
    }, /requested top page/u],
    ["reference target interior white capacity", (value) => {
      const readiness = value.matrix[0].comparison.referenceTarget.readiness;
      readiness.pageWhitePixels =
        readiness.winnerWhiteArea -
          (readiness.pageBounds.width * readiness.pageBounds.height -
            readiness.pagePixels) - 1;
      readiness.pageWhiteRatio =
        readiness.pageWhitePixels / readiness.pagePixels;
    }, /requested top page/u],
    ["reference target crop ink gates", (value) => {
      value.matrix[0].comparison.referenceTarget.readiness.inkRowBands = 1;
    }, /requested top page/u],
    ["reference target impossible ink bands", (value) => {
      const readiness = value.matrix[0].comparison.referenceTarget.readiness;
      const insetY = Math.max(2, Math.floor(readiness.pageBounds.height * 0.01));
      readiness.inkRowBands =
        Math.ceil((readiness.pageBounds.height - insetY * 2) / 3) + 1;
    }, /requested top page/u],
    ["reference target disjoint white and ink pixels", (value) => {
      const readiness = value.matrix[0].comparison.referenceTarget.readiness;
      readiness.inkPixels =
        readiness.pagePixels - readiness.pageWhitePixels + 1;
      readiness.inkRatio = readiness.inkPixels / readiness.pagePixels;
    }, /requested top page/u],
    ["reference target fractional ink span", (value) => {
      value.matrix[0].comparison.referenceTarget.readiness.inkSpanRatio =
        0.6500001;
    }, /requested top page/u],
    ["reference target exact ink span quotient", (value) => {
      const readiness = value.matrix[0].comparison.referenceTarget.readiness;
      const insetX = Math.max(2, Math.floor(readiness.pageBounds.width * 0.01));
      const interiorWidth = readiness.pageBounds.width - insetX * 2;
      const spanPixels = Math.round(readiness.inkSpanRatio * interiorWidth);
      readiness.inkSpanRatio = (spanPixels + 5e-8) / interiorWidth;
    }, /requested top page/u],
    ["reference target crop winner", (value) => {
      value.matrix[0].comparison.referenceTarget.readiness.winnerWhiteArea -= 1;
    }, /requested top page/u],
    ["reference target requested page", (value) => {
      value.matrix[0].comparison.referenceTarget.requestedPage = 3;
    }, /requested top page/u],
    ["reference lifecycle missing", (value) => {
      delete value.matrix[0].comparison.referenceReadiness.captureLifecycle;
    }, /isolated loader lifecycle/u],
    ["reference lifecycle configuration", (value) => {
      value.matrix[0].comparison.referenceReadiness.captureLifecycle
        .configurationId = value.matrix[1].id;
    }, /isolated loader lifecycle/u],
    ["reference lifecycle baseline", (value) => {
      value.matrix[0].comparison.referenceReadiness.captureLifecycle
        .baseline.workerCount = 1;
    }, /isolated loader lifecycle/u],
    ["reference lifecycle stale loader", (value) => {
      value.matrix[0].comparison.referenceReadiness.captureLifecycle
        .navigation.lifecycleLoaderIdentityHash = "f".repeat(64);
    }, /isolated loader lifecycle/u],
    ["reference lifecycle stale frame", (value) => {
      value.matrix[0].comparison.referenceReadiness.captureLifecycle
        .navigation.frameIdentityHash = "f".repeat(64);
    }, /isolated loader lifecycle/u],
    ["reference lifecycle viewport relation", (value) => {
      value.matrix[4].comparison.referenceReadiness.captureLifecycle
        .viewer.viewport.visualViewportWidth += 1;
    }, /isolated loader lifecycle/u],
    ["reference lifecycle DPR", (value) => {
      value.matrix[4].comparison.referenceReadiness.captureLifecycle
        .viewer.viewport.devicePixelRatio += 0.01;
    }, /isolated loader lifecycle/u],
    ["reference lifecycle screen", (value) => {
      value.matrix[4].comparison.referenceReadiness.captureLifecycle
        .configuredViewport.screenWidth += 1;
    }, /isolated loader lifecycle/u],
    ["reference lifecycle pinch", (value) => {
      value.matrix[5].comparison.referenceReadiness.captureLifecycle
        .configuredViewport.visualViewportScale = 1;
    }, /isolated loader lifecycle/u],
    ["reference lifecycle layout stability", (value) => {
      value.matrix[4].comparison.referenceReadiness.captureLifecycle
        .viewer.viewport.innerWidth += 2;
    }, /isolated loader lifecycle/u],
    ["reference lifecycle native mobile layout width", (value) => {
      const lifecycle = value.matrix[4].comparison.referenceReadiness
        .captureLifecycle;
      const innerWidth = 10_000;
      const innerHeight = innerWidth * 844 / 390;
      Object.assign(lifecycle.configuredViewport, {
        innerHeight,
        innerWidth,
      });
      Object.assign(lifecycle.viewer.viewport, {
        innerHeight,
        innerWidth,
        visualViewportHeight: innerHeight,
        visualViewportScale: 390 / innerWidth,
        visualViewportWidth: innerWidth,
      });
    }, /isolated loader lifecycle/u],
    ["reference lifecycle fractional DOM layout height", (value) => {
      const lifecycle = value.matrix[4].comparison.referenceReadiness
        .captureLifecycle;
      lifecycle.configuredViewport.innerHeight += 0.5;
      lifecycle.viewer.viewport.innerHeight += 0.5;
    }, /isolated loader lifecycle/u],
    ["stale priority", (value) => {
      value.matrix[0].visibleFirst.firstPostScrollCompositionPage = 3;
    }, /current viewport first/u],
    ["cached priority undersized bitmap", (value) => {
      value.matrix[0].visibleFirst.targetBefore.latestBitmapWidth -= 1;
    }, /current viewport first/u],
    ["cached priority wrong bitmap identity", (value) => {
      value.matrix[0].visibleFirst.targetComposition.bitmapEventId += 1;
    }, /current viewport first/u],
    ["cached priority manufactured render request", (value) => {
      value.matrix[0].visibleFirst.targetVisibleRequest = structuredClone(
        value.matrix[2].visibleFirst.targetVisibleRequest,
      );
    }, /current viewport first/u],
    ["cached priority hidden redundant target chain", (value) => {
      const cached = value.matrix[0].visibleFirst;
      const rendered = value.matrix[2].visibleFirst;
      const request = structuredClone(rendered.targetVisibleRequest);
      request.visible = false;
      cached.targetRenderRequestCount = 1;
      cached.targetRenderRequests = [request];
      cached.targetBitmapCount = 1;
      cached.targetBitmaps = [structuredClone(
        rendered.targetBitmapAfterVisibleRequest,
      )];
    }, /current viewport first/u],
    ["cached priority missing request array", (value) => {
      delete value.matrix[0].visibleFirst.targetRenderRequests;
    }, /current viewport first/u],
    ["cached priority missing bitmap array", (value) => {
      delete value.matrix[0].visibleFirst.targetBitmaps;
    }, /current viewport first/u],
    ["render priority wrong first visible request", (value) => {
      value.matrix[2].visibleFirst.firstPostScrollVisibleRequestPage = 5;
    }, /current viewport first/u],
    ["render priority wrong target bitmap", (value) => {
      value.matrix[2].visibleFirst.targetBitmapAfterVisibleRequest.pageNumber = 5;
    }, /current viewport first/u],
    ["render priority duplicate target chain", (value) => {
      const priority = value.matrix[2].visibleFirst;
      priority.targetRenderRequestCount = 2;
      priority.targetRenderRequests.push(structuredClone(
        priority.targetRenderRequests[0],
      ));
      priority.targetBitmapCount = 2;
      priority.targetBitmaps.push(structuredClone(priority.targetBitmaps[0]));
    }, /current viewport first/u],
    ["priority composition before scroll action", (value) => {
      value.matrix[2].visibleFirst.targetComposition.at = 99;
    }, /current viewport first/u],
    ["priority equal-time pre-boundary composition", (value) => {
      const priority = value.matrix[2].visibleFirst;
      priority.targetComposition.at = priority.scrollAction.at;
      priority.targetComposition.drawInvocationId =
        priority.scrollAction.drawInvocationBoundary;
    }, /current viewport first/u],
    ["priority missing action activity identity", (value) => {
      delete value.matrix[2].visibleFirst.scrollAction.activityId;
    }, /current viewport first/u],
    ["priority request activity before action", (value) => {
      value.matrix[2].visibleFirst.targetVisibleRequest.activityId = 99;
      value.matrix[2].visibleFirst.targetRenderRequests[0].activityId = 99;
    }, /current viewport first/u],
    ["priority bitmap activity before request", (value) => {
      const priority = value.matrix[2].visibleFirst;
      priority.targetBitmapAfterVisibleRequest.activityId = 109;
      priority.targetBitmaps[0].activityId = 109;
    }, /current viewport first/u],
    ["priority composition geometry misses reader", (value) => {
      value.matrix[2].visibleFirst.targetComposition.geometry = {
        bottom: 900,
        left: 20,
        right: 620,
        top: 800,
      };
    }, /current viewport first/u],
    ["priority action did not move scroll position", (value) => {
      const action = value.matrix[2].visibleFirst.scrollAction;
      action.scrollTopAfter = action.scrollTopBefore;
    }, /current viewport first/u],
    ["priority target was already visible before instant scroll", (value) => {
      const action = value.matrix[2].visibleFirst.scrollAction;
      action.targetGeometryBefore = {
        bottom: 650,
        left: 20,
        right: 620,
        top: 50,
      };
    }, /current viewport first/u],
    ["priority target remained offscreen after instant scroll", (value) => {
      const action = value.matrix[2].visibleFirst.scrollAction;
      action.targetGeometryAfter = {
        bottom: 1_600,
        left: 20,
        right: 620,
        top: 800,
      };
    }, /current viewport first/u],
    ["priority composition activity stayed at action boundary", (value) => {
      const priority = value.matrix[0].visibleFirst;
      priority.targetComposition.activityId = priority.scrollAction.activityId;
    }, /current viewport first/u],
    ["priority draw invocation stayed at action boundary", (value) => {
      const priority = value.matrix[0].visibleFirst;
      priority.targetComposition.drawInvocationId =
        priority.scrollAction.drawInvocationBoundary;
    }, /current viewport first/u],
    ["cached priority bitmap preempts target composition", (value) => {
      value.matrix[0].visibleFirst.nonTargetBitmaps[0].activityId = 105;
    }, /current viewport first/u],
    ["render priority bitmap preempts target bitmap", (value) => {
      value.matrix[2].visibleFirst.nonTargetBitmaps[0].activityId = 115;
    }, /current viewport first/u],
    ["priority missing non-target bitmap sequence", (value) => {
      delete value.matrix[2].visibleFirst.nonTargetBitmaps;
    }, /current viewport first/u],
    ["priority non-visible composition", (value) => {
      value.matrix[2].visibleFirst.staleNonVisibleCompositions.push({
        page: 3,
        visible: false,
      });
    }, /current viewport first/u],
    ["priority lacks a cached path", (value) => {
      for (const run of value.matrix) {
        if (run.visibleFirst.targetPath !== "cached-target") continue;
        run.visibleFirst.targetPath = "render-required";
      }
    }, /cached and render-required/u],
    ["visible canvas duplicate page", (value) => {
      value.matrix[0].canvasBudget.maximumCountFrame.composedPages[1].page = 1;
    }, /visible composed-canvas budget/u],
    ["visible canvas count mismatch", (value) => {
      value.matrix[0].canvasBudget.maximumCountFrame.composedCount += 1;
    }, /visible composed-canvas budget/u],
    ["visible canvas pixel sum mismatch", (value) => {
      value.matrix[0].canvasBudget.maximumPixelsFrame.composedPixels += 1;
    }, /visible composed-canvas budget/u],
    ["visible canvas marked offscreen", (value) => {
      value.matrix[4].canvasBudget.maximumCountFrame.composedPages[2].visible = false;
    }, /visible composed-canvas budget/u],
    ["visible canvas membership mismatch", (value) => {
      value.matrix[4].canvasBudget.maximumPixelsFrame.visiblePages.pop();
    }, /visible composed-canvas budget/u],
    ["visible canvas per-page pixel mismatch", (value) => {
      value.matrix[0].canvasBudget.maximumCountFrame.composedPages[0].pixels += 1;
    }, /visible composed-canvas budget/u],
    ["visible canvas correlated false geometry", (value) => {
      const frame = value.matrix[4].canvasBudget.maximumCountFrame;
      frame.composedPages[2].geometry = {
        bottom: 900,
        left: 20,
        right: 620,
        top: 800,
      };
    }, /visible composed-canvas budget/u],
    ["visible canvas count-peak contradicts pixel peak", (value) => {
      const run = value.matrix[0];
      const frame = run.canvasBudget.maximumCountFrame;
      frame.composedPages[0].width += 1;
      frame.composedPages[0].pixels =
        frame.composedPages[0].width * frame.composedPages[0].height;
      frame.composedPixels = frame.composedPages.reduce(
        (sum, page) => sum + page.pixels,
        0,
      );
    }, /visible composed-canvas budget/u],
    ["visible canvas pixel-peak contradicts count peak", (value) => {
      const run = value.matrix[0];
      const frame = run.canvasBudget.maximumPixelsFrame;
      const firstPixels = frame.composedPages[0].pixels;
      Object.assign(frame.composedPages[0], {
        height: 1,
        pixels: firstPixels - 1,
        width: firstPixels - 1,
      });
      frame.composedPages.push({
        geometry: { bottom: 540, left: 20, right: 620, top: 440 },
        geometryVisible: true,
        height: 1,
        page: 3,
        pixels: 1,
        visible: true,
        width: 1,
      });
      frame.composedCount = 3;
      frame.geometryVisiblePages.push(3);
      frame.visiblePages.push(3);
    }, /visible composed-canvas budget/u],
    ["visible canvas pixel cap", (value) => {
      const run = value.matrix[5];
      run.canvasBudget.maximumPixels = PDF_SHARPNESS_MAX_BITMAP_PIXELS + 1;
      run.canvasBudget.maximumPixelsFrame.composedPixels =
        PDF_SHARPNESS_MAX_BITMAP_PIXELS + 1;
    }, /visible composed-canvas budget/u],
    ["offscreen shell", (value) => {
      value.matrix[0].release.shellRetained = false;
    }, /retain its offscreen text/u],
    ["long task", (value) => {
      value.matrix[0].longTasks[0].duration = 50.01;
    }, /Long Task over 50ms/u],
    ["missing matrix Long Task evidence", (value) => {
      delete value.matrix[0].longTasks;
    }, /Long Task evidence is missing/u],
    ["malformed matrix Long Task evidence", (value) => {
      value.matrix[0].longTasks[0].startTime = null;
    }, /Long Task evidence is malformed/u],
    ["per-scenario alignment", (value) => {
      value.matrix[5].alignment.configurationId = value.matrix[0].id;
    }, /highlight\/narration alignment/u],
    ["pinned overflow probe", (value) => {
      value.bitmapBudget.pinnedPeak = { count: 8, pixels: 32_000_000 };
    }, /bitmap budget probe failed/u],
    ["fallback serialization", (value) => {
      value.fallback.maximumConcurrentStaging = 2;
    }, /fallback cancellation\/retry/u],
    ["fallback retry identity", (value) => {
      value.fallback.retry.retryAttemptId = 3;
    }, /fallback cancellation\/retry/u],
    ["fallback retry revision", (value) => {
      value.fallback.retry.revision = "substituted-revision";
    }, /fallback cancellation\/retry/u],
    ["fallback retry abort signal", (value) => {
      value.fallback.stagingEvents.find(
        (event) =>
          event.type === "visible-compose" &&
          event.renderAttemptId === value.fallback.retry.retryAttemptId,
      ).abortSignalId = 99;
    }, /fallback cancellation\/retry/u],
    ["fallback retry ambiguous signal binding", (value) => {
      value.fallback.stagingEvents.find(
        (event) =>
          event.type === "staging-start" && event.renderAttemptId === 2,
      ).abortSignalCandidateCount = 2;
    }, /fallback cancellation\/retry/u],
    ["fallback missing injected outcome", (value) => {
      value.fallback.stagingEvents = value.fallback.stagingEvents.filter(
        (event) => event.outcome !== "injected-failure",
      );
    }, /fallback cancellation\/retry/u],
    ["fallback missing injection arm", (value) => {
      value.fallback.stagingEvents = value.fallback.stagingEvents.filter(
        (event) => event.type !== "injection-armed",
      );
    }, /fallback cancellation\/retry/u],
    ["fallback injection arm wrong document", (value) => {
      value.fallback.stagingEvents.find(
        (event) => event.type === "injection-armed",
      ).documentKey = "restored-document:restored-revision";
    }, /fallback cancellation\/retry/u],
    ["fallback injection arm wrong page", (value) => {
      value.fallback.stagingEvents.find(
        (event) => event.type === "injection-armed",
      ).page = 1;
    }, /fallback cancellation\/retry/u],
    ["fallback cancellation", (value) => {
      value.fallback.invisibleCancellation.completedAfterExit = true;
    }, /fallback cancellation\/retry/u],
    ["fallback missing minimum elapsed", (value) => {
      value.fallback.stagingEvents = value.fallback.stagingEvents.filter(
        (event) => event.type !== "continuation-minimum-elapsed",
      );
    }, /fallback cancellation\/retry/u],
    ["fallback early automatic resume order", (value) => {
      const events = value.fallback.stagingEvents;
      const resumeIndex = events.findIndex(
        (event) => event.type === "continuation-resume",
      );
      const [resume] = events.splice(resumeIndex, 1);
      const requestIndex = events.findIndex(
        (event) => event.type === "viewport-exit-request",
      );
      events.splice(requestIndex, 0, resume);
    }, /fallback cancellation\/retry/u],
    ["fallback release before terminal order", (value) => {
      const events = value.fallback.stagingEvents;
      const exitIndex = events.findIndex((event) => event.type === "viewport-exit");
      const [exit] = events.splice(exitIndex, 1);
      const terminalIndex = events.findIndex(
        (event) => event.outcome === "cancelled",
      );
      events.splice(terminalIndex, 0, exit);
    }, /fallback cancellation\/retry/u],
    ["fallback resume release identity", (value) => {
      value.fallback.stagingEvents.find(
        (event) => event.type === "continuation-resume",
      ).releaseRequestedAt += 1;
    }, /fallback cancellation\/retry/u],
    ["fallback minimum hold duration", (value) => {
      value.fallback.stagingEvents.find(
        (event) => event.type === "continuation-minimum-elapsed",
      ).afterMs = 999;
    }, /fallback cancellation\/retry/u],
    ["fallback minimum hold inconsistent clock", (value) => {
      value.fallback.stagingEvents.find(
        (event) => event.type === "continuation-minimum-elapsed",
      ).at = 1099;
      value.fallback.invisibleCancellation.continuationMinimumElapsedAt = 1099;
    }, /fallback cancellation\/retry/u],
    ["fallback cancellation signal mismatch", (value) => {
      value.fallback.stagingEvents.find(
        (event) => event.type === "cancel-request",
      ).abortSignalId = 99;
    }, /fallback cancellation\/retry/u],
    ["fallback cancellation signal reuse", (value) => {
      const replacement = value.fallback.retry.retryAbortSignalId;
      const cancellation = value.fallback.invisibleCancellation;
      cancellation.abortSignalId = replacement;
      cancellation.viewportExit.abortSignalId = replacement;
      cancellation.viewportExitRequest.abortSignalId = replacement;
      for (const event of value.fallback.stagingEvents) {
        if (event.abortSignalId === CANCELLATION_ABORT_SIGNAL_ID) {
          event.abortSignalId = replacement;
        }
      }
    }, /fallback cancellation\/retry/u],
    ["fallback cancellation ambiguous signal binding", (value) => {
      value.fallback.stagingEvents.find(
        (event) =>
          event.type === "staging-start" && event.renderAttemptId === 7,
      ).abortSignalCandidateCount = 2;
    }, /fallback cancellation\/retry/u],
    ["fallback cancellation signal registration", (value) => {
      value.fallback.stagingEvents = value.fallback.stagingEvents.filter(
        (event) =>
          event.type !== "abort-signal-registered" ||
          event.abortSignalId !== CANCELLATION_ABORT_SIGNAL_ID,
      );
    }, /fallback cancellation\/retry/u],
    ["missing cancellation terminal", (value) => {
      value.fallback.stagingEvents = value.fallback.stagingEvents.filter(
        (event) => event.outcome !== "cancelled",
      );
    }, /fallback cancellation\/retry/u],
    ["wrong cancellation terminal attempt", (value) => {
      value.fallback.invisibleCancellation.cancellationTerminal
        .renderAttemptId = 8;
    }, /fallback cancellation\/retry/u],
    ["wrong cancellation terminal outcome", (value) => {
      value.fallback.stagingEvents.find(
        (event) => event.outcome === "cancelled",
      ).outcome = "released";
    }, /fallback cancellation\/retry/u],
    ["cancellation terminal before cancel request", (value) => {
      value.fallback.invisibleCancellation.cancellationTerminal.at = 139;
    }, /fallback cancellation\/retry/u],
    ["cancellation terminal after continuation resume", (value) => {
      value.fallback.invisibleCancellation.cancellationTerminal.at = 1101;
    }, /fallback cancellation\/retry/u],
    ["fallback continuation delay", (value) => {
      value.fallback.invisibleCancellation.continuationDelayObserved = false;
    }, /fallback cancellation\/retry/u],
    ["fallback missing continuation arm", (value) => {
      value.fallback.stagingEvents = value.fallback.stagingEvents.filter(
        (event) => event.type !== "continuation-armed",
      );
    }, /fallback cancellation\/retry/u],
    ["fallback continuation arm wrong document", (value) => {
      value.fallback.stagingEvents.find(
        (event) => event.type === "continuation-armed",
      ).documentKey = "restored-document:restored-revision";
    }, /fallback cancellation\/retry/u],
    ["fallback continuation arm wrong page", (value) => {
      value.fallback.stagingEvents.find(
        (event) => event.type === "continuation-armed",
      ).page = 4;
    }, /fallback cancellation\/retry/u],
    ["fallback continuation callback", (value) => {
      value.fallback.stagingEvents.find(
        (event) => event.type === "continuation-delay",
      ).callbackName = "unrelated animation";
    }, /fallback cancellation\/retry/u],
    ["fallback manufactured page mismatch", (value) => {
      value.fallback.stagingEvents.find(
        (event) => event.type === "continuation-delay",
      ).page = 4;
    }, /fallback cancellation\/retry/u],
    ["fallback resume attempt mismatch", (value) => {
      value.fallback.stagingEvents.find(
        (event) => event.type === "continuation-resume",
      ).renderAttemptId = 8;
    }, /fallback cancellation\/retry/u],
    ["fallback exit attempt mismatch", (value) => {
      value.fallback.invisibleCancellation.viewportExit.renderAttemptId = 8;
    }, /fallback cancellation\/retry/u],
    ["fallback missing exit request", (value) => {
      value.fallback.stagingEvents = value.fallback.stagingEvents.filter(
        (event) => event.type !== "viewport-exit-request",
      );
    }, /fallback cancellation\/retry/u],
    ["fallback duplicate continuation event", (value) => {
      value.fallback.stagingEvents.push({
        ...value.fallback.stagingEvents.find(
          (event) => event.type === "continuation-resume",
        ),
      });
    }, /fallback cancellation\/retry/u],
    ["fallback abort before exit request", (value) => {
      const request = value.fallback.stagingEvents.find(
        (event) => event.type === "viewport-exit-request",
      );
      request.at = 141;
      value.fallback.invisibleCancellation.viewportExitRequest.at = 141;
      value.fallback.invisibleCancellation.exitRequestedAt = 141;
    }, /fallback cancellation\/retry/u],
    ["fallback compose after cancel before exit observation", (value) => {
      const cancellation = value.fallback.invisibleCancellation;
      const exitIndex = value.fallback.stagingEvents.findIndex(
        (event) => event.type === "viewport-exit",
      );
      value.fallback.stagingEvents.splice(exitIndex, 0, {
        abortSignalId: cancellation.abortSignalId,
        at: 147,
        documentKey: cancellation.documentKey,
        page: cancellation.page,
        pageDerivation: cancellation.pageDerivation,
        pageMatchesAttempt: true,
        renderAttemptId: cancellation.renderAttemptId,
        revision: cancellation.revision,
        sourcePage: cancellation.page,
        type: "visible-compose",
      });
    }, /fallback cancellation\/retry/u],
    ["fallback compose missing timestamp", (value) => {
      const cancellation = value.fallback.invisibleCancellation;
      const exitRequestIndex = value.fallback.stagingEvents.findIndex(
        (event) => event.type === "viewport-exit-request",
      );
      value.fallback.stagingEvents.splice(exitRequestIndex, 0, {
        abortSignalId: cancellation.abortSignalId,
        documentKey: cancellation.documentKey,
        page: cancellation.page,
        pageDerivation: cancellation.pageDerivation,
        pageMatchesAttempt: true,
        renderAttemptId: cancellation.renderAttemptId,
        revision: cancellation.revision,
        sourcePage: cancellation.page,
        type: "visible-compose",
      });
    }, /fallback cancellation\/retry/u],
    ["fallback compose sequenced after boundary with earlier time", (value) => {
      const cancellation = value.fallback.invisibleCancellation;
      const exitRequestIndex = value.fallback.stagingEvents.findIndex(
        (event) => event.type === "viewport-exit-request",
      );
      value.fallback.stagingEvents.splice(exitRequestIndex + 1, 0, {
        abortSignalId: cancellation.abortSignalId,
        at: 120,
        documentKey: cancellation.documentKey,
        page: cancellation.page,
        pageDerivation: cancellation.pageDerivation,
        pageMatchesAttempt: true,
        renderAttemptId: cancellation.renderAttemptId,
        revision: cancellation.revision,
        sourcePage: cancellation.page,
        type: "visible-compose",
      });
    }, /fallback cancellation\/retry/u],
    ["fallback compose timestamps are nonmonotonic", (value) => {
      const cancellation = value.fallback.invisibleCancellation;
      const exitRequestIndex = value.fallback.stagingEvents.findIndex(
        (event) => event.type === "viewport-exit-request",
      );
      const compose = (at) => ({
        abortSignalId: cancellation.abortSignalId,
        at,
        documentKey: cancellation.documentKey,
        page: cancellation.page,
        pageDerivation: cancellation.pageDerivation,
        pageMatchesAttempt: true,
        renderAttemptId: cancellation.renderAttemptId,
        revision: cancellation.revision,
        sourcePage: cancellation.page,
        type: "visible-compose",
      });
      value.fallback.stagingEvents.splice(
        exitRequestIndex,
        0,
        compose(125),
        compose(124),
      );
    }, /fallback cancellation\/retry/u],
    ["fallback continuation resume", (value) => {
      value.fallback.invisibleCancellation.continuationResumeObserved = false;
    }, /fallback cancellation\/retry/u],
    ["fallback continuation resume timing", (value) => {
      value.fallback.invisibleCancellation.continuationResumedAfterMs = 500;
    }, /fallback cancellation\/retry/u],
    ["missing fallback Long Task evidence", (value) => {
      delete value.fallback.longTasks;
    }, /fallback Long Task evidence is missing/u],
    ["malformed fallback Long Task evidence", (value) => {
      value.fallback.longTasks[0].name = "";
    }, /fallback Long Task evidence is malformed/u],
    ["fallback Long Task threshold", (value) => {
      value.fallback.longTasks[0].duration = 50.01;
    }, /fallback recorded a Long Task over 50ms/u],
    ["network privacy", (value) => {
      value.network.externalRequests.push({ url: "https://example.test/pdf" });
    }, /recursively attached worker network/u],
    ["recursive worker coverage", (value) => {
      value.network.coverageTargets.forcedParserWorker = [];
    }, /recursively attached worker network/u],
    ["matrix phase target coverage", (value) => {
      value.network.matrixCoverage[PDF_SHARPNESS_MATRIX[5].id]
        .documentTargets = [];
    }, /recursively attached worker network/u],
    ["matrix phase request coverage", (value) => {
      value.network.matrixCoverage[PDF_SHARPNESS_MATRIX[4].id]
        .parserRequestCount = 0;
    }, /recursively attached worker network/u],
    ["service worker bypass", (value) => {
      value.network.serviceWorkerBypassed = false;
    }, /recursively attached worker network/u],
    ["clean initial target baseline", (value) => {
      value.network.initialTargetBaseline.workerCount = 1;
      value.network.initialTargetBaseline.targetCount = 2;
    }, /recursively attached worker network/u],
    ["service worker resume dispatch ordering", (value) => {
      const target = value.network.targets.find(
        (entry) => entry.type === "service_worker",
      );
      target.resumeDispatchedAt = target.commands[0].dispatchedAt - 1;
      target.commands.at(-1).dispatchedAt = target.resumeDispatchedAt;
    }, /recursively attached worker network/u],
    ["service worker missing setup command", (value) => {
      value.network.targets.find(
        (entry) => entry.type === "service_worker",
      ).commands.pop();
    }, /recursively attached worker network/u],
    ["service worker failed setup command", (value) => {
      value.network.targets.find(
        (entry) => entry.type === "service_worker",
      ).commands[0].status = "failed";
    }, /recursively attached worker network/u],
    ["service worker late setup result", (value) => {
      const target = value.network.targets.find(
        (entry) => entry.type === "service_worker",
      );
      target.commands[0].resultAt = target.commandDeadlineAt + 1;
    }, /recursively attached worker network/u],
    ["service worker setup result before resume", (value) => {
      const target = value.network.targets.find(
        (entry) => entry.type === "service_worker",
      );
      target.commands[0].resultAt = target.resumeDispatchedAt - 1;
    }, /recursively attached worker network/u],
    ["service worker nonconsecutive command IDs", (value) => {
      value.network.targets.find(
        (entry) => entry.type === "service_worker",
      ).commands[2].cdpId += 10;
    }, /recursively attached worker network/u],
    ["duplicate global target command ID", (value) => {
      const firstId = value.network.targets.find(
        (entry) => entry.type === "worker",
      ).commands[0].cdpId;
      const serviceWorker = value.network.targets.find(
        (entry) => entry.type === "service_worker",
      );
      serviceWorker.commands.forEach((command, index) => {
        command.cdpId = firstId + index;
      });
    }, /recursively attached worker network/u],
    ["reversed command dispatch timestamp", (value) => {
      const target = value.network.targets.find(
        (entry) => entry.type === "worker",
      );
      target.commands[1].dispatchedAt = target.commands[0].dispatchedAt - 1;
    }, /recursively attached worker network/u],
    ["reversed command result timestamp", (value) => {
      const target = value.network.targets.find(
        (entry) => entry.type === "worker",
      );
      const firstResultAt = target.commands[0].resultAt;
      target.commands[0].resultAt = target.commands[1].resultAt;
      target.commands[1].resultAt = firstResultAt;
    }, /recursively attached worker network/u],
    ["service worker missing bootstrap observation", (value) => {
      value.network.serviceWorkerBootstrapObservations = [];
    }, /recursively attached worker network/u],
    ["service worker wrong bootstrap URL", (value) => {
      value.network.serviceWorkerBootstrapObservations[0].url += "?wrong=1";
    }, /recursively attached worker network/u],
    ["service worker nonterminal bootstrap", (value) => {
      const request = value.network.requests.find(
        (entry) => entry.serviceWorkerTargetSessionId,
      );
      request.terminalReason = "loading-failed";
      value.network.serviceWorkerBootstrapObservations[0].terminalReason =
        request.terminalReason;
    }, /recursively attached worker network/u],
    ["service worker bootstrap before resume", (value) => {
      const target = value.network.targets.find(
        (entry) => entry.type === "service_worker",
      );
      const request = value.network.requests.find(
        (entry) => entry.serviceWorkerTargetSessionId,
      );
      request.startedAt = target.resumeDispatchedAt - 1;
      value.network.serviceWorkerBootstrapObservations[0].requestStartedAt =
        request.startedAt;
    }, /recursively attached worker network/u],
    ["detached service worker bootstrap", (value) => {
      value.network.serviceWorkerBootstrapObservations[0]
        .targetDetachedAtObservation = true;
    }, /recursively attached worker network/u],
    ["service worker cannot satisfy PDF bootstrap", (value) => {
      const serviceWorker = value.network.targets.find(
        (entry) => entry.type === "service_worker",
      );
      const settlement = value.network.targetBootstrapSettlements.find(
        (entry) => entry.targetType === "worker",
      );
      settlement.targetId = serviceWorker.targetId;
      settlement.targetSessionId = serviceWorker.sessionId;
      settlement.targetType = serviceWorker.type;
    }, /recursively attached worker network/u],
    ["fixed-point attach health", (value) => {
      value.network.networkFixedPoints[0].attachmentReady = false;
    }, /recursively attached worker network/u],
    ["fixed-point attach error", (value) => {
      value.network.networkFixedPoints[0].attachErrorCount = 1;
    }, /recursively attached worker network/u],
    ["fixed-point service worker bypass", (value) => {
      value.network.networkFixedPoints[0].serviceWorkerBypassed = false;
    }, /recursively attached worker network/u],
    ["bootstrap settlement URL", (value) => {
      value.network.targetBootstrapSettlements[0].url += "?wrong=1";
    }, /recursively attached worker network/u],
    ["bootstrap settlement session", (value) => {
      value.network.targetBootstrapSettlements[0].requestSessionId =
        "wrong-session";
    }, /recursively attached worker network/u],
    ["bootstrap settlement method", (value) => {
      value.network.targetBootstrapSettlements[0].method = "POST";
    }, /recursively attached worker network/u],
    ["bootstrap settlement resource type", (value) => {
      value.network.targetBootstrapSettlements[0].resourceType = "Fetch";
    }, /recursively attached worker network/u],
    ["bootstrap settlement target type", (value) => {
      value.network.targetBootstrapSettlements[0].targetType =
        "service_worker";
    }, /recursively attached worker network/u],
    ["bootstrap settlement unattached target", (value) => {
      const targetSession =
        value.network.targetBootstrapSettlements[0].targetSessionId;
      value.network.targets.find(
        (target) => target.sessionId === targetSession,
      ).attachComplete = false;
    }, /recursively attached worker network/u],
    ["bootstrap settlement failed target command", (value) => {
      const targetSession =
        value.network.targetBootstrapSettlements[0].targetSessionId;
      value.network.targets.find(
        (target) => target.sessionId === targetSession,
      ).commands[0].status = "failed";
    }, /recursively attached worker network/u],
    ["bootstrap settlement duplicate identity", (value) => {
      value.network.targetBootstrapSettlements.push({
        ...value.network.targetBootstrapSettlements[0],
      });
      for (const point of value.network.networkFixedPoints) {
        point.targetBootstrapSettlementCount += 1;
      }
    }, /recursively attached worker network/u],
    ["matrix phase bootstrap settlement coverage", (value) => {
      value.network.matrixCoverage[PDF_SHARPNESS_MATRIX[0].id]
        .documentBootstrapSettlementCount = 0;
    }, /recursively attached worker network/u],
    ["recursive attach fixed point", (value) => {
      value.network.networkFixedPoints.pop();
    }, /recursively attached worker network/u],
    ["network still in flight", (value) => {
      value.network.inflightRequestCount = 1;
    }, /recursively attached worker network/u],
    ["actual network arrays", (value) => {
      delete value.network.failures;
    }, /recursively attached worker network/u],
    ["artifact binding", (value) => {
      value.artifacts.sourceCommit = "d".repeat(40);
    }, /exact source and deployment/u],
    ["source file omission", (value) => {
      delete value.source.files[PDF_SHARPNESS_SOURCE_FILES[0]];
    }, /exact reviewed file set/u],
    ["source file substitution", (value) => {
      delete value.source.files[PDF_SHARPNESS_SOURCE_FILES[0]];
      value.source.files["app/unreviewed-substitute.mjs"] = SHA;
    }, /exact reviewed file set/u],
    ["screenshot omission", (value) => {
      value.artifacts.screenshots.pop();
    }, /exactly enumerate the reviewed screenshots/u],
    ["screenshot filename substitution", (value) => {
      value.matrix[0].comparison.referenceScreenshot.path =
        "outputs/issue-68/substitute.png";
    }, /exactly enumerate the reviewed screenshots/u],
    ["duplicate screenshot path", (value) => {
      value.artifacts.screenshots.at(-1).path =
        value.artifacts.screenshots[0].path;
    }, /exactly enumerate the reviewed screenshots/u],
    ["screenshot hash reference substitution", (value) => {
      value.artifacts.screenshots[0] = {
        ...value.artifacts.screenshots[0],
        sha256: "f".repeat(64),
      };
    }, /exactly enumerate the reviewed screenshots/u],
    ["teardown", (value) => {
      value.teardown.app.profileRemoved = false;
    }, /tear down cleanly/u],
    ["reference teardown", (value) => {
      value.teardown.reference.processClosed = false;
    }, /tear down cleanly/u],
    ["reference teardown session missing", (value) => {
      value.teardown.referenceSessions.pop();
    }, /tear down cleanly/u],
    ["reference teardown extra session", (value) => {
      value.teardown.referenceSessions.push(
        structuredClone(value.teardown.referenceSessions[0]),
      );
    }, /tear down cleanly/u],
    ["reference teardown session order", (value) => {
      value.teardown.referenceSessions.reverse();
    }, /tear down cleanly/u],
    ["reference teardown duplicate profile", (value) => {
      value.teardown.referenceSessions[1].sessionIdentityHash =
        value.teardown.referenceSessions[0].sessionIdentityHash;
      value.matrix[1].comparison.referenceReadiness.captureLifecycle
        .sessionIdentityHash = value.teardown.referenceSessions[0]
          .sessionIdentityHash;
    }, /tear down cleanly/u],
    ["reference teardown lifecycle mismatch", (value) => {
      value.teardown.referenceSessions[0].sessionIdentityHash = "f".repeat(64);
    }, /tear down cleanly/u],
    ["reference teardown partial failure", (value) => {
      value.teardown.referenceSessions[2].errorPresent = true;
    }, /tear down cleanly/u],
    ["server teardown", (value) => {
      value.teardown.server.processClosed = false;
    }, /tear down cleanly/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const evidence = passingEvidence();
      mutate(evidence);
      assert.match(validatePdfSharpnessEvidence(evidence).join("\n"), pattern);
    });
  }
});

test("fails closed without throwing on omitted arrays and numeric fields", () => {
  assert.doesNotThrow(() => validatePdfSharpnessEvidence({}));
  const evidence = passingEvidence();
  delete evidence.matrix[0].longTasks;
  delete evidence.matrix[0].runtimeErrors;
  delete evidence.matrix[0].visibleFirst.staleWorkerBitmaps;
  delete evidence.bitmapBudget.peak.pixels;
  delete evidence.fallback.longTasks;
  delete evidence.network.attachErrors;
  delete evidence.teardown.errors;
  const failures = validatePdfSharpnessEvidence(evidence);
  assert.ok(failures.length >= 7);
});

test("decodes CDP-style RGBA PNG scanlines for reference analysis", () => {
  const chunk = (type, data) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0);
    result.write(type, 4, 4, "ascii");
    data.copy(result, 8);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([
      0,
      250, 250, 250, 255,
      30, 30, 30, 255,
    ]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const decoded = decodePngScreenshot(png);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 1);
  assert.deepEqual(
    Array.from(decoded.pixels),
    [250, 250, 250, 255, 30, 30, 30, 255],
  );
});

function createReferencePixels(width, height, value = 70) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function paintReferenceRectangle(
  pixels,
  width,
  { height, value, width: rectangleWidth, x, y },
) {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + rectangleWidth; column += 1) {
      const offset = (row * width + column) * 4;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
}

test("segments a rendered PDF page from disconnected viewer white stripes", () => {
  const width = 400;
  const height = 300;
  const pixels = createReferencePixels(width, height);
  paintReferenceRectangle(pixels, width, {
    height: 270,
    value: 250,
    width: 90,
    x: 10,
    y: 20,
  });
  paintReferenceRectangle(pixels, width, {
    height: 250,
    value: 250,
    width: 240,
    x: 140,
    y: 30,
  });
  for (const y of [80, 120, 160, 200]) {
    paintReferenceRectangle(pixels, width, {
      height: 4,
      value: 30,
      width: 160,
      x: 180,
      y,
    });
  }

  const rendered = analyzeReferencePixels({ height, pixels, width });
  assert.equal(rendered.segmentationVersion, 2);
  assert.equal(rendered.proof, "white-page-with-rendered-ink");
  assert.equal(rendered.substantialComponentCount, 1);
  assert.deepEqual(
    rendered.pageBounds,
    { height: 250, width: 240, x: 140, y: 30 },
  );
  assert.equal(rendered.runnerUpWhiteArea, 90 * 270);
  assert.equal(
    rendered.winnerDominanceRatio,
    rendered.winnerWhiteArea / rendered.runnerUpWhiteArea,
  );
  assert.equal(rendered.renderedPage, true);
  assert.ok(rendered.inkRowBands >= 4);
  assert.ok(rendered.inkSpanRatio > 0.5);
});

test("crops the unique top-anchored requested page when an adjacent page is larger", () => {
  const width = 400;
  const height = 600;
  const pixels = createReferencePixels(width, height);
  for (const y of [20, 330]) {
    paintReferenceRectangle(pixels, width, {
      height: 250,
      value: 250,
      width: 240,
      x: 80,
      y,
    });
  }
  for (const y of [70, 110, 150, 190]) {
    paintReferenceRectangle(pixels, width, {
      height: 4,
      value: 30,
      width: 160,
      x: 120,
      y,
    });
  }
  for (const y of [390, 450]) {
    paintReferenceRectangle(pixels, width, {
      height: 4,
      value: 30,
      width: 160,
      x: 120,
      y,
    });
  }
  const decoded = { height, pixels, width };
  const analysis = analyzeReferencePixels(decoded);
  const target = analyzeReferenceTarget(decoded, 3, analysis);
  assert.equal(analysis.renderedPage, true);
  assert.equal(analysis.pageBounds.y, 330);
  assert.equal(target.requestedPage, 3);
  assert.equal(target.selectedComponentIndex, 0);
  assert.equal(target.cropBounds.y, 20);
  assert.equal(target.readiness.renderedPage, true);
  assert.deepEqual(
    target.readiness.pageBounds,
    { height: 250, width: 240, x: 0, y: 0 },
  );

  const ambiguous = structuredClone(target);
  ambiguous.components[1].bounds.y = 100;
  assert.ok(ambiguous.components[1].bounds.y < ambiguous.anchorLimit);
});

test("rejects blank pages, spinners, stripes, toolbars, and clipped pages", () => {
  const width = 240;
  const height = 180;
  const createPage = () => {
    const pixels = createReferencePixels(width, height);
    paintReferenceRectangle(pixels, width, {
      height: 150,
      value: 250,
      width: 190,
      x: 25,
      y: 20,
    });
    return pixels;
  };

  const blank = analyzeReferencePixels({
    height,
    pixels: createPage(),
    width,
  });
  assert.equal(blank.renderedPage, false);
  assert.equal(blank.inkPixels, 0);

  const spinnerPixels = createPage();
  paintReferenceRectangle(spinnerPixels, width, {
    height: 20,
    value: 30,
    width: 20,
    x: 110,
    y: 85,
  });
  const spinner = analyzeReferencePixels({
    height,
    pixels: spinnerPixels,
    width,
  });
  assert.ok(spinner.inkPixels >= 100);
  assert.equal(spinner.inkRowBands, 1);
  assert.equal(spinner.renderedPage, false);

  for (const rectangle of [
    { height: 180, width: 80, x: 0, y: 0 },
    { height: 60, width: 240, x: 0, y: 0 },
    { height: 79, width: 180, x: 20, y: 20 },
  ]) {
    const pixels = createReferencePixels(width, height);
    paintReferenceRectangle(pixels, width, {
      ...rectangle,
      value: 250,
    });
    const result = analyzeReferencePixels({ height, pixels, width });
    assert.equal(result.substantialComponentCount, 0);
    assert.equal(result.pageBounds, null);
    assert.equal(result.renderedPage, false);
  }
});

test("fails closed when white-page components are absent or tied", () => {
  const absent = analyzeReferencePixels({
    height: 180,
    pixels: createReferencePixels(240, 180),
    width: 240,
  });
  assert.equal(absent.substantialComponentCount, 0);
  assert.equal(absent.winnerWhiteArea, 0);
  assert.equal(absent.runnerUpWhiteArea, 0);
  assert.equal(absent.winnerDominanceRatio, null);
  assert.equal(absent.renderedPage, false);

  const width = 500;
  const height = 300;
  const pixels = createReferencePixels(width, height);
  for (const x of [30, 290]) {
    paintReferenceRectangle(pixels, width, {
      height: 200,
      value: 250,
      width: 180,
      x,
      y: 50,
    });
  }
  const tied = analyzeReferencePixels({ height, pixels, width });
  assert.equal(tied.substantialComponentCount, 2);
  assert.equal(tied.winnerWhiteArea, 36_000);
  assert.equal(tied.runnerUpWhiteArea, 36_000);
  assert.equal(tied.winnerDominanceRatio, 1);
  assert.equal(tied.pageBounds, null);
  assert.equal(tied.renderedPage, false);
});

test("binds fallback delay to a real attempt instead of a caller page", async () => {
  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  assert.match(source, /delayNextContinuation\(1000\)/u);
  assert.match(source, /arguments\.length !== 1/u);
  assert.match(
    source,
    /matchesArmedFallbackInjection\(delayNextContinuation, attempt\)/u,
  );
  assert.doesNotMatch(source, /delayNextContinuation\(1000,\s*3\)/u);
});

test("requires exact worker model completion before traversing virtualized pages", async () => {
  const restoredDocumentKey = "restored-document:restored-revision";
  const restoredRevision = "restored-revision";
  const restoredEvents = [
    {
      at: 1,
      direction: "to-worker",
      documentKey: restoredDocumentKey,
      jobId: 1,
      revision: restoredRevision,
      type: "open",
    },
    ...Array.from({ length: 6 }, (_, index) => ({
      at: index + 2,
      direction: "from-worker",
      documentKey: restoredDocumentKey,
      jobId: 1,
      pageNumber: index + 1,
      revision: restoredRevision,
      type: "page",
    })),
    {
      at: 8,
      completedPages: 6,
      direction: "from-worker",
      jobId: 1,
      pageCount: 6,
      revision: restoredRevision,
      type: "progress",
    },
    {
      at: 9,
      direction: "from-worker",
      documentKey: restoredDocumentKey,
      jobId: 1,
      pageCount: 6,
      revision: restoredRevision,
      type: "complete",
    },
  ];
  const pageEvents = Array.from({ length: 6 }, (_, index) => ({
    at: index + 101,
    direction: "from-worker",
    documentKey: DOCUMENT_KEY,
    jobId: 2,
    pageNumber: index + 1,
    revision: REVISION,
    type: "page",
  }));
  const events = [
    ...restoredEvents,
    {
      at: 100,
      direction: "to-worker",
      documentKey: DOCUMENT_KEY,
      jobId: 2,
      revision: REVISION,
      type: "import",
    },
    ...pageEvents,
    {
      at: 107,
      completedPages: 6,
      direction: "from-worker",
      jobId: 2,
      pageCount: 6,
      revision: REVISION,
      type: "progress",
    },
    {
      at: 108,
      direction: "from-worker",
      documentKey: DOCUMENT_KEY,
      jobId: 2,
      pageCount: 6,
      revision: REVISION,
      type: "complete",
    },
  ];
  assert.equal(summarizePdfModelCompletion(events, 6).complete, true);
  assert.equal(summarizePdfModelCompletion(restoredEvents, 6).complete, false);
  assert.equal(
    summarizePdfModelCompletion(events.slice(0, -1), 6).complete,
    false,
  );
  assert.equal(
    summarizePdfModelCompletion(
      events.map((event) =>
        event.type === "progress" && event.jobId === 2
          ? { ...event, pageCount: 7 }
          : event,
      ),
      6,
    ).complete,
    false,
  );
  assert.equal(
    summarizePdfModelCompletion([...events, pageEvents[5]], 6).complete,
    false,
  );
  assert.equal(
    summarizePdfModelCompletion(
      events.filter(
        (event) => event.type !== "page" || event.pageNumber !== 6,
      ),
      6,
    ).complete,
    false,
  );
  assert.equal(
    summarizePdfModelCompletion(
      events.map((event) =>
        event.type === "page" && event.jobId === 2 && event.pageNumber === 6
          ? { ...event, revision: "substituted-revision" }
          : event,
      ),
      6,
    ).complete,
    false,
  );
  assert.equal(
    summarizePdfModelCompletion(
      events.map((event) =>
        event.type === "progress" && event.jobId === 2
          ? { ...event, revision: "substituted-revision" }
          : event,
      ),
      6,
    ).complete,
    false,
  );
  assert.equal(
    summarizePdfModelCompletion(
      events.map((event) =>
        event.type === "page" && event.jobId === 2 && event.pageNumber === 6
          ? { ...event, documentKey: restoredDocumentKey }
          : event,
      ),
      6,
    ).complete,
    false,
  );
  assert.equal(
    summarizePdfModelCompletion([
      ...events,
      {
        at: 200,
        direction: "to-worker",
        documentKey: "new-document:new-revision",
        jobId: 3,
        revision: "new-revision",
        type: "import",
      },
    ], 6).complete,
    false,
  );
  assert.equal(
    summarizePdfModelCompletion([
      ...events,
      {
        at: 200,
        direction: "to-worker",
        documentKey: null,
        jobId: 3,
        revision: null,
        type: "import",
      },
    ], 6).complete,
    false,
  );

  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  assert.equal(
    source.match(/waitForPdfModelCompletion\(cdp, 6\)/gu)?.length,
    3,
  );
  assert.doesNotMatch(source, /waitForPageShell\(cdp, 6\)/u);
  assert.match(
    source,
    /mountPdfPageByTraversal\(cdp, pageNumber\);[\s\S]*waitForPageShell\(cdp, pageNumber\)/u,
  );
  assert.match(source, /PDF_VIRTUAL_SCROLL_MAX_STEPS/u);
  assert.match(source, /requestAnimationFrame\(\(\) =>[\s\S]*requestAnimationFrame/u);
  assert.doesNotMatch(source, /PDF_PAGE_(?:CHROME|GAP)/u);
});

test("plans bounded sub-viewport traversal toward unmounted PDF pages", () => {
  const forward = planPdfVirtualScroll({
    clientHeight: 900,
    mountedPages: [1, 2, 3],
    scrollHeight: 6_000,
    scrollTop: 0,
    targetPage: 6,
    visiblePages: [1],
  });
  assert.deepEqual(forward, { direction: 1, nextScrollTop: 450 });

  const backward = planPdfVirtualScroll({
    clientHeight: 900,
    mountedPages: [4, 5, 6],
    scrollHeight: 6_000,
    scrollTop: 3_000,
    targetPage: 1,
    visiblePages: [5],
  });
  assert.deepEqual(backward, { direction: -1, nextScrollTop: 2_550 });

  const bounded = planPdfVirtualScroll({
    clientHeight: 900,
    mountedPages: [1, 2, 3],
    scrollHeight: 6_000,
    scrollTop: 0,
    targetPage: 1,
    visiblePages: [2],
  });
  assert.deepEqual(bounded, { direction: -1, nextScrollTop: 0 });
});

test("probes mixed bitmap sizes and temporary pinned overflow", () => {
  const probe = probePdfBitmapBudget();
  assert.equal(probe.passed, true);
  assert.ok(probe.peak.count <= PDF_SHARPNESS_MAX_BITMAP_COUNT);
  assert.ok(probe.peak.pixels <= PDF_SHARPNESS_MAX_BITMAP_PIXELS);
  assert.ok(
    probe.pinnedPeak.count > PDF_SHARPNESS_MAX_BITMAP_COUNT ||
      probe.pinnedPeak.pixels > PDF_SHARPNESS_MAX_BITMAP_PIXELS,
  );
  assert.ok(probe.afterUnpin.count <= PDF_SHARPNESS_MAX_BITMAP_COUNT);
  assert.ok(probe.afterUnpin.pixels <= PDF_SHARPNESS_MAX_BITMAP_PIXELS);
  assert.ok(probe.closedBitmaps > 0);
});

test("documents a headed, fresh-build-only command without launching it", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/run-pdf-sharpness-browser-regression.mjs", "--help"],
    { cwd: path.resolve(".") },
  );
  assert.match(stdout, /fresh production build/u);
  assert.match(stdout, /visible browser/u);
  assert.match(stdout, /--diagnose-fallback-import/u);
  assert.match(stdout, /--diagnose-first-network-fixed-point/u);
  assert.match(stdout, /--diagnose-reference-capture/u);
  assert.match(stdout, /--reference-configuration/u);
  assert.doesNotMatch(stdout, /headless/u);
});

test("keeps the first-network diagnostic bounded and non-recording", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "scripts/run-pdf-sharpness-browser-regression.mjs",
        "--diagnose-first-network-fixed-point",
        "--record",
      ],
      { cwd: path.resolve(".") },
    ),
    /cannot be combined with --record/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "scripts/run-pdf-sharpness-browser-regression.mjs",
        "--diagnose-first-network-fixed-point",
      ],
      { cwd: path.resolve(".") },
    ),
    /requires an explicit --output/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "scripts/run-pdf-sharpness-browser-regression.mjs",
        "--diagnose-first-network-fixed-point",
        "--output",
        "outputs/issue-68-diagnostic",
      ],
      { cwd: path.resolve(".") },
    ),
    /output must be outside the source repository/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "scripts/run-pdf-sharpness-browser-regression.mjs",
        "--diagnose-first-network-fixed-point",
        "--fixture",
        path.join(os.tmpdir(), "private-reader-document.pdf"),
        "--output",
        path.join(os.tmpdir(), "issue-68-network-diagnostic"),
      ],
      { cwd: path.resolve(".") },
    ),
    /requires the exact repository PDF fixture/u,
  );
  const symlinkRoot = await mkdtemp(
    path.join(os.tmpdir(), "issue-68-output-guard-"),
  );
  try {
    const repositoryLink = path.join(symlinkRoot, "repository-link");
    await symlink(path.resolve("."), repositoryLink, "dir");
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "scripts/run-pdf-sharpness-browser-regression.mjs",
          "--diagnose-first-network-fixed-point",
          "--output",
          path.join(repositoryLink, "outputs", "diagnostic"),
        ],
        { cwd: path.resolve(".") },
      ),
      /output must be outside the source repository/u,
    );
  } finally {
    await rm(symlinkRoot, { force: true, recursive: true });
  }
  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  assert.match(
    source,
    /!options\.diagnoseFallbackImport &&\s*!options\.diagnoseFirstNetworkFixedPoint[\s\S]*networkState\.phase = "forced-main-fallback"/u,
  );
  assert.match(
    source,
    /networkState\.fixedPointDiagnostics\.push\(diagnostic\);\s*throw new Error/u,
  );
  assert.match(
    source,
    /evidence\.networkDiagnostics = \[\s*\.\.\.networkState\.fixedPointDiagnostics/u,
  );
  assert.match(
    source,
    /const enableResults = await Promise\.allSettled\(\[/u,
  );
  assert.match(source, /buildFirstNetworkDiagnosticReport/u);
  assert.match(source, /pdf-sharpness-network-diagnostic\.json/u);
});

test("keeps the reference-capture diagnostic bounded and noncanonical", async () => {
  const runner = "scripts/run-pdf-sharpness-browser-regression.mjs";
  const freshOutput = path.join(
    os.tmpdir(),
    `issue-68-reference-cli-${process.pid}`,
  );
  await rm(freshOutput, { force: true, recursive: true });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [runner, "--diagnose-reference-capture", "--record"],
      { cwd: path.resolve(".") },
    ),
    /cannot be combined with --record/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [runner, "--diagnose-reference-capture"],
      { cwd: path.resolve(".") },
    ),
    /requires an explicit --output/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--diagnose-reference-capture",
        "--output",
        "outputs/issue-68-reference-diagnostic",
      ],
      { cwd: path.resolve(".") },
    ),
    /output must be outside the source repository/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--diagnose-reference-capture",
        "--fixture",
        path.join(os.tmpdir(), "private-reader-document.pdf"),
        "--output",
        freshOutput,
      ],
      { cwd: path.resolve(".") },
    ),
    /requires the exact repository PDF fixture/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--diagnose-reference-capture",
        "--diagnose-fallback-import",
        "--output",
        freshOutput,
      ],
      { cwd: path.resolve(".") },
    ),
    /diagnostic modes are mutually exclusive/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--reference-configuration",
        "mobile-dpr3-zoom100",
        "--output",
        freshOutput,
      ],
      { cwd: path.resolve(".") },
    ),
    /only valid with --diagnose-reference-capture/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--diagnose-reference-capture",
        "--reference-configuration",
      ],
      { cwd: path.resolve(".") },
    ),
    /requires one allowlisted configuration ID/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--diagnose-reference-capture",
        "--reference-configuration",
        "mobile-dpr3-pinch200",
        "--output",
        freshOutput,
      ],
      { cwd: path.resolve(".") },
    ),
    /configuration is not allowlisted/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--diagnose-reference-capture",
        "--reference-configuration",
        "mobile-dpr3-zoom100",
        "--reference-configuration",
        "desktop-dpr1-zoom100",
        "--output",
        freshOutput,
      ],
      { cwd: path.resolve(".") },
    ),
    /may be selected only once/u,
  );
  const existingOutput = await mkdtemp(
    path.join(os.tmpdir(), "issue-68-reference-existing-"),
  );
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          runner,
          "--diagnose-reference-capture",
          "--output",
          existingOutput,
        ],
        { cwd: path.resolve(".") },
      ),
      /fresh absent directory/u,
    );
  } finally {
    await rm(existingOutput, { force: true, recursive: true });
  }
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--diagnose-reference-capture",
        "--output",
        freshOutput,
      ],
      {
        cwd: path.resolve("."),
        env: { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "" },
      },
    ),
    /requires a graphical DISPLAY or WAYLAND_DISPLAY/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--diagnose-reference-capture",
        "--reference-configuration",
        "mobile-dpr3-zoom100",
        "--output",
        freshOutput,
      ],
      {
        cwd: path.resolve("."),
        env: { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "" },
      },
    ),
    /requires a graphical DISPLAY or WAYLAND_DISPLAY/u,
  );

  assert.deepEqual(
    Object.keys(REFERENCE_CAPTURE_DIAGNOSTIC_CONFIGURATIONS),
    ["desktop-dpr1-zoom100", "mobile-dpr3-zoom100"],
  );
  assert.equal(
    REFERENCE_CAPTURE_DIAGNOSTIC_CONFIGURATIONS["mobile-dpr3-zoom100"]
      .targetPage,
    3,
  );

  const source = await readFile(runner, "utf8");
  for (const step of REFERENCE_CAPTURE_DIAGNOSTIC_STEPS) {
    assert.match(
      source,
      new RegExp(
        `runReferenceCaptureDiagnosticStage\\(\\s*progress,\\s*"${step}"`,
        "u",
      ),
      `${step} must bind one exact diagnostic operation`,
    );
  }
  assert.match(
    source,
    /if \(options\.diagnoseReferenceCapture\) \{[\s\S]*runReferenceCaptureDiagnostic\(options, source\);[\s\S]*return;[\s\S]*buildProductionArtifact/u,
  );
  assert.match(
    source,
    /runBoundedDiagnosticOperation\(async \(\) => \{[\s\S]*captureStableReferenceDiagnosticCandidates[\s\S]*referenceCdp\?\.close\(\)[\s\S]*closeOwnedBrowser/u,
  );
  assert.match(
    source,
    /readReferenceCaptureDiagnosticBaseline[\s\S]*Page\.setLifecycleEventsEnabled[\s\S]*applyMatrixConfiguration[\s\S]*navigateReferenceCaptureDiagnosticPage/u,
  );
  assert.match(source, /pdf-sharpness-reference-capture-diagnostic\.json/u);
  assert.doesNotMatch(
    buildReferenceCaptureDiagnosticReport.toString(),
    /\bpassed\b|schemaVersion/u,
  );
});

test("keeps the fallback-import diagnostic bounded and noncanonical", async () => {
  const runner = "scripts/run-pdf-sharpness-browser-regression.mjs";
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [runner, "--diagnose-fallback-import", "--record"],
      { cwd: path.resolve(".") },
    ),
    /cannot be combined with --record/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [runner, "--diagnose-fallback-import"],
      { cwd: path.resolve(".") },
    ),
    /requires an explicit --output/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--diagnose-fallback-import",
        "--output",
        "outputs/issue-68-fallback-diagnostic",
      ],
      { cwd: path.resolve(".") },
    ),
    /output must be outside the source repository/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--diagnose-fallback-import",
        "--fixture",
        path.join(os.tmpdir(), "private-reader-document.pdf"),
        "--output",
        path.join(os.tmpdir(), "issue-68-fallback-diagnostic"),
      ],
      { cwd: path.resolve(".") },
    ),
    /requires the exact repository PDF fixture/u,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--diagnose-fallback-import",
        "--diagnose-first-network-fixed-point",
        "--output",
        path.join(os.tmpdir(), "issue-68-fallback-diagnostic"),
      ],
      { cwd: path.resolve(".") },
    ),
    /diagnostic modes are mutually exclusive/u,
  );

  const source = await readFile(runner, "utf8");
  for (const step of FALLBACK_IMPORT_DIAGNOSTIC_STEPS) {
    assert.match(
      source,
      new RegExp(
        `runFallbackImportDiagnosticStage\\(\\s*` +
          `(?:progress|fallbackDiagnosticProgress),\\s*"${step}"`,
        "u",
      ),
      `${step} must bind one exact fallback diagnostic operation`,
    );
  }
  assert.match(
    source,
    /if \(options\.diagnoseFallbackImport\) \{[\s\S]*collectPersistedFallbackDiagnosticSetup[\s\S]*collectFallbackImportDiagnostic/u,
  );
  assert.match(
    source,
    /collectPersistedFallbackDiagnosticSetup[\s\S]*navigateToReader\(cdp, appUrl, configuration, true\)[\s\S]*selectFixtureFile/u,
  );
  assert.match(source, /buildFallbackImportDiagnosticReport/u);
  assert.match(
    source,
    /console\.debug\('__linelight_issue68_worker__'[\s\S]*Runtime\.consoleAPICalled[\s\S]*target\.workerInstanceId = workerInstanceId\.value/u,
  );
  assert.match(
    source,
    /isFallbackImportNetworkDiagnosticHealthy\([\s\S]*lifecycle\.importIdentity\?\.workerInstanceId/u,
  );
  assert.match(
    source,
    /pdf-sharpness-fallback-import-diagnostic\.json/u,
  );
  assert.match(
    source,
    /finally \{[\s\S]*closeOwnedBrowser[\s\S]*if \(options\.diagnoseFallbackImport\)/u,
  );
  assert.doesNotMatch(
    buildFallbackImportDiagnosticReport.toString(),
    /\bpassed\b|schemaVersion/u,
  );
});

test("forces bounded fallback diagnostic cleanup before reporting", async () => {
  let cleanupStarted = false;
  let finallyReached = false;
  try {
    await assert.rejects(
      runBoundedDiagnosticOperation(
        () => new Promise(() => {}),
        {
          onTimeout() {
            cleanupStarted = true;
          },
          timeoutMs: 5,
        },
      ),
      /bounded fallback-import diagnostic timed out/u,
    );
  } finally {
    finallyReached = true;
  }
  assert.equal(cleanupStarted, true);
  assert.equal(finallyReached, true);

  const source = await readFile(
    "scripts/run-pdf-sharpness-browser-regression.mjs",
    "utf8",
  );
  assert.match(
    source,
    /runBoundedDiagnosticOperation\(collectAppEvidence[\s\S]*appCdp\?\.close\(\)[\s\S]*finally \{[\s\S]*closeOwnedBrowser[\s\S]*buildFallbackImportDiagnosticReport/u,
  );
});

test("refuses to record screenshots from a private fixture", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "scripts/run-pdf-sharpness-browser-regression.mjs",
        "--record",
        "--fixture",
        path.join(os.tmpdir(), "private-reader-document.pdf"),
      ],
      { cwd: path.resolve(".") },
    ),
    /requires the exact repository PDF fixture/u,
  );
});

test(
  "runs the headed Issue 68 regression only when explicitly enabled",
  {
    skip: process.env.LINELIGHT_RUN_PDF_SHARPNESS_BROWSER !== "1",
    timeout: 900_000,
  },
  async () => {
    const outputDirectory = await mkdtemp(
      path.join(os.tmpdir(), "linelight-pdf-sharpness-evidence-"),
    );
    try {
      await execFileAsync(
        process.execPath,
        [
          "scripts/run-pdf-sharpness-browser-regression.mjs",
          "--output",
          outputDirectory,
        ],
        { cwd: path.resolve("."), timeout: 880_000 },
      );
      const evidence = JSON.parse(
        await readFile(
          path.join(outputDirectory, "pdf-sharpness-browser.json"),
          "utf8",
        ),
      );
      assert.equal(evidence.passed, true, evidence.failures?.join("\n"));
      assert.deepEqual(validatePdfSharpnessEvidence(evidence), []);
    } finally {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  },
);
