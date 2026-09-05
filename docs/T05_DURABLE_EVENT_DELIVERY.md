# T-05 — Canonical durable event delivery and transactional write composition

Baseline: `main` @ `61242141de6115e0b90bc0eb38ecf902e624e9d3` (T-04 merge).

This document records what T-05 changed, the exact delivery semantics that are
now enforced by durable PostgreSQL state, and — just as importantly — what is
**not** claimed.

## 1. Before / after

### Before (baseline)

```
producer ──publishEvent──► events (legacy collection)      autocommit #1
                       └─► UnifiedOutbox record            autocommit #2
                       └─► kernel bus (volatile, in-process)
                                │
                                ├─► billing            (onEnveloped)  ┐ effects lost if the
                                ├─► revenue-ledger     (onEnveloped)  │ process dies between
                                ├─► commercial-memory  (onEnveloped)  │ commit and handler,
                                └─► commercial-observability          ┘ or if a handler throws

CommercialEventStreamService.pump()  ──► reads the LEGACY events collection,
                                          no production caller, no lease, no fence
UnifiedOutbox.ack/markDeadLetter/quarantine ──► zero production callers
```

Two delivery designs coexisted (volatile bus vs. a pump over the legacy event
log), neither was the production path, and no production write composed its
state mutation with its event/outbox record in one transaction.

### After (T-05)

```
producer ──storage.atomically(scope)──┬─► domain state mutation        ┐ ONE IStorageTransaction
                                      ├─► events (legacy/replay view)   │ on PostgreSQL
                                      ├─► per-tenant sequence counters  │ (BEGIN … COMMIT);
                                      └─► UnifiedOutbox record          ┘ rollback leaves nothing
                          COMMIT ──► onCommit: in-process bus notification (wake-up + telemetry)
                                                     │
                     durable delivery worker (CommercialEventStreamService.pump)
                                                     │
        claim outbox record (PG CAS, lease owner/token/generation/expiry)
              │
              ├─► verify record on read (hash, envelope, tenant)  ──► QUARANTINED (fenced)
              ├─► per handler: inbox claim (deliveries collection, PG CAS, same fence)
              │        ├─► schema contract / version acceptance ──► SCHEMA_REJECTED (fenced)
              │        ├─► handler effect (its own atomic scope: state + event + outbox)
              │        ├─► fenced durable ack ─► DELIVERED
              │        └─► fenced retry (bounded backoff) ─► RETRYING … ─► DEAD_LETTER
              └─► fenced aggregate: DELIVERED | RETRYING | DEAD_LETTER | QUARANTINED | released
```

There is now exactly one production delivery architecture: the
`UnifiedOutbox` is the authoritative publication, the `deliveries` collection
is the durable subscriber inbox, and `CommercialEventStreamService.pump()` is
the only delivery worker. The legacy `events` collection is retained as the
replay/compatibility view written in the same transaction; it is never an
independent delivery source any more.

## 2. Transactional write composition

`@jataqi/storage` gains `StorageModule.atomically(fn)` and the
`StorageWriteScope` handed to `fn`:

- On a driver that implements `beginTransaction` (PostgreSQL) every
  `scope.collection(name)` handle is bound to one transaction client; `fn`
  success commits, any throw rolls back and rethrows. `scope.atomic === true`.
- On the memory/filesystem drivers (development only) the same code runs
  sequentially against the plain collections and `scope.atomic === false`.
  This is **not** atomic and is documented as such; `jataqi host` already
  refuses non-durable storage.
- `scope.onSettle(fn)` runs on commit **or** rollback (used to release the
  per-tenant publish mutex); `scope.onCommit(fn)` runs only after a successful
  commit, in registration order, after the connection has been released.

CAS inside a scope reuses the caller-owned client (T-04 contract): no nested
`BEGIN`, no premature `COMMIT`/`ROLLBACK`, no ownership transfer. The
T-04 regression suite is unchanged and still passes.

Composed production writes:

