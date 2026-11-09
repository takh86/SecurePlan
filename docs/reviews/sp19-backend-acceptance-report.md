# SP-19 administrative work queue: backend-backed acceptance report

Target: draft PR #113, branch `feat/sp19-admin-work-queue-ui`.
Product code under test: commit `3eb9465` (acceptance fixes); this report is committed after it.
Refs #35 and #36. This report does not close those issues and does not merge PR #113.
It supersedes the stub-only status in `sp19-browser-acceptance.md`.

## Result

All 15 backend-backed scenarios passed in one complete run (exit code 0, no fatal error).
The run used the real NestJS backend, the real React frontend (Vite development server),
real Chrome, and an isolated PostgreSQL 17 database. Some checks used controlled fixtures,
documented below. Merge recommendation is in the last section.

## Environment

| Item | Value |
|---|---|
| Database | Disposable PostgreSQL 17.11, Docker container `secureplan-sp19-6892717d7142` (run ID `sp19-6892717d7142`), image `postgres:17`, tmpfs storage, host binding 127.0.0.1:55736 -> 5432. Created for this run only. |
| Existing database | Not used, not modified. The persistent development container `docker-postgres-1` (127.0.0.1:5432) was not connected to, migrated, or written. |
| Target verification | Repository procedure `docs/testing/disposable-postgres.md`: `scripts/disposable-test-target.mjs record` and reverify, then migrations applied twice (second run no-op), then `scripts/verify-db.mjs` passed. |
| Migrations | `0001` through `0018` (repository files, applied to the disposable database only). |
| Backend | NestJS built from this branch (`apps/backend`), started with the development `.env` for secrets and settings; `DATABASE_URL` overridden to the disposable database; `PORT=3000`, `APP_ORIGIN=https://localhost:8443`, `NODE_ENV=development`. Readiness `GET /api/v1/health/ready` = 200. |
| Frontend | Vite development server `https://localhost:8443` (mkcert certificates copied from the development checkout, gitignored); `/api` proxied to the backend. |
| Browser | Google Chrome (channel `chrome`) via Playwright 1.64.1, headless; viewport 1440x1000 and emulated 390x844; locale de-DE; browser time zone America/Los_Angeles; `ignoreHTTPSErrors` for the local certificate. |
| Identities | Synthetic only: Company A (administrator, a second administrator for role-change tests, three employees), Company B (administrator, one employee). Generated random password per run, never printed. E-mails carry a per-run tag under `@example.invalid`. |
| Harness | `scripts/sp19-browser-acceptance.mjs` (committed). Evidence: `docs/reviews/sp19-evidence/backend/`. |

Synthetic data created by the run: 2 companies, 7 accounts, 4 employees, 3 projects,
3 published plans, 30 cancellations (27 for one employee in one month, 1 for a second
employee in another project, 1 for a third employee that was withdrawn, 1 in Company B),
four replacement offers created over HTTP (one of them later set to withdrawn by a fixture),
and calendars for each project.

## Scenario matrix

Status: PASS = executed against the real backend and isolated database; FAIL; BLOCKED;
NOT RUN. Each row gives the steps, the expected and actual results, and the evidence.

