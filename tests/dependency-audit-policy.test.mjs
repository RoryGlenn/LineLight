import assert from "node:assert/strict";
import test from "node:test";

import { findBlockingVulnerabilities } from "../scripts/audit-dependencies.mjs";

const ALLOWED_ICNS = {
  name: "image-size",
  severity: "high",
  via: [
    {
      url: "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr",
    },
  ],
  nodes: ["node_modules/image-size"],
};

const DEV_LOCKFILE = {
  packages: {
    "node_modules/image-size": { dev: true, version: "2.0.2" },
    "node_modules/vinext": { dev: true, version: "0.0.50" },
  },
};

test("accepts only the pinned image-size advisory through dev-only paths", () => {
  const report = {
    vulnerabilities: {
      "image-size": ALLOWED_ICNS,
      vinext: {
        name: "vinext",
        severity: "high",
        via: ["image-size"],
        nodes: ["node_modules/vinext"],
      },
    },
  };

  assert.deepEqual(findBlockingVulnerabilities(report, DEV_LOCKFILE), []);
});

test("rejects new high advisories even on an otherwise allowed package", () => {
  const report = {
    vulnerabilities: {
      "image-size": {
        ...ALLOWED_ICNS,
        via: [
          ...ALLOWED_ICNS.via,
          {
            url: "https://github.com/advisories/GHSA-new0-new0-new0",
          },
        ],
      },
    },
  };

  assert.deepEqual(findBlockingVulnerabilities(report, DEV_LOCKFILE), [
    "image-size",
  ]);
});

test("rejects an allowed advisory when any affected path is production", () => {
  const lockfile = structuredClone(DEV_LOCKFILE);
  lockfile.packages["node_modules/image-size"].dev = false;

  assert.deepEqual(
    findBlockingVulnerabilities(
      { vulnerabilities: { "image-size": ALLOWED_ICNS } },
      lockfile,
    ),
    ["image-size"],
  );
});

test("rejects an allowed advisory after the pinned package version changes", () => {
  const lockfile = structuredClone(DEV_LOCKFILE);
  lockfile.packages["node_modules/image-size"].version = "2.0.3";

  assert.deepEqual(
    findBlockingVulnerabilities(
      { vulnerabilities: { "image-size": ALLOWED_ICNS } },
      lockfile,
    ),
    ["image-size"],
  );
});

test("rejects unrelated high vulnerabilities", () => {
  const report = {
    vulnerabilities: {
      nanoid: {
        name: "nanoid",
        severity: "high",
        via: [{ url: "https://github.com/advisories/GHSA-example" }],
        nodes: ["node_modules/nanoid"],
      },
    },
  };
  const lockfile = {
    packages: {
      "node_modules/nanoid": { dev: false, version: "3.3.16" },
    },
  };

  assert.deepEqual(findBlockingVulnerabilities(report, lockfile), ["nanoid"]);
});
