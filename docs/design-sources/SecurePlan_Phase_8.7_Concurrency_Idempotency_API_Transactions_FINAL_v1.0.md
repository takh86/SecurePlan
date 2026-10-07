# SecurePlan_Phase_8.7_Concurrency_Idempotency_API_Transactions_FINAL_v1.0

> Designquelle: SecurePlan_Phase_8.7_Concurrency_Idempotency_API_Transactions_FINAL_v1.0.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan - Phase 8.7

Concurrency, Idempotency & API Transactions

Planning-unit versioning · Edit leases · Idempotency-Key · ACID command boundaries

| Document control | Value |
| --- | --- |
| Version | v1.0 FINAL |
| Status | COMPLETE - PASS FOR PHASE 8.8 |
| Date | 06.10.2026 |
| API base | /api/v1 |
| Architecture | Modular Monolith · NestJS/TypeScript · PostgreSQL · Shared DB/Schema |
| Normative inputs | Phase 6.5 Transaction/Consistency/Concurrency; Phase 6.7 API Architecture; Phase 7 Database Design; Phase 8.2-8.6 |
| Output | Final API contracts for optimistic concurrency, edit leases, request idempotency and transaction boundaries |

| Phase objective<br>Phase 8.7 turns the approved architecture into concrete HTTP/API behavior. The correctness model remains: short coordination leases improve UX, optimistic version checks prevent lost updates, selected critical commands use request idempotency, and local PostgreSQL ACID transactions keep workflow, planning, audit and required outbox intent consistent. |
| --- |


## 1. Best-practice principles

Concurrency correctness is enforced at commit time; an edit lease is never the final correctness mechanism.

The concurrency boundary is the individual Duty / planning unit, not the complete MonthlyPlan.

Do not silently overwrite a stale write. Return a stable conflict and require the client to reload.

Do not automatically retry a human business decision after a stale-state conflict.

Use Idempotency-Key selectively for retry-sensitive POST commands, not for every mutation.

A retry with the same key and same normalized command must produce the same logical result; the same key with a different command payload is a conflict.

Critical workflow state, plan mutation and mandatory audit are committed in one local PostgreSQL transaction.

External notifications are after-commit side effects; provider failure does not roll back committed business state.

No distributed transaction, Kafka/RabbitMQ or Redis is required for the current modular-monolith MVP.

| Important consistency point<br>This phase deliberately keeps the previously approved 409 semantics for stale planning writes. Because the architecture already standardized stale expected-version conflicts as 409 PLAN_CONCURRENT_MODIFICATION, SecurePlan does not introduce HTTP If-Match/412 semantics in v1. Instead it uses an explicit Expected-Version request header. |
| --- |


## 2. 8.7.1 - Concurrency boundary and version token

The stable MonthlyPlan is a project+month aggregate for navigation and publishing, but it is not the global concurrency unit. Independent Duties may be edited in parallel. Each Duty exposes a monotonically increasing integer version.

| Concept | Final rule |
| --- | --- |
| Concurrency unit | Duty / planning entry. |
| Version source | Duty.version; server-owned integer, starts at database-defined initial value and increments on each successful effective Duty/assignment mutation. |
| Response exposure | MonthlyPlanEntryResponseDto continues to expose version. |
| Client authority | Client may echo an expected version only; it never chooses the new version. |
| Stale behavior | No commit; 409 PLAN_CONCURRENT_MODIFICATION; client reloads current state. |
| MonthlyPlan global revision | Not introduced. |

### 2.1 Expected-Version header

| Expected-Version: 7 |
| --- |


| Rule | Contract |
| --- | --- |
| Header name | Expected-Version |
| Format | Positive base-10 integer. |
| Required on | PATCH monthly-plan entry; DELETE monthly-plan entry; cancellation decision when decision=APPROVE because the command mutates the affected Duty. |
| Not required on | Read endpoints, create entry, cancellation REJECT, offer creation, ordinary master-data changes without a modeled version token. |
| Missing required header | 400 EXPECTED_VERSION_REQUIRED. |
| Malformed header | 400 INVALID_EXPECTED_VERSION. |
| Version mismatch | 409 PLAN_CONCURRENT_MODIFICATION. |
| Success | Response contains the new/current entry version where an entry representation is returned. |

