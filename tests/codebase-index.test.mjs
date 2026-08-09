import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = resolve(repositoryRoot, "docs/codebase-index.md");
const indexDirectory = dirname(indexPath);

const REQUIRED_DOMAIN_FIELDS = [
  "Purpose",
  "Runtime",
  "Owns",
  "Entry points",
  "Change together",
  "State and I/O",
  "Verification",
];

const FIRST_DOMAIN_TITLE = "Application shell and reader orchestration";
const EXCLUSIONS_TITLE = "Explicit exclusions";

const ROOT_CONFIG_PATTERN = /^(?:\.env\.example|\.npmrc|package\.json|tsconfig(?:\.[^/]+)?\.json|[^/]+\.config\.(?:[cm]?js|ts))$/;
const MARKDOWN_LINK_PATTERN = /(?<!!)\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\)/g;

async function loadIndex() {
  return readFile(indexPath, "utf8");
}

function parseH2Sections(source) {
  const headings = [...source.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)];

  return headings.map((heading, index) => ({
    title: heading[1],
    body: source.slice(
      heading.index + heading[0].length,
      headings[index + 1]?.index ?? source.length,
    ),
  }));
}

function extractMarkdownLinks(source) {
  return [...source.matchAll(MARKDOWN_LINK_PATTERN)].map((match) => ({
    target: match[1] ?? match[2],
    index: match.index,
    end: match.index + match[0].length,
  }));
}

function markdownHeadingAnchors(source) {
  const counts = new Map();
  const anchors = new Set();

  for (const match of source.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)) {
    const base = match[1]
      .toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }

  return anchors;
}

function resolveRelativeLink(target) {
  if (
    target.startsWith("/") ||
    target.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(target)
  ) {
    return null;
  }

  const hashIndex = target.indexOf("#");
  const pathAndQuery = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : target.slice(hashIndex + 1);
  const pathOnly = pathAndQuery.split("?", 1)[0];

  let decodedPath;
  let decodedFragment;
  try {
    decodedPath = decodeURIComponent(pathOnly || "codebase-index.md");
    decodedFragment = decodeURIComponent(fragment);
  } catch {
    assert.fail(`Invalid percent-encoding in Markdown link: ${target}`);
  }

  const absolutePath = resolve(indexDirectory, decodedPath);
  const repositoryPath = relative(repositoryRoot, absolutePath)
    .split(sep)
    .join("/");

  assert.ok(
    repositoryPath && repositoryPath !== ".." && !repositoryPath.startsWith("../"),
    `Relative Markdown link escapes the repository: ${target}`,
  );

  return { absolutePath, repositoryPath, fragment: decodedFragment };
}

function isScopedFirstPartyPath(path) {
  return (
    ["app/", "worker/", "db/", "build/", "scripts/"].some((prefix) =>
      path.startsWith(prefix),
    ) ||
    /^tests\/[^/]+\.test\.mjs$/.test(path) ||
    path.startsWith(".github/workflows/") ||
    path === ".openai/hosting.json" ||
    ROOT_CONFIG_PATTERN.test(path) ||
    /^public\/sw-[^/]+\.js$/.test(path) ||
    path === "public/_headers" ||
    /^public\/[^/]+\.webmanifest$/.test(path)
  );
}

async function trackedFirstPartyPaths() {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  return stdout
    .split("\0")
    .filter(Boolean)
    .filter(isScopedFirstPartyPath)
    .sort();
}

test("codebase index domains provide every required field", async () => {
  const sections = parseH2Sections(await loadIndex());
  const firstDomainIndex = sections.findIndex(
    ({ title }) => title === FIRST_DOMAIN_TITLE,
  );
  const exclusionsIndex = sections.findIndex(({ title }) => title === EXCLUSIONS_TITLE);

  assert.notEqual(
    firstDomainIndex,
    -1,
    `docs/codebase-index.md must define an '## ${FIRST_DOMAIN_TITLE}' domain`,
  );
  assert.notEqual(
    exclusionsIndex,
    -1,
    `docs/codebase-index.md must end with an '## ${EXCLUSIONS_TITLE}' section`,
  );
  assert.equal(
    exclusionsIndex,
    sections.length - 1,
    `'## ${EXCLUSIONS_TITLE}' must be the final H2 section`,
  );
  assert.ok(
    exclusionsIndex > firstDomainIndex,
    `'## ${EXCLUSIONS_TITLE}' must follow the semantic domains`,
  );

  const domains = sections.slice(firstDomainIndex, exclusionsIndex);
  assert.ok(domains.length > 0, "The codebase index must define at least one domain");

  for (const domain of domains) {
    const fields = [
      ...domain.body.matchAll(/^\*\*([^*\n]+?):\*\*(.*)$/gm),
    ];

    for (const requiredField of REQUIRED_DOMAIN_FIELDS) {
      const matches = fields.filter((field) => field[1] === requiredField);
      assert.equal(
        matches.length,
        1,
        `Domain '${domain.title}' must contain exactly one '**${requiredField}:**' field`,
      );

      const field = matches[0];
      const fieldPosition = fields.indexOf(field);
      const nextField = fields[fieldPosition + 1];
      const continuation = domain.body.slice(
        field.index + field[0].length,
        nextField?.index ?? domain.body.length,
      );
      assert.ok(
        `${field[2]}${continuation}`.trim(),
        `Domain '${domain.title}' has an empty '${requiredField}' field`,
      );
    }
  }
});

