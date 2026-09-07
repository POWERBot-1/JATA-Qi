# R2 Phase 0 — DESIGN FREEZE: Durable Distributed Security State

**Status:** FROZEN. Implementation must follow this document. Any deviation
requires a design amendment with explicit rationale before code changes.

**Canonical baseline:** `0db2f36340966df2d49adb304f54a59341494aae` (R1 CLOSED).
**Authoritative store:** PostgreSQL is the SOLE authoritative
SecurityStateStore. Redis is NOT part of R2 (seam rule only, §11).

---

## 0. Non-negotiable rules

1. **Fail closed.** Any operation requiring authoritative security state
   MUST deny when that state cannot be read, validated, or
   transactionally updated. New machine-readable reason:
   `SECURITY_STATE_UNAVAILABLE` (added to the closed `A01DenialReason`
   set). Never fall back to MemoryDriver, process-local Maps, assumed
   zero usage, assumed unrevoked credentials/sessions, or assumed unused
   envelopes. Never convert storage failure into ALLOW.
2. **No silent authority.** No restart, crash, process fan-out, migration,
   GC pass, or deployment may create, restore, widen, or extend security
   authority.
3. **Tenant isolation.** Every security-state record carries `tenantId`
   unless explicitly defined as system-scoped (§6). All tenant-scoped
   security-state operations run inside explicit tenant-scoped
   transactions (`StorageModule.atomically(fn, { tenantId })` or
   `beginTransaction({ tenantId })`). No unscoped security-state read API
   is exported. RLS + `FORCE ROW LEVEL SECURITY` + `SET LOCAL
   app.tenant_id` + driver guards + application checks are all preserved.
4. **No secrets at rest.** Durable security state carries bindings,
   fingerprints, and references only. Credential material, token
   material, and raw secrets MUST NOT be persisted, logged, or audited.
   Repository layers enforce closed field allow-lists (same technique as
   `StorageAuditSink.ALLOWED_AUDIT_FIELDS`).
5. **R1 preservation.** All 1082 R1 tests keep passing unmodified in
   meaning. The synchronous in-memory gate path is preserved bit-for-bit
   for compositions WITHOUT a store; it MUST NOT become a bypass when a
   store IS attached (§B).

---

## A. Rate limiting — durable fixed-window counter

**Decision: fixed windows.** No concrete security/correctness reason was
found to require token-bucket semantics; fixed windows are simpler,
race-safe under CAS, and strictly stronger than the current sliding
in-memory windows for cross-process correctness.

- **Key:** `id = sha256hex("v1:" + tenantId + "\0" + principalId + "\0" +
  capabilityId + "\0" + windowStart)` — deterministic, tenant-scoped,
  collision-safe. `windowStart = floor(now / windowMs) * windowMs` using
  the manifest's `windowMs`.
- **Row (S-6 `authorization.rate-windows`):**
  `{ id, tenantId, principalId, capabilityId, windowStart, windowMs,
  count, createdAt, updatedAt }`.
- **Semantics:** `decideAsync` increments-then-checks inside the decision
  transaction: `count` after increment `<= max` ⇒ within budget. Every
  `decideAsync` call with a non-empty (capabilityId, tenantId,
  principalId) triple increments, including DENY decisions (matches R1:
  denied attempts are load too). Increment uses single-document CAS
  (`SELECT … FOR UPDATE` on Postgres; first-create
  `ON CONFLICT DO NOTHING` election) with bounded retry (8 attempts,
  mirroring `WorkQueue.enqueue`); exhaustion ⇒ DENY
  `SECURITY_STATE_UNAVAILABLE` (fail closed, never assume zero usage).
- **Retention:** a window row is eligible for GC only when
  `windowStart + windowMs < now - GC_GRACE` with
  `GC_GRACE = 1h` (covers clock skew + in-flight decisions). GC deletes
  in bounded batches, audited per batch. See §G.
- **Unavailable store ⇒ DENY** with `SECURITY_STATE_UNAVAILABLE`
  (distinguishable from `RATE_LIMIT_EXCEEDED` for alerting).

