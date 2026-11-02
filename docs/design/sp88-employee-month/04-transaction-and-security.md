# Proposed PostgreSQL transaction, security and audit design

T2/T3/T4 approval is required. This is a correctness argument for a proposed
writer, not evidence that an SP-88 implementation exists. The exploratory tests
prove only the PostgreSQL mechanisms described in the evidence document.

## Admission strategy and alternatives

Recommend READ COMMITTED, the existing L1 prefix, and **L FOR UPDATE from the
first plan-row lock** for this new batch. Existing create/PATCH/DELETE/lease
writers take L SHARE before D. First Publish takes L UPDATE. Therefore a batch
can freeze this plan's live slot set without introducing a second locking
namespace that existing writers ignore. No global revision or user-duration
month lock is created. The cost is short serialization and conservative
full-month stale conflicts; this is an explicit Phase 8.7 amendment.

L SHARE alone cannot protect a nonexistent duty row. A partial unique index
prevents duplicate slots but does not validate an entire absence read set.
New advisory slot locks would require every SP-12/create/Publish writer to adopt
the protocol. A SERIALIZABLE-only batch would still need lease/version semantics
and explicit human conflict handling; mixing it with current writers is no
shortcut. A persisted month revision would introduce another write protocol.
These alternatives are not recommended for the initial implementation.

The PostgreSQL row-lock conflict matrix shows UPDATE conflicts with SHARE;
its READ COMMITTED semantics give a fresh snapshot to each subsequent statement.
Use **a new statement after a wait**, not values materialized before it.
See [PostgreSQL 17 row locking](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS)
and [READ COMMITTED](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED).

## Exact transaction phases

The application service owns one business `DatabaseService.withTransaction`.
The short reservation transaction is separate technical state; it contains no
planning mutation. It is not a partial monthly save. No day savepoint commits,
parallel per-duty transactions, public service method loops or nested transaction
owners are allowed. Shared helpers accept the caller's client and locked context.

```text
A accounts (UUID order, final strength)
  -> C company SHARE
  -> I command advisory try-lock + reservation row UPDATE
  -> E employees NO KEY UPDATE (UUID order)
  -> P project SHARE
  -> M existing month links SHARE (UUID order)
  -> L monthly plan UPDATE (never SHARE then upgrade)
  -> D all existing duties UPDATE (UUID order; new duties as below)
  -> A2 all active memberships UPDATE (UUID order)
  -> Q all existing lease rows UPDATE (UUID order)
  -> W no workflow integration in this slice
  -> Z business audit + immutable command result/completion
```

1. **Boundary and A/C.** Apply existing 5s lock / 15s statement timeouts. Use
   `lockAccountsPrefix(actor, COMPANY_ADMIN)` once in this transaction, account
   SHARE then company SHARE, at final strength. The batch changes no target
   account. Recheck active account/company/live role. Through an Identity-owned
   transaction-aware read contract, recheck the trusted session ID's ownership,
   revocation and expiry using fresh time under the already-held account lock.
   No second `validateAndTouch`, account UPDATE upgrade or session row lock is
   taken late. Revocation writers already lock account UPDATE before sessions.
2. **I and visibility.** Assert schema integrity and plan/employee tenant
   visibility. Take the nonwaiting scoped command advisory lock, then the
   reservation row UPDATE; validate fingerprint, context, state and attempt-ID
   fence. Completed replay is handled before new business eligibility. An absent
   reservation is protected by I in the short claim. Retain I/row through COMMIT.
3. **Nonlocking discovery.** Read the plan, all its live duties and all ACTIVE
   memberships. Determine the complete employee set: selected employee plus
   **every** active roster employee of this full-month read set. Record duty
   identities/versions/temporal provenance and sorted membership signatures
   (ID, duty, employee, role, source). Discovery is not authorization/eligibility.
4. **E/P/M.** Lock the complete E set in UUID order at NO KEY UPDATE. Missing
   selected employee is concealed 404; an internally discovered broken reference
   is schema/integrity failure. Lock project SHARE, then all existing links for
   these employees and this month, ordered by link UUID, SHARE. An absent link
   is protected by the employee parent because its writers take conflicting E.
   After waits use fresh reads for status, employment, eligibility, links and
   the effective whole configuration. Reapply project visibility (ARCHIVED 404).
