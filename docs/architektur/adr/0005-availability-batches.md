# ADR-0005 — Administrative daily availability

- **Status:** Owner technical approval recorded on 30.10.2026; implementation
  subject to code review and the evidence below.
- **Authority:** [SP-10 / #24](https://github.com/takh86/SecurePlan/issues/24),
  [implementation approval](https://github.com/takh86/SecurePlan/issues/24#issuecomment-6530983248).
- **Scope:** Public summary of the implemented slice. Private specifications,
  source documents and the controlled approval record remain outside Git.
  ADR-0004 remains the separate related-business audit decision.

## Decision

Store one tenant-scoped employee marker per civil date using `SICK` or `LEAVE`.
The administrative UI calls these “Krank” and “Urlaub (genehmigt)”. Vacation is
already approved; this feature is not a request/approval workflow. There are no
medical text fields. An inclusive batch covers at most 93 dates and may cross
month/year boundaries.

Use a month read and a preview/commit API. Identical SET and absent CLEAR days
are no-ops. SET defaults to rejecting mixed statuses. Replacement needs a new
replacement preview and explicit confirmation; CLEAR also requires confirmation.
SET requires documented employment start, optional inclusive end and, for an
inactive employee, dates strictly before company-local today. Confirmed CLEAR
can correct erroneous facts without creating employment evidence.

Use SQL-first persistence with unique/check/composite-FK constraints in forward
migration `0010`. Existing migrations are immutable. Employment/time-dependent
rules are enforced under the existing employee parent lock, with fresh statements
after waiting. Actor/company authorization is rechecked in the transaction.
Availability adds no project, assignment or duty lock in reverse order.

Previews bind the normalized selection, tenant/actor/employee and current
employee context/revision. They expire, and effective availability/employment
changes invalidate them even after an A→B→A change. Human review holds no database
transaction open. An application-managed revision fits the existing writers;
out-of-band SQL that omits revision changes remains a documented operational
limitation. A trigger was not adopted in this scoped change.

Commit uses a transaction-scoped PostgreSQL key reservation and an atomic
completed result. An exact authorized retry replays counts without repeating
business effects. Different intent under the same key is rejected. Uncertain
client outcomes retain the exact request/key in memory; the UI never silently
creates a new destructive request. The typed technical command table stores
digests and bounded metadata, with expiry and bounded cleanup, rather than raw
requests or cached absence responses. Maintenance scheduling remains an
operational gate; expiry is not a physical-erasure guarantee.

## Audit and privacy

`EMPLOYEE_AVAILABILITY_SET` and `EMPLOYEE_AVAILABILITY_CLEARED` use resource
`EMPLOYEE_AVAILABILITY`, identified by the employee UUID. Each effective changed
day emits one event in the business transaction. The value objects contain only
`{day}`: insertion has null old values, replacement has that same date on both
sides, and removal has null new values. No-op/refusal/replay emits no extra event.
Audit or command-completion failure rolls back all business and audit effects.

These events deliberately cannot reconstruct historical SICK/LEAVE status.
Employee/date references remain personal data requiring restricted access and
retention controls. The internal Workforce read contract returns only
`AVAILABLE` / `NOT_AVAILABLE`; it does not expose the reason or assert full duty
eligibility. No employee-facing absence-status HTTP endpoint is added.

## Alternatives and boundaries

Per-day public writes cannot provide atomic reviewed ranges. A client-only lock
cannot protect competing administrators. Silent upsert replacement violates the
approved conflict rule. Raw before/after status audit and stored response bodies
retain unnecessary absence information. These alternatives were rejected.

Factual absence never changes a duty. Published-duty conflict discovery,
planning/publish/replacement revalidation and global LOCK-01 belong to
[#25/#26](../../datenbank/sp11-integrity-handoff.md). Both existing temporary
planning guards remain active. This ADR does not approve the unfinished SP-11
lock graph, resolve E-04, or remove any replacement quota (CR-01 already did so).

See [executed evidence and limitations](../../reviews/sp10-availability.md) and
[pre-staging gates](../../security/pre-staging-gates.md). Design approval is
separate from implementation review, browser acceptance and production release.
