# SecurePlan_Phase_8.8_Query_Design_FINAL_v1.0

> Designquelle: SecurePlan_Phase_8.8_Query_Design_FINAL_v1.0.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan - Phase 8.8

Query Design

Filtering · Sorting · Pagination · Search · Query Security · Performance

| Document control | Value |
| --- | --- |
| Version | v1.0 FINAL |
| Status | COMPLETE - PASS FOR PHASE 8.9 |
| Date | 06.10.2026 |
| API base | /api/v1 |
| Primary goal | Consistent and secure collection/read-model query contracts for the SecurePlan MVP. |
| Inputs | Phase 6.7 API Architecture; Phase 7 Database Design; Phase 8.2-8.7 |
| Output | Canonical query parameters, pagination envelope, sorting/filtering rules, endpoint matrix and test expectations. |

| Phase objective<br>Phase 8.8 defines only the query features justified by SecurePlan use cases and expected volume. The API remains explicit and easy to validate: no generic query DSL, no arbitrary includes/fields, and no client-controlled tenant expansion. |
| --- |


## 1. Best-practice principles

Add pagination, filtering and sorting only where the use case and data volume justify them.

Use explicit per-endpoint query parameters instead of a generic filtering DSL.

Authorization/tenant scoping happens before business filtering and pagination.

Sorting is whitelist-based and deterministic; never expose arbitrary database column names.

Empty collections return 200 with an empty items array, not 404.

Unknown query parameters are rejected to avoid silent contract drift and hidden client mistakes.

Purpose-specific response DTOs remain the data-exposure boundary; no arbitrary fields/include expansion.

Performance work is evidence-driven: correct query -> suitable index -> representative data -> EXPLAIN ANALYZE -> optimize only if needed.

## 2. 8.8.1 - Global query contract

### 2.1 Pagination

SecurePlan uses page-based offset pagination for bounded administrative collections. Cursor pagination is deliberately not introduced in the MVP because the expected data size is small and the admin UI benefits from page numbers and total counts.

| Parameter | Rule |
| --- | --- |
| page | integer; default 1; minimum 1 |
| pageSize | integer; default 25; minimum 1; maximum 100 |

| {<br>  "items": [...],<br>  "pagination": {<br>    "page": 1,<br>    "pageSize": 25,<br>    "totalItems": 83,<br>    "totalPages": 4<br>  }<br>} |
| --- |


| A8.8-01 - Collection response amendment<br>Paginated collection endpoints change from the earlier generic `{ items: T[] }` shape to `{ items: T[], pagination: { page, pageSize, totalItems, totalPages } }`. This must be backported to the canonical Phase-8.3 collection response DTO definitions before the overall Phase-8 final gate. |
| --- |


### 2.2 Sorting

| Concern | Rule |
| --- | --- |
| Parameters | sortBy + sortOrder |
| sortOrder values | asc \| desc |
| Allowed sort keys | Per-endpoint whitelist only. |
| Tie-breaker | Always append a stable unique key, normally id. |
| Unknown sort key | 400 VALIDATION_FAILED. |

| ORDER BY last_name ASC, first_name ASC, id ASC |
| --- |


### 2.3 Filtering

Omitted optional filter means no filtering by that field.

An explicitly empty filter value is invalid unless that endpoint explicitly documents empty-string semantics.

Unknown query parameters are rejected with 400 VALIDATION_FAILED.

Enum/date/UUID query parameters use the same Phase-8.4 validation rules as body/path values.

### 2.4 Search

| Parameter | Rule |
| --- | --- |
| q | trimmed string; minimum 2; maximum 100 characters |
| Employee search | employeeCode, firstName, lastName |
| Project search | name |
| Search engine | Database-backed simple search only; no Elasticsearch/full-text platform for MVP. |

## 3. 8.8.2 - Endpoint query matrix

