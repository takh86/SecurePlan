# SecurePlan_Phase_8.3_DTO_Design_FINAL_v1.0

> Designquelle: SecurePlan_Phase_8.3_DTO_Design_FINAL_v1.0.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan – Phase 8.3

Request / Response DTO Design

| Document | SecurePlan – Phase 8.3 DTO Design |
| --- | --- |
| Version | v1.0 – Professional Baseline |
| Status | COMPLETE · PASS FOR PHASE 8.4, with documented 8.2 correction |
| Date | 06.10.2026 |
| API base | /api/v1 |
| Architecture | NestJS / TypeScript · PostgreSQL · REST · tenant-aware Modular Monolith |
| Primary inputs | Phase 2 v1.1 · Phase 3 v1.1 · CR-01/02/03 · Phase 4 FINAL v1.2 · Phase 6.6 · Phase 7 FINAL v1.0 · Phase 8.2 |
| Next | Phase 8.4 – Validation Contracts |

| Core rule<br>DTOs are API contracts, not database rows. Request DTOs describe what a client may ask for; response DTOs describe what the server may expose. Server-derived tenant/security fields and persistence-only fields do not leak into public contracts. |
| --- |


## 1. Purpose and scope

Phase 8.3 converts the endpoint structure from Phase 8.2 into explicit transport contracts. It defines request and response shapes, public enum values, null/omission semantics and reusable summary DTOs. Detailed field validation, error payloads, authorization matrices, concurrency precondition transport, pagination and OpenAPI annotations are intentionally deferred to later Phase-8 subphases.

Covers every endpoint fixed in Phase 8.2.

Uses camelCase in JSON although PostgreSQL remains snake_case.

Keeps Company/Tenant context server-derived; clients do not send companyId as an authorization input.

Preserves CR-03: after initial publish there is no parallel monthly-plan draft and no re-publish workflow.

Preserves CR-01: there is no replacement quota / 3-takeover field or counter in any DTO.

Does not expose password hashes, session token hashes, credential token hashes, audit internals or other persistence-only data.

### 1.1 Baseline reconciliation performed before DTO freeze

| Correction found during full review<br>The earlier learning exercise used a deliberately simplified Employee DTO and omitted account provisioning. The final baseline requires employee/account separation in the data model, but the MVP onboarding flow still needs an e-mail/account activation path. The final CreateEmployeeRequestDto therefore carries e-mail as account-provisioning input while password, account role and account status remain server-controlled. This does not merge Employee and Account entities. |
| --- |


| CR-03 precedence<br>Any older Draft/Re-Publish wording is superseded. MonthlyPlan has UNPUBLISHED/PUBLISHED lifecycle for the first publication; after PUBLISHED, authorized planning mutations update the current source-of-truth plan directly after revalidation and successful commit. |
| --- |


| 8.2 consistency correction A8.2-01<br>Phase 4 FINAL v1.2 explicitly requires minimal administrative SICK/LEAVE availability maintenance for replacement eligibility, while the current 8.2 endpoint catalog omitted it. This document records the minimal correction: GET /employees/{employeeId}/availability, PUT /employees/{employeeId}/availability/{day}, DELETE /employees/{employeeId}/availability/{day}. These routes must be mirrored back into the Phase-8.2 endpoint document before the final Phase-8 gate. |
| --- |


### 1.2 Explicitly deferred

8.4: min/max length, e-mail syntax, date boundaries, enum membership validation, cross-field rules and business validation mapping.

8.5: ApiErrorDto, stable domain/error codes and field error representation.

8.6: endpoint-by-endpoint authentication, authorization, ownership and tenant-access matrix.

8.7: If-Match/version preconditions, idempotency-key transport and retry contracts.

8.8: pagination, sorting, filter/query parameter contracts.

8.9: OpenAPI/Swagger annotations and generated specification.

## 2. Global DTO conventions

| Convention | Decision | Rationale |
| --- | --- | --- |
| JSON field naming | camelCase | Database uses snake_case; API does not expose DB column names. |
| UUID | string (uuid) | Opaque public identifier. Client must not infer meaning. |
| Date | string (date) | Calendar date, e.g. 2026-10-06. |
| Month | string (date) | Represented by monthStart; must denote first day of month. Validation in 8.4. |
| Local time | string (time) | Project-local recurring time, e.g. 06:00:00. |
| Timestamp | string (date-time) | RFC 3339 / ISO-8601 instant; concrete timezone rules finalized in OpenAPI. |
| Enum | string enum | English technical values. UI may localize TAG/NACHT etc. |
| Optional request field | omitted | For PATCH: omitted means 'leave unchanged'. |
| Nullable request field | explicit null | Used only where clearing a persisted optional value is meaningful. |
| Tenant context | not in request | companyId is derived from authenticated server context. |
| Collection response | { items: [...] } | Pagination metadata is added/finalized in 8.8. |

