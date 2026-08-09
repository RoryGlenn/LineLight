#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_SOURCE_COMMIT = "89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0";
const EXPECTED_PACKAGE_VERSION = "1.22.0-dev.20250409-89f8206ba4";
const EXPECTED_LOCAL_PACKAGE_SPEC =
  "file:vendor/onnxruntime-web/onnxruntime-web-1.22.0-dev.20250409-89f8206ba4.tgz";
const EXPECTED_PATCH_SHA256 =
  "4b368d00b9c4fc11cf5183caeed13d858e93b842cba26df27bde1b653d9372f2";
const EXPECTED_LICENSE_SHA256 =
  "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c";
const EXPECTED_NOTICES_SHA256 =
  "e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc";
const EXPECTED_MODIFICATION_NOTICE_SHA256 =
  "9c451ee63c6c8a7c95c6def90acb21f866a582a3c31814e244b036d2eeac9d85";
const EXPECTED_VCPKG_TOOL_COMMIT = "b02e341c927f16d991edbd915d8ea43eac52096c";
const EXPECTED_VCPKG_REGISTRY_BASELINE =
  "a29711cc86340a43c054cd37b8bd2871332a01e9";
const EXPECTED_VCPKG_REGISTRY_HEAD = "ea1a7396b05637a53bf23c078647ecc0edee4b80";
const EXPECTED_VCPKG_MANIFEST_SHA256 =
  "a76794c3c836e1cbc9adb3307dc3f2af6d629815642832fcb56d3172690e2129";
const EXPECTED_VCPKG_CONFIGURATION_SHA256 =
  "11d905868d78604f6c4ed97718b7e229c8cc5e5ea78d566ce53e2748c5fe6f1f";
