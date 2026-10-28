# Issue #51 — HTTP parser evidence

Date: 2026-10-28. Scope: candidate pre-DTO parser fix only. The API amendment is
[PROPOSED](../api/proposals/issue-51-http-parser-errors.md), pending human review.

## Baseline reproduced before application changes

- Assigned worktree/branch: `SecurePlan-issue51`, `fix/issue-51-http-parser`.
- `HEAD` and freshly fetched `origin/main` were both
  `dd5f3f8baba4bf982155e7946acd327258700c92`.
- Node 24.21.0; dependencies installed with `npm ci` from the lockfile.
- Characterization commit: `95a5474` (`test(http): reproduce pre-DTO parser findings for issue 51`).
- Command at that commit: `npm run test:e2e -- -- http-parser.e2e-spec.ts`.
- Result: **4/4 PASS** with the original application source untouched.

| Login request, with valid synthetic Origin | Before | Candidate after |
|---|---|---|
| Malformed JSON | 400 `INVALID_REQUEST_BODY` | 400 `INVALID_REQUEST_BODY` |
| JSON above 102400 bytes | 500 `INTERNAL_ERROR`, server error log | 413 `REQUEST_BODY_TOO_LARGE`, no application log |
| JSON with unsupported charset | 500 `INTERNAL_ERROR`, server error log | 415 `UNSUPPORTED_MEDIA_TYPE`, no application log |
| `text/plain` body | 400 `VALIDATION_FAILED` | 415 `UNSUPPORTED_MEDIA_TYPE`, no application log |

Spies established that all four baseline rejections avoided login, limiter and
database transaction work. Parser exceptions carried `entity.too.large` with
`status = statusCode = 413`, and `charset.unsupported` with both fields 415.
Nest mapped malformed JSON's `SyntaxError` into a Nest 400 before the filter.
`text/plain` was skipped by the parsers and reached DTO validation; it was not a
parser exception. The new login guard makes this distinction explicit.

## Representative responses

The examples replace each actual server-generated UUID with `{correlationId}`.
Responses use `Content-Type: application/problem+json` and
`X-Correlation-ID: {correlationId}`.

Before (oversize and unsupported charset):

```json
{
  "type": "/problems/internal-error",
  "title": "Internal Server Error",
  "status": 500,
  "detail": "An unexpected error occurred. Please try again later.",
  "instance": "/problems/occurrences/{correlationId}",
  "code": "INTERNAL_ERROR",
  "correlationId": "{correlationId}"
}
```

Candidate after (oversize):

```json
{
  "type": "/problems/request-body-too-large",
  "title": "Content Too Large",
  "status": 413,
  "detail": "The request body exceeds the permitted size.",
  "instance": "/problems/occurrences/{correlationId}",
  "code": "REQUEST_BODY_TOO_LARGE",
  "correlationId": "{correlationId}"
}
```

Candidate after (unsupported charset, content encoding or login media type):

```json
{
  "type": "/problems/unsupported-media-type",
  "title": "Unsupported Media Type",
  "status": 415,
  "detail": "The request media type, charset or content encoding is not supported.",
  "instance": "/problems/occurrences/{correlationId}",
  "code": "UNSUPPORTED_MEDIA_TYPE",
  "correlationId": "{correlationId}"
}
```

## Regression coverage

`apps/backend/test/http-parser.e2e-spec.ts` has 31 HTTP cases: malformed/scalar
JSON, two unsupported charset paths, unsupported Content-Type/encoding, missing
Content-Type, byte boundaries (102399/102400 accepted, 102401 rejected), multibyte
JSON, chunked and gzip bodies, successful login transport, empty-body validation,
Origin checks, distinct server correlation IDs, health/404/protected routes, and
nine unexpected/unclassified-error cases that retain sanitized 500 responses.
Negative cases assert no credential/limiter/database transaction work and no
application Logger calls. Internal failures assert neutral responses and safe,
correlated logs, even with injected synthetic body, credential and SQL markers.

