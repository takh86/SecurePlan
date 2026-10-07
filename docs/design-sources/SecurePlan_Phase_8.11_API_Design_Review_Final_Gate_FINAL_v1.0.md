# SecurePlan_Phase_8.11_API_Design_Review_Final_Gate_FINAL_v1.0

> Designquelle: SecurePlan_Phase_8.11_API_Design_Review_Final_Gate_FINAL_v1.0.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan - Phase 8.11

API Design Review & Final Gate

Consolidated API Baseline · Final Consistency Review · Implementation Handoff

| Document control | Value |
| --- | --- |
| Version | v1.0 FINAL |
| Status | PHASE 8 FINAL / APPROVED |
| Date | 06.10.2026 |
| API base | /api/v1 |
| Canonical endpoint count | 47 MVP endpoints |
| MVP use-case coverage | 17 / 17 use cases mapped |
| Primary stack context | NestJS/TypeScript · PostgreSQL · REST/JSON · server-side sessions · shared DB/shared schema tenancy |
| Purpose | Final review, reconciliation and approval of Phase 8 API Design before Phase 9 Security Design and implementation hardening. |

| Final gate decision<br>PHASE 8 - API DESIGN is APPROVED. The design is internally coherent, traceable to the current MVP baseline, security-aware, testable and sufficiently detailed for implementation. This Phase 8.11 document is the consolidated API baseline for Phase 8 and explicitly resolves the controlled amendments accumulated in 8.2-8.10. |
| --- |


## 1. Review scope and gate criteria

The final review checks whether the API can move from design into security hardening and implementation without unresolved contract ambiguity. The gate is not a code-completeness review; implementation evidence belongs to later development/testing phases.

| Review dimension | Question answered by the gate |
| --- | --- |
| Scope | Does the API implement only the internship MVP and avoid hidden Post-MVP scope? |
| Functional completeness | Are all 17 MVP use cases represented by API operations/read models? |
| REST/resource model | Are resources and explicit domain commands consistent? |
| DTO/data exposure | Are request/response contracts explicit, purpose-specific and safe? |
| Validation/errors | Are validation boundaries and RFC 9457 errors consistent? |
| AuthN/AuthZ/tenancy | Are session, ownership, role, context and tenant rules explicit? |
| Concurrency/idempotency | Can stale writes, duplicate commands and simultaneous admin actions be handled safely? |
| Transactions | Are critical multi-entity state changes atomic? |
| Query design | Are filtering/sorting/pagination explicit and authorization-safe? |
| OpenAPI | Can the implemented contract be generated and drift-checked in CI? |
| Traceability/tests | Can each business/security contract be verified automatically? |

## 2. Final baseline precedence

Phase 8 accumulated intentional refinements as later subphases exposed cross-cutting needs. Instead of silently rewriting history, Phase 8.11 closes those refinements through an explicit consolidated precedence rule.

| Effective API Design Baseline<br><br>Approved CRs / MVP scope / architecture<br>        ↓<br>Phase 8.11 Consolidated API Baseline<br>        ↓<br>Phase 8.9 Canonical OpenAPI View<br>        ↓<br>Phase 8.2-8.8 source artifacts where not superseded<br>        ↓<br>Implementation + generated OpenAPI + CI tests |
| --- |


| D-8.11-01 - Consolidated baseline authority<br>If an earlier Phase-8 artifact conflicts with a controlled amendment explicitly closed by this document, Phase 8.11 is normative for the API contract. Earlier artifacts remain historical design evidence; they are not allowed to reintroduce superseded behavior during implementation. |
| --- |


## 3. Phase 8 artifact review

| Phase | Artifact | Gate | Senior review |
| --- | --- | --- | --- |
| 8.1 | API Resource Analysis | PASS | Resource set matches MVP domains and read models. |
| 8.2 | REST Endpoint Design | PASS after consolidation | Base endpoint catalogue sound; later availability/edit-lease/query/header amendments incorporated here. |
| 8.3 | Request/Response DTO Design | PASS after consolidation | Purpose-specific DTOs retained; pagination/query additions and email-update correction incorporated. |
| 8.4 | Validation Contracts | PASS | Strict whitelist, transport/business separation and domain validation remain valid. |
| 8.5 | Error Handling & Error Contract | PASS after consolidation | RFC 9457 baseline retained; 8.7 version/lease/idempotency codes added to canonical catalogue. |
| 8.6 | Authentication & Authorization API Rules | PASS | Server-side session, default-deny, tenant isolation, ownership/context rules retained. |
| 8.7 | Concurrency, Idempotency & API Transactions | PASS | Duty-level versioning, edit lease, selective idempotency and ACID boundaries retained. |
| 8.8 | Query Design | PASS | Explicit filters/sorts/page pagination; no generic query DSL. |
| 8.9 | OpenAPI / Swagger Contract | PASS | Canonical machine-readable documentation view and CI drift discipline. |
| 8.10 | Traceability & API Test Design | PASS | All 17 MVP use cases mapped; critical security/reliability test coverage defined. |

