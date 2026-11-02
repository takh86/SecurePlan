# SP-11 dependency evidence — PR #79 / Issue #51

Recorded 2026-11-02 from the unchanged lockfile after `npm ci`, on Node 24.21.0
and npm 11.19.0. No packages were upgraded. Security remediation and independent
risk acceptance remain under [Issue #51](https://github.com/takh86/SecurePlan/issues/51).

## Integrity and the controlled approval record (L-8)

`package-lock.json` SHA-256:

```text
5099584cb17bcf2f96075f0d1d8f5fe8eb9e96da7c93df3be5b3f8844d667f57
```

This is the value to transfer into the owner's controlled **SP-11A Rev3.1 T6
dependency approval record** for the exact resolver pin. That private record was
not edited; recording and accepting the value there remains an owner action.
The public repository does not contain or replace that controlled approval.

The lockfile and registry `npm view <package>@<version> dist.integrity` agree:

| Package | Locked version | SHA-512 integrity |
|---|---|---|
| `@js-temporal/polyfill` | `0.5.1` | `sha512-hloP58zRVCRSpgDxmqCWJNlizAlUgJFqG2ypq79DCvyv9tHjRYMDOcPFjzfl/A1/YxDvRCZz8wvZvmapQnKwFQ==` |
| `jsbi` | `4.3.2` | `sha512-9fqMSQbhJykSeii05nxKl4m6Eqn2P6rOlYiS+C5Dr/HPIU/7yZxu5qzbs40tgaFORiw2Amd0mirjxatXYMkIew==` |

The polyfill is the only new direct runtime dependency of this slice; jsbi is
its transitive dependency. Neither appears in the captured audit findings.
Integrity agreement establishes package identity, not code safety or approval.

## npm audit findings

An online `npm audit --json` reports **12 affected package entries: 8 moderate,
4 high**, not 12 distinct advisories. Aggregated parent entries overlap their
transitive findings. The normalized JSON evidence SHA-256 is
`9a6cbed4b23106caeb31aef872cae65f4d0688e3ab9cd5ac3042e8114eb348ca`.
Paths below were checked with `npm ls ... --all`.

| Affected package / version | Severity | Dependency path / advisory basis | Reachability assessment |
|---|---|---|---|
| `@nestjs/cli@12.0.8` | moderate | backend dev dependency → minimatch | Build tooling; aggregated entry |
| `@nestjs/platform-express@12.1.2` | high | backend → multer | Runtime dependency; aggregated entry |
| `@vitest/coverage-v8@4.1.11` | moderate | backend dev dependency → vitest | Test tooling; aggregated entry |
| `@vitest/mocker@4.1.11` | moderate | vitest → mocker; [registration injection](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [Windows traversal](https://github.com/advisories/GHSA-xp26-3454-mjgp) | Test/browser mock tooling; exposure depends on a reachable tooling server |
| `body-parser@2.3.0` | high | platform-express → express → body-parser; [compressed-body DoS](https://github.com/advisories/GHSA-27r3-jxmh-p828) | JSON parser is reachable before authentication; incompatible compressed input is relevant to the deployment gate |
| `fast-uri@3.1.8` | moderate | cli → angular-devkit/core → ajv → fast-uri; [scheme decoding](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [path equivalence](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [host canonicalization](https://github.com/advisories/GHSA-wjr9-j795-jxcr), [scheme injection](https://github.com/advisories/GHSA-333x-w4r6-6crp) | Build tooling; no application use found |
| `minimatch@10.2.6` | moderate | cli → minimatch; [glob amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249) | Build tooling; attacker-controlled glob processing would be required |
| `multer@2.4.0` | high | platform-express → multer; [pending fileFilter DoS](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) | Runtime package; no upload interceptors/routes found in application source |
| `nodemailer@10.1.1` | moderate | backend direct dependency; [comment parsing](https://github.com/advisories/GHSA-8c8m-p3m8-cjg8), [group parsing](https://github.com/advisories/GHSA-m943-m63m-w62w), [quoted local-part parsing](https://github.com/advisories/GHSA-85x2-q946-cp5h) | Current delivery is development-only and limited to synthetic recipients; future production mail needs separate review |
| `qs@6.16.0` | moderate | express / body-parser → qs; also dev supertest → superagent → qs; [comma stringify DoS](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw) | Runtime dependency, but no direct application `qs.stringify` use found; parsing alone is not proof of this stringify path |
| `undici@8.12.1` | high | frontend dev dependency jsdom → undici; [advisory collection](https://github.com/nodejs/undici/security/advisories) | Test tooling dependency; application's Node built-in fetch is a separate implementation/version |
| `vitest@4.1.11` | moderate | backend/frontend dev dependency → mocker / coverage | Test tooling; aggregated entry |

These are source-based reachability inferences, not exploit tests or security
risk acceptance. The captured undici entry includes EventSource memory growth,
SRI token case, content-encoding errors, redirect/cache disclosure, TLS option
loss and renegotiation, WebSocket PONG buffering, and decompression errors.

Registry advice identifies patches for most entries (for example mocker/Vitest
4.1.12, body-parser 2.4.0, multer 2.5.0, fast-uri 3.1.9, nodemailer 10.1.4,
undici 8.12.2). Compatibility is **NOT_RUN** here. The minimatch aggregate even
suggests changing the Nest CLI major; do not apply `npm audit fix --force`
without a separately reviewed compatibility plan. No upgrade or risk acceptance
is bundled into planning remediation.
