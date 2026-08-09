import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureCachedOfflineAsset,
  getCachedOfflineAssetRetainedBytes,
  getCachedOfflineAssetResponse,
  isCachedOfflineAssetComplete,
} from "../app/offline-pack-installer.mjs";
import {
  commitOfflineModelReadyMarker,
  createOfflineModelCacheAdapter,
  deleteOfflineModelArtifactEntries,
  deleteOfflineModelEntriesByIdentifier,
  hasOfflineModelReadyMarker,
  retainOfflineRuntimeAssets,
} from "../app/offline-model-cache.mjs";

function memoryCache({
  failPut = false,
  onPut,
  putError,
  retainPut = true,
} = {}) {
  const entries = new Map();
  return {
    entries,
    async delete(key) {
      return entries.delete(typeof key === "string" ? key : key.url);
    },
    async keys() {
      return [...entries.keys()].map((key) => new Request(key));
    },
    async match(key) {
      return entries.get(key)?.clone();
    },
    async put(key, response) {
      if (putError) throw putError;
      if (
        typeof failPut === "function"
          ? failPut(key)
          : failPut
      ) {
        throw new Error("cache unavailable");
      }
      const retainedResponse = response.clone();
      await response.arrayBuffer();
      if (retainPut) entries.set(key, retainedResponse);
      await onPut?.(key, retainedResponse.clone());
    },
  };
}

function requestedRange(init) {
  const match = /^bytes=(\d+)-(\d+)$/u.exec(init.headers.Range);
  assert.ok(match);
  return {
    end: Number(match[2]),
    start: Number(match[1]),
  };
}

