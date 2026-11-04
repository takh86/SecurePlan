import { personalPlan } from './my-month-plan.test-support';
import type { CancellationResponse } from './cancellation-api';
export function cancellation(): CancellationResponse {
  const duty = personalPlan().items[0].duties[0];
  return {
    id: '70000000-0000-4000-8000-000000000001',
    assignmentId: duty.assignmentId,
    employee: {
      id: '80000000-0000-4000-8000-000000000001',
      employeeCode: 'SYN-1',
      firstName: 'Synthetic',
      lastName: 'Employee',
    },
    duty: {
      id: duty.dutyId,
      dutyDate: duty.dutyDate,
      shiftKind: duty.shiftKind,
      startsAt: duty.startsAt,
      endsAt: duty.endsAt,
    },
    status: 'OPEN',
    createdAt: '2026-11-04T14:00:00.123Z',
    decidedAt: null,
    replacementNeed: {
      id: '90000000-0000-4000-8000-000000000001',
      status: 'OPEN',
      resolvedAt: null,
    },
  };
}
