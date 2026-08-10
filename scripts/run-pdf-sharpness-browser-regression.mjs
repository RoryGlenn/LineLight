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
    fixture: DEFAULT_PDF_HIGHLIGHT_FIXTURE,
    outputDirectory:
      process.env.LINELIGHT_PDF_SHARPNESS_EVIDENCE ??
      DEFAULT_OUTPUT_DIRECTORY,
    record: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--browser") options.browser = argv[++index];
    else if (argument === "--fixture") options.fixture = argv[++index];
    else if (argument === "--output") options.outputDirectory = argv[++index];
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
          "  --fixture PATH   Selectable-text PDF used for both original and import.",
          "  --output DIR     Transient evidence directory.",
          "  --record         Write review evidence to docs/evidence/issue-68/.",
          "",
          "The runner always makes a fresh production build, uses visible browsers,",
          "owns its loopback server, and refuses a dirty source tree.",
          "",
        ].join("\n"),
      );
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.record) options.outputDirectory = RECORDED_OUTPUT_DIRECTORY;
  options.browser = path.resolve(options.browser);
  options.fixture = path.resolve(options.fixture);
  options.outputDirectory = path.resolve(options.outputDirectory);
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

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
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
    width: Number(width) || 0,
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
  const qualifyingRows = [];
  const minimumWhitePixels = Math.max(80, Math.ceil(width * 0.45));
  for (let y = 0; y < height; y += 1) {
    let firstWhite = width;
    let lastWhite = -1;
    let whitePixels = 0;
    for (let x = 0; x < width; x += 1) {
      if (!isWhite((y * width + x) * 4)) continue;
      whitePixels += 1;
      firstWhite = Math.min(firstWhite, x);
      lastWhite = x;
    }
    if (whitePixels >= minimumWhitePixels) {
      qualifyingRows.push({ firstWhite, lastWhite, whitePixels, y });
    }
  }

  let bestRows = [];
  let currentRows = [];
  for (const row of qualifyingRows) {
    if (
      currentRows.length > 0 &&
      row.y > currentRows[currentRows.length - 1].y + 16
    ) {
      if (currentRows.length > bestRows.length) bestRows = currentRows;
      currentRows = [];
    }
    currentRows.push(row);
  }
  if (currentRows.length > bestRows.length) bestRows = currentRows;

  const minimumPageHeight = Math.max(80, Math.ceil(height * 0.25));
  if (bestRows.length < minimumPageHeight) return empty;
  const pageLeft = median(bestRows.map((row) => row.firstWhite));
  const pageRight = median(bestRows.map((row) => row.lastWhite));
  const pageTop = bestRows[0].y;
  const pageBottom = bestRows[bestRows.length - 1].y;
  const pageWidth = pageRight - pageLeft + 1;
  const pageHeight = pageBottom - pageTop + 1;
  if (
    pageWidth < Math.max(120, Math.ceil(width * 0.25)) ||
    pageHeight < minimumPageHeight
  ) {
    return empty;
  }

  const insetX = Math.max(2, Math.floor(pageWidth * 0.01));
  const insetY = Math.max(2, Math.floor(pageHeight * 0.01));
  const interiorLeft = pageLeft + insetX;
  const interiorRight = pageRight - insetX;
  const interiorTop = pageTop + insetY;
  const interiorBottom = pageBottom - insetY;
  const interiorWidth = interiorRight - interiorLeft + 1;
  const interiorHeight = interiorBottom - interiorTop + 1;
  if (interiorWidth <= 0 || interiorHeight <= 0) return empty;

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
  const workerEvents = [];
  globalThis.Worker = class Issue68Worker extends NativeWorker {
    constructor(url, options) {
      const resolved = new URL(String(url), location.href).href;
      const pdfWorker = resolved.includes("pdf-document.worker");
      let workerUrl = url;
      if (forceFallback && pdfWorker) {
        const source = [
          "try { Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: undefined }); } catch {}",
          "await import(" + JSON.stringify(resolved) + ");"
        ].join("\n");
        workerUrl = URL.createObjectURL(
          new Blob([source], { type: "text/javascript" })
        );
      }
      super(workerUrl, options);
      this.__issue68PdfWorker = pdfWorker;
      if (pdfWorker) {
        this.addEventListener("message", (event) => {
          const message = event.data || {};
          const documentId = message.page?.documentId || message.document?.id;
          const revision = message.page?.revision || message.revision || null;
          workerEvents.push({
            at: performance.now(),
            completedPages: Number(message.completedPages) || null,
            direction: "from-worker",
            documentKey: documentId && revision
              ? documentId + ":" + revision
              : null,
            height: Number(message.height) || null,
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
            width: Number(message.width) || null
          });
        });
      }
    }

    postMessage(message, transferOrOptions) {
      if (this.__issue68PdfWorker) {
        const documentId = message?.documentId;
        const revision = message?.revision ?? null;
        workerEvents.push({
          at: performance.now(),
          direction: "to-worker",
          distance: Number(message?.distance),
          documentKey: documentId && revision
            ? documentId + ":" + revision
            : null,
          enabled: message?.enabled,
          jobId: Number(message?.jobId) || null,
          pageNumber: Number(message?.pageNumber) || null,
          revision,
          scale: Number(message?.scale) || null,
          type: message?.type || null,
          visible: message?.visible
        });
      }
      if (arguments.length > 1) {
        return super.postMessage(message, transferOrOptions);
      }
      return super.postMessage(message);
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
    workerEvents
  };
  let currentScenario = null;
  let currentPriorityProbe = null;
  let failNextFallback = false;
  let delayNextContinuation = null;
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
      /\.cancel\s*\(/u.test(Function.prototype.toString.call(listener)) &&
      !fallbackAbortCandidates.some((candidate) => candidate.signal === this)
    ) {
      const candidate = {
        bound: false,
        registeredAt: performance.now(),
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
      state.sourceFiles.push({ sha256, size: file.size });
    }).catch(recordError);
  }, true);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({
          duration: entry.duration,
          name: entry.name,
          startTime: entry.startTime
        });
      }
    }).observe({ type: "longtask", buffered: true });
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
  globalThis.requestAnimationFrame = (callback) => {
    if (
      delayNextContinuation?.delay > 0 &&
      forceFallback &&
      state.fallback.activeStaging > 0 &&
      /scheduleNext/i.test(callback?.name || "")
    ) {
      const { armedAt, delay } = delayNextContinuation;
      delayNextContinuation = null;
      const activeAttempts = Array.from(fallbackAttempts.values()).filter(
        (attempt) => !attempt.finished
      );
      const attempt = activeAttempts.length === 1 ? activeAttempts[0] : null;
      const delayedAt = performance.now();
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
      return setTimeout(() => {
        const resumedAt = performance.now();
        state.fallback.events.push({
          abortSignalId: attempt?.abortSignalId ?? null,
          afterMs: resumedAt - delayedAt,
          at: resumedAt,
          documentKey: attempt?.documentKey ?? null,
          page: attempt?.page ?? null,
          pageDerivation: attempt?.pageDerivation ?? null,
          renderAttemptId: attempt?.renderAttemptId ?? null,
          revision: attempt?.revision ?? null,
          type: "continuation-resume"
        });
        nativeRequestAnimationFrame(callback);
      }, delay);
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
      const abortCandidates = fallbackAbortCandidates.filter(
        (candidate) => !candidate.bound
      );
      const abortCandidate = abortCandidates.length === 1
        ? abortCandidates[0]
        : null;
      const attempt = {
        ...derivedPage,
        abortSignalCandidateCount: abortCandidates.length,
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
      if (failNextFallback) {
        failNextFallback = false;
        state.fallback.injectedFailures += 1;
        finishStaging(this, "injected-failure");
        return null;
      }
    }
    return nativeGetContext.call(this, type, options);
  };
  const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function issue68DrawImage(...args) {
    const result = nativeDrawImage.apply(this, args);
    if (this.canvas?.isConnected) {
      const destination = this.canvas;
      const fallbackAttempt = args[0]?.[stagingSymbol] ?? null;
      const fallbackCompose = Boolean(fallbackAttempt);
      queueMicrotask(() => {
        const block = destination.closest(".pdf-page-block");
        const draw = {
          at: performance.now(),
          distance: Number(block?.dataset.pdfPageDistance),
          height: destination.height,
          page: Number(block?.dataset.pdfPageIndex || -1) + 1,
          scale: Number(destination.dataset.pdfRasterScale) || null,
          source: destination.dataset.pdfRenderSource ||
            (fallbackCompose ? "main-fallback" : "worker-bitmap"),
          visible: block?.dataset.pdfPageVisible === "true",
          width: destination.width
        };
        state.draws.push(draw);
        if (currentPriorityProbe) currentPriorityProbe.compositions.push(draw);
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
    for (const block of document.querySelectorAll(".pdf-page-block")) {
      const canvas = block.querySelector("canvas");
      if (!canvas) continue;
      const page = Number(block.dataset.pdfPageIndex || -1) + 1;
      const sample = {
        at: now,
        capped: canvas.dataset.pdfRasterCapped === "true",
        distance: Number(block.dataset.pdfPageDistance),
        height: canvas.height,
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
      }
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
        if (currentPriorityProbe && sample.width > 0 && sample.height > 0) {
          currentPriorityProbe.compositions.push(sample);
        }
      }
    }
    if (currentScenario) {
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
      longTaskStart: state.longTasks.length,
      maximumCanvasCount: 0,
      maximumCanvasPixels: 0,
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
    currentScenario.drawEnd = state.draws.length;
    currentScenario.longTaskEnd = state.longTasks.length;
    currentScenario.sampleEnd = state.samples.length;
    currentScenario.workerEventEnd = workerEvents.length;
    const result = structuredClone(currentScenario);
    currentScenario = null;
    return result;
  };
  state.beginPriorityProbe = (targetPage) => {
    currentPriorityProbe = {
      compositions: [],
      startedAt: performance.now(),
      targetPage,
      workerEventStart: workerEvents.length
    };
  };
  state.finishPriorityProbe = () => {
    if (currentPriorityProbe) {
      currentPriorityProbe.workerEvents = workerEvents.slice(
        currentPriorityProbe.workerEventStart
      );
    }
    const result = structuredClone(currentPriorityProbe);
    currentPriorityProbe = null;
    return result;
  };
  state.failNextFallback = () => {
    failNextFallback = true;
  };
  state.delayNextContinuation = function issue68DelayNextContinuation(milliseconds) {
    if (arguments.length !== 1) {
      throw new Error("Fallback continuation delay accepts only a duration.");
    }
    delayNextContinuation = {
      armedAt: performance.now(),
      delay: Math.max(0, Number(milliseconds) || 0)
    };
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
    return structuredClone(event);
  };
  state.snapshot = () => structuredClone({
    draws: state.draws,
    errors: state.errors,
    fallback: state.fallback,
    longTasks: state.longTasks,
    notices: state.notices,
    samples: state.samples,
    scenarios: state.scenarios,
    sourceFiles: state.sourceFiles,
    spoken: state.spoken,
    workerEvents: state.workerEvents
  });
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

function sendToCdpSession(cdp, method, params, sessionId) {
  if (!sessionId) return cdp.send(method, params);
  const id = cdp.nextId++;
  return new Promise((resolve, reject) => {
    cdp.pending.set(id, { reject, resolve });
    cdp.webSocket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function configureAppSession(cdp, networkState) {
  const recordRequest = (event, sessionId) => {
    const key = `${sessionId ?? "page"}:${event.requestId}`;
    const request = {
      method: event.request.method,
      phase: networkState.phase,
      requestId: event.requestId,
      sessionId: sessionId ?? null,
      type: event.type,
      url: event.request.url,
    };
    networkState.requests.push(request);
    networkState.byId.set(key, request);
    networkState.inflightRequests.add(key);
  };
  const completeRequest = (event, sessionId) => {
    const key = `${sessionId ?? "page"}:${event.requestId}`;
    if (networkState.inflightRequests.delete(key)) {
      networkState.completedRequestCount += 1;
    }
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
      completeRequest(event, message.sessionId);
    } else if (message.method === "Network.loadingFinished") {
      completeRequest(event, message.sessionId);
    } else if (message.method === "Network.responseReceived") {
      recordResponse(event, message.sessionId);
    } else if (message.method === "Target.targetInfoChanged") {
      const target = networkState.targets.find(
        (candidate) => candidate.targetId === event.targetInfo?.targetId,
      );
      if (target) {
        target.type = event.targetInfo.type;
        target.url = event.targetInfo.url;
      }
    } else if (message.method === "Target.detachedFromTarget") {
      const target = networkState.targets.find(
        (candidate) => candidate.sessionId === event.sessionId,
      );
      if (target) target.detached = true;
    } else if (message.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo, waitingForDebugger } = event;
      networkState.targets.push({
        openerId: targetInfo.openerId ?? null,
        parentSessionId: message.sessionId ?? null,
        phase: networkState.phase,
        sessionId,
        targetId: targetInfo.targetId,
        type: targetInfo.type,
        url: targetInfo.url,
        waitingForDebugger: Boolean(waitingForDebugger),
      });
      const attachPromise = (async () => {
        try {
          await Promise.all([
            sendToCdpSession(cdp, "Network.enable", {}, sessionId),
            sendToCdpSession(cdp, "Runtime.enable", {}, sessionId),
          ]);
          await sendToCdpSession(
            cdp,
            "Network.setCacheDisabled",
            { cacheDisabled: true },
            sessionId,
          );
          await sendToCdpSession(
            cdp,
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
            type: targetInfo.type,
            url: targetInfo.url,
          });
        } finally {
          if (waitingForDebugger) {
            await sendToCdpSession(
              cdp,
              "Runtime.runIfWaitingForDebugger",
              {},
              sessionId,
            ).catch((error) => {
              networkState.attachErrors.push({
                error: `Could not resume target: ${String(error)}`,
                sessionId,
                type: targetInfo.type,
                url: targetInfo.url,
              });
            });
          }
        }
      })();
      networkState.attachPromises.push(attachPromise);
      networkState.pendingAttachPromises.add(attachPromise);
      void attachPromise.then(
        () => networkState.pendingAttachPromises.delete(attachPromise),
        (error) => {
          networkState.pendingAttachPromises.delete(attachPromise);
          networkState.attachErrors.push({
            error: `Unhandled attach setup error: ${String(error)}`,
            sessionId,
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
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: INSTRUMENTATION_SOURCE,
  });
}

async function waitForCdpNetworkFixedPoint(
  networkState,
  label,
  timeoutMs = 10_000,
) {
  const startedAt = Date.now();
  let previousRequestCount = -1;
  let previousTargetCount = -1;
  let stableSamples = 0;
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
    if (
      networkState.pendingAttachPromises.size === 0 &&
      networkState.inflightRequests.size === 0 &&
      requestCount === previousRequestCount &&
      targetCount === previousTargetCount
    ) {
      stableSamples += 1;
    } else {
      stableSamples = 0;
    }
    previousRequestCount = requestCount;
    previousTargetCount = targetCount;
    if (stableSamples >= 3) {
      const fixedPoint = {
        attachPromiseCount: networkState.attachPromises.length,
        completedRequestCount: networkState.completedRequestCount,
        inflightRequestCount: 0,
        label,
        pendingAttachCount: 0,
        requestCount,
        targetCount,
      };
      networkState.networkFixedPoints.push(fixedPoint);
      return fixedPoint;
    }
  }
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

async function waitForSharpCanvas(cdp, pageNumber, source = null) {
  return waitForExpression(
    cdp,
    browserExpression(`
      const block = document.querySelector('#pdf-page-${pageNumber}');
      const canvas = block?.querySelector('canvas');
      if (!canvas || block?.dataset.pdfPageVisible !== 'true') return false;
      const bounds = canvas.getBoundingClientRect();
      const pageEvent = globalThis.__lineLightIssue68.workerEvents.findLast(
        (event) => event.direction === 'from-worker' &&
          event.type === 'page' && event.pageNumber === ${pageNumber}
      );
      const targetWidth = Number(canvas.dataset.pdfRasterTargetWidth);
      const targetHeight = Number(canvas.dataset.pdfRasterTargetHeight);
      const renderSource = canvas.dataset.pdfRenderSource || null;
      if (${JSON.stringify(source)} && renderSource !== ${JSON.stringify(source)}) return false;
      return bounds.width > 0 && bounds.height > 0 &&
        pageEvent?.pageWidth > 0 && pageEvent?.pageHeight > 0 &&
        targetWidth > 0 && targetHeight > 0 &&
        canvas.width >= targetWidth && canvas.height >= targetHeight && {
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
  await waitForPdfModelCompletion(cdp, 6);
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
        draw.scale <= 1.2500001 &&
        draw.at >= ${scenarioStart.startedAt}
      ) || false;
    `),
    `page ${adjacent.page} connected-canvas preview composition`,
    SCENARIO_TIMEOUT_MS,
  );
  const sharp = await waitForSharpCanvas(cdp, adjacent.page);
  const sharpComposition = await waitForExpression(
    cdp,
    browserExpression(`
      return globalThis.__lineLightIssue68.draws.find((draw) =>
        draw.page === ${adjacent.page} &&
        draw.visible === true &&
        draw.width >= ${sharp.targetWidth} &&
        draw.height >= ${sharp.targetHeight} &&
        draw.at > ${previewComposition.at}
      ) || false;
    `),
    `page ${adjacent.page} connected-canvas sharp composition`,
    SCENARIO_TIMEOUT_MS,
  );
  const lineLightScreenshot = await writeScreenshot(
    cdp,
    outputDirectory,
    `linelight-${configuration.id}.png`,
  );

  const alignment = await collectAlignmentEvidence(cdp, configuration.id);
  const intermediatePage = Math.min(6, adjacent.page + 1);
  const priorityTarget = Math.min(6, adjacent.page + 2);
  await scrollPageIntoView(cdp, intermediatePage);
  await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.beginPriorityProbe(${priorityTarget}); true`,
  );
  await scrollPageIntoView(cdp, priorityTarget);
  await waitForSharpCanvas(cdp, priorityTarget);
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
    (event) => event.pageNumber === adjacent.page,
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
  const previewBitmapIndex = targetWorkerEvents.findIndex(
    (event) =>
      event.direction === "from-worker" &&
      event.type === "bitmap" &&
      event.scale <= 1.25 + 1e-7,
  );
  const sharpBitmapIndex = targetWorkerEvents.findIndex(
    (event) =>
      event.direction === "from-worker" &&
      event.type === "bitmap" &&
      event.width >= sharp.targetWidth &&
      event.height >= sharp.targetHeight,
  );
  const priorityBitmaps = (priorityProbe?.workerEvents ?? []).filter(
    (event) => event.direction === "from-worker" && event.type === "bitmap",
  );
  const firstTargetBitmapIndex = priorityBitmaps.findIndex(
    (event) => event.pageNumber === priorityTarget,
  );
  const staleWorkerBitmaps = firstTargetBitmapIndex < 0
    ? priorityBitmaps
    : priorityBitmaps.slice(0, firstTargetBitmapIndex).filter(
        (event) => event.pageNumber !== priorityTarget,
      );
  const staleNonVisibleCompositions = (
    priorityProbe?.compositions ?? []
  ).filter(
    (composition) =>
      composition.page !== priorityTarget && composition.visible === false,
  );

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
      maximumPixels: scenario.maximumCanvasPixels,
    },
    id: configuration.id,
    importedSource: snapshot.sourceFiles[0] ?? null,
    longTasks: snapshot.longTasks.slice(
      scenario.longTaskStart,
      scenario.longTaskEnd,
    ),
    raster: {
      noLateLowOverwrite: hasNoResolutionRegression(pageDraws),
      noResolutionRegression:
        hasNoResolutionRegression(pageDraws) &&
        hasNoResolutionRegression(pageSamples),
      preview: {
        composedAt: previewComposition.at,
        connectedCanvas: previewComposition.visible === true,
        distance: adjacent.distance,
        observed:
          previewRequestIndex >= 0 &&
          previewBitmapIndex >= 0 &&
          previewComposition.visible === true,
        scale: previewComposition.scale,
        workerObserved: previewRequestIndex >= 0 && previewBitmapIndex >= 0,
      },
      previewBeforeSharp:
        previewComposition.at < sharpComposition.at &&
        previewBitmapIndex >= 0 &&
        sharpBitmapIndex >= 0 &&
        previewBitmapIndex < sharpBitmapIndex,
      sharp: {
        actualHeight: sharp.actualHeight,
        actualWidth: sharp.actualWidth,
        composedAt: sharpComposition.at,
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
    },
    release,
    runtimeErrors: snapshot.errors,
    viewport: await collectViewport(cdp, configuration, beforeViewport),
    visibleFirst: {
      firstComposedPage: priorityProbe?.compositions?.[0]?.page ?? null,
      firstWorkerBitmapPage: priorityBitmaps[0]?.pageNumber ?? null,
      staleNonVisibleCompositions,
      staleWorkerBitmaps,
      targetPage: priorityTarget,
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
    `globalThis.__lineLightIssue68.failNextFallback();
      globalThis.__lineLightIssue68.beginScenario('forced-main-fallback'); true`,
  );
  await importFixture(cdp, fixture);
  await waitForExpression(
    cdp,
    `globalThis.__lineLightIssue68.sourceFiles.length === 1`,
    "the fallback browser-side imported PDF hash",
    SCENARIO_TIMEOUT_MS,
  );
  await waitForPdfModelCompletion(cdp, 6);
  await waitForExpression(
    cdp,
    `document.querySelector('.pdf-page-view')?.dataset.pdfRenderFallback === 'true'`,
    "the immediate worker fallback signal",
    SCENARIO_TIMEOUT_MS,
  );
  await waitForExpression(
    cdp,
    `globalThis.__lineLightIssue68.fallback.injectedFailures === 1`,
    "the injected first fallback failure",
    SCENARIO_TIMEOUT_MS,
  );
  await scrollPageIntoView(cdp, 1);
  await waitForSharpCanvas(cdp, 1, "main-fallback");
  const retry = await waitForExpression(
    cdp,
    browserExpression(`
      const events = globalThis.__lineLightIssue68.fallback.events;
      const failure = events.find((event) =>
        event.type === 'staging-finish' &&
        event.outcome === 'injected-failure' &&
        event.documentKey && event.revision &&
        Number.isInteger(event.abortSignalId) &&
        Number.isInteger(event.renderAttemptId) &&
        Number.isInteger(event.page) &&
        event.targetKey
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
      return failure && failedStart && retryStart && retryCompose && {
        composedAt: retryCompose.at,
        documentKey: failure.documentKey,
        failedAbortSignalId: failure.abortSignalId,
        failedAttemptId: failure.renderAttemptId,
        failedAt: failure.at,
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

  await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.delayNextContinuation(1000); true`,
  );
  await scrollPageIntoView(cdp, 3);
  const continuationDelay = await waitForExpression(
    cdp,
    browserExpression(`
      return globalThis.__lineLightIssue68.fallback.events.find(
        (event) => event.type === 'continuation-delay' &&
          Number.isInteger(event.renderAttemptId)
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
  const viewportExitRequest = await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.markFallbackViewportExitRequest(${renderAttemptId}, 5)`,
  );
  await scrollPageIntoView(cdp, 5);
  await waitForExpression(
    cdp,
    browserExpression(`
      const block = document.querySelector('#pdf-page-${cancelledPage}');
      const canvas = block?.querySelector('canvas');
      if (block && block.dataset.pdfPageVisible !== 'false') return false;
      if (canvas && (canvas.width !== 0 || canvas.height !== 0)) return false;
      return true;
    `),
    "the cancelled fallback page to leave the viewport and release its backing",
    SCENARIO_TIMEOUT_MS,
  );
  const viewportExit = await evaluate(
    cdp,
    `globalThis.__lineLightIssue68.markFallbackViewportExit(${renderAttemptId})`,
  );
  const cancellationTerminal = await waitForExpression(
    cdp,
    browserExpression(`
      return globalThis.__lineLightIssue68.fallback.events.find(
        (event) => event.type === 'staging-finish' &&
          event.abortSignalId === ${continuationDelay.abortSignalId} &&
          event.outcome === 'cancelled' &&
          event.renderAttemptId === ${renderAttemptId} &&
          event.documentKey === ${JSON.stringify(continuationDelay.documentKey)} &&
          event.revision === ${JSON.stringify(continuationDelay.revision)} &&
          event.page === ${cancelledPage} &&
          event.cancelRequestedAt === ${viewportExit.cancelRequestedAt} &&
          event.cancelRequestedAt >= ${viewportExitRequest.at} &&
          event.at <= ${viewportExit.at}
      ) || false;
    `),
    `page ${cancelledPage} delayed attempt to reach its cancellation terminal`,
    SCENARIO_TIMEOUT_MS,
  );
  const continuationResume = await waitForExpression(
    cdp,
    browserExpression(`
      return globalThis.__lineLightIssue68.fallback.events.find(
        (event) => event.type === 'continuation-resume' &&
          event.abortSignalId === ${continuationDelay.abortSignalId} &&
          event.renderAttemptId === ${renderAttemptId} &&
          event.documentKey === ${JSON.stringify(continuationDelay.documentKey)} &&
          event.revision === ${JSON.stringify(continuationDelay.revision)} &&
          event.page === ${cancelledPage} && event.afterMs >= 950 &&
          event.at > ${cancellationTerminal.at}
      ) || false;
    `),
    `page ${cancelledPage} delayed continuation to resume after one second`,
    SCENARIO_TIMEOUT_MS,
  );
  await waitForSharpCanvas(cdp, 5, "main-fallback");
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
  const firstStaging = snapshot.fallback.events.find(
    (event) => event.type === "staging-start",
  );
  const workerFallbackEvent = snapshot.workerEvents.find(
    (event) =>
      event.direction === "from-worker" &&
      event.type === "render-fallback",
  );
  const workerBitmapsAfterSignal = snapshot.workerEvents.filter(
    (event) =>
      event.direction === "from-worker" &&
      event.type === "bitmap" &&
      event.at >= (workerFallbackEvent?.at ?? Number.POSITIVE_INFINITY),
  );
  const pageOneDraws = snapshot.draws.filter((draw) => draw.page === 1);
  const cancelledAttemptLateComposes = snapshot.fallback.events.filter(
    (event) =>
      event.type === "visible-compose" &&
      event.renderAttemptId === renderAttemptId &&
      event.at > viewportExit.at,
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
      continuationResumeAt: continuationResume.at,
      continuationResumeObserved: true,
      continuationResumedAfterMs: continuationResume.afterMs,
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
    longTasks: snapshot.longTasks.slice(
      scenario.longTaskStart,
      scenario.longTaskEnd,
    ),
    maximumConcurrentStaging:
      snapshot.fallback.maximumConcurrentStaging,
    noLateLowOverwrite:
      workerBitmapsAfterSignal.length === 0 &&
      hasNoResolutionRegression(pageOneDraws),
    retry,
    retrySucceeded: Boolean(retry),
    runtimeErrors: snapshot.errors,
    signaledBeforeDocumentReady: Boolean(
      snapshot.fallback.signalAt !== null &&
      workerFallbackEvent &&
      firstStaging &&
      workerFallbackEvent.at <= snapshot.fallback.signalAt &&
      snapshot.fallback.signalAt <= firstStaging.at
    ),
    stagingEvents: snapshot.fallback.events,
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
      return [id, {
        documentRequestCount,
        documentTargets,
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
    localRequestCount: networkState.requests.length - externalRequests.length,
    inflightRequestCount: networkState.inflightRequests.size,
    matrixCoverage,
    nonPageRequestCounts,
    nonPageRequests,
    referenceScheme,
    sourceRequest: sourceRequest ?? null,
    sourceSha256: fixtureSha256,
    sourceStayedLocal: !sourceRequest && externalRequests.length === 0,
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
    networkFixedPoints: [],
    phase: "startup",
    pendingAttachPromises: new Set(),
    requests: [],
    responseFailures: [],
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
    appCdp = await CdpSession.connect(appBrowser.webSocketDebuggerUrl);
    await configureAppSession(appCdp, networkState);
    const targetPages = new Map();
    for (const configuration of PDF_SHARPNESS_MATRIX) {
      networkState.phase = configuration.id;
      const matrixRun = await collectMatrixRun(
        appCdp,
        server.appUrl,
        options.fixture,
        options.outputDirectory,
        configuration,
      );
      await waitForCdpNetworkFixedPoint(networkState, configuration.id);
      matrixRun.comparison.sourceSha256 = fixture.sha256;
      targetPages.set(configuration.id, matrixRun.comparison.targetPage);
      evidence.matrix.push(matrixRun);
    }
    networkState.phase = "forced-main-fallback";
    evidence.fallback = await collectFallbackEvidence(
      appCdp,
      server.appUrl,
      options.fixture,
      options.outputDirectory,
    );
    await waitForCdpNetworkFixedPoint(
      networkState,
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