## B. Authorization API — asynchronous authoritative path

**Decision: introduce `decideAsync()`; sync `decide()` fails closed when
a store is attached.**

- New authoritative flow:
  `decideAsync(request)` → durable manifest read (system scope, §6) →
  tenant transaction { rate increment → pure PDP `decideA01` (unchanged)
  → DECISION audit write } → sealed envelope citing
  `manifestId + manifestDigest + sessionReference + securityStoreTxId`.
- `executeAuthorized` keeps its single entry point but branches on store
  presence: with a store it runs the **enforcement transaction** (§13);
  without a store it runs the exact R1 in-memory path. One enforcement
  entry point ⇒ no bypass confusion.
- **Sync `decide()` when a store is attached throws
  `AuthorizationDeniedError(['SECURITY_STATE_UNAVAILABLE'])`** — a sync
  API cannot consult durable state, so it MUST NOT render production
  decisions. This mirrors the existing audit-failure throw precedent.
- Callers updated to branch: `autonomous-action-runtime` (`execute`),
  `agent-runtime` (`renderToolEnvelope`, made async). Both keep sync
  behavior when the gate has no store (R1 tests unaffected).
- The pure PDP `decideA01` is UNCHANGED (all 16 checks, default deny).
  Durable inputs (manifest row, rate count, session status) are resolved
  by the gate before/around the PDP call; the PDP's `rateWindowUsage`
  probe is fed the post-increment count minus one (identical semantics
  to R1: `usage >= max ⇒ RATE_LIMIT_EXCEEDED`).

## C. Credential ID reuse — permanent identity, no silent rebind

**Decision: a credential ID is a permanent, never-rebound identity.**

- S-2 `authorization.credentials` rows are insert-once; `issue` against
  an existing ID (any status) is rejected with
  `CREDENTIAL_BINDING_MISMATCH` (same code as the R1 in-memory duplicate
  rejection — no behavior change for the collision case).
- No versioned supersession in R2. Rotation = issue new ID + revoke old
  ID. History rows are never deleted (revocation evidence is permanent).
- Rationale: silent rebinding would let a stale envelope referencing an
  old ID acquire a new credential's material. Permanent identity makes
  this structurally impossible.

## D. Session migration — fail closed, re-authentication required

**Decision: unknown pre-R2 `authenticationEventId`s are INVALID.**

- S-8 `authentication.events` starts empty at migration. Dispatch and
  gate session validation treat a missing event row as
  revoked/unknown ⇒ `PRINCIPAL_REVOKED` hold/deny (umbrella code;
  detail strings differentiate revoked / expired / unknown for ops).
- **Availability impact (documented):** in-flight work items enqueued
  before R2 carry snapshots whose event IDs have no durable row; on
  first post-migration dispatch they HOLD with `PRINCIPAL_REVOKED`
  (detail: `session-unknown`) and require fresh authenticated enqueue.
  Operators MUST drain or re-enqueue during the migration window. This
  is the honest fail-closed posture: pre-R2 sessions are unverifiable
  by construction (no durable event ever existed).
- Kernel-internal (`KERNEL_INTERNAL`, `kie-…`) principals are NOT
  sessions: they bypass S-8 and continue to verify via the per-process
  `KernelInternalIdentity` + `verifyKernelPrincipal`, exactly as in R1.

## E. Rate/budget migration — honest empty start

**Decision: S-6/S-7 start empty (zero usage). No fabricated history.**

- Post-migration, every (tenant, principal, capability) window and every
  (tenant, principal, run) budget starts at zero usage — the only honest
  state, since pre-R2 usage is unknowable.
- **Migration boundary (documented):** this constitutes a one-time fresh
  quota grant bounded to a single window/lifetime. It CANNOT grant
  authority beyond what a brand-new principal receives, and it cannot
  restore consumed/revoked/exhausted state (there is none to restore —
  S-4/S-5 start empty-deny … see below).
