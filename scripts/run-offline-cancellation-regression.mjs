#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_PDF_HIGHLIGHT_FIXTURE } from "./generate-pdf-highlight-fixture.mjs";
import {
  delay,
  evaluate,
  importFixture,
  stopProcessGroup,
  waitForExpression,
} from "./run-pdf-highlight-browser-regression.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const RECORDED_EVIDENCE_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "docs/evidence/issue-55",
);
const DEFAULT_OUTPUT_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "outputs/offline-cancellation",
);
const EVIDENCE_FILENAME = "offline-cancellation.json";
const DEFAULT_FIXTURE_RELATIVE_PATH =
  "tests/fixtures/pdf-highlights/issue-60-geometry.pdf";
const DEFAULT_FIXTURE_SHA256 =
  "1addfceae4b869eec37dae4755d576ccd0fd7e1ce505dc856da3b96acbf3f06c";
const WEBGPU_COVERAGE_RELATIVE_PATH = "tests/offline-model.test.mjs";
const WEBGPU_COVERAGE_SHA256 =
  "4f48ed467068c74080e7b8cfd215338da80b6b70d27fafb6fbbd709581ea9370";
const EXPECTED_JSEP_WASM_SHA256 =
  "1e5a323ca41d859f324694c7b5ba2052bf8c1a96ff9721bc62e94f874d379fe1";
const REQUIRED_ACTIVE_CANCELLATIONS = 5;
const CPU_SAMPLE_INTERVAL_MS = 50;
const MAX_CPU_SAMPLE_INTERVAL_MS = 100;
const MAX_PAUSE_LATENCY_MS = 50;
const MAX_CPU_QUIESCENCE_MS = 500;
const MAX_QUIESCENT_CPU_PERCENT = 50;
const MAX_FAR_SEEK_START_MS = 500;
const CANCELLATION_TIMEOUT_MS = 750;
const CANCELLATION_TIMEOUT_TOLERANCE_MS = 250;
const FALLBACK_OBSERVATION_MS = CANCELLATION_TIMEOUT_MS + 250;
const PREPARED_PROFILE_ORIGIN_PORT = 5212;
const EXTERNAL_MODEL_REQUEST_PATTERN =
  /(?:huggingface\.co|cdn\.jsdelivr\.net|raw\.githubusercontent\.com|kokoro|onnx\/model.*\.onnx|voices\/.*\.bin)/iu;
const SOURCE_EVIDENCE_FILES = Object.freeze([
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
  WEBGPU_COVERAGE_RELATIVE_PATH,
  "vendor/onnxruntime-web/CHECKSUMS.sha256",
  "vendor/onnxruntime-web/onnxruntime-web-1.22.0-dev.20250409-89f8206ba4.tgz",
]);

export class AttachedCdpSession {
  constructor(webSocket, { commandTimeoutMs = 15_000 } = {}) {
    this.commandTimeoutMs = commandTimeoutMs;
    this.closed = false;
    this.listeners = new Map();
    this.nextId = 1;
    this.pending = new Map();
    this.webSocket = webSocket;
    webSocket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {}, message.sessionId ?? null);
      }
    });
    const rejectPending = (reason) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(reason);
      }
      this.pending.clear();
    };
    webSocket.addEventListener("error", () => {
      rejectPending(new Error("The browser debugging connection failed."));
    });
    webSocket.addEventListener("close", () => {
      rejectPending(new Error("The browser debugging connection closed."));
    });
  }

  static async connect(url, timeoutMs = 15_000) {
    const webSocket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        webSocket.close();
        reject(
          new Error("Timed out connecting to the browser debugging target."),
        );
      }, timeoutMs);
      const settle = (callback) => (event) => {
        clearTimeout(timeout);
        callback(event);
      };
      webSocket.addEventListener("open", settle(resolve), { once: true });
      webSocket.addEventListener("error", settle(reject), { once: true });
    });
    return new AttachedCdpSession(webSocket);
  }

  send(method, params = {}, sessionId = null) {
    if (this.closed) {
      return Promise.reject(
        new Error(`Cannot send CDP ${method}; the debugging target is closed.`),
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(
          new Error(
            `Timed out waiting for CDP ${method} (${sessionId ?? "page"}).`,
          ),
        );
      }, this.commandTimeoutMs);
      this.pending.set(id, { method, reject, resolve, sessionId, timeout });
      try {
        this.webSocket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    this.closed = true;
    this.webSocket.close();
  }
}