| Write | Composed in one scope |
|---|---|
| `CommercialControlPlaneService.publishEvent` | idempotency check, per-tenant event sequence, `events` row, unified-outbox sequence + record |
| `publishEvent(actor, input, { scope })` | the same, joined to a caller's scope (domain state + event + outbox) |
| `PaymentsService.verifyPayment` / `verifyRefund` | payment row + `payment.verified` / `payment.refund.verified` |
| `BillingService` verified-payment handler | invoice `PAID` + `billing.invoice.paid` + subscription `ACTIVE` + `billing.subscription.activated` |
| `BillingService` verified-refund handler | invoice `REFUNDED` + `billing.invoice.refunded` |
| `RevenueLedgerService` paid/refunded handlers | ledger entry + `revenue.recorded` / `revenue.reversed` |
| `CommercialMemoryService` raw-event capture | memory record + `commercial.memory.recorded` |
| `LoopHostService.dispatchLeased` | DISPATCHED checkpoint + work item `LEASED → DISPATCHED` |
| `LoopHostService` settlement | SETTLED checkpoint + `settleTerminal` / `parkSleeping` / `recordFailure` |

Not composed (documented follow-on, unchanged from baseline): the control
plane's action-lifecycle methods (`startAction`, `reportActionResult`, …)
still write state, ledger, and event as separate autocommits; the loop-host's
audit *bus* events remain in-process notifications (their durable evidence is
the checkpoint journal, which **is** composed).

## 3. Lease and fencing semantics

- A claim is a PostgreSQL row-lock CAS (`SELECT … FOR UPDATE`) that requires
  `state ∈ {PENDING, RETRYING, LEASED}`, `nextAttemptAt <= now` and
  (`no lease` or `leaseExpiry <= now`). It writes
  `leaseOwner`, a fresh random `leaseToken`, `leaseGeneration + 1`,
  `leaseExpiry = now + ttl`, `attemptCount + 1`, `state = LEASED`.
- Every finalising transition (`ack`, `scheduleRetry`, `markDeadLetter`,
  `quarantine`, `release`, and every inbox settle) is a CAS whose guard
  compares **both** `leaseToken` and `leaseGeneration` with the fence the
  worker received at claim time. The comparison happens inside the same
  row-locked statement as the write — it is not a check at the start of
  processing. A stale owner (its lease expired and another process
  re-claimed) gets `false` and writes nothing.
- Ownership is the fence, not the wall clock: an owner whose lease expired but
  was *not* re-claimed may still finalise (it is the only process that ran the
  effect). Expiry only makes a record eligible for re-claim.
- Administrative (unfenced) `ack`/`markDeadLetter`/`quarantine` remain
  possible **only** on records that have never been claimed
  (`leaseGeneration === 0`); once any worker has claimed, only fenced
  transitions are accepted.
- The inbox record carries the same fence as the outbox claim, so a handler
  effect can only be acknowledged by the worker that was issued the claim.

## 4. Inbox (subscriber idempotency) semantics

- Inbox identity: `${eventId}:${handlerId}` in `commercial-event-stream.deliveries`,
  stable across restarts, replays and processes; `tenantId` is copied from
  the outbox record (never from the caller).
- States: `PENDING` (legacy rows) → `CLAIMED` → `DELIVERED` |
  `RETRYING` → … → `DEAD_LETTER`; `SCHEMA_REJECTED` is terminal and never
  redelivered.
- Attempts are counted **at claim** (not at outcome), so a handler that
  crashes the process on every invocation is still bounded by `maxAttempts`
  and ends in `DEAD_LETTER` instead of an infinite crash loop.
- Backoff: `min(60s, 1s · 2^(attempt-1))`; `maxAttempts` 1..10 per handler
  (default 3).
- Schema: an explicitly registered contract for (type, eventVersion,
  schemaVersion) validates the event (F-01e policies unchanged). Without a
  contract the handler's declared `accepts` list (default
  `[{eventVersion:1, schemaVersion:1}]`) decides; anything else is
  `SCHEMA_REJECTED` fail-closed.

## 5. Failure semantics (what happens, and what is tested)

