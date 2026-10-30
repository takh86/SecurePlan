# SP-11 integrity handoff from Issues #64 and #73

Date: 2026-10-29. Implementation baseline: `7107781e1cbd9aab232cd394662372c1fb7cf92f`.
Accountable delivery owner: [@takh86](https://github.com/takh86).
Tracking: [SP-11 #25](https://github.com/takh86/SecurePlan/issues/25), continued in
[#26](https://github.com/takh86/SecurePlan/issues/26). Operational acceptance belongs
to [#51](https://github.com/takh86/SecurePlan/issues/51).

The [PO decision D1–D6](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6502123168)
approves the business rules below. Detailed API, relational and concurrency
contracts still require independent Tech Lead/API review. No SP-11 implementation
or planning-table migration is delivered by this handoff. Each numbered item has
its own acceptance checkbox in #25; none inherits a PASS from SP-09 CI.

## SP-10 handoff — 30 October 2026

The owner approved the scoped SP-10 technical contract in
[#24](https://github.com/takh86/SecurePlan/issues/24#issuecomment-6530983248).
[ADR-0005](../architektur/adr/0005-availability-batches.md) and
[executed evidence](../reviews/sp10-availability.md) describe daily facts and the
internal privacy-neutral Workforce read. Both availability tables are classified
as non-planning; neither temporary planning guard is disabled.

SP-10 can record a fact without changing a duty. **E-04 remains a required SP-11
integration:** if a published duty already exists, preserve it exactly and make
the administrative conflict discoverable through the approved planning model.
If absence exists first, planning/publish/replacement eligibility must revalidate
under the approved workflow locks and refuse ineligible assignment. The neutral
read alone is not complete eligibility, duty-conflict reporting or resolution.

Integrate employee protection before dependent scans and use fresh statements
after waits. SP-10's approved employee/command order does not ratify global
LOCK-01 or resolve Duty-first/assignment/plan lock placement below. Duty-date,
overnight mapping, bounded conflict projection and lifecycle remain explicit
SP-11 decisions. No quota, automatic reassignment, cancellation or republish is
introduced. Carry these acceptance obligations into #25/#26; no SP-10 test total
passes them. The following dated SP-09 handoff remains intact.

## Existing behavior to preserve

- Assignment correction and removal use `assertPlanningDependencyCheckImplemented`;
  shift replacement uses `assertShiftConfigurationPlanningCheckImplemented`.
  Both temporary implementations still count classified planning relations and
  fail closed. They are unchanged by this documentation work.
- Keep the classification and migration/catalogue tripwires. Introducing planning
  tables must integrate **both** real guards and all three consumers in the same
  approved integration scope. Never disable a guard because tables now exist.
  An incomplete or unknown dependency model must still refuse the mutation.
- PRs #70/#71/#72 establish future-target employment/status correction rules;
  #74 establishes future-only, versioned removal; #75 adds S-9 discovery;
  #76 protects employment dates against newly excluded future monthly links.
  None implements actual duty dependency checks.
- The company timezone and trusted session tenant remain authoritative. An
  assignment month at or before the company-local current month is historical
  for Case 2. This does not classify every duty in that month as past.

## Shared contract and concurrency gate

Every new query, join, aggregate, lock and mutation must use the trusted tenant.
Retain default-deny roles, Origin/CSRF, transactional actor recheck, concealed
404s, sanitized errors and server correlation IDs. A dependency refusal must
write neither business state nor a success audit. A successful effective write
and its mandatory audit must commit together; audit failure rolls both back.
Preserve existing true-no-op and version/error precedence. Do not add automatic
reassignment, cancellation, vacancies, historic repair or blind write retries.

**LOCK-01 — unresolved architectural contract:** current assignment writers lock
actor account/company → employees in ID order (`NO KEY UPDATE`) → projects in ID
order (`SHARE`) → monthly assignment (`UPDATE`). Employment PATCH uses employee
`UPDATE`, followed by a fresh READ COMMITTED impact statement. Shift/project
PATCH use project `NO KEY UPDATE`. Existing handoff prose has placed the monthly
assignment both before and after planning locks; the controlled planning/workflow
baseline additionally requires a Duty-first order within duty/workflow changes.
These sequences are not a reviewed global protocol merely by being concatenated.

Before coding, approve one lock graph for every workforce, duty, plan-membership,
publish and replacement writer. Specify whether the assignment row precedes
planning rows, where a MonthlyPlan lifecycle lock is necessary, and how all
paths acquire shared employee/project protection **before** revalidation. Prove
that no path takes those locks in the opposite order. Preserve deterministic
ordering for multiple employees/projects/duties. A missing-row dependency check
cannot rely solely on locks on rows that already exist; use an approved shared
parent-lock protocol or equivalent protection against concurrent inserts.
FK existence checks alone do not enforce employment or dependency semantics.

Required PostgreSQL proof for each affected writer pair: both acquisition orders,
observed blocking using deterministic barriers, COMMIT and ROLLBACK, a dependency
insert while the other transaction waits, a fresh post-lock snapshot, audit
failure, and absence of deadlock/orphan/partial commit. Define technical timeout
handling separately from business 409s; never relabel a timeout as a stale human
decision. No new lock order is approved by this document.

## D2 — monthly assignment correction and removal dependencies

**Approved:** reject an effective assignment PATCH or eligible future DELETE
when it would orphan, invalidate, detach or contradict dependent duties or
plan assignments in **DRAFT and PUBLISHED** plans. Check affected old and resulting
employee–project–month relationships; unrelated tuples do not block. Preserve
historical correction exceptions, no-op, #73 Expected-Version, tenant-safe 404
and the restriction against current/past DELETE. Safe, proven independent
operations remain possible; unknown dependencies fail closed. This decision
does not weaken historical planning protection.

**API/DB decisions before coding:** define actual duty/plan-assignment relations,
FK versus tuple-based dependency predicates, active/removed assignment lifecycle,
draft storage vocabulary (existing design may call it UNPUBLISHED), old/new
tuple evaluation and historical-path compatibility. Keep
`409 PROJECT_ASSIGNMENT_CORRECTION_CONFLICT` for dependency refusal and the
existing separate stale-version `PROJECT_ASSIGNMENT_CONFLICT`; review exact
safe response wording/precedence without exposing plan details. Do not extend
this monthly endpoint into a duty-removal workflow.

**Components and locks:** assignment `correct`/`remove`, their shared guard,
Planning eligibility and every duty/plan-assignment writer, monthly assignment
FKs/indexes and plan lifecycle operations. Resolve LOCK-01 first. Every dependency
creator must participate in the approved employee/assignment lock protocol;
DELETE alone does not acquire a parent employee lock through its FK.

**Real-PG acceptance:** PATCH employee/project/month separately and combined;
DELETE with current/stale version; DRAFT and PUBLISHED; old and resulting tuple;
unrelated employee/project/month/tenant; no-op; current/past historical regression;
missing/unknown relational state; concurrent dependency create/move/delete,
assignment POST/PATCH/DELETE and employment edit in both orders, including audit
rollback. Refusals retain exact rows/versions and emit no success audit.

**Frontend acceptance:** show safe planning refusal, retain correction inputs,
close removal confirmation and refresh authoritative state, use a fresh version
for any later confirmation, and require explicit duty resolution. Cover lost
responses, focus and employee switching; no blind DELETE retry.

**DoD:** relational/API/lock contracts approved and reconciled; both temporary
guard consumers replaced together with planning integration; all tests above,
tripwire successors, route/security regressions, green relevant CI and independent
review. Browser acceptance needs a separate real browser→API→isolated-PG run.

## D3 — saved duties and a configuration's effective interval

**Approved:** reject an effective full-set replacement for project P/month M
when saved DRAFT or PUBLISHED duties depend on the configuration in
`[M, next later effective month of P)`, or forward without end if none exists.
Earlier dates, unrelated projects and later versions do not block. Retain UTC
duty snapshots, prior versions and true-no-op behavior; never recalculate duties.

**API/DB decisions before coding:** finalize saved-duty lifecycle and the exact
predicate for replacing an existing version versus inserting an intervening
version. Explicitly test creating M between two versions; it changes the effective
interval even when nominal times match. Confirm next-version boundary queries,
publish revalidation and time/snapshot ownership. Preserve
`409 SHIFT_CONFIGURATION_CONFLICT`, sanitized payload and existing precedence.

**Components and locks:** ShiftConfigurationsService, its guard, effective-version
query, saved duties and create/update/publish writers. Configuration writes keep
project `NO KEY UPDATE`; duty writers must obtain conflicting project `SHARE`
before reading/revalidating the configuration. Review their placement under
LOCK-01. Serialize next-version changes on that same project parent.

**Real-PG acceptance:** time change, omitted kind and new/intervening version;
DRAFT/PUBLISHED; duties just before M, at M, just before and exactly at the next
version, open-ended interval, other project/tenant, absent duties and no-op.
Run config edits versus duty create/update/publish and competing version writes
both ways with commit/rollback and failed-audit rollback. Existing duty UTC
snapshots must be byte-for-byte unchanged.

**Frontend acceptance:** retain entered configuration on conflict; explain that
dependent duties need explicit resolution, refresh before another save and keep
no-op behavior. The configuration UI already exists as `ShiftConfigurationSection`
on Project Detail (merged #62); add real dependency-refusal cases to its existing
form/error/focus regressions. Browser acceptance remains NOT_RUN.

**DoD:** approved interval/lifecycle/lock contract, real scoped guard integrated
alongside D2 when planning tables arrive, documented error/audit behavior,
Real-PG and relevant UI evidence plus independent review. Successful effective
replacement retains one `SHIFT_CONFIGURATION_UPDATED`, never one event per duty.

## D4 — project deactivation and unresolved future duties

**Approved:** block transition to INACTIVE while unresolved future scheduled
duties in DRAFT or PUBLISHED plans remain. Administrators resolve duties explicitly.
**Case 3b remains unchanged:** monthly assignment rows alone never block project
deactivation, and retained monthly links are not deleted.

**API/DB decisions before coding:** define unresolved lifecycle states, empty
versus staffed duties, cancellation/replacement-in-progress, the future cutoff
and cross-midnight/in-progress interpretation. Decide one captured instant and
company-local date policy, the exact **new safe 409 code/type/detail**, precedence,
whether bounded recovery hints are allowed, and operator recovery. No code for
this new project-PATCH condition has been approved; do not repurpose another
conflict. Approve any new audit shape separately; refusal has no success audit.

**Components/security/locks:** ProjectsService.update, duty/plan/workflow lifecycle,
eligibility and project locks. Use tenant-scoped predicates and concealed project
lookup before hints. Project `NO KEY UPDATE` and all duty writers' shared project
protection must prevent an insert after the empty check; reconcile LOCK-01 and
revalidate after waits. A permitted project edit keeps its existing atomic audit.

**Real-PG acceptance:** every agreed unresolved/resolved state × DRAFT/PUBLISHED;
future/current/past and midnight boundaries; retained monthly links with no duties
still permit INACTIVE; other tenant/project; unchanged status no-op; mixed
name/status PATCH rejects atomically; deactivation versus duty create/resolution,
publish and rollback in both orders, with no orphan or success audit on refusal.

**Frontend acceptance:** preserve edited project data, show the approved safe
conflict, link to the approved duty-resolution flow without exposing foreign
data, refresh and require an explicit retry. Never auto-cancel or move duties.

**DoD:** API owner approves the code and lifecycle/reference-time contract;
controlled amendments, implementation, Real-PG/UX/CI and independent review pass.
Monthly Case-3b regression remains green.

## D5 — employment dates and future duties including the current month

**Approved:** block an effective employment-bound edit only if a future duty was
covered before and is newly excluded: `futureDuty && covered(old,dutyDate) &&
!covered(next,dutyDate)`. Include future duty dates inside the company-local
current month. Preserve Case-2 monthly behavior, already-invalid/history
exceptions, no-op and non-date edits. Employee deactivation's duty-specific
`EMPLOYEE_HAS_FUTURE_ASSIGNMENTS` rule remains a separate safeguard.

**API/DB decisions before coding:** define duty-date versus resolved start/end
instant, inclusive coverage, same-day future and overnight/in-progress behavior,
relevant duty/assignment lifecycle and one captured reference time. Approve the
duty-conflict code/schema and precedence when monthly and duty conflicts coexist;
the existing monthly 409 cannot silently acquire duty references. Approve bounded
historical-impact audit context, if needed; do not insert duty arrays into the
existing count-only monthly context or reinterpret that count as a duty check.

**Components/security/locks:** employee update/impact query, duty eligibility and
every writer moving a duty or employee. Keep tenant/employee scoping, actor
recheck and employee `UPDATE`; duty writers need compatible ordered parent
protection before validation. Resolve LOCK-01; read impacts in a fresh statement
after the lock, never a stale pre-wait snapshot. Rejection of mixed fields is
atomic and unaudited; accepted edits keep one transactional employee audit.

**Real-PG acceptance:** start/end/both/null, inclusive boundaries, no-op/non-date,
already-invalid duty, historical duty, future duty in current month and later
month, current-month monthly link alone, leap/year/IANA boundaries, overnight
and in-progress cases per approved policy. Both-order races against duty
create/move/remove, date edits, deactivation and publish, plus failed audit,
tenant concealment and exact bounded response projection.

**Frontend acceptance:** retain unsaved employee form, distinguish monthly-link
recovery from duty recovery, never imply that empty S-9 proves no duties, and
require explicit resolution/save. No automatic removals or retries.

**DoD:** reference-time/API/audit/lock decisions approved, monthly behavior
unchanged, new duty checks and deactivation handoff tested on Real-PG, UX/CI and
independent review complete.

## D6 — deterministic DST resolution and UTC snapshots

**Approved:** advance nonexistent wall time by the exact UTC-offset gap; for an
ambiguous time choose the earlier UTC instant (first occurrence). Resolve each
endpoint on its correct local date in the company IANA zone. `duty_date` is the
start date; only the approved NIGHT wrap (`end_local < start_local`) moves the
end to the next date. Persist exact UTC `starts_at`/`ends_at` snapshots, enforce
`ends_at > starts_at`, and never assume a night lasts 12 real hours.

**API/DB decisions before coding:** choose and review an explicit resolver and
timezone-data policy; settle supported dates/precision, invalid-zone handling,
how non-positive resolved intervals map to approved errors, snapshot DTO display
and publish revalidation. No library or PostgreSQL default implicitly decides
the rule. A future tzdata update must not silently recalculate saved snapshots.

**Components/security/locks:** Planning duty construction/update, company zone,
effective shift read and UTC columns/DTOs. Resolve under the reviewed company,
project/configuration and duty lock protocol; zone/configuration cannot change
between validation and commit. The tenant supplies neither an overriding zone
nor canonical UTC instants. Audit the actual committed duty mutation atomically
under its separately approved catalogue; D1 does not ratify new duty actions.

**Required deterministic fixtures:**

| Zone / local input | Approved resolved UTC |
|---|---|
| Berlin 2026-03-29 02:30 (gap → 03:30) | 2026-03-29T01:30:00Z |
| Berlin 2026-10-25 02:30 (first occurrence) | 2026-10-25T00:30:00Z |
| New York 2026-03-08 02:30 (gap → 03:30) | 2026-03-08T07:30:00Z |
| New York 2026-11-01 01:30 (first occurrence) | 2026-11-01T05:30:00Z |

New York's repeated hour is **01:xx**, while Berlin's is **02:xx**. New York
02:30 on fall-back day is unambiguous. Unit and Real-PG persistence tests must
assert exact instants and reload equality, both endpoints independently,
transition-adjacent dates, UTC/local year boundaries, ordinary 12-hour nights,
11/13-hour transition nights in both zones and rejection of non-positive resolved
intervals. Assert no silent snapshot change after configuration/zone updates and
rollback of duty plus audit on failure. No DST implementation tests ran in this audit.

**Frontend acceptance:** display the agreed company-local date/time and offset or
disambiguation hint where approved; preview and saved response agree. Keep inputs
on failure. A real browser flow must verify transition dates with the actual API.

**DoD:** resolver/error/precision contract and controlled amendments approved;
unit/Real-PG/UX/CI evidence and independent review complete before duty scheduling
is accepted. Plan-count statistics remain unchanged.

## D1 — bounded audit catalogue reconciliation

PO approval covers exactly four names and their existing meanings. The public
[ADR-0004](../architektur/adr/0004-related-business-audit-catalogue.md) records the
code-derived summary; the controlled local register records source comparison,
canonical catalogue adoption and outstanding reviewer acceptance. Keep original
decision records and superseded drafts intact. Do not ratify unrelated actions,
rename events, backfill logs or change the emitted schema in this task.

Independent documentary acceptance must verify resource, exact bounded old/new
values, correction scope, tenant/actor/correlation, data minimization, no-op and
rollback for all four actions. Relevant existing Real-PG audit tests and CI are
listed in the [closeout evidence](../reviews/sp09-closeout-64-73.md). Browser tests
do not establish operational audit controls. Retention, restricted DB roles,
access, backups and restore tests have their own #51 acceptance; no indefinite
retention or DB immutability is asserted.

**DoD:** independent TL/API/audit-owner acceptance of the controlled amendment
and public summary is recorded before #64/#73 closure. D1 does not require a new
business feature or migration. This final documentary acceptance remains pending.

## Order and delivery boundaries

1. Review controlled D1 reconciliation and this handoff; independently accept
   administrative transfer before closing either source issue.
2. Complete SP-10 #24 as its own approved slice. Classify actual absence tables
   by schema purpose; do not infer planning dependencies from the story number.
3. Approve LOCK-01, D2/D3 relational predicates, D4 lifecycle/new 409, D5
   reference-time/API/audit and D6 resolver contracts before SP-11 coding.
4. Integrate D2/D3 real guards and D6 snapshots with the first approved planning
   relations. Implement D4/D5 and employee-deactivation duty protection before
   accepting SP-11 scheduling. Carry unfinished work visibly from #25 to #26;
   never label a calendar day complete based on its planned date.
5. Require independently reviewed code, relevant CI and actual planning tests
   for SP-11 acceptance. Require browser, audit operations, dependency triage and
   all remaining #51 gates separately for staging/production.
