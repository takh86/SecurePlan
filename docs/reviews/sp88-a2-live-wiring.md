# A2 live employee-month integration evidence

Follow-up to Draft PR [#97](https://github.com/takh86/SecurePlan/pull/97), exact base
`feafbceb76f3c4c929e07791d5abfe0516ca5dfe`, including backend main `fc7ec3b`.
The source branch, worktree and PR are unchanged. This change constructs
`createEmployeeMonthApi(api)` in `MonthlyPlanningSection`; the existing page uses
the live workspace and removes its preview badge. No backend contract, migration,
planner replacement, dependency or browser storage was added.

The login boundary owns a revocable in-memory capability. Suspension hides the
protected tree and invalidates its old memory/API capabilities. Re-login restores
only the same account/company/role's resource-bound snapshot, after the workspace
has completed a new authorized read. Changed dates require explicit reconciliation.
An interrupted save or lookup becomes uncertain and retains its frozen body/key;
only result lookup can lead to recovery. A different account, company or role
clears retained input. Deliberate logout clears it; normal confirmed navigation
discards it. Document destruction loses it. Late callbacks cannot read/write the
retained snapshot or send with a newer session's browser cookie.

## Real browser acceptance

Executed 2026-11-03 with installed Chrome 156.0.8078.80, built React, the real
NestJS binary and a freshly created PostgreSQL 17 tmpfs container. Container label,
loopback binding, PostgreSQL major version and cluster identity were verified
before fixture writes. Migrations 0001–0015 applied, replayed unchanged and passed
DB verification. Existing development, staging and production databases were not
used. TLS validation and the Chrome sandbox remained enabled.

Reproducible harness: `scripts/sp88-a2-browser-acceptance.mjs`. Supply explicit
`DATABASE_URL`, `SECUREPLAN_TEST_TARGET_RECEIPT`, `SECUREPLAN_PLAYWRIGHT_MODULE`,
`SECUREPLAN_BROWSER_OUTPUT_DIR`, runtime HMAC key, denylist and local TLS files.
Playwright is an external tool, not a new project dependency. The target receipt
is required before any seed. Prerequisite rows and one explicitly invalid legacy
fixture use SQL; all ordinary saves, competing writes, calendars and publications
use real HTTP. Receipt/body/key comparisons remain in memory and are not written
to evidence. No mocked API responses establish any PASS below.

| Case | Result | Evidence/extent |
|---|---|---|
| B01 complete multi-day Save and document reload | PASS | Real React Save; exactly one POST, all 31 dates and preconditions, no-store; PostgreSQL membership readback; desktop screenshot |
| B02 DAY↔NIGHT, FREI, SHIFT_LEAD and other employee | PASS | React changes; authoritative role retained in subsequent Save; other employee's membership/function unchanged and absent from body |
| B03 invalid day rolls back the whole month | PASS | Availability changed by real API after React read; one Save refused at VALIDATION; all duty/version/membership rows equal before/after |
| B04 concurrent administrator and stale preconditions | PASS | Separate administrator session writes; React gets PRECONDITION; no partial write; fresh read and explicit keep-choice reconciliation |
| B05 committed response lost, immutable receipt, replay, duplicate click | PASS | Proxy discards real committed answer; React queries result without another Save; same-key browser HTTP replay equals original receipt without data change; changed body rejected; double click sends once |
| B06 PUBLISHED CR-03 | PASS | First Publish through real React dialog; later React Save includes PUBLISHED precondition; original publication timestamp unchanged |
| B07 CLOSED and MISSING calendar | PASS | Real calendar API; React blocks new closed-day work and explains MISSING; explicit same-origin browser API probes are refused atomically |
| B08 legacy DAY+NIGHT | PASS | Labelled invalid SQL fixture; React identifies correction, blocks Save until corrected, and saves one exclusive shift |
| B09 mobile, keyboard and navigation | PASS | 390×844, no document overflow, arrow-key focus, real SPA leave/stay guard, native Chrome reload/beforeunload dialog dismissed; mobile screenshot |
| B10 revoked session and same-actor login | PASS | Session revoked in disposable DB; actual Save gets 401, no protected grid; in-place login restores input only after fresh read; lookup UNKNOWN then explicit reconciliation/new Save |
| B11 different actor, role, CSRF and tenant | PASS | In-place actor switch has no previous selection or enabled Save; employee-session probes 403, foreign tenant probes 404, missing CSRF 403; browser storage empty |
| B12 failed result then exact retry | PASS | Real validation refusal's answer lost; lookup NOT_COMPLETED; availability explicitly cleared; user retries with byte-identical body/key and succeeds |
| B13 company switch in the same tab | PASS | Revocation then foreign-company login; previous planner/draft/Save absent; old resource/result lookup concealed with 404 |
| Human screen-reader and real-device audit | NOT_RUN | Automated Chrome keyboard/mobile checks do not establish human accessibility acceptance |
| Cross-browser acceptance | NOT_RUN | Chrome only |
| Staging/production, capacity and retention acceptance | NOT_RUN | Outside this disposable development integration; no deployment performed |

Private local evidence contains `report.json`, `B01-desktop.png`, and
`B09-mobile.png`. The report records source HEAD/dirty state, browser version,
verified cluster, case results, request count and built index hash. The final
exact-head report is the authoritative run; diagnostic failures from harness
development do not replace that ledger. Screenshots contain synthetic data only.

## Automated gates

| Gate | Result |
|---|---|
| Lint | PASS |
| Backend typecheck | PASS |
| Backend and frontend production builds | PASS; existing bundle-size advisory |
| Full frontend suite | PASS, 1060 tests / 65 files; includes live-section, memory capability, login boundary, rebase and uncertain-attempt regressions |
| Backend unit | PASS, 411 tests / 37 files |
| Disposable PostgreSQL E2E | PASS, 1423 tests / 53 files |
| Migration application/replay and DB verification | PASS, 0001–0015 |
| Script checks | PASS, 34 tests; disposable Node 24 runner shared only the verified PostgreSQL container network because host port 5432 was occupied |
| Public-content scan | PASS |

Frontend unit/component tests remain separate from the browser ledger. Backend
E2E additionally exercises transactional fault injection, leases, lifecycle,
authorization and tenant isolation; those tests are not Chrome acceptance.

## Integration decision and remaining dependency

The tested combined feature is ready for development-integration review. Merge
remains gated on required review/CI. This Draft PR targets
`agent/claude/sp88-a2-employee-month-ui` and contains only follow-up changes.
PR #97 is still a dependency: after its authorized merge, retarget this PR to
latest main, inspect the combined diff/tree and rerun the required integration
gates. That post-merge gate is NOT_RUN until the parent actually merges. No merge,
deployment or issue closure is part of this change.