function rangeResponse(source, { end, start }) {
  return new Response(source.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${source.byteLength}`,
      "Content-Type": "application/octet-stream",
    },
  });
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

test("repairs a truncated whole asset and records its verified byte size", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://runtime.example/voice.bin";
  const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
  let fetchCount = 0;
  cache.entries.set(
    cacheUrl,
    new Response(source.slice(0, 2), {
      headers: { "Content-Length": "2" },
    }),
  );

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async () => {
      fetchCount += 1;
      return new Response(source);
    },
    label: "The included Heart voice",
    sourceUrl: "/offline-model/voices/af_heart.bin",
  });

  const retained = cache.entries.get(cacheUrl);
  assert.equal(fetchCount, 1);
  assert.equal(retained.headers.get("content-length"), "6");
  assert.deepEqual(
    new Uint8Array(await retained.clone().arrayBuffer()),
    source,
  );
  assert.equal(
    await isCachedOfflineAssetComplete({
      cache,
      cacheUrl,
      expectedBytes: source.byteLength,
    }),
    true,
  );

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async () => {
      throw new Error("a verified asset must not be downloaded again");
    },
    label: "The included Heart voice",
    sourceUrl: "/offline-model/voices/af_heart.bin",
  });
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
      return rangeResponse(source, requestedRange(init));
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
  assert.equal(
    await isCachedOfflineAssetComplete({
      cache,
      cacheUrl: "https://runtime.example/model.onnx",
      expectedBytes: source.byteLength,
      rangeChunkBytes: 4,
    }),
    true,
  );
  const finalResponse = await getCachedOfflineAssetResponse({
    cache,
    cacheUrl: "https://runtime.example/model.onnx",
    expectedBytes: source.byteLength,
    rangeChunkBytes: 4,
  });
  assert.ok(finalResponse);
  assert.deepEqual(
    new Uint8Array(await finalResponse.arrayBuffer()),
    source,
  );
  assert.deepEqual(
    new Uint8Array(await cached.arrayBuffer()),
    source,
  );
  assert.deepEqual([...cache.entries.keys()], [
    "https://runtime.example/model.onnx",
  ]);
});

test("repairs a truncated canonical model instead of trusting its presence", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://runtime.example/truncated-model.onnx";
  const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
  cache.entries.set(
    cacheUrl,
    new Response(source.slice(0, 2), {
      headers: { "Content-Length": "2" },
    }),
  );

  assert.equal(
    await isCachedOfflineAssetComplete({
      cache,
      cacheUrl,
      expectedBytes: source.byteLength,
      rangeChunkBytes: 3,
    }),
    false,
  );
  assert.equal(cache.entries.has(cacheUrl), false);

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) =>
      rangeResponse(source, requestedRange(init)),
    label: "The included neural voice model",
    rangeBacked: true,
    rangeChunkBytes: 3,
    sourceUrl: "/offline-model/model.onnx",
  });

  assert.equal(
    await isCachedOfflineAssetComplete({
      cache,
      cacheUrl,
      expectedBytes: source.byteLength,
      rangeChunkBytes: 3,
    }),
    true,
  );
  assert.equal(cache.entries.has(cacheUrl), false);
});

test("serves absolute and relative model keys from ranges without a full put", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://app.example/offline-model/model.onnx";
  const source = new Uint8Array([9, 8, 7, 6, 5, 4]);
  await ensureCachedOfflineAsset({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) =>
      rangeResponse(source, requestedRange(init)),
    label: "The included neural voice model",
    rangeBacked: true,
    rangeChunkBytes: 3,
    sourceUrl: cacheUrl,
  });
  const adapter = createOfflineModelCacheAdapter({
    baseUrl: "https://app.example",
    getCache: async () => cache,
    models: [{ cacheUrl, expectedBytes: source.byteLength }],
    rangeChunkBytes: 3,
  });

  for (const key of [
    "/offline-model/model.onnx",
    new Request(cacheUrl),
  ]) {
    const response = await adapter.match(key);
    assert.ok(response);
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      source,
    );
  }

  await adapter.put(cacheUrl, new Response(source));
  assert.equal(cache.entries.has(cacheUrl), false);
  assert.equal(
    [...cache.entries.keys()].filter((key) => key.includes("offline_range"))
      .length,
    2,
  );
});

test("serves a current model request from a complete legacy cache key", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://app.example/offline-model/model_quantized.onnx";
  const legacyUrl =
    "https://models.example/resolve/main/onnx/model_quantized.onnx";
  const source = new Uint8Array([4, 3, 2, 1]);
  await ensureCachedOfflineAsset({
    cache,
    cacheUrl: legacyUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) =>
      rangeResponse(source, requestedRange(init)),
    label: "The stored compatibility model",
    rangeBacked: true,
    rangeChunkBytes: 2,
    sourceUrl: legacyUrl,
  });
  const adapter = createOfflineModelCacheAdapter({
    baseUrl: "https://app.example",
    getCache: async () => cache,
    models: [
      {
        cacheUrl,
        expectedBytes: source.byteLength,
        fallbackCacheUrls: [legacyUrl],
      },
    ],
    rangeChunkBytes: 2,
  });

  const response = await adapter.match(cacheUrl);
  assert.ok(response);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), source);
});

test("serves setup requests from legacy direct cache keys", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://app.example/offline-model/config.json";
  const legacyUrl = "https://models.example/resolve/main/config.json";
  cache.entries.set(
    legacyUrl,
    new Response('{"model_type":"style_text_to_speech_2"}'),
  );
  const adapter = createOfflineModelCacheAdapter({
    aliases: [{ cacheUrl, fallbackCacheUrls: [legacyUrl] }],
    baseUrl: "https://app.example",
    getCache: async () => cache,
    models: [],
    rangeChunkBytes: 2,
  });

  const response = await adapter.match(cacheUrl);
  assert.ok(response);
  assert.match(await response.text(), /style_text_to_speech_2/u);
});

test("requires every compatibility-model cache entry to be removed", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://app.example/offline-model/model_quantized.onnx";
  const rangeUrl = `${cacheUrl}?__linelight_offline_range=0`;
  const siblingUrl = "https://app.example/offline-model/model_fp16.onnx";
  cache.entries.set(cacheUrl, new Response("q8"));
  cache.entries.set(rangeUrl, new Response("range"));
  cache.entries.set(siblingUrl, new Response("fp16"));

  await deleteOfflineModelArtifactEntries({
    baseUrl: "https://app.example",
    cache,
    cacheUrl,
  });
  assert.equal(cache.entries.has(cacheUrl), false);
  assert.equal(cache.entries.has(rangeUrl), false);
  assert.equal(cache.entries.has(siblingUrl), true);

  cache.entries.set(rangeUrl, new Response("range"));
  const normalDelete = cache.delete;
  cache.delete = async (key) => {
    const url = typeof key === "string" ? key : key.url;
    if (url === rangeUrl) return false;
    return normalDelete.call(cache, key);
  };
  await assert.rejects(
    deleteOfflineModelArtifactEntries({
      baseUrl: "https://app.example",
      cache,
      cacheUrl,
    }),
    /could not be removed/u,
  );
});

test("strictly removes every entry for an offline pack", async () => {
  const cache = memoryCache();
  const modelIdentifier = "onnx-community/Kokoro-82M";
  const modelUrl = `https://app.example/${modelIdentifier}/model.onnx`;
  const markerUrl = `https://app.example/${modelIdentifier}/ready-v1`;
  const unrelatedUrl = "https://app.example/other/model.onnx";
  cache.entries.set(modelUrl, new Response("model"));
  cache.entries.set(markerUrl, new Response("ready"));
  cache.entries.set(unrelatedUrl, new Response("other"));

  await deleteOfflineModelEntriesByIdentifier({ cache, modelIdentifier });
  assert.deepEqual([...cache.entries.keys()], [unrelatedUrl]);

  cache.entries.set(modelUrl, new Response("model"));
  cache.delete = async () => false;
  await assert.rejects(
    deleteOfflineModelEntriesByIdentifier({ cache, modelIdentifier }),
    /could not be completely removed/u,
  );
});