## 4. Controlled amendment closure register

| ID | Issue | Status | Final resolution |
| --- | --- | --- | --- |
| A8.2-01 | Missing employee availability routes | CLOSED | GET/PUT/DELETE availability endpoints are part of final 47-endpoint surface. |
| A8.6-01 | Generic Employee PATCH allowed login-email mutation | CLOSED | email is not mutable through generic Employee PATCH; future change requires dedicated verified identity flow. |
| A8.7-01 | Edit-lease API absent from 8.2 | CLOSED | Acquire/renew/release edit-lease endpoints included. |
| A8.7-02 | 8.7 introduced version/lease/idempotency errors | CLOSED | Final error catalogue includes required new stable codes. |
| A8.7-03 | Expected-Version transport not in original endpoint baseline | CLOSED | Expected-Version header required on concurrency-sensitive Duty mutation; conditional APPROVE semantics documented. |
| A8.7-04 | Idempotency-Key requirements not fully reflected in 8.2 | CLOSED | Required on cancellation create, replacement offer create, decision and initial publish. |
| A8.8-01 | Paginated collection envelope missing | CLOSED | Paginated endpoints return items + pagination metadata. |
| A8.8-02 | Shift configuration GET ambiguous | CLOSED | effectiveForMonth is required. |
| A8.8-03 | Personal monthly plan implicit month | CLOSED | monthStart is required. |
| A8.8-04 | Availability history query unbounded | CLOSED | monthStart is required. |
| A8.8-05 | Personal work-items/statistics not explicitly month-scoped | CLOSED | monthStart is required. |
| A8.8-06 | Query details needed OpenAPI documentation | CLOSED | Phase 8.9 documents parameters, defaults, limits and sort whitelists. |

| Documentation-debt decision<br>The amendments above are considered closed by this consolidated baseline. Teams may still update older Phase-8 source files for editorial cleanliness, but implementation must not wait for duplicate document editing and must not follow older conflicting text. |
| --- |


## 5. Scope and backward-consistency review

| Area | Final Phase-8 state | Review |
| --- | --- | --- |
| CR-01 replacement quota | No monthly takeover quota/counter/check/error exists. | PASS |
| CR-03 published-plan lifecycle | Initial publish once; later authorized validated mutations affect published plan directly after commit; no Draft/Re-Publish loop. | PASS |
| Tenant model | Company is tenant; TenantContext is server-derived; no tenant switch by request parameter. | PASS |
| Admin Work Queue | Derived read model, not a writable domain/source of truth. | PASS |
| Statistics | Derived from current published planning state; not time tracking. | PASS |
| Day plan | Post-MVP; no API endpoints introduced. | PASS |
| Payroll | Post-MVP; no API endpoints introduced. | PASS |
| Wunschfrei / shift swap | Post-MVP; no endpoints introduced. | PASS |
| Full notifications | Not pulled into required MVP API; only implemented side effects use outbox rules. | PASS |
| Platform Control Plane | Logically separated; no speculative provider/admin MVP endpoints. | PASS |

## 6. Final canonical endpoint surface

| API area | Endpoints | Purpose |
| --- | --- | --- |
| Identity & Access | 6 | Login, logout, /me, activation, password-reset request and completion. |
| Employees & Availability | 8 | Employee admin lifecycle plus month-scoped SICK/LEAVE availability maintenance. |
| Projects & Monthly Assignments | 9 | Projects, month assignments and effective shift configuration. |
| Planning | 12 | Monthly plans, entries, edit leases, initial publish, employee personal monthly plan. |
| Cancellation & Replacement | 9 | Cancellation list/detail/create/withdraw/decision, replacement needs/offers. |
| Operations & Statistics | 3 | Employee work items, admin work queue, employee planning statistics. |

| Canonical endpoint count<br>The final internship-MVP API surface contains 47 endpoints under /api/v1. No hidden API has been added for day planning, payroll, Wunschfrei, shift swap, billing or provider-wide platform administration. |
| --- |


