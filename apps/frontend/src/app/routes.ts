import type { IdentityContext } from '../features/auth/auth-api';
import { MY_MONTH_PLAN_PATH } from '../features/planning/my-month-plan/my-month-plan-paths';

/** Tenant role exactly as returned by GET /api/v1/me (`COMPANY_ADMIN` | `EMPLOYEE`). */
export type TenantRole = IdentityContext['role'];

export type AppRouteId =
  | 'work-queue'
  | 'employees'
  | 'projects'
  | 'monthly-planning'
  | 'my-month-plan'
  | 'cancellations'
  | 'my-statistics';

export interface AppRoute {
  id: AppRouteId;
  path: string;
  /**
   * The only role whose navigation contains this route. This gating is UX only:
   * the server authorizes every API request independently (SP-06 AccessControlGuard).
   */
  role: TenantRole;
  title: string;
  lead?: string;
  /**
   * `available`: real, contract-backed API. `preview`: read-only UI preview
   * with synthetic data. `planned`: placeholder, no data.
   */
  availability: 'available' | 'preview' | 'planned';
  /** Shown on the placeholder page of a planned route. */
  plannedScope?: string;
  /** Route additionally accepts an optional `/:month` (`YYYY-MM`) segment. */
  acceptsMonth?: boolean;
  /** Route owns nested sub-pages below its path (e.g. list, create, detail). */
  nested?: boolean;
}

export const APP_ROUTES: readonly AppRoute[] = [
  {
    id: 'work-queue',
    path: '/arbeitsuebersicht',
    role: 'COMPANY_ADMIN',
    title: 'Arbeitsübersicht',
    lead: 'Offene Vorgänge – Absagen und Ersatzbedarf, die eine Entscheidung brauchen.',
    availability: 'preview',
  },
  {
    id: 'employees',
    path: '/mitarbeitende',
    role: 'COMPANY_ADMIN',
    title: 'Mitarbeitende',
    lead: 'Mitarbeitende anlegen, bearbeiten und deaktivieren.',
    availability: 'available',
    nested: true,
  },
  {
    id: 'projects',
    path: '/projekte',
    role: 'COMPANY_ADMIN',
    title: 'Projekte & Zuordnungen',
    lead: 'Projekte pflegen und Mitarbeitende monatsweise einem Projekt zuordnen.',
    availability: 'available',
    nested: true,
  },
  {
    id: 'monthly-planning',
    path: '/monatsplanung',
    role: 'COMPANY_ADMIN',
    title: 'Monatsplanung',
    availability: 'planned',
    plannedScope: 'Monatspläne je Projekt erstellen, veröffentlichen und anpassen.',
  },
  {
    id: 'my-month-plan',
    path: MY_MONTH_PLAN_PATH,
    role: 'EMPLOYEE',
    title: 'Mein Monatsplan',
    lead: 'Ihre geplanten Dienste im ausgewählten Monat.',
    availability: 'preview',
    acceptsMonth: true,
  },
  {
    id: 'cancellations',
    path: '/absagen-und-ersatz',
    role: 'EMPLOYEE',
    title: 'Absagen & Ersatz',
    availability: 'planned',
    plannedScope: 'Eigene Absageanträge und Ersatzangebote mit ihrem Status einsehen.',
  },
  {
    id: 'my-statistics',
    path: '/meine-statistik',
    role: 'EMPLOYEE',
    title: 'Meine Statistik',
    availability: 'planned',
    plannedScope: 'Geplante Arbeitstage sowie Tag- und Nachtdienste auf Basis des veröffentlichten Plans.',
  },
];

export const ROLE_LABELS: Record<TenantRole, string> = {
  COMPANY_ADMIN: 'Administration',
  EMPLOYEE: 'Mitarbeitende',
};

export function routesForRole(role: TenantRole): AppRoute[] {
  return APP_ROUTES.filter((route) => route.role === role);
}

export function landingPathFor(role: TenantRole): string {
  switch (role) {
    case 'COMPANY_ADMIN':
      return '/arbeitsuebersicht';
    case 'EMPLOYEE':
      return MY_MONTH_PLAN_PATH;
  }
}
