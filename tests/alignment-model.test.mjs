import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUDIOBOOK_ALIGNMENT_MODEL_FILES,
  AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_PREFIX,
  resolveAudiobookAlignmentModelRequest,
} from "../app/audiobook-alignment-model.mjs";
import {
  AUDIOBOOK_ALIGNMENT_MODEL_ID,
  AUDIOBOOK_ALIGNMENT_MODEL_REVISION,
} from "../app/audiobook-alignment.mjs";
import { handleAudiobookAlignmentModelRequest } from
  "../worker/alignment-model.mjs";

test("pins and allowlists only the q8 local alignment model", () => {
  assert.match(AUDIOBOOK_ALIGNMENT_MODEL_REVISION, /^[a-f0-9]{40}$/u);
  assert.ok(
    AUDIOBOOK_ALIGNMENT_MODEL_FILES.includes(
      "onnx/encoder_model_quantized.onnx",
    ),
  );
  assert.ok(
    AUDIOBOOK_ALIGNMENT_MODEL_FILES.includes(
      "onnx/decoder_model_merged_quantized.onnx",
    ),
  );
  const allowed = resolveAudiobookAlignmentModelRequest(
    `${AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_PREFIX}config.json`,
  );
  assert.equal(allowed.file, "config.json");
  assert.match(allowed.upstreamUrl, new RegExp(AUDIOBOOK_ALIGNMENT_MODEL_ID));
  assert.match(
    allowed.upstreamUrl,
    new RegExp(AUDIOBOOK_ALIGNMENT_MODEL_REVISION),
  );
  assert.equal(
    resolveAudiobookAlignmentModelRequest(
      `${AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_PREFIX}../../private.txt`,
    ),
    null,
  );
  assert.equal(
    resolveAudiobookAlignmentModelRequest(
      `${AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_PREFIX}onnx/encoder_model.onnx`,
    ),
    null,
  );
});

test("streams pinned alignment files and forwards ranges", async () => {
  let upstreamRequest;
  const response = await handleAudiobookAlignmentModelRequest(
    new Request(
      `https://linelight.example${AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_PREFIX}` +
        "onnx/encoder_model_quantized.onnx",
      { headers: { Range: "bytes=0-7" } },
    ),
    async (request) => {
      upstreamRequest = request;
      return new Response(new Uint8Array(8), {
        status: 206,
        headers: {
          "Content-Length": "8",
          "Content-Range": "bytes 0-7/10124993",
          "Content-Type": "application/octet-stream",
          ETag: '"alignment-model"',
        },
      });
    },
  );
  assert.equal(upstreamRequest.headers.get("range"), "bytes=0-7");
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    response.headers.get("cdn-cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    response.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
  assert.equal((await response.arrayBuffer()).byteLength, 8);
});

test("rejects unknown paths and write methods without fetching upstream", async () => {
  let fetchCalls = 0;
  const missing = await handleAudiobookAlignmentModelRequest(
    new Request("https://linelight.example/alignment-model/private.txt"),
    async () => {
      fetchCalls += 1;
      return new Response("unexpected");
    },
  );
  assert.equal(missing.status, 404);
  assert.equal(fetchCalls, 0);

  const write = await handleAudiobookAlignmentModelRequest(
    new Request(
      `https://linelight.example${AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_PREFIX}` +
        "config.json",
      { method: "POST" },
    ),
  );
  assert.equal(write.status, 405);
  assert.equal(write.headers.get("allow"), "GET, HEAD");
});

test("registers the same-origin alignment route ahead of the app handler", async () => {
  const source = await readFile("worker/index.ts", "utf8");
  const alignmentRoute = source.indexOf(
    "url.pathname.startsWith(AUDIOBOOK_ALIGNMENT_MODEL_ROUTE_BASE)",
  );
  const appHandler = source.indexOf("handler.fetch(request, env, ctx)");
  assert.ok(alignmentRoute >= 0);
  assert.ok(alignmentRoute < appHandler);
});
