# SecurePlan_Phase_8.10_Traceability_API_Test_Design_FINAL_v1.0

> Designquelle: SecurePlan_Phase_8.10_Traceability_API_Test_Design_FINAL_v1.0.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan - Phase 8.10

Traceability & API Test Design

Requirements -> Use Cases -> API Contracts -> Automated Verification

| Document control | Value |
| --- | --- |
| Version | v1.0 FINAL |
| Status | COMPLETE - PASS FOR PHASE 8.11 |
| Date | 06.10.2026 |
| Scope | Internship MVP API only |
| Test focus | Functional API behavior, authorization, tenant isolation, validation, workflow/state, concurrency, idempotency, transactions, query contracts, OpenAPI. |
| Primary inputs | Effective requirements/scope baseline + CR-01/CR-03 interpretation; Phase 4 System Analysis; Phase 6.5-6.8 architecture; Phase 7 DB; Phase 8.2-8.9 API design. |
| Output | Bidirectional traceability model, API test layers, canonical test catalogue, data-fixture strategy and Phase-8.10 gate. |

| Phase objective<br>Phase 8.10 proves that the API design is testable and traceable. Every MVP use case must map to concrete API operations and test evidence; every critical API contract must map back to an approved requirement, use case, architecture decision or controlled Phase-8 refinement. |
| --- |


## 1. Why traceability matters

It prevents endpoints from becoming undocumented feature scope.

It prevents requirements from existing only in documents without executable verification.

It makes security and reliability rules first-class test obligations, not optional review notes.

It allows a reviewer to move in both directions: requirement -> test evidence and failing test -> originating business/security rule.

It supports the final Phase-8 gate and later implementation/test phases without inventing behavior during coding.

| Requirement / AC / Use Case<br>        ↓<br>API operation<br>        ↓<br>DTO + validation + security + state rule<br>        ↓<br>expected HTTP / error code / DB effect<br>        ↓<br>automated test ID<br>        ↓<br>CI / release evidence |
| --- |


## 2. 8.10.1 - Normative source precedence

Traceability follows the effective project baseline rather than blindly copying obsolete statements from earlier documents.

| Priority | Source / rule | Traceability treatment |
| --- | --- | --- |
| 1 | Approved Change Requests / amendments | Override conflicting earlier statements. |
| 2 | Frozen MVP Scope / current System Analysis | Defines what belongs to the internship API. |
| 3 | Approved Architecture + Database Design | Defines security, transaction, concurrency, persistence and reliability constraints. |
| 4 | Phase 8.2-8.9 API design | Defines concrete endpoint/DTO/error/query/OpenAPI contracts. |
| 5 | Older Phase-2 statements that conflict with approved changes | Recorded as superseded; not converted into current tests. |

| Explicit supersessions<br>AC-ER-04 (three-replacement monthly quota) is removed by CR-01 and must not have a current API test. Old Draft/Re-Publish assumptions after initial publication are superseded by CR-03 and the later architecture; current API tests verify direct validated mutation of the published plan. Day plan, payroll, Wunschfrei, shift-swap and other post-MVP areas are not pulled into Phase 8.10. |
| --- |


## 3. 8.10.2 - API test strategy by layer

| Layer | Primary responsibility | Examples | CI role |
| --- | --- | --- | --- |
| Unit / domain | Pure business rules without HTTP/DB where practical. | Eligibility rule, state transition predicate, normalization helper. | Fast PR checks. |
| Application service | Use-case orchestration and business preconditions. | Cancellation create, approve without offer, candidate revalidation. | Fast/medium PR checks. |
| Repository / DB integration | Constraints, transactions, scoped queries, rollback. | One project/month, one open cancellation, atomic replacement. | PR integration suite. |
| HTTP/API integration | Real NestJS route, DTO validation, session/security guards, DB. | 400/401/403/404/409 behavior, response DTOs, headers. | Required PR gate. |
| Contract / OpenAPI | Generated spec matches implementation contract. | operationId, schemas, required headers, no 422 drift. | Required PR gate. |
| Selected E2E workflow | Critical vertical business flows across multiple API calls. | Admin -> publish -> employee -> cancellation -> offer -> decision. | Release candidate gate. |
| Security negative | Broken-access-control and input-abuse paths. | Cross-tenant IDs, ownership, CSRF, mass assignment. | Required release gate. |

| Testing principle<br>Do not test the same rule expensively at every layer. Put the detailed rule matrix at the lowest reliable layer, then keep representative HTTP/E2E tests to prove wiring, status/error semantics and security boundaries. |
| --- |


## 4. 8.10.3 - Test identification and evidence convention

