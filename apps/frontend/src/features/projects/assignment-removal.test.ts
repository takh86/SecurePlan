import { describe, expect, it } from 'vitest';
import { ApiError } from '../../shared/api/api-error';
import { httpError } from '../employees/employees.test-support';
import { removalFailureText, removalQuestion, removedText, type RemovalSnapshot } from './assignment-removal';

// Synthetic example snapshot, not a business rule.
const snapshot: RemovalSnapshot = {
  id: 'a-1', version: 1793260800123456, employeeName: 'Mira Beispiel', projectName: 'Demo-Objekt Hafen', monthLabel: 'Januar 2027',
};

describe('#73 — removal texts', () => {
  it('names person, project and month in the question and the confirmation of success', () => {
    expect(removalQuestion(snapshot)).toBe('Zuordnung Mira Beispiel → Demo-Objekt Hafen, Januar 2027 entfernen?');
    expect(removedText(snapshot))
      .toBe('Zuordnung entfernt: Mira Beispiel, Demo-Objekt Hafen, Januar 2027. Ein Ersatz wird nicht automatisch angelegt.');
  });

  it.each([
    ['404 (already removed, unknown or foreign)', httpError(404, 'RESOURCE_NOT_FOUND'), 'Zuordnung nicht mehr vorhanden'],
    ['409 stale version or changed row', httpError(409, 'PROJECT_ASSIGNMENT_CONFLICT'), 'Zuordnung wurde geändert'],
    ['409 month not in the future or planning data', httpError(409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'), 'Entfernen nicht möglich'],
    ['400 missing/invalid Expected-Version (unknown code here)', httpError(400, null), 'Anfrage unvollständig'],
    ['network failure: outcome unknown', new ApiError('network', null, null, null), 'Ergebnis unbekannt'],
  ] as const)('%s has its own title', (_label, error, title) => {
    expect(removalFailureText(error)?.title).toBe(title);
  });

  it('the company time zone and planning data are named for the month refusal; nothing changed', () => {
    expect(removalFailureText(httpError(409, 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'))?.description)
      .toMatch(/künftiger Monate.*Zeitzone des Unternehmens.*Planungsdaten.*nichts geändert/);
  });

  it.each([
    ['401', httpError(401, 'SESSION_EXPIRED')],
    ['403', httpError(403, 'ACTION_FORBIDDEN')],
    ['500', httpError(500, 'INTERNAL_ERROR')],
    ['invalid response', new ApiError('invalid-response', 204, null, null)],
    ['not an ApiError', new Error('x')],
  ] as const)('%s keeps the general text', (_label, error) => {
    expect(removalFailureText(error)).toBeNull();
  });
});
