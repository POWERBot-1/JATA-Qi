# P2-S1 Verification Report (E4)

**Milestone:** P2-S1 — Production Identity Core
**Determination under which this was implemented:** B (per `docs/verification/P2_READINESS_AUDIT.md`)
**Specification:** `docs/P2_PRODUCTION_IDENTITY_PRIVILEGED_PLANE_SPECIFICATION.md` (esp. §4, §5, §14, §18, §21, §24-S1)
**Prepared by:** the P2-S1 implementation agent, on branch `arena/01a08684-jata-qi`
**Recovery note:** re-verified on a fresh clone after the workspace re-clone lost the original unpushed commit objects; see §1a for the documented SHA substitution.
**Remediation note:** a broken OIDC test fixture (Finding P2-S1-OIDC-01) was discovered in the post-publication CI follow-up and corrected in `97f055b62f7c97d47455cf71da1e0ec69c129cff` (test-only); the verification record is corrected in §1b.

---

## 1. Commit identity

| Artifact | SHA |
| --- | --- |
| Canonical baseline (HEAD of `main` at start; verified still at this SHA on the remote at publication) | `5d12cc57353c4e7cce3af157f5e23efde2c74b28` |
| **Published implementation commit (the exact artifact under publication)** | `b8235b2631a22dd155638d4f3d00aebec3900a00` |
| Historical (unrecoverable) implementation SHA — first local commit of this work, **never pushed** | `cd9fcd6891ff1e348ce6deccc3d9faa0ee202bca` |
| Historical (unrecoverable) E4-report SHA — first local report commit, **never pushed** | `0579eb9` (short form of the first local report commit) |
| Branch | `arena/01a08684-jata-qi` |
| E4 report commit | this file, committed immediately after the implementation commit |
| Remediation commit (post-publication; Finding P2-S1-OIDC-01; **test-only**, no `src/` change) | `97f055b62f7c97d47455cf71da1e0ec69c129cff` |
| Final published artifact (PR #29 head) | this report-amendment commit, committed immediately after the remediation commit |

All evidence below was produced by executing the committed artifacts (workspace HEAD == implementation commit at verification time).

### 1a. Commit-identity reconciliation (SHA substitution, documented)

The original unpushed P2-S1 commit `cd9fcd6891ff1e348ce6deccc3d9faa0ee202bca`
(and its report commit `0579eb9`) were **never pushed** (the push attempt
failed on an expired sandbox GitHub token) and became **unrecoverable**
when the workspace was re-cloned from GitHub (verified: neither SHA exists
locally, on any remote ref, or as a dangling object). The authorized
implementation content **survived in the working tree** byte-identical —
17 tracked modifications with the previously established diff (+847/−38)
plus the 12 new implementation files and this report, and nothing else.

Before re-committing, the recovered tree was **freshly re-verified** on a
clean clone: `npm ci`, full workspace build (0 TS errors), and the complete
gate set — p2-s1-identity-core 19/19, p2-s1-oidc 14/14,
p2-s1-identity-decision 8/8, p2-posture-invariants 7/7, p1-posture-pg
5/5, full regression 50/50 (0 failed, 0 skipped), lint 0 errors, R2 secret
scan PASS (0 findings). No P2-S1 implementation content was modified,
redesigned, extended, or refactored to facilitate publication; the only
content change in the recovery is this reconciliation text.

`b8235b2631a22dd155638d4f3d00aebec3900a00` is therefore the **replacement
publication identity** for the identical authorized content, and the final
exact artifact that is being published (with this report committed
immediately after it on the same branch).

### 1b. Post-publication remediation — Finding P2-S1-OIDC-01 (documented)

After publication, the CI run against the exact published head (run
`34412338682`, job `102669392025`) **FAILED** at the "Test (all workspaces)"
step. The root cause was fully characterized by re-execution on the exact
published tree under both Node v20.20.2 (the CI runtime) and Node v22.22.3:

1. **Broken fixture.** `ecFixture()` in
   `packages/authentication/test/p2-s1-oidc.test.ts` called
   `ecdh.getPublicKeyDER()` / `ecdh.getPrivateKeyDER()` — methods that **do
   not exist** on the `node:crypto` `ECDH` class in any released Node.js
   (empirically absent on v20.20.2 and v22.22.3; absent from current Node
   documentation). The TS source cast the instance
   (`as unknown as {…}`), so the build did not detect it. The JWT-core
   `describe` block therefore threw a `TypeError` at suite setup in
   **every** environment, and its **8 subtests never executed anywhere** —
   including **A-02's 4-case deny-early skew table at the exact second
   boundary** and **A-26's step-up recency**.

2. **Runner masking.** node:test (both runtimes; minimal 4-line repro)
   reports a top-level suite-setup failure as `not ok` but **excludes it
   from the `# tests`/`# pass`/`# fail` counters**, and its exit status is
   version-dependent: Node 22 → exit 0 (fully masked — every local gate run
   reported PASS); Node 20 → exit 1 (surfaced in CI). Consequently the
   pre-remediation "p2-s1-oidc 14/14" figure in §3/§4.1 reflects only the
   *authenticator* describe (14 subtests); the 8 JWT-core subtests had not
   executed when those numbers were recorded. The workspace-level "50/50"
   likewise held only for the masked Node-22 runs (CI on Node 20 reported
   49/50).

3. **Remediation** (commit `97f055b62f7c97d47455cf71da1e0ec69c129cff`,
   **test-only** — no `src/` or implementation modification):
   (a) `ecFixture()` now generates the P-256 keypair directly as KeyObjects
   via `generateKeyPairSync('ec', { namedCurve: 'prime256v1' })` (available
   on every supported Node; the repo declares `engines: node >=20.0.0`); the
   fixture shape (`privateKey`, `publicJwk`, `kid`, `alg`) is unchanged.
   (b) The `alg:"none"` assertion, which used the canonical RFC 7519
   empty-signature shape, is replaced by **two** accurate cases
   (strengthening, not weakening): the empty-signature shape asserts
   `JWT_MALFORMED` (the earlier fail-closed malformation check), and a
   well-formed `alg:"none"` token asserts `JWT_ALG_REJECTED`. Both refuse;
   the closed code set is unchanged.

4. **Pre-remediation implementation-level diagnostic** (a 1:1 mirror of the
   8 subtest assertions executed against the published `dist` on both
   runtimes): 7 of 8 logic suites passed fully — including
   **A-02's exact-boundary 4-case skew** (exp DENY `+300`/ALLOW `+301`/DENY
   `+299`/DENY `−1`; nbf and iat ALLOW `+300`/DENY `+301`/ALLOW `−60`) and
   **A-26** (boundary fresh, 1 s stale, `ageMs`, `NaN`/`maxAgeMs=0`
   refused) — and the only mismatch was the documented `alg:"none"`
   shape expectation (test-side, not an implementation defect). No
   implementation security defect was identified.

