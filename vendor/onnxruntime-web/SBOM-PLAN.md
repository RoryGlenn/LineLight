# ONNX Runtime Web SBOM generation plan

Do not hand-edit `sbom.spdx.json`. Generate it only after the authoritative
baseline and JSEP builds, final notice-bearing npm package, and LineLight local
file dependency are all present. Merely listing every vcpkg package installed
during configuration would incorrectly include host tools and unused build
dependencies while missing the evidence that a header-only component reached a
linked object.

`generate-sbom.mjs` is a fail-closed, offline generator for SPDX 2.3 JSON. It
does not write its output until all of these inputs agree:

- the exact ONNX Runtime source commit and LineLight patch SHA-256;
- every one of the patch's 24 source-file postimages, reconstructed in a
  temporary Git index from the exact commit plus patch and byte-compared with
  the authoritative build tree;
- the exact six deterministic package-version mutations and three legal-file
  additions outside those patch paths, with any other visible source-tree
  change rejected;
- an unchanged superproject index plus every recursively initialized submodule
  at its exact gitlink and with no tracked or untracked change;
- the distinct pinned vcpkg tool checkout, source-registry baseline and
  configuration hash, and each build's resolved registry lock;
- the exact upstream `LICENSE` and `ThirdPartyNotices.txt` in the source tree,
  vendor directory, deployed public file, and npm tarball;
- the exact `LINELIGHT-NOTICE.txt` self-identification in the vendor directory
  and npm tarball;
- the final npm package name, version, SHA-256, SHA-512, and LineLight lockfile
  integrity, with the exact local-file spec present in both LineLight's root
  manifest and root lock entry;
- all four threaded runtime members, byte-identical between authoritative
  `js/web/dist` output and the npm tarball and bound to their expected SHA-256;
- the package's complete direct dependency-name set and each dependency's exact
  version, integrity, resolved location, and declared license from LineLight's
  lockfile;
- both final `onnxruntime_webassembly` linker response files;
- vcpkg archive ownership, linked-target dependency files, per-port SPDX data,
  and installed copyright files from each authoritative build tree.

The runtime package remains `filesAnalyzed: false`: the focused document does
not enumerate or claim analysis of every npm-tarball member. The three exact,
checksum-bound legal files are still document-level SPDX file elements, with
commented `OTHER` relationships recording that the distribution carries them.
They are deliberately not `CONTAINS` relationships because SPDX 2.3 forbids a
package marked `filesAnalyzed: false` from containing file elements.

For native scope, the generator takes the union of two evidence classes across
the baseline and JSEP artifacts:

1. vcpkg archives named directly on the final linker command line receive an
   SPDX `STATIC_LINK` relationship;
2. vcpkg-owned headers included by an object target whose local archive is on
   that linker command line receive an SPDX `GENERATED_FROM` relationship.

Every installed path must map to exactly one package through vcpkg's generated
`vcpkg/info/*_wasm32-emscripten.list`. Each selected component's version,
source resource, and license conclusion come from that component's generated
`share/*/vcpkg.spdx.json`. This deliberately excludes x64 host packages,
benchmarks, tests, and other installed ports unless final link/include evidence
selects them. The two configurations must agree on source version, source
resource checksums, license data, homepage, and installed copyright hash. Their
configuration-specific vcpkg binary ABI identifiers, per-build SPDX hashes,
linker-response hashes, and selected paths are retained separately as evidence;
binary ABI identifiers are not expected to match between baseline and JSEP.

Some vcpkg SPDX records use `NOASSERTION` even though their exact installed
`copyright` file contains a standard license. The generator refuses to replace
that value implicitly. After the final build identifies such a selected
component, review that exact file and add only a version- and SHA-256-bound
conclusion to `sbom-license-conclusions.json`, for example:

```json
{
  "package-name": {
    "version": "exact vcpkg version",
    "copyrightSha256": "64 lowercase hexadecimal characters",
    "licenseConcluded": "reviewed SPDX license expression"
  }
}
```

The checked-in conclusions file records only conclusions bound to final
evidence. Both authoritative builds selected SafeInt 3.0.28 and emitted the
same standard MIT copyright file, so that one conclusion is version- and
SHA-256-bound there; any changed version or bytes fail generation.

After the final package is installed into LineLight's lockfile as a local file
dependency, generate the document with an explicit UTC creation timestamp from
the successful final-package record:

```bash
node vendor/onnxruntime-web/generate-sbom.mjs \
  --repository . \
  --source /tmp/issue55-build/onnxruntime-final-ack \
  --patch vendor/onnxruntime-web/onnxruntime-89f8206-live-cancellation.patch \
  --vcpkg-tool /tmp/issue55-build/vcpkg \
  --tarball vendor/onnxruntime-web/onnxruntime-web-1.22.0-dev.20250409-89f8206ba4.tgz \
  --created 2026-08-09T00:00:00Z \
  --output vendor/onnxruntime-web/sbom.spdx.json
```

The retained document uses the recorded final-package timestamp shown above. To
verify determinism, run the generator twice with the same inputs and timestamp
to two new temporary paths, compare them byte-for-byte, then move neither into
the repository. As an independent JavaScript-graph cross-check, run npm 11's
`npm sbom --sbom-format spdx --package-lock-only` against the final LineLight
lockfile and confirm the modified runtime's six direct dependency edges and
resolved versions match the focused document. The npm output covers the whole
application graph and therefore is not substituted for this runtime-specific
SBOM. Validate the retained JSON against the
[official SPDX 2.3 JSON schema](https://raw.githubusercontent.com/spdx/spdx-spec/v2.3/schemas/spdx-schema.json),
review every `NOASSERTION`, and add the final SBOM digest to
`CHECKSUMS.sha256`. The retained
`evidence/sbom-validation.json` records the two-run comparison and official
schema result; `evidence/npm-sbom-cross-check.json` records the whole-graph
digest and the exact six resolved direct dependency edges.

The copied upstream `ThirdPartyNotices.txt` remains the complete deployed legal
notice even when a package is correctly excluded from this artifact-specific
SBOM. The SBOM is an artifact composition record, not a replacement for those
notices.
