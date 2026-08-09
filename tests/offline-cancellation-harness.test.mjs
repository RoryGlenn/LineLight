import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AttachedCdpSession,
  attachCdpChildTarget,
  countTrackedProcessSurvivors,
  evaluateBrowserStatePredicate,
  findEvidencePrivacyViolations,
  findUnterminatedSynthesisRequests,
  isAttachedTargetBootstrapRequest,
  parseArguments,
  selectOwnedProcessTree,
  summarizeAttachedTargetCoverage,
  validateCleanTargetBaseline,
  validateOfflineCancellationEvidence,
} from "../scripts/run-offline-cancellation-regression.mjs";

const JSEP_SHA256 =
  "1e5a323ca41d859f324694c7b5ba2052bf8c1a96ff9721bc62e94f874d379fe1";
const FIXTURE_SHA256 =
  "1addfceae4b869eec37dae4755d576ccd0fd7e1ce505dc856da3b96acbf3f06c";
const WEBGPU_COVERAGE_SHA256 =
  "4f48ed467068c74080e7b8cfd215338da80b6b70d27fafb6fbbd709581ea9370";
const FIXTURE_PATH = "tests/fixtures/pdf-highlights/issue-60-geometry.pdf";
const WEBGPU_COVERAGE_PATH = "tests/offline-model.test.mjs";
const SOURCE_FILES = [
  "app/offline-run-cancellation.mjs",
  "app/offline-speech.ts",
  "app/offline-speech.worker.ts",
  "app/onnxruntime-web-types.d.ts",
  "app/page.tsx",
  "app/speech-prefetch.mjs",
  "package-lock.json",
  "package.json",
  "scripts/apply-dependency-patches.mjs",
  "scripts/run-offline-cancellation-regression.mjs",
  "tests/offline-cancellation-harness.test.mjs",
  WEBGPU_COVERAGE_PATH,
  "vendor/onnxruntime-web/CHECKSUMS.sha256",
  "vendor/onnxruntime-web/onnxruntime-web-1.22.0-dev.20250409-89f8206ba4.tgz",
  FIXTURE_PATH,
];
const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cancellation(index) {
  const actionAtMs = 1_000 + index * 2_000;
  return {
    actionAtMs,
    actionNodeMonotonicMs: actionAtMs + 50,
    actionRoundTripMs: 12,
    audiblePauseAtMs: actionAtMs + 3,
    audiblePauseLatencyMs: 3,
    cooperative: true,
    cpu: {
      activeIntervals: [
        { cpuPercent: 90, elapsedMs: 50, endAfterActionMs: -50 },
      ],
      cpuPercentAtIdle: 4,
      idleByMs: 180,
      intervals: [
        { cpuPercent: 90, elapsedMs: 50 },
        { cpuPercent: 10, elapsedMs: 50 },
        { cpuPercent: 4, elapsedMs: 50 },
      ],
      peakActiveCpuPercent: 90,
      samples: [
        { monotonicMs: actionAtMs - 50, processes: [] },
        { monotonicMs: actionAtMs, processes: [] },
        { monotonicMs: actionAtMs + 50, processes: [] },
        { monotonicMs: actionAtMs + 100, processes: [] },
      ],
    },
    endToEndPauseUpperBoundMs: 15,
    generation: index + 1,
    provenActive: true,
    requestId: 10 + index,
    runEndedAtMs: actionAtMs + 10,
    runEndedSequence: 90 + index,
    runStartedAtMs: actionAtMs - 20,
    sessionGeneration: 3,
    terminalAtMs: actionAtMs + 20,
    terminalSequence: 100 + index,
    terminalType: "canceled",
    workerEpoch: 1,
  };
}

