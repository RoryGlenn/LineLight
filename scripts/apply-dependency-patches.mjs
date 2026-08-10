import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TRANSFORMERS_VERSION = "3.8.1";
const TRANSFORMERS_INTEGRITY =
  "sha512-tsTk4zVjImqdqjS8/AOZg2yNLd1z9S5v+7oUPpXaasDRwEDhB+xnglK1k5cad26lL5/ZIaeREgWWy0bs9y9pPA==";

export const TRANSFORMERS_CHAIN_ORIGINAL = `    const output = await (IS_WEB_ENV
        ? (webInferenceChain = webInferenceChain.then(run))
        : run()
    );`;

export const TRANSFORMERS_CHAIN_REPLACEMENT = `    const currentRun = IS_WEB_ENV ? webInferenceChain.then(run) : run();
    // Modified by LineLight for Issue #55: recover the serialized web inference queue after rejection.
    if (IS_WEB_ENV) {
        webInferenceChain = currentRun.then(
            () => undefined,
            () => undefined,
        );
    }
    const output = await currentRun;`;

export const TRANSFORMERS_ERROR_DIAGNOSTIC_ORIGINAL = `    } catch (e) {
        // Error messages can be long (nested) and uninformative. For this reason,`;

export const TRANSFORMERS_ERROR_DIAGNOSTIC_REPLACEMENT = `    } catch (e) {
        // Modified by LineLight for Issue #55: expected cooperative cancellation must not log model inputs.
        if (e?.name === 'AbortError' && e?.code === 'ERR_ORT_WASM_RUN_CANCELED') {
            throw e;
        }

        // Error messages can be long (nested) and uninformative. For this reason,`;

const PATCHES = Object.freeze([
  {
    path: "src/backends/onnx.js",
    originalSha256:
      "3265edafb24d321eb4b214f45684fa1d498407e2e0eca5fea9e720958f1635f3",
    patchedSha256:
      "3d026ce1714db9aee4e5b6d2aead761d006ae9dea2a8e9d05800878ac881acd8",
    replacements: [
      [TRANSFORMERS_CHAIN_ORIGINAL, TRANSFORMERS_CHAIN_REPLACEMENT],
    ],
  },
  {
    path: "src/models.js",
    originalSha256:
      "6ba3e066c05b5a4ae35281b0cafff0504e13a6b18d7e2e3799eb9f243a610108",
    patchedSha256:
      "4152078945cce8defb4807e8f17b30211f7621555f6223c2ff2c34a2bffb1530",
    replacements: [
      [
        TRANSFORMERS_ERROR_DIAGNOSTIC_ORIGINAL,
        TRANSFORMERS_ERROR_DIAGNOSTIC_REPLACEMENT,
      ],
    ],
  },
  {
    path: "dist/transformers.web.js",
    originalSha256:
      "1b41438d839ca3ea1346031472edee8cb3eefbf0bad48945f969559e2eb03394",
    patchedSha256:
      "56528ad2d27d93dfc5326346298ef47bc75fe83ac8e284d6811909c14467abe7",
    replacements: [
      [TRANSFORMERS_CHAIN_ORIGINAL, TRANSFORMERS_CHAIN_REPLACEMENT],
      [
        TRANSFORMERS_ERROR_DIAGNOSTIC_ORIGINAL,
        TRANSFORMERS_ERROR_DIAGNOSTIC_REPLACEMENT,
      ],
    ],
  },
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Model the exact queue-tail policy installed below. The current caller keeps
 * its original resolve/reject result, while the private tail always settles so
 * a canceled inference cannot poison the warm session's next run.
 */
export function createRecoveringSerializedInferenceAdapter() {
  let tail = Promise.resolve();
  return (run) => {
    const currentRun = tail.then(run);
    tail = currentRun.then(
      () => undefined,
      () => undefined,
    );
    return currentRun;
  };
}

export function isReviewedCooperativeCancellation(error) {
  return (
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    error.name === "AbortError" &&
    error.code === "ERR_ORT_WASM_RUN_CANCELED"
  );
}

/**
 * Model the exact early-rethrow policy installed in Transformers' model
 * wrapper. Expected cancellation reaches the caller without touching model
 * inputs or error logging; every other failure retains upstream diagnostics.
 */
export function rethrowTransformersInferenceError(error, reportOrdinaryError) {
  if (isReviewedCooperativeCancellation(error)) throw error;
  reportOrdinaryError();
  throw error;
}

export async function applyDependencyPatches(projectRoot = process.cwd()) {
  const lock = JSON.parse(
    await readFile(resolve(projectRoot, "package-lock.json"), "utf8"),
  );
  const lockedTransformers =
    lock.packages?.["node_modules/@huggingface/transformers"];
  if (
    lockedTransformers?.version !== TRANSFORMERS_VERSION ||
    lockedTransformers?.integrity !== TRANSFORMERS_INTEGRITY
  ) {
    throw new Error(
      "Refusing to patch an unreviewed @huggingface/transformers lock entry.",
    );
  }

  const dependencyRoot = resolve(
    projectRoot,
    "node_modules/@huggingface/transformers",
  );
  const packageMetadata = JSON.parse(
    await readFile(resolve(dependencyRoot, "package.json"), "utf8"),
  );
  if (packageMetadata.version !== TRANSFORMERS_VERSION) {
    throw new Error(
      `Expected @huggingface/transformers ${TRANSFORMERS_VERSION}, got ${packageMetadata.version}.`,
    );
  }

  const pendingWrites = [];
  for (const patch of PATCHES) {
    const path = resolve(dependencyRoot, patch.path);
    const source = await readFile(path, "utf8");
    const sourceSha256 = sha256(source);
    if (sourceSha256 === patch.patchedSha256) continue;
    if (sourceSha256 !== patch.originalSha256) {
      throw new Error(
        `Refusing to patch unreviewed ${patch.path} (${sourceSha256}).`,
      );
    }
    let patched = source;
    for (const [original, replacement] of patch.replacements) {
      const occurrences = patched.split(original).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `Expected one reviewed patch site in ${patch.path}, found ${occurrences}.`,
        );
      }
      patched = patched.replace(original, replacement);
    }
    const patchedSha256 = sha256(patched);
    if (patchedSha256 !== patch.patchedSha256) {
      throw new Error(
        `Patched ${patch.path} has unexpected digest ${patchedSha256}.`,
      );
    }
    pendingWrites.push({ path, patched });
  }

  // Validate every reviewed preimage before mutating any installed file. The
  // mutex tail must recover from every rejection, not only cancellation:
  // callers still receive the original error, while a rejected private tail
  // can never permanently block later work on the same warm session.
  for (const { path, patched } of pendingWrites) {
    await writeFile(path, patched);
  }

  console.log(
    `[linelight] applied reviewed Transformers ${TRANSFORMERS_VERSION} cancellation integration`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await applyDependencyPatches();
}