5. **Post-remediation re-verification** (from head `97f055b`):
   - Node v20.20.2 (CI runtime parity): `p2-s1-oidc.test.js` **22/22** (0
     `not ok`, exit 0); authentication workspace **92/92** subtests; full
     `npm test` **50/50 workspaces, exit 0**; build 0 errors; lint 0 errors
     (60 pre-existing baseline warnings); scan:r2 PASS (8 static files, 13
     dump rows, 0 findings).
   - Node v22.22.3: identical results (22/22; 50/50, exit 0).
   - **CI run at the remediation head: PASS** — run `34448530864`, job
     `102778627618`, `build · lint · test` green (10m43s).
   - Residual platform risk (recorded; no repo-side change in this
     milestone): the node:test suite-setup-failure counter/exit-status
     desync undercounts any suite that throws at setup and is invisible to
     exit status on Node 22. A repo-level guard (e.g., TAP `not ok` scanning
     in CI, or runner-Node alignment with `engines`) is a separate
     improvement item.

## 2. Changed files (29)

New (14):

| File | Purpose |
| --- | --- |
| `packages/authentication/src/identity-types.ts` | Identity vocabulary: 5 states, 6 permitted transitions (closed sets), doc field allow-lists (closed schema), `IdentityStateAuthority`/`IdentityStateLookup`, error classes |
| `packages/authentication/src/identity-store.ts` | Durable identity core: enrollment, lifecycle CAS transitions, role assignments, recovery, subject bindings, events, `autoLinkTokenPrincipal`, `asStateAuthority()` (in-tenant-tx lookup), `runBootCanary`; all 7 tables materialized at `open()` |
| `packages/authentication/src/jti-replay.ts` | Durable one-shot jti replay set (`consume`/`gc`, grace window 300 s); table materialized at `open()` |
| `packages/authentication/src/jwt.ts` | Pinned-JWKS JWT core (node:crypto only): `verifyJwt`, `resolveJwksPin` (inline/URL pin, injectable fetcher, fetched exactly once, private-key JWK refusal), `assessOidcClaims` (epoch-seconds boundary), `assertStepUpRecency` |
| `packages/authentication/src/oidc-authenticator.ts` | Provider-neutral OIDC authenticator: signature → claims → replay → identity → lifecycle → role narrowing → record-before-principal; `health()` reports pin state only (no live IdP probe) |
| `packages/authentication/test/p2-s1-identity-core.test.ts` | 19 tests: lifecycle matrix (all 6 permitted + all 10 store-driven forbidden + 4 to-ENROLLED), deprovisioning cascade, auto-link idempotency, rebind refusal, terminal states, canary, closed-schema |
| `packages/authentication/test/p2-s1-oidc.test.ts` | 14 tests: JWT core (RS256/ES256, alg-none/HS256 confusion, kid handling, signature tamper, private-key JWK, URL pin once), full claim table, 4-case skew at the exact second boundary, authenticator pipeline (A-01/02/03/06/15/22/23/26), contract conformance |
| `packages/authorization-boundary/test/p2-s1-identity-decision.test.ts` | 8 tests: A-11 two-decision proof, non-ACTIVATED/terminal denial, unlinked passthrough, KERNEL_INTERNAL skip (counting authority), tenant-mismatch defensive seam, fail-closed lookup failure |
| `packages/cli/test/p2-posture-invariants.test.ts` | 7 tests: P2-INV-01/02/03/09 positive + negative (boot-level where reachable; kernel-API seam where the earlier layers make the state unreachable), P2-INV-11 negatives, INV-15 pos/neg, E2E OIDC login through the production composition |
| `docs/P2_PRODUCTION_IDENTITY_PRIVILEGED_PLANE_SPECIFICATION.md` | The P2 specification (authored in the spec phase; committed with the implementation it governs) |
| `docs/verification/P2_READINESS_AUDIT.md` | Readiness audit incl. the determination B record |
| `docs/verification/POST_INV15_NEXT_MILESTONE_RECONNAISSANCE.md` | Post-INV-15 reconnaissance (adjacent gaps recorded, not expanded) |
| `docs/verification/P2_S1_VERIFICATION_REPORT.md` | This report |

