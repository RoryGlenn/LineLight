# Issue 68 PDF sharpness browser evidence

This directory is the review target for the headed-Brave regression that guards
PDF text sharpness after import. No browser evidence is checked in until the
Issue 68 implementation is committed, independently reviewed, and the shared
headed-test host is available.

Run the acceptance harness from that exact clean commit:

```bash
node scripts/run-pdf-sharpness-browser-regression.mjs --record
```

When the recursive CDP network gate itself needs diagnosis, use the bounded,
non-recording mode with an explicit transient output directory:

```bash
node scripts/run-pdf-sharpness-browser-regression.mjs \
  --diagnose-first-network-fixed-point --output /tmp/issue-68-network-diagnostic
```

That mode runs only the first desktop scenario, skips fallback and reference
capture, and still closes its owned browser, CDP connection, profile, and
server. Its explicit output directory must resolve outside the source
repository, including through existing symlinks, and it accepts only the exact
deterministic repository PDF fixture. On
either success or timeout it writes a separate `diagnostic: true` schema with
`completed` and `fixedPointReached` states, never a canonical `passed` result.
The diagnostic binds only `linelight-desktop-dpr1-zoom100.png` from that
external output directory and contains counts,
per-command pending-attach status, inflight request metadata, recent stability
samples/activity, detached target ancestry, opaque request/session/target IDs,
the clean pre-navigation target baseline, service-worker bypass state, the
first service-worker bootstrap request outcome, and fixed URL classes. A
reported fixed point is
independently rejected when any attach error, incomplete target, failed or
pending target command, pending request, or missing service-worker bypass is
present, even if the recorded outcome says that the network became quiet. The
report also binds the exact first desktop phase, three real stable samples,
one attach promise per target, unique opaque request/target identities, and a
parser target parented to the same-phase document worker. It
never records URL paths or queries, raw error text,
request bodies or headers, document text, or browser-profile paths. It is a
diagnosis aid, not Issue 68 acceptance evidence.

When the persisted-document restore and forced-fallback import boundary needs
diagnosis, use the separate bounded lifecycle mode with a fresh external output
directory:

```bash
node scripts/run-pdf-sharpness-browser-regression.mjs \
  --diagnose-fallback-import --output /tmp/issue-68-fallback-import-diagnostic
```

This mode first imports and persists the exact public fixture, navigates the
same disposable profile into forced fallback, and immediately selects that
fixture again. It accepts completion only from the new file-change import's
exact job, document, revision, page 1, terminal progress, complete, and
render-fallback chain; an automatically restored page or generic ready DOM
cannot pass. Its distinct `diagnostic: true` report has `completed`,
`importCompleted`, and `networkSettled` states but never a canonical `passed`
field or acceptance schema version. It records only fixture hashes/counts,
opaque local-library identities, fixed DOM/notice/error categories, wrapped
worker lifecycle metadata, sanitized CDP target/network state, one bound
external screenshot, and fail-closed owned teardown. It never stores document
text, raw local document identities, worker payloads, URL paths or queries, raw
errors, or profile paths. The report also records a fixed before/after stage for
each bounded connect, baseline, configuration, setup, fallback import, network,
and screenshot step. A failure exposes only its fixed stage-derived category;
raw exception text cannot affect the report. Setup evidence is retained as
privacy-safe hashes, counts, and independently derived source/model/library
condition booleans even when a later setup step fails, rather than being
discarded as one null result.

When the native PDF-viewer readiness classifier itself needs diagnosis, use
the distinct reference-capture mode with a fresh, absent external output
directory. It defaults to the first desktop configuration:

```bash
node scripts/run-pdf-sharpness-browser-regression.mjs \
  --diagnose-reference-capture --output /tmp/issue-68-reference-diagnostic
```

The only alternate selector is a fresh mobile DPR-3 observation of page 3:

```bash
node scripts/run-pdf-sharpness-browser-regression.mjs \
  --diagnose-reference-capture \
  --reference-configuration mobile-dpr3-zoom100 \
  --output /tmp/issue-68-mobile-reference-diagnostic
```

