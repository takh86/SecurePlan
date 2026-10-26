import { describe, expect, it } from 'vitest';
import { APP_ROUTES, ROLE_LABELS, landingPathFor, routesForRole } from './routes';

describe('F1 — route table', () => {
  it('has unique ids and paths', () => {
    expect(new Set(APP_ROUTES.map((route) => route.id)).size).toBe(APP_ROUTES.length);
    expect(new Set(APP_ROUTES.map((route) => route.path)).size).toBe(APP_ROUTES.length);
  });

  it('T-ROLE-1: uses only the real tenant role values from /me', () => {
    const allowed = ['COMPANY_ADMIN', 'EMPLOYEE'];
    for (const route of APP_ROUTES) {
      expect(allowed, route.id).toContain(route.role);
    }
    expect(new Set(APP_ROUTES.map((route) => route.role))).toEqual(new Set(allowed));
    expect(Object.keys(ROLE_LABELS).sort()).toEqual([...allowed].sort());
    expect(landingPathFor('COMPANY_ADMIN')).toBe('/arbeitsuebersicht');
    expect(landingPathFor('EMPLOYEE')).toBe('/mein-monatsplan');
  });

  it('defines the approved navigation taxonomy per role', () => {
    expect(routesForRole('COMPANY_ADMIN').map((route) => route.title)).toEqual([
      'Arbeitsübersicht',
      'Mitarbeitende',
      'Projekte & Zuordnungen',
      'Monatsplanung',
    ]);
    expect(routesForRole('EMPLOYEE').map((route) => route.title)).toEqual([
      'Mein Monatsplan',
      'Absagen & Ersatz',
      'Meine Statistik',
    ]);
  });

  it('makes each landing route a preview of its own role; only SP-07 employees and SP-08 projects use the real API', () => {
    for (const role of ['COMPANY_ADMIN', 'EMPLOYEE'] as const) {
      const landing = APP_ROUTES.find((route) => route.path === landingPathFor(role));
      expect(landing?.role).toBe(role);
      expect(landing?.availability).toBe('preview');
    }
    const available = APP_ROUTES.filter((route) => route.availability === 'available');
    expect(available.map((route) => [route.id, route.role, route.nested])).toEqual([
      ['employees', 'COMPANY_ADMIN', true],
      ['projects', 'COMPANY_ADMIN', true],
    ]);
    const planned = APP_ROUTES.filter((route) => route.availability === 'planned');
    expect(planned.map((route) => route.id)).toEqual([
      'monthly-planning',
      'cancellations',
      'my-statistics',
    ]);
    for (const route of planned) expect(route.plannedScope, route.id).toBeTruthy();
  });
});