### 2.2 Conditional write

| UPDATE duty<br>SET version = version + 1,<br>    updated_at = now()<br>WHERE company_id = :tenantCompanyId<br>  AND id = :dutyId<br>  AND version = :expectedVersion;<br><br>updated rows != 1<br>  -> ROLLBACK<br>  -> 409 PLAN_CONCURRENT_MODIFICATION |
| --- |


## 3. 8.7.2 - Edit lease API

The lease coordinates two administrators while an edit screen is open. It is short-lived and stored in PostgreSQL. It does not hold a database row lock for the duration of user editing.

| A8.7-01 - Endpoint backport required<br>Phase 8.2 did not yet expose the edit-lease support required by the architecture. Phase 8.7 adds three technical API endpoints. They must be mirrored into the canonical Phase-8.2 endpoint artifact before the Phase-8 final gate. |
| --- |


| Method / endpoint | Purpose | Result |
| --- | --- | --- |
| POST /monthly-plans/{planId}/entries/{entryId}/edit-lease | Acquire a lease. Same actor may reacquire/rotate its token; another active holder causes conflict. | 200 EditLeaseResponseDto |
| PUT /monthly-plans/{planId}/entries/{entryId}/edit-lease | Renew current lease using Edit-Lease-Token. | 200 EditLeaseResponseDto |
| DELETE /monthly-plans/{planId}/entries/{entryId}/edit-lease | Release current lease. Idempotent for an already-expired/released own lease. | 204 |

### 3.1 EditLeaseResponseDto

| {<br>  "leaseToken": "<opaque-random-token>",<br>  "expiresAt": "2026-10-06T14:47:00Z"<br>} |
| --- |


Only the token hash is persisted; the raw lease token is returned to the holder and never logged.

Default lease TTL: 120 seconds, configurable. Active edit UI renews approximately every 60 seconds.

Lease acquire/renew uses an atomic conditional update.

If another actor holds a non-expired lease: 409 RESOURCE_EDIT_LOCKED.

Expired/missing/invalid holder token on a mutation: 409 EDIT_LEASE_NOT_HELD.

### 3.2 Mutation rule

| Mutation | Lease behavior |
| --- | --- |
| PATCH entry | Requires Edit-Lease-Token + Expected-Version. |
| DELETE entry | Requires Edit-Lease-Token + Expected-Version. |
| Replacement/cancellation APPROVE | Server attempts the same Duty lease scope internally for the short command; if another admin actively holds it, reject with 409 RESOURCE_EDIT_LOCKED. |
| Create new entry | No existing Duty lease is possible; uniqueness/transaction rules protect creation. |

| Lease vs. version<br>A valid lease does not guarantee a successful commit. The version check is still mandatory. Conversely, the lease exists to prevent two admins from actively editing the same Duty at the same time and to improve UX before the commit-time check. |
| --- |


## 4. 8.7.3 - Idempotency-Key contract

| Idempotency-Key: 7c3ec8d2-7e7a-4cf5-b4c4-0d9c93c62b94 |
| --- |


| Rule | Final contract |
| --- | --- |
| Header | Idempotency-Key |
| Client generation | Opaque client-generated key; UUIDv4/ULID recommended. |
| Length | 8..128 visible ASCII characters. |
| Storage | Store a cryptographic hash of the key, not the raw value. |
| Scope | company + actor account + operation + key hash. |
| Fingerprint | Hash of normalized semantic request: route resource IDs + relevant body + concurrency precondition; JSON property order/whitespace must not change the fingerprint. |
| Completed same-key retry | Return the same logical result without repeating business effects. |
| Same key + different fingerprint | 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST. |
| Concurrent same-key request | 409 IDEMPOTENCY_REQUEST_IN_PROGRESS, optionally Retry-After. |
| Retention | 24 hours after terminal completion by default; configurable; must exceed supported client retry window. |

