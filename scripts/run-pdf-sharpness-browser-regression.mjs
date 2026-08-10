#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import { createPdfPageStore } from "../app/pdf-page-store.mjs";
import {
  DEFAULT_PDF_HIGHLIGHT_FIXTURE,
} from "./generate-pdf-highlight-fixture.mjs";
import {
  CdpSession,
  delay,
  evaluate,
  importFixture,
  selectFixtureFile,
  startBrowser,
  stopProcessGroup,
  waitForExpression,
} from "./run-pdf-highlight-browser-regression.mjs";
import {
  PDF_SHARPNESS_MATRIX,
  PDF_SHARPNESS_MAX_BITMAP_COUNT,
  PDF_SHARPNESS_MAX_BITMAP_PIXELS,
  PDF_SHARPNESS_REFERENCE_MAX_INK_RATIO,
  PDF_SHARPNESS_REFERENCE_MIN_INK_PIXELS,
  PDF_SHARPNESS_REFERENCE_MIN_INK_SPAN_RATIO,
  PDF_SHARPNESS_REFERENCE_MIN_INK_ROW_BANDS,
  PDF_SHARPNESS_REFERENCE_MIN_WHITE_RATIO,
  PDF_SHARPNESS_SCHEMA_VERSION,
  PDF_SHARPNESS_SOURCE_FILES,
  validatePdfSharpnessEvidence,
} from "./pdf-sharpness-evidence.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_OUTPUT_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "outputs/issue-68-pdf-sharpness",
);
const RECORDED_OUTPUT_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "docs/evidence/issue-68",
);
const LOCAL_RUNTIME_MANIFEST = path.join(
  REPOSITORY_ROOT,
  "dist/client/runtime-assets.json",
);
const BUILD_TIMEOUT_MS = 300_000;
const SERVER_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const PDF_VIRTUAL_SCROLL_MAX_STEPS = 120;
const CDP_FIXED_POINT_STABLE_SAMPLES = 3;
const CDP_CHILD_COMMAND_TIMEOUT_MS = 5_000;
const FALLBACK_IMPORT_DIAGNOSTIC_TIMEOUT_MS = 60_000;
const FALLBACK_IMPORT_DIAGNOSTIC_RUN_TIMEOUT_MS = 180_000;
const FALLBACK_IMPORT_DIAGNOSTIC_LABEL = "fallback-import-diagnostic";
const FALLBACK_IMPORT_DIAGNOSTIC_SCREENSHOT =
  "linelight-fallback-import-diagnostic.png";
const REFERENCE_CAPTURE_DIAGNOSTIC_TIMEOUT_MS = 120_000;
const REFERENCE_CAPTURE_DIAGNOSTIC_TARGET_PAGE = 2;
const REFERENCE_CAPTURE_DIAGNOSTIC_REPORT =
  "pdf-sharpness-reference-capture-diagnostic.json";
export const REFERENCE_CAPTURE_DIAGNOSTIC_CANDIDATES = Object.freeze([
  "reference-capture-candidate-1.png",
  "reference-capture-candidate-2.png",
]);
export const REFERENCE_CAPTURE_DIAGNOSTIC_STEPS = Object.freeze([
  "browser-launch",
  "cdp-connect",
  "configure",
  "navigate",
  "viewer-ready",
  "stable-candidates",
  "source-finalize",
]);
export const REFERENCE_CAPTURE_DIAGNOSTIC_STAGES = Object.freeze(
  REFERENCE_CAPTURE_DIAGNOSTIC_STEPS.flatMap((step) => [
    `${step}-started`,
    `${step}-completed`,
  ]),
);
export const FALLBACK_IMPORT_DIAGNOSTIC_STEPS = Object.freeze([
  "connect",
  "baseline",
  "configure",
  "setup-navigate",
  "setup-file-select",
  "setup-source-hash",
  "setup-model-completion",
  "setup-library-snapshot",
  "setup-fixed-point",
  "fallback-navigate",
  "fallback-file-select",
  "fallback-chain",
  "fallback-network",
  "fallback-screenshot",
]);
export const FALLBACK_IMPORT_DIAGNOSTIC_STAGES = Object.freeze(
  FALLBACK_IMPORT_DIAGNOSTIC_STEPS.flatMap((step) => [
    `${step}-started`,
    `${step}-completed`,
  ]),
);
const PUBLIC_PDF_FIXTURE_BYTES = 4_745;
const PUBLIC_PDF_FIXTURE_SHA256 =
  "1addfceae4b869eec37dae4755d576ccd0fd7e1ce505dc856da3b96acbf3f06c";
const CDP_WORKER_TARGET_TYPES = new Set([
  "service_worker",
  "shared_worker",
  "worker",
]);

export function createReferenceCaptureDiagnosticProgress() {
  return { history: [], terminalStage: null };
}

export function markReferenceCaptureDiagnosticStage(progress, stage) {
  if (!progress || !Array.isArray(progress.history)) {
    throw new Error("Reference-capture diagnostic progress is unavailable.");
  }
  const expected = REFERENCE_CAPTURE_DIAGNOSTIC_STAGES[progress.history.length];
  if (stage !== expected) {
    throw new Error("Reference-capture diagnostic stage ordering is invalid.");
  }
  progress.history.push(stage);
  progress.terminalStage = stage;
  return stage;
}

async function runReferenceCaptureDiagnosticStage(progress, step, operation) {
  markReferenceCaptureDiagnosticStage(progress, `${step}-started`);
  const result = await operation();
  markReferenceCaptureDiagnosticStage(progress, `${step}-completed`);
  return result;
}

export function createFallbackImportDiagnosticProgress() {
  return { history: [], terminalStage: null };
}

export function markFallbackImportDiagnosticStage(progress, stage) {
  if (!progress || !Array.isArray(progress.history)) {
    throw new Error("Fallback diagnostic progress is unavailable.");
  }
  const expected = FALLBACK_IMPORT_DIAGNOSTIC_STAGES[progress.history.length];
  if (stage !== expected) {
    throw new Error("Fallback diagnostic stage ordering is invalid.");
  }
  progress.history.push(stage);
  progress.terminalStage = stage;
  return stage;
}

export function buildFallbackWorkerModuleSource(
  resolvedWorkerUrl,
  workerInstanceId,
) {
  if (
    typeof resolvedWorkerUrl !== "string" ||
    !resolvedWorkerUrl ||
    !Number.isInteger(workerInstanceId) ||
    workerInstanceId <= 0
  ) {
    throw new Error("Fallback worker identity is invalid.");
  }
  let absoluteWorkerUrl;
  try {
    absoluteWorkerUrl = new URL(resolvedWorkerUrl);
  } catch {
    throw new Error("Fallback worker identity is invalid.");
  }
  if (!["http:", "https:"].includes(absoluteWorkerUrl.protocol)) {
    throw new Error("Fallback worker identity is invalid.");
  }
  const serializedWorkerUrl = JSON.stringify(absoluteWorkerUrl.href);
  return [
    "import " + serializedWorkerUrl + ";",
    "const NativeNestedWorker = globalThis.Worker;",
    "globalThis.Worker = new Proxy(NativeNestedWorker, {",
    "  construct(target, args, newTarget) {",
    "    if (args.length === 0) return Reflect.construct(target, args, newTarget);",
    "    const [url, ...rest] = args;",
    "    const resolved = new URL(url, " + serializedWorkerUrl + ");",
    "    return Reflect.construct(target, [resolved, ...rest], newTarget);",
    "  }",
    "});",
    "try { Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: undefined }); } catch {}",
    "console.debug('__linelight_issue68_worker__', " + workerInstanceId + ");",
  ].join("\n");
}

async function runFallbackImportDiagnosticStage(progress, step, operation) {
  markFallbackImportDiagnosticStage(progress, `${step}-started`);
  const result = await operation();
  markFallbackImportDiagnosticStage(progress, `${step}-completed`);
  return result;
}

export async function runBoundedDiagnosticOperation(
  operation,
  { onTimeout = () => {}, timeoutMs },
) {
  if (typeof operation !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("A bounded diagnostic requires an operation and timeout.");
  }
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        Promise.resolve(onTimeout()).catch(() => {});
      } catch {
        // The fixed timeout result still drives the owned finally cleanup.
      }
      reject(new Error("The bounded fallback-import diagnostic timed out."));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function validateCdpInitialTargetBaseline(targetInfos) {
  const targets = Array.isArray(targetInfos) ? targetInfos : [];
  const pages = targets.filter((target) => target?.type === "page");
  const workers = targets.filter((target) =>
    CDP_WORKER_TARGET_TYPES.has(target?.type)
  );
  if (
    pages.length !== 1 ||
    pages[0]?.url !== "about:blank" ||
    workers.length !== 0 ||
    targets.length !== 1
  ) {
    throw new Error(
      "Issue #68 requires one clean about:blank page and no preexisting worker targets.",
    );
  }
  return {
    checked: true,
    pageCount: 1,
    pageUrlClass: "about",
    targetCount: targets.length,
    workerCount: 0,
  };
}

export function summarizePdfModelCompletion(workerEvents, expectedPageCount) {
  const events = workerEvents ?? [];
  const importRequests = events.filter(
    (event) =>
      event?.direction === "to-worker" &&
      event?.type === "import",
  );
  const importRequestsValid = importRequests.every(
    (event) =>
      Number.isFinite(event?.at) &&
      Number.isInteger(event?.jobId) &&
      typeof event?.documentKey === "string" &&
      event.documentKey.length > 0 &&
      typeof event?.revision === "string" &&
      event.revision.length > 0,
  );
  const importRequest = importRequestsValid
    ? [...importRequests].sort((left, right) => left.at - right.at).at(-1)
    : null;
  const expectedPages = Array.from(
    { length: expectedPageCount },
    (_, index) => index + 1,
  );
  const matchesImport = (event) =>
    Boolean(importRequest) &&
    event?.at >= importRequest.at &&
    event?.jobId === importRequest.jobId &&
    event?.revision === importRequest.revision;
  const pageEvents = events.filter(
    (event) =>
      event?.direction === "from-worker" &&
      event?.type === "page" &&
      Number.isInteger(event?.pageNumber) &&
      event?.documentKey === importRequest?.documentKey &&
      matchesImport(event),
  );
  const pageNumbers = [...new Set(pageEvents.map((event) => event.pageNumber))]
    .sort((left, right) => left - right);
  const progressEvents = events.filter(
    (event) =>
      event?.direction === "from-worker" &&
      event?.type === "progress" &&
      event?.completedPages === expectedPageCount &&
      event?.pageCount === expectedPageCount &&
      matchesImport(event),
  );
  const completeEvents = events.filter(
    (event) =>
      event?.direction === "from-worker" &&
      event?.type === "complete" &&
      event?.documentKey === importRequest?.documentKey &&
      event?.pageCount === expectedPageCount &&
      matchesImport(event),
  );
  const completion = completeEvents[0];
  const expectedPageKey = expectedPages.join(",");
  const pageNumberKey = pageNumbers.join(",");
  const identityBound = importRequestsValid && Boolean(importRequest) &&
    typeof completion?.documentKey === "string" &&
    completion.documentKey.length > 0 &&
    typeof completion?.revision === "string" &&
    completion.revision.length > 0 &&
    pageEvents.every(
      (event) =>
        event.documentKey === completion.documentKey &&
        event.revision === completion.revision,
    );
  return {
    complete:
      Number.isInteger(expectedPageCount) &&
      expectedPageCount > 0 &&
      pageEvents.length === expectedPageCount &&
      pageNumberKey === expectedPageKey &&
      progressEvents.length === 1 &&
      completeEvents.length === 1 &&
      identityBound,
    completeEventCount: completeEvents.length,
    completedProgressCount: progressEvents.length,
    documentKey: completion?.documentKey ?? null,
    importAt: importRequest?.at ?? null,
    importJobId: importRequest?.jobId ?? null,
    importRequestCount: importRequests.length,
    pageEventCount: pageEvents.length,
    pageNumbers,
    revision: completion?.revision ?? null,
  };
}

const PDF_FALLBACK_DIAGNOSTIC_EVENT_TYPES = new Set([
  "abort-signal-registered",
  "cancel-request",
  "continuation-armed",
  "continuation-delay",
  "continuation-minimum-elapsed",
  "continuation-resume",
  "staging-finish",
  "staging-start",
  "viewport-exit",
  "viewport-exit-request",
]);
const PDF_FALLBACK_DIAGNOSTIC_STAGES = new Set([
  "viewport-exit-request",
  "page-traversal",
  "cancellation-ready",
  "viewport-exit-confirmation",
  "minimum-elapsed",
  "continuation-resume",
]);

/**
 * Reduce a failed cancellation probe to fixed metadata. Document identities and
 * revisions are compared in memory but never copied into the failure artifact.
 */
export function summarizePdfFallbackCancellationDiagnostic(raw, expected) {
  const events = Array.isArray(raw?.events) ? raw.events : [];
  const expectedAttempt = Number(expected?.renderAttemptId);
  const expectedSignal = Number(expected?.abortSignalId);
  const expectedPage = Number(expected?.page);
  const matchesDocument = (event) =>
    typeof expected?.documentKey === "string" &&
    event?.documentKey === expected.documentKey;
  const matchesRevision = (event) =>
    typeof expected?.revision === "string" &&
    event?.revision === expected.revision;
  const relatedEvents = events.filter((event) => {
    if (!PDF_FALLBACK_DIAGNOSTIC_EVENT_TYPES.has(event?.type)) return false;
    if (event?.renderAttemptId === expectedAttempt) return true;
    if (event?.abortSignalId === expectedSignal) return true;
    return (
      event?.page === expectedPage &&
      matchesDocument(event) &&
      matchesRevision(event)
    );
  });
  const sanitizeNumber = (value) =>
    Number.isFinite(value) ? Number(value) : null;
  const sanitizeInteger = (value) =>
    Number.isInteger(value) ? Number(value) : null;
  const sanitizeOutcome = (value) =>
    ["cancelled", "injected-failure", "released"].includes(value)
      ? value
      : null;
  const sanitizedEvents = relatedEvents.map((event) => ({
    abortSignalId: sanitizeInteger(event?.abortSignalId),
    afterMs: sanitizeNumber(event?.afterMs),
    at: sanitizeNumber(event?.at),
    cancelRequestedAt: sanitizeNumber(event?.cancelRequestedAt),
    canvasHeight: sanitizeInteger(event?.canvasHeight),
    canvasPresent:
      typeof event?.canvasPresent === "boolean" ? event.canvasPresent : null,
    canvasWidth: sanitizeInteger(event?.canvasWidth),
    candidateCount: sanitizeInteger(event?.abortSignalCandidateCount),
    delay: sanitizeNumber(event?.delay),
    documentMatches: matchesDocument(event),
    outcome: sanitizeOutcome(event?.outcome),
    page: sanitizeInteger(event?.page),
    pageMatches: event?.page === expectedPage,
    renderAttemptId: sanitizeInteger(event?.renderAttemptId),
    revisionMatches: matchesRevision(event),
    signalMatches: event?.abortSignalId === expectedSignal,
    textOverlayCount: sanitizeInteger(event?.textOverlayCount),
    type: event.type,
    visible: typeof event?.visible === "boolean" ? event.visible : null,
  }));
  const counts = Object.fromEntries(
    [...PDF_FALLBACK_DIAGNOSTIC_EVENT_TYPES].map((type) => [
      type,
      sanitizedEvents.filter((event) => event.type === type).length,
    ]),
  );
  const dom = raw?.dom ?? {};
  return {
    counts,
    dom: {
      blockPresent: dom?.blockPresent === true,
      canvasHeight: sanitizeInteger(dom?.canvasHeight),
      canvasPresent: dom?.canvasPresent === true,
      canvasWidth: sanitizeInteger(dom?.canvasWidth),
      textOverlayCount: sanitizeInteger(dom?.textOverlayCount),
      visible: typeof dom?.visible === "boolean" ? dom.visible : null,
    },
    events: sanitizedEvents,
    expected: {
      abortSignalId: sanitizeInteger(expectedSignal),
      page: sanitizeInteger(expectedPage),
      renderAttemptId: sanitizeInteger(expectedAttempt),
    },
    held: {
      attemptMatches: raw?.held?.renderAttemptId === expectedAttempt,
      minimumElapsed: raw?.held?.minimumElapsed === true,
      releaseRequested: Number.isFinite(raw?.held?.releaseRequestedAt),
      resumed: raw?.held?.resumed === true,
      signalMatches: raw?.held?.abortSignalId === expectedSignal,
    },
    stage: PDF_FALLBACK_DIAGNOSTIC_STAGES.has(expected?.stage)
      ? expected.stage
      : null,
  };
}

export function selectPdfLongTasksForWindow(
  entries,
  { finishedAt, startedAt },
) {
  if (
    !Array.isArray(entries) ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    finishedAt < startedAt
  ) {
    throw new TypeError("Long Task selection requires an array and a valid window.");
  }
  return entries.filter(
    (entry) =>
      !Number.isFinite(entry?.startTime) ||
      (entry.startTime >= startedAt && entry.startTime < finishedAt),
  );
}

export function classifyPdfRasterTransition(previewComposition, sharpTarget) {
  return previewComposition?.width === sharpTarget?.targetWidth &&
      previewComposition?.height === sharpTarget?.targetHeight &&
      Math.abs(
        Number(previewComposition?.scale) - Number(sharpTarget?.targetScale),
      ) <= 1e-7
    ? "preview-satisfied-target"
    : "preview-to-sharp-upgrade";
}

export function selectPdfFallbackScenarioEvents(
  fallbackEvents,
  { documentKey, revision, startedAt },
) {
  const scenarioEvents = (fallbackEvents ?? []).filter(
    (event) => Number.isFinite(event?.at) && event.at >= startedAt,
  );
  const signalIds = new Set(
    scenarioEvents
      .filter(
        (event) =>
          event.documentKey === documentKey &&
          event.revision === revision &&
          Number.isInteger(event.abortSignalId),
      )
      .map((event) => event.abortSignalId),
  );
  const events = scenarioEvents.filter(
    (event) =>
      (event.documentKey === documentKey && event.revision === revision) ||
      (Number.isInteger(event.abortSignalId) &&
        signalIds.has(event.abortSignalId)),
  );
  let active = 0;
  let maximumConcurrentStaging = 0;
  for (const event of events) {
    if (event.type === "staging-start") {
      active += 1;
      maximumConcurrentStaging = Math.max(maximumConcurrentStaging, active);
    } else if (event.type === "staging-finish") {
      active = Math.max(0, active - 1);
    }
  }
  return { events, maximumConcurrentStaging };
}

export function matchesPdfFallbackInjection(armed, attempt) {
  return Boolean(
    armed &&
    attempt &&
    typeof armed.documentKey === "string" &&
    armed.documentKey.length > 0 &&
    typeof armed.revision === "string" &&
    armed.revision.length > 0 &&
    Number.isInteger(armed.page) &&
    armed.page > 0 &&
    attempt.documentKey === armed.documentKey &&
    attempt.revision === armed.revision &&
    attempt.page === armed.page,
  );
}

export function selectPdfFallbackAbortCandidate(candidates) {
  const eligible = (candidates ?? []).filter(
    (candidate) =>
      candidate?.bound === false &&
      candidate?.retired === false &&
      typeof candidate?.signal?.aborted === "boolean" &&
      candidate.signal.aborted === false,
  );
  return {
    candidate: eligible.length === 1 ? eligible[0] : null,
    candidateCount: eligible.length,
  };
}

export function classifyCdpDiagnosticUrl(value, appUrl) {
  if (typeof value !== "string" || value.length === 0) return "other-local";
  if (value.startsWith("about:")) return "about";
  if (value.startsWith("data:")) return "data";
  if (value.startsWith("blob:")) return "blob";
  try {
    const parsed = new URL(value);
    const app = new URL(appUrl);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
      parsed.hostname,
    );
    if (parsed.origin !== app.origin) return loopback ? "other-local" : "external";
    if (/pdf-document\.worker-[^/]+\.js$/u.test(parsed.pathname)) {
      return "pdf-document-worker";
    }
    if (/pdf-parser\.worker-[^/]+\.js$/u.test(parsed.pathname)) {
      return "pdf-parser-worker";
    }
    if (parsed.pathname.startsWith("/assets/")) return "app-asset";
    if (parsed.pathname === "/" || parsed.pathname.endsWith(".html")) {
      return "page";
    }
    return "other-local";
  } catch {
    return "other-local";
  }
}

function cdpDiagnosticIdentity(...parts) {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}

function cdpRequestKey(requestId, sessionId) {
  return `${sessionId ?? "page"}:${requestId}`;
}

export function recordCdpNetworkRequest(networkState, event, sessionId) {
  const key = cdpRequestKey(event.requestId, sessionId);
  const request = {
    method: event.request.method,
    phase: networkState.phase,
    requestId: event.requestId,
    sequence: networkState.requests.length + 1,
    sessionId: sessionId ?? null,
    startedAt: Date.now(),
    terminalAt: null,
    terminalReason: null,
    type: event.type,
    url: event.request.url,
  };
  networkState.requests.push(request);
  networkState.byId.set(key, request);
  networkState.inflightRequests.add(key);
  return request;
}

export function completeCdpNetworkRequest(
  networkState,
  event,
  sessionId,
  terminalReason = "loading-finished",
) {
  const key = cdpRequestKey(event.requestId, sessionId);
  if (!networkState.inflightRequests.delete(key)) return null;
  networkState.completedRequestCount += 1;
  const request = networkState.byId.get(key) ?? null;
  if (request) {
    request.terminalAt = Date.now();
    request.terminalReason = terminalReason;
  }
  return request;
}

const expectedCdpTargetCommands = (target) => [
  { method: "Network.enable", name: "network-enable" },
  { method: "Runtime.enable", name: "runtime-enable" },
  { method: "Network.setCacheDisabled", name: "cache-disable" },
  { method: "Target.setAutoAttach", name: "auto-attach" },
  ...(target?.waitingForDebugger === true
    ? [{ method: "Runtime.runIfWaitingForDebugger", name: "resume" }]
    : []),
];

export function isCdpTargetSetupComplete(target) {
  const expectedCommands = expectedCdpTargetCommands(target);
  const commands = Array.isArray(target?.commands) ? target.commands : [];
  const resume = commands.find((command) => command?.name === "resume");
  const setupCommands = commands.filter((command) => command?.name !== "resume");
  const resultSequences = commands.map((command) => command?.resultSequence);
  const expectedResultSequences = commands.map((_, index) => index + 1);
  const commandIds = commands.map((command) => command?.cdpId);
  const commandsByResult = [...commands].sort(
    (left, right) => left.resultSequence - right.resultSequence,
  );
  const serviceWorkerBarrier =
    target?.type === "service_worker" &&
    target?.waitingForDebugger === true;
  const expectedStrategy = serviceWorkerBarrier
    ? "setup-dispatched-before-resume"
    : target?.waitingForDebugger === true
      ? "setup-completed-before-resume"
      : "already-running";
  return (
    target?.attachComplete === true &&
    target?.resumed === true &&
    target?.lifecycleStrategy === expectedStrategy &&
    commands.length === expectedCommands.length &&
    commands.every(
      (command, index) =>
        command?.name === expectedCommands[index].name &&
        command?.method === expectedCommands[index].method &&
        command?.dispatchSequence === index + 1 &&
        Number.isInteger(command?.cdpId) &&
        command.cdpId > 0 &&
        Number.isFinite(command?.dispatchedAt) &&
        Number.isFinite(command?.resultAt) &&
        command.resultAt >= command.dispatchedAt &&
        Number.isInteger(command?.resultSequence) &&
        command.resultSequence > 0 &&
        command?.status === "completed",
    ) &&
    new Set(commands.map((command) => command.cdpId)).size ===
      commands.length &&
    commandIds.every(
      (commandId, index) => index === 0 || commandId > commandIds[index - 1],
    ) &&
    commands.every(
      (command, index) =>
        index === 0 || command.dispatchedAt >= commands[index - 1].dispatchedAt,
    ) &&
    commandsByResult.every(
      (command, index) =>
        index === 0 ||
        command.resultAt >= commandsByResult[index - 1].resultAt,
    ) &&
    [...resultSequences].sort((left, right) => left - right).join(",") ===
      expectedResultSequences.join(",") &&
    (target?.waitingForDebugger === true
      ? Number.isFinite(target?.resumeDispatchedAt) &&
        target.resumeDispatchedAt === resume?.dispatchedAt
      : target?.resumeDispatchedAt === null) &&
    (serviceWorkerBarrier
      ? Number.isFinite(target?.commandDeadlineAt) &&
        target.commandDeadlineAt > target.resumeDispatchedAt &&
        commandIds.every(
          (commandId, index) =>
            index === 0 || commandId === commandIds[index - 1] + 1,
        ) &&
        setupCommands.every(
          (command) => command.dispatchedAt <= target.resumeDispatchedAt,
        ) &&
        commands.every(
          (command) =>
            command.deadlineAt === target.commandDeadlineAt &&
            command.resultAt >= target.resumeDispatchedAt &&
            command.resultAt <= target.commandDeadlineAt,
        )
      : target?.commandDeadlineAt === null &&
        (target?.waitingForDebugger !== true ||
          setupCommands.every(
            (command) => command.resultAt <= target.resumeDispatchedAt,
          )))
  );
}

function hasCdpServiceWorkerBootstrapCoverage(networkState) {
  const targets = Array.isArray(networkState?.targets)
    ? networkState.targets.filter((target) => target?.type === "service_worker")
    : [];
  const observations = Array.isArray(
    networkState?.serviceWorkerBootstrapObservations,
  )
    ? networkState.serviceWorkerBootstrapObservations
    : [];
  const observationSessions = observations.map(
    (observation) => observation?.targetSessionId,
  );
  return (
    targets.length > 0 &&
    observations.length === targets.length &&
    new Set(observationSessions).size === observationSessions.length &&
    targets.every((target) => {
      const observation = observations.find(
        (candidate) => candidate?.targetSessionId === target.sessionId,
      );
      const sessionRequests = (networkState.requests ?? []).filter(
        (request) => request?.sessionId === target.sessionId,
      );
      const request = sessionRequests.find(
        (candidate) => candidate?.requestId === observation?.requestId,
      );
      const requestKey = cdpRequestKey(request?.requestId, request?.sessionId);
      const sessionFailureCount = (networkState.failures ?? []).filter(
        (failure) => failure?.sessionId === target.sessionId,
      ).length + (networkState.responseFailures ?? []).filter(
        (failure) => failure?.sessionId === target.sessionId,
      ).length;
      return (
        isCdpServiceWorkerBootstrapRequest(
          request,
          { ...target, detached: false },
        ) &&
        observation?.targetDetachedAtObservation === false &&
        sessionRequests[0] === request &&
        !sessionRequests.some(
          (candidate) => candidate.startedAt < target.resumeDispatchedAt,
        ) &&
        sessionFailureCount === 0 &&
        target.serviceWorkerBootstrapRequestKey === requestKey &&
        request.serviceWorkerTargetSessionId === target.sessionId &&
        observation?.method === request.method &&
        observation?.phase === request.phase &&
        observation?.requestId === request.requestId &&
        observation?.requestSequence === request.sequence &&
        observation?.requestSessionId === request.sessionId &&
        observation?.requestStartedAt === request.startedAt &&
        observation?.resourceType === request.type &&
        observation?.resumeDispatchedAt === target.resumeDispatchedAt &&
        observation?.targetId === target.targetId &&
        observation?.targetSessionId === target.sessionId &&
        observation?.targetType === target.type &&
        observation?.terminalAt === request.terminalAt &&
        observation?.terminalReason === request.terminalReason &&
        observation?.url === request.url
      );
    })
  );
}

export function isCdpAttachmentStateHealthy(networkState) {
  return (
    networkState?.serviceWorkerBypassed === true &&
    Array.isArray(networkState?.attachErrors) &&
    networkState.attachErrors.length === 0 &&
    Array.isArray(networkState?.targets) &&
    networkState.targets.length > 0 &&
    networkState.targets.every(isCdpTargetSetupComplete) &&
    hasCdpServiceWorkerBootstrapCoverage(networkState)
  );
}

function cdpPhasePdfBootstrapCounts(networkState, appUrl, label) {
  const phaseTargets = (networkState.targets ?? []).filter(
    (target) => target?.phase === label,
  );
  const documentTargets = phaseTargets.filter(
    (target) => classifyCdpDiagnosticUrl(target?.url, appUrl) ===
      "pdf-document-worker",
  );
  const parserTargets = phaseTargets.filter(
    (target) => classifyCdpDiagnosticUrl(target?.url, appUrl) ===
      "pdf-parser-worker",
  );
  const settlements = networkState.targetBootstrapSettlements ?? [];
  const documentTargetSessions = new Set(
    documentTargets.map((target) => target.sessionId),
  );
  const parserTargetSessions = new Set(
    parserTargets.map((target) => target.sessionId),
  );
  return {
    documentBootstrapSettlementCount: settlements.filter(
      (settlement) =>
        settlement?.phase === label &&
        documentTargetSessions.has(settlement?.targetSessionId),
    ).length,
    documentTargetCount: documentTargets.length,
    parserBootstrapSettlementCount: settlements.filter(
      (settlement) =>
        settlement?.phase === label &&
        parserTargetSessions.has(settlement?.targetSessionId),
    ).length,
    parserTargetCount: parserTargets.length,
  };
}

export function hasCdpPhasePdfBootstrapCoverage(networkState, appUrl, label) {
  if (!PDF_SHARPNESS_MATRIX.some((configuration) => configuration.id === label)) {
    return true;
  }
  const counts = cdpPhasePdfBootstrapCounts(networkState, appUrl, label);
  return (
    counts.documentTargetCount > 0 &&
    counts.parserTargetCount > 0 &&
    counts.documentBootstrapSettlementCount === counts.documentTargetCount &&
    counts.parserBootstrapSettlementCount === counts.parserTargetCount
  );
}

export function isCdpTargetBootstrapRequest(request, target) {
  return (
    isCdpTargetSetupComplete(target) &&
    target?.detached !== true &&
    target?.type === "worker" &&
    request?.method === "GET" &&
    request?.type === "Script" &&
    request?.phase === target.phase &&
    request?.sessionId === target.parentSessionId &&
    request?.url === target.url
  );
}

export function reconcileCdpTargetBootstrapRequests(networkState) {
  const settlements = [];
  for (const target of networkState.targets) {
    if (target.bootstrapRequestKey) continue;
    for (const requestKey of networkState.inflightRequests) {
      const request = networkState.byId.get(requestKey);
      if (
        request?.bootstrapTargetSessionId ||
        !isCdpTargetBootstrapRequest(request, target)
      ) {
        continue;
      }
      target.bootstrapRequestKey = requestKey;
      request.bootstrapTargetSessionId = target.sessionId;
      request.terminalAt = Date.now();
      request.terminalReason = "target-attached";
      networkState.inflightRequests.delete(requestKey);
      networkState.completedRequestCount += 1;
      const settlement = {
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
      };
      networkState.targetBootstrapSettlements.push(settlement);
      settlements.push(settlement);
      break;
    }
  }
  return settlements;
}

export function isCdpServiceWorkerBootstrapRequest(request, target) {
  return (
    isCdpTargetSetupComplete(target) &&
    target?.type === "service_worker" &&
    target?.detached !== true &&
    target?.lifecycleStrategy === "setup-dispatched-before-resume" &&
    request?.method === "GET" &&
    request?.type === "Script" &&
    request?.phase === target.phase &&
    request?.sessionId === target.sessionId &&
    request?.url === target.url &&
    Number.isInteger(request?.sequence) &&
    request.sequence > 0 &&
    Number.isFinite(request?.startedAt) &&
    request.startedAt >= target.resumeDispatchedAt &&
    request?.terminalReason === "loading-finished" &&
    Number.isFinite(request?.terminalAt) &&
    request.terminalAt >= request.startedAt
  );
}

export function reconcileCdpServiceWorkerBootstraps(networkState) {
  networkState.serviceWorkerBootstrapObservations ??= [];
  const observations = [];
  for (const target of networkState.targets) {
    if (
      target.type !== "service_worker" ||
      target.serviceWorkerBootstrapRequestKey
    ) {
      continue;
    }
    const sessionRequests = networkState.requests.filter(
      (request) => request.sessionId === target.sessionId,
    );
    const firstRequest = sessionRequests[0];
    if (
      sessionRequests.some(
        (request) => request.startedAt < target.resumeDispatchedAt,
      ) ||
      !isCdpServiceWorkerBootstrapRequest(firstRequest, target)
    ) {
      continue;
    }
    const requestKey = cdpRequestKey(
      firstRequest.requestId,
      firstRequest.sessionId,
    );
    target.serviceWorkerBootstrapRequestKey = requestKey;
    firstRequest.serviceWorkerTargetSessionId = target.sessionId;
    const observation = {
      method: firstRequest.method,
      phase: firstRequest.phase,
      requestId: firstRequest.requestId,
      requestSequence: firstRequest.sequence,
      requestSessionId: firstRequest.sessionId,
      requestStartedAt: firstRequest.startedAt,
      resourceType: firstRequest.type,
      resumeDispatchedAt: target.resumeDispatchedAt,
      targetId: target.targetId,
      targetDetachedAtObservation: false,
      targetSessionId: target.sessionId,
      targetType: target.type,
      terminalAt: firstRequest.terminalAt,
      terminalReason: firstRequest.terminalReason,
      url: firstRequest.url,
    };
    networkState.serviceWorkerBootstrapObservations.push(observation);
    observations.push(observation);
  }
  return observations;
}

export function advanceCdpFixedPointStability(previous, sample) {
  const unchangedAndQuiet =
    sample.attachmentReady === true &&
    sample.pendingAttachCount === 0 &&
    sample.inflightRequestCount === 0 &&
    sample.requestCount === previous.requestCount &&
    sample.targetCount === previous.targetCount;
  const stableSamples = unchangedAndQuiet
    ? previous.stableSamples + 1
    : 0;
  return {
    fixedPointReached: stableSamples >= CDP_FIXED_POINT_STABLE_SAMPLES,
    requestCount: sample.requestCount,
    stableSamples,
    targetCount: sample.targetCount,
  };
}

