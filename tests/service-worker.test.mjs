import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  RUNTIME_ASSET_MANIFEST_URL,
  SERVICE_WORKER_URL,
  configureServiceWorker,
  getRuntimeAssetStorageDiagnostics,
} from "../app/service-worker-registration.mjs";

const SERVICE_WORKER_PATH = "public/sw-v9.js";
const ORIGIN = "https://linelight.example";
const STABLE_CACHE = "linelight-assets-v1";
const MODEL_CACHE = "linelight-offline-model-v2";
const VOICE_CACHE = "linelight-offline-voices-v4";
const RETAIN_RUNTIME_ASSETS = "linelight:retain-runtime-assets";
const RELEASE_RUNTIME_ASSETS = "linelight:release-runtime-assets";
const GET_RUNTIME_ASSET_DIAGNOSTICS =
  "linelight:get-runtime-asset-diagnostics";

function absoluteAsset(pathname) {
  return new URL(pathname, ORIGIN).href;
}

function manifest(deploymentId, assets) {
  return {
    version: 1,
    deploymentId,
    assets,
  };
}

function requestUrl(request) {
  return typeof request === "string" || request instanceof URL
    ? new URL(request, ORIGIN).href
    : request.url;
}

async function loadServiceWorker({
  initialCaches = {},
  liveClientIds = [],
} = {}) {
  const source = await readFile(SERVICE_WORKER_PATH, "utf8");
  const listeners = new Map();
  const cacheStore = new Map();
  const deletedCaches = [];
  const clientMessages = [];
  let claimed = false;
  let fetchRequest = async () => {
    throw new TypeError("offline");
  };
  let beforeStableCachePut = async () => {};
  let globalMatchedResponse;
  let globalMatchError;
  let failedDelete;
  let failedCacheDelete;
  let clients = new Map();

  const getCache = (name) => {
    if (cacheStore.has(name)) return cacheStore.get(name);
    const entries = new Map();
    const cache = {
      async delete(request) {
        const url = requestUrl(request);
        if (
          failedDelete?.cacheName === name &&
          failedDelete.url === url &&
          failedDelete.remaining > 0
        ) {
          failedDelete.remaining -= 1;
          return false;
        }
        return entries.delete(url);
      },
      async keys() {
        return Array.from(entries.keys(), (url) => new Request(url));
      },
      async match(request) {
        const response = entries.get(requestUrl(request));
        return response?.clone();
      },
      async put(request, response) {
        if (name === STABLE_CACHE) await beforeStableCachePut();
        entries.set(requestUrl(request), response.clone());
      },
      _entries: entries,
    };
    cacheStore.set(name, cache);
    return cache;
  };

  for (const [cacheName, entries] of Object.entries(initialCaches)) {
    const cache = getCache(cacheName);
    for (const [url, response] of entries) {
      cache._entries.set(requestUrl(url), response.clone());
    }
  }
  // These caches contain the 166 MB pack and are always outside runtime GC.
  getCache(MODEL_CACHE);
  getCache(VOICE_CACHE);

  const clientFor = (id) => ({
    id,
    postMessage(message) {
      clientMessages.push({ id, message });
    },
  });
  const setLiveClients = (ids) => {
    clients = new Map(ids.map((id) => [id, clientFor(id)]));
  };
  setLiveClients(liveClientIds);

  const caches = {
    async delete(name) {
      deletedCaches.push(name);
      if (failedCacheDelete?.name === name && failedCacheDelete.remaining > 0) {
        failedCacheDelete.remaining -= 1;
        return false;
      }
      return cacheStore.delete(name);
    },
    async keys() {
      return Array.from(cacheStore.keys());
    },
    async match(request) {
      if (globalMatchError) throw globalMatchError;
      if (globalMatchedResponse) return globalMatchedResponse.clone();
      for (const cache of cacheStore.values()) {
        const response = await cache.match(request);
        if (response) return response;
      }
      return undefined;
    },
    async open(name) {
      return getCache(name);
    },
  };
  const self = {
    location: { origin: ORIGIN },
    clients: {
      async claim() {
        claimed = true;
      },
      async matchAll() {
        return Array.from(clients.values());
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    async skipWaiting() {},
  };

  vm.runInNewContext(source, {
    Headers,
    Request,
    Response,
    URL,
    caches,
    fetch: (request) => fetchRequest(request),
    self,
  });

  return {
    cacheNames() {
      return Array.from(cacheStore.keys());
    },
    cacheUrls(name) {
      return Array.from(getCache(name)._entries.keys()).sort();
    },
    clientMessages,
    deletedCaches,
    failCacheDeleteOnce(name) {
      failedCacheDelete = { name, remaining: 1 };
    },
    failDeleteOnce(cacheName, url) {
      failedDelete = {
        cacheName,
        url: requestUrl(url),
        remaining: 1,
      };
    },
    listeners,
    async match(cacheName, url) {
      return getCache(cacheName).match(url);
    },
    async put(cacheName, url, response) {
      await getCache(cacheName).put(url, response);
    },
    setBeforeCachePut(nextBeforeCachePut) {
      beforeStableCachePut = nextBeforeCachePut;
    },
    setCacheMatchError(error) {
      globalMatchError = error;
    },
    setFetchRequest(nextFetch) {
      fetchRequest = nextFetch;
    },
    setLiveClients,
    setMatchedResponse(response) {
      globalMatchedResponse = response;
    },
    sourceClient(id) {
      return clients.get(id) ?? clientFor(id);
    },
    wasClaimed() {
      return claimed;
    },
  };
}

async function runWaitUntil(listener) {
  let completion;
  listener({
    waitUntil(value) {
      completion = Promise.resolve(value);
    },
  });
  await completion;
}

async function runMessage(runtime, data, sourceId, ports = []) {
  let completion;
  runtime.listeners.get("message")({
    data,
    ports,
    source: runtime.sourceClient(sourceId),
    waitUntil(value) {
      completion = Promise.resolve(value);
    },
  });
  await completion;
}

function startFetch(listener, request) {
  let responsePromise;
  let lifetime = Promise.resolve();
  listener({
    request,
    respondWith(value) {
      responsePromise = Promise.resolve(value);
    },
    waitUntil(value) {
      lifetime = Promise.resolve(value);
    },
  });
  return { lifetime, response: responsePromise };
}

async function runFetch(listener, request) {
  const pending = startFetch(listener, request);
  if (!pending.response) return undefined;
  const response = await pending.response;
  await pending.lifetime;
  return response;
}

function createRegistrationEnvironment({
  assets,
  manifestValue,
}) {
  const listeners = new Map();
  const documentListeners = new Map();
  let idleCallback;
  return {
    document: {
      visibilityState: "visible",
      addEventListener(type, listener) {
        documentListeners.set(type, listener);
      },
      removeEventListener(type) {
        documentListeners.delete(type);
      },
    },
    location: { origin: ORIGIN },
    performance: {
      timeOrigin: 1_000,
      getEntriesByType() {
        return assets.map((name) => ({ name }));
      },
    },
    async fetch(url, options) {
      assert.equal(url, RUNTIME_ASSET_MANIFEST_URL);
      assert.equal(options.cache, "no-store");
      return Response.json(manifestValue);
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    requestIdleCallback(callback) {
      idleCallback = callback;
      return 1;
    },
    cancelIdleCallback() {
      idleCallback = undefined;
    },
    runIdle() {
      const callback = idleCallback;
      idleCallback = undefined;
      callback?.();
    },
    setTimeout,
    clearTimeout,
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("the app uses the shared service worker registration policy", async () => {
  const pageSource = await readFile("app/page.tsx", "utf8");

  assert.match(pageSource, /configureServiceWorker\(navigator\.serviceWorker/);
  assert.match(pageSource, /development: import\.meta\.env\.DEV/);
  assert.match(pageSource, /preloadOfflineSpeechRuntime\(\)/u);
  assert.equal(SERVICE_WORKER_URL, "/sw-v9.js");
});

test("development unregisters stale workers instead of intercepting Vite", async () => {
  const unregistered = [];
  let registeredUrl;
  const serviceWorker = {
    async getRegistrations() {
      return ["/sw.js", "/sw-v9.js"].map((url) => ({
        async unregister() {
          unregistered.push(url);
          return true;
        },
      }));
    },
    async register(url) {
      registeredUrl = url;
    },
  };

  const dispose = await configureServiceWorker(serviceWorker, {
    development: true,
  });

  assert.deepEqual(unregistered, ["/sw.js", "/sw-v9.js"]);
  assert.equal(registeredUrl, undefined);
  assert.equal(typeof dispose, "function");
});

test("production reports its exact build assets during an idle callback", async () => {
  const messages = [];
  const currentAssets = [
    absoluteAsset("/assets/app-current.js"),
    absoluteAsset("/assets/offline-worker-current.js"),
  ];
  const environment = createRegistrationEnvironment({
    assets: [currentAssets[0]],
    manifestValue: manifest("current", currentAssets),
  });
  const active = {
    postMessage(message) {
      messages.push(message);
    },
  };
  const serviceWorker = {
    controller: active,
    addEventListener() {},
    removeEventListener() {},
    async register(url) {
      assert.equal(url, "/sw-v9.js");
      return { active };
    },
  };

  const dispose = await configureServiceWorker(serviceWorker, {
    development: false,
    environment,
  });
  assert.deepEqual(messages, []);

  environment.runIdle();
  await flushAsyncWork();

  assert.equal(messages[0].type, RETAIN_RUNTIME_ASSETS);
  assert.deepEqual(messages[0].manifest.assets, currentAssets);
  assert.deepEqual(messages[0].observedAssets, [currentAssets[0]]);
  dispose();
  assert.equal(messages.at(-1).type, RELEASE_RUNTIME_ASSETS);
});

test("a page/manifest deployment mismatch stays conservatively unleased", async () => {
  const messages = [];
  const environment = createRegistrationEnvironment({
    assets: [absoluteAsset("/assets/app-old.js")],
    manifestValue: manifest("new", [
      absoluteAsset("/assets/app-new.js"),
    ]),
  });
  const active = {
    postMessage(message) {
      messages.push(message);
    },
  };
  const serviceWorker = {
    controller: active,
    addEventListener() {},
    removeEventListener() {},
    async register() {
      return { active };
    },
  };

  const dispose = await configureServiceWorker(serviceWorker, {
    development: false,
    environment,
  });
  environment.runIdle();
  await flushAsyncWork();

  assert.deepEqual(messages, []);
  dispose();
  assert.equal(messages.at(-1).type, RELEASE_RUNTIME_ASSETS);
});

test("activation claims clients without putting cleanup on that path", async () => {
  const runtime = await loadServiceWorker({
    initialCaches: {
      "linelight-v8": [
        [absoluteAsset("/assets/legacy.js"), new Response("legacy")],
      ],
    },
  });

  await runWaitUntil(runtime.listeners.get("install"));
  await runWaitUntil(runtime.listeners.get("activate"));

  assert.deepEqual(runtime.deletedCaches, []);
  assert.ok(runtime.cacheNames().includes("linelight-v8"));
  assert.equal(runtime.wasClaimed(), true);
});

test("an unknown old tab blocks pruning while a new deployment activates", async () => {
  const oldAsset = absoluteAsset("/assets/offline-worker-old.js");
  const currentAsset = absoluteAsset("/assets/offline-worker-current.js");
  const retiredAsset = absoluteAsset("/assets/retired.js");
  const runtime = await loadServiceWorker({
    initialCaches: {
      [STABLE_CACHE]: [
        [oldAsset, new Response("old")],
        [currentAsset, new Response("current")],
        [retiredAsset, new Response("retired")],
      ],
      "linelight-v8": [
        [oldAsset, new Response("legacy old")],
      ],
    },
    liveClientIds: ["legacy-tab", "new-tab"],
  });

  await runMessage(
    runtime,
    {
      type: RETAIN_RUNTIME_ASSETS,
      loadedAt: 200,
      manifest: manifest("current", [currentAsset]),
      observedAssets: [currentAsset],
    },
    "new-tab",
  );

  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [
    currentAsset,
    oldAsset,
    retiredAsset,
  ].sort());
  assert.ok(runtime.cacheNames().includes("linelight-v8"));
});

test("an idle heartbeat reconciles an abruptly closed pre-protocol tab", async () => {
  const oldAsset = absoluteAsset("/assets/pre-protocol.js");
  const currentAsset = absoluteAsset("/assets/current.js");
  const runtime = await loadServiceWorker({
    initialCaches: {
      [STABLE_CACHE]: [
        [oldAsset, new Response("old")],
        [currentAsset, new Response("current")],
      ],
    },
    liveClientIds: ["legacy-tab", "new-tab"],
  });
  const lease = {
    type: RETAIN_RUNTIME_ASSETS,
    loadedAt: 200,
    manifest: manifest("current", [currentAsset]),
    observedAssets: [currentAsset],
  };

  await runMessage(runtime, lease, "new-tab");
  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [
    currentAsset,
    oldAsset,
  ].sort());

  runtime.setLiveClients(["new-tab"]);
  await runMessage(runtime, lease, "new-tab");

  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [currentAsset]);
});

test("known old clients retain their deployment until the last client closes", async () => {
  const oldAsset = absoluteAsset("/assets/offline-worker-old.js");
  const currentAsset = absoluteAsset("/assets/offline-worker-current.js");
  const retiredAsset = absoluteAsset("/assets/unreferenced.js");
  const runtime = await loadServiceWorker({
    initialCaches: {
      [STABLE_CACHE]: [
        [oldAsset, new Response("old")],
        [currentAsset, new Response("current")],
        [retiredAsset, new Response("retired")],
      ],
    },
    liveClientIds: ["old-tab", "new-tab"],
  });

  await runMessage(
    runtime,
    {
      type: RETAIN_RUNTIME_ASSETS,
      loadedAt: 100,
      manifest: manifest("old", [oldAsset]),
      observedAssets: [oldAsset],
    },
    "old-tab",
  );
  await runMessage(
    runtime,
    {
      type: RETAIN_RUNTIME_ASSETS,
      loadedAt: 200,
      manifest: manifest("current", [currentAsset]),
      observedAssets: [currentAsset],
    },
    "new-tab",
  );

  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [
    currentAsset,
    oldAsset,
  ].sort());

  await runMessage(
    runtime,
    { type: RELEASE_RUNTIME_ASSETS },
    "old-tab",
  );

  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [currentAsset]);
});

test("protected pre-v9 assets migrate before finite legacy caches retire", async () => {
  const oldAsset = absoluteAsset("/assets/worker-old.js");
  const currentAsset = absoluteAsset("/assets/worker-current.js");
  const modelUrl = `${ORIGIN}/offline-model/revision/model.onnx`;
  const runtime = await loadServiceWorker({
    initialCaches: {
      [STABLE_CACHE]: [[currentAsset, new Response("current")]],
      "linelight-v8": [[oldAsset, new Response("old")]],
      [MODEL_CACHE]: [[modelUrl, new Response("model")]],
      [VOICE_CACHE]: [[`${ORIGIN}/voices/a.bin`, new Response("voice")]],
    },
    liveClientIds: ["old-tab", "new-tab"],
  });

  await runMessage(
    runtime,
    {
      type: RETAIN_RUNTIME_ASSETS,
      loadedAt: 100,
      manifest: manifest("old", [oldAsset]),
      observedAssets: [oldAsset],
    },
    "old-tab",
  );
  await runMessage(
    runtime,
    {
      type: RETAIN_RUNTIME_ASSETS,
      loadedAt: 200,
      manifest: manifest("current", [currentAsset]),
      observedAssets: [currentAsset],
    },
    "new-tab",
  );

  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [
    currentAsset,
    oldAsset,
  ].sort());
  assert.ok(!runtime.cacheNames().includes("linelight-v8"));
  assert.deepEqual(runtime.cacheUrls(MODEL_CACHE), [modelUrl]);
  assert.deepEqual(runtime.cacheUrls(VOICE_CACHE), [
    `${ORIGIN}/voices/a.bin`,
  ]);
});

