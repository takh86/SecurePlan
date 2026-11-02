# Proposed domain and interaction contract

Approval scope: recommended details for #88; only the one-command atomic business
requirement is already approved. Decision IDs refer to the decision sheet.

## Intent and aggregate boundaries

The route identifies an existing visible monthly plan and one employee of the
same company. Project and month come from that immutable plan. The existing
create-plan flow precedes this editor when no plan exists; Save does not silently
create the plan or a project-month assignment. Duties and their memberships
remain the source of truth. An employee-month is a projection and command scope.

| Alternative | Benefit | Cost / recommendation |
|---|---|---|
| Full desired state for every date and both kinds | Meaning of the displayed month is explicit; one clear review; omitted dates cannot accidentally mean deletion | **Recommend.** Require exactly every date, explicit null membership and a version/absence precondition for each slot. More conservative conflicts |
| Changed-days-only operations | Smaller payload; unrelated duties need not conflict | Requires an additional baseline and explicit ADD/REMOVE/KEEP semantics; omitted changes cannot express the whole selected month. Possible future optimization, not the initial primary contract |
| Many single-duty saves | Reuses current UI API directly | Cannot meet the approved atomic requirement; excluded as implementation of Monat speichern |

Full state is scoped to this employee only. It is never the complete roster of
any duty. The server derives the delta from locked current state **after matching
all preconditions**. The UI initializes every role from the read response and
never resets retained SHIFT_LEAD roles to EMPLOYEE.

## Meaning of each date

Represent DAY and NIGHT independently. Each has an expected duty identity/version
or explicit absence, and a desired `selectedRole` of EMPLOYEE, SHIFT_LEAD or null.

| Stored membership → desired role | Effect |
|---|---|
| Absent → null | Unchanged; no duty or membership created |
| Present → same role | Unchanged; same membership ID/source and duty version |
| Absent → role | Add one new ACTIVE NORMAL membership; create a duty only if its live slot is absent |
| Present → different role | Change this membership's duty function, preserve ID/source |
| Present → null | Explicit removal: mark only this membership REMOVED, retain history |

For a date, neither selected means **no membership in either duty** for this
employee. Label it “Frei / nicht eingeplant” with an explanation; it is not a
SICK, LEAVE, Wunschfrei or availability fact. DAY and NIGHT together are proposed
when both intervals are valid and do not overlap, including adjacent intervals.
The two selections may have different duty roles. The single-choice Phase 5
sketch needs the explicit P1 amendment; no rest-time, daily-hours or leader
minimum is inferred. Existing approved validation remains the boundary.

DAY → NIGHT is a removal and addition, not a change of the shared DAY duty's kind.
Other employees remain in DAY with the same roles, membership IDs and sources.
The employee retains a current NIGHT membership if it already exists; otherwise
the new membership gets a new ID/source NORMAL. Rejoining a removed membership
creates a new historical row; never revive a REMOVED row.

## Missing slots, empty duties and other employees

Proposed P2: create an absent live slot only when the employee is being assigned
to it. Resolve its interval using the effective whole configuration and existing
D6 resolver. Do not create up to 62 empty placeholders for unselected days.
Removed/tombstoned duties do not occupy a live slot; a valid recreation gets a
new duty ID.

Retain every existing duty, including one that becomes empty after removal of
this employee. This intentionally leaves D3 configuration dependency protection
and other duty history in place. Deleting a whole duty remains the separate
explicit SP-12 operation. A batch never deletes, renames, moves or changes the
times/kind of an existing shared duty. It never submits or replaces its other
employees' roster. Staffing can be zero; no minimum or required leader count is
introduced.

For each effective change to an existing duty, reuse SP-12's resulting-roster
validation. All remaining staff must pass it, even if their memberships are
preserved. Consequently, an unchanged invalid colleague can block the batch;
show a neutral duty conflict and an authorized route to the aggregate editor.
No broad new removal exception is proposed. Do not automatically unassign that
colleague to make the selected employee's month valid.

## Lifecycle, history and eligibility

UNPUBLISHED Save persists planning without publishing. PUBLISHED Save takes
effect immediately after commit under CR-03. It does not change `publishedAt`,
publisher, lifecycle or a plan revision. If publication happens after this editor
loaded, the expected lifecycle no longer matches: preserve input and require a
fresh review of the now-immediate effect, even when duty versions match.

