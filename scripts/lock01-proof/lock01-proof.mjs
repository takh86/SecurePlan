/**
 * SP-11A LOCK-01-L1 review-only proof suite (synthetic schema, NO product tables).
 *
 * Models the lock modes of the proposed protocol on tiny stand-in tables in a
 * uniquely named, self-created schema of a VERIFIED disposable PostgreSQL 17
 * target. It proves PostgreSQL lock semantics the design relies on; it does NOT
 * exercise SecurePlan application code or the future planning migration.
 *
 * Safety: verifyRecordedTestTarget() runs first (same gate as npm run test:e2e);
 * only the own schema is created/dropped; server major version must be 17.
 * Synthetic data only; nothing credential-bearing is printed or written.
 *
 * SCOPE LIMITS (read before citing a PASS):
 *  - PASS means PostgreSQL lock/wait/visibility semantics behaved as modelled. It is not business-rule proof.
 *  - D4 (project deactivation) and D5 (employment edit / deactivation) stand-ins are SIMPLIFIED predicates
 *    (any live Duty / membership beyond a date). They do not model the approved D4/D5 semantics (scope of
 *    "dependent", Employment-period boundaries, SP-10 absence interplay, the E-04 barrier set).
 *  - publish() locks only the plan row and has no Draft/Publish/Re-Publish version model. The final state
 *    "PUBLISHED with a Duty committed after the publish-time snapshot" is recorded as observed and classified
 *    NOT_PROVEN_CONTRACT_UNDECIDED; no lifecycle rule is asserted because the CR-03 source is not available.
 *  - The "CURRENT order" deactivation control is a model of the code's employee -> account order, not a run
 *    of the real service. Real-schema concurrency tests are a PR-1 gate and are kept separate from this file.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { verifyRecordedTestTarget } from '../disposable-test-target.mjs';

await verifyRecordedTestTarget(); // throws -> process exits non-zero, nothing else runs
const SCHEMA = `lock01_proof_${randomBytes(4).toString('hex')}`;
const OUT = process.env.LOCK01_PROOF_OUTPUT ?? 'lock01-proof-results.json';
const results = [];
const clients = [];

async function open() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`SET search_path TO ${SCHEMA}`);
  await c.query(`SET lock_timeout = '15s'`);
  await c.query(`SET statement_timeout = '30s'`);
  try { await c.query(`SET deadlock_timeout = '1s'`); } catch { /* needs privilege; default 1s anyway */ }
  c.pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  clients.push(c);
  return c;
}
const begin = (c) => c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isBlockedBy(obs, waiter, blocker) {
  const r = await obs.query('SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS b', [waiter.pid, blocker.pid]);
  return r.rows[0].b;
}
async function awaitBlocked(obs, waiter, blocker, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) {
    if (await isBlockedBy(obs, waiter, blocker)) return true;
  }
  return false;
}

async function reset(obs) {
  if (process.env.LOCK01_TRACE) console.error('reset after', results.length, JSON.stringify(results.at(-1)));
  await obs.query(`TRUNCATE membership, duty, plan, monthly_link, shift_cfg, audit, employee, project, account CASCADE`);
  await obs.query(`INSERT INTO account VALUES (1,'ACTIVE')`);
  await obs.query(`INSERT INTO employee VALUES (1,'ACTIVE',NULL),(2,'ACTIVE',NULL)`);
  await obs.query(`INSERT INTO project VALUES (1,'ACTIVE')`);
  await obs.query(`INSERT INTO plan VALUES (1,1,'2026-12-01','UNPUBLISHED',NULL)`);
  await obs.query(`INSERT INTO monthly_link VALUES (1,1,1,'2026-12-01')`);
}