function passingEvidence() {
  const sourceFiles = Object.fromEntries(
    SOURCE_FILES.map((file) => [file, HASH]),
  );
  const jsepWasmPath =
    "dist/client/assets/ort-wasm-simd-threaded.jsep-test.wasm";
  const workerPath = "dist/client/assets/offline-speech.worker-test.js";
  return {
    artifact: {
      jsepWasmPath,
      jsepWasmSha256: JSEP_SHA256,
      loadedJsepWasm: true,
      loadedJsepWasmPath: "/assets/ort-wasm-simd-threaded.jsep-test.wasm",
      loadedWorker: true,
      loadedWorkerPath: "/assets/offline-speech.worker-test.js",
      workerCancellationIdentity: true,
      workerPath,
      workerSha256: HASH,
    },
    browserDiagnostics: { consoleErrors: [], errors: [] },
    build: {
      exactCleanSource: true,
      exitCode: 0,
      performed: true,
      sourceCommit: COMMIT,
      sourceFilesSha256: sha256(JSON.stringify(sourceFiles)),
    },
    cache: { unchanged: true },
    cleanup: {
      browserProfileMatchesAfterStop: 0,
      browserProcessGroupId: 4_001,
      browserProcessGroupStopped: true,
      browserTrackedProcessCount: 2,
      browserTrackedProcessIdentityHashes: ["c".repeat(64), "d".repeat(64)],
      browserTrackedSurvivors: 0,
      failures: [],
      profileCloneRemoved: true,
      serverCommandMatchesAfterStop: 0,
      serverProcessGroupId: 4_002,
      serverProcessGroupStopped: true,
      serverPortReleased: true,
      serverTrackedProcessCount: 1,
      serverTrackedProcessIdentityHashes: ["e".repeat(64)],
      serverTrackedSurvivors: 0,
      survivingBrowserProcesses: 0,
    },
    fallbacks: {
      wasmSingleThread: {
        available: true,
        cancelMessages: 0,
        device: "wasm",
        observationMs: 1_000,
        sameRequestSucceeded: true,
        wasmRunStarts: 0,
        wasmThreads: 1,
        workerTerminations: 0,
      },
      webgpu: {
        available: false,
        executableCoverage: {
          path: WEBGPU_COVERAGE_PATH,
          sha256: WEBGPU_COVERAGE_SHA256,
        },
        gracefulFallback: { device: "wasm", success: true, wasmThreads: 4 },
        probeAvailable: false,
        unflaggedAdapterResult: "unavailable",
        unsafeFeatureFlags: false,
      },
    },
    finalIsolation: {
      activeSpeechWorkers: 0,
      narrationStopped: true,
      networkSettled: true,
      speechWorkersDetached: 1,
      teardownPath: "/offline-voice-license.txt",
    },
    fixture: {
      path: FIXTURE_PATH,
      sha256: FIXTURE_SHA256,
      synthetic: true,
    },
    isolation: {
      baselinePageCount: 1,
      baselinePageUrl: "about://non-http-resource",
      preexistingSpeechWorkers: 0,
      preexistingWorkers: 0,
      sessionRestorePurged: true,
    },
    issue: 55,
    network: {
      attachFailures: [],
      externalModelRequests: [],
      loadingFailures: [],
      nestedPthreadWorkersAttached: 2,
      nonLoopbackRequests: [],
      offlineSpeechWorkerAttached: true,
      outstandingAttachPromises: 0,
      outstandingRequests: 0,
      responseFailures: [],
      serviceWorkerBypassed: true,
      targetBootstrapSettlements: [
        {
          method: "GET",
          resourceType: "Script",
          targetType: "worker",
          terminalReason: "target-attached",
          url: "http://127.0.0.1:5212/assets/offline-speech.worker-test.js",
        },
      ],
    },
    privacy: { narrationTextRecorded: false },
    run: {
      appOrigin: "http://127.0.0.1:5212",
      externalUrl: false,
      headed: true,
      ownedProcessGroup: true,
      ownedProductionServer: true,
    },
    schemaVersion: 1,
    source: { commit: COMMIT, dirty: false, files: sourceFiles },
    threadedWasm: {
      cancellations: Array.from({ length: 5 }, (_, index) =>
        cancellation(index),
      ),
      cpuBaseline: {
        derivedIdleThresholdPercent: 14,
        intervals: [
          { cpuPercent: 4, elapsedMs: 50 },
          { cpuPercent: 3, elapsedMs: 50 },
        ],
        p95CpuPercent: 4,
        samples: [
          { monotonicMs: 100, processes: [] },
          { monotonicMs: 150, processes: [] },
          { monotonicMs: 200, processes: [] },
        ],
      },
      farSeek: {
        actionAtMs: 20_000,
        discardedRequestId: 41,
        discardedRunCooperativelyCanceled: true,
        discardedRunProvenActive: true,
        discardedSessionGeneration: 3,
        discardedTerminalAtMs: 20_020,
        discardedWorkerEpoch: 1,
        reset: {
          actionAtMs: 16_000,
          actionWallTimeMs: 1_000_000,
          anchor: {
            kind: "reviewed-fixture-token",
            matchCount: 1,
            ordinal: 0,
          },
          backendChanges: 0,
          boundarySequence: 210,
          currentAudioPlayingAtMs: 16_110,
          currentRequestAtMs: 16_010,
          currentRequestId: 40,
          currentRequestSequence: 211,
          currentRunStartAtMs: 16_020,
          currentRunStartSequence: 212,
          currentSessionGeneration: 3,
          currentSuccessAtMs: 16_100,
          currentSuccessSequence: 213,
          currentSynthesisRequested: true,
          currentWorkerEpoch: 1,
          lookaheadRequestAtMs: 16_120,
          lookaheadRequestId: 41,
          lookaheadRequestSequence: 214,
          lookaheadRunStartAtMs: 16_130,
          lookaheadRunStartSequence: 215,
          lookaheadSessionGeneration: 3,
          lookaheadWorkerEpoch: 1,
          modelRequests: 0,
          preResetErrorTerminalCount: 0,
          preResetOpenRequestCount: 1,
          preResetOpenTerminalCount: 1,
          preResetMaxRequestId: 39,
          preResetPreparedSnapshotSequence: 200,
          preResetRequestBoundarySequence: 205,
          preResetRequestCount: 8,
          sessionIdentityChanges: 0,
          workerTerminations: 0,
        },
        targetAudioLatencyMs: 100,
        targetAudioPlayingAtMs: 20_100,
        targetRequestId: 42,
        targetRunStartAtMs: 20_030,
        targetRunStartLatencyMs: 30,
        targetSessionGeneration: 3,
        targetStartedAfterDiscardedTerminal: true,
        targetWorkerEpoch: 1,
      },
      preparedResume: {
        audioCreatedBeforePause: true,
        discarded: false,
        newSynthesisRequests: 0,
        playedAtMs: 15_000,
        snapshotSequence: 200,
        success: true,
      },
      sameSessionFollowup: {
        modelRequests: 0,
        sessionGeneration: 3,
        success: true,
        workerEpoch: 1,
        workerTerminations: 0,
      },
      timeoutRecovery: {
        cacheUnchanged: true,
        canceledRequestReplayed: false,
        forced: true,
        modelRequests: 0,
        newWorkerEpoch: 2,
        oldWorkerEpoch: 1,
        oldWorkerTerminated: true,
        pendingRequestReplayed: true,
        pendingRequestSucceeded: true,
        staleMessagesIgnored: true,
        watchdogDelayMs: 760,
      },
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

class FakeWebSocket extends EventTarget {
  sent = [];

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.dispatchEvent(new Event("close"));
  }
}

test("accepts a complete synthetic Issue #55 evidence shape", () => {
  assert.deepEqual(validateOfflineCancellationEvidence(passingEvidence()), []);
});

test("accepts a real unflagged WebGPU fallback when an adapter is available", () => {
  const evidence = passingEvidence();
  evidence.fallbacks.webgpu = {
    available: true,
    cancelMessages: 0,
    device: "webgpu",
    executableCoverage: {
      path: WEBGPU_COVERAGE_PATH,
      sha256: WEBGPU_COVERAGE_SHA256,
    },
    observationMs: 1_000,
    probeAvailable: true,
    sameRequestSucceeded: true,
    unsafeFeatureFlags: false,
    wasmRunStarts: 0,
    wasmThreads: null,
    workerTerminations: 0,
  };
  assert.deepEqual(validateOfflineCancellationEvidence(evidence), []);
});

test("fails closed on every source, timing, lifecycle, and fallback gate", () => {
  const cases = [
    [
      "owned server",
      (evidence) => {
        evidence.run.ownedProductionServer = false;
      },
      "harness-owned production server",
    ],
    [
      "source dirtiness",
      (evidence) => {
        evidence.source.dirty = true;
      },
      "source commit",
    ],
    [
      "build source binding",
      (evidence) => {
        evidence.build.sourceCommit = "c".repeat(40);
      },
      "exact clean evidence source",
    ],
    [
      "fixture identity",
      (evidence) => {
        evidence.fixture.sha256 = HASH;
      },
      "exact reviewed synthetic fixture",
    ],
    [
      "restored worker",
      (evidence) => {
        evidence.isolation.preexistingWorkers = 1;
      },
      "one clean about:blank page",
    ],
    [
      "idle baseline cadence",
      (evidence) => {
        evidence.threadedWasm.cpuBaseline.intervals[0].elapsedMs = 101;
      },
      "measured idle CPU baseline",
    ],
    [
      "active count",
      (evidence) => evidence.threadedWasm.cancellations.pop(),
      "fewer than 5 active cancellations",
    ],
    [
      "run-end ordering",
      (evidence) => {
        evidence.threadedWasm.cancellations[0].runEndedAtMs = 900;
      },
      "start, action, run-end, terminal ordering",
    ],
    [
      "CPU quiescence",
      (evidence) => {
        evidence.threadedWasm.cancellations[0].cpu.idleByMs = 501;
      },
      "near-idle CPU",
    ],
    [
      "CPU cadence",
      (evidence) => {
        evidence.threadedWasm.cancellations[0].cpu.intervals[0].elapsedMs = 101;
      },
      "CPU sampling exceeded",
    ],
    [
      "active CPU sample",
      (evidence) => {
        evidence.threadedWasm.cancellations[0].cpu.activeIntervals = [];
      },
      "raw CPU sample above",
    ],
    [
      "CDP Pause dispatch",
      (evidence) => {
        evidence.threadedWasm.cancellations[0].actionRoundTripMs = 51;
      },
      "audible Pause exceeded",
    ],
    [
      "end-to-end Pause",
      (evidence) => {
        evidence.threadedWasm.cancellations[0].endToEndPauseUpperBoundMs = 51;
      },
      "audible Pause exceeded",
    ],
    [
      "intermediate session replacement",
      (evidence) => {
        evidence.threadedWasm.cancellations[2].workerEpoch = 9;
      },
      "silently changed worker",
    ],
    [
      "follow-up model request",
      (evidence) => {
        evidence.threadedWasm.sameSessionFollowup.modelRequests = 1;
      },
      "same-worker, same-session success",
    ],
    [
      "prepared audio discarded",
      (evidence) => {
        evidence.threadedWasm.preparedResume.discarded = true;
      },
      "already prepared audio",
    ],
    [
      "far seek reset anchor ambiguity",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.anchor.matchCount = 2;
      },
      "far-seek reset",
    ],
    [
      "far seek reset left an old request unterminated",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.preResetOpenTerminalCount = 0;
      },
      "far-seek reset",
    ],
    [
      "far seek reset old request error",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.preResetErrorTerminalCount = 1;
      },
      "far-seek reset",
    ],
    [
      "far seek reset request escaped atomic boundary",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.preResetRequestBoundarySequence = 199;
      },
      "far-seek reset",
    ],
    [
      "far seek reset reused cached current audio",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.currentSynthesisRequested = false;
      },
      "far-seek reset",
    ],
    [
      "far seek reset reused a prior request ID",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.currentRequestId = 39;
      },
      "far-seek reset",
    ],
    [
      "far seek lookahead began before current audio",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.lookaheadRequestAtMs = 16_100;
      },
      "far-seek reset",
    ],
    [
      "far seek reset action followed current request",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.actionAtMs = 16_020;
      },
      "far-seek reset",
    ],
    [
      "far seek reset replaced the warm session",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.currentSessionGeneration = 9;
      },
      "far-seek reset",
    ],
    [
      "far seek reset phase model request",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.modelRequests = 1;
      },
      "far-seek reset",
    ],
    [
      "far seek reset backend change",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.backendChanges = 1;
      },
      "far-seek reset",
    ],
    [
      "far seek reset worker termination",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.workerTerminations = 1;
      },
      "far-seek reset",
    ],
    [
      "far seek reset session delta",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.sessionIdentityChanges = 1;
      },
      "far-seek reset",
    ],
    [
      "far seek latency",
      (evidence) => {
        evidence.threadedWasm.farSeek.targetRunStartLatencyMs = 501;
      },
      "far-seek target",
    ],
    [
      "far seek action preceded active lookahead",
      (evidence) => {
        evidence.threadedWasm.farSeek.reset.lookaheadRunStartAtMs = 20_001;
      },
      "far-seek target",
    ],
    [
      "far seek terminal preceded action",
      (evidence) => {
        evidence.threadedWasm.farSeek.discardedTerminalAtMs = 19_999;
      },
      "far-seek target",
    ],
    [
      "far seek derived latency mismatch",
      (evidence) => {
        evidence.threadedWasm.farSeek.targetAudioLatencyMs = 99;
      },
      "far-seek target",
    ],
    [
      "far seek session",
      (evidence) => {
        evidence.threadedWasm.farSeek.targetSessionGeneration = 9;
      },
      "far-seek target",
    ],
    [
      "far seek audio",
      (evidence) => {
        evidence.threadedWasm.farSeek.targetAudioPlayingAtMs = null;
      },
      "far-seek target",
    ],
    [
      "timeout replay",
      (evidence) => {
        evidence.threadedWasm.timeoutRecovery.pendingRequestReplayed = false;
      },
      "forced timeout",
    ],
    [
      "watchdog timing",
      (evidence) => {
        evidence.threadedWasm.timeoutRecovery.watchdogDelayMs = 1_001;
      },
      "forced timeout",
    ],
    [
      "single-thread watchdog",
      (evidence) => {
        evidence.fallbacks.wasmSingleThread.workerTerminations = 1;
      },
      "wasmSingleThread",
    ],
    [
      "unavailable WebGPU coverage",
      (evidence) => {
        evidence.fallbacks.webgpu.executableCoverage.sha256 = HASH;
      },
      "adapter-unavailable WebGPU evidence",
    ],
    [
      "artifact exposure",
      (evidence) => {
        evidence.artifact.loadedWorkerPath = "/assets/stale-worker.js";
      },
      "production JSEP Wasm",
    ],
    [
      "worker network coverage",
      (evidence) => {
        evidence.network.nestedPthreadWorkersAttached = 0;
      },
      "network instrumentation was incomplete",
    ],
    [
      "worker bootstrap overmatch",
      (evidence) => {
        evidence.network.targetBootstrapSettlements[0].method = "POST";
      },
      "network instrumentation was incomplete",
    ],
    [
      "missing worker bootstrap settlement",
      (evidence) => {
        evidence.network.targetBootstrapSettlements = [];
      },
      "network instrumentation was incomplete",
    ],
    [
      "unsettled network",
      (evidence) => {
        evidence.network.outstandingRequests = 1;
      },
      "network instrumentation was incomplete",
    ],
    [
      "non-loopback privacy",
      (evidence) => {
        evidence.network.nonLoopbackRequests.push({
          method: "POST",
          url: "https://example.test/upload",
        });
      },
      "non-loopback HTTP(S)",
    ],
    [
      "final worker quiescence",
      (evidence) => {
        evidence.finalIsolation.activeSpeechWorkers = 1;
      },
      "not explicitly quiesced",
    ],
    [
      "browser scenario error",
      (evidence) => {
        evidence.browserDiagnostics.errors.push({ code: "scenario-error" });
      },
      "browser diagnostics contain an error",
    ],
    [
      "escaped browser survivor",
      (evidence) => {
        evidence.cleanup.browserTrackedSurvivors = 1;
      },
      "not fully cleaned up",
    ],
    [
      "server descendant survivor",
      (evidence) => {
        evidence.cleanup.serverTrackedSurvivors = 1;
      },
      "not fully cleaned up",
    ],
    [
      "cleanup identity proof",
      (evidence) => {
        evidence.cleanup.browserTrackedProcessIdentityHashes.pop();
      },
      "not fully cleaned up",
    ],
    [
      "server listener cleanup",
      (evidence) => {
        evidence.cleanup.serverPortReleased = false;
      },
      "not fully cleaned up",
    ],
    [
      "browser cleanup",
      (evidence) => {
        evidence.cleanup.survivingBrowserProcesses = 1;
      },
      "not fully cleaned up",
    ],
  ];

  for (const [name, mutate, expected] of cases) {
    const evidence = clone(passingEvidence());
    mutate(evidence);
    assert.ok(
      validateOfflineCancellationEvidence(evidence).some((failure) =>
        failure.includes(expected),
      ),
      name,
    );
  }
});

