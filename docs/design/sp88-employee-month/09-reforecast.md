# Remaining scope and delivery forecast - revision 2026-11-02

Estimate, not approved capacity/elapsed time/commitment. Replaces the original
SP-88-only 62-100 h allowance for this combined scope; do not add that again.
#90 is new work. Main 13b680c and open issue inventory inspected with
`gh issue list --repo takh86/SecurePlan --state open --limit 100 --json number,title,url`.
Historical dated tickets are not completion evidence. Current business controllers
cover workforce/admin planning; M5 workflow/employee published-plan API not present.

## Remaining planning package with foundation credit

| Remaining work | Focused hours | Credit/boundary |
|---|---:|---|
| Decisions, controlled backports, review coordination | 6-10 | Initial source/design work done; no redo |
| A1 SP-90 DB/API + all existing create/PATCH/DELETE/Publish guards and PG tests | 22-34 | Reuse P barriers/D3/resolver; calendar is new |
| A2 SP-88 backend read/save/result, additive receipts, session/lease/actual PG tests | 30-46 | Reuse #86 fencing and SP-11/12; no recoding foundations |
| B paint revision/adapter/recovery/roles/component tests | 14-22 | Credit #87 matrix/editor and #91 draft/review/guards/tests |
| B project calendar admin UI/effective-month conflicts/tests | 6-10 | New UI, reuse project/shift form patterns |
| Actual Publish frontend/bodyless/recovery integration | 6-10 | #86 backend already delivered; slot/dirty guard credited |
| C combined PG/browser/security acceptance and defect retest | 12-20 | One combined package, no second old A10/Publish allowance |
| Independent technical/security/UX review and corrections | 8-14 | Human review remains finite and independent |
| **Combined remaining planning package** | **104-166** | Re-estimate after frozen contract and actual-schema slice |

A1/A2 include unit/HTTP/PG implementation tests; B includes component/adapter tests;
C is combined cross-feature browser proof, review separate. Do not add Claude's
old 10.5-18.5 days: overlapping scope predates paint/calendar correction. Credit
completed work without assuming accepted integration. Major defects/legal policy/
new company-zone API are not silently covered. Legacy data may expand the range.

## Essential MUST beyond this package

| Capability / inspected gap | References | Provisional hours |
|---|---|---:|
| Employee's own current Published plan, strict ownership | #29/#30 SP-14; no employee published read in current controller | 8-14 |
| Own planned DAY/NIGHT/month counts | #31 SP-15, M6 | 4-8 |
| Cancellation/withdrawal, demand/offers, eligibility, joint admin review, atomic replacement or without/reject, idempotency/races, GEGENSTANDSLOS | #32-40 SP-16-22, M5; no workflow module | 44-72 |
| Own cases + minimal admin work queue/navigation | #41/#42 SP-23/24, M7 | 6-10 |
| Staging/demo HTTPS/secrets/mail/config, setup/migration/rollback procedure, applicable security gates | #22/#30/#44-46, M9 and applicable #51 | 12-20 |
| Full MUST regression, clean checkout/docs/probedemo/owner acceptance/fixes | #42/#44-47 SP-25-27, M8/M9 | 12-18 |
| **Beyond-planning total** | No second package-C browser charge | **86-142** |
| **Combined provisional scenario** | 104-166 +86-142 | **190-308** |

Bottom-up provisional estimates require measured ticket review, not the historical
108 h sum. SP-14/M5/#51 remain outside this runtime mission but inside release
planning. Production backup/RPO/RTO/observability, retention automation, MFA, full
audit viewer, Excel/holidays/notifications are not silently added as MVP. Security
owner separates #51 pre-external-staging obligations from later production gates.
No MUST is cut to fit a date. Staging host/HTTPS/secrets/test mail/deployment owner,
review turnaround and accepted synthetic demo fixtures remain dependencies; no
accepted staging inferred from CI. No environment was deployed by this mission.

## Calendar capacity and agent scenarios

Nov 3-Dec 3 inclusive: 19 Mo-Thu workdays, 152 gross hours at 8 h or 114 focused hours at
illustrative 6 h/day after review/coordination. Only 15 days precede Nov 30 release QA,
about 90 focused hours/engineer. Calendar arithmetic, not booked capacity. Actual
availability must be measured; no Friday/weekend overtime assumed. Dec 3 is high
risk and unsupported by current unapproved scope/capacity.

