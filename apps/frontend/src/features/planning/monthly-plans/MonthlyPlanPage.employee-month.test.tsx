// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/monatsplanung"}
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import userEvent from '@testing-library/user-event';
import { JONAS_ID, LEA_ID, MIRA_ID, PAUL_ID, PLAN_ID, duty, member, plan, planningCompany } from './monthly-planning.test-support';
import { fakeSessionApi, type Handler } from '../../employees/employees.test-support';
import { createEmployeesApi } from '../../employees/employees-api';
import { createProjectsApi } from '../../projects/projects-api';
import { createProjectAssignmentsApi } from '../../projects/project-assignments-api';
import { createShiftConfigurationApi } from '../../projects/shift-configuration-api';
import { createMonthlyPlansApi } from './monthly-plans-api';
import { MonthlyPlanPage } from './MonthlyPlanPage';

// Explicitly exercise the optional-port preview fallback. The production
// section now constructs the live adapter (covered separately).
function renderPlanning(path: string, handler: Handler) {
  const fake = fakeSessionApi(handler);
  const apis = {
    plans: createMonthlyPlansApi(fake.api), projects: createProjectsApi(fake.api),
    employees: createEmployeesApi(fake.api), assignments: createProjectAssignmentsApi(fake.api),
    shiftConfigurations: createShiftConfigurationApi(fake.api),
  };
  const router = createMemoryRouter([
    { path: '/monatsplanung', element: <main>Übersicht</main> },
    { path: '/monatsplanung/:planId', element: <main><MonthlyPlanPage planId={PLAN_ID} basePath="/monatsplanung" apis={apis} timeZone="Europe/Berlin" publishSlot={() => null} /></main> },
  ], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { ...fake, location: () => `${router.state.location.pathname}${router.state.location.search}` };
}

afterEach(() => cleanup());

const PLAN_PATH = `/monatsplanung/${PLAN_ID}`;
const DEC_3 = { dutyDate: '2026-12-03', startsAt: '2026-12-03T05:00:00Z', endsAt: '2026-12-03T17:00:00Z' };
const FREE = 'Frei (nicht eingeplant)';

function setup() {
  const stored = duty({ ...DEC_3, assignments: [member(MIRA_ID, 'SHIFT_LEAD'), member(JONAS_ID)] });
  const server = planningCompany({ plans: [plan()], duties: { [PLAN_ID]: [stored] } });
  return { ...renderPlanning(PLAN_PATH, server.handler), server, stored };
}

async function openPersonView(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('radio', { name: /Monat einer Person planen/ }));
  return screen.findByRole('grid', { name: /^Dienste von .+ im Dezember 2026$/ });
}

function dateButton(day: number) {
  return within(screen.getByRole('grid')).getByRole('button', { name: new RegExp(`^[A-Z][a-z]\\., ${day}\\. Dezember:`) });
}

function stateOf(day: number) {
  return dateButton(day).getAttribute('aria-label')!.split(': ')[1];
}

async function chooseMode(user: ReturnType<typeof userEvent.setup>, label: 'Tag' | 'Nacht' | 'Frei') {
  await user.click(within(screen.getByRole('group', { name: 'Eintragen als' })).getByRole('radio', { name: label }));
}

function prompt(title: string) {
  return screen.getByRole('group', { name: title });
}

