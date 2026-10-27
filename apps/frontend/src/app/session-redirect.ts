/**
 * Marks the one navigation the session boundary itself performs after a
 * confirmed sign-out or session loss (SessionRoot -> `/`). Unsaved-changes
 * guards let ONLY this exact navigation pass: a marked REPLACE to a bare `/`.
 * Every other navigation (other target, PUSH/POP, unmarked, extra search/hash)
 * stays guarded. This is not a security control: the protected
 * content is already hidden by the session state when the redirect runs.
 */
const MARKER = 'secureplanSessionRedirect';

export const SESSION_REDIRECT_STATE: Readonly<Record<string, true>> = Object.freeze({ [MARKER]: true });

function isSessionRedirect(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[MARKER] === true;
}

/** True only for the session boundary's own redirect: marked REPLACE to a bare `/`. */
export function isSessionRedirectNavigation(
  historyAction: string,
  next: { pathname: string; search: string; hash: string; state: unknown },
): boolean {
  return (
    historyAction === 'REPLACE' &&
    next.pathname === '/' &&
    next.search === '' &&
    next.hash === '' &&
    isSessionRedirect(next.state)
  );
}