test("interrupted cleanup is conservative and completes on the next idle request", async () => {
  const currentAsset = absoluteAsset("/assets/current.js");
  const retiredOne = absoluteAsset("/assets/retired-one.js");
  const retiredTwo = absoluteAsset("/assets/retired-two.js");
  const runtime = await loadServiceWorker({
    initialCaches: {
      [STABLE_CACHE]: [
        [retiredOne, new Response("one")],
        [retiredTwo, new Response("two")],
        [currentAsset, new Response("current")],
      ],
    },
    liveClientIds: ["current-tab"],
  });
  runtime.failDeleteOnce(STABLE_CACHE, retiredTwo);

  await runMessage(
    runtime,
    {
      type: RETAIN_RUNTIME_ASSETS,
      loadedAt: 300,
      manifest: manifest("current", [currentAsset]),
      observedAssets: [currentAsset],
    },
    "current-tab",
  );

  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [
    currentAsset,
    retiredTwo,
  ].sort());

  await runMessage(
    runtime,
    { type: GET_RUNTIME_ASSET_DIAGNOSTICS },
    "current-tab",
    [{ postMessage() {} }],
  );

  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [currentAsset]);
});

test("repeated deployments retain only the current generation", async () => {
  const runtime = await loadServiceWorker({
    liveClientIds: ["current-tab"],
  });

  for (let generation = 1; generation <= 6; generation += 1) {
    const asset = absoluteAsset(`/assets/app-${generation}.js`);
    await runtime.put(STABLE_CACHE, asset, new Response(`app ${generation}`));
    await runMessage(
      runtime,
      {
        type: RETAIN_RUNTIME_ASSETS,
        loadedAt: generation * 100,
        manifest: manifest(`deployment-${generation}`, [asset]),
        observedAssets: [asset],
      },
      "current-tab",
    );
    assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [asset]);
  }
});

