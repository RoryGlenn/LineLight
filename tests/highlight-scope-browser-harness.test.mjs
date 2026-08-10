import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  captureWhenVisualStateStable,
  validateHighlightScopeEvidence,
  visualStateFingerprintExpression,
  waitForVisualStateStable,
} from "../scripts/run-highlight-scope-browser-regression.mjs";

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

test("visual fingerprints cover every source of screenshot movement without reader text", () => {
  const expression = visualStateFingerprintExpression(
    ".pdf-sentence-overlay.scope-active",
  );
  for (const expected of [
    ".reader-scroll",
    "scrollTop",
    "scrollHeight",
    "clientHeight",
    "[data-active-token=\"true\"]",
    ".pdf-sentence-overlay.scope-active",
    "getClientRects",
    "document.fonts?.status",
    ".pdf-page-loading",
    ".position-action-stack",
  ]) {
    assert.match(
      expression,
      new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"),
    );
  }
  assert.doesNotMatch(expression, /(?:innerText|outerHTML|textContent)/u);
});

test("waits for four ready, identical visual fingerprints", async () => {
  const fingerprint = (scrollTop, ready = true) =>
    JSON.stringify({ ready, reader: { scrollTop } });
  const responses = [
    fingerprint(0, false),
    fingerprint(10),
    fingerprint(20),
    fingerprint(20),
    fingerprint(20),
    fingerprint(20),
  ];
  let calls = 0;
  const cdp = {
    async send(method) {
      assert.equal(method, "Runtime.evaluate");
      const value = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      return { result: { value } };
    },
  };
  const result = await waitForVisualStateStable(cdp, ".scope-active", {
    sampleDelayMs: 0,
    stableSamples: 4,
    timeoutMs: 1_000,
  });
  assert.equal(result, fingerprint(20));
  assert.equal(calls, 6);
});

test("retries a capture whose post-collect fingerprint changed", async () => {
  const events = [];
  const before = ["first-stable", "second-stable"];
  const after = ["moved", "second-stable"];
  const result = await captureWhenVisualStateStable({
    maxAttempts: 2,
    waitForStable: async () => {
      events.push("wait");
      return before.shift();
    },
    collect: async () => {
      events.push("collect");
      return { attempt: events.filter((event) => event === "collect").length };
    },
    capture: async () => {
      events.push("capture");
    },
    fingerprint: async () => {
      events.push("fingerprint");
      return after.shift();
    },
    discard: async () => {
      events.push("discard");
    },
  });
  assert.deepEqual(result, { attempt: 2 });
  assert.deepEqual(events, [
    "wait",
    "collect",
    "capture",
    "fingerprint",
    "discard",
    "wait",
    "collect",
    "capture",
    "fingerprint",
  ]);
});

test("discards every unstable capture and fails after the bounded attempts", async () => {
  let captures = 0;
  let discards = 0;
  await assert.rejects(
    captureWhenVisualStateStable({
      maxAttempts: 3,
      waitForStable: async () => "before",
      collect: async () => ({ ignored: true }),
      capture: async () => {
        captures += 1;
      },
      fingerprint: async () => "after",
      discard: async () => {
        discards += 1;
      },
    }),
    /changed while its screenshot was captured/iu,
  );
  assert.equal(captures, 3);
  assert.equal(discards, 3);
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
