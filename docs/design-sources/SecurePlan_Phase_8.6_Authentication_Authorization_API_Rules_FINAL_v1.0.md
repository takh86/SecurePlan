# SecurePlan_Phase_8.6_Authentication_Authorization_API_Rules_FINAL_v1.0

> Designquelle: SecurePlan_Phase_8.6_Authentication_Authorization_API_Rules_FINAL_v1.0.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan - Phase 8.6

Authentication & Authorization API Rules

Server-side sessions · Tenant isolation · RBAC + context · CSRF · Endpoint policy

| Document control | Value |
| --- | --- |
| Version | v1.0 FINAL |
| Status | COMPLETE - PASS FOR PHASE 8.7 |
| Date | 06.10.2026 |
| API base | /api/v1 |
| Architecture | NestJS/TypeScript · PostgreSQL · same-origin web app · server-side session |
| Inputs | Phase 4 System Analysis; Phase 6.6 Security Architecture & RBAC; Phase 6.7 API & Integration; Phase 6.8 Runtime; Phase 8.2-8.5 |
| Output | Canonical API authentication, authorization, tenant, CSRF and security policy contract |

| Phase objective<br>Phase 8.6 converts the already-approved security architecture into endpoint-level API rules. It does not redesign password hashing, database persistence or production operations; it defines exactly how API requests prove identity, establish tenant context, receive authorization and are rejected safely. |
| --- |


## 1. Best-practice baseline and non-negotiable principles

Authentication and authorization are server-side responsibilities. Hidden UI elements are not security controls.

SecurePlan uses server-side sessions, not JWT-only browser authentication.

Authorization is default-deny and combines role capability, tenant scope, resource ownership/scope and contextual permissions.

Tenant context is derived from the authenticated account/session; client-supplied company identifiers never switch tenant.

Unsafe cookie-authenticated requests require CSRF protection and trusted Origin validation.

Business validation happens after authorization; an authorized actor can still receive a 409 business-state conflict.

Purpose-specific DTOs expose only the minimum data required by the use case.

Platform control-plane identity does not imply operational tenant-data access.

| Source vs. new Phase-8.6 decisions<br>Rules explicitly inherited from Phase 6.6-6.8 are treated as normative baselines. Decisions introduced here are marked D-8.6-* and complete details deliberately deferred to Phase 8, especially the CSRF header/bootstrap mechanism and the endpoint authorization matrix. |
| --- |


## 2. 8.6.1 - Authentication contract

### 2.1 Server-side session

| Browser<br>  -> opaque session cookie<br>API<br>  -> session lookup<br>  -> Session ACTIVE and not expired<br>  -> Account ACTIVE<br>  -> Company ACTIVE<br>  -> derive TenantContext<br>  -> authorization policy<br>  -> application use case |
| --- |


The browser never receives an authorization-bearing JWT. The session identifier is an opaque random secret; effective permissions are recalculated from current server-side state for every protected request.

### 2.2 Login

| Endpoint | Auth state | Security rules | Success |
| --- | --- | --- | --- |
| POST /auth/login | Public | Validate credentials; generic failure message; progressive throttling; ACTIVE account/company required; MFA gate if required. | Create server-side session; set cookie; return safe identity context. |

Invalid e-mail and invalid password use the same external error semantics to prevent account enumeration.

PENDING_ACTIVATION and DEACTIVATED accounts do not receive an authenticated session.

A suspended Company cannot create a usable tenant session.

Session fixation is prevented by creating a fresh session identifier after successful authentication.

### 2.3 Session cookie contract

| Property | Production rule |
| --- | --- |
| Name | Prefer __Host-secureplan_session where runtime support permits. |
| Value | Opaque high-entropy session identifier only. |
| HttpOnly | true |
| Secure | true |
| SameSite | Lax |
| Path | / |
| Domain | Omit; host-only preferred. |
| Client-readable claims | None. No role/companyId/permissions in the cookie. |

### 2.4 /me, logout, activation and reset