5. **L.** Lock the tenant plan UPDATE immediately at its final strength. Freshly
   reread its lifecycle and **complete** live slot/member set after L is acquired.
   Determine precondition/discovery drift; remember a refusal without acquiring
   any newly discovered E/P/M/A lock. All approved plan writers must pass L, so
   the set now remains stable through COMMIT. Unknown newly discovered employees
   cause conflict, never late employee locking or unprotected eligibility reads.
6. **D.** Lock all current live duties, not just selected existing memberships,
   in UUID order at UPDATE. For absent slots that need creation and whose known
   preconditions match, prepare their D6 snapshots, collecting any configuration/
   interval conflict without changing its precedence. Allocate new duty UUIDs
   through PostgreSQL before this phase; merge their IDs into D's UUID order and
   insert valid tentative new duties at their ordered D position. This keeps
   every duty parent present/owned before A2/Q. They are initially empty inside
   the uncommitted transaction. If drift is already known, skip provisional
   creation. Any later refusal rolls these rows back. L UPDATE plus the live-slot
   unique index protects creation; a generated-ID/integrity failure aborts.
7. **A2.** Lock all current ACTIVE membership rows of the pre-existing duty set
   in membership UUID order, UPDATE. Keep the pre-write signatures. New membership
   rows are inserted only after final validation, with their employee and duty
   parents already locked/owned (the same pattern as SP-12). They require no late
   lock on another existing parent. No retained REMOVED history is mutated.
8. **Q.** Lock existing lease rows for the duty set in lease UUID order, UPDATE.
   A missing Q row is protected by D UPDATE; a lease command must first acquire
   L/D and cannot insert behind the batch. Evaluate `released_at` and
   `expires_at > clock_timestamp()` in a fresh statement after **all** waits.
   Apply the internal admission rule below. No expiry from transaction-start
   `now()` or from a pre-wait application clock may authorize a write.
9. **Preconditions and validation.** Refuse active leases on potentially changed
   existing duties first; then lifecycle/slot/context/calendar/discovery drift. Compare
   against the pre-provisional-creation snapshot, excluding this transaction's
   tentative rows from the discovery comparison. If there is no effective delta,
   complete NO_OP without eligibility checks, lease changes or domain writes.
   Otherwise validate project/configuration and the complete projected result
   as below. Recheck session expiry with fresh time before mutation; account
   SHARE prevents concurrent account-based revocation from passing in between.
10. **Mutate.** Conditional version UPDATE of each changed existing duty exactly
    once (company, plan, duty ID, live state, expected version). New duties retain
    initial version 1. Apply only the selected employee's membership delta; assert
    expected affected counts. Retain source/ID for roles, tombstone removals and
    use new NORMAL membership IDs for additions. Preserve all temporal snapshots
    of existing duties and every other employee's membership. No duty tombstones,
    month assignment writes, lifecycle updates or publication metadata updates.
11. **Z and COMMIT.** Emit all required approved duty/membership delta audits on
    this same client. Persist the exact bounded SaveResult and transition the
    fenced reservation to COMPLETED in this transaction; require one affected
    row. Only COMMIT permits an HTTP success. A late SQL, audit, result encoding
    or completion error rolls back everything, including provisional duties.

All existing D locks must precede **any** A2 or Q lock; do not execute
`D1/A2-1/Q1/write, D2/A2-2/Q2/write`. Never call an SP-12 orchestration method
that reacquires A/C/E/P/M/L from inside the batch. If schema signatures or a
future workflow table are unsupported, fail closed as today; this gate neither
implements W nor bypasses its future reconciliation requirement.

The tentative-duty insertion is a deliberate implementation detail requiring T2
review: it avoids introducing a new duty parent after Q. Expected validation
failures may occur after uncommitted SQL, but **none** may persist. Do not return
or log provisional IDs in a conflict. Configuration errors recorded during
preparation are surfaced only at their specified validation stage.

## Coexistence with interactive leases

