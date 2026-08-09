#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_PDF_HIGHLIGHT_FIXTURE,
  PDF_HIGHLIGHT_FIXTURE_EXPECTATIONS,
  writePdfHighlightFixture,
} from "./generate-pdf-highlight-fixture.mjs";
import { validateOfflineNaturalTimingEvidence } from "./run-offline-natural-timing-regression.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_OUTPUT_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "outputs/pdf-highlight-browser",
);
const RECORDED_EVIDENCE_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "docs/evidence/issue-60",
);
const MAX_GLYPH_EDGE_ERROR_CSS_PX = 2;
const MAX_LONG_TASK_MS = 50;
const MATRIX = Object.freeze([
  {
    id: "zoom-100-dpr-1",
    width: 1100,
    height: 900,
    pageScaleFactor: 1,
    deviceScaleFactor: 1,
  },
  {
    id: "zoom-125-dpr-1",
    width: 1440,
    height: 1000,
    pageScaleFactor: 1.25,
    deviceScaleFactor: 1,
  },
  {
    id: "zoom-100-dpr-2",
    width: 1440,
    height: 1000,
    pageScaleFactor: 1,
    deviceScaleFactor: 2,
  },
]);

function parseArguments(argv) {
  const options = {
    appUrl: null,
    browser: process.env.LINELIGHT_BROWSER ?? "/usr/bin/brave-browser",
    fixture: DEFAULT_PDF_HIGHLIGHT_FIXTURE,
    headed: false,
    outputDirectory: DEFAULT_OUTPUT_DIRECTORY,
    record: false,
    offlineNaturalEvidence: null,
    offlineNaturalBlocked: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--headed") options.headed = true;
    else if (argument === "--record") options.record = true;
    else if (argument === "--url") options.appUrl = argv[++index];
    else if (argument === "--browser") options.browser = argv[++index];
    else if (argument === "--fixture") options.fixture = argv[++index];
    else if (argument === "--output") options.outputDirectory = argv[++index];
    else if (argument === "--offline-natural-evidence") {
      options.offlineNaturalEvidence = argv[++index];
    }
    else if (argument === "--offline-natural-blocked") {
      options.offlineNaturalBlocked = argv[++index];
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        [
          "Usage: node scripts/run-pdf-highlight-browser-regression.mjs [options]",
          "",
          "Options:",
          "  --url URL       Use an already-running LineLight app instead of starting Vite.",
          "  --browser PATH  Brave/Chromium executable (default: /usr/bin/brave-browser).",
          "  --headed        Show the browser; the default still uses full Chromium headless.",
          "  --fixture PATH  Override the deterministic generated PDF fixture.",
          "  --output DIR    Write transient JSON and screenshots here.",
          "  --record        Write review evidence to docs/evidence/issue-60/.",
          "  --offline-natural-evidence PATH",
          "                  Link a passing real Offline-natural timing record.",
          "  --offline-natural-blocked MESSAGE",
          "                  Record an observed narration blocker without inventing rate data.",
          "",
        ].join("\n"),
      );
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.record) options.outputDirectory = RECORDED_EVIDENCE_DIRECTORY;
  if (options.offlineNaturalEvidence && options.offlineNaturalBlocked) {
    throw new Error(
      "Use either --offline-natural-evidence or --offline-natural-blocked, not both.",
    );
  }
  options.fixture = path.resolve(options.fixture);
  options.outputDirectory = path.resolve(options.outputDirectory);
  if (options.offlineNaturalEvidence) {
    options.offlineNaturalEvidence = path.resolve(
      options.offlineNaturalEvidence,
    );
  }
  return options;
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

export function terminateProcessGroup(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function waitForHttp(url, processHandle, log, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (processHandle?.exitCode !== null) {
      throw new Error(
        `The development server stopped before ${url} was ready.\n${log()}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The local listener is still starting.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}.\n${log()}`);
}

export async function startDevelopmentServer() {
  const port = await getFreePort();
  const output = [];
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: REPOSITORY_ROOT,
      detached: true,
      env: { ...process.env, BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const collect = (chunk) => {
    output.push(chunk.toString());
    if (output.length > 80) output.shift();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const appUrl = `http://127.0.0.1:${port}/`;
  await waitForHttp(appUrl, child, () => output.join(""));
  return { appUrl, child, log: () => output.join("") };
}

async function pollJson(url, processHandle, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (processHandle?.exitCode !== null) {
      throw new Error("The browser stopped before its debugging endpoint opened.");
    }
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // The debugging endpoint is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

export async function startBrowser(executable, headed) {
  await access(executable);
  const debuggingPort = await getFreePort();
  const profileDirectory = await mkdtemp(
    path.join(os.tmpdir(), "linelight-pdf-highlight-browser-"),
  );
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
    "--metrics-recording-only",
    "--password-store=basic",
    "--use-mock-keychain",
    ...(headed ? [] : ["--headless=new", "--hide-scrollbars"]),
    "about:blank",
  ];
  const child = spawn(executable, arguments_, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const browserErrors = [];
  child.stderr.on("data", (chunk) => {
    browserErrors.push(chunk.toString());
    if (browserErrors.length > 80) browserErrors.shift();
  });
  const targets = await pollJson(
    `http://127.0.0.1:${debuggingPort}/json/list`,
    child,
  );
  const pageTarget = targets.find(
    (target) => target.type === "page" && target.webSocketDebuggerUrl,
  );
  if (!pageTarget) {
    throw new Error(`Brave did not expose a page target.\n${browserErrors.join("")}`);
  }
  return {
    child,
    profileDirectory,
    webSocketDebuggerUrl: pageTarget.webSocketDebuggerUrl,
    log: () => browserErrors.join(""),
  };
}

export class CdpSession {
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

export async function evaluate(cdp, expression) {
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

export async function waitForExpression(
  cdp,
  expression,
  description,
  timeoutMs = 30_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await evaluate(cdp, expression);
      if (value) return value;
    } catch {
      // React may be replacing the queried subtree while it settles.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

export async function waitForRenderedWindowStable(cdp, timeoutMs = 10_000) {
  const startedAt = Date.now();
  let previous = null;
  let stableSamples = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await evaluate(
      cdp,
      `JSON.stringify({
        shells: Array.from(document.querySelectorAll('.pdf-page-block')).map((shell) => ({
          page: shell.dataset.pdfPageIndex,
          rendered: shell.dataset.pdfPageRendered,
          renders: shell.dataset.pdfShellRenderCount
        })),
        loading: document.querySelectorAll('.pdf-page-loading').length
      })`,
    );
    if (snapshot === previous) stableSamples += 1;
    else stableSamples = 0;
    if (stableSamples >= 2) return;
    previous = snapshot;
    await delay(100);
  }
  throw new Error("The virtualized PDF render window did not settle.");
}

export async function configurePage(cdp, appUrl) {
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
    cdp.send("Network.enable"),
    cdp.send("Performance.enable"),
  ]);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      localStorage.setItem("guided-reader-settings", JSON.stringify({
        narrationEngine: "device",
        narrationPreferenceVersion: 1,
        highlightScope: "sentence",
        follow: false
      }));
      globalThis.__lineLightPdfRegression = {
        errors: [],
        longTasks: []
      };
      addEventListener("error", (event) => {
        globalThis.__lineLightPdfRegression.errors.push(
          event.error?.stack || event.message || "window error"
        );
      });
      addEventListener("unhandledrejection", (event) => {
        globalThis.__lineLightPdfRegression.errors.push(
          event.reason?.stack || String(event.reason)
        );
      });
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            globalThis.__lineLightPdfRegression.longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
              name: entry.name
            });
          }
        }).observe({ type: "longtask", buffered: true });
      } catch (error) {
        globalThis.__lineLightPdfRegression.errors.push(
          "Long Task observer unavailable: " + error.message
        );
      }
    `,
  });
  await cdp.send("Page.navigate", { url: appUrl });
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector(".import-button"))`,
    "the LineLight reader shell",
  );
  return consoleEntries;
}

