# AGENTS.md

## Repository state

SecurePlan currently contains architecture and requirements documents.
Do not describe planned application code as implemented.
Respect the user's practicum learning workflow and the supervisor's authority.

## Commands

- install: N/A; no package manifest in the audited tree.
- test: NOT CONFIGURED.
- lint: NOT CONFIGURED.
- typecheck: NOT CONFIGURED.
- build: NOT CONFIGURED.
- Documentation-only verification: scoped diff review, internal references, `git diff --check`.
- Identify actual commands when implementation is approved; never report an absent check as PASS.

## Rules

- Codex is the engineering executor; ChatGPT/Work defines and reviews the Task Contract.
- Work only on a feature branch; open a pull request before `main`.
- Never push directly to `main`, force-push `main`, or delete a protected branch.
- Never merge or enable auto-merge; the human owner performs the merge.
- Keep diffs focused; ask before touching files outside scope.
- Never read, print, or edit secrets or `.env`.
- Never run destructive migrations.
- Explicit human gates: production, credentials, important deletes, external messages, auth/RLS weakening, substantial architecture changes, and installing Plugins/MCPs.
- Verify version-specific APIs with current primary documentation when needed.
- Do not say "done" without evidence.

## Required evidence

- `git diff --stat` and summary.
- Tests / lint / typecheck / build: actual result, NOT RUN, or N/A with reason.
- Screenshots when UI, known limitations, untested areas, approval gates.

## Review and stop rules

Flag authorization/RBAC and tenant-isolation gaps, missing business-rule tests, unvalidated input, secrets, destructive migrations, and security regressions.
Stop on ambiguity, out-of-scope needs, destructive changes, or unresolved test failures.
