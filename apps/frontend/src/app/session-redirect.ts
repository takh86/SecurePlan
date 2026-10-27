/**
 * Marks the one navigation the session boundary itself performs after a
 * confirmed sign-out or session loss (SessionRoot -> `/`). Unsaved-changes
 * guards let ONLY this marked redirect pass; every other navigation, REPLACE
 * included, stays guarded. This is not a security control: the protected
 * content is already hidden by the session state when the redirect runs.
 */
const MARKER = 'secureplanSessionRedirect';

export const SESSION_REDIRECT_STATE: Readonly<Record<string, true>> = Object.freeze({ [MARKER]: true });

export function isSessionRedirect(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[MARKER] === true;
}
