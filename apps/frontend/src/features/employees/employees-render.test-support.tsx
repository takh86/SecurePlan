/** Renders the real SP-07 routes (list, create, detail) with an in-memory session API. */
import { render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { APP_ROUTES } from '../../app/routes';
import { EmployeesSection } from './EmployeesSection';
import { fakeSessionApi, type Handler } from './employees.test-support';

const EMPLOYEES_ROUTE = APP_ROUTES.find((route) => route.id === 'employees')!;

export function renderEmployees(path: string, handler: Handler) {
  const fake = fakeSessionApi(handler);
  const router = createMemoryRouter(
    [{ path: '/mitarbeitende/*', element: <main><EmployeesSection route={EMPLOYEES_ROUTE} api={fake.api} /></main> }],
    { initialEntries: [path] },
  );
  const view = render(<RouterProvider router={router} />);
  const location = () => `${router.state.location.pathname}${router.state.location.search}`;
  return { ...fake, view, location };
}
