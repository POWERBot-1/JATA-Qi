# P1 adversarial campaign — 30 cases (execution record)

Executed against the P1 implementation on branch `arena/01a07f88-jata-qi`
(parent `10fc9baffbc432eb1ec92cec9cd1f4c86d810a64`) on **2026-09-08**.
Status vocabulary: **EXECUTED** (a fail-hard test with exact assertions ran and
passed in this campaign) / **REGRESSION-COVERED** (the case is proven by an
existing R2/A-01 suite that re-ran green in the full P1 regression sweep —
1193/1193, 0 skipped). No case is reported as PASS on design alone.

| # | Case | Status | Result | Evidence | Residual risk |
|---|---|---|---|---|---|
| 1 | Durable security disabled in production | EXECUTED | PASS — BOOT FAILURE `P1_CFG_DURABLE_SECURITY_REQUIRED` + kernel invariant `p1.production.durable-security` | `cli/test/p1-posture.test.ts` | none |
| 2 | MemoryDriver in production | EXECUTED | PASS — BOOT FAILURE `P1_CFG_STORAGE_DRIVER_NOT_DURABLE` | `cli/test/p1-posture.test.ts` | none |
| 3 | FsDriver in production | EXECUTED | PASS — BOOT FAILURE `P1_CFG_STORAGE_DRIVER_NOT_DURABLE` | `cli/test/p1-posture.test.ts` | none |
| 4 | PostgreSQL outage | EXECUTED | PASS — DENY `SECURITY_STATE_UNAVAILABLE`, host survives, recovery after live round-trip | `cli/test/p1-posture-pg.test.ts` (outage/recovery) + `authorization-boundary/test/r2-pool-outage.test.ts` (regression) | availability only |
| 5 | Security-state initialization failure | EXECUTED | PASS — BOOT FAILURE (open throws; drifted seed ⇒ `ManifestDivergenceError`) | `cli/test/p1-posture.test.ts` (unreachable PG) + `cli/test/p1-posture-pg.test.ts` (drift) + R2-A11/A12 (regression) | none |
| 6 | Credential provider outage | REGRESSION-COVERED + EXECUTED (boot half) | PASS — provider fetch failure ⇒ `CREDENTIAL_*` DENY before side effect (R2 semantics unchanged, re-run green); dev provider at boot ⇒ BOOT FAILURE `P1_CFG_DEV_CREDENTIAL_PROVIDER` (new P1 test) | `authorization-boundary/test/r2-credentials.test.ts` + adversarial 24/36 + `cli/test/p1-posture.test.ts` | a declared-`external` provider cannot be cryptographically verified as KMS-backed (operator accountability — documented) |
| 7 | Session persistence failure | EXECUTED | PASS — record failure rejects authentication (fail-closed); factory that cannot operate durably aborts boot | `authentication/test/p1-auth-factory.test.ts` + R2-A03 (regression) | none |
| 8 | RLS posture failure | EXECUTED | PASS — probe fails closed: missing table `P1_RLS_TABLE_MISSING`, RLS off `P1_RLS_NOT_ENABLED`; boot invariant aborts | `storage-postgres/test/p1-rls-probe.test.ts` + `p1-posture-pg` green boot asserts probe ok | none |
| 9 | BYPASSRLS role | EXECUTED | PASS — `P1_RLS_BYPASSRLS_ROLE` probe failure | `storage-postgres/test/p1-rls-probe.test.ts` | none |
| 10 | Superuser role | EXECUTED | PASS — `P1_RLS_SUPERUSER_ROLE` probe failure | `storage-postgres/test/p1-rls-probe.test.ts` | none |
| 11 | FORCE RLS failure | EXECUTED | PASS — (a) DDL now fail-closed (source fix, P1-GAP-06); (b) probe asserts `relforcerowsecurity` ⇒ `P1_RLS_FORCE_NOT_ENABLED`; (c) canary proves owner-restriction | `storage-postgres/src/tenant-isolation.ts` + `test/p1-rls-probe.test.ts` | none |
| 12 | Tenant substitution | REGRESSION-COVERED | PASS — `TENANT_SUBSTITUTION` + driver cross-tenant refusal (R2-OBS-02 defense in depth retained) | R2-A02/A15 + a01 suites | none |
| 13 | Replay | REGRESSION-COVERED | PASS — `REPLAYED_AUTHORIZATION`, effect once | R2-A16 | none |
| 14 | Concurrent replay (multi-process) | REGRESSION-COVERED | PASS — 8-process exactly-once | `r2-multiprocess-restart.test.ts` | none |
| 15 | Concurrent credential use | REGRESSION-COVERED | PASS — S-3 single-use | `r2-credentials.test.ts` | none |
| 16 | Revocation race (decide→execute) | REGRESSION-COVERED | PASS — post-commit deny, no side effect | R2-A19 | none |
| 17 | Session revocation race (dispatch) | REGRESSION-COVERED | PASS — HOLD `PRINCIPAL_REVOKED`, never dispatched | `loop-host/test/r2-session-dispatch.test.ts` | none |
| 18 | Manifest poisoning | REGRESSION-COVERED | PASS — narrowing-only rotation, approvals, immutability | R2-A08–A12 | none |
| 19 | Lifetime trap (`maxLifetimeMs <= skew`) | EXECUTED | PASS — `ManifestRejectedError` at durable registration (below/equal/boundary/concurrent/seed paths); R1 registry unchanged | `authorization-boundary/test/p1-manifest-lifetime.test.ts` | none |
| 20 | Configuration drift | EXECUTED | PASS — drifted seed ⇒ boot abort | `cli/test/p1-posture-pg.test.ts` (drift) | none |
| 21 | Process restart | EXECUTED | PASS — revocation survives full composition restart | `cli/test/p1-posture-pg.test.ts` (restart) + `r2-multiprocess-restart` (regression) | none |
| 22 | Multi-process fan-out | EXECUTED | PASS — revocation by composition A enforced by a separate OS process running the full production composition (invariants incl. RLS probe green in the worker) | `cli/test/p1-posture-pg.test.ts` (multi-process, `p1-worker.mjs`) | none |
| 23 | Node loss | REGRESSION-COVERED | PASS — S-5 orphan leases marked EXPIRED after grace (never deleted); Tx rollback leaves no partial authority | `r2-retention-gc.test.ts` + R2 restart suites | no new SIGKILL-mid-Tx harness in P1 (R2 evidence + PG tx semantics; documented) |
| 24 | Database reconnect | EXECUTED | PASS — outage→restart→decisions resume; degradation observable; recovery needs a live round-trip | `cli/test/p1-posture-pg.test.ts` + F1 suite (regression) | none |
| 25 | State corruption (row tamper) | REGRESSION-COVERED | PASS — digest/citation mismatch ⇒ deny | R2-A09/A18 | none |
| 26 | Malformed state | REGRESSION-COVERED | PASS — closed-schema rejection | shape tests (all durable suites) | none |
| 27 | Privilege escalation | REGRESSION-COVERED | PASS — wider manifest rejected; `system` role refused at ingress; no `kernel:*` wildcard | adversarial 15/16 + policy suites | none |
| 28 | Secret leakage | EXECUTED | PASS — `scan:r2` re-run: 0 findings (8 files, 13 dump rows); probe diagnostics carry no credentials/connection strings; closed schemas unchanged | `r2-secret-scan.json` (re-run) + `p1-rls-probe.test.ts` diagnostics test | none |
| 29 | Audit failure | REGRESSION-COVERED | PASS — `AUDIT_UNAVAILABLE` fail-closed semantics; **P1-DEF-01 fix strengthened** the durable audit (S-10 is the sole durable channel; the double-write defect made every module-composed durable decision fail closed) | `a01-core`/R2 enforcement suites + `authorization-boundary/src/module.ts` fix | none |
| 30 | Security-state outage / fail-closed verification | EXECUTED | PASS — production-composition outage denies with `SECURITY_STATE_UNAVAILABLE` (never ALLOW); boot canary renders a live DENY | `cli/test/p1-posture-pg.test.ts` + R2-A06 (regression) | none |

**Campaign totals: 30/30 DESIGNED → 30/30 EXECUTED or REGRESSION-COVERED,
30/30 PASS, 0 FAIL.** Two documented residuals (cases 6 and 23) are recorded
with rationale in `P1_IMPLEMENTATION_EVIDENCE.md` §Residuals.