| Endpoint | Query parameters | Default order | Page? |
| --- | --- | --- | --- |
| GET /employees | q, status, shiftEligibility, page, pageSize, sortBy, sortOrder | lastName ASC, firstName ASC, id ASC | YES |
| GET /projects | q, status, page, pageSize, sortBy, sortOrder | name ASC, id ASC | YES |
| GET /project-assignments | monthStart required; projectId; employeeId; page; pageSize | stable employee/code order | YES |
| GET /employees/{employeeId}/availability | monthStart required | day ASC | NO |
| GET /projects/{projectId}/shift-configuration | effectiveForMonth required | n/a | NO |
| GET /monthly-plans | projectId, monthStart, status, page, pageSize | monthStart DESC, id ASC | YES |
| GET /monthly-plans/{planId}/entries | shiftKind optional | dutyDate ASC, shiftKind ASC, id ASC | NO |
| GET /me/monthly-plans | monthStart required | dutyDate ASC, shiftKind ASC, id ASC | NO |
| GET /cancellation-requests | status, employeeId, projectId, monthStart, page, pageSize, sortBy, sortOrder | createdAt DESC, id ASC | YES |
| GET /me/replacement-needs | monthStart required, page, pageSize | dutyDate ASC, id ASC | YES |
| GET /replacement-needs/{needId}/offers | status, page, pageSize | createdAt ASC, id ASC | YES |
| GET /me/work-items | monthStart required | actionable date ASC, id ASC | NO |
| GET /admin/work-queue | projectId, monthStart, type, page, pageSize, sortBy, sortOrder | createdAt ASC, id ASC | YES |
| GET /me/planning-statistics | monthStart required | n/a | NO |

## 4. 8.8.3 - Employee and Project queries

### 4.1 Employees

| GET /api/v1/employees<br>  ?q=hus<br>  &status=ACTIVE<br>  &shiftEligibility=NIGHT<br>  &page=1<br>  &pageSize=25<br>  &sortBy=lastName<br>  &sortOrder=asc |
| --- |


| Allowed sortBy | Notes |
| --- | --- |
| employeeCode | Stable secondary id tie-breaker. |
| firstName | Case-insensitive presentation sort where supported consistently. |
| lastName | Default primary sort. |
| status | Useful for administrative lifecycle overview. |

Search does not expose sensitive or security fields.

companyId is never an accepted filter because tenant context is server-derived.

### 4.2 Projects

| GET /api/v1/projects?q=north&status=ACTIVE&page=1&pageSize=25&sortBy=name&sortOrder=asc |
| --- |


| Allowed sortBy | Notes |
| --- | --- |
| name | Default. |
| status | Administrative grouping. |

## 5. 8.8.4 - Assignment, availability and shift configuration queries

### 5.1 Project assignments

| GET /project-assignments?monthStart=2026-10-01&projectId=<uuid> |
| --- |


monthStart is required because ProjectAssignment is a month-scoped resource.

projectId and employeeId are optional narrowing filters.

Pagination is enabled because tenant-wide administrative assignment lists can grow across the employee base.

### 5.2 Employee availability

| GET /employees/{employeeId}/availability?monthStart=2026-10-01 |
| --- |


monthStart is required; the endpoint does not return unlimited historical availability.

Results are ordered by day ASC and are not paginated because one month is naturally bounded.

| A8.8-04 - Availability query amendment<br>GET /employees/{employeeId}/availability requires monthStart. This must be reflected in the canonical Phase-8.2 endpoint description and Phase-8.3 query DTO/OpenAPI contract. |
| --- |


### 5.3 Shift configuration

| GET /projects/{projectId}/shift-configuration?effectiveForMonth=2026-10-01 |
| --- |


The earlier GET shape is ambiguous without a month. The server returns the configuration effective for the requested month rather than guessing 'latest' or 'current'.

| A8.8-02 - Shift configuration query amendment<br>effectiveForMonth becomes a required query parameter for GET /projects/{projectId}/shift-configuration. The parameter uses YYYY-MM-01 month semantics. |
| --- |


## 6. 8.8.5 - Planning queries

### 6.1 Monthly plan collection

| GET /monthly-plans<br>  ?projectId=<uuid><br>  &monthStart=2026-10-01<br>  &status=PUBLISHED<br>  &page=1<br>  &pageSize=25 |
| --- |


Filters are optional and may be combined.

Default order is monthStart DESC, id ASC.

No arbitrary date range is added in MVP because the resource is already month-scoped.

### 6.2 Monthly plan entries

| GET /monthly-plans/{planId}/entries?shiftKind=DAY |
| --- |


The collection is naturally bounded by one plan month, so no pagination is introduced.

Optional shiftKind is the only MVP filter.

Default order: dutyDate ASC, shiftKind ASC, id ASC.

