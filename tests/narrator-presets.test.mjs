import assert from "node:assert/strict";
import test from "node:test";

import {
  PODCAST_HOST_PRESET,
  applyNarratorPreset,
  isNarratorPresetActive,
} from "../app/narrator-presets.mjs";

test("applies the reviewed podcast-host voice and pace without changing reader layout", () => {
  const settings = {
    narrationEngine: "device",
    offlineVoice: "am_michael",
    rate: 1.25,
    font: "serif",
    lineHeight: 1.78,
    follow: true,
  };

  const result = applyNarratorPreset(settings);

  assert.notEqual(result, settings);
  assert.deepEqual(result, {
    ...settings,
    narrationEngine: "offline",
    offlineVoice: "F2",
    rate: 0.9,
  });
  assert.equal(PODCAST_HOST_PRESET.label, "Podcast host");
  assert.equal(
    PODCAST_HOST_PRESET.description,
    "Warm Studio F2 voice · native 44.1 kHz · fully offline",
  );
});

test("marks the preset active only while all of its voice settings match", () => {
  const selected = applyNarratorPreset({ theme: "cream" });

  assert.equal(isNarratorPresetActive(selected), true);
  assert.equal(isNarratorPresetActive({ ...selected, rate: 1 }), false);
  assert.equal(
    isNarratorPresetActive({ ...selected, offlineVoice: "bm_george" }),
    false,
  );
  assert.equal(
    isNarratorPresetActive({ ...selected, narrationEngine: "azure" }),
    false,
  );
});
