import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { RawImage } from "@huggingface/transformers";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

test("Transformers image helpers remain compatible with patched Sharp", async () => {
  assert.equal(sharp.versions.sharp, "0.35.3");

  const source = new RawImage(
    new Uint8ClampedArray([
      255, 0, 0,
      0, 255, 0,
      0, 0, 255,
      255, 255, 255,
    ]),
    2,
    2,
    3,
  );
  const affineResized = await source.resize(4, 4, {
    resample: "bilinear",
  });
  const lanczosResized = await source.resize(4, 4, {
    resample: "lanczos",
  });
  const padded = await lanczosResized.pad([1, 1, 1, 1]);
  const cropped = await padded.crop([1, 1, 4, 4]);
  const encoded = await cropped.toSharp().png().toBuffer();
  const decoded = await RawImage.read(
    new Blob([encoded], { type: "image/png" }),
  );

  assert.deepEqual(affineResized.size, [4, 4]);
  assert.deepEqual(lanczosResized.size, [4, 4]);
  assert.deepEqual(padded.size, [6, 6]);
  assert.deepEqual(cropped.size, [4, 4]);
  assert.deepEqual(decoded.size, [4, 4]);
  assert.equal(decoded.channels, 3);
  assert.equal(decoded.data.length, 4 * 4 * 3);
});

test("Drizzle Kit remains compatible with patched esbuild", async () => {
  const { stdout } = await execFileAsync(
    "./node_modules/.bin/drizzle-kit",
    ["check"],
  );

  assert.match(stdout, /Everything's fine/u);
});

test("production artifacts exclude native Sharp and libvips files", async () => {
  const files = await listFiles("dist");
  const nativeImageFiles = files.filter((path) =>
    /(?:^|[/\\])(?:@img|sharp|libvips)(?:[/\\]|$)|\.node$/iu.test(path),
  );
  const offlineWorkers = files.filter((path) =>
    /^offline-speech\.worker-.*\.js$/u.test(basename(path)),
  );

  assert.deepEqual(nativeImageFiles, []);
  assert.ok(offlineWorkers.length >= 1);

  for (const worker of offlineWorkers) {
    const source = await readFile(worker, "utf8");
    assert.match(source, /sharp \(ignored\)/u);
    assert.doesNotMatch(source, /@img[/\\]sharp|sharp-libvips|sharp\.node/iu);
  }
});
