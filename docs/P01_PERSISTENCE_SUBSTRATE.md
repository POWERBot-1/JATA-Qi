# P-01 — Production Durable Persistence & Recovery Substrate

**Status:** implemented in-repo, validated against a real PostgreSQL backend.
**Milestone type:** persistence milestone — **no new cognitive stage, no new
reasoning, no policy/authorization, no capability granting, no human/regulatory
decision, no production execution.** Persistence remains infrastructure.
**Baseline:** canonical `main` `3ea6ad30cf3a60ade1aa85b2c524f080ac81d953`
(post-O-01). O-01 remains CLOSED and immutable.

## What P-01 establishes

P-01 replaces the single-process memory/filesystem durability ceiling behind
the loop-host's queue, leases, and checkpoints with an authoritative,
transactional, database-backed persistence substrate — while preserving the
existing architecture, governance, and W22/W23/O-01 semantics.

```text
@jataqi/loop-host      (unchanged orchestration boundary)
        │  public storage interfaces only (never PostgreSQL APIs)
        ▼
@jataqi/storage        (ICollection.cas, IStorageTransaction, IStorageDriver.beginTransaction)
        │
        ├── MemoryDriver   (dev/test; per-document CAS in-process)
        ├── FsDriver       (dev-only single-process; per-document CAS)
        └── PostgresDriver (@jataqi/storage-postgres; row-lock CAS + real transactions)
```

Dependency direction is preserved and enforced:
`loop-host → unified-loop → governance/capability fabrics → storage`, and the
new `@jataqi/storage-postgres` depends only on `@jataqi/storage` (+ `pg`). There
is no `storage → loop-host`, no `storage → unified-loop`, and no cycle.

## What changed

- **`@jataqi/storage` interface (minimal additive seam).**
  - `ICollection.cas(id, guard, makeNext)`: a single-document, driver-atomic
    compare-and-swap. `guard` is a pure synchronous predicate on the current
    document; the backend evaluates it under an exclusive lock/row-lock so two
    concurrent writers cannot both observe the same pre-state.
  - `IStorageTransaction` + optional `IStorageDriver.beginTransaction()`: a real
    multi-operation transaction over one or more collections.
  - Only the two existing implementers were updated (memory & filesystem); all
    consumers of the interface are unaffected (verified by the full suite).
- **`@jataqi/storage-postgres` (new workspace).** A `PostgresDriver` implementing
  `IStorageDriver`: collections (JSONB rows, deterministic table derivation),
  namespaces, blobs, `cas` via `SELECT … FOR UPDATE`, `beginTransaction` with
  `BEGIN/COMMIT/ROLLBACK`, and a versioned schema guard (`jata_qi_schema`) that
  fails closed on an incompatible schema. Config is externalized (env
  `JATAQI_PG_CONNECTION_STRING` / `PG*` or explicit options); missing config
  throws `PostgresConfigError` (fail closed, never a silent default).
- **`@jataqi/loop-host` (persistence-path only).** The queue's guarded state
  transitions (lease, dispatch, settle, retry, sleep, reclaim, resume,
  quarantine) now run as atomic compare-and-swaps instead of read-then-write,
  making them concurrency-safe across multiple workers/processes on a
  database-backed driver. Idempotent enqueue uses a deterministic id derived
  from (tenant, key) so two concurrent enqueues can never duplicate. A
  token-guarded `renewLease` was added. Checkpoint rows use deterministic ids
  keyed by (work item, monotonic sequence). The loop-host public API and O-01
  orchestration semantics are unchanged; its runtime dependencies are unchanged.

## Database target

PostgreSQL is the production target. It is implemented behind the existing
`@jataqi/storage` abstraction: development/test (memory) and dev filesystem
storage remain available; higher layers never import PostgreSQL types. To use it
in a composition root:

```ts
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
// driver reads JATAQI_PG_CONNECTION_STRING (or PG*) / explicit options
const storage = new StorageModule({ driverInstance: new PostgresDriver({ requireExplicitConfig: true }) });
```

No production database is deployed and no credentials are invented by this
milestone; P-01 only makes the substrate available and proven.

