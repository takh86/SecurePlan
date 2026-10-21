import { Link } from 'react-router';
import { StatusBadge } from '../shared/ui/StatusBadge';
import { PageFrame } from './PageFrame';
import { landingPathFor, type AppRoute, type TenantRole } from './routes';

/** Placeholder for a navigation destination that is not built yet; renders no data. */
export function PlannedFeaturePage({ route }: { route: AppRoute }) {
  return (
    <PageFrame title={route.title}>
      <div className="fallback-page">
        <StatusBadge tone="neutral">Noch nicht verfügbar</StatusBadge>
        <p>Dieser Bereich ist noch nicht verfügbar. Er wird in einer späteren Ausbaustufe ergänzt.</p>
        {route.plannedScope && <p>Geplanter Umfang: {route.plannedScope}</p>}
      </div>
    </PageFrame>
  );
}

/**
 * Shown for a route of the other role. This only improves UX; access to data is
 * decided by the server for every API request.
 */
export function AccessDeniedPage({ role }: { role: TenantRole }) {
  return (
    <PageFrame title="Kein Zugriff auf diese Ansicht">
      <div className="fallback-page">
        <p>Diese Ansicht gehört nicht zu Ihrem Arbeitsbereich.</p>
        <Link to={landingPathFor(role)}>Zur Startseite</Link>
      </div>
    </PageFrame>
  );
}

export function NotFoundPage({ role }: { role: TenantRole }) {
  return (
    <PageFrame title="Seite nicht gefunden">
      <div className="fallback-page">
        <p>Diese Adresse gibt es in SecurePlan nicht.</p>
        <Link to={landingPathFor(role)}>Zur Startseite</Link>
      </div>
    </PageFrame>
  );
}
