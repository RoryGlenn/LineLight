#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_PDF_HIGHLIGHT_FIXTURE } from "./generate-pdf-highlight-fixture.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_OUTPUT_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "outputs/offline-natural-timing",
);
const RECORDED_EVIDENCE_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "docs/evidence/issue-60",
);
const EVIDENCE_FILENAME = "offline-natural-timing.json";
const TEST_RATES = Object.freeze([0.75, 1, 1.25]);
const REQUIRED_TRANSITIONS = 12;
const MAX_LOGICAL_INDEX_DELTA = 1;
const MAX_ACTIVATIONS_PER_FRAME = 1;
const MAX_LONG_TASK_MS = 50;

function parseArguments(argv) {
  const options = {
    appUrl: "http://127.0.0.1:5189/",
    cdpUrl: process.env.LINELIGHT_CDP_URL ?? null,
    fixture: DEFAULT_PDF_HIGHLIGHT_FIXTURE,
    outputDirectory: DEFAULT_OUTPUT_DIRECTORY,
    record: false,
    timeoutMs: 180_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cdp") options.cdpUrl = argv[++index];
    else if (argument === "--url") options.appUrl = argv[++index];
    else if (argument === "--fixture") options.fixture = argv[++index];
    else if (argument === "--output") options.outputDirectory = argv[++index];
    else if (argument === "--record") options.record = true;
    else if (argument === "--timeout") {
      options.timeoutMs = Number(argv[++index]);
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        [
          "Usage: node scripts/run-offline-natural-timing-regression.mjs --cdp URL [options]",
          "",
          "The CDP browser profile must already contain LineLight's offline voice pack.",
          "Run this against a headed Brave instance and the matching local app origin.",
          "",
          "Options:",
          "  --cdp URL      Brave remote-debugging endpoint (or LINELIGHT_CDP_URL).",
          "  --url URL      Running LineLight app (default: http://127.0.0.1:5189/).",
          "  --fixture PATH Deterministic PDF timing fixture.",
          "  --output DIR   Write transient evidence here.",
          "  --record       Write docs/evidence/issue-60/offline-natural-timing.json.",
          "  --timeout MS   Per-rate transition timeout (default: 180000).",
          "",
        ].join("\n"),
      );
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.cdpUrl) {
    throw new Error(
      "--cdp is required so the run can use a browser profile with the stored offline voice pack.",
    );
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout must be a positive number of milliseconds.");
  }
  if (options.record) options.outputDirectory = RECORDED_EVIDENCE_DIRECTORY;
  options.cdpUrl = options.cdpUrl.replace(/\/$/u, "");
  options.fixture = path.resolve(options.fixture);
  options.outputDirectory = path.resolve(options.outputDirectory);
  return options;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CdpSession {
  constructor(webSocket) {
    this.webSocket = webSocket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    webSocket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {});
      }
    });
    webSocket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("The browser debugging connection closed."));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const webSocket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      webSocket.addEventListener("open", resolve, { once: true });
      webSocket.addEventListener("error", reject, { once: true });
    });
    return new CdpSession(webSocket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.webSocket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    this.webSocket.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      "Browser evaluation failed.";
    throw new Error(description);
  }
  return result.result?.value;
}

