# Proposed acceptance, implementation backlog and reforecast

All SP-88 application/browser tests below are **NOT_RUN**: no runtime behavior is
implemented by this gate. Existing SP-11/SP-12/#86/#87 results are foundation
evidence only. The 14 exploratory PostgreSQL checks are separately classified.

## Functional and failure acceptance matrix

Use genuine PostgreSQL with the real NestJS HTTP boundary, final migrations,
identity guards, audit service and canonical planning tables in PR A. Assert the
entire before/after domain state (including untouched memberships, versions,
history, timestamps, leases and audits), not just HTTP codes or the first date.

| ID | Fixture / action | Required result |
|---|---|---|
| F01 | Select 15 valid dates, mixed existing/missing duties, one Save | All 15 memberships and exact duty/audit/receipt deltas commit; one business transaction |
| F02 | Same 15 dates, one selected date invalid (parameterize employment, eligibility, availability, overlap, configuration) | Atomic 409 with safe date/kind; zero changes to every domain/audit row, including provisionally created slots |
| F03 | DAY→NIGHT where DAY and NIGHT contain other staff | Remove only target's DAY membership; add/retain target in NIGHT; preserve all other IDs/roles/sources and both existing duty intervals |
| F04 | DAY+NIGHT same date, adjacent/non-overlapping; then overlapping intervals | Both valid selections commit together; invalid overlap refuses all. Also test next-day and adjacent-month overnight conflicts |
| F05 | Missing slots, existing empty duty, tombstoned historical duty | Create only selected absent live slots; reuse empty live duty; recreated slot has new ID; no empty placeholder month |
| F06 | Retained SHIFT_LEAD / REPLACEMENT membership, explicit role edit, remove then later rejoin | Retain role/ID/source unless explicitly changed; role-only update preserves source; rejoin creates new NORMAL membership |
| F07 | Identical normalized desired month with valid preconditions | NO_OP, zero domain timestamp/version/audit/lease changes; durable replayable no-op receipt only |
| F08 | Any slot version changed, replaced ID, missing→existing or existing→removed, including an unselected slot | Entire full-read-set command refuses; no silent no-op/rebase or overwriting another admin |
| F09 | Inactive, outside employment, wrong project link, wrong kind, unavailable target; invalid preserved colleague | Current canonical rules; neutral preserved-roster conflict; no other worker removed; valid removal/no-op exceptions exactly as SP-12 |
| F10 | Same key/body, reordered JSON/date array/cased UUIDs, concurrent duplicate, changed precondition/body/route | Same semantic command replays once; different command conflicts; no duplicated audits/memberships |
| F11 | Fail the Nth mandatory audit after several successful duty/member writes | All business/audit changes roll back; no COMPLETED success receipt |
| F12 | Force a real SQL constraint/error after several changes; fail receipt completion separately | All dates, history changes, versions and earlier audits roll back. No per-day commits/savepoint continuation |
| F13 | Target unavailable versus preserved colleague unavailable | Only neutral approved codes/dates; no SICK/LEAVE, colleague ID, diagnosis, holder details or raw inputs in errors/receipts/logs |
| F14 | PUBLISHED effective save and no-op; Publish race after draft read | Direct immediate Published mutations, unchanged publication instant/account, no republish; lifecycle change forces explicit review |
| F15 | 28/29/30/31-day months; 62 selected slots; duplicates/omissions/out-of-month/invalid dates/extra fields/body limit | Exact strict shapes/bounds, safe structural errors; no fixtures leak or arbitrary roster cap |
| F16 | D6 gaps/folds, company/device-zone mismatch, effective whole-version kind missing, creation checksum changed | Canonical resolver and saved UTC preserved; new-slot checksum drift conflicts; no hard-coded times or device-zone writes |
| F17 | Drop HTTP response after real COMMIT, later change one duty, then explicit result GET and exact retry | Original immutable receipt proves that command; no reapplication/audits; later changes remain intact; UI refreshes current state |
| F18 | Crash between claim/business; stale live claimant; FAILED recovery; expired/missing receipt; no-op receipt | Attempt fence plus exclusive I prevents takeover of active writer; GET never retries; explicit recovery only; UNKNOWN is not failure proof |
| F19 | Active lease on a changed duty (other account AND another tab of same account), released/expired lease, untouched-duty lease | Whole batch blocked for live affected lease; no token rotation/release; expired admission uses fresh clock; untouched lease/no-op remains intact |
| F20 | Live lease expires while batch waits; lease is renewed before admission; expiration after admission | Fresh post-wait evaluation decides; no transaction-start timestamp shortcut; admitted locks protect through COMMIT |
| F21 | Existing INITIAL_PUBLISH records, publish replay and schema guards across new migration | Preserve old fingerprints/results/states; operation-specific CHECKs/FKs/JSON bounds; corrupted/partial schema fails closed |
| F22 | Max safe duty version, statement/lock timeout, controlled deadlock/serialization failure | No wraparound/partial commit or blind retry; approved sanitized technical response and explicit outcome handling |