const EXPECTED_DIRECT_DEPENDENCIES = Object.freeze([
  "flatbuffers",
  "guid-typescript",
  "long",
  "onnxruntime-common",
  "platform",
  "protobufjs",
]);
const EXPECTED_PATCH_PATH_COUNT = 24;
const EXPECTED_POST_BUILD_MUTATIONS = Object.freeze({
  "js/common/lib/version.ts":
    "a97ea93643634915d26016eca4df1549bc1bc7d77e72ea710d6e31438dcbc9b2",
  "js/common/package-lock.json":
    "07716cb1620a7993c213d9ba84ede93b7b472cf4c60b3a94974ba37799df54eb",
  "js/common/package.json":
    "ef503ddd4abe1e980cce0f680c0b1d76ca800ae59eb6d8a8fee446c8443e2f14",
  "js/web/lib/version.ts":
    "a97ea93643634915d26016eca4df1549bc1bc7d77e72ea710d6e31438dcbc9b2",
  "js/web/package-lock.json":
    "e54d6422bf451a9173d4d8b4ae1fe827d9bbe290fdbb2346a1a344914930c627",
  "js/web/package.json":
    "02f25f8c2c4f090efee69090b9264776f5593123ae2172b862fe9b942bbddeac",
});
const EXPECTED_SOURCE_LEGAL_FILES = Object.freeze({
  "js/web/LICENSE": EXPECTED_LICENSE_SHA256,
  "js/web/LINELIGHT-NOTICE.txt": EXPECTED_MODIFICATION_NOTICE_SHA256,
  "js/web/ThirdPartyNotices.txt": EXPECTED_NOTICES_SHA256,
});
const EXPECTED_RUNTIME_MEMBERS = Object.freeze({
  "ort-wasm-simd-threaded.wasm":
    "db1fa2012c98f8806f5641558635261a9b09aaff8827e01a38ffdcb4d73f7a22",
  "ort-wasm-simd-threaded.mjs":
    "87a120859ceba8870536ab6684a47b5cdb2515a33a0ab80c4520ec84fbe3df85",
  "ort-wasm-simd-threaded.jsep.wasm":
    "1e5a323ca41d859f324694c7b5ba2052bf8c1a96ff9721bc62e94f874d379fe1",
  "ort-wasm-simd-threaded.jsep.mjs":
    "c1458b19e63c7b104a38fc4dd44a0993b58c961a2c7884b347d2abce74556a22",
});
const BUILD_RELATIVE_PATHS = Object.freeze([
  "build/wasm_inferencing/Release",
  "build/wasm_inferencing_jsep/Release",
]);
const TRIPLET = "wasm32-emscripten";
const TOOL_NAME = "LineLight-onnxruntime-web-sbom-generator-1";

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      fail(
        "usage: generate-sbom.mjs --repository ROOT --source ORT_SOURCE " +
          "--patch PATCH --vcpkg-tool VCPKG --tarball PACKAGE.tgz " +
          "--created ISO_UTC --output FILE",
      );
    }
    const key = name.slice(2);
    if (values.has(key)) fail(`duplicate --${key}`);
    values.set(key, value);
  }

  const required = [
    "repository",
    "source",
    "patch",
    "vcpkg-tool",
    "tarball",
    "created",
    "output",
  ];
  for (const name of required) {
    if (!values.has(name)) fail(`missing --${name}`);
  }
  if (values.size !== required.length) fail("unexpected or duplicate argument");

  const created = values.get("created");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(created) ||
    Number.isNaN(Date.parse(created)) ||
    new Date(created).toISOString().replace(".000Z", "Z") !== created
  ) {
    fail(
      "--created must be an explicit UTC timestamp such as 2026-08-09T20:15:00Z",
    );
  }

  return Object.fromEntries(
    [...values].map(([name, value]) => [
      name,
      name === "created" ? value : resolve(value),
    ]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha512(value) {
  return createHash("sha512").update(value).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sortedRecord(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function assertSha256(path, expected) {
  const actual = sha256(readFileSync(path));
  if (actual !== expected) {
    fail(`${path} has SHA-256 ${actual}; expected ${expected}`);
  }
}

function assertSameBytes(leftPath, rightPath) {
  const left = readFileSync(leftPath);
  const right = readFileSync(rightPath);
  if (!left.equals(right)) fail(`${leftPath} and ${rightPath} differ`);
}

function exactPatchedPaths(source, patch) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "linelight-ort-postimage-"));
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: join(temporaryRoot, "index"),
  };

  try {
    execFileSync("git", ["-C", source, "read-tree", EXPECTED_SOURCE_COMMIT], {
      env: environment,
      stdio: "ignore",
    });
    execFileSync("git", ["-C", source, "apply", "--cached", "--check", patch], {
      env: environment,
      stdio: "ignore",
    });
    execFileSync("git", ["-C", source, "apply", "--cached", patch], {
      env: environment,
      stdio: "ignore",
    });
    const pathOutput = execFileSync(
      "git",
      [
        "-C",
        source,
        "diff",
        "--cached",
        "--name-only",
        "-z",
        EXPECTED_SOURCE_COMMIT,
        "--",
      ],
      { env: environment },
    );
    const paths = pathOutput.toString("utf8").split("\0").filter(Boolean);
    if (paths.length !== EXPECTED_PATCH_PATH_COUNT) {
      fail(
        `the exact patch changes ${paths.length} paths; expected ${EXPECTED_PATCH_PATH_COUNT}`,
      );
    }

    for (const path of paths) {
      const expected = execFileSync("git", ["-C", source, "show", `:${path}`], {
        env: environment,
        maxBuffer: 64 * 1024 * 1024,
      });
      const actual = readFileSync(join(source, path));
      if (!expected.equals(actual)) {
        fail(
          `${path} does not match its exact ${EXPECTED_SOURCE_COMMIT}+patch postimage`,
        );
      }
    }
    return paths;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot verify exact patched source postimages: ${detail}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertExpectedSourceChanges(source, patchedPaths) {
  for (const [path, expected] of Object.entries({
    ...EXPECTED_POST_BUILD_MUTATIONS,
    ...EXPECTED_SOURCE_LEGAL_FILES,
  })) {
    assertSha256(join(source, path), expected);
  }

  const status = execFileSync(
    "git",
    [
      "-C",
      source,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
    ],
    { encoding: "utf8" },
  );
  const changedPaths = status
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const code = entry.slice(0, 2);
      if (code.includes("R") || code.includes("C")) {
        fail(
          "renamed or copied source paths are not allowed in the build tree",
        );
      }
      return entry.slice(3);
    })
    .sort();
  const expectedPaths = [
    ...patchedPaths,
    ...Object.keys(EXPECTED_POST_BUILD_MUTATIONS),
    ...Object.keys(EXPECTED_SOURCE_LEGAL_FILES),
  ].sort();
  if (JSON.stringify(changedPaths) !== JSON.stringify(expectedPaths)) {
    fail(
      `unexpected build-tree changes: ${changedPaths.filter((path) => !expectedPaths.includes(path)).join(", ") || "expected paths are missing"}`,
    );
  }
}

