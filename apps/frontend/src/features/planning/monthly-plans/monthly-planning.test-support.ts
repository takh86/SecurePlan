/**
 * Test support for the planning screens (SP-11 PR-2, SP-12 A10): synthetic
 * example records and an in-memory company that answers the documented
 * endpoints and keeps state across reloads. Records, times and outcomes are
 * examples, not business rules; the duty interval below is a test
 * simplification, not the server's D6 resolver, and the edit-lease model only
 * follows ADR-0006 closely enough for screen tests (no real clock, no hashing).
 * Not part of the application bundle (only imported by tests).
 */
import { ApiError } from '../../../shared/api/api-error';
import { employee, httpError, type Handler, type RecordedRequest } from '../../employees/employees.test-support';
import type { Employee } from '../../employees/employee-types';
import type { ProjectAssignment } from '../../projects/project-assignments-api';
import type { Project } from '../../projects/project-types';
import { project, shiftVersion, type ShiftVersion } from '../../projects/projects.test-support';
import type { ShiftKind } from '../../projects/shift-configuration-api';
import type { Duty, DutyRole, MonthlyPlan } from './monthly-plan-types';

// Synthetic example identifiers.
export const HAFEN_ID = '7a2be0c4-1d3e-4f5a-8b6c-9d0e1f2a3b4c';
export const MESSE_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
export const NORD_ID = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';
export const PLAN_ID = '0b5f0c1e-2d3a-4b4c-8d5e-6f7a8b9c0d1e';

export const MIRA_ID = '6f1ad9a6-3a0c-4b7c-9c5e-0d4f2a1e8b11';
export const JONAS_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
export const LEA_ID = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
export const OSKAR_ID = '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a';
export const PAUL_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

export const hafen = project({ id: HAFEN_ID, name: 'Demo-Objekt Hafen' });
export const messe = project({ id: MESSE_ID, name: 'Demo-Objekt Messe', status: 'INACTIVE' });
export const nord = project({ id: NORD_ID, name: 'Demo-Objekt Nord' });

/** Synthetic example staff of one company. */
export const staff: Employee[] = [
  employee({ id: MIRA_ID, employeeCode: 'A-001', firstName: 'Mira', lastName: 'Beispiel', employmentStart: '2020-01-01' }),
  employee({ id: JONAS_ID, employeeCode: 'A-002', firstName: 'Jonas', lastName: 'Muster', employmentStart: '2020-01-01', shiftEligibility: 'DAY' }),
  employee({ id: LEA_ID, employeeCode: 'A-003', firstName: 'Lea', lastName: 'Probe', employmentStart: '2020-01-01', employmentEnd: '2026-12-15' }),
  employee({ id: OSKAR_ID, employeeCode: 'A-004', firstName: 'Oskar', lastName: 'Test', employmentStart: '2020-01-01', status: 'INACTIVE' }),
  // Not assigned to any project in the test months.
  employee({ id: PAUL_ID, employeeCode: 'A-005', firstName: 'Paul', lastName: 'Anders', employmentStart: '2020-01-01' }),
];

export function plan(overrides: Partial<MonthlyPlan> = {}): MonthlyPlan {
  return { id: PLAN_ID, projectId: HAFEN_ID, monthStart: '2026-12-01', status: 'UNPUBLISHED', publishedAt: null, ...overrides };
}

let assignmentSeq = 0;
/** Month assignments of `employeeIds` to `projectId` (synthetic). */
export function monthAssignments(projectId: string, monthStart: string, employeeIds: string[]): ProjectAssignment[] {
  return employeeIds.map((employeeId) => ({
    id: `00000000-0000-4000-9000-${String(++assignmentSeq).padStart(12, '0')}`,
    employeeId,
    projectId,
    monthStart,
    version: 1793260800000001 + assignmentSeq,
  }));
}

let dutySeq = 0;
function nextId(prefix: string): string {
  dutySeq += 1;
  return `${prefix}-0000-4000-8000-${String(dutySeq).padStart(12, '0')}`;
}