// ---- writers: {lock(c): barrier statements; finish(c): fresh reads+writes -> outcome string} ----
const dutyCreate = ({ id, emp = null, s = 10, e = 20, date = '2026-12-10' }) => ({
  name: `DUTY_CREATE(${id}${emp ? `,emp${emp}` : ',empty'})`,
  async lock(c) {
    if (emp) await c.query('SELECT 1 FROM employee WHERE id=$1 FOR NO KEY UPDATE', [emp]); // E
    await c.query('SELECT 1 FROM project WHERE id=1 FOR SHARE');                              // P
    if (emp) await c.query('SELECT 1 FROM monthly_link WHERE employee_id=$1 FOR SHARE', [emp]); // M
    await c.query('SELECT 1 FROM plan WHERE id=1 FOR SHARE');                                 // L
  },
  async finish(c) {
    // NEW statements after the waits (never a pre-wait snapshot)
    const p = (await c.query('SELECT status FROM project WHERE id=1')).rows[0];
    if (p.status !== 'ACTIVE') return 'REFUSED_PROJECT';
    const cfg = (await c.query('SELECT count(*)::int n FROM shift_cfg WHERE project_id=1')).rows[0].n;
    if (emp) {
      const e1 = (await c.query('SELECT status, emp_end FROM employee WHERE id=$1', [emp])).rows[0];
      if (e1.status !== 'ACTIVE') return 'REFUSED_EMPLOYEE';
      if (e1.emp_end !== null && new Date(e1.emp_end) < new Date(date)) return 'REFUSED_EMPLOYMENT';
      if ((await c.query('SELECT 1 FROM monthly_link WHERE employee_id=$1 AND project_id=1 AND month=$2', [emp, '2026-12-01'])).rowCount === 0) return 'REFUSED_LINK';
      const ov = await c.query(`SELECT 1 FROM membership m JOIN duty d ON d.id=m.duty_id
        WHERE m.employee_id=$1 AND m.state='ACTIVE' AND d.removed=false AND d.s < $3 AND $2 < d.e`, [emp, s, e]);
      if (ov.rowCount) return 'REFUSED_OVERLAP';
    }
    await c.query(`INSERT INTO duty(id,plan_id,project_id,duty_date,s,e,cfg_seen) VALUES ($1,1,1,$2,$3,$4,$5)`, [id, date, s, e, cfg]);
    if (emp) await c.query(`INSERT INTO membership(id,duty_id,employee_id) VALUES ($1,$1,$2)`, [id, emp]);
    return 'CREATED';
  },
});
const empPatchEnd = ({ emp = 1, end = '2026-12-05' } = {}) => ({
  name: 'EMPLOYMENT_PATCH_END',
  async lock(c) { await c.query('SELECT 1 FROM employee WHERE id=$1 FOR UPDATE', [emp]); },
  async finish(c) {
    const n = (await c.query(`SELECT count(*)::int n FROM membership m JOIN duty d ON d.id=m.duty_id
      WHERE m.employee_id=$1 AND m.state='ACTIVE' AND d.removed=false AND d.duty_date > $2`, [emp, end])).rows[0].n;
    if (n > 0) return 'REFUSED_DUTY_DEPENDENCY';
    await c.query('UPDATE employee SET emp_end=$2 WHERE id=$1', [emp, end]);
    return 'APPLIED';
  },
});
const empDeactivate = ({ emp = 1 } = {}) => ({
  name: 'EMPLOYEE_DEACTIVATE',
  async lock(c) { await c.query('SELECT 1 FROM employee WHERE id=$1 FOR UPDATE', [emp]); },
  async finish(c) {
    const n = (await c.query(`SELECT count(*)::int n FROM membership m JOIN duty d ON d.id=m.duty_id
      WHERE m.employee_id=$1 AND m.state='ACTIVE' AND d.removed=false`, [emp])).rows[0].n;
    if (n > 0) return 'REFUSED_DUTY_DEPENDENCY';
    await c.query(`UPDATE employee SET status='DEACTIVATED' WHERE id=$1`, [emp]);
    return 'APPLIED';
  },
});
const linkDelete = ({ emp = 1 } = {}) => ({
  name: 'MONTHLY_ASSIGNMENT_DELETE',
  async lock(c) {
    await c.query('SELECT 1 FROM employee WHERE id=$1 FOR NO KEY UPDATE', [emp]);
    await c.query('SELECT 1 FROM project WHERE id=1 FOR SHARE');
    await c.query('SELECT 1 FROM monthly_link WHERE employee_id=$1 FOR UPDATE', [emp]);
  },
  async finish(c) {
    const n = (await c.query(`SELECT count(*)::int n FROM membership m JOIN duty d ON d.id=m.duty_id
      WHERE m.employee_id=$1 AND m.state='ACTIVE' AND d.removed=false AND d.project_id=1
        AND date_trunc('month', d.duty_date)='2026-12-01'`, [emp])).rows[0].n;
    if (n > 0) return 'REFUSED_DUTY_DEPENDENCY';
    await c.query('DELETE FROM monthly_link WHERE employee_id=$1', [emp]);
    return 'APPLIED';
  },
});
const projectDeactivate = () => ({
  name: 'PROJECT_DEACTIVATE',
  async lock(c) { await c.query(`SELECT 1 FROM project WHERE id=1 FOR NO KEY UPDATE`); },
  async finish(c) {
    const n = (await c.query('SELECT count(*)::int n FROM duty WHERE project_id=1 AND removed=false')).rows[0].n;
    if (n > 0) return 'REFUSED_DUTY_DEPENDENCY';
    await c.query(`UPDATE project SET status='INACTIVE' WHERE id=1`);
    return 'APPLIED';
  },
});
const shiftPatch = () => ({
  name: 'SHIFT_CONFIG_PATCH',
  async lock(c) { await c.query(`SELECT 1 FROM project WHERE id=1 FOR NO KEY UPDATE`); },
  async finish(c) {
    // D3: refuse while a saved (non-removed) Duty exists on the project; plain fresh read after the P lock.
    const n = (await c.query('SELECT count(*)::int n FROM duty WHERE project_id=1 AND removed=false')).rows[0].n;
    if (n > 0) return 'REFUSED_DUTY_DEPENDENCY';
    await c.query(`INSERT INTO shift_cfg(project_id) VALUES (1)`);
    return 'APPLIED';
  },
});
const publish = () => ({
  name: 'INITIAL_PUBLISH',
  async lock(c) { await c.query('SELECT 1 FROM plan WHERE id=1 FOR UPDATE'); },
  async finish(c) {
    const n = (await c.query('SELECT count(*)::int n FROM duty WHERE plan_id=1 AND removed=false')).rows[0].n;
    await c.query(`UPDATE plan SET state='PUBLISHED', published_count=$1 WHERE id=1`, [n]);
    return `PUBLISHED_COUNT_${n}`;
  },
});

