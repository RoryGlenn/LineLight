import assert from "node:assert/strict";
import test from "node:test";

import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";

import {
  parseEpubFile,
  resolveEpubPath,
} from "../app/epub-parser.mjs";

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`;

async function createEpub({
  name = "book.epub",
  container = CONTAINER,
  packagePath = "OPS/package.opf",
  packageDocument,
  chapters = {},
}) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  if (container !== null) zip.file("META-INF/container.xml", container);
  if (packageDocument) zip.file(packagePath, packageDocument);
  for (const [path, source] of Object.entries(chapters)) {
    zip.file(path, source);
  }
  const bytes = await zip.generateAsync({
    type: "uint8array",
    mimeType: "application/epub+zip",
  });
  return new File([bytes], name, { type: "application/epub+zip" });
}

function parse(file) {
  return parseEpubFile(file, {
    DOMParser,
    createId: () => "fixed-id",
  });
}

test("resolves encoded, relative EPUB manifest paths", () => {
  assert.equal(
    resolveEpubPath("OPS/package", "../Text/chapter%201.xhtml#opening"),
    "OPS/Text/chapter 1.xhtml",
  );
  assert.equal(
    resolveEpubPath("", "OPS/content.opf?cache=ignored"),
    "OPS/content.opf",
  );
  assert.equal(
    resolveEpubPath("OPS", "Text/a%broken.xhtml"),
    "OPS/Text/a%broken.xhtml",
  );
});

test("imports EPUB 3 metadata and readable spine content in book order", async () => {
  const packageDocument = `<?xml version="1.0" encoding="UTF-8"?>
  <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>  The   Test Book  </dc:title>
      <dc:creator>Casey Reader</dc:creator>
    </metadata>
    <manifest>
      <item id="chapter-one" href="Text/chapter%201.xhtml#opening" media-type="application/xhtml+xml" />
      <item id="chapter-two" href="Text/chapter2.xhtml" media-type="application/xhtml+xml" />
      <item id="unused" href="Text/unused.xhtml" media-type="application/xhtml+xml" />
    </manifest>
    <spine>
      <itemref idref="chapter-one" />
      <itemref idref="chapter-two" />
    </spine>
  </package>`;
  const file = await createEpub({
    packageDocument,
    chapters: {
      "OPS/Text/chapter 1.xhtml": `<?xml version="1.0" encoding="UTF-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml">
        <head><title>Hidden browser title</title><style>p { color: red; }</style></head>
        <body>
          <nav><p>Table of contents must not become reading text.</p></nav>
          <h1 id="opening">Chapter One</h1>
          <p>Hello <em>curious</em> reader.</p>
          <blockquote><p>Nested quotation.</p></blockquote>
          <ol><li><p>First list item.</p></li></ol>
          <script>Hidden script text.</script>
        </body>
      </html>`,
      "OPS/Text/chapter2.xhtml": `<?xml version="1.0" encoding="UTF-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml">
        <body><section><div><span>A div-only chapter still imports.</span></div></section></body>
      </html>`,
      "OPS/Text/unused.xhtml":
        "<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>Not in the spine.</p></body></html>",
    },
  });

  assert.deepEqual(await parse(file), {
    id: "epub-fixed-id",
    title: "The Test Book",
    author: "Casey Reader",
    kind: "epub",
    paragraphs: [
      "Chapter One",
      "Hello curious reader.",
      "Nested quotation.",
      "First list item.",
      "A div-only chapter still imports.",
    ],
  });
});

test("imports namespace-prefixed EPUB 2 packages and uses safe metadata fallbacks", async () => {
  const container = `<?xml version="1.0"?>
  <ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container">
    <ocf:rootfiles>
      <ocf:rootfile full-path="missing.opf" media-type="text/plain" />
      <ocf:rootfile full-path="OPS/Package/content.opf" media-type="application/oebps-package+xml" />
    </ocf:rootfiles>
  </ocf:container>`;
  const packageDocument = `<?xml version="1.0"?>
  <opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="2.0">
    <opf:metadata />
    <opf:manifest>
      <opf:item id="only" href="../Text/only.xhtml" media-type="application/xhtml+xml" />
    </opf:manifest>
    <opf:spine><opf:itemref idref="only" /></opf:spine>
  </opf:package>`;
  const file = await createEpub({
    name: "Fallback Name.EPUB",
    container,
    packagePath: "OPS/Package/content.opf",
    packageDocument,
    chapters: {
      "OPS/Text/only.xhtml":
        "<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>Readable EPUB two content.</p></body></html>",
    },
  });

  assert.deepEqual(await parse(file), {
    id: "epub-fixed-id",
    title: "Fallback Name",
    author: "Unknown author",
    kind: "epub",
    paragraphs: ["Readable EPUB two content."],
  });
});

test("reports damaged EPUBs and missing reading orders clearly", async () => {
  const damaged = new File(["not a zip"], "damaged.epub", {
    type: "application/epub+zip",
  });
  await assert.rejects(
    parse(damaged),
    /damaged or is not a valid EPUB file/u,
  );

  const missingContainer = await createEpub({
    container: null,
    packageDocument: null,
  });
  await assert.rejects(parse(missingContainer), /missing its book manifest/u);

  const noSpine = await createEpub({
    packageDocument: `<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf">
        <metadata /><manifest /><spine />
      </package>`,
  });
  await assert.rejects(parse(noSpine), /readable book order/u);
});
