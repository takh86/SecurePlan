# F-A1-2 — Project operating calendar admin UI

Date: 2026-11-03. Branch `agent/claude/sp90-calendar-ui` from `main@dd3e83e` (A1 #92 and the
SP-13 publish UI #93 merged). Refs #90. Draft PR to `main`; no merge, issue closure, staging or
deployment is part of this work. Contract: [A1 project operating calendar](../api/project-operating-calendar.md),
[development runbook](../development-a1-rollout.md).

## Scope

A COMPANY_ADMIN React interface for the merged A1 endpoints
`GET/PATCH /api/v1/projects/{projectId}/operating-calendar`, as the section „Betriebstage“ of the
existing project detail page (`/projekte/:id/:month`), between the month bar and „Schichtzeiten“.
No backend, API, error-contract, migration, dependency, lockfile, CI or `.env` change. Draft PR #91
(employee-month preview) is untouched; A2 (atomic employee-month save) is not implemented.

| Area | Delivered |
|---|---|
| Reading | One read per selected month. Shows exactly what the server stored: „Nicht festgelegt“ (MISSING), „Für {Monat} gespeichert“ (own version) or „Übernommen aus {Monat}“ (inherited); the version in force with its number; the next stored version. A seven-entry overview, Monday first, states „in Betrieb“/„geschlossen“ as text (never colour alone). MISSING shows no overview and says that there is no default |
| No assumed set | Nothing is ever preselected that the server has not stored for this project: a MISSING form starts empty; an inherited or own version preselects exactly its stored set. At least one weekday is required (the API allows 1–7); the hint suggests setting a project without operating days to inactive instead |
| Normal write | Month-effective replacement of the complete set of the selected month. The API client derives `expectedExactVersion`, `expectedEffective` and `expectedNextEffectiveFromMonth` from the read the administrator reviewed; screens cannot assemble them. The form explains the basis (no default / inherited → creates an own version even unchanged / own version n), the applicability interval up to the next stored version (also across a year boundary), newly closed and newly opened weekdays, and that a newly closed weekday is refused while a saved duty (also unstaffed or published) starts on it. Re-saving the exact stored set sends nothing |
| First version warning | A normal write for a project without ANY stored version warns that the one-time bootstrap is no longer possible afterwards and that earlier months then stay without operating days (runbook step 7) |
| Bootstrap | Offered only for a month that is past in every supported time zone AND while the project has no stored version at all. The latter is exact: the read is MISSING and has no later version. Four warnings (retroactive and open-ended; only once and only from the month of the earliest saved duty, else the current company month, checked by the server; must cover all saved duties incl. unstaffed/published, which are never changed or deleted; explicit acceptance, no proof of earlier operation, immutable for past months) and a required confirmation checkbox. Sends `bootstrap: true` |
| Read-only | An inactive project; a past month with any stored version (with the reason, including why the bootstrap is gone) |
| Response checks | Another project or month, an unknown state, CONFIGURED/MISSING inconsistent with the version, an exact reference that is not the own-month version, unsorted/duplicate/out-of-range weekdays, non-UUID ids, non-positive or unsafe versions, a next month not after the month, a write answer without APPLIED/NO_OP, without exact version or with a set other than the one sent: all are an invalid response |
| Conflicts | `PROJECT_CALENDAR_CONCURRENT_MODIFICATION`: German text, selection kept, saving blocked until „Aktuellen Stand laden“; the reload replaces the preconditions (not the selection), names the fresh state with its version and resets the bootstrap confirmation. `PROJECT_CALENDAR_DEPENDENCY_CONFLICT`: separate texts for normal and bootstrap writes, selection kept, correction can be saved directly. `PROJECT_CALENDAR_INVALID` at `#/effectiveFromMonth`: „Monat nicht mehr änderbar“ (normal) or „Ersteinrichtung für {Monat} nicht möglich“ with the month rule (bootstrap). `PROJECT_INACTIVE`, 403 and 404 end the form (only „Abbrechen“). Texts say „Es wurde nichts gespeichert.“ and name no duty, date or person |
| Unknown outcome | No or an unreadable answer and technical 5xx never count as success or failure („Ergebnis unbekannt“); saving is blocked until the current state is loaded. No automatic or blind resend; the A1 contract has no calendar idempotency key, so the explicit re-read is the recovery path. If the fresh state equals the selection, saving sends nothing |
| Unsaved input | The section joins the page's single navigation blocker (links, Back/Forward, REPLACE; only the marked session redirect passes) with its own prompt texts, and asks the browser before reload/close while a selection is unsaved or a save is running |
| Accessibility | Native checkboxes in a `fieldset`/`legend`; visible „Mo“…„So“ with full weekday names as accessible names (label-in-name); 44 px targets; focus on the form heading when it opens, on the first invalid field, on the alert after a failed save, on the confirmation after success, back on the edit button after „Abbrechen“; status messages in live regions |

### Changes outside the calendar files (listed exactly)

- `features/projects/ProjectDetailPage.tsx`: mounts the section; `ProjectDetailApis` gains
  `operatingCalendars`; the blocker and its prompt cover a third area (texts generalised into
  per-area records, behaviour unchanged); month hint mentions „Betriebstage“.
- `features/projects/ProjectsSection.tsx`: creates the calendar client.
- `features/projects/projects.test-support.ts` (test only): the in-memory company answers the two
  calendar endpoints with the merged service's precedence (stale → month/bootstrap → no-op →
  inactive → dependency → write).