// ---- generic race: X acquires first; Y starts while X holds; X ends; Y completes ----
async function race(obs, name, X, Y, firstEnds, expectBlocked) {
  await reset(obs);
  const cx = await open(); const cy = await open();
  const rec = { scenario: name, first: X.name, second: Y.name, firstEnds, expectBlocked, status: 'FAIL' };
  try {
    await begin(cx); await X.lock(cx);
    await begin(cy);
    const pending = Y.lock(cy).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    let blocked;
    if (expectBlocked) blocked = await awaitBlocked(obs, cy, cx);
    else { await sleep(600); blocked = await isBlockedBy(obs, cy, cx); }
    rec.blocked = blocked;
    rec.firstResult = await X.finish(cx);
    await cx.query(firstEnds === 'COMMIT' ? 'COMMIT' : 'ROLLBACK');
    const got = await pending;
    if (!got.ok) { rec.error = String(got.error.code ?? got.error.message); await cy.query('ROLLBACK').catch(() => {}); return rec; }
    rec.secondResult = await Y.finish(cy);
    await cy.query('COMMIT');
    rec.status = blocked === expectBlocked ? 'PASS' : 'FAIL';
  } catch (error) {
    rec.error = String(error.code ?? error.message);
    await cx.query('ROLLBACK').catch(() => {}); await cy.query('ROLLBACK').catch(() => {});
  } finally { await cx.end().catch(() => {}); await cy.end().catch(() => {}); }
  return rec;
}
const q = async (obs, sql, p = []) => (await obs.query(sql, p)).rows;

