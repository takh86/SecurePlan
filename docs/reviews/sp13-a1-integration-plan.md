# A1 (#92) + SP-13 First Publish UI (#93): combined integration test plan

Date: 2026-11-03. Status: **executed** on the integrated tree (A1 #92 merged as `7d4b2a8`,
merged into #93). The per-case results, deviations from this plan and NOT_RUN items are in
[`sp13-a1-integration-evidence.md`](sp13-a1-integration-evidence.md). This file stays the plan
as written before the run; §4 F-A1-1 has since been implemented.

Inputs: Draft PR #92 (A1 operating calendar and cross-writer guards, reviewed head `512b4d3`,
current head `9e2f5fb` with the development runbook `docs/development-a1-rollout.md`), Draft PR
#93 (First Publish dialog, `7ef1fae`), `main@0e8e912`. Refs #90, #28, #29.

## 1. Order and target

1. The independent review of #92 is settled, and the owner decides on the development rollout
   path. Without a calendar admin UI, configuration is the manual admin API path of the runbook.
2. Build a **local, unpushed** integration tree: `main` + #92 head + #93 head. Once #92 is merged,
   use `main` with A1 + #93 rebased instead. Record all three SHAs and the merge result; a conflict
   stops the run.
3. Use a fresh labelled tmpfs `postgres:17` per `docs/testing/disposable-postgres.md`. Record the
   receipt and re-verify it before migrating. Apply 0001–0014; a second run applies none.
   `verify-db.mjs` must pass, including the calendar relation. Never use the development DB.
4. Gates on the integrated tree: `npm ci` (lockfile unchanged), lint, typecheck, build, frontend
   tests, backend unit, `test:e2e` on the same receipt, and the publish-UI harness (§3, I0).
5. Build both apps from the integrated tree. The backend runs against the verified
   `DATABASE_URL` only. Chrome uses the installed channel with external pinned Playwright and
   normal certificate validation, plus a proxy that only observes or injects faults, as in the
   SP-13 harness.

Fixture boundary, as in SP-13: only **prerequisites** are inserted directly (synthetic
companies, two COMPANY_ADMINs, employees, projects, month assignments, shift times). **Calendars
are configured only through the A1 admin API.** Duties, edits, removals and publications are made
only through the UI or the API under test. No calendar, publication or audit row is written by
SQL. All weekday sets below are synthetic examples, not business rules.

