# SP-21 S7 — Real-Browser Acceptance (REJECT and APPROVE without replacement)

Status: **EXECUTED — awaiting Tech Lead S7 acceptance review.** Not a merge, closeout or release decision.

| Item | Value |
|---|---|
| Authorization | [TL comment on #38](https://github.com/takh86/SecurePlan/issues/38#issuecomment-6827886956) (2026-11-12) |
| Test contract | [`sp21-s6-closeout.md`](sp21-s6-closeout.md) §7 (B-01..B-26) and §9 |
| Approved baseline (production code under test) | `b2b45ceda0d490ccca448d2152b8c569f6c71bd7` |
| Harness commit of the evidence runs | `57abe564d4c3b9a389b39d3455b8f37392826550` (= baseline + `scripts/sp21-s7-browser-acceptance.mjs` only; tracked tree clean, recorded by the harness) |
| Browser | Google Chrome 157.0.8103.51 (Playwright 1.64.1, `channel: 'chrome'`, headless), locale `de-DE`, time zone Europe/Berlin |
| Viewports | Desktop 1280×800; mobile emulation 390×844 (DPR 3, `isMobile`, `hasTouch`) |
| Runs | Evidence run A 15:55:19–15:56:35 UTC and repeat run B 15:56:38–15:57:52 UTC (2026-11-12), both **26/26 PASS** on the same fresh target |
| Evidence | [`sp21-s7-evidence/`](sp21-s7-evidence/): `run-A.json`, `run-B.json` (sanitized), 15 screenshots of synthetic data |

Evidence classes in this document: **BROWSER** = real Chrome → real Vite frontend → real NestJS API → real
PostgreSQL 17. No jsdom, no stubbed fetch. Where the harness intercepts traffic (B-11/B-12/B-20/B-21/B-22/B-23), the case
says exactly what was intercepted and what reached the backend.

## 1. Environment and safety (S7-0)

1. **Isolated worktree/branch** `test/sp21-s7-browser-acceptance` created from the exact baseline SHA. The primary
   checkout (with its two locally modified migrations 0006/0007), the other worktrees, the developer Docker Compose stack
   and its volume were **not touched**.
2. **Disposable PostgreSQL 17**: new `postgres:17` container per run identity, label `secureplan.disposable-test=<run id>`,
   tmpfs data directory, no mounts, loopback-only port, random credentials kept outside Git. The receipt was recorded
   with `node scripts/disposable-test-target.mjs record` and reverified read-only **before** the first migration, before
   every harness run and before backend start. The harness itself calls `verifyRecordedTestTarget()` before any write.
   - Evidence target: run id `sp21-s7-937efe6e3af4`, PostgreSQL 17.11, 0 public tables before migration.
   - A first (development) target `sp21-s7-5196decbf529` was used to build the harness; it was removed after rechecking its
     exact container id and label. Its runs are **not** used as evidence.
3. `node scripts/migrate.mjs` twice: run 1 applied 20 (0001..0020), run 2 applied **0** (20 "Already applied");
   `node scripts/verify-db.mjs` exit 0.
4. Services, loopback only:
   - Backend `apps/backend/dist/main.js` (`npm run build` at the baseline) on `127.0.0.1:3000`, `DATABASE_URL` = the
     verified target, `APP_ORIGIN=https://localhost:8444` supplied per process (no `.env*` edits).
   - Frontend Vite dev server (`vite --port 8444 --strictPort`) with the local mkcert certificate.
   - **Deviation from §7.1 step 3:** port 8443 was occupied by the developer's running Docker Compose frontend, which
     must not be touched. S7 therefore used `https://localhost:8444` for both the browser origin and `APP_ORIGIN`.
     There was no code or config change; the Origin/CSRF rules apply unchanged.
   - Reachability: `GET https://localhost:8444/api/v1/health/ready` → 200 through the Vite proxy to the real backend.
5. **Synthetic data only**:
   - Two tenants. A: `ADMIN-A1`, `ADMIN-A2`, a dedicated `ADMIN-A3` for the destructive session test, `EMP-A1..A4`.
     B: `ADMIN-B1`, `EMP-B1`.
   - Names `Synthetic Alpha…Foxtrot`, e-mails `…@example.invalid`, a random password per run.
   - Identities and prerequisites (companies, accounts, employees, projects, shift configurations, project assignments)
     were inserted by SQL on the verified target.
   - Real HTTP as the real accounts did the following:
     - operating calendars, monthly plans, employee-month saves and publication;
     - one cancellation per case (EMP-A1 on Dec 1..26, EMP-B1 on Dec 3);
     - offers by EMP-A2..A4.
6. **Controlled fixtures**, all SQL on the verified disposable target only:
   - C3: EMP-A4 is set to `SICK` on the duty day after offering, so the offer is currently ineligible.
   - C3T: EMP-A4's offer is set to `WITHDRAWN`, the terminal offer.
   - B-17: the dedicated admin's session gets `absolute_expires_at` in the past.
   - B-18: the downgrade `role='EMPLOYEE'` touches exactly one row (asserted) and is restored afterwards.
7. One fixture case per destructive scenario (day → case: 1 C0, 2 C1, 3 C3, 4 C3T, 5 K09, 6/7 R10a/b, 8/9 D11a/b, 10 S12,
   11 S13, 12 T14, 13 V15, 14 X17, 24 X17b, 15 X18, 16 F19, 17 F20, 18 F21, 19/20 F22a/b, 21/22 F23a/b, 23 SPARE,
   25 B03, 26 L24).

### Reproduction

```powershell
# PowerShell, Node 24; DB env from the receipt-verified disposable target (never .env / dev DB)
node scripts/disposable-test-target.mjs record ; node scripts/disposable-test-target.mjs
node scripts/migrate.mjs ; node scripts/migrate.mjs ; node scripts/verify-db.mjs ; npm run build
$env:APP_ORIGIN='https://localhost:8444'; node --env-file=<local .env> apps/backend/dist/main.js   # terminal 1
cd apps/frontend; node ../../node_modules/vite/bin/vite.js --port 8444 --strictPort                 # terminal 2
$env:SECUREPLAN_ORIGIN='https://localhost:8444'; $env:SECUREPLAN_PLAYWRIGHT_MODULE='<scratch>/node_modules/playwright/index.mjs'
$env:SECUREPLAN_BROWSER_OUTPUT_DIR='<scratch>/out'; node scripts/sp21-s7-browser-acceptance.mjs
```

Playwright 1.64.1 was installed into a scratch directory with `--ignore-scripts` (no global tooling, no lockfile change).
The harness uses the locally installed Google Chrome.

## 2. Result matrix B-01..B-26

All rows: Chrome 157 headless; harness `57abe56` over production code `b2b45ce`; desktop 1280×800 unless stated.
Status = run A, identical in run B. "PG" = read-only PostgreSQL snapshot of the affected rows.

| ID | Objective | Status | Actual result (browser) | PG evidence |
|---|---|---|---|---|
| B-01 | Admin access | **PASS** | Queue → C1 link → case view with region „Absage ohne Ersatz entscheiden“, **Ablehnen** and **Ohne Ersatz genehmigen** enabled, SP-20 „Ersatz auswählen“ and 1 offer listed | Case snapshot identical before/after |
| B-02 | Employee access | **PASS** | EMP-A1: `/arbeitsuebersicht` and `/arbeitsuebersicht/<C1>` both show „Kein Zugriff auf diese Ansicht“; no table, no decision buttons; 0 decision requests; no „Arbeitsübersicht“ in employee nav | — |
| B-03 | Employee API | **PASS** | From the signed-in employee page (`/me` 200, valid CSRF): REJECT → **403 `ACTION_FORBIDDEN`**, APPROVE with versions → **403 `ACTION_FORBIDDEN`** | Case unchanged, decision audits Δ0, idempotency rows Δ0 |
| B-04 | REJECT confirm (C3: 2 eligible + 1 ineligible) | **PASS** | Copy contains "Zuordnung bleibt aktiv", "Ersatzbedarf wird geschlossen", "…gesetzt werden: 3 (davon aktuell geeignet: 2)"; success status; case reloads: Abgelehnt / Geschlossen / Zuordnung Aktiv, 3× „Nicht ausgewählt“, note „nicht mehr offen“, no actions left; 1 POST | `REJECTED`, need `CLOSED` v1→2, duty v unchanged, membership `ACTIVE`, 3 `NOT_SELECTED`, **5 success audits (2+3)**, 1 decision event |
| B-05 | APPROVE, 0 offers (C0) | **PASS** | Copy names removal and „Unbesetzt“, "…: 0"; success; Genehmigt / Unbesetzt / Nicht mehr aktiv; no decision actions; row stays in work queue showing „Unbesetzt“ | `APPROVED`, membership `REMOVED`, duty +1 and plan `PUBLISHED`, need `OPEN_UNFILLED` +1, no selected offer, not resolved, **4 audits** |
| B-06 | APPROVE, 1 offer (C1) | **PASS** | Offer shows „Nicht ausgewählt“ | as B-05, 1 `NOT_SELECTED`, **5 audits**, 0 replacement memberships |
| B-07 | APPROVE, 2 OPEN + terminal (C3T) | **PASS** | Copy "…: 2"; offers „Nicht ausgewählt“×2, „Zurückgezogen“×1 | 2 `NOT_SELECTED`, `WITHDRAWN` row **byte-identical** (status/decided_at/updated_at), **6 audits** |
| B-08 | Cancel | **PASS** | REJECT and APPROVE × (Abbrechen, Escape): confirmation closes, focus returns to the opener in all 4 cases; 0 decision POSTs | Case unchanged |
| B-09 | Keyboard/focus/ARIA | **PASS** (screen reader: **NOT_RUN**) | Tab ×9 reaches „Ablehnen“, `:focus-visible`, outline `solid 3px`; Tab → „Ohne Ersatz genehmigen“; Enter opens, focus on `h3` „Absage ablehnen?“; Tab order „Ablehnung bestätigen“ → „Abbrechen“; Escape closes and refocuses opener; Enter/Tab/Enter confirms (1 POST); outcome in `role=status`. ARIA tree: `region` → `group "Absage ablehnen?"` → heading, copy, two named buttons (in `run-A.json`) | REJECT applied once (2 audits + 1) |
| B-10 | Responsive | **PASS** | 390×844 emulation, touch: R10a REJECT and R10b APPROVE complete; page overflow-x 0 before/confirm/done; opener and confirm button inside the viewport; confirmation box right edge 353 px, no inner overflow, no clipped text; min. target height 42 px. Desktop 1280×800 overflow 0 (B-04/B-05 ran at desktop) | Both decided exactly once |
| B-11 | Double submit | **PASS** | Response held 1.5 s by the harness (forwarded at once). **Double-click: exactly 1 POST**; while pending: confirm, Abbrechen and SP-20 „Ersatz auswählen“ disabled. **Enter twice: exactly 1 POST** | 1 decision each; exactly 2 `COMPLETED` receipts for the two cases |
| B-12 | SP-20 vs SP-21 in one case (S12) | **PASS** | Selection confirm open → „Ablehnen“: selection confirm closes (0 open), reject confirm 1. Approve confirm open → „Ersatz auswählen“: approve confirm closes, selection confirm 1. REJECT pending (held 2 s): both „Ersatz auswählen“ buttons disabled; forced click sends **0 selection requests** | `REJECTED`/`CLOSED`, no selected offer, 1 decision |
| B-13 | Cross-tab race (S13) | **PASS** | Tab 2 opens APPROVE confirmation (earlier read); tab 1 selects + confirms → 200; tab 2 confirms → **409 `CANCELLATION_ALREADY_RESOLVED`**, confirmation closes, alert "… Die Daten wurden neu geladen.", tab 2 shows Genehmigt / Besetzt | One winner: need `RESOLVED`, 1 replacement membership; audits of the case: 1 `REPLACEMENT_OFFER_SELECTED`, 1 `CANCELLATION_APPROVED` (SP-20's), 0 SP-21-only actions; refused attempt: audits Δ0 (1 `FAILED` idempotency attempt row, allowed by TL-4) |
| B-14 | Two admins (T14) | **PASS** | A2 holds APPROVE confirmation; A1 REJECTs; A2 confirms → **409 `REPLACEMENT_NEED_NOT_OPEN`** (contract: already-resolved or version conflict), alert „Dieser Ersatzbedarf ist nicht mehr offen. Die Daten wurden neu geladen.“, confirmation closed, case reloaded | Only A1's decision: `REJECTED`/`CLOSED`, membership `ACTIVE`, 1 decision |
| B-15 | Stale duty version (V15) | **PASS** | APPROVE confirmation captured duty v1. Second session edits the duty through the real A10 planning API (lease → PATCH adds EMP-A4 → 200 → lease released): duty v1→2. Confirm → **409 `PLAN_CONCURRENT_MODIFICATION`**, alert „Der Vorgang wurde inzwischen geändert. Die Daten wurden neu geladen.“, no success, case reloads with actions | Request `OPEN`, need `OPEN` v unchanged, 0 decisions |
| B-16 | Tenant isolation | **PASS** | A1 opens tenant-B case URL → „Vorgang nicht verfügbar“; no B names/codes/project shown. POST REJECT, POST APPROVE and GET offers on B ids from A1's page → **404 `RESOURCE_NOT_FOUND`** ×3 | Tenant B case and company counters identical before/after |
| B-17 | Session expiry | **PASS** | Dedicated admin (X17), confirmation open, session expired by fixture → confirm → `POST …/decision 401` → central sign-out to „Anmelden“; **1 API call total** (no loop); no success. Variant X17b: sign-out in a second tab → the first tab is signed out by the cross-tab session broadcast before any confirm is possible; **0 decision POSTs**; lands on login | Both cases unchanged |
| B-18 | Role downgrade (X18) | **PASS** | ADMIN-A2 confirmation open; fixture SQL downgrades exactly 1 row; confirm → **403 `ACTION_FORBIDDEN`**, alert „Für diese Aktion fehlt die Berechtigung. Laden Sie den Vorgang neu, …“; **exactly 1 request** afterwards (no refetch loop); no success | Case unchanged; decision audits Δ0, all audits Δ0. Role restored |
| B-19 | Offline before delivery (F19) | **PASS** | Browser context offline → confirm → alert „Das Ergebnis ist nicht bestätigt …“, only „Erneut bestätigen“, Abbrechen disabled, SP-20 hidden. Online → retry with **same key and body** (equality booleans) → success | **Before retry: 0 writes, idempotency rows Δ0** (request never reached the server); after: exactly 1 decision, +1 receipt |
| B-20 | Lost response after commit (F20) | **PASS** | Harness route forwards the APPROVE to the real backend (upstream **200**, 1 forward) and then resets the browser connection → uncertain state. Retry: same key/body/`Expected-Version` → **200 `Idempotency-Replayed: true`**, decided state shown | **Before retry:** already `APPROVED`, 1 decision, 5 audits (4+1), `COMPLETED` receipt. **After:** snapshot identical, audits Δ0, receipts unchanged |
| B-21 | Synthetic 5xx (F21) | **PASS** (UI handling only) | Harness answers with a synthetic 503 problem **without forwarding** → uncertain state; retry same key → 200 (not a replay) → decided | Before retry: 0 writes, idempotency Δ0; after: exactly 1 decision. **Proves only the UI reaction to a 5xx**, not server atomicity (S2, S4 A6/A7) |
| B-22 | Reload with uncertain intent | **PASS** | (a) F22a: APPROVE committed, response lost, reload → Genehmigt / Unbesetzt, 0 decision buttons, no success or uncertain text; a separately sent REJECT with a new key → **409 `CANCELLATION_ALREADY_RESOLVED`**. (b) F22b: offline → uncertain, reload online → open case with buttons, no uncertain text; new confirmation uses a **new key** → success | (a) 1 decision, unchanged by the stale request; (b) 0 decisions before reload, exactly 1 after. **No double write, no misleading success** |
| B-23 | Case/account switch in flight | **PASS** | Response held 3 s (forwarded at once). (a) Confirm on F23a, then in-app switch to SPARE: after the late response no success/uncertain text, SPARE buttons enabled. (b) Confirm on F23b, then sign out and sign in as ADMIN-A2: no late message | (a) F23a exactly 1 REJECT, SPARE untouched; (b) F23b exactly 1 APPROVE |
| B-24 | UI ↔ DB consistency | **PASS** | 15 decided cases: Absage, Ersatzbedarf, Ursprüngliche Zuordnung, offer badges and open count equal the PG snapshot. Work queue (month 2026-12, all pages) lists exactly the PG pending set (15 = 15). Back-navigation from a case keeps `month`, `sortBy`, `sortOrder` (the app canonicalizes the parameter order) | Per-case snapshots in `run-A.json` |
| B-25 | Storage | **PASS** | `localStorage`, `sessionStorage` and IndexedDB were empty in every page still open at the end (2× ADMIN-A1 desktop/mobile, ADMIN-A2) | — |
| B-26 | Resubmission | **PASS** | EMP-A1 (own browser session): the REJECTED duty is still listed and a new cancellation → **201**; the APPROVED duty is no longer listed; retry on it → **409 `CANCELLATION_ASSIGNMENT_NOT_ACTIVE`** | Rejected assignment: 1 `REJECTED` + 1 new `OPEN`; approved assignment: only the 1 `APPROVED` |

**Totals:** 26 PASS, 0 FAIL, 0 BLOCKED (runs A and B). Tenant A after run A: 18 SP-21 decisions made through the UI →
exactly **18 `COMPLETED` decision receipts** and 18 SP-21 decision audits (+1 approval from the B-13 SP-20 winner).
There were 4 `FAILED` attempt rows from refused attempts (B-13/B-14/B-15/B-22a), as allowed by TL-4. Tenant B
was unchanged (6 setup audits, 0 decision rows).

Browser console (run A): 0 uncaught page errors and 0 "other" errors. All logged errors are expected resource
failures provoked by the tests:

| Category | Count | Cause |
|---|---|---|
| 401 | 19 | Session bootstrap before each sign-in, plus B-17 |
| 403 | 3 | B-03, B-18 |
| 404 | 4 | B-16: case page load plus 3 fetches |
| 409 | 5 | B-13, B-14, B-15, B-22a, B-26 |
| `ERR_INTERNET_DISCONNECTED` | 2 | B-19, B-22b |
| `ERR_CONNECTION_RESET` | 2 | B-20, B-22a |
| 503 | 1 | B-21 (synthetic) |

### Optional and partial targets

| Target | Status |
|---|---|
| Firefox desktop | **NOT_RUN** (not executed; optional per §9.3) |
| Physical mobile device | **NOT_RUN** (390×844 is Chrome device emulation, not a phone) |
| Screen reader (NVDA/VoiceOver) | **NOT_RUN** — no screen reader in the headless harness. Only the accessibility tree (roles, names, `status`/`alert` regions, focus) was checked, which is a proxy, not an SR observation |
| Headed (visible) Chrome | NOT_RUN; all runs headless Chrome 157 (same engine) |

## 3. Fault-scenario commit boundary (what reached the backend)

| Case | Reached backend on 1st attempt? | Committed before retry/reload? | Proof |
|---|---|---|---|
| B-19 | No (browser offline) | No | 0 rows, idempotency Δ0 |
| B-20 | Yes (harness forwarded, upstream 200) | Yes | `COMPLETED` receipt, 5 audits before retry; replay header `true`, Δ0 after |
| B-21 | No (synthetic 503, not forwarded) | No | 0 rows, idempotency Δ0 |
| B-22a | Yes (forwarded, connection reset) | Yes | 1 decision before reload; stale request 409, Δ0 |
| B-22b | No (offline) | No | 0 decisions before reload; 1 after new-key confirmation |
| B-23a/b | Yes (forwarded at once, response held 3 s) | Yes | 1 decision each; no UI effect in the new context |

## 4. Defects, deviations and risks

**No H-risk deviation found:** no double write, no tenant breach, no incorrect authority and no misleading success,
including B-22. **No new production defect was filed.** Observations for Tech Lead review:

| # | Observation | Severity | Note |
|---|---|---|---|
| O-1 | Origin `https://localhost:8444` instead of 8443 (port held by the untouched developer Compose stack) | Info | No code/config change; same Origin/CSRF enforcement |
| O-2 | B-13 is a deterministic ordered race (tab 1 commits, then tab 2), not simultaneous submission | Low (coverage) | Truly parallel races are backend evidence (S2 races, S4 A5) |
| O-3 | Screen reader not observed (NOT_RUN); Firefox and a physical phone not run | Coverage gap | Optional/where-supported per §9.3; human SR check recommended before release |
| O-4 | B-25 inspected the pages open at the end (3 admin pages); employee contexts had been closed after their cases | Low (coverage) | The app code contains no Web Storage writes for these flows (§3.4) |
| O-5 | B-17 second-tab sign-out variant: the cross-tab broadcast signs the first tab out before a confirm is possible, so the 401 path was exercised via the expiry fixture | Info | Safer than expected; both paths end on the login view without a write |
| O-6 | Exact 409 codes observed: B-13 `CANCELLATION_ALREADY_RESOLVED`, B-14 `REPLACEMENT_NEED_NOT_OPEN`, B-15 `PLAN_CONCURRENT_MODIFICATION`, B-26 `CANCELLATION_ASSIGNMENT_NOT_ACTIVE` | Info | All within the contract's expected sets |
| O-7 | Harness iterations before the evidence runs failed on harness defects only: numeric casting, hidden mobile nav, an audit metric that also counted SP-20's `CANCELLATION_APPROVED`, URL parameter order. Fixed in the harness; no expectation about the app was changed | Info | Development target discarded |

Still open and unchanged by S7:
- **#125** physical receipt retention (HARD real-PII release blocker);
- **#124** SP-20 mutable replay (not tested or claimed fixed here);
- **#123** `OPEN_UNFILLED` closure (PO decision);
- **#118** flaky E2E;
- **#121** notifications;
- **#51** pre-staging gates.

Issues #38/#39 remain OPEN.

## 5. Evidence handling

The published JSON contains:
- statuses, codes, versions, counts and equality booleans;
- HTTP paths with ids replaced by `:id`;
- the disposable run id.

It does **not** contain:
- idempotency keys, cookies, CSRF tokens or passwords;
- receipt bodies or the cluster identifier;
- connection strings or local paths.

Key/body/version comparisons happened inside the harness before redaction. Screenshots show synthetic data only
(`Synthetic …`, `S7-…`, `…@example.invalid`). No HAR file was recorded.

## 6. Validation of this slice

| Check | Result |
|---|---|
| S7 browser runs A and B (exact harness `57abe56`, clean tracked tree) | 26/26 PASS each |
| Migrations twice + `db:verify` on the verified target | PASS (20 / 0 / exit 0) |
| `oxlint` on the harness; `npm run lint` | 0 warnings, 0 errors |
| `npm run check:public`; `git diff --check` | PASS |
| Production code, schema, API, `.env*` changed | **No** (harness, this report, evidence only) |
| Full Foundation CI on the PR head | See PR (push and PR runs) |