export async function importFixture(cdp, fixture) {
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
    `Boolean(document.querySelector('.pdf-page-view')) &&
      document.querySelectorAll('#pdf-page-1 .pdf-word-overlay').length >= 20`,
    "the measured first PDF page",
    60_000,
  );
  await evaluate(
    cdp,
    `document.querySelector('.notice button[aria-label="Dismiss message"]')?.click(); true`,
  );
  await delay(300);
}

function pageReadyExpression(pageNumber, word) {
  return `(() => {
    const page = document.querySelector('#pdf-page-${pageNumber}');
    if (!page) return false;
    page.scrollIntoView({ block: 'center', behavior: 'auto' });
    return Array.from(page.querySelectorAll('.pdf-word-overlay'))
      .some((element) => element.getAttribute('aria-label') === ${JSON.stringify(word)});
  })()`;
}

export async function showPage(cdp, pageNumber, word) {
  await evaluate(
    cdp,
    `document.querySelector('#pdf-page-${pageNumber}')?.scrollIntoView({ block: 'center', behavior: 'auto' }); true`,
  );
  await waitForExpression(
    cdp,
    pageReadyExpression(pageNumber, word),
    `page ${pageNumber} word ${word}`,
  );
  await evaluate(
    cdp,
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  );
  await waitForRenderedWindowStable(cdp);
}

