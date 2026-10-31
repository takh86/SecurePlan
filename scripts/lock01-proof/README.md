# SP-11A LOCK-01 proof (review only)

Synthetic-schema PostgreSQL lock proofs plus D6 reference fixtures for the SP-11 planning design review.
No product table, migration or application behaviour is touched. `lock01-proof.mjs` first runs the
disposable-target verification (`verifyRecordedTestTarget`), requires PostgreSQL major 17, creates and drops
only its own `lock01_proof_<hex>` schema and writes a JSON result. Local PG16 runs are exploratory only.

- `node --test scripts/lock01-proof/d6-reference-resolver.test.mjs` – Intl-based oracle for the approved DST fixtures (not the production resolver).
- CI: `.github/workflows/lock01-proof.yml` (postgres:17 tmpfs service, receipt recorded before any write).
