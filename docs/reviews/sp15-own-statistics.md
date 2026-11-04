# SP-15: Own planning statistics

The employee area provides `/meine-statistik` and an optional `YYYY-MM` month
segment. Three cards show planned workdays, day duties and night duties from
published personal plans. Workdays count distinct saved duty dates; duties
count independently. This is planning information, with no actual-hours or
payroll calculation. Authorized months without visible own duties use the
same neutral zero state.

The additive employee-only read endpoint reuses the existing personal-plan
read. It adds no persistence, migration or dependency. Committed published-plan
changes appear on a fresh read. The page uses the authenticated company month,
strict response validation and the existing session boundary; private counts
are neither persisted in the browser nor retained during reload/error states.

## Verification

Focused tests are `me-planning-statistics.service.spec.ts`,
`me-planning-statistics-real.e2e-spec.ts` and the frontend `my-statistics` tests.
Run them through the normal workspace commands. Fixture-capable checks require
[a verified disposable database](../testing/disposable-postgres.md).

`scripts/sp15-browser-acceptance.mjs` exercises the built frontend, real NestJS
and disposable PostgreSQL using installed Chrome or Edge. It requires explicit
`SECUREPLAN_PLAYWRIGHT_MODULE` and `SECUREPLAN_BROWSER_OUTPUT_DIR`; an optional
`SECUREPLAN_BROWSER_CHANNEL` selects the installed browser. TLS uses the local
certificates already required for development. Evidence is written outside Git.
The harness seeds synthetic prerequisites and uses supported HTTP writers for
saves, publication and subsequent edits. Controlled transport holds and invalid
responses are labelled separately from successful server behavior.

Tests cover counting, strict parsing, role/tenant/session boundaries, concurrency,
cache/error paths, refresh, responsive layout, keyboard focus and browser history.
Broader multi-plan arithmetic uses unit models; SQL fixtures retain database
constraints and label legacy no-current-link membership shapes explicitly.

Physical Android/iOS, Safari, assistive-technology user testing and independent
human acceptance remain NOT_RUN. Browser viewport/page-scale checks do not claim
physical-device or native toolbar zoom acceptance. Commit-specific results and
CI links belong to the review handoff. Separate gates #30, #51, #100 and #101
remain open; this slice does not authorize release, merge or deployment.
