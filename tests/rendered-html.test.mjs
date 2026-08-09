import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { resolve } from "node:path";
import path from "node:path";
import test from "node:test";
import { loadConfigFromFile } from "vite";

import {
  OFFLINE_MODEL_REVISION,
  OFFLINE_MODEL_ROUTE_PREFIX,
} from "../app/offline-model-manifest.mjs";
import { stopProcessGroup } from "../scripts/run-pdf-highlight-browser-regression.mjs";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;
const authenticatedManifestLink =
  /<link(?=[^>]*\brel=["']manifest["'])(?=[^>]*\bhref=["']\/manifest\.webmanifest["'])(?=[^>]*\bcrossorigin=["']use-credentials["'])[^>]*>/i;

let workerPromise;

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a test port."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitForBuiltOrigin(url, child, log, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Built origin stopped before startup.\n${log()}`);
    }
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Wrangler is still starting the local built artifact.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for the built origin.\n${log()}`);
}

function loadBuiltWorker() {
  workerPromise ??= import(
    new URL(
      `../dist/server/index.js?test=${process.pid}-${Date.now()}`,
      import.meta.url,
    ).href
  );
  return workerPromise;
}

test("isolates Vite-served development module workers", async () => {
  const loaded = await loadConfigFromFile(
    {
      command: "serve",
      mode: "test",
      isPreview: false,
      isSsrBuild: false,
    },
    resolve("vite.config.ts"),
  );

  assert.ok(loaded, "Vite should load the repository configuration");
  assert.equal(
    loaded.config.server?.headers?.["Cross-Origin-Embedder-Policy"],
    "require-corp",
  );
  assert.equal(
    loaded.config.server?.headers?.["Cross-Origin-Resource-Policy"],
    "same-origin",
  );
});

test(
  "serves isolated workers and WebAssembly from the built production origin",
  { timeout: 60_000 },
  async () => {
    const builtWranglerConfig = JSON.parse(
      await readFile("dist/server/wrangler.json", "utf8"),
    );
    assert.equal(builtWranglerConfig.dev?.ip, "0.0.0.0");
    assert.equal(builtWranglerConfig.dev?.port, 3000);
    const port = await getFreePort();
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "linelight-built-origin-test-"),
    );
    const child = spawn(
      "npm",
      [
        "start",
        "--",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        "0",
        "--local",
        "--log-level",
        "warn",
        "--persist-to",
        temporaryDirectory,
        "--show-interactive-dev-session=false",
      ],
      {
        detached: true,
        env: {
          ...process.env,
          MINIFLARE_REGISTRY_PATH: path.join(
            temporaryDirectory,
            "registry",
          ),
          WRANGLER_LOG_PATH: path.join(temporaryDirectory, "wrangler.log"),
          WRANGLER_SEND_METRICS: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = [];
    const collect = (chunk) => output.push(chunk.toString());
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const log = () => output.join("");
    const origin = `http://127.0.0.1:${port}`;
    try {
      await waitForBuiltOrigin(`${origin}/`, child, log);
      const manifestResponse = await fetch(`${origin}/runtime-assets.json`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(manifestResponse.status, 200);
      assert.equal(manifestResponse.headers.get("cache-control"), "no-store");
      const manifest = await manifestResponse.json();
      assert.ok(Array.isArray(manifest.assets));
      const requiredAsset = (pattern) => {
        const matches = manifest.assets.filter((asset) => pattern.test(asset));
        assert.equal(matches.length, 1, `expected one asset matching ${pattern}`);
        return matches[0];
      };
      const assets = [
        {
          contentType: /^(?:application|text)\/javascript\b/iu,
          path: requiredAsset(
            /^\/assets\/pdf-document\.worker-[^/]+\.js$/u,
          ),
        },
        {
          contentType: /^(?:application|text)\/javascript\b/iu,
          path: requiredAsset(
            /^\/assets\/pdf-parser\.worker-[^/]+\.js$/u,
          ),
        },
        {
          contentType: /^(?:application|text)\/javascript\b/iu,
          path: requiredAsset(
            /^\/assets\/pdf\.worker\.min-[^/]+\.mjs$/u,
          ),
        },
        {
          contentType: /^application\/wasm\b/iu,
          path: requiredAsset(
            /^\/assets\/ort-wasm-simd-threaded\.jsep-[^/]+\.wasm$/u,
          ),
        },
      ];
      const documentResponse = await fetch(`${origin}/`, {
        cache: "no-store",
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(
        documentResponse.headers.get("cross-origin-embedder-policy"),
        "require-corp",
      );
      assert.equal(
        documentResponse.headers.get("cross-origin-opener-policy"),
        "same-origin",
      );
      for (const asset of assets) {
        const response = await fetch(`${origin}${asset.path}`, {
          cache: "no-store",
          method: "HEAD",
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(response.status, 200, asset.path);
        assert.match(
          response.headers.get("content-type") ?? "",
          asset.contentType,
        );
        assert.equal(
          response.headers.get("cross-origin-embedder-policy"),
          "require-corp",
          asset.path,
        );
        assert.equal(
          response.headers.get("cross-origin-resource-policy"),
          "same-origin",
          asset.path,
        );
      }
    } finally {
      let shutdown;
      try {
        shutdown = await stopProcessGroup(child.pid, 2_000);
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
      assert.equal(
        shutdown?.closed,
        true,
        `Wrangler process group ${child.pid} survived test cleanup.`,
      );
    }
  },
);

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
  assert.equal(response.headers.get("origin-agent-cluster"), "?1");
  const html = await response.text();
  const manifestLinks =
    html.match(/<link(?=[^>]*\brel=["']manifest["'])[^>]*>/gi) ?? [];
  assert.match(html, developmentPreviewMeta);
  assert.equal(manifestLinks.length, 1);
  assert.match(manifestLinks[0], authenticatedManifestLink);
  assert.doesNotMatch(html, /\.vinext\/fonts|geist-[^"']+\.woff2/i);
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
      null,
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

test("serves the generated runtime asset manifest through the production worker", async () => {
  const manifestSource = await readFile(
    new URL("../dist/client/runtime-assets.json", import.meta.url),
    "utf8",
  );
  let assetRequest;
  const { default: worker } = await loadBuiltWorker();
  const response = await worker.fetch(
    new Request("http://localhost/runtime-assets.json"),
    {
      ASSETS: {
        async fetch(request) {
          assetRequest = request;
          return new Response(manifestSource, {
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(new URL(assetRequest.url).pathname, "/runtime-assets.json");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.deepEqual(await response.json(), JSON.parse(manifestSource));
});
