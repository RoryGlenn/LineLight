import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NARRATION_ENGINE,
  NARRATION_PREFERENCE_VERSION,
  allowsDeviceFallback,
  restoreNarrationPreference,
} from "../app/narration-defaults.mjs";
import {
  OFFLINE_MODEL_DTYPE,
  OFFLINE_MODEL_REVISION,
  OFFLINE_MODEL_ROUTE_PREFIX,
  OFFLINE_MODEL_RUNTIME,
  OFFLINE_WASM_PROXY,
  OFFLINE_WASM_THREADS,
  resolveOfflineModelRequest,
} from "../app/offline-model-manifest.mjs";
import { handleOfflineModelRequest } from "../worker/offline-model.mjs";

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
});

test("never silently falls back from offline narration to browser speech", () => {
  assert.equal(allowsDeviceFallback("offline"), false);
  assert.equal(allowsDeviceFallback("azure"), true);
});

test("pairs the included q8 model with the compatible WASM runtime", () => {
  assert.equal(OFFLINE_MODEL_DTYPE, "q8");
  assert.equal(OFFLINE_MODEL_RUNTIME, "wasm");
  assert.equal(OFFLINE_WASM_THREADS, 1);
  assert.equal(OFFLINE_WASM_PROXY, false);
});

test("only resolves pinned, allowlisted offline model assets", () => {
  const allowed = resolveOfflineModelRequest(
    `${OFFLINE_MODEL_ROUTE_PREFIX}onnx/model_quantized.onnx`,
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
});

test("streams included model files with immutable first-party headers", async () => {
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
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    response.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
  assert.equal(response.headers.get("etag"), '"model-etag"');
  assert.equal(await response.text(), '{"model_type":"kokoro"}');
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