- S-4/S-5 start empty-**deny**: no consumed envelope exists (nothing was
  consumed under R2 — correct), and no idempotency receipt exists
  (duplicates re-execute exactly once, then are recorded — correct,
  since no R2 execution has occurred). Fail-closed semantics preserved:
  uncertainty never produces ALLOW; it produces first-execution, which
  is the correct semantics for a new ledger.

## F. Secondary indexes — reviewed declaration seam

**Decision: hot enforcement paths are PRIMARY-KEY lookups; a reviewed
index seam covers operational/GC queries.**

- S-1..S-9 document IDs are deterministic (§A/C + §5), so every
  enforcement read is a PK `get`/`cas` — no secondary index on the hot
  path (stated explicitly to simplify the security argument).
- New seam: `PostgresDriver.ensureJsonIndex(logicalCollection, def)` +
  optional `IStorageDriver.ensureIndex?(...)` (backward compatible;
  memory driver leaves it undefined). Index def:
  `{ name, keys: [{ field, opclass? }], includeTenant: boolean }`
  generating deterministic
  `CREATE INDEX IF NOT EXISTS … ON … ((body->>'k1'), …)` (+
  `tenant_id` leading column when `includeTenant`). Names are
  deterministic (`{table}_{name}`); creation is idempotent and
  concurrent-boot safe (`IF NOT EXISTS` + duplicate_object tolerance).
- Indexes are **performance-only**: they never bypass RLS (policies
  apply regardless), never authorize, and are verified present (via
  `pg_indexes`) in tests. Initial indexes: S-1 by
  `(capabilityId, status)` for rotation queries; S-8 by
  `(principalId)` + `(status)` for revocation/audit queries; S-5/S-4 by
  `(status/leaseExpiry, updatedAt)` for GC scans; S-10 by
  `(envelopeId)` for reconciliation.
- Manifest ACTIVE pointer: to keep even manifest reads PK-based, S-1
  maintains a pointer row `id = {capabilityId}::ACTIVE →
  { activeVersion, manifestId }`, updated in the same transaction as
  rotation. Enforcement: pointer PK-get → manifest PK-get → digest
  match against the decision-cited digest.

## G. Retention / GC — explicit, conservative, audited

**Decision: retention floors + grace + batch-audited purge. GC NEVER
deletes state that can still affect authorization, dispute,
reconciliation, replay protection, or recovery.**

| Collection | Eligible for GC only when | Floor |
|---|---|---|
| S-4 consumed-envelopes | `consumedAt < now - RETENTION` | `RETENTION = 30d` (≫ any manifest `maxLifetimeMs` + skew; enforced: retention floor is validated `>= maxManifestLifetime + skew` at GC construction) |
| S-5 idempotency COMPLETED/FAILED | `updatedAt < now - RETENTION` | `COMPLETED: 30d` (dispute window), `FAILED: 7d` |
| S-5 idempotency IN_PROGRESS | **never time-GC'd**; reclaimed on access past lease expiry (T-13 pattern); orphan sweep only marks `EXPIRED` via CAS after `leaseExpiry + 24h`, never deletes | — |
| S-6 rate-windows | `windowStart + windowMs < now - 1h` | 1h grace |
| S-7 run-budgets | `updatedAt < now - 30d` (run-lifetime evidence) | 30d |
| S-2/S-8 revoked/expired | **never deleted** (permanent revocation evidence, §C) | ∞ |
| S-1 SUPERSEDED manifests | **never deleted** (policy history) | ∞ |

- GC runs as an explicit, audited substrate operation attributed to a
  `kernel:maintenance` principal (per-batch audit rows); it is NOT
  envelope-authorized (S-* collections are substrate-private, §13 —
  the store is below the enforcement layer, and envelopes authorize
  actions, not substrate maintenance). GC deletes in bounded batches
  (default 500 rows) inside tenant-scoped transactions.
- Safety interlock: GC refuses to run when ANY manifest's
  `maxLifetimeMs + skew` exceeds the S-4 retention (fail closed:
  throw, delete nothing).

## H. Authentication-event writer — single path, write-before-trust

**Decision: `PrincipalBoundary.authenticate()` is the SOLE writer.**

