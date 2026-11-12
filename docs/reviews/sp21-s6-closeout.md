# SP-21 S6 — Documentation and Closeout (REJECT and APPROVE without replacement)

Slice: S6 documentation only. No production code, migration, API contract, test, Docker or database change.
Authorization: Tech Lead S6 gate on [issue #38](https://github.com/takh86/SecurePlan/issues/38#issuecomment-6821292203)
(2026-11-12): S6 implementation GO (docs-only), **S6 merge HOLD, S7 HOLD**.

| | |
|---|---|
| Base (`origin/main`, S5 post-merge baseline) | `83848a2ce688f3dc6c8f427ca65768fcb0b7ef8b` |
| Branch | `docs/sp21-s6-closeout` |
| Head | see the Draft PR (the head commit cannot name itself) |
| Changed files | this report (new), `docs/api/README.md`, `docs/README.md`, `docs/project-status.md` (dated SP-21 addendum) |

Evidence rule: DOCUMENTED ≠ IMPLEMENTED ≠ VERIFIED ≠ PRODUCTION READY. This report adds no new test evidence. It
collects evidence from S1–S5 and labels its source:

| Label | Meaning |
|---|---|
| **REVIEWED** | Source/contract reviewed and accepted by the Tech Lead in a dated gate comment on #38 or a PR review |
| **AUTHOR** | Local results reported by the slice author in the PR body / S4 matrix (disposable PostgreSQL 17, synthetic data) |
| **CI** | GitHub Actions `Foundation CI` run on the exact SHA; job and step conclusions re-queried for this report (2026-11-12) |
| **NOT_RUN** | Not executed by anyone; no claim is made |

**Status in one line:** SP-21 REJECT and APPROVE-without-replacement are implemented end to end (DB receipt, service,
HTTP API, React admin UI) and verified by backend real-PostgreSQL E2E, unit and jsdom tests in CI. Real-browser
acceptance (S7) is NOT_RUN. SP-21 is **not** release-ready; #125 blocks any environment with real personal data.

## 1. Delivery history and CI evidence

All `Foundation CI` runs below have jobs `backend`, `frontend` and `verify` = **success**. The `backend` job runs, in
order: `check:public`, `npm ci`, disposable PostgreSQL identity check, `lint`, `check:replacement-api`, `typecheck`,
`build`, backend unit, `db:migrate` twice, `db:verify`, `test:scripts`, full `test:e2e` (real PostgreSQL 17),
isolated SP-19 DDL wait, backend runtime readiness. `pages-build-deployment` runs build the GitHub Pages site and are
**not** a SecurePlan application deployment.

| Slice | PR | Content | Head → merge | CI (exact head) | CI (post-merge main) | Tech Lead gate |
|---|---|---|---|---|---|---|
| S1 | [#126](https://github.com/takh86/SecurePlan/pull/126) | Migration `0020`, `DECIDE_CANCELLATION` receipt schema/codec | `836f57c` → `a583250` | [PR 42796237183](https://github.com/takh86/SecurePlan/actions/runs/42796237183) | [42801071581](https://github.com/takh86/SecurePlan/actions/runs/42801071581), [42806253919](https://github.com/takh86/SecurePlan/actions/runs/42806253919) | [S1 post-merge](https://github.com/takh86/SecurePlan/issues/38#issuecomment-6765387478) |
| S2 | [#127](https://github.com/takh86/SecurePlan/pull/127) | Transactional decision service | `55f9fe9` → `13d6eed` | [PR 42813137503](https://github.com/takh86/SecurePlan/actions/runs/42813137503) | [42814727993](https://github.com/takh86/SecurePlan/actions/runs/42814727993) | [S2 post-merge](https://github.com/takh86/SecurePlan/issues/38#issuecomment-6767336016) |
| S3 | [#131](https://github.com/takh86/SecurePlan/pull/131) | HTTP API + OpenAPI | `37ddb36` → `64329e3` | [PR 43040466284](https://github.com/takh86/SecurePlan/actions/runs/43040466284) | [43066925479](https://github.com/takh86/SecurePlan/actions/runs/43066925479) | [S3 post-merge](https://github.com/takh86/SecurePlan/issues/38#issuecomment-6803295995) |
| S4 | [#133](https://github.com/takh86/SecurePlan/pull/133) | Acceptance matrix + gap tests | `b76fec8` → `b7422a5` | [PR 43082542845](https://github.com/takh86/SecurePlan/actions/runs/43082542845) | [43087735266](https://github.com/takh86/SecurePlan/actions/runs/43087735266) | [S4 post-merge](https://github.com/takh86/SecurePlan/issues/38#issuecomment-6805611366) |
| S5 | [#134](https://github.com/takh86/SecurePlan/pull/134) | React admin decision UI + S5-READ-01 | `3987cd2` → `83848a2` | [PR 43197929543](https://github.com/takh86/SecurePlan/actions/runs/43197929543) | [43199720930](https://github.com/takh86/SecurePlan/actions/runs/43199720930) | [S5 review](https://github.com/takh86/SecurePlan/pull/134#pullrequestreview-5872706900), [post-merge → S6](https://github.com/takh86/SecurePlan/issues/38#issuecomment-6821292203) |
| S6 | [#135](https://github.com/takh86/SecurePlan/pull/135) (Draft) | Documentation and closeout | initial head `d8bef04` | initial head only: [push 43214630782](https://github.com/takh86/SecurePlan/actions/runs/43214630782), [PR 43214726309](https://github.com/takh86/SecurePlan/actions/runs/43214726309); not evidence for later commits, current-head CI is recorded on PR #135 | — | [review: changes required](https://github.com/takh86/SecurePlan/pull/135#pullrequestreview-5874306631) |
| S7 | — | Real-browser acceptance | — | — | — | **NOT authorized, NOT_RUN** |

Full SHAs: S1 `836f57c63fbab493d17aed327bca8fd89a915325` / `a58325062ae1bc89cc24345a61e9f09d05498900`; S2
`55f9fe9dfe959c015992afe08e0c0c577f5402c7` / `13d6eed0268dd468d48bef23c589f11d92d1817a`; S3
`37ddb3604823b03f96c0d2de94e381411ea2eed5` / `64329e3909ff9835c51927e6c66a2b676686e8c2`; S4
`b76fec8518be1b4b3afee21fd7dbb9c5387275ac` / `b7422a57af84ae494e6f473b18144b23c22cada5`; S5
`3987cd2dc5d48a95b3ebfd73921760175b7dbea6` / `83848a2ce688f3dc6c8f427ca65768fcb0b7ef8b`.

Contract baselines: [PO-1..PO-8 decision baseline](https://github.com/takh86/SecurePlan/issues/38#issuecomment-6762803106)
(incl. TL-1..TL-6), [S1 technical gate D-S1-1..6](https://github.com/takh86/SecurePlan/issues/38#issuecomment-6763574954),
[S5 authorization incl. S5-READ-01](https://github.com/takh86/SecurePlan/issues/38#issuecomment-6805611366).

## 2. Architecture

```text
COMPANY_ADMIN browser
  /arbeitsuebersicht/:needId  (WorkQueueCasePage, DecisionPanel; shared action state with SP-20 selection)
        │  GET  /api/v1/replacement-needs/:needId/offers  → need.concurrencyVersion, need.dutyConcurrencyVersion
        │  POST /api/v1/cancellation-requests/:requestId/decision  (via SessionApi.request: cookie, CSRF, Origin)
        ▼
AccessControlGuard (global, SP-06): Origin → session validateAndTouch → CSRF → live role ∈ @RequireRoles('COMPANY_ADMIN')
PlanningJsonGuard, CancellationDecisionBodyGuard (media type, size, parser, unknown fields)
CancellationDecisionController → CancellationDecisionService (one transaction, ADR-0006 lock rank,
        session recheck after lock wait, idempotency reservation/fence, business writes, audit, receipt)
        ▼
PostgreSQL 17: cancellation_requests, replacement_needs, replacement_offers, duties, duty memberships,
        audit rows, idempotency_records (DECIDE_CANCELLATION receipt, migration 0020)
```

| Layer | Artifacts |
|---|---|
| DB | [`0020_cancellation_decision_receipt.sql`](../../apps/backend/migrations/0020_cancellation_decision_receipt.sql) |
| Receipt | [`cancellation-decision-receipt.ts`](../../apps/backend/src/modules/cancellation-replacement/cancellation-decision-receipt.ts) |
| Service | [`cancellation-decision.service.ts`](../../apps/backend/src/modules/cancellation-replacement/cancellation-decision.service.ts) |
| HTTP | [`cancellation-decision.controller.ts`](../../apps/backend/src/modules/cancellation-replacement/cancellation-decision.controller.ts), [`cancellation-decision.dto.ts`](../../apps/backend/src/modules/cancellation-replacement/cancellation-decision.dto.ts), [`cancellation-decision-body.guard.ts`](../../apps/backend/src/modules/cancellation-replacement/cancellation-decision-body.guard.ts) |
| Read model (S5-READ-01) | [`admin-work-queue.query.ts`](../../apps/backend/src/modules/cancellation-replacement/admin-work-queue.query.ts), [`admin-work-queue.service.ts`](../../apps/backend/src/modules/cancellation-replacement/admin-work-queue.service.ts) |
| Contracts | [`cancellation-decision.openapi.json`](../api/cancellation-decision.openapi.json), [`admin-work-queue.openapi.json`](../api/admin-work-queue.openapi.json) |
| Frontend | [`WorkQueueCasePage.tsx`](../../apps/frontend/src/features/cancellation-replacement/work-queue/WorkQueueCasePage.tsx), [`work-queue-api.ts`](../../apps/frontend/src/features/cancellation-replacement/work-queue/work-queue-api.ts), [`work-queue-types.ts`](../../apps/frontend/src/features/cancellation-replacement/work-queue/work-queue-types.ts) |
| ADRs | [ADR-0004 audit catalogue](../architektur/adr/0004-related-business-audit-catalogue.md), [ADR-0006 duty edit leases / lock rank](../architektur/adr/0006-duty-edit-leases.md) |

## 3. End-to-end behaviour (COMPANY_ADMIN)

Endpoint: `POST /api/v1/cancellation-requests/:requestId/decision`, success **200** with the decision receipt. Details
and every status/code: [OpenAPI](../api/cancellation-decision.openapi.json). Only `COMPANY_ADMIN` of the session's
company may decide; `EMPLOYEE` receives 403 `ACTION_FORBIDDEN`; a request of another tenant is 404
`RESOURCE_NOT_FOUND` (concealment in SQL, not only in the error filter).

### 3.1 Request

| | REJECT | APPROVE without replacement |
|---|---|---|
| Body | `{"decision":"REJECT"}` | `{"decision":"APPROVE","expectedDutyVersion":<duty version>}` |
| `Expected-Version` header | not required; if present only syntax-checked, value ignored and **not** in the fingerprint | **required** = need version (`replacement_needs.concurrency_version`) |
| `expectedDutyVersion` | forbidden (400) | **required** = duty version (`duties.concurrency_version`) |
| `replacementOfferId` | absent or `null`; non-null → 400 `VALIDATION_FAILED` | same |
| `Idempotency-Key` | required | required |
| Fingerprint (D-S1-6) | `[decide-cancellation-v1, requestId, REJECT, null]` | `[decide-cancellation-v1, requestId, APPROVE, null, needVersion, dutyVersion]` |

### 3.2 Need Version versus Duty Version

These are two independent optimistic-concurrency counters. The **need version** changes with the replacement need
(offers, decisions). The **duty version** changes with the duty (planning edits, membership changes). APPROVE changes
both (need +1, duty +1) and must therefore prove that the admin saw the current state of both. They must never be
swapped, derived from each other or replaced by a constant. Before S5 the admin read model exposed only the need
version; S5-READ-01 added `need.dutyConcurrencyVersion`, read from `duties.concurrency_version` in the **same SQL
statement** as the need version. It is read metadata, not a lock: the command re-checks both under row locks and
answers stale values with 409. The field appears only in admin projections, not in employee views (S5 real-PG test).

### 3.3 Outcomes

| Effect | REJECT | APPROVE without replacement |
|---|---|---|
| Cancellation request | `OPEN → REJECTED` | `OPEN → APPROVED` |
| Original duty membership | stays **ACTIVE** | **REMOVED** |
| Duty | unchanged (`updatedDuty: null`) | stays **published**, version +1 exactly once |
| Replacement membership | none | none (never selected or fabricated) |
| Replacement need | `OPEN → CLOSED`, version +1 | `OPEN → OPEN_UNFILLED`, version +1, `selectedOffer: null`, `resolvedAt: null`; stays visible in the work queue |
| OPEN offers | all → `NOT_SELECTED` | all → `NOT_SELECTED` |
| Terminal offers (e.g. `INVALIDATED`) | untouched | untouched |
| Success audit events (k = finalized OPEN offers) | **2 + k** | **4 + k** |
| Notifications | none (PO-3, #121) | none |
| Time cut-off | none (PO-5 Option A) | none; a decision after duty start/end is allowed and may change the published plan and derived statistics retroactively |

Audit vocabulary (PO-2, ADR-0004): new `CANCELLATION_REJECTED`, `REPLACEMENT_NEED_OPEN_UNFILLED`; scoped
`CANCELLATION_APPROVED`, `REPLACEMENT_NEED_CLOSED`, `REPLACEMENT_OFFER_NOT_SELECTED`; reused SP-12 `DUTY_UPDATED` and
`DUTY_MEMBERSHIP_REMOVED`. One actor and one correlation id (server-issued) per decision; all in the business
transaction. The bounded audit values contain no direct names, e-mails, reasons, free text or secrets, but they **do**
contain linkable identifiers and times (actor and resource ids, `employeeId` in `DUTY_MEMBERSHIP_REMOVED` values,
duty date/start/end). They are pseudonymous personal data; access, retention and privacy controls apply (§5). Refusals and replays write **zero** business rows and zero success
audits; idempotency attempt metadata (`FAILED`) may remain (TL-4).

After APPROVE the need is `OPEN_UNFILLED`: SP-20 selection is refused (409 `CANCELLATION_ALREADY_RESOLVED` /
`REPLACEMENT_NEED_NOT_OPEN`), and **no** closure command exists. Operational closure and later duty-removal
reconciliation are #123 (not implemented).

### 3.4 Idempotency, immutable receipts and retry limits

- **Receipt.** The 200 body is generated once inside the final business transaction and stored in the same fenced
  `IN_PROGRESS → COMPLETED` update (`idempotency_records.result_json`, `result_schema_version = 1`, ≤ 8192 bytes of
  PostgreSQL JSON text, closed key sets checked by DB `CHECK`s and a strict codec). The original response is served
  from that snapshot. The receipt **contains identifiable personal data**: `cancellation.employee` with `id`,
  `employeeCode`, `firstName` and `lastName`, plus assignment/duty ids and times (decoded in
  `cancellation-decision-receipt.ts`, persisted by `cancellation-decision.service.ts`). It outlives the logical
  window because rows are not physically deleted (#125).
- **Replay.** Same key + same fingerprint within the logical window (86 400 s) returns the decision-time JSON content
  with `Idempotency-Replayed: true`, even after later duty or employee changes, without new writes or audits. The
  live role is re-checked on replay (a downgraded admin gets 403).
- **Conflicts.** Same key + different payload/versions → 409 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST`; a
  concurrent attempt → 409 `IDEMPOTENCY_REQUEST_IN_PROGRESS`; an expired completed key is re-evaluated against current
  state (a finished decision then answers its normal 409 state conflict, D-S1-5).
- **Immutability is application-level.** `CHECK`s enforce structure, not temporal immutability; a privileged DB
  writer could overwrite the JSON. `expires_at` is a **logical** expiry; rows are **not physically deleted** (#125).
- **Frontend retry.** A new key per confirmed intent; APPROVE versions are captured when the confirmation opens. On an
  uncertain outcome (network error, 5xx, `IDEMPOTENCY_REQUEST_IN_PROGRESS`, unreadable 200) the intent locks and only
  "Erneut bestätigen" resends the **same key, body and versions**. No automatic retry, no switch of decision.
- **Limitation.** The uncertain-intent state is held **in memory only** (React state). It does not survive a route
  remount, reload, case switch or sign-in change; afterwards the admin must re-read the case, and a new confirmation
  uses a new key. The server state remains authoritative (an already-applied decision then shows as decided, a new
  attempt gets 409). Nothing is written to `localStorage`/`sessionStorage`.
- **SP-20 contrast.** SP-20 selection replay rebuilds its response from mutable rows and can drift or fail after later
  duty changes (#124, open). The S5 UI improvement (same-key retry for SP-20) does **not** fix #124.

## 4. Traceability PO-1..PO-8, TL-1..TL-6, ADR-0004/0006

Test file abbreviations (backend `apps/backend/test/`): **S1** `cancellation-decision-receipt-real`, **S2**
`cancellation-decision-real`, **S3** `cancellation-decision-http-real`, **S4** `cancellation-decision-acceptance-real`
(A1–A7), **CR** `cancellation-requests-real`, **SP20** `replacement-selection-real`, **WQ**
`admin-work-queue-real`. Unit: `cancellation-decision-receipt.spec.ts`, `cancellation-decision-command.spec.ts`,
`modules/audit/cancellation-decision-audit.spec.ts`. Frontend (jsdom, fetch stubbed): **FE-UI**
`WorkQueueDecision.test.tsx`, **FE-API** `work-queue-decision-api.test.ts`. The condition-level mapping is in the
[S4 acceptance matrix](sp21-s4-acceptance-matrix.md); this table summarizes it and adds S5.

| Req. | Requirement (short) | Implemented in | Automated evidence | Evidence class | Browser (S7) |
|---|---|---|---|---|---|
| PO-1 | Finalize all OPEN offers `NOT_SELECTED`; never select/fabricate; fail closed | S2 service | S2 (k = 0/1/2, contradictory state ×3), S4 A1/A2 | REVIEWED, AUTHOR, CI | NOT_RUN |
| PO-2 | Audit vocabulary, 2+k / 4+k, atomic, no direct names/e-mails/free text/secrets (linkable ids remain) | S2 service, ADR-0004 | S2 rollback boundaries, S4 A1 (key sets, synthetic names/e-mails absent, tenant), S4 A7 (REJECT rollback via HTTP), audit unit spec | REVIEWED, AUTHOR, CI | n/a |
| PO-3 | No notifications/outbox | (absence) | S4 A1/A2 delivery double receives nothing | REVIEWED, CI | n/a |
| PO-4 | Resubmission only under current create rules | existing create rules (CR) | S4 A3 (after REJECTED/APPROVED/WITHDRAWN/OBSOLETE) | AUTHOR, CI | NOT_RUN |
| PO-5 | Option A: no new time cut-off | S2 (no time guard) | S2 "PO-5 Option A" (database clock); HTTP by inspection | REVIEWED, CI | NOT_RUN |
| PO-6 | APPROVE: membership REMOVED, duty +1, need `OPEN_UNFILLED`, visible, no late SP-20, no closure | S2, WQ read model | S2, S3, S4 A2 (work queue after real APPROVE, SP-20 refused), FE-UI APPROVE success | REVIEWED, AUTHOR, CI | NOT_RUN |
| PO-7 | Endpoint, `APPROVE`/`REJECT`, offer null, OpenAPI | S3 controller/DTO/guard, OpenAPI | S3 invalid-body table, `check:replacement-api`, SP20 coexistence | REVIEWED, CI | NOT_RUN |
| PO-8 | Gated S1–S7 delivery | process | §1 of this report | REVIEWED | S7 **NOT_RUN** |
| TL-1 | Need vs duty versions under locks; REJECT no version | S2/S3, S5-READ-01 | S2/S3 stale versions; WQ swapped versions → 409 `PLAN_CONCURRENT_MODIFICATION`; FE-API exact requests | REVIEWED, AUTHOR, CI | NOT_RUN |
| TL-2 | Fingerprint incl. both versions; REJECT header excluded | S1 codec, S2 | S1, S3 | REVIEWED, CI | n/a |
| TL-3 | Immutable typed receipt, replay after duty change | S1 migration/codec, S2 | S1, S2, S3 (byte-identical replay text) | REVIEWED, CI | NOT_RUN |
| TL-4 | Refusal = zero business writes and success audits | S2 | S2, S3 snapshots, S4 A4–A7 | REVIEWED, CI | n/a |
| TL-5 | ADR-0006 lock rank, session recheck, bounded waits, concealment, one winner vs SP-20 | S2, global guard | S2 races, S4 A4 (role downgrade/deactivation), A5 (APPROVE vs duty removal), A6 (5 s `lock_timeout` → sanitized 500, same key decides once) | REVIEWED, AUTHOR, CI | NOT_RUN |
| TL-6 | #123 / #118 / #122 kept separate | — | — | REVIEWED | n/a |
| S5-READ-01 | `need.dutyConcurrencyVersion`, same statement, fail closed, admin-only | S5 query/service/types/OpenAPI | WQ +1 test, FE parser rejection cases | REVIEWED, AUTHOR, CI | NOT_RUN |
| S5 UX | Confirm/cancel, focus, keyboard, pending, one action per case, same-key retry, 401/403/404/409 | S5 React | FE-UI (28 tests), FE-API (33 tests) — jsdom, fetch stubbed | REVIEWED, AUTHOR, CI | **NOT_RUN** |

Author-reported test counts (AUTHOR): S2 suite 65 and S3 suite 78 tests (S4 matrix §1); S4 spec 17/17 three runs; S5
61 new frontend tests, WQ/chain/S4 61 passed. Full suites at S5 head: backend unit 571, frontend 1458, real-PG E2E
2197 passed / 2 env-gated skips (one earlier run had a #118 timeout), `test:scripts` 36. CI confirms these suites
passed on each exact head (§1); CI does not report per-test counts in this document.

## 5. Security, tenant isolation and audit

- **Authentication/authorization.** Global SP-06 `AccessControlGuard` (default-deny): Origin check before cookie/DB
  access, one session `validateAndTouch`, per-session CSRF token, live DB role in `@RequireRoles('COMPANY_ADMIN')`.
  The service re-checks the session after waiting for locks (TL-5). The browser only hides/disables actions.
- **Tenant isolation.** `companyId`, actor and role come only from the validated session. All reads/writes filter by
  the session company; foreign requests are 404 without receipts. Covered by real-PG tests (S3, WQ, S4 A1 audit set).
- **Input.** Strict media type, body size bound, unknown/prototype fields, duplicate headers and query parameters are
  refused (S3).
- **Errors.** RFC 9457 Problem Details from the closed catalogue; lock timeouts are a sanitized 500 `INTERNAL_ERROR`
  without SQL/lock detail (S4 A6). The UI maps codes to a closed German allowlist; no server text passthrough.
- **Privacy.** Neither the receipt nor the audit is free of personal data:
  - The **decision receipt** holds exactly the approved response, which includes the employee's id, employee code,
    first and last name, assignment/duty ids and times. It excludes e-mails, secrets, absence reasons and free text.
    It is stored in `idempotency_records.result_json` (≤ 8192 bytes) with a logical 86 400 s replay window, but is
    **not physically deleted** after expiry. This is why #125 is a hard release blocker.
  - **Audit values** exclude direct names, e-mails, reasons, free text and secrets, but contain employee and other
    linkable ids and duty times (pseudonymous personal data).
  - Access control, retention and privacy review apply to both. S6 changes no receipt or audit schema.
- **Not performed:** automated security review **NOT_RUN**; dependency audit **NOT_RUN**; penetration test NOT_RUN.

## 6. Known defects, deferred features and release blockers

| Item | Type | Status | Effect on SP-21 | Owner / next gate |
|---|---|---|---|---|
| [#125](https://github.com/takh86/SecurePlan/issues/125) Physical retention of idempotency receipts | Security/privacy | OPEN | **HARD release blocker for any environment with real personal data.** SP-21 receipts contain employee id, code, first and last name; `expires_at` ≠ deletion; covers all JSON receipts incl. `EMPLOYEE_MONTH_SAVE` | Tech Lead + privacy review; verified cleanup before staging |
| [#124](https://github.com/takh86/SecurePlan/issues/124) SP-20 replay consistency | Defect | OPEN | SP-20 replay can drift/fail after duty changes; S5 FE retry does not fix it | Separate reviewed slice |
| [#123](https://github.com/takh86/SecurePlan/issues/123) `OPEN_UNFILLED` operational closure | Missing feature | OPEN | `OPEN_UNFILLED` staying visible is the approved PO-6 outcome; #123 may stay open while the S7 decision workflow is accepted. No closure/reconciliation exists; an APPROVE'd duty can still be removed at its current version (removed-duty / invisible-need edge). End-to-end staffing lifecycle and operational closure cannot be claimed | **PO must decide and explicitly accept deferral/residual risk before the final MVP release/demo disposition**; not required for the S6 merge; no S7 writer scope |
| [#118](https://github.com/takh86/SecurePlan/issues/118) Flaky full-suite E2E 5 s timeouts | Test infra | OPEN | Local full runs intermittently fail; reproduced on unchanged base; CI green does not prove the root cause fixed | Test-infra slice |
| [#121](https://github.com/takh86/SecurePlan/issues/121) Notifications | Deferred | OPEN | Employees are not notified of decisions (PO-3) | V1 backlog |
| [#51](https://github.com/takh86/SecurePlan/issues/51) Production hardening / operational gates | Pre-staging | OPEN | Applies to any staging/production | Before staging |
| In-memory uncertain intent | Limitation | by design | Lost on remount/reload (§3.4); acceptable within approved S5 MVP scope if S7 B-22 proves safe reconciliation | Mandatory S7 test B-22 |
| Real-browser acceptance | Gate | NOT_RUN | No browser, responsive or a11y evidence in a real browser | S7 (separately authorized) |
| Automated security review, dependency audit | Gate | NOT_RUN | — | Pre-staging |

Applicable pre-staging gates (none passed by this slice): #125 verified physical cleanup and privacy review; #51
hardening (secrets/key management, TLS/cookie deployment config, logging/monitoring, backup/restore, rate limits,
operational audit controls); dependency triage; automated security review; S7 browser acceptance; human UX
acceptance. GitHub Pages deployments are documentation only. **No application staging or production deployment
exists or is authorized.**

Issues #38 and #39 stay **OPEN**; SP-21 is not feature-complete (S7 pending) and not release-ready.

## 7. S7 browser acceptance handoff (PLANNED, NOT_RUN)

Nothing in this section has been executed. Existing automated UI coverage is jsdom with stubbed `fetch` (FE-UI,
FE-API) and does **not** count as browser evidence. S7 needs its own Tech Lead authorization.

### 7.1 Setup

1. New isolated worktree from the S6 post-merge main SHA; record the SHA.
2. New disposable PostgreSQL 17 target, identity recorded and receipt-verified with
   `scripts/disposable-test-target.mjs` **before** any migration or fixture write ([guide](../testing/disposable-postgres.md)).
   Never the development Compose volume or a shared database. `db:migrate` twice (second = 0 applied), `db:verify`.
3. Backend `npm run dev:backend` (loopback), frontend `npm run dev:frontend` on `https://localhost:8443` with
   `APP_ORIGIN=https://localhost:8443` supplied for the run without editing `.env.example`.
4. Synthetic fixtures only (no real names/e-mails), created through existing APIs where possible:
   - Tenant **A**: `ADMIN-A1`, `ADMIN-A2` (COMPANY_ADMIN), `EMP-A1`..`EMP-A4` (EMPLOYEE); one published plan with duties.
   - Tenant **B**: `ADMIN-B1`, `EMP-B1`, one OPEN cancellation case.
   - Cases in tenant A (each `OPEN/OPEN`, `CONSISTENT`): **C0** 0 offers, **C1** 1 eligible offer, **C3** 3 offers
     (2 eligible + 1 not eligible), **C3T** 2 OPEN + 1 terminal offer, plus spare cases for conflict tests.
5. Browsers (Tech Lead review of #135):
   - **Required MVP minimum:** Chromium/Chrome desktop at 1280×800 and narrow 390×844 device emulation; keyboard-only
     and focus checks; basic screen-reader checks (NVDA or VoiceOver) where the harness supports them.
   - **Optional:** Firefox desktop if readily and safely available; a real mobile device. Not hard gates; any optional
     platform not executed is logged as NOT_RUN.
6. Evidence per case: test id, SHA, browser/viewport, screenshots before/after, HAR or network log with **cookies,
   CSRF tokens, idempotency keys and receipt bodies redacted**, console log, and a read-only SQL snapshot of the
   affected rows (statuses, versions, audit action counts, `idempotency_records.state`). No personal data, tokens or
   local paths in published evidence.
7. Key, body and version comparisons between attempts happen **inside the controlled harness before redaction**.
   Only equality booleans (or safe salted hashes) are published, never the raw idempotency key, cookies, CSRF token,
   receipt JSON or PII.
8. Failure tests prove on which side of the commit boundary they failed: before and after the retry, the harness
   records read-only counts of decision rows/success audits and the `idempotency_records` state for the key.

### 7.2 Test matrix

Status of every row: **PLANNED / NOT_RUN**.

| ID | Area | Steps | Expected result | DB check |
|---|---|---|---|---|
| B-01 | Admin access | ADMIN-A1 opens `/arbeitsuebersicht`, then C1 | Case view with "Absage ohne Ersatz entscheiden", buttons **Ablehnen** and **Ohne Ersatz genehmigen**, SP-20 offers visible | none changed |
| B-02 | Employee access | EMP-A1 signs in, opens `/arbeitsuebersicht` and `/arbeitsuebersicht/<C1 needId>` by URL | No admin work queue/decision UI; route refused or redirected; no decision request sent | none changed |
| B-03 | Employee API | As EMP-A1, send the decision POST via devtools with valid CSRF | 403 `ACTION_FORBIDDEN` | none changed |
| B-04 | REJECT confirm | C3: Ablehnen → read copy → „Ablehnung bestätigen“ | Copy: membership stays active, need closed, 3 offers → "Nicht ausgewählt"; success status; case reloads as decided; no actions left | request `REJECTED`, need `CLOSED` v+1, membership ACTIVE, 3 offers `NOT_SELECTED`, 5 success audits (2+3), receipt `COMPLETED` |
| B-05 | APPROVE confirm, 0 offers | C0: Ohne Ersatz genehmigen → „Genehmigung ohne Ersatz bestätigen“ | Success; case shows approved/„Unbesetzt“; stays in work queue | `APPROVED`, membership REMOVED, duty v+1 and still published, need `OPEN_UNFILLED` v+1, selected offer null, 4 audits |
| B-06 | APPROVE, 1 offer | C1 | as B-05; the offer is "Nicht ausgewählt"; no replacement assigned | 5 audits, no replacement membership |
| B-07 | APPROVE, multiple + terminal | C3T | 2 OPEN → NOT_SELECTED; terminal offer unchanged | 6 audits; terminal row identical |
| B-08 | Cancel | Open each confirmation, press Abbrechen; then Escape | Nothing sent (network log), focus returns to opener | none changed |
| B-09 | Keyboard/focus | Tab to buttons, Enter opens confirmation, focus on heading, Tab order inside, Enter confirms, Escape cancels | All operable without mouse; visible focus ring; status/alert announced by screen reader | — |
| B-10 | Responsive | B-04/B-05 at all viewports | No horizontal scroll, buttons reachable, confirmation box wraps, text not clipped | — |
| B-11 | Double submit | Double-click the confirm button; press Enter twice | Exactly one POST; buttons disabled while pending | one receipt, audits as B-04/05 |
| B-12 | SP-20 coordination | In C3 open SP-20 selection, then decision; and reverse; select an offer while a decision is pending | Only one confirmation open; while pending/uncertain all other actions disabled/hidden | at most one mutation |
| B-13 | Cross-tab SP-20 race | Tab 1 selects offer (SP-20) on C3-copy, tab 2 APPROVEs the same case with the earlier read | Exactly one winner; loser sees 409 reason, case reloads to winner's state | one outcome only |
| B-14 | Two admins | ADMIN-A1 and ADMIN-A2 open the same case; A1 REJECTs, then A2 APPROVEs | A2: 409 (`CANCELLATION_ALREADY_RESOLVED` or version conflict), stale confirmation closes, explanation shown, case reloads | only A1's decision |
| B-15 | Stale duty version | Open APPROVE confirmation; meanwhile change the duty in planning (other tab); confirm | 409 `PLAN_CONCURRENT_MODIFICATION` (or lease 409); reload shows new versions; no success shown | no decision rows |
| B-16 | Tenant isolation | ADMIN-A1 opens tenant B case URL; sends POST to tenant B request id | 404 page/state, no data of B; POST 404 `RESOURCE_NOT_FOUND` | B unchanged |
| B-17 | Session expiry | Let session expire (or revoke via sign-out in second tab), then confirm | 401 → central sign-out to login; no reload loop; no success shown | none changed |
| B-18 | Role downgrade | No role-management API exists in the codebase, and none may be invented. ADMIN-A2 has the case open with the confirmation ready. The harness downgrades ADMIN-A2 to `EMPLOYEE` by **scoped fixture-only SQL**, committed before the confirm, on the **receipt-verified, isolated, disposable** PostgreSQL 17 target only (as S4 A4; never a dev, shared or production DB). ADMIN-A2 confirms. Cleanup: discard the disposable target (or restore the role). If a tested public role-management API exists by S7, prefer it | 403 `ACTION_FORBIDDEN`, fails closed, no refetch loop, no success shown | zero business writes and zero success audits for the case |
| B-19 | Offline **before delivery** | Browser set offline (DevTools) before pressing confirm; the request never reaches the server | Uncertain state: alert, only "Erneut bestätigen"; other actions disabled | proof of side: **0** decision rows/audits, no `idempotency_records` row for the key |
| B-20 | Lost response **after commit**, same-key retry | A harness-controlled proxy forwards the request to the real backend, lets it commit, then drops the response. Then "Erneut bestätigen" | First attempt: uncertain state. Retry: same key/body/versions (harness equality booleans); 200 with `Idempotency-Replayed: true`; UI shows the decided state | proof of side: exactly **one** decision and receipt `COMPLETED` before the retry; row and audit counts unchanged by the replay |
| B-21 | Synthesized 5xx | The harness proxy answers the first attempt with a synthetic 5xx **without forwarding**; then retry | Uncertain state, then a same-key retry succeeds once. This proves only the UI's handling of a 5xx response, **not** a server 5xx or transaction atomicity (that is backend evidence: S2, S4 A6/A7) | 0 writes before the retry, exactly one decision after |
| B-22 | Reload with uncertain intent (**mandatory**) | Reach the uncertain state in two variants: (a) first command committed (as B-20); (b) first command never delivered (as B-19). Then reload the page | (a) UI shows the server's decided state with no write action; a separately sent stale request gets the normal 409. (b) UI may offer a freshly confirmed action with a **new** key, which succeeds once. Never optimistic success or a duplicate applied decision. No automatic recovery or persistent storage is expected | (a) one decision; (b) one decision after the new confirm; never two |
| B-23 | Case/account switch in flight | Throttle network, confirm, immediately open another case / sign out and in as other admin | Late response not shown in the new context | one decision on original case |
| B-24 | UI ↔ DB consistency | After each positive case compare visible status, offer states, unfilled marker with SQL snapshot and work-queue list | Identical; no optimistic state; list back-navigation keeps filters safely | — |
| B-25 | Storage | After B-04..B-23 inspect `localStorage`, `sessionStorage`, IndexedDB | No keys, tokens, receipts or PII | — |
| B-26 | Resubmission | EMP whose case was REJECTED creates a new cancellation; EMP whose case was APPROVED tries again | New case allowed; APPROVED membership refused (409) | as PO-4 |

Exit criteria for S7 (proposal for the Tech Lead): all rows executed with evidence on the required platforms,
optional platforms executed or logged NOT_RUN, deviations filed as issues, no open H-risk deviation. A double write or
a misleading success (including in B-22) is an H-severity S7 blocker; results recorded in a new `docs/reviews/sp21-s7-browser-acceptance.md`.

## 8. Validation of this slice

| Check | Result |
|---|---|
| Relative links in the four changed files resolve at the base SHA | PASS (65 distinct links, 0 missing; scripted check) |
| PR/issue/comment/run URLs and SHAs re-queried via `gh` (2026-11-12) | PASS (5 PRs, 8 issues, 11 Foundation CI runs: every job `success`) |
| `npm run check:public` (`node scripts/check-public.mjs`) | PASS |
| `git diff --check` | PASS |
| Changed files limited to documentation | PASS (4 Markdown files under `docs/`) |
| Exact-head CI | Initial head `d8bef04`: push 43214630782 and PR 43214726309 green (§1). Those runs do not validate later commits; the current head's CI is recorded on PR #135 |
| Lint, typecheck, build, unit, frontend, E2E, migrations, DB, browser | NOT_RUN locally (docs-only; CI runs the full pipeline on the PR head) |

## 9. Tech Lead decisions on the initial open questions

Resolved by the [review of #135](https://github.com/takh86/SecurePlan/pull/135#pullrequestreview-5874306631):

1. In-memory uncertain intent is acceptable within the approved S5 MVP scope, provided B-22 proves safe server
   reconciliation. B-22 is mandatory; it blocks S7 only if it finds a double write or a misleading success.
2. B-18 uses scoped fixture-only SQL on the receipt-verified disposable target, unless a tested public
   role-management API exists by then.
3. Required: Chrome desktop 1280×800 and 390×844 emulation, plus keyboard/focus and basic screen-reader checks.
   Firefox and a real phone are optional; if not executed they are logged NOT_RUN.
4. #123 may stay open for S6/S7. Before the final MVP release/demo disposition, the PO must decide and explicitly
   accept the deferral and residual risk.