test("commits and validates model readiness", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://app.example/offline-model/ready-v1";
  const value = "fp16-ready-v1";

  assert.equal(
    await hasOfflineModelReadyMarker({ cache, cacheUrl, value }),
    false,
  );
  await commitOfflineModelReadyMarker({ cache, cacheUrl, value });
  assert.equal(
    await hasOfflineModelReadyMarker({ cache, cacheUrl, value }),
    true,
  );
  assert.equal(
    await hasOfflineModelReadyMarker({
      cache,
      cacheUrl,
      value: "fp16-ready-v2",
    }),
    false,
  );

});

test("rejects a readiness commit the cache did not retain", async () => {
  const cache = memoryCache({ retainPut: false });
  await assert.rejects(
    commitOfflineModelReadyMarker({
      cache,
      cacheUrl: "https://app.example/offline-model/ready-v1",
      value: "fp16-ready-v1",
    }),
    /could not be retained/u,
  );
});

test("retains and verifies the worker and WASM runtime before ready", async () => {
  const cache = memoryCache();
  const assets = [
    {
      cacheUrl: "https://app.example/assets/offline-worker.js",
      expectedContentType: "javascript",
      label: "The offline voice worker",
    },
    {
      cacheUrl: "https://app.example/assets/ort.wasm",
      expectedContentType: "application/wasm",
      label: "The offline voice runtime",
    },
  ];
  const requested = [];
  await retainOfflineRuntimeAssets({
    assets,
    cache,
    fetchAsset: async (url, init) => {
      requested.push({ init, url });
      return new Response("runtime", {
        headers: {
          "Content-Type": url.endsWith(".wasm")
            ? "application/wasm"
            : "application/javascript",
        },
      });
    },
  });
  assert.deepEqual(
    requested.map(({ init, url }) => [url, init.cache]),
    assets.map(({ cacheUrl }) => [cacheUrl, "force-cache"]),
  );

  await retainOfflineRuntimeAssets({
    assets,
    cache,
    fetchAsset: async () => {
      throw new Error("verified runtime assets must not be fetched again");
    },
  });
});

test("rejects a runtime asset with the wrong content type", async () => {
  await assert.rejects(
    retainOfflineRuntimeAssets({
      assets: [
        {
          cacheUrl: "https://app.example/assets/ort.wasm",
          expectedContentType: "application/wasm",
          label: "The offline voice runtime",
        },
      ],
      cache: memoryCache(),
      fetchAsset: async () =>
        new Response("not wasm", {
          headers: { "Content-Type": "text/html" },
        }),
    }),
    /could not be stored for offline use/u,
  );
});

