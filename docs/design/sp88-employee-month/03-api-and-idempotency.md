# Proposed API, preconditions and command recovery

These are new contracts awaiting T1/T3/T4 approval. They are not endpoints on
main. All routes use `/api/v1`, COMPANY_ADMIN, trusted session tenant, resource
visibility and `Cache-Control: no-store`, including problem/result responses.

## Method and routes

| Method / route after `/api/v1/monthly-plans/{planId}` | Purpose |
|---|---|
| `GET /employee-months/{employeeId}` | Consistent complete read projection for one employee and the plan's month |
| `POST /employee-months/{employeeId}/save` | One atomic multi-duty command, required `Idempotency-Key` and JSON body |
| `GET /employee-months/{employeeId}/save-result` | Safe outcome lookup using the same `Idempotency-Key` header; never executes/reclaims a save |

PUT of the desired membership projection could be defensible, but suggests
replacing a resource and invites confusion with an independent employee-month
aggregate or complete duty rosters. PATCH fits explicit deltas but is less clear
for a complete, reviewed month and critical command receipt. Recommend POST:
Phase 8.2 permits actions with multiple consistent effects; fingerprinted command
identity supplies retry safety. Only the POST mutates planning. No 207, partial
success, asynchronous per-day worker or client loop is offered.

Plan creation remains a preceding explicit command. No endpoint takes a company,
actor, project or month override. The route's employee need not be the admin's own
employee: the admin may plan one authorized employee of the same company.
EMPLOYEE, contextual SHIFT_LEAD and PLATFORM_ADMIN do not gain this capability.

## DTOs and bounds

The following type notation specifies exact JSON shapes, not runtime code.
Every property is required unless explicitly marked optional; undeclared fields
are rejected recursively. UUID comparisons normalize case. DATE is a real
Gregorian `YYYY-MM-DD`; INSTANT is the canonical server UTC timestamp format.

```ts
type Role = 'EMPLOYEE' | 'SHIFT_LEAD';
type ExpectedDuty = null | { id: UUID; version: number };
type PlanState = {
  status: 'UNPUBLISHED' | 'PUBLISHED';
  publishedAt: null | INSTANT;
};
type SaveSlot = { expectedDuty: ExpectedDuty; selectedRole: Role | null };
type SaveEmployeeMonth = {
  expectedPlan: PlanState;
  expectedCreationContext: SHA256_HEX;
  days: Array<{ date: DATE; day: SaveSlot; night: SaveSlot }>;
};
type Assignment = { id: UUID; dutyRole: Role; source: 'NORMAL' | 'REPLACEMENT' };
type ReadSlot = null | {
  dutyId: UUID; version: number; startsAt: INSTANT; endsAt: INSTANT;
  assignment: Assignment | null; // only the selected employee
};
type EmployeeMonthRead = {
  plan: { id: UUID; projectId: UUID; monthStart: DATE } & PlanState;
  employeeId: UUID;
  creationContextFingerprint: SHA256_HEX;
  unavailableDates: DATE[]; // neutral current facts for this employee only
  days: Array<{ date: DATE; day: ReadSlot; night: ReadSlot }>;
};
type SaveResult = {
  commandId: UUID; outcome: 'APPLIED' | 'NO_OP'; completedAt: INSTANT;
  plan: { id: UUID; projectId: UUID; monthStart: DATE } & PlanState;
  employeeId: UUID;
  counts: {
    createdDuties: number; changedDuties: number;
    addedMemberships: number; removedMemberships: number; updatedMemberships: number;
  };
  changes: Array<{
    date: DATE; shiftKind: 'DAY' | 'NIGHT'; dutyId: UUID; version: number;
    startsAt: INSTANT; endsAt: INSTANT; assignment: Assignment | null;
  }>;
};
```