### 4.1 Commands that require Idempotency-Key

| Endpoint | Required? | Reason |
| --- | --- | --- |
| POST /cancellation-requests | YES | Double click/retry must not create a second CancellationRequest/ReplacementNeed. |
| POST /replacement-needs/{needId}/offers | YES | Must not create duplicate active offer. |
| POST /cancellation-requests/{requestId}/decision | YES | Final decision may mutate workflow and plan; selection must never execute twice. |
| POST /monthly-plans/{planId}/publish | YES | Initial publish and related side effects must not execute twice. |
| Simple master-data POST/PATCH | NO by default | Business/DB uniqueness plus normal transaction semantics are sufficient for current risk. |
| Reads / GET | NO | HTTP safe/idempotent by method semantics. |

### 4.2 Replay semantics

| same actor + operation + key<br>  -> same fingerprint + COMPLETED<br>       -> return stored/reconstructed logical result<br>       -> Idempotency-Replayed: true<br>       -> fresh Correlation ID for this HTTP attempt<br><br>  -> different fingerprint<br>       -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST<br><br>  -> IN_PROGRESS<br>       -> 409 IDEMPOTENCY_REQUEST_IN_PROGRESS |
| --- |


The replay does not need to be byte-for-byte identical. It must preserve the same business outcome, HTTP status class and resource reference. A new request correlation ID remains useful for diagnostics.

## 5. 8.7.4 - Idempotency persistence and recovery

The Phase-7 schema already supports company_id, actor_account_id, operation, key hash, request hash, state, response metadata/result reference and expires_at. Phase 8.7 defines how the states behave.

| State | Meaning | Behavior |
| --- | --- | --- |
| IN_PROGRESS | A command key has been claimed but terminal business state is not yet recorded. | Duplicate same-key request receives 409. Stale record recovery is allowed only after configured in-progress timeout. |
| COMPLETED | Business transaction committed and replay metadata exists. | Same-key/same-fingerprint retry returns same logical result. |
| FAILED | Technical recovery marker for a claimed command that did not complete cleanly outside the atomic business commit. | Not blindly replayed; recovery decides whether it is safe to retry. No business success may be inferred from FAILED. |

### 5.1 Claim and commit pattern

| 1. Short claim transaction<br>   INSERT/claim IdempotencyRecord(state=IN_PROGRESS)<br>   unique(company, actor, operation, key)<br><br>2. Business transaction<br>   lock/revalidate command state<br>   perform business mutation<br>   write mandatory audit<br>   write required outbox intent<br>   update IdempotencyRecord -> COMPLETED + result metadata<br>   COMMIT<br><br>3. HTTP response<br><br>Crash before step 2 commit<br>   -> business transaction rolls back<br>   -> stale IN_PROGRESS may be recovered later<br><br>Crash after commit but before response reaches client<br>   -> retry sees COMPLETED<br>   -> no repeated business effect |
| --- |


Default stale IN_PROGRESS recovery threshold: 5 minutes, configurable and longer than expected command execution.

Recovery must verify that no completed business result already exists before resetting/retrying.

Expired terminal idempotency records are technical records and may be cleaned according to retention policy.

## 6. 8.7.5 - Transaction model

SecurePlan uses local PostgreSQL ACID transactions. READ COMMITTED remains the default isolation level; correctness is achieved through explicit row locks where needed, conditional version updates, business revalidation and database constraints. SERIALIZABLE is not introduced globally.

| Rule | Decision |
| --- | --- |
| Transaction ownership | Owning Application Service defines the transaction boundary. |
| Cross-module collaboration | Via public application contracts; no controller or foreign repository orchestration. |
| Mandatory audit | If required audit cannot be persisted, the critical mutation rolls back. |
| Required outbox intent | If a release-required outbox event cannot be written inside the transaction, the transaction rolls back. |
| Provider delivery | Happens after commit; provider failure does not roll back business state. |
| Long user editing | Never holds a PostgreSQL row lock; edit lease coordinates instead. |