/** A stored duty (synthetic example); instants are given explicitly in UTC. */
export function duty(overrides: Partial<Duty> & Pick<Duty, 'dutyDate' | 'startsAt' | 'endsAt'>): Duty {
  return {
    id: nextId('d0000000'),
    shiftKind: 'DAY',
    version: 1,
    assignments: [],
    availabilityConflicts: [],
    ...overrides,
  };
}

export function member(employeeId: string, dutyRole: DutyRole = 'EMPLOYEE') {
  return { id: nextId('a0000000'), employeeId, dutyRole, source: 'NORMAL' as const };
}

/** Example shift times (not business rules): day 06:00-18:00, night 18:00-06:00. */
export const STANDARD_SHIFTS = (month: string, projectId = HAFEN_ID): ShiftVersion =>
  shiftVersion(month, [['DAY', '06:00', '18:00'], ['NIGHT', '18:00', '06:00']], projectId);

/** UTC instant of a local wall-clock time in `timeZone` (test helper; ignores DST gaps/folds). */
export function zonedInstant(date: string, time: string, timeZone = 'Europe/Berlin'): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (shown - guess)).toISOString().replace('.000Z', 'Z');
}

/** One duty's lease slot: held by this test session (`self`) or another admin (`other`). */
export type LeaseSlot = { token: string; holder: 'self' | 'other'; live: boolean };

type PlanningState = {
  projects: Project[];
  employees: Employee[];
  assignments: ProjectAssignment[];
  shiftVersions: ShiftVersion[];
  plans: MonthlyPlan[];
  duties: Record<string, Duty[]>;
  /** `employeeId|YYYY-MM-DD`: synthetic absence facts, only ever reported neutrally. */
  unavailable: Set<string>;
  /** Edit leases by duty id (ADR-0006 model). */
  leases: Record<string, LeaseSlot>;
};

let tokenSeq = 0;
/** A synthetic lease token in the canonical 43-character base64url shape. */
export function leaseToken(): string {
  tokenSeq += 1;
  return `lease${String(tokenSeq).padStart(6, '0')}`.padEnd(43, 'x');
}

/** Expiry `ttlMs` from now, rendered with microseconds as the server does. */
export function leaseExpiry(ttlMs = 120_000): string {
  return new Date(Date.now() + ttlMs).toISOString().replace('Z', '456Z');
}

function paged<T>(items: T[], params: URLSearchParams) {
  const pageSize = Number(params.get('pageSize') ?? 25);
  const page = Number(params.get('page') ?? 1);
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page, pageSize, totalItems: items.length, totalPages: Math.ceil(items.length / pageSize) },
  };
}

/**
 * In-memory company behind the documented endpoints (plans, duties, projects,
 * employees, month assignments, shift configuration). Planning outcomes follow
 * the API's codes and precedence closely enough for screen tests; `fail`
 * injects an error for one request.
 */