Security cases:

| ID | Required negative / positive proof |
|---|---|
| S01 | Missing/expired/revoked session, invalid Origin/CSRF, EMPLOYEE, contextual SHIFT_LEAD and PLATFORM_ADMIN: denied at proper precedence, no business/receipt success |
| S02 | Foreign plan or employee IDs (including actor-supplied company/project/month/employee override fields), archived resource, foreign-looking expected duty IDs: concealment and tenant-safe comparison |
| S03 | Revoke role/account/session after guard but before A/C admission, during a blocked command, and before completed replay/result GET: current authority controls; admitted-command ordering documented |
| S04 | Malicious error extension values, 63 conflicts, invalid dates/enums/pointers, SQL/stack/token/name/medical details: strict allowlist/sanitization; no arbitrary exception forwarding |
| S05 | Receipt lookup with another actor/key/route/tenant and result JSON corrupted/cross-tenant FK insertion: no disclosure; server-owned bounded result only |

## Real concurrency schedules

For **each** C-family below, run both writer orders and release the first writer
by COMMIT and ROLLBACK: four schedules per family (24 families → 96 planned
schedule cases, not an executed test count). Observe blocking with distinct
sessions and `pg_blocking_pids` / hooks at known boundaries. Sleep alone is not
proof. Use real HTTP writers where possible, with narrowly scoped barriers that
pause production transaction paths, not stand-in lock tables. Clean up clients
and barriers after failures without forced database termination.

| ID | Competing writer versus employee-month Save | Principal invariant |
|---|---|---|
| C01 | Availability SET | Fresh neutral exclusion after E wait |
| C02 | Availability CLEAR | No stale absence decision |
| C03 | Availability batch commit | Same E ordering; no planning locks added to workforce |
| C04 | Employment-period change | Fresh inclusive dates, existing D5 guard |
| C05 | Shift eligibility change | Current kind eligibility, no partial month |
| C06 | Employee/account deactivation | Ordered account prefix, future-duty guard, no E→A cycle |
| C07 | Project-month assignment create | Missing link protected by E |
| C08 | Assignment correction | Old/resulting D2 dependency scope retained |
| C09 | Assignment removal | D2 refusal or fresh missing-link conflict |
| C10 | Existing effective configuration replacement | P lock and D3, including empty duties |
| C11 | New whole effective configuration version | Fresh creation checksum/kind interval; no per-kind inheritance |
| C12 | Project deactivate/archive | P status, D4 dependency and concealment |
| C13 | Actual First Publish endpoint | L serialization, fresh lifecycle and full Publish revalidation |
| C14 | Duty create, empty and staffed variants | Absent slot protection, one live slot, no hidden phantom |
| C15 | SP-12 PATCH, roster and date/kind variants | Full roster/versions and discovery drift; no overwrite |
| C16 | SP-12 DELETE | Tombstone/recreation identity and rollback |
| C17 | Lease acquire, own/other account variants | No batch bypass/rotation or late D/Q→L |
| C18 | Lease renew around expiry | Fresh expiry after wait |
| C19 | Lease release | Safe later admission and preserved release contract |
| C20 | Second batch, same employee | Complete read-set conflict; no duplicate month |
| C21 | Second batch, different employee sharing several duties | All D before all A2 before all Q, sorted tiers; preserve each employee |
| C22 | Second batch in another plan/month sharing roster employees | Global E order, overnight overlap across plan boundaries |
| C23 | Acting-account role revocation/deactivation | A admission/replay security and no lock upgrade |
| C24 | Acting-session logout/reset revocation | Session recheck under A; no late validateAndTouch |

