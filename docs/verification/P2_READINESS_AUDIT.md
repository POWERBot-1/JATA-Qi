# P2 READINESS AUDIT — CURRENT-STATE INVENTORY & PROVENANCE RECORD

> **Scope:** P2 readiness + implementation specification (documentation-only
> authorization). This record is the source-verified current-state
> inventory behind `docs/P2_PRODUCTION_IDENTITY_PRIVILEGED_PLANE_SPECIFICATION.md`
> (the Specification). Method: direct inspection of canonical source at
> `5d12cc5` (NOT re-derivation from the prior P1 audit) + read-only GitHub
> API checks. No implementation was performed.
>
> **Artifacts:** UNCOMMITTED (commit/push/PR not covered by this
> authorization). Canonical persistence per the Specification §19
> (report-durability rule) is a separately-authorized step.

| Field | Value |
| --- | --- |
| Date of record | 2026-09-09 (UTC) |
| Canonical baseline | `5d12cc57353c4e7cce3af157f5e23efde2c74b28` (HEAD = main, verified `git rev-parse HEAD`) |
| Mode | READ-ONLY reconnaissance + specification. Zero `src/` changes (verified: `git status` — only the two documentation artifacts added) |
| P0 | 9.484375% preserved; no points awarded or projected by this audit |
| G10 / G19 / P1C-OBS-01 | OPEN-UNATTRIBUTABLE / UNRECOVERED / documented-not-remediated — untouched, re-confirmed where canonical state was checked |

---

## 1. Verification method

1. `git rev-parse HEAD` = `5d12cc5…` (canonical baseline confirmed before
   any read).
2. Full-file reads of the identity-surface modules (list in §3 with
   line-level citations).
3. Targeted greps across `packages/*/src` for role/privilege usage
   (complete enumeration — §3.6), OIDC surface, `global_admin`,
   `globalAdmin`, `break-glass`, `elevat`, `stepUp`, `StepUp`,
   `delegat`, `MFA`, `TOTP`, `SAML`.
4. Cross-checks against the P1-era audit (`docs/P1_…SPECIFICATION.md`
   §7.1) to record DELTAS explicitly (§4) rather than assume equivalence.
5. Read-only GitHub API (no mutation): remote refs (canonical state),
   branch ruleset `20134880` (R-9 status), tag/branch inventory.
6. Negative greps for absent capabilities (delegation store, MFA
   implementation, break-glass, key-management seam, SAML, identity
   stores) — absence is claimed only where the grep returned zero hits
   across all `packages/*/src`.

Evidence classes used below:
- **SOURCE** = read at `5d12cc5` this session (file:line cited).
- **REGISTRY** = closed-schema/closed-vocabulary constant (file:line cited).
- **AUDIT** = a prior canonical verification record (P1-CLOSURE, INV-15
  record, R2 record) — cited, not re-executed.
- **API** = read-only GitHub API observation (2026-09-09).
- **DOC** = program document (cited path).

---

## 2. Canonical-state checks (non-identity, re-confirmed)

