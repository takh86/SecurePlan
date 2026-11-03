/**
 * Test support for SP-08/SP-09 project screens: synthetic example records and
 * an in-memory company that answers the documented endpoints and keeps state
 * across reloads. Records are examples, not business rules.
 * Not part of the application bundle (only imported by *.test.tsx files).
 */
import type { Clock } from '../../shared/time/clock';
import { employee, httpError, type Handler, type RecordedRequest } from '../employees/employees.test-support';
import type { Employee } from '../employees/employee-types';
import type { ProjectAssignment } from './project-assignments-api';
import type { Project, ProjectPage } from './project-types';
import type { ShiftKind, ShiftRule } from './shift-configuration-api';

/** Fixed "today" for deterministic month defaults: 15.12.2026, local midday. */
export const DECEMBER_2026: Clock = () => new Date(2026, 11, 15, 12, 0, 0);

export const PROJECT_ID = '7a2be0c4-1d3e-4f5a-8b6c-9d0e1f2a3b4c';

/** Synthetic example project. */
export function project(overrides: Partial<Project> = {}): Project {
  return { id: PROJECT_ID, name: 'Demo-Objekt Hafen', status: 'ACTIVE', ...overrides };
}

export function projectPage(items: Project[], overrides: Partial<ProjectPage['pagination']> = {}): ProjectPage {
  const totalItems = overrides.totalItems ?? items.length;
  const pageSize = overrides.pageSize ?? 25;
  return {
    items,
    pagination: { page: 1, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize), ...overrides },
  };
}

function paged<T>(items: T[], params: URLSearchParams) {
  const pageSize = Number(params.get('pageSize') ?? 25);
  const page = Number(params.get('page') ?? 1);
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page, pageSize, totalItems: items.length, totalPages: Math.ceil(items.length / pageSize) },
  };
}

/** One stored shift-configuration version (SP-08b): `month` is `YYYY-MM-01`. */
export type ShiftVersion = { projectId: string; month: string; shifts: ShiftRule[] };

/** Synthetic example version; the times are examples, not business rules. */
export function shiftVersion(month: string, shifts: [ShiftKind, string, string][], projectId = PROJECT_ID): ShiftVersion {
  return {
    projectId,
    month,
    shifts: shifts.map(([shiftKind, startLocal, endLocal]) => ({
      id: `s-${projectId.slice(0, 4)}-${month}-${shiftKind}`,
      shiftKind,
      startLocal,
      endLocal,
    })),
  };
}

/** One stored operating-calendar version (A1): `month` is `YYYY-MM-01`, weekdays ISO 1-7. */
export type CalendarVersion = { projectId: string; month: string; id: string; version: number; weekdays: number[] };

/** Synthetic example version; the weekday set is an explicit example, never a default. */
export function calendarVersion(month: string, weekdays: number[], version = 1, projectId = PROJECT_ID): CalendarVersion {
  const suffix = `${month.slice(0, 4)}${month.slice(5, 7)}`;
  return { projectId, month, id: `9a000000-0000-4000-8000-${suffix}${String(version).padStart(6, '0')}`, version, weekdays };
}

/** A live saved duty start date of a project (dependency and bootstrap rules only). */
export type DutyDate = { projectId: string; date: string };

type CompanyState = {
  projects: Project[];
  employees: Employee[];
  assignments: ProjectAssignment[];
  shiftVersions: ShiftVersion[];
  calendarVersions: CalendarVersion[];
  dutyDates: DutyDate[];
};

const KIND_ORDER: ShiftKind[] = ['DAY', 'NIGHT'];

function versionResponse(projectId: string, version: ShiftVersion | undefined) {
  if (!version) return { projectId, effectiveFromMonth: null, shifts: [] };
  return {
    projectId,
    effectiveFromMonth: version.month,
    shifts: [...version.shifts].sort((a, b) => KIND_ORDER.indexOf(a.shiftKind) - KIND_ORDER.indexOf(b.shiftKind)),
  };
}

/**
 * In-memory company behind the documented endpoints. Business outcomes of
 * POST/PATCH/DELETE /project-assignments (with versions, #73) and the SP-08b shift configuration follow the API
 * contract (codes, versions, full replacement, no-op) so screens can be tested
 * end to end; `fail` lets a test inject an error for one request.
 * `currentMonthStart` is the company's current month for the past-month rule.
 */
