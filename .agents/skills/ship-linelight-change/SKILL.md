---
name: ship-linelight-change
description: Implement, fix, or review a LineLight repository change from codebase orientation through validation and an authorized pull-request finish line. Use for work in RoryGlenn/LineLight that touches the reader UI, document import, narration, browser workers, IndexedDB, service workers, edge routes, deployment assembly, or repository validation.
---

# Ship a LineLight Change

Use LineLight's ownership map and private-first constraints to make the smallest
complete change, prove the affected behavior, and finish at the outcome the user
authorized.

## Establish scope

1. Read the root `AGENTS.md` and any closer `AGENTS.md` that governs the target
   files.
2. Read the relevant domain in `docs/codebase-index.md`. Use `README.md` for
   product behavior, `CONTRIBUTING.md` for publishing, and
   `docs/dependency-security.md` before changing dependencies.
3. Run `git status -sb` and inspect existing diffs. Preserve unrelated user
   changes and use a fresh branch or isolated worktree when necessary.
4. Distinguish the requested outcome before acting:
   - For an explanation or review, gather evidence without editing.
   - For diagnosis, identify and explain the root cause without implementing a
     fix unless requested.
   - For a change, implement and validate it.
   - Commit, push, merge, deploy, or mutate external systems only when the
     prompt or parent agent authorizes that finish line.

## Map the behavior

1. Identify the owning runtime, entry point, state or network boundary,
   neighboring contracts, and verification links from the codebase index.
2. Trace the real execution path with `rg` and targeted reads before editing.
   Treat `app/page.tsx` as the coordinator, not the automatic home for new
   domain logic.
3. For browser-reported failures, inspect the current browser-facing behavior
   when possible. Separate source defects from stale service-worker control,
   Vite optimizer state, cached runtime assets, and old deployment responses.
4. State any assumption that would materially change scope. Prefer a safe,
   reversible assumption when the repository can answer the question.

## Implement the change

1. Keep imported documents, audiobook files, derived text, narration audio,
   and reader state on the device unless the user explicitly selects a feature
   whose documented boundary says otherwise.
2. Preserve document identity, token indices, revisions, cancellation, and
   stale-result guards across browser main, workers, storage, and playback.
3. Make a focused change in the owning module. Avoid unrelated refactors and do
   not edit generated artifacts by hand.
4. Add or update tests for changed behavior. Update the affected codebase-index
   entry when ownership, runtime, storage, network, or verification changes.

## Validate proportionally

1. Run the focused tests linked from the owning codebase-index domain while
   iterating.
2. For change tasks, run the repository gates before handoff exactly as
   documented. For read-only diagnosis or review, run only the focused,
   non-mutating checks needed to support the conclusion.

   ```bash
   npm run lint
   npm run typecheck
   npm test
   git diff --check
   ```

3. When a source-bound browser-evidence test fails because an owning source
   changed, run the repository's corresponding recording harness. Never make a
   test pass by hand-editing evidence hashes or claiming a browser run that did
   not occur.
4. Validate user-visible browser, audio, worker, and deployment changes in the
   real surface when the required environment is available. Do not invent or
   substitute a deployed URL, document fixture, voice pack, or browser profile
   that the report depends on. If an input or environment is unavailable,
   report exactly what is missing and the unverified boundary.

## Publish when authorized

1. Re-read `CONTRIBUTING.md`, inspect the final diff, and stage only intended
   files.
2. Use a signed-off focused commit and push a non-protected feature branch.
3. Open the requested draft or ready pull request with the root cause, user
   impact, and exact validation commands. If the GitHub connector rejects a
   write, use the authenticated `gh` CLI fallback.
4. Wait for required CI on the actual PR head and inspect unresolved review
   threads. Fix actionable failures without weakening tests or privacy gates.
5. Merge only when authorized and branch protection permits it. Verify the
   exact merge commit on `main` and the fresh post-merge CI run.

## Report the result

Lead with the user-visible outcome. Name the changed files or PR, the validation
that passed, and any boundary that remains unverified. Do not call work complete
while a required check, review thread, merge, deployment, or live verification
is still outstanding.
