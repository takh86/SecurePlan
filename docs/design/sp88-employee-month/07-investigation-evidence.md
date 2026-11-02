# SP-88 / SP-90 revision evidence - 2026-11-02

This section records the revision mission. The original investigation/stand-in
probe below is historical evidence at5467e21, not rerun or acceptance of the new
rules. Revised business behavior is approved direction; detailed design remains
P1-P6/T1-T4 pending. No runtime/backend/frontend/migration/CI file change.

## Revision investigation and safe Git checks

Ran `git status --short`, `git branch --show-current`, `git worktree list`,
`git branch -avv`, `git remote -v`, `git fetch origin`, and
`git log -1 --format='%H %s' origin/main`. Fetched origin/main remains
13b680c07929ae595c196a523a32d4226bfa8e64. Existing design branch reused from5467e21.
Initial tracked worktree clean; untracked local AGENTS.md never staged. Primary
main/worktree, SP-13 e30db8f, #87 662985e and Claude #91 f61b547 preserved.
No reset/discard/force-push/merge/deploy performed.

Read latest GitHub issue88/90 bodies/comments and PR86/87/89/91 metadata/comments
through connector; compact comment bodies included owner corrections/paint review.
All four PRs open/unmerged at inspection; #89/#91 Draft. #91 base is #87 branch.
Read Claude's current handoff/worktree read-only; frontend unchanged here.
Open issue inventory obtained read-only via:
`gh issue list --repo takh86/SecurePlan --state open --limit 100 --json number,title,url`.
Two connector list-issues calls had argument-binding errors; CLI read succeeded.
No issue metadata was changed by those reads.

Rechecked actual0007/0009/0011/0012, shift-config service/guard/planning dependencies,
monthly-plans service/error catalogue and ADR-0006; #86 code/migration read via
`git show` without switching branches. Existing controlled source register retained;
public historical roadmap remains explicitly historical, not current acceptance.
Some guessed read paths and an initial patch hunk failed without application
changes; corrected via rg enumeration and bounded file edits. Windows pipe
encoding artifacts in draft prose were corrected and checked before delivery.
No implementation or DB experiment was attempted. Future tests must use actual
application migrations/tables with verified disposable PostgreSQL.

## Revision checks and exact scope

| Command/check | Actual result |
|---|---|
| `node .env.sp88-runtime/verify-revision.mjs` | PASS:11 Markdown files,33 relative links,5 parsed JSON examples,81 unique acceptance rows,30-day November exclusive request,receipt/removal counts,forecast sums/19 Mo-Thu capacity days,unchanged old probe hash |
| `npm run check:public` | First attempt blocked by sandbox spawnSync git EPERM; separately rerun with read-only Git access PASS exit0 |
| `git diff --check` | PASS exit0; only normal configured LF-to-CRLF notices |
| `git diff --name-only -- apps scripts infra package.json package-lock.json .github` | Empty runtime/test/dependency/infra/workflow diff |
| Staged-path/branch/ancestry verification before commit | Required:11 design Markdown paths only; AGENTS.md excluded; #86/#87/#91 heads unchanged |
| Lint/typecheck/build/unit/E2E/migration/browser locally | NOT_RUN for this docs-only revision; no revised application behavior exists |
| New calendar/exclusivity/batch/Publish acceptance | NOT_RUN;81 planned rows and120 concurrency schedules are not executed tests |
| Exact revised-head Foundation CI | Report final state/run in PR89; baseline regression only, never proof of new rules |

The probe14/14 and Foundation CI362 unit/607 frontend/34 scripts/1135 PG E2E below
belong to the earlier design head. No reuse of that run as revised-head CI.
No development/production database or fixture was touched in this revision.

# SP-88 design investigation evidence

Date: 2026-11-02. Design base:
`13b680c07929ae595c196a523a32d4226bfa8e64`. This record separates observations,
experiments and unexecuted acceptance. No runtime application change is included.

## Git and source investigation

Commands ran from the assigned Codex worktree, with Git metadata/network access
authorized through the sandbox where required:

```powershell
git status --short
git worktree list --porcelain
git branch -avv
git remote -v
git fetch origin
git rev-parse origin/main
git diff --quiet
git diff --cached --quiet
git switch --create agent/codex/sp88-employee-month-design origin/main
git branch --show-current
git log -1 --oneline
```

Result: no tracked modifications; the local untracked AGENTS.md remained in
place. Latest fetched origin/main was the base SHA above. SP-13 and Claude's
branches/worktrees were preserved. GitHub APIs inspected #88/#85 and comments,
#86/#87 metadata and changed paths, #87 review comments and exact-head CI. The
source register records revisions and conclusions, including the owner's
superseding atomic-save decision.

