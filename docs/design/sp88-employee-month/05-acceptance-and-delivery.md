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
| F04 | Attempt DAY+NIGHT same date with adjacent/nonoverlapping and overlapping intervals | Always reject dual; malformed union400, final invariant409; independent next-day/adjacent-month UTC overlap remains checked |
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
| F15 | 28/29/30/31-day months; 62 slot preconditions but at most31 selected states; duplicates/omissions/out-of-month/invalid dates/extra fields/body limit | Exact strict shapes/bounds, safe structural errors; no fixtures leak or arbitrary roster cap |
| F16 | D6 gaps/folds, company/device-zone mismatch, effective whole-version kind missing, creation checksum changed | Canonical resolver and saved UTC preserved; new-slot checksum drift conflicts; no hard-coded times or device-zone writes |
| F17 | Drop HTTP response after real COMMIT, later change one duty, then explicit result GET and exact retry | Original immutable receipt proves that command; no reapplication/audits; later changes remain intact; UI refreshes current state |
| F18 | Crash between claim/business; stale live claimant; FAILED recovery; expired/missing receipt; no-op receipt | Attempt fence plus exclusive I prevents takeover of active writer; GET never retries; explicit recovery only; UNKNOWN is not failure proof |
| F19 | Active lease on a changed duty (other account AND another tab of same account), released/expired lease, untouched-duty lease | Whole batch blocked for live affected lease; no token rotation/release; expired admission uses fresh clock; untouched lease/no-op remains intact |
| F20 | Live lease expires while batch waits; lease is renewed before admission; expiration after admission | Fresh post-wait evaluation decides; no transaction-start timestamp shortcut; admitted locks protect through COMMIT |
| F21 | Existing INITIAL_PUBLISH records, publish replay and schema guards across new migration | Preserve old fingerprints/results/states; operation-specific CHECKs/FKs/JSON bounds; corrupted/partial schema fails closed |
| F22 | Max safe duty version, statement/lock timeout, controlled deadlock/serialization failure | No wraparound/partial commit or blind retry; approved sanitized technical response and explicit outcome handling |
| F23 | Paint TAG1,2,5,10 then NACHT17,19 then FREI5 in November; separately15 DAY-only and15 NIGHT-only | One exclusive state/date; one atomic command; five final assignments plus exact removal, never absence |
| F24 | Repeat TAG on TAG/SHIFT_LEAD; FREI on OFF | No toggle; role/source retained; true no-op; no SICK/LEAVE writes |
| F25 | Read legacy dual; explicitly choose DAY/NIGHT/OFF, including retained SHIFT_LEAD/source | INVALID_DUAL visible, no silent normalization; correction leaves at most one, history intact |
| F26 | Strict exclusive DTO, calendar precondition drift, old independent selectedRole fields | Consistent full read; invalid request rejected; safe errors; no compatibility promise for unimplemented old DTO |

## SP-90 acceptance (actual application schema, NOT_RUN)

