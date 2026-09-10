# P2-S4 — Delegation + Policy: Verification Report

Canonical evidence artifact for the P2-S4 "Delegation + Policy" implementation
(spec `docs/P2_PRODUCTION_IDENTITY_PRIVILEGED_PLANE_SPECIFICATION.md` §8, §13,
§14, §24-S4; acceptance items A-08/A-09/A-16/A-24/A-25 delegation subset).

This report is committed to canonical source control (NOT a PR-body
attestation) and is the authoritative record of the S4 evidence.

---

## 1. Baseline

| Item | Value |
| --- | --- |
| Canonical baseline (main) | `66e78835cc7b6d4dea5de14a0d4f6a3bd564c5cf` |
| Baseline tree | clean (`git status --porcelain` empty) before any S4 edit |
| Session branch | `arena/01a08c63-jata-qi` |
| PR lineage (verified) | #29 P2-S1 (`4293e72`) → #30 P2-S2 (`f68f329`) → #31 P2-S3 (`66e7883`) |
| Node | v22.22.3 |
| npm | 10.9.8 |
| Baseline build | `npm run build` — all workspaces passed |
| Baseline test | `npm test` — `Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0` |

Baseline verification was re-confirmed GREEN immediately before the first S4
source edit (no silent drift).

---

## 2. Implementation

| Item | Value |
| --- | --- |
| Implementation commit | `5623af56a8a6844b1bc85d55bf1a2861b4464995` |
| Commit subject | `P2-S4: durable Delegation + Policy plane over the single PostgreSQL authority` |

### 2.1 `packages/authentication`

- **`src/delegation-types.ts`** (new): closed grant model per spec §8.1
  (`DelegationDoc`), the `identity.delegations` collection name, grant
  lifecycle (`ACTIVE`/`CONSUMED`/`REVOKED`/`EXPIRED`), the decision-time
  `DelegationStateAuthority` surface, the deny-early expiry bound (the single
  300 s P2 skew bound), the chain-depth bound (≤ 2), secret-free closed-schema
  guards, and the pure `assessDelegationRow` (delegatee binding → tenant/
  cross-tenant refusal → status → expiry → capability/operation/target subset →
  classification/impact ceilings → chain depth → chain integrity vs the LIVE
  manifest → approval).
- **`src/delegation-store.ts`** (new): the ONLY writer of
  `identity.delegations`. Non-transactional drivers refused at open (memory /
  filesystem are never delegation authority). CAS-guarded transitions;
  insert-once ids; grant ⊆ delegator-live-manifest subset defense-in-depth;
  platform-scope grants require a recorded platform elevation + a bound digest
  approval; every grant/revoke emits a durable `DELEGATION_GRANTED` /
  `DELEGATION_REVOKED` / `DELEGATION_USED` / `DELEGATION_DENIED` event in the
  SAME transaction (an audit-write failure fails the operation).
- **`src/authentication-module.ts`**: opens the delegation store alongside the
  identity/session/privilege stores (fail-closed at open); registers
  `authentication.delegation-store`.

### 2.2 `packages/authorization-boundary`

- **`src/types.ts`**: `A01DelegationBinding` request field; 15 `DELEGATION_*`
  denial codes added to `A01DenialReason` and the ordered reason set;
  `delegationStatus` envelope citation field.
- **`src/envelope.ts`**: the delegation reference is mirrored into the sealed
  body (covered by the integrity digest); `sanitizeRequestForEnvelope` drops
  malformed delegation fields; `delegationStatus` is a durable citation.
- **`src/policy-engine.ts`**: delegation stage at step **4.5** — after
  principal/tenant + privilege, before capability (§7.2). Absent a configured
  delegation stage + a delegation reference ⇒ `DELEGATION_CHECK_UNAVAILABLE`
  (fail-closed — no ambient delegation authority).
