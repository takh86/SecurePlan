# #88 Employee-month planning — UX preparation (preview, stacked on #87)

Date: 2026-11-02. Branch `agent/claude/sp88-employee-month-ux`, created from the PR #87 head
`662985e`; the Draft PR targets the PR #87 branch `agent/claude/sp12-a10-ui`. Tracking:
[#88](https://github.com/takh86/SecurePlan/issues/88) (Product Owner decision, design gate OPEN) under
[#85](https://github.com/takh86/SecurePlan/issues/85).

**Status:** UX preparation and a preview-only frontend. The #88 HTTP contract is not approved and
does not exist, so **"Monat speichern" cannot save**: the production route passes no save
function, the button is unavailable with a stated reason, and the preview sends no write request
(tested). No backend, migration, dependency, CI or `.env` change. Not merge-ready, not an
approved implementation, not an MVP claim. The single-duty editor of PR #87 is unchanged and
remains the only way to change duties.

## 1. User flow (PO direction of 2026-11-02)

1. Overview: choose project and month (existing overview), open the plan.
2. Plan page, section "Dienste": switch the view from **Alle Personen** (A10 matrix) to
   **Monat einer Person planen** (labelled "Vorschau"), or open it from a matrix cell's panel
   ("Monat von {Name} planen (Vorschau)").
3. Choose ONE person (list with code and flags "nicht zugeordnet"/"deaktiviert"), or step with
   **Vorherige Person** / **Nächste Person**.
4. Plan the month: every calendar day is a row with a **Tagdienst** and a **Nachtdienst** toggle.
   The role (Mitarbeitende/Schichtleitung) is chosen in **Ausgewählter Tag**, which follows the
   focused day and also lists the other members of both duties as "bleiben unverändert".
5. Review: **Ungespeicherte Änderungen (n)** lists every change in calendar order with "Zum Tag"
   (date link) and **Zurücksetzen**; **Alle Änderungen verwerfen** asks first.
6. **Monat speichern** once (sticky save bar with the change count). In the preview it explains
   why it is unavailable; with the future adapter it sends ONE command.
7. Failure: nothing is saved, every selection stays, the findings are shown per day; a lost
   answer blocks another attempt until **Aktuellen Stand prüfen** has re-read the state.
8. Continue with **Nächste Person**.

```
┌ Dienste ─────────────────────────────────────────────────────────────────────┐
│ Ansicht: ( ) Alle Personen  (•) Monat einer Person planen [Vorschau]         │
│ Person [Mira Beispiel (A-001) ▾]  [Vorherige Person] [Nächste Person]        │
│ ⓘ Vorschau: … noch ohne Speichern …                                          │
│ Eignung · Status · Beschäftigt · Projektzuordnung                            │
│ ┌ Datum ┬ Tagdienst ┬ Nachtdienst ┬ Hinweise ──┐ ┌ Ausgewählter Tag ───────┐ │
│ │ Di 01.│ [ Tag   ] │ [   –   ]   │            │ │ Tagdienst: neu …        │ │
│ │ Do 03.│ [(Tag) − !]│ [ Nacht + ] │ Tag: ! …  │ │ Weitere Personen (bleib-│ │
│ │ …     │           │             │            │ │ en unverändert): …      │ │
│ └───────┴───────────┴─────────────┴────────────┘ │ Funktion ( ) MA ( ) SL  │ │
│                                                  ├ Ungespeicherte Änd. (4) ┤ │
│                                                  │ 03.12. · Tagdienst: aus-│ │
│                                                  │ getragen … [Zurücksetz.]│ │
│                                                  └─────────────────────────┘ │
│ ▁▁ 4 ungespeicherte Änderungen  [Aktuellen Stand laden] [Monat speichern] ▁▁ │
└──────────────────────────────────────────────────────────────────────────────┘
```

Side column beside the month from 1280 px; below that the month scrolls with the page (sticky
header and save bar, no nested scroll frame). Checked at 1440 and 390 px (section 6).

### Cell states (text and marks, never colour alone)

| State | Shown as | Accessible description (example) |
|---|---|---|
| Unchanged, planned | `Tag` / `Nacht` (+ `SL`) | "eingeplant als Schichtleitung" |
| Unchanged, not planned | `–` | "nicht eingeplant" (+ "Dienst noch nicht angelegt") |
| New | `Tag +`, dashed brand border | "neu eingeplant als Mitarbeitende, noch nicht gespeichert" |
| Removed | struck-through `Tag` with `−`, dashed | "wird ausgetragen, bisher Schichtleitung, noch nicht gespeichert" |
| Role changed | `Tag SL ~` | "Funktion geändert zu Schichtleitung, bisher Mitarbeitende, …" |
| Not offered (static rule) | dotted, `aria-disabled` (still focusable) | "… Einplanen nicht möglich: nicht für diese Dienstart freigegeben" |
| Neutral hint | `!` | "Hinweis: nicht verfügbar" (no reason, ever) |
| Changed on the server | attention style, "Prüfen" in the list | "Die Besetzung dieses Dienstes wurde inzwischen geändert." |
| Rejected by the server | attention style | "Nicht gespeichert: Überschneidet sich zeitlich mit …" |

"Nicht eingeplant" only means "no membership in that duty"; it is never an absence record
(sickness, leave). The planner reads no absence data; only the server's neutral
`EMPLOYEE_UNAVAILABLE` hint on an existing membership is shown.

### Keyboard and focus

ARIA grid with one tab stop (roving tabindex). Arrow keys move between days and Tag/Nacht,
Page Up/Down by one week, Home/End to the first/last slot of the day, Ctrl+Home/End to the first
and last day; Space/Enter toggle. "Ausgewählter Tag" follows focus. The date links in the change
list and in the error alert move focus back into the grid. A rejection or unknown outcome moves
focus to the alert heading. Unsaved selections are guarded on person switch, view switch and
leaving the page (inline prompt "Ungespeicherte Monatsplanung", no browser dialog).

## 2. Reuse and change inventory (PR #87)

| PR #87 part | Use here | Change |
|---|---|---|
| `MonthlyPlanPage` | Host of both views | View switch (radio group), `PersonMonthView` (person list, previous/next), guarded `requestView`; the matrix branch is only re-indented |
| `UnsavedPrompt` + `useBlocker` | Reused for person/view switch and navigation | New copy for mode `month` (dirty and saving) |
| `PlanningMatrix`, `planning-matrix.ts` | Matrix view unchanged; `matrixDays`, `dayHeader`, `spokenDate`, `MatrixRow` reused | None |
| `PlanningDayDetails` | Entry point | Optional "Monat von {Name} planen (Vorschau)" button |
| `duty-eligibility.ts` | Static UX restrictions (status, employment, shift eligibility) | None |
| `DutyEditor`, `DutyEditLease`, `use-duty-edit-lease`, PATCH/DELETE client | **Not used** by the planner; remain the supporting single-duty path | None |
| `DutyCreateForm` | Not used by the planner | None |
| `PublishSlot` | Unchanged; `hasUnsavedChanges` now also covers an unsaved month draft | None |
| `planning-errors.ts` | Not used yet; the future adapter maps codes to `DayIssue` | None |

New: `employee-month-draft.ts` (pure model), `EmployeeMonthPlanner.tsx` (planner, grid, day
details), styles in `MonthlyPlanning.css`, and three test files.

Deliberately **not** done: no Save wired to several PATCH/POST calls (that would break the
approved all-or-nothing rule), no mock persistence, no browser storage of the draft.

## 3. Frontend state model

```
MonthBase   = server state for ONE employee and month: per (date, DAY|NIGHT) slot
              { dutyId | null, version | null, role | null, unavailable, others[] }
Draft       = { base, choices: slot → role | null (only where ≠ base), conflicts: slot → {kind, before} }
```

- `setChoice` drops a choice equal to the server state (canonical "unchanged"); toggling a removed
  membership restores its original role.
- `rebase(draft, freshBase)` runs whenever the page delivers a newer duty read: a choice the
  server already shows is reported as **reached** (not attributed to anyone); a choice whose slot
  changed in any way (duty created/removed/replaced, the employee's role, other members/version)
  stays and becomes a **conflict** that needs "Meine Auswahl behalten" or "Aktuellen Stand
  übernehmen"; untouched slots simply follow the server and are counted as changed elsewhere.
- `changeRestriction` mirrors static rules as a UX aid in server order (project inactive, unknown
  person, not assigned, inactive, not employed, not eligible, optional "no duty"). Taking someone
  off and returning to the server state are always offered.
- Save phases: `editing` → `saving` (draft locked, page told `saving`) → `rejected` (back to
  editing, findings per day, nothing saved) | `unknown` (save blocked until a re-read) | `saved` →
  `verifying` (re-read; the rebase confirms what the server shows).
- `EmployeeMonthCommand` is a **frontend seam**, not an API shape: per changed slot `date`, `kind`,
  `dutyId`, `basedOnVersion`, `from`, `to`. It never contains other members.
- `EmployeeMonthSave = (command) => Promise<{ saved } | { rejected, issues[] } | { unknown }>`;
  any malformed outcome or thrown error is treated as `unknown`.

## 4. Requirements for the #88 contract (input for Codex; not a contract)

| # | Requirement from the UI | Why |
|---|---|---|
| R1 | One request per employee-month save, one transaction; all or nothing, including audit | PO rule; the UI never splits a save |
| R2 | Input expresses, per slot, the wanted role or "not planned" for ONE employee; desired-state or delta is the contract's choice — the seam carries both `from` and `to` | Preserve other members; no lost update of other employees |
| R3 | A precondition per affected duty (e.g. the version the choice was based on) and for absent duties ("no duty existed"), or an equivalent employee-month token | Detect changes by other admins; the UI already keeps `basedOnVersion` |
| R4 | Decision: may a save create a missing duty for a date/kind? If yes, per-day shift-time errors | The UI supports both (`newDuties` flag) |
| R5 | Rejections list findings per date and kind with stable codes (reuse `EMPLOYEE_UNAVAILABLE`, `DUTY_ASSIGNMENT_CONFLICT`, `EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT`, `EMPLOYEE_NOT_EMPLOYED_FOR_DAY`, version conflict, lock), plus whole-command errors; never another employee's data or an absence reason | Day-specific, neutral correction |
| R6 | Idempotency for lost answers (e.g. a client key per attempt) and a defined way to learn the outcome; no partial result | "Ergebnis unbekannt" must be resolvable without blind retry |
| R7 | Defined interplay with ADR-0006 edit leases held by another admin's single-duty editor (reject that day with a lock finding, or another approved rule) — never a silent bypass | PR #87 editors stay in use |
| R8 | Success answer with the resulting state (or versions) of the affected duties | Optional: avoids a full re-read; the UI re-reads today |
| R9 | Input limits (at most 31 × 2 slots, one plan, one employee), tenant/role checks server-side | Defensive bounds; frontend checks are UX only |
| R10 | Serialization with Publish (#86) and CR-03: a save in a PUBLISHED plan is effective at once | The save bar already says so |

## 5. Open Product Owner decisions

1. Default view: should "Monat einer Person planen" become the default once it can save (matrix as overview)?
2. Wording: the matrix legend says "– = frei"; the planner says "nicht eingeplant". One term for both?
3. Dates without a duty: may the admin select them (a duty is created on save), or only existing duties?
4. A change by another admin to *other* members of the same duty: re-confirm (current, conservative) or accept silently?
5. Extra confirmation before saving into a PUBLISHED plan, or is the visible CR-03 note enough?
6. After a successful save: stay on the person (current) or move to the next person automatically?
7. Role selection in the day details (two steps) — acceptable, or a third cell state for Schichtleitung?
8. DAY and NIGHT on the same date are both selectable without a warning (the server decides overlaps) — confirm that no extra business rule applies.
9. Bulk helpers (e.g. "Mo–Fr Tagdienst") — wanted for the MVP? Not included.
10. The draft is not kept across a reload or sign-out (no browser storage of planning data) — confirm.
11. Phone save bar takes about a quarter of the screen height in the preview — acceptable?

## 6. Tests and evidence

Local, Windows, Node 24.21.0, working tree of the code commit.

| Gate | Result |
|---|---|
| `npm run lint` | passed, 0 warnings |
| `npm run typecheck`; frontend `tsc -b` via `npm run build` | passed |
| `npm run build` | passed; main chunk 594.4 kB (PR #87: 562.9 kB, warning above 500 kB already present) |
| `npm run test --workspace=frontend` | **53 files / 735 tests passed** (PR #87 head: 50 / 698) |
| `npm run check:public`, `git diff --check` | passed |

New tests (37):

- `employee-month-draft.test.ts` (18): month base for 31/30/29/28-day months and the night of the
  last day, duties of other months ignored, role/hint/other members (case-insensitive); choose,
  clear, remove and restore, role change; DAY and NIGHT independent and ordered; the command lists
  only the selected employee; rebase reached/created/removed/replaced/own/others and no-op;
  restrictions in server order and removal always allowed; findings dropped on edit.
- `EmployeeMonthPlanner.test.tsx` (15): preview label and unavailable save; existing vs new vs
  removed vs cleared; DAY+NIGHT and role change with other members listed unchanged; keyboard
  (one tab stop, arrows, Page Up/Down, Home/End, Ctrl+Home/End, Space, focus from the change list);
  February 2028; static restrictions and inactive project; ONE command per save and draft kept
  after a rejection with neutral day findings; unknown outcome blocks retry until re-read;
  malformed outcome treated as unknown; conflict keep/take; locked while saving and re-read after
  a confirmed save; discard with confirmation; CR-03 note.
- `MonthlyPlanPage.employee-month.test.tsx` (4, real plan page and in-memory API): preview sends
  no write request; unsaved draft guarded on next person, leaving the page, person list and view
  switch; entry from a matrix cell; "Aktuellen Stand laden" keeps the draft and marks a duty
  another admin changed.

Visual check (not an acceptance test): the planner rendered with synthetic data in headless
Chrome 156 from a throw-away harness outside the repository (no backend, database or Docker);
1440 × 1000 and 390 × 844 px, no horizontal page overflow, no console or page errors.

**NOT_RUN:** real-browser acceptance against the API and disposable PostgreSQL (there is no #88
endpoint), backend tests (no backend change), screen-reader, cross-browser and device checks,
a 60–100-person month, owner UX review.

## 7. Connecting the real save once #88 is approved

1. Add the typed client call to `monthly-plans-api.ts` with response-shape validation, as for the
   SP-12 writes.
2. Write an adapter `EmployeeMonthCommand → request` and `response → EmployeeMonthSaveOutcome`:
   2xx → `saved`; a documented rejection → `rejected` with `DayIssue`s (codes → reasons, neutral
   texts); network/invalid response → `unknown`; idempotency key handling per the contract.
3. Pass the adapter as `save` from `MonthlyPlanningSection` through `MonthlyPlanPage` to
   `EmployeeMonthPlanner`; set `newDuties` per decision 3; remove the "Vorschau" labels.
4. Tests: adapter unit tests, page tests against the in-memory company implementing the approved
   contract, then real-browser acceptance on a disposable PostgreSQL: multi-day success, one invalid
   day → nothing saved, competing admin, lost answer, PUBLISHED plan, keyboard and 390 px.

## 8. Effort and dependencies (estimate, not a committed reforecast)

| Work item | Owner | Estimate (working days) | Depends on |
|---|---|---|---|
| #88 contract: request/response, preconditions, idempotency, lease interplay, review | Codex + Tech Lead | 1–2 | PO decisions 3, 4, 8 |
| Backend command: one transaction, LOCK-01 order, audit, PostgreSQL/HTTP and concurrency tests | Codex | 5–8 | approved contract |
| Frontend adapter, wiring, error mapping, removal of preview labels | Claude | 1.5–2.5 | approved contract |
| Real-browser acceptance with disposable PostgreSQL (incl. concurrency, lost answer, PUBLISHED) | Claude | 1–2 | backend on a branch |
| Owner UX review of the preview and one revision | PO + Claude | 1–2 | this Draft PR |
| Integration with #86/#87 merge order, combined-head CI and browser run | both | 1–2 | #86 and #87 reviews |
| **Total delta** | | **≈ 10.5–18.5** | |

With frontend and backend in parallel, the critical path is contract approval → backend command
and tests → frontend adapter and browser acceptance → merges, roughly 8–13 working days after the
contract is approved. Against the 2026-12-03 MVP forecast this is tight and uses buffer; it holds
only if the contract is decided within the first days of November and #86/#87 merge sequencing
does not slip. The owner decides scope and buffer use.
