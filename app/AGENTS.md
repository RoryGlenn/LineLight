# LineLight reader runtime guidance

This guidance applies to source files under `app/` and supplements the root
[`AGENTS.md`](../AGENTS.md).

## Before editing

- Read the owning domain in [`docs/codebase-index.md`](../docs/codebase-index.md)
  before changing a reader, worker, storage, narration, or rendering path.
- Keep `page.tsx` focused on coordination. Put reusable validation, identity,
  scheduling, storage, and transformation logic in the module that owns the
  contract.
- Trace every affected runtime boundary: browser main, dedicated worker,
  service worker, edge worker, browser storage, and media playback.

## Runtime invariants

- Keep imported document text, audiobook files, transcripts, generated audio,
  and reader state on the device. Only an explicitly selected and documented
  online feature may send its bounded input across the network.
- Preserve document IDs, storage schema versions, token indices, source-text
  fingerprints, worker job generations, and cancellation identities. Reject or
  dispose stale results instead of applying them to a newer document or run.
- Keep stored media owned by a valid document record, exact profile, and
  edition fingerprint. Removing an owner must remove its derived records
  without affecting other books.
- Keep model and runtime routes pinned and allowlisted. They may transfer public
  assets, never imported text, audiobook bytes, transcripts, or generated
  narration.
- Treat Kokoro word timing as an audio-synchronized estimate. Do not present it
  as an exact model-provided timestamp.

## React and external-store behavior

- Keep `useSyncExternalStore` snapshots referentially stable until the store
  changes. Coalesce burst notifications and never mutate a store while React is
  rendering or reading its snapshot.
- Cancel asynchronous work in effect cleanup and guard every completion against
  the active document, revision, worker, and narration session.
- Preserve accessible names, keyboard behavior, reduced-motion expectations,
  and exact seek targets when changing reader controls or highlights.

## Verification and review

- Run the focused tests named by the owning codebase-index domain, then the root
  handoff gates.
- Use the owning real-browser harness for visual, worker, media, or committed
  evidence changes. Never refresh evidence hashes without the corresponding
  browser run.
- Flag a change as blocking when it silently expands the privacy boundary,
  accepts stale cross-runtime output, breaks storage cleanup or exact-edition
  matching, or claims stronger synchronization than the available timing data
  supports.