async function waitForExpression(
  cdp,
  expression,
  description,
  timeoutMs = 60_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await evaluate(cdp, expression);
      if (value) return value;
    } catch {
      // React may replace the queried subtree while it settles.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function createTarget(cdpUrl) {
  const response = await fetch(
    `${cdpUrl}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  if (!response.ok) {
    throw new Error(`Brave could not create a timing target (${response.status}).`);
  }
  const target = await response.json();
  if (!target.id || !target.webSocketDebuggerUrl) {
    throw new Error("Brave did not expose a debuggable page target.");
  }
  return target;
}

async function closeTarget(cdpUrl, targetId) {
  try {
    await fetch(`${cdpUrl}/json/close/${targetId}`);
  } catch {
    // Closing the dedicated evidence tab is best-effort cleanup.
  }
}

const INSTRUMENTATION_SOURCE = `
(() => {
  try {
    localStorage.setItem("guided-reader-settings", JSON.stringify({
      narrationEngine: "offline",
      narrationPreferenceVersion: 1,
      highlightScope: "sentence",
      follow: false,
      rate: 1,
      offlineVoice: "af_heart"
    }));
  } catch {}

  const state = globalThis.__lineLightOfflineTiming = {
    errors: [],
    longTasks: [],
    plays: [],
    currentRound: null,
    frame: 0
  };
  const nextFrame = () => {
    state.frame += 1;
    requestAnimationFrame(nextFrame);
  };
  requestAnimationFrame(nextFrame);

  addEventListener("error", (event) => {
    state.errors.push(event.error?.stack || event.message || "window error");
  });
  addEventListener("unhandledrejection", (event) => {
    state.errors.push(event.reason?.stack || String(event.reason));
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name
        });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch (error) {
    state.errors.push("Long Task observer unavailable: " + error.message);
  }

  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...arguments_) {
    const record = {
      roundId: state.currentRound?.id ?? null,
      calledAt: performance.now(),
      sourceKind: this.src.startsWith("blob:") ? "blob" : "other",
      loop: this.loop,
      muted: this.muted,
      volume: this.volume,
      events: []
    };
    state.plays.push(record);
    for (const name of ["play", "playing", "waiting", "stalled", "pause", "ended"]) {
      this.addEventListener(name, () => {
        record.events.push({
          name,
          time: performance.now(),
          currentTime: this.currentTime,
          duration: Number.isFinite(this.duration) ? this.duration : null
        });
      });
    }
    const result = nativePlay.apply(this, arguments_);
    Promise.resolve(result).then(
      () => { record.resolvedAt = performance.now(); },
      (error) => { record.rejected = String(error); }
    );
    return result;
  };
})();
`;

async function configurePage(cdp, appUrl) {
  const consoleEntries = [];
  cdp.on("Runtime.consoleAPICalled", (event) => {
    consoleEntries.push({
      type: event.type,
      values: event.args.map((argument) => argument.value ?? argument.description),
    });
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    consoleEntries.push({ type: entry.level, values: [entry.text] });
  });
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("DOM.enable"),
    cdp.send("Log.enable"),
    cdp.send("Performance.enable"),
  ]);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: INSTRUMENTATION_SOURCE,
  });
  await cdp.send("Page.navigate", { url: appUrl });
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector(".import-button")) &&
      Boolean(document.querySelector(".speed-control select"))`,
    "the LineLight reader shell",
  );
  return consoleEntries;
}