export function parseArguments(argv) {
  const options = {
    appUrl: null,
    browser: process.env.LINELIGHT_BROWSER ?? "/usr/bin/brave-browser",
    fixture: DEFAULT_PDF_HIGHLIGHT_FIXTURE,
    outputDirectory: DEFAULT_OUTPUT_DIRECTORY,
    profile: null,
    record: false,
    timeoutMs: 180_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--url") options.appUrl = argv[++index];
    else if (argument === "--browser") options.browser = argv[++index];
    else if (argument === "--fixture") options.fixture = argv[++index];
    else if (argument === "--output") {
      options.outputDirectory = argv[++index];
    } else if (argument === "--profile") options.profile = argv[++index];
    else if (argument === "--record") options.record = true;
    else if (argument === "--timeout") {
      options.timeoutMs = Number(argv[++index]);
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        [
          "Usage: node scripts/run-offline-cancellation-regression.mjs --profile DIR [options]",
          "",
          "Runs the real Offline-natural Issue #55 acceptance matrix in an owned,",
          "headed Brave process group. DIR must be a disposable copy of a prepared",
          "profile; the harness refuses common live/default-profile paths.",
          "",
          "Options:",
          "  --profile DIR   Disposable Brave profile containing the offline pack.",
          "  --url URL       Use an already-running production LineLight server.",
          "  --browser PATH  Brave/Chromium executable.",
          "  --fixture PATH Deterministic local PDF fixture.",
          "  --output DIR    Transient evidence directory.",
          "  --record        Write docs/evidence/issue-55/offline-cancellation.json.",
          "  --timeout MS    Per-condition timeout (default: 180000).",
          "",
        ].join("\n"),
      );
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.profile) {
    throw new Error(
      "--profile is required; pass a disposable copy of a prepared Brave profile.",
    );
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout must be a positive number of milliseconds.");
  }
  if (options.record) options.outputDirectory = RECORDED_EVIDENCE_DIRECTORY;
  options.browser = path.resolve(options.browser);
  options.fixture = path.resolve(options.fixture);
  options.outputDirectory = path.resolve(options.outputDirectory);
  options.profile = path.resolve(options.profile);
  if (options.record && options.appUrl) {
    throw new Error(
      "--record requires the harness-owned production server; omit --url.",
    );
  }
  if (
    options.record &&
    options.fixture !== path.resolve(DEFAULT_PDF_HIGHLIGHT_FIXTURE)
  ) {
    throw new Error(
      `--record requires the exact synthetic fixture ${DEFAULT_FIXTURE_RELATIVE_PATH}.`,
    );
  }
  return options;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function pushFailure(failures, condition, message) {
  if (!condition) failures.push(message);
}

function validateCpuRecord(record, index, failures, idleThresholdPercent) {
  const prefix = `cancellation ${index + 1}`;
  const samples = record.cpu?.samples ?? [];
  pushFailure(
    failures,
    samples.length >= 3,
    `${prefix} did not retain enough raw owned-process CPU samples`,
  );
  const intervals = record.cpu?.intervals ?? [];
  pushFailure(
    failures,
    intervals.every(
      (entry) =>
        finiteNumber(entry.elapsedMs) &&
        entry.elapsedMs > 0 &&
        entry.elapsedMs <= MAX_CPU_SAMPLE_INTERVAL_MS,
    ),
    `${prefix} CPU sampling exceeded ${MAX_CPU_SAMPLE_INTERVAL_MS}ms cadence`,
  );
  pushFailure(
    failures,
    finiteNumber(record.cpu?.idleByMs) &&
      record.cpu.idleByMs <= MAX_CPU_QUIESCENCE_MS,
    `${prefix} did not reach near-idle CPU within ${MAX_CPU_QUIESCENCE_MS}ms`,
  );
  pushFailure(
    failures,
    finiteNumber(record.cpu?.cpuPercentAtIdle) &&
      record.cpu.cpuPercentAtIdle <= idleThresholdPercent,
    `${prefix} owned browser CPU remained above its ${idleThresholdPercent}% measured idle threshold`,
  );
  pushFailure(
    failures,
    (record.cpu?.activeIntervals?.length ?? 0) >= 1 &&
      finiteNumber(record.cpu?.peakActiveCpuPercent) &&
      record.cpu.peakActiveCpuPercent > idleThresholdPercent,
    `${prefix} did not retain a raw CPU sample above its measured idle threshold`,
  );
}

/**
 * Validate the durable, source-bound evidence produced by this harness. The
 * function is exported so synthetic tests can prove every fail-closed gate
 * without pretending that a unit test is a real Kokoro benchmark.
 */
export function validateOfflineCancellationEvidence(evidence) {
  const failures = [];
  pushFailure(
    failures,
    evidence?.schemaVersion === 1,
    "schemaVersion must be 1",
  );
  pushFailure(
    failures,
    evidence?.issue === 55,
    "evidence must identify Issue #55",
  );
  pushFailure(
    failures,
    evidence?.run?.headed === true &&
      evidence?.run?.ownedProcessGroup === true &&
      evidence?.run?.ownedProductionServer === true &&
      evidence?.run?.externalUrl === false &&
      evidence?.run?.appOrigin ===
        `http://127.0.0.1:${PREPARED_PROFILE_ORIGIN_PORT}`,
    "run must use a headed owned browser and the harness-owned production server",
  );
  const sourceFiles = evidence?.source?.files ?? {};
  pushFailure(
    failures,
    evidence?.source?.dirty === false &&
      /^[a-f\d]{40}$/u.test(evidence?.source?.commit ?? "") &&
      [...SOURCE_EVIDENCE_FILES, DEFAULT_FIXTURE_RELATIVE_PATH].every((file) =>
        /^[a-f\d]{64}$/u.test(sourceFiles[file] ?? ""),
      ),
    "source commit or required source-file hashes are missing or dirty",
  );
  pushFailure(
    failures,
    evidence?.fixture?.path === DEFAULT_FIXTURE_RELATIVE_PATH &&
      evidence?.fixture?.sha256 === DEFAULT_FIXTURE_SHA256 &&
      evidence?.fixture?.synthetic === true,
    "recorded evidence did not use the exact reviewed synthetic fixture",
  );
  pushFailure(
    failures,
    evidence?.isolation?.baselinePageCount === 1 &&
      evidence?.isolation?.baselinePageUrl === "about://non-http-resource" &&
      evidence?.isolation?.preexistingWorkers === 0 &&
      evidence?.isolation?.preexistingSpeechWorkers === 0 &&
      evidence?.isolation?.sessionRestorePurged === true,
    "browser clone did not start from one clean about:blank page",
  );
  pushFailure(
    failures,
    evidence?.build?.performed === true &&
      evidence?.build?.exactCleanSource === true &&
      evidence?.build?.exitCode === 0 &&
      evidence?.build?.sourceCommit === evidence?.source?.commit &&
      evidence?.build?.sourceFilesSha256 ===
        hashDiagnostic(JSON.stringify(evidence?.source?.files ?? {})),
    "production assets were not built from the exact clean evidence source",
  );
  pushFailure(
    failures,
    evidence?.artifact?.jsepWasmSha256 === EXPECTED_JSEP_WASM_SHA256 &&
      evidence?.artifact?.workerCancellationIdentity === true &&
      evidence?.artifact?.loadedJsepWasm === true &&
      evidence?.artifact?.loadedWorker === true &&
      /^[a-f\d]{64}$/u.test(evidence?.artifact?.workerSha256 ?? "") &&
      evidence?.artifact?.loadedJsepWasmPath ===
        `/${evidence?.artifact?.jsepWasmPath?.replace(/^dist\/client\//u, "")}` &&
      evidence?.artifact?.loadedWorkerPath ===
        `/${evidence?.artifact?.workerPath?.replace(/^dist\/client\//u, "")}` &&
      evidence?.network?.serviceWorkerBypassed === true,
    "production JSEP Wasm or worker cancellation identity is not the reviewed artifact",
  );
  pushFailure(
    failures,
    evidence?.privacy?.narrationTextRecorded === false,
    "evidence must not record imported narration text",
  );
  const privacyViolations = findEvidencePrivacyViolations(evidence);
  pushFailure(
    failures,
    privacyViolations.length === 0,
    `evidence contains forbidden private/raw fields: ${privacyViolations.join(", ")}`,
  );

  const cancellations = evidence?.threadedWasm?.cancellations ?? [];
  const cpuBaseline = evidence?.threadedWasm?.cpuBaseline;
  pushFailure(
    failures,
    (cpuBaseline?.samples?.length ?? 0) >= 3 &&
      (cpuBaseline?.intervals?.length ?? 0) >= 2 &&
      cpuBaseline.intervals.every(
        (entry) =>
          finiteNumber(entry.elapsedMs) &&
          entry.elapsedMs > 0 &&
          entry.elapsedMs <= MAX_CPU_SAMPLE_INTERVAL_MS,
      ) &&
      finiteNumber(cpuBaseline?.p95CpuPercent) &&
      finiteNumber(cpuBaseline?.derivedIdleThresholdPercent) &&
      cpuBaseline.p95CpuPercent <= cpuBaseline.derivedIdleThresholdPercent &&
      cpuBaseline.derivedIdleThresholdPercent <= MAX_QUIESCENT_CPU_PERCENT &&
      cpuBaseline.derivedIdleThresholdPercent ===
        Math.min(
          MAX_QUIESCENT_CPU_PERCENT,
          Math.max(10, Math.ceil(cpuBaseline.p95CpuPercent + 10)),
        ),
    "threaded-WASM evidence lacks a measured idle CPU baseline and derived threshold",
  );
  pushFailure(
    failures,
    cancellations.length >= REQUIRED_ACTIVE_CANCELLATIONS,
    `fewer than ${REQUIRED_ACTIVE_CANCELLATIONS} active cancellations were retained`,
  );
  for (const [index, record] of cancellations.entries()) {
    const prefix = `cancellation ${index + 1}`;
    pushFailure(
      failures,
      record.provenActive === true &&
        finiteNumber(record.runStartedAtMs) &&
        finiteNumber(record.actionAtMs) &&
        record.runStartedAtMs <= record.actionAtMs,
      `${prefix} was not proven active before Pause`,
    );
    pushFailure(
      failures,
      finiteNumber(record.runEndedAtMs) &&
        record.runStartedAtMs <= record.actionAtMs &&
        record.actionAtMs <= record.runEndedAtMs &&
        record.runEndedAtMs <= record.terminalAtMs,
      `${prefix} did not preserve start, action, run-end, terminal ordering`,
    );
    pushFailure(
      failures,
      record.cooperative === true && record.terminalType === "canceled",
      `${prefix} did not receive a cooperative canceled acknowledgement`,
    );
    pushFailure(
      failures,
      finiteNumber(record.audiblePauseLatencyMs) &&
        record.audiblePauseLatencyMs <= MAX_PAUSE_LATENCY_MS &&
        finiteNumber(record.actionRoundTripMs) &&
        record.actionRoundTripMs <= MAX_PAUSE_LATENCY_MS &&
        finiteNumber(record.endToEndPauseUpperBoundMs) &&
        record.endToEndPauseUpperBoundMs <= MAX_PAUSE_LATENCY_MS,
      `${prefix} audible Pause exceeded ${MAX_PAUSE_LATENCY_MS}ms`,
    );
    pushFailure(
      failures,
      Number.isInteger(record.workerEpoch) &&
        Number.isInteger(record.sessionGeneration) &&
        Number.isInteger(record.generation),
      `${prefix} is missing worker/session/run identity`,
    );
    if (firstCancellationIdentity(cancellations)) {
      const identity = firstCancellationIdentity(cancellations);
      pushFailure(
        failures,
        record.workerEpoch === identity.workerEpoch &&
          record.sessionGeneration === identity.sessionGeneration,
        `${prefix} silently changed worker or model session`,
      );
    }
    validateCpuRecord(
      record,
      index,
      failures,
      cpuBaseline?.derivedIdleThresholdPercent,
    );
  }

  const followup = evidence?.threadedWasm?.sameSessionFollowup;
  const first = cancellations[0];
  pushFailure(
    failures,
    followup?.success === true &&
      first &&
      followup.workerEpoch === first.workerEpoch &&
      followup.sessionGeneration === first.sessionGeneration &&
      followup.modelRequests === 0 &&
      followup.workerTerminations === 0,
    "cooperative cancel was not followed by same-worker, same-session success without a model fetch",
  );

  const prepared = evidence?.threadedWasm?.preparedResume;
  pushFailure(
    failures,
    prepared?.success === true &&
      prepared?.audioCreatedBeforePause === true &&
      prepared?.newSynthesisRequests === 0 &&
      prepared?.discarded === false,
    "Resume did not reuse already prepared audio unchanged",
  );

  const farSeek = evidence?.threadedWasm?.farSeek;
  pushFailure(
    failures,
    farSeek?.discardedRunProvenActive === true &&
      farSeek?.discardedRunCooperativelyCanceled === true &&
      finiteNumber(farSeek?.targetRunStartLatencyMs) &&
      farSeek.targetRunStartLatencyMs >= 0 &&
      farSeek.targetRunStartLatencyMs <= MAX_FAR_SEEK_START_MS &&
      farSeek?.targetStartedAfterDiscardedTerminal === true &&
      farSeek?.discardedWorkerEpoch === farSeek?.targetWorkerEpoch &&
      farSeek?.discardedSessionGeneration ===
        farSeek?.targetSessionGeneration &&
      finiteNumber(farSeek?.targetAudioPlayingAtMs) &&
      finiteNumber(farSeek?.targetAudioLatencyMs) &&
      finiteNumber(farSeek?.targetRunStartAtMs) &&
      farSeek.targetAudioPlayingAtMs >= farSeek.targetRunStartAtMs &&
      farSeek.targetAudioLatencyMs >= farSeek.targetRunStartLatencyMs,
    `far-seek target did not start within ${MAX_FAR_SEEK_START_MS}ms behind a cooperatively discarded run`,
  );

  const timeout = evidence?.threadedWasm?.timeoutRecovery;
  pushFailure(
    failures,
    timeout?.forced === true &&
      timeout?.oldWorkerTerminated === true &&
      timeout?.newWorkerEpoch > timeout?.oldWorkerEpoch &&
      timeout?.pendingRequestReplayed === true &&
      timeout?.pendingRequestSucceeded === true &&
      timeout?.canceledRequestReplayed === false &&
      timeout?.staleMessagesIgnored === true &&
      timeout?.modelRequests === 0 &&
      timeout?.cacheUnchanged === true &&
      finiteNumber(timeout?.watchdogDelayMs) &&
      timeout.watchdogDelayMs >=
        CANCELLATION_TIMEOUT_MS - CANCELLATION_TIMEOUT_TOLERANCE_MS &&
      timeout.watchdogDelayMs <=
        CANCELLATION_TIMEOUT_MS + CANCELLATION_TIMEOUT_TOLERANCE_MS,
    "forced timeout did not replace the worker and replay only the live request from local cache",
  );

  for (const [name, expectedDevice, expectedThreads] of [
    ["wasmSingleThread", "wasm", 1],
  ]) {
    const fallback = evidence?.fallbacks?.[name];
    pushFailure(
      failures,
      fallback?.available === true &&
        fallback?.device === expectedDevice &&
        fallback?.wasmThreads === expectedThreads &&
        fallback?.wasmRunStarts === 0 &&
        fallback?.cancelMessages === 0 &&
        fallback?.workerTerminations === 0 &&
        fallback?.sameRequestSucceeded === true &&
        fallback?.observationMs >= FALLBACK_OBSERVATION_MS,
      `${name} did not preserve the non-cooperative no-watchdog fallback`,
    );
  }
  const webgpu = evidence?.fallbacks?.webgpu;
  if (webgpu?.probeAvailable === true) {
    pushFailure(
      failures,
      webgpu.available === true &&
        webgpu.device === "webgpu" &&
        webgpu.wasmThreads === null &&
        webgpu.wasmRunStarts === 0 &&
        webgpu.cancelMessages === 0 &&
        webgpu.workerTerminations === 0 &&
        webgpu.sameRequestSucceeded === true &&
        webgpu.observationMs >= FALLBACK_OBSERVATION_MS &&
        webgpu.unsafeFeatureFlags === false &&
        webgpu?.executableCoverage?.path === WEBGPU_COVERAGE_RELATIVE_PATH &&
        webgpu?.executableCoverage?.sha256 === WEBGPU_COVERAGE_SHA256,
      "available unflagged WebGPU did not preserve the non-cooperative fallback",
    );
  } else {
    pushFailure(
      failures,
      webgpu?.probeAvailable === false &&
        webgpu?.available === false &&
        webgpu?.unflaggedAdapterResult === "unavailable" &&
        webgpu?.gracefulFallback?.device === "wasm" &&
        webgpu?.gracefulFallback?.success === true &&
        webgpu?.unsafeFeatureFlags === false &&
        webgpu?.executableCoverage?.path === WEBGPU_COVERAGE_RELATIVE_PATH &&
        webgpu?.executableCoverage?.sha256 === WEBGPU_COVERAGE_SHA256,
      "adapter-unavailable WebGPU evidence lacks an honest probe, graceful WASM selection, or executable path coverage",
    );
  }

  pushFailure(
    failures,
    evidence?.network?.externalModelRequests?.length === 0,
    "the run made an external model, voice, or runtime request",
  );
  pushFailure(
    failures,
    evidence?.network?.nonLoopbackRequests?.length === 0,
    "a page or worker made a non-loopback HTTP(S) request",
  );
  pushFailure(
    failures,
    evidence?.network?.attachFailures?.length === 0 &&
      evidence?.network?.loadingFailures?.length === 0 &&
      evidence?.network?.responseFailures?.length === 0 &&
      evidence?.network?.outstandingRequests === 0 &&
      evidence?.network?.outstandingAttachPromises === 0 &&
      evidence?.network?.offlineSpeechWorkerAttached === true &&
      (evidence?.network?.nestedPthreadWorkersAttached ?? 0) >= 1 &&
      Array.isArray(evidence?.network?.targetBootstrapSettlements) &&
      evidence.network.targetBootstrapSettlements.length >= 1 &&
      evidence.network.targetBootstrapSettlements.every(
        (entry) =>
          entry.method === "GET" &&
          entry.resourceType === "Script" &&
          ["service_worker", "shared_worker", "worker"].includes(
            entry.targetType,
          ) &&
          entry.terminalReason === "target-attached" &&
          typeof entry.url === "string" &&
          entry.url.startsWith(`${evidence?.run?.appOrigin}/`),
      ),
    "page/worker network instrumentation was incomplete or observed a failure",
  );
  pushFailure(
    failures,
    evidence?.cache?.unchanged === true,
    "offline model/voice cache inventory changed during the matrix",
  );
  pushFailure(
    failures,
    evidence?.browserDiagnostics?.errors?.length === 0 &&
      evidence?.browserDiagnostics?.consoleErrors?.length === 0,
    "browser diagnostics contain an error",
  );
  pushFailure(
    failures,
    evidence?.finalIsolation?.narrationStopped === true &&
      evidence?.finalIsolation?.speechWorkersDetached >= 1 &&
      evidence?.finalIsolation?.activeSpeechWorkers === 0 &&
      evidence?.finalIsolation?.networkSettled === true,
    "final fallback narration or worker/network activity was not explicitly quiesced",
  );
  pushFailure(
    failures,
    Number.isInteger(evidence?.cleanup?.browserProcessGroupId) &&
      evidence.cleanup.browserProcessGroupId > 0 &&
      Number.isInteger(evidence?.cleanup?.serverProcessGroupId) &&
      evidence.cleanup.serverProcessGroupId > 0 &&
      Number.isInteger(evidence?.cleanup?.browserTrackedProcessCount) &&
      evidence.cleanup.browserTrackedProcessCount >= 1 &&
      evidence?.cleanup?.browserTrackedProcessIdentityHashes?.length ===
        evidence.cleanup.browserTrackedProcessCount &&
      evidence.cleanup.browserTrackedProcessIdentityHashes.every((hash) =>
        /^[a-f\d]{64}$/u.test(hash),
      ) &&
      Number.isInteger(evidence?.cleanup?.serverTrackedProcessCount) &&
      evidence.cleanup.serverTrackedProcessCount >= 1 &&
      evidence?.cleanup?.serverTrackedProcessIdentityHashes?.length ===
        evidence.cleanup.serverTrackedProcessCount &&
      evidence.cleanup.serverTrackedProcessIdentityHashes.every((hash) =>
        /^[a-f\d]{64}$/u.test(hash),
      ) &&
      evidence?.cleanup?.browserProcessGroupStopped === true &&
      evidence?.cleanup?.survivingBrowserProcesses === 0 &&
      evidence?.cleanup?.browserTrackedSurvivors === 0 &&
      evidence?.cleanup?.browserProfileMatchesAfterStop === 0 &&
      evidence?.cleanup?.serverProcessGroupStopped === true &&
      evidence?.cleanup?.serverTrackedSurvivors === 0 &&
      evidence?.cleanup?.serverCommandMatchesAfterStop === 0 &&
      evidence?.cleanup?.serverPortReleased === true &&
      evidence?.cleanup?.profileCloneRemoved === true &&
      evidence?.cleanup?.failures?.length === 0,
    "owned browser, server, or cloned profile was not fully cleaned up",
  );
  return failures;
}

function firstCancellationIdentity(cancellations) {
  const first = cancellations[0];
  return first
    ? {
        sessionGeneration: first.sessionGeneration,
        workerEpoch: first.workerEpoch,
      }
    : null;
}

export function findEvidencePrivacyViolations(value) {
  const violations = [];
  const forbiddenKeys = new Set([
    "consoleEntries",
    "documentText",
    "message",
    "narrationText",
    "payload",
    "profileDirectory",
    "profilePath",
    "requestText",
    "stack",
    "textLength",
    "values",
  ]);
  const visit = (current, currentPath) => {
    if (typeof current === "string") {
      if (
        /(?:^|[\s"'])(?:\/tmp\/|\/home\/ubuntu\/)/u.test(current) ||
        /I like my friend Tiarn|regretted attrition/iu.test(current)
      ) {
        violations.push(currentPath);
      }
      return;
    }
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach((entry, index) =>
        visit(entry, `${currentPath}[${index}]`),
      );
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      const entryPath = `${currentPath}.${key}`;
      if (forbiddenKeys.has(key)) violations.push(entryPath);
      else visit(entry, entryPath);
    }
  };
  visit(value, "$evidence");
  return [...new Set(violations)];
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local TCP port."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForHttp(url, processHandle, log, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (processHandle?.exitCode !== null) {
      throw new Error(
        `The production server stopped before ${url} was ready.\n${log()}`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The local production listener is still starting.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}.\n${log()}`);
}

async function runProductionBuild(timeoutMs = 10 * 60_000) {
  const output = [];
  const startedAt = performance.now();
  const child = spawn("npm", ["run", "build"], {
    cwd: REPOSITORY_ROOT,
    detached: true,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    output.push(chunk.toString());
    if (output.length > 200) output.shift();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let timeout;
  const result = await new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Production build timed out.\n${output.join("")}`));
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  })
    .catch(async (error) => {
      await stopProcessGroup(child.pid, 5_000);
      throw error;
    })
    .finally(() => clearTimeout(timeout));
  await stopProcessGroup(child.pid, 5_000);
  if (result.exitCode !== 0) {
    throw new Error(
      `Production build exited ${result.exitCode ?? result.signal}.\n${output.join("")}`,
    );
  }
  return {
    command: "npm run build",
    elapsedMs: performance.now() - startedAt,
    exactCleanSource: true,
    exitCode: 0,
    outputSha256: hashDiagnostic(output.join("")),
    performed: true,
  };
}