Recommend a new, explicitly approved **short command admission** mode, using the
existing Duty lease scope. The month editor takes no durable leases while the
user thinks. Once L/D/A2/Q are held, check every existing duty that the tentative
target-employee delta would change. A nonreleased, unexpired interactive lease
on any of them refuses the whole command with ACTIVE_DUTY_EDIT, **including the
same account in another tab**. Ask the user to close/release that editor or wait
for actual expiry; do not rotate it or accept ownership alone as token proof.

When no live lease conflicts, D/Q locks are the internal command admission until
COMMIT. Do not create, renew, rotate or release a persisted lease record. This is
not a new public token exemption for SP-12: it is a new command mode needing an
ADR-0006/Phase-8.7 supplement and security approval. New duties have no previous
interactive editor; existing create semantics need no token for that absent slot.
Untouched duties/true no-op do not steal or invalidate leases. All observed duty
versions still must match, including untouched slots.

Alternative: acquire a client lease for every changed duty and carry 62 proofs.
It preserves interactive token semantics but introduces partial acquisition,
renewal/release recovery and cross-tab token rotation across shared aggregates.
Holding a long month lease would block unrelated work. Neither is recommended.
Blindly calling `acquireDutyLease` is specifically unsafe: its approved
same-account reacquisition rotates another tab's token. The internal admission
helper must check/block rather than invoke that behavior.

Admission occurs after the last wait; once admitted, locks protect the operation
through COMMIT even if an inactive retained lease expires during the transaction.
A waiting lease acquire/renew/release proceeds afterwards through normal SP-12
rules. Publish remains as #86 specifies: it does not invalidate idle leases or
require them for its lifecycle-only write.

## Validate the resulting month, not an SQL execution sequence

Build a projected roster for each effectively changed duty from locked existing
members: keep every other employee exactly, retain/change/remove the target,
and add the target only where selected. A true no-op does not force eligibility.
For an effective update inherit SP-12's validation of **all remaining members**,
not only the selected employee. Empty resulting rosters are valid.

For overlap use a single virtual result set:

```text
effective memberships = current ACTIVE memberships on all live duties
                        minus this command's target-employee removals
                        plus this command's target-employee additions
interval(duty) = saved UTC for existing; approved D6 result for new
overlap(a,b)   = a.startsAt < b.endsAt AND a.endsAt > b.startsAt
```

Check all resulting assignments of affected roster employees against this set,
excluding only the same assignment/duty as appropriate. Include unchanged duties,
both lifecycle states, other plans and adjacent-month overnight intervals.
Explicitly check proposed additions against one another. Independently count active memberships
per employee/project/local dutyDate in the final set: at most one DAY/NIGHT, even
when their saved UTC intervals are adjacent. No UTC-only shortcut is sufficient. Do not exclude whole
other affected duties or all of this employee's old month: either would conceal
real overlaps. Remove only the target's intended old memberships in the overlay.

Thus DAY→NIGHT is judged after its DAY removal, rather than spuriously conflicting
with the old membership. Another employee's overlapping assignments remain
visible and may block the aggregate update. Role changes alone still inherit
SP-12 resulting-roster validation. Keep the existing employee-rule precedence
and local-start-date availability/employment rules. New slots use the latest
whole configuration (no per-kind inheritance); existing duty UTC/provenance is
unchanged even across DST or later configuration work.

## Concurrency argument and writer compatibility