| Endpoint | Rule |
| --- | --- |
| GET /me | Authenticated. Returns identity/UI context only; never becomes the authorization source. |
| POST /auth/logout | Authenticated. Revoke server-side session and clear browser cookie. |
| POST /auth/activate | Public token-based command. Opaque, one-time, purpose/account-bound, expiring token; only token hash persists. |
| POST /auth/password-reset-requests | Public. Always neutral response; do not disclose whether account exists. |
| POST /auth/password-resets | Public token-based command. On success invalidate other open reset tokens and revoke existing sessions. |

| Controlled security correction A8.6-01<br>Phase 8.3 currently allows email in UpdateEmployeeRequestDto. Directly replacing a login e-mail from the generic employee PATCH would create an account-takeover/re-verification ambiguity. For the MVP, email mutation is removed from generic PATCH /employees/{employeeId}. Creation may still provision the initial account e-mail. A future e-mail change requires a dedicated Identity flow with verification of the new address. This correction must be backported to Phase 8.3 before the Phase-8 final gate. |
| --- |


## 3. 8.6.2 - Central security pipeline

| Request<br>  -> Origin / CSRF protection where applicable<br>  -> Session resolution<br>  -> Session ACTIVE + not expired<br>  -> Account ACTIVE<br>  -> Company ACTIVE<br>  -> server-derived TenantContext<br>  -> coarse capability / role check<br>  -> resource scope + ownership<br>  -> contextual permission<br>  -> business preconditions<br>  -> application service |
| --- |


Controllers do not reproduce these checks independently. NestJS Guards/Policies may implement the pipeline, while business preconditions remain inside the owning application/domain module.

| Failure point | API result |
| --- | --- |
| Missing/invalid session | 401 SESSION_REQUIRED / INVALID_CREDENTIALS as applicable |
| Expired/revoked session | 401 SESSION_EXPIRED / SESSION_REVOKED |
| Authenticated actor lacks visible capability | 403 ACTION_FORBIDDEN |
| Resource absent or intentionally invisible/cross-tenant | 404 RESOURCE_NOT_FOUND |
| Authorized actor but current business state blocks operation | 409 domain-specific conflict |

## 4. 8.6.3 - Authorization model: RBAC + ownership + context

SecurePlan deliberately does not use pure RBAC. Role is only the coarse first gate. Final authorization is resource- and context-aware.

| ALLOW =<br>  authenticated session<br>  + active account/company<br>  + trusted TenantContext<br>  + coarse capability<br>  + resource ownership/scope<br>  + contextual permission<br>  + business preconditions<br><br>Default = DENY |
| --- |


### 4.1 Actor scopes

| Actor | API security scope | Key restriction |
| --- | --- | --- |
| COMPANY_ADMIN | Broad operational capability inside own Company. | Never cross-tenant; sensitive data remains purpose-limited. |
| EMPLOYEE | Self-service and explicitly eligible workflow resources. | No admin functions; no foreign personal plans/cases. |
| PLATFORM_ADMIN | Provider control-plane only. | No implicit access to tenant operational data or tenant audit. |
| SHIFT_LEAD context | Temporary duty-bound contextual permission only when that post-MVP vertical exists. | Not a permanent global account role; not used to widen current MVP endpoints. |

### 4.2 Named capability pattern

Best practice for the NestJS implementation is to centralize coarse permissions as named capabilities rather than scattering role string comparisons across controllers.

| Role | Representative capabilities |
| --- | --- |
| COMPANY_ADMIN | employees.manage, availability.manage, projects.manage, planning.manage, cancellations.manage, replacements.manage, workqueue.read |
| EMPLOYEE | self.plan.read, self.cancellation.create, self.cancellation.withdraw, replacement.offer.create, self.workitems.read, self.statistics.read |

These capabilities are code-level policy names for the MVP, not a new dynamic permission-table feature.

## 5. 8.6.4 - Endpoint authorization matrix

