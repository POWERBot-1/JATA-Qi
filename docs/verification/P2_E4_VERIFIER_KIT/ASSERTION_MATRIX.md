# P2-S8 assertion and failure-injection matrix

**Use:** future separate verifier's assertion-level execution plan.
**Class:** owner-side preparation; no row is an observed independent result.

The exact artifact already contains the P2-S8 suites and runbook. The matrix
pins what must be checked and what counts as a divergence.

| Case | Exact acceptance assertion | Test/input already available at target SHA | Declared expected result | Finding trigger |
|---|---|---|---|---|
| A-17 restart | Durable identity/session/MFA/elevation/delegation state is re-read by a fresh process; kill inside an open transaction rolls back uncommitted state; post-restart digests remain equal | `packages/authentication/test/p2-s8-restart-recovery.test.ts` and `p2-s8-worker.ts` | 4/4 | memory reconstruction, digest mismatch, unclean rollback, skip, or any non-zero exit |
| A-18 fan-out | Concurrent auth/rotation/revocation has zero duplicate accepts, monotonic rotation fingerprints, and zero lost revocations | `packages/authentication/test/p2-s8-fanout-contention.test.ts` and worker | 5/5 | duplicate accept, ordering violation, lost revoke, race failure, or skip |
| A-19 store outage | Authentication and authorization deny with `SECURITY_STATE_UNAVAILABLE`; no memory fallback; after restore, known-good decisions recover | `packages/authentication/test/p2-s8-outage-matrix.test.ts`; `packages/authorization-boundary/test/p2-s8-decision-outage.test.ts` | 3/3 plus 3/3 | ALLOW during outage, fallback, wrong error, no recovery, or skip |
| A-20 failover | New-primary auth/decision state is equivalent by row counts/statuses/digests; no divergence window | `packages/authentication/test/p2-s8-failover.test.ts` | 3/3 | divergent state, stale local state, missing digest, or skip |
| A-21 skew | At -301/-299/+299/+301 seconds, expiry, step-up, elevation, and delegation boundaries flip exactly as specified against the store clock | `packages/authentication/test/p2-s8-skew-matrix.test.ts` | 6/6 | boundary drift, future evidence accepted, or skip |
| A-22 tamper | In-app closed-schema/CAS protections hold; directly mutated event is refused or detected at decision; secret/field allow-list remains clean | `packages/authentication/test/p2-s8-tamper-duplicates.test.ts` | included in 11/11 | accepted tampered decision, secret material persisted, shape bypass, or skip |
| A-23 duplicates | Duplicate enrollment/token import/break-glass activation is denied, idempotently skipped, or one-shot failed as specified; exactly one durable record | same A-22/A-23 suite | included in 11/11 | duplicate durable record, rebind, second activation, or skip |
| Mutation hygiene | Harness structure prevents tracked-tree mutation; source bytes remain unchanged | `packages/authentication/test/p2-s8-mutation-hygiene.test.ts` | 4/4 | tracked write path, changed source, or skip |
| Disposable mutation | Mutants run in disposable stages, fail their targeted assertions, are killed, and leave no tracked or temporary residue | `packages/authentication/test/p2-s7-mutation.test.ts` | 17/17; 15/15 mutants killed | mutant survives, stage leaks, target tree changes, or skip |
| Whole tree | All workspace build/lint/test gates execute; no hidden skipped PostgreSQL integration | root scripts and `.github/workflows/ci.yml` | build exit 0; lint 0 errors; 50/50, 0 failed, 0 skipped | any divergence, hidden skip, or missing summary |

## Negative/failure-injection discipline

The A-17 through A-23 suites are the declared failure-injection program. They
inject process death, contention, store outage, failover, clock skew, direct
row tampering, and duplicate submissions. The verifier must inspect the
negative assertions, not merely the positive count.

The verifier must not:

- remove a failing case;
- turn a real PostgreSQL failure into SKIP;
- replace an outage with a mock that does not exercise the declared seam;
- mutate the tracked target tree;
- accept a test that only reproduces a supplied expected output;
- alter the matrix after seeing results.

If an expected result is not met, the report must retain the observed output,
classify the finding, and issue FAIL or an appropriately qualified result.
