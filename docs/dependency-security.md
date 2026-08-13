# Dependency security posture

Last reviewed: 2026-08-09

LineLight treats dependency updates as part of the production build, even when
the affected package is primarily development tooling. CI installs from the
lockfile, audits the complete dependency graph at high severity, type-checks,
builds the Sites Worker, runs the test suite, and validates the packaged
artifact.

## August 2026 hardening

The pre-hardening lockfile reported 20 advisories: 13 high, 6 moderate, and 1
low. The hardening update moves direct dependencies to their compatible patched
releases, including:

- Next.js 16.2.12 and React Server Components 19.2.8;
- Vite 8.2.0;
- Cloudflare's Vite plugin 1.51.1 and Wrangler 4.120.0;
- patched transitive releases of brace-expansion, fast-uri, js-yaml, undici,
  and ws.

The current lockfile reports zero unapproved high or critical findings. Two
high-severity `image-size` 2.0.2 advisories are accepted only through verified
development-only paths: `GHSA-5P2G-FCMC-QVQQ` and
`GHSA-W3RX-R6R6-PGPR`. The exact package, version, advisory IDs, and dev-only
reachability are enforced by `scripts/audit-dependencies.mjs`; any production
path or new finding fails CI. This is a dated audit result, not a permanent
guarantee, so CI repeats the audit on every proposed change.

## Audited overrides

Three transitive packages need explicit overrides because an otherwise-current
parent package constrains them to an advisory-affected release:

- `postcss` 8.5.26 replaces Next.js's older 8.4.31 copy. It stays on PostCSS 8,
  and the production CSS build exercises the integration.
- `esbuild` 0.28.1 replaces the older copy used by Drizzle Kit's deprecated
  `@esbuild-kit` loader. `drizzle-kit check`, type checking, and the production
  build exercise this path.
- `sharp` 0.35.3 replaces the vulnerable 0.34 line required by
  `@huggingface/transformers` 3.8.1. The pinned local audiobook-alignment
  runtime still uses the reviewed Transformers 3.x browser API.

Sharp 0.35 drops Node.js 18 and removes several deprecated image options.
LineLight requires Node.js 22.13 or newer, and Transformers 3.8.1 does not call
the removed options. The dependency-hardening regression test exercises the
actual Transformers adapter with Sharp 0.35.3: metadata decoding, raw pixels,
affine and Lanczos resizing, padding, cropping, PNG encoding, and decoding.

## Sharp production exposure

Local audiobook alignment runs Transformers in a browser Web Worker. That path
does not invoke the Node-only Sharp adapter. Offline narration now calls ONNX
Runtime directly for Supertonic and does not bundle Transformers. No Sharp
native addon, `@img` platform package, or libvips binary is packaged in `dist`.

The artifact test enforces that boundary after every production build. Sharp is
still installed for Node-side development imports, so the adapter compatibility
test remains necessary while the local alignment worker imports Transformers.

## Transformers inference-queue and cancellation-diagnostic patch

LineLight applies a narrow compatibility patch to
`@huggingface/transformers` 3.8.1 during installation. In the browser inference
path, a canceled ONNX run rejects its own promise. The upstream serialization
chain retained that rejection as the queue tail, which made every later run
reject before it could start. The LineLight patch keeps the current run promise
for its caller, preserving the original fulfillment or rejection, while a
private continuation normalizes both outcomes before that promise becomes the
tail used to schedule the next run. That queue-tail change is applied to
`src/backends/onnx.js` and the equivalent code in
`dist/transformers.web.js`.

The same install step modifies the model wrapper in `src/models.js` and the
equivalent code in `dist/transformers.web.js`. It rethrows only an error whose
name is exactly `AbortError` and whose code is exactly
`ERR_ORT_WASM_RUN_CANCELED`, before the upstream catch path formats tensor or
model inputs or writes its error diagnostic. This expected cooperative
cancellation still rejects the current caller, but it cannot serialize private
model input through the browser console. Ordinary failures and similar-looking
errors continue through Transformers' unchanged diagnostic, rejection, and
queue-recovery behavior.

The reviewed whole-file SHA-256 boundaries are:

| Installed Transformers 3.8.1 file | Upstream preimage                                                  | LineLight result                                                   |
| --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `src/backends/onnx.js`            | `3265edafb24d321eb4b214f45684fa1d498407e2e0eca5fea9e720958f1635f3` | `3d026ce1714db9aee4e5b6d2aead761d006ae9dea2a8e9d05800878ac881acd8` |
| `src/models.js`                   | `6ba3e066c05b5a4ae35281b0cafff0504e13a6b18d7e2e3799eb9f243a610108` | `4152078945cce8defb4807e8f17b30211f7621555f6223c2ff2c34a2bffb1530` |
| `dist/transformers.web.js`        | `1b41438d839ca3ea1346031472edee8cb3eefbf0bad48945f969559e2eb03394` | `56528ad2d27d93dfc5326346298ef47bc75fe83ac8e284d6811909c14467abe7` |

