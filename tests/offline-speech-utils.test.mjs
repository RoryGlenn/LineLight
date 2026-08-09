import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidOfflineAudioError,
  buildOfflineAudioRecoveryText,
  buildWordPhonemeBatch,
  buildPhonemeWeightedBoundaries,
  countBatchedWordPhonemes,
  countPronouncedSymbols,
  extractTimedWords,
  generateUsableOfflineAudio,
  hasUsableOfflineAudio,
  isOfflineBackendRuntimeFailure,
  measureOfflineAudioLeadIn,
} from "../app/offline-speech-utils.mjs";

test("extracts source offsets for punctuation and contractions", () => {
  const words = extractTimedWords("Hello, don't stop.");

  assert.deepEqual(
    words.map(({ text, textOffset, trailingText }) => ({
      text,
      textOffset,
      trailingText,
    })),
    [
      { text: "Hello", textOffset: 0, trailingText: ", " },
      { text: "don't", textOffset: 7, trailingText: " " },
      { text: "stop", textOffset: 13, trailingText: "." },
    ],
  );
});

test("counts pronounced IPA symbols without stress marks", () => {
  assert.equal(countPronouncedSymbols("lˈaɪf"), 4);
  assert.equal(countPronouncedSymbols(""), 1);
});

test("batches words for one phonemizer call", () => {
  const words = extractTimedWords("Reading stays smooth.");

  assert.equal(buildWordPhonemeBatch(words), "Reading; stays; smooth");
  assert.deepEqual(
    countBatchedWordPhonemes(words, ["ɹˈiːdɪŋ", "stˈeɪz", "smˈuːð"]),
    [5, 5, 4],
  );
});

test("falls back to source weights if a phoneme batch loses boundaries", () => {
  const words = extractTimedWords("One extraordinary word");

  assert.deepEqual(countBatchedWordPhonemes(words, ["merged"]), [3, 13, 4]);
});

test("rejects silent and non-finite offline model output", () => {
  assert.equal(
    hasUsableOfflineAudio(new Float32Array([0, 0.1, -0.2]), 24_000),
    true,
  );
  assert.equal(
    hasUsableOfflineAudio(new Float32Array([0, Number.NaN]), 24_000),
    false,
  );
  assert.equal(
    hasUsableOfflineAudio(
      new Float32Array([0, Number.POSITIVE_INFINITY]),
      24_000,
    ),
    false,
  );
  assert.equal(
    hasUsableOfflineAudio(new Float32Array([0, 0]), 24_000),
    false,
  );
  assert.equal(hasUsableOfflineAudio(new Float32Array([0.1]), 0), false);
  assert.equal(
    buildOfflineAudioRecoveryText("sentence at a time."),
    ", sentence at a time.",
  );
});

test("classifies generic WebGPU and WASM runtime failures", () => {
  assert.equal(
    isOfflineBackendRuntimeFailure(
      new Error("Failed to create a session"),
    ),
    true,
  );
  assert.equal(
    isOfflineBackendRuntimeFailure(
      new WebAssembly.RuntimeError("memory access out of bounds"),
    ),
    true,
  );
  assert.equal(
    isOfflineBackendRuntimeFailure(
      new WebAssembly.CompileError("module validation failed"),
    ),
    true,
  );
  assert.equal(
    isOfflineBackendRuntimeFailure(
      new RangeError("WebAssembly.Memory(): could not allocate memory"),
    ),
    true,
  );
  assert.equal(
    isOfflineBackendRuntimeFailure(new Error("std::bad_alloc")),
    true,
  );
  assert.equal(
    isOfflineBackendRuntimeFailure({
      name: "GPUValidationError",
      message: "operation failed",
    }),
    true,
  );
  assert.equal(
    isOfflineBackendRuntimeFailure(
      new Error("The selected voice is unavailable"),
    ),
    false,
  );
});

test("retries invalid model audio once with lexical-free context", async () => {
  const calls = [];
  const finite = {
    audio: new Float32Array([0, 0.2]),
    sampling_rate: 24_000,
  };
  const result = await generateUsableOfflineAudio(
    "sentence at a time.",
    async (text) => {
      calls.push(text);
      return calls.length === 1
        ? {
            audio: new Float32Array([Number.NaN]),
            sampling_rate: 24_000,
          }
        : finite;
    },
  );

  assert.equal(result, finite);
  assert.deepEqual(calls, [
    "sentence at a time.",
    ", sentence at a time.",
  ]);
});

test("rejects a second invalid model waveform without another retry", async () => {
  const calls = [];
  await assert.rejects(
    generateUsableOfflineAudio("at a time.", async (text) => {
      calls.push(text);
      return {
        audio: new Float32Array([0, Number.NaN]),
        sampling_rate: 24_000,
      };
    }),
    InvalidOfflineAudioError,
  );
  assert.deepEqual(calls, ["at a time.", ", at a time."]);
});

test("uses measured waveform onset for the first highlight", () => {
  const samples = new Float32Array(24_000);
  samples[7_200] = 0.02;
  const leadIn = measureOfflineAudioLeadIn(samples, 24_000);
  assert.equal(leadIn, 0.3);

  const boundaries = buildPhonemeWeightedBoundaries(
    "Sentence at a time.",
    2,
    [8, 2, 1, 4],
    { leadingSilenceSeconds: leadIn },
  );
  assert.equal(boundaries[0].audioOffsetSeconds, 0.3);
});

test("ignores low-level pre-roll when measuring audible onset", () => {
  const samples = new Float32Array(24_000);
  samples[1_920] = 0.001;
  samples[7_200] = 0.007;
  samples[8_000] = 0.6;

  assert.equal(measureOfflineAudioLeadIn(samples, 24_000), 0.3);
});

test("builds monotonic boundaries across the real waveform duration", () => {
  const boundaries = buildPhonemeWeightedBoundaries(
    "A short phrase, then a longer ending.",
    4.2,
    [1, 4, 4, 3, 1, 6, 5],
  );

  assert.equal(boundaries.length, 7);
  assert.equal(boundaries[0].text, "A");
  assert.equal(boundaries.at(-1).text, "ending");
  assert.ok(boundaries[0].audioOffsetSeconds >= 0);
  assert.ok(
    boundaries.every(
      (boundary, index) =>
        index === 0 ||
        boundary.audioOffsetSeconds >
          boundaries[index - 1].audioOffsetSeconds,
    ),
  );
  assert.ok(
    boundaries.at(-1).audioOffsetSeconds +
      boundaries.at(-1).durationSeconds <=
      4.2,
  );
});

test("allocates an audible pause after punctuation", () => {
  const withComma = buildPhonemeWeightedBoundaries(
    "One, two",
    2,
    [3, 3],
  );
  const withoutComma = buildPhonemeWeightedBoundaries(
    "One two",
    2,
    [3, 3],
  );

  assert.ok(
    withComma[1].audioOffsetSeconds >
      withoutComma[1].audioOffsetSeconds,
  );
});
