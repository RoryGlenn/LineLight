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
  OFFLINE_MODEL_ASSETS,
  OFFLINE_MODEL_BYTES,
  OFFLINE_DEFAULT_VOICE,
  OFFLINE_MODEL_READY_MARKER_URL,
  OFFLINE_MODEL_READY_MARKER_VERSION,
  OFFLINE_RETIRED_MODEL_READY_MARKER_URLS,
  OFFLINE_MODEL_REVISION,
  OFFLINE_MODEL_ROUTE_PREFIX,
  OFFLINE_MODEL_RUNTIME,
  OFFLINE_OUTPUT_SAMPLE_RATE,
  OFFLINE_RUNTIME_CACHE_NAME,
  OFFLINE_VOICE_ASSETS,
  OFFLINE_VOICE_BYTES,
  OFFLINE_WEBGPU_ADAPTER_TIMEOUT_MS,
  OFFLINE_WASM_PROXY,
  OFFLINE_WASM_THREADS,
  constrainOfflineBackendPreference,
  nextOfflineSpeechBackend,
  normalizeOfflineVoiceId,
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

test("migrates former voices to a valid 44.1 kHz studio style", () => {
  assert.equal(OFFLINE_DEFAULT_VOICE, "F4");
  assert.equal(normalizeOfflineVoiceId("F2"), "F4");
  assert.equal(normalizeOfflineVoiceId("M1"), "M2");
  assert.equal(normalizeOfflineVoiceId("M4"), "M2");
  assert.equal(normalizeOfflineVoiceId("am_michael"), "M2");
  assert.equal(normalizeOfflineVoiceId("bm_george"), "M2");
  assert.equal(normalizeOfflineVoiceId("af_heart"), "F4");
  assert.equal(normalizeOfflineVoiceId(null), "F4");
});

test("offers one plain-language female and male offline voice", async () => {
  const [configSource, pageSource] = await Promise.all([
    readFile("app/offline-speech-config.ts", "utf8"),
    readFile("app/page.tsx", "utf8"),
  ]);

  assert.equal(
    Array.from(configSource.matchAll(/value: "[FM]\d"/gu)).length,
    2,
  );
  assert.match(configSource, /value: "F4",[\s\S]*label: "Female"/u);
  assert.match(configSource, /value: "M2",[\s\S]*label: "Male"/u);
  assert.doesNotMatch(configSource, /label: "Studio [FM]\d"/u);
  assert.match(pageSource, /One female and one male voice are available/u);
  assert.match(
    pageSource,
    /warm female voice at a conversational pace/u,
  );
  assert.doesNotMatch(pageSource, /warm Heart voice at a relaxed pace/u);
  assert.match(
    configSource,
    /OFFLINE_VOICE_CACHE_NAME = "linelight-offline-voices-v5"/u,
  );
  assert.match(configSource, /"linelight-offline-voices-v4"/u);
  assert.match(configSource, /"linelight-offline-voices-v3"/u);
  assert.match(configSource, /"linelight-offline-voices-v2"/u);
});

