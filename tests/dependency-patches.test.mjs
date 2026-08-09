import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TRANSFORMERS_CHAIN_ORIGINAL,
  TRANSFORMERS_CHAIN_REPLACEMENT,
  applyDependencyPatches,
  createRecoveringSerializedInferenceAdapter,
} from "../scripts/apply-dependency-patches.mjs";

const TRANSFORMERS_INTEGRITY =
  "sha512-tsTk4zVjImqdqjS8/AOZg2yNLd1z9S5v+7oUPpXaasDRwEDhB+xnglK1k5cad26lL5/ZIaeREgWWy0bs9y9pPA==";

test("the reviewed Transformers browser files contain the recovering chain", async () => {
  const paths = [
    "node_modules/@huggingface/transformers/src/backends/onnx.js",
    "node_modules/@huggingface/transformers/dist/transformers.web.js",
  ];
  for (const path of paths) {
    const source = await readFile(path, "utf8");
    assert.equal(source.includes(TRANSFORMERS_CHAIN_ORIGINAL), false, path);
    assert.equal(source.includes(TRANSFORMERS_CHAIN_REPLACEMENT), true, path);
  }
});

test("a rejected run reaches its caller but cannot poison the next warm run", async () => {
  const runSerialized = createRecoveringSerializedInferenceAdapter();
  const order = [];

  let rejectCanceledRun;
  let markCanceledRunStarted;
  const canceledRunStarted = new Promise((resolve) => {
    markCanceledRunStarted = resolve;
  });
  const canceledRun = runSerialized(
    () =>
      new Promise((_, reject) => {
        rejectCanceledRun = reject;
        order.push("canceled-start");
        markCanceledRunStarted();
      }),
  );
  await canceledRunStarted;
  const alreadyQueuedNextRun = runSerialized(async () => {
    order.push("next-start");
    return "same-session-success";
  });
  const canceledError = new Error("canceled");
  canceledError.name = "AbortError";
  canceledError.code = "ERR_ORT_WASM_RUN_CANCELED";
  rejectCanceledRun(canceledError);

  await assert.rejects(
    canceledRun,
    { name: "AbortError", code: "ERR_ORT_WASM_RUN_CANCELED" },
  );

  const result = await alreadyQueuedNextRun;
  assert.equal(result, "same-session-success");
  assert.deepEqual(order, ["canceled-start", "next-start"]);
});

test("ordinary inference errors remain rejected while later work recovers", async () => {
  const runSerialized = createRecoveringSerializedInferenceAdapter();
  const ordinaryError = new Error("operator failed");

  await assert.rejects(runSerialized(() => Promise.reject(ordinaryError)), {
    message: "operator failed",
  });
  assert.equal(await runSerialized(() => Promise.resolve(42)), 42);
});

test("the exact dependency patch is idempotent and rejects changed preimages", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "linelight-transformers-patch-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const dependencyRoot = join(
    temporaryRoot,
    "node_modules/@huggingface/transformers",
  );
  await mkdir(join(dependencyRoot, "src/backends"), { recursive: true });
  await mkdir(join(dependencyRoot, "dist"), { recursive: true });
  await writeFile(
    join(temporaryRoot, "package-lock.json"),
    JSON.stringify({
      packages: {
        "node_modules/@huggingface/transformers": {
          version: "3.8.1",
          integrity: TRANSFORMERS_INTEGRITY,
        },
      },
    }),
  );
  await writeFile(
    join(dependencyRoot, "package.json"),
    JSON.stringify({ version: "3.8.1" }),
  );
  for (const relativePath of [
    "src/backends/onnx.js",
    "dist/transformers.web.js",
  ]) {
    await writeFile(
      join(dependencyRoot, relativePath),
      await readFile(
        join("node_modules/@huggingface/transformers", relativePath),
      ),
    );
  }

  // Installed files are already patched by postinstall, so both invocations
  // exercise the accepted reviewed-output digest path.
  await applyDependencyPatches(temporaryRoot);
  await applyDependencyPatches(temporaryRoot);
  await writeFile(
    join(dependencyRoot, "src/backends/onnx.js"),
    `${await readFile(join(dependencyRoot, "src/backends/onnx.js"), "utf8")}\n// tampered\n`,
  );
  await assert.rejects(applyDependencyPatches(temporaryRoot), {
    message: /Refusing to patch unreviewed src\/backends\/onnx\.js/u,
  });
});
