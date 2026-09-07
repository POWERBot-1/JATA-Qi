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

---

## Post-verification remediation (F1 + F2 ONLY, PR #24 unmerged)

Independent verification returned PASS WITH NON-BLOCKING FINDINGS
(13 findings, F1–F12 + R2-OBS assessment; original record above
preserved unchanged). This section records ONLY the two authorized
pre-merge engineering remediations. No F3–F12 work. No R3 work.

### F1 — PostgreSQL pool outage robustness (FIXED)

Finding: `PostgresDriver` attached no pool `'error'` listener; a live
PG outage produced an uncaught exception that terminated the host
(proven live pre-fix: 2 uncaught exceptions on server stop).

Fix (`packages/storage-postgres/src/postgres-driver.ts`, +~60 lines,
no happy-path behavior change):
- pool `'error'` listener → `notePoolError()` (records, never throws,
  never falls back — host survives);
- observable degradation state via `getPoolHealth()` (`degraded`,
  monotonic `poolErrors`, `lastPoolErrorAt/Message`; type
  `PostgresPoolHealth` re-exported from the package index);
- recovery: `degraded` clears on the next operation that completes a
  live round-trip (`beginTransaction` setup success, successful
  `COMMIT`) — no restart, no permissive retry;
- fail-closed chain unchanged and re-proven: ops attempted while PG is
  unreachable fail through the normal query-error path, mapped to
  `SECURITY_STATE_UNAVAILABLE` by `DurableDecider.storageDenied` (never
  ALLOW, never MemoryDriver, never process-local authority).

Regression: `packages/authorization-boundary/test/r2-pool-outage.test.ts`
(5 tests, real embedded-PG stop/restart, no mocks/seam): healthy
baseline (pool not degraded) → outage (host survives, degradation
recorded, decide throws `SECURITY_STATE_UNAVAILABLE`, session issuance
refused) → pre-outage ALLOW envelope executes NO effect during outage
(`SECURITY_STATE_UNAVAILABLE`; gate still durably attached, sync
`decide` still refuses) → restart (decide ALLOWs again, effect runs,
`degraded` clears, outage stays visible in the monotonic counter).
Mutation-checked: with the listener neutralized the suite FAILS (3/5);
with the fix it passes 5/5.

### F2 — R2 lint failures (FIXED)

- `postgres-driver.ts` `ensureIndex`: 12 `no-useless-escape` errors
  removed by writing `"` instead of `\"` in template literals, regex
  literals, and single-quoted strings. SQL semantics byte-identical
  (proven by evaluating old vs new DDL construction over adversarial
  inputs incl. embedded quotes — identical output). No rule
  suppression, no config change.
- `credential-store.ts:16`: removed the unused `ICollection` import.

### Remediation regression (2026-09-07, post-fix)

- `npm run build`: exit 0 (0 TS errors).
- `npm test`: exit 0 — 242 suites, 1151/1151 pass, 0 fail, 0 skipped,
  0 todo (1146 pre-remediation + 5 new F1 tests). No test weakened.
- `npm run lint`: exit 0 — 0 errors, 62 warnings (pre-remediation:
  12 errors + 63 warnings; the 62 remaining warnings are pre-existing
  and untouched).
- R2 scope + F1 suite + T-15 + T-18: 12 suites, 69/69 pass, 0 skip.
- All 20 adversarial cases re-executed live post-fix: 50/50 checks
  pass (P1 10/10, P2 12/12, P3 7/7, P4 6/6, P5 3/3, P6 5/5, P9 7/7 —
  incl. the previously failing host-survival probe, now passing, plus
  a degradation-observability probe).
- `npm run scan:r2`: PASS (8 files, 13 rows, 0 findings).

Changed files (remediation): `storage-postgres/src/postgres-driver.ts`,
`storage-postgres/src/index.ts`,
`authorization-boundary/src/credential-store.ts`,
`authorization-boundary/test/r2-pool-outage.test.ts` (new), this pack.
Main (`0db2f36`) not mutated. Merge still UNAUTHORIZED; awaiting fresh
read-only verification of this corrective patch.