async function verifyOfflinePack(cdp) {
  const state = await waitForExpression(
    cdp,
    `(() => {
      if (!document.querySelector(".settings-layer")) {
        document.querySelector(".sidebar-settings")?.click();
        return "";
      }
      if (document.querySelector(".offline-pack-ready")) return "ready";
      const status = document.querySelector(".offline-pack-status")?.textContent ?? "";
      if (/Preparing automatically while connected/iu.test(status)) return "missing";
      if (/could not|failed|error/iu.test(status)) return "error";
      return "";
    })()`,
    "the offline voice pack state",
    60_000,
  );
  if (state !== "ready") {
    throw new Error(
      "The attached Brave profile does not contain the ready offline voice pack.",
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

async function importFixture(cdp, fixture) {
  await waitForExpression(
    cdp,
    `(() => {
      const input = document.querySelector('input[type="file"]');
      if (input) return true;
      document.querySelector(".import-button")?.click();
      return false;
    })()`,
    "the import file input",
  );
  const documentNode = await cdp.send("DOM.getDocument", { depth: -1 });
  const fileInput = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: 'input[type="file"]',
  });
  if (!fileInput.nodeId) throw new Error("The import file input was not found.");
  await cdp.send("DOM.setFileInputFiles", {
    files: [fixture],
    nodeId: fileInput.nodeId,
  });
  await waitForExpression(
    cdp,
    `document.querySelectorAll("#pdf-page-1 .pdf-word-overlay").length >= 20`,
    "the measured timing fixture",
    60_000,
  );
  await evaluate(
    cdp,
    `document.querySelector('.notice button[aria-label="Dismiss message"]')?.click(); true`,
  );
  await delay(300);
}

function uniqueTransitions(transitions) {
  const unique = [];
  for (const transition of transitions) {
    if (unique.at(-1)?.index !== transition.index) unique.push(transition);
  }
  return unique;
}

function roundMetrics(round, browserState) {
  const transitions = uniqueTransitions(round.transitions);
  const logicalIndexDeltas = transitions.map((transition, index) =>
    transition.index -
    (index === 0 ? round.startIndex : transitions[index - 1].index),
  );
  const frameActivations = new Map();
  for (const transition of transitions) {
    frameActivations.set(
      transition.frame,
      (frameActivations.get(transition.frame) ?? 0) + 1,
    );
  }
  const plays = browserState.plays.filter((play) => play.roundId === round.id);
  const narrationPlays = plays.filter((play) => !play.loop);
  const playingEvents = narrationPlays
    .flatMap((play) => play.events.filter((event) => event.name === "playing"))
    .sort((left, right) => left.time - right.time);
  const audibleStartedAt = playingEvents[0]?.time ?? null;
  const longTasks = browserState.longTasks.filter(
    (entry) =>
      audibleStartedAt !== null &&
      entry.startTime + entry.duration >= audibleStartedAt &&
      entry.startTime <= round.finishedAt,
  );
  const intervals = transitions
    .slice(1)
    .map((transition, index) => transition.at - transitions[index].at);
  const audioChunks = narrationPlays
    .filter((play) => play.events.some((event) => event.name === "playing"))
    .map((play) => ({
      calledAtMs: play.calledAt - round.startedAt,
      resolvedAtMs:
        typeof play.resolvedAt === "number"
          ? play.resolvedAt - round.startedAt
          : null,
      sourceKind: play.sourceKind,
      rejected: play.rejected ?? null,
      events: play.events.map((event) => ({
        ...event,
        timeMs: event.time - round.startedAt,
      })),
    }));
  const primePlay = plays.find((play) => play.loop);
  const audioPrime = primePlay
    ? {
        sourceKind: primePlay.sourceKind,
        loop: true,
        muted: primePlay.muted,
        volume: primePlay.volume,
      }
    : null;
  const maximumLogicalIndexDelta = logicalIndexDeltas.length
    ? Math.max(...logicalIndexDeltas)
    : null;
  const maximumActivationsPerFrame = frameActivations.size
    ? Math.max(...frameActivations.values())
    : null;
  const maximumLongTaskMs = longTasks.length
    ? Math.max(...longTasks.map((entry) => entry.duration))
    : 0;
  const failures = [];
  if (transitions.length < REQUIRED_TRANSITIONS) {
    failures.push(
      `observed ${transitions.length} transitions; ${REQUIRED_TRANSITIONS} required`,
    );
  }
  if (logicalIndexDeltas.some((delta) => delta !== 1)) {
    failures.push(`logical index deltas were ${logicalIndexDeltas.join(", ")}`);
  }
  if (maximumActivationsPerFrame > MAX_ACTIVATIONS_PER_FRAME) {
    failures.push(
      `${maximumActivationsPerFrame} logical words activated in one animation frame`,
    );
  }
  if (maximumLongTaskMs > MAX_LONG_TASK_MS) {
    failures.push(`playback Long Task reached ${maximumLongTaskMs}ms`);
  }
  if (!audioChunks.length) failures.push("no Offline-natural audio reached playing");
  if (audioChunks.some((chunk) => chunk.rejected)) {
    failures.push("an Offline-natural audio.play() promise rejected");
  }

  return {
    rate: round.rate,
    selectedRate: round.selectedRate,
    startWordIndex: round.startIndex,
    observedTransitions: transitions.length,
    transitions,
    logicalIndexDeltas,
    skippedLogicalWords: logicalIndexDeltas.reduce(
      (total, delta) => total + Math.max(0, delta - 1),
      0,
    ),
    maximumLogicalIndexDelta,
    maximumActivationsPerFrame,
    transitionIntervalsMs: {
      minimum: intervals.length ? Math.min(...intervals) : null,
      mean: intervals.length
        ? intervals.reduce((total, interval) => total + interval, 0) /
          intervals.length
        : null,
      maximum: intervals.length ? Math.max(...intervals) : null,
    },
    synthesisAndDecodeWaitMs:
      audibleStartedAt === null ? null : audibleStartedAt - round.startedAt,
    firstHighlightAfterAudioMs:
      audibleStartedAt === null || !transitions.length
        ? null
        : transitions[0].at - audibleStartedAt,
    observedPlaybackMs:
      audibleStartedAt === null ? null : round.finishedAt - audibleStartedAt,
    silentAudioPrime: audioPrime,
    audioChunks,
    playbackLongTasks: longTasks,
    maximumLongTaskMs,
    failures,
    passed: failures.length === 0,
  };
}

async function runRate(cdp, rate, timeoutMs) {
  await evaluate(
    cdp,
    `(() => {
      const button = document.querySelector(".play-button");
      if (button?.getAttribute("aria-label") !== "Play narration") button?.click();
      return true;
    })()`,
  );
  await waitForExpression(
    cdp,
    `document.querySelector(".play-button")?.getAttribute("aria-label") === "Play narration"`,
    "narration to stop before a rate run",
  );
  await evaluate(
    cdp,
    `(() => {
      const select = document.querySelector(".speed-control select");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value"
      ).set;
      setter.call(select, ${JSON.stringify(String(rate))});
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
  );
  await waitForExpression(
    cdp,
    `document.querySelector(".speed-control select")?.value === ${JSON.stringify(String(rate))}`,
    `the ${rate}x speed setting`,
  );
  const startIndex = await evaluate(
    cdp,
    `(async () => {
      const page = document.querySelector("#pdf-page-1");
      page.scrollIntoView({ block: "center", behavior: "auto" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const word = Array.from(page.querySelectorAll(".pdf-word-overlay"))
        .find((element) => element.getAttribute("aria-label") === "like");
      if (!word) throw new Error("The timing fixture word 'like' was not rendered.");
      word.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return Number(word.dataset.pdfWord);
    })()`,
  );
  const roundId = `rate-${rate}-${Date.now()}`;
  await evaluate(
    cdp,
    `(() => {
      const state = globalThis.__lineLightOfflineTiming;
      state.currentRound?.observer?.disconnect();
      const round = {
        id: ${JSON.stringify(roundId)},
        rate: ${rate},
        selectedRate: Number(document.querySelector(".speed-control select")?.value),
        startIndex: ${startIndex},
        startedAt: performance.now(),
        transitions: []
      };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const element = record.target;
          const wasActive = record.oldValue === "true";
          if (!wasActive && element.dataset.activeToken === "true") {
            round.transitions.push({
              at: performance.now(),
              frame: state.frame,
              index: Number(element.dataset.pdfWord),
              label: element.getAttribute("aria-label")
            });
          }
        }
      });
      observer.observe(document.querySelector(".pdf-pages"), {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-active-token"],
        attributeOldValue: true
      });
      round.observer = observer;
      state.currentRound = round;
      document.querySelector(".play-button").click();
      return true;
    })()`,
  );

  const startedAt = Date.now();
  let observed = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const state = await evaluate(
      cdp,
      `(() => {
        const timing = globalThis.__lineLightOfflineTiming;
        const round = timing.currentRound;
        const unique = new Set(round.transitions.map((entry) => entry.index));
        return {
          transitions: unique.size,
          button: document.querySelector(".play-button")?.getAttribute("aria-label"),
          notice: document.querySelector(".notice")?.innerText ?? "",
          errors: timing.errors
        };
      })()`,
    );
    observed = state.transitions;
    if (observed >= REQUIRED_TRANSITIONS) break;
    if (
      state.button === "Play narration" &&
      /could not|stopped unexpectedly|failed|error/iu.test(state.notice)
    ) {
      throw new Error(`Offline natural failed at ${rate}x: ${state.notice}`);
    }
    if (state.errors.length) {
      throw new Error(`Browser error at ${rate}x: ${state.errors.join("\n")}`);
    }
    await delay(100);
  }
  if (observed < REQUIRED_TRANSITIONS) {
    throw new Error(
      `Timed out at ${rate}x after ${observed}/${REQUIRED_TRANSITIONS} highlight transitions.`,
    );
  }

  await evaluate(
    cdp,
    `(() => {
      const button = document.querySelector(".play-button");
      if (button?.getAttribute("aria-label") !== "Play narration") button?.click();
      const round = globalThis.__lineLightOfflineTiming.currentRound;
      round.observer.disconnect();
      round.finishedAt = performance.now();
      delete round.observer;
      return true;
    })()`,
  );
  await waitForExpression(
    cdp,
    `document.querySelector(".play-button")?.getAttribute("aria-label") === "Play narration"`,
    `the ${rate}x run to pause`,
  );
  await delay(150);
  const state = await evaluate(
    cdp,
    `(() => {
      const timing = globalThis.__lineLightOfflineTiming;
      return {
        round: timing.currentRound,
        plays: timing.plays,
        longTasks: timing.longTasks,
        errors: timing.errors
      };
    })()`,
  );
  return roundMetrics(state.round, state);
}

async function sha256File(file) {
  const contents = await readFile(file);
  return createHash("sha256").update(contents).digest("hex");
}

async function sourceEvidence(fixture) {
  const files = [
    "app/page.tsx",
    "app/offline-speech.ts",
    "app/offline-speech.worker.ts",
    "app/offline-speech-utils.mjs",
    "app/pdf-page-view.tsx",
    "scripts/generate-pdf-highlight-fixture.mjs",
    "scripts/run-offline-natural-timing-regression.mjs",
    "tests/offline-natural-timing-harness.test.mjs",
    path.relative(REPOSITORY_ROOT, fixture),
  ];
  const hashes = {};
  for (const relativeFile of files) {
    hashes[relativeFile] = await sha256File(
      path.join(REPOSITORY_ROOT, relativeFile),
    );
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  ).trim();
  return { commit, dirty: Boolean(status), files: hashes };
}

export function validateOfflineNaturalTimingEvidence(evidence) {
  const failures = [];
  if (evidence?.schemaVersion !== 1) failures.push("schemaVersion must be 1");
  if (evidence?.issue !== 60) failures.push("issue must be 60");
  if (!evidence?.source?.commit) failures.push("source.commit is required");
  if (!evidence?.fixture?.sha256) failures.push("fixture.sha256 is required");
  if (evidence?.rates?.length !== TEST_RATES.length) {
    failures.push(`rates must contain ${TEST_RATES.length} runs`);
  }
  for (const expectedRate of TEST_RATES) {
    const run = evidence?.rates?.find((candidate) => candidate.rate === expectedRate);
    if (!run) {
      failures.push(`missing ${expectedRate}x run`);
      continue;
    }
    if (run.selectedRate !== expectedRate) {
      failures.push(`${expectedRate}x was not selected in the reader`);
    }
    if (run.observedTransitions < REQUIRED_TRANSITIONS) {
      failures.push(`${expectedRate}x did not observe enough transitions`);
    }
    if (run.logicalIndexDeltas?.some((delta) => delta !== 1)) {
      failures.push(`${expectedRate}x skipped or reversed a logical word`);
    }
    if (run.maximumLogicalIndexDelta > MAX_LOGICAL_INDEX_DELTA) {
      failures.push(`${expectedRate}x advanced across multiple logical words`);
    }
    if (run.maximumActivationsPerFrame > MAX_ACTIVATIONS_PER_FRAME) {
      failures.push(`${expectedRate}x activated multiple words in one frame`);
    }
    if (run.maximumLongTaskMs > MAX_LONG_TASK_MS) {
      failures.push(`${expectedRate}x had a playback Long Task over 50ms`);
    }
    if (!run.audioChunks?.length) {
      failures.push(`${expectedRate}x did not play Offline-natural audio`);
    }
    if (run.failures?.length) failures.push(`${expectedRate}x has run failures`);
  }
  if (evidence?.browserDiagnostics?.errors?.length) {
    failures.push("browser diagnostics contain runtime errors");
  }
  return failures;
}

async function run(options) {
  await mkdir(options.outputDirectory, { recursive: true });
  const target = await createTarget(options.cdpUrl);
  let cdp;
  try {
    cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
    const consoleEntries = await configurePage(cdp, options.appUrl);
    const packLabel = await verifyOfflinePack(cdp);
    await importFixture(cdp, options.fixture);

    const browserVersion = await fetch(`${options.cdpUrl}/json/version`).then(
      (response) => response.json(),
    );
    const environment = await evaluate(
      cdp,
      `({
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        devicePixelRatio,
        visualViewportScale: visualViewport?.scale ?? 1,
        crossOriginIsolated,
        workerResources: performance.getEntriesByType("resource")
          .filter((entry) => /offline-speech\\.worker|kokoro-js|onnxruntime/iu.test(entry.name))
          .map((entry) => ({
            name: entry.name,
            initiatorType: entry.initiatorType,
            durationMs: entry.duration,
            transferSize: entry.transferSize
          }))
      })`,
    );
    const rates = [];
    for (const rate of TEST_RATES) {
      rates.push(await runRate(cdp, rate, options.timeoutMs));
    }
    const browserState = await evaluate(
      cdp,
      `({
        errors: globalThis.__lineLightOfflineTiming.errors,
        allLongTasks: globalThis.__lineLightOfflineTiming.longTasks
      })`,
    );
    const evidence = {
      schemaVersion: 1,
      issue: 60,
      generatedAt: new Date().toISOString(),
      source: await sourceEvidence(options.fixture),
      fixture: {
        path: path.relative(REPOSITORY_ROOT, options.fixture),
        sha256: await sha256File(options.fixture),
        passage: "deterministic synthetic Issue 60 fixture; no imported private text is recorded",
      },
      precondition: {
        profile: "disposable copy of a local Brave profile",
        offlinePack: packLabel,
      },
      environment: {
        appUrl: options.appUrl,
        browserProduct: browserVersion.Browser,
        browserRevision: browserVersion["WebKit-Version"],
        ...environment,
      },
      thresholds: {
        requiredLogicalTransitions: REQUIRED_TRANSITIONS,
        maximumLogicalIndexDelta: MAX_LOGICAL_INDEX_DELTA,
        maximumLogicalActivationsPerAnimationFrame:
          MAX_ACTIVATIONS_PER_FRAME,
        maximumPlaybackLongTaskMs: MAX_LONG_TASK_MS,
      },
      rates,
      browserDiagnostics: {
        errors: browserState.errors,
        consoleEntries: consoleEntries.filter((entry) =>
          ["error", "warning", "assert"].includes(entry.type),
        ),
        allLongTasks: browserState.allLongTasks,
      },
    };
    evidence.failures = validateOfflineNaturalTimingEvidence(evidence);
    evidence.passed = evidence.failures.length === 0;
    const evidencePath = path.join(options.outputDirectory, EVIDENCE_FILENAME);
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({
        evidence: evidencePath,
        passed: evidence.passed,
        failures: evidence.failures,
        rates: evidence.rates.map((rate) => ({
          rate: rate.rate,
          transitions: rate.observedTransitions,
          maximumLogicalIndexDelta: rate.maximumLogicalIndexDelta,
          maximumActivationsPerFrame: rate.maximumActivationsPerFrame,
          maximumLongTaskMs: rate.maximumLongTaskMs,
        })),
      })}\n`,
    );
    if (!evidence.passed) process.exitCode = 1;
  } finally {
    cdp?.close();
    await closeTarget(options.cdpUrl, target.id);
  }
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
