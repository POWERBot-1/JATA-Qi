# R2 implementation evidence (implementation pass, NOT independent verification)

Scope: R2 ONLY (PostgreSQL as the sole authoritative security-state store).
R3–R24 are NOT authorized and NOT attempted. This pack records what the
implementation pass executed and observed. It is input to independent
verification — it does not declare R2 verified.

Independent-verification status: NOT PERFORMED. No merge is authorized.

## R2 suites (all fail-hard real PostgreSQL; 0 skipped / 0 todo / no `.only`)

| Suite | Tests | Result |
|---|---|---|
| `authentication/test/r2-durable-sessions.test.ts` | 9 | PASS |
| `authorization-boundary/test/r2-durable-decisions.test.ts` | 8 | PASS |
| `authorization-boundary/test/r2-manifest-authority.test.ts` | 9 | PASS |
| `authorization-boundary/test/r2-credentials.test.ts` | 6 | PASS |
| `authorization-boundary/test/r2-enforcement.test.ts` | 9 | PASS |
| `authorization-boundary/test/r2-retention-gc.test.ts` | 4 | PASS |
| `authorization-boundary/test/r2-multiprocess-restart.test.ts` | 4 | PASS |
| `authorization-boundary/test/r2-no-secrets.test.ts` | 2 | PASS |
| `loop-host/test/r2-session-dispatch.test.ts` | 6 | PASS |
| `commercial-control-plane/test/t15-planaction-dedup.test.ts` | 4 | PASS (6/6 stability runs) |
| `human-approval/test/t18-vote-seq.test.ts` | 3 | PASS (6/6 stability runs) |
| Total new R2 | 64 | 64 PASS, 0 FAIL, 0 SKIP |

Harness: per-package `test/r2-pg.ts` (embedded PostgreSQL, throws when PG
is unavailable — never skips) with bounded boot retry (3 attempts, then
fail). Authorization-boundary suites share `test/r2-fixtures.ts`
(controllable clock shared by gate, broker, AND `SecurityStateStore`).
The multiprocess suite uses `test/r2-two-process-worker.mjs` (copied to
`dist/test` by the package build, same pattern as loop-host).

Adversarial coverage: `r2-adversarial-matrix.md` (R2-A01…R2-A20, exact
codes asserted).

## Defects found and fixed within R2

- R2-DEF-01 (S-5 field tripped its own scanner): the persisted S-5
  `leaseToken` field matched the material-shaped closed-schema guard, so
  EVERY idempotent execution failed closed. Fix: renamed the field to
  `leaseNonce` in `consumption-stores.ts` + `durable-decider.ts` only
  (identifier-only deviation from `R2_DESIGN_FREEZE.md` §S-5, which names
  `leaseToken`; lease + token-matching-CAS-reclaim semantics unchanged;
  the scanner was NOT weakened). Found by `r2-enforcement.test.ts`.
- R2-DEF-02 (T-15 lifecycle regress): a plan-election loser's
  `authorizeDecision` unconditionally put `AUTHORIZED`, clobbering the
  winner's `QUEUED` marker (flaky final state). Fix: authorize state
  writes are now live-row CAS with a forward-only rule (ranks ≥ QUEUED
  preserved; pre-planning verdicts still stand so policy changes take
  effect). Found by `t15-planaction-dedup.test.ts`.

## Observations (no code change; follow-ups, NOT silently expanded)

- R2-OBS-01: enforcement deny-earlies freshness by the 300s skew bound,
  so manifests with `maxLifetimeMs <= R2_SKEW_MS` can never execute
  (conservative, per freeze). R2 fixtures default to 1h. A registration
  floor would be new behavior — NOT implemented; recommend as follow-up.
- R2-OBS-02: the storage tenant boundary (driver) refuses cross-tenant
  CAS before store predicates run (proven in A02/A15) — defense in depth,
  both layers kept.
- R2-OBS-03: `appendLedger`'s 8-attempt CAS loop exhausts under 16-way
  concurrent authorize (pre-existing, outside R2/T-15). The T-15 race
  test uses 4 planners; a ledger write-retry hardening is NOT in scope.

## Latency (R1 vs R2, `scripts/r2-perf.mjs`, `r2-perf.json`)

| Path | n | p50 | p95 | p99 |
|---|---|---|---|---|
| decide R1 (sync, process-local) | 200 | 0.076ms | 0.143ms | 1.375ms |
| decideAsync R2 (durable, PG) | 200 | 3.846ms | 5.678ms | 7.826ms |
| execute R2 (Tx-1 + effect + Tx-2) | 100 | 5.208ms | 6.080ms | 7.621ms |

911 security transactions, 0 serialization/deadlock retries. Second run
reproduced within noise (see `r2-perf.json` for the recorded run).

## Secret scan (`scripts/r2-secret-scan.mjs`, `r2-secret-scan.json`)

Static brace-span scan of all 8 R2 durable sources (no `material` /
`secretMaterial` / `privateKey` / `password` identifier inside any
`.put`/`.cas` span) + live dump scan of all 9 security collections
(presented token material, issued materials, and the `r2-material-`
marker all absent; no material-shaped field names). Result: PASS
(0 findings; negative control verified the detector fires).

## Full sweep (recorded below at sweep time)

- `npm run build`: CLEAN (0 TS errors, ~153s, 2026-09-07)
- `npm test`: Total 50 · Passed 50 · Failed 0 · Skipped 0 (~324s,
  2026-09-07) — includes all 64 new R2 tests, 0 skipped / 0 todo repo-wide
- `npm run lint` on R2-touched files: 0 errors; the 2 remaining warnings
  in `commercial-control-plane-service.ts` are pre-existing and untouched
  (out of scope).

## Changed files (implementation pass)

R2 source: `authorization-boundary` (gate/module/index/durable-decider/
security-state-store/consumption-stores/credential-store/audit/envelope),
`loop-host` (types/host-service), `agent-runtime` (agent),
`autonomous-action-runtime` (action-runtime-service),
`commercial-control-plane` (T-15 election + authorize forward-only),
`human-approval` (T-18 vote-seq), `authentication` (durable sessions,
prior pass). R2 tests: 11 suites + 5 `r2-pg.ts` + `r2-fixtures.ts` +
`r2-two-process-worker.mjs`. Scripts: `r2-perf.mjs`,
`r2-secret-scan.mjs`. Docs: this pack + matrix + `r2-perf.json` +
`r2-secret-scan.json`. `AUTHORIZATION_MANIFESTS_TOKEN` SEALED per R2 (`registerSealed`, immutable
binding; the durable path never consults the in-memory registry).

STOP: commit → push → PR, no merge, await independent verification.