- **`src/durable-decider.ts`**: Phase-A classification (authority resolve +
  system-scope `peek` + platform-scope assessment), Phase-B in-tx assessment,
  short-circuit DENY (`renderDelegationDenyTx`), and `delegationStatus: VALID`
  citation on ALLOW. Enforcement (`executeDurable`) re-validates the grant
  before the side effect and **atomically consumes** it (tenant-scope inside
  Tx-1 with the S-4 envelope claim — one consistent snapshot; platform-scope
  in a system transaction before Tx-1, the safe direction).
- **`src/gate.ts` / `src/module.ts`**: `delegationAuthorityResolver` wiring +
  the `hasLiveDelegationAuthority()` structural probe.

### 2.3 `packages/cli`

- **`src/bootstrap.ts`**: supplies the boundary module with
  `delegationAuthorityResolver` pulled from the registered `authentication`
  module (mirrors the S3 privilege resolver).
- **`src/security-posture.ts`**: declares the **P2-INV-04 delegation half**
  (`p2.production.delegation-stage-registered`) — the delegation plane must be
  attached and the A-01 delegation stage wired at production boot.

---

## 3. Single-authority & fail-closed model

- Delegation state exists ONLY on the existing durable PostgreSQL authority
  (`identity.delegations`). No second store, no in-memory authoritative grants,
  no process-local grants, no ambient/implicit delegation, no grant-all
  default, no client-controlled authorization.
- `DelegationStore.open()` refuses a non-transactional source.
- A delegation reference is the grant **id only**; the grant is re-read from
  durable state at every decision and re-verified at every enforcement.
- Cross-tenant delegation is default-refused; a foreign-tenant grant is
  indistinguishable from a non-existent grant (no grant-existence leak).

---

## 4. Test evidence (real PostgreSQL, fail-hard, 0 skip)

All PostgreSQL suites use the fail-hard embedded-PostgreSQL helper
(`r2-pg.ts`): a boot failure **rejects** the suite (never skips).

| Suite | Tests | Result |
| --- | --- | --- |
| `p2-s4-delegation-store.test.ts` (new) | 16 | pass 16, skip 0 |
| `p2-s4-delegation-decision.test.ts` (new) | 17 | pass 17, skip 0 |
| `p2-s3-posture-invariants.test.ts` (extended +3) | 8 | pass 8, skip 0 |
| `@jataqi/authentication` (full) | 175 | pass 175, skip 0 |
| `@jataqi/authorization-boundary` (full) | 177 | pass 177, skip 0 |
| **Full workspace** `npm test` | 50 workspaces | **Passed: 50 · Failed: 0 · Skipped: 0** |

### 4.1 Store-level coverage (16)

Non-transactional-source refusal; durable `DELEGATION_GRANTED`/`REVOKED`
events (secret-free, in the same store); idempotent reason-mandatory
revocation; self-delegation refusal; mandatory bounded lifetime (0, 24 h];
wildcard-operation and empty-scope refusal; chain-depth bound; grant
⊆ delegator authority (subset) refusal; platform-scope requires platform
elevation + approval; approval mandatory when the delegator's capability
requires it; **cross-tenant invisibility** (RLS-bound read + authority
assessment from a foreign tenant ⇒ `UNKNOWN_GRANT`); **one-shot CAS
consumption (3-way race ⇒ exactly one winner)**; counted-grant decrement to
`CONSUMED`; revoked-grant consumption refusal; closed-schema +
material-shaped-field refusal.

### 4.2 Decision / enforcement coverage (17)

VALID delegation ALLOW + `delegationStatus: VALID` citation; direct
invocation without a reference is unchanged (pre-P2-S4 behavior);
fail-closed gate without a delegation authority (`DELEGATION_CHECK_UNAVAILABLE`);
unknown grant (`DELEGATION_UNKNOWN_GRANT`); wrong delegatee
(`DELEGATION_NOT_DELEGATEE`); **cross-tenant refusal** (A-09); operation /
target / classification subset denials (`DELEGATION_SCOPE_*`); expiry
(`DELEGATION_EXPIRED`); revocation (`DELEGATION_REVOKED`); **chain integrity
(A-16)** — rotating the delegator's manifest after the grant ⇒
`DELEGATION_DELEGATOR_AUTHORITY_CHANGED`; **one-shot consumption** (next
decision after enforcement ⇒ `DELEGATION_CONSUMED`); **replay** (same envelope
twice fails closed, no duplicate side effect); **enforcement re-validation**
(revocation after decide denies BEFORE the side effect); restart re-read (a
second gate over the same PostgreSQL reads the same durable grant).

