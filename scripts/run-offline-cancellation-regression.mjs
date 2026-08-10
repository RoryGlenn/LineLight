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
const EXPECTED_MODEL_CACHE_ENTRIES = 24;
const EXPECTED_VOICE_CACHE_ENTRIES = 5;
const MODEL_CACHE_NAME = "transformers-cache";
const RUNTIME_CACHE_NAME = "linelight-assets-v1";
const VOICE_CACHE_NAME = "kokoro-voices";
const REQUIRED_ACTIVE_CANCELLATIONS = 5;
const CPU_SAMPLE_INTERVAL_MS = 50;
const MAX_CPU_SAMPLE_INTERVAL_MS = 100;
const MAX_PAUSE_LATENCY_MS = 50;
const MAX_CPU_QUIESCENCE_MS = 500;
const MAX_QUIESCENT_CPU_PERCENT = 50;
const CPU_PROCESS_ROLES = new Set([
  "browser",
  "gpu-process",
  "other",
  "renderer",
  "utility",
  "zygote",
]);
const CPU_PROCESS_SAMPLE_KEYS = Object.freeze(
  ["pid", "role", "startTimeTicks", "ticks"].sort(),
);
const CPU_SAMPLE_KEYS = Object.freeze(
  ["monotonicMs", "processes", "wallTimeMs"].sort(),
);
const CPU_BASELINE_KEYS = Object.freeze(
  [
    "derivedIdleThresholdPercent",
    "intervals",
    "p95CpuPercent",
    "samples",
  ].sort(),
);
const CPU_CANCELLATION_KEYS = Object.freeze(
  [
    "activeIntervals",
    "cpuPercentAtIdle",
    "idleByMs",
    "intervals",
    "peakActiveCpuPercent",
    "samples",
  ].sort(),
);
const CPU_INTERVAL_KEYS = Object.freeze(
  [
    "cpuPercent",
    "elapsedMs",
    "endMonotonicMs",
    "processCount",
    "startMonotonicMs",
  ].sort(),
);
const CPU_ACTION_INTERVAL_KEYS = Object.freeze(
  [...CPU_INTERVAL_KEYS, "endAfterActionMs"].sort(),
);
const MAX_FAR_SEEK_START_MS = 500;
const CANCELLATION_TIMEOUT_MS = 750;
const CANCELLATION_TIMEOUT_TOLERANCE_MS = 250;
const FALLBACK_OBSERVATION_MS = CANCELLATION_TIMEOUT_MS + 250;
const FAR_SEEK_RESET_ANCHOR_KIND = "reviewed-fixture-token";
const FAR_SEEK_RESET_ANCHOR_ORDINAL = 0;
const PREPARED_PROFILE_ORIGIN_PORT = 5212;
const EXTERNAL_MODEL_REQUEST_PATTERN =
  /(?:huggingface\.co|cdn\.jsdelivr\.net|raw\.githubusercontent\.com|kokoro|onnx\/model.*\.onnx|voices\/.*\.bin)/iu;
const PROTOCOL_WORKER_EVENT_KEYS = Object.freeze(
  [
    "atMs",
    "backendDevice",
    "cooperative",
    "direction",
    "elapsedMilliseconds",
    "epoch",
    "generation",
    "id",
    "progress",
    "sequence",
    "sessionGeneration",
    "stage",
    "type",
    "wallTimeMs",
    "wasmThreads",
  ].sort(),
);
const CONTROL_WORKER_EVENT_KEYS = Object.freeze(
  ["atMs", "direction", "epoch", "id", "sequence", "type", "wallTimeMs"].sort(),
);
const FORCED_START_EVENT_KEYS = Object.freeze(
  [...CONTROL_WORKER_EVENT_KEYS, "generation", "sessionGeneration"].sort(),
);
const WORKER_PROGRESS_STAGES = new Set([
  "downloading",
  "initializing",
  "loaded",
  "ready",
  "synthesizing",
  "verifying",
  "warming",
]);
const SOURCE_EVIDENCE_FILES = Object.freeze([
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

function validDetachedSessionHashSet(
  before,
  detached,
  { minimum = 1 } = {},
) {
  return (
    Array.isArray(before) &&
    before.length >= minimum &&
    Array.isArray(detached) &&
    detached.length === before.length &&
    before.every((value) => /^[a-f\d]{64}$/u.test(value)) &&
    detached.every((value) => /^[a-f\d]{64}$/u.test(value)) &&
    new Set(before).size === before.length &&
    new Set(detached).size === detached.length &&
    JSON.stringify([...before].sort()) ===
      JSON.stringify([...detached].sort())
  );
}

function exactObjectKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
  );
}

function nullable(value, predicate) {
  return value === null || predicate(value);
}

function uint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function validCpuProcessSample(process_) {
  return (
    exactObjectKeys(process_, CPU_PROCESS_SAMPLE_KEYS) &&
    Number.isSafeInteger(process_.pid) &&
    process_.pid >= 1 &&
    typeof process_.role === "string" &&
    CPU_PROCESS_ROLES.has(process_.role) &&
    Number.isSafeInteger(process_.startTimeTicks) &&
    process_.startTimeTicks >= 0 &&
    Number.isSafeInteger(process_.ticks) &&
    process_.ticks >= 0
  );
}

function validCpuSample(sample) {
  if (
    !exactObjectKeys(sample, CPU_SAMPLE_KEYS) ||
    !finiteNumber(sample.monotonicMs) ||
    sample.monotonicMs < 0 ||
    !finiteNumber(sample.wallTimeMs) ||
    sample.wallTimeMs < 0 ||
    !Array.isArray(sample.processes) ||
    sample.processes.length < 1 ||
    sample.processes.length > 1_024 ||
    !sample.processes.every(validCpuProcessSample)
  ) {
    return false;
  }
  const processIdentities = sample.processes.map(
    (process_) => `${process_.pid}:${process_.startTimeTicks}`,
  );
  return new Set(processIdentities).size === processIdentities.length;
}

function validCpuSampleTimeline(samples, minimum = 3) {
  if (
    !Array.isArray(samples) ||
    samples.length < minimum ||
    samples.length > 10_000
  ) {
    return false;
  }
  let previousMonotonicMs = -Infinity;
  let previousWallTimeMs = -Infinity;
  for (const sample of samples) {
    if (
      !validCpuSample(sample) ||
      sample.monotonicMs <= previousMonotonicMs ||
      sample.wallTimeMs < previousWallTimeMs
    ) {
      return false;
    }
    previousMonotonicMs = sample.monotonicMs;
    previousWallTimeMs = sample.wallTimeMs;
  }
  return true;
}

function validCpuInterval(interval, { actionRelative = false } = {}) {
  const expectedKeys = actionRelative
    ? CPU_ACTION_INTERVAL_KEYS
    : CPU_INTERVAL_KEYS;
  return (
    exactObjectKeys(interval, expectedKeys) &&
    finiteNumber(interval.cpuPercent) &&
    interval.cpuPercent >= 0 &&
    finiteNumber(interval.elapsedMs) &&
    interval.elapsedMs > 0 &&
    interval.elapsedMs <= MAX_CPU_SAMPLE_INTERVAL_MS &&
    finiteNumber(interval.startMonotonicMs) &&
    interval.startMonotonicMs >= 0 &&
    finiteNumber(interval.endMonotonicMs) &&
    interval.endMonotonicMs > interval.startMonotonicMs &&
    Math.abs(
      interval.endMonotonicMs -
        interval.startMonotonicMs -
        interval.elapsedMs,
    ) < 0.001 &&
    Number.isInteger(interval.processCount) &&
    interval.processCount >= 1 &&
    interval.processCount <= 1_024 &&
    (!actionRelative || finiteNumber(interval.endAfterActionMs))
  );
}

function validCpuIntervalTimeline(
  intervals,
  samples,
  { actionRelative = false } = {},
) {
  if (
    !Array.isArray(intervals) ||
    !Array.isArray(samples) ||
    intervals.length < 2 ||
    intervals.length !== samples.length - 1
  ) {
    return false;
  }
  return intervals.every(
    (interval, index) =>
      validCpuInterval(interval, { actionRelative }) &&
      Math.abs(interval.startMonotonicMs - samples[index].monotonicMs) <
        0.001 &&
      Math.abs(interval.endMonotonicMs - samples[index + 1].monotonicMs) <
        0.001 &&
      interval.processCount === samples[index + 1].processes.length,
  );
}

function validCpuBaseline(baseline) {
  return (
    exactObjectKeys(baseline, CPU_BASELINE_KEYS) &&
    validCpuSampleTimeline(baseline.samples) &&
    validCpuIntervalTimeline(baseline.intervals, baseline.samples) &&
    finiteNumber(baseline.p95CpuPercent) &&
    finiteNumber(baseline.derivedIdleThresholdPercent) &&
    baseline.p95CpuPercent <= baseline.derivedIdleThresholdPercent &&
    baseline.derivedIdleThresholdPercent <= MAX_QUIESCENT_CPU_PERCENT &&
    baseline.derivedIdleThresholdPercent ===
      Math.min(
        MAX_QUIESCENT_CPU_PERCENT,
        Math.max(10, Math.ceil(baseline.p95CpuPercent + 10)),
      )
  );
}

function validCpuCancellation(cpu) {
  if (
    !exactObjectKeys(cpu, CPU_CANCELLATION_KEYS) ||
    !validCpuSampleTimeline(cpu.samples) ||
    !validCpuIntervalTimeline(cpu.intervals, cpu.samples, {
      actionRelative: true,
    }) ||
    !Array.isArray(cpu.activeIntervals) ||
    cpu.activeIntervals.length < 1 ||
    !cpu.activeIntervals.every((interval) =>
      validCpuInterval(interval, { actionRelative: true }),
    ) ||
    JSON.stringify(cpu.activeIntervals) !==
      JSON.stringify(
        cpu.intervals.filter((interval) => interval.endAfterActionMs <= 0),
      ) ||
    !finiteNumber(cpu.cpuPercentAtIdle) ||
    cpu.cpuPercentAtIdle < 0 ||
    !finiteNumber(cpu.idleByMs) ||
    cpu.idleByMs < 0 ||
    !finiteNumber(cpu.peakActiveCpuPercent) ||
    cpu.peakActiveCpuPercent < 0
  ) {
    return false;
  }
  return (
    cpu.peakActiveCpuPercent ===
    Math.max(...cpu.activeIntervals.map((interval) => interval.cpuPercent))
  );
}

