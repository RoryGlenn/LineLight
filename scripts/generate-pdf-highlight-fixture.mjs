#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const DEFAULT_PDF_HIGHLIGHT_FIXTURE = path.join(
  REPOSITORY_ROOT,
  "tests/fixtures/pdf-highlights/issue-60-geometry.pdf",
);

export const PDF_HIGHLIGHT_FIXTURE_EXPECTATIONS = Object.freeze({
  pageCount: 6,
  reportedPassageWords: ["Tiarnán", "definition", "engineer", "attrition"],
  dehyphenatedWordFragments: ["extraordi", "nary"],
  multiFontWords: ["Serif", "sans", "monospace"],
  // PDF.js normalizes the single /fi glyph to the searchable text "fi".
  ligatureText: "fi",
  ligatureGlyph: "/fi",
  multiColumnWords: ["Left", "Right"],
  rotatedWords: ["Rotated", "words", "aligned"],
  farBoundaryWord: "Far",
});

function pdfStream(contents, extraDictionary = "") {
  const data = Buffer.isBuffer(contents)
    ? contents
    : Buffer.from(contents, "latin1");
  const opening = Buffer.from(
    `<< /Length ${data.byteLength}${extraDictionary ? ` ${extraDictionary}` : ""} >>\nstream\n`,
    "ascii",
  );
  return Buffer.concat([opening, data, Buffer.from("\nendstream", "ascii")]);
}

function pageObject(contentsObject) {
  return Buffer.from(
    [
      "<< /Type /Page /Parent 2 0 R",
      "/MediaBox [0 0 612 792]",
      "/Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R /F4 7 0 R >> >>",
      `/Contents ${contentsObject} 0 R >>`,
    ].join(" "),
    "ascii",
  );
}

/**
 * Generate a deterministic, dependency-free PDF whose text operators exercise
 * the geometry that LineLight measures in a real PDF.js TextLayer.
 */