- On successful verification, the boundary durably inserts the S-8 row
  (insert-if-absent by event ID; CAS) BEFORE returning the principal.
  Row: `{ id: eventId, tenantId, principalId, method, verifiedAt,
  expiresAt, status: ACTIVE }`. `expiresAt = min(methodSessionLifetime,
  tokenExpiresAt?)`; default method session lifetime 24h
  (`DEFAULT_SESSION_LIFETIME_MS = 86_400_000`, configurable per
  boundary, upper-bounded by 30d mirroring T-02).
- **Write failure ⇒ `authenticate()` throws `UnauthenticatedRequestError`
  (fail closed).** No principal is returned without its durable event.
- No other component writes S-8 (single writer ⇒ no conflicting
  issuance semantics). Revocation/expiry flips are CAS status
  transitions via the repository (`revokeEvent`, expiry evaluated on
  read + lazily flippable).
- When NO event store is configured, the boundary behaves exactly as R1
  (ephemeral event IDs, no durability) — R1 tests unaffected.

---

## 5. Authoritative collections (schemas)

All documents carry `{ id, tenantId, createdAt, updatedAt }` (RLS +
driver guards apply). Field allow-lists reject unknown fields and any
material-shaped field (`material`, `secret*`, `token` values,
`password`, `privateKey`) at the repository layer. All IDs
deterministic as specified (PK hot paths).

- **S-1 `authorization.manifests`**: version rows
  `id = {capabilityId}::{version}` +
  pointer rows `id = {capabilityId}::ACTIVE`.
  Version row: `{ …, capabilityId, version, manifest (full frozen
  A01CapabilityManifest), manifestDigest (sha256 canonical),
  registeredBy { principalId, tenantId, authenticationEventId },
  supersedes: manifestId|null, status: ACTIVE|SUPERSEDED }`.
  Tenant: owning tenant, or `system` for `allowTenantWildcard`
  manifests (explicit system scope, §6). Immutable once written
  (repository refuses updates except the ACTIVE→SUPERSEDED flip, which
  is CAS-guarded and content-preserving).
- **S-2 `authorization.credentials`**: `{ …, principalId,
  capabilityId, tool, operation, audience, scopes[], issuedAt,
  expiresAt, issuedBy { principalId, authenticationEventId },
  status: ACTIVE|REVOKED|EXPIRED, revokedAt?, revocationReason? }`.
  **NO material field.**
- **S-3 `authorization.credential-uses`**:
  `id = {credentialId}::{envelopeId}` →
  `{ …, credentialId, envelopeId, acquiredAt }`. Insert-if-absent =
  single-use proof; conflict ⇒ `CREDENTIAL_REPLAY`.
- **S-4 `authorization.consumed-envelopes`**: `id = envelopeId` →
  `{ …, decisionId, consumedAt, consumedBy { principalId, runId } }`.
  Non-READ enforcement = insert-if-absent in the enforcement tx;
  conflict ⇒ `REPLAYED_AUTHORIZATION`.
- **S-5 `authorization.idempotency`**:
  `id = {tenantId}::{key}` (hash-qualified per §A8-style; tenant in
  body AND id) → `{ …, key, status: IN_PROGRESS|COMPLETED|FAILED|
  EXPIRED, resultRef? { decisionId, envelopeId, actionId?, completedAt },
  leaseToken?, leaseExpiry?, attempts }`. Claim = insert-if-absent
  IN_PROGRESS+lease; duplicate while live ⇒ `IDEMPOTENCY_CONFLICT`
  (new closed reason); COMPLETED ⇒ return referenced receipt
  (re-fetched, never cached objects); FAILED ⇒ allow re-execution
  after CAS reclaim (new attempt, audited); reclaim requires lease
  token match (unguessable `randomUUID`, T-13 pattern).
- **S-6 `authorization.rate-windows`**: §A.
- **S-7 `authorization.run-budgets`**:
  `id = {tenantId}::{principalId}::{runId}` →
  `{ …, capabilityId, ceiling (pinned from ACTIVE manifest at first
  consume), manifestId, used }`. CAS read-check-increment in
  enforcement tx; `used+cost > ceiling ⇒ BUDGET_EXHAUSTED`.