test("browser errors win over a simultaneously satisfied predicate", () => {
  let predicateCalled = false;
  assert.throws(
    () =>
      evaluateBrowserStatePredicate(
        { errors: ["same-snapshot sentinel"] },
        () => {
          predicateCalled = true;
          return true;
        },
        "the synthetic scenario",
      ),
    /same-snapshot sentinel/u,
  );
  assert.equal(predicateCalled, false);
  assert.equal(
    evaluateBrowserStatePredicate({ errors: [] }, () => "matched", "healthy"),
    "matched",
  );
});

test("rejects private prose, absolute paths, raw payloads, and textLength", () => {
  const evidence = passingEvidence();
  evidence.debug = {
    payload: { id: 12 },
    profile: "/tmp/linelight-private-profile",
    prose: "I like my friend Tiarnan and regretted attrition",
    textLength: 12,
  };
  const violations = findEvidencePrivacyViolations(evidence);
  assert.ok(violations.includes("$evidence.debug.payload"));
  assert.ok(violations.includes("$evidence.debug.profile"));
  assert.ok(violations.includes("$evidence.debug.prose"));
  assert.ok(violations.includes("$evidence.debug.textLength"));
  assert.ok(
    validateOfflineCancellationEvidence(evidence).some((failure) =>
      failure.includes("forbidden private/raw fields"),
    ),
  );
});

