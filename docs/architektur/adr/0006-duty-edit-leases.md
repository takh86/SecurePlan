# ADR-0006 — Duty edit leases and mutation locking

Date: 2026-11-02. Business scope approved explicitly by the owner in the SP-12
implementation conversation. Technical implementation remains subject to
independent review. This code-derived decision reconciles the existing lease
API with the approved SP-11A Rev3.1 T7/T8 staging and LOCK-01-L1; it does not
publish or replace the controlled originals.

## Decision

Migration 0012 adds the duty-only part of `edit_leases`: tenant/duty/owner
composite foreign keys, one slot per duty, SHA-256 token hash (32 bytes), acquired,
renewed, expiry and release instants. Tokens use 32 random bytes, canonical
base64url, and are returned only to the holder. PostgreSQL-generated UUIDs follow
the repository's ratified strategy. The token hash and release marker complete
the older physical model's columns as required by the later hash-only API and
the owner's authenticated-release rule. Workflow-case columns/FKs remain deferred.

Default TTL is 120 seconds; clients renew around 60 seconds. Technical setting
`SECUREPLAN_EDIT_LEASE_TTL_SECONDS` accepts positive PostgreSQL-int seconds;
invalid configuration fails startup. PostgreSQL clock instants govern expiry,
never transaction-start time or a client timestamp. Responses preserve microseconds.

Acquire/rotate is a conditional upsert: another actor's live slot returns
409 RESOURCE_EDIT_LOCKED. Same-owner rotation or takeover of an expired/released
slot replaces the hash. Renewal requires the current owner/token and a live,
unreleased lease; expiry cannot be renewed into ownership. Release authenticates
the retained owner/hash even after expiry/release, then returns 204 without
changing an already released row. Arbitrary, foreign or rotated tokens return
409 EDIT_LEASE_NOT_HELD and never release a newer slot. Retaining one last hash
per duty permits safe idempotence without a token-history table; an overwritten
token can no longer authenticate release. No cleanup deletes that evidence here.

HTTP precedence preserves the existing guard/DTO/resource-ID pipeline. Required
Expected-Version syntax is parsed before the missing-lease-header check (both
400). EMPTY_PATCH, civil date and visible-plan month checks precede business
409s. Visibility/concealment precedes token authentication. Under the locks,
lease authentication/expiry precedes version/discovery-drift 409, then true no-op,
then effective-write eligibility. Malformed tokens are never echoed and use
EDIT_LEASE_NOT_HELD. A missing required token is 400 EDIT_LEASE_TOKEN_REQUIRED.
This refines otherwise unspecified combined-error precedence consistently with
the existing lease-before-version application preconditions; no error is renamed.

## Locking and lifecycle

Mutation: A ordered account prefix -> C company SHARE -> E all discovered and
desired employees in UUID order, NO KEY UPDATE -> P project SHARE -> M monthly
links in UUID order, SHARE -> L plan SHARE -> D duty UPDATE -> A2 active members
in UUID order, UPDATE -> Q lease UPDATE -> Z audit. Compare the complete discovered
duty/member identity set after locks; drift aborts with PLAN_CONCURRENT_MODIFICATION.
Never acquire late parent locks or upgrade modes. Lease-only commands need no E/M
work and use A/C/P/L/D/Q, protecting missing Q slots with D UPDATE. Independent
duties share L; a future first-publish writer must take L UPDATE under the same
approved prefix. No first-publish endpoint is added here.

Expiry is checked in a fresh statement after Q waits, immediately before version
and mutation validation. The command then holds D/Q through commit, preventing
lease takeover during its short transaction. Expiry during subsequent SQL does
not undo the already admitted command; Expected-Version remains the correctness
boundary. Lock timeout 5s / statement timeout 15s apply; technical failures roll
back to sanitized 500 without automatic replay.

Effective PATCH validates the resulting active roster, excluding its own duty
from overlap checks. Membership-only edits preserve exact saved UTC/provenance;
date/kind changes resolve fresh snapshots under the project lock. No-op and
removal need no new eligibility evidence. Removal can resolve visible inactive
project/employee history; it tombstones the duty, retires active memberships and
marks its held lease released, atomically with mandatory audit. CR-03 permits
direct writes in UNPUBLISHED and PUBLISHED plans, without a second Draft/publish.

Existing employee/absence/assignment writers conflict at E; project/configuration
writers conflict at P and inspect dependencies with fresh plain reads. They never
take D after an inverted parent sequence. The schema signature now covers all
four canonical relations, and recognizes unimplemented cancellation/replacement
relation names as unsupported. Their appearance fails closed until a separately
approved integration provides reconciliation. No workflow state is invented.

## Acceptance