test("runtime diagnostics report stable and legacy bytes but exclude voice data", async () => {
  const stableAsset = absoluteAsset("/assets/current.js");
  const headerlessAsset = absoluteAsset("/assets/current.css");
  const legacyAsset = absoluteAsset("/assets/old.wasm");
  const runtime = await loadServiceWorker({
    initialCaches: {
      [STABLE_CACHE]: [
        [
          stableAsset,
          new Response("1234", { headers: { "Content-Length": "4" } }),
        ],
        [headerlessAsset, new Response("abc")],
      ],
      "linelight-v8": [
        [
          legacyAsset,
          new Response("123456", { headers: { "Content-Length": "6" } }),
        ],
      ],
      [MODEL_CACHE]: [
        [
          `${ORIGIN}/offline-model/model.onnx`,
          new Response("large model", {
            headers: { "Content-Length": "1000000" },
          }),
        ],
      ],
    },
  });
  let diagnostics;

  await runMessage(
    runtime,
    { type: GET_RUNTIME_ASSET_DIAGNOSTICS },
    "diagnostics",
    [{ postMessage(value) { diagnostics = value; } }],
  );

  assert.equal(diagnostics.available, true);
  assert.equal(diagnostics.retainedAssets, 3);
  assert.equal(diagnostics.retainedBytes, 13);
  assert.equal(diagnostics.legacyCaches, 1);
});