Example month: M = `2026-12-01` (a future month when written; on the run date it must be current
or future in the company's time zone). December 2026 starts on a Tuesday. Example policy P =
Tuesday–Saturday `[2,3,4,5,6]`.

## 2. Cases

Each case records: request statuses and codes (proxy or harness), the UI text shown, and the DB
read-back (rows, versions, audit, idempotency reservations). The "UI today" column describes #93
as it is now. §4 lists the frontend follow-up that would change it.

| ID | Case | Steps | Expected server / DB | UI today (#93 `7ef1fae`) |
|---|---|---|---|---|
| I0 | Regression | SP-13 harness P01–P15 on the integrated tree, after configuring every harness project's calendar for M through the API (harness change needed: a calendar setup step) | All 15 groups pass unchanged | As in the SP-13 evidence |
| I1a | Calendar missing: no default | GET `/api/v1/projects/{id}/operating-calendar?effectiveForMonth=M` for a new project | 200 `state: MISSING`, `effective: null`, `no-store`; no row exists | n/a (no calendar UI) |
| I1b | Missing blocks duty creation | Plan page → create a DAY duty on an open-looking date | 409 `PROJECT_CALENDAR_MISSING`; no duty row; no audit | Generic "Konflikt" alert (code not trusted yet); form input kept; nothing claimed |
| I1c | Missing blocks First Publish, even for an empty plan | Empty plan → dialog → confirm | 409 `PROJECT_CALENDAR_MISSING`; plan UNPUBLISHED; no publish audit; no COMPLETED reservation | Dialog closes; generic "Konflikt" alert; plan, project and duties reloaded; status "Unveröffentlicht"; a later try uses a new key |
| I1d | Explicit configuration | PATCH with `effectiveFromMonth=M`, `operatingWeekdays=P`, `bootstrap=false` and the exact/effective/next values from I1a, with CSRF and Origin | 200 `outcome: APPLIED`, `CONFIGURED`, version 1; one `PROJECT_OPERATING_CALENDAR_UPDATED` audit (bounded values); `no-store` | n/a |
| I1e | Stale precondition | Repeat the I1d PATCH with the same (now stale) preconditions and a different set | 409 `PROJECT_CALENDAR_CONCURRENT_MODIFICATION`; no new version or audit | n/a |
| I2a | Duty on an allowed weekday | UI: DAY duty on Tue `2026-12-08` with an eligible, assigned, available employee | 201; duty and assignment rows; audit | Saved; shown in the matrix |
| I2b | NIGHT across midnight into a closed day | UI: NIGHT duty starting Sat `2026-12-12` (allowed) and ending Sunday (closed) | 201: the local start date decides | Saved |
| I3a | Closed weekday refused | UI: DAY duty on Mon `2026-12-07` | 409 `PROJECT_CLOSED_WEEKDAY`; no row; no audit | Generic "Konflikt" alert; input kept |
| I3b | NIGHT starting on a closed day | UI: NIGHT starting Sun `2026-12-13` | 409 `PROJECT_CLOSED_WEEKDAY` | Generic alert |
| I3c | Edit onto a closed day | Editor (lease held): move the I2a duty to Mon `2026-12-14` | 409 `PROJECT_CLOSED_WEEKDAY`; duty version unchanged; lease kept | Generic alert; editor input kept |
| I3d | Calendar cannot newly close an occupied date | PATCH closing Tuesday from M while the I2a duty exists | 409 `PROJECT_CALENDAR_DEPENDENCY_CONFLICT`; no version change | n/a |
| I4a | Same-date DAY/NIGHT, DAY first | Employee E in a DAY duty on Wed `2026-12-09`; UI: NIGHT duty on the same date with E (UTC intervals adjacent, not overlapping) | 409 `EMPLOYEE_DAILY_SHIFT_CONFLICT`; no row | Generic alert |
| I4b | Same-date DAY/NIGHT, NIGHT first | Mirror of I4a on Thu `2026-12-10` | 409 `EMPLOYEE_DAILY_SHIFT_CONFLICT` | Generic alert |
| I4c | Added through the editor | Add E to an existing NIGHT duty of the date of E's DAY duty | 409 `EMPLOYEE_DAILY_SHIFT_CONFLICT`; duty version unchanged | Generic alert |
| I4d | Scope boundary | E on DAY in project A and NIGHT in project B on the same date, without UTC overlap | Accepted: the A1 rule is per employee, project and local date. Any UTC overlap stays `DUTY_ASSIGNMENT_CONFLICT` | Saved |
| I5a | Successful First Publish | Configured project with the I2 duties: dialog → confirm (double click) | One bodyless POST with key, CSRF and Origin; 200 `Idempotency-Replayed: false`; PUBLISHED by this admin; one `MONTHLY_PLAN_PUBLISHED` audit; one COMPLETED reservation whose hash = SHA-256(browser key) | Success notice focused; status with commit-time and no-employee-view wording; no re-publish |
| I5b | Empty plan on a configured project | Dialog → confirm | 200 PUBLISHED (no invented minimum) | Success |
| I5c | CR-03 after publication | Editor: allowed change on an open weekday; then a change onto a closed weekday | First 200 (same `published_at`, no second publish); second 409 `PROJECT_CLOSED_WEEKDAY` | Applied / generic alert |
| I6a | Lost answer after commit | Proxy truncates the 200 body | GET confirms PUBLISHED; one audit; one reservation | "bestätigt" via the read; no automatic resend |
| I6b | Lost answer + failed check → replay | Truncation, and the check read fails (502); "Erneut anfragen" | Same key; 200 `Idempotency-Replayed: true`; still one audit and one reservation | "erneute Anfrage … bestätigt; doppelt veröffentlicht wurde nicht" |
| I6c | Replay precedes fresh checks | After I6b, make a member of a published duty day-only (no future-duty guard for that field, as in SP-13 P13); replay the same key via the API | 200 replay (contract: a completed replay precedes lifecycle and eligibility checks); session still checked; no second audit | n/a |
| I6d | Key reuse for another plan | API: the I5a key against a different plan | 409 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST` | Mapped text "Vorgang stimmt nicht überein" (UI path only through a defect) |
| I6e | Calendar audit | Read the audit rows of I1d, I1e and I3d | Exactly one `PROJECT_OPERATING_CALENDAR_UPDATED` per APPLIED write; none for refusals and NO_OP | n/a |
| I7a | Legacy upgrade (real binaries) | Disposable DB at 0001–0013 with the **pre-A1 build** (`main`, which has the duty UI but no publish UI). In the UI, create two plans of one project: in each, E is on DAY and NIGHT of the same date (adjacent intervals, allowed before A1). Publish one of them pre-A1 through the existing API with an Idempotency-Key. Add one empty plan in M for a second project without duties. **Drain**: stop the old backend. Apply 0014 and start the integrated backend | Rows, versions, memberships and `published_at` unchanged (compare before/after); zero calendar rows | Matrix shows all legacy duties |
| I7b | Inventory | `node scripts/scan-project-calendars.mjs` | Reports MISSING for the legacy projects and the dual DAY/NIGHT group; no repair | n/a (output stays private) |
| I7c | Legacy publish blocked | Dialog on the unpublished legacy plan | 409 `PROJECT_CALENDAR_MISSING`; nothing published | Generic alert; reload |
| I7d | Explicit bootstrap | PATCH `bootstrap:true` at exactly the earliest live-duty month, with an admin-chosen set covering every live duty date (including the PUBLISHED plan's) | APPLIED, audit carries `bootstrap: true`; a second bootstrap with fresh preconditions → 400 `PROJECT_CALENDAR_INVALID`; a bootstrap at another month → 400 | n/a |
| I7e | Dual membership blocks publish | Dialog → confirm | 409 `EMPLOYEE_DAILY_SHIFT_CONFLICT` | Generic alert; reload |
| I7f | Correction by removal | Editor: remove E from the NIGHT duty (pure removal) | 200 even though the legacy pair existed; new version; audit | Saved |
| I7g | Publish after correction | Dialog → confirm | 200 PUBLISHED; one audit | Success |
| I7h | Retained PUBLISHED legacy plan | Open the plan published pre-A1. First try a role change for E in one of the dual duties, then remove E from it (pure removal) | Role change 409 `EMPLOYEE_DAILY_SHIFT_CONFLICT` (changed work is validated); removal 200 (CR-03, applies directly); status and `published_at` unchanged; no second publish | Generic alert / removal applied |
| I7i | Legacy project without duties | Second project's empty plan: dialog (MISSING) → then PATCH `bootstrap:true` at the company-local current month (the runbook rule for projects without live duties) → dialog again | First 409 `PROJECT_CALENDAR_MISSING`; after bootstrap 200 PUBLISHED with one audit | Generic alert, then success |
| I8 | Isolation and authorization | Foreign tenant, and an EMPLOYEE role, against calendar GET/PATCH and the plan page | Concealed 404 / 403 as before; no foreign rows changed | "Nicht gefunden" |

Totals after the run: per published plan exactly one publication, one audit and one COMPLETED
reservation; only key hashes stored; one calendar audit per applied calendar write; fixture
cleanup by exact synthetic tenant; console errors only in deliberate categories, `other = 0`.

## 3. Evidence to record

Integration tree SHAs; receipt run ID and re-verification; migration counts (14, then 0) and
`verify-db`; gate results with counts; one PASS/FAIL line per case; status and code per request;
DB read-backs; console-error categories; screenshots and result JSON kept private outside Git;
container removal after its identity was re-checked. Mark every case not executed as NOT_RUN.

## 4. Frontend changes for the combined integration

**For safety and correctness: none.** A1 changes no response shape that the UI parses (plans,
entries, projects, leases). Its new refusals are 409s with codes the client does not yet trust,
so they show the generic 409 alert. The publish dialog treats every 409 except
`IDEMPOTENCY_REQUEST_IN_PROGRESS` as a definitive refusal: it reloads and uses a new key, and it
never shows success. The session re-check inside the publish transaction (A1 T4) rolls back
before commit, so a 401 cannot hide a publication.

**Before product/UX acceptance of the combined gate (recommended, after #92's contract is
adopted and merged):**

- F-A1-1, small, in #93 after the rebase or as its own commit: trust `PROJECT_CALENDAR_MISSING`,
  `PROJECT_CLOSED_WEEKDAY` and `EMPLOYEE_DAILY_SHIFT_CONFLICT` (409) in `shared/api/api-error.ts`.
  Add German texts in `planning-errors.ts` for `create-duty`, `update-duty` and `publish-plan`.
  The publish texts must say "Der Plan wurde nicht veröffentlicht." and must name no duty or
  person. With it, I1b, I1c, I3*, I4*, I7c and I7e show specific texts instead of "Konflikt".
- F-A1-2, separate slice: a calendar admin UI (GET/PATCH with exact/effective/next
  preconditions, bootstrap and dependency conflicts). Until then, configuration follows the
  documented API path, and the combined acceptance is "API-configured calendar + browser
  planning/publish".
- F-A1-3, optional UX: a calendar-aware duty form that marks closed weekdays. The server stays
  the authority.

Unchanged: publish transport, idempotency handling, dialog flow and wording.
