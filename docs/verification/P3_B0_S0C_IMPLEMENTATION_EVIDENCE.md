# P3-B₀ S0c (OD-5) — IMPLEMENTATION EVIDENCE RECORD

| Field | Value |
|---|---|
| Document class | **IMPLEMENTATION EVIDENCE** — records what the S0c slice changed, how it was tested, and what remains open. This record is **evidence, not authorization**; it grants nothing and certifies nothing independently. |
| Authorization | Owner, 2026-09-19/20 (explicit, S0c-only): *"I explicitly authorize implementation of P3-B₀ S0c only, based on the completed and post-merge-verified S0b state."* |
| Slice | **S0c / OD-5 only** — truthful external-side-effect authorization: (i) new capabilityId for the external-side-effect capability, (ii) egress-envelope consume-once at all three required sites. |
| Baseline | `main @ 193d2601ffb438da081000a88970b85b1cb6b40e` (PR #42 / S0b merge commit) — verified live before editing (`git rev-parse origin/main`). |
| Canonical design | `docs/P3_B0_GOVERNED_EGRESS_DESIGN_RECORD.md` §4.5 (OD-5), §5.6, §8 (I-5), §9 (sequencing), §11 (U-3(α) elected). |
| Evidence base for the defect | PR #39 assessment §7.4 (F-3, VERIFIED DEFECT), §8.2 (T-10, VERIFIED), correction D-2 (third consumption site). |
| Standing state (unchanged) | Score **9.484375% FROZEN** · P2-E4 **NOT ACHIEVED** · **PRODUCTION NOT READY** · no finding closed here except as evidenced below. |
| Independent verification | **NOT performed by this record's author.** A separate read-only session must verify before any merge; merge requires a separate explicit owner decision. |

---

## 1. PRE-CHANGE DEFECT MEASUREMENT (at baseline `193d260`)

Confirmed S0c defects, measured by direct source inspection before any edit:

| # | Defect | Measured location | Content |
|---|---|---|---|
| M-1 | F-3 live: `vector.search` authorized as internal READ while its effect is credentialed external transmission | `agent-runtime/src/builtins.ts` | `KNOWLEDGE_READ_CAPABILITY` (`capabilityId: 'internal-knowledge.read'`, `impact: 'READ'`) shared by `vector.search`, whose execute path is `embedAndSearch` → `model.embed(text)` → credentialed outbound POST at `vector-search/src/embeddings.ts` (N-2 seam) |
| M-2 | T-10 site 1+2 (R1 in-memory): READ envelopes never consumed | `authorization-boundary/src/gate.ts` | replay check `if (verified.impact !== 'READ')` and pre-await add `if (verified.impact !== 'READ')` — the exact `gate.ts:407-408` / `:453` sites of the assessment |
| M-3 | T-10 site 3 (durable S-4): READ envelopes never consumed | `authorization-boundary/src/consumption-stores.ts` | `if (input.impact === 'READ') return { consumed: false };` documented as intentional R1 parity — the `consumption-stores.ts:75` site of the assessment (correction D-2) |
| M-4 | Enforcement intensity derived solely from the declared impact label | all three sites | no representation of "this decision binds an external side effect" existed anywhere (0 hits) — a misdeclared READ capability (M-1's shape) evaded consumption at every site |

Consequence (as assessed): one authorization permitted **unlimited repeat external transmission** of tenant data, consistently across all three sites, forensically invisible as egress.

## 2. WHAT S0c IMPLEMENTS (exact scope)

### 2.1 OD-5(i) — truthful impact declaration via NEW capabilityId (U-3(α), elected)

- `builtins.ts`: `vector.search` now declares **`VECTOR_SEARCH_EGRESS_CAPABILITY`** —
  `capabilityId: 'internal-knowledge.vector-search-egress'` (the id named by design §4.5(i)),
  `impact: 'EXTERNAL_SIDE_EFFECT'` (the truthful level per the closed enum, `types.ts`),
  `dataClassification: 'INTERNAL'`, `targetSystem: 'tenant-knowledge'`, `operation: 'search'`.
- The false binding is **retired**: `vector.search` no longer runs under `internal-knowledge.read`.
  That capability remains, unchanged, the declaration of the genuinely read-only tools
  (`knowledge.search`, `graph.traverse`, `graph.findEntity`, `graph.retrieve`).
- The new capabilityId is **distinct** from the false one; nothing resurrects or broadens the
  false capability. Raising the old capability's ceiling remains impossible: `isNarrowing`
  still rejects impact-ceiling raises (B-1 preserved — test-asserted in §4), which is exactly
  why the correction uses a new capabilityId.
- Manifests registering `internal-knowledge.vector-search-egress` MUST declare
  `egressBound: true` (§2.2); a registration under a READ ceiling refuses the truthful
  declaration with `IMPACT_EXCEEDED` (test-asserted), so the retired shape cannot serve egress.
- **Governance note (deployment):** capability authority is granted by registration events,
  not by code; a production composition must register the new capability with
  `egressBound: true` and retire the `vector.search` binding under `internal-knowledge.read`
  via the corresponding governance registration event. No production manifest registration
  exists in-repo (registration is operator/governance-driven), so no bootstrap change belongs
  to this slice.

### 2.2 OD-5(ii) — egress-envelope representation + consume-once at all three sites

**Representation.** A manifest may declare `egressBound: true` (registered governance fact).
Registration validation accepts **only the literal `true`** — an explicit `false` or any
non-boolean value is an ambiguous declaration and is rejected (`ManifestRejectedError`,
fail-closed). The PDP derives the binding from the resolving manifest and seals
`egressBound: true` into the decision envelope (both decision paths: R1 sync `decide()` and
the durable `DurableDecider`). There is **no request-side source** for the flag: no request
field, caller metadata, model output, or tool input can set it. The flag is covered by the
envelope integrity digest — adding, removing, or altering it after sealing is detected as
`ENVELOPE_TAMPERED`. Non-egress decisions keep the exact pre-S0c envelope shape.

**Enforcement.** A single shared predicate, `requiresEnvelopeConsumption(envelope)` =
`impact !== 'READ' || egressBound === true`, is enforced at **all three required sites** —
one implementation, no drift:

| Site | Location | Change |
|---|---|---|
| 1 — R1 in-memory replay check | `gate.ts` `executeAuthorized` | `if (verified.impact !== 'READ')` → `if (requiresEnvelopeConsumption(verified))` |
| 2 — R1 pre-await consumption | `gate.ts` `executeAuthorized` | same predicate for the `consumedEnvelopes.add` |
| 3 — durable S-4 claim | `consumption-stores.ts` `consumeEnvelope` (called by `durable-decider.ts` Tx-1) | READ early-return now applies **only** when the decision is not egress-bound; the sealed binding is passed in from the verified envelope |

**Semantics (design §4.5(ii), verbatim posture):** enforcement intensity derives from
**whether the decision binds a side effect**, not from the declared impact label — an
egress-bound envelope labeled READ (the exact F-3 shape) consumes exactly once. `READ`
remains non-consuming **only** for genuinely read-only decisions (no egress binding),
preserving the prior replay parity for true reads (R1 and durable, both test-asserted).
This is a **policy-model change with migration note** (recorded at `consumeEnvelope`):
pre-existing stored S-4 rows are unaffected; the change governs whether NEW decisions
consume. **Closes T-10 for the egress class without altering READ replay semantics for
true reads** — satisfying invariant I-5 of the design record.

### 2.3 Changed files (exact)

| File | Change |
|---|---|
| `packages/authorization-boundary/src/types.ts` | manifest type + envelope type gain optional `egressBound` with invariant documentation |
| `packages/authorization-boundary/src/capability-manifests.ts` | `validateManifestShape`: only literal `true` registrable (fail-closed). **`isNarrowing` and `targetMatches` untouched (byte-stable)** |
| `packages/authorization-boundary/src/envelope.ts` | `sealEnvelope` seals the PDP-derived binding; new exported `requiresEnvelopeConsumption` (the single predicate) |
| `packages/authorization-boundary/src/gate.ts` | sites 1+2: predicate replaced; `decide()` seals the binding; header comment updated |
| `packages/authorization-boundary/src/consumption-stores.ts` | site 3: binding-aware consumption + migration note |
| `packages/authorization-boundary/src/durable-decider.ts` | durable decision path seals the binding; Tx-1 passes it to the S-4 claim |
| `packages/authorization-boundary/src/index.ts` | exports `requiresEnvelopeConsumption` |
| `packages/agent-runtime/src/builtins.ts` | OD-5(i): new truthful capability for `vector.search`; false binding retired; genuine reads unchanged |
| `packages/authorization-boundary/test/p3-s0c-egress-consume-once.test.ts` | **new** — 34 adversarial tests (R1 + durable unit + durable end-to-end on real embedded PostgreSQL, fail-hard) |
| `packages/agent-runtime/test/p3-s0c-truthful-declaration.test.ts` | **new** — 6 tests (declaration truthfulness + ToolRegistry end-to-end consume-once / fail-closed) |

**Total: 10 files — 8 modified, 2 added. Zero changes outside `authorization-boundary` src/test and `agent-runtime` src/test.**

## 3. ADVERSARIAL COVERAGE MAP (owner-mandated list)

Numbering: A-1…A-5 (registration discipline), B-1…B-15 (shared predicate + R1 gate — the
first three tests of that block pin the single consumption predicate; B-1…B-15 number the R1
gate tests in file order), C-1…C-6 (durable S-4 unit), and D-0 (PostgreSQL-started canary) +
D-1…D-4 (durable end-to-end) are the tests in file order of the five describe blocks of
`p3-s0c-egress-consume-once.test.ts`; E-1…E-4 are the tests of the end-to-end describe block
of `p3-s0c-truthful-declaration.test.ts` (its first describe block, declaration truthfulness,
adds two more tests).

| Requirement | Evidence (test) |
|---|---|
| valid S0c authorization succeeds | B-1 (R1 ALLOW + sealed binding + one execution); D-1 (durable); E-1 (registry e2e) |
| missing/invalid authorization fails closed | B-7 DENY envelope ⇒ `ENVELOPE_NOT_ALLOWED`; B-8 malformed ⇒ `ENVELOPE_MALFORMED`; E-4 no envelope ⇒ `AUTHORIZATION_ENVELOPE_MISSING`; D-4 unregistered capability ⇒ `UNKNOWN_CAPABILITY` (R1 + durable) |
| first valid envelope consumption succeeds | B-1, D-1, E-1 |
| second use of the same envelope fails | B-3, D-1, D-2, E-1 (`REPLAYED_AUTHORIZATION`, side effect ran exactly once) |
| replay after successful consumption fails | B-4 (time-advanced replay still refused on CONSUMPTION, not expiry) |
| cross-tenant reuse fails | B-11 (sealed tenant re-point ⇒ `ENVELOPE_TAMPERED`); C-4 (durable S-4 claim under a different tenant ⇒ `REPLAYED_AUTHORIZATION`, original tenant row intact) |
| cross-principal reuse fails | B-12 (sealed principal substitution ⇒ `ENVELOPE_TAMPERED`); C-5 (durable S-4 claim under a different principal refused, original `consumedBy` intact) |
| malformed/tampered envelope fails | B-8 (structurally broken), B-10 (egress-binding strip AND binding forge ⇒ `ENVELOPE_TAMPERED`), B-11, B-12 |
| wrong capabilityId fails | B-13 (retired READ capability refuses `EXTERNAL_SIDE_EFFECT` ⇒ `IMPACT_EXCEEDED`); B-14 (capability confusion: other tool/operation/target ⇒ `OPERATION_SUBSTITUTION` / `TARGET_SUBSTITUTION`); D-4 (`UNKNOWN_CAPABILITY`); E-2 (retired capability cannot grant the truthful declaration); E-3 (READ-ceiling registration under the egress id refuses the truthful declaration); A-4 (new id ≠ false id, no resurrection) |
| expired/invalid envelope state fails | B-9 expiry ⇒ `AUTHORIZATION_EXPIRED`; C-6 malformed consume inputs fail closed |
| **all three required sites enforce consume-once** | sites 1+2 (R1): B-3 and B-5 (F-3 shape — READ-labeled egress-bound envelope consumed on the in-memory path); site 3 (durable S-4): C-2/C-3 unit + D-2 (**READ-labeled egress-bound envelope consumes exactly once on real PostgreSQL**); integrated durable path: D-1 |
| existing S0b behavior intact | full `@jataqi/authentication` suite **390/390 PASS**; S0b files byte-stable (§5) |
| relevant P2 invariants intact | full repo suite 50/50 (§4); `isNarrowing` ceiling-raise refusal asserted (A-5); closed audit field set refusal asserted (B-15); byte-stability diff (§5); true-read parity preserved R1+durable (B-6, C-1, D-3); B-2 (no binding sealed for non-egress decisions — no widening) |

## 4. EXECUTED EVIDENCE (Node 20 = CI parity; Node 22 = local parity)

Environment: sandbox Linux, `npm ci` clean install; Node **v20.18.1** via the npm-distributed
Node 20 binary (CI runs Node 20 per `ci.yml`); Node **v22.22.3** = the sandbox default.

**Pre-change baseline (Node 20.18.1):** build PASS (50 workspaces) · lint **0 errors / 60
warnings** · `@jataqi/authorization-boundary` **188/188 PASS, 0 skip** (embedded PostgreSQL
executed) · `@jataqi/agent-runtime` **80/80 PASS**.

**Post-change (Node 20.18.1):**
- build: **PASS** (all 50 workspaces).
- lint: **0 errors / 60 warnings** — identical to baseline (no new warnings).
- `@jataqi/authorization-boundary`: **222/222 PASS, 0 fail, 0 skip** (188 baseline + 34 new;
  PostgreSQL integration executed, no SKIP).
- `@jataqi/agent-runtime`: **86/86 PASS, 0 fail, 0 skip** (80 baseline + 6 new).
- `@jataqi/authentication` (S0b re-verification): **390/390 PASS, 0 fail, 0 skip**.
- **Full repository suite: 50/50 workspaces PASSED, 0 failed, 0 skipped** (PostgreSQL
  integration executed, no SKIP).

**Node 22 parity (v22.22.3):** the two new S0c suites re-run — 34/34 and 6/6 PASS (embedded
PostgreSQL started under Node 22 as well). The full-suite CI run on the PR head (Node 20) is
the independent platform-side confirmation.

## 5. INVARIANT CHECKS (byte-stability at `193d260` → S0c head)

Verified by `git diff`: **UNCHANGED** — `isNarrowing` (function body) · `targetMatches`
(S0a-corrected matcher) · `delegationTargetMatches` (`authentication`) ·
`r17-matcher-conformance.test.ts` · `T16_GRANT_CORPUS_REEVALUATION_REPORT.md` · `audit.ts`
(`ALLOWED_AUDIT_FIELDS` + `assertAllowedAuditShape`) · `secret-material.ts` /
`egress-credential.ts` (S0b) · `docs/rubric/*` (frozen score) · `.github/workflows/ci.yml`.
The only `capability-manifests.ts` change is the additive `egressBound` registration check
inside `validateManifestShape`. `ALLOWED_S4_FIELDS` (consumed-envelope row schema) unchanged —
the S-4 row shape is identical; only WHETHER an egress-bound decision inserts one changed.

## 6. DEFECT DISCIPLINE — FINDINGS CLASSIFICATION

| Finding | Class | Disposition |
|---|---|---|
| M-1…M-4 (F-3/T-10 shape) | **confirmed S0c defect** | remediated (this slice, with evidence) |
| **R-1:** `knowledge.search` (`KnowledgeService.retrieve` → `embedAndSearch`), `graph.findEntity` (`findEntities` → `embedAndSearch`), and `graph.retrieve` (graph-RAG → `embedAndSearch`) ALSO reach the N-2 embedding seam yet remain declared `internal-knowledge.read` / `READ` | **pre-existing defect — OUT OF SCOPE** | F-3 was verified specifically for `vector.search` and OD-5 names only the vector-search egress capability; broadening the remediation was not authorized. Recorded, not fixed. Their READ envelopes remain non-consuming until separately truthified. |
| **R-2:** `isNarrowing` is byte-stable by invariant mandate, so a future version of an egress-bound capability could drop `egressBound` in a narrowing registration without rejection (no egressBound-preservation rule) | **hardening opportunity — OUT OF SCOPE** | recorded for S1/future consideration; the S1 destination-policy `capabilityBinding` is expected to subsume egress binding. No code changed. |
| **R-3:** `ALLOWED_AUDIT_FIELDS` carries no egress destination knowledge (B-5 class) | **out of scope** | OD-6 (separate `EgressAuditRecord`) belongs to S1; `ALLOWED_AUDIT_FIELDS` untouched by mandate. |
| No new evidence/mechanism weaknesses identified in the S0c surface; the sealed binding has no caller-side input path and is digest-covered. | — | — |

**Only confirmed S0c defects were remediated. No unrelated finding was fixed, reclassified, or closed.**

## 7. EXCLUSIONS (authorized scope boundary — nothing beyond S0c touched)

NOT implemented / NOT touched: S1 · S2 · S3 · general egress-plane implementation ·
provider adapter cutover · removal of remaining direct provider env reads · redirect policy ·
R-16 static ban · matcher changes · R-17 changes · T-16 amendment · I-6/B-4 remediation ·
U-2…U-8 reconstruction · PR #39 changes · P2-E4 score/rubric changes · ruleset changes ·
repository visibility/settings · production deployment or any readiness claim · any unrelated
hardening (including R-1/R-2/R-3 above).

## 8. GOVERNANCE STATE

- **No merge authorization** is requested, implied, or assumed by this record.
- **Independent verification by a genuinely separate session is required** (read-only; this
  implementation session must not self-verify). After IV, the verified result returns to the
  owner for a separate, explicit merge decision.
- **P2-E4:** score **9.484375% FROZEN / NOT ACHIEVED** — rubric files untouched.
- **PRODUCTION: NOT READY.** No readiness claim is made or implied.
- S1 remains locked; it requires its own separate explicit authorization.

*— End of S0c implementation evidence record —*
