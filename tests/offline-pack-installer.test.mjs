import assert from "node:assert/strict";
import test from "node:test";

import { ensureCachedOfflineAsset } from "../app/offline-pack-installer.mjs";

function memoryCache({ failPut = false, retainPut = true } = {}) {
  const entries = new Map();
  return {
    entries,
    async match(key) {
      return entries.get(key);
    },
    async put(key, response) {
      if (failPut) throw new Error("quota exceeded");
      if (retainPut) entries.set(key, response);
    },
  };
}

test("downloads an offline asset once under its runtime cache key", async () => {
  const cache = memoryCache();
  let fetchCount = 0;
  const fetchAsset = async (url) => {
    fetchCount += 1;
    assert.equal(url, "/offline-model/model.onnx");
    return new Response("model");
  };

  assert.equal(
    await ensureCachedOfflineAsset({
      cache,
      cacheUrl: "https://runtime.example/model.onnx",
      fetchAsset,
      label: "The included neural voice model",
      sourceUrl: "/offline-model/model.onnx",
    }),
    true,
  );
  assert.ok(cache.entries.has("https://runtime.example/model.onnx"));

  assert.equal(
    await ensureCachedOfflineAsset({
      cache,
      cacheUrl: "https://runtime.example/model.onnx",
      fetchAsset,
      label: "The included neural voice model",
      sourceUrl: "/offline-model/model.onnx",
    }),
    false,
  );
  assert.equal(fetchCount, 1);
});

test("reports download, storage, and retention failures precisely", async () => {
  await assert.rejects(
    ensureCachedOfflineAsset({
      cache: memoryCache(),
      cacheUrl: "model",
      fetchAsset: async () => new Response("missing", { status: 503 }),
      label: "The included neural voice model",
      sourceUrl: "model",
    }),
    /HTTP 503/u,
  );

  await assert.rejects(
    ensureCachedOfflineAsset({
      cache: memoryCache({ failPut: true }),
      cacheUrl: "model",
      fetchAsset: async () => new Response("model"),
      label: "The included neural voice model",
      sourceUrl: "model",
    }),
    /Free at least 100 MB of site storage/u,
  );

  await assert.rejects(
    ensureCachedOfflineAsset({
      cache: memoryCache({ retainPut: false }),
      cacheUrl: "model",
      fetchAsset: async () => new Response("model"),
      label: "The included neural voice model",
      sourceUrl: "model",
    }),
    /did not retain the included neural voice model/u,
  );
});