### 6.1 Canonical endpoint matrix

| Method | Path | Actor | Important contract | Success |
| --- | --- | --- | --- | --- |
| POST | /auth/login | Public | Credentials; Origin | 200 |
| POST | /auth/logout | Authenticated | CSRF | 204 |
| GET | /me | Authenticated | Session | 200 |
| POST | /auth/activate | Public | Activation token; Origin | 200 |
| POST | /auth/password-reset-requests | Public | Neutral response; Origin | 202 |
| POST | /auth/password-resets | Public | Reset token; Origin | 200 |
| GET | /employees | Admin | q/status/shiftEligibility/page/sort | 200 |
| GET | /employees/{employeeId} | Admin | Tenant-scoped path | 200 |
| POST | /employees | Admin | CSRF | 201 |
| PATCH | /employees/{employeeId} | Admin | CSRF; email excluded | 200 |
| POST | /employees/{employeeId}/deactivate | Admin | CSRF | 200 |
| GET | /employees/{employeeId}/availability | Admin | monthStart required | 200 |
| PUT | /employees/{employeeId}/availability/{day} | Admin | CSRF | 200 |
| DELETE | /employees/{employeeId}/availability/{day} | Admin | CSRF | 204 |
| GET | /projects | Admin | q/status/page/sort | 200 |
| GET | /projects/{projectId} | Admin | Tenant-scoped path | 200 |
| POST | /projects | Admin | CSRF | 201 |
| PATCH | /projects/{projectId} | Admin | CSRF | 200 |
| GET | /project-assignments | Admin | monthStart required; filters/page | 200 |
| POST | /project-assignments | Admin | CSRF | 201 |
| PATCH | /project-assignments/{assignmentId} | Admin | CSRF; correction-only | 200 |
| GET | /projects/{projectId}/shift-configuration | Admin | effectiveForMonth required | 200 |
| PATCH | /projects/{projectId}/shift-configuration | Admin | CSRF | 200 |
| GET | /monthly-plans | Admin | projectId/monthStart/status/page | 200 |
| GET | /monthly-plans/{planId} | Admin | Tenant-scoped path | 200 |
| POST | /monthly-plans | Admin | CSRF | 201 |
| GET | /monthly-plans/{planId}/entries | Admin | shiftKind optional | 200 |
| POST | /monthly-plans/{planId}/entries | Admin | CSRF | 201 |
| PATCH | /monthly-plans/{planId}/entries/{entryId} | Admin | CSRF + Expected-Version + Edit-Lease-Token | 200 |
| DELETE | /monthly-plans/{planId}/entries/{entryId} | Admin | CSRF + Expected-Version + Edit-Lease-Token | 204 |
| POST | /monthly-plans/{planId}/entries/{entryId}/edit-lease | Admin | CSRF | 200 |
| PUT | /monthly-plans/{planId}/entries/{entryId}/edit-lease | Admin | CSRF + Edit-Lease-Token | 200 |
| DELETE | /monthly-plans/{planId}/entries/{entryId}/edit-lease | Admin | CSRF + Edit-Lease-Token | 204 |
| POST | /monthly-plans/{planId}/publish | Admin | CSRF + Idempotency-Key | 200 |
| GET | /me/monthly-plans | Employee | monthStart required | 200 |
| GET | /cancellation-requests | Admin | filters/page/sort | 200 |
| GET | /cancellation-requests/{requestId} | Admin or owner | Ownership/tenant | 200 |
| POST | /cancellation-requests | Employee | CSRF + Idempotency-Key | 201 |
| POST | /cancellation-requests/{requestId}/withdraw | Owner employee | CSRF | 200 |
| POST | /cancellation-requests/{requestId}/decision | Admin | CSRF + Idempotency-Key; Expected-Version for APPROVE | 200 |
| GET | /me/replacement-needs | Employee | monthStart/page; eligibility scoped | 200 |
| GET | /replacement-needs/{needId} | Admin or eligible employee | Contextual visibility | 200 |
| GET | /replacement-needs/{needId}/offers | Admin | status/page | 200 |
| POST | /replacement-needs/{needId}/offers | Employee | CSRF + Idempotency-Key | 201 |
| GET | /me/work-items | Employee | monthStart required | 200 |
| GET | /admin/work-queue | Admin | projectId/monthStart/type/page/sort | 200 |
| GET | /me/planning-statistics | Employee | monthStart required | 200 |

