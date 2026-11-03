# A2 atomic employee-month Save backend evidence

Date: 2026-11-03. Scope: bounded backend implementation, Draft [PR #95](https://github.com/takh86/SecurePlan/pull/95).
Authority: [owner approval](https://github.com/takh86/SecurePlan/issues/88#issuecomment-6600906336),
A2-GATE-1 at PR #94 `c066ff41d3a5eda8d6f20a62144fc5212e3cf280`.
Base: origin/main `dd3e83e5e6f619f197aad93ee2b7f5c121d6eeca`.
P1–P6 remain binding. Approval, executable evidence and independent acceptance
are distinct. This document is implementation evidence, not human security certification.

## Reviewable stages and contract

1. `a4e08f9`: adopt [API](../api/employee-month-save.md), exact
   [OpenAPI](../api/employee-month-save.openapi.json) and ADR-0006 batch admission.
2. `5aaa17d`: additive migration 0015, projection, atomic command, strict codecs,
   operation-specific receipts, bounded conflicts, transactional audits and tests.
3. `7a578ed`: share the durable reservation protocol with First Publish and
   register all three new routes in the authorization inventory.

Only 0015 is new. Applied 0001–0014 are unchanged; 0014 remains operating calendars.
The receipt catalogue signature and DB verification include the A2 extension.
Existing valid INITIAL_PUBLISH records, fingerprints, replay and reconstruction
remain compatible. Its unsupported-operation CHECK test now expects the new
compound CHECK name, which PostgreSQL evaluates first; rejection remains 23514.

The new routes are COMPANY_ADMIN only. GET projects one complete snapshot;
POST `/save` consumes every date and both slot preconditions; GET `/save-result`
only queries evidence. OFF is unscheduled. Live canonical duties and other staff
remain authoritative. Existing empty duties and removed memberships are retained;
rejoin creates a new membership. No frontend or Claude worktree/#91 changes.

## Transaction and security inspection

The short durable claim takes A/C/I/E target/P/L KEY SHARE before context FK
writes. Its separate READ COMMITTED business transaction takes A/C/I/E/P/M/L
UPDATE, allocates PostgreSQL duty UUIDs and merges inserts/locks in D order,
then locks every active membership before every current lease. Discovery drift
refuses rather than acquiring new employee/account/link locks late. A SQL trace
test covers multiple D/A2/Q rows and checks no late parent/duty acquisition.

Fresh session and live-lease admission occur after waits. Active affected-duty
leases refuse the entire command, including another tab of the same actor;
unchanged leases do not block admission. The final overlay removes only target
memberships, adds desired intervals and compares retained rosters and external
saved UTC intervals, including adjacent months. Calendar and exclusivity use
A1 compatibility, including corrective reductions and overnight start-date rules.
No-op does not certify Publish readiness; CR-03 preserves publication metadata.

All changed canonical duties increment once. Existing bounded D/M audit actions
and strict receipt completion use the same client/transaction. Nth-audit, receipt
completion, invalid final date and ambiguous COMMIT tests check rollback or
retained evidence. FAILED markers are attempt-fenced and cannot overwrite
COMPLETED. Replay never reconstructs the A2 result from later roster state.

Queries use parameterized values and trusted tenant context. Read/receipt output
contains only the selected employee's memberships. Conflict serialization admits
only bounded date/kind/reason tuples and no medical reason, other employee,
lease holder or token. Error paths also set no-store. The explicit maintenance
entry point is principal-bound, defaults to 100 candidates (maximum 1000),
uses nonwaiting I per key and rechecks expiry. No automatic cleanup/retry or job.

## New-code acceptance evidence

New tests: **26 unit + 103 real PostgreSQL/HTTP** (89 command/domain/concurrency,
14 schema). These are distinct from unchanged baseline regression tests.

| Acceptance family | Executable evidence |
|---|---|
| Full month | Complete 31-day Save; 28/29/30/31-day projections and commands |
| Atomic refusal | Invalid final day; range-boundary NIGHT; adjacent-month overlap; exact before/after domain and audit comparisons |
| Competing writers | 48 measured blocking cases: nine writer families × both orders × COMMIT/ROLLBACK, plus different employees/absent DAY and NIGHT, lease admission and session revocation |
| Legacy and preservation | Shared and empty destinations, INVALID_DUAL correction, source/role/history retention, new identity on rejoin, neutral preserved-roster refusal |
| Leases and identity | Same-actor live lease, unchanged/expired lease, idle/absolute post-wait checks, guard-issued context vs actual logout, role/tenant/archived refusals |
| Calendars and times | Missing/closed dates, no-op and corrective reduction, effective-calendar drift, DST, overnight closed following day, complete slot/lifecycle/context drift |
| Idempotency | Original receipt after later changes, result-only UNKNOWN/NOT_COMPLETED, expired evidence, live I exclusion, abandoned claim takeover and old-attempt fencing |
| Faults | Fourth audit failure, receipt completion failure and actual commit followed by lost acknowledgement |
| Migration/backcompat | Forward application, checksum replay, pre-0015 completed/in-progress INITIAL_PUBLISH rows unchanged, context tenant FKs, malformed/oversized/63-slot receipts, receipt-schema drift |
| No-op/published | No business version/timestamp/audit change on NO_OP/replay; direct PUBLISHED update preserves publication metadata |
| Codecs/API | Frozen UTF-8 SHA-256 tuples, PostgreSQL precision cross-check, safe integer boundary, low years/leap months, strict unknown/nested fields, bounded error/result codec and OpenAPI checks |

Existing First Publish, calendar and planning regression suites run alongside
these new tests. No mocked UI test is represented as browser acceptance.

## Verification ledger

| Check | Executed result |
|---|---|
| `npm ci` | PASS, Node 24.21.0 |
| `npm run lint`, `npm run typecheck` | PASS |
| Both application builds | PASS; existing frontend bundle-size advisory |
| Backend units | PASS 411/411, 37 files; includes 26 new tests |
| Frontend regression | PASS 820/820, 52 files; unchanged UI |
| Focused final reservation/HTTP compatibility run | PASS 193/193, four files |
| Full final local PostgreSQL/HTTP regression | PASS 1414/1414, 53 files, two workers; includes 103 new A2 tests |
| Disposable migration forward/replay and DB verification | PASS 0001–0015, verified PostgreSQL 17 tmpfs container |
| Local script/migration-safety suite | 21/34 PASS; 13 refused fixed-5432 demo guard on custom host transport; full suite runs in verified ephemeral CI |
| `npm run check:public`, whitespace | PASS |
| Exact-head GitHub push and PR CI | Final results recorded in [PR checks](https://github.com/takh86/SecurePlan/pull/95/checks) and final PR ledger |

All fixture-capable local commands use the identity-verified fresh labelled
PostgreSQL 17 tmpfs container and explicit loopback target, never an environment
file fallback. A temporary canonical-port forwarding attempt found 5432 occupied;
the identity guard refused it before writes. No existing listener/database was
modified. No existing development/production database migration occurred.

Corrections during development: calendar test used the wrong verb/shape;
session-expiry fault fixtures initially violated their own timestamp constraints;
Publish correctly refused discovery drift after A2 creation; the new compound
CHECK changed the unsupported-operation constraint name; and the static route
inventory needed all three new routes. These were corrected and rerun, not
counted as initial passes. First-head CI and full local E2E each exposed the
inventory mismatch (1413/1414); the final ledger supersedes that intermediate run.
One later PR run passed all 1414 assertions but exposed a teardown race:
`pool.end()` can resolve before the server removes disconnected backends from
`pg_stat_activity`. The isolated database helper now observes fresh snapshots
for up to two seconds before its existing strict refusal. It never terminates
connections or force-drops a database. An unchanged frontend focus assertion
also failed in an earlier PR run; the full local and push runs passed it.

## Outstanding acceptance gates

- Independent implementation and human security review remain OPEN.
- Frontend integration and real browser → HTTP → PostgreSQL acceptance: NOT_RUN
  in this backend-only scope. Principal-bound draft UX remains the UI owner's work.
- Human accessibility and stage/production #51 remain OPEN. No deployment,
  merge or issue closure occurred; PR #94 stays a separate Draft design artifact.
- Whole-plan serialization/full-roster locks are intentional. No artificial
  roster cap was introduced; large-roster performance and operational retention
  ownership require review before release. The test fixture footprint is not a
  production capacity certification.
