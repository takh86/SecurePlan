# A2 employee-month Save — adopted A2-GATE-1

Status: ADOPTED for bounded backend implementation, 2026-11-03.
Revision A2-GATE-1 at PR #94 head `c066ff41d3a5eda8d6f20a62144fc5212e3cf280`.
[Owner decision](https://github.com/takh86/SecurePlan/issues/88#issuecomment-6600906336)
adopts T1–T4 and the choices described as proposed in the source text below.
This adoption is not implementation or release acceptance.

## Authority and reconciliation

Base: `dd3e83e5e6f619f197aad93ee2b7f5c121d6eeca`, including merged #92/#93.
[PO P1–P6](https://github.com/takh86/SecurePlan/issues/88#issuecomment-6588991067)
approve full desired state, conservative conflicts, lifecycle, calendar and
audit direction. They explicitly exclude detailed technical/implementation
approval. [Design #89](https://github.com/takh86/SecurePlan/pull/89), revision
`3d73b4d9f744b5010267bb89c869c224d32c31d6`, remains a proposal.
This amendment supersedes its historical baseline and missing-A1 claims for A2.

| Historical proposal/reference | Current main and A2 disposition |
|---|---|
| Next migration 0014 for employee-month receipts | 0014 is `project_operating_calendars`; next is provisionally **0015**, recheck origin/main before allocation. Never modify applied 0013/0014 |
| Calendar API/all-writer guards absent; #86/#87 unmerged | Calendar/exclusivity guards, First Publish and its React UI are merged. Reuse them; do not reimplement A1 |
| Transaction-aware session read must be introduced | `assertSessionInTransaction` exists in Identity; reuse under A/C and after business waits |
| Calendar action missing | A1 implements its bounded validator and event. A2 proposes only existing duty/member actions |
| Publish result reconstructs current plan | Suitable only for existing INITIAL_PUBLISH; A2 requires a persisted immutable receipt |
| P1–P6 pending / dual-shift default | Superseded by owner approval; exclusive DAY/NIGHT/OFF and retained empty duties are settled |

References: [A1 API](project-operating-calendar.md),
[ADR-0003](../architektur/adr/0003-schichtkonfiguration-monatsversioniert.md),
[ADR-0004](../architektur/adr/0004-related-business-audit-catalogue.md),
[ADR-0005](../architektur/adr/0005-availability-batches.md),
[ADR-0006](../architektur/adr/0006-duty-edit-leases.md),
[CR-03](../requirements/cr-03-direct-published-plan-updates.md).
ADR-0001's readiness-only 503 and ADR-0002's concealed ARCHIVED behavior stay scoped.
No API field for tenant, timezone override, lifecycle mutation or replacement workflow is added.

## Resource, shape and preconditions

After `/api/v1/monthly-plans/{planId}/employee-months/{employeeId}`:

| Method/path | Contract |
|---|---|
| GET resource | One complete REPEATABLE READ, READ ONLY employee-month projection |
| POST `/save` | COMPANY_ADMIN, Origin/CSRF/session; required Idempotency-Key; one business transaction; 200 APPLIED or NO_OP only after commit |
| GET `/save-result` | Same actor/tenant/route and key; outcome query only, never claim/retry |

Exact proposed read/receipt field definitions and complete November examples are
in the [pinned design API](https://github.com/takh86/SecurePlan/blob/3d73b4d9f744b5010267bb89c869c224d32c31d6/docs/design/sp88-employee-month/03-api-and-idempotency.md).
Adopt those shapes with this amendment's precedence, codecs and migration correction.
The request is exactly:

```ts
type ExpectedDuty = null | { id: UUID; version: PositiveSafeInteger };
type SaveEmployeeMonth = {
  expectedPlan: { status: 'UNPUBLISHED' | 'PUBLISHED'; publishedAt: null | Instant };
  expectedCreationContext: LowercaseSHA256;
  expectedCalendar: null | { id: UUID; version: PositiveSafeInteger };
  days: Array<{
    date: CivilDate;
    expected: { day: ExpectedDuty; night: ExpectedDuty };
    desired: { state: 'OFF' } | { state: 'DAY' | 'NIGHT'; role: 'EMPLOYEE' | 'SHIFT_LEAD' };
  }>;
};
```

All fields required, unknown fields rejected recursively. Require every unique
date in the plan month (28–31), both slots per date (maximum 62), at most one
desired assignment per date, no role on OFF, valid Gregorian dates, UUIDs and
versions 1..9007199254740991. Published state must carry its canonical persisted
publication instant; unpublished must carry null. No INVALID_DUAL desired state.
Keep the existing 100 KiB body parser bound and parser/media status mappings.
Reject missing/duplicate/out-of-month days rather than interpreting them as unchanged.

The consistent read includes all live DAY/NIGHT slots, including empty/shared
duties with no selected membership; each carries exact ID/version and saved UTC
interval. Only the selected employee's assignment ID/role/source is returned.
Neutral unavailable dates contain no absence status or reason. Legacy duals are
readable as INVALID_DUAL, requiring an explicit DAY/NIGHT/OFF correction.

Every save, even no-op/removal, matches lifecycle, all 2N slot ID/version/absence
tokens and effective calendar ID/version/null. Shared-duty changes conflict even
on an unchanged desired date. Tombstone/recreation is a different identity.
Creation context is compared only if a duty must be created; it is always part of
the submitted command fingerprint. There is no plan aggregate version or new
Expected-Version header; existing SP-12 headers remain unchanged.

Proposed deterministic codecs (new technical acceptance required): SHA-256 of
UTF-8 JSON.stringify of array tuples, no object-key-order dependence. UUIDs are
lowercase; civil dates ISO; instants canonical UTC at persisted precision;
versions use safe JSON integers; null is explicit. Dates sort ascending, kinds
DAY then NIGHT. No locale-sensitive sorting.

```text
creation = ["EMPLOYEE_MONTH_CREATION_V1", projectId, monthStart, companyIanaZone,
  null | [effectiveShiftMonth, [[shiftRowId, apiKind, HH:mmStart, HH:mmEnd], ...]],
  null | [calendarId, calendarVersion, effectiveFromMonth, [sortedIsoWeekdays]],
  "D6_V1"]
request = ["EMPLOYEE_MONTH_SAVE_V2", planId, employeeId,
  [status, publishedAt], expectedCreationContext,
  null | [calendarId, calendarVersion],
  [[date, null | [dayId, dayVersion], null | [nightId, nightVersion],
    ["OFF"] | ["DAY" | "NIGHT", role]], ...]]
```

Shift configuration has **no numeric version column**: its complete effective
set, IDs and HH:mm values form the checksum. Never invent a version or inherit a
missing kind from an older set. D6_V1 identifies the existing reviewed resolver;
codec golden vectors must freeze that mapping before enabling the command.

## Domain delta on canonical duties

Full desired state describes only the selected employee's memberships; it is
never an entire-roster replacement and creates no employee-month source of truth.

| Transition | Required effect |
|---|---|
| OFF → DAY/NIGHT, absent live slot | Create canonical duty only for actual assignment, D6 saved snapshot, version 1, new NORMAL membership |
| OFF → DAY/NIGHT, existing empty/shared slot | Reuse duty ID and exact temporal provenance; add only selected member |
| DAY ↔ NIGHT | Retire selected old membership; reuse/create destination slot; validate the final overlay, not the transient old+new state |
| DAY/NIGHT → OFF | Tombstone selected membership with persisted removedAt; retain duty even if now empty |
| Retained assignment/role | Preserve membership ID/source and all other staff; role change increments affected duty once |
| No effective delta | Fresh preconditions, immutable NO_OP receipt; no domain timestamp/version or success audit |

Same-mode paint is locally idempotent. FREI is unscheduled, independent of
SICK/LEAVE. No placeholder prepopulation, automatic duty deletion, month-link
creation, role downgrade, saved-time re-resolution or reactivation of REMOVED
membership rows. Rejoining uses a new ID. Existing SP-12 deletion is separate.

For every effectively changed duty, validate its complete resulting roster with
existing ACTIVE/employment/month-link/shift/availability/UTC overlap rules.
Other employees' identities, roles, source, history and memberships remain exact.
A preserved-worker failure is a neutral conflict, never their ID/medical reason.
Use one final overlay excluding only selected memberships actually retired and
adding all desired intervals; include external plans and month-boundary UTC
overlap. Existing SP-12 single-duty validation cannot simply loop here: it would
misread DAY→NIGHT and cross-date moves against the pre-command database.

Use A1's exact compatibility: new/replaced/role-mutated work needs configured
open company-local start date; NIGHT can end on a closed following date.
MISSING/closed dates permit genuine no-op or corrective reduction subject to
existing effective-PATCH rules. INACTIVE project still blocks effective changes,
including membership removal; ARCHIVED is concealed. No-op does not revalidate
unchanged duties; Save does not certify First Publish readiness. PUBLISHED saves
apply immediately without altering publication metadata or requiring republish.

## Proposed LOCK-01-L1 and admission supplement

Business transaction, READ COMMITTED, final modes on first acquisition:

```text
A accounts sorted, actor SHARE → C SHARE → I nonwaiting advisory + reservation UPDATE
→ E sorted NO KEY UPDATE → P SHARE → M sorted SHARE → L UPDATE
→ all D sorted UPDATE/new inserts → all A2 sorted UPDATE → all Q sorted UPDATE
→ fresh session/admission/validation → domain delta → Z audit + fenced receipt → COMMIT
```

Discover the full month's duty/member signature and all roster employees plus
target before E. Re-read after L waits. If membership/duty discovery changed,
abort; never acquire newly discovered E/M/accounts late. Lock all existing D
before any A2/Q. New duty UUIDs come from PostgreSQL and merge into ordered D;
insert tentative empty rows only if preconditions permit, before A2/Q, rolling
them back on every refusal. Never call an orchestration method that opens its
own transaction or reacquires an earlier tier. M absence is protected by E,
slot absence by L UPDATE, lease absence by D, calendars/configuration by P SHARE.
Calendar writers retain P NO KEY UPDATE and never acquire late D/E.

Lock current Q rows in UUID order. At a fresh database clock after all waits,
refuse any live unreleased lease on a potentially changed existing duty, including
the same actor's other tab. Do not acquire/rotate/release its lease or require
the client to hold 62 leases. Unchanged duties do not cause lease refusal.
An admitted command holds L/D/Q through commit; later lease expiry does not
invalidate admission. This is a **new batch admission mode requiring ADR-0006
acceptance**, not a silent bypass of SP-12's token contract.

Reuse `lockAccountsPrefix` and Identity's `assertSessionInTransaction` after A/C,
after business waits and before accepting no-op/replay/result lookup. Use a fresh
READ COMMITTED statement; never invoke validateAndTouch or take a late session
lock/account upgrade. A SHARE serializes logout/reset/role writers at A UPDATE;
clock expiry still needs the post-wait check. Global guard validation alone is
insufficient. Preserve 5s lock and 15s statement limits, sanitized 500 on
55P03/40P01/40001, complete rollback, no automatic command retry.

## Claims, immutable receipts and uncertain outcomes

Provisionally 0015 extends idempotency_records with tenant-safe plan/employee
context FKs, bounded result JSON and a nullable result-schema-version column.
INITIAL_PUBLISH retains original hashes,
scope, result codec and null new columns. EMPLOYEE_MONTH_SAVE requires both
context IDs in every state, null JSON for IN_PROGRESS/FAILED, and exact bounded
versioned SaveResult plus result_plan_id=context plan and finite completedAt for
COMPLETED (result-schema-version 2; null in other states and on INITIAL_PUBLISH).
Retain existing hash/time/fencing constraints; cap stored result at
128 KiB and at 62 changed slots. SQL checks bound shape/size; strict service codec
validates every write/read, route identity, counts and versions. JSONB structural
equality defines immutable replay, not HTTP whitespace/key ordering.

Do not extend the hard-coded Publish codec to decode arbitrary JSON. Extract a
reviewed shared transaction-aware claim/fence primitive with separate operation
codecs, preserving INITIAL_PUBLISH compatibility. Schema classification, receipt
signature checks and migration forward/replay tests must change together.
No SQL migration is added by this gate PR.

Short durable claim: A/C → I → E target NO KEY UPDATE → P SHARE → L KEY SHARE,
then context-FK insert/reset and COMMIT. No M/D/A2/Q/business writes. All FK
parents exist/are held before insertion; do not rely on trigger order to obtain
E after L. The separate business transaction takes L UPDATE initially. Receipt
completion occurs on the same client as all domain/audit writes; a late encoding,
Nth-audit, SQL or completion failure rolls them all back.

Scope is company/actor/operation/hash(key), across plans/employees. Existing key
syntax remains 8..128 visible ASCII; store no raw key. Hold nonwaiting I and
reservation row through business commit. Attempt UUID fences stale claimants;
staleness alone cannot steal a running command. Same key/different request is
409 KEY_REUSED; live execution is 409 IN_PROGRESS. A post-rollback FAILED marker
must be fenced and conditional on IN_PROGRESS, never overwrite COMPLETED after
an ambiguous COMMIT acknowledgement. No connection failure proves rollback.

Proposed defaults retain 24h terminal replay and 5min abandoned-claim threshold,
configurable as for Publish. Completed same request returns original SaveResult
with `Idempotency-Replayed: true`, fresh correlation ID and no success audit.
Later roster/plan changes never reconstruct/replace that retained receipt.
Expiry permits only a reviewed recovery policy; it is neither proof of failure
nor physical erasure. Bounded cleanup and operational retention ownership need
explicit acceptance; do not add an indefinite archive or an operational job here.

Result GET takes A/C, fresh session, nonwaiting I and P SHARE for current resource
visibility; recheck session after waits. No E/M/L/D/A2/Q eligibility work or row
reset. Current role/tenant/account and exact route context are required even for
replay. Foreign/archived/context mismatch is concealed 404 without details.
Outcomes: COMPLETED with receipt, IN_PROGRESS with bounded retryAfterSeconds,
NOT_COMPLETED only for fenced FAILED observed under exclusive I, UNKNOWN for
absent/expired evidence. A contended I may instead return existing in-progress
409. Never infer noncompletion from current state matching the desired month.
Use full public codes IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST and
IDEMPOTENCY_REQUEST_IN_PROGRESS for the abbreviated KEY_REUSED/IN_PROGRESS
cases above. Proposed JSON size enforcement measures UTF-8 bytes of result::text
(maximum 131072), rather than compressed physical tuple size.

After expiry, a POST may reset a reservation only under exclusive I, the
attempt fence and the complete context-FK prefix, then execute with all original
preconditions. Never replay expired JSON as authoritative evidence. A formerly
effective write changed a slot/version, so its original full request is stale;
a still-identical no-op can only remain a no-op. This is a duplicate-effect
backstop, not permission for client automatic retry or reuse of a key for edited
intent. Completed rows are immutable within their retained replay window;
expiry/reset or authorized cleanup does not promise indefinite receipt history.

Unknown network outcome retains exact frozen body/key. Explicit lookup precedes
reconciliation. NOT_COMPLETED permits an explicitly confirmed exact-key/body
attempt with full revalidation. UNKNOWN requires fresh state and explicit new
intent/key; old preconditions protect effective changes, not proof of outcome.
Corrected intent always uses a new key. No blind retry, per-day loop or partial
success. Keep drafts in actor/company/resource-bound hidden memory across auth
failure; another login cannot view/submit them. Tab destruction is a stated limit.

## Error and audit amendment requiring acceptance

Precedence within the existing HTTP guard/parser pipeline:

1. Authentication/role/Origin/CSRF, parser/media/body bound and strict DTO syntax;
   concealed route visibility before plan-relative date errors.
2. Transaction account/company/role, usable schema, current session and resource
   visibility; repeat session/visibility after relevant waits, before details.
3. Idempotency scope/fingerprint/fence and authorized completed replay, before
   new eligibility/staleness rules. Existing completed receipts remain replayable
   after ordinary workforce changes.
4. Live affected-duty lease admission; then lifecycle, slot/discovery, creation
   context (only creation), effective-calendar drift; then true NO_OP.
5. Effective-write ACTIVE project, calendar, configuration/interval and complete
   projected-roster eligibility, exclusivity and half-open UTC overlap; audit and
   completion. Technical/integrity failures are sanitized 500, never business 409.

Propose 409 EMPLOYEE_MONTH_SAVE_CONFLICT for LEASE/VALIDATION; existing
PLAN_CONCURRENT_MODIFICATION for PRECONDITION. A strict allowlisted extension is
`{atomic:true, stage:'LEASE'|'PRECONDITION'|'VALIDATION', conflicts:[{date,
shiftKind:'DAY'|'NIGHT',reason}]}`. At most 62 unique date/kind entries, sorted
date then DAY/NIGHT, one first safe reason per slot. Version drift uses
PLAN_CONCURRENT_MODIFICATION; lease uses ACTIVE_DUTY_EDIT; other staff use
PRESERVED_ROSTER_CONFLICT. The remaining allowed reason enum is PROJECT_INACTIVE,
PROJECT_CALENDAR_MISSING, PROJECT_CLOSED_WEEKDAY, SHIFT_CONFIGURATION_MISSING,
DUTY_TIME_RANGE_INVALID, EMPLOYEE_INACTIVE, EMPLOYEE_NOT_EMPLOYED_FOR_DAY,
EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH, EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT,
EMPLOYEE_UNAVAILABLE, EMPLOYEE_DAILY_SHIFT_CONFLICT, DUTY_ASSIGNMENT_CONFLICT.
Freeze this exact enum in OpenAPI; no arbitrary string or exception forwarding.
If drift cannot safely identify a slot, conflicts is empty. Stages never mix.
No details on auth/hidden 404/500; no holder, other employee ID, medical fact or
provisional ID. Keep structural suberrors bounded at 25. All three new routes,
including guard/parser/error/result paths, must set no-store. A1's filter handles
calendar no-store only; it does not yet handle these employee-month paths.

Reuse bounded ADR-0004 D/M payloads: new duty emits DUTY_CREATED and member ADDED;
each changed existing duty increments once, emits DUTY_UPDATED plus effective
member ADDED/UPDATED/REMOVED. Role updates retain ID/source; removal contains
persisted removedAt. Audit order is duty UUID, then member UUID/category. No new
MONTH_SAVED event, full-month snapshot, success audit on no-op/replay/refusal,
notifications or outbox obligation. Trusted tenant/actor/correlation and all
events share the business transaction with receipt completion. Extending these
actions to the new command still requires audit/security scope acceptance.


## Adoption record

The owner decision above adopts the API, locking, migration, receipt and security
choices in this revision. This document records the implementation-facing
M3/M4/A10 and Phase 8 amendment; exact schemas are in
[OpenAPI](employee-month-save.openapi.json). Private documents are not asserted
updated. ADR-0006 records batch admission. Migration allocation rechecked on
origin/main `dd3e83e5e6f619f197aad93ee2b7f5c121d6eeca`: 0015 available;
0014 remains operating calendars. Applied migrations remain immutable.

The implementation separates the consistent projection, operation-specific
receipt codec and atomic command; shares I-tier admission/fencing with Publish;
and keeps INITIAL_PUBLISH hashes and result reconstruction unchanged.
Replay defaults: 86400 seconds; abandoned claim: 300 seconds, using existing
validated idempotency settings. Explicit maintenance entry point
`EmployeeMonthIdempotencyService.pruneExpired` requires current admin/session,
and removes only that principal's expired A2 records (default 100, maximum 1000
candidates), under each key's nonwaiting I lock and a fresh expiry predicate.
Live writers are skipped, retained records and INITIAL_PUBLISH are untouched.
No HTTP cleanup route, startup cleanup or operational job is introduced.

Implementation-specific PostgreSQL/HTTP evidence, independent review,
frontend/browser acceptance, human accessibility/security and stage/production
#51 remain acceptance gates. No merge, deployment or issue closure is authorized.

