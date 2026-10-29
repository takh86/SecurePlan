/** Approved Issue #64 Case 2: the only Problem Details variant with assignment hints. */
export const EMPLOYMENT_PERIOD_CONFLICT = 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_PROJECT_ASSIGNMENTS';
export const MAX_EMPLOYMENT_CONFLICTS = 25;

export type EmploymentPeriodConflict = {
  conflictCount: number;
  conflictingAssignments: { assignmentId: string; monthStart: string }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/;

/** Reconstruct allowed fields only. Inconsistent internal summaries fail closed. */
export function safeEmploymentPeriodConflict(value: unknown): EmploymentPeriodConflict | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { conflictCount, conflictingAssignments } = value as Record<string, unknown>;
  if (typeof conflictCount !== 'number' || !Number.isSafeInteger(conflictCount) || conflictCount < 1
    || !Array.isArray(conflictingAssignments)
    || conflictingAssignments.length !== Math.min(conflictCount, MAX_EMPLOYMENT_CONFLICTS)) return undefined;
  const result: EmploymentPeriodConflict['conflictingAssignments'] = [];
  const ids = new Set<string>();
  let previous = '';
  for (const item of conflictingAssignments) {
    if (typeof item !== 'object' || item === null) return undefined;
    const { assignmentId, monthStart } = item as Record<string, unknown>;
    if (typeof assignmentId !== 'string' || !UUID.test(assignmentId)
      || typeof monthStart !== 'string' || !MONTH.test(monthStart)) return undefined;
    const key = `${monthStart}/${assignmentId}`;
    if (key <= previous || ids.has(assignmentId)) return undefined;
    previous = key;
    ids.add(assignmentId);
    result.push({ assignmentId, monthStart });
  }
  return { conflictCount, conflictingAssignments: result };
}
