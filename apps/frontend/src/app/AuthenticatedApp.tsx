import { Navigate, Route, Routes } from 'react-router';
import { WorkQueuePage } from '../features/cancellation-replacement/work-queue/WorkQueuePage';
import type { AuthenticatedSession } from '../features/auth/LoginScreen';
import { MyMonthPlanPage } from '../features/planning/my-month-plan/MyMonthPlanPage';
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
            path={route.acceptsMonth ? `${route.path}/:month?` : route.path}
            element={<RouteView route={route} role={role} />}
          />
        ))}
        <Route path="*" element={<NotFoundPage role={role} />} />
      </Route>
    </Routes>
  );
}

// Role check is UX only; the server authorizes every API request on its own.
function RouteView({ route, role }: { route: AppRoute; role: TenantRole }) {
  if (route.role !== role) return <AccessDeniedPage role={role} />;
  if (route.availability === 'planned') return <PlannedFeaturePage route={route} />;
  switch (route.id) {
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
