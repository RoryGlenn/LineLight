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
  stopProcessGroup,
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
const BUILD_TIMEOUT_MS = 300_000;
const CDP_COMMAND_TIMEOUT_MS = 15_000;
const CDP_STREAM_TIMEOUT_MS = 30_000;
const PROCESS_SHUTDOWN_TIMEOUT_MS = 3_000;

function parseArguments(argv) {
  const options = {
    appUrl: null,
    browser: process.env.LINELIGHT_BROWSER ?? "/usr/bin/brave-browser",
    expectedPages: 359,
    outputDirectory:
      process.env.LINELIGHT_PDF_WORKER_EVIDENCE ?? DEFAULT_OUTPUT_DIRECTORY,
    reference: DEFAULT_REFERENCE_PDF,
    replacement: DEFAULT_PDF_HIGHLIGHT_FIXTURE,
    replacementPages: 6,
    skipBuild: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--url") options.appUrl = argv[++index];
    else if (argument === "--browser") options.browser = argv[++index];
    else if (argument === "--reference") options.reference = argv[++index];
    else if (argument === "--replacement") options.replacement = argv[++index];
    else if (argument === "--replacement-pages") {
      options.replacementPages = Number(argv[++index]);
    }
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
          "  --replacement-pages N  Expected replacement page count (default: 6).",
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
  if (!Number.isInteger(options.replacementPages) || options.replacementPages < 1) {
    throw new Error("--replacement-pages must be a positive integer.");
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

function processStatus(child) {
  return {
    code: child?.exitCode ?? null,
    exited: Boolean(
      child && (child.exitCode !== null || child.signalCode !== null)
    ),
    signal: child?.signalCode ?? null,
    stderrClosed: Boolean(
      !child?.stderr || child.stderr.destroyed || child.stderr.readableEnded
    ),
    stdoutClosed: Boolean(
      !child?.stdout || child.stdout.destroyed || child.stdout.readableEnded
    ),
  };
}

async function waitForProcessClose(child, timeoutMs) {
  const status = processStatus(child);
  if (!child || (status.exited && status.stderrClosed && status.stdoutClosed)) {
    return true;
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("close", onClose);
  });
}

async function stopOwnedProcess(child, processGroupId, label) {
  if (!child && !processGroupId) {
    return { closed: true, label, present: false };
  }
  const group = await stopProcessGroup(
    processGroupId,
    PROCESS_SHUTDOWN_TIMEOUT_MS,
  );
  const processClosed = await waitForProcessClose(
    child,
    PROCESS_SHUTDOWN_TIMEOUT_MS,
  );
  return {
    closed: group.closed && processClosed,
    group,
    label,
    present: true,
    processClosed,
    ...processStatus(child),
  };
}

async function waitForProcess(child, label, log, timeoutMs) {
  const exitCode = await new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      if (signal) reject(new Error(`${label} stopped with signal ${signal}.`));
      else resolve(code);
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} timed out after ${timeoutMs} ms.\n${log()}`));
    }, timeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  if (exitCode !== 0) {
    throw new Error(`${label} exited with code ${exitCode}.\n${log()}`);
  }
}

async function buildProductionApp() {
  const child = spawn("npm", ["run", "build"], {
    cwd: REPOSITORY_ROOT,
    detached: true,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const processGroupId = child.pid;
  const log = collectProcessOutput(child);
  try {
    await waitForProcess(child, "The production build", log, BUILD_TIMEOUT_MS);
    return log();
  } catch (error) {
    const shutdown = await stopOwnedProcess(
      child,
      processGroupId,
      "production-build",
    );
    if (shutdown.closed) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nProduction build process group ${processGroupId} survived cleanup.`,
    );
  }
}

