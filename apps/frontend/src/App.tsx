import { useRef, useState, type FormEvent } from 'react';
import { ApiError, parseApiError } from './shared/api/api-error';
import { ApiErrorAlert } from './shared/ui/ApiErrorAlert';
import { LoginScreen } from './features/auth/LoginScreen';
import './App.css';

type ScreenState = 'ready' | 'submitting' | 'success' | 'invalid' | 'error';

// Read and remove the token once, outside React render.
// This avoids losing it during StrictMode's development re-renders.
function captureActivationToken(): string | null {
  if (window.location.pathname !== '/activate') {
    return null;
  }

  const url = new URL(window.location.href);

  const fragmentParams = new URLSearchParams(
    url.hash.slice(1),
  );

  // Prefer the safer fragment format.
  const token =
    fragmentParams.get('token') ??
    url.searchParams.get('token');

  let changed = false;

  if (fragmentParams.has('token')) {
    fragmentParams.delete('token');

    url.hash = fragmentParams.toString()
      ? `#${fragmentParams.toString()}`
      : '';

    changed = true;
  }

  if (url.searchParams.has('token')) {
    url.searchParams.delete('token');
    changed = true;
  }

  if (changed) {
    window.history.replaceState(
      window.history.state,
      '',
      url.pathname + url.search + url.hash,
    );
  }

  return token;
}

const initialToken = captureActivationToken();

function ActivationScreen() {
  const tokenRef = useRef(initialToken);
  const submittingRef = useRef(false);

  const [state, setState] = useState<ScreenState>(
    initialToken ? 'ready' : 'invalid',
  );
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<ApiError | Error | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submittingRef.current || !tokenRef.current) return;
    if (password.length < 15 || password.length > 128) return;
    if (password !== confirmation) return;

    submittingRef.current = true;
    setState('submitting');
    setError(null);

    try {
      let response: Response;

      try {
        response = await fetch('/api/v1/auth/activate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/problem+json',
          },
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          body: JSON.stringify({
            token: tokenRef.current,
            password,
          }),
        });
      } catch {
        throw new ApiError('network', null, null, null);
      }

      if (!response.ok) {
        throw await parseApiError(response);
      }

      tokenRef.current = null;
      setPassword('');
      setConfirmation('');
      setState('success');
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        caught.code === 'ACTIVATION_TOKEN_INVALID_OR_EXPIRED'
      ) {
        tokenRef.current = null;
        setPassword('');
        setConfirmation('');
        setState('invalid');
      } else {
        setError(
          caught instanceof Error
            ? caught
            : new Error('Activation failed'),
        );
        setState('error');
      }
    } finally {
      submittingRef.current = false;
    }
  }

  return (
    <main className="activation">
      <section className="activation__card" aria-labelledby="activation-title">
        <p className="activation__brand">SECUREPLAN</p>

        {state === 'success' ? (
          <div role="status">
            <h1 id="activation-title">Konto aktiviert</h1>
            <p>
              Ihr Passwort wurde eingerichtet. Sie können sich jetzt anmelden.
            </p>
            <a href="/">Zur Anmeldung</a>
          </div>
        ) : state === 'invalid' ? (
          <div role="alert">
            <h1 id="activation-title">Aktivierungslink ungültig</h1>
            <p>
              Dieser Link ist ungültig, abgelaufen oder wurde bereits verwendet.
              Bitte wenden Sie sich an Ihre Administration.
            </p>
          </div>
        ) : (
          <>
            <h1 id="activation-title">Konto aktivieren</h1>
            <p>
              Legen Sie ein sicheres Passwort fest, um Ihr SecurePlan-Konto
              zu aktivieren.
            </p>

            <form onSubmit={handleSubmit}>
              <label htmlFor="password">Passwort</label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                minLength={15}
                maxLength={128}
                required
                value={password}
                disabled={state === 'submitting'}
                onChange={(event) => setPassword(event.target.value)}
              />

              <p className="activation__hint">
                Mindestens 15 Zeichen. Passwortmanager und Einfügen sind erlaubt.
              </p>

              <label htmlFor="confirmation">Passwort bestätigen</label>
              <input
                id="confirmation"
                type="password"
                autoComplete="new-password"
                required
                value={confirmation}
                disabled={state === 'submitting'}
                onChange={(event) => setConfirmation(event.target.value)}
              />

              {confirmation && password !== confirmation && (
                <p className="activation__validation" role="alert">
                  Die Passwörter stimmen nicht überein.
                </p>
              )}

              <ApiErrorAlert error={error} />

              <button
                type="submit"
                disabled={
                  state === 'submitting' ||
                  password.length < 15 ||
                  password.length > 128 ||
                  password !== confirmation
                }
              >
                {state === 'submitting'
                  ? 'Konto wird aktiviert…'
                  : 'Konto aktivieren'}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}

export default function App() {
  if (window.location.pathname === '/activate') {
    return <ActivationScreen />;
  }

  return <LoginScreen />;
}