| Prefix | Area |
| --- | --- |
| API-AUTH-* | Authentication/session/account lifecycle |
| API-EMP-* | Employees and availability |
| API-PROJ-* | Projects, assignments and shift configuration |
| API-PLAN-* | Monthly plans, entries and publish |
| API-CAN-* | Cancellation requests |
| API-REP-* | Replacement needs/offers/decision |
| API-READ-* | Self-service read models, work queue, statistics |
| API-SEC-* | Authorization, tenant isolation, CSRF, mass assignment |
| API-CON-* | Concurrency/edit lease |
| API-IDEM-* | Idempotency and retry behavior |
| API-ERR-* | RFC 9457/error sanitation |
| API-QRY-* | Filtering/sorting/pagination |
| API-OAS-* | OpenAPI/Swagger contract |
| E2E-MVP-* | Critical end-to-end flows |

A test ID is stable even if the implementation file name changes. Pull requests and defect tickets may reference these IDs.

## 5. 8.10.4 - MVP use-case to API traceability

| UC | Use case | Primary API surface | Test evidence |
| --- | --- | --- | --- |
| UC-01 | Anmelden | POST /auth/login; GET /me | API-AUTH-01..05, API-SEC-01 |
| UC-02 | Abmelden | POST /auth/logout | API-AUTH-06..07 |
| UC-03 | Monatsplan erstellen | POST /monthly-plans; GET /monthly-plans/{id} | API-PLAN-01..04 |
| UC-04 | Monatsplan bearbeiten | entries GET/POST/PATCH/DELETE + edit-lease endpoints | API-PLAN-05..14, API-CON-01..06 |
| UC-05 | Monatsplan veröffentlichen | POST /monthly-plans/{planId}/publish | API-PLAN-15..19, API-IDEM-01..03 |
| UC-06 | Eigenen Monatsplan anzeigen | GET /me/monthly-plans?monthStart=... | API-READ-01..04, API-SEC-08 |
| UC-07 | Absageantrag erstellen | POST /cancellation-requests | API-CAN-01..06, API-IDEM-04 |
| UC-08 | Absageantrag zurückziehen | POST /cancellation-requests/{id}/withdraw | API-CAN-07..11 |
| UC-09 | Absageanträge prüfen/entscheiden | GET /cancellation-requests; GET /{id}; POST /{id}/decision | API-CAN-12..18 |
| UC-10 | Ersatzangebot abgeben | GET /me/replacement-needs; POST /replacement-needs/{id}/offers | API-REP-01..08, API-IDEM-05 |
| UC-11 | Ersatzangebote prüfen | GET /replacement-needs/{id}; GET /replacement-needs/{id}/offers | API-REP-09..13 |
| UC-12 | Ersatzmitarbeiter auswählen | POST /cancellation-requests/{id}/decision (APPROVE + replacementOfferId) | API-REP-14..22, API-CON-07, API-IDEM-06 |
| UC-13 | Antragsstatus anzeigen | GET /me/work-items; GET own cancellation resource where allowed | API-READ-05..08, API-SEC-09 |
| UC-14 | Offene Absage-/Ersatzvorgänge anzeigen | GET /admin/work-queue; cancellation/replacement detail endpoints | API-READ-09..13, API-QRY-10 |
| UC-15 | Mitarbeiter verwalten | employees CRUD/deactivate + availability GET/PUT/DELETE | API-EMP-01..17 |
| UC-16 | Projekte/Projektzuordnungen verwalten | projects; project-assignments; shift-configuration endpoints | API-PROJ-01..18 |
| UC-17 | Eigene planbasierte Statistik | GET /me/planning-statistics?monthStart=... | API-READ-14..17 |

| Coverage check<br>All 17 Phase-4 MVP use cases have at least one concrete API surface and an assigned automated test family. Post-MVP capabilities are intentionally absent. |
| --- |


## 6. 8.10.5 - Critical acceptance-criteria traceability

| AC | Source intent | Current status | API mapping | Tests |
| --- | --- | --- | --- | --- |
| AC-TP-03 | Stale parallel editing must not silently overwrite newer state. | Current architecture reuses this concurrency principle for Duty planning. | PATCH/DELETE entry + Expected-Version | API-CON-02, API-CON-05 |
| AC-AB-01 | Valid cancellation creates exactly one request + one open replacement need. | Current MVP | POST /cancellation-requests | API-CAN-01, API-IDEM-04 |
| AC-AB-02 | Plan change removes requester before final decision -> cancellation obsolete / need closed. | Current MVP | Entry mutation / workflow reconciliation | API-PLAN-13, API-CAN-18 |
| AC-ER-01 | SICK/LEAVE or wrong shift eligibility -> candidate not eligible. | Current MVP | Replacement visibility/offer/decision | API-REP-03, API-REP-06, API-REP-17 |
| AC-ER-02 | Multiple offers -> exactly one selected; others not selected. | Current MVP | Decision APPROVE with offer | API-REP-15, API-REP-19 |
| AC-ER-03 | No offers -> admin may approve/reject; approve leaves open staffing need. | Current MVP | Decision endpoint | API-CAN-15, API-CAN-16 |
| AC-ER-04 | Three-replacement monthly limit. | REMOVED BY CR-01 | None | NO TEST - prohibited obsolete behavior |
| AC-DASH-01 | Open tasks are visible with direct navigation. | MVP simplified as Admin Work Queue | GET /admin/work-queue | API-READ-09..13 |
| AC-IDEMP-01 | Repeated publish causes no duplicate publication/effect. | Current via idempotent initial publish contract | POST /monthly-plans/{id}/publish | API-IDEM-01..03 |
| AC-EMP-01 | Employment end -> access removed and sessions invalidated after boundary. | Security/account lifecycle requirement | Protected API after deactivation/offboarding | API-AUTH-05, API-SEC-06 |
| AC-PRIV-01 | SICK stores date + status only; no medical detail fields. | Current privacy rule | Availability DTO | API-EMP-14, API-SEC-12 |