export function buildCdpNetworkFixedPointDiagnostic(
  networkState,
  appUrl,
  label,
  outcome = "timeout",
  waitState = {},
) {
  const capturedAt = Number.isFinite(waitState.capturedAtMs)
    ? waitState.capturedAtMs
    : Date.now();
  const requestForKey = (key) => networkState.byId.get(key) ?? null;
  const pendingAttachMetadata = networkState.pendingAttachMetadata ?? new Map();
  const pendingAttaches = [...networkState.pendingAttachPromises].map(
    (promise) => {
      const entry = pendingAttachMetadata.get(promise) ?? {};
      return {
        commands: (entry.commands ?? []).map((command) => ({
          cdpId: command.cdpId,
          deadlineAt: command.deadlineAt,
          dispatchedAt: command.dispatchedAt,
          dispatchSequence: command.dispatchSequence,
          method: command.method,
          name: command.name,
          resultAt: command.resultAt,
          resultSequence: command.resultSequence,
          status: command.status,
        })),
        commandDeadlineAt: entry.commandDeadlineAt ?? null,
        identityHash: cdpDiagnosticIdentity(
          entry.sessionId,
          entry.targetId,
        ),
        parentSessionId: entry.parentSessionId ?? null,
        phase: entry.phase ?? null,
        resumeDispatchedAt: entry.resumeDispatchedAt ?? null,
        sessionId: entry.sessionId ?? null,
        targetId: entry.targetId ?? null,
        type: entry.type ?? null,
        urlClass: classifyCdpDiagnosticUrl(entry.url, appUrl),
      };
    },
  );
  const inflightRequests = [...networkState.inflightRequests].map((key) => {
    const request = requestForKey(key) ?? {};
    return {
      identityHash: cdpDiagnosticIdentity(
        request.sessionId,
        request.requestId,
      ),
      method: request.method ?? null,
      phase: request.phase ?? null,
      requestId: request.requestId ?? null,
      sessionId: request.sessionId ?? null,
      type: request.type ?? null,
      urlClass: classifyCdpDiagnosticUrl(request.url, appUrl),
    };
  });
  const targets = withTargetAncestry(networkState.targets).map((target) => ({
    ancestry: target.ancestry.map((ancestor) => ({
      phase: ancestor.phase,
      sessionId: ancestor.sessionId,
      type: ancestor.type,
      urlClass: classifyCdpDiagnosticUrl(ancestor.url, appUrl),
    })),
    attachComplete: target.attachComplete === true,
    commands: (target.commands ?? []).map((command) => ({
      cdpId: command.cdpId,
      deadlineAt: command.deadlineAt,
      dispatchedAt: command.dispatchedAt,
      dispatchSequence: command.dispatchSequence,
      method: command.method,
      name: command.name,
      resultAt: command.resultAt,
      resultSequence: command.resultSequence,
      status: command.status,
    })),
    commandDeadlineAt: target.commandDeadlineAt ?? null,
    detached: target.detached === true,
    identityHash: cdpDiagnosticIdentity(
      target.sessionId,
      target.targetId,
    ),
    parentSessionId: target.parentSessionId ?? null,
    phase: target.phase ?? null,
    lifecycleStrategy: target.lifecycleStrategy ?? null,
    resumed: target.resumed === true,
    resumeDispatchedAt: target.resumeDispatchedAt ?? null,
    sessionId: target.sessionId ?? null,
    targetId: target.targetId ?? null,
    type: target.type ?? null,
    urlClass: classifyCdpDiagnosticUrl(target.url, appUrl),
    waitingForDebugger: target.waitingForDebugger === true,
    workerInstanceId: Number.isInteger(target.workerInstanceId)
      ? target.workerInstanceId
      : null,
  }));
  const targetBootstrapSettlements = (
    networkState.targetBootstrapSettlements ?? []
  ).map((entry) => ({
    identityHash: cdpDiagnosticIdentity(
      entry.requestSessionId,
      entry.requestId,
      entry.targetSessionId,
      entry.targetId,
    ),
    method: entry.method,
    phase: entry.phase,
    requestId: entry.requestId,
    requestSessionId: entry.requestSessionId,
    resourceType: entry.resourceType,
    targetDetachedAtSettlement: entry.targetDetachedAtSettlement === true,
    targetId: entry.targetId,
    targetParentSessionId: entry.targetParentSessionId,
    targetSessionId: entry.targetSessionId,
    targetType: entry.targetType,
    terminalReason: entry.terminalReason,
    urlClass: classifyCdpDiagnosticUrl(entry.url, appUrl),
  }));
  const serviceWorkerBootstrapObservations = (
    networkState.serviceWorkerBootstrapObservations ?? []
  ).map((entry) => {
    const target = networkState.targets.find(
      (candidate) => candidate.sessionId === entry.targetSessionId,
    );
    const sessionRequests = networkState.requests.filter(
      (request) => request.sessionId === entry.requestSessionId,
    );
    const request = sessionRequests.find(
      (candidate) => candidate.requestId === entry.requestId,
    );
    return {
      earlierRequestCount: sessionRequests.filter(
        (candidate) => candidate.startedAt < entry.resumeDispatchedAt,
      ).length,
      identityHash: cdpDiagnosticIdentity(
        entry.requestSessionId,
        entry.requestId,
        entry.targetSessionId,
        entry.targetId,
      ),
      method: entry.method,
      phase: entry.phase,
      requestId: entry.requestId,
      requestIsFirst: sessionRequests[0] === request,
      requestSequence: entry.requestSequence,
      requestSessionId: entry.requestSessionId,
      requestStartedAt: entry.requestStartedAt,
      resourceType: entry.resourceType,
      resumeDispatchedAt: entry.resumeDispatchedAt,
      sessionFailureCount: (networkState.failures ?? []).filter(
        (failure) => failure.sessionId === entry.requestSessionId,
      ).length + (networkState.responseFailures ?? []).filter(
        (failure) => failure.sessionId === entry.requestSessionId,
      ).length,
      sessionRequestCount: sessionRequests.length,
      targetId: entry.targetId,
      targetDetachedAtObservation:
        entry.targetDetachedAtObservation === true,
      targetSessionId: entry.targetSessionId,
      targetType: entry.targetType,
      targetUrlMatched: request?.url === target?.url,
      terminalAt: entry.terminalAt,
      terminalReason: entry.terminalReason,
      urlClass: classifyCdpDiagnosticUrl(entry.url, appUrl),
    };
  });
  const attachErrors = networkState.attachErrors.map((entry) => ({
    category: String(entry.error).startsWith("Could not resume target:")
      ? "resume"
      : String(entry.error).startsWith("Unhandled attach setup error:")
        ? "unhandled-setup"
        : "setup",
    command: entry.command ?? null,
    identityHash: cdpDiagnosticIdentity(
      entry.sessionId,
      entry.targetId,
    ),
    sessionId: entry.sessionId ?? null,
    targetId: entry.targetId ?? null,
    type: entry.type ?? null,
    urlClass: classifyCdpDiagnosticUrl(entry.url, appUrl),
  }));
  const recentActivity = (networkState.recentActivity ?? [])
    .slice(-20)
    .map((entry) => ({
      ageMs: Number.isFinite(entry.at)
        ? Math.max(0, capturedAt - entry.at)
        : null,
      cdpId: entry.cdpId ?? null,
      command: entry.command ?? null,
      dispatchSequence: entry.dispatchSequence ?? null,
      identityHash: cdpDiagnosticIdentity(
        entry.sessionId,
        entry.targetId,
        entry.requestId,
      ),
      kind: entry.kind,
      method: entry.method ?? null,
      phase: entry.phase ?? null,
      requestId: entry.requestId ?? null,
      resultSequence: entry.resultSequence ?? null,
      sessionId: entry.sessionId ?? null,
      targetId: entry.targetId ?? null,
      type: entry.type ?? null,
      urlClass: classifyCdpDiagnosticUrl(entry.url, appUrl),
    }));
  return {
    attachErrors,
    counts: {
      attachErrorCount: networkState.attachErrors.length,
      attachPromiseCount: networkState.attachPromises.length,
      completedRequestCount: networkState.completedRequestCount,
      externalRequestCount: networkState.requests.filter(
        (request) => !isLoopbackRequest(request.url, appUrl),
      ).length,
      inflightRequestCount: networkState.inflightRequests.size,
      pendingAttachCount: networkState.pendingAttachPromises.size,
      networkFailureCount:
        (networkState.failures ?? []).filter(
          (failure) => !failure.canceled,
        ).length + (networkState.responseFailures ?? []).length,
      requestCount: networkState.requests.length,
      serviceWorkerBootstrapObservationCount:
        serviceWorkerBootstrapObservations.length,
      targetBootstrapSettlementCount: targetBootstrapSettlements.length,
      targetCount: networkState.targets.length,
    },
    inflightRequests,
    initialTargetBaseline: networkState.initialTargetBaseline ?? null,
    label,
    outcome,
    pendingAttaches,
    recentActivity,
    serviceWorkerBypassed: networkState.serviceWorkerBypassed === true,
    serviceWorkerBootstrapObservations,
    targetBootstrapSettlements,
    targets,
    wait: {
      elapsedMs: Number.isFinite(waitState.elapsedMs)
        ? Math.max(0, waitState.elapsedMs)
        : 0,
      recentSamples: (waitState.recentSamples ?? []).slice(-12).map(
        (sample) => ({
          attachErrorCount: sample.attachErrorCount,
          attachmentReady: sample.attachmentReady === true,
          elapsedMs: sample.elapsedMs,
          incompleteTargetCount: sample.incompleteTargetCount,
          inflightRequestCount: sample.inflightRequestCount,
          pendingAttachCount: sample.pendingAttachCount,
          requestCount: sample.requestCount,
          serviceWorkerBypassed: sample.serviceWorkerBypassed === true,
          stableSamples: sample.stableSamples,
          targetCount: sample.targetCount,
        }),
      ),
      requiredStableSamples: CDP_FIXED_POINT_STABLE_SAMPLES,
      stableSamples: Number.isInteger(waitState.stableSamples)
        ? waitState.stableSamples
        : 0,
      timeoutMs: Number.isFinite(waitState.timeoutMs)
        ? waitState.timeoutMs
        : 0,
    },
  };
}

export function isCdpFixedPointDiagnosticHealthy(networkDiagnostic) {
  const targets = Array.isArray(networkDiagnostic?.targets)
    ? networkDiagnostic.targets
    : [];
  const targetSessions = targets.map((target) => target?.sessionId);
  const targetIds = targets.map((target) => target?.targetId);
  const targetCommandIds = targets.flatMap((target) =>
    Array.isArray(target?.commands)
      ? target.commands.map((command) => command?.cdpId)
      : []
  );
  const targetBySession = new Map(
    targets.map((target) => [target?.sessionId, target]),
  );
  const nonEmptyString = (value) =>
    typeof value === "string" && value.length > 0;
  const validTargetIdentities =
    targetSessions.every(nonEmptyString) &&
    new Set(targetSessions).size === targetSessions.length &&
    targetIds.every(nonEmptyString) &&
    new Set(targetIds).size === targetIds.length &&
    targets.every(
      (target) =>
        nonEmptyString(target?.phase) &&
        nonEmptyString(target?.type) &&
        target?.identityHash === cdpDiagnosticIdentity(
          target.sessionId,
          target.targetId,
        ),
    );
  const targetBootstrapSettlements = Array.isArray(
    networkDiagnostic?.targetBootstrapSettlements,
  )
    ? networkDiagnostic.targetBootstrapSettlements
    : [];
  const bootstrapTargetSessions = targetBootstrapSettlements.map(
    (settlement) => settlement?.targetSessionId,
  );
  const bootstrapRequestIdentities = targetBootstrapSettlements.map(
    (settlement) =>
      `${settlement?.requestSessionId ?? "page"}:${settlement?.requestId}`,
  );
  const validBootstrapSettlements = targetBootstrapSettlements.every(
    (settlement) => {
      const target = targetBySession.get(settlement?.targetSessionId);
      return (
        nonEmptyString(settlement?.requestId) &&
        (settlement?.requestSessionId === null ||
          nonEmptyString(settlement?.requestSessionId)) &&
        nonEmptyString(settlement?.targetSessionId) &&
        nonEmptyString(settlement?.targetId) &&
        nonEmptyString(settlement?.phase) &&
        nonEmptyString(settlement?.targetType) &&
        settlement?.identityHash === cdpDiagnosticIdentity(
          settlement.requestSessionId,
          settlement.requestId,
          settlement.targetSessionId,
          settlement.targetId,
        ) &&
        isCdpTargetSetupComplete(target) &&
        target?.targetId === settlement?.targetId &&
        target?.parentSessionId === settlement?.targetParentSessionId &&
        target?.parentSessionId === settlement?.requestSessionId &&
        target?.phase === settlement?.phase &&
        target?.phase === networkDiagnostic?.label &&
        target?.type === "worker" &&
        target?.type === settlement?.targetType &&
        target?.urlClass === settlement?.urlClass &&
        settlement?.method === "GET" &&
        settlement?.resourceType === "Script" &&
        settlement?.targetDetachedAtSettlement === false &&
        settlement?.terminalReason === "target-attached"
      );
    },
  );
  const pdfTargets = targets.filter(
    (target) =>
      target?.phase === networkDiagnostic?.label &&
      ["pdf-document-worker", "pdf-parser-worker"].includes(
        target?.urlClass,
      ),
  );
  const pdfBootstrapCoverage = [
    "pdf-document-worker",
    "pdf-parser-worker",
  ].every((urlClass) => {
    const matchingTargets = pdfTargets.filter(
      (target) => target.urlClass === urlClass,
    );
    return (
      matchingTargets.length > 0 &&
      matchingTargets.every((target) =>
        bootstrapTargetSessions.includes(target.sessionId)
      )
    );
  });
  const parserTargetsBoundToDocumentWorker = pdfTargets
    .filter((target) => target.urlClass === "pdf-parser-worker")
    .every((target) => {
      const parent = targetBySession.get(target.parentSessionId);
      const directAncestor = Array.isArray(target.ancestry)
        ? target.ancestry[0]
        : null;
      return (
        parent?.urlClass === "pdf-document-worker" &&
        parent?.type === "worker" &&
        parent?.phase === target.phase &&
        directAncestor?.sessionId === parent.sessionId &&
        directAncestor?.urlClass === parent.urlClass &&
        directAncestor?.type === parent.type &&
        directAncestor?.phase === parent.phase
      );
    });
  const initialTargetBaseline = networkDiagnostic?.initialTargetBaseline;
  const serviceWorkerTargets = targets.filter(
    (target) => target?.type === "service_worker",
  );
  const serviceWorkerBootstrapObservations = Array.isArray(
    networkDiagnostic?.serviceWorkerBootstrapObservations,
  )
    ? networkDiagnostic.serviceWorkerBootstrapObservations
    : [];
  const serviceWorkerObservationSessions =
    serviceWorkerBootstrapObservations.map(
      (observation) => observation?.targetSessionId,
    );
  const validServiceWorkerBootstrapObservations =
    serviceWorkerTargets.length > 0 &&
    serviceWorkerBootstrapObservations.length === serviceWorkerTargets.length &&
    new Set(serviceWorkerObservationSessions).size ===
      serviceWorkerObservationSessions.length &&
    serviceWorkerTargets.every((target) =>
      serviceWorkerObservationSessions.includes(target.sessionId)
    ) &&
    serviceWorkerBootstrapObservations.every((observation) => {
      const target = targetBySession.get(observation?.targetSessionId);
      return (
        isCdpTargetSetupComplete(target) &&
        target?.type === "service_worker" &&
        target?.phase === networkDiagnostic?.label &&
        observation?.identityHash === cdpDiagnosticIdentity(
          observation.requestSessionId,
          observation.requestId,
          observation.targetSessionId,
          observation.targetId,
        ) &&
        nonEmptyString(observation?.requestId) &&
        observation?.requestSessionId === target.sessionId &&
        observation?.targetId === target.targetId &&
        observation?.targetDetachedAtObservation === false &&
        observation?.targetType === target.type &&
        observation?.phase === target.phase &&
        observation?.method === "GET" &&
        observation?.resourceType === "Script" &&
        observation?.urlClass === target.urlClass &&
        observation?.targetUrlMatched === true &&
        observation?.requestIsFirst === true &&
        Number.isInteger(observation?.requestSequence) &&
        observation.requestSequence > 0 &&
        Number.isFinite(observation?.resumeDispatchedAt) &&
        observation.resumeDispatchedAt === target.resumeDispatchedAt &&
        Number.isFinite(observation?.requestStartedAt) &&
        observation.requestStartedAt >= observation.resumeDispatchedAt &&
        observation?.earlierRequestCount === 0 &&
        Number.isInteger(observation?.sessionRequestCount) &&
        observation.sessionRequestCount > 0 &&
        observation?.sessionFailureCount === 0 &&
        observation?.terminalReason === "loading-finished" &&
        Number.isFinite(observation?.terminalAt) &&
        observation.terminalAt >= observation.requestStartedAt
      );
    });
  const recentSamples = Array.isArray(networkDiagnostic?.wait?.recentSamples)
    ? networkDiagnostic.wait.recentSamples
    : [];
  const requiredStableSamples = CDP_FIXED_POINT_STABLE_SAMPLES;
  const stableTail = recentSamples.slice(-requiredStableSamples);
  const counts = networkDiagnostic?.counts;
  return (
    networkDiagnostic?.outcome === "fixed-point-reached" &&
    networkDiagnostic?.serviceWorkerBypassed === true &&
    Array.isArray(networkDiagnostic?.attachErrors) &&
    networkDiagnostic.attachErrors.length === 0 &&
    Array.isArray(networkDiagnostic?.pendingAttaches) &&
    networkDiagnostic.pendingAttaches.length === 0 &&
    Array.isArray(networkDiagnostic?.inflightRequests) &&
    networkDiagnostic.inflightRequests.length === 0 &&
    counts?.attachErrorCount === 0 &&
    counts?.externalRequestCount === 0 &&
    counts?.networkFailureCount === 0 &&
    counts?.pendingAttachCount === 0 &&
    counts?.inflightRequestCount === 0 &&
    counts?.targetBootstrapSettlementCount ===
      targetBootstrapSettlements.length &&
    counts?.serviceWorkerBootstrapObservationCount ===
      serviceWorkerBootstrapObservations.length &&
    Number.isInteger(counts?.attachPromiseCount) &&
    counts.attachPromiseCount === targets.length &&
    Number.isInteger(counts?.completedRequestCount) &&
    counts.completedRequestCount > 0 &&
    Number.isInteger(counts?.requestCount) &&
    counts.requestCount > 0 &&
    counts.completedRequestCount === counts.requestCount &&
    Number.isInteger(counts?.targetCount) &&
    counts.targetCount === targets.length &&
    targets.length > 0 &&
    targets.every(isCdpTargetSetupComplete) &&
    validTargetIdentities &&
    new Set(targetCommandIds).size === targetCommandIds.length &&
    validBootstrapSettlements &&
    targetBootstrapSettlements.length > 0 &&
    new Set(bootstrapTargetSessions).size ===
      bootstrapTargetSessions.length &&
    new Set(bootstrapRequestIdentities).size ===
      bootstrapRequestIdentities.length &&
    pdfBootstrapCoverage &&
    parserTargetsBoundToDocumentWorker &&
    initialTargetBaseline?.checked === true &&
    initialTargetBaseline?.pageCount === 1 &&
    initialTargetBaseline?.pageUrlClass === "about" &&
    initialTargetBaseline?.workerCount === 0 &&
    initialTargetBaseline?.targetCount === 1 &&
    validServiceWorkerBootstrapObservations &&
    networkDiagnostic?.wait?.requiredStableSamples === requiredStableSamples &&
    Number.isInteger(networkDiagnostic?.wait?.stableSamples) &&
    networkDiagnostic.wait.stableSamples === requiredStableSamples &&
    stableTail.length === requiredStableSamples &&
    stableTail.every((sample, index) =>
      sample?.attachmentReady === true &&
      sample?.attachErrorCount === 0 &&
      sample?.incompleteTargetCount === 0 &&
      sample?.serviceWorkerBypassed === true &&
      sample?.pendingAttachCount === 0 &&
      sample?.inflightRequestCount === 0 &&
      sample?.requestCount === counts.requestCount &&
      sample?.targetCount === counts.targetCount &&
      sample?.stableSamples ===
        networkDiagnostic.wait.stableSamples - stableTail.length + index + 1
    )
  );
}

function resolveThroughExistingAncestor(candidatePath) {
  let existingAncestor = candidatePath;
  const missingSegments = [];
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathSync(existingAncestor);
  return path.resolve(canonicalAncestor, ...missingSegments);
}

function isOutsideRepository(candidatePath) {
  if (typeof candidatePath !== "string" || !path.isAbsolute(candidatePath)) {
    return false;
  }
  const canonicalRepository = realpathSync(REPOSITORY_ROOT);
  const canonicalCandidate = resolveThroughExistingAncestor(candidatePath);
  const relative = path.relative(canonicalRepository, canonicalCandidate);
  return (
    relative !== "" &&
    (relative.startsWith("..") || path.isAbsolute(relative))
  );
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

function isExactReferenceDiagnosticSource(source) {
  const files = source?.files &&
      typeof source.files === "object" &&
      !Array.isArray(source.files)
    ? source.files
    : null;
  const actualKeys = files ? Object.keys(files).sort() : [];
  const expectedKeys = [...PDF_SHARPNESS_SOURCE_FILES].sort();
  return (
    COMMIT_PATTERN.test(source?.commit ?? "") &&
    COMMIT_PATTERN.test(source?.tree ?? "") &&
    Array.isArray(source?.preflightStatus) &&
    source.preflightStatus.length === 0 &&
    source?.postCaptureCommit === source?.commit &&
    source?.postCaptureTree === source?.tree &&
    Array.isArray(source?.postCaptureStatus) &&
    source.postCaptureStatus.length === 0 &&
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) =>
      key === expectedKeys[index] && SHA256_PATTERN.test(files[key] ?? "")
    )
  );
}

function summarizeReferenceDiagnosticSource(source) {
  return {
    commit: COMMIT_PATTERN.test(source?.commit ?? "") ? source.commit : null,
    files: Object.fromEntries(PDF_SHARPNESS_SOURCE_FILES.map((file) => [
      file,
      SHA256_PATTERN.test(source?.files?.[file] ?? "")
        ? source.files[file]
        : null,
    ])),
    postCaptureClean:
      Array.isArray(source?.postCaptureStatus) &&
      source.postCaptureStatus.length === 0,
    postCaptureCommit: COMMIT_PATTERN.test(source?.postCaptureCommit ?? "")
      ? source.postCaptureCommit
      : null,
    postCaptureTree: COMMIT_PATTERN.test(source?.postCaptureTree ?? "")
      ? source.postCaptureTree
      : null,
    preflightClean:
      Array.isArray(source?.preflightStatus) &&
      source.preflightStatus.length === 0,
    tree: COMMIT_PATTERN.test(source?.tree ?? "") ? source.tree : null,
  };
}

function sanitizeReferenceDiagnosticAnalysis(analysis) {
  const nonNegativeInteger = (value) =>
    Number.isInteger(value) && value >= 0;
  const nonNegativeFinite = (value) =>
    Number.isFinite(value) && value >= 0;
  const ratio = (value) =>
    Number.isFinite(value) && value >= 0 && value <= 1;
  const closeTo = (left, right) =>
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= 1e-9;
  const bounds = analysis?.pageBounds;
  const dimensionsValid =
    Number.isInteger(analysis?.height) &&
    analysis.height > 0 &&
    Number.isInteger(analysis?.width) &&
    analysis.width > 0;
  const metricsValid =
    nonNegativeInteger(analysis?.inkPixels) &&
    ratio(analysis?.inkRatio) &&
    nonNegativeInteger(analysis?.inkRowBands) &&
    ratio(analysis?.inkSpanRatio) &&
    nonNegativeInteger(analysis?.pagePixels) &&
    nonNegativeInteger(analysis?.pageWhitePixels) &&
    ratio(analysis?.pageWhiteRatio);
  const segmentationShapeValid =
    analysis?.segmentationVersion === 2 &&
    nonNegativeInteger(analysis?.substantialComponentCount) &&
    nonNegativeInteger(analysis?.winnerWhiteArea) &&
    nonNegativeInteger(analysis?.runnerUpWhiteArea);
  const boundsValid = bounds &&
    nonNegativeInteger(bounds.height) &&
    nonNegativeInteger(bounds.width) &&
    nonNegativeInteger(bounds.x) &&
    nonNegativeInteger(bounds.y) &&
    bounds.height > 0 &&
    bounds.width > 0 &&
    dimensionsValid &&
    bounds.x + bounds.width <= analysis.width &&
    bounds.y + bounds.height <= analysis.height;
  const noSubstantialComponent =
    analysis?.substantialComponentCount === 0;
  const uniqueWinner =
    analysis?.substantialComponentCount > 0 &&
    analysis?.winnerWhiteArea > analysis?.runnerUpWhiteArea;
  const dominanceValid = uniqueWinner
    ? analysis.runnerUpWhiteArea === 0
      ? analysis.winnerDominanceRatio === null
      : nonNegativeFinite(analysis.winnerDominanceRatio) &&
        analysis.winnerDominanceRatio > 1 &&
        closeTo(
          analysis.winnerDominanceRatio,
          analysis.winnerWhiteArea / analysis.runnerUpWhiteArea,
        )
    : analysis?.winnerWhiteArea > 0 &&
      analysis?.runnerUpWhiteArea > 0 &&
      nonNegativeFinite(analysis?.winnerDominanceRatio) &&
      closeTo(
        analysis.winnerDominanceRatio,
        analysis.winnerWhiteArea / analysis.runnerUpWhiteArea,
      );
  const emptyAnalysis =
    analysis?.renderedPage === false &&
    bounds === null &&
    analysis?.pagePixels === 0 &&
    analysis?.pageWhitePixels === 0 &&
    analysis?.pageWhiteRatio === 0 &&
    analysis?.inkPixels === 0 &&
    analysis?.inkRatio === 0 &&
    analysis?.inkRowBands === 0 &&
    analysis?.inkSpanRatio === 0;
  const noWinnerStateValid = noSubstantialComponent
    ? analysis?.winnerWhiteArea === 0 &&
      analysis?.runnerUpWhiteArea === 0 &&
      analysis?.winnerDominanceRatio === null &&
      emptyAnalysis
    : !uniqueWinner && dominanceValid && emptyAnalysis;
  let uniqueWinnerStateValid = false;
  if (
    uniqueWinner &&
    dominanceValid &&
    boundsValid &&
    metricsValid &&
    analysis.winnerWhiteArea <= bounds.width * bounds.height &&
    analysis.runnerUpWhiteArea <= analysis.width * analysis.height &&
    (analysis.substantialComponentCount === 1 ||
      analysis.runnerUpWhiteArea > 0) &&
    bounds.width >= Math.max(120, Math.ceil(analysis.width * 0.25)) &&
    bounds.height >= Math.max(80, Math.ceil(analysis.height * 0.25))
  ) {
    const insetX = Math.max(2, Math.floor(bounds.width * 0.01));
    const insetY = Math.max(2, Math.floor(bounds.height * 0.01));
    const expectedPagePixels =
      (bounds.width - insetX * 2) * (bounds.height - insetY * 2);
    const renderedPage =
      analysis.pageWhiteRatio >= PDF_SHARPNESS_REFERENCE_MIN_WHITE_RATIO &&
      analysis.inkPixels >= PDF_SHARPNESS_REFERENCE_MIN_INK_PIXELS &&
      analysis.inkRatio <= PDF_SHARPNESS_REFERENCE_MAX_INK_RATIO &&
      analysis.inkRowBands >= PDF_SHARPNESS_REFERENCE_MIN_INK_ROW_BANDS &&
      analysis.inkSpanRatio >= PDF_SHARPNESS_REFERENCE_MIN_INK_SPAN_RATIO;
    uniqueWinnerStateValid =
      expectedPagePixels > 0 &&
      analysis.pagePixels === expectedPagePixels &&
      analysis.pageWhitePixels <= analysis.pagePixels &&
      analysis.pageWhitePixels <= analysis.winnerWhiteArea &&
      closeTo(
        analysis.pageWhiteRatio,
        analysis.pageWhitePixels / analysis.pagePixels,
      ) &&
      analysis.inkPixels <= analysis.pagePixels &&
      closeTo(
        analysis.inkRatio,
        analysis.inkPixels / analysis.pagePixels,
      ) &&
      analysis.renderedPage === renderedPage;
  }
  const analysisStateValid =
    dimensionsValid &&
    metricsValid &&
    segmentationShapeValid &&
    (noWinnerStateValid || uniqueWinnerStateValid);
  if (
    analysis?.proof !== "white-page-with-rendered-ink" ||
    typeof analysis?.renderedPage !== "boolean" ||
    !analysisStateValid
  ) {
    return null;
  }
  return {
    height: analysis.height,
    inkPixels: analysis.inkPixels,
    inkRatio: analysis.inkRatio,
    inkRowBands: analysis.inkRowBands,
    inkSpanRatio: analysis.inkSpanRatio,
    pageBounds: bounds
      ? {
          height: bounds.height,
          width: bounds.width,
          x: bounds.x,
          y: bounds.y,
        }
      : null,
    pagePixels: analysis.pagePixels,
    pageWhitePixels: analysis.pageWhitePixels,
    pageWhiteRatio: analysis.pageWhiteRatio,
    proof: analysis.proof,
    renderedPage: analysis.renderedPage,
    runnerUpWhiteArea: analysis.runnerUpWhiteArea,
    segmentationVersion: analysis.segmentationVersion,
    substantialComponentCount: analysis.substantialComponentCount,
    width: analysis.width,
    winnerDominanceRatio: analysis.winnerDominanceRatio,
    winnerWhiteArea: analysis.winnerWhiteArea,
  };
}

function summarizeReferenceDiagnosticProgress(progress, runnerFailure) {
  const history = Array.isArray(progress?.history) &&
      progress.history.every((stage) =>
        REFERENCE_CAPTURE_DIAGNOSTIC_STAGES.includes(stage)
      )
    ? [...progress.history]
    : [];
  const sequenceComplete =
    history.length === REFERENCE_CAPTURE_DIAGNOSTIC_STAGES.length &&
    history.every(
      (stage, index) => stage === REFERENCE_CAPTURE_DIAGNOSTIC_STAGES[index],
    );
  const terminalStage = REFERENCE_CAPTURE_DIAGNOSTIC_STAGES.includes(
    progress?.terminalStage,
  )
    ? progress.terminalStage
    : null;
  const failureCategory = runnerFailure
    ? terminalStage
      ? `${terminalStage.replace(/-(?:started|completed)$/u, "")}-failure`
      : "pre-diagnostic-failure"
    : "none";
  return { failureCategory, history, sequenceComplete, terminalStage };
}

export function buildReferenceCaptureDiagnosticReport({
  capture,
  fixture,
  outputDirectory,
  progress,
  recordedAt = new Date().toISOString(),
  runnerFailure,
  source,
  teardown,
}) {
  const expectedFixturePath = path.relative(
    REPOSITORY_ROOT,
    path.resolve(DEFAULT_PDF_HIGHLIGHT_FIXTURE),
  );
  const fixtureBound =
    fixture?.path === expectedFixturePath &&
    fixture?.bytes === PUBLIC_PDF_FIXTURE_BYTES &&
    fixture?.sha256 === PUBLIC_PDF_FIXTURE_SHA256;
  const outputIsExternal = isOutsideRepository(outputDirectory);
  const candidates = Array.isArray(capture?.candidates)
    ? capture.candidates
    : [];
  const publicCandidates = candidates.map((candidate, index) => {
    const expectedName = REFERENCE_CAPTURE_DIAGNOSTIC_CANDIDATES[index];
    const expectedPath = expectedName && outputIsExternal
      ? path.relative(
        REPOSITORY_ROOT,
        path.join(outputDirectory, expectedName),
      )
      : null;
    const analysis = sanitizeReferenceDiagnosticAnalysis(candidate?.analysis);
    const bound =
      Boolean(expectedName) &&
      candidate?.path === expectedPath &&
      Number.isInteger(candidate?.bytes) &&
      candidate.bytes > 0 &&
      SHA256_PATTERN.test(candidate?.sha256 ?? "") &&
      Number.isInteger(candidate?.attempt) &&
      candidate.attempt > 0 &&
      Boolean(analysis);
    return bound
      ? {
          analysis,
          artifact: {
            bytes: candidate.bytes,
            path: expectedName,
            sha256: candidate.sha256,
          },
          attempt: candidate.attempt,
        }
      : null;
  });
  const stableCandidatesBound =
    outputIsExternal &&
    capture?.configurationId === PDF_SHARPNESS_MATRIX[0].id &&
    capture?.referenceScheme === "file:" &&
    capture?.targetPage === REFERENCE_CAPTURE_DIAGNOSTIC_TARGET_PAGE &&
    Number.isInteger(capture?.attempts) &&
    capture.attempts >= 2 &&
    Number.isInteger(capture?.captureErrorCount) &&
    capture.captureErrorCount >= 0 &&
    candidates.length === REFERENCE_CAPTURE_DIAGNOSTIC_CANDIDATES.length &&
    publicCandidates.every(Boolean) &&
    publicCandidates[0].attempt < publicCandidates[1].attempt &&
    publicCandidates[1].attempt <= capture.attempts &&
    publicCandidates[0].artifact.bytes === publicCandidates[1].artifact.bytes &&
    publicCandidates[0].artifact.sha256 ===
      publicCandidates[1].artifact.sha256 &&
    JSON.stringify(publicCandidates[0].analysis) ===
      JSON.stringify(publicCandidates[1].analysis);
  const progressSummary = summarizeReferenceDiagnosticProgress(
    progress,
    runnerFailure,
  );
  const sourceBound = isExactReferenceDiagnosticSource(source);
  const teardownFailed =
    teardown?.reference?.present !== true ||
    teardown?.reference?.cdpClosed !== true ||
    teardown?.reference?.processClosed !== true ||
    teardown?.reference?.profileRemoved !== true ||
    Boolean(teardown?.reference?.error) ||
    teardown?.errorCount !== 0;
  const failures = [
    ...(runnerFailure
      ? ["The bounded reference-capture diagnostic runner reported a failure."]
      : []),
    ...(!progressSummary.sequenceComplete
      ? ["The reference-capture diagnostic stage sequence is incomplete or invalid."]
      : []),
    ...(!sourceBound
      ? ["The reference-capture diagnostic source binding is not exact and clean."]
      : []),
    ...(!fixtureBound
      ? ["The reference-capture diagnostic fixture is not the exact public fixture."]
      : []),
    ...(!outputIsExternal
      ? ["The reference-capture diagnostic output is not external."]
      : []),
    ...(!stableCandidatesBound
      ? ["The reference-capture diagnostic did not retain two stable byte-identical candidates."]
      : []),
    ...(teardownFailed
      ? ["The owned reference browser/CDP/profile did not tear down cleanly."]
      : []),
  ];
  return {
    artifacts: {
      candidates: stableCandidatesBound ? publicCandidates : [],
      sourceCommit: sourceBound ? source.commit : null,
      sourceTree: sourceBound ? source.tree : null,
    },
    capture: {
      attempts: Number.isInteger(capture?.attempts) ? capture.attempts : null,
      captureErrorCount: Number.isInteger(capture?.captureErrorCount)
        ? capture.captureErrorCount
        : null,
      stableByteIdentical: stableCandidatesBound,
    },
    completed:
      progressSummary.sequenceComplete &&
      sourceBound &&
      fixtureBound &&
      stableCandidatesBound &&
      !teardownFailed &&
      !runnerFailure,
    configuration: {
      id: PDF_SHARPNESS_MATRIX[0].id,
      targetPage: REFERENCE_CAPTURE_DIAGNOSTIC_TARGET_PAGE,
    },
    diagnostic: true,
    diagnosticSchemaVersion: 1,
    execution: progressSummary,
    failures,
    fixture: fixtureBound ? fixture : null,
    mode: "reference-capture",
    recordedAt,
    source: summarizeReferenceDiagnosticSource(source),
    teardown: {
      errorCount: Number.isInteger(teardown?.errorCount)
        ? teardown.errorCount
        : null,
      reference: {
        cdpClosed: teardown?.reference?.cdpClosed === true,
        errorPresent: Boolean(teardown?.reference?.error),
        present: teardown?.reference?.present === true,
        processClosed: teardown?.reference?.processClosed === true,
        profileRemoved: teardown?.reference?.profileRemoved === true,
      },
    },
  };
}

