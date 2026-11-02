# PR #79 — review remediation and findings closure

Date: 2026-11-02. Original reviewed head: `f79b29d`, branch
`feat/sp11-planning-foundation`. PR remains Draft for independent review; no
merge, issue closure or deployment is authorized by this evidence.

Verified code/test commit: `280e93af8a8ea3a8ebece24f99bf4eeddb47e3dd`.
The following evidence commit changes public documentation and audit comments only.

## Scope and verification

Remediation preserves the SP-11A Rev3.1 create/read slice. It corrects validation
and schema trust, adds missing executable evidence, and documents the remaining
owner decisions. Private documents and the untracked `AGENTS.md` were preserved.

Tests used a newly created PostgreSQL **17.11** container, labelled for this
run, with tmpfs data, loopback-only port binding and a verified receipt including
the cluster/connection identity. No development database was used. DDL-changing
suites create separate databases inside that same disposable cluster, replay the
migrations there, and drop those databases on completion. This prevents catalog
tests from blocking independent concurrency tests. Operational script tests ran
in Node 24 with read-only repository/receipt mounts and only the disposable
container's network, so even the port-5432-only demo tests ran safely.

| Executed local gate | Result |
|---|---|
| `npm ci` | PASS; lockfile unchanged; 12 audit findings remain |
| `npm run lint` / `npm run typecheck` | PASS; zero lint warnings |
| `npm run build` | PASS; backend and frontend |
| `npm test` | PASS: 33 files / **352 tests** |
| `npm run test --workspace=frontend` | PASS: 40 files / **520 tests** |
| `npm run test:e2e` | PASS: 43 files / **946 tests**, including real PostgreSQL concurrency |
| Migrations ×2 + `node scripts/verify-db.mjs` | PASS: fresh 0001–0011 application, replay no-op, verification |
| `npm run test:scripts` | PASS: **34 tests**, none skipped; includes migration checksum/replay/rollback and activation demo |
| `npm run check:public` / `git diff --check` | PASS |

The previous handoff's baseline counts were not re-established on an old
checkout during this remediation. The table above records the current tree's
actual executions. Expected negative-test errors in server logs are not a claim
of unexpected application failures. The failure suite deliberately produces real
PostgreSQL deadlocks, lock timeouts and serialization failures.

## Findings closure

