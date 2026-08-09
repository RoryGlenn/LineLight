# Issue 56 browser evidence

This directory records the production headed-Brave regression for the supplied
359-page PDF. Regenerate it locally with:

```bash
node scripts/run-pdf-worker-browser-regression.mjs \
  --output docs/evidence/issue-56
```

The JSON report is authoritative for thresholds and environment details. The
raw DevTools trace is retained for task/thread inspection, and the screenshots
show the first visible page for the reference and replacement documents.