### 6.1 Superseded or out-of-MVP acceptance criteria

| Source item | Why not in current Phase-8 API test baseline |
| --- | --- |
| AC-MP-01..03 Excel import | Excel import is not a binding internship-MVP MUST. |
| AC-MP-04 old Draft/Re-Publish after publication | Superseded by CR-03 and later architecture: authorized validated published-plan mutations become effective directly. |
| AC-TP-01/02 day-plan position publish | Day plan is Post-MVP. |
| AC-WF-* Wunschfrei | Post-MVP / backlog. |
| AC-ST-* shift swap | Post-MVP. |
| AC-LA-* payroll documents | Post-MVP. |
| AC-NOT-* full notification behavior | Notification matrix is Stretch/Post-MVP; only implemented side effects are tested. |
| AC-AUD-01 central audit console access | No end-user audit-console endpoint in current MVP API. |

## 7. 8.10.6 - Cross-cutting architecture/security traceability

| Decision/quality | Required observable behavior | Tests |
| --- | --- | --- |
| Server-side session | Protected request must resolve active server session/account/company. | API-AUTH-02, API-AUTH-04, API-SEC-01 |
| Default-deny authorization | Employee cannot call admin-only operations. | API-SEC-02 |
| Tenant isolation | Company A cannot read/write Company B resource or relationship. | API-SEC-03..05 |
| 403/404 concealment | Invisible/cross-tenant resource returns safe 404; visible forbidden action returns 403. | API-SEC-03, API-SEC-07 |
| CSRF + Origin | Protected unsafe request without valid CSRF/origin is denied. | API-SEC-10..11 |
| Mass-assignment protection | Unknown/security fields rejected; companyId/role cannot alter context. | API-SEC-12..13 |
| RFC 9457 | All modeled errors use problem+json, stable code and correlationId. | API-ERR-01..06 |
| Optimistic concurrency | Stale Duty version returns 409 and no lost update. | API-CON-02..05 |
| Edit lease | Second active editor cannot acquire/use same Duty lease. | API-CON-01, API-CON-03 |
| Selective idempotency | Same key/same request does not duplicate; changed request conflicts. | API-IDEM-01..08 |
| Atomic replacement | Workflow + plan + audit commit together or rollback together. | API-REP-18..22 |
| Query security | Tenant/ownership scoping occurs before filter/count/pagination. | API-QRY-08..11 |
| OpenAPI contract discipline | Generated spec valid; drift/breaking changes block CI. | API-OAS-01..12 |

## 8. 8.10.7 - Canonical integration-test fixture model

Integration/security tests use deterministic synthetic fixtures. Every test either creates its own minimal state in a transaction/database reset or uses a versioned fixture builder; tests must not depend on execution order.

| Fixture | Minimum state |
| --- | --- |
| Company A | ACTIVE tenant with Admin A1, Admin A2, Employees A-E1/A-E2/A-E3. |
| Company B | ACTIVE tenant with Admin B1 and Employee B-E1 for cross-tenant negative tests. |
| A-E1 | ACTIVE, DAY eligibility, project assignment for target month. |
| A-E2 | ACTIVE, BOTH eligibility, same project/month, available. |
| A-E3 | ACTIVE but SICK/LEAVE on selected duty date or wrong shift eligibility depending scenario. |
| Project A | ACTIVE with DAY/NIGHT shift configuration effective for target month. |
| Monthly Plan A | UNPUBLISHED or PUBLISHED variants; deterministic month such as 2026-10-01. |
| Duty D1 | Target planning unit with known version and assignments. |
| Cancellation C1 | OPEN scenario linked to A-E1 assignment. |
| Replacement Need N1 | OPEN / OPEN_UNFILLED variants. |
| Offers O1/O2 | OPEN offers from eligible employees for selection tests. |

Use UTC/timestamptz at persistence boundaries while business dates/months remain explicit date values.

No real employee data, real credentials or production identifiers are used.

Known passwords/tokens in tests exist only in test configuration and never in committed production environment files.

Cross-tenant tests must always use genuinely different company ownership, not only different IDs in the same tenant.

## 9. 8.10.8 - Canonical API test catalogue

