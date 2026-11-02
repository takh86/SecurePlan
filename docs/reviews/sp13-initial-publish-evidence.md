# SP-13 backend implementation and verification evidence

Date: 2026-11-02. Branch: `agent/codex/sp13-initial-publish`.
Baseline: `main@13b680c07929ae595c196a523a32d4226bfa8e64` (also the fetched
origin/main during this work). Refs #28 and the SP-13 portion of #29.

The [contract/lock review](sp13-initial-publish-contract.md) was written before
application changes. The owner subsequently approved its exact bounded
`MONTHLY_PLAN_PUBLISHED` audit event in this conversation. No unresolved business
decision remains for this backend slice. Independent review and the separate
React/browser acceptance are not supplied by this implementation.

## Result and scope

The admin-only, bodyless initial-publish POST uses the existing session/Origin/
CSRF authorization, transactional account prefix, tenant concealment, plan,
duties, membership history, workforce checks and audit service. It takes the
approved L1 prefix, discovers and locks employees before project/month/plan,
takes L UPDATE without upgrading, then locks/rechecks live duties and members.
Discovery drift aborts without late parent locks. Staffing and effective shift
lookup are reused from the existing create/edit implementation.

Publication changes only plan lifecycle metadata. Its single approved success
audit and idempotency completion use the same PostgreSQL transaction. Saved
duty UTC snapshots, versions, membership identities and leases are preserved.
Real post-publication duty mutation verifies CR-03 direct PUBLISHED edits.

Migration 0013 adds technical idempotency reservations, scoped by company,
actor, operation and hashed key. It includes composite tenant FKs, hash/state/
time constraints and unique scope. A short durable claim, attempt fencing,
nonwaiting I lock, terminal result reference and atomic completion provide
lost-response recovery. Completed retries bypass new eligibility conflicts but
still require current authorization and visible tenant/project scope. Expired
retention never permits a second publication. The shared SP-10 key parser was
extracted unchanged; its old import remains available.

No React files, frontend clients/tests, dependency manifests, CI configuration,
SP-14 endpoints, cancellation/replacement logic or Issue #51 operational feature
changes are included. The DB verification script adds only the migration-0013
smoke check. Local AGENTS.md and all runtime files remain uncommitted.

## Disposable target and runtime

- Fresh PostgreSQL 17 container `secureplan-sp13-codex-20261102`, exact ID
  `dbd4b12840beb6107f21d4e41d014bae4c346096adc81ef267e634877008b3bc`.
- Label `secureplan.disposable-test=sp13-codex-20261102`, tmpfs data directory,
  only `127.0.0.1:55413 -> 5432`; no development Compose volume or shared DB.
- `disposable-test-target.mjs record` verified Docker identity/storage/binding
  and PostgreSQL cluster/database/role/version before any migration or fixture.
  Receipt timestamp: `2026-11-02T17:39:14.319Z`. Fixture-capable commands reverified
  the receipt and actual cluster before loading tests.
- PostgreSQL `17.11`; Windows Node `24.21.0`, ICU `78.3`, tzdata `2026c`.
  Script tests used `node:24-bookworm` in this exact PostgreSQL container's
  network namespace, with workspace/receipt and denylist mounted read-only.
- Host tests explicitly source ignored `.env.sp13-runtime/env.ps1`; it supplies
  only this target, its receipt, a fresh runtime HMAC key and the existing
  integrity-checked denylist. No shared `.env` fallback was used. Connection
  credentials, receipt contents, HMAC and denylist are not published here.

## Commands and results

Commands ran from the assigned worktree root. The DB commands below were
preceded by `. ./.env.sp13-runtime/env.ps1`. Tests were not skipped or replaced
with mocks for the PostgreSQL proof. Windows sandbox EPERM on Docker/Git/Vite
child processes was resolved through the execution permission mechanism; no
test-target guard was bypassed.

| Command | Result |
|---|---|
| `npm ci` | PASS; 421 packages installed, 424 audited; unchanged dependency warnings below. |
| `node scripts/disposable-test-target.mjs record` | PASS; exact fresh container/cluster identity recorded. |
| `node scripts/disposable-test-target.mjs` | PASS; read-only identity recheck before migration. |
| `node scripts/migrate.mjs` (first invocation) | PASS; 0001-0013 applied to the fresh target. |
| `node scripts/migrate.mjs` (second invocation) | PASS; all 13 already applied, checksum replay preserved. |
| `node scripts/verify-db.mjs` | PASS; foundation, availability, planning, lease and publish reservation catalogue. |
| `npm run lint` | PASS; backend and frontend, final run without warnings. |
| `npm run typecheck` | PASS; backend source and test types. |
| `npm run build` | PASS; Nest backend and unchanged React/Vite frontend. |
| `npm test` | PASS; 35 files / 375 backend unit tests. |
| `npm run test --workspace=frontend` | PASS; 46 files / 607 tests; frontend unchanged. |
| `npm run test:e2e -- initial-publish-real.e2e-spec.ts initial-publish-concurrency-real.e2e-spec.ts initial-publish-schema-real.e2e-spec.ts` | PASS; 3 files / 114 tests (33 HTTP/behavior, 69 concurrency, 12 schema). |
| `npm run test:e2e -- --maxWorkers=4` | PASS; all 49 files / 1,249 tests, zero failed/skipped; 62.73s. |
| `npm run test:scripts` | PASS in the Node 24 container; 34 tests, zero failed/skipped; includes replay/checksum and failed forward-migration rollback. |
| `node .env.sp13-runtime/runtime-readiness.mjs` | PASS; built backend reached HTTP 200 `{status: "ok"}` at loopback port 30013 using the verified target, then stopped. |
| `npm run check:public` | PASS; tracked and nonignored pending text. |
| `git diff --check` | PASS. |

