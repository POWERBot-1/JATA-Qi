# R-01 — Runtime Activation & Operable Host Composition

**Status:** implemented in-repo, validated against a real PostgreSQL backend and
against the real shipped CLI binary.
**Milestone type:** runtime/deployment milestone — **no new cognitive stage, no
new engine, no new reasoning, no new policy/authorization, no capability
granting, no human/regulatory decision, no production side effect.**
**Baseline / rollback point:** canonical `main`
`1701f65d0431722583707ac2fe12008da024e76c` (the P-01 merge).
**Series:** new `R` (Runtime/Deployment) series — deliberately *not* `W24`.
W22/W23 = loop integration, O-01 = operation-over-time host, P-01 = durable
persistence substrate, R-01 = making those reachable as a running process.

## The problem R-01 solves

The POST-P-01 audit found that O-01 and P-01 were both **built and unreachable**:

- **G-01 — no runnable host process.** No daemon, no `bin` entrypoint, no CLI
  command. `autoTickMs` defaulted to `0`, and even when set the interval was
  `unref()`'d, so it could not hold a Node process open.
- **G-02 — PostgreSQL not wired into any composition.** `@jataqi/storage-postgres`
  was a *devDependency of loop-host only*. `StorageModule` accepted only
  `memory` | `filesystem` by name; the CLI had no way to select it.
- **G-03 — no boot-time recovery.** `recover()` existed but nothing called it at
  startup, so post-crash work sat stranded until a human intervened.
- **G-12 / G-13 — no CI, no lint.** Every milestone through P-01 merged with no
  automated verification, and `npm run lint` was vacuous (no workspace defined a
  `lint` script, so `--if-present` always succeeded).

R-01 closes exactly these. It adds **no architecture** — it makes existing
architecture runnable.

## What R-01 delivers

```text
jataqi host                                   <- NEW: supervised process entrypoint
   │
   ├─ resolveStorageDriver('postgres')        <- NEW: composition-root driver selection
   │     └─ @jataqi/storage-postgres (P-01, unchanged)
   │
   └─ HostRuntime (NEW supervisor)
         │  assert durable storage  -> fail closed on memory/filesystem
         │  recover()               -> boot-time crash recovery BEFORE first tick
         │  start()
         │  loop { tick(); sleep(next-due-aware) }   <- keep-alive, NOT unref'd
         │  on SIGTERM/SIGINT: stop() -> drain -> release
         ▼
      LoopHostService (O-01, UNCHANGED)
         ▼
      UnifiedLoopService (W22/W23, UNCHANGED — all 34 stages, every dispatch)
```

### 1. `jataqi host` — the supervised process

```bash
STORAGE_DRIVER=postgres \
JATAQI_PG_CONNECTION_STRING='postgres://user:pass@host:5432/jataqi' \
  jataqi host
```

Flags: `--max-cycles <n>`, `--min-idle-ms <n>`, `--max-idle-ms <n>`,
`--allow-non-durable-storage` (local development only).

The keep-alive handle is deliberately **not** `unref()`'d — that was precisely
the defect that made O-01's auto-tick unable to hold a process open.

### 2. Durable driver resolution at the composition root

`STORAGE_DRIVER=postgres` now resolves a real `PostgresDriver`, constructed with
`requireExplicitConfig: true` so a missing connection string throws
`PostgresConfigError` instead of silently attempting localhost.

**Why this lives in `@jataqi/cli` and not `@jataqi/storage`:**
`@jataqi/storage-postgres` depends on `@jataqi/storage`. If the storage
abstraction resolved the Postgres driver *by name*, it would depend on its own
dependent and create a cycle — inverting the layering the P-01 audit verified as
clean. Driver selection is a composition-root concern. Dependency direction
remains `storage-postgres → storage`, never the reverse.

### 3. Boot-time crash recovery

`recover()` runs **before the first tick**, reclaiming only *expired* leases,
validating checkpoints, and quarantining corrupt ones fail-closed. Verified by
an explicit call-ordering test.

### 4. Read-only operator tooling

`host:health`, `host:work [status]`, `host:dlq`. These **observe only** — they
never dispatch, tick, resume, retry, approve, settle, or quarantine anything.
An operator who can *see* a `HELD` item still cannot release it from here.

### 5. CI and lint (first automated merge gate in this repository)

`.github/workflows/ci.yml` runs `npm ci` → `check:workspaces` → `build` → `lint`
→ `test` on every PR to `main`. The workflow explicitly surfaces whether the
PostgreSQL suites executed or SKIPped, so an aggregate green check can never be
misread as PostgreSQL-verified.

