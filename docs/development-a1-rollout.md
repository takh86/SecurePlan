# A1 development rollout and demo

Development only; manual admin API configuration is the A1 integration path.
There is no calendar admin UI or A2 month Save in this change. Migration 0014
seeds nothing: existing projects reject new assignments and First Publish until
explicitly configured. Existing entries remain readable. This runbook does not
authorize writes to any existing database, staging or production.

Since F-A1-2 the same GET/PATCH flow, including the one-time bootstrap, is also
available to COMPANY_ADMIN in the project page section „Betriebstage“
([review](reviews/sp90-calendar-ui.md)). It uses this contract unchanged and
changes none of the rollout prerequisites below; the API path remains valid.

## Reproduce on a disposable database

Prerequisites: Node 24, `npm ci`, Docker with `postgres:17`, repository root in
PowerShell, unused loopback port 55494 and unused container name below. Never
load `.env` for this rehearsal. Stop on any failed command. All example database
credentials below are synthetic and only for this disposable container.

```powershell
$ErrorActionPreference = 'Stop'
$run = 'sp92-demo-' + [guid]::NewGuid().ToString('N')
$name = $run
$id = docker run -d --name $name --label "secureplan.disposable-test=$run" --tmpfs /var/lib/postgresql/data:rw -e POSTGRES_USER=secureplan -e POSTGRES_PASSWORD=sp92-disposable-only -e POSTGRES_DB=secureplan -p 127.0.0.1:55494:5432 postgres:17
if ($LASTEXITCODE) { throw 'Container creation failed' }
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  docker exec $id pg_isready -U secureplan -d secureplan
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (!$ready) { throw 'Disposable PostgreSQL did not become ready' }
$env:DATABASE_URL = 'postgresql://secureplan:sp92-disposable-only@127.0.0.1:55494/secureplan'
$env:SECUREPLAN_TEST_CONTAINER_ID = $id.Trim()
$env:SECUREPLAN_TEST_RUN_ID = $run
$env:SECUREPLAN_TEST_TARGET_RECEIPT = Join-Path (Get-Location) '.env.a1-demo-target.json'
node scripts/disposable-test-target.mjs record
if ($LASTEXITCODE) { throw 'Target verification failed' }
node scripts/rehearse-legacy-calendar.mjs
if ($LASTEXITCODE) { throw 'Rehearsal failed; retain the disposable target for investigation' }
npm run test:e2e -- operating-calendar-real --maxWorkers=1 --testTimeout=15000
if ($LASTEXITCODE) { throw 'A1 guards failed' }
node scripts/scan-project-calendars.mjs
```

The rehearsal refuses a nonempty or unverified target. It applies 0001–0013,
commits synthetic pre-calendar fixtures, then runs the normal migrator for 0014.
It proves exact plan/duty/membership preservation, zero seeded policies,
read-only inventory, explicit historical bootstrap, retained empty/PUBLISHED
and dual DAY/NIGHT history, and actual HTTP calendar → plan → duty → First
Publish. Fixture policies are deliberately supplied Sunday, Saturday and
Tuesday sets; none is inferred from history. AppModule, guards, sessions, CSRF,
SQL and audit are real; outbound delivery/password checks use the test harness.
This is HTTP/PG acceptance, not browser or real-login acceptance.

Fixtures are removed by exact synthetic tenant after assertions. For inspection
of legacy data, the test asserts inventory before cleanup; the final CLI scan
therefore normally reports no projects. The additional A1 suite proves missing
and closed days, tenant/role/CSRF concealment, stale versions, observed writer
blocking in both orders, commit/rollback and late audit failure.

After testing, verify the container ID and its disposable label before removal:

```powershell
docker inspect --format '{{.Id}} {{index .Config.Labels "secureplan.disposable-test"}}' $id
# Must match $id and $run from this session. Remove only that container.
docker rm -f $id
Remove-Item Env:DATABASE_URL, Env:SECUREPLAN_TEST_CONTAINER_ID, Env:SECUREPLAN_TEST_RUN_ID, Env:SECUREPLAN_TEST_TARGET_RECEIPT
```

## Development integration order

1. Obtain the required PR review and green exact-head checks before integration.
2. Before touching an existing development database, obtain explicit target
   authorization and verify database/host/port/role and company time zone. Take
   a backup and verify restoration on a separate disposable target. No such
   existing-target rollout is performed by the rehearsal.
3. Stop/drain **all** old backend writers and background jobs before migration;
   old binaries do not enforce the new invariant. Do not mix old/new writers.
4. Apply immutable migrations with the normal migration runner, then replay
   checksums and run `scripts/verify-db.mjs`, using the explicitly selected
   `DATABASE_URL` only. Start only the A1-capable backend, keeping planning
   access gated until inventory and explicit configuration are reviewed.
5. Run `node scripts/scan-project-calendars.mjs` against that authorized target.
   Retain its output privately: IDs and month counts are operational data.
   `findings` reports live MISSING/CLOSED duty counts and dual employee/date
   groups. `projects` also includes projects with no duties, calendar-version
   count, company-local current month, earliest live duty month and all missing
   plan months. No findings alone is insufficient to declare readiness.
