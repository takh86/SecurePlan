import type { MeIdentity } from '../../auth/auth-api';
import type { MyMonthlyPlansResponse } from './my-month-plan-types';
export const employeeIdentity: MeIdentity = {
  accountId: '40000000-0000-4000-8000-000000000001',
  companyId: '50000000-0000-4000-8000-000000000001',
  email: 'employee@example.invalid',
  role: 'EMPLOYEE',
  companyTimeZone: 'Europe/Berlin',
  currentCompanyMonth: '2026-12-01',
};
export function personalPlan(): MyMonthlyPlansResponse {
  return {
    items: [
      {
        planId: '10000000-0000-4000-8000-000000000001',
        project: { id: '20000000-0000-4000-8000-000000000001', name: 'Synthetic Nord' },
        monthStart: '2026-12-01',
        duties: [
          {
            dutyId: '30000000-0000-4000-8000-000000000001',
            dutyDate: '2026-12-31',
            shiftKind: 'NIGHT',
            startsAt: '2026-12-31T17:00:00Z',
            endsAt: '2027-01-01T05:00:00Z',
            dutyRole: 'EMPLOYEE',
            timeZone: 'Europe/Berlin',
          },
        ],
      },
    ],
  };
}
