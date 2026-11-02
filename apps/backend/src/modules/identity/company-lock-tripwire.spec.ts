/**
 * LOCK-01-L1 DEC-1.3 tripwire (SP11A-R1 T1). The legacy joined actor helper
 * (`FOR SHARE OF a, c`) leaves the account/company locking order to the
 * planner. It is cycle-free only because the company row is a SHARE-only leaf:
 * no application code or migration writes or exclusively locks `companies`.
 * This test enforces that invariant (DEC-1.2) without a database:
 * - no UPDATE / DELETE FROM / INSERT INTO / TRUNCATE of companies;
 * - no LOCK TABLE naming companies;
 * - no FOR UPDATE / FOR NO KEY UPDATE that covers the company row (an OF list
 *   naming its alias, or no OF list in a statement reading companies);
 * - joined account+company LOCKING statements only in the two allow-listed
 *   files, with exactly the reviewed number of copies.
 * A future company writer needs its own ADR, the sequential helper with the
 * company tier directly after the accounts, migration of the legacy helper in
 * the same change and a real-PG proof; only then may this allow-list change.
 *
 * Stated limits: a static text scan; dynamically built or out-of-band SQL is
 * invisible to it. Migrations after 0010 are covered because the whole
 * directory is scanned.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = join(BACKEND, 'src');
const MIGRATIONS = join(BACKEND, 'migrations');

/** File (relative to apps/backend, forward slashes) -> reviewed number of joined locking statements. */
const JOINED_LOCK_ALLOW_LIST: Readonly<Record<string, number>> = {
  'src/auth/authorization/actor-in-transaction.ts': 1,
  'src/auth/session.service.ts': 2,
};

type Source = { file: string; text: string; sql: string[] };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Block comments, then line comments that start a line or follow whitespace (keeps "https://"). */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)(?:\/\/|--)[^\n]*/g, '$1');
}

