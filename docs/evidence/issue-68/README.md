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
and fixed URL classes. It never records URL paths or queries, raw error text,
request bodies or headers, document text, or browser-profile paths. It is a
diagnosis aid, not Issue 68 acceptance evidence.

The runner always makes a fresh production build, serves that exact artifact on
an owned loopback Wrangler process, and opens visible Brave windows. It refuses
an uncommitted source tree and binds the source commit/tree, reviewed-file
hashes, runtime manifest deployment, deterministic PDF hash, screenshots, and
JSON result. Recorded evidence accepts only the repository's deterministic PDF
fixture; a private local PDF is permitted only with transient `--output`, so its
rendered pixels cannot be committed accidentally. Reference-browser,
app-browser, and server cleanup run as
independent settled operations; the validator requires each CDP connection,
process, and disposable profile to report its own successful teardown.

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
with multiple, broadly distributed lines of rendered ink; a fixed delay,
nonempty PNG, blank page, or loading surface cannot satisfy readiness. The JSON
validator additionally requires:

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
  non-visible composition and no lower-resolution overwrite; before those
  probes, the harness requires the exact six-page worker model to complete and
  reaches distant virtualized shells through bounded half-viewport traversal,
  without assuming offscreen pages are mounted or copying product offset math;
  page/complete document keys and every page/progress/complete and
  preview/render/bitmap job/revision are bound to the latest exact import
  request so an earlier automatic library restore cannot satisfy or invalidate
  these gates;
- count and total-pixel bitmap limits, temporary pinned-only overflow, and a
  zero-sized offscreen canvas whose measured text/highlight shell remains;
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
  exit confirmation, delayed continuation resume, and no-late-compose proof must
  share that signal/document/revision/attempt identity and occur in that order;
  the terminal cancellation must happen before the held continuation resumes
  more than one second later, while the zero-sized canvas and text shell remain;
- deterministic local narration advancing a word inside its measured sentence
  highlight in every desktop/mobile/zoom scenario, with no Window Long Task
  above 50 ms;
- recursive CDP attachment to a fixed point covering normal document/parser
  workers and the forced blob-wrapper/parser chain, with their session ancestry
  and non-page request counts in every one of the six matrix phases; attachment
  commands are explicitly bounded and must complete before a paused target is
  resumed. The page bypasses its service worker for direct origin observation.
  A worker script request transferred into an attached target settles only when
  one fully attached and resumed `worker` has the exact raw URL, parent session,
  phase, `GET` method, and `Script` resource type; the request remains in the
  evidence with a one-to-one `target-attached` terminal record. Each matrix
  phase requires both document- and parser-worker settlements. All remaining
  attachment promises and observed network requests must reach a quiet fixed
  point before the privacy snapshot, with no attach error, external request,
  request for the imported PDF source, or other network failure; and a local
  `file:` reference comparison.

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