async function waitForHttp(url, processHandle, log, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (
      processHandle?.exitCode !== null ||
      processHandle?.signalCode !== null
    ) {
      throw new Error(
        `The production server stopped before ${url} was ready.\n${log()}`,
      );
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
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
  const processGroupId = child.pid;
  const log = collectProcessOutput(child);
  const appUrl = `http://127.0.0.1:${port}/`;
  try {
    await waitForHttp(appUrl, child, log);
    return { appUrl, child, log, processGroupId };
  } catch (error) {
    const shutdown = await stopOwnedProcess(
      child,
      processGroupId,
      "production-server",
    );
    if (shutdown.closed) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nProduction server process group ${processGroupId} survived cleanup.`,
    );
  }
}

class CdpSession {
  constructor(webSocket) {
    this.webSocket = webSocket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.commandLog = [];
    this.connectionEvents = [];
    this.usable = true;
    const retain = (entries, entry, maximum = 240) => {
      entries.push(entry);
      if (entries.length > maximum) entries.shift();
    };
    this.retain = retain;
    const rejectPending = (status, error) => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        retain(this.commandLog, {
          elapsedMs: Date.now() - pending.startedAt,
          id,
          method: pending.method,
          sessionId: pending.sessionId,
          status,
        });
        pending.reject(error);
      }
      this.pending.clear();
    };
    webSocket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        retain(this.commandLog, {
          elapsedMs: Date.now() - pending.startedAt,
          id: message.id,
          method: pending.method,
          sessionId: pending.sessionId,
          status: message.error ? "error" : "resolved",
          ...(message.error ? { error: message.error.message } : {}),
        });
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {}, message.sessionId ?? null);
      }
    });
    webSocket.addEventListener("error", (event) => {
      this.usable = false;
      retain(this.connectionEvents, {
        at: new Date().toISOString(),
        message: event.message ?? "WebSocket error",
        type: "error",
      });
      rejectPending(
        "connection-error",
        new Error("The browser debugging connection failed."),
      );
    });
    webSocket.addEventListener("close", (event) => {
      this.usable = false;
      retain(this.connectionEvents, {
        at: new Date().toISOString(),
        code: event.code,
        reason: event.reason,
        type: "close",
        wasClean: event.wasClean,
      });
      rejectPending(
        "connection-closed",
        new Error("The browser debugging connection closed."),
      );
    });
  }

  static async connect(url) {
    const webSocket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        webSocket.close();
        reject(new Error("Timed out connecting to the browser debugging target."));
      }, CDP_COMMAND_TIMEOUT_MS);
      const settle = (callback) => (event) => {
        clearTimeout(timeout);
        callback(event);
      };
      webSocket.addEventListener("open", settle(resolve), { once: true });
      webSocket.addEventListener("error", settle(reject), { once: true });
    });
    return new CdpSession(webSocket);
  }

  send(method, params = {}, sessionId = null) {
    if (!this.isUsable()) {
      return Promise.reject(
        new Error(`Cannot send CDP ${method}; the debugging target is closed.`),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timeoutMs = method === "IO.read"
        ? CDP_STREAM_TIMEOUT_MS
        : CDP_COMMAND_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.usable = false;
        this.retain(this.commandLog, {
          elapsedMs: Date.now() - startedAt,
          id,
          method,
          sessionId,
          status: "timeout",
        });
        reject(
          new Error(
            `Timed out after ${timeoutMs} ms waiting for CDP ${method}.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        method,
        reject,
        resolve,
        sessionId,
        startedAt,
        timeout,
      });
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
        this.usable = false;
        this.retain(this.commandLog, {
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id,
          method,
          sessionId,
          status: "send-error",
        });
        reject(error);
      }
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
    return () => {
      const current = this.listeners.get(method) ?? [];
      const next = current.filter((candidate) => candidate !== listener);
      if (next.length) this.listeners.set(method, next);
      else this.listeners.delete(method);
    };
  }

  isUsable() {
    return this.usable && this.webSocket.readyState === WebSocket.OPEN;
  }

  async close(timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS) {
    this.usable = false;
    if (this.webSocket.readyState === WebSocket.CLOSED) return true;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.webSocket.removeEventListener("close", onClose);
        resolve(false);
      }, timeoutMs);
      const onClose = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      this.webSocket.addEventListener("close", onClose, { once: true });
      try {
        this.webSocket.close();
      } catch {
        clearTimeout(timeout);
        this.webSocket.removeEventListener("close", onClose);
        resolve(false);
      }
    });
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
    longTasks: [],
    notices: []
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
  let lastNotice = null;
  new MutationObserver(() => {
    const text = document.querySelector(".notice")?.textContent?.trim() ?? null;
    if (!text || text === lastNotice) return;
    lastNotice = text;
    state.notices.push({
      at: performance.now(),
      importLabel: state.imports.at(-1)?.label ?? null,
      text
    });
  }).observe(document, { childList: true, characterData: true, subtree: true });

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
      const renderFallback =
        document.querySelector(".pdf-page-view")?.dataset.pdfRenderFallback ?? null;
      const background = document.querySelector(
        '.pdf-page-block[data-pdf-page-index]:not([data-pdf-page-index="0"])'
      );
      if (pageOne && current.pageOneShellAt === null) {
        current.pageOneShellAt = now;
      }
      if (pageOne?.querySelector(".pdf-word-overlay") && current.pageOneTextAt === null) {
        current.pageOneTextAt = now;
      }
      if (renderFallback === "true") current.renderFallbackObserved = true;
      if (
        pageOneCanvas?.width > 0 &&
        pageOneCanvas?.height > 0 &&
        !pageOne?.querySelector(".pdf-page-loading") &&
        visible(pageOneCanvas) &&
        current.pageOneBitmapAt === null
      ) {
        current.pageOneBitmapAt = now;
        current.pageOneRenderSource = pageOneCanvas.dataset.pdfRenderSource ?? null;
        current.renderFallback = renderFallback;
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
      control: null,
      controls: [],
      outcome: null,
      renderFallbackObserved: false
    };
    state.imports.push(run);
    return startedAt;
  };

  state.finishImport = async (label, outcome) => {
    const run = state.imports.find((candidate) => candidate.label === label);
    if (!run) throw new Error("Unknown import run: " + label);
    if (run.stoppedAt !== null) return structuredClone(run);
    await new Promise((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(resolve)
    ));
    run.stoppedAt = performance.now();
    run.outcome = outcome;
    performance.mark("linelight:harness:" + label + "-import-end");
    return structuredClone(run);
  };

  state.mark = (label) => performance.mark("linelight:harness:" + label);

  state.measureSettingsControl = async (probeId) => {
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
    run.control = { name: "Reading settings", probeId, startedAt, latencyMs };
    run.controls.push(run.control);
    return run.control;
  };
})();
`;

async function configurePage(cdp, appUrl, networkState) {
  const consoleEntries = [];
  cdp.on("Runtime.consoleAPICalled", (event, sessionId) => {
    consoleEntries.push({
      phase: networkState.phase,
      sessionId,
      type: event.type,
      values: event.args.map((argument) => argument.value ?? argument.description),
    });
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    consoleEntries.push({
      phase: networkState.phase,
      sessionId: null,
      type: entry.level,
      values: [entry.text],
    });
  });
  cdp.on("Network.requestWillBeSent", (event, sessionId) => {
    const request = {
      documentURL: event.documentURL,
      initiatorType: event.initiator?.type ?? null,
      method: event.request.method,
      phase: networkState.phase,
      requestId: event.requestId,
      resourceType: event.type,
      sessionId,
      timestamp: event.timestamp,
      url: event.request.url,
    };
    networkState.requests.push(request);
    networkState.requestsByKey.set(`${sessionId ?? "page"}:${event.requestId}`, request);
  });
  cdp.on("Network.loadingFailed", (event, sessionId) => {
    const request = networkState.requestsByKey.get(
      `${sessionId ?? "page"}:${event.requestId}`,
    );
    networkState.failures.push({
      blockedReason: event.blockedReason ?? null,
      canceled: event.canceled ?? false,
      documentURL: request?.documentURL ?? null,
      errorText: event.errorText,
      phase: request?.phase ?? networkState.phase,
      requestId: event.requestId,
      resourceType: event.type ?? request?.resourceType ?? null,
      sessionId,
      timestamp: event.timestamp,
      url: request?.url ?? null,
    });
  });
  cdp.on("Network.responseReceived", (event, sessionId) => {
    if (event.response.status < 400) return;
    const request = networkState.requestsByKey.get(
      `${sessionId ?? "page"}:${event.requestId}`,
    );
    networkState.responseFailures.push({
      phase: request?.phase ?? networkState.phase,
      requestId: event.requestId,
      resourceType: event.type ?? request?.resourceType ?? null,
      sessionId,
      status: event.response.status,
      statusText: event.response.statusText,
      timestamp: event.timestamp,
      url: event.response.url ?? request?.url ?? null,
    });
  });
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }, sessionId) => {
    networkState.runtimeExceptions.push({
      columnNumber: exceptionDetails.columnNumber ?? null,
      exception:
        exceptionDetails.exception?.description ??
        exceptionDetails.exception?.value ??
        null,
      lineNumber: exceptionDetails.lineNumber ?? null,
      phase: networkState.phase,
      scriptId: exceptionDetails.scriptId ?? null,
      sessionId,
      stack: (exceptionDetails.stackTrace?.callFrames ?? []).map((frame) => ({
        columnNumber: frame.columnNumber,
        functionName: frame.functionName,
        lineNumber: frame.lineNumber,
        scriptId: frame.scriptId,
        url: frame.url,
      })),
      text: exceptionDetails.text,
      timestamp: exceptionDetails.timestamp ?? null,
      url: exceptionDetails.url ?? null,
    });
  });
  cdp.on("Target.attachedToTarget", (event) => {
    const { sessionId, targetInfo, waitingForDebugger } = event;
    networkState.targets.push({
      sessionId,
      targetId: targetInfo.targetId,
      type: targetInfo.type,
      url: targetInfo.url,
    });
    void (async () => {
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
        networkState.attachErrors.push({
          error: String(error),
          sessionId,
          targetType: targetInfo.type,
          targetUrl: targetInfo.url,
        });
      } finally {
        if (waitingForDebugger) {
          await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(
            (error) => {
              networkState.attachErrors.push({
                error: `Could not resume target: ${String(error)}`,
                sessionId,
                targetType: targetInfo.type,
                targetUrl: targetInfo.url,
              });
            },
          );
        }
      }
    })();
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
  await markHarness(cdp, `${label}-dispatched`);
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

async function waitForPdfRecord(
  cdp,
  {
    description,
    expectedPages,
    minimumStoredPages = 1,
    onProbe,
    probeEveryMs = 1_000,
    status,
    timeoutMs,
    title,
  },
) {
  const startedAt = Date.now();
  let lastProbeAt = startedAt;
  while (Date.now() - startedAt < timeoutMs) {
    const library = await inspectLibrary(cdp);
    const record = library.pdfs.find(
      (candidate) =>
        candidate.title === title &&
        candidate.pdfPageCount === expectedPages &&
        candidate.pdfImportStatus === status &&
        candidate.storedPageCount >= minimumStoredPages,
    );
    if (record) return { library, record };
    if (onProbe && Date.now() - lastProbeAt >= probeEveryMs) {
      await onProbe();
      lastProbeAt = Date.now();
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function finishInstrumentedImport(cdp, label, outcome) {
  return evaluate(
    cdp,
    `globalThis.__lineLightIssue56.finishImport(${JSON.stringify(label)}, ${JSON.stringify(outcome)})`,
  );
}

async function markHarness(cdp, label) {
  await evaluate(
    cdp,
    `globalThis.__lineLightIssue56.mark(${JSON.stringify(label)})`,
  );
}

async function measureSettingsControl(cdp) {
  const probeId = `control-${measureSettingsControl.nextProbeId++}`;
  const dispatchedAt = performance.now();
  const control = await evaluate(
    cdp,
    `globalThis.__lineLightIssue56.measureSettingsControl(${JSON.stringify(probeId)})`,
  );
  const dispatchLatencyMs = performance.now() - dispatchedAt;
  await evaluate(
    cdp,
    `(() => {
      const control = globalThis.__lineLightIssue56.imports
        .flatMap((run) => run.controls)
        .find((candidate) => candidate.probeId === ${JSON.stringify(probeId)});
      if (!control) throw new Error("Control probe was not retained.");
      control.dispatchLatencyMs = ${JSON.stringify(dispatchLatencyMs)};
      return true;
    })()`,
  );
  return { ...control, dispatchLatencyMs };
}
measureSettingsControl.nextProbeId = 1;

async function captureInstrumentation(cdp) {
  return evaluate(
    cdp,
    `({
      errors: globalThis.__lineLightIssue56.errors.slice(),
      imports: globalThis.__lineLightIssue56.imports.map((run) => ({ ...run })),
      longTasks: globalThis.__lineLightIssue56.longTasks.map((task) => ({ ...task })),
      notices: globalThis.__lineLightIssue56.notices.map((notice) => ({ ...notice })),
      capturedAt: performance.now()
    })`,
  );
}

function isolatedLoopbackUrl(appUrl) {
  const url = new URL(appUrl);
  if (url.hostname === "127.0.0.1") url.hostname = "localhost";
  else if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  else {
    throw new Error(
      "The two-scenario harness needs a loopback production URL so it can use a second isolated origin.",
    );
  }
  return url.href;
}

async function navigateToCleanOrigin(cdp, appUrl, networkState) {
  const isolatedUrl = isolatedLoopbackUrl(appUrl);
  networkState.phase = "isolation-navigation";
  await cdp.send("Page.navigate", { url: isolatedUrl });
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector(".import-button"))`,
    "LineLight on the isolated cancellation origin",
    30_000,
  );
  return isolatedUrl;
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
      const countOutlineItems = (items) => (items ?? []).reduce(
        (total, item) => total + 1 + countOutlineItems(item.items),
        0
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
          outlineItemCount: countOutlineItems(document.outline),
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
  let removeListener = () => {};
  let traceTimeout;
  const completion = new Promise((resolve, reject) => {
    traceTimeout = setTimeout(
      () => reject(new Error("Timed out waiting for Brave to finish the trace.")),
      30_000,
    );
    removeListener = cdp.on("Tracing.tracingComplete", (result) => {
      resolve(result);
    });
  });
  let result;
  try {
    await cdp.send("Tracing.end");
    result = await completion;
  } finally {
    clearTimeout(traceTimeout);
    removeListener();
  }
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

function traceSummary(trace, { documentId, endLabel, startLabel }) {
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
    .map((event) => ({
      name: event.name,
      processId: event.pid,
      threadId: event.tid,
      timestampMicroseconds: event.ts,
    }))
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
  const windowStart = harnessMarks.find(
    (mark) => mark.name === `linelight:harness:${startLabel}-import-start`,
  )?.timestampMicroseconds;
  const windowEnd = harnessMarks.find(
    (mark) => mark.name === `linelight:harness:${endLabel}-import-end`,
  )?.timestampMicroseconds;
  const windowProcessId = harnessMarks.find(
    (mark) => mark.name === `linelight:harness:${startLabel}-import-start`,
  )?.processId;
  const windowThreadId = harnessMarks.find(
    (mark) => mark.name === `linelight:harness:${startLabel}-import-start`,
  )?.threadId;
  const mainThreadTasks = events
    .filter(
      (event) =>
        event.pid === windowProcessId &&
        event.tid === windowThreadId &&
        typeof event.name === "string" &&
        (event.name === "RunTask" || event.name.endsWith("::RunTask")) &&
        event.ph === "X" &&
        Number.isFinite(event.dur) &&
        (!windowStart || event.ts + event.dur >= windowStart) &&
        (!windowEnd || event.ts <= windowEnd),
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
    windowEndMicroseconds: windowEnd ?? null,
    windowProcessId: windowProcessId ?? null,
    windowStartMicroseconds: windowStart ?? null,
    windowThreadId: windowThreadId ?? null,
  };
}

function workerOrdering(summary, { requireComplete = false } = {}) {
  const stage = (name) => summary.pdfMarks.find((mark) => mark.stage === name);
  const pageOnePersisted = stage("page-1-persisted");
  const rasterStart = stage("page-1-raster-start");
  const rasterEnd = stage("page-1-raster-end");
  const pageOnePosted = stage("page-1-posted");
  const pageTwoTextStart = stage("page-2-text-start");
  const complete = stage("complete");
  const usesWorkerRaster = Boolean(rasterStart || rasterEnd);
  return {
    complete,
    completeSeen: Boolean(complete),
    pageOnePersisted,
    pageOnePosted,
    pageTwoTextStart,
    passed:
      Boolean(pageOnePosted) &&
      Boolean(pageOnePersisted) &&
      Boolean(pageTwoTextStart) &&
      pageOnePersisted.timestampMicroseconds <=
        (rasterStart?.timestampMicroseconds ?? pageOnePosted.timestampMicroseconds) &&
      pageOnePosted.timestampMicroseconds <= pageTwoTextStart.timestampMicroseconds &&
      (!requireComplete || Boolean(complete)) &&
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
  const activeEnd = run.stoppedAt ?? instrumentation.capturedAt;
  return {
    ...run,
    activeWindowEnd: activeEnd,
    importToFirstBitmapMs:
      firstPageEnd === null ? null : firstPageEnd - run.startedAt,
    importToFirstShellMs:
      run.pageOneShellAt === null ? null : run.pageOneShellAt - run.startedAt,
    pageOneTextBeforeBitmap:
      run.pageOneTextAt !== null &&
      run.pageOneBitmapAt !== null &&
      run.pageOneTextAt <= run.pageOneBitmapAt,
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

function scenarioTiming(instrumentation, startLabel, endLabel = startLabel) {
  const startRun = instrumentation.imports.find(
    (candidate) => candidate.label === startLabel,
  );
  const endRun = instrumentation.imports.find(
    (candidate) => candidate.label === endLabel,
  );
  if (!startRun || !endRun) return null;
  const end = endRun.stoppedAt ?? instrumentation.capturedAt;
  const windowLongTasks = instrumentation.longTasks.filter(
    (entry) => entry.startTime >= startRun.startedAt && entry.startTime <= end,
  );
  return {
    durationMs: end - startRun.startedAt,
    end,
    endLabel,
    maximumWindowLongTaskMs: windowLongTasks.length
      ? Math.max(...windowLongTasks.map((entry) => entry.duration))
      : 0,
    start: startRun.startedAt,
    startLabel,
    windowLongTasks,
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
  const traceTexts = {};
  let activeTraceName = null;
  let traceStarted = false;
  let buildLog = "";
  let consoleEntries = [];
  const phaseLog = [];
  const reportPhase = (phase, details = {}) => {
    const entry = { at: new Date().toISOString(), phase, ...details };
    phaseLog.push(entry);
    process.stdout.write(`[issue-56] ${phase}\n`);
    return entry;
  };
  let browserExit = null;
  const networkState = {
    attachErrors: [],
    failures: [],
    phase: "startup",
    requests: [],
    requestsByKey: new Map(),
    responseFailures: [],
    runtimeExceptions: [],
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
    reportPhase("source-preflight");
    const source = sourceEvidence();
    evidence.source = source;
    if (source.dirty) {
      throw new Error(
        "Issue #56 browser evidence must run from a clean committed source tree.",
      );
    }
    if (!options.appUrl && !options.skipBuild) {
      reportPhase("production-build-start");
      buildLog = await buildProductionApp();
      reportPhase("production-build-complete");
    }
    server = options.appUrl ? null : await startProductionServer();
    const appUrl = options.appUrl ?? server.appUrl;
    const productionMode = options.appUrl ? "external-production-url" : "local-production-build";

    reportPhase("browser-start");
    browser = await startBrowser(options.browser, true);
    browser.child.once("exit", (code, signal) => {
      browserExit = {
        at: new Date().toISOString(),
        code,
        signal,
      };
      reportPhase("browser-exit", browserExit);
    });
    reportPhase("browser-debug-target-ready", { pid: browser.child.pid });
    cdp = await CdpSession.connect(browser.webSocketDebuggerUrl);
    reportPhase("browser-debug-connected");
    consoleEntries = await configurePage(cdp, appUrl, networkState);
    reportPhase("app-shell-ready");
    const browserVersion = await cdp.send("Browser.getVersion");
    const reference = await fileEvidence(options.reference);
    const replacement = await fileEvidence(options.replacement);

    const referenceTitle = path.basename(
      options.reference,
      path.extname(options.reference),
    );
    const replacementTitle = path.basename(
      options.replacement,
      path.extname(options.replacement),
    );

    await startTrace(cdp);
    activeTraceName = "full-import-trace.json";
    traceStarted = true;
    await beginImport(cdp, options.reference, "full", networkState);
    reportPhase("full-import-dispatched");
    const fullInitialControl = await measureSettingsControl(cdp);
    const fullFirstPage = await waitForFirstVisiblePage(
      cdp,
      "full",
      options.timeoutMs,
    );
    reportPhase("full-first-page-visible");
    const fullLibraryAtFirstPaint = await inspectLibrary(cdp);
    await captureScreenshot(
      cdp,
      path.join(options.outputDirectory, "full-first-page.png"),
    );
    await waitForBackgroundPage(cdp, "full", Math.min(options.timeoutMs, 30_000));
    const fullCompletion = await waitForPdfRecord(cdp, {
      description: `all ${options.expectedPages} reference PDF pages and completion metadata`,
      expectedPages: options.expectedPages,
      minimumStoredPages: options.expectedPages,
      onProbe: () => measureSettingsControl(cdp),
      status: "ready",
      timeoutMs: options.timeoutMs,
      title: referenceTitle,
    });
    reportPhase("full-import-complete");
    const fullFinalControl = await measureSettingsControl(cdp);
    await finishInstrumentedImport(cdp, "full", "completed");
    const fullInstrumentation = await captureInstrumentation(cdp);
    await captureScreenshot(
      cdp,
      path.join(options.outputDirectory, "full-complete.png"),
    );
    traceTexts[activeTraceName] = await stopTrace(cdp);
    traceStarted = false;
    activeTraceName = null;

    const fullRecordAtFirstPaint = fullLibraryAtFirstPaint.pdfs.find(
      (document) => document.id === fullCompletion.record.id,
    );
    const fullTrace = traceSummary(
      JSON.parse(traceTexts["full-import-trace.json"]),
      {
        documentId: fullCompletion.record.id,
        endLabel: "full",
        startLabel: "full",
      },
    );
    const fullOrdering = workerOrdering(fullTrace, { requireComplete: true });
    const fullTiming = importTiming(fullInstrumentation, "full");
    const fullScenarioTiming = scenarioTiming(fullInstrumentation, "full");

    const cancellationAppUrl = await navigateToCleanOrigin(
      cdp,
      appUrl,
      networkState,
    );
    reportPhase("cancellation-origin-ready");
    await startTrace(cdp);
    activeTraceName = "cancellation-trace.json";
    traceStarted = true;
    await beginImport(cdp, options.reference, "cancel-large", networkState);
    reportPhase("cancellation-import-dispatched");
    const cancelInitialControl = await measureSettingsControl(cdp);
    const cancelFirstPage = await waitForFirstVisiblePage(
      cdp,
      "cancel-large",
      options.timeoutMs,
    );
    reportPhase("cancellation-first-page-visible");
    const cancelLibraryAtFirstPaint = await inspectLibrary(cdp);
    await captureScreenshot(
      cdp,
      path.join(options.outputDirectory, "cancel-large-first-page.png"),
    );
    await waitForBackgroundPage(
      cdp,
      "cancel-large",
      Math.min(options.timeoutMs, 30_000),
    );
    const cancelPrefix = await waitForPdfRecord(cdp, {
      description: "a durable background-page prefix before cancellation",
      expectedPages: options.expectedPages,
      minimumStoredPages: 2,
      onProbe: () => measureSettingsControl(cdp),
      status: "importing",
      timeoutMs: Math.min(options.timeoutMs, 30_000),
      title: referenceTitle,
    });
    await finishInstrumentedImport(cdp, "cancel-large", "replaced");
    await beginImport(cdp, options.replacement, "replacement", networkState);
    reportPhase("replacement-import-dispatched");
    const canceledLibraryAfterReplacementDispatch = await inspectLibrary(cdp);
    const canceledRecordAfterReplacementDispatch =
      canceledLibraryAfterReplacementDispatch.pdfs.find(
        (document) => document.id === cancelPrefix.record.id,
      );
    const replacementInitialControl = await measureSettingsControl(cdp);
    const replacementFirstPage = await waitForFirstVisiblePage(
      cdp,
      "replacement",
      options.timeoutMs,
    );
    reportPhase("replacement-first-page-visible");
    await markHarness(cdp, "replacement-active");
    const canceledLibraryAfterReplacementStart = await inspectLibrary(cdp);
    const canceledRecordAfterReplacementStart =
      canceledLibraryAfterReplacementStart.pdfs.find(
        (document) => document.id === cancelPrefix.record.id,
      );
    const replacementCompletion = await waitForPdfRecord(cdp, {
      description: "the replacement PDF to complete",
      expectedPages: options.replacementPages,
      minimumStoredPages: options.replacementPages,
      onProbe: () => measureSettingsControl(cdp),
      status: "ready",
      timeoutMs: options.timeoutMs,
      title: replacementTitle,
    });
    reportPhase("replacement-import-complete");
    const replacementFinalControl = await measureSettingsControl(cdp);
    await finishInstrumentedImport(cdp, "replacement", "completed");
    await captureScreenshot(
      cdp,
      path.join(options.outputDirectory, "replacement-complete.png"),
    );
    await delay(1_000);
    const cancellationInstrumentation = await captureInstrumentation(cdp);
    const titleAfterSettling = await evaluate(
      cdp,
      `document.querySelector("h1")?.textContent ?? null`,
    );
    const libraryAfterReplacement = await inspectLibrary(cdp);
    traceTexts[activeTraceName] = await stopTrace(cdp);
    traceStarted = false;
    activeTraceName = null;

    const cancelRecordAtFirstPaint = cancelLibraryAtFirstPaint.pdfs.find(
      (document) => document.id === cancelPrefix.record.id,
    );
    const largeRecordAfterReplacement = libraryAfterReplacement.pdfs.find(
      (document) => document.id === cancelPrefix.record.id,
    );
    const activeRecordAfterReplacement = libraryAfterReplacement.pdfs.find(
      (document) => document.id === libraryAfterReplacement.activeDocumentId,
    );
    const cancellationTrace = traceSummary(
      JSON.parse(traceTexts["cancellation-trace.json"]),
      {
        documentId: cancelPrefix.record.id,
        endLabel: "replacement",
        startLabel: "cancel-large",
      },
    );
    const cancellationOrdering = workerOrdering(cancellationTrace);
    const replacementDispatchedAt = cancellationTrace.harnessMarks.find(
      (mark) => mark.name === "linelight:harness:replacement-dispatched",
    )?.timestampMicroseconds;
    const staleCanceledWorkerMarks = cancellationTrace.pdfMarks.filter(
      (mark) =>
        replacementDispatchedAt !== undefined &&
        mark.timestampMicroseconds > replacementDispatchedAt,
    );
    const cancelTiming = importTiming(cancellationInstrumentation, "cancel-large");
    const replacementTiming = importTiming(
      cancellationInstrumentation,
      "replacement",
    );
    const cancellationScenarioTiming = scenarioTiming(
      cancellationInstrumentation,
      "cancel-large",
      "replacement",
    );
    const importPhases = ["full", "cancel-large", "replacement"];
    const importRequests = networkState.requests.filter((request) =>
      importPhases.includes(request.phase),
    );
    const externalRequests = importRequests.filter((request) =>
      requestIsExternal(
        request,
        request.phase === "full" ? appUrl : cancellationAppUrl,
      ),
    );
    const importNetworkFailures = networkState.failures.filter((failure) =>
      importPhases.includes(failure.phase),
    );
    const importResponseFailures = networkState.responseFailures.filter(
      (failure) => importPhases.includes(failure.phase),
    );
    const importRuntimeExceptions = networkState.runtimeExceptions.filter(
      (exception) => importPhases.includes(exception.phase),
    );
    const runtimeErrors = [
      ...fullInstrumentation.errors,
      ...cancellationInstrumentation.errors,
    ];
    const consoleFailures = consoleEntries.filter(
      (entry) =>
        importPhases.includes(entry.phase) &&
        ["assert", "error"].includes(entry.type),
    );

    const firstPaintRecords = [
      ["full import", fullRecordAtFirstPaint],
      ["cancellation import", cancelRecordAtFirstPaint],
    ];
    for (const [label, record] of firstPaintRecords) {
      if (!record) {
        evidence.failures.push(`The ${label} had no durable first-paint record.`);
      } else if (
        record.pdfImportStatus !== "importing" ||
        record.pdfCompletedPages >= options.expectedPages ||
        record.storedPageCount < 1 ||
        !record.hasSource
      ) {
        evidence.failures.push(
          `The ${label} did not display page one from a durable, incomplete local prefix.`,
        );
      }
    }
    if (
      fullCompletion.record.pdfImportStatus !== "ready" ||
      fullCompletion.record.pdfCompletedPages !== options.expectedPages ||
      fullCompletion.record.pdfPageCount !== options.expectedPages ||
      fullCompletion.record.storedPageCount !== options.expectedPages ||
      fullCompletion.record.outlineItemCount < 1 ||
      fullCompletion.record.wordCount < 1 ||
      fullCompletion.library.activeDocumentId !== fullCompletion.record.id
    ) {
      evidence.failures.push(
        `The full scenario did not complete all ${options.expectedPages} pages with outline and word metadata.`,
      );
    }
    for (const [label, timing] of [
      ["full import", fullTiming],
      ["cancellation import", cancelTiming],
      ["replacement", replacementTiming],
    ]) {
      if (
        !timing?.pageOneTextBeforeBitmap ||
        timing?.pageOneRenderSource !== "worker-bitmap" ||
        timing?.renderFallback !== "false" ||
        timing?.renderFallbackObserved
      ) {
        evidence.failures.push(
          `The ${label} did not display readable page-one text before an actual worker bitmap with fallback disabled.`,
        );
      }
    }
    if (!fullTiming?.firstBitmapBeforeBackgroundDom) {
      evidence.failures.push(
        "The full import's first visible bitmap did not precede background-page DOM.",
      );
    }
    if (!cancelTiming?.firstBitmapBeforeBackgroundDom) {
      evidence.failures.push(
        "The cancellation import's first visible bitmap did not precede background-page DOM.",
      );
    }
    if (
      !fullOrdering.passed ||
      !fullOrdering.completeSeen ||
      !fullOrdering.usesWorkerRaster
    ) {
      evidence.failures.push(
        "The full worker trace did not prove page-one raster settlement before page two and final completion.",
      );
    }
    if (
      !cancellationOrdering.passed ||
      cancellationOrdering.completeSeen ||
      !cancellationOrdering.usesWorkerRaster
    ) {
      evidence.failures.push(
        "The canceled worker trace did not prove page-one ordering followed by cancellation before completion.",
      );
    }
    if (
      replacementDispatchedAt === undefined ||
      staleCanceledWorkerMarks.length > 0
    ) {
      evidence.failures.push(
        "The canceled worker recorded progress after the replacement became active.",
      );
    }
    for (const [label, timing, trace] of [
      ["full import", fullScenarioTiming, fullTrace],
      ["cancellation/replacement", cancellationScenarioTiming, cancellationTrace],
    ]) {
      if (
        !timing ||
        timing.windowLongTasks.some(
          (entry) => entry.duration > MAX_WINDOW_TASK_MS,
        )
      ) {
        evidence.failures.push(
          `A Window Long Task exceeded ${MAX_WINDOW_TASK_MS} ms during the entire ${label} window.`,
        );
      }
      if (
        trace.windowStartMicroseconds === null ||
        trace.windowEndMicroseconds === null ||
        !Number.isFinite(trace.maximumMainThreadTaskMs) ||
        trace.maximumMainThreadTaskMs > MAX_WINDOW_TASK_MS
      ) {
        evidence.failures.push(
          `The raw trace did not prove every renderer-main task stayed within ${MAX_WINDOW_TASK_MS} ms for the entire ${label} window.`,
        );
      }
    }
    const controlProbes = [
      ...(fullTiming?.controls ?? []),
      ...(cancelTiming?.controls ?? []),
      ...(replacementTiming?.controls ?? []),
    ];
    if (
      (fullTiming?.controls.length ?? 0) < 2 ||
      (cancelTiming?.controls.length ?? 0) < 1 ||
      (replacementTiming?.controls.length ?? 0) < 2 ||
      controlProbes.some(
        (control) =>
          control.latencyMs > MAX_CONTROL_LATENCY_MS ||
          control.dispatchLatencyMs > MAX_CONTROL_LATENCY_MS,
      )
    ) {
      evidence.failures.push(
        `Reading settings was not repeatedly responsive within ${MAX_CONTROL_LATENCY_MS} ms across both scenarios.`,
      );
    }
    if (externalRequests.length) {
      evidence.failures.push(
        "The page or an attached worker made an external import request.",
      );
    }
    if (importNetworkFailures.length || importResponseFailures.length) {
      evidence.failures.push(
        "The page or an attached worker recorded a failed import request.",
      );
    }
    if (networkState.attachErrors.length) {
      evidence.failures.push(
        "One or more worker targets could not be fully instrumented.",
      );
    }
    const importNotices = [
      ...fullInstrumentation.notices,
      ...cancellationInstrumentation.notices,
    ].filter((notice) => importPhases.includes(notice.importLabel));
    if (
      importRuntimeExceptions.length ||
      runtimeErrors.length ||
      consoleFailures.length ||
      importNotices.length
    ) {
      evidence.failures.push(
        "The page or an attached worker recorded a runtime exception.",
      );
    }
    if (
      !largeRecordAfterReplacement ||
      !canceledRecordAfterReplacementDispatch ||
      !canceledRecordAfterReplacementStart ||
      largeRecordAfterReplacement.pdfImportStatus !== "importing" ||
      largeRecordAfterReplacement.pdfCompletedPages >= options.expectedPages ||
      largeRecordAfterReplacement.storedPageCount < 2 ||
      !largeRecordAfterReplacement.hasSource ||
      ["pdfCompletedPages", "pdfImportStatus", "pdfRevision", "storedPageCount", "wordCount"]
        .some(
          (field) =>
            largeRecordAfterReplacement[field] !==
              canceledRecordAfterReplacementDispatch[field] ||
            canceledRecordAfterReplacementStart[field] !==
              canceledRecordAfterReplacementDispatch[field],
        )
    ) {
      evidence.failures.push(
        "The canceled large import was not left as a resumable local prefix.",
      );
    }
    if (
      !activeRecordAfterReplacement ||
      activeRecordAfterReplacement.id !== replacementCompletion.record.id ||
      activeRecordAfterReplacement.id === largeRecordAfterReplacement?.id ||
      activeRecordAfterReplacement.pdfImportStatus !== "ready" ||
      activeRecordAfterReplacement.storedPageCount !== options.replacementPages ||
      titleAfterSettling !== activeRecordAfterReplacement.title
    ) {
      evidence.failures.push(
        "Stale large-import work displaced or corrupted the completed active replacement.",
      );
    }

    evidence.passed = evidence.failures.length === 0;
    Object.assign(evidence, {
      app: {
        cancellationUrl: cancellationAppUrl,
        fullImportUrl: appUrl,
        mode: productionMode,
      },
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
        replacement: { ...replacement, expectedPages: options.replacementPages },
      },
      thresholds: {
        maximumControlLatencyMs: MAX_CONTROL_LATENCY_MS,
        maximumWindowTaskMs: MAX_WINDOW_TASK_MS,
      },
      firstPage: {
        cancellation: cancelFirstPage,
        cancellationLibraryAtFirstPaint: cancelLibraryAtFirstPaint,
        full: fullFirstPage,
        fullLibraryAtFirstPaint,
        replacement: replacementFirstPage,
      },
      timings: {
        cancellation: cancelTiming,
        cancellationScenario: cancellationScenarioTiming,
        full: fullTiming,
        fullScenario: fullScenarioTiming,
        replacement: replacementTiming,
      },
      controls: {
        cancelInitial: cancelInitialControl,
        fullFinal: fullFinalControl,
        fullInitial: fullInitialControl,
        probes: controlProbes,
        replacementFinal: replacementFinalControl,
        replacementInitial: replacementInitialControl,
      },
      ordering: {
        cancellation: cancellationOrdering,
        full: fullOrdering,
      },
      fullImport: {
        completion: fullCompletion,
      },
      cancellation: {
        activeRecordAfterReplacement,
        canceledRecordAfterReplacementDispatch,
        canceledRecordAfterReplacementStart,
        durablePrefixBeforeReplacement: cancelPrefix,
        largeRecordAfterReplacement,
        libraryAfterReplacement,
        replacementDispatchedAt,
        staleCanceledWorkerMarks,
        titleAfterSettling,
      },
      network: {
        attachErrors: networkState.attachErrors,
        attachedTargets: networkState.targets,
        externalRequests,
        importFailures: importNetworkFailures,
        importRequests,
        responseFailures: importResponseFailures,
      },
      traces: {
        cancellation: {
          file: "cancellation-trace.json",
          ...cancellationTrace,
        },
        full: { file: "full-import-trace.json", ...fullTrace },
      },
      browserDiagnostics: {
        browserExit,
        cdpCommands: cdp.commandLog,
        cdpConnectionEvents: cdp.connectionEvents,
        consoleEntries,
        consoleFailures,
        errors: runtimeErrors,
        notices: importNotices,
        runtimeExceptions: importRuntimeExceptions,
        browserStderr: browser.log(),
        productionBuildLog: buildLog,
        productionServerLog: server?.log() ?? null,
        phaseLog,
      },
      artifacts: {
        cancellationFirstPageScreenshot: "cancel-large-first-page.png",
        cancellationTrace: "cancellation-trace.json",
        fullCompleteScreenshot: "full-complete.png",
        fullFirstPageScreenshot: "full-first-page.png",
        fullTrace: "full-import-trace.json",
        replacementCompleteScreenshot: "replacement-complete.png",
      },
    });
  } catch (error) {
    reportPhase("run-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    evidence.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
    let diagnosticsAvailable = Boolean(
      cdp?.isUsable() &&
      !browserExit &&
      browser?.child.exitCode === null &&
      browser?.child.signalCode === null,
    );
    const diagnosticFailure = (label, diagnosticError) => {
      diagnosticsAvailable = false;
      evidence.failureDiagnostics ??= {};
      evidence.failureDiagnostics[label] = {
        error: diagnosticError instanceof Error
          ? diagnosticError.stack ?? diagnosticError.message
          : String(diagnosticError),
      };
      reportPhase("failure-diagnostic-failed", { label });
    };
    if (diagnosticsAvailable) {
      reportPhase("failure-diagnostics-start");
      try {
        evidence.failureState = await evaluate(
          cdp,
          `({
          instrumentation: globalThis.__lineLightIssue56 ? {
            errors: globalThis.__lineLightIssue56.errors.slice(),
            imports: globalThis.__lineLightIssue56.imports.map((run) => ({ ...run })),
            longTasks: globalThis.__lineLightIssue56.longTasks.map((task) => ({ ...task })),
            notices: globalThis.__lineLightIssue56.notices.map((notice) => ({ ...notice })),
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
        );
      } catch (diagnosticError) {
        diagnosticFailure("page-state", diagnosticError);
      }
      if (diagnosticsAvailable) {
        try {
          evidence.failureLibrary = await inspectLibrary(cdp);
        } catch (diagnosticError) {
          diagnosticFailure("library", diagnosticError);
        }
      }
      if (diagnosticsAvailable) {
        try {
          await captureScreenshot(
            cdp,
            path.join(options.outputDirectory, "failure.png"),
          );
        } catch (diagnosticError) {
          diagnosticFailure("screenshot", diagnosticError);
        }
      }
      if (traceStarted && diagnosticsAvailable) {
        const failedTraceName = activeTraceName ?? "failure-trace.json";
        try {
          traceTexts[failedTraceName] = await stopTrace(cdp);
        } catch (diagnosticError) {
          diagnosticFailure("trace", diagnosticError);
        }
      }
    } else {
      evidence.failureDiagnostics = {
        skipped: "The browser or debugging connection was already closed.",
      };
    }
    if (traceStarted) {
      traceStarted = false;
      activeTraceName = null;
    }
    evidence.browserDiagnostics = {
      browserExit,
      cdpCommands: cdp?.commandLog ?? [],
      cdpConnectionEvents: cdp?.connectionEvents ?? [],
      consoleEntries,
      networkFailures: networkState.failures,
      responseFailures: networkState.responseFailures,
      runtimeExceptions: networkState.runtimeExceptions,
      browserStderr: browser?.log() ?? null,
      productionBuildLog: buildLog,
      productionServerLog: server?.log() ?? null,
      phaseLog,
    };
  } finally {
    reportPhase("teardown-start");
    const shutdownResults = await Promise.allSettled([
      cdp?.close() ?? Promise.resolve(true),
      stopOwnedProcess(
        browser?.child,
        browser?.processGroupId,
        "browser",
      ),
      stopOwnedProcess(
        server?.child,
        server?.processGroupId,
        "production-server",
      ),
    ]);
    const [cdpShutdown, browserShutdown, serverShutdown] = shutdownResults;
    const recordTeardownFailure = (message) => {
      evidence.passed = false;
      evidence.failures.push(`Teardown evidence failure: ${message}`);
    };
    if (cdpShutdown.status === "rejected") {
      recordTeardownFailure(`CDP close failed: ${String(cdpShutdown.reason)}`);
    } else if (!cdpShutdown.value) {
      recordTeardownFailure("CDP close was not observed within the deadline.");
    }
    for (const result of [browserShutdown, serverShutdown]) {
      if (result.status === "rejected") {
        recordTeardownFailure(String(result.reason));
      } else if (!result.value.closed) {
        recordTeardownFailure(
          `${result.value.label} did not close after bounded SIGTERM/SIGKILL.`,
        );
      }
    }
    if (!browserExit && browser?.child) {
      const status = processStatus(browser.child);
      if (status.exited) {
        browserExit = {
          at: new Date().toISOString(),
          code: status.code,
          observedDuringTeardown: true,
          signal: status.signal,
        };
        reportPhase("browser-exit-observed", browserExit);
      }
    }
    if (browser?.profileDirectory) {
      try {
        await rm(browser.profileDirectory, { recursive: true, force: true });
      } catch (error) {
        recordTeardownFailure(
          `Could not remove the browser profile: ${String(error)}`,
        );
      }
    }
    reportPhase("teardown-complete", {
      browserClosed:
        browserShutdown.status === "fulfilled" && browserShutdown.value.closed,
      cdpClosed: cdpShutdown.status === "fulfilled" && cdpShutdown.value,
      serverClosed:
        serverShutdown.status === "fulfilled" && serverShutdown.value.closed,
    });
    evidence.browserDiagnostics = {
      ...(evidence.browserDiagnostics ?? {}),
      browserExit,
      browserStderr: browser?.log() ?? null,
      cdpCommands: cdp?.commandLog ?? [],
      cdpConnectionEvents: cdp?.connectionEvents ?? [],
      phaseLog,
      processShutdown: {
        browser: browserShutdown.status === "fulfilled"
          ? browserShutdown.value
          : { error: String(browserShutdown.reason) },
        cdp: cdpShutdown.status === "fulfilled"
          ? { closed: cdpShutdown.value }
          : { error: String(cdpShutdown.reason) },
        productionServer: serverShutdown.status === "fulfilled"
          ? serverShutdown.value
          : { error: String(serverShutdown.reason) },
      },
      productionServerLog: server?.log() ?? null,
    };
    for (const [fileName, traceText] of Object.entries(traceTexts)) {
      if (!traceText) continue;
      await writeFile(
        path.join(options.outputDirectory, fileName),
        traceText,
      );
    }
    await writeFile(
      path.join(options.outputDirectory, "pdf-worker-browser.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }

  if (!evidence.passed) {
    throw new Error(evidence.failures.join("\n"));
  }
  process.stdout.write(
    `${JSON.stringify({
      evidence: path.join(options.outputDirectory, "pdf-worker-browser.json"),
      firstPageMs: evidence.timings.full.importToFirstBitmapMs,
      maximumWindowTaskMs: Math.max(
        evidence.timings.fullScenario.maximumWindowLongTaskMs,
        evidence.timings.cancellationScenario.maximumWindowLongTaskMs,
      ),
      passed: true,
      traces: ["full-import-trace.json", "cancellation-trace.json"].map(
        (fileName) => path.join(options.outputDirectory, fileName),
      ),
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
