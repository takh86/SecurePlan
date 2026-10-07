# SecurePlan_Phase_8.5_Error_Handling_Error_Contract_FINAL_v1.0

> Designquelle: SecurePlan_Phase_8.5_Error_Handling_Error_Contract_FINAL_v1.0.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan - Phase 8.5

Error Handling & Error Contract

RFC 9457 Problem Details, stable error codes, centralized mapping and security-safe diagnostics

| Document | SecurePlan - Phase 8.5 Error Handling & Error Contract |
| --- | --- |
| Version | v1.0 FINAL |
| Status | COMPLETE - PASS FOR PHASE 8.6 |
| Date | 06.10.2026 |
| API base | /api/v1 |
| Canonical media type | application/problem+json |
| Primary standard | RFC 9457 - Problem Details for HTTP APIs |
| Architecture baseline | Phase 6.7 API & Integration Architecture FINAL v1.0 |
| Input design | Phase 8.4 Validation Contracts FINAL v1.0 |
| Next | Phase 8.6 - Authentication & Authorization API Rules |

| Phase decision<br>SecurePlan adopts RFC 9457 Problem Details as the canonical HTTP API error representation. HTTP status codes describe the error class; stable SecurePlan application codes describe the exact problem. All errors are serialized centrally, carry a correlation identifier, and expose only safe client-facing information. |
| --- |


## Contents

| Section | Topic |
| --- | --- |
| 1 | Purpose, scope and governing principles |
| 2 | 8.5.1 HTTP status mapping |
| 3 | 8.5.2 Stable Error Code Catalog |
| 4 | 8.5.3 RFC 9457 Problem Details schema |
| 5 | Field-level validation error contract |
| 6 | 8.5.4 Error Mapping & Exception Strategy |
| 7 | Database and concurrency error mapping |
| 8 | 8.5.5 Correlation IDs, logging and security-safe messages |
| 9 | Client handling and localization rules |
| 10 | Contract tests and acceptance matrix |
| 11 | Design decisions |
| 12 | Final review and Phase 8.5 gate |
| 13 | Handoff to Phase 8.6 |
| 14 | Normative and external source basis |

| Scope boundary<br>Phase 8.5 defines how API failures are represented and mapped. Detailed endpoint authorization remains Phase 8.6; If-Match/version and Idempotency-Key transport details remain Phase 8.7; query/pagination errors remain Phase 8.8; OpenAPI annotations and contract publication remain Phase 8.9. |
| --- |


## 1. Purpose, scope and governing principles

A production-style API contract must make failures predictable for clients without exposing implementation details. SecurePlan therefore treats error handling as a contract, not as ad-hoc exception text. The API separates transport validation, security decisions, business-state conflicts, persistence races and unexpected server failures.

RFC 9457 is the canonical representation for API problem responses.

The HTTP status communicates the broad class of failure.

A stable machine-readable SecurePlan code communicates the exact application problem.

The frontend must never parse title/detail text to make business decisions.

Cross-tenant or intentionally hidden resources are represented as 404 to prevent information leakage.

Known business and concurrency conflicts are explicit; unknown failures are never guessed into a business error.

Stack traces, SQL, database constraint names, secrets and raw security tokens never appear in client responses.

| Approved architecture alignment<br>Phase 6.7 already requires semantic HTTP status codes, stable machine-readable application error codes, safe messages and a Correlation ID. It also fixes the 403/404 information boundary and requires sanitized handling of unexpected failures. |
| --- |


## 2. 8.5.1 - HTTP status mapping

SecurePlan keeps the MVP status model intentionally small. Invalid transport/input contracts use 400. A request that is syntactically valid but conflicts with current business or concurrency state uses 409. HTTP 422 is deliberately not introduced.

| HTTP status | SecurePlan use | Representative codes |
| --- | --- | --- |
| 400 Bad Request | Malformed JSON, DTO/schema validation, invalid field combination, invalid date/month input. | VALIDATION_FAILED, INVALID_REQUEST_BODY, INVALID_DATE, EMPTY_PATCH |
| 401 Unauthorized | Authentication is missing or no longer valid. | INVALID_CREDENTIALS, SESSION_REQUIRED, SESSION_EXPIRED, SESSION_REVOKED |
| 403 Forbidden | Actor is authenticated and the resource/context is visible, but the requested action is forbidden. | ACTION_FORBIDDEN, CSRF_VALIDATION_FAILED |
| 404 Not Found | Resource does not exist OR must remain invisible to the actor, including cross-tenant resources. | RESOURCE_NOT_FOUND |
| 409 Conflict | Current business state, uniqueness, workflow state, concurrency token or idempotency state prevents the operation. | PROJECT_ASSIGNMENT_CONFLICT, CANCELLATION_ALREADY_RESOLVED, PLAN_CONCURRENT_MODIFICATION |
| 429 Too Many Requests | Configured throttling/rate limit has been exceeded. | LOGIN_RATE_LIMITED, RATE_LIMITED |
| 500 Internal Server Error | Unexpected application/infrastructure failure. Client receives no implementation internals. | INTERNAL_ERROR |

