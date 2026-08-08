import JSZip from "jszip";

const EPUB_CONTAINER_PATH = "META-INF/container.xml";
const EPUB_PACKAGE_MEDIA_TYPE = "application/oebps-package+xml";
const EPUB_BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dt",
  "figcaption",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "p",
  "pre",
  "section",
]);
const EPUB_PREFERRED_TEXT_ELEMENTS = new Set([
  "blockquote",
  "dd",
  "dt",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "pre",
]);
const EPUB_IGNORED_ELEMENTS = new Set([
  "audio",
  "canvas",
  "head",
  "nav",
  "noscript",
  "script",
  "style",
  "svg",
  "template",
  "video",
]);

function cleanText(value) {
  return String(value ?? "")
    .replace(/\u00ad/gu, "")
    .replace(/[\s\u00a0]+/gu, " ")
    .trim();
}

function filenameWithoutExtension(name) {
  return name.replace(/\.[^.]+$/u, "");
}

function elementName(node) {
  if (!node || node.nodeType !== 1) return "";
  const name = node.localName || node.nodeName || "";
  return name.toLocaleLowerCase().replace(/^.*:/u, "");
}

function allElements(root) {
  return Array.from(root?.getElementsByTagName?.("*") ?? []);
}

function elementsNamed(root, name) {
  const normalizedName = name.toLocaleLowerCase();
  return allElements(root).filter(
    (element) => elementName(element) === normalizedName,
  );
}

function firstElementNamed(root, name) {
  return elementsNamed(root, name)[0] ?? null;
}

function isParserError(document) {
  return elementsNamed(document, "parsererror").length > 0;
}

function parseXml(parser, source, label) {
  const document = parser.parseFromString(source, "application/xml");
  if (!document?.documentElement || isParserError(document)) {
    throw new Error(`${label} contains invalid XML.`);
  }
  return document;
}

function parseChapter(parser, source) {
  const xhtml = parser.parseFromString(source, "application/xhtml+xml");
  if (xhtml?.documentElement && !isParserError(xhtml)) return xhtml;

  const html = parser.parseFromString(source, "text/html");
  return html?.documentElement ? html : null;
}

function safeDecodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolve an EPUB URI reference to its corresponding ZIP entry.
 *
 * @param {string} basePath Directory containing the package document.
 * @param {string} target URI reference from the EPUB manifest.
 * @returns {string}
 */
export function resolveEpubPath(basePath, target) {
  const pathWithoutSuffix = String(target).split(/[?#]/u, 1)[0];
  const normalizedTarget = safeDecodePath(pathWithoutSuffix).replace(
    /\\/gu,
    "/",
  );
  const parts = `${basePath}/${normalizedTarget}`.split("/");
  const resolved = [];

  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }

  return resolved.join("/");
}

function directChildElements(element) {
  return Array.from(element?.childNodes ?? []).filter(
    (child) => child.nodeType === 1,
  );
}

function manifestItems(packageDocument) {
  const manifest = firstElementNamed(packageDocument, "manifest");
  if (!manifest) return [];
  return directChildElements(manifest).filter(
    (element) => elementName(element) === "item",
  );
}

function spineItems(packageDocument) {
  const spine = firstElementNamed(packageDocument, "spine");
  if (!spine) return [];
  return directChildElements(spine).filter(
    (element) => elementName(element) === "itemref",
  );
}

function removeIgnoredContent(document) {
  for (const element of allElements(document)) {
    if (!EPUB_IGNORED_ELEMENTS.has(elementName(element))) continue;
    element.parentNode?.removeChild(element);
  }
}

function hasPreferredAncestor(element, boundary) {
  let ancestor = element.parentNode;
  while (ancestor && ancestor !== boundary) {
    if (EPUB_PREFERRED_TEXT_ELEMENTS.has(elementName(ancestor))) return true;
    ancestor = ancestor.parentNode;
  }
  return false;
}

function nodeText(node) {
  if (!node) return "";
  if (node.nodeType === 3 || node.nodeType === 4) {
    return node.nodeValue ?? "";
  }
  if (node.nodeType !== 1 && node.nodeType !== 9) return "";

  const name = elementName(node);
  if (EPUB_IGNORED_ELEMENTS.has(name)) return "";
  if (name === "br") return "\n";
  if (name === "img") return node.getAttribute?.("alt") ?? "";

  const pieces = [];
  for (const child of Array.from(node.childNodes ?? [])) {
    const childName = elementName(child);
    const isBlock = EPUB_BLOCK_ELEMENTS.has(childName);
    if (isBlock) pieces.push("\n");
    pieces.push(nodeText(child));
    if (isBlock) pieces.push("\n");
  }
  return pieces.join("");
}

/**
 * Extract readable blocks from a spine document without duplicating nested
 * list items or paragraphs.
 *
 * @param {Document} document Parsed XHTML or HTML document.
 * @returns {string[]}
 */
export function extractEpubParagraphs(document) {
  if (!document?.documentElement) return [];
  removeIgnoredContent(document);

  const body = firstElementNamed(document, "body") ?? document.documentElement;
  const preferredBlocks = allElements(body).filter(
    (element) =>
      EPUB_PREFERRED_TEXT_ELEMENTS.has(elementName(element)) &&
      !hasPreferredAncestor(element, body),
  );
  const paragraphs = preferredBlocks.flatMap((element) =>
    nodeText(element)
      .split(/\n+/u)
      .map(cleanText)
      .filter(Boolean),
  );
  if (paragraphs.length) return paragraphs;

  const fallbackText = nodeText(body);
  return fallbackText
    .split(/\n+/u)
    .map(cleanText)
    .filter(Boolean);
}

function metadataValue(packageDocument, name) {
  const metadata = firstElementNamed(packageDocument, "metadata");
  const value = firstElementNamed(metadata ?? packageDocument, name);
  return cleanText(value?.textContent ?? "");
}

function createDocumentId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
}

