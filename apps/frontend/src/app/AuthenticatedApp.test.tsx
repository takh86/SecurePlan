// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { ApiError } from '../shared/api/api-error';
import type { IdentityContext } from '../features/auth/auth-api';
import { fakeSessionApi, page, type RecordedRequest } from '../features/employees/employees.test-support';
import { AuthenticatedApp } from './AuthenticatedApp';
import { APP_ROUTES, type TenantRole } from './routes';

const ROLES: readonly TenantRole[] = ['COMPANY_ADMIN', 'EMPLOYEE'];
const ADMIN_PREVIEW_TEXT = ['Alex Beispiel', 'Demo-Objekt Messe', 'Offene Vorgänge'];
const EMPLOYEE_PREVIEW_TEXT = ['Dezember 2026', 'Projekt: Demo-Objekt Nord'];

function identityFor(role: TenantRole): IdentityContext {
  return {
    accountId: '11111111-1111-4111-8111-111111111111',
    companyId: '22222222-2222-4222-8222-222222222222',
    email: role === 'COMPANY_ADMIN' ? 'admin@secureplan.test' : 'mitarbeitende@secureplan.test',
    role,
  };
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

let apiRequests: RecordedRequest[] = [];

function renderApp(role: TenantRole, path: string, overrides: { logoutPending?: boolean; logoutError?: Error | null } = {}) {
  const logout = vi.fn();
  // SP-07: the employees area reads through the session-bound API (empty company here).
  const { api, requests } = fakeSessionApi(() => page([]));
  apiRequests = requests;
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthenticatedApp
        identity={identityFor(role)}
        api={api}
        logout={logout}
        logoutPending={overrides.logoutPending ?? false}
        logoutError={overrides.logoutError ?? null}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
  return { logout };
}

function pageHeading() {
  return screen.getByRole('heading', { level: 1 });
}

function currentPath() {
  return screen.getByTestId('location').textContent;
}

beforeEach(() => {
  // Deterministic "today" for the default preview sources: 15.12.2026, local midday.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 11, 15, 12, 0, 0));
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('F1 — role-based routes (UI gating only; the server authorizes every API call)', () => {
  describe.each(ROLES)('role %s', (role) => {
    it.each(APP_ROUTES.map((route) => [route.path, route] as const))('%s', async (path, route) => {
      renderApp(role, path);
      if (route.role === role) {
        expect(pageHeading().textContent).toBe(route.title);
      } else {
        expect(pageHeading().textContent).toBe('Kein Zugriff auf diese Ansicht');
        expect(screen.getByRole('link', { name: 'Zur Startseite' })).toBeTruthy();
        // No preview data of the other role is rendered behind the access-denied page.
        const text = document.body.textContent ?? '';
        for (const fragment of [...ADMIN_PREVIEW_TEXT, ...EMPLOYEE_PREVIEW_TEXT, 'Demodaten']) {
          expect(text).not.toContain(fragment);
        }
        // The access-denied page never requests data of another role's area.
        expect(apiRequests).toEqual([]);
      }
      expect(currentPath()).toBe(path);
    });

    it('redirects / to the role landing page', async () => {
      renderApp(role, '/');
      const landing = role === 'COMPANY_ADMIN' ? '/arbeitsuebersicht' : '/mein-monatsplan';
      await waitFor(() => expect(currentPath()).toBe(landing));
      expect(pageHeading().textContent).toBe(role === 'COMPANY_ADMIN' ? 'Arbeitsübersicht' : 'Mein Monatsplan');
    });

    it('shows a safe not-found page for unknown paths', () => {
      renderApp(role, '/gibt-es-nicht');
      expect(pageHeading().textContent).toBe('Seite nicht gefunden');
      expect(screen.getByRole('link', { name: 'Zur Startseite' }).getAttribute('href')).toBe(
        role === 'COMPANY_ADMIN' ? '/arbeitsuebersicht' : '/mein-monatsplan',
      );
    });
  });

  it('shows only the admin navigation for COMPANY_ADMIN, with planned items marked as text', async () => {
    renderApp('COMPANY_ADMIN', '/arbeitsuebersicht');
    const nav = screen.getByRole('navigation', { name: 'Hauptnavigation' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Arbeitsübersicht',
      'Mitarbeitende',
      'Projekte & Zuordnungen',
      'Monatsplanung folgt',
    ]);
    expect(links[0].getAttribute('aria-current')).toBe('page');
    expect(within(nav).queryByText('Mein Monatsplan')).toBeNull();
    expect(await screen.findByText('Alex Beispiel')).toBeTruthy();
  });

  it('shows only the employee navigation for EMPLOYEE and marks the month route as current', async () => {
    renderApp('EMPLOYEE', '/mein-monatsplan/2027-01');
    const nav = screen.getByRole('navigation', { name: 'Hauptnavigation' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Mein Monatsplan',
      'Absagen & Ersatz folgt',
      'Meine Statistik folgt',
    ]);
    expect(links[0].getAttribute('aria-current')).toBe('page');
    expect(within(nav).queryByText('Arbeitsübersicht')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Januar 2027');
  });

  it('redirects an invalid month to the current month for EMPLOYEE', async () => {
    renderApp('EMPLOYEE', '/mein-monatsplan/2026-13');
    await waitFor(() => expect(currentPath()).toBe('/mein-monatsplan'));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Dezember 2026');
  });

  it('keeps the access-denied page for COMPANY_ADMIN on an employee month deep link', () => {
    renderApp('COMPANY_ADMIN', '/mein-monatsplan/2027-01');
    expect(pageHeading().textContent).toBe('Kein Zugriff auf diese Ansicht');
    expect(currentPath()).toBe('/mein-monatsplan/2027-01');
    expect(document.body.textContent).not.toContain('Januar 2027');
  });

  it('renders placeholders for planned areas without data', () => {
    renderApp('EMPLOYEE', '/meine-statistik');
    expect(pageHeading().textContent).toBe('Meine Statistik');
    expect(screen.getByText('Noch nicht verfügbar')).toBeTruthy();
    expect(screen.queryByText(/Demodaten/)).toBeNull();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('shows the account e-mail and role label but no internal identifiers', () => {
    renderApp('COMPANY_ADMIN', '/arbeitsuebersicht');
    const account = screen.getByRole('region', { name: 'Konto' });
    expect(account.textContent).toContain('admin@secureplan.test');
    expect(account.textContent).toContain('Rolle: Administration');
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(text).not.toContain('22222222-2222-4222-8222-222222222222');
  });

  it('moves focus to the page heading and updates the title after navigating to another area', async () => {
    const user = userEvent.setup();
    renderApp('COMPANY_ADMIN', '/arbeitsuebersicht');
    await waitFor(() => expect(document.title).toBe('Arbeitsübersicht – SecurePlan'));

    await user.click(screen.getByRole('link', { name: /^Monatsplanung/ }));
    expect(currentPath()).toBe('/monatsplanung');
    expect(document.activeElement).toBe(pageHeading());
    expect(pageHeading().textContent).toBe('Monatsplanung');
    expect(document.title).toBe('Monatsplanung – SecurePlan');
  });

  it('keeps focus on the month link when switching months within the plan', async () => {
    const user = userEvent.setup();
    renderApp('EMPLOYEE', '/mein-monatsplan');
    await user.click(screen.getByRole('link', { name: /^Nächster Monat/ }));
    expect(currentPath()).toBe('/mein-monatsplan/2027-01');
    expect(document.activeElement?.textContent).toContain('Nächster Monat');
  });

  it('provides landmarks and a skip link that focuses the main content', async () => {
    renderApp('EMPLOYEE', '/mein-monatsplan');
    expect(screen.getByRole('banner')).toBeTruthy();
    const main = screen.getByRole('main');
    await userEvent.setup().click(screen.getByRole('link', { name: 'Zum Inhalt springen' }));
    expect(document.activeElement).toBe(main);
    expect(currentPath()).toBe('/mein-monatsplan');
  });

  it('toggles the compact menu and closes it with Escape, returning focus to the toggle', async () => {
    const user = userEvent.setup();
    renderApp('EMPLOYEE', '/mein-monatsplan');
    const toggle = screen.getByRole('button', { name: 'Menü' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(panel?.getAttribute('data-open')).toBe('true');

    await user.click(within(panel!).getByRole('link', { name: /^Meine Statistik/ }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await user.click(toggle);
    await user.keyboard('{Escape}');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('wires the logout button, its pending state and a logout error alert', async () => {
    const { logout } = renderApp('EMPLOYEE', '/mein-monatsplan');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Abmelden' }));
    expect(logout).toHaveBeenCalledTimes(1);
    cleanup();

    renderApp('EMPLOYEE', '/mein-monatsplan', {
      logoutPending: true,
      logoutError: new ApiError('http', 403, 'CSRF_VALIDATION_FAILED', null),
    });
    expect((screen.getByRole('button', { name: 'Abmeldung läuft …' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Kein Zugriff');
  });
});