### 9.1 Authentication and security

| ID | Scenario | Expected |
| --- | --- | --- |
| API-AUTH-01 | Valid employee/admin credentials | 200; new session cookie; safe identity context; CSRF bootstrap available. |
| API-AUTH-02 | Protected endpoint without session | 401 RFC 9457; no protected data. |
| API-AUTH-03 | Wrong email vs wrong password | Externally neutral invalid-credentials behavior. |
| API-AUTH-04 | Expired/revoked session reused | 401; no access. |
| API-AUTH-05 | Deactivated account / inactive company with old cookie | Immediate denial; old session not sufficient. |
| API-AUTH-06 | Logout current session | 204; server session revoked; cookie cleared. |
| API-AUTH-07 | Reuse cookie after logout | 401. |
| API-SEC-01 | Protected route security wiring | Session/account/company gate applies before use case. |
| API-SEC-02 | EMPLOYEE invokes admin-only employee/project/plan action | 403 ACTION_FORBIDDEN. |
| API-SEC-03 | Company A addresses Company B employee/plan/request | 404 RESOURCE_NOT_FOUND; no existence leakage. |
| API-SEC-04 | Company A attempts cross-tenant write/relationship | Rejected; no state change. |
| API-SEC-05 | Client sends companyId attempting tenant switch | Rejected/ignored as authority; TenantContext unchanged. |
| API-SEC-06 | Role/account state changes while session active | New request reflects current server-side authorization state. |
| API-SEC-07 | Visible resource but forbidden action | 403, not concealed 404. |
| API-SEC-08 | Employee personal plan returns only own published assignments | No coworker data. |
| API-SEC-09 | Employee requests another employee's personal workflow resource | 404 / no data exposure. |
| API-SEC-10 | Protected unsafe request missing/wrong X-CSRF-Token | 403 CSRF validation failure. |
| API-SEC-11 | Protected unsafe request wrong Origin | 403. |
| API-SEC-12 | Unknown/security-sensitive request fields including medical free text | 400; no persistence/mass assignment. |
| API-SEC-13 | Response DTO inspection | No company security claims, password/token hashes or internal persistence fields. |

### 9.2 Employees, availability, projects and assignments

| ID | Scenario | Expected |
| --- | --- | --- |
| API-EMP-01 | Create valid employee | 201; ACTIVE Employee + linked pending account according to contract. |
| API-EMP-02 | Duplicate employeeCode in tenant | 409 EMPLOYEE_CODE_ALREADY_EXISTS. |
| API-EMP-03 | Invalid create fields / unknown field | 400 VALIDATION_FAILED. |
| API-EMP-04 | Employee PATCH with no fields | 400 EMPTY_PATCH. |
| API-EMP-05 | Generic Employee PATCH tries email change | 400 unknown/forbidden field under A8.6-01. |
| API-EMP-06 | Deactivate employee with unresolved future assignments | 409 EMPLOYEE_HAS_FUTURE_ASSIGNMENTS. |
| API-EMP-07 | Successful deactivation | Employee inactive; account sessions revoked as applicable. |
| API-EMP-08 | GET employee from foreign tenant | 404. |
| API-EMP-09 | Availability GET without monthStart | 400. |
| API-EMP-10 | Availability PUT SICK/LEAVE | 200; exactly employee/day/status. |
| API-EMP-11 | Availability PUT invalid status/medical detail | 400. |
| API-EMP-12 | Availability DELETE correction | 204; marker removed; history/related plan rules remain consistent. |
| API-EMP-13 | Availability affects candidate/assignment validation | Unavailable employee cannot be newly assigned/selected. |
| API-EMP-14 | Persisted SICK data shape | No diagnosis/free-text fields. |
| API-PROJ-01 | Create valid project | 201. |
| API-PROJ-02 | Duplicate project name tenant-wide | 409 PROJECT_NAME_ALREADY_EXISTS. |
| API-PROJ-03 | Inactive project used for new month assignment/plan | 409 PROJECT_INACTIVE. |
| API-PROJ-04 | Create project assignment valid month | 201. |
| API-PROJ-05 | Employee assigned to second project same month | 409 PROJECT_ASSIGNMENT_ALREADY_EXISTS/CONFLICT. |
| API-PROJ-06 | Inactive employee assignment | 409. |
| API-PROJ-07 | Correction that would invalidate planning | 409 correction conflict. |
| API-PROJ-08 | GET assignments missing monthStart | 400. |
| API-PROJ-09 | Shift-config GET missing effectiveForMonth | 400. |
| API-PROJ-10 | Shift-config valid DAY/NIGHT definition | 200 update. |
| API-PROJ-11 | Duplicate shiftKind / invalid time / start=end | 400. |

### 9.3 Planning, publish and concurrency

