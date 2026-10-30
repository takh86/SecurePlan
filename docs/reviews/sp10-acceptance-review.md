# SP-10 PR #78 — critical review and browser acceptance

Review starting point: `e404d43142fb1b901fd27bcd2a4d92eac7885ebc`, against
`main` at `5752ca82838a62a54e4bcb4395709d5ff4e3f0bb`. All 47 changed files were
reviewed individually, including their authorization, transaction, error,
employee lifecycle and frontend integration context. The ratified SP-10
supplement and approval record were checked privately; neither is published.
[ADR-0005](../architektur/adr/0005-availability-batches.md) is the public summary.
This is the implementation agent's critical review, separate from the owner's
independent Tech Lead review and final human acceptance.

## Confirmed findings

Severity P2 means a concrete, in-scope defect requiring correction before
acceptance. No P0/P1 or additional demonstrable in-scope defect was found.
Accepted limitations below are not relabeled as new defects.

| Finding | Severity | Exact original evidence | Proof | Correction and regression evidence | Final result |
|---|---|---|---|---|---|
| F1: a reloaded month retained a destructive confirmation | P2, UX/consistency | [EmployeeAvailabilitySection.tsx L106](https://github.com/takh86/SecurePlan/blob/e404d43142fb1b901fd27bcd2a4d92eac7885ebc/apps/frontend/src/features/employees/EmployeeAvailabilitySection.tsx#L106): disclosure only toggled `open`; L110 remounted the month read, while L34 retained preview/confirmation | In real Chrome: confirm CLEAR, hide the section, second real admin clears the range, reopen and load the now-empty month. The old checked confirmation/save control remained visible. The backend still refused stale commits; no overwrite bypass was observed. New RTL regression also failed before correction. | Disclosure now discards preview/confirmation before a fresh month read. Dates, status and unrelated unsaved master data remain. [Regression](../../apps/frontend/src/features/employees/EmployeeAvailabilitySection.test.tsx), test “disclosure reload discards…”; real browser B06 passes. | **PASS — fixed** |
| F2: a valid binding concealed additional unverified database port bindings | P2, test safety/network isolation | [disposable-test-target.mjs L23](https://github.com/takh86/SecurePlan/blob/e404d43142fb1b901fd27bcd2a4d92eac7885ebc/scripts/disposable-test-target.mjs#L23) used `some` | Three database-free negative tests failed: a valid loopback binding plus public IPv4, public IPv6 or a second unverified loopback port was accepted. The actual test container had only the intended loopback binding; no fixture write to a shared target occurred. | Require a nonempty binding array with **every** binding matching the verified loopback endpoint. [Gate regressions](../../scripts/disposable-test-target.test.mjs) now pass 11/11; the full script suite passes 34/34. Actual container/cluster reverified before fixtures. | **PASS — fixed** |

## File-by-file review matrix

Paths are relative to the repository root. PASS means no remaining confirmed
defect in the reviewed scope after the corrections; it is not a claim of formal
verification or production approval. The list is exactly the original 47-file
diff; the new browser harness and this report are reviewed separately below.

| # | Changed file | Review focus and result |
|---|---|---|
| 1 | `.gitattributes` | PASS: LF pin applies only to migration 0010; older applied files unchanged. |
| 2 | `.github/workflows/ci.yml` | PASS: explicit disposable connection, unique label/tmpfs/loopback, identity before writes; existing checks/masking retained. |
| 3 | `README.md` | PASS: implemented/design/release boundaries and safe test prerequisites; follow-up browser scope updated. |
| 4 | `apps/backend/migrations/0010_employee_availability.sql` | PASS: tenant composite FKs/RESTRICT, day uniqueness/status/date bounds, bigint revision, complete command state/count/digest checks and lookup/expiry indexes. |
| 5 | `apps/backend/package.json` | PASS: direct E2E invocation uses verified launcher; no application dependency added. |
| 6 | `apps/backend/src/app.module.ts` | PASS: DI/controller wiring; single global authorization guard and injected clock retained. |
| 7 | `apps/backend/src/common/errors/error-contract.ts` | PASS: four additive approved code/status pairs; existing catalogue unchanged. |
| 8 | `apps/backend/src/common/filters/problem-details.filter.ts` | PASS: no-store includes pre-handler availability errors; sanitized problem/log output and other workflows retained. |
| 9 | `apps/backend/src/modules/audit/business-audit.service.ts` | PASS: scoped action/resource extension, parameterized insert on caller's transaction, no broad catalogue ratification. |
| 10 | `apps/backend/src/modules/workforce/availability/availability.controller.ts` | PASS: three explicit admin handlers, canonical IDs/trusted tenant/CSRF, raw duplicate-header rejection, replay and Retry-After headers. |
| 11 | `apps/backend/src/modules/workforce/availability/availability.rules.spec.ts` | PASS: date boundaries, no-op/conflict effects, normalization, explicit confirmation and header cases. |
| 12 | `apps/backend/src/modules/workforce/availability/availability.rules.ts` | PASS: canonical civil dates, inclusive 1–93, documented employment/inactive precedence, deterministic hashing and effects. |
| 13 | `apps/backend/src/modules/workforce/availability/availability.service.ts` | PASS: tenant predicates, actor/parent/command order, fresh statements after waits, revision/ABA, expiry/replay/cleanup, atomic delta+audit+completion, neutral internal read. |
| 14 | `apps/backend/src/modules/workforce/availability/availability.types.ts` | PASS: bounded canonical enums/response contracts; no medical input. |
| 15 | `apps/backend/src/modules/workforce/availability/dto/availability.dto.ts` | PASS: required fields, strict Gregorian format/enums, forbidden/null combinations and whitelist via existing global pipe. |
| 16 | `apps/backend/src/modules/workforce/employees/employees.service.ts` | PASS: revision changes only on effective employment changes/deactivation under existing employee lock; monthly errors, audit and no-op behavior retained. |
| 17 | `apps/backend/src/modules/workforce/planning-guard/planning-table-classification.ts` | PASS: only the two non-planning tables added; both planning guards/tripwires retained. |
| 18 | `apps/backend/test/availability-concurrency-real.e2e-spec.ts` | PASS: real SQL barriers/blocking, both-order commit/rollback, key races, authorization, expiry and audit/command faults; no fabricated query results. |
| 19 | `apps/backend/test/availability-real.e2e-spec.ts` | PASS: persisted facts/no-ops/audit, dates/lifecycle/tenant/RBAC/DTO, stale/replay/cleanup and physical integrity checks. |
| 20 | `apps/backend/test/helpers/synthetic-tenants.ts` | PASS: explicit tenant cleanup includes command/marker children before employee parents; launcher/global setup prevents development fallback. |
| 21 | `apps/backend/test/route-access-inventory.e2e-spec.ts` | PASS: exact three admin routes added; public allowlist and classification self-test retained. |
| 22 | `apps/backend/vitest.config.e2e.ts` | PASS: direct Vitest runs reverify target before fixture modules load. |
| 23 | `apps/frontend/src/features/auth/session-api.ts` | PASS: one explicit idempotency header; existing same-origin CSRF/no-store/401 behavior and no implicit retry retained. |
| 24 | `apps/frontend/src/features/employees/EmployeeAvailabilitySection.css` | PASS: scoped styles, visible focus, bounded inputs and scrolling preview table; actual Chrome rendering inspected. |
| 25 | `apps/frontend/src/features/employees/EmployeeAvailabilitySection.test.tsx` | PASS: recovery, confirmation, focus, races and unsaved master-data regression; new F1 test proved red then green. jsdom is labeled separately. |
| 26 | `apps/frontend/src/features/employees/EmployeeAvailabilitySection.tsx` | PASS after F1: fresh explicit decisions, locked pending attempt, exact retry memory, input preservation, expiry/lifecycle/employee unmount handling and accessible controls. |
| 27 | `apps/frontend/src/features/employees/EmployeeDetailPage.tsx` | PASS: employee-keyed section outside the master-data form; unsaved input and existing deactivation/assignment behavior retained. |
| 28 | `apps/frontend/src/features/employees/EmployeesSection.tsx` | PASS: memoized session-bound API and employee-keyed route wiring. |
| 29 | `apps/frontend/src/features/employees/availability-api.test.ts` | PASS: rejects unbound/malformed results, checks complete day/count effects and actual idempotency/CSRF transport. |
| 30 | `apps/frontend/src/features/employees/availability-api.ts` | PASS: strict bounded runtime mapping, selection/employee/day/effect binding, strips unused fields; no business authority delegated to client. |
| 31 | `apps/frontend/src/features/employees/employees.test-support.ts` | PASS: optional header recorded only when sent; existing exact request assertions preserved; test-only data. |
| 32 | `apps/frontend/src/shared/api/api-error.ts` | PASS: approved code/status allowlist and safe German recovery; no raw server detail/value display. |
| 33 | `docs/README.md` | PASS: public navigation only; no private source paths/content. |
| 34 | `docs/architektur/adr/0005-availability-batches.md` | PASS: scoped approval/trade-offs; ADR-0004 preserved and SP-11 explicitly separate. |
| 35 | `docs/datenbank/sp11-integrity-handoff.md` | PASS: factual absence and required future E-04/eligibility/LOCK-01 acceptance are separate; prior dated handoff retained. |
| 36 | `docs/project-status.md` | PASS: verified baseline, actual test/browser scope and remaining owner/operations gates distinguished. |
| 37 | `docs/reviews/sp10-availability.md` | PASS: actual local results, initial CI and follow-up review/browser evidence distinguished. |
| 38 | `docs/security/pre-staging-gates.md` | PASS: revision bypass, minimal audit/retention/proxy/S7-7 remain explicit; SP-10 browser evidence does not pass SP-09/production gates. |
| 39 | `docs/testing/disposable-postgres.md` | PASS: independent preflight and explicit child connection, strict script namespace and credential-free receipt scope. |
| 40 | `package.json` | PASS: fixture-capable launchers require verified target; other scripts unchanged. |
| 41 | `scripts/activation-demo.test.mjs` | PASS: verifies before fixtures and removes .env fallback; original demo-environment/CLI security assertions retained. |
| 42 | `scripts/disposable-test-target.mjs` | PASS after F2: container/storage/all bindings and actual cluster identity; fresh explicit transport receipt, no fixture writes. |
| 43 | `scripts/disposable-test-target.test.mjs` | PASS: fail-closed negative cases, including all three newly reproduced mixed-binding cases. |
| 44 | `scripts/migration-safety.test.mjs` | PASS: only temporary copies altered; actual checksum refusal and DDL/data/ledger rollback; original migration files unchanged. |
| 45 | `scripts/verified-test-command.mjs` | PASS: preflight before child loading, explicit inherited connection, correct workspace/args and exit code, no fallback. |
| 46 | `scripts/verify-db.mjs` | PASS: read-only foundation/0010 revision/table/unique-index catalogue checks; not a substitute for fixture preflight. |
| 47 | `scripts/verify-test-target.mjs` | PASS: E2E global setup reuses actual read-only cluster identity verification. |

The new [browser harness](../../scripts/sp10-browser-acceptance.mjs) was also
reviewed: verified target before fixtures/backend start, random synthetic
credentials/tenant IDs, explicit HTTPS origin, normal TLS validation, real
login/guards, private evidence, exact-tenant cleanup, only its own server/browser
processes closed. Transport faults/delays do not fabricate business responses.
This public report contains no fixture credentials, receipt contents, private
contract text or customer data.

## Actual browser evidence

Windows headless **Google Chrome 156.0.8078.74**, supported Playwright **1.64.1**,
Node 24. The externally installed test tool adds no runtime/package-lock
dependency. Built React assets are served over local HTTPS with the existing
trusted localhost certificate; a minimal test proxy forwards to the unmodified
NestJS application on an ephemeral loopback port. No `ignoreHTTPSErrors`,
injected sessions, mocked business API or development database was used.

| Browser group | Actual evidence | Result |
|---|---|---|
| B01 | Admin form login, real Argon2/account/session, Secure/HttpOnly/SameSite cookie and actual empty month | PASS |
| B02 | Keyboard Enter/Tab preview/save, heading/control focus, month navigation, real SICK rows and date-only audit | PASS |
| B03 | REJECT conflict, fresh REPLACE preview, disabled save until Space confirmation, Enter save and LEAVE persistence | PASS |
| B04 | CLEAR disabled before confirmation, real row removal and per-day audit | PASS |
| B05 | Second logged-in administrator changes state; first gets actual 409 stale, retains dates and obtains a fresh no-op preview | PASS |
| B06 | Competing CLEAR while section hidden; reloaded month discards old confirmation after F1 correction | PASS |
| B07 | Cancel focus, full reload without repeat mutation, no absence browser storage, audit contains date-only values | PASS |
| B08 | Proxy truncates the real 200 body **after DB commit**; explicit retry uses exact body/key, replay header true, no duplicate audit | PASS |
| B09 | Post-save month transport failure; acknowledged CLEAR stays separate, explicit read retry produces no second batch | PASS |
| B10 | 94-day validation and successful save preserve unrelated unsaved employee input; DB master data unchanged | PASS |
| B11 | Delayed real preview finishes after SPA employee switch; old decision ignored; logout/new login carries no confirmation/key | PASS |

All 11 groups passed with no uncaught page exceptions and exact-tenant fixture
cleanup PASS. JSON/synthetic screenshots remain in a private temporary evidence
directory. jsdom and backend HTTP totals below are separate from these actual
browser scenarios. A local test proxy is not evidence for eventual deployment
proxy configuration. Manual owner UX sign-off, screen-reader certification and
cross-browser/device acceptance are not claimed.

Reproduction uses [the verified disposable-PG prerequisite](../testing/disposable-postgres.md),
an existing build/trusted localhost TLS certificate, the normal login HMAC and
verified denylist environment, an external pinned Playwright installation and
installed Chrome. Supply `SECUREPLAN_PLAYWRIGHT_MODULE` as its absolute
`playwright/index.mjs` path and `SECUREPLAN_BROWSER_OUTPUT_DIR` as a **private
directory outside Git**, then run `node scripts/sp10-browser-acceptance.mjs`.
The script selects free loopback ports, verifies the explicit receipt/cluster
again before fixtures and cleanup, and never reads `.env`. Playwright's
[supported Chrome channel](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)
is used with normal certificate checking.

## Required checks and CI

| Executed check on the corrected tree | Result |
|---|---|
| `npm run lint`, `npm run typecheck`, `npm run build` | PASS, exit 0 |
| `npm test` | PASS, 269 tests / 29 files |
| `npm run test --workspace=frontend` | PASS, 519 tests / 40 files |
| `npm run test:e2e` | PASS, 763 tests / 37 files, actual PostgreSQL concurrency/rollback |
| `npm run test:scripts` | PASS, 34 tests, Node 24 in verified PG namespace |
| Migration replay/checksum/failure probes | PASS; no migration changed in this follow-up |
| Browser harness | PASS, 11 real Chrome groups |
| `npm run check:public`, `git diff --check`, browser script syntax | PASS, exit 0 |

At original head `e404d43`, both [push CI 41121733472](https://github.com/takh86/SecurePlan/actions/runs/41121733472)
and [PR CI 41121819854](https://github.com/takh86/SecurePlan/actions/runs/41121819854)
were independently queried as completed **SUCCESS**. The PR's obsolete QUEUED
statement was corrected. These runs certify that exact original head; new-head
CI evidence is recorded separately in PR #78 after the corrective push.

## Remaining gates

- Independent human acceptance of the complete corrected diff and owner merge
  decision remain pending. This agent review is not a substitute.
- SP-11 E-04 discovery/eligibility/global LOCK-01 and duty workflows remain
  **NOT_IMPLEMENTED / NOT_RUN** under #25/#26. No duty is changed by SP-10.
- #51 still owns the deployed proxy, retention maintenance/monitoring, audit DB
  roles/backup/restore, accepted out-of-band revision limitation, inherited
  S7-7 and dependency triage. Production readiness is **NOT_APPROVED**.
- SP-09 browser workflows and broader manual UX/assistive-technology/device
  checks are **NOT_RUN** by this scoped SP-10 browser suite.

PR #78 remains **Draft**; Issue #24 remains **OPEN**. No merge, deployment,
issue closure or business/technical contract amendment was performed.