Where an existing D2/D3/D4/D5 guard forbids a workforce COMMIT, assert that refusal
and rollback rather than disabling it. Also supply a feasible dependency-free
fixture so a permitted competing COMMIT is actually exercised. Include a newly
appearing roster employee after initial discovery: batch aborts without locking
that E late. Test shared duties with interleaved UUIDs and more than one lease,
including opposite client selection order. Test the short-claim context-FK prefix
against publication/deactivation as well as the business transaction.

## Browser and interaction acceptance

| ID | Real browser → real API → verified disposable PostgreSQL proof |
|---|---|
| U01 | 15 local selections, one final Monat speichern, one batch POST, full persisted month after reload |
| U02 | DAY→NIGHT, DAY+NIGHT, explicit role preservation/change, clear-month removal review, other staff intact |
| U03 | Dirty employee/project/month/browser navigation; Publish guarded while dirty or outcome unknown; secondary editor does not steal leases |
| U04 | One invalid/conflicted date: full draft retained, safe linked error summary, explicit rebase/confirmation, no network retry loop |
| U05 | Response dropped after COMMIT: outcome-unknown UI, explicit safe lookup/exact retry, completion distinguished from refresh failure |
| U06 | Real Initial Publish dialog/bodyless request followed by Published month Save; two independent users; no SQL PUBLISHED fixture substitutes for Publish |
| U07 | 60–100-person month, keyboard/focus/error announcements, responsive layout, supported-browser sample, current company-zone contract and human UX review |

Mock/jsdom tests are useful regression coverage, not these browser proofs.
Session/role failures retain the complete input hidden in a context-bound
in-memory recovery store; only the same freshly authorized actor/company may
recover it. Prove a different login cannot display or submit it, and that no
persistent browser storage is used. Explicit confirmed discard may clear it.
Browser/tab destruction and expired receipts remain explicit recovery limits.

## Implementation PR sequence and file ownership

0. **Design gate (this Draft PR):** PO decisions P1–P3, technical/security T1–T4,
   controlled amendment version/date and baseline backports assigned. Review is
   separate from granting implementation authority. Foundation owners resolve
   #86 and #87 review/merge conditions; no design commits go onto either PR.
1. **PR A — backend, Codex/backend owner:** branch from integrated current main,
   after #86. Ship the complete atomic API, read/result projections, command
   persistence migration, approved lease admission/session read contracts,
   shared validation overlay and real PostgreSQL/HTTP/security/concurrency tests.
   Do not merge a new writer without all affected guards and protocol integration.
   No React changes. Preserve #86 Publish and SP-12 behavior by regression tests.
2. **PR B — React, Claude/frontend owner:** build on bounded #87 foundation and
   approved A contract. Employee-month draft/review/reconciliation, batch/result
   API, matrix integration, unsaved navigation/Publish guard, safe conflict and
   unknown-outcome states. Keep the existing duty editor as a secondary tool.
   Frontend may develop against approved contract fixtures in parallel with A;
   production enablement/merge waits for actual A and combined verification.
