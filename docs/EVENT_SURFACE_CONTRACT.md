# JATA Qi Event Surface Contract

**Status:** documentation of the existing contract (unification conditions C-3
and C-4 of `JATA_QI_RECOVERY_MANIFEST.md`). Verified against baseline commit
`6cbac10e9b64a925d569fcac813c3aaa725f4995` on 2026-09-04. Unification verdict
remains **CONDITIONALLY_UNIFIED**; this document does not change it.

This document records and clarifies the existing event-surface contract. It
does not perform code-level schema unification. Audit finding **F-01**
(two-plane event schema split) therefore **remains open**; see
`JATA_QI_UNIFICATION_AUDIT_SUMMARY.md`.

JATA Qi publishes events on a single shared kernel event bus
(`packages/core-kernel/src/event-bus.ts`), but the payloads on that bus fall
into two planes with different shapes.

## A. Two-plane event model

### Commercial plane — self-describing envelopes

Commercial-plane events are full `CommercialEvent` envelope records defined in
`packages/commercial-control-plane/src/types.ts` (`interface CommercialEvent`,
lines 836–853):

```text
id, sequence, eventType, eventVersion, tenantId, source, actor?, entityId?,
timestamp, correlationId, causationId?, payload, schemaVersion, provenance,
privacyClassification, idempotencyKey?
```

The Commercial Control Plane emits every recorded commercial event onto the
kernel bus twice — once under the event's own type and once under the
canonical audit topic (`packages/commercial-control-plane/src/
commercial-control-plane-service.ts`, lines 1212–1213):

```ts
await this.api.bus.emit(event.eventType, copy(event));
await this.api.bus.emit(CommercialControlPlaneEvents.EventRecorded, copy(event));
```

where `EventRecorded = 'commercial.event.recorded'`
(`packages/commercial-control-plane/src/types.ts`, line 890). The bus payload
**is** the envelope: it carries `eventType`, `tenantId`, `correlationId`,
`provenance`, and `schemaVersion` inside itself, so a receiver holding only
the payload can classify it.

Commercial subscribers therefore treat the bus payload as a `CommercialEvent`
(e.g. `packages/billing/src/billing-service.ts`, lines 56–57;
`packages/revenue-ledger/src/revenue-ledger-service.ts`, lines 46–47;
`packages/commercial-memory/src/commercial-memory-service.ts`, line 58).
Separately, `@jataqi/commercial-event-stream` provides an explicit durable
delivery path over the control-plane outbox with registered
`CommercialEventContract` / `CommercialEventHandler` objects, schema
validation, bounded retry, replay, and dead-letter records
(`packages/commercial-event-stream/src/types.ts` and
`commercial-event-stream-service.ts`); that path does not rely on bus
wildcards.

### Core/knowledge plane — plain payloads

Core, knowledge, storage, vector, and other engine-plane events are emitted as
plain domain payloads under a named topic; the payload carries no `eventType`
or envelope fields. Examples verified at the cited lines:

- `packages/knowledge-service/src/knowledge-module.ts:104` —
  `KnowledgeEvents.DocumentIngested` with payload `{ docId, chunks }`
  (`KnowledgeEvents` in `packages/knowledge-service/src/types.ts:75–80`);
- `packages/storage/src/storage-module.ts:63,83,94,105` —
  `StorageEvents.DriverRegistered` / `NamespaceCreated` / `CollectionCreated` /
  `BlobStoreCreated` with plain payloads such as `{ driverId }`, `{ name }`;
- `packages/vector-search/src/vector-module.ts:82,98,105` —
  `VectorEvents.IndexCreated` / `VectorAdded` / `Searched` with plain payloads.

Kernel lifecycle topics are the frozen `KernelEvents` set in
`packages/core-kernel/src/types.ts` (12 names, `kernel.module.*` /
`kernel.boot*` / `kernel.shutdown*`).

## B. Consumer behavior and wildcard guidance

The bus API (`packages/core-kernel/src/event-bus.ts`) offers named
subscriptions (`on`, `once`, `off`) and a wildcard subscription `onAny`.
`emit(event, payload)` passes **only the payload** to handlers — the topic
name is not delivered to the handler. Handler errors are contained per-handler
and written to stderr; one throwing handler does not prevent siblings.

Consequence (the F-01 observation, stated as guidance):

- A wildcard (`onAny`) consumer receiving a **commercial-plane** payload can
  classify it from the payload itself (`eventType`, `source`, `tenantId`,
  `correlationId` are inside the envelope).
- A wildcard consumer receiving a **core/knowledge-plane** payload cannot
  infer which topic fired, because plain payloads carry no `eventType`. Such
  consumers must subscribe to named topics instead.

**No wildcard consumer exists in the repository at baseline** (no `onAny` call
outside `event-bus.ts` itself), so no existing consumer is affected; the
guidance above constrains future consumers.

### Nominated in-repo consumers (demonstrable at baseline)

