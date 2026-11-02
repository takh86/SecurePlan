# SP-11 PR-2 — monthly planning UI (create/read slice)

Date: 2026-11-02. Branch `feat/sp11-pr2-ui`, **stacked** on SP-11 PR-1 (Draft PR #79,
`feat/sp11-planning-foundation` at `4834b33`), which is not merged. Tracking:
[#25](https://github.com/takh86/SecurePlan/issues/25), [#26](https://github.com/takh86/SecurePlan/issues/26).
Draft only: no merge, issue closure or deployment.

## Scope

A COMPANY_ADMIN React interface on exactly the five PR-1 routes
(`GET/POST /api/v1/monthly-plans`, `GET /api/v1/monthly-plans/{planId}`,
`GET/POST /api/v1/monthly-plans/{planId}/entries`). No backend, migration, dependency,
lockfile, CI or `.env` change. No publish, edit, removal, lease or replacement call exists
in the UI, and no business rule was changed.

| Area | Delivered |
|---|---|
| Navigation | `/monatsplanung` is now an available admin route (was a placeholder); role gating stays UX only |
| Month overview | `?month=YYYY-MM` (default: the clock's current month, invalid values fall back to it), month steps across year boundaries, every visible project with its plan state for the month |
| Create plan | Inline confirmation naming project, month and effect (unpublished; cannot be deleted in this slice), then `POST` with `projectId` + `monthStart` only; opens the new plan |
| Plan page | Plan and project status (read-only), stored duties with date, kind, resolved times, members, shift-lead role and neutral availability hints; link to the project's shift times and month assignments |
| Add duty | Date limited to the plan month, DAY/NIGHT, optional roster with a duty role per member; a duty without members is allowed (no staffing minimum); the effective shift times of the month are shown as information |
| Eligibility pre-selection | Offers only employees who are assigned to the project for the plan month, ACTIVE, employed on the duty date (inclusive, missing start = no evidence) and eligible for the kind; excluded assigned people are listed with a reason. The server re-validates everything and alone decides absence and overlaps |
| States | Loading, empty, retryable read errors, 403/404 safe states, pending/double-submit lock, per-code German error texts that say nothing was saved, "outcome unknown" for a lost response (no automatic retry, explicit re-read), unsaved-input navigation guard, inactive project read-only |
| Security | Session/CSRF via the existing `SessionApi` (token only in memory, sent on unsafe methods); no tenant, role, status, instant or version is ever sent; every response is shape-checked; conflicts keep only `{code, assignmentId, employeeId}` |

## Design decisions to review

- **A10 deviation.** The approved UX for the plan screen is an employee-by-day matrix with a
  focus editor. Its per-cell editing needs membership changes on existing duties (SP-12).
  This slice therefore shows a duty-centric list plus a creation form. The matrix belongs to
  the edit slice and needs a UX decision then.
- **Time display (gap).** No API exposes the company's IANA time zone; duty responses carry
  UTC instants only. The UI shows them in the device's zone and always names it (zone
  abbreviation per endpoint when a DST change lies inside a duty, and a hint naming the IANA
  zone). The instants are never recalculated. Exposing the company zone (or local times in
  the entry DTO) is an API decision, not taken here.
- **Neutral availability.** The planning UI reads no availability data of its own, so it
  cannot reveal sickness or leave. It displays only the API's neutral
  `EMPLOYEE_UNAVAILABLE` conflicts and refusal.
- **Wording.** Duty roles are shown as "Mitarbeitende" and "Schichtleitung" (API
  `EMPLOYEE`/`SHIFT_LEAD`); the status `UNPUBLISHED` as "Unveröffentlicht". To confirm in UX review.
- The client now trusts the ten planning creation codes only with their catalogued status
  (`INVALID_DATE`, `DUTY_DATE_OUTSIDE_PLAN_MONTH`, `MONTHLY_PLAN_ALREADY_EXISTS`,
  `DUTY_ALREADY_EXISTS`, `SHIFT_CONFIGURATION_MISSING`, `DUTY_TIME_RANGE_INVALID`,
  `EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH`, `EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT`,
  `EMPLOYEE_UNAVAILABLE`, `DUTY_ASSIGNMENT_CONFLICT`). No code was added to the backend
  catalogue. `MONTHLY_PLAN_ALREADY_PUBLISHED` stays untrusted until a UI handles it.

## Executed evidence (local, Windows, Node 24.21.0)

Disposable PostgreSQL 17.11 container (tmpfs, loopback-only port, unique run label,
receipt recorded and re-verified with `scripts/disposable-test-target.mjs`), never the
development database. Migrations `0001`–`0011` applied once, replay no-op, `verify-db` passed.

| Gate | Result |
|---|---|
| `npm run lint` | passed, 0 warnings |
| `npm run typecheck` / `npm run build` | passed (frontend build type-checks test files) |
| `npm run test --workspace=frontend` | 46 files / 607 tests passed (base `4834b33`: 40 / 520) |
| `npm test` (backend unit, unchanged code) | 33 files / 352 tests passed |
| `npm run test:e2e` (backend, unchanged code, disposable target) | 43 files / 946 tests passed |
| `check-public`, `disposable-test-target`, `migration-safety` script tests | 17 / 17 passed |
| `npm run check:public`, `git diff --check`, harness `node --check` | passed |
| Browser harness (below) | 12 / 12 groups passed, no uncaught page errors, exact-tenant cleanup PASS |

New frontend tests: API client validation and requests, eligibility rules (inclusive
employment boundaries, case-insensitive ids, precedence), time display (DST end, year
boundary, foreign device zone), error texts, overview and plan page with an in-memory
company, and shell integration (logout then Back/Forward/Refresh on a plan deep link; a duty
write carrying the in-memory CSRF token and only the three business fields). Fixed clock
15.12.2026; month and year boundaries (Dec→Jan, February 2027/2028) are covered. Test
records are synthetic examples, not business rules.

## Real browser acceptance

`scripts/sp11-planning-browser-acceptance.mjs`: headless **Google Chrome 156.0.8078.74**
through an external, pinned **Playwright 1.64.1** (not an application dependency), the built
React assets over local HTTPS with the trusted localhost certificate, a minimal proxy to the
unmodified NestJS build on an ephemeral loopback port, and the verified disposable cluster.
Browser locale `de-DE`, time zone `Europe/Berlin`. No `ignoreHTTPSErrors`, injected session,
mocked API or development database.

Fixture boundary: only prerequisites are inserted directly (two synthetic tenants, accounts,
employees, projects, month assignments, shift times, one pre-existing absence, one plan of the
foreign tenant). Every plan, duty and membership asserted as persisted was created through the
UI and read back from PostgreSQL; the later absence in P08 was entered through the real SP-10 UI.

| Group | Actual evidence | Result |
|---|---|---|
| P01 | Form login on a `/monatsplanung` deep link, Secure/HttpOnly/SameSite cookie, current-month overview, month step, inactive project without action, foreign project not listed, no browser storage | PASS |
| P02 | Keyboard-only create (Enter, focused confirmation heading, Tab, Enter); no write before confirming; one `UNPUBLISHED` row without `published_at`; one `MONTHLY_PLAN_CREATED` audit event | PASS |
| P03 | Pre-selection offers exactly the three assigned people; DAY duty with a shift lead; focused notice; row `06:00 – 18:00 MEZ`; PG `05:00Z–17:00Z`, zone `Europe/Berlin`, version 1, `SCHICHTLEITER`/`MITARBEITER` members; audit 1 + 1 + 2 | PASS |
| P04 | NIGHT duty on 31.12.2026 shown as `18:00 – 06:00 (Fr., 01.01.2027) MEZ`; PG `2027-01-01T05:00:00Z`; DAY-only person listed as excluded with reason | PASS |
| P05 | Absent member refused neutrally ("Person nicht verfügbar"), no sickness/leave wording on the page, input kept, no duty and no audit written | PASS |
| P06 | A second logged-in admin takes the slot first; the stale first admin gets `DUTY_ALREADY_EXISTS`, explicit reload shows one duty; loser's members not written | PASS |
| P07 | Proxy truncates the real 201 body **after commit**: "Ergebnis unbekannt", no retry button, exactly one POST, one stored duty, explicit reload shows it once, input kept | PASS |
| P08 | Unsaved-input guard holds a sidebar navigation (focused prompt) and discards on request; an absence entered via the SP-10 UI produces the neutral hint in place and in the summary; duties and memberships byte-identical before/after | PASS |
| P09 | Foreign tenant's plan id answers "Nicht gefunden"; no foreign name or table shown; foreign rows unchanged | PASS |
| P10 | 390 px viewport: plan page and overview without horizontal page scroll and without badges overflowing their cells (this check failed on the first build and passed after the CSS correction) | PASS |
| P11 | EMPLOYEE account: "Kein Zugriff auf diese Ansicht"; same-origin `GET` of the plan answers 403 | PASS |
| P12 | Reload of the plan page, logout, Back, Forward, Back + Refresh: only the login, no plan data, no storage; no additional POST or audit event | PASS |

Screenshots and the JSON report stay in a private directory outside Git. A local test proxy is
not evidence for a deployed proxy. Reproduce with the [disposable PostgreSQL prerequisite](../testing/disposable-postgres.md),
a build, the local trusted TLS certificate, the login HMAC/denylist environment, an external
Playwright 1.64.1 (`SECUREPLAN_PLAYWRIGHT_MODULE` = absolute `playwright/index.mjs`) and
`SECUREPLAN_BROWSER_OUTPUT_DIR` outside Git, then `node scripts/sp11-planning-browser-acceptance.mjs`.

NOT_RUN: `activation-demo` script tests (their guard accepts only the development database),
CI on this branch (to be assessed on the pushed head), screen-reader, cross-browser and device
acceptance, owner UX sign-off, production performance and load.

## Open points and integration requirements

- **Stacking.** This branch contains PR #79 unchanged and must be rebased or retargeted only
  after #79 is approved and merged; it must not be merged before #79.
- The root README and `docs/project-status.md` still describe the state before SP-11 PR-1
  (e.g. "Planung/Dienste sind noch nicht implementiert"); updating them belongs to the
  integration after #79.
- A10 matrix and focus editor, publish (SP-13), duty edit/removal and leases (SP-12), and
  employee-facing plan reads remain separate approvals.
- Company time zone exposure (see above) is an open API decision.
- Independent technical and UX review of this diff remain separate gates.