async function startProductionServer() {
  const port = PREPARED_PROFILE_ORIGIN_PORT;
  await new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.once("error", (error) => {
      reject(
        new Error(
          `Prepared-profile origin port ${port} is not free: ${error.message}`,
        ),
      );
    });
    reservation.listen(port, "127.0.0.1", () => {
      reservation.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const output = [];
  const child = spawn(
    "npm",
    ["run", "start", "--", "--ip", "127.0.0.1", "--port", String(port)],
    {
      cwd: REPOSITORY_ROOT,
      detached: true,
      env: { ...process.env, BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const collect = (chunk) => {
    output.push(chunk.toString());
    if (output.length > 120) output.shift();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const appUrl = `http://127.0.0.1:${port}/`;
  try {
    await waitForHttp(appUrl, child, () => output.join(""));
    return { appUrl, child, log: () => output.join("") };
  } catch (error) {
    await stopProcessGroup(child.pid, 5_000);
    throw error;
  }
}

async function pollJson(url, child, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("The owned browser stopped before CDP became available.");
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response.json();
    } catch {
      // The debugging endpoint is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function assertDisposableProfile(profileDirectory) {
  const normalized = path.resolve(profileDirectory);
  const unsafe = [
    path.resolve(os.homedir(), ".config/BraveSoftware"),
    path.resolve(os.homedir(), ".config/BraveSoftware/Brave-Browser"),
    path.resolve(os.homedir(), ".config/chromium"),
    path.resolve(os.homedir(), ".config/google-chrome"),
  ];
  if (
    unsafe.some(
      (candidate) =>
        normalized === candidate ||
        normalized.startsWith(`${candidate}${path.sep}`),
    )
  ) {
    throw new Error(
      "Refusing to launch against a live/default browser profile.",
    );
  }
  if (!normalized.startsWith(`${os.tmpdir()}${path.sep}`)) {
    throw new Error(
      "The evidence profile must be a disposable directory under /tmp.",
    );
  }
}

async function startOwnedBrowser(executable, profileDirectory) {
  await access(executable);
  assertDisposableProfile(profileDirectory);
  for (const lock of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
    await rm(path.join(profileDirectory, lock), { force: true });
  }
  const debuggingPort = await getFreePort();
  const arguments_ = [
    `--remote-debugging-port=${debuggingPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-features=OptimizationHints,Translate",
    "--disable-sync",
    "--disable-session-crashed-bubble",
    "--metrics-recording-only",
    "--password-store=basic",
    "--use-mock-keychain",
    "--autoplay-policy=no-user-gesture-required",
    "about:blank",
  ];
  const child = spawn(executable, arguments_, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errors = [];
  child.stderr.on("data", (chunk) => {
    errors.push(chunk.toString());
    if (errors.length > 120) errors.shift();
  });
  try {
    const targets = await pollJson(
      `http://127.0.0.1:${debuggingPort}/json/list`,
      child,
    );
    const target = targets.find(
      (candidate) =>
        candidate.type === "page" && candidate.webSocketDebuggerUrl,
    );
    if (!target) {
      throw new Error("The owned browser did not expose a page target.");
    }
    return {
      child,
      debuggingPort,
      log: () => errors.join(""),
      processGroupId: child.pid,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    };
  } catch (error) {
    await stopProcessGroup(child.pid, 5_000);
    throw error;
  }
}

function parseProcStat(contents) {
  const close = contents.lastIndexOf(")");
  if (close < 0) return null;
  const fields = contents
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const startTimeTicks = Number(fields[19]);
  if (
    ![ppid, pgrp, userTicks, systemTicks, startTimeTicks].every(Number.isFinite)
  ) {
    return null;
  }
  return { pgrp, ppid, startTimeTicks, ticks: userTicks + systemTicks };
}

async function readProcessTable() {
  const entries = await readdir("/proc");
  const processes = [];
  await Promise.all(
    entries
      .filter((entry) => /^\d+$/u.test(entry))
      .map(async (entry) => {
        try {
          const pid = Number(entry);
          const processDirectory = path.join("/proc", entry);
          const parsed = parseProcStat(
            await readFile(path.join(processDirectory, "stat"), "utf8"),
          );
          if (!parsed) return;
          let commandLine = "";
          let cwd = null;
          try {
            commandLine = (
              await readFile(path.join(processDirectory, "cmdline"), "utf8")
            )
              .replaceAll("\0", " ")
              .trim();
          } catch {
            // The process may exit while its metadata is read.
          }
          try {
            cwd = await readlink(path.join(processDirectory, "cwd"));
          } catch {
            // Kernel workers and exiting processes may not expose a cwd.
          }
          processes.push({
            commandLine,
            cwd,
            pgrp: parsed.pgrp,
            pid,
            ppid: parsed.ppid,
            startTimeTicks: parsed.startTimeTicks,
          });
        } catch {
          // A process can exit between the /proc directory and stat reads.
        }
      }),
  );
  return processes.sort((left, right) => left.pid - right.pid);
}

export function selectOwnedProcessTree(
  processes,
  { commandNeedle = null, processGroupId, requiredCwd = null, rootPid },
) {
  const selectedPids = new Set();
  for (const process_ of processes) {
    const commandMatches =
      commandNeedle &&
      process_.commandLine.includes(commandNeedle) &&
      (!requiredCwd || process_.cwd === requiredCwd);
    if (
      process_.pid === rootPid ||
      process_.pgrp === processGroupId ||
      commandMatches
    ) {
      selectedPids.add(process_.pid);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const process_ of processes) {
      if (!selectedPids.has(process_.pid) && selectedPids.has(process_.ppid)) {
        selectedPids.add(process_.pid);
        changed = true;
      }
    }
  }
  return processes.filter((process_) => selectedPids.has(process_.pid));
}

function processIdentityKey(process_) {
  return `${process_.pid}:${process_.startTimeTicks}`;
}

function processIdentityHash(process_) {
  return hashDiagnostic(
    JSON.stringify({
      commandLineSha256: hashDiagnostic(process_.commandLine),
      pid: process_.pid,
      startTimeTicks: process_.startTimeTicks,
    }),
  );
}

export function countTrackedProcessSurvivors(processes, trackedProcesses) {
  const currentIdentities = new Set(processes.map(processIdentityKey));
  return trackedProcesses.filter((process_) =>
    currentIdentities.has(processIdentityKey(process_)),
  ).length;
}

function countCommandMatches(processes, { commandNeedle, requiredCwd = null }) {
  return processes.filter(
    (process_) =>
      process_.commandLine.includes(commandNeedle) &&
      (!requiredCwd || process_.cwd === requiredCwd),
  ).length;
}

function isLoopbackPortListening(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function waitForOwnedProcessCleanup({
  browserCommandNeedle,
  browserTrackedProcesses,
  serverCommandNeedle,
  serverRequiredCwd,
  serverTrackedProcesses,
  timeoutMs = 5_000,
}) {
  const startedAt = performance.now();
  let proof = null;
  do {
    const processes = await readProcessTable();
    proof = {
      browserProfileMatchesAfterStop: countCommandMatches(processes, {
        commandNeedle: browserCommandNeedle,
      }),
      browserTrackedSurvivors: countTrackedProcessSurvivors(
        processes,
        browserTrackedProcesses,
      ),
      elapsedMs: performance.now() - startedAt,
      serverCommandMatchesAfterStop: countCommandMatches(processes, {
        commandNeedle: serverCommandNeedle,
        requiredCwd: serverRequiredCwd,
      }),
      serverPortReleased: !(await isLoopbackPortListening(
        PREPARED_PROFILE_ORIGIN_PORT,
      )),
      serverTrackedSurvivors: countTrackedProcessSurvivors(
        processes,
        serverTrackedProcesses,
      ),
    };
    if (
      proof.browserProfileMatchesAfterStop === 0 &&
      proof.browserTrackedSurvivors === 0 &&
      proof.serverCommandMatchesAfterStop === 0 &&
      proof.serverPortReleased &&
      proof.serverTrackedSurvivors === 0
    ) {
      return proof;
    }
    await delay(50);
  } while (performance.now() - startedAt < timeoutMs);
  return proof;
}

async function sampleProcessGroup(processGroupId) {
  const entries = await readdir("/proc");
  const processes = [];
  await Promise.all(
    entries
      .filter((entry) => /^\d+$/u.test(entry))
      .map(async (entry) => {
        try {
          const pid = Number(entry);
          const parsed = parseProcStat(
            await readFile(path.join("/proc", entry, "stat"), "utf8"),
          );
          if (!parsed || parsed.pgrp !== processGroupId) return;
          let role = "browser";
          try {
            const commandLine = await readFile(
              path.join("/proc", entry, "cmdline"),
              "utf8",
            );
            const match = commandLine.match(/--type=([^\0]+)/u);
            if (match) role = match[1];
          } catch {
            // A short-lived process may exit between stat and cmdline.
          }
          processes.push({
            pid,
            role,
            startTimeTicks: parsed.startTimeTicks,
            ticks: parsed.ticks,
          });
        } catch {
          // Chromium child processes can exit while /proc is sampled.
        }
      }),
  );
  processes.sort((left, right) => left.pid - right.pid);
  return {
    monotonicMs: performance.now(),
    wallTimeMs: Date.now(),
    processes,
  };
}

function startCpuSampler(processGroupId) {
  const samples = [];
  let stopping = false;
  let timer = null;
  let currentPoll = Promise.resolve();
  const poll = () => {
    if (stopping) return;
    currentPoll = sampleProcessGroup(processGroupId)
      .then((sample) => {
        samples.push(sample);
      })
      .finally(() => {
        if (!stopping) timer = setTimeout(poll, CPU_SAMPLE_INTERVAL_MS);
      });
  };
  poll();
  return {
    samples,
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      await currentPoll;
      samples.push(await sampleProcessGroup(processGroupId));
    },
  };
}

function cpuIntervals(samples, clockTicksPerSecond) {
  const intervals = [];
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1];
    const after = samples[index];
    const elapsedMs = after.monotonicMs - before.monotonicMs;
    const beforeByProcess = new Map(
      before.processes.map((process_) => [
        `${process_.pid}:${process_.startTimeTicks}`,
        process_,
      ]),
    );
    let deltaTicks = 0;
    for (const process_ of after.processes) {
      const previous = beforeByProcess.get(
        `${process_.pid}:${process_.startTimeTicks}`,
      );
      if (previous) deltaTicks += Math.max(0, process_.ticks - previous.ticks);
    }
    intervals.push({
      cpuPercent:
        elapsedMs > 0
          ? (deltaTicks / clockTicksPerSecond / (elapsedMs / 1_000)) * 100
          : null,
      elapsedMs,
      endMonotonicMs: after.monotonicMs,
      processCount: after.processes.length,
      startMonotonicMs: before.monotonicMs,
    });
  }
  return intervals;
}

function cpuWindow(
  samples,
  actionNodeMonotonicMs,
  clockTicksPerSecond,
  idleThresholdPercent,
) {
  const selected = samples.filter(
    (sample) =>
      sample.monotonicMs >= actionNodeMonotonicMs - 200 &&
      sample.monotonicMs <= actionNodeMonotonicMs + MAX_CPU_QUIESCENCE_MS + 150,
  );
  const intervals = cpuIntervals(selected, clockTicksPerSecond).map(
    (entry) => ({
      ...entry,
      endAfterActionMs: entry.endMonotonicMs - actionNodeMonotonicMs,
    }),
  );
  let idle = null;
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (
      previous.endAfterActionMs >= 0 &&
      previous.cpuPercent <= idleThresholdPercent &&
      current.cpuPercent <= idleThresholdPercent
    ) {
      idle = current;
      break;
    }
  }
  const activeIntervals = intervals.filter(
    (entry) => entry.endAfterActionMs <= 0,
  );
  return {
    activeIntervals,
    cpuPercentAtIdle: idle?.cpuPercent ?? null,
    idleByMs: idle?.endAfterActionMs ?? null,
    intervals,
    peakActiveCpuPercent: activeIntervals.length
      ? Math.max(...activeIntervals.map((entry) => entry.cpuPercent))
      : null,
    samples: selected,
  };
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return sorted[index];
}

function measureIdleCpuBaseline(
  samples,
  actionNodeMonotonicMs,
  clockTicksPerSecond,
) {
  const selected = samples.filter(
    (sample) =>
      sample.monotonicMs >= actionNodeMonotonicMs + 200 &&
      sample.monotonicMs <= actionNodeMonotonicMs + 650,
  );
  const intervals = cpuIntervals(selected, clockTicksPerSecond);
  const p95CpuPercent = percentile(
    intervals.map((entry) => entry.cpuPercent),
    0.95,
  );
  if (!finiteNumber(p95CpuPercent)) {
    throw new Error("Could not measure an owned-browser idle CPU baseline.");
  }
  return {
    derivedIdleThresholdPercent: Math.min(
      MAX_QUIESCENT_CPU_PERCENT,
      Math.max(10, Math.ceil(p95CpuPercent + 10)),
    ),
    intervals,
    p95CpuPercent,
    samples: selected,
  };
}

async function sha256File(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function hashSourceFiles(fixture) {
  const files = [
    ...SOURCE_EVIDENCE_FILES,
    path.relative(REPOSITORY_ROOT, fixture),
  ];
  const hashes = {};
  for (const relativeFile of files) {
    hashes[relativeFile] = await sha256File(
      path.join(REPOSITORY_ROOT, relativeFile),
    );
  }
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    }).trim(),
    dirty: Boolean(
      execFileSync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        { cwd: REPOSITORY_ROOT, encoding: "utf8" },
      ).trim(),
    ),
    files: hashes,
  };
}

