import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
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
  analyzeReferencePixels,
  advanceCdpFixedPointStability,
  buildCdpNetworkFixedPointDiagnostic,
  buildFirstNetworkDiagnosticReport,
  classifyCdpDiagnosticUrl,
  classifyPdfRasterTransition,
  completeCdpNetworkRequest,
  decodePngScreenshot,
  isCdpAttachmentStateHealthy,
  isCdpFixedPointDiagnosticHealthy,
  isCdpTargetBootstrapRequest,
  isCdpTargetSetupComplete,
  matchesPdfFallbackInjection,
  planPdfVirtualScroll,
  probePdfBitmapBudget,
  recordCdpNetworkRequest,
  reconcileCdpTargetBootstrapRequests,
  selectPdfFallbackAbortCandidate,
  selectPdfFallbackScenarioEvents,
  sendToCdpSession,
  summarizePdfModelCompletion,
} from
  "../scripts/run-pdf-sharpness-browser-regression.mjs";

const execFileAsync = promisify(execFile);
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const SHA = "c".repeat(64);
const DEPLOYMENT = "issue-68-test-deployment";
const DOCUMENT_KEY = "issue-68-document:issue-68-revision";
const REVISION = "issue-68-revision";
const FAILED_ABORT_SIGNAL_ID = 1;
const RETRY_ABORT_SIGNAL_ID = 2;
const CANCELLATION_ABORT_SIGNAL_ID = 3;
const PUBLIC_PDF_FIXTURE =
  "tests/fixtures/pdf-highlights/issue-60-geometry.pdf";
const PUBLIC_PDF_FIXTURE_BYTES = 4_745;
const PUBLIC_PDF_FIXTURE_SHA256 =
  "1addfceae4b869eec37dae4755d576ccd0fd7e1ce505dc856da3b96acbf3f06c";

