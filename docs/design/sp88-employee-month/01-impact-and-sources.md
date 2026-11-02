# Requirements, scope and source review

All SP-88-specific contracts in this package are proposals until the decision
sheet is signed. Source precedence is approved amendments, effective MVP,
controlled final contracts with approved supplements, then implementation and
review evidence. Historical drafts and a passing test run do not create authority.

## Source register

Controlled originals were inspected locally; they are not copied into this PR.
Private-source identifiers below allow the owner to locate the controlled copy.
The public proposal contains synthetic examples and bounded engineering findings.

| ID | Inspected source / exact revision | Finding relevant to SP-88 |
|---|---|---|
| S01 | Phase 2 FINAL Requirements Baseline v1.1, sections 5–8, 17–23 | Employee/month project membership, configurable DAY/NIGHT, duty roles, reliable writes, audit, safe errors and accessibility |
| S02 | Phase 3 FINAL Scope/MVP v1.1, M2/M3/M4/M8; [effective MVP](../../requirements/effective-mvp-baseline.md) | Manual monthly planning is MUST; Excel is Stretch; no new replacement, payroll or day-plan vertical |
| S03 | Approved CR-01, CR-02 and [CR-03](../../requirements/cr-03-direct-published-plan-updates.md), including CR-03 controlled DOCX | No replacement quota; fixed session-derived tenant; direct Published mutation supersedes old draft/republish language |
| S04 | Phase 4 professional v1.1 UC-03/04/05, read with [FINAL v1.2](../../systemanalyse/phase-4-final-v1.2.md) and controlled v1.2 DOCX | Extend manual create/edit flow; Initial Publish remains separate UC-05; CL-04-01/02 keep availability minimal and configuration project-owned |
| S05 | Phase 5.3 FINAL UF-02; 5.5 ST-12/conflict states; 5.6 FINAL WF-DEC-01/A10; 5.8 handoff; [Phase 5 gate](../../ux-ui/phase-5-baseline.md) | Employee×day matrix, focused editor, unsaved-input protection, explicit Save/Publish; wireframe has Frei/Tag/Nacht radio selection |
| S06 | Phase 8.2 public endpoint summary; controlled FINAL 8.3 DTOs §7, 8.4 validation/publish, 8.5 errors, 8.6 security, 8.7 §§2–12, 8.10 tests and 8.11 gate | Duty aggregate/version, 409 stale writes, leases, selective command idempotency, atomic audit, tenant concealment; no employee-month command approved |
| S07 | SP-11A Rev3.1 T1/T3/T5, K1–K3 and dated owner supplements; [ADR-0003](../../architektur/adr/0003-schichtkonfiguration-monatsversioniert.md), [ADR-0004](../../architektur/adr/0004-related-business-audit-catalogue.md), [ADR-0006](../../architektur/adr/0006-duty-edit-leases.md) | Final L1 order overrides older Duty-first sketches; tombstones, UTC provenance, full resulting-roster validation; bulk month save excluded from SP-11 approval |
| S08 | `main@13b680c07929ae595c196a523a32d4226bfa8e64`, migrations 0001–0012 | Actual SP-11/SP-12 services, conditional duty versions, unique live slots/memberships, leases, workforce guards and schema classification |
| S09 | [PR #86](https://github.com/takh86/SecurePlan/pull/86), head `e30db8fb6a2db851e154c9d6dbf6ebcdf94129e2` | First-Publish service, bounded approved publication audit, reservation fencing, migration 0013 restricted to INITIAL_PUBLISH |
| S10 | [PR #87](https://github.com/takh86/SecurePlan/pull/87), head `662985e7d137940c8f6443bcf93ebb7eabd95423` | Actual React matrix, complete single-duty roster PATCH, lease controller, input recovery and Publish render slot; no month save |
| S11 | [#88](https://github.com/takh86/SecurePlan/issues/88), [#85 owner decision](https://github.com/takh86/SecurePlan/issues/85#issuecomment-6586164552), [#87 owner note](https://github.com/takh86/SecurePlan/pull/87#issuecomment-6586166111) | Employee-month primary workflow and atomicity approved; detailed design/implementation not approved; #85 stays open |
| S12 | SecurePlan MVP Reforecast 2026-11-02 v1.2 DRAFT; Phase 10 Restlaufzeitplan v1.1 | Dec 3 target, historical 108h SP-13–27 and 10–16h A10 allowance; neither is a measured current remaining-effort figure |
| S13 | PostgreSQL 17 [row locks](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS) and [isolation](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED) | Lock conflicts and fresh statement snapshots support the proposed short transaction; application integration still needs real tests |

Phase 8.1 remains a resource-analysis draft. Old ADR-0003 temporary-guard and
unresolved-DST notes are historical; its ratified SP-11 addenda and shipped
resolver/guards control. BR-SHIFT-03 legal rest-time policy remains a production
follow-up; it is not permission to invent an MVP hours or staffing rule.

## Traceability and required controlled changes

`A-SP88-*` below are **proposed amendment identifiers**, not approved CR numbers.
The owner should assign a controlled change identifier; do not presume CR-04 is
available. Preserve the original baselines and record approval/version/date.

| Requirement / controlled contract | Existing obligation | SP-88 impact and disposition | Acceptance reference |
|---|---|---|---|
| Phase 3 M4; FR-MP-05/08/09; UC-03/04 | Manual planning, duty edits and membership changes | A-SP88-01 adds one employee's month as a single command boundary, while Duty stays canonical | F01–F10 |
| NFR-REL-01/02; #88 owner decision | Related changes atomically commit/roll back | Approved atomic requirement now spans all selected dates and all mandatory audit | F01/02/11/12 |
| NFR-CONC-01; Phase 8.7 D-8.7-01/02; ADR-0006 | Duty versions; independent single-duty edits | A-SP88-02 adds a full-month read set and short L UPDATE barrier for this command only, with conservative stale conflicts; no global plan revision | F08; C01–C24 |
| Phase 5 WF-DEC-01/A10 and UF-02 | Matrix, focused cell/day editor, save/publish | A-SP88-03 makes employee-month editing primary and a single final Save; PR #87 editor becomes a secondary tool | U01–U07 |
| Phase 5.6 A10 radio; UF-02 multiple-booking exception | Frei/Tag/Nacht single-choice sketch; prevent simultaneous assignments | A-SP88-03 must explicitly resolve DAY+NIGHT on the same local date. Recommend allowing both only when saved/resolved UTC intervals do not overlap | F04; U02 |
| BR-DATA-02; Phase 8.3 aggregate mapping | One plan per project/month; Duty contains memberships | Read projection is not a new persisted employee-month plan. No alternate roster source or cross-month command | F05/15 |
| BR-PROJ-01/02/03; FR-PROJ-01; SP-11 D2 | Single project per employee/month; traceable assignment corrections | Save never creates/corrects project assignment; revalidate current link, preserve D2 protections | F09; C07–C09 |
| FR-SHIFT-01/02; BR-SHIFT-01; SP-11 D6 | Configured shift kinds/times, overnight resolution | New duty uses effective whole configuration and company zone; existing duty retains saved UTC/provenance. No hard-coded 12h shift | F04/05/16; C10/11 |
| BR-MP-04/05/07/08 as replaced by CR-03 | First Publish only, immediate validated Published edits | A-SP88-01 applies identically to both lifecycle states. Fresh lifecycle precondition prevents an unnoticed switch to immediate Published effects | F14; C13 |
| FR-MP-08; contextual SHIFT_LEAD | Duty-bound function, not account role | Preserve retained membership function/source/ID; explicit role change only; no required leader count | F03/06 |
| Phase 4 CL-04-01; SP-10 availability; privacy baseline | Neutral eligibility facts; no medical free text | Frei removes this employee's memberships only. No availability writes; conflict payload never reveals SICK/LEAVE or another worker's facts | F09/13; S01–S05 |
| SEC-AUTHZ-01; SEC-SESSION-01; CR-02; Phase 8.6 | Live authority, tenant and resource scope | Recheck account/company/session under the prefix; all SQL tenant-scoped, all new result references composite-scoped | S01–S05; C23/24 |
| BR-AUD-01/02/03; M8; ADR-0004 | Critical changes auditable with transaction | A-SP88-04 extends usage of existing duty/membership events to this command; bounded payloads, no new event vocabulary | F07/11/12/17 |
| NFR-REL-03/04; Phase 8.7 D-8.7-05–08 | No duplicate effects; durable command recovery | A-SP88-05 adds a separately fingerprinted operation, immutable result and safe status read; 0013 cannot be used unchanged | F10/17/18 |
| NFR-ERR-01/02; Phase 8.5 | Safe actionable conflicts | A-SP88-06 adds a validated batch-conflict extension and one proposed error code; unknown payloads remain fail-closed | S04; U04 |
| NFR-UX-03/04/05; NFR-A11Y-01/02; ST-12 | Visible state, explicit confirmation and keyboard access | Keep entire draft through conflict/rebase; per-date errors and retained-role/removal review, no implicit retry | U01–U07 |
| M8/API 8.9/8.10/8.11 | OpenAPI, traceability, quality evidence | Update canonical controlled artifacts and acceptance matrix with approved amendment in implementation PR A | All |
| Phase 10 / Dec 3 forecast | Measured remaining effort and scope discipline | A-SP88-07 reforecasts meaningful new work; no silent MUST cuts or assumed weekend capacity | Delivery gates |

The single-choice UI wording is a genuine design conflict, not an authorization
to impose one duty per calendar day on the backend. Conversely, the backend's
non-overlap behavior alone does not approve a dual-selection primary UI.

## Code impact and independent foundations

Inspected backend: `monthly-plans.service.ts` (`createEntry`, `lockMutation`,
`updateEntry`, `assertStaffing`, `visiblePlan`), controller/DTOs, duty lease
helpers, `planning-schema.ts`, account prefix, session validation/revocation,
Problem Details filter and migrations. SP-12 PATCH receives the complete roster;
calling it repeatedly would both expose partial commits and risk replacing other
staff with an employee-only roster. A batch needs one owning application service
and transaction-aware shared validation/persistence primitives.

Inspected #87 code: draft diff/roles in `duty-editor-model.ts`, lease API calls,
`MonthlyPlanPage.tsx` PublishSlot, matrix projection and `session-api.ts`.
PublishSlot currently observes only the single-duty draft. PR B/C must include
the employee-month draft and unknown-outcome state in that guard.

Both PRs were OPEN, unmerged and GitHub-reported mergeable at investigation.
Their changed file paths are disjoint. #86's CI run
[41498339369](https://github.com/takh86/SecurePlan/actions/runs/41498339369)
and #87's exact-head PR run
[41503238081](https://github.com/takh86/SecurePlan/actions/runs/41503238081)
were successful evidence for their respective foundations, not a combined head.

Recommendation: **#86 can proceed independently through its existing backend
review gate. #87 is a usable foundation, but its merge is conditional on an
explicit bounded foundation-scope decision**, consistent with the owner's note
to keep it in review. It does not implement the newly approved primary workflow
or close #85. Prefer #86 first; the #87 owner then integrates current main without
force-push and runs combined-head checks. This gate performs no such merge.

There is a concrete integration gap: #87 serializes an omitted POST body as `{}`;
#86 requires a truly bodyless Publish POST. The future frontend owner must add an
explicit bodyless option and test transmitted bytes. #87's Published browser
fixture is not a call to the real Publish endpoint. Company-IANA-zone API/display,
large-grid usability and human accessibility/UX sign-off also remain separate
gates. This design does not quietly add a company-zone API field.