### 2.1 Public enum catalogue

| Enum | Values |
| --- | --- |
| AccountRole | EMPLOYEE · COMPANY_ADMIN |
| AccountStatus | PENDING_ACTIVATION · ACTIVE · DEACTIVATED |
| EmployeeStatus | ACTIVE · INACTIVE |
| ShiftEligibility | DAY · NIGHT · BOTH |
| ProjectStatus | ACTIVE · INACTIVE |
| ShiftKind | DAY · NIGHT |
| AvailabilityStatus | SICK · LEAVE |
| MonthlyPlanStatus | UNPUBLISHED · PUBLISHED |
| DutyRole | EMPLOYEE · SHIFT_LEAD |
| AssignmentSource | NORMAL · REPLACEMENT |
| CancellationStatus | OPEN · WITHDRAWN · REJECTED · APPROVED · OBSOLETE |
| CancellationDecision | APPROVE · REJECT |
| ReplacementNeedStatus | OPEN · OPEN_UNFILLED · RESOLVED · CLOSED |
| ReplacementOfferStatus | OPEN · SELECTED · NOT_SELECTED · INVALIDATED · WITHDRAWN |

## 3. Reusable summary DTOs

EmployeeIdentitySummaryDto

Small non-sensitive employee identity projection used inside workflow/read DTOs.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | Employee technical ID |
| employeeCode | string | required | server | Company-local business identifier |
| firstName | string | required | server | Display name |
| lastName | string | required | server | Display name |

ProjectSummaryDto

Small project projection for personal plan and workflow responses.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | Project ID |
| name | string | required | server | Project display name |

DutySummaryDto

Read-only duty projection reused by cancellation/replacement DTOs.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | Duty / planning-unit ID |
| dutyDate | string(date) | required | server | Calendar day |
| shiftKind | ShiftKind | required | server | DAY or NIGHT |
| startsAt | string(date-time) | required | server | Resolved concrete start instant |
| endsAt | string(date-time) | required | server | Resolved concrete end instant |

## 4. Authentication and account DTOs

LoginRequestDto   ·   POST /api/v1/auth/login

Credentials sent to create an authenticated server-side session.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| email | string | required | client | Login e-mail; normalized by server |
| password | string | required | client | Raw password only in transport; never stored/logged |

MeResponseDto   ·   GET /api/v1/me

Authenticated account context returned after login and by GET /me.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| accountId | string(uuid) | required | server | Authenticated account |
| email | string | required | server | Account e-mail |
| role | AccountRole | required | server | EMPLOYEE or COMPANY_ADMIN |
| accountStatus | AccountStatus | required | server | Current account lifecycle |
| employee | EmployeeIdentitySummaryDto \| null | required | server | Linked employee for employee accounts; null for admin-only account |

Design note: Session credential is carried in the secure session cookie, not returned as a bearer token in JSON.

ActivateAccountRequestDto   ·   POST /api/v1/auth/activate

Completes one-time account activation.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| token | string | required | client | Raw one-time activation token from activation link |
| password | string | required | client | New account password |

Design note: The raw token is accepted for verification but only its hash is persisted. Password policy belongs to 8.4.

PasswordResetRequestDto   ·   POST /api/v1/auth/password-reset-requests

Starts a neutral password-reset flow.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| email | string | required | client | Account e-mail |

Design note: Response must not disclose whether the account exists. The endpoint may return no body.

PasswordResetConfirmRequestDto   ·   POST /api/v1/auth/password-resets

Consumes a time-limited one-time reset token.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| token | string | required | client | Raw reset token |
| newPassword | string | required | client | Replacement password |

| No DTO body<br>POST /auth/logout has no request DTO and normally returns no response body. The server revokes the current session. |
| --- |


## 5. Employee and availability DTOs

CreateEmployeeRequestDto   ·   POST /api/v1/employees

Creates the business Employee and provisions the linked employee Account for the MVP activation flow.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| employeeCode | string | required | client | Business employee identifier |
| firstName | string | required | client | Given name |
| lastName | string | required | client | Family name |
| email | string | required | client | Account-provisioning e-mail; belongs to Account domain, not Employee entity |
| employmentStart | string(date) | optional | client | Employment start if known |
| shiftEligibility | ShiftEligibility | required | client | DAY, NIGHT or BOTH |