function installBrowserInstrumentation() {
  globalThis.localStorage.setItem(
    "guided-reader-settings",
    JSON.stringify({
      follow: false,
      highlightScope: "sentence",
      narrationEngine: "offline",
      narrationPreferenceVersion: 1,
      offlineVoice: "af_heart",
      rate: 1,
    }),
  );
  const mode =
    globalThis.localStorage.getItem("__linelightIssue55Backend") ?? "threaded";
  const startedAt = globalThis.performance.now();
  const state = {
    actions: [],
    audio: [],
    backendMode: mode,
    errors: [],
    forcedTimeout: null,
    nextAudioId: 1,
    nextBlobId: 1,
    nextEventSequence: 1,
    nextWorkerEpoch: 1,
    workerEvents: [],
    workers: [],
  };
  const audioByElement = new WeakMap();
  const audioElements = new Map();
  const blobByUrl = new Map();
  const native = {
    Audio: globalThis.Audio,
    Worker: globalThis.Worker,
    createObjectURL: globalThis.URL.createObjectURL,
    mediaPause: globalThis.HTMLMediaElement.prototype.pause,
    mediaPlay: globalThis.HTMLMediaElement.prototype.play,
    mediaSrc: Object.getOwnPropertyDescriptor(
      globalThis.HTMLMediaElement.prototype,
      "src",
    ),
  };

  const now = () => ({
    atMs: globalThis.performance.now(),
    wallTimeMs:
      globalThis.performance.timeOrigin + globalThis.performance.now(),
  });
  const event = (entry) => {
    state.workerEvents.push({
      sequence: state.nextEventSequence,
      ...now(),
      ...entry,
    });
    state.nextEventSequence += 1;
  };
  const backendOverride = () => {
    if (state.backendMode === "auto") return null;
    if (state.backendMode === "w1") return { device: "wasm", wasmThreads: 1 };
    if (state.backendMode === "webgpu") return { device: "webgpu" };
    return { device: "wasm", wasmThreads: 4 };
  };
  const sanitizeWorkerMessage = (message, direction, epoch) => {
    const result = message?.result;
    const backend =
      message?.backend ??
      (result && typeof result === "object" ? result : null);
    return {
      backendDevice: backend?.device ?? null,
      cooperative: message?.cooperative ?? null,
      direction,
      elapsedMilliseconds: message?.elapsedMilliseconds ?? null,
      epoch,
      generation: message?.generation ?? null,
      id: message?.id ?? null,
      progress: message?.progress ?? null,
      sessionGeneration: message?.sessionGeneration ?? null,
      stage: message?.stage ?? null,
      type: message?.type ?? "unknown",
      wasmThreads: backend?.wasmThreads ?? null,
    };
  };

  const ensureAudio = (element) => {
    let record = audioByElement.get(element);
    if (record) return record;
    record = {
      createdAtMs: globalThis.performance.now(),
      events: [],
      id: state.nextAudioId,
      sourceBlobId: null,
    };
    state.nextAudioId += 1;
    state.audio.push(record);
    audioByElement.set(element, record);
    audioElements.set(record.id, element);
    for (const name of [
      "canplay",
      "ended",
      "error",
      "pause",
      "play",
      "playing",
      "stalled",
      "waiting",
    ]) {
      element.addEventListener(name, () => {
        record.events.push({
          ...now(),
          currentTime: element.currentTime,
          duration: Number.isFinite(element.duration) ? element.duration : null,
          loop: element.loop,
          name,
          paused: element.paused,
        });
      });
    }
    return record;
  };

  const WrappedAudio = function (...arguments_) {
    const audio = new native.Audio(...arguments_);
    ensureAudio(audio);
    return audio;
  };
  Object.setPrototypeOf(WrappedAudio, native.Audio);
  WrappedAudio.prototype = native.Audio.prototype;
  globalThis.Audio = WrappedAudio;

  globalThis.URL.createObjectURL = function (object) {
    const url = native.createObjectURL.call(this, object);
    blobByUrl.set(url, {
      createdAtMs: globalThis.performance.now(),
      id: state.nextBlobId,
      size: object?.size ?? null,
      type: object?.type ?? null,
    });
    state.nextBlobId += 1;
    return url;
  };

  if (native.mediaSrc?.get && native.mediaSrc?.set) {
    Object.defineProperty(globalThis.HTMLMediaElement.prototype, "src", {
      ...native.mediaSrc,
      set(value) {
        const record = ensureAudio(this);
        record.sourceBlobId = blobByUrl.get(value)?.id ?? null;
        return native.mediaSrc.set.call(this, value);
      },
    });
  }

  globalThis.HTMLMediaElement.prototype.play = function (...arguments_) {
    const record = ensureAudio(this);
    record.playCalls = (record.playCalls ?? 0) + 1;
    record.lastPlayCalledAtMs = globalThis.performance.now();
    return native.mediaPlay.apply(this, arguments_);
  };
  globalThis.HTMLMediaElement.prototype.pause = function (...arguments_) {
    const record = ensureAudio(this);
    record.pauseCalls = (record.pauseCalls ?? 0) + 1;
    record.lastPauseCalledAtMs = globalThis.performance.now();
    return native.mediaPause.apply(this, arguments_);
  };

  class InstrumentedWorker extends native.Worker {
    constructor(url, options) {
      super(url, options);
      this.__issue55Offline = options?.name === "linelight-offline-voice";
      this.__issue55Epoch = this.__issue55Offline ? state.nextWorkerEpoch : 0;
      this.__issue55ListenerMap = new Map();
      if (this.__issue55Offline) {
        state.nextWorkerEpoch += 1;
        state.workers.push({
          ...now(),
          epoch: this.__issue55Epoch,
          event: "created",
          terminatedAtMs: null,
        });
        super.addEventListener("message", (messageEvent) => {
          const message = messageEvent.data;
          event(sanitizeWorkerMessage(message, "in", this.__issue55Epoch));
        });
      }
    }

    postMessage(message, transfer) {
      if (!this.__issue55Offline) return super.postMessage(message, transfer);
      const outgoing =
        message &&
        ["initialize", "install", "synthesize"].includes(message.type)
          ? {
              ...message,
              ...(state.backendMode === "webgpu" &&
              state.forcedTimeout?.allowAppFallback
                ? {}
                : (backendOverride() ?? {})),
            }
          : message;
      event(sanitizeWorkerMessage(outgoing, "out", this.__issue55Epoch));
      if (
        outgoing?.type === "cancel" &&
        state.forcedTimeout?.selectedId === outgoing.id &&
        state.forcedTimeout?.blockedEpoch === this.__issue55Epoch
      ) {
        state.forcedTimeout.cancelSwallowedAtMs = globalThis.performance.now();
        event({
          direction: "control",
          epoch: this.__issue55Epoch,
          id: outgoing.id,
          type: "forced-cancel-swallowed",
        });
        return undefined;
      }
      if (
        outgoing?.type === "synthesize" &&
        state.forcedTimeout?.blockedEpoch === this.__issue55Epoch &&
        outgoing.id !== state.forcedTimeout.selectedId
      ) {
        state.forcedTimeout.pendingReplayId = outgoing.id;
      }
      return transfer === undefined
        ? super.postMessage(outgoing)
        : super.postMessage(outgoing, transfer);
    }

    addEventListener(type, listener, options) {
      if (!this.__issue55Offline || type !== "message") {
        return super.addEventListener(type, listener, options);
      }
      const wrapped = (messageEvent) => {
        const message = messageEvent.data;
        const timeout = state.forcedTimeout;
        if (
          timeout?.armed &&
          !timeout.selectedId &&
          message?.type === "wasm-run-start"
        ) {
          timeout.selectedId = message.id;
          timeout.blockedEpoch = this.__issue55Epoch;
          timeout.actualGeneration = message.generation;
          timeout.sessionGeneration = message.sessionGeneration;
          timeout.realStartAtMs = globalThis.performance.now();
          const fakeBuffer = new globalThis.SharedArrayBuffer(12);
          const fakeMailbox = new Uint32Array(fakeBuffer);
          globalThis.Atomics.store(fakeMailbox, 0, message.generation);
          const replacement = {
            ...message,
            sharedBuffer: fakeBuffer,
            activeGenerationIndex: 0,
            cancellationGenerationIndex: 1,
          };
          event({
            direction: "control",
            epoch: this.__issue55Epoch,
            generation: message.generation,
            id: message.id,
            sessionGeneration: message.sessionGeneration,
            type: "forced-fake-run-start",
          });
          listener.call(
            this,
            new globalThis.MessageEvent("message", { data: replacement }),
          );
          return;
        }
        if (
          timeout?.blockedEpoch === this.__issue55Epoch &&
          !message?.__issue55Stale &&
          (message?.type === "wasm-run-start" ||
            message?.type === "wasm-run-end" ||
            message?.type === "success" ||
            message?.type === "error" ||
            message?.type === "canceled")
        ) {
          timeout.suppressedMessages.push({
            ...now(),
            id: message.id ?? null,
            type: message.type,
          });
          return;
        }
        if (
          state.backendMode === "webgpu" &&
          message?.type === "error" &&
          message?.code === "backend_failed" &&
          message?.backend?.device === "webgpu"
        ) {
          if (!state.forcedTimeout) {
            state.forcedTimeout = {
              allowAppFallback: true,
              armed: false,
              suppressedMessages: [],
            };
          } else {
            state.forcedTimeout.allowAppFallback = true;
          }
        }
        listener.call(this, messageEvent);
      };
      this.__issue55ListenerMap.set(listener, wrapped);
      return super.addEventListener(type, wrapped, options);
    }

    removeEventListener(type, listener, options) {
      const wrapped = this.__issue55ListenerMap?.get(listener) ?? listener;
      return super.removeEventListener(type, wrapped, options);
    }

    terminate() {
      if (this.__issue55Offline) {
        const record = state.workers.find(
          (candidate) => candidate.epoch === this.__issue55Epoch,
        );
        if (record) record.terminatedAtMs = globalThis.performance.now();
        event({
          direction: "control",
          epoch: this.__issue55Epoch,
          id: null,
          type: "worker-terminated",
        });
        if (
          state.forcedTimeout?.blockedEpoch === this.__issue55Epoch &&
          state.forcedTimeout?.pendingReplayId
        ) {
          const staleId = state.forcedTimeout.pendingReplayId;
          globalThis.setTimeout(() => {
            state.forcedTimeout.staleInjectedAtMs =
              globalThis.performance.now();
            this.dispatchEvent(
              new globalThis.MessageEvent("message", {
                data: {
                  __issue55Stale: true,
                  id: staleId,
                  message: "Issue #55 stale worker sentinel",
                  type: "error",
                },
              }),
            );
          }, 0);
        }
      }
      return super.terminate();
    }
  }
  globalThis.Worker = InstrumentedWorker;

  globalThis.addEventListener("error", (errorEvent) => {
    state.errors.push(
      errorEvent.error?.stack ?? errorEvent.message ?? "window error",
    );
  });
  globalThis.addEventListener("unhandledrejection", (rejectionEvent) => {
    state.errors.push(
      rejectionEvent.reason?.stack ?? String(rejectionEvent.reason),
    );
  });

  globalThis.__lineLightIssue55 = {
    action(kind, details = {}) {
      const record = { ...now(), details, kind };
      state.actions.push(record);
      return record;
    },
    armForcedTimeout() {
      state.forcedTimeout = {
        allowAppFallback: false,
        armed: true,
        blockedEpoch: null,
        selectedId: null,
        suppressedMessages: [],
      };
      return true;
    },
    finishCurrentNarrationAudio() {
      const candidates = state.audio
        .filter(
          (record) =>
            record.events.some(
              (entry) => entry.name === "playing" && !entry.loop,
            ) && !record.events.some((entry) => entry.name === "ended"),
        )
        .sort((left, right) => right.id - left.id);
      const record = candidates[0];
      const audio = record ? audioElements.get(record.id) : null;
      if (!audio || !Number.isFinite(audio.duration)) return false;
      audio.currentTime = Math.max(0, audio.duration - 0.03);
      return true;
    },
    markActionAndClick(kind, selector) {
      const action = this.action(kind);
      const element = globalThis.document.querySelector(selector);
      if (!element) throw new Error(`Missing control: ${selector}`);
      element.click();
      return action;
    },
    snapshot() {
      return globalThis.structuredClone({
        actions: state.actions,
        audio: state.audio,
        backendMode: state.backendMode,
        errors: state.errors,
        forcedTimeout: state.forcedTimeout,
        startedAt,
        workerEvents: state.workerEvents,
        workers: state.workers,
      });
    },
  };
}

const INSTRUMENTATION_SOURCE = `(${installBrowserInstrumentation.toString()})();`;

async function walkFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(resolved)));
    else if (entry.isFile()) files.push(resolved);
  }
  return files;
}

async function inspectProductionArtifacts() {
  const clientDirectory = path.join(REPOSITORY_ROOT, "dist/client");
  const files = await walkFiles(clientDirectory);
  const jsepCandidates = files.filter((file) =>
    /ort-wasm-simd-threaded\.jsep-[^/]+\.wasm$/u.test(file),
  );
  if (jsepCandidates.length !== 1) {
    throw new Error(
      `Expected one emitted threaded JSEP Wasm asset; found ${jsepCandidates.length}.`,
    );
  }
  const jsepWasmSha256 = await sha256File(jsepCandidates[0]);
  if (jsepWasmSha256 !== EXPECTED_JSEP_WASM_SHA256) {
    throw new Error(
      `Emitted JSEP Wasm hash ${jsepWasmSha256} is not the reviewed custom runtime.`,
    );
  }
  const workerCandidates = files.filter((file) =>
    /offline-speech\.worker[^/]*\.js$/u.test(file),
  );
  const identities = [
    "ERR_ORT_WASM_RUN_CANCELED",
    "wasm-run-start",
    "sessionGeneration",
  ];
  let worker = null;
  for (const candidate of workerCandidates) {
    const source = await readFile(candidate, "utf8");
    if (identities.every((identity) => source.includes(identity))) {
      worker = { candidate, source };
      break;
    }
  }
  if (!worker) {
    throw new Error(
      "The emitted offline worker does not contain the reviewed cancellation identity.",
    );
  }
  return {
    jsepWasmBytes: (await stat(jsepCandidates[0])).size,
    jsepWasmPath: path.relative(REPOSITORY_ROOT, jsepCandidates[0]),
    jsepWasmSha256,
    workerCancellationIdentity: true,
    workerPath: path.relative(REPOSITORY_ROOT, worker.candidate),
    workerSha256: createHash("sha256").update(worker.source).digest("hex"),
  };
}

function safeNetworkUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return `${parsed.protocol}//non-http-resource`;
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "invalid-url";
  }
}

