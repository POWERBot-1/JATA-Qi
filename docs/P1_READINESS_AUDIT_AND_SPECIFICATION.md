# P1 READINESS AUDIT & IMPLEMENTATION SPECIFICATION — ENFORCED PRODUCTION SECURITY COMPOSITION

> **Status:** READ-ONLY AUDIT + IMPLEMENTATION SPECIFICATION. Documentation only.
> **This document authorizes NOTHING.** Implementation, commit, push, PR, merge,
> P2–P7, R3, and 120% work all remain NOT AUTHORIZED. It is input to a future,
> separate, explicit P1 implementation authorization issued by the human owner.
>
> Audited tree: canonical `main` `10fc9baffbc432eb1ec92cec9cd1f4c86d810a64`
> (working tree clean except uncommitted governance/audit documents; no source,
> tests, dependencies, package configuration, CI, runtime configuration,
> infrastructure, or database schemas/migrations were modified by this audit).
>
> This document supersedes and completes the interrupted draft of the same name.

| Field | Value |
| --- | --- |
| Record type | P1 readiness audit + implementation specification (documentation-only) |
| Date of record | 2026-09-08 |
| Mode | STRICTLY READ-ONLY AUDIT + IMPLEMENTATION SPECIFICATION |
| Canonical main | `10fc9baffbc432eb1ec92cec9cd1f4c86d810a64` |
| Rubric | `JATA-P0-95-v1.1` (authoritative; adoption commit `36f0026573074466e701db722e7f1cd91333d667`, branch `arena/01a07e0c-jata-qi`, unmerged) |
| P0 | ASSURANCE PROCESS CLOSED — RELEASE GATES UNSATISFIED |
| G10 | OPEN — UNATTRIBUTABLE CANONICAL CI FAILURE (run `34162894915`, job `101868167969`, step "Test (all workspaces)", `npm test`) |
| G19 | UNRECOVERED — HISTORICAL F3–F12 SOURCE UNAVAILABLE |
| P1 IMPLEMENTATION | NOT AUTHORIZED |
| COMMIT / PUSH / PR / MERGE | NOT AUTHORIZED |
| P2 / P3 / P4 / P5 / P6 / P7 / 120% | NOT AUTHORIZED |

---

## Method and evidence classes

Every finding is grounded in source at `10fc9ba` (file paths cited) or in the
repository's own evidence records (`docs/verification/R2_IMPLEMENTATION_EVIDENCE.md`,
`docs/verification/r2-adversarial-matrix.md`, `docs/verification/R2_*`,
`docs/A01_AUTHORIZATION_BOUNDARY.md`, `docs/R2_DESIGN_FREEZE.md`). Documentation
claims are never counted as implementation evidence (rubric V3: inspection ≠ runtime
verification). **No test, build, migration, or deployment was executed by this
audit**; test references cite the repository's recorded evidence packs, not new runs.

Evidence classes distinguished throughout, per the directive:

| Class | Meaning in this document |
| --- | --- |
| **SOURCE** | Source-code inspection at `10fc9ba` (mechanism present at a cited location). Never production proof. |
| **TEST** | Implementer-produced repo test suites recorded as passing at `10fc9ba` (fail-hard real PostgreSQL; 0 skipped). |
| **INTEGRATED** | Multi-package composition exercised within repo tests (e.g. gate + storage-postgres + loop-host). |
| **IND. VERIFICATION** | Independent (separate-party) verification pass recorded in `docs/verification/` (exists for R2 scope: PASS WITH NON-BLOCKING FINDINGS F1–F12). |
| **PRODUCTION-LIKE** | Evidence under a production posture/composition. **None exists — the production posture itself does not exist at `10fc9ba`.** |
| **PRODUCTION** | Evidence from an actual production deployment. **None exists.** |

Qualifiers used exactly as mandated: **PROVEN / PARTIALLY PROVEN / UNVERIFIED /
MISSING / EXTERNAL DEPENDENCY**.

---

## 1. EXECUTIVE VERDICT