Design note: Server generates Employee.id and tenant context; Employee status defaults ACTIVE. Linked Account is provisioned with server-controlled EMPLOYEE role and activation lifecycle. No password is accepted here.

UpdateEmployeeRequestDto   ·   PATCH /api/v1/employees/{employeeId}

Partial correction/update of mutable employee master data and account e-mail.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| employeeCode | string | optional | client | Correctable business code; change is audit-relevant |
| firstName | string | optional | client | Name correction |
| lastName | string | optional | client | Name correction |
| email | string | optional | client | Linked account e-mail correction; verification consequences handled outside this DTO |
| employmentStart | string(date) \| null | optional | client | Set or clear employment start |
| employmentEnd | string(date) \| null | optional | client | Set or clear employment end |
| shiftEligibility | ShiftEligibility | optional | client | DAY, NIGHT or BOTH |

Design note: Employee status is intentionally not patched here; deactivation is the dedicated domain action.

EmployeeResponseDto   ·   GET/POST/PATCH /api/v1/employees...

Admin-facing employee projection. It exposes useful business/account state but hides tenant and security internals.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | Employee ID |
| employeeCode | string | required | server | Business identifier |
| firstName | string | required | server | Given name |
| lastName | string | required | server | Family name |
| employmentStart | string(date) \| null | required | server | Employment start |
| employmentEnd | string(date) \| null | required | server | Employment end |
| shiftEligibility | ShiftEligibility | required | server | Current eligibility |
| status | EmployeeStatus | required | server | ACTIVE / INACTIVE |
| email | string | required | server | Linked account e-mail |
| accountStatus | AccountStatus | required | server | Linked account lifecycle |

Design note: companyId, passwordHash, token hashes and session details are never exposed.

| Deactivate employee<br>POST /employees/{employeeId}/deactivate has no request body. The response uses EmployeeResponseDto. Session/account side effects are finalized in 8.6/8.7. |
| --- |


### 5.1 Availability DTOs – A8.2-01 correction

SetAvailabilityDayRequestDto   ·   PUT /api/v1/employees/{employeeId}/availability/{day}

Creates or replaces one employee availability day used by replacement eligibility.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| status | AvailabilityStatus | required | client | SICK or LEAVE only |

Design note: No diagnosis, symptoms or free text. The day comes from the path.

AvailabilityDayResponseDto   ·   GET /api/v1/employees/{employeeId}/availability

Minimal privacy-preserving availability projection.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| employeeId | string(uuid) | required | server | Employee |
| day | string(date) | required | server | Affected calendar day |
| status | AvailabilityStatus | required | server | SICK or LEAVE |

| Delete availability day<br>DELETE /employees/{employeeId}/availability/{day} has no request body and removes the minimal availability marker when administratively corrected. |
| --- |


## 6. Project, assignment and shift-configuration DTOs

CreateProjectRequestDto   ·   POST /api/v1/projects

Creates a project with only the fields supported by the final database baseline.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| name | string | required | client | Project display name |

UpdateProjectRequestDto   ·   PATCH /api/v1/projects/{projectId}

Partial project update.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| name | string | optional | client | Rename project |
| status | ProjectStatus | optional | client | ACTIVE / INACTIVE |

ProjectResponseDto   ·   GET/POST/PATCH /api/v1/projects...

Minimal project projection used by list/detail endpoints.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | Project ID |
| name | string | required | server | Project display name |
| status | ProjectStatus | required | server | ACTIVE / INACTIVE |

CreateProjectAssignmentRequestDto   ·   POST /api/v1/project-assignments

Creates the month-scoped Employee → Project association.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| employeeId | string(uuid) | required | client | Employee to assign |
| projectId | string(uuid) | required | client | Target project |
| monthStart | string(date) | required | client | Planning month represented by first calendar day |

UpdateProjectAssignmentRequestDto   ·   PATCH /api/v1/project-assignments/{assignmentId}

Correction-only patch for an erroneous month assignment.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| employeeId | string(uuid) | optional | client | Correction only |
| projectId | string(uuid) | optional | client | Correction only |
| monthStart | string(date) | optional | client | Correction only |

Design note: At least one field must be present. Business validation must reject corrections that would violate history/current planning invariants.

ProjectAssignmentResponseDto   ·   GET/POST/PATCH /api/v1/project-assignments...