| ID | Scenario | Expected |
| --- | --- | --- |
| API-PLAN-01 | Create monthly plan valid project/month | 201 UNPUBLISHED. |
| API-PLAN-02 | Duplicate project+month plan | 409 MONTHLY_PLAN_ALREADY_EXISTS. |
| API-PLAN-03 | Invalid monthStart | 400. |
| API-PLAN-04 | List/filter plans | Authorized tenant results only; deterministic pagination. |
| API-PLAN-05 | Create plan entry valid assignments | 201; server-derived times/version. |
| API-PLAN-06 | Entry date outside plan month | 400 DUTY_DATE_OUTSIDE_PLAN_MONTH. |
| API-PLAN-07 | Employee not assigned project-month | 409. |
| API-PLAN-08 | Wrong shift eligibility / unavailable employee | 409; no partial write. |
| API-PLAN-09 | Overlapping/conflicting duty assignment | 409. |
| API-PLAN-10 | PATCH valid entry with lease + current version | 200; version increments exactly once. |
| API-PLAN-11 | PATCH missing Expected-Version / lease token | 400 documented header error. |
| API-PLAN-12 | DELETE valid entry | 204; workflow reconciliation occurs atomically. |
| API-PLAN-13 | Plan change removes requester with open cancellation | Cancellation becomes obsolete; need closed; open offers invalidated. |
| API-PLAN-14 | Published-plan authorized mutation | Change becomes effective after successful commit; no re-publish stage. |
| API-PLAN-15 | Initial publish valid plan | 200; status PUBLISHED. |
| API-PLAN-16 | Repeat publish with new idempotency key after already published | 409 MONTHLY_PLAN_ALREADY_PUBLISHED. |
| API-PLAN-17 | Publish fails business revalidation | 409/appropriate domain conflict; remains UNPUBLISHED. |
| API-PLAN-18 | Employee personal-plan month query after publish | Own current published duties visible. |
| API-PLAN-19 | Personal plan no results | 200 empty state, not 404. |
| API-CON-01 | Admin A acquires lease; Admin B tries same Duty | 409 RESOURCE_EDIT_LOCKED. |
| API-CON-02 | A/B read v7; A commits -> v8; B submits v7 | B gets 409 PLAN_CONCURRENT_MODIFICATION; A state preserved. |
| API-CON-03 | Expired/invalid lease token mutation | 409 EDIT_LEASE_NOT_HELD. |
| API-CON-04 | Independent Duties edited concurrently | Both may commit. |
| API-CON-05 | Stale request is not automatically blind-retried | 409 reaches client; reload required. |
| API-CON-06 | Release expired/own edit lease | Idempotent 204 behavior. |

### 9.4 Cancellation and replacement workflow

| ID | Scenario | Expected |
| --- | --- | --- |
| API-CAN-01 | Create cancellation for own active published assignment | 201; exactly one OPEN cancellation + one OPEN need. |
| API-CAN-02 | Cancellation for another employee assignment | 404/ownership denial. |
| API-CAN-03 | Second open cancellation same assignment | 409 CANCELLATION_ALREADY_EXISTS. |
| API-CAN-04 | Cancellation on inactive/obsolete assignment | 409. |
| API-CAN-05 | Cancellation creation does not remove employee from plan | Original assignment remains active. |
| API-CAN-06 | Cancellation create transaction fails mid-way | Rollback leaves neither partial cancellation nor need. |
| API-CAN-07 | Withdraw own OPEN cancellation | 200; cancellation WITHDRAWN, need CLOSED, offers invalidated, assignment remains. |
| API-CAN-08 | Withdraw another employee's request | 404. |
| API-CAN-09 | Withdraw already resolved request | 409. |
| API-CAN-10 | Withdraw rollback on failure | No partial state. |
| API-CAN-11 | Read own request status | Current status only. |
| API-CAN-12 | Admin list/open cancellation query | Authorized tenant rows, filters/pagination correct. |
| API-CAN-13 | Employee tries admin cancellation list | 403. |
| API-CAN-14 | Decision REJECT | REJECTED + need CLOSED + open offers NOT_SELECTED; assignment remains. |
| API-CAN-15 | Decision APPROVE with no offer | APPROVED + need OPEN_UNFILLED + requester assignment removed. |
| API-CAN-16 | Decision already-resolved cancellation | 409 CANCELLATION_ALREADY_RESOLVED. |
| API-CAN-17 | Approve using stale plan version | 409; no workflow/plan partial changes. |
| API-CAN-18 | Underlying plan changed and request obsolete | No outdated final decision; current workflow state wins. |
| API-REP-01 | Employee sees replacement needs | Only contextually visible/eligible needs. |
| API-REP-02 | Need closed/not open | Offer creation rejected. |
| API-REP-03 | Employee SICK/LEAVE | Need not eligible / offer rejected. |
| API-REP-04 | Wrong shift eligibility or project-month | Offer rejected. |
| API-REP-05 | Candidate has conflicting duty | Offer rejected. |
| API-REP-06 | Duplicate active offer employee+need | 409 REPLACEMENT_OFFER_ALREADY_EXISTS. |
| API-REP-07 | Original cancellation requester self-offers same assignment | 409 REPLACEMENT_SELF_OFFER_NOT_ALLOWED. |
| API-REP-08 | Valid offer | 201 OPEN; not yet plan assignment. |
| API-REP-09 | Admin views offers | All authorized offers; employee cannot list candidate set. |
| API-REP-10 | Offer becomes invalid after plan change | Not selectable. |
| API-REP-11 | Offers list zero results | 200 empty. |
| API-REP-12 | Foreign-tenant need/offers | 404. |
| API-REP-13 | Offer list filter/status pagination | Deterministic authorized results. |
| API-REP-14 | Approve with valid offer | Workflow + plan mutation succeeds. |
| API-REP-15 | Exactly selected offer SELECTED; all others NOT_SELECTED | Invariant holds. |
| API-REP-16 | Need already resolved by concurrent admin | Second decision 409. |
| API-REP-17 | Candidate becomes unavailable before final commit | Revalidation blocks decision. |
| API-REP-18 | Assignment insert fails after workflow changes staged | Full rollback. |
| API-REP-19 | Replacement approval increments Duty.version once | New version returned/current. |
| API-REP-20 | Mandatory audit persistence fails | Critical mutation rolls back. |
| API-REP-21 | Required outbox intent insert fails (if active side effect) | Critical mutation rolls back. |
| API-REP-22 | No replacement quota behavior | System never rejects because candidate exceeded a monthly takeover count. |