## 7. Cross-cutting contract review

### 7.1 DTO and validation

| Rule | Final baseline |
| --- | --- |
| JSON style | camelCase API; persistence naming is not exposed. |
| Unknown fields | Rejected; strict whitelist / mass-assignment defense. |
| PATCH | Omitted = unchanged; empty PATCH invalid; null only where explicitly meaningful. |
| Dates/months | Exact date formats; monthStart uses first day of month. |
| Tenant fields | companyId / TenantContext / role / permissions never accepted as client trust input. |
| Employee email update | Not allowed through generic Employee PATCH. |
| Collections | Paginated only where justified; bounded month collections may return simple items arrays. |

### 7.2 Error contract

| Rule | Final baseline |
| --- | --- |
| Format | RFC 9457 application/problem+json. |
| Extensions | Stable code, correlationId, optional validation errors[]. |
| 400 | Malformed/validation/query/header contract failures. |
| 401 | Missing/invalid/expired/revoked session or login credentials as applicable. |
| 403 | Known visible context but forbidden action; CSRF/Origin failure. |
| 404 | Absent or deliberately concealed/invisible resource. |
| 409 | Business state, uniqueness, concurrency, edit lease and idempotency conflicts. |
| 429 | Rate limiting. |
| 500 | Sanitized INTERNAL_ERROR; no stack/SQL/secret leakage. |
| 422 | Not used as normal MVP validation class. |

### 7.3 Authentication, authorization and tenant isolation

| Protected request<br>  -> session<br>  -> active account + company<br>  -> server-derived TenantContext<br>  -> coarse role/capability<br>  -> resource scope / ownership<br>  -> contextual permission<br>  -> business preconditions<br>  -> use case |
| --- |


Default deny is mandatory.

Frontend visibility is UX only; backend authorization is authoritative.

Cross-tenant identifiers do not reveal whether the foreign resource exists.

Protected unsafe methods use CSRF token + Origin validation.

Session cookie is opaque; permissions are recalculated from current server state.

## 8. Concurrency, idempotency and transaction final review

| Concern | Final decision | Gate |
| --- | --- | --- |
| Concurrency boundary | Duty/planning entry, not global MonthlyPlan. | PASS |
| Optimistic versioning | Expected-Version checked atomically; stale write -> 409 PLAN_CONCURRENT_MODIFICATION. | PASS |
| Edit lease | Short-lived coordination aid; never replaces version check. | PASS |
| Independent duties | May be edited concurrently. | PASS |
| Idempotency | Selective Idempotency-Key for critical POST commands. | PASS |
| Replay | Same key + same semantic request -> same logical result; different request -> 409. | PASS |
| Transaction ownership | Application service owns local PostgreSQL ACID boundary. | PASS |
| Replacement approval | Workflow state + assignment mutation + mandatory audit/outbox intent are atomic. | PASS |
| External delivery | After commit; delivery failure does not roll back committed business state. | PASS |

| OpenAPI modeling note - accepted limitation<br>The combined cancellation decision operation has a conditional concurrency precondition: Expected-Version is required when decision=APPROVE because the Duty is mutated, but not needed for a pure REJECT. OpenAPI 3.0 cannot express this header/body dependency perfectly. The operation therefore documents the conditional rule in its description and enforces it in application validation/tests. This is an accepted documentation limitation, not a runtime ambiguity. |
| --- |


## 9. Query design final review

| Concern | Final decision |
| --- | --- |
| Pagination | Page-based offset pagination on selected administrative collections. |
| Defaults | page=1; pageSize=25; max pageSize=100. |
| Sorting | Explicit sortBy/sortOrder with per-endpoint whitelist and deterministic tie-breaker. |
| Search | q only for selected employee/project fields. |
| Month-scoped reads | monthStart required where the resource/read model is inherently monthly. |
| Shift config read | effectiveForMonth required. |
| Authorization order | Tenant/ownership scope before filters, counts, sorting and pagination. |
| Unknown query parameters | Rejected with 400 validation error. |
| Generic query DSL | Not used. |
| Arbitrary fields/include | Not used. |

## 10. OpenAPI and testability final review

