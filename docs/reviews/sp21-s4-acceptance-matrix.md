# SP-21 S4 — Acceptance Coverage Matrix (REJECT and APPROVE without replacement)

Slice: S4 acceptance evidence only. No production code, migration, OpenAPI or frontend change.
Authorization: Tech Lead S4 gate on issue #38 (2026-11-11). Contract: approved PO-1..PO-8 baseline and Tech Lead
conditions TL-1..TL-6 on issue #38 (2026-11-10).

| | |
|---|---|
| Base (`origin/main`, approved S3 post-merge baseline) | `64329e3909ff9835c51927e6c66a2b676686e8c2` |
| Branch | `agent/codex/sp21-s4-acceptance` |
| Head | see the Draft PR (the head commit cannot name itself) |
| Changed files | `apps/backend/test/cancellation-decision-acceptance-real.e2e-spec.ts` (new), this report (new) |

Evidence rule: DOCUMENTED ≠ IMPLEMENTED ≠ VERIFIED ≠ PRODUCTION READY. "PASS" below means a named automated test
was executed in this slice against a receipt-verified disposable PostgreSQL 17 and passed. This is backend HTTP and
real-PostgreSQL evidence, **not** browser acceptance (S7, NOT_RUN).

## 1. Method

1. Inventory before writing tests: the S2 service suite (`cancellation-decision-real`, 65 tests), the S3 HTTP suite
   (`cancellation-decision-http-real`, 78 tests), the S1 receipt suite (`cancellation-decision-receipt-real`), the
   cancellation create/withdraw suite (`cancellation-requests-real`), the SP-20 suite (`replacement-selection-real`),
   the work-queue suites and the receipt/audit unit specs. Each acceptance condition was mapped to existing test
   titles first.
2. A new test was added only where no existing test proves the condition, or where the existing proof is at a
   lower level (service only, SQL-forced state) and the HTTP path or the real-decision path could plausibly differ.
3. Races use real row locks held by a test transaction and `pg_blocking_pids` polling as a barrier (no sleeps to
   order events). The single timing-based assertion (A6) relies on the server-side 5 s `lock_timeout`, which is
   deterministic in PostgreSQL.

Abbreviations for existing evidence: **S2** = `test/cancellation-decision-real.e2e-spec.ts`, **S3** =
`test/cancellation-decision-http-real.e2e-spec.ts`, **S1** = `test/cancellation-decision-receipt-real.e2e-spec.ts`,
**CR** = `test/cancellation-requests-real.e2e-spec.ts`, **SP20** = `test/replacement-selection-real.e2e-spec.ts`,
**S4** = the new `test/cancellation-decision-acceptance-real.e2e-spec.ts` (blocks A1–A7).

## 2. Acceptance Coverage Matrix

Risk: H = wrong business/authorization outcome or data loss, M = wrong audit/observability or degraded guarantee,
L = cosmetic/contract detail. Status reflects this slice's executed runs.

### PO-1 — finalize OPEN offers, never select or fabricate, fail closed

| Condition | Implementation | Existing evidence | Gap → S4 test | Risk | Status |
|---|---|---|---|---|---|
| 0 OPEN offers | `cancellation-decision.service.ts` W3 | S2 "REJECT/APPROVE with 0 OPEN offers" | none | H | PASS |
| 1 OPEN offer | same | S3 first test (k=1, action list) | none | H | PASS |
| multiple OPEN offers → all `NOT_SELECTED` | same | S2 k=2 | none | H | PASS |
| only OPEN offers count in k; terminal offers untouched | `lockReplacementOffers` + `status='OPEN'` filter | **none** (fixtures had only OPEN offers) | A1: 2 OPEN + 1 INVALIDATED, both decisions; k=2 exact, INVALIDATED row byte-identical | H | PASS |
| no selected/fabricated replacement | no SELECTED path in S2 service | S2 races assert 0 `REPLACEMENT` memberships | A2 re-asserts after a real APPROVE | H | PASS |
| inconsistent source state fails closed | invariant checks, `Error` → 500 | S2 "contradictory state" ×3 | none | H | PASS |