- **S-8 `authentication.events`**: §H +
  `{ revokedAt?, revocationReason? }`. Status transitions
  ACTIVE→REVOKED (CAS, operator/system) ; EXPIRED evaluated on read
  (`now + SKEW >= expiresAt`, conservative §8-clock) with lazy
  CAS flip (best-effort, non-blocking).
- **S-9 `authentication.token-registry`**:
  `id = sha256hex(material)` (fingerprint; NEVER material) →
  `{ …, principalId, roles[], status: ACTIVE|REVOKED, expiresAt? }`.
  One-way seed import from `JATAQI_AUTH_PRINCIPALS` file at operator
  invocation (`importStaticTokens`, idempotent CAS); post-import, file
  edits have NO effect without explicit re-import (documented, audited).
- **S-10 `authorization.decisions`** (extended): existing rows +
  optional `manifestId?, manifestDigest?, sessionEventId?,
  sessionStatus?, securityStoreTxId?`. `ALLOWED_AUDIT_FIELDS` extended
  accordingly. DECISION written in the decide tx; CONSUMED written in
  the post-side-effect receipt tx (§13). CONSUMED-consistency
  reconciliation query documented for ops (DECISION w/o CONSUMED).

**Clock-skew policy (§8):** `R2_SKEW_MS = 300_000` (T-02 precedent).
All durable-path expiry comparisons are conservative (deny-early):
`expired ⟺ now + SKEW >= expiresAt` for credentials, sessions, and
envelope freshness in `decideAsync`/durable enforcement. Sync R1 path
semantics are UNCHANGED (no skew adjustment — R1 tests bit-identical).

---

## 6. Tenant isolation

- S-2..S-9 + S-10 rows are tenant-scoped; accessed ONLY in
  tenant-scoped transactions. Repository constructors REQUIRE a tenant
  binding per operation (no ambient tenant, no unscoped read export).
- S-1 rows: tenant-owned (`tenantId` = owner) or explicit system scope
  (`tenantId = 'system'`, ONLY when `allowTenantWildcard: true`).
  Manifest READS run in explicit narrow system-scope transactions
  (documented exception: policy lookup is inherently cross-tenant; PDP
  tenant checks `TENANT_OUT_OF_SCOPE`/`TENANT_SUBSTITUTION` still
  apply per decision on top). Manifest WRITES (seed/rotate) run in
  system scope with verified-registrar attribution + audit.
- `'*'` system RLS scope is never returned as a tenant context; tenant
  charset validation reuses `StorageModule.validateTenantId` (no
  re-implementation).
- Cross-tenant attempts (credential/session/envelope/idempotency) are
  refused at THREE layers: repository tenant predicate, driver guard,
  RLS. Tests assert refusal at the store layer independently of the PDP
  (defense in depth).

## 7. Manifest authority

- Deterministic identity (`capId::version` + ACTIVE pointer), immutable
  history, ACTIVE/SUPERSEDED, monotonic narrowing enforced by the
  EXISTING `isNarrowing` check executed INSIDE the registration
  transaction against the row-locked current ACTIVE row (CAS) ⇒
  concurrent conflicting registrations serialize; losers get
  `ManifestRejectedError`, never silent divergence.
- Boot seed: code-defined manifests (incl. kernel-worker specs via
  dual-writing `establishKernelWorkerAuthority`) upsert idempotently
  (CAS insert-if-absent per version + pointer CAS); digest compare
  detects code/store divergence ⇒ **abort boot (throw in module init)**
  unless an approved rotation record exists. Rotation procedure:
  explicit versioned registration (narrowing-checked) + pointer CAS —
  audited, never silent.
- `AUTHORIZATION_MANIFESTS_TOKEN`: **SEALED** (binding immutable).
  It continues to expose the gate's in-memory registry (dev/test sync
  path + diagnostics); the durable repository is exposed via a NEW
  sealed token `AUTHORIZATION_SECURITY_STORE_TOKEN`. Rationale for
  seal-over-remove: removal would break the R1 `has()` contract test;
  sealing eliminates substitution while preserving compatibility.
  Durable-path decisions NEVER consult the in-memory registry.

