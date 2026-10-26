import { useEffect, useEffectEvent, useRef, useState, type ComponentType, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { ApiError } from '../../shared/api/api-error';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { useDocumentTitle } from '../../shared/ui/use-document-title';
import {
  currentSession,
  login,
  logout,
  type AuthenticatedContext,
  type IdentityContext,
} from './auth-api';
import { createSessionApi, type SessionApi } from './session-api';
import './LoginScreen.css';

type ViewState = 'checking' | 'logged-out' | 'submitting' | 'authenticated' | 'logging-out';

/**
 * What the protected UI receives. The CSRF token deliberately stays inside
 * LoginScreen; `api` is bound to it without exposing it (SP-07).
 */
export type AuthenticatedSession = {
  identity: IdentityContext;
  api: SessionApi;
  logout: () => void;
  logoutPending: boolean;
  logoutError: Error | null;
};

type LoginScreenProps = {
  /** Protected UI; rendered only with an identity validated by login or GET /me. */
  authenticatedView: ComponentType<AuthenticatedSession>;
  /** Called once the server session is gone (logout 204 or 401). */
  onSignedOut?: () => void;
};

/** Session boundary: restores/creates the session and shows the login form until one is valid. */
export function LoginScreen({ authenticatedView: AuthenticatedView, onSignedOut }: LoginScreenProps) {
  const [state, setState] = useState<ViewState>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [auth, setAuthState] = useState<AuthenticatedContext | null>(null);
  const [api, setApi] = useState<SessionApi | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const inFlight = useRef(false);
  // The session the UI belongs to right now; lets a late response for an
  // earlier session be recognised as stale.
  const currentAuth = useRef<AuthenticatedContext | null>(null);
  const showsProtectedUi = auth !== null && (state === 'authenticated' || state === 'logging-out');
  useDocumentTitle(showsProtectedUi ? null : 'Anmelden');

  // Adopts a validated session (or none) together with its own API object.
  // A 401 from any business call means the server session is gone: show the
  // login in place (same URL) with the reason, so the user can continue after
  // signing in again. A late 401 for an earlier session (a write still in flight
  // across logout or re-login) is ignored: it must neither end the current
  // session nor touch the login form.
  function setAuth(next: AuthenticatedContext | null) {
    currentAuth.current = next;
    setAuthState(next);
    setApi(next && createSessionApi(next.csrfToken, (cause) => {
      if (currentAuth.current !== next) return;
      setAuth(null);
      setPassword('');
      setError(cause);
      setState('logged-out');
    }));
  }

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

  // Stable across re-renders: a parent re-render (e.g. a location change) must not
  // restart the effect below and orphan a pending session check.
  const signedOut = useEffectEvent(() => onSignedOut?.());

  useEffect(() => {
    if (!auth) return;
    let mounted = true;
    function onPageShow(event: PageTransitionEvent) {
      // Single-flight: shares the login/logout guard, so overlapping restores
      // cannot race and an obsolete response cannot override a newer outcome.
      if (!event.persisted || inFlight.current) return;
      inFlight.current = true;
      // Restored from the back/forward cache: hide protected content until
      // GET /me confirms the session again.
      flushSync(() => setState('checking'));
      void currentSession().then(
        (restored) => {
          if (!mounted) return;
          setAuth(restored);
          setState('authenticated');
        },
        (cause: unknown) => {
          if (!mounted) return;
          if (!(cause instanceof ApiError && cause.status === 401)) {
            setError(cause instanceof Error ? cause : new Error('Session check failed'));
          }
          setAuth(null);
          setState('logged-out');
          signedOut();
        },
      ).finally(() => {
        inFlight.current = false;
      });
    }
    window.addEventListener('pageshow', onPageShow);
    return () => {
      mounted = false;
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [auth]);

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
      onSignedOut?.();
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error('Logout failed');
      setError(failure);
      // A 401 proves this session is no longer valid; otherwise preserve
      // the authenticated state and allow explicit retry.
      if (failure instanceof ApiError && failure.status === 401) {
        setAuth(null);
        setState('logged-out');
        onSignedOut?.();
      } else {
        setState('authenticated');
      }
    } finally {
      inFlight.current = false;
    }
  }

  if (showsProtectedUi && api) {
    return (
      <AuthenticatedView
        identity={auth.identity}
        api={api}
        logout={() => { void onLogout(); }}
        logoutPending={state === 'logging-out'}
        logoutError={error}
      />
    );
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