3. **PR C — combined acceptance/integration, coordinated lead/QA:** integrate the
   actual Publish dialog and month editor, bodyless Publish transport, real
   browser scenarios, negative tenant/session and CR-03 regression. Claude owns
   React/client fixes; backend owner owns backend fixes. Run exact combined-head
   CI and independent review. Record human UX acceptance and residual #85/#88
   criteria. This bounded admin flow does not implement SP-14 or certify the MVP.

| Owner | Concrete proposed paths / boundary |
|---|---|
| A backend | New `apps/backend/src/modules/planning/employee-month-{controller,service,types}.ts`, `dto/employee-month.dto.ts`, transaction-aware planning validation/persistence helpers; narrow registration in `app.module.ts` or planning controller |
| A command persistence | Additive `apps/backend/migrations/NNNN_employee_month_idempotency.sql`; existing `publish-idempotency.service.ts` factoring with unchanged Publish codec; catalogue classification and appropriate command-schema validation |
| A security/audit | Identity-owned transaction-aware session-read contract; `common/errors/error-contract.ts`, specific safe conflict validator and `common/filters/problem-details.filter.ts`; existing audit service only if approved scope needs a type extension |
| A tests | New `apps/backend/test/employee-month-{real,concurrency-real,failures-real}.e2e-spec.ts`; DTO/fingerprint/overlay specs; reuse `test/helpers/planning-fixtures.ts`, isolated DB and observed-blocking patterns; extend Publish migration regressions |
| B frontend — exclusive Claude ownership | `apps/frontend/src/features/planning/monthly-plans/**`: new EmployeeMonthEditor/draft/API/tests; `MonthlyPlanPage.tsx`, `MonthlyPlanningSection.tsx`, matrix, CSS and PublishSlot dirty-state integration |
| B/C shared frontend seam — Claude only | `apps/frontend/src/features/auth/session-api.ts` bodyless POST/result GET headers; app-shell integration tests only as needed; coordinate path ownership before edits |
| C browser harness | Dedicated employee-month browser scenario/harness, coordinated with `scripts/sp12-a10-browser-acceptance.mjs` from #87; backend fixtures remain synthetic/disposable; assign a single harness file owner before changes |
| Design/evidence | Dedicated `docs/design/sp88-employee-month/**` now; later A/B/C evidence files and a scoped new ADR supplement after approval; no rewrite of historical review reports |

Avoid speculative repository moves or a new general scheduling framework. Reuse
the duty resolver, employee/workforce read contracts, account prefix, existing
SQL constraints, audit shapes and test infrastructure. Refactor only what the
atomic transaction requires. No cancellation/replacement logic, SP-14, #51
operational work or frontend modifications belong to the backend mission.

PR A verification: lint, typecheck, both builds, backend unit/security tests,
verified real-DB E2E, migration twice/checksum/rollback/catalogue verification,
script/public checks and exact-head CI. PR B adds frontend/component/keyboard
tests and build. PR C adds real browser and supported-browser/human acceptance.
Report exact commands/counts and all failures/NOT_RUN results per PR. Never
reuse a development `.env` or infer safety from a localhost URL.

## Effort, timeline and risks — proposed reforecast

Engineering ranges are estimates, not elapsed hours or an approved schedule.
They assume the existing foundations are available, contracts are frozen, existing
test hooks can be reused and no SP-14/M5/#51 work is pulled into SP-88.

| Work | Estimated focused effort | Principal uncertainty |
|---|---|---|
| Remaining controlled decisions, amendment backports and independent design review | 4–8h | Review turnaround and domain/default changes |
| A: backend/migration/read+result API/overlay/leases/security and PG matrix | 28–44h | Shared-roster conflicts, recovery/FK prefix, session races and test hooks |
| B: primary month editor, review/rebase/recovery and frontend regression | 18–28h | 31-day UX, preserved roles, existing-editor coordination |
| C: Publish integration and genuine browser/security/regression evidence | 12–20h | Bodyless POST seam, drop-response harness, cross-browser/zone UX |
| **SP-88 delivery package** | **62–100h** | Re-estimate after approval and first backend concurrency slice |

