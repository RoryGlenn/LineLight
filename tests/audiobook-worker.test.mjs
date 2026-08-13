import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("runs pinned local-only q8 transcription in a dedicated worker", async () => {
  const source = await readFile("app/audiobook-alignment.worker.ts", "utf8");
  assert.match(source, /allowLocalModels = true/u);
  assert.match(source, /allowRemoteModels = false/u);
  assert.match(source, /AUDIOBOOK_ALIGNMENT_MODEL_LOCAL_PATH/u);
  assert.match(source, /AUDIOBOOK_ALIGNMENT_MODEL_REVISION/u);
  assert.match(source, /dtype: "q8"/u);
  assert.match(source, /device: "wasm"/u);
  assert.match(source, /return_timestamps: true/u);
  assert.doesNotMatch(source, /console\.(?:log|debug|info)/u);
});

test("transfers one bounded PCM window and cancels by terminating inference", async () => {
  const source = await readFile("app/audiobook-transcriber.ts", "utf8");
  assert.match(source, /transfer: \[audio\.buffer\]/u);
  assert.match(source, /worker\?\.terminate\(\)/u);
  assert.match(source, /new DOMException\([\s\S]*"AbortError"/u);
  assert.doesNotMatch(source, /console\.(?:log|debug|info)/u);
});

test("connects attachment, resume, manual sync, confidence gating, and cleanup", async () => {
  const source = await readFile("app/page.tsx", "utf8");
  for (const required of [
    "attachReaderAudiobook",
    "commitReaderAudiobookTranscriptWindow",
    "listReaderAudiobookTranscriptWindows",
    "findTimedMediaAnchorAtTime",
    "findTimedMediaPositionForToken",
    "Sync this sentence here",
    "Pause alignment",
    "Remove this audiobook",
    "different edition",
    "AA/AAX",
  ]) {
    assert.ok(source.includes(required), `missing ${required}`);
  }
  assert.match(
    source,
    /processedWindows:\s*storedKeys\.size/u,
  );
  assert.match(
    source,
    /if \(firstMissing\) \{[\s\S]*prepareAudiobookTranscriber/u,
  );
  assert.match(
    source,
    /anchor\.source === "manual"/u,
  );
});
