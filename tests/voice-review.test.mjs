import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  analyzePcm16,
  buildVoiceReview,
  calculateWordErrorRate,
  formatVoiceReview,
  normalizeTranscript,
  parsePcm16Wav,
} from "../scripts/lib/voice-review.mjs";

const execFileAsync = promisify(execFile);

function pcm16Wav(samples, sampleRate = 16000) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

test("normalizes punctuation, apostrophes, case, and dashes for WER", () => {
  const expected = "Reading isn't a race — it's a read-along place.";
  const transcript = "reading isnt a race its a read along place";

  assert.deepEqual(normalizeTranscript(expected), normalizeTranscript(transcript));
  assert.deepEqual(calculateWordErrorRate(expected, transcript), {
    errors: 0,
    hypothesisWords: 9,
    referenceWords: 9,
    wer: 0,
  });
});

test("calculates substitutions and insertions as word errors", () => {
  const result = calculateWordErrorRate("one two three", "one four three extra");

  assert.equal(result.errors, 2);
  assert.equal(result.wer, 2 / 3);
});

test("parses normalized PCM WAV data", () => {
  const source = Int16Array.from([0, 10, -20, 32767]);
  const parsed = parsePcm16Wav(pcm16Wav(source));

  assert.equal(parsed.sampleRate, 16000);
  assert.deepEqual(Array.from(parsed.samples), Array.from(source));
});

test("rejects WAV data that was not normalized to 16 kHz", () => {
  assert.throws(
    () => parsePcm16Wav(pcm16Wav(Int16Array.from([1, 2]), 24000)),
    /mono 16 kHz/,
  );
});

test("measures levels, clipping, and meaningful internal pauses", () => {
  const sampleRate = 1000;
  const samples = new Int16Array(1400);
  samples.fill(10000, 200, 600);
  samples.fill(10000, 800, 1200);
  samples[300] = 32767;
  samples[900] = -32768;

  const result = analyzePcm16(samples, sampleRate);

  assert.equal(result.durationSeconds, 1.4);
  assert.equal(result.clippedSamples, 2);
  assert.equal(result.leadingSilenceSeconds, 0.2);
  assert.equal(result.trailingSilenceSeconds, 0.2);
  assert.deepEqual(result.meaningfulPauses, [
    {
      durationSeconds: 0.2,
      endSeconds: 0.8,
      kind: "internal",
      startSeconds: 0.6,
    },
  ]);
  assert.equal(result.peakDbfs, 0);
  assert.ok(result.rmsDbfs < -12 && result.rmsDbfs > -14);
});

test("builds a good offline review when naturalness and WER are strong", () => {
  const review = buildVoiceReview({
    audioPath: "/tmp/voice.wav",
    expectedText: "Reading is not a race.",
    models: {
      utmos: { id: "utmos", revision: "immutable" },
      whisper: { id: "whisper", revision: "immutable" },
    },
    signal: {
      clippedSamples: 0,
      clippingPercent: 0,
      durationSeconds: 2,
      leadingSilenceSeconds: 0.1,
      meaningfulPauses: [],
      peakDbfs: -3,
      rmsDbfs: -20,
      sampleRate: 16000,
      trailingSilenceSeconds: 0.1,
    },
    transcript: "Reading is not a race",
    utmosScore: 4.25,
  });

  assert.equal(review.status, "looks-good");
  assert.equal(review.intelligibility.wer, 0);
  assert.equal(review.signal.wordsPerMinute, 150);
  assert.equal(review.privacy.networkAccessDuringReview, false);
  assert.match(formatVoiceReview(review), /Naturalness: 4\.25\/5/);
});

test("CLI help does not prepare or download models", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/review-voice.mjs",
    "--help",
  ]);

  assert.match(stdout, /Prepare the pinned local models once/);
  assert.match(stdout, /reviews are always strictly offline/);
});
