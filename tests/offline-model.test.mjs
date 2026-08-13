import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_NARRATION_ENGINE,
  NARRATION_PREFERENCE_VERSION,
  allowsDeviceFallback,
  restoreNarrationPreference,
} from "../app/narration-defaults.mjs";
import {
  OFFLINE_MODEL_DTYPE,
  OFFLINE_FP16_READY_MARKER_URL,
  OFFLINE_FP16_READY_MARKER_VERSION,
  OFFLINE_LEGACY_Q8_MODEL_FILE,
  OFFLINE_MODEL_REVISION,
  OFFLINE_MODEL_ROUTE_PREFIX,
  OFFLINE_MODEL_RUNTIME,
  OFFLINE_RUNTIME_CACHE_NAME,
  OFFLINE_WEBGPU_MODEL_BYTES,
  OFFLINE_WEBGPU_ADAPTER_TIMEOUT_MS,
  OFFLINE_WEBGPU_MODEL_DTYPE,
  OFFLINE_WEBGPU_MODEL_FILE,
  OFFLINE_WASM_PROXY,
  OFFLINE_WASM_THREADS,
  constrainOfflineBackendPreference,
  nextOfflineSpeechBackend,
  probeWebGpuAdapter,
  resolveOfflineModelRequest,
  selectOfflineModelDtype,
  selectOfflineSpeechBackend,
} from "../app/offline-model-manifest.mjs";
import { handleOfflineModelRequest } from "../worker/offline-model.mjs";
import { describeWorkerStartupFailure } from "../app/worker-startup-diagnostics.mjs";

test("defaults new readers to Offline natural narration", () => {
  assert.equal(DEFAULT_NARRATION_ENGINE, "offline");
});

test("migrates the legacy browser voice default to Offline natural once", () => {
  assert.deepEqual(
    restoreNarrationPreference({ narrationEngine: "device" }),
    {
      narrationEngine: "offline",
      narrationPreferenceVersion: NARRATION_PREFERENCE_VERSION,
    },
  );
});

test("preserves explicit narration choices after preference migration", () => {
  assert.deepEqual(
    restoreNarrationPreference({
      narrationEngine: "device",
      narrationPreferenceVersion: NARRATION_PREFERENCE_VERSION,
    }),
    {
      narrationEngine: "device",
      narrationPreferenceVersion: NARRATION_PREFERENCE_VERSION,
    },
  );
  assert.equal(
    restoreNarrationPreference({ narrationEngine: "azure" })
      .narrationEngine,
    "azure",
  );
  assert.equal(
    restoreNarrationPreference({
      narrationEngine: "audiobook",
      narrationPreferenceVersion: NARRATION_PREFERENCE_VERSION,
    }).narrationEngine,
    "audiobook",
  );
});

test("never silently falls back from offline narration to browser speech", () => {
  assert.equal(allowsDeviceFallback("offline"), false);
  assert.equal(allowsDeviceFallback("audiobook"), false);
  assert.equal(allowsDeviceFallback("azure"), true);
});

