# SP-90: proposed project operating weekdays

Revision 2026-11-02. Design only, linked to [#90](https://github.com/takh86/SecurePlan/issues/90)
and [SP-88](sp88-employee-month/README.md). Project-specific weekdays and exclusive
daily scheduling are approved business direction. Schema, applicability,
compatibility, audit and API below require P4/P5 and T1–T4 approval. No holiday,
one-off exception, automatic scheduling or legal-compliance claim is introduced.

## Architecture comparison and recommendation

| Alternative | History / applicability | Guards, compatibility and cost |
|---|---|---|
| A: weekdays on projects | One current value rewrites the apparent policy for old months; needs snapshots or history to repair that | Small initial migration, but ambiguous published-plan changes and lost history; reject |
| B: separate month-effective weekly set | Latest complete version at or before the planning month; old versions remain | **Recommend.** One small table/API, project parent barrier, independent of shift-time releases; modest extra UI/read work |
| C: extend versioned shift configuration | Fits existing month concept, but weekday set belongs to whole version, not DAY/NIGHT rows | Duplicating weekdays across rows risks inconsistent sets; normalizing a version header requires migrating existing APIs, IDs, D3 and provenance. Bundles unrelated time/calendar edits; higher MVP cost |

B is a bounded recurring weekly policy, not a general calendar subsystem. Use
the company's civil `dutyDate`, not device weekday or UTC date. A NIGHT beginning
Friday on an open Friday may end Saturday even when Saturday is closed. Its
start date controls; UTC overlap and existing eligibility/availability remain
independent. For November 2026, day 1 is Sunday, 5 Thursday, 17 Tuesday, 19 Thursday.

Shift configuration remains unchanged: latest **whole** shift set, no per-kind
inheritance, D6 for new duty UTC snapshots. Operating calendar resolves separately
for the same planning month; neither derives defaults from the other. Calendar
selection does not recalculate existing duty instants or provenance.

## Proposed additive database model

Allocate the next free migration after integrated main; do not amend migrations
0007, 0009 or INITIAL_PUBLISH-only 0013. Schema sketch (not executed SQL):

```sql
CREATE TABLE project_operating_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  project_id uuid NOT NULL,
  effective_from_month date NOT NULL,
  weekday_mask smallint NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, project_id, effective_from_month),
  FOREIGN KEY (company_id, project_id)
    REFERENCES projects (company_id, id) ON DELETE RESTRICT,
  CHECK (isfinite(effective_from_month)
    AND effective_from_month = date_trunc('month', effective_from_month)::date),
  CHECK (effective_from_month BETWEEN DATE '0001-01-01' AND DATE '9999-12-01'),
  CHECK (weekday_mask BETWEEN 1 AND 127),
  CHECK (version BETWEEN 1 AND 9007199254740991),
  CHECK (isfinite(created_at) AND isfinite(updated_at))
);
```

ISO Monday=1 through Sunday=7; bit `(weekday-1)` corresponds to that weekday.
Mask 127 means all seven, 31 Mon–Fri, 63 Mon–Sat. API uses sorted unique integers,
never exposes bit arithmetic. Recommend at least one day (1–7); fully closed
projects can be INACTIVE, but permitting an empty set is an explicit P4 alternative.
Unique project/month index also supports latest <= month and next-version reads;
no duplicate index. Existing duties project/date indexes should serve the interval
guard; verify actual EXPLAIN on realistic synthetic data before adding an index.
Add schema classification/signature and migration replay tests. No duty-calendar
FK or employee-month table; historical policy is resolved by immutable past versions.

Exclusivity spans duties and memberships, not one row. Existing live-slot and
active-membership unique indexes do **not** enforce employee/project/date across
DAY and NIGHT. Do not claim a cross-table CHECK can do it: [PostgreSQL constraints](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS).
Recommend shared application validation under E/P locks across every supported
writer; avoid a denormalized assignment date/project and another source of truth.
Direct privileged SQL remains outside that application proof and subject to #51.

## Applicability, historical protection and bootstrap (P4/P5 pending)

Recommend current/future effective-month writes only, matching shift-config UX.
Past versions are immutable. Resolve latest month <= target; versions apply over
`[effectiveFromMonth, next calendar version)`. Do not use next **shift** version.
No DELETE endpoint; replacing one complete set is explicit. Future unreferenced
versions can be replaced, with monotonic version and retained audit history.

Unlike D3's time-snapshot guard, the proposed **separate calendar guard** permits
compatible changes but refuses any change that newly closes a date occupied by
a live saved duty, staffed **or empty**, in that interval. Both UNPUBLISHED (the
implementation's Draft) and PUBLISHED count. Old calendar MISSING is treated as
unknown, so initial configuration must permit every saved live duty date in the
interval. Removing a weekday with no saved duty is allowed; adding days is allowed.
An identical exact stored set is a no-op after matching the expected version.
Creating an explicit equal-to-inherited set is a new version, not no-op.

This is a controlled new guard, **not** replacement or relaxation of D3 for shift
times. Existing empty duties can therefore block a closure; explicit SP-12 deletion
is the only currently approved duty-deletion path, subject to its own guards.
Never silently remove duties/members, shift a plan, republish or close a saved date.
If narrowing conflicts, recommend a later dependency-free effective month, or an
explicit authorized roster correction first. No override workflow in MVP.

Migration inserts **no assumed Mon–Fri/all-seven policies**. Existing projects
return MISSING until an admin explicitly configures them. Proposed one-time
bootstrap exception: only when the project has **no calendar versions at all**, an
admin may choose a past month equal to the earliest live duty's planning month
(or current month if none). Validate the proposed set against **every** live duty
from that month forward, including empty/published duties. Refuse if any would
be closed. This supplies historical coverage without silently guessing weekdays;
the recorded version means explicitly accepted migration compatibility, not proof
that the policy existed historically. After the first version, past writes are
forbidden. A boolean `bootstrap:true` explicitly requests this exceptional path;
ordinary PATCH cannot backdate. P5 must approve this exception and its wording.
Alternative is a separately approved migration mapping per project; never silently
seed all seven days. Do not remove legacy assignments to make migration pass.

| Existing data / intent | Recommended behavior |
|---|---|
| No configuration, no actual delta | True no-op allowed; read shows MISSING, never implies weekends closed |
| No configuration, target removal only | Permit correction if existing SP-12 rules pass; no availability write |
| No configuration, addition or target role mutation retaining scheduled work | Refuse PROJECT_CALENDAR_MISSING; configure first |
| Existing closed assignment, unchanged in unrelated save | Keep visible with violation; no silent removal; do not require unrelated correction |
| Existing closed assignment, remove | Permit removal, preserve other staff/history; project ACTIVE and existing resulting-roster rules still apply |
| Existing closed assignment, replace kind or change target role | Refuse closed-day assignment; changing kind is a new assignment, even on same date |
| First Publish with MISSING, closed live duty or dual membership | Refuse full publication; no lifecycle/audit/idempotency completion |
| Already PUBLISHED legacy data | Remains visible; permitted corrections apply directly under CR-03, no republish |
| Calendar update tries to close saved date | Atomic refusal under P; no automatic invalidation of either lifecycle state |

Strict Publish recommendation validates **all live duties including empty ones**
against configured weekdays, plus all active memberships for exclusivity. Legacy
empty closed duties require explicit correction/deletion. This treatment needs P4/P2
approval; relaxing it only for empty rows is an alternative, not an assumed rule.

## Proposed project calendar HTTP contract

COMPANY_ADMIN only, `/api/v1/projects/{projectId}/operating-calendar`, current
session tenant/CSRF/Origin rules, hidden foreign/ARCHIVED 404, INACTIVE GET allowed,
effective PATCH refused for INACTIVE. `Cache-Control: no-store`. Strict DTOs.

GET `?effectiveForMonth=2026-11-01` returns in one consistent read:

```json
{
  "projectId":"40000000-0000-4000-8000-000000000001",
  "effectiveForMonth":"2026-11-01",
  "state":"CONFIGURED",
  "effective":{"id":"90000000-0000-4000-8000-000000000001","effectiveFromMonth":"2026-11-01","version":1,"operatingWeekdays":[1,2,3,4,5]},
  "exactVersion":{"id":"90000000-0000-4000-8000-000000000001","version":1},
  "nextEffectiveFromMonth":null
}
```

MISSING uses `effective:null`, `exactVersion:null` (state MISSING), no invented set.
`exactVersion` refers to the queried month, independently of inherited effective
version. GET is also the edit baseline for PATCH of that exact month.

PATCH replaces the full set of **one** month:

```json
{
  "effectiveFromMonth":"2026-12-01",
  "expectedExactVersion":null,
  "expectedEffective":{"id":"90000000-0000-4000-8000-000000000001","version":1},
  "expectedNextEffectiveFromMonth":null,
  "operatingWeekdays":[1,2,3,4,5,6],
  "bootstrap":false
}
```

Expected values are null or exact `{id,version}`. ExpectedExact protects absence
of a row at requested month; expectedEffective protects inherited policy. Match
both freshly after P and match `expectedNextEffectiveFromMonth` against the next
version month (or null), so the reviewed applicability interval cannot silently
change. False no-op never hides stale input. Bounds: real month-start,
years0001–9999, 1–7 distinct ISO integers, positive safe versions, UUIDs, strict
unknown-field rejection, existing100KiB parser bound. Sort weekdays canonically.
200 returns the GET shape for the edited month and outcome APPLIED/NO_OP.
No idempotency key/table widening for this PATCH: exact expected version/absence
prevents duplicate effective mutation. A lost response requires explicit GET and
comparison; matching state alone does not prove attribution. Exact stale retry409,
not automatic success. Audit only an effective accepted write.

Proposed errors: 400 PROJECT_CALENDAR_INVALID (field pointers, no arbitrary detail),
409 PROJECT_CALENDAR_CONCURRENT_MODIFICATION, 409 PROJECT_CALENDAR_DEPENDENCY_CONFLICT,
existing PROJECT_INACTIVE, concealed404; existing auth/parser errors and sanitized500.
Dependency conflict exposes only requested/affected interval and remedy text, no
employee names/rosters. Strict error catalogue/OpenAPI amendment is T1.

## Locking, cross-writer and security proof obligations

Calendar PATCH: existing lockAccountsPrefix A account final-mode SHARE -> C SHARE -> **P NO KEY UPDATE**
from its first acquisition -> read current calendar version and planning dependency
interval in new statements -> mutate calendar row -> Z audit -> COMMIT. Calendar
row SQL locks are internal to P configuration scope, never a new global planning
tier. Take no E/M/L/D/A2/Q row locks in this writer. All planning mutations and
Publish take P SHARE **before L/D**, so P NO KEY UPDATE freezes the dependency
set. After waiting, a fresh statement sees committed dependencies; see [row lock
conflicts](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS).
Fresh transaction-aware session/role checks under A/C apply to calendar writes
as well; recheck session expiry after P waits before mutation, no late session
row lock/account upgrade. Existing shift/project writers use the same P barrier. No SHARE-to-UPDATE upgrade.
FK insertion references P already held; no late employee/account parent.

Batch-first COMMIT -> calendar sees duties and rejects a newly excluding closure;
batch-first ROLLBACK -> calendar can succeed if dependency-free. Calendar-first
COMMIT -> batch detects changed calendar token before applying new assignments;
calendar-first ROLLBACK -> old preconditions remain valid. A compatible committed
calendar change still makes the old batch token stale: explicit review required.
Calendar and shift writers serialize on P without holding later plan/lease locks.
No new cycle under L1; actual-schema both-order tests remain mandatory.

Proposed audit **requires a new owner/security decision**, not silent vocabulary:
exactly one `PROJECT_OPERATING_CALENDAR_UPDATED`, resource
`PROJECT_OPERATING_CALENDAR`, resourceId project ID, oldValues null for a new
exact version or `{effectiveFromMonth,operatingWeekdays,version}` for replacement,
newValues same fields with persisted version; trusted tenant/actor/correlation.
`bootstrap:true` is also included in newValues only for approved bootstrap, and
the audit DTO must explicitly allow it. No names, staff, availability or raw input.
All mutation+audit one transaction; no audit for no-op/refusal/read. Rejecting this
vocabulary blocks calendar writes only; recommend this precise P6/T4 approval.

## Implementation boundaries and acceptance

See [cross-writer contract](sp88-employee-month/04-transaction-and-security.md),
[acceptance/backlog](sp88-employee-month/05-acceptance-and-delivery.md),
[Claude handoff](sp88-employee-month/08-frontend-handoff.md) and
[capacity forecast](sp88-employee-month/09-reforecast.md).
Schema and all affected writer/Publish guards must ship together before enabling
calendar enforcement; do not deploy only the batch validator. Include explicit
legacy-data scan/report before rollout, no destructive cleanup. Unit/API/schema/
PG tests use actual application tables and verified disposable infrastructure.
No new experiment was run for this design revision; the old stand-in probe does
not validate this schema, migration, calendar rules or cross-writer enforcement.