function validProtocolWorkerEvent(event) {
  const validDirectionAndType =
    (event.direction === "out" &&
      ["cancel", "initialize", "install", "synthesize"].includes(
        event.type,
      )) ||
    (event.direction === "in" &&
      [
        "canceled",
        "error",
        "progress",
        "success",
        "wasm-run-end",
        "wasm-run-start",
      ].includes(event.type));
  return (
    exactObjectKeys(event, PROTOCOL_WORKER_EVENT_KEYS) &&
    validDirectionAndType &&
    finiteNumber(event.atMs) &&
    event.atMs >= 0 &&
    finiteNumber(event.wallTimeMs) &&
    event.wallTimeMs >= 0 &&
    Number.isInteger(event.sequence) &&
    event.sequence >= 1 &&
    Number.isInteger(event.epoch) &&
    event.epoch >= 1 &&
    Number.isInteger(event.id) &&
    event.id >= 1 &&
    nullable(
      event.backendDevice,
      (value) => typeof value === "string" && ["wasm", "webgpu"].includes(value),
    ) &&
    nullable(event.cooperative, (value) => typeof value === "boolean") &&
    nullable(
      event.elapsedMilliseconds,
      (value) => finiteNumber(value) && value >= 0,
    ) &&
    nullable(event.generation, uint32) &&
    nullable(
      event.progress,
      (value) => Number.isInteger(value) && value >= 0 && value <= 100,
    ) &&
    nullable(event.sessionGeneration, uint32) &&
    nullable(
      event.stage,
      (value) => typeof value === "string" && WORKER_PROGRESS_STAGES.has(value),
    ) &&
    nullable(
      event.wasmThreads,
      (value) => Number.isInteger(value) && value >= 1 && value <= 1_024,
    )
  );
}

function validControlWorkerEvent(event) {
  if (
    !["forced-cancel-swallowed", "forced-fake-run-start", "worker-terminated"].includes(
      event?.type,
    ) ||
    event?.direction !== "control" ||
    !finiteNumber(event.atMs) ||
    event.atMs < 0 ||
    !finiteNumber(event.wallTimeMs) ||
    event.wallTimeMs < 0 ||
    !Number.isInteger(event.sequence) ||
    event.sequence < 1 ||
    !Number.isInteger(event.epoch) ||
    event.epoch < 1
  ) {
    return false;
  }
  if (event.type === "forced-fake-run-start") {
    return (
      exactObjectKeys(event, FORCED_START_EVENT_KEYS) &&
      Number.isInteger(event.id) &&
      event.id >= 1 &&
      uint32(event.generation) &&
      uint32(event.sessionGeneration)
    );
  }
  return (
    exactObjectKeys(event, CONTROL_WORKER_EVENT_KEYS) &&
    (event.type === "worker-terminated"
      ? event.id === null
      : Number.isInteger(event.id) && event.id >= 1)
  );
}

function validWorkerEventTimeline(events) {
  if (!Array.isArray(events) || events.length < 1 || events.length > 100_000) {
    return false;
  }
  let previousSequence = 0;
  let previousAtMs = -Infinity;
  let previousWallTimeMs = -Infinity;
  for (const event of events) {
    if (
      (!validProtocolWorkerEvent(event) && !validControlWorkerEvent(event)) ||
      event.sequence <= previousSequence ||
      event.atMs < previousAtMs ||
      event.wallTimeMs < previousWallTimeMs
    ) {
      return false;
    }
    previousSequence = event.sequence;
    previousAtMs = event.atMs;
    previousWallTimeMs = event.wallTimeMs;
  }
  return true;
}