Repository inspection used `rg --files`, `rg -n`, `Get-Content -Encoding utf8`
and `git show <foundation-branch>:<path>` for the actual services, migrations,
DTOs, guards, lease controller, draft model and UI/client integration. Controlled
DOCX paragraphs were read directly through .NET ZipArchive/XML, without copying
private originals into Git. Phase 2 PDF extraction used MiKTeX `pdftotext -layout`
read-only; sandbox elevation was needed for its own local application log.
Some initial guessed paths were corrected with repository enumeration; they were
read failures, not product/test failures. Current final files are cross-linked.

## Verified disposable PostgreSQL experiment

Purpose: check UPDATE/SHARE admission, absence observations after waits,
conditional versions, and all-or-nothing rollback on real PostgreSQL. This uses
**stand-in tables**, not NestJS, SecurePlan migrations, HTTP, workforce guards,
leases or real duty aggregates. It cannot prove SP-88 business acceptance,
tenant/security correctness or absence of application deadlocks.

Created a fresh `postgres:17` container with a unique label, tmpfs PGDATA and only
`127.0.0.1:55488` exposed. No Compose development service, existing volume or
development/production connection was used. Run identity:
`sp88-design-20261102-da888a7b`, container prefix `1959bcaef1ce`.
Server: `17.11 (Debian 17.11-1.pgdg13+2)`; Node `v24.21.0`.

The existing `scripts/disposable-test-target.mjs record` verified the exact full
container ID, label, image, tmpfs, loopback binding, DB/role/version and cluster
identity **before any schema/fixture write**. The probe reverified the recorded
cluster immediately before execution. Receipt/connection/password remained in
ignored local runtime files; none is published here.

Exact executed commands after creating the target:

```powershell
& '.env.sp88-runtime/run.ps1' -Task record
& '.env.sp88-runtime/run.ps1' -Task probe
Get-FileHash -Algorithm SHA256 -LiteralPath '.env.sp88-runtime/probe.mjs'
```

The local wrapper sets only the explicitly created target connection, container
ID, run ID and receipt, then calls respectively:

```text
node scripts/disposable-test-target.mjs record
node .env.sp88-runtime/probe.mjs
```

Final probe source SHA-256:
`0ac85e4305cb543f14f558cc6a294449027fee7b05c9e91369db82e589eaf42f`.
The complete sanitized source is reproduced below for review/reproduction.

| Final probe group | Cases | Result / exact scope |
|---|---:|---|
| Plan SHARE/UPDATE, both first modes × COMMIT/ROLLBACK | 4 | PASS; observed blocker via pg_blocking_pids; fresh later duty version |
| Initially absent slot, creator/batch first × COMMIT/ROLLBACK | 4 | PASS; later read observes committed existence or rolled-back absence; one live stand-in slot |
| Conditional duty version, actual reversed client order × COMMIT/ROLLBACK | 4 | PASS; stale predicate affects zero rows after commit; succeeds after rollback |
| Three updates plus earlier audit, then audit CHECK or late division-by-zero failure | 2 | PASS; all versions and audit restored by rollback |
| **Final total** | **14** | **14 passed, 0 failed; applicationAcceptance=NOT_PROVEN** |

An intermediate harness run terminated after 8 passes with PostgreSQL 55P03:
the harness requested a backend PID on a connection behind its own blocked
statement. It was corrected to use the PIDs obtained before queuing that
statement. An earlier preliminary run did not physically reverse clients in its
second version-order labels; it is superseded, not credited as additional proof.
The final source above actually reverses clients and completed all 14 checks.
These are harness corrections, not SecurePlan application test results. The
outer PowerShell command of the failed attempt also ran Get-FileHash afterwards,
so its exit 0 was not proof of probe success; the final probe was run separately
and exited 0 with the full summary below.

```text
SP88_EXPLORATORY_PG total=14 passed=14 failed=0 applicationAcceptance=NOT_PROVEN
```

Reproduction must create and verify its **own** fresh target/receipt first,
following [the disposable test instructions](../../testing/disposable-postgres.md).
Save the appendix as `.env.sp88-runtime/probe.mjs` so its relative import resolves,
set the verified explicit environment and run `node` as above. It creates and
truncates only its own `sp88_design_proof` stand-in tables. Never point it at a
shared instance or treat a hostname alone as identity verification.