test("authoritative recording requires the owned server and exact fixture", () => {
  assert.throws(
    () =>
      parseArguments([
        "--profile",
        "/tmp/linelight-profile",
        "--record",
        "--url",
        "http://127.0.0.1:5212/",
      ]),
    /harness-owned production server/u,
  );
  assert.throws(
    () =>
      parseArguments([
        "--profile",
        "/tmp/linelight-profile",
        "--record",
        "--fixture",
        "/tmp/arbitrary.pdf",
      ]),
    /exact synthetic fixture/u,
  );
  const options = parseArguments([
    "--profile",
    "/tmp/linelight-profile",
    "--record",
  ]);
  assert.equal(options.record, true);
  assert.equal(options.appUrl, null);
  assert.ok(options.fixture.endsWith(FIXTURE_PATH));
});

test("clean target baseline allows one about:blank page and no workers", () => {
  assert.deepEqual(
    validateCleanTargetBaseline([
      { targetId: "page-1", type: "page", url: "about:blank" },
    ]),
    {
      baselinePageCount: 1,
      baselinePageUrl: "about://non-http-resource",
      preexistingSpeechWorkers: 0,
      preexistingWorkers: 0,
    },
  );
  assert.throws(
    () =>
      validateCleanTargetBaseline([
        { targetId: "page-1", type: "page", url: "about:blank" },
        { targetId: "page-2", type: "page", url: "https://example.test" },
      ]),
    /exactly one about:blank/u,
  );
  assert.throws(
    () =>
      validateCleanTargetBaseline([
        { targetId: "page-1", type: "page", url: "about:blank" },
        {
          targetId: "worker-1",
          type: "worker",
          url: "http://127.0.0.1:5212/assets/offline-speech.worker.js",
        },
      ]),
    /no preexisting worker/u,
  );
});