const MEASURE_PAGE_EXPRESSION = (pageNumber) => `(() => {
  const page = document.querySelector('#pdf-page-${pageNumber}');
  if (!page) return { pageNumber: ${pageNumber}, measured: 0, failures: [{ reason: 'missing page' }] };
  const measurements = [];
  for (const overlay of page.querySelectorAll('.pdf-word-overlay')) {
    const textDivIndex = overlay.dataset.pdfTextDiv;
    const textDiv = page.querySelector(
      '.pdf-text-content [data-pdf-text-div="' + textDivIndex + '"]'
    );
    const textNode = textDiv?.firstChild;
    const start = Number(overlay.dataset.pdfTextStart);
    const end = Number(overlay.dataset.pdfTextEnd);
    if (!(textNode instanceof Text) || !Number.isInteger(start) || !Number.isInteger(end)) {
      measurements.push({ label: overlay.getAttribute('aria-label'), error: null, reason: 'missing source range' });
      continue;
    }
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const overlayRect = overlay.getBoundingClientRect();
    const sourceRects = Array.from(range.getClientRects());
    range.detach();
    const errors = sourceRects.map((sourceRect) => Math.max(
      Math.abs(overlayRect.left - sourceRect.left),
      Math.abs(overlayRect.top - sourceRect.top),
      Math.abs(overlayRect.right - sourceRect.right),
      Math.abs(overlayRect.bottom - sourceRect.bottom)
    ));
    measurements.push({
      label: overlay.getAttribute('aria-label'),
      error: errors.length ? Math.min(...errors) : null,
      overlay: {
        left: overlayRect.left,
        top: overlayRect.top,
        width: overlayRect.width,
        height: overlayRect.height
      }
    });
  }
  const numeric = measurements.filter((measurement) => Number.isFinite(measurement.error));
  return {
    pageNumber: ${pageNumber},
    pageWidthCssPx: page.querySelector('.pdf-page')?.getBoundingClientRect().width ?? null,
    measured: numeric.length,
    overlayCount: measurements.length,
    maximumEdgeErrorCssPx: numeric.length ? Math.max(...numeric.map((measurement) => measurement.error)) : null,
    meanEdgeErrorCssPx: numeric.length
      ? numeric.reduce((total, measurement) => total + measurement.error, 0) / numeric.length
      : null,
    failures: measurements
      .filter((measurement) => !Number.isFinite(measurement.error) || measurement.error > ${MAX_GLYPH_EDGE_ERROR_CSS_PX})
      .map((measurement) => ({ label: measurement.label, error: measurement.error, reason: measurement.reason }))
  };
})()`;

async function collectScenarioEvidence(cdp) {
  await showPage(cdp, 1, "like");
  const reportedPassage = await evaluate(
    cdp,
    `(async () => {
      const page = document.querySelector('#pdf-page-1');
      const word = Array.from(page.querySelectorAll('.pdf-word-overlay'))
        .find((element) => element.getAttribute('aria-label') === 'like');
      word.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const lines = Array.from(page.querySelectorAll('.pdf-sentence-overlay.scope-active'))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width };
        })
        .sort((a, b) => a.top - b.top || a.left - b.left);
      const leave = Array.from(page.querySelectorAll('.pdf-word-overlay'))
        .find((element) => element.getAttribute('aria-label') === 'leave');
      let punctuationRightEdgeErrorCssPx = null;
      if (leave) {
        const textDiv = page.querySelector(
          '.pdf-text-content [data-pdf-text-div="' + leave.dataset.pdfTextDiv + '"]'
        );
        if (textDiv?.firstChild instanceof Text) {
          const range = document.createRange();
          range.setStart(textDiv.firstChild, Number(leave.dataset.pdfTextStart));
          range.setEnd(textDiv.firstChild, textDiv.firstChild.length);
          const punctuationRect = Array.from(range.getClientRects()).at(-1);
          range.detach();
          const line = lines.find((candidate) =>
            punctuationRect && candidate.top < punctuationRect.bottom && candidate.bottom > punctuationRect.top
          );
          if (line && punctuationRect) {
            punctuationRightEdgeErrorCssPx = Math.abs(line.right - punctuationRect.right);
          }
        }
      }
      return {
        sentenceLineCount: lines.length,
        sentenceLines: lines,
        punctuationRightEdgeErrorCssPx,
        continuous: lines.length === 3 && lines.every((line) => line.width > 250)
      };
    })()`,
  );

  const dehyphenation = await evaluate(
    cdp,
    `(async () => {
      const page = document.querySelector('#pdf-page-1');
      const fragments = ['extraordi', 'nary'].map((label) =>
        Array.from(page.querySelectorAll('.pdf-word-overlay'))
          .find((element) => element.getAttribute('aria-label') === label)
      );
      const indices = fragments.map((element) => element?.dataset.pdfWord ?? null);
      fragments[0]?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        fragmentIndices: indices,
        sameLogicalWord: Boolean(indices[0] && indices[0] === indices[1]),
        bothFragmentsActive:
          document.querySelectorAll('[data-active-token="true"]').length === 1 &&
          fragments.some((element) => element?.dataset.activeToken === 'true') &&
          page.querySelectorAll('.pdf-sentence-overlay.scope-active').length > 0
      };
    })()`,
  );

  await showPage(cdp, 2, "Serif");
  const fontsAndLigature = await evaluate(
    cdp,
    `(() => {
      const page = document.querySelector('#pdf-page-2');
      const inspect = (label) => {
        const overlay = Array.from(page.querySelectorAll('.pdf-word-overlay'))
          .find((element) => element.getAttribute('aria-label') === label);
        const textDiv = overlay && page.querySelector(
          '.pdf-text-content [data-pdf-text-div="' + overlay.dataset.pdfTextDiv + '"]'
        );
        return {
          label,
          found: Boolean(overlay),
          fontFamily: textDiv ? getComputedStyle(textDiv).fontFamily : null,
          sourceLength: overlay
            ? Number(overlay.dataset.pdfTextEnd) - Number(overlay.dataset.pdfTextStart)
            : null
        };
      };
      const words = ['Serif', 'sans', 'monospace'].map(inspect);
      const ligature = inspect('fi');
      return {
        words,
        distinctFontFamilies: new Set(words.map((word) => word.fontFamily).filter(Boolean)).size,
        ligature,
        passed: words.every((word) => word.found) &&
          new Set(words.map((word) => word.fontFamily).filter(Boolean)).size >= 3 &&
          ligature.found && ligature.sourceLength === 2
      };
    })()`,
  );

  await showPage(cdp, 3, "Rotated");
  const rotatedAndColumns = await evaluate(
    cdp,
    `(async () => {
      const page = document.querySelector('#pdf-page-3');
      const findWord = (label) => Array.from(page.querySelectorAll('.pdf-word-overlay'))
        .find((element) => element.getAttribute('aria-label') === label);
      const rotated = findWord('aligned');
      const rotatedRect = rotated?.getBoundingClientRect();
      const left = findWord('Left');
      const right = findWord('Right');
      left?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const leftRect = left?.getBoundingClientRect();
      const rightRect = right?.getBoundingClientRect();
      const rowLines = Array.from(page.querySelectorAll('.pdf-sentence-overlay.scope-active'))
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => leftRect && rect.top < leftRect.bottom && rect.bottom > leftRect.top)
        .sort((a, b) => a.left - b.left);
      return {
        rotated: rotatedRect ? {
          width: rotatedRect.width,
          height: rotatedRect.height,
          vertical: rotatedRect.height > rotatedRect.width
        } : null,
        columns: leftRect && rightRect ? {
          leftWordX: leftRect.left,
          rightWordX: rightRect.left,
          wordGapCssPx: rightRect.left - leftRect.right,
          activeSentenceLineCountOnRow: rowLines.length,
          highlightGapCssPx: rowLines.length >= 2 ? rowLines[1].left - rowLines[0].right : null,
          separated: rowLines.length === 2 && rowLines[1].left - rowLines[0].right > 20
        } : null
      };
    })()`,
  );

  return { reportedPassage, dehyphenation, fontsAndLigature, rotatedAndColumns };
}