export function buildFirstNetworkDiagnosticReport({
  build,
  fixture,
  networkDiagnostic,
  outputDirectory,
  runnerFailure,
  scenario,
  source,
  teardown,
}) {
  const screenshot = scenario?.comparison?.lineLightScreenshot ?? null;
  const expectedFixturePath = path.relative(
    REPOSITORY_ROOT,
    path.resolve(DEFAULT_PDF_HIGHLIGHT_FIXTURE),
  );
  const fixtureBound =
    fixture?.path === expectedFixturePath &&
    fixture?.bytes === PUBLIC_PDF_FIXTURE_BYTES &&
    fixture?.sha256 === PUBLIC_PDF_FIXTURE_SHA256;
  const outputIsExternal = isOutsideRepository(outputDirectory);
  const expectedScreenshotPath = outputIsExternal
    ? path.relative(
      REPOSITORY_ROOT,
      path.join(outputDirectory, "linelight-desktop-dpr1-zoom100.png"),
    )
    : null;
  const screenshotBound =
    outputIsExternal &&
    scenario?.id === PDF_SHARPNESS_MATRIX[0].id &&
    typeof screenshot?.path === "string" &&
    screenshot.path === expectedScreenshotPath &&
    Number.isInteger(screenshot?.bytes) &&
    screenshot.bytes > 0 &&
    /^[a-f0-9]{64}$/u.test(screenshot?.sha256 ?? "");
  const teardownFailed =
    teardown?.app?.present !== true ||
    teardown?.app?.cdpClosed !== true ||
    teardown?.app?.processClosed !== true ||
    teardown?.app?.profileRemoved !== true ||
    Boolean(teardown?.app?.error) ||
    teardown?.reference?.cdpClosed !== true ||
    teardown?.reference?.processClosed !== true ||
    teardown?.reference?.profileRemoved !== true ||
    Boolean(teardown?.reference?.error) ||
    teardown?.server?.present !== true ||
    teardown?.server?.processClosed !== true ||
    Boolean(teardown?.server?.error) ||
    teardown?.browserClosed !== true ||
    teardown?.cdpClosed !== true ||
    teardown?.profilesRemoved !== true ||
    teardown?.serverClosed !== true ||
    teardown?.errors?.length > 0;
  const fixedPointHealthy =
    networkDiagnostic?.label === PDF_SHARPNESS_MATRIX[0].id &&
    scenario?.id === PDF_SHARPNESS_MATRIX[0].id &&
    isCdpFixedPointDiagnosticHealthy(networkDiagnostic);
  const summarizeBrowserShutdown = (shutdown) => ({
    cdpClosed: shutdown?.cdpClosed === true,
    errorPresent: Boolean(shutdown?.error),
    present: shutdown?.present === true,
    processClosed: shutdown?.processClosed === true,
    profileRemoved: shutdown?.profileRemoved === true,
  });
  const teardownSummary = {
    app: summarizeBrowserShutdown(teardown?.app),
    browserClosed: teardown?.browserClosed === true,
    cdpClosed: teardown?.cdpClosed === true,
    errorCount: Array.isArray(teardown?.errors) ? teardown.errors.length : 0,
    profilesRemoved: teardown?.profilesRemoved === true,
    reference: summarizeBrowserShutdown(teardown?.reference),
    referenceBrowserClosed: teardown?.referenceBrowserClosed === true,
    server: {
      errorPresent: Boolean(teardown?.server?.error),
      present: teardown?.server?.present === true,
      processClosed: teardown?.server?.processClosed === true,
    },
    serverClosed: teardown?.serverClosed === true,
  };
  const failures = [
    ...(runnerFailure
      ? ["The bounded network diagnostic runner reported a failure."]
      : []),
    ...(!networkDiagnostic
      ? ["The bounded network diagnostic did not capture its fixed-point state."]
      : []),
    ...(networkDiagnostic && !fixedPointHealthy
      ? ["The bounded network diagnostic did not reach a fixed point."]
      : []),
    ...(!fixtureBound
      ? ["The bounded network diagnostic fixture is not the exact public fixture."]
      : []),
    ...(!screenshotBound
      ? ["The bounded network diagnostic screenshot manifest is not exact."]
      : []),
    ...(teardownFailed
      ? ["Owned diagnostic browser/server/CDP resources did not tear down cleanly."]
      : []),
  ];
  return {
    artifacts: {
      deploymentId: build?.localManifest?.deploymentId ?? null,
      screenshots: screenshotBound ? [screenshot] : [],
      sourceCommit: source?.commit ?? null,
      sourceTree: source?.tree ?? null,
    },
    build,
    completed:
      Boolean(networkDiagnostic) &&
      fixtureBound &&
      screenshotBound &&
      !teardownFailed,
    diagnostic: true,
    diagnosticSchemaVersion: 1,
    failures,
    fixture: fixtureBound ? fixture : null,
    fixedPointReached: fixedPointHealthy,
    mode: "first-network-fixed-point",
    network: networkDiagnostic,
    recordedAt: new Date().toISOString(),
    scenario: {
      configurationId: scenario?.id ?? null,
      screenshot: screenshotBound ? screenshot : null,
    },
    source,
    teardown: teardownSummary,
  };
}

function fixedDiagnosticCategory(value) {
  const text = String(value ?? "");
  if (/AbortError|cancel/u.test(text)) return "cancellation";
  if (/worker/u.test(text)) return "worker-runtime";
  if (/library/u.test(text)) return "library-runtime";
  return text ? "other-runtime" : "none";
}

function fixedNoticeCategory(value) {
  const text = String(value ?? "");
  if (!text) return "none";
  if (/operation was replaced/u.test(text)) return "operation-replaced";
  if (/private library/u.test(text)) return "library-open-failed";
  if (/OffscreenCanvas|cooperative visible-page rendering/u.test(text)) {
    return "render-fallback";
  }
  if (/could not be opened|stopped unexpectedly/u.test(text)) {
    return "document-open-failed";
  }
  return "other-present";
}

export function summarizeFallbackImportLifecycle(capture, fixture) {
  const boundary = capture?.boundary ?? {};
  const snapshot = capture?.snapshot ?? {};
  const workerEvents = Array.isArray(snapshot.workerEvents)
    ? snapshot.workerEvents
    : [];
  const sourceFiles = Array.isArray(snapshot.sourceFiles)
    ? snapshot.sourceFiles.slice(boundary.sourceFileStart ?? 0)
    : [];
  const workerLifecycle = Array.isArray(snapshot.workerLifecycle)
    ? snapshot.workerLifecycle.slice(boundary.workerLifecycleStart ?? 0)
    : [];
  const outcome = [
    "import-request-timeout",
    "import-chain-timeout",
    "import-chain-reached",
  ].includes(capture?.outcome)
    ? capture.outcome
    : "invalid";
  const afterWorkerEvent = (event) =>
    Number.isInteger(event?.eventId) &&
    event.eventId > Number(boundary.workerEventStart ?? 0);
  const boundaryValid =
    Number.isInteger(boundary?.sourceFileStart) &&
    boundary.sourceFileStart >= 0 &&
    Number.isInteger(boundary?.workerEventStart) &&
    boundary.workerEventStart >= 0 &&
    Number.isInteger(boundary?.workerLifecycleStart) &&
    boundary.workerLifecycleStart >= 0 &&
    Number.isFinite(boundary?.startedAt) &&
    boundary.sourceFileStart <= (snapshot.sourceFiles?.length ?? -1) &&
    boundary.workerEventStart <= workerEvents.length &&
    boundary.workerLifecycleStart <= (snapshot.workerLifecycle?.length ?? -1);
  const importRequests = workerEvents.filter(
    (event) =>
      afterWorkerEvent(event) &&
      event.direction === "to-worker" &&
      event.type === "import",
  );
  const importRequest = importRequests[0] ?? null;
  const importEventId = importRequest?.eventId ?? Number.POSITIVE_INFINITY;
  const matchingEvent = (event) =>
    Number.isInteger(importRequest?.jobId) &&
    Number.isInteger(importRequest?.workerInstanceId) &&
    importRequest.workerInstanceId > 0 &&
    typeof importRequest?.revision === "string" &&
    event?.eventId > importEventId &&
    event?.jobId === importRequest.jobId &&
    event?.revision === importRequest.revision &&
    event?.workerInstanceId === importRequest.workerInstanceId;
  const pageEvents = workerEvents.filter(
    (event) =>
      matchingEvent(event) &&
      event.direction === "from-worker" &&
      event.type === "page" &&
      event.documentKey === importRequest?.documentKey,
  );
  const progressEvents = workerEvents.filter(
    (event) =>
      matchingEvent(event) &&
      event.direction === "from-worker" &&
      event.type === "progress",
  );
  const completeEvents = workerEvents.filter(
    (event) =>
      matchingEvent(event) &&
      event.direction === "from-worker" &&
      event.type === "complete" &&
      event.documentKey === importRequest?.documentKey,
  );
  const fallbackEvents = workerEvents.filter(
    (event) =>
      matchingEvent(event) &&
      event.direction === "from-worker" &&
      event.type === "render-fallback",
  );
  const laterStartEvents = workerEvents.filter(
    (event) =>
      event?.eventId > importEventId &&
      event.direction === "to-worker" &&
      ["import", "open"].includes(event.type),
  );
  const pageNumbers = pageEvents.map((event) => event.pageNumber);
  const progressPages = progressEvents.map((event) => event.completedPages);
  const terminalProgressEvents = progressEvents.filter(
    (event) => event.completedPages === 6 && event.pageCount === 6,
  );
  const pageOne = pageEvents.find((event) => event.pageNumber === 1) ?? null;
  const terminalProgress = terminalProgressEvents[0] ?? null;
  const complete = completeEvents[0] ?? null;
  const fallback = fallbackEvents[0] ?? null;
  const documentKey = importRequest?.documentKey;
  const revision = importRequest?.revision;
  const documentId =
    typeof documentKey === "string" &&
    typeof revision === "string" &&
    documentKey.endsWith(`:${revision}`)
      ? documentKey.slice(0, -(revision.length + 1))
      : null;
  const workerInstanceId = importRequest?.workerInstanceId ?? null;
  const lifecycleForImport = workerLifecycle.filter(
    (event) => event?.workerInstanceId === workerInstanceId,
  );
  const constructedEvents = lifecycleForImport.filter(
    (event) => event.type === "constructed",
  );
  const importPostEvents = lifecycleForImport.filter(
    (event) =>
      event.type === "post-message" &&
      event.messageType === "import" &&
      event.jobId === importRequest?.jobId &&
      event.revision === revision &&
      event.documentKey === documentKey,
  );
  const firstMessageEvents = lifecycleForImport.filter(
    (event) => event.type === "first-message",
  );
  const constructed = constructedEvents[0] ?? null;
  const importPost = importPostEvents[0] ?? null;
  const firstMessage = firstMessageEvents[0] ?? null;
  const lifecycleFailures = lifecycleForImport.filter(
    (event) => ["error", "message-error"].includes(event.type),
  );
  const terminatedBeforeComplete = lifecycleForImport.some(
    (event) =>
      event.type === "terminated" &&
      (!complete || Number(event.at) <= Number(complete.at)),
  );
  const source = sourceFiles[0] ?? null;
  const sourceBound =
    sourceFiles.length === 1 &&
    source?.size === PUBLIC_PDF_FIXTURE_BYTES &&
    source?.sha256 === PUBLIC_PDF_FIXTURE_SHA256 &&
    fixture?.bytes === PUBLIC_PDF_FIXTURE_BYTES &&
    fixture?.sha256 === PUBLIC_PDF_FIXTURE_SHA256;
  const exactPages =
    pageEvents.length === 6 &&
    new Set(pageNumbers).size === 6 &&
    [1, 2, 3, 4, 5, 6].every((page) => pageNumbers.includes(page));
  const exactProgress =
    progressEvents.length === 6 &&
    new Set(progressPages).size === 6 &&
    [1, 2, 3, 4, 5, 6].every((page) => progressPages.includes(page)) &&
    terminalProgressEvents.length === 1;
  const exactOrdering = Boolean(
    importRequest &&
    pageOne &&
    fallback &&
    terminalProgress &&
    complete &&
    importRequest.eventId < pageOne.eventId &&
    pageOne.eventId < fallback.eventId &&
    fallback.eventId < terminalProgress.eventId &&
    terminalProgress.eventId < complete.eventId,
  );
  const dom = capture?.dom ?? {};
  const runtimeErrorCategories = (snapshot.errors ?? []).map(
    fixedDiagnosticCategory,
  );
  const noticeCategories = (snapshot.notices ?? []).map(
    (notice) => fixedNoticeCategory(notice?.text),
  );
  const importedDocumentIdentityHash = documentId
    ? cdpDiagnosticIdentity(documentId)
    : null;
  const importCompleted = Boolean(
    boundaryValid &&
    outcome === "import-chain-reached" &&
    capture?.importRequestObserved === true &&
    importRequests.length === 1 &&
    Number(importRequest?.at) >= Number(boundary.startedAt) &&
    sourceBound &&
    Number(source?.at) >= Number(boundary.startedAt) &&
    source?.eventId === boundary.sourceFileStart + 1 &&
    exactPages &&
    exactProgress &&
    completeEvents.length === 1 &&
    fallbackEvents.length === 1 &&
    laterStartEvents.length === 0 &&
    exactOrdering &&
    constructedEvents.length === 1 &&
    importPostEvents.length === 1 &&
    firstMessageEvents.length === 1 &&
    constructed?.wrapped === true &&
    constructed?.forceFallback === true &&
    Number(constructed?.at) >= Number(boundary.startedAt) &&
    importPost &&
    Number(importPost.at) >= Number(constructed.at) &&
    firstMessage?.messageType === "page" &&
    firstMessage?.pageNumber === 1 &&
    Number(firstMessage.at) >= Number(importPost.at) &&
    Number(complete?.at) >= Number(firstMessage.at) &&
    firstMessage?.jobId === importRequest.jobId &&
    firstMessage?.revision === revision &&
    firstMessage?.documentKey === documentKey &&
    lifecycleFailures.length === 0 &&
    !terminatedBeforeComplete &&
    runtimeErrorCategories.length === 0 &&
    noticeCategories.includes("render-fallback") &&
    noticeCategories.every((category) => category === "render-fallback") &&
    Number.isFinite(snapshot?.fallback?.signalAt) &&
    dom.pageViewPresent === true &&
    dom.fallbackActive === true &&
    dom.pageOnePresent === true &&
    dom.pageOneVisible === true &&
    dom.pageOneWordOverlayCount >= 20 &&
    dom.pageOneCanvasSource === "main-fallback" &&
    dom.pageOneCanvasWidth > 0 &&
    dom.pageOneCanvasHeight > 0 &&
    dom.loadingPageCount === 0 &&
    dom.noticeCategory === "render-fallback" &&
    dom.noticePresent === true &&
    capture?.libraryAfter?.available === true &&
    capture.libraryAfter.activeDocumentPresent === true &&
    capture?.libraryAfter?.activeDocumentIdentityHash ===
      importedDocumentIdentityHash,
  );
  return {
    chain: {
      completeEventCount: completeEvents.length,
      exactOrdering,
      fallbackEventCount: fallbackEvents.length,
      fallbackSignalObserved: Number.isFinite(snapshot?.fallback?.signalAt),
      pageEventCount: pageEvents.length,
      pageNumbers: [...new Set(pageNumbers)].sort((left, right) => left - right),
      progressEventCount: progressEvents.length,
      progressPages: [...new Set(progressPages)].sort((left, right) => left - right),
      terminalProgressEventCount: terminalProgressEvents.length,
    },
    dom,
    importCompleted,
    importIdentity: importRequest
      ? {
          documentIdentityHash: importedDocumentIdentityHash,
          identityHash: cdpDiagnosticIdentity(
            importRequest.workerInstanceId,
            importRequest.jobId,
            documentKey,
            revision,
          ),
          jobId: importRequest.jobId,
          requestEventId: importRequest.eventId,
          revisionIdentityHash: cdpDiagnosticIdentity(revision),
          workerInstanceId,
        }
      : null,
    importRequestCount: importRequests.length,
    laterStartCount: laterStartEvents.length,
    libraryAfter: capture?.libraryAfter ?? null,
    libraryBefore: capture?.libraryBefore ?? null,
    noticeCategories: [...new Set(noticeCategories)],
    outcome,
    runtimeErrorCategories: [...new Set(runtimeErrorCategories)],
    source: sourceBound
      ? { bytes: source.size, sha256: source.sha256 }
      : null,
    sourceSelectionCount: sourceFiles.length,
    worker: {
      constructed: Boolean(constructed),
      firstMessageType: firstMessage?.messageType ?? null,
      lifecycleFailureCount: lifecycleFailures.length,
      postBound: Boolean(importPost),
      terminatedBeforeComplete,
      wrapped: constructed?.wrapped === true,
    },
    workerLifecycle: workerLifecycle.map((event, index) => ({
      category: event.category ?? null,
      documentIdentityHash:
        typeof event.documentKey === "string" &&
        typeof event.revision === "string" &&
        event.documentKey.endsWith(`:${event.revision}`)
          ? cdpDiagnosticIdentity(
              event.documentKey.slice(0, -(event.revision.length + 1)),
            )
          : null,
      forceFallback: event.forceFallback === true,
      identityHash: cdpDiagnosticIdentity(event.workerInstanceId),
      jobId: event.jobId ?? null,
      messageType: event.messageType ?? null,
      pageNumber: event.pageNumber ?? null,
      sequence: index + 1,
      type: event.type,
      urlClass: event.urlClass,
      workerInstanceId: event.workerInstanceId,
      wrapped: event.wrapped === true,
    })),
  };
}

export function isFallbackImportNetworkDiagnosticHealthy(
  diagnostic,
  boundary,
  expectedWorkerInstanceId,
) {
  const targets = Array.isArray(diagnostic?.targets) ? diagnostic.targets : [];
  const settlements = Array.isArray(diagnostic?.targetBootstrapSettlements)
    ? diagnostic.targetBootstrapSettlements
    : [];
  const observations = Array.isArray(
    diagnostic?.serviceWorkerBootstrapObservations,
  )
    ? diagnostic.serviceWorkerBootstrapObservations
    : [];
  const counts = diagnostic?.counts ?? {};
  const targetStart = boundary?.targetCount;
  const settlementStart = boundary?.settlementCount;
  const requestStart = boundary?.requestCount;
  const attachStart = boundary?.attachPromiseCount;
  const validBoundary =
    [targetStart, settlementStart, requestStart, attachStart].every(
      (value) => Number.isInteger(value) && value >= 0,
    ) &&
    targetStart === attachStart &&
    targetStart <= targets.length &&
    settlementStart <= settlements.length &&
    requestStart <= counts.requestCount;
  const newTargets = validBoundary ? targets.slice(targetStart) : [];
  const postBoundarySettlements = validBoundary
    ? settlements.slice(settlementStart)
    : [];
  const blobTargets = newTargets.filter(
    (target) => target?.type === "worker" && target?.urlClass === "blob",
  );
  const parserTargets = newTargets.filter(
    (target) =>
      target?.type === "worker" && target?.urlClass === "pdf-parser-worker",
  );
  const importBlobTargets = blobTargets.filter(
    (target) => target?.workerInstanceId === expectedWorkerInstanceId,
  );
  const importBlobTarget = importBlobTargets[0] ?? null;
  const importParserTargets = parserTargets.filter(
    (target) => target?.parentSessionId === importBlobTarget?.sessionId,
  );
  const nonEmptyString = (value) =>
    typeof value === "string" && value.length > 0;
  const targetSessions = targets.map((target) => target?.sessionId);
  const targetIds = targets.map((target) => target?.targetId);
  const commandIds = targets.flatMap((target) =>
    Array.isArray(target?.commands)
      ? target.commands.map((command) => command?.cdpId)
      : []
  );
  const targetBySession = new Map(
    targets.map((target) => [target?.sessionId, target]),
  );
  const validTargets =
    targetSessions.every(nonEmptyString) &&
    new Set(targetSessions).size === targetSessions.length &&
    targetIds.every(nonEmptyString) &&
    new Set(targetIds).size === targetIds.length &&
    new Set(commandIds).size === commandIds.length &&
    targets.every(
      (target) =>
        isCdpTargetSetupComplete(target) &&
        nonEmptyString(target?.phase) &&
        nonEmptyString(target?.type) &&
        target?.identityHash === cdpDiagnosticIdentity(
          target.sessionId,
          target.targetId,
        ),
    );
  const serviceWorkerTargets = targets.filter(
    (target) => target?.type === "service_worker",
  );
  const validServiceWorkerObservations =
    serviceWorkerTargets.length > 0 &&
    observations.length === serviceWorkerTargets.length &&
    new Set(observations.map((entry) => entry?.targetSessionId)).size ===
      observations.length &&
    observations.every((entry) => {
      const target = targetBySession.get(entry?.targetSessionId);
      return (
        target?.type === "service_worker" &&
        entry?.identityHash === cdpDiagnosticIdentity(
          entry.requestSessionId,
          entry.requestId,
          entry.targetSessionId,
          entry.targetId,
        ) &&
        nonEmptyString(entry?.requestId) &&
        entry?.requestSessionId === target.sessionId &&
        entry?.targetId === target.targetId &&
        entry?.targetDetachedAtObservation === false &&
        entry?.targetType === target.type &&
        entry?.phase === target.phase &&
        entry?.method === "GET" &&
        entry?.resourceType === "Script" &&
        entry?.urlClass === target.urlClass &&
        entry?.targetUrlMatched === true &&
        entry?.requestIsFirst === true &&
        Number.isInteger(entry?.requestSequence) &&
        entry.requestSequence > 0 &&
        entry?.resumeDispatchedAt === target.resumeDispatchedAt &&
        Number.isFinite(entry?.requestStartedAt) &&
        entry.requestStartedAt >= entry.resumeDispatchedAt &&
        entry?.earlierRequestCount === 0 &&
        Number.isInteger(entry?.sessionRequestCount) &&
        entry.sessionRequestCount > 0 &&
        entry?.sessionFailureCount === 0 &&
        entry?.terminalReason === "loading-finished" &&
        Number.isFinite(entry?.terminalAt) &&
        entry.terminalAt >= entry.requestStartedAt
      );
    });
  const newTargetBySession = new Map(
    newTargets.map((target) => [target?.sessionId, target]),
  );
  const validPostBoundarySettlements =
    new Set(
      postBoundarySettlements.map((entry) => entry?.targetSessionId),
    ).size === postBoundarySettlements.length &&
    new Set(
      postBoundarySettlements.map(
        (entry) => JSON.stringify([
          entry?.requestSessionId ?? null,
          entry?.requestId,
        ]),
      ),
    ).size === postBoundarySettlements.length &&
    postBoundarySettlements.every((entry) => {
      const target = newTargetBySession.get(entry?.targetSessionId);
      return (
        target?.type === "worker" &&
        nonEmptyString(entry?.requestId) &&
        (entry?.requestSessionId === null ||
          nonEmptyString(entry?.requestSessionId)) &&
        entry?.identityHash === cdpDiagnosticIdentity(
          entry.requestSessionId,
          entry.requestId,
          entry.targetSessionId,
          entry.targetId,
        ) &&
        entry?.targetId === target.targetId &&
        entry?.targetParentSessionId === target.parentSessionId &&
        entry?.requestSessionId === target.parentSessionId &&
        entry?.phase === FALLBACK_IMPORT_DIAGNOSTIC_LABEL &&
        entry?.phase === target.phase &&
        entry?.method === "GET" &&
        entry?.resourceType === "Script" &&
        entry?.targetType === target.type &&
        entry?.urlClass === target.urlClass &&
        entry?.targetDetachedAtSettlement === false &&
        entry?.terminalReason === "target-attached"
      );
    });
  const currentTargets = [importBlobTarget, ...importParserTargets].filter(
    Boolean,
  );
  const currentTargetSessions = new Set(
    currentTargets.map((target) => target.sessionId),
  );
  const currentSettlements = postBoundarySettlements.filter((entry) =>
    currentTargetSessions.has(entry?.targetSessionId)
  );
  const currentBlobSettlement = currentSettlements.find(
    (entry) => entry?.targetSessionId === importBlobTarget?.sessionId,
  );
  const currentParserTarget = importParserTargets[0] ?? null;
  const currentParserSettlement = currentSettlements.find(
    (entry) => entry?.targetSessionId === currentParserTarget?.sessionId,
  );
  const validCurrentSettlements =
    importBlobTargets.length === 1 &&
    importParserTargets.length === 1 &&
    currentSettlements.length === 2 &&
    currentTargets.every(
      (target) =>
        currentSettlements.filter(
          (entry) => entry?.targetSessionId === target.sessionId,
        ).length === 1,
    ) &&
    importBlobTarget?.parentSessionId === null &&
    currentBlobSettlement?.targetParentSessionId === null &&
    currentBlobSettlement?.requestSessionId === null &&
    currentParserTarget?.parentSessionId === importBlobTarget?.sessionId &&
    currentParserSettlement?.targetParentSessionId === importBlobTarget?.sessionId &&
    currentParserSettlement?.requestSessionId === importBlobTarget?.sessionId;
  const stableTail = Array.isArray(diagnostic?.wait?.recentSamples)
    ? diagnostic.wait.recentSamples.slice(-CDP_FIXED_POINT_STABLE_SAMPLES)
    : [];
  return (
    validBoundary &&
    diagnostic?.label === FALLBACK_IMPORT_DIAGNOSTIC_LABEL &&
    diagnostic?.outcome === "fixed-point-reached" &&
    diagnostic?.serviceWorkerBypassed === true &&
    diagnostic?.counts?.attachErrorCount === 0 &&
    diagnostic?.counts?.pendingAttachCount === 0 &&
    diagnostic?.counts?.inflightRequestCount === 0 &&
    diagnostic?.counts?.externalRequestCount === 0 &&
    diagnostic?.counts?.networkFailureCount === 0 &&
    counts.attachPromiseCount === targets.length &&
    counts.completedRequestCount === counts.requestCount &&
    Number.isInteger(counts.requestCount) &&
    counts.requestCount > requestStart &&
    counts.serviceWorkerBootstrapObservationCount === observations.length &&
    counts.targetBootstrapSettlementCount === settlements.length &&
    counts.targetCount === targets.length &&
    Array.isArray(diagnostic?.attachErrors) &&
    diagnostic.attachErrors.length === 0 &&
    Array.isArray(diagnostic?.pendingAttaches) &&
    diagnostic.pendingAttaches.length === 0 &&
    Array.isArray(diagnostic?.inflightRequests) &&
    diagnostic.inflightRequests.length === 0 &&
    diagnostic?.initialTargetBaseline?.checked === true &&
    diagnostic.initialTargetBaseline.pageCount === 1 &&
    diagnostic.initialTargetBaseline.pageUrlClass === "about" &&
    diagnostic.initialTargetBaseline.targetCount === 1 &&
    diagnostic.initialTargetBaseline.workerCount === 0 &&
    validTargets &&
    validServiceWorkerObservations &&
    targets.length > targetStart &&
    newTargets.every(
      (target) => target?.phase === FALLBACK_IMPORT_DIAGNOSTIC_LABEL,
    ) &&
    blobTargets.length >= 1 &&
    parserTargets.length >= 1 &&
    Number.isInteger(expectedWorkerInstanceId) &&
    expectedWorkerInstanceId > 0 &&
    importBlobTargets.length === 1 &&
    importParserTargets.length === 1 &&
    parserTargets.every((target) => {
      const parent = blobTargets.find(
        (candidate) => candidate.sessionId === target.parentSessionId,
      );
      const directAncestor = Array.isArray(target?.ancestry)
        ? target.ancestry[0]
        : null;
      return (
        parent &&
        target.phase === FALLBACK_IMPORT_DIAGNOSTIC_LABEL &&
        Array.isArray(target.ancestry) &&
        target.ancestry.length === 1 &&
        directAncestor?.sessionId === parent.sessionId &&
        directAncestor?.phase === parent.phase &&
        directAncestor?.type === parent.type &&
        directAncestor?.urlClass === parent.urlClass &&
        postBoundarySettlements.some(
          (settlement) =>
            settlement?.targetSessionId === target.sessionId &&
            settlement?.terminalReason === "target-attached",
        )
      );
    }) &&
    validPostBoundarySettlements &&
    validCurrentSettlements &&
    diagnostic?.wait?.requiredStableSamples ===
      CDP_FIXED_POINT_STABLE_SAMPLES &&
    diagnostic?.wait?.stableSamples === CDP_FIXED_POINT_STABLE_SAMPLES &&
    stableTail.length === CDP_FIXED_POINT_STABLE_SAMPLES &&
    stableTail.every(
      (sample, index) =>
        sample?.attachmentReady === true &&
        sample?.attachErrorCount === 0 &&
        sample?.incompleteTargetCount === 0 &&
        sample?.pendingAttachCount === 0 &&
        sample?.inflightRequestCount === 0 &&
        sample?.serviceWorkerBypassed === true &&
        sample?.requestCount === counts.requestCount &&
        sample?.targetCount === counts.targetCount &&
        sample?.stableSamples === index + 1,
    )
  );
}

function fixedSha256(value) {
  return /^[a-f0-9]{64}$/u.test(value ?? "") ? value : null;
}

function fixedNonnegativeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function summarizeFallbackDiagnosticSetup(setup) {
  const source = setup?.source ?? {};
  const library = setup?.library ?? {};
  const documentIdentityHash = fixedSha256(setup?.documentIdentityHash);
  const sourceSummary = {
    bytes: fixedNonnegativeCount(source?.bytes),
    sha256: fixedSha256(source?.sha256),
  };
  const librarySummary = {
    activeDocumentIdentityHash: fixedSha256(
      library?.activeDocumentIdentityHash,
    ),
    activeDocumentPresent: library?.activeDocumentPresent === true,
    available: library?.available === true,
    documentCount: fixedNonnegativeCount(library?.documentCount),
    entryCount: fixedNonnegativeCount(library?.entryCount),
    errorCategory: library?.errorCategory === "indexeddb-read"
      ? "indexeddb-read"
      : "none",
    pageCount: fixedNonnegativeCount(library?.pageCount),
    pdfEntryCount: fixedNonnegativeCount(library?.pdfEntryCount),
    sourceCount: fixedNonnegativeCount(library?.sourceCount),
  };
  const pageEventCount = fixedNonnegativeCount(setup?.pageEventCount);
  const completeEventCount = fixedNonnegativeCount(setup?.completeEventCount);
  const sourceSelectionCount = fixedNonnegativeCount(
    setup?.sourceSelectionCount,
  );
  const conditions = {
    fileSelected: setup?.fileSelected === true,
    libraryBound: Boolean(
      librarySummary.available &&
      librarySummary.activeDocumentPresent &&
      librarySummary.activeDocumentIdentityHash === documentIdentityHash &&
      librarySummary.documentCount >= 1 &&
      librarySummary.entryCount >= 1 &&
      librarySummary.pageCount >= 6 &&
      librarySummary.pdfEntryCount >= 1 &&
      librarySummary.sourceCount >= 1
    ),
    librarySnapshotCompleted: setup?.librarySnapshotCompleted === true,
    modelBound: Boolean(
      pageEventCount === 6 &&
      completeEventCount === 1 &&
      documentIdentityHash
    ),
    navigationCompleted: setup?.navigationCompleted === true,
    networkFixedPointReached: setup?.networkFixedPointReached === true,
    sourceBound: Boolean(
      sourceSelectionCount === 1 &&
      sourceSummary.bytes === PUBLIC_PDF_FIXTURE_BYTES &&
      sourceSummary.sha256 === PUBLIC_PDF_FIXTURE_SHA256
    ),
  };
  return {
    bound: Object.values(conditions).every(Boolean),
    completeEventCount,
    conditions,
    documentIdentityHash,
    library: librarySummary,
    pageEventCount,
    source: sourceSummary,
    sourceSelectionCount,
  };
}

export function summarizeFallbackDiagnosticProgress(progress, runnerFailure) {
  const allowedStages = new Set(FALLBACK_IMPORT_DIAGNOSTIC_STAGES);
  const rawHistory = Array.isArray(progress?.history) ? progress.history : [];
  const history = rawHistory.map((stage) =>
    allowedStages.has(stage) ? stage : "invalid"
  );
  const terminalStage = allowedStages.has(progress?.terminalStage)
    ? progress.terminalStage
    : progress?.terminalStage == null
      ? null
      : "invalid";
  const sequenceComplete =
    history.length === FALLBACK_IMPORT_DIAGNOSTIC_STAGES.length &&
    history.every(
      (stage, index) => stage === FALLBACK_IMPORT_DIAGNOSTIC_STAGES[index],
    ) &&
    terminalStage === FALLBACK_IMPORT_DIAGNOSTIC_STAGES.at(-1);
  let errorCategory = "none";
  if (runnerFailure) {
    if (terminalStage === "invalid") {
      errorCategory = "invalid-stage-failure";
    } else if (terminalStage?.endsWith("-started")) {
      errorCategory = `${terminalStage.slice(0, -"-started".length)}-failure`;
    } else if (terminalStage === null) {
      errorCategory = "pre-diagnostic-failure";
    } else {
      errorCategory = "stage-transition-failure";
    }
  } else if (!sequenceComplete) {
    errorCategory = "missing-stage";
  }
  return {
    errorCategory,
    history,
    sequenceComplete,
    terminalStage,
  };
}

export function buildFallbackImportDiagnosticReport({
  build,
  capture,
  diagnosticProgress,
  fixture,
  networkDiagnostic,
  outputDirectory,
  recordedAt = new Date().toISOString(),
  runnerFailure,
  setup,
  source,
  teardown,
}) {
  const expectedFixturePath = path.relative(
    REPOSITORY_ROOT,
    path.resolve(DEFAULT_PDF_HIGHLIGHT_FIXTURE),
  );
  const fixtureBound =
    fixture?.path === expectedFixturePath &&
    fixture?.bytes === PUBLIC_PDF_FIXTURE_BYTES &&
    fixture?.sha256 === PUBLIC_PDF_FIXTURE_SHA256;
  const outputIsExternal = isOutsideRepository(outputDirectory);
  const screenshot = capture?.screenshot ?? null;
  const expectedScreenshotPath = outputIsExternal
    ? path.relative(
        REPOSITORY_ROOT,
        path.join(outputDirectory, FALLBACK_IMPORT_DIAGNOSTIC_SCREENSHOT),
      )
    : null;
  const screenshotBound =
    outputIsExternal &&
    screenshot?.path === expectedScreenshotPath &&
    Number.isInteger(screenshot?.bytes) &&
    screenshot.bytes > 0 &&
    /^[a-f0-9]{64}$/u.test(screenshot?.sha256 ?? "");
  const publicScreenshot = screenshotBound
    ? { ...screenshot, path: FALLBACK_IMPORT_DIAGNOSTIC_SCREENSHOT }
    : null;
  const teardownFailed =
    teardown?.app?.present !== true ||
    teardown?.app?.cdpClosed !== true ||
    teardown?.app?.processClosed !== true ||
    teardown?.app?.profileRemoved !== true ||
    Boolean(teardown?.app?.error) ||
    teardown?.reference?.cdpClosed !== true ||
    teardown?.reference?.processClosed !== true ||
    teardown?.reference?.profileRemoved !== true ||
    Boolean(teardown?.reference?.error) ||
    teardown?.server?.present !== true ||
    teardown?.server?.processClosed !== true ||
    Boolean(teardown?.server?.error) ||
    teardown?.browserClosed !== true ||
    teardown?.cdpClosed !== true ||
    teardown?.profilesRemoved !== true ||
    teardown?.serverClosed !== true ||
    teardown?.errors?.length > 0;
  const setupSummary = summarizeFallbackDiagnosticSetup(setup);
  const setupBound = setupSummary.bound;
  const progressSummary = summarizeFallbackDiagnosticProgress(
    diagnosticProgress,
    runnerFailure,
  );
  const lifecycle = summarizeFallbackImportLifecycle(capture, fixture);
  const networkHealthy = isFallbackImportNetworkDiagnosticHealthy(
    networkDiagnostic,
    capture?.networkBoundary,
    lifecycle.importIdentity?.workerInstanceId,
  );
  const failures = [
    ...(runnerFailure
      ? ["The bounded fallback-import diagnostic runner reported a failure."]
      : []),
    ...(!progressSummary.sequenceComplete
      ? ["The fallback-import diagnostic stage sequence is incomplete or invalid."]
      : []),
    ...(!fixtureBound
      ? ["The fallback-import diagnostic fixture is not the exact public fixture."]
      : []),
    ...(!setupBound
      ? ["The fallback-import diagnostic did not persist the exact setup PDF."]
      : []),
    ...(!lifecycle.importCompleted
      ? ["The post-navigation fallback import did not complete its exact bound chain."]
      : []),
    ...(!networkHealthy
      ? ["The fallback-import diagnostic CDP lifecycle did not settle cleanly."]
      : []),
    ...(!screenshotBound
      ? ["The fallback-import diagnostic screenshot manifest is not exact."]
      : []),
    ...(teardownFailed
      ? ["Owned fallback diagnostic resources did not tear down cleanly."]
      : []),
  ];
  return {
    artifacts: {
      deploymentId: build?.localManifest?.deploymentId ?? null,
      screenshots: publicScreenshot ? [publicScreenshot] : [],
      sourceCommit: source?.commit ?? null,
      sourceTree: source?.tree ?? null,
    },
    build,
    completed:
      progressSummary.sequenceComplete &&
      fixtureBound &&
      screenshotBound &&
      !teardownFailed,
    diagnostic: true,
    diagnosticSchemaVersion: 1,
    execution: progressSummary,
    failures,
    fixture: fixtureBound ? fixture : null,
    importCompleted: lifecycle.importCompleted,
    lifecycle,
    mode: "fallback-import-lifecycle",
    network: networkDiagnostic,
    networkSettled: networkHealthy,
    recordedAt,
    setup: setupSummary,
    source,
    teardown: {
      app: {
        cdpClosed: teardown?.app?.cdpClosed === true,
        errorPresent: Boolean(teardown?.app?.error),
        present: teardown?.app?.present === true,
        processClosed: teardown?.app?.processClosed === true,
        profileRemoved: teardown?.app?.profileRemoved === true,
      },
      browserClosed: teardown?.browserClosed === true,
      cdpClosed: teardown?.cdpClosed === true,
      errorCount: Array.isArray(teardown?.errors) ? teardown.errors.length : 0,
      profilesRemoved: teardown?.profilesRemoved === true,
      reference: {
        cdpClosed: teardown?.reference?.cdpClosed === true,
        errorPresent: Boolean(teardown?.reference?.error),
        present: teardown?.reference?.present === true,
        processClosed: teardown?.reference?.processClosed === true,
        profileRemoved: teardown?.reference?.profileRemoved === true,
      },
      server: {
        errorPresent: Boolean(teardown?.server?.error),
        present: teardown?.server?.present === true,
        processClosed: teardown?.server?.processClosed === true,
      },
      serverClosed: teardown?.serverClosed === true,
    },
  };
}