The read uses one REPEATABLE READ, READ ONLY snapshot, like existing planning
GETs, after the global session/role guard. No pagination or separately fetched
pages may assemble this baseline. Return all live slots, even empty duties or
duties containing only other employees. Their assignment is null, but their ID
and aggregate version remain a precondition. Removed duty/member history is not
a live slot. Do not return other staff names, lease holders or absence reasons.

Exactly N unique dates cover the plan's complete calendar month, N = 28/29/30/31;
both slot properties are mandatory on every date. At most 62 slot preconditions
and 62 desired memberships. Require positive safe-integer versions
1…9007199254740991, UUID IDs, canonical plan-state combination (UNPUBLISHED/null
or PUBLISHED/timestamp), and a 64 lowercase-hex fingerprint. No coercion of null
to absent, strings to booleans/versions, or duplicate-date deduplication. Date
outside this plan month is structural 400 after plan visibility is established.
Years follow existing 0001–9999 support; invalid/collapsed end intervals, including
an unrepresentable overnight end at the range boundary, remain domain conflicts.

Retain the existing 100 KiB parser limit (413 REQUEST_BODY_TOO_LARGE), strict JSON
media handling, and strict nested DTO validation. This is a technical body bound,
not a staffing maximum. No new roster cap of 50/100, minimum shifts, mandatory
leader or workdays quota is authorized. Maximum result JSON is proposed at
128 KiB; the bounded 62-change result must be sized/tested against this limit.

## Complete concurrency preconditions

1. `expectedPlan` must equal the freshly locked lifecycle and publication instant.
   A Publish racing with a draft-loaded batch causes 409 even if duty versions
   did not change. This is a lifecycle acknowledgement, not a plan revision.
2. All 2N `expectedDuty` values must match the current live slot map: exact duty
   ID and version, or genuine absence. Any mismatch, including an unchanged
   slot occupied/changed by other staff, refuses the entire command. A removed
   and recreated slot with the same date/kind but another ID does not match.
3. Each duty version covers its whole active roster, including the selected
   employee's role/source/identity. Hence clients do not supply assignment IDs,
   sources or other employees' rosters as authority. Post-lock discovery also
   compares identities, versions and roster signatures, not just counts.
4. For any newly created duty, `expectedCreationContext` must equal a fresh
   server-computed fingerprint of the company zone, project/month, effective
   **whole** shift-configuration version/rules and D6 resolution-contract version.
   Canonical tuple encoding is fixed in API tests. It is an opaque concurrency
   checksum, not a signed credential or a company-zone display API. Ignore this
   comparison when no duty is created, while still fingerprinting the submitted
   value for command identity. Existing saved UTC snapshots are not re-resolved.
5. Employee/other-staff employment, status, project-month links, availability and
   overlap have no new public version tokens. They are freshly revalidated under
   their existing parent locks. This command never overwrites these facts. A
   still-valid workforce change may therefore be accepted; no guarantee that
   those facts have remained historically unchanged is claimed.

This conservative full-month read set is intentional (P1/T2): two disjoint batch
drafts of the same month may conflict after either changes a duty. Two existing
SP-12 edits to independent duties retain their current behavior. Reducing the
batch's read set later requires an explicit contract revision, not an automatic
server merge. No single `Expected-Version` header or If-Match/412 is invented for
62 versions; the proposed body preconditions extend Phase 8.7 with 409 semantics.

## Full request example

Synthetic IDs and an illustrative server-issued checksum. This is a complete
February 2027 request (28 dates), adding DAY on February 2; every other slot is
known absent and unselected. Real clients must use their actual read baseline.

```http
POST /api/v1/monthly-plans/10000000-0000-4000-8000-000000000001/employee-months/20000000-0000-4000-8000-000000000001/save
Content-Type: application/json
Idempotency-Key: 70000000-0000-4000-8000-000000000001
X-CSRF-Token: <session-bound-token>
```

