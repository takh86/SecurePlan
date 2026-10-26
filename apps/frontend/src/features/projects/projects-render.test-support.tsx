/** Renders the real SP-08/SP-09 /projekte routes with an in-memory session API and a fixed clock. */
import { render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { APP_ROUTES } from '../../app/routes';
import type { Clock } from '../../shared/time/clock';
import { fakeSessionApi, type Handler } from '../employees/employees.test-support';
import { ProjectsSection } from './ProjectsSection';
import { DECEMBER_2026 } from './projects.test-support';

const PROJECTS_ROUTE = APP_ROUTES.find((route) => route.id === 'projects')!;

export function renderProjects(path: string, handler: Handler, clock: Clock = DECEMBER_2026) {
  const fake = fakeSessionApi(handler);
  const router = createMemoryRouter(
    [{ path: '/projekte/*', element: <main><ProjectsSection route={PROJECTS_ROUTE} api={fake.api} clock={clock} /></main> }],
    { initialEntries: [path] },
  );
  const view = render(<RouterProvider router={router} />);
  const location = () => `${router.state.location.pathname}${router.state.location.search}`;
  return { ...fake, view, router, location };
}