Stable identifier plus the three business dimensions of the assignment.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | Assignment resource ID |
| employeeId | string(uuid) | required | server | Employee |
| projectId | string(uuid) | required | server | Project |
| monthStart | string(date) | required | server | Planning month |

ShiftRuleInputDto

One project-local shift rule supplied as part of configuration update.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| shiftKind | ShiftKind | required | client | DAY or NIGHT |
| startLocal | string(time) | required | client | Recurring local start |
| endLocal | string(time) | required | client | Recurring local end; NIGHT may end next day |

UpdateProjectShiftConfigurationRequestDto   ·   PATCH /api/v1/projects/{projectId}/shift-configuration

Versioned-by-effective-month project shift configuration.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| effectiveFromMonth | string(date) | required | client | Month from which configuration applies |
| shifts | ShiftRuleInputDto[] | required | client | Configured project shifts |

ShiftRuleResponseDto

Persisted shift rule.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | Shift configuration row ID |
| shiftKind | ShiftKind | required | server | DAY or NIGHT |
| startLocal | string(time) | required | server | Local start |
| endLocal | string(time) | required | server | Local end |

ProjectShiftConfigurationResponseDto   ·   GET /api/v1/projects/{projectId}/shift-configuration

Read model for the effective project shift configuration.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| projectId | string(uuid) | required | server | Project |
| effectiveFromMonth | string(date) | required | server | Effective month |
| shifts | ShiftRuleResponseDto[] | required | server | Configured shift rules |

## 7. Monthly planning DTOs

| Aggregate mapping<br>The API term MonthlyPlanEntry maps to the Duty aggregate, not to a single database row. A Duty is the concurrency boundary and contains the current active DutyAssignments. This prevents the API from leaking the internal split between duty and duty_assignment while still preserving targeted planning mutations. |
| --- |


CreateMonthlyPlanRequestDto   ·   POST /api/v1/monthly-plans

Creates the stable Project + Month plan resource before first publication.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| projectId | string(uuid) | required | client | Project |
| monthStart | string(date) | required | client | Planning month |

MonthlyPlanResponseDto   ·   GET/POST /api/v1/monthly-plans...

Plan header/lifecycle projection.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | Monthly plan ID |
| projectId | string(uuid) | required | server | Project |
| monthStart | string(date) | required | server | Planning month |
| status | MonthlyPlanStatus | required | server | UNPUBLISHED / PUBLISHED |
| publishedAt | string(date-time) \| null | required | server | Set once on initial publish |

DutyAssignmentInputDto

Current desired assignment inside a duty entry.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| employeeId | string(uuid) | required | client | Assigned employee |
| dutyRole | DutyRole | required | client | EMPLOYEE or SHIFT_LEAD |

CreateMonthlyPlanEntryRequestDto   ·   POST /api/v1/monthly-plans/{planId}/entries

Creates a duty/planning unit and its current active assignments.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| dutyDate | string(date) | required | client | Date inside plan month |
| shiftKind | ShiftKind | required | client | DAY or NIGHT |
| assignments | DutyAssignmentInputDto[] | optional | client | Initial active assignments; may be empty if the duty exists before staffing |

UpdateMonthlyPlanEntryRequestDto   ·   PATCH /api/v1/monthly-plans/{planId}/entries/{entryId}

Partial mutation of the Duty aggregate.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| dutyDate | string(date) | optional | client | Correct duty date |
| shiftKind | ShiftKind | optional | client | Change shift kind |
| assignments | DutyAssignmentInputDto[] | optional | client | Desired current active assignment set |

Design note: The response exposes duty.version. Whether the client submits the expected version via If-Match header or body is finalized in 8.7; it is not silently fixed in 8.3.

DutyAssignmentResponseDto

Current active assignment inside a monthly-plan duty.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | DutyAssignment ID |
| employeeId | string(uuid) | required | server | Employee |
| dutyRole | DutyRole | required | server | EMPLOYEE / SHIFT_LEAD |
| source | AssignmentSource | required | server | NORMAL / REPLACEMENT |

MonthlyPlanEntryResponseDto   ·   GET/POST/PATCH /api/v1/monthly-plans/{planId}/entries...

Duty aggregate projection used by plan-entry list/create/update.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | Duty ID; equals entryId in path |
| dutyDate | string(date) | required | server | Duty date |
| shiftKind | ShiftKind | required | server | DAY or NIGHT |
| startsAt | string(date-time) | required | server | Resolved concrete start |
| endsAt | string(date-time) | required | server | Resolved concrete end |
| version | integer | required | server | Optimistic-concurrency token |
| assignments | DutyAssignmentResponseDto[] | required | server | Current active assignments only |