## 8. Credential authority

Lifecycle `ISSUE → ACTIVE → REVOKED | EXPIRED` per §5/S-2/S-3.
Durable issuance/revocation/use audit rows (new audit kinds on S-10?
No — S-10 kinds stay DECISION/CONSUMED; broker mutations are audited
via dedicated rows in S-2/S-3/S-8 history + a new
`authorization.credential-audit` collection? **Decision: reuse S-10
with two new kinds `CREDENTIAL_ISSUED`, `CREDENTIAL_REVOKED`** —
keeps one audit surface; kind allow-list extended; GC-exempt like all
S-10 rows). Material provider seam: `CredentialMaterialProvider`
interface (`getMaterial(credentialId, envelopeId)`) with an in-memory
dev/test implementation; production KMS/HSM OUT OF SCOPE (interface
only). The durable broker (`DurableCredentialBroker`) validates
bindings against S-2 + S-3 inside the enforcement tx and fetches
material ONLY at acquire time via the provider.

## 9. Session authority

Per §H + S-8. Gate `decideAsync` validates non-kernel
`authenticationEventId`s (ACTIVE + unexpired-conservative) inside the
decision tx; loop-host dispatch re-validates post-`authorizeDispatch`
(HELD with `PRINCIPAL_REVOKED` on revoked/expired/unknown).
`PRINCIPAL_REVOKED` is added to BOTH `A01DenialReason` (gate) and
`AuthorityHoldReason` (host) closed sets (+ `AUTHORITY_HELD_REASONS`,
so operator resume refuses it — resume must not launder revocation).

## 10–11. Replay + idempotency

Per §5/S-4/S-5. Exactly-once semantics via PK insert-if-absent inside
the enforcement transaction. New closed reason `IDEMPOTENCY_CONFLICT`
for live-lease duplicates. No process-local result caching on the
durable path (G-2 `idempotencyCache` is NOT consulted when a store is
attached; retained for the R1 sync path only).

## 12. Rate + budget

Per §A + S-6/S-7. Restart MUST NOT restore quota (durable counters;
§E documents only the one-time migration boundary).

## 13. Enforcement transaction (the central objective)

**Honest two-transaction design** (the external side effect cannot join
a DB tx — §13 of the authorization explicitly forbids pretending
otherwise):

- **Tx-1 (pre-side-effect, tenant-scoped):** enforcement-lock
  re-validations (credential ACTIVE via no-op CAS — takes the row
  lock, serializing concurrent revokes; session ACTIVE via no-op CAS;
  cited-manifest digest match via system-scope PK reads),
  S-4 insert-if-absent (non-READ), S-3 insert-if-absent (credential
  path), S-7 CAS consume, S-5 claim IN_PROGRESS + lease (idempotency
  path). Any conflict ⇒ DENY with the specific machine-readable code.
  Commit ⇒ authorization to invoke the side effect exactly once.
- **Side effect** runs OUTSIDE any tx (documented boundary).
- **Tx-2 (post-side-effect, tenant-scoped):** S-5 → COMPLETED with
  receipt ref (or FAILED on error, audited) + CONSUMED audit row.
  Crash between Tx-1 commit and Tx-2 ⇒ orphan IN_PROGRESS/DECISION
  rows ⇒ recovered via lease reclaim + reconciliation queries
  (documented ops runbook; tested).
- Enforcement-lock semantics (non-retroactivity, documented):
  a revoke/rotation that commits BEFORE Tx-1's re-validation ⇒ DENY;
  one that arrives DURING Tx-1 waits on the row lock, then commits
  after ⇒ the already-authorized side effect stands (revocation is
  never retroactive — standard, explicit, tested).
- Retry: serialization (`40001`) / deadlock (`40P01`) ⇒ bounded retry
  (3 attempts, 5→25ms backoff), then DENY
  `SECURITY_STATE_UNAVAILABLE`. Lock-timeout (`55P03`) ⇒ immediate
  DENY (fail fast). Retry counter exposed for perf evidence (§20).

