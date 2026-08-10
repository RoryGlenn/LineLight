# LineLight codebase index

This index maps product concepts to the code that owns them. It is intended for
contributors and coding agents who need to answer five questions before making
a change:

1. Which runtime owns the behavior?
2. Which files define its contracts and invariants?
3. What state or network boundary does it touch?
4. Which neighboring components must be reviewed with it?
5. Which checks provide evidence that the change still works?

The index is deliberately curated rather than generated from imports. LineLight
uses browser workers, a service worker, Cache Storage, route strings, and build
rewrites that are not represented by a normal module graph. Keep descriptions
at the ownership and invariant level. Link to source constants instead of
copying fast-moving byte counts, versions, timings, or asset hashes here.

When a change adds a first-party module, moves responsibility between modules,
alters a runtime or storage boundary, or changes the relevant verification,
update the affected entry in the same pull request.

## Runtime vocabulary

- **Browser main:** React, EPUB/text parsing, reader state, media playback,
  lightweight PDF bitmap composition and DOM text measurement, and browser
  storage coordination in the page's main execution context.
- **Dedicated worker:** CPU- or GPU-intensive offline narration, local
  audiobook transcription, and the app-owned PDF document pipeline, isolated
  from the browser main thread. The PDF document worker creates a nested PDF.js
  worker for parser internals.
- **Service worker:** installable-app and immutable runtime-asset caching.
- **Edge worker:** Cloudflare/vinext request routing, response headers, model
  asset delivery, and Azure token exchange.
- **Node tooling:** build, dependency audit, artifact validation, tests, and
  local voice-review commands.

## Domain map