| # | Failure | Outcome |
|---|---|---|
| 1 | Crash after domain commit, before the bus wake-up | Record stays `PENDING`; the periodic worker (or the next wake-up) delivers it. |
| 2 | Crash while holding a claim (before/after the handler effect) | Lease expires; another process re-claims (generation+1, attempt+1); the effect may run twice — **at-least-once**, handlers are idempotent. |
| 3 | Stale owner finishes after re-claim | Its fenced ack/retry/DLQ returns `false`; the record's durable state is whatever the current owner wrote. Counted as `fenceRejected`. |
| 4 | Handler throws | Fenced `RETRYING` with bounded backoff; `DEAD_LETTER` when attempts reach `maxAttempts`. |
| 5 | Handler exceeds the lease TTL and is re-claimed meanwhile | Same as 3 (duplicate effect possible; documented, not hidden). |
| 6 | No contract / unsupported version / contract errors | `SCHEMA_REJECTED` inbox record; handler not invoked; outbox `QUARANTINED` when no other handler is still pending. |
| 7 | Record corrupted (hash/envelope/tenant mismatch on read) | `QUARANTINED`, handler never invoked. |
| 8 | Two processes race for one record | Exactly one claim wins (PG row lock). Proven with real child OS processes. |
| 9 | Rollback of the producing transaction | No event, no outbox record, no sequence advance, no domain row. |
| 10 | Duplicate publish (same tenant + idempotency key) | One event, one outbox record (unchanged F-01 behaviour). |
| 11 | Worker for tenant A | Never claims, sees, or acks tenant B records; cross-tenant delivery requires an explicit `allTenants` request by a `system`/`global_admin` actor. |
| 12 | Graceful stop mid-batch | The in-flight record finishes; unclaimed records stay `PENDING`; anything still leased is re-claimed after expiry (no fabricated outcome). |

No exactly-once claim is made anywhere. The only "exactly once" statements in
tests are the *no-failure* properties proven by the tests themselves (e.g.
N events across M competing processes produce exactly N effects when no
process crashes).

## 6. Producer / subscriber cutover (Section I)

All commercial domain producers already publish through
`CommercialControlPlaneService.publishEvent`, so every one of their events is
durable in the outbox. What changed is *who consumes them and how*:

| Subscriber | Before | After |
|---|---|---|
| `@jataqi/billing` (`payment.verified`, `payment.refund.verified`) | volatile `bus.onEnveloped` | durable handler `billing.verified-payments` |
| `@jataqi/revenue-ledger` (`billing.invoice.paid`, `.refunded`) | volatile | durable handler `revenue-ledger.invoice-settlement` |
| `@jataqi/commercial-memory` (19 nominated topics) | volatile | durable handler `commercial-memory.raw-event-capture` |
| `@jataqi/commercial-observability` (`commercial.event.recorded`) | volatile | **retained in-process** — a privacy-minimised telemetry projection that is fully rebuildable from the durable outbox; it never owns business state |
| `@jataqi/knowledge-graph` (`knowledge.document.ingested`) | volatile | retained in-process (core/knowledge plane, not a commercial event; out of scope) |
| `@jataqi/commercial-event-stream` (`commercial.event.recorded`) | — | new in-process **wake-up** subscriber: after a commit it pumps the publishing tenant when a durable handler exists for the event type. Authority never comes from the bus payload; the worker re-reads the durable record. |

Bus emission by the control plane is retained (dual topic, unchanged payload)
as the in-process notification plane; no production subscriber depends on it
for durable-domain effects any more.

`bus.emit` inventory (106 baseline producer sites in `packages/*/src`, none
removed; T-05 adds exactly one — the delivery worker's
`commercial.event.delivery.*` telemetry emission in
`commercial-event-stream-service.ts` — which is itself an internal
notification signal, never a delivery path):

- **Production durable-domain**: none emit directly on the bus — durable domain
  events go through `publishEvent` (durable by construction).
- **Internal notification / audit signals (retained)**: kernel lifecycle (1),
  storage (4), capability-fabric (1), unified-loop stage/audit (5),
  loop-host host/runtime audit (3), knowledge service/graph/vector (12),
  commercial-observability telemetry (1), delivery-worker telemetry (1, new),
  control-plane dual emission (2),
  and the cognition/governance engines (orbital-intelligence 17,
  permanence-fabric 10, multi-agent-cognition 8, meta-reasoning 7,
  human-approval 7, cognitive-kernel 6, world-model 4, regulatory-gates 4,
  temporal-engine 3, research-evidence 3, hypothesis-engine 3,
  causal-engine 3, reproducibility 2). These are publish-only evidence
  signals (EVENT_SURFACE_CONTRACT §C); their durable evidence lives in their
  own collections and no in-repo consumer acts on them.