Inherit SP-12, rather than adding a new historic-edit policy: no past-month/date
freeze. New/remaining assignments require ACTIVE employee status, inclusive
employment on the local duty date, matching project-month assignment, shift
eligibility, neutral availability and no UTC overlap. Existing duty times remain
saved UTC snapshots. An inactive/ineligible employee can be viewed and true
no-ops remain no-ops; removing that employee is possible if the resulting roster
and the active project/configuration pass the existing effective-PATCH rules.
An INACTIVE project blocks effective changes, including membership removals;
ARCHIVED is concealed. Correcting that policy is a separate business change.

Unchanged duties are not forcibly revalidated by a true no-op. First Publish
still independently revalidates the entire live plan. Saving one employee's
month must not claim the whole plan is publishable. Unavailability is checked on
the local duty start date, as currently approved; no cross-midnight expansion of
absence rules is invented.

## Interaction and state machine

1. Choose project/month, open or explicitly create its plan, choose one employee.
   Show all dates and both shift choices; historical/current memberships stay
   visible even when the employee is no longer selectable for new assignments.
2. Load one consistent employee-month projection. Store an immutable baseline,
   the complete desired month and a separate dirty-date/role diff in memory.
   No lease or database transaction lasts through user editing.
3. Apply cell changes locally. Show additions, removals and role changes with
   text/icons, not color alone. Show a visible review summary and the immediate
   Published effect. Clearing the whole month must explicitly acknowledge the
   displayed removal count before final Save. There is one final submit action
   labelled **Monat speichern**, not a save per date.
4. Final Save freezes an in-memory request/key pair and sends one batch POST.
   Disable duplicate submits and context navigation while the outcome is pending.
   No optimistic persisted-success display or split request fallback.
5. On APPLIED/NO_OP (including proven receipt replay), mark this exact draft
   acknowledged and refresh the authoritative projection/matrix. Distinguish a
   completed save from a later read-refresh failure. Never use an old receipt to
   overwrite a newly observed Published status or later edits.
6. On an atomic conflict, retain every selection and role. Focus an error summary
   whose date/kind links reach the relevant controls. Explain that nothing in
   this command was saved. Refresh into a **separate** current baseline and show
   base/current/desired differences. Do not silently merge or drop invalid dates.
   Only an explicit “Änderungen prüfen und erneut bestätigen” builds a revised
   full request and a new key. Restored selections are proposals until confirmed.
7. On an ambiguous network/COMMIT outcome, retain the exact frozen request/key
   and draft, mark outcome unknown, and disable editing/resubmission as a new
   command. An explicit safe result GET can prove completion. A further explicitly
   confirmed retry uses the exact same key/body; it is not an automatic retry.
   A current read matching the draft proves state, not which request caused it.

Suggested states: LOADING → CLEAN → DIRTY → REVIEW → SAVING → ACKNOWLEDGED;
SAVING may instead reach CONFLICT or OUTCOME_UNKNOWN. Only explicit reconciliation
leaves those states for a new reviewed intent. Idle lease conflicts may be retried
by explicit confirmation after the other editor closes; never steal its token.

Protect employee/project/month navigation, browser back and in-app Publish while
dirty or outcome-unknown. Provide explicit discard/continue choices. Use
`beforeunload` only as a best-effort warning; a tab close cannot guarantee memory
survival. No personal planning draft, session/key or lease token goes into local
storage by default. An authorization/session failure must also retain the entire
draft, as #88 requires: move it and its frozen request/key to a protected,
non-rendered in-memory recovery store above the route/session boundary. Bind it
to the original company, actor, plan and employee. Hide the planning UI and disable
submission until a fresh session for that same actor/company has current admin
permission and resource visibility. Another signed-in actor/tenant must neither
see nor submit the retained input. Reauthentication still requires explicit
reconciliation/confirmation, never automatic retry. T4 must review this memory
lifecycle; existing #87 route-local state alone is insufficient. Explicit discard
or an explicitly confirmed logout/discard may clear it. Tab destruction remains
the stated limit; no persistent cross-login draft storage is proposed.

Reuse #87's matrix, keyboard navigation, labels and secondary duty editor.
Opening that editor must first resolve the employee-month draft, and the new
editor must not reuse/rotate an open secondary editor's live lease. At 60–100
employees, show a clear selected-employee month with sticky date/context and
keyboard access; month editing is primary, other rows remain context. The owner
must validate this with representative tasks, not only screenshots.

No authoritative company-zone HTTP field is approved here. Use civil date/kind
for selection and server-resolved UTC values for correctness. The existing
company-zone display decision remains an explicit dependency for time labels
and combined browser acceptance; device-zone inference cannot resolve it.