test("the page-side diagnostics request has a bounded structured response", async () => {
  const serviceWorker = {
    controller: {
      postMessage(message, ports) {
        assert.equal(message.type, GET_RUNTIME_ASSET_DIAGNOSTICS);
        ports[0].postMessage({
          type: "linelight:runtime-asset-diagnostics",
          available: true,
          retainedAssets: 3,
          retainedBytes: 22_500_000,
          legacyCaches: 0,
        });
      },
    },
  };

  const diagnostics = await getRuntimeAssetStorageDiagnostics(serviceWorker);

  assert.deepEqual(diagnostics, {
    available: true,
    retainedAssets: 3,
    retainedBytes: 22_500_000,
    legacyCaches: 0,
  });
});

test("the production build emits a complete deterministic runtime manifest", async () => {
  const value = JSON.parse(
    await readFile("dist/client/runtime-assets.json", "utf8"),
  );
  const assetDirectory = `${process.cwd()}/dist/client/assets`;
  const assets = (await readdir(assetDirectory, {
    recursive: true,
    withFileTypes: true,
  }))
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const parentPath = entry.parentPath.slice(assetDirectory.length);
      return `/assets${parentPath}/${entry.name}`;
    })
    .sort();
  const deploymentId = createHash("sha256")
    .update(JSON.stringify(assets))
    .digest("hex")
    .slice(0, 20);

  assert.deepEqual(value, {
    version: 1,
    deploymentId,
    assets,
  });
  assert.ok(assets.some((asset) => /offline-speech\.worker-.*\.js$/u.test(asset)));
  assert.ok(assets.some((asset) => /ort-wasm-.*\.wasm$/u.test(asset)));
  assert.ok(assets.some((asset) => /pdf-.*\.js$/u.test(asset)));
});

