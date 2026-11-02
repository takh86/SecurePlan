# SP-88 atomic employee-month design + SP-90 project weekdays

Revision 2026-11-02, design gate for [#88](https://github.com/takh86/SecurePlan/issues/88),
[#90](https://github.com/takh86/SecurePlan/issues/90), Draft [PR #89](https://github.com/takh86/SecurePlan/pull/89).
Supersedes the dual-selection proposal at5467e21. No runtime application change.

Approved: persistent TAG/NACHT/FREI paint mode before dates; exactly one daily
state per employee/project/company-local date; repeat same paint is no-op; one
atomic Monat speichern; preserve others; FREI never absence; project-specific
operating weekdays. These are product rules, not legal-compliance certification.

Proposed: complete exclusive desired month with separate shared-duty preconditions,
calendar version precondition, one final-state transaction under LOCK-01-L1,
existing-lease admission, immutable idempotent result and safe recovery. Separate
small month-effective calendar table/API avoids retroactively rewriting history.
Creation-on-real-assignment/retained empty duties, calendar compatibility/bootstrap,
audit vocabulary, capacity and technical T1-T4 still need explicit approval.

| Artifact | Review content |
|---|---|
| [01 Requirements/source impact](01-impact-and-sources.md) | Approved corrections, baseline traceability, controlled amendment and foundations |
| [02 Domain and UX](02-domain-and-ux.md) | Exclusive paint state, roles, history, duties, retained input |
| [03 API and recovery](03-api-and-idempotency.md) | Complete November request/receipt, versions/calendar, errors, additive persistence |
| [04 Transaction/security](04-transaction-and-security.md) | Exact locks, leases, all-writer invariants, session/audit/privacy |
| [05 Acceptance/backlog](05-acceptance-and-delivery.md) | Actual-schema implementation tests and file ownership |
| [06 Decision sheet](06-decision-sheet.md) | Remaining P1-P6, technical T1-T4 and next authorization |
| [07 Investigation evidence](07-investigation-evidence.md) | Historical experiment versus revision checks; explicit NOT_RUN |
| [08 Claude handoff](08-frontend-handoff.md) | Approved UX versus proposed wire contracts; #91 gaps |
| [09 Reforecast](09-reforecast.md) | Credited remaining work, MUST backlog, capacity/parallelism and mission |
| [SP-90 calendar design](../sp90-project-operating-weekdays.md) | Alternatives, schema, GET/PATCH, effective guard, migration/audit |

#86/#87/#91 remain unchanged and unmerged by this mission. #86 independent review
and #87 bounded-foundation disposition do not accept SP-88 or close #85. #91 is
stacked preview preparation, not persistence or approved final UX.

Application acceptance for the revised rules is NOT_RUN. Historical baseline CI
and14/14 stand-in PG mechanisms do not prove the new rules, calendar schema or
cross-writer safety. See evidence for exact scope and revision check commands.