| Endpoint | Allowed actor | Additional authorization/context |
| --- | --- | --- |
| POST /auth/login | PUBLIC | No existing session required; Origin validation. |
| POST /auth/logout | AUTHENTICATED | Current session only; CSRF + Origin. |
| GET /me | AUTHENTICATED | Return current actor context only. |
| POST /auth/activate | PUBLIC | Valid activation token; Origin validation. |
| POST /auth/password-reset-requests | PUBLIC | Neutral response; Origin validation. |
| POST /auth/password-resets | PUBLIC | Valid reset token; Origin validation. |
| GET /employees | COMPANY_ADMIN | Own tenant only. |
| GET /employees/{employeeId} | COMPANY_ADMIN | Own tenant only. |
| POST /employees | COMPANY_ADMIN | Own tenant; provisions employee account. |
| PATCH /employees/{employeeId} | COMPANY_ADMIN | Own tenant; e-mail excluded by A8.6-01. |
| POST /employees/{employeeId}/deactivate | COMPANY_ADMIN | Own tenant; revoke affected account sessions. |
| GET /employees/{employeeId}/availability | COMPANY_ADMIN | Purpose-limited SICK/LEAVE only. |
| PUT /employees/{employeeId}/availability/{day} | COMPANY_ADMIN | CSRF + Origin; own tenant. |
| DELETE /employees/{employeeId}/availability/{day} | COMPANY_ADMIN | CSRF + Origin; own tenant. |
| GET /projects | COMPANY_ADMIN | Own tenant. |
| GET /projects/{projectId} | COMPANY_ADMIN | Own tenant. |
| POST /projects | COMPANY_ADMIN | CSRF + Origin. |
| PATCH /projects/{projectId} | COMPANY_ADMIN | CSRF + Origin. |
| GET /project-assignments | COMPANY_ADMIN | Own tenant. |
| POST /project-assignments | COMPANY_ADMIN | CSRF + Origin. |
| PATCH /project-assignments/{assignmentId} | COMPANY_ADMIN | Correction-only; CSRF + Origin. |
| GET /projects/{projectId}/shift-configuration | COMPANY_ADMIN | Own tenant. |
| PATCH /projects/{projectId}/shift-configuration | COMPANY_ADMIN | CSRF + Origin. |
| GET /monthly-plans | COMPANY_ADMIN | Own tenant. |
| GET /monthly-plans/{planId} | COMPANY_ADMIN | Own tenant. |
| POST /monthly-plans | COMPANY_ADMIN | CSRF + Origin. |
| GET /monthly-plans/{planId}/entries | COMPANY_ADMIN | Own tenant. |
| POST /monthly-plans/{planId}/entries | COMPANY_ADMIN | CSRF + Origin. |
| PATCH /monthly-plans/{planId}/entries/{entryId} | COMPANY_ADMIN | CSRF + Origin; concurrency rules later 8.7. |
| DELETE /monthly-plans/{planId}/entries/{entryId} | COMPANY_ADMIN | CSRF + Origin; workflow reconciliation. |
| POST /monthly-plans/{planId}/publish | COMPANY_ADMIN | Initial publish only; CSRF + Origin. |
| GET /me/monthly-plans | EMPLOYEE | Own published assignments only. |
| GET /cancellation-requests | COMPANY_ADMIN | Administrative tenant-wide list. |
| GET /cancellation-requests/{requestId} | COMPANY_ADMIN or OWNER EMPLOYEE | Employee can read own request; admin own tenant. |
| POST /cancellation-requests | EMPLOYEE | Own active assignment only; CSRF + Origin. |
| POST /cancellation-requests/{requestId}/withdraw | OWNER EMPLOYEE | Own OPEN request only; CSRF + Origin. |
| POST /cancellation-requests/{requestId}/decision | COMPANY_ADMIN | Own tenant; CSRF + Origin. |
| GET /me/replacement-needs | EMPLOYEE | Only needs visible/eligible to current employee. |
| GET /replacement-needs/{needId} | COMPANY_ADMIN or ELIGIBLE EMPLOYEE | Employee visibility is contextual; no general tenant browse. |
| GET /replacement-needs/{needId}/offers | COMPANY_ADMIN | Candidate list is administrative data. |
| POST /replacement-needs/{needId}/offers | EMPLOYEE | Current employee derived from session; eligibility rechecked; CSRF + Origin. |
| GET /me/work-items | EMPLOYEE | Own cancellation/offer state only. |
| GET /admin/work-queue | COMPANY_ADMIN | Own tenant administrative queue. |
| GET /me/planning-statistics | EMPLOYEE | Own plan-based statistics only. |