Real PostgreSQL proofs must cover both writer orders and COMMIT/ROLLBACK, observed
blocking, membership drift, missing slots, expiry after waits, token rotation,
lease/version precedence, direct Published edits, retained history and audit
rollback. Executed results belong to the PR evidence; this ADR alone grants no
implementation PASS, independent sign-off, merge or deployment authorization.

## A1 supplement — 2026-11-03

The [calendar amendment](../../api/project-operating-calendar.md) implements PO
P4/P5 without changing lease ownership. Calendar PATCH takes A SHARE → C SHARE →
P NO KEY UPDATE from its first acquisition, then fresh configuration/dependency
reads and Z audit. It takes no E/L/D/A2/Q row locks. Duty writers and Publish
already acquire P SHARE before L/D, so calendar changes serialize with all
effective writers, including direct CR-03 edits and removal. Exclusivity reads
are fresh under the complete sorted E lock set; no late employee is acquired.
The shared schema signature now includes the calendar table and its constraints.

Identity supplies a read-only session check under A/C, scoped to the trusted
session/account/company. It uses the existing idle/absolute policy with a fresh
database clock after business-lock waits; it never calls validateAndTouch or
updates/locks a session at a late tier. Logout/reset writers require A UPDATE,
so they serialize with admitted writes. Publish claim/replay also validates the
specific session. Clock expiry is checked after P/L/D/Q waits before accepting
the business command. This is implementation evidence awaiting independent T4
review, not a security sign-off. A2 receipts and employee-month Save are separate.

## A2 batch admission supplement

Accepted for bounded backend implementation, 2026-11-03, under the
[A2-GATE-1 owner decision](https://github.com/takh86/SecurePlan/issues/88#issuecomment-6600906336),
PR #94 head `c066ff41d3a5eda8d6f20a62144fc5212e3cf280`.
The [adopted API](../../api/employee-month-save.md) and its OpenAPI define scope.

Employee-month Save uses READ COMMITTED and short batch admission rather than
interactive per-duty client leases. Acquire final strength initially:
A sorted/actor SHARE → C SHARE → I nonwaiting/reservation UPDATE → E sorted
NO KEY UPDATE → P SHARE → M sorted SHARE → L UPDATE → all D sorted UPDATE or
tentative inserts → all A2 sorted UPDATE → all Q sorted UPDATE → Z.
Allocate new duty UUIDs in PostgreSQL and merge them into D order. Discover the
complete month's roster before E; after L, reject discovery drift without
acquiring any late employee, account or monthly-link lock. Hold every D before
any A2/Q; implicit FK parents must already be held.

After all waits, revalidate the specific Identity session and query leases using
a fresh database clock. Any live unreleased lease on an affected existing duty
refuses the whole command, including a lease in another tab of the same actor.
Do not rotate, release or acquire an interactive lease. Unchanged duties do not
refuse admission. L/D/Q remain held through commit. Preserve SP-12 headers and
all existing single-duty behavior. Retain existing bounded writer timeouts;
technical failures roll back and never trigger automatic retry.

The short durable claim takes A/C/I/E target/P/L KEY SHARE before inserting its
context FKs. Its separate business transaction starts with L UPDATE, never an
upgrade. Result lookup takes A/C/I/P, current visibility and fresh session, with
no eligibility locks or claim mutation. All domain writes, bounded existing
audit events and fenced immutable receipt completion share one transaction.
No-op and replay emit no success audit. Existing INITIAL_PUBLISH is preserved.

Tradeoff: whole-plan serialization and complete slot preconditions can refuse
disjoint stale drafts. This is explicitly accepted; no silent roster merging.
Implementation concurrency, failure-injection and independent security review
remain acceptance gates; adoption alone does not prove them.


## CR-03 prerequisite supplement ? 2026-11-04

The [separately approved prerequisite](https://github.com/takh86/SecurePlan/issues/32#issuecomment-6630358320)
extends the writer order to A ? C ? I (when present) ? E ? P ? M ? L ? D ?
A2 ? Q ? W1 cancellation rows ? W2 replacement-need rows ? Z audit/completion.
All IDs within a tier are sorted and locked at final strength. Batch saves
finish every planning delta and acquire every W1 before every W2 before Z.
The existing actor, employee, parent, duty, assignment and lease fences remain.

A required neutral synchronous handler reconciles effective assignment removals
on the existing transaction client. Planning owns assignment changes; the workflow
owner writes only its cancellations and needs. Missing registration or workflow
integrity failure aborts the command. Retained assignment date/shift/role changes
and terminal cases are preserved. The schema signature now trusts seven exact
canonical tables, while replacement offers and aliases remain unsupported.
The employee-month receipt schema is unchanged at D16. No workflow endpoint is
activated by this supplement.
