import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSpeechChunk,
  isRetryableSpeechError,
  speechFailureMessage,
} from "../app/speech-utils.mjs";

function tokenize(text) {
  const matches = Array.from(text.matchAll(/\b[\p{L}\p{N}]+\b/gu));
  let sentenceIndex = 0;

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const token = {
      index,
      text: match[0],
      start,
      end: start + match[0].length,
      sentenceIndex,
    };
    const between = text.slice(token.end, matches[index + 1]?.index);
    if (/[.!?]/.test(between)) sentenceIndex += 1;
    return token;
  });
}

test("speech chunks prefer sentence boundaries", () => {
  const text =
    "The first sentence is short. The second sentence is also short. A third sentence follows.";
  const tokens = tokenize(text);
  const chunk = buildSpeechChunk(text, tokens, 0, 68);

  assert.ok(chunk);
  assert.equal(
    chunk.text,
    "The first sentence is short. The second sentence is also short.",
  );
  assert.equal(tokens[chunk.nextIndex].text, "A");
});

test("speech chunks split a long sentence at a safe word boundary", () => {
  const text =
    "one two three four five six seven eight nine ten eleven twelve thirteen";
  const tokens = tokenize(text);
  const chunk = buildSpeechChunk(text, tokens, 0, 24);

  assert.ok(chunk);
  assert.equal(chunk.text, "one two three four five");
  assert.equal(tokens[chunk.nextIndex].text, "six");
  assert.ok(chunk.text.length <= 24);
});

test("speech chunks can continue from the middle of a document", () => {
  const text = "Alpha beta. Gamma delta. Epsilon zeta.";
  const tokens = tokenize(text);
  const chunk = buildSpeechChunk(text, tokens, 2, 20);

  assert.ok(chunk);
  assert.equal(chunk.text, "Gamma delta.");
  assert.equal(tokens[chunk.nextIndex].text, "Epsilon");
});

test("classifies transient speech errors for one retry", () => {
  assert.equal(isRetryableSpeechError("synthesis-failed"), true);
  assert.equal(isRetryableSpeechError("audio-busy"), true);
  assert.equal(isRetryableSpeechError("not-allowed"), false);
  assert.equal(isRetryableSpeechError("audio-hardware"), false);
});

test("provides Ubuntu-specific failure guidance", () => {
  assert.match(speechFailureMessage("synthesis-unavailable"), /Ubuntu voice/);
  assert.match(
    speechFailureMessage("synthesis-failed", false),
    /Ubuntu speech voice/,
  );
  assert.match(speechFailureMessage("not-allowed"), /Brave blocked/);
});
