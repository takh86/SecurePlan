import { OpenDutiesPage } from '../features/cancellation-replacement/open-duties/OpenDutiesPage';
import { Navigate, Route, Routes } from 'react-router';
import { WorkQueueSection } from '../features/cancellation-replacement/work-queue/WorkQueueSection';
import type { AuthenticatedSession } from '../features/auth/LoginScreen';
import type { SessionApi } from '../features/auth/session-api';
import { EmployeesSection } from '../features/employees/EmployeesSection';
import { MonthlyPlanningSection } from '../features/planning/monthly-plans/MonthlyPlanningSection';
import { MyStatisticsPage } from '../features/planning/my-statistics/MyStatisticsPage';
import { MyMonthPlanPage } from '../features/planning/my-month-plan/MyMonthPlanPage';
import { ProjectsSection } from '../features/projects/ProjectsSection';
import { AppShell } from './AppShell';
import { AccessDeniedPage, NotFoundPage, PlannedFeaturePage } from './FallbackPages';
import { PageFrame } from './PageFrame';
import { APP_ROUTES, landingPathFor, type AppRoute, type TenantRole } from './routes';

/** Protected application. Rendered only for an identity validated by the server. */
export function AuthenticatedApp(session: AuthenticatedSession) {
  const role = session.identity.role;
  return (
    <Routes>
      <Route element={<AppShell session={session} />}>
        <Route index element={<Navigate to={landingPathFor(role)} replace />} />
        {APP_ROUTES.map((route) => (
          <Route
            key={route.id}
            path={routePattern(route)}
            element={<RouteView route={route} role={role} api={session.api} identity={session.identity} requestSessionRevalidation={session.requestSessionRevalidation} />}
          />
        ))}
        <Route path="*" element={<NotFoundPage role={role} />} />
      </Route>
    </Routes>
  );
}

function routePattern(route: AppRoute): string {
  if (route.acceptsMonth) return `${route.path}/:month?`;
  if (route.nested) return `${route.path}/*`;
  return route.path;
}

// Role check is UX only; the server authorizes every API request on its own.
function RouteView({ route, role, api, identity, requestSessionRevalidation }: { route: AppRoute; role: TenantRole; api: SessionApi; identity: AuthenticatedSession['identity']; requestSessionRevalidation: () => void }) {
  if (route.role !== role) return <AccessDeniedPage role={role} />;
  if (route.availability === 'planned') return <PlannedFeaturePage route={route} />;
  switch (route.id) {
    case 'open-duties':
      return <PageFrame title={route.title}><OpenDutiesPage api={api} identity={identity} requestSessionRevalidation={requestSessionRevalidation} /></PageFrame>;
    case 'employees':
      return <EmployeesSection route={route} api={api} />;
    case 'projects':
      return <ProjectsSection route={route} api={api} />;
    case 'monthly-planning':
      return <MonthlyPlanningSection route={route} api={api} />;
    case 'work-queue':
      return (
        <WorkQueueSection route={route} api={api} identity={identity} />
      );
    case 'my-statistics':
      return (
        <PageFrame title={route.title} lead={route.lead}>
          <MyStatisticsPage api={api} identity={identity} requestSessionRevalidation={requestSessionRevalidation} />
        </PageFrame>
      );
    case 'my-month-plan':
      return (
        <PageFrame title={route.title} lead={route.lead}>
          <MyMonthPlanPage api={api} identity={identity} requestSessionRevalidation={requestSessionRevalidation} />
        </PageFrame>
      );
    default:
      return <PlannedFeaturePage route={route} />;
  }
}
