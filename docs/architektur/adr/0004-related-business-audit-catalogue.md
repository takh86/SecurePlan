# ADR-0004 — Bounded catalogue for related assignment and shift audit actions

- **Status:** Names and existing business meanings approved by PO D1; independent
  documentary acceptance of the controlled catalogue amendment pending.
- **Date:** 2026-10-29.
- **Authority:** [Issue #64, D1–D6](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6502123168),
  [original Case 4](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6474708196),
  [removal contract](https://github.com/takh86/SecurePlan/issues/73#issuecomment-6492654582),
  and [ADR-0003](0003-schichtkonfiguration-monatsversioniert.md).
- **Scope:** Public summary derived from the approved public decisions and
  implemented code at `7107781e1cbd9aab232cd394662372c1fb7cf92f`.
  This document does not publish the private baseline or replace its controlled register.

## Decision

Retain the following four names and their current semantics. D1 does not approve
every member of `BusinessAuditAction`. No event rename, schema change, historical
backfill or new success event is introduced by this reconciliation.

| Action | Resource | `oldValues` | `newValues` |
|---|---|---|---|
| `PROJECT_ASSIGNMENT_CREATED` | `PROJECT_ASSIGNMENT`, newly created assignment ID | SQL null | Complete `{employeeId, projectId, monthStart}` tuple |
| `PROJECT_ASSIGNMENT_CORRECTED` | `PROJECT_ASSIGNMENT`, existing assignment ID | Only changed members of `{employeeId, projectId, monthStart}` | The corresponding changed members plus `scope` |
| `PROJECT_ASSIGNMENT_REMOVED` | `PROJECT_ASSIGNMENT`, physically removed assignment ID | Complete removed `{employeeId, projectId, monthStart}` tuple | SQL null |
| `SHIFT_CONFIGURATION_UPDATED` | `PROJECT_SHIFT_CONFIGURATION`, **project ID** | `{effectiveFromMonth, shifts}` for the set stored at that exact month, or SQL null for its first creation | `{effectiveFromMonth, shifts}` for the complete resulting set |

Correction `scope` is `FUTURE` only if **both** old and resulting month are after
the company-local current month; otherwise it is `HISTORICAL`. A historical→future
move retains HISTORICAL scope while enforcing the approved destination-future
employment and ACTIVE rules. Scope is in `newValues`, not both value objects.
Audit contains the delta, not a fabricated full before/after tuple.

Each shift set contains 1–2 rules with only `shiftKind`, `startLocal`, `endLocal`;
API kinds are DAY/NIGHT and local times are HH:mm. The old set belongs to the
**exact replaced effective month**, not the older effective version inherited
when that month had no version. Full-set replacement is the business operation;
the implementation can preserve IDs by diff-applying rows. It emits one event,
not an event per shift or dependent duty. An order-only identical set is a no-op.

## Attribution, minimization and atomicity

All four successful operations are COMPANY_ADMIN writes using trusted session
tenant and transactional actor recheck. Each event carries company, actor account,
action, resource type/ID, server-issued request correlation ID and database
`occurred_at`. The audit uses the caller's transaction client.

Assignment payloads contain at most three tuple members per side plus correction
scope; shift payloads contain at most two rules per side. No names, email,
credentials, tokens, free-text reasons, full plan copies or unbounded dependency
lists are included. Employee/account IDs remain **pseudonymous personal data**;
their presence is intentional and still requires access and retention controls.

- Exactly one success event per effective successful operation.
- True correction/configuration no-op: no mutation and no audit.
- Removal has no successful absent-row no-op: repeated DELETE returns concealed
  404, leaves the final absent state unchanged and emits no second success audit.
- Authorization, validation, version, month and dependency refusals emit no
  business success audit.
- An audit insertion failure rolls back the business mutation. A later failure
  inside the same transaction also rolls back its audit. No silent cascade or
  automatic replacement accompanies removal.
- Audit resource IDs are not a foreign key requiring the removed assignment to
  survive. The full old tuple remains reconstructable from the removal event.

## Verification and remaining acceptance

Existing Real-PG assertions are in `project-assignments-real.e2e-spec.ts`,
`project-assignments-patch-real.e2e-spec.ts`,
`project-assignments-remove-real.e2e-spec.ts`, their concurrency suites and
`shift-configurations-real.e2e-spec.ts`. They check attribution, bounded values,
scope, no-op/refusal and audit rollback. See the
[CI and closeout matrix](../../reviews/sp09-closeout-64-73.md) for actual run IDs
and totals. No database tests are executed by this documentation audit.

The source comments in `business-audit.service.ts` still describe these names as
provisional and say no catalogue exists. That wording predates PO D1. This
documentation-only change records the later authority; it deliberately leaves
application files untouched. Other actions in that union retain their own
approval status, including development-only activation recovery.

The ignored local canonical amendment records the baseline comparison and these
four definitions. Independent Tech Lead/API/audit-owner acceptance of that
document remains required before #64/#73 administrative closure. Original
baselines and earlier ADR history remain preserved.

Retention period, database-role append-only enforcement, privileged access,
privacy policy, backups and restore proof are separately tracked in
[#51](https://github.com/takh86/SecurePlan/issues/51) and the
[pre-staging gates](../../security/pre-staging-gates.md). Application append-only
convention is not database immutability, and D1 does not approve indefinite
retention or operational readiness.