| Test | Scenario | Steps (abridged) | Expected | Actual | Status | Evidence |
|---|---|---|---|---|---|---|
| TEST-01 | Administrator login, queue from backend | UI login as Company A administrator; open `/arbeitsuebersicht` | Queue loads from the backend, no preview text, no authorization error | Heading and rows rendered; no `Demodaten`, `VORSCHAU`, `Alex Beispiel`, `Beispielzeit`. `GET /api/v1/admin/work-queue?page=1&pageSize=25&sortBy=createdAt&sortOrder=asc` = 200, `cache-control: private, no-store` | PASS | HTTP trace; `TEST-01-admin-queue-desktop.png` |
| TEST-02 | Queue values match API and PostgreSQL | Read row of case C1 (Dec 3 duty, two offers) | Employee, project, shift, date, statuses and counts equal API and PostgreSQL | UI row: Projekt `SP19 Nord`; Dienst `Do, 03.12.2026`, `Tagdienst · 06:00 – 18:00`, `Zeitzone Europe/Berlin`; Vorgang `Absage`; Absage `Offen`; Ersatzbedarf `Offen`; Offene Angebote `2`; Aktuell geeignet `1`; Angelegt in UTC. API for the same row: `openOfferCount` 2, `eligibleOpenOfferCount` 1. PostgreSQL: request `OPEN`, need `OPEN`, 2 offers with status `OPEN`. | PASS | PostgreSQL rows (`TEST-02 open/status for C1`); HTTP; `TEST-01` screenshot |
| TEST-02b | Overnight duty in saved zone | Süd night duty, browser in America/Los_Angeles | Times and end date in Europe/Berlin | `18:00 – 06:00 (Mo, 11.01.2027)`, `Zeitzone Europe/Berlin` | PASS | UI assertion |
| TEST-03 | Offers: ELIGIBLE / INELIGIBLE / NOT_APPLICABLE | Open C1 and C2 | Labels from the server; no decision control | C1: Synthetic Bravo `Aktuell geeignet`; Synthetic Charlie `Aktuell nicht geeignet` (after SICK fixture on the duty day). C2: withdrawn offer `Nicht anwendbar`; `GET /replacement-needs/{id}/offers` for C2 returns `reviewEligibility: NOT_APPLICABLE`. No button named approve, reject, select, assign, confirm, save or cancellation. | PASS | HTTP 200; PostgreSQL (`offers-after-setup`); `TEST-03-case-eligibility.png` |
| TEST-04 | Filters, sorting, pagination, empty page, URL state | Click offer filters; type, project, month, sort; next/previous; `?page=3`; reload | Server parameters and stable state | Offer `WITH_ELIGIBLE` shows 2 rows (C1, C3); project Süd shows 1; month 2027-01 shows 1; sort and type applied; `Seite 1 von 2` then page 2 requested from the server; `?page=3` shows `Diese Seite ist leer`, `Zur ersten Seite` returns to page one; reload restores the offer filter from the URL | PASS | UI assertions; `TEST-04-filters.png` |
| TEST-05 | Case changed while open | Open C4 (not yet withdrawn), withdraw it by its employee via `POST /api/v1/cancellation-requests/{id}/withdraw`, refresh | Authoritative state; closed case not pending | Withdraw = 200; PostgreSQL `WITHDRAWN`; open cancellations 28 after (29 before by construction: 27 + C3 + C4); detail after refresh shows `nicht mehr offen` note. The absence of the row in the queue was not asserted in the UI; the count is verified in PostgreSQL. | PASS | HTTP 200; PostgreSQL rows; `TEST-05-after-withdrawal.png` |
| TEST-06a | HTTP authorization and tenant isolation | Employee, anonymous, cross-tenant, invalid and hidden IDs (HTTP) | 403, 401, 404 without existence information | Employee `GET /admin/work-queue` = 403 `ACTION_FORBIDDEN`. Anonymous = 401 `SESSION_REQUIRED`. Company A reads Company B offers, cancellation and project filter = 404 `RESOURCE_NOT_FOUND` each. Company B administrator reads a Company A case = 404. Malformed ID `not-a-uuid` = 404 `RESOURCE_NOT_FOUND`. Company B has still exactly one open need after the attempts. | PASS | HTTP trace; PostgreSQL (`no cross-tenant write`) |
| TEST-06b | UI: employee and unavailable cases | Employee signs in and opens `/arbeitsuebersicht`; administrator opens a foreign case and a malformed ID | `Kein Zugriff auf diese Ansicht`; `Vorgang nicht verfügbar` without case data | As expected; `TEST-06-unavailable-case.png` | PASS | `TEST-06-unavailable-case.png` |
| TEST-06c | Logout, replay, revocation and expiry | UI logout; replay the signed-out session cookie from a fresh context; revoke and expire sessions of a dedicated account | Replay and revoked and expired sessions rejected by the server | UI shows sign-in after logout; replayed cookie = 401 `SESSION_REVOKED`; revoked = 401 `SESSION_REVOKED`; expired = 401 `SESSION_EXPIRED`. Cookie values were never printed or stored. | PASS | HTTP trace |
| TEST-06d | Account switch, same browser | Administrator signs out; employee signs in and opens the admin route | No administrative data | `Kein Zugriff auf diese Ansicht`; no admin rows; no table | PASS | UI assertions |
| TEST-07a | Network interruption and retry | Browser offline, click refresh, online, retry | Safe error, then recovery | `Verbindung fehlgeschlagen`; retry shows the table | PASS | UI assertions |
| TEST-07b | Forbidden after real role change | Second administrator loaded; role set to EMPLOYEE in the database; refresh | 403 once, no request loop | `Kein Zugriff`; exactly one queue request in 1.5 s after the 403. Server answered 403 `ACTION_FORBIDDEN` for the employee role (TEST-06a). | PASS | UI request count; `TEST-07b-forbidden.png` |
| TEST-07c | Empty response, hidden project, pagination beyond the end | `?month=2030-01`; `?projectId=` of Company B; `?page=3` | Empty state; `Projekt nicht verfügbar` with removal; empty page with way back | `Keine Vorgänge für diese Auswahl`; real 404 for the hidden project and `Projekt nicht verfügbar`, filter removal returns the table; `Diese Seite ist leer` | PASS | HTTP 404; UI assertions |
| TEST-07d | Invalid timestamp rejected (controlled fault injection) | Route interception rewrites `createdAt` of the real response to `2026-13-01...` | `Antwort konnte nicht verarbeitet werden`; no uncaught page error | As expected; page errors 0 | PASS | UI assertions |
| TEST-07 (API 401 in UI) | UI reaction to a revoked session mid-page | — | Sign-in form | Not run against the real backend in this run. Covered by the stub-based run (UI-07b). | NOT RUN (real backend) | `docs/reviews/sp19-browser-acceptance.md` |
| TEST-08 | UX: keyboard, responsive layout, German labels, console | Tab to the open link; 390px emulation; console | Visible focus; no horizontal overflow; no uncaught errors | Focus visible on `Vorgang öffnen`; no horizontal overflow at 390 px; German labels; page errors 0; console errors are only `Failed to load resource` entries from negative tests (401 x4, 404 x2, network disconnect x1) | PASS | `TEST-08-mobile-390.png`; console categories in the JSON |

