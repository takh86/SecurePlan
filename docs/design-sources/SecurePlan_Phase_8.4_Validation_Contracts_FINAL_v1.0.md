# SecurePlan_Phase_8.4_Validation_Contracts_FINAL_v1.0

> Designquelle: SecurePlan_Phase_8.4_Validation_Contracts_FINAL_v1.0.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan - Phase 8.4

Validation Contracts

Request validation, cross-field rules and business-state guards

| Document | SecurePlan - Phase 8.4 Validation Contracts |
| --- | --- |
| Version | v1.0 FINAL |
| Status | COMPLETE - PASS FOR PHASE 8.5 |
| Date | 06.10.2026 |
| API base | /api/v1 |
| Input baseline | Phase 8.3 DTO Design v1.0 + approved SecurePlan baselines |
| Scope | DTO syntax, structural validation, cross-field validation and business-state validation |
| Next | Phase 8.5 - Error Handling & Error Contract |

| Key principle<br>Validation is layered. Transport validation answers whether the request is structurally valid. Cross-field validation checks relationships inside the payload. Business-state validation verifies the request against tenant-scoped current system state. Authorization, error-body format, concurrency headers and query/pagination design remain in later Phase-8 subphases. |
| --- |


## 1. Why Phase 8.4 exists

Phase 8.3 defined the shape of the API. Phase 8.4 defines what values and state combinations are accepted. Without an explicit validation contract, client behavior, backend rules, database constraints and tests drift apart.

Reject malformed data before it reaches domain logic.

Express cross-field rules explicitly instead of hiding them in ad-hoc service code.

Revalidate state-dependent rules at the time of the write, not only in the frontend.

Keep database constraints as the final integrity safety net, not as the only validation layer.

Turn every rule into a later API/integration test target.

| Baseline distinction<br>Rules marked 'Baseline' are directly supported by approved project artifacts. Rules marked 'D-8.4' are design decisions introduced in this phase to complete the public API contract. They are not presented as older requirements. |
| --- |


### 1.1 Validation layers

| Layer | Purpose |
| --- | --- |
| L1 Transport | Type, required/optional, UUID/date/e-mail/enum format, length, unknown fields. |
| L2 Cross-field | Relationships inside one request, for example employmentEnd >= employmentStart. |
| L3 Business state | Tenant-scoped existence, lifecycle state, uniqueness, eligibility, workflow status. |
| DB safety net | UNIQUE, FK, CHECK and transaction constraints protect integrity against races or bugs. |

### 1.2 What is not frozen here

The final ApiErrorDto and stable error-code catalogue are Phase 8.5.

Authentication and authorization policy per endpoint are Phase 8.6.

If-Match/version and Idempotency-Key transport are Phase 8.7.

Query filters, pagination, sorting and search limits are Phase 8.8.

OpenAPI annotations and generated schemas are Phase 8.9.

## 2. Global request validation contract

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| Unknown JSON fields | Rejected. DTO whitelist is strict; clients may not send undeclared properties. | Prevents accidental mass-assignment and silently ignored client mistakes. | D-8.4-01 |
| Required field | Must be present and must not be null unless the DTO explicitly allows null. | Required text must remain non-empty after trimming. | D-8.4-02 |
| Optional PATCH field | May be omitted. If present, it must pass the same type/format rules as on create. | An empty PATCH object is invalid. Omitted means 'leave unchanged'. | D-8.4-03 |
| Nullable field | Explicit null is accepted only where Phase 8.3 declared '\| null'. | Null means 'clear the stored optional value'; omission means 'do not change'. | D-8.4-04 |
| string | UTF-8 JSON string. Business text is trimmed at both ends; control characters are rejected. | Internal whitespace is preserved unless a field-specific rule says otherwise. | D-8.4-05 |
| secret/token/password | String is not auto-trimmed or case-normalized. | Never logged in raw form; storage rules are outside DTO validation. | Baseline + D-8.4 |
| UUID | Canonical UUID string accepted; malformed UUID rejected. | Existence and tenant ownership are L3 checks, not syntax checks. | D-8.4-06 |
| date | Exact YYYY-MM-DD and a real Gregorian calendar date. | No implicit timezone conversion for calendar dates. | D-8.4-07 |
| monthStart | Valid date and day-of-month must be 01. | Revalidated wherever month-scoped uniqueness or project assignment is involved. | Baseline |
| local time | Canonical HH:mm, 24-hour clock. | Converted to concrete duty instants using project/company timezone when a Duty is created. | D-8.4-08 |
| enum | Case-sensitive technical API value from the declared enum only. | UI localization does not change transport enum values. | D-8.4-09 |
| array | Must be a JSON array. Duplicate logical keys are rejected where stated. | No silent deduplication; client must correct the payload. | D-8.4-10 |