async function collectSamePageMutationEvidence(cdp) {
  await showPage(cdp, 1, "like");
  await evaluate(
    cdp,
    `(async () => {
      Array.from(document.querySelectorAll('#pdf-page-1 .pdf-word-overlay'))
        .find((element) => element.getAttribute('aria-label') === 'like')?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })()`,
  );
  await waitForRenderedWindowStable(cdp);
  return evaluate(
    cdp,
    `(async () => {
      const page = document.querySelector('#pdf-page-1');
      const words = ['like', 'my', 'friend', 'Tiarnán', 'de', 'Burca’s', 'definition', 'of'];
      const findWord = (label) => Array.from(page.querySelectorAll('.pdf-word-overlay'))
        .find((element) => element.getAttribute('aria-label') === label);
      findWord(words[0])?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const pages = document.querySelector('.pdf-pages');
      const shellSnapshot = Array.from(document.querySelectorAll('.pdf-page-block'));
      const shellRenderCountsBefore = shellSnapshot.map((shell) => Number(shell.dataset.pdfShellRenderCount));
      const renderedWindowBefore = shellSnapshot
        .filter((shell) => shell.dataset.pdfPageRendered === 'true')
        .map((shell) => Number(shell.dataset.pdfPageIndex));
      const mapRenderCountBefore = Number(pages.dataset.pdfShellMapRenderCount);
      const mutations = { classAttributes: 0, childList: 0, addedNodes: 0, removedNodes: 0 };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') mutations.classAttributes += 1;
          if (record.type === 'childList') {
            mutations.childList += 1;
            mutations.addedNodes += record.addedNodes.length;
            mutations.removedNodes += record.removedNodes.length;
          }
        }
      });
      observer.observe(pages, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      const startedAt = performance.now();
      const frameLatenciesMs = [];
      for (const label of words.slice(1)) {
        const word = findWord(label);
        if (!word) throw new Error('Missing same-page fixture word: ' + label);
        const transitionStartedAt = performance.now();
        word.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        frameLatenciesMs.push(performance.now() - transitionStartedAt);
      }
      observer.disconnect();
      const currentShells = Array.from(document.querySelectorAll('.pdf-page-block'));
      const shellRenderCountsAfter = currentShells.map((shell) => Number(shell.dataset.pdfShellRenderCount));
      const renderedWindowAfter = currentShells
        .filter((shell) => shell.dataset.pdfPageRendered === 'true')
        .map((shell) => Number(shell.dataset.pdfPageIndex));
      const longTasks = globalThis.__lineLightPdfRegression.longTasks
        .filter((entry) => entry.startTime >= startedAt);
      return {
        transitions: words.length - 1,
        frameLatenciesMs,
        maximumTwoFrameLatencyMs: Math.max(...frameLatenciesMs),
        meanTwoFrameLatencyMs: frameLatenciesMs.reduce((sum, value) => sum + value, 0) / frameLatenciesMs.length,
        mutations,
        shellCountBefore: shellSnapshot.length,
        shellCountAfter: currentShells.length,
        mapRenderCountBefore,
        mapRenderCountAfter: Number(pages.dataset.pdfShellMapRenderCount),
        shellRenderCountsBefore,
        shellRenderCountsAfter,
        changedShellRenderCounts: shellRenderCountsAfter
          .map((value, index) => ({
            pageIndex: index,
            before: shellRenderCountsBefore[index],
            after: value,
            delta: value - shellRenderCountsBefore[index]
          }))
          .filter((entry) => entry.delta !== 0),
        renderedWindowBefore,
        renderedWindowAfter,
        shellIdentityPreserved: shellSnapshot.length === currentShells.length &&
          shellSnapshot.every((shell, index) => shell === currentShells[index]),
        longTasks
      };
    })()`,
  );
}

