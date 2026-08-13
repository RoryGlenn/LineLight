/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  handleSpeechTokenRequest,
  type SpeechEnvironment,
} from "./speech-token";
import { OFFLINE_MODEL_ROUTE_BASE } from "../app/offline-model-manifest.mjs";
import { handleOfflineModelRequest } from "./offline-model.mjs";
import { AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_BASE } from
  "../app/audiobook-alignment-model.mjs";
import { handleAudiobookAlignmentModelRequest } from
  "./alignment-model.mjs";

interface Env extends SpeechEnvironment {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const RUNTIME_ASSET_MANIFEST_PATH = "/runtime-assets.json";

function withRuntimeHeaders(request: Request, response: Response) {
  const url = new URL(request.url);
  const contentType = response.headers.get("content-type") ?? "";
  const isDocument = /^text\/html\b/iu.test(contentType);
  const isRuntimeAsset = url.pathname.startsWith("/assets/");
  const isWorkerScript = isRuntimeAsset && url.pathname.endsWith(".js");
  const isWasm = url.pathname.endsWith(".wasm");
  if (!isDocument && !isRuntimeAsset && !isWasm) return response;

  const headers = new Headers(response.headers);
  if (isDocument) {
    // SharedArrayBuffer unlocks ONNX's threaded WASM fallback when WebGPU is
    // unavailable. Every narration/runtime asset is same-origin or explicitly
    // CORP-protected, so the reader can use a cross-origin-isolated agent.
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Origin-Agent-Cluster", "?1");
  }
  if (isRuntimeAsset) {
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
  }
  if (isWorkerScript) {
    // Dedicated workers need their own embedder policy to join the isolated
    // agent cluster and create ONNX's nested WASM workers.
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  }
  if (isWasm) headers.set("Content-Type", "application/wasm");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/speech/token") {
      return handleSpeechTokenRequest(request, env);
    }

    if (url.pathname.startsWith(OFFLINE_MODEL_ROUTE_BASE)) {
      return handleOfflineModelRequest(request);
    }

    if (url.pathname.startsWith(AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_BASE)) {
      return handleAudiobookAlignmentModelRequest(request);
    }

    if (url.pathname === RUNTIME_ASSET_MANIFEST_PATH) {
      if (!env?.ASSETS) {
        // Vinext's local production server resolves this signal against the
        // built client directory. Deployed Workers use the ASSETS binding
        // below instead.
        return new Response(null, {
          headers: {
            "Cache-Control": "no-store",
            "x-vinext-static-file": encodeURIComponent(
              RUNTIME_ASSET_MANIFEST_PATH,
            ),
          },
        });
      }
      const response = await env.ASSETS.fetch(request);
      if (!response.ok) return response;
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(
        request,
        {
          fetchAsset: (path) =>
            env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body)
              .transform(width > 0 ? { width } : {})
              .output({ format, quality });
            return result.response();
          },
        },
        allowedWidths,
      );
    }

    const response = await handler.fetch(request, env, ctx);
    return withRuntimeHeaders(request, response);
  },
};

export default worker;