```json
{
  "expectedPlan": {"status":"UNPUBLISHED","publishedAt":null},
  "expectedCreationContext":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "days": [
    {"date":"2027-02-01","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-02","day":{"expectedDuty":null,"selectedRole":"EMPLOYEE"},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-03","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-04","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-05","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-06","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-07","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-08","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-09","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-10","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-11","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-12","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-13","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-14","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-15","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-16","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-17","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-18","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-19","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-20","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-21","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-22","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-23","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-24","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-25","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-26","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-27","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}},
    {"date":"2027-02-28","day":{"expectedDuty":null,"selectedRole":null},"night":{"expectedDuty":null,"selectedRole":null}}
  ]
}
```

A retained existing membership is submitted with its current role and, for
example, `expectedDuty: {"id":"30000000-0000-4000-8000-000000000001","version":7}`.
Explicit removal sets only `selectedRole` to null. This still supplies the duty
precondition and never requests deletion of its other members.

Full success is HTTP 200 after COMMIT, with a new correlation ID. Example:

```json
{
  "commandId":"60000000-0000-4000-8000-000000000001",
  "outcome":"APPLIED","completedAt":"2026-11-02T20:00:00.000001Z",
  "plan":{"id":"10000000-0000-4000-8000-000000000001","projectId":"40000000-0000-4000-8000-000000000001","monthStart":"2027-02-01","status":"UNPUBLISHED","publishedAt":null},
  "employeeId":"20000000-0000-4000-8000-000000000001",
  "counts":{"createdDuties":1,"changedDuties":0,"addedMemberships":1,"removedMemberships":0,"updatedMemberships":0},
  "changes":[{"date":"2027-02-02","shiftKind":"DAY","dutyId":"30000000-0000-4000-8000-000000000002","version":1,"startsAt":"2027-02-02T05:00:00Z","endsAt":"2027-02-02T17:00:00Z","assignment":{"id":"50000000-0000-4000-8000-000000000002","dutyRole":"EMPLOYEE","source":"NORMAL"}}]
}
```

`changedDuties` counts effective updates of existing duties; new duties are counted
only in `createdDuties`. Changes contain one entry per effectively changed slot,
sorted date then DAY/NIGHT, maximum 62. A true no-op returns the same DTO with
outcome NO_OP, all counts zero, and changes `[]`. It changes no domain timestamp,
version or audit; it still completes its technical command receipt atomically.
No-op requires matching preconditions and current authorization. Do not classify
a stale request as no-op merely because its desired state now happens to match.
`commandId` is a PostgreSQL-generated UUID for the committed receipt, persisted
with that result and stable on replay. Do not reuse a reservation row ID as this
public receipt ID when recycling an expired key for a different intent.

## Error precedence and safe conflicts

Preserve the existing parser/global guard boundary: invalid/oversized JSON can
fail before guards; for a valid parsed request the guard is Origin → session →
CSRF → live role. Route ID concealment, nested DTO/key syntax and complete-month
structural checks precede business execution. Recheck actor and session, schema
integrity and plan/employee tenant visibility before looking up/replaying a key.

Completed same-command replay then precedes fresh business preconditions. For a
fresh command: active lease conflicts on potentially changed existing duties →
lifecycle/slot/context/discovery conflicts → no-op → project ACTIVE →
configuration/interval → resulting staffing. Staffing order stays ACTIVE →
inclusive employment → project-month membership → shift eligibility → neutral
unavailability → UTC overlap. Within a stage order date, DAY before NIGHT; report
at most the first safe reason per slot. A global context error appears once.
Do not continue eligibility reads using employees missing from the discovery
lock set; return discovery conflict instead.

409 version/lifecycle/context drift retains `PLAN_CONCURRENT_MODIFICATION`.
**Proposed new** 409 `EMPLOYEE_MONTH_SAVE_CONFLICT` covers the LEASE or VALIDATION
stage; it requires catalogue/OpenAPI approval and a strict allowlisted extension
in ProblemDetailsFilter. Existing SP-12 codes/status mappings do not change.

