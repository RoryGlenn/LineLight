import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateOfflineStorageHeadroom,
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

test("requires transient storage headroom for the offline pack", () => {
  const enough = evaluateOfflineStorageHeadroom(95_000_000, {
    quota: 500_000_000,
    usage: 200_000_000,
  });
  assert.deepEqual(enough, {
    availableBytes: 300_000_000,
    requiredBytes: 190_000_000,
    sufficient: true,
  });
  assert.equal(
    evaluateOfflineStorageHeadroom(95_000_000, {
      quota: 300_000_000,
      usage: 150_000_000,
    }).sufficient,
    false,
  );
  assert.equal(
    evaluateOfflineStorageHeadroom(95_000_000, undefined).sufficient,
    null,
  );
});