test("keeps complete ranges as the canonical asset in range-backed mode", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://runtime.example/range-backed.onnx";
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const snapshots = [];

  assert.equal(
    await ensureCachedOfflineAsset({
      cache,
      cacheUrl,
      expectedBytes: source.byteLength,
      fetchAsset: async (_url, init) =>
        rangeResponse(source, requestedRange(init)),
      label: "The included neural voice model",
      onDownloadProgress: (snapshot) => snapshots.push(snapshot),
      rangeBacked: true,
      rangeChunkBytes: 4,
      rangeConcurrency: 1,
      sourceUrl: "/offline-model/model.onnx",
    }),
    true,
  );

  assert.equal(await cache.match(cacheUrl), undefined);
  assert.equal(cache.entries.size, 3);
  assert.equal(
    await isCachedOfflineAssetComplete({
      cache,
      cacheUrl,
      expectedBytes: source.byteLength,
      rangeChunkBytes: 4,
    }),
    true,
  );
  assert.deepEqual(snapshots, [
    { done: false, loaded: 0, total: 10 },
    { done: false, loaded: 4, total: 10 },
    { done: false, loaded: 8, total: 10 },
    { done: true, loaded: 10, total: 10 },
  ]);
});

test("streams a normal response from a complete range-backed asset", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://runtime.example/range-response.onnx";
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) =>
      rangeResponse(source, requestedRange(init)),
    label: "The included neural voice model",
    rangeBacked: true,
    rangeChunkBytes: 4,
    rangeConcurrency: 1,
    sourceUrl: "/offline-model/model.onnx",
  });

  const response = await getCachedOfflineAssetResponse({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    rangeChunkBytes: 4,
  });
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "10");
  assert.equal(response.headers.get("content-range"), null);
  assert.equal(response.headers.get("x-linelight-range-start"), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), source);
  assert.equal(cache.entries.size, 3);
  assert.equal(await cache.match(cacheUrl), undefined);
});

test("recognizes a complete range-backed asset after reload", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://runtime.example/range-reload.onnx";
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) =>
      rangeResponse(source, requestedRange(init)),
    label: "The included neural voice model",
    rangeBacked: true,
    rangeChunkBytes: 4,
    rangeConcurrency: 1,
    sourceUrl: "/offline-model/model.onnx",
  });

  let fetchCount = 0;
  assert.equal(
    await ensureCachedOfflineAsset({
      cache,
      cacheUrl,
      expectedBytes: source.byteLength,
      fetchAsset: async () => {
        fetchCount += 1;
        throw new Error("complete retained ranges should not be fetched");
      },
      label: "The included neural voice model",
      rangeBacked: true,
      rangeChunkBytes: 4,
      rangeConcurrency: 1,
      sourceUrl: "/offline-model/model.onnx",
    }),
    false,
  );

  assert.equal(fetchCount, 0);
  assert.equal(cache.entries.size, 2);
  assert.equal(await cache.match(cacheUrl), undefined);
});

test("resumes from ranges retained by an interrupted install", async () => {
  const cache = memoryCache();
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const firstRunRequests = [];

  await assert.rejects(
    ensureCachedOfflineAsset({
      cache,
      cacheUrl: "https://runtime.example/resumable.onnx",
      expectedBytes: source.byteLength,
      fetchAsset: async (_url, init) => {
        const range = requestedRange(init);
        firstRunRequests.push(range);
        if (range.start === 8) {
          throw new Error("connection interrupted");
        }
        return rangeResponse(source, range);
      },
      label: "The included neural voice model",
      rangeChunkBytes: 4,
      rangeConcurrency: 1,
      sourceUrl: "/offline-model/model.onnx",
    }),
    /could not be downloaded completely/u,
  );

  assert.deepEqual(firstRunRequests, [
    { end: 3, start: 0 },
    { end: 7, start: 4 },
    { end: 9, start: 8 },
    { end: 9, start: 8 },
  ]);
  assert.equal(cache.entries.size, 2);
  assert.equal(
    await getCachedOfflineAssetRetainedBytes({
      cache,
      cacheUrl: "https://runtime.example/resumable.onnx",
      expectedBytes: source.byteLength,
      rangeChunkBytes: 4,
    }),
    8,
  );
  assert.equal(
    await isCachedOfflineAssetComplete({
      cache,
      cacheUrl: "https://runtime.example/resumable.onnx",
      expectedBytes: source.byteLength,
      rangeChunkBytes: 4,
    }),
    false,
  );
  assert.equal(
    await getCachedOfflineAssetResponse({
      cache,
      cacheUrl: "https://runtime.example/resumable.onnx",
      expectedBytes: source.byteLength,
      rangeChunkBytes: 4,
    }),
    undefined,
  );

  const resumedRequests = [];
  const snapshots = [];
  await ensureCachedOfflineAsset({
    cache,
    cacheUrl: "https://runtime.example/resumable.onnx",
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) => {
      const range = requestedRange(init);
      resumedRequests.push(range);
      return rangeResponse(source, range);
    },
    label: "The included neural voice model",
    onDownloadProgress: (snapshot) => snapshots.push(snapshot),
    rangeChunkBytes: 4,
    rangeConcurrency: 1,
    sourceUrl: "/offline-model/model.onnx",
  });

  assert.deepEqual(resumedRequests, [{ end: 9, start: 8 }]);
  assert.deepEqual(snapshots, [
    { done: false, loaded: 8, total: 10 },
    { done: true, loaded: 10, total: 10 },
  ]);
  assert.deepEqual([...cache.entries.keys()], [
    "https://runtime.example/resumable.onnx",
  ]);
  assert.deepEqual(
    new Uint8Array(
      await cache.entries
        .get("https://runtime.example/resumable.onnx")
        .arrayBuffer(),
    ),
    source,
  );
});