Cleanup: PASS. After a read-only `node scripts/disposable-test-target.mjs`
cluster recheck and Docker inspection matching the full ID, exact run label,
image, tmpfs and loopback binding, executed `docker stop --time 5` and `docker rm`
against only that exact container ID. The experiment container was stopped and
removed; unrelated/SP-13/development containers were not targeted. Docker warned
that `--time` is deprecated in favor of `--timeout`; both cleanup steps exited 0.

## Design-only verification ledger

The final PR description and CI run provide the final-head verification result.
Local completion checks for this package are:

| Command / check | Local result |
|---|---|
| `git diff --check`; `git diff --cached --check` | PASS; only eight design Markdown files staged, local AGENTS.md left untracked |
| `npm run check:public` | PASS; current tracked and non-ignored untracked text passed the limited publication check |
| `node .env.sp88-runtime/verify-docs.mjs` | PASS: 8 Markdown files, 15 resolving relative links, 3 parsed JSON examples, 58 acceptance rows; complete 28-day request/counts and appendix SHA-256 match |
| `git diff --name-only origin/main -- apps scripts infra package.json package-lock.json .github` | Empty: no tracked runtime, test, dependency, infrastructure or workflow change |
| Exact-head Foundation CI | PENDING at artifact authoring; final PR/report records it as baseline regression evidence, not SP-88 implementation tests |

Backend/frontend lint, typecheck, builds, unit suites, database application E2E,
forward migration/replay/catalogue and integrated browser tests were **NOT_RUN
locally for this design-only change**. No migration is introduced and no new
application test can exercise an unimplemented endpoint. Their exact future
gates are in the acceptance matrix. Existing foundation CI remains independently
identified in the source review; don't import its counts as tests of this design.

The design logical argument depends on all application writers honoring L1 and
the existing workforce parent locks. The experiment cannot validate those
integration assumptions. PR A's real canonical-table/HTTP races, security/audit
approval, human UX, combined Publish flow and remaining MVP/release gates are
still outstanding.

## Appendix — executed exploratory source

