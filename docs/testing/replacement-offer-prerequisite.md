# Replacement offer prerequisite

SP18-P1 prepares retained offer history and synchronous invalidation for existing
cancellation withdrawal and published-plan assignment removal. It does not enable
employee offer discovery/submission or administrative selection. Issue #34 remains
open for the later employee feature and independent review.

## Compatible application and database

The application and migration 0018 form one coordinated pair. Drain requests and
stop the old application before applying the migration; start the matching new
binary only after migration and database verification succeed. Never serve the
old application against the new schema or the new application against the old
schema. Both exact guards intentionally reject mismatches. There is no permissive
seven-or-eight-table transition and no automatic schema downgrade.

This is a cutover requirement, not authorization to migrate any environment.
Migration 0018 is additive; previous applied migrations remain unchanged. It
preserves existing publish, employee-month and cancellation receipt data.

## Verification

Use only a fresh target verified as described in [Disposable PostgreSQL test
targets](disposable-postgres.md). Verify its identity before migration, apply the
migration runner twice, then run database verification, operational script tests
and the complete backend HTTP/database suite. Run the remaining checks from
CONTRIBUTING.md and require the final commit's CI aggregate to succeed.

The replacement-offers schema, catalog and invalidation suites cover tenant FKs,
active uniqueness, finalization checks, old receipt replay, exact catalog drift,
observed DDL waits, actual closure writers, terminal history, failure rollback,
batch behavior, competing transactions and high-cardinality closure/timeout.
REPEATABLE READ planning and employee-month readers acquire schema protection
before their first snapshot-producing statement so a DDL wait cannot authorize
queries using a stale catalog snapshot. Data reads retain one coherent snapshot.

Offers remain voluntary applications. Invalidation retains historical rows,
uses one database lifecycle timestamp and records one bounded audit per effective
transition in the owning transaction. Replays produce no extra transition audit.
Candidate eligibility changes and administrative decisions belong to later work.
