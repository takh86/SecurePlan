# A2 engineering gate and implementation handoff

2026-11-03. Base `dd3e83e5e6f619f197aad93ee2b7f5c121d6eeca` from freshly fetched
origin/main, including merged A1 #92 and First Publish UI #93. Scope: proposed
contract, executable PostgreSQL probes and handoff only. No application runtime,
existing migration, frontend or dependency changes. #89/#91 and other worktrees
are untouched. Issue #88 remains open.

**Verdict: A2 is NOT approved for implementation.**
[P1–P6 approval](https://github.com/takh86/SecurePlan/issues/88#issuecomment-6588991067)
explicitly excludes technical/implementation authorization. The current issue
header directs reconciliation after A1; it does not adopt a precise API/receipt
contract. Passing probes do not supply that approval. The approval-ready artifact
is [A2-GATE-1](../api/employee-month-save-proposed.md). Controlled originals were
not available as verified approval artifacts in this task; their update/adoption
must be recorded by their owner. This is AI-assisted review, not independent
human security certification.

## Findings against current main

Reviewed repository AGENTS/CONTRIBUTING/public-documentation rules, ADR-0001–0006,
CR-03, #88's approval/comments, pinned #89 API/domain/transaction/decision sheet,
0011–0014, MonthlyPlansService create/edit/delete/lease/Publish, calendar service,
account-prefix locks, SessionService, PublishIdempotencyService, schema signature,
ProblemDetailsFilter and bounded audit catalogue. A1 is implemented; historical
#89 statements about missing calendar/session/audit support are superseded.

| Finding | Engineering consequence |
|---|---|
| 0014 is applied calendar DDL, not a receipt migration | Allocate new migration after 0014; 0015 is provisional. Preserve all historical checksums |
| Current Publish codec is INITIAL_PUBLISH-only; receipt is plan reference | A2 needs discriminated schema/codec, exact stored result and old replay regression coverage |
| Current per-duty orchestrators own transactions and reacquire parents | Extract client-taking validation/delta helpers; never call public mutation methods in a loop |
| Existing staffing helper excludes only one old duty | New final-state overlay must exclude all target retired memberships, preserve colleagues, compare all desired intervals and external overlaps |
| Current session helper reuses policy with fresh DB clock under A/C | Reuse it; enforce again after waits for command/no-op/replay/result. No late validateAndTouch |
| Current filter has calendar no-store and static shared-rule errors | A2 needs route-wide no-store and approved bounded atomic-conflict extension; arbitrary extensions currently are not forwarded |
| Whole duty version includes other staff, retained empty slots remain live | Full month preconditions intentionally conflict on shared changes; never delete/rebuild whole rosters |
| A1 calendar P NO KEY UPDATE conflicts with planning P SHARE | Preserve parent barrier, effective token and absent-slot protection; no extra late calendar lock |

Business semantics in the amendment are settled P1/P2/P4/P5: full desired month,
exclusive TAG/NACHT/FREI, true OFF, retained duty/member history, first-assignment
creation only and preservation of every other employee. Existing ACTIVE project,
resulting-roster and independent UTC overlap constraints remain. Missing calendar
does not become an implicit seven-day policy. Shared/legacy defects may still
block an effective changed-duty roster; do not silently weaken that rule.

## Reproducible disposable-database experiments

Harness: [a2-contract-probe.e2e-spec.ts](../../apps/backend/test/a2-contract-probe.e2e-spec.ts).
It is explicitly a proposed prefix probe, not an implementation of Save. Every
fixture has two duties, two active members and a retained released lease row;
the patch schedules add another lease row. Test transactions use actual migrated
relations and existing services/helpers. The candidate I is a separate advisory
scope; A2 reservation rows/context FKs do not exist and are not claimed tested.

Dedicated fresh `postgres:17` container `secureplan-a2-gate-20261103`, ID prefix
`a573f103c54d`, run label `a2-gate-20261103`, loopback-only port 55488 and tmpfs
`/var/lib/postgresql/data`. No bind-mounted database or existing development DB.
The repository verifier inspected full container identity, label, image, port,
tmpfs, database/user, PostgreSQL major and pg_control_system cluster identity;
the credential-free local receipt hashes the explicit connection string and is
ignored. Verification runs before migration and again before fixture loading.
No .env fallback. Credentials and local receipt are not committed.

Reproduction: create a fresh labelled tmpfs postgres:17 container as required by
`scripts/disposable-test-target.mjs`; set explicit DATABASE_URL,
SECUREPLAN_TEST_CONTAINER_ID, SECUREPLAN_TEST_RUN_ID,
SECUREPLAN_TEST_TARGET_RECEIPT and a generated login HMAC key. Then:

```text
node scripts/disposable-test-target.mjs record
node scripts/migrate.mjs
node scripts/migrate.mjs
node scripts/verify-db.mjs
npm run test:e2e -- --maxWorkers=1 operating-calendar-real.e2e-spec.ts a2-contract-probe.e2e-spec.ts initial-publish-concurrency-real.e2e-spec.ts session-lock-concurrency.e2e-spec.ts
```

Blocking is observed with pg_blocking_pids, not assumed from sleeping. Candidate
transactions take A/C/I/E/P/M/L UPDATE/all D/all A2/all Q in final modes, then
fresh session/lease/state reads. Real service contenders bypass only HTTP guard
orchestration using a previously validated trusted context, so global session
touch A UPDATE does not mask the intended E/P/L wait. Existing suites separately
exercise real HTTP paths. Audit barriers retain the real audit INSERT and inject
a late exception to force rollback.

| New experiment family | Schedules | Assertion |
|---|---:|---|
| Candidate vs create, PATCH, First Publish, calendar | 16: four writers × both first orders × COMMIT/ROLLBACK | Actual blocking, fresh counts/versions/lifecycle/calendar; no unexpected deadlock |
| Candidate vs lease | 4: both orders × COMMIT/ROLLBACK | L prevents late lease insertion; committed earlier lease is live at fresh admission; rollback leaves no live lease |
| Candidate vs logout SQL, reset-revocation helper, role SQL | 12: three changes × both orders × COMMIT/ROLLBACK | A UPDATE vs SHARE serializes; earlier committed logout/reset is 401, role change 403; rollback preserves valid context |

Proposal-first makes one harmless existing duty version mutation to distinguish
commit/rollback. It makes no employee-month business save. PATCH and First Publish
correctly return PLAN_CONCURRENT_MODIFICATION after the committed mutation;
Publish discovers before E wait and refuses drift. Calendar and create serialize
and proceed when valid. Writer-first probes see committed effects or original
state after rollback. Lease-first uses the real acquireDutyLease on a caller-owned
transaction so rollback is observable; identity SQL schedules model existing
account-first revocation/role ordering, not full password-reset endpoint proof.

Initial run: 149/150 PASS, one incorrect probe expectation that First Publish
would accept changed discovery. Corrected to expect the actual safe 409; unchanged
20-probe rerun: 150/150 PASS across four suites, 40.07s. Expanded multi-duty run:
158/162 PASS; four calendar schedules correctly refused the newly added Thursday
duty, which the harness had omitted from its compatible weekday proposal. Fixed
the proposal from [3,5] to [3,4,5], retaining all saved dates. No production code
changed. Expanded final run: **162/162 PASS**, 2026-11-03, started
09:56:13 UTC; four suites, no failed/pending tests. Probe suite 32/32 (6.19s),
First Publish concurrency 69/69 (19.06s), calendar 57/57 (11.24s), session locks
4/4 (0.48s). The ignored Vitest JSON report records each assertion and timing.
Full migrations 0001–0014 applied to the empty cluster, then checksum-preserving
replay passed; foundation/SP-10/SP-11/SP-12/SP-13/A1 DB verification passed.
No application fix was
needed. Expected sanitized 500 logs in existing fault-injection cases are not
unexplained test failures.

## Implementation breakdown after acceptance

| Step / ownership | Concrete work and review boundary | Exit evidence |
|---|---|---|
| 0 API/requirements + architecture/DB + Identity/security/audit owners | Accept exact A2-GATE-1 revision, codec vectors, safe reason enum, ADR-0006 supplement, controlled amendment versions and bounded backend authorization | Named approver/role/date/revision and deltas; no inferred approval |
| 1 backend DB/command component | Provisionally 0015 discriminated receipt schema; operation codecs/shared claim fence; tenant FKs/size/time/state constraints; schema/table classification and verifier updates | Forward/replay from 0014, unchanged historical Publish rows/replays, malformed receipt rejection, cross-tenant FK and claim-FK ordering experiments |
| 2 backend read/projection | New employee-month DTO/controller/mapper, consistent month read, saved slots, selected membership, effective calendar, checksum | 28/29/30/31-day, legacy dual/empty/shared, timestamp/range/DST and strict DTO tests |
| 3 backend transaction/delta | Discover full roster; ordered prefix; all D before A2/Q; absent-duty creation; fresh lease/session/version/calendars; final overlay validator and target-only mutations | Multi-date success and invalid-day rollback, all preservation invariants, no-op/stale/role/source/rejoin, blocked discovery drift |
| 4 backend security/audit/recovery | Strict atomic problem extension/no-store; exact immutable receipt; execute/replay/result current authorization; existing D/M audit payloads on same client | Nth audit/receipt failure rolls back every date; lost COMMIT response, fences, key expiry/cleanup bounds, foreign principal/route and post-wait expiry proof |
| 5 independent implementation review | Real A2 against every effective competing writer, both orders and commit/rollback; inspect actual implicit FK locks and no upgrades | Measured blocking + outcome matrix, actual new tests reported separately, capacity/lock-footprint measurements without invented roster caps |
| 6 separately assigned UI integration | Frozen fixtures/API adapter, persistent paint and roles, protected draft/rebase/unknown-outcome recovery | Owner review and browser → HTTP → disposable PG → refreshed plan proof, accessibility/responsive and cross-login isolation |

Suggested new backend files: employee-month DTO/types/mapper/controller/service,
final-overlay validator and operation-specific receipt codec; client-taking shared
helpers next to planning locks, staffing and idempotency. Keep existing controller
paths and INITIAL_PUBLISH fingerprints compatible. Identity helper exists: add
coverage/call sites, avoid a broad auth rewrite. No edits to Claude's worktree or
#91; a later UI owner can consume this handoff after contract freeze.

Remaining acceptance must include two A2 saves/shared rosters, absent DAY/NIGHT,
newly discovered employees, project/month-link/employment/status/availability/
configuration writers, SP-12 DELETE, Publish, calendar bootstrap, lease rotation/
expiry and multi-D/multi-Q scenarios. Current probes are a bounded subset of the
larger #89 matrix, not its completion. Receipt/context-FK migration, A2 endpoint,
browser acceptance, performance and controlled-document adoption remain open.

## Verification ledger and gate

| Check | Result in this task |
|---|---|
| Targeted real PostgreSQL/HTTP concurrency suites | PASS 162/162, including 32 new protocol probes |
| New A2 migration / endpoint / immutable receipt / browser acceptance | NOT_IMPLEMENTED / NOT_RUN; contract gate |
| Full backend E2E suite | NOT_RUN; targeted suites above are the executed subset |
| `npm run typecheck` | PASS including backend source and tests |
| `npm run lint` | PASS backend/frontend |
| `npm run build` | PASS backend/frontend; existing frontend bundle-size advisory |
| `npm test` | PASS 385 backend unit tests, 36 files |
| `npm run test --workspace=frontend` | PASS 820 frontend tests, 52 files |
| `npm run check:public` | PASS after sandbox Git EPERM; escalated read-only rerun exit 0 |
| `npm run test:scripts` | NOT_RUN; scripts unchanged |

The PostgreSQL evidence supports bounded T2/T4 assumptions, not an unqualified
T1–T4 PASS. Existing A1 expiry cases verify post-P idle/absolute revalidation;
new A2 claim/context FKs, tentative new-duty writes, Nth-audit/receipt rollback,
lost-response recovery and principal-bound UI state still require actual A2 tests.

Before implementation, approval is still needed for T1 schema/errors/codecs,
T2 batch lease/locking supplement, T3 migration/receipt/recovery/cleanup and T4
audit/privacy/session/draft integration scope. These are technical contract
decisions; the approved business interaction is not pending again. No new audit
action or business policy is required by the proposed default. Any alternative
(delta-only, silent roster merge, placeholder deletion, inactive-project bypass,
automatic retry) needs a separately explicit business amendment.

No operational migrations, existing development/production data writes, merge,
deployment or issue closure occurred. The disposable probe is not release sign-off.