function exactSubmoduleEvidence(source) {
  try {
    execFileSync(
      "git",
      [
        "-C",
        source,
        "diff",
        "--cached",
        "--quiet",
        EXPECTED_SOURCE_COMMIT,
        "--",
      ],
      { stdio: "ignore" },
    );
  } catch {
    fail(
      "the authoritative source index differs from the exact upstream commit",
    );
  }

  const lines = execFileSync(
    "git",
    ["-C", source, "submodule", "status", "--recursive"],
    { encoding: "utf8" },
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  if (lines.length === 0)
    fail("the authoritative source has no submodule evidence");

  return lines.map((line) => {
    const match = /^ ([0-9a-f]{40}) (.+?)(?: \([^\r\n]*\))?$/u.exec(line);
    if (!match) {
      fail(
        `submodule is uninitialized, conflicted, or not at its exact gitlink: ${line}`,
      );
    }
    const [, commit, path] = match;
    const status = execFileSync("git", [
      "-C",
      join(source, path),
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    if (status.length !== 0) fail(`submodule ${path} is not clean`);
    return { path, commit };
  });
}

function readTarMember(tarball, member) {
  try {
    return execFileSync("tar", ["-xOzf", tarball, member], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    fail(`cannot read ${member} from ${tarball}: ${error.message}`);
  }
}

function runtimeMemberEvidence(source, tarball) {
  return Object.entries(EXPECTED_RUNTIME_MEMBERS).map(([name, expected]) => {
    const sourceBytes = readFileSync(join(source, "js", "web", "dist", name));
    const packageBytes = readTarMember(tarball, `package/dist/${name}`);
    if (sha256(sourceBytes) !== expected || !sourceBytes.equals(packageBytes)) {
      fail(
        `${name} does not match the exact authoritative source output and npm package member`,
      );
    }
    return { name, sha256: expected, size: sourceBytes.length };
  });
}

function parseIntegrity(integrity, expectedAlgorithm = "sha512") {
  const match = new RegExp(
    `^${expectedAlgorithm}-([A-Za-z0-9+/=]+)$`,
    "u",
  ).exec(integrity ?? "");
  if (!match)
    fail(`expected ${expectedAlgorithm} package integrity, got ${integrity}`);
  return Buffer.from(match[1], "base64").toString("hex");
}

function tokenizeResponseFile(source) {
  const values = [];
  for (const match of source.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)) {
    values.push(match[1] ?? match[2] ?? match[3]);
  }
  return values;
}

function walkFiles(root, predicate, output = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, predicate, output);
    else if (entry.isFile() && predicate(path)) output.push(path);
  }
  return output;
}

function spdxId(kind, name, version) {
  const normalized = `${kind}-${name}-${version}`.replace(
    /[^A-Za-z0-9.-]/gu,
    "-",
  );
  return `SPDXRef-Package-${normalized}`;
}

function npmPurl(name, version) {
  const encodedName = name.startsWith("@")
    ? `%40${name.slice(1).replace("/", "%2F")}`
    : name;
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function packageFromLock(name, lock, parentPath) {
  const candidates = [
    `${parentPath}/node_modules/${name}`,
    `node_modules/${name}`,
  ];
  const path = candidates.find((candidate) => lock.packages?.[candidate]);
  if (!path)
    fail(`package-lock.json does not resolve direct dependency ${name}`);
  const value = lock.packages[path];
  if (!value.version || !value.resolved || !value.integrity || !value.license) {
    fail(`incomplete exact lock metadata for ${path}`);
  }
  return { name, path, ...value };
}

function directJavaScriptPackages(packageMetadata, lock) {
  const dependencyNames = Object.keys(
    packageMetadata.dependencies ?? {},
  ).sort();
  if (
    JSON.stringify(dependencyNames) !==
    JSON.stringify(EXPECTED_DIRECT_DEPENDENCIES)
  ) {
    fail(`unexpected direct dependencies: ${dependencyNames.join(", ")}`);
  }

  return dependencyNames.map((name) => {
    const locked = packageFromLock(name, lock, "node_modules/onnxruntime-web");
    const id = spdxId("npm", name, locked.version);
    return {
      id,
      package: {
        name,
        SPDXID: id,
        versionInfo: locked.version,
        downloadLocation: locked.resolved,
        filesAnalyzed: false,
        licenseConcluded: locked.license,
        licenseDeclared: locked.license,
        copyrightText: "NOASSERTION",
        checksums: [
          {
            algorithm: "SHA512",
            checksumValue: parseIntegrity(locked.integrity),
          },
        ],
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: npmPurl(name, locked.version),
          },
        ],
        comment: `Exact direct dependency resolved at ${locked.path} in LineLight's package-lock.json.`,
      },
    };
  });
}