## 7. 8.7.6 - API transaction boundary matrix

| Command | Atomic state | Key guard |
| --- | --- | --- |
| Create Employee | Employee + linked Account provisioning state + audit as applicable | Unique employeeCode/e-mail; tenant scoped. |
| Set/Delete Availability | AvailabilityDay write/delete correction | One employee/day; tenant scope. |
| Create/Update Project Assignment | Assignment write + relevant audit | One project per employee/month; correction consistency. |
| Create Plan Entry | Duty + initial active assignments + audit | Unique plan/date/shift; eligibility revalidated. |
| PATCH Plan Entry | Duty conditional version update + assignment delta + workflow reconciliation + audit + outbox if required | Lease + Expected-Version; one atomic commit. |
| DELETE Plan Entry | Duty/assignment removal + cancellation/replacement reconciliation + audit + outbox if required | Lease + Expected-Version; no orphan workflow state. |
| Initial Publish | Plan first-publish state + publishedAt + audit + required outbox intent | Idempotency-Key; full revalidation; no re-publish. |
| Create Cancellation | Cancellation OPEN + ReplacementNeed OPEN + audit + idempotency completion | Exactly one visible committed case; no intermediate cancellation-without-need. |
| Withdraw Cancellation | Cancellation WITHDRAWN + Need CLOSED + open offers INVALIDATED + audit | Only OPEN case; original DutyAssignment remains. |
| Create Replacement Offer | Offer OPEN + idempotency completion (+ audit if configured as business audit event) | Need open; one active offer per employee/need. |
| Decision REJECT | Cancellation REJECTED + Need CLOSED + open offers NOT_SELECTED + audit + idempotency completion | No Duty mutation. |
| Decision APPROVE without offer | Cancellation APPROVED + Need OPEN_UNFILLED + old assignment REMOVED + Duty.version increment + audit/outbox + idempotency completion | Expected-Version required; atomic plan/workflow mutation. |
| Decision APPROVE with offer | Cancellation APPROVED + Need RESOLVED + one offer SELECTED + others NOT_SELECTED + old assignment REMOVED + new replacement assignment ACTIVE + Duty.version increment + audit/outbox + idempotency completion | Expected-Version + eligibility revalidation; exactly one replacement. |

## 8. 8.7.7 - Lock order and deadlock prevention

When one transaction must touch both planning and workflow records, all code paths use a deterministic lock order. This prevents plan edits and replacement decisions from locking the same records in opposite order.

| Canonical lock order for a Duty-affecting workflow:<br>1. Duty (planning-unit row)<br>2. affected active DutyAssignment rows<br>3. CancellationRequest<br>4. ReplacementNeed<br>5. ReplacementOffer rows ordered by id<br>6. Audit/Outbox/Idempotency writes<br><br>Initial publish:<br>1. MonthlyPlan row<br>2. Duties in deterministic id order<br>3. related active assignments as needed |
| --- |


Direct plan mutations and replacement decisions follow the same Duty-first ordering when they can touch the same workflow.

Database deadlock/serialization failures are technical transient failures; the infrastructure layer may retry a complete transaction a small bounded number of times only when the command is retry-safe.

Stale Expected-Version conflicts are never auto-retried; they represent a human/business state conflict requiring reload.

## 9. 8.7.8 - Initial publish concurrency

MonthlyPlan has no global operational version, but initial publish must still observe a coherent planning state.

| BEGIN<br>  lock MonthlyPlan<br>  assert status = UNPUBLISHED<br>  lock/read current Duties deterministically<br>  revalidate assignments, eligibility, availability and shift configuration<br>  set status = PUBLISHED, publishedAt = now()<br>  write mandatory audit<br>  write required outbox intent<br>  complete IdempotencyRecord<br>COMMIT |
| --- |


