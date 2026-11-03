# A1 (#92) + SP-13 First Publish UI (#93): combined integration evidence

Date: 2026-11-03. Plan: [`sp13-a1-integration-plan.md`](sp13-a1-integration-plan.md). Refs #28,
#29, #90. Draft PR #93; no merge, deployment, issue closure or existing-database change is part
of this work.

## Integrated tree

| Item | Value |
|---|---|
| `origin/main` (A1 #92 merged) | `7d4b2a8` |
| #93 before integration | `1166990` |
| Merge into the #93 branch | `1f2a7d2` (no conflicts; no file changed on both sides) |
| F-A1-1 + harnesses (code head of the runs below) | `b6ce3c4` |
| Pre-A1 binary for I7 | export of `0e8e912` (main before A1), backend built from that export; the I7 harness proves it has 13 byte-identical migrations, no 0014 and no calendar module |

The versionless publish contract is unchanged: no version or fingerprint precondition was added
(see `sp13-react-publish-ui.md`, "Versionless publish").

## F-A1-1 (implemented)

`shared/api/api-error.ts` trusts `PROJECT_CALENDAR_MISSING`, `PROJECT_CLOSED_WEEKDAY` and
`EMPLOYEE_DAILY_SHIFT_CONFLICT` only as 409. `planning-errors.ts` has German texts for each code in
three flows:

| Flow | Outcome sentence |
|---|---|
| Duty creation | „Es wurde nichts gespeichert.“ |
| Duty edit | „Es wurde nichts geändert.“ |
| First Publish | „Der Plan wurde nicht veröffentlicht.“ |

The texts name no person, duty, date or reason. The missing-calendar texts say that no page to set
operating days exists in this release. Edit texts keep removal ("Austragen und Löschen") as the
correction path. For night duties, the start date decides. The calendar-write codes
(`PROJECT_CALENDAR_INVALID/_CONCURRENT_MODIFICATION/_DEPENDENCY_CONFLICT`) stay untrusted until a
calendar UI exists. Tests cover:

- the catalogue status;
- every text and its privacy;
- the create form, the editor and the publish dialog (jsdom).

The browser runs below show the texts against the real server.

## Gates (local, Windows, Node 24.21.0, tree `b6ce3c4`)

| Gate | Result |
|---|---|
| `npm run lint` | passed; oxlint 0 warnings / 0 errors in both workspaces |
| `npm run typecheck` | passed |
| `npm run build` (both apps) | passed (pre-existing Vite chunk-size notice) |
| `npm test` (backend unit) | 36 files / 385 tests passed |
| `npm run test --workspace=frontend` | 52 files / 820 tests passed (804 before F-A1-1) |
| `npm run test:e2e -- --maxWorkers=4 --testTimeout=15000` (full backend HTTP/PostgreSQL) | **51 files / 1311 tests passed** (includes the A1 suites `operating-calendar-real` and `legacy-calendar-bootstrap-real`) |
| Script tests `check-public`, `reissue-employee-activation`, `disposable-test-target`, `migration-safety` | 21 / 21 passed (`node --test`, same verified target) |
| `scripts/activation-demo.test.mjs` | NOT_RUN locally (its guard accepts only the development DB); CI runs it |
| `npm run check:public`, `git diff --check`, `node --check` of both harnesses | passed |

Every database run used a **fresh labelled tmpfs `postgres:17`** on a loopback-only port. Each had
its own run ID, its receipt recorded and re-verified, and was removed after its ID and label were
re-checked. The development database was not touched.

| Run | Target (run ID) | Migrations |
|---|---|---|
| Full E2E + script tests | `sp13-a1-e2e-20261103102119` | 14 applied, replay 0, `verify-db` passed (incl. the A1 calendar relation) |
| Integrated browser run (main) | `sp13-a1-clean-20261103102444` | 14 applied, replay 0 (14 already applied), `verify-db` passed |
| Legacy browser run (I7) | `sp13-a1-legacyfinal-20261103102529` | empty target; pre-A1 migrator 13, then integrated migrator 0014 only, replay 0, `verify-db` passed |

Earlier trial runs on other fresh targets also passed: main 34/34, legacy 15/15. A first final
main run passed 34/34 but recorded `sourceDirty` because a documentation file was modified. It was
repeated on a new target with a clean tracked tree; only the clean runs are reported.

## Real-browser runs

Chrome 156.0.8078.80 (installed channel, headless, normal certificate validation), external pinned
Playwright 1.64.1, de-DE, Europe/Berlin. The stack is the built React app over local HTTPS → the
unmodified integrated NestJS → PostgreSQL. Calendars are configured **only** through the
authenticated admin API from inside the logged-in page (GET, then PATCH with CSRF and the read's
exact/effective/next preconditions). No calendar, publication or audit row is written by SQL, and
no default weekday set is seeded. Example sets are synthetic: Tuesday–Saturday `[2,3,4,5,6]` for
the main run; Wednesday+Sunday `[3,7]` and Monday–Friday `[1..5]` for I7.

| Harness | Groups | Tree | Console errors (categories only) | Page errors | Fixture cleanup |
|---|---|---|---|---|---|
| `scripts/sp13-publish-browser-acceptance.mjs` | **34 / 34 PASS**: `A1-0`, P01–P15, `A1-I1a` … `A1-T` | `b6ce3c4`, tracked tree clean (recorded by the harness) | 28, all from deliberate failures: `http-401` ×3 (session checks before login, 3 contexts), `ERR_CONTENT_LENGTH_MISMATCH` ×2 (P06/P07), `http-502` ×2 (P07/P08), `http-409` ×15 (P10, P11, P13 and the A1 refusals), `http-404` ×4 (P14, I8), `http-403` ×2 (I8); `other` 0 (asserted) | 0 | PASS |
| `scripts/sp13-a1-legacy-browser-acceptance.mjs` | **15 / 15 PASS**: `L0`–`L3`, `I7a-1` … `I7-T` | `b6ce3c4`, tracked tree clean (checked before the run) | 8: `http-401` ×1, `http-409` ×5, `http-400` ×2, all deliberate; `other` 0 (asserted) | 0 | PASS |

Calendar writes of the main run (outcome per write): 8 regression projects APPLIED; Kalender
APPLIED, 409 stale, NO_OP, 409 dependency; Süd January APPLIED. That gives 10 APPLIED writes,
10 calendar audits and 10 calendar rows. Screenshots and result JSON stay private evidence outside
Git; the JSON holds codes, outcomes and counts, never keys, tokens or IDs of the inventory.

## Results per case

| ID | Result | Executed as |
|---|---|---|
| I0 | **PASS** | `A1-0`: every regression project reads MISSING and is then configured through the API before any duty exists. P01–P15 (the full SP-13 regression) then pass unchanged on 0014 |
| I1a | **PASS** | `A1-I1a`: GET 200 `MISSING`, no effective/exact version, `no-store`, no row |
| I1b | **PASS** | `A1-I1b`: UI create → 409 `PROJECT_CALENDAR_MISSING`; „Keine Betriebstage festgelegt … Es wurde nichts gespeichert.“; date and selection kept; no row |
| I1c | **PASS** | `A1-I1c`: empty plan → dialog → 409 `PROJECT_CALENDAR_MISSING`; German alert „… Der Plan wurde nicht veröffentlicht.“; UNPUBLISHED; no audit; the refused key's reservation is `FAILED`, not COMPLETED |
| I1d | **PASS** | `A1-I1d`: PATCH → 200 `APPLIED`, `CONFIGURED`, version 1; one `PROJECT_OPERATING_CALENDAR_UPDATED` audit with exactly `{effectiveFromMonth, operatingWeekdays, version}` |
| I1e | **PASS** | `A1-I1e`: stale preconditions → 409 `PROJECT_CALENDAR_CONCURRENT_MODIFICATION`; fresh same set → 200 `NO_OP`; neither audited |
| I2a | **PASS** | `A1-I2a`: the input kept from I1b is saved after configuration: DAY on Tuesday 8 Dec → 201 |
| I2b | **PASS** | `A1-I2b`: NIGHT starting Saturday 12 Dec (ending on a closed Sunday) → 201 |
| I3a | **PASS** | `A1-I3a/I3b`: DAY on Monday 7 Dec → 409 `PROJECT_CLOSED_WEEKDAY`; „Kein Betriebstag … Es wurde nichts gespeichert.“ |
| I3b | **PASS** | same group: NIGHT starting Sunday 13 Dec → 409 `PROJECT_CLOSED_WEEKDAY`; no row added |
| I3c | **PASS** | `A1-I3c`: editor (lease held) moves the duty to Monday 14 Dec → 409; „… Es wurde nichts geändert.“; input and lease kept; duty row unchanged |
| I3d | **PASS** | `A1-I3d`: PATCH closing Tuesday while 8 Dec is occupied → 409 `PROJECT_CALENDAR_DEPENDENCY_CONFLICT`; version unchanged |
| I4a | **PASS** | `A1-I4a/I4b`: DAY 9 Dec with Delta, then NIGHT 9 Dec with Delta → 409 `EMPLOYEE_DAILY_SHIFT_CONFLICT` (adjacent 06–18/18–06, no UTC overlap) |
| I4b | **PASS** | same group, mirrored order on 10 Dec with Echo → 409 |
| I4c | **PASS** | `A1-I4c`: an unstaffed NIGHT 9 Dec is allowed; adding Delta through the editor → 409; „… Es wurde nichts geändert.“; lease kept; rows unchanged |
| I4d | **NOT_RUN** | Unreachable by the schema: `uq_project_assignments__employee_month` (0008) allows one project per employee and month, so one person cannot be planned in two projects in the same month and the boundary cannot be set up |
| I5a | **PASS** | `A1-I5a`: summary „5 (davon 1 ohne Besetzung)“; double click → exactly one POST (0 body bytes, no Content-Type, CSRF, same Origin, no Expected-Version) with a new key; 200 `Idempotency-Replayed: false`; PUBLISHED by this admin; one audit; one COMPLETED reservation whose hash = SHA-256 of the browser key. P04 shows the same on another project |
| I5b | **PASS** | P06 and P08 publish empty plans on configured projects, and I7i on a bootstrapped one |
| I5c | **PASS** | `A1-I5c`: after publication, adding Echo applies directly (CR-03); moving the duty to a closed Monday → 409; `published_at` unchanged; no second publish or audit |
| I6a | **PASS** | P06 on 0014: answer truncated after commit, GET confirms PUBLISHED, one audit |
| I6b | **PASS** | P07 on 0014: truncation + failed check read → same-key resend → 200 `Idempotency-Replayed: true`; one audit, one reservation |
| I6c | **PASS** | `A1-I6c` (stronger than planned): after a later calendar version (January) and **project deactivation**, the same key replays via the API → 200 `Idempotency-Replayed: true`, PUBLISHED, bodyless; still one audit and one reservation |
| I6d | **PASS** | `A1-I6d`: that key against another (unpublished) plan → 409 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST`; nothing published |
| I6e | **PASS** | `A1-T`: calendar audits = APPLIED writes; the refusals and the NO_OP are not audited; calendar rows = APPLIED writes, so nothing else wrote calendars |
| I7a | **PASS** | `L0`–`L3`, `I7a-1/2` (real binaries): the pre-A1 migrator applies 0001–0013. The pre-A1 backend creates the legacy data over HTTP: two plans in which one person holds DAY+NIGHT on one date, a Sunday duty, a **pre-A1 publication** and an empty plan of a second project. The old backend is drained (stopped, port closed). The integrated migrator then applies only 0014; replay applies nothing; `verify-db` passes. Plans, duties, memberships, audit and reservations are byte-identical before and after; zero calendars. The integrated UI shows every legacy duty |
| I7b | **PASS** | `scan-project-calendars.mjs`: MISSING 3 (Dec) / 2 (Jan); DUAL_ASSIGNMENT 1 / 1; empty project listed (0 versions, no live duty, missing Dec); nothing changed |
| I7c | **PASS** | legacy publish → 409 `PROJECT_CALENDAR_MISSING`, German alert, UNPUBLISHED |
| I7d | **PASS** | bootstrap at January → 400 `PROJECT_CALENDAR_INVALID`; `[3]` not covering the Sunday duty → 409 `PROJECT_CALENDAR_DEPENDENCY_CONFLICT`; `[3,7]` at the earliest live-duty month → APPLIED, audit carries `bootstrap: true`; a second bootstrap → 400; no row deleted |
| I7e | **PASS** | publish → 409 `EMPLOYEE_DAILY_SHIFT_CONFLICT`, German alert |
| I7f | **PASS** | editor: pure removal of the person from the NIGHT duty → 200, despite the legacy pair |
| I7g | **PASS** | publish → 200 PUBLISHED, one audit |
| I7h | **PASS** | the plan published before A1: a role change of the dual member → 409 `EMPLOYEE_DAILY_SHIFT_CONFLICT` („… Es wurde nichts geändert.“); pure removal → 200 (CR-03). Status and `published_at` unchanged; only the pre-A1 publish audit exists |
| I7i | **PASS** | project without live duties: publish → 409 MISSING; bootstrap at the company-local current month → APPLIED; publish → 200 |
| I8 | **PASS** | `A1-I8`: foreign project calendar GET and PATCH → 404 (concealed); EMPLOYEE GET and PATCH → 403; no foreign calendar row; foreign plans unchanged. P14: foreign plan „Nicht gefunden“, no publish action |

Deviations from the plan, all recorded above:

- I7a legacy data came from the pre-A1 backend's **HTTP API**, not its UI; that build has no publish UI.
- I6c used a later calendar version plus project deactivation instead of an eligibility change.
- I7h ran the role change before the removal.

## NOT_RUN and open items

- **I4d:** unreachable by the schema (above).
- Screen readers, Firefox/Safari, real mobile devices. Browser `IDEMPOTENCY_REQUEST_IN_PROGRESS`, a
  session loss during publish, and Chrome's forced dialog close during a request are covered in
  jsdom only.
- Concurrent calendar-writer vs duty-writer timing was not run in the browser. The backend E2E
  (`operating-calendar-real`) covers the observed lock ordering in both orders.
- **Existing development database:** no rollout, inventory or bootstrap was performed and none is
  authorized. The runbook's backup, writer drain and inventory steps remain prerequisites.
- Calendar admin UI (F-A1-2) does not exist. Configuration happens through the admin API (runbook).
- Product decision still open: versionless First Publish publishes the latest server-valid state
  at commit, not a guaranteed reviewed snapshot.
- Staging/production stay blocked by the #51 operational/security gates, dependency findings,
  privileged-SQL controls and human security/UX acceptance.