| No HTTP 422 in the MVP<br>The approved architecture already chose a simpler split: invalid request/input -> 400; structurally valid request that collides with current business/concurrency state -> 409. This document keeps that decision. |
| --- |


| 415 note<br>Unsupported request Content-Type is an HTTP protocol concern and may be rejected by the web framework/reverse proxy as 415. It is not added to the SecurePlan business error catalogue in this phase because the MVP endpoints consume JSON only and the existing Phase 6.7 error-class baseline does not require a separate application code for it. |
| --- |


## 3. 8.5.2 - Stable Error Code Catalog

Application codes use UPPER_SNAKE_CASE and are part of the public API contract. A code keeps its semantic meaning for the lifetime of API v1. Human-readable text may improve or be localized; clients must continue to branch on the code/type, not the text.

Do not expose PostgreSQL SQLSTATE values, table names or constraint names as public error codes.

Do not create a new code when an existing code has the same meaning.

Resource existence is intentionally generalized to RESOURCE_NOT_FOUND when visibility must be concealed.

Field validator subcodes are separate from top-level application codes.

### 3.1 Transport and validation

| Code | HTTP | Meaning |
| --- | --- | --- |
| VALIDATION_FAILED | 400 | One or more request fields violate the DTO/validation contract. |
| INVALID_REQUEST_BODY | 400 | Malformed JSON or request body cannot be parsed into the declared contract. |
| INVALID_DATE | 400 | Date value is malformed or not a real calendar date. |
| INVALID_MONTH_START | 400 | Month-scoped date is valid but not the first day of a month. |
| UNKNOWN_FIELD | 400 | Request contains a property not declared by the DTO contract. |
| EMPTY_PATCH | 400 | PATCH request contains no mutable field. |
| INVALID_FIELD_COMBINATION | 400 | Fields are individually valid but their combination is invalid. |

Field-level validation subcodes used inside errors[]:

| Subcode | Meaning |
| --- | --- |
| REQUIRED | Required value missing/null. |
| INVALID_TYPE | JSON value has the wrong primitive/container type. |
| INVALID_FORMAT | Value has an invalid e-mail/date/time/identifier format. |
| INVALID_UUID | Identifier is not a valid UUID. |
| INVALID_ENUM | Value is not part of the declared enum. |
| TOO_SHORT | String/collection is shorter than the contract allows. |
| TOO_LONG | String/collection exceeds the contract limit. |
| OUT_OF_RANGE | Numeric/range constraint failed. |
| DUPLICATE_ITEM | Array contains a duplicate logical item. |

### 3.2 Authentication and security

| Code | HTTP | Meaning |
| --- | --- | --- |
| INVALID_CREDENTIALS | 401 | Login failed. Message remains generic and does not reveal which credential was wrong. |
| SESSION_REQUIRED | 401 | Protected endpoint called without an authenticated session. |
| SESSION_EXPIRED | 401 | Session exceeded its expiry/inactivity policy. |
| SESSION_REVOKED | 401 | Server-side session was revoked. |
| ACTION_FORBIDDEN | 403 | Authenticated actor can see the context/resource but may not perform this action. |
| CSRF_VALIDATION_FAILED | 403 | Unsafe browser request failed CSRF/origin protection. |
| RESOURCE_NOT_FOUND | 404 | Resource does not exist or is intentionally hidden from this actor/tenant. |
| LOGIN_RATE_LIMITED | 429 | Login throttling currently blocks another attempt. |
| RATE_LIMITED | 429 | Generic configured API throttling limit exceeded. |

### 3.3 Employee and account

| Code | HTTP | Meaning |
| --- | --- | --- |
| EMPLOYEE_CODE_ALREADY_EXISTS | 409 | employeeCode is already used inside the tenant. |
| EMAIL_ALREADY_IN_USE | 409 | Normalized e-mail is already used in the tenant account namespace. |
| EMPLOYEE_INACTIVE | 409 | Operation requires an active employee. |
| EMPLOYEE_HAS_FUTURE_ASSIGNMENTS | 409 | Deactivation would leave unresolved future active planning state. |
| EMPLOYMENT_DATE_CONFLICT | 400 | employmentEnd is before employmentStart. |
| PASSWORD_POLICY_VIOLATION | 400 | Password fails length/common/compromised-password policy. |
| ACTIVATION_TOKEN_INVALID_OR_EXPIRED | 400 | Activation token is invalid, expired, used or wrong-purpose; response does not reveal account existence. |
| RESET_TOKEN_INVALID_OR_EXPIRED | 400 | Password-reset token is invalid, expired, used or wrong-purpose. |