test("target coverage counts only the exact offline worker ancestry", () => {
  const workerUrl = "http://127.0.0.1:5212/assets/offline-speech.worker.js";
  const targets = [
    {
      attachComplete: true,
      detached: false,
      parentSessionId: null,
      sessionId: "speech",
      type: "worker",
      url: workerUrl,
    },
    {
      attachComplete: true,
      detached: false,
      parentSessionId: "speech",
      sessionId: "pthread-1",
      type: "worker",
      url: "blob:http://127.0.0.1:5212/pthread-1",
    },
    {
      attachComplete: true,
      detached: false,
      parentSessionId: "pthread-1",
      sessionId: "pthread-2",
      type: "worker",
      url: "blob:http://127.0.0.1:5212/pthread-2",
    },
    {
      attachComplete: true,
      detached: false,
      parentSessionId: null,
      sessionId: "pdf-worker",
      type: "worker",
      url: "http://127.0.0.1:5212/assets/pdf.worker.js",
    },
    {
      attachComplete: false,
      detached: false,
      parentSessionId: "speech",
      sessionId: "unattached-child",
      type: "worker",
      url: "blob:http://127.0.0.1:5212/unattached",
    },
  ];
  assert.deepEqual(summarizeAttachedTargetCoverage(targets, workerUrl), {
    activeOfflineSpeechWorkers: 1,
    nestedPthreadWorkersAttached: 2,
    offlineSpeechWorkerAttached: true,
    offlineSpeechWorkersAttached: 1,
    speechWorkersDetached: 0,
  });
  targets[0].detached = true;
  assert.equal(
    summarizeAttachedTargetCoverage(targets, workerUrl)
      .activeOfflineSpeechWorkers,
    0,
  );
  assert.equal(
    summarizeAttachedTargetCoverage(targets, workerUrl).speechWorkersDetached,
    1,
  );
});

