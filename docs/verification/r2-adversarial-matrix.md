# R2 adversarial matrix (20 cases, machine-readable codes)

Every case runs against real PostgreSQL (embedded, fail-hard — no PG ⇒ the
suite fails, never skips). Codes are the exact `reasonCodes` / error
discriminants asserted in the suites.

| # | Adversary | Expected code / outcome | Suite |
|---|-----------|-------------------------|-------|
| R2-A01 | Re-record a duplicate authentication event id | `AuthenticationStoreError` (insert-once) | `authentication/test/r2-durable-sessions.test.ts` |
| R2-A02 | Cross-tenant session read + revoke | read `undefined`; revoke refused (`/cross-tenant\|different tenant/i`, driver layer) | same |
| R2-A03 | Session row write fails mid-authentication | `PrincipalValidationError`, no principal returned | same |
| R2-A04 | Decide with a revoked session | DENY `PRINCIPAL_REVOKED`, `sessionStatus REVOKED` | `authorization-boundary/test/r2-durable-decisions.test.ts` |
| R2-A05 | Decide with an expired session | DENY `PRINCIPAL_REVOKED`, `sessionStatus EXPIRED` | same |
| R2-A06 | Decide while PostgreSQL is down | throws `AuthorizationDeniedError` carrying `SECURITY_STATE_UNAVAILABLE` | same |
| R2-A07 | Call sync `decide()` with a store attached | throws (must use `decideAsync`) | same |
| R2-A08 | Rotate a manifest wider (op add / ceiling raise) | `ManifestRejectedError`, ACTIVE unchanged | `authorization-boundary/test/r2-manifest-authority.test.ts` |
| R2-A09 | Mutate content under a registered version | `ManifestRejectedError` (immutability) | same |
| R2-A10 | 4 concurrent contenders rotate one version | exactly 1 winner; losers `ManifestRejectedError` | same |
| R2-A11 | Boot with a drifted seed (same version, new bytes) | `ManifestDivergenceError` (boot aborts) | same |
| R2-A12 | Boot a new version with no rotation approval | `ManifestDivergenceError` (boot aborts) | same |
| R2-A13 | Issue a duplicate credential id | `CredentialDeniedError[CREDENTIAL_BINDING_MISMATCH]` | `authorization-boundary/test/r2-credentials.test.ts` |
| R2-A14 | Smuggle `secretMaterial` into durable issuance | `CredentialDeniedError` before any write | same |
| R2-A15 | Revoke another tenant's credential | driver refuses (`TenantIsolationDriverError`); row untouched | same |
| R2-A16 | Execute one envelope twice (S-4 replay) | `REPLAYED_AUTHORIZATION`; side effect runs once | `authorization-boundary/test/r2-enforcement.test.ts` |
| R2-A17 | Reuse an idempotency key (completed / in-flight) | COMPLETED receipt without re-run; live lease ⇒ `IDEMPOTENCY_CONFLICT` | same |
| R2-A18 | Execute after a manifest rotation (stale citations) | `CAPABILITY_VERSION_MISMATCH`; no side effect | same |
| R2-A19 | Revoke the session between decide and execute | `PRINCIPAL_REVOKED`; no side effect | same |
| R2-A20 | Execute a sync-path (R1) envelope durably | `CAPABILITY_VERSION_MISMATCH` (no citations) | same |

Further R2 coverage beyond the matrix (same fail-hard PG posture): S-7
pinned-budget exhaustion (`BUDGET_EXHAUSTED`); GC floors/interlock/orphan
marking; 8-process S-4 contention (exactly-once); 32-process rate sharing
(exactly-max ALLOW); full restart recovery; DB-dump secret scan;
dispatch-time HOLD (`PRINCIPAL_REVOKED`) incl. store-outage throw; T-15
4-planner election (one row, one `ACTION_QUEUED`, no lifecycle regress);
T-18 5-voter sequencing (1..5, intact chain, per-tenant counters).

Defects found by this matrix during R2: R2-DEF-01 (S-5 `leaseToken`
tripped the material-shaped scanner — every idempotent execution failed;
renamed to `leaseNonce`, scanner kept at full strength) and R2-DEF-02
(T-15 loser authorize regressed `QUEUED` → `AUTHORIZED`; authorize state
writes are now forward-only via live-row CAS). See
`R2_IMPLEMENTATION_EVIDENCE.md`.
