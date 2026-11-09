# SP-19 administrative work queue: browser acceptance report

Target: draft PR #113, branch `feat/sp19-admin-work-queue-ui`.
Starting commit: `5a6f63c`. Reviewed fix commit: `3eb9465`.
Refs #35 and #36. This report does not close those issues and does not merge PR #113.

## Result in one sentence

The frontend behaves correctly in real Chrome under controlled API responses, and three
review findings plus one loop and one layout defect were fixed. The required acceptance
against a running backend and a disposable PostgreSQL 17 database was **not executed**
(BLOCKED), so this PR has **insufficient acceptance evidence** for merge.

## Environment

| Item | Status |
|---|---|
| Browser | Google Chrome (installed desktop build, Playwright channel `chrome`), Playwright 1.64.1 from the existing local tooling. Headless. Desktop 1440x1000 and mobile emulation 390x844. Locale de-DE, browser time zone America/Los_Angeles. |
| Frontend | Production build of commit `3eb9465`, served by a loopback static server for the check run only. |
| Backend | **Not started.** |
| PostgreSQL | **Not provisioned** (see Blocker). |
| API responses | Network-level stubs with contract-shaped, synthetic payloads (`scripts/sp19-browser-ui-checks.mjs`). |
| Credentials | None used. No login, no session cookies, no `.env` values were read or printed. |

### Blocker: disposable PostgreSQL 17 target

- Docker Desktop daemon is reachable, but every image operation (including the already
  used `postgres:17`) fails with: `This machine is required to be signed in while using
  Docker Desktop. To continue - run 'docker login' or open the Docker Desktop application.`
- Signing in needs the account owner's credentials. Not supplied; not attempted.
- A native PostgreSQL install exists on this machine, but only versions 15 and 16. The
  repository's disposable-target verifier requires PostgreSQL 17 and a labelled tmpfs
  container, so these clusters were not used.
- Consequence: no migrated database, no backend process, no real login, no real
  workflow data, no real authorization checks.

To unblock: sign in to Docker Desktop (interactive, owner-performed), then the disposable
target can be provisioned per `docs/testing/disposable-postgres.md` and the backend
browser acceptance can be run.

## Test results

Status legend: PASS = executed and observed; FAIL = executed and failed; BLOCKED = could
not be executed (reason given); NOT RUN = not executed for another reason.

| Test | Scenario | Status | Evidence |
|---|---|---|---|
| TEST-01 | Admin login through the real backend, navigate to the queue, data from the backend | **BLOCKED** | Needs backend and PostgreSQL. UI-01 covers only that the queue renders from a stubbed `/me` and queue response without preview text. |
| TEST-02 | Queue values match PostgreSQL and API responses | **BLOCKED** | No database. UI-02 verifies the rendered values equal the stubbed payload, including the saved-zone overnight time (18:00 - 06:00, Do, 17.12.2026, Europe/Berlin) with the browser in America/Los_Angeles. |
| TEST-03 | Offers with ELIGIBLE / INELIGIBLE / NOT_APPLICABLE, read-only | **PARTIAL** | UI-03 (stubbed data): three states shown as text, open and eligible counts separate, no decision control. Server-side eligibility not verified. |
| TEST-04 | Filters, sorting, pagination, empty page, return to page one, refresh keeps URL state | **PARTIAL** | UI-04, UI-04b (stubbed responses): the browser sends the documented parameters (`offerPresence`, `type`, `projectId`, `monthStart`, `sortBy`, `sortOrder`, `page`), page-count and next/previous work, empty page is handled, refresh restores filters from the URL. Server-side query semantics not verified. |
| TEST-05 | Case changes while open; refresh shows the authoritative state; closed case not pending | **PARTIAL** | UI-05 (stub changes the state): after "Ansicht aktualisieren" the closed-case note appears, after "Liste aktualisieren" the case is gone. The real workflow change (withdrawal through the backend) was not run. |
| TEST-06 | Security and tenant isolation (EMPLOYEE denied, cross-company, anonymous, hidden IDs, logout, expired/revoked session, account switch) | **BLOCKED / NOT RUN** | Requires backend. UI-06 only checks client gating and malformed-ID handling in the browser; it is not evidence for server authorization. |
| TEST-07 | Failure recovery: network interruption and retry, 401, 403, 404, invalid response, invalid timestamp, empty response, page beyond last page | **PASS** (injected faults) | UI-07a network abort then retry; UI-07b 401 leads to the sign-in form, 403 shows "Kein Zugriff" with exactly one request; UI-07c hidden project 404 and unknown case 404 show neutral messages; UI-07d invalid shape and `2026-13-01` both show the invalid-response message with no uncaught page error; UI-07e empty company and project-list retry; UI-07f page past the end keeps the status filter. |
| TEST-08 | UX: navigation, keyboard focus, loading/empty states, responsive layout, German labels, time formatting, console | **PASS** (partial scope) | UI-08a: Tab reaches the open link with a visible focus outline; at 390 px there is no horizontal page overflow and mobile cells are labelled; UI-08b: zero uncaught page errors. Screenshots: `docs/reviews/sp19-evidence/`. Only desktop Chrome and emulated mobile were run; no other browsers or devices. |