| Consumer package | Topic(s) subscribed | Source |
|---|---|---|
| `@jataqi/knowledge-graph` | `knowledge.document.ingested` | `packages/knowledge-graph/src/graph-module.ts:73` |
| `@jataqi/billing` | `payment.verified`, `payment.refund.verified` | `packages/billing/src/billing-service.ts:56–57` |
| `@jataqi/revenue-ledger` | `billing.invoice.paid`, `billing.invoice.refunded` | `packages/revenue-ledger/src/revenue-ledger-service.ts:46–47` |
| `@jataqi/commercial-memory` | 19 nominated commercial topics (`observedCommercialEvents()`) | `packages/commercial-memory/src/commercial-memory-service.ts:58,233–241` |
| `@jataqi/commercial-observability` | `commercial.event.recorded` | `packages/commercial-observability/src/commercial-observability-service.ts:103` |
| `@jataqi/core-kernel` (internal) | one-shot lifecycle waits (`bus.once`) | `packages/core-kernel/src/kernel.ts:195` |

Every other declared event has no in-repo subscriber; that is intentional
(Section C).

## C. Publish-only event intent

Verified counts at baseline (reproducible by grep over `packages/*/src`):

- **189** event-name constants declared across **36** packages (frozen
  `*Events` objects).
- **8** subscription sites in non-test source: the 7 domain consumer rows
  above plus one kernel-internal lifecycle utility.

The overwhelming majority of declared events (the unification audit records
183/189) are therefore **publish-only by design**: they are durable
audit/evidence/provenance signals, not feedback-loop inputs. Feedback loops
exist only where a consumer is explicitly nominated (Section B). Per
condition C-4, this intent is confirmed as deliberate: an event gains an
in-repo consumer only through an explicit, reviewed nomination — new wildcard
or catch-all consumers should not be added while the two-plane split (F-01)
is open.

## D. Explicit limitation (pre-F-01 baseline note; see Section E)

This document records and clarifies the existing event-surface contract. At
the time of writing it did not perform code-level schema unification.

- Unification conditions C-3 (document the two-plane schema) and C-4 (confirm
  publish-only intent and nominate consumers) are addressed here at the
  documentation level; conditions C-1 (in-repo loop orchestration) and C-2
  (AMBER engines exercised in unified-loop context) remain open per
  `JATA_QI_RECOVERY_MANIFEST.md`.
- Documenting a contract is not implementing a unified schema, and passing
  documentation review is not production verification.

## E. F-01 unification (implemented)

F-01 closes the two-plane split described above with a backward-compatible
unified envelope; no topic was renamed and no subscription was deleted:

- **Envelope + bus** (`packages/core-kernel/src/event-envelope.ts`,
  `packages/core-kernel/src/event-bus.ts`): `EventEnvelope` v1 with canonical
  JSON/sha256 helpers, chain sealing/verification, and dual verification for
  historical chains. `emitEnveloped` / `onEnveloped` / `onAnyEnveloped` carry
  `(topic, envelope)`; legacy `emit` bridges a best-effort envelope to
  enveloped listeners, and `emitEnveloped` delivers a preserved legacy payload
  to legacy listeners — one emission, no duplicates.
- **Producers migrated (F-01b)**: core-kernel lifecycle, commercial-control-plane
  (dual delivery under the event type and `commercial.event.recorded`),
  capability-fabric registry events, commercial-observability telemetry,
  unified-loop audit events (stage entry now emitted under the previously
  declared-but-silent `UnifiedLoopEvents.StageEntered`), loop-host audit
  events. All other milestone emitters are unchanged and served by the bridge
  (explicit F-01b scope boundary).
- **Subscribers cut over (F-01f)** to `onEnveloped` on the same nominated
  topics: billing, revenue-ledger, commercial-memory, commercial-observability
  capture (full `CommercialEvent` view via `commercialEventFromEnvelope` from
  `@jataqi/commercial-control-plane`), knowledge-graph document ingest (plain
  payload via `payloadOf` from `@jataqi/core-kernel`).
- **Nomination is machine-readable (F-01e/C-4)**: `F01_NOMINATED_SUBSCRIPTIONS`,
  `isNominatedSubscription`, and `auditSubscriptionCoverage` in
  `@jataqi/core-kernel`, enforced by
  `packages/core-kernel/test/f01-subscription-governance.test.ts`. Still no
  `onAny` consumer in non-test source.
- **Sequencing + durability (F-01c/d)**: per-tenant CAS event sequencing and a
  hash-chained unified durable outbox with tenant-scoped replay, tenant-guarded
  ack/dead-letter/quarantine, and integrity verification
  (`packages/commercial-control-plane/src/unified-outbox.ts`,
  `commercial-control-plane-service.ts`). Delivery is at-least-once with
  idempotent processing — exactly-once is not claimed.
- **Schema registry + governance (F-01e)**: versioned contracts with a default
  `exact` policy (unknown/incompatible schemas are SCHEMA_REJECTED
  fail-closed) and an explicit admin-registered `fallback-previous-schema`
  opt-in (`packages/commercial-event-stream/src/`).
