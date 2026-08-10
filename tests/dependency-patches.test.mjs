import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TRANSFORMERS_CHAIN_ORIGINAL,
  TRANSFORMERS_CHAIN_REPLACEMENT,
  TRANSFORMERS_ERROR_DIAGNOSTIC_ORIGINAL,
  TRANSFORMERS_ERROR_DIAGNOSTIC_REPLACEMENT,
  applyDependencyPatches,
  createRecoveringSerializedInferenceAdapter,
  rethrowTransformersInferenceError,
} from "../scripts/apply-dependency-patches.mjs";

const TRANSFORMERS_INTEGRITY =
  "sha512-tsTk4zVjImqdqjS8/AOZg2yNLd1z9S5v+7oUPpXaasDRwEDhB+xnglK1k5cad26lL5/ZIaeREgWWy0bs9y9pPA==";

test("the browser export resolves to exact reviewed Transformers bytes", async () => {
  const dependencyRoot = "node_modules/@huggingface/transformers";
  const [metadata, lock] = await Promise.all([
    readFile(`${dependencyRoot}/package.json`, "utf8").then(JSON.parse),
    readFile("package-lock.json", "utf8").then(JSON.parse),
  ]);
  assert.equal(metadata.version, "3.8.1");
  assert.equal(metadata.exports.default.default, "./dist/transformers.web.js");
  assert.deepEqual(
    {
      integrity:
        lock.packages["node_modules/@huggingface/transformers"].integrity,
      version: lock.packages["node_modules/@huggingface/transformers"].version,
    },
    { integrity: TRANSFORMERS_INTEGRITY, version: "3.8.1" },
  );
  for (const [relativePath, expectedSha256] of Object.entries({
    "dist/transformers.web.js":
      "56528ad2d27d93dfc5326346298ef47bc75fe83ac8e284d6811909c14467abe7",
    "src/backends/onnx.js":
      "3d026ce1714db9aee4e5b6d2aead761d006ae9dea2a8e9d05800878ac881acd8",
    "src/models.js":
      "4152078945cce8defb4807e8f17b30211f7621555f6223c2ff2c34a2bffb1530",
  })) {
    const bytes = await readFile(`${dependencyRoot}/${relativePath}`);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expectedSha256,
      relativePath,
    );
  }
});

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

test("the reviewed Transformers model wrappers omit diagnostics only for cooperative cancellation", async () => {
  const paths = [
    "node_modules/@huggingface/transformers/src/models.js",
    "node_modules/@huggingface/transformers/dist/transformers.web.js",
  ];
  for (const path of paths) {
    const source = await readFile(path, "utf8");
    assert.equal(
      source.includes(TRANSFORMERS_ERROR_DIAGNOSTIC_ORIGINAL),
      false,
      path,
    );
    assert.equal(
      source.includes(TRANSFORMERS_ERROR_DIAGNOSTIC_REPLACEMENT),
      true,
      path,
    );
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

  await assert.rejects(canceledRun, {
    name: "AbortError",
    code: "ERR_ORT_WASM_RUN_CANCELED",
  });

  const result = await alreadyQueuedNextRun;
  assert.equal(result, "same-session-success");
  assert.deepEqual(order, ["canceled-start", "next-start"]);
});

test("ordinary inference errors remain rejected while later work recovers", async () => {
  const runSerialized = createRecoveringSerializedInferenceAdapter();
  const ordinaryError = new Error("operator failed");

  await assert.rejects(
    runSerialized(() => Promise.reject(ordinaryError)),
    {
      message: "operator failed",
    },
  );
  assert.equal(await runSerialized(() => Promise.resolve(42)), 42);
});

test("cooperative cancellation rejects without formatting or logging model inputs", () => {
  const canceled = {
    code: "ERR_ORT_WASM_RUN_CANCELED",
    name: "AbortError",
  };
  let diagnosticCalls = 0;
  const tensor = {
    get data() {
      throw new Error("model inputs must not be inspected for cancellation");
    },
  };

  assert.throws(
    () =>
      rethrowTransformersInferenceError(canceled, () => {
        diagnosticCalls += 1;
        void tensor.data;
      }),
    (error) => error === canceled,
  );
  assert.equal(diagnosticCalls, 0);
});

test("ordinary and similar AbortError failures keep diagnostics and rejection", () => {
  for (const error of [
    new Error("operator failed"),
    Object.assign(new Error("unrelated abort"), { name: "AbortError" }),
    Object.assign(new Error("different cancellation"), {
      name: "AbortError",
      code: "ERR_OTHER_ABORT",
    }),
  ]) {
    let diagnosticCalls = 0;
    assert.throws(
      () =>
        rethrowTransformersInferenceError(error, () => {
          diagnosticCalls += 1;
        }),
      (received) => received === error,
    );
    assert.equal(diagnosticCalls, 1);
  }
});

test("the exact dependency patch is idempotent and rejects changed preimages", async (context) => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "linelight-transformers-patch-"),
  );
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
  const transformations = {
    "dist/transformers.web.js": [
      [TRANSFORMERS_CHAIN_REPLACEMENT, TRANSFORMERS_CHAIN_ORIGINAL],
      [
        TRANSFORMERS_ERROR_DIAGNOSTIC_REPLACEMENT,
        TRANSFORMERS_ERROR_DIAGNOSTIC_ORIGINAL,
      ],
    ],
    "src/backends/onnx.js": [
      [TRANSFORMERS_CHAIN_REPLACEMENT, TRANSFORMERS_CHAIN_ORIGINAL],
    ],
    "src/models.js": [
      [
        TRANSFORMERS_ERROR_DIAGNOSTIC_REPLACEMENT,
        TRANSFORMERS_ERROR_DIAGNOSTIC_ORIGINAL,
      ],
    ],
  };
  const reviewedPatchedSources = new Map();
  for (const [relativePath, reverseReplacements] of Object.entries(
    transformations,
  )) {
    const patched = await readFile(
      join("node_modules/@huggingface/transformers", relativePath),
      "utf8",
    );
    reviewedPatchedSources.set(relativePath, patched);
    const original = reverseReplacements.reduce(
      (source, [replacement, preimage]) =>
        source.replace(replacement, preimage),
      patched,
    );
    assert.notEqual(original, patched, relativePath);
    await writeFile(join(dependencyRoot, relativePath), original);
  }

  // The first invocation exercises every exact upstream preimage; the second
  // proves that the complete reviewed postimages are accepted idempotently.
  await applyDependencyPatches(temporaryRoot);
  for (const [relativePath, expected] of reviewedPatchedSources) {
    assert.equal(
      await readFile(join(dependencyRoot, relativePath), "utf8"),
      expected,
      relativePath,
    );
  }
  await applyDependencyPatches(temporaryRoot);
  await writeFile(
    join(dependencyRoot, "src/backends/onnx.js"),
    `${await readFile(join(dependencyRoot, "src/backends/onnx.js"), "utf8")}\n// tampered\n`,
  );
  await assert.rejects(applyDependencyPatches(temporaryRoot), {
    message: /Refusing to patch unreviewed src\/backends\/onnx\.js/u,
  });
});