test("downloads at most one unfinished range by default", async () => {
  const cache = memoryCache();
  const source = new Uint8Array(20).map((_value, index) => index + 1);
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let requestCount = 0;

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl: "https://runtime.example/parallel.onnx",
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) => {
      requestCount += 1;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      const range = requestedRange(init);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRequests -= 1;
      return rangeResponse(source, range);
    },
    label: "The included neural voice model",
    rangeChunkBytes: 4,
    sourceUrl: "/offline-model/model.onnx",
  });

  assert.equal(requestCount, 5);
  assert.equal(maxActiveRequests, 1);
});

test("caps explicitly parallel range downloads", async () => {
  const cache = memoryCache();
  const source = new Uint8Array(24).map((_value, index) => index + 1);
  let activeRequests = 0;
  let maxActiveRequests = 0;

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl: "https://runtime.example/parallel-cap.onnx",
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      const range = requestedRange(init);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRequests -= 1;
      return rangeResponse(source, range);
    },
    label: "The included neural voice model",
    rangeChunkBytes: 4,
    rangeConcurrency: 99,
    sourceUrl: "/offline-model/model.onnx",
  });

  assert.equal(maxActiveRequests, 4);
});

test("abort retains completed ranges and starts no later default range", async () => {
  const cache = memoryCache();
  const source = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  ]);
  const controller = new AbortController();
  const abortError = new DOMException("Stop downloading", "AbortError");
  let requestCount = 0;

  await assert.rejects(
    ensureCachedOfflineAsset({
      cache,
      cacheUrl: "https://runtime.example/abortable.onnx",
      expectedBytes: source.byteLength,
      fetchAsset: async (_url, init) => {
        requestCount += 1;
        assert.equal(init.signal, controller.signal);
        const range = requestedRange(init);
        if (range.start === 4) {
          controller.abort(abortError);
          throw abortError;
        }
        return rangeResponse(source, range);
      },
      label: "The included neural voice model",
      rangeBacked: true,
      rangeChunkBytes: 4,
      signal: controller.signal,
      sourceUrl: "/offline-model/model.onnx",
    }),
    (error) => error === abortError,
  );

  assert.equal(requestCount, 2);
  assert.equal(cache.entries.size, 1);

  const resumedRequests = [];
  await ensureCachedOfflineAsset({
    cache,
    cacheUrl: "https://runtime.example/abortable.onnx",
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) => {
      const range = requestedRange(init);
      resumedRequests.push(range);
      return rangeResponse(source, range);
    },
    label: "The included neural voice model",
    rangeBacked: true,
    rangeChunkBytes: 4,
    sourceUrl: "/offline-model/model.onnx",
  });

  assert.deepEqual(resumedRequests, [
    { end: 7, start: 4 },
    { end: 11, start: 8 },
  ]);
});