export function planPdfVirtualScroll({
  clientHeight,
  mountedPages,
  scrollHeight,
  scrollTop,
  targetPage,
  visiblePages,
}) {
  const mounted = (mountedPages ?? []).filter(Number.isInteger);
  const visible = (visiblePages ?? []).filter(Number.isInteger);
  const anchors = visible.length ? visible : mounted;
  const minimum = Math.min(...anchors);
  const maximum = Math.max(...anchors);
  const midpoint = (minimum + maximum) / 2;
  const direction = targetPage < minimum || targetPage < midpoint ? -1 : 1;
  const maximumScrollTop = Math.max(0, scrollHeight - clientHeight);
  const step = Math.max(1, Math.floor(clientHeight * 0.5));
  return {
    direction,
    nextScrollTop: Math.min(
      maximumScrollTop,
      Math.max(0, scrollTop + direction * step),
    ),
  };
}

function parseArguments(argv) {
  const options = {
    browser: process.env.LINELIGHT_BROWSER ?? "/usr/bin/brave-browser",
    diagnoseFallbackImport: false,
    diagnoseFirstNetworkFixedPoint: false,
    diagnoseReferenceCapture: false,
    fixture: DEFAULT_PDF_HIGHLIGHT_FIXTURE,
    outputDirectory:
      process.env.LINELIGHT_PDF_SHARPNESS_EVIDENCE ??
      DEFAULT_OUTPUT_DIRECTORY,
    outputProvided: false,
    record: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--browser") options.browser = argv[++index];
    else if (argument === "--diagnose-fallback-import") {
      options.diagnoseFallbackImport = true;
    }
    else if (argument === "--diagnose-first-network-fixed-point") {
      options.diagnoseFirstNetworkFixedPoint = true;
    }
    else if (argument === "--diagnose-reference-capture") {
      options.diagnoseReferenceCapture = true;
    }
    else if (argument === "--fixture") options.fixture = argv[++index];
    else if (argument === "--output") {
      options.outputDirectory = argv[++index];
      options.outputProvided = true;
    }
    else if (argument === "--record") options.record = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        [
          "Usage: node scripts/run-pdf-sharpness-browser-regression.mjs [options]",
          "",
          "Builds and opens LineLight in headed Brave, compares the original PDF",
          "with the imported page across desktop/mobile zoom and DPR, and writes",
          "Issue #68 sharpness, priority, memory, fallback, privacy, and teardown evidence.",
          "",
          "  --browser PATH   Brave/Chromium executable.",
          "  --diagnose-fallback-import",
          "                   Persist once, reload in fallback mode, re-import, then cleanup.",
          "  --diagnose-first-network-fixed-point",
          "                   Stop after the first matrix network gate and cleanup.",
          "  --diagnose-reference-capture",
          "                   Capture two stable native-viewer frames for the first desktop case.",
          "  --fixture PATH   Selectable-text PDF used for both original and import.",
          "  --output DIR     Transient evidence directory.",
          "  --record         Write review evidence to docs/evidence/issue-68/.",
          "",
          "Acceptance and app diagnostics make a fresh production build and own",
          "their loopback server; reference capture opens only one visible browser",
          "for the native viewer. Every mode refuses a dirty source tree.",
          "",
        ].join("\n"),
      );
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.record && options.diagnoseFirstNetworkFixedPoint) {
    throw new Error(
      "First-network diagnostic mode cannot be combined with --record.",
    );
  }
  if (options.record && options.diagnoseFallbackImport) {
    throw new Error(
      "Fallback-import diagnostic mode cannot be combined with --record.",
    );
  }
  if (options.record && options.diagnoseReferenceCapture) {
    throw new Error(
      "Reference-capture diagnostic mode cannot be combined with --record.",
    );
  }
  const enabledDiagnosticModes = [
    options.diagnoseFirstNetworkFixedPoint,
    options.diagnoseFallbackImport,
    options.diagnoseReferenceCapture,
  ].filter(Boolean).length;
  if (enabledDiagnosticModes > 1) {
    throw new Error("Issue #68 diagnostic modes are mutually exclusive.");
  }
  if (
    enabledDiagnosticModes === 1 &&
    !options.outputProvided
  ) {
    throw new Error(
      "Issue #68 diagnostic mode requires an explicit --output directory.",
    );
  }
  if (options.record) options.outputDirectory = RECORDED_OUTPUT_DIRECTORY;
  options.browser = path.resolve(options.browser);
  options.fixture = path.resolve(options.fixture);
  options.outputDirectory = path.resolve(options.outputDirectory);
  if (
    enabledDiagnosticModes === 1 &&
    options.fixture !== path.resolve(DEFAULT_PDF_HIGHLIGHT_FIXTURE)
  ) {
    throw new Error(
      "Issue #68 diagnostic mode requires the exact repository PDF fixture.",
    );
  }
  if (
    enabledDiagnosticModes === 1 &&
    !isOutsideRepository(options.outputDirectory)
  ) {
    throw new Error(
      "Issue #68 diagnostic output must be outside the source repository.",
    );
  }
  if (
    options.diagnoseReferenceCapture &&
    existsSync(options.outputDirectory)
  ) {
    throw new Error(
      "Reference-capture diagnostic output must be a fresh absent directory.",
    );
  }
  if (
    options.record &&
    options.fixture !== path.resolve(DEFAULT_PDF_HIGHLIGHT_FIXTURE)
  ) {
    throw new Error(
      "Recorded Issue #68 evidence requires the exact repository PDF fixture; " +
      "use --output (without --record) for a private local PDF.",
    );
  }
  return options;
}

async function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

async function fileArtifact(filePath) {
  const details = await stat(filePath);
  return {
    path: path.relative(REPOSITORY_ROOT, filePath),
    bytes: details.size,
    sha256: await sha256File(filePath),
  };
}

function gitOutput(arguments_) {
  return execFileSync("git", arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
}

function gitStatus() {
  const status = gitOutput(["status", "--porcelain", "--untracked-files=normal"]);
  return status ? status.split("\n") : [];
}

async function collectSourceEvidence() {
  const files = {};
  for (const relativeFile of PDF_SHARPNESS_SOURCE_FILES) {
    files[relativeFile] = await sha256File(
      path.join(REPOSITORY_ROOT, relativeFile),
    );
  }
  return {
    commit: gitOutput(["rev-parse", "HEAD"]),
    tree: gitOutput(["rev-parse", "HEAD^{tree}"]),
    preflightStatus: gitStatus(),
    postBuildStatus: null,
    files,
  };
}

function processLog(child, maximumChunks = 160) {
  const chunks = [];
  const collect = (chunk) => {
    chunks.push(chunk.toString());
    if (chunks.length > maximumChunks) chunks.shift();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return () => chunks.join("");
}

async function waitForExit(child, label, timeoutMs, log) {
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.\n${log()}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  if (result.signal || result.code !== 0) {
    throw new Error(
      `${label} exited with ${result.signal ?? result.code}.\n${log()}`,
    );
  }
}

async function buildProductionArtifact() {
  const child = spawn("npm", ["run", "build"], {
    cwd: REPOSITORY_ROOT,
    detached: true,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = processLog(child);
  try {
    await waitForExit(child, "production build", BUILD_TIMEOUT_MS, log);
    return { log: log(), processGroupId: child.pid };
  } catch (error) {
    await stopProcessGroup(child.pid, SHUTDOWN_TIMEOUT_MS);
    throw error;
  }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHttp(url, child, log) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SERVER_TIMEOUT_MS) {
    if (child?.exitCode !== null || child?.signalCode !== null) {
      throw new Error(`production server exited before ${url}.\n${log()}`);
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The loopback listener is still starting.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}.\n${log()}`);
}

async function startProductionServer() {
  const port = await getFreePort();
  const child = spawn(
    "npm",
    [
      "start",
      "--",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--local",
      "--log-level",
      "warn",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: REPOSITORY_ROOT,
      detached: true,
      env: {
        ...process.env,
        BROWSER: "none",
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const log = processLog(child);
  const appUrl = `http://127.0.0.1:${port}/`;
  try {
    await waitForHttp(appUrl, child, log);
    return { appUrl, child, log, processGroupId: child.pid };
  } catch (error) {
    await stopProcessGroup(child.pid, SHUTDOWN_TIMEOUT_MS);
    throw error;
  }
}

async function collectBuildBinding(appUrl, source) {
  const localBytes = await readFile(LOCAL_RUNTIME_MANIFEST);
  const localManifest = JSON.parse(localBytes);
  const response = await fetch(new URL("/runtime-assets.json", appUrl), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`runtime-assets.json returned HTTP ${response.status}.`);
  }
  const servedBytes = Buffer.from(await response.arrayBuffer());
  const servedManifest = JSON.parse(servedBytes);
  return {
    sourceCommit: source.commit,
    sourceTree: source.tree,
    localManifest: {
      deploymentId: localManifest.deploymentId,
      sha256: await sha256Bytes(localBytes),
    },
    servedManifest: {
      deploymentId: servedManifest.deploymentId,
      sha256: await sha256Bytes(servedBytes),
    },
  };
}

function applyMatrixConfiguration(cdp, configuration, final = true) {
  const browserZoom = final ? configuration.browserZoom : 1;
  const deviceScaleFactor = configuration.baseDevicePixelRatio *
    browserZoom;
  const width = Math.round(configuration.width / browserZoom);
  const height = Math.round(configuration.height / browserZoom);
  return Promise.all([
    cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile: configuration.kind === "mobile",
      screenWidth: width,
      screenHeight: height,
    }),
    cdp.send("Emulation.setPageScaleFactor", {
      pageScaleFactor: final ? configuration.pinchZoom : 1,
    }),
  ]);
}

async function writeScreenshot(cdp, outputDirectory, fileName, clip) {
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  });
  const filePath = path.join(outputDirectory, fileName);
  await writeFile(filePath, Buffer.from(screenshot.data, "base64"));
  return fileArtifact(filePath);
}

function paethPredictor(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

/** Decode the non-interlaced 8-bit PNG emitted by CDP screenshots. */
export function decodePngScreenshot(bytes) {
  const png = Buffer.from(bytes);
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (png.length < signature.length || !png.subarray(0, 8).equals(signature)) {
    throw new Error("The reference screenshot is not a PNG.");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let compression = -1;
  let filterMethod = -1;
  let interlace = -1;
  const imageChunks = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) {
      throw new Error("The reference PNG contains a truncated chunk.");
    }
    const data = png.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (length !== 13) throw new Error("The reference PNG has an invalid IHDR.");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      compression = data[10];
      filterMethod = data[11];
      interlace = data[12];
    } else if (type === "IDAT") {
      imageChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  const channels = new Map([
    [0, 1],
    [2, 3],
    [4, 2],
    [6, 4],
  ]).get(colorType);
  if (
    width <= 0 ||
    height <= 0 ||
    bitDepth !== 8 ||
    !channels ||
    compression !== 0 ||
    filterMethod !== 0 ||
    interlace !== 0 ||
    imageChunks.length === 0
  ) {
    throw new Error(
      "The reference PNG must be a non-interlaced 8-bit RGB/RGBA or grayscale image.",
    );
  }

  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(imageChunks));
  const expectedBytes = height * (stride + 1);
  if (inflated.length !== expectedBytes) {
    throw new Error("The reference PNG scanline size is invalid.");
  }
  const decoded = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const sourceOffset = y * (stride + 1);
    const targetOffset = y * stride;
    const filter = inflated[sourceOffset];
    if (filter > 4) throw new Error("The reference PNG uses an unknown filter.");
    for (let x = 0; x < stride; x += 1) {
      const value = inflated[sourceOffset + x + 1];
      const left = x >= channels ? decoded[targetOffset + x - channels] : 0;
      const above = y > 0 ? decoded[targetOffset + x - stride] : 0;
      const upperLeft = y > 0 && x >= channels
        ? decoded[targetOffset + x - stride - channels]
        : 0;
      let reconstructed = value;
      if (filter === 1) reconstructed += left;
      else if (filter === 2) reconstructed += above;
      else if (filter === 3) reconstructed += Math.floor((left + above) / 2);
      else if (filter === 4) {
        reconstructed += paethPredictor(left, above, upperLeft);
      }
      decoded[targetOffset + x] = reconstructed & 0xff;
    }
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const destination = pixel * 4;
    if (colorType === 0 || colorType === 4) {
      pixels[destination] = decoded[source];
      pixels[destination + 1] = decoded[source];
      pixels[destination + 2] = decoded[source];
      pixels[destination + 3] = colorType === 4
        ? decoded[source + 1]
        : 255;
    } else {
      pixels[destination] = decoded[source];
      pixels[destination + 1] = decoded[source + 1];
      pixels[destination + 2] = decoded[source + 2];
      pixels[destination + 3] = colorType === 6
        ? decoded[source + 3]
        : 255;
    }
  }
  return { height, pixels, width };
}

/**
 * Prove that a screenshot contains a substantial white PDF page and multiple
 * lines of rendered ink, rather than a blank/loading viewer surface.
 */
export function analyzeReferencePixels({ height, pixels, width }) {
  const empty = {
    height: Number(height) || 0,
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
    substantialComponentCount: 0,
    width: Number(width) || 0,
    winnerDominanceRatio: null,
    winnerWhiteArea: 0,
  };
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !(
      pixels instanceof Uint8Array ||
      pixels instanceof Uint8ClampedArray
    ) ||
    pixels.length !== width * height * 4
  ) {
    return empty;
  }

  const isWhite = (offset) =>
    pixels[offset] >= 235 &&
    pixels[offset + 1] >= 235 &&
    pixels[offset + 2] >= 235 &&
    pixels[offset + 3] >= 200;
  const whiteMask = new Uint8Array(width * height);
  for (let pixel = 0; pixel < whiteMask.length; pixel += 1) {
    if (isWhite(pixel * 4)) whiteMask[pixel] = 1;
  }
  const queue = new Int32Array(width * height);
  const components = [];
  for (let start = 0; start < whiteMask.length; start += 1) {
    if (whiteMask[start] !== 1) continue;
    whiteMask[start] = 0;
    queue[0] = start;
    let head = 0;
    let tail = 1;
    let left = start % width;
    let right = left;
    let top = Math.floor(start / width);
    let bottom = top;
    while (head < tail) {
      const pixel = queue[head];
      head += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      if (x > 0 && whiteMask[pixel - 1] === 1) {
        whiteMask[pixel - 1] = 0;
        queue[tail] = pixel - 1;
        tail += 1;
      }
      if (x + 1 < width && whiteMask[pixel + 1] === 1) {
        whiteMask[pixel + 1] = 0;
        queue[tail] = pixel + 1;
        tail += 1;
      }
      if (y > 0 && whiteMask[pixel - width] === 1) {
        whiteMask[pixel - width] = 0;
        queue[tail] = pixel - width;
        tail += 1;
      }
      if (y + 1 < height && whiteMask[pixel + width] === 1) {
        whiteMask[pixel + width] = 0;
        queue[tail] = pixel + width;
        tail += 1;
      }
    }
    components.push({
      bottom,
      height: bottom - top + 1,
      left,
      right,
      top,
      whiteArea: tail,
      width: right - left + 1,
    });
  }
  components.sort((left, right) =>
    right.whiteArea - left.whiteArea ||
    left.top - right.top ||
    left.left - right.left ||
    left.bottom - right.bottom ||
    left.right - right.right
  );

  const minimumPageWidth = Math.max(120, Math.ceil(width * 0.25));
  const minimumPageHeight = Math.max(80, Math.ceil(height * 0.25));
  const substantialComponents = components.filter((component) =>
    component.width >= minimumPageWidth &&
    component.height >= minimumPageHeight
  );
  const winner = substantialComponents[0] ?? null;
  const runnerUp = winner
    ? components.find((component) => component !== winner) ?? null
    : null;
  const segmentation = {
    runnerUpWhiteArea: runnerUp?.whiteArea ?? 0,
    segmentationVersion: 2,
    substantialComponentCount: substantialComponents.length,
    winnerDominanceRatio:
      winner && runnerUp
        ? winner.whiteArea / runnerUp.whiteArea
        : null,
    winnerWhiteArea: winner?.whiteArea ?? 0,
  };
  if (
    !winner ||
    (runnerUp && winner.whiteArea <= runnerUp.whiteArea)
  ) {
    return { ...empty, ...segmentation };
  }
  const pageLeft = winner.left;
  const pageRight = winner.right;
  const pageTop = winner.top;
  const pageBottom = winner.bottom;
  const pageWidth = winner.width;
  const pageHeight = winner.height;

  const insetX = Math.max(2, Math.floor(pageWidth * 0.01));
  const insetY = Math.max(2, Math.floor(pageHeight * 0.01));
  const interiorLeft = pageLeft + insetX;
  const interiorRight = pageRight - insetX;
  const interiorTop = pageTop + insetY;
  const interiorBottom = pageBottom - insetY;
  const interiorWidth = interiorRight - interiorLeft + 1;
  const interiorHeight = interiorBottom - interiorTop + 1;
  if (interiorWidth <= 0 || interiorHeight <= 0) {
    return { ...empty, ...segmentation };
  }

  let inkMaximumX = -1;
  let inkMinimumX = width;
  let inkPixels = 0;
  let pageWhitePixels = 0;
  const inkRows = [];
  for (let y = interiorTop; y <= interiorBottom; y += 1) {
    let rowInk = 0;
    for (let x = interiorLeft; x <= interiorRight; x += 1) {
      const offset = (y * width + x) * 4;
      if (isWhite(offset)) pageWhitePixels += 1;
      const luminance =
        pixels[offset] * 0.2126 +
        pixels[offset + 1] * 0.7152 +
        pixels[offset + 2] * 0.0722;
      if (pixels[offset + 3] < 200 || luminance > 200) continue;
      inkPixels += 1;
      rowInk += 1;
      inkMinimumX = Math.min(inkMinimumX, x);
      inkMaximumX = Math.max(inkMaximumX, x);
    }
    if (rowInk >= 3) inkRows.push(y);
  }
  let inkRowBands = 0;
  let previousInkRow = Number.NEGATIVE_INFINITY;
  for (const row of inkRows) {
    if (row > previousInkRow + 2) inkRowBands += 1;
    previousInkRow = row;
  }

  const pagePixels = interiorWidth * interiorHeight;
  const pageWhiteRatio = pageWhitePixels / pagePixels;
  const inkRatio = inkPixels / pagePixels;
  const inkSpanRatio = inkMaximumX >= inkMinimumX
    ? (inkMaximumX - inkMinimumX + 1) / interiorWidth
    : 0;
  return {
    height,
    inkPixels,
    inkRatio,
    inkRowBands,
    inkSpanRatio,
    pageBounds: {
      height: pageHeight,
      width: pageWidth,
      x: pageLeft,
      y: pageTop,
    },
    pagePixels,
    pageWhitePixels,
    pageWhiteRatio,
    proof: "white-page-with-rendered-ink",
    renderedPage:
      pageWhiteRatio >= PDF_SHARPNESS_REFERENCE_MIN_WHITE_RATIO &&
      inkPixels >= PDF_SHARPNESS_REFERENCE_MIN_INK_PIXELS &&
      inkRatio <= PDF_SHARPNESS_REFERENCE_MAX_INK_RATIO &&
      inkRowBands >= PDF_SHARPNESS_REFERENCE_MIN_INK_ROW_BANDS &&
      inkSpanRatio >= PDF_SHARPNESS_REFERENCE_MIN_INK_SPAN_RATIO,
    ...segmentation,
    width,
  };
}