| Competing writer | Coordination / result after waiting |
|---|---|
| SP-12 PATCH/DELETE | E/P/M then L SHARE conflicts with batch L UPDATE. If writer commits first, versions/discovery differ and batch refuses; if it rolls back, unchanged preconditions may pass. If batch commits first, an old SP-12 version fails (provided its live lease admission passes); rollback leaves the old version valid |
| Duty create, including unstaffed slot | L SHARE blocks behind UPDATE even with no D row to lock. Creator-first COMMIT makes expected absence stale; ROLLBACK leaves absence. Batch-first creation makes later duplicate create fail uniqueness; batch rollback leaves the slot creatable |
| Another employee-month batch | Same E set order and L UPDATE serialize; shared-duty or any full-read-set version change causes the stale batch to refuse. Even disjoint batches in this plan may conflict by design. Across plans, shared employee E locks protect overlap checks |
| First Publish (#86) | Same E/P/M prefix and L UPDATE. Publish-first COMMIT changes expected lifecycle; batch requires a new review. Publish rollback preserves it. Batch-first COMMIT is included in Publish's fresh full validation, or causes discovery refusal; no half-month publish. Batch rollback exposes no changes |
| Lease acquire/renew/release | P/L/D/Q order: cannot hold D/Q and then request L. Idle lease blocks affected batch at admission. In-flight lease command serializes on L/D; fresh post-wait expiry is authoritative |
| Availability SET/CLEAR/batch | Conflicting E serializes, fresh neutral facts validate. A later availability fact can legitimately make an already saved/published duty show a neutral conflict, as currently approved; batch does not prevent later fact correction |
| Employment / eligibility | Conflicting E, fresh remaining-roster validation. Existing D5 guards can refuse a newly excluding employment change. A later change is governed by its existing rules, not a new batch veto |
| Employee/account deactivation | Deactivation discovers account then takes ordered A at final strength before E. Existing future-duty guard may refuse it; no E→A inversion. Batch never asks for that target account after E |
| Month assignment create/correct/delete | E protects missing and existing link context; M SHARE protects known rows. Existing D2 dependency guards remain active for live duties in both plan states. Recheck after waits; do not force an otherwise forbidden writer to commit in tests |
| Project status / configuration | P SHARE conflicts with their NO KEY UPDATE. Fresh visibility/configuration/creation checksum after wait; D3/D4 may already forbid a change, including empty duties. No child-lock query is added to workforce writers |
| Role change / individual session logout / reset | Account lock serializes with A SHARE. Fresh session read catches revocation between guard and application admission; account/role recheck catches revoked authority. If batch admitted first, it may finish before revocation takes effect; revocation-first prevents execution/replay |

No-partial-write argument: one client/transaction contains all duty rows,
membership deltas, audits and completion; no other connection can observe a
committed prefix. Rollback restores versions, tombstones, provisional slots and
audit. The durable claim may remain FAILED/IN_PROGRESS, which is technical state,
not a saved planning date.

No-lost-update argument: compare every observed slot under L, condition every
existing effective duty update on its version, and retain a matching lifecycle.
Do not accept a changed identity/version as an automatic no-op. Concurrent edits
cannot be copied out of an old employee-only roster over other staff.

No-new-cycle argument: every waiting edge of this writer advances in L1 rank;
within a tier, existing rows use UUID order and final modes. I is nonwaiting.
L is UPDATE from first acquisition, so there is no L SHARE upgrade cycle. New
rows are transaction-owned and all referenced parent locks already exist before
children/audit/completion. A workforce writer waiting for E/P owns no later child
lock that this batch needs. A competing planning writer waiting for L owns no
D/A2/Q lock. Discovery drift aborts without obtaining late E/M/accounts. The
company row remains a SHARE-only leaf. These are explicit assumptions to prove
with the application-level concurrency matrix, not a guarantee for unreviewed
future writers, DDL or out-of-band SQL.

Keep current timeout/error policy: 55P03, 40P01, 40001 and unknown SQL errors are
sanitized 500 and full rollback; no automatic human-command transaction retry.
15s is per statement, not a 15s whole-command guarantee. Measure bounded-month
latency and parent/roster lock footprint before acceptance; do not invent a
staffing cap to conceal performance problems.

## Security and audit review

All predicates include server-derived company ID, including discovery, parent
locks, membership updates, overlap queries, leases, reservations and result reads.
Composite FKs enforce company ownership. A submitted expected-duty ID is only
compared with this tenant's current slot; never query another tenant to explain
why it mismatches. A foreign employee or plan is concealed 404; foreign-looking
expected IDs in an otherwise owned request yield only an ordinary stale conflict.
The target employee cannot be replaced by a body field. Names, account roles,
company IDs, source, availability and resolved timestamps are not writable DTOs.

The proposed Identity session read is necessary for this command: main's
`lockAccountsPrefix` rechecks account/company/role, while the global guard owns
session validation in a preceding transaction. It does not itself recheck a
particular session row. Do not claim that the existing helper alone closes this
guard-to-command revocation gap. A new read-only Identity contract under A/C
must reuse session expiry rules and pass logout/reset races without lock upgrades;
this does not authorize Issue #51 operational changes or a broad auth rewrite.

Proposed audit scope: reuse ADR-0004's existing bounded actions and payloads:

| Effective change | Events, all inside the business transaction |
|---|---|
| New duty and this employee's membership | One DUTY_CREATED (D payload), one DUTY_MEMBERSHIP_ADDED (M payload) |
| Existing duty membership delta | One DUTY_UPDATED per changed duty, plus only effective DUTY_MEMBERSHIP_ADDED/UPDATED/REMOVED |
| No-op / replay / refused batch | No business success audit |

D is `{planId,dutyDate,shiftKind,startsAt,endsAt,version}`. M is
`{dutyId,employeeId,dutyRole,source}`. Removal uses the existing bounded state /
persisted removal-timestamp representation. Keep the trusted tenant, actor,
server correlation and persisted occurred-at envelope. Role updates preserve
source; removals retain history. Audit order is duty UUID then deterministic
membership UUID/category order. An Nth audit failure must roll back earlier
events and all dates. No new MONTH_SAVED event or whole-month before/after audit
is proposed. Extending approved event usage to this new command still requires
explicit audit/security scope approval; it is not supplied by #86's Publish event.

No medical facts, names, contact details, raw keys/tokens, arbitrary exception
strings or full rosters enter receipts, errors or logs. Error dates/kinds belong
only to this authorized plan/employee context. A preserved-roster problem is
neutral. Never return a stale conflict list from another tenant or echo provisional
IDs. Extend ProblemDetailsFilter with a specific validator, lengths/enums/date
checks and context authorization; unknown extensions fail closed.

The frontend must retain the complete draft even after an authorization failure,
without rendering it to an unauthenticated/different principal. T4 covers a
volatile recovery store bound to the original actor/company/resource context,
same-actor reauthentication and explicit reconciliation. Do not solve retention
with localStorage, exposing the old plan after a new login, or automatic replay.

No new notification/outbox obligation is invented. If an approved later release
requires one, its intent must join the same transaction before acceptance;
provider delivery remains after commit. Cancellation/replacement reconciliation
is outside this slice; when those tables arrive the guarded schema and writer
integration must be reviewed together. Retention execution, privileged SQL,
append-only DB roles, backup/restore and deployment remain #51's separate gates.

## Revision: exclusive daily assignment and SP-90 across all writers

Approved BR-1 supersedes the earlier nonoverlap-only proposal. Full read still
includes two shared duty slots per date, but desired state is exclusive. The
[SP-90 calendar design](../sp90-project-operating-weekdays.md) supplies proposed
migration, effective interval, missing/legacy behavior, audit and guard rules.
Do not deploy new invariants only inside the employee-month endpoint.

| Path | Exclusive employee/project/dutyDate rule | Operating weekday / compatibility |
|---|---|---|
| SP-11 createEntry, staffed or empty | For every added employee validate final live assignment set, including other kind at same date; E locks cover submitted staff | New canonical duty date must be configured/open even if empty; retain explicit existing duty creation API until controlled P2 disposition |
| SP-12 PATCH membership add/role/date/kind/time | Validate all remaining roster members at resulting project/local date against live duties excluding only this duty's old projection; old and new staff E union before P | New memberships, kind/date moves and role-mutated target work require open configured start date; preserved unchanged closed memberships can remain during unrelated repair; keep existing full resulting-roster eligibility rules |
| SP-12 DELETE / pure membership removal | Cannot introduce dual; remaining changed-roster staff still checked as SP-12 requires; target removal can correct dual | Allow reduction on legacy closed/missing-calendar dates if existing operation-specific project/lease/version/other guards pass; do not introduce calendar veto on deleting bad data |
| SP-88 full month | Final overlay removes target old memberships, adds at most one desired kind per date; reject invalid desired encoding and conflicting final result | Match effective calendar token; new/replaced/role-mutated target assignment open; no-op/unchanged/removal compatibility; no partial skip |
| First Publish (#86 follow-up on integrated main) | Check entire live plan, all active memberships, same-date exclusivity plus independent UTC overlaps | Require configuration; all live duty start dates open, including empty duties (proposed P4/P2). Refusal rolls back lifecycle, audit, completion |
| CR-03 after publication | Same create/PATCH/DELETE/batch checks, no secondary draft | Immediate changes with same guards, preserve publishedAt; no republish |
| Project calendar PATCH | Does not mutate membership or repair dual automatically | P NO KEY UPDATE; newly excluded live duty guard, both lifecycles, staffed/empty; fresh interval reads |
| Shift configuration / project status | Existing D3/D4 remain; no new shift-time rewrite | Same P barrier. Separate calendar does not weaken D3; configuration cannot accidentally overwrite weekdays |
| Future cancellation/replacement | Later owner must validate resulting roster including newly accepted replacement employee under E and workflow tiers | Must honor start-date calendar on new/replaced work plus W reconciliation; future contracts gated, not implemented here |

Removal-only compatibility is a scoped new-rule policy, not a waiver of SP-12's
existing resulting-roster validation. For example another ineligible preserved
worker can still block a shared-duty patch. A legacy target dual can be corrected
by retaining one kind/removing the other, or removing both. A full month read with
an unresolved dual must require explicit user correction before constructing its
exclusive request. Existing bad data remains detectable; migration neither picks
winners nor deletes it. First Publish is stricter than unrelated repair saves.

### Protecting absent opposite-kind assignments without extra lock tiers

Every membership-changing writer already takes affected employee E NO KEY UPDATE
before P SHARE. Query the final active assignment set for each resulting employee,
project and civil date in a **new statement after E/P waits**, excluding only old
memberships explicitly replaced by the command. E serializes competing assignments
for that employee even if DAY/NIGHT duties or plans are currently absent. Across
employees, no shared exclusivity fact is overwritten; D versions protect shared
aggregates. Date/kind mutations must validate all affected roster employees with
their existing discovered/desired E set. Unknown newly discovered employees abort,
never acquire E after D. No new late lock on an opposite duty, calendar row or
account is permitted. Read the opposite duty through the protected parent scope.

For calendars, take P SHARE as already specified, then fresh read the effective
calendar. P NO KEY UPDATE from the calendar writer blocks all planning writes
and Publish at their parent stage. Never take a calendar child UPDATE lock after
Q, and never add L/D locks to the calendar dependency guard. Parent stability
protects absent versions and their effective interval. Include calendar ID/version
in the request preconditions and creation checksum, but not as an FK on tentative
new duties; its parent scope is already held. All D (existing+new sorted UUID)
still precede all A2 and all Q. The short idempotency claim FK prefix remains
A/C/I/E/P/L KEY SHARE; it makes no calendar/business writes and releases before
the complete business prefix. No migration may introduce a new FK causing a
late calendar/project/employee lock after the owned parent stages.

### Both-order outcomes required using actual schema

Calendar-first COMMIT makes old batch calendar precondition stale, even for a
compatible set; ROLLBACK leaves it valid. Batch-first COMMIT makes newly excluding
calendar PATCH refuse; ROLLBACK leaves dependency-free PATCH eligible. If calendar
PATCH is already forbidden by a saved dependency, test its refusal plus a separate
fixture where a real configuration COMMIT is allowed. Concurrent opposite-kind
SP-11/SP-12 adds for the same employee/date cannot both commit: later writer sees
the first through E, or can proceed if it rolled back. Publish-first may complete
before a new calendar proposal only if its protected plan is currently valid;
a later closure cannot invalidate its saved duties. Batch-first is wholly visible
to Publish after commit or invisible after rollback. Active leases are still
checked before stale/calendar/business conflicts as the API specifies.

This is a lock-order proof sketch under the all-writers protocol, not executed
concurrency evidence. Actual-schema HTTP/PG tests must observe blocking and both
COMMIT/ROLLBACK outcomes, including newly discovered staff, multiple D/A2/Q rows,
calendar absence/bootstrap and idempotency claim/completion failure.

Existing SP-12 **whole-duty DELETE** can remove inactive-project history under
its approved removal contract; do not confuse it with membership-removal PATCH,
whose effective-write ACTIVE project/resulting-roster rules still apply. The
new calendar must not disable that existing correction path. Temporal PATCHes
that change actual assigned work also require an open configured start date for
all remaining staff, even if employee IDs are retained; unchanged snapshots and
pure reductions follow the scoped compatibility rules.