| Item | Status | Evidence |
| --- | --- | --- |
| Canonical main | `5d12cc5` (merge commit of PR #28) | SOURCE (git) |
| CI on `5d12cc5` | GREEN (run `34359343572`) | AUDIT (INV-15 post-merge verification) |
| Rubric | v1.1 adopted successor; v1.0 base text ABSENT; rubric branch @`36f0026` remote, unmerged | API + DOC (recon §6) |
| R-9 (CI required gate) | OPEN (ruleset `20134880` lacks `required_status_checks`; no required reviewers) | API (2026-09-09, full rule content read) |
| G10 | OPEN / UNATTRIBUTABLE; log blobs retained at source (fresh SAS signatures observed 2026-09-09); egress to Azure storage blocked in this sandbox (TLS failure at 0 bytes — network-class, not G10-specific); attribution technically possible from an egress-capable environment | DOC (recon §4) + this-session observation |
| G19 | UNRECOVERED; re-confirmed class C across every remote ref | DOC (recon §5) + API (ref inventory re-checked) |
| P1C-OBS-01 | DOCUMENTED, NOT REMEDIATED (32-process harness flake) | DOC (P1-CLOSURE §6.2.4) |
| D1–D4 | Open owner decisions (static-token production default; KMS/HSM provider; DB role provisioning; slice granularity) | DOC (P1 spec §12.3; recon §7) |
| P0 score | 9.484375% frozen; D07b = 0/2.25 at `5d12cc5` (v1.1 text absent — no delta computed) | DOC (P1-CLOSURE §7.3) |
| Dormant stream | `arena/019fccab` @`8348cec` (167 commits, tag `v1.0.0`, base `5a3e47d`) — unmerged, unverified, zero credit | API + DOC (recon §6) |
| PR #1 | Open (pre-program, 2026-04-08) | API (recon §6) |

---

## 3. Identity-surface inventory (SOURCE-verified at `5d12cc5`)

### 3.1 `packages/authentication`

| Claim (Specification §1.1) | Evidence |
| --- | --- |
| Closed method union `DETERMINISTIC_TEST, STATIC_TOKEN, OIDC, MTLS, KERNEL_INTERNAL`; frozen recognized list; `PresentedCredential` | SOURCE `src/types.ts:36` (union), `:50` (frozen list), `:95` (credential) |
| `AuthenticatedPrincipal` shape (6 core fields + `credentialExpiresAt`/`claims`); `projectToActor` narrowing-only | SOURCE `src/types.ts:117` (shape), `:182` (narrowing; throws on widening) |
| Role vocabulary closed 7 (`observer, agent, operator, approver, admin, global_admin, system`) | REGISTRY `commercial-control-plane` `RECOGNIZED_COMMERCIAL_ACTOR_ROLES` (cited by `packages/cli/src/auth-config.ts:22-30` import + usage) |
| Admission policy: production default admits `STATIC_TOKEN/OIDC/MTLS`; test-only double opt-in; `KERNEL_INTERNAL` never at ingress; admission BEFORE authenticator | SOURCE `src/authentication-policy.ts:117` (`resolveAuthenticationPolicy`) + `assertMethodAdmitted`; call-order verified in `src/principal-boundary.ts` (policy check precedes registry dispatch) |
| Six-stage boundary pipeline; record-before-principal durable session; lifetime `(0, 30 days]`; cap by `credentialExpiresAt` | SOURCE `src/principal-boundary.ts` (stage sequence + `recordEvent` before `return principal`; invalid-lifetime refusal) |
| Registry: duplicate-id refusal, method dispatch | SOURCE `src/authenticator-registry.ts` |
| Static token: opaque table OR durable registry path when attached (material still required at config) | SOURCE `src/static-token-authenticator.ts` (branch on `store` presence) |
| Durable session store: `authentication.events`; insert-once `recordEvent`; `assertActive` deny-early 300 s; CAS `revokeEvent`; cross-tenant revocation refused; closed allow-list + material-field refusal; transactional-driver required | SOURCE `src/authentication-event-store.ts` (all named methods; `AUTH_SESSION_CLOCK_SKEW_MS = 300_000` at `:32`) |
| Token registry: `authentication.token-registry`; SHA-256 fingerprint doc id; one-shot idempotent import; rebind refusal; `verifyByMaterial` system-scope single-row read; `revokeByFingerprint`/`revokeByPrincipal`; closed schema | SOURCE `src/token-registry.ts` (import: INSERT … ON CONFLICT with fingerprint comparison; rebind ⇒ throw; `revokeByPrincipal` = update-by-principal with reason) |
| Module wiring: `durableSessions.enabled` from storage (fail-closed absent); `authenticatorFactory` seam XOR explicit array; container tokens | SOURCE `src/authentication-module.ts` |
| P1 contracts present as INTERFACES ONLY: `ProductionAuthenticatorContract` (`verifiesCryptographicProof`, `validatesIssuerAndAudience`, `replayResistant`, `health`), `SessionLifecycleContract`, `TokenLifecycleContract`, `StepUpRequirement{maxAgeMs, satisfiedBy}`, `StepUpCapableAuthenticator.verifyStepUp`, `IdentityProviderHealth`, `PrincipalLifecycleHooks`, `PrivilegedIdentityBoundary` | SOURCE `src/contracts.ts` (all named types; grep for implementations of `verifyStepUp`/`assertPrivilegeValid` in `packages/*/src` ⇒ ZERO hits outside contracts.ts) |
| **Δ-1:** `types.ts` header comment asserts "an `OidcAuthenticator` exists as a type-only contract" — **FALSE at `5d12cc5`**: grep `OidcAuthenticator` across `packages/*/src` ⇒ single hit = the comment itself. No class, no type. | SOURCE (negative grep, 2026-09-09) |
| Deterministic test authenticator: test infrastructure only | SOURCE `src/deterministic-test-authenticator.ts` (pure lookup table; never admitted in production by policy) |

### 3.2 `packages/cli`

| Claim (Specification §1.2) | Evidence |
| --- | --- |
| Modes `none` (default, admits nothing, honest limitation string) / `static-token` / `test-only` (double opt-in: mode flag + `allowTestMethod`) | SOURCE `src/auth-config.ts:209` (`resolveCliAuthentication`) |
| `JATAQI_AUTH_TOKEN` from env only (never argv) | SOURCE `src/auth-config.ts` (env read; argv path absent by grep) |
| `FORBIDDEN_EXTERNAL_ROLES = ['system']` (external credentials cannot self-claim `system`) | REGISTRY `src/auth-config.ts:65` (constant), `:110` (enforcement at file parse) |
| Posture resolution `JATAQI_SECURITY_POSTURE`, default `development`, unknown ⇒ throw `P1_POSTURE_UNKNOWN` | SOURCE `src/security-posture.ts:71` (`resolveSecurityPosture`) |
| Pre-boot validation codes: `P1_CFG_UNSAFE_ESCAPE_HATCH`, `_STORAGE_DRIVER_NOT_DURABLE`, `_DURABLE_SECURITY_REQUIRED`, `_DURABLE_AUDIT_REQUIRED`, `_DEV_CREDENTIAL_PROVIDER`, `_DURABLE_SESSIONS_REQUIRED`, `_TEST_AUTH_REFUSED`, `_STATIC_TOKEN_REQUIRES_OPT_IN` | SOURCE `src/security-posture.ts` (code table + `validateProductionSecurityConfig`) |
| Seven kernel invariants (append-only, re-declaration ⇒ error): `p1.production.durable-security` (boot canary `p1-canary`/`p1.boot-canary` must DENY, never availability-fail), `.durable-storage`, `.durable-sessions`, `.credential-material-provider`, `.rls-posture` (probe), `.ambient-scope-minimization` (live `hasAmbientConnectScope()` + `getSystemScopeAudit.undeclaredLabels`), `.security-state-health` | SOURCE `src/security-posture.ts` (invariant declaration block, full file read) |
| `productionAuthenticationConfig`: `none` ⇒ ingress closed; `static-token` ⇒ requires `JATAQI_ALLOW_STATIC_TOKEN_PRODUCTION=true` AND durable-registry-only verification; comment "Production identity (OIDC/mTLS) is P2 (fail-closed)" | SOURCE `src/bootstrap.ts:153-229` (opt-out rejections; the P2 comment is at `:229`, verified verbatim) |
| Operator surfaces: `JATAQI_OPERATOR_GLOBAL_ADMIN=true` ⇒ `['operator','global_admin']` (explicit env opt-in); delivery worker `{tenantId:'system', roles:['system']}`; work ingress method from posture never CLI | SOURCE `src/host-inspect.ts` (env branch), `src/host-command.ts` (worker principal literal), `src/host-ingress-command.ts:1-60` (credential from `JATAQI_AUTH_TOKEN` env; fail-closed unconfigured; no test/SYSTEM fallback) |

### 3.3 `packages/authorization-boundary`

| Claim (Specification §1.3) | Evidence |
| --- | --- |
| Pipeline: ordered fail-closed; DEFAULT DENY with accumulated reason codes; discretionary engine strengthen-only; defect ⇒ DENY `POLICY_ENGINE_UNAVAILABLE` | SOURCE `src/policy-engine.ts` (pipeline order + default-deny + reason accumulation; full semantics re-read at R2/P1, spot-checked this session) |
| Approvals: `A01ApprovalBinding {approvalId, approvedActionDigest, …}`; digest-bound to exact action | SOURCE `src/types.ts` (type + fields); enforcement in `durable-decider.ts` (digest recomputed at decision) |
| Manifests: registration validation (wildcard/empty rejection); monotonic narrowing across versions (operations/targets/tenants/classification/impact/rate/budget/lifetime; no dropping approval/credential requirements) | SOURCE `src/capability-manifests.ts` (validation + `validateVersionMonotonicity`-class function) |
| Credential broker/store: single-use material at enforcement only; provider `kind` `dev-inmemory`\|`external`; production refuses dev providers (INV-09); closed schemas | SOURCE `src/credential-store.ts`, `src/credential-broker.ts` (kind field + INV-09 check path; cited at P1, spot-checked) |
| Kernel internal identity: per-process HMAC-SHA256 service principals; closed scopes `kernel:bootstrap\|maintenance\|verification\|internal-execution`; tenant `system`; NOT a bypass (A-01 decision required); `timingSafeEqual`; revocable; no wildcard | SOURCE `src/kernel-principal.ts` (full read: scope set constant, sign/verify, decision-path note) |
| Phase-B: single tenant transaction (rate → session → credential → PDP → audit); sealed envelope cites manifestId+digest, sessionEventId+status, securityStoreTxId | SOURCE `src/durable-decider.ts` (transaction body order — verified at R2; spot-checked) |
| Security state store: PostgreSQL SOLE authoritative SecurityStateStore; collections `authorization.manifests/credentials/credential-uses/consumed-envelopes/idempotency/rate-windows/run-budgets/decisions` + S-1 approvals; retention/GC interlocks; fail-closed `SECURITY_STATE_UNAVAILABLE` | SOURCE `src/security-state-store.ts` (collection constants + `SECURITY_SYSTEM_TENANT` + store open contract) |
| Module: mandatory boundary; kernel-identity token; R1 audit-sink pool path (enumerated INV-15 exception) | SOURCE `src/module.ts` |

### 3.4 `packages/loop-host`

| Claim (Specification §1.4) | Evidence |
| --- | --- |
| Snapshots: `freezePrincipalSnapshot` = exactly 6 fixed provenance fields (everything else stripped); `assessPersistedSnapshot` (version/shape/method/freshness; 300 s skew; future-beyond-skew ⇒ `PRINCIPAL_SKEW`); `authorizeDispatch` (triple tenant match snapshot==item==actor, identity match, role non-expansion via T-01 `projectToActor`; hold taxonomy `PRINCIPAL_ABSENT/MALFORMED/VERSION/SKEW/STALE/TEST_METHOD/MISMATCH/ROLE_ESCALATION/REVOKED`) | SOURCE `src/principal-snapshot.ts` (full read, 333 lines) |
| Dispatch-time session re-validation: after lease + authorizeDispatch, `sessionStore.assertActive`; non-ACTIVE ⇒ HELD `PRINCIPAL_REVOKED` (never dispatched, never silently resumed); store FAILURE ⇒ throw (fail closed); `KERNEL_INTERNAL` bypass (cryptographic instead) | SOURCE `src/host-service.ts:90-95` (contract comment), `:175-183` (enqueue-time re-validation), `:504-528` (dispatch re-validation + `PRINCIPAL_REVOKED` hold) |
| Work ingress: presented credential → T-03 boundary → principal → durable enqueue; submission tenant must equal principal tenant | SOURCE `src/work-ingress.ts` (surface greps: boundary call, tenant equality check) |
| Out-of-scope note (existing, verbatim intent): OIDC/mTLS activation remains out of scope; STATIC_TOKEN counts as non-test (staging-capable) | SOURCE `src/types.ts:410-415` (comment block) |

### 3.5 Storage substrate (INV-15 state)

| Claim (Specification §1.5) | Evidence |
| --- | --- |
| Blind pooled sessions (no ambient `'*'`); explicit system scope only via counted `SET LOCAL` grants; `ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS` = `poolpath:<collection>` / `transaction:system` / `schema:isolation` patterns | SOURCE `packages/storage-postgres/src/system-scope-audit.ts` + `tenant-isolation.ts` (INV-15 merged state; cited from the INV-15 record + P1 invariant code `hasAmbientConnectScope`/`getSystemScopeAudit` verified in `security-posture.ts`) |
| Boot invariants `p1.production.rls-posture` (verifyRlsPosture) + `.ambient-scope-minimization` (live negative probe + enumeration check) | SOURCE `packages/cli/src/security-posture.ts` (invariant block) |
| INV-15 closure: PR #28 merged @`5d12cc5`; CI `34359343572` green; post-merge verified; E4 report lost pre-merge (recorded loss) | AUDIT (INV-15 record + P1-CLOSURE) + API |

### 3.6 Privileged-operation enumeration (complete — the P2-GAP-04 basis)

Grep set: `roles.includes\|global_admin\|globalAdmin\|'admin' \|"admin" | isAdministrator | canManage | canRead | isPrivileged | break.?glass | elevat | stepUp | StepUp | delegat | TOTP | SAML` across `packages/*/src` (2026-09-09). **Every** privileged gate in the canonical tree is one of the register entries PO-1…PO-15 in Specification §1.6; each was verified at its call site:

| Register entry | Call site (SOURCE) |
| --- | --- |
| PO-1/PO-2/PO-3 | `packages/commercial-control-plane/src/billing/billing-service.ts` — `assertAdministrator`/`assertManager` + `billing-system` system actor + `global_admin` cross-tenant read |
| PO-4 | `packages/autonomous-deployment/src/deployment-service.ts` — cross-tenant adapter registration gated `global_admin`; admin actions `admin\|global_admin` |
| PO-5 | `packages/autonomous-venture-factory/src/venture-factory-service.ts` — manager roles + `global_admin` cross-tenant read |
| PO-6/PO-7 | `packages/capability-fabric/src/capability-fabric-service.ts` — registry mutation `admin\|global_admin\|system`; cross-tenant audit verification `global_admin` |
| PO-8 | `packages/causal-engine/src/…` (and analogous read paths) — `global_admin` cross-tenant reads |
| PO-9 | `packages/authorization-boundary/src/durable-decider.ts` + S-1 approval records (digest binding) |
| PO-10 | `packages/authentication/src/token-registry.ts` (one-shot import; `importedBy`) |
| PO-11 | `packages/authentication/src/authentication-event-store.ts` (`revokeEvent`, CAS, reason) |
| PO-12 | `packages/authorization-boundary/src/capability-manifests.ts` (version registration) |
| PO-13 | `packages/cli/src/host-inspect.ts` (env opt-in) |
| PO-14 | `packages/authorization-boundary/src/kernel-principal.ts` (HMAC kernel principals) |
| PO-15 | `packages/authorization-boundary/src/security-state-store.ts` (retention/GC, `kernel:maintenance`) |

**Negative findings (absence claims, all grep-verified across
`packages/*/src`):**
- No `OidcAuthenticator` class/type exists (only the method token + the
  false comment — Δ-1).
- No MFA/TOTP implementation (only the `MFA` member of the
  `StepUpRequirement.satisfiedBy` union).
- No SAML/OAuth implementation (only documentation/comments).
- No break-glass, elevation, plane-role, or delegation constructs of any
  kind (zero hits for `break-glass`, `elevation`, `delegat*` outside
  unrelated words like `delegated` in test fixtures).
- No key-management seam for identity material (the only material provider
  is the A-01 credential-material provider for broker material).
- No identity/membership/role-assignment/recovery stores (the only
  principal-shaped records are S-9 token-registry rows).
- No second security-authority store exists (PostgreSQL sole — R2 rule 1).

---

## 4. Deltas vs the P1-era audit (explicit — no silent assumptions)

| # | Delta | Assessment |
| --- | --- | --- |
| Δ-1 | `types.ts` comment references a nonexistent `OidcAuthenticator` | Documentation delta; cosmetic at P1 time, material for P2 (S1 makes it true by implementing the class). Spec §1.7/§2 (P2-GAP-14) |
| Δ-2 | INV-15 changed the scope layer under S-8/S-9 reads (pre-tenant single-row reads now run through enumerated counted system-scope grants) | Verified compatible: `token-registry.ts` `getSystem` uses an explicit system-scope transaction; patterns remain in the enumeration. **New P2 stores MUST follow the same pattern** (Spec §1.5/§10, S1 scope) |
| Δ-3 | V-2 32-process stabilization + O-1/O-2/O-3 harness fixes since R2 | Tests-only; no identity-surface behavior change (verified by diff scope — test files) |
| — | All other P1 spec §7.1 classifications | Re-verify unchanged (spot-checked against source this session; no contradicting finding) |

---

## 5. Readiness findings (input to the Specification)

| # | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| F-1 | No production identity provider (GAP-01, CRITICAL) | CRITICAL | Spec §5 (S1) |
| F-2 | No identity lifecycle (GAP-02, CRITICAL) | CRITICAL | Spec §4 (S1) |
| F-3 | No MFA/step-up (GAP-03, HIGH) | HIGH | Spec §5.1/S5 |
| F-4 | No privileged plane (GAP-04, HIGH) — ad-hoc role gates enumerated PO-1…PO-15 | HIGH | Spec §9 (S3) + §9.4 (S6) |
| F-5 | Session bearer never rotates (GAP-05, HIGH) | HIGH | Spec §6 (S2) |
| F-6 | No delegation (GAP-06, HIGH) | HIGH | Spec §8 (S4) |
| F-7 | Federation = method token only (GAP-07, MEDIUM) | MEDIUM | Spec §5.2 (S1/S5) |
| F-8 | No key-management seam for identity keys (GAP-08, MEDIUM) | MEDIUM | Spec §12 (S7) |
| F-9 | Identity/privilege audit events undefined (GAP-09, MEDIUM) | MEDIUM | Spec §13 |
| F-10 | Takeover surface = joint of GAP-01/03/05 (GAP-10) | MEDIUM | Spec §4.2 (joint control set) |
| F-11 | No recovery (GAP-11, MEDIUM) | MEDIUM | Spec §4.2 (S1) |
| F-12 | No break-glass notification plane (GAP-12, MEDIUM) — bus exists; external delivery out of scope | MEDIUM | Spec §9.4 item 7 (S6) |
| F-13 | External: production IdP + KMS/HSM (GAP-13) | EXTERNAL | Spec §12/§20; D1/D2 owner decisions (AG-8) |
| F-14 | `OidcAuthenticator` comment inaccuracy (GAP-14, LOW) | LOW | S1 |
| F-15 | Existing strengths preserved as the design base (fail-closed policy admission; record-before-principal; CAS revocation; Phase-B durable decisions; INV-15 blind pools; kernel-identity closed scopes; digest-bound approvals; monotonic manifests) | POSITIVE | Spec §3/§7.1 (PRESERVE decisions) |

**Positive readiness observations (what P2 builds ON — verified, not
assumed):** the fail-closed pipeline discipline (A-01), the durable-session
discipline (S-8), the no-material-at-rest discipline (S-9), the single-
authoritative-store rule (R2), and the boot-invariant mechanism (P1) are all
CANONICAL at `5d12cc5`. P2 is additive on these; it does not need to
re-architect them.

---

## 6. Determination inputs

- **Baseline consistent?** YES — the canonical tree at `5d12cc5` matches the
  P1-era audit except for the three explicitly-recorded deltas (§4). No
  baseline inconsistency (D determination NOT triggered).
- **Scope/governance violation?** NONE observed in the canonical tree; all
  P1 invariants remain declared; no dev authenticator is admitted to
  production by default (closed ingress default verified §3.2). (E
  determination NOT triggered.)
- **Blocking for specification completion?** NONE — all gaps are specifiable
  with concrete, verifiable designs (Specification §17: 26/26 cases have
  observable criteria).
- **Implementation readiness of the first slice?** P2-S1 is bounded,
  dependency-clean (canonical baseline only), and independently verifiable
  (Specification §24-S1). **Implementation remains NOT authorized** — the
  slice is called out for separate explicit authorization.

**Determination (returned to the authorizing party, per the task's
single-determination rule):** **B — specification complete with
non-blocking findings** (the non-blocking findings are: P2-GAP-07 SAML seam
deferred-by-design; P2-GAP-13 external IdP/KMS are operational decisions,
not implementation gaps; AG-1 R-9; P1C-OBS-01; and the Δ-1 documentation
delta — none blocks P2-S1 authorization). Determination B carries the same
hard stop as A: **no implementation is authorized by the specification.**

---

## 7. Provenance register (this record's own artifacts)

| Artifact | State |
| --- | --- |
| `docs/P2_PRODUCTION_IDENTITY_PRIVILEGED_PLANE_SPECIFICATION.md` | UNCOMMITTED (working tree) |
| `docs/verification/P2_READINESS_AUDIT.md` (this file) | UNCOMMITTED (working tree) |
| `docs/verification/POST_INV15_NEXT_MILESTONE_RECONNAISSANCE.md` | prior-session artifact (uncommitted; cited) |
| Source reads | `packages/authentication/src/{types,authentication-policy,principal-boundary,authenticator-registry,static-token-authenticator,authentication-event-store,token-registry,authentication-module,contracts,deterministic-test-authenticator}.ts`; `packages/cli/src/{security-posture,auth-config,bootstrap,host-inspect,host-command,host-ingress-command}.ts`; `packages/authorization-boundary/src/{kernel-principal,policy-engine,durable-decider,security-state-store,types,credential-store,credential-broker,capability-manifests,module}.ts`; `packages/loop-host/src/{principal-snapshot,host-service,work-ingress,types}.ts`; `packages/storage-postgres/src/{system-scope-audit,tenant-isolation}.ts` (INV-15 state, spot-checked) |
| GitHub API (read-only, 2026-09-09) | refs, ruleset `20134880`, tag/branch inventory; G10 SAS-signature observation (blobs retained; egress-blocked in sandbox) |

**STOP.**