Entry creation/deletion that changes plan membership must coordinate with the plan lifecycle so it cannot create an unvalidated hidden race during the initial publish.

After publish, CR-03 applies: authorized Duty changes commit directly to the PUBLISHED plan after their own revalidation and concurrency check; there is no re-publish step.

## 10. 8.7.9 - Replacement decision transaction

| APPROVE with selected offer<br>  -> validate Idempotency-Key<br>  -> validate Expected-Version<br>  -> ensure no foreign active edit lease blocks Duty<br>  -> BEGIN<br>     lock Duty first<br>     verify Duty.version == Expected-Version<br>     lock Cancellation / Need / offers<br>     revalidate OPEN state<br>     revalidate selected employee:<br>       ACTIVE<br>       same project-month<br>       shift eligible<br>       not SICK/LEAVE<br>       no conflicting Duty<br>     remove old assignment<br>     create replacement assignment<br>     mark selected / non-selected offers<br>     set cancellation APPROVED<br>     set need RESOLVED<br>     increment Duty.version<br>     write mandatory audit<br>     write required outbox intent<br>     mark idempotency COMPLETED<br>     COMMIT<br>  -> return new current state |
| --- |


| Atomic invariant<br>The selected replacement and the resulting plan state are one business fact. SecurePlan never commits 'approved replacement' without the matching DutyAssignment change, and never commits the assignment change without the matching workflow state/audit. |
| --- |


## 11. 8.7.10 - Client and server retry policy

| Situation | Retry rule |
| --- | --- |
| GET/HEAD network failure | Client may retry normally. |
| Critical POST with Idempotency-Key and lost response | Client may retry with exactly the same key and semantic request. |
| 409 PLAN_CONCURRENT_MODIFICATION | Do not blind retry. Reload latest resource, show conflict, let actor decide again. |
| 409 IDEMPOTENCY_REQUEST_IN_PROGRESS | Wait briefly / honor Retry-After, then retry same key. |
| 429 RATE_LIMITED | Honor Retry-After where supplied. |
| Transient DB deadlock/serialization error | Server may retry the whole transaction a small bounded number of times if the command is safe/idempotency-protected. |
| Unexpected 500 on non-idempotent command without key | Client must not blindly retry a potentially committed mutation. |

## 12. 8.7.11 - Error-contract additions

| A8.7-02 - Phase 8.5 catalogue backport<br>The following stable codes are added by this phase and must be mirrored into the canonical Phase-8.5 Error Code Catalog before Phase-8 final closure. |
| --- |


| Code | HTTP | Meaning |
| --- | --- | --- |
| EXPECTED_VERSION_REQUIRED | 400 | Concurrency-sensitive mutation omitted Expected-Version. |
| INVALID_EXPECTED_VERSION | 400 | Expected-Version is malformed/non-positive. |
| PLAN_CONCURRENT_MODIFICATION | 409 | Existing canonical code; current Duty version differs. |
| EDIT_LEASE_TOKEN_REQUIRED | 400 | Interactive plan mutation omitted Edit-Lease-Token. |
| RESOURCE_EDIT_LOCKED | 409 | Another actor holds a valid edit lease for this Duty. |
| EDIT_LEASE_NOT_HELD | 409 | Lease token is invalid, expired or no longer held by actor. |
| IDEMPOTENCY_KEY_REQUIRED | 400 | Critical command omitted Idempotency-Key. |
| IDEMPOTENCY_KEY_INVALID | 400 | Idempotency key does not satisfy transport format. |
| IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST | 409 | Same scoped key is bound to a different request fingerprint. |
| IDEMPOTENCY_REQUEST_IN_PROGRESS | 409 | Same scoped key is currently executing/recovering. |

## 13. Phase-8 contract amendments created by 8.7