- **Compatibility**: the control plane's legacy-topic + `commercial.event.recorded`
  dual emission.
- **Test-only / obsolete**: none in production source. The loop-host
  `OutboxInbox` (T-01-H) remains a test substrate for the T-01 atomicity
  evidence; it has no production caller and is not a delivery path.
- **Still requiring durable migration**: none identified. Every consumer that
  owns business state (billing, revenue-ledger, commercial-memory) is on the
  durable path; the two remaining bus consumers (observability telemetry,
  knowledge-graph derived index) are rebuildable projections by design.

Verification of "one authoritative delivery source" (post-cutover grep of
`packages/*/src`): the only bus consumers are the delivery worker's wake-up,
commercial-observability and knowledge-graph; `UnifiedOutbox.claim/ackLeased/
scheduleRetry/deadLetterLeased/quarantineLeased/release` are called only by
`CommercialEventStreamService`; no module reads the legacy `events`
collection to drive an effect.

## 7. Tenant and authority provenance

- Outbox `tenantId` = envelope `tenantId` = the publishing actor's tenant
  (`publishEvent` derives it server-side from `actor.tenantId`).
- On read the worker re-checks `record.tenantId === record.envelope.tenantId`
  and the record hash; mismatch → `QUARANTINED`.
- Inbox `tenantId` is copied from the record; handlers receive the event and
  derive their own system actor from `event.tenantId` (existing pattern).
- Delivery telemetry events are published under a server-derived system actor
  for the record's tenant, never the worker operator's tenant.
- Cross-tenant delivery is opt-in (`pump(actor, { allTenants: true })`) and
  requires the `system` or `global_admin` role; a plain operator pumps only
  its own tenant.
- T-01/T-02/T-03 boundaries are untouched: the loop-host still requires a
  verified principal snapshot at enqueue and dispatch, and the delivery
  worker never grants authority.

## 8. Approval / resume and restart

Held work (`HELD`, authority holds, human-approval requests) and delivery
state live only in durable collections; nothing about resume depends on an
in-memory subscription. A restarted process re-registers its code handlers,
runs `pump()` and continues from `PENDING` / `RETRYING` / expired `LEASED`
records exactly where the durable state says it stopped.

## 9. Observability

Every step writes structured durable fields on the outbox record
(`state`, `attemptCount`, `leaseOwner`, `leaseGeneration`, `leaseExpiry`,
`claimedAt`, `nextAttemptAt`, `deliveredAt`, `lastError`) and on the inbox
record (`state`, `attemptCount`, `maxAttempts`, `leaseOwner`,
`leaseGeneration`, `claimedAt`, `lastAttemptAt`, `nextAttemptAt`,
`deliveredAt`, `lastError`), plus privacy-minimised bus telemetry
(`commercial.event.delivery.*`: claimed, delivered, retrying, dead_lettered,
schema_rejected, quarantined, released, fence_rejected). Read-only surfaces:
`replayUnifiedOutbox`, `listDeliveries`, `listDeadLetters`, `getDelivery`,
the command center's `eventDelivery`, and the CLI: `jataqi host:health`
(adds a `delivery` block: adopted handler ids, outbox counts by state, inbox
dead letters), `jataqi host:outbox [state]` and `jataqi host:inbox [state]`
(tenant-scoped, read-only — nothing is claimed, acked, retried or released).

The supervised `jataqi host` process is the production delivery worker: after
every dispatch cycle `HostRuntime` runs one bounded `pump()` pass under a
server-derived system actor over all tenants (`deliveryPump`), and reports the
pass on the cycle record. Handler effects that publish further events enqueue
their tenant for the in-process post-commit drain, so a chain such as
`payment.verified → billing → revenue-ledger` settles within the publishing
call on a single node and within the next cycles across nodes.

## 9a. External effects vs database atomicity (payments)

