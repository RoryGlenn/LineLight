import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const VERSION = "1.22.0-dev.20250409-89f8206ba4";
const TARBALL_SPEC =
  "file:vendor/onnxruntime-web/onnxruntime-web-1.22.0-dev.20250409-89f8206ba4.tgz";
const TARBALL = path.resolve(TARBALL_SPEC.slice("file:".length));
const EXPECTED_TARBALL_SHA256 =
  "8ded0bd491693184e4ee9b47356264986409d2f1ccd205b6d24d3d4ce6f43542";
const EXPECTED_RUNTIME_SHA256 = Object.freeze({
  "package/dist/ort-wasm-simd-threaded.wasm":
    "db1fa2012c98f8806f5641558635261a9b09aaff8827e01a38ffdcb4d73f7a22",
  "package/dist/ort-wasm-simd-threaded.mjs":
    "87a120859ceba8870536ab6684a47b5cdb2515a33a0ab80c4520ec84fbe3df85",
  "package/dist/ort-wasm-simd-threaded.jsep.wasm":
    "1e5a323ca41d859f324694c7b5ba2052bf8c1a96ff9721bc62e94f874d379fe1",
  "package/dist/ort-wasm-simd-threaded.jsep.mjs":
    "c1458b19e63c7b104a38fc4dd44a0993b58c961a2c7884b347d2abce74556a22",
});

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function readTarMember(member) {
  const { stdout } = await execFile("tar", ["-xOzf", TARBALL, member], {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

test("the reviewed ORT package contains the exact runtime and legal inventory", async () => {
  const tarball = await readFile(TARBALL);
  assert.equal(sha256(tarball), EXPECTED_TARBALL_SHA256);

  const { stdout: listing } = await execFile("tar", ["-tzf", TARBALL]);
  const members = new Set(listing.trim().split("\n"));
  for (const member of [
    "package/LICENSE",
    "package/LINELIGHT-NOTICE.txt",
    "package/ThirdPartyNotices.txt",
    "package/package.json",
    "package/types.d.ts",
    ...Object.keys(EXPECTED_RUNTIME_SHA256),
  ]) {
    assert.equal(members.has(member), true, member);
  }

  const metadata = JSON.parse(
    (await readTarMember("package/package.json")).toString("utf8"),
  );
  assert.equal(metadata.name, "onnxruntime-web");
  assert.equal(metadata.version, VERSION);

  const [packagedTypes, installedTypes, typeReference] = await Promise.all([
    readTarMember("package/types.d.ts"),
    readFile("node_modules/onnxruntime-web/types.d.ts"),
    readFile("app/onnxruntime-web-types.d.ts", "utf8"),
  ]);
  assert.equal(sha256(packagedTypes), sha256(installedTypes));
  assert.equal(
    sha256(packagedTypes),
    "b46e661f0b650aa22ab41aa1ccb08a791686bd0d7114034cc5d40fea36ce9d64",
  );
  assert.match(
    typeReference,
    /import "\.\.\/node_modules\/onnxruntime-web\/types\.d\.ts";/u,
  );

  for (const [member, expected] of Object.entries(EXPECTED_RUNTIME_SHA256)) {
    assert.equal(sha256(await readTarMember(member)), expected, member);
  }

  for (const member of [
    "package/dist/ort-wasm-simd-threaded.mjs",
    "package/dist/ort-wasm-simd-threaded.jsep.mjs",
  ]) {
    const wrapper = (await readTarMember(member)).toString("utf8");
    for (const symbol of [
      "_OrtGetRunCancellationMailbox",
      "_OrtBeginRunCancellation",
      "_OrtIsRunCancellationRequested",
      "_OrtEndRunCancellation",
    ]) {
      assert.equal(wrapper.includes(symbol), true, `${member}: ${symbol}`);
    }
  }
});

test("the root lock binds the exact local ORT artifact and integrity", async () => {
  const [manifest, lock, tarball] = await Promise.all([
    readFile("package.json", "utf8").then(JSON.parse),
    readFile("package-lock.json", "utf8").then(JSON.parse),
    readFile(TARBALL),
  ]);
  assert.equal(manifest.dependencies["onnxruntime-web"], TARBALL_SPEC);
  assert.equal(lock.packages[""].dependencies["onnxruntime-web"], TARBALL_SPEC);
  const installed = lock.packages["node_modules/onnxruntime-web"];
  assert.equal(installed.version, VERSION);
  assert.equal(installed.resolved, TARBALL_SPEC);
  assert.equal(
    installed.integrity,
    `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  );
});

test("the clean install has one custom ORT and one patched Transformers instance", async () => {
  for (const dependency of ["onnxruntime-web", "@huggingface/transformers"]) {
    const { stdout } = await execFile(
      "npm",
      ["ls", dependency, "--all", "--parseable"],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );
    const paths = stdout.trim().split("\n").filter(Boolean);
    assert.deepEqual(paths, [path.resolve("node_modules", dependency)]);
  }
});

test("an initialized threaded module calls all four cancellation wrappers", async () => {
  const { stdout, stderr } = await execFile(
    process.execPath,
    [
      "vendor/onnxruntime-web/runtime-export-smoke.mjs",
      "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
      "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
    ],
    { cwd: process.cwd(), maxBuffer: 1024 * 1024, timeout: 30_000 },
  );
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.sharedMemory, true);
  assert.equal(result.mailboxCells, 3);
  assert.equal(result.wrapperExports, 4);
  assert.notEqual(result.firstGeneration, result.secondGeneration);
});