### PO-2 — audit vocabulary, exact mappings, counts, atomicity, privacy

| Condition | Existing evidence | Gap → S4 test | Risk | Status |
|---|---|---|---|---|
| REJECT = 2+k, APPROVE = 4+k | S2 k∈{0,2}, S3 k=1 | A1 k=2 with a non-counted terminal offer | M | PASS |
| exact resources and status payloads | S2 (`old/new` status pairs, membership payload) | A1: exact **key sets** of every payload incl. existing SP-12 `DUTY_UPDATED` shape (`dutyDate, endsAt, planId, shiftKind, startsAt, version`), version 1→2 | M | PASS |
| one actor, one correlation = server-issued response id | S2 (service), S3 (HTTP) | A1 (with three offers) | M | PASS |
| no PII/secrets/free text | S2 APPROVE regex only | A1: every synthetic first/last name and e-mail of the tenant absent; no `@`, token, password, reason; **REJECT** included | M | PASS |
| audit stays in the tenant | — (implicit) | A1: foreign tenant audit set unchanged | M | PASS |
| atomic rollback, APPROVE (all boundaries) | S2 APPROVE: 5 business + 6 audit + receipt boundaries | none | H | PASS |
| atomic rollback, REJECT | S2: audit rows 1–4 only (service level) | A7: offer finalization, cancellation, need, **receipt completion** via HTTP → sanitized 500, nothing committed, `FAILED`, same key decides once, then replays byte-identically | H | PASS |
| zero success audits on refusal/replay | S2 "refused or replayed decision emits no success audit"; S3 snapshots | none | M | PASS |
| `FAILED` attempt metadata may remain on admitted conflicts (TL-4) | S2 stale-version tests assert `FAILED` | documented, not a defect | L | PASS |

### PO-3 — no notifications/outbox (#121 deferred)

| Condition | Evidence | Status |
|---|---|---|
| decision triggers no delivery | A1, A2: the recording delivery double receives nothing | PASS |
| no outbox mechanism added | this slice changes no production code; S4 adds none | PASS (by inspection) |

### PO-4 — resubmission only under independently valid current rules

| Condition | Existing evidence | Gap → S4 test | Risk | Status |
|---|---|---|---|---|
| after REJECTED: new case on still-ACTIVE membership | **none** | A3: 201, new case id and new need id, old case stays REJECTED | H | PASS |
| no second OPEN case | CR (duplicate create) | A3 re-asserts after a REJECT (`CANCELLATION_ALREADY_EXISTS`) | H | PASS |
| after APPROVED: removed membership not reusable | **none** | A3: 409 `CANCELLATION_ASSIGNMENT_NOT_ACTIVE`, no row change | H | PASS |
| after WITHDRAWN: allowed | CR "…even after a new case exists" (partial) | A3: explicit 201 | M | PASS |
| after OBSOLETE (duty removed): refused | **none** | A3: 409 `CANCELLATION_ASSIGNMENT_NOT_ACTIVE`; APPROVE on the OBSOLETE case 409 | H | PASS |

### PO-5 — Option A: no new decision time cut-off

| Condition | Evidence | Status |
|---|---|---|
| decision on an OPEN case after duty start/end is not refused by time | S2 "PO-5 Option A …" (APPROVE and REJECT, database clock) | PASS |
| no time logic on the HTTP path | controller/DTO contain no clock or date guard (inspection); HTTP rerun not added (no differing code path) | PASS (inspection) |
| retroactive published-plan/statistics change | an APPROVE after the duty removes the membership from the published plan; statistics derived from ACTIVE memberships change retroactively. No payroll or entitlement behaviour exists or is decided here. | Documented consequence |

### PO-6 — APPROVE outcome and OPEN_UNFILLED visibility

