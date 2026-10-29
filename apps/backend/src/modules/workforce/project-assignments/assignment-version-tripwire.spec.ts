/**
 * #73 static CI tripwire (U-3): the assignment version is `updated_at` in epoch
 * microseconds, so it only strictly increases if EVERY application UPDATE of
 * project_assignments applies PROJECT_ASSIGNMENT_TOUCH (TL sign-off S-2 R2).
 * This scans source text: it complements the real-PostgreSQL version tests
 * (test/project-assignments-remove-real.e2e-spec.ts), it does not replace them,
 * and it cannot see SQL built from fragments elsewhere or run out of band.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ASSIGNMENT_TOUCH } from './project-assignment.mapper.js';

const SRC_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPTS_DIR = fileURLToPath(new URL('../../../../../../scripts/', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations/', import.meta.url));

function files(dir: string, accept: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, accept);
    return accept(name) ? [path] : [];
  });
}

const applicationSources = () => [
  ...files(SRC_DIR, (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts')),
  ...files(SCRIPTS_DIR, (name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs')),
];

/** Every `UPDATE project_assignments … ` up to the end of its SQL string or statement. */
function assignmentUpdates(text: string): string[] {
  return [...text.matchAll(/UPDATE\s+(?:public\.)?project_assignments\b[^`;]*/gi)].map((match) => match[0]);
}

describe('#73 — every application UPDATE of project_assignments keeps the version strictly increasing', () => {
  it('the scan sees the known writer (not vacuous)', () => {
    const service = readFileSync(join(SRC_DIR, 'modules/workforce/project-assignments/project-assignments.service.ts'), 'utf8');
    expect(assignmentUpdates(service)).toHaveLength(1);
  });

  it('each UPDATE sets updated_at only through PROJECT_ASSIGNMENT_TOUCH', () => {
    const violations: string[] = [];
    for (const file of applicationSources()) {
      for (const statement of assignmentUpdates(readFileSync(file, 'utf8'))) {
        const touches = statement.includes('${PROJECT_ASSIGNMENT_TOUCH}') || statement.includes(PROJECT_ASSIGNMENT_TOUCH);
        // Any other updated_at assignment (e.g. clock_timestamp() alone) could move the version backwards.
        const otherAssignments = statement.replace('${PROJECT_ASSIGNMENT_TOUCH}', '').replace(PROJECT_ASSIGNMENT_TOUCH, '')
          .match(/updated_at\s*=/gi);
        if (!touches || otherAssignments !== null) violations.push(`${file}: ${statement.replace(/\s+/g, ' ').trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no migration installs a trigger or rule that writes project_assignments behind the application', () => {
    for (const file of files(MIGRATIONS_DIR, (name) => name.endsWith('.sql'))) {
      const sql = readFileSync(file, 'utf8');
      expect(sql, file).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER[^;]*project_assignments/i);
      expect(sql, file).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?RULE[^;]*project_assignments/i);
      expect(assignmentUpdates(sql), file).toEqual([]);
    }
  });

  it('no upsert writes project_assignments around the UPDATE rule', () => {
    for (const file of applicationSources()) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?project_assignments\b[^`;]*ON\s+CONFLICT/i);
    }
  });
});
