# Modified ONNX Runtime Web for Issue #55

This directory records the source, build, package, licensing, and SBOM evidence
for LineLight's modified `onnxruntime-web` package. The modification adds
generation-scoped cooperative cancellation for serialized, multi-threaded
WebAssembly inference. LineLight uses that path for Offline natural narration;
WebGPU and single-thread WebAssembly retain request-boundary cancellation.

The npm package is built from an exact upstream commit and installed by
LineLight as a checksum-locked local file dependency. It does not patch an
installed `node_modules` tree, add a service, or send narration text anywhere.

## Reviewed files

- `onnxruntime-web-1.22.0-dev.20250409-89f8206ba4.tgz` is the distributable npm
  package.
- `onnxruntime-89f8206-live-cancellation.patch` is the complete 24-file source
  modification.
- `reproduce-build.sh` performs the clean baseline and JSEP Wasm builds and the
  JavaScript pre-package checks.
- `finalize-package.sh` adds the exact legal notices and repacks the completed
  outputs without rebuilding Wasm.
- `static-audit.sh` checks the intended native and JavaScript cancellation
  surface before packaging.
- `wasm-cancellation-protocol.test.mjs` exercises the four cross-agent mailbox
  cases against the retained `run-cancellation.bundle.mjs` page helper.
- `runtime-export-smoke.mjs` loads the retained threaded runtime and exercises
  its four cancellation exports and three-cell shared mailbox.
- `LICENSE` is the byte-identical upstream ONNX Runtime MIT license.
- `ThirdPartyNotices.txt` is the byte-identical upstream component notice.
- `LINELIGHT-NOTICE.txt` identifies the exact upstream commit and LineLight
  patch inside the npm distribution.
- `generate-sbom.mjs`, `SBOM-PLAN.md`, and
  `sbom-license-conclusions.json` define the fail-closed SPDX 2.3 generation
  procedure. `sbom.spdx.json` is retained only after all final artifact gates
  pass.
- `evidence/` retains the raw full-build log, P-prime incremental relink,
  fresh-apply and postimage checks, source delta, successful final packaging,
  the exact native `onnxruntime_test_all` build and filtered cancellation test,
  runtime-export smoke result, SPDX validation and npm graph cross-check, and
  independent final hash comparison. Their digests are recorded in
  `CHECKSUMS.sha256`; the full-build log truthfully retains its final npm-pack
  working-directory failure after both native builds and source checks passed.
- `CHECKSUMS.sha256` binds the checked-in provenance files and final artifacts.

## Exact identity

- Package: `onnxruntime-web@1.22.0-dev.20250409-89f8206ba4`
- Upstream commit: `89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0`
- LineLight patch SHA-256:
  `4b368d00b9c4fc11cf5183caeed13d858e93b842cba26df27bde1b653d9372f2`
- Patch size: 66,066 bytes and 1,534 lines
- Patch delta: 24 files, 894 insertions, 73 deletions
- Final package SHA-256:
  `8ded0bd491693184e4ee9b47356264986409d2f1ccd205b6d24d3d4ce6f43542`
- Final package SHA-512:
  `d634aef4901d323d5267a375188629047710c27a7932e543942c4549b02e5d1d1f09d20d93cce1d0140d2c24399480a4a6b2737ab3fa1566c645f7571af42196`
- Packed files: 499
- Package size: 21,390,688 bytes

The final threaded runtime members are:

| npm member                              |      Bytes | SHA-256                                                            |
| --------------------------------------- | ---------: | ------------------------------------------------------------------ |
| `dist/ort-wasm-simd-threaded.wasm`      | 12,755,933 | `db1fa2012c98f8806f5641558635261a9b09aaff8827e01a38ffdcb4d73f7a22` |
| `dist/ort-wasm-simd-threaded.mjs`       |     26,843 | `87a120859ceba8870536ab6684a47b5cdb2515a33a0ab80c4520ec84fbe3df85` |
| `dist/ort-wasm-simd-threaded.jsep.wasm` | 24,113,968 | `1e5a323ca41d859f324694c7b5ba2052bf8c1a96ff9721bc62e94f874d379fe1` |
| `dist/ort-wasm-simd-threaded.jsep.mjs`  |     53,881 | `c1458b19e63c7b104a38fc4dd44a0993b58c961a2c7884b347d2abce74556a22` |

