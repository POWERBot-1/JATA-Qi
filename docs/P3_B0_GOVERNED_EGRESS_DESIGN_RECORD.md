# P3-B₀ — GOVERNED EGRESS CONTROL PLANE
# DESIGN DECISION RECORD (BOUNDED DESIGN-ONLY PHASE)

| Field | Value |
|---|---|
| Document class | **DESIGN RECORD — DOCUMENTATION ONLY.** No production code. No remediation. This document **implements nothing** and **authorizes nothing by itself**. |
| Authorization | **Owner, 2026-09-18:** *"AUTHORIZE P3-B₀ — BOUNDED DESIGN-ONLY PHASE."* Scope strictly limited to design/governance artifacts resolving **OD-1…OD-7** and satisfying the documented P3-B₀ prerequisites. |
| Explicitly NOT authorized (verbatim scope) | No production-code implementation · no remediation commits · no P3-B implementation · no P3-B₀-to-P3-B promotion · no merge of PR #39 · no merge of any future implementation PR · no score recalculation · no governance-rule or ruleset changes · no changes to existing findings merely to make the design pass · no claim of production readiness |
| Design baseline | `6b61256c6115a02da2d3ad6ba42771831b550f81` == `origin/main` (verified at design time; tree clean) |
| Evidence base | PR #39 assessment at **`608a6ead7e6a018c29b872afa982ba99dcb9afcf`** (R2) + independent verification record at **`86c00d1b14973e9a803ee088d2d287d74b0831f1`** (separate-party). **Every finding state in that evidence base is preserved unchanged by this record (§1.4).** |
| Author | Arena session `arena/01a0b377-jata-qi` (same session that performed the independent verification; **author-to-be of nothing else here**) |
| Date (UTC) | 2026-09-18 |
| Standing state (unchanged) | Score **9.484375% FROZEN** · P2-E4 **NOT ACHIEVED** (permanently capped) · **PRODUCTION NOT READY** · PR #39 **OPEN, UNMERGED** · all findings **OPEN** as registered |

---

## 1. MANDATE, METHOD, AND DISCIPLINE

### 1.1 What this document is

The committed design record referenced by gate condition **G-1** of the PR #39 assessment (§23.2):
*OD-1…OD-7 resolved in a committed design record*. Each owner decision receives a **DESIGN
DISPOSITION** — the design resolution the owner ratifies or amends at the P3-B₀ **exit gate** (§12).
A design disposition is **not** an owner ratification; it is the evidence-based resolution placed
before the owner with its options analysis, rejected alternatives, and preserved invariants.

### 1.2 Method

- Every disposition is derived from the **independently verified evidence base** (PR #39 R2 + the
  separate-party verification record), not from the same-agent portions of earlier context.
- All source anchors were re-read at the baseline during this phase (read-only).
- **Ambiguity rule (honored):** where the evidence leaves a genuine choice or an undefined term,
  it is **recorded** in §11 (U-1…U-8) with options and a recommendation — **never silently resolved**.

### 1.3 Absolute constraints (preserved throughout; verified per section)

| Constraint | Preservation mechanism in this design |
|---|---|
| **DC-1** No destination may become model- or tool-influenced | Destination selection is by **policy registry key only** (§4.2); request/model content can never name, select, or construct a destination |
| **DC-2** Fail-closed polarity everywhere | Every new decision point defaults to DENY on ambiguity, absence, or unavailability (§4.3, §5.4, §5.7) |
| **DC-3** `isNarrowing` must not be weakened | Destination policy lives **outside** the manifest model entirely (§4.1); `isNarrowing` is not touched |
| **DC-4** Closed audit field set anti-smuggling survives | A **separate** egress audit record with its **own** closed field set (§4.6); `ALLOWED_AUDIT_FIELDS` untouched |
| **DC-5** N-3 precedent is the floor | The enforced transport adopts N-3's properties as defaults (§5.1): scheme restriction, `redirect:'error'`, fetch-once, injectable fetcher |
| **DC-6** N-1 governed though it is not a tool | The control point sits at the **transport**, below both the tool path and the per-turn LLM path (§3) |
| **DC-7** Static ban on ungoverned `fetch` | §5.8 designs the lint gate on the existing `openNamespace` precedent (`eslint.config.mjs:58-70`) |

### 1.4 Findings integrity statement

**No finding was changed to make this design pass.** The register stands exactly as independently
verified: 5 blockers (B-1…B-5), defects F-3…F-18, T-02 CONFIRMED, T-03 REFUTED (cross-origin),
T-08 REFUTED, T-07 PARTIAL, T-15/T-16 OPEN, F-8 UNVERIFIED, TA-4 absent, INV-13 UNKNOWN. Where the
design dispositions a finding, it says so without reclassifying it; remediation remains **0**.

---

## 2. DESIGN INPUTS (verified anchors used)

