// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/monatsplanung"}
/**
 * #88 A2 on the plan page with an injected `employeeMonths` port. Production
 * (`MonthlyPlanningSection`) passes none until the wiring step, so this is a
 * mocked integration test, not browser acceptance.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { fakeSessionApi } from '../../employees/employees.test-support';
import { createEmployeesApi } from '../../employees/employees-api';
import { createProjectAssignmentsApi } from '../../projects/project-assignments-api';
import { createProjectsApi } from '../../projects/projects-api';
import { createShiftConfigurationApi } from '../../projects/shift-configuration-api';
import { MonthlyPlanPage, type PlanPageApis } from './MonthlyPlanPage';
import { employeeMonthServer } from './employee-month.test-support';
import { createMonthlyPlansApi } from './monthly-plans-api';
import { JONAS_ID, MIRA_ID, PLAN_ID, duty, member, plan, planningCompany } from './monthly-planning.test-support';

afterEach(() => cleanup());

const PLAN_PATH = `/monatsplanung/${PLAN_ID}`;
const SHARED = 'd0000000-0000-4000-8000-0000000000a3';

function renderPage() {
  // The matrix read (context) and the A2 read describe the same shared duty on 3 December.
  const stored = duty({ id: SHARED, version: 4, dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z', assignments: [member(JONAS_ID, 'SHIFT_LEAD')] });
  const company = planningCompany({ plans: [plan()], duties: { [PLAN_ID]: [stored] } });
  const a2 = employeeMonthServer({ day: { 3: { dutyId: SHARED, version: 4, role: null } } });
  const session = fakeSessionApi(company.handler);
  const apis: PlanPageApis = {
    plans: createMonthlyPlansApi(session.api),
    projects: createProjectsApi(session.api),
    employees: createEmployeesApi(session.api),
    assignments: createProjectAssignmentsApi(session.api),
    shiftConfigurations: createShiftConfigurationApi(session.api),
    employeeMonths: a2.api,
  };
  const router = createMemoryRouter(
    [
      { path: '/monatsplanung', element: <main>Übersicht</main> },
      { path: '/monatsplanung/:planId', element: <main><MonthlyPlanPage planId={PLAN_ID} basePath="/monatsplanung" apis={apis} timeZone="Europe/Berlin" publishSlot={() => null} /></main> },
    ],
    { initialEntries: [PLAN_PATH] },
  );
  render(<RouterProvider router={router} />);
  const location = () => `${router.state.location.pathname}${router.state.location.search}`;
  return { a2, company, session, location };
}

function dateButton(day: number) {
  return within(screen.getByRole('grid')).getByRole('button', { name: new RegExp(`^[A-Z][a-z]\\., ${day}\\. Dezember:`) });
}

describe('#88 plan page — employee-month view with the A2 port', () => {
  it('is no preview: plans on the A2 read, saves once, stays on the person and offers the next one', async () => {
    const user = userEvent.setup();
    const { a2, session } = renderPage();
    const option = await screen.findByRole('radio', { name: /Monat einer Person planen/ });
    expect(option.closest('label')!.textContent).not.toContain('Vorschau');
    await user.click(option);
    await screen.findByRole('grid', { name: 'Dienste von Mira Beispiel im Dezember 2026' });
    expect(screen.queryByText(/noch ohne Speichern/)).toBeNull();
    expect(a2.reads()).toHaveLength(1);

    await user.click(within(screen.getByRole('group', { name: 'Eintragen als' })).getByRole('radio', { name: 'Tag' }));
    await user.click(dateButton(3));
    await user.click(screen.getByRole('button', { name: 'Monat speichern' }));
    await waitFor(() => expect(screen.getByText(/Der Monat wurde gespeichert: 1 Dienst geändert\. Der aktuelle Stand ist geladen\./)).toBeTruthy());
    expect(a2.saves()).toHaveLength(1);
    // The matrix read is refreshed as context; no single-duty write was sent.
    expect(session.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect((screen.getByLabelText('Person') as HTMLSelectElement).value).toBe(MIRA_ID);
    expect(screen.getByRole('button', { name: 'Nächste Person: Jonas Muster' })).toBeTruthy();
  });

  it('holds a navigation back while the outcome of a save is unknown', async () => {
    const user = userEvent.setup();
    const { a2, location } = renderPage();
    await user.click(await screen.findByRole('radio', { name: /Monat einer Person planen/ }));
    await screen.findByRole('grid');
    a2.loseNextSave();
    await user.click(within(screen.getByRole('group', { name: 'Eintragen als' })).getByRole('radio', { name: 'Nacht' }));
    await user.click(dateButton(9));
    await user.click(screen.getByRole('button', { name: 'Monat speichern' }));
    await screen.findByRole('heading', { name: 'Ergebnis unbekannt' });
    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    expect(screen.getByRole('group', { name: 'Ungespeicherte Monatsplanung' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Weiter planen' }));
    expect(location()).toBe(PLAN_PATH);
    expect(a2.saves()).toHaveLength(1);
  });
});
