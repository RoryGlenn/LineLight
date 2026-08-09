import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  SERVICE_WORKER_URL,
  configureServiceWorker,
} from "../app/service-worker-registration.mjs";

const SERVICE_WORKER_PATH = "public/sw-v9.js";

async function loadServiceWorker() {
  const source = await readFile(SERVICE_WORKER_PATH, "utf8");
  const listeners = new Map();
  const deletedCaches = [];
  const cachedResponses = [];
  let claimed = false;
  let fetchRequest = async () => {
    throw new TypeError("offline");
  };
  let beforeCachePut = async () => {};
  let matchedResponse;
  let matchError;

  const cache = {
    async put(request, response) {
      await beforeCachePut();
      cachedResponses.push({ request, response });
    },
  };
  const caches = {
    async delete(name) {
      deletedCaches.push(name);
      return true;
    },
    async keys() {
      return [
        "linelight-v5",
        "linelight-v6",
        "linelight-v8",
        "transformers-cache",
        "kokoro-voices",
      ];
    },
    async match() {
      if (matchError) throw matchError;
      return matchedResponse;
    },
    async open() {
      return cache;
    },
  };
  const self = {
    location: { origin: "https://linelight.example" },
    clients: {
      async claim() {
        claimed = true;
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    async skipWaiting() {},
  };

  vm.runInNewContext(source, {
    Headers,
    Response,
    URL,
    caches,
    fetch: (request) => fetchRequest(request),
    self,
  });

  return {
    cachedResponses,
    deletedCaches,
    listeners,
    setFetchRequest(nextFetch) {
      fetchRequest = nextFetch;
    },
    setBeforeCachePut(nextBeforeCachePut) {
      beforeCachePut = nextBeforeCachePut;
    },
    setMatchedResponse(response) {
      matchedResponse = response;
    },
    setCacheMatchError(error) {
      matchError = error;
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

  await configureServiceWorker(serviceWorker, { development: true });

  assert.deepEqual(unregistered, ["/sw.js", "/sw-v9.js"]);
  assert.equal(registeredUrl, undefined);
});

test("production registers the versioned worker", async () => {
  let registrationsRead = false;
  let registeredUrl;
  const serviceWorker = {
    async getRegistrations() {
      registrationsRead = true;
      return [];
    },
    async register(url) {
      registeredUrl = url;
    },
  };

  await configureServiceWorker(serviceWorker, { development: false });

  assert.equal(registrationsRead, false);
  assert.equal(registeredUrl, "/sw-v9.js");
});

test("service worker retains old immutable assets for open offline tabs", async () => {
  const runtime = await loadServiceWorker();

  await runWaitUntil(runtime.listeners.get("install"));
  await runWaitUntil(runtime.listeners.get("activate"));

  assert.deepEqual(runtime.deletedCaches, []);
  assert.equal(runtime.wasClaimed(), true);
});

test("service worker leaves page navigations to the browser", async () => {
  const runtime = await loadServiceWorker();
  const listener = runtime.listeners.get("fetch");
  const request = {
    destination: "document",
    method: "GET",
    mode: "navigate",
    url: "https://linelight.example/",
  };

  const response = await runFetch(listener, request);

  assert.equal(response, undefined);
  assert.equal(runtime.cachedResponses.length, 0);
});

test("service worker always resolves intercepted requests with a Response", async () => {
  const runtime = await loadServiceWorker();
  const listener = runtime.listeners.get("fetch");
  const request = new Request("https://linelight.example/assets/app.js");

  const unavailable = await runFetch(listener, request);
  assert.ok(unavailable instanceof Response);
  assert.equal(unavailable.type, "error");

  runtime.setFetchRequest(async () => new Response("Sign in", { status: 401 }));
  const unauthorized = await runFetch(listener, request);
  assert.equal(unauthorized.status, 401);
  assert.equal(runtime.cachedResponses.length, 0);

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
  assert.equal(runtime.cachedResponses.length, 1);
});

test("service worker serves immutable hashed assets from cache first", async () => {
  const runtime = await loadServiceWorker();
  const listener = runtime.listeners.get("fetch");
  const request = new Request(
    "https://linelight.example/assets/app-abc123.js",
  );
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
  assert.equal(runtime.cachedResponses.length, 0);
});

test("service worker returns a network asset before its cache write finishes", async () => {
  const runtime = await loadServiceWorker();
  const listener = runtime.listeners.get("fetch");
  const request = new Request(
    "https://linelight.example/assets/worker-new.js",
  );
  let releaseCachePut;
  const cachePutBarrier = new Promise((resolve) => {
    releaseCachePut = resolve;
  });
  runtime.setBeforeCachePut(() => cachePutBarrier);
  runtime.setFetchRequest(async () => new Response("network application"));

  const pending = startFetch(listener, request);
  const response = await pending.response;

  assert.equal(await response.text(), "network application");
  assert.equal(runtime.cachedResponses.length, 0);
  releaseCachePut();
  await pending.lifetime;
  assert.equal(runtime.cachedResponses.length, 1);
});

test("service worker treats failed cache reads as optional", async () => {
  const runtime = await loadServiceWorker();
  const listener = runtime.listeners.get("fetch");
  const request = new Request(
    "https://linelight.example/assets/worker-cache-error.js",
  );
  runtime.setCacheMatchError(new Error("Cache Storage unavailable"));
  runtime.setFetchRequest(async () => new Response("network application"));

  const response = await runFetch(listener, request);

  assert.equal(await response.text(), "network application");
  assert.equal(runtime.cachedResponses.length, 1);
});

test("service worker serves the bundled ONNX runtime with the WASM MIME type", async () => {
  const runtime = await loadServiceWorker();
  const listener = runtime.listeners.get("fetch");
  const request = new Request(
    "https://linelight.example/assets/ort-wasm-runtime.wasm",
  );
  runtime.setFetchRequest(async () =>
    new Response(new Uint8Array([0, 97, 115, 109]), {
      headers: { "Content-Type": "application/octet-stream" },
    }),
  );

  const response = await runFetch(listener, request);

  assert.equal(response.headers.get("content-type"), "application/wasm");
  assert.equal(runtime.cachedResponses.length, 1);
  assert.equal(
    runtime.cachedResponses[0].response.headers.get("content-type"),
    "application/wasm",
  );
});

test("the static host serves ONNX runtime assets as WebAssembly", async () => {
  const headers = await readFile("public/_headers", "utf8");

  assert.match(headers, /^  Cross-Origin-Embedder-Policy: require-corp$/mu);
  assert.match(headers, /^  Cross-Origin-Resource-Policy: same-origin$/mu);
  assert.match(headers, /^\/assets\/\*\.wasm$/mu);
  assert.match(headers, /^  Content-Type: application\/wasm$/mu);
});