describe('#88 plan page — employee-month view (preview, no persistence)', () => {
  it('plans one person with paint modes in the preview without sending any write request', async () => {
    const user = userEvent.setup();
    const { requests } = setup();
    const grid = await openPersonView(user);
    expect(screen.getByRole('grid', { name: 'Dienste von Mira Beispiel im Dezember 2026' })).toBe(grid);
    expect((screen.getByLabelText('Person') as HTMLSelectElement).value).toBe(MIRA_ID);
    expect(screen.getByText(/Monat einer Person planen – noch ohne Speichern/)).toBeTruthy();
    // The matrix and its single-duty tools are not shown in this view.
    expect(screen.queryByRole('grid', { name: 'Dienste im Dezember 2026 nach Person und Tag' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dienst hinzufügen' })).toBeNull();

    expect(stateOf(3)).toBe('Tagdienst (Schichtleitung)');
    await chooseMode(user, 'Nacht');
    await user.click(dateButton(3));
    await user.click(dateButton(4));
    expect(stateOf(3)).toBe('Nachtdienst (Mitarbeitende)');
    const save = screen.getByRole('button', { name: 'Monat speichern' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    await user.click(save);
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(stateOf(4)).toBe('Nachtdienst (Mitarbeitende)');
  });

  it('guards unsaved selections on person switches, view switches and navigation away', async () => {
    const user = userEvent.setup();
    const { location } = setup();
    await openPersonView(user);
    await chooseMode(user, 'Nacht');
    await user.click(dateButton(4));

    // Next person: held back; staying keeps the draft.
    await user.click(screen.getByRole('button', { name: 'Nächste Person: Jonas Muster' }));
    expect(prompt('Ungespeicherte Monatsplanung').textContent).toContain('Wenn Sie wechseln, wird sie verworfen.');
    await user.click(screen.getByRole('button', { name: 'Weiter planen' }));
    expect(stateOf(4)).toBe('Nachtdienst (Mitarbeitende)');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Nächste Person: Jonas Muster');

    // Leaving the page: held back by the page blocker with the same wording.
    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    expect(prompt('Ungespeicherte Monatsplanung')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Weiter planen' }));
    expect(location()).toBe(PLAN_PATH);
    expect(stateOf(4)).toBe('Nachtdienst (Mitarbeitende)');

    // Choosing another person in the list: discarding switches to that person's month.
    await user.selectOptions(screen.getByLabelText('Person'), LEA_ID);
    await user.click(within(prompt('Ungespeicherte Monatsplanung')).getByRole('button', { name: 'Auswahl verwerfen und wechseln' }));
    expect(await screen.findByRole('grid', { name: 'Dienste von Lea Probe im Dezember 2026' })).toBeTruthy();
    expect((screen.getByLabelText('Person') as HTMLSelectElement).value).toBe(LEA_ID);
    expect(screen.getByRole('region', { name: /Ungespeicherte Änderungen/ }).textContent).toContain('Keine ungespeicherten Änderungen.');

    // Back to all persons with a new unsaved selection: held back again.
    await chooseMode(user, 'Tag');
    await user.click(dateButton(3));
    await user.click(screen.getByRole('radio', { name: 'Alle Personen' }));
    expect((screen.getByRole('radio', { name: /Monat einer Person planen/ }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(prompt('Ungespeicherte Monatsplanung')).getByRole('button', { name: 'Auswahl verwerfen und wechseln' }));
    expect(await screen.findByRole('grid', { name: 'Dienste im Dezember 2026 nach Person und Tag' })).toBeTruthy();

    // Without unsaved input the page can be left at once.
    await user.click(screen.getByRole('link', { name: 'Zurück zur Übersicht' }));
    await waitFor(() => expect(location()).toBe('/monatsplanung?month=2026-12'));
  });

  it('opens the planner for the person of a matrix cell', async () => {
    const user = userEvent.setup();
    setup();
    const matrix = await screen.findByRole('grid', { name: 'Dienste im Dezember 2026 nach Person und Tag' });
    await user.click(within(matrix).getByRole('button', { name: /^Jonas Muster, Do\., 3\. Dezember/ }));
    await user.click(screen.getByRole('button', { name: 'Monat von Jonas Muster planen (Vorschau)' }));
    expect(await screen.findByRole('grid', { name: 'Dienste von Jonas Muster im Dezember 2026' })).toBeTruthy();
    expect(stateOf(3)).toBe('Tagdienst (Mitarbeitende)');
    // Jonas is only released for day duties: in NACHT mode his dates are not offered.
    await chooseMode(user, 'Nacht');
    expect(dateButton(4).getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps the planner of a person whom a newer read no longer lists (membership removed elsewhere)', async () => {
    const user = userEvent.setup();
    const stored = duty({ ...DEC_3, assignments: [member(MIRA_ID), member(PAUL_ID)] });
    const server = planningCompany({ plans: [plan()], duties: { [PLAN_ID]: [stored] } });
    renderPlanning(PLAN_PATH, server.handler);
    await openPersonView(user);
    await user.selectOptions(screen.getByLabelText('Person'), PAUL_ID);
    await screen.findByRole('grid', { name: 'Dienste von Paul Anders im Dezember 2026' });
    // Paul is not assigned this month: only Frei is offered.
    await chooseMode(user, 'Nacht');
    expect(dateButton(4).getAttribute('aria-disabled')).toBe('true');
    await chooseMode(user, 'Frei');
    await user.click(dateButton(3));
    server.state.duties[PLAN_ID] = [{ ...stored, version: stored.version + 1, assignments: [stored.assignments[0]] }];

    await user.click(screen.getByRole('button', { name: 'Aktuellen Stand laden' }));
    await waitFor(() => expect(screen.getByText(/Eine Ihrer Änderungen ist darin bereits enthalten\./)).toBeTruthy());
    expect(screen.getByRole('grid', { name: 'Dienste von Paul Anders im Dezember 2026' })).toBeTruthy();
    expect((screen.getByLabelText('Person') as HTMLSelectElement).value).toBe(PAUL_ID);
    expect(stateOf(3)).toBe(FREE);
  });

  it('keeps the draft on "Aktuellen Stand laden" and marks a duty another admin changed meanwhile', async () => {
    const user = userEvent.setup();
    const { server, stored } = setup();
    await openPersonView(user);
    await user.click(screen.getByRole('button', { name: 'Nächste Person: Jonas Muster' }));
    await screen.findByRole('grid', { name: 'Dienste von Jonas Muster im Dezember 2026' });
    await chooseMode(user, 'Frei');
    await user.click(dateButton(3)); // take Jonas off the 3 Dec day duty (unsaved)
    // Another admin adds Lea to the same duty.
    server.state.duties[PLAN_ID] = [{ ...stored, version: stored.version + 1, assignments: [...stored.assignments, member(LEA_ID)] }];

    await user.click(screen.getByRole('button', { name: 'Aktuellen Stand laden' }));
    await waitFor(() => expect(screen.getByText(/Der aktuelle Stand wurde geladen\./)).toBeTruthy());
    const changes = screen.getByRole('region', { name: /Ungespeicherte Änderungen/ });
    expect(changes.textContent).toContain('Frei, bisher Tagdienst (Mitarbeitende)');
    expect(changes.textContent).toContain('Die Besetzung des Tagdienstes wurde inzwischen geändert.');
    expect(stateOf(3)).toBe(FREE);
    expect(screen.getByRole('region', { name: 'Ausgewählter Tag: Do., 3. Dezember' }).textContent)
      .toContain('Tagdienst, weitere Personen (bleiben unverändert): Lea Probe, Mira Beispiel (Schichtleitung)');
  });
});
