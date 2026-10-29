import { toFutureProjectAssignmentResponse, type FutureProjectAssignmentRow } from './project-assignment.mapper.js';

const row: FutureProjectAssignmentRow = {
  id: 'assignment', employee_id: 'employee', project_id: 'project', month_start: '2027-01-01',
  version: '1793275200123456', project_name: 'Visible project', project_status: 'ACTIVE',
};

describe('S-9 future assignment projection', () => {
  it.each(['ACTIVE', 'INACTIVE'])('keeps visible %s metadata and the exact assignment version', (status) => {
    expect(toFutureProjectAssignmentResponse({ ...row, project_status: status })).toEqual({
      id: 'assignment', employeeId: 'employee', projectId: 'project', monthStart: '2027-01-01',
      version: 1793275200123456, projectName: 'Visible project', projectStatus: status,
    });
  });

  it.each(['ARCHIVED', 'UNKNOWN', null])('defensively masks both metadata fields for %s even if a query delivered a name', (status) => {
    const projected = toFutureProjectAssignmentResponse({ ...row, project_status: status, project_name: 'Hidden label' });
    expect(projected).toMatchObject({ id: 'assignment', projectId: 'project', projectName: null, projectStatus: null });
    expect(JSON.stringify(projected)).not.toContain('Hidden label');
  });

  it('never leaks an unsafe assignment version', () => {
    expect(() => toFutureProjectAssignmentResponse({ ...row, version: '9007199254740992' })).toThrow();
  });
});
