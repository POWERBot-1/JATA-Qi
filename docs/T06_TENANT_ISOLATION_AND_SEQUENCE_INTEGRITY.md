# T-06 — Production tenant isolation (RLS) and sequence integrity

Baseline: `main` @ `258595fb02f5e7ac4c1d1d14f799d43c1f25d06a` (canonical for T-06).

This document records what T-06 changed, the semantics now enforced by real
PostgreSQL state, and — just as importantly — what is **not** claimed.

Scope (approved): (A) wire PostgreSQL Row-Level Security into the production
transaction path so tenant context is set inside transactions, RLS fails
closed, and tenant ownership is verified across reads and writes — plus tenant
identity through the knowledge stack (knowledge-service, vector-search,
knowledge-graph); (B) replace query-then-write sequence allocation in
revenue-ledger and commercial-memory with the existing CAS-counter pattern
used by control-plane and unified-outbox. Existing application-level
authorization is preserved everywhere; no HTTP server, identity provider,
payment provider, LLM integration, or DR work is introduced.

## 1. Before / after

### Tenant isolation

```
Before: storage writes carried an optional tenantId on the document; nothing
        forced tenant context on a session, the DB enforced nothing, and any
        code path holding a collection could read every tenant's rows.

After:  tenant context is BOUND to a PostgreSQL session inside the same
        transaction that performs the write:
        BEGIN ──► SELECT set_config('app.tenant_id', <tenant>, true)
               ──► tenant-scoped reads/writes        (RLS policy sees the GUC)
               ──► COMMIT
```

Every collection table now carries a `tenant_id` column, is created with
`ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`, and has one pair of
policies:

- `SELECT`/`UPDATE`/`DELETE`: `tenant_id = current_setting('app.tenant_id')`
  (never satisfied when the setting is absent, a literal `*`, or a
  syntactically different tenant — fail closed, including for the table owner
  because of FORCE RLS);
- `INSERT`: `WITH CHECK` on the same predicate — a row whose `tenant_id`
  differs from the session tenant is refused at the database, not merely in
  application code.

The application-layer guard is unchanged and still runs first
(`PostgresCollection` tenant-mismatch check: writing a document whose
`tenantId` does not match the active tenant raises
`TenantIsolationDriverError` before any SQL). RLS is therefore the second,
in-depth, database-enforced boundary — not a replacement for authorization.
`StorageModule.atomically(scope, { tenantId })` and
`driver.beginTransaction({ tenantId })` run every statement of the composed
write with the tenant bound **inside** the transaction; a tenant id that does
not match the collection's charset is rejected before a transaction begins.
Scope-bound collection handles (`scope.collection(...)`) refuse to be used on
a different tenant than the scope they came from.

No application-level change is needed for the unscoped, legacy
development-ingress path (`cli`): a driver session without a tenant context
still defaults to system scope `*`; RLS makes such sessions see only rows
whose tenant is `*` or `null` — i.e. system-level rows — while tenant rows are
invisible. Explicit `{ tenantId: '*' }` system scopes behave the same.

### Sequence integrity

```
Before: revenue-ledger and commercial-memory allocated entry sequences with
        query-then-write (read latest entry / counter, then insert), so two
        concurrent writers for the same tenant could both observe the same
        "latest" state and allocate the same sequence.

After:  the same composed-write CAS pattern already proven in control-plane
        and unified-outbox:
        atomically({tenantId}, scope) {
          loop ≤64 rounds:
            observed = counters.get('seq:<tenant>')
            next     = observed.sequence + 1
            ok       = counters.cas('seq:<tenant>',
                                    guard: unchanged since observed,
                                    write: next)
            if ok: insert entry with sequence = next, previousHash = latest
                   entry's hash (or GENESIS) — same transaction
          }
        }
```

The CAS is a compare-and-swap on the counter row (optimistic concurrency):
exactly one writer wins a given counter state, so **no duplicate sequence can
be allocated** and the counter never moves backwards. Because allocation,
entry insert, and hash-chain linkage commit in ONE transaction, a crash or
failure rolls the allocation back with the entry: retries continue
contiguously with no gap and no reuse of a sequence that is already visible
in the chain.

## 2. Multi-process first-boot fix