| Amendment | Backport target | Required change |
| --- | --- | --- |
| A8.7-01 | Phase 8.2 + 8.3 | Add edit-lease acquire/renew/release endpoints and EditLeaseResponseDto; document Edit-Lease-Token on PATCH/DELETE entry. |
| A8.7-02 | Phase 8.5 | Add lease/version/idempotency error codes listed in section 12. |
| A8.7-03 | Phase 8.2 / OpenAPI | Mark Expected-Version required on entry PATCH/DELETE and APPROVE decision; document 409 stale response. |
| A8.7-04 | Phase 8.2 / OpenAPI | Mark Idempotency-Key required on cancellation create, replacement offer create, decision and initial publish. |

## 14. NestJS implementation target (not feature implementation)

| HTTP boundary<br>  -> Idempotency interceptor/guard for selected commands<br>  -> Expected-Version / Edit-Lease header parsing<br>  -> Application Service<br><br>Application Service<br>  -> tenant + auth context already established<br>  -> lease / business preconditions<br>  -> TransactionManager.run(...)<br>       -> explicit lock order<br>       -> conditional Duty.version update<br>       -> domain/workflow mutation<br>       -> mandatory audit<br>       -> outbox intent if required<br>       -> idempotency completion<br>  -> response DTO<br><br>Repository layer<br>  -> parameterized scoped queries<br>  -> no transaction ownership hidden inside unrelated repositories |
| --- |


| Best practice | Decision |
| --- | --- |
| Transaction boundary visible | Use-case/application service owns it; repositories participate but do not independently commit critical multi-entity workflows. |
| No long transaction around UI | Lease is outside user think-time; DB transaction begins only for the command. |
| No hidden auto-merge | Stale plan changes surface as conflict. |
| No idempotency in controller | Cross-cutting component + application transaction integration. |
| No raw key/token logs | Hash idempotency/lease keys in persistence and redact request headers. |

## 15. 8.7.12 - Mandatory concurrency/idempotency/transaction tests

| ID | Scenario | Expected result |
| --- | --- | --- |
| CON-01 | Two admins read Duty version 7; A commits; B commits version 7 | A succeeds -> v8; B gets 409; A not overwritten. |
| CON-02 | Two different Duties edited concurrently | Both may succeed independently. |
| LEASE-01 | Admin A holds active lease; Admin B acquires same Duty | B gets 409 RESOURCE_EDIT_LOCKED. |
| LEASE-02 | Lease expires while screen open; data changed | Commit fails lease/version guard; no silent overwrite. |
| LEASE-03 | Release already expired own lease | 204 idempotent. |
| IDEM-01 | Create cancellation sent twice same key/payload | One cancellation + one need; retry returns same logical result. |
| IDEM-02 | Same key different payload | 409 key reuse conflict. |
| IDEM-03 | Concurrent same-key critical POST | One executes; other receives in-progress/replay behavior; no duplicate. |
| IDEM-04 | Response lost after commit; retry same key | No second mutation; committed result replayed. |
| IDEM-05 | Expired idempotency record cleanup | Cleanup does not delete business state; business invariants still prevent invalid duplicate. |
| TX-01 | Cancellation create fails after request row but before need | Entire transaction rolls back; neither visible. |
| TX-02 | Replacement selected but new assignment insert fails | Entire decision rolls back. |
| TX-03 | Mandatory audit insert fails | Critical mutation rolls back. |
| TX-04 | Required outbox insert fails inside business transaction | Business transaction rolls back. |
| TX-05 | Provider e-mail fails after commit | Business state remains committed; delivery failure handled separately. |
| TX-06 | Employee becomes SICK while admin decision screen is open | Final revalidation blocks replacement; no partial state. |
| TX-07 | ReplacementNeed already finalized by second admin | Late decision rejected; exactly one final outcome. |
| PUB-01 | Initial publish submitted twice same key | One publish; retry same logical result. |
| PUB-02 | Plan changes while initial publish is validating | Lock/revalidation gives one coherent serial order; no half-published state. |
| LOCK-01 | Plan edit and replacement decision touch same Duty | Deterministic Duty-first locking prevents inconsistent ordering; one serial result. |
| RETRY-01 | Stale Expected-Version | No automatic blind retry. |