// invariants evaluated on committed state after BOTH transactions ended
const INV = {
  noDutyBeyondEmploymentEnd: async (o) => (await q(o, `SELECT 1 FROM membership m JOIN duty d ON d.id=m.duty_id JOIN employee e ON e.id=m.employee_id
    WHERE m.state='ACTIVE' AND d.removed=false AND e.emp_end IS NOT NULL AND d.duty_date > e.emp_end`)).length === 0,
  noActiveMembershipOnDeactivated: async (o) => (await q(o, `SELECT 1 FROM membership m JOIN employee e ON e.id=m.employee_id
    WHERE m.state='ACTIVE' AND e.status<>'ACTIVE'`)).length === 0,
  noOrphanMembership: async (o) => (await q(o, `SELECT 1 FROM membership m JOIN duty d ON d.id=m.duty_id
    WHERE m.state='ACTIVE' AND d.removed=false AND NOT EXISTS (SELECT 1 FROM monthly_link l WHERE l.employee_id=m.employee_id
      AND l.project_id=d.project_id AND l.month=date_trunc('month', d.duty_date)::date)`)).length === 0,
  noDutyOnInactiveProject: async (o) => (await q(o, `SELECT 1 FROM duty d JOIN project p ON p.id=d.project_id WHERE d.removed=false AND p.status<>'ACTIVE'`)).length === 0,
  dutySnapshotCurrent: async (o) => (await q(o, `SELECT 1 FROM duty d WHERE d.cfg_seen <> (SELECT count(*) FROM shift_cfg WHERE project_id=d.project_id)
    AND EXISTS (SELECT 1 FROM shift_cfg WHERE project_id=d.project_id)`)).length === 0 ? true : 'DUTY_SNAPSHOT_STALE',
  noOverlap: async (o) => (await q(o, `SELECT 1 FROM membership a JOIN duty da ON da.id=a.duty_id JOIN membership b ON b.employee_id=a.employee_id AND b.id<a.id
    JOIN duty db ON db.id=b.duty_id WHERE da.s < db.e AND db.s < da.e`)).length === 0,
  publishCountMatchesCommittedBefore: async (o) => true,
};

const PAIRS = [
  ['E-barrier: staffed Duty create vs Employment PATCH (D5)', () => dutyCreate({ id: 1, emp: 1 }), () => empPatchEnd(), 'noDutyBeyondEmploymentEnd', true],
  ['E-barrier: staffed Duty create vs Employee deactivation (D5 guard)', () => dutyCreate({ id: 1, emp: 1 }), () => empDeactivate(), 'noActiveMembershipOnDeactivated', true],
  ['D2: staffed Duty create vs monthly assignment DELETE', () => dutyCreate({ id: 1, emp: 1 }), () => linkDelete(), 'noOrphanMembership', true],
  ['D4: empty Duty create vs Project deactivation', () => dutyCreate({ id: 1 }), () => projectDeactivate(), 'noDutyOnInactiveProject', true],
  ['D3: empty Duty create vs Shift configuration PATCH', () => dutyCreate({ id: 1 }), () => shiftPatch(), 'dutySnapshotCurrent', true],
  ['L: Duty create vs initial publish', () => dutyCreate({ id: 1 }), () => publish(), null, true],
  ['E: two staffing writes, same employee, overlapping UTC', () => dutyCreate({ id: 1, emp: 1, s: 10, e: 20 }), () => dutyCreate({ id: 2, emp: 1, s: 15, e: 25 }), 'noOverlap', true],
];