export function validateCleanTargetBaseline(targetInfos) {
  const pages = targetInfos.filter((target) => target.type === "page");
  const workers = targetInfos.filter((target) =>
    ["service_worker", "shared_worker", "worker"].includes(target.type),
  );
  const speechWorkers = workers.filter((target) =>
    /offline-speech\.worker/iu.test(target.url ?? ""),
  );
  const failures = [];
  if (pages.length !== 1 || pages[0]?.url !== "about:blank") {
    failures.push("expected exactly one about:blank page target");
  }
  if (workers.length !== 0) {
    failures.push("expected no preexisting worker targets");
  }
  if (failures.length)
    throw new Error(`Dirty browser target baseline: ${failures.join("; ")}.`);
  return {
    baselinePageCount: pages.length,
    baselinePageUrl: safeNetworkUrl(pages[0].url),
    preexistingSpeechWorkers: speechWorkers.length,
    preexistingWorkers: workers.length,
  };
}

async function assertCleanTargetBaseline(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets", {
    filter: [
      { type: "page" },
      { type: "worker" },
      { type: "shared_worker" },
      { type: "service_worker" },
    ],
  });
  return validateCleanTargetBaseline(targetInfos);
}

export async function attachCdpChildTarget(cdp, entry, attachFailures) {
  const { sessionId, targetInfo, waitingForDebugger } = entry;
  let attached = true;
  let resumed = !waitingForDebugger;
  try {
    await Promise.all([
      cdp.send("Network.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
    ]);
    await cdp.send(
      "Target.setAutoAttach",
      {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: true,
      },
      sessionId,
    );
  } catch (error) {
    attached = false;
    attachFailures.push({
      code: "target-attach-failed",
      sha256: hashDiagnostic(error),
      targetType: targetInfo.type,
    });
  } finally {
    if (waitingForDebugger) {
      await cdp
        .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
        .then(() => {
          resumed = true;
        })
        .catch((error) => {
          attachFailures.push({
            code: "target-resume-failed",
            sha256: hashDiagnostic(error),
            targetType: targetInfo.type,
          });
        });
    }
  }
  return { attached, resumed };
}

export function summarizeAttachedTargetCoverage(targets, expectedWorkerUrl) {
  const targetsBySession = new Map(
    targets.map((target) => [target.sessionId, target]),
  );
  const offlineWorkers = targets.filter(
    (target) =>
      target.type === "worker" &&
      target.url === expectedWorkerUrl &&
      target.attachComplete,
  );
  const offlineSessions = new Set(
    offlineWorkers.map((target) => target.sessionId),
  );
  const descendsFromOfflineWorker = (target) => {
    const visited = new Set();
    let parentSessionId = target.parentSessionId;
    while (parentSessionId && !visited.has(parentSessionId)) {
      if (offlineSessions.has(parentSessionId)) return true;
      visited.add(parentSessionId);
      parentSessionId = targetsBySession.get(parentSessionId)?.parentSessionId;
    }
    return false;
  };
  const pthreadWorkers = targets.filter(
    (target) =>
      target.type === "worker" &&
      target.attachComplete &&
      !offlineSessions.has(target.sessionId) &&
      descendsFromOfflineWorker(target),
  );
  const activeOfflineWorkers = offlineWorkers.filter(
    (target) => !target.detached,
  );
  return {
    activeOfflineSpeechWorkers: activeOfflineWorkers.length,
    nestedPthreadWorkersAttached: pthreadWorkers.length,
    offlineSpeechWorkerAttached: offlineWorkers.length >= 1,
    offlineSpeechWorkersAttached: offlineWorkers.length,
    speechWorkersDetached: offlineWorkers.filter((target) => target.detached)
      .length,
  };
}

export function isAttachedTargetBootstrapRequest(request, target) {
  return (
    target.attachComplete === true &&
    ["service_worker", "shared_worker", "worker"].includes(target.type) &&
    request.method === "GET" &&
    request.resourceType === "Script" &&
    request.sessionId === target.parentSessionId &&
    request.url === target.url
  );
}

async function configurePage(cdp, appUrl, expectedWorkerPath) {
  const consoleEntries = [];
  const networkRequests = [];
  const networkFailures = [];
  const responseFailures = [];
  const requestsByKey = new Map();
  const targets = [];
  const targetsBySession = new Map();
  const attachFailures = [];
  const attachPromises = new Set();
  const outstandingRequests = new Set();
  const targetBootstrapSettlements = [];
  let lastActivityAtMs = performance.now();
  const markActivity = () => {
    lastActivityAtMs = performance.now();
  };
  const reconcileTargetBootstrapRequests = () => {
    for (const target of targets) {
      if (target.bootstrapRequestKey) continue;
      for (const requestKey of outstandingRequests) {
        const request = requestsByKey.get(requestKey);
        if (!request || !isAttachedTargetBootstrapRequest(request, target)) {
          continue;
        }
        target.bootstrapRequestKey = requestKey;
        outstandingRequests.delete(requestKey);
        targetBootstrapSettlements.push({
          method: request.method,
          resourceType: request.resourceType,
          targetType: target.type,
          terminalReason: "target-attached",
          url: request.url,
        });
        break;
      }
    }
  };
  cdp.on("Runtime.consoleAPICalled", (entry, sessionId) => {
    consoleEntries.push({
      sessionId,
      type: entry.type,
    });
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    consoleEntries.push({ sessionId: null, type: entry.level });
  });
  cdp.on("Network.requestWillBeSent", (entry, sessionId) => {
    markActivity();
    const request = {
      documentUrl: safeNetworkUrl(entry.documentURL ?? ""),
      method: entry.request.method,
      requestId: entry.requestId,
      resourceType: entry.type,
      sessionId,
      timestampSeconds: entry.timestamp,
      url: safeNetworkUrl(entry.request.url),
      wallTimeMs: finiteNumber(entry.wallTime)
        ? entry.wallTime * 1_000
        : Date.now(),
    };
    networkRequests.push(request);
    const requestKey = `${sessionId ?? "page"}:${entry.requestId}`;
    requestsByKey.set(requestKey, request);
    outstandingRequests.add(requestKey);
    reconcileTargetBootstrapRequests();
  });
  cdp.on("Network.loadingFinished", (entry, sessionId) => {
    markActivity();
    outstandingRequests.delete(`${sessionId ?? "page"}:${entry.requestId}`);
  });
  cdp.on("Network.loadingFailed", (entry, sessionId) => {
    markActivity();
    const request = requestsByKey.get(
      `${sessionId ?? "page"}:${entry.requestId}`,
    );
    networkFailures.push({
      canceled: entry.canceled ?? false,
      code: entry.blockedReason ?? "loading-failed",
      requestId: entry.requestId,
      sessionId,
      url: request?.url ?? null,
    });
    outstandingRequests.delete(`${sessionId ?? "page"}:${entry.requestId}`);
  });
  cdp.on("Network.responseReceived", (entry, sessionId) => {
    if (entry.response.status < 400) return;
    responseFailures.push({
      requestId: entry.requestId,
      sessionId,
      status: entry.response.status,
      url: safeNetworkUrl(entry.response.url),
    });
  });
  cdp.on("Target.attachedToTarget", (entry, parentSessionId) => {
    markActivity();
    const { sessionId, targetInfo, waitingForDebugger } = entry;
    const target = {
      attachComplete: false,
      bootstrapRequestKey: null,
      detached: false,
      parentSessionId,
      sessionId,
      targetId: targetInfo.targetId,
      type: targetInfo.type,
      url: safeNetworkUrl(targetInfo.url),
    };
    targets.push(target);
    targetsBySession.set(sessionId, target);
    const attachPromise = attachCdpChildTarget(
      cdp,
      { sessionId, targetInfo, waitingForDebugger },
      attachFailures,
    )
      .then((result) => {
        target.attachComplete = result.attached && result.resumed;
        reconcileTargetBootstrapRequests();
      })
      .finally(() => {
        attachPromises.delete(attachPromise);
        markActivity();
      });
    attachPromises.add(attachPromise);
  });
  cdp.on("Target.detachedFromTarget", (entry) => {
    markActivity();
    const target = targetsBySession.get(entry.sessionId);
    if (target) target.detached = true;
  });
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("DOM.enable"),
    cdp.send("Log.enable"),
    cdp.send("Network.enable"),
    cdp.send("Performance.enable"),
    cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true,
    }),
  ]);
  await cdp.send("Network.setBypassServiceWorker", { bypass: true });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: INSTRUMENTATION_SOURCE,
  });
  await cdp.send("Page.navigate", { url: appUrl });
  await waitForExpression(
    cdp,
    `Boolean(globalThis.__lineLightIssue55) &&
      Boolean(document.querySelector(".import-button"))`,
    "the instrumented LineLight production shell",
    60_000,
  );
  await evaluate(
    cdp,
    `(async () => {
      const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
      const results = await Promise.all(registrations.map((entry) => entry.unregister()));
      return { registrations: registrations.length, unregistered: results.filter(Boolean).length };
    })()`,
  );
  const settle = async ({ quietMs = 250, timeoutMs = 30_000 } = {}) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (attachPromises.size) {
        await Promise.allSettled([...attachPromises]);
        continue;
      }
      if (
        outstandingRequests.size === 0 &&
        performance.now() - lastActivityAtMs >= quietMs
      ) {
        return true;
      }
      await delay(25);
    }
    throw new Error(
      `CDP observation did not settle (${attachPromises.size} attaches, ${outstandingRequests.size} requests).`,
    );
  };
  const targetCoverage = () =>
    summarizeAttachedTargetCoverage(targets, expectedWorkerPath);
  return {
    attachFailures,
    attachPromises,
    consoleEntries,
    networkFailures,
    networkRequests,
    outstandingRequests,
    responseFailures,
    serviceWorkerBypassed: true,
    settle,
    targetBootstrapSettlements,
    targetCoverage,
    targets,
  };
}

async function verifyOfflinePack(cdp) {
  const status = await waitForExpression(
    cdp,
    `(() => {
      if (!document.querySelector(".settings-layer")) {
        document.querySelector(".sidebar-settings")?.click();
        return "";
      }
      if (document.querySelector(".offline-pack-ready")) return "ready";
      const text = document.querySelector(".offline-pack-status")?.textContent ?? "";
      if (/Preparing automatically while connected/iu.test(text)) return "missing";
      if (/could not|failed|error/iu.test(text)) return "error";
      return "";
    })()`,
    "the prepared Offline-natural pack",
    60_000,
  );
  if (status !== "ready") {
    throw new Error(
      "The disposable browser profile does not contain the ready offline pack.",
    );
  }
  const label = await evaluate(
    cdp,
    `document.querySelector(".offline-pack-ready")?.innerText ?? ""`,
  );
  await evaluate(
    cdp,
    `document.querySelector(".settings-layer .modal-close")?.click(); true`,
  );
  return label;
}

async function setBackendModeAndReload(cdp, appUrl, mode) {
  await evaluate(
    cdp,
    `localStorage.setItem("__linelightIssue55Backend", ${JSON.stringify(mode)}); true`,
  );
  await cdp.send("Page.navigate", { url: appUrl });
  await waitForExpression(
    cdp,
    `globalThis.__lineLightIssue55?.snapshot().backendMode === ${JSON.stringify(mode)} &&
      Boolean(document.querySelector(".import-button"))`,
    `the ${mode} instrumented reader shell`,
    60_000,
  );
}

async function prepareScenario(cdp, appUrl, fixture, mode) {
  await setBackendModeAndReload(cdp, appUrl, mode);
  const packLabel = await verifyOfflinePack(cdp);
  await importFixture(cdp, fixture);
  await evaluate(
    cdp,
    `(async () => {
      const page = document.querySelector("#pdf-page-1");
      page?.scrollIntoView({ block: "center", behavior: "auto" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const word = Array.from(page?.querySelectorAll(".pdf-word-overlay") ?? [])
        .find((element) => element.getAttribute("aria-label") === "like");
      if (!word) throw new Error("The deterministic fixture word 'like' was not rendered.");
      word.click();
      return true;
    })()`,
  );
  return packLabel;
}

async function browserSnapshot(cdp) {
  return evaluate(cdp, `globalThis.__lineLightIssue55.snapshot()`);
}

export function evaluateBrowserStatePredicate(state, predicate, description) {
  if (state.errors?.length) {
    throw new Error(
      `${description} encountered a browser error: ${state.errors.join("\n")}`,
    );
  }
  return predicate(state);
}

async function assertBrowserStateHealthy(cdp, description) {
  const state = await browserSnapshot(cdp);
  evaluateBrowserStatePredicate(state, () => true, description);
  return state;
}

