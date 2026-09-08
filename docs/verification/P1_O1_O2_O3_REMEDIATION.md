# P1 O-1 / O-2 / O-3 carry-forward remediation — verification record

| Field | Value |
| --- | --- |
| Authorization | Explicit **O-1/O-2/O-3 ONLY** remediation directive (2026-09-08). P2/P3+ not authorized; production not authorized; G10/G19 untouched; P0 score FROZEN at 9.484375%. |
| Working branch | `arena/01a08164-jata-qi` (this session's fixed branch) |
| Canonical `main` (baseline) | `ac8926cc88dce4949b3a30f63bc349ad4d50251b` |
| Baseline vs change | HEAD before remediation = `ac8926c`; working tree clean before edits. |
| Environment | 2 vCPU sandbox, Node v22.22.3, Linux; embedded PostgreSQL `embedded-postgres@18.4.0-beta.17`. |
| Scope decision | O-3 confirmed repo-wide (16 embedded-PG allocation sites across ~10 packages). **User explicitly authorized repo-wide cleanup** for O-3. O-2 readiness-retry scoped to the shared R2 harness. O-1 scoped to the one affected test. |

---

## O-1 — order-sensitive R2 enforcement test race — **RESOLVED (B-turned-fix)**

### Reproduction (before any change; canonical `ac8926c` artifact)

`r2-enforcement.test.ts` subtest **"conflicts a duplicate key while the first attempt
holds a live lease"**, run standalone in fresh processes (each ~6 s):

| Campaign | Result |
| --- | --- |
| Pre-fix standalone ×14 | **4 FAIL / 10 PASS** (exit 1 when failing) |
| Failing-run signatures | Run 2: `Missing expected rejection`; Run 6: unhandled `IDEMPOTENCY_CONFLICT` (on the awaited `inFlight`) |

### Root cause

`executeAuthorized(first)` was started **unawaited** and `executeAuthorized(second)`
fired immediately; the test asserted `second` is rejected with `IDEMPOTENCY_CONFLICT`
while `first` holds the lease, and that `first` returns `'first-result'`. In the durable
path the S-5 idempotency lease is won by whichever of the two concurrent executes
reaches `claimIdempotency` first (CAS first-create; loser gets
`IDEMPOTENCY_CONFLICT`). When `second` won the race:

- the second executed and returned, so `assert.rejects(second)` reported
  **`Missing expected rejection`**, and/or
- the awaited `first` (`inFlight`) was the one rejected with `IDEMPOTENCY_CONFLICT`.

**Classification: D/E — test/harness defect (order-sensitive test), NOT a product
defect.** The documented R2 semantics hold exactly in every run: the durable S-5
ledger admits exactly one winner and returns `IDEMPOTENCY_CONFLICT` to the loser;
replay/idempotency/concurrency semantics are correct. The defect was purely the
test's unenforced assumption about which concurrent caller wins.

### Remediation (test-only, deterministic; assertions unchanged)

`packages/authorization-boundary/test/r2-enforcement.test.ts`: the first side effect
now resolves a one-shot `leaseHeld` promise on entry. Because `executeDurable`
commits Tx-1 (which durably claims the S-5 `IN_PROGRESS` lease) **before** invoking
the side effect, the side effect reaching its first await is deterministic proof
`first` holds a live lease. The test awaits `leaseHeld` **before** issuing the second
call. All original assertions are preserved verbatim: `second` must be rejected with
`IDEMPOTENCY_CONFLICT`, `first` returns `'first-result'`, `calls === 1`.

What it does NOT do: no assertion weakened/suppressed; no process-count reduction; no
retry that masks failure; no production code touched (authorization, rate limiting,
idempotency, replay, durable state, fail-closed all byte-identical); no sleep as a
correctness substitute (the wait enforces the test's stated precondition).

### Post-fix verification

| Campaign | Result |
| --- | --- |
| `r2-enforcement.test.ts` standalone ×12 | **12/12 PASS** (pre-fix: 4/14 FAIL) |
| Full `@jataqi/authorization-boundary` suite | **126 tests / 27 suites / 126 pass / 0 fail / 0 skip** |

**Security impact: none.** Change confined to one test file.

---

## O-2 — embedded-PostgreSQL boot `ECONNREFUSED` flake — **RESOLVED (harness correction)**

### Reproduction

Not reproduced in this sandbox across **42 rapid fresh-process boots** (30 sequential +
12 parallel/concurrent, immediate `CREATE DATABASE` + driver-pool open). Pre-existing
prior evidence (documented in `P1_REMEDIATION_V1_V2.md`, O-2) recorded 2/42 rapid
campaign runs failing at `before()` with `ECONNREFUSED`, subtests cancelled.

### Root-cause analysis (code-level)

`bootR2Postgres` (the shared R2 harness, byte-identical in 5 packages) called
`server.initialise()` → `server.start()` → `server.createDatabase(...)`. Embedded-
postgres's `start()` resolves at the postmaster log line **"database system is ready
to accept connections"**, which can precede the TCP listener actually accepting
connections. The first post-boot connection — `createDatabase`'s internal pg client —
was the **only** post-boot connection with **no** bounded readiness retry
(`bootR2StorageKernel` already applies one to the driver pool). A transient
`ECONNREFUSED` there rejects `before()` → whole suite cancelled. Aggravated by
resource contention under rapid back-to-back boots.

**Classification: B/E — harness/environment defect (unguarded startup-readiness
window in test infrastructure); not a product defect** (product fail-closed semantics
unaffected). Note: `pg.start()` on line 202 of `r2-pool-outage.test.ts` (mid-test
restart of the *same* server/data-dir) is unaffected because cleanup runs only in the
final `stop()`.

### Remediation (minimal, deterministic, fail-closed)

`bootR2Postgres` in all 5 identical `r2-pg.ts` harnesses: bounded 3-attempt
readiness retry around `server.createDatabase(...)` for the
`ECONNREFUSED|connection refused|not accepting|terminated` signature, with the same
750·attempt backoff `bootR2StorageKernel` already uses. Any other error, or
persistent failure on the final attempt, **throws** — the suite still FAILS (never
skips, never masks a real outage).

**Security impact: none.** Test-harness only; production durable path untouched.

---

## O-3 — `/tmp` PostgreSQL data-directory accumulation — **RESOLVED (repo-wide)**

### Reproduction / measurement

Each embedded-PG `databaseDir` is `path.join(os.tmpdir(), 'jataqi-<label>-<pid>')`
with `persistent: true`, so embedded-postgres never deletes it and no harness removed
it. Reproduction on this sandbox produced **58 dirs ≈ 2.4 GB (~48 MB each, 1449
files)** from a short campaign — matching the prior documented exhaustion (439 dirs /
100% disk).

Confirmed **repo-wide**: every embedded-PG allocation site in the tracked source uses
the same never-cleaned persistent pid-named directory (`r2-pg.ts` ×5, `cli/p1-pg.ts`,
`commercial-event-stream/pg-harness.ts`, `loop-host/pg-host-harness.ts`,
`storage-postgres/pg-test-harness.ts`, `storage-postgres/p1-rls-probe`,
`commercial-control-plane/f01`, `commercial-memory/t06`,
`knowledge-graph/t06`, `revenue-ledger t05/t06/t07`).

**Classification: E — ops/lifecycle defect (deterministic /tmp accumulation); no
product or security impact in normal operation, but availability/disk exhaustion in
long-lived dev/test hosts. User authorized repo-wide remediation.**

### Remediation (safe, deterministic, per-suite cleanup)

Every harness/test now captures its own dedicated `clusterDir` and removes it
(`fs.rm(…, {recursive, force})`, best-effort — teardown never fails the suite) on
**stop()/after() and on boot-failure**. Each directory is process-exclusive (pid- or
run-unique) and created only by that harness, so cleanup never touches content the
harness did not create and never breaks mid-test server restarts (e.g.
`r2-pool-outage` restarts the same server/data-dir; removal happens only in the final
`after()`/`stop()`).

What it does NOT do: no deletion of unrelated `/tmp` content; only the specific
`jataqi-…-<pid>` cluster dir each harness owns.

### Post-fix verification (leftover `jataqi-*` PG dirs = 0 after every PG-booting suite)

| Package | tests | pass | fail | leftover PG dirs |
| --- | --- | --- | --- | --- |
| @jataqi/authorization-boundary | 126 | 126 | 0 | 0 |
| @jataqi/authentication | 51 | 51 | 0 | 0 |
| @jataqi/commercial-control-plane | 69 | 69 | 0 | 0 |
| @jataqi/commercial-event-stream | 22 | 22 | 0 | 0 |
| @jataqi/commercial-memory | 10 | 10 | 0 | 0 |
| @jataqi/human-approval | 8 | 8 | 0 | 0 |
| @jataqi/knowledge-graph | 47 | 47 | 0 | 0 |
| @jataqi/loop-host | 170 | 170 | 0 | 0 |
| @jataqi/revenue-ledger (incl. T-05/T-06/T-07) | 20 | 20 | 0 | 0 |
| @jataqi/storage-postgres | 44 | 44 | 0 | 0 |
| @jataqi/cli (incl. p1-posture-pg) | 117 | 117 | 0 | 0 (PG) |

After each suite, `ls -d /tmp/jataqi-*` returned **0**. The only residuals observed
anywhere are 7 tiny (~512 B, 3.5 KB total) `/tmp/jataqi-t03-*` directories from
`packages/cli/test/t03-composition.test.ts` — **filesystem-storage `mkdtempSync`
scratch (a single `principals.json`), NOT PostgreSQL clusters.** They predate this
change and are unrelated to the O-3 embedded-PG data-directory accumulation;
documented here and intentionally **not** modified (out of O-3 scope).

**Security impact: none.** Test-harness cleanup only; production PostgreSQL authority,
RLS, tenant isolation, and fail-closed behavior untouched.

---

## File inventory (exact changed files, §8)

**O-1 (1 file):**
- `packages/authorization-boundary/test/r2-enforcement.test.ts` — deterministic lease-hold barrier.

**O-2 + O-3 shared R2 harness (5 byte-identical files):**
- `packages/authorization-boundary/test/r2-pg.ts`
- `packages/authentication/test/r2-pg.ts`
- `packages/commercial-control-plane/test/r2-pg.ts`
- `packages/human-approval/test/r2-pg.ts`
- `packages/loop-host/test/r2-pg.ts`

**O-3 repo-wide harness/test cleanup (11 files):**
- `packages/cli/test/p1-pg.ts`
- `packages/commercial-event-stream/test/pg-harness.ts`
- `packages/loop-host/test/pg-host-harness.ts`
- `packages/storage-postgres/test/pg-test-harness.ts`
- `packages/storage-postgres/test/p1-rls-probe.test.ts`
- `packages/commercial-control-plane/test/f01-event-fabric-pg.test.ts`
- `packages/commercial-memory/test/t06-memory-concurrency-pg.test.ts`
- `packages/knowledge-graph/test/t06-knowledge-tenant-pg.test.ts`
- `packages/revenue-ledger/test/t05-payment-chain-pg.test.ts`
- `packages/revenue-ledger/test/t06-ledger-concurrency-pg.test.ts`
- `packages/revenue-ledger/test/t07-finalization-concurrency-pg.test.ts`

**Documentation (this record):**
- `docs/verification/P1_O1_O2_O3_REMEDIATION.md`

No production `src/` file was modified. No unrelated refactor, no assertion weakening,
no lint/scan suppression, no config change, no hidden fallback.

---

## Required test battery (§7) — results

| Check | Command | Result |
| --- | --- | --- |
| Build (all affected packages) | `npm run build --workspace` per affected package | **all OK**, 0 TS errors |
| O-1 affected test | `r2-enforcement.test.ts` ×12 + full auth-boundary | 12/12; 126/126 |
| O-2 boot flake | 42 rapid fresh-process boots | 0 failures locally (rare/env; code-level root cause fixed) |
| O-3 affected suites | per-package `npm test` | all pass, **0 leftover PG dirs** |
| Full monorepo suite | `npm test` | **50/50 workspaces PASS, 0 fail, 0 skip** |
| Full lint | `npm run lint` | **0 errors, 62 warnings** (identical to pre-change baseline) |
| R2 secret scan | `npm run scan:r2` | **PASS — 8 static files, 13 dump rows, 0 findings** (timestamp artifact restored; not committed) |
| Diff discipline | `git diff` inspected | only the authorized files above changed; no secrets; no suppression; no config/production change |

**Note:** the only observations recorded are passes, failures, and skips above. The
single legacy residual is the tiny cli `t03` FS scratch dir (documented, not part of
this remediation). No TODOs or build errors introduced.

---

## Final disposition

| Finding | Classification | Disposition |
| --- | --- | --- |
| O-1 | Test/harness defect (order-sensitive test); NOT product | **RESOLVED** (deterministic test correction; assertions preserved) |
| O-2 | Harness/environment defect (unguarded startup-readiness window); NOT product | **RESOLVED** (minimal deterministic bounded readiness retry in the R2 harness) |
| O-3 | Ops/lifecycle defect (deterministic `/tmp` PG-dir accumulation) | **RESOLVED** (repo-wide safe cleanup; verified 0 leftover) |

**Security posture: unchanged.** AuthorizationBoundary semantics, durable
authorization/rate/idempotency state, RLS/FORCE RLS, tenant isolation, replay
protection, idempotency, credential revocation, manifest authority, and fail-closed
behavior are byte-identical in `src/` across all three remediations. No production
`src/` file was modified.

**Overall determination: PASS — all three findings resolved/acceptably closed.**
(P0 score remains frozen at 9.484375%. G10 = OPEN / unattributable; G19 = UNRECOVERED —
both untouched. No historical F3–F12 material reconstructed.)

### Remaining limitations / evidence quality
- **O-1**: reproduced before, eliminated after (12/12); strong.
- **O-2**: deterministic on-demand reproduction remains environment-rare; fix is
  grounded in code-level root-cause (the sole unguarded post-boot connection) + prior
  documented observation. Local reproduction was inconclusive (0/42) — classified
  harness/environment; the correction is provably no-weakening.
- **O-3**: directly measured pre/post (58 dirs / 2.4 GB → 0). Strong, repo-wide.
- These results are self-reported on this sandbox and not canonical-CI determinations.

## Merge gate (per directive §12)
**MERGE NOT AUTHORIZED.** Code is committed/pushed and a PR is created only. A
separate, explicit merge authorization is mandatory before any merge. Independent
verification and explicit merge authorization remain outstanding. Production is NOT
authorized. P2 is NOT authorized by this directive.
