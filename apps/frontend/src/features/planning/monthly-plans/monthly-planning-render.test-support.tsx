/** Renders the real SP-11 PR-2 /monatsplanung routes with an in-memory session API, a fixed clock and zone. */
import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { APP_ROUTES } from '../../../app/routes';
import type { Clock } from '../../../shared/time/clock';
import { fakeSessionApi, type Handler } from '../../employees/employees.test-support';
import { DECEMBER_2026 } from '../../projects/projects.test-support';
import { MonthlyPlanningSection } from './MonthlyPlanningSection';

const PLANNING_ROUTE = APP_ROUTES.find((route) => route.id === 'monthly-planning')!;

export function renderPlanning(
  path: string,
  handler: Handler,
  options: { clock?: Clock; timeZone?: string; strict?: boolean } = {},
) {
  const fake = fakeSessionApi(handler);
  const router = createMemoryRouter(
    [{
      path: '/monatsplanung/*',
      element: (
        <main>
          <MonthlyPlanningSection
            route={PLANNING_ROUTE}
            api={fake.api}
            clock={options.clock ?? DECEMBER_2026}
            timeZone={options.timeZone ?? 'Europe/Berlin'}
          />
        </main>
      ),
    }],
    { initialEntries: [path] },
  );
  const provider = <RouterProvider router={router} />;
  const view = render(options.strict ? <StrictMode>{provider}</StrictMode> : provider);
  const location = () => `${router.state.location.pathname}${router.state.location.search}`;
  return { ...fake, view, router, location };
}
