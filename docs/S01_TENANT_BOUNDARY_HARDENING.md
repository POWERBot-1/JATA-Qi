# S-1 — Tenant Boundary Hardening: root-cause / impact map (pre-implementation)

**Milestone:** S-1 (authorized 2026-09-06, after independent verification of R-1+R-4 returned *PASS WITH NON-BLOCKING FINDINGS*)
**Branch:** `arena/01a076d2-jata-qi` · **base:** `c45cfc1e32dca28916a5c343dc457bfc3b379ea5` (verified head of PR #20) · **canonical `main`:** `82af3def9b8b26989b3f686369d17f03bb62ad9c` (unmutated)
**Governance:** PR #20 stays open/unmerged · no merge · no `main` mutation · no T-10 · implement S-1 only · STOP after push + PR update

> Workspace recovery note: this sandbox was recreated between cycles. `.git` was a fresh
> main-only clone whose local branch pointer sat at `82af3de` while the working tree still
> held the verified content. The remote still held `refs/heads/arena/01a076d2-jata-qi =
> c45cfc1` and `refs/pull/20/head = c45cfc1`; the branch was fetched and the pointer
> restored (`update-ref` + `reset --hard c45cfc1`) after proving every tracked and untracked
> file was byte-identical to `c45cfc1`'s blobs. Ancestry re-verified: `c45cfc1 → 0cb6b6b →
> 82af3de`, 0 merge commits, clean tree. No history was rewritten.

---

## 1. Root cause map

### B-1 — service-level tenant widening (Priority 1, incl. **destructive** delete)

**Root cause.** `KnowledgeService` applies two different tenant disciplines in one class:

| Path | Gate | Behaviour with no tenant |
|---|---|---|
| write (`ingestText`) | `resolveTenantIdForIngest()` (`knowledge-module.ts:62-73`) | **fails closed** (K1) unless `JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK=1` / `JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK=1` |
| read/delete (`getDocument`, `getChunk`, `deleteDocument`, `retrieve`, `stats`) | `tenantId !== undefined` (`:146, :156, :164, :188, :211, :238`) | **widens**: no filter at all ⇒ every tenant's data |

The read side treats "no tenant" as *system-level* rather than *unauthorized*. The same
asymmetry exists one layer down in `VectorSearchModule.scopeOptions()`
(`vector-module.ts:121-130`), which returns options unchanged when `tenantId === undefined`
even though its own doc comment claims it "fails closed at the module boundary", and one
layer up in `agent-runtime/builtins.ts:14-17`, whose `ctxTenantId()` returns `undefined`
when `ctx.metadata.tenantId` is absent — documented as "the tools keep their legacy unscoped
behavior".

**Verified impact (independent probes, previous cycle).**
- `retrieve(q)` with no tenant returned **both** tenants' chunks; `stats()` returned global totals; `getChunk`/`getDocument` returned a foreign record.
- **`deleteDocument(id)` with no tenant destroyed a foreign tenant's document** (highest severity: unscoped, unauthenticated, destructive, and it also removes the vectors and emits `DocumentDeleted`).
- `knowledgeSearchTool` with `ctx.metadata = {}` disclosed a foreign chunk (score 0.86).
- Blank/whitespace tenant returned empty results (fail-closed *by accident* of the equality filter, not by design).
- **Not affected** (already fail-closed, verified): `KnowledgeGraphModule.resolveTenantId` (K1) — `graph.stats(undefined)` throws; `graph.retrieve` with no ctx tenant throws.

**Reachability today.** Latent, not live: the CLI passes an explicit tenant at 9/9 call
sites; `AgentRuntimeModule`'s only consumer is the CLI, which seeds `metadata.tenantId`;
unified-loop capabilities use `ctx.actor.tenantId`, and the principal boundary enforces
`isNonBlankString` + actor≡principal tenant (`principal-snapshot.ts:72,144,150`). The hazard
is that the **authoritative data boundary is fail-open**, so every future consumer inherits
cross-tenant read/delete by default. Aggravating factor: on memory/filesystem dev drivers
`atomically(fn,{tenantId})` performs no tenant filtering (T-09 finding **F-6**), so the
service filter is the *only* boundary in development.

**Required contract (per authorization).** For every tenant-bound data-plane operation:
tenant required → missing/blank fails closed; tenant supplied → operation is scoped to it;
cross-tenant identifier → denied (no read, no mutation); ambiguous tenant → denied; no
implicit default tenant. Enforcement moves to the authoritative service/data boundary
(knowledge-service, vector-search) **and** the agent/tool boundary (builtins) — not the CLI.

**Design.**
1. New `packages/knowledge-service/src/tenant-context.ts`: `TenantContextError` (+ stable `code`), `isDefaultTenantFallbackAuthorized()` (the two K1 flags only, never `NODE_ENV`), and `resolveTenantContext(requested, op)` — the single guard: non-blank string ⇒ returned unchanged; `undefined`/`null`/blank ⇒ **throw** unless the K1 flags authorize the test-only default (preserving existing K1 semantics and message shape for `ingestText`).
2. Apply it to **all six** tenant-bound operations (`ingestText`, `getDocument`, `getChunk`, `deleteDocument`, `retrieve`, `stats`), keeping the existing cross-tenant denials (`undefined` / `false`) and the retrieve pre-rank filter + post-verification.
3. Make the tenant **compile-time required** in the tenant-bound signatures (`IngestOptions.tenantId: string`, `RetrievalOptions.tenantId: string`, `getDocument/getChunk/deleteDocument(id, { tenantId: string })`, `stats({ tenantId: string })`) so the compiler enumerates every caller — no call site can be missed and none can silently pass `undefined`.
4. `VectorSearchModule.embedAndSearch()/search()`: require a non-blank `opts.tenantId` and fail closed (strict; no default-tenant concept exists at the vector layer, so no escape hatch). `index()`/`embedAndAdd()` stay as low-level primitives (records carry tenant metadata; their callers are tenant-resolved) — documented residual.
5. `agent-runtime/builtins.ts`: all five tenant-bound tools (`knowledge.search`, `graph.traverse`, `graph.findEntity`, `graph.retrieve`, `vector.search`) **fail closed** when `ctx.metadata.tenantId` is missing/blank — the legacy unscoped mode is removed, not preserved.
6. `graph-rag.ts`: resolve/assert the tenant **before** any vector or graph work (today the unscoped vector retrieval happens first and only the later graph call throws), and pass it explicitly on every lookup.
7. **Intentionally tenant-independent contracts preserved:** none of the six operations has a legitimate tenant-independent consumer (verified by repo-wide trace), so no "system-level" mode is kept. `KnowledgeGraphModule`'s public API keeps its existing runtime K1 guard (already fail-closed) rather than being churned into compile-time requiredness — that would be unrelated refactoring of 15 methods and ~100 test call sites for no security gain.

### B-2 — latent `graph.store` default-tenant handle (Priority 2)

**Root cause.** `KnowledgeGraphModule.init()` executes
`kernel.container.registerValue('graph.store', this.storeFor(DEFAULT_TENANT_ID))`
(`graph-module.ts:128`). `storeFor(DEFAULT_TENANT_ID)` is called with an *explicit* value, so
it never passes through the fail-closed `resolveTenantId` guard, and the deprecated
`get store()` getter (which *does* fail closed) is bypassed entirely: the container hands any
resolver a live, writable `MemoryTripleStore` for the reserved default tenant.

**Verified impact.** `container.resolve('graph.store')` → real store; `upsertEntity(...)`
through it landed in the default bucket (0 → 1 entities), was visible via
`graph.allEntities('default')`, and `persist()` made it **durable** (`default\u0001ent:probe`).
The handle is bound to `default` only, so it cannot read A/B buckets — the impact is
*unauthorized write into the shared default bucket + durability*, plus the boot-time creation
of an ambient default store that makes `tenantKeys()` include `default` on every process.

**Reachability.** Any code with kernel/container access (in-process modules, adapters, future
consumers). **No consumer exists today**: a repo-wide grep for `graph.store` finds only the
registration itself and two test comments — so removal is free of breakage.

**Design.** Delete the ambient registration (and the deprecated `get store()` unscoped-handle
API). Tenant identity becomes explicit at the authoritative boundary: `storeFor(tenantId)`
remains the only way to obtain a store, and it fails closed without a tenant. Keep
`graph.module` (the module itself exposes only tenant-explicit methods). Adversarial tests
must prove `container.resolve('graph.store')` now fails, that no `default` store exists at
boot (`tenantKeys()` excludes it; `stats(DEFAULT_TENANT_ID)` = 0), and that no handle can
write another tenant's data.

### B-3 — untagged durable rows funnelled into `default` (Priority 3)

**Root cause.** `loadFromStorage()` maps a durable row with no tenant to the reserved bucket:
`const tenant = row.tenantId ?? DEFAULT_TENANT_ID` (`graph-module.ts:364` entities, `:371`
triples). `persist()` then rewrites every in-memory store with an explicit tenant tag, so the
silent guess becomes **canonical** (`default\u0001ent:untagged @ default`) — an ownership
assignment nobody authorized.

**Verified impact.** A hand-crafted untagged `__kg__.entities` row loaded into the `default`
bucket and was queryable through the public graph API for `default`; tagged rows were
correctly isolated; untagged rows never appeared in a real tenant's bucket. Combined with B-2
(unauthorized write) and B-4 (`default` actor) this makes the reserved bucket a writable,
readable, durable sink.

**Design (safest auditable fail-closed option: quarantine + explicit migration attribution).**
- Untagged tenant-sensitive rows are **never** loaded into any tenant store and **never** tagged `default`.
- They are held in a module-level **quarantine** (raw rows, unmodified), reported at load through a structured WARN + audit event with row ids and counts, and exposed via a read-only `quarantineReport()` accessor for operators.
- `persist()` re-emits quarantined rows **verbatim** (still untagged) so quarantine is non-destructive — no data loss, no silent ownership.
- Opt-in **explicit migration attribution**: `KnowledgeGraphConfig.untaggedRowTenant` (must be non-blank and must not be `DEFAULT_TENANT_ID`; validated at construction) attributes untagged rows to that named tenant with a WARN + audit record. Absent ⇒ quarantine. Never inferred from `NODE_ENV`, never defaulted.
- Knowledge-service needs no equivalent change: it never assigns a tenant to untagged rows — with B-1 fixed, untagged doc/chunk rows are unreachable by every read (verified by test).

### V-1 — forged `knowledge.document.ingested` ⇒ foreign metadata disclosure (Priority 4)

**Root cause.** The auto-index consumer trusts the event payload and performs an **unscoped**
privileged lookup: `graph-module.ts:139-150` reads `payload.tenantId` (falling back to the
K1 guard) and then calls `svc.getDocument(p.docId)` **without** a tenant, writing the result's
`title`/`metadata` into the *claimed* tenant's graph. `autoIndexDocuments` defaults to `true`
(`:72`), so the handler is always registered. `knowledge.document.ingested` is a nominated
subscription for `@jataqi/knowledge-graph` (F-01e table, `event-envelope.ts:443`).

**Verified impact.** Emitting `{docId: <B's doc>, tenantId: 'tenant-alpha'}` planted a
`Document` entity in A's graph carrying B's title (`BETA-CONFIDENTIAL-TITLE`) and metadata
(`classification: beta-secret`). Body text was **not** disclosed; B's bucket was unaffected.
Preconditions: in-process bus-publish capability plus knowledge of the foreign `docId`.

**Design (treat event payloads as untrusted).**
1. **Producer attestation:** migrate the emit to the sanctioned F-01b helper
   `emitPlainEnveloped(bus, KnowledgeEvents.DocumentIngested, payload, { source: 'knowledge', tenantId, entityId: docId, correlationId, privacyClassification: 'INTERNAL' })`
   so the tenant is bound **in the envelope**, not only in the payload, and the producing
   subsystem is recorded in `source`/`provenance`. Legacy subscribers keep receiving the
   byte-identical plain payload (`legacyPayload`), so F-01a compatibility is preserved.
2. **Consumer validation, in order, all fail-closed with an audit record:**
   - envelope `source`/`provenance.source` must be the attested producer (`knowledge`); a plain `bus.emit` spoof is bridged as `legacy-bridge` ⇒ refused;
   - tenant must be present and non-blank (envelope, corroborated by the payload when the payload carries one); envelope/payload disagreement ⇒ **ambiguous ⇒ refused**; `system` ⇒ refused;
   - **authoritative corroboration before any privileged use:** `svc.getDocument(docId, { tenantId })` — the scoped read (B-1 fix) returns `undefined` for a foreign document ⇒ refuse, create nothing, disclose nothing.
3. Honest limitation, recorded in the milestone doc: any in-process code holding the bus can
   forge `source`, so the **scoped corroboration is the control that actually prevents
   cross-tenant disclosure**; attestation and tenant binding are defense-in-depth and
   auditability, not the sole gate. Replay of a *legitimate* event is idempotent
   (`addOrGetEntity` upsert into the same tenant) and cannot cross tenants.

### V-2 — `entities` path lacks the CLI re-filter (Priority 5)

**Root cause.** `runKnowledgeCommand` re-filters `search` hits against the operator tenant
(`knowledge-command.ts:280-281`) but prints `graph.allEntities(tenantId)` /
`entitiesByType(type, tenantId)` results verbatim (`:290-292`).

**Verified impact.** With a poisoned graph dependency returning a foreign entity, the CLI
printed `BETA-SECRET-ORG … [tenant tenant-alpha]`. **Not exploitable through the real module**
(store-partitioned + K1 fail-closed), so this is a defense-in-depth asymmetry.

**Design (authoritative first, then defense-in-depth).** The authoritative protection is the
graph module's tenant partitioning plus B-2's removal of the ambient default store. On top of
that, the CLI attributes every listed entity back through the authoritative tenant-scoped
lookup — `graph.getEntity(id, tenantId)` must return the same entity — and drops (with an
auditable stderr line counting drops) anything not attributable to the operator tenant,
including any row carrying a foreign `tenantId` marker. `getEntity` is added to the injected
`Pick<>` dependency for this purpose.

### B-4 / B-5 / B-6 / B-7 (not ignored)

- **B-4** `host-inspect.ts:37` `env.JATAQI_OPERATOR_TENANT ?? 'default'` builds the read-only inspection actor (used for tenant-scoped outbox/inbox/DLQ/work reads). Fix: resolve the operator tenant through the **same** authoritative CLI resolver (`resolveOperatorTenant`), i.e. missing/blank/reserved-`default`/mismatch ⇒ refusal **before boot**, no silent default. (Verified nuance: an *empty* value already failed closed downstream; only the *unset* case silently defaulted.)
- **B-5** Document the operator-tenant requirement accurately: README + `.env.example`, and fix **V-4** — `.env.example` ships `JATAQI_OPERATOR_TENANT=default`, a value the CLI refuses, while `index.ts:97` calls `loadEnv()`, so a copied example yields fail-closed refusals out of the box. Sample value becomes a real tenant id, with the refusal semantics stated for both knowledge and `host:*` inspection commands.
- **B-6** Investigate the Node 24 vs requested Node 20 discrepancy and report intent. Static investigation only (workflow, `engines`, runtime-feature usage, local multi-version evidence); CI log blobs are unreachable from this sandbox (TLS egress blocked), which will be reported as an explicit limitation rather than inferred away. **No `ci.yml` change** in this milestone (it must stay byte-identical so the security diff audit remains clean).
- **B-7** Determine whether the CI gate is *required* by branch protection. `GET /branches/main/protection` returns 403 to this sandbox's token; an **empirical** determination is possible instead: `main`'s tip `82af3de` is itself the merge commit of PR #19, and PR #19's head `d221f655` had a **red** CI run — if `merged: true` with `merge_commit_sha = 82af3de`, a red gate did not block the merge. Result reported verbatim, with the exact authorization limitation stated. **No merge is performed regardless.**

---

## 2. Impact / blast radius (measured before editing)

| Surface | Change | Callers to update |
|---|---|---|
| `knowledge-service` API | tenant compile-time required + runtime fail-closed on 6 operations | src: `knowledge-graph/graph-rag.ts` (5), `knowledge-graph/graph-module.ts` (3), `cli/knowledge-command.ts` (5), `unified-loop/capability-adapters.ts` (2), `agent-runtime/builtins.ts` (1). tests: `knowledge-graph/test/t06-knowledge-tenant-pg.test.ts` (32), `cli/test/cli-tenant-isolation.test.ts` (12), `cli/test/cli.test.ts` (3), `knowledge-graph/test/graph*.test.ts` (4), `knowledge-service/test/*`, `vector-search/test/vector.test.ts` (1) |
| `vector-search` module | `embedAndSearch`/`search` require tenant | 3 src callers (all tenant-bound) + its own tests |
| `agent-runtime` builtins | 5 tools fail closed without ctx tenant | agent tests that pass `metadata: {}` |
| `knowledge-graph` | B-2 handle removal, B-3 quarantine, V-1 consumer hardening | no `graph.store` consumers exist (grep-verified); graph tests referencing boot-time `default` store comments |
| `cli` | V-2 entities attribution, B-4 inspection actor | `host-inspect` tests/CLI tests that relied on the `default` actor |
| docs | README, `.env.example`, `docs/S01_TENANT_BOUNDARY_HARDENING.md` | — |

**Untouched by design:** `storage`, `storage-postgres` (RLS/driver isolation), `authentication`,
`commercial-control-plane`, `loop-host`, `regulatory-gates`, `human-approval`,
`capability-fabric`, `core-kernel` (the envelope helpers already exist; no fabric change),
`.github/workflows/ci.yml`, lint config, every T-09 monetary file, and the R-1/R-4 test
assertions (extended, never weakened).

## 3. Invariants this milestone must preserve and strengthen

tenant isolation · K1 fail-closed (the two flags remain the *only* authorizers, and are set
nowhere) · authorization enforced outside the model · RLS/storage isolation · explicit tenant
propagation · no implicit default tenant anywhere · least privilege (ambient handles removed) ·
defense-in-depth (authoritative boundary **and** CLI re-filters) · auditable authorization
decisions (every refusal/drop/quarantine is logged with a reason and count).

## 4. Test plan (adversarial, mapped to the 11 required cases)

| # | Required case | Where |
|---|---|---|
| 1 | cross-tenant read | knowledge-service S-1 suite (retrieve/getChunk/getDocument/stats as A vs B), CLI isolation suite |
| 2 | cross-tenant write | ingest into A never visible to B; graph writes partitioned; no default-bucket write |
| 3 | **cross-tenant delete** | `deleteDocument(B)` as A ⇒ `false`, B intact; unscoped delete now **throws** |
| 4 | undefined tenant | every tenant-bound operation throws `TenantContextError`; tools refuse; vector search refuses |
| 5 | mismatched tenant | id owned by B requested with tenant A ⇒ denied (read `undefined`, delete `false`); envelope/payload tenant disagreement ⇒ refused |
| 6 | forged event | plain `bus.emit` spoof (`source: legacy-bridge`) ⇒ refused, nothing created, audit recorded |
| 7 | foreign document ID | attested-source event with B's `docId` claimed by A ⇒ scoped corroboration fails ⇒ refused, no title/metadata disclosure |
| 8 | untagged storage row | quarantined, invisible to every tenant (incl. `default`), preserved verbatim by `persist()`, reported; explicit `untaggedRowTenant` attribution path tested; `DEFAULT_TENANT_ID` attribution rejected |
| 9 | default-tenant handle abuse | `container.resolve('graph.store')` fails; no `default` store at boot; no writable ambient handle |
| 10 | entities enumeration | A cannot enumerate B; poisoned dependency's foreign entities dropped + audited; missing tenant fails closed |
| 11 | replay/manipulation | replayed legitimate event is idempotent and tenant-bound; manipulated ids/tenants refused; `--tenant` manipulation still refused at the CLI |

Then: full suite (49 workspaces), build, lint, CLI tests, knowledge-service tests,
knowledge-graph tests, storage/PostgreSQL tests with **genuine** PostgreSQL (embedded-postgres
harness: RLS, tenant isolation, multi-process), and the tenant-isolation/security suites —
with a complete diff inspection, deleted-line/assertion audit, fallback-flag sweep, and
RLS/authentication non-weakening proof before commit.

## 5. Implementation record (what changed, per finding)

Every change below is inside the authorized S-1 scope. No unrelated refactoring was performed:
`packages/storage-postgres` (RLS/durable isolation), `packages/authentication`,
`packages/cli/src/auth-config.ts`, `packages/core-kernel` and every other workspace are
**untouched** (see §7 audit).

| Finding | File(s) | Change now enforced at the authoritative boundary |
|---|---|---|
| **B-1** (incl. destructive `deleteDocument`) | `packages/knowledge-service/src/tenant-context.ts` (new), `knowledge-module.ts`, `types.ts`, `index.ts` | One shared guard (`resolveTenantContext`) resolves the tenant for **all six** tenant-bound ops (`ingestText`, `retrieve`, `getDocument`, `getChunk`, `deleteDocument`, `stats`). Non-blank tenant ⇒ scoped; missing/blank/non-string ⇒ `TenantContextError` (`TENANT_CONTEXT_REQUIRED`) thrown **before** any storage/vector work; K1 semantics preserved verbatim (same two flags, same WARN, no `NODE_ENV` authorization). The tenantless `stats()` **global cross-tenant total branch was deleted**; `retrieve()` now pushes the tenant into the vector layer (`embedAndSearch({ tenantId })`) instead of filtering only at the caller. `deleteDocument` resolves the tenant first and deletes only a document owned by that exact tenant (cross-tenant/untagged ⇒ `false`, zero mutation, no event). |
| **B-1** (vector layer) | `packages/vector-search/src/tenant-context.ts` (new), `vector-module.ts`, `index.ts` | `scopeOptions` is applied on **both** module search paths (`search`, `embedAndSearch`): a missing/blank tenant is refused by a strict local guard (this package cannot import the knowledge-service one — dependency direction — and it honours **no** fallback flag), and a tenant-scoped search only returns records whose `metadata.tenantId` equals it. `index()`/`embedAndAdd()` remain low-level, tenant-agnostic primitives (documented residual, pinned by a test). |
| **B-1** (tool layer) | `packages/agent-runtime/src/builtins.ts` | `ctxTenantId(ctx, tool)` now **throws** `TenantContextError` instead of returning `undefined` (the "legacy unscoped behavior" branch is deleted). All five built-ins (`knowledge.search`, `graph.traverse`, `graph.findEntity`, `graph.retrieve`, `vector.search`) resolve the execution tenant before any data-plane call. No tool input schema accepts a tenant, so the model cannot name one. |
| **B-2** | `packages/knowledge-graph/src/graph-module.ts` | The deprecated `get store()` getter and the `kernel.container.registerValue('graph.store', …DEFAULT_TENANT_ID…)` registration are **removed**: there is no ambient, unscoped, writable store handle for any resolver to obtain. A store is reachable only via `storeFor(tenantId)`, which routes missing **and blank/whitespace** tenants through the fail-closed guard (so no unowned `''` bucket can be minted either). `requireTenant(tenantId, op)` is the exported read-side wrapper used by graph-RAG. |
| **B-3** | `packages/knowledge-graph/src/graph-module.ts` | `loadFromStorage` no longer does `row.tenantId ?? DEFAULT_TENANT_ID`. Untagged (or blank-tagged) durable entity/triple rows are **quarantined**: not loaded into any tenant store, counted and listed by the new read-only `quarantineReport()`, reported through a structured `WARN`, and re-emitted **verbatim** (still untagged) by `persist()` so quarantine is non-destructive. The only attribution path is the new explicit operator option `KnowledgeGraphConfig.untaggedRowTenant`, validated at construction to be a non-blank string that is **not** the reserved `DEFAULT_TENANT_ID`; attributions are counted and `WARN`-audited. |
| **V-1** | `packages/knowledge-graph/src/graph-module.ts`, `index.ts`; producer side `knowledge-module.ts` | New exported pure decision function `authorizeDocumentIngestedEvent(envelope)` enforces, in order: producer attestation (`envelope.source` **and** `envelope.provenance.source` must be `KNOWLEDGE_EVENT_SOURCE`), tenant binding (non-blank, not `SYSTEM_TENANT`, payload tenant may only *agree*), then the handler performs an authoritative **tenant-scoped** `getDocument(docId, { tenantId })` corroboration before creating any entity. Every refusal is `WARN`-audited with its reason and states that nothing was read/created. The producer emits all knowledge events through `emitPlainEnveloped` with `source: 'knowledge'` and the owning tenant bound to the envelope, while legacy plain subscribers keep receiving the identical payload. |
| **V-1/V-3** (retrieval path) | `packages/knowledge-graph/src/graph-rag.ts` | `graph.requireTenant(opts.tenantId, 'graphRetrieve')` runs **before** any vector or graph lookup, and the tenant is passed explicitly into `svc.retrieve(…, { tenantId })` rather than relying on a caller-side filter. |
| **V-2** | `packages/cli/src/knowledge-command.ts` | Authoritative protection is the graph module's tenant partitioning (a tenantless graph call fails closed there). The CLI keeps defense-in-depth: the `graph` dependency Pick gains `getEntity`, and the `entities` listing re-attributes every row through `getEntity(id, tenantId)`, dropping (with an audited stderr count) any row carrying a foreign tenant marker, any row the authoritative lookup will not corroborate, and **all** rows when the lookup is unavailable (fail-closed). |
| **B-4** | `packages/cli/src/host-inspect.ts` | `inspectActor` no longer does `env.JATAQI_OPERATOR_TENANT ?? 'default'`; it calls the same authoritative `resolveOperatorTenant` the knowledge commands use, and the tenant is resolved **before** `createJataQiFromEnv()` is called, so a refusal boots nothing, reads nothing, and reports nothing (exit 1, `refused (no tenant context; nothing was booted or read)`). Least privilege is unchanged: `global_admin` still requires `JATAQI_OPERATOR_GLOBAL_ADMIN=true`. |
| **B-5 / V-4** | `README.md`, `.env.example` | New README section **"Tenant boundary (S-1)"** states the contract table (scoped / refused / denied / quarantined), the absence of any implicit default tenant, the K1 flag semantics, and the B-2/B-3/V-1/V-2 guarantees, and names the suites that pin them. `.env.example` no longer ships `JATAQI_OPERATOR_TENANT=default` — a value the CLI **refuses** while `index.ts` auto-loads `.env`, which made a copied example fail closed out of the box; the sample is now a real-shaped tenant id (`tenant-acme`) with the requirement documented for both the knowledge commands and `host:*` inspection. |
| **B-6 / B-7** | — | Investigation/determination only; recorded in §8. No code change was authorized or made. |

## 6. Adversarial test record

New suites (all run with **no** fallback flag set, and each asserts at entry that
`JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK` / `JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK` are unset):

| Suite | Cases | Covers |
|---|---|---|
| `packages/knowledge-service/test/s1-tenant-boundary.test.ts` | 9 | B-1: tenantless refusal for all six ops (with a "no mutation, no disclosure" post-check), blank/whitespace refusal, cross-tenant read denial by id and by adversarial query text, **cross-tenant delete denial with victim row/chunk/vector integrity + no event**, own-tenant delete still works, untagged durable rows unreachable by every tenant (incl. `default`) and preserved on disk, refusals auditable via the kernel logger, and the K1 flag yielding the **isolated** default bucket only (a flagged tenant-less delete cannot touch A or B). |
| `packages/vector-search/test/s1-vector-tenant.test.ts` | 6 | Tenantless `embedAndSearch` refused **before** any embedding/search (no `VectorEvents.Searched`), blank tenant refused, unscoped raw `search` refused, no cross-tenant or untagged vector ever returned, a permissive caller `filter` cannot widen the tenant scope, and the documented residual (the `FlatIndex` primitive does not scope, which is why every product path goes through the module). |
| `packages/knowledge-graph/test/s1-graph-tenant-boundary.test.ts` | 9 | B-2: no `graph.store` in the container, no `store` property, no `default`/`''` bucket at boot, no store handle without an unambiguous tenant, all 14 sync + 3 async graph ops refuse tenantless, blank-tenant writes/reads refused, cross-tenant write invisibility, no tenantless "planting", persisted rows all carry non-blank tenant tags with tenant-prefixed composite ids, identical entity ids stay per-tenant. B-3 (genuine durable filesystem snapshots across two kernels): untagged **and** blank-tagged rows quarantined and invisible to every tenant incl. `default`, tagged rows still load, `quarantineReport()` counts/ids, WARN audit, `persist()` re-emits them verbatim (still untagged, content unchanged), attribution option rejects `default`/blank/non-string, and explicit `untaggedRowTenant` attribution is scoped, reported, audited and durably re-tagged. |
| `packages/knowledge-graph/test/s1-graph-event-trust.test.ts` | 13 | V-1: positive control (own ingest indexes in own tenant only), forged plain `bus.emit` refused (`unattested-source`), **attested forgery** with attacker tenant + foreign `docId` refused by scoped corroboration with zero metadata/title disclosure, payload/envelope tenant disagreement refused, missing/blank tenant refused, `system` tenant refused, missing/blank/nonexistent `docId` refused, replay idempotent and tenant-bound, legacy plain subscribers unaffected, the full `authorizeDocumentIngestedEvent` decision table, and graph-RAG refusing a tenantless call **before** any vector search while returning only own-tenant evidence. |
| `packages/agent-runtime/test/s1-tool-tenant.test.ts` | 37 | 30 refusal cases = 5 built-in tools × 6 bad contexts (`{}`, `''`, `'   '`, `null`, `42`, object), each with **poisoned** service/graph/vector deps proving *zero* data-plane calls, plus: no tool input schema mentions a tenant; foreign ids/tenants in tool input change nothing; per-tool cross-tenant isolation (search/traverse/findEntity/retrieve/vector.search); an agent loop run without tenant metadata receives a refusal (surfaced to the model, no data in the transcript); runs with A/B metadata see only their own tenant. |
| `packages/cli/test/s1-cli-tenant-boundary.test.ts` | 10 | V-2: real-module positive controls (incl. type-filtered listing), poisoned listing returning a foreign entity ⇒ dropped + audited, foreign-marked row dropped even when the lookup would corroborate the id, dependency without `getEntity` ⇒ everything dropped (fail-closed, audited reason), refusal before any listing for missing/blank/`default`/contradicting `--tenant`. B-4: `host:health`/`host:work`/`host:dlq` refused with exit 1 for missing, blank and reserved-`default` tenants **with `STORAGE_DRIVER` set to an impossible value, proving the refusal precedes any boot attempt** (no `failed to boot`, no `unknown driver`, empty stdout); a configured tenant reports exactly that tenant in `delivery.tenantId` and the outbox/inbox listings; `global_admin` remains opt-in and does not change the reported scope. |

Required-case matrix (§4) → 1 cross-tenant read ✓ · 2 cross-tenant write ✓ · 3 cross-tenant
delete ✓ · 4 undefined tenant ✓ · 5 mismatched tenant ✓ · 6 forged event ✓ · 7 foreign document
id ✓ · 8 untagged storage row ✓ · 9 default-tenant handle abuse ✓ · 10 entities enumeration ✓ ·
11 replay/manipulation ✓ (all 11 covered, plus blank/whitespace/non-string ambiguity cases).

Existing suites updated **only** where the contract they asserted was the vulnerability itself
(no test case deleted anywhere; assertion counts rose — see §7):

- `packages/cli/test/cli-tenant-isolation.test.ts` — the "unscoped `stats()` sees both tenants"
  proof was replaced by a stronger one: tenantless and blank `stats()` are **refused**, tenant B's
  scoped stats still see B's document, and the store total (A-scoped + B-scoped = 2) is still
  provably larger than the CLI's narrowed report.
- `packages/knowledge-graph/test/t06-knowledge-tenant-pg.test.ts` (real PostgreSQL) — three
  "an unscoped search sees both tenants" assertions became "an unscoped search is **refused**, and
  the union of the two tenant-scoped searches shows both tenants share the index".
- `packages/vector-search/test/vector.test.ts` — records are now tenant-tagged and every
  module-level search names its tenant (behaviour asserted is unchanged).

## 7. Audit record (diff, deleted lines, non-weakening)

- **Scope of the diff**: 16 modified + 6 new files, all inside `packages/{knowledge-service,
  vector-search,knowledge-graph,agent-runtime,cli}`, plus `README.md`, `.env.example` and this
  document. `git status` shows **no** change to `packages/storage-postgres` (RLS, tenant
  isolation, CAS/transactions), `packages/authentication`, `packages/cli/src/auth-config.ts`,
  `packages/core-kernel`, `.github/workflows/ci.yml`, or any lockfile.
- **Deleted-line review**: every deleted source line is one of the unsafe paths listed in §1
  (tenantless `stats()` global totals; tenantless `retrieve`/`getDocument`/`getChunk` "system-level
  read" branches; `deleteDocument` without tenant resolution; `ctxTenantId` returning `undefined`
  for "legacy unscoped behavior"; `get store()`; the `graph.store` container registration;
  `row.tenantId ?? DEFAULT_TENANT_ID`; `env.JATAQI_OPERATOR_TENANT ?? 'default'`; graph-RAG's
  "tenant-scoped **when given**" optionality). One stale doc-comment claim that `NODE_ENV=test`
  could authorize the fallback was deleted — it contradicted the code then and now; the two explicit
  flags remain the only authorizers.
- **No test case or assertion was weakened**: `it()` counts are identical (19/19, 19/19, 4/4) and
  `assert.*` counts rose (92→95, 35→35 with 6 new refusal assertions replacing 3 unscoped calls,
  110→113) in the three updated suites.
- **No fallback flag was restored or added**: the only source references are the pre-existing K1
  guard reads (`=== '1'`); no source file assigns them; the new suites assert they are unset, and
  the single K1-compatibility test that sets one restores it in a `finally` and asserts restoration.
- **No authentication, authorization, RLS, secrets, or network control was weakened**: no new
  `fetch`/`http`/`net`/`child_process` usage, no new environment read besides the existing
  operator-tenant variable, no credential or connection-string handling changed, no role or policy
  default loosened (`global_admin` still opt-in).
- **Lint**: `npm run lint` ⇒ **0 errors, 60 warnings**, all pre-existing style warnings
  (`@typescript-eslint/no-unused-vars`, `prefer-const`) in files this milestone did **not** modify —
  plus `knowledge-graph/src/graph-rag.ts:41 'vecs'`, verified byte-identical at the base commit
  `c45cfc1`. **Zero** warnings come from any new `s1-*` suite. The one warning this milestone
  transiently introduced (an unused `DEFAULT_TENANT_ID` import left behind by moving the guard into
  `tenant-context.ts`) was **removed**, not suppressed, so the final warning count is not higher
  than the base.

## 8. Regression record and B-6 / B-7 determinations

### 8.1 Full regression (clean build — every `packages/*/dist` removed first)

| Gate | Command | Result |
|---|---|---|
| Build (all workspaces, `src` **and** `test` compilations) | `npm run build` | **exit 0**, 0 TypeScript errors |
| Lint | `npm run lint` | **exit 0** — 0 errors (warnings are pre-existing style warnings; see §7) |
| Tests (all workspaces) | `npm test` | **exit 0** — `Total: 49 · Passed: 49 · Failed: 0 · Skipped: 0`; **924 tests, 924 pass, 0 fail, 0 skipped** |
| PostgreSQL honesty gate | `grep -ci 'SKIPPED: PostgreSQL integration'` over the full log | **0** — the PostgreSQL suites genuinely executed (embedded PostgreSQL really started; the log contains real server shutdown/connection-termination messages), so this run **is** PostgreSQL-verified |

Because `npm test` executes each workspace's compiled `dist/test/*.test.js`, the run was performed
after deleting every `dist` directory: a stale build artifact cannot execute a test that no longer
exists in source (an earlier, non-clean run in this cycle did surface one such phantom compiled
suite; the clean rebuild removed it and it does not exist in source or in `git` history).

Suites specifically required by the authorization: CLI ✓ (77 tests), knowledge-service ✓ (27),
knowledge-graph ✓ (47, incl. the real-PostgreSQL T-06 cross-tenant suite), storage/PostgreSQL ✓
(genuine, not skipped), vector-search ✓ (25), agent-runtime ✓ (47), tenant-isolation/security
suites ✓, unified-loop ✓, loop-host ✓.
### 8.2 B-6 — "Node 24 in CI" vs the requested Node 20 — **RESOLVED from primary CI evidence**

Evidence read from the CI job log of run **34048251273** (job `101527091000`, head `c45cfc1`,
conclusion `success`), retrieved through the GitHub API's signed log URL:

```text
2026-09-06T17:19:41.067Z Node 20 is being deprecated. This workflow is running with Node 24 by
  default. If you need to temporarily use Node 20, you can set the
  ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true environment variable. For more information see:
  https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
2026-09-06T17:19:42.097Z ##[group]Run actions/setup-node@v4
2026-09-06T17:19:42.097Z   node-version: 20
2026-09-06T17:19:42.243Z Attempting to download 20...
2026-09-06T17:19:42.943Z Acquiring 20.20.2 - x64 from https://github.com/actions/node-versions/...
2026-09-06T17:19:46.453Z ##[group]Environment details
2026-09-06T17:19:46.453Z node: v20.20.2
2026-09-06T17:19:46.454Z npm: 10.8.2
```

**Determination — two different runtimes, only one of them ours:**

| Runtime | Version observed | Who chooses it |
|---|---|---|
| GitHub Actions **action runtime** (executes `actions/checkout@v4`, `actions/setup-node@v4`) | **Node 24** | GitHub's platform. Node 20 was deprecated *for actions* on 2025-09-19; the banner is platform-wide and now appears in every workflow on hosted runners |
| **Repository build / lint / test runtime** (`npm ci`, `npm run build`, `npm run lint`, `npm test`) | **Node v20.20.2**, npm 10.8.2 | This repository: `ci.yml` pins `node-version: '20'`; root `engines: node >=20.0.0` |

So the "Node 24" observation is **explained, and it is not a repository-side decision**: the workflow
requested Node 20 and every build/lint/test step ran on Node **20.20.2**. There is **no mismatch to
fix**. No `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` workaround was added — that variable would only
pin the *platform's* action runtime back to a deprecated Node 20, has no bearing on this
repository's verification, and would be exactly the kind of CI-wide environment workaround this
milestone's governance forbids.

Also verified from the same log: runner image `ubuntu-24.04` (image version `20260831.293.1`, runner
`2.337.0`) — a second, unrelated source of a "24" in CI output; the checkout ref is
`refs/remotes/pull/20/merge` at `a8f4c3e` ("Merge c45cfc1… into 82af3de…"), i.e. **CI verifies the
merge result with canonical `main`, not the bare head**; and
`Workspace/lockfile consistency check passed (49 workspaces)`.

### 8.3 B-7 — Is the CI gate *required* for merging? — **DETERMINED: NO, it is advisory**

Read directly from the repository's rules API (not inferred from PR status):
`GET /repos/POWERBot-1/JATA-Qi/rules/branches/main` and `GET /repos/POWERBot-1/JATA-Qi/rulesets/20134880`:

```json
{ "id": 20134880, "name": "Jata Qi", "target": "branch", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [ { "type": "deletion" },
             { "type": "non_fast_forward" },
             { "type": "pull_request", "parameters": {
                 "required_approving_review_count": 0, "required_reviewers": [],
                 "require_code_owner_review": false, "require_last_push_approval": false,
                 "dismiss_stale_reviews_on_push": false,
                 "required_review_thread_resolution": true,
                 "allowed_merge_methods": ["merge", "squash", "rebase"] } } ],
  "current_user_can_bypass": "never" }
```

| Question | Answer (from the API response above) |
|---|---|
| **Required status checks** | **NONE.** The active ruleset has no `required_status_checks` rule, so the `CI` ("build · lint · test") check is **advisory only** |
| **Required branches** | the ruleset targets `refs/heads/main` only (include list; no excludes) |
| **Required approvals** | **0** approving reviews, no required reviewers, no code-owner review, no last-push approval; review **threads** must be resolved (`required_review_thread_resolution: true`) |
| **Rewrite / merge rules** | changes must arrive through a **pull request**; `merge`, `squash` and `rebase` are all allowed; branch **deletion** and **non-fast-forward** (force-push) are blocked |
| **Administrator / bypass** | `current_user_can_bypass: "never"` for this token, and no `bypass_actors` list is exposed to it. The **classic** branch-protection endpoint (`GET /branches/main/protection`) returns `403 Resource not accessible by integration` (admin-only), so classic settings cannot be read from here; the ruleset above is the active mechanism (created 2026-07-31, updated 2026-09-03) |
| **Can PR #20 merge while CI is red?** | **YES, technically.** Nothing in the active ruleset conditions merging on a check conclusion |

**Empirical corroboration of the prior "PR #19 merged despite a red gate" observation** (now
confirmed rather than suspected, from `GET /pulls/19` and `GET /commits/{sha}/check-runs`):

```text
PR #19 head  d221f6556d9822f722ea59bfb558f73392492829
  check run "build · lint · test":  status=completed   conclusion=FAILURE
    started   2026-09-06T12:33:05Z
    completed 2026-09-06T12:41:52Z
PR #19 merged_at        2026-09-06T12:55:06Z     ← 13 minutes AFTER that failure
PR #19 merge_commit_sha 82af3def9b8b26989b3f686369d17f03bb62ad9c   ← canonical main today
```

**Governance consequence:** in this repository a green CI run is *evidence*, never a *gate*. Merge
decisions must therefore be explicit and human/agent-authorized — which is precisely why this
milestone stops before merging and why the standing workflow requires an independent verification
plus explicit merge authorization.

### 8.4 GitHub access and sandbox-recreation note (transparency, affects provenance only)

An earlier attempt at this delivery was blocked because the sandbox's GitHub credential had expired:
`gh auth status` reported *"The github.com token in GH_TOKEN is no longer valid"*, every
`api.github.com` request returned `401 Bad credentials` (even with the `Authorization` header
stripped locally), and `git push` failed with *"could not read Username for 'https://github.com'"*.
Access was restored by reconnecting the integration in Arena; §8.2 and §8.3 were then derived from
live API reads (`gh auth status` now reports `Logged in to github.com as
arena-ai-coding-agent[bot] (GH_TOKEN)`).

During that outage the sandbox was also **recreated**, which destroyed the local git objects of the
first S-1 commit (`c2d13e4`) while leaving the worktree files intact. Recovery, and the proof that
nothing was lost or altered:

1. re-added the branch refspec and fetched `origin/arena/01a076d2-jata-qi` = `c45cfc1`
   (ancestry `c45cfc1 → 0cb6b6b → 82af3de`, 0 merge commits);
2. pointed the local branch back at `c45cfc1` with a **mixed** reset (worktree preserved — no
   `--hard`, no `clean`);
3. `git status` then listed **exactly the 25 S-1 paths** — which simultaneously proves every T-09
   and R-1/R-4 file in the worktree is byte-identical to `c45cfc1`;
4. `git diff --cached --numstat` totals **2705 insertions / 149 deletions across 25 files**,
   identical to the lost commit's recorded diffstat;
5. `npm ci` (exit 0), then the **full clean regression was re-run on the restored tree** with the
   same result as before the recreation: build exit 0, lint exit 0 (0 errors, 60 warnings),
   `Total: 49 · Passed: 49 · Failed: 0 · Skipped: 0`, 924/924 tests, `SKIPPED: PostgreSQL
   integration` count 0.

The S-1 commit was therefore recreated with identical **content**; only its SHA differs (commit
timestamps are part of the object hash and cannot be reproduced). This is a provenance note, not a
code difference.

### 8.5 Status

Implementation, adversarial tests, full regression (twice: before and after the sandbox recreation),
the diff/deleted-line/non-weakening audit, and the B-6/B-7 determinations are **complete**. The
milestone is pushed to `origin/arena/01a076d2-jata-qi` and reported on PR #20; the CI run for the
pushed commit is recorded there. Canonical `main` (`82af3de`) is untouched, PR #20 remains
**OPEN and UNMERGED**, and T-10 is not started. **STOP** — this branch now awaits a fresh
independent read-only verification (fresh clone, independently derived evidence) and an explicit
merge authorization. No merge is proposed, attempted, or authorized here.