### 3.4 Project, assignment and shift configuration

| Code | HTTP | Meaning |
| --- | --- | --- |
| PROJECT_NAME_ALREADY_EXISTS | 409 | Project name violates tenant-scoped uniqueness. |
| PROJECT_INACTIVE | 409 | Operation requires an active project. |
| PROJECT_ASSIGNMENT_ALREADY_EXISTS | 409 | Equivalent employee/project/month assignment already exists. |
| PROJECT_ASSIGNMENT_CONFLICT | 409 | Employee is already assigned to another project for the target month. |
| PROJECT_ASSIGNMENT_CORRECTION_CONFLICT | 409 | Correction would invalidate existing planning/history invariants. |
| SHIFT_CONFIGURATION_INVALID | 400 | Shift configuration payload or time relationship is invalid. |
| SHIFT_CONFIGURATION_CONFLICT | 409 | Requested configuration conflicts with persisted/effective configuration state. |
| SHIFT_CONFIGURATION_MISSING | 409 | A duty requires a project shift configuration that is not available for the target period. |

### 3.5 Monthly planning

| Code | HTTP | Meaning |
| --- | --- | --- |
| MONTHLY_PLAN_ALREADY_EXISTS | 409 | Company/project/month already has a MonthlyPlan. |
| MONTHLY_PLAN_ALREADY_PUBLISHED | 409 | Initial publish command was invoked on an already published plan. |
| DUTY_ALREADY_EXISTS | 409 | Plan already contains the same date + shift duty. |
| DUTY_DATE_OUTSIDE_PLAN_MONTH | 400 | dutyDate is not inside the MonthlyPlan month. |
| EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH | 409 | Employee is not assigned to the plan project for that month. |
| EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT | 409 | Employee shiftEligibility does not permit the requested shift. |
| EMPLOYEE_UNAVAILABLE | 409 | Employee is SICK/LEAVE on the duty date or otherwise not available. |
| DUTY_ASSIGNMENT_CONFLICT | 409 | Employee has a conflicting/overlapping active duty assignment. |
| PLAN_CONCURRENT_MODIFICATION | 409 | Expected Duty version no longer matches current state. |

### 3.6 Cancellation and replacement workflow

| Code | HTTP | Meaning |
| --- | --- | --- |
| CANCELLATION_ALREADY_EXISTS | 409 | An OPEN cancellation already exists for the assignment. |
| CANCELLATION_ALREADY_RESOLVED | 409 | Cancellation is no longer OPEN and cannot be decided again. |
| CANCELLATION_NOT_WITHDRAWABLE | 409 | Cancellation current state does not permit withdrawal. |
| CANCELLATION_ASSIGNMENT_NOT_ACTIVE | 409 | Referenced assignment is no longer active. |
| CANCELLATION_PLAN_CHANGED | 409 | Plan changed so the cancellation request is no longer valid. |
| REPLACEMENT_NEED_NOT_OPEN | 409 | ReplacementNeed is no longer OPEN/OPEN_UNFILLED for this action. |
| REPLACEMENT_OFFER_ALREADY_EXISTS | 409 | Employee already has an active offer for this need. |
| REPLACEMENT_OFFER_NOT_SELECTABLE | 409 | Offer is no longer OPEN/valid for final selection. |
| REPLACEMENT_CANDIDATE_INELIGIBLE | 409 | Candidate fails project-month or shift eligibility at current state. |
| REPLACEMENT_CANDIDATE_UNAVAILABLE | 409 | Candidate is unavailable at final validation. |
| REPLACEMENT_SELF_OFFER_NOT_ALLOWED | 409 | Original cancellation requester cannot offer to replace the same assignment. |

| CR-01 guardrail<br>There is intentionally no REPLACEMENT_MONTHLY_LIMIT_REACHED error. CR-01 removed the fixed monthly replacement takeover quota, so neither backend validation nor client error messaging may reintroduce such a limit. |
| --- |


### 3.7 Idempotency, throttling and internal failure