| No role union by accident<br>Current MVP accounts have one tenant role. COMPANY_ADMIN does not automatically inherit EMPLOYEE self-service routes. If the product later needs a person to act as both admin and employee, that requires an explicit role/capability model decision instead of silently widening permissions. |
| --- |


## 6. 8.6.5 - Tenant isolation and resource visibility

TenantContext is derived Session -> Account -> Company; companyId from body/query/path never becomes the trust source.

Every tenant repository/query path is scoped by tenant Company ID.

Reads, writes and cross-resource relations must all preserve tenant scope.

PLATFORM_ADMIN has no generic bypassTenantFilter path.

Cross-tenant resource identifiers are treated as not found to avoid data-existence leakage.

| Company A admin -> Company A employee     ALLOW<br>Company A admin -> Company B employee     404 RESOURCE_NOT_FOUND<br>Employee -> own plan                       ALLOW<br>Employee -> coworker personal plan         404 RESOURCE_NOT_FOUND<br>client body companyId=CompanyB             rejected/ignored as authority; no tenant switch |
| --- |


## 7. 8.6.6 - CSRF, Origin and browser request rules

Because authentication uses cookies, state-changing requests require explicit CSRF protection in addition to SameSite.

| Rule | Final API contract |
| --- | --- |
| Unsafe methods | POST / PUT / PATCH / DELETE must pass Origin policy; protected cookie-authenticated mutations additionally require CSRF token. |
| Safe methods | GET / HEAD / OPTIONS must be side-effect free. |
| CSRF header | D-8.6-08: X-CSRF-Token. |
| Token model | D-8.6-09: synchronizer token bound to the active server-side session. |
| Bootstrap | D-8.6-10: successful login and GET /me expose the current CSRF token in the X-CSRF-Token response header; no extra endpoint is required. |
| Origin | Exact configured same-origin value in normal deployment. Do not accept wildcard origins with credentials. |
| Public token commands | Login/activation/reset do not require session CSRF token, but browser POSTs still pass allowed-Origin validation. |

| Why this design<br>A synchronizer token is a natural fit for server-side sessions. Returning it in a response header avoids adding an undeclared JSON field to MeResponseDto and avoids a new CSRF endpoint. The session cookie remains HttpOnly; only the non-secret CSRF token is exposed to frontend JavaScript. |
| --- |


## 8. 8.6.7 - Session, account and company lifecycle

| Event | Required security behavior |
| --- | --- |
| Logout | Revoke current server-side session immediately and clear cookie. |
| Account deactivation | Revoke all active sessions for the account; later requests fail even if an old cookie remains. |
| Company suspension | Block login and protected tenant access; revoke active company sessions. |
| Password reset completed | Revoke existing sessions and invalidate other unused reset tokens. |
| Session expiration | Reject with 401 and require re-authentication. |
| Idle / absolute lifetime | Configurable; exact values remain implementation/production-hardening configuration. |
| Role change | Effective permissions change immediately because authorization is recalculated server-side per request. |

## 9. 8.6.8 - MFA and privileged accounts

TOTP is the selected MFA mechanism for privileged accounts.

COMPANY_ADMIN MFA is allowed as Stretch during the 12-week internship MVP but is mandatory before real Production go-live.

PLATFORM_ADMIN requires MFA whenever the role becomes productively available.

EMPLOYEE has no mandatory MFA in V1.

No MFA endpoints are silently added to the current Phase-8.2 MVP endpoint catalogue. If the Stretch is implemented, its API surface receives a controlled Phase-8 amendment and OpenAPI coverage.

