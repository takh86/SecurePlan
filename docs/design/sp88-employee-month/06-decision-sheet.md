# SP-88 decision sheet

Status 2026-11-02: recommendations ready; decisions below are **PENDING**, not
inferred from the request to design or from CI. The one-employee/month interaction,
single final Save, complete atomic rollback, safe conflicts and retained input
are already approved by #88 and are not being reopened.

## Product Owner decisions genuinely remaining

| ID | Recommended default to approve | Trade-off / controlled impact |
|---|---|---|
| P1 — desired-state and primary UX detail | Full month with explicit DAY/NIGHT selections and removal states, retained roles/source/history, both kinds allowed when UTC intervals do not overlap; full-month slot preconditions and explicit rebase; existing plan/assignment as prerequisites | Resolve A10 single-choice sketch and conservative conflicts, including unrelated staff edits in the month. A delta-only API or single-kind UI is an alternative, not an approved default. No staffing/rest-time rule added |
| P2 — duty lifecycle side effects | Assignment to an absent slot creates its canonical duty atomically; unselected absence creates nothing; retain all existing empty duties and other employees; no duty time/kind mutation | Convenient employee-first planning, but empty duties continue to block affected configuration changes under D3. Alternative explicit duty creation adds steps; automatic whole-duty cleanup risks other workflows and is not recommended |
| P3 — scope/effort baseline | Adopt a controlled M4/A10 amendment and measured remaining-capacity reforecast; use 62–100h package estimate until re-estimated; keep Dec 3 uncommitted/high risk until capacity is reconciled | New meaningful work exceeds the former A10 allowance. Choose real capacity/date adjustment if needed; no silent MUST cuts, lost atomicity or assumed weekend overtime |

No new owner choice is needed to preserve CR-03, tenant isolation, existing
employee/date eligibility, historical tombstones, zero staffing minimum, source
preservation or neutral availability. Those already have authority. P1 records
their application to the new UX, rather than changing them. If the owner wants
an exception (for example editing an inactive project's history), that is a new
separate proposal, not a hidden prerequisite to this gate.

## Technical / API / security decisions

| ID | Recommended contract to ratify | Required reviewers / proof |
|---|---|---|
| T1 — API and error extension | POST save action plus projection/result GETs; complete 28–31-day DTO and 62-slot maximum; lifecycle and duty ID/version/absence preconditions; new-slot creation-context checksum; new bounded batch error | API/requirements owner: endpoint/DTO/OpenAPI/error-catalogue amendments and strict Problem Details whitelist. Existing single-duty header/status semantics unchanged |
| T2 — LOCK-01 and lease mode | Full L1 parent discovery/prefix, L UPDATE immediately, all D then A2 then Q sorted, provisional new duties at D phase, final-state validation overlay; short internal admission blocks any active affected interactive lease, including own account | PostgreSQL/architecture/security: explicit Phase 8.7/ADR-0006 supplement, no late parent/upgrade, both-order COMMIT/ROLLBACK tests and realistic lock footprint. Existing SP-12 lease APIs retain token rules |
| T3 — durable command result | Additive operation-discriminated idempotency migration; immutable bounded SaveResult; shared tested reservation/fencing protocol, context-FK claim prefix, exact semantic fingerprint, authorized safe result lookup | DB/API/security: migration/old-record regression, 24h replay/5min stale settings, no raw keys or cached absence facts, no automatic retries; never widen 0013 without updating constraints/codecs |
| T4 — security/audit scope | Fresh Identity session read under existing A/C, strict neutral per-day errors, context-bound hidden memory retention after authorization failure, same-transaction existing duty/membership audit events only; no new audit vocabulary or notification promise | Identity/security/audit owner: session admission/expiry/revocation races, same-actor reauthentication/different-login isolation, bounded result privacy/retention, explicit permission to use existing audit shapes for this command. #86's Publish audit approval is not this approval |

T1/T2 include deliberate departures from the older single-duty-only API
interaction, not changes to existing SP-12 callers. Rejecting a lease-owning tab
without a supplied proof is intentional; silently rotating it is not acceptable.
The authoritative company-IANA-zone **display/API** decision stays separately
open under #85; an opaque creation checksum does not decide it or certify UX.

## Approval record to complete, without changing historical baselines

For each P/T decision record: approver/role, date, exact design commit/hash,
accepted default or concrete delta, controlled amendment ID/version and backport
owner. Then record a separate explicit authorization to implement PR A/B/C.
Technical review, green implementation tests, human UX acceptance and merge/
deployment authorization remain distinct. This document supplies none of them.

Foundation disposition: #86 is independent backend work eligible for its normal
review; #87 may merge only after an explicit bounded foundation-scope decision
and combined verification. Neither alone completes #88 or closes #85. Prefer
foundation #86 → bounded #87 → A backend → B employee-month UI → C combined
Publish/browser acceptance. Keep all issue status/merge decisions with the owner.