Scope limits of TEST-08: desktop Chrome only; mobile is viewport emulation; no other
browsers or physical devices.

## Controlled fixtures (not production workflow paths)

These writes were made directly in the disposable database and are labelled in the harness:

1. An availability record `SICK` for one candidate on the duty day of case C1, after her
   offer was accepted. Purpose: current eligibility changes after submission (TEST-03).
2. One offer of case C2 set to `WITHDRAWN` with a decision time. Purpose: NOT_APPLICABLE
   state (TEST-03).
3. Session rows of a dedicated account: `revoked_at` set, and `absolute_expires_at` set to
   one millisecond after creation (TEST-06c). A first attempt set expiry before creation and was
   correctly rejected by `chk_sessions_absolute_expiry`; the fixture was corrected.
4. A role change of a dedicated account from COMPANY_ADMIN to EMPLOYEE and back (TEST-07b).

Everything else (identities, plans, calendars, duties, saves, publication, cancellations,
offers, withdrawal, reads) went through the real HTTP API as the actual accounts.

## Defects

Product defects found in this backend-backed run: **none**.

Defects found earlier by the stub-based browser run and fixed on this branch (commit
`3eb9465`), with regression tests:

| ID | Severity | Status here |
|---|---|---|
| B-01: 403 caused an endless request loop | High | Fixed; verified with the real backend by TEST-07b (exactly one request after 403) |
| P2-01: impossible timestamps threw `RangeError` | Medium | Fixed; verified by TEST-07d (real response with injected impossible timestamp) |
| P2-02: empty offer page and status without matches both said "no offers" | Medium (UX) | Fixed; verified in the stub browser run (UI-07f) and unit tests. Not separately exercised against the real backend. |
| P3: project-list failure without recovery | Low | Fixed; verified in the stub browser run (UI-07e) and unit tests. Not exercised against the real backend. |
| L-01: desktop action column clipped at 1440 px | Medium (layout) | Fixed; verified by screenshot `UI-01-queue-desktop.png` from the stub run and by the backend run's desktop screenshots |

Harness corrections made during this run (test tooling, not product code): an expectation of
the exact cache header (the contract says `private, no-store`); a race while counting rows
during a pending router navigation; a login that had not finished before the employee route
was requested; the expiry fixture described above; and per-run e-mail tags, because account
e-mails are unique and the disposable database may be reused.

## Automated checks on the reviewed product code

Run before this report on the same product code (commit `3eb9465`; this report and the
harness only changed documents and the script):

| Command | Result |
|---|---|
| `npm run lint` (root) | exit 0 |
| `npm run typecheck` (backend, incl. tests) | exit 0 |
| `npm run test --workspace=frontend` | 78 files, 1390 tests passed |
| `npm run build --workspace=frontend` | exit 0 |
| `npm test` (backend unit) | 42 files, 480 tests passed |
| `npm run check:public`, `git diff --check` | passed |
| Backend E2E and script suites (`npm run test:e2e`, `test:scripts`) | Not run in this session; CI backend job runs them |

## Remaining risks

1. Only desktop Chrome; mobile is emulated; the frontend under test is the development
   server, not the production bundle.
2. Eligibility transitions use controlled fixtures (sickness, withdrawn offer); production
   transitions are not exercised by this run.
3. Eligibility counts are checked against expected fixture values and the API; they are not
   recomputed independently in SQL.
4. UI reaction to a session revoked in the middle of a page with the real backend is not
   executed here (stub run only).
5. The case-view empty-state and project-list retry fixes are verified in the stub browser run
   and unit tests, not against the real backend.
6. Malformed identifiers return 404 `RESOURCE_NOT_FOUND` (concealment by design), not 400.
   This is consistent with the error contract but differs from a 400 expectation.
7. Pre-existing and outside this PR: `OpenDutiesPage` uses the same session-revalidation
   pattern on 403 that caused B-01 in the work queue, so it may show the same request loop.
8. The acceptance harness is a local script (needs Docker, Chrome and a running stack); it is
   not part of CI.

## Merge recommendation

**READY FOR HUMAN REVIEW / MERGE CANDIDATE**, conditional on the GitHub CI run for the final
PR head being green (checked and recorded in the PR description after the push). The remaining
risks above are not blockers for the reviewed scope, but they must be accepted by the reviewer.
Merging is a human decision; nothing has been merged.
