import { useMemo } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router';
import type { AppRoute } from '../../app/routes';
import { useFocusHeadingOnSubpageChange } from '../../app/use-focus-heading-on-subpage-change';
import type { SessionApi } from '../auth/session-api';
// Shared admin list/form/card styles (introduced with SP-07).
import '../employees/Employees.css';
import { ProjectCreatePage } from './ProjectCreatePage';
import { ProjectDetailPage } from './ProjectDetailPage';
import { ProjectsListPage } from './ProjectsListPage';
import { createProjectsApi, type ProjectsApi } from './projects-api';

/**
 * SP-08 admin area `/projekte`: list, create (`/neu`) and detail (`/:id`).
 * Only real API data; the server enforces COMPANY_ADMIN and tenant scope.
 */
export function ProjectsSection({ route, api }: { route: AppRoute; api: SessionApi }) {
  const projects = useMemo(() => createProjectsApi(api), [api]);
  useFocusHeadingOnSubpageChange();
  return (
    <Routes>
      <Route index element={<ProjectsListPage route={route} projects={projects} />} />
      <Route path="neu" element={<ProjectCreatePage basePath={route.path} projects={projects} />} />
      <Route path=":projectId" element={<DetailRoute basePath={route.path} projects={projects} />} />
      <Route path="*" element={<Navigate to={route.path} replace />} />
    </Routes>
  );
}

function DetailRoute({ basePath, projects }: { basePath: string; projects: ProjectsApi }) {
  const { projectId = '' } = useParams();
  // A new id is a new page: no state carries over from the previous record.
  return <ProjectDetailPage key={projectId} projectId={projectId} basePath={basePath} projects={projects} />;
}