- `shared/api/api-error.ts`: the three calendar-write codes are trusted with their catalogued
  status only; safe field pointers of `PROJECT_CALENDAR_INVALID` are kept (never server text).
- `features/planning/monthly-plans/planning-errors.ts`: the `PROJECT_CALENDAR_MISSING` texts no
  longer say that no calendar page exists; they point to „Projekte“ → project → „Betriebstage“.
- `scripts/sp90-calendar-ui-browser-acceptance.mjs`: new browser acceptance harness (below).

## Test evidence

All commands from the repository root under Node 24.21.0 (PowerShell), on `3dda35d` unless noted.

| Gate | Result |
|---|---|
| `npm run lint` (both workspaces) | exit 0; frontend oxlint 0 warnings, 0 errors |
| `npm run typecheck` (backend) | exit 0 |
| `npm run build` (both) | exit 0 |
| `npm run test --workspace=frontend` | 55 files / 890 tests PASS (new: `operating-calendar-api.test.ts`, `operating-calendar-form.test.ts`, `OperatingCalendarSection.test.tsx` with 23 screen tests; updated: `api-error-fields.test.ts`, `planning-errors.test.ts`) |
| `npm test` (backend unit) | 36 files / 385 tests PASS (backend unchanged) |
| `npm run test:e2e` on a verified disposable PG 17 | 51 files / 1311 tests PASS (backend unchanged) |
| `npm run test:scripts` | 21 / 21 PASS outside `activation-demo`; `activation-demo.test.mjs` **NOT_RUN** locally (its guard requires the real development DB on port 5432 with `NODE_ENV=development`; 13 refusals „Development mode required“). CI covers it |
| `npm run check:public` | PASS |

Screen tests run the real `/projekte` routes on an in-memory company with a fixed clock
(15.12.2026) and cover: MISSING without default, inherited and own versions, interval across the
year boundary, keyboard-only selection and submission, double submit, NO_OP, stale reload, dependency
correction, lost answer without resend, PROJECT_INACTIVE race, bootstrap (warnings, confirmation,
dependency, server month refusal, withdrawn after reload), inactive read-only, navigation prompt
(single and combined with shift times), beforeunload, cancel focus, read failures and a foreign
answer. Form-model tests cover the month-boundary window (UTC−12 … UTC+14) and the error texts.
jsdom tests are not browser proof; the harness below is.

### Real Chrome → NestJS → PostgreSQL

`scripts/sp90-calendar-ui-browser-acceptance.mjs`: built React app over trusted local HTTPS →
proxy → unmodified NestJS (`apps/backend/dist`) → verified disposable PostgreSQL 17 (fresh tmpfs
container, receipt recorded and reverified, migrations 0001–0014 applied, second run applied 0,
`verify-db` passed). Playwright 1.64.1 outside the repository, Chrome 156.0.8078.80, viewport
1440×1000 (one group 390×844), `de-DE`, Europe/Berlin. Only prerequisites are inserted by SQL
(tenants, accounts, projects, one month's shift times, two legacy pre-calendar duties in past
months, one of them in a published plan). Every calendar version is written through the UI and read
back from PostgreSQL. Months are computed in the company zone at run time; the harness refuses to run
inside the month-boundary window. Run months: current 2026-11, bootstrap 2026-09.

Evidence run 2026-11-03 10:39 UTC on `3dda35d`, tracked tree clean (`sourceDirty: false`):
**11 / 11 PASS**, fixture cleanup PASS, 0 page errors.