| Delete entry<br>DELETE /monthly-plans/{planId}/entries/{entryId} has no DTO body in this phase. Concurrency precondition transport is finalized in 8.7. |
| --- |


| Initial publish<br>POST /monthly-plans/{planId}/publish has no request body and returns MonthlyPlanResponseDto with status=PUBLISHED and publishedAt set. CR-03 means this is not used as a re-publish step. |
| --- |


### 7.1 Employee personal plan

MyDutyResponseDto

Employee-safe view of one own active assignment; no other employees are exposed.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| dutyId | string(uuid) | required | server | Duty |
| dutyDate | string(date) | required | server | Duty date |
| shiftKind | ShiftKind | required | server | DAY or NIGHT |
| startsAt | string(date-time) | required | server | Concrete start |
| endsAt | string(date-time) | required | server | Concrete end |
| dutyRole | DutyRole | required | server | Employee's role for that duty |

MyMonthlyPlanResponseDto

One employee-visible published plan projection.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| planId | string(uuid) | required | server | Published monthly plan |
| project | ProjectSummaryDto | required | server | Employee's project for the month |
| monthStart | string(date) | required | server | Planning month |
| duties | MyDutyResponseDto[] | required | server | Only the authenticated employee's duties |

MyMonthlyPlansResponseDto   ·   GET /api/v1/me/monthly-plans

Collection wrapper; a month filter typically yields zero or one item because an employee has at most one project per month.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| items | MyMonthlyPlanResponseDto[] | required | server | Employee-safe monthly plans |

## 8. Cancellation and replacement DTOs

CreateCancellationRequestDto   ·   POST /api/v1/cancellation-requests

Employee requests cancellation of one own active duty assignment.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| assignmentId | string(uuid) | required | client | Own DutyAssignment to cancel |

Design note: employeeId is derived from the authenticated identity and never accepted as authority from the request.

ReplacementNeedSummaryDto

Compact need state nested in cancellation responses.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | ReplacementNeed ID |
| status | ReplacementNeedStatus | required | server | Current need state |
| resolvedAt | string(date-time) \| null | required | server | Resolution time |

CancellationRequestResponseDto   ·   GET/POST /api/v1/cancellation-requests...

Canonical cancellation projection for admin and self-service reads.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | Cancellation request ID |
| assignmentId | string(uuid) | required | server | Historical/current assignment reference |
| employee | EmployeeIdentitySummaryDto | required | server | Requesting employee |
| duty | DutySummaryDto | required | server | Affected duty |
| status | CancellationStatus | required | server | OPEN/WITHDRAWN/REJECTED/APPROVED/OBSOLETE |
| createdAt | string(date-time) | required | server | Creation timestamp |
| decidedAt | string(date-time) \| null | required | server | Final decision timestamp |
| replacementNeed | ReplacementNeedSummaryDto | required | server | Need created together with valid request |

| Withdraw<br>POST /cancellation-requests/{requestId}/withdraw has no request body and returns CancellationRequestResponseDto after the state transition. |
| --- |


CancellationDecisionRequestDto   ·   POST /api/v1/cancellation-requests/{requestId}/decision

Single server-side command for reject/approve and optional replacement selection.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| decision | CancellationDecision | required | client | APPROVE or REJECT |
| replacementOfferId | string(uuid) | optional | client | Optional on APPROVE; absent means approved but staffing need may remain OPEN_UNFILLED |

Design note: OBSOLETE is server-derived when the underlying planning state invalidates the case; clients cannot request it.

CancellationDecisionResponseDto

Post-command state without requiring the client to reconstruct the transaction result.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| cancellation | CancellationRequestResponseDto | required | server | Updated request |
| selectedOffer | ReplacementOfferResponseDto \| null | required | server | Selected replacement, if any |
| updatedDuty | MonthlyPlanEntryResponseDto \| null | required | server | Updated planning unit when a replacement was atomically applied |

ReplacementOfferResponseDto   ·   GET /api/v1/replacement-needs/{needId}/offers

Offer projection for admin candidate list and employee status.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | Offer ID |
| needId | string(uuid) | required | server | Replacement need |
| employee | EmployeeIdentitySummaryDto | required | server | Offering employee |
| status | ReplacementOfferStatus | required | server | OPEN/SELECTED/NOT_SELECTED/INVALIDATED/WITHDRAWN |
| createdAt | string(date-time) | required | server | Offer creation |
| decidedAt | string(date-time) \| null | required | server | Selection/finalization time |