| Area | Final contract |
| --- | --- |
| OpenAPI model | Code-first from implemented NestJS controllers and explicit DTOs. |
| Security scheme | Session cookie documented as apiKey-in-cookie. |
| Shared headers | X-CSRF-Token, X-Correlation-ID, Expected-Version, Edit-Lease-Token, Idempotency-Key, Retry-After where applicable. |
| Contract drift | Generated OpenAPI validated/diffed in CI; incompatible unexpected drift blocks merge/release. |
| Swagger exposure | Local available; Staging controlled; no freely public Production Swagger UI. |
| Traceability | 17/17 MVP use cases mapped to API and automated test families. |
| Canonical API tests | 164 identified API/contract/security test cases plus 9 selected E2E MVP scenarios. |
| Release blockers | Cross-tenant, authz, transaction atomicity, stale-write, idempotency and OpenAPI-breaking-change failures block release. |

## 11. API security review - design-level readiness

| Risk / OWASP-relevant concern | Phase-8 mitigation | Status |
| --- | --- | --- |
| Broken Object Level Authorization | Server-derived tenant scope + ownership/context checks + concealed 404 + negative tests. | DESIGNED |
| Broken Authentication | Server-side sessions, revocation, active account/company checks, neutral login/reset behavior. | DESIGNED |
| Broken Object Property Level Authorization / Mass Assignment | Purpose-specific DTOs, whitelist validation, no client companyId/role/permissions. | DESIGNED |
| Unrestricted resource/query exposure | Explicit endpoint/query vocabulary, page-size cap, no generic include/filter DSL. | DESIGNED |
| CSRF for cookie auth | X-CSRF-Token + Origin validation on unsafe protected methods. | DESIGNED |
| Duplicate/replayed critical commands | Selective idempotency with request fingerprint and persistent state. | DESIGNED |
| Lost update / race | Duty version + edit lease + transactional final revalidation. | DESIGNED |
| Sensitive error leakage | RFC 9457 safe responses, stable code, correlation ID; unexpected 500 sanitized. | DESIGNED |
| Cross-tenant DB relationships | Tenant-scoped application queries plus DB integrity design from Phase 7. | DESIGNED |

| Boundary of this gate<br>DESIGNED does not mean implementation-proven. Phase 9 Security Design must complete threat modeling/OWASP-focused controls, and Phase 13 must prove the controls with automated and manual security testing. |
| --- |


## 12. Non-blocking deferred details

| Deferred detail | Why it does not block Phase 8 | Owner phase |
| --- | --- | --- |
| Exact owned HTTPS origin for RFC 9457 problem-type documentation | Problem slugs/semantics are fixed; final docs host is deployment/documentation configuration. | Phase 9/15/17 |
| Exact physical session-cookie name | OpenAPI/runtime use one shared configured constant; semantics already fixed. | Phase 11 |
| Concrete NestJS Swagger/tool versions | Tooling choice does not change API semantics. | Phase 11 |
| MFA endpoint surface | Stretch for internship; mandatory Production gate if implemented. | Phase 9 / later release |
| Dedicated verified email-change flow | Explicitly excluded from generic Employee PATCH; future feature. | Post-MVP |
| Exact test DB orchestration/tooling | Test design is complete; tooling follows setup/testing phase. | Phase 11/13 |
| Performance thresholds | Queries/index strategy defined; thresholds require implementation/runtime evidence. | Phase 13/16 |

## 13. Final gate scorecard

| Gate criterion | Result |
| --- | --- |
| MVP scope alignment | PASS |
| 17-use-case functional coverage | PASS |
| Resource/command model | PASS |
| DTO/data exposure design | PASS |
| Validation contract | PASS |
| RFC 9457 error contract | PASS |
| Authentication/session contract | PASS |
| Authorization/tenant isolation | PASS |
| Concurrency/edit lease | PASS |
| Idempotency/retry semantics | PASS |
| Atomic transaction design | PASS |
| Query/filter/sort/pagination design | PASS |
| OpenAPI/Swagger contract discipline | PASS |
| Traceability/API test design | PASS |
| CR-01 removal consistently enforced | PASS |
| CR-03 direct published-plan semantics enforced | PASS |
| Post-MVP scope creep | NONE |
| Blocking API-design contradiction | NONE |

| PHASE 8 - API DESIGN: FINAL / APPROVED<br>No blocking API-design contradiction remains. The consolidated Phase-8 baseline is sufficiently precise for Phase 9 Security Design and subsequent implementation. Any future incompatible API change requires explicit change control and, where client compatibility is broken, a controlled migration or new major API version. |
| --- |


## 14. Implementation guardrails created by the final gate

Implementation must follow the consolidated 47-endpoint surface; do not resurrect older conflicting Phase-8 text.

