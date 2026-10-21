import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigationType } from 'react-router';
import type { AuthenticatedSession } from '../features/auth/LoginScreen';
import { ApiErrorAlert } from '../shared/ui/ApiErrorAlert';
import { ROLE_LABELS, routesForRole } from './routes';
import '../shared/styles/tokens.css';
import './AppShell.css';

export function AppShell({ session }: { session: AuthenticatedSession }) {
  const { identity, logout, logoutPending, logoutError } = session;
  const [menuOpen, setMenuOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const navigationType = useNavigationType();
  const area = location.pathname.split('/')[1] ?? '';
  const previousArea = useRef<string | null>(null);

  // After in-app navigation to another area, move focus to the new page heading.
  // Not on first load, redirects (REPLACE) or month changes within the same area.
  useEffect(() => {
    const previous = previousArea.current;
    previousArea.current = area;
    if (previous === null || previous === area || navigationType === 'REPLACE') return;
    document.getElementById('page-title')?.focus();
  }, [area, navigationType]);

  function closeMenuOnEscape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape' || !menuOpen) return;
    setMenuOpen(false);
    toggleRef.current?.focus();
  }

  function skipToContent(event: MouseEvent<HTMLAnchorElement>) {
    // Keep the URL free of `#main`; just move focus to the content.
    event.preventDefault();
    document.getElementById('main')?.focus();
  }

  return (
    <div className="shell">
      <a className="shell__skip" href="#main" onClick={skipToContent}>
        Zum Inhalt springen
      </a>
      <div className="shell__sidebar" onKeyDown={closeMenuOnEscape}>
        <header className="shell__header">
          <p className="shell__brand">SECUREPLAN</p>
          <button
            ref={toggleRef}
            type="button"
            className="shell__menu-toggle"
            aria-expanded={menuOpen}
            aria-controls={panelId}
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menü
          </button>
        </header>
        <div id={panelId} className="shell__panel" data-open={menuOpen}>
          <nav className="shell__nav" aria-label="Hauptnavigation">
            <ul>
              {routesForRole(identity.role).map((route) => (
                <li key={route.id}>
                  <NavLink to={route.path} className="shell__nav-link" onClick={() => setMenuOpen(false)}>
                    <span>{route.title}</span>
                    {route.availability === 'planned' && <> <span className="shell__nav-tag">folgt</span></>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <section className="shell__account" aria-label="Konto">
            <p className="shell__account-label">Angemeldet als</p>
            <p className="shell__account-email">{identity.email}</p>
            <p className="shell__account-role">Rolle: {ROLE_LABELS[identity.role]}</p>
            <button type="button" className="shell__logout" onClick={logout} disabled={logoutPending}>
              {logoutPending ? 'Abmeldung läuft …' : 'Abmelden'}
            </button>
          </section>
        </div>
      </div>
      <main id="main" className="shell__main" tabIndex={-1}>
        <ApiErrorAlert error={logoutError} />
        <Outlet />
      </main>
    </div>
  );
}