const INSTRUMENTATION_SOURCE = String.raw`
(() => {
  localStorage.setItem("guided-reader-settings", JSON.stringify({
    narrationEngine: "device",
    narrationPreferenceVersion: 1,
    highlightScope: "sentence",
    follow: false
  }));

  const forceFallback = new URL(location.href).searchParams.has("issue68Fallback");
  const NativeWorker = globalThis.Worker;
  const buildFallbackWorkerModuleSource = (${buildFallbackWorkerModuleSource.toString()});
  const workerEvents = [];
  const workerLifecycle = [];
  const bitmapEventByObject = new WeakMap();
  let activitySequence = 0;
  let drawInvocationSequence = 0;
  let workerInstanceSequence = 0;
  globalThis.Worker = class Issue68Worker extends NativeWorker {
    constructor(url, options) {
      const resolved = new URL(String(url), location.href).href;
      const pdfWorker = resolved.includes("pdf-document.worker");
      const workerInstanceId = ++workerInstanceSequence;
      const wrapped = forceFallback && pdfWorker;
      let workerUrl = url;
      if (wrapped) {
        const source = buildFallbackWorkerModuleSource(
          resolved,
          workerInstanceId
        );
        workerUrl = URL.createObjectURL(
          new Blob([source], { type: "text/javascript" })
        );
      }
      super(workerUrl, options);
      this.__issue68PdfWorker = pdfWorker;
      this.__issue68WorkerInstanceId = workerInstanceId;
      workerLifecycle.push({
        at: performance.now(),
        forceFallback,
        type: "constructed",
        urlClass: pdfWorker ? "pdf-document-worker" : "other-worker",
        workerInstanceId,
        wrapped
      });
      if (pdfWorker) {
        let firstMessageRecorded = false;
        this.addEventListener("message", (event) => {
          const message = event.data || {};
          const documentId = message.page?.documentId || message.document?.id;
          const revision = message.page?.revision || message.revision || null;
          if (!firstMessageRecorded) {
            firstMessageRecorded = true;
            workerLifecycle.push({
              at: performance.now(),
              documentKey: documentId && revision
                ? documentId + ":" + revision
                : null,
              jobId: Number(message.jobId) || null,
              messageType: message.type || null,
              pageNumber: Number(message.pageNumber || message.page?.pageNumber) || null,
              revision,
              type: "first-message",
              urlClass: "pdf-document-worker",
              workerInstanceId
            });
          }
          const workerEvent = {
            activityId: ++activitySequence,
            at: performance.now(),
            completedPages: Number(message.completedPages) || null,
            direction: "from-worker",
            documentKey: documentId && revision
              ? documentId + ":" + revision
              : null,
            height: Number(message.height) || null,
            eventId: workerEvents.length + 1,
            jobId: Number(message.jobId) || null,
            pageHeight: Number(message.page?.layout?.height) || null,
            pageCount: Number(
              message.pageCount || message.document?.pdfPageCount
            ) || null,
            pageNumber: Number(message.pageNumber || message.page?.pageNumber) || null,
            pageWidth: Number(message.page?.layout?.width) || null,
            revision,
            scale: Number(message.scale) || null,
            type: message.type || null,
            workerInstanceId,
            width: Number(message.width) || null
          };
          workerEvents.push(workerEvent);
          if (
            workerEvent.type === "bitmap" &&
            message.bitmap &&
            (typeof message.bitmap === "object" || typeof message.bitmap === "function")
          ) {
            bitmapEventByObject.set(message.bitmap, workerEvent.eventId);
          }
        });
        this.addEventListener("error", () => {
          workerLifecycle.push({
            at: performance.now(),
            category: "worker-error",
            type: "error",
            urlClass: "pdf-document-worker",
            workerInstanceId
          });
        });
        this.addEventListener("messageerror", () => {
          workerLifecycle.push({
            at: performance.now(),
            category: "message-deserialization",
            type: "message-error",
            urlClass: "pdf-document-worker",
            workerInstanceId
          });
        });
      }
    }

    postMessage(message, transferOrOptions) {
      if (this.__issue68PdfWorker) {
        const documentId = message?.documentId;
        const revision = message?.revision ?? null;
        workerEvents.push({
          activityId: ++activitySequence,
          at: performance.now(),
          direction: "to-worker",
          distance: Number(message?.distance),
          documentKey: documentId && revision
            ? documentId + ":" + revision
            : null,
          enabled: message?.enabled,
          eventId: workerEvents.length + 1,
          jobId: Number(message?.jobId) || null,
          pageNumber: Number(message?.pageNumber) || null,
          revision,
          scale: Number(message?.scale) || null,
          type: message?.type || null,
          visible: message?.visible,
          workerInstanceId: this.__issue68WorkerInstanceId
        });
        workerLifecycle.push({
          at: performance.now(),
          documentKey: documentId && revision
            ? documentId + ":" + revision
            : null,
          jobId: Number(message?.jobId) || null,
          messageType: message?.type || null,
          revision,
          type: "post-message",
          urlClass: "pdf-document-worker",
          workerInstanceId: this.__issue68WorkerInstanceId
        });
      }
      if (arguments.length > 1) {
        return super.postMessage(message, transferOrOptions);
      }
      return super.postMessage(message);
    }

    terminate() {
      if (this.__issue68PdfWorker) {
        workerLifecycle.push({
          at: performance.now(),
          type: "terminated",
          urlClass: "pdf-document-worker",
          workerInstanceId: this.__issue68WorkerInstanceId
        });
      }
      return super.terminate();
    }
  };

  const state = globalThis.__lineLightIssue68 = {
    draws: [],
    errors: [],
    fallback: {
      activeStaging: 0,
      events: [],
      injectedFailures: 0,
      maximumConcurrentStaging: 0,
      signalAt: null,
      stagingStarted: 0
    },
    longTasks: [],
    notices: [],
    samples: [],
    scenarios: [],
    sourceFiles: [],
    spoken: [],
    workerEvents,
    workerLifecycle
  };
  let currentScenario = null;
  let currentPriorityProbe = null;
  let failNextFallback = null;
  let fallbackProofIdentity = null;
  let delayNextContinuation = null;
  let heldContinuation = null;
  const matchesArmedFallbackInjection = (${matchesPdfFallbackInjection.toString()});
  const selectFallbackAbortCandidate = (${selectPdfFallbackAbortCandidate.toString()});
  const latestValidatedPdfImport = () => workerEvents.findLast((event) =>
    event.direction === 'to-worker' &&
    event.type === 'import' &&
    Number.isFinite(event.at) &&
    Number.isInteger(event.jobId) &&
    typeof event.documentKey === 'string' && event.documentKey &&
    typeof event.revision === 'string' && event.revision
  ) ?? null;
  const fallbackAttempts = new Map();
  const stagingSymbol = Symbol("issue68FallbackStaging");
  const fallbackAbortCandidates = [];
  const fallbackAttemptBySignal = new WeakMap();
  let abortSignalSequence = 0;
  const nativeAbortListener = AbortSignal.prototype.addEventListener;
  AbortSignal.prototype.addEventListener = function issue68AbortListener(
    type,
    listener,
    options
  ) {
    if (
      forceFallback &&
      type === "abort" &&
      typeof listener === "function" &&
      !this.aborted &&
      /\.cancel\s*\(/u.test(Function.prototype.toString.call(listener)) &&
      !fallbackAbortCandidates.some((candidate) => candidate.signal === this)
    ) {
      const candidate = {
        bound: false,
        registeredAt: performance.now(),
        retired: false,
        signal: this,
        signalId: ++abortSignalSequence
      };
      fallbackAbortCandidates.push(candidate);
      state.fallback.events.push({
        abortSignalId: candidate.signalId,
        at: candidate.registeredAt,
        type: "abort-signal-registered"
      });
    }
    return nativeAbortListener.call(this, type, listener, options);
  };
  const nativeAbort = AbortController.prototype.abort;
  AbortController.prototype.abort = function issue68Abort(reason) {
    if (forceFallback) {
      const unboundCandidate = fallbackAbortCandidates.find((candidate) =>
        candidate.signal === this.signal &&
        !candidate.bound &&
        !candidate.retired
      );
      if (unboundCandidate) {
        unboundCandidate.retired = true;
        state.fallback.events.push({
          abortSignalId: unboundCandidate.signalId,
          at: performance.now(),
          reason: 'aborted-before-staging',
          type: 'abort-signal-retired'
        });
      }
      const attempt = fallbackAttemptBySignal.get(this.signal) ?? null;
      const delayedAttempt = attempt && state.fallback.events.some((event) =>
        event.type === "continuation-delay" &&
        event.renderAttemptId === attempt.renderAttemptId
      );
      if (
        attempt &&
        !attempt.finished &&
        attempt.cancelRequestedAt === null &&
        delayedAttempt
      ) {
        attempt.cancelRequestedAt = performance.now();
        state.fallback.events.push({
          abortSignalId: attempt.abortSignalId,
          at: attempt.cancelRequestedAt,
          documentKey: attempt.documentKey,
          page: attempt.page,
          pageDerivation: attempt.pageDerivation,
          renderAttemptId: attempt.renderAttemptId,
          revision: attempt.revision,
          type: "cancel-request"
        });
      }
    }
    return nativeAbort.call(this, reason);
  };
  const recordError = (value) => state.errors.push(String(value));
  addEventListener("error", (event) => {
    recordError(event.error?.stack || event.message || "window error");
  });
  addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    if (reason?.name === "AbortError" || reason?.name === "RenderingCancelledException") return;
    recordError(reason?.stack || reason || "unhandled rejection");
  });
  addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
    const file = input.files?.[0];
    if (!file) return;
    void file.arrayBuffer().then(async (bytes) => {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0")
      ).join("");
      state.sourceFiles.push({
        at: performance.now(),
        eventId: state.sourceFiles.length + 1,
        sha256,
        size: file.size
      });
    }).catch(recordError);
  }, true);
  const recordLongTaskEntries = (entries) => {
    for (const entry of entries) {
      state.longTasks.push({
        duration: entry.duration,
        name: entry.name,
        startTime: entry.startTime
      });
    }
  };
  let longTaskObserver = null;
  const drainLongTasks = () => {
    if (longTaskObserver) recordLongTaskEntries(longTaskObserver.takeRecords());
  };
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      recordLongTaskEntries(list.getEntries());
    });
    longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch (error) {
    recordError("Long Task observer unavailable: " + error.message);
  }

  let previousNotice = null;
  new MutationObserver(() => {
    const notice = document.querySelector(".notice")?.textContent?.trim() || null;
    if (!notice || notice === previousNotice) return;
    previousNotice = notice;
    state.notices.push({ at: performance.now(), text: notice });
  }).observe(document, { childList: true, characterData: true, subtree: true });

  class FakeUtterance {
    constructor(text = "") {
      this.text = String(text);
      this.lang = "en-US";
      this.pitch = 1;
      this.rate = 1;
      this.voice = null;
      this.volume = 1;
      this.onboundary = null;
      this.onend = null;
      this.onerror = null;
      this.onstart = null;
    }
  }
  const fakeSpeech = new EventTarget();
  const voice = {
    default: true,
    lang: "en-US",
    localService: true,
    name: "LineLight deterministic local test voice",
    voiceURI: "linelight-local-test"
  };
  let speechGeneration = 0;
  let speaking = false;
  Object.defineProperties(fakeSpeech, {
    paused: { get: () => false },
    pending: { get: () => false },
    speaking: { get: () => speaking }
  });
  fakeSpeech.getVoices = () => [voice];
  fakeSpeech.cancel = () => {
    speechGeneration += 1;
    speaking = false;
  };
  fakeSpeech.pause = () => {};
  fakeSpeech.resume = () => {};
  fakeSpeech.speak = (utterance) => {
    const generation = ++speechGeneration;
    speaking = true;
    const words = Array.from(utterance.text.matchAll(/\S+/gu));
    state.spoken.push({
      at: performance.now(),
      characters: utterance.text.length
    });
    queueMicrotask(() => {
      if (generation !== speechGeneration) return;
      utterance.onstart?.({ type: "start" });
    });
    words.slice(0, 8).forEach((match, index) => {
      setTimeout(() => {
        if (generation !== speechGeneration) return;
        utterance.onboundary?.({
          charIndex: match.index || 0,
          charLength: match[0].length,
          elapsedTime: index * 0.06,
          name: "word",
          type: "boundary"
        });
      }, 60 + index * 60);
    });
    setTimeout(() => {
      if (generation !== speechGeneration) return;
      speaking = false;
      utterance.onend?.({ type: "end" });
    }, Math.max(600, words.length * 65));
  };
  try {
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      configurable: true,
      value: FakeUtterance
    });
    Object.defineProperty(globalThis, "speechSynthesis", {
      configurable: true,
      value: fakeSpeech
    });
  } catch (error) {
    recordError("Could not install deterministic local speech: " + error.message);
  }

  const nativeRequestAnimationFrame = globalThis.requestAnimationFrame.bind(globalThis);
  const maybeResumeHeldContinuation = () => {
    const held = heldContinuation;
    if (
      !held || held.resumed || !held.minimumElapsed ||
      !Number.isFinite(held.releaseRequestedAt)
    ) {
      return false;
    }
    held.resumed = true;
    const resumedAt = performance.now();
    state.fallback.events.push({
      abortSignalId: held.attempt.abortSignalId,
      afterMs: resumedAt - held.delayedAt,
      at: resumedAt,
      documentKey: held.attempt.documentKey,
      page: held.attempt.page,
      pageDerivation: held.attempt.pageDerivation,
      releaseRequestedAt: held.releaseRequestedAt,
      renderAttemptId: held.attempt.renderAttemptId,
      revision: held.attempt.revision,
      type: "continuation-resume"
    });
    nativeRequestAnimationFrame(held.callback);
    return true;
  };
  globalThis.requestAnimationFrame = (callback) => {
    if (
      delayNextContinuation?.delay > 0 &&
      forceFallback &&
      /scheduleNext/i.test(callback?.name || "")
    ) {
      const activeAttempts = Array.from(fallbackAttempts.values()).filter(
        (attempt) =>
          !attempt.finished &&
          matchesArmedFallbackInjection(delayNextContinuation, attempt)
      );
      const attempt = activeAttempts.length === 1 ? activeAttempts[0] : null;
      if (!attempt) return nativeRequestAnimationFrame(callback);
      if (heldContinuation && !heldContinuation.resumed) {
        return nativeRequestAnimationFrame(callback);
      }
      const { armedAt, delay } = delayNextContinuation;
      delayNextContinuation = null;
      const delayedAt = performance.now();
      heldContinuation = {
        attempt,
        callback,
        delayedAt,
        minimumElapsed: false,
        releaseRequestedAt: null,
        resumed: false
      };
      state.fallback.events.push({
        abortSignalId: attempt?.abortSignalId ?? null,
        at: delayedAt,
        armedAt,
        callbackName: callback?.name || null,
        delay,
        documentKey: attempt?.documentKey ?? null,
        page: attempt?.page ?? null,
        pageDerivation: attempt?.pageDerivation ?? null,
        renderAttemptId: attempt?.renderAttemptId ?? null,
        revision: attempt?.revision ?? null,
        type: "continuation-delay"
      });
      setTimeout(() => {
        if (!heldContinuation || heldContinuation.attempt !== attempt) return;
        heldContinuation.minimumElapsed = true;
        const elapsedAt = performance.now();
        state.fallback.events.push({
          abortSignalId: attempt?.abortSignalId ?? null,
          afterMs: elapsedAt - delayedAt,
          at: elapsedAt,
          documentKey: attempt?.documentKey ?? null,
          page: attempt?.page ?? null,
          pageDerivation: attempt?.pageDerivation ?? null,
          renderAttemptId: attempt?.renderAttemptId ?? null,
          revision: attempt?.revision ?? null,
          type: "continuation-minimum-elapsed"
        });
        maybeResumeHeldContinuation();
      }, delay);
      // PDF.js may call cancelAnimationFrame with this return value. The real
      // continuation remains under the explicit proof gate above.
      return 0;
    }
    return nativeRequestAnimationFrame(callback);
  };

  const widthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "width"
  );
  const finishStaging = (canvas, outcome) => {
    const staging = canvas[stagingSymbol];
    if (!staging || staging.finished) return;
    staging.finished = true;
    const terminalOutcome = staging.cancelRequestedAt === null
      ? outcome
      : "cancelled";
    state.fallback.activeStaging = Math.max(0, state.fallback.activeStaging - 1);
    state.fallback.events.push({
      abortSignalId: staging.abortSignalId,
      at: performance.now(),
      cancelRequestedAt: staging.cancelRequestedAt,
      documentKey: staging.documentKey,
      id: staging.id,
      outcome: terminalOutcome,
      page: staging.page,
      pageDerivation: staging.pageDerivation,
      renderAttemptId: staging.renderAttemptId,
      revision: staging.revision,
      targetHeight: staging.targetHeight,
      targetKey: staging.targetKey,
      targetWidth: staging.targetWidth,
      type: "staging-finish"
    });
  };
  if (widthDescriptor?.get && widthDescriptor?.set) {
    Object.defineProperty(HTMLCanvasElement.prototype, "width", {
      configurable: widthDescriptor.configurable,
      enumerable: widthDescriptor.enumerable,
      get: widthDescriptor.get,
      set(value) {
        widthDescriptor.set.call(this, value);
        if (Number(value) === 0) finishStaging(this, "released");
      }
    });
  }
  const deriveFallbackPage = (stagingWidth, stagingHeight) => {
    const candidates = Array.from(document.querySelectorAll(
      '.pdf-page-block[data-pdf-page-visible="true"]'
    )).flatMap((block) => {
      const canvas = block.querySelector("canvas");
      const page = Number(block.dataset.pdfPageIndex) + 1;
      const targetWidth = Number(canvas?.dataset.pdfRasterTargetWidth);
      const targetHeight = Number(canvas?.dataset.pdfRasterTargetHeight);
      if (
        !canvas ||
        !Number.isInteger(page) ||
        page < 1 ||
        !(targetWidth > 0) ||
        !(targetHeight > 0) ||
        Math.abs(targetWidth - stagingWidth) > 1 ||
        Math.abs(targetHeight - stagingHeight) > 1 ||
        (canvas.width >= targetWidth && canvas.height >= targetHeight)
      ) {
        return [];
      }
      return [page];
    });
    const page = candidates.length === 1 ? candidates[0] : null;
    const pageEvent = Number.isInteger(page)
      ? workerEvents.findLast((event) =>
          event.direction === "from-worker" &&
          event.type === "page" &&
          event.pageNumber === page &&
          event.documentKey &&
          event.revision
        )
      : null;
    return {
      candidatePages: candidates,
      documentKey: pageEvent?.documentKey ?? null,
      page,
      pageDerivation: "sole-visible-unsatisfied-page",
      revision: pageEvent?.revision ?? null
    };
  };
  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function issue68GetContext(type, options) {
    const staging = forceFallback && type === "2d" && !this.isConnected &&
      this.width * this.height > 100000;
    if (staging && !this[stagingSymbol]) {
      const id = ++state.fallback.stagingStarted;
      const derivedPage = deriveFallbackPage(this.width, this.height);
      const {
        candidate: abortCandidate,
        candidateCount: abortSignalCandidateCount
      } = selectFallbackAbortCandidate(fallbackAbortCandidates);
      const attempt = {
        ...derivedPage,
        abortSignalCandidateCount,
        abortSignalId: abortCandidate?.signalId ?? null,
        abortSignalRegisteredAt: abortCandidate?.registeredAt ?? null,
        cancelRequestedAt: null,
        finished: false,
        id,
        renderAttemptId: id,
        targetHeight: this.height,
        targetKey: this.width + "x" + this.height,
        targetWidth: this.width
      };
      if (abortCandidate) {
        abortCandidate.bound = true;
        fallbackAttemptBySignal.set(abortCandidate.signal, attempt);
      }
      this[stagingSymbol] = attempt;
      fallbackAttempts.set(id, attempt);
      state.fallback.activeStaging += 1;
      state.fallback.maximumConcurrentStaging = Math.max(
        state.fallback.maximumConcurrentStaging,
        state.fallback.activeStaging
      );
      state.fallback.events.push({
        abortSignalCandidateCount: attempt.abortSignalCandidateCount,
        abortSignalId: attempt.abortSignalId,
        abortSignalRegisteredAt: attempt.abortSignalRegisteredAt,
        at: performance.now(),
        candidatePages: derivedPage.candidatePages,
        documentKey: attempt.documentKey,
        height: this.height,
        id,
        page: derivedPage.page,
        pageDerivation: derivedPage.pageDerivation,
        renderAttemptId: id,
        revision: attempt.revision,
        targetHeight: attempt.targetHeight,
        targetKey: attempt.targetKey,
        targetWidth: attempt.targetWidth,
        type: "staging-start",
        width: this.width
      });
      if (matchesArmedFallbackInjection(failNextFallback, attempt)) {
        failNextFallback = null;
        state.fallback.injectedFailures += 1;
        finishStaging(this, "injected-failure");
        return null;
      }
    }
    return nativeGetContext.call(this, type, options);
  };
  const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function issue68DrawImage(...args) {
    const destination = this.canvas;
    const connected = Boolean(destination?.isConnected);
    const fallbackAttempt = connected ? args[0]?.[stagingSymbol] ?? null : null;
    const fallbackCompose = Boolean(fallbackAttempt);
    const transferredBitmapEventId = connected
      ? bitmapEventByObject.get(args[0]) ?? null
      : null;
    let invocation = null;
    if (connected) {
      const block = destination.closest(".pdf-page-block");
      const reader = document.querySelector(".reader-scroll");
      const blockRect = block?.getBoundingClientRect() ?? null;
      const readerRect = reader?.getBoundingClientRect() ?? null;
      const geometry = blockRect
        ? {
            bottom: blockRect.bottom,
            left: blockRect.left,
            right: blockRect.right,
            top: blockRect.top
          }
        : null;
      const readerViewport = readerRect
        ? {
            bottom: readerRect.bottom,
            left: readerRect.left,
            right: readerRect.right,
            top: readerRect.top
          }
        : null;
      invocation = {
        activityId: ++activitySequence,
        at: performance.now(),
        bitmapEventId: transferredBitmapEventId,
        distance: Number(block?.dataset.pdfPageDistance),
        drawInvocationId: ++drawInvocationSequence,
        geometry,
        geometryVisible: Boolean(
          blockRect && readerRect &&
          blockRect.bottom > readerRect.top &&
          blockRect.top < readerRect.bottom &&
          blockRect.right > readerRect.left &&
          blockRect.left < readerRect.right
        ),
        height: destination.height,
        page: Number(block?.dataset.pdfPageIndex || -1) + 1,
        priorityProbe: currentPriorityProbe,
        readerViewport,
        visible: block?.dataset.pdfPageVisible === "true",
        visiblePages: Array.from(document.querySelectorAll(
          '.pdf-page-block[data-pdf-page-visible="true"]'
        )).map((candidate) =>
          Number(candidate.dataset.pdfPageIndex) + 1
        ).filter(Number.isInteger).sort((left, right) => left - right),
        width: destination.width
      };
    }
    const result = nativeDrawImage.apply(this, args);
    if (connected && invocation) {
      queueMicrotask(() => {
        const draw = {
          activityId: invocation.activityId,
          at: invocation.at,
          bitmapEventId: invocation.bitmapEventId,
          compositionId: state.draws.length + 1,
          distance: invocation.distance,
          drawInvocationId: invocation.drawInvocationId,
          geometry: invocation.geometry,
          geometryVisible: invocation.geometryVisible,
          height: invocation.height,
          page: invocation.page,
          readerViewport: invocation.readerViewport,
          scale: Number(destination.dataset.pdfRasterScale) || null,
          source: destination.dataset.pdfRenderSource ||
            (fallbackCompose ? "main-fallback" : "worker-bitmap"),
          visible: invocation.visible,
          visiblePages: invocation.visiblePages,
          width: invocation.width
        };
        state.draws.push(draw);
        if (
          invocation.priorityProbe &&
          invocation.activityId > invocation.priorityProbe.scrollAction.activityId &&
          invocation.drawInvocationId >
            invocation.priorityProbe.scrollAction.drawInvocationBoundary
        ) {
          invocation.priorityProbe.compositions.push(draw);
        }
        if (fallbackCompose) {
          state.fallback.events.push({
            abortSignalId: fallbackAttempt.abortSignalId,
            at: draw.at,
            documentKey: fallbackAttempt.documentKey,
            page: draw.page,
            pageDerivation: fallbackAttempt.pageDerivation,
            pageMatchesAttempt: draw.page === fallbackAttempt.page,
            renderAttemptId: fallbackAttempt.renderAttemptId,
            revision: fallbackAttempt.revision,
            sourcePage: fallbackAttempt.page,
            targetHeight: fallbackAttempt.targetHeight,
            targetKey: fallbackAttempt.targetKey,
            targetWidth: fallbackAttempt.targetWidth,
            type: "visible-compose"
          });
        }
      });
    }
    return result;
  };

  const previousCanvasState = new WeakMap();
  const sampleCanvases = () => {
    const now = performance.now();
    const view = document.querySelector(".pdf-page-view");
    if (view?.dataset.pdfRenderFallback === "true" && state.fallback.signalAt === null) {
      state.fallback.signalAt = now;
      state.fallback.events.push({ at: now, type: "fallback-signal" });
    }
    let composedCount = 0;
    let composedPixels = 0;
    const composedPages = [];
    const geometryVisiblePages = [];
    const visiblePages = [];
    const reader = document.querySelector('.reader-scroll');
    const readerRect = reader?.getBoundingClientRect() ?? null;
    const readerViewport = readerRect
      ? {
          bottom: readerRect.bottom,
          left: readerRect.left,
          right: readerRect.right,
          top: readerRect.top
        }
      : null;
    for (const block of document.querySelectorAll(".pdf-page-block")) {
      const page = Number(block.dataset.pdfPageIndex || -1) + 1;
      const blockRect = block.getBoundingClientRect();
      const geometry = {
        bottom: blockRect.bottom,
        left: blockRect.left,
        right: blockRect.right,
        top: blockRect.top
      };
      const geometryVisible = Boolean(
        readerRect &&
        blockRect.bottom > readerRect.top &&
        blockRect.top < readerRect.bottom &&
        blockRect.right > readerRect.left &&
        blockRect.left < readerRect.right
      );
      if (geometryVisible) geometryVisiblePages.push(page);
      const canvas = block.querySelector("canvas");
      if (!canvas) continue;
      const sample = {
        at: now,
        capped: canvas.dataset.pdfRasterCapped === "true",
        distance: Number(block.dataset.pdfPageDistance),
        height: canvas.height,
        geometry,
        geometryVisible,
        page,
        scale: Number(canvas.dataset.pdfRasterScale) || null,
        source: canvas.dataset.pdfRenderSource || null,
        targetHeight: Number(canvas.dataset.pdfRasterTargetHeight) || null,
        targetScale: Number(canvas.dataset.pdfRasterTargetScale) || null,
        targetWidth: Number(canvas.dataset.pdfRasterTargetWidth) || null,
        visible: block.dataset.pdfPageVisible === "true",
        width: canvas.width
      };
      if (sample.width > 0 && sample.height > 0) {
        composedCount += 1;
        composedPixels += sample.width * sample.height;
        composedPages.push({
          height: sample.height,
          geometry: sample.geometry,
          geometryVisible: sample.geometryVisible,
          page,
          pixels: sample.width * sample.height,
          visible: sample.visible,
          width: sample.width
        });
      }
      if (sample.visible) visiblePages.push(page);
      const key = [
        sample.width,
        sample.height,
        sample.source,
        sample.scale,
        sample.targetWidth,
        sample.targetHeight,
        sample.visible,
        sample.distance
      ].join(":");
      if (previousCanvasState.get(canvas) !== key) {
        previousCanvasState.set(canvas, key);
        state.samples.push(sample);
      }
    }
    if (currentScenario) {
      const frame = {
        at: now,
        composedCount,
        composedPages,
        composedPixels,
        geometryVisiblePages,
        readerViewport,
        visiblePages
      };
      if (composedCount > currentScenario.maximumCanvasCount) {
        currentScenario.maximumCountFrame = structuredClone(frame);
      }
      if (composedPixels > currentScenario.maximumCanvasPixels) {
        currentScenario.maximumPixelsFrame = structuredClone(frame);
      }
      currentScenario.maximumCanvasCount = Math.max(
        currentScenario.maximumCanvasCount,
        composedCount
      );
      currentScenario.maximumCanvasPixels = Math.max(
        currentScenario.maximumCanvasPixels,
        composedPixels
      );
    }
    nativeRequestAnimationFrame(sampleCanvases);
  };
  nativeRequestAnimationFrame(sampleCanvases);

  state.beginScenario = (id) => {
    const scenario = {
      id,
      drawStart: state.draws.length,
      maximumCanvasCount: 0,
      maximumCanvasPixels: 0,
      maximumCountFrame: null,
      maximumPixelsFrame: null,
      sampleStart: state.samples.length,
      startedAt: performance.now(),
      workerEventStart: workerEvents.length
    };
    state.scenarios.push(scenario);
    currentScenario = scenario;
    return structuredClone(scenario);
  };
  state.finishScenario = () => {
    if (!currentScenario) return null;
    currentScenario.finishedAt = performance.now();
    drainLongTasks();
    currentScenario.drawEnd = state.draws.length;
    currentScenario.sampleEnd = state.samples.length;
    currentScenario.workerEventEnd = workerEvents.length;
    const result = structuredClone(currentScenario);
    currentScenario = null;
    return result;
  };
  state.beginPriorityScroll = (targetPage) => {
    const latestImport = latestValidatedPdfImport();
    const block = document.querySelector('#pdf-page-' + targetPage);
    if (!block) {
      throw new Error('The mounted priority target disappeared.');
    }
    const canvas = block?.querySelector('canvas') ?? null;
    const latestBitmap = workerEvents.findLast((event) =>
      event.direction === 'from-worker' &&
      event.type === 'bitmap' &&
      event.pageNumber === targetPage &&
      event.jobId === latestImport?.jobId &&
      event.revision === latestImport?.revision &&
      event.at >= latestImport.at
    ) ?? null;
    const reader = document.querySelector('.reader-scroll');
    const rectangle = (element) => {
      const rect = element?.getBoundingClientRect() ?? null;
      return rect
        ? {
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            top: rect.top
          }
        : null;
    };
    const action = {
      activityId: ++activitySequence,
      at: performance.now(),
      drawBoundary: state.draws.length,
      drawInvocationBoundary: drawInvocationSequence,
      eventId: workerEvents.length,
      readerViewportBefore: rectangle(reader),
      scrollTopBefore: Number(reader?.scrollTop),
      targetGeometryBefore: rectangle(block),
      targetPage,
      type: 'rapid-scroll-action'
    };
    currentPriorityProbe = {
      compositions: [],
      scrollAction: action,
      startedAt: action.at,
      targetBefore: {
        canvasHeight: canvas?.height ?? null,
        canvasWidth: canvas?.width ?? null,
        distance: Number(block?.dataset.pdfPageDistance),
        latestBitmapActivityId: latestBitmap?.activityId ?? null,
        latestBitmapEventId: latestBitmap?.eventId ?? null,
        latestBitmapHeight: latestBitmap?.height ?? null,
        latestBitmapScale: latestBitmap?.scale ?? null,
        latestBitmapWidth: latestBitmap?.width ?? null,
        targetHeight: Number(canvas?.dataset.pdfRasterTargetHeight) || null,
        targetScale: Number(canvas?.dataset.pdfRasterTargetScale) || null,
        targetWidth: Number(canvas?.dataset.pdfRasterTargetWidth) || null,
        visible: block?.dataset.pdfPageVisible === 'true'
      },
      targetPage
    };
    block.scrollIntoView({ behavior: 'auto', block: 'center' });
    action.readerViewportAfter = rectangle(reader);
    action.scrollTopAfter = Number(reader?.scrollTop);
    action.targetGeometryAfter = rectangle(block);
    return structuredClone(action);
  };
  state.finishPriorityProbe = () => {
    if (currentPriorityProbe) {
      currentPriorityProbe.workerEvents = workerEvents.filter(
        (event) =>
          Number.isInteger(event.activityId) &&
          event.activityId > currentPriorityProbe.scrollAction.activityId
      );
      const block = document.querySelector(
        '#pdf-page-' + currentPriorityProbe.targetPage
      );
      const canvas = block?.querySelector('canvas') ?? null;
      currentPriorityProbe.targetAfter = {
        canvasHeight: canvas?.height ?? null,
        canvasWidth: canvas?.width ?? null,
        distance: Number(block?.dataset.pdfPageDistance),
        renderSource: canvas?.dataset.pdfRenderSource || null,
        scale: Number(canvas?.dataset.pdfRasterScale) || null,
        targetHeight: Number(canvas?.dataset.pdfRasterTargetHeight) || null,
        targetScale: Number(canvas?.dataset.pdfRasterTargetScale) || null,
        targetWidth: Number(canvas?.dataset.pdfRasterTargetWidth) || null,
        visible: block?.dataset.pdfPageVisible === 'true'
      };
    }
    const result = structuredClone(currentPriorityProbe);
    currentPriorityProbe = null;
    return result;
  };
  state.failNextFallback = (documentKey, revision, pageNumber) => {
    const page = Number(pageNumber);
    const latestImport = latestValidatedPdfImport();
    const block = Number.isInteger(page)
      ? document.querySelector('#pdf-page-' + page)
      : null;
    const canvas = block?.querySelector('canvas') ?? null;
    const pageEvent = Number.isInteger(page)
      ? workerEvents.findLast((event) =>
          event.direction === 'from-worker' &&
          event.type === 'page' &&
          event.pageNumber === page &&
          event.documentKey === documentKey &&
          event.revision === revision &&
          event.jobId === latestImport?.jobId &&
          event.at >= latestImport.at
        )
      : null;
    if (
      !forceFallback ||
      typeof documentKey !== 'string' || !documentKey ||
      typeof revision !== 'string' || !revision ||
      !Number.isInteger(page) || page < 1 ||
      latestImport?.documentKey !== documentKey ||
      latestImport?.revision !== revision ||
      !pageEvent ||
      !block || block.dataset.pdfPageVisible !== 'false' ||
      Number(block.dataset.pdfPageDistance) !== 1 ||
      !canvas || canvas.width !== 0 || canvas.height !== 0
    ) {
      throw new Error('Fallback failure arm requires one exact adjacent unsatisfied import page.');
    }
    const event = {
      at: performance.now(),
      documentKey,
      page,
      pageDerivation: 'validated-adjacent-unsatisfied-page',
      revision,
      type: 'injection-armed'
    };
    failNextFallback = { documentKey, page, revision };
    fallbackProofIdentity = {
      documentKey,
      importJobId: latestImport.jobId,
      revision
    };
    state.fallback.events.push(event);
    return structuredClone(event);
  };
  state.delayNextContinuation = function issue68DelayNextContinuation(milliseconds) {
    if (arguments.length !== 1) {
      throw new Error("Fallback continuation delay accepts only a duration.");
    }
    const visibleBlocks = Array.from(document.querySelectorAll(
      '.pdf-page-block[data-pdf-page-visible="true"]'
    ));
    const visiblePages = visibleBlocks.map(
      (block) => Number(block.dataset.pdfPageIndex) + 1
    ).filter(Number.isInteger);
    const page = visiblePages.length === 1 ? visiblePages[0] + 1 : null;
    const latestImport = latestValidatedPdfImport();
    const block = Number.isInteger(page)
      ? document.querySelector('#pdf-page-' + page)
      : null;
    const canvas = block?.querySelector('canvas') ?? null;
    const pageEvent = Number.isInteger(page) && fallbackProofIdentity
      ? workerEvents.findLast((event) =>
          event.direction === 'from-worker' &&
          event.type === 'page' &&
          event.pageNumber === page &&
          event.documentKey === fallbackProofIdentity.documentKey &&
          event.revision === fallbackProofIdentity.revision &&
          event.jobId === fallbackProofIdentity.importJobId &&
          event.at >= latestImport.at
        )
      : null;
    if (
      !forceFallback ||
      !fallbackProofIdentity ||
      latestImport?.documentKey !== fallbackProofIdentity.documentKey ||
      latestImport?.revision !== fallbackProofIdentity.revision ||
      latestImport?.jobId !== fallbackProofIdentity.importJobId ||
      !Number.isInteger(page) || page < 1 ||
      !pageEvent ||
      !block || block.dataset.pdfPageVisible !== 'false' ||
      Number(block.dataset.pdfPageDistance) !== 1 ||
      !canvas || canvas.width !== 0 || canvas.height !== 0
    ) {
      throw new Error('Fallback continuation arm requires the next exact unsatisfied import page.');
    }
    const armedAt = performance.now();
    delayNextContinuation = {
      armedAt,
      delay: Math.max(0, Number(milliseconds) || 0),
      documentKey: fallbackProofIdentity.documentKey,
      page,
      revision: fallbackProofIdentity.revision
    };
    const event = {
      armedAt,
      at: armedAt,
      candidatePages: [page],
      documentKey: fallbackProofIdentity.documentKey,
      page,
      pageDerivation: 'next-page-from-sole-visible-page',
      revision: fallbackProofIdentity.revision,
      type: 'continuation-armed'
    };
    state.fallback.events.push(event);
    return structuredClone(event);
  };
  state.markFallbackViewportExitRequest = (renderAttemptId, destinationPage) => {
    const attempt = fallbackAttempts.get(Number(renderAttemptId));
    const block = Number.isInteger(attempt?.page)
      ? document.querySelector('#pdf-page-' + attempt.page)
      : null;
    const event = {
      abortSignalId: attempt?.abortSignalId ?? null,
      at: performance.now(),
      destinationPage: Number(destinationPage),
      documentKey: attempt?.documentKey ?? null,
      page: attempt?.page ?? null,
      pageDerivation: attempt?.pageDerivation ?? null,
      renderAttemptId: attempt?.renderAttemptId ?? null,
      revision: attempt?.revision ?? null,
      type: "viewport-exit-request",
      visibleBeforeRequest: block?.dataset.pdfPageVisible === "true"
    };
    state.fallback.events.push(event);
    return structuredClone(event);
  };
  state.markFallbackViewportExit = (renderAttemptId) => {
    const attempt = fallbackAttempts.get(Number(renderAttemptId));
    const block = Number.isInteger(attempt?.page)
      ? document.querySelector('#pdf-page-' + attempt.page)
      : null;
    const canvas = block?.querySelector("canvas") ?? null;
    const at = performance.now();
    const matchingCancelRequests = state.fallback.events.filter((candidate) =>
      candidate.type === "cancel-request" &&
      candidate.renderAttemptId === attempt?.renderAttemptId &&
      candidate.abortSignalId === attempt?.abortSignalId
    );
    const matchingTerminals = state.fallback.events.filter((candidate) =>
      candidate.type === "staging-finish" &&
      candidate.outcome === "cancelled" &&
      candidate.renderAttemptId === attempt?.renderAttemptId &&
      candidate.abortSignalId === attempt?.abortSignalId
    );
    const matchingExitRequests = state.fallback.events.filter((candidate) =>
      candidate.type === "viewport-exit-request" &&
      candidate.renderAttemptId === attempt?.renderAttemptId &&
      candidate.abortSignalId === attempt?.abortSignalId
    );
    if (
      !attempt || !heldContinuation || heldContinuation.attempt !== attempt ||
      heldContinuation.resumed ||
      matchingExitRequests.length !== 1 ||
      matchingCancelRequests.length !== 1 ||
      matchingTerminals.length !== 1 ||
      !Number.isFinite(attempt.cancelRequestedAt) || !attempt.finished ||
      block?.dataset.pdfPageVisible !== "false" || !canvas ||
      canvas.width !== 0 || canvas.height !== 0 ||
      !block.querySelector(".pdf-word-overlay")
    ) {
      throw new Error("Fallback continuation release requires one cancelled invisible attempt.");
    }
    const event = {
      abortSignalId: attempt?.abortSignalId ?? null,
      at,
      cancelRequestedAt: attempt?.cancelRequestedAt ?? null,
      canvasHeight: canvas?.height ?? null,
      canvasPresent: Boolean(canvas),
      canvasWidth: canvas?.width ?? null,
      documentKey: attempt?.documentKey ?? null,
      page: attempt?.page ?? null,
      pageDerivation: attempt?.pageDerivation ?? null,
      renderAttemptId: attempt?.renderAttemptId ?? null,
      revision: attempt?.revision ?? null,
      textOverlayCount: block?.querySelectorAll(".pdf-word-overlay").length ?? 0,
      type: "viewport-exit",
      visible: block?.dataset.pdfPageVisible === "true"
    };
    state.fallback.events.push(event);
    heldContinuation.releaseRequestedAt = at;
    maybeResumeHeldContinuation();
    return structuredClone(event);
  };
  state.readHeldContinuation = () => heldContinuation
    ? {
        abortSignalId: heldContinuation.attempt?.abortSignalId ?? null,
        minimumElapsed: heldContinuation.minimumElapsed,
        releaseRequestedAt: heldContinuation.releaseRequestedAt,
        renderAttemptId: heldContinuation.attempt?.renderAttemptId ?? null,
        resumed: heldContinuation.resumed
      }
    : null;
  state.snapshot = () => {
    drainLongTasks();
    return structuredClone({
      draws: state.draws,
      errors: state.errors,
      fallback: state.fallback,
      longTasks: state.longTasks,
      notices: state.notices,
      samples: state.samples,
      scenarios: state.scenarios,
      sourceFiles: state.sourceFiles,
      spoken: state.spoken,
      workerEvents: state.workerEvents,
      workerLifecycle: state.workerLifecycle
    });
  };
})();
`;

function transitionName(configuration) {
  if (configuration.browserZoom > 1) return "browser-zoom";
  if (configuration.pinchZoom > 1) return "visual-viewport-pinch";
  return "normal";
}

function browserExpression(expression) {
  return `(() => { ${expression} })()`;
}

export function asyncBrowserExpression(expression) {
  return `(async () => { ${expression} })()`;
}

function pageCanvasExpression(pageNumber) {
  return browserExpression(`
    const block = document.querySelector('#pdf-page-${pageNumber}');
    const canvas = block?.querySelector('canvas');
    if (!block || !canvas) return null;
    return {
      capped: canvas.dataset.pdfRasterCapped === 'true',
      distance: Number(block.dataset.pdfPageDistance),
      height: canvas.height,
      renderSource: canvas.dataset.pdfRenderSource || null,
      scale: Number(canvas.dataset.pdfRasterScale) || null,
      targetHeight: Number(canvas.dataset.pdfRasterTargetHeight) || null,
      targetScale: Number(canvas.dataset.pdfRasterTargetScale) || null,
      targetWidth: Number(canvas.dataset.pdfRasterTargetWidth) || null,
      visible: block.dataset.pdfPageVisible === 'true',
      width: canvas.width,
      wordOverlays: block.querySelectorAll('.pdf-word-overlay').length
    };
  `);
}

export function dispatchToCdpSession(
  cdp,
  method,
  params,
  sessionId,
) {
  if (!sessionId) {
    throw new Error("A flattened child session ID is required for dispatch.");
  }
  const id = cdp.nextId++;
  const promise = new Promise((resolve, reject) => {
    cdp.pending.set(id, {
      reject(error) {
        reject(error);
      },
      resolve(result) {
        resolve(result);
      },
    });
    try {
      cdp.webSocket.send(JSON.stringify({ id, method, params, sessionId }));
    } catch (error) {
      cdp.pending.delete(id);
      reject(error);
    }
  });
  return { id, method, promise, sessionId };
}

export async function settleCdpCommandDispatches(
  cdp,
  dispatches,
  deadlineAt,
) {
  const settlement = Promise.allSettled(
    dispatches.map((dispatch) => dispatch.promise),
  );
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  let timeoutId;
  const outcome = await Promise.race([
    settlement.then((results) => ({ results, timedOut: false })),
    new Promise((resolve) => {
      timeoutId = setTimeout(
        () => resolve({ results: null, timedOut: true }),
        remainingMs,
      );
    }),
  ]);
  clearTimeout(timeoutId);
  if (outcome.timedOut) {
    for (const dispatch of dispatches) {
      const pending = cdp.pending.get(dispatch.id);
      if (!pending) continue;
      cdp.pending.delete(dispatch.id);
      pending.reject(
        new Error(
          `Timed out waiting for CDP ${dispatch.method} (${dispatch.sessionId}).`,
        ),
      );
    }
  }
  const results = outcome.results ?? await settlement;
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return results.map((result) => result.value);
}

export function sendToCdpSession(
  cdp,
  method,
  params,
  sessionId,
  timeoutMs = CDP_CHILD_COMMAND_TIMEOUT_MS,
) {
  if (!sessionId) return cdp.send(method, params);
  const dispatch = dispatchToCdpSession(cdp, method, params, sessionId);
  return settleCdpCommandDispatches(
    cdp,
    [dispatch],
    Date.now() + timeoutMs,
  ).then(([result]) => result);
}

const CDP_CHILD_SETUP_COMMANDS = Object.freeze([
  ["network-enable", "Network.enable", {}],
  ["runtime-enable", "Runtime.enable", {}],
  ["cache-disable", "Network.setCacheDisabled", { cacheDisabled: true }],
  ["auto-attach", "Target.setAutoAttach", {
    autoAttach: true,
    flatten: true,
    waitForDebuggerOnStart: true,
  }],
]);

export async function dispatchPausedServiceWorkerCommands(
  dispatchCommand,
  settleCommands,
  timeoutMs = CDP_CHILD_COMMAND_TIMEOUT_MS,
) {
  const dispatches = [
    ...CDP_CHILD_SETUP_COMMANDS.map(([name, method, params]) =>
      dispatchCommand(name, method, params)
    ),
    dispatchCommand("resume", "Runtime.runIfWaitingForDebugger", {}),
  ];
  const resumeDispatch = dispatches.at(-1);
  const deadlineAt = Date.now() + timeoutMs;
  for (const dispatch of dispatches) {
    dispatch.command.deadlineAt = deadlineAt;
  }
  await settleCommands(dispatches, deadlineAt);
  return {
    deadlineAt,
    dispatches,
    resumeDispatchedAt: resumeDispatch.command.dispatchedAt,
  };
}