The SBOM generator byte-compares each of those package members with the
authoritative `js/web/dist` output before recording its hash and size.

## Source and toolchain pins

The build uses these recursively initialized upstream gitlinks:

- Emscripten SDK: `074211759c17c646164d3271ca1d155cc174f78e`
- libprotobuf-mutator: `7a2ed51a6b682a83e345ff49fc4cfd7ca47550db`
- ONNX: `b8baa8446686496da4cc8fda09f2b6fe65c2a02c`
- ONNX's nested pybind11:
  `3e9dfa2866941655c56877882565e7577de6fc7b`

The checked build tools are:

- Python 3.12
- CMake 3.31.6
- Emscripten 4.0.4
- Node.js 20.19.4
- vcpkg tool checkout:
  `b02e341c927f16d991edbd915d8ea43eac52096c`

The vcpkg tool checkout is not the dependency registry identity. ONNX
Runtime's exact source configuration records:

- `cmake/vcpkg.json` SHA-256:
  `a76794c3c836e1cbc9adb3307dc3f2af6d629815642832fcb56d3172690e2129`
- `cmake/vcpkg-configuration.json` SHA-256:
  `11d905868d78604f6c4ed97718b7e229c8cc5e5ea78d566ce53e2748c5fe6f1f`
- Registry baseline:
  `a29711cc86340a43c054cd37b8bd2871332a01e9`
- Resolved registry HEAD from each generated vcpkg lock:
  `ea1a7396b05637a53bf23c078647ecc0edee4b80`

The exact legal inputs are:

- `LICENSE` SHA-256:
  `2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c`
- `ThirdPartyNotices.txt` SHA-256:
  `e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc`
- `LINELIGHT-NOTICE.txt` SHA-256:
  `9c451ee63c6c8a7c95c6def90acb21f866a582a3c31814e244b036d2eeac9d85`

## What changed

### Thread-safe run termination

The patch replaces the plain termination flag used during execution with a
copyable `RunTerminationFlag`. Its local request is atomic, preserving the
existing `RunOptionsSetTerminate` and `RunOptionsUnsetTerminate` behavior
without a C++ data race. An optional external generation binding lets executor
threads observe the Wasm mailbox at existing ONNX Runtime cancellation
checkpoints. Copy and move operations preserve the local value but deliberately
drop an active external binding.

The patch propagates the new flag through execution steps, kernel context,
sequential execution, stream execution, and graph utilities. It also makes
multi-stream failure publication race-free so the first failure is published
before the owner reads its final status.

### Wasm cancellation mailbox

The Wasm runtime owns three adjacent, aligned `atomic<uint32_t>` cells:

1. active run generation;
2. requested cancellation generation;
3. executor-observed cancellation generation.

Only the first two cells form the public cross-agent pair. The third remains
private to the runtime so a late request cannot be mistaken for cancellation
that an executor actually observed.

Four kept-alive Wasm functions implement the bridge:

- `OrtGetRunCancellationMailbox()`
- `OrtBeginRunCancellation(run_options)`
- `OrtIsRunCancellationRequested(generation)`
- `OrtEndRunCancellation(run_options, generation)`

Generation zero is reserved. Begin binds one serialized run; End acknowledges
only the matching observed request, clears only matching state, and unbinds
after inference returns. A stale generation cannot cancel a later run.

### JavaScript boundary

`js/web/lib/wasm/run-cancellation.ts` exposes an opt-in observer and request
helper. A start event carries the shared Wasm buffer, the active/requested cell
indices, and the current generation. Before an atomic write, the helper checks
that the buffer is a real `SharedArrayBuffer`, values are in range, the cells
are adjacent, and the active cell still contains the same generation.