T-06's multi-process evidence exposed one genuine driver bug: when several
fresh processes first touch a shared PostgreSQL database simultaneously, the
catalog race around `CREATE TABLE IF NOT EXISTS` can surface as
`23505` (unique violation on `pg_type`), `42P07` (duplicate table), or
`42710` (duplicate object — the table's implicit array type). The
storage-postgres driver previously retried only the first two codes, so
legitimate concurrent first boot could fail. `ensureResource` (collection
tables) and `doInit` (schema-registry table) now treat all three catalog-race
codes identically: one exact retry (the object now exists), any other error —
or a failing retry — rethrows the ORIGINAL error unchanged (fail closed).

## 3. Knowledge-stack tenant identity

Tenant identity now threads through the knowledge stack end to end:

- `knowledge-service`: `tenantId` is optional on ingest/retrieve/chunk reads.
  A **tenant-scoped** retrieval filters candidates by tenant BEFORE ranking
  and re-verifies every returned chunk/document against that tenant
  (fail-closed: a missing, differently-tagged, or untagged row is never
  returned). Calls without a tenant id stay system-level/legacy by design
  (used by the dev ingress); the production kernel callers below always pass
  a tenant.
- `vector-search`: `SearchOptions.tenantId` filters rows at the store level;
  vectors carry their tenant in row metadata.
- `knowledge-graph`: graph stores are per-tenant; entity/triple snapshot rows
  are keyed `tenant + separator + id` and reloaded into the tenant's own
  store on boot (the separator is U+0001 because PostgreSQL `text` rejects
  0x00 outright; tenant ids may not contain control characters).
- Kernel built-ins / capability adapters thread the actor/context tenant into
  each capability while preserving the legacy unscoped call shape.

The legacy default tenant (`DEFAULT_TENANT_ID`) remains for code that has not
been tenant-migrated (ingest without an explicit tenant lands there); such
knowledge is tenant-tagged and visible only under that tenant, so it can
never leak across tenant boundaries either.

## 4. What the tests prove (real embedded PostgreSQL — no mocks)

Workstream A — tenant isolation (storage-postgres, knowledge-graph):

- the `app.tenant_id` GUC provably runs inside `BEGIN … COMMIT` during
  `atomically(..., { tenantId })`; after COMMIT the pooled session provably
  reverts to the system default `'*'` (statement-level probe), and sequential
  tenant scopes on the SAME driver stay isolated (context does not leak
  between transactions);
- tenant A cannot read, count, has-check, update, or delete tenant B rows
  through bound scopes, and B's rows stay byte-intact after A's attempts;
- identical row ids across tenants cannot be clobbered or cross-read: tenant
  B's write of tenant A's id fails closed (driver ownership guard first, RLS
  underneath), and A's row stays byte-intact;
- a real non-superuser database role (`NOSUPERUSER`, no BYPASSRLS) sees zero
  rows with no tenant GUC, only its own tenant's row with the GUC set, and is
  refused cross-tenant INSERTs by the RLS `WITH CHECK` — with
  `relrowsecurity` and `relforcerowsecurity` asserted on the tables;
- FORCE ROW LEVEL SECURITY is proven at EXECUTION level, not only in the
  catalog: the non-superuser role is made the table OWNER, after which it
  still cannot read another tenant's rows without a matching GUC, cannot
  UPDATE another tenant's row (0 rows affected, payload byte-intact), and is
  refused cross-tenant INSERTs — behavior that only FORCE RLS produces (an
  owner on a non-forced RLS table bypasses the policies);
- driver/session restart: a fresh driver and pool keep unscoped/system reads
  working, keep tenant-bound transactions isolated, and RLS flags persist;
- explicit system scope `*` reads both tenants' rows at the storage layer
  (the operator path) while tenant scopes stay walled off;
- invalid tenant ids (spaces, quotes, empty, SQL-injection strings, slashes)
  are rejected before any transaction begins and write zero rows;
- composed-scope ownership: exactly one BEGIN and one COMMIT per
  `atomically`, and an injected failure rolls back BOTH the entry and its
  CAS sequence allocation, after which retry continues contiguously;
- knowledge: tenant A cannot retrieve, chunk-read, document-read, or
  vector-search tenant B's knowledge; graph traversal and entity stores stay
  per-tenant; a single database holds both tenants; persistence + reload into
  a fresh kernel keeps every tenant in its own partition; two kernels
  (two processes, one database) cannot see across tenants in either
  direction;
- identical-content knowledge: when BOTH tenants ingest the SAME text and
  create IDENTICAL entity/triple ids, every tenant-scoped retrieval, vector
  search, graph traversal, and Graph RAG call still resolves only the
  caller's own instances (identical ids persist as distinct composite rows
  stamped per tenant and reload partitioned);
