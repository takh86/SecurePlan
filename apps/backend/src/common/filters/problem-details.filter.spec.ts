import { BadRequestException, ConflictException, HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { EMPLOYMENT_PERIOD_CONFLICT as CODE } from '../errors/employment-period-conflict.js';

const reference = { assignmentId: '0d0b92c8-89d9-4fe1-a57c-9d6bc78b2ce8', monthStart: '2027-03-01' };
const valid = { conflictCount: 1, conflictingAssignments: [reference] };

function render(exception: unknown) {
  const response = { setHeader: vi.fn(), status: vi.fn(), type: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response); response.type.mockReturnValue(response);
  const host = { switchToHttp: () => ({
    getRequest: () => ({ correlationId: 'server-reference', method: 'PATCH' }), getResponse: () => response,
  }) } as unknown as ArgumentsHost;
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  new ProblemDetailsFilter().catch(exception, host);
  return { response, problem: response.json.mock.calls[0][0] as Record<string, unknown> };
}
afterEach(() => vi.restoreAllMocks());

describe('Case 2 Problem Details trust boundary', () => {
  it('projects exactly nine safe members, ignores arbitrary payloads and disables caching', () => {
    const { problem, response } = render(new ConflictException({
      code: CODE, ...valid, detail: 'unsafe SQL', errors: [{ pointer: '#/firstName', code: 'REQUIRED' }],
      companyId: 'foreign', conflictingAssignments: [{ ...reference, projectName: 'private' }],
    }));
    expect(problem).toEqual({
      type: '/problems/employment-period-excludes-future-project-assignments', title: 'Conflict', status: 409,
      detail: 'The changed employment period would no longer cover existing future monthly project assignments. Review and correct or remove the conflicting assignments first.',
      code: CODE, correlationId: 'server-reference', instance: '/problems/occurrences/server-reference', ...valid,
    });
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.type).toHaveBeenCalledWith('application/problem+json');
  });

  it.each([
    {}, { ...valid, conflictCount: 0 }, { ...valid, conflictCount: -1 }, { ...valid, conflictCount: 1.2 },
    { ...valid, conflictCount: '1' }, { ...valid, conflictCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, conflictingAssignments: null }, { ...valid, conflictingAssignments: [] },
    { ...valid, conflictCount: 26 }, { ...valid, conflictingAssignments: Array(26).fill(reference) },
    ...['invalid', reference.assignmentId.toUpperCase()].map((assignmentId) => ({ ...valid, conflictingAssignments: [{ ...reference, assignmentId }] })),
    ...['2027-02-29', '2027-13-01', '0000-01-01', '2027-3-01'].map((monthStart) => ({ ...valid, conflictingAssignments: [{ ...reference, monthStart }] })),
    { conflictCount: 2, conflictingAssignments: [reference, reference] },
    { conflictCount: 2, conflictingAssignments: [{ ...reference, monthStart: '2027-04-01' }, { ...reference, assignmentId: '1d0b92c8-89d9-4fe1-a57c-9d6bc78b2ce8' }] },
  ])('fails closed on malformed internally generated summary %#', (summary) => {
    const { problem } = render(new ConflictException({ code: CODE, ...summary, detail: 'private' }));
    expect(problem.status).toBe(500); expect(problem.code).toBe('INTERNAL_ERROR');
    expect(problem).not.toHaveProperty('conflictingAssignments'); expect(problem).not.toHaveProperty('conflictCount');
    expect(JSON.stringify(problem)).not.toContain('private');
  });

  it.each([
    new ConflictException({ code: 'EMPLOYEE_CODE_ALREADY_EXISTS', ...valid }),
    new BadRequestException({ code: 'EMPLOYMENT_DATE_CONFLICT', ...valid }),
    new HttpException({ code: CODE, ...valid }, 400),
    new HttpException({ code: 'RESOURCE_NOT_FOUND', ...valid }, 404),
    new HttpException({ code: 'ACTION_FORBIDDEN', ...valid }, 403),
    new ConflictException({ code: 'NOT_APPROVED', ...valid }), new Error('private SQL'),
  ])('never forwards extensions for another status/code %#', (exception) => {
    const { problem } = render(exception);
    expect(problem).not.toHaveProperty('conflictingAssignments'); expect(problem).not.toHaveProperty('conflictCount');
  });
});