| Item | Determination |
| --- | --- |
| Canonical SHA | `10fc9baffbc432eb1ec92cec9cd1f4c86d810a64` (verified: HEAD of the audited tree; merge of PR #24, 2026-09-07) |
| P0 status | ASSURANCE PROCESS CLOSED; RELEASE GATES UNSATISFIED |
| Current frozen score | **9.484375%** (evidence-qualified baseline, `JATA-P0-95-v1.1`) |
| Capability index | **44.375/100** |
| Integration-adjusted capability | **36.6875/100** |
| Sensitivity range | **6.6484375–14.875** |
| Stretch | **0/20** |
| Production | **NOT READY** |
| G10 | **OPEN — UNATTRIBUTABLE CANONICAL CI FAILURE** (not reopened, not resolved, not reinterpreted by this audit) |
| G19 | **UNRECOVERED — HISTORICAL F3–F12 SOURCE UNAVAILABLE** (not reconstructed by this audit) |
| P1 objective | Convert JATA Qi's security architecture from **partially optional/configurable posture** into an **enforced production-security composition**: durable security state mandatory, durable sessions mandatory, production-safe storage/providers required, tenant isolation and RLS posture boot-verified, configuration invariants enforced, fail-closed behavior preserved under outage, with adversarial/restart/multi-process evidence — **without** absorbing P2+ (identity provider implementation) or the wider 95% program |
| Final P1 readiness classification | **A — P1 READY FOR EXPLICIT IMPLEMENTATION AUTHORIZATION** (§24; "A" does NOT authorize implementation) |

**Verdict in one paragraph.** JATA Qi's security architecture is library-strong but
composition-optional. The A-01 authorization boundary is genuinely mandatory, sealed,
and kernel-invariant-checked at every boot. The R2 durable security substrate
(S-1…S-10) is well-designed and proven fail-closed under real PostgreSQL — but
**nothing in any shipped composition enables it**; no environment variable reaches
it; the default boots on the `memory` driver with process-local replay/rate/budget
state, no durable sessions, a plaintext bearer-token file as the only real
authentication method, and an in-memory credential-material provider that draws only
a `logger.warn`. P1's work is precisely the conversion of these advisory distinctions
into enforced boot invariants (INV-01…INV-16, §12). **No future P1 credit is awarded
by this document**; the frozen baseline remains 9.484375%.

## 2. CURRENT P1 READINESS

### 2.1 Prerequisite assessment

| # | P1 prerequisite | Qualifier | Basis (evidence classes) |
| --- | --- | --- | --- |
| 1 | Mandatory authorization boundary (composition-invariant, sealed, boot-aborting) | **PROVEN** | SOURCE (`bootstrap.ts`, `module.ts`, `core-kernel/security-invariants.ts`) + TEST (`r1-composition-boundary.test.ts`: absent/uninitialized/unsealed/substitution/redeclaration) + INTEGRATED |
| 2 | Durable security substrate S-1…S-10 (mechanisms) | **PROVEN** | SOURCE (`security-state-store.ts`, `durable-decider.ts`, `consumption-stores.ts`, `credential-store.ts`) + TEST (64 R2 tests, 20-case adversarial matrix, 8-/32-process contention, restart) + IND. VERIFICATION (R2: PASS WITH NON-BLOCKING FINDINGS; F1/F2 remediated + re-verified) |
| 3 | Durable security substrate **enabled by a shipped composition** | **MISSING** | SOURCE: repo-wide zero non-test references to `durableSecurity` outside `packages/authorization-boundary/src`; no env path (this audit) |
| 4 | Durable sessions / token registry (mechanisms) | **PROVEN** | SOURCE + TEST (`r2-durable-sessions.test.ts`, R2-A01–A05) |
| 5 | Durable sessions **wired into shipped compositions** (incl. CLI authenticator registry attachment) | **MISSING** | SOURCE: `auth-config.ts` constructs `StaticTokenAuthenticator` without the S-9 registry; no composition sets `durableSessions` |
| 6 | Production credential-material provider (KMS/HSM) | **MISSING** (interface **PROVEN**, implementation absent by design) | SOURCE: `CredentialMaterialProvider` seam + in-memory dev provider only |
| 7 | Fail-closed security-state availability chain (outage → `SECURITY_STATE_UNAVAILABLE`, no memory fallback) | **PROVEN** | SOURCE + TEST (R2-A06; `r2-pool-outage.test.ts` mutation-checked) + IND. VERIFICATION (F1 remediation) |
| 8 | PostgreSQL RLS tenant isolation (mechanisms) | **PROVEN** | SOURCE (`tenant-isolation.ts`, `tenant-context.ts`) + TEST (t01/t06 incl. non-superuser enforcement suite) |
| 9 | Production RLS posture (roles, FORCE verification, provisioning) | **UNVERIFIED** → **MISSING** (no verification/provisioning exists) | SOURCE: no role provisioning or boot probe anywhere; "documented activation requirement" only |
| 10 | FORCE ROW LEVEL SECURITY runtime guarantee | **UNVERIFIED** | SOURCE: DDL error swallowed (`.catch(() => undefined)`, `tenant-isolation.ts:127`) — cannot be proven at runtime |
| 11 | Production/test authentication policy separation | **PROVEN** | SOURCE (`authentication-policy.ts`, `auth-config.ts`) + TEST (t03-boundary) — double opt-in for test authority; `system` role refused at ingress |
| 12 | Production identity provider (OIDC/OAuth/SSO/SAML/MFA/step-up) | **MISSING — EXTERNAL DEPENDENCY (P2 by design)** | SOURCE: interface vocabulary only (`types.ts`); no implementation |
| 13 | Production storage driver (PostgreSQL) | **PROVEN** (driver) / **MISSING** (mandatory-selection invariant) | SOURCE + TEST (P-01, T-06, R2 suites); default remains `memory` with warn-only |
| 14 | Configuration/manifest lifetime validation | **PARTIALLY PROVEN** | Registration validates `maxLifetimeMs > 0` (TEST) but accepts values ≤ the 300s skew bound that can never execute (R2-OBS-01) |
| 15 | Key-management / secret-hygiene controls | **PARTIALLY PROVEN** | Secret scan PROVEN (SOURCE+TEST: `r2-secret-scan`, closed schemas, fingerprinting); production key management **MISSING** |
| 16 | Adversarial/concurrency/restart evidence (existing scope) | **PROVEN** for R2 scope | TEST packs + adversarial matrix; **PRODUCTION-LIKE: none** (no production posture exists) |
| 17 | Independent verification (P1 scope) | **MISSING** | No P1-scope independent verification exists (by definition — P1 not implemented) |
| 18 | Operational enablement (retention/GC execution, health surfacing, runbook) | **PARTIALLY PROVEN** | GC + floors + S-4 interlock PROVEN (SOURCE+TEST); nothing schedules/runs it in production; no runbook |
| 19 | Production database role provisioning (ops) | **EXTERNAL DEPENDENCY** | Owner/ops action; P1 supplies the contract + reviewed script (§8) |
| 20 | Production secret/KMS provider selection (ops) | **EXTERNAL DEPENDENCY** | Owner decision D2; P1 supplies the contract (§9) |

### 2.2 Evidence-class matrix (explicit)

| Evidence class | Exists at `10fc9ba` for P1-relevant controls? |
| --- | --- |
| Source evidence | **YES** — extensive (this document cites it per finding) |
| Test evidence | **YES** — for the mechanisms (R2/A-01 packs; 242 suites, 1151/1151 recorded at PR #24 head) |
| Integrated evidence | **YES** — multi-package durable suites (gate + storage-postgres + authentication + loop-host) |
| Independent verification | **YES, R2 scope only** (R2 record: PASS WITH NON-BLOCKING FINDINGS; F1/F2 fixed + re-verified). **NO** for any production composition (none exists) |
| Production-like evidence | **NO** — the production posture itself is not implemented |
| Actual production evidence | **NO** — no production deployment exists or is claimed |

**Source inspection is never treated as production proof anywhere in this document.**

## 3. PRODUCTION SECURITY COMPOSITION

### 3.1 Component audit

| Component | Finding (class) |
| --- | --- |
| `createJataQi(cfg)` (`packages/cli/src/bootstrap.ts`) | Registers ~50 modules; `AuthorizationBoundaryModule` **unconditionally** + `requireAuthorizationBoundary(kernel)` immediately after. Forwards `cfg.authorization` verbatim. **No production posture exists.** (SOURCE + TEST) |
| `createJataQiFromEnv` | Resolves storage driver, authentication posture, LLM from env; forwards `overrides.authorization`. **No env key can enable durable security.** (SOURCE) |
| `AuthorizationBoundaryModule` | Durable substrate opened BEFORE the gate (born on final path; no post-hoc attachment); sealed tokens; boot order: reachability → indexes → rotation approvals → seed + divergence → mirror → gate; any failure aborts boot. `durableSecurity` default **absent ⇒ false ⇒ exact R1 behavior**. `materialProvider` absent ⇒ in-memory provider + `logger.warn`. `durableAudit` default true (durable sink over whatever driver is configured — `memory` under default config). (SOURCE + TEST) |
| `AuthorizationGate` | Single PDP+PEP (`decide`/`decideAsync` → sealed envelope → `executeAuthorized` re-verifies integrity/decision/freshness/binding before the side effect). With a store attached, sync `decide()` THROWS and the DurableDecider is the only path. Without a store, the R1 in-memory path runs (process-local Sets/Maps — §4.3). (SOURCE + TEST) |
| `AuthenticationModule` | Always registered; `durableSessions.enabled` default off; when on, S-8/S-9 open over storage (non-transactional ⇒ throw), every successful authentication recorded BEFORE the principal is returned, record failure rejects authentication. **No shipped composition enables it.** (SOURCE + TEST) |
| `StorageModule` | Driver selection: `memory` (default) / `filesystem` (dev-only, warn) / instance injection (`postgres` via CLI resolution, fail-closed on missing config). `supportsTransactions()` false for memory/fs. Tenant validation + tenant-scoped `atomically`. (SOURCE + TEST) |
| `durableSecurity` | Opt-in config object; **the single most important P1 gap** — see §3.2 case A. |
| `durableSessions` | Opt-in; see §3.2 case F. |
| Credential provider | `CredentialMaterialProvider` seam; in-memory dev implementation only; production = KMS/HSM contract (§9). |
| Storage driver selection | `resolveStorageDriver` (`packages/cli/src/storage-driver.ts`): `postgres` → dynamic import, `requireExplicitConfig: true` ⇒ `PostgresConfigError` on missing connection config (never silent localhost); connection-string redaction helper for logs. |
| Production/test authentication policy | `resolveAuthenticationPolicy`: `production` default admits `STATIC_TOKEN/OIDC/MTLS`; `DETERMINISTIC_TEST` requires mode `test-only` **AND** `allowTestMethod:true` (two deliberate acts; production + allowTestMethod ⇒ throw). `KERNEL_INTERNAL` never admissible at ingress. `system` role refused from external credentials. (SOURCE + TEST) |
| Default configuration | `STORAGE_DRIVER=memory`, `JATAQI_AUTH_MODE=none` (admits nothing), `AGENT_LLM=echo`, `durableSecurity` unreachable, `durableSessions` off. |
| Fallback behavior | **None permissive exists on the durable path**: no MemoryDriver fallback, no process-local fallback, no permissive retry (bounded serialization/deadlock retry then deny; 55P03 immediate deny). Development path intentionally falls back to R1 in-memory semantics — which is the composition problem P1 solves. |
| Fail-closed behavior | Extensive and proven (§3.2 cases B–F; §10). |
| `requireDurableStorage` | Loop-host runtime guard (`packages/loop-host/src/runtime.ts`): supervised host refuses to run unattended on non-durable state (`NonDurableStorageError`) unless `--allow-non-durable-storage`. CLI-level, host-scope only — not a composition invariant. (SOURCE + TEST) |
| `--allow-non-durable-storage` | Explicit escape hatch on the host command (`host-command.ts`); must remain development-only and be **refused under production posture** (INV-03). |
| Loop host | Opt-in (`loopHost.enabled`), starts IDLE; leased dispatch; dispatch re-validates sessions when a session store is attached (HELD `PRINCIPAL_REVOKED`); principal-snapshot freshness horizon; test-authority refusal derived from authentication posture. |
| Protected ingress | `WorkIngress` (T-03): presented credential → PrincipalBoundary → verified principal → durable work; no fallback principal; caller tenant must equal authenticated tenant. With `JATAQI_AUTH_MODE=none` (default) **every ingress request fails closed** — honest secure-by-denial. |

### 3.2 Expected vs actual enforcement (mandated cases A–H)

| Case | Condition | EXPECTED | ACTUAL at `10fc9ba` | Verdict |
| --- | --- | --- | --- | --- |
| **A** | `durableSecurity=false`/absent in production | BOOT FAILURE | **Boots silently.** Exact R1 path: process-local replay/idempotency/rate/budget state; in-memory manifests/audit over `memory`. No production posture exists to detect the condition. | **NOT ENFORCED — P1-GAP-01/02 (CRITICAL)** |
| **B** | PostgreSQL unavailable, durable security enabled | BOOT FAILURE / FAIL CLOSED | **ENFORCED.** `SecurityStateStore.open` (reachability, indexes, approvals, seed+divergence) throws ⇒ module init fails ⇒ boot aborts. (SOURCE + TEST) | **ENFORCED (when enabled)** |
| **C** | Non-transactional driver with durable security enabled | BOOT FAILURE | **ENFORCED.** `SecurityStateStore.open` throws `SecurityStateUnavailableError` on `!supportsTransactions()` ("a non-transactional store is never authoritative security state"); `AuthenticationEventStore.open` and `TokenRegistryStore.open` throw identically for sessions/tokens. (SOURCE + TEST) | **ENFORCED (when enabled)** |
| **D** | Security-state initialization failure (indexes/approvals/seed divergence) | BOOT FAILURE | **ENFORCED.** Any `open()` failure aborts init; seed divergence without an approved rotation record ⇒ `ManifestDivergenceError` boot abort (R2-A11/A12). (SOURCE + TEST) | **ENFORCED (when enabled)** |
| **E** | Credential material unavailable | DENY / FAIL CLOSED | Runtime: **ENFORCED** — broker/provider failures deny before the side effect (`CREDENTIAL_*`, `CREDENTIAL_BROKER_UNAVAILABLE`); "unavailable broker" is never "no credential required". Boot: **NOT ENFORCED** — absent production provider ⇒ in-memory dev provider + `logger.warn` (GAP-03). | **PARTIAL — runtime yes, boot no** |
| **F** | Durable sessions cannot persist | DENY / FAIL CLOSED | With `durableSessions` on: **ENFORCED** — non-transactional store ⇒ open throws (boot); record failure mid-authentication ⇒ `PrincipalValidationError`, no principal (R2-A03); dispatch re-check ⇒ HOLD `PRINCIPAL_REVOKED`; store outage at dispatch ⇒ throw. Default composition: durable sessions off entirely (**NOT WIRED — GAP-04**). | **ENFORCED (when enabled), NOT WIRED by default** |
| **G** | RLS posture cannot be verified | BOOT FAILURE / FAIL CLOSED | **NOT ENFORCED.** No runtime verification of RLS/FORCE/role posture exists anywhere; FORCE DDL error swallowed (GAP-06); no role provisioning (GAP-05). | **NOT ENFORCED — P1-GAP-05/06/08** |
| **H** | Required production security providers absent | BOOT FAILURE or protected traffic permanently DENIED | Split: (i) **Absent authenticator ⇒ protected traffic permanently DENIED — ENFORCED** (mode `none` default; no authenticator can verify; workers without verified principals ⇒ `MISSING_PRINCIPAL` deny; unbound connectors ⇒ `UNBOUND_CONNECTOR`). (ii) **Absent production credential provider ⇒ NOT ENFORCED** (warn + dev provider). | **PARTIAL — secure-by-denial for identity; configuration NOT rejected for providers (GAP-03)** |

### 3.3 Secure-by-denial vs configuration-rejected (explicit)

- **Secure only because the protected operation is denied (secure-by-denial):**
  default ingress with no authenticator (every request fails closed); worker external
  execution without verified principals; unbound connectors; sync `decide()` on the
  durable path; sessions under store outage. These are honest and fail-closed, but
  they are **availability postures, not production composition guarantees** — the
  configuration that produces them is not itself rejected, and a later
  misconfiguration can widen them.
- **Configuration itself rejected (boot failure):** durable-security-enabled +
  PG-unreachable; durable-security-enabled + non-transactional driver; security-state
  init failure; manifest divergence. These are genuine composition guarantees —
  **but only on the opt-in durable path**.
- **Neither (the P1 problem):** production can boot with durable security disabled,
  `memory` storage, no durable sessions, a dev credential provider, and unverified
  RLS — silently, with warnings only. **P1 exists to move every item in this third
  column into the second column (or, for identity, keep it permanently in the first
  with the configuration explicitly recorded).**

---

## 4. AUTHORIZATION BOUNDARY

### 4.1 Control audit

| Control | Finding (class) |
| --- | --- |
| `AuthorizationBoundaryModule` | Mandatory at the shipped composition root; sealed bindings; boot-order guarantees; invariant-checked. **PROVEN** (SOURCE+TEST+IND. for R1 scope) |
| `AuthorizationGate` | Single PDP+PEP checkpoint; `executeAuthorized` re-verifies sealed envelope (integrity, ALLOW, freshness, tool/operation/target binding) BEFORE any side effect; replay/idempotency/budget/credential enforced at the same point; default deny; closed reason-code set. **PROVEN** |
| PDP/PEP separation | `decideA01` (pure policy decision point, ordered fail-closed pipeline: structure→principal→tenant→agent/run→capability→tool/operation→target→classification/impact→approval→credential→budget→rate→discretionary engine→audit) vs the gate/`DurableDecider` (enforcement point that renders AND enforces). A discretionary engine that throws or is ambiguous ⇒ DENY (`POLICY_ENGINE_UNAVAILABLE`/`AMBIGUOUS_POLICY_RESULT`). **PROVEN** |
| `DurableDecider` | The ONLY decision path when a store is attached: Tx-1 {rate → session → credential preload → pure PDP → audit + S-10} → sealed envelope with durable citations (manifestId+digest, sessionEventId, securityStoreTxId); execution: citation check → live manifest digest match → session re-check → S-4/S-5/S-7/S-3 → side effect with heartbeat → Tx-2 completion. **PROVEN** |
| Capability manifests | Registration validation (no wildcards, non-empty allow-lists, ceilings, scope shape); S-1 durable immutable version rows + ACTIVE pointers + rotation approvals; divergence abort. **PROVEN** |
| Monotonic narrowing | A new version may never widen operations/targets/tenants/classification/impact/rate/budget/lifetime or drop approval/credential requirements (`capability-manifests.ts` narrowing check). **PROVEN** (adversarial 16) |
| Rotation approvals | Attributed approval rows required before a non-seed version becomes ACTIVE; concurrent rotation: exactly 1 winner of 4 contenders (R2-A10). **PROVEN** |
| Manifest divergence detection | Boot compares composed seeds to durable ACTIVE policy; same version + different bytes, or new version without approval ⇒ `ManifestDivergenceError`, boot aborts (R2-A11/A12). **PROVEN** |
| Credential broker | R1: `CredentialBroker` interface + in-memory reference (fail-closed). R2: `DurableCredentialBroker` — S-2 binding rows (closed schema, never material), S-3 single-use proofs, permanent never-rebound credential IDs, revocation permanent history. **PROVEN** |
| Credential bindings | principal/tenant/capability/tool/operation/audience/scopes/lifetime; verdict order mirrored exactly between decide-time and enforcement re-check (single shared `checkCredentialRow`). **PROVEN** |
| Replay protection | Durable: S-4 consumed envelopes, exactly-once, 8-process contention proven (R2-A16). R1 default: process-local `Set` — **process-local authority** (§4.3). |
| Idempotency | Durable: S-5 lease (`leaseNonce`) + heartbeat + COMPLETED receipt; in-flight duplicate ⇒ `IDEMPOTENCY_CONFLICT` (R2-A17). R1 default: `Map` cache. |
| Rate limits | Durable: S-6 fixed windows shared across 32 processes, exactly-max ALLOW. R1 default: in-memory windows. |
| Execution budgets | Durable: S-7 pinned per-run budget. R1 default: in-memory Map. |
| Decision persistence | S-10 `authorization.decisions`, privacy-safe closed field set; the durable decision-audit write is AWAITED before the side effect (`AUDIT_UNAVAILABLE` fail-closed). R1 default: sinks write over whatever driver is configured (`memory` ⇒ process-local). |
| Audit availability | Throwing sink ⇒ `AUDIT_UNAVAILABLE` (an unauditable ALLOW does not exist); failed durable write latches and fails subsequent executions closed. **PROVEN** |
| Kernel/internal identity | Per-process HMAC-verifiable `KernelInternalIdentity`; closed scope set; no `kernel:*` wildcard; minted only by the composition root; forged/foreign KERNEL_INTERNAL principals fail verification. Kernel workers get narrow one-tool manifests (deliberate tenant wildcard for platform workers, documented). **PROVEN** |
| Protected ingress | T-03 `WorkIngress`: boundary-authenticated principal required; tenant consistency enforced; no fallback principal/SYSTEM actor. **PROVEN** |

### 4.2 Controls authoritative ONLY when `durableSecurity.enabled=true`

Manifest authority (S-1), credential bindings + single-use proofs (S-2/S-3), replay
exactly-once (S-4), idempotency leases (S-5), rate windows (S-6), run budgets (S-7),
durable decision audit (S-10), session re-check at decide AND execute, citation
verification (manifest digest match at execution), rotation approvals, divergence
detection, and the `SECURITY_STATE_UNAVAILABLE` outage chain. **Every one of these is
dormant in the default composition.**

### 4.3 Remaining R1 process-local security authority (exhaustive)

When no store is attached (the default at `10fc9ba`), the following security state is
process-local (`gate.ts` fields) and resets on restart / fans out per process:

1. `consumedEnvelopes: Set<string>` — replay protection;
2. `idempotencyCache: Map<string, unknown>` — idempotent duplicate detection;
3. `rateWindows: Map<string, RateWindowState>` — rate limiting;
4. `runBudgets: Map<string, number>` — execution budgets;
5. in-memory `CapabilityManifestRegistry` — the only manifest authority (bootstrap
   mirror, no divergence detection);
6. `InMemoryCredentialBroker` (when no durable broker) — credential bindings,
   revocation, single-use proofs;
7. `InMemoryAuditSink` (when `durableAudit:false`, or "durable" over the `memory`
   driver) — decision/consumed audit;
8. envelope integrity = **unkeyed SHA-256 digest** — tamper-evidence only, no origin
   authenticity (durable path compensates by re-verifying citations against the DB;
   R1 path does not);
9. kernel identity HMAC secret — process-local **by design** (acceptable: in-process
   verification only, narrow scopes, not transferable authority).

Items 1–7 are the security authority P1 must make impossible in production posture
(INV-02/INV-13; criterion C).

---

## 5. TENANT ISOLATION

### 5.1 Source present vs production enforcement proven

| Control | Source present | Production enforcement proven |
| --- | --- | --- |
| Tenant context (envelope-authoritative; caller metadata never trusted; `TENANT_SUBSTITUTION`; `IDENTITY_CONFLICT`) | YES (`policy-engine.ts`, agent-runtime) | YES at TEST/INTEGRATED class (adversarial 3/38); production-like: N/A (no posture) |
| `StorageModule.validateTenantId` (charset-bound; blank/unsafe refused) | YES | YES (TEST) |
| Transaction tenant binding (`atomically(fn,{tenantId})` ⇒ `BEGIN`+`SET LOCAL app.tenant_id`; reverts on commit/rollback) | YES | YES (TEST, t01/t06) |
| `PostgresCollection` tenant binding (tenant-stamped writes, tenant-predicated reads) | YES | YES (TEST) |
| CAS tenant clash check (cross-tenant CAS refused at the driver BEFORE store predicates run — R2-OBS-02) | YES | YES (TEST A02/A15) — PASS / DEFENSE IN DEPTH |
| PostgreSQL RLS (`ENABLE ROW LEVEL SECURITY` + `USING`/`WITH CHECK` policy `tenant_id = current_setting('app.tenant_id', true) OR current_setting(...) = '*'`) | YES | YES at TEST class **only** (suites create their own non-superuser role to prove enforcement); **production role/privilege posture NOT proven** |
| Unset-GUC blindness (session without tenant context sees/writes NO rows) | YES | YES (TEST) |
| **FORCE ROW LEVEL SECURITY** | YES (DDL issued) | **NO — the DDL error is swallowed** (`.catch(() => undefined)`, `tenant-isolation.ts:127`); FORCE cannot be asserted at runtime ⇒ owner bypass unverifiable |
| `app.tenant_id` GUC + `SET LOCAL` scoping | YES | YES (TEST) |
| Pool behavior (per-session `SET app.tenant_id='*'` on connect; `SET LOCAL` overrides per transaction; SET failure swallowed — GUC then unset ⇒ blind, fail-closed direction) | YES | PARTIAL (mechanism tested; the ambient `'*'` default itself is the production risk, §8) |
| System scope `'*'` (sees/writes all rows; not a valid tenant id; tenant API refuses it) | YES (intentional) | Broad-by-design; requires strict operational controls + minimization (INV-15) |
| Database ownership (owner bypasses RLS unless FORCE) | RISK acknowledged in source comment | **NOT proven / NOT governed** — no role separation exists (P1-GAP-05) |
| BYPASSRLS / superuser | Source documents that RLS does not apply | **NOT prevented** — no boot check; production role contract missing (P1-GAP-05) |
| Cache isolation (R1 gate Maps tenant-keyed per process; in-memory audit sink; knowledge/vector/graph dev caches tenant-scoped) | YES | PARTIAL — per-process isolation only; documented dev-only caches |
| Memory isolation (no cross-tenant in-memory sharing found; actor/tenant carried in sealed state) | YES | YES at TEST class |
| Knowledge / vector / graph isolation (tenant-bound retrieval; execution tenant authoritative; read-only B-paths) | YES | YES at TEST class; documented in the A/B inventory |
| Commercial state isolation (tenant-scoped collections/ledgers; tenant predicates + RLS) | YES | YES at TEST class (T-06/T-07 suites) |
| Cross-tenant authorization (decision pipeline tenant equality + manifest `tenantScopes`) | YES | YES (TEST) |
| Cross-tenant CAS | Refused at driver layer + store predicates | YES (TEST, R2-OBS-02) |

### 5.2 The FORCE RLS swallowed-error issue (explicit record)

`ensureTenantIsolation` (`packages/storage-postgres/src/tenant-isolation.ts:124–127`)
issues `ALTER TABLE … FORCE ROW LEVEL SECURITY` with `.catch(() => undefined)`.
**Security implication:** without FORCE, the table OWNER bypasses RLS entirely, and
production deployments typically own their tables; because the error is swallowed, a
database where FORCE failed (privileges, managed-PG restrictions, migration races)
cannot be distinguished from one where it succeeded. The strict policy may be
present yet **ineffective for the owner role**. This is not an attacker-facing
bypass in the test harness (tests verify with a non-superuser role), but it makes
the production owner-bypass posture **unverifiable at runtime** — unacceptable for
an enforced production composition. P1 requires: fail-closed DDL for
security-relevant statements + the INV-08/INV-10 boot probe asserting
`relforcerowsecurity` on every security table. **Do not assume an application role
is safe merely because tests use one** — the tests prove the mechanism; they do not
prove any production role's configuration.

---

## 6. DURABLE SECURITY STATE

Classification vocabulary: **authoritative** (durable, transactional source of
truth) / **process-local** / **cache** / **derived** / **bootstrap** / **external**.
Per-item survival under: restart (R), multi-process (MP), node loss (NL), concurrent
access (CA), failover (F); plus corruption behavior (X) and recovery/reconciliation
(RC). Ratings given for the DEFAULT composition and for the DURABLE-ENABLED
composition.

| Item | Default comp. | Durable-enabled | R / MP / NL / CA / F (durable) | Corruption (X) & recovery (RC) |
| --- | --- | --- | --- | --- |
| S-1 manifests | bootstrap mirror (in-memory) | **authoritative** (immutable versions, ACTIVE pointers, approvals) | survives all; CA: rotation exactly-1-winner (R2-A10) | X: divergence ⇒ boot abort (R2-A11/A12); closed schema rejects unknown/material fields; RC: operator rotation procedure |
| S-2 credentials | process-local (in-memory broker) | **authoritative** (binding rows) | survives all; CA: issue/verify transactional | X: malformed row ⇒ deny (fail-closed); IDs never rebound (collision ⇒ error); RC: re-issue under new ID after revocation |
| S-3 credential uses | process-local | **authoritative** (insert-if-absent single-use proofs) | survives all; CA: single-use proven | X: duplicate insert impossible (PK); RC: none needed |
| S-4 consumed envelopes | **process-local Set** | **authoritative** (exactly-once) | R: replay window reopens (default) / closed (durable); MP: 8-process exactly-once; NL: safe (durable); CA: proven | X: malformed ⇒ deny; GC retention floor 30d + interlock (GC refuses if S-4 trips); RC: retention GC |
| S-5 idempotency | **process-local Map** | **authoritative** (lease + heartbeat + COMPLETED receipt) | R: durable; MP: in-flight duplicate ⇒ `IDEMPOTENCY_CONFLICT`; NL: orphan lease → EXPIRED after grace (never deleted); CA: proven | X: malformed ⇒ deny; RC: orphan marking + GC |
| S-6 rate windows | **process-local Map** | **authoritative** (fixed windows) | R/MP: 32-process exactly-max; NL: durable; CA: proven | X: malformed ⇒ deny (fail-closed, never zero-usage); RC: window GC |
| S-7 run budgets | **process-local Map** | **authoritative** (pinned budget) | durable across all; CA: proven (`BUDGET_EXHAUSTED`) | X: deny; RC: retention GC |
| S-8 authentication events (sessions) | none (not persisted) | **authoritative** (record-before-principal; deny-early expiry 300s skew) | durable; MP: revocation visible cross-process; CA: session re-check at decide+execute (R2-A19) | X: malformed row ⇒ deny (`assessSessionRow`); RC: expiry sweep |
| S-9 token registry | **process-local plaintext table** (CLI constructor table) | **authoritative** (SHA-256 fingerprints; no material) | durable; MP: revocation/rotation visible without restart | X: fingerprint collision with different binding ⇒ refused (no silent rebind); RC: revoke/re-import |
| S-10 authorization decisions | "durable" over configured driver ⇒ `memory` ⇒ process-local | **authoritative** (closed schema; awaited before side effect) | durable; CA: exactly the committed receipt | X: schema-restricted; audit failure ⇒ `AUDIT_UNAVAILABLE` fail-closed; RC: none (append-only) |
| Sessions (as authority objects) | absent | authoritative (S-8) | see S-8 | see S-8 |
| Approvals (A-01) | request-carried, digest-bound + CCP durable records | same (unchanged by R2) | durable with the storage driver | X: digest mismatch ⇒ `APPROVAL_MISMATCH`; RC: re-approval |
| Kernel identity | **bootstrap** (per-process HMAC secret) — by design | same (intentional) | R: fresh identity (narrow, in-process only); MP: per-process; NL: n/a | X: not applicable; RC: n/a |
| Process-local mirrors (gate in-memory manifest mirror, in-memory audit sink) | **cache/diagnostic only** | mirror retained for binding checks + diagnostics ONLY (durable decisions never consult it — structural) | n/a (cache) | X: divergence impossible on the decision path; RC: mirror rebuilt at boot from ACTIVE |
| R1 authorization state (Sets/Maps of §4.3) | **the only authority** (process-local) | unused (structural: `decide()` throws) | R/MP/NL/F: **broken** (resets/fans out) | X: n/a; RC: none — this is why INV-02 exists |
| Vector/knowledge caches | dev caches (filesystem/memory), tenant-scoped | same | R: dev snapshot restore; MP: single-process by design | X: cache miss ⇒ rebuild; RC: documented dev-only |

**Node loss / failover summary (durable path):** in-flight Tx-1 rolls back (no
partial authority); S-5 orphan leases marked EXPIRED after grace, never deleted;
F1 keeps the host alive through pool outages with all decisions failing closed; a
pre-outage ALLOW envelope executes NO effect during the outage. **On the default
path, node loss and restart simply erase replay/rate/budget/idempotency state.**

---

## 7. IDENTITY AND SECURITY BOUNDARY

### 7.1 Existing mechanisms

| Mechanism | Finding (class) |
| --- | --- |
| `PrincipalBoundary` | Fail-closed enforcement wrapper: policy admission checked BEFORE any authenticator; independent validation of authenticator output; no SYSTEM/anonymous/default principal; never persists by itself. **PROVEN** |
| `AuthenticatorRegistry` | Duplicate-id refusal; method dispatch; per-credential failures distinguishable from structural rejection. **PROVEN** |
| Authentication policy | Production/test postures; double opt-in for test authority; `KERNEL_INTERNAL` never admissible at ingress; frozen `describe()` for audit. **PROVEN** |
| Static-token authenticator | Opaque-token → principal mapping; **documented development/staging scope, NOT production**; R2 S-9 option (registry-based verification) exists but the shipped CLI path constructs it WITHOUT the registry (`auth-config.ts:246`) ⇒ revocation invisible cross-process. **PARTIALLY PROVEN** |
| Deterministic test authenticator | Test infrastructure; double opt-in; never production default. **PROVEN (as test infra)** |
| Durable session store (S-8) | Record-before-principal; bounded lifetime `(0,30d]`; deny-early expiry; ACTIVE/EXPIRED/REVOKED; dispatch re-validation (HELD `PRINCIPAL_REVOKED`). **PROVEN (mechanism), NOT WIRED** |
| Token registry (S-9) | SHA-256 fingerprints; no material persisted (closed schema + pattern guard); revoke by fingerprint/principal; import idempotent, rebind refused. **PROVEN (mechanism), NOT WIRED into CLI verification** |
| Token revocation | `revokeByFingerprint` / `revokeByPrincipal` (compromise path). **PROVEN (mechanism)** |
| Principal snapshots (T-02) | Durable, freshness horizon at dispatch; re-verified actor derivation. **PROVEN** |
| Session freshness | Deny-early skew 300s shared with R2 (asserted at open). **PROVEN** |
| Token freshness | Expiry checked on every verification (table + registry paths). **PROVEN** |

### 7.2 Missing capabilities (explicit)

**OIDC — MISSING. OAuth — MISSING. SSO — MISSING. SAML — MISSING. MFA — MISSING.
Step-up authentication — MISSING. Enrollment — MISSING. Account recovery — MISSING.
Deprovisioning — MISSING (only `revokeByPrincipal` primitive). Identity lifecycle —
MISSING. Privileged identity management — MISSING. Session rotation — MISSING.
Token rotation — MISSING (revocation exists; rotation does not). Production
identity provider — MISSING (interface vocabulary only).** All are **P2 scope by
design**; none blocks P1, because P1 keeps protected ingress closed
(secure-by-denial) until P2 supplies a real provider.

### 7.3 P1/P2 boundary (mandated)

**P1 (contracts and composition only):**
- define production identity interfaces/contracts (production `ServerAuthenticator`
  requirements: signature verification, issuer/audience validation, replay
  resistance, clock policy, fail-closed errors);
- define the session lifecycle contract (S-8 semantics; production wiring; freshness
  rules) — the contract, not new semantics;
- define the step-up authorization contract (interface sketch: high-impact manifests
  may require a step-up assertion; boundary challenge hook) — contract only;
- define production composition invariants (INV-01…INV-16);
- ensure protected authorization can depend on those contracts (the gate consumes
  verified principals; no P1 control may depend on an identity provider existing).

**P2 (implementation — NOT authorized, NOT started):**
- complete OIDC/OAuth/SSO/SAML; MFA; privileged identity plane; lifecycle;
  recovery; deprovisioning; production identity integrations.

**Do NOT implement P2.** Any P1 slice that finds itself implementing an identity
provider has breached the scope boundary.


---

## 8. POSTGRESQL / RLS

### 8.1 Audit

| Aspect | Finding (class) |
| --- | --- |
| RLS creation | `ensureTenantIsolation` on every collection table at open: `tenant_id` column (idempotent `ADD COLUMN IF NOT EXISTS`), legacy backfill, tenant index, `ENABLE ROW LEVEL SECURITY`, strict policy, FORCE; multi-process first-boot tolerant (42710 ⇒ already-present for policy/index). **PROVEN (mechanism, TEST)** |
| FORCE RLS | DDL issued; **error swallowed** — see §5.2. Explicit: **FORCE RLS errors are currently swallowed.** |
| `USING` predicate | `tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = '*'` — tenant-equality OR explicit system marker. **PROVEN (TEST)** |
| `WITH CHECK` predicate | Identical expression — cross-tenant writes fail the check (fail-closed). **PROVEN (TEST)** |
| `app.tenant_id` GUC | Per-transaction via `set_config(..., true)` (`SET LOCAL` semantics — reverts on commit/rollback); parameterized, tenant charset-bound; `'*'` refused by the tenant API. **PROVEN (TEST)** |
| Connection pool behavior | Pool 'connect' handler sets session-level `app.tenant_id='*'` (ambient system scope — §5); SET failure swallowed (falls back to unset ⇒ blind, fail-closed direction); `SET LOCAL` inside transactions overrides per-tx with no bleed. |
| Transaction boundaries | `beginTransaction({tenantId})` = `BEGIN` → scope → `SET LOCAL statement_timeout` (default 10s) + `SET LOCAL lock_timeout` (default 5s) → work → `COMMIT`/`ROLLBACK`; F1 health notes on begin/commit. **PROVEN (TEST)** |
| System scope | Intentionally broad (`'*'` sees/writes all rows) for pre-tenant lookups (S-1 policy read, S-9 fingerprint lookup) and unscoped driver operations; **therefore requires strict operational controls** — P1 minimizes it (INV-15). |
| Ownership | Owner bypasses RLS unless FORCE; FORCE unverifiable today (swallowed). **Risk recorded (RLS-R5).** |
| BYPASSRLS / superuser | **Can defeat RLS entirely.** Not detected, not prevented at boot today. **Explicit: superuser/BYPASSRLS can defeat RLS.** |
| Role provisioning | **None exists.** No role creation, no grants, no verification. **Explicit: production role/privilege posture is not yet proven.** |
| Privileges | Single connection role from env; no least-privilege model. |
| CAS | `SELECT … FOR UPDATE` row-lock inside one transaction; tenant-bound CAS checks cross-tenant clash BEFORE guard predicates; standalone CAS owns its transaction; tx-participating CAS defers lifecycle to the outer transaction. **PROVEN (TEST incl. 8-process contention)** |
| Locking | Row locks bounded by `lock_timeout`; 55P03 ⇒ immediate deny. **PROVEN (TEST)** |
| Retry behavior | Serialization (40001) / deadlock (40P01) ⇒ bounded retry (3 attempts, 5/25ms backoff), then deny. **PROVEN (TEST)** |
| Statement timeout | Per-transaction `SET LOCAL` (default 10 000 ms); expiry aborts the tx ⇒ callers fail closed. **PROVEN** |
| Lock timeout | Per-transaction `SET LOCAL` (default 5 000 ms); 55P03 immediate deny. **PROVEN** |
| Serialization failures / deadlocks | Bounded retry then deny (never ALLOW); retry may over-count quota (safe direction); duplicate rolled-back sink records possible, S-10 holds exactly the committed receipt. **PROVEN** |
| Outage behavior | F1: pool 'error' listener (host survives), degradation observable (`getPoolHealth()`), recovery on next live round-trip; all ops fail closed (`SECURITY_STATE_UNAVAILABLE`). **PROVEN (mutation-checked)** |

### 8.2 Explicit statements (mandated)

1. **RLS is source-implemented** (policy creation, tenant GUC scoping, unset-GUC
   blindness — all present and test-proven as mechanisms).
2. **Production role/privilege posture is not yet proven** — no provisioning, no
   boot verification, tests prove mechanisms with self-created roles only.
3. **FORCE RLS errors are currently swallowed** — owner-bypass posture unverifiable
   at runtime (§5.2).
4. **Superuser/BYPASSRLS can defeat RLS** — nothing at `10fc9ba` detects or refuses
   such roles in production.
5. **System scope `'*'` is intentionally broad and therefore requires strict
   operational controls** — P1 minimizes it (INV-15) and enumerates its uses in the
   boot audit record.

### 8.3 P1 production contract for PostgreSQL roles and RLS

- **PG-1 (Role separation).** Two database roles minimum: a **DDL/migration owner
  role** (used only for schema setup/upgrade) and a **runtime application role**
  that is NOT superuser, NOT `BYPASSRLS`, and does NOT own the security tables
  (or owns them with FORCE verified). Connection config used by the runtime must
  specify the application role.
- **PG-2 (Least privilege).** The application role receives only the privileges
  required for DML on JATA Qi tables (+ `SET app.tenant_id`); no schema-alter
  rights at runtime.
- **PG-3 (Fail-closed DDL).** Security-relevant DDL (RLS enable, policy create,
  FORCE) throws on failure instead of swallowing; concurrent-boot races remain
  tolerated only for genuinely idempotent outcomes.
- **PG-4 (Boot verification probe — INV-08/09/10).** Before serving protected
  traffic: (a) `pg_roles` check — the connected role is neither `rolsuper` nor
  `rolbypassrls`; (b) `relrowsecurity` AND `relforcerowsecurity` true on every
  security collection table; (c) canary cross-tenant read/write refused; (d)
  no-tenant-context session sees zero rows. Probe results recorded in the boot
  audit. Any failure ⇒ BOOT FAILURE.
- **PG-5 (System-scope minimization — INV-15).** No ambient session-level `'*'`;
  pooled sessions start unset (blind); system scope only via explicit
  `SET LOCAL` transactions; the enumerated exceptions (S-1 policy lookup, S-9
  fingerprint lookup) are documented in the boot audit.
- **PG-6 (Provisioning artifact).** A reviewed script/runbook creates the roles/
  grants (executed by ops — EXTERNAL DEPENDENCY; **no production credentials or
  provider details are invented by this specification**).

## 9. CREDENTIALS / KEY MANAGEMENT

### 9.1 Current state

| Secret | Location (class) |
| --- | --- |
| PostgreSQL connection string | Env only (`JATAQI_PG_CONNECTION_STRING` / `PG*`); never committed; `.env` git-ignored; `redactConnectionString` for logs; missing config fails closed. |
| API keys (OpenAI) | Env only. |
| Static token file | **Plaintext operator JSON** (`JATAQI_AUTH_PRINCIPALS`) → in-memory Map; documented development/staging scope. |
| In-memory credential material | `InMemoryCredentialMaterialProvider` (dev/test); never persisted (closed schemas + shape guards). |
| Kernel HMAC secret | Per-process `randomBytes`; never leaves the process (bootstrap, by design). |
| Logging/redaction | Secret-free policy `describe()`; token material read from env not argv; redaction helper; audit closed field sets. **PROVEN.** |
| Secret scanning | Static brace-span scan of durable sources + live dump scan of all 9 security collections; negative control verified (`r2-secret-scan`, PASS). **PROVEN.** |
| Credential persistence guards | Closed schemas with material-shaped field patterns (`material|secret|token(?!registry)|password|privatekey`) rejected pre-write in S-1/S-2/S-3/S-8/S-9/S-10. **PROVEN.** |
| Rotation | Credential revocation permanent-history (S-2); token revocation (S-9); **no key rotation/versioning** (no keys to rotate — no encryption at rest exists). |
| Versioning | None (no key material). |
| External providers / KMS/HSM abstraction | `CredentialMaterialProvider` seam exists; no production implementation. |

**Explicit statement (mandated): current R2 secret-scan evidence does NOT equal
production key-management capability.** The scan proves no secret material is
persisted in the audited durable tables under the tested configuration; it does not
provide externalized secret storage, key versioning, rotation, controlled
retrieval, use-audit, or a production provider.

### 9.2 Required P1 contract (KMP)

1. **Externalized secret storage** — production secrets live in an operator-managed
   secret store (KMS/HSM/secret-manager); injected at process start; never in the
   repository, never in argv, never in logs.
2. **No plaintext production secrets in the repository** — enforced by existing
   hygiene + scan extension to provider configuration paths.
3. **No plaintext credential material in durable security tables** — existing
   closed-schema guards kept; provider path added to the scan (adversarial case 21).
4. **Key/version identifiers** — the provider surfaces a stable provider `id` and
   (optionally) key/version descriptors recorded in audit records (never material).
5. **Rotation contract** — S-2 revocation + S-9 fingerprint rotation compose with
   provider-side key rotation; deterministic-per-credentialId `create` (crash
   between row-commit and material-creation converges, never strands).
6. **Controlled retrieval** — material fetched ONLY at acquire time, after the
   enforcement transaction commits, single-use per envelope (existing semantics
   kept).
7. **Audit of key use** — S-10/S-3 records cite the credential/provider ids
   (references only).
8. **Revocation** — existing durable revocation semantics kept; provider fetch of a
   revoked/unavailable credential fails closed.
9. **No secret logging** — existing redaction/describe guarantees kept and extended
   to the provider boundary.
10. **Failure closed when provider unavailable** — provider fetch failure ⇒
    `CREDENTIAL_*` DENY before the side effect; absent production provider at boot ⇒
    BOOT FAILURE (INV-05/INV-13).

**No vendor is selected by this specification** — vendor choice is owner decision D2
unless explicit owner direction or evidence requires otherwise.

## 10. SECURITY STATE AVAILABILITY

### 10.1 F1 remediation review (recorded state at `10fc9ba`)

| F1 element | Status |
| --- | --- |
| Pool `'error'` listener → `notePoolError()` (records, never throws) | **PROVEN** (SOURCE + TEST `r2-pool-outage.test.ts`, 5 tests, mutation-checked: neutralized listener ⇒ 3/5 fail) |
| Degradation state + monotonic counters (`getPoolHealth()`) | **PROVEN** |
| Recovery on next successful live round-trip (beginTransaction setup / COMMIT) — no restart, no permissive retry | **PROVEN** |
| `SECURITY_STATE_UNAVAILABLE` mapping — storage failure NEVER converts to ALLOW, zero-usage, or "unrevoked" | **PROVEN** (R2-A06 + outage suite) |
| No memory fallback / no process-local authority on the durable path | **PROVEN** (structural: sync `decide()` throws; DurableDecider is the only path) |
| Host survival through outage (no uncaught pool error kills the process) | **PROVEN** (live pre-fix: 2 uncaught exceptions; post-fix: host survives) |

**Is the F1 contract sufficient?** **Yes, at library level, for the fail-closed
chain it claims** — outage before/after boot, during execute, and at session
issuance all deny; observability exists; recovery requires a live round-trip. It is
kept as-is; P1 does not rewrite it (and must not).

### 10.2 The remaining composition-level issue (mandated)

**The durable fail-closed path is not sufficient if production can boot with durable
security disabled.** A perfectly fail-closed substrate that no composition attaches
protects nothing. Therefore **P1 must make durable security a mandatory production
invariant** (INV-02), together with the storage/role/provider/session invariants
(INV-03…INV-07, INV-12…INV-14) so that the fail-closed chain is the ONLY chain a
production process can have.

## 11. R2 OBSERVATIONS

### R2-OBS-01 — manifest `maxLifetimeMs <= R2_SKEW_MS` (300 000 ms)

- **SECURITY BYPASS? NO.** The behavior is strictly conservative: enforcement
  deny-earlies freshness by the skew bound, so such manifests can never execute —
  they deny, never allow. **This is not claimed as a historical security bypass.**
- **AVAILABILITY / CONFIGURATION RISK? YES.** A registered-but-unexecutable
  manifest is a silent configuration defect (work that can never run).
- **Required P1 action:** registration-time validation MUST reject manifests whose
  lifetime cannot survive the required skew/replay window (`maxLifetimeMs >
  R2_SKEW_MS` floor; optional configurable ceiling) — INV-11, slice P1-S6.
  Classification: **GAP** (conservative direction).

### R2-OBS-02 — driver refuses cross-tenant CAS before store predicates run

- **Classification: PASS / DEFENSE IN DEPTH.** Both layers kept (driver clash check
  + store tenant predicates). **Retain the test** (A02/A15) and re-run under the
  production posture in P1-S7. No code change.

### R2-OBS-03 — high-contention `appendLedger` CAS exhaustion (8-attempt loop, 16-way concurrent authorize)

- **Classification: PERFORMANCE / OPERATIONAL QUALIFICATION — NOT an authorization
  bypass.** Exhaustion fails closed (write refused; no authority granted). P1 must
  not misclassify it as a security defect, and must not silently expand into
  performance work: load characterization only (P1-GAP-10, non-blocking).
- **Required P1 evidence (mandated list, each a fail-hard real-PG test with exact
  assertions):** concurrent authorization (exists: 32-process S-6 — keep/extend);
  concurrent credential use (extend to multi-process); concurrent revocation
  (extend R2-A19 pattern); concurrent session revocation (dispatch-vs-revoke race);
  concurrent manifest registration (exists: R2-A10 4-way — keep); concurrent rate
  limits (exists — keep); concurrent budget enforcement (exists — keep); concurrent
  tenant CAS (extend A02/A15 to parallel contenders); payment/ledger operations
  where relevant (T-15 4-planner election stability exists — keep; OBS-03 load
  profile documented).

## 12. CONFIGURATION INVARIANTS (production)

All invariants are **boot-time, fail-closed, kernel-security-invariant-registered**
(same append-only, non-overridable registry as `a01.authorization-boundary.mandatory`),
evaluated on every boot before any module starts. Detection point = where the check
runs. "Fail-open possibility" states the residual risk the acceptance test must
attempt and fail to realize.

| INV | Condition refused | Detection point | Expected behavior | Fail-open possibility | Fail-closed behavior | Evidence required | Acceptance test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **INV-01** | Missing/unknown posture declaration treated as production | Composition root, before module registration | Posture (`production`\|`development`) explicit, sealed at boot; unknown value throws; default `development` preserves current behavior | None (posture is sealed; no runtime change path) | BOOT FAILURE on unknown posture | Posture matrix pack (E4) | Boot with `JATAQI_SECURITY_POSTURE=production`/`development`/garbage ⇒ boot / boot / named error |
| **INV-02** | `durableSecurity=false`/absent in production | Kernel security invariant after init | Durable substrate attached; R1 path structurally unreachable | None (`decide()` already throws when a store is attached) | BOOT FAILURE (`ProductionPostureViolation`) | Boot matrix + mutation check that R1 Maps are unused (criterion C) | Production + `durableSecurity:false` ⇒ named boot error; no module starts |
| **INV-03** | `MemoryDriver` / `FsDriver` selected in production | Kernel invariant (driver check) | Transactional durable driver required (`supportsTransactions()` ∧ driver `postgres`) | None (memory/fs cannot satisfy the check) | BOOT FAILURE with named driver error | Boot matrix | Production + `STORAGE_DRIVER=memory` ⇒ boot failure; `filesystem` ⇒ boot failure; `--allow-non-durable-storage` refused under production |
| **INV-04** | Durable sessions required but unavailable | `AuthenticationModule.init` / kernel invariant | S-8/S-9 opened over the durable store; non-transactional/unavailable ⇒ boot abort | None (open throws) | BOOT FAILURE | Session wiring test (two-process revocation) | Production without `durableSessions` ⇒ boot failure; with unavailable store ⇒ boot failure |
| **INV-05** | Production credential provider absent | Kernel invariant (provider check) | Injected `CredentialMaterialProvider` with non-dev `id` | None (absent provider cannot be conjured) | BOOT FAILURE | Provider contract suite | Production + in-memory provider ⇒ boot failure |
| **INV-06** | Production authentication provider absent | Composition root | **Protected traffic permanently DENIED** (`admitsNothing`), recorded — never a silent allow; test authority still refused | None (no authenticator ⇒ nothing verifies) | Ingress closed; boot proceeds only with the closed posture explicitly recorded | Posture + ingress tests | Production with no authenticator ⇒ every ingress request fails closed; posture recorded in boot audit |
| **INV-07** | Unsafe token configuration (plaintext bearer tables) | Composition root / policy resolution | Constructor-table static tokens refused in production; only S-9 registry verification admissible (owner decision D1 may refuse outright) | None | BOOT FAILURE | Token-path tests | Production + constructor-table authenticator ⇒ boot failure |
| **INV-08** | RLS posture cannot be established | Boot probe (PG-4) | Policy present + canary cross-tenant refused + no-context session blind | None (probe is an active negative test) | BOOT FAILURE | Probe matrix (E4) | Database with RLS disabled / canary succeeding ⇒ boot failure |
| **INV-09** | Unsafe database role (superuser, BYPASSRLS, owner-without-FORCE) | Boot probe (`pg_roles` + ownership check) | Runtime role is non-superuser, non-BYPASSRLS, non-owner (or FORCE verified) | None | BOOT FAILURE | Probe matrix | Connect as superuser / BYPASSRLS / owner-with-FORCE-off ⇒ boot failure |
| **INV-10** | FORCE RLS cannot be established | Fail-closed DDL (PG-3) + boot probe assertion | `relforcerowsecurity` true on every security table | None (DDL throws; probe asserts) | BOOT FAILURE | Probe matrix | Force-RLS-missing database ⇒ DDL error surfaces + boot failure |
| **INV-11** | Manifest lifetime invariant violated | Manifest registration (`capability-manifests.ts`) | `maxLifetimeMs > R2_SKEW_MS` (floor; optional ceiling) | None (registration-time rejection) | `ManifestRejectedError` at registration; boot report flags pre-existing violating rows | Registration tests | Register `maxLifetimeMs = 300000` ⇒ `ManifestRejectedError` |
| **INV-12** | Required security-state storage unavailable | `SecurityStateStore.open` (kept) | Reachability + indexes + seed succeed before serving | None (open throws) | BOOT FAILURE | Existing R2-A11/A12 + posture re-run | PG down at boot with durable security ⇒ boot failure |
| **INV-13** | Production-only providers resolving to development implementations | Kernel invariant (provider/registry ids) | Dev provider ids (`r2-inmemory-material-provider`, etc.) refused in production | None (id check is exact) | BOOT FAILURE | Dev-implementation refusal tests | Production + any dev provider id ⇒ boot failure |
| **INV-14** | Security-state health cannot be established | Boot health/canary check (optional INV-12a canary) | At boot: pool healthy (or a live round-trip succeeds) + expected-DENY canary denies with the exact code | None (canary is a negative test) | BOOT FAILURE (or refuse serving until healthy) | Canary test | Boot with degraded/unreachable state ⇒ no protected traffic; canary denies |
| **INV-15** | Ambient system scope (session-level `'*'`) | Driver config / pool initialization | Pooled sessions start unset (blind); system scope only via explicit `SET LOCAL` transactions; exceptions enumerated in boot audit | None (unset GUC ⇒ see-nothing policy) | Sessions without explicit scope see/write nothing | Scope-minimization tests | No-tenant-context session ⇒ zero rows; system-scope uses enumerable |
| **INV-16** | `durableAudit:false` in production; unbounded authorization state | Kernel invariant + retention config check | Durable audit sink mandatory; retention/GC configuration recorded | None | BOOT FAILURE / posture record | Audit + GC smoke tests | Production + `durableAudit:false` ⇒ boot failure; missing retention config ⇒ posture refuses/records per D4 |

---

## 13. THREAT MODEL

Format: attack surface → control → enforcement location → evidence requirement →
residual risk. (Mandated threats 1–18; the directive's list continues past
"PostgreSQL outage" — items 13–18 follow the previously mandated set.)

| # | Threat | Surface → Control → Enforcement → Evidence → Residual |
| --- | --- |
| 1 | Account takeover | Presented ingress credentials (bearer static tokens only today) → no password system exists; token theft = full principal until expiry/revocation → `authentication-policy.ts`, S-9 registry (when wired) → revocation-visible-cross-process test (P1-S4); P2: MFA/step-up → **HIGH until P2 (bearer-only)** |
| 2 | Stolen session | S-8 rows are authentication events, not transferable bearer artifacts; decide AND execute re-check status; dispatch re-validation → `durable-decider.ts`, `loop-host/host-service.ts` → R2-A04/A05/A19 + dispatch HOLD + P1-S7 race extension → LOW on durable path |
| 3 | Replay | Sealed envelope + freshness window + S-4 exactly-once → `gate.ts` / `durable-decider.ts` → R2-A16 + 8-process contention → LOW on durable path; **HIGH on default R1 path (process-local Set)** → P1 closes via INV-02 |
| 4 | Credential theft | Material only at acquire, single-use (S-3), never persisted/logged (closed schemas + scans) → `credential-store.ts` → `r2-no-secrets`, R2-A14, P1-S3 provider contract → MEDIUM (process memory; P3 containment improves) |
| 5 | Privilege escalation | Closed role set; `system` refused at ingress; monotonic manifest narrowing; kernel scopes closed, no `kernel:*` → `capability-manifests.ts`, `kernel-principal.ts`, `auth-config.ts` → adversarial 15/16 + policy tests → LOW |
| 6 | Tenant substitution | Envelope tenant authoritative; `TENANT_SUBSTITUTION`; RLS + driver CAS clash check → `policy-engine.ts`, `postgres-collection.ts` → R2-A02/A15 + P1-S5 probe + P1-S7 concurrency extension → LOW on durable path |
| 7 | Malicious tenant | Same as 6 + per-tenant rate/budget (S-6/S-7) + read-only B-paths → same → 32-process rate test + tenant CAS races → LOW |
| 8 | Compromised worker | Kernel principal narrow scopes; unverified principal ⇒ deny; `runUnderEnvelope` wrapper required for external I/O → `kernel-worker-authority.ts`, `worker-boundary.ts` → adversarial 27/29 → MEDIUM (P3 contained execution improves) |
| 9 | Malicious internal code | Sealed container tokens; append-only invariants; closed schemas resist smuggling; in-process compromise of the gate itself is not defended (honest) → `core-kernel/security-invariants.ts` → composition-boundary tests → **MEDIUM-HIGH (accepted; P3 scope)** |
| 10 | Database compromise | DB reader/writer can read/mutate security state; envelope digest unkeyed; durable path re-verifies citations against the DB ⇒ full DB compromise subverts decisions → role separation (PG-1/2), least privilege, append-only audit → P1-S5 role model + probe evidence → **HIGH (out of P1 to fully mitigate; acknowledged)** |
| 11 | Unsafe database role (BYPASSRLS/owner/superuser) | Boot probe (role assertions + FORCE check + canary) → `postgres-driver.ts` (new probe, PG-4) → P1-S5 probe matrix (E4) → LOW after P1-S5; **HIGH before (current state: undetected)** |
| 12 | PostgreSQL outage | F1 + `SECURITY_STATE_UNAVAILABLE`; host survives; no memory fallback; pre-outage ALLOW executes no effect → `postgres-driver.ts`, `durable-decider.ts` → R2-A06 + `r2-pool-outage` (mutation-checked) → LOW (availability impact only) |
| 13 | Security-state corruption | Closed schemas reject malformed docs; malformed session rows ⇒ deny; unknown/material-shaped fields refused pre-write; row tamper ⇒ digest/citation mismatch ⇒ deny → `security-state-store.ts`, `assessSessionRow`, envelope citations → shape tests + R2-A09/A18 + P1-S7 cases 28/29 → LOW |
| 14 | Stale authorization | Per-transaction re-checks; live manifest digest match at execute; session re-check at execute → `durable-decider.ts` → R2-A18/A19 → LOW on durable path |
| 15 | Manifest poisoning | Registration validation; narrowing-only rotation; attributed approvals; boot divergence abort → `capability-manifests.ts`, `security-state-store.ts` → R2-A08–A12 → LOW |
| 16 | Configuration drift | Boot seed/ACTIVE divergence abort; P1 invariants; posture sealed at boot → `module.ts`, P1-S1/S6 → R2-A11/A12 + posture tests → LOW |
| 17 | Administrator abuse | Approvals digest-bound to exact actions; rotation approvals attributed; sealed bindings; audit records → `envelope.ts`, S-1 approvals → adversarial 20–22 → MEDIUM (P2 privileged plane + P7 qualification improve) |
| 18 | Supply-chain compromise | `npm ci` lockfile; no provenance/SBOM verification; no dependency-pinning policy beyond the lockfile → CI (`.github/workflows/ci.yml`) → P7 scope → **HIGH (accepted residual, P7)** |

---

## 14. P1 GAP REGISTER

Severity: CRITICAL > HIGH > MEDIUM. "Blocking" = blocks P1 exit criteria. No
evidence is invented; every current-evidence cell cites source or recorded packs.

| ID | Sev | Gap | Current evidence | Required state | Scope | Deps | Acceptance test | Indep. verification | Blocking |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **P1-GAP-01** | CRITICAL | No composition enables the durable substrate; `durableSecurity` default off; no env path | `module.ts` default; repo-wide zero non-test references (this audit) | INV-02 enforced; env wiring exists | P1-S2 | S1 | Production + `durableSecurity:false` ⇒ named boot failure | REQUIRED (E4) | YES |
| **P1-GAP-02** | CRITICAL | No production posture / invariant framework | Advisory-only distinctions (§3.1) | INV-01…INV-06, INV-13, INV-14, INV-16 as kernel invariants | P1-S1 | — | Posture rejection matrix (§3.2 cases A/C/E/F/G/H boot components) ⇒ BOOT FAILURE | REQUIRED (E4) | YES |
| **P1-GAP-03** | HIGH | Credential material provider: in-memory only; warn-not-enforce; no production contract | `module.ts` warn; `credential-store.ts` seam | INV-05/INV-13 + KMP contract tests; production provider EXTERNAL | P1-S3 | S1 | Production + in-memory provider ⇒ boot failure; contract suite (determinism, fail-closed fetch) | REQUIRED (E4) | YES |
| **P1-GAP-04** | HIGH | Durable sessions/registry not wired; CLI authenticator built without registry (revocation invisible) | `auth-config.ts:246`; R2 session suites PROVEN | INV-04 wiring; S-9 as the only production static-token path | P1-S4 | S1, S2 | Two-process revocation-without-restart (live); production refusal of constructor-table path | REQUIRED (E4) | YES |
| **P1-GAP-05** | HIGH | No production DB role model (provisioning, non-superuser enforcement, ownership separation) | `tenant-isolation.ts` comment; tests self-create roles | PG-1/PG-2/PG-6 role contract + script; INV-09 probe | P1-S5 | S1 | Probe fails closed on superuser/BYPASSRLS/owner-without-FORCE | REQUIRED (E4) | YES |
| **P1-GAP-06** | HIGH | FORCE RLS DDL error swallowed; FORCE unverifiable at runtime | `tenant-isolation.ts:127` (this audit, §5.2) | PG-3 fail-closed DDL + INV-10 probe assertion | P1-S5 | — | FORCE-missing database ⇒ boot failure | REQUIRED (E4) | YES |
| **P1-GAP-07** | HIGH | Ambient system scope `'*'` on every pooled session | `postgres-driver.ts` pool 'connect' (this audit) | INV-15/PG-5 minimization; exceptions enumerated | P1-S5 | — | No-context session ⇒ zero rows; system-scope uses enumerable; existing suites pass | REQUIRED (E4) | YES |
| **P1-GAP-08** | MEDIUM | No boot-time RLS/security verification probe | Absent (this audit) | PG-4 probe implemented + recorded | P1-S5 | 05/06 | Probe matrix (4 assertions) | REQUIRED | YES |
| **P1-GAP-09** | MEDIUM | R2-OBS-01: registration accepts unexecutable manifests (`maxLifetimeMs <=` skew) | OBS-01 record; `capability-manifests.ts` validation | INV-11 floor (+optional ceiling) | P1-S6 | — | Floor-violating registration ⇒ `ManifestRejectedError` | REQUIRED | YES |
| **P1-GAP-10** | MEDIUM | R2-OBS-03: CAS exhaustion under 16-way contention (operational) | OBS-03 record | Load characterization; NOT a security-correctness gate | P1-S7 (evidence only) | — | Documented load profile with fail-closed exhaustion | Optional | NO (operational) |
| **P1-GAP-11** | HIGH | Plaintext static-token file normalized by the CLI path | `auth-config.ts`; `.env.example` | INV-07 refusal in production; S-9 fingerprints only | P1-S4 | S1, S2 | Production + bearer table ⇒ boot failure | REQUIRED | YES |
| **P1-GAP-12** | MEDIUM | Envelope integrity unkeyed SHA-256 (tamper-evidence, not origin authenticity) | `envelope.ts` (algorithm `sha256`, no key) | Mandate durable path (INV-02) so enforcement re-verifies citations; optionally key the digest with the per-process kernel secret | P1-S2 (mandate) / optional hardening | — | Citation tests (R2-A18/A20) kept green; optional keyed-digest test | Optional for P1 exit | NO (defense-in-depth) |
| **P1-GAP-13** | MEDIUM | No production GC/retention operations story (floors + interlock exist; nothing runs them) | `security-state-store.ts` retention + GC + S-4 interlock | INV-16 retention config + maintenance procedure + health surfacing | P1-S8 | S2 | GC smoke under production posture; runbook | Optional | NO (operational, INV-16 recorded) |
| **P1-GAP-14** | — | No production identity provider (OIDC/MTLS/SAML/MFA/step-up/recovery/privileged plane) | Interface-only (`types.ts`); `auth-config.ts` limitation note | **NOT a P1 gap**: P1 ships contracts (§7.3); ingress stays closed; P2 implements | P2 | — | P1 acceptance explicitly does NOT require an identity provider | n/a | NO (EXTERNAL DEPENDENCY on P2 by design) |

**Summary:** 14 entries — 11 blocking (01–09, 11), 2 operational (10, 13),
1 defense-in-depth (12), 1 by-design external dependency (14).

---

## 15. P1 ACCEPTANCE CRITERIA

"Production posture" = INV-01 declaration. Each criterion is measurable and maps to
invariants and slices.

- **A. Production composition.** Boot under production posture fails closed (named
  error, no module starts) when: durable security disabled; storage
  non-transactional/non-durable; durable sessions unavailable; dev material provider
  present; durable audit disabled; RLS/role probe fails. [INV-02…06, 08–10, 13, 14, 16; S1–S5]
- **B. Authorization.** Every externally consequential invocation traverses the gate;
  the A/B invocation-boundary inventory is re-verified against the tree at P1
  closure; any new externally consequential path is added to (A) or proven (B). [S7]
- **C. Durable authority.** No security-critical decision depends on process-local
  authoritative state in production posture (§4.3 items 1–7 unused — proven by a
  mutation check that corrupts the in-memory Maps and asserts unchanged outcomes). [INV-02; S2]
- **D. Tenant isolation.** Cross-tenant access denied at BOTH layers + live RLS
  canary at boot; independently re-verified. [INV-08; S5]
- **E. PostgreSQL.** Production database role/RLS assumptions explicitly verified at
  boot (non-superuser, non-BYPASSRLS, FORCE active, canary refused, no-context
  blind) and recorded in the boot audit. [INV-08/09/10; S5]
- **F. Sessions.** Security-critical session/revocation state durable; revocation
  visible cross-process without restart (live two-process test). [INV-04; S4]
- **G. Credentials.** Credential secret material never persisted in plaintext
  anywhere; production provider contract enforced; bearer tables refused. [INV-05/07/13; S3/S4]
- **H. Security-state outage.** Unavailability never produces authorization success —
  existing `SECURITY_STATE_UNAVAILABLE` chain re-proven under production posture
  (outage before boot, after boot, during execute). [S7; F1 contract kept]
- **I. Configuration.** Unsafe production configurations rejected BEFORE serving
  protected traffic (all INV rejections at boot; no module reaches `start` on
  failure). [S1]
- **J. Concurrency.** Security-critical CAS/locking correct under concurrent
  execution: multi-process replay exactly-once, rate exactly-max, concurrent
  revocation, concurrent credential use, rotation races, tenant CAS races (§11
  evidence list). [S7]
- **K. Restart.** Security guarantees survive process restart (no envelope
  re-execution; revocations/budgets/rates persist). [S7; extends `r2-multiprocess-restart`]
- **L. Multi-process.** Security guarantees survive process fan-out (two-process
  worker pattern under production posture). [S7]
- **M. Evidence.** Critical P1 controls carry independent verification at **E4 or
  stronger under JATA-P0-95-v1.1** (rubric V3/V4/V5 honored: inspection ≠ runtime
  verification; historical ≠ current; evidence does not close gates; evidence must
  correspond to the exact promoted artifact/configuration). [S7 + separate verification pass]

---

## 16. ADVERSARIAL TEST PLAN (DESIGN ONLY — nothing executed)

All cases run against real PostgreSQL (fail-hard, no skips) under the
**production-posture composition**, asserting exact reason codes. ✅ = existing
coverage (keep; re-run under production posture); ➕ = new case.

| # | Case | Expected outcome | Coverage |
|---|---|---|---|
| 1 | Durable security disabled in production | BOOT FAILURE (named `ProductionPostureViolation`) | ➕ S1 |
| 2 | MemoryDriver supplied in production | BOOT FAILURE | ➕ S1 |
| 3 | FsDriver supplied in production | BOOT FAILURE | ➕ S1 |
| 4 | PostgreSQL unavailable at startup (durable on) | BOOT FAILURE (open throws) | ✅ (posture re-run) |
| 5 | PostgreSQL lost after startup | DENY `SECURITY_STATE_UNAVAILABLE`; host survives; pre-outage ALLOW executes no effect | ✅ `r2-pool-outage` (extend) |
| 6 | Security-state timeout (statement/lock) | deny; 55P03 immediate; 40001/40P01 bounded then deny | ✅ (extend) |
| 7 | Stale authorization (rotated manifest / expired) | `CAPABILITY_VERSION_MISMATCH` / expiry deny | ✅ R2-A18 |
| 8 | Replay one envelope | `REPLAYED_AUTHORIZATION`; effect once | ✅ R2-A16 |
| 9 | Concurrent replay (multi-process) | exactly-once | ✅ 8-process (keep) |
| 10 | Concurrent idempotency | COMPLETED receipt or `IDEMPOTENCY_CONFLICT` | ✅ R2-A17 (extend) |
| 11 | Concurrent credential use | single-use wins; others `CREDENTIAL_*` deny | ✅ (extend multi-process) |
| 12 | Concurrent revocation (revoke racing execute) | post-commit deny `PRINCIPAL_REVOKED`; no effect | ✅ R2-A19 (extend) |
| 13 | Tenant substitution | `TENANT_SUBSTITUTION` + driver refusal | ✅ R2-A02/A15 |
| 14 | RLS bypass attempt (raw SQL / wrong GUC) | zero rows / WITH CHECK failure | ✅ t01/t06 (extend) |
| 15 | BYPASSRLS role | BOOT FAILURE (probe) | ➕ S5 |
| 16 | Owner-role bypass (FORCE off) | BOOT FAILURE (probe) | ➕ S5 |
| 17 | Session revocation race (dispatch vs revoke) | HOLD `PRINCIPAL_REVOKED`; never dispatched | ✅ (extend) |
| 18 | Manifest version race (N contenders) | exactly 1 winner | ✅ R2-A10 |
| 19 | Unsafe manifest lifetime (`<=` skew) | `ManifestRejectedError` at registration | ➕ S6 |
| 20 | Configuration drift (seed vs ACTIVE) | `ManifestDivergenceError` boot abort | ✅ R2-A11/A12 |
| 21 | Credential secret leakage (incl. provider path) | no material in any store/audit/log (scan + live dump) | ✅ `r2-no-secrets` (extend) |
| 22 | Privilege escalation (wider manifest / `system` role / kernel wildcard) | rejected at registration/ingress/verification | ✅ adversarial 15/16 + policy |
| 23 | Process restart mid-flight | lease/orphan handling; no re-execution | ✅ `r2-multiprocess-restart` (extend) |
| 24 | Multi-process fan-out | shared limits; cross-process revocation visible | ✅ (extend two-process worker) |
| 25 | Database reconnect after outage | degraded clears; decisions resume correct | ✅ F1 suite (extend) |
| 26 | Transaction rollback between Tx-1/Tx-2 | S-5 lease orphan-marked; no partial authority | ✅ GC suite (extend) |
| 27 | Failover (pool recycling) | fail-closed throughout; no partial ALLOW | ➕ (harness-level) |
| 28 | Malformed authorization state | closed-schema/closed-code rejection; deny | ✅ shape tests (extend) |
| 29 | Authorization-state corruption (row tamper) | digest/citation mismatch ⇒ deny | ✅ R2-A09/A18 (extend) |
| 30 | Fail-closed verification (expected-DENY canary at boot) | canary denies with exact code | ➕ S1/INV-14 |

## 17. EVIDENCE PLAN

Per critical control, the ladder (source → unit → integration → adversarial →
concurrency → restart → production-like → independent verification), graded under
the JATA-P0-95-v1.1 E0–E6 schedule. Rules honored: V3 (inspection ≠ runtime
verification), V4 (historical ≠ current), V5 (evidence does not close gates).
E4/E5 are never awarded merely because a test exists — evidence must correspond to
the exact promoted artifact/configuration, and independent verification is a
separate pass by a party other than the implementer.

| Control | Source | Unit | Integration | Adversarial | Concurrency | Restart | Production-like | Indep. (E4+) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Mandatory boundary invariant | ✅ | ✅ | ✅ | ✅ | — | — | ➕ posture matrix | REQUIRED |
| Durable decide/enforce (Tx-1/Tx-2) | ✅ | ✅ | ✅ R2 suites | ✅ | ✅ | ✅ | ➕ posture re-run | REQUIRED |
| Production invariants (INV-01…16) | ➕ | ➕ | ➕ | ➕ matrix | — | — | ➕ boot matrix | REQUIRED |
| Tenant isolation / RLS / roles | ✅ | ✅ | ✅ | ✅ | ➕ | — | ➕ probe | REQUIRED |
| Sessions / revocation | ✅ | ✅ | ✅ | ✅ | ➕ | ✅ | ➕ wiring test | REQUIRED |
| Credentials / material / provider | ✅ | ✅ | ✅ | ✅ | ➕ | ✅ (strand case) | ➕ contract suite | REQUIRED |
| Availability / fail-closed (F1 chain) | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ (re-run) | REQUIRED |
| Configuration / manifest lifetime | ✅ | ✅ | ✅ | ➕ | ✅ | — | ➕ | REQUIRED |
| Multi-process / restart guarantees | ✅ | — | ✅ | ✅ | ✅ | ✅ | ➕ | REQUIRED |

**Current evidence at `10fc9ba` is implementer-produced (at best INTEGRATED class);
no P1 control holds E4+ independent verification under a production-posture
composition — none exists.**

## 18. P1 DEPENDENCY GRAPH

```
P1 FOUNDATION: posture framework (S1, INV-01…06/07/11/13/14/16)
   │
   ├─► PRODUCTION SECURITY COMPOSITION (S2: durable security mandatory in posture)
   │       ├─► DURABLE SECURITY STATE (S-1…S-10 engaged; criterion-C proof)
   │       ├─► IDENTITY BOUNDARY (S4: sessions/registry wiring; contracts only)
   │       │       └──[P2: OIDC/OAuth/SSO/SAML/MFA/step-up/recovery/deprovisioning/
   │       │            privileged plane/production identity integrations]──► LATER
   │       └─► POSTGRESQL/RLS (S5: roles, FORCE fail-closed, probe, scope minimization)
   │               └──[ops EXTERNAL: production DB/role provisioning]──► OWNER
   ├─► CREDENTIAL/KEY BOUNDARY (S3: provider contract + enforcement)
   │       └──[ops EXTERNAL: production KMS/HSM provider selection (D2)]──► OWNER
   ├─► CONFIGURATION ASSURANCE (S6: INV-11 floor, drift/rotation docs)
   ├─► ADVERSARIAL QUALIFICATION (S7: 30-case plan; concurrency/restart/production-like)
   └─► SECURITY OPS (S8: retention/GC, health surfacing, runbook)
   │
   └─► INDEPENDENT VERIFICATION (E4+, separate pass, separate party)
           └─► [P7: production qualification — LATER]
                   └──[P3: contained execution/governed egress; P4–P6; S1-120% — LATER]
```

Explicitly **P2 or later**: identity-provider implementations, step-up enforcement,
account recovery, deprovisioning, privileged-plane management, session refresh
beyond S-8. **External (owner/ops)**: production DB provisioning/roles, production
KMS/HSM provider, deployment environment. **P1-internal**: everything else.

## 19. IMPLEMENTATION PLAN — REVIEWABLE SLICES (NOTHING IMPLEMENTED NOW)

Slices land in order S1 → S2 → (S3, S4, S5 parallel) → S6 → S7 → S8. Each is
independently reviewable and reversible; the verification plan (§16/§17) is fixed
NOW, before implementation.

### P1-S1 — Production posture & composition invariant framework
Objective: INV-01…INV-07, INV-11…INV-14, INV-16 as fail-closed boot invariants;
posture sealed. Files: `packages/cli/src/bootstrap.ts`, `config.ts`,
`host-command.ts`, new `security-posture.ts`; `authorization-boundary/src/module.ts`
(config surface). Interfaces: `JataQiConfig.securityPosture`, env
`JATAQI_SECURITY_POSTURE`; default `development` (current behavior unchanged).
Migration: none (additive). Security: advisories → boot failures. Tests: posture
rejection matrix + expected-DENY canary. Evidence: matrix pack; independent E4.
Rollback: revert; development posture unchanged throughout. Acceptance: criteria
I + A (framework components).

### P1-S2 — Durable security production wiring
Objective: production posture constructs `durableSecurity` (S-1…S-10) with operator
seed/rotation inputs; closes P1-GAP-01 (INV-02/12). Files: `bootstrap.ts`,
`security-posture.ts`, `module.ts` (config surface). Interfaces: env for seed
manifest source + rotation approvals; registrar attribution from operator identity
(never `kernel:boot` in production). Migration: first production boot seeds S-1;
divergence procedure documented. Tests: GAP-01 acceptance; mutation check that R1
Maps are unused (criterion C). Rollback: posture revert; durable schema additive.
Acceptance: criteria C + A (durable component).

### P1-S3 — Credential/key boundary enforcement
Objective: INV-05/INV-13 + KMP contract tests; refuse dev providers in production;
provider id recorded in audit. Files: `credential-store.ts`, `module.ts`,
`security-posture.ts`, new contract suite. Interfaces: none broken. Migration:
none (provider is ops-supplied, decision D2). Tests: contract suite (determinism,
fail-closed fetch, no-log, no-persist) + boot refusal. Acceptance: criterion G
(provider half).

### P1-S4 — Durable sessions, token registry wiring, bearer-table refusal
Objective: INV-04/INV-07; registry-based static-token verification in the CLI path;
cross-process revocation; closes P1-GAP-04/11. Files: `auth-config.ts`,
`bootstrap.ts`, `authentication-module.ts` (wiring aid), `host-service.ts`
(session store attachment). Interfaces: `JATAQI_AUTH_MODE=static-token` production
path requires the registry; S-9 import procedure. Migration: principal file → S-9
fingerprint import (one-shot, idempotent, rebind refused). Tests: two-process
revocation-without-restart (live); production refusal of constructor-table path.
Acceptance: criteria F + G (token half).

### P1-S5 — PostgreSQL production role/RLS hardening
Objective: closes P1-GAP-05/06/07/08: PG-3 fail-closed security DDL; PG-4 boot
probe (INV-08/09/10); PG-5 scope minimization (INV-15); PG-6 provisioning script.
Files: `tenant-isolation.ts`, `postgres-driver.ts`, `config.ts`, new `rls-probe.ts`,
`scripts/` artifact. Interfaces: driver config for role expectations; probe report
in boot audit. Migration: probe runs against live tables (idempotent). Tests: probe
matrix (superuser/BYPASSRLS/no-FORCE/canary-success ⇒ boot failure); no-context
session zero rows; all existing PG suites re-run. Acceptance: criteria D + E.

### P1-S6 — Configuration assurance & manifest lifetime
Objective: INV-11 floor (+optional ceiling); drift/rotation operator docs. Files:
`capability-manifests.ts`, `security-state-store.ts` (registration path), docs.
Interfaces: none (new rejection on existing validation). Migration: pre-existing
violating rows flagged in the boot report (they could never execute); no silent
change. Tests: floor rejection; divergence re-proven. Acceptance: criterion I
(configuration component).

### P1-S7 — Adversarial & qualification suite
Objective: implement + run the 30-case plan (§16) under production posture; extend
concurrency/restart/multi-process evidence; OBS-03 load characterization (GAP-10).
Files: new suites beside `r2-*`; harness reuse (`r2-pg.ts`, `r2-fixtures.ts`,
`r2-two-process-worker.mjs`). Tests: this slice IS tests. Evidence:
machine-readable results pack (extend the adversarial-matrix pattern) with exact
codes. Acceptance: criteria B, H, J, K, L.

### P1-S8 — Security operations enablement
Objective: INV-16 operational half: retention/GC configuration + maintenance
procedure; health surfacing (`getPoolHealth` → structured log/metrics hook);
runbook. Files: `host-command.ts` (maintenance cycle), docs, optional `scripts/`.
Tests: GC smoke under production posture; retention config validation. Acceptance:
INV-16 recorded; criteria A–L unaffected.

## 20. SCORE IMPACT (NO POINTS AWARDED)

- **CURRENT (frozen):** evidence-qualified baseline **9.484375%**; capability index
  **44.375/100**; integration-adjusted capability **36.6875/100**; sensitivity
  range **6.6484375–14.875**; stretch **0/20**; production **NOT READY**.
- **Dimensions P1 could legitimately improve** (qualitatively; exact dimension IDs
  live in the v1.0 base rubric): durable security state, authorization enforcement
  composition, tenant isolation, configuration assurance, security-state
  availability evidence, and security evidence classes (INTEGRATED → adversarial/
  restart/multi-process production-like). P1 does **not** improve modality
  dimensions (D07), identity-provider dimensions (P2), or qualification (P7).
- **POTENTIAL POST-P1 SCORE: NOT COMPUTED, NOT CLAIMED.** Any projection requires a
  full v1.1 worksheet against evidence that does not exist yet. Per rubric V2/V5
  and the P0 closure record (§11: architectural presence ≠ production capability;
  no credit for planned capabilities), **no projected capability in this document
  is achieved, and none may be presented as such. No future P1 credit is awarded.**
  The baseline remains 9.484375% until separately evidenced and independently
  verified.

## 21. P1 EXIT CRITERIA (FUTURE — nothing performed now)

P1 is NOT complete when implementation tests pass. Future closure requires ALL of:

1. implementation completed (authorized slices only; scope boundary respected);
2. required tests pass (full repo suite, 0 skipped/todo, fail-hard PG);
3. adversarial suite (§16) passes under production posture;
4. concurrency/restart/multi-process suites pass (criteria J/K/L);
5. production composition verified (criteria A/I — boot matrix);
6. PostgreSQL/RLS production assumptions verified (criterion E — probe + ops role
   provisioning evidence);
7. independent verification PASS (E4+ under JATA-P0-95-v1.1, separate party, exact
   artifact/configuration);
8. no unresolved critical P1 blocker (all blocking gaps closed);
9. exact tested artifact/configuration identified (commit SHA, env, roles, provider);
10. commit/PR provenance verified;
11. explicit merge authorization (human owner);
12. post-merge verification.

## 22. G10 / G19 BOUNDARY

- **G10 remains OPEN — UNATTRIBUTABLE CANONICAL CI FAILURE** (run `34162894915`,
  job `101868167969`, step "Test (all workspaces)", `npm test`). This audit
  performed no CI log retrieval and no reinterpretation. P1's future verification
  runs are new evidence for P1 only; **P1 must not be claimed to resolve G10**.
  Any G10 revisit requires the materially new authoritative evidence defined in
  `docs/P0_ASSURANCE_CLOSURE_HANDOFF.md` §6.
- **G19 remains UNRECOVERED — HISTORICAL F3–F12 SOURCE UNAVAILABLE.** Nothing in
  this audit reconstructs, infers, renames, substitutes, or maps anything into
  F3–F12. The finding identifiers `F1`/`F2` used in this document are the R2
  independent-verification findings explicitly recorded in
  `docs/verification/R2_IMPLEMENTATION_EVIDENCE.md` — a different, disjoint series;
  no relation to G19's F3–F12 is asserted or implied.
- The P0 assurance process remains CLOSED; release criteria remain UNSATISFIED;
  production remains NOT READY.

## 23. FINAL GOVERNANCE RECORD

| Item | Status |
| --- | --- |
| P0 assurance | CLOSED (process); release NOT PASSED |
| Evidence-qualified score | 9.484375% (frozen; unchanged by this audit) |
| Capability index / integration-adjusted / sensitivity / stretch | 44.375/100 · 36.6875/100 · 6.6484375–14.875 · 0/20 |
| Production | NOT READY |
| G10 / G19 | OPEN / UNRECOVERED (unchanged) |
| Rubric | JATA-P0-95-v1.1 ADOPTED (authoritative) |
| P1 implementation | **NOT AUTHORIZED** (this document is specification only) |
| Commit / push / PR / merge | NOT AUTHORIZED |
| P2 / P3 / P4 / P5 / P6 / P7 / 120% | NOT AUTHORIZED |
| Repository modifications by this audit | NONE — this document (and the P0 closure record) are uncommitted documentation only; no source, tests, dependencies, package configuration, CI, runtime configuration, infrastructure, or database schemas/migrations changed |

## 24. P1 READINESS CLASSIFICATION

> ## A. P1 READY FOR EXPLICIT IMPLEMENTATION AUTHORIZATION

**"A" does NOT authorize implementation.** It means this audit and specification
are complete, evidence-backed, internally consistent, and sufficiently structured
for the human owner to decide whether to issue a separate P1 implementation
authorization. Basis: every mandated audit area (§§3–13) has source-level findings
at `10fc9ba`; every gap is registered with severity, evidence, scope, dependencies,
acceptance tests, and verification requirements; invariant semantics (INV-01…16),
acceptance criteria (A–M), the adversarial plan (30 cases), the evidence plan, the
dependency graph, and the implementation slices (S1–S8) are fully specified; no
unresolvable design ambiguity blocks implementation. Open items are explicit owner
decision points and external dependencies, none of which block the authorization
decision itself.

**Owner decision points (parameters, not blockers):**
- **D1** — static-token admissibility under production posture (spec default:
  refused unless S-9-registry-verified + explicit opt-in; alternative: refuse
  outright until P2).
- **D2** — production credential material provider (vendor/ops choice against the
  KMP contract).
- **D3** — production database role names/provisioning mechanism (P1-S5 delivers
  the contract + reviewed script; naming/execution is ops).
- **D4** — slice granularity for the authorization (recommended minimum for any
  security-meaningful first slice: **S1 + S2 + S7**).

## 25. EXACT AUTHORIZATION REQUIRED

Implementation may begin ONLY upon an explicit, separate human-owner issuance
substantially of the form:

> *"I authorize P1 — Enforced Production Security Composition — implementation on
> [branch] against canonical `10fc9ba…` (or its designated successor), limited to
> slices [explicit subset of S1–S8], per
> `docs/P1_READINESS_AUDIT_AND_SPECIFICATION.md` (2026-09-08): invariants
> INV-01…INV-16, acceptance criteria A–M, adversarial plan §16, evidence plan §17.
> Decision points D1–D4 are resolved as follows: […]. No merge without independent
> verification (E4+) and explicit merge authorization. P2/P3/120% remain
> unauthorized."*

Until that issuance: **P1 IMPLEMENTATION: NOT AUTHORIZED.**

## 26. REQUIRED STOP

This audit modified no source, tests, dependencies, package configuration, CI,
runtime configuration, infrastructure, or database schemas/migrations; installed
nothing; committed nothing; pushed nothing; created no PR; merged nothing;
authorized nothing; claimed no production readiness; awarded no projected score
points; reopened no P0 process; reconstructed no G19/F3–F12 content. The artifact
is left UNCOMMITTED in the working tree as directed. The next action belongs to
the human owner.

**STOP. — END OF P1 READINESS AUDIT & IMPLEMENTATION SPECIFICATION.**
