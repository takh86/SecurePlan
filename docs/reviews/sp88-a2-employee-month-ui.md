# #88 A2 employee-month Save — frontend integration preparation

Date: 2026-11-03. Branch `agent/claude/sp88-a2-employee-month-ui`, started from `origin/main`
`eca4b3d` (after #92, #93, #96) and rebased (unpushed) onto `fc7ec3b`, the merge of backend PR
[#95](https://github.com/takh86/SecurePlan/pull/95) that landed during this work. Tracking:
[#88](https://github.com/takh86/SecurePlan/issues/88). Contract: **A2-GATE-1**, adopted 2026-11-03
([owner decision](https://github.com/takh86/SecurePlan/issues/88#issuecomment-6600906336)),
`docs/api/employee-month-save.md` and `docs/api/employee-month-save.openapi.json`. Reviewed at
#95 head `c147e58`; the merged head `e9fd9a0` changes no backend source, migration or contract
file (only a merge of main, an E2E test and a First Publish test-timing fix).

**Status:** frontend preparation only, as scoped. The A2 routes are now on `main`, but the
production page still does **not** create the A2 client: "Monat einer Person planen" stays the
labelled preview and sends no write. Everything below the page is implemented against the
frozen contract and tested with a model of the three routes; it is enabled by one wiring change
(see "Enablement"), which should land together with the combined browser acceptance. No backend,
database, migration, dependency, CI or `.env` change. Not an acceptance claim: mocked UI tests
do not establish browser end-to-end completion.

## 1. Migration of Draft PR #91 onto current main

PR #91 (`agent/claude/sp88-employee-month-ux`, head `ef1a480`) is stacked on the #87 branch
(`662985e`). #87 was squash-merged as `0e8e912`; `git diff 662985e 0e8e912 -- apps/frontend` is
empty, so the net #91 change applies to main unchanged except where #93/#96 touched the same
files.

| Step | Result |
|---|---|
| Port | One commit with the net diff `662985e..ef1a480` (5 commits listed in its message) instead of replaying 5 commits whose rev 2 rewrote rev 1 |
| Conflicts | Only `MonthlyPlanPage.tsx` (main's SP-13 `StatusProps = PublishSlotProps & …` kept, `PersonMonthView` inserted before it). `MonthlyPlanning.css`: main's SP-13 rules kept, the planner block appended unchanged |
| Verification | Per file, the added/removed lines of the port equal the #91 net diff (8 files identical; CSS additions identical); typecheck 0; planning suite 16 files / 345 tests PASS before any A2 change |
| Old PR | Branch, commits, review comments and evidence of #91 are untouched; #91 stays open as the reviewed record of the preview |

## 2. Contract review (A2-GATE-1, as implemented in #95)

| Topic | Contract | Frontend consequence |
|---|---|---|
| Read | `GET …/employee-months/{employeeId}`: one REPEATABLE READ projection; every date; both slots with exact `dutyId`/`version` (also empty duties and duties staffed only by others); only the selected employee's assignment; lifecycle; `creationContextFingerprint`; effective calendar or MISSING; neutral `unavailableDates`; `currentState`, `operatingState`, `violations` | Strict decoder; derived facts must agree with slots and calendar, otherwise "malformed answer". The draft is built from this read only (`monthBaseFromRead`) |
| Request | Complete month (28–31 dates), `expected.day/night` per date, one `desired` OFF / DAY+role / NIGHT+role, `expectedPlan`, `expectedCreationContext`, `expectedCalendar`; unknown fields rejected | `buildSaveBody` sends every date (OFF included) from the read the draft is on; never other people, assignment IDs, sources, times or tenant data |
| Preconditions | All 2N slot tokens, lifecycle and calendar on **every** save; checksum only when a duty is created | Any change between read and save is a PRECONDITION refusal; the draft is kept and moved onto the fresh read |
| Idempotency | Required key (8–128 visible ASCII), same actor/company/operation; same key + same body replays the immutable receipt; different body 409 KEY_REUSED; running 409 IN_PROGRESS | One key per decision (`crypto.randomUUID`); the key and the frozen body are reused only for an explicitly confirmed resend after NOT_COMPLETED |
| Result lookup | `GET …/save-result` with the key: COMPLETED (receipt), IN_PROGRESS, NOT_COMPLETED (fenced failure), UNKNOWN (absent/expired, **not** proof of failure); contended key 409 IN_PROGRESS | Lookup precedes any reconciliation; the receipt is checked against the frozen body |
| Conflict extension | 409 `{atomic, stage: LEASE / PRECONDITION / VALIDATION, conflicts[{date, shiftKind, reason}]}`, ≤ 62, sorted, frozen reason enum; PRECONDITION uses PLAN_CONCURRENT_MODIFICATION | `ApiError.employeeMonthConflict`, parsed only for these two codes, rejected as a unit when malformed; neutral German text per reason |
| Domain | Only effectively changed duties are validated; removals need no open date; MISSING/closed allow genuine no-op or reduction; INACTIVE blocks every change; new kind defaults EMPLOYEE, retained kind keeps SHIFT_LEAD; others' memberships preserved; CR-03 PUBLISHED saves apply directly | See section 3 (closed days changed from #91) |
| Headers | All three routes `no-store` (filter in #95) | Nothing cached client-side; the session transport already uses `cache: 'no-store'` |

Observations for the reviewers (no contract change requested here):

1. `unavailableDates` covers every date, not only scheduled ones; the planner shows the neutral
   "!" hint on such dates as a planning aid (no reason, no status).
2. The read does not say whether shift times exist for the month; SHIFT_CONFIGURATION_MISSING
   is therefore only learnt from a refused save (neutral dated text). Per #95's combined review
   this also applies to a pure removal (SP-12 compatibility); only a true NO_OP skips it.
3. The read does not list other members (by design). The planner shows them only from the page's
   duty read **and only if that read has the same duty version**; otherwise it says "weitere
   eingeplante Personen bleiben unverändert" without names (two reads of different times are
   never combined into one statement).
4. The controller sets `Retry-After` only on POST; a contended lookup returns 409 IN_PROGRESS
   without it. The UI treats both as "Speichern läuft noch" with a manual "Ergebnis erneut
   abfragen" (no automatic polling).
5. Slot instants are second precision, `completedAt` has microseconds; the decoder accepts 0–6
   fraction digits for both. Checked against the merged mapper and service: `to_char(… "Z")` for
   duty/publication instants, `.US` for `completedAt`; a created duty is returned at version 1,
   a changed duty incremented once, a removal with `assignment: null`.
6. After logout the lookup answers 401 and after a role change 403 (#95 combined review); the UI
   classifies them as signed-out and terminal. Another actor's lookup of the same raw key is
   UNKNOWN, which the UI treats as "not provable", never as failure.

## 3. Frontend design

Files (all under `apps/frontend/src`):

| File | Content |
|---|---|
| `features/planning/monthly-plans/employee-month-api.ts` | Typed client of the three routes; strict decoders `toEmployeeMonthRead`, `toSaveResult` (route, lifecycle as expected, counts, order, created duty version 1, changed duty version above the expected one, the employee's membership per changed slot exactly as requested, NO_OP ⇔ no changes), `toSaveResultLookup` |
| `features/planning/monthly-plans/employee-month-save.ts` | `buildSaveBody`, frozen `SaveAttempt` (route, key, body), `classifySaveError`, `classifyLookupError`, texts, `readDrift` (publication, calendar, creation basis, availability changed between reads) |
| `features/planning/monthly-plans/employee-month-draft.ts` | #91 draft model plus `monthBaseFromRead`, `calendarOfRead`, MISSING calendar, `isNewWork`, `keptOnBlockedDay`, `draftBlock`, `othersFromDuties`; issue reasons = frozen A2 enum; the abstract `EmployeeMonthSave` seam of #91 is removed |
| `features/planning/monthly-plans/EmployeeMonthPlanner.tsx` | Source-agnostic planner (`base` prop) with the save/lookup state machine below |
| `features/planning/monthly-plans/EmployeeMonthWorkspace.tsx` | `EmployeeMonthWorkspace` (loads the A2 read, keeps the planner on screen during re-reads) and `EmployeeMonthPreview` (unchanged #91 behaviour) |
| `features/planning/monthly-plans/MonthlyPlanPage.tsx` | Optional `PlanPageApis.employeeMonths`; without it the preview, with it the workspace; "Vorschau" badges follow it |
| `shared/api/api-error.ts` | Known code `EMPLOYEE_MONTH_SAVE_CONFLICT` (409) and the allowlisted extension |

Save states (the draft is never dropped; "locked" = dates and roles cannot be edited):

| Phase | Entered by | UI | Save | Leave prompt |
|---|---|---|---|---|
| editing | read, re-read | – | allowed if the draft has changes, no undecided conflict, no correction | dirty if changes |
| saving | "Monat speichern" | button "Monat wird gespeichert …", locked | blocked | saving |
| refused | 409 stage / 400 / 413 / 415 / other 409 | alert with stage title, "Es wurde nichts gespeichert; Ihre Auswahl ist erhalten.", dated findings | PRECONDITION and request errors: after a re-read; LEASE/VALIDATION: new attempt with a new key | dirty |
| unknown | network, unreadable/invalid answer, 5xx, 429, 409 IN_PROGRESS | alert "Ergebnis unbekannt", button "Ergebnis abfragen", locked, re-read disabled | blocked | dirty |
| checking | "Ergebnis abfragen" | button busy, locked | blocked | saving |
| running | lookup IN_PROGRESS / contended | "Speichern läuft noch", "Ergebnis erneut abfragen" | blocked | dirty |
| not-completed | lookup NOT_COMPLETED | "Unverändert erneut speichern" (same key and body) or "Aktuellen Stand laden und Auswahl prüfen" | blocked | dirty |
| unresolved | lookup UNKNOWN | "Ergebnis nicht feststellbar", only reconciliation by re-read; the next save is a new decision with a new key | blocked | dirty |
| verifying | receipt (fresh, replayed or from the lookup), or reconciliation | status with counts; locked until the re-read lands; a failed re-read asks to load again | blocked | clean after a receipt |
| terminal | 404 / 403 | "Monat nicht mehr verfügbar" / "Aktion nicht erlaubt"; selection visible | blocked | dirty if changes |

401 is left to the session boundary (login in place); see the gaps below.

Behaviour that is preserved or intentionally changed:

- **Unsaved input:** kept through every refusal, unknown outcome, lookup, re-read (rebase with
  per-date conflicts and "Meine Auswahl behalten" / "Aktuellen Stand übernehmen"), and guarded by
  the page's single navigation blocker and person/view switches (#91 wiring) and, new here, a
  `beforeunload` prompt while the planner is not clean. An unresolved outcome counts as unsaved.
- **SHIFT_LEAD:** a stored role is sent unchanged for untouched dates and kept when the same kind
  is painted again; a new kind starts as Mitarbeitende (contract); role changes are explicit in
  the day panel. Tested at body level.
- **Other employees:** never part of the request; shown as unchanged context only; their
  problems arrive as the neutral PRESERVED_ROSTER_CONFLICT.
- **CR-03:** a PUBLISHED plan is saved with its publication instant as precondition and applies
  directly; the planner says so; a publication between read and save is a PRECONDITION refusal
  and the re-read says "Der Plan wurde inzwischen veröffentlicht".
- **Changed from #91 (contract alignment):** a stored duty on a closed weekday is **no longer a
  correction that blocks the save**. The server validates only effectively changed duties, so the
  UI keeps such a duty, explains it ("Bestehender Dienst … bleibt unverändert, bis Sie den Tag auf
  Frei setzen") and offers Frei; new or changed work on a closed date (or any date with a MISSING
  calendar) is not offered, and a pending one that a newer calendar closes blocks the save.
  A wanted shift without a duty now reads "Dienst wird beim Speichern angelegt" (P2 settled).

## 4. Evidence (executed on this branch)

| Check | Result |
|---|---|
| `npm run lint` | exit 0; frontend `Found 0 warnings and 0 errors` |
| `npm run typecheck` (backend) | exit 0 |
| `npm run build` | exit 0 (existing bundle-size advisory only) |
| `npm run test --workspace=frontend` | 63 files / 1045 tests PASS |
| `npm test` (backend unit, unchanged code) | 36 files / 385 tests PASS |
| `npm run check:public` | PASS |
| New suites | `employee-month-api.test.ts`, `employee-month-save.test.ts`, `api-error-employee-month.test.ts`, `EmployeeMonthPlanner.a2.test.tsx`, `MonthlyPlanPage.employee-month-a2.test.tsx`; #91 suites adapted |

The component tests run through the real adapter and decoders against an in-memory model of the
three routes (`employee-month.test-support.ts`): preconditions, lease admission, idempotency
records (replay, key reuse, FAILED → NOT_COMPLETED), the selected employee's delta and scripted
eligibility outcomes. That model is a test simplification, not the #95 implementation.

**NOT_RUN** (with reason):

- Real Chrome → React → NestJS → PostgreSQL acceptance of the combined A2 flow: #95 is merged
  (`fc7ec3b`), but the production wiring is intentionally not in this preparation PR; the run
  belongs to the enablement step below.
- Backend E2E suites: no backend change on this branch; #95 reports its own evidence.
- `test:scripts`: no script change.
- Human screen-reader, keyboard-only, cross-browser and real-device checks; security review.
- Exact-head CI of the Draft PR: to be checked after the push.

## 5. Remaining gates and gaps

1. **Enablement and browser acceptance** (now unblocked: #95 merged as `fc7ec3b`; its release
   gates such as capacity/retention and human security stay with #95).
2. **Principal-bound hidden draft across 401 / re-login** (contract: keep drafts in actor/company/
   resource-bound memory; another login must neither see nor submit them). **Not implemented:**
   a 401 shows the login in place and the planner's in-memory draft is lost, as for every other
   form today. It touches the session boundary (`LoginScreen`/`SessionRoot`) and is left as a
   separate, reviewable change.
3. Tab destruction loses the draft (stated limit; no `localStorage` by design).
4. No automatic lookup polling for IN_PROGRESS (manual re-query only).
5. Browser acceptance after #95, at least: complete month save; replay after a lost answer with no
   second commit; NOT_COMPLETED resend; UNKNOWN reconciliation; PRECONDITION after another admin's
   duty edit and after First Publish; LEASE while the SP-12 editor holds a lease; VALIDATION
   (unavailable, closed weekday, MISSING calendar); INVALID_DUAL correction; CR-03 on a really
   published plan (no SQL shortcut); 390 px layout; console categories; `no-store` on all three
   routes; tenant/role/CSRF (404/403).
6. Human UX/accessibility and security acceptance; TL review.

## 6. Enablement (#95 is merged)

1. Merge current `main` into this branch if it moved (no force-push once pushed).
2. In `MonthlyPlanningSection.tsx` add `employeeMonths: createEmployeeMonthApi(api)` to `apis`.
   The page then shows the workspace instead of the preview; the "Vorschau" badges disappear.
3. Re-run lint, typecheck, build, frontend tests and the combined browser acceptance above on a
   verified disposable PostgreSQL with all migrations including 0015.
