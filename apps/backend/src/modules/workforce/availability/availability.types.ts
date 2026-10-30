export enum AvailabilityStatus { SICK = 'SICK', LEAVE = 'LEAVE' }
export enum AvailabilityOperation { SET = 'SET', CLEAR = 'CLEAR' }
export enum ConflictPolicy { REJECT = 'REJECT', REPLACE = 'REPLACE' }
export type Selection = {
  operation: AvailabilityOperation; fromDate: string; toDate: string;
  status?: AvailabilityStatus; conflictPolicy?: ConflictPolicy;
};
export type DayEffect = 'CREATE' | 'UNCHANGED' | 'CONFLICT' | 'REPLACE' | 'CLEAR';
export type PreviewDay = { day: string; currentStatus: AvailabilityStatus | null; effect: DayEffect };
export type AvailabilityPreview = Selection & {
  employeeId: string; previewToken: string; expiresAt: string; canCommit: boolean; days: PreviewDay[];
};
export type AvailabilityResult = { employeeId: string; changedDayCount: number; unchangedDayCount: number };
