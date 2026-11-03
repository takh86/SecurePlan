# A1 calendar implementation evidence

2026-11-03. Refs [#90](https://github.com/takh86/SecurePlan/issues/90) and
[#88](https://github.com/takh86/SecurePlan/issues/88). Implementation baseline:
`origin/main@0e8e912` (merged #86/#87); new branch
`agent/codex/sp90-a1-calendar`. The #89 design branch remains at `3d73b4d`,
Claude's #91 branch at `ef1a480`; neither was edited. The existing untracked
AGENTS.md was preserved. No A2 endpoint, frontend change, merge or deployment.

## Implemented scope

- Additive 0014: month-effective, nonempty ISO weekday mask, tenant/project FK,
  unique project/month, bounded version and finite timestamps. No seed/default,
  no modification to 0013 or any applied migration. The runtime signature and
  central catalogue classification include the new table.
- Admin-only month-scoped calendar GET/PATCH, exact/effective/next optimistic
  preconditions, current/future history rules and explicit one-time bootstrap.
  Strict DTOs, bounded safe errors and no-store cover success and errors.
- Calendar P NO KEY UPDATE excludes planning P SHARE. Fresh dependency reads
  refuse newly closed live dates, including empty and Published duties. The
  existing partial project/date index was selected by actual EXPLAIN on a
  ten-year synthetic roster; no duplicate index was added.
- Duty creation, membership/date/kind PATCH and First Publish enforce the start
  weekday and exclusive employee/project/local-date DAY/NIGHT rule. UTC overlap
  remains independent. No-op/removal preserve visible legacy data; existing
  leases, versions, roles, eligibility and CR-03 direct edits remain in force.
- Identity-owned read-only transactional session validation uses the existing
  role policy and fresh clock after waits, without session writes/late account
  upgrades. Publish claim/replay checks the specific session as well.
- P6 audit values are allowlisted at the audit boundary; only effective changes
  emit PROJECT_OPERATING_CALENDAR_UPDATED, atomically with the mutation.
  The inventory script reads violation counts without repairing records.

## Verification

Node 24.21.0; PostgreSQL 17 in a dedicated labelled tmpfs container on loopback
port 55490. Container identity, storage, binding, database role and cluster ID
were verified by the repository's disposable-target harness before migrations
or fixtures. No development database was used. Runtime readiness used this same
target and the integrity-checked local password denylist.

| Check | Executed result |
|---|---|
| npm ci | PASS; existing dependency audit reported 8 moderate / 4 high findings; no dependency changes |
| migrations 0001–0014, checksum replay | PASS |
| DB verification including 0014 | PASS |
| npm run lint | PASS, zero warnings after final test comparator fix |
| npm run typecheck | PASS |
| npm run build | PASS both workspaces; existing frontend chunk-size warning |
| npm test -- --maxWorkers=2 | PASS 385/385, 36 files, including 10 new bounded-audit tests |
| npm run test --workspace=frontend -- --maxWorkers=2 | PASS 698/698, 50 files |
| A1 real-PG coverage in the final full run | PASS 57/57, including the two additional bootstrap/history cases |
| npm run test:e2e -- --maxWorkers=4 --testTimeout=15000 | PASS 1,310/1,310, 50 files, final shared error vocabulary; 148.94 seconds |
| script suite, verified container-local Node 24 | PASS 34/34 |
| backend runtime /api/v1/health/ready | PASS 200, status ok; process stopped afterward |
| read-only inventory smoke check | PASS on disposable data, no findings after fixture cleanup |
| public-content scan / whitespace | PASS; repeated before commit |

The A1 suite uses actual AppModule HTTP writers, sessions/CSRF, migrated tables
and transactional audit. It covers multiple project policies, inheritance,
exact versions and next boundaries, bootstrap, missing/closed dates, NIGHT over
midnight, empty/Published dependencies, all effective duty paths, First Publish,
legacy removal/no-op, concealed tenants, permissions, stale precedence and late
audit rollback. It observes PostgreSQL blocking for calendar/duty and DAY/NIGHT
creation in both orders and COMMIT/ROLLBACK, plus account/session waits.

Initial unbounded Windows runs encountered CPU contention and five-second test
timeouts; a corrected schema/route/contract expectation pass preceded the full
green rerun. The old Publish overlap fixture was moved to the preceding local
date to test UTC overlap independently of the new same-date exclusivity code.
CLI imports from the Windows bind mount exceeded their timeout;
the unchanged script suite passed from a disposable Linux-local archive instead.
The host-port script guard refused port 55490 before demo fixtures; the script
runner used the verified cluster's internal 5432 connection, without changing
that guard. These setup failures are not counted as passing checks.

## Remaining gates

Independent T1–T4 implementation/security acceptance, formal internal contract
adoption, real browser/calendar admin integration and an authorized pre-rollout
legacy inventory are NOT_RUN here. GitHub exact-head CI is recorded on the Draft
PR after push. No claim of production readiness, statutory compliance or
privileged-SQL enforcement is made. #51 retention, roles, operations and other
pre-staging gates remain open. Existing projects intentionally remain MISSING
until explicitly configured; rollout must account for that transition.