### 4.3 Posture invariants (P2-INV-04 delegation half)

Positive (plane attached + stage wired) and two negative checks (missing plane
/ unwired stage ⇒ fail-closed string, never `true`).

### 4.4 Flake observation (documented, not a failure)

The first full `npm test` run after the S4 edits reported `@jataqi/loop-host`
as failed; re-running loop-host in isolation passed 176/176, and both
subsequent full runs passed 50/50. The loop-host suite does not import the S4
code paths; the failure is consistent with the known embedded-PostgreSQL
resource-contention flake when ~50 workspaces boot parallel PG clusters. No
code was changed to make the suite pass.

---

## 5. Security / adversarial results

| Adversarial case | Outcome |
| --- | --- |
| Issuer/subject mismatch (grant for A used by B) | DENY `DELEGATION_NOT_DELEGATEE` |
| Cross-tenant use of a tenant grant (A-09) | DENY `DELEGATION_UNKNOWN_GRANT` (no existence leak) |
| Foreign-tenant grant read via RLS-bound scope | invisible ⇒ `UNKNOWN_GRANT` |
| Forged/altered tenant claim | DENY (tenant-scoped re-read + RLS) |
| Altered chain (delegator manifest rotated, A-16) | DENY `DELEGATION_DELEGATOR_AUTHORITY_CHANGED` |
| Stale/revoked grant | DENY `DELEGATION_REVOKED` |
| Expired grant | DENY `DELEGATION_EXPIRED` |
| Malformed/over-broad grant at grant time | refused (`DELEGATOR_AUTHORITY_EXCEEDED`, `INVALID_LIFETIME`, `WILDCARD_REFUSED`, `SELF_DELEGATION_REFUSED`, `CHAIN_DEPTH_EXCEEDED`, `APPROVAL_REQUIRED`) |
| Chained escalation (depth > 2) | refused at grant time |
| One-shot double-use (concurrent) | exactly one CAS winner |
| Replayed envelope | fails closed (no duplicate side effect) |
| Revoke-after-decide, before-enforce | DENY before the side effect |

All refusals go through the authoritative durable path and are durably
auditable (deny receipts + `DELEGATION_DENIED` event capability).

---

## 6. Build / lint / secret-scan

| Gate | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | all workspaces passed |
| Lint | `npm run lint` | 0 errors, 60 warnings (all pre-existing; no S4-file warnings) |
| Secret scan | `npm run scan:r2` | `findings: 0` — PASS (artifact `docs/verification/r2-secret-scan.json` updated) |
| Full test | `npm test` | 50/50, Failed 0, Skipped 0 |

---

## 7. S1 / S2 / S3 regression

The S1 identity core, S2 session tokens/fanout, and S3 privilege plane suites
all remain green (authentication 175 tests, authorization-boundary 177 tests,
full workspace 50/50 with 0 skip). No test was weakened or removed; no silent
PG skip was introduced.

---

## 8. Evidence-durability status

- **S4**: this canonical report is committed under `docs/verification/` with
  exact SHAs, commands, and results (this document).
- **S2/S3 gap (identified)**: the S2 and S3 reports are absent from
  `docs/verification/` (their verification was recorded as PR-body attestation
  only). **Remediation follow-up**: backfill canonical
  `docs/verification/P2_S2_VERIFICATION_REPORT.md` and
  `docs/verification/P2_S3_VERIFICATION_REPORT.md` artifacts from the existing
  PR evidence.