Some C work overlaps the old SP-13/A10 integration allowance. Credit it explicitly
when rebuilding the remaining backlog; do not add both full allowances. The
company-zone display decision and any new API, major defects or operational #51
work are not silently included. Existing #86/#87 implementation effort has
already occurred and is not to be charged again as new implementation.

The Nov 2 v1.2 DRAFT used 108h historical SP-13–27 plus 10–16h A10, against an
upper-bound 160 gross hours through Dec 3 (112 planned + 48 reserve, Mo–Thu).
Those figures predate #88 and do not measure today's accepted remaining work.
Replacing that old A10 line with this package, **before crediting completed
#86/#87 and overlapping integration**, gives a deliberately conservative
170–208h scenario (108 + 62–100), above 160h. It is not a current remaining-hours
claim. Actual Nov 2 time, meetings, review availability and the rest of SP-14–27
must be measured before making a reliable completion promise.

Reforecast formula: `new remaining = re-estimated remaining MUST backlog after
foundation/integration credits + uncredited SP-88 work`. Reserve is at most 48h
before existing overruns, less than this package's 62h lower bound. On one
engineer's 8h gross days it represents about 8–13 additional days (roughly 2–3+
Mo–Thu weeks), with productive time/review potentially longer. Agent parallelism
does not create unlimited human implementation/review capacity.

| Conditional window | Gate, assuming prompt approval and actual parallel owners |
|---|---|
| Nov 3–5 | Freeze contracts/CR and foundation scope; begin A with migration, one shared-duty atomic slice and rollback tests |
| Nov 9–12 | Complete A concurrency/security matrix; B develops approved contract and retained-input states |
| Nov 16–19 | Integrate A/B and complete C real Publish + employee-month scenarios and UX review |
| Nov 23–26 | Resolve SP-88 regressions; protect remaining MUST feature-freeze evidence |
| Nov 30–Dec 3 | Retain release regression/demo/acceptance capacity; do not plan new features here |

These are proposed checkpoints, not commitments. The former Nov 5 G2 goal cannot
be used as full #88 acceptance. Dec 3 is **high risk / uncommitted** until the
owner approves an actual remaining-capacity plan. Recommend reuse/limited UX
scope within the approved workflow and real additional implementation/review
capacity, or a date change. Do not silently weaken atomicity, reduce the MUST
workflow, consume all QA reserve or assume Fri–Sun overtime.

| Risk | Consequence | Mitigation / owner |
|---|---|---|
| Full-month versions and plan admission contention | More stale conflicts and parent locks than single-duty editing | Explicit P1/T2 trade-off, measure realistic rosters, retain/rebase whole draft |
| Lease shortcut or per-duty mini-transactions | Lost edits, token invalidation, partial month or deadlock | Approved internal admission, all D→all A2→all Q, real multi-duty races |
| Snapshot-based per-add validation | False DAY→NIGHT errors or hidden mutual overlaps | One final-state overlay with cross-month UTC tests |
| Incorrect idempotency generalization | Duplicate edits, corrupted Publish replay or private result leaks | Discriminated additive migration, immutable receipt, exact codec/old-record tests |
| Guard-to-command revocation gap | Authorized-at-load but revoked-at-save writer | Identity-owned fresh session read under A/C; security race tests |
| Unapproved dual-shift/empty-duty semantics | UX conflicts with controlled baseline | P1/P2 decision and dated amendment before coding |
| Unknown outcome + silently discarded draft | Repeated mutation or lost selection | Explicit result lookup/exact retry and separate reconciliation state |
| Remaining MVP scope and review capacity | Dec 3 target lacks credible reserve | P3 measured reforecast; no automatic MUST cuts or production claims |

Recommended next coding mission: **only after this gate's contract/security
decisions and explicit implementation authorization**, PR A on integrated main,
backend only, with a 15-date atomic slice and real failure/shared-duty lease
tests first. Do not begin with a frontend loop over existing PATCH endpoints.