- [Application shell and reader orchestration](#application-shell-and-reader-orchestration)
- [Document ingestion and page rendering](#document-ingestion-and-page-rendering)
- [Local library, navigation, and reader layout](#local-library-navigation-and-reader-layout)
- [Narration control, device speech, and Azure](#narration-control-device-speech-and-azure)
- [Offline natural narration and voice-pack lifecycle](#offline-natural-narration-and-voice-pack-lifecycle)
- [Prepared narration, WAV export, and audiobook sync](#prepared-narration-wav-export-and-audiobook-sync)
- [PWA caching and browser runtime isolation](#pwa-caching-and-browser-runtime-isolation)
- [Edge routes and deployment assembly](#edge-routes-and-deployment-assembly)
- [Offline voice quality review](#offline-voice-quality-review)
- [Build, dependency security, and repository validation](#build-dependency-security-and-repository-validation)
- [Inactive and opt-in starter surfaces](#inactive-and-opt-in-starter-surfaces)

## Application shell and reader orchestration

**Purpose:** Present the reader, coordinate document and narration state, and
connect the focused reading surface, PDF page surface, settings, library, and
navigation controls.

**Runtime:** Browser main.

**Owns:** [`app/page.tsx`](../app/page.tsx) is the application coordinator and
owns settings restoration, active-word state, import flow, narration session
lifecycle, follow behavior, and most user actions.
[`app/highlight-scope.mjs`](../app/highlight-scope.mjs) owns the canonical
sentence/paragraph setting, deterministic legacy migration, and visual-region
derivation while exact-token state remains internal for seeking and navigation.
[`app/document-model.mjs`](../app/document-model.mjs) owns the shared Focus and
narration token/segment model, including the explicit PDF-only structural
paragraph boundary option. [`app/layout.tsx`](../app/layout.tsx) owns root metadata and global style
loading. [`app/globals.css`](../app/globals.css) owns the visual system and reader
geometry. [`app/focus-document-view.tsx`](../app/focus-document-view.tsx) renders
reflowed continuous sentence/paragraph regions through bounded range
virtualization, an incremental accessible feed, and localized imperative scope
updates, while
[`app/document-outline.tsx`](../app/document-outline.tsx) renders the PDF
contents tree.

**Entry points:** The default application route is
[`app/page.tsx`](../app/page.tsx), mounted by
[`app/layout.tsx`](../app/layout.tsx). The two document surfaces are
[`app/focus-document-view.tsx`](../app/focus-document-view.tsx) and
[`app/pdf-page-view.tsx`](../app/pdf-page-view.tsx).

**Change together:** Reader state changes generally require a
review of the local-library and navigation modules. Narration controls require
a review of shared speech utilities and the selected engine. Rendering changes
must consider virtualization, follow scrolling, and the corresponding CSS.

**State and I/O:** The coordinator persists settings, per-document progress, and
the selected view in `localStorage`; document and navigation records belong to
IndexedDB through the local-library module. Imported document content must stay
in browser-owned storage unless a user explicitly selects Azure narration for a
short passage.

**Verification:** Use
[`tests/rendered-html.test.mjs`](../tests/rendered-html.test.mjs) for packaged
markup and artifact-level assertions. Domain-specific behavior is covered by
the reader, parser, narration, and service-worker tests linked below. Visual,
focus, keyboard, and browser media changes still need a real-browser check. The
scope contract and migration are covered by
[`tests/highlight-scope.test.mjs`](../tests/highlight-scope.test.mjs).

## Document ingestion and page rendering

**Purpose:** Convert PDF, EPUB, and text files into the common ordered word
model, then render either reflowed content or the original PDF page while
preserving navigation and highlighting indices.

**Runtime:** Browser main for React, visible bitmap composition, PDF.js DOM
`TextLayer`, and bounded `Range` measurement; an app-owned dedicated PDF worker
for source conversion, extraction, semantic mapping, page persistence, outline
construction, and supported `OffscreenCanvas` rasterization; plus the nested
PDF.js parser worker. Pages requiring DOM-only PDF filters use a cooperative,
visible-page-only main-thread fallback.

**Owns:** PDF session orchestration lives in [`app/page.tsx`](../app/page.tsx),
while [`app/pdf-document.ts`](../app/pdf-document.ts) owns the job/revision
client and [`app/pdf-document.worker.ts`](../app/pdf-document.worker.ts) owns
the progressive document pipeline.
[`app/pdf-parser.worker.ts`](../app/pdf-parser.worker.ts) is the first-party
nested-worker bootstrap that imports PDF.js and exposes its parser protocol.
[`app/pdf-worker-filters.mjs`](../app/pdf-worker-filters.mjs) implements the
worker-safe alpha/luminosity soft-mask pixel transforms (including soft-mask
alpha transfer maps) used by supported OffscreenCanvas pages.
[`app/pdf-document-types.ts`](../app/pdf-document-types.ts) defines the
serializable worker/storage contract;
[`app/pdf-document-protocol.mjs`](../app/pdf-document-protocol.mjs) owns
cancellation, stale-message disposal, first-page milestones, parser-ready
gating, and truthful terminal outcomes; and
[`app/pdf-raster-scheduler.mjs`](../app/pdf-raster-scheduler.mjs) owns
single-flight raster serialization.
[`app/pdf-document-model.mjs`](../app/pdf-document-model.mjs) builds page-local
semantic chunks that preserve the shared global indices and reconciles each
page's current worker-queue priority without retaining stale visibility; the
first fallback signal closes that revision's worker raster queue immediately,
[`app/pdf-raster-scale.mjs`](../app/pdf-raster-scale.mjs) maps responsive page
geometry, device-pixel ratio, and pinch zoom to bounded physical-pixel raster
targets and the visible/adjacent preview policy,
[`app/pdf-fallback-scheduler.mjs`](../app/pdf-fallback-scheduler.mjs) serializes
and cancels the document-scoped main-thread fallback queue,
[`app/pdf-page-store.mjs`](../app/pdf-page-store.mjs) is the paged external UI
store and count-plus-pixel-budgeted bitmap cache, and
[`app/pdf-progressive-navigation.mjs`](../app/pdf-progressive-navigation.mjs)
keeps late progress, outline, and bookmark destinations pending until their
chunk exists. [`app/pdf-terminal-reconciliation.mjs`](../app/pdf-terminal-reconciliation.mjs)
prevents delayed terminal storage reads from replacing a newer document. The
shared non-PDF token model lives in [`app/document-model.mjs`](../app/document-model.mjs).
[`app/epub-parser.mjs`](../app/epub-parser.mjs) owns EPUB container, package,
spine, metadata, and chapter extraction.
[`app/pdf-text-model.mjs`](../app/pdf-text-model.mjs) owns reversible displayed
glyph-to-narration-token mapping, line-end dehyphenation, continuous
sentence/paragraph line geometry derived from one measured segment pass, and
the persisted PDF text-model version/migration contract. Legacy PDF records are
rebuilt locally from their stored bytes; no network source or manual re-import
is used.
[`app/pdf-page-view.tsx`](../app/pdf-page-view.tsx) owns true range-virtualized
canvas pages, progressive preview-to-sharp bitmap upgrades across responsive
size, DPR, and visual-viewport changes, releases raster backing outside the
actual viewport while retaining measured text/highlight shells, and owns the
visible/adjacent/cancel worker state plus the visible-page fallback.
[`app/pdf-outline.mjs`](../app/pdf-outline.mjs)
maps PDF destinations to document token indices.
[`app/reader-virtualization.mjs`](../app/reader-virtualization.mjs) selects the
bounded page and paragraph render windows and notifies only the PDF or Focus
shells whose rendered state changes.

**Entry points:** File selection enters the import functions in
[`app/page.tsx`](../app/page.tsx); EPUB files delegate to
[`app/epub-parser.mjs`](../app/epub-parser.mjs). Page view enters through
[`app/pdf-page-view.tsx`](../app/pdf-page-view.tsx), and its contents sidebar
enters through [`app/document-outline.tsx`](../app/document-outline.tsx).

**Change together:** Any tokenization or cleanup change must be
reviewed against PDF `wordStart` values, outline destinations, narration
boundary offsets, stored progress recovery, and both reader views. Page geometry
changes must be reviewed with [`app/globals.css`](../app/globals.css), follow
scrolling in the coordinator, and virtualization.

**State and I/O:** User-selected PDFs are transferred directly to the document
worker and never uploaded. IndexedDB v7 stores one local source `Blob`, a
lightweight manifest, and independently keyed page text/layout/model records;
page one commits and publishes its semantic model before initial rasterization
or background extraction. Ready documents stream page one directly and then
bounded batches, and v3 documents migrate lazily while their recoverable record
remains intact. The main thread retains the progressive semantic reader model,
bounded page selectors, and worker bitmaps bounded by both count and total
physical pixels, with temporary overflow only for pinned visible pages. Browser
evidence uses actual worker bitmap ordering as the page-priority gate;
transparent measured overlay and background-shell timings remain diagnostic.

**Verification:** Parser and ordering behavior is covered by
[`tests/epub-parser.test.mjs`](../tests/epub-parser.test.mjs) and
[`tests/pdf-outline.test.mjs`](../tests/pdf-outline.test.mjs). Render-window
selection is covered by
[`tests/reader-virtualization.test.mjs`](../tests/reader-virtualization.test.mjs).
Incremental semantic equivalence, worker protocol ordering, parser readiness,
current-state queue reprioritization, active cancellation, stale bitmap
disposal, and confirmed terminal outcomes are covered by
[`tests/pdf-document-model.test.mjs`](../tests/pdf-document-model.test.mjs).
Bounded external-store selectors and bitmap disposal are covered by
[`tests/pdf-page-store.test.mjs`](../tests/pdf-page-store.test.mjs); late
lower-resolution rejection is covered there, while responsive physical-pixel
targets, zoom handling, integer canvas caps, and visible/adjacent request policy
are covered by
[`tests/pdf-raster-scale.test.mjs`](../tests/pdf-raster-scale.test.mjs).
Fallback serialization and cancellation are covered by
[`tests/pdf-fallback-scheduler.test.mjs`](../tests/pdf-fallback-scheduler.test.mjs),
and [`tests/pdf-raster-lifecycle.test.mjs`](../tests/pdf-raster-lifecycle.test.mjs)
locks the viewport ownership, document-revision reset, retry, and worker recovery
integration points. Late
progress/outline/bookmark targets and explicit playback races are covered by
[`tests/pdf-progressive-navigation.test.mjs`](../tests/pdf-progressive-navigation.test.mjs);
and generation-safe terminal UI reconciliation is covered by
[`tests/pdf-terminal-reconciliation.test.mjs`](../tests/pdf-terminal-reconciliation.test.mjs).
Worker filter pixel math is covered by
[`tests/pdf-worker-filters.test.mjs`](../tests/pdf-worker-filters.test.mjs).
Shared sentence behavior, including unchanged TXT/EPUB paragraph navigation,
is covered by [`tests/document-model.test.mjs`](../tests/document-model.test.mjs).
Normalized token mapping, dehyphenation, and multi-font, ligature, rotated, and
multi-column highlight geometry fixtures are covered by
[`tests/pdf-text-model.test.mjs`](../tests/pdf-text-model.test.mjs).
The deterministic real-PDF fixture at
[`tests/fixtures/pdf-highlights/issue-60-geometry.pdf`](../tests/fixtures/pdf-highlights/issue-60-geometry.pdf)
is owned by
[`scripts/generate-pdf-highlight-fixture.mjs`](../scripts/generate-pdf-highlight-fixture.mjs).
[`scripts/run-pdf-highlight-browser-regression.mjs`](../scripts/run-pdf-highlight-browser-regression.mjs)
drives Brave through CDP to check measured overlays across zoom/DPR, visual
scenarios, localized shell updates, DOM mutations, and Long Tasks; its fast
contract and opt-in real-browser gate live in
[`tests/pdf-highlight-browser-harness.test.mjs`](../tests/pdf-highlight-browser-harness.test.mjs).
[`scripts/run-highlight-scope-browser-regression.mjs`](../scripts/run-highlight-scope-browser-regression.mjs)
records headed-Brave Sentence and Paragraph visuals in Focus and Page views,
exact-token click behavior, settings migration/persistence, document switching,
narration navigation, stable shell identity, DOM mutations, and Long Tasks. Its
fast contract and opt-in real-browser gate live in
[`tests/highlight-scope-browser-harness.test.mjs`](../tests/highlight-scope-browser-harness.test.mjs),
with review records in [`docs/evidence/issue-62/`](evidence/issue-62/).
[`scripts/run-offline-natural-timing-regression.mjs`](../scripts/run-offline-natural-timing-regression.mjs)
attaches to a disposable headed-Brave profile with the stored local voice pack
and verifies consecutive PDF highlight updates at 0.75x, 1x, and 1.25x against
the real Offline-natural worker. Its optional `--voice` gate selects and records
the exact voice under test through the current settings UI, and its fixture
import targets the PDF input only after that panel closes so audiobook timing
sidecars cannot capture the test file. Its thresholds and opt-in CDP gate live in
[`tests/offline-natural-timing-harness.test.mjs`](../tests/offline-natural-timing-harness.test.mjs),
with review records in
[`docs/evidence/issue-60/`](evidence/issue-60/).
[`scripts/run-pdf-worker-browser-regression.mjs`](../scripts/run-pdf-worker-browser-regression.mjs)
runs the built Cloudflare Worker and ASSETS artifact locally through Wrangler,
directly verifies origin COOP/COEP/CORP and WebAssembly MIME headers without a
service worker, then opens headed Brave against the supplied 359-page PDF. It
records first-page ordering, Window Long Tasks, control latency, attached worker
network traffic, resumable cancellation/replacement state, screenshots, and a
DevTools trace. Review records live in
[`docs/evidence/issue-56/`](evidence/issue-56/).
[`scripts/run-pdf-sharpness-browser-regression.mjs`](../scripts/run-pdf-sharpness-browser-regression.mjs)
builds and serves one clean source commit, then uses headed Brave to pair the
same local PDF page in the browser viewer and LineLight across desktop DPR,
effective browser-zoom metrics, mobile DPR, and visual-viewport pinch. It
requires decoded reference pixels to prove a rendered page, and records
independently recomputed preview-to-sharp backing targets, current viewport
priority, bitmap/canvas
budgets, offscreen release, identity-bound serialized fallback
failure/retry/cancellation, per-scenario measured narration alignment, Long
Tasks, per-scenario document/parser worker traffic settled to a network-quiet
fixed point, exact source/screenshot manifests, and owned-process teardown.
The independently testable acceptance contract lives in
[`scripts/pdf-sharpness-evidence.mjs`](../scripts/pdf-sharpness-evidence.mjs),
its fast and opt-in browser gates live in
[`tests/pdf-sharpness-browser-harness.test.mjs`](../tests/pdf-sharpness-browser-harness.test.mjs),
and review records belong in
[`docs/evidence/issue-68/`](evidence/issue-68/).
The packaged page is checked by
[`tests/rendered-html.test.mjs`](../tests/rendered-html.test.mjs). PDF geometry,
complex reading order, and highlight alignment require representative browser
PDFs in addition to unit tests.

## Local library, navigation, and reader layout

**Purpose:** Keep imported documents, library metadata, bookmarks, bounded jump
history, progress recovery, search, and reading-layout preferences private to
the device.

**Runtime:** Browser main.

**Owns:** [`app/reader-library.mjs`](../app/reader-library.mjs) owns the versioned
IndexedDB schema, migrations, document records, library entries, active-document
state, per-document navigation records, the PDF source/page stores, prepared
narration manifests/chunks/metadata, and audiobook manifests/source
blobs/transcript windows with document-scoped cleanup. PDF storage retains its
revision-guarded staging, completion, and recovery behavior.
[`app/prepared-narration.mjs`](../app/prepared-narration.mjs) owns the versioned
offline narration profile key, whole-book resumable manifest, independent
compression, storage estimate, bounded source-text fingerprint, and strict
stored audio/timing record validation. Audiobook record validation belongs to
[`app/audiobook-alignment.mjs`](../app/audiobook-alignment.mjs).
[`app/reader-navigation.mjs`](../app/reader-navigation.mjs) owns contextual
position snapshots, recovery after text changes, bounded history, and document
word search. [`app/reader-layout.mjs`](../app/reader-layout.mjs) owns layout
normalization, CSS values, and focus-window selection.
[`app/reader-virtualization.mjs`](../app/reader-virtualization.mjs) owns bounded
render windows and placeholder sizing.

**Entry points:** The browser singleton exported by
[`app/reader-library.mjs`](../app/reader-library.mjs) is the persistence entry
point used by [`app/page.tsx`](../app/page.tsx). Navigation and layout helpers
are pure functions called by that coordinator and the two document views.

**Change together:** IndexedDB changes require explicit upgrade
and lifecycle coverage. Position-shape changes must update navigation cleanup in
the coordinator and remain recoverable against tokenized documents. Layout
changes must be reviewed with focus rendering, virtualization estimates, and
the CSS variables that consume them.

**State and I/O:** Documents, library metadata, active-document identity,
navigation records, PDF sources, keyed PDF pages, exact-profile narration
manifests/chunks, audiobook files, transcript windows, and sync anchors live in
IndexedDB. Automatically retained WAV chunks use a bounded recent-cache policy;
explicit whole-book preparation has a reserved distinct retention class and
stores audio separately from export metadata.
Settings, progress, and view selection remain in `localStorage` under the
coordinator. Removing a document must clean every owned record without
affecting other local documents; interrupted PDFs remain explicit resumable
revisions rather than orphaned anonymous pages.

**Verification:** Use
[`tests/reader-library.test.mjs`](../tests/reader-library.test.mjs) for schema,
migration, prepared-audio cleanup, and lifecycle behavior;
[`tests/prepared-narration.test.mjs`](../tests/prepared-narration.test.mjs) for
profile identity, source fingerprints, and stored-chunk validation;
[`tests/audiobook-alignment.test.mjs`](../tests/audiobook-alignment.test.mjs)
for audiobook record, window, alignment, and confidence contracts;
[`tests/reader-navigation.test.mjs`](../tests/reader-navigation.test.mjs) for
snapshots, recovery, history, and search; and
[`tests/reader-layout.test.mjs`](../tests/reader-layout.test.mjs) plus
[`tests/reader-virtualization.test.mjs`](../tests/reader-virtualization.test.mjs)
for layout and render-window behavior.

## Narration control, device speech, and Azure

**Purpose:** Turn document tokens into bounded speech passages, keep the active
word synchronized with playback, provide instant in-buffer seeking, and route
requests to device, offline, audiobook, or Azure narration without silently
changing the reader's privacy choice.

**Runtime:** Browser main for scheduling and playback; edge worker for Azure
authorization; the operating system or browser may own device-voice synthesis.

**Owns:** Device narration and engine coordination currently live in
[`app/page.tsx`](../app/page.tsx).
[`app/speech-utils.mjs`](../app/speech-utils.mjs) owns passage boundaries,
timed-boundary lookup, sentence navigation, buffered seek offsets, and device
error classification. [`app/speech-prefetch.mjs`](../app/speech-prefetch.mjs)
owns the bounded preparation queue and audio cache.
[`app/prepared-narration.mjs`](../app/prepared-narration.mjs) binds durable
offline chunks to an exact model, voice, pace, token range, and source-text
fingerprint before reuse.
[`app/narration-defaults.mjs`](../app/narration-defaults.mjs) owns engine defaults
and fallback policy; [`app/narration-readiness.mjs`](../app/narration-readiness.mjs)
owns monotonic readiness presentation; and
[`app/narrator-presets.mjs`](../app/narrator-presets.mjs) owns named settings
presets. [`app/azure-speech.ts`](../app/azure-speech.ts) owns Azure client token
acquisition, SDK synthesis, and exact word-boundary capture.
[`worker/speech-token.ts`](../worker/speech-token.ts) owns the server-side Azure
token exchange.

**Entry points:** Play and navigation actions enter the narration functions in
[`app/page.tsx`](../app/page.tsx). Shared passage scheduling enters
[`app/speech-utils.mjs`](../app/speech-utils.mjs) and
[`app/speech-prefetch.mjs`](../app/speech-prefetch.mjs). Azure browser requests
enter [`app/azure-speech.ts`](../app/azure-speech.ts) and call the edge route
implemented by [`worker/speech-token.ts`](../worker/speech-token.ts).

**Change together:** Passage shapes and offsets must remain
consistent with the document token model and all four engines. Queue changes
must preserve cancellation, pause/resume, seek, audio disposal, and the
one-passage lookahead bound. Azure changes require synchronized browser and
edge contracts. Engine fallback must respect the policy in narration defaults.

**State and I/O:** Voice, engine, rate, and preset selections are local settings.
Matching Offline-natural chunks generated for saved books are retained with
their timing boundaries in browser-owned IndexedDB and removed with the book.
Device narration uses the Web Speech API. Azure sends only the current short
passage and one prepared-ahead passage after obtaining a short-lived token from
`/api/speech/token`; credentials are supplied through the variables documented
in [`.env.example`](../.env.example) and stay on the edge worker.

**Verification:** Use
[`tests/speech-utils.test.mjs`](../tests/speech-utils.test.mjs),
[`tests/speech-prefetch.test.mjs`](../tests/speech-prefetch.test.mjs),
[`tests/prepared-narration.test.mjs`](../tests/prepared-narration.test.mjs),
[`tests/narration-readiness.test.mjs`](../tests/narration-readiness.test.mjs), and
[`tests/narrator-presets.test.mjs`](../tests/narrator-presets.test.mjs). Device
boundary behavior, browser audio startup, and the live Azure SDK/token route
still require focused browser or integration checks because they do not have a
complete deterministic unit harness.

## Offline natural narration and voice-pack lifecycle

**Purpose:** Install, validate, retain, load, synthesize, update, and remove the
private native-44.1 kHz Supertonic 3 voice pack with one reviewed female voice
(`F4`, warm and conversational) and one reviewed male voice (`M2`, deep and
grounded) while supporting WebGPU, threaded WebAssembly, a single-thread
fallback, resumable downloads, and safe cleanup of retired voice caches. The
two styles were selected locally against the supplied reference recording with
reference-similarity, naturalness, intelligibility, and signal-quality checks.
The male selection uses a robust approximately 91 Hz reference pitch rather
than the rejected harmonic estimate. The private recording is never a runtime
or repository asset.

**Runtime:** Browser main for worker ownership and status; dedicated worker for
download validation, ONNX initialization, and synthesis; edge worker for pinned
first-party model delivery.

**Owns:** [`app/offline-speech-config.ts`](../app/offline-speech-config.ts) derives
browser cache and voice URLs from the canonical model manifest.
[`app/offline-model-manifest.mjs`](../app/offline-model-manifest.mjs) owns pinned
model identity, files, sizes, routes, backend selection, dtype selection, and the
ready-marker identity. [`app/offline-model-cache.mjs`](../app/offline-model-cache.mjs)
owns strict artifact deletion, ready-marker operations, legacy cache helpers,
and retention of emitted worker/WASM runtime assets.
[`app/offline-pack-installer.mjs`](../app/offline-pack-installer.mjs) owns
verified range downloads, resumption, assembly, and cache writes.
[`app/offline-preparation.mjs`](../app/offline-preparation.mjs) owns preparation
policy, storage headroom, adaptive passage sizing, and progress mapping.
[`app/offline-speech.ts`](../app/offline-speech.ts) owns the page-side worker RPC,
readiness state, backend retry ladder, cooperative-cancellation integration,
bounded unacknowledged-run recovery, Web Lock serialization, and public pack
operations. [`app/offline-run-cancellation.mjs`](../app/offline-run-cancellation.mjs)
owns the small page-side shared-memory mailbox contract, validates worker epoch
and run generations, retains cancellation intent through terminal
acknowledgment, and deliberately has no ONNX Runtime import.
[`app/onnxruntime-web-types.d.ts`](../app/onnxruntime-web-types.d.ts) points
TypeScript at the pinned package's own reviewed declarations because its
runtime export map omits a `types` condition; it must stay aligned with the
bundled package and cancellation bridge.
[`app/worker-startup-diagnostics.mjs`](../app/worker-startup-diagnostics.mjs)
owns bounded, local-only worker failure details without serializing document or
narration data. [`app/offline-speech.worker.ts`](../app/offline-speech.worker.ts) owns
model installation, four-session ONNX initialization, warm-up, synthesis,
pronunciation-weighted boundary generation, runtime fallback, and commit
ordering. [`app/supertonic-runtime.mjs`](../app/supertonic-runtime.mjs) owns
reviewed text preprocessing, bounded segmentation, Supertonic inference, voice
style validation, and native 44.1 kHz PCM-16 WAV encoding. The worker publishes
ONNX run start/end generations only for
multi-threaded WebAssembly, bridges cancellation to the modified runtime, and
returns a terminal cancellation acknowledgment without disposing a healthy
warm session.
[`app/offline-speech-utils.mjs`](../app/offline-speech-utils.mjs) owns backend
error classification, strict waveform validation, bounded punctuation-only
token-shape recovery, and approximate word timing. Exhausting those local
recovery shapes stays request-local rather than restarting the same model
through the backend ladder.
[`app/phonemizer-runtime.ts`](../app/phonemizer-runtime.ts) preserves the
phonemizer's prebuilt runtime interface. [`worker/offline-model.mjs`](../worker/offline-model.mjs)
serves only allowlisted pinned model files.

**Entry points:** UI install, initialize, synthesize, and remove calls enter
[`app/offline-speech.ts`](../app/offline-speech.ts), which creates
[`app/offline-speech.worker.ts`](../app/offline-speech.worker.ts). Model requests
use the allowlisted `/offline-model/` route implemented by
[`worker/offline-model.mjs`](../worker/offline-model.mjs).

**Change together:** Treat the manifest, cache adapter,
installer, main-thread RPC, worker protocol, service worker, model route, and
artifact validation as one compatibility boundary. The install transaction
downloads every exact-size graph and required voice style, validates and warms
44.1 kHz audio, retains the emitted worker and WASM assets, writes and verifies
the ready marker, and only then removes the former ten-voice and Kokoro caches.
Installation and removal must remain serialized. A WebGPU
failure advances through the applicable fresh WASM tiers: isolated, capable
contexts try threaded WASM before single-thread, while other contexts go
directly to single-thread WASM. Changes to active-run cancellation must keep the
page mailbox, worker protocol, bundled ONNX Runtime patch, and direct
Supertonic session runner compatible. Cancellation applies only when the
selected backend is
multi-threaded WebAssembly; WebGPU and single-thread WebAssembly keep their
request-boundary behavior even if shared memory happens to be available.

**State and I/O:** Model and setup assets use a dedicated browser Cache Storage
cache; voice styles use a second cache; resumable ranges remain verified cache
entries until assembly. Runtime worker and WASM assets are
retained in the stable asset cache. Installation may access only LineLight's
pinned model route and bundled assets. Once installed, synthesis consumes local
text and local cached assets. The worker forwards the same-origin shared Wasm
memory reference and two reviewed mailbox indices; the page helper reads or
writes only the two atomic run-generation cells and does not copy narration
text or document content into the protocol. The distributed model and runtime
license text is
[`public/offline-voice-license.txt`](../public/offline-voice-license.txt), and
the complete Supertonic model and reference-source licenses are
[`public/supertonic-model-license.txt`](../public/supertonic-model-license.txt)
and
[`public/supertonic-source-license.txt`](../public/supertonic-source-license.txt).
The exact upstream runtime component notices are
[`public/offline-voice-third-party-notices.txt`](../public/offline-voice-third-party-notices.txt).

**Verification:** Use
[`tests/offline-model.test.mjs`](../tests/offline-model.test.mjs) for manifest,
backend, cache, worker, route, and artifact contracts;
[`tests/supertonic-runtime.test.mjs`](../tests/supertonic-runtime.test.mjs) for
native sample rate, text/style validation, inference feeds, and WAV encoding;
[`tests/offline-pack-installer.test.mjs`](../tests/offline-pack-installer.test.mjs)
for resumable storage behavior;
[`tests/offline-preparation.test.mjs`](../tests/offline-preparation.test.mjs) for
policy and progress; and
[`tests/offline-speech-utils.test.mjs`](../tests/offline-speech-utils.test.mjs)
for audio and timing helpers.
[`tests/offline-run-cancellation.test.mjs`](../tests/offline-run-cancellation.test.mjs)
covers mailbox validation, epochs, generations, terminal acknowledgment,
watchdog state, and the threaded-WASM-only page/worker boundary.
[`tests/offline-speech-recovery.test.mjs`](../tests/offline-speech-recovery.test.mjs)
executes worker-timeout replacement, live-request replay, stale-message
isolation, and installed-cache reuse against the production speech module.
[`tests/onnxruntime-vendor.test.mjs`](../tests/onnxruntime-vendor.test.mjs)
binds the reviewed runtime archive, legal inventory, declarations, dependency
topology, cancellation exports, and initialized shared-memory protocol.
[`tests/offline-cancellation-harness.test.mjs`](../tests/offline-cancellation-harness.test.mjs)
keeps the headed evidence validator fail-closed across active-run identity,
Pause and CPU timing, far seek, timeout replay, fallback, network, artifact,
cleanup, and private-text gates. It binds prepared reuse to the exact completed
request and audio object while allowing only distinct later refills; preserves
the required model, voice, and current JSEP runtime cache subset while allowing
only manifest-retired runtime assets to disappear; distinguishes range-cache
keys with SHA-256 identities while retaining only their canonical,
query-free path; binds far-seek playback to the target request, worker, and
session by correlating the session-bearing run start with its otherwise
session-less success message; classifies the speech worker and same-URL
pthreads by exact target ancestry; and accepts only hashed, detached
service-worker attach races during
the deliberate unregister phase. Its worker-event schema rejects unknown or
raw-text fields, while owned-process CPU samples retain only exact-schema
numeric counters and a bounded browser-process role enum rather than command
lines, working directories, or profile paths. The recursive privacy gate
rejects unreviewed Unix, Windows, profile, and temporary-path strings anywhere
in the evidence. Final teardown proves the exact active speech roots and all
recursive pthread descendants detached through privacy-safe session-ancestry
hashes. Persisted console and uncaught-exception evidence contains only
privacy-safe category, phase, target class, severity, count, and digest fields
rather than raw arguments, and the gate requires zero console errors, runtime
exceptions, network failures (including canceled loads), or 4xx responses. The
matching production runner is
[`scripts/run-offline-cancellation-regression.mjs`](../scripts/run-offline-cancellation-regression.mjs);
it rebuilds a clean source commit, clones a prepared local profile, owns its
headed browser and server process groups, auto-attaches network inspection to
speech and pthread workers, and retains no narration text or profile path. The
worker-compatible phonemizer import is probed
by [`tests/helpers/phonemizer-worker-probe.mjs`](../tests/helpers/phonemizer-worker-probe.mjs).
Backend fallback, migration, offline restart, active-cancellation latency,
warm-session reuse, no-fetch recovery, and voice quality require the
corresponding real-browser records; a passing Issue #55 run writes its exact
source-bound JSON under `docs/evidence/issue-55/`. The headed production-browser
waveform, recovery-shape, onset-boundary, cache, and privacy gate for the
previous model is recorded in
[`docs/evidence/issue-70/offline-audio-recovery.json`](evidence/issue-70/offline-audio-recovery.json).

## Prepared narration, WAV export, and audiobook sync

**Purpose:** Make an exact offline voice/pace reusable for a complete book,
export portable bounded WAV parts with text timing, and synchronize a matching
DRM-free local audiobook without uploading book or audio content.

**Runtime:** Browser main coordinates jobs, IndexedDB, decoding, playback, and
file saves. Dedicated workers own Supertonic synthesis and Whisper transcription.
The edge worker streams only pinned public model assets.

**Owns:** [`app/prepared-narration.mjs`](../app/prepared-narration.mjs) owns
prepared profile identity, resumable manifest transitions, independent
gzip/identity chunk encoding, quota estimates, and exact chunk validation.
[`app/prepared-narration-export.mjs`](../app/prepared-narration-export.mjs)
owns RIFF/WAVE parsing, sequential duration/byte-bounded part planning, portable
filenames, word-anchor sidecars, cancellation, and exact-edition re-import
validation. [`app/timed-media.mjs`](../app/timed-media.mjs) owns the shared
manifest/anchor shape, confidence threshold, audio-to-text lookup, and
confidence-bounded text-to-audio interpolation.
[`app/audiobook-alignment.mjs`](../app/audiobook-alignment.mjs) owns DRM-free
format policy, natural chapter ordering, bounded overlapping windows, local
transcript-to-token alignment, mismatch reporting, resampling, resumable
manifest validation, and preservation of manual corrections.
[`app/audiobook-alignment-model.mjs`](../app/audiobook-alignment-model.mjs)
owns the pinned Whisper model identity and allowlisted same-origin paths.
[`app/audiobook-transcriber.ts`](../app/audiobook-transcriber.ts) owns page-side
worker RPC and termination-based cancellation;
[`app/audiobook-alignment.worker.ts`](../app/audiobook-alignment.worker.ts)
owns local-only q8 Whisper inference for one transferred PCM window.
[`worker/alignment-model.mjs`](../worker/alignment-model.mjs) owns the edge
model-file stream. The controls and job orchestration live in
[`app/page.tsx`](../app/page.tsx), and durable records live behind
[`app/reader-library.mjs`](../app/reader-library.mjs).

**Entry points:** Narration settings start, pause, resume, cancel, export,
sidecar verification, audiobook attachment/alignment, manual sentence sync, and
cleanup. Play and sentence navigation enter the common reader transport; a
ready prepared profile reuses the containing independent chunk, while an
audiobook uses only qualified or manual anchors for text seeking.
The built-in demo exposes the same render, replay, and export controls. Its fixed
text is registered as an unlisted document owner so exact-profile audio can
persist without creating a private-library entry.

**Change together:** Changes to token indices, chunk boundaries, sidecar fields,
or confidence rules must update preparation, export, audiobook alignment,
IndexedDB validation/migration, playback seeking, and all three focused test
suites. Model changes require an immutable revision, a minimal allowlist,
worker/runtime review, size/privacy copy, and edge-route tests. Never treat a
weak alignment as an exact word timestamp or add DRM circumvention.

**State and I/O:** Prepared audio is committed as independently playable,
optionally compressed WAV chunks plus audio-free metadata and a manifest keyed
by exact document fingerprint, model, voice, and generated pace. Export reads
one bounded part at a time and writes locally through the File System Access
API or browser downloads. Audiobook source `Blob`s, local transcript windows,
confidence-scored anchors, and manual corrections remain in book-scoped
IndexedDB records. A ready LineLight WAV sidecar can bypass ASR only when its
book fingerprint and ordered filenames match. Whisper model requests contain no
book text or audio; only pinned public files cross the network. Book and profile
removal clean their owned audio, metadata, transcript, and anchor records.
The built-in demo's narration records use the same local-only stores and exact
fingerprint checks as imported documents.

**Verification:** Use
[`tests/prepared-narration.test.mjs`](../tests/prepared-narration.test.mjs),
[`tests/prepared-narration-export.test.mjs`](../tests/prepared-narration-export.test.mjs),
[`tests/prepared-narration-ui.test.mjs`](../tests/prepared-narration-ui.test.mjs),
and [`tests/timed-media.test.mjs`](../tests/timed-media.test.mjs) for preparation,
WAV, sidecar, and shared seek contracts. Use
[`tests/audiobook-alignment.test.mjs`](../tests/audiobook-alignment.test.mjs),
[`tests/audiobook-worker.test.mjs`](../tests/audiobook-worker.test.mjs), and
[`tests/alignment-model.test.mjs`](../tests/alignment-model.test.mjs) for local
ASR, confidence, cancellation, route, and reader-wiring contracts.
[`tests/reader-library.test.mjs`](../tests/reader-library.test.mjs) establishes
atomic progress, per-profile cleanup, and cross-book isolation. Real codec
support, download prompts, long-running local inference, and audio output still
need representative browser checks.

## PWA caching and browser runtime isolation

**Purpose:** Make the app installable, retain immutable runtime assets for
offline reuse, and provide the isolation headers required for threaded ONNX
WebAssembly.

**Runtime:** Browser main for registration, service worker for caching, edge
worker for production response headers, and the Vite development server for
local response headers.

**Owns:** [`app/service-worker-registration.mjs`](../app/service-worker-registration.mjs)
owns environment-aware registration, idle deployment leases, last-client
release signals, low-frequency reconciliation for abruptly closed legacy tabs,
and the on-demand runtime-storage diagnostic request.
[`public/sw-v9.js`](../public/sw-v9.js) owns cache versioning, cache-first hashed
assets, asynchronous cache population, deployment/client ownership metadata,
safe pre-v9 migration, retired-hash pruning, and cache fallback for intercepted
same-origin non-document assets. It deliberately leaves document navigations to
the browser and network. [`build/sites-vite-plugin.ts`](../build/sites-vite-plugin.ts)
emits the complete content-hashed asset manifest used by those leases.
[`public/manifest.webmanifest`](../public/manifest.webmanifest)
owns install metadata and the installed icon declarations.
[`public/favicon.ico`](../public/favicon.ico) is the real 32-by-32 legacy icon
served at the conventional `/favicon.ico` route, while
[`public/favicon.svg`](../public/favicon.svg) is its scalable manifest peer.
[`worker/index.ts`](../worker/index.ts) owns production
COOP/COEP/CORP and WebAssembly content-type headers and serves the generated,
unversioned runtime manifest through the deployment asset binding, while
[`public/_headers`](../public/_headers) owns the complementary static-asset
header policy. [`vite.config.ts`](../vite.config.ts) supplies matching COEP and
CORP headers to source module workers that Vite serves directly during local
development and emits the local production address used by `npm start`; that
command runs the built Worker and asset binding through local Wrangler so its
document isolation matches deployment.

**Entry points:** [`app/page.tsx`](../app/page.tsx) invokes
[`app/service-worker-registration.mjs`](../app/service-worker-registration.mjs).
The browser loads [`public/sw-v9.js`](../public/sw-v9.js); production responses
pass through [`worker/index.ts`](../worker/index.ts), while local module-worker
requests pass directly through the development server configured in
[`vite.config.ts`](../vite.config.ts).

**Change together:** Service-worker cache changes must be
reviewed with offline runtime-asset retention, generated asset hashing, old
client compatibility, the build-emitted deployment manifest, response
streaming, and deployment headers. Unknown pre-lease clients must conservatively
block deletion; known clients protect their complete deployment until release
or reconciliation proves they have closed. Isolation changes must be tested on
the document, worker script, nested worker, and WASM paths, not only the HTML
response.

**State and I/O:** The service worker owns stable Cache Storage entries for
same-origin generated, non-document assets. It does not intercept page or
document navigations, so navigation availability remains the browser and
network's responsibility. Cache writes are optional and must stay off the
network-response critical path. Cleanup runs from an idle client message rather
than activation or narration startup. A separate metadata cache records the
current manifest and live deployment leases; diagnostics count only the stable
runtime cache and finite pre-v9 caches. The service worker never scans or
deletes the large model and voice caches or their validation receipt, although
offline narration retains its bundled worker and WASM assets in the runtime
cache.

**Verification:** Use
[`tests/service-worker.test.mjs`](../tests/service-worker.test.mjs) for lifecycle,
manifest completeness, old-client retention, last-client cleanup, interrupted
cleanup, bounded repeated deployments, byte diagnostics, cache ordering, and
failure behavior;
[`tests/rendered-html.test.mjs`](../tests/rendered-html.test.mjs) for packaged
registration, manifest routing, production headers, and development-server
worker headers; and
[`tests/offline-model.test.mjs`](../tests/offline-model.test.mjs) for runtime-asset
retention and worker-diagnostic contracts. Complete offline readiness still
requires a first-visit, restart, and network-disabled browser check; development
worker-header changes also require a fresh-profile browser smoke covering both
offline narration and PDF.js. The Issue #55 headed harness binds the web
manifest and ICO file to its source commit and rejects any observed 4xx,
including a missing `/favicon.ico`.

## Edge routes and deployment assembly

**Purpose:** Assemble the vinext application for Cloudflare, route model and
speech-token requests, serve generated assets, and apply production response
headers.

**Runtime:** Edge worker and Node tooling during build.

**Owns:** [`worker/index.ts`](../worker/index.ts) is the edge request router and
vinext entry point. [`worker/offline-model.mjs`](../worker/offline-model.mjs) owns
the pinned public Supertonic model proxy,
[`worker/alignment-model.mjs`](../worker/alignment-model.mjs) owns the pinned
Whisper alignment-model proxy, and
[`worker/speech-token.ts`](../worker/speech-token.ts) owns the Azure token route.
[`vite.config.ts`](../vite.config.ts) owns vinext/Cloudflare composition, local
bindings, the phonemizer alias, worker format, and development server settings.
[`build/sites-vite-plugin.ts`](../build/sites-vite-plugin.ts) stages the Sites
artifact, while [`next.config.ts`](../next.config.ts) and
[`postcss.config.mjs`](../postcss.config.mjs) provide framework build settings.
The hosting binding names consumed by Vite are stored in
[`.openai/hosting.json`](../.openai/hosting.json).

**Entry points:** Cloudflare invokes [`worker/index.ts`](../worker/index.ts).
Vite loads [`vite.config.ts`](../vite.config.ts), which composes vinext,
[`build/sites-vite-plugin.ts`](../build/sites-vite-plugin.ts), and the Cloudflare
plugin.

**Change together:** Route changes require synchronized browser
callers, edge environment types, headers, and artifact tests. Model routes must
stay tied to the canonical allowlist. Azure route changes must preserve secret
handling, request timeouts, and browser error contracts. Build-plugin changes
must be checked against the generated `dist` layout and Sites publishing flow.

**State and I/O:** The edge receives requests for the application, generated
assets, allowlisted public model files, and Azure tokens. It must never receive
imported documents. Azure credentials come from protected environment variables
described in [`.env.example`](../.env.example). The ASSETS binding serves the
application bundle; current product document storage does not use D1.

**Verification:** The production artifact and worker entry are exercised by
[`scripts/build-verified.sh`](../scripts/build-verified.sh),
[`scripts/validate-artifact.sh`](../scripts/validate-artifact.sh), and
[`tests/rendered-html.test.mjs`](../tests/rendered-html.test.mjs). Model route
contracts are covered by
[`tests/offline-model.test.mjs`](../tests/offline-model.test.mjs) and
[`tests/alignment-model.test.mjs`](../tests/alignment-model.test.mjs). Live binding,
header, and secret changes need a local Cloudflare or hosted smoke test.

## Offline voice quality review

**Purpose:** Screen narration recordings locally for signal problems,
naturalness, and optional English transcription differences without uploading
the user's audio.

**Runtime:** Node tooling plus a pinned local Python environment and external
`ffmpeg`/`uv` commands.

**Owns:** [`scripts/review-voice.mjs`](../scripts/review-voice.mjs) owns CLI
arguments, resumable model preparation, offline enforcement, normalization,
inference, and report orchestration.
[`scripts/lib/voice-review.mjs`](../scripts/lib/voice-review.mjs) owns WAV parsing,
signal measurements, word-error rate, result schema, and human-readable output.
[`scripts/utmos-score.py`](../scripts/utmos-score.py) owns local UTMOS inference.

**Entry points:** `npm run review:voice` invokes
[`scripts/review-voice.mjs`](../scripts/review-voice.mjs). Preparation and review
usage are documented in [`README.md`](../README.md).

**Change together:** Model revision, digest, schema, cache, or
offline-policy changes require synchronized CLI validation and documentation.
Scoring thresholds must not be presented as a substitute for human listening or
accessibility review.

**State and I/O:** Pinned review models and the isolated Python environment live
outside the repository in the user's cache directory. Preparation is the only
network-enabled phase; completed reviews force offline model loading and do not
upload recordings.

**Verification:** Use
[`tests/voice-review.test.mjs`](../tests/voice-review.test.mjs) for parsing,
metrics, reports, preparation integrity, offline behavior, and subprocess
handling. Important voice changes also require a human listening review.

## Build, dependency security, and repository validation

**Purpose:** Produce a reproducible Sites artifact, enforce supported runtime
and dependency policy, and provide the checks required before a pull request is
merged.

**Runtime:** Node tooling, shell tooling, and GitHub Actions.

**Owns:** [`package.json`](../package.json) owns the supported Node version,
direct dependencies, overrides, and command surface. [`.npmrc`](../.npmrc)
owns npm installation policy. [`eslint.config.mjs`](../eslint.config.mjs),
[`tsconfig.json`](../tsconfig.json), and
[`postcss.config.mjs`](../postcss.config.mjs) own lint, type, and CSS tooling.
[`scripts/install-ci.sh`](../scripts/install-ci.sh) owns bounded CI installation;
[`scripts/sites-env.sh`](../scripts/sites-env.sh) owns the Cloudflare-compatible
command environment; [`scripts/build-verified.sh`](../scripts/build-verified.sh)
owns serialized production builds; [`build/sites-vite-plugin.ts`](../build/sites-vite-plugin.ts)
packages Sites metadata and emits the deterministic client runtime-asset
manifest; and
[`scripts/validate-artifact.sh`](../scripts/validate-artifact.sh) owns packaged
worker/artifact assertions. [`scripts/audit-dependencies.mjs`](../scripts/audit-dependencies.mjs)
owns the narrow advisory allowlist enforced by CI.
[`scripts/apply-dependency-patches.mjs`](../scripts/apply-dependency-patches.mjs)
owns fail-closed, version-, integrity-, and digest-guarded patching of the
installed Transformers 3.8.1 files: queue-tail recovery in
`src/backends/onnx.js` and `dist/transformers.web.js`, plus exact cooperative
cancellation rethrow before input formatting or logging in `src/models.js` and
`dist/transformers.web.js`. The modified ONNX Runtime Web package, source patch,
pinned reproduction procedure, checksums, deterministic SBOM generator and
evidence plan, and upstream and modification notices live under
[`vendor/onnxruntime-web/`](../vendor/onnxruntime-web/README.md).
[`docs/dependency-security.md`](dependency-security.md) explains the reviewed
dependency posture. [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
owns required hosted checks. [`.gitignore`](../.gitignore) owns repository-local
generated and secret-file exclusions. [`AGENTS.md`](../AGENTS.md) and
[`app/AGENTS.md`](../app/AGENTS.md) own durable repository and reader-runtime
instructions for coding agents. The
[`ship-linelight-change` skill](../.agents/skills/ship-linelight-change/SKILL.md)
owns the repeatable change-to-validation workflow, while the
[`linelight_investigator` agent](../.codex/agents/linelight-investigator.toml)
owns read-only cross-runtime diagnosis.

**Entry points:** Contributors use the scripts in
[`package.json`](../package.json). GitHub invokes
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml), which installs,
audits, lints, type-checks, builds, tests, and validates the current change.
Codex discovers the instruction chain from `AGENTS.md`, the project skill from
`.agents/skills`, and the custom investigator from `.codex/agents`.

**Change together:** Dependency updates require lockfile,
override, audit-policy, compatibility, production-exposure, and artifact review.
Updates to Transformers or ONNX Runtime Web must also revalidate the guarded
patch inputs and review the distributed license notices. An ONNX Runtime Web
update additionally requires regenerating the bundled runtime from its pinned
source and refreshing its focused checksums and SBOM; a Transformers-only
install patch does not change those ONNX records.
Build-output changes require synchronized Sites staging and artifact validation.
Repository workflow belongs in [`CONTRIBUTING.md`](../CONTRIBUTING.md); developer
orientation belongs in [`README.md`](../README.md), this index, and
[`AGENTS.md`](../AGENTS.md). Keep agent instructions and skills concise, link to
this index instead of duplicating fast-changing architecture, and preserve the
investigator's read-only boundary.

**State and I/O:** Build state is written only to ignored local output directories
and the generated Sites artifact. Secrets belong in ignored `.env` files or
protected deployment variables. Dependency audit output is evaluated against a
small explicit development-only allowance rather than accepted wholesale.

**Verification:** Dependency policy is covered by
[`tests/dependency-audit-policy.test.mjs`](../tests/dependency-audit-policy.test.mjs)
and real-adapter compatibility by
[`tests/dependency-hardening.test.mjs`](../tests/dependency-hardening.test.mjs).
[`tests/dependency-patches.test.mjs`](../tests/dependency-patches.test.mjs)
covers the exact Transformers transformations, queue rejection isolation,
cancel-only early rethrow without input diagnostics, preservation of ordinary
error diagnostics and recovery, idempotence, and fail-closed tamper behavior.
Bundled-runtime review must additionally check its recorded checksums, package
dependency shape, generated WebAssembly wrappers, and the runtime behavior
described by the offline narration gate.
The semantic-index contract itself is covered by
[`tests/codebase-index.test.mjs`](../tests/codebase-index.test.mjs), which checks
the domain schema, relative links, and tracked first-party path coverage.
[`tests/agent-customization.test.mjs`](../tests/agent-customization.test.mjs)
checks project customization discovery, skill metadata, and the investigator's
required read-only configuration.
Run `npm run lint`, `npm run typecheck`, `npm test`, and `git diff --check` before
handoff. `npm test` performs the production build before running every
[`tests/*.test.mjs`](../tests) file.

## Inactive and opt-in starter surfaces

**Purpose:** Identify inherited framework examples and optional platform helpers
that are present in the repository but do not own LineLight's current document,
identity, or persistence architecture.

**Runtime:** Unused by the active reader unless a future feature explicitly
wires them in; examples target edge worker and D1 runtimes.

**Owns:** [`app/chatgpt-auth.ts`](../app/chatgpt-auth.ts) provides optional
ChatGPT-host authentication header and redirect helpers but has no current
caller. [`db/index.ts`](../db/index.ts) provides an opt-in Drizzle/D1 factory;
[`db/schema.ts`](../db/schema.ts) intentionally exports no product schema.
[`drizzle.config.ts`](../drizzle.config.ts) and
[`drizzle/meta/_journal.json`](../drizzle/meta/_journal.json) are the corresponding
tooling placeholders. [`examples/d1/app/api/notes/route.ts`](../examples/d1/app/api/notes/route.ts)
and [`examples/d1/db/schema.ts`](../examples/d1/db/schema.ts) demonstrate a D1
notes route and schema; they are not LineLight data flows.

**Entry points:** None in the active reader. These files become entry points only
after an explicit feature integrates them and moves their ownership into an
active domain.

**Change together:** Do not route imported documents, reader
progress, bookmarks, or settings into these examples. Any activation requires a
privacy and architecture decision, edge binding review, production schema and
migration tests, and an update to this index and user-facing privacy docs.

**State and I/O:** The active product keeps documents and navigation data in
browser storage. The D1 example would create server-side state, and the auth
helper would introduce hosted identity; neither boundary is currently active.

**Verification:** There is no active product test contract for these examples.
If one becomes production code, add focused behavior and migration tests before
removing the inactive designation.

## Explicit exclusions

These tracked files remain outside semantic ownership because they are generated
or presentation-only artifacts rather than behavior-bearing modules:

- [`package-lock.json`](../package-lock.json) is npm's generated resolved
  dependency graph; keep it synchronized with package policy rather than
  assigning it independent semantic ownership.
- [`.vinext/fonts`](../.vinext/fonts) contains generated framework font files;
  edit the font/build configuration that produces them instead.
- [`public/favicon.ico`](../public/favicon.ico) and
  [`public/favicon.svg`](../public/favicon.svg) are presentation-only image
  assets; the PWA domain above owns their route and manifest contracts.
- [`public/file.svg`](../public/file.svg) is unused template artwork rather than
  a behavior-bearing module.
- [`public/globe.svg`](../public/globe.svg) is unused template artwork rather
  than a behavior-bearing module.
- [`public/window.svg`](../public/window.svg) is unused template artwork rather
  than a behavior-bearing module.
- [`public/offline-voice-license.txt`](../public/offline-voice-license.txt) is the
  distributed third-party license text, not an implementation entry point.
- [`public/offline-voice-third-party-notices.txt`](../public/offline-voice-third-party-notices.txt) documents
  the byte-identical deployed ONNX Runtime component notice, not an
  implementation entry point.

### Coverage and maintenance rules

The domain entries intentionally cover tracked first-party modules under
`app/`, `worker/`, `db/`, `build/`, `scripts/`, and `tests/`, together with the
runtime and validation configuration that determines their behavior. Cross-cutting
files appear in more than one domain when that helps a reader follow a real
change path.

Generated, vendored, static, or legal artifacts do not need semantic ownership
beyond the module that consumes them. This includes the tracked `.vinext/` font
files, generic SVGs in `public/`, and generated Drizzle metadata other than the
journal placeholder explicitly identified above. The offline model license is
linked from the owning domain but is not an implementation entry point.

Validation can prove that a path is present and a link still resolves; it cannot
prove that a prose description remains true. Pull-request review remains
responsible for checking ownership, privacy boundaries, runtime context, and
verification claims whenever an indexed component changes.