test("codebase index relative Markdown links resolve", async () => {
  const links = extractMarkdownLinks(await loadIndex());
  const relativeLinks = links
    .map(({ target }) => ({ target, resolved: resolveRelativeLink(target) }))
    .filter(({ resolved }) => resolved !== null);

  assert.ok(relativeLinks.length > 0, "The codebase index must contain relative links");

  const brokenLinks = [];
  const headingCache = new Map();
  await Promise.all(
    relativeLinks.map(async ({ target, resolved }) => {
      try {
        await stat(resolved.absolutePath);
      } catch {
        brokenLinks.push(`${target} -> ${resolved.repositoryPath}`);
        return;
      }

      if (resolved.fragment) {
        let anchors = headingCache.get(resolved.absolutePath);
        if (!anchors) {
          const linkedSource = await readFile(resolved.absolutePath, "utf8");
          anchors = markdownHeadingAnchors(linkedSource);
          headingCache.set(resolved.absolutePath, anchors);
        }
        if (!anchors.has(resolved.fragment)) {
          brokenLinks.push(
            `${target} -> ${resolved.repositoryPath} has no '#${resolved.fragment}' heading`,
          );
        }
      }
    }),
  );

  assert.deepEqual(
    brokenLinks.sort(),
    [],
    `Broken relative links in docs/codebase-index.md:\n${brokenLinks
      .sort()
      .map((link) => `  - ${link}`)
      .join("\n")}`,
  );
});

test("tracked first-party files are indexed or explicitly excluded with reasons", async () => {
  const source = await loadIndex();
  const sections = parseH2Sections(source);
  const firstDomainIndex = sections.findIndex(
    ({ title }) => title === FIRST_DOMAIN_TITLE,
  );
  const exclusionsIndex = sections.findIndex(
    ({ title }) => title === EXCLUSIONS_TITLE,
  );
  const exclusions = sections.find(
    ({ title }) => title === EXCLUSIONS_TITLE,
  );
  assert.ok(exclusions, "The codebase index must define explicit exclusions");

  const exclusionBullets = exclusions.body
    .split("\n")
    .filter((line) => /^-\s+/.test(line));
  assert.ok(
    exclusionBullets.length > 0,
    "Explicit exclusions must list linked paths and plain-language reasons",
  );

  const excludedPaths = new Set();
  for (const bullet of exclusionBullets) {
    const links = extractMarkdownLinks(bullet);
    assert.ok(
      links.length > 0,
      `Every explicit exclusion must link its excluded path: ${bullet}`,
    );

    const lastLink = links.at(-1);
    const reason = bullet
      .slice(lastLink.end)
      .replace(/^[\s:;,.\-\u2013\u2014]+/u, "")
      .trim();
    assert.match(
      reason,
      /[A-Za-z]{3}/,
      `Every explicit exclusion needs a plain-language reason after its link: ${bullet}`,
    );

    for (const { target } of links) {
      const resolved = resolveRelativeLink(target);
      assert.ok(
        resolved,
        `Explicit exclusions must use repository-relative links: ${target}`,
      );
      excludedPaths.add(resolved.repositoryPath);
    }
  }

  const domainSource = sections
    .slice(firstDomainIndex, exclusionsIndex)
    .map(({ body }) => body)
    .join("\n");
  const indexedPaths = new Set(
    extractMarkdownLinks(domainSource)
      .map(({ target }) => resolveRelativeLink(target)?.repositoryPath)
      .filter(Boolean),
  );
  const trackedPaths = await trackedFirstPartyPaths();
  const missingPaths = trackedPaths.filter(
    (path) => !indexedPaths.has(path) && !excludedPaths.has(path),
  );

  assert.deepEqual(
    missingPaths,
    [],
    `Tracked first-party files missing from docs/codebase-index.md:\n${missingPaths
      .map(
        (path) =>
          `  - ${path} (add a relative Markdown link, or link it under Explicit exclusions with a reason)`,
      )
      .join("\n")}`,
  );
});