Modified (15):

| File | Change (additive/fail-closed) |
| --- | --- |
| `packages/authentication/src/authentication-module.ts` | Opens identity + jti stores with the durable session substrate; exposes `getIdentityStore`/`getJtiReplay`; `listAuthenticators` on the boundary service |
| `packages/authentication/src/index.ts` | Exports the P2-S1 API surface |
| `packages/authentication/src/principal-boundary.ts` | Read-only `listAuthenticators()` accessor for structural posture checks (never used for verification); `credentialExpiresAt` honored in session expiry |
| `packages/authentication/src/static-token-authenticator.ts` | `AutoLinkedStaticTokenAuthenticator`: idempotent auto-link of every verified static token into the identity core (spec §21.1; rebind-resistant; terminal refusal) |
| `packages/authentication/src/types.ts` | `AuthenticatedPrincipal.credentialExpiresAt`, method vocabulary incl. `OIDC` |
| `packages/authorization-boundary/src/durable-decider.ts` | Stage 2.5: identity-state + role re-read INSIDE the Phase-B tenant transaction (narrow to ACTIVE assignments; deny `IDENTITY_STATE_INACTIVE`/`IDENTITY_TENANT_MISMATCH`; skip KERNEL_INTERNAL; passthrough unlinked; fail-closed on lookup failure) |
| `packages/authorization-boundary/src/gate.ts` | `identityAuthorityResolver` config (lazy, resolved once at first decision; absent ⇒ exact pre-P2 behavior) |
| `packages/authorization-boundary/src/module.ts` | Wires the resolver from the authentication module when the identity core is attached |
| `packages/authorization-boundary/src/types.ts` | Closed denial-reason set extended by `IDENTITY_STATE_INACTIVE`, `IDENTITY_TENANT_MISMATCH` (append-only) |
| `packages/cli/src/auth-config.ts` | `oidc` auth mode: pinned `JATAQI_OIDC_ISSUER` / `JATAQI_OIDC_AUDIENCE` / `JATAQI_OIDC_JWKS` (inline) XOR `JATAQI_OIDC_JWKS_URL` / `JATAQI_OIDC_ALG` (closed [RS256, ES256]); fail-closed parsing |
| `packages/cli/src/bootstrap.ts` | OIDC authenticator factory (requires durable identity core + jti set); sealed static-token transition validation (P2-INV-11: opt-in AND future deadline, both required); OIDC durable-core wiring in all postures |
| `packages/cli/src/host-ingress-command.ts` | Host ingress presents OIDC bearer material from env (never command line) under `oidc` mode |
| `packages/cli/src/security-posture.ts` | P2 production invariants on the append-only kernel registry: P2-INV-01 (cryptographic authenticator OR sealed transition), P2-INV-02 (no development-set authority), P2-INV-03 (identity boot canary), P2-INV-09 (non-empty identity↔tenant mapping when OIDC registered); success paths return `true`, failures return machine-readable strings |
| `packages/cli/test/p1-posture-pg.test.ts` | Deadline adaptation for the sealed transition (30-day future deadline env; P2-INV-11) |
| `packages/storage-postgres/src/rls-probe.ts` | Identity collections added to the RLS-verified security table set (identity is security state) |
| `packages/storage-postgres/src/system-scope-audit.ts` | Enumerated system-scope exception registry + audit snapshot (INV-15 mechanism) |
| `docs/verification/r2-secret-scan.json` | Regenerated by the R2 secret scan (only `generatedAt` changed; 0 findings) |

