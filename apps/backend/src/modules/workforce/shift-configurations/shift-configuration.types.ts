/** API vocabulary of the project shift configuration (v1). The database stores TAG/NACHT; see shift-configuration.mapper.ts. */
export const ShiftKind = { DAY: 'DAY', NIGHT: 'NIGHT' } as const;
export type ShiftKind = (typeof ShiftKind)[keyof typeof ShiftKind];

/** One persisted shift rule. Times are local wall-clock times, HH:mm. */
export type ShiftRuleResponse = {
  /** Identifies (project, effective month, shift kind); a new month version has new ids. */
  id: string;
  shiftKind: ShiftKind;
  startLocal: string;
  endLocal: string;
};

/**
 * Response DTO for GET and PATCH. Deliberately excludes companyId and internal
 * timestamps. Amendment A-SP08b-01 (ADR-0003): without any version up to the
 * requested month, effectiveFromMonth is null and shifts is empty.
 */
export type ProjectShiftConfigurationResponse = {
  projectId: string;
  /** First day of the effective month, YYYY-MM-01, or null when nothing is configured. */
  effectiveFromMonth: string | null;
  shifts: ShiftRuleResponse[];
};