test("service worker leaves page navigations to the browser", async () => {
  const runtime = await loadServiceWorker();
  const listener = runtime.listeners.get("fetch");
  const request = {
    destination: "document",
    method: "GET",
    mode: "navigate",
    url: `${ORIGIN}/`,
  };

  const response = await runFetch(listener, request);

  assert.equal(response, undefined);
  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), []);
});

test("service worker always resolves intercepted requests with a Response", async () => {
  const runtime = await loadServiceWorker();
  const listener = runtime.listeners.get("fetch");
  const request = new Request(`${ORIGIN}/assets/app.js`);

  const unavailable = await runFetch(listener, request);
  assert.ok(unavailable instanceof Response);
  assert.equal(unavailable.type, "error");

  runtime.setFetchRequest(async () => new Response("Sign in", { status: 401 }));
  const unauthorized = await runFetch(listener, request);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), []);

  runtime.setFetchRequest(async () => new Response("application"));
  const successful = await runFetch(listener, request);
  assert.equal(successful.status, 200);
  assert.equal(
    successful.headers.get("cross-origin-embedder-policy"),
    "require-corp",
  );
  assert.equal(
    successful.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [request.url]);
});

test("service worker serves immutable current hashes from cache first", async () => {
  const runtime = await loadServiceWorker();
  const listener = runtime.listeners.get("fetch");
  const request = new Request(`${ORIGIN}/assets/app-abc123.js`);
  runtime.setMatchedResponse(new Response("cached application"));
  runtime.setFetchRequest(async () => {
    throw new Error("a cached immutable asset must not wait for the network");
  });

  const response = await runFetch(listener, request);

  assert.equal(await response.text(), "cached application");
  assert.equal(
    response.headers.get("cross-origin-embedder-policy"),
    "require-corp",
  );
  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), []);
});

