import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFLINE_MODEL_REVISION,
  OFFLINE_MODEL_ROUTE_PREFIX,
} from "../app/offline-model-manifest.mjs";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

let workerPromise;

function loadBuiltWorker() {
  workerPromise ??= import(
    new URL(
      `../dist/server/index.js?test=${process.pid}-${Date.now()}`,
      import.meta.url,
    ).href
  );
  return workerPromise;
}

test("renders development preview metadata", async () => {
  const { default: worker } = await loadBuiltWorker();

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.equal(
    response.headers.get("cross-origin-embedder-policy"),
    "require-corp",
  );
  assert.equal(
    response.headers.get("cross-origin-opener-policy"),
    "same-origin",
  );
  assert.match(await response.text(), developmentPreviewMeta);
});

test("keeps Azure Speech credentials on the server", async () => {
  const { default: worker } = await loadBuiltWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/speech/token"),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    code: "not_configured",
    message:
      "Natural voice is not configured yet. Add Azure Speech credentials, or use the private device voice.",
  });
});

test("serves the pinned offline model through the production worker", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamUrl = "";
  globalThis.fetch = async (request) => {
    upstreamUrl = request.url;
    return new Response('{"model_type":"kokoro"}', {
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { default: worker } = await loadBuiltWorker();
    const response = await worker.fetch(
      new Request(
        `http://localhost${OFFLINE_MODEL_ROUTE_PREFIX}config.json`,
      ),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );

    assert.equal(response.status, 200);
    assert.match(upstreamUrl, new RegExp(OFFLINE_MODEL_REVISION));
    assert.equal(
      response.headers.get("cross-origin-embedder-policy"),
      "require-corp",
    );
    assert.equal(
      response.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
    assert.equal(await response.text(), '{"model_type":"kokoro"}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