## 3. Tests executed and exact results

Environment: node v22.22.3, npm 10.9.8, embedded PostgreSQL 18.4 (real PG per suite; fail-hard — a PG start failure fails the suite, never skips). Post-remediation re-verification additionally executed under node v20.20.2 (the CI runtime) — see §1b.

| Suite | Command | Result |
| --- | --- | --- |
| P2-S1 identity core | `cd packages/authentication && npx tsc -p tsconfig.test.json && node --test dist/test/p2-s1-identity-core.test.js` | **19 pass / 0 fail** |
| P2-S1 OIDC boundary | `cd packages/authentication && node --test dist/test/p2-s1-oidc.test.js` | **14 pass / 0 fail** — *pre-remediation counter; it excludes the JWT-core describe (8 subtests) that never executed — see §1b*. Post-remediation (head `97f055b`): **22 pass / 0 fail** on both Node v20.20.2 and v22.22.3 |
| P2-S1 identity decision (A-11) | `cd packages/authorization-boundary && node --test dist/test/p2-s1-identity-decision.test.js` | **8 pass / 0 fail** |
| P2-S1 posture invariants | `cd packages/cli && node --test dist/test/p2-posture-invariants.test.js` | **7 pass / 0 fail** |
| P1 production posture (re-qualification) | `cd packages/cli && node --test dist/test/p1-posture-pg.test.js` | **5 pass / 0 fail** |
| Full workspace regression | `npm test` (root) | **Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0** — all 51 packages PASSED |