export function fakeCompany(initial: Partial<CompanyState> & { currentMonthStart?: string } = {}) {
  const state: CompanyState = {
    projects: initial.projects ?? [project()],
    employees: initial.employees ?? [employee()],
    assignments: initial.assignments ?? [],
    shiftVersions: initial.shiftVersions ?? [],
    calendarVersions: initial.calendarVersions ?? [],
    dutyDates: initial.dutyDates ?? [],
  };
  const currentMonthStart = initial.currentMonthStart ?? '2026-12-01';
  let failNext: ((request: RecordedRequest) => unknown) | null = null;
  let nextId = 1;
  // Synthetic example versions (#73): opaque, strictly increasing per write.
  let nextVersion = 1793260800000001;

  /** A1 calendar contract (docs/api/project-operating-calendar.md), same precedence as the service. */
  function calendarRead(projectId: string, target: string) {
    const versions = state.calendarVersions.filter((item) => item.projectId === projectId).sort((a, b) => a.month.localeCompare(b.month));
    const effective = versions.filter((item) => item.month <= target).at(-1);
    const exact = effective?.month === target ? effective : undefined;
    const next = versions.find((item) => item.month > target)?.month ?? null;
    return {
      effective, exact, next,
      response: {
        projectId, effectiveForMonth: target, state: effective ? 'CONFIGURED' : 'MISSING',
        effective: effective
          ? { id: effective.id, effectiveFromMonth: effective.month, operatingWeekdays: [...effective.weekdays].sort(), version: effective.version }
          : null,
        exactVersion: exact ? { id: exact.id, version: exact.version } : null,
        nextEffectiveFromMonth: next,
      },
    };
  }

  function calendarAnswer(projectId: string, request: RecordedRequest, params: URLSearchParams) {
    const invalidMonth = (field: string) => httpError(400, 'PROJECT_CALENDAR_INVALID', [{ pointer: `#/${field}`, code: 'INVALID_FORMAT' }]);
    const target = state.projects.find((item) => item.id === projectId);
    if (request.method === 'GET') {
      const month = params.get('effectiveForMonth') ?? '';
      if (!/^\d{4}-\d{2}-01$/.test(month)) throw invalidMonth('effectiveForMonth');
      if (!target) throw httpError(404, 'RESOURCE_NOT_FOUND');
      return calendarRead(projectId, month).response;
    }
    if (request.method !== 'PATCH') throw new Error(`Unexpected request ${request.method} ${request.path}`);
    type Ref = { id: string; version: number } | null;
    const body = request.body as {
      effectiveFromMonth: string; expectedExactVersion: Ref; expectedEffective: Ref;
      expectedNextEffectiveFromMonth: string | null; operatingWeekdays: number[]; bootstrap: boolean;
    };
    if (!/^\d{4}-\d{2}-01$/.test(body.effectiveFromMonth)) throw invalidMonth('effectiveFromMonth');
    if (!target) throw httpError(404, 'RESOURCE_NOT_FOUND');
    const current = calendarRead(projectId, body.effectiveFromMonth);
    const matches = (actual: CalendarVersion | undefined, expected: Ref) =>
      actual === undefined ? expected === null : expected !== null && expected.id === actual.id && expected.version === actual.version;
    if (!matches(current.exact, body.expectedExactVersion) || !matches(current.effective, body.expectedEffective)
      || current.next !== body.expectedNextEffectiveFromMonth) throw httpError(409, 'PROJECT_CALENDAR_CONCURRENT_MODIFICATION');
    const duties = state.dutyDates.filter((item) => item.projectId === projectId);
    const first = duties.map((item) => `${item.date.slice(0, 7)}-01`).sort()[0];
    const configured = state.calendarVersions.some((item) => item.projectId === projectId);
    if (body.bootstrap ? configured || body.effectiveFromMonth !== (first ?? currentMonthStart) : body.effectiveFromMonth < currentMonthStart) {
      throw invalidMonth('effectiveFromMonth');
    }
    const weekdays = [...body.operatingWeekdays].sort();
    if (current.exact && [...current.exact.weekdays].sort().join() === weekdays.join()) return { ...current.response, outcome: 'NO_OP' };
    if (target.status !== 'ACTIVE') throw httpError(409, 'PROJECT_INACTIVE');
    const isoDay = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const closes = duties.some((item) => item.date >= body.effectiveFromMonth && (current.next === null || item.date < current.next)
      && !weekdays.includes(isoDay(item.date)) && (!current.effective || current.effective.weekdays.includes(isoDay(item.date))));
    if (closes) throw httpError(409, 'PROJECT_CALENDAR_DEPENDENCY_CONFLICT');
    const written = current.exact
      ? { ...current.exact, weekdays, version: current.exact.version + 1 }
      : calendarVersion(body.effectiveFromMonth, weekdays, 1, projectId);
    state.calendarVersions = [...state.calendarVersions.filter((item) => item !== current.exact), written];
    return { ...calendarRead(projectId, body.effectiveFromMonth).response, outcome: 'APPLIED' };
  }

  const handler: Handler = (request) => {
    if (failNext) {
      const injected = failNext(request);
      if (injected !== undefined) {
        failNext = null;
        throw injected;
      }
    }
    const [pathname, search = ''] = request.path.split('?');
    const params = new URLSearchParams(search);
    const projectMatch = /^\/api\/v1\/projects\/([^/]+)$/.exec(pathname);
    const shiftMatch = /^\/api\/v1\/projects\/([^/]+)\/shift-configuration$/.exec(pathname);
    const calendarMatch = /^\/api\/v1\/projects\/([^/]+)\/operating-calendar$/.exec(pathname);

    if (calendarMatch) return calendarAnswer(decodeURIComponent(calendarMatch[1]), request, params);

    if (shiftMatch) {
      const projectId = decodeURIComponent(shiftMatch[1]);
      const target = state.projects.find((item) => item.id === projectId);
      const versions = state.shiftVersions.filter((item) => item.projectId === projectId);
      if (request.method === 'GET') {
        const month = params.get('effectiveForMonth') ?? '';
        if (!/^\d{4}-\d{2}-01$/.test(month)) throw httpError(400, 'INVALID_MONTH_START');
        if (!target) throw httpError(404, 'RESOURCE_NOT_FOUND');
        const effective = versions.filter((item) => item.month <= month).sort((a, b) => b.month.localeCompare(a.month))[0];
        return versionResponse(projectId, effective);
      }
      if (request.method === 'PATCH') {
        const body = request.body as { effectiveFromMonth: string; shifts: Omit<ShiftRule, 'id'>[] };
        if (!/^\d{4}-\d{2}-01$/.test(body.effectiveFromMonth)) throw httpError(400, 'INVALID_MONTH_START');
        const invalidTimes = body.shifts.some((rule) =>
          rule.startLocal === rule.endLocal || (rule.shiftKind === 'DAY' && rule.endLocal < rule.startLocal));
        if (invalidTimes) throw httpError(400, 'SHIFT_CONFIGURATION_INVALID');
        if (!target) throw httpError(404, 'RESOURCE_NOT_FOUND');
        if (target.status !== 'ACTIVE') throw httpError(409, 'PROJECT_INACTIVE');
        if (body.effectiveFromMonth < currentMonthStart) throw httpError(400, 'SHIFT_CONFIGURATION_INVALID');
        const existing = versions.find((item) => item.month === body.effectiveFromMonth);
        const same = existing !== undefined && existing.shifts.length === body.shifts.length && body.shifts.every((rule) =>
          existing.shifts.some((stored) =>
            stored.shiftKind === rule.shiftKind && stored.startLocal === rule.startLocal && stored.endLocal === rule.endLocal));
        if (same) return versionResponse(projectId, existing);
        // Full replacement of exactly this month; a retimed kind keeps its id.
        const shifts = body.shifts.map((rule) => ({
          id: existing?.shifts.find((stored) => stored.shiftKind === rule.shiftKind)?.id ?? `s-new-${nextId++}`,
          shiftKind: rule.shiftKind,
          startLocal: rule.startLocal,
          endLocal: rule.endLocal,
        }));
        const written: ShiftVersion = { projectId, month: body.effectiveFromMonth, shifts };
        state.shiftVersions = [...state.shiftVersions.filter((item) => item !== existing), written];
        return versionResponse(projectId, written);
      }
    }

    if (pathname === '/api/v1/projects' && request.method === 'GET') {
      const status = params.get('status');
      return paged(state.projects.filter((item) => !status || item.status === status), params);
    }
    if (pathname === '/api/v1/projects' && request.method === 'POST') {
      const created: Project = {
        id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
        name: (request.body as { name: string }).name,
        status: 'ACTIVE',
      };
      state.projects.push(created);
      return created;
    }
    if (projectMatch && request.method === 'GET') {
      const found = state.projects.find((item) => item.id === decodeURIComponent(projectMatch[1]));
      if (!found) throw httpError(404, 'RESOURCE_NOT_FOUND');
      return found;
    }
    if (projectMatch && request.method === 'PATCH') {
      const index = state.projects.findIndex((item) => item.id === decodeURIComponent(projectMatch[1]));
      if (index < 0) throw httpError(404, 'RESOURCE_NOT_FOUND');
      state.projects[index] = { ...state.projects[index], ...(request.body as Partial<Project>) };
      return state.projects[index];
    }
    if (pathname === '/api/v1/employees' && request.method === 'GET') return paged(state.employees, params);
    if (pathname === '/api/v1/project-assignments' && request.method === 'GET') {
      const monthStart = params.get('monthStart');
      return paged(state.assignments.filter((item) => item.monthStart === monthStart), params);
    }
    if (pathname === '/api/v1/project-assignments' && request.method === 'POST') {
      const body = request.body as Omit<ProjectAssignment, 'id' | 'version'>;
      const person = state.employees.find((item) => item.id === body.employeeId);
      const target = state.projects.find((item) => item.id === body.projectId);
      if (!person || !target) throw httpError(404, 'RESOURCE_NOT_FOUND');
      if (person.status !== 'ACTIVE') throw httpError(409, 'EMPLOYEE_INACTIVE');
      if (target.status !== 'ACTIVE') throw httpError(409, 'PROJECT_INACTIVE');
      const existing = state.assignments.find(
        (item) => item.employeeId === body.employeeId && item.monthStart === body.monthStart,
      );
      if (existing) {
        throw httpError(409, existing.projectId === body.projectId ? 'PROJECT_ASSIGNMENT_ALREADY_EXISTS' : 'PROJECT_ASSIGNMENT_CONFLICT');
      }
      const created = { id: `a-${nextId++}`, ...body, version: nextVersion++ };
      state.assignments.push(created);
      return created;
    }
    const assignmentMatch = /^\/api\/v1\/project-assignments\/([^/]+)$/.exec(pathname);
    if (assignmentMatch && request.method === 'DELETE') {
      // #73 contract: header 400, unknown 404, stale 409, current/past month 409, else 204 (no body).
      if (request.expectedVersion === undefined) throw httpError(400, null);
      const index = state.assignments.findIndex((item) => item.id === decodeURIComponent(assignmentMatch[1]));
      if (index < 0) throw httpError(404, 'RESOURCE_NOT_FOUND');
      if (state.assignments[index].version !== request.expectedVersion) throw httpError(409, 'PROJECT_ASSIGNMENT_CONFLICT');
      if (state.assignments[index].monthStart <= currentMonthStart) throw httpError(409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT');
      state.assignments.splice(index, 1);
      return undefined;
    }
    if (assignmentMatch && request.method === 'PATCH') {
      // Simplified correction contract: no time-zone/historical scope and no planning guard
      // (tests inject those answers with `fail`).
      const index = state.assignments.findIndex((item) => item.id === decodeURIComponent(assignmentMatch[1]));
      if (index < 0) throw httpError(404, 'RESOURCE_NOT_FOUND');
      const body = request.body as Partial<Omit<ProjectAssignment, 'id' | 'version'>>;
      if (Object.keys(body).length === 0) throw httpError(400, 'EMPTY_PATCH');
      if (body.monthStart !== undefined && !/^\d{4}-\d{2}-01$/.test(body.monthStart)) throw httpError(400, 'INVALID_MONTH_START');
      const current = state.assignments[index];
      const next = { ...current, ...body };
      const person = state.employees.find((item) => item.id === next.employeeId);
      const target = state.projects.find((item) => item.id === next.projectId);
      if (!person || !target) throw httpError(404, 'RESOURCE_NOT_FOUND');
      if (next.employeeId === current.employeeId && next.projectId === current.projectId && next.monthStart === current.monthStart) {
        return current;
      }
      if (next.employeeId !== current.employeeId && person.status !== 'ACTIVE') throw httpError(409, 'EMPLOYEE_INACTIVE');
      if (next.projectId !== current.projectId && target.status !== 'ACTIVE') throw httpError(409, 'PROJECT_INACTIVE');
      const existing = state.assignments.find(
        (item) => item.id !== current.id && item.employeeId === next.employeeId && item.monthStart === next.monthStart,
      );
      if (existing) {
        throw httpError(409, existing.projectId === next.projectId ? 'PROJECT_ASSIGNMENT_ALREADY_EXISTS' : 'PROJECT_ASSIGNMENT_CONFLICT');
      }
      // An effective correction moves the version; a no-op (above) keeps it.
      state.assignments[index] = { ...next, version: nextVersion++ };
      return state.assignments[index];
    }
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  };

  return {
    state,
    handler,
    /** The next request for which `match` returns an error fails with it. */
    fail(match: (request: RecordedRequest) => unknown) {
      failNext = match;
    },
  };
}
