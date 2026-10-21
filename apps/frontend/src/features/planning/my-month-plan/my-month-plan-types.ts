import type { ReadSource } from '../../../shared/data/data-source';
import type { ShiftView } from '../../../shared/shift/shift-view';
import type { MonthKey } from '../../../shared/time/month';

export type DutyStatus = 'PLANNED' | 'CANCELLATION_REQUESTED';

/**
 * UI view model of one of the signed-in employee's planned duties (a planned
 * assignment, not attendance). NOT the API contract; a future source maps the
 * approved `/me/...` plan read model into this shape.
 */
export interface PlannedDuty {
  /** Display/list key only; not a server identifier. */
  reference: string;
  shift: ShiftView;
  projectName: string;
  status: DutyStatus;
}

export interface MyMonthPlan {
  duties: PlannedDuty[];
}

/** Resolves `null` when no published plan exists for the month. */
export type MyMonthPlanSource = ReadSource<MonthKey, MyMonthPlan | null>;