async function configureAppSession(cdp, networkState) {
  const recordActivity = (entry) => {
    networkState.recentActivity.push({ at: Date.now(), ...entry });
    if (networkState.recentActivity.length > 40) {
      networkState.recentActivity.splice(
        0,
        networkState.recentActivity.length - 40,
      );
    }
  };
  const recordBootstrapSettlements = () => {
    for (const settlement of reconcileCdpTargetBootstrapRequests(
      networkState,
    )) {
      recordActivity({
        kind: "request-bootstrap-settled",
        method: settlement.method,
        phase: settlement.phase,
        requestId: settlement.requestId,
        sessionId: settlement.requestSessionId,
        targetId: settlement.targetId,
        type: settlement.resourceType,
        url: settlement.url,
      });
    }
  };
  const recordServiceWorkerBootstraps = () => {
    for (const observation of reconcileCdpServiceWorkerBootstraps(
      networkState,
    )) {
      recordActivity({
        kind: "service-worker-bootstrap-observed",
        method: observation.method,
        phase: observation.phase,
        requestId: observation.requestId,
        sessionId: observation.requestSessionId,
        targetId: observation.targetId,
        type: observation.resourceType,
        url: observation.url,
      });
    }
  };
  const recordRequest = (event, sessionId) => {
    const request = recordCdpNetworkRequest(networkState, event, sessionId);
    recordActivity({ kind: "request-start", ...request });
    recordBootstrapSettlements();
    recordServiceWorkerBootstraps();
  };
  const completeRequest = (event, sessionId, terminalReason) => {
    const request = completeCdpNetworkRequest(
      networkState,
      event,
      sessionId,
      terminalReason,
    );
    if (request) {
      recordActivity({
        ...request,
        kind: "request-complete",
      });
    }
    recordServiceWorkerBootstraps();
  };
  const recordFailure = (event, sessionId) => {
    const request = networkState.byId.get(
      `${sessionId ?? "page"}:${event.requestId}`,
    );
    networkState.failures.push({
      canceled: event.canceled ?? false,
      errorText: event.errorText,
      phase: request?.phase ?? networkState.phase,
      sessionId: sessionId ?? null,
      type: event.type ?? request?.type ?? null,
      url: request?.url ?? null,
    });
  };
  const recordResponse = (event, sessionId) => {
    if (event.response.status < 400) return;
    networkState.responseFailures.push({
      phase: networkState.byId.get(
        `${sessionId ?? "page"}:${event.requestId}`,
      )?.phase ?? networkState.phase,
      sessionId: sessionId ?? null,
      status: event.response.status,
      url: event.response.url,
    });
  };
  cdp.webSocket.addEventListener("message", (messageEvent) => {
    const message = JSON.parse(messageEvent.data);
    if (!message.method) return;
    const event = message.params ?? {};
    if (message.method === "Network.requestWillBeSent") {
      recordRequest(event, message.sessionId);
    } else if (message.method === "Network.loadingFailed") {
      recordFailure(event, message.sessionId);
      completeRequest(event, message.sessionId, "loading-failed");
    } else if (message.method === "Network.loadingFinished") {
      completeRequest(event, message.sessionId, "loading-finished");
    } else if (message.method === "Network.responseReceived") {
      recordResponse(event, message.sessionId);
    } else if (message.method === "Runtime.consoleAPICalled") {
      const [sentinel, workerInstanceId] = event.args ?? [];
      const target = networkState.targets.find(
        (candidate) => candidate.sessionId === message.sessionId,
      );
      if (
        sentinel?.value === "__linelight_issue68_worker__" &&
        Number.isInteger(workerInstanceId?.value) &&
        workerInstanceId.value > 0 &&
        target?.type === "worker" &&
        String(target.url).startsWith("blob:")
      ) {
        target.workerInstanceId = workerInstanceId.value;
        recordActivity({
          kind: "worker-instance-bound",
          phase: target.phase,
          sessionId: target.sessionId,
          targetId: target.targetId,
          type: target.type,
          url: target.url,
        });
      }
    } else if (message.method === "Target.targetInfoChanged") {
      const target = networkState.targets.find(
        (candidate) => candidate.targetId === event.targetInfo?.targetId,
      );
      if (target) {
        target.type = event.targetInfo.type;
        target.url = event.targetInfo.url;
        recordBootstrapSettlements();
        recordServiceWorkerBootstraps();
      }
    } else if (message.method === "Target.detachedFromTarget") {
      const target = networkState.targets.find(
        (candidate) => candidate.sessionId === event.sessionId,
      );
      if (target) {
        target.detached = true;
        recordActivity({
          kind: "target-detached",
          phase: target.phase,
          sessionId: target.sessionId,
          targetId: target.targetId,
          type: target.type,
          url: target.url,
        });
      }
    } else if (message.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo, waitingForDebugger } = event;
      const attachMetadata = {
        commands: [],
        commandDeadlineAt: null,
        lifecycleStrategy:
          targetInfo.type === "service_worker" && waitingForDebugger
            ? "setup-dispatched-before-resume"
            : waitingForDebugger
              ? "setup-completed-before-resume"
              : "already-running",
        parentSessionId: message.sessionId ?? null,
        phase: networkState.phase,
        resumeDispatchedAt: null,
        sessionId,
        targetId: targetInfo.targetId,
        type: targetInfo.type,
        url: targetInfo.url,
      };
      const target = {
        attachComplete: false,
        bootstrapRequestKey: null,
        commandDeadlineAt: null,
        commands: attachMetadata.commands,
        detached: false,
        lifecycleStrategy: attachMetadata.lifecycleStrategy,
        openerId: targetInfo.openerId ?? null,
        parentSessionId: message.sessionId ?? null,
        phase: networkState.phase,
        resumed: !waitingForDebugger,
        resumeDispatchedAt: null,
        serviceWorkerBootstrapRequestKey: null,
        sessionId,
        targetId: targetInfo.targetId,
        type: targetInfo.type,
        url: targetInfo.url,
        waitingForDebugger: Boolean(waitingForDebugger),
        workerInstanceId: null,
      };
      let commandResultSequence = 0;
      const dispatchAttachCommand = (name, method, params) => {
        const command = {
          cdpId: null,
          deadlineAt: null,
          dispatchedAt: Date.now(),
          dispatchSequence: attachMetadata.commands.length + 1,
          method,
          name,
          resultAt: null,
          resultSequence: null,
          status: "pending",
        };
        attachMetadata.commands.push(command);
        const dispatch = dispatchToCdpSession(
          cdp,
          method,
          params,
          sessionId,
        );
        command.cdpId = dispatch.id;
        if (name === "resume") {
          attachMetadata.resumeDispatchedAt = command.dispatchedAt;
          target.resumeDispatchedAt = command.dispatchedAt;
        }
        recordActivity({
          cdpId: command.cdpId,
          command: name,
          dispatchSequence: command.dispatchSequence,
          kind: "attach-command-start",
          method,
          phase: attachMetadata.phase,
          sessionId,
          targetId: targetInfo.targetId,
          type: targetInfo.type,
          url: targetInfo.url,
        });
        const promise = dispatch.promise.then(
          (result) => {
            command.status = "completed";
            if (name === "resume") target.resumed = true;
            return result;
          },
          (error) => {
            command.status = "failed";
            throw error;
          },
        ).finally(() => {
          command.resultAt = Date.now();
          command.resultSequence = ++commandResultSequence;
          recordActivity({
            cdpId: command.cdpId,
            command: name,
            dispatchSequence: command.dispatchSequence,
            kind: `attach-command-${command.status}`,
            method,
            phase: attachMetadata.phase,
            resultSequence: command.resultSequence,
            sessionId,
            targetId: targetInfo.targetId,
            type: targetInfo.type,
            url: targetInfo.url,
          });
        });
        return { ...dispatch, command, promise };
      };
      const settleAttachCommands = async (dispatches, deadlineAt) => {
        await settleCdpCommandDispatches(cdp, dispatches, deadlineAt);
      };
      const runAttachCommand = async (name, method, params) => {
        const dispatch = dispatchAttachCommand(name, method, params);
        await settleAttachCommands(
          [dispatch],
          Date.now() + CDP_CHILD_COMMAND_TIMEOUT_MS,
        );
      };
      networkState.targets.push(target);
      recordActivity({
        kind: "target-attached",
        phase: attachMetadata.phase,
        sessionId,
        targetId: targetInfo.targetId,
        type: targetInfo.type,
        url: targetInfo.url,
      });
      const attachPromise = (async () => {
        let setupSucceeded = false;
        let resumeDispatched = false;
        try {
          if (target.lifecycleStrategy === "setup-dispatched-before-resume") {
            resumeDispatched = true;
            const barrier = await dispatchPausedServiceWorkerCommands(
              dispatchAttachCommand,
              async (dispatches, deadlineAt) => {
                attachMetadata.commandDeadlineAt = deadlineAt;
                target.commandDeadlineAt = deadlineAt;
                await settleAttachCommands(dispatches, deadlineAt);
              },
            );
            if (barrier.resumeDispatchedAt !== target.resumeDispatchedAt) {
              throw new Error(
                "Service-worker resume dispatch did not match its barrier.",
              );
            }
          } else {
            const enableResults = await Promise.allSettled([
              runAttachCommand("network-enable", "Network.enable", {}),
              runAttachCommand("runtime-enable", "Runtime.enable", {}),
            ]);
            const enableFailure = enableResults.find(
              (result) => result.status === "rejected",
            );
            if (enableFailure) throw enableFailure.reason;
            await runAttachCommand(
              "cache-disable",
              "Network.setCacheDisabled",
              { cacheDisabled: true },
            );
            await runAttachCommand(
              "auto-attach",
              "Target.setAutoAttach",
              {
                autoAttach: true,
                flatten: true,
                waitForDebuggerOnStart: true,
              },
            );
          }
          setupSucceeded = true;
        } catch (error) {
          networkState.attachErrors.push({
            command: attachMetadata.commands.find(
              (command) => command.status === "failed",
            )?.name ?? null,
            error: String(error),
            sessionId,
            targetId: targetInfo.targetId,
            type: targetInfo.type,
            url: targetInfo.url,
          });
        } finally {
          if (waitingForDebugger && !resumeDispatched) {
            resumeDispatched = true;
            await runAttachCommand(
              "resume",
              "Runtime.runIfWaitingForDebugger",
              {},
            ).catch((error) => {
              networkState.attachErrors.push({
                command: "resume",
                error: `Could not resume target: ${String(error)}`,
                sessionId,
                targetId: targetInfo.targetId,
                type: targetInfo.type,
                url: targetInfo.url,
              });
            });
          }
          target.attachComplete =
            setupSucceeded &&
            target.resumed &&
            target.commands.every((command) => command.status === "completed");
          recordActivity({
            kind: target.attachComplete
              ? "target-attach-completed"
              : "target-attach-failed",
            phase: target.phase,
            sessionId: target.sessionId,
            targetId: target.targetId,
            type: target.type,
            url: target.url,
          });
          recordBootstrapSettlements();
          recordServiceWorkerBootstraps();
        }
      })();
      networkState.attachPromises.push(attachPromise);
      networkState.pendingAttachPromises.add(attachPromise);
      networkState.pendingAttachMetadata.set(attachPromise, attachMetadata);
      void attachPromise.then(
        () => {
          networkState.pendingAttachPromises.delete(attachPromise);
          networkState.pendingAttachMetadata.delete(attachPromise);
        },
        (error) => {
          networkState.pendingAttachPromises.delete(attachPromise);
          networkState.pendingAttachMetadata.delete(attachPromise);
          networkState.attachErrors.push({
            command: attachMetadata.commands.find(
              (command) => command.status === "failed",
            )?.name ?? null,
            error: `Unhandled attach setup error: ${String(error)}`,
            sessionId,
            targetId: targetInfo.targetId,
            type: targetInfo.type,
            url: targetInfo.url,
          });
        },
      );
    }
  });
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("DOM.enable"),
    cdp.send("Network.enable"),
    cdp.send("Performance.enable"),
    cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true,
    }),
  ]);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.setBypassServiceWorker", { bypass: true });
  networkState.serviceWorkerBypassed = true;
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: INSTRUMENTATION_SOURCE,
  });
}

async function waitForCdpNetworkFixedPoint(
  networkState,
  appUrl,
  label,
  timeoutMs = 10_000,
) {
  const startedAt = Date.now();
  const recentSamples = [];
  let stability = {
    requestCount: -1,
    stableSamples: 0,
    targetCount: -1,
  };
  while (Date.now() - startedAt < timeoutMs) {
    const pending = [...networkState.pendingAttachPromises];
    if (pending.length) {
      await Promise.race([
        Promise.allSettled(pending),
        delay(250),
      ]);
    }
    await delay(75);
    const requestCount = networkState.requests.length;
    const targetCount = networkState.targets.length;
    const phaseBootstrapCounts = cdpPhasePdfBootstrapCounts(
      networkState,
      appUrl,
      label,
    );
    const attachmentReady =
      isCdpAttachmentStateHealthy(networkState) &&
      hasCdpPhasePdfBootstrapCoverage(networkState, appUrl, label) &&
      (networkState.failures ?? []).every((failure) => failure?.canceled) &&
      (networkState.responseFailures ?? []).length === 0 &&
      networkState.requests.every(
        (request) => isLoopbackRequest(request?.url, appUrl),
      );
    const incompleteTargetCount = networkState.targets.filter(
      (target) => !isCdpTargetSetupComplete(target),
    ).length;
    stability = advanceCdpFixedPointStability(stability, {
      attachmentReady,
      inflightRequestCount: networkState.inflightRequests.size,
      pendingAttachCount: networkState.pendingAttachPromises.size,
      requestCount,
      targetCount,
    });
    recentSamples.push({
      attachErrorCount: networkState.attachErrors.length,
      attachmentReady,
      elapsedMs: Date.now() - startedAt,
      incompleteTargetCount,
      inflightRequestCount: networkState.inflightRequests.size,
      pendingAttachCount: networkState.pendingAttachPromises.size,
      requestCount,
      serviceWorkerBypassed: networkState.serviceWorkerBypassed === true,
      stableSamples: stability.stableSamples,
      targetCount,
    });
    if (recentSamples.length > 12) recentSamples.shift();
    if (stability.fixedPointReached) {
      const fixedPoint = {
        attachErrorCount: networkState.attachErrors.length,
        attachmentReady,
        attachPromiseCount: networkState.attachPromises.length,
        completedRequestCount: networkState.completedRequestCount,
        documentBootstrapSettlementCount:
          phaseBootstrapCounts.documentBootstrapSettlementCount,
        inflightRequestCount: 0,
        label,
        pendingAttachCount: 0,
        parserBootstrapSettlementCount:
          phaseBootstrapCounts.parserBootstrapSettlementCount,
        requestCount,
        serviceWorkerBypassed: networkState.serviceWorkerBypassed === true,
        serviceWorkerBootstrapObservationCount:
          networkState.serviceWorkerBootstrapObservations.length,
        targetBootstrapSettlementCount:
          networkState.targetBootstrapSettlements.length,
        targetCount,
      };
      networkState.networkFixedPoints.push(fixedPoint);
      return {
        diagnostic: buildCdpNetworkFixedPointDiagnostic(
          networkState,
          appUrl,
          label,
          "fixed-point-reached",
          {
            elapsedMs: Date.now() - startedAt,
            recentSamples,
            stableSamples: stability.stableSamples,
            timeoutMs,
          },
        ),
        fixedPoint,
      };
    }
  }
  const diagnostic = buildCdpNetworkFixedPointDiagnostic(
    networkState,
    appUrl,
    label,
    "timeout",
    {
      elapsedMs: Date.now() - startedAt,
      recentSamples,
      stableSamples: stability.stableSamples,
      timeoutMs,
    },
  );
  networkState.fixedPointDiagnostics.push(diagnostic);
  throw new Error(
    `CDP worker attachment and network activity did not reach a fixed point for ${label}.`,
  );
}

async function navigateToReader(cdp, appUrl, configuration, fallback = false) {
  await applyMatrixConfiguration(cdp, configuration, false);
  const url = new URL(appUrl);
  if (fallback) url.searchParams.set("issue68Fallback", "1");
  await cdp.send("Page.navigate", { url: url.href });
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector('.import-button')) &&
      Boolean(globalThis.__lineLightIssue68)`,
    "the instrumented LineLight reader shell",
    SCENARIO_TIMEOUT_MS,
  );
}

async function readPrivateLibraryDiagnostic(cdp) {
  return evaluate(
    cdp,
    asyncBrowserExpression(`
      const requestValue = (request) => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const digestIdentity = async (value) => {
        if (typeof value !== 'string' || !value) return null;
        const bytes = new TextEncoder().encode(JSON.stringify([value]));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0')
        ).join('');
      };
      try {
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open('guided-reader-library');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const transaction = database.transaction(
            ['documents', 'library', 'state', 'pdf-sources', 'pdf-pages'],
            'readonly'
          );
          const library = await requestValue(
            transaction.objectStore('library').getAll()
          );
          const activeDocumentId = await requestValue(
            transaction.objectStore('state').get('active-document-id')
          );
          const activeDocument = typeof activeDocumentId === 'string'
            ? await requestValue(
                transaction.objectStore('documents').get(activeDocumentId)
              )
            : null;
          const documentCount = await requestValue(
            transaction.objectStore('documents').count()
          );
          const sourceCount = await requestValue(
            transaction.objectStore('pdf-sources').count()
          );
          const pageCount = await requestValue(
            transaction.objectStore('pdf-pages').count()
          );
          return {
            activeDocumentIdentityHash: await digestIdentity(activeDocumentId),
            activeDocumentPresent: Boolean(activeDocument),
            available: true,
            documentCount,
            entryCount: library.length,
            pageCount,
            pdfEntryCount: library.filter((entry) => entry?.kind === 'pdf').length,
            sourceCount
          };
        } finally {
          database.close();
        }
      } catch {
        return {
          activeDocumentIdentityHash: null,
          activeDocumentPresent: false,
          available: false,
          documentCount: null,
          entryCount: null,
          errorCategory: 'indexeddb-read',
          pageCount: null,
          pdfEntryCount: null,
          sourceCount: null
        };
      }
    `),
  );
}

async function readFallbackImportDomDiagnostic(cdp) {
  return evaluate(
    cdp,
    browserExpression(`
      const pageView = document.querySelector('.pdf-page-view');
      const pageOne = document.querySelector('#pdf-page-1');
      const canvas = pageOne?.querySelector('canvas') ?? null;
      const canvasSource = canvas?.dataset.pdfRenderSource || '';
      const fileInput = document.querySelector('input[type="file"]');
      const notice = document.querySelector('.notice')?.textContent?.trim() || '';
      const noticeCategory = (${fixedNoticeCategory.toString()})(notice);
      return {
        fallbackActive: pageView?.dataset.pdfRenderFallback === 'true',
        fileInputDisabled: fileInput instanceof HTMLInputElement
          ? fileInput.disabled
          : null,
        fileInputPresent: Boolean(fileInput),
        importDialogPresent: Boolean(document.querySelector('.import-modal')),
        loadingPageCount: Array.from(
          document.querySelectorAll('.pdf-page-loading')
        ).filter((element) => getComputedStyle(element).display !== 'none').length,
        mountedPageCount: document.querySelectorAll('.pdf-page-block').length,
        noticeCategory,
        noticePresent: Boolean(notice),
        pageOneCanvasHeight: canvas?.height ?? null,
        pageOneCanvasSource: ['main-fallback', 'worker-bitmap'].includes(canvasSource)
          ? canvasSource
          : canvasSource ? 'other' : null,
        pageOneCanvasWidth: canvas?.width ?? null,
        pageOnePresent: Boolean(pageOne),
        pageOneVisible: pageOne?.dataset.pdfPageVisible === 'true',
        pageOneWordOverlayCount:
          pageOne?.querySelectorAll('.pdf-word-overlay').length ?? 0,
        pageViewPresent: Boolean(pageView)
      };
    `),
  );
}

async function collectPersistedFallbackDiagnosticSetup(
  cdp,
  appUrl,
  fixturePath,
  progress,
  setup,
) {
  const configuration = PDF_SHARPNESS_MATRIX[0];
  await runFallbackImportDiagnosticStage(
    progress,
    "setup-navigate",
    () => navigateToReader(cdp, appUrl, configuration),
  );
  setup.navigationCompleted = true;
  await runFallbackImportDiagnosticStage(
    progress,
    "setup-file-select",
    () => selectFixtureFile(cdp, fixturePath),
  );
  setup.fileSelected = true;
  const source = await runFallbackImportDiagnosticStage(
    progress,
    "setup-source-hash",
    () => waitForExpression(
      cdp,
      browserExpression(`
        const sources = globalThis.__lineLightIssue68?.sourceFiles ?? [];
        const source = sources[0];
        return sources.length > 0 &&
          Number.isInteger(source?.size) && source.size >= 0 &&
          /^[a-f0-9]{64}$/u.test(source?.sha256 ?? '')
          ? {
              bytes: source.size,
              sha256: source.sha256,
              sourceSelectionCount: sources.length
            }
          : false;
      `),
      "the setup PDF source hash",
      SCENARIO_TIMEOUT_MS,
    ),
  );
  setup.source = { bytes: source.bytes, sha256: source.sha256 };
  setup.sourceSelectionCount = source.sourceSelectionCount;
  const model = await runFallbackImportDiagnosticStage(
    progress,
    "setup-model-completion",
    () => waitForPdfModelCompletion(cdp, 6),
  );
  const documentId =
    typeof model.documentKey === "string" &&
    typeof model.revision === "string" &&
    model.documentKey.endsWith(`:${model.revision}`)
      ? model.documentKey.slice(0, -(model.revision.length + 1))
      : null;
  setup.completeEventCount = model.completeEventCount;
  setup.documentIdentityHash = documentId
    ? cdpDiagnosticIdentity(documentId)
    : null;
  setup.pageEventCount = model.pageEventCount;
  setup.library = await runFallbackImportDiagnosticStage(
    progress,
    "setup-library-snapshot",
    () => readPrivateLibraryDiagnostic(cdp),
  );
  setup.librarySnapshotCompleted = true;
  return setup;
}

async function collectFallbackImportDiagnostic(
  cdp,
  appUrl,
  fixturePath,
  fixture,
  networkState,
  progress,
) {
  const configuration = PDF_SHARPNESS_MATRIX[0];
  await runFallbackImportDiagnosticStage(
    progress,
    "fallback-navigate",
    () => navigateToReader(cdp, appUrl, configuration, true),
  );
  const { boundary, networkBoundary } =
    await runFallbackImportDiagnosticStage(
      progress,
      "fallback-file-select",
      async () => {
        const value = await evaluate(
          cdp,
          browserExpression(`
            const state = globalThis.__lineLightIssue68;
            return {
              sourceFileStart: state.sourceFiles.length,
              startedAt: performance.now(),
              workerEventStart: state.workerEvents.length,
              workerLifecycleStart: state.workerLifecycle.length
            };
          `),
        );
        const network = {
          attachPromiseCount: networkState.attachPromises.length,
          requestCount: networkState.requests.length,
          settlementCount: networkState.targetBootstrapSettlements.length,
          targetCount: networkState.targets.length,
        };
        await selectFixtureFile(cdp, fixturePath);
        return { boundary: value, networkBoundary: network };
      },
    );
  return runFallbackImportDiagnosticStage(
    progress,
    "fallback-chain",
    async () => {
      let importRequest = null;
      let outcome = "import-request-timeout";
      try {
        importRequest = await waitForExpression(
          cdp,
          browserExpression(`
            return globalThis.__lineLightIssue68.workerEvents.find((event) =>
              event.eventId > ${boundary.workerEventStart} &&
              event.direction === 'to-worker' &&
              event.type === 'import' &&
              Number.isInteger(event.jobId) &&
              typeof event.documentKey === 'string' && event.documentKey &&
              typeof event.revision === 'string' && event.revision
            ) || false;
          `),
          "the exact post-change fallback import request",
          10_000,
        );
        outcome = "import-chain-timeout";
        await waitForExpression(
          cdp,
          browserExpression(`
            const state = globalThis.__lineLightIssue68;
            const summarize = (${summarizePdfModelCompletion.toString()});
            const importRequest = state.workerEvents.find((event) =>
              event.eventId === ${importRequest.eventId} &&
              event.direction === 'to-worker' && event.type === 'import'
            );
            if (!importRequest) return false;
            const model = summarize(state.workerEvents.filter((event) =>
              event.direction === 'to-worker' ||
              event.workerInstanceId === importRequest.workerInstanceId
            ), 6);
            const laterStart = state.workerEvents.some((event) =>
              event.eventId > importRequest.eventId &&
              event.direction === 'to-worker' &&
              ['import', 'open'].includes(event.type)
            );
            const fallback = state.workerEvents.find((event) =>
              event.eventId > importRequest.eventId &&
              event.direction === 'from-worker' &&
              event.type === 'render-fallback' &&
              event.jobId === importRequest.jobId &&
              event.revision === importRequest.revision &&
              event.workerInstanceId === importRequest.workerInstanceId
            );
            const source = state.sourceFiles[${boundary.sourceFileStart}];
            const pageOne = document.querySelector('#pdf-page-1');
            return Boolean(
              model.complete &&
              model.importJobId === importRequest.jobId &&
              model.revision === importRequest.revision &&
              model.documentKey === importRequest.documentKey &&
              !laterStart && fallback &&
              source?.size === ${PUBLIC_PDF_FIXTURE_BYTES} &&
              source?.sha256 === ${JSON.stringify(PUBLIC_PDF_FIXTURE_SHA256)} &&
              document.querySelector('.pdf-page-view')?.dataset.pdfRenderFallback === 'true' &&
              pageOne?.querySelectorAll('.pdf-word-overlay').length >= 20
            );
          `),
          "the exact fallback import model/DOM chain",
          FALLBACK_IMPORT_DIAGNOSTIC_TIMEOUT_MS,
        );
        outcome = "import-chain-reached";
      } catch {
        // The report persists bounded fixed metadata that distinguishes the stage.
      }
      const [snapshot, dom, libraryAfter] = await Promise.all([
        evaluate(cdp, `globalThis.__lineLightIssue68.snapshot()`),
        readFallbackImportDomDiagnostic(cdp),
        readPrivateLibraryDiagnostic(cdp),
      ]);
      return {
        boundary,
        dom,
        fixture: { bytes: fixture.bytes, sha256: fixture.sha256 },
        importRequestObserved: Boolean(importRequest),
        libraryAfter,
        libraryBefore: null,
        networkBoundary,
        outcome,
        screenshot: null,
        snapshot,
      };
    },
  );
}

async function waitForPageShell(cdp, pageNumber) {
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector('#pdf-page-${pageNumber} .pdf-word-overlay'))`,
    `measured PDF page ${pageNumber}`,
    SCENARIO_TIMEOUT_MS,
  );
}

async function readPdfModelDiagnostic(cdp, expectedPageCount) {
  return evaluate(
    cdp,
    browserExpression(`
      const workerEvents = globalThis.__lineLightIssue68?.workerEvents ?? [];
      const summarize = (${summarizePdfModelCompletion.toString()});
      const root = document.querySelector('.reader-scroll');
      const list = document.querySelector('.pdf-pages');
      return {
        model: summarize(workerEvents, ${expectedPageCount}),
        mountedShellIds: Array.from(
          document.querySelectorAll('.pdf-page-block')
        ).map((block) => block.id),
        range: list?.dataset.pdfRange ?? null,
        scroll: root ? {
          clientHeight: root.clientHeight,
          scrollHeight: root.scrollHeight,
          scrollTop: root.scrollTop
        } : null,
        workerEvents: workerEvents.filter((event) =>
          (event.direction === 'from-worker' &&
            ['page', 'progress', 'complete'].includes(event.type)) ||
          (event.direction === 'to-worker' &&
            ['import', 'open'].includes(event.type))
        )
      };
    `),
  );
}

async function waitForPdfModelCompletion(cdp, expectedPageCount) {
  try {
    return await waitForExpression(
      cdp,
      browserExpression(`
        const summarize = (${summarizePdfModelCompletion.toString()});
        const summary = summarize(
          globalThis.__lineLightIssue68?.workerEvents ?? [],
          ${expectedPageCount}
        );
        return summary.complete ? summary : false;
      `),
      `the exact ${expectedPageCount}-page PDF worker model to complete`,
      SCENARIO_TIMEOUT_MS,
    );
  } catch (error) {
    const diagnostic = await readPdfModelDiagnostic(cdp, expectedPageCount)
      .catch((diagnosticError) => ({
        diagnosticError: String(diagnosticError),
      }));
    throw new Error(
      `${error instanceof Error ? error.message : error}\n` +
      `PDF model diagnostic: ${JSON.stringify(diagnostic)}`,
    );
  }
}

async function readRasterTransitionDiagnostic(
  cdp,
  pageNumber,
  scenarioStart,
  modelCompletion,
) {
  const [canvas, model, activity] = await Promise.all([
    evaluate(cdp, pageCanvasExpression(pageNumber)),
    readPdfModelDiagnostic(cdp, 6),
    evaluate(
      cdp,
      browserExpression(`
        const state = globalThis.__lineLightIssue68;
        return {
          draws: (state?.draws ?? []).slice(${scenarioStart.drawStart}).filter(
            (draw) => draw.page === ${pageNumber}
          ),
          workerEvents: (state?.workerEvents ?? []).filter((event) =>
            event.pageNumber === ${pageNumber} &&
            event.jobId === ${modelCompletion.importJobId} &&
            event.revision === ${JSON.stringify(modelCompletion.revision)} &&
            ['render', 'bitmap'].includes(event.type)
          )
        };
      `),
    ),
  ]);
  return { activity, canvas, model };
}

async function mountPdfPageByTraversal(cdp, pageNumber) {
  const startedAt = Date.now();
  let lastState = null;
  let stagnantSteps = 0;
  for (
    let step = 0;
    step < PDF_VIRTUAL_SCROLL_MAX_STEPS &&
      Date.now() - startedAt < SCENARIO_TIMEOUT_MS;
    step += 1
  ) {
    const state = await evaluate(
      cdp,
      browserExpression(`
        const targetPage = ${pageNumber};
        const root = document.querySelector('.reader-scroll');
        const list = document.querySelector('.pdf-pages');
        const readState = () => {
          const blocks = Array.from(document.querySelectorAll('.pdf-page-block'));
          const mountedPages = blocks.map(
            (block) => Number(block.dataset.pdfPageIndex) + 1
          ).filter(Number.isInteger).sort((left, right) => left - right);
          const visiblePages = blocks.filter(
            (block) => block.dataset.pdfPageVisible === 'true'
          ).map(
            (block) => Number(block.dataset.pdfPageIndex) + 1
          ).filter(Number.isInteger).sort((left, right) => left - right);
          return {
            found: Boolean(document.querySelector('#pdf-page-' + targetPage)),
            mountedPages,
            range: list?.dataset.pdfRange ?? null,
            scroll: root ? {
              clientHeight: root.clientHeight,
              scrollHeight: root.scrollHeight,
              scrollTop: root.scrollTop
            } : null,
            visiblePages
          };
        };
        const before = readState();
        if (before.found || !root || !list || before.mountedPages.length === 0) {
          return before;
        }
        const plan = (${planPdfVirtualScroll.toString()})({
          ...before.scroll,
          mountedPages: before.mountedPages,
          targetPage,
          visiblePages: before.visiblePages
        });
        root.scrollTop = plan.nextScrollTop;
        return new Promise((resolve) => requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve({
            ...readState(),
            attemptedDirection: plan.direction,
            attemptedScrollTop: plan.nextScrollTop,
            previousScrollTop: before.scroll.scrollTop
          }))
        ));
      `),
    );
    lastState = state;
    if (state?.found) return state;
    if (!state?.scroll || !state?.mountedPages?.length) {
      throw new Error(
        `Cannot traverse the virtualized PDF to page ${pageNumber}: ` +
        JSON.stringify(state),
      );
    }
    if (state.scroll.scrollTop === state.previousScrollTop) stagnantSteps += 1;
    else stagnantSteps = 0;
    if (stagnantSteps >= 8) break;
  }
  throw new Error(
    `Bounded virtualized PDF traversal did not mount page ${pageNumber}: ` +
    JSON.stringify(lastState),
  );
}

async function scrollPageIntoView(cdp, pageNumber) {
  await waitForExpression(
    cdp,
    browserExpression(`
      return globalThis.__lineLightIssue68.workerEvents.some((event) =>
        event.direction === 'from-worker' && event.type === 'page' &&
        event.pageNumber === ${pageNumber}
      );
    `),
    `PDF page ${pageNumber} worker model`,
    SCENARIO_TIMEOUT_MS,
  );
  await mountPdfPageByTraversal(cdp, pageNumber);
  await waitForPageShell(cdp, pageNumber);
  await evaluate(
    cdp,
    `document.querySelector('#pdf-page-${pageNumber}')?.scrollIntoView({
      behavior: 'auto', block: 'center'
    }); true`,
  );
  await waitForExpression(
    cdp,
    `document.querySelector('#pdf-page-${pageNumber}')?.dataset.pdfPageVisible === 'true'`,
    `PDF page ${pageNumber} to enter the viewport`,
    SCENARIO_TIMEOUT_MS,
  );
}

async function waitForSharpCanvas(
  cdp,
  pageNumber,
  source = null,
  modelCompletion = null,
) {
  return waitForExpression(
    cdp,
    browserExpression(`
      const block = document.querySelector('#pdf-page-${pageNumber}');
      const canvas = block?.querySelector('canvas');
      if (!canvas || block?.dataset.pdfPageVisible !== 'true') return false;
      const bounds = canvas.getBoundingClientRect();
      const pageEvent = globalThis.__lineLightIssue68.workerEvents.findLast(
        (event) => event.direction === 'from-worker' &&
          event.type === 'page' && event.pageNumber === ${pageNumber} &&
          (${modelCompletion?.importJobId ?? "null"} === null ||
            event.jobId === ${modelCompletion?.importJobId ?? "null"}) &&
          (${JSON.stringify(modelCompletion?.revision ?? null)} === null ||
            event.revision === ${JSON.stringify(modelCompletion?.revision ?? null)})
      );
      const targetWidth = Number(canvas.dataset.pdfRasterTargetWidth);
      const targetHeight = Number(canvas.dataset.pdfRasterTargetHeight);
      const renderSource = canvas.dataset.pdfRenderSource || null;
      if (${JSON.stringify(source)} && renderSource !== ${JSON.stringify(source)}) return false;
      return bounds.width > 0 && bounds.height > 0 &&
        pageEvent?.pageWidth > 0 && pageEvent?.pageHeight > 0 &&
        targetWidth > 0 && targetHeight > 0 &&
        canvas.width === targetWidth && canvas.height === targetHeight && {
          actualHeight: canvas.height,
          actualWidth: canvas.width,
          cssHeight: bounds.height,
          cssWidth: bounds.width,
          pageHeight: pageEvent.pageHeight,
          pageWidth: pageEvent.pageWidth,
          renderSource,
          scale: Number(canvas.dataset.pdfRasterScale),
          targetCapped: canvas.dataset.pdfRasterCapped === 'true',
          targetHeight,
          targetScale: Number(canvas.dataset.pdfRasterTargetScale),
          targetWidth
        };
    `),
    `page ${pageNumber} physical-pixel raster`,
    SCENARIO_TIMEOUT_MS,
  );
}

async function readViewport(cdp) {
  return evaluate(
    cdp,
    browserExpression(`
      return {
        devicePixelRatio,
        layoutHeight: innerHeight,
        layoutWidth: innerWidth,
        visualViewportScale: visualViewport?.scale || 1
      };
    `),
  );
}

async function collectViewport(cdp, configuration, before) {
  const after = await readViewport(cdp);
  return {
    beforeDevicePixelRatio: before.devicePixelRatio,
    beforeLayoutHeight: before.layoutHeight,
    beforeLayoutWidth: before.layoutWidth,
    beforeVisualViewportScale: before.visualViewportScale,
    devicePixelRatio: after.devicePixelRatio,
    layoutHeight: after.layoutHeight,
    layoutWidth: after.layoutWidth,
    mobile: configuration.kind === "mobile",
    transition: transitionName(configuration),
    visualViewportScale: after.visualViewportScale,
  };
}

async function waitForRenderedReferenceScreenshot(
  cdp,
  outputDirectory,
  fileName,
) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  let attempts = 0;
  let lastAnalysis = null;
  let lastError = null;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const screenshot = await cdp.send("Page.captureScreenshot", {
        captureBeyondViewport: false,
        format: "png",
        fromSurface: true,
      });
      const bytes = Buffer.from(screenshot.data, "base64");
      lastAnalysis = analyzeReferencePixels(decodePngScreenshot(bytes));
      if (lastAnalysis.renderedPage) {
        const filePath = path.join(outputDirectory, fileName);
        await writeFile(filePath, bytes);
        return {
          artifact: await fileArtifact(filePath),
          readiness: {
            ...lastAnalysis,
            attempts,
          },
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(
    `The original PDF viewer never produced a rendered-page pixel proof: ${JSON.stringify({
      attempts,
      lastAnalysis,
      lastError,
    })}`,
  );
}

async function captureStableReferenceDiagnosticCandidates(
  cdp,
  outputDirectory,
) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  let attempts = 0;
  let captureErrorCount = 0;
  let previous = null;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const screenshot = await cdp.send("Page.captureScreenshot", {
        captureBeyondViewport: false,
        format: "png",
        fromSurface: true,
      });
      const bytes = Buffer.from(screenshot.data, "base64");
      const candidate = {
        analysis: analyzeReferencePixels(decodePngScreenshot(bytes)),
        attempt: attempts,
        bytes,
        sha256: await sha256Bytes(bytes),
      };
      if (
        previous &&
        previous.sha256 === candidate.sha256 &&
        previous.bytes.equals(candidate.bytes)
      ) {
        const candidates = [];
        for (const [index, stable] of [previous, candidate].entries()) {
          const filePath = path.join(
            outputDirectory,
            REFERENCE_CAPTURE_DIAGNOSTIC_CANDIDATES[index],
          );
          await writeFile(filePath, stable.bytes);
          candidates.push({
            ...(await fileArtifact(filePath)),
            analysis: stable.analysis,
            attempt: stable.attempt,
          });
        }
        return { attempts, candidates, captureErrorCount };
      }
      previous = candidate;
    } catch {
      captureErrorCount += 1;
      previous = null;
    }
    await delay(100);
  }
  throw new Error(
    "The reference-capture diagnostic did not observe two stable screenshots.",
  );
}

async function captureReferenceScreenshots(
  cdp,
  fixture,
  outputDirectory,
  targetPages,
) {
  const screenshots = new Map();
  const requestedUrl = new URL(pathToFileURL(fixture));
  for (const configuration of PDF_SHARPNESS_MATRIX) {
    requestedUrl.hash = `page=${targetPages.get(configuration.id)}&zoom=page-width`;
    await applyMatrixConfiguration(cdp, configuration, true);
    await cdp.send("Page.navigate", { url: requestedUrl.href });
    await waitForExpression(
      cdp,
      `document.readyState === 'complete' &&
        (document.contentType === 'application/pdf' ||
          Boolean(document.querySelector('embed[type="application/pdf"]')) ||
          location.protocol === 'chrome-extension:')`,
      `${configuration.id} original PDF viewer`,
      SCENARIO_TIMEOUT_MS,
    );
    screenshots.set(
      configuration.id,
      await waitForRenderedReferenceScreenshot(
        cdp,
        outputDirectory,
        `reference-${configuration.id}.png`,
      ),
    );
  }
  return {
    requestedUrl: requestedUrl.href,
    scheme: requestedUrl.protocol,
    screenshots,
  };
}

