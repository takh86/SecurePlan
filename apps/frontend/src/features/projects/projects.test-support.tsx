/**
 * Test support for SP-08/SP-09 project screens: renders the real `/projekte`
 * routes with the in-memory SessionApi from the SP-07 test support, plus
 * synthetic example records (labelled examples, not business rules).
 * Only imported by *.test.tsx files.
 */
import { render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { APP_ROUTES } from '../../app/routes';
import { fakeSessionApi, type Handler } from '../employees/employees.test-support';
import type { Project, ProjectPage } from './project-types';
import { ProjectsSection } from './ProjectsSection';

const PROJECTS_ROUTE = APP_ROUTES.find((route) => route.id === 'projects')!;

export function renderProjects(path: string, handler: Handler) {
  const fake = fakeSessionApi(handler);
  const router = createMemoryRouter(
    [{ path: '/projekte/*', element: <main><ProjectsSection route={PROJECTS_ROUTE} api={fake.api} /></main> }],
    { initialEntries: [path] },
  );
  const view = render(<RouterProvider router={router} />);
  const location = () => `${router.state.location.pathname}${router.state.location.search}`;
  return { ...fake, view, router, location };
}

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
