# SP-88 / SP-90 decision sheet - revised 2026-11-02

## Already approved; do not reopen

BR-1 exclusive DAY/NIGHT/FREI per employee/project/company-local duty date;
BR-2 persistent paint before dates, replace rather than toggle;
BR-3 FREI is unscheduled, never absence; BR-4 one atomic Save with all required
audits and retained input on failure; BR-5 preserve other staff. Project-defined
operating weekdays must be enforced by UI/backend. UTC overlap remains separate.
Primary employee-month view, matrix overview, explicit rebase on shared edits,
stay after Save with Nächste Person, no extra bulk helper are recorded owner
review direction. No legal certification, implementation or merge approval implied.

## Remaining Product Owner / controlled-scope decisions

| ID | Recommended default | Trade-off / alternative |
|---|---|---|
| P1 remaining | Full desired month, exclusive desired state plus two slot preconditions/date; require explicit legacy-dual correction; conservative full-month conflicts | Delta-only saves reduce unrelated conflicts but require a different read/intent protocol. Paint/exclusivity themselves are already approved |
| P2 duty lifecycle | Create canonical duty only for a real new assignment; retain existing empty duties, including after last-member removal; separate explicit SP-12 delete | No placeholders created in normal month workflow. Retained empty duties continue to block time/calendar dependencies. Never infer deletion permission |
| P3 scope/capacity | Approve controlled M3/M4/A10/Phase8 amendments and measured remaining-MUST plan; use revised ranges in reforecast pending measurement | No silent MUST cuts, automatic approval from agent speed, or Dec 3 promise |
| P4 calendar applicability | Separate complete month-effective weekly set;1-7 ISO weekdays; NIGHT start date; compatible updates allowed but no newly closed live saved duty, including empty; strict full Publish validation | No all-closed set, retroactive override or holiday subsystem. Alternative all-closed/empty-duty exemptions need explicit deltas |
| P5 legacy/bootstrap | No guessed migration seed; MISSING blocks new work/Publish, permits no-op/removal; explicitly requested one-time historical bootstrap must cover every live duty date | Needs review of past initialization exception; alternative owner-supplied per-project migration mapping. Never silently assume all seven or delete legacy rows |
| P6 calendar audit vocabulary | One PROJECT_OPERATING_CALENDAR_UPDATED / PROJECT_OPERATING_CALENDAR / projectID with exact bounded old/new month, weekdays, version, bootstrap marker | New action requires explicit business audit owner + security approval; existing SHIFT_CONFIGURATION_UPDATED must not be relabelled silently |

Existing SP-12 project/roster eligibility continues; no new staffing minimum,
historic planning freeze, hours/rest law or availability model is requested.
Details: [calendar](../sp90-project-operating-weekdays.md), [domain](02-domain-and-ux.md).

## Technical approval checklist T1-T4 (all pending)

| Gate | Exact review scope | Required proof / owner |
|---|---|---|
| T1 API/requirements | Exclusive desired union; complete read set, expectedCalendar and creation checksum; project GET/PATCH exact/effective version and next-boundary preconditions; strict safe conflict whitelist and new error catalogue/OpenAPI; no body/header changes for existing SP-12 | API/requirements owner signs codec, examples, precedence, bounds, projection consistency and migration-facing MISSING/legacy behavior |
| T2 PostgreSQL/LOCK-01/leases | A/C/I/E/P/M/L UPDATE/all D/all A2/all Q/Z; tentative new duties at ordered D; E-protected exclusive final set; P-protected calendar/no new child locks in guard; internal admission blocks any live affected lease, own tab included | Architecture/DB/security approve ADR-0006/Phase8.7 supplement; actual-schema both orders COMMIT/ROLLBACK, missing slots, calendar and shared-roster races; no late parent or upgrade |
| T3 DB/idempotency | Additive calendar and operation-discriminated receipt migrations, never edit0013; unchanged Publish codec; SAVE_V2 semantic hash includes exclusive intent/calendar; context FK short claim prefix, immutable bounded receipt, fencing/result GET | DB/API reviewer validates migration replay/old records/schema classification/privacy, partial SQL/audit/receipt rollback, lost response and expired receipt |
| T4 Identity/security/audit | Fresh transaction-aware session read under A/C, no validateAndTouch upgrade; tenant/role checks on execute/replay/lookup; hidden actor-bound memory draft; neutral legacy/weekday errors; scoped existing duty audits and new calendar action only when approved | Identity/security/audit owners approve revocation/expiry races, different-login isolation, audit payload/envelope, receipt privacy/retention and exact new vocabulary |

Approvals record approver/role/date/exact design commit, accepted default or delta,
controlled amendment/version and backport owner. Approval must be followed by
explicit implementation authorization. Author review, CI and owner UX approval
are separate; this package claims none of them.

## Sequence and blockers

Foundation #86 remains independently reviewable as its current approved contract;
new cross-writer rules require a later amendment on integrated main. #87 is a
bounded supporting foundation only, pending owner disposition/combined checks;
#91 stays Draft, must replace independent toggles, and is not merge-ready. Do not
modify those PRs in this mission or close #85.

After approvals: A1 calendar DB/API plus **all existing writer/Publish guards** ->
A2 SP-88 backend/read/save/result/idempotency and actual PG proof -> B Claude-owned
calendar UI + exclusive month adapter -> C real Publish/browser/security integration.
A1 and A2 may be developed sequentially in Codex while B uses frozen contract
fixtures; enable no writer before its guards/migrations are present. Independent
QA reviews and prepares separate evidence/harness files, serializes heavy DB runs.

Next authorized coding request should be the bounded **A1 backend foundation**
mission in [reforecast](09-reforecast.md), not a partial monthly PATCH loop.
Company IANA-zone display/API remains a separate #85 integration decision.