function artifact(name, digit) {
  return {
    bytes: 1024,
    path: `outputs/issue-68/${name}`,
    sha256: String(digit).repeat(64),
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
        maximumCount: 2,
        maximumPixels: targetWidth * targetHeight,
      },
      comparison: {
        lineLightScreenshot,
        paired: true,
        referenceReadiness: {
          attempts: 2,
          height: 1000,
          inkPixels: 8_000,
          inkRatio: 0.01,
          inkRowBands: 4,
          inkSpanRatio: 0.65,
          pageBounds: { height: 800, width: 1000, x: 100, y: 100 },
          pagePixels: 800_000,
          pageWhitePixels: 720_000,
          pageWhiteRatio: 0.9,
          proof: "white-page-with-rendered-ink",
          renderedPage: true,
          width: 1200,
        },
        referenceScreenshot,
        sourceSha256: SHA,
        targetPage: 2,
      },
      id: configuration.id,
      importedSource: { sha256: SHA, size: fixture.bytes },
      longTasks: [{ duration: 49.9, name: "self", startTime: 1 }],
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
        firstComposedPage: 4,
        firstWorkerBitmapPage: 4,
        staleNonVisibleCompositions: [],
        staleWorkerBitmaps: [],
        targetPage: 4,
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
        continuationResumeAt: 1100,
        continuationResumeObserved: true,
        continuationResumedAfterMs: 1000,
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
      longTasks: [{ duration: 49.9, name: "self", startTime: 1 }],
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
      const completedAttachCommands = () => [
        { name: "network-enable", status: "completed" },
        { name: "runtime-enable", status: "completed" },
        { name: "cache-disable", status: "completed" },
        { name: "auto-attach", status: "completed" },
        { name: "resume", status: "completed" },
      ];
      const normalPairs = PDF_SHARPNESS_MATRIX.map(({ id }, index) => {
        const documentTarget = {
          ancestry: [],
          attachComplete: true,
          bootstrapRequestKey: null,
          commands: completedAttachCommands(),
          detached: false,
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
          commands: completedAttachCommands(),
          detached: false,
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
        commands: completedAttachCommands(),
        detached: false,
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
        commands: completedAttachCommands(),
        detached: false,
        parentSessionId: forcedWrapper.sessionId,
        phase: "forced-main-fallback",
        resumed: true,
        sessionId: "forced-parser-session",
        targetId: "forced-parser-target",
        type: "worker",
        url: "http://127.0.0.1/assets/pdf-parser.worker-test.js",
        waitingForDebugger: true,
      };
      const targets = [
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
      const requests = [...bootstrapRequests, ...runtimeRequests];
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
          inflightRequestCount: 0,
          label,
          pendingAttachCount: 0,
          requestCount,
          serviceWorkerBypassed: true,
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
      server: { error: null, present: true, processClosed: true },
      serverClosed: true,
    },
  };
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
    "label",
    "outcome",
    "pendingAttaches",
    "recentActivity",
    "serviceWorkerBypassed",
    "targetBootstrapSettlements",
    "targets",
    "wait",
  ]);
  assert.equal(diagnostic.inflightRequests[0].urlClass,
    "pdf-parser-worker");
  assert.equal(diagnostic.pendingAttaches[0].urlClass,
    "pdf-parser-worker");
  assert.deepEqual(diagnostic.pendingAttaches[0].commands, [
    { name: "network-enable", status: "completed" },
    { name: "runtime-enable", status: "pending" },
  ]);
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
  assert.equal(diagnostic.wait.recentSamples[0].inflightRequestCount, 1);
  assert.match(diagnostic.inflightRequests[0].identityHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(diagnostic.counts, {
    attachErrorCount: 1,
    attachPromiseCount: 1,
    completedRequestCount: 4,
    inflightRequestCount: 1,
    pendingAttachCount: 1,
    requestCount: 1,
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
  healthyDiagnostic.counts.attachPromiseCount = 2;
  healthyDiagnostic.counts.completedRequestCount = 2;
  healthyDiagnostic.counts.inflightRequestCount = 0;
  healthyDiagnostic.counts.pendingAttachCount = 0;
  healthyDiagnostic.counts.requestCount = 2;
  healthyDiagnostic.inflightRequests = [];
  healthyDiagnostic.outcome = "fixed-point-reached";
  healthyDiagnostic.pendingAttaches = [];
  healthyDiagnostic.serviceWorkerBypassed = true;
  healthyDiagnostic.targets = healthyDiagnostic.targets.map((target) => ({
    ...target,
    attachComplete: true,
    commands: [
      { name: "network-enable", status: "completed" },
      { name: "runtime-enable", status: "completed" },
      { name: "cache-disable", status: "completed" },
      { name: "auto-attach", status: "completed" },
      ...(target.waitingForDebugger
        ? [{ name: "resume", status: "completed" }]
        : []),
    ],
    resumed: true,
  }));
  healthyDiagnostic.targetBootstrapSettlements = [
    {
      ...healthyDiagnostic.targetBootstrapSettlements[0],
      identityHash: SHA,
    },
    {
      identityHash: "d".repeat(64),
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
    ["missing parser bootstrap settlement", (value) => {
      value.targetBootstrapSettlements.pop();
      value.counts.targetBootstrapSettlementCount -= 1;
    }],
    ["unhealthy stable sample", (value) => {
      value.wait.recentSamples.at(-1).attachmentReady = false;
    }],
  ]) {
    const unhealthyDiagnostic = structuredClone(healthyDiagnostic);
    mutate(unhealthyDiagnostic);
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
    commands: [
      { name: "network-enable", status: "completed" },
      { name: "runtime-enable", status: "completed" },
      { name: "cache-disable", status: "completed" },
      { name: "auto-attach", status: "completed" },
      { name: "resume", status: "completed" },
    ],
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
  }), true);
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

test("accepts synchronous cancellation before a delayed PDF.js continuation resumes", () => {
  const evidence = passingEvidence();
  const cancellation = evidence.fallback.invisibleCancellation;
  assert.ok(
    cancellation.cancellationTerminal.at < cancellation.exitedAt &&
    cancellation.exitedAt < cancellation.continuationResumeAt,
  );
  assert.deepEqual(validatePdfSharpnessEvidence(evidence), []);
});

test("uses composition and bitmap sequence when timer samples tie", () => {
  const evidence = passingEvidence();
  const upgraded = evidence.matrix[2].raster;
  upgraded.sharp.composedAt = upgraded.preview.composedAt;
  assert.deepEqual(validatePdfSharpnessEvidence(evidence), []);
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
  run.canvasBudget.maximumPixels = PDF_SHARPNESS_MAX_RASTER_PIXELS;
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
    ["stale priority", (value) => {
      value.matrix[0].visibleFirst.firstComposedPage = 3;
    }, /current viewport first/u],
    ["offscreen shell", (value) => {
      value.matrix[0].release.shellRetained = false;
    }, /retain its offscreen text/u],
    ["long task", (value) => {
      value.matrix[0].longTasks[0].duration = 50.01;
    }, /Long Task over 50ms/u],
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
    ["fallback continuation resume", (value) => {
      value.fallback.invisibleCancellation.continuationResumeObserved = false;
    }, /fallback cancellation\/retry/u],
    ["fallback continuation resume timing", (value) => {
      value.fallback.invisibleCancellation.continuationResumedAfterMs = 500;
    }, /fallback cancellation\/retry/u],
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

test("requires rendered ink on a substantial reference PDF page", () => {
  const width = 240;
  const height = 180;
  const createPixels = (withInk) => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 70;
      pixels[offset + 1] = 70;
      pixels[offset + 2] = 70;
      pixels[offset + 3] = 255;
    }
    for (let y = 20; y < 170; y += 1) {
      for (let x = 25; x < 215; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 250;
        pixels[offset + 1] = 250;
        pixels[offset + 2] = 250;
        pixels[offset + 3] = 255;
      }
    }
    if (withInk) {
      for (const top of [45, 75, 105]) {
        for (let y = top; y < top + 4; y += 1) {
          for (let x = 50; x < 185; x += 1) {
            const offset = (y * width + x) * 4;
            pixels[offset] = 30;
            pixels[offset + 1] = 30;
            pixels[offset + 2] = 30;
          }
        }
      }
    }
    return pixels;
  };

  const rendered = analyzeReferencePixels({
    height,
    pixels: createPixels(true),
    width,
  });
  assert.equal(rendered.renderedPage, true);
  assert.ok(rendered.inkRowBands >= 3);
  assert.ok(rendered.inkSpanRatio > 0.5);

  const blank = analyzeReferencePixels({
    height,
    pixels: createPixels(false),
    width,
  });
  assert.equal(blank.renderedPage, false);
  assert.equal(blank.inkPixels, 0);

  const loadingPixels = createPixels(false);
  for (let y = 85; y < 105; y += 1) {
    for (let x = 110; x < 130; x += 1) {
      const offset = (y * width + x) * 4;
      loadingPixels[offset] = 30;
      loadingPixels[offset + 1] = 30;
      loadingPixels[offset + 2] = 30;
    }
  }
  const loading = analyzeReferencePixels({
    height,
    pixels: loadingPixels,
    width,
  });
  assert.ok(loading.inkPixels >= 100);
  assert.equal(loading.renderedPage, false);
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
    2,
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
  assert.match(stdout, /--diagnose-first-network-fixed-point/u);
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
    /if \(!options\.diagnoseFirstNetworkFixedPoint\) \{\s*networkState\.phase = "forced-main-fallback"/u,
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