| Input | Anchor (baseline `6b61256`) | Role in design |
|---|---|---|
| Egress seams N-1/N-2 | `agent-runtime/src/llms/openai.ts:72`; `vector-search/src/embeddings.ts:109` | The only two credentialed call sites the plane must govern |
| N-3 precedent | `authentication/src/jwt.ts:235` (`redirect:'error'`, fetch-once, injectable fetcher) | Floor properties for the enforced transport (DC-5) |
| Enforcement pattern | `authorization-boundary/src/gate.ts:380-404` (single enforcement entry; decision-audit write **awaited before** the side effect; `AUDIT_UNAVAILABLE` fail-closed) | Shape of the Egress Enforcement Gate |
| Consumption sites | `gate.ts:407-408,:453`; `consumption-stores.ts:75` (intentional at `:60-61`) | OD-5 replay-policy change surface |
| Impact vocabulary | `types.ts:25` (`A01ImpactLevel`), `:34-39` (`EXTERNAL_SIDE_EFFECT` is the truthful impact for external transmission) | OD-5 ceiling correction target |
| Envelope credential-binding precedent | `types.ts:364-367` (id/audience/scopes, never material; *"validates at decision and re-acquires at enforcement"*) | OD-7 credential-handle pattern |
| Secret seam | `secret-material.ts:64-70` (closed `SecretPurpose`), `:72` (`SecretOperation` incl. `rotate`,`revoke`), `:298-300` (closed-set rejection) | OD-7 extension surface |
| Identity exists upstream | `agent.ts:132-140` (envelope with verified principal; `MISSING_PRINCIPAL` fail-closed); N-1 call site `agent.ts:227` (`this.llm.complete(...)`) | OD-3 threading source and injection point |
| Identity void at seam | `llm.ts:17-23` (`LLMRequest`, 5 fields, 0 identity) | OD-3 gap being closed |
| Matcher sites | `capability-manifests.ts:267-284` (`.join('.*')` `:281`); `delegation-types.ts:385-402` (`.join('.*')` `:399`); byte-identical bodies; coupling comments `:381,:404-409` | OD-4 remediation surface |
| Package dependency direction | `authorization-boundary/package.json` depends on `@jataqi/authentication`; `authentication/package.json` does **not** depend back; both depend on `@jataqi/core-kernel` | Where R-17 lives; where a shared helper *could* live (deferred, §4.4) |
| Live matcher consumers | PDP `policy-engine.ts:304`; delegation `:438-440` serving `:442-445` (two enforcement sites) | OD-4 blast radius and T-16 |
| Bootstrap wiring | `bootstrap.ts:574-575,:591-592` (adapters built from raw `env.OPENAI_API_KEY`); `cli/config.ts:14,:99` | OD-2/OD-7 wiring to change (design only) |
| Lint precedent | `eslint.config.mjs:58-70` (`no-restricted-syntax` guardrail with driver/test overrides) | R-16 static-ban pattern |
| Field-set precedent | `audit.ts:29` (`ALLOWED_AUDIT_FIELDS`), `:87` (`assertAllowedAuditShape`) | OD-6 mirror for the egress record |

---

## 3. TARGET ARCHITECTURE (design)

**Single enforced choke point.** All provider-bound traffic is routed through one component —
the **Egress Transport** — which cannot be reached except through the **Egress Enforcement Gate**.
The tool path and the per-turn LLM path (N-1 is *not* a tool, DC-6) both traverse the same gate.

```
agent loop (agent.ts:227) ──┐
tool: vector.search   ──────┤   ┌────────────────────────────────────────────────┐
(any future provider)  ─────┴──▶│ EGRESS ENFORCEMENT GATE                        │
                                │  1. EgressContext REQUIRED (fail-closed)        │
                                │  2. DESTINATION POLICY decision (deny-default)  │
                                │     · canonicalize (R-03)                       │
                                │     · corrected segment-glob match (B-3 fix)    │
                                │     · scheme allowlist (R-04)                   │
                                │     · resolved-address class check (R-07/R-08)  │
                                │  3. CREDENTIAL resolution via handle (OD-7)     │
                                │  4. RATE/VOLUME ceiling per destination (R-15)  │
                                │  5. EGRESS AUDIT WRITE — awaited (OD-6, R-13)   │
                                │  6. ENVELOPE CONSUMED (OD-5 replay policy)      │
                                └───────────────┬────────────────────────────────┘
                                                ▼
                                ┌────────────────────────────────────────────────┐
                                │ EGRESS TRANSPORT (the ONLY fetch site)          │
                                │  · https only · redirect:'error' (R-05)         │
                                │  · mandatory deadline, internal AbortController │
                                │    ANDed with caller signal, never extended     │
                                │    (R-09)                                       │
                                │  · pinned resolution; no re-resolve (R-08)      │
                                │  · byte accounting + status capture (R-11)      │
                                │  · injectable fetcher (tests; N-3 parity)       │
                                └────────────────────────────────────────────────┘
```

**Placement of new types (design):** packages that can host each component without reversing any
documented dependency (§2): the egress plane core (policy store, gate, audit record type, transport)
is designed as a **new package** (`@jataqi/egress-control-plane`) depended on by `agent-runtime`,
`vector-search`, and `cli` — the direction *consumers → plane*, never *plane → consumers*. The
corrected matcher semantics arrive via the **OD-4 prerequisite slice** in the two existing packages
(§4.4); the plane consumes `targetMatches` only after that slice lands (or implements its own
identical semantics under the R-17 corpus, recorded option U-4).

---

## 4. OWNER DECISIONS (OD-1…OD-7) — DESIGN DISPOSITIONS

### 4.1 OD-1 — Destination representation given `isNarrowing` forbids adding targets