function samplesForPage(snapshot, scenario, pageNumber) {
  return snapshot.samples
    .slice(scenario.sampleStart, scenario.sampleEnd ?? snapshot.samples.length)
    .filter(
      (sample) =>
        sample.page === pageNumber &&
        sample.width > 0 &&
        sample.height > 0 &&
        sample.source,
    );
}

function drawsForPage(snapshot, scenario, pageNumber) {
  return snapshot.draws
    .slice(scenario.drawStart, scenario.drawEnd ?? snapshot.draws.length)
    .filter(
      (draw) =>
        draw.page === pageNumber &&
        draw.width > 0 &&
        draw.height > 0 &&
        draw.source,
    );
}

function hasNoResolutionRegression(samples) {
  let maximumPixels = 0;
  for (const sample of samples) {
    const pixels = sample.width * sample.height;
    if (pixels + 1 < maximumPixels) return false;
    maximumPixels = Math.max(maximumPixels, pixels);
  }
  return true;
}

async function collectAlignmentEvidence(cdp, configurationId) {
  await scrollPageIntoView(cdp, 2);
  const before = await evaluate(
    cdp,
    browserExpression(`
      const word = document.querySelector('#pdf-page-2 .pdf-word-overlay');
      if (!word) return null;
      word.click();
      return Number(word.dataset.pdfWord);
    `),
  );
  await evaluate(
    cdp,
    `document.querySelector('button[aria-label="Play narration"]')?.click(); true`,
  );
  await waitForExpression(
    cdp,
    browserExpression(`
      const active = document.querySelector('#active-spoken-word');
      return globalThis.__lineLightIssue68.spoken.length > 0 &&
        active && Number(active.dataset.pdfWord) !== ${Number(before)};
    `),
    "deterministic narration to advance the active PDF word",
    10_000,
  );
  const measurement = await evaluate(
    cdp,
    browserExpression(`
      const active = document.querySelector('#active-spoken-word');
      const activeRect = active?.getBoundingClientRect();
      const highlights = Array.from(
        active?.closest('.pdf-page-block')?.querySelectorAll(
          '.pdf-sentence-overlay.scope-active'
        ) || []
      ).map((element) => element.getBoundingClientRect());
      const center = activeRect ? {
        x: activeRect.left + activeRect.width / 2,
        y: activeRect.top + activeRect.height / 2
      } : null;
      const inside = Boolean(center && highlights.some((rectangle) =>
        center.x >= rectangle.left && center.x <= rectangle.right &&
        center.y >= rectangle.top && center.y <= rectangle.bottom
      ));
      return {
        activeWordAfter: Number(active?.dataset.pdfWord),
        activeWordBefore: ${Number(before)},
        activeWordInsideHighlight: inside,
        highlightRectangles: highlights.length,
        narrationAdvanced: Boolean(
          active && Number(active.dataset.pdfWord) !== ${Number(before)} &&
          globalThis.__lineLightIssue68.spoken.length
        ),
        spoken: structuredClone(globalThis.__lineLightIssue68.spoken)
      };
    `),
  );
  await evaluate(
    cdp,
    `document.querySelector('button[aria-label="Pause narration"]')?.click(); true`,
  );
  return {
    ...measurement,
    configurationId,
    passed:
      measurement.activeWordInsideHighlight && measurement.narrationAdvanced,
  };
}

async function selectAdjacentPreviewTarget(cdp) {
  await scrollPageIntoView(cdp, 1);
  return waitForExpression(
    cdp,
    browserExpression(`
      const candidates = Array.from(document.querySelectorAll(
        '.pdf-page-block[data-pdf-page-distance="1"]'
      ));
      const candidate = candidates.find((block) =>
        block.querySelector('.pdf-word-overlay') &&
        Number(block.dataset.pdfPageIndex) + 1 < 6
      ) || candidates[0];
      if (!candidate) return false;
      const canvas = candidate.querySelector('canvas');
      return {
        canvasHeight: canvas?.height ?? 0,
        canvasWidth: canvas?.width ?? 0,
        distance: Number(candidate.dataset.pdfPageDistance),
        page: Number(candidate.dataset.pdfPageIndex) + 1,
        shellRetained: true,
        wordOverlays: candidate.querySelectorAll('.pdf-word-overlay').length
      };
    `),
    "an adjacent measured page for the 1.25x preview probe",
    SCENARIO_TIMEOUT_MS,
  );
}

async function collectMatrixRun(
  cdp,
  appUrl,
  fixture,
  outputDirectory,
  configuration,
) {
  await navigateToReader(cdp, appUrl, configuration);
  await importFixture(cdp, fixture);
  await waitForExpression(
    cdp,
    `globalThis.__lineLightIssue68.sourceFiles.length === 1`,
    "the browser-side imported PDF hash",
    SCENARIO_TIMEOUT_MS,
  );
  const modelCompletion = await waitForPdfModelCompletion(cdp, 6);
  const adjacent = await selectAdjacentPreviewTarget(cdp);
  if (
    adjacent.distance !== 1 ||
    adjacent.canvasWidth !== 0 ||
    adjacent.canvasHeight !== 0
  ) {
    throw new Error(
      `${configuration.id} did not keep its adjacent preview off the composed canvas.`,
    );
  }

  const scenarioStart = await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.beginScenario(${JSON.stringify(configuration.id)})`,
  );
  await waitForExpression(
    cdp,
    browserExpression(`
      return globalThis.__lineLightIssue68.workerEvents.find((event) =>
        event.direction === 'from-worker' &&
        event.type === 'bitmap' &&
        event.pageNumber === ${adjacent.page} &&
        event.jobId === ${modelCompletion.importJobId} &&
        event.revision === ${JSON.stringify(modelCompletion.revision)} &&
        event.scale <= 1.2500001
      ) || false;
    `),
    `page ${adjacent.page} adjacent 1.25x worker preview`,
    SCENARIO_TIMEOUT_MS,
  );
  const beforeViewport = await readViewport(cdp);
  await applyMatrixConfiguration(cdp, configuration, true);
  const expectedDpr =
    configuration.baseDevicePixelRatio * configuration.browserZoom;
  const expectedLayoutWidth = Math.round(
    configuration.width / configuration.browserZoom,
  );
  const expectedLayoutHeight = Math.round(
    configuration.height / configuration.browserZoom,
  );
  await waitForExpression(
    cdp,
    `Math.abs(devicePixelRatio - ${expectedDpr}) < 0.02 &&
      Math.abs((visualViewport?.scale || 1) - ${configuration.pinchZoom}) < 0.02 &&
      Math.abs(innerWidth - ${expectedLayoutWidth}) <= 2 &&
      Math.abs(innerHeight - ${expectedLayoutHeight}) <= 2`,
    `${configuration.id} DPR/zoom transition`,
    SCENARIO_TIMEOUT_MS,
  );
  await scrollPageIntoView(cdp, adjacent.page);
  const previewComposition = await waitForExpression(
    cdp,
    browserExpression(`
      return globalThis.__lineLightIssue68.draws.find((draw) =>
        draw.page === ${adjacent.page} &&
        draw.visible === true &&
        draw.source === 'worker-bitmap' &&
        draw.scale > 0 &&
        draw.scale <= 1.2500001 &&
        draw.at >= ${scenarioStart.startedAt}
      ) || false;
    `),
    `page ${adjacent.page} connected-canvas preview composition`,
    SCENARIO_TIMEOUT_MS,
  );
  let rasterTransition;
  let sharp;
  let sharpComposition;
  try {
    sharp = await waitForSharpCanvas(
      cdp,
      adjacent.page,
      "worker-bitmap",
      modelCompletion,
    );
    rasterTransition = classifyPdfRasterTransition(previewComposition, sharp);
    sharpComposition = rasterTransition === "preview-satisfied-target"
      ? previewComposition
      : await waitForExpression(
        cdp,
        browserExpression(`
          return globalThis.__lineLightIssue68.draws.find((draw) =>
            draw.page === ${adjacent.page} &&
            draw.visible === true &&
            draw.source === 'worker-bitmap' &&
            draw.width === ${sharp.targetWidth} &&
            draw.height === ${sharp.targetHeight} &&
            Math.abs(draw.scale - ${sharp.targetScale}) <= 1e-7 &&
            draw.compositionId > ${previewComposition.compositionId}
          ) || false;
        `),
        `page ${adjacent.page} connected-canvas sharp composition`,
        SCENARIO_TIMEOUT_MS,
      );
  } catch (error) {
    const diagnostic = await readRasterTransitionDiagnostic(
      cdp,
      adjacent.page,
      scenarioStart,
      modelCompletion,
    ).catch((diagnosticError) => ({
      diagnosticError: String(diagnosticError),
    }));
    throw new Error(
      `${error instanceof Error ? error.message : error}\n` +
      `Raster transition diagnostic: ${JSON.stringify(diagnostic)}`,
    );
  }
  const lineLightScreenshot = await writeScreenshot(
    cdp,
    outputDirectory,
    `linelight-${configuration.id}.png`,
  );

  const alignment = await collectAlignmentEvidence(cdp, configuration.id);
  const intermediatePage = Math.min(6, adjacent.page + 1);
  const priorityTarget = Math.min(6, adjacent.page + 2);
  await scrollPageIntoView(cdp, intermediatePage);
  await waitForPageShell(cdp, priorityTarget);
  await waitForExpression(
    cdp,
    browserExpression(`
      const events = globalThis.__lineLightIssue68.workerEvents;
      const previewRequest = events.find((event) =>
        event.direction === 'to-worker' && event.type === 'render' &&
        event.enabled === true && event.visible === false &&
        event.distance === 1 && event.pageNumber === ${priorityTarget} &&
        event.jobId === ${modelCompletion.importJobId} &&
        event.revision === ${JSON.stringify(modelCompletion.revision)}
      );
      return previewRequest && events.find((event) =>
        event.direction === 'from-worker' && event.type === 'bitmap' &&
        event.pageNumber === ${priorityTarget} &&
        event.jobId === ${modelCompletion.importJobId} &&
        event.revision === ${JSON.stringify(modelCompletion.revision)} &&
        event.eventId > previewRequest.eventId
      ) || false;
    `),
    `page ${priorityTarget} adjacent preview to settle before priority action`,
    SCENARIO_TIMEOUT_MS,
  );
  const priorityScrollAction = await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.beginPriorityScroll(${priorityTarget})`,
  );
  await waitForExpression(
    cdp,
    `document.querySelector('#pdf-page-${priorityTarget}')?.dataset.pdfPageVisible === 'true'`,
    `PDF page ${priorityTarget} to enter the viewport after the priority action`,
    SCENARIO_TIMEOUT_MS,
  );
  const prioritySharp = await waitForSharpCanvas(
    cdp,
    priorityTarget,
    null,
    modelCompletion,
  );
  await waitForExpression(
    cdp,
    browserExpression(`
      return globalThis.__lineLightIssue68.draws.find((draw) =>
        draw.page === ${priorityTarget} &&
        draw.activityId > ${priorityScrollAction.activityId} &&
        draw.drawInvocationId > ${priorityScrollAction.drawInvocationBoundary} &&
        draw.geometryVisible === true &&
        draw.visible === true &&
        draw.visiblePages.includes(${priorityTarget}) &&
        draw.source === 'worker-bitmap' &&
        draw.width === ${prioritySharp.targetWidth} &&
        draw.height === ${prioritySharp.targetHeight}
      ) || false;
    `),
    `page ${priorityTarget} post-action priority composition`,
    SCENARIO_TIMEOUT_MS,
  );
  const priorityProbe = await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.finishPriorityProbe()`,
  );
  await waitForExpression(
    cdp,
    browserExpression(`
      const block = document.querySelector('#pdf-page-${adjacent.page}');
      const canvas = block?.querySelector('canvas');
      return !block || (block.dataset.pdfPageVisible === 'false' &&
        canvas?.width === 0 && canvas?.height === 0);
    `),
    `page ${adjacent.page} to release its offscreen canvas backing`,
    SCENARIO_TIMEOUT_MS,
  );
  const release = await evaluate(
    cdp,
    browserExpression(`
      const block = document.querySelector('#pdf-page-${adjacent.page}');
      const canvas = block?.querySelector('canvas');
      return {
        canvasHeight: canvas?.height ?? 0,
        canvasWidth: canvas?.width ?? 0,
        renderSource: canvas?.dataset.pdfRenderSource || null,
        shellRetained: Boolean(block),
        textOverlayRetained: Boolean(block?.querySelector('.pdf-word-overlay'))
      };
    `),
  );
  const scenario = await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.finishScenario()`,
  );
  const snapshot = await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.snapshot()`,
  );
  const pageSamples = samplesForPage(snapshot, scenario, adjacent.page);
  const pageDraws = drawsForPage(snapshot, scenario, adjacent.page);
  const targetWorkerEvents = snapshot.workerEvents.filter(
    (event) =>
      event.pageNumber === adjacent.page &&
      event.jobId === modelCompletion.importJobId &&
      event.revision === modelCompletion.revision,
  );
  const previewRequestIndex = targetWorkerEvents.findIndex(
    (event) =>
      event.direction === "to-worker" &&
      event.type === "render" &&
      event.enabled === true &&
      event.visible === false &&
      event.distance === 1 &&
      event.scale <= 1.25 + 1e-7,
  );
  const previewBitmapEvent = targetWorkerEvents.find(
    (event) =>
      event.direction === "from-worker" &&
      event.type === "bitmap" &&
      event.scale <= 1.25 + 1e-7 &&
      event.width === previewComposition.width &&
      event.height === previewComposition.height,
  );
  const sharpBitmapEvent = targetWorkerEvents.find(
    (event) =>
      event.direction === "from-worker" &&
      event.type === "bitmap" &&
      event.width === sharp.targetWidth &&
      event.height === sharp.targetHeight,
  );
  const priorityBitmaps = (priorityProbe?.workerEvents ?? []).filter(
    (event) =>
      event.direction === "from-worker" &&
      event.type === "bitmap" &&
      event.jobId === modelCompletion.importJobId &&
      event.revision === modelCompletion.revision,
  );
  const postScrollWorkerEvents = (priorityProbe?.workerEvents ?? []).filter(
    (event) =>
      Number.isInteger(event.activityId) &&
      event.activityId > Number(priorityProbe?.scrollAction?.activityId) &&
      event.jobId === modelCompletion.importJobId &&
      event.revision === modelCompletion.revision,
  ).sort((left, right) => left.activityId - right.activityId);
  const visibleRenderRequests = postScrollWorkerEvents.filter(
    (event) =>
      event.direction === "to-worker" &&
      event.type === "render" &&
      event.enabled === true &&
      event.visible === true,
  );
  const postScrollBitmaps = postScrollWorkerEvents.filter(
    (event) => event.direction === "from-worker" && event.type === "bitmap",
  );
  const targetRenderRequests = postScrollWorkerEvents.filter(
    (event) =>
      event.direction === "to-worker" &&
      event.type === "render" &&
      event.enabled === true &&
      event.pageNumber === priorityTarget,
  );
  const targetBitmaps = postScrollBitmaps.filter(
    (event) => event.pageNumber === priorityTarget,
  );
  const targetVisibleRequest = targetRenderRequests.find(
    (event) => event.visible === true,
  ) ?? null;
  const targetBitmapAfterVisibleRequest = targetVisibleRequest
    ? postScrollBitmaps.find(
        (event) =>
          event.pageNumber === priorityTarget &&
          event.activityId > targetVisibleRequest.activityId,
      ) ?? null
    : null;
  const postScrollCompositions = (priorityProbe?.compositions ?? []).filter(
    (composition) =>
      Number.isInteger(composition?.activityId) &&
      composition.activityId >
        Number(priorityProbe?.scrollAction?.activityId) &&
      Number.isInteger(composition?.drawInvocationId) &&
      composition.drawInvocationId >
        Number(priorityProbe?.scrollAction?.drawInvocationBoundary),
  ).sort((left, right) => left.activityId - right.activityId);
  const targetComposition = postScrollCompositions.find(
    (composition) =>
      composition.page === priorityTarget &&
      composition.geometryVisible === true &&
      composition.visible === true &&
      Array.isArray(composition.visiblePages) &&
      composition.visiblePages.includes(priorityTarget) &&
      composition.source === "worker-bitmap" &&
      composition.width === prioritySharp.targetWidth &&
      composition.height === prioritySharp.targetHeight,
  ) ?? null;
  const cachedTargetSatisfied =
    priorityProbe?.targetBefore?.latestBitmapWidth === prioritySharp.targetWidth &&
    priorityProbe?.targetBefore?.latestBitmapHeight === prioritySharp.targetHeight &&
    Math.abs(
      Number(priorityProbe?.targetBefore?.latestBitmapScale) -
        prioritySharp.targetScale,
    ) <= 1e-7;
  const summarizePriorityEvent = (event) => event
    ? {
        activityId: event.activityId,
        distance: Number.isFinite(event.distance) ? event.distance : null,
        enabled: typeof event.enabled === "boolean" ? event.enabled : null,
        eventId: event.eventId,
        height: event.height ?? null,
        identityHash: cdpDiagnosticIdentity(
          event.workerInstanceId,
          event.jobId,
          event.documentKey,
          event.revision,
          event.eventId,
        ),
        pageNumber: event.pageNumber,
        scale: event.scale ?? null,
        type: event.type,
        visible: typeof event.visible === "boolean" ? event.visible : null,
        width: event.width ?? null,
    }
    : null;
  const summarizePriorityComposition = (composition) => composition
    ? {
        activityId: composition.activityId,
        at: composition.at,
        bitmapEventId: composition.bitmapEventId ?? null,
        compositionId: composition.compositionId,
        drawInvocationId: composition.drawInvocationId,
        geometry: composition.geometry,
        geometryVisible: composition.geometryVisible,
        height: composition.height,
        page: composition.page,
        readerViewport: composition.readerViewport,
        scale: composition.scale,
        source: composition.source,
        visible: composition.visible,
        visiblePages: composition.visiblePages,
        width: composition.width,
    }
    : null;
  const staleBitmapCutoffActivityId = cachedTargetSatisfied
    ? targetComposition?.activityId
    : targetBitmapAfterVisibleRequest?.activityId;
  const nonTargetBitmaps = postScrollBitmaps.filter(
    (bitmap) => bitmap.pageNumber !== priorityTarget,
  );
  const staleWorkerBitmaps = nonTargetBitmaps.filter((bitmap) =>
    (
      !Number.isInteger(staleBitmapCutoffActivityId) ||
      bitmap.activityId < staleBitmapCutoffActivityId
    )
  ).map(summarizePriorityEvent);
  const staleNonVisibleCompositions = postScrollCompositions.filter(
    (composition) =>
      (
        !Number.isInteger(targetComposition?.activityId) ||
        composition.activityId < targetComposition.activityId
      ) &&
      (
        composition.geometryVisible !== true ||
        composition.visible !== true ||
        !Array.isArray(composition.visiblePages) ||
        !composition.visiblePages.includes(composition.page)
      ),
  ).map(summarizePriorityComposition);

  return {
    alignment,
    comparison: {
      lineLightScreenshot,
      paired: false,
      referenceReadiness: null,
      referenceScreenshot: null,
      sourceSha256: null,
      targetPage: adjacent.page,
    },
    canvasBudget: {
      maximumCount: scenario.maximumCanvasCount,
      maximumCountFrame: scenario.maximumCountFrame,
      maximumPixels: scenario.maximumCanvasPixels,
      maximumPixelsFrame: scenario.maximumPixelsFrame,
    },
    id: configuration.id,
    importedSource: snapshot.sourceFiles[0] ?? null,
    longTasks: selectPdfLongTasksForWindow(snapshot.longTasks, scenario),
    raster: {
      noLateLowOverwrite: hasNoResolutionRegression(pageDraws),
      noResolutionRegression:
        hasNoResolutionRegression(pageDraws) &&
        hasNoResolutionRegression(pageSamples),
      preview: {
        actualHeight: previewComposition.height,
        actualWidth: previewComposition.width,
        bitmapEventId: previewBitmapEvent?.eventId ?? null,
        composedAt: previewComposition.at,
        compositionId: previewComposition.compositionId,
        connectedCanvas: previewComposition.visible === true,
        distance: adjacent.distance,
        observed:
          previewRequestIndex >= 0 &&
          Boolean(previewBitmapEvent) &&
          previewComposition.visible === true,
        scale: previewComposition.scale,
        workerObserved: previewRequestIndex >= 0 && Boolean(previewBitmapEvent),
      },
      previewBeforeSharp:
        rasterTransition === "preview-to-sharp-upgrade" &&
        previewComposition.compositionId < sharpComposition.compositionId &&
        Number.isInteger(previewBitmapEvent?.eventId) &&
        Number.isInteger(sharpBitmapEvent?.eventId) &&
        previewBitmapEvent.eventId < sharpBitmapEvent.eventId,
      sharp: {
        actualHeight: sharp.actualHeight,
        actualWidth: sharp.actualWidth,
        bitmapEventId: sharpBitmapEvent?.eventId ?? null,
        composedAt: sharpComposition.at,
        compositionId: sharpComposition.compositionId,
        cssHeight: sharp.cssHeight,
        cssWidth: sharp.cssWidth,
        pageHeight: sharp.pageHeight,
        pageWidth: sharp.pageWidth,
        source: sharp.renderSource,
        targetCapped: sharp.targetCapped,
        targetHeight: sharp.targetHeight,
        targetScale: sharp.targetScale,
        targetWidth: sharp.targetWidth,
      },
      transition: rasterTransition,
    },
    release,
    runtimeErrors: snapshot.errors,
    viewport: await collectViewport(cdp, configuration, beforeViewport),
    visibleFirst: {
      firstComposedPage: priorityProbe?.compositions?.[0]?.page ?? null,
      firstWorkerBitmapPage: priorityBitmaps[0]?.pageNumber ?? null,
      firstPostScrollCompositionPage:
        postScrollCompositions[0]?.page ?? null,
      nonTargetBitmaps: nonTargetBitmaps.map(summarizePriorityEvent),
      staleNonVisibleCompositions,
      staleWorkerBitmaps,
      targetAfter: priorityProbe?.targetAfter ?? null,
      targetBefore: priorityProbe?.targetBefore ?? null,
      targetBitmapAfterVisibleRequest: summarizePriorityEvent(
        targetBitmapAfterVisibleRequest,
      ),
      targetBitmapCount: targetBitmaps.length,
      targetBitmaps: targetBitmaps.map(summarizePriorityEvent),
      targetComposition: summarizePriorityComposition(targetComposition),
      targetPage: priorityTarget,
      targetPath: cachedTargetSatisfied
        ? "cached-target"
        : "render-required",
      targetRenderRequestCount: targetRenderRequests.length,
      targetRenderRequests: targetRenderRequests.map(summarizePriorityEvent),
      targetVisibleRequest: summarizePriorityEvent(targetVisibleRequest),
      firstPostScrollBitmapPage: postScrollBitmaps[0]?.pageNumber ?? null,
      firstPostScrollVisibleRequestPage:
        visibleRenderRequests[0]?.pageNumber ?? null,
      scrollAction: priorityProbe?.scrollAction ?? null,
    },
  };
}

function fakeBitmap(width, height, closed) {
  return {
    bitmap: {
      close() {
        closed.count += 1;
      },
    },
    height,
    scale: 1,
    width,
  };
}

export function probePdfBitmapBudget() {
  const closed = { count: 0 };
  const store = createPdfPageStore({
    maxBitmaps: PDF_SHARPNESS_MAX_BITMAP_COUNT,
    maxBitmapPixels: PDF_SHARPNESS_MAX_BITMAP_PIXELS,
  });
  let peak = { count: 0, pixels: 0 };
  const rememberPeak = () => {
    const current = store.getBitmapStats();
    peak = {
      count: Math.max(peak.count, current.count),
      pixels: Math.max(peak.pixels, current.pixels),
    };
  };
  const mixedSizes = [
    [1024, 1024],
    [1800, 1200],
    [900, 2200],
    [2048, 1536],
    [640, 2800],
    [2300, 1100],
    [1400, 1400],
    [768, 3072],
    [1920, 1080],
    [2500, 1250],
  ];
  for (const [index, [width, height]] of mixedSizes.entries()) {
    store.setBitmap(index + 1, fakeBitmap(width, height, closed));
    rememberPeak();
  }
  const steadyState = store.getBitmapStats();

  store.clear();
  const releasePins = [];
  for (let page = 1; page <= PDF_SHARPNESS_MAX_BITMAP_COUNT + 1; page += 1) {
    releasePins.push(store.pinBitmap(page));
    store.setBitmap(page, fakeBitmap(2048, 2048, closed));
  }
  const pinnedPeak = store.getBitmapStats();
  const pinnedOverflowObserved =
    pinnedPeak.count > PDF_SHARPNESS_MAX_BITMAP_COUNT ||
    pinnedPeak.pixels > PDF_SHARPNESS_MAX_BITMAP_PIXELS;
  for (const release of releasePins) release();
  const afterUnpin = store.getBitmapStats();
  const passed =
    peak.count <= PDF_SHARPNESS_MAX_BITMAP_COUNT &&
    peak.pixels <= PDF_SHARPNESS_MAX_BITMAP_PIXELS &&
    steadyState.count <= PDF_SHARPNESS_MAX_BITMAP_COUNT &&
    steadyState.pixels <= PDF_SHARPNESS_MAX_BITMAP_PIXELS &&
    pinnedOverflowObserved &&
    afterUnpin.count <= PDF_SHARPNESS_MAX_BITMAP_COUNT &&
    afterUnpin.pixels <= PDF_SHARPNESS_MAX_BITMAP_PIXELS;
  store.dispose();
  return {
    afterUnpin,
    closedBitmaps: closed.count,
    limits: {
      count: PDF_SHARPNESS_MAX_BITMAP_COUNT,
      pixels: PDF_SHARPNESS_MAX_BITMAP_PIXELS,
    },
    mixedSizes: mixedSizes.map(([width, height]) => ({ height, width })),
    passed,
    peak,
    pinnedOverflowObserved,
    pinnedPeak,
    steadyState,
  };
}

async function readFallbackCancellationTimeoutDiagnostic(cdp, expected) {
  try {
    const raw = await evaluate(
      cdp,
      browserExpression(`
        const state = globalThis.__lineLightIssue68;
        const block = document.querySelector('#pdf-page-${expected.page}');
        const canvas = block?.querySelector('canvas') ?? null;
        return {
          dom: {
            blockPresent: Boolean(block),
            canvasHeight: canvas?.height ?? null,
            canvasPresent: Boolean(canvas),
            canvasWidth: canvas?.width ?? null,
            textOverlayCount: block?.querySelectorAll('.pdf-word-overlay').length ?? 0,
            visible: block?.dataset.pdfPageVisible === 'true'
          },
          events: state?.fallback?.events ?? [],
          held: state?.readHeldContinuation?.() ?? null
        };
      `),
    );
    return summarizePdfFallbackCancellationDiagnostic(raw, expected);
  } catch {
    return {
      category: "diagnostic-unavailable",
      counts: {},
      dom: null,
      events: [],
      expected: {
        abortSignalId: Number.isInteger(expected?.abortSignalId)
          ? expected.abortSignalId
          : null,
        page: Number.isInteger(expected?.page) ? expected.page : null,
        renderAttemptId: Number.isInteger(expected?.renderAttemptId)
          ? expected.renderAttemptId
          : null,
      },
      held: null,
      stage: PDF_FALLBACK_DIAGNOSTIC_STAGES.has(expected?.stage)
        ? expected.stage
        : null,
    };
  }
}

async function collectFallbackEvidence(
  cdp,
  appUrl,
  fixture,
  outputDirectory,
) {
  const configuration = PDF_SHARPNESS_MATRIX[0];
  await navigateToReader(cdp, appUrl, configuration, true);
  await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.beginScenario('forced-main-fallback'); true`,
  );
  await importFixture(cdp, fixture);
  await waitForExpression(
    cdp,
    `globalThis.__lineLightIssue68.sourceFiles.length === 1`,
    "the fallback browser-side imported PDF hash",
    SCENARIO_TIMEOUT_MS,
  );
  const modelCompletion = await waitForPdfModelCompletion(cdp, 6);
  await waitForExpression(
    cdp,
    `document.querySelector('.pdf-page-view')?.dataset.pdfRenderFallback === 'true'`,
    "the immediate worker fallback signal",
    SCENARIO_TIMEOUT_MS,
  );
  await scrollPageIntoView(cdp, 1);
  await waitForSharpCanvas(cdp, 1, "main-fallback", modelCompletion);
  const injectionTarget = await selectAdjacentPreviewTarget(cdp);
  if (
    injectionTarget.page !== 2 ||
    injectionTarget.distance !== 1 ||
    injectionTarget.canvasWidth !== 0 ||
    injectionTarget.canvasHeight !== 0
  ) {
    throw new Error(
      "Fallback injection page 2 was not the exact adjacent unsatisfied page.",
    );
  }
  const injectionArm = await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.failNextFallback(
      ${JSON.stringify(modelCompletion.documentKey)},
      ${JSON.stringify(modelCompletion.revision)},
      ${injectionTarget.page}
    )`,
  );
  await scrollPageIntoView(cdp, injectionTarget.page);
  const injectedFailure = await waitForExpression(
    cdp,
    browserExpression(`
      return globalThis.__lineLightIssue68.fallback.events.find((event) =>
        event.type === 'staging-finish' &&
        event.outcome === 'injected-failure' &&
        event.documentKey === ${JSON.stringify(modelCompletion.documentKey)} &&
        event.revision === ${JSON.stringify(modelCompletion.revision)} &&
        event.page === ${injectionTarget.page} &&
        event.at >= ${injectionArm.at}
      ) || false;
    `),
    "the injected first fallback failure",
    SCENARIO_TIMEOUT_MS,
  );
  await waitForSharpCanvas(
    cdp,
    injectionTarget.page,
    "main-fallback",
    modelCompletion,
  );
  const retry = await waitForExpression(
    cdp,
    browserExpression(`
      const events = globalThis.__lineLightIssue68.fallback.events;
      const failure = events.find((event) =>
        event.type === 'staging-finish' &&
        event.outcome === 'injected-failure' &&
        event.documentKey === ${JSON.stringify(modelCompletion.documentKey)} &&
        event.revision === ${JSON.stringify(modelCompletion.revision)} &&
        event.page === ${injectionTarget.page} &&
        event.at === ${injectedFailure.at} &&
        Number.isInteger(event.abortSignalId) &&
        Number.isInteger(event.renderAttemptId) &&
        event.targetKey
      );
      const injectionArm = failure && events.find((event) =>
        event.type === 'injection-armed' &&
        event.documentKey === failure.documentKey &&
        event.page === failure.page &&
        event.revision === failure.revision &&
        event.at === ${injectionArm.at} &&
        event.at <= failure.at
      );
      const failedStart = failure && events.find((event) =>
        event.type === 'staging-start' &&
        event.abortSignalCandidateCount === 1 &&
        event.abortSignalId === failure.abortSignalId &&
        event.renderAttemptId === failure.renderAttemptId &&
        event.documentKey === failure.documentKey &&
        event.page === failure.page &&
        event.revision === failure.revision &&
        event.targetKey === failure.targetKey &&
        event.at <= failure.at
      );
      const retryStart = failure && events.find((event) =>
        event.type === 'staging-start' &&
        event.abortSignalCandidateCount === 1 &&
        Number.isInteger(event.abortSignalId) &&
        event.abortSignalId !== failure.abortSignalId &&
        event.renderAttemptId !== failure.renderAttemptId &&
        event.documentKey === failure.documentKey &&
        event.page === failure.page &&
        event.revision === failure.revision &&
        event.targetKey === failure.targetKey &&
        event.at > failure.at
      );
      const retryCompose = retryStart && events.find((event) =>
        event.type === 'visible-compose' &&
        event.abortSignalId === retryStart.abortSignalId &&
        event.renderAttemptId === retryStart.renderAttemptId &&
        event.documentKey === retryStart.documentKey &&
        event.page === retryStart.page &&
        event.revision === retryStart.revision &&
        event.targetKey === retryStart.targetKey &&
        event.at >= retryStart.at
      );
      return failure && injectionArm && failedStart && retryStart && retryCompose && {
        composedAt: retryCompose.at,
        documentKey: failure.documentKey,
        failedAbortSignalId: failure.abortSignalId,
        failedAttemptId: failure.renderAttemptId,
        failedAt: failure.at,
        injectionArmedAt: injectionArm.at,
        injectionPageDerivation: injectionArm.pageDerivation,
        page: failure.page,
        pageDerivation: failure.pageDerivation,
        retryAttemptId: retryStart.renderAttemptId,
        retryAbortSignalId: retryStart.abortSignalId,
        retryStartedAt: retryStart.at,
        revision: failure.revision,
        targetHeight: failure.targetHeight,
        targetKey: failure.targetKey,
        targetWidth: failure.targetWidth
      };
    `),
    "the failed fallback attempt to retry and compose the same page target",
    SCENARIO_TIMEOUT_MS,
  );

  const continuationArm = await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.delayNextContinuation(1000)`,
  );
  if (
    continuationArm.page !== 3 ||
    continuationArm.documentKey !== modelCompletion.documentKey ||
    continuationArm.revision !== modelCompletion.revision ||
    continuationArm.pageDerivation !== "next-page-from-sole-visible-page"
  ) {
    throw new Error(
      "The delayed fallback arm did not derive current import page 3.",
    );
  }
  await scrollPageIntoView(cdp, 3);
  const continuationDelay = await waitForExpression(
    cdp,
    browserExpression(`
      return globalThis.__lineLightIssue68.fallback.events.find(
        (event) => event.type === 'continuation-delay' &&
          Number.isInteger(event.renderAttemptId) &&
          event.documentKey === ${JSON.stringify(modelCompletion.documentKey)} &&
          event.revision === ${JSON.stringify(modelCompletion.revision)} &&
          event.page === ${continuationArm.page} &&
          event.armedAt === ${continuationArm.at}
      ) || false;
    `),
    "a real fallback render attempt to enter the one-second continuation delay",
    SCENARIO_TIMEOUT_MS,
  );
  if (
    continuationDelay.page !== 3 ||
    continuationDelay.pageDerivation !== "sole-visible-unsatisfied-page" ||
    !Number.isInteger(continuationDelay.abortSignalId) ||
    !continuationDelay.documentKey ||
    !continuationDelay.revision
  ) {
    throw new Error(
      "The delayed fallback attempt did not derive the intended visible page 3.",
    );
  }
  const cancelledPage = continuationDelay.page;
  const renderAttemptId = continuationDelay.renderAttemptId;
  let viewportExitRequest;
  let cancellationReady;
  let cancellationTerminal;
  let viewportExit;
  let continuationMinimumElapsed;
  let continuationResume;
  let cancellationStage = "viewport-exit-request";
  try {
    viewportExitRequest = await evaluate(
      cdp,
      `globalThis.__lineLightIssue68.markFallbackViewportExitRequest(${renderAttemptId}, 5)`,
    );
    cancellationStage = "page-traversal";
    await scrollPageIntoView(cdp, 5);
    cancellationStage = "cancellation-ready";
    cancellationReady = await waitForExpression(
      cdp,
      browserExpression(`
        const state = globalThis.__lineLightIssue68;
        const events = state?.fallback?.events ?? [];
        const cancelRequest = events.find((event) =>
          event.type === 'cancel-request' &&
          event.abortSignalId === ${continuationDelay.abortSignalId} &&
          event.renderAttemptId === ${renderAttemptId} &&
          event.documentKey === ${JSON.stringify(continuationDelay.documentKey)} &&
          event.revision === ${JSON.stringify(continuationDelay.revision)} &&
          event.page === ${cancelledPage} &&
          event.at >= ${viewportExitRequest.at}
        );
        const cancellationTerminal = cancelRequest && events.find((event) =>
          event.type === 'staging-finish' &&
          event.abortSignalId === ${continuationDelay.abortSignalId} &&
          event.outcome === 'cancelled' &&
          event.renderAttemptId === ${renderAttemptId} &&
          event.documentKey === ${JSON.stringify(continuationDelay.documentKey)} &&
          event.revision === ${JSON.stringify(continuationDelay.revision)} &&
          event.page === ${cancelledPage} &&
          event.cancelRequestedAt === cancelRequest.at &&
          event.at >= cancelRequest.at
        );
        const resumedEarly = events.some((event) =>
          event.type === 'continuation-resume' &&
          event.renderAttemptId === ${renderAttemptId}
        );
        const block = document.querySelector('#pdf-page-${cancelledPage}');
        const canvas = block?.querySelector('canvas') ?? null;
        if (
          !cancelRequest || !cancellationTerminal || resumedEarly || !block ||
          block.dataset.pdfPageVisible !== 'false' || !canvas ||
          canvas.width !== 0 || canvas.height !== 0 ||
          !block.querySelector('.pdf-word-overlay')
        ) return false;
        return {
          cancelRequest,
          cancellationTerminal,
          canvasHeight: canvas.height,
          canvasWidth: canvas.width,
          textOverlayCount: block.querySelectorAll('.pdf-word-overlay').length,
          visible: false
        };
      `),
      "the exact cancelled fallback attempt and released page backing",
      SCENARIO_TIMEOUT_MS,
    );
    cancellationTerminal = cancellationReady.cancellationTerminal;
    cancellationStage = "viewport-exit-confirmation";
    viewportExit = await evaluate(
      cdp,
      `globalThis.__lineLightIssue68.markFallbackViewportExit(${renderAttemptId})`,
    );
    cancellationStage = "minimum-elapsed";
    continuationMinimumElapsed = await waitForExpression(
      cdp,
      browserExpression(`
        return globalThis.__lineLightIssue68.fallback.events.find(
          (event) => event.type === 'continuation-minimum-elapsed' &&
            event.abortSignalId === ${continuationDelay.abortSignalId} &&
            event.renderAttemptId === ${renderAttemptId} &&
            event.documentKey === ${JSON.stringify(continuationDelay.documentKey)} &&
            event.revision === ${JSON.stringify(continuationDelay.revision)} &&
            event.page === ${cancelledPage} &&
            event.at - ${continuationDelay.at} >= 1000 &&
            event.afterMs === event.at - ${continuationDelay.at}
        ) || false;
      `),
      `page ${cancelledPage} continuation hold to reach one second`,
      SCENARIO_TIMEOUT_MS,
    );
    cancellationStage = "continuation-resume";
    continuationResume = await waitForExpression(
      cdp,
      browserExpression(`
        return globalThis.__lineLightIssue68.fallback.events.find(
          (event) => event.type === 'continuation-resume' &&
            event.abortSignalId === ${continuationDelay.abortSignalId} &&
            event.renderAttemptId === ${renderAttemptId} &&
            event.documentKey === ${JSON.stringify(continuationDelay.documentKey)} &&
            event.revision === ${JSON.stringify(continuationDelay.revision)} &&
            event.page === ${cancelledPage} &&
            event.afterMs === event.at - ${continuationDelay.at} &&
            event.at - ${continuationDelay.at} >= 1000 &&
            event.releaseRequestedAt === ${viewportExit.at} &&
            event.at >= ${continuationMinimumElapsed.at} &&
            event.at >= ${viewportExit.at}
        ) || false;
      `),
      `page ${cancelledPage} delayed continuation to resume after one second`,
      SCENARIO_TIMEOUT_MS,
    );
  } catch {
    const diagnostic = await readFallbackCancellationTimeoutDiagnostic(cdp, {
      abortSignalId: continuationDelay.abortSignalId,
      documentKey: continuationDelay.documentKey,
      page: cancelledPage,
      renderAttemptId,
      revision: continuationDelay.revision,
      stage: cancellationStage,
    });
    throw new Error(
      `Fallback cancellation lifecycle failed at ${cancellationStage}.\n` +
      `Fallback cancellation diagnostic: ${JSON.stringify(diagnostic)}`,
    );
  }
  await waitForSharpCanvas(cdp, 5, "main-fallback", modelCompletion);
  await waitForExpression(
    cdp,
    `globalThis.__lineLightIssue68.fallback.activeStaging === 0`,
    "all serialized fallback staging work to settle",
    SCENARIO_TIMEOUT_MS,
  );
  await evaluate(
    cdp,
    `new Promise((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(resolve)))`,
  );
  const screenshot = await writeScreenshot(
    cdp,
    outputDirectory,
    "fallback-visible-retry.png",
  );
  const scenario = await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.finishScenario()`,
  );
  const snapshot = await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.snapshot()`,
  );
  const {
    events: stagingEvents,
    maximumConcurrentStaging,
  } = selectPdfFallbackScenarioEvents(snapshot.fallback.events, {
    documentKey: modelCompletion.documentKey,
    revision: modelCompletion.revision,
    startedAt: scenario.startedAt,
  });
  const firstStaging = stagingEvents.find(
    (event) =>
      event.type === "staging-start",
  );
  const workerFallbackEvent = snapshot.workerEvents.find(
    (event) =>
      event.direction === "from-worker" &&
      event.type === "render-fallback" &&
      event.jobId === modelCompletion.importJobId &&
      event.revision === modelCompletion.revision,
  );
  const workerBitmapsAfterSignal = snapshot.workerEvents.filter(
    (event) =>
      event.direction === "from-worker" &&
      event.type === "bitmap" &&
      event.jobId === modelCompletion.importJobId &&
      event.revision === modelCompletion.revision &&
      event.at >= (workerFallbackEvent?.at ?? Number.POSITIVE_INFINITY),
  );
  const pageOneDraws = snapshot.draws
    .slice(scenario.drawStart)
    .filter((draw) => draw.page === 1);
  const cancellationBoundaryIndex = Math.min(
    ...stagingEvents.map((event, index) =>
      (
        event.renderAttemptId === renderAttemptId &&
        ["viewport-exit-request", "cancel-request"].includes(event.type)
      )
        ? index
        : Number.POSITIVE_INFINITY
    ),
  );
  const cancelledAttemptLateComposes = stagingEvents.filter(
    (event, index) =>
      event.type === "visible-compose" &&
      event.renderAttemptId === renderAttemptId &&
      (
        !Number.isFinite(event.at) ||
        event.at >= Math.min(
          viewportExitRequest.at,
          cancellationTerminal.cancelRequestedAt,
        ) ||
        index >= cancellationBoundaryIndex
      ),
  );
  const releasedCancelledPage = await evaluate(
    cdp,
    pageCanvasExpression(cancelledPage),
  );
  return {
    artifact: screenshot,
    importedSource: snapshot.sourceFiles[0] ?? null,
    injectedFailures: snapshot.fallback.injectedFailures,
    invisibleCancellation: {
      abortSignalId: continuationDelay.abortSignalId,
      canvasHeightAfterExit: releasedCancelledPage?.height ?? 0,
      canvasPresentAfterExit: Boolean(releasedCancelledPage),
      canvasWidthAfterExit: releasedCancelledPage?.width ?? 0,
      cancellationTerminal,
      completedAfterExit: cancelledAttemptLateComposes.length > 0,
      continuationDelayAt: continuationDelay.at,
      continuationDelayObserved: true,
      continuationArmedAt: continuationArm.at,
      continuationArmPageDerivation: continuationArm.pageDerivation,
      continuationMinimumElapsedAt: continuationMinimumElapsed.at,
      continuationMinimumElapsedObserved: true,
      continuationResumeAt: continuationResume.at,
      continuationResumeObserved: true,
      continuationResumedAfterMs: continuationResume.afterMs,
      continuationReleaseRequestedAt: viewportExit.at,
      documentKey: continuationDelay.documentKey,
      exitRequestedAt: viewportExitRequest.at,
      exitedAt: viewportExit.at,
      lateComposes: cancelledAttemptLateComposes,
      page: cancelledPage,
      pageDerivation: continuationDelay.pageDerivation,
      renderAttemptId,
      revision: continuationDelay.revision,
      textOverlayRetainedAfterExit:
        (releasedCancelledPage?.wordOverlays ?? 0) > 0,
      viewportExit,
      viewportExitRequest,
    },
    longTasks: selectPdfLongTasksForWindow(snapshot.longTasks, scenario),
    maximumConcurrentStaging,
    noLateLowOverwrite:
      workerBitmapsAfterSignal.length === 0 &&
      hasNoResolutionRegression(pageOneDraws),
    retry,
    retrySucceeded: Boolean(retry),
    runtimeErrors: snapshot.errors,
    signaledBeforeDocumentReady: Boolean(
      workerFallbackEvent &&
      firstStaging &&
      workerFallbackEvent.at <= firstStaging.at
    ),
    stagingEvents,
    workerFallbackEvent,
    workerQueueClosed:
      Boolean(workerFallbackEvent) && workerBitmapsAfterSignal.length === 0,
  };
}