| Code | HTTP | Meaning |
| --- | --- | --- |
| IDEMPOTENCY_KEY_REQUIRED | 400 | A command that explicitly requires an idempotency key was called without one. Exact command list is finalized in 8.7. |
| IDEMPOTENCY_KEY_INVALID | 400 | Idempotency key violates the accepted transport format/limit. |
| IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST | 409 | Same idempotency key was reused for a different logical request. |
| INTERNAL_ERROR | 500 | Unexpected unclassified server failure. Safe generic client message only. |

## 4. 8.5.3 - RFC 9457 Problem Details schema

Every SecurePlan API problem response uses Content-Type application/problem+json. RFC 9457 standard members are combined with small SecurePlan extensions. Clients must tolerate future additive extension members within API v1.

| Member | Type | SecurePlan contract |
| --- | --- | --- |
| type | string (URI reference) | Required by SecurePlan contract. Stable identifier for the problem type. Production type paths are served under /problems/{slug} on the API origin and should resolve to short documentation. |
| title | string | Required. Short stable summary for the problem type; may be localized, but semantics stay unchanged. |
| status | integer | Required. Must equal the actual HTTP response status for this occurrence. |
| detail | string | Required. Safe, human-readable, occurrence-specific and actionable where possible. Never intended for machine parsing. |
| instance | string (URI reference) | Required. Identifies the specific occurrence as /problems/occurrences/{correlationId}; it need not be dereferenceable. |
| code | string | Required SecurePlan extension. Stable UPPER_SNAKE_CASE application code. |
| correlationId | string | Required SecurePlan extension. Opaque diagnostic identifier; clients treat it as an opaque string. |
| errors | array | Optional SecurePlan/RFC-style extension for validation suberrors. Omit when there are no suberrors; do not emit an empty array. |

Representative business conflict:

| HTTP/1.1 409 Conflict<br>Content-Type: application/problem+json<br>X-Correlation-Id: 01J9XYZ123<br><br>{<br>  "type": "/problems/employee-code-already-exists",<br>  "title": "Employee code already exists",<br>  "status": 409,<br>  "detail": "An employee with this code already exists. Use a different employee code.",<br>  "instance": "/problems/occurrences/01J9XYZ123",<br>  "code": "EMPLOYEE_CODE_ALREADY_EXISTS",<br>  "correlationId": "01J9XYZ123"<br>} |
| --- |


| Type URI decision<br>RFC 9457 allows URI references. SecurePlan uses stable /problems/{slug} paths so the final production origin is not hard-coded into the application code during design. The deployed API should make these paths resolve to lightweight problem documentation. |
| --- |


## 5. Field-level validation error contract

Validation responses use the top-level code VALIDATION_FAILED and an optional errors[] collection. For JSON body errors, a JSON Pointer locates the invalid value. Path/query/header errors use location + parameter because they are not part of the JSON request body.

| Member | Rule |
| --- | --- |
| code | Required stable validation subcode such as REQUIRED, INVALID_FORMAT or TOO_LONG. |
| detail | Required safe field-level explanation. The UI may replace/localize it; clients do not parse it. |
| pointer | Body validation only. JSON Pointer fragment such as #/assignments/0/employeeId. |
| location | Non-body validation only. One of path, query, header. |
| parameter | Non-body validation only. Public API parameter/header name. |

| {<br>  "type": "/problems/validation-failed",<br>  "title": "Validation failed",<br>  "status": 400,<br>  "detail": "One or more fields are invalid.",<br>  "instance": "/problems/occurrences/01J9VAL123",<br>  "code": "VALIDATION_FAILED",<br>  "correlationId": "01J9VAL123",<br>  "errors": [<br>    {<br>      "pointer": "#/email",<br>      "code": "INVALID_FORMAT",<br>      "detail": "Enter a valid email address."<br>    },<br>    {<br>      "pointer": "#/assignments/0/employeeId",<br>      "code": "INVALID_UUID",<br>      "detail": "Employee ID must be a valid UUID."<br>    }<br>  ]<br>} |
| --- |


| {<br>  "type": "/problems/validation-failed",<br>  "title": "Validation failed",<br>  "status": 400,<br>  "detail": "One or more request parameters are invalid.",<br>  "instance": "/problems/occurrences/01J9PATH456",<br>  "code": "VALIDATION_FAILED",<br>  "correlationId": "01J9PATH456",<br>  "errors": [<br>    {<br>      "location": "path",<br>      "parameter": "employeeId",<br>      "code": "INVALID_UUID",<br>      "detail": "Employee ID must be a valid UUID."<br>    }<br>  ]<br>} |
| --- |


| No rejectedValue<br>errors[] never echoes the rejected input value. This avoids accidentally reflecting passwords, e-mail addresses, tokens or other sensitive/user-controlled values into browser consoles, telemetry, support systems or screenshots. |
| --- |


