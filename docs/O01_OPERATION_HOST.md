# O-01 — Durable Continuous-Operation Host

**Status:** implemented in-repo (`@jataqi/loop-host`), validated, awaiting review merge.
**Milestone type:** operation milestone — **no new cognitive stage, no new intelligence
engine, no provider, no external capability added.**
**Baseline:** canonical `main` `88808108128981712ea2fd504e4d547acad6e236` (post-W23).
**W22/W23 effect:** none — stage order, governance semantics, capability adapters,
registry enforcement, and all W22/W23 tests are unchanged.

## What O-01 establishes

Before O-01, a loop run was a pure function of an external call:
`external trigger → runLoop() → 34-stage cognition → result`.
`SLEEP_PENDING` was a string, not a process; a crash lost the in-flight run;
nothing could wake the system. O-01 adds the missing operation-over-time layer:

```text
WAKE → QUEUE → LEASE → RUN → CHECKPOINT → VERIFY → COMPLETE/HELD/FAIL → SLEEP → RESUME
```

The host is a **driver/valet, not a second brain**. The W22/W23 unified loop
remains the sole authoritative cognitive orchestrator. Every dispatch re-enters
the **whole** 34-stage loop (governance included), so resume can never skip a
gate or inherit a stale approval. Outcomes are **recorded** from loop results,
never granted: COMPLETED here means "the loop reported completion" —
verification was the loop's, never the host's.

## What the host owns (and only this)

Scheduling and wake eligibility, tenant-scoped pending work, exclusive leases
with deterministic expiry/reclamation, versioned integrity-checked checkpoint
journaling, bounded retry accounting with backoff, DLQ transitions, host
lifecycle (`IDLE → RUNNING → DRAINING → STOPPED`), restart/recovery
coordination, dispatch to the existing unified loop, and host-lifecycle
observability on new `loop-host.*` bus topics (no existing topic touched).

The host MUST NOT and does not: reason, plan, create policy, authorize,
grant capabilities, cast human votes, evaluate regulatory gates, execute
production side effects, mark anything verified, self-approve, or remediate.
Its module depends only on `storage` and `unified-loop`; the dependency
`unified-loop → loop-host` is forbidden and tested absent.

## Durability honesty (read carefully)

Checkpoints and queue records persist through the **available** storage
abstraction (memory or development-only single-process filesystem). That yields
crash **detection** plus deterministic resume-or-fail-closed semantics — NOT
production-grade transactional, multi-process, or zero-loss durability:

- no Postgres, no transactions spanning records;
- no distributed leases or fencing;
- no zero-loss guarantee (a crash between the last checkpoint write and the
  process death loses at most the un-checkpointed tail, and recovery reports
  that honestly via reclaim + full redispatch);
- a missing, corrupt, incompatible, or ambiguous checkpoint **fails closed**
  (record quarantined to DLQ, never dispatched).

Production-grade durability remains future **P-01** scope. The checkpoint
schema is versioned (`LOOP_HOST_CHECKPOINT_SCHEMA_VERSION = 1`) and the
record shapes are backend-agnostic so P-01 is non-breaking.

## Operation

```ts
import { createJataQi } from '@jataqi/cli'; // composition root
const jataqi = await createJataQi({ loopHost: { enabled: true } }); // opt-in; default OFF
const host = jataqi.kernel.getModule('loop-host').getService();
host.start(); // explicit; IDLE → RUNNING
// T-02: enqueue is authenticated — the actor must derive from a T-01
// AuthenticatedPrincipal, whose snapshot is embedded on the record.
await host.enqueue(actor, { task }, principal); // tenant-scoped, idempotent
await host.tick(); // one explicit scheduler pass (leased dispatch)
await host.recover(); // explicit crash-recovery pass (reclaim expired, quarantine corrupt)
await host.resume(actor, heldId); // explicit operator resume of HELD/SLEEPING
await host.stop(); // DRAINING → STOPPED; in-flight leases left for expiry reclaim
```

`tick()`/`recover()` are explicit (the same philosophy as the event stream's
manual pump). Background auto-tick exists only when `autoTickMs > 0` is
configured AND the host was explicitly started. Boot never starts the host.

## Failure taxonomy