The mode accepts only the exact public fixture and the allowlisted
`desktop-dpr1-zoom100`/page-2 or `mobile-dpr3-zoom100`/page-3 pair. A fresh
disposable viewer must begin with one `about:blank` page. The selected device
metrics are applied before the first PDF navigation, whose nonempty new loader
and frame must match a `Page.lifecycleEvent` load while a separate
post-dispatch `Page.loadEventFired` proves the page-load boundary. The report
retains only opaque ID hashes, fixed protocol/content classes, and the actual
DPR, screen, layout, and visual-viewport metrics. Native mobile PDF viewing is
validated relationally: pre-navigation and viewer layouts remain stable,
the named 980-CSS-pixel Chromium default mobile layout width is exact, layout
height follows the emulated screen aspect, visual dimensions multiplied by
their scale map back to that screen within the DPR tolerance, and viewer scale
derives from the requested pinch and screen-to-layout ratio. Observed fractional
heights and scales are derived rather than hardcoded. The mode
then binds two adjacent, byte-identical candidate PNGs at the exact expected
physical dimensions to fixed basenames, byte counts, hashes, version-2
segmentation metrics, and the deterministic requested-page component
observation, plus the exact clean source commit/tree and reviewed file hashes.
A stable candidate may deliberately report `renderedPage: false`:
that observation is diagnosis, never Issue 68 acceptance, and the report has no
`passed` field or acceptance schema version. Raw capture exceptions, local
output paths, private fixtures, and browser-profile paths are never serialized;
only a fixed stage-derived failure category and teardown booleans are retained.
The mode starts no app server and makes no production build, but its single
owned reference browser, CDP connection, process, and disposable profile must
all tear down successfully. It rejects `--record`, another diagnostic mode,
repository-resident output, an existing output directory, and any substituted
fixture.

The acceptance, network, and fallback-import paths always make a fresh
production build, serve that exact artifact on an owned loopback Wrangler
process, and open visible Brave windows. Every path refuses an uncommitted
source tree. The build-backed paths additionally bind the runtime manifest
deployment, deterministic PDF hash, screenshots, and JSON result to that exact
source commit/tree and reviewed-file hash set. Recorded evidence accepts only
the repository's deterministic PDF
fixture; a private local PDF is permitted only with transient `--output`, so its
rendered pixels cannot be committed accidentally. Each acceptance configuration
owns a fresh reference browser, CDP connection, and disposable profile from one
exact `about:blank` baseline through its first configured PDF navigation and
new-loader lifecycle. No reference target is reused across desktop, zoom,
mobile, or pinch configurations. Each session closes before the next begins,
is bound by an opaque unique identity to its comparison and exact teardown row,
and is aggregated independently from app-browser and server cleanup. The
schema-3 validator requires all six ordered reference sessions, every
process/CDP/profile cleanup, and the app and server teardown to succeed.

The six-scenario matrix covers desktop DPR 1 and 2 at normal and effective 125%
browser-zoom metrics, plus mobile DPR 3 at normal scale and a 200%
visual-viewport pinch. The desktop transition is represented by Chromium's
effective `devicePixelRatio` and corresponding CSS viewport resize;
`visualViewport.scale` remains one. It does not automate a browser-chrome
Ctrl/+ shortcut. That UI action is not an additional Issue 68 acceptance gate:
LineLight can observe only the resulting DPR/viewport events, and the harness
sets and verifies those exact runtime signals deterministically. The mobile
pinch keeps the base DPR and independently changes `visualViewport.scale`,
preventing desktop zoom from being counted twice.

Each scenario pairs a screenshot of the original local PDF in Brave's PDF
viewer with LineLight's imported rendering of the same hashed page. A reference
screenshot is accepted only after decoded pixels prove a substantial white page
with multiple, broadly distributed lines of rendered ink. The readiness
classifier uses the unchanged white-pixel predicate to form deterministic
4-connected components, retains only components meeting the existing minimum
page width and height, and requires one uniquely largest white-area component.
Its version-2 proof records the substantial-component count, winner and
runner-up white areas, and their exact dominance ratio before applying the
unchanged 1% inset and five rendered-ink thresholds. A disconnected white
thumbnail rail, toolbar, blank page, clipped page, spinner, loading surface, or
ambiguous tied components therefore cannot satisfy readiness. The JSON
validator independently checks those global segmentation metrics, including
each connected component's minimum spanning area, the disjoint-component area
sum, disjoint white/ink pixel counts, the minimum-pixel and row-spacing
implications of each ink band, and the integer-pixel horizontal ink span. It proves
the requested page separately instead of assuming that page is the largest
visible component: all substantial components are retained in deterministic
top-first order, exactly one must be anchored in the top quarter after the
exact `#page=N&zoom=page-width` new-loader navigation, and its exact RGBA bounds
are cropped and run through the same unchanged version-2 thresholds. An
adjacent page may legitimately be the global white-area winner, but cannot be
substituted for the top-anchored requested page. The validator additionally
requires:

- an adjacent page cached at the independently derived, safety-capped preview
  target of at most 1.25x, then actually drawn into its connected visible
  canvas. When that exact backing already equals the computed physical-pixel
  target, the same composition and worker-bitmap identities must be retained
  without a redundant render; otherwise, distinct monotonically ordered bitmap
  and composition identities must prove the later larger sharp backing. At
  least one matrix run must exercise that strict upgrade. The validator derives
  both targets from measured CSS size, PDF page size, DPR, and visual-viewport
  scale, so no timing sleep or app-reported target stands in for either path;
- the current viewport to compose first after a rapid scroll, with no stale
  non-visible composition and no lower-resolution overwrite. The target shell
  is mounted before the probe, then one main-thread activity sequence records
  the final scroll action, worker messages, and draw invocations. Each draw's
  invocation ID, page/reader rectangles, product visibility, and independent
  geometric intersection are captured synchronously; only render source and
  scale are filled in by the deferred recorder. The action snapshots the draw
  invocation boundary and immediately calls instant `scrollIntoView` in that
  same browser task. The target must be geometrically outside the reader before
  the action, the scroll position must change synchronously, and the target
  must intersect the reader afterward, so CSS smooth-scroll timing cannot
  relabel an intermediate draw as the final target. A draw invoked before the
  scroll cannot be mislabeled by a later microtask. An exact cached bitmap that
  already satisfies the target
  must compose with exactly zero new target requests or bitmaps, before any
  non-target bitmap. An undersized or missing bitmap must instead produce
  exactly one first post-action visible request, exactly one later target
  bitmap, and the bound visible composition; only a non-target bitmap that
  overtakes that target bitmap is stale. Later adjacent-page prefetch output is
  retained and allowed after the applicable target cutoff. The composition
  records the actual transferred `ImageBitmap` event identity rather than
  inferring it from equal dimensions.
  The matrix must prove both
  paths. Before those probes, the harness requires the exact six-page worker
  model to complete and reaches distant virtualized shells through bounded
  half-viewport traversal, without assuming offscreen pages are mounted or
  copying product offset math;
  page/complete document keys and every page/progress/complete and
  preview/render/bitmap job/revision are bound to the latest exact import
  request so an earlier automatic library restore cannot satisfy or invalidate
  these gates;
- count and total-pixel bitmap-cache limits, temporary pinned-only overflow,
  and visible-canvas peak frames whose unique composed-page set exactly equals
  both the product-visible set and an independently recomputed intersection of
  each page rectangle with the reader scroll-root rectangle. Both retained peak
  frames are cross-checked against the observed count and pixel maxima. Every
  composed page must report
  a positive exact backing and the frame's exact pixel sum must remain below
  33,554,432; a tall mobile viewport may therefore retain three genuinely
  visible canvases without being mistaken for offscreen leakage. A page that
  leaves the viewport must still expose a zero-sized canvas while its measured
  text/highlight shell remains;