```json
{
  "type":"/problems/employee-month-save-conflict",
  "title":"Conflict","status":409,
  "detail":"The employee month could not be saved. Review the conflicts.",
  "instance":"/problems/occurrences/80000000-0000-4000-8000-000000000001",
  "code":"EMPLOYEE_MONTH_SAVE_CONFLICT",
  "correlationId":"80000000-0000-4000-8000-000000000001",
  "stage":"VALIDATION",
  "conflicts":[{"date":"2027-02-15","shiftKind":"NIGHT","reason":"EMPLOYEE_UNAVAILABLE"}]
}
```

The example is a different attempted month selection with a failing February 15
assignment. It carries no success counts: **zero domain changes**. The extension
is optional on existing PLAN_CONCURRENT_MODIFICATION and required on the new
batch error. Define it as `stage` plus `conflicts` (1…62) and optional single
`contextConflict` enum PLAN_LIFECYCLE / CREATION_CONTEXT / DISCOVERY / PROJECT.
When a context-only conflict exists, conflicts is `[]`; at least one of the two
must be present. Reason values are only current applicable staffing/config codes
plus proposed ACTIVE_DUTY_EDIT and PRESERVED_ROSTER_CONFLICT. Version-slot reasons
use PLAN_CONCURRENT_MODIFICATION. These two new reason values are not new audit
actions or standalone HTTP error codes.

Unavailability never identifies SICK/LEAVE, absence ID or text. An invalid
preserved colleague becomes PRESERVED_ROSTER_CONFLICT without their ID/reason.
Lease refusal never identifies holder, account, token or expiry. Cross-tenant,
missing and archived resources are concealed 404 with **no** per-day details.
Malformed DTOs use the current safe validation pointers/subcodes (maximum 25),
not this business extension. SQL/schema/config corruption, timeout, deadlock,
serialization or audit failure stays sanitized 500 INTERNAL_ERROR with correlation
ID and rollback. Do not claim definite failure for an ambiguous COMMIT response.
Never forward arbitrary exception objects or unapproved extension values.

## Idempotency persistence: explicit additive migration

PR #86's `0013_initial_publish_idempotency.sql` has a CHECK restricting operation
to INITIAL_PUBLISH. COMPLETED requires result_plan_id and completed_at; it stores
no immutable batch result. `PublishIdempotencyService` fingerprints only a plan
and reconstructs its publication response. Neither that service nor SP-10's
typed availability batch table accepts this operation unchanged.

Recommend one forward migration after #86 (expected next number 0014, allocated
after rebasing). Leave 0013 immutable. Extend `idempotency_records` with nullable
`employee_month_plan_id`, `employee_month_employee_id`, `employee_month_result`
(JSONB), composite company/plan and company/employee FKs, and operation-discriminated
CHECKs. Widen the operation allowlist to INITIAL_PUBLISH / EMPLOYEE_MONTH_SAVE.
For INITIAL_PUBLISH all new fields must be null and its existing state/result
invariants remain unchanged. For EMPLOYEE_MONTH_SAVE both context IDs are required
in every state; IN_PROGRESS/FAILED have null result JSON; COMPLETED has a bounded
object result, existing result_plan_id equals employee_month_plan_id, and a finite
completed timestamp. Enforce the 128 KiB JSON limit. Existing hash-length, scope
uniqueness, finite expiry and fencing constraints continue to hold.

The server validates the exact versioned SaveResult schema on write/replay; JSON
is never a raw client request. Persist only receipt IDs, dates, roles, sources,
versions, resolved intervals and counts. No unavailableDates, workforce snapshot,
medical/status details, names, other staff rosters, raw key or lease token.
The result is personal planning data requiring the same tenant/actor purpose and
bounded retention as the command. No result is a second authoritative plan.

