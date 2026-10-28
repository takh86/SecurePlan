/**
 * Edit state a project-detail form reports to the page's single navigation
 * blocker. `dirty`: unsaved input; `saving`: a save whose outcome is not yet confirmed.
 */
export type EditState = 'clean' | 'dirty' | 'saving';