| Class | Behavior |
|---|---|
| Transient / timeout | Requeue with bounded exponential backoff while attempts remain |
| Loop `FAILED_CLOSED` | Same as transient (the loop already failed closed; the host retries the whole run) |
| `HELD_AT_GATE` | Terminal HELD; resumes only via explicit operator `resume()` (full re-evaluation) |
| `DENIED` (policy/kill-switch) | Terminal; never retried — retry must not manufacture authorization |
| Permanent (malformed input) | Straight to DLQ |
| Corrupt/incompatible checkpoint | Quarantine to DLQ without dispatch |
| Attempts exhausted | DLQ with recorded reason; repeated failure is never converted to success |

Stale lease holders cannot commit (token mismatch throws `StaleLeaseError`
with zero state change). Idempotent replays (same idempotency key, same
terminal loop run) return the existing record.

## T-02 — Authenticated durable authority carry-through

Durable work must never execute on a caller-self-asserted actor. Since
T-02, `enqueue` requires a T-01 `AuthenticatedPrincipal` alongside the
actor (same id/tenant, narrowed-or-equal roles); the host embeds an
immutable principal snapshot (`version`, `principalId`, `tenantId`,
`roles`, `authenticationMethod`, `verifiedAt`, `authenticationEventId`;
never tokens/secrets) on the record. Every dispatch re-verifies the
persisted snapshot — presence, shape, version, freshness against the
host max-age policy (default 24h, cap 30d), test-method admission,
snapshot/item/actor tenant match, identity match, and role
non-expansion via T-01's own `projectToActor` — and executes with the
verified narrowed actor plus the reconstructed principal, which the
default runner forwards into the loop's own T-01 match check.

Authority failures HOLD the item with a deterministic `PRINCIPAL_*`
reason (`PRINCIPAL_ABSENT` for pre-T-02 rows, `PRINCIPAL_STALE`,
`PRINCIPAL_SKEW`, `PRINCIPAL_MALFORMED`, `PRINCIPAL_VERSION`,
`PRINCIPAL_MISMATCH`, `PRINCIPAL_ROLE_ESCALATION`,
`PRINCIPAL_TEST_METHOD`): no checkpoint, no attempt consumed, no
dispatch, never auto-retried, and operator `resume` refuses them — the
recovery path is a fresh authenticated enqueue. Loop-reported gate
holds (no `heldReason`) still resume through the normal operator path.
Lifecycle audit events carry principal provenance (`principalMethod`,
`principalEventId`, `principalVerifiedAt`, `principalId`); Held events
from the authority gate also carry the machine-readable `heldReason`.

## Validation

New `@jataqi/loop-host` suite covers acceptance O1–O27 (queue/lease unit
mechanics plus full-lifecycle dispatch against the real governed loop,
including gate HELD-twice re-evaluation, kill-switch DENIED, crash-resume
with correlation preservation, corrupt-checkpoint quarantine, bounded
retry→DLQ, multi-tenant isolation, governance-negative spies, single-loop
proof, safe shutdown, and content-free observability). W22/W23 suites run
unchanged as regression.

## Gaps carried forward (do not over-claim)

> **Correction (T-03):** this section originally listed P-01 and F-01 as
> "still open". Both have since merged — P-01 via PR #8 (`1701f65`) and F-01
> via PR #11 (`54d3f14`) — so those two bullets were stale and are corrected
> below. The remaining statements are still accurate.

- **P-01 (production durability):** MERGED (PR #8). PostgreSQL, transactions,
  and row-lock leases are delivered. Still genuinely open within it: backups,
  PITR, replication, failover — RPO/RTO remain UNDEFINED.
- **F-01 (event fabric):** MERGED (PR #11). The two-plane split is unified
  behind `EventEnvelope`. The host still emits its own `loop-host.*` topics
  and reuses the manual pump.
- **T-01/T-02/T-03 (authority):** the principal boundary, the durable
  principal snapshot, and the authenticated work ingress are all merged. See
  [`T03_AUTHENTICATED_WORK_INGRESS.md`](./T03_AUTHENTICATED_WORK_INGRESS.md).
- **No live connectors, providers, credentials, or production side effects** are introduced or claimed.
- **No quantum execution, no AGI/superintelligence, no production deployment** is claimed or introduced.

