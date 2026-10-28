# APPROVED API amendment — Issue #51 HTTP parser errors

**Status: APPROVED by Product/API Owner on 2026-10-28 (decisions A, B and C).**
Date: 2026-10-28. Related work: [Issue #51](https://github.com/takh86/SecurePlan/issues/51).
This amendment records the owner's approval of the transport errors and login JSON-only rule.
It extends the API error catalogue only for the exact cases described here; it does not release any deployment gate.
The full private API baseline is not published in this repository; the checked-in
`error-contract.ts`, existing HTTP contract tests and ADR-0001 are the available
contract evidence. The owner must reconcile this proposal with that baseline.

## Approved decisions

1. Add the following stable transport error pairs, with their problem types:

   | HTTP status | Approved code | Approved `type` |
   |---|---|---|
   | 413 Content Too Large | `REQUEST_BODY_TOO_LARGE` | `/problems/request-body-too-large` |
   | 415 Unsupported Media Type | `UNSUPPORTED_MEDIA_TYPE` | `/problems/unsupported-media-type` |

2. For `POST /api/v1/auth/login`, require `application/json` for a body. MIME
   matching is case insensitive and accepts parameters. Nonempty `text/plain`,
   XML, forms, binary, JSON lookalikes, vendor `+json` and bodies without a
   Content-Type receive 415. Express's existing JSON parser does not parse those
   media types; this proposal does not add support for them. An absent body or
   Content-Length of zero keeps existing DTO validation (400). This restriction
   is local to login; other routes gain no new media-type requirement.

Malformed supported JSON retains approved 400 `INVALID_REQUEST_BODY`. Parsed
JSON with invalid DTO fields retains its existing validation code. No 422 is
introduced. Existing approved error pairs remain unchanged. The two approved codes are registered in `isApprovedErrorCode`; parser handling
is restricted to the documented type/status combinations.

## Implemented transport behavior and scope

The existing 100 KiB JSON parser limit is pinned to **102400 bytes**, without
increasing it. The limit counts bytes, includes JSON syntax/whitespace, and also
applies to chunked and decompressed JSON. A valid login padded to 102400 bytes
reaches the existing login flow; 102401 bytes is rejected before it. This is an
application parser limit, not a total network/connection budget or a proxy design.
The automatic URL-encoded parser and its limits remain in place.

`ProblemDetailsFilter` recognizes only these documented non-Nest parser errors:

| Parser `type` | Required `status` and `statusCode` | Candidate response |
|---|---|---|
| `entity.too.large` | both 413 | 413 `REQUEST_BODY_TOO_LARGE` |
| `charset.unsupported` | both 415 | 415 `UNSUPPORTED_MEDIA_TYPE` |
| `encoding.unsupported` | both 415 | 415 `UNSUPPORTED_MEDIA_TYPE` |
| `entity.parse.failed` | both 400 | 400 `INVALID_REQUEST_BODY` |

Both status fields must agree and the exception must be an `Error`. Status alone,
unknown types, inconsistent metadata and internal stream faults retain sanitized
500 `INTERNAL_ERROR`. There is no generic permission to expose `http-errors`
messages or their `expose` flag. Nest's Express adapter currently turns JSON
`SyntaxError` into `BadRequestException` before the global filter; the existing
code-less Nest 400 fallback continues to handle that path.

Parser errors occur before route guards and DTOs. The login MIME guard runs after
the existing Origin guard and before DTO/controller/login/limiter work. Parser
rejection can therefore take precedence over Origin/session errors, as it already
does on main. For example, a too-large form may hit the existing parser limit
before login's MIME guard. Successful requests still traverse every existing
authentication, throttling, Origin, CSRF and tenant control.

The parser mapping is global because Express parsing is global. The login MIME
guard is route specific. Trusted-proxy configuration, request limits on other
parsers, business rules and SP-10 contracts are outside this amendment.

## RFC 9457 and data exposure

All approved transport errors retain `application/problem+json` and exactly the existing
required fields: `type`, `title`, `status`, `detail`, `instance`, `code` and
`correlationId`. The server-generated `X-Correlation-ID` matches the body and
`/problems/occurrences/{correlationId}`; caller-supplied correlation IDs are ignored.

Fixed details for the new responses are:

- 413: `The request body exceeds the permitted size.`
- 415: `The request media type, charset or content encoding is not supported.`

No parser message, body, charset/encoding value, lengths, stack, credentials, SQL
or arbitrary properties are copied into responses. Expected 400/413/415 errors
produce no application Logger entries. Unexpected errors still emit only the
existing sanitized failure metadata, correlated to the sanitized 500 response.
Tests cover the default application logging path; infrastructure logging and
debug logging in a deployment need the separate security/operations review.

## Reproduction and review evidence

[HTTP evidence](../../reviews/issue-51-http-parser-evidence.md) records the main
baseline, repeatable characterization commit, before/after results and checks.
The HTTP suite exercises the actual AppModule, Nest routing/guards, Express
parsers and global filter; its credential/database dependencies are instrumented
to prove early rejection. Existing PostgreSQL-backed authentication/security tests
provide separate regression coverage for the real login/session flow.

The [Express parser documentation](https://expressjs.com/en/resources/middleware/body-parser/#errors)
defines the error type/status metadata. The installed, lockfile-pinned parser and
Nest Express adapter were also inspected; documentation for newer dependency
versions alone is not proof of current behavior.

## Remaining human and deployment gates

The API owner approved both new error pairs and login's media-type behavior on
2026-10-28 (PR #69 decision record). The private normative Phase 8 baseline must
also be reconciled through controlled internal documentation; this public amendment
is the approval record for the limited protocol extension. Review/CI gates still apply. Do not close Issue #51.

Issue #51 still requires a trusted proxy/client-IP contract and its tests;
bounded login-counter retention, pending-reservation crash handling and documented
HMAC rotation; full deployment-level pre-DTO defenses; authoritative login identity
under locking; expired/revoked cookie and logout/revocation hygiene; and security
review, audit/alert assessment and sign-off. Its explicit proxy/retention ADRs,
negative/concurrent tests and no-public-deployment condition remain open.