When multiple validators fail for the same field, return the most actionable error rather than a noisy cascade. Suggested priority:

| REQUIRED -> INVALID_TYPE -> INVALID_FORMAT / INVALID_ENUM -> TOO_SHORT / TOO_LONG -> cross-field rule |
| --- |


## 6. 8.5.4 - Error Mapping & Exception Strategy

Error handling is centralized. Controllers do not contain repeated try/catch blocks whose only purpose is translating domain or infrastructure failures into HTTP. Each layer reports errors in its own language; the HTTP boundary owns final RFC 9457 serialization.

| HTTP Request<br>  -> DTO / ValidationPipe<br>  -> Security Pipeline<br>  -> Controller (thin)<br>  -> Application Service / Use Case<br>  -> Domain<br>  -> Repository / PostgreSQL<br>  -> typed error or unexpected exception<br>  -> Central Error Mapper<br>  -> Global Exception Filter<br>  -> RFC 9457 response |
| --- |


| Core rule<br>Domain/Application logic does not depend on NestJS HttpException subclasses. The domain describes what went wrong; the API adapter decides how that problem is represented over HTTP. |
| --- |


| Source | Internal representation | HTTP result | Owner of mapping |
| --- | --- | --- | --- |
| Transport / DTO | Validation exception/result | 400 VALIDATION_FAILED | Global validation/problem factory |
| Authentication | Typed security outcome | 401 | Security pipeline -> central mapper |
| Authorization / visibility | Typed security outcome | 403 or concealed 404 | Security pipeline -> central mapper |
| Business rule/state | Typed ApplicationError / domain error | 409 | Application/domain -> central mapper |
| Known DB integrity race | Repository/infrastructure maps recognized constraint | 409 or known contract status | Repository adapter -> central mapper |
| Optimistic concurrency | Typed PlanConcurrentModificationError | 409 | Application/infrastructure -> central mapper |
| Unexpected failure | Unknown exception | 500 INTERNAL_ERROR | Global filter last-resort fallback |

### 6.1 Typed application errors

Avoid a generic BusinessException("something failed") model. Use a small base abstraction plus typed errors or discriminated typed error objects so tests and mapping remain explicit.

| ApplicationError<br>  \|- EmployeeInactiveError<br>  \|- ProjectAssignmentConflictError<br>  \|- EmployeeUnavailableError<br>  \|- CancellationAlreadyResolvedError<br>  \|- ReplacementOfferNotSelectableError<br>  \|- PlanConcurrentModificationError |
| --- |


The typed error carries stable internal semantics, not HTTP response formatting.

The central mapper contains the explicit error -> status/code/type/title mapping.

Unknown error classes are not silently converted into a 409; they fall through to INTERNAL_ERROR.

### 6.2 Controller rule

| // Desired controller responsibility (conceptual)<br>@Post()<br>create(@Body() dto: CreateEmployeeRequestDto) {<br>  return this.createEmployee.execute(dto);<br>} |
| --- |


| Forbidden pattern<br>Do not repeat controller-level catch blocks for validation, business conflicts, database exceptions or internal errors. Local try/catch is acceptable only when the controller itself genuinely owns a protocol-specific recovery decision, which is rare here. |
| --- |


## 7. Database and concurrency error mapping

Application pre-checks provide good UX, but database constraints remain the final race-safe integrity barrier. Persistence adapters map only recognized integrity failures. Raw driver messages are never forwarded to the client.

| Persistence situation | Mapping rule | Client result |
| --- | --- | --- |
| Recognized tenant employeeCode uniqueness race | Repository identifies the known unique constraint/SQLSTATE in a driver-specific adapter. | 409 EMPLOYEE_CODE_ALREADY_EXISTS |
| Recognized employee/month assignment uniqueness race | Map to application conflict. | 409 PROJECT_ASSIGNMENT_CONFLICT |
| Recognized active-offer uniqueness race | Map to duplicate offer conflict. | 409 REPLACEMENT_OFFER_ALREADY_EXISTS |
| Conditional Duty.version update affects 0 rows | Map to typed concurrency error. | 409 PLAN_CONCURRENT_MODIFICATION |
| Unknown SQL/driver/connection failure | Do not infer business meaning. Log internally with correlation ID. | 500 INTERNAL_ERROR |

| Do not parse raw DB text in controllers<br>Driver/ORM-specific mapping belongs inside the persistence adapter. Prefer stable SQLSTATE plus explicitly recognized constraint identity over brittle substring matching of human-readable database messages. |
| --- |


### 7.1 Idempotency interaction