Mandated artifact gates: A-01 (replay), A-02 (4-case skew), A-03 (static-token revocation ⇒ next authentication DENY), A-06 (tenant server-side; unknown subject DENY; forged tenant claim ignored), A-11 (two decisions across a durable role revocation), A-15 (wrong iss/aud deny before any store read — asserted with a store-read counter), A-22 (closed schema + material refusal; insert-once), A-23 (double submission insert-once: enrollment DENY, import idempotent-skip, one record), A-26 (step-up boundary fresh/stale) — all present in the suites above; the exact-boundary evidence for A-02 and A-26 lives in the JWT-core describe, which did **not** execute pre-remediation (§1b) and passes 8/8 post-remediation on both runtimes.

## 4. Evidence by area

### 4.1 OIDC claims boundary (A. of the authorization)
`p2-s1-oidc.test.ts` (22/22 post-remediation; the pre-remediation counter was 14/14 — see §1b): every required claim (`sub`, `iss`, `aud`, `exp`, `nbf`, `iat`, `jti`, optional `auth_time`) missing/wrong ⇒ exact closed failure code (`OIDC_CLAIM_SUB_MISSING`, `_ISS_MISMATCH`, `_AUD_MISMATCH` (string or array audience), `_EXP_MISSING`, `_NBF_MISSING`, `_IAT_MISSING`, `_JTI_MISSING`, `_AUTH_TIME_INVALID`). 4-case deny-early skew asserted at the exact second boundary with `OIDC_CLOCK_SKEW_SECONDS = 300`: exp DENY at `+300` (inclusive) / ALLOW at `+301` / DENY at `+299` / DENY at `−1`; nbf ALLOW at `+300` / DENY at `+301`; iat same as nbf — verified both in pure `assessOidcClaims` and through `OidcAuthenticator.verify` (exp boundary). Unsigned (`alg:none`) and HMAC-confusion (`HS256`) tokens, missing/unknown/mismatched kids, wrong-key (same kid, different key) and tampered signatures all refused at the signature stage. Private-key JWK material refused (`JWKS_REJECTED_KEY`); empty JWKS refused; non-http(s) pin URL refused; URL pin fetched exactly once (injected fetcher count), never at verification time. **No permissive claim handling exists: every absent claim is a closed-code refusal.** (The JWT-core assertions in this paragraph did not execute pre-remediation; they now execute and pass — §1b.)

### 4.2 Identity lifecycle (B.)
`p2-s1-identity-core.test.ts` (19/19): all 6 permitted transitions executed (ENROLLED→ACTIVATED, ENROLLED→DEPROVISIONED, ACTIVATED→SUSPENDED, SUSPENDED→ACTIVATED, SUSPENDED→DEACTIVATED, DEACTIVATED→DEPROVISIONED); all forbidden transitions negative-asserted (10 store-driven + 4 to-ENROLLED = 14, asserted as `storeDriven === 10` plus the closed-set matrix). ENROLLED is treated as non-ACTIVATED by the decision path (`IDENTITY_STATE_INACTIVE`); SUSPENDED denied; DEPROVISIONED denied (terminal; no re-enable; deprovisioning cascades: sessions REVOKED, tokens revoked via the registry, future grants refused — `grantRoleAssignment`/`createRecovery`/`enroll` all refuse terminal identities).

### 4.3 Identity linking (C.)
`p2-s1-identity-core.test.ts`: auto-link is idempotent — repeated verification of the same token links exactly once (one stable (tenant, principal) relationship; exactly one CREDENTIAL_CHANGED event; rebind of the same fingerprint is an idempotent skip). Rebind to an incompatible principal/account is refused (`IdentityRebindRefusedError` — cross-tenant binding of an already-bound principal; a token bound to a terminal/foreign identity is refused by `AutoLinkedStaticTokenAuthenticator`). No auto-linking on weak/ambiguous attributes: linking occurs only from a verified credential (fingerprint for static tokens; issuer+subject for OIDC).