test("service worker returns a network asset before its cache write finishes", async () => {
  const runtime = await loadServiceWorker();
  const listener = runtime.listeners.get("fetch");
  const request = new Request(`${ORIGIN}/assets/worker-new.js`);
  let releaseCachePut;
  const cachePutBarrier = new Promise((resolve) => {
    releaseCachePut = resolve;
  });
  runtime.setBeforeCachePut(() => cachePutBarrier);
  runtime.setFetchRequest(async () => new Response("network application"));

  const pending = startFetch(listener, request);
  const response = await pending.response;

  assert.equal(await response.text(), "network application");
  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), []);
  releaseCachePut();
  await pending.lifetime;
  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [request.url]);
});

test("service worker treats Cache Storage failures as optional online", async () => {
  const runtime = await loadServiceWorker();
  const listener = runtime.listeners.get("fetch");
  const request = new Request(`${ORIGIN}/assets/worker-cache-error.js`);
  runtime.setCacheMatchError(new Error("Cache Storage unavailable"));
  runtime.setFetchRequest(async () => new Response("network application"));

  const response = await runFetch(listener, request);

  assert.equal(await response.text(), "network application");
  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [request.url]);
});

test("service worker serves the bundled ONNX runtime with the WASM MIME type", async () => {
  const runtime = await loadServiceWorker();
  const listener = runtime.listeners.get("fetch");
  const request = new Request(`${ORIGIN}/assets/ort-wasm-runtime.wasm`);
  runtime.setFetchRequest(async () =>
    new Response(new Uint8Array([0, 97, 115, 109]), {
      headers: { "Content-Type": "application/octet-stream" },
    }),
  );

  const response = await runFetch(listener, request);

  assert.equal(response.headers.get("content-type"), "application/wasm");
  const cachedResponse = await runtime.match(STABLE_CACHE, request.url);
  assert.deepEqual(runtime.cacheUrls(STABLE_CACHE), [request.url]);
  assert.equal(cachedResponse.headers.get("content-type"), "application/wasm");
});

test("the static host serves ONNX runtime assets as WebAssembly", async () => {
  const headers = await readFile("public/_headers", "utf8");

  assert.match(headers, /^  Cross-Origin-Embedder-Policy: require-corp$/mu);
  assert.match(headers, /^  Cross-Origin-Resource-Policy: same-origin$/mu);
  assert.match(headers, /^\/assets\/\*\.wasm$/mu);
  assert.match(headers, /^  Content-Type: application\/wasm$/mu);
  assert.match(headers, /^\/runtime-assets\.json$/mu);
  assert.match(headers, /^  Cache-Control: no-store$/mu);
});