### 9.5 Read models, query, idempotency, errors and OpenAPI

| ID | Scenario | Expected |
| --- | --- | --- |
| API-READ-01 | /me/monthly-plans missing monthStart | 400. |
| API-READ-02 | /me/monthly-plans foreign employee override param | 400 unknown param / no impersonation. |
| API-READ-03 | Published plan changes | Self-service view reflects committed current state. |
| API-READ-04 | Unpublished plan | Employee does not see unpublished tenant planning. |
| API-READ-05 | /me/work-items own state | Only own cancellation/offer status. |
| API-READ-06 | /me/work-items missing monthStart | 400. |
| API-READ-07 | No personal work items | 200 empty state. |
| API-READ-08 | Foreign workflow ID via own context | No exposure. |
| API-READ-09 | Admin work queue open cancellation | Appears as actionable item. |
| API-READ-10 | OPEN_UNFILLED need | Appears in work queue. |
| API-READ-11 | Closed/resolved work | Excluded from actionable queue. |
| API-READ-12 | Work queue tenant/project/month filters | Authorized rows only. |
| API-READ-13 | Work queue page totals | Count only authorized/actionable rows. |
| API-READ-14 | Planning statistics month | Correct plannedWorkdays/day/night counts from ACTIVE published assignments. |
| API-READ-15 | Statistics no duties | Zero values/valid empty semantics. |
| API-READ-16 | Statistics other employee override | Not accepted. |
| API-READ-17 | Removed historical assignment | Not counted as active planned work. |
| API-QRY-01 | Default pagination | page=1, pageSize=25. |
| API-QRY-02 | pageSize >100 / page=0 | 400. |
| API-QRY-03 | Unknown query parameter / sort key | 400. |
| API-QRY-04 | Stable tie sorting | Deterministic id tie-breaker. |
| API-QRY-05 | Search q too short | 400. |
| API-QRY-06 | Employee/project q search scope | Only documented fields participate. |
| API-QRY-07 | Empty paginated collection | 200; totalItems=0; totalPages=0. |
| API-QRY-08 | Cross-tenant hidden rows and totals | Never included in result or totalItems. |
| API-QRY-09 | /me endpoint employeeId/companyId override | 400 / no scope expansion. |
| API-QRY-10 | Admin work queue default ordering | Oldest actionable first. |
| API-QRY-11 | Invalid enum/date/UUID filter | 400 RFC 9457 validation. |
| API-IDEM-01 | Initial publish same key + same request retry | Same logical result; no duplicate effect. |
| API-IDEM-02 | Same publish key + different request | 409 key reuse conflict. |
| API-IDEM-03 | Concurrent same-key publish | One executes; other in-progress/replay; no duplicate. |
| API-IDEM-04 | Cancellation create lost response then retry same key | Exactly one cancellation/need. |
| API-IDEM-05 | Replacement offer retry same key | Exactly one active offer. |
| API-IDEM-06 | Replacement decision retry after committed response loss | No second plan mutation. |
| API-IDEM-07 | Required Idempotency-Key missing/invalid | 400 documented error. |
| API-IDEM-08 | Stale IN_PROGRESS recovery path | No duplicate business success inferred. |
| API-ERR-01 | Validation failure | application/problem+json; VALIDATION_FAILED; field/query errors. |
| API-ERR-02 | Cross-tenant/not-found | Generic RESOURCE_NOT_FOUND without leak. |
| API-ERR-03 | Business conflict | 409 stable domain code. |
| API-ERR-04 | Unexpected exception | 500 INTERNAL_ERROR; no stack/SQL/secret. |
| API-ERR-05 | Correlation ID | Present in response and matches server diagnostic context. |
| API-ERR-06 | Client ignores detail for logic | Contract tests assert stable code, not exact localized prose. |
| API-OAS-01 | Generated OpenAPI validates | CI pass. |
| API-OAS-02 | Unique operationId | No duplicate/missing operation IDs. |
| API-OAS-03 | Public/protected security declarations | Correct sessionCookie usage. |
| API-OAS-04 | Protected unsafe operations | X-CSRF-Token documented required. |
| API-OAS-05 | Concurrency/idempotency headers | Required where Phase 8.7 says so. |
| API-OAS-06 | Paginated schemas/query bounds | Documented accurately. |
| API-OAS-07 | RFC 9457 responses | Critical 4xx/5xx schemas present. |
| API-OAS-08 | No routine 422 | Spec contains no accidental 422 validation contract. |
| API-OAS-09 | No removed replacement quota | No obsolete code/example. |
| API-OAS-10 | Employee PATCH schema | email absent after A8.6-01. |
| API-OAS-11 | Breaking-change diff | CI flags incompatible change. |
| API-OAS-12 | Production Swagger exposure configuration | No unrestricted Swagger UI. |

