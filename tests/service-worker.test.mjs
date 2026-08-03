import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const SERVICE_WORKER_PATH = "public/sw-v7.js";

async function loadServiceWorker() {
  const source = await readFile(SERVICE_WORKER_PATH, "utf8");
  const listeners = new Map();
  const deletedCaches = [];
  const cachedResponses = [];
  let claimed = false;
  let fetchRequest = async () => {
    throw new TypeError("offline");
  };
  let matchedResponse;

  const cache = {
    async put(request, response) {
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
        "transformers-cache",
        "kokoro-voices",
      ];
    },
    async match() {
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
    setMatchedResponse(response) {
      matchedResponse = response;
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

async function runFetch(listener, request) {
  let responsePromise;
  listener({
    request,
    respondWith(value) {
      responsePromise = Promise.resolve(value);
    },
  });
  return responsePromise;
}

test("the app registers the versioned service worker at the root scope", async () => {
  const pageSource = await readFile("app/page.tsx", "utf8");

  assert.match(pageSource, /serviceWorker\.register\("\/sw-v7\.js"\)/);
});

test("service worker replaces stale shell caches without touching model data", async () => {
  const runtime = await loadServiceWorker();

  await runWaitUntil(runtime.listeners.get("install"));
  await runWaitUntil(runtime.listeners.get("activate"));

  assert.deepEqual(runtime.deletedCaches, ["linelight-v5", "linelight-v6"]);
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
  assert.equal(runtime.cachedResponses.length, 1);
});
