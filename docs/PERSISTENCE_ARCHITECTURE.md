# Persistence Architecture and P0 Filesystem Containment

**Status:** P0 containment implemented for local development filesystem mode on
2026-09-03. The authoritative transactional persistence architecture described
below is a **design**, not an implemented production service.

## Scope and non-claims

JATA Qi currently ships two storage modes:

- `memory` — the default ephemeral development/test mode.
- `filesystem` — a local development mode for demos and deterministic tests.

`filesystem` is explicitly **single-process, non-production, non-transactional,
non-multi-host storage**. It must not be used as the authoritative store for
customer data, tenant data, payments, approvals, audit evidence, external
execution, or any production deployment.

The P0 remediation improves local correctness by serializing in-process writes,
using collision-resistant temporary files, recovering stale temporary files,
rejecting a second process for the same root, and restoring known development
knowledge/vector snapshots after an orderly restart. These improvements do not
turn files into a database, a distributed lock service, an audit ledger, or a
production control plane.

No real payment, external execution, GitHub, deployment, distribution, cloud,
or production credential integration is introduced by this document or the P0
implementation.

---

## Current filesystem development contract

The filesystem driver provides these bounded guarantees only while used as
intended:

1. One process may own one filesystem root at a time. A second process is
   rejected rather than being allowed to silently overwrite data.
2. Operations on one local collection/namespace/blob store are serialized in
   that process.
3. Collection replacement writes one complete JSONL snapshot through a unique
   temporary file followed by atomic rename. File data is synced before rename;
   parent-directory sync is attempted where supported by the host filesystem.
4. On acquisition of an otherwise unowned root, contents left in the driver's
   reserved temporary staging directories are removed. A stale process-lock file
   is quarantined and recovered only after its recorded process is no longer
   alive.
5. The knowledge service snapshots its known vector index after a knowledge
   mutation and restores that known index on the next orderly filesystem boot.
6. The graph writes a coherent entity/triple snapshot during orderly shutdown,
   instead of issuing unawaited per-record full-file rewrites.

The following are **not** guaranteed:

- survival of an abrupt process or host failure at an arbitrary point across
  multiple resources;
- a transaction spanning documents, chunks, vectors, graph records, commercial
  records, or files and metadata;
- safe concurrent readers/writers in different processes, containers, hosts,
  or network filesystems;
- replication, backups, point-in-time recovery, encryption/key custody,
  tenant isolation, high availability, or durable audit anchoring;
- safe operation on externally modified filesystem roots.

The local root lock is deliberate fail-safe containment, not a distributed
coordination mechanism.

---

# Proposed authoritative production persistence architecture

## 1. Reference baseline: PostgreSQL plus durable vector storage

Use PostgreSQL as the authoritative transactional system of record. Start with
`pgvector` in the same PostgreSQL cluster when query volume, corpus size,
latency, and recall evaluation support that choice. A dedicated vector service
may be introduced later only behind the same durable write/replay contract.

The key rule is that an application-visible fact is committed only when its
record, tenant scope, version, audit metadata, and outbox event are committed
atomically in the authoritative database.

Suggested logical schemas:

| Schema/domain | Authoritative records |
|---|---|
| `identity` | tenants, principals, service identities, memberships, roles, policy bindings |
| `knowledge` | documents, chunks, chunk revisions, embeddings/vector rows, ingestion jobs, retrieval index versions |
| `graph` | entities, triples, source references, graph revisions/index jobs |
| `control` | policies, decisions, approvals, consent, budgets, actions, verification states, immutable audit-event references |
| `commerce` | payment/provider events, invoices, subscriptions, revenue/cost/reversal journals, reconciliation runs |
| `events` | transactional outbox, consumer inbox/idempotency records, leases, delivery attempts, dead letters, replay checkpoints |
| `operations` | migrations, backup/restore drill records, retention jobs, configuration versions, readiness state |

Use UUID/ULID primary keys, immutable event IDs, explicit schema versions,
`tenant_id` on every tenant-owned table, `created_at`/`updated_at`, and
optimistic versioning where records are concurrently editable.

## 2. Durable vector/index strategy

A vector index is not the only source of truth. The authoritative text/chunk
record and embedding version must be durable independently of any index.

Recommended flow:

1. In one database transaction, store the document revision, chunks, embedding
   model/version metadata, vector rows (or an index-pending marker), and an
   `knowledge.ingested` outbox record.
2. If vectors live in PostgreSQL/pgvector, store them in the same transaction
   when feasible. Otherwise, persist an index-pending state plus a durable
   outbox job with a deterministic vector record ID.
3. A leased index worker writes/updates the external vector store idempotently.
4. It records success against the source revision. Retrieval exposes only
   index versions known to be complete, or has an explicit degraded fallback.
5. A replay/rebuild job can recreate every vector/index from durable chunks and
   embedding version metadata.

Graph vector indexing follows the same rule: entities/triples remain
transactional source records; a vector index is rebuildable derived state.

## 3. Transactional write boundaries

