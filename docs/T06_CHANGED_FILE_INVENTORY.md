# T-06 exact changed-file inventory

Branch: `arena/01a07352-jata-qi` · Baseline: `main` @ `258595fb02f5e7ac4c1d1d14f799d43c1f25d06a`
25 modified files · 11 new files · 0 deletions · 35 files changed, +3,643/−278 (vs canonical `258595fb`)

## Workstream A — production tenant isolation & RLS (storage substrate)

| File | Change |
| --- | --- |
| `packages/storage/src/types.ts` | scope-bound collection handles carry an immutable tenant binding; tenant option on `atomically`/`beginTransaction`/`unsafeWrite` |
| `packages/storage/src/storage-module.ts` | tenant plumbing through `atomically`, transaction scopes, and per-scope `collection()` handles |
| `packages/storage-postgres/src/tenant-isolation.ts` | strict tenant-id validation, `tenant_id` DDL, `ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + SELECT/UPDATE/DELETE/INSERT-WITH-CHECK policies |
| `packages/storage-postgres/src/postgres-collection.ts` | tenant-bound collection: mismatch guard (`TenantIsolationDriverError`) before SQL; first-create CAS via `INSERT … ON CONFLICT DO NOTHING`; loser returns `{ok:false, doc:undefined}`; tenant_predicate SQL on every statement |
| `packages/storage-postgres/src/postgres-driver.ts` | connect-hook system scope, `tenant_id` column in DDL, `beginTransaction({tenantId})`, per-transaction `set_config('app.tenant_id', …, true)`; multi-process first-boot catalog-race retry for `23505`/`42P07`/`42710` in `ensureResource` AND `doInit` (T-06 multi-process evidence) |

## Workstream A — knowledge-stack tenant identity

| File | Change |
| --- | --- |
| `packages/knowledge-service/src/types.ts` | optional `tenantId` on Document/Chunk/Ingest/Retrieve/stats types |
| `packages/knowledge-service/src/knowledge-module.ts` | tenant-aware ingest/get/delete/retrieve/stats; fail-closed tenant re-verification on every returned row |
| `packages/knowledge-service/src/index.ts` | exports `DEFAULT_TENANT_ID` |
| `packages/vector-search/src/types.ts` | `SearchOptions.tenantId` |
| `packages/vector-search/src/vector-module.ts` | row-level tenant filter on search before ranking |
| `packages/knowledge-graph/src/graph-module.ts` | per-tenant stores; persisted snapshot row ids namespaced `tenant \u0001 id` (PG-safe separator); tenant threading through add/get/remove/traverse/find/stats and load/persist |
| `packages/knowledge-graph/src/graph-rag.ts` | tenant threading into graph-RAG |
| `packages/unified-loop/src/capability-adapters.ts` | actor/ctx tenant passed into knowledge/vector/graph capabilities; legacy unscoped fallback preserved |
| `packages/agent-runtime/src/builtins.ts` | tenant threading into built-in knowledge capabilities |

## Workstream B — sequence integrity (CAS counters)

| File | Change |
| --- | --- |
| `packages/revenue-ledger/src/revenue-ledger-service.ts` | `recordCost`, revenue-recognition handler, refund-reversal handler now run as tenant-bound `atomically(…, {tenantId})` composed writes; `append()` CAS-advances per-tenant counter `revenue-ledger.entries-seq` (`seq:<tenant>`), ≤64 rounds, then links to the latest entry with `sequence < reserved`; hash chain preserved |
| `packages/commercial-memory/src/commercial-memory-service.ts` | `record()` and raw-event capture as tenant-bound composed writes; CAS counter `commercial-memory.records-seq` (`seq:<tenant>`); same append/predecessor mechanics |

## Durability handlers passing tenant context (existing authz preserved)

| File | Change |
| --- | --- |
| `packages/billing/src/billing-service.ts` | invoice-paid / invoice-refunded durable handlers bind `{tenantId: event.tenantId}` on their composed writes |
| `packages/payments/src/payments-service.ts` | verifyPayment/verifyRefund bind tenant on composed writes when actor and payment tenant match, else unscoped (unchanged semantics for cross-tenant/system actors) |
| `packages/loop-host/src/work-queue.ts` | concurrent deterministic-id enqueue: CAS loser re-reads the winner by id (≤8 rounds), fail-closed throw if invisible |
| `packages/loop-host/src/outbox-inbox.ts` | duplicate outbox-create loser re-reads the winner by id; fail-closed if invisible |

## Build metadata

| File | Change |
| --- | --- |
| `packages/revenue-ledger/package.json` | devDeps (`@jataqi/storage-postgres`, `embedded-postgres`); build copies `t06-ledger-worker.mjs` into `dist/test` |
| `packages/commercial-memory/package.json` | same for its worker |
| `packages/knowledge-graph/package.json` | devDeps (`@jataqi/storage-postgres`, `embedded-postgres`, `@types/node`) for the PG suite |
| `package-lock.json` | lockfile sync for the above |

## New tests (real embedded PostgreSQL — hard fail when PG unavailable)

| File | Proves |
| --- | --- |
| `packages/storage-postgres/test/t06-rls-production-path.test.ts` | GUC set inside BEGIN…COMMIT and NO leak between transactions (post-COMMIT session reverts to `'*'`; sequential scopes isolated); cross-tenant read/mutate fail-closed; IDENTICAL row ids across tenants fail closed (no clobber, no cross-read); non-superuser role subject to RLS; FORCE RLS proven at EXECUTION level (role becomes table OWNER: no GUC → no rows, foreign-row UPDATE affects 0 rows, cross-tenant INSERT refused, payload byte-intact); restart keeps isolation; explicit system scope; invalid tenant ids write nothing; one BEGIN/COMMIT per scope; rollback hides entry + sequence allocation; retry contiguous |
| `packages/knowledge-graph/test/t06-knowledge-tenant-pg.test.ts` | full knowledge stack over PG: per-tenant ingest/retrieve; cross-tenant retrieval/chunk/document/vector access fails closed in both directions; graph per-tenant stores/traversal; single DB holds both tenants; persistence + fresh-kernel reload stays partitioned; two kernels on one DB cannot cross; IDENTICAL content + IDENTICAL entity/triple ids stay isolated (retrieval, vectors, traversal, Graph RAG `graphRetrieve`, composite persisted rows, post-reload partition); two full-lifecycle OS processes + two CONCURRENT OS probe processes on one DB show no contamination |
| `packages/knowledge-graph/test/t06-knowledge-worker.mjs` | knowledge OS-process worker: `ingest` (boot → ingest shared text → add identical graph ids → tenant-scoped self-checks → shutdown/persist) and `probe` (read-only concurrent observer with internal fail-closed assertions) |
| `packages/revenue-ledger/test/t06-ledger-concurrency-pg.test.ts` (+ `t06-ledger-worker.mjs`) | two and three real OS processes appending one tenant: unique contiguous sequences, valid hash chain (row-level + service `verifyIntegrity`); different tenants independent; SIGKILL mid-transaction rolls back entry + allocation, retry continues; injected-failure rollback; `sourceEventId` redelivery guard |
| `packages/commercial-memory/test/t06-memory-concurrency-pg.test.ts` (+ `t06-memory-worker.mjs`) | same evidence for commercial-memory `record()` |
| `packages/{revenue-ledger,commercial-memory,knowledge-graph}/test/embedded-postgres.d.ts` | ambient types for the embedded-postgres dev dependency |

## Documentation

| File | Change |
| --- | --- |
| `docs/T06_TENANT_ISOLATION_AND_SEQUENCE_INTEGRITY.md` | engineering record: before/after semantics, RLS mechanics, multi-process first-boot fix, test evidence, honest limitations |

## Not changed (deliberately)

No HTTP/API server, no OIDC/OAuth/SAML, no payment providers, no LLM
integration, no DR work, no unrelated refactors. Files outside the above list
are byte-identical to baseline (verified by `git status` against
`258595fb`).