test("unterminated synthesis detection respects request epoch and boundary", () => {
  const request = (id, epoch, sequence) => ({
    direction: "out",
    epoch,
    id,
    sequence,
    type: "synthesize",
  });
  const terminal = (id, epoch, sequence, type = "success") => ({
    direction: "in",
    epoch,
    id,
    sequence,
    type,
  });
  const state = {
    workerEvents: [
      request(1, 1, 1),
      terminal(1, 1, 2),
      request(2, 1, 3),
      terminal(2, 2, 4),
      request(3, 1, 5),
      terminal(3, 1, 6, "canceled"),
      request(4, 1, 7),
    ],
  };
  assert.deepEqual(
    findUnterminatedSynthesisRequests(state, 5).map(({ id }) => id),
    [2],
  );
  assert.deepEqual(
    findUnterminatedSynthesisRequests(state).map(({ id }) => id),
    [2, 4],
  );
});

test("worker bootstrap settlement requires exact attached target identity", () => {
  const request = {
    method: "GET",
    resourceType: "Script",
    sessionId: "speech-session",
    url: "http://127.0.0.1:5212/assets/offline-speech.worker.js",
  };
  const target = {
    attachComplete: true,
    parentSessionId: "speech-session",
    type: "worker",
    url: request.url,
  };
  assert.equal(isAttachedTargetBootstrapRequest(request, target), true);
  assert.equal(
    isAttachedTargetBootstrapRequest(request, {
      ...target,
      attachComplete: false,
    }),
    false,
  );
  assert.equal(
    isAttachedTargetBootstrapRequest(
      { ...request, sessionId: "unrelated-session" },
      target,
    ),
    false,
  );
  assert.equal(
    isAttachedTargetBootstrapRequest(
      { ...request, url: "http://127.0.0.1:5212/assets/unrelated.js" },
      target,
    ),
    false,
  );
  assert.equal(
    isAttachedTargetBootstrapRequest(
      { ...request, resourceType: "Fetch" },
      target,
    ),
    false,
  );
});