ReplacementNeedResponseDto   ·   GET /api/v1/replacement-needs/{needId}

Replacement-need projection used by eligible employee/admin reads.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| id | string(uuid) | required | server | Need ID |
| cancellationRequestId | string(uuid) | required | server | Originating cancellation request |
| duty | DutySummaryDto | required | server | Duty requiring replacement |
| status | ReplacementNeedStatus | required | server | OPEN/OPEN_UNFILLED/RESOLVED/CLOSED |
| resolvedAt | string(date-time) \| null | required | server | Resolution time |
| openOfferCount | integer | required | server | Derived count useful for admin/read UI |

MyReplacementNeedResponseDto

Employee-safe eligible-need read model with own-offer state.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| need | ReplacementNeedResponseDto | required | server | Eligible need |
| myOffer | ReplacementOfferResponseDto \| null | required | server | Authenticated employee's offer if one already exists |

MyReplacementNeedsResponseDto   ·   GET /api/v1/me/replacement-needs

Eligible replacement needs for the authenticated employee.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| items | MyReplacementNeedResponseDto[] | required | server | Only needs for which the server determined eligibility/visibility |

| Create replacement offer<br>POST /replacement-needs/{needId}/offers has no request body: needId comes from the path and employee identity is server-derived. It returns ReplacementOfferResponseDto. |
| --- |


## 9. Read-model DTOs

MyWorkItemsResponseDto   ·   GET /api/v1/me/work-items

Employee dashboard/status aggregation without creating a second write model.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| cancellationRequests | CancellationRequestResponseDto[] | required | server | Own cancellation cases |
| replacementOffers | ReplacementOfferResponseDto[] | required | server | Own replacement offers |

AdminWorkQueueItemDto

Normalized work-queue projection for open cancellation/replacement work.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| type | string enum | required | server | CANCELLATION_REQUEST or REPLACEMENT_NEED |
| cancellationRequestId | string(uuid) | required | server | Originating cancellation |
| replacementNeedId | string(uuid) | required | server | Related need |
| duty | DutySummaryDto | required | server | Affected duty |
| requestingEmployee | EmployeeIdentitySummaryDto | required | server | Employee who submitted cancellation |
| cancellationStatus | CancellationStatus | required | server | Current request status |
| replacementNeedStatus | ReplacementNeedStatus | required | server | Current need status |
| openOfferCount | integer | required | server | Open candidate count |
| createdAt | string(date-time) | required | server | Queue ordering timestamp |

AdminWorkQueueResponseDto   ·   GET /api/v1/admin/work-queue

Read-only aggregation for UC-14.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| items | AdminWorkQueueItemDto[] | required | server | Open work items only |

PlanningStatisticsResponseDto   ·   GET /api/v1/me/planning-statistics

Plan-based statistics for the authenticated employee; not time tracking.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| monthStart | string(date) | required | server | Requested month |
| plannedWorkdays | integer | required | server | Distinct planned duty dates |
| dayShiftCount | integer | required | server | Active DAY assignments |
| nightShiftCount | integer | required | server | Active NIGHT assignments |

## 10. Collection response rule

CollectionResponseDto<T>

Interim collection wrapper used by GET list endpoints in 8.3.

| Field | API type | Presence | Controlled by | Meaning / rule |
| --- | --- | --- | --- | --- |
| items | T[] | required | server | Result items |

Design note: Page/limit/total/cursor metadata is intentionally not frozen here; Phase 8.8 owns pagination/query contracts.

GET /employees → CollectionResponseDto<EmployeeResponseDto>

GET /projects → CollectionResponseDto<ProjectResponseDto>

GET /project-assignments → CollectionResponseDto<ProjectAssignmentResponseDto>

GET /monthly-plans → CollectionResponseDto<MonthlyPlanResponseDto>

GET /monthly-plans/{planId}/entries → CollectionResponseDto<MonthlyPlanEntryResponseDto>

GET /cancellation-requests → CollectionResponseDto<CancellationRequestResponseDto>

GET /replacement-needs/{needId}/offers → CollectionResponseDto<ReplacementOfferResponseDto>

## 11. Endpoint-to-DTO contract matrix