export function generatePdfHighlightFixture() {
  const objects = new Map();

  objects.set(
    1,
    Buffer.from(
      "<< /Type /Catalog /Pages 2 0 R /PageMode /UseNone >>",
      "ascii",
    ),
  );
  objects.set(
    2,
    Buffer.from(
      "<< /Type /Pages /Kids [9 0 R 11 0 R 13 0 R 15 0 R 17 0 R 19 0 R] /Count 6 >>",
      "ascii",
    ),
  );
  objects.set(
    3,
    Buffer.from(
      "<< /Title (LineLight issue 60 PDF highlight geometry) /Producer (LineLight deterministic fixture generator) >>",
      "ascii",
    ),
  );
  objects.set(
    4,
    Buffer.from(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      "ascii",
    ),
  );
  objects.set(
    5,
    Buffer.from(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>",
      "ascii",
    ),
  );
  objects.set(
    6,
    Buffer.from(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
      "ascii",
    ),
  );
  objects.set(
    7,
    Buffer.from(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /fi] >> /ToUnicode 8 0 R >>",
      "ascii",
    ),
  );
  objects.set(
    8,
    pdfStream(
      [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /LineLight-fi def",
        "/CMapType 2 def",
        "1 begincodespacerange",
        "<00> <FF>",
        "endcodespacerange",
        "1 beginbfchar",
        "<01> <FB01>",
        "endbfchar",
        "endcmap",
        "CMapName currentdict /CMap defineresource pop",
        "end",
        "end",
      ].join("\n"),
    ),
  );

  objects.set(9, pageObject(10));
  objects.set(
    10,
    pdfStream(
      Buffer.from(
        [
          "BT /F2 16 Tf 45 744 Td (Reported passage - continuous sentence bands) Tj ET",
          // WinAnsi 0xe1 is a-acute and 0x92 is the curly apostrophe.
          "BT /F1 11 Tf 45 704 Td (3  I like my friend Tiarn\xe1n de Burca\x92s definition of senior engineer: the level at which) Tj ET",
          "BT /F1 11 Tf 45 686 Td (someone can stop advancing and continue their current level of productivity, capability,) Tj ET",
          "BT /F1 11 Tf 45 668 Td (and of output for the rest of their career and still be \"regretted attrition\" if they leave.) Tj ET",
          "BT /F1 15 Tf 45 602 Td (An extraordi-) Tj ET",
          "BT /F1 15 Tf 45 580 Td (nary staff path stays one spoken word.) Tj ET",
        ].join("\n"),
        "latin1",
      ),
    ),
  );

  objects.set(11, pageObject(12));
  objects.set(
    12,
    pdfStream(
      [
        "BT /F2 18 Tf 54 744 Td (Multi-font and ligature geometry) Tj ET",
        "BT /F2 18 Tf 54 690 Td (Serif text,) Tj /F1 18 Tf ( sans text,) Tj /F3 16 Tf ( monospace text.) Tj ET",
        "BT /F2 22 Tf 54 630 Td (A true PDF ) Tj /F4 22 Tf <01> Tj /F2 22 Tf ( ligature keeps measured bounds.) Tj ET",
        "BT /F1 13 Tf 54 580 Td (Mixed metrics remain aligned when the active word changes.) Tj ET",
      ].join("\n"),
    ),
  );

  objects.set(13, pageObject(14));
  objects.set(
    14,
    pdfStream(
      [
        "BT /F2 18 Tf 54 744 Td (Rotated and multi-column geometry) Tj ET",
        "BT /F1 14 Tf 54 680 Td (Left column shares a visual row) Tj ET",
        "BT /F1 14 Tf 326 680 Td (Right column stays separate.) Tj ET",
        "BT /F2 13 Tf 54 640 Td (Column gaps must not become one highlight rectangle.) Tj ET",
        "q 0 1 -1 0 560 120 cm BT /F3 16 Tf 0 0 Td (Rotated words stay aligned.) Tj ET Q",
      ].join("\n"),
    ),
  );

  objects.set(15, pageObject(16));
  objects.set(
    16,
    pdfStream(
      [
        "BT /F2 18 Tf 54 744 Td (Virtualized boundary fixture - page four) Tj ET",
        "BT /F1 14 Tf 54 680 Td (Boundary page four keeps a stable shell.) Tj ET",
      ].join("\n"),
    ),
  );
  objects.set(17, pageObject(18));
  objects.set(
    18,
    pdfStream(
      [
        "BT /F2 18 Tf 54 744 Td (Virtualized boundary fixture - page five) Tj ET",
        "BT /F1 14 Tf 54 680 Td (Boundary page five keeps a stable shell.) Tj ET",
      ].join("\n"),
    ),
  );
  objects.set(19, pageObject(20));
  objects.set(
    20,
    pdfStream(
      [
        "BT /F2 18 Tf 54 744 Td (Virtualized boundary fixture - page six) Tj ET",
        "BT /F1 14 Tf 54 680 Td (Far boundary target verifies localized shell reconciliation.) Tj ET",
      ].join("\n"),
    ),
  );

  const header = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const chunks = [header];
  const offsets = [0];
  let offset = header.byteLength;
  const objectCount = Math.max(...objects.keys());

  for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
    const body = objects.get(objectNumber);
    if (!body) throw new Error(`Missing PDF object ${objectNumber}.`);
    offsets[objectNumber] = offset;
    const object = Buffer.concat([
      Buffer.from(`${objectNumber} 0 obj\n`, "ascii"),
      body,
      Buffer.from("\nendobj\n", "ascii"),
    ]);
    chunks.push(object);
    offset += object.byteLength;
  }

  const xrefOffset = offset;
  const xref = [
    "xref",
    `0 ${objectCount + 1}`,
    "0000000000 65535 f",
    ...offsets.slice(1).map((value) =>
      `${String(value).padStart(10, "0")} 00000 n`,
    ),
    "trailer",
    `<< /Size ${objectCount + 1} /Root 1 0 R /Info 3 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\r\n");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

export async function writePdfHighlightFixture(outputPath) {
  const resolvedPath = path.resolve(outputPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  const pdf = generatePdfHighlightFixture();
  await writeFile(resolvedPath, pdf);
  return { outputPath: resolvedPath, byteLength: pdf.byteLength };
}

async function main() {
  const outputPath = process.argv[2] ?? DEFAULT_PDF_HIGHLIGHT_FIXTURE;
  const result = await writePdfHighlightFixture(outputPath);
  process.stdout.write(
    `${JSON.stringify({ fixture: result.outputPath, bytes: result.byteLength })}\n`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