| Group | Asserted |
|---|---|
| C1 | MISSING shown, no overview, nothing preselected; empty save refused on the client (focus Monday, no request); Tab/Space selection Tuesday–Saturday, Enter on the save button; DB `mask 62, version 1`; one audit with exactly `{effectiveFromMonth, operatingWeekdays, version}`; PATCH body has exactly the six contract fields with null preconditions, CSRF, same Origin, `no-store` |
| C2 | Inherited set preselected for a later month; own later version written; the current month's change shows the bounded interval and sends `expectedNextEffectiveFromMonth`; versions 2 and 1 in DB; audit `oldValues` of the replaced version |
| C3 | Second admin saves first; first admin gets the German stale text, selection kept, save disabled; DB keeps the other admin's version; reload names version 3; resave applies version 4 with fresh preconditions; the refused write is not audited |
| C4 | Saturday opened via UI; an unstaffed Saturday duty created through the real planning API; closing Saturday → 409 with the safe text (no date, no name), DB unchanged, selection kept, no reload needed; corrected set applies |
| C5 | Committed answer truncated by the proxy (real headers, cut body): „Ergebnis unbekannt“, save blocked, DB shows exactly one increment; reload names the version; resaving sends nothing; exactly one PATCH reached the server |
| C6 | Current month offers a normal first write with the bootstrap warning; a later past month offers the bootstrap with all four warnings; missing confirmation sends nothing (focus on the checkbox); a non-earliest month → 400 with the month rule, input kept; month change with unsaved input asks first; Monday only → 409 (would exclude the Tuesday duties, incl. the published one); Monday+Tuesday applies with `bootstrap: true`; audit `newValues` include `bootstrap: true`; afterwards both past months read-only with no button; legacy duties untouched |
| C7 | Month link held with „Ungespeicherte Betriebstage“; „Weiter bearbeiten“ returns focus to the link and keeps the selection; page close asks `beforeunload` |
| C8 | Inactive project read-only (no button); direct PATCH → 409 `PROJECT_INACTIVE`; project deactivated by another admin while editing → German refusal, no reload offer, save disabled, no row |
| C9 | 390 px: no horizontal page scroll; overview items and weekday choices inside their cards; every choice ≥ 44 px high |
| C10 | Foreign tenant's calendar: GET and PATCH 404, project page „Nicht gefunden“ without the section; PATCH without CSRF 403; EMPLOYEE: GET/PATCH 403 and no „Projekte“ navigation; no foreign or extra rows |
| C-T | Calendar audits = applied version changes = 9 (none for refusals or client no-ops); every observed calendar answer (40 requests, 18 PATCH) `Cache-Control: no-store`; console errors only deliberate refusals (`http-401` ×4 before login, `http-409` ×5, `http-404` ×3, `http-403` ×3, `http-400` ×1) and the deliberately truncated answer (`net::ERR_CONTENT_LENGTH_MISMATCH` ×1); `other` 0 (asserted) |

Rerun (PowerShell, Node 24): create and record a fresh target per
[disposable-postgres.md](../testing/disposable-postgres.md), migrate twice, run `verify-db`, build,
then with an explicit `DATABASE_URL`, `SECUREPLAN_PLAYWRIGHT_MODULE` (external Playwright
`index.mjs`) and `SECUREPLAN_BROWSER_OUTPUT_DIR` (private directory) run
`node --env-file=<development .env for login/denylist settings> scripts/sp90-calendar-ui-browser-acceptance.mjs`.
The explicit `DATABASE_URL` wins over the file; local TLS certificates are required.

## Limitations and remaining gates

- **Earliest duty month for the bootstrap.** The A1 read does not expose the earliest live duty
  month, so the UI cannot name it; the admin finds it in the planning overview or the runbook
  inventory, and the server refuses any other month with an explained 400. Exposing it would be an
  API change (not in scope).
- **Company time zone unknown to the client.** Within about 26 h around a month change a normal
  write may be offered for a month the server already treats as past (explained 400), and the
  bootstrap is offered only once a month is past in every supported zone. Same rule as the shift
  times screen.
- **Equal-to-inherited versions** are allowed by the contract and create an explicit version; the
  form says so before saving.
- A server `NO_OP` is handled, but the UI normally sends nothing for an unchanged own version.
- Closed weekdays are not yet marked in the planning forms (optional F-A1-3); planning writers still
  refuse them server-side with the existing German texts.
- **Not done:** human UX/security acceptance, formal contract adoption, any existing development
  database rollout (backup, writer drain, private inventory and explicit configuration per runbook),
  staging/production (#51 operational gates and the other blockers in the runbook). Issues #88/#90
  stay open; A2 is not implemented; PR #91 is unchanged.