async function runPairs(obs) {
  for (const [name, mk1, mk2, inv, expectBlocked] of PAIRS) {
    for (const order of ['A_FIRST', 'B_FIRST']) {
      for (const ends of ['COMMIT', 'ROLLBACK']) {
        const [X, Y] = order === 'A_FIRST' ? [mk1(), mk2()] : [mk2(), mk1()];
        const rec = await race(obs, name, X, Y, ends, expectBlocked);
        rec.order = order;
        if (inv) { const v = await INV[inv](obs); rec.invariant = inv; rec.invariantHolds = v === true; if (v !== true) rec.status = 'FAIL'; }
        if (name.startsWith('L:')) {
          // PROVEN (lock semantics only): publish-time count equals the Duties committed before publish took L.
          const created = [rec.firstResult, rec.secondResult].find((r) => r?.startsWith('PUBLISHED_COUNT_'));
          const creatorFirst = X.name.startsWith('DUTY_CREATE');
          const expected = creatorFirst && ends === 'COMMIT' ? 1 : 0;
          rec.assertion = `publish-time count == Duties committed before publish held L (expected ${expected})`;
          if (created !== `PUBLISHED_COUNT_${expected}`) rec.status = 'FAIL';
          // OBSERVED final committed state, recorded explicitly (no business rule is asserted here).
          const fin = (await q(obs, `SELECT p.state, p.published_count,
              (SELECT count(*)::int FROM duty d WHERE d.plan_id=1 AND d.removed=false) AS live_duties FROM plan p WHERE p.id=1`))[0];
          rec.finalState = { planState: fin.state, publishedCount: fin.published_count, liveDuties: fin.live_duties };
          rec.dutyCommittedAfterPublish = fin.state === 'PUBLISHED' && fin.live_duties !== fin.published_count;
          // NOT_PROVEN: whether "PUBLISHED with a Duty committed after the publish snapshot" is a legal final state
          // depends on the Draft/Publish/Re-Publish contract (CR-03 source not available to this review). The synthetic
          // plan has no version/ownership model, so this is classified, not decided, and never turned into a pass/fail rule.
          rec.lifecycleInvariant = 'NOT_PROVEN_CONTRACT_UNDECIDED';
        }
        // after a ROLLBACK of the first writer the second must never observe a phantom dependency
        if (ends === 'ROLLBACK' && /REFUSED_(DUTY_DEPENDENCY|OVERLAP)/.test(String(rec.secondResult))) { rec.status = 'FAIL'; rec.note = 'phantom dependency'; }
        results.push(rec);
      }
    }
  }
}

async function controls(obs) {
  // C1: FK KEY SHARE alone does not block project NO KEY UPDATE (explicit P barrier is required)
  await reset(obs);
  {
    const a = await open(); const b = await open();
    await begin(a); await a.query(`INSERT INTO duty(id,plan_id,project_id,duty_date,s,e,cfg_seen) VALUES (9,1,1,'2026-12-10',1,2,0)`);
    await begin(b);
    const pend = b.query('SELECT 1 FROM project WHERE id=1 FOR NO KEY UPDATE').then(() => 'DONE', () => 'ERR');
    await sleep(600); const blocked = await isBlockedBy(obs, b, a);
    await a.query('ROLLBACK'); await pend; await b.query('ROLLBACK');
    results.push({ scenario: 'CONTROL FK-only: child INSERT vs parent NO KEY UPDATE', expectBlocked: false, blocked, status: blocked === false ? 'PASS' : 'FAIL' });
    await a.end(); await b.end();
  }
  // C2: pre-wait CTE snapshot is STALE (negative control), fresh statement after wait is correct
  for (const ends of ['COMMIT', 'ROLLBACK']) {
    await reset(obs);
    const a = await open(); const b = await open();
    await begin(a); await dutyCreate({ id: 1, emp: 1 }).lock(a);
    await begin(b);
    const stale = b.query(`WITH l AS (SELECT id FROM employee WHERE id=1 FOR UPDATE)
      SELECT (SELECT count(*) FROM membership WHERE employee_id=1)::int AS n FROM l`).then((r) => r.rows[0].n);
    const blocked = await awaitBlocked(obs, b, a);
    await dutyCreate({ id: 1, emp: 1 }).finish(a); await a.query(ends);
    const staleN = await stale;
    const freshN = (await b.query('SELECT count(*)::int n FROM membership WHERE employee_id=1')).rows[0].n;
    await b.query('ROLLBACK');
    const expectFresh = ends === 'COMMIT' ? 1 : 0;
    results.push({ scenario: 'CONTROL same-CTE lock+scan vs separate post-wait statement', firstEnds: ends, blocked,
      staleCteCount: staleN, freshStatementCount: freshN, status: blocked && freshN === expectFresh ? 'PASS' : 'FAIL',
      note: `observed same-CTE count=${staleN} (stale if blocker committed and value is 0)` });
    await a.end(); await b.end();
  }
}