test("owned process proof follows escaped descendants and ignores PID reuse", () => {
  const processes = [
    {
      commandLine:
        "/usr/bin/brave --user-data-dir=/tmp/linelight-issue55-browser-test/profile",
      cwd: "/opt",
      pgrp: 100,
      pid: 100,
      ppid: 1,
      startTimeTicks: 1,
    },
    {
      commandLine: "/usr/bin/brave --type=renderer",
      cwd: "/opt",
      pgrp: 100,
      pid: 101,
      ppid: 100,
      startTimeTicks: 2,
    },
    {
      commandLine: "/usr/bin/brave --type=utility",
      cwd: "/opt",
      pgrp: 999,
      pid: 102,
      ppid: 101,
      startTimeTicks: 3,
    },
    {
      commandLine: "/usr/bin/brave --type=renderer",
      cwd: "/opt",
      pgrp: 500,
      pid: 103,
      ppid: 1,
      startTimeTicks: 4,
    },
  ];
  const tracked = selectOwnedProcessTree(processes, {
    commandNeedle:
      "--user-data-dir=/tmp/linelight-issue55-browser-test/profile",
    processGroupId: 100,
    rootPid: 100,
  });
  assert.deepEqual(
    tracked.map((process_) => process_.pid),
    [100, 101, 102],
  );
  assert.equal(
    countTrackedProcessSurvivors([{ pid: 102, startTimeTicks: 3 }], tracked),
    1,
  );
  assert.equal(
    countTrackedProcessSurvivors([{ pid: 102, startTimeTicks: 30 }], tracked),
    0,
  );

  const serverProcesses = [
    {
      commandLine: "npm run start -- --port 5212",
      cwd: "/repo",
      pgrp: 200,
      pid: 200,
      ppid: 1,
      startTimeTicks: 5,
    },
    {
      commandLine: "workerd serve",
      cwd: "/repo",
      pgrp: 777,
      pid: 201,
      ppid: 200,
      startTimeTicks: 6,
    },
    {
      commandLine: "npm run start -- --port 5212",
      cwd: "/other-repo",
      pgrp: 300,
      pid: 202,
      ppid: 1,
      startTimeTicks: 7,
    },
  ];
  assert.deepEqual(
    selectOwnedProcessTree(serverProcesses, {
      commandNeedle: "--port 5212",
      processGroupId: 200,
      requiredCwd: "/repo",
      rootPid: 200,
    }).map((process_) => process_.pid),
    [200, 201],
  );
});

