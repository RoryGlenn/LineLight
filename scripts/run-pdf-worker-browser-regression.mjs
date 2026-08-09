#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { fileURLToPath } from "node:url";

import { DEFAULT_PDF_HIGHLIGHT_FIXTURE } from "./generate-pdf-highlight-fixture.mjs";
import {
  delay,
  startBrowser,
  terminateProcessGroup,
} from "./run-pdf-highlight-browser-regression.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_REFERENCE_PDF =
  process.env.LINELIGHT_PDF_WORKER_REFERENCE ??
  "/home/ubuntu/Downloads/The Staff Engineer’s Path -- Tanya Reilly.pdf";
const DEFAULT_OUTPUT_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "outputs/issue-56-pdf-worker",
);
const MAX_WINDOW_TASK_MS = 50;
const MAX_CONTROL_LATENCY_MS = 100;
const DEFAULT_TIMEOUT_MS = 180_000;

function parseArguments(argv) {
  const options = {
    appUrl: null,
    browser: process.env.LINELIGHT_BROWSER ?? "/usr/bin/brave-browser",
    expectedPages: 359,
    outputDirectory:
      process.env.LINELIGHT_PDF_WORKER_EVIDENCE ?? DEFAULT_OUTPUT_DIRECTORY,
    reference: DEFAULT_REFERENCE_PDF,
    replacement: DEFAULT_PDF_HIGHLIGHT_FIXTURE,
    skipBuild: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--url") options.appUrl = argv[++index];
    else if (argument === "--browser") options.browser = argv[++index];
    else if (argument === "--reference") options.reference = argv[++index];
    else if (argument === "--replacement") options.replacement = argv[++index];
    else if (argument === "--output") options.outputDirectory = argv[++index];
    else if (argument === "--expected-pages") {
      options.expectedPages = Number(argv[++index]);
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index]);
    } else if (argument === "--skip-build") options.skipBuild = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        [
          "Usage: node scripts/run-pdf-worker-browser-regression.mjs [options]",
          "",
          "Runs LineLight's production build in a visible Brave window and records",
          "Issue #56 PDF-worker responsiveness, ordering, privacy, and cancellation evidence.",
          "",
          "Options:",
          "  --reference PATH       Large reference PDF (defaults to the supplied 359-page book).",
          "  --replacement PATH     Small PDF used to replace/cancel the large import.",
          "  --expected-pages N     Expected reference page count (default: 359).",
          "  --output DIR           JSON, trace, and screenshot directory.",
          "  --browser PATH         Brave/Chromium executable.",
          "  --timeout-ms N         Per-import timeout (default: 180000).",
          "  --skip-build           Reuse the current production build.",
          "  --url URL              Use an externally started production app.",
          "",
          "A graphical DISPLAY or WAYLAND_DISPLAY is required; this harness never uses headless mode.",
          "",
        ].join("\n"),
      );
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isInteger(options.expectedPages) || options.expectedPages < 2) {
    throw new Error("--expected-pages must be an integer greater than one.");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10_000) {
    throw new Error("--timeout-ms must be at least 10000.");
  }
  options.reference = path.resolve(options.reference);
  options.replacement = path.resolve(options.replacement);
  options.outputDirectory = path.resolve(options.outputDirectory);
  return options;
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