`payments.verifyPayment` / `verifyRefund` call the provider (an external,
non-transactional effect) through the action runtime, which records the
verdict durably on the action (`VERIFYING → COMPLETED/FAILED`) in its own
write **before** the composed payment write. If the composed write fails or
the process crashes between the two, the retry resumes from the durable
action verdict instead of asking the provider again (an action can never be
verified twice). No exactly-once external effect is claimed; the boundary is
the durable action state plus idempotent provider adapters.

## 9b. Test evidence delivered with T-05

| Suite | Backend | What it proves |
|---|---|---|
| `storage-postgres/test/t05-atomically-ownership.test.ts` | real PG, instrumented pool | one `BEGIN`/`COMMIT` (or `ROLLBACK`) per scope regardless of CAS count; a throwing or losing CAS never issues transaction control; hooks fire after the durable outcome; pre-commit invisibility (T-04 preserved) |
| `commercial-event-stream/test/t05-durable-delivery-pg.test.ts` | real PG + **3 real child OS processes** | rollback of event+outbox+sequence; post-commit bus; exactly-once handler invocation across two workers; stale-owner fence on ack/retry/DLQ/quarantine/release + forged token + admin ack; mid-delivery re-claim fenced on inbox and outbox; bounded backoff → DEAD_LETTER; poison → QUARANTINED; restart keeps inbox identity; tenant/principal provenance; two processes racing (one winner per event); hard crash while LEASED → expiry reclaim once → zombie fenced; crash after effect before ack → at-least-once redelivery, idempotent effect, single finalisation |
| `loop-host/test/t05-composed-writes-pg.test.ts` | real PG | dispatch checkpoint + transition commit/rollback together; settlement (terminal, bounded retry) composition; stale token inside the scope rolls the checkpoint back; two hosts racing one composed dispatch |
| `revenue-ledger/test/t05-payment-chain-pg.test.ts` | real PG | production chain settles through the outbox with causation + tenant preserved; producer failure after outbox write rolls back payment+event+outbox; subscriber failure inside billing rolls back invoice+event; retry after backoff completes the chain once |
| `loop-host/test/runtime.test.ts`, `cli/test/host-command.test.ts` | memory | host runtime runs the pump every cycle, survives pump failure; the CLI composition wires the pump and adopts the three durable subscribers |
| `billing/test/billing.test.ts` | memory | durable inbox row per verified payment; redelivery idempotent; foreign-tenant `payment.verified` never mutates the tenant's invoice |

## 10. Known limitations (honest scope statement)

- PostgreSQL `query()` in `@jataqi/storage-postgres` is `SELECT body FROM t`
  plus a JavaScript filter. Claim scans are **bounded in results** (`limit`)
  but not in rows read. Pushing predicates/`ORDER BY`/`LIMIT` into SQL and
  adding indexes on `(state, next_attempt_at, tenant_id)` is a follow-on; it
  was not redesigned here.
- The first-use counter creation race between two *processes* documented on
  `UnifiedOutbox.nextSequence` is unchanged.
- Duplicate-publish detection with the same idempotency key is serialised
  in-process (tenant mutex) and by the PostgreSQL counter row lock only
  after the check; two processes publishing the same key at the same instant
  can still produce two events (baseline residual).
- No `LISTEN/NOTIFY`; wake-up is in-process only, cross-process latency is
  the host's idle bound.
- No lease renewal: a handler must finish within the lease TTL or accept
  possible duplicate delivery (the fence guarantees the stale attempt cannot
  finalise; the effect itself must be idempotent — it is, for all three
  durable subscribers).
- Concurrent first-boot DDL: two processes creating the same new table race
  `CREATE TABLE IF NOT EXISTS`; the driver now retries once on the catalog
  unique-violation / duplicate-table codes and otherwise surfaces the
  original error. Existing tables are unaffected.
- On non-transactional development drivers (`memory`, `filesystem`)
  `atomically` runs sequentially and non-atomically with
  `scope.atomic === false`; the production host refuses those drivers
  (`jataqi host` fails closed).
- No live external effects were activated: no provider, connector, network
  ingress, or webhook is touched by T-05.