| Endpoint | Request DTO | Response DTO |
| --- | --- | --- |
| POST /auth/login | LoginRequestDto | MeResponseDto |
| POST /auth/logout | — | — |
| GET /me | — | MeResponseDto |
| POST /auth/activate | ActivateAccountRequestDto | — |
| POST /auth/password-reset-requests | PasswordResetRequestDto | — |
| POST /auth/password-resets | PasswordResetConfirmRequestDto | — |
| GET /employees | — | CollectionResponseDto<EmployeeResponseDto> |
| GET /employees/{employeeId} | — | EmployeeResponseDto |
| POST /employees | CreateEmployeeRequestDto | EmployeeResponseDto |
| PATCH /employees/{employeeId} | UpdateEmployeeRequestDto | EmployeeResponseDto |
| POST /employees/{employeeId}/deactivate | — | EmployeeResponseDto |
| GET /employees/{employeeId}/availability | — | CollectionResponseDto<AvailabilityDayResponseDto> |
| PUT /employees/{employeeId}/availability/{day} | SetAvailabilityDayRequestDto | AvailabilityDayResponseDto |
| DELETE /employees/{employeeId}/availability/{day} | — | — |
| GET /projects | — | CollectionResponseDto<ProjectResponseDto> |
| GET /projects/{projectId} | — | ProjectResponseDto |
| POST /projects | CreateProjectRequestDto | ProjectResponseDto |
| PATCH /projects/{projectId} | UpdateProjectRequestDto | ProjectResponseDto |
| GET /project-assignments | — | CollectionResponseDto<ProjectAssignmentResponseDto> |
| POST /project-assignments | CreateProjectAssignmentRequestDto | ProjectAssignmentResponseDto |
| PATCH /project-assignments/{assignmentId} | UpdateProjectAssignmentRequestDto | ProjectAssignmentResponseDto |
| GET /projects/{projectId}/shift-configuration | — | ProjectShiftConfigurationResponseDto |
| PATCH /projects/{projectId}/shift-configuration | UpdateProjectShiftConfigurationRequestDto | ProjectShiftConfigurationResponseDto |
| GET /monthly-plans | — | CollectionResponseDto<MonthlyPlanResponseDto> |
| GET /monthly-plans/{planId} | — | MonthlyPlanResponseDto |
| POST /monthly-plans | CreateMonthlyPlanRequestDto | MonthlyPlanResponseDto |
| GET /monthly-plans/{planId}/entries | — | CollectionResponseDto<MonthlyPlanEntryResponseDto> |
| POST /monthly-plans/{planId}/entries | CreateMonthlyPlanEntryRequestDto | MonthlyPlanEntryResponseDto |
| PATCH /monthly-plans/{planId}/entries/{entryId} | UpdateMonthlyPlanEntryRequestDto | MonthlyPlanEntryResponseDto |
| DELETE /monthly-plans/{planId}/entries/{entryId} | — | — |
| POST /monthly-plans/{planId}/publish | — | MonthlyPlanResponseDto |
| GET /me/monthly-plans | — | MyMonthlyPlansResponseDto |
| GET /cancellation-requests | — | CollectionResponseDto<CancellationRequestResponseDto> |
| GET /cancellation-requests/{requestId} | — | CancellationRequestResponseDto |
| POST /cancellation-requests | CreateCancellationRequestDto | CancellationRequestResponseDto |
| POST /cancellation-requests/{requestId}/withdraw | — | CancellationRequestResponseDto |
| POST /cancellation-requests/{requestId}/decision | CancellationDecisionRequestDto | CancellationDecisionResponseDto |
| GET /me/replacement-needs | — | MyReplacementNeedsResponseDto |
| GET /replacement-needs/{needId} | — | ReplacementNeedResponseDto |
| GET /replacement-needs/{needId}/offers | — | CollectionResponseDto<ReplacementOfferResponseDto> |
| POST /replacement-needs/{needId}/offers | — | ReplacementOfferResponseDto |
| GET /me/work-items | — | MyWorkItemsResponseDto |
| GET /admin/work-queue | — | AdminWorkQueueResponseDto |
| GET /me/planning-statistics | — | PlanningStatisticsResponseDto |

## 12. Representative JSON examples

### 12.1 Create employee

| {<br>  "employeeCode": "EMP-0042",<br>  "firstName": "Ahmed",<br>  "lastName": "Hassan",<br>  "email": "employee@example.invalid",<br>  "employmentStart": "2026-10-01",<br>  "shiftEligibility": "BOTH"<br>} |
| --- |


### 12.2 Employee response