async function collectPageBoundaryEvidence(cdp) {
  await showPage(cdp, 1, "like");
  return evaluate(
    cdp,
    `(async () => {
      const targets = [[1, 'like'], [2, 'Serif'], [6, 'Far'], [1, 'like']];
      const pages = document.querySelector('.pdf-pages');
      const shellSnapshot = Array.from(document.querySelectorAll('.pdf-page-block'));
      const shellRenderCountsBefore = shellSnapshot.map((shell) => Number(shell.dataset.pdfShellRenderCount));
      const renderedWindowBefore = shellSnapshot
        .filter((shell) => shell.dataset.pdfPageRendered === 'true')
        .map((shell) => Number(shell.dataset.pdfPageIndex));
      const mapRenderCountBefore = Number(pages.dataset.pdfShellMapRenderCount);
      const mutations = {
        directChildList: 0,
        descendantChildList: 0,
        classAttributes: 0,
        addedNodes: 0,
        removedNodes: 0
      };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') mutations.classAttributes += 1;
          if (record.type === 'childList') {
            if (record.target === pages) mutations.directChildList += 1;
            else mutations.descendantChildList += 1;
            mutations.addedNodes += record.addedNodes.length;
            mutations.removedNodes += record.removedNodes.length;
          }
        }
      });
      observer.observe(pages, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      const startedAt = performance.now();
      const visited = [];
      for (const [pageNumber, label] of targets) {
        const page = document.querySelector('#pdf-page-' + pageNumber);
        page.scrollIntoView({ block: 'center', behavior: 'auto' });
        let word = null;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          word = Array.from(page.querySelectorAll('.pdf-word-overlay'))
            .find((element) => element.getAttribute('aria-label') === label);
          if (word) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!word) throw new Error('Page ' + pageNumber + ' did not render word ' + label);
        word.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        visited.push({
          pageNumber,
          label,
          activeWord: word.dataset.pdfWord,
          mapRenderCount: Number(pages.dataset.pdfShellMapRenderCount),
          renderedWindow: Array.from(document.querySelectorAll('.pdf-page-block'))
            .filter((shell) => shell.dataset.pdfPageRendered === 'true')
            .map((shell) => Number(shell.dataset.pdfPageIndex)),
          shellRenderCounts: Array.from(document.querySelectorAll('.pdf-page-block'))
            .map((shell) => Number(shell.dataset.pdfShellRenderCount))
        });
      }
      observer.disconnect();
      const currentShells = Array.from(document.querySelectorAll('.pdf-page-block'));
      const shellRenderCountsAfter = currentShells.map((shell) => Number(shell.dataset.pdfShellRenderCount));
      const renderedWindowAfter = currentShells
        .filter((shell) => shell.dataset.pdfPageRendered === 'true')
        .map((shell) => Number(shell.dataset.pdfPageIndex));
      return {
        visited,
        shellCountBefore: shellSnapshot.length,
        shellCountAfter: currentShells.length,
        mapRenderCountBefore,
        mapRenderCountAfter: Number(pages.dataset.pdfShellMapRenderCount),
        shellRenderCountsBefore,
        shellRenderCountsAfter,
        changedShellRenderCounts: shellRenderCountsAfter
          .map((value, index) => ({
            pageIndex: index,
            before: shellRenderCountsBefore[index],
            after: value,
            delta: value - shellRenderCountsBefore[index]
          }))
          .filter((entry) => entry.delta !== 0),
        renderedWindowBefore,
        renderedWindowAfter,
        renderedWindowAdded: renderedWindowAfter.filter((index) => !renderedWindowBefore.includes(index)),
        renderedWindowRemoved: renderedWindowBefore.filter((index) => !renderedWindowAfter.includes(index)),
        shellIdentityPreserved: shellSnapshot.length === currentShells.length &&
          shellSnapshot.every((shell, index) => shell === currentShells[index]),
        mutations,
        longTasks: globalThis.__lineLightPdfRegression.longTasks
          .filter((entry) => entry.startTime >= startedAt)
      };
    })()`,
  );
}

