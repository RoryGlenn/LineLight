import assert from "node:assert/strict";
import test from "node:test";

import { ensureCachedOfflineAsset } from "../app/offline-pack-installer.mjs";

function memoryCache({ failPut = false, putError, retainPut = true } = {}) {
  const entries = new Map();
  return {
    entries,
    async match(key) {
      return entries.get(key);
    },
    async put(key, response) {
      if (putError) throw putError;
      if (failPut) throw new Error("cache unavailable");
      const retainedResponse = response.clone();
      await response.arrayBuffer();
      if (retainPut) entries.set(key, retainedResponse);
    },
  };
}

test("downloads an offline asset once under its runtime cache key", async () => {
  const cache = memoryCache();
  let fetchCount = 0;
  const fetchAsset = async (url, init) => {
    fetchCount += 1;
    assert.equal(url, "/offline-model/model.onnx");
    assert.equal(init.cache, "no-store");
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

test("reports byte-level progress while the browser stores an asset", async () => {
  const cache = memoryCache();
  const snapshots = [];
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4, 5, 6]));
      controller.close();
    },
  });

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl: "https://runtime.example/model.onnx",
    fetchAsset: async () =>
      new Response(body, {
        headers: { "Content-Length": "6" },
      }),
    label: "The included neural voice model",
    onDownloadProgress: (snapshot) => snapshots.push(snapshot),
    sourceUrl: "/offline-model/model.onnx",
  });

  assert.deepEqual(snapshots, [
    { done: false, loaded: 0, total: 6 },
    { done: false, loaded: 2, total: 6 },
    { done: true, loaded: 6, total: 6 },
  ]);
});

test("downloads large assets in verified byte ranges", async () => {
  const cache = memoryCache();
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const requests = [];
  const snapshots = [];

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl: "https://runtime.example/model.onnx",
    expectedBytes: source.byteLength,
    fetchAsset: async (url, init) => {
      requests.push({ url, init });
      const match = /^bytes=(\d+)-(\d+)$/u.exec(init.headers.Range);
      assert.ok(match);
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(source.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${source.byteLength}`,
          "Content-Type": "application/octet-stream",
        },
      });
    },
    label: "The included neural voice model",
    onDownloadProgress: (snapshot) => snapshots.push(snapshot),
    rangeChunkBytes: 4,
    sourceUrl: "/offline-model/model.onnx",
  });

  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ init }) => init.cache === "no-store"));
  assert.deepEqual(snapshots, [
    { done: false, loaded: 0, total: 10 },
    { done: false, loaded: 4, total: 10 },
    { done: false, loaded: 8, total: 10 },
    { done: true, loaded: 10, total: 10 },
  ]);
  const cached = cache.entries.get("https://runtime.example/model.onnx");
  assert.ok(cached);
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get("content-range"), null);
  assert.deepEqual(
    new Uint8Array(await cached.arrayBuffer()),
    source,
  );
});

test("retries an interrupted response body before caching", async () => {
  const cache = memoryCache();
  let attempts = 0;

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl: "model",
    fetchAsset: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("connection interrupted"));
            },
          }),
        );
      }
      return new Response("model");
    },
    label: "The included neural voice model",
    sourceUrl: "model",
  });

  assert.equal(attempts, 2);
  assert.ok(cache.entries.has("model"));
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
    /Check site storage permissions/u,
  );

  await assert.rejects(
    ensureCachedOfflineAsset({
      cache: memoryCache({
        putError: new DOMException("quota exceeded", "QuotaExceededError"),
      }),
      cacheUrl: "model",
      fetchAsset: async () => new Response("model"),
      label: "The included neural voice model",
      sourceUrl: "model",
    }),
    /Free at least 200 MB/u,
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
