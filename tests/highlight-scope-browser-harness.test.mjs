import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { validateHighlightScopeEvidence } from "../scripts/run-highlight-scope-browser-regression.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(".");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function passingVisual(view) {
  return {
    fragmentCount: 3,
    activeRegionIndices: ["1"],
    exactTokenCount: 1,
    exactTokenVisual: { transparent: true },
    overlayAriaHidden: view === "page" ? true : null,
    screenshot: `${view}.png`,
    screenshotSha256: "test",
  };
}

function passingInteraction() {
  return {
    rootIdentityPreserved: true,
    shellIdentityPreserved: true,
    mapRenderCountBefore: 2,
    mapRenderCountAfter: 2,
    changedShellRenderCounts: [],
    mutations: { childList: 0 },
    longTasks: [],
  };
}

function passingEvidence() {
  return {
    schemaVersion: 1,
    issue: 62,
    legacyMigration: { passed: true },
    settings: {
      options: [
        { value: "sentence", label: "Sentence" },
        { value: "paragraph", label: "Paragraph" },
      ],
    },
    visuals: {
      focus: {
        sentence: passingVisual("focus"),
        paragraph: { ...passingVisual("focus"), fragmentCount: 4 },
      },
      page: {
        sentence: passingVisual("page"),
        paragraph: { ...passingVisual("page"), fragmentCount: 4 },
      },
    },
    interactions: {
      focus: passingInteraction(),
      page: passingInteraction(),
    },
    navigation: { passed: true },
    persistence: { passed: true },
    performance: { maximumLongTaskMs: 0 },
    browserDiagnostics: { errors: [] },
  };
}

test("accepts complete sentence/paragraph browser evidence", () => {
  assert.deepEqual(validateHighlightScopeEvidence(passingEvidence()), []);
});

test("rejects a word box, shell reconciliation, or interaction Long Task", () => {
  const evidence = passingEvidence();
  evidence.visuals.page.paragraph.exactTokenVisual.transparent = false;
  evidence.interactions.focus.mutations.childList = 1;
  evidence.interactions.page.changedShellRenderCounts = [
    { index: 1, before: 2, after: 3 },
  ];
  evidence.performance.maximumLongTaskMs = 51;
  const failures = validateHighlightScopeEvidence(evidence).join("\n");
  assert.match(failures, /visible exact-word box/iu);
  assert.match(failures, /stable shell list/iu);
  assert.match(failures, /Long Task/iu);
});

test("keeps committed headed-Brave evidence tied to the exact sources and screenshots", async () => {
  const evidenceDirectory = path.join(repositoryRoot, "docs/evidence/issue-62");
  const evidence = JSON.parse(
    await readFile(
      path.join(evidenceDirectory, "highlight-scope-browser.json"),
      "utf8",
    ),
  );
  assert.equal(evidence.browser.headed, true);
  assert.equal(evidence.passed, true, evidence.failures?.join("\n"));
  assert.deepEqual(validateHighlightScopeEvidence(evidence), []);

  for (const [source, expectedHash] of Object.entries(evidence.source.files)) {
    assert.equal(
      sha256(await readFile(path.join(repositoryRoot, source))),
      expectedHash,
      `${source} changed after the browser evidence was recorded`,
    );
  }
  for (const view of ["focus", "page"]) {
    for (const scope of ["sentence", "paragraph"]) {
      const visual = evidence.visuals[view][scope];
      assert.equal(
        sha256(await readFile(path.join(evidenceDirectory, visual.screenshot))),
        visual.screenshotSha256,
      );
    }
  }
});

test(
  "runs the highlight-scope regression in real Brave when explicitly enabled",
  {
    skip: process.env.LINELIGHT_RUN_HIGHLIGHT_SCOPE_BROWSER !== "1",
    timeout: 240_000,
  },
  async () => {
    const outputDirectory = await mkdtemp(
      path.join(os.tmpdir(), "linelight-highlight-scope-evidence-"),
    );
    try {
      await execFileAsync(
        process.execPath,
        [
          "scripts/run-highlight-scope-browser-regression.mjs",
          "--output",
          outputDirectory,
        ],
        { cwd: path.resolve("."), timeout: 230_000 },
      );
      const evidence = JSON.parse(
        await readFile(
          path.join(outputDirectory, "highlight-scope-browser.json"),
          "utf8",
        ),
      );
      assert.equal(evidence.passed, true, evidence.failures?.join("\n"));
      assert.deepEqual(validateHighlightScopeEvidence(evidence), []);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  },
);