| Scenario | Planning-package critical path after decisions | Full remaining MUST rough path | Constraints |
|---|---|---|---|
| One engineer | 18-28 focused 6 h days (104-166 h), plus approval waits | 32-52 days (190-308 h) | Does not fit 19 days; package consumes most/all available time |
| Codex backend + Claude frontend | About 12-19 days: backend 52-80 h (~9-14 days), overlapping UI 20-32 h, integration/review tail | About 23-37 days | Frontend fixtures/UI parallel, backend-heavy M5 and staging remain critical |
| Two dev agents + independent QA/review | About 11-18 days with reserved reviewer time | About 21-34 days | Earlier review/test preparation helps; no threefold speedup, final real runtime still prerequisite |

These dependency-based ranges are not throughput measurements or a completion
promise. Path: decisions -> calendar/all-writer guards -> batch -> employee-owned
read/M5 -> full integration/work queue -> staging/regression -> human acceptance.
B fixtures/UI and QA preparation overlap A; migrations/shared backend services
stay sequential with Codex. Defects can return the path to backend. Agent execution
does not expand human PO/security review hours; reserve package 8-14 review hours
and separate release acceptance explicitly.

Constrained laptop: one heavy PG/browser suite at a time, bounded workers (use
proven maxWorkers=4 only if resources permit), distinct verified disposable DB
ports/receipts/containers per owner, no shared fixtures. Unit/UI work can overlap.
Resource-heavy suites are a scheduled bottleneck; stand-in probes cannot replace
actual-schema concurrency/rollback acceptance.

## Bounded PR sequence / file ownership

0. Approve P1-P6/T1-T4, controlled amendments and capacity. Owner resolves #86
   independent review, #87 bounded-foundation disposition; #91 stays Draft until
   corrected and backed by API. This mission changes none of those PRs.
1. **A1 Codex calendar + cross-writer backend foundation**, integrated main after
   #86: calendar migration/module/DTO/schema guards; shared exclusive/calendar
   checks in SP-11/SP-12/Publish; compatibility/bootstrap; approved calendar audit;
   actual-schema HTTP/PG/migration/security/both-order tests. No React.
2. **A2 Codex employee-month backend**, depends A1: full read/save/result,
   additive operation-discriminated idempotency, Identity session read, ordered
   transaction/internal lease admission, immutable receipt/rollback/race proof.
3. **B Claude integration**, can develop approved fixtures during A1/A2: paint
   draft, calendar admin UI, strict adapter/recovery/roles, bodyless real Publish.
   Enable/merge only against actual backend and exact combined-head checks.
   B may split calendar and month UI into bounded nonoverlapping commits.
4. **C independent acceptance/integration**: real Publish/month/calendar browser
   flow, negative security/legacy, keyboard/mobile/realistic roster review; owner
   disposition. No SQL PUBLISHED fixture substitute.

Codex paths: `apps/backend/src/modules/workforce/project-operating-calendars/**`,
`modules/planning/**`, narrow Identity/error/audit/schema seams, additive migrations,
backend test files. Claude: all React/client `features/projects/**`,
`features/planning/monthly-plans/**`, auth transport/frontend/app-shell tests.
QA: separately named new browser/evidence file after assignment; fixes return to
owner. No shared harness concurrent edits. Exact commands/counts/NOT_RUN per PR.

## Exact next backend mission, after explicit approval/authorization

**A1 backend only:** on integrated main after #86, implement approved project
calendar schema/API and **all existing writer/Publish guards** as one coherent
release. First vertical slice: seven-day vs Mon-Fri -> SP-11/SP-12 rejection ->
First Publish revalidation -> calendar/duty both-order COMMIT/ROLLBACK -> mandatory
audit failure rollback, actual migrations on identity-verified disposable PG.
No changes to0013, CR-03, existing lease token contract, D2-D5, old shift-config
last-writer-wins API, frontend or placeholders. Missing/bootstrap/audit contract
must be signed before fixture assumptions. A1 does not authorize A2 automatically.

Recommend measuring real remaining MUST/review/staging capacity immediately,
reserving independent reviewers, then agreeing additional bounded capacity/date
if conservative path exceeds available days. Do not weaken security/atomicity,
silently spend QA reserve, remove MUST, or equate agents with human approvers.