### 2.1 Product-level text limits introduced in 8.4

| Field | Min chars | Max chars | Rule |
| --- | --- | --- | --- |
| employeeCode | 1 | 30 | Trimmed; ASCII letters/digits plus '-', '_', '.'; unique inside tenant. |
| firstName | 2 | 50 | Unicode names allowed; spaces, apostrophes and hyphens allowed; no control chars. |
| lastName | 2 | 50 | Same rule as firstName. |
| project.name | 2 | 100 | Unicode printable text; tenant-wide uniqueness is business validation. |
| email | 3 | 254 | Validated with an e-mail parser; do not rely on a brittle hand-written regex. |
| password | 15 | 128 | Minimum is baseline; 128 is an 8.4 defensive API cap and still supports >=64. |

| Name length decision<br>The user suggested a minimum of about three characters. The final API uses 2 instead of 3 because legitimate international names can be two characters long. The 50-character maximum is retained for first/last name. This is a Phase-8.4 design decision, not an older requirement. |
| --- |


## 3. Authentication and account validation

### 3.1 LoginRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| email | Required string; trim; valid e-mail; max 254. | Normalize for lookup. Validation must not reveal whether an account exists. | D-8.4 |
| password | Required string; 15..128 characters; do not trim or normalize. | Login still performs credential verification and throttling. No composition rule such as mandatory number/symbol. | Baseline + D-8.4 |

### 3.2 ActivateAccountRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| token | Required non-empty opaque string; max 2048; no trimming/case normalization. | Token must match ACTIVATION purpose, account, not be expired and not already used. | Baseline + D-8.4 |
| password | Required; 15..128 characters. | Reject common/compromised passwords. On success store Argon2id hash; raw password never persisted/logged. | Baseline + D-8.4 |

### 3.3 PasswordResetRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| email | Required; valid e-mail; max 254. | The operation returns a neutral result whether or not a matching account exists. | Baseline |

### 3.4 PasswordResetConfirmRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| token | Required non-empty opaque string; max 2048. | Must be RESET purpose, unexpired and unused. | Baseline + D-8.4 |
| newPassword | Required; 15..128 characters. | Reject common/compromised passwords. Successful reset invalidates other open reset tokens and existing sessions. | Baseline + D-8.4 |

| Password baseline<br>SecurePlan requires at least 15 characters, supports at least 64 characters, does not require arbitrary upper/lower/number/symbol composition, and rejects common or compromised passwords. The 128-character API maximum is introduced here as a defensive request-boundary decision. |
| --- |


## 4. Employee and availability validation

### 4.1 CreateEmployeeRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| employeeCode | Required string; trim; 1..30; pattern [A-Za-z0-9][A-Za-z0-9._-]*. | Must be unique within authenticated company. | Baseline + D-8.4 |
| firstName | Required string; trim; 2..50; must not become empty. | No semantic/business lookup required. | D-8.4 |
| lastName | Required string; trim; 2..50; must not become empty. | No semantic/business lookup required. | D-8.4 |
| email | Required string; trim; valid e-mail; max 254. | Normalized e-mail must be unique inside the company account namespace. | Baseline + D-8.4 |
| employmentStart | Optional valid date. | May be past, current or future; no invented 'must be today' rule. | D-8.4 |
| shiftEligibility | Required enum DAY \| NIGHT \| BOTH. | Server stores only declared enum value. | Baseline |
| create operation | Body must contain only declared fields. | Server generates IDs/tenant context, Employee starts ACTIVE, linked Account uses server-controlled EMPLOYEE role and activation lifecycle. | 8.3 + D-8.4 |

