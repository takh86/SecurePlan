# SP-09 closeout evidence for Issues #64 and #73

Audit date: 2026-10-29. Verified remote main:
[`7107781e1cbd9aab232cd394662372c1fb7cf92f`](https://github.com/takh86/SecurePlan/commit/7107781e1cbd9aab232cd394662372c1fb7cf92f).
The audit branch starts at that commit. Initial checkout was the merged feature
head `afa66034acc4ebe091b24a371f09b6053c867967`, with the identical tracked tree.
Initial tracked/staged status was clean; an existing untracked instruction file
was preserved. No worktree, application/schema/test/dependency changes,
deployment, merge or issue closure form part of this work.

**Issue #64 closure: BLOCKED pending independent final documentary/transfer review.**
**Issue #73 closure: BLOCKED pending that same independent final review.**
The implemented SP-09 scopes are supported by merged code and CI. The remaining
planning functionality and operational responsibilities have explicit destinations
below. Recording a handoff is not independent acceptance of it. Neither issue
should be closed automatically or before the reviewer records acceptance.

## Evidence method and boundaries

Reviewed repository/contribution/publication rules, both complete issue comment
histories (23 comments for #64, 8 for #73 at initial read), all six PR descriptions,
changes in the merged tree, review discussions, implementation paths and relevant
test assertions. Checked Actions run/job metadata and actual checkout/test logs,
including the post-merge main run. Compared controlled local Phase-7/8, database,
audit/transaction and UX source documents read-only; original hashes and private
reconciliation stay ignored locally. Public statements here derive from public
decisions/code/CI, without reproducing confidential source text.

No database connection, fixture creation, migration or DB-backed test was executed
during this audit. All runtime evidence below is **existing CI evidence**, not a
new local execution. Manual browser smoke and automated browser E2E remain
**NOT_RUN**. The earlier local development-database fixture cleanup is **reported
by its author, not independently verified here**; no no-impact certification is
made. Prevention and any necessary read-only reconciliation remain under #51.

`DONE` means the stated SP-09 behavior is implemented with the identified
evidence. `TRANSFERRED` means unimplemented or operational work has a named
follow-up owner and acceptance criteria. `BLOCKED` marks required acceptance
that has not yet happened. It does not negate the completed implementation.

## Issue #64 completion matrix

| Requirement | Approved decision/reference | Implementation PR | Test / CI evidence | Remaining gap | Handoff | Verdict |
|---|---|---|---|---|---|---|
| Case 1: FUTURE→FUTURE employment overlap | [1a](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6474708196) | [#70](https://github.com/takh86/SecurePlan/pull/70) | Employment helper matrix, patch-real and patch-concurrency-real; CI C70 | Browser acceptance separate | #51 | DONE |
| Case 1: historical→future coverage and resulting ACTIVE references | [B](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6476351354), [status rule](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6476989126), [archived API confirmation](https://github.com/takh86/SecurePlan/pull/72#issuecomment-6490108817) | [#71](https://github.com/takh86/SecurePlan/pull/71), [#72](https://github.com/takh86/SecurePlan/pull/72) | Coverage/status unit matrices, patch-real/concurrency, guard precedence; C71/C72 | None in implemented monthly rule | #25 for actual duties | DONE |
| Case 2: effective employment edit rejects newly excluded future monthly links | [final API/audit contract](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6499148328) | [#76](https://github.com/takh86/SecurePlan/pull/76), prerequisites [#74](https://github.com/takh86/SecurePlan/pull/74)/[#75](https://github.com/takh86/SecurePlan/pull/75) | Period-real/concurrency, filter/FE recovery, updated API-CON-12; C76/M76 | Future duty checks are separate | #25 D5; #51 browser/operations | DONE |
| Case 3b: INACTIVE retains monthly links, blocks new assignments and labels retained state | [3b](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6474708196), [scope review](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6501425953) | Existing SP-09 [#61](https://github.com/takh86/SecurePlan/pull/61); S-9 #75 retains projection | `project-assignments-real` inactive/reactivation case; `ProjectAssignmentsPanel` inactive-project test; M76 | Actual unresolved future duties require a new guard | #25 D4 | DONE |
| Case 4: four related audit actions and exact bounded meanings | [D1](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6502123168) | Existing #61/#62 and #70–#76; documentation reconciliation in this draft | Existing assignment/shift audit, no-op/rollback assertions; M76; [ADR-0004](../architektur/adr/0004-related-business-audit-catalogue.md) | Controlled catalogue documentary acceptance pending; other provisional actions not ratified | #25 D1 acceptance; #51 operational controls | BLOCKED |
| Case 5: preserve temporary fail-closed protection | [E-10](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6469492086), D2/D3 | [#66](https://github.com/takh86/SecurePlan/pull/66), #74 adds removal consumer | Guard/classification/catalogue tests; source unchanged since E-10; M76 | No real duty dependency integration yet | #25 D2/D3, #26 continuation | TRANSFERRED |

Case 1 compatibility is deliberate: historical employee-change coverage retains
`PROJECT_ASSIGNMENT_CORRECTION_CONFLICT`; unchanged employee into future uses
`EMPLOYEE_NOT_EMPLOYED_FOR_MONTH`. A **newly referenced** archived project is 404;
an unchanged archived reference in an effective future-target correction is
`409 PROJECT_INACTIVE`. Historical-target exceptions and true no-op 200 without
write/audit remain. No-op does not certify an existing row's validity.

Case 2 preserves `400 EMPLOYMENT_DATE_CONFLICT`, concealed 404, unchanged-date
and no-op behavior, uniqueness precedence and inactive-employee support. Its
409 has exact `conflictCount` plus `min(count,25)` ordered ID/month hints only.
The employee UPDATE lock precedes a fresh READ COMMITTED scan and serializes
supported assignment writers. Accepted date edits record both bounds and
count-only historical impact; rejected mixed PATCHes and failed audits roll back.
The UI retains unsaved fields and explicitly refreshes/focuses S-9. Already-invalid
future rows do not force blanket cleanup. This is an application writer protocol,
not a coverage constraint against arbitrary SQL.

Case 3 is verified in `ProjectsService.update`, assignment `create`, and the
operator label already explaining that existing links remain. D4 adds a future
**duty** condition; mere monthly links must continue to permit deactivation.

## Issue #73 acceptance matrix

| Requirement | Approved decision/reference | Implementation PR | Test / CI evidence | Remaining gap | Handoff | Verdict |
|---|---|---|---|---|---|---|
| Future-only by company IANA month; current/past unchanged | [D73](https://github.com/takh86/SecurePlan/issues/73#issuecomment-6491464511) | #74 | API-PROJ-13, Berlin/New York month/year boundaries; C74/M76 | None in monthly rule | — | DONE |
| COMPANY_ADMIN, Origin/CSRF/session and transactional actor recheck | [R2](https://github.com/takh86/SecurePlan/issues/73#issuecomment-6492654582) | #74 | API-PROJ-20/22, expired/revoked/role/company changes; C74/M76 | Existing security hardening independent | #51 | DONE |
| Mandatory Expected-Version, strict 400s, safe 404, correct 409 and precedence | R2 | #74 | API-PROJ-15/16/20/21/28, duplicates and If-Match; C74/M76 | Deploy proxy duplicate-header behavior | #51 | DONE |
| Exact version, locked reread, ABA and clock-skew protection | R2 S-2/S-5 | #74 | API-PROJ-17–19/25–27, API-CON-08–15, static writer tripwire; C74/M76 | Out-of-band SQL is not DB-enforced | #51 writer controls | DONE |
| Physical DELETE and exactly one atomic old-tuple removal audit | D73-1/5 and D1 | #74 | API-PROJ-12/24, repeated 404 and audit-failure rollback; C74/M76 | Catalogue acceptance and operational immutability distinct | #25 D1; #51 | DONE |
| No automatic replacement, vacancy, employment edit or historical removal | D-E / D73 | #74 | API-PROJ-12/23, before/after state and UI assertions; C74/M76 | Later scheduling is separate | #25 | DONE |
| Deactivated employee and inactive/archived reference removal | D73-1 | #74 | API-PROJ-14; C74/M76 | None in removal rule | — | DONE |
| S-9 complete employee future discovery, exact versions, hidden archived metadata | [S-9 sign-off](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6496624387) | #75 | 50 new PG discovery cases, snapshot/paging/tenant/rollover and listed-version DELETE; C75/M76 | Browser acceptance pending | #51 | DONE |
| Frontend confirmation, refresh, focus, uncertain outcome and preserved employee draft | R2 and S-9 | #74/#75/#76 | Removal, EmployeeFutureAssignmentsSection, EmployeeDetailPage and conflict-parser tests; C74–C76/M76 | jsdom is not browser E2E | #51 | DONE |
| Concurrent removal/PATCH/POST/employment/deactivation, both orders and rollback | R2; Case-2 final contract | #74/#76 | API-CON-08–15 and period concurrency C01–24; retained April blocker in API-CON-12; M76 | Actual planning writers not implemented | #25 LOCK-01/D2/D5 | DONE |
| Existing E-10 refusal remains; real scoped DRAFT/PUBLISHED dependency validation | D73-6/9, D2/D3 | #66/#74 preserve guard | `planning-guards-real`, classification/catalogue tests; M76 | Actual planning dependency checks unimplemented | #25 D2/D3, #26 | TRANSFERRED |
| Durable audit operational policy and browser acceptance | D73-5; explicit merge-review limits | #74–#76 record limits | [#74 review](https://github.com/takh86/SecurePlan/pull/74#issuecomment-6495849774), [#75 review](https://github.com/takh86/SecurePlan/pull/75#issuecomment-6498073827), [#76 review](https://github.com/takh86/SecurePlan/pull/76#issuecomment-6500555364) | Browser NOT_RUN; DB roles/retention/access/backup unverified | #51 | TRANSFERRED |
| Final controlled-document and transfer acceptance | D1–D6; present audit instruction | Documentation draft | Review package prepared; no independent final sign-off claimed | Required before closure | #25 D1 and final review on #64/#73 | BLOCKED |

A safe removal endpoint is implemented. It is **not** completed SP-11 planning
integration: the temporary guard refuses effective removal/correction once
classified planning relations exist until real checks replace it.

## Exact existing CI evidence

All listed runs and their `verify` jobs concluded SUCCESS. Actual checkout logs
were read, including PR synthetic merges rather than relying on a head SHA label.
HTTP/E2E totals include the real PostgreSQL suites; these totals are not a count
of independent real-DB scenarios or browser tests.

| Evidence | Tested checkout | Backend unit | Frontend | Backend HTTP/E2E | Scripts |
|---|---|---|---|---|---|
| C70: [40733593054](https://github.com/takh86/SecurePlan/actions/runs/40733593054) | PR #70 merge `f353f62` | 137 / 23 files | 368 / 32 | 391 / 30 | 20 |
| C71: [40742043430](https://github.com/takh86/SecurePlan/actions/runs/40742043430) | PR #71 merge `d75152c` | 149 / 23 | 368 / 32 | 407 / 30 | 20 |
| C72: [40831339523](https://github.com/takh86/SecurePlan/actions/runs/40831339523) | PR #72 merge `a8a13ed` | 169 / 24 | 368 / 32 | 427 / 30 | 20 |
| C74: [40855543173](https://github.com/takh86/SecurePlan/actions/runs/40855543173) | PR #74 merge `f1e7263` | 212 / 26 | 421 / 34 | 487 / 32 | 20 |
| C75: [40881665759](https://github.com/takh86/SecurePlan/actions/runs/40881665759) | PR #75 merge `18322a5` | 218 / 27 | 451 / 36 | 537 / 33 | 20 |
| C76: [40898206984](https://github.com/takh86/SecurePlan/actions/runs/40898206984) | PR #76 merge `3e92177` | 244 / 28 | 486 / 38 | 673 / 35 | 20 |
| M76: [40899445571](https://github.com/takh86/SecurePlan/actions/runs/40899445571) | actual main `7107781` | 244 / 28 | 486 / 38 | 673 / 35 | 20 |

Each job also passed publication scan, npm ci, lint, typecheck, both builds,
migrations twice (replay already applied), DB verification and built-backend
readiness. These migrations ran previously in isolated CI, never in this audit.
The main log still reports **10 dependency findings: 6 moderate, 4 high**. This
records that run's findings, not a fresh package-level vulnerability assessment.

This documentation branch uses `[skip ci]` because the existing push/PR workflow
writes to its ephemeral database, prohibited during this audit. Local checks are
publication scan, whitespace/scope and relative Markdown links. New branch
lint/typecheck/build/unit/frontend/scripts/DB/E2E: **NOT_RUN**. Required workflow
checks may stay pending as described by [GitHub](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs).
Do not treat the draft as merge-ready or bypass required checks. A later isolated
CI run requires a separate authorized review stage.

Audit-only checks completed locally: publication scan PASS (initial sandbox
subprocess restriction resolved by the authorized read-only rerun), whitespace
check PASS, 84 relative Markdown links across 14 changed/new public documents
PASS, and all 22 original private-source hashes plus the existing untracked
instruction-file hash unchanged. Only Markdown documentation is included in the
draft. No DB-backed checks were rerun to obtain these results.

## Documentation, controlled reconciliation and pending contracts

The draft reconciles the assignment/configuration handoffs, appends a dated
ADR-0003 update, adds ADR-0004 and the [D1–D6 handoff](../datenbank/sp11-integrity-handoff.md),
and refreshes current entry-point summaries and pre-staging gates. Original
decisions and dated historical reports remain intact. Application comments that
still call the four actions provisional are explicitly superseded by the PO
decision in documentation, without changing application files.

The ignored local register preserves originals and earlier drafts, records
approved monthly correction/status/removal/S-9/Case-2 amendments, and adds the
four-action catalogue. It distinguishes already approved business/API decisions
from **pending independent adoption/acceptance of the reconciled documents**.
It does not certify that earlier implementation authors had completed canonical
private adoption at their own coding dates.

Outstanding contracts are independently testable in #25:

- **LOCK-01:** a single global lock graph reconciled across workforce, planning,
  publish and replacement writers; conflicting prior orderings are not ratified.
- **D2:** exact old/new relational dependency predicates and duty/assignment lifecycle.
- **D3:** saved-duty lifecycle and effective-interval/intervening-version predicates.
- **D4:** unresolved/future duty lifecycle, exact new project-PATCH 409 and recovery.
- **D5:** duty-date versus instant/cross-midnight reference, duty conflict schema,
  precedence and bounded audit context, including current-month future duties.
- **D6:** explicit resolver/tzdata/precision/invalid-zone/error and snapshot contracts;
  business gap-forward/first-occurrence choice is already approved.
- **D1:** final independent acceptance of canonical catalogue reconciliation;
  no blanket ratification of unrelated provisional actions.

## Ownership, transfer and release gates

[#25](https://github.com/takh86/SecurePlan/issues/25) is the existing SP-11 parent
with separate D1/D2/D3/D4/D5/D6 and LOCK-01 acceptance gates;
[#26](https://github.com/takh86/SecurePlan/issues/26) carries the integration
continuation. [@takh86](https://github.com/takh86) coordinates delivery and obtains
independent Tech Lead/API/audit-owner approval. A named independent approver and
their actual decision must be recorded; this audit is not that approval.
The #25/#26/#51 issue bodies were updated with these gates and assigned to that
delivery coordinator during this audit; no duplicate follow-up issues were created.

[#51](https://github.com/takh86/SecurePlan/issues/51) owns browser→real-API→isolated-PG
acceptance; audit retention, restricted roles/append-only enforcement, access and
backup/restore; dependency package/reachability triage and fixes or explicit risk
acceptance; pre-write disposable-test-target verification and any required
read-only incident reconciliation; proxy/client-IP, counter-retention,
session/identity/logout and remaining security-review gates. Preserve its already
completed parser-hardening and CI-secret-masking evidence. Additional existing
pre-staging gates remain in [the security handoff](../security/pre-staging-gates.md).

**Administrative SP-09 closure** becomes a GO only after independent acceptance
of this evidence, controlled documents and explicit residual ownership, plus
resolution of any review findings. **SP-11 functionality acceptance** still
requires implementation and real planning/concurrency tests. **Staging/production
release** still requires browser, audit operations, dependency/security gates and
explicit release approval. Neither green SP-09 CI nor closed tracking issues
establishes either of the latter two acceptances.

Recommended next task: independent closeout review of this documentation draft
and the controlled amendment register. After acceptance, return to the separately
approved **SP-10 #24 → SP-11 #25** sequence; approve the outstanding contracts
before implementing planning. Before any further fixture-writing test, complete
or verify the #51 fail-closed test-target gate. No feature implementation starts
in this audit.