`eslint.config.mjs` makes `npm run lint` real. Activating a linter on a
48-workspace codebase that never had one surfaced **55 pre-existing violations**.
R-01's scope is to make the gate *real*, not to perform a repo-wide rewrite that
would touch W22/W23/O-01/P-01 files this milestone must not change. Those
categories are therefore reported as **warnings** (visible and counted) while the
gate fails on anything outside them.

Two are genuine correctness findings, **recorded and deliberately not fixed here**:

| Finding | Location |
|---|---|
| `no-unsafe-finally` | `packages/external-connectors/src/registry.ts:136` |
| `no-useless-catch` | `packages/storage-postgres/src/postgres-collection.ts:52` |

Neither is introduced by R-01. Both are candidates for a future milestone.

## Governance preservation

R-01 changes **no** governance semantics. Verified by test:

| Invariant | Status |
|---|---|
| All 34 stages, in order, on every dispatch | Unchanged — the runtime only decides *when* to call `tick()` |
| Full-loop redispatch on resume (no mid-stage resume) | Unchanged |
| `HELD` terminal-pending-human, never auto-retried | Tested across 6 supervised cycles: dispatched exactly once |
| `DENIED` terminal, never retried | Tested across 6 supervised cycles: dispatched exactly once |
| Fail-closed; never fabricate an outcome | A failing tick is recorded with `completed: 0`; the runtime survives and continues |
| Persistence ≠ authority | The runtime reads no work content and makes no decision |
| Default-deny | Refuses non-durable storage; refuses unknown flags; refuses missing DB config |

**The supervisor has no authority.** It cannot approve, deny, retry a held item,
or alter any outcome. It starts a process and calls existing methods.

## Durability boundary — unchanged by R-01

R-01 **requires** a durable database but does **not** provision, back up,
replicate, or restore one.

| Property | Status after R-01 |
|---|---|
| Durable persistence (survives process death) | ✅ Delivered by P-01, now actually reachable |
| Backup / restore / PITR | ❌ **NOT IMPLEMENTED** |
| Replication / failover / multi-region | ❌ **NOT IMPLEMENTED** |
| RPO / RTO | ❌ **UNDEFINED** |
| Disaster recovery | ❌ **NOT IMPLEMENTED** |

**Durable persistence is not production-grade durability.** A single disk loss
still destroys all state permanently. DR is a future milestone (proposed D-01).

## Test evidence

All results below were **executed live** in the development environment. Where a
result was not executed, it is not claimed.

| Suite | Result |
|---|---|
| `loop-host/test/runtime.test.ts` (15 tests) | **PASS** — supervision, fail-closed, multi-cycle, sleep/wake, HELD/DENIED terminality, shutdown |
| `loop-host/test/runtime-pg.test.ts` (5 tests, **real PostgreSQL**) | **PASS** — durable acceptance, 3-item unattended drain, sleep→wake→complete, boot recovery + redispatch, graceful mid-flight shutdown |
| `loop-host/test/two-process.test.ts` (3 tests, **real PostgreSQL, real separate OS processes**) | **PASS** — exactly one lease winner across two processes; hard-crashed process recovered exactly once; active lease never stolen |
| `cli/test/host-command.test.ts` (14 tests) | **PASS** — arg parsing, credential redaction, driver resolution, **default-behaviour immutability** |
| Full aggregated suite (48 workspaces) | **PASS** |
| Lint | **PASS** (0 errors, 55 pre-existing warnings) |
| CI | **Workflow added in this PR.** Its first execution occurs on the PR itself; no CI result is claimed here |

### Two-process contention — closing the P-01 evidence gap

P-01's "two workers" were two connection pools **inside one Node process**. The
audit classified multi-process contention as NOT DEMONSTRATED. R-01 spawns
**real separate OS processes** (`two-process-worker.mjs`) against one
authoritative PostgreSQL and asserts exactly one lease winner, plus recovery of
a process that dies by `process.exit(9)` while holding a lease.

This closes the two-node case. **Horizontal scale-out beyond two nodes remains
undemonstrated** and is not claimed.

## Default-behaviour immutability

Composing JATA Qi with no configuration behaves exactly as at the P-01 baseline.
Enforced by test:

- default storage driver is still `memory`;
- the loop host is still **not registered** unless `loopHost.enabled === true`;
- when explicitly enabled it still registers **IDLE** and starts nothing.

## Non-goals (explicitly NOT delivered)

Backup/restore/PITR/replication/failover/multi-region (D-01); scale-out beyond
the two-process proof; F-01 event-fabric unification; mid-stage resume; new
stages, engines, or cognition; multimodal sensing; additional LLM providers;
continuous evaluation; self-improvement; quantum; live external side effects or
credential activation; database-level RLS and migration tooling (R-02).

## Rollback

Revert the merge commit. R-01 is purely additive — a new CLI command, a new
driver-name branch, new test suites, a new workflow, a new lint config — and
every default remains off, so reverting restores exact P-01 behaviour.