- one main-thread fallback staging render at a time, an injected first-render
  failure followed by recovery on the same document revision and target, and
  page-3 cancellation after its PDF.js continuation is delayed. The failure is
  armed only after the latest import completes, against its validated adjacent
  unsatisfied page, so an automatic persisted-document restore cannot consume
  it. The one-argument continuation arm internally derives the next adjacent
  unsatisfied page from the sole visible page and keeps waiting through any
  wrong-document or wrong-page staging. The arm, consumption, failure/retry,
  and continuation events must retain that exact document/revision/page
  identity. Page 3 and a unique attempt ID are therefore derived from the real
  fallback flow rather than supplied by the delay caller. Each attempt is bound
  to the unique `AbortSignal` registered by its production PDF.js cancel
  listener; an already-aborted signal is ineligible, and a restored-document
  signal aborted before staging is explicitly retired instead of competing
  with the current attempt. The
  page-exit action, exact controller abort, cancelled terminal outcome, viewport
  exit confirmation, controlled continuation resume, and no-late-compose proof
  must share that signal/document/revision/attempt identity and occur in that
  order. The continuation is explicitly held rather than automatically released
  by a one-second timer: DOM release may be observed before or after React's
  passive cancellation cleanup, but resume is authorized only after the exact
  cancelled terminal and the zero-sized canvas/text shell are both present, and
  only after timestamps prove at least one second has elapsed. No composition
  for that attempt may occur from the exit request onward. A failure anywhere
  from the exit request through traversal, cancellation, release, minimum hold,
  or resume retains a fixed, privacy-safe partial event/DOM summary with
  document and revision represented only by match booleans;
- deterministic local narration advancing a word inside its measured sentence
  highlight in every desktop/mobile/zoom scenario, with the retained Long Task
  observer drained at scenario close and entries selected by `startTime`; a
  missing or malformed trace is distinct from an observed task above 50 ms;
- recursive CDP attachment to a fixed point covering normal document/parser
  workers and the forced blob-wrapper/parser chain, with their session ancestry
  and non-page request counts in every one of the six matrix phases; attachment
  commands are explicitly bounded. Before the initial navigation, an exact CDP
  baseline must contain one `about:blank` page and no worker, shared-worker, or
  service-worker target. Paused PDF/shared workers must complete setup before
  resume. A paused service worker uses the observed Chromium-safe barrier:
  `Network.enable`, `Runtime.enable`, cache disable, and recursive auto-attach
  are sent synchronously in that order, resume is sent fifth without awaiting
  an earlier response, and all five results must arrive at or after resume and
  before one shared post-resume deadline. Its exact first session request must
  be a terminal local `GET` `Script` for the target's raw URL, with no request
  before the resume barrier and no session failure. A service worker can never
  satisfy document/parser-worker settlement coverage. The page bypasses its
  service worker for direct origin observation.
  A worker script request transferred into an attached target settles only when
  one fully attached and resumed `worker` has the exact raw URL, parent session,
  phase, `GET` method, and `Script` resource type; the request remains in the
  evidence with a one-to-one `target-attached` terminal record. Each matrix
  phase requires both document- and parser-worker settlements. All remaining
  attachment promises and observed network requests must reach a quiet fixed
  point before the privacy snapshot. Every stable sample independently requires
  successful service-worker bypass, zero attach errors, and the exact completed
  attach/resume command sequence for every observed target, so a timed-out
  command cannot be mistaken for a quiet network. There must also be no external
  request, request for the imported PDF source, or other network failure; and a
  local `file:` reference comparison.

The forced-fallback diagnostic generates a module wrapper whose first statement
is a static import of the resolved document-worker module. That dependency
installs the real worker message listener before the worker port queue opens;
the wrapper body then proxies native nested `Worker` construction so root- and
asset-relative parser URLs resolve against the absolute document-worker URL,
disables `OffscreenCanvas`, and emits the fixed, integer-only worker sentinel
before any import message can dispatch. The proxy preserves native construction,
options, prototype, static, error, and subclass semantics and does not queue or
replay messages. Every post-file-selection bootstrap settlement must bind to an
exact new target. Separately, the selected import must have exactly one
null-parent wrapper blob and exactly one direct parser child, each with one
matching settlement and exact ancestry. A restored wrapper, unrelated local
worker, or second parser cannot substitute for that chain.

The validator also requires the exact reviewed source-file key set and one
unique, expected filename/path/hash/byte reference for every screenshot. A
partial or substituted manifest cannot preserve a passing record.

The report stores only PDF byte counts/hashes and local test-speech character
counts; it does not serialize PDF text or narration text. A non-default local
fixture path is redacted from the JSON record.

The fast validator and opt-in launch gate live in
[`tests/pdf-sharpness-browser-harness.test.mjs`](../../../tests/pdf-sharpness-browser-harness.test.mjs).
The browser test remains skipped unless
`LINELIGHT_RUN_PDF_SHARPNESS_BROWSER=1` is explicitly set.