async function collectLegacyMigrationEvidence(cdp) {
  const downgraded = await evaluate(
    cdp,
    `(async () => {
      const open = indexedDB.open('guided-reader-library', 3);
      const database = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const read = database.transaction('documents', 'readonly');
      const request = read.objectStore('documents').getAll();
      const documents = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const document = documents.find((candidate) =>
        candidate?.kind === 'pdf' && candidate?.title === 'issue-60-geometry'
      );
      if (!document) throw new Error('The imported fixture record was not found.');
      const legacy = structuredClone(document);
      delete legacy.pdfTextModelVersion;
      let removedWordIndexArrays = 0;
      for (const page of legacy.pdfPages ?? []) {
        for (const item of page.items ?? []) {
          if (Array.isArray(item.wordIndices)) removedWordIndexArrays += 1;
          delete item.wordIndices;
        }
      }
      const write = database.transaction('documents', 'readwrite');
      write.objectStore('documents').put(legacy, legacy.id);
      await new Promise((resolve, reject) => {
        write.oncomplete = resolve;
        write.onerror = () => reject(write.error);
        write.onabort = () => reject(write.error);
      });
      database.close();
      return {
        documentId: legacy.id,
        removedVersion: document.pdfTextModelVersion,
        removedWordIndexArrays
      };
    })()`,
  );

  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector('.pdf-page-view')) &&
      document.querySelectorAll('.pdf-page-block').length === 6 &&
      Array.from(document.querySelectorAll('#pdf-page-1 .pdf-word-overlay'))
        .some((element) => element.getAttribute('aria-label') === 'extraordi')`,
    "the migrated stored PDF fixture",
    60_000,
  );
  await showPage(cdp, 1, "extraordi");

  return evaluate(
    cdp,
    `(async () => {
      const open = indexedDB.open('guided-reader-library', 3);
      const database = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const read = database.transaction('documents', 'readonly');
      const request = read.objectStore('documents').get(${JSON.stringify(downgraded.documentId)});
      const storedDocument = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      const page = storedDocument.pdfPages?.[0];
      const first = page?.items?.find((item) => item.text.includes('extraordi'));
      const second = page?.items?.find((item) => item.text.startsWith('nary'));
      const firstIndex = first?.wordIndices?.at(-1) ?? null;
      const secondIndex = second?.wordIndices?.[0] ?? null;
      const renderedFragments = ['extraordi', 'nary'].map((label) =>
        Array.from(document.querySelectorAll('#pdf-page-1 .pdf-word-overlay'))
          .find((element) => element.getAttribute('aria-label') === label)
          ?.dataset.pdfWord ?? null
      );
      return {
        downgraded: ${JSON.stringify(downgraded)},
        restoredVersion: storedDocument.pdfTextModelVersion ?? null,
        restoredWordIndexArrays: storedDocument.pdfPages
          .flatMap((candidate) => candidate.items)
          .filter((item) => Array.isArray(item.wordIndices)).length,
        storedFragmentIndices: [firstIndex, secondIndex],
        renderedFragmentIndices: renderedFragments,
        passed: storedDocument.pdfTextModelVersion === 1 &&
          firstIndex !== null && firstIndex === secondIndex &&
          renderedFragments[0] !== null && renderedFragments[0] === renderedFragments[1]
      };
    })()`,
  );
}

async function sha256File(file) {
  const contents = await readFile(file);
  return createHash("sha256").update(contents).digest("hex");
}

async function sourceEvidence(fixture) {
  const files = [
    "app/globals.css",
    "app/page.tsx",
    "app/offline-speech.worker.ts",
    "app/pdf-page-view.tsx",
    "app/pdf-text-model.mjs",
    "app/reader-virtualization.mjs",
    "scripts/generate-pdf-highlight-fixture.mjs",
    "scripts/run-offline-natural-timing-regression.mjs",
    "scripts/run-pdf-highlight-browser-regression.mjs",
    "tests/offline-natural-timing-harness.test.mjs",
    "tests/pdf-highlight-browser-harness.test.mjs",
    "tests/reader-virtualization.test.mjs",
    path.relative(REPOSITORY_ROOT, fixture),
  ];
  const hashes = {};
  for (const relativeFile of files) {
    const absoluteFile = path.join(REPOSITORY_ROOT, relativeFile);
    try {
      hashes[relativeFile] = await sha256File(absoluteFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
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

export function validatePdfHighlightEvidence(evidence) {
  const failures = [];
  if (evidence?.schemaVersion !== 1) failures.push("schemaVersion must be 1");
  if (evidence?.issue !== 60) failures.push("issue must be 60");
  if (!evidence?.source?.commit) failures.push("source.commit is required");
  if (!evidence?.fixture?.sha256) failures.push("fixture.sha256 is required");
  if (evidence?.geometry?.length !== MATRIX.length) {
    failures.push(`geometry must contain ${MATRIX.length} zoom/DPR runs`);
  }
  for (const run of evidence?.geometry ?? []) {
    if (!Number.isFinite(run.maximumEdgeErrorCssPx)) {
      failures.push(`${run.id} lacks a numeric maximum edge error`);
    } else if (run.maximumEdgeErrorCssPx > MAX_GLYPH_EDGE_ERROR_CSS_PX) {
      failures.push(
        `${run.id} exceeded ${MAX_GLYPH_EDGE_ERROR_CSS_PX}px (${run.maximumEdgeErrorCssPx}px)`,
      );
    }
    if (run.failures?.length) failures.push(`${run.id} has geometry failures`);
  }
  const scenarios = evidence?.scenarios;
  if (!scenarios?.reportedPassage?.continuous) {
    failures.push("reported passage sentence bands are not continuous");
  }
  if (
    scenarios?.reportedPassage?.punctuationRightEdgeErrorCssPx >
    MAX_GLYPH_EDGE_ERROR_CSS_PX
  ) {
    failures.push("reported passage punctuation is outside the sentence band");
  }
  if (!scenarios?.dehyphenation?.sameLogicalWord) {
    failures.push("dehyphenated fragments do not map to one logical word");
  }
  if (!scenarios?.dehyphenation?.bothFragmentsActive) {
    failures.push("both dehyphenated glyph fragments did not activate");
  }
  if (!scenarios?.fontsAndLigature?.passed) {
    failures.push("multi-font or ligature fixture check failed");
  }
  if (!scenarios?.rotatedAndColumns?.rotated?.vertical) {
    failures.push("rotated fixture did not retain vertical geometry");
  }
  if (!scenarios?.rotatedAndColumns?.columns?.separated) {
    failures.push("multi-column sentence rectangles were bridged");
  }
  if (!scenarios?.legacyMigration?.passed) {
    failures.push("legacy stored PDF text geometry was not migrated in place");
  }
  if (!evidence?.interactions?.samePage?.shellIdentityPreserved) {
    failures.push("same-page transitions replaced page shells");
  }
  if (
    evidence?.interactions?.samePage?.mapRenderCountBefore !==
    evidence?.interactions?.samePage?.mapRenderCountAfter
  ) {
    failures.push("same-page transitions rerendered the page-shell map");
  }
  if (evidence?.interactions?.samePage?.changedShellRenderCounts?.length) {
    failures.push("same-page transitions rerendered one or more page shells");
  }
  if (evidence?.interactions?.samePage?.mutations?.childList !== 0) {
    failures.push("same-page transitions changed rendered children");
  }
  if (!evidence?.interactions?.pageBoundary?.shellIdentityPreserved) {
    failures.push("page-boundary transitions replaced page shells");
  }
  if (
    evidence?.interactions?.pageBoundary?.mapRenderCountBefore !==
    evidence?.interactions?.pageBoundary?.mapRenderCountAfter
  ) {
    failures.push("page-boundary transitions rerendered the page-shell map");
  }
  if (evidence?.interactions?.pageBoundary?.mutations?.directChildList !== 0) {
    failures.push("page-boundary transitions reconciled the page-shell list");
  }
  const longTasks = [
    ...(evidence?.interactions?.samePage?.longTasks ?? []),
    ...(evidence?.interactions?.pageBoundary?.longTasks ?? []),
  ];
  if (longTasks.some((entry) => entry.duration > MAX_LONG_TASK_MS)) {
    failures.push(`an interaction Long Task exceeded ${MAX_LONG_TASK_MS}ms`);
  }
  return failures;
}

async function run(options) {
  await writePdfHighlightFixture(options.fixture);
  await mkdir(options.outputDirectory, { recursive: true });

  let offlineNaturalTiming = null;
  if (options.offlineNaturalEvidence) {
    offlineNaturalTiming = JSON.parse(
      await readFile(options.offlineNaturalEvidence, "utf8"),
    );
    const timingFailures = validateOfflineNaturalTimingEvidence(
      offlineNaturalTiming,
    );
    if (timingFailures.length) {
      throw new Error(
        `Offline-natural evidence failed validation:\n${timingFailures.join("\n")}`,
      );
    }
  }
  // Snapshot the reviewed source before screenshots or JSON evidence update
  // tracked output files. Per-file hashes still bind the exact implementation.
  const source = await sourceEvidence(options.fixture);

  let server;
  let browser;
  let cdp;
  try {
    server = options.appUrl ? null : await startDevelopmentServer();
    const appUrl = options.appUrl ?? server.appUrl;
    browser = await startBrowser(options.browser, options.headed);
    cdp = await CdpSession.connect(browser.webSocketDebuggerUrl);
    const consoleEntries = await configurePage(cdp, appUrl);
    const browserVersion = await cdp.send("Browser.getVersion");
    await importFixture(cdp, options.fixture);

    const geometry = [];
    let scenarios;
    let screenshotEvidence;
    for (const configuration of MATRIX) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: configuration.width,
        height: configuration.height,
        deviceScaleFactor: configuration.deviceScaleFactor,
        mobile: false,
        screenWidth: configuration.width,
        screenHeight: configuration.height,
      });
      await cdp.send("Emulation.setPageScaleFactor", {
        pageScaleFactor: configuration.pageScaleFactor,
      });
      await delay(200);
      const pages = [];
      for (const [pageNumber, word] of [
        [1, "like"],
        [2, "Serif"],
        [3, "Rotated"],
      ]) {
        await showPage(cdp, pageNumber, word);
        pages.push(await evaluate(cdp, MEASURE_PAGE_EXPRESSION(pageNumber)));
      }
      const actualViewport = await evaluate(
        cdp,
        `({
          innerWidth,
          innerHeight,
          devicePixelRatio,
          visualViewportScale: visualViewport?.scale ?? 1
        })`,
      );
      const failures = pages.flatMap((page) => page.failures);
      const numericMaximums = pages
        .map((page) => page.maximumEdgeErrorCssPx)
        .filter(Number.isFinite);
      geometry.push({
        ...configuration,
        actualViewport,
        measuredOverlays: pages.reduce((sum, page) => sum + page.measured, 0),
        overlayCount: pages.reduce((sum, page) => sum + page.overlayCount, 0),
        maximumEdgeErrorCssPx: Math.max(...numericMaximums),
        pages,
        failures,
      });
      if (configuration.id === "zoom-100-dpr-1") {
        scenarios = await collectScenarioEvidence(cdp);
        await showPage(cdp, 1, "like");
        await evaluate(
          cdp,
          `(async () => {
            Array.from(document.querySelectorAll('#pdf-page-1 .pdf-word-overlay'))
              .find((element) => element.getAttribute('aria-label') === 'like')?.click();
            await new Promise((resolve) => setTimeout(resolve, 700));
            return true;
          })()`,
        );
        const screenshot = await cdp.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        });
        const screenshotName = options.record
          ? "pdf-highlight-browser.png"
          : `${configuration.id}.png`;
        const screenshotPath = path.join(options.outputDirectory, screenshotName);
        const screenshotBytes = Buffer.from(screenshot.data, "base64");
        await writeFile(screenshotPath, screenshotBytes);
        screenshotEvidence = {
          path: path.relative(REPOSITORY_ROOT, screenshotPath),
          bytes: screenshotBytes.byteLength,
          sha256: createHash("sha256").update(screenshotBytes).digest("hex"),
          description: "Headed Brave at 100% zoom and DPR 1 with the reported passage sentence and active word highlighted.",
        };
      }
    }

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1100,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    const samePage = await collectSamePageMutationEvidence(cdp);
    const pageBoundary = await collectPageBoundaryEvidence(cdp);
    const legacyMigration = await collectLegacyMigrationEvidence(cdp);
    const browserState = await evaluate(
      cdp,
      `({
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        errors: globalThis.__lineLightPdfRegression.errors,
        allLongTasks: globalThis.__lineLightPdfRegression.longTasks
      })`,
    );

    const fixtureStats = await stat(options.fixture);
    const evidence = {
      schemaVersion: 1,
      issue: 60,
      generatedAt: new Date().toISOString(),
      source,
      fixture: {
        path: path.relative(REPOSITORY_ROOT, options.fixture),
        bytes: fixtureStats.size,
        sha256: await sha256File(options.fixture),
        expectations: PDF_HIGHLIGHT_FIXTURE_EXPECTATIONS,
      },
      coverage: {
        browserFixtureShellCount: PDF_HIGHLIGHT_FIXTURE_EXPECTATIONS.pageCount,
        unitScaleCoverage: 359,
        unitScaleTest: "tests/reader-virtualization.test.mjs",
        note: "The browser fixture forces a distant render-window transition with six stable shells; the page-indexed store is separately exercised with 359 subscribers in the unit test.",
      },
      artifacts: { screenshot: screenshotEvidence },
      environment: {
        appUrl,
        headed: options.headed,
        node: process.version,
        browserProduct: browserVersion.product,
        browserRevision: browserVersion.revision,
        userAgent: browserState.userAgent,
        platform: browserState.platform,
      },
      thresholds: {
        maximumGlyphEdgeErrorCssPx: MAX_GLYPH_EDGE_ERROR_CSS_PX,
        maximumLongTaskMs: MAX_LONG_TASK_MS,
        samePageChildListMutations: 0,
        pageShellDirectChildListMutations: 0,
      },
      geometry,
      scenarios: { ...scenarios, legacyMigration },
      interactions: { samePage, pageBoundary },
      browserDiagnostics: {
        errors: browserState.errors,
        consoleEntries: consoleEntries.filter((entry) =>
          ["error", "warning", "assert"].includes(entry.type),
        ),
        allLongTasks: browserState.allLongTasks,
      },
      relatedChecks: {
        offlineNaturalTiming: offlineNaturalTiming
          ? {
              status: "passed",
              evidence: path.relative(
                REPOSITORY_ROOT,
                options.offlineNaturalEvidence,
              ),
              source: offlineNaturalTiming.source,
              rates: offlineNaturalTiming.rates.map((run) => ({
                rate: run.rate,
                observedTransitions: run.observedTransitions,
                maximumLogicalIndexDelta: run.maximumLogicalIndexDelta,
                maximumActivationsPerFrame:
                  run.maximumActivationsPerFrame,
                maximumLongTaskMs: run.maximumLongTaskMs,
              })),
            }
          : options.offlineNaturalBlocked
          ? { status: "blocked", error: options.offlineNaturalBlocked }
          : {
              status: "not-run",
              reason: "This PDF geometry harness does not start narration.",
            },
      },
    };
    evidence.failures = validatePdfHighlightEvidence(evidence);
    evidence.passed = evidence.failures.length === 0;

    const evidencePath = path.join(
      options.outputDirectory,
      "pdf-highlight-browser.json",
    );
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ evidence: evidencePath, passed: evidence.passed, failures: evidence.failures })}\n`,
    );
    if (!evidence.passed) process.exitCode = 1;
  } finally {
    cdp?.close();
    terminateProcessGroup(browser?.child);
    terminateProcessGroup(server?.child);
    if (browser?.profileDirectory) {
      await delay(200);
      await rm(browser.profileDirectory, { recursive: true, force: true });
    }
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