- **Independent verification**: NOT yet performed. A genuinely separate pass
  (independent reviewer/process, not this implementation session) must re-run
  the commands and record its own result before this can be marked
  independently verified.

---

## 9. F1–F6 carried-forward status

| Id | Finding | Status after S4 |
| --- | --- | --- |
| F1 | Service-elevation coverage (service seams) | OPEN / NON-BLOCKING — not exercised by S4 |
| F2 | Service-seam session binding | OPEN / NON-BLOCKING — not exercised by S4 |
| F3 | `approvalRequired` enforcement (register-only in S3) | OPEN / NON-BLOCKING — S4 exercises approval-mandatory-at-grant; decision-time approval re-check remains limited |
| F4 | Bootstrap operator / CLI gap | OPEN / NON-BLOCKING — the delegation resolver is wired in `bootstrap.ts`, but no CLI operator surface exists yet |
| F5 | Step-up re-verification | OPEN / NON-BLOCKING — not in S4 scope |
| F6 | A-16/A-24 adversarial exercise (S4 acceptance) | **CLOSED by direct evidence** — chain-integrity rotation (A-16) and one-shot/consumption/replay races (A-24) are exercised in `p2-s4-delegation-decision.test.ts` / `p2-s4-delegation-store.test.ts` |

---

## 10. Known limitations & unresolved findings (not silently weakened)

1. **Platform-scoped delegation consumption ordering**: a platform grant is
   consumed in a system-scope transaction BEFORE Tx-1 (the safe direction —
   never a double-use); it cannot share Tx-1's tenant transaction (different
   RLS scopes). A Tx-1 failure after a platform-grant consume loses one use
   (fail-closed; documented, not an over-authorization).
2. **Target-subset at grant time is exact-or-`*`**: the store accepts a grant
   target only when it equals a registered delegator target or the delegator
   holds `*`. Glob re-narrowing (e.g. `res-a-*` ⊆ `res-*`) is NOT inferred —
   conservative, fail-closed (rejects some valid narrowings; never accepts an
   over-broad grant). The authoritative per-decision resource check is the
   exact `targetMatches` semantics.
3. **Delegation semantics in the flat A-01 model**: the delegation stage
   verifies, cites, and consumes a durable delegation claim and enforces the
   grant's narrowing constraints; it does not add new PDP authority beyond the
   existing tenant-scoped capability model (no escalation is introduced).
4. **Prompt-injection / confused-deputy / sandbox-escape / tool-abuse /
   indirect-instruction / cross-tenant RAG-cache contamination** remain
   explicitly UNRESOLVED — model output is never an authority source in this
   implementation, but comprehensive agent-authorization security is NOT
   claimed from S4 alone.
5. **KMS/HSM, HA/PITR, advanced identity gaps** remain tracked and are out of
   S4 scope.
6. **Decision-time approval re-check** validates the bound approval's expiry
   and the live manifest's `requiresApproval`; a full digest-equality re-check
   against a re-fetched approval record is not performed (the approval is
   bound at grant time). Tracked.

---

## 11. Merge & production readiness

- **Merge**: NOT performed. This report does not constitute merge
  authorization. Merging requires a separate, explicit human authorization
  after independent verification.
- **Production**: NOT declared. No production-readiness, full-hardening, or
  95%/120% claim is made without environment evidence.
- **Independent verification status**: PENDING (not yet performed).

---

## 12. Commands to reproduce

```bash
git checkout 66e78835cc7b6d4dea5de14a0d4f6a3bd564c5cf   # baseline (read-only check)
npm ci --no-audit --no-fund
npm run build
npm test
npm run lint
npm run scan:r2

# S4 suites (after implementation commit 5623af56a8a6844b1bc85d55bf1a2861b4464995):
cd packages/authentication  && node --test dist/test/p2-s4-delegation-store.test.js
cd packages/authorization-boundary && node --test dist/test/p2-s4-delegation-decision.test.js
cd packages/cli && node --test dist/test/p2-s3-posture-invariants.test.js
```