`wasm-core-impl.ts` begins observation immediately before `_OrtRun` or
`_OrtRunWithBinding` and ends it in `finally`. Native acknowledgment produces a
stable `AbortError` with code `ERR_ORT_WASM_RUN_CANCELED`. A canceled run keeps
its initialized session available for the next serialized request.

LineLight's page helper receives the same-origin shared Wasm memory reference
but reads or writes only the two reviewed public cells. Narration text and
document content are not added to this protocol.

## Build and package provenance

The retained artifact comes from a split, recorded verification sequence:

1. A detached checkout at the exact upstream commit was initialized
   recursively and patched. Both Release targets completed: baseline
   SIMD/threaded Wasm and JSEP SIMD/threaded Wasm with WebNN.
2. The source package installations, web TypeScript prebuild, repository
   ESLint run, and Prettier check completed after the native builds.
3. The original full-build script's last `npm pack` invocation exposed an npm
   10 behavior: a relative `--prefix` loaded the web config but still tried to
   pack the source root. The native outputs and preceding checks were already
   complete. The checked-in scripts use an explicit `js/web` working directory
   for packaging.
4. The final P-prime patch and notice were applied to the exact source. A fresh
   detached checkout accepted the patch, and all 24 resulting file postimages
   matched the authoritative build tree byte-for-byte. The final baseline and
   JSEP targets were relinked from that tree; both reached 100%, the TypeScript
   prebuild, ESLint, and Prettier checks passed again, and the resulting four
   runtime hashes match the package members recorded above.
5. The final package stage installed the exact MIT license, LineLight notice,
   and upstream third-party notice; packed 499 files; and verified those three
   members plus all four runtime members.
6. An independent repack produced the same final package SHA-256 shown above.

This record does not turn an incremental or split check into an unrun test. The
full build established both native target outputs and dependency evidence; the
postimage comparison establishes that the final 24 patched source files equal
fresh exact HEAD plus the retained patch; the package comparisons bind the
shipped runtime members to the authoritative `js/web/dist` bytes.

Completed checks include:

- exact patch hash, clean applicability, `git diff --check`, and all 24 fresh
  postimage comparisons;
- recursively initialized exact submodules;
- static audit of the native exports, TypeScript interface, public exports,
  memory64 signatures, wrapper placement, and test discovery;
- baseline and JSEP Release Wasm target builds;
- web TypeScript prebuild, ESLint, and Prettier 3.3.3;
- the standalone `worker_threads` shared-mailbox protocol cases (4/4);
- a package runtime-export smoke check that observed shared memory, three
  mailbox cells, generations 1 then 2, and all four wrapper exports;
- an exact-P-prime native `onnxruntime_test_all` build followed by all seven
  `RunTerminationFlagTest.*` cases, including concurrent local cancellation,
  external-generation observation, late-request isolation, copy, assignment,
  move, and unbind behavior;
- final package identity, three legal members, four runtime members, and
  reproducible package SHA-256.

The following are not claimed by this record unless a later checked-in evidence
entry says otherwise:

- native ONNX Runtime sanitizer tests or unit suites beyond the seven focused
  `RunTerminationFlagTest.*` cases;
- ONNX Runtime browser/WebDriver unit tests;
- a headed real-Kokoro cancellation latency benchmark;
- LineLight's complete repository checks or hosted CI.

## Reproduce

Run from the LineLight repository root with the pinned tool versions above. The
source directory supplied to `reproduce-build.sh` must not already exist.