/**
 * Parse an EPUB entirely in memory. Imported book contents never leave the
 * browser.
 *
 * @param {{ name: string, arrayBuffer: () => Promise<ArrayBuffer> }} file
 * @param {{ DOMParser?: typeof globalThis.DOMParser, createId?: () => string }} [options]
 * @returns {Promise<{
 *   id: string,
 *   title: string,
 *   author: string,
 *   kind: "epub",
 *   paragraphs: string[],
 * }>}
 */
export async function parseEpubFile(file, options = {}) {
  const Parser = options.DOMParser ?? globalThis.DOMParser;
  if (typeof Parser !== "function") {
    throw new Error("This browser cannot read EPUB files.");
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error("This EPUB is damaged or is not a valid EPUB file.");
  }

  const containerText = await zip
    .file(EPUB_CONTAINER_PATH)
    ?.async("string");
  if (!containerText) {
    throw new Error("This EPUB is missing its book manifest.");
  }

  const parser = new Parser();
  const containerDocument = parseXml(
    parser,
    containerText,
    "This EPUB's container",
  );
  const rootfiles = elementsNamed(containerDocument, "rootfile");
  const rootfile =
    rootfiles.find(
      (element) =>
        element.getAttribute("media-type") === EPUB_PACKAGE_MEDIA_TYPE,
    ) ?? rootfiles[0];
  const rootfilePath = rootfile?.getAttribute("full-path")?.trim();
  if (!rootfilePath) {
    throw new Error("The EPUB reading order could not be found.");
  }

  const packagePath = resolveEpubPath("", rootfilePath);
  const packageText = await zip.file(packagePath)?.async("string");
  if (!packageText) {
    throw new Error("The EPUB package could not be opened.");
  }

  const packageDocument = parseXml(
    parser,
    packageText,
    "This EPUB's package",
  );
  const basePath = packagePath.includes("/")
    ? packagePath.slice(0, packagePath.lastIndexOf("/"))
    : "";
  const manifest = new Map();
  for (const item of manifestItems(packageDocument)) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest.set(id, resolveEpubPath(basePath, href));
  }

  const readingOrder = spineItems(packageDocument)
    .map((item) => item.getAttribute("idref"))
    .filter(Boolean);
  if (!readingOrder.length) {
    throw new Error("The EPUB does not include a readable book order.");
  }

  const paragraphs = [];
  for (const id of readingOrder) {
    const chapterPath = manifest.get(id);
    if (!chapterPath) continue;
    const chapterText = await zip.file(chapterPath)?.async("string");
    if (!chapterText) continue;
    const chapterDocument = parseChapter(parser, chapterText);
    if (!chapterDocument) continue;
    paragraphs.push(...extractEpubParagraphs(chapterDocument));
  }

  if (!paragraphs.length) {
    throw new Error("No readable text was found in this EPUB.");
  }

  const title =
    metadataValue(packageDocument, "title") ||
    filenameWithoutExtension(file.name) ||
    "Untitled EPUB";
  const author =
    metadataValue(packageDocument, "creator") || "Unknown author";
  const id = (options.createId ?? createDocumentId)();

  return {
    id: `epub-${id}`,
    title,
    author,
    kind: "epub",
    paragraphs,
  };
}
