import { useNavigate } from 'react-router';
import { LoginScreen } from '../features/auth/LoginScreen';
import { AuthenticatedApp } from './AuthenticatedApp';
import { SESSION_REDIRECT_STATE } from './session-redirect';

/**
 * Connects the session boundary to the router. Protected routes render only
 * after login or GET /me succeeded; after logout the URL is reset to `/` so
 * the next sign-in does not inherit the previous deep link. That redirect is
 * explicitly marked, so no unsaved-changes guard can hold it back.
 */
export function SessionRoot() {
  const navigate = useNavigate();
  return (
    <LoginScreen
      authenticatedView={AuthenticatedApp}
      onSignedOut={() => {
        void navigate('/', { replace: true, state: SESSION_REDIRECT_STATE });
      }}
    />
  );
}
