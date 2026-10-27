import { projectStatusFromDb, toProjectResponse } from './project.mapper.js';

describe('SP-08 — project mapper', () => {
  it('maps a stored row to the v1 response without internal fields', () => {
    expect(toProjectResponse({ id: 'p-1', name: 'Objekt Nord', status: 'INACTIVE' }))
      .toEqual({ id: 'p-1', name: 'Objekt Nord', status: 'INACTIVE' });
  });

  it('fails closed for ARCHIVED (allowed in the database, not part of API v1) and unknown values', () => {
    expect(() => projectStatusFromDb('ARCHIVED')).toThrow('Unexpected project status in database');
    expect(() => projectStatusFromDb('DELETED')).toThrow('Unexpected project status in database');
    expect(() => projectStatusFromDb('active')).toThrow('Unexpected project status in database');
  });
});
