import assert from "node:assert/strict";
import test from "node:test";

import { normalizeNarrationReadiness } from "../app/narration-readiness.mjs";

test("normalizes narration readiness into an accessible percentage", () => {
  assert.deepEqual(
    normalizeNarrationReadiness(42.4, "Generating narration audio…"),
    {
      progress: 42,
      label: "Generating narration audio…",
    },
  );
  assert.equal(normalizeNarrationReadiness(-5, "Starting").progress, 0);
  assert.equal(normalizeNarrationReadiness(105, "Ready").progress, 100);
});

test("keeps readiness monotonic across a backend retry", () => {
  const retried = normalizeNarrationReadiness(
    8,
    "Switching to compatibility mode…",
    64,
  );

  assert.deepEqual(retried, {
    progress: 64,
    label: "Switching to compatibility mode…",
  });
});
