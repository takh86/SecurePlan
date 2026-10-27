import { Navigate, Route, Routes } from 'react-router';
import { WorkQueuePage } from '../features/cancellation-replacement/work-queue/WorkQueuePage';
import type { AuthenticatedSession } from '../features/auth/LoginScreen';
import type { SessionApi } from '../features/auth/session-api';
import { EmployeesSection } from '../features/employees/EmployeesSection';
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
            element={<RouteView route={route} role={role} api={session.api} />}
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
function RouteView({ route, role, api }: { route: AppRoute; role: TenantRole; api: SessionApi }) {
  if (route.role !== role) return <AccessDeniedPage role={role} />;
  if (route.availability === 'planned') return <PlannedFeaturePage route={route} />;
  switch (route.id) {
    case 'employees':
      return <EmployeesSection route={route} api={api} />;
    case 'projects':
      return <ProjectsSection route={route} api={api} />;
    case 'work-queue':
      return (
        <PageFrame title={route.title} lead={route.lead}>
          <WorkQueuePage />
        </PageFrame>
      );
    case 'my-month-plan':
      return (
        <PageFrame title={route.title} lead={route.lead}>
          <MyMonthPlanPage />
        </PageFrame>
      );
    default:
      return <PlannedFeaturePage route={route} />;
  }
}
