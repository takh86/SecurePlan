export type MyDuty = {
  dutyId: string;
  assignmentId: string;
  version: number;
  dutyDate: string;
  shiftKind: 'DAY' | 'NIGHT';
  startsAt: string;
  endsAt: string;
  dutyRole: 'EMPLOYEE' | 'SHIFT_LEAD';
  timeZone: string;
};
export type MyMonthlyPlan = {
  planId: string;
  project: { id: string; name: string };
  monthStart: string;
  duties: MyDuty[];
};
export type MyMonthlyPlansResponse = { items: MyMonthlyPlan[] };