/** SQL-bearing literals of a TypeScript file, or the statements of a .sql file. */
export function sqlFragments(text: string, isSql: boolean): string[] {
  if (isSql) return text.split(';');
  return [
    ...text.matchAll(/`(?:[^`\\]|\\.)*`/g),
    ...text.matchAll(/'(?:[^'\\\n]|\\.)*'/g),
    ...text.matchAll(/"(?:[^"\\\n]|\\.)*"/g),
  ].map((match) => match[0]);
}

const WRITE = /\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\s+(?:ONLY\s+)?(?:public\.)?companies\b/i;
const LOCK_TABLE = /\bLOCK\s+(?:TABLE\s+)?(?:ONLY\s+)?[^;`'"]*\bcompanies\b/i;
const READS_COMPANIES = /\b(?:FROM|JOIN)\s+(?:public\.)?companies\b(?:\s+(?:AS\s+)?(?!WHERE\b|ON\b|JOIN\b|FOR\b)([A-Za-z_]\w*))?/i;
const EXCLUSIVE = /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b(?:\s+OF\s+([A-Za-z_][\w\s,]*?))?(?=\s*(?:\bFOR\b|\bNOWAIT\b|\bSKIP\b|[`'";)]|$))/gi;
const JOINED_LOCK = /\bFROM\s+accounts\b[\s\S]*\bJOIN\s+companies\b[\s\S]*\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i;

export function violations(source: Source): { problems: string[]; joinedLocks: number } {
  const problems: string[] = [];
  if (WRITE.test(source.text)) problems.push(`${source.file}: writes companies`);
  if (LOCK_TABLE.test(source.text)) problems.push(`${source.file}: LOCK TABLE on companies`);
  let joinedLocks = 0;
  for (const fragment of source.sql) {
    const reads = READS_COMPANIES.exec(fragment);
    if (reads) {
      const alias = (reads[1] ?? 'companies').toLowerCase();
      for (const clause of fragment.matchAll(EXCLUSIVE)) {
        const ofList = clause[1]?.split(',').map((name) => name.trim().toLowerCase());
        if (ofList === undefined || ofList.includes(alias) || ofList.includes('companies')) {
          problems.push(`${source.file}: exclusive row lock covers companies (${clause[0].trim()})`);
        }
      }
    }
    if (JOINED_LOCK.test(fragment)) joinedLocks += 1;
  }
  return { problems, joinedLocks };
}

function sources(): Source[] {
  const files = [
    ...walk(SRC).filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts')),
    ...walk(MIGRATIONS).filter((path) => path.endsWith('.sql')),
  ];
  return files.map((path) => {
    const text = stripComments(readFileSync(path, 'utf8'));
    const file = relative(BACKEND, path).replaceAll('\\', '/');
    return { file, text, sql: sqlFragments(text, path.endsWith('.sql')) };
  });
}

describe('LOCK-01-L1 DEC-1.3 — company rows are a SHARE-only leaf', () => {
  it('scans the backend sources and every migration', () => {
    const files = sources().map(({ file }) => file);
    expect(files).toEqual(expect.arrayContaining([
      ...Object.keys(JOINED_LOCK_ALLOW_LIST),
      'src/modules/identity/account-prefix-lock.ts',
      'migrations/0002_identity_accounts.sql',
      'migrations/0011_planning_foundation.sql',
    ]));
  });

  it('no source writes, table-locks or exclusively row-locks companies', () => {
    expect(sources().flatMap((source) => violations(source).problems)).toEqual([]);
  });

  it('joined account+company locking statements exist only in the allow-listed files, exactly as reviewed', () => {
    const counts = Object.fromEntries(
      sources().map((source) => [source.file, violations(source).joinedLocks]).filter(([, n]) => n !== 0),
    );
    expect(counts).toEqual(JOINED_LOCK_ALLOW_LIST);
  });
});

describe('LOCK-01-L1 DEC-1.3 — tripwire self-check (red/green)', () => {
  const check = (text: string, isSql = false) =>
    violations({ file: 'probe', text: stripComments(text), sql: sqlFragments(stripComments(text), isSql) });

  it.each([
    ['UPDATE companies', "await client.query('UPDATE companies SET status = $2 WHERE id = $1')"],
    ['DELETE FROM companies', '`DELETE FROM public.companies WHERE id = $1`'],
    ['INSERT INTO companies', 'INSERT INTO companies (id) VALUES (1);'],
    ['TRUNCATE companies', 'TRUNCATE ONLY companies;'],
    ['LOCK TABLE companies', 'LOCK TABLE companies IN SHARE ROW EXCLUSIVE MODE;'],
    ['FOR UPDATE without OF', '`SELECT status FROM companies WHERE id = $1 FOR UPDATE`'],
    ['FOR UPDATE before a line break and the closing backtick', '`SELECT status FROM companies\n WHERE id = $1\n FOR UPDATE\n `'],
    ['FOR NO KEY UPDATE without OF', '`SELECT 1 FROM companies c WHERE c.id = $1 FOR NO KEY UPDATE`'],
    ['FOR UPDATE OF the company alias', '`SELECT a.role FROM accounts AS a JOIN companies AS c ON c.id = a.company_id FOR UPDATE OF a, c`'],
    ['FOR UPDATE in a joined statement without OF', '`SELECT 1 FROM accounts a JOIN companies c ON c.id = a.company_id FOR UPDATE`'],
  ])('red: %s is reported', (_name, text) => {
    expect(check(text, text.endsWith(';')).problems).toHaveLength(1);
  });

  it.each([
    ['company FOR SHARE in its own statement', "'SELECT status FROM companies WHERE id = $1 FOR SHARE'"],
    ['plain company read', '`SELECT c.time_zone FROM companies AS c WHERE c.id = $1`'],
    ['account UPDATE lock, company SHARE lock', '`SELECT a.role FROM accounts AS a JOIN companies AS c ON c.id = a.company_id FOR UPDATE OF a FOR SHARE OF c`'],
    ['commented-out write', '// UPDATE companies SET x = 1\n/* DELETE FROM companies */ const url = "https://example.invalid";'],
    ['a column merely named like the table', '`UPDATE employees SET companies_seen = 1`'],
  ])('green: %s is allowed', (_name, text) => {
    expect(check(text).problems).toEqual([]);
  });

  it('counts joined locking statements, not joined plain reads', () => {
    expect(check('`SELECT 1 FROM accounts AS a JOIN companies AS c ON c.id = a.company_id FOR SHARE OF a, c`').joinedLocks).toBe(1);
    expect(check('`SELECT 1 FROM accounts AS a LEFT JOIN companies AS c ON c.id = a.company_id WHERE a.id = $1`').joinedLocks).toBe(0);
  });
});