## 14. Concurrency

Proven CAS/row-lock patterns ONLY (`PostgresCollection.cas`,
`atomically`). Statement + lock timeouts: new driver config
`statementTimeoutMs` (default 10_000), `lockTimeoutMs` (default
5_000), applied via `SET LOCAL` in `beginTransaction` (never global
pool state). Protected by CAS/PK-uniqueness: envelope consumption,
credential use, idempotency claim/reclaim, manifest registration +
pointer swing, rate/budget counters, session + credential revocation
flips. `MemoryDriver`/`FsDriver` are REFUSED as SecurityStateStores:
repository construction over a non-transactional driver throws at
init (fail closed, R-8j); `supportsTransactions()` is the gate.

## 15. Adjacent races

- **T-15 `planAction` dedup:** implement deterministic-ID
  (`sha256("v1:"+tenantId+"\0"+idempotencyKey)`) CAS insert-if-absent
  election mirroring `WorkQueue.enqueue` (query-hit fast path kept;
  race path added; loser returns winner). IN SCOPE.
- **T-18 human-approval vote sequencing:** implement per-tenant CAS
  counter (`human-approval.vote-seq`, mirroring capability-fabric
  `audit-seq`) replacing query-max+put. IN SCOPE.
- **R-8c action lifecycle transitions — DESIGN REVIEW VERDICT: R2b
  (OUT OF SCOPE, STOP before implementing).** Rationale: converting
  `startAction`/`reportActionResult`/`verifyAction`/`retryAction` to
  CAS requires restructuring ledger + event emission ordering
  (money-adjacent `ACTION_QUEUED/RESULT/VERIFIED` ledger chain +
  `recordEvent` side writes currently interleave reads and puts across
  four methods). The SECURITY consequence (duplicate external
  execution from double-start) IS closed by R2's S-5 gate-level
  idempotency (same-attempt races collapse to one winner +
  `IDEMPOTENCY_CONFLICT`); what remains is status/ledger consistency
  under races — correctness, not authorization. Expanding R2 to
  re-architect the control-plane write path would materially expand
  scope (ledger atomicity design + money-ledger migration review).
  R2b design note will be filed with R2 evidence; R2b needs its own
  audit→authorization cycle.

## 16–17. Restart / boot reconciliation

Covered by §5–§7 + §13 (restart safety matrix) and module init order:
store reachability → schema/collection verify → index ensure →
manifest seed + divergence check → invariant verify → expose paths.
Any failure ⇒ init throws ⇒ boot aborts (no silent fallback).

## 18–19. Tests + adversarial matrix

Per authorization §§18–19 (20 adversarial cases, machine-readable
codes, real PG, multi-process via the `two-process` worker pattern,
no skips/`.only`/TODOs/bypasses). R2 PG tests FAIL (not skip) when
no PostgreSQL is available — a skipped durability test is a false
pass. (Pre-R2 suites keep their skip convention untouched.)

## 20. Performance

**Latency budget (set BEFORE final verification):** on local embedded
PG, single client: `decideAsync` p99 ≤ 250ms; durable
`executeAuthorized` (Tx-1 + Tx-2, excluding side-effect runtime) p99
≤ 500ms; 32-way contention on one counter: all-correct + p99 ≤ 2s
with retry rate recorded. Budgets are generous-by-design (local PG);
correctness is never sacrificed for latency. Evidence records
p50/p95/p99 + contention latency + retry frequency for R1-sync vs
R2-durable.

## 21–22. Secrets + evidence

`scripts/scan-secrets.mjs` (dependency-free): pattern + entropy scan
of repo + committed artifacts (allowlisted fixtures only); DB-row
scan implemented as tests (dump S-*/S-10 rows post-adversarial-run,
assert no issued material/token appears, assert field allow-lists).
Evidence pack under `docs/verification/R2_*` with executed /
reconstructed / design / unavailable clearly separated.

---

## Amendment log

| # | Date | Change | Rationale |
|---|---|---|---|
| 0 | 2026-09-07 | Initial freeze | R2 authorization §§1–26 |