Stub harness: 15 of 15 checks passed in the final run (`ui-stub-report.json`). Console
resource errors: 6, all from the injected faults. These checks are **not** acceptance tests.

## Findings fixed in this round

| ID | Severity | Root cause | Fix | Regression coverage |
|---|---|---|---|---|
| B-01 | High | A 403 called session revalidation. The new identity object remounted the page, which requested again and got another 403: an endless request loop (about 2,400 console errors in the first browser run). | The work-queue data path no longer triggers revalidation. A 403 shows "Kein Zugriff" once. 401 remains with the session boundary. | Unit test "shows forbidden access once, without a request loop"; UI-07b asserts exactly one queue request after 403. |
| P2-01 | Medium | `millis()` called `toISOString()` after a pattern check. An impossible date such as month 13 or hour 25 threw `RangeError` instead of the `invalid-response` path. Confirmed with Node: `RangeError: Invalid time value`. | `Date.parse` is checked before `toISOString()`. February 30 rolls over and is rejected by the round-trip check. | Unit tests for impossible instants in queue rows, the evaluation time, offers and the case context; UI-07d in the browser. |
| P2-02 | Medium (UX) | An empty offer page, and a status filter without matches, both showed "Noch keine Ersatzangebote". | Three distinct states: no offers at all; a status without matches (offers "Alle Angebote anzeigen"); a page past the end (keeps the status, "Zur ersten Seite"). | Unit tests for the page-past-end and status-without-matches states; UI-07f. |
| P3 | Low | When the project list failed, the filter was disabled with no recovery. | "Projektliste erneut laden" retry; a URL-selected project stays visible in the disabled selector. | Unit test for retry and recovery; UI-07e. |
| L-01 | Medium (layout) | At 1440 px the "Vorgang öffnen" column was clipped behind a horizontal scroll, hiding the main action. Found by reviewing the desktop screenshot. | The link moved into the employee cell; cell padding reduced. | Existing link tests; screenshot `UI-01-queue-desktop.png` after the fix. No automated desktop overflow assertion was added. |

Harness corrections (test tooling, not product code): a static-server header bug, a
strict-mode text match, and a radio check that read the state before the router finished
navigating. These were fixed in the harness; the product was not changed for them.

## Observations not fixed here

- `OpenDutiesPage` (existing, outside this PR) uses the same session-revalidation pattern
  on 403 as the work queue did. It may show the same request loop. Recommended as a
  separate follow-up; not changed in this PR.
- Filter radio buttons update after React Router navigation settles, not instantly. This is
  not a functional defect; automated checks must wait for the settled state.

## Automated checks on the reviewed commit

| Command | Result |
|---|---|
| `npm run lint` (root) | exit 0 |
| `npm run typecheck` (backend, incl. tests) | exit 0 |
| `npm run test --workspace=frontend` | 78 files, 1390 tests passed |
| `npm run build --workspace=frontend` (`tsc -b` + vite) | exit 0; chunk-size warning pre-existing |
| `npm test` (backend unit) | 42 files, 480 tests passed |
| `npm run check:public` | passed |
| Backend E2E, real-PostgreSQL tests (`npm run test:e2e`, `test:scripts`) | **NOT RUN**: no disposable PostgreSQL 17 target (Blocker) |

## Remaining risks

Not executed: the backend-backed browser acceptance (TEST-01, TEST-02, TEST-06, and the
server side of TEST-03 to TEST-05), the server authorization of the queue endpoints, the
PostgreSQL query results compared with the UI, and browsers other than desktop Chrome.

Known product risks (unchanged): offers-page and project-list states rely on
hand-written invariants checked by the parsers; a contract change fails closed as
`invalid-response`. The `docs/api/README.md` still labels SP19-P1 as a proposal for review.

## Merge recommendation

**BLOCKED — INSUFFICIENT ACCEPTANCE EVIDENCE.**

The frontend fixes are verified and the automated checks are green. The required
backend and real PostgreSQL acceptance (TEST-01, TEST-02, TEST-06 and the server side of
TEST-03 to TEST-05) has not been run. A green CI run alone is not sufficient.
