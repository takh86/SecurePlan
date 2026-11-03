# PR #95 combined-main backend integration

Date: 2026-11-03. Scope: development-main backend integration assessment, not a
merge, deployment, existing-database migration or release authorization.

## Preserved worktree and merge

Continued the existing `feat/a2-atomic-employee-month-save` branch in its Codex
worktree, starting at `c147e5848d1902685d061ce1a41302fe20c13809`.
The only pre-existing uncommitted file was untracked `AGENTS.md`. Its SHA-256
before and after the merge was
`212DA2D5792835BB66BE368DFA82696E714665D4A4B75EC778614034DFC83944`.
No stash, reset, clean, worktree replacement or edits to that file were used.

Fetched origin/main and merged Calendar Admin UI #96 at
`eca4b3d58544238ebc38b0a0b31734f4b0c20a9f` into #95. Merge commit
`eaa9282c0c3f7ce22e01577f59523034bce726d7` has the original A2 head and that main
commit as its parents. Git's `ort` merge completed without conflicts. All 18
incoming files were preserved, including Calendar UI, API/error adapters,
documentation and its browser-acceptance script. No manual conflict resolution
or Calendar/A2 runtime behavior changes were necessary. Claude's worktree and
PR #91 were not changed.

## Independent review disposition

Read the [independent review](https://github.com/takh86/SecurePlan/pull/95#pullrequestreview-5752880259)
against the actual combined tree. It reported no confirmed blocking defect and
required this combined-head gate. Inspection and nine additional real HTTP/PG
tests found no confirmed runtime defect. The approved A2-GATE-1 contract, applied
migrations and business rules remain unchanged.

The first combined-head [push CI](https://github.com/takh86/SecurePlan/actions/runs/41646379627)
was FAIL on a confirmed inherited test timing defect; its matching
[PR CI](https://github.com/takh86/SecurePlan/actions/runs/41646384324) was PASS.
The failure was
in First Publish: an immediate focus assertion could run after the outcome text
rendered but before the component's passive React focus effect. That assertion
and the previously observed late-plan-read focus assertion now use `waitFor`
around the same exact active-element expectation. No assertion is removed, no
timeout is enlarged, and First Publish/Calendar runtime behavior is unchanged.
The initial failed CI run is retained in the PR ledger; final-head runs supersede it.

| Review question | Disposition and executed proof |
|---|---|
| Missing shift configuration | True NO_OP succeeds without eligibility revalidation. Effective changes, including corrective membership removal, still require that duty kind in the effective configuration. Actual A2 and SP-12 PATCH routes are exercised side by side and both refuse with SHIFT_CONFIGURATION_MISSING; all business/audit state is unchanged. This preserves SP-12's existing effective-PATCH semantics, explicitly retained by the adopted A2 contract; it introduces no new bypass. |
| Missing/closed calendar | No guessed seven-day default. Consistent GET reports MISSING/null or CLOSED. True NO_OP succeeds; genuine corrective reduction is allowed with an effective shift rule. The new test first removes the target via SP-12 while preserving a colleague, releases the interactive lease, then removes the colleague via A2. The canonical duty remains live and its version advances once per effective correction. |
| Legacy invalid remaining roster | Read and genuine NO_OP remain available. Correcting one membership still revalidates the resulting retained roster, as SP-12 does. Invalid retained staff refuse A2 neutrally as PRESERVED_ROSTER_CONFLICT, without employee identity; the actual SP-12 path also refuses. This is conservative existing correction behavior, not a new business decision. |
| Revoked session / receipt lookup | New HTTP test commits A2, verifies its original receipt, performs actual HTTP logout, then checks result lookup and replay both return 401 SESSION_REVOKED, no-store, with no receipt/conflict details or business/audit changes. Another authorized actor sees UNKNOWN for the same raw key and cannot replay the first actor's command; its stale attempt is refused. |
| Current principal changes | A previously authorized second admin's live role is changed; actual HTTP result lookup returns 403/no-store with no retained receipt. Existing foreign-tenant, route mismatch and archived-resource tests remain part of the full suite. |
| Immutable replay / lost COMMIT | Existing real COMMIT-then-lost-acknowledgement test, result-only lookup, replay after later roster changes and attempt-fencing tests rerun on the combined tree. A2 results remain persisted originals, not reconstructed current state. |
| Audit / receipt atomicity | Existing fourth-audit and receipt-completion faults rerun. Two new tests force a strict result-codec rejection after duty/member/audit writes, and a real PostgreSQL 0015 CHECK failure at receipt completion. Both return sanitized 500, roll back every business/audit change and leave only fenced FAILED technical evidence with null result/completed timestamp. |
| Calendar read preconditions / client contract | An actual admin calendar bootstrap after an A2 MISSING baseline makes even a stale no-op fail PRECONDITION. Existing strict DTO, SHA-256/precision golden vectors and OpenAPI tests rerun. No calendar, context, role or roster defaults are invented. |
| Capacity / retention / human security | Still release-review gates. No production-capacity, human penetration-test or full Employee-Month browser acceptance claim is made. |

The missing-rule distinction is deliberate compatibility: SP-12 checks an
effective rule after detecting an actual change, even for pure roster removal;
it skips this for a genuine no-op. Calendar guards apply to new/moved/role-mutated
work, while genuine reductions may correct missing/closed calendar dates. A2
follows those paths and validates the full final roster. Changing this policy
would require an explicit business amendment; this task makes none.

## Combined verification ledger

| Check | Result |
|---|---|
| `npm ci` | PASS, Node 24 |
| Backend/frontend lint | PASS |
| Backend source/test typecheck; frontend `tsc -b` | PASS |
| Backend and Calendar UI production builds | PASS; existing frontend bundle-size advisory |
| Backend units | PASS 411/411, 37 files |
| Frontend regression including Calendar UI | PASS 890/890, 55 files |
| Focused A2 command suite | PASS 98/98; nine new review-focused tests |
| Focused First Publish UI suite after focus timing correction | PASS 48/48; exact focus expectations retained |
| Full combined PostgreSQL/HTTP suite | PASS 1423/1423, 53 files, two workers; includes nine additional review-focused tests |
| Migrations 0001–0015 forward, checksum replay, DB verification | PASS on fresh identity-verified disposable PG17 |
| Script tests | PASS 34/34 in disposable Node 24 environment against that same verified PG17 cluster |
| Public-content and whitespace checks | PASS |
| Exact final-head push and PR CI | Final results and exact SHA recorded in [PR #95](https://github.com/takh86/SecurePlan/pull/95) |
| New real-browser Employee-Month Save acceptance | NOT_RUN; separate frontend/integration scope |
| Existing development/stage/production database migration | NOT_RUN; not authorized |
| Human security/accessibility and capacity/retention release reviews | NOT_RUN / OPEN |

The local PG17 target was a new labelled tmpfs container on a dedicated loopback
port. The repository identity receipt was verified before migrations/fixtures.
Script tests ran in a temporary Node 24 container sharing only that disposable
database's network, using its canonical loopback port 5432 and the recorded
identity. Source was mounted read-only; dependencies/build outputs lived in a
separate tmpfs copy. No host-port reassignment, guard relaxation or existing
database access was needed. No `.env` fallback was used for database tests.

## Integration decision

Recommendation: **GO for development-main backend integration**, contingent on
green push and PR CI for the exact final combined head. All local combined gates
above passed and no confirmed blocking runtime defect remains. The final PR
ledger records whether that CI condition has been fulfilled and the exact SHA.
This is an engineering recommendation, not an executed merge or release approval.
PR #95 remains Draft; no PR merge, deployment, issue closure or changes to PR #91
are performed. Full browser integration, stage/production #51 and the release
review gates above remain separate.