Controllers remain thin and do not own cross-module workflow orchestration or repetitive error mapping.

Request DTOs must reject unknown fields and must not expose tenant/security authority to the client.

Every protected endpoint must declare and implement an explicit authorization policy; new endpoint = deny until policy exists.

Every Duty mutation must respect the final concurrency/lease contract.

Every selected critical POST must implement the final idempotency contract.

Critical multi-entity workflow mutations must be transactionally atomic with required audit/outbox intent.

Generated OpenAPI is reviewed in CI; implementation is not considered complete if documentation drifts.

API tests should use the Phase-8.10 stable IDs as implementation evidence where practical.

## 15. Handoff to Phase 9 - Security Design

Phase 8 defines the security-relevant API contract, but Phase 9 now examines the system adversarially and completes security design before production-grade implementation claims.

| Phase-9 focus | Input from Phase 8 |
| --- | --- |
| Threat model / trust boundaries | Browser -> edge -> API -> PostgreSQL -> worker/provider; tenant and identity boundaries already explicit. |
| Authentication hardening | Server-side session lifecycle, neutral login/reset, cookie/CSRF model. |
| Authorization design review | Role + ownership + tenant + contextual policies and 403/404 boundary. |
| OWASP API risks | Endpoint inventory, DTO whitelist, query limits, error sanitation, idempotency/concurrency controls. |
| Secrets/token handling | Activation/reset/session/lease/idempotency token handling rules. |
| Logging/audit/privacy | Correlation IDs, safe logs, critical audit, SICK data minimization. |
| Abuse/rate limiting | Login/general rate-limit error semantics defined; detailed thresholds/control strategy follow. |
| Security test plan | Phase 8.10 negative API/security catalogue is direct input. |

## 16. Phase-8.11 decision register

| ID | Decision |
| --- | --- |
| D-8.11-01 | Phase 8.11 is the consolidated normative Phase-8 API baseline for conflicts resolved by the amendment register. |
| D-8.11-02 | The final MVP API surface is 47 endpoints under /api/v1. |
| D-8.11-03 | All 17 MVP use cases have API and test traceability; no Post-MVP vertical is silently included. |
| D-8.11-04 | Earlier controlled amendments A8.2-01, A8.6-01, A8.7-01..04 and A8.8-01..06 are CLOSED by this baseline. |
| D-8.11-05 | The combined cancellation-decision endpoint is retained; its APPROVE-only Expected-Version requirement is documented/enforced despite OpenAPI 3.0 conditional-modeling limits. |
| D-8.11-06 | Phase 8 is approved at design level; implementation proof and security verification remain later-phase responsibilities. |
| D-8.11-07 | Future incompatible API changes require controlled migration or a new major API version; additive compatible changes may remain v1. |

## 17. Reviewed source basis

SecurePlan - Phase 2 FINAL Requirements Specification & Baseline v1.1, read with approved change control.

SecurePlan - Phase 3 FINAL Scope & MVP v1.1.

SecurePlan - CR-01 / Baseline Amendment v1.2 (replacement quota removed).

SecurePlan - CR-03 direct published-plan update semantics as reflected in approved architecture/database/API baselines.

SecurePlan - Phase 4 Systemanalyse (17 MVP use cases).

SecurePlan - Phase 6.5 Transaction, Consistency & Concurrency FINAL v1.0.

SecurePlan - Phase 6.6 Security Architecture & RBAC FINAL v1.0.

SecurePlan - Phase 6.7 API & Integration Architecture FINAL v1.0.

SecurePlan - Phase 6.8 Deployment & Runtime Architecture FINAL.

SecurePlan - Phase 7 Database Design FINAL v1.0.

SecurePlan - Phase 8.1 API Resource Analysis.

SecurePlan - Phase 8.2 REST Endpoint Design.

SecurePlan - Phase 8.3 DTO Design FINAL v1.0.

SecurePlan - Phase 8.4 Validation Contracts FINAL v1.0.

SecurePlan - Phase 8.5 Error Handling & Error Contract FINAL v1.0.

SecurePlan - Phase 8.6 Authentication & Authorization API Rules FINAL v1.0.

SecurePlan - Phase 8.7 Concurrency, Idempotency & API Transactions FINAL v1.0.

SecurePlan - Phase 8.8 Query Design FINAL v1.0.

SecurePlan - Phase 8.9 OpenAPI / Swagger Contract FINAL v1.0.

SecurePlan - Phase 8.10 Traceability & API Test Design FINAL v1.0.
