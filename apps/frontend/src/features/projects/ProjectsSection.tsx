import { useMemo } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router';
import type { AppRoute } from '../../app/routes';
import { useFocusHeadingOnSubpageChange } from '../../app/use-focus-heading-on-subpage-change';
import { systemClock, type Clock } from '../../shared/time/clock';
import type { SessionApi } from '../auth/session-api';
import { createEmployeesApi } from '../employees/employees-api';
// Shared admin list/form/card styles (introduced with SP-07).
import '../employees/Employees.css';
import { createProjectAssignmentsApi } from './project-assignments-api';
import type { AssignmentApis } from './ProjectAssignmentsPanel';
import { ProjectCreatePage } from './ProjectCreatePage';
import { ProjectDetailPage } from './ProjectDetailPage';
import { ProjectsListPage } from './ProjectsListPage';
import { createProjectsApi } from './projects-api';
import './Projects.css';

type SectionProps = { route: AppRoute; api: SessionApi; clock?: Clock };

/**
 * SP-08/SP-09 admin area `/projekte`: list, create (`/neu`) and detail with
 * the month assignment (`/:id` = current month, `/:id/:month` with YYYY-MM).
 * Only real API data; the server enforces COMPANY_ADMIN and tenant scope.
 */
export function ProjectsSection({ route, api, clock = systemClock }: SectionProps) {
  const apis = useMemo<AssignmentApis>(
    () => ({
      projects: createProjectsApi(api),
      employees: createEmployeesApi(api),
      assignments: createProjectAssignmentsApi(api),
    }),
    [api],
  );
  // Month steps stay on the same page: focus remains on the month link.
  useFocusHeadingOnSubpageChange(sameProjectPage);
  const detail = <DetailRoute basePath={route.path} apis={apis} clock={clock} />;
  return (
    <Routes>
      <Route index element={<ProjectsListPage route={route} projects={apis.projects} />} />
      <Route path="neu" element={<ProjectCreatePage basePath={route.path} projects={apis.projects} />} />
      <Route path=":projectId" element={detail} />
      <Route path=":projectId/:month" element={detail} />
      <Route path="*" element={<Navigate to={route.path} replace />} />
    </Routes>
  );
}

const DETAIL_PATH = /^\/projekte\/([^/]+)(?:\/[^/]+)?$/;

/** `/projekte/:id` and `/projekte/:id/:month` of the same project are one page. */
function sameProjectPage(previous: string, next: string): boolean {
  const before = DETAIL_PATH.exec(previous)?.[1];
  return before !== undefined && before !== 'neu' && before === DETAIL_PATH.exec(next)?.[1];
}

function DetailRoute({ basePath, apis, clock }: { basePath: string; apis: AssignmentApis; clock: Clock }) {
  const { projectId = '', month } = useParams();
  // A new id is a new page: no state carries over from the previous record.
  return (
    <ProjectDetailPage
      key={projectId}
      projectId={projectId}
      monthParam={month}
      basePath={basePath}
      apis={apis}
      clock={clock}
    />
  );
}
