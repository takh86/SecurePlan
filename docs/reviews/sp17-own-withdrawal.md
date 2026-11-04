# SP-17 own cancellation withdrawal

Employees can find their own cancellation requests and current statuses in **Mein Monatsplan**, including after a reload or a new sign-in. The separate month-scoped read is `GET /api/v1/me/work-items?monthStart=YYYY-MM-01`; the personal monthly-plan and statistics DTOs retain their existing shapes. Replacement offers remain outside this slice.

`POST /api/v1/cancellation-requests/{requestId}/withdraw` is a bodyless, CSRF-protected employee action returning the current cancellation DTO with HTTP 200. Only the current owner may withdraw an OPEN cancellation with its matching OPEN need. The transaction sets WITHDRAWN/CLOSED and writes mandatory bounded audits. It preserves the original assignment, duty version and cancellation history.

A repeated call for the same currently owned, consistent WITHDRAWN/CLOSED resource returns 200 without another transition or audit. Other terminal cancellation states return `409 CANCELLATION_NOT_WITHDRAWABLE`; inconsistent workflow data fails technically. No new migration or idempotency-ledger operation is introduced.

The German confirmation explains that the employee remains assigned. It includes keyboard focus containment/restoration, a synchronous duplicate-submit fence, a response deadline, same-resource retry after uncertainty, stale-state reload and account/session boundaries. Private responses use `private, no-store` before guards and parsers.

Real PostgreSQL/HTTP proofs are in `cancellation-requests-real.e2e-spec.ts`; historical receipt/schema regression remains in `cancellation-schema-real.e2e-spec.ts`. Frontend component and parser tests cover the read and recovery contracts. `scripts/sp17-browser-acceptance.mjs` exercises the built application in installed Chrome against a verified disposable PostgreSQL target. The existing SP-16 browser harness scopes duty selectors to the personal-plan section.

Independent Tech Lead review is required. Other browser engines and physical devices are NOT_RUN; 390px Chrome is viewport emulation. Offers, administrative decisions, notifications, deployment and release acceptance remain separate work. Gates #30, #51, #100 and #101 remain open.
