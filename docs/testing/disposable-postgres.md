# Disposable PostgreSQL test targets

Fixture-capable tests refuse to load without an explicitly supplied
`DATABASE_URL` and `SECUREPLAN_TEST_TARGET_RECEIPT`. A localhost address or
`NODE_ENV=test` alone proves no isolation. The development `.env` is not a test
fallback. Never point fixture tests at the persistent development Compose volume.

Provision a fresh PostgreSQL 17 container with a unique run ID in label
`secureplan.disposable-test`, database/role `secureplan`, a loopback-only port
mapping and tmpfs at `/var/lib/postgresql/data`. Keep its exact full container ID.
Do not reuse existing volumes, shared instances or another run's identity.

Before any migration or fixture, explicitly set the connection and these values:

- `SECUREPLAN_TEST_CONTAINER_ID`: exact newly created container ID.
- `SECUREPLAN_TEST_RUN_ID`: that run's unique label value.
- `SECUREPLAN_TEST_TARGET_RECEIPT`: a local file outside Git.
- Optional `SECUREPLAN_TEST_DOCKER_PATH`: Docker executable on Windows.

Run `node scripts/disposable-test-target.mjs record`. It checks Docker storage,
identity and port mapping, then reads PostgreSQL cluster/database/role/version
identity before creating a credential-free receipt. No receipt is produced for
an ambiguous target. This is a developer/CI safety check, not an attestation
against a malicious operator who controls Docker and the receipt file.

With the explicit connection still set, reverify using
`node scripts/disposable-test-target.mjs` immediately before migrations. Apply
`node scripts/migrate.mjs` twice and run `node scripts/verify-db.mjs`. The normal
operational migration command remains usable for intentional development setup;
it is not a substitute for disposable-target verification during testing.

`npm run test:e2e` and `npm run test:scripts` reverify the receipt and actual
cluster before loading tests. Vitest's E2E global setup also checks direct
invocations. Receipts are valid for at most one day and only the verified host
connection or the same container's internal loopback transport. Every child
process must inherit that exact explicit connection. Run `npm ci` and build
before the script suite; supply the existing login HMAC/denylist requirements
without disabling their checks.

Operational script tests additionally retain their strict development-demo
guard: database `secureplan` on loopback port 5432 and `NODE_ENV=development`.
When a disposable host port differs, run those tests in a Node 24 container in
the **verified PostgreSQL container's network namespace**, with the workspace
and receipt mounted read-only. Set the internal verified connection explicitly.
Do not widen the demo guard or redirect port 5432 to a shared development DB.

CI creates a new labelled tmpfs PostgreSQL service per run/attempt, binds it to
127.0.0.1 and records its receipt before migration/tests. Evidence must identify
the run without publishing credentials, receipt contents or private fixture data.
If cleanup is wanted, recheck the exact disposable container identity first;
never use a broad prune or remove unrelated resources.