## Guarantees (honest classification)

**Implemented and demonstrated against real PostgreSQL in this repository's
integration suites:**

| Area | Guarantee |
|---|---|
| Database-backed persistence | Collection/work-item/lease/checkpoint rows live in PostgreSQL. |
| Transactional consistency | Real `BEGIN/COMMIT/ROLLBACK`; multi-collection commit & rollback demonstrated. |
| Concurrent worker safety | Two independent pools ("workers") can never both win one lease; row-lock CAS is the commit point. |
| Lease authority | Unique ownership, expiry, unguessable token/fencing, safe renewal, atomic acquisition, safe reclamation, stale-holder rejection. |
| Checkpoint ordering | Monotonic per-item sequence; a stale writer cannot advance/overwrite a newer checkpoint. |
| Idempotency | Duplicate enqueue (same tenant+key) yields one record; duplicate/terminal settlement is replay-idempotent. |
| Crash/restart recovery | Work survives process death; `recover()`/`reclaimExpired` deterministically requeues or fails closed. |
| Retry → DLQ | Bounded attempts then DLQ; repeated failure is never converted to success; DENIED is never retried. |
| Tenant isolation | Enforced at the loop-host persistence boundary (`TenantIsolationError`), plus faithful storage of tenant id. |
| Schema/migration | Versioned resource guard fails closed on incompatible schema; does not silently destroy data. |
| Fail-closed on corruption | Missing/corrupt/incompatible checkpoint → quarantine to DLQ without dispatch (unchanged O-01). |

**Not claimed (unless later demonstrated):** infinite durability, zero-loss
under arbitrary infrastructure failure, multi-region disaster recovery, global
consensus, or unlimited horizontal scaling.

**Residual, documented limits:**

- The loop-host is single-process by orchestration design; "two workers" here
  means two concurrent dispatch/lease contenders over one authoritative store
  (the concurrency it actually needs). Horizontal/multi-host execution and full
  DR remain future milestones.
- `ICollection.query` predicates are evaluated after fetch (parity with the
  memory/fs drivers), so a large collection is not yet indexed for
  production-scale queue polling. Indexing is future work; correctness and
  concurrency are what P-01 establishes.
- Each queue/checkpoint *state transition* is a single atomic record write
  (compare-and-swap). The loop-host treats the work-item record as its commit
  pointer, so the companion checkpoint write + item update are individually
  atomic and consistency is preserved by commit-pointer semantics rather than a
  single cross-record transaction. Real multi-record transactions are provided
  by the driver (`beginTransaction`) and demonstrated at the storage layer for
  consumers that need them.
- P-01 does not implement mid-stage cognitive resume (out of scope; unchanged).

## Testing & database integration status

`npm test` (aggregates all 48 workspaces) passes with **0 failures / 0
skipped**. Integration suites that exercise a **real PostgreSQL** backend
(`embedded-postgres`, genuine PG 18 binaries) are included:

- `@jataqi/storage-postgres` — collection/CAS semantics, two-pool lease race
  (exactly one winner), real transaction commit/rollback/error-rollback, schema
  fail-closed, restart persistence, missing-config fail-closed.
- `@jataqi/loop-host` — lease race, stale-settle rejection, expiry/reclaim,
  renewal, duplicate-idempotency-key, tenant isolation, checkpoint ordering,
  crash/restart recovery, full host pipeline, retry→DLQ, and a full 34-stage
  governed loop dispatch over PostgreSQL.

If a real PostgreSQL cannot start in a given environment, those suites report
SKIP and the status below must read **DATABASE INTEGRATION NOT EXECUTED** for
that environment (never a fabricated pass).

**In the environment where P-01 was developed and validated, the real-PostgreSQL
integration suites executed and passed.**

## Governance preservation

Persistence stores state; it grants nothing. Every dispatch still re-enters the
whole 34-stage governed unified loop, so a stored row is never treated as
authorization. P-01 adds no reasoning, planning, policy generation,
authorization, capability grant, human/regulatory decision, or production side
effect, and changes no W22/W23/O-01 governance semantics (verified by the
unchanged W22/W23/O-01 suites).
