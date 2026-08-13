import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFLINE_FIRST_CHUNK_CHARACTERS,
  OFFLINE_INSTALL_IDLE_DELAY_MS,
  OFFLINE_MAX_CHUNK_CHARACTERS,
  OFFLINE_MIN_CHUNK_CHARACTERS,
  OFFLINE_WARM_IDLE_TIMEOUT_MS,
  adaptOfflineSpeechChunkCharacters,
  evaluateOfflineStorageHeadroom,
  mapOfflineInstallProgress,
  mapOfflineNarrationPhaseProgress,
  shouldAbortOfflineWarmRestore,
  shouldDisposeOfflineWorkerForImport,
  shouldRestoreOfflineWorkerAfterImport,
  shouldScheduleOfflinePreparation,
} from "../app/offline-preparation.mjs";

test("does not schedule the offline pack while a document is importing", () => {
  const ready = {
    attempted: false,
    engine: "offline",
    importing: false,
    packState: "missing",
    settingsRestored: true,
  };
  assert.equal(shouldScheduleOfflinePreparation(ready), true);
  assert.equal(
    shouldScheduleOfflinePreparation({ ...ready, importing: true }),
    false,
  );
  assert.equal(
    shouldScheduleOfflinePreparation({ ...ready, attempted: true }),
    false,
  );
});

test("missing offline preparation is eligible on the first idle turn", () => {
  assert.equal(OFFLINE_INSTALL_IDLE_DELAY_MS, 0);
  assert.equal(OFFLINE_WARM_IDLE_TIMEOUT_MS, 5_000);
});

test("document import preserves a ready offline model worker", () => {
  assert.equal(shouldDisposeOfflineWorkerForImport("ready"), false);
  assert.equal(shouldDisposeOfflineWorkerForImport("missing"), false);
  assert.equal(shouldDisposeOfflineWorkerForImport("installing"), true);
});

test("document import prepares every installed offline model after paint", () => {
  assert.equal(
    shouldRestoreOfflineWorkerAfterImport({
      packState: "ready",
      readinessState: "ready",
    }),
    true,
  );
  assert.equal(
    shouldRestoreOfflineWorkerAfterImport({
      packState: "ready",
      readinessState: "idle",
    }),
    true,
  );
  assert.equal(
    shouldRestoreOfflineWorkerAfterImport({
      packState: "ready",
      readinessState: "warming",
    }),
    true,
  );
  assert.equal(
    shouldRestoreOfflineWorkerAfterImport({
      packState: "missing",
      readinessState: "ready",
    }),
    false,
  );
});

test("Play joins active idle initialization but cancels work not yet started", () => {
  assert.equal(
    shouldAbortOfflineWarmRestore({ abortActive: false, started: false }),
    true,
  );
  assert.equal(
    shouldAbortOfflineWarmRestore({ abortActive: false, started: true }),
    false,
  );
  assert.equal(
    shouldAbortOfflineWarmRestore({ abortActive: true, started: true }),
    true,
  );
});

test("requires fixed runtime headroom for the 44.1 kHz offline pack", () => {
  const enough = evaluateOfflineStorageHeadroom(401_276_744, {
    quota: 800_000_000,
    usage: 300_000_000,
  });
  assert.deepEqual(enough, {
    availableBytes: 500_000_000,
    requiredBytes: 451_276_744,
    sufficient: true,
  });
  assert.equal(
    evaluateOfflineStorageHeadroom(401_276_744, {
      quota: 700_000_000,
      usage: 300_000_000,
    }).sufficient,
    false,
  );
  assert.equal(
    evaluateOfflineStorageHeadroom(401_276_744, undefined).sufficient,
    null,
  );
});

test("a resumed install reserves only missing pack bytes plus runtime margin", () => {
  const resumed = evaluateOfflineStorageHeadroom(
    401_276_744,
    {
      quota: 600_000_000,
      usage: 400_000_000,
    },
    300_000_000,
  );
  assert.deepEqual(resumed, {
    availableBytes: 200_000_000,
    requiredBytes: 151_276_744,
    sufficient: true,
  });
});

test("starts short and adapts later offline chunks to measured buffer health", () => {
  assert.equal(OFFLINE_FIRST_CHUNK_CHARACTERS, 24);
  assert.equal(
    adaptOfflineSpeechChunkCharacters({
      currentCharacters: OFFLINE_FIRST_CHUNK_CHARACTERS,
      synthesisMilliseconds: 1_000,
      audioDurationSeconds: 10,
    }),
    OFFLINE_MIN_CHUNK_CHARACTERS * 2,
  );
  assert.equal(
    adaptOfflineSpeechChunkCharacters({
      currentCharacters: 240,
      synthesisMilliseconds: 1_000,
      audioDurationSeconds: 10,
    }),
    OFFLINE_MAX_CHUNK_CHARACTERS,
  );
  assert.equal(
    adaptOfflineSpeechChunkCharacters({
      currentCharacters: OFFLINE_FIRST_CHUNK_CHARACTERS,
      synthesisMilliseconds: 20_000,
      audioDurationSeconds: 10,
    }),
    OFFLINE_MIN_CHUNK_CHARACTERS,
  );
});

test("keeps the current chunk size when timing data is unavailable", () => {
  assert.equal(
    adaptOfflineSpeechChunkCharacters({
      currentCharacters: 176,
      synthesisMilliseconds: 0,
      audioDurationSeconds: Number.NaN,
    }),
    176,
  );
});

test("maps model initialization and synthesis into truthful monotonic phases", () => {
  assert.equal(mapOfflineNarrationPhaseProgress("initializing", 0), 4);
  assert.equal(mapOfflineNarrationPhaseProgress("initializing", 100), 60);
  assert.equal(mapOfflineNarrationPhaseProgress("synthesizing", 0), 60);
  assert.equal(mapOfflineNarrationPhaseProgress("synthesizing", 50), 77);
  assert.equal(mapOfflineNarrationPhaseProgress("synthesizing", 100), 94);
});

test("keeps install download, initialization, and warm-up visibly distinct", () => {
  const sequence = [
    mapOfflineInstallProgress("downloading", 0),
    mapOfflineInstallProgress("downloading", 98),
    mapOfflineInstallProgress("verifying", 99),
    mapOfflineInstallProgress("verifying", 2),
    mapOfflineInstallProgress("initializing", 8),
    mapOfflineInstallProgress("initializing", 62),
    mapOfflineInstallProgress("warming", 76),
    mapOfflineInstallProgress("ready", 100),
  ];

  assert.deepEqual(sequence, [0, 82, 85, 85, 87, 91, 98, 100]);
  assert.ok(sequence.every((value, index) => index === 0 || value >= sequence[index - 1]));
});