export function planningCompany(initial: Partial<PlanningState> = {}) {
  const state: PlanningState = {
    projects: initial.projects ?? [hafen, messe],
    employees: initial.employees ?? staff,
    assignments: initial.assignments ?? monthAssignments(HAFEN_ID, '2026-12-01', [MIRA_ID, JONAS_ID, LEA_ID, OSKAR_ID]),
    shiftVersions: initial.shiftVersions ?? [STANDARD_SHIFTS('2026-12-01')],
    plans: initial.plans ?? [],
    duties: initial.duties ?? {},
    unavailable: initial.unavailable ?? new Set(),
    leases: initial.leases ?? {},
  };
  let failNext: ((request: RecordedRequest) => unknown) | null = null;
  let loseNext: ((request: RecordedRequest) => boolean) | null = null;
  let planSeq = 0;
  /** SP-13 model of the idempotency records: key -> plan id of the completed publication. */
  const publishKeys = new Map<string, string>();
  const publishLog = { publications: 0, replays: 0 };

  const handler: Handler = (request) => {
    if (failNext) {
      const injected = failNext(request);
      if (injected !== undefined) {
        failNext = null;
        throw injected;
      }
    }
    if (loseNext?.(request)) {
      // The server processes (and commits) the request; its answer never arrives.
      loseNext = null;
      route(request);
      throw new ApiError('network', null, null, null);
    }
    return route(request);
  };

  function route(request: RecordedRequest): unknown {
    const [pathname, search = ''] = request.path.split('?');
    const params = new URLSearchParams(search);
    const planMatch = /^\/api\/v1\/monthly-plans\/([^/]+)$/.exec(pathname);
    const entriesMatch = /^\/api\/v1\/monthly-plans\/([^/]+)\/entries$/.exec(pathname);
    const entryMatch = /^\/api\/v1\/monthly-plans\/([^/]+)\/entries\/([^/]+)$/.exec(pathname);
    const leaseMatch = /^\/api\/v1\/monthly-plans\/([^/]+)\/entries\/([^/]+)\/edit-lease$/.exec(pathname);
    const publishMatch = /^\/api\/v1\/monthly-plans\/([^/]+)\/publish$/.exec(pathname);
    const projectMatch = /^\/api\/v1\/projects\/([^/]+)$/.exec(pathname);
    const shiftMatch = /^\/api\/v1\/projects\/([^/]+)\/shift-configuration$/.exec(pathname);

    if (pathname === '/api/v1/projects' && request.method === 'GET') return paged(state.projects, params);
    if (projectMatch && request.method === 'GET') {
      const found = state.projects.find((item) => item.id === decodeURIComponent(projectMatch[1]));
      if (!found) throw httpError(404, 'RESOURCE_NOT_FOUND');
      return found;
    }
    if (shiftMatch && request.method === 'GET') {
      const projectId = decodeURIComponent(shiftMatch[1]);
      const month = params.get('effectiveForMonth') ?? '';
      const effective = state.shiftVersions
        .filter((item) => item.projectId === projectId && item.month <= month)
        .sort((a, b) => b.month.localeCompare(a.month))[0];
      return effective
        ? { projectId, effectiveFromMonth: effective.month, shifts: effective.shifts }
        : { projectId, effectiveFromMonth: null, shifts: [] };
    }
    if (pathname === '/api/v1/employees' && request.method === 'GET') return paged(state.employees, params);
    if (pathname === '/api/v1/project-assignments' && request.method === 'GET') {
      return paged(state.assignments.filter((item) => item.monthStart === params.get('monthStart')), params);
    }

    if (pathname === '/api/v1/monthly-plans' && request.method === 'GET') {
      return paged(state.plans.filter((item) => item.monthStart === params.get('monthStart')), params);
    }
    if (pathname === '/api/v1/monthly-plans' && request.method === 'POST') {
      const body = request.body as { projectId: string; monthStart: string };
      const target = state.projects.find((item) => item.id === body.projectId);
      if (!target) throw httpError(404, 'RESOURCE_NOT_FOUND');
      if (target.status !== 'ACTIVE') throw httpError(409, 'PROJECT_INACTIVE');
      if (state.plans.some((item) => item.projectId === body.projectId && item.monthStart === body.monthStart)) {
        throw httpError(409, 'MONTHLY_PLAN_ALREADY_EXISTS');
      }
      planSeq += 1;
      const created: MonthlyPlan = {
        id: `e0000000-0000-4000-8000-${String(planSeq).padStart(12, '0')}`,
        projectId: body.projectId,
        monthStart: body.monthStart,
        status: 'UNPUBLISHED',
        publishedAt: null,
      };
      state.plans.push(created);
      return created;
    }
    if (planMatch && request.method === 'GET') {
      const found = state.plans.find((item) => item.id === decodeURIComponent(planMatch[1]));
      if (!found) throw httpError(404, 'RESOURCE_NOT_FOUND');
      return found;
    }
    if (publishMatch && request.method === 'POST') return publishPlan(decodeURIComponent(publishMatch[1]), request);
    if (entriesMatch) {
      const target = state.plans.find((item) => item.id === decodeURIComponent(entriesMatch[1]));
      if (!target) throw httpError(404, 'RESOURCE_NOT_FOUND');
      const duties = (state.duties[target.id] ??= []);
      if (request.method === 'GET') return { items: duties };
      if (request.method === 'POST') return createDuty(target, duties, request.body as CreateBody);
    }
    if (entryMatch || leaseMatch) {
      const [, planId, dutyId] = (leaseMatch ?? entryMatch)!;
      const target = state.plans.find((item) => item.id === decodeURIComponent(planId));
      const duties = target ? (state.duties[target.id] ??= []) : [];
      const found = duties.find((item) => item.id === decodeURIComponent(dutyId));
      if (!target || !found) throw httpError(404, 'RESOURCE_NOT_FOUND');
      if (leaseMatch) return leaseCommand(found, request);
      if (request.method === 'GET') return structuredClone(found);
      if (request.method === 'PATCH') return updateDuty(target, duties, found, request);
      if (request.method === 'DELETE') return removeDuty(duties, found, request);
    }
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  }

  /**
   * SP-13 model (precedence of the contract): key syntax and the bodyless rule
   * (400) -> visibility (404) -> completed replay of the same key -> key reused
   * for another plan -> lifecycle -> project ACTIVE -> configuration and staffing
   * of every live duty (UUID order). The plan object is replaced, never mutated,
   * so answers already handed out stay unchanged.
   */
  function publishPlan(planId: string, request: RecordedRequest): MonthlyPlan {
    const key = request.idempotencyKey;
    if (key === undefined) throw httpError(400, 'IDEMPOTENCY_KEY_REQUIRED');
    if (!/^[\x21-\x7e]{8,128}$/.test(key)) throw httpError(400, 'IDEMPOTENCY_KEY_INVALID');
    if (request.noBody !== true || request.body !== undefined) throw httpError(400, 'INVALID_REQUEST_BODY');
    const index = state.plans.findIndex((item) => item.id === planId);
    if (index < 0) throw httpError(404, 'RESOURCE_NOT_FOUND');
    const target = state.plans[index];
    const prior = publishKeys.get(key);
    if (prior !== undefined) {
      if (prior !== planId) throw httpError(409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
      publishLog.replays += 1;
      return structuredClone(target);
    }
    if (target.status === 'PUBLISHED') throw httpError(409, 'MONTHLY_PLAN_ALREADY_PUBLISHED');
    const owner = state.projects.find((item) => item.id === target.projectId)!;
    if (owner.status !== 'ACTIVE') throw httpError(409, 'PROJECT_INACTIVE');
    for (const item of [...(state.duties[planId] ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
      shiftRule(target, item.shiftKind);
      const members = item.assignments.map((assignment) => {
        const person = state.employees.find((candidate) => candidate.id === assignment.employeeId);
        if (!person) throw httpError(404, 'RESOURCE_NOT_FOUND');
        return { person };
      });
      assertStaffing(target, item.dutyDate, item.shiftKind, members);
    }
    const published: MonthlyPlan = { ...target, status: 'PUBLISHED', publishedAt: PUBLISHED_AT };
    state.plans[index] = published;
    publishKeys.set(key, planId);
    publishLog.publications += 1;
    return structuredClone(published);
  }

  function leaseCommand(target: Duty, request: RecordedRequest) {
    const slot = state.leases[target.id];
    if (request.method === 'POST') {
      if (slot && slot.live && slot.holder === 'other') throw httpError(409, 'RESOURCE_EDIT_LOCKED');
      const token = leaseToken();
      state.leases[target.id] = { token, holder: 'self', live: true };
      return { leaseToken: token, expiresAt: leaseExpiry() };
    }
    if (request.editLeaseToken === undefined) throw httpError(400, null);
    const owns = slot !== undefined && slot.holder === 'self' && slot.token === request.editLeaseToken;
    if (request.method === 'PUT') {
      if (!owns || !slot.live) throw httpError(409, 'EDIT_LEASE_NOT_HELD');
      return { leaseToken: slot.token, expiresAt: leaseExpiry() };
    }
    if (request.method === 'DELETE') {
      // The retained owner and token authenticate a release even after expiry.
      if (!owns) throw httpError(409, 'EDIT_LEASE_NOT_HELD');
      slot.live = false;
      return undefined;
    }
    throw new Error(`Unexpected lease request ${request.method}`);
  }

  /** ADR-0006 precedence: headers (400) -> lease (409) -> version/drift (409) -> no-op -> business rules. */
  function assertMutation(target: Duty, request: RecordedRequest) {
    if (request.expectedVersion === undefined || request.editLeaseToken === undefined) throw httpError(400, null);
    const slot = state.leases[target.id];
    if (!slot || slot.holder !== 'self' || !slot.live || slot.token !== request.editLeaseToken) {
      throw httpError(409, 'EDIT_LEASE_NOT_HELD');
    }
    if (target.version !== request.expectedVersion) throw httpError(409, 'PLAN_CONCURRENT_MODIFICATION');
  }

  type PatchBody = { dutyDate?: string; shiftKind?: ShiftKind; assignments?: { employeeId: string; dutyRole: DutyRole }[] };

  function updateDuty(plan: MonthlyPlan, duties: Duty[], target: Duty, request: RecordedRequest): Duty {
    const body = request.body as PatchBody;
    if (body.dutyDate === undefined && body.shiftKind === undefined && body.assignments === undefined) {
      throw httpError(400, 'EMPTY_PATCH');
    }
    if (body.dutyDate !== undefined && body.dutyDate.slice(0, 8) !== plan.monthStart.slice(0, 8)) {
      throw httpError(400, 'DUTY_DATE_OUTSIDE_PLAN_MONTH');
    }
    const roster = body.assignments ?? target.assignments.map(({ employeeId, dutyRole }) => ({ employeeId, dutyRole }));
    const members = roster.map((item) => {
      const person = state.employees.find((candidate) => candidate.id === item.employeeId);
      if (!person) throw httpError(404, 'RESOURCE_NOT_FOUND');
      return { person, role: item.dutyRole };
    });
    assertMutation(target, request);
    const day = body.dutyDate ?? target.dutyDate;
    const kind = body.shiftKind ?? target.shiftKind;
    const timeChanged = day !== target.dutyDate || kind !== target.shiftKind;
    const rosterChanged = roster.length !== target.assignments.length
      || roster.some((item) => target.assignments.find((old) => old.employeeId === item.employeeId)?.dutyRole !== item.dutyRole);
    if (!timeChanged && !rosterChanged) return structuredClone(target);
    const owner = state.projects.find((item) => item.id === plan.projectId)!;
    if (owner.status !== 'ACTIVE') throw httpError(409, 'PROJECT_INACTIVE');
    if (duties.some((item) => item.id !== target.id && item.dutyDate === day && item.shiftKind === kind)) {
      throw httpError(409, 'DUTY_ALREADY_EXISTS');
    }
    const rule = shiftRule(plan, kind);
    assertStaffing(plan, day, kind, members);
    if (timeChanged) {
      const endDate = rule.endLocal < rule.startLocal
        ? new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
        : day;
      target.startsAt = zonedInstant(day, rule.startLocal);
      target.endsAt = zonedInstant(endDate, rule.endLocal);
    }
    target.dutyDate = day;
    target.shiftKind = kind;
    target.assignments = members.map(({ person, role }) => {
      const kept = target.assignments.find((old) => old.employeeId === person.id);
      return kept ? { ...kept, dutyRole: role } : member(person.id, role);
    });
    target.availabilityConflicts = [];
    target.version += 1;
    return structuredClone(target);
  }

  function removeDuty(duties: Duty[], target: Duty, request: RecordedRequest) {
    assertMutation(target, request);
    duties.splice(duties.indexOf(target), 1);
    state.leases[target.id].live = false;
    return undefined;
  }

  function shiftRule(target: MonthlyPlan, kind: ShiftKind) {
    const version = state.shiftVersions
      .filter((item) => item.projectId === target.projectId && item.month <= target.monthStart)
      .sort((a, b) => b.month.localeCompare(a.month))[0];
    const rule = version?.shifts.find((item) => item.shiftKind === kind);
    if (!rule) throw httpError(409, 'SHIFT_CONFIGURATION_MISSING');
    return rule;
  }

  function assertStaffing(target: MonthlyPlan, dutyDate: string, kind: ShiftKind, members: { person: Employee }[]) {
    for (const { person } of [...members].sort((a, b) => a.person.id.localeCompare(b.person.id))) {
      if (person.status !== 'ACTIVE') throw httpError(409, 'EMPLOYEE_INACTIVE');
      const employed = person.employmentStart !== null && person.employmentStart <= dutyDate
        && (person.employmentEnd === null || person.employmentEnd >= dutyDate);
      if (!employed) throw httpError(409, 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY');
      const assigned = state.assignments.some((item) =>
        item.employeeId === person.id && item.projectId === target.projectId && item.monthStart === target.monthStart);
      if (!assigned) throw httpError(409, 'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH');
      if (person.shiftEligibility !== 'BOTH' && person.shiftEligibility !== kind) {
        throw httpError(409, 'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT');
      }
      if (state.unavailable.has(`${person.id}|${dutyDate}`)) throw httpError(409, 'EMPLOYEE_UNAVAILABLE');
    }
  }

  type CreateBody = { dutyDate: string; shiftKind: ShiftKind; assignments: { employeeId: string; dutyRole: DutyRole }[] };

  function createDuty(target: MonthlyPlan, duties: Duty[], body: CreateBody): Duty {
    if (body.dutyDate.slice(0, 8) !== target.monthStart.slice(0, 8)) throw httpError(400, 'DUTY_DATE_OUTSIDE_PLAN_MONTH');
    const members = body.assignments.map((item) => {
      const person = state.employees.find((candidate) => candidate.id === item.employeeId);
      if (!person) throw httpError(404, 'RESOURCE_NOT_FOUND');
      return { person, role: item.dutyRole };
    });
    const owner = state.projects.find((item) => item.id === target.projectId)!;
    if (owner.status !== 'ACTIVE') throw httpError(409, 'PROJECT_INACTIVE');
    if (duties.some((item) => item.dutyDate === body.dutyDate && item.shiftKind === body.shiftKind)) {
      throw httpError(409, 'DUTY_ALREADY_EXISTS');
    }
    const rule = shiftRule(target, body.shiftKind);
    assertStaffing(target, body.dutyDate, body.shiftKind, members);
    const endDate = rule.endLocal < rule.startLocal
      ? new Date(Date.parse(`${body.dutyDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
      : body.dutyDate;
    const created: Duty = {
      id: nextId('c0000000'),
      dutyDate: body.dutyDate,
      shiftKind: body.shiftKind,
      startsAt: zonedInstant(body.dutyDate, rule.startLocal),
      endsAt: zonedInstant(endDate, rule.endLocal),
      version: 1,
      assignments: members.map(({ person, role }) => member(person.id, role)),
      availabilityConflicts: [],
    };
    duties.push(created);
    return created;
  }

  return {
    state,
    handler,
    /** SP-13: completed publications and replays of a completed key. */
    publishLog,
    /** The next request for which `match` returns an error fails with it. */
    fail(match: (request: RecordedRequest) => unknown) {
      failNext = match;
    },
    /** The next request for which `match` is true is processed, but its answer is lost (network error). */
    loseResponse(match: (request: RecordedRequest) => boolean) {
      loseNext = match;
    },
  };
}

/** SP-13 synthetic publication instant of the in-memory company (an example, not a rule). */
export const PUBLISHED_AT = '2026-12-01T08:00:00Z';

/** True for the SP-13 publish command of any plan. */
export function isPublish(request: RecordedRequest): boolean {
  return request.method === 'POST' && /^\/api\/v1\/monthly-plans\/[^/]+\/publish$/.test(request.path);
}
