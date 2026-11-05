import { ApiError } from '../../../shared/api/api-error';
import {
  isCivilDate,
  isNamedTimeZone,
  isUtcSecond,
} from '../../../shared/time/civil-time';
export function invalid(): never {
  throw new ApiError('invalid-response', 200, null, null);
}
export function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    invalid();
  return v as Record<string, unknown>;
}
export function uuid(v: unknown): string {
  if (
    typeof v !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  )
    invalid();
  return v;
}
function text(v: unknown): string {
  if (typeof v !== 'string') invalid();
  return v;
}
function millis(v: unknown): string {
  const s = text(v);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s).toISOString() !== s
  )
    invalid();
  return s;
}
export type Offer = {
  id: string;
  needId: string;
  employee: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string;
  };
  status: 'OPEN' | 'SELECTED' | 'NOT_SELECTED' | 'INVALIDATED' | 'WITHDRAWN';
  createdAt: string;
  decidedAt: string | null;
};
export type Need = {
  id: string;
  cancellationRequestId: string;
  duty: {
    id: string;
    dutyDate: string;
    shiftKind: 'DAY' | 'NIGHT';
    startsAt: string;
    endsAt: string;
  };
  status: 'OPEN' | 'OPEN_UNFILLED' | 'RESOLVED' | 'CLOSED';
  resolvedAt: string | null;
  openOfferCount: number;
  project: { id: string; name: string };
  timeZone: string;
};
export function parseOffer(
  value: unknown,
  owner?: string,
  needId?: string,
): Offer {
  const o = object(value, [
      'id',
      'needId',
      'employee',
      'status',
      'createdAt',
      'decidedAt',
    ]),
    e = object(o.employee, ['id', 'employeeCode', 'firstName', 'lastName']);
  const employee = {
      id: uuid(e.id),
      employeeCode: text(e.employeeCode),
      firstName: text(e.firstName),
      lastName: text(e.lastName),
    },
    status = text(o.status),
    createdAt = millis(o.createdAt),
    decidedAt = o.decidedAt === null ? null : millis(o.decidedAt);
  if (
    !['OPEN', 'SELECTED', 'NOT_SELECTED', 'INVALIDATED', 'WITHDRAWN'].includes(
      status,
    ) ||
    (status === 'OPEN') !== (decidedAt === null) ||
    (decidedAt !== null && decidedAt < createdAt) ||
    (owner && employee.id.toLowerCase() !== owner.toLowerCase()) ||
    (needId && uuid(o.needId).toLowerCase() !== needId.toLowerCase())
  )
    invalid();
  return {
    id: uuid(o.id),
    needId: uuid(o.needId),
    employee,
    status: status as Offer['status'],
    createdAt,
    decidedAt,
  };
}
export function parseOffers(v: unknown, owner?: string): Offer[] {
  if (!Array.isArray(v)) invalid();
  const seen = new Set<string>(),
    active = new Set<string>();
  let employee = owner;
  return v.map((raw) => {
    const o = parseOffer(raw, employee);
    employee ??= o.employee.id;
    const id = o.id.toLowerCase(),
      n = o.needId.toLowerCase();
    if (
      seen.has(id) ||
      (['OPEN', 'SELECTED'].includes(o.status) && active.has(n))
    )
      invalid();
    seen.add(id);
    if (['OPEN', 'SELECTED'].includes(o.status)) active.add(n);
    return o;
  });
}
export function parseNeed(v: unknown, expectedId?: string): Need {
  const n = object(v, [
      'id',
      'cancellationRequestId',
      'duty',
      'status',
      'resolvedAt',
      'openOfferCount',
      'project',
      'timeZone',
    ]),
    d = object(n.duty, ['id', 'dutyDate', 'shiftKind', 'startsAt', 'endsAt']),
    p = object(n.project, ['id', 'name']);
  const id = uuid(n.id),
    status = text(n.status),
    resolvedAt = n.resolvedAt === null ? null : millis(n.resolvedAt);
  if (
    (expectedId && id.toLowerCase() !== expectedId.toLowerCase()) ||
    !['OPEN', 'OPEN_UNFILLED', 'RESOLVED', 'CLOSED'].includes(status) ||
    (status === 'RESOLVED') !== (resolvedAt !== null) ||
    !Number.isSafeInteger(n.openOfferCount) ||
    Number(n.openOfferCount) < 0 ||
    !isNamedTimeZone(n.timeZone) ||
    !isCivilDate(d.dutyDate) ||
    !['DAY', 'NIGHT'].includes(text(d.shiftKind)) ||
    !isUtcSecond(d.startsAt) ||
    !isUtcSecond(d.endsAt) ||
    d.endsAt <= d.startsAt
  )
    invalid();
  return {
    id,
    cancellationRequestId: uuid(n.cancellationRequestId),
    duty: {
      id: uuid(d.id),
      dutyDate: d.dutyDate,
      shiftKind: d.shiftKind as 'DAY' | 'NIGHT',
      startsAt: d.startsAt,
      endsAt: d.endsAt,
    },
    status: status as Need['status'],
    resolvedAt,
    openOfferCount: Number(n.openOfferCount),
    project: { id: uuid(p.id), name: text(p.name) },
    timeZone: n.timeZone,
  };
}
export type NeedPage = {
  items: { need: Need; myOffer: Offer | null }[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
};
export function parseNeedPage(
  v: unknown,
  month: string,
  page: number,
  pageSize = 25,
  owner?: string,
): NeedPage {
  const r = object(v, ['items', 'pagination']),
    p = object(r.pagination, ['page', 'pageSize', 'totalItems', 'totalPages']);
  if (
    !Array.isArray(r.items) ||
    Object.values(p).some((n) => !Number.isSafeInteger(n) || Number(n) < 0) ||
    p.page !== page ||
    p.pageSize !== pageSize ||
    page < 1 ||
    pageSize < 1 ||
    pageSize > 100 ||
    p.totalPages !== Math.ceil(Number(p.totalItems) / pageSize)
  )
    invalid();
  const expected = Math.min(
    pageSize,
    Math.max(0, Number(p.totalItems) - (page - 1) * pageSize),
  );
  if (r.items.length !== expected) invalid();
  const seen = new Set<string>();
  let previous = '',
    employee = owner;
  const items = r.items.map((raw) => {
    const item = object(raw, ['need', 'myOffer']),
      need = parseNeed(item.need),
      order = `${need.duty.dutyDate}\0${need.id.toLowerCase()}`;
    if (
      need.status !== 'OPEN' ||
      need.duty.dutyDate.slice(0, 7) !== month.slice(0, 7) ||
      seen.has(need.id.toLowerCase()) ||
      order <= previous
    )
      invalid();
    previous = order;
    seen.add(need.id.toLowerCase());
    const myOffer =
      item.myOffer === null
        ? null
        : parseOffer(item.myOffer, employee, need.id);
    employee ??= myOffer?.employee.id;
    return { need, myOffer };
  });
  return {
    items,
    pagination: {
      page,
      pageSize,
      totalItems: Number(p.totalItems),
      totalPages: Number(p.totalPages),
    },
  };
}
export const offerLabels: Record<Offer['status'], string> = {
  OPEN: 'Offen',
  SELECTED: 'Ausgewählt',
  NOT_SELECTED: 'Nicht ausgewählt',
  INVALIDATED: 'Nicht mehr gültig',
  WITHDRAWN: 'Zurückgezogen',
};
/** Both endpoint dates and UTC offsets come from the saved duty zone. */
export function savedDutyTime(need: Need): string {
  const f = new Intl.DateTimeFormat('de-DE', {
    timeZone: need.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'longOffset',
  });
  return `${f.format(new Date(need.duty.startsAt))} – ${f.format(new Date(need.duty.endsAt))} (${need.timeZone})`;
}