```bash
issue55_scratch=$(mktemp -d)
git clone https://github.com/microsoft/vcpkg.git "$issue55_scratch/vcpkg"
git -C "$issue55_scratch/vcpkg" checkout --detach \
  b02e341c927f16d991edbd915d8ea43eac52096c

vendor/onnxruntime-web/reproduce-build.sh \
  "$issue55_scratch/onnxruntime" \
  vendor/onnxruntime-web/onnxruntime-89f8206-live-cancellation.patch \
  "$issue55_scratch/vcpkg" \
  "$issue55_scratch/artifacts"

vendor/onnxruntime-web/finalize-package.sh \
  "$issue55_scratch/onnxruntime" \
  "$issue55_scratch/artifacts"
```

The Wasm builds use these shared flags:

```text
--parallel --use_vcpkg --config Release --skip_submodule_sync --build_wasm
--enable_wasm_simd --enable_wasm_threads --target onnxruntime_webassembly
--skip_tests --enable_wasm_api_exception_catching --disable_rtti
```

`--skip_tests` belongs to these Wasm artifact builds; it is not evidence that a
native test target ran. The JSEP build additionally uses `--use_jsep --use_webnn`.
The reproduction script then installs the JavaScript packages, runs the web
prebuild/lint/format checks, assigns the exact dev package version, and packs
from the explicit `js/web` working directory. The finalizer adds and verifies
the legal members and prints the four runtime hashes and final package hash.

## SPDX composition record

Do not hand-edit `sbom.spdx.json`. The retained document was generated only
after the final tarball was installed in LineLight's root manifest and lockfile
through this exact spec:

```text
file:vendor/onnxruntime-web/onnxruntime-web-1.22.0-dev.20250409-89f8206ba4.tgz
```

The generator fails unless it can prove all of the following:

- exact upstream HEAD, exact patch hash, and byte-identical postimages for all
  24 patch paths reconstructed in a temporary Git index;
- only six checksum-pinned version mutations and three exact legal additions
  outside those patch paths;
- exact, clean recursive submodule gitlinks;
- exact vcpkg tool, registry configuration, per-build registry locks, linker
  response files, ownership lists, dependency files, per-port SPDX data, and
  installed copyright files;
- exact local dependency specs in LineLight's root manifest and root lock
  entry, plus tarball SHA-512 lock integrity;
- the complete six-name direct JavaScript dependency set; and
- byte identity between every retained threaded runtime source output and its
  npm member.

Native SBOM scope is the union of vcpkg archives named on both final link lines
and vcpkg-owned headers included by linked object targets. The two builds must
agree on source/license identity, while their configuration-specific ABI and
SPDX hashes remain separately recorded. SafeInt 3.0.28 is the sole selected
component whose generated vcpkg record lacks a conclusion; its standard MIT
text is accepted only through the exact version and copyright-file SHA-256 in
`sbom-license-conclusions.json`.

## Licensing and privacy

ONNX Runtime and LineLight's modifications are provided under the MIT License
in `LICENSE`. `ThirdPartyNotices.txt` retains the complete upstream component
inventory. `LINELIGHT-NOTICE.txt` prominently identifies the modified package,
upstream commit, patch digest, modification date, and purpose. The same upstream
third-party notice is deployed unchanged by LineLight at
`public/offline-voice-third-party-notices.txt`, while the offline voice license
page carries the complete MIT text and modification notice.

The runtime remains inside LineLight's private Offline natural boundary. Once
the voice pack is prepared, synthesis uses local narration text and cached model
assets. Cooperative cancellation adds same-origin atomic control state; it does
not add a network endpoint or upload document or narration data.

## Operational limits

- Cancellation is observed at ONNX Runtime executor checkpoints, not inside an
  arbitrarily long operator kernel.
- The mailbox supports LineLight's serialized inference invariant; it is not an
  arbitrary concurrent-session cancellation API.
- A bounded LineLight watchdog still replaces a worker that does not produce a
  terminal acknowledgment. Recovery may use only already-prepared Cache Storage
  assets.
- The `SharedArrayBuffer` is an opt-in trusted same-origin control plane, not a
  security boundary against other same-origin code.
- Maintaining a modified runtime requires repeating the exact build, package,
  license, SBOM, security, and browser acceptance review for every update.