[`scripts/apply-dependency-patches.mjs`](../scripts/apply-dependency-patches.mjs)
is deliberately fail closed. Before writing any file, it checks the exact
package version, lockfile integrity, and every complete SHA-256 preimage or
already-patched digest. A partial match or unexpected dependency update aborts
installation; a fully patched installation is accepted idempotently. The
source and distributed browser representations are both covered because
development and production bundling can resolve different package entry
points. The modification and upstream package remain under Apache-2.0, with
the distributed notice in
[`public/offline-voice-license.txt`](../public/offline-voice-license.txt).
This install-time Transformers patch does not modify the repository-bundled
ONNX Runtime package, so the focused ONNX Runtime SBOM and checksum manifest
remain unchanged.

## Modified ONNX Runtime Web

LineLight uses a repository-bundled
`onnxruntime-web` 1.22.0-dev.20250409-89f8206ba4 package built from upstream
commit `89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0`. The source modification adds a
generation-scoped cancellation mailbox and WebAssembly API bridge so a
multi-threaded CPU inference can observe cancellation between graph execution
steps. LineLight publishes that bridge only when the active backend is
multi-threaded WebAssembly. Single-thread WebAssembly and WebGPU do not opt in,
even in an environment where `SharedArrayBuffer` exists.

The package is a direct local file dependency rather than an unrecorded edit to
`node_modules`. [`vendor/onnxruntime-web/README.md`](../vendor/onnxruntime-web/README.md)
records the pinned source and toolchain, build procedure, and artifact layout;
the same directory contains the source patch, reproduction script, package
tarball, exact upstream MIT license and component notices, LineLight
modification notice (`LINELIGHT-NOTICE.txt`), deterministic SPDX generator and
evidence plan, and SHA-256 manifest. Artifact and input digests are recorded in
`CHECKSUMS.sha256`; this document intentionally does not duplicate them.

The retained SPDX 2.3 SBOM was generated only after the final artifact evidence
and local dependency lock agreed. The offline generator reads the exact direct
JavaScript dependency set from the notice-bearing tarball and LineLight
lockfile, then takes the union of vcpkg archives on both final linker command
lines and vcpkg-owned headers included by the local object targets those
commands link. It rejects unresolved license conclusions and keeps the vcpkg
tool checkout distinct from the source registry baseline. The generation
procedure, focused [`sbom.spdx.json`](../vendor/onnxruntime-web/sbom.spdx.json),
official-schema validation record, and npm whole-application dependency-graph
cross-check are retained under
[`vendor/onnxruntime-web/`](../vendor/onnxruntime-web/README.md) and bound by its
checksum manifest.

The runtime remains inside the private offline-narration boundary. During
installed synthesis, its worker processes locally supplied narration text and
model assets from browser storage, and forwards the same-origin shared Wasm
memory reference plus the two reviewed mailbox indices to the page. The page
helper accesses only those atomic generation cells; the protocol does not copy
narration text or document content, add a service, or add a network destination.
If a canceled run fails to acknowledge within the bounded page watchdog,
LineLight replaces that worker and permits the replacement to load the
already-prepared voice only from Cache Storage.

ONNX Runtime is MIT-licensed. The complete upstream text and a prominent notice
describing LineLight's modification are distributed in
[`public/offline-voice-license.txt`](../public/offline-voice-license.txt) and in
the vendor provenance directory. ONNX Runtime's complete upstream component
notices are also deployed unchanged in
[`public/offline-voice-third-party-notices.txt`](../public/offline-voice-third-party-notices.txt).

## Maintenance

When Supertonic, Transformers, or ONNX Runtime Web changes:

1. remove or update the corresponding override or guarded patch in a dedicated
   dependency update;
2. when ONNX Runtime Web changes, regenerate the modified runtime only from the
   pinned source and reproduction procedure, then refresh its checksums, SBOM,
   and notices;
3. regenerate the lockfile from a clean install and confirm that only the
   intended ONNX Runtime Web package is installed;
4. rerun the audit, Drizzle check, type check, lint, production build, tests,
   artifact validation, and applicable real-browser backend gates;
5. keep the compatibility, cancellation-lifecycle, and artifact tests unless
   the patched path is no longer installed at all.