| Finding | Root cause | Fix / disposition | Executable regression | Result | Remaining risk / decision |
|---|---|---|---|---|---|
| H-1 LOCK-01 | Legacy joined-helper / sequential-helper coexistence and hypothetical exclusive company writers lacked direct PG evidence | Added test-only company writer, real helpers, observed wait barriers and NOWAIT inversion probes; corrected the legacy helper's ordering comment | `account-company-lock-concurrency-real.e2e-spec.ts`: **14 tests**, helper/writer first, COMMIT/ROLLBACK, compatible company SHARE locks, atomic plan/audit outcomes | PASS | Joined SQL does not become an ordering API. Companies must remain a production SHARE-only leaf; a future company writer requires the approved protocol migration |
| M-1 roster validation | `ValidateNested` accepts nested arrays, including empty arrays without children; service assumes an object | Require `IsObject({ each: true })` before nested DTO validation | `monthly-plans-real.e2e-spec.ts`: `[[]]`, nested populated/deeper arrays, mixed valid/array, null/scalar/missing fields; HTTP 400, unchanged business state and no request audit | PASS | Body-size limit remains the technical roster bound |
| M-2 schema fail-closed | Signature omitted visibility/behavior flags and temporary names; unqualified SQL could read shadows | Reject RLS/forced RLS/policies, user triggers/rules, disabled FK triggers, unlogged tables, inheritance/partition membership and unusable indexes. Inspect temporary schemas; qualify planning relations with `public.`. Lock against ACCESS EXCLUSIVE DDL and recheck. Planning reads also validate schema | `planning-guards-real.e2e-spec.ts`: real restricted-role RLS hides a membership, but D2 refuses; trigger/rule/persistence/inheritance/shadow regressions. `planning-failures-real.e2e-spec.ts`: both creates return sanitized 500 and roll back unsupported states | PASS | Privileged online schema changes are not an approved application workflow. Future migrations must update the signature and rollout remains controlled |
| M-3 acceptance evidence | Broad acceptance labels exceeded named test evidence; transport and in-flight failure contracts were missing | Added planning JSON guard, actual DB failures and authority races; replaced broad acceptance claims with executable evidence | `planning-failures-real.e2e-spec.ts`: **40 tests**; both creates, authority COMMIT/ROLLBACK before prefix and protection after prefix; real 55P03/40P01/40001 after business + audit writes, late second-member failure, sanitized response and exactly one attempt. Monthly-plan HTTP suite covers 415, charset/encoding, missing Content-Type, malformed/empty JSON and UTF-8 JSON | PASS | Session-only revocation/expiry during a command remains a separate #51 contract; authority recheck is not evidence for that unresolved rule |
| L-1 tripwire | Text patterns missed quoted identifiers and MERGE | Normalize static quoted identifiers and detect MERGE, ONLY, schema spacing and quoted lock aliases | `company-lock-tripwire.spec.ts`: negative probes including quoted UPDATE, DELETE FROM ONLY, MERGE and exclusive company reads; positive SHARE probes | PASS | Static scan cannot prove dynamically generated or out-of-band SQL safe |
| L-2 search path | Constraint deparse output depends on visibility; other existing tenant SQL still requires public | Normalize FK signatures independent of search path; record the deployment invariant below | Guard suite checks `public`, `pg_catalog, public`, and `pg_catalog` signatures; failure suite proves missing-public planning requests fail closed without business/audit writes | PASS for tested behavior | Deployment must preserve the public-resolution invariant; missing public can still cause an outage |
| L-3 Temporal runtime | Millions of full civil-date Intl conversions during transition discovery | Read Intl numeric offsets directly; retain all 13 zones, every 15-minute discovery probe from 2020–2040 and all 481 local-minute comparisons per transition in normal CI `npm test` | Full mandatory differential test and boot goldens; no skip flag or reduced local/CI grid | PASS | Standalone differential run: about 50 s; complete final unit gate: about 60 s. Runtime varies with hardware/load; both sides still use runtime ICU data |
| L-4 performance | Per-member audit round trips and two availability reads hold locks longer | Retained deliberately in this remediation; batching/caching would enlarge the transactional change | Existing atomic roster/overlap/absence races plus late audit rollback regressions | Behavior PASS; new load benchmark NOT_RUN | No latency or production capacity claim. Audit batching and availability-result reuse remain measured follow-up optimizations |
| L-5 Location | Entry URI is reserved but single-entry GET is deferred | Preserve the approved URI; canonicalize UUID case and explicitly document deferred dereferencing | Monthly-plan HTTP suite follows returned entry Location → concealed 404, and reads the entries collection successfully | PASS for documented behavior | Clients must use the collection until SP-12; this is not a new GET endpoint |
| L-6 contract clarity | Annex order and structural-400 test rule need reconciliation; C1's year-range wording is incomplete | Preserve implemented structural 400 before business 409, and existing unrepresentable-interval 409. Flag the two owner clarifications below | Existing HTTP precedence and extreme-year resolver tests | Behavior PASS; documentary decision PENDING | Independent owner/API decision required; this remediation does not invent or ratify a business rule |
| L-7 regression gaps | Important boot/security/audit cases lacked explicit assertions | Added every listed case | Resolver boot failure; DAY-before-NIGHT with reverse insertion; ARCHIVED detail/list/create concealment; MONTHLY_PLAN_CREATED and DUTY_CREATED audit failures; staffed D4 in both orders and outcomes; company suspension during both planning creates | PASS | Browser acceptance and later lifecycle operations remain outside this slice |
| L-8 approval integrity | Controlled T6 record lacked exact lockfile SHA-256 | Computed hash and verified package registry integrity; [dependency record](sp11-dependency-review.md) identifies intended controlled record | `npm ci`, unchanged lockfile hash, registry integrity comparison | Computation PASS; private-record transfer PENDING | Owner must enter/accept the hash in the private T6 record; no private approval was edited or inferred |
| L-9 audit vocabulary | ADR lacked an explicit API-vocabulary statement | Clarified DAY/NIGHT, EMPLOYEE/SHIFT_LEAD, source/status and relation/resource names; aligned scoped code comments | Existing exact DTO/audit assertions and mapper tests; [ADR-0004](../architektur/adr/0004-related-business-audit-catalogue.md) | PASS for implementation; documentary acceptance PENDING | Independent catalogue acceptance and audit operations remain separate gates |

## Deployment and contract boundaries

The application database role must include `public` in its effective
`search_path`, and unqualified tenant relations must resolve to their canonical
public tables, without an untrusted schema taking precedence. The standard
`"$user", public` setup is supported when no shadowing user schema exists;
`pg_catalog, public` is also covered. Do not remove public from the role/database
configuration. Planning table qualification and signature normalization improve
integrity; they do not make all existing workforce/identity SQL independent of
search path. PostgreSQL describes [schema resolution](https://www.postgresql.org/docs/17/ddl-schemas.html),
[table flags](https://www.postgresql.org/docs/17/catalog-pg-class.html) and
[trigger state](https://www.postgresql.org/docs/17/catalog-pg-trigger.html).

Entry `Location` is the contract's reserved resource URI. Following it returns
404 in this slice; clients read `GET /monthly-plans/{planId}/entries`. A successful
create does not imply that a single-entry GET, edit or removal route exists.

Owner/API clarification remains required for (1) literal T5 project-status order
versus the structural-400-before-business-409 rule, and (2) making the existing
year-range use of `DUTY_TIME_RANGE_INVALID` explicit in C1. Current behavior is
tested and unchanged. No private annex was modified or published.

**NOT_RUN / not accepted here:** real browser planning acceptance, production
load/latency, privileged online-DDL rollout, staging/production, operational audit
retention/append-only roles/backups, dependency patch compatibility, and
session-only in-flight revocation/expiry policy. Publish, edit/removal, lease,
idempotency and replacement workflows are not implemented in this PR. Green
local gates do not replace independent code/documentary review or release gates.

The **12 npm audit findings** (8 moderate / 4 high), exact paths, reachability
inferences and package integrity are recorded in the
[Issue #51 dependency follow-up](sp11-dependency-review.md). No broad upgrades or
security risk acceptance are included.
