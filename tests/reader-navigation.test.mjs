import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_POSITION_HISTORY,
  createPositionSnapshot,
  findDocumentMatches,
  isMeaningfulPositionJump,
  pushPositionHistory,
  resolveStoredPosition,
} from "../app/reader-navigation.mjs";

function tokensFor(text) {
  return Array.from(text.matchAll(/[\p{L}\p{N}]+/gu), (match, index) => ({
    index,
    text: match[0],
    start: match.index,
  }));
}

test("captures nearby text and recovers a bookmark after content shifts", () => {
  const original = tokensFor(
    "zero one two three four five anchor six seven eight nine ten eleven",
  );
  const snapshot = createPositionSnapshot(original, 6, 1234);

  assert.equal(snapshot.anchorText, "anchor");
  assert.equal(snapshot.tokenIndex, 6);
  assert.match(snapshot.snippet, /anchor six seven/);

  const shifted = tokensFor(
    "new opening words zero one two three four five anchor six seven eight nine ten eleven",
  );
  assert.equal(resolveStoredPosition(snapshot, shifted), 9);
});

test("prefers matching context when the saved index now holds the same word", () => {
  const original = tokensFor("zero one before anchor after ending");
  const snapshot = createPositionSnapshot(original, 3, 1234);
  const shifted = tokensFor(
    "new opening text anchor wrong place zero one before anchor after ending",
  );

  assert.equal(resolveStoredPosition(snapshot, shifted), 9);
});

test("refuses an ambiguous moved position without supporting context", () => {
  const ambiguous = {
    tokenIndex: 0,
    anchorText: "repeat",
    contextBefore: [],
    contextAfter: [],
  };
  const tokens = tokensFor("changed repeat middle repeat ending");

  assert.equal(resolveStoredPosition(ambiguous, tokens), null);
});

test("records only long jumps and keeps a bounded de-duplicated history", () => {
  assert.equal(isMeaningfulPositionJump(10, 21, 200), false);
  assert.equal(isMeaningfulPositionJump(10, 22, 200), true);
  assert.equal(isMeaningfulPositionJump(10, 60, 2000), false);
  assert.equal(isMeaningfulPositionJump(10, 90, 2000), true);

  let history = [];
  for (let index = 0; index < MAX_POSITION_HISTORY + 5; index += 1) {
    history = pushPositionHistory(history, {
      tokenIndex: index,
      anchorText: `word-${index}`,
    });
  }
  assert.equal(history.length, MAX_POSITION_HISTORY);
  assert.equal(history[0].tokenIndex, 5);

  history = pushPositionHistory(history, {
    tokenIndex: MAX_POSITION_HISTORY + 4,
    anchorText: `word-${MAX_POSITION_HISTORY + 4}`,
    createdAt: 999,
  });
  assert.equal(history.length, MAX_POSITION_HISTORY);
  assert.equal(history.at(-1).createdAt, 999);
});

test("finds document phrases and returns contextual positions", () => {
  const text = "A blue sky opens. Later, the blue sky darkens.";
  const tokens = tokensFor(text);
  const matches = findDocumentMatches(tokens, text, "blue sky");

  assert.deepEqual(
    matches.map((match) => match.tokenIndex),
    [1, 6],
  );
  assert.match(matches[0].snippet, /blue sky opens/);
  assert.deepEqual(findDocumentMatches(tokens, text, "x"), []);
});
