# #88 Employee-month planning — UX preparation (preview, stacked on #87)

> **Update 2026-11-03 (integration branch on main):** this is the reviewed #91 handoff, ported
> unchanged. Its pre-contract parts are superseded by the adopted A2-GATE-1 contract and
> [`sp88-a2-employee-month-ui.md`](sp88-a2-employee-month-ui.md): the `EmployeeMonthCommand` /
> `EmployeeMonthSave` seam (sections 3, 4 and 7) is replaced by the A2 client and save protocol,
> and a stored duty on a closed weekday is now kept without blocking the save (the server
> validates only changed duties). Draft PR #91 itself is unchanged.

Date: 2026-11-02, revised the same day after the Tech Lead review of PR #91
([comment](https://github.com/takh86/SecurePlan/pull/91#issuecomment-6588190627), CHANGES REQUESTED).
Branch `agent/claude/sp88-employee-month-ux`, created from the PR #87 head `662985e`; the Draft
PR targets the PR #87 branch `agent/claude/sp12-a10-ui`. Tracking:
[#88](https://github.com/takh86/SecurePlan/issues/88) (Product Owner decision, design gate OPEN)
under [#85](https://github.com/takh86/SecurePlan/issues/85); project operating weekdays in
[#90](https://github.com/takh86/SecurePlan/issues/90) (PO clarification recorded, contract pending).

**Status:** UX preparation and a preview-only frontend. The #88 HTTP contract and the #90
operating-day contract are not approved and do not exist, so **"Monat speichern" cannot save**:
the production route passes no save function, the button is unavailable with a stated reason,
and the preview sends no write request (tested). No backend, migration, dependency, CI or `.env`
change. Not merge-ready, not an approved implementation, not an MVP claim. The single-duty editor
of PR #87 is unchanged and remains the only way to change duties.

### Revision 2 (Tech Lead review)

| Review point | Change |
|---|---|
| 1. Paint mode before dates | One toolbar **Eintragen als: Tag / Nacht / Frei** (persistent radio group), then one click, tap or key activation per date in a Monday-first month calendar. The 31 × 2 toggle grid is gone. |
| 2. Exclusive selection | The draft stores per date one plan: one shift with a role, or Frei. TAG replaces NACHT and vice versa, FREI removes both, repeating the active mode changes nothing. No path (click, keyboard, role editing, rebase) can produce both shifts. |
| 2. Stored dual data | A stored date with DAY and NIGHT stays visible as **Korrektur nötig** (calendar, list, summary), is never changed on load, blocks the save, and is corrected explicitly ("Nur Tagdienst behalten", "Nur Nachtdienst behalten", "Frei (beide austragen)" or a paint mode). |
| 3. #90 operating days | Typed boundary `ProjectCalendar` (`unknown` / `known` with closed dates). Production passes nothing: no weekday is blocked, a note says so, the server decides. With a known calendar the UI offers only Frei on closed dates and flags stored duties there. |
| 4. Frei wording, SHIFT_LEAD | "Frei (nicht eingeplant)" everywhere in the planner; never an absence record. A stored Schichtleitung is kept unless changed in "Ausgewählter Tag"; no role dialog per date. |
| 5. No persistence | Unchanged: no save wiring, no PATCH calls, preview label and reason stay. |

## 1. User flow

1. Overview: choose project and month (existing overview), open the plan.
2. Plan page, section "Dienste": switch the view from **Alle Personen** (A10 matrix, overview) to
   **Monat einer Person planen** (labelled "Vorschau"), or open it from a matrix cell's panel
   ("Monat von {Name} planen (Vorschau)").
3. Choose ONE person (list with code and flags "nicht zugeordnet"/"deaktiviert"), or step with
   **Vorherige Person** / **Nächste Person**.
4. Choose a mode in **Eintragen als: Tag / Nacht / Frei**. Without a mode a click only selects the
   date ("Wählen Sie zuerst Tag, Nacht oder Frei.").
5. Click, tap or activate dates one after another. Each activation is announced, e.g.
   "Di., 1. Dezember: Nachtdienst (Mitarbeitende)." or "… bereits Tagdienst (Mitarbeitende),
   keine Änderung." The role (Mitarbeitende/Schichtleitung) can be changed in **Ausgewählter Tag**,
   which follows the last date and lists the other members of both duties as "bleiben unverändert".
6. Review: summary line "Im Monat: n × Tag, n × Nacht, n × Frei"; **Korrektur nötig (n)** for
   stored dates that break a rule; **Ungespeicherte Änderungen (n)** with date links and
   **Zurücksetzen**; **Alle Änderungen verwerfen** asks first.
7. **Monat speichern** once (sticky save bar). In the preview it explains why it is unavailable;
   with the future adapter it sends ONE command.
8. Failure: nothing is saved, every selection stays, the findings are shown per date; a lost
   answer blocks another attempt until **Aktuellen Stand prüfen** has re-read the state.
9. After a successful save the planner stays on the person; **Nächste Person** in the toolbar
   continues (no automatic jump).

```
┌ Dienste ─────────────────────────────────────────────────────────────────────┐
│ Ansicht: ( ) Alle Personen  (•) Monat einer Person planen [Vorschau]         │
│ Person [Mira Beispiel (A-001) ▾]  [Vorherige Person] [Nächste Person]        │
│ ⓘ Vorschau: … noch ohne Speichern …   Betriebstage: noch nicht hinterlegt    │
│ ┌ Eintragen als ─────────────────────┐ ┌ Ausgewählter Tag: Mi., 2. Dez. ──┐  │
│ │ [ Tag ] [ Nacht ] [✓ Frei ]        │ │ Geplant: Frei, bisher Tagdienst …│  │
│ └────────────────────────────────────┘ │ Tagdienst, weitere Personen      │  │
│ Im Monat: 7 × Tag, 4 × Nacht, 19 × Frei│ (bleiben unverändert): …         │  │
│ ┌ Korrektur nötig (1) ───────────────┐ │ [Diesen Tag zurücksetzen]        │  │
│ │ Mi., 16.12.: Tag und Nacht …       │ ├ Ungespeicherte Änderungen (5) ───┤  │
│ └────────────────────────────────────┘ │ 01.12. · Nachtdienst statt Tag…  │  │
│   Mo   Di    Mi    Do    Fr   Sa  So   │ 02.12. · Frei, bisher Tagdienst  │  │
│        1↔    2−    3     4+   5   6    │ … [Zurücksetzen]                 │  │
│        Nacht Frei  Tag!  Tag  –   –    └──────────────────────────────────┘  │
│   7    8     9     10    11+  12  13                                         │
│   Tag  Tag   Tag SL Tag  Tag SL –  –                                         │
│   14   15    16⚠   …                                                         │
│        –     Tag+Nacht                                                       │
│ ▁ 5 Änderungen · 1 Tag korrigieren   [Aktuellen Stand laden] [Monat speichern] ▁ │
└──────────────────────────────────────────────────────────────────────────────┘
```

Side column beside the calendar from 1280 px; below that it follows the calendar, and the page
scrolls (sticky save bar, no nested scroll frame). Checked at 1440 and 390 px (section 6).

### Date states (text and marks, never colour alone)

| State | Shown in the cell | Accessible name / description (example) |
|---|---|---|
| Unchanged Tag / Nacht | `Tag` / `Nacht` (+ `SL`), filled | "Do., 3. Dezember: Tagdienst (Schichtleitung)" |
| Unchanged Frei | `–` | "…: Frei (nicht eingeplant)" |
| New | `+`, dashed brand border | "Geändert, bisher Frei (nicht eingeplant), noch nicht gespeichert" |
| Set to Frei | `Frei` with `−`, dashed | "…: Frei (nicht eingeplant)" + "Geändert, bisher Tagdienst (…)" |
| Shift switched | `↔` | "…: Nachtdienst (Mitarbeitende)" + "Geändert, bisher Tagdienst (…)" |
| Role changed | `~` | "…: Tagdienst (Schichtleitung)" + "Geändert, bisher Tagdienst (Mitarbeitende)" |
| Stored DAY + NIGHT | `Tag + Nacht` `⚠`, attention style | "…: Tagdienst und Nachtdienst, Korrektur nötig" |
| Not offered in the current mode | dotted, `aria-disabled` (still focusable) | "Nacht nicht möglich: nicht für diese Dienstart freigegeben" |
| Closed project day (known calendar only) | `geschl.` | "Projekt an diesem Tag nicht in Betrieb" |
| Neutral hint | `!` | "Hinweis: nicht verfügbar" (no reason, ever) |
| Changed on the server | `⚠`, "Prüfen" in the list | "Die Besetzung des Tagdienstes wurde inzwischen geändert." |
| Rejected by the server | `⚠` | "Nicht gespeichert: Nachtdienst: An diesem Tag nicht verfügbar." |

"Frei" only means "not planned in this project on this date"; it is never an absence record
(sickness, leave) and creates none. The planner reads no absence data; only the server's neutral
`EMPLOYEE_UNAVAILABLE` hint on an existing membership is shown. Weekend columns are not shaded,
so the calendar does not suggest a weekend rule.

### Keyboard, touch and focus

ARIA grid with one tab stop (roving tabindex). Arrow keys move by a day (left/right) or a week
(up/down), Home/End to the start/end of the week, Ctrl+Home/End to the first/last day of the
month; Space/Enter paint the date with the current mode; T, N and F choose the mode from within
the calendar. The mode toolbar is a native radio group (arrow keys inside it). Every change goes
to a polite live region. The date links in the correction list, the change list and the error
alert move focus back into the calendar. A rejection or unknown outcome moves focus to the alert
heading. Unsaved selections are guarded on person switch, view switch and leaving the page (inline
prompt "Ungespeicherte Monatsplanung", no browser dialog). Touch: date targets 43 × 71 px at
390 px, 92 × 81 px at 1440 px; mode targets at least 91 × 60 px.

## 2. Reuse and change inventory (PR #87)

| PR #87 part | Use here | Change |
|---|---|---|
| `MonthlyPlanPage` | Host of both views | View switch (radio group), `PersonMonthView` (person list, previous/next), guarded `requestView`; the matrix branch is only re-indented; focus fallback now targets the calendar |
| `UnsavedPrompt` + `useBlocker` | Reused for person/view switch and navigation | New copy for mode `month` (dirty and saving) |
| `PlanningMatrix`, `planning-matrix.ts` | Matrix view unchanged; `matrixDays`, `spokenDate`, `MatrixRow` reused | New `standaloneRow` keeps a chosen person selectable after a read no longer lists them |
| `PlanningDayDetails` | Entry point | Optional "Monat von {Name} planen (Vorschau)" button |
| `duty-eligibility.ts` | Static UX restrictions (status, employment, shift eligibility) | None |
| `DutyEditor`, `DutyEditLease`, `use-duty-edit-lease`, PATCH/DELETE client | **Not used** by the planner; remain the supporting single-duty path | None |
| `DutyCreateForm` | Not used by the planner | None |
| `PublishSlot` | Unchanged; `hasUnsavedChanges` also covers an unsaved month draft | None |
| `planning-errors.ts` | Not used yet; the future adapter maps codes to `DayIssue` | None |

New: `employee-month-draft.ts` (pure model), `EmployeeMonthPlanner.tsx` (mode toolbar, calendar,
corrections, day details, review), styles in `MonthlyPlanning.css`, and three test files.

Deliberately **not** done: no Save wired to several PATCH/POST calls (that would break the
approved all-or-nothing rule), no mock persistence, no browser storage of the draft, no bulk
helpers beyond the paint mode, no invented operating weekdays.

## 3. Frontend state model

```
MonthBase   = server state for ONE employee and month: per (date, DAY|NIGHT) slot
              { dutyId | null, version | null, role | null, unavailable, others[] }
DayPlan     = { kind: DAY|NIGHT, role } | null (Frei)        — what the admin can want
DayState    = DayPlan | BOTH                                  — BOTH only for stored data
Draft       = { base, choices: date → DayPlan (only where ≠ stored), conflicts: date → {kind, shift, before} }
```

- One shift per date by construction: a choice is a `DayPlan`, never BOTH. `paint(draft, date,
  mode)` returns the same draft when the date already has that state (idempotent); TAG/NACHT keep
  the role of a shift the date already has, restore the stored role of the target shift, and
  start a new membership as Mitarbeitende. `setRole` changes only the single wanted shift.
- `corrections(draft, calendar)` lists dates whose wanted state is BOTH or a shift on a closed
  day (known calendar only). `monthCommand` returns null while any correction, conflict or no
  change remains.
- `rebase(draft, freshBase)` runs whenever the page delivers a newer duty read: a choice the
  server already shows is **reached** (not attributed); a choice is a **conflict** when a slot it
  writes to changed (the employee's role first, then duty created/removed/replaced, then other
  members/version) and needs "Meine Auswahl behalten" or "Aktuellen Stand übernehmen"; changes of
  a slot the choice leaves alone are ignored; dates without a choice follow the server and are
  counted as changed elsewhere (a date that became dual elsewhere shows up under "Korrektur nötig").
- `changeRestriction` / `paintRestriction` mirror static rules as a UX aid: project inactive,
  closed day (known calendar), unknown person, not assigned, inactive, not employed, not eligible,
  optional "no duty". Frei and returning to the stored state are always offered.
- `ProjectCalendar = { status: 'unknown' } | { status: 'known', closed: Set<date> }`: closed dates
  resolved by the server in company-local dates (a night counts on its start date).
- Save phases unchanged: `editing` → `saving` (locked) → `rejected` (findings per date) |
  `unknown` (save blocked until a re-read) | `saved` → `verifying` (re-read).
- `EmployeeMonthCommand` is a **frontend seam**, not an API shape: per changed date `to` (one
  shift with role, or null = Frei) and `basedOn.DAY` / `basedOn.NIGHT` = `{ dutyId, version, role }`.
  It never contains other members.
- `EmployeeMonthSave = (command) => Promise<{ saved } | { rejected, issues[] } | { unknown }>`;
  any malformed outcome or thrown error is treated as `unknown`.

## 4. Requirements for the #88/#90 contracts (input for Codex; not a contract)

| # | Requirement from the UI | Why |
|---|---|---|
| R1 | One request per employee-month save, one transaction; all or nothing, including audit | PO rule; the UI never splits a save |
| R2 | Input expresses, per date, the wanted state for ONE employee: one shift with a role, or Frei. Desired-state or delta is the contract's choice; the seam carries `to` and the stored state of both slots | Preserve other members; one shift per date |
| R3 | The server enforces **one shift per employee, project and local duty date** on the final state of the month (independent of time overlap), and rejects with a dated finding | PO rule (#90); the UI is only a UX aid |
| R4 | A precondition per affected duty (e.g. the version the choice was based on) and for absent duties, or an equivalent employee-month token | Detect changes by other admins; the UI keeps `basedOn` |
| R5 | Decision on missing duties (#88 P2): may a save create a missing duty, or are dates without a duty not selectable? No silent placeholder rows | The UI supports both (`newDuties` flag) |
| R6 | Rejections list findings per date (and kind) with stable codes: existing staffing codes, version conflict, lock, plus one-shift-per-date and closed operating day; never another employee's data or an absence reason | Day-specific, neutral correction (`ONE_SHIFT_PER_DAY`, `PROJECT_CLOSED_DAY` are frontend categories only) |
| R7 | #90: a read of the project's operating days for the plan month, resolved to company-local closed dates, with a defined rule for nights (start date) and effective dates; the server validates fail-closed on save | Feeds `ProjectCalendar`; without it the UI assumes no closed day |
| R8 | Defined treatment of stored dual dates and of stored duties on (newly) closed days in a month save: reject until corrected (current UI behaviour) or another approved rule | The UI blocks the save until corrected |
| R9 | Idempotency for lost answers (e.g. a client key per attempt) and a defined way to learn the outcome; no partial result | "Ergebnis unbekannt" must be resolvable without blind retry |
| R10 | Defined interplay with ADR-0006 edit leases held by another admin's single-duty editor (reject that date with a lock finding, or another approved rule) — never a silent bypass | PR #87 editors stay in use |
| R11 | Success answer with the resulting state (or versions) of the affected duties | Optional: avoids a full re-read; the UI re-reads today |
| R12 | Input limits (at most 31 dates, one plan, one employee), tenant/role checks server-side; serialization with Publish (#86) and CR-03 (a save in a PUBLISHED plan is effective at once) | Defensive bounds; the save bar already shows the CR-03 note |

## 5. Product Owner decisions

Settled by the PO direction and the Tech Lead review (2026-11-02):

- Employee-month planning is the primary planning action; "Alle Personen" stays as overview. While
  saving is unavailable, the matrix stays the default view so the working single-duty editor is
  not hidden; the person view becomes the default once the save is approved and wired.
- DAY and NIGHT on the same date are not allowed (stricter SecurePlan rule, #90); "Frei" is a
  scheduling state only.
- A change by another admin to the same duty needs an explicit decision (keep or take server state).
- After a successful save: stay on the person; "Nächste Person" continues (no automatic jump).
- No bulk helpers beyond the paint mode in the MVP; missing duties follow the #88 P2/#90 contract.

Still open:

1. Role on a shift switch: a new membership starts as Mitarbeitende (a stored Schichtleitung is
   not carried to the other shift). Confirm, or carry the role over?
2. Stored dual dates and stored duties on closed days block the whole month save until corrected
   (current). Confirm, or allow saving other dates?
3. No mode is preselected (first click asks for one). Preselect Tag instead?
4. The mode is reset when switching person. Keep it across persons?
5. Extra confirmation before saving into a PUBLISHED plan, or is the visible CR-03 note enough?
6. The draft is not kept across a reload or sign-out (no browser storage of planning data) — confirm.
7. Phone save bar takes about a quarter of the screen height in the preview — acceptable?

## 6. Tests and evidence

Local, Windows, Node 24.21.0, working tree of the revision commit.

| Gate | Result |
|---|---|
| `npm run lint` | passed, no findings |
| `npm run typecheck`; frontend `tsc -b` via `npm run build` | passed |
| `npm run build` | passed; main chunk 603.9 kB (PR #87: 562.9 kB, warning above 500 kB already present) |
| `npm run test --workspace=frontend` | **53 files / 751 tests passed** (PR #87 head: 50 / 698) |
| `npm run check:public`, `git diff --check` | passed |

Employee-month tests (53):

- `employee-month-draft.test.ts` (27): month base for 31/30/29/28-day months and the night of the
  last day; stored Tag/Nacht/Frei/BOTH; the acceptance scenario (TAG 1, 2, 5, 10 · NACHT 17, 19 ·
  FREI 5 · TAG 2 again = same draft · NACHT on a TAG date); stored TAG → NACHT as one change;
  idempotent repeat (kept role, open conflict untouched); Schichtleitung kept; **exhaustive
  negative test** over every mode sequence with role edits on Frei/Tag/Nacht/BOTH stored states
  (never BOTH, command always single); stored dual dates visible, blocking and correctable; the
  command lists only the selected employee; rebase kinds, never dual after a newer read, ignored
  untouched slots; restrictions, no weekend rule while unknown, closed dates with a known calendar;
  Monday-first calendar weeks; findings dropped per date.
- `EmployeeMonthPlanner.test.tsx` (21): preview label and unavailable save; calendar layout; February
  2028; the acceptance scenario by clicks with live-region announcements; mode required first;
  stored TAG → NACHT with role and other members; keyboard (one tab stop, arrows, Home/End,
  Ctrl+Home/End, T/N/F, Space/Enter, idempotent repeat, focus from the change list); restrictions;
  inactive project; stored dual date as "Korrektur nötig" blocking save and its correction;
  known calendar (closed dates, correction); unknown calendar does not block weekends; ONE
  command and draft kept after a rejection with neutral findings; unknown outcome; malformed
  outcome; conflict keep/take; never dual after a newer read; locked while saving; discard; CR-03.
- `MonthlyPlanPage.employee-month.test.tsx` (5, real plan page and in-memory API): preview with
  paint modes sends no write request; guards on next person, leaving the page, person list and
  view switch; entry from a matrix cell; a person no longer listed after a reload keeps the
  planner; "Aktuellen Stand laden" keeps the draft and marks a duty another admin changed.

Visual check (not an acceptance test): the planner rendered with synthetic data in headless
Chrome 156 from a throw-away harness outside the repository (no backend, database or Docker);
1440 × 1000 (mouse) and 390 × 844 (touch emulation, taps); no horizontal page overflow, no
console or page errors; the stored dual date stayed visible; the correction and the rejection
alert worked. The 390 px run led to a fix (whole words in date cells).

**NOT_RUN:** real-browser acceptance against the API and disposable PostgreSQL (there is no
#88/#90 endpoint), backend tests (no backend change), screen-reader, cross-browser and real-device
checks, a 60–100-person month, owner UX review.

## 7. Connecting the real save once #88 (and #90) are approved

1. Add the typed client call to `monthly-plans-api.ts` with response-shape validation, as for the
   SP-12 writes.
2. Write an adapter `EmployeeMonthCommand → request` and `response → EmployeeMonthSaveOutcome`:
   2xx → `saved`; a documented rejection → `rejected` with `DayIssue`s (codes → reasons, neutral
   texts); network/invalid response → `unknown`; idempotency key handling per the contract.
3. Pass the adapter as `save` from `MonthlyPlanningSection` through `MonthlyPlanPage` to
   `EmployeeMonthPlanner`; set `newDuties` per the P2 decision; remove the "Vorschau" labels.
4. Once #90 exists: read the operating days for the plan month, map them to
   `{ status: 'known', closed }` and pass `calendar`; keep `unknown` (never a guessed weekend) when
   the read fails.
5. Tests: adapter unit tests, page tests against the in-memory company implementing the approved
   contract, then real-browser acceptance on a disposable PostgreSQL: multi-day success, one invalid
   date → nothing saved, dual and closed-day rejections, competing admin, lost answer, PUBLISHED
   plan, keyboard and 390 px touch.

## 8. Effort and dependencies (estimate, not a committed reforecast)

| Work item | Owner | Estimate (working days) | Depends on |
|---|---|---|---|
| #88 contract incl. P1 (one shift per date) and P2 (missing duties), review | Codex + Tech Lead | 1–2 | PO decisions 1–2 above |
| #90 operating-day contract, configuration, validation (separate scope amendment) | Codex + Tech Lead | not estimated here | PO scope decision |
| Backend month command: one transaction, LOCK-01 order, audit, PostgreSQL/HTTP and concurrency tests | Codex | 5–8 | approved #88 contract |
| Frontend adapter, wiring, error mapping, removal of preview labels | Claude | 1.5–2.5 | approved #88 contract |
| Frontend operating-day read and `calendar` wiring | Claude | 0.5–1 | approved #90 contract |
| Real-browser acceptance with disposable PostgreSQL (incl. concurrency, lost answer, PUBLISHED) | Claude | 1–2 | backend on a branch |
| Owner UX review of this revision and one more revision | PO + Claude | 1–2 | this Draft PR |
| Integration with #86/#87 merge order, combined-head CI and browser run | both | 1–2 | #86 and #87 reviews |
| **Total delta (without #90 backend)** | | **≈ 11–19.5** | |

With frontend and backend in parallel, the critical path is contract approval → backend command
and tests → frontend adapter and browser acceptance → merges, roughly 8–13 working days after the
#88 contract is approved, plus whatever #90 adds if the operating days are required for the MVP.
Against the 2026-12-03 MVP forecast this is tight and uses buffer; it holds only if the contracts
are decided within the first days of November and #86/#87 merge sequencing does not slip. The
owner decides scope and buffer use.
