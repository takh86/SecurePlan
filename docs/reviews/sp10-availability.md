# SP-10 availability — implementation evidence

Date: 30 October 2026. Branch: `feat/sp10-availability`, based on verified
`main` / `origin/main` at `5752ca82838a62a54e4bcb4395709d5ff4e3f0bb`.
The initial working tree contained only the owner's untracked local `AGENTS.md`;
it is excluded from commits. Existing application edits were not overwritten.

[Issue #24](https://github.com/takh86/SecurePlan/issues/24) supplies functional
authority; [owner technical approval](https://github.com/takh86/SecurePlan/issues/24#issuecomment-6530983248)
authorizes implementation and a Draft PR. The source inventory, approved
supplement and approval record remain private. Missing source versions were not
represented as reviewed. Approval is separate from independent code review,
browser acceptance and release authorization.

Follow-up: [complete 47-file critical review and real browser acceptance](sp10-acceptance-review.md).
Two reproduced P2 defects were corrected; the scoped SP-10 Chrome suite now
passes all 11 groups. The original native automation-host failure no longer
blocks headless browser testing. Final human acceptance remains separate.

## Delivered behavior and files

Migration `0010_employee_availability.sql` adds daily facts, technical batch
metadata and an internal bigint employee revision. Unique/check/composite-FK
constraints enforce physical integrity. All previous migration bytes remain
unchanged; only the new migration is pinned to LF for stable checksum replay.
Availability rules/service/controller implement month read, preview
and atomic SET/REPLACE/CLEAR with company-admin authorization, trusted tenant,
company-local lifecycle rules and explicit destructive confirmation.

The three protected routes are `GET /api/v1/employees/:employeeId/availability`
(required `monthStart`), `POST …/availability/preview` and
`POST …/availability/batch` (one `Idempotency-Key`). Existing routes and guards
remain in force. Additive problems are `AVAILABILITY_RANGE_INVALID`,
`EMPLOYEE_NOT_EMPLOYED_FOR_DAY`, `AVAILABILITY_STATUS_CONFLICT` and
`AVAILABILITY_PREVIEW_STALE`. There is no day PUT/DELETE bypass.

Locks follow actor/company → employee → command, with a nonblocking key
reservation before business locking and fresh dependent statements after waits.
No transaction stays open for human review. Exact authorized retries replay
counts without repeating effects; stale tokens cannot overwrite later changes.
Markers, revision, date-only per-day audit and completion metadata commit or roll
back together. Employee employment/deactivation paths advance the revision on
effective changes and retain their existing SP-09 rules.

`EmployeeAvailabilitySection` and its typed API adapter add a bounded month
display, inclusive 1–93 date selection, Krank / Urlaub (genehmigt), per-day
preview and explicit confirmation. Recoverable errors preserve input; uncertain
outcomes retain the exact body/key in memory for an explicit retry. Successful
commit and failed refresh are separate states. No medical input or browser
storage of previews exists. The internal Workforce read exposes only
`AVAILABLE` / `NOT_AVAILABLE`, with no new employee-facing absence-status route.
See [ADR-0005](../architektur/adr/0005-availability-batches.md).

## Executed validation

All database writes used a fresh PostgreSQL 17 container with unique run
identity, tmpfs data and loopback-only mapping. Docker identity/storage and
actual PostgreSQL cluster/database/role/version were checked read-only before
migrations/fixtures. The development database and `.env` fallback were not used.
Credentials and receipts remain private. The
[disposable-target gate](../testing/disposable-postgres.md) also runs in CI and
refuses absent/mismatched evidence before loading fixture tests.

| Command/check | Actual result |
|---|---|
| `npm ci` | PASS; Node 24; inherited dependency findings retained under #51 |
| `npm run lint` | PASS, exit 0 |
| `npm run typecheck` | PASS, backend source/tests as configured |
| `npm run build` | PASS, both applications including frontend TypeScript |
| `npm test` | PASS, 269 tests / 29 files |
| `npm run test --workspace=frontend` | PASS, 519 tests / 40 files after review correction |
| `npm run test:e2e` | PASS, 763 tests / 37 files, including actual PostgreSQL |
| `npm run test:scripts` | PASS, 34 tests after isolation-gate correction, Node 24 in verified PG namespace |
| Migration + replay + DB verification | PASS, all ten ledger checksums verified |
| Migration fault probes | PASS, changed applied **copy** refused; failing new DDL/data/ledger rolled back |
| `npm run check:public` | PASS; repeated on final staged content before push |
| Automated SP-10 real browser acceptance | **PASS**, 11 headless Chrome groups; normal TLS, real login/API/PG |
| Independent human code review | Pending; self-review does not replace it |

These totals are executed feature-branch evidence, not inherited green main CI.
No assertion, security validation or test gate was weakened. Expected injected
failures produce sanitized 500 log metadata. Public code/docs were also inspected
for private sources, personal data and runtime configuration before publication.

## Acceptance evidence

| Area | Result / evidence |
|---|---|
| Calendar, employment, tenant/RBAC, DTOs, SET/no-op/REJECT/confirmed REPLACE/CLEAR | PASS, rule/HTTP/Real-PG suites |
| Token/context/ABA freshness, expiry during wait, replay, duplicate headers, actor changes | PASS, Real-PG and raw Node HTTP |
| Competing admins and assignment POST/PATCH/DELETE, employment/deactivation | PASS, both acquisition orders with COMMIT/ROLLBACK |
| Audit-N / command-completion faults, command cleanup, constraints and migration safety | PASS, actual PostgreSQL assertions |
| German UI, explicit confirmation, focus, stale/lost-response recovery and input preservation | PASS, React Testing Library/jsdom |
| Real browser rendering, keyboard flow and browser→API→PG recovery | **PASS**, scoped SP-10 browser suite; manual owner acceptance separate |
| Existing workforce/auth/project/shift/error/route regressions | PASS, full suites above |
| SP-11 duty-conflict/eligibility integration | **NOT_RUN / NOT_IMPLEMENTED** here |
| Operations/production acceptance | **NOT_RUN / NOT_APPROVED**, #51 remains open |

Concurrency tests pause after actual SQL; independent connections and
`pg_blocking_pids` prove waiting without fabricated query results. The inherited
authentication account lock can serialize a duplicate before the business key
reservation. Tests prove that waiter replays success and that two already
authorized concurrent attempts receive the specified `IN_PROGRESS` outcome and
`Retry-After`. Authentication behavior was preserved.

Self-review covered tenant predicates, runtime route inventory, parent ordering,
fresh snapshots, no-op identity, atomic rollback, date-only audit, bounded retry
storage and publication scope. It is not independent human acceptance.

## Remaining limitations and handoff

Factual absence never changes a duty. E-04 published-duty conflict discovery,
planning/publish/replacement revalidation, overnight mapping and global LOCK-01
remain with [#25/#26](../datenbank/sp11-integrity-handoff.md). Both temporary
planning guards and their catalogue tripwires remain active.

Out-of-band SQL must participate in revision/lock rules; the accepted
application-managed revision cannot detect bypassing them. Date-only audit
deliberately cannot reconstruct historical SICK/LEAVE status. Command expiry
bounds authority; maintenance scheduling/monitoring, physical retention and
privileged access remain #51 acceptance. The eventual proxy must preserve
duplicate-header rejection. S7-7 session-revocation race, audit-role/restore
controls and the inherited 10 dependency findings (6 moderate, 4 high) remain
under [pre-staging gates](../security/pre-staging-gates.md).

Next gates: independent human review of the corrected diff and owner acceptance.
SP-09/browser workflows beyond the scoped SP-10 suite remain NOT_RUN.
No merge, #24 closure, deployment or production certification is authorized.