test("pairs device-specific Kokoro artifacts with a safe runtime ladder", () => {
  assert.equal(OFFLINE_MODEL_DTYPE, "fp16");
  assert.equal(OFFLINE_WEBGPU_MODEL_DTYPE, "fp16");
  assert.equal(OFFLINE_WEBGPU_MODEL_FILE, "onnx/model_fp16.onnx");
  assert.equal(OFFLINE_WEBGPU_MODEL_BYTES, 163_234_740);
  assert.equal(OFFLINE_WEBGPU_ADAPTER_TIMEOUT_MS, 500);
  assert.equal(OFFLINE_MODEL_RUNTIME, "webgpu");
  assert.equal(OFFLINE_WASM_THREADS, 8);
  assert.equal(OFFLINE_WASM_PROXY, false);

  assert.deepEqual(
    selectOfflineSpeechBackend({
      crossOriginIsolated: false,
      hardwareConcurrency: 20,
      webGpuAvailable: true,
    }),
    { device: "webgpu", wasmThreads: null },
  );
  assert.deepEqual(
    selectOfflineSpeechBackend({
      crossOriginIsolated: true,
      hardwareConcurrency: 10,
      webGpuAvailable: false,
    }),
    { device: "wasm", wasmThreads: 8 },
  );
  assert.deepEqual(
    selectOfflineSpeechBackend({
      crossOriginIsolated: true,
      hardwareConcurrency: 20,
      webGpuAvailable: false,
    }),
    { device: "wasm", wasmThreads: 8 },
  );
  assert.deepEqual(
    selectOfflineSpeechBackend({
      crossOriginIsolated: false,
      hardwareConcurrency: 20,
      webGpuAvailable: false,
    }),
    { device: "wasm", wasmThreads: 1 },
  );
  assert.deepEqual(
    selectOfflineSpeechBackend({
      crossOriginIsolated: true,
      forceSingleThreadWasm: true,
      hardwareConcurrency: 20,
      webGpuAvailable: false,
    }),
    { device: "wasm", wasmThreads: 1 },
  );
  assert.deepEqual(
    nextOfflineSpeechBackend({ device: "webgpu", wasmThreads: null }),
    { device: "wasm", wasmThreads: null },
  );
  assert.deepEqual(
    nextOfflineSpeechBackend({ device: "wasm", wasmThreads: 8 }),
    { device: "wasm", wasmThreads: 1 },
  );
  assert.equal(
    nextOfflineSpeechBackend({ device: "wasm", wasmThreads: 1 }),
    null,
  );

  const threadedFallback = nextOfflineSpeechBackend({
    device: "webgpu",
    wasmThreads: null,
  });
  assert.deepEqual(
    constrainOfflineBackendPreference(
      {
        device: threadedFallback.device,
        wasmThreads: threadedFallback.wasmThreads ?? undefined,
      },
      true,
    ),
    { device: "wasm" },
  );
  const singleThreadFallback = nextOfflineSpeechBackend({
    device: "wasm",
    wasmThreads: 8,
  });
  assert.deepEqual(
    constrainOfflineBackendPreference(
      {
        device: singleThreadFallback.device,
        wasmThreads: singleThreadFallback.wasmThreads ?? undefined,
      },
      true,
    ),
    { device: "wasm", wasmThreads: 1 },
  );
});

test("keeps q8 selected until an explicit fp16 validation commits", () => {
  assert.equal(
    selectOfflineModelDtype({
      fp16Available: false,
      legacyQ8Available: true,
    }),
    "q8",
  );
  assert.equal(
    selectOfflineModelDtype({
      fp16Available: true,
      legacyQ8Available: true,
    }),
    "q8",
  );
  assert.equal(
    selectOfflineModelDtype({
      fp16Available: true,
      legacyQ8Available: true,
      preferFp16: true,
    }),
    "fp16",
  );
  assert.equal(selectOfflineModelDtype(), "fp16");
});

test("bounds WebGPU adapter detection and ignores late results", async () => {
  const fp16Adapter = {
    features: { has: (feature) => feature === "shader-f16" },
  };
  assert.equal(
    await probeWebGpuAdapter({
      requestAdapter: async () => fp16Adapter,
    }),
    true,
  );
  assert.equal(
    await probeWebGpuAdapter({
      requestAdapter: async () => null,
    }),
    false,
  );
  assert.equal(
    await probeWebGpuAdapter({
      requestAdapter: async () => {
        throw new Error("adapter failed");
      },
    }),
    false,
  );
  assert.equal(
    await probeWebGpuAdapter({
      requestAdapter: () => {
        throw new Error("synchronous adapter failure");
      },
    }),
    false,
  );

  let fireDeadline = () => {};
  let resolveAdapter = () => {};
  let clearCalls = 0;
  const lateAdapter = new Promise((resolve) => {
    resolveAdapter = () => resolve(fp16Adapter);
  });
  const probe = probeWebGpuAdapter({
    requestAdapter: () => lateAdapter,
    timeoutMs: 500,
    setTimeoutFn: (callback) => {
      fireDeadline = callback;
      return 17;
    },
    clearTimeoutFn: () => {
      clearCalls += 1;
    },
  });
  fireDeadline();
  assert.equal(await probe, false);
  resolveAdapter();
  await Promise.resolve();
  assert.equal(clearCalls, 1);
});

test("retries WebGPU on a later page load after a transient runtime failure", async () => {
  const source = await readFile("app/offline-speech.ts", "utf8");

  assert.match(source, /let webGpuDisabledForSession = false/u);
  assert.match(source, /webGpuDisabledForSession = true/u);
  assert.doesNotMatch(source, /offline-webgpu-disabled/u);
  assert.doesNotMatch(
    source,
    /localStorage[^\n]*(?:webgpu|backend)|(?:webgpu|backend)[^\n]*localStorage/iu,
  );
});

