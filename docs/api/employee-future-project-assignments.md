# Employee Future Monthly Project Assignment Discovery

S-9 / D73-7, implementation review dated 2026-10-29. Authority:
[Tech Lead/API sign-off](https://github.com/takh86/SecurePlan/issues/64#issuecomment-6496624387),
following [Issue #73](https://github.com/takh86/SecurePlan/issues/73) and PR #74.
This slice adds discovery and reuses individual removal. Issue #64 Case 2,
SP-10/SP-11 and deployment approval remain separate.

## API

`GET /api/v1/employees/{employeeId}/future-project-assignments`

Only the authenticated company's `COMPANY_ADMIN` may read this resource.
Deactivated employees and assignments lacking employment evidence remain
discoverable. Company identity comes from the validated session; unknown and
foreign employee IDs are indistinguishable (`404 RESOURCE_NOT_FOUND`).

The only query parameters are `page` (1..1,000,000, default 1) and `pageSize`
(1..100, default 25). Invalid paging and unknown fields use the existing
`VALIDATION_FAILED` / `UNKNOWN_FIELD` Problem Details contracts. HTTP regression
tests pin actual Nest pipe precedence: malformed path plus invalid paging yields
404, while missing authentication wins with 401 before either pipe.

FUTURE means `planning_month` is strictly after the company's current month.
One injected server-clock instant and the stored company IANA timezone determine
one cutoff for the response. Current/past months are excluded; no future horizon
is imposed. The new read checks the zone against PostgreSQL's named-zone catalog
before conversion, because `AT TIME ZONE` alone also accepts POSIX strings.
An invalid zone fails closed with sanitized `500 INTERNAL_ERROR`. Existing write
timezone handling is unchanged.

Success is 200 with `Cache-Control: no-store` and the existing envelope:

```text
{ items, pagination: { page, pageSize, totalItems, totalPages } }
```

Each item has `id`, `employeeId`, `projectId`, `monthStart`, `version`,
`projectName` and `projectStatus`. Sorting is `monthStart ASC, id ASC`.
The version uses the exact existing positive-safe-integer mapping from #73.
Visible projects have a name and `ACTIVE`/`INACTIVE` status. Archived references
retain assignment identity, but both metadata fields are null: a conditional
tenant-scoped SQL join and defensive mapper enforce ADR-0002 F-3. No ARCHIVED
status or archived name leaves the endpoint.

An existing employee with no matches receives empty items and zero totals.
A beyond-last page also returns empty items, with the actual nonzero totals
where applicable. It does not mean all future assignments have disappeared.
There is no migration, new error code, or change to the original assignment
GET/POST/PATCH/DELETE contracts.

## Consistency and query plan

Employee existence, company zone, count, rows and project labels share one short
`REPEATABLE READ, READ ONLY` transaction. It takes no mutation locks, changes no
business record/version and writes no business audit. Existing session activity
touching occurs independently through the authentication guard.

Each HTTP page gets a fresh snapshot. Concurrent changes may shift offset pages;
the API does not hold a transaction across administrator interactions.

An isolated synthetic EXPLAIN (ANALYZE, BUFFERS) experiment with 24,000 background
assignments used `uq_project_assignments__employee_month`: index-only scan for
count, index scan plus incremental sort for the page. No index was forced or
added. The experimental fixture was rolled back. This is index-suitability
evidence, not a production performance benchmark.

## Employee detail workflow

The section **Zukünftige Projektzuordnungen** is available for active and
deactivated employees. It displays project, German month/year and project status.
Hidden metadata appears as **Projekt nicht verfügbar**, with the retained project
reference and no project-detail link.

Pagination, refresh, loading, retryable read failure, empty and beyond-last states
are distinct. Native labelled buttons, table/section labels, live feedback and
focus handling support keyboard and screen-reader use.

**Entfernen** reuses the existing inline confirmation and DELETE client. The
confirmed ID/version/context remain fixed. Any DELETE settlement, including an
uncertain network outcome, closes confirmation and reloads page 1; DELETE is
never retried automatically. Only a successful response with zero total confirms
that no future assignments remain. Assignment refresh does not remount or save
the employee's unsaved master-data form.

Listing establishes future status at its snapshot instant, not guaranteed
removability. DELETE still checks the locked version, company-local month and
unchanged E-10 planning guard. Stale PATCH/ABA, another DELETE and month rollover
keep their approved 409/404/refusal behavior. Employment dates, deactivation and
replacement remain separate explicit actions; no batch or automatic mutation.

## Verification evidence and limits

Local checks on this slice: 218 backend unit tests; 537 HTTP/E2E tests including
50 new real-PG discovery cases; 451 frontend tests; 20 operational-script tests.
Migrations applied twice (second application a no-op) and DB verification passed
on an isolated PostgreSQL 17 container. Script tests ran in a temporary Node 24
container sharing that test container's network, preserving their existing
port-5432 environment guard. The initial host-port script run was rejected by
that guard and made no business changes.

The new PG suite covers visibility, projection masking, authorization, query
errors, >100 rows, exact versions, IANA month/year boundaries, read immutability,
and deterministic real-SQL snapshot barriers during PATCH/DELETE/rollback,
project/zone changes and clock rollover. It also drives listed versions through
successful/stale/ABA/repeated/rollover DELETE and the unchanged planning guard.
Frontend cases cover state handling, paging, version confirmation, unknown
outcomes, focus, cancellation, employee switching and unsaved-form preservation.

The first concurrently scheduled full frontend run hit an unchanged activation
test import timeout under load; the complete isolated rerun passed. No activation
code or timeout configuration was changed.

Manual browser smoke: **NOT_RUN**. The real backend and HTTPS frontend started,
backend readiness passed and synthetic browser fixtures were prepared in the
isolated database. Browser control reported the access host unavailable; the
fallback native Chrome launch approval timed out before any browser interaction.
Automated browser E2E: **NOT_RUN**, no browser E2E harness was added. Mocked UI
tests and backend HTTP tests are not browser evidence. Independent code review
and the browser acceptance gap remain explicit; no production-readiness claim.