### 4.2 UpdateEmployeeRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| employeeCode | Optional; same lexical rule as create. | If changed, new code must remain unique inside company; old/new value is audit-relevant. | Baseline |
| firstName / lastName | Optional; same 2..50 rules. | At least one field in PATCH must be present. | D-8.4 |
| email | Optional; valid e-mail; max 254. | New normalized e-mail must be unique. Verification/account consequences are applied consistently by Identity module. | Baseline + D-8.4 |
| employmentStart | Optional date or null. | If both employmentStart and effective employmentEnd are known, end must be >= start. | D-8.4 |
| employmentEnd | Optional date or null. | If both dates are known, end must be >= start. Clearing with null is allowed. | Baseline + D-8.4 |
| shiftEligibility | Optional DAY \| NIGHT \| BOTH. | If changed, existing/future planning that would become invalid must be detected before commit. | Baseline + D-8.4 |

### 4.3 Deactivate employee action

| Input | Syntactic / structural validation | Business-state validation | Decision source |
| --- | --- | --- | --- |
| employeeId path | Valid UUID. | Employee must exist in tenant and not already be INACTIVE. | D-8.4 |
| deactivation state | No request body. | D-8.4 decision: deactivation is blocked while unresolved future active DutyAssignments would be left invalid. Admin must resolve those assignments first. Historical rows remain. | D-8.4-11 |

### 4.4 Availability

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| employeeId path | Valid UUID. | Employee must belong to tenant. Historical correction remains allowed even if employee is currently inactive. | D-8.4 |
| day path | Valid YYYY-MM-DD. | One availability marker per employee/day; PUT replaces the marker for that day. | Baseline + D-8.4 |
| status | Required enum SICK \| LEAVE. | No diagnosis, symptom or free-text field is accepted. | Baseline |
| DELETE day | Valid employeeId + date. | Existing marker may be removed as an administrative correction; no hard delete of employee/history is implied. | D-8.4 |

## 5. Project, assignment and shift-configuration validation

### 5.1 Project DTOs

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| CreateProject.name | Required string; trim; 2..100. | Name must be unique inside current company. | Baseline + D-8.4 |
| UpdateProject.name | Optional; same 2..100 rules. | If changed, tenant-wide uniqueness still applies. | Baseline + D-8.4 |
| UpdateProject.status | Optional enum ACTIVE \| INACTIVE. | INACTIVE blocks new month assignments, new plans and future shift-configuration writes; historical data remain readable. ACTIVE reactivation is allowed. | D-8.4-12 |
| UpdateProject PATCH | At least one declared field must be present. | Unknown fields are rejected. | D-8.4 |

### 5.2 CreateProjectAssignmentRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| employeeId | Required UUID. | Employee must belong to tenant and be ACTIVE for a new operational assignment. | Baseline + D-8.4 |
| projectId | Required UUID. | Project must belong to tenant and be ACTIVE. | Baseline + D-8.4 |
| monthStart | Required date; day must be 01. | Employee may have at most one project assignment for that month. | Baseline |
| tuple | All three fields required. | The combination must not conflict with existing month assignment or planning consistency. | Baseline |

### 5.3 UpdateProjectAssignmentRequestDto - correction only

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| employeeId / projectId / monthStart | Each optional; if present UUID/date format applies; monthStart day=01. | At least one field required. Revalidate the complete resulting Employee + Project + Month tuple. | 8.3 + D-8.4 |
| correction safety | No free-form reason field in current DTO. | Correction must preserve historical consistency. If existing plan/duty assignments would become invalid, reject this endpoint-level correction and require planning to be corrected first. | D-8.4-13 |
| historical correction | Same syntax. | Inactive Employee/Project may be referenced only for a genuine historical correction where the target period already belongs to that history and no current/future operational state is made invalid. | D-8.4-14 |

### 5.4 UpdateProjectShiftConfigurationRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| effectiveFromMonth | Required date; day=01. | Configuration version is unique per project + shiftKind + effective month. | Baseline |
| shifts | Required array; 1..2 items. | shiftKind values inside one request must be unique. | D-8.4 |
| shiftKind | Required DAY \| NIGHT. | Must be a shift kind supported by SecurePlan MVP. | Baseline |
| startLocal / endLocal | Required HH:mm; valid 24-hour time; values must differ. | DAY may end later same day. NIGHT may wrap to the following day. Computed duration must be >0 and <=24h. | Baseline + D-8.4 |
| configuration state | All rows structurally valid. | Project must exist and be ACTIVE. Planning uses the configuration effective for the duty's month/date. | Baseline + D-8.4 |

## 6. Monthly planning validation

### 6.1 CreateMonthlyPlanRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| projectId | Required UUID. | Project must belong to tenant and be ACTIVE. | Baseline + D-8.4 |
| monthStart | Required date; day=01. | At most one MonthlyPlan for company + project + month. | Baseline |
| create state | Only declared fields. | Server creates status UNPUBLISHED. No client-supplied publishedAt/status. | Baseline + 8.3 |

### 6.2 DutyAssignmentInputDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| employeeId | Required UUID. | Employee must exist in tenant, be ACTIVE, be assigned to this project for the plan month, and be eligible for the shift. | Baseline |
| dutyRole | Required EMPLOYEE \| SHIFT_LEAD. | Role is duty-scoped, not a permanent account role. | Baseline |
| array uniqueness | No duplicate employeeId inside one duty payload. | One active DutyAssignment per Duty + Employee. | Baseline + D-8.4 |
| availability/conflict | No extra input field. | Employee must not be SICK/LEAVE on the duty date and must not have a conflicting/overlapping active duty assignment. | Baseline |

### 6.3 CreateMonthlyPlanEntryRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| dutyDate | Required valid date. | Must fall inside the MonthlyPlan month. | D-8.4 |
| shiftKind | Required DAY \| NIGHT. | Must exist in the project's effective shift configuration for that period. | Baseline |
| assignments | Optional array; empty array allowed; each item validates as DutyAssignmentInputDto. | All employees are revalidated against project month, shift eligibility, availability and overlap. | Baseline + D-8.4 |
| derived times | Client does not send startsAt/endsAt. | Server derives concrete instants from project shift configuration and timezone; computed endsAt must be > startsAt. | Baseline |

### 6.4 UpdateMonthlyPlanEntryRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| PATCH body | At least one of dutyDate, shiftKind, assignments must be present. | Resulting Duty aggregate is validated as a whole, not field-by-field only. | D-8.4 |
| dutyDate | Optional valid date. | If changed, must remain inside the plan month; all assignment availability/conflict checks are rerun. | D-8.4 |
| shiftKind | Optional DAY \| NIGHT. | If changed, effective project configuration and each employee's shiftEligibility are rerun. | Baseline |
| assignments | Optional array; empty means intentionally unstaffed; duplicates rejected. | If present, it represents the desired current active assignment set. Removed rows remain historical in persistence. | 8.3 + Baseline |
| PUBLISHED plan | Same request shape. | CR-03: authorized changes to a PUBLISHED plan are allowed directly, but every changed rule is revalidated before commit; no re-publish step is created. | CR-03 |

### 6.5 Delete entry and initial publish actions

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| DELETE entryId | Valid planId and entryId UUIDs; no body. | Entry must belong to plan/tenant. Any linked open cancellation/replacement state must be reconciled consistently; endpoint may not orphan workflow data. | Baseline + D-8.4 |
| POST publish | Valid planId UUID; no body. | Plan must be UNPUBLISHED. Revalidate every duty/assignment against project, month assignment, shift config, ACTIVE employee, eligibility, SICK/LEAVE and overlap rules before first publication. | Baseline + CR-03 |
| repeat publish | Same path syntax. | A PUBLISHED plan is not re-published under CR-03; this action is invalid for the already-PUBLISHED lifecycle state. | CR-03 |