```javascript
import assert from 'node:assert/strict';
import pg from 'pg';
import { verifyRecordedTestTarget } from '../scripts/disposable-test-target.mjs';

// Exploratory PostgreSQL semantics, deliberately NOT SecurePlan application tests.
await verifyRecordedTestTarget();
const clients = Array.from({ length: 3 }, () => new pg.Client({ connectionString: process.env.DATABASE_URL }));
await Promise.all(clients.map((client) => client.connect()));
const [a, b, observer] = clients;
let passed = 0;
let failed = 0;
const failures = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pid = async (client) => Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
const aPid = await pid(a);
const bPid = await pid(b);
const begin = (client) => client.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'");
const planLock = (client, mode) => client.query(`SELECT id FROM sp88_design_proof.plan WHERE id=1 FOR ${mode}`);
const reset = async (count = 1) => {
  await observer.query('TRUNCATE sp88_design_proof.audit, sp88_design_proof.duty, sp88_design_proof.plan');
  await observer.query('INSERT INTO sp88_design_proof.plan VALUES (1)');
  for (let index = 1; index <= count; index++) {
    await observer.query('INSERT INTO sp88_design_proof.duty VALUES ($1,1)', [index]);
  }
};
async function blocked(blockerPid = aPid, waitingPid = bPid) {
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    const row = (await observer.query('SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked', [blockerPid, waitingPid])).rows[0];
    if (row.blocked) return;
    await pause(10);
  }
  throw new Error('Expected PostgreSQL blocking was not observed');
}
async function test(name, work) {
  try { await work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; failures.push({ name, error: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
  finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); }
}
try {
  const version = (await observer.query('SHOW server_version')).rows[0].server_version;
  console.log(`SP88_EXPLORATORY_PG server=${version}`);
  await observer.query(`CREATE SCHEMA IF NOT EXISTS sp88_design_proof;
    CREATE TABLE IF NOT EXISTS sp88_design_proof.plan(id int PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS sp88_design_proof.duty(slot int PRIMARY KEY, version int NOT NULL CHECK(version>0));
    CREATE TABLE IF NOT EXISTS sp88_design_proof.audit(ok boolean NOT NULL CHECK(ok))`);

  for (const firstMode of ['SHARE', 'UPDATE']) {
    for (const outcome of ['COMMIT', 'ROLLBACK']) {
      await test(`plan-${firstMode.toLowerCase()}-first-${outcome.toLowerCase()}-fresh-read`, async () => {
        await reset(); await begin(a); await begin(b);
        await planLock(a, firstMode);
        await a.query('UPDATE sp88_design_proof.duty SET version=2 WHERE slot=1');
        const waiting = planLock(b, firstMode === 'SHARE' ? 'UPDATE' : 'SHARE');
        await blocked(); await a.query(outcome); await waiting;
        const versionNow = (await b.query('SELECT version FROM sp88_design_proof.duty WHERE slot=1')).rows[0].version;
        assert.equal(versionNow, outcome === 'COMMIT' ? 2 : 1);
        await b.query('COMMIT');
      });
    }
  }
  for (const firstMode of ['SHARE', 'UPDATE']) {
    for (const outcome of ['COMMIT', 'ROLLBACK']) {
      await test(`absent-slot-${firstMode.toLowerCase()}-first-${outcome.toLowerCase()}`, async () => {
        await reset(0); await begin(a); await begin(b);
        await planLock(a, firstMode);
        await a.query('INSERT INTO sp88_design_proof.duty VALUES (1,1)');
        const waiting = planLock(b, firstMode === 'SHARE' ? 'UPDATE' : 'SHARE');
        await blocked(); await a.query(outcome); await waiting;
        const current = await b.query('SELECT slot FROM sp88_design_proof.duty WHERE slot=1');
        assert.equal(current.rowCount, outcome === 'COMMIT' ? 1 : 0);
        if (current.rowCount === 0) await b.query('INSERT INTO sp88_design_proof.duty VALUES (1,1)');
        await b.query('COMMIT');
        assert.equal((await observer.query('SELECT * FROM sp88_design_proof.duty')).rowCount, 1);
      });
    }
  }
  for (const actorOrder of ['admin-a-first', 'admin-b-first']) {
    for (const outcome of ['COMMIT', 'ROLLBACK']) {
      await test(`version-${actorOrder}-${outcome.toLowerCase()}`, async () => {
        const [first, second] = actorOrder === 'admin-a-first' ? [a, b] : [b, a];
        await reset(); await begin(first); await begin(second);
        await planLock(first, 'SHARE'); await planLock(second, 'SHARE');
        assert.equal((await first.query('UPDATE sp88_design_proof.duty SET version=version+1 WHERE slot=1 AND version=1')).rowCount, 1);
        const waiting = second.query('UPDATE sp88_design_proof.duty SET version=version+1 WHERE slot=1 AND version=1');
        await blocked(first === a ? aPid : bPid, second === a ? aPid : bPid); await first.query(outcome);
        assert.equal((await waiting).rowCount, outcome === 'COMMIT' ? 0 : 1);
        await second.query('COMMIT');
        assert.equal((await observer.query('SELECT version FROM sp88_design_proof.duty')).rows[0].version, 2);
      });
    }
  }
  for (const fault of ['audit', 'late-sql']) {
    await test(`three-writes-${fault}-failure-rolls-back`, async () => {
      await reset(3); await begin(a); await planLock(a, 'UPDATE');
      for (const slot of [1, 2, 3]) await a.query('UPDATE sp88_design_proof.duty SET version=2 WHERE slot=$1', [slot]);
      await a.query('INSERT INTO sp88_design_proof.audit VALUES (true)');
      await assert.rejects(a.query(fault === 'audit'
        ? 'INSERT INTO sp88_design_proof.audit VALUES (false)'
        : 'SELECT 1/0'), (error) => error.code === (fault === 'audit' ? '23514' : '22012'));
      await a.query('ROLLBACK');
      assert.deepEqual((await observer.query('SELECT version FROM sp88_design_proof.duty ORDER BY slot')).rows.map((row) => row.version), [1, 1, 1]);
      assert.equal((await observer.query('SELECT * FROM sp88_design_proof.audit')).rowCount, 0);
    });
  }
  console.log(`SP88_EXPLORATORY_PG total=${passed + failed} passed=${passed} failed=${failed} applicationAcceptance=NOT_PROVEN`);
  if (failures.length) process.exitCode = 1;
} finally {
  await Promise.all(clients.map((client) => client.end()));
}
```

## Revision document validator source

Reproduce by saving this block to the ignored local path shown in the command;
it checks design examples and historical probe integrity, not application behavior.

```mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
const root = 'docs/design/sp88-employee-month';
const files = readdirSync(root).filter(n => n.endsWith('.md')).map(n => `${root}/${n}`);
files.push('docs/design/sp90-project-operating-weekdays.md');
assert.equal(files.length, 11);
let links = 0, examples = 0;
const parsed = [];
for (const path of files) {
  const text = readFileSync(path, 'utf8');
  assert.notEqual(text.charCodeAt(0), 0xfeff, `${path}: BOM`);
  assert.equal([...text.matchAll(/^```[^\r\n]*$/gm)].length % 2, 0, `${path}: fence`);
  assert.ok(!/\d\?\d|N\?chste|BR-1\?/.test(text), `${path}: encoding`);
  for (const [, link] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^https?:|^#/.test(link)) continue;
    assert.ok(existsSync(resolve(dirname(path), link.split('#')[0])), `${path}: ${link}`);
    links++;
  }
  for (const [, json] of text.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    parsed.push(JSON.parse(json)); examples++;
  }
}
assert.equal(examples, 5);
const request = parsed.find(x => x.days);
assert.equal(request.days.length, 30);
assert.equal(new Set(request.days.map(x => x.date)).size, 30);
assert.match(request.expectedCreationContext, /^[a-f0-9]{64}$/);
request.days.forEach((day, i) => {
  assert.equal(day.date, `2026-11-${String(i + 1).padStart(2, '0')}`);
  assert.deepEqual(Object.keys(day.expected).sort(), ['day', 'night']);
  assert.ok(['OFF', 'DAY', 'NIGHT'].includes(day.desired.state));
  assert.deepEqual(Object.keys(day.desired).sort(), day.desired.state === 'OFF' ? ['state'] : ['role', 'state']);
});
assert.deepEqual(request.days.filter(x => x.desired.state === 'DAY').map(x => Number(x.date.slice(-2))), [1,2,10]);
assert.deepEqual(request.days.filter(x => x.desired.state === 'NIGHT').map(x => Number(x.date.slice(-2))), [17,19]);
assert.equal(request.days[4].desired.state, 'OFF');
assert.equal(request.days[4].expected.day.version, 7);
const result = parsed.find(x => x.outcome === 'APPLIED');
assert.deepEqual(result.counts, {createdDuties:5,changedDuties:1,addedMemberships:5,removedMemberships:1,updatedMemberships:0});
assert.equal(result.changes.length, 6);
assert.equal(result.changes.find(x => x.date === '2026-11-05').assignment, null);
for (const c of result.changes) assert.ok(Date.parse(c.endsAt) > Date.parse(c.startsAt));
const error = parsed.find(x => x.code === 'EMPLOYEE_MONTH_SAVE_CONFLICT');
assert.equal(error.conflicts[0].date, '2026-11-01');
assert.equal(error.conflicts[0].reason, 'PROJECT_CLOSED_WEEKDAY');
assert.equal(new Date('2026-11-01T00:00:00Z').getUTCDay(), 0);
const patch = parsed.find(x => 'bootstrap' in x);
assert.ok('expectedNextEffectiveFromMonth' in patch);
assert.deepEqual(patch.operatingWeekdays, [1,2,3,4,5,6]);
const acceptance = readFileSync(`${root}/05-acceptance-and-delivery.md`, 'utf8');
let rows = 0;
for (const [prefix, count] of [['F',26],['S',5],['C',30],['U',8],['G',12]]) {
  for (let i = 1; i <= count; i++) {
    const id = `${prefix}${String(i).padStart(2,'0')}`;
    assert.equal(acceptance.split(`| ${id} |`).length - 1, 1, id); rows++;
  }
}
assert.equal(rows, 81);
const evidence = readFileSync(`${root}/07-investigation-evidence.md`, 'utf8');
const appendix = /```javascript\n([\s\S]*?)\n```/.exec(evidence)[1];
const probe = readFileSync('.env.sp88-runtime/probe.mjs', 'utf8');
assert.equal(`${appendix}\n`, probe);
assert.ok(evidence.includes(createHash('sha256').update(probe).digest('hex')));
assert.equal([6,22,30,14,6,6,12,8].reduce((a,b)=>a+b),104);
assert.equal([10,34,46,22,10,10,20,14].reduce((a,b)=>a+b),166);
assert.equal([8,4,44,6,12,12].reduce((a,b)=>a+b),86);
assert.equal([14,8,72,10,20,18].reduce((a,b)=>a+b),142);
let days = 0;
for (let d = new Date('2026-11-03T00:00:00Z'); d <= new Date('2026-12-03T00:00:00Z'); d.setUTCDate(d.getUTCDate()+1)) {
  if ([1,2,3,4].includes(d.getUTCDay())) days++;
}
assert.equal(days,19);
console.log(`SP88_SP90_DOCS files=${files.length} relativeLinks=${links} jsonExamples=${examples} acceptanceRows=${rows} estimateSums=PASS capacityDays=${days} oldProbeHash=MATCH PASS`);
```
