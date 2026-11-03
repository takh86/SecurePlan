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

## Development integration follow-up (2026-11-03)

Reviewed the independent [PR #92 review](https://github.com/takh86/SecurePlan/pull/92#pullrequestreview-5747924883)
and [approved P1–P6](https://github.com/takh86/SecurePlan/issues/90#issuecomment-6588992180).
The review's remaining development rollout gap is addressed by the
[development-only runbook](../development-a1-rollout.md) and
`node scripts/rehearse-legacy-calendar.mjs`. This supersedes the earlier
NOT_RUN statement for disposable legacy bootstrap and manual HTTP integration;
it does not claim an existing-target rollout or browser acceptance.

One confirmed inventory defect was fixed: the previous duty-only report omitted
projects with no duties and historical empty plans. The additive `projects`
output now exposes those projects, company-local current month, earliest live
duty month, version count and missing plan months. The existing violation-count
format is retained. No runtime domain rules or applied migrations were changed.

Two new labelled tmpfs PostgreSQL 17 containers were independently verified by
container ID, label, loopback binding (55492/55494), role/database, storage and
cluster receipt before writes. Shared development PostgreSQL on 5432 was never
used. Node 24.21.0; existing installed dependencies used (`npm ci` NOT_RUN in
this follow-up; it passed for the reviewed baseline).

The fresh-target rehearsal applied 0001–0013, then committed fixtures before
0014: a January 2020 PUBLISHED DAY/NIGHT pair with the same active member, a
February 2020 retained empty duty with removed membership, and a project with
no duties but a January 2019 empty plan. Exact complete rows of monthly plans,
duties and memberships were unchanged by migration, inventory and bootstrap.
No policy was seeded. Read-only inventory reported two missing historical
duties, one missing empty duty, one dual-member/date group and the no-duty
project's missing old plan. Explicit Sunday/Saturday policies succeeded;
incompatible sets returned dependency conflicts. Three audited explicit
bootstraps left dual memberships/history intact. A Tuesday policy then allowed
actual HTTP plan and staffed duty creation and First Publish, persisted in PG.
The final inventory retained the dual conflict and historical empty-plan gap.

Important verified boundary: with no live duties, bootstrap is current month
only. A 2019 empty plan remains readable/MISSING and First Publish returns
PROJECT_CALENDAR_MISSING; there is no approved backdate/delete workaround. The
runbook explicitly gates any requirement to publish such plans on a separate
approved rule. This is a documented contract limitation, not a silent repair.

Executed follow-up checks:

| Command | Result |
|---|---|
| `node scripts/disposable-test-target.mjs record` | PASS independently for both new containers |
| pre-0014 preparation + `npm run test:e2e -- legacy-calendar-bootstrap-real --maxWorkers=1 --testTimeout=15000` | PASS fresh upgrade and HTTP lifecycle |
| `node scripts/rehearse-legacy-calendar.mjs` | PASS on second fresh target, including DB verification |
| `npm run test:e2e -- --maxWorkers=4 --testTimeout=15000` | PASS 1,311/1,311, 51 files, 103.74s; includes 57 existing A1 guard/concurrency cases + new lifecycle scenario |
| `node scripts/disposable-test-target.mjs` | PASS read-only target re-verification |
| `node scripts/migrate.mjs` / `node scripts/verify-db.mjs` | PASS replay of all 14 checksums and schema verification |
| `node --test scripts/disposable-test-target.test.mjs scripts/migration-safety.test.mjs scripts/check-public.test.mjs` | PASS 17/17 including failed forward-migration rollback |
| `npm run lint` / `npm run typecheck` | PASS |
| `npm run build` | PASS both; existing frontend chunk-size warning |
| `npm test -- --maxWorkers=2` | PASS 385/385; root npm wrapper warned and did not forward worker limit |
| `npm run test --workspace=frontend -- --maxWorkers=2` | PASS 698/698 |
| `npm run check:public` / `git diff --check` | PASS |

Initial sandboxed Vitest/public-check attempts were refused by Windows child
process permissions (EPERM); expanded-access reruns above passed. These startup
failures are not test passes. The complete 34-case script suite is NOT_RUN
locally in this follow-up (17 relevant cases executed); normal exact-head CI
must still run the complete suite. No new dependency audit or runtime/browser
smoke test is claimed here.

Development merge recommendation: GO for the documented manual admin path,
subject to required review and green exact-head CI. Applying to an existing
development database still requires separate target authorization, backup and
restore proof, old-writer drain, private inventory and explicit policy acceptance.
No migration/configuration was applied there. Staging/production remain NO-GO:
environment rollout proof, controlled contract adoption, admin/error UI and
browser acceptance, company-time-zone acceptance, #51 proxy/operations,
dependency findings, privileged SQL, retention and human security/UX gates.
PR remains Draft pending the owner's review decision; A2, #88 and #90 stay open.
