# P2 — PRODUCTION IDENTITY & PRIVILEGED PLANE: IMPLEMENTATION SPECIFICATION

> **Status:** SPECIFICATION (P2 readiness + implementation specification under
> explicit authorization). **IMPLEMENTATION NOT AUTHORIZED.** The first
> implementation slice (§24) is proposed for a SEPARATE explicit
> implementation authorization. No production identity code is written by
> this document.
>
> **Mode:** P2 READINESS + IMPLEMENTATION SPECIFICATION (documentation-only).
> **Authorization scope:** technical reconnaissance, architecture,
> specification, dependency mapping, acceptance criteria, adversarial design,
> migration/rollback design, evidence requirements. **Excluded:** production
> identity implementation, external IdP integration, KMS/HSM deployment,
> production rollout, merge.
>
> **Strict non-scope (recorded, NOT expanded):** Model Fabric, Autonomous
> Prompt Compiler, Execution Acceleration Layer, marketplace, payments,
> universal wallet, production deployment, broad knowledge-plane/vector/graph
> redesign, G10, G19, P1C-OBS-01. Adjacent gaps found during this audit are
> recorded in §25 and assigned to their own future authorizations.

| Field | Value |
| --- | --- |
| Record type | P2 implementation specification + readiness basis (authoritative milestone specification) |
| Date of record | 2026-09-09 (UTC) |
| Canonical baseline (verified against source this session) | `5d12cc57353c4e7cce3af157f5e23efde2c74b28` |
| Working branch | `arena/01a08684-jata-qi` (session-fixed; no implementation made) |
| Predecessor milestone | INV-15/GAP-07 — CLOSED, MERGED, POST-MERGE VERIFIED (PR #28; CI `34359343572` green) |
| P0 score | 9.484375% (frozen; this specification awards and projects no points; §19) |
| G10 / G19 / P1C-OBS-01 | OPEN / UNRECOVERED / DOCUMENTED-NOT-REMEDIATED — untouched by this work |
| Rubric | `JATA-P0-95-v1.1` (adopted successor; v1.0 base text absent — P0R-RUB-02) |
| Companion record | `docs/verification/P2_READINESS_AUDIT.md` (current-state inventory with file:line provenance) |
| Artifacts | UNCOMMITTED (commit/push/PR not covered by this authorization; §26) |

---

## 1. Current-state inventory (verified against canonical source at `5d12cc5`)

Method: direct source inspection at `5d12cc5` (not re-derivation from the P1
audit). Full file:line provenance in the companion readiness audit. Deltas
against the P1-era audit are marked **Δ**.

### 1.1 `@jataqi/authentication` (last modified at P1; unchanged since)

| Component | Verified state at `5d12cc5` |
| --- | --- |
| Method vocabulary (`src/types.ts`) | Closed `AuthenticationMethod` union: `DETERMINISTIC_TEST`, `STATIC_TOKEN`, `OIDC`, `MTLS`, `KERNEL_INTERNAL`; frozen `RECOGNIZED_AUTHENTICATION_METHODS` list; `PresentedCredential {method, material, context?}` |
| Principal shape (`src/types.ts`) | `AuthenticatedPrincipal {id, tenantId, roles, authenticationMethod, verifiedAt, authenticationEventId, credentialExpiresAt?, claims?}`; `projectToActor` narrows only (widening throws); `ServerAuthenticator {id, supports, verify(credential, now, requestId)}` |
| **Δ** OidcAuthenticator | `types.ts` header comment says "an `OidcAuthenticator` exists as a type-only contract" — **no such class exists in src** (verified: grep all `packages/*/src`). Only the `OIDC` method token and the P1 contract surface exist. The comment is aspirational; S1 closes this delta by implementing the class (or the comment is corrected — S1 does both: implements, making the comment true) |
| Role vocabulary (`commercial-control-plane`, closed) | `observer, agent, operator, approver, admin, global_admin, system` — `RECOGNIZED_COMMERCIAL_ACTOR_ROLES`; `system` is refused for externally-presented credentials (`auth-config.ts` `FORBIDDEN_EXTERNAL_ROLES`) |
| Admission policy (`src/authentication-policy.ts`, T-03) | `resolveAuthenticationPolicy`: production (default) admits `STATIC_TOKEN/OIDC/MTLS`; `test-only` requires mode + `allowTestMethod:true` (double opt-in); `KERNEL_INTERNAL` never admissible at ingress; `assertMethodAdmitted` runs BEFORE any authenticator |
| Principal boundary (`src/principal-boundary.ts`, T-03) | Six-stage fail-closed pipeline: credential present → method admitted by policy → registry verifies → independent structural validation of result → result method re-checked against policy → **durable session recorded BEFORE the principal is returned** (record-failure rejects the authentication). Session lifetime `(0, 30 days]`, capped by `credentialExpiresAt` |
| Authenticator registry (`src/authenticator-registry.ts`) | Duplicate-id refusal; method dispatch; per-credential failure distinction |
| Static token authenticator (`src/static-token-authenticator.ts`) | Opaque token → principal; dev/staging-scoped by contract; when a `TokenRegistryStore` is attached, verification goes through the durable registry INSTEAD of the constructor table (material still required at config — fail-closed) |
| Deterministic test authenticator | Test infrastructure; never production (policy + posture refuse it) |
| Durable session store (`src/authentication-event-store.ts`, R2 S-8) | `authentication.events` collection; insert-once `recordEvent` (CAS); `assertActive` (deny-early, 300 s skew bound); CAS-guarded `revokeEvent` (cross-tenant revocation refused); `markExpired` (evidence hygiene only); closed field allow-list + material-shaped-field refusal; requires a transactional driver (memory/Fs refused) |
| Token registry (`src/token-registry.ts`, R2 S-9) | `authentication.token-registry`; SHA-256 fingerprint = doc id (one-way, never material); one-shot idempotent import with rebind refusal; `verifyByMaterial` (system-scope single-row read — an enumerated INV-15 exception); `revokeByFingerprint` / `revokeByPrincipal` (compromise path); closed schema |
| Module wiring (`src/authentication-module.ts`, T-03 + P1 S2) | `durableSessions.enabled` opens S-8/S-9 from storage (fail-closed when storage absent); `authenticatorFactory` seam (factory XOR explicit array); container tokens `authentication.boundary` / `.session-store` / `.token-registry` |
| P1 contracts (`src/contracts.ts`) | `ProductionAuthenticatorContract` (`verifiesCryptographicProof`, `validatesIssuerAndAudience`, `replayResistant`, `health()`), `SessionLifecycleContract`, `TokenLifecycleContract`, `StepUpRequirement {maxAgeMs, satisfiedBy: OIDC|MTLS|MFA}` + `StepUpCapableAuthenticator.verifyStepUp`, `IdentityProviderHealth`, `PrincipalLifecycleHooks {onProvisioned, onDeprovisioned}`, `PrivilegedIdentityBoundary {isPrivileged, assertPrivilegeValid}` — **interfaces only; no implementations exist** |

### 1.2 CLI composition (`@jataqi/cli`)

| Component | Verified state |
| --- | --- |
| `src/auth-config.ts` (T-03) | `resolveCliAuthentication`: modes `none` (DEFAULT — admits nothing; honest limitation reported), `static-token` (operator principal file → `StaticTokenAuthenticator`, production policy), `test-only` (double opt-in). `JATAQI_AUTH_TOKEN` read from env, never argv |
| `src/security-posture.ts` (P1 S1/S5) | `resolveSecurityPosture` (`JATAQI_SECURITY_POSTURE`, default `development`, unknown ⇒ throw); pre-boot `validateProductionSecurityConfig` (deterministic `P1_*` codes); seven declared kernel invariants: `p1.production.durable-security` (boot canary must DENY, never availability-fail), `.durable-storage`, `.durable-sessions`, `.credential-material-provider`, `.rls-posture` (probe), `.ambient-scope-minimization` (INV-15 live probe + enumeration), `.security-state-health` |
| `src/bootstrap.ts` (P1) | `productionAuthorizationConfig` (durable security auto-wired; explicit opt-outs refused); `productionAuthenticationConfig`: `none` ⇒ ingress closed; `static-token` ⇒ requires `JATAQI_ALLOW_STATIC_TOKEN_PRODUCTION=true` AND verification only via the durable S-9 registry (constructor tables refused) — code comment: "Production identity (OIDC/mTLS) is P2 (fail-closed)" |
| Operator surfaces (privileged-adjacent, existing) | `host-inspect.ts`: `JATAQI_OPERATOR_GLOBAL_ADMIN=true` env ⇒ `['operator','global_admin']` (explicit opt-in, documented); `host-command.ts`: delivery worker runs as `{tenantId:'system', roles:['system']}`; `host-ingress-command.ts`: authenticated work ingress — method derived from posture, never from CLI |

### 1.3 `@jataqi/authorization-boundary` (A-01 + R1 + R2)

| Component | Verified state |
| --- | --- |
| Decision pipeline (`src/policy-engine.ts`) | Ordered fail-closed pipeline, DEFAULT = DENY with accumulated reason codes; discretionary engine can only strengthen, never ALLOW; internal defect ⇒ DENY (`POLICY_ENGINE_UNAVAILABLE`) |
| Approvals (`src/types.ts`) | `A01ApprovalBinding {approvalId, approvedActionDigest, …}` — approvals digest-bound to the EXACT action (replay of an approval for a different operation/target/tenant refused); manifests carry `requiresApproval` |
| Capability manifests (`src/capability-manifests.ts`) | Registration validation (rejects wildcards/empty allow-lists); **monotonic narrowing** across versions (no widening of operations/targets/tenants/classification/impact/rate/budget/lifetime; no dropping approval/credential requirements) |
| Credential broker/store | Single-use credential material at the enforcement point only; provider `kind` (`dev-inmemory` / `external`); production refuses dev providers (INV-09); closed schemas, no material at rest |
| Kernel internal identity (`src/kernel-principal.ts`, R1/D2) | `KernelInternalIdentity`: per-process HMAC-signed service principals; closed scope set (`kernel:bootstrap`, `kernel:maintenance`, `kernel:verification`, `kernel:internal-execution`); tenant `system`; NOT a bypass (ordinary A-01 decision still required); no wildcard scope |
| Durable decider (`src/durable-decider.ts`) | Phase-B single tenant transaction: rate increment → session check → credential preload → PDP → audit; sealed envelope cites manifestId+digest, sessionEventId+status, securityStoreTxId |
| Security state store (`src/security-state-store.ts`, R2) | PostgreSQL is the SOLE authoritative SecurityStateStore; collections `authorization.{manifests, credentials, credential-uses, consumed-envelopes, idempotency, rate-windows, run-budgets, decisions}`; S-1 approvals; retention/GC with interlocks; fail-closed `SECURITY_STATE_UNAVAILABLE` |
| Module (`src/module.ts`) | Mandatory boundary (non-optional in composition); kernel-identity token; R1 audit-sink pool path (enumerated INV-15 exception) |

### 1.4 `@jataqi/loop-host` (T-02/T-03 + R2/P1)

| Component | Verified state |
| --- | --- |
| Principal snapshots (`src/principal-snapshot.ts`, T-02) | `freezePrincipalSnapshot` (six fixed provenance fields, everything else stripped); `assessPersistedSnapshot` (version/shape/method/freshness; 300 s skew tolerance; future-beyond-skew ⇒ `PRINCIPAL_SKEW`); `authorizeDispatch` (triple tenant match snapshot==item==actor, identity match, role non-expansion via T-01's own `projectToActor`; hold reasons `PRINCIPAL_*` incl. `PRINCIPAL_ROLE_ESCALATION`) |
| Session re-validation at dispatch (`src/host-service.ts`) | After lease + `authorizeDispatch`, every dispatch re-validates the durable session: non-ACTIVE ⇒ HELD `PRINCIPAL_REVOKED` (never dispatched, never resumed silently); store FAILURE ⇒ throw (fail closed); `KERNEL_INTERNAL` bypasses (cryptographic verification instead) |
| Work ingress (`src/work-ingress.ts`, T-03) | Presented credential → T-03 boundary → `AuthenticatedPrincipal` → durable enqueue; submission tenant must equal principal tenant; no self-attested principals |

### 1.5 Storage substrate (INV-15 state — preserved by P2 by construction)

Pooled PostgreSQL sessions start **blind** (no ambient `'*'`); system scope only
via explicit, enumerated `SET LOCAL` transactions counted by the driver audit
(`ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS`: `poolpath:<collection>`,
`transaction:system`, `schema:isolation`); boot invariant
`p1.production.ambient-scope-minimization` + live `hasAmbientConnectScope()`
probe; RLS + `FORCE ROW LEVEL SECURITY` probe-verified at boot. **Every P2
store specified below must be built on this substrate and must not introduce
any new ambient-scope path; any new system-scope read pattern must be added to
the enumerated registry (mechanically detected, else boot fails).**

### 1.6 Existing privileged operations (enumerated from source — §9 input)

| # | Operation | Current enforcement (verified) | Package/site |
| --- | --- | --- | --- |
| PO-1 | Billing administration (plan/invoice admin actions) | `admin` or `global_admin` role check (ad-hoc) | `billing/billing-service.ts` |
| PO-2 | Billing management (operator-class) | `operator|admin|global_admin|system` role check | `billing/billing-service.ts` |
| PO-3 | Cross-tenant read (billing) | `global_admin` role check | `billing/billing-service.ts` |
| PO-4 | Deployment administration / adapter registration (cross-tenant) | `admin|global_admin`; cross-tenant adapter registration requires `global_admin` | `autonomous-deployment/deployment-service.ts` |
| PO-5 | Venture factory management / cross-tenant read | operator-class roles; `global_admin` for cross-tenant | `autonomous-venture-factory/venture-factory-service.ts` |
| PO-6 | Capability/engine registry changes | `admin|global_admin|system` | `capability-fabric/capability-fabric-service.ts` |
| PO-7 | Cross-tenant capability audit verification | `global_admin` only | `capability-fabric/capability-fabric-service.ts` |
| PO-8 | Cross-tenant reads (causal-engine and analogous read paths) | `global_admin` | `causal-engine/…` (pattern repeats across services) |
| PO-9 | A-01 approval-granting (S-1 approvals) | Approval bound to digest of exact action; attributed | `authorization-boundary` (S-1) |
| PO-10 | Static token import (S-9 one-shot import) | Operator path; `importedBy` recorded; rebind refused | `authentication/token-registry.ts` |
| PO-11 | Session revocation (operator path) | CAS-guarded; reason mandatory | `authentication-event-store.ts` |
| PO-12 | Manifest rotation (narrowing-only) | Version validation; monotonic narrowing | `capability-manifests.ts` |
| PO-13 | Operator console surface (global_admin opt-in) | Explicit env opt-in `JATAQI_OPERATOR_GLOBAL_ADMIN` | `cli/host-inspect.ts` |
| PO-14 | Kernel-internal maintenance/verification/sweeps | HMAC-signed kernel service principal, closed scopes | `authorization-boundary/kernel-principal.ts` |
| PO-15 | Retention/GC + orphan-lease maintenance | Kernel `kernel:maintenance` scope + durable interlocks | `security-state-store.ts` |

**Finding (P2-GAP-04 basis):** privileged authority today is (a) a role flag
on a principal minted by a static-token table (or closed ingress), checked
**ad-hoc per service** (PO-1…PO-8), with (b) two genuinely governed privileged
mechanisms (PO-9 approvals; PO-14 kernel principals). There is **no privileged
plane**: no plane-role vocabulary separate from the commercial roles, no
just-in-time elevation, no step-up requirement on administrative operations,
no break-glass, no privileged-session review, no cross-service consistent
privilege decision. The `global_admin` cross-tenant read pattern is the
closest thing to a platform-admin role and is currently a bare role flag
granted at token-registration time, indefinitely.

### 1.7 Deltas against the P1-era forensic audit (explicit)

1. **Δ-1 (documentation):** `types.ts` references an `OidcAuthenticator`
   type-only contract that does not exist (verified §1.1). S1 resolves it.
2. **Δ-2 (substrate):** INV-15 (PR #28) changed the scope layer under
   `authentication.events` / `token-registry` reads: the S-8/S-9 pre-tenant
   single-row reads now run through the enumerated, counted explicit
   `poolpath:`/`transaction:system` grants (verified: `token-registry.ts`
   `getSystem` uses an explicit system-scope transaction; both remain in
   `ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS`). P2 stores MUST follow the same
   pattern.
3. **Δ-3 (tests only):** V-2 32-process stabilization and O-1/O-2/O-3
   harness fixes since R2 — no behavioral change to the identity surface.
4. All other P1 spec §7.1 "PROVEN/PARTIALLY PROVEN" classifications re-verify
   unchanged at `5d12cc5` (spot-checked against source this session).

---

## 2. P2 gap register (mapping of mandated core capabilities)

Severity: CRITICAL > HIGH > MEDIUM. "Blocking" = blocks P2 exit (i.e., the
P2 program's exit criteria require closure).

| ID | Sev | Capability (task §2) | Gap | Current evidence (canonical) | Required state | Slice |
| --- | --- | --- | --- | --- | --- | --- |
| P2-GAP-01 | CRITICAL | A. Production authentication | No production identity provider: production ingress is either closed (`none`) or static-token (dev/staging-scoped; opt-in). T1 account-takeover residual HIGH persists | §1.1/§1.2 (verified) | Provider-neutral `OidcAuthenticator` satisfying `ProductionAuthenticatorContract` (crypto proof, iss/aud, replay) + production wiring; static-token production only as owner-sealed transition (D1) | S1 |
| P2-GAP-02 | CRITICAL | B. Identity lifecycle | No identity records: no enrollment/activation/verification/suspension/deactivation/deletion/recovery/linking/tenant-membership/role-lifecycle; principals exist only as token-table rows | §1.1 (no such stores exist — verified) | Durable identity stores + lifecycle state machine + recovery + deprovisioning cascade | S1 |
| P2-GAP-03 | HIGH | D. MFA / strong auth | `StepUpRequirement`/`StepUpCapableAuthenticator` markers exist; no MFA implementation, no step-up challenge flow, no enforcement | `contracts.ts` (interfaces only) | Provider-neutral TOTP (RFC 6238) + step-up enforcement at the A-01 decision point | S5 |
| P2-GAP-04 | HIGH | F. Privileged access | No privileged plane (enumerated §1.6): ad-hoc role checks, no elevation windows, no break-glass, no privileged review, `global_admin` = indefinite role flag | §1.6 | Dedicated privileged plane: plane roles, JIT elevation, per-operation gates, break-glass, review | S3 (+S6) |
| P2-GAP-05 | HIGH | C. Sessions (token lifecycle) | The durable session row exists; the BEARER is the raw static token (never rotates); no session tokens, no rotation, no concurrent-session policy, no fixation defense | `authentication-event-store.ts` (row only) | Opaque per-session tokens (fingerprinted), rotation chain, concurrent-session policy, cascade revocation | S2 |
| P2-GAP-06 | HIGH | §4 Delegation | No delegation primitive: work can only be performed by the authenticated principal; no scoped/expiring/constrained delegation | no such store/stage (verified) | Durable delegation grants + A-01 stage + chain semantics + cross-tenant refusal | S4 |
| P2-GAP-07 | MEDIUM | E. Federation | Only `OIDC` method token + contract; no SAML/enterprise federation seam; OAuth 2.x grant choices unspecified | §1.1 | OIDC implemented (S1); OAuth 2.x grant scoping specified within it; SAML = documented seam/contract only (no implementation without demonstrated requirement) | S1/S5 |
| P2-GAP-08 | MEDIUM | §9 Key management | No signing-key seam for identity material (JWKS pinning, MFA secrets, future session signing); credential-material provider contract (A-01) covers broker material only | `credential-store.ts` (broker material only) | `KeyManagementSeam` contract + external-provider wiring + rotation/versioning/revocation + fail-closed; no KMS/HSM availability claim | S7 |
| P2-GAP-09 | MEDIUM | §10 Audit | Identity/privilege audit events undefined: authentication events exist; lifecycle/privilege/delegation/break-glass events do not | `authentication.events` (auth only) | Privileged security event catalog (§14) on the SAME authoritative store (no second security authority store) | S1–S6 (per-slice) |
| P2-GAP-10 | MEDIUM | A/B (takeover resistance) | Account-takeover surface: bearer-token-only, no rotation, no MFA, no disablement cascade | T1 (P1 spec §13) | Closed by GAP-01/03/05 controls jointly | S1/S2/S5 |
| P2-GAP-11 | MEDIUM | B (recovery) | No identity recovery (no challenge/binding/one-shot reset semantics) | none (verified) | Durable recovery records, one-shot, bound, expiring | S1 |
| P2-GAP-12 | MEDIUM | F (notification) | No event notification plane for break-glass/privilege events (bus exists; no delivery) | event bus (canonical) | Bus event emission + durable event record; EXTERNAL delivery explicitly out of scope (no claim) | S6 |
| P2-GAP-13 | — (EXTERNAL) | A/E (provider/KMS) | Production IdP deployment + KMS/HSM vendor selection (D2) | external | Owner/ops decisions; P2 ships contracts + provider-neutral implementations verified against honest test doubles | S7 |
| P2-GAP-14 | LOW | A (documentation) | `types.ts` comment references nonexistent `OidcAuthenticator` | §1.7 Δ-1 | Resolved by S1 (class implemented ⇒ comment true) | S1 |

**Summary:** 14 entries — 2 CRITICAL, 5 HIGH, 6 MEDIUM, 1 external, 1
documentation. All P2 gaps are mapped (§22 acceptance gate: every gap has a
slice, a control, tests, and evidence).

---

## 3. Target architecture

### 3.1 The ten-link chain (task objective)

```
IDENTITY        →  AUTHENTICATION   →  SESSION      →  AUTHORIZATION
(durable records,   (OIDC crypto      (opaque tokens,   (existing A-01
 membership,        proof; policy     rotation,        PDP + NEW privilege
 roles, lifecycle)  admission)        revocation)      stage + delegation
                                                        stage)
        →  DELEGATION   →  PRIVILEGE      →  ADMINISTRATION →  REVOCATION
 (durable grants,  (plane roles, JIT     (governed ops:  (durable cascade:
 chains, scope,     elevation,           approvals,      disable ⇒ sessions
 expiry)            break-glass)         audit)          + tokens + grants)
        →  AUDIT          →  RECOVERY
 (privileged event   (one-shot bound
  catalog, same      recovery)
  authoritative
  store)
```

### 3.2 Components (new vs extended)

| Component | Kind | Location (proposed) |
| --- | --- | --- |
| Identity stores (principals, memberships, role-assignments, recovery, delegation) | NEW | `@jataqi/authentication` (new modules; same package family — identity and authentication are one plane; storage: the existing PG authoritative substrate) |
| `OidcAuthenticator` (+ JWKS verifier) | NEW | `@jataqi/authentication` |
| MFA (TOTP) + step-up flow | NEW | `@jataqi/authentication` |
| Privileged plane (elevations, break-glass, plane roles) | NEW | `@jataqi/authentication` (plane state) + A-01 pipeline stage (enforcement) |
| Session token layer | NEW over existing S-8 | `@jataqi/authentication` |
| Key-management seam | NEW (contract + wiring) | `@jataqi/authentication` (contract); external provider via owner/ops (S7) |
| A-01 decision pipeline | EXTENDED | `@jataqi/authorization-boundary` (two new ordered stages: privilege, delegation — both fail-closed, both audit-logged) |
| `PrincipalBoundary` / policy / module | EXTENDED | authenticator admission of `ProductionAuthenticatorContract` in production; identity-store boot canary |
| CLI posture (`security-posture.ts`) | EXTENDED | new P2 invariants (§15) |
| Audit | EXTENDED (same store) | new collections on the authoritative substrate; `authorization.decisions` unchanged as the decision-of-record |
| `loop-host` dispatch | EXTENDED (minimal) | dispatch re-validation already covers sessions; delegation/privilege are decided at A-01 BEFORE enqueue/dispatch (no host-side privilege logic) |

### 3.3 Trust boundaries (explicit)

```
┌────────────────────────────────────────────────────────────────────────┐
│ UNTRUSTED: network, presented credentials, claims in tokens,          │
│             operator-supplied principal files (treated as data)       │
├────────────────────────────────────────────────────────────────────────┤
│ T1: AUTHENTICATION BOUNDARY (T-03 PrincipalBoundary + P1 policy)      │
│   • policy admission BEFORE authenticator (verified §1.1)             │
│   • independent validation of authenticator output (verified)         │
│   • P2: ProductionAuthenticatorContract admission in production       │
│   • P2: identity-store lookup (subject→principal, membership, state)  │
├────────────────────────────────────────────────────────────────────────┤
│ T2: SESSION LAYER (R2 S-8 + P2 session tokens)                        │
│   • record-before-principal (verified); deny-early expiry (verified)  │
│   • P2: opaque tokens → session rows; rotation; concurrent policy     │
├────────────────────────────────────────────────────────────────────────┤
│ T3: AUTHORIZATION PDP (A-01, mandatory, fail-closed)                  │
│   • existing 14-step pipeline (verified) + NEW: privilege stage,      │
│     delegation stage (ordered AFTER principal/tenant, BEFORE capability)│
│   • durable Phase-B transaction (verified)                            │
├────────────────────────────────────────────────────────────────────────┤
│ T4: PRIVILEGED PLANE STATE (elevations, break-glass, review)          │
│   • plane roles ≠ commercial roles (separate closed vocabulary)       │
│   • elevation validity re-checked at T3 every decision                │
├────────────────────────────────────────────────────────────────────────┤
│ T5: AUTHORITATIVE STORE (PostgreSQL; RLS + FORCE; INV-15 blind        │
│     sessions; sole security-authoritative substrate — R2 rule 1)      │
│   • NO second security-authority store (task §10)                     │
└────────────────────────────────────────────────────────────────────────┘
```

Rules: (1) no authority crosses a boundary without a durable, verifiable
evidence object (principal, session, envelope, elevation, grant); (2)
every layer fails closed on substrate failure (no memory fallback — R2
rule 1, preserved); (3) the kernel-internal identity (`KERNEL_INTERNAL`)
remains minted only by the composition root, HMAC-signed, closed scopes —
P2 does not widen it; (4) `system`-tenant rows (platform-level identity)
are written only by enumerated system-scope transactions (INV-15
registry — new labels require explicit enumeration at boot else boot
fails).

---

## 4. Identity model

### 4.1 Durable identity stores (new collections — additive, same substrate)

| Collection | Key doc | Tenant scoping | Notes |
| --- | --- | --- | --- |
| `identity.principals` | `principalId` | `tenantId` (membership tenant) + platform rows under `system` tenant | `{principalId, externalSubject?, issuerId?, state, version, createdAt, updatedAt, deactivatedAt?, deactivationReason?}`; state machine §4.2; closed schema + material-field refusal (existing pattern) |
| `identity.memberships` | `(principalId, tenantId)` | per row | `{principalId, tenantId, status: ACTIVE\|SUSPENDED\|REVOKED, since, until?, revokedAt?, revocationReason?}`; a principal may hold multiple memberships (cross-tenant principal, tenant-bound authority — matching the existing "server-verified tenant id" model where authority is always tenant-bound) |
| `identity.role-assignments` | `(principalId, tenantId, role)` | per row | `{principalId, tenantId, role (closed commercial vocabulary), grantedBy, grantedAt, expiresAt?, status: ACTIVE\|REVOKED, revokedAt?}`; **role lifecycle**: grant/revoke are durable, cross-process, audited; the principal's effective role set at authentication = intersection of (token/IdP asserted roles) ∩ (active role-assignments) ∩ membership ACTIVE — never the union; missing/absent assignment ⇒ role absent (fail-closed narrowing) |
| `identity.recovery` | `recoveryId` | per row | `{recoveryId, principalId, tenantId, method, binding (opaque reference, never material), oneShot: true, expiresAt, status: PENDING\|CONSUMED\|EXPIRED\|REVOKED, consumedAt?}` |
| `identity.delegations` | `delegationId` | per row | §8 |

Store contract (all): require transactional driver (existing
`AuthenticationEventStore.open` pattern); closed field allow-lists;
material-shaped-field refusal; CAS-guarded transitions; insert-once where
ids are minted; tenant-scoped transactions; any pre-tenant single-row read
runs through an enumerated, counted system-scope grant (INV-15 Δ-2);
boot canary for each store (§15 P2-INV-03).

### 4.2 Lifecycle state machine (B)

```
ENROLLED → ACTIVATED → (ACTIVE)
              │            │  ▲
              │            ▼  │ re-activation (new verification)
           (rejected)   SUSPENDED
                          │
                          ▼
                      DEACTIVATED (terminal for use; record retained)
                          │
                          ▼
                    DEPROVISIONED (terminal; cascade §4.4; record retained
                                     for audit — rows are never deleted)
```

- **Enrollment:** create `identity.principals` (state `ENROLLED`) +
  membership + role-assignments, all in ONE tenant transaction (atomic —
  no half-identities). Enrollment is a privileged operation (PO-class, §9).
- **Activation:** requires first successful verification through a
  production authenticator (OIDC) — `ACTIVATED` + activation event.
- **Suspension:** durable status flip; effective immediately cross-process
  (every authentication/decision re-reads state in its transaction);
  cascade §4.4 (sessions/tokens/elevations/delegations for the principal in
  that tenant).
- **Deactivation/Deprovisioning:** terminal; cascade; record retained
  (audit); deprovisioning is a privileged operation requiring approval
  (PO-class).
- **Verification:** MFA or re-authentication through the IdP (S5);
  recorded as an identity event.
- **Recovery (B):** one-shot bound challenge (`identity.recovery`);
  consumption is CAS (single use); expiry deny-early (300 s skew, existing
  bound); recovery NEVER re-enables a DEPROVISIONED principal (terminal is
  terminal).
- **Account-takeover resistance (B):** joint control set — MFA step-up
  (S5) + session/token rotation (S2) + disablement cascade (S4.4) +
  recovery one-shot binding (S1). Individually insufficient; together they
  bound the stolen-bearer window to one rotation/revocation latency.
- **Identity linking (B):** `externalSubject` + `issuerId` bind an IdP
  subject to one `principalId` (one-shot; rebind of a taken binding
  refused — same rebind-refusal pattern as S-9 import, verified §1.1).
  Cross-IdP linking requires an admin operation with approval.
- **Role lifecycle (B):** §4.1 role-assignments; revocation is durable and
  takes effect at the next decision (Phase-B re-read) — no caching of role
  sets outside a single decision transaction.

---

## 5. Authentication model (A)

### 5.1 `OidcAuthenticator` (provider-neutral; S1)

Implements `ServerAuthenticator` + `ProductionAuthenticatorContract`.
Verification pipeline (all fail-closed, deterministic error codes):

1. Method = `OIDC`; material = a single-use authorization code or a signed
   token per the configured grant (§5.2); empty/malformed ⇒ reject.
2. **JWKS:** fetch from the pinned `jwks_uri`; pin = configured URL +
   accepted key `kid` set (or JWK set digest at configuration time);
   unknown `kid` ⇒ reject (no silent key acceptance); key rotation is
   operator-driven (update pin ⇒ new boot or configuration reload — no
   runtime un-pinned fetch).
3. **Signature** verification (RS256/ES256 allowed; others rejected).
4. **Claims:** `iss` ∈ configured issuer allow-list; `aud` ∈ configured
   audience allow-list (both mandatory — `validatesIssuerAndAudience=true`);
   `exp`/`nbf` with the shared 300 s deny-early skew; `iat` future-beyond-
   skew ⇒ reject; `sub` non-blank; optional `auth_time` honored for
   step-up recency (S5).
5. **Replay:** `jti` tracked in a durable, bounded single-use store
   (`identity.jti-replay` collection, TTL-bounded, GC interlock); repeated
   `jti` ⇒ reject (`replayResistant=true`).
6. **Tenant mapping:** `sub` (+ `iss`) → `tenantId` via the explicit
   mapping (membership lookup); unknown subject ⇒ reject (no default
   tenant); **tenant substitution impossible**: the tenant is derived
   server-side from the mapping, never from a caller claim.
7. **Principal resolution:** subject → `identity.principals` (state must be
   `ACTIVATED`/active membership; §4.2); role set = asserted ∩ assigned
   (§4.1); the returned `AuthenticatedPrincipal` carries
   `authenticationMethod:'OIDC'`, `verifiedAt`, `authenticationEventId`
   (durable event id — session), `credentialExpiresAt` (token `exp`).
8. **Event durability:** success is recorded record-before-principal by the
   existing boundary path (verified §1.1); failure records are emitted as
   identity audit events (§14) — durable, never log-only.

`health()`: JWKS reachability + last-verified age; `unavailable` ⇒
verification fails closed (INV-14 semantics, existing).

### 5.2 Grant scoping (OAuth 2.x where appropriate)

- **authorization code + PKCE** (interactive human login) — primary.
- **client credentials** (machine-to-machine, service principals) — for
  non-human principals; service principals are identities too
  (`identity.principals` rows with a `service` class marker), subject to
  the same lifecycle and revocation.
- **SAML / enterprise federation:** CONTRACT/SEAM ONLY (task §E: do not
  implement every provider). The seam = `ServerAuthenticator` +
  `ProductionAuthenticatorContract` + a documented SAML assertion-
  verification specification (signature, issuer, audience, conditions,
  replay via `InResponseTo`/`NotOnOrAfter`); implementation requires a
  demonstrated production requirement + separate authorization. **No SAML
  code in P2.**

### 5.3 Credential rotation / account disablement (A)

- OIDC tokens: no local lifetime beyond `exp`; rotation is an IdP-side
  property; the P2-side rotation is the SESSION TOKEN (§6) — a compromised
  session token dies on rotation/revocation even if the bearer credential
  is still valid.
- Static tokens (transition): existing S-9 fingerprint registry rotation
  (revoke old + import new) — already durable and cross-process (verified
  §1.1); P2 adds: static-token registration carries a mandatory
  `expiresAt` in production (no unbounded static tokens; bounded by the
  transition window, D1).
- **Account disablement:** §4.2 cascade — the enforcement points are the
  existing re-validation sites (authentication, Phase-B decision tx,
  dispatch re-validation) plus the new identity-state check inside the
  Phase-B transaction (one additional indexed read, same tenant tx).

### 5.4 No development dependence (A)

Production requires ≥1 authenticator with
`verifiesCryptographicProof=true` (P2-INV-01). The static-token path in
production remains ONLY as the owner-sealed transition (D1;
`JATAQI_ALLOW_STATIC_TOKEN_PRODUCTION` + mandatory bounded `expiresAt` +
deadline invariant P2-INV-11); `none` remains the fail-closed default when
no production identity is configured (honest closure, verified §1.2).

---

## 6. Session model (C)

### 6.1 Session tokens (new over S-8)

- On successful authentication (after record-before-principal), the
  boundary mints a **session token**: 256-bit random opaque string; the
  durable row gains `sessionTokenFp` (SHA-256; one-way — **material is
  never persisted**, mirroring S-9); the token is returned to the caller
  ONCE (authentication receipt); subsequent requests present the session
  token, and verification = fingerprint lookup + row status (no credential
  re-verification; the credential evidence remains cited in the row).
- **Rotation:** `rotate(sessionToken)` ⇒ new 256-bit token, new fingerprint,
  OLD fingerprint REVOKED (CAS; the previous token stops working
  immediately, cross-process); rotation is bounded (configurable max
  rotations per event; exceeding ⇒ full re-authentication) — prevents
  rotation loops as a DoS.
- **Revocation:** existing `revokeEvent` (verified §1.1) covers the row;
  token revocation = row revocation (single source of truth — no separate
  token-state store).
- **Expiry:** unchanged deny-early semantics (300 s skew); session lifetime
  `(0, 30 days]` capped by `credentialExpiresAt` (existing, verified).
- **Concurrent sessions:** policy = max N active events per (principal,
  tenant) (default N=3, configurable); on exceed: **refuse new** (default)
  or **revoke oldest** (configurable) — never silently accumulate;
  concurrent-session audit events (§14).
- **Session fixation:** tokens are server-minted 256-bit random (not
  derived from request material — the current `authenticationEventId`
  derivation `${requestId}:${hash16}` is replaced by `randomUUID` at record
  time; the old derivation stays for R1 compatibility rows only); a
  presented token that does not exist is a denial, never a mint.
- **Binding:** row binds principal + tenant + method + issuer (OIDC) /
  label (static); verification re-checks all four against the presentation
  context where the context is supplied (cross-context replay ⇒ deny).
- **Survival:** sessions survive process/node boundaries BY CONSTRUCTION
  (shared authoritative store; dispatch re-validation verified §1.4);
  restart ⇒ re-read from store (no local session cache — cache isolation:
  **no** process-local session authority exists or may be added, R2 rule).
- **Replay resistance:** the session token is a bearer REFERENCE to a
  status-checked row (replay of a revoked/expired token ⇒ deny);
  jti-replay (§5.1.5) covers assertion-level replay; the two mechanisms are
  distinct and both durable.

---

## 7. Authorization model (task §3)

### 7.1 What the 95% baseline requires (decision, justified)

| Mechanism | Required for 95%? | Decision |
| --- | --- | --- |
| RBAC (closed role vocabulary, tenant-bound) | YES | PRESERVED as-is (verified; narrowing-only; closed set). P2 adds role LIFECYCLE (assignments durable, revocable, audited — §4.1) but does not widen the vocabulary |
| ABAC (attributes at decision time) | YES — minimal set | Extend the existing A-01 pipeline with attribute checks: identity state, membership status, session freshness/status (existing), **step-up recency** (new, S5), **elevation window validity** (new, S3). Attributes are read inside the Phase-B transaction (no separate policy engine, no attribute store beyond the identity/privilege collections) |
| ReBAC (graph relationships) | NO | **NOT built** (task: "Do not build unnecessary policy complexity without a demonstrated requirement"). The action dimension is already covered by the A-01 capability manifest model (operation/target/classification/impact ceilings); the relationship dimension that would need ReBAC (resource-ownership graphs) has no demonstrated 95% requirement in the canonical product surface. Revisit trigger: marketplace/ownership-based sharing requirements (P6 era) — recorded, not authorized |
| Capability manifests (A-01) | YES | PRESERVED as the action/capability policy (verified; monotonic narrowing; digest-bound approvals) |
| Tenant boundaries | YES | PRESERVED (RLS + tenant transactions + triple-tenant-match at dispatch, all verified) |
| Delegation | YES (P2 objective) | NEW durable grants (§8) — the delegation dimension today is absent |
| Privileged roles | YES | NEW plane (§9) — separate closed vocabulary; does not widen the commercial role set |
| Resource ownership / administrative scope | PARTIAL | Administrative scope = plane-role × tenant-scope × operation-class (§9); resource ownership beyond tenant scope = not required for 95% (recorded) |

### 7.2 Pipeline integration (fail-closed preserved)

Two new ordered stages in the A-01 decision pipeline, inserted AFTER
principal/tenant validation and BEFORE capability evaluation:

```
… principal → tenant → [PRIVILEGE STAGE (new, S3)] → [DELEGATION STAGE
(new, S4)] → agent/run → capability → tool/operation → target →
classification/impact → approval → credential → budget → rate →
discretionary → audit
```

- **Privilege stage:** if the requested operation is classified privileged
  (§9 register) ⇒ require a valid elevation (plane role, tenant/platform
  scope match, window not expired, step-up recency satisfied, not revoked);
  else the stage is a no-ALLOW passthrough (it can only add DENY reasons —
  consistent with the pipeline's "discretionary can only strengthen" rule,
  extended to mandatory stages: a stage defect ⇒ DENY
  `PRIVILEGE_CHECK_UNAVAILABLE`).
- **Delegation stage:** if the request carries a delegation reference ⇒
  verify the grant (§8.2); else passthrough. Defect ⇒ DENY
  `DELEGATION_CHECK_UNAVAILABLE`.
- Both stages write their verdict into the sealed envelope (citable in the
  decision record) and the durable audit (§14).
- **DEFAULT = DENY** remains the pipeline's starting state; no stage can
  convert DENY to ALLOW (existing invariant, verified §1.3).

---

## 8. Delegation (task §4)

### 8.1 Grant record (`identity.delegations`)

```
{ delegationId,
  delegatorPrincipal, delegateePrincipal,
  tenantId,                    // delegation is tenant-bound by default
  capability: { capabilityId, capabilityVersion } | operationClass,
  targetScope: { system, resourcePattern },   // must be a SUBSET of the
                                              // delegator's manifest scope
  actions: readonly string[],   // ⊆ capability operations
  constraints: { maxAgeMs (mandatory, bounded by manifest lifetime floor),
                 budget?, rate?, classificationCeiling?, impactCeiling? },
  chainDepth, chain: [envelopeId…],   // provenance: the delegator's
                                      // authority evidence at grant time
  grantedBy: { principal, authenticationEventId, stepUpEventId? },
  approval?: A01ApprovalBinding,      // mandatory when the capability
                                      // requiresApproval
  oneShot | useCount,
  expiresAt (mandatory), status: ACTIVE|REVOKED|EXPIRED|CONSUMED,
  createdAt, updatedAt }
```

### 8.2 Enforcement (delegation stage, S4)

Verify, in order (any failure ⇒ DENY with a distinct reason code):
1. `delegateePrincipal` == the presenting principal (no acting-as
   someone else's grant).
2. Grant tenant == request tenant (default); **cross-tenant delegation is
   refused** unless the grant carries an explicit `platform` scope AND the
   delegator held a platform-plane elevation at grant time (recorded) AND
   an approval is bound — the only cross-tenant path, fully audited.
3. Requested capability/operation/target ⊆ grant scope (subset check
   against the grant, then against the live manifest — both must pass;
   scope widening at either point ⇒ DENY).
4. Expiry: `now + skew < expiresAt`; use-count/one-shot (CAS-consumed).
5. Status ACTIVE.
6. **Chain integrity (confused deputy):** the grant's `chain` cites the
   delegator's envelope/manifest digest AT GRANT TIME; the grant cannot
   exceed what the delegator held then (delegator authority shrinkage after
   grant ⇒ grant invalid — re-verified against the live manifest at
   decision time, not only at grant time). Chain depth ≤ 2 (default 1;
   configurable; `chainDepth` recorded).
7. Revocation cascade: delegator deprovisioned/suspended ⇒ all their
   grants REVOKED (same tenant transaction); delegatee likewise.
8. Replay: `delegationId` + request correlation dedup in the existing
   consumed-envelope mechanism (the grant is referenced inside the sealed
   envelope; double-use across envelopes ⇒ existing replay denial).

### 8.3 Durability

Security-critical delegation is durable by construction (the grant lives in
the authoritative store; the envelope cites it; the decision re-verifies in
the Phase-B transaction). No process-local grant state exists.

---

## 9. Privileged plane (task §2F, §5)

### 9.1 Plane roles (new closed vocabulary — separate from commercial roles)

```
PrivilegeRole = 'platform-admin' | 'tenant-admin' | 'security-admin'
              | 'operator' | 'break-glass'
```

- Held ONLY in elevation grants (`privileged.elevations`), never as a
  token-table field. The commercial 7-role vocabulary is untouched.
- Mapping at the decision point: an operation requiring "admin" (existing
  ad-hoc checks, PO-1…PO-8) becomes: (a) the service's own role check
  (preserved — defense in depth) AND (b) the A-01 privilege stage requiring
  the corresponding plane elevation for the operation class. Services are
  migrated OFF bare-role privileged operations onto the staged check in
  S3 (per-service, explicitly enumerated; until migrated, the bare check
  remains as the weaker of two gates — the staged gate is the binding one
  once present).
- Plane hierarchy (strict, no transitivity): `security-admin` ⊄
  `platform-admin`; `platform-admin` ⊄ `tenant-admin` (a platform-admin
  acting inside a tenant must hold the tenant elevation); `operator` =
  operational plane (deploy/GC/maintenance classes), never an admin
  decision; `break-glass` = emergency (§10), never a standing role.

### 9.2 Elevation grants (`privileged.elevations`)

```
{ elevationId, principalId, tenantId | 'platform', planeRole,
  operationClasses: readonly string[],   // closed set (§9.3)
  stepUpEventId,                          // the MFA/fresh-auth evidence
  grantedBy (admin identity or break-glass record),
  reason (mandatory, non-blank),
  issuedAt, expiresAt (mandatory; default 30 min; max 4 h),
  status: ACTIVE|REVOKED|EXPIRED,
  revokedAt?, revocationReason? }
```

Validity (privilege stage): ACTIVE + within window + step-up recency
(step-up age ≤ `StepUpRequirement.maxAgeMs` for the operation class) +
not revoked + plane role ∈ the operation's required set + scope match
(tenant or platform). `assertPrivilegeValid` (existing contract, verified
§1.1) is implemented by this check.

### 9.3 Privileged-operation register (from §1.6 enumeration — S3 work items)

| Op class | Members (current) | Required plane role | Step-up? | Approval? | Audit | Revocation behavior | Emergency behavior |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tenant-admin` | PO-1…PO-3, PO-5, PO-8 (per-tenant admin/management/cross-read-within-platform) | `tenant-admin` for the tenant | YES (MFA) when MFA configured | NO (bounded scope) | privileged event | elevation revocation ⇒ immediate deny at next decision | break-glass with tenant scope |
| `platform-admin` | PO-4 (cross-tenant adapter registration), PO-6, PO-7, PO-13 (global_admin surfaces), cross-tenant reads (PO-3/PO-8 platform form) | `platform-admin` | YES | YES (digest-bound, existing S-1 mechanism) | privileged event (platform class) | same | break-glass platform scope (rarest; extra audit) |
| `security-admin` | PO-9 (approval-granting), PO-10 (token import), PO-11 (session revocation), PO-12 (manifest rotation), identity enrollment/deprovisioning (new), plane-role grant | `security-admin` | YES | YES for plane-role grant + deprovisioning | privileged + identity events | same | break-glass security scope |
| `operator` | PO-2, PO-14, PO-15 (maintenance/GC/leases), deployment operations | `operator` | NO (session auth suffices; MFA optional by posture) | NO (budgeted/rate-bounded) | privileged event | same | break-glass operator scope |
| `break-glass` | any of the above, emergency only | `break-glass` | YES (strong auth mandatory) | POST-HOC review record (pre-approval impossible by definition) | full break-glass event (§10) | auto-expiry + explicit revocation | IS the emergency path |

**Rule: no privileged operation may silently rely on ambient authority** —
every register entry names its required identity/role/scope/approval/audit/
revocation/emergency behavior; a privileged operation NOT in the register is
an implementation defect (the register is code + test-asserted, and an
ad-hoc privileged check outside it fails the S3 adversarial matrix case A-13).

### 9.4 Break-glass (task §6)

Activation (all required, one transaction):
1. **Explicit activation** — a named act (`activateBreakGlass`), never
   implicit; requires an identity (human principal OR a sealed pre-provisioned
   break-glass credential registered at deployment — fingerprinted,
   never material; the credential is itself an audited event).
2. **Strong authentication** — MFA step-up (or the sealed credential's
   second factor) with fresh `auth_time` within the step-up window.
3. **Narrow scope** — one operation class OR one named capability set
   (≤ 3 operation classes); tenant-scoped or platform-scoped (explicit).
4. **Short lifetime** — default 15 min, max 60 min; hard cap; no extension
   without a NEW activation (a new record; the old one is terminal).
5. **Mandatory reason** — non-blank, operator-supplied, stored.
6. **Durable audit** — full event (§14 `PRIVILEGE_BREAKGLASS_*`): who
   (activator + identity evidence), what (scope), when, tenant, resource,
   authority (the step-up + registration evidence ids), decision, result,
   correlation (correlationId binding all resulting decisions).
7. **Notification** — event on the canonical bus + durable record; EXTERNAL
   delivery (pager/email) is out of scope (no claim; P7 ops).
8. **Post-event review** — the record carries `reviewRequired: true` +
   `reviewDeadline`; expiry of the deadline without a recorded review
   decision ⇒ durable alert state (surfaced by the security-state health
   probe / boot invariant P2-INV-07); review records are append-only.
9. **Automatic expiry** — enforced at every privilege-stage check (no
   background timer required; deny-early skew).
10. **Revocation** — any `security-admin` or the platform operator can
    revoke any active break-glass (CAS, idempotent, audited).
**Never permanent:** break-glass records are terminal (EXPIRED/REVOKED);
reactivation is a new grant with fresh evidence; there is no state in which
a break-glass credential confers standing authority (verified by adversarial
case A-12).

---

## 10. Tenant isolation preservation (task §7)

INV-15 properties are preserved by construction and re-asserted:

| Property | P2 treatment |
| --- | --- |
| Tenant-bound authorization | All identity/privilege/delegation stores are tenant-scoped collections on the same RLS substrate; Phase-B re-reads happen inside the tenant transaction |
| Explicit transaction scope (INV-15) | Every new store uses `atomically` with explicit tenant scope; pre-tenant single-row reads (JWKS-independent lookups by external subject, session-token fingerprint lookup) use enumerated, counted system-scope grants — **new labels added to `ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS` at S1/S2 time; the boot invariant detects any undeclared pattern** |
| RLS / FORCE RLS | Untouched (probe re-run at every P2 milestone; §18 cases) |
| Fail-closed behavior | Every new component throws/denies on substrate failure (no memory fallback — R2 rule 1) |
| Durable security state | SOLE authoritative store preserved; P2 adds collections, not a competing store (task §10) |

Identity-to-tenant binding: the tenant is derived SERVER-SIDE (IdP subject
mapping §5.1.6 / membership rows) and re-checked at authentication,
Phase-B, and dispatch (existing triple-tenant-match, verified §1.4).

Prevention (each has an adversarial case, §18): tenant substitution
(A-06), forged tenant claims (A-06/A-15), stale membership (A-11 —
membership re-read inside the decision tx), revoked-user access (A-04/A-11),
cross-tenant delegation (A-09 — refused by default; platform path audited).

---

## 11. Token / session security (task §8)

| Aspect | Specification |
| --- | --- |
| Issuance | Server-minted: session tokens (256-bit random, §6.1); delegation/elevation/break-glass ids (`randomUUID`); static tokens (operator-generated, fingerprinted at import — existing S-9) |
| Fingerprinting | SHA-256 one-way for everything durable (existing pattern); document id = fingerprint where the material is the identity (S-9 precedent) |
| Storage | Identity metadata (principal/membership/role/session-row/elevation/grant/break-glass/recovery/jti) — durable, closed schemas. **Secret material (tokens, TOTP secrets, JWKS private artifacts, break-glass credential material) is NEVER persisted in these stores** — material lives in the key-management seam / operator vault (§12); stores carry references/fingerprints only; material-shaped-field refusal (existing pattern) applies to every new collection |
| Rotation | Session tokens (§6.1); static tokens (revoke+import, S-9); IdP keys (operator, pinned); TOTP secrets (re-issuance revokes the old binding, one concurrent binding max + 1 pending) |
| Revocation | Durable, cross-process, CAS-guarded, reason-mandatory (existing patterns reused); cascade §4.4 |
| Expiry | Deny-early 300 s skew everywhere (existing bound); mandatory `expiresAt` on every grant-class record (elevations, delegations, break-glass, recovery, jti) |
| Replay detection | jti durable single-use store (§5.1.5); session-token = status-checked reference (§6.1); delegation consumed-envelope dedup (§8.2.8); break-glass activation one-shot per credential+scope window |
| Session binding | principal + tenant + method + issuer/label (§6.1); cross-context presentation ⇒ deny |
| Audience / issuer | OIDC: both mandatory allow-lists (§5.1.4); session tokens: audience = this deployment (issuer-bound row) |
| Nonce/state | PKCE `code_verifier`/`state` for the interactive flow (transport-level, not persisted); `jti` covers assertion replay |
| Identity metadata vs secret material | HARD separation (task §8): the identity plane stores references; the key-management seam stores material; no code path may persist material outside the seam (enforced by closed schemas + secret-scan CI + adversarial case A-22) |

---

## 12. Key-management seam (task §9)

**Contract (S7; no KMS/HSM availability claim — provider is an external
production dependency, D2):**

```
interface KeyManagementSeam {
  readonly kind: 'dev-inmemory' | 'external';   // production refuses dev
                                                 // (mirrors INV-09 pattern)
  listKeys(purpose: 'signing' | 'encryption'): Promise<KeyRef[]>;
  getSigner(keyId: string, version: number): Promise<Signer>;
  getEncryptor(keyId: string, version: number): Promise<Encryptor>;
  rotate(keyId: string): Promise<KeyRef>;        // new version; old remains
                                                 // verifiable
  revoke(keyId: string, version: number): Promise<void>;
  health(): Promise<IdentityProviderHealth>;
}
KeyRef = { keyId, version, purpose, status: ACTIVE|RETIRED|REVOKED,
           notAfter?, algorithm }
```

- **Key identifiers/versioning:** `(keyId, version)` everywhere evidence
  cites a key (JWT `kid` ↔ `(keyId, version)` mapping); retired versions
  stay verifiable until `notAfter`; revoked ⇒ verification fails.
- **Signing/encryption separation:** distinct `purpose` keys; a signing key
  can never be requested as an encryptor (contract-enforced).
- **Failure behavior:** unavailable ⇒ the dependent verification fails
  closed (OIDC verification, MFA, break-glass all deny; `health()`
  surfaces at boot — P2-INV-08).
- **Bootstrap trust:** initial key material/operator-provided JWKS pins
  enter via the operator secret channel (env/file in dev/staging; KMS/secret
  manager in production) — NEVER from the repository or a production env
  default; the boot invariant refuses a production composition whose
  identity-key configuration came from a development source.
- **Consumers:** OIDC JWKS verification (S1), TOTP secrets (S5), break-glass
  sealed credential (S6), future session-assertion signing (post-P2).
  The A-01 credential-material provider (existing) remains the broker
  material seam; the two seams are distinct and both external in production.

---

## 13. Audit (task §10)

### 13.1 Event catalog (new collection `identity.events` + privileged
extensions of `authorization.decisions` — SAME authoritative store, NO
second security-authority store)

Every event carries the provenance fields (task §10): **WHO** (principalId
+ authenticationEventId + elevationId?), **WHAT** (event kind +
operation/resource), **WHEN** (ts, deny-early skew-tolerated), **TENANT**,
**RESOURCE** (collection + id / capability + operation), **AUTHORITY**
(method, step-up evidence id, approval id, grant id), **DECISION**
(ALLOW/DENY/HELD + reason codes), **RESULT** (outcome + count),
**CORRELATION** (correlationId threading authentication → decision →
dispatch → audit receipt).

| Kind | Emitted at |
| --- | --- |
| `AUTH_LOGIN` / `AUTH_FAILED` | boundary authenticate (success/failure; failure records carry reason class, never material) |
| `AUTH_MFA_STEPUP` | S5 step-up verification (result + method) |
| `SESSION_CREATED` / `SESSION_ROTATED` / `SESSION_REVOKED` / `SESSION_EXPIRED` | §6 lifecycle (rotation cites previous + new fingerprints) |
| `IDENTITY_ENROLLED` / `IDENTITY_ACTIVATED` / `IDENTITY_SUSPENDED` / `IDENTITY_DEACTIVATED` / `IDENTITY_DEPROVISIONED` / `IDENTITY_RECOVERED` | §4.2 transitions (each cites the acting admin + approval where required) |
| `MEMBERSHIP_CHANGED` / `ROLE_CHANGED` | §4.1 (grant/revoke, grantedBy, expiresAt) |
| `PRIVILEGE_ELEVATION` / `PRIVILEGE_REVOKED` | §9.2 (reason, step-up evidence, operation classes, window) |
| `PRIVILEGE_BREAKGLASS_ACTIVATED` / `_REVOKED` / `_EXPIRED` / `_REVIEW_DUE` / `_REVIEWED` | §10 (full §9.4 fields) |
| `DELEGATION_GRANTED` / `DELEGATION_REVOKED` / `DELEGATION_USED` / `DELEGATION_DENIED` | §8 (grant id, chain, subset decision) |
| `CREDENTIAL_CHANGED` (static-token import/revocation; TOTP binding) | S-9/S5 (existing import records extended with the event) |
| `ADMIN_ACTION` (any register operation, §9.3) | the operation site (uniform shape) |
| `POLICY_CHANGED` (manifest registration/rotation; posture invariant set; elevation policy) | existing S-1/manifest records + new posture events |

### 13.2 Integrity

Append-only (rows are never deleted — existing pattern); hash-chaining via
the existing per-tenant ledger mechanism where one exists; tamper-evidence
as today (unkeyed digests — P1-GAP-12 remains a recorded adjacent gap, §25);
audit writes happen INSIDE the decision transaction where the decision is
durable (existing Phase-B) or in the store's own tenant tx otherwise — an
audit-write failure fails the operation (no unaudited ALLOW, existing
INV-05 extended to identity/privilege events).

---

## 14. Production composition (task §11)

Postures: `development` (default, today's behavior preserved exactly),
`test-only` (double opt-in, existing), `staging` (NEW posture name,
behavior = production posture MINUS the transition-window allowances:
staging requires the production authenticator contract but permits the
static-token transition WITHOUT a deadline; staging is explicitly NOT
production — no production claims may cite staging evidence), `production`
(production + all P2 invariants + D1 transition deadline when in use).

No development authenticator may silently become the production
authenticator: (a) existing policy + posture refusals (verified §1.1/§1.2)
preserved; (b) NEW P2-INV-01 (production requires
`verifiesCryptographicProof`-capable authenticator, else the sealed
transition P2-INV-11); (c) authenticator admission at `PrincipalBoundary`
construction extends to reject production-posture authenticators that do
not declare `ProductionAuthenticatorContract` conformance (the
self-declaration rule of the P1 contract, verified §1.1, becomes
structurally checked where the declaration is part of the constructor).

**P2 production boot invariants (declared alongside the P1 set; same
append-only, non-overridable mechanism, evaluated at end of init):**

| ID | Invariant |
| --- | --- |
| P2-INV-01 | production: ≥1 authenticator with `verifiesCryptographicProof=true` registered (else boot failure — or P2-INV-11 transition state active) |
| P2-INV-02 | production: no authenticator from the development set (extends INV-10 to contract level) |
| P2-INV-03 | identity stores reachable: boot canary (mint+read+deny-path against `identity.*` under the canary tenant, GC-cleaned) renders expected outcomes, never an availability failure |
| P2-INV-04 | privilege stage + delegation stage registered on the A-01 pipeline (structural check: the mandatory invariants registry asserts their presence under production) |
| P2-INV-05 | every ACTIVE elevation satisfies the bounded-window policy (max lifetime respected at read) |
| P2-INV-06 | no ACTIVE break-glass older than its hard cap; no break-glass with standing-ability flags (structural) |
| P2-INV-07 | no overdue unreviewed break-glass (review-deadline check; alert state, not silent) |
| P2-INV-08 | key-management seam present and `kind !== 'dev-inmemory'` under production (mirrors INV-09); `health()` not `unavailable` at boot |
| P2-INV-09 | identity-to-tenant mapping configured and non-empty under production when an OIDC authenticator is registered (a registered OIDC authenticator with no tenant mapping can authenticate no one — detected at boot, not at first request) |
| P2-INV-10 | privileged-operation register loaded and test-asserted (the register is data in code; a mismatch between register and the privilege-stage config ⇒ boot failure) |
| P2-INV-11 | (transition only) static-token production transition is SEALED: explicit owner record + mandatory bounded deadline (`JATAQI_STATIC_TOKEN_PRODUCTION_DEADLINE`); past-deadline ⇒ boot failure. No open-ended static-token production |

Deterministic production boot = P1 set + P2 set, same mechanism, same
fail-closed semantics (verified §1.2). Posture is resolved once at boot; no
runtime posture change (existing rule).

---

## 15. Distributed behavior (task §12)

| Scenario | Specification |
| --- | --- |
| Multiple processes | All identity/privilege state in the shared authoritative store; no process-local session/token/elevation/delegation authority (R2 rule; same discipline as verified S-8/S-9); 32-process-class multi-process suites (existing pattern, §18 A-17) |
| Multiple nodes | Store-mediated (no node identity in the security plane; nodes are stateless with respect to it); session validity is store-status, not node state |
| Restart | Re-read from store at boot (canary P2-INV-03) and at every decision; kernel-identity HMAC authority is per-process by design (existing, unchanged) |
| Network partition | Store unreachable ⇒ authentication denies, decisions deny (`SECURITY_STATE_UNAVAILABLE` semantics), dispatch HELD — fail closed, never a local fallback |
| Stale session state | Dispatch re-validation (verified §1.4) + Phase-B session check (verified §1.3) + deny-early skew; stale = deny at the next touch, no timer dependency |
| Concurrent revocation | CAS-guarded transitions (existing pattern); concurrent revoke+use ⇒ the use's transaction sees the post-revocation row or its CAS fails ⇒ deny; 8-way contention suites (§18 A-05) |
| Concurrent privilege changes | Same CAS discipline on elevations/grants; a decision sees exactly one consistent snapshot (single tenant transaction) |
| Database failover | No local replica of security state; post-failover decisions re-read (same fail-closed contract); failover itself is P7 infrastructure — P2 specifies the CONTRACT, P7 qualifies it |
| Clock skew | The single shared 300 s deny-early bound (existing; T-02 and S-8 verified) applied uniformly to sessions, elevations, step-up recency, delegations, recovery, jti; future-beyond-skew ⇒ reject |
| Duplicate authentication events | Insert-once event ids (existing S-8); duplicate jti ⇒ replay denial (§5.1.5); duplicate import ⇒ idempotent skip or rebind refusal (existing S-9) |
| Duplicate elevation/grant activation | One-shot activation records (CAS) — a second concurrent activation for the same scope window fails |

---

## 16. Threat model (task §13)

Format: threat → control → implementation → test → evidence. "Control"
cites the spec section; "test" cites the §18 matrix id; "evidence" = the
artifact that must be committed for E4 (§20).

| # | Threat | Control | Implementation | Test | Evidence |
| --- | --- | --- | --- | --- | --- |
| TH-01 | Credential theft (static/OIDC) | Bounded static tokens + transition deadline; OIDC jti replay; session-token rotation; disablement cascade | S1 §5; S2 §6 | A-02, A-12, A-19 | S1/S2 E4 reports |
| TH-02 | Session theft | Opaque 256-bit tokens (no derivation); status-checked reference; rotation invalidates old; fixation defense (server-minted, unknown ⇒ deny) | S2 §6.1 | A-14, A-18 | S2 E4 |
| TH-03 | Token replay | jti durable single-use; consumed-envelope dedup; one-shot activations | S1 §5.1.5; S6 | A-01, A-08 | S1/S6 E4 |
| TH-04 | Account takeover | MFA step-up on privilege; rotation; cascade; recovery one-shot (no re-enable of deprovisioned) | S5; S2; S1 §4.2 | A-03, A-11, A-20 | S5/S1 E4 |
| TH-05 | Tenant substitution | Server-side tenant derivation; triple-tenant-match; membership re-read in decision tx | §10; existing (verified) | A-06 | S1 E4 (+ regression) |
| TH-06 | Privilege escalation | Privilege stage (elevation required for register ops); plane hierarchy (no transitivity); monotonic narrowing (existing) | S3 §9 | A-07, A-13, A-16 | S3 E4 |
| TH-07 | Confused deputy | Delegation chain re-verified at decision time (delegator's live manifest); depth bound; no acting-as | S4 §8.2 | A-08 | S4 E4 |
| TH-08 | Insider administrator | Digest-bound approvals (existing); admin-action audit with WHO/AUTHORITY fields; review-deadline for break-glass; step-up recency | S3/S6 §9/§10/§13 | A-13, A-15 | S3/S6 E4 |
| TH-09 | Compromised tenant administrator | Tenant-scoped elevations only; platform ops require platform elevation + approval; cross-tenant delegation refused by default | S3/S4 §9.1/§8.2.2 | A-09, A-10 | S3/S4 E4 |
| TH-10 | Compromised worker | A-01 pre-side-effect enforcement (existing); `runUnderEnvelope` (existing); kernel principals closed scopes (existing); worker cannot self-elevate (privilege stage requires an elevation grant — workers hold none by default) | existing + S3 | A-16 (regression) + S3 | S3 E4 + R2 regression |
| TH-11 | Malicious tool | Capability manifest ceilings (existing); delegation subset check; tool authority is the manifest, not a role | S4 (existing) | A-16, A-24 | S4 E4 + R2 regression |
| TH-12 | Malicious agent | Agent run under sealed envelope (existing); no agent can present an elevation (elevation binds a human/service principal + step-up evidence); capability ceilings | S3/S4 | A-07, A-16 | S3/S4 E4 |
| TH-13 | Stale identity | Membership/role re-read inside Phase-B tx; dispatch re-validation (existing) | S1 §4.1 | A-11 | S1 E4 |
| TH-14 | Revoked identity | Durable cascade (sessions+tokens+elevations+delegations in one tx); every re-validation site re-reads | S1 §4.4; S2 | A-04, A-05 | S1/S2 E4 |
| TH-15 | Federation compromise | JWKS pinning (no un-pinned fetch); iss/aud allow-lists; kid pinning; unknown kid ⇒ reject; health fail-closed | S1 §5.1 | A-15, A-21 | S1 E4 |
| TH-16 | Break-glass abuse | §9.4 ten requirements (explicit, strong auth, narrow, short, reason, audit, notify, review, auto-expiry, revocation); terminal records | S6 | A-12 | S6 E4 |
| TH-17 | Race conditions | CAS everywhere; single-tx consistent snapshots; contention suites | all slices | A-05, A-17, A-19 | per-slice E4 |
| TH-18 | Database compromise | Existing HIGH residual (P1 spec T10): P2 adds nothing structural here (role separation is P7 ops + D3); P2 ensures identity state CANNOT be a weaker point than the rest (same substrate, same RLS, fail-closed) — recorded, not claimed closed | §10 | regression (RLS probe) | P7 |
| TH-19 | Key compromise | Key versioning + revocation; retired-version window bounded; rotation runbook; signing/encryption separation | S7 §12 | A-21 | S7 E4 |
| TH-20 | Audit tampering | Append-only, closed schemas, in-tx writes; (unkeyed-digest limitation = P1-GAP-12, recorded adjacent) | §13 | A-22, A-23 | per-slice E4 |

---

## 17. Adversarial verification matrix (task §14)

Design-only (nothing executed by this specification). Every case has an
OBSERVABLE acceptance criterion (the exact assertion class). "PASS shape"
states what green looks like; a case passes only when the assertion
deterministically holds on the exact artifact.

| ID | Case | Setup | Observable acceptance criterion (PASS shape) |
| --- | --- | --- | --- |
| A-01 | Authentication replay | Same OIDC assertion (same `jti`) presented twice | 2nd presentation ⇒ DENY `REPLAY_DETECTED`; durable jti row CONSUMED; audit `AUTH_FAILED` with replay class |
| A-02 | Expired credentials | Token/assertion past `exp` (and within skew variants) | DENY at the skew boundary exactly per deny-early rule (documented table of 4 boundary cases) |
| A-03 | Revoked credentials | Static token revoked via S-9 mid-session | Next authentication AND next decision AND next dispatch all DENY; no path shows ALLOW after revocation commit (3 re-read sites asserted) |
| A-04 | Revoked sessions | Session revoked; in-flight queued work references it | Dispatch HELD `PRINCIPAL_REVOKED`; work never executed; resume impossible without re-authentication |
| A-05 | Concurrent revocation | 8 processes: 4 revoking, 4 using the same session/token | Zero post-revocation ALLOWs; CAS loser paths produce DENY/HELD (not throws into substrate-failure loop); exactly one revocation row state (terminal) |
| A-06 | Tenant substitution | Forged tenant claim in credential context / mismatched mapping | Tenant derived server-side only; forged claim ignored + DENY; cross-tenant read of identity rows ⇒ RLS refusal (probe re-run green) |
| A-07 | Privilege escalation | Ordinary principal attempts a register operation with NO elevation | DENY `PRIVILEGE_ELEVATION_REQUIRED`; with a tenant-scoped elevation attempted on a platform op ⇒ DENY `PRIVILEGE_SCOPE_MISMATCH` |
| A-08 | Delegated privilege escalation | Delegatee attempts an action outside the grant scope (operation, target, classification, tenant) | DENY with the specific `DELEGATION_SCOPE_*` code for each of the 4 widening attempts; grant row untouched |
| A-09 | Cross-tenant delegation | Grant without platform scope, request in another tenant | DENY `DELEGATION_CROSS_TENANT_REFUSED`; the platform path (explicit scope + platform elevation at grant + approval) succeeds ONLY with all three (3-way assertion) |
| A-10 | Stale membership | Membership REVOKED after enqueue, before dispatch | Dispatch DENY/HELD (membership re-read in Phase-B/dispatch re-validation); audit cites the membership status |
| A-11 | Stale identity (role) | Role-assignment revoked; queued privileged work | Decision at dispatch re-reads roles ⇒ DENY; no role set cached across decisions (two consecutive decisions with the revocation between them show the change) |
| A-12 | Break-glass misuse | (a) break-glass beyond lifetime; (b) reactivation of an expired record; (c) scope expansion mid-window; (d) no-reason activation | (a) auto-expiry deny at the boundary; (b) new record required (old terminal — asserted immutable); (c) DENY (scope frozen at activation); (d) activation refused (reason mandatory) |
| A-13 | Admin impersonation / out-of-register privileged op | A service attempts a privileged op not in the register; a principal with `admin` role but no elevation | Both DENY; the register mismatch is boot-detected (P2-INV-10) — a test flips the register and asserts boot failure |
| A-14 | Session fixation | Attacker-supplied session token value attempted as new session | Unknown token ⇒ DENY, never minted; session id is server-random (asserted non-derivable: 100 minted ids, zero collide with the old derivation pattern) |
| A-15 | Identity/provider mismatch | Assertion signed by a valid kid but wrong `iss`; assertion for `aud` not in allow-list | Both DENY at the claims stage (before any store read — asserted by store-read counter) |
| A-16 | Confused deputy | Delegatee uses the grant after the delegator's manifest is narrowed (delegator authority shrinks post-grant) | DENY (live re-verification); the grant is marked invalid at decision (audit `DELEGATION_DENIED` reason `DELEGATOR_AUTHORITY_CHANGED`) |
| A-17 | Restart | Authenticated session in flight; host process killed and restarted | Session survives (store-mediated); the in-flight work HELDs or resumes by re-validation; NO session state reconstructed from process memory (memory snapshot diff = empty) |
| A-18 | Process fan-out | 32 processes share one store; mixed auth/rotation/revocation load | Zero duplicate session-token accepts; rotation ordering consistent (per-event monotonic fingerprint chain); zero lost revocations |
| A-19 | Node loss | Store becomes unreachable mid-decision (outage injection) | Decision DENY `SECURITY_STATE_UNAVAILABLE` (never ALLOW, never memory fallback); recovery after restore resumes decisions (existing R2 outage pattern re-run + identity stores included in the outage matrix) |
| A-20 | Failover | Simulated primary loss (test-double failover) | Post-failover: authentication + decisions re-read from the new primary; state identical (row counts + statuses); no divergence window accepted (asserted by pre/post row digests) |
| A-21 | Clock skew | Clocks offset by −301 s / −299 s / +299 s / +301 s against the store clock | Expiry/step-up/elevation boundaries flip exactly at the documented skew (4×4 boundary table across session/elevation/step-up/delegation) |
| A-22 | Audit tampering | Direct row mutation of an `identity.events` record (bypass attempt) | Mutation refused by closed-schema/CAS in-app; at the DB level, the append-only + digest chain detects (row digest mismatch ⇒ decision citing the event DENYs); secret-scan + field-allow-list assert no material persisted |
| A-23 | Duplicate events | Double-submit of enrollment / token import / break-glass activation | Insert-once: second submission DENY (id) or idempotent-skip (import) or one-shot-fail (activation); exactly one durable record in each case |
| A-24 | Capability substitution | Envelope cites a capability version whose manifest was re-registered (narrowed) | DENY (live manifest digest match — existing R2 mechanism, re-run with delegation-extended envelopes) |
| A-25 | Capability/delegation combo replay | Same delegation grant consumed in two envelopes | Second envelope DENY (consumed-envelope dedup); grant use-count = 1 asserted |
| A-26 | MFA step-up staleness | Step-up assertion older than `maxAgeMs` used for a privileged op | DENY `STEP_UP_STALE`; fresh assertion ⇒ ALLOW (pair assertion) |

Coverage check vs task §14 list: replay (A-01/08/25), expired (A-02),
revoked credentials (A-03), revoked sessions (A-04), concurrent revocation
(A-05/18), tenant substitution (A-06), privilege escalation (A-07/13),
delegated escalation (A-08), cross-tenant delegation (A-09), stale
membership (A-10/11), admin impersonation (A-13), break-glass misuse
(A-12), token rotation races (A-18/05), session fixation (A-14),
identity/provider mismatch (A-15), restart (A-17), process fan-out (A-18),
node loss (A-19), database outage (A-19), failover (A-20), clock skew
(A-21), audit tampering (A-22/23), duplicate events (A-23/25), capability
substitution (A-24), confused deputy (A-16). **All 26 mandated cases have
observable criteria.**

---

## 18. P0 acceptance mapping (task §15)

Rubric: `JATA-P0-95-v1.1` only. **No points are awarded or projected here.**
Column meanings: C = completeness required for the capability to be
evidence-eligible; I = integration (the capability must be INTEGRATED into
the canonical composition, not a standalone library); E = the evidence level
the implementation must REACH to be assessable (E4 = independent
verification of the exact artifact — the program's standing threshold; E5 =
promoted production-qualified artifact); F = freshness requirement (evidence
on the EXACT canonical artifact at assessment time — historical ≠ current,
rubric V4); Q = quality bar (adversarial matrix green + fail-hard suites +
zero skipped). The v1.0 E-coefficient schedule is absent (P0R-RUB-02) — no
numeric coefficients are stated or implied. Dimension IDs are the
directive-provided mapping (v1.0 text absent; per P0R-RUB-02 no dimension
content is re-derived).

| Dimension (directive mapping) | P2 capability | C (what "complete" means) | I | E | F | Q |
| --- | --- | --- | --- | --- | --- | --- |
| D01 Security | S3 privilege plane; S6 break-glass; S10 tenant-isolation preservation | Register + staged enforcement + cascade live in the composition; A-07/09/12/13/16/26 green | INTEGRATED (A-01 pipeline stages; CLI posture invariants) | E4 (separate-party, exact artifact, report committed) | exact-artifact | fail-hard PG suites; zero skip |
| D02 Identity/access | S1 identity core + OIDC; S2 sessions; S5 MFA/federation | Full lifecycle state machine + production authenticator + rotation + MFA + step-up; A-01…A-06/11/14/15/26 green | INTEGRATED (PrincipalBoundary wiring; production posture) | E4 | exact-artifact | 32-process class suites; boundary tables |
| D12 Reliability/distributed | S8 distributed assurance; all stores' distributed behavior | A-17…A-23 green (restart, fan-out, node loss, outage, failover, skew, tamper, duplicates) | INTEGRATED (shared substrate; dispatch re-validation) | E4 | exact-artifact | outage/failover harnesses (test-class; P7 qualifies production) |
| D13 Observability/operations | §13 audit catalog; P2-INV health surfaces; `health()` contract | Event catalog emitted + assertable; boot invariants observable; secret-free diagnostics | INTEGRATED (same store; Phase-B tx) | E4 | exact-artifact | audit-shape assertions (WHO/WHAT/WHEN/TENANT/RESOURCE/AUTHORITY/DECISION/RESULT/CORRELATION) |
| D15 Governance/autonomy | Delegation (§8); approvals (existing, extended); break-glass review loop; register governance | Delegation grants durable + enforced; digest-bound approvals on privileged ops; review-deadline state machine; register is data + test-asserted | INTEGRATED (A-01 stages; S-1 mechanism) | E4 | exact-artifact | A-08/09/16/25 + register boot-invariant |

**Honesty clause:** until a committed E4 report exists for a slice on the
exact canonical artifact, that slice's P0 contribution is ZERO under the
v1.1 integrity rules (implementation-without-independent-verification ⇒ no
points — the rule that blocked P1 credit, P1-CLOSURE §7.3, applied without
change). This mapping is an ACCEPTANCE SPECIFICATION, not a score.

---

## 19. E4 evidence durability (task §16)

The recurring loss of independent-verification artifacts (T09 → S-1/R2 → P1
→ INV-15; verdicts surviving as PR-ATTESTATION only) is treated as a
governance defect with a designed remedy. **No retroactive credit is
awarded for the lost P1/INV-15 reports** (recorded as losses, not
re-attested).

**Report-durability rule (normative for all P2 slices and future
milestones):**

1. **What must become canonical (committed under `docs/verification/`)
   BEFORE a slice's merge authorization can be granted:**
   - implementation evidence doc (exact diff, commands, results,
     adversarial matrix results, environment, artifact SHA);
   - the independent-verification report of a SEPARATE party (E4) on the
     EXACT artifact/configuration (SHA + env + roles + provider config),
     including its findings register and the remediation record for any
     findings;
   - the slice's acceptance-criteria results (§24 per slice) as an
     assertion-level table (case → command → result);
   - the post-merge verification record (post-merge CI run id + steps).
2. **What does NOT count as canonical evidence:** chat messages, PR
   comments/bodies, uncommitted local reports, sandbox transcripts,
   screenshots. (PR comments may ATTTEST that a canonical report exists;
   the report itself must be in the tree.)
3. **Naming convention:** `P2_<SLICE>_IMPLEMENTATION_EVIDENCE.md`,
   `P2_<SLICE>_INDEPENDENT_VERIFICATION.md`,
   `P2_<SLICE>_FINDINGS_REMEDIATION.md` (where applicable),
   `P2_<SLICE>_POSTMERGE_VERIFICATION.md`.
4. **Verification class:** E4 = separate-party verification of the exact
   artifact (the program's standing threshold, rubric V3/V4/V5 honored);
   E5 = promotion to a production-qualified artifact (P7 territory).
5. **Milestone E4/E5 credit** is receivable only when the rule-1 artifacts
   exist in the canonical record; the first post-P2 v1.1 assessment may
   then evaluate the P2 security/identity dimensions under V1–V5 (no
   projection before that assessment occurs).

---

## 20. Dependencies (task §17)

| Dependency | Class | Status |
| --- | --- | --- |
| PostgreSQL (transactional, RLS + FORCE, INV-15 scope layer) | IMPLEMENTED (canonical) | present at `5d12cc5` (verified §1.5); the substrate for ALL P2 stores |
| Durable security state (R2 store, Phase-B decider) | IMPLEMENTED | verified §1.3; P2 extends (stages, collections) |
| RLS / tenant isolation / FORCE RLS probe | IMPLEMENTED | verified; re-run per milestone |
| INV-15 ambient-scope minimization + enumeration | IMPLEMENTED (merged, PR #28) | verified; new P2 system-scope reads require registry entries (S1/S2 work) |
| Production identity provider (real IdP deployment) | REQUIRED EXTERNAL (production) | NOT implemented, NOT claimed; S1 is provider-neutral (JWKS-pinned) and verifies against honest test doubles; production IdP = owner/ops (P2-GAP-13) |
| Key management (KMS/HSM) | REQUIRED EXTERNAL (production) | S7 = contract + external-provider wiring + dev double; no KMS/HSM availability claimed (task §9 rule honored) |
| Secrets (operator vault / secret manager) | REQUIRED EXTERNAL (production) | dev/staging: env/file (existing pattern); production: operator secret channel via the seam; nothing secret in the repository (scan:r2 enforced) |
| Network (IdP reachability, JWKS) | REQUIRED EXTERNAL (runtime) | fail-closed on unreachability (health + deny); no network dependency in development posture |
| Production infrastructure (VPS/cloud, HA, DR) | REQUIRED EXTERNAL (P7) | P2 specifies contracts only (failover = A-20 test-class); no production deployment (strict non-scope) |
| Observability exporters | NOT required by P2 | structured logging + invariants + audit store suffice for P2 acceptance (D13 mapping); exporters = P7 |

---

## 21. Migration (task §18)

Current identity behavior (verified §1) at migration time: principals exist
only as S-9 token-registry rows (+ optional static-token files); sessions =
`authentication.events` rows; no identity/membership/role-assignment
records; role sets asserted by the token table; `global_admin` as an
indefinite role flag where granted.

**Principle: additive migration, no destructive step, cutover by boot
invariants, rollback = artifact revert.** No destructive migration exists
in this design (nothing is renamed, dropped, or rewritten in place).

1. **Existing tokens (S-9 registry):** remain valid as-is. On first
   successful verification post-P2, a LINK is created: token-registry row →
   `identity.principals` (auto-provision, state `ACTIVATED`, membership +
   role-assignments from the token's binding — one-shot, idempotent,
   rebind-refused). Until linked, verification works via the S-9 path
   (unchanged). Static tokens additionally get a mandatory `expiresAt`
   under production (P2-INV-11 transition deadline) — existing rows
   without `expiresAt` are grandfathered ONLY within the transition
   window; the deadline invariant is what bounds them.
2. **Existing sessions (`authentication.events`):** valid without change;
   they carry no session token (P2 session-token field absent ⇒ the row is
   treated as a pre-token session: bearer = the original credential path,
   status re-validation unchanged). New authentications mint session tokens.
   Pre-token rows expire per their existing `expiresAt` (≤ 30 days — the
   pre-token session population self-drains within 30 days by construction).
3. **Existing static/test credentials:** static — as (1); test credentials —
   unaffected (test-only posture, existing double opt-in).
4. **Tenant memberships / role assignments:** auto-provisioned from the
   first linked verification (1); admin operations (PO register) require
   plane elevations from cutover — the cutover runbook provisions the
   initial `security-admin` elevations via the break-glass-free bootstrap
   path: the FIRST elevation is minted by the composition root under
   `kernel:bootstrap` scope with a mandatory reason + audit (one-time
   bootstrap grant, short lifetime, documented — this is the only
   out-of-band elevation in the design and it is audited as
   `PRIVILEGE_ELEVATION` with `grantedBy: kernel:bootstrap`).
5. **Backwards compatibility:** pre-P2 clients presenting static tokens
   keep working through the S-9 path (unchanged code path); the P2 OIDC
   path is additive. No client-visible breaking change.
6. **Cutover:** production posture with P2 invariants (P2-INV-01…11) at
   boot; the posture flip IS the cutover (deterministic, all-or-nothing,
   verified by the invariant set + canary).
7. **Revocation during migration:** disablement cascades apply to linked
   identities from the moment of linkage; pre-linkage revocation remains the
   S-9 path (unchanged).
8. **No destructive migration without explicit authorization:** enforced —
   the migration is DDL-additive (new collections + indexes only, via the
   existing `ensureResource`/`ensureIndex` paths); any future DROP/rewrite
   is a separate authorization by definition.

---

## 22. Rollback (task §19)

Per-slice deterministic rollback boundaries (all slices additive; rollback
never restores a known-insecure default — the pre-P2 state was
fail-closed-by-default: closed ingress or sealed transition; that property
is preserved across every rollback boundary):

| Boundary | Rollback |
| --- | --- |
| Database migrations | DDL-additive only (§21.8); rollback = stop using new collections (rows retained for audit); no DROP in any slice; a future DROP is a separately-authorized destructive act |
| Configuration | Posture resolution is boot-time; rollback = revert the environment/config to the previous artifact's values (deterministic, no runtime state to unwind); P2-INV set declared only under production posture with P2 config present |
| Identity-provider rollback | OIDC authenticator removed from configuration ⇒ boundary falls back to the previously-registered authenticators (or closed ingress) — the `PrincipalBoundary` construction is fail-closed on any misconfiguration (verified pattern); JWKS pin reverts with the config |
| Session cutover rollback | Pre-token sessions and token sessions coexist (§21.2); reverting the artifact leaves token-bearing rows inert but status-valid (their bearers re-authenticate via the old path); no row migration needed |
| Token invalidation strategy | On ANY P2 rollback with a suspected compromised token population: `revokeByPrincipal`/`revokeByFingerprint` (existing, cross-process, durable) — invalidation does not depend on P2 code remaining deployed |
| Privilege-plane rollback | Elevations/delegations rows are inert without the pipeline stages (stages absent ⇒ pre-P2 ad-hoc checks apply — WEAKER, so the rollback boundary is explicitly "revert artifact AND record the weakened window in the audit"); the invariant set prevents a production boot in the mixed state (P2-INV-04: stages present ⇔ P2 posture) |
| Emergency recovery | Break-glass remains the emergency path in every state (it is itself rollback-safe: records terminal, activation one-shot); kernel `kernel:bootstrap` first-elevation path is the bootstrap recovery (documented, audited) |
| Security-rollback rule | No rollback step may re-enable: test authority in production, unbounded static tokens, ambient scopes, or non-durable session state — each is a P1 invariant that remains declared under the previous artifact (rollback re-enters a previously VERIFIED state, not an unverified one) |

---

## 23. Acceptance criteria (milestone-level, task §22 gate)

P2 is ready/complete when ALL hold (each maps to a verifiable artifact):

1. Every P2 gap mapped: §2 register — 14/14 with slice+control+test+evidence. ✔ (this document)
2. Trust boundaries explicit: §3.3. ✔
3. Production identity separated from development authentication: P2-INV-01/02 + §5.4 (static-token transition sealed, bounded). 
4. Privileged authority explicit: §9.3 register (code + test-asserted; P2-INV-10). 
5. Tenant binding explicit: §10 (server-side derivation; triple-match preserved). 
6. Delegation constrained: §8 (subset, bounded, chained, cross-tenant-refused, consumed). 
7. Revocation durable: §6.1/§4.4 (CAS, cross-process, cascading, reason-mandatory). 
8. Sessions survive process/node boundaries safely: §6.1/§15 (A-17/A-18/A-19). 
9. Break-glass controlled: §9.4 (ten requirements, A-12). 
10. Audit durable: §13 (catalog + integrity + in-tx writes). 
11. Production key-management seam defined: §12 (contract + fail-closed + no KMS/HSM claim). 
12. Distributed failure behavior specified: §15 + A-17…A-23. 
13. Adversarial tests concrete: §17 (26/26 with observable criteria). 
14. Migration and rollback bounded: §21/§22 (additive; no destructive step; per-slice boundaries). 
15. P0 mapping explicit: §18 (D01/D02/D12/D13/D15; no points awarded). 
16. Evidence requirements durable: §19 (report-durability rule). 
17. Implementation slices independently verifiable: §24 (each slice: scope, acceptance, rollback, E4 report).

**Gate status: 17/17 satisfied at specification level.** Implementation
acceptance per slice is defined in §24.

---

## 24. Implementation slices (task §21)

Independently verifiable slices; each has: scope, dependencies, files,
acceptance criteria, rollback boundary, evidence deliverables.

### P2-S1 — Production Identity Core (RECOMMENDED FIRST SLICE)

- **Scope:** identity stores (`identity.principals`, `identity.memberships`,
  `identity.role-assignments`, `identity.recovery`, `identity.jti-replay`) +
  lifecycle state machine + enrollment/deprovisioning workflows +
  recovery one-shot + `OidcAuthenticator` (JWKS-pinned, provider-neutral,
  full claims pipeline) + OIDC wiring into `PrincipalBoundary` +
  tenant-mapping + identity-state check inside the Phase-B transaction +
  identity audit events (§13 catalog, identity subset) + P2-INV-01/02/03/09 +
  INV-15 registry entries for the new system-scope reads + migration
  auto-linking (§21.1) + Δ-1 resolution.
- **Dependencies:** canonical baseline only (S8/S9 stores, A-01 pipeline,
  posture mechanism — all verified present). No external IdP required for
  implementation or verification (honest JWKS test double; real IdP is
  operational, P2-GAP-13).
- **Likely files:** `packages/authentication/src/` (new:
  `identity-store.ts`, `identity-lifecycle.ts`, `oidc-authenticator.ts`,
  `jwks-verifier.ts`, `jti-replay.ts`; extended: `authentication-module.ts`,
  `types.ts` (comment fix), `index.ts`), `packages/authorization-boundary/src/durable-decider.ts`
  (+ identity-state read in Phase-B), `packages/cli/src/security-posture.ts`
  (P2 invariants), `packages/cli/src/bootstrap.ts` (OIDC config),
  `packages/storage-postgres/src/system-scope-audit.ts` (new enumerated
  labels), tests (new `p2-s1-*.test.ts` incl. real-PG fail-hard + 8-process
  contention), `docs/verification/P2_S1_*.md` (rule §19).
- **Acceptance criteria:** A-01/02/03/06/11/15/22/23/26 (subset) green;
  OIDC pipeline boundary tables (kid/iss/aud/exp/nbf/iat/jti — the
  4-case skew tables); identity lifecycle state machine all-transitions
  asserted; deprovisioning cascade (sessions+tokens+future grants) asserted;
  auto-linking idempotent + rebind-refused; P2-INV-01/02/03/09 fire on the
  violation matrix (each invariant: one negative test + one positive);
  INV-15 boot invariant green with the new labels declared (and red with an
  undeclared label — negative control); full 50/50 regression; committed
  E4 report per §19.
- **Rollback boundary:** §22 (additive collections; config revert; OIDC
  removal falls back to prior authenticators or closed ingress).
- **Boundedness:** one package family + one pipeline read + posture
  invariants; no other slice's surface touched. **VERIFIABLE IN ISOLATION:
  yes.**

### P2-S2 — Durable Session / Token Lifecycle

- **Scope:** session tokens (mint/verify/rotate/expire) over S-8;
  concurrent-session policy; fixation defense (server-random ids); cascade
  revocation hooks; migration coexistence (§21.2); audit events (session
  subset).
- **Dependencies:** S1 (identity linkage for per-principal policies).
- **Acceptance:** A-04/05/14/18/19 green; rotation-chain monotonicity
  asserted; unknown-token-never-minted (100-id non-derivation assertion);
  32-process fan-out (existing harness class); full regression; E4 report.
- **Rollback:** §22 session-cutover row.

### P2-S3 — Privileged Access Plane

- **Scope:** plane-role vocabulary + `privileged.elevations` store +
  privilege stage in the A-01 pipeline + privileged-operation register
  (data + code + test-asserted) + migration of the enumerated PO-1…PO-8
  ad-hoc checks onto the staged gate (service-by-service, explicitly
  listed in the slice plan) + first-elevation bootstrap path + audit events
  (privilege subset) + P2-INV-04/05/10.
- **Dependencies:** S1 (identity + audit), S2 (session binding for
  elevation step-up evidence).
- **Acceptance:** A-07/13/16/24/26 green; register completeness test
  (every PO entry enforced by a case); plane-hierarchy non-transitivity
  (pairwise matrix); P2-INV-04/05/10 violation matrix; R2 regression
  (manifest/approval suites unchanged); E4 report.
- **Rollback:** §22 privilege-plane row (weakened-window audit rule).

### P2-S4 — Delegation + Policy

- **Scope:** `identity.delegations` store + delegation stage + grant
  lifecycle + chain semantics + cross-tenant refusal + consumed-envelope
  integration + audit (delegation subset).
- **Dependencies:** S3 (plane elevation for platform-scope grants), S1.
- **Acceptance:** A-08/09/16/25 green; 4-way scope-widening table;
  3-way cross-tenant platform path; depth-bound (1/2) behavior; E4 report.
- **Rollback:** grants inert without the stage (§22).

### P2-S5 — MFA / Federation

- **Scope:** TOTP (RFC 6238, provider-neutral; secrets via the key-management
  seam; one concurrent + one pending binding; re-issuance revokes old) +
  step-up challenge flow (`StepUpCapableAuthenticator` implemented) +
  step-up recency in the privilege stage + `auth_time` handling + SAML
  SEAM SPEC (contract + verification spec, NO SAML code) + IdP health
  surfacing + audit (MFA subset) + P2-INV (MFA-on-privilege posture option).
- **Dependencies:** S1 (identity), S3 (step-up consumer), S7 (seam — S7 may
  precede or parallel; TOTP secrets need the seam, dev double otherwise).
- **Acceptance:** A-26 green + TOTP vector suite (RFC 6238 test vectors);
  step-up staleness boundary table; SAML seam = contract compiles + doc
  only (no implementation asserted); E4 report.
- **Rollback:** MFA optional-by-posture (privilege step-up requirement
  config reverts; elevations without step-up evidence are then invalid —
  the stage stays fail-closed; config defines which step-up methods
  satisfy).

### P2-S6 — Break-Glass + Administrative Controls

- **Scope:** `privileged.break-glass` store + activation/revocation/review
  state machine + sealed break-glass credential (fingerprinted via the
  seam) + notification (bus events + durable record; NO external delivery
  claim) + review-deadline alert state + admin-action audit uniformity +
  P2-INV-06/07.
- **Dependencies:** S3 (plane), S5 (strong auth), S7 (seal).
- **Acceptance:** A-12 (all four sub-cases) + A-23 (activation one-shot)
  green; review-deadline state machine (pending → due → reviewed/overdue-
  alert); terminal-record immutability; E4 report.
- **Rollback:** records inert without the stage; activation path reverts
  with the artifact.

### P2-S7 — Production Key/Secret Integration

- **Scope:** `KeyManagementSeam` contract (§12) + dev double (honestly
  labeled) + external-provider adapter INTERFACE + rotation/versioning/
  revocation semantics + JWKS pin integration + TOTP-secret integration +
  break-glass-seal integration + P2-INV-08 + NO KMS/HSM availability claim.
- **Dependencies:** S1 (JWKS consumer); S5/S6 (seal consumers) — S7 may
  run in parallel after S1 and be completed with S5/S6.
- **Acceptance:** §12 contract tests (signing/encryption separation,
  revoked-key denial, rotation window); dev-provider refusal under
  production (P2-INV-08 negative test); secret-scan clean; E4 report.
- **Rollback:** seam is additive; reverting removes the P2-INV-08
  requirement (config).

### P2-S8 — Distributed Failure / Recovery Assurance

- **Scope:** the §15 behavior suite as a first-class test program (not new
  product code where avoidable): A-17…A-23 end-to-end on the fully-built
  P2 tree (32-process, restart, outage injection, failover test-double,
  skew matrix, tamper, duplicates) + runbook (operator-facing: recovery
  steps per failure class) + the P2 post-milestone E4 pass over the whole
  P2 tree (this is the milestone-level E4 of §18/§19).
- **Dependencies:** S1–S7 complete.
- **Acceptance:** A-17…A-23 green on the exact final artifact; runbook
  committed; whole-tree E4 report committed; first post-P2 v1.1 scoring
  assessment (assessment-only; no projection) recorded.
- **Rollback:** n/a (verification milestone).

### Slice dependency graph & minimum first slice

```
S1 (Identity Core) ──┬─► S2 (Sessions) ──► S3 (Privileged Plane) ──┬─► S4 (Delegation)
                     │                                              ├─► S6 (Break-Glass)
                     ├─► S7 (Key/Secret seam)  ─────────────────────┤        ▲
                     └─────────────────────────────────────────────┴─► S5 (MFA/Federation)
                                                                            │
                                          S1–S7 ──► S8 (Distributed Assurance + milestone E4)
```

**RECOMMENDED MINIMUM FIRST IMPLEMENTATION SLICE: P2-S1 (Production
Identity Core).** Rationale: it is the foundation for every later slice; it
is fully bounded (one package family + one pipeline read + posture
invariants + enumerated scope labels); it requires NO external production
dependency for implementation or verification (provider-neutral OIDC +
honest test doubles; the real IdP is an operational decision); it closes the
two CRITICAL gaps (P2-GAP-01/02) and resolves the Δ-1 documentation delta;
and its acceptance criteria are concrete and independently verifiable
(§24-S1). S1's E4 report — committed per §19 — additionally begins the
durable-evidence chain the P0 assessment needs.

**S1 explicit call-out for separate authorization:** P2-S1 is hereby
proposed, with the exact acceptance criteria above, as the minimum first
implementation slice. **Its implementation is NOT authorized by this
document.** A separate explicit implementation authorization naming P2-S1
(scope text, D1–D4 resolutions, G10/G19 handling, verification criteria,
report-durability rule, scoring rules, rollback boundary) is required before
any S1 code change.

---

## 25. Adjacent gaps discovered (RECORDED ONLY — strict non-scope honored)

| # | Gap | Home (recorded) |
| --- | --- | --- |
| AG-1 | R-9: CI not a required merge gate (ruleset `20134880` lacks `required_status_checks`; verified live 2026-09-09) | CI governance track (admin token) |
| AG-2 | P1C-OBS-01 harness flake (documented, not remediated) | separate test-only authorization |
| AG-3 | G10 (OPEN/UNATTRIBUTABLE; log content egress-blocked; retention decaying) | evidence-only track |
| AG-4 | G19 (UNRECOVERED) | passive source watch |
| AG-5 | P1-GAP-12: envelope integrity unkeyed SHA-256 (tamper-evidence, not origin authenticity) | defense-in-depth (optional, later) |
| AG-6 | P1-GAP-10 (load characterization) / P1-GAP-13 (retention/GC operations) | operational (INV-16/P7) |
| AG-7 | T09 L-1…L-8 + F-6 register items (commercial/money) | P6 era |
| AG-8 | D1–D4 owner decisions (static-token production default; KMS/HSM provider; DB role provisioning; slice granularity) | owner record at implementation authorization |
| AG-9 | Dormant stream disposition (167-commit `arena/019fccab` + tag v1.0.0; unverified) | owner strategy decision (integration is a separately-audited program) |
| AG-10 | PR #1 open (pre-program) | governance housekeeping |
| AG-11 | P1/INV-15 independent-verification reports lost (PR-ATTESTATION only) | recorded as losses; §19 prevents recurrence; NO retroactive credit |

None of AG-1…AG-11 is expanded into P2 scope by this specification.

---

## 26. Governance status

**Performed under this authorization (documentation only):**
source-verified reconnaissance at `5d12cc5` (read-only git + GitHub API);
the P2 gap register; the target architecture, identity/authentication/
session/authorization/delegation/privileged-plane/break-glass/tenant/
token/key/audit/composition/distributed specifications; the threat model;
the 26-case adversarial matrix with observable criteria; the P0 acceptance
mapping (no points); the E4 durability rule; dependencies; migration;
rollback; slices; the first-slice recommendation.

**NOT performed / NOT authorized by this document:** any production
identity implementation (zero `src/` changes); external IdP integration;
KMS/HSM deployment; production rollout; merge; commit/push/PR (the two
artifacts are in the working tree, UNCOMMITTED — canonical persistence is a
separately-authorized housekeeping step, and §19 makes it a hard
requirement before any P2 merge authorization); P2/R3/production/120%
authorization; G10/G19/P1C-OBS-01 action; rubric modification; P0 score
change (9.484375% preserved; no projection).

**Governance model (preserved):**
`AUDIT → AUTHORIZATION → IMPLEMENTATION → TEST → COMMIT/PUSH → PR →
INDEPENDENT VERIFICATION → EXPLICIT MERGE AUTHORIZATION → MERGE →
POST-MERGE VERIFICATION`. This milestone completed AUTHORIZATION +
SPECIFICATION. IMPLEMENTATION awaits the separate explicit authorization of
the first slice (§24).

**STOP.**
