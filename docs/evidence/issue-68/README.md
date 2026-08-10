# Issue 68 PDF sharpness browser evidence

This directory is the review target for the headed-Brave regression that guards
PDF text sharpness after import. No browser evidence is checked in until the
Issue 68 implementation is committed, independently reviewed, and the shared
headed-test host is available.

Run the acceptance harness from that exact clean commit:

```bash
node scripts/run-pdf-sharpness-browser-regression.mjs --record
```

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

- an adjacent page cached at no more than 1.25x, then actually drawn into its
  connected visible canvas before a later sharp composition reaches the
  computed, safety-capped target (the validator independently derives that
  target from measured CSS size, PDF page size, DPR, and visual-viewport scale;
  no timing sleep or app-reported target stands in for either draw);
- the current viewport to compose first after a rapid scroll, with no stale
  non-visible composition and no lower-resolution overwrite;
- count and total-pixel bitmap limits, temporary pinned-only overflow, and a
  zero-sized offscreen canvas whose measured text/highlight shell remains;
- one main-thread fallback staging render at a time, an injected first-render
  failure followed by recovery, and page-3 cancellation after its PDF.js
  continuation is delayed; page 3 and a unique attempt ID are derived from the
  sole real visible, unsatisfied fallback flow rather than supplied by the test
  caller. Delay, viewport exit, continuation resume, and no-late-compose proof
  must share that identity, and the harness waits for the continuation to resume
  more than one second later before accepting a retained zero-sized canvas;
- deterministic local narration advancing a word inside its measured sentence
  highlight in every desktop/mobile/zoom scenario, with no Window Long Task
  above 50 ms;
- recursive CDP attachment to a fixed point covering normal document/parser
  workers and the forced blob-wrapper/parser chain, with their session ancestry
  and non-page request counts; attachment promises and all observed network
  requests must reach a quiet fixed point before the privacy snapshot, with no
  attach error, external request, request for the imported PDF source, or other
  network failure; and a local `file:` reference comparison.

The report stores only PDF byte counts/hashes and local test-speech character
counts; it does not serialize PDF text or narration text. A non-default local
fixture path is redacted from the JSON record.

The fast validator and opt-in launch gate live in
[`tests/pdf-sharpness-browser-harness.test.mjs`](../../../tests/pdf-sharpness-browser-harness.test.mjs).
The browser test remains skipped unless
`LINELIGHT_RUN_PDF_SHARPNESS_BROWSER=1` is explicitly set.