function installedOwnership(buildRoot) {
  const installedRoot = join(buildRoot, "vcpkg_installed");
  const infoRoot = join(installedRoot, "vcpkg", "info");
  const shareRoot = join(installedRoot, TRIPLET, "share");
  const infoFiles = readdirSync(infoRoot);
  const owners = new Map();
  const metadata = new Map();

  for (const entry of readdirSync(shareRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const spdxPath = join(shareRoot, name, "vcpkg.spdx.json");
    if (!existsSync(spdxPath)) continue;
    const listFiles = infoFiles.filter(
      (file) =>
        file.startsWith(`${name}_`) && file.endsWith(`_${TRIPLET}.list`),
    );
    if (listFiles.length !== 1) {
      fail(
        `expected one ${TRIPLET} ownership list for ${name}, found ${listFiles.length}`,
      );
    }
    for (const path of readFileSync(join(infoRoot, listFiles[0]), "utf8").split(
      /\r?\n/u,
    )) {
      if (!path || path.endsWith("/")) continue;
      const previous = owners.get(path);
      if (previous && previous !== name) {
        fail(`vcpkg path ${path} is owned by both ${previous} and ${name}`);
      }
      owners.set(path, name);
    }

    const copyrightPath = join(shareRoot, name, "copyright");
    const spdx = readJson(spdxPath);
    const port = spdx.packages?.find(
      (value) => value.SPDXID === "SPDXRef-port",
    );
    const binary = spdx.packages?.find(
      (value) => value.SPDXID === "SPDXRef-binary",
    );
    if (!port?.versionInfo || !binary)
      fail(`incomplete vcpkg SPDX packages for ${name}`);
    metadata.set(name, {
      name,
      port,
      binary,
      resources: (spdx.packages ?? []).filter((value) =>
        value.SPDXID?.startsWith("SPDXRef-resource-"),
      ),
      copyrightSha256: existsSync(copyrightPath)
        ? sha256(readFileSync(copyrightPath))
        : null,
      spdxSha256: sha256(readFileSync(spdxPath)),
    });
  }

  return { owners, metadata };
}

function owningPackage(path, owners) {
  const owner = owners.get(path);
  if (!owner) fail(`no exact vcpkg ownership record for linked input ${path}`);
  return owner;
}

export function nativeEvidenceForBuild(buildRoot) {
  const { owners, metadata } = installedOwnership(buildRoot);
  const targetRoot = join(
    buildRoot,
    "CMakeFiles",
    "onnxruntime_webassembly.dir",
  );
  const linkPath = join(targetRoot, "linkLibs.rsp");
  const linkSource = readFileSync(linkPath, "utf8");
  const registryLock = readJson(
    join(buildRoot, "vcpkg_installed", "vcpkg", "vcpkg-lock.json"),
  );
  if (
    registryLock["https://github.com/Microsoft/vcpkg"]?.HEAD !==
    EXPECTED_VCPKG_REGISTRY_HEAD
  ) {
    fail(`unexpected vcpkg registry lock in ${buildRoot}`);
  }
  const evidence = new Map();
  const targetNames = new Set(["onnxruntime_webassembly"]);

  function addEvidence(name, type, path) {
    const value = evidence.get(name) ?? {
      direct: new Set(),
      headers: new Set(),
    };
    value[type].add(path);
    evidence.set(name, value);
  }

  for (const token of tokenizeResponseFile(linkSource)) {
    const marker = `vcpkg_installed/${TRIPLET}/`;
    const markerIndex = token.indexOf(marker);
    if (markerIndex !== -1) {
      const installedPath = `${TRIPLET}/${token.slice(markerIndex + marker.length)}`;
      const normalizedPath = normalize(installedPath);
      addEvidence(
        owningPackage(normalizedPath, owners),
        "direct",
        normalizedPath,
      );
      continue;
    }
    const archiveMatch = /^lib(.+)\.a$/u.exec(basename(token));
    if (archiveMatch) targetNames.add(archiveMatch[1]);
  }

  for (const targetName of targetNames) {
    const targetDirectory = join(buildRoot, "CMakeFiles", `${targetName}.dir`);
    if (!statSync(targetDirectory).isDirectory()) {
      fail(`missing linked CMake target directory ${targetDirectory}`);
    }
    for (const dependencyFile of walkFiles(targetDirectory, (path) =>
      path.endsWith(".d"),
    )) {
      const source = readFileSync(dependencyFile, "utf8");
      const pattern = new RegExp(
        `vcpkg_installed/${TRIPLET}/([^\\\\\\s]+)`,
        "gu",
      );
      for (const match of source.matchAll(pattern)) {
        const installedPath = `${TRIPLET}/${match[1]}`;
        const normalizedPath = normalize(installedPath);
        addEvidence(
          owningPackage(normalizedPath, owners),
          "headers",
          normalizedPath,
        );
      }
    }
  }

  return {
    buildRoot,
    linkSha256: sha256(linkSource),
    evidence,
    metadata,
  };
}

function loadLicenseOverrides(repository) {
  const path = join(
    repository,
    "vendor",
    "onnxruntime-web",
    "sbom-license-conclusions.json",
  );
  return { path, values: readJson(path) };
}

function concludedNativeLicense(metadata, overrides, overridePath) {
  const recorded = metadata.binary.licenseConcluded;
  if (recorded && recorded !== "NOASSERTION") return recorded;

  const override = overrides[metadata.name];
  if (
    !override ||
    override.version !== metadata.port.versionInfo ||
    override.copyrightSha256 !== metadata.copyrightSha256 ||
    !override.licenseConcluded
  ) {
    fail(
      `${metadata.name}@${metadata.port.versionInfo} has no vcpkg license conclusion; ` +
        `review its exact copyright file (SHA-256 ${metadata.copyrightSha256}) and add ` +
        `a version/hash-bound conclusion to ${overridePath}`,
    );
  }
  return override.licenseConcluded;
}

function nativeSourceIdentity(metadata) {
  return JSON.stringify({
    version: metadata.port.versionInfo,
    licenseDeclared: metadata.port.licenseDeclared ?? "NOASSERTION",
    licenseConcluded: metadata.binary.licenseConcluded ?? "NOASSERTION",
    homepage: metadata.port.homepage ?? null,
    copyrightSha256: metadata.copyrightSha256,
    resources: metadata.resources
      .map((resource) => ({
        name: resource.name,
        downloadLocation: resource.downloadLocation,
        checksums: resource.checksums,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
}

function nativePackages(buildEvidence, repository) {
  const { path: overridePath, values: overrides } =
    loadLicenseOverrides(repository);
  const combined = new Map();

  for (const build of buildEvidence) {
    for (const [name, evidence] of build.evidence) {
      const metadata = build.metadata.get(name);
      const previous = combined.get(name);
      const identity = nativeSourceIdentity(metadata);
      if (previous && previous.identity !== identity) {
        fail(
          `${name} differs between the baseline and JSEP authoritative builds`,
        );
      }
      const value = previous ?? {
        identity,
        metadata,
        builds: [],
      };
      value.builds.push({
        build: relative(resolve(build.buildRoot, "../../.."), build.buildRoot),
        direct: [...evidence.direct].sort(),
        headers: [...evidence.headers].sort(),
        linkSha256: build.linkSha256,
        binaryVersion: metadata.binary.versionInfo ?? "NOASSERTION",
        vcpkgSpdxSha256: metadata.spdxSha256,
      });
      combined.set(name, value);
    }
  }

  return [...combined]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      const { metadata } = value;
      const license = concludedNativeLicense(metadata, overrides, overridePath);
      const resources = metadata.resources.map((resource) => ({
        name: resource.name,
        downloadLocation: resource.downloadLocation,
        checksums: resource.checksums,
      }));
      const id = spdxId("vcpkg", name, metadata.port.versionInfo);
      return {
        id,
        relationshipType: value.builds.some((build) => build.direct.length > 0)
          ? "STATIC_LINK"
          : "GENERATED_FROM",
        package: {
          name,
          SPDXID: id,
          versionInfo: metadata.port.versionInfo,
          downloadLocation:
            resources.length === 1
              ? resources[0].downloadLocation
              : "NOASSERTION",
          filesAnalyzed: false,
          licenseConcluded: license,
          licenseDeclared: metadata.port.licenseDeclared || "NOASSERTION",
          copyrightText: "NOASSERTION",
          homepage: metadata.port.homepage,
          comment:
            `Exact ${TRIPLET} vcpkg component. Installed copyright SHA-256 ` +
            `${metadata.copyrightSha256 ?? "not provided by vcpkg"}. ` +
            `Link/include evidence: ${JSON.stringify(
              value.builds,
            )}. Source resources: ${JSON.stringify(resources)}.`,
        },
      };
    });
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const vendorRoot = join(args.repository, "vendor", "onnxruntime-web");
  const sourceCommit = execFileSync(
    "git",
    ["-C", args.source, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  if (sourceCommit !== EXPECTED_SOURCE_COMMIT) {
    fail(`unexpected ONNX Runtime source commit ${sourceCommit}`);
  }
  assertSha256(args.patch, EXPECTED_PATCH_SHA256);
  const patchedPaths = exactPatchedPaths(args.source, args.patch);
  assertExpectedSourceChanges(args.source, patchedPaths);
  const submodules = exactSubmoduleEvidence(args.source);
  const vcpkgToolCommit = execFileSync(
    "git",
    ["-C", args["vcpkg-tool"], "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  if (vcpkgToolCommit !== EXPECTED_VCPKG_TOOL_COMMIT) {
    fail(`unexpected vcpkg tool checkout ${vcpkgToolCommit}`);
  }

  assertSha256(join(args.source, "LICENSE"), EXPECTED_LICENSE_SHA256);
  assertSha256(
    join(args.source, "ThirdPartyNotices.txt"),
    EXPECTED_NOTICES_SHA256,
  );
  assertSha256(
    join(args.source, "cmake", "vcpkg.json"),
    EXPECTED_VCPKG_MANIFEST_SHA256,
  );
  assertSha256(
    join(args.source, "cmake", "vcpkg-configuration.json"),
    EXPECTED_VCPKG_CONFIGURATION_SHA256,
  );
  const vcpkgConfiguration = readJson(
    join(args.source, "cmake", "vcpkg-configuration.json"),
  );
  if (
    vcpkgConfiguration["default-registry"]?.baseline !==
    EXPECTED_VCPKG_REGISTRY_BASELINE
  ) {
    fail("unexpected vcpkg source registry baseline");
  }
  assertSameBytes(join(args.source, "LICENSE"), join(vendorRoot, "LICENSE"));
  assertSameBytes(
    join(args.source, "ThirdPartyNotices.txt"),
    join(vendorRoot, "ThirdPartyNotices.txt"),
  );
  assertSameBytes(
    join(args.source, "ThirdPartyNotices.txt"),
    join(args.repository, "public", "offline-voice-third-party-notices.txt"),
  );
  assertSha256(
    join(vendorRoot, "LINELIGHT-NOTICE.txt"),
    EXPECTED_MODIFICATION_NOTICE_SHA256,
  );

  const tarballBytes = readFileSync(args.tarball);
  const packageMetadata = JSON.parse(
    readTarMember(args.tarball, "package/package.json").toString("utf8"),
  );
  if (
    packageMetadata.name !== "onnxruntime-web" ||
    packageMetadata.version !== EXPECTED_PACKAGE_VERSION ||
    packageMetadata.license !== "MIT"
  ) {
    fail(
      `unexpected package identity or license ${packageMetadata.name}@${packageMetadata.version} (${packageMetadata.license})`,
    );
  }
  if (
    sha256(readTarMember(args.tarball, "package/LICENSE")) !==
      EXPECTED_LICENSE_SHA256 ||
    sha256(readTarMember(args.tarball, "package/LINELIGHT-NOTICE.txt")) !==
      EXPECTED_MODIFICATION_NOTICE_SHA256 ||
    sha256(readTarMember(args.tarball, "package/ThirdPartyNotices.txt")) !==
      EXPECTED_NOTICES_SHA256
  ) {
    fail(
      "the package does not contain the exact LICENSE, LINELIGHT-NOTICE.txt, " +
        "and ThirdPartyNotices.txt",
    );
  }
  const runtimeMembers = runtimeMemberEvidence(args.source, args.tarball);

  const lock = readJson(join(args.repository, "package-lock.json"));
  const repositoryPackage = readJson(join(args.repository, "package.json"));
  const lockedRuntime = lock.packages?.["node_modules/onnxruntime-web"];
  if (
    repositoryPackage.dependencies?.["onnxruntime-web"] !==
      EXPECTED_LOCAL_PACKAGE_SPEC ||
    lock.packages?.[""]?.dependencies?.["onnxruntime-web"] !==
      EXPECTED_LOCAL_PACKAGE_SPEC ||
    lockedRuntime?.version !== EXPECTED_PACKAGE_VERSION ||
    lockedRuntime.resolved !== EXPECTED_LOCAL_PACKAGE_SPEC
  ) {
    fail(
      "LineLight package.json and lockfile do not directly resolve the exact reviewed local runtime tarball",
    );
  }
  if (
    JSON.stringify(sortedRecord(lockedRuntime.dependencies)) !==
    JSON.stringify(sortedRecord(packageMetadata.dependencies))
  ) {
    fail(
      "LineLight package-lock.json does not retain the package's exact direct dependency specifications",
    );
  }
  const tarballSha512 = sha512(tarballBytes);
  if (parseIntegrity(lockedRuntime.integrity) !== tarballSha512) {
    fail(
      "LineLight package-lock.json integrity does not match the supplied runtime tarball",
    );
  }

  const javascriptPackages = directJavaScriptPackages(packageMetadata, lock);
  const buildEvidence = BUILD_RELATIVE_PATHS.map((path) =>
    nativeEvidenceForBuild(join(args.source, path)),
  );
  const linkedNativePackages = nativePackages(buildEvidence, args.repository);
  if (linkedNativePackages.length === 0)
    fail("no linked native components found");

  const tarballSha256 = sha256(tarballBytes);
  const runtimeId = spdxId(
    "npm",
    packageMetadata.name,
    packageMetadata.version,
  );
  const noticeFiles = [
    {
      fileName: "./LICENSE",
      SPDXID: "SPDXRef-File-License",
      checksums: [
        { algorithm: "SHA256", checksumValue: EXPECTED_LICENSE_SHA256 },
      ],
      licenseConcluded: "MIT",
      copyrightText: "Copyright (c) Microsoft Corporation",
    },
    {
      fileName: "./LINELIGHT-NOTICE.txt",
      SPDXID: "SPDXRef-File-LineLight-Notice",
      checksums: [
        {
          algorithm: "SHA256",
          checksumValue: EXPECTED_MODIFICATION_NOTICE_SHA256,
        },
      ],
      licenseConcluded: "NOASSERTION",
      copyrightText: "NOASSERTION",
      comment:
        "Self-identifies the exact LineLight-modified package and patch.",
    },
    {
      fileName: "./ThirdPartyNotices.txt",
      SPDXID: "SPDXRef-File-Third-Party-Notices",
      checksums: [
        { algorithm: "SHA256", checksumValue: EXPECTED_NOTICES_SHA256 },
      ],
      licenseConcluded: "NOASSERTION",
      copyrightText: "NOASSERTION",
      comment: "Exact upstream ONNX Runtime component notices.",
    },
  ];
  const document = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `LineLight modified ${packageMetadata.name}@${packageMetadata.version}`,
    documentNamespace:
      `https://github.com/linelight-app/LineLight/spdx/` +
      `${packageMetadata.name}-${packageMetadata.version}-${tarballSha256}`,
    creationInfo: {
      created: args.created,
      creators: [`Tool: ${TOOL_NAME}`],
      comment:
        `Source ${EXPECTED_SOURCE_COMMIT}; patch SHA-256 ${EXPECTED_PATCH_SHA256}; ` +
        `vcpkg tool ${EXPECTED_VCPKG_TOOL_COMMIT}; registry baseline ` +
        `${EXPECTED_VCPKG_REGISTRY_BASELINE}; resolved registry HEAD ` +
        `${EXPECTED_VCPKG_REGISTRY_HEAD}; tarball SHA-256 ${tarballSha256}. ` +
        `Exact recursive submodules: ${submodules
          .map((value) => `${value.path}@${value.commit}`)
          .join(", ")}. ` +
        `Runtime members: ${runtimeMembers
          .map(
            (value) =>
              `${value.name}=SHA256:${value.sha256} (${value.size} bytes)`,
          )
          .join(", ")}. ` +
        `Native scope is the union of exact ` +
        `vcpkg archives on both final linker command lines and vcpkg-owned headers ` +
        `included by object targets linked into those artifacts.`,
    },
    documentDescribes: [runtimeId],
    packages: [
      {
        name: packageMetadata.name,
        SPDXID: runtimeId,
        versionInfo: packageMetadata.version,
        packageFileName: basename(args.tarball),
        downloadLocation: "NONE",
        filesAnalyzed: false,
        licenseConcluded: "MIT",
        licenseDeclared: packageMetadata.license,
        copyrightText: "Copyright (c) Microsoft Corporation",
        primaryPackagePurpose: "LIBRARY",
        checksums: [
          { algorithm: "SHA256", checksumValue: tarballSha256 },
          { algorithm: "SHA512", checksumValue: tarballSha512 },
        ],
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: npmPurl(
              packageMetadata.name,
              packageMetadata.version,
            ),
          },
        ],
        comment:
          `Modified by LineLight for cooperative threaded-Wasm inference ` +
          `cancellation. The tarball carries exact LICENSE, ` +
          `LINELIGHT-NOTICE.txt, and ThirdPartyNotices.txt copies.`,
      },
      ...javascriptPackages.map((value) => value.package),
      ...linkedNativePackages.map((value) => value.package),
    ],
    files: noticeFiles,
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: runtimeId,
      },
      ...javascriptPackages.map((value) => ({
        spdxElementId: runtimeId,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: value.id,
      })),
      ...linkedNativePackages.map((value) => ({
        spdxElementId: runtimeId,
        relationshipType: value.relationshipType,
        relatedSpdxElement: value.id,
      })),
      ...noticeFiles.map((value) => ({
        spdxElementId: runtimeId,
        relationshipType: "OTHER",
        relatedSpdxElement: value.SPDXID,
        comment:
          `The exact npm distribution carries checksum-bound ${value.fileName}; ` +
          "this relationship does not assert SPDX package containment or full file analysis.",
      })),
    ],
  };

  writeFileSync(args.output, `${JSON.stringify(document, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(
    `${args.output}\nSHA-256 ${sha256(readFileSync(args.output))}\n`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main();
}
