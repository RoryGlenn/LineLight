import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  DEFAULT_PDF_HIGHLIGHT_FIXTURE,
  generatePdfHighlightFixture,
} from "../scripts/generate-pdf-highlight-fixture.mjs";
import { validatePdfHighlightEvidence } from "../scripts/run-pdf-highlight-browser-regression.mjs";

const execFileAsync = promisify(execFile);

test("keeps the checked PDF highlight fixture deterministic", async () => {
  const checkedFixture = await readFile(DEFAULT_PDF_HIGHLIGHT_FIXTURE);
  assert.deepEqual(checkedFixture, generatePdfHighlightFixture());
  assert.match(checkedFixture.toString("latin1"), /\/Differences \[1 \/fi\]/u);
});

test("generates reported, multi-font, ligature, column, and rotated PDF content", async () => {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(generatePdfHighlightFixture()),
    useSystemFonts: true,
  }).promise;
  assert.equal(pdf.numPages, 6);

  const page1 = await (await pdf.getPage(1)).getTextContent();
  const page1Text = page1.items
    .filter((item) => "str" in item)
    .map((item) => item.str)
    .join(" ");
  assert.match(page1Text, /Tiarnán de Burca’s definition of senior engineer/u);
  assert.match(page1Text, /extraordi-\s+nary/u);

  const page2 = await (await pdf.getPage(2)).getTextContent();
  const page2Items = page2.items.filter((item) => "str" in item);
  const fixtureFonts = ["Serif text,", "sans text,", "monospace"].map(
    (text) => page2Items.find((item) => item.str === text)?.fontName,
  );
  assert.equal(new Set(fixtureFonts).size, 3);
  const ligature = page2Items.find((item) => item.str === "fi");
  assert.ok(ligature, "the single PDF /fi glyph should normalize to searchable fi");
  assert.ok(ligature.width > 0);

  const page3 = await (await pdf.getPage(3)).getTextContent();
  const page3Items = page3.items.filter((item) => "str" in item);
  const left = page3Items.find((item) => item.str.startsWith("Left column"));
  const right = page3Items.find((item) => item.str.startsWith("Right column"));
  assert.ok(left && right);
  assert.equal(left.hasEOL, false);
  assert.equal(right.hasEOL, false);
  assert.ok(right.transform[4] - (left.transform[4] + left.width) > 70);
  const rotated = page3Items.find((item) => item.str === "Rotated");
  assert.ok(rotated);
  assert.deepEqual(rotated.transform.slice(0, 4), [0, 16, -16, 0]);
  await pdf.destroy();
});

test("validates persisted browser evidence against the issue thresholds", () => {
  const geometry = ["a", "b", "c"].map((id) => ({
    id,
    maximumEdgeErrorCssPx: 1.25,
    failures: [],
  }));
  const evidence = {
    schemaVersion: 1,
    issue: 60,
    source: { commit: "test" },
    fixture: { sha256: "test" },
    geometry,
    scenarios: {
      reportedPassage: {
        continuous: true,
        punctuationRightEdgeErrorCssPx: 0.5,
      },
      dehyphenation: {
        sameLogicalWord: true,
        bothFragmentsActive: true,
      },
      fontsAndLigature: { passed: true },
      rotatedAndColumns: {
        rotated: { vertical: true },
        columns: { separated: true },
      },
      legacyMigration: { passed: true },
    },
    interactions: {
      samePage: {
        shellIdentityPreserved: true,
        mapRenderCountBefore: 2,
        mapRenderCountAfter: 2,
        changedShellRenderCounts: [],
        mutations: { childList: 0 },
        longTasks: [],
      },
      pageBoundary: {
        shellIdentityPreserved: true,
        mapRenderCountBefore: 2,
        mapRenderCountAfter: 2,
        mutations: { directChildList: 0 },
        longTasks: [],
      },
    },
  };
  assert.deepEqual(validatePdfHighlightEvidence(evidence), []);

  geometry[1].maximumEdgeErrorCssPx = 2.01;
  assert.match(
    validatePdfHighlightEvidence(evidence).join("\n"),
    /exceeded 2px/u,
  );
});

test(
  "runs the PDF highlight regression in a real browser when explicitly enabled",
  { skip: process.env.LINELIGHT_RUN_PDF_BROWSER !== "1", timeout: 180_000 },
  async () => {
    const outputDirectory = await mkdtemp(
      path.join(os.tmpdir(), "linelight-pdf-highlight-evidence-"),
    );
    try {
      await execFileAsync(
        process.execPath,
        [
          "scripts/run-pdf-highlight-browser-regression.mjs",
          "--output",
          outputDirectory,
        ],
        { cwd: path.resolve("."), timeout: 170_000 },
      );
      const evidence = JSON.parse(
        await readFile(
          path.join(outputDirectory, "pdf-highlight-browser.json"),
          "utf8",
        ),
      );
      assert.equal(evidence.passed, true, evidence.failures?.join("\n"));
      assert.deepEqual(validatePdfHighlightEvidence(evidence), []);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  },
);