| No invented staffing minimum<br>The approved baselines do not define a universal minimum number of employees or shift leaders per monthly Duty in the internship MVP. Phase 8.4 therefore does not invent such a constraint. Project-specific staffing rules would need an explicit requirement/change request. |
| --- |


## 7. Cancellation and replacement workflow validation

### 7.1 CreateCancellationRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| assignmentId | Required UUID. | Assignment must belong to authenticated employee, be ACTIVE and belong to a currently PUBLISHED plan. | Baseline |
| duplicate open request | No extra input field. | At most one OPEN cancellation request for the same assignment. Valid creation atomically creates exactly one OPEN ReplacementNeed. | Baseline |
| plan changed | Syntax can still be valid. | If assignment/plan changed so the request is no longer valid, do not create a duplicate/stale case. | Baseline |

### 7.2 Withdraw cancellation action

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| requestId | Valid UUID; no body. | Request must belong to authenticated employee and have status OPEN. | Baseline |
| workflow result | No client-supplied target statuses. | Successful withdrawal -> cancellation WITHDRAWN, need CLOSED, open offers INVALIDATED. Original assignment remains ACTIVE. | Baseline |

### 7.3 CancellationDecisionRequestDto

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| decision | Required APPROVE \| REJECT. | CancellationRequest must currently be OPEN. | Baseline + 8.3 |
| replacementOfferId | Optional UUID. | If decision=REJECT, replacementOfferId must be omitted. If decision=APPROVE, it may be omitted or reference one valid OPEN offer of the same ReplacementNeed. | D-8.4-15 |
| approve with offer | Valid UUID if supplied. | Revalidate candidate immediately: same tenant/need, offer OPEN, employee ACTIVE, correct project month, shift eligible, not SICK/LEAVE, no conflicting duty. Then select exactly one offer. | Baseline |
| approve without offer | replacementOfferId omitted. | Allowed: cancellation APPROVED, original assignment removed, need becomes OPEN_UNFILLED. | Baseline |
| reject | No offer ID. | Cancellation REJECTED, need CLOSED, open offers NOT_SELECTED; original assignment stays ACTIVE. | Baseline |

### 7.4 Create replacement offer action

| Field / operation | Syntactic / structural validation | Cross-field / business-state validation | Decision source |
| --- | --- | --- | --- |
| needId path | Valid UUID; no body. | Need must belong to tenant and be OPEN or OPEN_UNFILLED. | Baseline + D-8.4 |
| candidate identity | Derived from authenticated employee, never client-supplied. | Employee must be ACTIVE, project-month eligible, shift eligible, available and conflict-free. | Baseline |
| duplicate offer | No body field. | Same employee may not have another OPEN/SELECTED offer for same need. | Baseline |
| self-replacement | No body field. | D-8.4 decision: the employee whose cancellation created the need cannot submit an offer to replace the same assignment. | D-8.4-16 |
| quota | No quota field. | No monthly replacement-takeover quota is evaluated; CR-01 removed the fixed limit. | CR-01 |

## 8. Common path and read-endpoint validation

