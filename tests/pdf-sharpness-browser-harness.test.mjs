import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  decodePngScreenshot,
  probePdfBitmapBudget,
} from
  "../scripts/run-pdf-sharpness-browser-regression.mjs";

const execFileAsync = promisify(execFile);
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const SHA = "c".repeat(64);
const DEPLOYMENT = "issue-68-test-deployment";
const DOCUMENT_KEY = "issue-68-document:issue-68-revision";
const REVISION = "issue-68-revision";

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
    const cssWidth = configuration.kind === "mobile" ? 300 : 600;
    const cssHeight = configuration.kind === "mobile" ? 400 : 800;
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
          composedAt: 10,
          connectedCanvas: true,
          distance: 1,
          observed: true,
          scale: 1.25,
          workerObserved: true,
        },
        previewBeforeSharp: true,
        sharp: {
          actualHeight: targetHeight,
          actualWidth: targetWidth,
          composedAt: 20,
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
    at: 1101,
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
        canvasHeightAfterExit: 0,
        canvasPresentAfterExit: true,
        canvasWidthAfterExit: 0,
        cancellationTerminal,
        completedAfterExit: false,
        continuationDelayAt: 100,
        continuationDelayObserved: true,
        continuationResumeAt: 1100,
        continuationResumeObserved: true,
        continuationResumedAfterMs: 1000,
        documentKey: DOCUMENT_KEY,
        exitedAt: 150,
        lateComposes: [],
        page: 3,
        pageDerivation: "sole-visible-unsatisfied-page",
        renderAttemptId: 7,
        revision: REVISION,
        textOverlayRetainedAfterExit: true,
        viewportExit: {
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
      },
      longTasks: [{ duration: 49.9, name: "self", startTime: 1 }],
      maximumConcurrentStaging: 1,
      noLateLowOverwrite: true,
      retry: {
        composedAt: 20,
        documentKey: DOCUMENT_KEY,
        failedAttemptId: 1,
        failedAt: 11,
        page: 1,
        pageDerivation: "sole-visible-unsatisfied-page",
        retryAttemptId: 2,
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
          at: 10,
          candidatePages: [1],
          documentKey: DOCUMENT_KEY,
          page: 1,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 1,
          revision: REVISION,
          targetHeight: 800,
          targetKey: "600x800",
          targetWidth: 600,
          type: "staging-start",
        },
        {
          at: 11,
          cancelRequestedAt: null,
          documentKey: DOCUMENT_KEY,
          outcome: "injected-failure",
          page: 1,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 1,
          revision: REVISION,
          targetHeight: 800,
          targetKey: "600x800",
          targetWidth: 600,
          type: "staging-finish",
        },
        {
          at: 12,
          candidatePages: [1],
          documentKey: DOCUMENT_KEY,
          page: 1,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 2,
          revision: REVISION,
          targetHeight: 800,
          targetKey: "600x800",
          targetWidth: 600,
          type: "staging-start",
        },
        {
          at: 20,
          documentKey: DOCUMENT_KEY,
          page: 1,
          pageDerivation: "sole-visible-unsatisfied-page",
          pageMatchesAttempt: true,
          renderAttemptId: 2,
          revision: REVISION,
          sourcePage: 1,
          targetHeight: 800,
          targetKey: "600x800",
          targetWidth: 600,
          type: "visible-compose",
        },
        {
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
          at: 140,
          documentKey: DOCUMENT_KEY,
          page: 3,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 7,
          revision: REVISION,
          type: "cancel-request",
        },
        {
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
          afterMs: 1000,
          at: 1100,
          documentKey: DOCUMENT_KEY,
          page: 3,
          pageDerivation: "sole-visible-unsatisfied-page",
          renderAttemptId: 7,
          revision: REVISION,
          type: "continuation-resume",
        },
        cancellationTerminal,
      ],
      workerFallbackEvent: { type: "render-fallback" },
      workerQueueClosed: true,
    },
    fixture,
    issue: 68,
    matrix,
    network: (() => {
      const normalPairs = PDF_SHARPNESS_MATRIX.map(({ id }, index) => {
        const documentTarget = {
          ancestry: [],
          phase: id,
          sessionId: `normal-document-session-${index}`,
          targetId: `normal-document-target-${index}`,
          type: "worker",
          url: "http://127.0.0.1/assets/pdf-document.worker-test.js",
        };
        const parserTarget = {
          ancestry: [documentTarget],
          phase: id,
          sessionId: `normal-parser-session-${index}`,
          targetId: `normal-parser-target-${index}`,
          type: "worker",
          url: "http://127.0.0.1/assets/pdf-parser.worker-test.js",
        };
        return { documentTarget, id, parserTarget };
      });
      const forcedWrapper = {
        ancestry: [],
        phase: "forced-main-fallback",
        sessionId: "forced-wrapper-session",
        targetId: "forced-wrapper-target",
        type: "worker",
        url: "blob:http://127.0.0.1/forced-wrapper",
      };
      const forcedParser = {
        ancestry: [forcedWrapper],
        phase: "forced-main-fallback",
        sessionId: "forced-parser-session",
        targetId: "forced-parser-target",
        type: "worker",
        url: "http://127.0.0.1/assets/pdf-parser.worker-test.js",
      };
      const targets = [
        ...normalPairs.flatMap(({ documentTarget, parserTarget }) => [
          documentTarget,
          parserTarget,
        ]),
        forcedWrapper,
        forcedParser,
      ];
      const nonPageRequests = targets.map((target, index) => ({
        sessionId: target.sessionId,
        url: `http://127.0.0.1/assets/worker-request-${index}.js`,
      }));
      const requestCount = nonPageRequests.length;
      return {
        attachErrors: [],
        networkFixedPoints: [
          ...PDF_SHARPNESS_MATRIX.map(({ id }) => id),
          "forced-main-fallback",
          "final-network-privacy",
        ].map((label) => ({
          attachPromiseCount: targets.length,
          completedRequestCount: requestCount,
          inflightRequestCount: 0,
          label,
          pendingAttachCount: 0,
          requestCount,
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
              documentRequestCount: 2,
              documentTargets: [documentTarget],
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
        sourceRequest: null,
        sourceSha256: SHA,
        sourceStayedLocal: true,
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
  assert.deepEqual(validatePdfSharpnessEvidence(passingEvidence()), []);
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
  run.canvasBudget.maximumPixels = PDF_SHARPNESS_MAX_RASTER_PIXELS;
  assert.deepEqual(validatePdfSharpnessEvidence(evidence), []);

  run.raster.sharp.targetCapped = false;
  assert.match(
    validatePdfSharpnessEvidence(evidence).join("\n"),
    /computed capped target/u,
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
    ["preview composition order", (value) => {
      value.matrix[0].raster.preview.composedAt = 25;
    }, /computed capped target|upgrade ordering/u],
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
    ["fallback missing injected outcome", (value) => {
      value.fallback.stagingEvents = value.fallback.stagingEvents.filter(
        (event) => event.outcome !== "injected-failure",
      );
    }, /fallback cancellation\/retry/u],
    ["fallback cancellation", (value) => {
      value.fallback.invisibleCancellation.completedAfterExit = true;
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
    ["fallback continuation delay", (value) => {
      value.fallback.invisibleCancellation.continuationDelayObserved = false;
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
  assert.match(source, /delayNextContinuation\(1000\);/u);
  assert.match(source, /arguments\.length !== 1/u);
  assert.doesNotMatch(source, /delayNextContinuation\(1000,\s*3\)/u);
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
  assert.doesNotMatch(stdout, /headless/u);
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
