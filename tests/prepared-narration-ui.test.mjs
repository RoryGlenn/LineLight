import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("connects resumable preparation, compressed playback, quota, and cleanup", async () => {
  const source = await readFile("app/page.tsx", "utf8");
  for (const required of [
    "createPreparedNarrationManifest",
    "commitReaderPreparedNarrationChunk",
    "encodePreparedNarrationAudio",
    "decodePreparedNarrationAudio",
    "navigator.storage?.estimate",
    "PREPARED_NARRATION_CHUNK_CHARACTERS",
    "Pause",
    "Cancel &amp; remove",
    "Remove all prepared audio",
  ]) {
    assert.ok(source.includes(required), `missing ${required}`);
  }
  assert.match(
    source,
    /metadata\.startIndex <= safeIndex[\s\S]*safeIndex < metadata\.nextIndex/u,
  );
  assert.match(
    source,
    /initialPreparedSeekIndex[\s\S]*findBufferedSeekOffset/u,
  );
  assert.doesNotMatch(
    source,
    /preparedNarrationManifest\?\.status === "ready"[\s\S]{0,240}preparedNarrationMetadata\.find/u,
  );
});

test("connects sequential bounded WAV export and exact sidecar re-import", async () => {
  const source = await readFile("app/page.tsx", "utf8");
  for (const required of [
    "exportPreparedNarration",
    "listReaderPreparedNarrationChunkMetadata",
    "getReaderPreparedNarrationChunk",
    "showDirectoryPicker",
    "Export WAV + timing",
    "Verify timing sidecar",
    "matchesPreparedNarrationExport",
    "different book or edition",
    "Cancel export",
  ]) {
    assert.ok(source.includes(required), `missing ${required}`);
  }
  assert.match(source, /return decodePreparedNarrationAudio\(record\)/u);
});