### 4.4 Tenant security + system scope (D.)
`p2-posture-invariants.test.ts` (7/7): INV-15 positive — a freshly checked-out pooled session carries NO ambient tenant scope (`hasAmbientConnectScope() === false`), and every system-scope operation observed during a full production boot is counted under a label in the enumerated exception registry (`undeclaredLabels === []`, `totalSystemScopeOperations > 0`, every boot label under `poolpath:`/`transaction:system`/`schema:isolation`). INV-15 negative — an explicit declared-label system-scope operation succeeds and is counted; an operation under an UNDECLARED label is recorded and the posture invariant `p1.production.ambient-scope-minimization` cites it as a boot failure (that is the refusal: any boot observing an undeclared label cannot reach the started state). INV-15 remains green across all production boots (re-asserted on both the static-token and OIDC boots). RLS: the RLS probe verifies all security tables incl. the identity set (`P1_RLS_TABLE_MISSING` fail-closed); the non-superuser/non-BYPASSRLS app role is asserted in `p1-posture-pg` (5/5). No ambient authority, no session-level `*`, no RLS bypass, no second security authority store (identity state lives in the same durable substrate; the decision path reads it inside the Phase-B transaction).

### 4.5 Fail-closed (E.)
`p2-s1-identity-decision.test.ts`: an identity-authority lookup failure inside the Phase-B transaction rolls the transaction back and renders a sealed DENY citing `SECURITY_STATE_UNAVAILABLE` (no permissive fallback; uncertainty never produces ALLOW). Same class of evidence in `p1-posture-pg.test.ts`: PostgreSQL outage ⇒ DENY `SECURITY_STATE_UNAVAILABLE`, host survives, no memory fallback, decisions resume after recovery.

### 4.6 Tenant mismatch (F.)
`p2-s1-identity-decision.test.ts` (documented defensive seam): a keyed lookup is addressed by `(tenantId, principalId)`, so a naturally stored row can NEVER report a different tenant; the test injects a fake authority (an explicitly injectable decider dependency, clearly a test fixture — it carries the type-level `kind` token only because the decider keys on presence) returning an inconsistent record, and the decision path renders DENY `IDENTITY_TENANT_MISMATCH`. This exercises the defensive branch the implementation must keep fail-closed; it is not a claim that normal keyed lookup can produce the mismatch.

### 4.7 KERNEL_INTERNAL (G.)
`p2-s1-identity-decision.test.ts`: a counting fake authority (reports every principal SUSPENDED, so any consultation would deny) proves the identity re-read is skipped for a KERNEL_INTERNAL principal — the same session-evidence row that gates the control STATIC_TOKEN request (`IDENTITY_STATE_INACTIVE`, counter ≥ 1) produces an ALLOW for the kernel path with **zero** identity-authority consultations. No unrelated validation was bypassed: the session-evidence stage (active S-8 row, tenant match) and the full PDP (operator-required engine, capability/tenant/tool checks) still apply to the kernel request.

