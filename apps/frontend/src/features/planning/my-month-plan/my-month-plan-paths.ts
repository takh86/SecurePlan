import type { MonthKey } from '../../../shared/time/month';

export const MY_MONTH_PLAN_PATH = '/mein-monatsplan';

export function myMonthPlanPath(month: MonthKey): string {
  return `${MY_MONTH_PLAN_PATH}/${month}`;
}
