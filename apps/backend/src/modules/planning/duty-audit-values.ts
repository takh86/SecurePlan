/**
 * Bounded duty and membership audit values (ADR-0004 SP-12 supplement). Shared by every duty writer so that
 * DUTY_UPDATED, DUTY_MEMBERSHIP_ADDED / _REMOVED carry the same API-vocabulary shapes everywhere:
 *   D = {planId, dutyDate, shiftKind, startsAt, endsAt, version}
 *   M = {dutyId, employeeId, dutyRole, source}
 * Removal instants are rendered by PostgreSQL (UTC, six fractional digits), never from application time.
 */
import { type DutyRow, type MembershipRow, toDutyAssignmentResponse, toMonthlyPlanEntryResponse } from './monthly-plan.mapper.js';

/** `removed_at` of the row being RETURNed; the alias of the table must not be used here. */
export const removalColumn = `to_char(removed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS removed_at`;

export const memberValues = (row: MembershipRow) => {
  const member = toDutyAssignmentResponse(row);
  return { dutyId: row.duty_id, employeeId: member.employeeId, dutyRole: member.dutyRole, source: member.source };
};

export const dutyValues = (planId: string, row: DutyRow) => {
  const entry = toMonthlyPlanEntryResponse(row, [], new Set());
  return { planId, dutyDate: entry.dutyDate, shiftKind: entry.shiftKind, startsAt: entry.startsAt, endsAt: entry.endsAt, version: entry.version };
};