| {<br>  "id": "5b77b1a0-5cc5-4d77-8c0f-6a15a72a7d36",<br>  "employeeCode": "EMP-0042",<br>  "firstName": "Ahmed",<br>  "lastName": "Hassan",<br>  "employmentStart": "2026-10-01",<br>  "employmentEnd": null,<br>  "shiftEligibility": "BOTH",<br>  "status": "ACTIVE",<br>  "email": "employee@example.invalid",<br>  "accountStatus": "PENDING_ACTIVATION"<br>} |
| --- |


### 12.3 Monthly-plan entry

| {<br>  "id": "9b98c1ea-a5db-49af-9c18-d75370472970",<br>  "dutyDate": "2026-10-12",<br>  "shiftKind": "DAY",<br>  "startsAt": "2026-10-12T04:00:00Z",<br>  "endsAt": "2026-10-12T16:00:00Z",<br>  "version": 3,<br>  "assignments": [<br>    {<br>      "id": "c3d49af3-d3fd-4bd3-a257-fce6fd939329",<br>      "employeeId": "5b77b1a0-5cc5-4d77-8c0f-6a15a72a7d36",<br>      "dutyRole": "EMPLOYEE",<br>      "source": "NORMAL"<br>    }<br>  ]<br>} |
| --- |


### 12.4 Cancellation decision with replacement

| {<br>  "decision": "APPROVE",<br>  "replacementOfferId": "4a64578d-b7aa-4572-8a6e-a2b9933a6c27"<br>} |
| --- |


## 13. Senior design review

| Review item | Result | Comment |
| --- | --- | --- |
| DTOs separated from persistence entities | PASS | No password hashes, token hashes, tenant FK plumbing, audit internals or DB-only fields leak into public DTOs. |
| Tenant isolation in contracts | PASS | companyId is not a client-controlled authorization input. |
| Employee vs Account separation | PASS | Separate persistence ownership preserved; Employee create provisions account through application workflow. |
| CR-01 | PASS | No replacement quota/counter appears in DTOs. |
| CR-03 | PASS | No re-publish request/DTO and no parallel-draft DTO semantics after initial publish. |
| Planning concurrency readiness | PASS | Duty version is exposed; write-precondition transport deferred to 8.7. |
| Privacy – SICK | PASS | Availability contains only day + SICK/LEAVE status; no diagnosis/free text. |
| Personal plan privacy | PASS | MyMonthlyPlan exposes only authenticated employee duties. |
| Replacement atomicity readiness | PASS | Decision DTO can carry optional selected offer in one server-side command. |
| Read models | PASS | Statistics and work queue remain read DTOs, not write-domain entities. |
| 8.2 endpoint consistency | CORRECTION RECORDED | A8.2-01 availability routes must be mirrored back into Phase 8.2 documentation. |

### 13.1 Gate decision

| PHASE 8.3 – COMPLETE · PASS FOR PHASE 8.4<br>The request/response DTO catalogue covers the Phase-8.2 API surface and records the missing availability route as a controlled 8.2 correction. No blocker remains for defining validation contracts. Before the final Phase-8 gate, the A8.2-01 availability routes must also be reflected in the canonical Phase-8.2 endpoint document. |
| --- |


## 14. Handoff to Phase 8.4 – Validation Contracts

Define syntactic validation for every request field: required/optional, format, enum membership, length and array cardinality.

Define cross-field rules: employmentEnd >= employmentStart, monthStart is first day of month, NIGHT interval rules, decision/replacementOfferId combinations.

Separate transport validation from business/state validation.

Map validation/business conflicts to the future error contract without exposing sensitive existence information.

Define validation for correction-only ProjectAssignment updates and published-plan direct mutation under CR-03.

Define password policy checks without adding arbitrary composition rules.

## 15. Source basis

SecurePlan – Phase 2 Requirements Engineering, FINAL Requirements Specification & Baseline v1.1.

SecurePlan – Phase 3 Scope & MVP, FINAL v1.1.

SecurePlan – Baseline Amendment v1.2 / CR-01 Ersatzlimit-Entfernung.

SecurePlan – CR-02 B2B-SaaS Tenant Model v1.1 FINAL / APPROVED.

SecurePlan – CR-03 Direct Published Plan Updates v1.0 FINAL / APPROVED.

SecurePlan – Phase 4 Systemanalyse FINAL v1.2, including CL-04-01 and CL-04-02.

SecurePlan – Phase 6.6 Consolidated Architecture Baseline & Final Phase-6 Gate.

SecurePlan – Phase 7 Database Design FINAL v1.0.

SecurePlan – Phase 8.2 REST Endpoint Design v1.0 plus A8.2-01 correction recorded in this document.