async function twoPartyDeadlock(obs, name, orderT1, orderT2, expectDeadlock) {
  await reset(obs);
  const t1 = await open(); const t2 = await open();
  // Each transaction runs its own sequence; staggered starts make the first locks interleave.
  const run = async (c, steps, delay) => {
    await sleep(delay);
    await begin(c);
    try {
      await c.query(steps[0]); await sleep(400); await c.query(steps[1]);
      await c.query('COMMIT'); return 'OK';
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); return e.code ?? e.message; }
  };
  const [o1, o2] = await Promise.all([run(t1, orderT1, 0), run(t2, orderT2, 150)]);
  const deadlocks = [o1, o2].filter((x) => x === '40P01').length;
  results.push({ scenario: name, outcomes: [o1, o2], expectDeadlock, deadlocks,
    status: expectDeadlock ? (deadlocks === 1 && [o1, o2].includes('OK') ? 'PASS' : 'FAIL') : (deadlocks === 0 && o1 === 'OK' && o2 === 'OK' ? 'PASS' : 'FAIL') });
  await t1.end(); await t2.end();
}

async function auditRollback(obs) {
  await reset(obs);
  const c = await open(); await begin(c);
  await c.query(`INSERT INTO duty(id,plan_id,project_id,duty_date,s,e,cfg_seen) VALUES (1,1,1,'2026-12-10',1,2,0)`);
  await c.query(`INSERT INTO membership(id,duty_id,employee_id) VALUES (1,1,1)`);
  let failed = false;
  try { await c.query(`INSERT INTO audit(n) VALUES (NULL)`); } catch { failed = true; }
  await c.query('ROLLBACK'); await c.end();
  const left = (await q(obs, `SELECT (SELECT count(*) FROM duty)::int d, (SELECT count(*) FROM membership)::int m`))[0];
  results.push({ scenario: 'Audit failure after memberships rolls back snapshot and memberships', auditFailed: failed, remaining: left,
    status: failed && left.d === 0 && left.m === 0 ? 'PASS' : 'FAIL' });
}

