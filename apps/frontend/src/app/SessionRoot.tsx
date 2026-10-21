import { useNavigate } from 'react-router';
import { LoginScreen } from '../features/auth/LoginScreen';
import { AuthenticatedApp } from './AuthenticatedApp';

/**
 * Connects the session boundary to the router. Protected routes render only
 * after login or GET /me succeeded; after logout the URL is reset to `/` so
 * the next sign-in does not inherit the previous deep link.
 */
export function SessionRoot() {
  const navigate = useNavigate();
  return (
    <LoginScreen
      authenticatedView={AuthenticatedApp}
      onSignedOut={() => {
        void navigate('/', { replace: true });
      }}
    />
  );
}