### 6.3 Employee personal plan

| GET /me/monthly-plans?monthStart=2026-10-01 |
| --- |


monthStart is required; the API does not silently choose the server's 'current month'.

Employee identity is derived from the session; employeeId is not accepted.

| A8.8-03 - Personal plan query amendment<br>GET /me/monthly-plans requires monthStart in the MVP. This avoids hidden current-date/time-zone semantics and keeps the client explicit. |
| --- |


## 7. 8.8.6 - Cancellation and replacement queries

### 7.1 Cancellation requests

| GET /cancellation-requests<br>  ?status=OPEN<br>  &projectId=<uuid><br>  &monthStart=2026-10-01<br>  &page=1<br>  &pageSize=25<br>  &sortBy=createdAt<br>  &sortOrder=desc |
| --- |


| Allowed sortBy | Use |
| --- | --- |
| createdAt | Default administrative ordering. |
| dutyDate | Operational date-centric view. |
| status | Administrative grouping if mixed statuses are requested. |

### 7.2 Replacement needs

| GET /me/replacement-needs?monthStart=2026-10-01&page=1&pageSize=25 |
| --- |


Only needs visible and eligible to the authenticated employee are returned.

A query filter can narrow authorized data; it can never broaden authorization.

### 7.3 Replacement offers

| GET /replacement-needs/{needId}/offers?status=OPEN&page=1&pageSize=25 |
| --- |


Administrative endpoint; employee self-service does not receive the entire candidate list.

Default order is createdAt ASC, id ASC.

## 8. 8.8.7 - Read-model queries

### 8.1 Admin Work Queue

Admin Work Queue remains a derived read model built from open cancellation/replacement workflow state; it is not a separate writable domain.

| GET /admin/work-queue<br>  ?projectId=<uuid><br>  &monthStart=2026-10-01<br>  &type=REPLACEMENT_NEED<br>  &page=1<br>  &pageSize=25 |
| --- |


| type value | Meaning |
| --- | --- |
| CANCELLATION_REQUEST | Actionable open cancellation case. |
| REPLACEMENT_NEED | Open / open-unfilled staffing need. |

Closed/non-actionable cases are not returned by the Work Queue contract.

Default order is oldest actionable item first: createdAt ASC, id ASC.

### 8.2 Employee work items

| GET /me/work-items?monthStart=2026-10-01 |
| --- |


monthStart is required.

No employeeId parameter exists; identity is derived from the session.

No pagination is needed for the MVP because this is a bounded month-scoped personal read model.

### 8.3 Planning statistics

| GET /me/planning-statistics?monthStart=2026-10-01 |
| --- |


| {<br>  "monthStart": "2026-10-01",<br>  "plannedWorkdays": 15,<br>  "dayShiftCount": 9,<br>  "nightShiftCount": 6<br>} |
| --- |


Statistics are derived from current published planning state; there is no writable statistics source-of-truth table.

No sorting or pagination applies.

| A8.8-05 - Month-scoped personal read models<br>GET /me/work-items and GET /me/planning-statistics explicitly require monthStart. This must be reflected in Phase 8.2/8.3/OpenAPI. |
| --- |


## 9. 8.8.8 - Authorization before filtering and pagination

| Tenant scope<br>  -> ownership / authorization scope<br>  -> business filters<br>  -> sorting<br>  -> pagination<br>  -> purpose-specific DTO |
| --- |


Pagination totals are calculated only over rows the actor is authorized to see. SecurePlan never counts hidden cross-tenant or foreign-personal records and then removes them after pagination.

| Company A scope<br>  -> status=OPEN<br>  -> projectId=<allowed project><br>  -> ORDER BY created_at ASC, id ASC<br>  -> LIMIT/OFFSET |
| --- |


No query parameter may override TenantContext.

No /me endpoint accepts employeeId to impersonate another employee.

A resource deliberately invisible to the actor remains subject to the Phase-8.5 safe 404 policy.

## 10. 8.8.9 - Deliberately excluded query features

