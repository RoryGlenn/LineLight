# Contributing to LineLight

LineLight is currently maintained by one person, but changes still use the same
reviewable path as a larger project.

## Change workflow

1. Create a branch from the latest `main`.
2. Make a focused change and run the relevant local checks.
3. Open a pull request into `main`.
4. Wait for the required CI `test` job to pass on the current head commit.
5. Resolve any review threads, then merge through GitHub.

The `main` branch protection rule requires pull requests and the CI `test` job.
The branch must be up to date before merge. Force pushes and branch deletion are
disabled, and the rule applies to repository administrators.

An approving review is not currently required because LineLight has a sole
maintainer and GitHub does not allow authors to approve their own pull requests.
This should be reconsidered when another regular maintainer joins the project.

## Emergency changes

There is no routine administrator bypass. The repository owner can edit the
protection rule, but may do so only when an urgent security, data-loss, or
availability fix is blocked by a GitHub or CI outage.

Before changing the rule, record the reason and intended change in a GitHub
issue. Disable only the minimum blocking setting for the shortest possible
time, restore the complete rule immediately afterward, verify it through the
GitHub API, and follow up with the normal pull-request record. Branch protection
must not be bypassed merely to save time or to merge a failing change.

## Sites deployments

LineLight's Sites deployment uses a separate generated source repository. A
release starts from an already merged and validated `main` commit, so publishing
does not require a direct push to the protected GitHub branch. Branch protection
must not be weakened for a Sites release.