| ID | Fixture / action | Required result |
|---|---|---|
| G01 | All7, Mon-Fri, Mon-Sat; invalid/duplicate/out-of-range/empty weekdays | Exact ISO mapping/bounds; no universal weekend default; empty rejected under proposed P4 |
| G02 | Beta Sunday November1 plus14 valid dates | Safe PROJECT_CLOSED_WEEKDAY on1; all15 rolled back |
| G03 | Open Friday NIGHT ends closed Saturday; closed start ends open day | Start date controls; independent UTC overlap still checked |
| G04 | GET missing/inherited/exact/future; PATCH expectedExact/expectedEffective | Latest complete set<=month; absence/stale409; no time-derived weekdays |
| G05 | Migration existing projects and INITIAL_PUBLISH records | No guessed seed/cleanup; immutable0013; old Publish codec/replay; additive migration/replay/schema checks |
| G06 | Narrow weekdays with staffed/empty live duty, both lifecycles | Dependency409, preserve duties/publishedAt; next calendar version bounds interval |
| G07 | Compatible widening, exact same set, inherited-equal explicit version | Effective update, true no-op no audit, new version audited |
| G08 | MISSING no-op/remove/add/role change; allowed/invalid past bootstrap | Exact compatibility; explicit first-only bootstrap covers all duties, no default |
| G09 | First Publish missing/closed/dual including empty duty | Whole publication refused, no lifecycle/audit/completion |
| G10 | SP-11/SP-12 bypass add/move/role/time/delete and Published variants | All-writer invariant, correction permitted and existing guards retained |
| G11 | Calendar audit fails; stale version; tenant/role/session revoked | Entire calendar rollback, sanitized errors, fresh authority |
| G12 | Calendar newly closes saved date; past rewrite; future gaps | Dependencies/past edit refused; bootstrap exception explicit; no automatic invalidation |

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
| C25 | Opposite-kind SP-11 creates for same employee/project/date, UTC nonoverlap | E serializes; second cannot create dual, rollback permits opposite writer |
| C26 | SP-12 kind/date/roster edit versus batch correction | Full final set, no late opposite-duty lock or overwritten other staff |
| C27 | Calendar create/replace versus batch | P barrier, fresh token/dependencies; no partial month |
| C28 | Calendar versus SP-11 create/SP-12 edit/delete | Parent protects absence/dependency, no calendar-child -> plan inversion |
| C29 | Calendar versus First Publish | Full revalidation, no newly closed published duty or partial publication |
| C30 | Calendar versus shift config/status/second calendar/bootstrap | Same P prefix, exact optimistic preconditions/history exception |

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
| U02 | DAY→NIGHT replacement, dual rejection, explicit role preservation/change, clear-month removal review, other staff intact |
| U03 | Dirty employee/project/month/browser navigation; Publish guarded while dirty or outcome unknown; secondary editor does not steal leases |
| U04 | One invalid/conflicted date: full draft retained, safe linked error summary, explicit rebase/confirmation, no network retry loop |
| U05 | Response dropped after COMMIT: outcome-unknown UI, explicit safe lookup/exact retry, completion distinguished from refresh failure |
| U06 | Real Initial Publish dialog/bodyless request followed by Published month Save; two independent users; no SQL PUBLISHED fixture substitutes for Publish |
| U07 | 60–100-person month, keyboard/focus/error announcements, responsive layout, supported-browser sample, current company-zone contract and human UX review |
| U08 | Persistent paint before dates, repeat no toggle, authoritative closed/missing reasons, visible legacy-dual correction; November sequence, mobile/keyboard, one final Save/no date popup |

Mock/jsdom tests are useful regression coverage, not these browser proofs.
Session/role failures retain the complete input hidden in a context-bound
in-memory recovery store; only the same freshly authorized actor/company may
recover it. Prove a different login cannot display or submit it, and that no
persistent browser storage is used. Explicit confirmed discard may clear it.
Browser/tab destruction and expired receipts remain explicit recovery limits.

## Implementation PR sequence and file ownership

0. Design gate: P1-P6/T1-T4 and controlled amendments; no implementation permission inferred.
1. A1 Codex: calendar DB/API and **all existing writer/Publish guards**, compatibility/audit/actual PG tests, on integrated main after #86.
2. A2 Codex: employee-month complete API/additive receipts/session/lease transaction and actual PG proof, after A1.
3. B Claude: paint/calendar admin UI/approved adapter/recovery/real Publish. Fixtures can overlap A1/A2; enable only with backend/combined checks.
4. C independent QA: combined PG/browser/security/UX proof; fixes remain file-owner controlled.

| Owner | Concrete proposed paths / boundary |
|---|---|
| A1 calendar | New workforce/project-operating-calendars module, additive calendar migration, shared planning guards and existing writer/Publish tests; no React |
| A2 backend | New `apps/backend/src/modules/planning/employee-month-{controller,service,types}.ts`, `dto/employee-month.dto.ts`, transaction-aware planning validation/persistence helpers; narrow registration in `app.module.ts` or planning controller |
| A2 command persistence | Additive `apps/backend/migrations/NNNN_employee_month_idempotency.sql`; existing `publish-idempotency.service.ts` factoring with unchanged Publish codec; catalogue classification and appropriate command-schema validation |
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

## Effort, timeline and risks

Original62-100h SP-88-only allowance is superseded for revised combined scope;
see [remaining work/parallelism forecast](09-reforecast.md). Never double-charge
#86/#87/#91 or old Publish integration. Risks: full-month conflicts, shared-roster
footprint, missing-calendar rollout, legacy dual/empty duties, all-writer guards,
lease admission, receipt/schema regression, revocation, finite review/staging.
Dec3 remains high risk; no MUST cut or acceptance inferred from CI.

Next mission: A1 backend foundation after P/T approvals and explicit authorization,
with actual-schema seven-day/Mon-Fri + Publish/race/audit-rollback slice. See
[Claude handoff](08-frontend-handoff.md). No React edits in Codex backend mission.