## 10. 8.10.9 - Selected MVP end-to-end API scenarios

| ID | Flow | Acceptance intent |
| --- | --- | --- |
| E2E-MVP-01 | Planning core | Admin login -> create employee/project -> month assignment -> plan -> entries -> publish -> employee login -> own published plan. |
| E2E-MVP-02 | Cancellation + successful replacement | Employee cancellation -> eligible employee sees need -> offer -> admin decision APPROVE with offer -> plan changes atomically -> statuses update. |
| E2E-MVP-03 | Approve without offer | Employee cancellation -> no offers -> admin APPROVE without replacement -> requester removed -> OPEN_UNFILLED need remains visible in work queue. |
| E2E-MVP-04 | Reject cancellation | Cancellation -> admin REJECT -> original assignment remains -> need closed -> employee sees final status. |
| E2E-MVP-05 | Obsolete after direct plan change | Open cancellation exists -> admin removes requester via authorized plan mutation -> cancellation obsolete + need closed + offers invalidated. |
| E2E-MVP-06 | Concurrency conflict | Two admins edit same Duty/stale version -> one commit succeeds -> second cannot overwrite. |
| E2E-MVP-07 | Tenant isolation | Company A and B fixtures -> manipulate IDs across key read/write flows -> no cross-tenant data/state. |
| E2E-MVP-08 | Idempotent retry | Simulate lost response on critical POST -> retry same Idempotency-Key -> same logical result/no duplicate. |
| E2E-MVP-09 | Work queue and statistics coherence | Workflow decision changes current published plan -> admin queue and employee statistics reflect same committed source of truth. |

## 11. 8.10.10 - Non-functional API verification

| Quality | Verification |
| --- | --- |
| Security | Negative authorization/tenant/CSRF/mass-assignment tests are mandatory release gates. |
| Reliability | Transaction rollback, idempotency retry and post-commit side-effect behavior are verified. |
| Privacy | No medical free text for SICK; no secrets/tokens/internal DB data in responses/log assertions. |
| Error quality | Every expected error is machine-readable, safe and actionable through stable code + correlation ID. |
| Performance | Representative query plans measured later with realistic data; no premature performance claim in Phase 8. |
| OpenAPI | Generated contract validates and breaking/unexpected drift blocks CI. |
| Auditability | Critical mutation integration tests verify mandatory audit persistence where the architecture requires it. |

## 12. 8.10.11 - Test execution policy and CI gates

| Pipeline stage | Minimum suite |
| --- | --- |
| Developer / pre-commit | Unit + focused application tests for changed module. |
| Pull request fast gate | Build/lint + unit/application + generated OpenAPI validation. |
| Pull request integration gate | DB-backed API integration tests for touched vertical; security/tenant negative smoke. |
| Main branch / release candidate | Full API integration + all API-SEC/API-CON/API-IDEM/API-OAS + selected E2E-MVP flows. |
| Staging smoke | Login, plan read, core workflow smoke using synthetic staging data; no production secrets/data. |

| Release blocker rule<br>Any failing cross-tenant, authorization, transaction-atomicity, stale-write, idempotency or OpenAPI-breaking-change test is release-blocking for the MVP. These are not downgraded to 'known issues' to protect schedule. |
| --- |


## 13. 8.10.12 - Coverage policy

Coverage is requirement/risk based, not a single percentage target.

Every 17 MVP use case has at least one API test family.

Every state-changing endpoint has happy-path + validation + authorization + relevant state-conflict coverage.

Every protected endpoint family has at least one no-session test and role/ownership/tenant negative coverage.