let exit = 1; let obs;
try {
  obs = await open();
  const ver = (await q(obs, `SELECT current_setting('server_version_num')::int v, current_setting('server_version') s`))[0];
  const major = Math.floor(ver.v / 10000);
  const meta = { suite: 'SP11A-R1 LOCK-01 proof', server_version: ver.s, major, conformant: major === 17, schema: SCHEMA,
    isolation: (await q(obs, `SELECT current_setting('default_transaction_isolation') i`))[0].i };
  if (major !== 17) throw new Error(`PG17 required, got ${ver.s}`);
  await obs.query(`CREATE SCHEMA ${SCHEMA}`); await obs.query(`SET search_path TO ${SCHEMA}`);
  for (const c of clients) await c.query(`SET search_path TO ${SCHEMA}`);
  await obs.query(`
    CREATE TABLE account(id int PRIMARY KEY, status text);
    CREATE TABLE employee(id int PRIMARY KEY, status text NOT NULL, emp_end date);
    CREATE TABLE project(id int PRIMARY KEY, status text NOT NULL);
    CREATE TABLE monthly_link(id int PRIMARY KEY, employee_id int REFERENCES employee, project_id int REFERENCES project, month date, UNIQUE(employee_id, month));
    CREATE TABLE plan(id int PRIMARY KEY, project_id int REFERENCES project, month date, state text, published_count int);
    CREATE TABLE duty(id int PRIMARY KEY, plan_id int REFERENCES plan, project_id int REFERENCES project, duty_date date, s int, e int, cfg_seen int, removed boolean NOT NULL DEFAULT false);
    CREATE TABLE membership(id int PRIMARY KEY, duty_id int REFERENCES duty, employee_id int REFERENCES employee, state text NOT NULL DEFAULT 'ACTIVE');
    CREATE TABLE shift_cfg(id serial PRIMARY KEY, project_id int REFERENCES project);
    CREATE TABLE audit(n int NOT NULL);`);
  await runPairs(obs);
  await controls(obs);
  await twoPartyDeadlock(obs, 'FORBIDDEN order L->E (publish) vs E->L (duty create) deadlocks',
    ['SELECT 1 FROM plan WHERE id=1 FOR UPDATE', 'SELECT 1 FROM employee WHERE id=1 FOR NO KEY UPDATE'],
    ['SELECT 1 FROM employee WHERE id=1 FOR NO KEY UPDATE', 'SELECT 1 FROM plan WHERE id=1 FOR SHARE'], true);
  await twoPartyDeadlock(obs, 'PROTOCOL order E->L for both: no deadlock',
    ['SELECT 1 FROM employee WHERE id=1 FOR NO KEY UPDATE', 'SELECT 1 FROM plan WHERE id=1 FOR UPDATE'],
    ['SELECT 1 FROM employee WHERE id=1 FOR NO KEY UPDATE', 'SELECT 1 FROM plan WHERE id=1 FOR SHARE'], false);
  await twoPartyDeadlock(obs, 'CURRENT order employee->linked account vs self-service account->employee deadlocks (model)',
    ['SELECT 1 FROM employee WHERE id=1 FOR UPDATE', 'SELECT 1 FROM account WHERE id=1 FOR UPDATE'],
    ['SELECT 1 FROM account WHERE id=1 FOR SHARE', 'SELECT 1 FROM employee WHERE id=1 FOR UPDATE'], true);
  await twoPartyDeadlock(obs, 'PROPOSED account-prefix order account->employee for both: no deadlock',
    ['SELECT 1 FROM account WHERE id=1 FOR UPDATE', 'SELECT 1 FROM employee WHERE id=1 FOR UPDATE'],
    ['SELECT 1 FROM account WHERE id=1 FOR SHARE', 'SELECT 1 FROM employee WHERE id=1 FOR UPDATE'], false);
  await auditRollback(obs);
  const failed = results.filter((r) => r.status !== 'PASS');
  const notProven = results.filter((r) => r.lifecycleInvariant);
  const afterPublish = results.filter((r) => r.dutyCommittedAfterPublish).length;
  writeFileSync(OUT, JSON.stringify({ ...meta, total: results.length, passed: results.length - failed.length, failed: failed.length,
    lifecycleNotProven: notProven.length, schedulesWithDutyCommittedAfterPublish: afterPublish, results }, null, 2));
  console.log(`LOCK01_PROOF server=${ver.s} total=${results.length} passed=${results.length - failed.length} failed=${failed.length} (PASS = synthetic lock semantics only)`);
  console.log(`LOCK01_PROOF lifecycle=NOT_PROVEN_CONTRACT_UNDECIDED schedules=${notProven.length} dutyCommittedAfterPublish=${afterPublish}`);
  for (const r of notProven) console.log(`NOT_PROVEN | ${r.order} ${r.first}->${r.second} ${r.firstEnds} | final=${JSON.stringify(r.finalState)}`);
  for (const r of results) console.log(`${r.status} | ${r.scenario} | ${r.order ?? ''} ${r.firstEnds ?? ''} | blocked=${r.blocked ?? ''} | ${r.firstResult ?? ''}/${r.secondResult ?? ''}${r.invariant ? ` inv=${r.invariantHolds}` : ''}${r.error ? ` err=${r.error}` : ''}`);
  exit = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error('LOCK01_PROOF aborted:', error.message, error.stack?.split('\n')[1]);
} finally {
  for (const c of clients) await c.end().catch(() => {});
  if (/^lock01_proof_[0-9a-f]{8}$/.test(SCHEMA)) {
    const cleaner = new pg.Client({ connectionString: process.env.DATABASE_URL });
    try { await cleaner.connect(); await cleaner.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } catch { /* reported by CI log */ }
    await cleaner.end().catch(() => {});
  }
}
process.exit(exit);