**DESIGN DISPOSITION: option (a) — a destination-policy model outside the manifest system.**
Option (b) (authorized weakening of `isNarrowing`) is **rejected**: it weakens a tested P2 control
(DC-3) and, per the verified evidence (assessment §22), its rollback would strand manifests
registered under the weakened rule in an inconsistent state.

**`EgressDestinationPolicy` (logical model, design sketch):**

| Field | Semantics |
|---|---|
| `policyId` / `policyVersion` | Identifies the policy; versions are **insert-once, immutable** (P2 manifest cadence mirrored, without the narrowing rule — destinations are *grants*, not capability ceilings) |
| `entries[]` | `{ scheme: 'https' \| 'http-dev' }`, `hostPattern` (corrected segment-glob, §4.4), optional `pathPrefix`, optional `portList` |
| `capabilityBinding` | Which capability/capabilities may use this policy (binds R-10 decision context to a declared purpose) |
| `tenantScope` | Tenants the policy applies to; no wildcard without explicit `allowTenantWildcard` (P2 shape precedent) |
| `approvalReference` | Governance event that enrolled the policy |
| `digest`, `registeredAt`, `registeredBy` | Integrity and provenance fields |
| `status: ACTIVE \| RETIRED \| REVOKED` | Revocation is **immediate and fail-closed** destination-wide |

**Governance properties (design):** empty registry ⇒ **no egress anywhere** (R-01 deny-by-default);
registration is an audited governance event, not a code edit; retrieval failures are
`EGRESS_POLICY_STORE_UNAVAILABLE` (R-13). Narrowing invariant **untouched** — manifests remain for
operations/targets as before; destinations simply do not route through them.

### 4.2 OD-2 — Where the destination value comes from

**DESIGN DISPOSITION: operator-enrolled registry; provider defaults ship as *proposed*
enrollments, never as silent configuration.**

- The operator enrolls destinations explicitly (bootstrap config or migration submitting
  policy-registration events). `cli/config.ts:99`-style raw env plumbing is the *credential* path
  only (and is replaced per §4.7); it plays **no** destination role (verified: `endpoint`
  occurrences in `bootstrap.ts`/`config.ts` = 0 per assessment §5.3 — the operator **never** had a
  destination knob; this design *creates* it deliberately).
- A code-shipped constant registry of provider defaults (e.g. `api.openai.com`) may exist **only**
  as *proposals* that become active on explicit enrollment. Boot logs MUST distinguish
  *proposed* vs *enrolled*. No enrollment ⇒ adapter complies by construction: the transport denies
  with `EGRESS_DESTINATION_NOT_ALLOWED`.
- **DC-1 enforcement (binding):** the destination is selected **by key** (capability → policy), and
  the matcher input is the policy's hostPattern vs the canonicalized target. Model output, tool
  input, and prompt content are **structurally unable** to name/alter a destination: no API accepts
  a caller-supplied destination string (verified need: `agent.ts:227` passes only messages/tools;
  `vector-module.ts:114` passes only text).

### 4.3 OD-3 — Identity-propagation architecture + absent-context semantics

**DESIGN DISPOSITION: option (a) — explicit threading of an `EgressContext`; option (b)
(`AsyncLocalStorage`) rejected** (zero codebase precedent — verified 0 hits; ambient context is an
ambiguity-hiding mechanism contrary to DC-2).

- **`EgressContext`** (design): `{ principalId, tenantId, agentId, runId, correlationId,
  envelopeId }` — constructed **only** by the agent/kernel runtime from the already-verified
  authorization envelope (`agent.ts:132-140` evidence that verified identity exists upstream).
  `LLMRequest` (5 fields) is **not** extended: the context is a separate, runtime-only parameter
  that never enters the model-facing payload (preserves "model output cannot author authority").
- **Injection points:** `agent.ts:227` (`this.llm.complete(...)`) and the embedding path
  (`vector-module.ts:114` → `embeddings.ts:109`). Adapter signatures gain a **required** context
  parameter (compile-time enforcement — absent context is a type error at build, not a runtime
  possibility).
- **Absent-context semantics (G-2 satisfied by design):** any null/missing/mismatched field ⇒
  deny `EGRESS_IDENTITY_MISSING` **before any network activity**, audited as a denied egress
  decision. There is no fallback identity, no default tenant, no ambient lookup.
- **N-1 coverage (DC-6):** the per-turn completion call carries the same envelope-derived context
  as tool calls; N-1 needs no tool registration to be governed because the gate is at the transport.

### 4.4 OD-4 — Matcher remediation (BOTH sites) and the R-17 invariant test

**DESIGN DISPOSITION: remediate as a separately authorized P2 slice BEFORE P3-B implementation
(option (a)), at BOTH sites, with byte-identical bodies preserved and equivalence enforced by
test (R-17).** Options (b) (inside P3-B) rejected — it makes a P3 slice modify tested P2 matchers
without separate review; (c) (unify via `@jataqi/core-kernel` — the one package both sides already
depend on, §2) is **deferred, not rejected**, as an owner-available simplification with its own
review (U-4); unification is *not* a precondition of this design.

**Corrected semantics (proposed definition — recorded as U-1 for owner ratification because the
codebase never defined "segment"):** within the glob language, `*` matches zero or more characters
**excluding** the boundary characters `/` and `.`. Consequences, each traceable to a verified
bypass class:

- Host-position boundary: `https://api.openai.com*` **no longer matches**
  `https://api.openai.com.evil.com/steal` (dot excluded) — closes the T-04 suffix-confusion class;
- Host globs become label-exact: `*.openai.com` matches exactly one DNS label — closes T-05's
  *cross-label* escape as verified (the intended single-label match still succeeds);
- Path boundary: `https://api.openai.com/v1/*` **no longer matches** `…/v1/../../admin`
  (slash excluded) — closes the T-06 dot-segment class **at the matcher**, with **R-03
  canonicalization additionally required before matching** (reject on traversal, encoded slash,
  non-canonical casing/punycode) so matching never happens against raw input;
- Doc/code consistency restored: `capability-manifests.ts:262-265` and `types.ts:404` ("segment
  glob") become *true* under the corrected implementation, rather than the docs changing to bless
  the defect.

**R-17 (design):** a **conformance suite** in `packages/authorization-boundary/test/` — the one
package that may import **both** implementations (dependency direction verified, §2) — asserting
identical verdicts from `targetMatches` and `delegationTargetMatches` over a **committed corpus**
of (pattern, system, resource, expected) vectors: exact matches; `undefined`-resource matrix;
suffix-confusion set; leading-wildcard set; dot-segment set; boundary-character probes
(`?`, `#`, `@`, port forms); multi-star forms. The suite fails on **any** divergence —
replacing the `:381`/`:408` comment-promise with executable evidence. A companion static check
asserts the two bodies remain textually identical (defence against silent single-site edits).

**T-16 migration (required acceptance precondition):** the delegation consumer is **live**
(`:442-445`, two enforcement sites). The corrected semantics are **stricter** for any existing grant
pattern containing `*` adjacent to `/` or `.`. Before the slice merges: (a) enumerate deployed
grant patterns; (b) re-evaluate each under both semantics; (c) record every grant whose verdict
changes; (d) obtain explicit owner acceptance per changed grant (tightening = fail-closed, but
availability-relevant). T-16's exploitability was **UNKNOWN** (no grant corpus inspected); this
enumeration converts it to measured fact during the prerequisite slice.
**Rollback flag (§22 verbatim):** rolling back this fix restores the suffix-confusion bypass in a
matcher the PDP already consumes (`policy-engine.ts:304`).

### 4.5 OD-5 — F-3 as a separate remediation (replay policy + impact ceiling)

**DESIGN DISPOSITION: separate slice (option (a)), with two coordinated parts.**

**(i) Truthful impact declaration.** `builtins.ts:66` `impact:'READ'` is false for a capability
whose effect is credentialed external transmission; the truthful level per the closed enum is
**`EXTERNAL_SIDE_EFFECT`** (`types.ts:25,:34-39`). Because raising a ceiling is precisely what
`isNarrowing` rejects (`:164-165`) — a control this design preserves (DC-3) — the correction is
designed as a **governor-visible registration event**, not a silent edit. Options for the owner
(recorded, U-3): **(α) recommended** — register the capability under a **new capabilityId**
(`internal-knowledge.vector-search-egress`) with truthful metadata and retire the false one;
**(β)** — a one-time, explicitly authorized ceiling-correction registration audit event carrying
the old→new declaration diff. Either way: an audit record exists, `isNarrowing` is untouched.

**(ii) Replay-policy change (designed, not coded).** The enforcement intensity of an envelope must
derive from **whether the decision binds a side effect**, not from the declared impact label —
which, as F-3 proved, can misdescribe the side effect. Design: an egress-bound decision envelope
is **consumed exactly once** at all three verified sites (`gate.ts:407-408`, `gate.ts:453`,
`consumption-stores.ts:75`). The `consumption-stores.ts:60-61` comment proves READ non-consumption
was **intentional R1 parity**, so this is recorded as a **policy-model change with a migration
note**, not a code fix: after the change, `READ` remains non-consumed for genuinely read-only
decisions, while any decision marked egress-bound (by capability binding, §4.1) consumes at all
three sites. Repeat transmissions therefore each carry their own decision envelope (R-15 ceilings
apply per destination). **Closes T-10 for the egress class without altering READ replay semantics
for true reads.**

### 4.6 OD-6 — Egress audit record, preserving the closed-set anti-smuggling property

**DESIGN DISPOSITION: option (b) — a separate `EgressAuditRecord` with its own closed field set
and shape assertion, mirroring `audit.ts:29,:87` exactly.** Option (a) (widening
`ALLOWED_AUDIT_FIELDS`) is **rejected**: it weakens the anti-smuggling property (DC-4) that P2
proved valuable.

- **`ALLOWED_EGRESS_AUDIT_FIELDS` (closed, shape-asserted):** `id`, `kind`,
  `principalId`, `tenantId`, `agentId`, `runId`, `correlationId`, `envelopeId`,
  `capabilityId`, `capabilityVersion`, `policyId`, `policyVersion`, `policyDigest`,
  `destinationCanonical`, `scheme`, `port`, `resolvedIps`, `hopCount` (always 0 until/unless
  hop-following is ever authorized, §5.1), `requestBytes`, `responseBytes`, `statusCode`,
  `deadlineMs`, `deadlineOutcome`, `rateWindowId`, `reasonCodes` (closed `EGRESS_*` set, §5.7),
  `approvalReference`, `credentialReference` (handle, never material — `types.ts:364-367`
  precedent), `decidedAt`, `dispatchedAt`, `completedAt`. **Unknown field ⇒ write fails**
  (assertion mirror). No free-text body/content fields anywhere: the record proves *where, by whom,
  under what decision, with what outcome* — not *what* was said (privacy posture preserved).
- **Write discipline (mirrors gate.ts:389-404):** the decision-row write is **awaited before** the
  transport fires; failure ⇒ `EGRESS_AUDIT_UNAVAILABLE` deny (`R-13`); completion/status row closes
  the record; both rows insert-once.
- **`A01AuditRecord` untouched.** Forensic gain: for the first time an exfiltration attempt is
  **distinguishable from normal operation** in the audit trail (closes the assessed B-5 gap).

### 4.7 OD-7 — Egress `SecretPurpose` and credential lifecycle

**DESIGN DISPOSITION: option (a) — extend the closed set with `'egress-provider'` (a deliberate,
separately reviewed P2 contract addition of exactly the kind `:60-63` contemplates: *"a new consumer
must be added deliberately"*), and re-home the provider credential inside the governed seam.**

- Adapters no longer read `process.env` at construction (`openai.ts:41`, `embeddings.ts:91`,
  `bootstrap.ts:574-575,:591-592` become design-delta targets — **no code changed here**).
  Bootstrap instead obtains from the **Secret Broker** a **credential handle**
  (`credentialReference`: id/audience/scopes, never material — envelope-binding precedent).
- **Resolution at enforcement:** the gate opens the sealed material *inside the enforcement path*
  (decision validates scope; enforcement re-acquires — `types.ts:364-367` pattern), attaches it to
  the outbound request, and discards it per call. Material never enters config, logs, audit, or
  diagnostics.
- **Lifecycle (F-13 closed by design):** rotation = `SecretOperation` `rotate` (`secret-material.ts:72`)
  + new handle version, old version retired on a schedule; revocation ⇒ immediate
  `EGRESS_CREDENTIAL_REVOKED` deny at the gate; provider-side re-issuance runbook entered in §10
  acceptance. **Option (b) (leave the key ungoverned, accept TA-1) is rejected** — it would leave
  R-14 unsatisfied and F-13 open by design.

---

## 5. CROSS-CUTTING TRANSPORT AND GATE DESIGN

### 5.1 Redirect policy (R-05, R-06; T-02, T-15, T-01)

**`redirect:'error'` on every egress fetch** — the DC-5 floor, applied to N-1/N-2 as N-3 already
does (`jwt.ts:235`). **Hop-following is not implemented in the governed plane**: traversal (T-01),
307/308 body forwarding (T-02), and the same-origin `Authorization` residual (T-15 — verified:
same-origin forwarding on all five statuses) are all denied *by construction* rather than by
hope. If a future provider flow legitimately needs a redirect, the design's only admissible path
is **explicit re-authorization of the exact redirect target as a new decision** (new envelope, new
audit row, `hopCount+1`) — recorded as a deferred capability (U-8), not built.

### 5.2 Scheme allowlist (R-04)

`https` only. `http` exists **only** behind a second explicit dev-posture flag (`http-dev` entry
kind, §4.1) that is **refused in production posture** — mirroring the test-authority and
static-token two-key precedents (`.env.example:54-63`; `security-posture.ts`). `file://`,
`gopher://`, `ftp://` etc. are non-negotiables: refused at the canonicalizer before any resolution
(T-08 remains refuted; the refusal is structural, not transport luck).

### 5.3 Address-class and DNS controls (R-07, R-08; T-07, T-09)

- **Canonicalize → resolve once → validate class → connect to the resolved IP** with TLS `servername`
  / `Host` pinned to the canonical host (defeats T-09 rebinding: no second resolution inside the
  connection's lifetime).
- **Refused classes (design default; operators may only narrow, never widen):** loopback
  (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local
  (`169.254.0.0/16` — **includes the cloud metadata address**, T-07/TA-4 — `fe80::/10`),
  CGNAT (`100.64.0.0/10`), unspecified (`0.0.0.0/8`, `::`), multicast/reserved class defaults.
  Refusal ⇒ `EGRESS_PRIVATE_ADDRESS` deny, audited. (Verified motivation: link-local reachability
  was *observed* — PR #39 §20.3 and IV record O-1.)
- A destination that resolves to a refused class is denied **regardless of pattern match** — the
  allowlist answers *"may this name be contacted"*, the class check answers *"may anything at this
  address be contacted"*; both must pass.

### 5.4 Deadlines (R-09)

Every call carries a mandatory deadline: policy-declared value, clamped to a hard maximum. The
transport creates an **internal `AbortController`** fired at the deadline, logically ANDed with
any caller-supplied signal (`openai.ts:79` precedent) — a caller can shorten but never extend.
Timeout ⇒ `EGRESS_DEADLINE_EXCEEDED` with `deadlineOutcome`, audited. N-2 currently has **no**
signal at all (`embeddings.ts:109` fetch options); the gate imposes one by construction.

### 5.5 Rate/volume ceilings (R-15)

Per-destination sliding-window counters (requests and bytes), reusing the run-budget storage
pattern (`gate.ts:456` precedent), durable where the gate is durable. Excess ⇒
`EGRESS_RATE_EXCEEDED`. Ceilings are part of the policy entry — a destination without a declared
ceiling is a registration error (fail-closed).

### 5.6 Consumption and replay (R-10 with OD-5)

See §4.5(ii): egress-bound envelopes consume exactly once at all three verified sites.

### 5.7 Denial vocabulary (R-12)

Closed set added to the plane (mirroring the 80-member `A01DenialReason` discipline, 0 egress
members verified): `EGRESS_DESTINATION_NOT_ALLOWED`, `EGRESS_SCHEME_DENIED`,
`EGRESS_NORMALIZATION_REJECTED`, `EGRESS_PRIVATE_ADDRESS`, `EGRESS_DNS_UNPINNED`,
`EGRESS_REDIRECT_REFUSED`, `EGRESS_IDENTITY_MISSING`, `EGRESS_CREDENTIAL_REVOKED`,
`EGRESS_CREDENTIAL_UNAVAILABLE`, `EGRESS_POLICY_STORE_UNAVAILABLE`, `EGRESS_AUDIT_UNAVAILABLE`,
`EGRESS_RATE_EXCEEDED`, `EGRESS_DEADLINE_EXCEEDED`. Any unlisted reason ⇒ implementation defect,
build failure (closed-set discipline).

### 5.8 Static ban on ungoverned `fetch` (R-16, DC-7)

Lint gate on the `openNamespace` precedent (`eslint.config.mjs:58-70`): `no-restricted-syntax` /
`no-restricted-properties` forbidding `fetch`, `globalThis.fetch`, and URL-opening primitives in
`packages/*/src`, with an **enumerated exemption list** containing only `EgressTransport`, `jwt.ts`
(N-3, until a future migration — own disposition), and test trees. Violations fail CI.

### 5.9 Degradation mode (G-5) — designed, election deferred to owner (U-2)

| Mode | Semantics | Posture |
|---|---|---|
| **STRICT (default)** | Policy store, audit store, identity context, or credential broker unavailable ⇒ **total egress denial**. Verified §22 consequence owned: this can convert an infrastructure outage into a total agent outage | **Fail-closed; DC-2-pure** |
| **CACHED-POLICY (optional, designed)** | Gate may serve from the last durably-stored ACTIVE snapshot for a bounded TTL; every degraded decision carries `degraded: true` in its audit row; TTL expiry ⇒ STRICT | **Availability-vs-assurance trade-off; requires explicit owner election with TTL bound — not chosen silently** |

### 5.10 Rollback runbook (G-5; per §22 verified non-neutrality)

| Rollback of… | Designed procedure | Standing warning (from evidence) |
|---|---|---|
| This design document | Delete/revert the doc | Trivially revertible |
| OD-4 matcher slice | Revert both packages *together* (R-17 suite guards equivalence) | **Restores T-04/T-05/T-06 in a PDP-consumed matcher** (`policy-engine.ts:304`) |
| OD-7 credential migration | Rotation *forward* to a re-issued credential; no return to env-read once cut over | Env-read path removal must be the *last* step of cutover (§9) |
| Egress plane (whole) | Re-point adapters at the ungoverned fetcher **only** under an emergency governance event with its own audit record | **Re-opens exactly the measured ungoverned state — there is no partial state (§22)** |
| OD-5 replay slice | Restore READ-parity comment semantics at all three sites together | Restores T-10 unlimited-repeat for the egress class |

---

## 6. REQUIREMENT COVERAGE MAP (R-01…R-17)

| Req | Design element | Acceptance test |
|---|---|---|
| R-01 deny-by-default | §4.1 empty registry ⇒ deny | E-01 |
| R-02 hostname-exact matching (both matchers) | §4.4 corrected semantics + canonicalizer | E-02, E-17 |
| R-03 normalization before comparison | §4.4 canonicalizer (reject traversal) | E-03 |
| R-04 scheme allowlist | §5.2 | E-04 |
| R-05 redirect policy | §5.1 `redirect:'error'` | E-05 |
| R-06 307/308 body control | §5.1 (no following ⇒ no forwarding) | E-05 |
| R-07 private/metadata address refusal | §5.3 class table | E-06 |
| R-08 DNS pinning | §5.3 resolve-once/pinned connect | E-07 |
| R-09 mandatory deadline | §5.4 | E-08 |
| R-10 identity-bound decision | §4.3 | E-09 |
| R-11 egress audit record | §4.6 | E-10 |
| R-12 closed egress denial vocabulary | §5.7 | E-11 |
| R-13 fail-closed on policy/audit store | §5.9 STRICT, §4.6 | E-12 |
| R-14 governed egress credential | §4.7 | E-13 |
| R-15 per-destination rate/volume | §5.5 | E-14 |
| R-16 static ban on ungoverned fetch | §5.8 | E-15 |
| R-17 matcher-equivalence test | §4.4 conformance corpus | E-17 |

*(R-02/R-03/R-17 cover both matcher sites; §4.4. B-1/B-2/B-4/B-5 blockers are addressed
respectively by §4.1/§4.3/§4.7/§4.6 without weakening any tested control.)*

## 7. ACCEPTANCE TEST PLAN (design; all on **Node 20** in CI, plus local Node-22 parity run)

| ID | Asserts (each fail-closed) |
|---|---|
| E-01 | No enrolled policy ⇒ every egress attempt denied `EGRESS_DESTINATION_NOT_ALLOWED`; zero network bytes |
| E-02 | `https://api.openai.com*` policy ⇒ `api.openai.com.evil.com` denied at **both** matcher sites (suffix confusion dead) |
| E-03 | `allowlist: */v1/*` vs `…/v1/../../admin` denied by canonicalizer **and** by matcher; normalization rejects, never silently repairs |
| E-04 | `file://`/`gopher://`/`ftp://`/bare `http` (no dev flag) denied pre-network |
| E-05 | 301/302/303/307/308 responses ⇒ `EGRESS_REDIRECT_REFUSED`; no body ever re-sent (transport-level proof with loopback listener, on both Node 20 and 22) |
| E-06 | Mocked resolver returning `127.0.0.1`, `10.x`, `169.254.169.254`, `192.168.x` ⇒ `EGRESS_PRIVATE_ADDRESS` despite pattern pass |
| E-07 | Resolver called more than once per connection attempt ⇒ `EGRESS_DNS_UNPINNED` |
| E-08 | Hanging server ⇒ abort at declared deadline; audit row shows `deadlineOutcome: EXCEEDED` |
| E-09 | Missing/mismatched `EgressContext` field ⇒ `EGRESS_IDENTITY_MISSING`; tool path **and** per-turn N-1 path both covered (DC-6) |
| E-10 | Audit rows complete per §4.6 closed set; injected unknown field ⇒ write fails; decision-row failure ⇒ no dispatch (audit-before-side-effect) |
| E-11 | Denial emitted outside the closed `EGRESS_*` set ⇒ build/test failure |
| E-12 | Policy store down ⇒ total deny (STRICT); audit store down ⇒ total deny; recovery restores exactly prior behavior |
| E-13 | After broker revocation ⇒ `EGRESS_CREDENTIAL_REVOKED` on next call; rotated handle works without process restart window beyond TTL |
| E-14 | N+1 requests/bytes over destination ceiling ⇒ `EGRESS_RATE_EXCEEDED`; window reset verified |
| E-15 | Lint fixture containing raw `fetch(` in a non-exempt `src` file ⇒ CI fails; exempt list files compile |
| E-16 | **DC-1 proof:** tool input/`LLMRequest` content attempting to influence destination has no effect; no adapter API accepts a destination string (type-level test + boundary test) |
| E-17 | R-17 corpus: identical verdicts from both matchers across all vectors (incl. every probe bypass class from PR #39 §20.1); textual-identity static check passes |
| E-18 | Non-regression: **all existing suites green** (CI Node 20 on the merge SHA; local Node 22 run recorded), T-16 grant-corpus re-evaluation report attached for the OD-4 slice |

## 8. SECURITY INVARIANTS (binding on any implementation)

**I-1** DC-1…DC-7 in full (§1.3). **I-2** No ambient identity — context is explicit, typed,
fail-closed (OD-3). **I-3** One transport; no second network primitive in product source (R-16).
**I-4** Audit decision-row awaited before dispatch; unknown fields fail the write (OD-6, DC-4).
**I-5** Egress envelopes consume exactly once at all three sites (OD-5). **I-6** Matcher semantics
identical at both sites, enforced by test not comment (R-17); bodies byte-identical until/unless
unified in `core-kernel` under separate review (U-4). **I-7** `isNarrowing`, `ALLOWED_AUDIT_FIELDS`,
and every tested P2 invariant remain byte-stable in any P3-B slice (DC-3/DC-4); their regression
suites must pass unmodified. **I-8** Credential material exists only sealed/at-rest in the broker;
never in config, env-plumbing post-cutover, logs, or audit (OD-7). **I-9** Every new failure mode
denies; every denial carries a closed-set reason code (DC-2, R-12). **I-10** No claim of production
readiness attaches to any slice until the exit gate and final independent verification complete.

## 9. IMPLEMENTATION SEQUENCING (design; each arrow = separate authorization boundary)

```
S0a  OD-4 matcher slice (BOTH packages + R-17 + T-16 corpus report)   ─┐  separate P2-class
S0b  OD-7 SecretPurpose extension ('egress-provider' contract)         ─┤  authorizations;
S0c  OD-5 F-3 slice (ceiling event + replay-policy change, 3 sites)    ─┘  NOT this document
        │
        ▼
S1   Egress plane core (policy store, gate, canonicalizer, transport, audit record)
        ▼
S2   Adapter wiring & cutover (N-1, N-2 contexts; broker handles; env-read removed LAST)
        ▼
S3   Static ban activation (R-16) + migration cleanup + docs
        ▼
GATE P3-B₀-EXIT (§12) → separate P3-B implementation authorization → IV per slice
```

**Dependency notes:** S1 may be *built* in parallel with S0 slices but cannot be *merged to effect*
before S0a (its decision layer consumes corrected matching) and S0b (its broker needs the purpose).
S2 before S0c is forbidden (replay/ceiling semantics must be live before governed traffic flows
under the corrected declaration ordering). Registration of the first production destination policy
is itself a gated governance event (§4.1), executed only after S2 acceptance.

## 10. INDEPENDENT-VERIFICATION REQUIREMENTS (forward, per slice)

1. **Separate-party verification** of every code slice (S0a–S3) before its merge: executed test
   evidence **on Node 20** (CI parity; the Node-22-only caveat of the current evidence base must
   not propagate), plus local Node-22 records for parity claims.
2. **Probe reproduction** of E-02/E-05/E-06 against the merged build (import product code — the
   fidelity limit of the current probes, re-implementation without import, is lifted once a build
   exists; the new verifier MUST run the product path).
3. **Register-diff review** at each slice: findings closed by a slice must close with evidence;
   coincidental drift must be flagged, not absorbed.
4. **R-17 conformance** runs on both Node versions at every merge touching either matcher.
5. Each slice's IV record is an **evidence input, not an authorization** — the same discipline as
   the PR #39 record at `86c00d1`.

## 11. UNRESOLVED QUESTIONS (recorded per the ambiguity rule — none silently resolved)

| ID | Question | Options recorded | Recommendation |
|---|---|---|---|
| U-1 | "Segment" was never defined in code/docs | (i) `/`+`.` excluded from `*` (design choice, §4.4); (ii) `/` only; (iii) per-entry delimiter declaration | (i); owner ratifies at exit gate |
| U-2 | Degradation mode on total outage | STRICT (fail-closed) vs CACHED-POLICY TTL mode (§5.9) | STRICT for first implementation; election is the owner's, with TTL bound |
| U-3 | F-3 ceiling-correction mechanism | (α) new capabilityId + retire (recommended); (β) one-time governed ceiling event | α (no invariant contact at all) |
| U-4 | Matcher duplication mechanics | Keep duplication + R-17 byte/test coupling (chosen) vs unify in `@jataqi/core-kernel` (dependency-clean, §2) | Keep; revisit unification only with separate review if the functions drift |
| U-5 | Rate-counter storage | Durable counters vs in-memory run budgets (`gate.ts:456` precedent) | Durable where gate durable; owner confirms dispersion semantics |
| U-6 | Response-side controls (size caps, content handling) | Not in R-01…R-17; byte counts recorded (R-11) but content scanning is a *new* control | Record for owner scope decision; **not smuggled into this design** |
| U-7 | `EgressContext` on adapter construction vs per-call | Per-call required parameter (chosen — matches envelope lifetime) vs constructor-pin | Per-call; constructor-pin silently freezes identity and is rejected |
| U-8 | Legitimate redirect needs (provider flows) | Refuse-by-default only (current design) vs deferred re-authorization-per-hop (§5.1) | Defer; raise only on demonstrated provider need with its own design |

## 12. DESIGN-PHASE REPORT (completion artifact mandated by the authorization)

**OD dispositions:** OD-1 → separate destination-policy model (`isNarrowing` untouched) ·
OD-2 → operator-enrolled registry; provider defaults as proposals only · OD-3 → explicit
`EgressContext` threading, fail-closed `EGRESS_IDENTITY_MISSING` (no ambient state) ·
OD-4 → both-sites matcher correction as separate prerequisite slice + R-17 conformance suite +
T-16 corpus re-evaluation · OD-5 → F-3 as separate slice (truthful `EXTERNAL_SIDE_EFFECT` via new
capabilityId; egress envelopes consume exactly once at all three sites) · OD-6 → separate
`EgressAuditRecord` with own closed field set + shape assertion (`A01AuditRecord` untouched) ·
OD-7 → `'egress-provider'` SecretPurpose + broker-held handles with rotate/revoke lifecycle.
**All DC-1…DC-7 preserved. All adverse findings preserved; none reclassified. Remediation performed: 0.
Code written: 0.**

**Unresolved questions:** U-1…U-8 (§11) — recorded with options and recommendations; **owner
ratification required at the exit gate.** **Security invariants:** I-1…I-10 (§8).
**Sequencing:** S0a/S0b/S0c (separately authorized P2-class slices) → S1 → S2 → S3 (§9).
**Rollback conditions:** §5.10 — notably: matcher rollback restores a PDP-consumed bypass; plane
rollback restores the measured ungoverned state; there is no partial state.
**Acceptance tests:** E-01…E-18 (§7), mandatory Node-20 execution plus Node-22 parity.

**EXACT GATE REQUIRED BEFORE ANY IMPLEMENTATION MAY BE AUTHORIZED — "P3-B₀-EXIT":**
1. Owner ratification of this record, **including explicit disposition of U-1…U-8**;
2. **Separate-party independent verification of this design record** against the verified evidence
   base (PR #39 @ `608a6ea` + IV record @ `86c00d1`) — this author must not verify its own design;
3. Explicit, individually-scoped authorizations for S0a, S0b, S0c (none granted here);
4. Only then, a **separate explicit P3-B implementation authorization**.

**This record grants nothing. P3-B implementation remains NOT AUTHORIZED. P3-B₀-to-P3-B promotion is
NOT granted. PR #39 remains OPEN and UNMERGED. Score 9.484375% remains FROZEN. PRODUCTION NOT READY.
No finding was remediated, weakened, reclassified, or closed by this design phase.**

*— End of P3-B₀ design record —*
