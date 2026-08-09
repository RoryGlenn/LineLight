# Issue 56 browser evidence

This directory records the production headed-Brave regression for the supplied
359-page PDF. Regenerate it locally with:

```bash
node scripts/run-pdf-worker-browser-regression.mjs \
  --output docs/evidence/issue-56
```

The JSON report is authoritative for thresholds and environment details. The
full-import trace covers the supplied PDF through all 359 durable pages,
outline construction, and completion. The separate cancellation trace covers
a second large import through a durable background-page prefix and then a
completed replacement on an isolated loopback origin. Both raw traces are
retained for task/thread inspection. Screenshots capture the full import's
first page and completion, the canceled import's first page, and the completed
replacement.