| Production gate<br>A deployment with real customer data must not treat the internship deferral as removal of the requirement. Admin MFA remains a Production security gate. |
| --- |


## 10. 8.6.9 - Security events, audit and sensitive-data handling

| Stream | Examples | Do not include |
| --- | --- | --- |
| Security events | Login failure/success, MFA failure, rate limit, access denied, session revocation, suspicious cross-tenant attempt. | Passwords, raw session IDs, reset/activation tokens, TOTP secrets, recovery codes. |
| Business audit | Employee lifecycle, plan changes, cancellation/replacement decision, critical account lifecycle actions. | Raw credentials or secret tokens. |
| Application logs | Technical request/error diagnostics linked by correlationId. | Sensitive payload dumps, cookies, secret headers. |

Authorization denial may be logged/metricized at an appropriate severity, but expected 403/404 traffic is not automatically an application ERROR.

Cross-tenant access attempts are particularly valuable security signals, while the client still receives the safe 404 contract.

Purpose-specific response DTOs remain part of authorization: permission to perform an action does not imply permission to receive all entity fields.

## 11. NestJS implementation strategy (design target, not implementation)

| Guards / Policies<br>  SessionGuard<br>  AccountCompanyStateGuard<br>  CsrfOriginGuard<br>  CapabilityGuard<br>  ResourcePolicy / OwnershipPolicy<br><br>Request-scoped trusted context<br>  AuthenticatedActor<br>  TenantContext<br><br>Application layer<br>  contextual authorization helpers where domain data is required<br>  business preconditions after authorization |
| --- |


| Practice | Decision |
| --- | --- |
| Avoid scattered role checks | Controllers should not contain repeated `if (user.role === ...)` authorization logic. |
| Central capability metadata | Use route metadata/decorators for coarse capability requirements. |
| Contextual policies | Ownership/eligibility checks may query the owning module; do not fake them with UI claims. |
| Default deny | A new endpoint has no access until an explicit policy is declared. |
| No client security claims | companyId, role, permissions, actor IDs from request DTOs are never trusted authorization inputs. |

## 12. 8.6.10 - Mandatory security/contract test matrix

| ID | Scenario | Expected result |
| --- | --- | --- |
| AUTH-01 | Protected endpoint without session | 401; no data. |
| AUTH-02 | Expired session | 401 SESSION_EXPIRED. |
| AUTH-03 | Revoked session cookie reused | 401; no access. |
| AUTH-04 | Deactivated account with old session | Denied immediately. |
| AUTH-05 | Suspended Company with old session | Denied immediately. |
| AUTH-06 | Wrong login e-mail/password | Same neutral external failure semantics. |
| AUTHZ-01 | EMPLOYEE calls admin employee-management endpoint | 403. |
| AUTHZ-02 | EMPLOYEE requests coworker personal plan/request | 404/no data exposure. |
| TENANT-01 | Company A admin reads Company B resource ID | 404/no existence leak. |
| TENANT-02 | Company A creates relation to Company B ID | Rejected; DB/application tenant invariant holds. |
| TENANT-03 | Request sends manipulated companyId | No tenant switch; field rejected or ignored as authority. |
| CSRF-01 | Protected POST without X-CSRF-Token | 403 CSRF validation failure. |
| CSRF-02 | Protected mutation with wrong CSRF token | 403. |
| CSRF-03 | Protected mutation from wrong Origin | 403. |
| CSRF-04 | GET causes business mutation | Test must fail; safe methods are side-effect free. |
| SELF-01 | Employee creates cancellation for another employee assignment | 404/forbidden by ownership policy. |
| SELF-02 | Employee withdraws another employee request | 404/no resource exposure. |
| REPL-01 | Employee reads all replacement offers | 403; only admin may list candidate offers. |
| REPL-02 | Ineligible employee posts offer | Authorization/visibility + business validation prevent operation. |
| RESET-01 | Password-reset request for existing vs non-existing e-mail | Externally indistinguishable response. |
| RESET-02 | Reset token replay | Rejected; single-use. |
| LOG-01 | Security error paths | No password/token/session secret in logs or response. |
| MFA-01 | Production admin account without required MFA | Production release gate fails. |

