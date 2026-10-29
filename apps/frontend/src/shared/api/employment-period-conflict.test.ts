import { describe, expect, it } from 'vitest';
import { describeApiError, parseApiError } from './api-error';

const code = 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_PROJECT_ASSIGNMENTS';
const ref = (n = 0) => ({ assignmentId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, monthStart: `2027-${String(n + 1).padStart(2, '0')}-01` });
const parse = (summary: unknown, status = 409) => parseApiError(new Response(JSON.stringify({ code, detail: 'unsafe raw text', ...summary as object }), { status, headers: { 'Content-Type': 'application/problem+json' } }));

describe('Case 2 client error summary', () => {
  it.each([1, 25, 26, 101])('keeps a bounded validated %s-count hint and safe guidance', async (count) => {
    const refs = Array.from({ length: Math.min(count, 25) }, (_, n) => ({ ...ref(n), monthStart: `${2027 + Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, '0')}-01` }));
    const summary = { conflictCount: count, conflictingAssignments: refs };
    const error = await parse({ ...summary, futureExtension: 'ignored' });
    expect(error.employmentPeriodConflict).toEqual(summary); expect(describeApiError(error).canRetry).toBe(false);
    expect(describeApiError(error).description).not.toContain('unsafe');
  });
  it.each([
    {}, { conflictCount: 1, conflictingAssignments: [] }, { conflictCount: 26, conflictingAssignments: [ref()] },
    { conflictCount: '1', conflictingAssignments: [ref()] }, { conflictCount: 0, conflictingAssignments: [] },
    { conflictCount: 1.1, conflictingAssignments: [ref()] }, { conflictCount: Number.MAX_SAFE_INTEGER + 1, conflictingAssignments: [ref()] },
    { conflictCount: 26, conflictingAssignments: Array(26).fill(ref()) },
    ...['x', '00000000-0000-4000-8000-00000000000A'].map((assignmentId) => ({ conflictCount: 1, conflictingAssignments: [{ ...ref(), assignmentId }] })),
    ...['2027-02-02', '2027-13-01', '0000-01-01', '2027-2-01'].map((monthStart) => ({ conflictCount: 1, conflictingAssignments: [{ ...ref(), monthStart }] })),
    { conflictCount: 2, conflictingAssignments: [ref(), ref()] }, { conflictCount: 2, conflictingAssignments: [ref(1), ref(0)] },
  ])('rejects the entire malformed hint %# without losing guidance', async (summary) => {
    const error = await parse(summary); expect(error.code).toBe(code); expect(error.employmentPeriodConflict).toBeUndefined();
    expect(describeApiError(error).title).toContain('Beschäftigungszeitraum');
  });
  it.each([400, 401, 403, 404, 500])('does not recognize the code or hint under HTTP %s', async (status) => {
    const error = await parse({ conflictCount: 1, conflictingAssignments: [ref()] }, status);
    expect(error.code).toBeNull(); expect(error.employmentPeriodConflict).toBeUndefined();
  });
});
