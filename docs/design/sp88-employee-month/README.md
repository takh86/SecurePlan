# SP-88 employee-month atomic planning — design gate

Date: 2026-11-02. Issue: [#88](https://github.com/takh86/SecurePlan/issues/88).
Status: **business interaction and all-or-nothing requirement APPROVED; the
detailed contracts below are PROPOSED; implementation approval PENDING.**

This is a design-only change. It neither changes the controlled baselines nor
authorizes implementation, merging, issue closure or deployment. In particular,
the scoped SP-13 audit approval does not approve this command. The recommendations
form one reviewable contract; alternatives are recorded where they matter.

## Recommendation and navigation

One admin submits the complete desired DAY/NIGHT membership state of one
employee in one existing project-month plan. The server compares every observed
slot, changes only that employee's memberships, preserves other staff and empty
existing duties, and commits all duty changes, required audit and command receipt
in one PostgreSQL transaction. Duties remain canonical and individually versioned.

Use a short plan-row UPDATE lock as an admission barrier for this new command,
under the existing LOCK-01-L1 parent prefix. Respect every active interactive
lease on a duty that would change, including another tab belonging to the same
account. Hold no month lease or database lock while the user edits. Keep SP-12's
single-duty API and lease protocol intact.

| Artifact | Review purpose |
|---|---|
| [Requirements and source review](01-impact-and-sources.md) | Baseline traceability, proposed amendments, #86/#87 foundation assessment |
| [Domain and UX](02-domain-and-ux.md) | Desired-state semantics, roles, missing/empty duties, recovery interaction |
| [API and idempotency](03-api-and-idempotency.md) | DTOs, examples, preconditions, errors, migration and lost-response recovery |
| [Transaction and security](04-transaction-and-security.md) | Exact lock phases, shared rosters, leases, validation overlay, audit and concurrency proof |
| [Acceptance and delivery](05-acceptance-and-delivery.md) | Test matrix, PR/file ownership, estimates, risks and next mission |
| [Decision sheet](06-decision-sheet.md) | Only remaining product and technical/security approvals |
| [Investigation evidence](07-investigation-evidence.md) | Exact commands, exploratory PostgreSQL results, limitations and verification ledger |

## Authority and completion boundary

The owner's decision on #88 is final: a single **Monat speichern** commits the
entire intended employee-month change or none of it. No client loop over SP-12
writes can satisfy this requirement. Conflicts retain the entire unsaved draft
and require an explicit human decision before another write.

CR-03 remains authoritative: before first publication the plan is UNPUBLISHED;
afterwards changes commit directly to PUBLISHED. No second draft, republish,
employee-month business aggregate, absence record called Frei, or staffing
minimum is introduced.

The design identifies concrete defaults, logical safety arguments and an
exploratory PostgreSQL result. It does **not** establish implemented SP-88
atomicity, integrated Publish acceptance, human UX approval or production
readiness. Those require the implementation and acceptance PRs in the backlog.

## Git isolation

The assigned worktree had no tracked modifications. The existing untracked
`AGENTS.md` was read and retained locally. After refreshing origin, this branch
was created from `origin/main@13b680c07929ae595c196a523a32d4226bfa8e64`:
`agent/codex/sp88-employee-month-design`.

SP-13 remains on `agent/codex/sp13-initial-publish` at
`e30db8fb6a2db851e154c9d6dbf6ebcdf94129e2`; PR #86 is preserved. Claude's
`agent/claude/sp12-a10-ui` at `662985e7d137940c8f6443bcf93ebb7eabd95423`
and PR #87 were inspected read-only. No SP-13 commit is stacked into this PR.