| Feature | MVP decision | Reason |
| --- | --- | --- |
| Cursor pagination | NOT USED | Expected volume is small; admin UI benefits from page numbers/counts. |
| Generic filter JSON / OData DSL | NOT USED | Adds validation/security/indexing complexity without MVP value. |
| Elasticsearch / external search engine | NOT USED | Simple employee/project search is sufficient. |
| Arbitrary fields= selection | NOT USED | Purpose-specific DTOs define exposure. |
| Arbitrary include= relationship expansion | NOT USED | Avoid accidental over-fetching/data leakage. |
| Client companyId filter | FORBIDDEN | Tenant context is server-derived. |
| Full plan-history query model | NOT USED | CR-03 keeps current published state as source of truth; audit covers critical history. |

## 11. 8.8.10 - Query validation and error behavior

| GET /employees?pageSize=5000 |
| --- |


Invalid query parameters use the existing RFC 9457 Phase-8.5 contract.

| HTTP 400<br>Content-Type: application/problem+json<br><br>{<br>  "type": "/problems/validation-failed",<br>  "title": "Validation failed",<br>  "status": 400,<br>  "detail": "One or more query parameters are invalid.",<br>  "code": "VALIDATION_FAILED",<br>  "correlationId": "...",<br>  "errors": [<br>    {<br>      "location": "query",<br>      "parameter": "pageSize",<br>      "code": "OUT_OF_RANGE",<br>      "detail": "pageSize must be between 1 and 100."<br>    }<br>  ]<br>} |
| --- |


| Case | Result |
| --- | --- |
| page=0 | 400 VALIDATION_FAILED |
| pageSize=0 or >100 | 400 VALIDATION_FAILED |
| unknown sortBy | 400 VALIDATION_FAILED |
| invalid enum/date/UUID filter | 400 VALIDATION_FAILED |
| unknown query parameter | 400 VALIDATION_FAILED |
| valid collection query with no matches | 200 with items: [] and pagination metadata where applicable |

## 12. 8.8.11 - Performance and index alignment

The database design already provides query-driven indexes for the important SecurePlan workloads: personal monthly plan, open cancellation/replacement work, offers by need, availability/project-month eligibility, sessions and audit. Phase 8.8 keeps the HTTP query vocabulary aligned with those access patterns instead of inventing arbitrary filter combinations.

| API workload | DB support / intent |
| --- | --- |
| Own monthly plan | company/project/month + duty date + active employee assignment indexes. |
| Admin open work | Partial indexes for OPEN cancellations and OPEN/OPEN_UNFILLED replacement needs. |
| Offers by need | company + need + status index. |
| Eligibility checks | availability employee/day + project-month assignment uniqueness. |
| Audit/read diagnostics | resource/time ordered audit index; not exposed as broad MVP user query. |

Do not add one index for every query parameter combination.

Use representative data and EXPLAIN (ANALYZE, BUFFERS) during Phase 13 performance/integration testing.

Materialized views and table partitioning remain unjustified for the expected MVP size.

## 13. 8.8.12 - Mandatory query contract tests

| ID | Scenario | Expected result |
| --- | --- | --- |
| QRY-01 | GET /employees with no query params | Default page=1, pageSize=25 and deterministic default ordering. |
| QRY-02 | pageSize=101 | 400 validation error. |
| QRY-03 | unknown query parameter | 400; not silently ignored. |
| QRY-04 | unknown sortBy | 400. |
| QRY-05 | multiple employees share same last/first name | id tie-breaker keeps order deterministic. |
| QRY-06 | employee search q length 1 | 400 validation error. |
| QRY-07 | employee q search | Search limited to employeeCode/firstName/lastName. |
| QRY-08 | project-assignments without monthStart | 400. |
| QRY-09 | availability without monthStart | 400. |
| QRY-10 | shift-configuration without effectiveForMonth | 400. |
| QRY-11 | /me/monthly-plans without monthStart | 400. |
| QRY-12 | /me/planning-statistics with employeeId | 400 unknown parameter; cannot impersonate. |
| QRY-13 | Company A query with Company B resource/filter ID | No cross-tenant exposure; safe authorization semantics. |
| QRY-14 | work queue with no matches | 200 empty collection. |
| QRY-15 | work queue totalItems | Counts authorized/actionable rows only. |
| QRY-16 | replacement-needs for employee | Only contextually visible/eligible needs. |
| QRY-17 | entries for one month | No pagination; deterministic day/shift ordering. |
| QRY-18 | filter produces zero rows on paginated endpoint | 200, totalItems=0, totalPages=0. |
| QRY-19 | status filter invalid enum | 400 RFC 9457 validation error. |
| QRY-20 | sort direction invalid | 400. |