The script-test container invocation used `--network container:<exact ID above>`,
the verified internal loopback connection on port 5432, `NODE_ENV=development`,
the recorded receipt and the existing denylist/HMAC configuration. The normal
development-only script guard was retained; port 5432 was never redirected to
the development database. The exact host Docker invocation is retained in the
local execution transcript, together with its synthetic runtime configuration.

## What the PostgreSQL tests prove

| Area | Executed proof |
|---|---|
| Authorization/isolation | Real AppModule HTTP: anonymous, EMPLOYEE, live role downgrade, stale trusted context, CSRF/Origin, foreign/absent IDs, revoked completed-key retry; no reservation or success audit on unauthorized attempts. Route inventory includes only COMPANY_ADMIN for publish and preserves the platform-role exclusion. |
| Revalidation | Project ACTIVE, configuration/kind, ACTIVE employee, inclusive employment, monthly link, shift eligibility, neutral SICK/LEAVE unavailability and half-open overlap; adjacency and self-exclusion; removed history, empty rosters/plans and past plans. |
| First-publish uniqueness | Different-key competing publishers serialize at the real prefix/L locks; one publication/audit/completion, including rollback of the first writer. Eight additional rounds alternate actors and commit/rollback. |
| Lost response/recovery | Same-key/canonical-ID HTTP replay, different-plan fingerprint conflict, actor/tenant key isolation, recent/stale claim handling, expiry, actual commit followed by an injected lost acknowledgement, live stale-claim exclusion and fencing of a process paused between claim and business work. |
| Atomicity | Actual SQL failure after publication audit insertion and at completion rolls back metadata/audit. Failed-marker handling cannot overwrite COMPLETED after an ambiguous acknowledgement. |
| Duty races | Actual leased PATCH, membership addition, DELETE and unstaffed INSERT in both orders, first writer COMMIT/ROLLBACK. An initially empty plan detects a committed phantom duty; rollback preserves the empty set. |
| Workforce races | Actual eligibility, historical employment/deactivation/project-status, configuration-version insertion and availability SET/CLEAR writers; absent monthly-link creation; assignment correction/delete and effective configuration dependency guards. Both orders and relevant rollback outcomes are observed. |
| Lock evidence | Barriers hold actual transactions; `pg_blocking_pids` verifies blocking before release. No mocked deadlock/lock error substitutes for these schedules. A changed membership set aborts without a late employee lock. |
| Tenant schema | Composite actor/result FKs, unique reservation scope, hash lengths, supported operation, state/completion metadata and finite time constraints reject invalid SQL. |

Guarded assignment/configuration writes are correctly refused while a live duty
depends on them; these refusals are rollback outcomes, not claimed as successful
workforce COMMIT cases. Historical employment/project/deactivation fixtures allow
their writers to commit so publication can prove fresh eligibility/status reads
after waiting. Later factual absence may legitimately create a neutral conflict
on an already PUBLISHED duty; publication does not silently remove it.

## Earlier failures and corrections

- Initial type checks found two local TypeScript typing errors in the new
  reservation union/header test helper; corrected before the passing gates.
- First 33-case run: 29 passed / 4 failed due to fixtures using the wrong employee
  status, expecting 400 instead of the existing concealed-ID 404, and assuming
  ordering of same-transaction audit timestamps. Corrected without changing
  the existing contracts. Next 96-case run: 92 passed / 4 CLEAR fixture failures;
  supplied the existing required `confirmation: "CLEAR"`.
- First complete default-parallel run: 1,248 passed / 1 failed; the protected
  route inventory needed the newly authorized publish route. Added the route
  while retaining its COMPANY_ADMIN-only assertion.
- Next default-parallel run: 1,248 passed / 1 failed; eight sequential stress
  rounds exceeded Vitest's default 5s aggregate budget. That one test now has
  20s; application 5s lock / 15s statement limits remain unchanged.
- Following default-parallel run: all SP-13 cases passed; 1,248 passed / 1 failed
  because unchanged login-abuse test 05 (60 sequential IP attempts) exceeded its
  5s budget under host oversubscription. Its code/assertions were not modified.
  The complete four-worker rerun retains every case and its existing assertions.
- An ad hoc runtime metadata one-liner hit PowerShell quoting; a local ignored
  script then read the server/runtime metadata successfully. No DB write occurred
  in that probe. PDF text extraction required its normal local log permission.

## Remaining acceptance and limitations

Foundation CI must be assessed on the submitted PR head; the PR carries the
run/check URLs and conclusion. Local checks are not independent review. No
merge, automatic merge, issue closure or deployment was performed.

The unchanged dependency installation reports 12 affected entries (8 moderate,
4 high), already tracked outside this scope in #51. The unchanged frontend
build reports its >500 kB bundle warning. These are not remediated or accepted
as production risks here. Idempotency expiry is enforced for replay/recovery;
no scheduled purge, new notification/outbox delivery, runtime rollout or other
operational #51 change is introduced.

See the [React Publish handoff](sp13-react-publish-handoff.md). A10 integration,
React dialog/client work, real-browser acceptance and SP-14 employee ownership
remain separate. **This is backend evidence, not SP-13 end-to-end acceptance.**
