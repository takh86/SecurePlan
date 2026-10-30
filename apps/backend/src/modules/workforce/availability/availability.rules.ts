import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AvailabilityOperation, AvailabilityStatus, ConflictPolicy, type Selection, type PreviewDay } from './availability.types.js';

export function validCivilDate(value: string): boolean {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}
export function selectedDays(input: Selection): string[] {
  if (!validCivilDate(input.fromDate) || !validCivilDate(input.toDate)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }
  const first = Date.parse(`${input.fromDate}T00:00:00Z`);
  const count = (Date.parse(`${input.toDate}T00:00:00Z`) - first) / 86_400_000 + 1;
  if (count < 1 || count > 93) throw new BadRequestException({ code: 'AVAILABILITY_RANGE_INVALID' });
  return Array.from({ length: count }, (_, i) => new Date(first + i * 86_400_000).toISOString().slice(0, 10));
}
export function normalizeSelection(input: Selection): Selection {
  if (input.operation === AvailabilityOperation.CLEAR) {
    if (input.status !== undefined || input.conflictPolicy !== undefined) combination();
    return { operation: input.operation, fromDate: input.fromDate, toDate: input.toDate };
  }
  if (input.operation !== AvailabilityOperation.SET || !Object.values(AvailabilityStatus).includes(input.status!)) combination();
  return { operation: input.operation, fromDate: input.fromDate, toDate: input.toDate,
    status: input.status, conflictPolicy: input.conflictPolicy ?? ConflictPolicy.REJECT };
}
export function combination(): never { throw new BadRequestException({ code: 'INVALID_FIELD_COMBINATION' }); }
export function assertConfirmation(input: Selection, confirmation: string | undefined): void {
  const required = input.operation === AvailabilityOperation.CLEAR ? 'CLEAR' :
    input.conflictPolicy === ConflictPolicy.REPLACE ? 'REPLACE' : undefined;
  if (confirmation !== required) combination();
}
export function assertEmployment(input: Selection, employee: {
  status: string; employment_start: string | null; employment_end: string | null;
}, today: string): void {
  if (input.operation === AvailabilityOperation.CLEAR) return;
  if (employee.status !== 'ACTIVE' && input.toDate >= today) throw new ConflictException({ code: 'EMPLOYEE_INACTIVE' });
  if (employee.employment_start === null || input.fromDate < employee.employment_start ||
      (employee.employment_end !== null && input.toDate > employee.employment_end)) {
    throw new ConflictException({ code: 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY' });
  }
}
export function previewDays(input: Selection, days: readonly string[], current: ReadonlyMap<string, AvailabilityStatus>): PreviewDay[] {
  return days.map((day) => {
    const currentStatus = current.get(day) ?? null;
    const effect = input.operation === AvailabilityOperation.CLEAR ? (currentStatus === null ? 'UNCHANGED' : 'CLEAR') :
      currentStatus === null ? 'CREATE' : currentStatus === input.status ? 'UNCHANGED' :
        input.conflictPolicy === ConflictPolicy.REPLACE ? 'REPLACE' : 'CONFLICT';
    return { day, currentStatus, effect };
  });
}
export function digest(value: string): Buffer { return createHash('sha256').update(value, 'utf8').digest(); }
export function selectionDigest(employeeId: string, input: Selection): Buffer {
  return digest(JSON.stringify(['SP10-v1', employeeId.toLowerCase(), input.operation, input.fromDate,
    input.toDate, input.status ?? null, input.conflictPolicy ?? null]));
}
