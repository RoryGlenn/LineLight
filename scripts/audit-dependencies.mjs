import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ALLOWED_DEV_ADVISORIES = Object.freeze({
  "GHSA-5P2G-FCMC-QVQQ": Object.freeze({
    name: "image-size",
    version: "2.0.2",
  }),
  "GHSA-W3RX-R6R6-PGPR": Object.freeze({
    name: "image-size",
    version: "2.0.2",
  }),
});

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

function advisoryId(via) {
  if (!via || typeof via !== "object" || typeof via.url !== "string") {
    return null;
  }
  return via.url.match(/GHSA-[a-z0-9-]+$/iu)?.[0]?.toUpperCase() ?? null;
}

function nodesAreDevOnly(vulnerability, lockfile) {
  return (
    Array.isArray(vulnerability.nodes) &&
    vulnerability.nodes.length > 0 &&
    vulnerability.nodes.every(
      (node) => lockfile.packages?.[node]?.dev === true,
    )
  );
}

function directAdvisoryIsAllowed(vulnerability, via, lockfile, allowances) {
  const id = advisoryId(via);
  const allowance = id ? allowances[id] : undefined;
  if (!allowance || vulnerability.name !== allowance.name) return false;
  if (!nodesAreDevOnly(vulnerability, lockfile)) return false;

  return vulnerability.nodes.every(
    (node) => lockfile.packages[node]?.version === allowance.version,
  );
}

/**
 * Find high or critical dependency findings not covered by the exact,
 * development-only advisory allowlist.
 *
 * Transitive wrapper findings such as vinext -> image-size are accepted only
 * when every referenced finding is independently allowed and the wrapper is
 * also development-only.
 *
 * @param {Record<string, any>} report npm audit JSON output.
 * @param {Record<string, any>} lockfile Parsed package-lock.json.
 * @param {Record<string, {name: string, version: string}>} [allowances]
 */
export function findBlockingVulnerabilities(
  report,
  lockfile,
  allowances = ALLOWED_DEV_ADVISORIES,
) {
  const vulnerabilities = report.vulnerabilities ?? {};
  const decisions = new Map();

  const isAllowed = (name, ancestry = new Set()) => {
    if (decisions.has(name)) return decisions.get(name);
    if (ancestry.has(name)) return false;

    const vulnerability = vulnerabilities[name];
    if (!vulnerability || !nodesAreDevOnly(vulnerability, lockfile)) {
      decisions.set(name, false);
      return false;
    }
    if (!Array.isArray(vulnerability.via) || !vulnerability.via.length) {
      decisions.set(name, false);
      return false;
    }

    const nextAncestry = new Set(ancestry).add(name);
    const allowed = vulnerability.via.every((via) =>
      typeof via === "string"
        ? isAllowed(via, nextAncestry)
        : directAdvisoryIsAllowed(
            vulnerability,
            via,
            lockfile,
            allowances,
          ),
    );
    decisions.set(name, allowed);
    return allowed;
  };

  return Object.values(vulnerabilities)
    .filter((vulnerability) =>
      BLOCKING_SEVERITIES.has(vulnerability.severity),
    )
    .filter((vulnerability) => !isAllowed(vulnerability.name))
    .map((vulnerability) => vulnerability.name)
    .sort();
}

function runAudit() {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["audit", "--package-lock-only", "--audit-level=high", "--json"],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (cause) {
    process.stderr.write(result.stderr);
    throw new Error("npm audit did not return valid JSON.", { cause });
  }
  if (!report.vulnerabilities || typeof report.vulnerabilities !== "object") {
    process.stderr.write(result.stderr);
    throw new Error("npm audit did not return a vulnerability report.");
  }

  const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const blocking = findBlockingVulnerabilities(report, lockfile);
  if (blocking.length) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(
      `Blocking high-severity dependencies: ${blocking.join(", ")}.`,
    );
  }

  const auditOutput = result.stdout.toUpperCase();
  const allowedIds = Object.keys(ALLOWED_DEV_ADVISORIES).filter((id) =>
    auditOutput.includes(id),
  );
  console.log("Dependency audit passed with no unapproved high findings.");
  if (allowedIds.length) {
    console.log(
      `Accepted unpatched development-only advisories: ${allowedIds.join(", ")}.`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    runAudit();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