function validateCpuRecord(record, index, failures, idleThresholdPercent) {
  const prefix = `cancellation ${index + 1}`;
  const samples = record.cpu?.samples ?? [];
  pushFailure(
    failures,
    validCpuCancellation(record.cpu),
    `${prefix} did not retain exact-schema, enum-only owned-process CPU evidence`,
  );
  const intervals = record.cpu?.intervals ?? [];
  pushFailure(
    failures,
    validCpuIntervalTimeline(intervals, samples, { actionRelative: true }) &&
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
    Array.isArray(record.cpu?.activeIntervals) &&
      record.cpu.activeIntervals.length >= 1 &&
      record.cpu.activeIntervals.every((entry) =>
        validCpuInterval(entry, { actionRelative: true }),
      ) &&
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
    validWorkerEventTimeline(evidence?.threadedWasm?.events),
    "worker event evidence contains unknown, out-of-order, or privacy-unsafe fields",
  );
  pushFailure(
    failures,
    validCpuBaseline(cpuBaseline),
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
    (() => {
      const events = evidence?.threadedWasm?.events;
      if (!Array.isArray(events)) return false;
      const preparedRequest = events.find(
        (entry) =>
          entry.direction === "out" &&
          entry.type === "synthesize" &&
          entry.id === prepared?.requestId &&
          entry.epoch === prepared?.requestWorkerEpoch &&
          entry.sequence === prepared?.requestSequence &&
          entry.atMs === prepared?.requestAtMs,
      );
      const preparedSuccess = events.find(
        (entry) =>
          entry.direction === "in" &&
          entry.type === "success" &&
          entry.id === prepared?.requestId &&
          entry.epoch === prepared?.requestWorkerEpoch &&
          entry.sessionGeneration === prepared?.requestSessionGeneration &&
          entry.sequence === prepared?.requestSuccessSequence &&
          entry.atMs === prepared?.requestSucceededAtMs,
      );
      const synthesisBeforePreparedPlayback = events
        .filter(
          (entry) =>
            entry.direction === "out" &&
            entry.type === "synthesize" &&
            entry.atMs > prepared?.pauseAtMs &&
            entry.atMs < prepared?.playedAtMs,
        )
        .sort((left, right) => left.sequence - right.sequence);
      const duplicatePreparedSynthesisRequests = events.filter(
        (entry) =>
          entry.direction === "out" &&
          entry.type === "synthesize" &&
          entry.id === prepared?.requestId &&
          entry.epoch === prepared?.requestWorkerEpoch &&
          entry.sequence > prepared?.requestSequence,
      );
      const interveningDistinctRequestIds = synthesisBeforePreparedPlayback
        .filter(
          (entry) =>
            entry.id !== prepared?.requestId ||
            entry.epoch !== prepared?.requestWorkerEpoch,
        )
        .map((entry) => entry.id);
      return (
        prepared?.success === true &&
        prepared?.audioCreatedBeforePause === true &&
        prepared?.discarded === false &&
        prepared?.sameAudioPlayed === true &&
        prepared?.duplicatePreparedSynthesisRequests === 0 &&
        duplicatePreparedSynthesisRequests.length === 0 &&
        Number.isInteger(prepared?.audioId) &&
        Number.isInteger(prepared?.requestId) &&
        Number.isInteger(prepared?.requestSequence) &&
        Number.isInteger(prepared?.requestSuccessSequence) &&
        prepared.requestSequence < prepared.requestSuccessSequence &&
        prepared?.requestWorkerEpoch === first?.workerEpoch &&
        prepared?.requestSessionGeneration === first?.sessionGeneration &&
        finiteNumber(prepared?.requestAtMs) &&
        finiteNumber(prepared?.requestSucceededAtMs) &&
        finiteNumber(prepared?.audioCreatedAtMs) &&
        finiteNumber(prepared?.pauseAtMs) &&
        finiteNumber(prepared?.resumedCurrentAtMs) &&
        finiteNumber(prepared?.playedAtMs) &&
        prepared.requestAtMs <= prepared.requestSucceededAtMs &&
        prepared.requestSucceededAtMs <= prepared.audioCreatedAtMs &&
        prepared.audioCreatedAtMs < prepared.pauseAtMs &&
        prepared.pauseAtMs <= prepared.resumedCurrentAtMs &&
        prepared.resumedCurrentAtMs <= prepared.playedAtMs &&
        Array.isArray(prepared?.interveningDistinctRequestIds) &&
        JSON.stringify(prepared.interveningDistinctRequestIds) ===
          JSON.stringify(interveningDistinctRequestIds) &&
        prepared.interveningDistinctRequestIds.every(
          (requestId) =>
            Number.isInteger(requestId) && requestId !== prepared.requestId,
        ) &&
        Number.isInteger(prepared?.snapshotSequence) &&
        Boolean(preparedRequest) &&
        Boolean(preparedSuccess)
      );
    })(),
    "Resume did not reuse already prepared audio unchanged",
  );

  const farSeek = evidence?.threadedWasm?.farSeek;
  const farSeekReset = farSeek?.reset;
  pushFailure(
    failures,
    farSeekReset?.anchor?.kind === FAR_SEEK_RESET_ANCHOR_KIND &&
      farSeekReset?.anchor?.ordinal === FAR_SEEK_RESET_ANCHOR_ORDINAL &&
      farSeekReset?.anchor?.matchCount === 1 &&
      farSeekReset?.preResetPreparedSnapshotSequence ===
        prepared?.snapshotSequence &&
      finiteNumber(prepared?.playedAtMs) &&
      finiteNumber(farSeekReset?.actionAtMs) &&
      prepared.playedAtMs < farSeekReset.actionAtMs &&
      Number.isInteger(farSeekReset?.preResetRequestCount) &&
      farSeekReset.preResetRequestCount >= 1 &&
      farSeekReset.preResetRequestCount >=
        farSeekReset.preResetOpenRequestCount &&
      Number.isInteger(farSeekReset?.preResetMaxRequestId) &&
      Number.isInteger(farSeekReset?.preResetOpenRequestCount) &&
      farSeekReset.preResetOpenRequestCount >= 0 &&
      farSeekReset?.preResetOpenTerminalCount ===
        farSeekReset.preResetOpenRequestCount &&
      farSeekReset?.preResetErrorTerminalCount === 0 &&
      Number.isInteger(farSeekReset?.preResetRequestBoundarySequence) &&
      farSeekReset.preResetRequestBoundarySequence >=
        farSeekReset.preResetPreparedSnapshotSequence &&
      Number.isInteger(farSeekReset?.boundarySequence) &&
      farSeekReset.boundarySequence >=
        farSeekReset.preResetRequestBoundarySequence &&
      farSeekReset?.currentSynthesisRequested === true &&
      Number.isInteger(farSeekReset?.currentRequestId) &&
      Number.isInteger(farSeekReset?.lookaheadRequestId) &&
      Number.isInteger(farSeekReset?.currentRequestSequence) &&
      Number.isInteger(farSeekReset?.currentRunStartSequence) &&
      Number.isInteger(farSeekReset?.currentSuccessSequence) &&
      Number.isInteger(farSeekReset?.lookaheadRequestSequence) &&
      Number.isInteger(farSeekReset?.lookaheadRunStartSequence) &&
      farSeekReset.currentRequestId > farSeekReset.preResetMaxRequestId &&
      farSeekReset.currentRequestId !== farSeekReset.lookaheadRequestId &&
      farSeekReset.lookaheadRequestId > farSeekReset.currentRequestId &&
      farSeekReset.lookaheadRequestId === farSeek?.discardedRequestId &&
      farSeekReset.currentRequestSequence > farSeekReset.boundarySequence &&
      farSeekReset.currentRequestSequence <
        farSeekReset.currentRunStartSequence &&
      farSeekReset.currentRunStartSequence <
        farSeekReset.currentSuccessSequence &&
      farSeekReset.currentSuccessSequence <
        farSeekReset.lookaheadRequestSequence &&
      farSeekReset.lookaheadRequestSequence <
        farSeekReset.lookaheadRunStartSequence &&
      farSeekReset.currentRequestAtMs <= farSeekReset.currentRunStartAtMs &&
      farSeekReset.actionAtMs < farSeekReset.currentRequestAtMs &&
      farSeekReset.currentRunStartAtMs <= farSeekReset.currentSuccessAtMs &&
      farSeekReset.currentSuccessAtMs < farSeekReset.currentAudioPlayingAtMs &&
      farSeekReset.currentAudioPlayingAtMs <
        farSeekReset.lookaheadRequestAtMs &&
      farSeekReset.lookaheadRequestAtMs <= farSeekReset.lookaheadRunStartAtMs &&
      farSeekReset.currentWorkerEpoch === first?.workerEpoch &&
      farSeekReset.currentSessionGeneration === first?.sessionGeneration &&
      farSeekReset.lookaheadWorkerEpoch === first?.workerEpoch &&
      farSeekReset.lookaheadSessionGeneration === first?.sessionGeneration &&
      farSeekReset.workerTerminations === 0 &&
      farSeekReset.modelRequests === 0 &&
      farSeekReset.backendChanges === 0 &&
      farSeekReset.sessionIdentityChanges === 0,
    "far-seek reset did not establish a fresh active same-session lookahead after prepared-audio proof",
  );
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
      farSeek?.discardedWorkerEpoch === first?.workerEpoch &&
      farSeek?.discardedSessionGeneration === first?.sessionGeneration &&
      farSeek?.targetRequestId > farSeek?.discardedRequestId &&
      farSeekReset?.lookaheadRunStartAtMs <= farSeek?.actionAtMs &&
      farSeek.actionAtMs <= farSeek?.discardedTerminalAtMs &&
      farSeek.discardedTerminalAtMs <= farSeek?.targetRunStartAtMs &&
      finiteNumber(farSeek?.targetAudioPlayingAtMs) &&
      finiteNumber(farSeek?.targetAudioLatencyMs) &&
      finiteNumber(farSeek?.targetRunStartAtMs) &&
      farSeek.targetAudioPlayingAtMs >= farSeek.targetRunStartAtMs &&
      Number.isInteger(farSeek?.targetAudioId) &&
      farSeek?.targetAudioSourceRequestId === farSeek?.targetRequestId &&
      farSeek?.targetAudioSourceWorkerEpoch === farSeek?.targetWorkerEpoch &&
      farSeek?.targetAudioSourceSessionGeneration ===
        farSeek?.targetSessionGeneration &&
      farSeek.targetRunStartLatencyMs ===
        farSeek.targetRunStartAtMs - farSeek.actionAtMs &&
      farSeek.targetAudioLatencyMs ===
        farSeek.targetAudioPlayingAtMs - farSeek.actionAtMs,
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
      timeout?.requiredCacheSubsetUnchanged === true &&
      validRequiredOfflineCacheSnapshot(
        timeout?.requiredCacheBefore,
        evidence?.artifact?.loadedJsepWasmPath,
      ) &&
      validRequiredOfflineCacheSnapshot(
        timeout?.requiredCacheAfter,
        evidence?.artifact?.loadedJsepWasmPath,
      ) &&
      timeout.requiredCacheBefore.sha256 ===
        timeout.requiredCacheAfter.sha256 &&
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
    evidence?.network?.unexplainedAttachFailures?.length === 0 &&
      Array.isArray(evidence?.network?.attachFailures) &&
      Array.isArray(
        evidence?.network?.intentionalServiceWorkerUnregisterRaces,
      ) &&
      evidence.network.attachFailures.length ===
        evidence.network.intentionalServiceWorkerUnregisterRaces.length &&
      JSON.stringify(evidence.network.attachFailures) ===
        JSON.stringify(
          evidence.network.intentionalServiceWorkerUnregisterRaces,
        ) &&
      evidence.network.intentionalServiceWorkerUnregisterRaces.every(
        (failure) =>
          failure.targetType === "service_worker" &&
          failure.phase === "service-worker-unregister" &&
          failure.detached === true &&
          ["target-attach-failed", "target-resume-failed"].includes(
            failure.code,
          ) &&
          /^[a-f\d]{64}$/u.test(failure.sha256) &&
          /^[a-f\d]{64}$/u.test(failure.targetIdSha256),
      ) &&
      evidence?.network?.serviceWorkerBypassed === true &&
      evidence?.network?.serviceWorkerLifecycle
        ?.attachFixedPointBeforeUnregister === true &&
      evidence.network.serviceWorkerLifecycle.phase ===
        "service-worker-unregister" &&
      Number.isInteger(evidence.network.serviceWorkerLifecycle.registrations) &&
      evidence.network.serviceWorkerLifecycle.registrations >= 0 &&
      evidence.network.serviceWorkerLifecycle.unregistered ===
        evidence.network.serviceWorkerLifecycle.registrations &&
      evidence?.network?.loadingFailures?.length === 0 &&
      evidence?.network?.responseFailures?.length === 0 &&
      evidence?.network?.outstandingRequests === 0 &&
      evidence?.network?.outstandingAttachPromises === 0 &&
      evidence?.network?.offlineSpeechWorkerAttached === true &&
      (evidence?.network?.nestedPthreadWorkersAttached ?? 0) >= 1 &&
      (evidence?.network?.sameUrlNestedPthreadWorkersAttached ?? 0) >= 1 &&
      evidence?.network?.orphanedOfflineWorkerTargets === 0 &&
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
    (() => {
      const manifest = evidence?.cache?.currentRuntimeManifest;
      const transition = analyzeOfflineCacheTransition(
        evidence?.cache?.before,
        evidence?.cache?.after,
        {
          currentJsepPath: evidence?.artifact?.loadedJsepWasmPath,
          currentRuntimeAssetPaths: manifest?.assetPaths,
        },
      );
      return (
        validCacheInventory(evidence?.cache?.before) &&
        validCacheInventory(evidence?.cache?.after) &&
        Array.isArray(manifest?.assetPaths) &&
        manifest.assetPaths.length >= 1 &&
        manifest.assetPaths.includes(evidence?.artifact?.loadedJsepWasmPath) &&
        manifest.sha256 ===
          hashDiagnostic(JSON.stringify([...manifest.assetPaths].sort())) &&
        validRequiredOfflineCacheSnapshot(
          transition.requiredBefore,
          evidence?.artifact?.loadedJsepWasmPath,
        ) &&
        validRequiredOfflineCacheSnapshot(
          transition.requiredAfter,
          evidence?.artifact?.loadedJsepWasmPath,
        ) &&
        transition.requiredSubsetUnchanged &&
        transition.added.length === 0 &&
        transition.unexplainedRemovals.length === 0 &&
        JSON.stringify(evidence?.cache?.transition) ===
          JSON.stringify(transition)
      );
    })(),
    "required offline model, voice, or current runtime cache data changed",
  );
  pushFailure(
    failures,
    evidence?.browserDiagnostics?.errors?.length === 0 &&
      evidence?.browserDiagnostics?.consoleErrors?.length === 0 &&
      evidence?.browserDiagnostics?.runtimeExceptions?.length === 0 &&
      Array.isArray(evidence?.browserDiagnostics?.consoleDiagnostics) &&
      evidence.browserDiagnostics.consoleDiagnostics.every(
        (entry) =>
          [
            "runtime-console",
            "runtime-exception",
            "network-log",
            "browser-log",
          ].includes(entry.category) &&
          [
            "app-load",
            "service-worker-unregister",
            "threaded-wasm",
            "single-thread-wasm",
            "webgpu",
            "webgpu-fallback",
            "final-quiesce",
          ].includes(entry.phase) &&
          [
            "page",
            "unknown-target",
            "service-worker",
            "other-target",
            "offline-pthread",
            "offline-speech",
            "pdf-worker",
            "other-worker",
          ].includes(entry.sessionClass) &&
          typeof entry.severity === "string" &&
          Number.isInteger(entry.count) &&
          entry.count >= 1 &&
          /^[a-f\d]{64}$/u.test(entry.sha256) &&
          JSON.stringify(Object.keys(entry).sort()) ===
            JSON.stringify(
              [
                "category",
                "count",
                "phase",
                "sessionClass",
                "severity",
                "sha256",
              ].sort(),
            ),
      ),
    "browser diagnostics contain an error",
  );
  pushFailure(
    failures,
    evidence?.finalIsolation?.narrationStopped === true &&
      evidence?.finalIsolation?.speechWorkersDetached >= 1 &&
      Number.isInteger(evidence?.finalIsolation?.pthreadWorkersDetached) &&
      evidence.finalIsolation.pthreadWorkersDetached >= 0 &&
      evidence?.finalIsolation?.activeSpeechWorkers === 0 &&
      evidence?.finalIsolation?.activePthreadWorkers === 0 &&
      Number.isInteger(evidence?.finalIsolation?.speechWorkersObserved) &&
      evidence.finalIsolation.speechWorkersObserved >= 1 &&
      evidence?.finalIsolation?.speechWorkersDetachedTotal ===
        evidence.finalIsolation.speechWorkersObserved &&
      Number.isInteger(evidence?.finalIsolation?.pthreadWorkersObserved) &&
      evidence.finalIsolation.pthreadWorkersObserved >= 1 &&
      evidence?.finalIsolation?.pthreadWorkersDetachedTotal ===
        evidence.finalIsolation.pthreadWorkersObserved &&
      validDetachedSessionHashSet(
        evidence?.finalIsolation?.rootSessionHashesBefore,
        evidence?.finalIsolation?.rootSessionHashesDetached,
      ) &&
      validDetachedSessionHashSet(
        evidence?.finalIsolation?.pthreadAncestryHashesBefore,
        evidence?.finalIsolation?.pthreadAncestryHashesDetached,
        { minimum: 0 },
      ) &&
      evidence.finalIsolation.speechWorkersDetached >=
        evidence.finalIsolation.rootSessionHashesBefore.length &&
      evidence.finalIsolation.pthreadWorkersDetached >=
        evidence.finalIsolation.pthreadAncestryHashesBefore.length &&
      evidence?.finalIsolation?.networkSettled === true &&
      evidence?.finalIsolation?.teardownPath ===
        "/offline-voice-license.txt",
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
  const forbiddenKeys = new Set(
    [
      "arguments",
      "argv",
      "commandArguments",
      "consoleEntries",
      "commandLine",
      "cwd",
      "directory",
      "documentText",
      "homeDirectory",
      "homePath",
      "message",
      "narrationText",
      "payload",
      "pidDirectory",
      "pidFile",
      "pidPath",
      "processArguments",
      "processCommand",
      "procPath",
      "profile",
      "profileDirectory",
      "profilePath",
      "requestText",
      "stack",
      "tempDirectory",
      "tempPath",
      "text",
      "textLength",
      "temporaryDirectory",
      "temporaryPath",
      "tmpDirectory",
      "tmpPath",
      "userDataDir",
      "values",
      "workingDirectory",
    ].map((key) => key.toLowerCase()),
  );
  const urlPathRules = [
    {
      path: /^\$evidence\.artifact\.loaded(?:JsepWasm|Worker)Path$/u,
      value: /^\/assets\/[A-Za-z\d._/-]+$/u,
    },
    {
      path: /^\$evidence\.cache\.(?:after|before)\.entries\[\d+\]\.url$/u,
      value: /^\/(?:assets|offline-model|onnx-community)\/[A-Za-z\d._/-]+$/u,
    },
    {
      path: /^\$evidence\.cache\.currentRuntimeManifest\.assetPaths\[\d+\]$/u,
      value: /^\/assets\/[A-Za-z\d._/-]+$/u,
    },
    {
      path: /^\$evidence\.cache\.transition\.(?:added|retiredRuntimeDeletions|unexplainedRemovals)\[\d+\]\.url$/u,
      value: /^\/(?:assets|offline-model|onnx-community)\/[A-Za-z\d._/-]+$/u,
    },
    {
      path: /^\$evidence\.cache\.transition\.required(?:After|Before)\.entries\[\d+\]\.url$/u,
      value: /^\/(?:assets|offline-model|onnx-community)\/[A-Za-z\d._/-]+$/u,
    },
    {
      path: /^\$evidence\.finalIsolation\.teardownPath$/u,
      value: /^\/offline-voice-license\.txt$/u,
    },
    {
      path: /^\$evidence\.threadedWasm\.timeoutRecovery\.requiredCache(?:After|Before)\.entries\[\d+\]\.url$/u,
      value: /^\/(?:assets|offline-model|onnx-community)\/[A-Za-z\d._/-]+$/u,
    },
  ];
  const isReviewedUrlPath = (current, currentPath) => {
    const rule = urlPathRules.find((candidate) =>
      candidate.path.test(currentPath),
    );
    if (
      !rule?.value.test(current) ||
      !current.startsWith("/") ||
      current.startsWith("//") ||
      current.includes("\\") ||
      /[?#\0]|%(?:2f|5c)/iu.test(current)
    ) {
      return false;
    }
    try {
      return new URL(current, "http://127.0.0.1").pathname === current;
    } catch {
      return false;
    }
  };
  const fullUrlRules = [
    {
      path: /^\$evidence\.(?:environment|run)\.appOrigin$/u,
      value: /^http:\/\/127\.0\.0\.1:5212$/u,
    },
    {
      path: /^\$evidence\.isolation\.baselinePageUrl$/u,
      value: /^about:\/\/non-http-resource$/u,
    },
    {
      path: /^\$evidence\.network\.targetBootstrapSettlements\[\d+\]\.url$/u,
      value:
        /^http:\/\/127\.0\.0\.1:5212\/assets\/[A-Za-z\d._/-]+$/u,
    },
  ];
  const isReviewedFullUrl = (current, currentPath) => {
    if (
      !fullUrlRules.some(
        (rule) => rule.path.test(currentPath) && rule.value.test(current),
      )
    ) {
      return false;
    }
    if (current === "about://non-http-resource") return true;
    try {
      const parsed = new URL(current);
      return (
        parsed.search === "" &&
        parsed.hash === "" &&
        (parsed.origin === current || parsed.href === current)
      );
    } catch {
      return false;
    }
  };
  const violatesPrivacy = (current, currentPath, { allowUrls = true } = {}) => {
    const containsProfileOrTempPrefix =
      /(?:HOME|TEMP|TMP|TMPDIR|USERPROFILE)=|(?:profile|temp(?:orary)?|tmp|user-?data)(?:-?(?:directory|dir|path))?=|linelight-issue55-(?:browser|profile)-/iu.test(
        current,
      );
    const reviewedUrl =
      allowUrls &&
      (isReviewedUrlPath(current, currentPath) ||
        isReviewedFullUrl(current, currentPath));
    const containsFilesystemPath =
      !reviewedUrl &&
      (current.includes("\\") ||
        /[A-Za-z]:\//u.test(current) ||
        /(?:^|[^\p{L}\p{N}._~-])\/(?:\/|[^\s]*)/u.test(current) ||
        /%(?:2f|5c)/iu.test(current) ||
        /file:\/\//iu.test(current) ||
        /(?:~|\$HOME|\$\{HOME\})[\\/]/u.test(current));
    return (
      containsProfileOrTempPrefix ||
      containsFilesystemPath ||
      current.includes("--") ||
      current.includes("\0") ||
      /I like my friend Tiarn|regretted attrition/iu.test(current)
    );
  };
  const visit = (current, currentPath) => {
    if (typeof current === "string") {
      if (violatesPrivacy(current, currentPath)) violations.push(currentPath);
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
      const unsafeKey = violatesPrivacy(key, currentPath, { allowUrls: false });
      const entryPath = unsafeKey
        ? `${currentPath}.$key[${hashDiagnostic(key).slice(0, 12)}]`
        : `${currentPath}.${key}`;
      if (forbiddenKeys.has(key.toLowerCase()) || unsafeKey) {
        violations.push(entryPath);
      }
      visit(entry, entryPath);
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
          let role = pid === processGroupId ? "browser" : "other";
          try {
            const commandLine = await readFile(
              path.join("/proc", entry, "cmdline"),
              "utf8",
            );
            role = classifyCpuProcessRole(commandLine, {
              isGroupLeader: pid === processGroupId,
            });
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

export function classifyCpuProcessRole(
  commandLine,
  { isGroupLeader = false } = {},
) {
  if (isGroupLeader) return "browser";
  if (typeof commandLine !== "string") return "other";
  const typeArgument = commandLine
    .split("\0")
    .find((argument) => argument.startsWith("--type="));
  const type = typeArgument?.slice("--type=".length) ?? "";
  return CPU_PROCESS_ROLES.has(type) && type !== "browser" ? type : "other";
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

export function correlateWorkerMessageSessionGeneration(
  message,
  sessionGenerationByRequest,
) {
  const id = message?.id;
  let sessionGeneration = Number.isInteger(message?.sessionGeneration)
    ? message.sessionGeneration
    : Number.isInteger(id)
      ? (sessionGenerationByRequest.get(id) ?? null)
      : null;
  if (
    message?.type === "wasm-run-start" &&
    Number.isInteger(id) &&
    Number.isInteger(sessionGeneration)
  ) {
    sessionGenerationByRequest.set(id, sessionGeneration);
  }
  if (
    Number.isInteger(id) &&
    ["canceled", "error", "success"].includes(message?.type)
  ) {
    sessionGenerationByRequest.delete(id);
  }
  return sessionGeneration;
}

function installBrowserInstrumentation(correlateSessionGeneration) {
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
  const requestByAudioData = new WeakMap();
  const requestByBlob = new WeakMap();
  const native = {
    Audio: globalThis.Audio,
    Blob: globalThis.Blob,
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
      sourceRequestId: null,
      sourceSessionGeneration: null,
      sourceWorkerEpoch: null,
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

  const WrappedBlob = function (parts, options) {
    const blob = new native.Blob(parts, options);
    const successfulRequest = Array.from(parts ?? [])
      .map((part) =>
        part && typeof part === "object" ? requestByAudioData.get(part) : null,
      )
      .find(Boolean);
    if (successfulRequest) requestByBlob.set(blob, successfulRequest);
    return blob;
  };
  Object.setPrototypeOf(WrappedBlob, native.Blob);
  WrappedBlob.prototype = native.Blob.prototype;
  globalThis.Blob = WrappedBlob;

  globalThis.URL.createObjectURL = function (object) {
    const url = native.createObjectURL.call(this, object);
    const successfulRequest = requestByBlob.get(object) ?? null;
    blobByUrl.set(url, {
      createdAtMs: globalThis.performance.now(),
      id: state.nextBlobId,
      requestId: successfulRequest?.id ?? null,
      sessionGeneration: successfulRequest?.sessionGeneration ?? null,
      size: object?.size ?? null,
      type: object?.type ?? null,
      workerEpoch: successfulRequest?.workerEpoch ?? null,
    });
    state.nextBlobId += 1;
    return url;
  };

  if (native.mediaSrc?.get && native.mediaSrc?.set) {
    Object.defineProperty(globalThis.HTMLMediaElement.prototype, "src", {
      ...native.mediaSrc,
      set(value) {
        const record = ensureAudio(this);
        const blob = blobByUrl.get(value);
        record.sourceBlobId = blob?.id ?? null;
        record.sourceRequestId = blob?.requestId ?? null;
        record.sourceSessionGeneration = blob?.sessionGeneration ?? null;
        record.sourceWorkerEpoch = blob?.workerEpoch ?? null;
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
      this.__issue55SessionGenerationByRequest = new Map();
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
          const sanitized = sanitizeWorkerMessage(
            message,
            "in",
            this.__issue55Epoch,
          );
          sanitized.sessionGeneration = correlateSessionGeneration(
            message,
            this.__issue55SessionGenerationByRequest,
          );
          event(sanitized);
          if (
            message?.type === "success" &&
            message?.result?.audioData instanceof ArrayBuffer
          ) {
            requestByAudioData.set(message.result.audioData, {
              id: message.id,
              sessionGeneration: sanitized.sessionGeneration,
              workerEpoch: this.__issue55Epoch,
            });
          }
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
    resetForFarSeek(anchorKind, anchorOrdinal) {
      const matches = Array.from(
        globalThis.document.querySelectorAll("#pdf-page-1 .pdf-word-overlay"),
      ).filter(
        (element) => element.getAttribute("aria-label") === "definition",
      );
      if (matches.length !== 1) {
        throw new Error("The reviewed far-seek reset anchor was not unique.");
      }
      const workerEvents = state.workerEvents.slice();
      const requestBoundarySequence = workerEvents.at(-1)?.sequence ?? 0;
      const requests = workerEvents
        .filter(
          (entry) => entry.direction === "out" && entry.type === "synthesize",
        )
        .map(({ epoch, id, sequence }) => ({ epoch, id, sequence }));
      const action = this.action("reset-for-far-seek");
      matches[0].click();
      return {
        action,
        anchor: {
          kind: anchorKind,
          matchCount: matches.length,
          ordinal: anchorOrdinal,
        },
        requestBoundarySequence,
        requests,
      };
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

const INSTRUMENTATION_SOURCE = `(${installBrowserInstrumentation.toString()})(${correlateWorkerMessageSessionGeneration.toString()});`;

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

export async function attachCdpChildTarget(
  cdp,
  entry,
  attachFailures,
  { phase = "unknown" } = {},
) {
  const { sessionId, targetInfo, waitingForDebugger } = entry;
  let attached = true;
  let resumed = !waitingForDebugger;
  const failureRecords = [];
  const recordFailure = (code, error) => {
    const record = {
      code,
      detached: false,
      phase,
      sha256: hashDiagnostic(error),
      targetIdSha256: hashDiagnostic(targetInfo.targetId ?? "unknown-target"),
      targetType: targetInfo.type,
    };
    failureRecords.push(record);
    attachFailures.push(record);
  };
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
    recordFailure("target-attach-failed", error);
  } finally {
    if (waitingForDebugger) {
      await cdp
        .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
        .then(() => {
          resumed = true;
        })
        .catch((error) => {
          recordFailure("target-resume-failed", error);
        });
    }
  }
  return { attached, failureRecords, resumed };
}

export function classifyTargetAttachFailures(attachFailures) {
  const intentionalServiceWorkerUnregisterRaces = attachFailures.filter(
    (failure) =>
      failure.targetType === "service_worker" &&
      failure.phase === "service-worker-unregister" &&
      failure.detached === true &&
      ["target-attach-failed", "target-resume-failed"].includes(failure.code),
  );
  return {
    intentionalServiceWorkerUnregisterRaces,
    unexplained: attachFailures.filter(
      (failure) => !intentionalServiceWorkerUnregisterRaces.includes(failure),
    ),
  };
}

export function summarizeAttachedTargetCoverage(targets, expectedWorkerUrl) {
  const targetsBySession = new Map(
    targets.map((target) => [target.sessionId, target]),
  );
  const exactWorkerTargets = targets.filter(
    (target) =>
      target.type === "worker" &&
      target.url === expectedWorkerUrl &&
      target.attachComplete,
  );
  const matchingAncestorSession = (target, sessionIds) => {
    const visited = new Set();
    let parentSessionId = target.parentSessionId;
    while (parentSessionId && !visited.has(parentSessionId)) {
      if (sessionIds.has(parentSessionId)) return parentSessionId;
      visited.add(parentSessionId);
      parentSessionId = targetsBySession.get(parentSessionId)?.parentSessionId;
    }
    return null;
  };
  const offlineWorkers = exactWorkerTargets.filter(
    (target) => target.parentSessionId === null,
  );
  const offlineSessions = new Set(
    offlineWorkers.map((target) => target.sessionId),
  );
  const pthreadWorkers = targets.filter(
    (target) =>
      target.type === "worker" &&
      target.attachComplete &&
      !offlineSessions.has(target.sessionId) &&
      matchingAncestorSession(target, offlineSessions),
  );
  const pthreadWorkerAncestry = pthreadWorkers.map((target) => ({
    rootSessionId: matchingAncestorSession(target, offlineSessions),
    sessionId: target.sessionId,
  }));
  const orphanedOfflineWorkers = exactWorkerTargets.filter(
    (target) =>
      !offlineSessions.has(target.sessionId) &&
      !matchingAncestorSession(target, offlineSessions),
  );
  const activeOfflineWorkers = offlineWorkers.filter(
    (target) => !target.detached,
  );
  const activePthreadWorkerAncestry = pthreadWorkerAncestry.filter(
    ({ sessionId }) => !targetsBySession.get(sessionId)?.detached,
  );
  const detachedPthreadWorkerAncestry = pthreadWorkerAncestry.filter(
    ({ sessionId }) => targetsBySession.get(sessionId)?.detached,
  );
  return {
    activeNestedPthreadWorkerAncestry: activePthreadWorkerAncestry,
    activeNestedPthreadWorkers: activePthreadWorkerAncestry.length,
    activeOfflineSpeechWorkers: activeOfflineWorkers.length,
    activeOfflineSpeechWorkerSessionIds: activeOfflineWorkers.map(
      (target) => target.sessionId,
    ),
    detachedNestedPthreadWorkerAncestry: detachedPthreadWorkerAncestry,
    detachedOfflineSpeechWorkerSessionIds: offlineWorkers
      .filter((target) => target.detached)
      .map((target) => target.sessionId),
    nestedPthreadWorkersAttached: pthreadWorkers.length,
    nestedPthreadWorkersDetached: detachedPthreadWorkerAncestry.length,
    offlineSpeechWorkerAttached: offlineWorkers.length >= 1,
    offlineSpeechWorkersAttached: offlineWorkers.length,
    orphanedOfflineWorkerTargets: orphanedOfflineWorkers.length,
    sameUrlNestedPthreadWorkersAttached: pthreadWorkers.filter(
      (target) => target.url === expectedWorkerUrl,
    ).length,
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

function targetSessionClass(sessionId, targetsBySession, expectedWorkerUrl) {
  if (!sessionId) return "page";
  const target = targetsBySession.get(sessionId);
  if (!target) return "unknown-target";
  if (target.type === "service_worker") return "service-worker";
  if (target.type !== "worker") return "other-target";
  const visited = new Set();
  let parentSessionId = target.parentSessionId;
  while (parentSessionId && !visited.has(parentSessionId)) {
    const parent = targetsBySession.get(parentSessionId);
    if (parent?.type === "worker" && parent.url === expectedWorkerUrl) {
      return "offline-pthread";
    }
    visited.add(parentSessionId);
    parentSessionId = parent?.parentSessionId;
  }
  if (target.url === expectedWorkerUrl) return "offline-speech";
  if (/pdf-(?:document|parser)\.worker/iu.test(target.url)) {
    return "pdf-worker";
  }
  return "other-worker";
}

export function summarizeConsoleDiagnostics(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = JSON.stringify([
      entry.category,
      entry.phase,
      entry.sessionClass,
      entry.severity,
      entry.sha256,
    ]);
    const current = grouped.get(key) ?? { ...entry, count: 0 };
    current.count += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

async function configurePage(cdp, appUrl, expectedWorkerPath) {
  const consoleEntries = [];
  const runtimeExceptionEntries = [];
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
  const allowedObservationPhases = new Set([
    "app-load",
    "service-worker-unregister",
    "threaded-wasm",
    "single-thread-wasm",
    "webgpu",
    "webgpu-fallback",
    "final-quiesce",
  ]);
  let lastActivityAtMs = performance.now();
  let observationPhase = "app-load";
  const markActivity = () => {
    lastActivityAtMs = performance.now();
  };
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
      category: "runtime-console",
      phase: observationPhase,
      sessionClass: targetSessionClass(
        sessionId,
        targetsBySession,
        expectedWorkerPath,
      ),
      severity: entry.type,
      sha256: hashDiagnostic(
        JSON.stringify({
          arguments: entry.args ?? [],
          stackTrace: entry.stackTrace ?? null,
          type: entry.type,
        }),
      ),
    });
  });
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }, sessionId) => {
    const diagnostic = {
      category: "runtime-exception",
      phase: observationPhase,
      sessionClass: targetSessionClass(
        sessionId,
        targetsBySession,
        expectedWorkerPath,
      ),
      severity: "error",
      sha256: hashDiagnostic(JSON.stringify(exceptionDetails ?? null)),
    };
    consoleEntries.push(diagnostic);
    runtimeExceptionEntries.push(diagnostic);
  });
  cdp.on("Log.entryAdded", ({ entry }, sessionId) => {
    consoleEntries.push({
      category: entry.source === "network" ? "network-log" : "browser-log",
      phase: observationPhase,
      sessionClass: targetSessionClass(
        sessionId,
        targetsBySession,
        expectedWorkerPath,
      ),
      severity: entry.level,
      sha256: hashDiagnostic(
        JSON.stringify({
          level: entry.level,
          source: entry.source,
          text: entry.text,
          url: safeNetworkUrl(entry.url ?? ""),
        }),
      ),
    });
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
    const request = requestsByKey.get(
      `${sessionId ?? "page"}:${entry.requestId}`,
    );
    responseFailures.push({
      method: request?.method ?? null,
      requestId: entry.requestId,
      resourceType: request?.resourceType ?? null,
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
      failureRecords: [],
      parentSessionId,
      phase: observationPhase,
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
      { phase: observationPhase },
    )
      .then((result) => {
        target.attachComplete = result.attached && result.resumed;
        target.failureRecords = result.failureRecords;
        for (const failure of target.failureRecords) {
          failure.detached = target.detached;
        }
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
    if (target) {
      target.detached = true;
      for (const failure of target.failureRecords) failure.detached = true;
    }
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
  await settle();
  const attachFixedPointBeforeUnregister =
    attachPromises.size === 0 && outstandingRequests.size === 0;
  observationPhase = "service-worker-unregister";
  const unregisterResult = await evaluate(
    cdp,
    `(async () => {
      const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
      const results = await Promise.all(registrations.map((entry) => entry.unregister()));
      return { registrations: registrations.length, unregistered: results.filter(Boolean).length };
    })()`,
  );
  await settle();
  observationPhase = "app-load";
  const targetCoverage = () =>
    summarizeAttachedTargetCoverage(targets, expectedWorkerPath);
  return {
    attachFailureClassification: () =>
      classifyTargetAttachFailures(attachFailures),
    attachFailures,
    attachPromises,
    consoleEntries,
    networkFailures,
    networkRequests,
    outstandingRequests,
    responseFailures,
    runtimeExceptionEntries,
    serviceWorkerBypassed: true,
    serviceWorkerLifecycle: {
      attachFixedPointBeforeUnregister,
      phase: "service-worker-unregister",
      registrations: unregisterResult.registrations,
      unregistered: unregisterResult.unregistered,
    },
    setObservationPhase(phase) {
      if (!allowedObservationPhases.has(phase)) {
        throw new Error(`Unknown CDP observation phase: ${phase}.`);
      }
      observationPhase = phase;
    },
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

function latestNarrationAudioPlayingForSource(
  state,
  { requestId, sessionGeneration, workerEpoch },
  afterMs = -Infinity,
) {
  for (const audio of [...state.audio].reverse()) {
    if (
      audio.sourceRequestId !== requestId ||
      audio.sourceSessionGeneration !== sessionGeneration ||
      audio.sourceWorkerEpoch !== workerEpoch
    ) {
      continue;
    }
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

function synthesisTerminalForRequest(state, request) {
  return state.workerEvents.find(
    (entry) =>
      entry.direction === "in" &&
      entry.epoch === request.epoch &&
      entry.id === request.id &&
      entry.sequence > request.sequence &&
      ["canceled", "error", "success"].includes(entry.type),
  );
}

export function findUnterminatedSynthesisRequests(
  state,
  maximumRequestSequence = Number.POSITIVE_INFINITY,
) {
  return state.workerEvents.filter(
    (entry) =>
      entry.direction === "out" &&
      entry.type === "synthesize" &&
      entry.sequence <= maximumRequestSequence &&
      !synthesisTerminalForRequest(state, entry),
  );
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
    state: playing.state,
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
          const [digest, requestDigest] = await Promise.all([
            crypto.subtle.digest("SHA-256", bytes),
            crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(request.url)
            )
          ]);
          entries.push({
            byteLength: bytes.byteLength,
            cacheName,
            requestSha256: Array.from(new Uint8Array(requestDigest), (value) =>
              value.toString(16).padStart(2, "0")
            ).join(""),
            sha256: Array.from(new Uint8Array(digest), (value) =>
              value.toString(16).padStart(2, "0")
            ).join(""),
            url: new URL(request.url).pathname
          });
        }
      }
      entries.sort((left, right) =>
        (left.cacheName + left.url + left.requestSha256).localeCompare(
          right.cacheName + right.url + right.requestSha256
        )
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

function cacheEntryKey(entry) {
  return JSON.stringify([
    entry.cacheName,
    entry.url,
    entry.requestSha256,
    entry.sha256,
    entry.byteLength,
  ]);
}

function cacheEntryIdentity(entry) {
  return `${entry.cacheName}\0${entry.url}\0${entry.requestSha256}`;
}

function isCanonicalCachePathname(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }
  try {
    const parsed = new URL(value, "https://cache.invalid");
    return (
      parsed.origin === "https://cache.invalid" &&
      parsed.pathname === value &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function validCacheInventory(inventory) {
  if (
    !inventory ||
    !Array.isArray(inventory.entries) ||
    inventory.entries.length === 0 ||
    inventory.entries.length > 2_048 ||
    !/^[a-f\d]{64}$/u.test(inventory.sha256 ?? "")
  ) {
    return false;
  }
  const identities = new Set();
  for (const entry of inventory.entries) {
    if (
      !entry ||
      Object.keys(entry).sort().join(",") !==
        "byteLength,cacheName,requestSha256,sha256,url" ||
      !Number.isInteger(entry.byteLength) ||
      entry.byteLength <= 0 ||
      typeof entry.cacheName !== "string" ||
      entry.cacheName.length === 0 ||
      entry.cacheName.length > 128 ||
      !isCanonicalCachePathname(entry.url) ||
      !/^[a-f\d]{64}$/u.test(entry.requestSha256) ||
      !/^[a-f\d]{64}$/u.test(entry.sha256)
    ) {
      return false;
    }
    const identity = cacheEntryIdentity(entry);
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  const sorted = [...inventory.entries].sort((left, right) =>
    cacheEntryIdentity(left).localeCompare(cacheEntryIdentity(right)),
  );
  return (
    JSON.stringify(inventory.entries) === JSON.stringify(sorted) &&
    inventory.sha256 === hashDiagnostic(JSON.stringify(inventory.entries))
  );
}

function sortedCacheEntries(entries) {
  return [...entries].sort((left, right) =>
    cacheEntryKey(left).localeCompare(cacheEntryKey(right)),
  );
}

export function requiredOfflineCacheSnapshot(inventory, currentJsepPath) {
  const entries = sortedCacheEntries(
    (inventory?.entries ?? []).filter(
      (entry) =>
        entry.cacheName === MODEL_CACHE_NAME ||
        entry.cacheName === VOICE_CACHE_NAME ||
        (entry.cacheName === RUNTIME_CACHE_NAME &&
          entry.url === currentJsepPath),
    ),
  );
  return {
    currentJsepEntries: entries.filter(
      (entry) =>
        entry.cacheName === RUNTIME_CACHE_NAME &&
        entry.url === currentJsepPath &&
        entry.sha256 === EXPECTED_JSEP_WASM_SHA256,
    ).length,
    entries,
    modelEntries: entries.filter(
      (entry) => entry.cacheName === MODEL_CACHE_NAME,
    ).length,
    sha256: hashDiagnostic(JSON.stringify(entries)),
    voiceEntries: entries.filter(
      (entry) => entry.cacheName === VOICE_CACHE_NAME,
    ).length,
  };
}

function cacheEntryMultisetDifference(leftEntries, rightEntries) {
  const remaining = new Map();
  for (const entry of rightEntries) {
    const key = cacheEntryKey(entry);
    const values = remaining.get(key) ?? [];
    values.push(entry);
    remaining.set(key, values);
  }
  const difference = [];
  for (const entry of leftEntries) {
    const key = cacheEntryKey(entry);
    const values = remaining.get(key);
    if (values?.length) {
      values.pop();
      if (!values.length) remaining.delete(key);
    } else {
      difference.push(entry);
    }
  }
  return sortedCacheEntries(difference);
}

export function analyzeOfflineCacheTransition(
  before,
  after,
  { currentJsepPath, currentRuntimeAssetPaths },
) {
  const requiredBefore = requiredOfflineCacheSnapshot(before, currentJsepPath);
  const requiredAfter = requiredOfflineCacheSnapshot(after, currentJsepPath);
  const removed = cacheEntryMultisetDifference(
    before?.entries ?? [],
    after?.entries ?? [],
  );
  const added = cacheEntryMultisetDifference(
    after?.entries ?? [],
    before?.entries ?? [],
  );
  const currentRuntimeAssets = new Set(currentRuntimeAssetPaths ?? []);
  const retiredRuntimeDeletions = removed.filter(
    (entry) =>
      /^linelight-(?:assets-v1|v\d+)$/u.test(entry.cacheName) &&
      entry.url.startsWith("/assets/") &&
      !currentRuntimeAssets.has(entry.url),
  );
  const unexplainedRemovals = cacheEntryMultisetDifference(
    removed,
    retiredRuntimeDeletions,
  );
  return {
    added,
    requiredAfter,
    requiredBefore,
    requiredSubsetUnchanged: requiredBefore.sha256 === requiredAfter.sha256,
    retiredRuntimeDeletions,
    unexplainedRemovals,
  };
}

function validRequiredOfflineCacheSnapshot(snapshot, currentJsepPath) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.entries) ||
    typeof currentJsepPath !== "string" ||
    !currentJsepPath.startsWith("/assets/") ||
    snapshot.entries.length !==
      EXPECTED_MODEL_CACHE_ENTRIES + EXPECTED_VOICE_CACHE_ENTRIES + 1
  ) {
    return false;
  }
  const entryIdentities = new Set();
  for (const entry of snapshot.entries) {
    if (
      !entry ||
      Object.keys(entry).sort().join(",") !==
        "byteLength,cacheName,requestSha256,sha256,url" ||
      !Number.isInteger(entry.byteLength) ||
      entry.byteLength <= 0 ||
      ![MODEL_CACHE_NAME, RUNTIME_CACHE_NAME, VOICE_CACHE_NAME].includes(
        entry.cacheName,
      ) ||
      !isCanonicalCachePathname(entry.url) ||
      !/^[a-f\d]{64}$/u.test(entry.requestSha256) ||
      !/^[a-f\d]{64}$/u.test(entry.sha256)
    ) {
      return false;
    }
    const identity = cacheEntryIdentity(entry);
    if (entryIdentities.has(identity)) return false;
    entryIdentities.add(identity);
  }
  const recomputed = requiredOfflineCacheSnapshot(
    { entries: snapshot.entries },
    currentJsepPath,
  );
  return (
    snapshot.modelEntries === EXPECTED_MODEL_CACHE_ENTRIES &&
    snapshot.voiceEntries === EXPECTED_VOICE_CACHE_ENTRIES &&
    snapshot.currentJsepEntries === 1 &&
    snapshot.sha256 === recomputed.sha256 &&
    JSON.stringify(snapshot.entries) === JSON.stringify(recomputed.entries) &&
    snapshot.modelEntries === recomputed.modelEntries &&
    snapshot.voiceEntries === recomputed.voiceEntries &&
    snapshot.currentJsepEntries === recomputed.currentJsepEntries
  );
}

async function runtimeAssetManifest(cdp, appOrigin) {
  const manifest = await evaluate(
    cdp,
    `(async () => {
      const response = await fetch("/runtime-assets.json", { cache: "no-store" });
      if (!response.ok) return null;
      return response.json();
    })()`,
  );
  if (
    !manifest ||
    typeof manifest.deploymentId !== "string" ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length === 0 ||
    manifest.assets.length > 512
  ) {
    throw new Error("The production runtime-asset manifest is invalid.");
  }
  const assetPaths = manifest.assets.map((asset) => {
    const parsed = new URL(asset, appOrigin);
    if (
      parsed.origin !== appOrigin ||
      !parsed.pathname.startsWith("/assets/")
    ) {
      throw new Error(
        "The production runtime-asset manifest is not same-origin.",
      );
    }
    return parsed.pathname;
  });
  const normalized = [...new Set(assetPaths)].sort();
  if (normalized.length !== assetPaths.length) {
    throw new Error(
      "The production runtime-asset manifest has duplicate assets.",
    );
  }
  return {
    assetPaths: normalized,
    deploymentId: manifest.deploymentId,
    sha256: hashDiagnostic(JSON.stringify(normalized)),
  };
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
  const rootsBefore = new Set(before.activeOfflineSpeechWorkerSessionIds);
  const pthreadsBefore = new Set(
    before.activeNestedPthreadWorkerAncestry.map(
      ({ rootSessionId, sessionId }) => `${rootSessionId}\0${sessionId}`,
    ),
  );
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
  const relevantSessionsDetached = () => {
    const detachedRoots = new Set(
      after.detachedOfflineSpeechWorkerSessionIds,
    );
    const detachedPthreads = new Set(
      after.detachedNestedPthreadWorkerAncestry.map(
        ({ rootSessionId, sessionId }) => `${rootSessionId}\0${sessionId}`,
      ),
    );
    return {
      pthreads: [...pthreadsBefore].every((entry) =>
        detachedPthreads.has(entry),
      ),
      roots: [...rootsBefore].every((entry) => detachedRoots.has(entry)),
    };
  };
  let detached = relevantSessionsDetached();
  while (
    Date.now() - startedAt < 30_000 &&
    (after.activeOfflineSpeechWorkers !== 0 ||
      after.activeNestedPthreadWorkers !== 0 ||
      !detached.roots ||
      !detached.pthreads)
  ) {
    await delay(25);
    after = observation.targetCoverage();
    detached = relevantSessionsDetached();
  }
  await observation.settle({ quietMs: 400, timeoutMs: 30_000 });
  after = observation.targetCoverage();
  detached = relevantSessionsDetached();
  const detachedRootHashes = [...rootsBefore]
    .filter((entry) =>
      after.detachedOfflineSpeechWorkerSessionIds.includes(entry),
    )
    .map(hashDiagnostic)
    .sort();
  const detachedPthreadHashes = [...pthreadsBefore]
    .filter((entry) =>
      after.detachedNestedPthreadWorkerAncestry.some(
        ({ rootSessionId, sessionId }) =>
          entry === `${rootSessionId}\0${sessionId}`,
      ),
    )
    .map(hashDiagnostic)
    .sort();
  return {
    activePthreadWorkers: after.activeNestedPthreadWorkers,
    activeSpeechWorkers: after.activeOfflineSpeechWorkers,
    narrationStopped:
      after.activeOfflineSpeechWorkers === 0 &&
      after.activeNestedPthreadWorkers === 0 &&
      detached.roots &&
      detached.pthreads,
    networkSettled:
      observation.outstandingRequests.size === 0 &&
      observation.attachPromises.size === 0,
    pthreadAncestryHashesBefore: [...pthreadsBefore]
      .map(hashDiagnostic)
      .sort(),
    pthreadAncestryHashesDetached: detachedPthreadHashes,
    pthreadWorkersDetached:
      after.nestedPthreadWorkersDetached -
      before.nestedPthreadWorkersDetached,
    pthreadWorkersDetachedTotal: after.nestedPthreadWorkersDetached,
    pthreadWorkersObserved: after.nestedPthreadWorkersAttached,
    rootSessionHashesBefore: [...rootsBefore].map(hashDiagnostic).sort(),
    rootSessionHashesDetached: detachedRootHashes,
    speechWorkersDetached:
      after.speechWorkersDetached - before.speechWorkersDetached,
    speechWorkersDetachedTotal: after.speechWorkersDetached,
    speechWorkersObserved: after.offlineSpeechWorkersAttached,
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
        if (synthesisTerminalForRequest(state, request)) continue;
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

async function prepareFarSeekReset({
  cdp,
  excludedIds,
  originalIdentity,
  preparedState,
  timeoutMs,
}) {
  const preparedSnapshotSequence = nextEventSequence(preparedState);
  const reset = await evaluate(
    cdp,
    `globalThis.__lineLightIssue55.resetForFarSeek(
      ${JSON.stringify(FAR_SEEK_RESET_ANCHOR_KIND)},
      ${FAR_SEEK_RESET_ANCHOR_ORDINAL}
    )`,
  );
  const preResetRequests = reset.requests;
  if (
    !preResetRequests.length ||
    reset.requestBoundarySequence < preparedSnapshotSequence
  ) {
    throw new Error("The far-seek reset lacks a valid prior request boundary.");
  }
  await waitForExpression(
    cdp,
    `document.querySelector(".play-button")?.getAttribute("aria-label") === "Play narration"`,
    "the reset narration transport",
    timeoutMs,
  );
  const settled = await waitForBrowserState(
    cdp,
    (state) => {
      const terminals = preResetRequests.map((request) =>
        synthesisTerminalForRequest(state, request),
      );
      return terminals.every(Boolean) ? { terminals } : null;
    },
    "all requests preceding the far-seek reset to reach terminal state",
    timeoutMs,
  );
  const errorTerminals = settled.result.terminals.filter(
    (terminal) => terminal.type === "error",
  );
  if (errorTerminals.length) {
    throw new Error("A request preceding the far-seek reset failed.");
  }
  const openTerminals = settled.result.terminals.filter(
    (terminal) => terminal.sequence > reset.requestBoundarySequence,
  );
  const boundarySequence = nextEventSequence(settled.state);
  const current = await startNarration(cdp, timeoutMs);
  const currentStart = current.state.workerEvents.find(
    (entry) =>
      entry.direction === "in" &&
      entry.type === "wasm-run-start" &&
      entry.id === current.request.id &&
      entry.epoch === current.request.epoch &&
      entry.sequence > current.request.sequence,
  );
  if (
    !currentStart ||
    current.request.sequence <= boundarySequence ||
    current.success.sequence <= currentStart.sequence ||
    current.audio.event.atMs <= current.success.atMs ||
    excludedIds.includes(current.request.id) ||
    preResetRequests.some(
      (request) =>
        request.id === current.request.id &&
        request.epoch === current.request.epoch,
    )
  ) {
    throw new Error(
      "The far-seek reset did not produce a new uncached current synthesis after its terminal boundary.",
    );
  }
  if (
    currentStart.epoch !== originalIdentity.workerEpoch ||
    currentStart.sessionGeneration !== originalIdentity.sessionGeneration
  ) {
    throw new Error("The far-seek reset replaced the warm worker or session.");
  }

  const active = await waitForActiveSpeculation(cdp, {
    afterSequence: current.success.sequence,
    excludeIds: [
      ...excludedIds,
      ...preResetRequests.map((request) => request.id),
      current.request.id,
    ],
    timeoutMs,
  });
  if (
    active.request.sequence <= current.success.sequence ||
    active.request.atMs <= current.audio.event.atMs ||
    active.start.atMs <= current.audio.event.atMs ||
    active.request.id === current.request.id ||
    active.start.epoch !== originalIdentity.workerEpoch ||
    active.start.sessionGeneration !== originalIdentity.sessionGeneration
  ) {
    throw new Error(
      "The far-seek lookahead was not a new active run after current audio reached playing.",
    );
  }

  return {
    active,
    current,
    evidence: {
      actionAtMs: reset.action.atMs,
      actionWallTimeMs: reset.action.wallTimeMs,
      anchor: reset.anchor,
      boundarySequence,
      currentAudioPlayingAtMs: current.audio.event.atMs,
      currentRequestAtMs: current.request.atMs,
      currentRequestId: current.request.id,
      currentRequestSequence: current.request.sequence,
      currentRunStartAtMs: currentStart.atMs,
      currentRunStartSequence: currentStart.sequence,
      currentSessionGeneration: currentStart.sessionGeneration,
      currentSuccessAtMs: current.success.atMs,
      currentSuccessSequence: current.success.sequence,
      currentSynthesisRequested: true,
      currentWorkerEpoch: currentStart.epoch,
      lookaheadRequestAtMs: active.request.atMs,
      lookaheadRequestId: active.request.id,
      lookaheadRequestSequence: active.request.sequence,
      lookaheadRunStartAtMs: active.start.atMs,
      lookaheadRunStartSequence: active.start.sequence,
      lookaheadSessionGeneration: active.start.sessionGeneration,
      lookaheadWorkerEpoch: active.start.epoch,
      preResetOpenRequestCount: openTerminals.length,
      preResetOpenTerminalCount: openTerminals.length,
      preResetErrorTerminalCount: errorTerminals.length,
      preResetMaxRequestId: Math.max(
        ...preResetRequests.map((request) => request.id),
      ),
      preResetPreparedSnapshotSequence: preparedSnapshotSequence,
      preResetRequestBoundarySequence: reset.requestBoundarySequence,
      preResetRequestCount: preResetRequests.length,
    },
  };
}

async function runThreadedWasmScenario({
  cdp,
  cpuSampler,
  clockTicksPerSecond,
  currentJsepPath,
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
    (state) => {
      const audio = state.audio.find(
        (audio) =>
          audio.id !== currentAudioId &&
          audio.sourceBlobId &&
          Number.isInteger(audio.sourceRequestId) &&
          audio.createdAtMs >= followupSuccess.result.atMs,
      );
      if (!audio) return null;
      const request = state.workerEvents.find(
        (entry) =>
          entry.direction === "out" &&
          entry.type === "synthesize" &&
          entry.id === audio.sourceRequestId &&
          entry.epoch === audio.sourceWorkerEpoch,
      );
      const success = state.workerEvents.find(
        (entry) =>
          entry.direction === "in" &&
          entry.type === "success" &&
          entry.id === audio.sourceRequestId &&
          entry.epoch === audio.sourceWorkerEpoch &&
          entry.sessionGeneration === audio.sourceSessionGeneration,
      );
      return request && success && success.atMs <= audio.createdAtMs
        ? { audio, request, success }
        : null;
    },
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
        (candidate) => candidate.id === preparedAudio.result.audio.id,
      );
      const playing = audio?.events.find(
        (entry) => entry.name === "playing" && entry.atMs > boundaryAction.atMs,
      );
      return playing ? { audio, playing } : null;
    },
    "the exact pre-Pause lookahead audio to play",
    timeoutMs,
  );
  const synthesisBeforePreparedPlayback =
    preparedPlayed.state.workerEvents.filter(
      (entry) =>
        entry.direction === "out" &&
        entry.type === "synthesize" &&
        entry.atMs > preparedPause.atMs &&
        entry.atMs < preparedPlayed.result.playing.atMs,
    );
  const duplicatePreparedSynthesisRequests =
    preparedPlayed.state.workerEvents.filter(
      (entry) =>
        entry.direction === "out" &&
        entry.type === "synthesize" &&
        entry.id === preparedAudio.result.request.id &&
        entry.epoch === preparedAudio.result.request.epoch &&
        entry.sequence > preparedAudio.result.request.sequence,
    );
  const preparedTerminalAfterSuccess = preparedPlayed.state.workerEvents.find(
    (entry) =>
      entry.direction === "in" &&
      entry.id === preparedAudio.result.request.id &&
      entry.epoch === preparedAudio.result.request.epoch &&
      entry.sequence > preparedAudio.result.success.sequence &&
      ["canceled", "error"].includes(entry.type),
  );
  const preparedResumeEvidence = {
    audioCreatedAtMs: preparedAudio.result.audio.createdAtMs,
    audioCreatedBeforePause:
      preparedAudio.result.audio.createdAtMs < preparedPause.atMs,
    audioId: preparedAudio.result.audio.id,
    discarded: Boolean(preparedTerminalAfterSuccess),
    duplicatePreparedSynthesisRequests:
      duplicatePreparedSynthesisRequests.length,
    interveningDistinctRequestIds: synthesisBeforePreparedPlayback
      .filter(
        (entry) =>
          entry.id !== preparedAudio.result.request.id ||
          entry.epoch !== preparedAudio.result.request.epoch,
      )
      .map((entry) => entry.id),
    pauseAtMs: preparedPause.atMs,
    playedAtMs: preparedPlayed.result.playing.atMs,
    requestAtMs: preparedAudio.result.request.atMs,
    requestId: preparedAudio.result.request.id,
    requestSequence: preparedAudio.result.request.sequence,
    requestSessionGeneration: preparedAudio.result.success.sessionGeneration,
    requestSucceededAtMs: preparedAudio.result.success.atMs,
    requestSuccessSequence: preparedAudio.result.success.sequence,
    requestWorkerEpoch: preparedAudio.result.request.epoch,
    resumedCurrentAtMs: preparedResume.event.atMs,
    sameAudioPlayed:
      preparedPlayed.result.audio.id === preparedAudio.result.audio.id,
    snapshotSequence: nextEventSequence(preparedPlayed.state),
    success: true,
  };

  const reset = await prepareFarSeekReset({
    cdp,
    excludedIds: [...excludedIds, followupActive.request.id],
    originalIdentity: {
      sessionGeneration: first.sessionGeneration,
      workerEpoch: first.workerEpoch,
    },
    preparedState: preparedPlayed.state,
    timeoutMs,
  });
  const seekDiscard = reset.active;
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
  const discardedTerminalBeforeAction = crossing.state.workerEvents.some(
    (entry) =>
      entry.id === seekDiscard.request.id &&
      entry.epoch === seekDiscard.start.epoch &&
      entry.atMs < crossing.action.atMs &&
      ["wasm-run-end", "success", "error", "canceled"].includes(entry.type),
  );
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
    discardedRunProvenActive:
      seekDiscard.start.atMs <= crossing.action.atMs &&
      !discardedTerminalBeforeAction,
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
          entry.id === crossing.targetRequest.id &&
          entry.epoch === farSeekState.result.targetStart.epoch &&
          entry.sessionGeneration ===
            farSeekState.result.targetStart.sessionGeneration,
      ),
    "far-seek target synthesis success",
    timeoutMs,
  );
  const targetPlaying = await waitForBrowserState(
    cdp,
    (state) =>
      latestNarrationAudioPlayingForSource(
        state,
        {
          requestId: crossing.targetRequest.id,
          sessionGeneration:
            farSeekState.result.targetStart.sessionGeneration,
          workerEpoch: farSeekState.result.targetStart.epoch,
        },
        targetSuccess.result.atMs,
      ),
    "far-seek target audio to reach playing",
    timeoutMs,
  );
  farSeek.targetAudioId = targetPlaying.result.audio.id;
  farSeek.targetAudioPlayingAtMs = targetPlaying.result.event.atMs;
  farSeek.targetAudioSourceRequestId =
    targetPlaying.result.audio.sourceRequestId;
  farSeek.targetAudioSourceSessionGeneration =
    targetPlaying.result.audio.sourceSessionGeneration;
  farSeek.targetAudioSourceWorkerEpoch =
    targetPlaying.result.audio.sourceWorkerEpoch;
  farSeek.targetAudioLatencyMs =
    targetPlaying.result.event.atMs - crossing.action.atMs;
  const resetPhaseEvents = targetPlaying.state.workerEvents.filter(
    (entry) => entry.atMs >= reset.evidence.actionAtMs,
  );
  farSeek.reset = {
    ...reset.evidence,
    backendChanges: resetPhaseEvents.filter(
      (entry) =>
        entry.backendDevice !== null &&
        (entry.backendDevice !== initial.success.backendDevice ||
          entry.wasmThreads !== initial.success.wasmThreads),
    ).length,
    modelRequests: countModelRequests(
      networkRequests,
      reset.evidence.actionWallTimeMs,
      targetPlaying.result.event.wallTimeMs,
    ),
    sessionIdentityChanges: resetPhaseEvents.filter(
      (entry) =>
        entry.type === "wasm-run-start" &&
        (entry.epoch !== first.workerEpoch ||
          entry.sessionGeneration !== first.sessionGeneration),
    ).length,
    workerTerminations: resetPhaseEvents.filter(
      (entry) => entry.type === "worker-terminated",
    ).length,
  };

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
  const timeoutCacheBefore = requiredOfflineCacheSnapshot(
    await cacheInventory(cdp),
    currentJsepPath,
  );
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
  const timeoutCacheAfter = requiredOfflineCacheSnapshot(
    await cacheInventory(cdp),
    currentJsepPath,
  );
  const finalTimeoutState = recovery.state;
  const forcedState = finalTimeoutState.forcedTimeout;
  const timeoutRecovery = {
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
    requiredCacheAfter: timeoutCacheAfter,
    requiredCacheBefore: timeoutCacheBefore,
    requiredCacheSubsetUnchanged:
      timeoutCacheBefore.sha256 === timeoutCacheAfter.sha256,
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
    const expectedJsepWasmPath = `/${artifact.jsepWasmPath.replace(
      /^dist\/client\//u,
      "",
    )}`;
    const page = await configurePage(cdp, appUrl, expectedWorkerUrl);
    await page.settle();
    const currentRuntimeManifest = await runtimeAssetManifest(
      cdp,
      new URL(appUrl).origin,
    );
    if (
      !currentRuntimeManifest.assetPaths.includes(expectedJsepWasmPath) ||
      !currentRuntimeManifest.assetPaths.includes(
        new URL(expectedWorkerUrl).pathname,
      )
    ) {
      throw new Error(
        "The production runtime manifest does not bind the reviewed worker and JSEP Wasm.",
      );
    }
    cpuSampler = startCpuSampler(browser.processGroupId);
    const isolation = {
      ...targetBaseline,
      sessionRestorePurged: profileClone.sessionRestorePurged,
    };
    page.setObservationPhase("threaded-wasm");
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
      currentJsepPath: expectedJsepWasmPath,
      networkRequests: page.networkRequests,
      timeoutMs: options.timeoutMs,
    });
    const { cacheBaseline: cacheBefore, ...threadedWasm } = threadedResult;
    await page.settle();
    await assertBrowserStateHealthy(cdp, "the completed threaded-WASM matrix");

    page.setObservationPhase("single-thread-wasm");
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
      page.setObservationPhase("webgpu");
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
      page.setObservationPhase("webgpu-fallback");
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

    await assertBrowserStateHealthy(cdp, "the completed WebGPU matrix");

    page.setObservationPhase("final-quiesce");
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
    await page.settle({ quietMs: 400, timeoutMs: 30_000 });
    const finalBrowserState = await browserSnapshot(cdp);
    const cacheAfter = await stableCacheInventory(cdp);
    const cacheTransition = analyzeOfflineCacheTransition(
      cacheBefore,
      cacheAfter,
      {
        currentJsepPath: expectedJsepWasmPath,
        currentRuntimeAssetPaths: currentRuntimeManifest.assetPaths,
      },
    );
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
    const attachFailureClassification = page.attachFailureClassification();
    execution = {
      artifact,
      browserDiagnostics: {
        consoleDiagnostics: summarizeConsoleDiagnostics(page.consoleEntries),
        consoleErrors: summarizeConsoleDiagnostics(
          page.consoleEntries.filter((entry) =>
            ["error", "assert"].includes(entry.severity),
          ),
        ),
        errors: finalBrowserState.errors.map((error) => ({
          code: "browser-runtime-error",
          sha256: hashDiagnostic(error),
        })),
        runtimeExceptions: summarizeConsoleDiagnostics(
          page.runtimeExceptionEntries,
        ),
      },
      cache: {
        after: cacheAfter,
        before: cacheBefore,
        currentRuntimeManifest,
        transition: cacheTransition,
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
        loadingFailures: page.networkFailures,
        nonLoopbackRequests,
        observedRequestCount: page.networkRequests.length,
        offlineSpeechWorkerAttached: targetCoverage.offlineSpeechWorkerAttached,
        nestedPthreadWorkersAttached:
          targetCoverage.nestedPthreadWorkersAttached,
        orphanedOfflineWorkerTargets:
          targetCoverage.orphanedOfflineWorkerTargets,
        outstandingAttachPromises: page.attachPromises.size,
        outstandingRequests: page.outstandingRequests.size,
        responseFailures: page.responseFailures,
        serviceWorkerBypassed: page.serviceWorkerBypassed,
        serviceWorkerLifecycle: page.serviceWorkerLifecycle,
        intentionalServiceWorkerUnregisterRaces:
          attachFailureClassification.intentionalServiceWorkerUnregisterRaces,
        sameUrlNestedPthreadWorkersAttached:
          targetCoverage.sameUrlNestedPthreadWorkersAttached,
        targetBootstrapSettlements: page.targetBootstrapSettlements,
        targetCounts: Object.fromEntries(
          [...new Set(page.targets.map((target) => target.type))]
            .sort()
            .map((type) => [
              type,
              page.targets.filter((target) => target.type === type).length,
            ]),
        ),
        unexplainedAttachFailures: attachFailureClassification.unexplained,
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
