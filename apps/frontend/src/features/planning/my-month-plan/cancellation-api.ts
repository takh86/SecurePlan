import { ApiError } from '../../../shared/api/api-error';
import { isCivilDate, isUtcSecond } from '../../../shared/time/civil-time';
export type CancellationResponse = {
  id: string;
  assignmentId: string;
  employee: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string;
  };
  duty: {
    id: string;
    dutyDate: string;
    shiftKind: 'DAY' | 'NIGHT';
    startsAt: string;
    endsAt: string;
  };
  status: 'OPEN' | 'WITHDRAWN' | 'REJECTED' | 'APPROVED' | 'OBSOLETE';
  createdAt: string;
  decidedAt: string | null;
  replacementNeed: {
    id: string;
    status: 'OPEN' | 'OPEN_UNFILLED' | 'RESOLVED' | 'CLOSED';
    resolvedAt: string | null;
  };
};
function invalid(): never {
  throw new ApiError('invalid-response', 201, null, null);
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') invalid();
  return value;
}
function instant(value: unknown): string {
  const s = text(value);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    !isUtcSecond(s.replace(/\.\d{3}Z$/, 'Z'))
  )
    invalid();
  return s;
}
/** Full exact DTO validation before any returned resource enters private UI state. */
export function parseCancellation(
  value: unknown,
  assignmentId: string,
  dutyId: string,
): CancellationResponse {
  const r = record(value, [
    'id',
    'assignmentId',
    'employee',
    'duty',
    'status',
    'createdAt',
    'decidedAt',
    'replacementNeed',
  ]);
  const e = record(r.employee, ['id', 'employeeCode', 'firstName', 'lastName']);
  const d = record(r.duty, [
    'id',
    'dutyDate',
    'shiftKind',
    'startsAt',
    'endsAt',
  ]);
  const n = record(r.replacementNeed, ['id', 'status', 'resolvedAt']);
  if (
    id(r.assignmentId).toLowerCase() !== assignmentId.toLowerCase() ||
    id(d.id).toLowerCase() !== dutyId.toLowerCase() ||
    !isCivilDate(d.dutyDate) ||
    (d.shiftKind !== 'DAY' && d.shiftKind !== 'NIGHT') ||
    !isUtcSecond(d.startsAt) ||
    !isUtcSecond(d.endsAt) ||
    d.endsAt <= d.startsAt
  )
    invalid();
  const status = text(r.status),
    needStatus = text(n.status);
  if (
    !['OPEN', 'WITHDRAWN', 'REJECTED', 'APPROVED', 'OBSOLETE'].includes(
      status,
    ) ||
    !['OPEN', 'OPEN_UNFILLED', 'RESOLVED', 'CLOSED'].includes(needStatus)
  )
    invalid();
  if (
    status === 'OPEN'
      ? needStatus !== 'OPEN'
      : status === 'APPROVED'
        ? !['RESOLVED', 'OPEN_UNFILLED'].includes(needStatus)
        : needStatus !== 'CLOSED'
  )
    invalid();
  if (
    ['APPROVED', 'REJECTED'].includes(status)
      ? r.decidedAt === null
      : r.decidedAt !== null
  )
    invalid();
  if ((needStatus === 'RESOLVED') !== (n.resolvedAt !== null)) invalid();
  const createdAt = instant(r.createdAt),
    decidedAt = r.decidedAt === null ? null : instant(r.decidedAt);
  if (decidedAt && Date.parse(decidedAt) < Date.parse(createdAt)) invalid();
  return {
    id: id(r.id),
    assignmentId: id(r.assignmentId),
    employee: {
      id: id(e.id),
      employeeCode: text(e.employeeCode),
      firstName: text(e.firstName),
      lastName: text(e.lastName),
    },
    duty: {
      id: id(d.id),
      dutyDate: d.dutyDate,
      shiftKind: d.shiftKind,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
    },
    status: status as CancellationResponse['status'],
    createdAt,
    decidedAt,
    replacementNeed: {
      id: id(n.id),
      status: needStatus as CancellationResponse['replacementNeed']['status'],
      resolvedAt: n.resolvedAt === null ? null : instant(n.resolvedAt),
    },
  };
}