| Situation | Error-contract behavior |
| --- | --- |
| Same key + same logical operation + same request | Not an error. Return/replay the same logical result according to Phase 8.7 storage/transport rules. |
| Same key + different request | 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST. |
| Missing required key on a command finalized as idempotency-protected | 400 IDEMPOTENCY_KEY_REQUIRED. |
| Invalid key format/size | 400 IDEMPOTENCY_KEY_INVALID. |

Exact Idempotency-Key header format, retention and command coverage are deliberately finalized in Phase 8.7, not here.

## 8. 8.5.5 - Correlation IDs, logging and security-safe messages

Every inbound API request receives one server-side correlation identifier before security/business processing. The value is propagated through request-scoped logging and is returned in the X-Correlation-Id response header. Problem responses also repeat it in correlationId.

### 8.1 Correlation ID contract

| Rule | Decision |
| --- | --- |
| Generation | Server guarantees an identifier for every request. The concrete generator (UUID/ULID/trace ID) is not a client contract; clients treat it as opaque. |
| Incoming header | If an upstream trusted component supplies X-Correlation-Id, accept only a bounded safe ASCII value; otherwise generate a new server value. Direct client input is never trusted as log structure. |
| Response header | Return X-Correlation-Id on success and error responses where the application can produce a response. |
| Problem body | correlationId equals the response header value. |
| Propagation | Pass through application context and outbound integrations/log records. Do not use it as authorization, tenancy or idempotency input. |
| Future tracing | Phase 6.9/observability may map the same request to W3C trace context/OpenTelemetry. That does not change the public semantics of correlationId. |

### 8.2 Structured logging policy

Logs are structured and keyed by correlationId. Log the route template rather than blindly logging raw URLs/query strings, and never log entire request bodies for authentication/reset/activation flows.

| Problem class | Logging guideline |
| --- | --- |
| 400 validation | DEBUG/INFO or metric, depending on environment/volume. No stack trace for expected user mistakes. |
| 401 authentication | Security telemetry as appropriate; avoid logging credential values. Repeated failures feed throttling/monitoring. |
| 403 authorization | WARN/INFO security event depending on context; include actor/tenant/resource identifiers only when safe for internal logs. |
| 404 | Usually INFO/DEBUG. Cross-tenant probes may be security telemetry; client response remains indistinguishable from a missing resource. |
| 409 business conflict | INFO; WARN only when operationally meaningful. No stack trace for expected state conflicts. |
| 429 | WARN/metric/security telemetry with rate-limit category; never echo credential/token values. |
| 500 unexpected | ERROR with internal exception type + stack trace + correlationId. Response remains sanitized. |

### 8.3 Sensitive data denylist

| Never expose/log raw | Examples |
| --- | --- |
| Authentication | password, newPassword, passwordHash, raw credentials |
| Sessions | Cookie values, session IDs/tokens, Authorization header credentials |
| Security links | Raw activation tokens, password-reset tokens, MFA recovery codes |
| Browser security | Raw CSRF token values |
| Database internals | SQL text containing sensitive values, raw driver error dumps in client response |
| Documents/future scope | Payroll/PDF contents and other sensitive document payloads |

| Sanitization rule<br>Client-facing problem details are not a debugging channel. Full technical diagnostics belong only in protected internal telemetry. Even internal logs should record only the minimum context required to diagnose the failure. |
| --- |


### 8.4 Security-safe and actionable client messages

| Situation | Safe client message style | Security/UX reason |
| --- | --- | --- |
| Invalid credentials | "The e-mail address or password is incorrect." | Do not reveal which credential/account check failed. |
| Reset request | Neutral success flow, not an existence error. | Prevents account enumeration. |
| Invalid reset/activation token | "The link is invalid or has expired." | Do not distinguish invalid/expired/used/wrong-account in client text. |
| Cross-tenant resource | "The requested resource was not found." | Do not reveal that the resource exists for another company. |
| Business conflict | Explain current state and next action, e.g. reload, choose another employee, resolve future assignments. | Actionable without internals. |
| Unexpected 500 | "An unexpected error occurred. Please try again later." + correlationId. | No stack trace, SQL or provider details. |

## 9. Client handling and localization rules

The frontend treats code/type as the stable machine contract. title/detail are display/help text and may change or be localized without requiring client logic changes.

Frontend branching: use code (and HTTP status where useful), never regex/substring matching on detail.

German is the initial product UI language. The frontend should own polished user-facing localization for common codes.

API title/detail may use a stable default language; future Accept-Language localization is additive and must not change code/type semantics.

Do not display raw API detail blindly in high-sensitivity flows if the UI has a safer product-specific message.

