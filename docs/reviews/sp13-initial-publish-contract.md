# SP-13 initial publish contract and concurrency review

Review date: 2026-11-02. Starting point: `main@13b680c07929ae595c196a523a32d4226bfa8e64`.
Scope: backend first publication for #28 and the SP-13 portion of #29.
This review precedes application changes. Approval, implementation and executed
verification are separate states; results belong in the SP-13 evidence record.

## Authority and existing implementation

Reviewed: the effective MVP baseline, Phase 2 v1.1 with approved changes, CR-03,
Phase 4 UC-05 read with FINAL v1.2, the controlled
Phase 8.3/8.4/8.6/8.7/8.10/8.11 contracts, SP-11A Rev3.1 T1/T5/T7 and owner
supplements, ADR-0003/0004/0006, migrations 0011/0012, and the current planning,
identity, workforce and test helpers. Controlled originals remain private;
this document records only the bounded implementation proposal and source
conclusions. The primary worktree's local AGENTS.md was also read; no instructions
file is copied or committed by this change. A matching untracked AGENTS.md
subsequently appeared in this worktree and was read; it remains uncommitted.

SP-11 already owns the stable plan, duty snapshots, membership history, D2/D3
dependency guards and D4/D5 lifecycle guards. SP-12 already owns duty mutations,
leases and their version checks. Reuse them. No frontend, SP-14, replacement,
cancellation or operational Issue #51 implementation belongs to this change.

## Confirmed API and lifecycle

- `POST /api/v1/monthly-plans/{planId}/publish`, no request body; success is
  HTTP 200 with the existing MonthlyPlanResponse representation. `publishedAt`
  is server-owned and set once, with the publishing account persisted.
- Authenticated, active COMPANY_ADMIN of the session-derived company only;
  existing Origin/session/CSRF controls and transactional account/company recheck
  remain mandatory. No client company, role or publishing-account input.
- Unknown/foreign plans and ARCHIVED projects retain concealed 404 behavior.
  INACTIVE projects remain visible but cannot be newly published.
- Only `UNPUBLISHED -> PUBLISHED`. A fresh command against PUBLISHED returns
  409 `MONTHLY_PLAN_ALREADY_PUBLISHED`; there is no republish or plan revision.
  Existing successful duty writes continue to apply directly to PUBLISHED plans.
- Phase 8.4 section 6.5 requires full revalidation and explicitly defines no
  universal employee/shift-leader minimum. An empty roster is valid; do not
  introduce a completeness percentage, leader requirement or quota. No new
  past-month restriction is authorized.
- Validate all live duties and ACTIVE memberships, excluding retained removed
  history. Check project, month ownership, effective configuration/kind, employee
  ACTIVE state, inclusive employment on the local duty date, project-month link,
  shift eligibility, neutral unavailability and half-open UTC overlap. Exclude
  each duty itself from overlap detection; other duties of this plan still count.
  Saved UTC instants remain the interval of record (ADR-0003 O-10); publication
  must not rewrite snapshots, membership identities or duty versions.
- No release-required notification side effect exists in this slice. The
  architecture makes outbox conditional on such a side effect; do not invent
  a notification event, worker or delivery promise.

## Idempotency and lost responses

Phase 8.7 sections 4-5 and the 8.11 endpoint matrix require Idempotency-Key:
8-128 visible ASCII characters, cryptographic hash at rest, scoped by company,
actor and operation. The semantic fingerprint includes the canonical plan ID;
the operation scope must span plan IDs so reuse for a different plan conflicts.
No raw key is stored, audited, echoed or logged. No Expected-Version or duty
lease token is required by the publish API; there is no global plan version.

