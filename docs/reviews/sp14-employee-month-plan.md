# SP-14 employee monthly plan ? implementation evidence

Employees can read their own published duties from PostgreSQL through the existing session boundary. The German personal-plan view now uses live data, company-local default months, explicit saved duty zones, overnight end dates, month selection and refresh. Published edits become visible on the next read without another publication. The feature remains read-only.

The dedicated employee controller and read service derive ownership from the authenticated account and tenant. The projection returns only authorized published plans and current, nonremoved personal memberships, conceals archived projects, and distinguishes an authorized empty plan from no visible published plan. Identity retains authority over sessions and company metadata. Login keeps its existing response; `/me` adds company zone and current company month.

All live personal-plan responses are validated before rendering, including nested fields, civil dates, UTC instants, enums, zones, identity duplication and order. Reads use the existing SessionApi. Principal changes, new session generations, logout and late responses cannot reuse the previous private view. GET/HEAD responses and guard/validation errors use private no-store caching without validators.

## Local verification

Evidence uses synthetic data only, Node 24.21.0 and a separately verified memory-only PostgreSQL 17.11 container on a random loopback port. The existing demo database was preserved. Existing migrations replayed successfully; no migration or index was added.

| Check | Result |
| --- | --- |
| Lint; backend typecheck; backend/frontend build | PASS |
| Backend unit suite | PASS ? 423 tests, 38 files |
| Frontend suite | PASS ? 1,122 tests, 67 files |
| Full backend HTTP/PostgreSQL suite | PASS ? 1,493 tests before the additional race cases; final suite recorded in PR |
| Expanded SP-14 real HTTP/PostgreSQL regressions | PASS ? 78 cases, including case-insensitive cache handling |
| Repository script tests | PASS ? 34 tests in Node 24, sharing only the disposable PostgreSQL container network |
| Public-content check | PASS ? limited automated scan, plus diff review |
| Real installed Chrome | Admin Save/First Publish, employee reload/refresh, CR-03, mobile390px, browser zones, malformed responses, principal changes, cross-tab logout and expiry verified; final native lifecycle result recorded in PR |
| Staging deployment and human screen-reader/device review | NOT_RUN |

The legacy demo-script guard requires port5432. Its host invocation refused the random-port target before its fixtures; the complete script suite subsequently passed inside an isolated Node container with the existing verified receipt. No host demo connection was substituted.

`EXPLAIN (ANALYZE, BUFFERS)` used 80 synthetic employees, 72 monthly plans, 1,440 duties and 115,200 memberships. Membership-heavy and project-linked empty-plan cases returned the expected 20 and one SQL rows. Execution measured 0.328ms and 0.382ms respectively (planning 2.312ms and 3.655ms). This is a local synthetic measurement, not a production latency guarantee. Existing indexes are sufficient for this measured workload.

## Reproduction and review limits

`scripts/sp14-browser-acceptance.mjs` requires an explicit verified disposable target, a local Playwright module, browser evidence directory, local TLS certificates and existing startup configuration. It starts its own backend and static proxy; the static test HTML may be cached specifically to exercise history restoration, while private API responses retain no-store. Malformed-response and delay cases intercept actual server responses. Screenshots and detailed evidence remain outside Git.

`scripts/sp14-query-benchmark.mjs` requires the same target verification and an explicit benchmark output directory. It creates synthetic history in a transaction and rolls it back. Both scripts refuse unverified database targets. They do not load a database URL from `.env`.

Issues #29 and #30 remain open pending review and their broader acceptance. #30 staging demonstration is not established by local Chrome evidence. Release hardening #51, independent integrity/audit acceptance #100 and the First Publish review-to-commit race #101 remain independent open gates. This AI-assisted engineering review is not an independent human certification. No merge or deployment was performed.
