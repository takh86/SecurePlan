# SP-13 React publish dialog handoff

Backend branch: `agent/codex/sp13-initial-publish`, based on
`main@13b680c07929ae595c196a523a32d4226bfa8e64`. Refs #28/#29; A10 dependency #85.
Implement the dialog after `agent/claude/sp12-a10-ui` is integrated. This backend
change contains no React screens, API-client edits or UI-test edits. Backend PR
integration and React/browser acceptance must be recorded separately.

## Request and result

```http
POST /api/v1/monthly-plans/{planId}/publish
Idempotency-Key: <one client-generated key for this confirmed command>
X-CSRF-Token: <existing session-bound token>
```

Use the existing same-origin session transport. Send no body, including no `{}`,
and no client company/actor/status/timestamp. No Expected-Version or
Edit-Lease-Token is required for publication. Key format: 8-128 visible ASCII
characters; a UUIDv4 is suitable. Keep the key private to the command's retry
state; do not include it in user messages or logs.

Success is HTTP 200 with the existing five-field plan representation:

```json
{
  "id": "<plan UUID>",
  "projectId": "<project UUID>",
  "monthStart": "2027-01-01",
  "status": "PUBLISHED",
  "publishedAt": "2026-11-02T18:00:00Z"
}
```

The example timestamp is illustrative. The actual timestamp comes from the
persisted server result. Headers include `Cache-Control: no-store`, a fresh
`X-Correlation-ID` for this attempt, and `Idempotency-Replayed: false` for the
initial command or `true` for a completed retry. Replay preserves the logical
HTTP 200 result and publication time, without a second audit or publication.

## Confirmation and recovery

1. Confirm first publication of the selected project/month. Use the integrated
   A10 plan/entries state and existing authorization conventions.
2. Create the key when the administrator confirms. Retain the same key and plan
   ID if the response is lost, the request times out, or a technical 500 leaves
   the outcome uncertain. Reloading GET is also safe; never infer rollback from
   a missing response. There is no automatic server replay of a human decision.
3. While awaiting the result, preserve the confirmed command and avoid issuing
   another command with a new key for the same click. A matching completed retry
   returns 200; `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` supplies `Retry-After: 1`.
4. On a business conflict, reload the plan and entries and let the administrator
   resolve/reconfirm the changed state. A new explicit command gets a new key.
   Reuse of one key for another plan returns
   `409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST`.
5. Reflect PUBLISHED only after a successful/replayed response or confirmed GET.
   The same stable plan remains editable through the existing SP-12 lease and
   Expected-Version APIs. No second Draft, copy or republish action exists.

## Conflicts and scope

| Result | Dialog behavior |
|---|---|
| `MONTHLY_PLAN_ALREADY_PUBLISHED` | Reload the plan; another command may have published it. Do not offer republish. |
| `PLAN_CONCURRENT_MODIFICATION` | Reload plan and entries; discovery changed while acquiring the publish locks. Require fresh confirmation. |
| `PROJECT_INACTIVE`, `SHIFT_CONFIGURATION_MISSING` | Display the existing safe problem and reload relevant planning context. |
| Employee ACTIVE/employment/month-link/eligibility conflicts | Use existing error presentation; reload before another confirmation. |
| `EMPLOYEE_UNAVAILABLE` | Keep the message neutral; publication errors do not disclose SICK/LEAVE, reasons or absence markers. |
| `DUTY_ASSIGNMENT_CONFLICT` | Reload affected planning state; do not blindly resubmit. |
| 401 / 403 / concealed 404 | Preserve the existing session/permission/not-found flow; no foreign-plan details. |

Empty plans and unstaffed duties have no invented employee or shift-leader
minimum. The server revalidates every live duty/member; do not add a client-side
staffing threshold or a new past-month rule. There is no publication notification
or delivery promise in this slice. SP-14 personal-plan reads remain outside scope.

## Outstanding acceptance

After both branches are integrated, verify confirmation, cancel-before-submit,
success/replay, double click, lost response, in-progress/retry, revalidation and
reload conflicts, tenant/role/session failures, and subsequent direct PUBLISHED
duty edits through a real browser, API and freshly verified disposable PostgreSQL.
No such React Publish dialog or browser acceptance was executed by this backend
change. Keep #28/#29 open until their separate applicable acceptance is supplied.