function collectProcessOutput(child, maximumChunks = 160) {
  const output = [];
  const collect = (chunk) => {
    output.push(chunk.toString());
    if (output.length > maximumChunks) output.shift();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return () => output.join("");
}

async function waitForProcess(child, label, log) {
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${label} stopped with signal ${signal}.`));
      else resolve(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`${label} exited with code ${exitCode}.\n${log()}`);
  }
}

async function buildProductionApp() {
  const child = spawn("npm", ["run", "build"], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = collectProcessOutput(child);
  await waitForProcess(child, "The production build", log);
  return log();
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
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The local production listener is still starting.
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
      "run",
      "start",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: REPOSITORY_ROOT,
      detached: true,
      env: { ...process.env, BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const log = collectProcessOutput(child);
  const appUrl = `http://127.0.0.1:${port}/`;
  await waitForHttp(appUrl, child, log);
  return { appUrl, child, log };
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
        listener(message.params ?? {}, message.sessionId ?? null);
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

  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.webSocket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
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
  timeoutMs,
  intervalMs = 50,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await evaluate(cdp, expression);
      if (value) return value;
    } catch {
      // React may be replacing the queried subtree while it settles.
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

const INSTRUMENTATION_SOURCE = `
(() => {
  localStorage.setItem("guided-reader-settings", JSON.stringify({
    narrationEngine: "device",
    narrationPreferenceVersion: 1,
    highlightScope: "sentence",
    follow: false
  }));

  const state = globalThis.__lineLightIssue56 = {
    errors: [],
    imports: [],
    longTasks: []
  };

  const recordError = (value) => state.errors.push(String(value));
  addEventListener("error", (event) => {
    recordError(event.error?.stack || event.message || "window error");
  });
  addEventListener("unhandledrejection", (event) => {
    recordError(event.reason?.stack || event.reason || "unhandled rejection");
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name,
          attribution: Array.from(entry.attribution || []).map((item) => ({
            name: item.name,
            containerId: item.containerId,
            containerName: item.containerName,
            containerSrc: item.containerSrc,
            containerType: item.containerType
          }))
        });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch (error) {
    recordError("Long Task observer unavailable: " + error.message);
  }

  const visible = (element) => {
    if (!element) return false;
    const rectangle = element.getBoundingClientRect();
    return rectangle.width > 0 && rectangle.height > 0 &&
      rectangle.bottom > 0 && rectangle.right > 0 &&
      rectangle.top < innerHeight && rectangle.left < innerWidth;
  };
  const monitor = () => {
    const current = state.imports.at(-1);
    const activeTitle = document.querySelector("h1")?.textContent ?? null;
    if (current && !current.stoppedAt && activeTitle === current.expectedTitle) {
      const now = performance.now();
      const pageOne = document.querySelector("#pdf-page-1");
      const pageOneCanvas = pageOne?.querySelector("canvas");
      const background = document.querySelector(
        '.pdf-page-block[data-pdf-page-index]:not([data-pdf-page-index="0"])'
      );
      if (pageOne && current.pageOneShellAt === null) {
        current.pageOneShellAt = now;
      }
      if (pageOne?.querySelector(".pdf-word-overlay") && current.pageOneTextAt === null) {
        current.pageOneTextAt = now;
      }
      if (
        pageOneCanvas?.width > 0 &&
        pageOneCanvas?.height > 0 &&
        !pageOne?.querySelector(".pdf-page-loading") &&
        visible(pageOneCanvas) &&
        current.pageOneBitmapAt === null
      ) {
        current.pageOneBitmapAt = now;
        current.pageOneRenderSource = pageOneCanvas.dataset.pdfRenderSource ?? null;
        current.renderFallback =
          document.querySelector(".pdf-page-view")?.dataset.pdfRenderFallback ?? null;
        current.pageOneCanvas = {
          width: pageOneCanvas.width,
          height: pageOneCanvas.height,
          cssWidth: pageOneCanvas.getBoundingClientRect().width,
          cssHeight: pageOneCanvas.getBoundingClientRect().height
        };
      }
      if (background && current.backgroundPageAt === null) {
        current.backgroundPageAt = now;
        current.backgroundPageNumber = Number(background.dataset.pdfPageIndex) + 1;
      }
    }
    requestAnimationFrame(monitor);
  };
  requestAnimationFrame(monitor);

  state.startImport = (label, expectedTitle) => {
    const startedAt = performance.now();
    performance.mark("linelight:harness:" + label + "-import-start");
    const run = {
      label,
      expectedTitle,
      startedAt,
      stoppedAt: null,
      pageOneShellAt: null,
      pageOneTextAt: null,
      pageOneBitmapAt: null,
      pageOneRenderSource: null,
      renderFallback: null,
      pageOneCanvas: null,
      backgroundPageAt: null,
      backgroundPageNumber: null,
      control: null
    };
    state.imports.push(run);
    return startedAt;
  };

  state.measureSettingsControl = async () => {
    const run = state.imports.at(-1);
    const button = Array.from(document.querySelectorAll("button"))
      .find((candidate) => candidate.textContent.includes("Reading settings"));
    if (!run || !button) throw new Error("Reading settings control was not found.");
    const startedAt = performance.now();
    button.click();
    while (!document.querySelector(".settings-panel")) {
      if (performance.now() - startedAt > 2000) {
        throw new Error("Reading settings did not open within two seconds.");
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const latencyMs = performance.now() - startedAt;
    document.querySelector('[aria-label="Close reading settings"]')?.click();
    run.control = { name: "Reading settings", startedAt, latencyMs };
    return run.control;
  };
})();
`;

async function configurePage(cdp, appUrl, networkState) {
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
  cdp.on("Network.requestWillBeSent", (event, sessionId) => {
    networkState.requests.push({
      documentURL: event.documentURL,
      initiatorType: event.initiator?.type ?? null,
      method: event.request.method,
      phase: networkState.phase,
      resourceType: event.type,
      sessionId,
      timestamp: event.timestamp,
      url: event.request.url,
    });
  });
  cdp.on("Network.loadingFailed", (event, sessionId) => {
    networkState.failures.push({
      blockedReason: event.blockedReason ?? null,
      canceled: event.canceled ?? false,
      errorText: event.errorText,
      phase: networkState.phase,
      requestId: event.requestId,
      sessionId,
      timestamp: event.timestamp,
    });
  });
  cdp.on("Target.attachedToTarget", (event) => {
    const { sessionId, targetInfo } = event;
    networkState.targets.push({
      sessionId,
      targetId: targetInfo.targetId,
      type: targetInfo.type,
      url: targetInfo.url,
    });
    void Promise.all([
      cdp.send("Network.enable", {}, sessionId),
      cdp.send(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          flatten: true,
          waitForDebuggerOnStart: false,
        },
        sessionId,
      ),
    ]).catch((error) => {
      networkState.attachErrors.push(String(error));
    });
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
      waitForDebuggerOnStart: false,
    }),
  ]);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: INSTRUMENTATION_SOURCE,
  });
  await cdp.send("Page.navigate", { url: appUrl });
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector(".import-button"))`,
    "the LineLight reader shell",
    30_000,
  );
  return consoleEntries;
}

async function openImportInput(cdp) {
  await waitForExpression(
    cdp,
    `(() => {
      const input = document.querySelector('input[type="file"]');
      if (input) return true;
      document.querySelector(".import-button")?.click();
      return false;
    })()`,
    "the import file input",
    10_000,
  );
  const documentNode = await cdp.send("DOM.getDocument", { depth: -1 });
  const fileInput = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: 'input[type="file"]',
  });
  if (!fileInput.nodeId) throw new Error("The import file input was not found.");
  return fileInput.nodeId;
}

async function beginImport(cdp, filePath, label, networkState) {
  const nodeId = await openImportInput(cdp);
  const expectedTitle = path.basename(filePath, path.extname(filePath));
  await evaluate(
    cdp,
    `globalThis.__lineLightIssue56.startImport(${JSON.stringify(label)}, ${JSON.stringify(expectedTitle)})`,
  );
  networkState.phase = label;
  await cdp.send("DOM.setFileInputFiles", {
    files: [filePath],
    nodeId,
  });
}

async function waitForFirstVisiblePage(cdp, label, timeoutMs) {
  return waitForExpression(
    cdp,
    `(() => {
      const run = globalThis.__lineLightIssue56.imports
        .find((candidate) => candidate.label === ${JSON.stringify(label)});
      return run?.pageOneBitmapAt ? structuredClone(run) : false;
    })()`,
    `${label} page one to display a completed bitmap`,
    timeoutMs,
  );
}

async function waitForBackgroundPage(cdp, label, timeoutMs = 30_000) {
  return waitForExpression(
    cdp,
    `(() => {
      const run = globalThis.__lineLightIssue56.imports
        .find((candidate) => candidate.label === ${JSON.stringify(label)});
      return run?.backgroundPageAt ? structuredClone(run) : false;
    })()`,
    `${label} background page two`,
    timeoutMs,
  );
}

async function inspectLibrary(cdp) {
  return evaluate(
    cdp,
    `(async () => {
      const request = indexedDB.open("guided-reader-library");
      const database = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const names = Array.from(database.objectStoreNames);
      const stores = ["documents", "state"];
      if (names.includes("pdf-pages")) stores.push("pdf-pages");
      if (names.includes("pdf-sources")) stores.push("pdf-sources");
      const transaction = database.transaction(stores, "readonly");
      const value = (request) => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const documents = await value(transaction.objectStore("documents").getAll());
      const activeDocumentId = await value(
        transaction.objectStore("state").get("active-document-id")
      );
      const pdfs = [];
      for (const document of documents.filter((candidate) => candidate?.kind === "pdf")) {
        const pageCount = names.includes("pdf-pages")
          ? await value(
              transaction.objectStore("pdf-pages").index("documentId").count(document.id)
            )
          : document.pdfPages?.length ?? 0;
        const hasSource = names.includes("pdf-sources")
          ? Boolean(await value(transaction.objectStore("pdf-sources").get(document.id)))
          : Boolean(document.pdfData?.length);
        pdfs.push({
          id: document.id,
          title: document.title,
          pdfCompletedPages: document.pdfCompletedPages ?? null,
          pdfImportStatus: document.pdfImportStatus ?? null,
          pdfPageCount: document.pdfPageCount ?? document.pdfPages?.length ?? null,
          pdfRevision: document.pdfRevision ?? null,
          storedPageCount: pageCount,
          hasSource,
          wordCount: document.wordCount ?? null
        });
      }
      database.close();
      return { activeDocumentId, pdfs };
    })()`,
  );
}

async function captureScreenshot(cdp, filePath) {
  const result = await cdp.send("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true,
  });
  await writeFile(filePath, Buffer.from(result.data, "base64"));
}

async function startTrace(cdp) {
  await cdp.send("Tracing.start", {
    categories: [
      "blink.user_timing",
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "loading",
      "toplevel",
    ].join(","),
    options: "record-as-much-as-possible",
    transferMode: "ReturnAsStream",
  });
}

async function stopTrace(cdp) {
  const completion = new Promise((resolve) => {
    cdp.on("Tracing.tracingComplete", resolve);
  });
  await cdp.send("Tracing.end");
  const result = await completion;
  if (!result.stream) throw new Error("Brave did not return a trace stream.");
  const chunks = [];
  while (true) {
    const chunk = await cdp.send("IO.read", { handle: result.stream });
    chunks.push(chunk.base64Encoded
      ? Buffer.from(chunk.data, "base64").toString("utf8")
      : chunk.data);
    if (chunk.eof) break;
  }
  await cdp.send("IO.close", { handle: result.stream });
  return chunks.join("");
}

function traceSummary(trace, documentId) {
  const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
  const pdfPrefix = `linelight:pdf:${documentId}:`;
  const pdfMarks = events
    .filter((event) => typeof event.name === "string" && event.name.startsWith(pdfPrefix))
    .map((event) => ({
      name: event.name,
      stage: event.name.split(":").slice(4).join(":"),
      threadId: event.tid,
      timestampMicroseconds: event.ts,
    }))
    .sort((left, right) => left.timestampMicroseconds - right.timestampMicroseconds);
  const harnessMarks = events
    .filter(
      (event) =>
        typeof event.name === "string" &&
        event.name.startsWith("linelight:harness:"),
    )
    .map((event) => ({ name: event.name, timestampMicroseconds: event.ts }))
    .sort((left, right) => left.timestampMicroseconds - right.timestampMicroseconds);
  const rendererMainThreadIds = new Set(
    events
      .filter(
        (event) =>
          event.ph === "M" &&
          event.name === "thread_name" &&
          event.args?.name === "CrRendererMain",
      )
      .map((event) => event.tid),
  );
  const importStart = harnessMarks.find(
    (mark) => mark.name === "linelight:harness:large-import-start",
  )?.timestampMicroseconds;
  const replacementStart = harnessMarks.find(
    (mark) => mark.name === "linelight:harness:replacement-import-start",
  )?.timestampMicroseconds;
  const mainThreadTasks = events
    .filter(
      (event) =>
        rendererMainThreadIds.has(event.tid) &&
        event.name === "RunTask" &&
        event.ph === "X" &&
        Number.isFinite(event.dur) &&
        (!importStart || event.ts + event.dur >= importStart) &&
        (!replacementStart || event.ts <= replacementStart),
    )
    .map((event) => ({
      durationMs: event.dur / 1000,
      startMicroseconds: event.ts,
      threadId: event.tid,
    }));
  return {
    harnessMarks,
    mainThreadTasks,
    maximumMainThreadTaskMs: mainThreadTasks.length
      ? Math.max(...mainThreadTasks.map((task) => task.durationMs))
      : null,
    pdfMarks,
    rendererMainThreadIds: [...rendererMainThreadIds],
  };
}

function workerOrdering(summary) {
  const stage = (name) => summary.pdfMarks.find((mark) => mark.stage === name);
  const rasterStart = stage("page-1-raster-start");
  const rasterEnd = stage("page-1-raster-end");
  const pageOnePosted = stage("page-1-posted");
  const pageTwoTextStart = stage("page-2-text-start");
  const complete = stage("complete");
  const usesWorkerRaster = Boolean(rasterStart || rasterEnd);
  return {
    completeBeforeReplacement: Boolean(complete),
    pageOnePosted,
    pageTwoTextStart,
    passed:
      Boolean(pageOnePosted) &&
      Boolean(pageTwoTextStart) &&
      pageOnePosted.timestampMicroseconds <= pageTwoTextStart.timestampMicroseconds &&
      (!usesWorkerRaster ||
        (Boolean(rasterStart) &&
          Boolean(rasterEnd) &&
          rasterStart.timestampMicroseconds <= rasterEnd.timestampMicroseconds &&
          rasterEnd.timestampMicroseconds <= pageOnePosted.timestampMicroseconds)),
    rasterEnd,
    rasterStart,
    usesWorkerRaster,
  };
}

function requestIsExternal(request, appUrl) {
  try {
    const url = new URL(request.url);
    if (["blob:", "data:", "about:"].includes(url.protocol)) return false;
    return url.origin !== new URL(appUrl).origin;
  } catch {
    return true;
  }
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function fileEvidence(filePath) {
  const details = await stat(filePath);
  return {
    path: filePath,
    bytes: details.size,
    sha256: await sha256File(filePath),
  };
}

function sourceEvidence() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  ).trim();
  return { commit, dirty: Boolean(status), status: status.split("\n").filter(Boolean) };
}

function importTiming(instrumentation, label) {
  const run = instrumentation.imports.find((candidate) => candidate.label === label);
  if (!run) return null;
  const firstPageEnd = run.pageOneBitmapAt;
  const nextRun = instrumentation.imports.find(
    (candidate) => candidate.startedAt > run.startedAt,
  );
  const activeEnd = nextRun?.startedAt ?? instrumentation.capturedAt;
  return {
    ...run,
    activeWindowEnd: activeEnd,
    importToFirstBitmapMs:
      firstPageEnd === null ? null : firstPageEnd - run.startedAt,
    importToFirstShellMs:
      run.pageOneShellAt === null ? null : run.pageOneShellAt - run.startedAt,
    firstBitmapBeforeBackgroundDom:
      run.pageOneBitmapAt !== null &&
      (run.backgroundPageAt === null || run.pageOneBitmapAt <= run.backgroundPageAt),
    firstPageWindowLongTasks: instrumentation.longTasks.filter(
      (entry) =>
        entry.startTime >= run.startedAt &&
        firstPageEnd !== null &&
        entry.startTime <= firstPageEnd,
    ),
    windowLongTasks: instrumentation.longTasks.filter(
      (entry) =>
        entry.startTime >= run.startedAt &&
        entry.startTime <= activeEnd,
    ),
  };
}

async function run(options) {
  await Promise.all([
    access(options.reference),
    access(options.replacement),
    access(options.browser),
  ]);
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error(
      "A graphical DISPLAY or WAYLAND_DISPLAY is required for headed-Brave evidence.",
    );
  }
  await mkdir(options.outputDirectory, { recursive: true });

  let browser;
  let cdp;
  let server;
  let traceText = "";
  let traceStarted = false;
  let buildLog = "";
  let consoleEntries = [];
  const networkState = {
    attachErrors: [],
    failures: [],
    phase: "startup",
    requests: [],
    targets: [],
  };
  const evidence = {
    schemaVersion: 1,
    issue: 56,
    generatedAt: new Date().toISOString(),
    passed: false,
    failures: [],
  };

  try {
    if (!options.appUrl && !options.skipBuild) buildLog = await buildProductionApp();
    server = options.appUrl ? null : await startProductionServer();
    const appUrl = options.appUrl ?? server.appUrl;
    const productionMode = options.appUrl ? "external-production-url" : "local-production-build";

    browser = await startBrowser(options.browser, true);
    cdp = await CdpSession.connect(browser.webSocketDebuggerUrl);
    consoleEntries = await configurePage(cdp, appUrl, networkState);
    const browserVersion = await cdp.send("Browser.getVersion");
    const source = sourceEvidence();
    if (source.dirty) {
      throw new Error(
        "Issue #56 browser evidence must run from a clean committed source tree.",
      );
    }
    const reference = await fileEvidence(options.reference);
    const replacement = await fileEvidence(options.replacement);

    await startTrace(cdp);
    traceStarted = true;
    await beginImport(cdp, options.reference, "large", networkState);
    const control = await evaluate(
      cdp,
      `globalThis.__lineLightIssue56.measureSettingsControl()`,
    );
    const largeFirstPage = await waitForFirstVisiblePage(
      cdp,
      "large",
      options.timeoutMs,
    );
    const largeLibraryAtFirstPaint = await inspectLibrary(cdp);
    await captureScreenshot(
      cdp,
      path.join(options.outputDirectory, "large-first-page.png"),
    );
    await waitForBackgroundPage(cdp, "large", Math.min(options.timeoutMs, 30_000));

    await beginImport(cdp, options.replacement, "replacement", networkState);
    const replacementFirstPage = await waitForFirstVisiblePage(
      cdp,
      "replacement",
      options.timeoutMs,
    );
    await captureScreenshot(
      cdp,
      path.join(options.outputDirectory, "replacement-first-page.png"),
    );
    await delay(1_000);
    const titleAfterSettling = await evaluate(
      cdp,
      `document.querySelector("h1")?.textContent ?? null`,
    );
    const libraryAfterReplacement = await inspectLibrary(cdp);
    const instrumentation = await evaluate(
      cdp,
      `({
        errors: globalThis.__lineLightIssue56.errors.slice(),
        imports: globalThis.__lineLightIssue56.imports.map((run) => ({ ...run })),
        longTasks: globalThis.__lineLightIssue56.longTasks.map((task) => ({ ...task })),
        capturedAt: performance.now()
      })`,
    );
    traceText = await stopTrace(cdp);
    traceStarted = false;
    const parsedTrace = JSON.parse(traceText);
    const largeRecordAtFirstPaint = largeLibraryAtFirstPaint.pdfs.find(
      (document) => document.pdfPageCount === options.expectedPages,
    );
    const largeRecordAfterReplacement = libraryAfterReplacement.pdfs.find(
      (document) => document.id === largeRecordAtFirstPaint?.id,
    );
    const activeRecordAfterReplacement = libraryAfterReplacement.pdfs.find(
      (document) => document.id === libraryAfterReplacement.activeDocumentId,
    );
    const trace = traceSummary(parsedTrace, largeRecordAtFirstPaint?.id ?? "missing");
    const ordering = workerOrdering(trace);
    const largeTiming = importTiming(instrumentation, "large");
    const replacementTiming = importTiming(instrumentation, "replacement");
    const importRequests = networkState.requests.filter((request) =>
      ["large", "replacement"].includes(request.phase),
    );
    const externalRequests = importRequests.filter((request) =>
      requestIsExternal(request, appUrl),
    );
    const runtimeErrors = instrumentation.errors;

    if (!largeRecordAtFirstPaint) {
      evidence.failures.push(
        `The first-paint library snapshot did not contain a ${options.expectedPages}-page PDF.`,
      );
    } else {
      if (largeRecordAtFirstPaint.pdfImportStatus !== "importing") {
        evidence.failures.push("The full PDF completed before the first page was displayed.");
      }
      if (largeRecordAtFirstPaint.pdfCompletedPages >= options.expectedPages) {
        evidence.failures.push("Background extraction completed before first-page display.");
      }
      if (!largeRecordAtFirstPaint.hasSource || largeRecordAtFirstPaint.storedPageCount < 1) {
        evidence.failures.push("Page one and its private source were not durably staged.");
      }
    }
    if (!largeTiming?.firstBitmapBeforeBackgroundDom) {
      evidence.failures.push("The first visible bitmap did not precede background page DOM.");
    }
    if (
      largeTiming?.pageOneRenderSource !== "worker-bitmap" ||
      largeTiming?.renderFallback !== "false"
    ) {
      evidence.failures.push(
        "The supplied PDF did not prove a real OffscreenCanvas worker bitmap without fallback.",
      );
    }
    if (!ordering.passed) {
      evidence.failures.push(
        "Worker trace marks did not prove page-one raster settlement before page-two extraction.",
      );
    }
    if (ordering.completeBeforeReplacement) {
      evidence.failures.push("The large import completed before its replacement was selected.");
    }
    if ((largeTiming?.windowLongTasks ?? []).some((entry) => entry.duration > MAX_WINDOW_TASK_MS)) {
      evidence.failures.push(
        `A Window Long Task exceeded ${MAX_WINDOW_TASK_MS} ms while the large import remained active.`,
      );
    }
    if (
      (replacementTiming?.windowLongTasks ?? []).some(
        (entry) => entry.duration > MAX_WINDOW_TASK_MS,
      )
    ) {
      evidence.failures.push(
        `A Window Long Task exceeded ${MAX_WINDOW_TASK_MS} ms during replacement/cancellation.`,
      );
    }
    if (!control || control.latencyMs > MAX_CONTROL_LATENCY_MS) {
      evidence.failures.push(
        `Reading settings did not respond within ${MAX_CONTROL_LATENCY_MS} ms during import.`,
      );
    }
    if (externalRequests.length) {
      evidence.failures.push("The page or one of its attached workers made an external import request.");
    }
    if (networkState.attachErrors.length) {
      evidence.failures.push("One or more worker targets could not be instrumented for network traffic.");
    }
    if (
      !largeRecordAfterReplacement ||
      largeRecordAfterReplacement.pdfImportStatus !== "importing" ||
      largeRecordAfterReplacement.pdfCompletedPages >= options.expectedPages ||
      largeRecordAfterReplacement.storedPageCount < 1 ||
      !largeRecordAfterReplacement.hasSource
    ) {
      evidence.failures.push("The canceled large import was not left as a resumable local prefix.");
    }
    if (
      !activeRecordAfterReplacement ||
      activeRecordAfterReplacement.id === largeRecordAfterReplacement?.id ||
      titleAfterSettling !== activeRecordAfterReplacement.title
    ) {
      evidence.failures.push("The replacement PDF did not remain the active rendered document.");
    }
    if (!replacementTiming?.pageOneBitmapAt) {
      evidence.failures.push("The replacement PDF did not render its first page.");
    }
    if (runtimeErrors.length) evidence.failures.push("The browser recorded runtime errors.");

    evidence.passed = evidence.failures.length === 0;
    Object.assign(evidence, {
      app: { mode: productionMode, url: appUrl },
      browser: {
        executable: options.browser,
        headed: true,
        product: browserVersion.product,
        revision: browserVersion.revision,
        userAgent: browserVersion.userAgent,
      },
      source,
      fixtures: {
        reference: { ...reference, expectedPages: options.expectedPages },
        replacement,
      },
      thresholds: {
        maximumControlLatencyMs: MAX_CONTROL_LATENCY_MS,
        maximumWindowTaskMs: MAX_WINDOW_TASK_MS,
      },
      firstPage: {
        large: largeFirstPage,
        replacement: replacementFirstPage,
        largeLibraryAtFirstPaint,
      },
      timings: { control, large: largeTiming, replacement: replacementTiming },
      ordering,
      cancellation: {
        activeRecordAfterReplacement,
        largeRecordAfterReplacement,
        libraryAfterReplacement,
        titleAfterSettling,
      },
      network: {
        attachErrors: networkState.attachErrors,
        attachedTargets: networkState.targets,
        externalRequests,
        importFailures: networkState.failures.filter((failure) =>
          ["large", "replacement"].includes(failure.phase),
        ),
        importRequests,
      },
      trace: {
        file: "pdf-worker-trace.json",
        ...trace,
      },
      browserDiagnostics: {
        consoleEntries,
        errors: runtimeErrors,
        browserStderr: browser.log(),
        productionBuildLog: buildLog,
        productionServerLog: server?.log() ?? null,
      },
      artifacts: {
        largeFirstPageScreenshot: "large-first-page.png",
        replacementFirstPageScreenshot: "replacement-first-page.png",
        trace: "pdf-worker-trace.json",
      },
    });
  } catch (error) {
    evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
    if (cdp) {
      evidence.failureState = await evaluate(
        cdp,
        `({
          instrumentation: globalThis.__lineLightIssue56 ? {
            errors: globalThis.__lineLightIssue56.errors.slice(),
            imports: globalThis.__lineLightIssue56.imports.map((run) => ({ ...run })),
            longTasks: globalThis.__lineLightIssue56.longTasks.map((task) => ({ ...task })),
            capturedAt: performance.now()
          } : null,
          title: document.querySelector("h1")?.textContent ?? null,
          notice: document.querySelector(".notice")?.textContent ?? null,
          view: document.querySelector(".pdf-page-view") ? "page" :
            document.querySelector(".reading-page") ? "focus" : null,
          pageCount: document.querySelectorAll(".pdf-page-block").length,
          firstPage: (() => {
            const page = document.querySelector("#pdf-page-1");
            const canvas = page?.querySelector("canvas");
            return page ? {
              loading: Boolean(page.querySelector(".pdf-page-loading")),
              canvasWidth: canvas?.width ?? null,
              canvasHeight: canvas?.height ?? null,
              rectangle: canvas ? {
                top: canvas.getBoundingClientRect().top,
                bottom: canvas.getBoundingClientRect().bottom,
                width: canvas.getBoundingClientRect().width,
                height: canvas.getBoundingClientRect().height
              } : null
            } : null;
          })()
        })`,
      ).catch((diagnosticError) => ({ error: String(diagnosticError) }));
      evidence.failureLibrary = await inspectLibrary(cdp).catch(
        (diagnosticError) => ({ error: String(diagnosticError) }),
      );
      await captureScreenshot(
        cdp,
        path.join(options.outputDirectory, "failure.png"),
      ).catch(() => undefined);
      if (traceStarted) {
        traceText = await stopTrace(cdp).catch(() => "");
        traceStarted = false;
      }
    }
    evidence.browserDiagnostics = {
      consoleEntries,
      browserStderr: browser?.log() ?? null,
      productionBuildLog: buildLog,
      productionServerLog: server?.log() ?? null,
    };
  } finally {
    if (traceText) {
      await writeFile(
        path.join(options.outputDirectory, "pdf-worker-trace.json"),
        traceText,
      );
    }
    await writeFile(
      path.join(options.outputDirectory, "pdf-worker-browser.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    cdp?.close();
    terminateProcessGroup(browser?.child);
    terminateProcessGroup(server?.child);
    if (browser?.profileDirectory) {
      await delay(100);
      await rm(browser.profileDirectory, { recursive: true, force: true });
    }
  }

  if (!evidence.passed) {
    throw new Error(evidence.failures.join("\n"));
  }
  process.stdout.write(
    `${JSON.stringify({
      evidence: path.join(options.outputDirectory, "pdf-worker-browser.json"),
      firstPageMs: evidence.timings.large.importToFirstBitmapMs,
      maximumWindowTaskMs: Math.max(
        0,
        ...evidence.timings.large.windowLongTasks.map((entry) => entry.duration),
      ),
      passed: true,
      trace: path.join(options.outputDirectory, "pdf-worker-trace.json"),
    }, null, 2)}\n`,
  );
}

const options = parseArguments(process.argv.slice(2));
if (options) {
  run(options).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}
