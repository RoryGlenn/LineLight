# LineLight repository guidance

This guidance applies to the entire repository.

Before changing code, read the relevant parts of
[`docs/codebase-index.md`](docs/codebase-index.md), the product and local setup
notes in [`README.md`](README.md), and the pull-request workflow in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Dependency changes also require
[`docs/dependency-security.md`](docs/dependency-security.md).

- Preserve LineLight's private-first boundary: imported documents and local
  reader state stay on the device unless an explicitly selected feature says
  otherwise.
- Follow the ownership, runtime, storage, and verification links in the
  codebase index before editing a cross-cutting path.
- Update the affected index entry when adding or moving a module, changing a
  runtime or storage boundary, or changing which tests establish behavior.
- Do not edit generated output or unrelated worktree changes.

Use targeted tests while iterating. Before handoff, run:

```bash
npm run lint
npm run typecheck
npm test
git diff --check
```