test("removes staged ranges when a final response is already cached", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://runtime.example/final-and-ranges.onnx";
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) =>
      rangeResponse(source, requestedRange(init)),
    label: "The included neural voice model",
    rangeBacked: true,
    rangeChunkBytes: 4,
    sourceUrl: "/offline-model/model.onnx",
  });
  await cache.put(
    cacheUrl,
    new Response(source, {
      headers: { "Content-Length": String(source.byteLength) },
    }),
  );
  assert.equal(cache.entries.size, 3);

  assert.equal(
    await isCachedOfflineAssetComplete({
      cache,
      cacheUrl,
      expectedBytes: source.byteLength,
      rangeChunkBytes: 4,
    }),
    true,
  );
  assert.deepEqual([...cache.entries.keys()], [cacheUrl]);
});

test("removes obsolete range layouts before replacing them", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://runtime.example/range-layout.onnx";
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) =>
      rangeResponse(source, requestedRange(init)),
    label: "The included neural voice model",
    rangeBacked: true,
    rangeChunkBytes: 4,
    sourceUrl: "/offline-model/model.onnx",
  });
  assert.equal(cache.entries.size, 3);

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) =>
      rangeResponse(source, requestedRange(init)),
    label: "The included neural voice model",
    rangeBacked: true,
    rangeChunkBytes: 5,
    sourceUrl: "/offline-model/model.onnx",
  });

  assert.equal(cache.entries.size, 2);
  const response = await getCachedOfflineAssetResponse({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    rangeChunkBytes: 5,
  });
  assert.ok(response);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), source);
});

test("discards an unreadable retained range so retry can restore it", async () => {
  const cache = memoryCache();
  const cacheUrl = "https://runtime.example/unreadable-range.onnx";
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  await ensureCachedOfflineAsset({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) =>
      rangeResponse(source, requestedRange(init)),
    label: "The included neural voice model",
    rangeBacked: true,
    rangeChunkBytes: 4,
    sourceUrl: "/offline-model/model.onnx",
  });

  const [unreadableKey] = cache.entries.keys();
  const retainedHeaders = cache.entries.get(unreadableKey).headers;
  cache.entries.set(
    unreadableKey,
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("cached range is unreadable"));
        },
      }),
      { headers: retainedHeaders },
    ),
  );

  const unreadableResponse = await getCachedOfflineAssetResponse({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    rangeChunkBytes: 4,
  });
  assert.ok(unreadableResponse);
  await assert.rejects(
    unreadableResponse.arrayBuffer(),
    /cached range is unreadable/u,
  );
  assert.equal(cache.entries.has(unreadableKey), false);

  const resumedRequests = [];
  await ensureCachedOfflineAsset({
    cache,
    cacheUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async (_url, init) => {
      const range = requestedRange(init);
      resumedRequests.push(range);
      return rangeResponse(source, range);
    },
    label: "The included neural voice model",
    rangeBacked: true,
    rangeChunkBytes: 4,
    sourceUrl: "/offline-model/model.onnx",
  });

  assert.deepEqual(resumedRequests, [{ end: 3, start: 0 }]);
});

test("keeps staged ranges when committing the final response fails", async () => {
  const finalUrl = "https://runtime.example/final-retry.onnx";
  let failFinalPut = true;
  const cache = memoryCache({
    failPut: (key) => failFinalPut && key === finalUrl,
  });
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  await assert.rejects(
    ensureCachedOfflineAsset({
      cache,
      cacheUrl: finalUrl,
      expectedBytes: source.byteLength,
      fetchAsset: async (_url, init) =>
        rangeResponse(source, requestedRange(init)),
      label: "The included neural voice model",
      rangeChunkBytes: 4,
      rangeConcurrency: 1,
      sourceUrl: "/offline-model/model.onnx",
    }),
    /could not store the included neural voice model/u,
  );
  assert.equal(cache.entries.size, 2);

  failFinalPut = false;
  await ensureCachedOfflineAsset({
    cache,
    cacheUrl: finalUrl,
    expectedBytes: source.byteLength,
    fetchAsset: async () => {
      throw new Error("retained ranges should avoid another fetch");
    },
    label: "The included neural voice model",
    rangeChunkBytes: 4,
    rangeConcurrency: 1,
    sourceUrl: "/offline-model/model.onnx",
  });

  assert.deepEqual([...cache.entries.keys()], [finalUrl]);
  assert.deepEqual(
    new Uint8Array(await cache.entries.get(finalUrl).arrayBuffer()),
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
    /Free more site storage/u,
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