test("bounds CDP commands and rejects in-flight work when the target closes", async () => {
  const timedSocket = new FakeWebSocket();
  const timedSession = new AttachedCdpSession(timedSocket, {
    commandTimeoutMs: 5,
  });
  await assert.rejects(
    timedSession.send("Network.enable", {}, "worker-1"),
    /Timed out waiting for CDP Network\.enable \(worker-1\)/u,
  );

  const closedSocket = new FakeWebSocket();
  const closedSession = new AttachedCdpSession(closedSocket, {
    commandTimeoutMs: 1_000,
  });
  const pending = closedSession.send("Runtime.enable");
  closedSocket.dispatchEvent(new Event("close"));
  await assert.rejects(pending, /debugging connection closed/u);
  await assert.rejects(
    closedSession.send("Page.enable"),
    /debugging target is closed/u,
  );
});

test("records child-target attach failures and still attempts debugger resume", async () => {
  const calls = [];
  const attachFailures = [];
  const cdp = {
    async send(method, _parameters, sessionId) {
      calls.push({ method, sessionId });
      if (method === "Network.enable") throw new Error("attach sentinel");
      if (method === "Runtime.runIfWaitingForDebugger") {
        throw new Error("resume sentinel");
      }
      return {};
    },
  };
  const result = await attachCdpChildTarget(
    cdp,
    {
      sessionId: "worker-7",
      targetInfo: { type: "worker" },
      waitingForDebugger: true,
    },
    attachFailures,
  );
  assert.deepEqual(result, { attached: false, resumed: false });
  assert.ok(calls.some((entry) => entry.method === "Network.enable"));
  assert.ok(
    calls.some((entry) => entry.method === "Runtime.runIfWaitingForDebugger"),
  );
  assert.deepEqual(
    attachFailures.map((entry) => entry.code),
    ["target-attach-failed", "target-resume-failed"],
  );
  assert.ok(
    attachFailures.every((entry) => /^[a-f\d]{64}$/u.test(entry.sha256)),
  );
});
