import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  isOfflineSpeechWorkerAsset,
  OFFLINE_SPEECH_WORKER_ROUTE,
} from "../worker/offline-speech-asset.mjs";

async function builtOfflineWorkerPath() {
  const assets = await readdir("dist/client/assets");
  const worker = assets.find((file) =>
    /^offline-speech\.worker-.*\.js$/u.test(file),
  );
  assert.ok(worker, "The production speech worker must be emitted.");
  return `/assets/${worker}`;
}

test("production routes only the offline speech worker through the Worker", async () => {
  const config = JSON.parse(
    await readFile("dist/server/wrangler.json", "utf8"),
  );

  assert.equal(config.assets.binding, "ASSETS");
  assert.deepEqual(config.assets.run_worker_first, [
    OFFLINE_SPEECH_WORKER_ROUTE,
  ]);
  assert.equal(isOfflineSpeechWorkerAsset(await builtOfflineWorkerPath()), true);
  assert.equal(isOfflineSpeechWorkerAsset("/assets/page-example.js"), false);
});

test("production serves the speech worker with cross-origin isolation", async () => {
  const path = await builtOfflineWorkerPath();
  const workerUrl = pathToFileURL(resolve("dist/server/index.js"));
  workerUrl.searchParams.set("offline-worker-test", `${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  let requestedUrl = "";

  const response = await worker.fetch(
    new Request(`https://linelight.example${path}`),
    {
      ASSETS: {
        async fetch(request) {
          requestedUrl = request.url;
          return new Response("worker source", {
            headers: {
              "Cache-Control": "public, max-age=0, must-revalidate",
              "Content-Type": "text/javascript",
            },
          });
        },
      },
    },
    {
      passThroughOnException() {},
      waitUntil() {},
    },
  );

  assert.equal(requestedUrl, `https://linelight.example${path}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/javascript");
  assert.equal(
    response.headers.get("cross-origin-embedder-policy"),
    "require-corp",
  );
  assert.equal(
    response.headers.get("cross-origin-opener-policy"),
    "same-origin",
  );
  assert.equal(await response.text(), "worker source");
});
