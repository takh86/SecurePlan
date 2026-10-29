# Employment-period changes and monthly project assignments

Implementation scope: Issue #64 Case 2. Contract approval: [independent Tech Lead / API-owner sign-off](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6499148328). Code review and merge approval remain separate.

An effective change to `employmentStart`, `employmentEnd`, or both rejects the entire employee PATCH only when an existing tenant-owned monthly assignment satisfies:

```text
assignment month > company current month
AND covered(previous interval, assignment month)
AND NOT covered(resulting interval, assignment month)
```

Coverage requires a non-null start and inclusive calendar-date overlap. Null end is open-ended. The company month uses one injected server instant and its stored named IANA timezone. Current/past assignments remain history. Existing invalid future rows, inactive employees and inactive/archived project references do not change this predicate. Explicitly unchanged dates skip the new guard; a complete no-op still writes no audit.

The existing 400 date-order validation, concealed 404, no-op and employee-code precheck keep their precedence. Other fields in a rejected mixed PATCH remain unchanged.

## Conflict response

`409 EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_PROJECT_ASSIGNMENTS` uses the existing RFC 9457 envelope, `application/problem+json` and `Cache-Control: no-store`.

- `type`: `/problems/employment-period-excludes-future-project-assignments`
- `title`: `Conflict`
- Fixed `detail`: `The changed employment period would no longer cover existing future monthly project assignments. Review and correct or remove the conflicting assignments first.`
- Server correlation ID in body/header and the matching occurrence `instance`.
- `conflictCount`: exact positive safe integer, including conflicts beyond the returned sample.
- `conflictingAssignments`: exactly `min(conflictCount, 25)` references `{assignmentId, monthStart}`, ordered by month then UUID ascending. Count greater than sample length means truncation.

The filter validates and reconstructs these two extensions only for this code/status. Malformed internal summaries become sanitized 500 responses. No names, project metadata, versions or tenant identifiers are included. References are recovery hints, never authority to delete.

## Atomicity and audit

The existing transaction retains actor/account/company SHARE locks and employee UPDATE locking. The impact query is a **fresh READ COMMITTED statement after the separate employee locking read**. Count, historical count and bounded sample use one statement snapshot and a tenant/employee-scoped predicate; LIMIT applies before sample aggregation, never to the exact count. No assignment locks, mutations, new indexes or migrations are introduced.

Supported assignment POST/PATCH/DELETE writers already hold conflicting employee NO KEY UPDATE locks. These writers serialize with employment updates. Foreign-key KEY SHARE only protects existence; arbitrary SQL bypassing the writer protocol can still violate employment coverage. This is an application protocol, not a database constraint.

Accepted effective date changes write one `EMPLOYEE_UPDATED` in the same transaction. Both old and resulting employment bounds are present, while `changedFields` contains only actual changes. `newValues.employmentPeriodImpact` contains exactly:

```ts
{
  newlyUncoveredHistoricalAssignmentCount: number; // exact, including zero
  evaluatedAt: string; // captured UTC instant after employee lock acquisition
  companyCurrentMonth: string; // YYYY-MM-01
  companyTimeZone: string;
}
```

Historical impact counts only newly uncovered months at or before the company cutoff. No assignment array is copied into audit. Rejection/full no-op produces no business audit; audit or response-mapping failure rolls back the mutation. Existing audit retention/access/tamper-control policy gates remain open; this change does not assert database immutability or check actual duties.

## Administrator recovery

The safe German form-level message preserves every unsaved field. “Zukünftige Projektzuordnungen prüfen” explicitly refreshes S-9 page 1 and focuses its heading. The section can contain covered and already-invalid rows as well as conflicting rows. No requirement to empty it is introduced.

Administrators review assignments, explicitly remove selected rows using freshly discovered `Expected-Version`, then explicitly save the employment dates. Deactivation and later replacement remain separate actions. There is no automatic write retry, batch removal or replacement. The #73 removal contract and E-10 planning guard are unchanged.

## Verification locations

- `employee-employment-period-real.e2e-spec.ts`: interval/null/no-op/legacy/history/calendar/timezone, exact HTTP schema/truncation, tenant/guard precedence, audit and rollback.
- `employee-employment-period-concurrency-real.e2e-spec.ts`: both lock orders for POST/PATCH/DELETE and employee/deactivation writes, rollback, fresh snapshots, company locking, lock compatibility and raw-writer limitation probes.
- `project-assignments-remove-concurrency-real.e2e-spec.ts`: API-CON-12 retains April as a blocker after March removal; deactivation remains successful.
- `problem-details.filter.spec.ts`: fail-closed extension projection and non-disclosure on other codes/statuses.
- Frontend conflict parser/form tests plus existing S-9, removal and late-response regressions.

Runtime results and unexecuted browser checks belong in the PR evidence; mocked component tests do not establish browser completion. SP-10/SP-11 and real planning dependencies remain outside this implementation. Later PO D1–D6 approves the duty/DST business rules, while their detailed contracts and implementation remain in the [SP-11 handoff](../datenbank/sp11-integrity-handoff.md). [Closeout evidence](../reviews/sp09-closeout-64-73.md) records merged PR #76, exact CI, pending controlled-document acceptance and browser NOT_RUN.