### 4.8 P2 invariants
`p2-posture-invariants.test.ts`:
- **P2-INV-01** positive: sealed static-token transition (explicit opt-in + future deadline asserted) ⇒ check returns `true`; OIDC-registered boot ⇒ check returns `true` via `verifiesCryptographicProof`. Negative: production composition with no production authenticator and no sealed transition ABORTS BOOT with `invariantId = p2.production.production-authenticator`.
- **P2-INV-02** negative (three layers proven): the concrete `DeterministicTestAuthenticator` is refused at configuration (`P1_CFG_TEST_AUTH_REFUSED`); a DETERMINISTIC_TEST-supporting authenticator is refused at registration by the production authentication policy (method not admitted); the invariant's declared check, evaluated against the kernel-API seam reporting such an authenticator, renders a failure (string) citing it — the contract-level backstop ("extends INV-10 to contract level"). Positive: `true` on both healthy boots.
- **P2-INV-03** positive: the identity boot canary (mint/read/suspended-deny-path/deprovision/GC) is green. Negative: with PostgreSQL stopped, the SAME invariant check reports an availability failure (never `true`); after recovery it is green again (the check re-runs on every boot).
- **P2-INV-09** positive: OIDC-registered boot with a durable non-empty identity↔tenant mapping ⇒ `true`. Negative: OIDC-registered boot over an EMPTY mapping ABORTS BOOT with `invariantId = p2.production.identity-tenant-mapping` (detected at boot, not at first login).
- **P2-INV-11** negatives: missing deadline and past deadline both refused at configuration (`P2_CFG_STATIC_TOKEN_DEADLINE_REQUIRED`; the transition is never open-ended).
- **Correct contract**: every success path returns `true`; a string is exclusively a failure reason (asserted by the kernel registry's `assertAll`).

### 4.9 A-11 (strongest observable proof)
`p2-s1-identity-decision.test.ts`: initial durable state `['operator','observer']`, request claims both, test-local operator-required policy engine ⇒ **decision 1 = ALLOW, `envelope.principal.roles = ['operator','observer']`**. The durable `operator` assignment is then revoked. **Decision 2** (request still claims both) ⇒ the identity stage narrows the effective set to the currently ACTIVE durable assignments: **`envelope.principal.roles = ['observer']`** and, with the operator-required policy, **decision = DENY** (citing the closed `PRINCIPAL_REVOKED` reason — the closed A-01 reason set carries no role-specific code; the fixture is documented as such). Both decisions cite the same manifest revision. This proves BOTH that the durable role state changed AND that the decision outcome changed because the effective authority changed — not merely that a row changed.

### 4.10 End-to-end (production composition)
`p2-posture-invariants.test.ts`: the OIDC production boot authenticates a REAL signed assertion (locally generated RSA-2048 key, operator-pinned inline JWKS — an honest local double; no external IdP activated or contacted) for an enrolled subject (ENROLLED identity activates on first verification; the assertion is the activation evidence), and refuses: an assertion for an unenrolled subject (`IDENTITY_NOT_ENROLLED`), and a token signed by a key outside the pin (signature-stage refusal).

## 5. Regression / build / lint / security

| Gate | Command | Result |
| --- | --- | --- |
| Full regression | `npm test` (root, all 51 packages) | **50/50 — Passed: 50, Failed: 0, Skipped: 0** |
| TypeScript build (all workspaces) | `npm run build` | clean — 0 errors |
| Lint | `npm run lint` | **0 errors**, 60 warnings — ALL pre-existing in baseline files; 0 warnings in any P2-S1 changed/new file |
| R2 secret scan | `npm run scan:r2` | **PASS — 0 findings** (8 static files, 13 dump rows, 3 markers) |
| No test weakening/deletion | diff inspection | only additive test changes: `p1-posture-pg.test.ts` gained the deadline env (required by P2-INV-11); no existing assertion removed or relaxed anywhere in the diff |
| No secrets introduced | scan + diff inspection | 0 findings; all test key material is generated in-process (node:crypto) and never persisted |

## 6. Defects found and fixed during bring-up (all within P2-S1 scope)

1. **JWT numericdate units at the claims boundary** (`jwt.ts`): the claims boundary compares epoch-SECONDS `exp`/`nbf`/`iat`/`auth_time` against the injected `now`; the codebase clock is epoch-ms. The boundary is now pure seconds (`OIDC_CLOCK_SKEW_SECONDS = 300`), with conversion happening EXACTLY ONCE in `OidcAuthenticator.verify` (`nowSeconds = Math.floor(now/1000)`; jti store stays ms with `exp*1000`).
2. **`credentialExpiresAt` units at the OIDC→boundary handoff** (`oidc-authenticator.ts`): the principal carried `claims.exp` (seconds) where the PrincipalBoundary session-expiry math uses ms — every OIDC login through the composition would have failed `recordEvent (expiresAt strictly after verifiedAt)`. Fixed at the boundary (`claims.exp * 1000`).
3. **Identity/jti tables not materialized at `open()`** (`identity-store.ts`, `jti-replay.ts`): the production RLS contract verifies every security table (now incl. the identity set) before boot completes; `identity.subject-bindings` and `identity.jti-replay` were created lazily, so NO fresh production boot could pass `p1.production.rls-posture`. Both stores now materialize all of their tables at open (plus useful indexes). This defect also broke the pre-existing P1 posture suite until fixed.
4. **P2-INV success paths returned failure-strings** (`security-posture.ts`): the kernel invariant contract treats any non-`true` return as a violation; the sealed-transition, canary, and mapping success paths returned descriptive strings and would have aborted every healthy boot. All success paths return `true`.

## 7. Deviations and findings (non-blocking)

- **P2-INV-02 negative is unreachable at boot level by design**: both the configuration layer (concrete class) and the authentication-policy admission (method not admitted) refuse test authority before the invariant runs; the invariant's logic is therefore evidenced at the kernel-API seam (a documented test fixture on an explicitly injectable seam). This is the intended defense-in-depth ordering, not a gap.
- **IDENTITY_TENANT_MISMATCH is exercised via an injected authority** (documented in §4.6): a keyed lookup cannot naturally produce the mismatch; the defensive branch is what the spec requires to stay fail-closed.
- **Test doubles are strictly local**: locally generated RSA/EC keys, inline JWKS pins, an injectable JWKS fetcher, and counting/defensive authorities. None is represented as a production identity provider; no external IdP was activated, contacted, or required (spec §5.1).
- **Test-local policy engine reason code**: the closed A-01 reason set has no role-specific code; the operator-required fixture cites `PRINCIPAL_REVOKED` (the semantic exercised: previously held authority revoked durably). Documented in the test.
- **`r2-secret-scan.json`** regenerated (timestamp only; 0 findings) — the committed scan artifact tracking the current state.
- **Finding P2-S1-OIDC-01 (remediated post-publication)**: a broken EC fixture (nonexistent `ECDH.getPublicKeyDER`/`getPrivateKeyDER`) plus node:test runner masking meant the 8 OIDC JWT-core subtests (incl. A-02 exact-boundary and A-26) never executed in any run, and the pre-remediation totals in §3/§4.1/§8 of this report reflect that masked state. Remediated in `97f055b` (test-only): post-remediation 22/22 (oidc file), 92/92 (auth workspace), 50/50 on both Node v20.20.2 and v22.22.3; CI at the remediation head green (run `34448530864`). Residual: the node:test suite-setup-failure desync is a platform-level risk (see §1b).
- **Out of scope (recorded, not expanded)**: P2-INV-04…08/10 (privilege stage, elevations, break-glass, key-management register) belong to later S1/later milestones; TOTP/MFA is S5; no P2-S2…S8, no production deployment, no external IdP activation, no KMS/HSM deployment.

## 8. Final determination

**PASS — P2-S1 implemented, evidenced, and ready for independent verification.**

- Baseline `5d12cc57353c4e7cce3af157f5e23efde2c74b28` preserved; additive-only diff; no existing test weakened or deleted; no RLS bypass; no ambient authority; no session-level `*`; no second security authority store; no destructive migration; fail-closed throughout.
- All mandated gates green: A-01/02/03/06/11/15/22/23/26; lifecycle pos+neg; cascade; auto-link idempotency; rebind refusal; OIDC claim boundary + 4-case skew; P2-INV-01/02/03/09 pos+neg; P2-INV-11 negatives; INV-15 pos+neg; system-scope declared/undeclared pos+neg; fail-closed; KERNEL_INTERNAL skip; 50/50 regression; clean build; 0 lint errors; scan PASS.
- **Verification record corrected (Finding P2-S1-OIDC-01, §1b)**: pre-remediation, 8 OIDC JWT-core subtests (incl. A-02 exact-boundary 4-case skew and A-26) never executed due to the broken fixture + runner masking; those gates are now backed by executed subtests, and the post-remediation 50/50 regression is green on both Node v20.20.2 (CI parity; CI run `34448530864` PASS) and v22.22.3.
- Governance honored: implementation + tests + this report committed on `arena/01a08684-jata-qi`; STOP before merge; no production-readiness claim; P2-S2 not advanced. Merge requires separate explicit authorization.