test("reports bounded offline worker startup details without serializing private data", () => {
  const error = new Error("Module evaluation failed");
  error.stack = "private narration must not appear";
  const diagnostic = describeWorkerStartupFailure({
    workerUrl:
      "http://reader:secret@localhost:5173/app/offline-speech.worker.ts?worker_file&type=module#private",
    message: "Uncaught TypeError\n",
    error,
    filename: "http://localhost:5173/app/offline-speech.worker.ts",
    lineno: 12,
    colno: 7,
    privateText: "private document text must not appear",
  });

  assert.match(
    diagnostic,
    /worker URL: http:\/\/localhost:5173\/app\/offline-speech\.worker\.ts\?worker_file&type=module/u,
  );
  assert.match(diagnostic, /message: Uncaught TypeError/u);
  assert.match(diagnostic, /error: Error: Module evaluation failed/u);
  assert.match(
    diagnostic,
    /source: http:\/\/localhost:5173\/app\/offline-speech\.worker\.ts/u,
  );
  assert.match(diagnostic, /line: 12/u);
  assert.match(diagnostic, /column: 7/u);
  assert.doesNotMatch(diagnostic, /reader|secret|private narration|private document/u);
});

test("validates waveforms before ready and preserves q8 after a model-only load", async () => {
  const workerSource = await readFile("app/offline-speech.worker.ts", "utf8");

  assert.match(
    workerSource,
    /generateUsableOfflineAudio\(\s*"Ready\."/u,
  );
  assert.match(workerSource, /generateUsableOfflineAudio\(text/u);
  assert.equal(
    Array.from(
      workerSource.matchAll(/shouldRetryOfflineSpeechBackend\(error,/gu),
    ).length,
    2,
  );
  assert.match(workerSource, /stage: warm \? "ready" : "loaded"/u);
  assert.match(
    workerSource,
    /const warm = message\.warm !== false;[\s\S]*initializeSpeech\([\s\S]*if \(warm\) \{[\s\S]*removeUnusedModelArtifact/u,
  );
  assert.match(
    workerSource,
    /installModelFiles[\s\S]*installBackend\.wasmThreads \?\? undefined,\s*true,\s*true,[\s\S]*retainOfflineSpeechRuntime\(\)[\s\S]*await removeUnusedModelArtifact\(\);[\s\S]*commitOfflineModelReadyMarker/u,
  );
  assert.doesNotMatch(workerSource, /invalidateOfflineModelReadyMarker/u);
});

test("uses every validated fp16 cache alias for WebGPU selection", async () => {
  const workerSource = await readFile("app/offline-speech.worker.ts", "utf8");
  const start = workerSource.indexOf("const webGpuAvailable =");
  const selection = workerSource.slice(
    start,
    workerSource.indexOf("const selectedBackend =", start),
  );

  assert.match(selection, /fp16Available/u);
  assert.match(selection, /hasWebGpuAdapter/u);
  assert.doesNotMatch(selection, /hasWebGpuModelArtifact/u);
});

test("selects and verifies each cold backend only once before model construction", async () => {
  const workerSource = await readFile("app/offline-speech.worker.ts", "utf8");
  const initializeStart = workerSource.indexOf("async function initializeSpeech");
  const generateStart = workerSource.indexOf("async function generateSpeech");
  const initializeSource = workerSource.slice(initializeStart, generateStart);
  const generateSource = workerSource.slice(
    generateStart,
    workerSource.indexOf("async function handleRequest", generateStart),
  );
  const loadModelStart = workerSource.indexOf("async function loadModel");
  const loadModelSource = workerSource.slice(loadModelStart, initializeStart);

  const count = (source, expression) =>
    Array.from(source.matchAll(expression)).length;

  assert.equal(count(initializeSource, /await selectBackend\(/gu), 1);
  assert.equal(
    count(
      initializeSource,
      /assertOfflineFilesAvailable\(voice, selectedBackend\)/gu,
    ),
    1,
  );
  assert.match(initializeSource, /loadModel\(id,[\s\S]*selectedBackend/u);

  assert.equal(count(generateSource, /await selectBackend\(/gu), 1);
  assert.equal(
    count(
      generateSource,
      /assertOfflineFilesAvailable\(voice, selectedBackend\)/gu,
    ),
    1,
  );
  assert.match(generateSource, /loadModel\(id,[\s\S]*selectedBackend/u);

  assert.match(loadModelSource, /suppliedBackend \?\?/u);
  assert.equal(count(loadModelSource, /await selectBackend\(/gu), 1);
  assert.doesNotMatch(
    loadModelSource,
    /assertOfflineFilesAvailable\(OFFLINE_VOICES\[0\]\.value/u,
  );
});

test("keeps the validation receipt private to Cache Storage", () => {
  assert.equal(OFFLINE_FP16_READY_MARKER_VERSION, "fp16-ready-v1");
  assert.match(OFFLINE_FP16_READY_MARKER_URL, /Kokoro-82M/u);
  assert.equal(resolveOfflineModelRequest(OFFLINE_FP16_READY_MARKER_URL), null);
});

test("shares one stable cache for the retained speech runtime", async () => {
  const serviceWorkerSource = await readFile("public/sw-v9.js", "utf8");

  assert.equal(OFFLINE_RUNTIME_CACHE_NAME, "linelight-assets-v1");
  assert.match(
    serviceWorkerSource,
    /const CACHE_NAME = "linelight-assets-v1";/u,
  );
});

test("only resolves pinned, allowlisted offline model assets", () => {
  const allowed = resolveOfflineModelRequest(
    `${OFFLINE_MODEL_ROUTE_PREFIX}${OFFLINE_WEBGPU_MODEL_FILE}`,
  );

  assert.ok(allowed);
  assert.match(allowed.upstreamUrl, new RegExp(OFFLINE_MODEL_REVISION));
  assert.equal(
    resolveOfflineModelRequest(
      `${OFFLINE_MODEL_ROUTE_PREFIX}../../private.txt`,
    ),
    null,
  );
  assert.equal(
    resolveOfflineModelRequest(
      "/offline-model/someone-else/arbitrary-model/model.onnx",
    ),
    null,
  );
  assert.ok(
    resolveOfflineModelRequest(
      `${OFFLINE_MODEL_ROUTE_PREFIX}${OFFLINE_LEGACY_Q8_MODEL_FILE}`,
    ),
  );
});

test("streams model files without duplicating the browser cache", async () => {
  let upstreamRequest;
  const response = await handleOfflineModelRequest(
    new Request(
      `https://linelight.example${OFFLINE_MODEL_ROUTE_PREFIX}config.json`,
    ),
    async (request) => {
      upstreamRequest = request;
      return new Response('{"model_type":"kokoro"}', {
        headers: {
          "Content-Length": "23",
          "Content-Type": "application/json",
          ETag: '"model-etag"',
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.ok(upstreamRequest);
  assert.match(upstreamRequest.url, new RegExp(OFFLINE_MODEL_REVISION));
  assert.equal(
    response.headers.get("cache-control"),
    "no-store",
  );
  assert.equal(
    response.headers.get("cdn-cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    response.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
  assert.equal(response.headers.get("etag"), '"model-etag"');
  assert.equal(await response.text(), '{"model_type":"kokoro"}');
});

test("forwards bounded model range requests", async () => {
  let upstreamRequest;
  const response = await handleOfflineModelRequest(
    new Request(
      `https://linelight.example${OFFLINE_MODEL_ROUTE_PREFIX}onnx/model_quantized.onnx`,
      { headers: { Range: "bytes=0-7" } },
    ),
    async (request) => {
      upstreamRequest = request;
      return new Response(new Uint8Array(8), {
        status: 206,
        headers: {
          "Content-Length": "8",
          "Content-Range": "bytes 0-7/92361116",
          "Content-Type": "application/octet-stream",
        },
      });
    },
  );

  assert.ok(upstreamRequest);
  assert.equal(upstreamRequest.headers.get("range"), "bytes=0-7");
  assert.equal(response.status, 206);
  assert.equal(
    response.headers.get("content-range"),
    "bytes 0-7/92361116",
  );
  assert.equal((await response.arrayBuffer()).byteLength, 8);
});

test("does not proxy unknown model paths", async () => {
  let fetchCalled = false;
  const response = await handleOfflineModelRequest(
    new Request("https://linelight.example/offline-model/private.txt"),
    async () => {
      fetchCalled = true;
      return new Response("unexpected");
    },
  );

  assert.equal(response.status, 404);
  assert.equal(fetchCalled, false);
});

test("only permits read requests for model assets", async () => {
  const response = await handleOfflineModelRequest(
    new Request(
      `https://linelight.example${OFFLINE_MODEL_ROUTE_PREFIX}config.json`,
      { method: "POST" },
    ),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});