6. The admin supplies and accepts each complete weekday set. Historical
   bootstrap must cover **all** live duties, including retained empty and
   PUBLISHED rows; it records compatibility acceptance, not an inferred old
   policy. Do not generate a set from inventory or delete conflicting history.
7. With zero calendar versions, use `bootstrap:true` at exactly the earliest
   live duty month; with no live duties use the company-local current month.
   Complete this before inserting any ordinary future calendar version.
   Otherwise the one-time bootstrap becomes unavailable. Existing past calendar
   versions cannot be rewritten, including by a no-op.
8. Re-read inventory and calendars; confirm intended historical/current/future
   coverage. Resolve dual memberships only through separately authorized SP-12
   lease/version removal. Calendar bootstrap intentionally leaves them intact.
   Re-enable planning only for explicitly configured projects/months and run a
   synthetic demo through duty creation and First Publish.

An empty historical plan older than the earliest live duty (or a project with
no live duties at all) stays MISSING before the permitted bootstrap boundary.
It remains readable but First Publish stays blocked. Do not backdate SQL, delete
the plan, or promise retroactive publishing as a workaround. If development
requires publishing such plans, that use case needs a separate approved rule;
this is not covered by the current bootstrap contract.

## Sample admin API flow

Use the existing authenticated COMPANY_ADMIN session over trusted local HTTPS,
with its CSRF token and configured Origin. Set `$Base`, `$Origin`, `$Session`
(PowerShell WebRequestSession), `$Csrf`, `$Project`, `$Employee`, `$Month`, `$DemoMonth` and
`$DutyDate` from the authorized demo setup. Employee must be active, employed,
eligible, available and assigned to this project/month. Shift times must already
be explicitly configured via the existing shift-configuration API. `$Month`
is the reviewed bootstrap month above; `$DutyDate` belongs to a demo plan month
covered by that policy and must be an explicitly allowed weekday.

```powershell
function Api($Method, $Path, $Body = $null, $Extra = @{}) {
  $headers = @{ Origin = $Origin; 'X-CSRF-Token' = $Csrf }
  foreach ($key in $Extra.Keys) { $headers[$key] = $Extra[$key] }
  $requestArgs = @{ Method = $Method; Uri = "$Base/api/v1$Path"; WebSession = $Session; Headers = $headers }
  if ($null -ne $Body) { $requestArgs.ContentType = 'application/json'; $requestArgs.Body = ConvertTo-Json -Depth 8 -InputObject $Body }
  Invoke-RestMethod @requestArgs
}
$read = Api GET "/projects/$Project/operating-calendar?effectiveForMonth=$Month"
# Explicit example only: this demo project operates Tuesdays, ISO weekday 2.
# Replace with the actual admin-approved complete set; never apply a global default.
$effective = $null
if ($read.effective) { $effective = @{ id = $read.effective.id; version = $read.effective.version } }
$configured = Api PATCH "/projects/$Project/operating-calendar" @{
  effectiveFromMonth = $Month; operatingWeekdays = @(2); bootstrap = $true
  expectedExactVersion = $read.exactVersion; expectedEffective = $effective
  expectedNextEffectiveFromMonth = $read.nextEffectiveFromMonth
}
$plan = Api POST '/monthly-plans' @{ projectId = $Project; monthStart = $DemoMonth }
$duty = Api POST "/monthly-plans/$($plan.id)/entries" @{
  dutyDate = $DutyDate; shiftKind = 'DAY'
  assignments = @(@{ employeeId = $Employee; dutyRole = 'EMPLOYEE' })
}
$publishKey = [guid]::NewGuid().ToString()
$published = Api POST "/monthly-plans/$($plan.id)/publish" $null @{ 'Idempotency-Key' = $publishKey }
Api GET "/monthly-plans/$($plan.id)/entries"
```

Set `$DemoMonth` explicitly (current/future and covered by the calendar); for an
existing plan use its ID from GET `/monthly-plans?projectId=...&monthStart=...`
instead of POST. Normal current/future calendar changes use `bootstrap:false`.
On 409 or a lost calendar response, GET again and review all exact/effective/next
preconditions; no blind retry. First Publish retries retain the same key.

## Recovery and separate release blockers

Any failed request must leave business rows unchanged; verify inventory and
audit before proceeding. There is no calendar DELETE or down migration. Correct
current/future policy only with fresh GET preconditions and dependency checks.
For an erroneous immutable historical bootstrap, stop writes and restore the
verified backup into a separate target for review; never delete history or edit
0014. Do not run an old binary against active A1 data. A disposable demo can be
discarded and recreated; an existing target requires an approved recovery plan.

Development merge: the manual path and intentional MISSING behavior must be
accepted, review and exact-head CI must be green. Existing-target authorization,
backup/restore, inventory and writer drain remain prerequisites to applying it
there. No existing development database was authorized or modified here.

Staging/production remain blocked separately: environment-specific inventory
and restoration rehearsal, complete writer drain, controlled contract adoption,
calendar admin/error UI and browser→API→PG acceptance, company-time-zone
acceptance, #51 proxy/operations controls, dependency findings, privileged SQL,
retention/observation and human security/UX acceptance. No deployment or security
certification is implied. A2 and issues #88/#90 remain open.