| Condition | Existing evidence | Gap → S4 test | Risk | Status |
|---|---|---|---|---|
| original REMOVED, duty +1 exactly, no replacement membership | S2, S3 | none | H | PASS |
| need `OPEN → OPEN_UNFILLED`, null selected offer/resolvedAt, need v+1 | S2 | none | H | PASS |
| REJECT: duty/membership unchanged, need CLOSED | S2, S3 | A2: case also leaves the work queue | M | PASS |
| office visibility after a **real** APPROVE | work-queue suites use SQL-forced `OPEN_UNFILLED` only | A2: work queue item `APPROVED/OPEN_UNFILLED`, admin need context (`concurrencyVersion 2`, `originalAssignmentActive false`, `dutyRemoved false`), admin case read, plan stays PUBLISHED | H | PASS |
| no late SP-20 selection | S2 race (decision first) | A2: selection with the **current** need version → 409 `CANCELLATION_ALREADY_RESOLVED`; new offer → 409 `REPLACEMENT_NEED_NOT_OPEN`; no row/audit change | H | PASS |
| no closure command, no reconciliation (#123) | none exists | A5 deliberately stops before a removal at the current duty version | — | OUT_OF_SCOPE (#123) |

### PO-7 — HTTP contract

| Condition | Evidence | Status |
|---|---|---|
| `APPROVE`/`REJECT` only, non-null `replacementOfferId` → 400 | S3 invalid-body table, SP-20 coexistence test | PASS |
| APPROVE: `Expected-Version` (need) + `expectedDutyVersion` (duty); REJECT: optional header syntax-checked, body version forbidden | S3 | PASS |
| idempotency (fingerprint, replay bytes, conflicts, expiry, in-progress, stale reclaim) | S1, S2, S3 | PASS |
| media type, body bound, parser, unknown/prototype fields, duplicate headers, query | S3 | PASS |
| guard order, CSRF, Origin, session, live role on replay, concealment without receipts | S3 | PASS |
| immutable receipt replay after later duty/employee change | S2, S3 (byte-identical text) | PASS |
| SP-20 selection route unchanged | SP20 suite (full E2E), S3 coexistence | PASS |
| OpenAPI documents both | `check:replacement-api` PASS; OpenAPI content reviewed in S3 | PASS |

### PO-8 — gated delivery

S1–S3 merged; S4 is this Draft PR; S5 (React), S6 (closeout), S7 (browser acceptance) **NOT_RUN / not started**.

### Tech Lead conditions and ADR-0004 / ADR-0006

| Condition | Existing evidence | Gap → S4 test | Risk | Status |
|---|---|---|---|---|
| TL-1/2 versions and fingerprint | S1, S2, S3 | none | H | PASS |
| TL-3 immutable receipt | S1, S2, S3 | none | H | PASS |
| TL-4 refusal = zero business writes and success audits | S2, S3 | A4–A7 re-assert on new paths | H | PASS |
| TL-5 session recheck after lock wait | S2 revoked/expired during duty wait | none | H | PASS |
| TL-5 **role downgrade / account deactivation** racing the decision | S3 role downgrade **before** a replay only | A4: change committed while the decision waits for the actor row → 403 `ACTION_FORBIDDEN` / 401 `SESSION_REVOKED`, no write; rolled-back change → decision proceeds once; downgrade issued while the decision holds its locks waits for it (blocker = decision backend) and the same key then cannot replay (403) | H | PASS |
| TL-5 exactly one winner vs SP-20, both orders | S2 (real HTTP selection vs service decision, barrier) | none: the HTTP controller adds no lock or state logic; A4/A6 prove the HTTP path parks and resumes at the same locks | H | PASS |
| two competing administrators | S2 (barrier), S3 (real HTTP, unordered) | none | H | PASS |
| planning duty removal vs REJECT, both orders | S2 | none | H | PASS |
| **APPROVE vs duty removal**, both orders | S2: live lease refuses APPROVE at once | A5: removal first → OBSOLETE, APPROVE 409 `REPLACEMENT_NEED_NOT_OPEN`, no decision audit; APPROVE first (lease request queued behind it) → removal at the pre-decision version 409 `PLAN_CONCURRENT_MODIFICATION`, need stays `OPEN_UNFILLED` | H | PASS |
| stale need/duty versions | S2, S3 | none | H | PASS |
| **bounded wait / lock timeout classification** | none for the decision | A6: blocked > 5 s `lock_timeout` → sanitized 500 `INTERNAL_ERROR` (no lock/SQL detail), no business write, receipt `FAILED`, same key then decides once (not a replay) | H | PASS |
| TL-6 #123 / #118 / #122 separate | — | not touched | — | OUT_OF_SCOPE |
| ADR-0004 vocabulary not broadened | A1 exact action set | — | M | PASS |
| ADR-0006 lock rank | service header order; S2/S4 barriers park at D; A4 shows account (rank A) precedes D | — | H | PASS (by test + inspection) |

### Regression and compatibility

| Area | Evidence | Status |
|---|---|---|
| SP-20 selection | SP20 suite inside full E2E | PASS |
| #132 activation compatibility | employee/activation suites inside full E2E; `test:scripts` incl. `activation-demo` | PASS |

## 3. Counterexamples / defects found

None. No production code change was needed. Every observed status and code matched the S1–S3 contracts; the
refusal codes in A2, A3 and A5 were observed first and then pinned as literals.

## 4. Validation (local, disposable PostgreSQL 17, synthetic data)

A new uniquely labelled tmpfs PostgreSQL 17 container was created and receipt-verified with
`scripts/disposable-test-target.mjs record` before any migration; the development Compose stack, other agents'
containers and volumes were not touched. Endpoint, credentials and receipt contents are not published.

| Gate | Result |
|---|---|
| `db:migrate` run 1 / run 2 | 20 applied / 0 applied (no-op replay) |
| `db:verify` | PASS |
| new spec `cancellation-decision-acceptance-real` | 17/17, three consecutive runs |
| S2 + S3 suites (baseline before changes) | 143/143 |
| full backend real-PG E2E (`test:e2e`) | 70 files: one run 2196 passed / 2 skipped; two runs with 2 failures each (see §5) |
| backend unit (`npm test`) | 571/571 |
| frontend (`vitest`) | 1397/1397 |
| `test:scripts` (Node 24 container in the verified PG network namespace, workspace and receipt read-only, `NODE_ENV=development`) | 36/36 |
| `check:public`, `check:replacement-api` | PASS |
| `lint` | exit 0; new file 0 warnings |
| `typecheck`, `build` | PASS |
| `git diff --check` | clean |
| automated security review | **NOT_RUN** |
| dependency audit | **NOT_RUN** (no dependency change) |
| browser acceptance (S7) | **NOT_RUN** |

The 2 skipped E2E tests are pre-existing environment-gated tests (`admin-work-queue-real`: isolated SP-19 DDL
wait, executed by CI as its own step; optional query-plan recorder).

## 5. Full-suite flakiness (#118, pre-existing)

Two of three full runs on this branch each had 2 failures, all vitest **5 s per-test timeouts** in pre-existing
specs (`replacement-offers-real` "fourth and fifth voluntary offers", `admin-work-queue-chain-real`, S2 "already
decided case…"). Each passes in isolation. To separate cause from load, the full suite was run twice on the
**unchanged base** with the new spec set aside: both runs had 1 failure of the same kind. The flake therefore
predates S4 and matches open issue #118 (local machine with low free memory). The new spec itself never failed.

## 6. Residual risks and open items

- **#125** (retention of expired idempotency response snapshots) is OPEN: a hard release blocker for any
  environment with real personal data.
- **#123** OPEN_UNFILLED operational closure and later duty-removal reconciliation: not implemented, not tested
  here beyond the stale-version refusal; an APPROVE'd duty can still be removed at its current version (lifecycle
  owned by #123).
- **#124** SP-20 mutable replay: unchanged, out of scope.
- **#121** notifications: deferred (PO-3).
- **#118** full-suite timing flakes: reproduced on base and branch (§5).
- A1 creates the INVALIDATED offer by SQL (the state is reachable via the existing invalidation path, which has its
  own tests); A4 changes the account row by SQL to place the change exactly at the lock.
- Automated security review and dependency audit NOT_RUN; React (S5), closeout (S6) and browser acceptance (S7)
  not started. SP-21 is not feature- or release-complete.