function isLoopbackRequest(url, appUrl) {
  try {
    const parsed = new URL(url);
    if (["about:", "blob:", "data:"].includes(parsed.protocol)) return true;
    const app = new URL(appUrl);
    return (
      parsed.origin === app.origin &&
      ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function withTargetAncestry(targets) {
  const bySession = new Map(
    targets.map((target) => [target.sessionId, target]),
  );
  return targets.map((target) => {
    const ancestry = [];
    const visited = new Set([target.sessionId]);
    let parentSessionId = target.parentSessionId;
    while (parentSessionId && !visited.has(parentSessionId)) {
      visited.add(parentSessionId);
      const parent = bySession.get(parentSessionId);
      if (!parent) break;
      ancestry.push({
        phase: parent.phase,
        sessionId: parent.sessionId,
        type: parent.type,
        url: parent.url,
      });
      parentSessionId = parent.parentSessionId;
    }
    return { ...target, ancestry };
  });
}

function summarizeNetwork(
  networkState,
  appUrl,
  fixture,
  fixtureSha256,
  referenceScheme,
) {
  const targets = withTargetAncestry(networkState.targets);
  const targetBySession = new Map(
    targets.map((target) => [target.sessionId, target]),
  );
  const externalRequests = networkState.requests.filter(
    (request) => !isLoopbackRequest(request.url, appUrl),
  );
  const failures = [
    ...networkState.failures.filter((failure) => !failure.canceled),
    ...networkState.responseFailures,
    ...networkState.attachErrors,
  ];
  const fixtureName = path.basename(fixture);
  const sourceRequest = networkState.requests.find((request) => {
    try {
      return decodeURIComponent(request.url).includes(fixtureName);
    } catch {
      return request.url.includes(fixtureName);
    }
  });
  const normalPhaseIds = new Set(PDF_SHARPNESS_MATRIX.map(({ id }) => id));
  const documentWorker = (target) =>
    /pdf-document\.worker-[^/]+\.js(?:$|[?#])/u.test(target?.url ?? "");
  const parserWorker = (target) =>
    /pdf-parser\.worker-[^/]+\.js(?:$|[?#])/u.test(target?.url ?? "");
  const blobWrapper = (target) =>
    target?.phase === "forced-main-fallback" &&
    String(target?.url).startsWith("blob:");
  const targetChain = (target) => [target, ...(target?.ancestry ?? [])];
  const coverageTargets = {
    forcedBlobWrapper: targets.filter(blobWrapper),
    forcedParserWorker: targets.filter(
      (target) =>
        target.phase === "forced-main-fallback" &&
        parserWorker(target) &&
        targetChain(target).some(blobWrapper),
    ),
    normalDocumentWorker: targets.filter(
      (target) => normalPhaseIds.has(target.phase) && documentWorker(target),
    ),
    normalParserWorker: targets.filter(
      (target) =>
        normalPhaseIds.has(target.phase) &&
        parserWorker(target) &&
        targetChain(target).some(documentWorker),
    ),
  };
  const nonPageRequests = networkState.requests.filter(
    (request) => request.sessionId !== null,
  );
  const requestBelongsTo = (request, predicate) =>
    targetChain(targetBySession.get(request.sessionId)).some(predicate);
  const targetBootstrapSettlements = [
    ...networkState.targetBootstrapSettlements,
  ];
  const matrixCoverage = Object.fromEntries(
    PDF_SHARPNESS_MATRIX.map(({ id }) => {
      const documentTargets = targets.filter(
        (target) => target.phase === id && documentWorker(target),
      );
      const parserTargets = targets.filter(
        (target) =>
          target.phase === id &&
          parserWorker(target) &&
          targetChain(target).some(documentWorker),
      );
      const documentRequestCount = nonPageRequests.filter(
        (request) =>
          targetBySession.get(request.sessionId)?.phase === id &&
          requestBelongsTo(request, documentWorker),
      ).length;
      const parserRequestCount = nonPageRequests.filter(
        (request) =>
          targetBySession.get(request.sessionId)?.phase === id &&
          parserWorker(targetBySession.get(request.sessionId)) &&
          targetChain(targetBySession.get(request.sessionId)).some(
            documentWorker,
          ),
      ).length;
      const documentBootstrapSettlementCount =
        targetBootstrapSettlements.filter(
          (settlement) => {
            const target = targetBySession.get(settlement.targetSessionId);
            return target?.phase === id && documentWorker(target);
          },
        ).length;
      const parserBootstrapSettlementCount =
        targetBootstrapSettlements.filter(
          (settlement) => {
            const target = targetBySession.get(settlement.targetSessionId);
            return target?.phase === id && parserWorker(target);
          },
        ).length;
      return [id, {
        documentBootstrapSettlementCount,
        documentRequestCount,
        documentTargets,
        parserBootstrapSettlementCount,
        parserRequestCount,
        parserTargets,
      }];
    }),
  );
  const nonPageRequestCounts = {
    forcedBlobWrapper: nonPageRequests.filter(
      (request) => requestBelongsTo(request, blobWrapper),
    ).length,
    forcedParserWorker: nonPageRequests.filter(
      (request) =>
        parserWorker(targetBySession.get(request.sessionId)) &&
        requestBelongsTo(request, blobWrapper),
    ).length,
    normalDocumentWorker: nonPageRequests.filter(
      (request) =>
        normalPhaseIds.has(targetBySession.get(request.sessionId)?.phase) &&
        requestBelongsTo(request, documentWorker),
    ).length,
    normalParserWorker: nonPageRequests.filter(
      (request) =>
        normalPhaseIds.has(targetBySession.get(request.sessionId)?.phase) &&
        parserWorker(targetBySession.get(request.sessionId)),
    ).length,
    total: nonPageRequests.length,
  };
  return {
    attachErrors: [...networkState.attachErrors],
    networkFixedPoints: [...networkState.networkFixedPoints],
    completedRequestCount: networkState.completedRequestCount,
    coverageTargets,
    externalRequests,
    failures,
    initialTargetBaseline: networkState.initialTargetBaseline,
    localRequestCount: networkState.requests.length - externalRequests.length,
    inflightRequestCount: networkState.inflightRequests.size,
    matrixCoverage,
    nonPageRequestCounts,
    nonPageRequests,
    referenceScheme,
    requests: [...networkState.requests],
    serviceWorkerBypassed: networkState.serviceWorkerBypassed === true,
    serviceWorkerBootstrapObservations: [
      ...networkState.serviceWorkerBootstrapObservations,
    ],
    sourceRequest: sourceRequest ?? null,
    sourceSha256: fixtureSha256,
    sourceStayedLocal: !sourceRequest && externalRequests.length === 0,
    targetBootstrapSettlements,
    targets,
  };
}

async function removeBrowserProfile(profileDirectory) {
  if (!profileDirectory) return true;
  await rm(profileDirectory, { force: true, recursive: true });
  try {
    await access(profileDirectory);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function closeOwnedBrowser(cdp, browser) {
  let cdpClosed = !cdp;
  if (cdp) {
    const closed = new Promise((resolve) => {
      cdp.webSocket.addEventListener("close", () => resolve(true), {
        once: true,
      });
    });
    cdp.close();
    cdpClosed = await Promise.race([
      closed,
      delay(500).then(() => cdp.webSocket.readyState === WebSocket.CLOSED),
    ]);
  }
  const process = browser
    ? await stopProcessGroup(browser.processGroupId, SHUTDOWN_TIMEOUT_MS)
    : { closed: true };
  await delay(50);
  const profileRemoved = await removeBrowserProfile(browser?.profileDirectory);
  return {
    cdpClosed,
    cdpPresent: Boolean(cdp),
    error: null,
    present: Boolean(browser),
    processClosed: process.closed,
    profileRemoved,
  };
}

async function closeOwnedServer(server) {
  const process = server
    ? await stopProcessGroup(server.processGroupId, SHUTDOWN_TIMEOUT_MS)
    : { closed: true };
  return {
    error: null,
    present: Boolean(server),
    processClosed: process.closed,
  };
}

function cleanupResult(result, kind) {
  if (result.status === "fulfilled") return result.value;
  const error = result.reason instanceof Error
    ? result.reason.stack ?? result.reason.message
    : String(result.reason);
  if (kind === "server") {
    return { error, present: true, processClosed: false };
  }
  return {
    cdpClosed: false,
    cdpPresent: true,
    error,
    present: true,
    processClosed: false,
    profileRemoved: false,
  };
}

function ensureCleanBoundSource(source) {
  if (source.preflightStatus.length) {
    throw new Error(
      "Issue #68 acceptance evidence requires a clean committed source tree.\n" +
      source.preflightStatus.join("\n"),
    );
  }
  source.postBuildCommit = gitOutput(["rev-parse", "HEAD"]);
  source.postBuildTree = gitOutput(["rev-parse", "HEAD^{tree}"]);
  source.postBuildStatus = gitStatus();
  if (
    source.postBuildStatus.length ||
    source.postBuildCommit !== source.commit ||
    source.postBuildTree !== source.tree
  ) {
    throw new Error(
      "The source commit/tree changed or became dirty while building Issue #68 evidence.",
    );
  }
}

function finalizeReferenceDiagnosticSource(source) {
  source.postCaptureCommit = gitOutput(["rev-parse", "HEAD"]);
  source.postCaptureTree = gitOutput(["rev-parse", "HEAD^{tree}"]);
  source.postCaptureStatus = gitStatus();
  if (!isExactReferenceDiagnosticSource(source)) {
    throw new Error(
      "The source commit/tree changed or became dirty during the reference diagnostic.",
    );
  }
}

async function runReferenceCaptureDiagnostic(options, source) {
  if (existsSync(options.outputDirectory)) {
    throw new Error(
      "Reference-capture diagnostic output must be a fresh absent directory.",
    );
  }
  await mkdir(options.outputDirectory, { recursive: true });
  const fixture = await fileArtifact(options.fixture);
  const progress = createReferenceCaptureDiagnosticProgress();
  let capture = null;
  let referenceBrowser = null;
  let referenceCdp = null;
  let referenceShutdown = null;
  let runnerFailure = null;
  try {
    await runBoundedDiagnosticOperation(async () => {
      referenceBrowser = await runReferenceCaptureDiagnosticStage(
        progress,
        "browser-launch",
        () => startBrowser(options.browser, true),
      );
      referenceCdp = await runReferenceCaptureDiagnosticStage(
        progress,
        "cdp-connect",
        () => CdpSession.connect(referenceBrowser.webSocketDebuggerUrl),
      );
      await runReferenceCaptureDiagnosticStage(
        progress,
        "configure",
        () => Promise.all([
          referenceCdp.send("Page.enable"),
          referenceCdp.send("Runtime.enable"),
          applyMatrixConfiguration(
            referenceCdp,
            PDF_SHARPNESS_MATRIX[0],
            true,
          ),
        ]),
      );
      const requestedUrl = new URL(pathToFileURL(options.fixture));
      requestedUrl.hash =
        `page=${REFERENCE_CAPTURE_DIAGNOSTIC_TARGET_PAGE}&zoom=page-width`;
      await runReferenceCaptureDiagnosticStage(
        progress,
        "navigate",
        () => referenceCdp.send("Page.navigate", { url: requestedUrl.href }),
      );
      await runReferenceCaptureDiagnosticStage(
        progress,
        "viewer-ready",
        () => waitForExpression(
          referenceCdp,
          `document.readyState === 'complete' &&
            (document.contentType === 'application/pdf' ||
              Boolean(document.querySelector('embed[type="application/pdf"]')) ||
              location.protocol === 'chrome-extension:')`,
          "desktop-dpr1-zoom100 reference-capture diagnostic",
          SCENARIO_TIMEOUT_MS,
        ),
      );
      const stable = await runReferenceCaptureDiagnosticStage(
        progress,
        "stable-candidates",
        () => captureStableReferenceDiagnosticCandidates(
          referenceCdp,
          options.outputDirectory,
        ),
      );
      capture = {
        ...stable,
        configurationId: PDF_SHARPNESS_MATRIX[0].id,
        referenceScheme: requestedUrl.protocol,
        targetPage: REFERENCE_CAPTURE_DIAGNOSTIC_TARGET_PAGE,
      };
      await runReferenceCaptureDiagnosticStage(
        progress,
        "source-finalize",
        () => finalizeReferenceDiagnosticSource(source),
      );
    }, {
      onTimeout() {
        referenceCdp?.close();
      },
      timeoutMs: REFERENCE_CAPTURE_DIAGNOSTIC_TIMEOUT_MS,
    });
  } catch (error) {
    runnerFailure = error;
    if (!source.postCaptureStatus) {
      try {
        finalizeReferenceDiagnosticSource(source);
      } catch {
        // The independently validated source summary stays fail-closed.
      }
    }
  } finally {
    const [cleanup] = await Promise.allSettled([
      closeOwnedBrowser(referenceCdp, referenceBrowser),
    ]);
    referenceShutdown = cleanupResult(cleanup, "browser");
  }
  const report = buildReferenceCaptureDiagnosticReport({
    capture,
    fixture,
    outputDirectory: options.outputDirectory,
    progress,
    runnerFailure,
    source,
    teardown: {
      errorCount: referenceShutdown?.error ? 1 : 0,
      reference: referenceShutdown,
    },
  });
  const diagnosticPath = path.join(
    options.outputDirectory,
    REFERENCE_CAPTURE_DIAGNOSTIC_REPORT,
  );
  await writeFile(diagnosticPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.failures.length) {
    throw new Error(
      `Issue #68 reference-capture diagnostic completed with a failed gate. Evidence: ${diagnosticPath}\n${report.failures.join("\n")}`,
    );
  }
  process.stdout.write(
    `Issue #68 reference-capture diagnostic completed: ${diagnosticPath}\n`,
  );
}

async function run(options) {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error(
      "Issue #68 evidence requires a graphical DISPLAY or WAYLAND_DISPLAY; headless mode is forbidden.",
    );
  }
  await Promise.all([access(options.browser), access(options.fixture)]);
  const source = await collectSourceEvidence();
  if (source.preflightStatus.length) {
    throw new Error(
      "Issue #68 acceptance evidence requires a clean committed source tree.\n" +
      source.preflightStatus.join("\n"),
    );
  }
  if (options.diagnoseReferenceCapture) {
    await runReferenceCaptureDiagnostic(options, source);
    return;
  }
  await buildProductionArtifact();
  ensureCleanBoundSource(source);
  await mkdir(options.outputDirectory, { recursive: true });

  const fixture = await fileArtifact(options.fixture);
  if (options.fixture !== path.resolve(DEFAULT_PDF_HIGHLIGHT_FIXTURE)) {
    fixture.path = "<local-user-selected-pdf>";
  }
  let server = null;
  let appBrowser = null;
  let appCdp = null;
  let referenceBrowser = null;
  let referenceCdp = null;
  let runnerFailure = null;
  let fallbackDiagnosticCapture = null;
  let fallbackDiagnosticNetwork = null;
  const fallbackDiagnosticProgress = options.diagnoseFallbackImport
    ? createFallbackImportDiagnosticProgress()
    : null;
  let fallbackDiagnosticSetup = options.diagnoseFallbackImport
    ? {
        completeEventCount: null,
        documentIdentityHash: null,
        fileSelected: false,
        library: null,
        librarySnapshotCompleted: false,
        navigationCompleted: false,
        networkFixedPointReached: false,
        pageEventCount: null,
        source: null,
        sourceSelectionCount: null,
      }
    : null;
  let appShutdown = null;
  let referenceShutdown = null;
  let serverShutdown = null;
  const evidence = {
    artifacts: {
      deploymentId: null,
      screenshots: [],
      sourceCommit: source.commit,
      sourceTree: source.tree,
    },
    bitmapBudget: probePdfBitmapBudget(),
    build: null,
    fixture,
    issue: 68,
    matrix: [],
    network: null,
    networkDiagnostics: [],
    schemaVersion: PDF_SHARPNESS_SCHEMA_VERSION,
    source,
    teardown: null,
  };
  const networkState = {
    attachErrors: [],
    attachPromises: [],
    byId: new Map(),
    completedRequestCount: 0,
    failures: [],
    inflightRequests: new Set(),
    fixedPointDiagnostics: [],
    initialTargetBaseline: null,
    networkFixedPoints: [],
    phase: "startup",
    pendingAttachPromises: new Set(),
    pendingAttachMetadata: new Map(),
    recentActivity: [],
    requests: [],
    responseFailures: [],
    serviceWorkerBypassed: false,
    serviceWorkerBootstrapObservations: [],
    targetBootstrapSettlements: [],
    targets: [],
  };

  try {
    server = await startProductionServer();
    evidence.build = {
      ...(await collectBuildBinding(server.appUrl, source)),
      fresh: true,
    };
    evidence.artifacts.deploymentId =
      evidence.build.localManifest.deploymentId;

    appBrowser = await startBrowser(options.browser, true);
    const collectAppEvidence = async () => {
      if (options.diagnoseFallbackImport) {
        appCdp = await runFallbackImportDiagnosticStage(
          fallbackDiagnosticProgress,
          "connect",
          () => CdpSession.connect(appBrowser.webSocketDebuggerUrl),
        );
        networkState.initialTargetBaseline =
          await runFallbackImportDiagnosticStage(
            fallbackDiagnosticProgress,
            "baseline",
            async () => {
              const { targetInfos } = await appCdp.send(
                "Target.getTargets",
                {
                  filter: [
                    { type: "page" },
                    { type: "worker" },
                    { type: "shared_worker" },
                    { type: "service_worker" },
                  ],
                },
              );
              return validateCdpInitialTargetBaseline(targetInfos);
            },
          );
        await runFallbackImportDiagnosticStage(
          fallbackDiagnosticProgress,
          "configure",
          () => configureAppSession(appCdp, networkState),
        );
      } else {
        appCdp = await CdpSession.connect(appBrowser.webSocketDebuggerUrl);
        const { targetInfos: initialTargetInfos } = await appCdp.send(
          "Target.getTargets",
          {
            filter: [
              { type: "page" },
              { type: "worker" },
              { type: "shared_worker" },
              { type: "service_worker" },
            ],
          },
        );
        networkState.initialTargetBaseline =
          validateCdpInitialTargetBaseline(initialTargetInfos);
        await configureAppSession(appCdp, networkState);
      }
      const targetPages = new Map();
      if (options.diagnoseFallbackImport) {
        networkState.phase = "fallback-diagnostic-setup";
        await collectPersistedFallbackDiagnosticSetup(
          appCdp,
          server.appUrl,
          options.fixture,
          fallbackDiagnosticProgress,
          fallbackDiagnosticSetup,
        );
        await runFallbackImportDiagnosticStage(
          fallbackDiagnosticProgress,
          "setup-fixed-point",
          () => waitForCdpNetworkFixedPoint(
            networkState,
            server.appUrl,
            "fallback-diagnostic-setup",
          ),
        );
        fallbackDiagnosticSetup.networkFixedPointReached = true;
        networkState.phase = FALLBACK_IMPORT_DIAGNOSTIC_LABEL;
        fallbackDiagnosticCapture = await collectFallbackImportDiagnostic(
          appCdp,
          server.appUrl,
          options.fixture,
          fixture,
          networkState,
          fallbackDiagnosticProgress,
        );
        fallbackDiagnosticNetwork = await runFallbackImportDiagnosticStage(
          fallbackDiagnosticProgress,
          "fallback-network",
          async () => {
            try {
              const fixedPoint = await waitForCdpNetworkFixedPoint(
                networkState,
                server.appUrl,
                FALLBACK_IMPORT_DIAGNOSTIC_LABEL,
              );
              return fixedPoint.diagnostic;
            } catch {
              return networkState.fixedPointDiagnostics.at(-1) ?? null;
            }
          },
        );
        fallbackDiagnosticCapture.screenshot =
          await runFallbackImportDiagnosticStage(
            fallbackDiagnosticProgress,
            "fallback-screenshot",
            () => writeScreenshot(
              appCdp,
              options.outputDirectory,
              FALLBACK_IMPORT_DIAGNOSTIC_SCREENSHOT,
            ),
          );
      } else {
        for (const configuration of PDF_SHARPNESS_MATRIX) {
          networkState.phase = configuration.id;
          const matrixRun = await collectMatrixRun(
            appCdp,
            server.appUrl,
            options.fixture,
            options.outputDirectory,
            configuration,
          );
          matrixRun.comparison.sourceSha256 = fixture.sha256;
          if (options.diagnoseFirstNetworkFixedPoint) {
            evidence.matrix.push(matrixRun);
          }
          const networkFixedPoint = await waitForCdpNetworkFixedPoint(
            networkState,
            server.appUrl,
            configuration.id,
          );
          if (options.diagnoseFirstNetworkFixedPoint) {
            networkState.fixedPointDiagnostics.push(
              networkFixedPoint.diagnostic,
            );
            break;
          }
          targetPages.set(configuration.id, matrixRun.comparison.targetPage);
          evidence.matrix.push(matrixRun);
        }
      }
      if (
        !options.diagnoseFallbackImport &&
        !options.diagnoseFirstNetworkFixedPoint
      ) {
        networkState.phase = "forced-main-fallback";
        evidence.fallback = await collectFallbackEvidence(
          appCdp,
          server.appUrl,
          options.fixture,
          options.outputDirectory,
        );
        await waitForCdpNetworkFixedPoint(
          networkState,
          server.appUrl,
          "forced-main-fallback",
        );

        referenceBrowser = await startBrowser(options.browser, true);
        referenceCdp = await CdpSession.connect(
          referenceBrowser.webSocketDebuggerUrl,
        );
        await Promise.all([
          referenceCdp.send("Page.enable"),
          referenceCdp.send("Runtime.enable"),
        ]);
        const reference = await captureReferenceScreenshots(
          referenceCdp,
          options.fixture,
          options.outputDirectory,
          targetPages,
        );
        for (const matrixRun of evidence.matrix) {
          const referenceCapture = reference.screenshots.get(matrixRun.id);
          matrixRun.comparison.referenceScreenshot =
            referenceCapture?.artifact ?? null;
          matrixRun.comparison.referenceReadiness =
            referenceCapture?.readiness ?? null;
          matrixRun.comparison.paired = true;
        }
        await waitForCdpNetworkFixedPoint(
          networkState,
          server.appUrl,
          "final-network-privacy",
        );
        evidence.network = summarizeNetwork(
          networkState,
          server.appUrl,
          options.fixture,
          fixture.sha256,
          reference.scheme,
        );
        evidence.artifacts.screenshots = [
          ...evidence.matrix.flatMap((matrixRun) => [
            matrixRun.comparison.referenceScreenshot,
            matrixRun.comparison.lineLightScreenshot,
          ]),
          evidence.fallback.artifact,
        ];
      }
    };
    if (options.diagnoseFallbackImport) {
      await runBoundedDiagnosticOperation(collectAppEvidence, {
        onTimeout() {
          appCdp?.close();
        },
        timeoutMs: FALLBACK_IMPORT_DIAGNOSTIC_RUN_TIMEOUT_MS,
      });
    } else {
      await collectAppEvidence();
    }
  } catch (error) {
    runnerFailure = error;
  } finally {
    networkState.phase = "teardown";
    const cleanup = await Promise.allSettled([
      closeOwnedBrowser(referenceCdp, referenceBrowser),
      closeOwnedBrowser(appCdp, appBrowser),
      closeOwnedServer(server),
    ]);
    referenceShutdown = cleanupResult(cleanup[0], "browser");
    appShutdown = cleanupResult(cleanup[1], "browser");
    serverShutdown = cleanupResult(cleanup[2], "server");
    const teardownErrors = [
      referenceShutdown.error,
      appShutdown.error,
      serverShutdown.error,
    ].filter(Boolean);
    evidence.teardown = {
      app: appShutdown,
      browserClosed: appShutdown.processClosed,
      cdpClosed: appShutdown.cdpClosed && referenceShutdown.cdpClosed,
      errors: teardownErrors,
      profilesRemoved:
        appShutdown.profileRemoved && referenceShutdown.profileRemoved,
      reference: referenceShutdown,
      referenceBrowserClosed: referenceShutdown.processClosed,
      server: serverShutdown,
      serverClosed: serverShutdown.processClosed,
    };
    evidence.networkDiagnostics = [
      ...networkState.fixedPointDiagnostics,
    ];
  }

  if (options.diagnoseFallbackImport) {
    const report = buildFallbackImportDiagnosticReport({
      build: evidence.build,
      capture: fallbackDiagnosticCapture,
      diagnosticProgress: fallbackDiagnosticProgress,
      fixture,
      networkDiagnostic: fallbackDiagnosticNetwork,
      outputDirectory: options.outputDirectory,
      runnerFailure,
      setup: fallbackDiagnosticSetup,
      source,
      teardown: evidence.teardown,
    });
    const diagnosticPath = path.join(
      options.outputDirectory,
      "pdf-sharpness-fallback-import-diagnostic.json",
    );
    await writeFile(diagnosticPath, `${JSON.stringify(report, null, 2)}\n`);
    if (report.failures.length) {
      throw new Error(
        `Issue #68 fallback-import diagnostic completed with a failed gate. Evidence: ${diagnosticPath}\n${report.failures.join("\n")}`,
      );
    }
    process.stdout.write(
      `Issue #68 fallback-import diagnostic completed: ${diagnosticPath}\n`,
    );
    return;
  }

  if (options.diagnoseFirstNetworkFixedPoint) {
    const report = buildFirstNetworkDiagnosticReport({
      build: evidence.build,
      fixture,
      networkDiagnostic: evidence.networkDiagnostics.at(-1) ?? null,
      outputDirectory: options.outputDirectory,
      runnerFailure,
      scenario: evidence.matrix[0] ?? null,
      source,
      teardown: evidence.teardown,
    });
    const diagnosticPath = path.join(
      options.outputDirectory,
      "pdf-sharpness-network-diagnostic.json",
    );
    await writeFile(diagnosticPath, `${JSON.stringify(report, null, 2)}\n`);
    if (report.failures.length) {
      throw new Error(
        `Issue #68 network diagnostic completed with a failed fixed-point gate. Evidence: ${diagnosticPath}\n${report.failures.join("\n")}`,
      );
    }
    process.stdout.write(
      `Issue #68 network diagnostic completed: ${diagnosticPath}\n`,
    );
    return;
  }

  const failures = [
    ...(runnerFailure
      ? [runnerFailure instanceof Error
          ? runnerFailure.stack
          : String(runnerFailure)]
      : []),
    ...validatePdfSharpnessEvidence(evidence),
  ];
  evidence.failures = failures;
  evidence.passed = failures.length === 0;
  evidence.recordedAt = new Date().toISOString();
  const evidencePath = path.join(
    options.outputDirectory,
    "pdf-sharpness-browser.json",
  );
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  if (failures.length) {
    throw new Error(
      `Issue #68 browser regression failed. Evidence: ${evidencePath}\n${failures.join("\n")}`,
    );
  }
  process.stdout.write(`Issue #68 browser evidence passed: ${evidencePath}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options) {
    run(options).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
      process.exitCode = 1;
    });
  }
}
