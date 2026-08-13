import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AttachedCdpSession,
  analyzeOfflineCacheTransition,
  attachCdpChildTarget,
  classifyCpuProcessRole,
  classifyTargetAttachFailures,
  correlateWorkerMessageSessionGeneration,
  countTrackedProcessSurvivors,
  evaluateBrowserStatePredicate,
  findEvidencePrivacyViolations,
  findUnterminatedSynthesisRequests,
  isAttachedTargetBootstrapRequest,
  parseArguments,
  requiredOfflineCacheSnapshot,
  selectOwnedProcessTree,
  summarizeAttachedTargetCoverage,
  summarizeConsoleDiagnostics,
  validateCleanTargetBaseline,
  validateOfflineCancellationEvidence,
} from "../scripts/run-offline-cancellation-regression.mjs";

const JSEP_SHA256 =
  "1e5a323ca41d859f324694c7b5ba2052bf8c1a96ff9721bc62e94f874d379fe1";
const FIXTURE_SHA256 =
  "1addfceae4b869eec37dae4755d576ccd0fd7e1ce505dc856da3b96acbf3f06c";
const WEBGPU_COVERAGE_SHA256 =
  "8bcea58cc78b82166246be9519a3d16a31b3378b55d4d5557359a3e275b5cfcb";
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
  "public/favicon.ico",
  "public/manifest.webmanifest",
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
const JSEP_PATH = "/assets/ort-wasm-simd-threaded.jsep-test.wasm";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cpuSample(
  monotonicMs,
  { pid = 42, role = "browser", ticks = 10 } = {},
) {
  return {
    monotonicMs,
    processes: [
      {
        pid,
        role,
        startTimeTicks: 1,
        ticks,
      },
    ],
    wallTimeMs: 1_000_000 + monotonicMs,
  };
}

function cpuInterval(
  startMonotonicMs,
  cpuPercent,
  { endAfterActionMs } = {},
) {
  const interval = {
    cpuPercent,
    elapsedMs: 50,
    endMonotonicMs: startMonotonicMs + 50,
    processCount: 1,
    startMonotonicMs,
  };
  if (endAfterActionMs !== undefined) interval.endAfterActionMs = endAfterActionMs;
  return interval;
}

function passingCacheInventory() {
  const entries = [
    ...Array.from({ length: 53 }, (_, index) => ({
      byteLength: 1_000 + index,
      cacheName: "linelight-offline-model-v2",
      requestSha256: sha256(`model-request-${index}`),
      sha256: sha256(`model-${index}`),
      url: `/offline-model/reviewed/model-${index}`,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      byteLength: 500 + index,
      cacheName: "linelight-offline-voices-v4",
      requestSha256: sha256(`voice-request-${index}`),
      sha256: sha256(`voice-${index}`),
      url: `/Supertone/supertonic-3/voice_styles/voice-${index}.json`,
    })),
    {
      byteLength: 24_113_968,
      cacheName: "linelight-assets-v1",
      requestSha256: sha256("jsep-request"),
      sha256: JSEP_SHA256,
      url: JSEP_PATH,
    },
  ];
  entries.sort((left, right) =>
    (left.cacheName + left.url + left.requestSha256).localeCompare(
      right.cacheName + right.url + right.requestSha256,
    ),
  );
  return { entries, sha256: sha256(JSON.stringify(entries)) };
}

