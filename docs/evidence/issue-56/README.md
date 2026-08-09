# Issue 56 browser evidence

This directory records the production headed-Brave regression for the supplied
359-page PDF. Regenerate it locally with:

```bash
node scripts/run-pdf-worker-browser-regression.mjs \
  --output docs/evidence/issue-56
```

The JSON report is authoritative for thresholds and environment details. The
runner builds LineLight, starts that exact Worker plus static-asset artifact in
local Wrangler, and directly checks the origin document, PDF worker scripts,
nested PDF.js worker, and threaded WebAssembly response headers before Brave or
its service worker can participate. The full-import trace proves page one's
model was durable and posted before raster work, visible Focus content was
available while the stored prefix was incomplete, the first worker bitmap
preceded an actual background-page worker bitmap, and all 359 pages plus the
outline completed later. The separate cancellation trace covers a second large
import through a durable background-page prefix and then a completed replacement
on an isolated loopback origin. Both raw traces are retained for task/thread inspection;
transparent measured-overlay and background-shell timing remain diagnostic and
do not delay an already-ready page bitmap. Screenshots capture the full import's
first page and completion, the canceled import's first page, and the completed
replacement.