- Graph RAG (`graphRetrieve`) is tenant-scoped end to end: hits and attached
  entities stay in-tenant even for identical entity ids;
- real OS processes: two full-lifecycle knowledge processes (each ingesting
  the same text + identical graph ids, each persisting its kernel snapshot)
  followed by TWO CONCURRENT read-only probe processes against the same
  database — every process observes only its own tenant's documents, chunks,
  vectors, and graph entities, and the database retains both tenants'
  rows without contamination.

Workstream B — sequence integrity (revenue-ledger, commercial-memory):

- two real OS processes concurrently appending/recording for one tenant
  produce exactly 2N unique, contiguous sequences with a verifiable hash
  chain (each worker runs the full production service path);
- three concurrent processes: same guarantee (3N, no duplicate, no gap);
- two processes on different tenants keep fully independent per-tenant chains;
- crash recovery: a worker SIGKILLed while its composed write is open leaves
  neither its entry nor its sequence allocation behind; the next append
  continues the chain with no gap and no duplicate;
- injected-failure rollback and retry: allocation and entry roll back
  together, then retry reuses the rolled-back sequence contiguously;
- the durable-handler `sourceEventId` idempotency guard still prevents
  duplicate entries on redelivery;
- final chains verify through the services' own `verifyIntegrity()` and
  through independent row-level assertions (contiguity, uniqueness,
  predecessor linkage).

All suites hard-fail ("DATABASE INTEGRATION NOT EXECUTED") when PostgreSQL
cannot start — a silent skip is not accepted as evidence.

## 5. Known limitations (honest scope statement)

- RLS policy evaluation trusts `app.tenant_id`, which only application code
  that holds a connection can set; this is a database-enforced application
  boundary, not a multi-role database-permission boundary. Superusers and
  BYPASSRLS roles remain able to read all rows — as they must be for
  operations; the production application never uses them for tenant traffic.
- Knowledge document ids are kernel-generated UUIDs: the public ingest path
  cannot produce two tenants holding the *identical* document id, so the
  identical-id proof targets the caller-supplied identity layer (graph
  entity/triple ids) plus identical content, while identical row ids at the
  storage layer are proven to fail closed (driver guard + RLS) rather than
  clobber.
- The knowledge-graph snapshot (`__kg__` rows) is written per kernel at
  shutdown (`replaceAll` over everything that kernel holds). The proven
  production shape is one kernel per database owning ALL tenants (single
  snapshot is complete); two kernels holding *disjoint* tenants serialize
  their snapshot lifecycles in the process proof. Concurrent `replaceAll`
  snapshot writes from two kernels are not a supported pattern and are not
  claimed safe.
- The session-level GUC leak (a tenant `SET` outliving its transaction on a
  pooled connection) remains OPEN and is deliberately not depended on:
  every tenant-bound path binds the tenant inside its transaction
  (`SET LOCAL` semantics, proven statement-level), pooled sessions reset to
  `'*'` on connect, and nothing in T-06 relies on autocommit-after-transaction
  statements inheriting tenant context.
- Multi-process first boot races (two processes creating the same table
  simultaneously) are handled for the catalog race codes observed
  (`23505`/`42P07`/`42710`, one exact retry); other DDL failure modes are
  intentionally fail-closed.
- Tenant migration of every caller is NOT complete: the knowledge
  capabilities keep a legacy unscoped entry point (defaults to
  `DEFAULT_TENANT_ID`) and the CLI dev ingress remains unscoped. Those paths
  are tenant-tagged and isolated — not widened.
- Hash-chain linkage is verified in tests at the row level and via the
  services' integrity check; T-06 does not add archival, compaction, or
  re-keying of ledger chains.
- `hash` values for manually injected "handled" rows inside the idempotency
  sub-test are placeholders; the sub-test asserts guard semantics (no second
  row) and row-level linkage, not service re-hashing of synthetic rows.

## 6. Deliverables shipped with T-06

- source: storage tenant-binding/RLS enforcement; tenant plumbing through the
  knowledge stack; CAS sequence allocation in revenue-ledger and
  commercial-memory; multi-process first-boot retry in the storage driver;
- tests: real-PostgreSQL suites listed in §4, all running inside the standard
  monorepo `npm test` without external services (embedded PostgreSQL);
- this document; a separate exact changed-file inventory accompanies the
  change set.