## 13. Phase-8.6 decision register

| ID | Decision |
| --- | --- |
| D-8.6-01 | Server-side session remains the canonical browser authentication mechanism. |
| D-8.6-02 | Opaque session cookie only; permissions are recalculated server-side. |
| D-8.6-03 | Authorization is default-deny RBAC + tenant + ownership/scope + contextual permission. |
| D-8.6-04 | Named code-level capabilities centralize coarse authorization; no dynamic permission-table feature is introduced. |
| D-8.6-05 | TenantContext is derived server-side and is mandatory for tenant-plane queries. |
| D-8.6-06 | Cross-tenant/invisible resource lookups use the Phase-8.5 safe 404 contract. |
| D-8.6-07 | COMPANY_ADMIN does not automatically inherit EMPLOYEE self-service capabilities. |
| D-8.6-08 | CSRF request header is X-CSRF-Token. |
| D-8.6-09 | CSRF uses a session-bound synchronizer token. |
| D-8.6-10 | Login and GET /me return the CSRF token in X-CSRF-Token response header. |
| D-8.6-11 | Public browser POST commands use Origin validation; protected unsafe requests require Origin + CSRF. |
| D-8.6-12 | No MFA endpoints are added unless the MFA Stretch is actually implemented; Admin MFA remains Production mandatory. |
| A8.6-01 | Remove email from generic UpdateEmployeeRequestDto; future e-mail changes require a dedicated verified Identity flow. |

## 14. Senior review and Phase-8.6 gate

| Gate criterion | Result |
| --- | --- |
| Authentication mechanism consistent with Phase 6.6 | PASS |
| Cookie/runtime rules consistent with Phase 6.8 | PASS |
| Default-deny authorization model defined | PASS |
| Endpoint-level actor matrix complete | PASS |
| Tenant isolation / 403-404 semantics preserved | PASS |
| CSRF header and bootstrap mechanism finalized | PASS |
| Session/account/company lifecycle handled | PASS |
| MFA MVP-vs-Production boundary explicit | PASS |
| Sensitive-data / logging rules preserved | PASS |
| Negative security test matrix defined | PASS |
| Blocking architecture conflict | NONE |

| PHASE 8.6 - FINAL / PASS<br>Authentication & Authorization API Rules are complete enough to proceed to Phase 8.7 - Concurrency, Idempotency & API Transactions. Before the overall Phase-8 closure gate, A8.6-01 must be backported into the Phase-8.3 DTO artifact, and the previously recorded availability-route correction must be mirrored into canonical Phase 8.2. |
| --- |


## 15. Handoff to Phase 8.7

Choose the concrete optimistic-concurrency transport for Duty mutations (for example If-Match/version contract).

Finalize Idempotency-Key request/response semantics and retention behavior.

Define atomic command boundaries for cancellation/replacement and initial publish.

Specify retry behavior and transaction-conflict mapping using the Phase-8.5 Problem Details contract.

Keep authorization context fixed to the authenticated actor/tenant throughout each transaction.

## 16. Source basis

SecurePlan - Phase 4 Systemanalyse (MVP actors, self-service, admin workflows).

SecurePlan - Phase 6.6 Security Architecture & RBAC FINAL v1.0.

SecurePlan - Phase 6.7 API & Integration Architecture FINAL v1.0.

SecurePlan - Phase 6.8 Deployment & Runtime Architecture FINAL.

SecurePlan - Phase 7 Database Design FINAL v1.0.

SecurePlan - Phase 8.2 REST Endpoint Design baseline + availability correction A8.2-01.

SecurePlan - Phase 8.3 DTO Design FINAL v1.0.

SecurePlan - Phase 8.4 Validation Contracts FINAL v1.0.

SecurePlan - Phase 8.5 Error Handling & Error Contract FINAL v1.0.