Every critical transaction has a rollback/failure-path integration test.

Every concurrency-sensitive Duty mutation has stale-version coverage.

Every idempotency-required command has same-key/same-request and same-key/different-request coverage.

Every public error class used by the endpoint is represented in OpenAPI and at least one integration/contract test.

Line/branch coverage may be reported, but it cannot substitute for missing business/security traceability.

## 14. 8.10.13 - Deferred testing details

| Detail | Deferred to |
| --- | --- |
| Exact Jest/Supertest helper organization, testcontainers vs docker-compose DB orchestration | Phase 11 Development Setup / Phase 13 Testing. |
| Load/performance thresholds and SLO-based tests | Phase 13/16 after representative deployment context. |
| DAST/fuzzing tool selection | Phase 13 Security Testing. |
| Browser UI E2E / Playwright coverage | Phase 13 Frontend/E2E testing. |
| MFA API tests | Only if MFA Stretch is implemented; mandatory before real Production go-live. |
| Email provider contract tests | Only for notification side effects implemented in the release. |

## 15. Phase-8.10 decision register

| ID | Decision |
| --- | --- |
| D-8.10-01 | Traceability is bidirectional: requirement/use case -> API -> test, and test -> originating rule. |
| D-8.10-02 | Phase 8.10 uses the effective baseline; superseded/out-of-MVP Phase-2 criteria are explicitly excluded rather than silently tested. |
| D-8.10-03 | Test design is layered: detailed business rules at lower layers, representative HTTP/E2E tests for wiring/security/contracts. |
| D-8.10-04 | Stable test IDs are independent of source-code file names. |
| D-8.10-05 | Two-tenant synthetic fixtures are mandatory for tenant-isolation evidence. |
| D-8.10-06 | Security negative, concurrency, transaction atomicity, idempotency and OpenAPI drift tests are release-blocking. |
| D-8.10-07 | Coverage is requirement/risk based; no arbitrary code-coverage percentage can replace traceability. |
| D-8.10-08 | Critical E2E coverage is limited to the main MVP verticals; exhaustive combinatorics stay at unit/application/integration layers. |

## 16. Senior review and Phase-8.10 gate

| Gate criterion | Result |
| --- | --- |
| All 17 MVP use cases mapped to API operations | PASS |
| All 17 MVP use cases mapped to test families | PASS |
| Critical acceptance criteria mapped or explicitly superseded/out-of-scope | PASS |
| CR-01 removal reflected; no quota test | PASS |
| CR-03 published-plan semantics reflected | PASS |
| Authentication/authorization/tenant negative tests defined | PASS |
| Validation/error/query tests defined | PASS |
| Concurrency/edit-lease/idempotency tests defined | PASS |
| Critical transaction rollback tests defined | PASS |
| OpenAPI contract/drift tests defined | PASS |
| Canonical synthetic fixture strategy defined | PASS |
| Selected E2E MVP scenarios defined | PASS |
| Blocking issue for Phase 8.11 | NONE |

| PHASE 8.10 - FINAL / PASS FOR PHASE 8.11<br>Traceability & API Test Design is complete. Phase 8 can now enter the final API Design Review, provided Phase 8.11 performs the outstanding controlled backports/reconciliation identified in 8.2-8.9 so that earlier human-readable artifacts, the canonical OpenAPI view and this test baseline describe one consistent API. |
| --- |


## 17. Handoff to Phase 8.11 - API Design Review & Final Gate

Reconcile controlled amendments into canonical 8.2/8.3/8.5 artifacts.

Check endpoint/DTO/status/header/query consistency against Phase 8.9 canonical OpenAPI view.

Check every endpoint has authorization, validation, error and test traceability.

Verify there is no obsolete replacement quota or Draft/Re-Publish behavior.

Review scope for accidental Post-MVP endpoints.

Issue the consolidated Phase-8 API Design FINAL decision and handoff to Phase 9 Security Design.

## 18. Source basis

SecurePlan - Phase 2 FINAL Requirements Specification & Baseline v1.1 (critical acceptance criteria and traceability baseline).

SecurePlan - CR-01 Ersatzlimit Entfernung APPROVED / Baseline Amendment v1.2.

SecurePlan - CR-03 direct published-plan mutation as reflected by approved later architecture.

SecurePlan - Phase 3 FINAL Scope & MVP v1.1.

SecurePlan - Phase 4 Systemanalyse Professional (17 MVP Use Cases).

SecurePlan - Phase 6.5 Transaction, Consistency & Concurrency FINAL v1.0.

SecurePlan - Phase 6.6 Security Architecture & RBAC FINAL v1.0.

SecurePlan - Phase 6.7 API & Integration Architecture FINAL v1.0.

SecurePlan - Phase 6.8 Deployment & Runtime Architecture FINAL.

SecurePlan - Phase 7 Database Design FINAL v1.0.

SecurePlan - Phase 8.2 through 8.9 API Design artifacts and controlled amendments.