Use the approved short IN_PROGRESS claim followed by the business transaction.
Business state, mandatory audit and COMPLETED result metadata commit together.
Same-key/same-command completed retry returns the same logical HTTP 200 result
and `Idempotency-Replayed: true`, with a fresh attempt correlation ID. Reuse for
a different command returns 409 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST`;
an executing claim returns 409 `IDEMPOTENCY_REQUEST_IN_PROGRESS`.

Default completed retention is 24 hours; stale IN_PROGRESS threshold is 5 minutes,
both technical configuration. Recovery must lock/recheck the reservation and
prove the business transaction did not complete before retrying. Expiry cannot
permit a second publication. Technical failure rolls back all business/audit/
completion changes; no automatic replay of a human command. A committed publish
whose response is lost is recovered using the same key, even if the project or
staffing later changes. Current authentication/tenant checks still precede replay.

## Lock order and revalidation

LOCK-01-L1, as amended by SP-11A and implemented by ADR-0006:

`A accounts -> C company -> I reservation -> E employees -> P project -> M month links -> L plan -> D duties -> A2 memberships -> Z audit/completion`.

Take the actor through `lockAccountsPrefix` at SHARE, then company SHARE, before
reservation and domain locks. Company remains a SHARE-only leaf. Employees use
NO KEY UPDATE in UUID order; project and monthly links use SHARE (links ordered
by UUID). Publish takes plan UPDATE immediately, never upgrades SHARE. Lock live
duties UPDATE in UUID order, then active memberships UPDATE in UUID order. Keep
the existing 5s lock / 15s statement timeouts and sanitized technical failures.

Discover plan/duty/member identity without row locks to determine the complete
employee set. After E/P/M/L waits, reread the complete live duty/member set in
fresh statements. If discovery changed, abort with
`PLAN_CONCURRENT_MODIFICATION`; never acquire a new E/M lock after L/D. Compare
identity and versions/content, not merely row counts. The plan lock protects an
initially empty duty set, including concurrent insertion of an unstaffed duty.
All authoritative eligibility/configuration/absence/overlap checks follow waits
in fresh READ COMMITTED statements. No late parents or lock upgrades.

| Other writer | Conflict and serial behavior |
|---|---|
| Duty create/PATCH/DELETE, including membership changes | Existing L SHARE conflicts with publish L UPDATE; mutation E/P/M precede L. A committed discovery change causes reload; rollback leaves the earlier set valid. |
| Duty lease acquire/renew/release | Existing P/L/D/Q order; L SHARE conflicts. An idle UI lease does not hold PostgreSQL locks. No publish lease-conflict rule is introduced. |
| Availability set/clear/batch | E lock serializes factual availability. Revalidate after waits; a later absence can legitimately create the existing neutral conflict in a PUBLISHED plan. |
| Employment/eligibility/employee deactivation | E serializes; deactivation also follows its account prefix. Existing D5/deactivation dependency rules retain their own scope. |
| Assignment create/correct/delete | E serializes absent links; M SHARE protects existing links. Existing D2 may already refuse a writer because a live unpublished duty depends on its tuple. |
| Project status/configuration versions | P SHARE conflicts with NO KEY UPDATE. D3/D4 remain active for live duties in either plan state; no cascaded snapshot rewrite. |
| A second publish | E/P prefixes followed by L UPDATE serialize; fresh status rejects a different key, or idempotency replays the same completed command. |
| Account/session revocation | Existing account prefix and transactional actor revalidation preserve the admitted-command ordering; no application company writer is added. |

## Error precedence

Preserve existing global guard and resource-ID parsing boundaries. Parse required
key syntax and reject bodies as structural 400s before business 409s. Recheck
actor transactionally; conceal tenant/project visibility before domain conflicts.
Completed replay precedes fresh publication lifecycle/eligibility checks.
For a fresh command: locked lifecycle, discovery drift, project ACTIVE, then
configuration and staffing, with duties and employees in deterministic UUID order.
Staffing follows the existing ACTIVE -> employed -> assigned -> eligible ->
unavailable -> overlap order. Use only approved error codes. Schema corruption,
invalid server configuration, timeout, deadlock and unknown SQL errors remain
sanitized 500 `INTERNAL_ERROR`, with correlation ID and full rollback.

## Publication audit owner decision

**P1: APPROVED by the owner in this implementation conversation, 2026-11-02,
after review and before the publication endpoint was introduced.**
Mandatory atomic audit is approved. Its publication event name and values are
not: ADR-0004 and the scoped SP-11/SP-12 approvals explicitly defer publication.
Issue #28's kickoff asks for this decision rather than supplying one. A string
in a technical catalogue would not itself constitute event approval.

Approved bounded contract: exactly one `MONTHLY_PLAN_PUBLISHED` action,
resource `MONTHLY_PLAN` / plan UUID; old values
`{status: "UNPUBLISHED", publishedAt: null}`; new values
`{status: "PUBLISHED", publishedAt: persistedTimestamp}`. Existing audit envelope
supplies company, actor and request correlation; no roster, names, absence data,
key, token or complete plan copy. Replays and refusals emit no success event.
Any audit/completion failure rolls back publication metadata and all earlier
events. The owner explicitly selected “Approve this bounded audit contract”.

The initial review left the publication mutation pending P1; that gate is now
resolved. No additional owner business decision was identified. Independent
review, executed backend evidence and later React/browser acceptance remain
separate requirements.

## Required proof and React handoff

Use a fresh, labelled tmpfs PostgreSQL 17 container and verify its exact identity
with the existing receipt tooling before migration or fixtures. Required proof:
HTTP authorization/tenant/CSRF, invalid revalidation, zero/empty staffing, unique
first publication, same/different-key retries, lost response, audit/completion
rollback; real observed PostgreSQL blocking for both writer orders and relevant
COMMIT/ROLLBACK cases, including phantom duties/members and workforce writers.
Run repository gates, forward migration twice, DB verification and CI, recording
exact commands/counts and any NOT_RUN or failed checks.

After A10 is integrated, the React Publish dialog can consume the confirmed
bodyless API and stable MonthlyPlanResponse. Generate one key per explicit
attempt; retain it across network retries, honor in-progress response, reload on
state/discovery conflicts, and show PUBLISHED only from a successful/replayed
response or confirmed GET. Final endpoint availability depends on backend
verification. Frontend integration and browser acceptance remain outstanding;
backend-only completion never establishes SP-13 end-to-end acceptance.
