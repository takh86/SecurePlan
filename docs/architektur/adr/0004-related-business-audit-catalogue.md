# ADR-0004 — Bounded catalogue for related assignment and shift audit actions

- **Status:** Names and existing business meanings approved by PO D1; independent
  documentary acceptance of the controlled catalogue amendment pending.
- **Date:** 2026-10-29.
- **Authority:** [Issue #64, D1–D6](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6502123168),
  [original Case 4](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6474708196),
  [removal contract](https://github.com/takh86/SecurePlan/issues/73#issuecomment-6492654582),
  and [ADR-0003](0003-schichtkonfiguration-monatsversioniert.md).
- **Scope:** Public summary derived from the approved public decisions and
  implemented code at `7107781e1cbd9aab232cd394662372c1fb7cf92f`.
  This document does not publish the private baseline or replace its controlled register.

## Decision

Retain the following four names and their current semantics. D1 does not approve
every member of `BusinessAuditAction`. No event rename, schema change, historical
backfill or new success event is introduced by this reconciliation.

| Action | Resource | `oldValues` | `newValues` |
|---|---|---|---|
| `PROJECT_ASSIGNMENT_CREATED` | `PROJECT_ASSIGNMENT`, newly created assignment ID | SQL null | Complete `{employeeId, projectId, monthStart}` tuple |
| `PROJECT_ASSIGNMENT_CORRECTED` | `PROJECT_ASSIGNMENT`, existing assignment ID | Only changed members of `{employeeId, projectId, monthStart}` | The corresponding changed members plus `scope` |
| `PROJECT_ASSIGNMENT_REMOVED` | `PROJECT_ASSIGNMENT`, physically removed assignment ID | Complete removed `{employeeId, projectId, monthStart}` tuple | SQL null |
| `SHIFT_CONFIGURATION_UPDATED` | `PROJECT_SHIFT_CONFIGURATION`, **project ID** | `{effectiveFromMonth, shifts}` for the set stored at that exact month, or SQL null for its first creation | `{effectiveFromMonth, shifts}` for the complete resulting set |

Correction `scope` is `FUTURE` only if **both** old and resulting month are after
the company-local current month; otherwise it is `HISTORICAL`. A historical→future
move retains HISTORICAL scope while enforcing the approved destination-future
employment and ACTIVE rules. Scope is in `newValues`, not both value objects.
Audit contains the delta, not a fabricated full before/after tuple.

Each shift set contains 1–2 rules with only `shiftKind`, `startLocal`, `endLocal`;
API kinds are DAY/NIGHT and local times are HH:mm. The old set belongs to the
**exact replaced effective month**, not the older effective version inherited
when that month had no version. Full-set replacement is the business operation;
the implementation can preserve IDs by diff-applying rows. It emits one event,
not an event per shift or dependent duty. An order-only identical set is a no-op.

## Attribution, minimization and atomicity

All four successful operations are COMPANY_ADMIN writes using trusted session
tenant and transactional actor recheck. Each event carries company, actor account,
action, resource type/ID, server-issued request correlation ID and database
`occurred_at`. The audit uses the caller's transaction client.

Assignment payloads contain at most three tuple members per side plus correction
scope; shift payloads contain at most two rules per side. No names, email,
credentials, tokens, free-text reasons, full plan copies or unbounded dependency
lists are included. Employee/account IDs remain **pseudonymous personal data**;
their presence is intentional and still requires access and retention controls.

- Exactly one success event per effective successful operation.
- True correction/configuration no-op: no mutation and no audit.
- Removal has no successful absent-row no-op: repeated DELETE returns concealed
  404, leaves the final absent state unchanged and emits no second success audit.
- Authorization, validation, version, month and dependency refusals emit no
  business success audit.
- An audit insertion failure rolls back the business mutation. A later failure
  inside the same transaction also rolls back its audit. No silent cascade or
  automatic replacement accompanies removal.
- Audit resource IDs are not a foreign key requiring the removed assignment to
  survive. The full old tuple remains reconstructable from the removal event.

## Verification and remaining acceptance

Existing Real-PG assertions are in `project-assignments-real.e2e-spec.ts`,
`project-assignments-patch-real.e2e-spec.ts`,
`project-assignments-remove-real.e2e-spec.ts`, their concurrency suites and
`shift-configurations-real.e2e-spec.ts`. They check attribution, bounded values,
scope, no-op/refusal and audit rollback. See the
[CI and closeout matrix](../../reviews/sp09-closeout-64-73.md) for actual run IDs
and totals. No database tests are executed by this documentation audit.

The source comments in `business-audit.service.ts` now refer to the scoped PO D1
approval recorded here. This reconciles the vocabulary without renaming events
or changing emitted payloads. Other actions in that union retain their own
approval status, including development-only activation recovery.

The ignored local canonical amendment records the baseline comparison and these
four definitions. Independent Tech Lead/API/audit-owner acceptance of that
document remains required before #64/#73 administrative closure. Original
baselines and earlier ADR history remain preserved.

## Supplement 2026-11-02 — SP-11 PR-1 planning creation events

The owner ratified exactly three further actions with the SP-11A technical design
(31.10.2026). They are implemented in SP-11 PR-1 ([evidence](../../reviews/sp11-pr1-planning-foundation.md));
edit, removal, publish and workflow actions are later, separate decisions.

| Action | Resource | `oldValues` | `newValues` |
|---|---|---|---|
| `MONTHLY_PLAN_CREATED` | `MONTHLY_PLAN`, plan ID | SQL null | `{projectId, monthStart, status}` |
| `DUTY_CREATED` | `DUTY`, duty ID | SQL null | `{planId, dutyDate, shiftKind, startsAt, endsAt, version}` |
| `DUTY_MEMBERSHIP_ADDED` | `DUTY_ASSIGNMENT`, membership ID | SQL null | `{dutyId, employeeId, dutyRole, source}` |

Audit payload values use the public API vocabulary: DAY/NIGHT and
EMPLOYEE/SHIFT_LEAD. The API/audit vocabulary differs from some SQL names:
`MONTHLY_PLAN.status` uses `UNPUBLISHED` / `PUBLISHED`; `shiftKind` is DAY/NIGHT
(stored as TAG/NACHT); `dutyRole` is EMPLOYEE/SHIFT_LEAD (stored as
MITARBEITER/SCHICHTLEITER); `source` is NORMAL/REPLACEMENT in both. An audit
membership resource is `DUTY_ASSIGNMENT`, while its SQL relation is
`public.plan_assignments`. `MONTHLY_PLAN_CREATED.newValues.status` is always
UNPUBLISHED in this slice. This describes existing mapper output, not new events.

One plan event per plan creation; one duty event plus one membership event per
initial member per duty creation, all on the caller's transaction. A failure on
any event rolls back the plan, duty, every membership and all earlier events.
Refusals write nothing. No names, e-mail, absence status or reason, tokens or
full plan copies are recorded. Accepted D4/D5 edits keep the existing
`PROJECT_UPDATED` / `EMPLOYEE_UPDATED` events without new fields. Independent
documentary acceptance of this supplement remains pending like the four above.

## Supplement 2026-11-02 — SP-12 duty mutation audit

**Authority:** explicit Product Owner approval in the SP-12 implementation
conversation on 2026-11-02. This is business-contract approval, separate from
independent technical/code/security and documentary review, which remain required.
The earlier creation-only approval above is preserved as history.

Let `D = {planId, dutyDate, shiftKind, startsAt, endsAt, version}` and
`M = {dutyId, employeeId, dutyRole, source}`. These are fixed-size per-resource
records in public API vocabulary, never full plan or roster copies.

| Action | Resource | `oldValues` | `newValues` |
|---|---|---|---|
| `DUTY_UPDATED` | `DUTY`, duty ID | Previous D | Resulting D |
| `DUTY_REMOVED` | `DUTY`, duty ID | Previous D | `{version: newVersion, removedAt: persistedRemovalTimestamp}` |
| `DUTY_MEMBERSHIP_ADDED` | `DUTY_ASSIGNMENT`, new membership ID | SQL null | M; extends the existing creation event to edits |
| `DUTY_MEMBERSHIP_UPDATED` | `DUTY_ASSIGNMENT`, retained membership ID | Previous M | Resulting M for a role change |
| `DUTY_MEMBERSHIP_REMOVED` | `DUTY_ASSIGNMENT`, retained membership ID | Previous M | `{dutyId, state: "REMOVED", removedAt: persistedRemovalTimestamp}` |

Every effective aggregate PATCH increments the duty version once and emits
exactly one DUTY_UPDATED, including membership-only changes, plus only its
effective membership delta events. Duty removal emits DUTY_REMOVED and one
removal event per active member. Tombstones and REMOVED rows retain historical
references and UTC snapshots; rejoining creates a new membership. Role changes
retain membership ID/source. Removal timestamps come from PostgreSQL RETURNING,
formatted in UTC with six fractional digits, matching the persisted instant.

After authorization, visibility, valid lease and matching version, a true
normalized no-op changes no domain timestamp/version and emits no business audit;
it does not force eligibility validation. Session validation retains its normal
session-touch behavior. Repeated removal is concealed 404. Refusals/stale writes
emit no success audit. All events use the domain transaction and trusted company,
actor and server correlation ID; any audit/late failure rolls back all earlier
domain and audit changes. No blind replay. Names, email, tokens, medical data,
free text and unbounded roster snapshots are excluded.

Lease reconciliation and the concrete L1 protocol are recorded in
[ADR-0006](0006-duty-edit-leases.md). CR-03 direct Published mutation is preserved;
publish and the future replacement workflow are not activated by this supplement.

## Supplement 2026-11-02 — SP-13 initial publication audit

The Product Owner explicitly approved the bounded contract proposed in the
[SP-13 review](../../reviews/sp13-initial-publish-contract.md), in the SP-13
implementation conversation on 2026-11-02, before introducing the endpoint.
Independent implementation/security review remains separate.

Exactly one `MONTHLY_PLAN_PUBLISHED` event targets `MONTHLY_PLAN` / plan UUID.
Old values are `{status: "UNPUBLISHED", publishedAt: null}`; new values are
`{status: "PUBLISHED", publishedAt: persistedTimestamp}`. The existing envelope
supplies company, publishing actor, server correlation ID and database event time.
No roster, names, absence information, raw idempotency key, token or complete
plan copy is included. Replay and refusal produce no success event. Publication
metadata, mandatory audit and idempotency completion commit together; failure
of any of them rolls back the business transaction. No republish event exists.

Retention period, database-role append-only enforcement, privileged access,
privacy policy, backups and restore proof are separately tracked in
[#51](https://github.com/takh86/SecurePlan/issues/51) and the
[pre-staging gates](../../security/pre-staging-gates.md). Application append-only
convention is not database immutability, and D1 does not approve indefinite
retention or operational readiness.

## A1 supplement — 2026-11-03

[PO P6](https://github.com/takh86/SecurePlan/issues/90#issuecomment-6588992180)
approves PROJECT_OPERATING_CALENDAR_UPDATED / PROJECT_OPERATING_CALENDAR, with
the project as resource. Old values are null for insertion or the replaced
effective month, sorted weekday set and safe numeric version; new values contain
the persisted equivalent and bootstrap:true only for explicit bootstrap. The
audit boundary rejects extra fields, invalid dates/sets/versions and a bootstrap
marker on old values. No-op, refusal and read produce no success event. Calendar
mutation and audit share one transaction. Existing retention/privileged-role
limits above remain open; independent T4 implementation acceptance is separate.


## CR-03 prerequisite supplement ? 2026-11-04

[SP16-D1 approval](https://github.com/takh86/SecurePlan/issues/32#issuecomment-6630358320)
and [owner kickoff](https://github.com/takh86/SecurePlan/issues/32#issuecomment-6630975690)
authorize two reconciliation events: `CANCELLATION_OBSOLETED` on
`CANCELLATION_REQUEST` and `REPLACEMENT_NEED_CLOSED` on `REPLACEMENT_NEED`.
Each records only `{status: "OPEN"}` as old values and the resulting status
(`OBSOLETE` or `CLOSED`) as new values. The existing envelope supplies the
trusted tenant, actor, resource ID, correlation ID and database event time.

Effective assignment removal, both workflow transitions, these mandatory
audits and any command completion share the planning writer's transaction.
A repeated handler call has no further effect or audit. Retained assignments
and terminal cancellations remain unchanged. This prerequisite introduces no
cancellation command, read resource, offer or decision API.

## SP-20 supplement — replacement selection audit (PRODUCT OWNER APPROVED)

**Status: PRODUCT OWNER APPROVED (2026-11-09, explicit owner decision in the SecurePlan project conversation).** The Product Owner approved precisely the four actions, resource identities, old/new payloads and counts below. This is approval of the business audit vocabulary only; independent code, security, browser acceptance, release and merge gates remain separate.

Scope: one successful `POST /api/v1/replacement-needs/:needId/selection` by a COMPANY_ADMIN. The operation changes one cancellation (OPEN to APPROVED), one replacement need (OPEN to RESOLVED), the selected offer (OPEN to SELECTED) and every other OPEN offer of that need (OPEN to NOT_SELECTED). Refusals, idempotent replays and rejected stale requests emit no success audit.

| Action | Resource | `oldValues` | `newValues` | Events per successful selection |
|---|---|---|---|---|
| `CANCELLATION_APPROVED` | `CANCELLATION_REQUEST`, cancellation ID | `{status: "OPEN"}` | `{status: "APPROVED"}` | exactly 1 |
| `REPLACEMENT_NEED_RESOLVED` | `REPLACEMENT_NEED`, need ID | `{status: "OPEN"}` | `{status: "RESOLVED", selectedOfferId}` | exactly 1 |
| `REPLACEMENT_OFFER_SELECTED` | `REPLACEMENT_OFFER`, selected offer ID | `{status: "OPEN"}` | `{status: "SELECTED"}` | exactly 1 |
| `REPLACEMENT_OFFER_NOT_SELECTED` | `REPLACEMENT_OFFER`, each rejected offer ID | `{status: "OPEN"}` | `{status: "NOT_SELECTED"}` | 1 per OPEN offer rejected |

Envelope, identical to the other administrative events: trusted company ID, the COMPANY_ADMIN actor account ID after the transactional session recheck, the server-issued correlation ID and the database event time. All rows are written in the selection transaction; any audit failure rolls back the whole selection.

The duty and membership rows written by the same transaction are not new actions. They use the already approved SP-12 contract in API vocabulary (`dutyRole` EMPLOYEE, never the stored duty-function word):

| Action | Resource | `oldValues` | `newValues` |
|---|---|---|---|
| `DUTY_UPDATED` | `DUTY`, duty ID | previous D | resulting D |
| `DUTY_MEMBERSHIP_REMOVED` | `DUTY_ASSIGNMENT`, original membership ID | previous M | `{dutyId, state: "REMOVED", removedAt}` |
| `DUTY_MEMBERSHIP_ADDED` | `DUTY_ASSIGNMENT`, replacement membership ID | SQL null | M of the replacement (source `REPLACEMENT`) |

A successful selection with one losing OPEN offer therefore produces seven rows in one transaction. The payloads contain IDs, statuses, bounded duty values and persisted timestamps only. No names, e-mail addresses, absence reasons, tokens or complete plan copies are recorded.

**Recorded decision: APPROVED — Product Owner, 2026-11-09.** Approved scope is limited to the four new SP-20 audit actions and their exact resource identities, bounded old/new payloads, occurrence rules and shared transactional envelope specified above. Existing SP-12 audit actions remain governed by their previously approved contract. This approval does **not** authorize merging PR #116, merging PR #117, deployment, or closure of technical acceptance findings.