| Input | Validation contract |
| --- | --- |
| {employeeId}, {projectId}, {assignmentId}, {planId}, {entryId}, {requestId}, {needId} | Must be valid UUID before service lookup. |
| {day} | Must be valid YYYY-MM-DD. |
| GET list/read endpoints | No request body. Query validation is intentionally finalized in Phase 8.8. |
| GET /me/* | No client-supplied employeeId; identity comes from authenticated server context. |
| Tenant-scoped resource lookup | A syntactically valid ID is not enough; server lookup remains constrained by derived company context. |

| Tenant isolation is not a DTO trick<br>companyId is not accepted as a trust-bearing request field. The server derives tenant context from the authenticated account and every business lookup/write is scoped to that tenant. A valid UUID from another company must never make the request valid. |
| --- |


## 9. NestJS implementation mapping

This section translates the contract into implementation intent without starting feature implementation.

| Mechanism | Expected approach |
| --- | --- |
| Global ValidationPipe | transform enabled where safe; whitelist=true; forbidNonWhitelisted=true; forbidUnknownValues=true. |
| Strings | Use IsString plus explicit trim transform for business text; do not trim passwords/tokens. |
| Lengths | Length / MinLength / MaxLength according to this contract. |
| E-mail | Use a maintained e-mail validator; normalize server-side. |
| UUID | IsUUID for request/path DTOs or equivalent ParseUUIDPipe. |
| Dates | Custom strict YYYY-MM-DD parser/validator; reject impossible dates; separate IsMonthStart validator. |
| Local time | Custom strict HH:mm validator. |
| Enums | IsEnum with technical enum types. |
| PATCH | Custom AtLeastOneField validator. |
| Arrays | ValidateNested(each=true), Type(...), ArrayUnique on employeeId/shiftKind where relevant. |
| Cross-field | Class-level/custom validators for employment date order and conditional decision/offer rule. |
| Business state | Application/domain service checks inside the same transaction boundary as the write. |

| Important<br>Database exceptions are not the normal validation UX. The application should pre-check meaningful business rules, while UNIQUE/FK/CHECK constraints still protect correctness under races. Phase 8.5 will map failures to a stable client-facing error contract. |
| --- |


## 10. Validation traceability matrix

| Invariant | Where validated | Protection |
| --- | --- | --- |
| Employee code uniqueness | Create/Update Employee | DB UNIQUE + tenant-scoped service check |
| Employee/account e-mail uniqueness | Create/Update Employee | Identity service + DB UNIQUE |
| Employment date order | Update Employee | Cross-field + DB/application rule |
| One project per employee/month | ProjectAssignment | DB UNIQUE + service check |
| Month is first day | ProjectAssignment / MonthlyPlan / ShiftConfig | DTO validator + DB CHECK where modeled |
| Project shift configuration | ShiftConfig / Duty | DTO + service lookup |
| Employee ACTIVE | Planning / replacement | Service validation |
| Project-month assignment | Planning / replacement | Service validation |
| Shift eligibility | Planning / replacement | Service validation |
| SICK/LEAVE exclusion | Planning / replacement | Service validation |
| No active duplicate DutyAssignment | Planning | DB partial UNIQUE + service |
| One OPEN cancellation per assignment | Cancellation | DB partial UNIQUE + service |
| One Need per cancellation | Cancellation | DB UNIQUE + transaction |
| One active offer per employee/need | Replacement | DB partial UNIQUE + service |
| At most one selected offer per need | Decision | DB partial UNIQUE + transaction |
| CR-03 direct published mutation | Plan update | State validation; no re-publish |
| CR-01 no replacement quota | Replacement | No validator/counter exists |

## 11. Minimum validation test catalogue for Phase 13

| ID | Scenario | Expected validation result |
| --- | --- | --- |
| V-001 | Create employee with empty firstName | reject |
| V-002 | Two-character valid firstName | accept |
| V-003 | Duplicate employeeCode in same company | reject |
| V-004 | Same employeeCode in different company | isolation rule allows independently |
| V-005 | Invalid e-mail | reject |
| V-006 | Password with 14 characters | reject |
| V-007 | 15-character password without symbol/number | may pass composition rule |
| V-008 | employmentEnd before employmentStart | reject |
| V-009 | monthStart=2026-10-02 | reject |
| V-010 | Employee assigned to second project same month | reject |
| V-011 | Duplicate shiftKind in one shift config request | reject |
| V-012 | Duty date outside plan month | reject |
| V-013 | Same employee twice in one Duty | reject |
| V-014 | NIGHT-ineligible employee on NIGHT duty | reject |
| V-015 | SICK employee selected for duty/replacement | reject |
| V-016 | Second OPEN cancellation for same assignment | reject/no duplicate |
| V-017 | Withdraw non-OPEN cancellation | reject |
| V-018 | REJECT with replacementOfferId | reject |
| V-019 | APPROVE without replacementOfferId | accept -> OPEN_UNFILLED |
| V-020 | Replacement candidate becomes unavailable before final selection | reject at revalidation |
| V-021 | Fourth/fifth/etc. replacement takeover in month | no quota rejection |
| V-022 | PATCH {} | reject |
| V-023 | Unknown JSON property | reject |
| V-024 | Cross-tenant UUID in tenant endpoint | must not become valid |

## 12. Phase-8.4 design decisions introduced here

| Decision | Final rule |
| --- | --- |
| D-8.4-01 | Strict unknown-field rejection. |
| D-8.4-03 | Empty PATCH object invalid. |
| D-8.4-05 | Trim business text; do not trim secrets. |
| D-8.4-08 | Canonical API local-time input HH:mm. |
| D-8.4-11 | Employee deactivation blocked if unresolved future active DutyAssignments would be left invalid. |
| D-8.4-12 | Inactive project blocks new assignments/plans/future shift config while preserving history. |
| D-8.4-13 | ProjectAssignment correction rejected if it would invalidate existing planning; planning must be fixed first. |
| D-8.4-15 | REJECT forbids replacementOfferId; APPROVE may omit it. |
| D-8.4-16 | Original cancellation requester cannot offer to replace the same assignment. |
| D-8.4-LIMITS | Names 2..50, project name 2..100, employeeCode 1..30, e-mail <=254, password <=128. |

These decisions complete the API contract and can be changed later only through normal design/change control. They are deliberately separated from source-derived requirements so future reviewers can see what was newly decided in Phase 8.4.

## 13. Senior review and phase gate

| Gate criterion | Result |
| --- | --- |
| All Phase-8.3 request DTOs covered | PASS |
| Path/action validation covered | PASS |
| Cross-field rules explicit | PASS |
| Business-state rules mapped | PASS |
| CR-01 respected | PASS |
| CR-03 respected | PASS |
| Tenant context remains server-derived | PASS |
| Privacy for SICK/LEAVE respected | PASS |
| Password baseline respected | PASS |
| No error-body design pulled forward | PASS |
| No authorization matrix pulled forward | PASS |
| Concurrency transport deferred to 8.7 | PASS |

| PHASE 8.4 - FINAL / PASS<br>Validation Contracts are sufficiently complete for the current MVP API surface. No blocker remains for Phase 8.5 - Error Handling & Error Contract. The previously recorded Phase-8.2 availability-route correction still has to be mirrored into the canonical Phase-8.2 endpoint artifact before the final Phase-8 closure gate. |
| --- |


## 14. Handoff to Phase 8.5 - Error Handling & Error Contract

Define one stable ApiErrorDto envelope.

Separate field/format validation errors from domain/state conflicts.

Define stable machine-readable error codes.

Decide safe 404/403 concealment behavior for tenant-sensitive resources.

Map duplicate/constraint/concurrency failures without leaking internal SQL details.

Define correlation/request ID exposure for troubleshooting.

Define examples for frontend form errors and workflow conflicts.

## 15. Normative/source basis used

SecurePlan - Phase 2 Requirements Baseline v1.1 FINAL.

SecurePlan - Phase 3 Scope & MVP v1.1 FINAL.

SecurePlan - Baseline Amendment v1.2 / CR-01 Ersatzlimit-Entfernung.

SecurePlan - CR-02 B2B SaaS Tenant Model v1.1 FINAL / APPROVED.

SecurePlan - CR-03 Direct Published Plan Updates v1.0 FINAL / APPROVED.

SecurePlan - Phase 4 Systemanalyse FINAL v1.2 including CL-04-01 and CL-04-02.

SecurePlan - Phase 6 Security/Architecture baseline including password and token rules.

SecurePlan - Phase 7 Database Design FINAL v1.0.

SecurePlan - Phase 8.3 DTO Design FINAL v1.0.
