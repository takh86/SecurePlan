# SP-13 — First Publish React dialog

Date: 2026-11-03. Branch `agent/claude/sp13-publish-ui` from `main@0e8e912` (SP-13 backend #86
and the A10 matrix/editor #87 merged). Refs #28, #29. Draft PR to `main`; no merge, issue
closure, staging or deployment is part of this work. Backend handoff:
[`sp13-react-publish-handoff.md`](sp13-react-publish-handoff.md); contract:
[`sp13-initial-publish-contract.md`](sp13-initial-publish-contract.md).

## Scope

A COMPANY_ADMIN React interface for the existing endpoint
`POST /api/v1/monthly-plans/{planId}/publish`, mounted in the existing `PublishSlot` of the A10
plan page. No backend, controller, service, migration, locking or error-contract change; no
dependency, lockfile, CI or `.env` change. Draft PR #91 (employee-month preview) and the Codex
branches are untouched; the employee-month save is not connected.

| Area | Delivered |
|---|---|
| Transport | `session-api.ts`: explicit `noBody` option. A POST with it sends no body (not even `{}`) and no Content-Type, but keeps CSRF, same-origin credentials and `no-store`. POST/PATCH without it are unchanged (`{}` when `body` is omitted). A bodyless request that also carries a body is refused before sending |
| API client | `publish(planId, idempotencyKey)`: bodyless POST, key syntax (8–128 visible ASCII) checked before sending, key only as the `Idempotency-Key` header, no Expected-Version or lease token. The answer must be this plan as PUBLISHED with `publishedAt`; anything else is an unreadable answer (outcome unknown) |
| Trigger | "Monatsplan veröffentlichen …" in the plan status, only for UNPUBLISHED plans. Kept focusable with `aria-disabled` and a visible reason (`aria-describedby`) while the project is inactive, the focus panel holds unsaved input or a write is running, or the duties are not loaded |
| Dialog | Native `<dialog>` opened with `showModal()` (page inert, top layer), `role="alertdialog"`, named by its heading and described by the intro. Names project and month; summarises duties, unstaffed duties and planned people; notes neutral unavailability hints (no reason); says the server re-validates everything, later duty changes apply directly (CR-03), the step cannot be undone and no notification is sent. An empty plan is allowed (no invented minimum). Initial focus on "Abbrechen" (least destructive) |
| Confirmation | Re-reads the duties; only if they still match what the admin saw (identity, version, date, kind, interval, members, roles, sources, availability hints) is ONE POST sent under a NEW UUID key. Otherwise nothing is sent and the duties are reloaded for a fresh decision |
| Double submit | A synchronous guard plus `aria-disabled` while a request runs: double clicks, repeated Enter, clicks on "Abbrechen" and Escape do nothing until the answer |
| Unknown outcome | No answer, an unreadable answer, a 5xx, a 429 or `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` never count as success or failure. The plan is re-read; PUBLISHED settles it. Otherwise the dialog says the outcome is open (a still UNPUBLISHED read is explicitly not taken as a rollback) and offers "Erneut anfragen" with the SAME key (after Retry-After 1 s for the in-progress case) or "Vorgang verlassen und Stand laden" (the key is dropped; plan, project and duties are re-read) |
| Replay | A same-key resend answered by the server's replay is the same logical 200; the success text says the resend confirmed the publication and that nothing was published twice |
| Refusals | `MONTHLY_PLAN_ALREADY_PUBLISHED`, `PLAN_CONCURRENT_MODIFICATION`, `PROJECT_INACTIVE`, `SHIFT_CONFIGURATION_MISSING`, the staffing codes and concealed 404: German alert that names no duty or person, then plan, project and duties are re-read; the next attempt is a new decision with a new key. 400 (key/body) is shown as a client defect; 401/403 keep the shared session/permission texts |
| Result | PUBLISHED is shown only from a successful/replayed answer or a confirming read; the notice takes focus. No re-publish action exists for a PUBLISHED plan |
| Page integration | `PublishSlotProps` gained `duties` (the duties on screen, null while no current read exists) and `onReload`. A reload keeps the matrix, an open panel and the publish outcome on screen (the plan context read is retained until replaced); the plan status only ever moves UNPUBLISHED → PUBLISHED in the view, so a late older read cannot undo a shown publication |

### Changes outside the planning feature (listed exactly)

- `features/auth/session-api.ts`: the `noBody` option (above). No other auth change.
- `shared/api/api-error.ts`: `MONTHLY_PLAN_ALREADY_PUBLISHED` trusted with status 409 only
  (approved backend catalogue); `api-error-fields.test.ts` updated accordingly.
- `features/employees/employees.test-support.ts` (test support only): records `noBody`.
- `shared/ui/native-dialog.test-support.ts` (test only): jsdom 30 implements no
  `showModal()`/`close()`; the stand-in opens/closes and fires `close`. It cannot prove modality,
  which the browser run does.
- `scripts/sp13-publish-browser-acceptance.mjs`: new browser acceptance harness (below).

## Executed evidence (local, Windows, Node 24.21.0)

| Gate | Result |
|---|---|
| `npm run lint` | passed (both workspaces) |
| `npm run typecheck`, `npm run build` | passed (the frontend build type-checks test files; Vite's >500 kB chunk notice is advisory and pre-existing) |
| `npm run test --workspace=frontend` | 52 files / 794 tests passed (base `0e8e912`: 50 / 698) |
| `npm test` (backend unit, unchanged backend) | 35 files / 375 tests passed |
| `npm run test:e2e` (backend HTTP/DB, unchanged backend) on the verified disposable PostgreSQL below | 49 files / 1249 tests passed |
| `check-public`, `reissue-employee-activation`, `disposable-test-target`, `migration-safety` script tests | 21 / 21 passed |
| `npm run check:public`, `git diff --check`, `node --check` of the harness | passed |
| Browser harness (below) | 15 / 15 groups passed on code head `afb596f` (tracked tree clean; the harness ran from the working tree and is committed unchanged in the following commit), no uncaught page errors, exact-tenant fixture cleanup PASS. Two earlier runs: run 1 stopped in P02 on a harness defect (Playwright does not click an `aria-disabled` control without `force`), run 2 passed 15/15 before console errors were categorised |

New and extended frontend tests (derived from the handoff's acceptance list):

- transport: bodyless POST (no body, no Content-Type, CSRF + key header, key not in URL), default
  POST still `{}`, body + `noBody` refused before sending, 401 still reported to the session boundary;
- API client: exact request (only path, method and key), response validation (wrong plan,
  UNPUBLISHED, missing/local `publishedAt`, empty), replay equals the first answer, malformed keys
  refused before sending, errors passed through without retry;
- model: summary (incl. empty plan), order/case-independent change signature and each detected
  change kind (incl. a new unavailability without a new version), outcome classification table,
  UUIDv4 key per decision;
- German texts for every publish refusal ("Der Plan wurde nicht veröffentlicht."), neutral
  unavailability, no re-publish wording, lost/in-progress texts that claim nothing;
- page/dialog (jsdom, real routes, in-memory company following the contract's precedence):
  modal alertdialog with summary and focus, cancel by button/Escape/native `cancel`/browser
  `close` with focus return and no request, StrictMode, double click/Enter/Escape during the
  request, empty plan, inactive project, unloaded duties, unsaved panel input, a clean open editor
  keeping its lease and switching to the CR-03 wording, three kinds of concurrent change detected
  before sending, already published by another admin, project deactivated meanwhile, server
  staffing refusal, eleven definitive refusals with/without reload and a new key afterwards,
  failed pre-send check, lost answer verified by GET, same-key resend after a lost request,
  replay after a lost answer plus failed check, 500 with reference ID, in-progress with the 1 s
  delay, leaving an open outcome by button or Escape and a new key afterwards.

Mocked UI tests do not establish browser end-to-end completion; the browser run below does that
for the listed cases only.

## Browser acceptance — real Chrome → built React → NestJS → disposable PostgreSQL

`scripts/sp13-publish-browser-acceptance.mjs`, executed from this worktree with the private `.env`
supplying only non-database settings (`DATABASE_URL` set explicitly, process env wins). Target:
fresh labelled tmpfs `postgres:17` container on a loopback-only port, run ID
`sp13-publish-ui-20261103072742`; receipt recorded and re-verified before migration, harness
and E2E; `scripts/migrate.mjs` applied 13 migrations, the second run applied none; `verify-db.mjs`
passed (including the SP-13 idempotency relation). Chrome 156.0.8078.80 (installed channel,
normal certificate validation), external pinned Playwright 1.64.1, de-DE, Europe/Berlin.

Fixture boundary: only prerequisites are inserted directly (companies, accounts, employees,
projects, month assignments, shift times, one foreign-tenant plan). Every plan, duty,
publication, project deactivation and employee change is produced through the UI by one of two
administrators and read back from PostgreSQL. **No publication is written by SQL.** The proxy
only observes, drops an answer after commit, refuses to forward (502) or fails one plan read
(502); it never alters a forwarded request.

| Group | Verified |
|---|---|
| P01 | plan, a staffed day duty and an unstaffed night duty created through the UI; the action is offered with `aria-haspopup="dialog"` |
| P02 | unsaved create-form input blocks the action with its reason; a click opens nothing; discarding unblocks; no request |
| P03 | Enter opens a real modal dialog (`:modal`), focus on "Abbrechen", summary "2 (davon 1 ohne Besetzung)" / 2 people; the back link under the backdrop is not hit; six Tab presses never reach the page; Escape cancels, focus returns, nothing sent, plan UNPUBLISHED |
| P04 | double click: exactly one POST, 0 body bytes, no Content-Type, UUIDv4 key, CSRF token, same Origin, no Expected-Version/lease token; 200, `Idempotency-Replayed: false`, `Cache-Control: no-store`; DB PUBLISHED by this admin, one `MONTHLY_PLAN_PUBLISHED` audit (old/new values), one COMPLETED reservation whose hash equals SHA-256 of the browser's key; outcome focused; no re-publish action; key not in the DOM |
| P05 | CR-03: an editor change after publication applies directly; status and `published_at` unchanged; no second publish/audit |
| P06 | answer truncated after commit: no automatic resend; the GET confirms PUBLISHED; one audit |
| P07 | answer truncated after commit AND the check read fails (502): the outcome stays open, nothing claimed although the DB is PUBLISHED; "Erneut anfragen" sends the same key and gets 200 with `Idempotency-Replayed: true`; still one audit and one reservation |
| P08 | POST never forwarded (502): the read shows UNPUBLISHED, the outcome stays open; the same-key resend is the first execution (`replayed: false`); one audit |
| P09 | the second admin adds a duty while the dialog is open: nothing is sent, alert, the matrix reloads with the new duty; a new decision publishes |
| P10 | the second admin publishes first: the first admin's POST gets 409 `MONTHLY_PLAN_ALREADY_PUBLISHED`, the view reloads to PUBLISHED, no re-publish; `published_by` is the second admin; two different keys; one audit |
| P11 | the second admin deactivates the project through its page: 409 `PROJECT_INACTIVE`, the action becomes unavailable with its reason, also after a page reload; plan UNPUBLISHED, no audit |
| P12 | 390 px: the dialog stays within the viewport, no horizontal page scroll |
| P13 | the second admin changes a night-duty member to day-only eligibility (no future-duty guard exists for that field): 409 `EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT`, nothing published, no audit |
| P14 | a foreign tenant's plan shows "Nicht gefunden" without data or publish action; foreign rows unchanged |
| P15 | totals: each published plan has exactly one publication, one audit and one COMPLETED reservation; every forwarded key exists only as its hash, no raw key stored; no page errors |

Browser console errors are counted by category only (no text or URLs in evidence): 11 in total,
all failed requests the harness caused on purpose — `http-401` ×2 (session check before login,
two contexts), `net::ERR_CONTENT_LENGTH_MISMATCH` ×2 (P06/P07 truncation), `http-502` ×2
(P07/P08), `http-409` ×3 (P10, P11, P13), `http-404` ×2 (P14 concealed plan and entries); `other`
0 (asserted). Screenshots of the dialog (desktop, 390 px) and the result JSON are private
evidence outside Git.

## NOT_RUN

- GitHub CI on this branch — pending until the Draft PR's checks complete.
- `scripts/activation-demo.test.mjs` — its guard accepts only the development DB (CI covers it).
- Screen readers (NVDA/JAWS/VoiceOver) — semantics checked through roles, names, focus and live
  regions in Chrome and jsdom only.
- Browsers other than Chrome 156 (Firefox/Safari dialog and Escape behaviour), real mobile devices.
- In the browser: `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` (needs a concurrent claim; covered in
  jsdom and by the backend concurrency suite), 401 session loss during a publish (jsdom only), a
  connection reset that Chrome may transparently re-send (truncation and gateway faults used
  instead), and Chrome's forced close after repeated close requests while a request runs (handled
  in code via the dialog's `close` event, not exercised).

## Integration dependencies and limitations

- **#90 project calendar and exclusive-day guards are not implemented.** Publication currently
  re-validates only the existing SP-11/SP-12 rules (project active, configuration, employee
  active/employed/assigned/eligible/unavailable, overlap). The UI adds no client-side calendar or
  exclusivity rule and must not be read as covering them. **The overall planning/publishing system
  is not ready for staging** until the server-side #90 guards (and the #51 operational gates named
  in #86) pass their own acceptance.
- PR #91's employee-month "Monat speichern" remains unconnected; its atomic save contract (#88)
  is not approved.
- The pre-send duty check narrows, but cannot close, the window between that read and the POST:
  by contract the publish API carries no plan version. The server still re-validates every rule,
  so a published plan is always rule-valid, but a change another admin commits within that window
  would be published without having been shown. A stricter guarantee needs a contract decision.
- Leaving the page while a publish request is in flight does not cancel it; reopening the plan
  shows the server state. The page's navigation guard is not extended to publishing (the modal
  dialog makes in-app links inert; browser Back still works).
- The client does not read `Idempotency-Replayed`; a replay is handled as the same logical 200.
- No notification or delivery promise (per contract). The plan status text from #87 says that
  employees see a published plan; personal plan reads (SP-14) are not implemented, so that
  sentence describes intended behaviour. The dialog deliberately makes no visibility promise.
  Recommended follow-up: align that status text once SP-14 is scoped.