A 409 PLAN_CONCURRENT_MODIFICATION should trigger a reload/reconcile UX, not a generic "Server error" toast.

A 404 RESOURCE_NOT_FOUND should not cause the UI to infer whether the ID is cross-tenant or truly absent.

| RFC principle<br>The detail member is human-readable and occurrence-specific; it is not a machine-parsing field. Stable extensions such as code/errors[] carry machine-readable semantics for SecurePlan. |
| --- |


### 9.1 Canonical examples

Concurrency conflict:

| {<br>  "type": "/problems/plan-concurrent-modification",<br>  "title": "Plan was modified",<br>  "status": 409,<br>  "detail": "The plan was changed by another operation. Reload the current state and try again.",<br>  "instance": "/problems/occurrences/01J9CON789",<br>  "code": "PLAN_CONCURRENT_MODIFICATION",<br>  "correlationId": "01J9CON789"<br>} |
| --- |


Secure concealed 404:

| {<br>  "type": "/problems/resource-not-found",<br>  "title": "Resource not found",<br>  "status": 404,<br>  "detail": "The requested resource was not found.",<br>  "instance": "/problems/occurrences/01J9NF404",<br>  "code": "RESOURCE_NOT_FOUND",<br>  "correlationId": "01J9NF404"<br>} |
| --- |


Unexpected server failure:

| {<br>  "type": "/problems/internal-error",<br>  "title": "Internal server error",<br>  "status": 500,<br>  "detail": "An unexpected error occurred. Please try again later.",<br>  "instance": "/problems/occurrences/01J9ERR500",<br>  "code": "INTERNAL_ERROR",<br>  "correlationId": "01J9ERR500"<br>} |
| --- |


## 10. Contract tests and acceptance matrix

These cases become API/integration/security tests in Phase 13 and are later documented in OpenAPI during Phase 8.9.

| ID | Scenario | Expected contract |
| --- | --- | --- |
| E-001 | Invalid e-mail/body field | 400 application/problem+json; code VALIDATION_FAILED; errors[] contains JSON pointer. |
| E-002 | Unknown JSON field such as companyId | 400 VALIDATION_FAILED/UNKNOWN_FIELD; value is not mass-assigned. |
| E-003 | Missing session on protected endpoint | 401 SESSION_REQUIRED; no protected data returned. |
| E-004 | Expired/revoked session | 401 SESSION_EXPIRED or SESSION_REVOKED. |
| E-005 | Employee invokes visible admin-only action | 403 ACTION_FORBIDDEN. |
| E-006 | Company A requests Company B resource ID | 404 RESOURCE_NOT_FOUND; response indistinguishable from truly absent ID. |
| E-007 | Duplicate employeeCode race reaches DB unique constraint | 409 EMPLOYEE_CODE_ALREADY_EXISTS; no SQL/constraint text in response. |
| E-008 | Employee already assigned to another project that month | 409 PROJECT_ASSIGNMENT_CONFLICT. |
| E-009 | Employee SICK/LEAVE for duty | 409 EMPLOYEE_UNAVAILABLE. |
| E-010 | Stale Duty version | 409 PLAN_CONCURRENT_MODIFICATION; no lost update. |
| E-011 | Cancellation already resolved | 409 CANCELLATION_ALREADY_RESOLVED. |
| E-012 | Replacement offer invalid at final selection | 409 REPLACEMENT_OFFER_NOT_SELECTABLE or specific candidate conflict. |
| E-013 | Same idempotency key + same request | No duplicate; same logical result per Phase 8.7. |
| E-014 | Same idempotency key + different request | 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST. |
| E-015 | Login throttled | 429 LOGIN_RATE_LIMITED. |
| E-016 | Unexpected repository/programming exception | 500 INTERNAL_ERROR; sanitized problem; internal ERROR log contains correlationId. |
| E-017 | Any problem response | HTTP Content-Type application/problem+json; body status equals HTTP status. |
| E-018 | Correlation contract | X-Correlation-Id header equals body correlationId on problem responses. |
| E-019 | Validation with several issues | errors[] contains useful non-duplicative suberrors; rejected values are absent. |
| E-020 | Client logic audit | Frontend decisions use code/type, not detail parsing. |
| E-021 | No HTTP 422 regression | Validation remains 400; business/concurrency state conflict remains 409. |
| E-022 | Cross-tenant negative suite | No response leaks whether a foreign-tenant resource exists. |

## 11. Phase 8.5 design decisions

