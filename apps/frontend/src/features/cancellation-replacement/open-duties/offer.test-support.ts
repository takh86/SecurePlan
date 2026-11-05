import type { Need, Offer } from './offer-api';
export const employee = '20000000-0000-4000-8000-000000000001';
export const need = (): Need => ({
  id: '20000000-0000-4000-8000-000000000002',
  cancellationRequestId: '20000000-0000-4000-8000-000000000003',
  duty: {
    id: '20000000-0000-4000-8000-000000000004',
    dutyDate: '2027-01-20',
    shiftKind: 'DAY',
    startsAt: '2027-01-20T05:00:00Z',
    endsAt: '2027-01-20T17:00:00Z',
  },
  status: 'OPEN',
  resolvedAt: null,
  openOfferCount: 0,
  project: { id: '20000000-0000-4000-8000-000000000005', name: 'Testprojekt' },
  timeZone: 'Europe/Berlin',
});
export const offer = (): Offer => ({
  id: '20000000-0000-4000-8000-000000000006',
  needId: need().id,
  employee: {
    id: employee,
    employeeCode: 'T1',
    firstName: 'Test',
    lastName: 'Person',
  },
  status: 'OPEN',
  createdAt: '2026-11-05T06:00:00.000Z',
  decidedAt: null,
});
export const page = () => ({
  items: [{ need: need(), myOffer: null }],
  pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 },
});
