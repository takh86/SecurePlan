# SP-11 PR-1 — planning foundation (create/read slice)

Date: 2026-11-02. Branch `feat/sp11-planning-foundation`, based on verified `main`
`787ba08e4ec57f30cfd19305747e5171647a08cf`. Tracking: [#25](https://github.com/takh86/SecurePlan/issues/25),
[#26](https://github.com/takh86/SecurePlan/issues/26). Draft PR only: no merge, issue closure or deployment.

## Authority

- Business rules: [PO decision D1–D6](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6502123168),
  [CR-03](../requirements/cr-03-direct-published-plan-updates.md),
  [ADR-0003](../architektur/adr/0003-schichtkonfiguration-monatsversioniert.md) (O-10, D6).
- Technical design: the owner's conditional approval (31.10.2026) of the SP-11A technical design,
  revision 3.1, with three corrections, after an independent Tech Lead review. The controlled design
  and approval record stay outside this repository; this page summarizes only what the code does.
- A local preflight on 2026-11-02 compared the controlled originals (by checksum) and the
  repository rules with that design before any product change; no contradiction remained.

## What this PR delivers

| Area | Delivered |
|---|---|
| Schema | Migration `0011_planning_foundation.sql`: `monthly_plans`, `duties`, `plan_assignments` with composite tenant/project/month ownership keys, live partial unique indexes, a duty tombstone and retained REMOVED memberships, UTC snapshots without a FK to the shift configuration, and a per-duty concurrency version (no plan version) |
| Guards | The two temporary fail-closed guards are **replaced** in the same change: real D2 (assignment PATCH/DELETE, old and resulting tuple) and D3 (shift PATCH, `[M, next version)`) checks. A catalog schema signature (ABSENT/COMPLETE/INVALID) precedes every planning check and write; anything but the exact canonical schema fails closed as a sanitized 500 |
| Workforce writers | D4 project ACTIVE→INACTIVE, D5 employment period (newly excluded future duties only, after the unchanged monthly check), employee deactivation (any unresolved future duty membership) |
| Locking | LOCK-01-L1 for new writers: sequential account prefix (accounts in UUID order at final strength, then company SHARE) before employees, projects, monthly assignments and the plan row; fresh statements after waits; bounded lock/statement timeouts. Deactivation now locks the linked account before the employee. A static tripwire keeps the company row a SHARE-only leaf |
| D6 | One adapter over the exact pin `@js-temporal/polyfill` 0.5.1 (native Temporal is absent on Node 24): gap → later, fold → earlier, per-endpoint local dates, NIGHT wrap only when end < start. Boot self-test on the approved goldens; differential test against an Intl oracle on the full transition matrix |
| API | `GET/POST /api/v1/monthly-plans`, `GET /api/v1/monthly-plans/{planId}`, `GET/POST /api/v1/monthly-plans/{planId}/entries`; COMPANY_ADMIN only; plans are created UNPUBLISHED |
| Errors | Three new 409 codes: `PROJECT_HAS_FUTURE_DUTIES`, `EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_DUTIES`, `DUTY_TIME_RANGE_INVALID` (a valid request that the saved configuration cannot resolve; structural input stays 400) |
| Audit | Three bounded creation events (see [ADR-0004 supplement](../architektur/adr/0004-related-business-audit-catalogue.md)) |
| E-04 | Admin entry reads carry neutral `availabilityConflicts` (`EMPLOYEE_UNAVAILABLE`, never SICK/LEAVE); a later absence never changes a duty |

Explicitly **not** in this PR: publish, entry edit/removal, edit leases, Idempotency-Key handling,
replacement workflow, employee-facing plan reads and any React planning UI. The accepted product
boundary is therefore pre-publication.

## Recorded technical choices

- No business roster maximum and no century window for dates. A roster is bounded only by the
  existing 100 KiB JSON body limit (413); every roster check is a set-based statement.
- PostgreSQL-generated UUIDs instead of the originally designed application UUIDv7 (intentional).
- Lock timeout 5 s, statement timeout 15 s for the new writers; deadlock, serialization and lock
  timeout failures are sanitized 500s and never replayed automatically.
- The D2 check also runs for effective HISTORICAL corrections, exactly where the temporary guard ran.
- Resolved instants outside 0001-01-01T00:00:00Z … 9999-12-31T23:59:59Z count as an invalid
  interval (`DUTY_TIME_RANGE_INVALID`); the strict ISO date DTO already rejects year 0000.
- `Location` names the created plan or entry; single-entry GET, PATCH and DELETE belong to SP-12.

## Executed evidence (local, Windows, Node 24.21.0, ICU 78.3, tz 2026c)

Disposable PostgreSQL 17.11 container (tmpfs, loopback-only, labelled run, receipt verified with
`scripts/disposable-test-target.mjs`) — never the development database.

| Gate | Result |
|---|---|
| Baseline before any change (`787ba08`) | `npm run test:e2e`: 37 files / 763 tests passed |
| `node scripts/migrate.mjs` ×2, `node scripts/verify-db.mjs` | 0011 applied once, replay no-op, verification including the new planning check passed |
| `npm run lint` / `npm run typecheck` / `npm run build` | passed (0 lint warnings) |
| `npm test` (backend unit) | 33 files / 339 tests passed, including the 151,515-comparison differential test |
| `npm run test --workspace=frontend` | 40 files / 520 tests passed |
| `npm run test:e2e` | 41 files / 871 tests passed (new: monthly plans 20, dependencies 19, concurrency 35, schema constraints 24; rewritten guards suite 30) |
| Script tests (check-public, reissue, disposable target, migration safety) | 21/21 passed |
| PostgreSQL server log | 0 deadlocks in any run. Each full E2E run, the unchanged baseline included, logs the same 3 lock timeouts from pre-existing tests that exercise `lock_timeout`; the planning suites run alone log none |

The concurrency suite runs every writer pair (D2, D3, D4, D5, deactivation) in both acquisition
orders with COMMIT and ROLLBACK of the first writer, plus insert-key races, an absence-fact race,
a stale-snapshot negative control and the account-prefix proofs (UUID order, actor = target,
revoked/downgraded actor, linked-account drift, stand-in self-service writer, parallel deactivations).

NOT_RUN locally: `scripts/activation-demo.test.mjs` (its guard accepts only the development database;
CI covers it), real browser acceptance (no planning UI exists). CI evidence is recorded on the PR.

## Open points

- Rollout: an older application revision keeps the temporary guards and refuses every effective
  assignment/shift change once the planning tables exist (fail closed). Old and new workforce
  writers must not run side by side after scheduling is enabled; drain and restart are an
  operations decision (#51), not granted here.
- A later migration that alters the three relations must update the schema signature in the same change.
- The review-only proof branch still describes CR-03 as unavailable; its synthetic results must not be
  cited without that correction. This PR does not use them as evidence.
- Independent technical review of this implementation, independent documentary acceptance of the
  ADR-0004 supplement, browser acceptance (PR-2) and the SP-12/SP-13 slices remain separate gates.
