import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  OFFLINE_TIMING_BOOK_INPUT_SELECTOR,
  OFFLINE_TIMING_SETTINGS_CLOSE_SELECTOR,
  validateOfflineNaturalTimingEvidence,
} from "../scripts/run-offline-natural-timing-regression.mjs";

const execFileAsync = promisify(execFile);

function passingRate(rate) {
  return {
    rate,
    selectedRate: rate,
    observedTransitions: 12,
    logicalIndexDeltas: Array.from({ length: 12 }, () => 1),
    maximumLogicalIndexDelta: 1,
    maximumActivationsPerFrame: 1,
    maximumLongTaskMs: 0,
    audioChunks: [{ sourceKind: "blob", events: [{ name: "playing" }] }],
    failures: [],
  };
}

function passingEvidence() {
  return {
    schemaVersion: 1,
    issue: 60,
    source: { commit: "test" },
    fixture: { sha256: "test" },
    precondition: { offlineVoice: "M2" },
    rates: [0.75, 1, 1.25].map(passingRate),
    browserDiagnostics: { errors: [] },
  };
}

test("accepts consecutive Offline-natural highlights at every required rate", () => {
  assert.deepEqual(
    validateOfflineNaturalTimingEvidence(passingEvidence()),
    [],
  );
});

test("selects the book input instead of an audiobook timing sidecar", () => {
  assert.equal(
    OFFLINE_TIMING_BOOK_INPUT_SELECTOR,
    'input[type="file"][accept*=".pdf"]',
  );
  assert.doesNotMatch(OFFLINE_TIMING_BOOK_INPUT_SELECTOR, /json/iu);
});

test("closes the current reading settings panel before importing", () => {
  assert.equal(
    OFFLINE_TIMING_SETTINGS_CLOSE_SELECTOR,
    '.settings-panel button[aria-label="Close reading settings"]',
  );
});

test("rejects a skipped logical word, frame catch-up, or playback Long Task", () => {
  const evidence = passingEvidence();
  evidence.rates[1].logicalIndexDeltas[4] = 2;
  evidence.rates[1].maximumLogicalIndexDelta = 2;
  evidence.rates[1].maximumActivationsPerFrame = 2;
  evidence.rates[1].maximumLongTaskMs = 51;
  assert.match(
    validateOfflineNaturalTimingEvidence(evidence).join("\n"),
    /skipped or reversed.*advanced across multiple.*activated multiple.*Long Task/isu,
  );
});

test(
  "runs real Offline-natural timing when an explicit ready-profile CDP endpoint is provided",
  {
    skip: !process.env.LINELIGHT_OFFLINE_TIMING_CDP,
    timeout: 600_000,
  },
  async () => {
    const outputDirectory = await mkdtemp(
      path.join(os.tmpdir(), "linelight-offline-timing-evidence-"),
    );
    try {
      await execFileAsync(
        process.execPath,
        [
          "scripts/run-offline-natural-timing-regression.mjs",
          "--cdp",
          process.env.LINELIGHT_OFFLINE_TIMING_CDP,
          "--url",
          process.env.LINELIGHT_OFFLINE_TIMING_URL ??
            "http://127.0.0.1:5189/",
          "--output",
          outputDirectory,
          ...(process.env.LINELIGHT_OFFLINE_TIMING_VOICE
            ? ["--voice", process.env.LINELIGHT_OFFLINE_TIMING_VOICE]
            : []),
        ],
        { cwd: path.resolve("."), timeout: 590_000 },
      );
      const evidence = JSON.parse(
        await readFile(
          path.join(outputDirectory, "offline-natural-timing.json"),
          "utf8",
        ),
      );
      assert.equal(evidence.passed, true, evidence.failures?.join("\n"));
      assert.deepEqual(validateOfflineNaturalTimingEvidence(evidence), []);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  },
);
