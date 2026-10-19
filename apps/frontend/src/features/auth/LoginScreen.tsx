import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../shared/api/api-error';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import {
  currentSession,
  login,
  logout,
  type AuthenticatedContext,
} from './auth-api';
import './LoginScreen.css';

type ViewState = 'checking' | 'logged-out' | 'submitting' | 'authenticated' | 'logging-out';

export function LoginScreen() {
  const [state, setState] = useState<ViewState>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [auth, setAuth] = useState<AuthenticatedContext | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let mounted = true;
    // Recover a session using the Cookie + /me; no auth state in LocalStorage.
    void currentSession().then(
      (restored) => {
        if (!mounted) return;
        setAuth(restored);
        setState('authenticated');
      },
      (cause: unknown) => {
        if (!mounted) return;
        // A missing/expired session is normal for the login page.
        if (!(cause instanceof ApiError && cause.status === 401)) {
          setError(cause instanceof Error ? cause : new Error('Session check failed'));
        }
        setState('logged-out');
      },
    );
    return () => { mounted = false; };
  }, []);

  async function onLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || state !== 'logged-out') return;
    if (!email.trim() || !password) return;
    inFlight.current = true;
    setState('submitting');
    setError(null);
    try {
      const next = await login(email.trim(), password);
      setAuth(next);
      setPassword('');
      setState('authenticated');
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Login failed'));
      setState('logged-out');
    } finally {
      inFlight.current = false;
    }
  }

  async function onLogout() {
    if (inFlight.current || !auth || state !== 'authenticated') return;
    inFlight.current = true;
    setState('logging-out');
    setError(null);
    try {
      await logout(auth.csrfToken);
      setAuth(null);
      setPassword('');
      setState('logged-out');
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error('Logout failed');
      setError(failure);
      // A 401 proves this session is no longer valid; otherwise preserve
      // the authenticated state and allow explicit retry.
      if (failure instanceof ApiError && failure.status === 401) {
        setAuth(null);
        setState('logged-out');
      } else {
        setState('authenticated');
      }
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <main className="activation">
      <section className="activation__card login" aria-labelledby="login-title">
        <p className="activation__brand">SECUREPLAN</p>

        {state === 'checking' ? (
          <div role="status" aria-live="polite">
            <h1 id="login-title">Sitzung wird geprüft</h1>
            <p>Einen Moment bitte …</p>
          </div>
        ) : auth && (state === 'authenticated' || state === 'logging-out') ? (
          <div>
            <h1 id="login-title">Angemeldet</h1>
            <p className="login__muted">Sie sind sicher bei SecurePlan angemeldet.</p>
            <dl className="login__identity">
              <dt>E-Mail</dt><dd>{auth.identity.email}</dd>
              <dt>Rolle</dt><dd>{auth.identity.role === 'COMPANY_ADMIN' ? 'Administration' : 'Mitarbeitende'}</dd>
            </dl>
            <p className="login__hint">Die geschützte Planungsoberfläche folgt in einem späteren Feature.</p>
            <ApiErrorAlert error={error} />
            <button
              className="login__logout"
              type="button"
              onClick={() => { void onLogout(); }}
              disabled={state === 'logging-out'}
            >
              {state === 'logging-out' ? 'Abmeldung läuft …' : 'Abmelden'}
            </button>
          </div>
        ) : (
          <>
            <h1 id="login-title">Anmelden</h1>
            <p className="login__muted">Melden Sie sich mit Ihrem SecurePlan-Konto an.</p>
            <form onSubmit={(event) => { void onLogin(event); }} aria-busy={state === 'submitting'}>
              <label htmlFor="login-email">E-Mail-Adresse</label>
              <input
                id="login-email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={320}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={state === 'submitting'}
              />
              <label htmlFor="login-password">Passwort</label>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={state === 'submitting'}
              />
              <ApiErrorAlert error={error} />
              <button type="submit" disabled={state === 'submitting' || !email.trim() || !password}>
                {state === 'submitting' ? 'Anmeldung läuft …' : 'Anmelden'}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