test("pairs the native 44.1 kHz model with a safe runtime ladder", () => {
  assert.equal(OFFLINE_MODEL_DTYPE, "fp32");
  assert.equal(OFFLINE_MODEL_BYTES, 398_361_202);
  assert.equal(OFFLINE_VOICE_BYTES, 583_863);
  assert.equal(OFFLINE_OUTPUT_SAMPLE_RATE, 44_100);
  assert.equal(OFFLINE_MODEL_ASSETS.length, 6);
  assert.deepEqual(
    OFFLINE_VOICE_ASSETS.map((voice) => voice.id),
    ["F4", "M2"],
  );
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

test("uses the reviewed float32 model on every backend", () => {
  assert.equal(selectOfflineModelDtype(), "fp32");
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

test("validates native audio before committing the installed model", async () => {
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
    /const warm = message\.warm !== false;[\s\S]*initializeSpeech\([\s\S]*if \(warm\) \{[\s\S]*retainOfflineSpeechRuntime/u,
  );
  assert.match(
    workerSource,
    /installModelFiles[\s\S]*installVoices[\s\S]*initializeSpeech[\s\S]*retainOfflineSpeechRuntime\(\)[\s\S]*commitOfflineModelReadyMarker[\s\S]*removeRetiredOfflineVoicePacks/u,
  );
  assert.match(
    workerSource,
    /OFFLINE_RETIRED_VOICE_CACHE_NAMES\.map\(\(cacheName\) =>[\s\S]*caches\.delete\(cacheName\)/u,
  );
  assert.match(
    workerSource,
    /OFFLINE_RETIRED_MODEL_READY_MARKER_URLS\.map\([\s\S]*getModelCache\(\)[\s\S]*delete\(cacheUrl\)/u,
  );
  assert.match(workerSource, /style,[\s\S]*steps: SUPERTONIC_SYNTHESIS_STEPS/u);
  assert.doesNotMatch(workerSource, /invalidateOfflineModelReadyMarker/u);
});

test("requires the complete reviewed model before WebGPU selection", async () => {
  const workerSource = await readFile("app/offline-speech.worker.ts", "utf8");
  const start = workerSource.indexOf("const webGpuAvailable =");
  const selection = workerSource.slice(
    start,
    workerSource.indexOf("const selectedBackend =", start),
  );

  assert.match(selection, /hasCompleteModelPack/u);
  assert.match(selection, /hasWebGpuAdapter/u);
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
      /assertOfflineFilesAvailable\(voice\)/gu,
    ),
    1,
  );
  assert.match(initializeSource, /loadModel\(id,[\s\S]*selectedBackend/u);

  assert.equal(count(generateSource, /await selectBackend\(/gu), 1);
  assert.equal(
    count(
      generateSource,
      /assertOfflineFilesAvailable\(voice\)/gu,
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
  assert.equal(
    OFFLINE_MODEL_READY_MARKER_VERSION,
    "supertonic-3-44100-reference-voices-ready-v4",
  );
  assert.match(OFFLINE_MODEL_READY_MARKER_URL, /supertonic-3/u);
  assert.equal(resolveOfflineModelRequest(OFFLINE_MODEL_READY_MARKER_URL), null);
  assert.deepEqual(
    OFFLINE_RETIRED_MODEL_READY_MARKER_URLS.map((url) =>
      url.slice(OFFLINE_MODEL_ROUTE_PREFIX.length),
    ),
    [
      "__linelight_supertonic-3-44100-reference-voices-ready-v3",
      "__linelight_supertonic-3-44100-two-voices-ready-v2",
      "__linelight_supertonic-3-44100-ready-v1",
    ],
  );
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
    `${OFFLINE_MODEL_ROUTE_PREFIX}onnx/vector_estimator.onnx`,
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
  assert.equal(
    resolveOfflineModelRequest(
      `${OFFLINE_MODEL_ROUTE_PREFIX}onnx/model_quantized.onnx`,
    ),
    null,
  );
});

test("streams model files without duplicating the browser cache", async () => {
  let upstreamRequest;
  const response = await handleOfflineModelRequest(
    new Request(
      `https://linelight.example${OFFLINE_MODEL_ROUTE_PREFIX}onnx/tts.json`,
    ),
    async (request) => {
      upstreamRequest = request;
      return new Response('{"tts_version":"v1.7.3"}', {
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
  assert.equal(await response.text(), '{"tts_version":"v1.7.3"}');
});

test("forwards bounded model range requests", async () => {
  let upstreamRequest;
  const response = await handleOfflineModelRequest(
    new Request(
      `https://linelight.example${OFFLINE_MODEL_ROUTE_PREFIX}onnx/vector_estimator.onnx`,
      { headers: { Range: "bytes=0-7" } },
    ),
    async (request) => {
      upstreamRequest = request;
      return new Response(new Uint8Array(8), {
        status: 206,
        headers: {
          "Content-Length": "8",
          "Content-Range": "bytes 0-7/256534781",
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
    "bytes 0-7/256534781",
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
      `https://linelight.example${OFFLINE_MODEL_ROUTE_PREFIX}onnx/tts.json`,
      { method: "POST" },
    ),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});