function cancellation(index) {
  const actionAtMs = 1_000 + index * 2_000;
  const intervals = [
    cpuInterval(actionAtMs - 50, 90, { endAfterActionMs: -50 }),
    cpuInterval(actionAtMs, 10, { endAfterActionMs: 0 }),
    cpuInterval(actionAtMs + 50, 4, { endAfterActionMs: 50 }),
  ];
  return {
    actionAtMs,
    actionNodeMonotonicMs: actionAtMs + 50,
    actionRoundTripMs: 12,
    audiblePauseAtMs: actionAtMs + 3,
    audiblePauseLatencyMs: 3,
    cooperative: true,
    cpu: {
      activeIntervals: structuredClone(intervals.slice(0, 2)),
      cpuPercentAtIdle: 4,
      idleByMs: 50,
      intervals,
      peakActiveCpuPercent: 90,
      samples: [
        cpuSample(actionAtMs - 50, { ticks: 10 }),
        cpuSample(actionAtMs, { ticks: 15 }),
        cpuSample(actionAtMs + 50, { ticks: 16 }),
        cpuSample(actionAtMs + 100, { ticks: 16 }),
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

function protocolEvent(overrides) {
  return {
    atMs: overrides.atMs,
    backendDevice: null,
    cooperative: null,
    direction: overrides.direction,
    elapsedMilliseconds: null,
    epoch: overrides.epoch,
    generation: null,
    id: overrides.id,
    progress: null,
    sequence: overrides.sequence,
    sessionGeneration: null,
    stage: null,
    type: overrides.type,
    wallTimeMs: 1_000_000 + overrides.atMs,
    wasmThreads: null,
    ...overrides,
  };
}

function passingEvidence() {
  const sourceFiles = Object.fromEntries(
    SOURCE_FILES.map((file) => [file, HASH]),
  );
  const jsepWasmPath =
    "dist/client/assets/ort-wasm-simd-threaded.jsep-test.wasm";
  const workerPath = "dist/client/assets/offline-speech.worker-test.js";
  const cacheBefore = passingCacheInventory();
  const cacheAfter = structuredClone(cacheBefore);
  const runtimeManifest = {
    assetPaths: [JSEP_PATH, "/assets/offline-speech.worker-test.js"].sort(),
    deploymentId: "reviewed-test-build",
  };
  runtimeManifest.sha256 = sha256(JSON.stringify(runtimeManifest.assetPaths));
  const cacheTransition = analyzeOfflineCacheTransition(
    cacheBefore,
    cacheAfter,
    {
      currentJsepPath: JSEP_PATH,
      currentRuntimeAssetPaths: runtimeManifest.assetPaths,
    },
  );
  const timeoutCache = requiredOfflineCacheSnapshot(cacheBefore, JSEP_PATH);
  return {
    artifact: {
      jsepWasmPath,
      jsepWasmSha256: JSEP_SHA256,
      loadedJsepWasm: true,
      loadedJsepWasmPath: JSEP_PATH,
      loadedWorker: true,
      loadedWorkerPath: "/assets/offline-speech.worker-test.js",
      workerCancellationIdentity: true,
      workerPath,
      workerSha256: HASH,
    },
    browserDiagnostics: {
      consoleDiagnostics: [],
      consoleErrors: [],
      errors: [],
      runtimeExceptions: [],
    },
    build: {
      exactCleanSource: true,
      exitCode: 0,
      performed: true,
      sourceCommit: COMMIT,
      sourceFilesSha256: sha256(JSON.stringify(sourceFiles)),
    },
    cache: {
      after: cacheAfter,
      before: cacheBefore,
      currentRuntimeManifest: runtimeManifest,
      transition: cacheTransition,
    },
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
      activePthreadWorkers: 0,
      activeSpeechWorkers: 0,
      narrationStopped: true,
      networkSettled: true,
      pthreadAncestryHashesBefore: [
        sha256("speech-root\0pthread-1"),
        sha256("speech-root\0pthread-2"),
      ].sort(),
      pthreadAncestryHashesDetached: [
        sha256("speech-root\0pthread-1"),
        sha256("speech-root\0pthread-2"),
      ].sort(),
      pthreadWorkersDetached: 2,
      pthreadWorkersDetachedTotal: 2,
      pthreadWorkersObserved: 2,
      rootSessionHashesBefore: [sha256("speech-root")],
      rootSessionHashesDetached: [sha256("speech-root")],
      speechWorkersDetached: 1,
      speechWorkersDetachedTotal: 1,
      speechWorkersObserved: 1,
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
      intentionalServiceWorkerUnregisterRaces: [],
      loadingFailures: [],
      nestedPthreadWorkersAttached: 2,
      nonLoopbackRequests: [],
      offlineSpeechWorkerAttached: true,
      orphanedOfflineWorkerTargets: 0,
      outstandingAttachPromises: 0,
      outstandingRequests: 0,
      responseFailures: [],
      serviceWorkerBypassed: true,
      serviceWorkerLifecycle: {
        attachFixedPointBeforeUnregister: true,
        phase: "service-worker-unregister",
        registrations: 1,
        unregistered: 1,
      },
      sameUrlNestedPthreadWorkersAttached: 2,
      targetBootstrapSettlements: [
        {
          method: "GET",
          resourceType: "Script",
          targetType: "worker",
          terminalReason: "target-attached",
          url: "http://127.0.0.1:5212/assets/offline-speech.worker-test.js",
        },
      ],
      unexplainedAttachFailures: [],
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
          cpuInterval(100, 4),
          cpuInterval(150, 3),
        ],
        p95CpuPercent: 4,
        samples: [
          cpuSample(100, { ticks: 10 }),
          cpuSample(150, { ticks: 11 }),
          cpuSample(200, { ticks: 11 }),
        ],
      },
      events: [
        protocolEvent({
          atMs: 13_000,
          direction: "out",
          epoch: 1,
          id: 40,
          sequence: 180,
          type: "synthesize",
        }),
        protocolEvent({
          atMs: 13_900,
          direction: "in",
          epoch: 1,
          id: 40,
          sequence: 190,
          sessionGeneration: 3,
          type: "success",
        }),
        protocolEvent({
          atMs: 14_500,
          direction: "out",
          epoch: 1,
          id: 41,
          sequence: 191,
          type: "synthesize",
        }),
      ],
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
        targetAudioId: 9,
        targetAudioLatencyMs: 100,
        targetAudioPlayingAtMs: 20_100,
        targetAudioSourceRequestId: 42,
        targetAudioSourceSessionGeneration: 3,
        targetAudioSourceWorkerEpoch: 1,
        targetRequestId: 42,
        targetRunStartAtMs: 20_030,
        targetRunStartLatencyMs: 30,
        targetSessionGeneration: 3,
        targetStartedAfterDiscardedTerminal: true,
        targetWorkerEpoch: 1,
      },
      preparedResume: {
        audioCreatedAtMs: 14_000,
        audioCreatedBeforePause: true,
        audioId: 7,
        discarded: false,
        duplicatePreparedSynthesisRequests: 0,
        interveningDistinctRequestIds: [41],
        pauseAtMs: 14_100,
        playedAtMs: 15_000,
        requestAtMs: 13_000,
        requestId: 40,
        requestSequence: 180,
        requestSessionGeneration: 3,
        requestSucceededAtMs: 13_900,
        requestSuccessSequence: 190,
        requestWorkerEpoch: 1,
        resumedCurrentAtMs: 14_200,
        sameAudioPlayed: true,
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
        canceledRequestReplayed: false,
        forced: true,
        modelRequests: 0,
        newWorkerEpoch: 2,
        oldWorkerEpoch: 1,
        oldWorkerTerminated: true,
        pendingRequestReplayed: true,
        pendingRequestSucceeded: true,
        requiredCacheAfter: structuredClone(timeoutCache),
        requiredCacheBefore: structuredClone(timeoutCache),
        requiredCacheSubsetUnchanged: true,
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

test("final quiescence allows no active pthreads before WebGPU teardown", () => {
  const evidence = passingEvidence();
  evidence.finalIsolation.pthreadAncestryHashesBefore = [];
  evidence.finalIsolation.pthreadAncestryHashesDetached = [];
  evidence.finalIsolation.pthreadWorkersDetached = 0;
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
      "CPU baseline unknown field",
      (evidence) => {
        evidence.threadedWasm.cpuBaseline.debugTag = "safe-looking";
      },
      "measured idle CPU baseline",
    ],
    [
      "CPU baseline interval unknown field",
      (evidence) => {
        evidence.threadedWasm.cpuBaseline.intervals[0].debugTag =
          "safe-looking";
      },
      "measured idle CPU baseline",
    ],
    [
      "CPU role command leak",
      (evidence) => {
        evidence.threadedWasm.cancellations[0].cpu.samples[0].processes[0].role =
          "renderer --user-data-dir=/tmp/private-profile";
      },
      "enum-only owned-process CPU evidence",
    ],
    [
      "CPU process unknown field",
      (evidence) => {
        evidence.threadedWasm.cpuBaseline.samples[0].processes[0].debugTag =
          "safe-looking";
      },
      "measured idle CPU baseline",
    ],
    [
      "CPU unknown role",
      (evidence) => {
        evidence.threadedWasm.cancellations[0].cpu.samples[0].processes[0].role =
          "broker";
      },
      "enum-only owned-process CPU evidence",
    ],
    [
      "CPU sample unknown field",
      (evidence) => {
        evidence.threadedWasm.cancellations[0].cpu.samples[0].debugTag =
          "safe-looking";
      },
      "enum-only owned-process CPU evidence",
    ],
    [
      "CPU cancellation unknown field",
      (evidence) => {
        evidence.threadedWasm.cancellations[0].cpu.debugTag = "safe-looking";
      },
      "enum-only owned-process CPU evidence",
    ],
    [
      "CPU cancellation interval unknown field",
      (evidence) => {
        evidence.threadedWasm.cancellations[0].cpu.intervals[0].debugTag =
          "safe-looking";
      },
      "enum-only owned-process CPU evidence",
    ],
    [
      "CPU active interval unknown field",
      (evidence) => {
        evidence.threadedWasm.cancellations[0].cpu.activeIntervals[0].debugTag =
          "safe-looking";
      },
      "enum-only owned-process CPU evidence",
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
      "worker event private text",
      (evidence) => {
        evidence.threadedWasm.events[0].text = "private excerpt";
      },
      "worker event evidence",
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
      "prepared audio replaced",
      (evidence) => {
        evidence.threadedWasm.preparedResume.sameAudioPlayed = false;
      },
      "already prepared audio",
    ],
    [
      "prepared request duplicated",
      (evidence) => {
        evidence.threadedWasm.preparedResume.duplicatePreparedSynthesisRequests = 1;
      },
      "already prepared audio",
    ],
    [
      "prepared refill reused its request",
      (evidence) => {
        evidence.threadedWasm.preparedResume.interveningDistinctRequestIds = [
          evidence.threadedWasm.preparedResume.requestId,
        ];
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
      "far seek audio source identity",
      (evidence) => {
        evidence.threadedWasm.farSeek.targetAudioSourceRequestId = 41;
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
      "timeout cache subset",
      (evidence) => {
        evidence.threadedWasm.timeoutRecovery.requiredCacheSubsetUnchanged = false;
      },
      "forced timeout",
    ],
    [
      "timeout cache runtime substitution",
      (evidence) => {
        const forgedJsepPath = "/assets/forged-threaded-jsep.wasm";
        const forgedInventory = {
          entries:
            evidence.threadedWasm.timeoutRecovery.requiredCacheBefore.entries.map(
              (entry) =>
                entry.cacheName === "linelight-assets-v1"
                  ? { ...entry, url: forgedJsepPath }
                  : entry,
            ),
        };
        const forgedSnapshot = requiredOfflineCacheSnapshot(
          forgedInventory,
          forgedJsepPath,
        );
        evidence.threadedWasm.timeoutRecovery.requiredCacheBefore =
          forgedSnapshot;
        evidence.threadedWasm.timeoutRecovery.requiredCacheAfter =
          structuredClone(forgedSnapshot);
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
      "same-url pthread coverage",
      (evidence) => {
        evidence.network.sameUrlNestedPthreadWorkersAttached = 0;
      },
      "network instrumentation was incomplete",
    ],
    [
      "orphaned offline target",
      (evidence) => {
        evidence.network.orphanedOfflineWorkerTargets = 1;
      },
      "network instrumentation was incomplete",
    ],
    [
      "service-worker attach fixed point",
      (evidence) => {
        evidence.network.serviceWorkerLifecycle.attachFixedPointBeforeUnregister = false;
      },
      "network instrumentation was incomplete",
    ],
    [
      "unexplained attach failure",
      (evidence) => {
        const failure = {
          code: "target-attach-failed",
          detached: true,
          phase: "threaded-wasm",
          sha256: HASH,
          targetIdSha256: HASH,
          targetType: "worker",
        };
        evidence.network.attachFailures.push(failure);
        evidence.network.unexplainedAttachFailures.push(failure);
      },
      "network instrumentation was incomplete",
    ],
    [
      "favicon response failure",
      (evidence) => {
        evidence.network.responseFailures.push({
          method: "GET",
          requestId: "favicon",
          resourceType: "Other",
          sessionId: null,
          status: 404,
          url: "http://127.0.0.1:5212/favicon.ico",
        });
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
      "canceled network failure",
      (evidence) => {
        evidence.network.loadingFailures.push({
          canceled: true,
          code: "net::ERR_ABORTED",
          requestId: "reviewed-request",
          sessionId: null,
          url: "http://127.0.0.1:5212/assets/reviewed.js",
        });
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
      "final pthread quiescence",
      (evidence) => {
        evidence.finalIsolation.activePthreadWorkers = 1;
      },
      "not explicitly quiesced",
    ],
    [
      "final pthread identity",
      (evidence) => {
        evidence.finalIsolation.pthreadAncestryHashesDetached.pop();
      },
      "not explicitly quiesced",
    ],
    [
      "final cumulative pthread detach",
      (evidence) => {
        evidence.finalIsolation.pthreadWorkersDetachedTotal = 1;
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
      "runtime exception",
      (evidence) => {
        evidence.browserDiagnostics.runtimeExceptions.push({
          category: "runtime-exception",
          count: 1,
          phase: "webgpu-fallback",
          sessionClass: "offline-pthread",
          severity: "error",
          sha256: HASH,
        });
      },
      "browser diagnostics contain an error",
    ],
    [
      "console error group",
      (evidence) => {
        const diagnostic = {
          category: "runtime-console",
          count: 1,
          phase: "threaded-wasm",
          sessionClass: "offline-speech",
          severity: "error",
          sha256: HASH,
        };
        evidence.browserDiagnostics.consoleDiagnostics.push(diagnostic);
        evidence.browserDiagnostics.consoleErrors.push(diagnostic);
      },
      "browser diagnostics contain an error",
    ],
    [
      "required model cache mutation",
      (evidence) => {
        evidence.cache.after.entries[0].sha256 = HASH;
      },
      "required offline model",
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

test("success audio inherits its same-worker run session identity", () => {
  const sessions = new Map();
  assert.equal(
    correlateWorkerMessageSessionGeneration(
      { id: 17, sessionGeneration: 4, type: "wasm-run-start" },
      sessions,
    ),
    4,
  );
  assert.equal(sessions.get(17), 4);
  assert.equal(
    correlateWorkerMessageSessionGeneration(
      { id: 17, type: "wasm-run-end" },
      sessions,
    ),
    4,
  );
  assert.equal(sessions.get(17), 4);
  assert.equal(
    correlateWorkerMessageSessionGeneration(
      { id: 17, result: { audioData: new ArrayBuffer(0) }, type: "success" },
      sessions,
    ),
    4,
  );
  assert.equal(sessions.has(17), false);
  assert.equal(
    correlateWorkerMessageSessionGeneration(
      { id: 17, type: "progress" },
      sessions,
    ),
    null,
  );
});

test("CPU sampling reduces process command lines to exact role enums", () => {
  assert.equal(
    classifyCpuProcessRole(
      "/usr/bin/brave\0--type=renderer\0--user-data-dir=/tmp/private\0",
    ),
    "renderer",
  );
  assert.equal(
    classifyCpuProcessRole(
      "/usr/bin/brave\0--type=gpu-process\0--profile-directory=Private\0",
    ),
    "gpu-process",
  );
  assert.equal(
    classifyCpuProcessRole("/usr/bin/brave\0--type=renderer --secret\0"),
    "other",
  );
  assert.equal(
    classifyCpuProcessRole("/usr/bin/brave\0--private-switch=/tmp/value\0"),
    "other",
  );
  assert.equal(
    classifyCpuProcessRole("/usr/bin/brave\0--type=broker\0"),
    "other",
  );
  assert.equal(
    classifyCpuProcessRole("/usr/bin/brave\0--type=renderer\0", {
      isGroupLeader: true,
    }),
    "browser",
  );
});

test("recursively rejects private prose, filesystem paths, process arguments, and raw fields", () => {
  const evidence = passingEvidence();
  evidence.debug = {
    argv: ["--user-data-dir=/tmp/linelight-private-profile"],
    commandLine: "/usr/bin/brave --type=renderer",
    cwd: "/opt/linelight-private",
    embeddedFileUrl: "argument=file:///tmp/linelight-private",
    embeddedUnixPath: "worker=/srv/private/worker.js",
    encodedUnixPath: "argument=%2Ftmp%2Flinelight-private",
    homePath: "~/linelight-private",
    payload: { id: 12 },
    profile: "/tmp/linelight-private-profile",
    prose: "I like my friend Tiarnan and regretted attrition",
    tempPrefix: "TMPDIR=/var/tmp/linelight-private",
    text: "private excerpt",
    textLength: 12,
    uncPath: "\\\\private-host\\private-share\\profile",
    unreviewedAbsoluteUrlPath: "/assets/private-profile.js",
    userDataSwitch: "--user-data-dir=C:\\Users\\Private\\Profile",
    windowsPath: "C:\\Users\\Private\\Profile",
  };
  const violations = findEvidencePrivacyViolations(evidence);
  assert.ok(violations.includes("$evidence.debug.argv"));
  assert.ok(violations.includes("$evidence.debug.commandLine"));
  assert.ok(violations.includes("$evidence.debug.cwd"));
  assert.ok(violations.includes("$evidence.debug.embeddedFileUrl"));
  assert.ok(violations.includes("$evidence.debug.embeddedUnixPath"));
  assert.ok(violations.includes("$evidence.debug.encodedUnixPath"));
  assert.ok(violations.includes("$evidence.debug.homePath"));
  assert.ok(violations.includes("$evidence.debug.payload"));
  assert.ok(violations.includes("$evidence.debug.profile"));
  assert.ok(violations.includes("$evidence.debug.prose"));
  assert.ok(violations.includes("$evidence.debug.tempPrefix"));
  assert.ok(violations.includes("$evidence.debug.text"));
  assert.ok(violations.includes("$evidence.debug.textLength"));
  assert.ok(violations.includes("$evidence.debug.uncPath"));
  assert.ok(violations.includes("$evidence.debug.unreviewedAbsoluteUrlPath"));
  assert.ok(violations.includes("$evidence.debug.userDataSwitch"));
  assert.ok(violations.includes("$evidence.debug.windowsPath"));
  assert.ok(
    validateOfflineCancellationEvidence(evidence).some((failure) =>
      failure.includes("forbidden private/raw fields"),
    ),
  );
});

test("privacy scanning rejects each filesystem and process fragment independently", () => {
  const privateValues = [
    "/",
    "/用户/private",
    "//private-host/private-share",
    "x]/etc/passwd",
    "x;/etc/passwd",
    "x;file:///tmp/private",
    "x;%2Ftmp%2Fprivate",
    "%2F%2Fprivate-host%2Fprivate-share",
    "x]C:\\Users\\Private",
    "x]\\\\private-host\\private-share",
    "x;~/private",
    "--profile=Private",
    "x;TMPDIR=opaque",
    "--type=renderer",
    "private\0fragment",
  ];
  for (const privateValue of privateValues) {
    assert.deepEqual(
      findEvidencePrivacyViolations({ debug: { probe: privateValue } }),
      ["$evidence.debug.probe"],
      privateValue.replaceAll("\0", "\\0"),
    );
  }

  for (const privateKey of [
    "/tmp/private",
    "C:\\Users\\Private",
    "--type=renderer",
  ]) {
    const violations = findEvidencePrivacyViolations({
      debug: { [privateKey]: "safe-looking" },
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^\$evidence\.debug\.\$key\[[a-f\d]{12}\]$/u);
    assert.equal(violations[0].includes(privateKey), false);
  }

  assert.deepEqual(
    findEvidencePrivacyViolations({ debug: { PrOfIlEpAtH: "opaque" } }),
    ["$evidence.debug.PrOfIlEpAtH"],
  );
});

test("absolute URL-path exceptions are field, prefix, and encoding bound", () => {
  assert.deepEqual(findEvidencePrivacyViolations(passingEvidence()), []);

  const filesystemPrefix = passingEvidence();
  filesystemPrefix.cache.before.entries[0].url = "/tmp/private-profile";
  assert.ok(
    findEvidencePrivacyViolations(filesystemPrefix).includes(
      "$evidence.cache.before.entries[0].url",
    ),
  );

  const encodedSeparator = passingEvidence();
  encodedSeparator.artifact.loadedWorkerPath =
    "/assets/%2Ftmp/private-worker.js";
  assert.ok(
    findEvidencePrivacyViolations(encodedSeparator).includes(
      "$evidence.artifact.loadedWorkerPath",
    ),
  );

  const dotSegment = passingEvidence();
  dotSegment.network.targetBootstrapSettlements[0].url =
    "http://127.0.0.1:5212/assets/../tmp/private-worker.js";
  assert.ok(
    findEvidencePrivacyViolations(dotSegment).includes(
      "$evidence.network.targetBootstrapSettlements[0].url",
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
      url: workerUrl,
    },
    {
      attachComplete: true,
      detached: false,
      parentSessionId: "pthread-1",
      sessionId: "pthread-2",
      type: "worker",
      url: workerUrl,
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
    activeNestedPthreadWorkerAncestry: [
      { rootSessionId: "speech", sessionId: "pthread-1" },
      { rootSessionId: "speech", sessionId: "pthread-2" },
    ],
    activeNestedPthreadWorkers: 2,
    activeOfflineSpeechWorkers: 1,
    activeOfflineSpeechWorkerSessionIds: ["speech"],
    detachedNestedPthreadWorkerAncestry: [],
    detachedOfflineSpeechWorkerSessionIds: [],
    nestedPthreadWorkersAttached: 2,
    nestedPthreadWorkersDetached: 0,
    offlineSpeechWorkerAttached: true,
    offlineSpeechWorkersAttached: 1,
    orphanedOfflineWorkerTargets: 0,
    sameUrlNestedPthreadWorkersAttached: 2,
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
  assert.equal(
    summarizeAttachedTargetCoverage(targets, workerUrl)
      .activeNestedPthreadWorkers,
    2,
  );
  targets[1].detached = true;
  targets[2].detached = true;
  assert.equal(
    summarizeAttachedTargetCoverage(targets, workerUrl)
      .activeNestedPthreadWorkers,
    0,
  );
  assert.equal(
    summarizeAttachedTargetCoverage(targets, workerUrl)
      .nestedPthreadWorkersDetached,
    2,
  );
  targets.push({
    attachComplete: true,
    detached: false,
    parentSessionId: "missing-parent-session",
    sessionId: "orphaned-same-url-worker",
    type: "worker",
    url: workerUrl,
  });
  assert.equal(
    summarizeAttachedTargetCoverage(targets, workerUrl)
      .orphanedOfflineWorkerTargets,
    1,
  );
});

test("cache evidence preserves required local data while allowing only retired runtime deletion", () => {
  const before = passingCacheInventory();
  before.entries.push({
    byteLength: 1_024,
    cacheName: "linelight-assets-v1",
    requestSha256: sha256("retired-runtime-request"),
    sha256: sha256("retired-runtime"),
    url: "/assets/ort-wasm-simd-threaded.jsep-retired.wasm",
  });
  const after = structuredClone(before);
  after.entries.pop();
  const transition = analyzeOfflineCacheTransition(before, after, {
    currentJsepPath: JSEP_PATH,
    currentRuntimeAssetPaths: [JSEP_PATH],
  });
  assert.equal(transition.requiredSubsetUnchanged, true);
  assert.equal(transition.retiredRuntimeDeletions.length, 1);
  assert.deepEqual(transition.added, []);
  assert.deepEqual(transition.unexplainedRemovals, []);

  const requiredMutation = structuredClone(after);
  requiredMutation.entries[0].sha256 = HASH;
  const rejected = analyzeOfflineCacheTransition(after, requiredMutation, {
    currentJsepPath: JSEP_PATH,
    currentRuntimeAssetPaths: [JSEP_PATH],
  });
  assert.equal(rejected.requiredSubsetUnchanged, false);
  assert.equal(rejected.added.length, 1);
  assert.equal(rejected.unexplainedRemovals.length, 1);
});

test("range cache keys stay distinct without exposing their query strings", () => {
  const evidence = passingEvidence();
  for (const inventory of [evidence.cache.before, evidence.cache.after]) {
    for (const entry of inventory.entries.filter(
      (candidate) => candidate.cacheName === "linelight-offline-model-v2",
    )) {
      entry.url = "/offline-model/reviewed/vector_estimator.onnx";
    }
    inventory.entries.sort((left, right) =>
      (left.cacheName + left.url + left.requestSha256).localeCompare(
        right.cacheName + right.url + right.requestSha256,
      ),
    );
    inventory.sha256 = sha256(JSON.stringify(inventory.entries));
  }
  evidence.cache.transition = analyzeOfflineCacheTransition(
    evidence.cache.before,
    evidence.cache.after,
    {
      currentJsepPath: JSEP_PATH,
      currentRuntimeAssetPaths:
        evidence.cache.currentRuntimeManifest.assetPaths,
    },
  );
  const timeoutSnapshot = requiredOfflineCacheSnapshot(
    evidence.cache.before,
    JSEP_PATH,
  );
  evidence.threadedWasm.timeoutRecovery.requiredCacheBefore = timeoutSnapshot;
  evidence.threadedWasm.timeoutRecovery.requiredCacheAfter = structuredClone(
    timeoutSnapshot,
  );
  assert.deepEqual(validateOfflineCancellationEvidence(evidence), []);

  const modelEntries = evidence.cache.after.entries.filter(
    (entry) => entry.cacheName === "linelight-offline-model-v2",
  );
  modelEntries[1].requestSha256 = modelEntries[0].requestSha256;
  evidence.cache.after.entries.sort((left, right) =>
    (left.cacheName + left.url + left.requestSha256).localeCompare(
      right.cacheName + right.url + right.requestSha256,
    ),
  );
  evidence.cache.after.sha256 = sha256(
    JSON.stringify(evidence.cache.after.entries),
  );
  evidence.cache.transition = analyzeOfflineCacheTransition(
    evidence.cache.before,
    evidence.cache.after,
    {
      currentJsepPath: JSEP_PATH,
      currentRuntimeAssetPaths:
        evidence.cache.currentRuntimeManifest.assetPaths,
    },
  );
  assert.ok(
    validateOfflineCancellationEvidence(evidence).includes(
      "required offline model, voice, or current runtime cache data changed",
    ),
  );
});

test("cache evidence rejects query strings and fragments in retained paths", () => {
  for (const suffix of ["?private=query", "#private-fragment"]) {
    const evidence = passingEvidence();
    for (const inventory of [evidence.cache.before, evidence.cache.after]) {
      inventory.entries[0].url += suffix;
      inventory.entries.sort((left, right) =>
        (left.cacheName + left.url + left.requestSha256).localeCompare(
          right.cacheName + right.url + right.requestSha256,
        ),
      );
      inventory.sha256 = sha256(JSON.stringify(inventory.entries));
    }
    evidence.cache.transition = analyzeOfflineCacheTransition(
      evidence.cache.before,
      evidence.cache.after,
      {
        currentJsepPath: JSEP_PATH,
        currentRuntimeAssetPaths:
          evidence.cache.currentRuntimeManifest.assetPaths,
      },
    );
    const timeoutSnapshot = requiredOfflineCacheSnapshot(
      evidence.cache.before,
      JSEP_PATH,
    );
    evidence.threadedWasm.timeoutRecovery.requiredCacheBefore =
      timeoutSnapshot;
    evidence.threadedWasm.timeoutRecovery.requiredCacheAfter = structuredClone(
      timeoutSnapshot,
    );
    assert.ok(
      validateOfflineCancellationEvidence(evidence).includes(
        "required offline model, voice, or current runtime cache data changed",
      ),
      suffix,
    );
  }
});

test("the evidence validator accepts only a manifest-retired runtime cache deletion", () => {
  const evidence = passingEvidence();
  evidence.cache.before.entries.push({
    byteLength: 1_024,
    cacheName: "linelight-assets-v1",
    requestSha256: sha256("retired-runtime-request"),
    sha256: sha256("retired-runtime"),
    url: "/assets/ort-wasm-simd-threaded.jsep-retired.wasm",
  });
  evidence.cache.before.entries.sort((left, right) =>
    (left.cacheName + left.url + left.requestSha256).localeCompare(
      right.cacheName + right.url + right.requestSha256,
    ),
  );
  evidence.cache.before.sha256 = sha256(
    JSON.stringify(evidence.cache.before.entries),
  );
  evidence.cache.transition = analyzeOfflineCacheTransition(
    evidence.cache.before,
    evidence.cache.after,
    {
      currentJsepPath: JSEP_PATH,
      currentRuntimeAssetPaths:
        evidence.cache.currentRuntimeManifest.assetPaths,
    },
  );
  assert.deepEqual(validateOfflineCancellationEvidence(evidence), []);

  evidence.cache.before.entries.find(
    (entry) => entry.sha256 === sha256("retired-runtime"),
  ).url = "/private/unreviewed-entry";
  evidence.cache.before.entries.sort((left, right) =>
    (left.cacheName + left.url + left.requestSha256).localeCompare(
      right.cacheName + right.url + right.requestSha256,
    ),
  );
  evidence.cache.before.sha256 = sha256(
    JSON.stringify(evidence.cache.before.entries),
  );
  evidence.cache.transition = analyzeOfflineCacheTransition(
    evidence.cache.before,
    evidence.cache.after,
    {
      currentJsepPath: JSEP_PATH,
      currentRuntimeAssetPaths:
        evidence.cache.currentRuntimeManifest.assetPaths,
    },
  );
  assert.ok(
    validateOfflineCancellationEvidence(evidence).some((failure) =>
      failure.includes("required offline model"),
    ),
  );
});

test("the installed favicon is a real ICO referenced by the manifest", async () => {
  const [favicon, manifestText] = await Promise.all([
    readFile(new URL("../public/favicon.ico", import.meta.url)),
    readFile(
      new URL("../public/manifest.webmanifest", import.meta.url),
      "utf8",
    ),
  ]);
  assert.deepEqual([...favicon.subarray(0, 4)], [0, 0, 1, 0]);
  assert.ok(favicon.readUInt16LE(4) >= 1);
  const manifest = JSON.parse(manifestText);
  assert.ok(
    manifest.icons.some(
      (icon) =>
        icon.src === "/favicon.ico" &&
        icon.type === "image/x-icon" &&
        icon.sizes === "32x32",
    ),
  );
});

test("attach failure classification accepts only a detached unregister race", () => {
  const intentional = {
    code: "target-attach-failed",
    detached: true,
    phase: "service-worker-unregister",
    sha256: HASH,
    targetIdSha256: HASH,
    targetType: "service_worker",
  };
  const unrelated = {
    ...intentional,
    phase: "threaded-wasm",
    targetType: "worker",
  };
  assert.deepEqual(classifyTargetAttachFailures([intentional]), {
    intentionalServiceWorkerUnregisterRaces: [intentional],
    unexplained: [],
  });
  assert.deepEqual(classifyTargetAttachFailures([intentional, unrelated]), {
    intentionalServiceWorkerUnregisterRaces: [intentional],
    unexplained: [unrelated],
  });
});

test("console evidence groups only privacy-safe phase and session metadata", () => {
  const groups = summarizeConsoleDiagnostics([
    {
      category: "runtime-console",
      phase: "threaded-wasm",
      sessionClass: "offline-pthread",
      severity: "warning",
      sha256: HASH,
    },
    {
      category: "runtime-console",
      phase: "threaded-wasm",
      sessionClass: "offline-pthread",
      severity: "warning",
      sha256: HASH,
    },
  ]);
  assert.deepEqual(groups, [
    {
      category: "runtime-console",
      count: 2,
      phase: "threaded-wasm",
      sessionClass: "offline-pthread",
      severity: "warning",
      sha256: HASH,
    },
  ]);
  assert.deepEqual(findEvidencePrivacyViolations({ groups }), []);
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
  assert.equal(result.attached, false);
  assert.equal(result.resumed, false);
  assert.equal(result.failureRecords.length, 2);
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
  assert.ok(
    attachFailures.every((entry) =>
      /^[a-f\d]{64}$/u.test(entry.targetIdSha256),
    ),
  );
});