Chunked/gzip tests use Node's native HTTP client so JSON serialization cannot
change their raw bytes or framing. Login/password and database dependencies in
this focused HTTP suite are mocked; it is not real-password or database evidence.

## Validation

| Check | Result |
|---|---|
| `npm ci` | PASS, Node 24.21.0, unchanged lockfile |
| `npm run lint` | PASS, both workspaces, no warnings |
| `npm run typecheck` | PASS |
| `npm run build` | PASS, backend and frontend |
| `npm test` | PASS, 122 tests / 23 files |
| `npm run test --workspace=frontend` | PASS, 311 tests / 30 files |
| Focused HTTP regression command below | PASS, 83 tests / 6 files |
| `npm run test:e2e` | PASS, 375 tests / 30 files, none skipped |
| `npm run test:scripts` | PASS, 20 tests, none skipped, isolated Node 24 Linux runner |
| Migrations, second idempotent pass, `scripts/verify-db.mjs` | PASS, all nine migrations |
| Pinned denylist generation/integrity check | PASS, 430 entries, expected digest |
| Compiled backend runtime probes | PASS, seven checks: ready/live, malformed/oversize/charset/media, unrelated route |
| `npm run check:public` and `git diff --check` | PASS |
| GitHub-hosted Foundation CI | NOT_RUN locally; draft PR workflow result is recorded in the PR |
| Deployment/proxy/load/security sign-off | NOT_RUN; outside this targeted subtask, still required by Issue #51 |

Focused command:

```text
npm run test:e2e -- -- http-parser.e2e-spec.ts login-http.e2e-spec.ts validation.e2e-spec.ts app.e2e-spec.ts authorization-guard-order.e2e-spec.ts route-access-inventory.e2e-spec.ts
```

Database checks used only dedicated ephemeral PostgreSQL 17 infrastructure for
this worktree, on loopback port 55451 with no shared volumes. Initial checks used
database `secureplan_issue51`; the final full suite used a database named
`secureplan` inside that same dedicated container because the existing session-lock
test safety guard requires that name. The initial full attempt passed 371 tests
and refused four at setup; the final full attempt passed all 375 without changing
the guard. No other worktree's database was migrated, reset or used.

Script tests have a stricter existing local environment guard (loopback:5432,
database/role `secureplan`). They ran from a read-only mount of this worktree in a
Node 24 container sharing **only the dedicated Issue #51 PostgreSQL container's
network namespace**. Its loopback:5432 is that isolated database, not the host's
database. The guard was preserved. An initial host script invocation started
before compiled backend imports existed; it was superseded by the passing
post-build container run.

Runtime probes used the built `apps/backend/dist/main.js`, the real database and
the checksum-verified denylist in an ignored worktree-local runtime directory.
The backend listened only on loopback:30551 and was stopped after verification.
Responses matched the table above; no request-error logs were produced for the
400/413/415 probes. Real successful credential/session behavior is separately
covered by the full PostgreSQL HTTP suite.

The source branch remains based on the baseline recorded above. During this
work, remote main advanced independently with the UI work in PR #68; those
frontend changes are not part of this parser branch's diff.

The Windows sandbox initially prevented npm/Vite worker processes and access to
Docker's named pipe. The affected setup and HTTP checks were rerun with the
required sandbox approval; this did not change application controls or CI.

## Files to review

- `apps/backend/src/configure-app.ts`: explicitly preserve the JSON size limit
  after correlation middleware and before parsing/guards/DTOs.
- `apps/backend/src/common/filters/problem-details.filter.ts`: narrow parser
  classification, safe 413/415 fields and explicit proposed-code handling.
- `apps/backend/src/auth/login-json.guard.ts` and `login.controller.ts`: enforce
  the proposed login MIME requirement after the existing Origin guard.
- `apps/backend/test/http-parser.e2e-spec.ts`: repeatable HTTP/security evidence.
- The proposed amendment and this evidence file: human contract gate and limits.

No migrations, dependency versions, frontend features, SP-10 contracts, proxy
settings or business rules are changed. This evidence does not approve the API
amendment, constitute a security sign-off or complete Issue #51.