Do not use in-process event handlers as the only mechanism for durable state
transitions.

### Knowledge ingestion

One transaction should include:

- document revision;
- all chunk rows and chunk-to-document links;
- ingest/idempotency key result;
- vector/index state or vector rows;
- audit metadata; and
- an outbox event.

### Graph changes

One transaction should include:

- entity/triple mutation or graph revision;
- source/document linkage;
- authorization/tenant validation result where applicable; and
- graph/index outbox work.

### Controlled actions and commerce

For a change such as payment verification, invoice payment, subscription
activation, revenue recognition, or rollback recording, use either one database
transaction or a clearly modelled saga with durable state transitions. The
transaction must atomically record:

- the authoritative state transition;
- an immutable audit event/reference;
- the idempotency key/result; and
- the outbox event for downstream work.

No caller should receive a final success result merely because an in-memory
subscriber was invoked.

## 4. Tenant isolation and identity prerequisites

Production persistence requires Phase 2 identity work before tenant data is
accepted through a service boundary. The storage design must nevertheless be
ready for it:

- derive tenant context from authenticated server-side identity, never from an
  untrusted caller object;
- require `tenant_id` in every tenant-owned primary/unique/index key;
- enforce PostgreSQL row-level security using a transaction-scoped tenant
  setting or service role model;
- prevent cross-tenant foreign keys and joins by construction;
- partition/audit privileged global-administrator access separately;
- encrypt data in transit and at rest through managed infrastructure/KMS; and
- define retention, deletion, export, and legal-hold workflows before customer
  data is stored.

This document does not implement identity, authentication, authorization, or
secret management.

## 5. Migrations and schema evolution

Use a single migration tool and a forward-only, reviewed migration history.
Every migration must have:

- migration ID, owner, rationale, and target application version;
- lock/timeout behavior appropriate for production;
- an expand/contract strategy for incompatible changes;
- data-backfill/reindex plan and idempotency behavior;
- validation queries and rollback/roll-forward procedure; and
- staging plus restore-drill evidence before production execution.

Vector dimensions, embedding model IDs, event schemas, and canonical ledger
serialization must be versioned rather than inferred from current code.

## 6. Transactional outbox, inbox, idempotency, and workers

### Outbox

Application transactions write an outbox row with a stable event ID, aggregate
version, tenant ID, schema version, causation/correlation IDs, payload
reference, and delivery state. A worker publishes the row only after commit.

### Inbox/idempotency

Every consumer stores the producer event ID and its completed result in an
inbox/idempotency table inside the consumer's transaction. Duplicate delivery
therefore becomes a no-op or returns the original result.

External provider calls require a separately stored provider idempotency key.
A timeout is an **unknown external outcome**, not permission to blindly retry.
Workers must reconcile provider state before retrying an uncertain effect.

### Leases, retries, and DLQ

Workers claim jobs using durable leases with owner ID, expiry, fencing/version
number, attempt count, and heartbeat. Retry schedules use bounded exponential
backoff and a documented retryability classification. Exhausted or malformed
jobs move to a durable DLQ with enough immutable context to investigate and
replay safely.

No in-memory `Map`, process-local promise, or core event-bus handler may be the
sole owner of delivery state.

## 7. Replay and recovery

Recovery procedures must be tested, automated where safe, and observable:

1. Reconcile unfinished leased jobs after lease expiry.
2. Replay outbox events from an immutable checkpoint.
3. Rebuild vector and graph derived indexes from authoritative source records.
4. Reconcile provider state before retrying actions whose external outcome is
   uncertain.
5. Run financial reconciliation against provider evidence and produce a
   reviewed correction workflow; do not silently mutate ledgers.
6. Verify audit-chain/signature/anchor integrity and alert on discontinuity.

Replay must be tenant-scoped, schema-version-aware, idempotent, rate-limited,
and fully auditable.

## 8. Backup, restore, and disaster recovery

Before production use, define and test:

- encrypted full backups and point-in-time recovery for PostgreSQL;
- backup retention, geographic/tenant constraints, and access controls;
- vector-index snapshot/rebuild policy and recovery-time objective;
- restore drills into isolated environments;
- documented RPO/RTO per data class;
- integrity verification after restore;
- separate audit-log/anchor retention; and
- a procedure for credential/key recovery that does not expose secrets in
  application storage or logs.

A backup is not accepted merely because it was created; restore evidence is a
release gate.

## 9. Production acceptance gates

The following are mandatory before replacing the current local-only
classification:

- concurrent/multi-process/multi-host load tests against the real database;
- crash, failover, retry, duplicate-delivery, and replay tests;
- migration and restore-drill evidence;
- tenant-isolation and authorization tests at the actual service boundary;
- outbox/inbox, lease, DLQ, and provider idempotency tests;
- vector recall/latency/cost evaluation on representative data;
- security review, secret management, observability, alerting, and runbooks;
- controlled staging deployment and production-change approval.

Until these gates are satisfied, no filesystem, PostgreSQL design, vector
index, commercial ledger, or control-plane record should be described as a
production-ready service.
