import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWordPhonemeBatch,
  buildPhonemeWeightedBoundaries,
  countBatchedWordPhonemes,
  countPronouncedSymbols,
  extractTimedWords,
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