## 14. Phase-8.8 decision register

| ID | Decision |
| --- | --- |
| D-8.8-01 | Use page-based offset pagination for selected administrative collections. |
| D-8.8-02 | page default=1; pageSize default=25; maximum pageSize=100. |
| D-8.8-03 | Paginated response includes page, pageSize, totalItems and totalPages. |
| D-8.8-04 | sortBy/sortOrder are explicit and whitelist-based per endpoint; all ordering is deterministic. |
| D-8.8-05 | Unknown query parameters are rejected. |
| D-8.8-06 | q search is limited to selected employee/project text fields; no external search engine in MVP. |
| D-8.8-07 | monthStart is required for project assignments, availability and selected /me read models. |
| D-8.8-08 | effectiveForMonth is required for shift-configuration GET. |
| D-8.8-09 | Tenant/ownership authorization scope is applied before business filters, totals and pagination. |
| D-8.8-10 | No generic filter DSL, arbitrary include, arbitrary fields or client tenant filter. |
| D-8.8-11 | Empty collection queries return 200, not 404. |
| D-8.8-12 | Performance optimization remains query/index/measurement driven; no premature materialized view/partitioning. |

## 15. Phase-8.8 amendments and backports

| Amendment | Target | Required change |
| --- | --- | --- |
| A8.8-01 | Phase 8.3 | Add pagination metadata to paginated CollectionResponse DTOs. |
| A8.8-02 | Phase 8.2 / 8.3 | GET shift configuration requires effectiveForMonth. |
| A8.8-03 | Phase 8.2 / 8.3 | GET /me/monthly-plans requires monthStart. |
| A8.8-04 | Phase 8.2 / 8.3 | GET employee availability requires monthStart. |
| A8.8-05 | Phase 8.2 / 8.3 | GET /me/work-items and /me/planning-statistics require monthStart. |
| A8.8-06 | Phase 8.9 | OpenAPI must document each allowed query parameter, default, bound, sort whitelist and pagination envelope. |

## 16. Senior review and Phase-8.8 gate

| Gate criterion | Result |
| --- | --- |
| Pagination strategy defined | PASS |
| Filtering vocabulary explicit | PASS |
| Stable deterministic sorting | PASS |
| Search scope limited and validated | PASS |
| Query validation/error behavior defined | PASS |
| Tenant isolation preserved | PASS |
| /me ownership preserved | PASS |
| Work Queue remains derived | PASS |
| Statistics remain derived | PASS |
| DB index strategy aligned | PASS |
| No generic query overengineering | PASS |
| Blocking architecture conflict | NONE |

| PHASE 8.8 - FINAL / PASS<br>Query Design is complete enough to proceed to Phase 8.9 - OpenAPI / Swagger Contract. Before the overall Phase-8 final gate, amendments A8.8-01 through A8.8-06 must be reconciled into the canonical Phase-8.2/8.3/OpenAPI artifacts together with the earlier controlled corrections from 8.2, 8.6 and 8.7. |
| --- |


## 17. Handoff to Phase 8.9 - OpenAPI / Swagger Contract

Document every endpoint, request/response DTO, authentication requirement and authorization-relevant response.

Document all query parameters, defaults, bounds, enum values, sort-key whitelists and pagination envelope.

Document RFC 9457 responses and stable SecurePlan error codes.

Document Expected-Version, Edit-Lease-Token, Idempotency-Key and X-CSRF-Token headers where applicable.

Keep generated OpenAPI aligned with implemented NestJS contracts and enforce contract drift checks in CI.

## 18. Source basis

SecurePlan - Phase 6.7 API & Integration Architecture FINAL v1.0.

SecurePlan - Phase 7 Database Design FINAL v1.0.

SecurePlan - Phase 8.2 REST Endpoint Design baseline.

SecurePlan - Phase 8.3 DTO Design FINAL v1.0.

SecurePlan - Phase 8.4 Validation Contracts FINAL v1.0.

SecurePlan - Phase 8.5 Error Handling & Error Contract FINAL v1.0.

SecurePlan - Phase 8.6 Authentication & Authorization API Rules FINAL v1.0.

SecurePlan - Phase 8.7 Concurrency, Idempotency & API Transactions FINAL v1.0.