## 16. Phase-8.7 decision register

| ID | Decision |
| --- | --- |
| D-8.7-01 | Duty remains the primary planning concurrency boundary; no global MonthlyPlan revision. |
| D-8.7-02 | Expected-Version request header is the v1 optimistic-concurrency transport; stale write stays 409 per approved architecture. |
| D-8.7-03 | Direct interactive Duty PATCH/DELETE requires a valid edit lease token plus Expected-Version. |
| D-8.7-04 | Edit lease defaults to 120s TTL with client renewal around 60s; values are configurable. |
| D-8.7-05 | Idempotency-Key is mandatory only for selected critical POST commands. |
| D-8.7-06 | Idempotency scope is tenant + actor + operation + key; request fingerprint binds the semantic request. |
| D-8.7-07 | Completed idempotency records retain replayability for 24h by default; IN_PROGRESS recovery threshold defaults to 5 min. |
| D-8.7-08 | Idempotency completion is committed in the same business transaction as the critical mutation. |
| D-8.7-09 | PostgreSQL READ COMMITTED + explicit locks/conditional writes/constraints is the default; no global SERIALIZABLE requirement. |
| D-8.7-10 | Duty-affecting multi-entity transactions use deterministic Duty-first lock ordering. |
| D-8.7-11 | No automatic retry for stale/business conflicts; only bounded technical retries for recognized transient DB failures when safe. |
| D-8.7-12 | Business state + mandatory audit + required outbox intent are atomic; external delivery remains after commit. |

## 17. Senior review and Phase-8.7 gate

| Gate criterion | Result |
| --- | --- |
| Concurrency boundary consistent with Phase 6.5/7 | PASS |
| No global MonthlyPlan version introduced | PASS |
| Stale-write transport/status contract finalized | PASS |
| Edit-lease API support completed | PASS |
| Selective Idempotency-Key contract finalized | PASS |
| Idempotency storage/recovery semantics defined | PASS |
| Critical transaction boundaries explicit | PASS |
| Replacement decision remains atomic | PASS |
| Audit/outbox failure semantics preserved | PASS |
| No distributed-system overengineering | PASS |
| Retry policy safe | PASS |
| Mandatory negative/race tests defined | PASS |
| Blocking architecture conflict | NONE |

| PHASE 8.7 - FINAL / PASS<br>Concurrency, Idempotency & API Transactions are complete enough to proceed to Phase 8.8 - Query Design. Before the overall Phase-8 closure gate, amendments A8.7-01 through A8.7-04 must be backported into the canonical 8.2/8.3/8.5/OpenAPI artifacts, alongside earlier A8.2-01 and A8.6-01 corrections. |
| --- |


## 18. Handoff to Phase 8.8 - Query Design

Finalize list filtering, sorting and pagination only where volume/use cases require them.

Keep tenant and ownership predicates server-enforced; query parameters never broaden authorization.

Define month/project/status filters for admin collections and /me read models.

Define stable ordering and pagination metadata without leaking hidden cross-tenant rows.

Preserve the transaction/concurrency semantics from 8.7; query design must not create a second source of truth.

## 19. Source basis

SecurePlan - Phase 6.5 Transaction, Consistency, Concurrency, Idempotency & External Side Effects FINAL v1.0.

SecurePlan - Phase 6.7 API & Integration Architecture FINAL v1.0.

SecurePlan - Phase 7 Database Design FINAL v1.0.

SecurePlan - Phase 8.2 REST Endpoint Design baseline.

SecurePlan - Phase 8.3 DTO Design FINAL v1.0.

SecurePlan - Phase 8.4 Validation Contracts FINAL v1.0.

SecurePlan - Phase 8.5 Error Handling & Error Contract FINAL v1.0.

SecurePlan - Phase 8.6 Authentication & Authorization API Rules FINAL v1.0.
