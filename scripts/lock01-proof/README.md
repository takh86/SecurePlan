# SP-11A LOCK-01 proof (review only)

Synthetic-schema PostgreSQL lock proofs plus D6 reference fixtures for the SP-11 planning design review.
No product table, migration or application behaviour is touched. `lock01-proof.mjs` first runs the
disposable-target verification (`verifyRecordedTestTarget`), requires PostgreSQL major 17, creates and drops
only its own `lock01_proof_<hex>` schema and writes a JSON result. Local PG16 runs are exploratory only.

- `node --test scripts/lock01-proof/d6-reference-resolver.test.mjs` – Intl-based oracle for the approved DST fixtures (not the production resolver).
- CI: `.github/workflows/lock01-proof.yml` (postgres:17 tmpfs service, receipt recorded before any write).

## What a PASS does and does not mean

Two separate evidence classes must never be merged:

1. **Synthetic proof (this directory).** Stand-in tables; proves PostgreSQL lock, wait and fresh-statement
   visibility semantics only. It is not a proof about SecurePlan code or the future planning schema.
2. **Real-schema proof (does not exist yet).** Concurrency tests against the actual planning tables and
   services are a PR-1 / PR-3 / PR-4 gate after owner approval of T1–T8. Nothing here substitutes for them.

Known limits of the synthetic model:

- **D4 / D5 stand-ins are simplified.** They refuse on "any live Duty / any active membership beyond a date".
  They do not prove the approved D4/D5 semantics (dependency scope, Employment-period boundaries, SP-10 absence
  interplay, the full E-04 barrier set).
- **`publish()` is lock-only.** It locks the plan row `FOR UPDATE` and records the Duty count it saw. In the
  "publish first, Duty create second" order the plan ends `PUBLISHED` with `published_count=0` and one live Duty
  committed afterwards. This is **not asserted either way**: whether that final state is legal depends on the
  Draft/Publish/Re-Publish contract (CR-03, source not available to this review). The result JSON records the
  observed `finalState` per schedule and labels it `NOT_PROVEN_CONTRACT_UNDECIDED`. The PASS for these
  schedules covers only the publish-time count and lock ordering.
- **Deactivation order.** The "CURRENT order" control models the code's employee → linked-account order and the
  account-prefix control models the proposed correction. Neither runs the real service; both need real-schema tests.
