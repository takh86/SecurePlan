# SP-12 A10 — planning matrix and existing-duty editor

Date: 2026-11-02. Branch `agent/claude/sp12-a10-ui` from `main@13b680c` (SP-12 backend #84
merged). Tracking: [#85](https://github.com/takh86/SecurePlan/issues/85). Review-ready PR to
`main`; no merge, issue closure or deployment is part of this work.

## Scope

A COMPANY_ADMIN React interface on the existing SP-11/SP-12 routes only. No backend controller,
service, migration, locking or error-contract change; no dependency, lockfile, CI or `.env` change.
No publish call exists (SP-13).

| Area | Delivered |
|---|---|
| A10 matrix | Replaces the interim duty list (accepted for SP-11 PR-2 only). Employee-by-day ARIA grid: one row per person assigned to the project in the plan month plus every duty member (deactivated/unknown persons stay visible), one column per day, a "Dienste am Tag" row that also shows duties without members. Sticky header and person column; the matrix scrolls inside its own frame and never reflows into cards (Phase 5.7 §7.3) |
| Accessibility | Every cell is a button named by person, date and state (e.g. "Synthetic Alpha, Do., 3. Dezember: Tagdienst, Schichtleitung"); roving tabindex (one tab stop), arrows, Home/End, Ctrl+Home/End; Enter/Space open the focus panel, Escape closes it and returns focus to the cell; status never by colour alone (text + SL/! markers + legend) |
| Focus panel | Cell/day details (eligibility, status, month assignment, the day's two duty slots), "anlegen" for a missing slot prefilled with date, kind and the cell's person, "bearbeiten" for an existing duty. Side panel ≥ 1280 px, below the matrix on narrower screens |
| Duty editor | Date, kind and complete roster with duty roles; the cell's person is listed first; members who no longer meet the static rules (or are reported unavailable) are flagged neutrally, never hidden. Shows exactly what is still unsaved. Saves ONE `PATCH` with only the changed fields |
| Deletion | Inline confirmation (no browser dialog) naming the duty, the number of members, the plan's publication state and the version guard; then ONE `DELETE` |
| Leases (ADR-0006) | Acquire on open, then read duty and plan; renewal from the server's `expiresAt` (half the remaining time, 5–60 s; default TTL 120 s → ~60 s); technical renewal failures are repeated until the lease's end; `pagehide` releases with `keepalive`; a release waits for a write still in flight; a page restored from the back/forward cache acquires again and re-checks the version |
| Recovery | Another holder → read-only with reason and "Erneut versuchen". Lease lost → input kept, "Erneut reservieren" re-checks the version before saving is possible. `PLAN_CONCURRENT_MODIFICATION` → nothing overwritten, unsaved input listed, "Aktuellen Stand laden" only on request. Lost/unreadable response → "Ergebnis unbekannt", no retry, "Aktuellen Stand prüfen" decides (unchanged → input kept; equals the input → saved; otherwise conflict) |
| CR-03 | In a PUBLISHED plan the editor, the status section and the notices say that saved changes and deletions apply at once, without re-publishing; the plan status is re-read whenever a lease is granted |
| SP-13 integration point | `PublishSlot` render prop on the plan status section (`plan`, `project`, `hasUnsavedChanges`, `onPlanChanged`); see below |

### Token handling

The lease token lives only in a private field of the in-memory `DutyEditLease` controller.
Status snapshots, React state, the DOM, URLs, request bodies, browser storage and logs never
contain it; writes borrow it through `withToken`, and the session transport sends it only as
the `Edit-Lease-Token` header (format-checked before sending; the value is never part of an
error message). CSRF and Origin handling are unchanged: every unsafe method carries the
in-memory CSRF token.

### Changes outside the planning feature (listed exactly)

- `features/auth/session-api.ts`: `PUT` method (no body, like `DELETE`), `editLeaseToken` →
  `Edit-Lease-Token` header with format check, optional `keepalive`. No other auth change.
- `features/employees/employees.test-support.ts` (test support only): records the two new options.
- `scripts/sp12-a10-browser-acceptance.mjs`: new browser acceptance harness (below).

## Executed evidence (local, Windows, Node 24.21.0)

| Gate | Result |
|---|---|
| `npm run lint` | passed, 0 warnings |
| `npm run typecheck`, `npm run build` | passed (the frontend build type-checks test files; Vite's >500 kB chunk notice is advisory) |
| `npm run test --workspace=frontend` | 50 files / 698 tests passed (base `13b680c`: 46 / 607) |
| `npm test` (backend unit, unchanged backend) | 34 files / 362 tests passed |
| `npm run check:public`, `git diff --check`, `node --check` of the harness | passed |
| Browser harness (below) | 14 / 14 groups passed on code head `439ac98`, no uncaught page errors, exact-tenant fixture cleanup PASS |

New frontend tests: lease controller with an injected clock (renewal cadence, same-token
renewal, refusal → lost, technical failures until expiry, overdue renewal on resume, release
deferred behind a write, start/stop/start, no logging), matrix and editor models (month lengths
incl. leap years, year-end night duty on its start date, filters, PATCH body, change texts,
roster flags), API adapter (exact routes and headers, token never in path/body, response
validation incl. lease grants), transport (PUT/PATCH/DELETE headers, keepalive, malformed
tokens refused before sending), German error texts, page tests (grid, keyboard, panel, prefill,
publish slot, unsaved-input guard, StrictMode) and editor tests (lease order, one PATCH,
another holder, conflict, lost lease, lost responses, browser re-send, deletion, CR-03,
navigation, fake-timer renewal), plus a shell integration test through `<App/>` and real
`fetch` (CSRF, Expected-Version and lease token as headers; token absent from DOM, URL, bodies
and storage). Test records are synthetic examples, not business rules.

## Real browser acceptance

`scripts/sp12-a10-browser-acceptance.mjs`: headless **Google Chrome 156.0.8078.74** through an
external, pinned **Playwright 1.64.1** (not an application dependency), the built React assets
over local HTTPS with the trusted localhost certificate, a minimal fault-injection proxy to the
unmodified NestJS build, and a verified disposable **PostgreSQL 17.11** container (tmpfs,
loopback port, unique run label, receipt recorded and re-verified; migrations `0001`–`0012`
applied once, replay no-op, `verify-db` passed). Never the development database. Locale
`de-DE`, zone `Europe/Berlin`. The backend ran with the technical setting
`SECUREPLAN_EDIT_LEASE_TTL_SECONDS=10` so renewal, expiry and takeover happen in real time.

Fixture boundary: only prerequisites are inserted directly (two synthetic tenants, accounts,
employees, project, month assignments, shift times, one foreign plan). Plans, duties, edits,
removals and leases asserted as persisted were produced through the UI and read back from
PostgreSQL. **One explicit fixture:** A09 marks the plan PUBLISHED directly, because no
publish endpoint exists yet.

| Group | Actual evidence | Result |
|---|---|---|
| A01 | Plan created through the UI; grid rows = the three assigned people (unassigned person absent), 32 column headers, one tab stop, computed `position: sticky` for header and person column | PASS |
| A02 | Real keyboard: arrows, End, Ctrl+End, Home move one focused cell (accessible names asserted); Enter opens the panel with focus on its heading; Escape closes and returns focus to the cell | PASS |
| A03 | Free cell → "Tagdienst anlegen" prefilled (date, kind, person); DAY duty with shift lead and a NIGHT duty on 31.12.; PG versions 1 with `SCHICHTLEITER`/`MITARBEITER` members | PASS |
| A04 | Editor holds a live lease owned by the admin whose stored SHA-256 hash matches a token received by this browser; token absent from DOM, URL, storage, cookies and request lines; after waiting TTL + 3 s the lease is renewed with the same hash; ONE `PATCH` with `Expected-Version: 1`, the token header, CSRF header and only the roster; PG version 2, members and audit (`DUTY_UPDATED` 1, `DUTY_MEMBERSHIP_REMOVED` 1); lease released after closing | PASS |
| A05 | A second real admin sees "wird gerade von einer anderen Person bearbeitet", no form and no delete; after the first admin closes, "Erneut versuchen" acquires (PG owner = second admin) | PASS |
| A06 | Proxy fails renewals → UI "Ihre Reservierung gilt nicht mehr", input kept, save disabled; PG lease expired; the second admin takes the slot over and saves; the first admin re-reserves → "Dienst wurde inzwischen geändert" with the unsaved input listed, no PATCH sent by the first admin; "Aktuellen Stand laden" shows the second admin's state | PASS |
| A07 | Proxy truncates the committed PATCH answer: "Ergebnis unbekannt", exactly one PATCH, one `DUTY_UPDATED`; "Aktuellen Stand prüfen" reports the save as confirmed | PASS |
| A07b | Proxy closes the connection after commit before any response byte: **Chrome re-sent the PATCH by itself** (2 sent); `Expected-Version` refused the duplicate, PG shows exactly one `DUTY_UPDATED`; the UI showed the conflict state and "Aktuellen Stand laden" ended in the verified saved state | PASS |
| A08 | Inline confirmation (focused heading, member count); cancel writes nothing; confirm → ONE `DELETE`, PG `removed_at` set, no active members, lease released by the removal, `DUTY_REMOVED` 1 | PASS |
| A09 | Fixture-published plan: status and editor say changes apply at once; an edit persists immediately; plan stays PUBLISHED with unchanged `published_at`; none of the recorded write request lines (duty PATCH/DELETE, lease requests) contains "publish" | PASS |
| A10 | Leaving the page with an open editor (`about:blank`): the `pagehide` keepalive release reaches the server (PG `released_at` set) | PASS |
| A11 | 1024 px and 390 px: no horizontal page scroll; the matrix frame scrolls (`overflow-x: auto`); the panel opens below the matrix and is usable | PASS |
| A12 | Foreign plan id → "Nicht gefunden", no foreign data, foreign rows unchanged; EMPLOYEE account → "Kein Zugriff auf diese Ansicht" | PASS |
| A13 | Logout with an editor open; Back, Forward, Refresh show only the login and no plan data; no duty write after logout; the lease is no longer live within TTL + 5 s; no token exposure | PASS |

Screenshots and the JSON report stay in a private directory outside Git. A local test proxy is
not evidence for a deployed proxy. Reproduce with the [disposable PostgreSQL prerequisite](../testing/disposable-postgres.md),
a build, the local trusted TLS certificate, the login HMAC/denylist environment, an external
Playwright 1.64.1 (`SECUREPLAN_PLAYWRIGHT_MODULE` = absolute `playwright/index.mjs`) and
`SECUREPLAN_BROWSER_OUTPUT_DIR` outside Git, then `node scripts/sp12-a10-browser-acceptance.mjs`.

NOT_RUN locally: backend `npm run test:e2e` and `npm run test:scripts` (backend and scripts
unchanged; CI runs them on the PR), screen-reader, cross-browser and device acceptance, a
60–100-person month (Phase 5.10 follow-up), owner UX sign-off, production performance and load.

## UX decisions for review

- **Focus editor edits one duty, not one cell.** The approved low-fi editor shows
  Frei/TAG/NACHT per cell. A move between a day and a night duty would need two separate,
  non-atomic writes (remove from one duty, add to the other). The editor therefore edits one
  duty per save; the cell panel leads to the right duty with the cell's person first. Moving a
  person between duties is two explicit saves.
- **Per-duty saving.** The wireframe's page-wide "Speichern" is replaced by one save per duty
  (one atomic server write each); there is no page-wide draft.
- **No month stepping on the plan page.** Months are switched in the overview (one plan per
  project and month).
- A person may hold a day and a night duty on the same date when the server's overlap rule
  allows it (adjacent intervals); the cell then shows "Tag + Nacht".

## Known limitations

- **Time display (unchanged follow-up):** duty times are shown in the device's zone with the
  zone named. Showing the authoritative company zone needs a separately approved API contract
  decision; no field is proposed or added here.
- **Clock skew:** renewal timing uses the client clock against the server's `expiresAt`. A
  skewed client renews more often or gives up early; it can never extend a lease (the server
  checks every renewal and write).
- **Background tabs:** browsers may delay timers; an overdue renewal runs when the tab becomes
  visible again. A lease that lapsed meanwhile is reported as lost; the input stays.
- **Logout with an open editor:** the release after the session ended is refused; the lease
  runs out after its TTL.
- **Browser re-send (A07b):** Chrome may re-send a write whose connection closed before any
  response byte. `Expected-Version` keeps it from applying twice; the UI first shows a
  conflict and resolves it to "saved" when the admin loads the current state.
- **Other admins' changes** appear after reload or when an editor reads the duty; there is no
  push update.
- A re-read of the duties replaces the local view (server state is authoritative).

## SP-13 integration handoff (Initial Publish)

- Render the publish action through `publishSlot` on `MonthlyPlanningSection`
  (`PublishSlot` in `MonthlyPlanPage.tsx`). It receives the current `plan` and `project`,
  `hasUnsavedChanges` (panel input unsaved or a write in flight) and `onPlanChanged`; call the
  latter with the server's answer after a successful first publication and the page shows the
  PUBLISHED status and CR-03 wording without a reload. Without a slot the page keeps the text
  "Das Veröffentlichen ist in dieser Ausbaustufe noch nicht verfügbar."
- Add the publish call to `MonthlyPlansApi` with the same response validation (`toMonthlyPlan`)
  and its own German error texts in `planning-errors.ts`.
- Editors re-read the plan whenever they are granted a lease, so a plan published in another
  tab is reflected there; duty edits after publication need no further UI change (CR-03).
- Publish takes the plan lifecycle row `L` in `UPDATE` mode under ADR-0006's prefix; duty
  writes hold it in `SHARE`. A publish while an editor is open is a server-side ordering
  question, not a UI one; the UI needs no lease for publishing unless SP-13 approves one.
