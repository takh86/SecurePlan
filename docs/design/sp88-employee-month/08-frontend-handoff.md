# Claude handoff: approved interaction versus proposed API

Read-only review: Draft [#91](https://github.com/takh86/SecurePlan/pull/91),
head f61b547ca96d087cd8a7f0101602512370f1917a and its
`docs/reviews/sp88-employee-month-ux.md`. It is stacked on #87, not main.
No Claude file/branch was modified. R1-R10 are useful input, not the HTTP contract.

## Approved behavior

Project -> month -> employee -> whole calendar. Persistent TAG/NACHT/FREI toolbar
**before** date clicks/taps/keys. One date activation applies current mode;
replace opposite kind; repeat same mode is no-op, not toggle. One reviewed Monat
speichern. No date popup/day Save/multi-PATCH loop. FREI never absence. Preserve
roles/source/identity/history and others. Employee month primary, matrix overview.
After Save remain on employee, offer Nächste Person. CR-03 direct Published effects.

Credit preview draft/review/rebase/navigation/dirty PublishSlot seams and tests.
Revise independent toggles, second-click removal and dual-allowed tests. Keep
Save disabled until approved backend exists. No fake persisted success.

## Proposed wire contract - pending T1-T4

[API](03-api-and-idempotency.md) defines GET employee-month, POST save and GET
save-result. One consistent full projection includes both canonical slot IDs/
versions/absence, target assignments/roles/source, lifecycle, creation checksum,
calendar identity/version/set and neutral unavailableDates. No other staff's
private data in this projection. A separate authorized matrix is context, never
copied as a roster into the command or mixed-time preconditions.

```ts
// Every actual date, not only dirty dates; wire DAY/NIGHT/OFF, UI TAG/NACHT/FREI.
{ date, expected: { day: null | {id,version}, night: null | {id,version} },
  desired: {state:'OFF'} | {state:'DAY'|'NIGHT',role:'EMPLOYEE'|'SHIFT_LEAD'} }
```

No desired independent roles, source, assignment IDs, other employees, times or
tenant override. Retained kind preserves SHIFT_LEAD; new kind defaults EMPLOYEE.
Existing selected-kind membership in legacy dual retains its role; explicit
secondary role control may change it, never a required popup per date.

Read currentState INVALID_DUAL with both actual assignments; never silently pick
a winner. Require explicit one-state correction before full Save. Rebase must
retain intent and cannot create dual state. Existing closed assignments remain
visible with safe violations and allow OFF correction under existing guards.

OperatingState OPEN/CLOSED/MISSING comes from authoritative project calendar.
CLOSED disables new DAY/NIGHT, remains focusable/explained/removable. MISSING is
configuration blocker, never invented Mon-Fri/all-seven. NIGHT uses local start
date, even if ending next morning. [SP-90](../sp90-project-operating-weekdays.md)
GET/PATCH supplies effective-month admin form; do not derive weekdays from times.

Freeze exact request/key on one POST. Validate response before acknowledgement.
APPLIED/NO_OP immutable receipt proves commit; refresh failure is separate. An old
replay receipt must not overwrite fresh lifecycle/current changes. New intent/
rebase gets new key; explicitly confirmed exact retry keeps key/body, no auto retry.

| Safe outcome/code | Client behavior |
|---|---|
| PLAN_CONCURRENT_MODIFICATION including CALENDAR | Keep entire draft; fresh baseline separate; explicit compare/review/reconfirm |
| ACTIVE_DUTY_EDIT | Retain draft; close secondary editor/wait; never rotate/steal lease |
| PROJECT_CLOSED_WEEKDAY / PROJECT_CALENDAR_MISSING | Safe dated/config action, never silently skip days |
| EMPLOYEE_DAILY_SHIFT_CONFLICT / INVALID_DUAL read | Explicit exclusive correction, no legal claim |
| Eligibility/unavailability/overlap | Neutral dated text; no medical category or other worker identity |
| PRESERVED_ROSTER_CONFLICT | Neutral shared-duty problem; authorized editor after resolving draft |
| 401/403/404 | Hide plan; retain context-bound non-rendered volatile draft; fresh same-actor authorization required |
| Network/malformed response/uncertain COMMIT | OUTCOME_UNKNOWN; freeze key/body; explicit result lookup before new Save |

Result states: COMPLETED(original immutable receipt), IN_PROGRESS, NOT_COMPLETED
(proven failed), UNKNOWN(absent/expired, not failure proof). Matching fresh state
alone cannot attribute the command. Explicit reconciliation retains all choices.
No localStorage. Different login must neither display nor submit another actor's
draft; same actor must reauthenticate/revalidate. Tab destruction is memory limit.

Claude owns `features/planning/monthly-plans/**`, project calendar admin UI under
`features/projects/**`, `auth/session-api.ts`, frontend/app-shell tests. Codex owns
backend/migrations/PG tests and contract docs. QA gets a dedicated harness/evidence
file by assignment; no concurrent shared-file edits. Heavy DB/browser runs serial
on distinct verified targets. UI can use frozen approved fixtures in parallel;
production enablement waits backend and combined CI/browser/security review.
Actual Publish requires truly bodyless POST, durable key/recovery and real
Publish -> PUBLISHED month Save browser proof; no SQL-published fixture shortcut.