| Decision | Final rule |
| --- | --- |
| D-8.5-01 | RFC 9457 Problem Details + application/problem+json is the canonical error representation. |
| D-8.5-02 | Centralized Error Mapping: a central mapper + global NestJS exception filter own HTTP problem serialization. |
| D-8.5-03 | Known vs unexpected failures: recognized validation/security/business/concurrency/persistence failures map explicitly; unknown failures -> sanitized 500 INTERNAL_ERROR. |
| D-8.5-04 | Controllers do not implement repetitive exception-to-HTTP try/catch mapping. |
| D-8.5-05 | SecurePlan extensions are stable code, correlationId and optional errors[]. |
| D-8.5-06 | Problem instances use /problems/occurrences/{correlationId}; type uses stable /problems/{slug} paths. |
| D-8.5-07 | Field-level validation uses JSON Pointer for body errors and location+parameter for non-body parameters; rejected values are never echoed. |
| D-8.5-08 | All application responses expose X-Correlation-Id when possible; problem bodies repeat the same opaque identifier. |
| D-8.5-09 | HTTP 422 is not introduced in MVP. Invalid input -> 400; current-state/concurrency conflict -> 409. |
| D-8.5-10 | Expected 4xx errors are not automatically logged as ERROR; unexpected 500 failures are ERROR-level with internal diagnostics. |
| D-8.5-11 | Frontend branches on stable code/type, not title/detail text. UI localization is independent from machine semantics. |

## 12. Senior review and Phase 8.5 gate

| Gate criterion | Result |
| --- | --- |
| RFC 9457 canonical representation defined | PASS |
| HTTP status mapping consistent with Phase 6.7 | PASS |
| Stable application error code catalogue defined | PASS |
| Validation suberror contract defined | PASS |
| 403/404 information boundary preserved | PASS |
| Concurrency 409 contract preserved | PASS |
| CR-01 replacement quota not reintroduced | PASS |
| CR-03 published-plan model not contradicted | PASS |
| Central mapping keeps Domain framework-agnostic | PASS |
| Known DB races vs unknown DB failure separated | PASS |
| Correlation ID contract defined | PASS |
| Safe logging/message rules defined | PASS |
| Stack traces/DB internals/secrets excluded from client | PASS |
| Contract/security negative tests enumerated | PASS |
| Authorization endpoint matrix deferred to 8.6 | PASS |
| Idempotency/concurrency transport detail deferred to 8.7 | PASS |

| PHASE 8.5 - FINAL / PASS<br>Error Handling & Error Contract is complete for the current MVP API surface. No blocking error-contract decision remains for Phase 8.6 - Authentication & Authorization API Rules. |
| --- |


| Phase-8 closure reminder<br>The Phase-8.2 availability-route correction (GET/PUT/DELETE employee availability day) remains a controlled backport requirement for the canonical Phase-8.2 endpoint artifact before the final Phase-8.11 gate. It is not an 8.5 blocker. |
| --- |


## 13. Handoff to Phase 8.6 - Authentication & Authorization API Rules

Map every protected endpoint to authentication requirement and actor capability.

Define COMPANY_ADMIN vs EMPLOYEE permissions and resource/ownership checks.

Apply tenant-derived context consistently; never trust companyId from client input.

Define /me authorization semantics and admin-only resource visibility.

Finalize 401 vs 403 vs concealed 404 outcomes endpoint-by-endpoint using this 8.5 contract.

Document CSRF/session integration for unsafe browser methods without duplicating business authorization logic.

## 14. Normative and external source basis

Project baselines used:

SecurePlan - Phase 2 Requirements Engineering FINAL v1.1 (Reliability, Error Handling, Audit/Logging).

SecurePlan - Phase 3 Scope & MVP FINAL v1.1.

SecurePlan - Baseline Amendment v1.2 / CR-01 and approved CR-01 replacement-limit removal.

SecurePlan - Phase 4 Systemanalyse FINAL (workflow/error scenarios).

SecurePlan - Phase 6.6 Security Architecture & RBAC FINAL v1.0.

SecurePlan - Phase 6.7 API & Integration Architecture FINAL v1.0.

SecurePlan - Phase 7 Database Design FINAL v1.0.

SecurePlan - Phase 8.3 DTO Design FINAL v1.0.

SecurePlan - Phase 8.4 Validation Contracts FINAL v1.0.

External standards / best-practice references:

IETF RFC 9457 - Problem Details for HTTP APIs (Standards Track, July 2023): https://www.rfc-editor.org/rfc/rfc9457.html

OWASP REST Security Cheat Sheet - input validation, safe content types, generic error handling and security logging guidance: https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html

OWASP Error Handling Cheat Sheet - avoid technical information disclosure through unhandled/client-visible errors: https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html
