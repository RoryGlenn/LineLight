import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPdfOutline,
  derivePdfPageWordStarts,
  findActivePdfOutlineItemId,
  findPdfOutlineAncestorIds,
  resolvePdfDestinationPageIndex,
} from "../app/pdf-outline.mjs";

function pdfDocument(destinations = {}) {
  return {
    async getDestination(name) {
      if (name === "throws") throw new Error("malformed destination");
      return destinations[name] ?? null;
    },
    async getPageIndex(reference) {
      if (reference.num === 999) throw new Error("missing page reference");
      return reference.num - 10;
    },
  };
}

test("resolves named, referenced, and direct PDF destinations", async () => {
  const pdf = pdfDocument({ chapter: [{ num: 12, gen: 0 }, "XYZ", 0, 0] });

  assert.equal(await resolvePdfDestinationPageIndex(pdf, "chapter"), 2);
  assert.equal(
    await resolvePdfDestinationPageIndex(pdf, [
      { num: 11, gen: 0 },
      "Fit",
    ]),
    1,
  );
  assert.equal(
    await resolvePdfDestinationPageIndex(pdf, [3, "XYZ", 0, 0]),
    3,
  );
  assert.equal(await resolvePdfDestinationPageIndex(pdf, "missing"), null);
  assert.equal(await resolvePdfDestinationPageIndex(pdf, "throws"), null);
  assert.equal(await resolvePdfDestinationPageIndex(pdf, ["bad"]), null);
});

test("recovers word starts for previously stored PDFs with empty pages", () => {
  assert.deepEqual(
    derivePdfPageWordStarts([
      { items: [] },
      { items: [{ wordStart: 0, wordCount: 4 }] },
      { items: [] },
      {
        items: [
          { wordStart: 4, wordCount: 3 },
          { wordStart: 7, wordCount: 2 },
        ],
      },
    ]),
    [0, 0, 4, 4],
  );
});

test("builds a serializable nested outline and ignores unsafe leaf links", async () => {
  const pdf = pdfDocument({ chapterOne: [{ num: 11, gen: 0 }, "Fit"] });
  const outline = await buildPdfOutline(
    [
      { title: " Cover ", dest: [0, "Fit"], items: [] },
      {
        title: "PART I",
        dest: null,
        items: [
          { title: "Chapter   One", dest: "chapterOne", items: [] },
          {
            title: "Publisher website",
            dest: null,
            url: "https://example.com",
            items: [],
          },
        ],
      },
      { title: "Broken", dest: [{ num: 999, gen: 0 }], items: [] },
      {
        title: "",
        dest: null,
        items: [{ title: "Appendix", dest: [3, "Fit"], items: [] }],
      },
    ],
    pdf,
    [0, 5, 11, 18],
    24,
  );

  assert.deepEqual(outline, [
    {
      id: "pdf-outline-0",
      title: "Cover",
      pageNumber: 1,
      tokenIndex: 0,
      items: [],
    },
    {
      id: "pdf-outline-1",
      title: "PART I",
      pageNumber: null,
      tokenIndex: null,
      items: [
        {
          id: "pdf-outline-1-0",
          title: "Chapter One",
          pageNumber: 2,
          tokenIndex: 5,
          items: [],
        },
      ],
    },
    {
      id: "pdf-outline-3-0",
      title: "Appendix",
      pageNumber: 4,
      tokenIndex: 18,
      items: [],
    },
  ]);
});

test("identifies the active section and its collapsible parents", () => {
  const outline = [
    {
      id: "cover",
      title: "Cover",
      tokenIndex: 0,
      items: [],
    },
    {
      id: "part-one",
      title: "Part I",
      tokenIndex: 5,
      items: [
        {
          id: "chapter-one",
          title: "Chapter 1",
          tokenIndex: 5,
          items: [],
        },
        {
          id: "chapter-two",
          title: "Chapter 2",
          tokenIndex: 20,
          items: [],
        },
      ],
    },
  ];

  assert.equal(findActivePdfOutlineItemId(outline, 4), "cover");
  assert.equal(findActivePdfOutlineItemId(outline, 5), "chapter-one");
  assert.equal(findActivePdfOutlineItemId(outline, 24), "chapter-two");
  assert.deepEqual(
    findPdfOutlineAncestorIds(outline, "chapter-two"),
    ["part-one"],
  );
  assert.deepEqual(findPdfOutlineAncestorIds(outline, "missing"), []);
});

test("returns an empty outline when the PDF has no embedded contents", async () => {
  assert.deepEqual(await buildPdfOutline(null, pdfDocument(), [0], 10), []);
  assert.deepEqual(await buildPdfOutline([], pdfDocument(), [0], 10), []);
  assert.equal(findActivePdfOutlineItemId([], 0), null);
});