Share the existing tested claim/fencing protocol through a transaction-aware
command component with operation-specific fingerprint/result codecs. Do not
route this operation through the hard-coded publish codec, copy its service into
a subtly divergent protocol, or change INITIAL_PUBLISH's hash/scope/result rules.
Migration/regression tests must prove old publication records and replays survive.
Update affected catalogue classification/signature checks together; the four
canonical planning tables themselves need no schema change.

## Key, fingerprint, replay and explicit retry

Use the Phase 8.7 key format (8…128 visible ASCII), cryptographic hash at rest and
scope `(company, actor account, operation, key hash)`, spanning all plans/employees.
The fingerprint is SHA-256 of a versioned canonical tuple containing both route
IDs, normalized lifecycle/time, creation-context checksum and every date/kind's
expected duty ID/version and selected role. Sort dates, normalize UUID case and
canonical timestamps; JSON property order/whitespace and input date-array order
do not affect identity. Exclude correlation/CSRF/session tokens and the key.

Use a short durable IN_PROGRESS claim; then one business transaction takes the
same nonwaiting I advisory scope plus reservation row before E/P/M/L/D/A2/Q.
Hold it through business writes, audit and COMPLETED result. Stale takeover uses
the existing attempt-ID fence and proves exclusive I ownership, not merely age.
FAILED is marked only after rollback and never overwrites COMPLETED. Recheck
current authorization/visibility in both transactions and before any replay.

The new context FKs also affect the **short claim** transaction. Before inserting
or changing those context columns, prelock target E NO KEY UPDATE, P SHARE and
the plan L KEY SHARE, in that order after I (no M/D/A2/Q is needed for a technical
claim). These are final claim-transaction modes; it never upgrades L or executes
business writes, and COMMIT releases them before the separate business prefix.
This avoids relying on implicit FK trigger order to acquire E after L. Existing
completed replay needs no new context-FK writes or eligibility locks. Preserve
INITIAL_PUBLISH's claim path unchanged. Include this FK ordering in T3 tests.

Same key + different fingerprint: 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST.
Same key still executing: 409 IDEMPOTENCY_REQUEST_IN_PROGRESS. Completed same
command: HTTP 200 immutable SaveResult, `Idempotency-Replayed: true`, fresh HTTP
correlation, no new audits/writes. A receipt describes the original committed
outcome even if later edits occurred; obtain a fresh projection before editing.

Retain Phase 8.7's configurable 24h terminal replay window and 5-minute stale
claim threshold. Expiry is not proof of failure or physical erasure. Do not reuse
an old key for revised intent. The lookup GET applies A/C authorization and I
coordination, without claiming/resetting any row, and returns HTTP 200:

```ts
type SaveOutcome =
  | { state: 'COMPLETED'; result: SaveResult }
  | { state: 'IN_PROGRESS'; retryAfterSeconds: number }
  | { state: 'NOT_COMPLETED' } // FAILED marker, exclusive I, no completed result
  | { state: 'UNKNOWN' }; // absent/expired receipt; not evidence of failure
```

The lookup is scoped to the current actor, operation and exact route context;
a stored context mismatch is concealed 404. A contended I may instead return
the existing in-progress 409. GET never applies/retries/reclaims a save. After
NOT_COMPLETED, an explicitly confirmed exact-key/body POST can safely attempt
the original intent through full revalidation. After UNKNOWN, reconcile a fresh
projection and explicitly confirm a new intent/key; do not infer failure.
After an ordinary conflict, corrected/rebased intent requires a new key.

If an old exact request arrives after receipt expiry, its original effective
write has changed at least one monotonic duty version or formerly absent slot,
so the complete old preconditions prevent duplicate application. A repeated
no-op can only remain a no-op. This backstop does not replace the retention/retry
contract or authorize automatic retry. Account/session revocation and hidden
resources still deny receipt access. Global session-account locking may serialize
same-account requests before they reach I; immediate HTTP in-progress response is
not promised by the advisory lock alone.
