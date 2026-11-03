# A1 project operating calendar

Implementation amendment, 2026-11-03; refs [#90](https://github.com/takh86/SecurePlan/issues/90),
[PO P1–P6](https://github.com/takh86/SecurePlan/issues/90#issuecomment-6588992180)
and [T1–T4 review](https://github.com/takh86/SecurePlan/pull/89#issuecomment-6589145511).
The A1 implementation is authorized in the implementation task. Independent
acceptance, merge and rollout remain separate gates. This public summary does
not replace the internal API specification or claim its formal adoption.

COMPANY_ADMIN can GET/PATCH a project's `operating-calendar`. Reads are scoped
to an explicit month and return CONFIGURED or MISSING, effective and exact
version references, and the next applicability boundary. PATCH replaces one
complete set of 1–7 distinct ISO weekdays; both version references and the next
boundary must still match after locking. Exact same-set writes are no-ops only
with fresh preconditions; equal-to-inherited inserts create an explicit version.
Lost responses require a new read and explicit review; stale retries are 409.
No delete, automatic retry or calendar idempotency command is introduced.

The local duty start date determines the weekday, including NIGHT across
midnight. There are no inferred weekdays, holidays or exceptions. Normal writes
cannot change past months. Explicit bootstrap is permitted only with no calendar
versions, at the earliest live duty month (current company month if none), and
must cover every existing live duty. Migration 0014 inserts no policies.

A change cannot newly close an occupied live duty date in its applicability
interval, including empty and PUBLISHED duties. A later calendar version bounds
that interval. Existing invalid rows remain readable and retain identity/history;
they are never silently deleted. No-op and corrective removals need no new
calendar evidence. Role/date/kind changes and new assignments validate the policy.
Existing eligibility, lease/version and authorization rules remain in force.
Explicit SP-12 removal can retire a duty. No automatic placeholder creation or
A2 employee-month Save is included.

All effective planning writers enforce exclusive DAY/NIGHT membership per
employee/project/local date, independently of half-open UTC overlap. First
Publish checks every live duty, including empty rows, and every active member;
MISSING blocks even an empty plan's publication. Authorized CR-03 edits still
apply directly to PUBLISHED plans.

Error precedence: global authentication/role/Origin/CSRF and parser checks;
strict structural validation; transactional account/company revalidation;
usable planning schema; concealed project 404; fresh session after P; stale
exact/effective/next preconditions; history/bootstrap validity; exact no-op;
PROJECT_INACTIVE; dependency conflict; atomic write/audit. Existing duty
lease/version and slot precedence is retained. The calendar check precedes shift
configuration and employee eligibility for newly scheduled work. Exclusivity
uses EMPLOYEE_DAILY_SHIFT_CONFLICT after existing employee eligibility/availability;
UTC overlap retains DUTY_ASSIGNMENT_CONFLICT. Closed days use PROJECT_CLOSED_WEEKDAY,
matching the shared vocabulary proposed in the approved design direction.

Calendar field failures use 400 PROJECT_CALENDAR_INVALID with bounded field
pointers. Unknown fields retain UNKNOWN_FIELD. Missing/closed policies and
stale/dependent calendar changes use the explicit calendar 409 codes
in the source catalogue. Errors contain static remedies and no roster/medical
details; all calendar success/error responses use no-store. Standard parser,
authentication, concealed 404 and sanitized 500 responses remain unchanged.

Before rollout, explicitly review the read-only inventory from
`node scripts/scan-project-calendars.mjs` against an authorized target. It reports
only tenant/project/month violation counts; it makes no repairs. Historical
bootstrap records explicit compatibility acceptance, not proof of an old policy.
The [development runbook](../development-a1-rollout.md) provides the explicit
manual admin path and disposable legacy migration/demo rehearsal. Its inventory
also reports projects without duties and missing historical plan months. No
existing environment rollout, development-data cleanup or frontend integration
has been performed. See the A1 PR for executed verification and limitations.