async function waitForBrowserState(
  cdp,
  predicate,
  description,
  timeoutMs = 60_000,
  intervalMs = 50,
) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await browserSnapshot(cdp);
    const result = evaluateBrowserStatePredicate(
      latest,
      predicate,
      description,
    );
    if (result) return { result, state: latest };
    await delay(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${description}. Last state: ${JSON.stringify(latest)?.slice(0, 2_000)}`,
  );
}

async function clickRecordedAction(cdp, kind, selector = ".play-button") {
  const nodeSentAtMs = performance.now();
  const action = await evaluate(
    cdp,
    `globalThis.__lineLightIssue55.markActionAndClick(
      ${JSON.stringify(kind)},
      ${JSON.stringify(selector)}
    )`,
  );
  const nodeReceivedAtMs = performance.now();
  return {
    ...action,
    nodeDispatchedAtMs: nodeSentAtMs,
    nodeEstimatedMonotonicMs: (nodeSentAtMs + nodeReceivedAtMs) / 2,
    nodeRoundTripMs: nodeReceivedAtMs - nodeSentAtMs,
  };
}

function latestNarrationAudioPlaying(state, afterMs = -Infinity) {
  for (const audio of [...state.audio].reverse()) {
    const playing = [...audio.events]
      .reverse()
      .find(
        (entry) =>
          entry.name === "playing" && !entry.loop && entry.atMs >= afterMs,
      );
    if (playing) return { audio, event: playing };
  }
  return null;
}

function workerEventsAfter(state, afterSequence = 0) {
  return state.workerEvents.filter((entry) => entry.sequence > afterSequence);
}

function nextEventSequence(state) {
  return state.workerEvents.at(-1)?.sequence ?? 0;
}

async function startNarration(cdp, timeoutMs) {
  const marker = await browserSnapshot(cdp);
  const action = await clickRecordedAction(cdp, "play-narration");
  const playing = await waitForBrowserState(
    cdp,
    (state) => latestNarrationAudioPlaying(state, action.atMs),
    "real Offline-natural audio to reach playing",
    timeoutMs,
  );
  const events = workerEventsAfter(playing.state, nextEventSequence(marker));
  const currentRequest = events.find(
    (entry) => entry.direction === "out" && entry.type === "synthesize",
  );
  if (!currentRequest) {
    throw new Error(
      "Narration reached playing without a recorded synthesis request.",
    );
  }
  const success = events.find(
    (entry) =>
      entry.direction === "in" &&
      entry.type === "success" &&
      entry.id === currentRequest.id,
  );
  if (!success) {
    throw new Error(
      "The current Offline-natural request did not record success.",
    );
  }
  return {
    action,
    audio: playing.result,
    request: currentRequest,
    success,
  };
}

async function cacheInventory(cdp) {
  return evaluate(
    cdp,
    `(async () => {
      const relevant = /(?:offline-model|Kokoro-82M|voices\\/|ort-wasm)/iu;
      const entries = [];
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        for (const request of await cache.keys()) {
          if (!relevant.test(request.url)) continue;
          const response = await cache.match(request);
          if (!response) continue;
          const bytes = await response.clone().arrayBuffer();
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          entries.push({
            byteLength: bytes.byteLength,
            cacheName,
            sha256: Array.from(new Uint8Array(digest), (value) =>
              value.toString(16).padStart(2, "0")
            ).join(""),
            url: new URL(request.url).pathname
          });
        }
      }
      entries.sort((left, right) =>
        (left.cacheName + left.url).localeCompare(right.cacheName + right.url)
      );
      const encoded = new TextEncoder().encode(JSON.stringify(entries));
      const inventoryDigest = await crypto.subtle.digest("SHA-256", encoded);
      return {
        entries,
        sha256: Array.from(new Uint8Array(inventoryDigest), (value) =>
          value.toString(16).padStart(2, "0")
        ).join("")
      };
    })()`,
  );
}

async function stableCacheInventory(cdp, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let previous = await cacheInventory(cdp);
  while (Date.now() - startedAt < timeoutMs) {
    await delay(250);
    const current = await cacheInventory(cdp);
    if (current.sha256 === previous.sha256) return current;
    previous = current;
  }
  throw new Error(
    "Offline model/voice/runtime cache did not reach a stable baseline.",
  );
}

async function probeWebGpu(cdp) {
  return evaluate(
    cdp,
    `(async () => {
      if (!navigator.gpu?.requestAdapter) {
        return { apiPresent: false, adapterAvailable: false, shaderF16: false, errorCode: null };
      }
      try {
        const adapter = await Promise.race([
          navigator.gpu.requestAdapter({ powerPreference: "high-performance" }),
          new Promise((resolve) => setTimeout(() => resolve(null), 1_000))
        ]);
        return {
          apiPresent: true,
          adapterAvailable: Boolean(adapter),
          shaderF16: Boolean(adapter?.features?.has("shader-f16")),
          errorCode: null
        };
      } catch (error) {
        return {
          apiPresent: true,
          adapterAvailable: false,
          shaderF16: false,
          errorCode: "request-adapter-threw"
        };
      }
    })()`,
  );
}

async function quiesceFinalNarration(cdp, appUrl, observation) {
  const before = observation.targetCoverage();
  await cdp.send("Page.navigate", {
    url: new URL("/offline-voice-license.txt", appUrl).href,
  });
  await waitForExpression(
    cdp,
    `document.readyState === "complete" &&
      location.pathname === "/offline-voice-license.txt"`,
    "the same-origin narration teardown page",
    30_000,
  );
  const startedAt = Date.now();
  let after = observation.targetCoverage();
  while (
    Date.now() - startedAt < 30_000 &&
    (after.activeOfflineSpeechWorkers !== 0 ||
      after.speechWorkersDetached <= before.speechWorkersDetached)
  ) {
    await delay(25);
    after = observation.targetCoverage();
  }
  await observation.settle({ quietMs: 400, timeoutMs: 30_000 });
  after = observation.targetCoverage();
  return {
    activeSpeechWorkers: after.activeOfflineSpeechWorkers,
    narrationStopped: after.activeOfflineSpeechWorkers === 0,
    networkSettled:
      observation.outstandingRequests.size === 0 &&
      observation.attachPromises.size === 0,
    speechWorkersDetached:
      after.speechWorkersDetached - before.speechWorkersDetached,
    teardownPath: "/offline-voice-license.txt",
  };
}

function countModelRequests(networkRequests, startWallTimeMs, endWallTimeMs) {
  return networkRequests.filter(
    (request) =>
      request.wallTimeMs >= startWallTimeMs &&
      request.wallTimeMs <= endWallTimeMs &&
      EXTERNAL_MODEL_REQUEST_PATTERN.test(request.url),
  ).length;
}

async function waitForActiveSpeculation(
  cdp,
  { afterSequence = 0, excludeIds = [], timeoutMs = 60_000 } = {},
) {
  const excluded = new Set(excludeIds);
  const observed = await waitForBrowserState(
    cdp,
    (state) => {
      const events = workerEventsAfter(state, afterSequence);
      for (const request of events) {
        if (
          request.direction !== "out" ||
          request.type !== "synthesize" ||
          excluded.has(request.id)
        ) {
          continue;
        }
        const start = events.find(
          (entry) =>
            entry.direction === "in" &&
            entry.type === "wasm-run-start" &&
            entry.id === request.id,
        );
        if (!start) continue;
        const playing = latestNarrationAudioPlaying(state);
        if (!playing || playing.event.atMs > request.atMs) continue;
        return { playing, request, start };
      }
      return null;
    },
    "an active speculative threaded-WASM run",
    timeoutMs,
  );
  return { ...observed.result, state: observed.state };
}

async function waitForCooperativeTerminal(
  cdp,
  requestId,
  afterSequence,
  timeoutMs,
) {
  const observed = await waitForBrowserState(
    cdp,
    (state) =>
      workerEventsAfter(state, afterSequence).find(
        (entry) =>
          entry.direction === "in" &&
          entry.id === requestId &&
          entry.type === "canceled" &&
          entry.cooperative === true,
      ),
    `cooperative terminal acknowledgement for request ${requestId}`,
    timeoutMs,
  );
  return { event: observed.result, state: observed.state };
}

function narrationPauseAfter(state, actionAtMs) {
  const events = state.audio
    .flatMap((audio) =>
      audio.events.map((entry) => ({ ...entry, audioId: audio.id })),
    )
    .filter(
      (entry) =>
        entry.name === "pause" && !entry.loop && entry.atMs >= actionAtMs,
    )
    .sort((left, right) => left.atMs - right.atMs);
  return events[0] ?? null;
}

async function pauseActiveSpeculation({
  active,
  cdp,
  cpuSampler,
  clockTicksPerSecond,
  idleThresholdPercent = MAX_QUIESCENT_CPU_PERCENT,
  timeoutMs,
}) {
  await delay(125);
  const action = await clickRecordedAction(cdp, "pause-active-speculation");
  const terminal = await waitForCooperativeTerminal(
    cdp,
    active.request.id,
    active.start.sequence - 1,
    timeoutMs,
  );
  const pauseEvent = narrationPauseAfter(terminal.state, action.atMs);
  if (!pauseEvent) {
    throw new Error(
      `Pause for request ${active.request.id} did not pause audible audio.`,
    );
  }
  const runEnd = terminal.state.workerEvents.find(
    (entry) =>
      entry.direction === "in" &&
      entry.id === active.request.id &&
      entry.type === "wasm-run-end" &&
      entry.generation === active.start.generation,
  );
  if (!runEnd) {
    throw new Error(
      `Request ${active.request.id} did not publish wasm-run-end.`,
    );
  }
  const terminalBeforeAction = terminal.state.workerEvents.some(
    (entry) =>
      entry.id === active.request.id &&
      entry.atMs < action.atMs &&
      ["wasm-run-end", "success", "error", "canceled"].includes(entry.type),
  );
  const remaining =
    action.nodeDispatchedAtMs + MAX_CPU_QUIESCENCE_MS + 150 - performance.now();
  if (remaining > 0) await delay(remaining);
  const cpu = cpuWindow(
    [...cpuSampler.samples],
    action.nodeDispatchedAtMs,
    clockTicksPerSecond,
    idleThresholdPercent,
  );
  return {
    actionAtMs: action.atMs,
    actionWallTimeMs: action.wallTimeMs,
    actionNodeMonotonicMs: action.nodeDispatchedAtMs,
    actionRoundTripMs: action.nodeRoundTripMs,
    audiblePauseAtMs: pauseEvent.atMs,
    audiblePauseLatencyMs: pauseEvent.atMs - action.atMs,
    endToEndPauseUpperBoundMs:
      action.nodeRoundTripMs + (pauseEvent.atMs - action.atMs),
    cooperative: terminal.event.cooperative,
    cpu,
    generation: active.start.generation,
    provenActive: active.start.atMs <= action.atMs && !terminalBeforeAction,
    requestId: active.request.id,
    runEndedAtMs: runEnd.atMs,
    runEndedSequence: runEnd.sequence,
    runStartedAtMs: active.start.atMs,
    sessionGeneration: active.start.sessionGeneration,
    terminalAtMs: terminal.event.atMs,
    terminalSequence: terminal.event.sequence,
    terminalType: terminal.event.type,
    workerEpoch: active.start.epoch,
  };
}

async function resumeNarration(cdp, afterMs, timeoutMs) {
  const action = await clickRecordedAction(cdp, "resume-narration");
  const observed = await waitForBrowserState(
    cdp,
    (state) =>
      latestNarrationAudioPlaying(state, Math.max(afterMs, action.atMs)),
    "paused Offline-natural audio to resume playing",
    timeoutMs,
  );
  return { action, ...observed.result, state: observed.state };
}

async function runThreadedWasmScenario({
  cdp,
  cpuSampler,
  clockTicksPerSecond,
  networkRequests,
  timeoutMs,
}) {
  const initial = await startNarration(cdp, timeoutMs);
  if (
    initial.success.backendDevice !== "wasm" ||
    (initial.success.wasmThreads ?? 1) <= 1
  ) {
    throw new Error(
      `Threaded scenario selected ${initial.success.backendDevice}/${initial.success.wasmThreads}.`,
    );
  }
  const cancellations = [];
  const warmupActive = await waitForActiveSpeculation(cdp, {
    afterSequence: initial.success.sequence,
    excludeIds: [initial.request.id],
    timeoutMs,
  });
  const warmupCancellation = await pauseActiveSpeculation({
    active: warmupActive,
    cdp,
    cpuSampler,
    clockTicksPerSecond,
    timeoutMs,
  });
  const cpuBaseline = measureIdleCpuBaseline(
    [...cpuSampler.samples],
    warmupCancellation.actionNodeMonotonicMs,
    clockTicksPerSecond,
  );
  const cacheBaseline = await stableCacheInventory(cdp);
  await resumeNarration(cdp, warmupCancellation.actionAtMs, timeoutMs);

  const excludedIds = [initial.request.id, warmupActive.request.id];
  let afterSequence = warmupCancellation.terminalSequence;
  for (let index = 0; index < REQUIRED_ACTIVE_CANCELLATIONS; index += 1) {
    const active = await waitForActiveSpeculation(cdp, {
      afterSequence,
      excludeIds: excludedIds,
      timeoutMs,
    });
    const cancellation = await pauseActiveSpeculation({
      active,
      cdp,
      cpuSampler,
      clockTicksPerSecond,
      idleThresholdPercent: cpuBaseline.derivedIdleThresholdPercent,
      timeoutMs,
    });
    cancellations.push(cancellation);
    excludedIds.push(active.request.id);
    afterSequence = cancellation.terminalSequence;
    const resumed = await resumeNarration(
      cdp,
      cancellation.actionAtMs,
      timeoutMs,
    );
    if (!resumed.event)
      throw new Error("Narration did not resume after cancellation.");
  }

  const followupActive = await waitForActiveSpeculation(cdp, {
    afterSequence: cancellations.at(-1)?.terminalSequence ?? 0,
    excludeIds: excludedIds,
    timeoutMs,
  });
  const followupSuccess = await waitForBrowserState(
    cdp,
    (state) =>
      state.workerEvents.find(
        (entry) =>
          entry.direction === "in" &&
          entry.type === "success" &&
          entry.id === followupActive.request.id &&
          entry.sequence > followupActive.start.sequence,
      ),
    "the immediate same-session request after cancellation to succeed",
    timeoutMs,
  );
  const first = cancellations[0];
  const sameSessionFollowup = {
    modelRequests: countModelRequests(
      networkRequests,
      cancellations[0].actionWallTimeMs,
      followupSuccess.result.wallTimeMs,
    ),
    requestId: followupActive.request.id,
    sessionGeneration: followupActive.start.sessionGeneration,
    success: true,
    successAtMs: followupSuccess.result.atMs,
    workerEpoch: followupActive.start.epoch,
    workerTerminations: followupSuccess.state.workerEvents.filter(
      (entry) =>
        entry.type === "worker-terminated" &&
        entry.atMs >= cancellations[0].actionAtMs &&
        entry.atMs <= followupSuccess.result.atMs,
    ).length,
    expectedSessionGeneration: first.sessionGeneration,
    expectedWorkerEpoch: first.workerEpoch,
  };

  const currentAudioId = initial.audio.audio.id;
  const preparedAudio = await waitForBrowserState(
    cdp,
    (state) =>
      state.audio.find(
        (audio) =>
          audio.id !== currentAudioId &&
          audio.sourceBlobId &&
          audio.createdAtMs >= followupSuccess.result.atMs,
      ),
    "the completed lookahead audio to become prepared",
    timeoutMs,
  );
  const preparedPause = await clickRecordedAction(
    cdp,
    "pause-with-ready-lookahead",
  );
  await waitForBrowserState(
    cdp,
    (state) => narrationPauseAfter(state, preparedPause.atMs),
    "Pause while lookahead audio is already ready",
    timeoutMs,
  );
  const preparedResume = await resumeNarration(
    cdp,
    preparedPause.atMs,
    timeoutMs,
  );
  const boundaryAction = await evaluate(
    cdp,
    `(() => {
      const action = globalThis.__lineLightIssue55.action("finish-current-for-ready-reuse");
      return {
        ...action,
        finished: globalThis.__lineLightIssue55.finishCurrentNarrationAudio()
      };
    })()`,
  );
  if (!boundaryAction.finished) {
    throw new Error(
      "Could not advance the current audio to the prepared lookahead.",
    );
  }
  const preparedPlayed = await waitForBrowserState(
    cdp,
    (state) => {
      const audio = state.audio.find(
        (candidate) => candidate.id === preparedAudio.result.id,
      );
      const playing = audio?.events.find(
        (entry) => entry.name === "playing" && entry.atMs > boundaryAction.atMs,
      );
      return playing ? { audio, playing } : null;
    },
    "the exact pre-Pause lookahead audio to play",
    timeoutMs,
  );
  const synthesisBeforeBoundaryAdvance =
    preparedPlayed.state.workerEvents.filter(
      (entry) =>
        entry.direction === "out" &&
        entry.type === "synthesize" &&
        entry.atMs > preparedPause.atMs &&
        entry.atMs < boundaryAction.atMs,
    );
  const preparedResumeEvidence = {
    audioCreatedAtMs: preparedAudio.result.createdAtMs,
    audioCreatedBeforePause:
      preparedAudio.result.createdAtMs < preparedPause.atMs,
    audioId: preparedAudio.result.id,
    discarded: false,
    newSynthesisRequests: synthesisBeforeBoundaryAdvance.length,
    playedAtMs: preparedPlayed.result.playing.atMs,
    requestId: followupActive.request.id,
    resumedCurrentAtMs: preparedResume.event.atMs,
    success: true,
  };

  const seekDiscard = await waitForActiveSpeculation(cdp, {
    afterSequence: followupSuccess.result.sequence,
    excludeIds: [...excludedIds, followupActive.request.id],
    timeoutMs,
  });
  let crossing = null;
  for (let index = 0; index < 16 && !crossing; index += 1) {
    const action = await clickRecordedAction(
      cdp,
      `far-seek-next-sentence-${index + 1}`,
      'button[aria-label="Next sentence"]',
    );
    await delay(75);
    const state = await browserSnapshot(cdp);
    const targetRequest = state.workerEvents.find(
      (entry) =>
        entry.direction === "out" &&
        entry.type === "synthesize" &&
        entry.id !== seekDiscard.request.id &&
        entry.sequence > seekDiscard.start.sequence &&
        entry.atMs >= action.atMs,
    );
    if (targetRequest) crossing = { action, state, targetRequest };
  }
  if (!crossing) {
    throw new Error("Next Sentence never crossed the buffered chunk boundary.");
  }
  const farSeekState = await waitForBrowserState(
    cdp,
    (state) => {
      const discardedTerminal = state.workerEvents.find(
        (entry) =>
          entry.direction === "in" &&
          entry.type === "canceled" &&
          entry.cooperative === true &&
          entry.id === seekDiscard.request.id,
      );
      const targetStart = state.workerEvents.find(
        (entry) =>
          entry.direction === "in" &&
          entry.type === "wasm-run-start" &&
          entry.id === crossing.targetRequest.id,
      );
      return discardedTerminal && targetStart
        ? { discardedTerminal, targetStart }
        : null;
    },
    "the far-seek discard and target run start",
    timeoutMs,
  );
  const farSeek = {
    actionAtMs: crossing.action.atMs,
    discardedRequestId: seekDiscard.request.id,
    discardedRunCooperativelyCanceled: true,
    discardedRunProvenActive: seekDiscard.start.atMs <= crossing.action.atMs,
    discardedSessionGeneration: seekDiscard.start.sessionGeneration,
    discardedTerminalAtMs: farSeekState.result.discardedTerminal.atMs,
    discardedWorkerEpoch: seekDiscard.start.epoch,
    targetRequestId: crossing.targetRequest.id,
    targetRunStartAtMs: farSeekState.result.targetStart.atMs,
    targetRunStartLatencyMs:
      farSeekState.result.targetStart.atMs - crossing.action.atMs,
    targetStartedAfterDiscardedTerminal:
      farSeekState.result.targetStart.sequence >
      farSeekState.result.discardedTerminal.sequence,
    targetSessionGeneration: farSeekState.result.targetStart.sessionGeneration,
    targetWorkerEpoch: farSeekState.result.targetStart.epoch,
  };

  const targetSuccess = await waitForBrowserState(
    cdp,
    (state) =>
      state.workerEvents.find(
        (entry) =>
          entry.direction === "in" &&
          entry.type === "success" &&
          entry.id === crossing.targetRequest.id,
      ),
    "far-seek target synthesis success",
    timeoutMs,
  );
  const targetPlaying = await waitForBrowserState(
    cdp,
    (state) => latestNarrationAudioPlaying(state, targetSuccess.result.atMs),
    "far-seek target audio to reach playing",
    timeoutMs,
  );
  farSeek.targetAudioPlayingAtMs = targetPlaying.result.event.atMs;
  farSeek.targetAudioLatencyMs =
    targetPlaying.result.event.atMs - crossing.action.atMs;

  const preTimeoutActive = await waitForActiveSpeculation(cdp, {
    afterSequence: targetSuccess.result.sequence,
    excludeIds: [crossing.targetRequest.id],
    timeoutMs,
  });
  const cleanPause = await pauseActiveSpeculation({
    active: preTimeoutActive,
    cdp,
    cpuSampler,
    clockTicksPerSecond,
    timeoutMs,
  });
  await evaluate(cdp, `globalThis.__lineLightIssue55.armForcedTimeout()`);
  const forcedResume = await resumeNarration(
    cdp,
    cleanPause.actionAtMs,
    timeoutMs,
  );
  const forcedStart = await waitForBrowserState(
    cdp,
    (state) =>
      state.workerEvents.find(
        (entry) =>
          entry.type === "forced-fake-run-start" &&
          entry.atMs >= forcedResume.action.atMs,
      ),
    "the forced watchdog run to publish its controlled start",
    timeoutMs,
  );
  const timeoutPause = await clickRecordedAction(cdp, "pause-forced-timeout");
  await waitForBrowserState(
    cdp,
    (state) =>
      state.workerEvents.find(
        (entry) =>
          entry.type === "forced-cancel-swallowed" &&
          entry.id === forcedStart.result.id,
      ),
    "the controlled cancellation message to be withheld",
    timeoutMs,
  );
  const pendingResume = await resumeNarration(
    cdp,
    timeoutPause.atMs,
    timeoutMs,
  );
  const pendingOld = await waitForBrowserState(
    cdp,
    (state) =>
      state.workerEvents.find(
        (entry) =>
          entry.direction === "out" &&
          entry.type === "synthesize" &&
          entry.epoch === forcedStart.result.epoch &&
          entry.id !== forcedStart.result.id &&
          entry.atMs >= pendingResume.action.atMs,
      ),
    "a live request queued behind the forced-timeout request",
    timeoutMs,
  );
  const recovery = await waitForBrowserState(
    cdp,
    (state) => {
      const termination = state.workerEvents.find(
        (entry) =>
          entry.type === "worker-terminated" &&
          entry.epoch === forcedStart.result.epoch &&
          entry.atMs >= timeoutPause.atMs,
      );
      const replay = state.workerEvents.find(
        (entry) =>
          entry.direction === "out" &&
          entry.type === "synthesize" &&
          entry.id === pendingOld.result.id &&
          entry.epoch > forcedStart.result.epoch,
      );
      const success = replay
        ? state.workerEvents.find(
            (entry) =>
              entry.direction === "in" &&
              entry.type === "success" &&
              entry.id === replay.id &&
              entry.epoch === replay.epoch,
          )
        : null;
      return termination && replay && success
        ? { replay, success, termination }
        : null;
    },
    "worker replacement and pending-request replay after watchdog timeout",
    timeoutMs,
  );
  const finalTimeoutState = recovery.state;
  const forcedState = finalTimeoutState.forcedTimeout;
  const timeoutRecovery = {
    cacheUnchanged: null,
    canceledRequestReplayed: finalTimeoutState.workerEvents.some(
      (entry) =>
        entry.direction === "out" &&
        entry.id === forcedStart.result.id &&
        entry.epoch > forcedStart.result.epoch,
    ),
    forced: true,
    modelRequests: countModelRequests(
      networkRequests,
      timeoutPause.wallTimeMs,
      Date.now(),
    ),
    newWorkerEpoch: recovery.result.replay.epoch,
    oldWorkerEpoch: forcedStart.result.epoch,
    oldWorkerTerminated: true,
    pendingRequestId: pendingOld.result.id,
    pendingRequestReplayed: true,
    pendingRequestSucceeded: true,
    staleMessagesIgnored:
      finiteNumber(forcedState?.staleInjectedAtMs) &&
      !finalTimeoutState.errors.some((error) =>
        String(error).includes("Issue #55 stale worker sentinel"),
      ),
    watchdogDelayMs: recovery.result.termination.atMs - timeoutPause.atMs,
  };

  return {
    cacheBaseline,
    cancellations,
    cpuBaseline,
    farSeek,
    preparedResume: preparedResumeEvidence,
    sameSessionFollowup,
    timeoutRecovery,
    targetPlayingAudioId: targetPlaying.result.audio.id,
    events: finalTimeoutState.workerEvents,
  };
}

async function runNonCooperativePauseScenario({ cdp, mode, timeoutMs }) {
  const initial = await startNarration(cdp, timeoutMs);
  const afterSequence = initial.success.sequence;
  const pending = await waitForBrowserState(
    cdp,
    (state) => {
      const request = workerEventsAfter(state, afterSequence).find(
        (entry) => entry.direction === "out" && entry.type === "synthesize",
      );
      if (!request) return null;
      const progress = state.workerEvents.find(
        (entry) =>
          entry.direction === "in" &&
          entry.id === request.id &&
          entry.type === "progress" &&
          entry.stage === "synthesizing",
      );
      const terminal = state.workerEvents.find(
        (entry) =>
          entry.direction === "in" &&
          entry.id === request.id &&
          ["success", "error", "canceled"].includes(entry.type),
      );
      return progress && !terminal ? { progress, request } : null;
    },
    `${mode} speculative synthesis to become active without an ORT mailbox`,
    timeoutMs,
  );
  const action = await clickRecordedAction(cdp, `pause-${mode}-fallback`);
  await delay(FALLBACK_OBSERVATION_MS);
  const completed = await waitForBrowserState(
    cdp,
    (state) =>
      state.workerEvents.find(
        (entry) =>
          entry.direction === "in" &&
          entry.type === "success" &&
          entry.id === pending.result.request.id,
      ),
    `${mode} paused speculative request to finish on the same worker`,
    timeoutMs,
  );
  const state = completed.state;
  const relevant = state.workerEvents.filter(
    (entry) => entry.sequence >= pending.result.request.sequence,
  );
  const success = relevant.find(
    (entry) =>
      entry.direction === "in" &&
      entry.type === "success" &&
      entry.id === pending.result.request.id,
  );
  return {
    actionAtMs: action.atMs,
    available: true,
    cancelMessages: relevant.filter(
      (entry) => entry.direction === "out" && entry.type === "cancel",
    ).length,
    device: initial.success.backendDevice,
    observationMs: FALLBACK_OBSERVATION_MS,
    requestId: pending.result.request.id,
    sameRequestSucceeded: Boolean(success),
    wasmRunStarts: relevant.filter(
      (entry) => entry.direction === "in" && entry.type === "wasm-run-start",
    ).length,
    wasmThreads: initial.success.wasmThreads,
    workerTerminations: relevant.filter(
      (entry) => entry.type === "worker-terminated",
    ).length,
  };
}

async function clonePreparedProfile(sourceDirectory) {
  assertDisposableProfile(sourceDirectory);
  await access(path.join(sourceDirectory, "Default"));
  const runDirectory = await mkdtemp(
    path.join(os.tmpdir(), "linelight-issue55-browser-"),
  );
  const profileDirectory = path.join(runDirectory, "profile");
  try {
    await cp(sourceDirectory, profileDirectory, {
      force: true,
      mode: fsConstants.COPYFILE_FICLONE,
      recursive: true,
    });
    const sessionRestorePaths = [
      "Current Session",
      "Current Tabs",
      "Last Session",
      "Last Tabs",
      "Sessions",
    ];
    await Promise.all(
      sessionRestorePaths.map((entry) =>
        rm(path.join(profileDirectory, "Default", entry), {
          force: true,
          recursive: true,
        }),
      ),
    );
    for (const lock of [
      "SingletonCookie",
      "SingletonLock",
      "SingletonSocket",
    ]) {
      await rm(path.join(profileDirectory, lock), { force: true });
    }
  } catch (error) {
    await rm(runDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    profileDirectory,
    runDirectory,
    sessionRestorePurged: true,
  };
}

function processGroupAlive(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function hashDiagnostic(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function run(options) {
  await Promise.all([
    access(options.browser),
    access(options.fixture),
    access(options.profile),
  ]);
  const sourceBeforeBuild = await hashSourceFiles(options.fixture);
  if (sourceBeforeBuild.dirty) {
    throw new Error(
      "Authoritative headed evidence must run from the clean, frozen source commit.",
    );
  }
  const build = await runProductionBuild();
  const source = await hashSourceFiles(options.fixture);
  if (
    source.dirty ||
    source.commit !== sourceBeforeBuild.commit ||
    JSON.stringify(source.files) !== JSON.stringify(sourceBeforeBuild.files)
  ) {
    throw new Error("The production build changed the frozen evidence source.");
  }
  build.sourceCommit = source.commit;
  build.sourceFilesSha256 = hashDiagnostic(JSON.stringify(source.files));
  const artifact = await inspectProductionArtifacts();
  const profileClone = await clonePreparedProfile(options.profile);
  let server = null;
  let browser = null;
  let cdp = null;
  let cpuSampler = null;
  let execution = null;
  let cleanup = {
    browserProfileMatchesAfterStop: null,
    browserProcessGroupId: null,
    browserProcessGroupStopped: false,
    browserTrackedProcessCount: 0,
    browserTrackedProcessIdentityHashes: [],
    browserTrackedSurvivors: null,
    failures: [],
    profileCloneRemoved: false,
    serverCommandMatchesAfterStop: null,
    serverProcessGroupId: null,
    serverProcessGroupStopped: false,
    serverPortReleased: false,
    serverTrackedProcessCount: 0,
    serverTrackedProcessIdentityHashes: [],
    serverTrackedSurvivors: null,
    survivingBrowserProcesses: null,
  };
  try {
    if (!options.appUrl) server = await startProductionServer();
    const appUrl = options.appUrl ?? server.appUrl;
    if (
      new URL(appUrl).origin !==
      `http://127.0.0.1:${PREPARED_PROFILE_ORIGIN_PORT}`
    ) {
      throw new Error(
        `Prepared Cache Storage is bound to http://127.0.0.1:${PREPARED_PROFILE_ORIGIN_PORT}.`,
      );
    }
    browser = await startOwnedBrowser(
      options.browser,
      profileClone.profileDirectory,
    );
    cdp = await AttachedCdpSession.connect(browser.webSocketDebuggerUrl);
    const targetBaseline = await assertCleanTargetBaseline(cdp);
    const expectedWorkerUrl = new URL(
      `/${artifact.workerPath.replace(/^dist\/client\//u, "")}`,
      appUrl,
    ).href;
    const page = await configurePage(cdp, appUrl, expectedWorkerUrl);
    await page.settle();
    cpuSampler = startCpuSampler(browser.processGroupId);
    const isolation = {
      ...targetBaseline,
      sessionRestorePurged: profileClone.sessionRestorePurged,
    };
    await prepareScenario(cdp, appUrl, options.fixture, "threaded");
    const webGpuProbe = await probeWebGpu(cdp);
    const clockTicksPerSecond = Number(
      execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim(),
    );
    if (!Number.isFinite(clockTicksPerSecond) || clockTicksPerSecond <= 0) {
      throw new Error("Could not determine the Linux process clock tick rate.");
    }

    const threadedResult = await runThreadedWasmScenario({
      cdp,
      clockTicksPerSecond,
      cpuSampler,
      networkRequests: page.networkRequests,
      timeoutMs: options.timeoutMs,
    });
    const { cacheBaseline: cacheBefore, ...threadedWasm } = threadedResult;
    await page.settle();
    await assertBrowserStateHealthy(cdp, "the completed threaded-WASM matrix");

    await prepareScenario(cdp, appUrl, options.fixture, "w1");
    const wasmSingleThread = await runNonCooperativePauseScenario({
      cdp,
      mode: "w1",
      timeoutMs: options.timeoutMs,
    });
    await assertBrowserStateHealthy(
      cdp,
      "the completed single-thread WASM fallback",
    );

    let webgpu;
    const webGpuAvailable =
      webGpuProbe.adapterAvailable === true && webGpuProbe.shaderF16 === true;
    if (webGpuAvailable) {
      await prepareScenario(cdp, appUrl, options.fixture, "webgpu");
      webgpu = {
        ...(await runNonCooperativePauseScenario({
          cdp,
          mode: "webgpu",
          timeoutMs: options.timeoutMs,
        })),
        executableCoverage: {
          path: WEBGPU_COVERAGE_RELATIVE_PATH,
          sha256: WEBGPU_COVERAGE_SHA256,
        },
        probeAvailable: true,
        probe: webGpuProbe,
        unsafeFeatureFlags: false,
      };
    } else {
      await prepareScenario(cdp, appUrl, options.fixture, "auto");
      const graceful = await startNarration(cdp, options.timeoutMs);
      webgpu = {
        available: false,
        executableCoverage: {
          path: WEBGPU_COVERAGE_RELATIVE_PATH,
          sha256: WEBGPU_COVERAGE_SHA256,
        },
        gracefulFallback: {
          device: graceful.success.backendDevice,
          success: graceful.success.backendDevice === "wasm",
          wasmThreads: graceful.success.wasmThreads,
        },
        probe: webGpuProbe,
        probeAvailable: false,
        unflaggedAdapterResult: "unavailable",
        unsafeFeatureFlags: false,
      };
    }

    const finalBrowserState = await browserSnapshot(cdp);
    const browserVersion = await cdp.send("Browser.getVersion");
    const environment = await evaluate(
      cdp,
      `({
        crossOriginIsolated,
        hardwareConcurrency: navigator.hardwareConcurrency,
        platform: navigator.platform,
        userAgent: navigator.userAgent
      })`,
    );
    const finalIsolation = await quiesceFinalNarration(cdp, appUrl, page);
    const cacheAfter = await cacheInventory(cdp);
    await page.settle({ quietMs: 400, timeoutMs: 30_000 });
    const cacheUnchanged = cacheBefore.sha256 === cacheAfter.sha256;
    threadedWasm.timeoutRecovery.cacheUnchanged = cacheUnchanged;
    const appOrigin = new URL(appUrl).origin;
    const nonLoopbackRequests = page.networkRequests
      .filter((request) => {
        try {
          return (
            ["http:", "https:"].includes(new URL(request.url).protocol) &&
            new URL(request.url).origin !== appOrigin
          );
        } catch {
          return false;
        }
      })
      .map((request) => ({
        method: request.method,
        resourceType: request.resourceType,
        url: request.url,
        wallTimeMs: request.wallTimeMs,
      }));
    const externalModelRequests = nonLoopbackRequests.filter((request) =>
      EXTERNAL_MODEL_REQUEST_PATTERN.test(request.url),
    );
    const loadedPaths = new Set(
      page.networkRequests.map((request) => new URL(request.url).pathname),
    );
    const expectedJsepWasmPath = `/${artifact.jsepWasmPath.replace(/^dist\/client\//u, "")}`;
    const expectedWorkerPath = `/${artifact.workerPath.replace(/^dist\/client\//u, "")}`;
    artifact.loadedJsepWasmPath = loadedPaths.has(expectedJsepWasmPath)
      ? expectedJsepWasmPath
      : null;
    artifact.loadedWorkerPath = loadedPaths.has(expectedWorkerPath)
      ? expectedWorkerPath
      : null;
    artifact.loadedJsepWasm = artifact.loadedJsepWasmPath !== null;
    artifact.loadedWorker = artifact.loadedWorkerPath !== null;
    const targetCoverage = page.targetCoverage();
    execution = {
      artifact,
      browserDiagnostics: {
        consoleErrors: page.consoleEntries
          .filter((entry) => ["error", "assert"].includes(entry.type))
          .map((entry) => ({ severity: entry.type })),
        errors: finalBrowserState.errors.map((error) => ({
          code: "browser-runtime-error",
          sha256: hashDiagnostic(error),
        })),
      },
      cache: {
        after: cacheAfter,
        before: cacheBefore,
        unchanged: cacheUnchanged,
      },
      environment: {
        appOrigin,
        browserProduct: browserVersion.product,
        browserRevision: browserVersion.revision,
        crossOriginIsolated: environment.crossOriginIsolated,
        hardwareConcurrency: environment.hardwareConcurrency,
        platform: environment.platform,
        userAgent: environment.userAgent,
      },
      fallbacks: { wasmSingleThread, webgpu },
      finalIsolation,
      isolation,
      network: {
        attachFailures: page.attachFailures,
        externalModelRequests,
        loadingFailures: page.networkFailures.filter(
          (failure) => !failure.canceled,
        ),
        nonLoopbackRequests,
        observedRequestCount: page.networkRequests.length,
        offlineSpeechWorkerAttached: targetCoverage.offlineSpeechWorkerAttached,
        nestedPthreadWorkersAttached:
          targetCoverage.nestedPthreadWorkersAttached,
        outstandingAttachPromises: page.attachPromises.size,
        outstandingRequests: page.outstandingRequests.size,
        responseFailures: page.responseFailures,
        serviceWorkerBypassed: page.serviceWorkerBypassed,
        targetBootstrapSettlements: page.targetBootstrapSettlements,
        targetCounts: Object.fromEntries(
          [...new Set(page.targets.map((target) => target.type))]
            .sort()
            .map((type) => [
              type,
              page.targets.filter((target) => target.type === type).length,
            ]),
        ),
      },
      threadedWasm,
    };
  } finally {
    const cleanupFailures = [];
    const attemptCleanup = async (code, operation) => {
      try {
        return await operation();
      } catch (error) {
        cleanupFailures.push({ code, sha256: hashDiagnostic(error) });
        return null;
      }
    };
    await attemptCleanup("cdp-close-failed", async () => cdp?.close());
    await attemptCleanup("cpu-sampler-stop-failed", async () =>
      cpuSampler?.stop(),
    );
    const processTableBeforeStop =
      browser || server
        ? await attemptCleanup(
            "owned-process-snapshot-failed",
            readProcessTable,
          )
        : null;
    const browserCommandNeedle = `--user-data-dir=${profileClone.profileDirectory}`;
    const serverCommandNeedle = `--port ${PREPARED_PROFILE_ORIGIN_PORT}`;
    const browserTrackedProcesses =
      browser && processTableBeforeStop
        ? selectOwnedProcessTree(processTableBeforeStop, {
            commandNeedle: browserCommandNeedle,
            processGroupId: browser.processGroupId,
            rootPid: browser.child.pid,
          })
        : [];
    const serverTrackedProcesses =
      server && processTableBeforeStop
        ? selectOwnedProcessTree(processTableBeforeStop, {
            commandNeedle: serverCommandNeedle,
            processGroupId: server.child.pid,
            requiredCwd: REPOSITORY_ROOT,
            rootPid: server.child.pid,
          })
        : [];
    const browserStop = browser
      ? await attemptCleanup("browser-stop-failed", async () =>
          stopProcessGroup(browser.processGroupId, 5_000),
        )
      : null;
    let survivingBrowserProcesses = null;
    if (browser) {
      const alive = await attemptCleanup(
        "browser-survival-check-failed",
        async () => processGroupAlive(browser.processGroupId),
      );
      survivingBrowserProcesses = alive === null ? null : alive ? 1 : 0;
    }
    const serverStop = server
      ? await attemptCleanup("server-stop-failed", async () =>
          stopProcessGroup(server.child.pid, 5_000),
        )
      : null;
    const processProof =
      browser && server
        ? await attemptCleanup("owned-process-proof-failed", async () =>
            waitForOwnedProcessCleanup({
              browserCommandNeedle,
              browserTrackedProcesses,
              serverCommandNeedle,
              serverRequiredCwd: REPOSITORY_ROOT,
              serverTrackedProcesses,
            }),
          )
        : null;
    await attemptCleanup("profile-clone-remove-failed", async () =>
      rm(profileClone.runDirectory, { recursive: true, force: true }),
    );
    let profileCloneRemoved = false;
    await attemptCleanup("profile-clone-check-failed", async () => {
      try {
        await access(profileClone.runDirectory);
      } catch (error) {
        if (error?.code === "ENOENT") {
          profileCloneRemoved = true;
          return;
        }
        throw error;
      }
    });
    cleanup = {
      browserProfileMatchesAfterStop:
        processProof?.browserProfileMatchesAfterStop ?? null,
      browserProcessGroupId: browser?.processGroupId ?? null,
      browserProcessGroupStopped: browserStop?.closed === true,
      browserTrackedProcessCount: browserTrackedProcesses.length,
      browserTrackedProcessIdentityHashes: browserTrackedProcesses
        .map(processIdentityHash)
        .sort(),
      browserTrackedSurvivors: processProof?.browserTrackedSurvivors ?? null,
      failures: cleanupFailures,
      profileCloneRemoved,
      serverCommandMatchesAfterStop:
        processProof?.serverCommandMatchesAfterStop ?? null,
      serverProcessGroupId: server?.child.pid ?? null,
      serverProcessGroupStopped: serverStop?.closed === true,
      serverPortReleased: processProof?.serverPortReleased ?? false,
      serverTrackedProcessCount: serverTrackedProcesses.length,
      serverTrackedProcessIdentityHashes: serverTrackedProcesses
        .map(processIdentityHash)
        .sort(),
      serverTrackedSurvivors: processProof?.serverTrackedSurvivors ?? null,
      survivingBrowserProcesses,
    };
  }

  if (!execution) throw new Error("The headed matrix ended without evidence.");
  const evidence = {
    schemaVersion: 1,
    issue: 55,
    generatedAt: new Date().toISOString(),
    source,
    build,
    fixture: {
      path: path.relative(REPOSITORY_ROOT, options.fixture),
      sha256: await sha256File(options.fixture),
      synthetic:
        path.relative(REPOSITORY_ROOT, options.fixture) ===
          DEFAULT_FIXTURE_RELATIVE_PATH &&
        (await sha256File(options.fixture)) === DEFAULT_FIXTURE_SHA256,
    },
    run: {
      appOrigin: execution.environment.appOrigin,
      externalUrl: Boolean(options.appUrl),
      headed: true,
      ownedProductionServer: !options.appUrl,
      ownedProcessGroup: true,
      preparedProfile: "disposable clone with the locally stored offline pack",
    },
    thresholds: {
      cancellationTimeoutMs: CANCELLATION_TIMEOUT_MS,
      cancellationTimeoutToleranceMs: CANCELLATION_TIMEOUT_TOLERANCE_MS,
      maximumCpuSampleIntervalMs: MAX_CPU_SAMPLE_INTERVAL_MS,
      maximumFarSeekStartMs: MAX_FAR_SEEK_START_MS,
      maximumPauseLatencyMs: MAX_PAUSE_LATENCY_MS,
      maximumQuiescentCpuPercent: MAX_QUIESCENT_CPU_PERCENT,
      maximumTimeToCpuQuiescenceMs: MAX_CPU_QUIESCENCE_MS,
      requiredActiveCancellations: REQUIRED_ACTIVE_CANCELLATIONS,
    },
    privacy: {
      narrationTextRecorded: false,
      retainedWorkerPayloadFields:
        "ids, generations, counts, timings, hashes, and backend state only",
    },
    ...execution,
    cleanup,
  };
  evidence.failures = validateOfflineCancellationEvidence(evidence);
  evidence.passed = evidence.failures.length === 0;
  await mkdir(options.outputDirectory, { recursive: true });
  const evidencePath = path.join(options.outputDirectory, EVIDENCE_FILENAME);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      evidence: evidencePath,
      failures: evidence.failures,
      passed: evidence.passed,
    })}\n`,
  );
  if (!evidence.passed) process.exitCode = 1;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options) await run(options);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
