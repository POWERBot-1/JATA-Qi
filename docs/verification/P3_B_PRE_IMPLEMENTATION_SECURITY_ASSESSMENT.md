# P3-B — GOVERNED EGRESS CONTROL PLANE
# FRESH PRE-IMPLEMENTATION SECURITY ASSESSMENT (DECISION SUPPORT)

| Field | Value |
|---|---|
| Document class | **READ-ONLY SECURITY AUDIT + DECISION SUPPORT.** Documentation-only artifact. |
| Repository | `POWERBot-1/JATA-Qi` (verified: `origin` = `https://github.com/POWERBot-1/JATA-Qi.git`) |
| **Audited commit SHA** | **`6b61256c6115a02da2d3ad6ba42771831b550f81`** |
| Baseline verification | local `HEAD` == `origin/main` == audited SHA; working tree clean at audit start (§3) |
| Assessment date/time (UTC) | **2026-09-18T06:30:28Z** (measured via `date -u`) |
| **Revision** | **R2 — evidence correction**, 2026-09-18T07:14Z. Corrects defects **D-1…D-6** found during read-only verification of PR #39. See **§24 Correction Record** |
| **Correction authorization** | **DOCUMENTATION/EVIDENCE CORRECTION ONLY** (owner, 2026-09-18). **This revision remediates no security condition.** It does not authorize P3-B, P3-B₀, remediation, merge, or E4 |
| **Correction scope** | **One file** — this document. **Zero** production/test/config/CI/dependency/schema/infrastructure/ruleset changes (§24.3) |
| Assessment type | **FRESH RE-MEASUREMENT.** No prior assessment was available to copy; every finding below was independently re-derived from source at the audited SHA, from read-only GitHub metadata, or from a labelled behavioural probe (§20). |
| Evidence provenance | (a) source file:line at `6b61256`; (b) remote blob-SHA comparison against `08adbd9`; (c) read-only GitHub API (`gh pr view`, `gh run list`, `gh api`); (d) four isolated behavioural probes executed **outside** the repository (§20) |
| **Evidence class** | **PRIMARY (source-verified at the audited SHA) + CI-metadata class + measured-transport class** |
| **Independence** | **SAME-AGENT. NOT E4. NOT INDEPENDENT VERIFICATION.** This document does **not** constitute independent verification and must not be cited as such. |
| Author | Arena agent session `arena/01a0b2f3-jata-qi` |
| Governing cap | **`P2 E4: NOT ACHIEVED` — permanently capped** (`P2_ASSURANCE_CAP_DISPOSITION.md`) |
| Score | **9.484375%** as recorded in `docs/rubric/JATA-P0-95-v1.1.md:185,226` and `docs/rubric/P0R-95_SCORECARD.md:60,342,358`. **This audit changes no figure.** The score was not independently recalculated. |
| Production readiness | **PRODUCTION NOT READY** (`P0_V11_ASSESSMENT_AT_08ADBD9.md:160,162`) |
| **P3-B implementation** | **NOT AUTHORIZED** |
| **P3-B₀ design phase** | **NOT AUTHORIZED** |
| Authorization for THIS artifact | Documentation-only canonicalization, explicitly granted by the owner 2026-09-18. **This document authorizes nothing beyond that canonicalization.** |
| Prior external artifact | A previous external assessment existed at `/home/user/assessments/P3_B_PRE_IMPLEMENTATION_SECURITY_ASSESSMENT.md` (~2,777 lines / ~260,563 bytes). **It no longer exists and is NOT available as evidence.** It is not reproduced, cited as authority, or relied upon here (§21.3). |

> **Reading rule.** Every material claim below carries either a `file:line` citation at the audited
> SHA, a read-only GitHub observation, or a labelled probe result with its methodology and
> preconditions. Where exact evidence could not be established, that is stated explicitly rather
> than approximated. **Precision is never fabricated.**

---

## 1. EXECUTIVE SUMMARY AND DETERMINATION

### 1.1 Determination

**P3-B (Governed Egress Control Plane) is NOT READY TO BE AUTHORIZED AS PREVIOUSLY SCOPED.**

The objective is correct and the risk it addresses is real and unremediated. But the slice as
described in `P3_A_SECURITY_THREAT_MODEL_AND_BASELINE.md` §7 rests on three mechanisms that fresh
measurement shows to be **unavailable or prohibited** at the audited SHA. One of them is a hard
structural prohibition enforced by an existing, deliberately tested security invariant.

### 1.2 The three blockers (all independently re-verified this audit)

| ID | Blocker | Fresh evidence | Class |
|---|---|---|---|
| **B-1** | The manifest **monotonic-narrowing invariant forbids the two changes P3-B needs**: adding a destination to `allowedTargets` is rejected as *"widens target scope"*, and raising an understated impact ceiling is rejected as *"raises the impact ceiling"* | `capability-manifests.ts:130` (`isNarrowing`), `:140`, `:162`, `:164-165`; enforced at registration `:213` | **VERIFIED DEFECT-BLOCKER** (structural) |
| **B-2** | The egress call sites carry **no identity whatsoever**, and there is **no ambient-context mechanism** to supply it | `llm.ts:18-24` `LLMRequest` = **5 fields**: `{messages, tools?, temperature?, maxTokens?, signal?}` — **0** hits for `principal\|tenant\|agentId\|runId\|correlationId\|actor\|subject\|sessionId` in the whole file; `AsyncLocalStorage`/`async_hooks` = **0** hits in `packages/*/src` **and 0 across all of `packages/`**. Identity **does** exist upstream (`agent.ts:132-140`) — this is a **seam/propagation** gap | **VERIFIED DEFECT-BLOCKER** (architectural) |
| **B-3** | The destination matcher P3-B would inherit implements an **unbounded `.*` glob**, not the *"simple segment glob"* its own documentation promises — and it exists in **TWO textually identical implementations across two packages** | `capability-manifests.ts:267-284` (`.join('.*')` at `:281`), doc comments `:262-265` and `types.ts:404`; consumed at `policy-engine.ts:304`. **[D-1]** Second site: `authentication/src/delegation-types.ts:385-402` `delegationTargetMatches` (`.join('.*')` at `:399`) — **byte-identical regex body**, documented at `:381` as mirroring A-01 *"exactly"*, consumed at `:439` for **delegation grant assessment**, exported at `index.ts:253`. **Bypass proven by probe** (§20.1) | **VERIFIED DEFECT** (HIGH for P3-B; latent today; **scope corrected to two sites**) |

### 1.3 Two further closed-set contracts block P3-B's own evidence requirements

| ID | Blocker | Fresh evidence |
|---|---|---|
| **B-4** | The P2 secret seam's **`SecretPurpose` is a closed three-value vocabulary with no egress/provider purpose**, so "credential delivered from the P2 seam" is not implementable without extending a tested P2 closed set | `secret-material.ts:64-70` = `'totp' \| 'break-glass-seal' \| 'session-assertion'`; unrecognized purpose ⇒ `SECRET_INVALID_ARGUMENT` at `:298-300` |
| **B-5** | The **audit field set is closed** and contains **no field capable of holding egress evidence** | `audit.ts:29` (`ALLOWED_AUDIT_FIELDS`), `:87` (`assertAllowedAuditShape`); `A01AuditRecord` has **0** occurrences of `destination`, `resolvedIp`, `scheme`, `port`, `method`, `redirect`, `hopCount`, `byteCount`, `deadline`, `status`. Only `targetResource?` exists (`types.ts:543`) |

### 1.4 The measured risk P3-B exists to close (confirmed live and unremediated)

**Zero egress governance exists.** Word-boundary search for `egress` across `packages/*/src` returns
**0 hits**. There is no destination model, no allowlist, no egress decision, no egress reason code
(`A01DenialReason` contains **80** codes and **0** begin with `EGRESS`), and no egress audit field.

Meanwhile **two credentialed outbound HTTP seams operate outside every authorization decision**, and
both are **byte-identical to the prior baseline `08adbd9`** — nothing has been remediated:

| Seam | Call site | Credential | Deadline | Redirect policy | Decision | Audit |
|---|---|---|---|---|---|---|
| **N-1** LLM | `openai.ts:72` | Bearer from `:41` (`process.env.OPENAI_API_KEY`) | caller-supplied `signal` only (`:79`) | **none** | **none** | **none** |
| **N-2** Embedding | `embeddings.ts:109` | Bearer from `:91` (`process.env.OPENAI_API_KEY`) | **none — no `signal` parameter exists** | **none** | **none** | **none** |
| **N-3** JWKS | `jwt.ts:235` | n/a (operator-pinned URL) | n/a (fetched once) | **`redirect:'error'`** ✔ | n/a | n/a |

**N-3 is the exemplar.** It enforces an `http(s)` scheme (`jwt.ts:229`), refuses redirects, fetches
exactly once, and injects a fetcher for hermetic tests. **N-1 and N-2 have none of these properties.**

### 1.5 Highest-value new measurement: a reachable model-controlled exfiltration path

Fresh tracing confirms an end-to-end path by which **model-controlled data leaves the boundary under
an authorization record that misdescribes it**:

```
builtins.ts:221   vector.search declares { ...KNOWLEDGE_READ_CAPABILITY, operation:'search' }
builtins.ts:66      impact: 'READ'
builtins.ts:67      dataClassification: 'INTERNAL'
builtins.ts:68      targetSystem: 'tenant-knowledge'
builtins.ts:227   return v.embedAndSearch(idx, String(input.query), { tenantId, ... })   ← input.query is MODEL-SUPPLIED
vector-module.ts:114   const q = await this.model.embed(text)
embeddings.ts:109      credentialed POST of JSON.stringify({ model, input: texts })       ← NO GATE, NO ALLOWLIST, NO AUDIT, NO DEADLINE
```

**Why this is materially worse than a plain "missing allowlist":**

1. **The authorization record understates the behaviour.** It records an internal `READ` against
   `tenant-knowledge`; the actual behaviour is external transmission of `INTERNAL` data.
2. **`READ` decisions are unboundedly repeatable — at three independent sites.** `gate.ts:407-408` —
   *"Replay protection: non-READ decisions are consumed exactly once"* — `if (verified.impact !==
   'READ')`; also `gate.ts:12` and `:453`; and, in the **durable** store, `consumption-stores.ts:75` —
   `if (input.impact === 'READ') return { consumed: false };` (**[D-2]**, documented as intentional at
   `:60-61`). A `READ` envelope is therefore **never consumed**, so one authorization permits
   **unlimited repeat transmission**.
3. **No destination is recorded anywhere**, so the transmission is forensically invisible.
4. **Correcting it is blocked by B-1**: raising `impact` from `READ` to `EXTERNAL_SIDE_EFFECT` is
   rejected by `isNarrowing` at `capability-manifests.ts:164-165`.

Recorded as **F-3, VERIFIED DEFECT** (§7.4).

### 1.6 What is genuinely strong (recorded so the picture is not falsely negative)

| Control | Fresh evidence | Class |
|---|---|---|
| Model output cannot author authority | `agent.ts` `renderToolEnvelope` builds the request only from the verified principal + tool declaration; fail-closed defaults `impact:'EXTERNAL_SIDE_EFFECT'`, `dataClassification:'INTERNAL'`; no gate ⇒ throw | **VERIFIED / IMPLEMENTED** |
| Post-decision target substitution denied | `tools.ts:216-241` — the same derived `targetResource` is passed to both `assertEnvelope` and `executeAuthorized` | **VERIFIED / IMPLEMENTED** |
| Tenant refusal at the module boundary (not merely the API boundary) | `vector-module.ts:139-155` `scopeOptions` throws on blank/missing tenant and filters `metadata.tenantId !== tenantId` | **VERIFIED / IMPLEMENTED** |
| RLS + `FORCE ROW LEVEL SECURITY` | `tenant-isolation.ts:55` (`app.tenant_id`), `:108` (ENABLE), `:138-140` (FORCE, fail-closed) | **VERIFIED / IMPLEMENTED** (runtime proof requires PostgreSQL) |
| Policy-manipulation resistance | `capability-manifests.ts:30-127` strict registration validation; `:130-190` monotonic narrowing; `:196-215` immutable versions | **VERIFIED / IMPLEMENTED** — and this is the *cause* of B-1 |
| Fail-closed posture resolution | `security-posture.ts:74-82` — unrecognized posture ⇒ throw | **VERIFIED / IMPLEMENTED** |
| Boot canary must render DENY | `security-posture.ts:186-199`; INV-01…INV-12, INV-14…INV-16 present | **VERIFIED / IMPLEMENTED** |
| Audit failure denies the decision | `AUDIT_UNAVAILABLE`; durable-write failure latches the gate closed (A-01 §6) | **DOCUMENTED + IMPLEMENTED** (not executed here) |
| JWKS governed fetch | `jwt.ts:229` scheme check, `:235` `redirect:'error'` | **VERIFIED / IMPLEMENTED** |
| OIDC production authenticator **actually wired** | `auth-config.ts:50` (`'oidc'` in `CliAuthMode`); `bootstrap.ts:70,84,336,352` (`OidcAuthenticator.create`) | **VERIFIED / IMPLEMENTED** |
| Static-ban precedent with test exemptions | `eslint.config.mjs:63` (`no-restricted-syntax`), `:135`/`:145` (test exemptions), `:140` (off) | **VERIFIED / IMPLEMENTED** (for storage calls only) |

### 1.7 Recommendation to the owner (decision support only — authorizes nothing)

1. **Do not authorize P3-B implementation as previously scoped.** Resolve B-1, B-2, B-3 first.
2. **Authorize a bounded P3-B₀ design-decision record** (documentation only) resolving the owner
   decisions in §19 — in particular the destination-policy data model, the identity-propagation
   architecture, and whether B-3 is remediated before or inside P3-B.
3. **Treat F-3 as a separately authorized remediation candidate**, not P3-B scope creep — it cannot
   be fixed inside P3-B without colliding with B-1.
4. **Accept explicitly** that a fail-closed egress plane converts a policy-store outage into a total
   agent outage, and that **rolling P3-B back re-opens the ungoverned egress paths** (§22).
5. **Do not expect infrastructure-level assurance.** No production environment exists, no container
   runtime is available, and this audit measured that **no network-layer egress control is active**
   — `http://169.254.169.254/latest/meta-data/` reached the network layer and returned an HTTP
   response (§20.3). Application-level allowlisting is the only barrier, which **raises** the design
   bar.

---

## 2. SCOPE, NON-SCOPE, AND METHOD

### 2.1 Authorized scope (per the owner's instruction, 2026-09-18)

Read-only security audit at `6b61256`; bounded behavioural probes; creation of **exactly one**
documentation artifact at `docs/verification/P3_B_PRE_IMPLEMENTATION_SECURITY_ASSESSMENT.md`;
commit, push, and open a PR containing only that artifact; then **stop**.

### 2.2 Explicitly NOT performed (and not authorized)

- **No P3-B implementation. No P3-B₀ design implementation. No remediation of any finding** —
  including B-1, B-2, B-3, F-3, F-4, F-8, F-9 and every other finding recorded here. All remain
  **OPEN**.
- **No production-code change. No test-code change. No configuration change. No CI/workflow change.
  No dependency change. No schema/database change. No infrastructure change. No ruleset change.
  No deployment.**
- **No score change** (9.484375% frozen). **No change to `P2 E4` status.** **No production-readiness
  claim.**
- **No merge, no post-merge verification, no merge authorization requested or assumed.**
- **No unrelated documentation change.** No existing file in `docs/` was modified.
- **No scratch probe is committed.** All probes were created in `/tmp/p3b-audit-probes/`, outside the
  tracked repository (§20).
- **No dependency installation and no build** — `node_modules` and `dist` remain absent, so the
  repository was not mutated even in gitignored paths. **Consequence: no test suite was executed**
  (§21.1).

### 2.3 Method

1. **Baseline verification** against the live remote before any read (§3).
2. **Source measurement** by `grep`/`sed` at the audited SHA, recording exact line numbers.
3. **Remote blob-SHA comparison** against the prior baseline `08adbd9` via read-only GitHub API, to
   establish whether the measured files changed between baselines — used instead of `git fetch`,
   which would have mutated the local object store.
4. **Read-only GitHub metadata**: PR scope, CI conclusions, ruleset read-back.
5. **Four bounded behavioural probes** in `/tmp/p3b-audit-probes/`, each read-only with respect to
   the product, creating no persistent secret and no network persistence (§20).
6. **Classification** of every material finding per §4.

### 2.4 Honesty rules adopted

1. A control is **IMPLEMENTED** only when source at the audited SHA performs it and the citation is given.
2. **Documentation is never treated as implementation.** Where only specification text exists, the
   finding is classified **DOCUMENTED ONLY**.
3. **Absence of a grep hit is evidence of absence only for the patterns searched.** Patterns are
   enumerated where used (§5.4, §14.1).
4. **Severity is not inflated.** Preconditions are stated for every threat; negative results that
   *reduce* risk are recorded with the same rigour as positive ones (§20.3 records schemes that are
   **not** reachable; §7.5 records that credentials are **not** forwarded cross-origin).
5. **No claim from the unavailable prior assessment is reproduced as fact.** Where a prior finding is
   re-tested, the re-test result governs (§7).

---

## 3. BASELINE VERIFICATION (performed before any read or write)

| Check | Method | Observed | Result |
|---|---|---|---|
| Repository identity | `git remote -v` | `origin https://github.com/POWERBot-1/JATA-Qi.git` (fetch and push) | ✅ matches |
| Live remote `main` | `git ls-remote origin refs/heads/main` | `6b61256c6115a02da2d3ad6ba42771831b550f81` | ✅ matches expected baseline |
| Local `HEAD` | `git rev-parse HEAD` | `6b61256c6115a02da2d3ad6ba42771831b550f81` | ✅ == `origin/main` |
| **Baseline drift** | comparison | **none** | ✅ no drift |
| Branch | `git rev-parse --abbrev-ref HEAD` | `arena/01a0b2f3-jata-qi` | ✅ authorized session branch |
| Working tree | `git status --porcelain \| wc -l` | **0 lines** | ✅ clean |
| Staged/unstaged changes | `git status --short` | empty | ✅ none |
| Stash | `git stash list` | **0 entries** | ✅ nothing hidden |
| Untracked files | `git ls-files --others --exclude-standard \| wc -l` | **0** | ✅ none |
| Reflog | `git reflog` | **2 entries**: `clone`, then `checkout: moving from main to arena/01a0b2f3-jata-qi` | ✅ no unexpected history manipulation |
| Target path pre-existence | `ls docs/verification/P3_B_PRE_IMPLEMENTATION_SECURITY_ASSESSMENT.md` | **does not exist** | ✅ creation, not overwrite |
| Existing P3 artifacts | `ls docs/verification \| grep -i P3` | only `P3_A_SECURITY_THREAT_MODEL_AND_BASELINE.md` | ✅ no collision |
| Audit timestamp | `date -u` | `2026-09-18T06:30:28Z` | recorded |
| Toolchain | `ls node_modules`, `packages/*/dist` | **absent** | ⚠️ no suite execution possible (§21.1) |
| Node runtime | `node --version` | **v22.22.3** | ⚠️ CI is Node **20** (`ci.yml:40`) — non-parity (§21.2) |

**No stop condition was triggered at baseline.** No force-reset or alteration of unrelated repository
state was performed at any point.

---

## 4. MEASUREMENT DISCIPLINE — CLASSIFICATION VOCABULARY

Every material finding carries exactly one class. The vocabulary is closed.

| Class | Meaning | Evidentiary bar applied here |
|---|---|---|
| **VERIFIED** | Independently established from source or read-only remote metadata at the audited SHA | `file:line` or blob SHA or GitHub API response |
| **DEFECT** | Verified *absence* or *incorrect behaviour* of a control that the stated requirement demands | Verification plus the requirement it violates |
| **PARTIAL** | Control exists but does not satisfy the requirement | Verified residue enumerated |
| **DOCUMENTED ONLY** | Specification or comment text exists; **no implementation performs it** | Cited text plus absence of implementing code |
| **ASSUMED** | Relied upon but not established by this audit | Assumption stated with its consequence |
| **UNVERIFIED** | Could not be established in this environment | Obstacle stated |
| **BLOCKED** | Cannot be established/implemented because of another verified condition | Blocking condition cited |
| **UNKNOWN** | Not determined; no claim made either way | — |

**Additional discipline adopted:**

- Each finding states **expected**, **observed**, **methodology**, **consequence**, and **confidence**.
- **Confidence** is expressed as HIGH/MEDIUM/LOW with the reason, never as a percentage.
- Where a probe was used, the **probe id**, **runtime**, and **preconditions** are stated (§20).
- Where a probe ran on a **different runtime than CI** (Node 22 vs Node 20), the finding is labelled
  with that caveat and never presented as CI-observed behaviour.

---

## 5. MEASURED ARCHITECTURE — WHERE AUTHORITY ENDS AND EGRESS BEGINS

### 5.1 The authorization layer (measured, strong)

| Component | Location | Measured role |
|---|---|---|
| Policy Decision Point | `policy-engine.ts` | evaluates capability against manifest; budget/rate checks; target match consumed at `:304` |
| Policy Enforcement Point | `gate.ts` | `executeAuthorized`; replay consumption at `:407-408`; audit-write gating |
| Capability manifests | `capability-manifests.ts` | registration validation `:30-127`; narrowing `:130-190`; immutability `:196-215`; `targetMatches` `:267-284` |
| Manifest/audit types | `types.ts` | `A01DenialReason` (**80** codes), `A01AuditRecord` (`targetResource?` at `:543`) |
| Agent envelope | `agent.ts` | builds authorization request from verified principal + tool declaration only |
| Tool authorization | `tools.ts` | `assertEnvelope` + `executeAuthorized`; `validateInput` |
| Built-in tools | `builtins.ts` | capability declarations, incl. `KNOWLEDGE_READ_CAPABILITY` `:63-68` |

**Measured property that matters for P3-B:** this layer decides **whether a capability may run** and
records **that** it ran. It has **no concept of a network destination**. Word-boundary `egress`
returns **0 hits** across `packages/*/src`; `A01DenialReason` contains **0** `EGRESS_*` codes;
`A01AuditRecord` contains **0** destination/scheme/port/IP/byte/deadline/redirect fields.

### 5.2 The egress seams (measured)

**N-1 — LLM completion.** `packages/agent-runtime/src/llms/openai.ts`

| Line | Measured content |
|---|---|
| `:39` | endpoint taken from config (no scheme validation, no allowlist) |
| `:41` | `this.apiKey = cfg.apiKey ?? process.env.OPENAI_API_KEY ?? ''` |
| `:42` | injectable `fetcher` (tests) |
| `:48` | fails closed if `apiKey` empty — *"apiKey not configured"* |
| `:72` | **the outbound call** |
| `:76` | `Authorization` bearer header set |
| `:79` | caller-supplied `signal` only |
| — | **no `redirect` option; no deadline; no destination decision; no audit** |

**N-2 — Embedding.** `packages/vector-search/src/embeddings.ts`

| Line | Measured content |
|---|---|
| `:90` | endpoint from config |
| `:91` | `this.apiKey = cfg.apiKey ?? process.env.OPENAI_API_KEY ?? ''` |
| `:93` | injectable `fetcher` |
| `:104` | fails closed if `apiKey` empty |
| `:109` | **the outbound call** |
| `:113` | `Authorization` bearer header set |
| — | **no `signal` at all; no `redirect`; no deadline; no decision; no audit** |

**N-3 — JWKS.** `packages/authentication/src/jwt.ts`

| Line | Measured content |
|---|---|
| `:229` | scheme restricted to `http(s)` |
| `:235` | `fetch(u, { redirect: 'error' })` — **refuses redirects** |
| `:16`, `:81`, `:203` | fetch **exactly once** at construction; failure rejects resolution |
| `:89` | injectable fetcher for hermetic tests |

**Asymmetry is the finding.** The one seam governed by the authentication package (N-3) is also the
only seam with a scheme check and a redirect refusal. The two seams carrying **tenant data and a
provider credential** have neither.

**Corroborating negative result:** `redirect` appears exactly **5 times** in `packages/*/src`, and all
five are in `jwt.ts` (`:16,:81,:89,:203,:235`). **Zero** occurrences exist on the N-1/N-2 paths.
`new URL(` appears exactly **once** in `packages/*/src` — `cli/src/storage-driver.ts:84`, parsing a
**PostgreSQL connection string**, not an egress destination. `127.0.0.1` appears exactly **once** —
`storage-postgres/src/config.ts:74`, the PG host default. **No egress URL is ever parsed or
validated anywhere in the product.**

### 5.3 Where the provider endpoint comes from

| Line | Measured content |
|---|---|
| `config.ts:14`, `:99` | `OPENAI_API_KEY` read from `process.env` |
| `bootstrap.ts:574-575` | `new OpenAILLM({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_CHAT_MODEL })` |
| `bootstrap.ts:591-592` | embedding model built from `env.OPENAI_API_KEY` + `env.OPENAI_EMBEDDING_MODEL` |
| — | **`endpoint` occurrences in `bootstrap.ts` and `config.ts`: 0** |

**Consequence:** the operator passes a **credential** and a **model name** but never a destination.
The destination is therefore whatever the adapter defaults to. This is *operationally* safer than a
model-controllable destination, and it is recorded as such — but it also means **P3-B's
destination-binding requirement has no operator-supplied destination to bind to**, which must be
resolved in design (§19, OD-2).

### 5.4 Absence-of-control sweeps (patterns enumerated so negatives are auditable)

`packages/*/src`, `--include='*.ts'`, exact-substring search:

| Pattern | Hits | Pattern | Hits |
|---|---|---|---|
| `egress` (word-boundary) | **0** | `isPrivate` | **0** |
| `EGRESS` (in `types.ts`) | **0** | `link-local` | **0** |
| `AsyncLocalStorage` | **0** | `169.254` | **0** |
| `async_hooks` | **0** | `loopback` | **0** |
| `docker` | **0** | `rfc1918` | **0** |
| `containerd` | **0** | `192.168` | **0** |
| `gVisor` | **0** | `10.0.0.0` | **0** |
| `firecracker` | **0** | `redirect` | **5** (all `jwt.ts`) |
| `seccomp` | **0** | `new URL(` | **1** (`storage-driver.ts:84`, PG DSN) |
| `cgroup` | **0** | `127.0.0.1` | **1** (`config.ts:74`, PG host) |
| `child_process` | **0** | `worker_threads` | **0** |
| `node:vm` | **0** | `eval(` | **0** |
| `new Function` | **0** | `chroot` | **0** |
| `unshare` | **0** | `namespace(` | **3** — all the **storage** namespace API (`knowledge-module.ts:41`, `storage-module.ts:69,:102`), **not** OS namespaces |

Including tests/scripts (`packages/`, `scripts/`): `child_process` **19**, `spawn(` **9**,
`node:net` **5** — **all test/script harness code, 0 in `src`**.

**Interpretation, deliberately conservative:** these sweeps prove **no OS-level isolation, no
network-layer egress control, and no ambient-context mechanism exist in product source**. They do
**not** prove none exists in a future deployment — but they do establish that **any such control would
be entirely outside this codebase**, i.e. an infrastructure assumption this audit cannot verify.

---

## 6. TRUST BOUNDARIES AND PRIVILEGE TRANSITIONS

### 6.1 Measured boundaries

| # | Boundary | Crossing mechanism | Identity present at crossing? | Decision at crossing? |
|---|---|---|---|---|
| **TB-1** | Unauthenticated network → CLI/ingress | authenticator registered per `CliAuthMode` (`auth-config.ts:50`); `none` ⇒ every authenticated request fails closed (`.env.example:54-56`) | ✅ principal + tenant | ✅ |
| **TB-2** | Ingress → agent runtime | verified principal propagated into the envelope by `agent.ts` `renderToolEnvelope` | ✅ | ✅ |
| **TB-3** | Agent runtime → capability execution | `gate.ts` `executeAuthorized`; PDP decision; replay consumption `:407-408` | ✅ | ✅ |
| **TB-4** | Capability execution → storage/vector | `vector-module.ts:139-155` tenant scoping; PostgreSQL RLS (`tenant-isolation.ts:108,:138`) | ✅ tenantId | ✅ |
| **TB-5** | **Capability execution → external network (N-1)** | `openai.ts:72` | **❌ NONE** | **❌ NONE** |
| **TB-6** | **Capability execution → external network (N-2)** | `embeddings.ts:109` | **❌ NONE** | **❌ NONE** |
| TB-7 | Process → JWKS endpoint (N-3) | `jwt.ts:235` | n/a (operator-pinned) | ⚠️ partial (scheme + no-redirect; no allowlist) |
| TB-8 | Model output → tool arguments | `tools.ts` `validateInput` | ✅ principal | ⚠️ **presence-only** (§11.2) |
| TB-9 | Tool output → model context | `agent.ts:261-265` pushes result verbatim as `role:'tool'` | n/a | **❌ none** (§13) |

### 6.2 The structural finding

**TB-1 through TB-4 are governed. TB-5 and TB-6 are not governed at all, and they are the only two
boundaries where data leaves the trust domain carrying a credential.**

This is the precise asymmetry P3-B exists to correct — and it is **live at the audited SHA**, not a
theoretical concern: both seams are **byte-identical to the prior baseline `08adbd9`** (§7.7).

### 6.3 Privilege transitions measured

| Transition | Mechanism | Measured status |
|---|---|---|
| Anonymous → principal | authenticator (`StaticTokenAuthenticator`, `OidcAuthenticator`, `DeterministicTestAuthenticator`) | **IMPLEMENTED** (`bootstrap.ts:336,:352`) |
| Principal → authorized capability | PDP + gate + manifest | **IMPLEMENTED** |
| Capability → **external transmission** | **nothing** | **NOT IMPLEMENTED** — the missing transition P3-B must create |
| Capability → privilege elevation via delegation | `isNarrowing` forbids widening (`capability-manifests.ts:140,:162,:164-165`) | **IMPLEMENTED** — and blocks P3-B (B-1) |
| Credential → outbound header | `openai.ts:76`, `embeddings.ts:113`, sourced from `process.env` | **IMPLEMENTED, ungoverned** |

### 6.4 Trust assumptions P3-B would inherit (each must be accepted or replaced by the owner)

| ID | Assumption | Class | Consequence if false |
|---|---|---|---|
| TA-1 | The process environment is trusted to supply `OPENAI_API_KEY` | **ASSUMED** | Env compromise ⇒ unrestricted credentialed egress with no destination record |
| TA-2 | The adapter's default endpoint is a legitimate provider host | **ASSUMED** — **0** `endpoint` occurrences in `bootstrap.ts`/`config.ts` | A malicious/typo'd adapter default is undetectable |
| TA-3 | DNS resolution is trustworthy | **UNVERIFIED** — no resolver control in source | Rebinding defeats any IP-based check (§10.6) |
| TA-4 | Network-layer egress filtering exists in deployment | **VERIFIED ABSENT in this environment** (§20.3) | Application allowlist is the **only** barrier |
| TA-5 | Node's default `fetch` redirect behaviour is acceptable | **VERIFIED NOT ACCEPTABLE** (§7.5) | Arbitrary-destination traversal |
| TA-6 | Model output is not trusted to author authority | **VERIFIED** (`agent.ts` envelope construction) | — (this assumption holds) |

---

## 7. RE-VERIFICATION OF THE PREVIOUSLY REPORTED FINDINGS

**Mandated by the assessment instruction: each previously reported finding must be independently
substantiated or refuted — not assumed to remain true.** All seven were re-measured from scratch at
`6b61256`. **All seven are SUBSTANTIATED.** Two are refined by new measurement (F-4 severity is
*narrower* than a naive "credential theft" reading; F-8 is restated with its exact register). No
finding was refuted.

### 7.1 B-1 — Monotonic-narrowing invariant forbids P3-B's required manifest changes

| Field | Value |
|---|---|
| **Class** | **VERIFIED DEFECT-BLOCKER (structural)** |
| Requirement | P3-B must bind a **destination** to each egress capability, and must **correct** impact ceilings that understate external transmission |
| Expected | The manifest model permits declaring a destination and permits raising an understated ceiling |
| Observed | Both are **explicitly rejected** |
| Methodology | `grep -n` on `isNarrowing` and its call site; read `:130-215` |
| Confidence | **HIGH** — direct source, and the invariant is itself tested |

**Fresh source evidence — `packages/authorization-boundary/src/capability-manifests.ts`:**

| Line | Measured behaviour |
|---|---|
| `:130` | `export function isNarrowing(previous: A01CapabilityManifest, next: A01CapabilityManifest): { ok: boolean; violation?: string }` — a new manifest version must be **narrower** than its predecessor. **[D-3 corrected]** The return type is a **result object**, not a bare `boolean`: the caller inspects `check.ok` and surfaces `check.violation` (`:213-217`) |
| `:140` | rejects any version that **adds** an `allowedTargets` entry — *"widens target scope"* |
| `:162` | rejects any version that **raises** `maxDataClassification` — classification ceiling |
| `:164-165` | rejects any version that **raises** `maxImpact` — impact ceiling |
| `:213` | **enforced at registration** — a non-narrowing version is refused |

**Why this blocks P3-B specifically, with two independent collisions:**

1. **Destination binding requires *adding* a target.** If P3-B expresses permitted destinations as
   `allowedTargets` entries, registering that version **adds** entries and is rejected at `:140`.
2. **Correcting F-3 requires *raising* an impact ceiling.** `vector.search` is declared
   `impact:'READ'` (`builtins.ts:66`). Correcting it to reflect external transmission means raising
   `maxImpact` — rejected at `:164-165`.

**This is not a bug in `isNarrowing`.** It is a *correct, deliberately tested* P2 invariant. The
defect is that **P3-B's design was scoped without accounting for it.** Any P3-B that needs either
change must either (a) introduce a **separate** destination-policy model that does not route through
`allowedTargets` (leaving `isNarrowing` intact), or (b) obtain an explicitly authorized, separately
reviewed change to the invariant — which would weaken a tested P2 control and must not be bundled
into P3-B.

**Consequence if unresolved:** P3-B implementation either fails its own registration step, or is
tempted into weakening `isNarrowing` — trading a verified control for a new one.

**Decision required:** OD-1 (§19).

### 7.2 B-2 — No identity reaches the egress seam; no ambient-context mechanism exists

| Field | Value |
|---|---|
| **Class** | **VERIFIED DEFECT-BLOCKER (architectural)** |
| Requirement | P3-B must decide per-request, per-principal, per-tenant: *"may **this** identity transmit **this** payload to **that** destination?"* |
| Expected | Identity is available at the seam, directly or ambiently |
| Observed | **Neither.** The seam's request type carries no identity, and no ambient mechanism exists |
| Methodology | full field enumeration of `LLMRequest`; grep for identity terms; sweep for `AsyncLocalStorage`/`async_hooks` in `packages/*/src` **and across all of `packages/`** |
| Confidence | **HIGH** |

**Fresh evidence:**

- `packages/agent-runtime/src/llm.ts:18-24` — `LLMRequest` comprises exactly **5 fields**:
  `messages` (`:19`), `tools?` (`:20`), `temperature?` (`:21`), `maxTokens?` (`:22`),
  `signal?` (`:23`). **[D-4 corrected]** An earlier revision of this document asserted **6** fields
  including a *"model/type discriminant"*; **no such field exists**. The correct count is **5**,
  confirmed by direct enumeration of the interface body.
  Search for `principal`, `tenant`, `agentId`, `runId`, `correlationId`, `actor`, `subject`,
  `sessionId` across the entire file: **0 hits for each.**
- `AsyncLocalStorage` in `packages/*/src`: **0 hits.** `async_hooks`: **0 hits.**
- Widened to **all of `packages/`** (including tests): **0 hits for both.** There is no ambient
  context mechanism anywhere in the product, not even partially built.

**Precision required by this correction — what B-2 does and does not claim:** B-2 is a
**propagation/seam gap, not an absence of identity from the system.** Identity **does** exist
upstream, in the agent runtime: `agent.ts:132-135` resolves `auth?.runId`, `auth?.correlationId`, and
`auth?.agentId`, and `agent.ts:138-140` fail-closes on a missing verified principal
(*"A missing verified principal is fail-closed: the decision is a DENY (`MISSING_PRINCIPAL`)"*).
The authorization envelope therefore carries principal, tenant, agent, run, and correlation identity.
**What is absent is any mechanism to carry that identity from the envelope to the egress seam**:
`LLMRequest` has no identity field, and no ambient context exists to supply one out-of-band. The gap
is the **last hop**, not the whole chain — which is why B-2 is an architectural *plumbing* problem
with a bounded (if non-trivial) solution space, rather than a missing identity model.

**Consequence:** at the moment the outbound call is constructed, **there is nothing to decide
against.** An egress PDP placed at N-1/N-2 would receive a payload and no subject. P3-B therefore
requires an **architectural change to the runtime's call chain** — threading identity from `agent.ts`
through `tools.ts` into the model/embedding interfaces — which is **not** an "add a middleware" task
and is materially larger than the P3-A slice description implies.

**Two candidate architectures, both with real cost (owner decision, OD-3):**

| Option | Mechanism | Cost |
|---|---|---|
| **Explicit threading** | Extend `LLMRequest` and the embedding interface with an identity/decision-context field | Breaks existing call signatures; touches `agent-runtime`, `vector-search`, `cli`; requires test updates |
| **Ambient context** | Introduce `AsyncLocalStorage` | **Zero precedent in this codebase**; must not become an implicit trust channel; risk of context loss across `await` boundaries silently disabling enforcement — must be **fail-closed on absent context** |

### 7.3 B-3 — Destination matcher implements an unbounded `.*` glob, contradicting its own documentation

| Field | Value |
|---|---|
| **Class** | **VERIFIED DEFECT (source + behavioural probe)** |
| Severity for P3-B | **HIGH** — P3-B would make this matcher *security-critical*; today it is latent |
| Requirement | A destination allowlist must match **hostname boundaries** exactly |
| Expected (per documentation) | *"segment-delimited"* matching |
| Observed (per code) | Patterns joined with an **unbounded `.*`**, so a pattern can cross hostname/segment boundaries |
| Methodology | read `:262-284`; locate consumer at `policy-engine.ts:304`; **probe `P3B-PROBE-01`** (§20.1) |
| Confidence | **HIGH** — code and observed behaviour agree |

**Fresh source evidence — `capability-manifests.ts`:**

| Line | Measured content |
|---|---|
| `:262-265` | doc comment describes matching *"within a segment-delimited resource"* |
| `:267` | `export function targetMatches(...)` — the implementation |
| `:267-284` | pattern pieces are joined with **`.*`** (unbounded) rather than a segment-bounded separator |
| `types.ts:404` | the type-level contract calls this a *"simple segment glob"* |
| `policy-engine.ts:304` | the matcher is **consumed by the PDP** — it is a live authorization input |

**Documentation/code mismatch is itself a finding:** the contract text says *"segment-delimited"* and
*"simple segment glob"*; the code does not delimit segments.

**Probe `P3B-PROBE-01` verbatim output** (reproduces the matcher's join semantics; runtime Node
v22.22.3):

```
node v22.22.3
MATCH    | pattern="https://api.openai.com/*" | resource="https://api.openai.com/v1/chat/completions" | intended allow
MATCH    | pattern="https://api.openai.com*"  | resource="https://api.openai.com.evil.com/steal"      | no-slash pattern vs attacker domain
MATCH    | pattern="*.openai.com"             | resource="api.openai.com"                             | host glob intended
MATCH    | pattern="*.openai.com"             | resource="evil.com?.openai.com"                       | host glob crossing segments
MATCH    | pattern="https://*/v1/embeddings"  | resource="https://attacker.tld/v1/embeddings"         | leading wildcard = any host
MATCH    | pattern="https://api.openai.com/v1/*" | resource="https://api.openai.com/v1/../../admin"   | dot-segments in allowed prefix
```

**Three distinct defects, each independently exploitable if this matcher became the egress allowlist:**

1. **Hostname-boundary bypass.** `https://api.openai.com*` matches `https://api.openai.com.evil.com/steal`.
   An allowlist entry intended to permit the provider would **also permit an attacker-controlled
   domain**. This is the classic suffix-confusion failure and it is **the** defect that makes
   B-3 HIGH for P3-B.
2. **Leading wildcard ⇒ any host.** `https://*/v1/embeddings` matches `https://attacker.tld/v1/embeddings`.
   A pattern that *looks* path-restricted is in fact **host-unrestricted**.
3. **Dot-segment traversal inside an allowed prefix.** `https://api.openai.com/v1/*` matches
   `https://api.openai.com/v1/../../admin` — the matcher performs **no URL normalization**, so
   traversal is neither rejected nor canonicalized before comparison.

**Why "latent today" and not "critical today":** no egress decision currently consumes a
destination pattern, because no egress decision exists (§5.1). The matcher's exposure today is
limited to whatever `allowedTargets` entries currently exist. **The severity escalates precisely
because P3-B proposes to route destination authorization through it.**

### 7.3.1 **[D-1 corrected]** A SECOND, TEXTUALLY IDENTICAL implementation exists in a different package and trust domain

**The original revision of this assessment recorded B-3 at one site only
(`capability-manifests.ts:267`). That was a material omission.** Independent inspection during
verification, re-confirmed against source for this correction, establishes that the same matching
weakness exists in **two** implementations, in **two** packages, on **two** sides of a declared
package dependency boundary.

**Second implementation — `packages/authentication/src/delegation-types.ts:385-402`,
`delegationTargetMatches`:**

| Line | Measured content |
|---|---|
| `:380-384` | doc comment: *"Target-scope matching (**mirrors the A-01 `targetMatches` semantics exactly**: exact system match; `resourcePattern` undefined ⇒ resource must be absent; no `*` ⇒ exact resource match; `*` ⇒ **simple segment glob**)."* — it repeats the **same inaccurate** "segment glob" description |
| `:385-389` | `export function delegationTargetMatches(pattern: DelegationTargetScope \| undefined, system: string, resource: string \| undefined): boolean` |
| `:390-394` | identical guard sequence to `targetMatches:272-276` |
| `:395-400` | `new RegExp('^' + …split('*')…replace(/[.*+?^${}()|[\]\\]/g,'\\$&')…` **`.join('.*')`** at `:399` `+ '$')` — **the same unbounded join** |
| `:401` | `return regex.test(resource)` |

**Textual identity established by direct comparison, not by eye:** extracting
`capability-manifests.ts:277-283` and `delegation-types.ts:395-401` and diffing them yields
**no differences** — the two regex-construction bodies are **byte-identical**. Repo-wide search for
`.join('.*')` returns **exactly these two sites** (`delegation-types.ts:399`,
`capability-manifests.ts:281`) and **zero** occurrences in test code.

**The second site is not dormant — it is an authoritative decision path:**

| Evidence | Measured content |
|---|---|
| `delegation-types.ts:364-367` | *"This is the fail-closed subset notion used at grant time and in the **A-16 live-manifest re-verification**; the **authoritative per-decision resource check is `delegationTargetMatches`** against both the grant and the live manifest."* |
| `delegation-types.ts:438-440` | `targetsContain(...)` ⇒ `targets.some((t) => delegationTargetMatches(t, system, resource))` — the **live consumer** |
| `delegation-types.ts:442-445` | that consumer serves the *"Pure, deterministic grant assessment (spec §8.2.1–8.2.8, in order). Only `VALID` is non-denying. Used by the store's **in-transaction reads** AND the decider's **enforcement re-check** (one semantics, **two enforcement sites**)."* |
| `authentication/src/index.ts:253` | `delegationTargetMatches` is **exported from the package's public surface** |

**An explicit identity invariant couples the two implementations.** `delegation-types.ts:404-409`
states that the locally mirrored orderings exist *"so the delegation store can compare ceilings
without depending on the authorization-boundary package — the dependency direction is
authorization-boundary → authentication"* and that *"These **MUST stay identical** to
`A01_CLASSIFICATION_ORDER` / `A01_IMPACT_ORDER`."* Combined with the `:381` claim that the matcher
*"mirrors the A-01 `targetMatches` semantics exactly"*, the codebase **asserts an intentional
equivalence** between the two implementations.

**Consequences — why this materially changes B-3's remediation shape:**

1. **Two trust domains are affected, not one.** The first site gates **capability authorization**
   (authorization-boundary). The second gates **delegation grant assessment** (authentication) — i.e.
   whether a delegated grant legitimately covers a target. **Delegation narrowing is a privilege
   boundary**, so an unbounded glob there can make a grant appear to cover a target it should not.
2. **Remediation must account for both implementations.** Fixing `targetMatches` alone leaves
   `delegationTargetMatches` vulnerable, and — because the two are documented as semantically
   identical — **silently breaks the stated identity invariant**, producing divergent authorization
   behaviour between the capability path and the delegation path. Any fix must therefore be applied
   to **both**, or the two must be **deliberately de-coupled** with the "mirrors exactly" /
   "MUST stay identical" comments corrected.
3. **The intended identity invariant must be preserved and verified, not assumed.** This assessment
   does **not** assert that a shared helper is the correct resolution — that is an engineering
   decision requiring separate authorization. It asserts only that **whatever remediation is chosen
   must (a) cover both sites, and (b) either preserve the equivalence or explicitly and verifiably
   revoke it.**
4. **Severity for P3-B is raised, not lowered.** P3-B would route destination authorization through
   matching semantics that are **duplicated across a package boundary**. A destination allowlist
   built on either site inherits the suffix-confusion, leading-wildcard, and dot-segment defects
   proven in §20.1 — and a fix applied to only one site would leave the other reachable.

**Classification of this correction:** the *underlying defect* (B-3) was already **VERIFIED**; what
changes is its **scope** — from one implementation to **two**. **Class: VERIFIED DEFECT, scope
corrected. No security condition was remediated by this documentation correction** (§24).

**Decision required:** OD-4 (§19) — remediate B-3 **before** P3-B (as a separately authorized P2/
authorization-boundary change), or **inside** P3-B with its own tests. Bundling it silently into
P3-B would make a P3 slice responsible for changing a tested P2 matcher. **[D-1]** OD-4 must now be
read as covering **both** `targetMatches` **and** `delegationTargetMatches`, plus the identity
invariant that couples them.

### 7.4 F-3 — `vector.search` is authorized as an internal READ yet causes credentialed external transmission

| Field | Value |
|---|---|
| **Class** | **VERIFIED DEFECT** |
| Severity | **HIGH** (measured, not inflated) |
| Requirement | An authorization record must accurately describe what the capability does |
| Expected | A capability that transmits tenant data externally is recorded as external transmission |
| Observed | Recorded as `impact:'READ'`, `dataClassification:'INTERNAL'`, `targetSystem:'tenant-knowledge'` — while the payload leaves the boundary over credentialed HTTPS |
| Methodology | end-to-end source trace `builtins.ts` → `vector-module.ts` → `embeddings.ts`; replay-consumption rule read at `gate.ts:407-408`; input-validation measured in `tools.ts` |
| Confidence | **HIGH** — every hop cited |

**Fresh evidence chain:**

| Step | Location | Measured content |
|---|---|---|
| 1 | `builtins.ts:63-68` | `KNOWLEDGE_READ_CAPABILITY`: `:66` `impact:'READ'`, `:67` `dataClassification:'INTERNAL'`, `:68` `targetSystem:'tenant-knowledge'` |
| 2 | `builtins.ts:210-229` | `vector.search` tool; `:221` declares `{ ...KNOWLEDGE_READ_CAPABILITY, operation:'search' }` |
| 3 | `builtins.ts:227` | `embedAndSearch(idx, String(input.query), { tenantId, ... })` — **`input.query` is model-supplied** |
| 4 | `vector-module.ts:111-118` | `embedAndSearch`; `:114` `const q = await this.model.embed(text)` |
| 5 | `embeddings.ts:109` | **credentialed outbound POST** of the text; `:113` `Authorization` bearer |

**Four aggravating properties, each separately verified:**

1. **Unbounded repeatability, enforced at THREE independent sites.** `gate.ts:407-408` — *"Replay
   protection: non-READ decisions are consumed exactly once"* — implemented as
   `if (verified.impact !== 'READ')`. Because the impact is `READ`, the envelope is **not consumed**
   (also `gate.ts:12`, `:453`). **[D-2 corrected]** A **third** site exists in the **durable**
   consumption store: `consumption-stores.ts:75` — `if (input.impact === 'READ') return { consumed:
   false };` — documented at `:60-61` as *"READ envelopes are never consumed (R1 parity) and return
   `{ consumed: false }`."* This is a **deliberate design decision, not an oversight**, which means
   correcting it requires a **policy change to the replay model**, not merely a code fix. **One
   authorization therefore permits unlimited repeat external transmission, and that permission is
   consistent across the in-memory gate, the pre-await consumption path, and the durable store.**
2. **No destination recorded.** `A01AuditRecord` has no destination field (§5.1) — the transmission is
   forensically invisible.
3. **No input validation on `query`.** `tools.ts` `validateInput` performs **required-key presence
   checking only** — no type, range, format, length, or content validation (§11.2). Arbitrary
   model-chosen text reaches the wire.
4. **Correction is blocked by B-1.** Raising `impact` above `READ` is rejected by `isNarrowing` at
   `capability-manifests.ts:164-165`.

**Consequence:** the authorization layer's own record asserts a weaker action than the one performed.
An auditor reading the audit trail would conclude no external transmission occurred.

**Scope discipline:** this is a **pre-existing defect**, not a P3-B regression. It **cannot be fixed
inside P3-B** without colliding with B-1. Recorded as a **separately authorized remediation
candidate** (§19, OD-5). This audit does **not** remediate it.

### 7.5 F-4 — No redirect policy on N-1/N-2: arbitrary-destination traversal plus 307/308 body forwarding

| Field | Value |
|---|---|
| **Class** | **VERIFIED DEFECT (source + behavioural probe)** |
| Severity | **HIGH** — with an important, evidence-based **narrowing** (see below) |
| Requirement | Outbound calls must not silently traverse to attacker-chosen destinations |
| Expected | Redirects refused (as N-3 does) or re-authorized per hop |
| Observed | **No redirect policy at all**; Node's default follows every redirect status cross-origin |
| Methodology | source check for `redirect` on N-1/N-2 (**0** occurrences — all 5 in `jwt.ts`); **probe `P3B-PROBE-02`** (§20.2) against a local listener |
| Runtime caveat | **Node v22.22.3**; CI is Node **20** (`ci.yml:40`). **Non-parity — this is NOT a CI-observed result** (§21.2) |
| Confidence | **HIGH** for the source absence; **MEDIUM-HIGH** for exact per-status transport behaviour on Node 20 |

**Probe `P3B-PROBE-02` verbatim output:**

```
node v22.22.3
HTTP 301: followed=YES target=127.0.0.1:37599 auth=(ABSENT) body=(EMPTY)
HTTP 302: followed=YES target=127.0.0.1:34035 auth=(ABSENT) body=(EMPTY)
HTTP 303: followed=YES target=127.0.0.1:43215 auth=(ABSENT) body=(EMPTY)
HTTP 307: followed=YES target=127.0.0.1:43491 auth=(ABSENT) body={"model":"probe","input":"TENANT-A-CONFIDENTIAL-CONTEXT"}
HTTP 308: followed=YES target=127.0.0.1:35813 auth=(ABSENT) body={"model":"probe","input":"TENANT-A-CONFIDENTIAL-CONTEXT"}
```

**Read precisely — this measurement *narrows* the naive reading and must not be inflated:**

| Property | **CROSS-ORIGIN** redirect (different port ⇒ different origin; the attacker/internal-host case) | **SAME-ORIGIN** redirect (path redirect on the same host:port; the allowed-origin case) | Correct interpretation |
|---|---|---|---|
| Redirects followed? | **YES on all five** (301/302/303/307/308) | **YES on all five** | Real defect, **origin-independent**: traversal to arbitrary destinations, including internal addresses |
| `Authorization` forwarded? | **STRIPPED on all five** | **FORWARDED on all five** | **Origin-dependent.** Cross-origin ⇒ **credential theft is NOT demonstrated**. Same-origin ⇒ the bearer credential **does** travel to the redirect target |
| Request body on 301/302/303 | **EMPTY** | **EMPTY** | Payload not forwarded on these statuses, either origin relationship |
| Request body on **307/308** | **FORWARDED** (probe marker `TENANT-A-CONFIDENTIAL-CONTEXT` received) | **FORWARDED** | Real defect, **origin-independent**: tenant payload exfiltration on method-preserving redirects |

**[D-6 corrected]** An earlier revision stated flatly that *"`Authorization` [is] not forwarded"* and
that it was *"stripped in every observed case."* That was **over-general**: it was true of the
**cross-origin** trials only, because the original probe exercised a single origin relationship. A
same-origin control added during verification shows the header **is** forwarded on all five statuses.
The table above replaces the unqualified claim. **Neither variant overstates nor understates the risk:**

- **Cross-origin credential theft remains REFUTED** (T-03). Node strips `Authorization` when the
  redirect target is a different origin, so an attacker-controlled **host** does not receive the
  bearer token by this mechanism.
- **Same-origin credential forwarding is a genuine residual**, not a refutation. If a permitted origin
  hosts an **open redirect** (or the provider endpoint itself redirects within its own origin), the
  credential and — on 307/308 — the body are delivered to that same-origin target. This **raises** the
  importance of R-02/R-03 (hostname-boundary-exact matching, URL normalization): an allowlist that can
  be confused about what "the same origin" is (B-3, D-1) directly undermines the only property that
  currently prevents credential exposure.
- **Body exfiltration (T-02) is confirmed on 307/308 regardless of origin relationship.**

**Therefore the substantiated consequences are exactly three:**

1. **SSRF / arbitrary-destination traversal** — a redirect response from the configured endpoint (or
   any MITM position on it) can point the request at internal hosts, and the request will be followed
   with **no re-authorization** and **no record**. *Origin-independent.*
2. **Data exfiltration via 307/308** — the request **body** (which at N-2 contains tenant text
   destined for embedding) is forwarded to the redirect target. *Origin-independent.*
3. **Credential forwarding on same-origin redirects** — the `Authorization` bearer **is** delivered
   when the redirect target shares the request's origin. *Origin-dependent; see the corrected table.*

**Explicitly NOT substantiated:** **cross-origin** credential theft via redirect (T-03). Node strips
`Authorization` on all five statuses when the target is a different origin, so the specific claim
*"a redirect to an attacker host steals the provider credential"* is **refuted under the measured
transport behaviour**. **[D-6 corrected]** The earlier wording — *"stripped in every observed case"* —
is withdrawn as over-general: it held only for the cross-origin trials the original probe ran.

**Requirement consequence, stated so it neither overstates nor understates:** P3-B must target
**traversal + body forwarding (both origin-independent) + same-origin header forwarding**, while
**not** claiming cross-origin credential theft. Treating the refuted T-03 as live would overstate the
finding; treating consequence 3 as refuted would understate it.

**Note also:** the probe's redirect target was **loopback**, and the request **succeeded**, which
independently corroborates §20.3: **internal addresses are reachable from this process.**

### 7.6 F-8 — The PR #38 "8/8 PASS" claim is NOT substantiated by canonical evidence

| Field | Value |
|---|---|
| **Class** | **UNVERIFIED — no canonical artifact exists** |
| Requirement | A post-merge verification claim must be backed by a committed canonical artifact naming the SHA, the checks, and the results |
| Expected | An artifact for PR #38 recording 8/8 PASS |
| Observed | **No file in the repository references PR #38 at all**, and no `8/8` occurrence relates to it |
| Methodology | (a) `grep -rl -E '#38\|PR 38\|PR-38\|pull/38'` excluding `.git` ⇒ **0 files**; (b) enumerated every `8/8` occurrence and read its context; (c) enumerated **all** post-merge verification records in `docs/verification/` and read each one's subject header and findings register (**[D-5 corrected]** — an earlier revision said "the sole post-merge record"; there are **two**, and neither covers PR #38); (d) read-only `gh pr view 38` |
| Confidence | **HIGH** that no canonical artifact exists |

**Fresh measurements:**

1. **Zero references to PR #38 anywhere in the tracked tree** — files matching `#38`/`PR 38`/`PR-38`/
   `pull/38`: **0**.
2. **Every `8/8` occurrence is unrelated** to PR #38. Enumerated with context:
   `JATA_QI_UNIFICATION_AUDIT_SUMMARY.md:45` (*"`EXECUTED_UNDER_AUTHORITY` (8/8 engines)"*);
   `INV-15_GAP-07_IMPLEMENTATION_EVIDENCE.md:123` (*"human-approval 8/8"*);
   `P2_S1_VERIFICATION_REPORT.md:41` (*"p2-s1-identity-decision 8/8"*), `:176` (*"passes 8/8
   post-remediation"*); `P2_S3_VERIFICATION_REPORT.md:135,:162`; `P2_S4_VERIFICATION_REPORT.md:375`
   (*"p2-s3-posture-invariants.test.ts 8/8"*);
   `PHASE_A_GOVERNANCE_AND_CRITICAL_PATH.md:405`. **None names PR #38.**
3. **There are exactly TWO post-merge verification records in the repository, and NEITHER covers
   PR #38.** **[D-5 corrected]** — an earlier revision of this document described
   `P2_S8_POSTMERGE_VERIFICATION.md` as *"the sole post-merge verification record."* That is
   **factually wrong**: enumeration of `docs/verification/` for `*POSTMERGE*` returns two files.

   | Record | Subject | Verified SHA | Covers PR #38? |
   |---|---|---|---|
   | `P2_S8_POSTMERGE_VERIFICATION.md` | *"Exact canonical artifact **`08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe`**"*; *"Merge commit `08adbd9…` **(PR #37)**"*; post-merge CI run **`35252694561`**; dated 2026-09-17; evidence class **"PRIMARY (same-agent, read-only) — NOT E4"** | `08adbd9…` (**PR #37**) | **NO** — `grep -c -E '#38\|6b61256'` = **0** |
   | `PR20_MERGE_POSTMERGE_VERIFICATION.md` | *"post-merge verification of canonical `main` **`700ae80`** (merge of PR #20)"*; verified SHA `700ae8000ee9303bf1ea6289d0eab90085ffb597`; merged 2026-09-07T01:23:53Z; CI run **`34072884374`** | `700ae80…` (**PR #20**) | **NO** — `grep -c -E '#38\|6b61256'` = **0** |

   **The correction does not change F-8's conclusion — it strengthens it.** Both records name a
   different PR and a different SHA, and neither contains any reference to PR #38 or to the audited
   baseline `6b61256`. **No canonical post-merge verification artifact for PR #38 exists.**
4. **That record is not 8/8.** Its register (PM-01…PM-08) is **3 PASS + 5 non-PASS**:

| ID | Verbatim substance | Verdict |
|---|---|---|
| PM-01 | Merge graph, parent identity, post-merge main agree with authorized values | **PASS (verification)** |
| PM-02 | Zero production `src/` changes in the merged diff | **PASS (verification)** |
| PM-03 | Post-merge CI green on the exact merge SHA | **PASS (CI class)** |
| PM-04 | *"No `P2_S8_INDEPENDENT_VERIFICATION.md` exists; S8's E4 acceptance item is unsatisfied"* | **EVIDENCE GAP** |
| PM-05 | *"Raw CI logs remain inaccessible (0 bytes) — G10-class limitation live on this run"* | **EVIDENCE LIMITATION** |
| PM-06 | *"Force-push protection absent; live ruleset differs from prior records"* | **GOVERNANCE** |
| PM-07 | *"Stale-review dismissal and last-push approval disabled"* | **GOVERNANCE (hardening)** |
| PM-08 | *"No local suite re-execution in this session"* | **LIMITATION** |

5. **What PR #38 actually is** (read-only `gh pr view 38`): state **MERGED**, merged
   **2026-09-18T04:55:03Z**, base `main`, head `arena/01a0b08f-jata-qi`, merge commit
   **`6b61256c6115a02da2d3ad6ba42771831b550f81`** — i.e. **PR #38 produced the audited baseline
   itself**. Its file list is **5 documentation files only**: `docs/rubric/P0R-95_SCORECARD.md`,
   `docs/verification/P0_V11_ASSESSMENT_AT_08ADBD9.md`, `docs/verification/P2_ASSURANCE_CAP_DISPOSITION.md`,
   `docs/verification/P2_S8_POSTMERGE_VERIFICATION.md`, `docs/verification/P3_A_SECURITY_THREAT_MODEL_AND_BASELINE.md`.

**Honest classification, per the instruction not to reproduce an unevidenced claim as verified fact:**

> **The "PR #38 — 8/8 PASS" assertion is UNVERIFIED and must not be cited as verified.** No canonical
> artifact supports it. The nearest canonical record covers **PR #37 / `08adbd9`** and reports
> **3 PASS with 5 open gaps**, not 8/8. PR #38 is a **documentation-only merge** that created the
> current baseline; **no post-merge verification record for PR #38 exists.**

**Corroborating CI metadata** (read-only `gh run list --branch main`): run **`35308789086`** on head
`6b61256` ⇒ conclusion **`success`**; run `35252694561` on `08adbd9` ⇒ `success`; run `34766326603` on
`2c1cad0` ⇒ `success`. **CI green on the audited SHA is VERIFIED** — but CI success is a *build/lint/
test* signal and is **not** equivalent to a security post-merge verification, and is **not** E4.

### 7.7 F-9 — Baseline continuity: the prior baseline `08adbd9` is not locally resolvable; the egress seams are unchanged

| Field | Value |
|---|---|
| **Class** | **VERIFIED (via read-only remote metadata)** |
| Question | Are the P3-A findings still live at `6b61256`, or were they remediated between `08adbd9` and HEAD? |
| Methodology | (a) establish the clone's depth and shallow boundary; (b) attempt local resolution of `08adbd9`; (c) **instead of `git fetch`** (which would mutate the object store), compare **remote blob SHAs** per file via read-only GitHub API; (d) confirm `08adbd9`'s existence and provenance remotely |
| Confidence | **HIGH** — blob SHAs are content hashes; equality is byte-identity |

**Fresh measurements:**

| Check | Command / method | Observed |
|---|---|---|
| Clone depth | `git rev-parse --is-shallow-repository` | **`true`** |
| Shallow boundary | `cat .git/shallow` | **`6b61256c6115a02da2d3ad6ba42771831b550f81`** (== HEAD) |
| Commit count | `git rev-list --count HEAD` | **1** — depth-1 clone |
| Local resolution of prior baseline | `git cat-file -t 08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe` | **`fatal: could not get object info`** — **not locally resolvable** |
| Remote existence of `08adbd9` | read-only `gh` | **exists**; it is the **PR #37 merge commit**, dated **2026-09-17** |
| Egress-file continuity `08adbd9` → `6b61256` | per-file **remote blob SHA** comparison | **all 4 egress-relevant files byte-identical** |

**Blob-identity result — the four files that constitute the egress attack surface:**

| File | `08adbd9` blob | `6b61256` blob | Result |
|---|---|---|---|
| `packages/agent-runtime/src/llms/openai.ts` | identical | identical | **UNCHANGED** |
| `packages/vector-search/src/embeddings.ts` | identical | identical | **UNCHANGED** |
| `packages/authentication/src/jwt.ts` | identical | identical | **UNCHANGED** |
| `packages/authorization-boundary/src/capability-manifests.ts` | identical | identical | **UNCHANGED** |

**Conclusion:** PR #38 (which produced `6b61256`) changed **documentation only** — corroborated
independently by its file list (§7.6 item 5). **Every egress finding from the prior baseline is still
live, unremediated, at the audited SHA.** P3-A's defects **P3-D1/D3/D4/D5** therefore remain open, and
this audit's §5 measurements describe current reality rather than stale state.

**Methodology note (deliberate):** `git fetch` was **not** used. Fetching would have mutated the local
object store and expanded the clone beyond its authorized depth-1 state. Blob-SHA comparison via the
read-only API achieves the same proof **without** altering repository state — consistent with the
"no unrelated repository mutation" constraint.

### 7.8 Re-verification summary

| Finding | Prior claim | Fresh result | Class now |
|---|---|---|---|
| **B-1** | Narrowing invariant blocks destination binding | **SUBSTANTIATED** (`:130,:140,:162,:164-165,:213`) | VERIFIED DEFECT-BLOCKER |
| **B-2** | No identity at the seam; no ambient context | **SUBSTANTIATED** (**5** fields per `llm.ts:18-24`; 0 identity hits; 0 `AsyncLocalStorage` across `packages/`) — **[D-4 corrected]** field count reduced from an erroneous 6 | VERIFIED DEFECT-BLOCKER |
| **B-3** | Unbounded glob; doc/code mismatch | **SUBSTANTIATED + probe-confirmed** (3 distinct bypass classes). **[D-1] SCOPE CORRECTED** — a second byte-identical implementation exists at `delegation-types.ts:385-402` | VERIFIED DEFECT (two sites) |
| **F-3** | Internal READ causes external transmission | **SUBSTANTIATED**, plus unbounded repeatability via `gate.ts:407-408` | VERIFIED DEFECT |
| **F-4** | Redirects followed; no policy | **SUBSTANTIATED and REFINED** — traversal + 307/308 body forwarding **yes**; credential theft **no** | VERIFIED DEFECT |
| **F-8** | PR #38 8/8 PASS | **NOT SUBSTANTIATED** — 0 references; nearest record is PR #37 with 3 PASS + 5 gaps | **UNVERIFIED** |
| **F-9** | Baseline continuity | **SUBSTANTIATED** — depth-1 clone; `08adbd9` remote-only; 4/4 egress blobs identical | VERIFIED |

**No previously reported finding was refuted. One (F-8) was reclassified from asserted to UNVERIFIED
for lack of canonical evidence. One (F-4) was refined downward on one axis and confirmed on two
others.**

---

## 8. THREAT MODEL FOR GOVERNED EGRESS (scope A — boundary and trust)

### 8.1 Assets at risk on the egress path

| Asset | Where measured | Exposure |
|---|---|---|
| Provider API credential | `openai.ts:41`, `embeddings.ts:91`, from `process.env.OPENAI_API_KEY` (`config.ts:99`) | Sent as `Authorization` bearer at `openai.ts:76`, `embeddings.ts:113` |
| Tenant document text | `builtins.ts:227` `String(input.query)` → `vector-module.ts:114` → `embeddings.ts:109` | Transmitted externally under an `INTERNAL`/`READ` record (F-3) |
| Conversation content | `agent.ts` message assembly → `openai.ts:72` | Transmitted externally with no destination record |
| Authorization audit trail | `audit.ts:29` closed field set | **Cannot record egress** ⇒ forensic blind spot (B-5) |
| Internal network position | §20.3 probe | Reachable from the process (loopback confirmed; `169.254.169.254` reached network layer) |

### 8.2 Threat register (each with precondition and measured status)

| ID | Threat | Precondition required | Measured status at `6b61256` | Class |
|---|---|---|---|---|
| **T-01** | Redirect-driven traversal to internal hosts (SSRF) | A redirect response reachable on the egress path | **No redirect policy on N-1/N-2**; all 5 statuses followed (probe §20.2) | **VERIFIED — exploitable given precondition** |
| **T-02** | Tenant-payload exfiltration via 307/308 | Same precondition | **Body forwarded verbatim on 307/308** (probe §20.2) | **VERIFIED — exploitable given precondition** |
| **T-03** | Provider credential theft via **cross-origin** redirect | Redirect to an attacker-controlled **host** (different origin) | **NOT demonstrated** — `Authorization` **STRIPPED** on all 5 statuses cross-origin | **REFUTED as stated** (recorded to prevent inflation). **[D-6]** scoped explicitly to cross-origin |
| **T-15** | Provider credential forwarding via **same-origin** redirect | A permitted origin hosts an **open redirect**, or the provider endpoint redirects within its own origin | **DEMONSTRATED** — `Authorization` **FORWARDED** on all 5 statuses same-origin (probe §20.2 `P3B-PROBE-02b`) | **VERIFIED residual** — **[D-6, newly added]**; interacts with B-3/D-1, since an allowlist confused about host boundaries defeats the origin distinction that currently protects the credential |
| **T-04** | Allowlist bypass via suffix confusion (`api.openai.com.evil.com`) | A destination allowlist consuming **either** matcher | **Both** matchers confirmed vulnerable (**[D-1]** `capability-manifests.ts:281` and `delegation-types.ts:399`, byte-identical; probe §20.1); **no allowlist consumes either for egress yet** | **VERIFIED DEFECT — latent for egress, escalates with P3-B** |
| **T-05** | Allowlist bypass via leading wildcard | Same | `https://*/v1/embeddings` matches any host (probe §20.1) — applies to **both** implementations | **VERIFIED DEFECT — latent for egress** |
| **T-06** | Path traversal inside an allowed prefix | Same | `/v1/../../admin` matches (probe §20.1); no normalization — applies to **both** implementations | **VERIFIED DEFECT — latent for egress** |
| **T-16** | **Delegation target-scope confusion** via the duplicated matcher | A delegation grant whose `resourcePattern` contains `*`, assessed by `delegationTargetMatches` | **[D-1, newly added]** Unlike T-04…T-06 this consumer is **live today**: `delegation-types.ts:439` `targetsContain` → the grant assessment at `:442-445`, used by *"the store's in-transaction reads AND the decider's enforcement re-check."* The matcher's glob weakness is therefore **already reachable** on a privilege-narrowing path. **Whether an exploitable pattern is actually registered depends on live grant data, which this audit did NOT measure** | **VERIFIED DEFECT in the matcher; exploitability UNKNOWN** (no grant corpus inspected) |
| **T-07** | Cloud-metadata credential theft | Metadata service reachable + network-layer filtering absent | `169.254.169.254` **reached the network layer** (HTTP 501 from the sandbox egress path). **No production metadata service was contacted** | **PARTIAL — reachability VERIFIED; metadata theft NOT demonstrated** |
| **T-08** | Non-HTTP scheme abuse (`file://`, `gopher://`, `ftp://`) | Transport permits the scheme | **All three failed** — `TypeError: fetch failed` (probe §20.3) | **REFUTED for this transport** |
| **T-09** | DNS rebinding against an IP allowlist | An IP-based check + attacker DNS | **No IP/resolver control exists at all** (0 hits for private-range terms, §5.4) | **UNVERIFIED — control absent, so moot until built** |
| **T-10** | Unbounded repeat external transmission under one authorization | A `READ`-impact capability that transmits | `gate.ts:407-408` does **not** consume `READ` envelopes; **[D-2]** corroborated at `gate.ts:453` **and** in the durable store at `consumption-stores.ts:75` (`{ consumed: false }`), documented as intentional *"R1 parity"* at `:60-61` — **three sites, one consistent policy** | **VERIFIED** |
| **T-11** | Model-controlled argument reaching the wire unvalidated | Tool passes model input to an egress call | `validateInput` = **presence-only** (§11.2) | **VERIFIED** |
| **T-12** | Undetected destination substitution by a compromised adapter default | Operator never sets an endpoint | **0** `endpoint` occurrences in `bootstrap.ts`/`config.ts` | **VERIFIED — no operator override path** |
| **T-13** | Ambient-context loss silently disabling enforcement | P3-B adopts `AsyncLocalStorage` | **Not yet applicable** — 0 hits today; must be designed fail-closed | **ASSUMED/FUTURE** |
| **T-14** | Prompt-injection-induced exfiltration | Model output steers a tool argument | `agent.ts:261-265` returns tool output verbatim to the model; no output filtering | **VERIFIED pathway; see §13** |

### 8.3 Trust-boundary statement for P3-B

**P3-B must create a new trust boundary that does not currently exist** — between "capability
authorized to run" (TB-3, governed) and "bytes leave the process" (TB-5/TB-6, ungoverned). It is not
hardening an existing boundary; it is **introducing** one. That is why B-2 (no identity at the seam) is
a blocker rather than an inconvenience: **there is no existing decision point to extend.**

---

## 9. AUTHENTICATION AND IDENTITY PROPAGATION (scope B)

### 9.1 Measured authentication surface

| Item | Evidence | Class |
|---|---|---|
| Auth modes | `auth-config.ts:50` — `CliAuthMode = 'none' \| 'static-token' \| 'oidc' \| 'test-only'` | **VERIFIED** |
| Default mode | `.env.example:63` — `JATAQI_AUTH_MODE=none` | **VERIFIED** |
| `none` semantics | `.env.example:54-56` — *"No authenticator is registered. Every authenticated ingress request fails closed. This is deliberate: an unconfigured process must not silently trust anything."* | **VERIFIED — fail-closed by design** |
| OIDC implemented **and wired** | `bootstrap.ts:70,:84,:336,:352` — `OidcAuthenticator.create(...)` | **VERIFIED / IMPLEMENTED** |
| JWKS fetch governed | `jwt.ts:229` scheme check; `:235` `redirect:'error'`; fetch once (`:16,:81,:203`) | **VERIFIED / IMPLEMENTED** |

### 9.2 Documentation drift (refined from prior context, now freshly measured)

`.env.example` documents the mode table at `:54` (`none`), `:57` (`static-token`), `:60`
(`test-only`) — **`oidc` is absent from the mode table**, despite being a valid `CliAuthMode`
(`auth-config.ts:50`) and genuinely constructed (`bootstrap.ts:352`). Its only appearance is
`.env.example:105`: *"Production identity (OIDC/mTLS) is P2 scope."*

| Field | Value |
|---|---|
| **Class** | **DOCUMENTATION DEFECT (drift)** |
| Expected | `.env.example` mode table lists all four implemented modes |
| Observed | Three listed; `oidc` described as *future* P2 scope while already implemented and wired |
| Consequence | An operator following the example cannot discover that production OIDC is available — **pushing operators toward `static-token` or leaving `none`** |
| Severity | **MEDIUM** (operational, not a direct vulnerability) |
| Remediation | **NOT performed by this audit** |

### 9.3 Identity propagation to the egress seam — the gap

**Measured: identity does not reach N-1 or N-2.** `LLMRequest` (`llm.ts:18-24`) has **5** fields and
**0** identity fields (B-2). There is no `AsyncLocalStorage`, no `async_hooks`, no context object, and
no correlation identifier anywhere in `packages/`.

**[D-4 corrected]** This is a **seam gap, not a system-wide identity gap.** The authorization envelope
upstream **does** carry principal, tenant, agent, run, and correlation identity
(`agent.ts:132-135` resolves `auth?.runId` / `auth?.correlationId` / `auth?.agentId`; `:138-140`
fail-closes with `MISSING_PRINCIPAL` when no verified principal exists). The identity is simply
**not carried the final hop** into `LLMRequest` or the embedding interface. **Consequence for P3-B
design:** the required work is **extending an existing identity to a new call site**, not
**constructing an identity model** — a materially smaller problem than the raw "no identity" reading
implies, though still cross-package (§19.4).

**Consequence for P3-B:** any per-principal, per-tenant egress policy is **unenforceable at the seam
today**. The identity-propagation work is a **prerequisite**, not a P3-B sub-task.

### 9.4 Absent authentication/authorization paradigms (measured, not assumed)

Word-boundary search across `packages/*/src`:

| Paradigm | Hits | Where | Class |
|---|---|---|---|
| **SAML** | **1** | `authentication/src/contracts.ts:5` — a **comment** listing out-of-scope concerns (*"OIDC, OAuth, SSO, SAML, MFA, enrollment, account recovery, deprovisioning,"*) | **DOCUMENTED ONLY — NOT IMPLEMENTED** |
| **ReBAC** | **1** | `contracts.ts:6` — same comment (*"privileged identity management, and ReBAC/PAM. Nothing in this file…"*) | **DOCUMENTED ONLY — NOT IMPLEMENTED** |
| **PAM** | **1** | `contracts.ts:6` — same comment | **DOCUMENTED ONLY — NOT IMPLEMENTED** |
| **ABAC** | **0** | — | **ABSENT** |

**This is a positive governance signal, recorded deliberately:** `contracts.ts:5-6` *explicitly
declares* these out of scope rather than implying support. **No overclaim exists.** The finding is
that P3-B's authorization design must not presume attribute-, relationship-, or privileged-access
machinery — **only capability manifests and the closed denial-reason vocabulary exist.**

---

## 10. AUTHORIZATION MODEL AND EGRESS CONTROLS (scopes C and D)

### 10.1 What the authorization model is (measured)

**Capability-based, manifest-driven, with a closed denial vocabulary.** It is **not** RBAC-only,
**not** ABAC, **not** ReBAC, and **not** PAM.

| Property | Evidence |
|---|---|
| Closed denial vocabulary | `types.ts` `A01DenialReason` — **80** distinct codes |
| Egress-specific denial codes | **0** (`EGRESS` count in `types.ts` = 0) |
| Manifest validation | `capability-manifests.ts:30-127` strict registration checks |
| Monotonic narrowing | `:130-190` — refuses widening/raising (B-1) |
| Immutable versions | `:196-215` |
| Destination matching | `targetMatches` `:267-284`, consumed by PDP at `policy-engine.ts:304` (B-3) |
| Replay protection | `gate.ts:407-408` — non-`READ` consumed once; **`READ` repeatable** (F-3/T-10) |
| Fail-closed defaults in envelope | `agent.ts` `renderToolEnvelope` defaults `impact:'EXTERNAL_SIDE_EFFECT'`, `dataClassification:'INTERNAL'`; no gate ⇒ throw |

**Strength recorded:** fail-closed defaults mean an *undeclared* tool is treated as the **most
dangerous** class, not the least. This is the correct polarity and should be preserved by P3-B.

### 10.2 Egress control requirements P3-B must satisfy (derived from measured gaps)

| Req | Requirement | Gap it closes | Currently present? |
|---|---|---|---|
| **R-01** | **Deny-by-default** destination allowlist; no destination ⇒ no egress | §5.1 (0 egress concept) | **NO** |
| **R-02** | **Hostname-boundary-exact** matching; reject suffix confusion. **[D-1]** Must be satisfied in **BOTH** `targetMatches` and `delegationTargetMatches`, or the two must be deliberately de-coupled and their "mirrors exactly" contract corrected | B-3 / T-04 / T-16 | **NO** (both matchers vulnerable) |
| **R-03** | **URL normalization before comparison** (reject/resolve dot-segments) — **[D-1]** at both sites | T-06 | **NO** (`new URL(` used once, for a PG DSN) |
| **R-17** | **[D-1, newly added]** If the two matcher implementations are kept, their **intended identity invariant must be enforced by a test** rather than by a code comment, so they cannot silently diverge during remediation | D-1 / `delegation-types.ts:381,:404-409` | **NO** — equivalence is asserted only in comments; 0 test occurrences of `.join('.*')` |
| **R-04** | **Scheme allowlist** limited to `https` (and `http` only in explicit dev posture) | T-08 (defence in depth) | **PARTIAL** — `jwt.ts:229` only, N-3 |
| **R-05** | **Redirect policy**: refuse by default (`redirect:'error'`), or re-authorize **every** hop | F-4 / T-01 | **NO** on N-1/N-2; **YES** on N-3 |
| **R-06** | **Per-hop body-forwarding control** (block 307/308 body re-send) | T-02 | **NO** |
| **R-07** | **Private/loopback/link-local/metadata IP refusal** after resolution | T-07 / T-09 | **NO** (0 hits for all range terms, §5.4) |
| **R-08** | **DNS-resolution pinning** (resolve once, connect to the resolved IP, re-check on every hop) to defeat rebinding | T-09 | **NO** |
| **R-09** | **Mandatory deadline** on every outbound call | N-2 has no `signal` at all | **PARTIAL** — N-1 caller-supplied only |
| **R-10** | **Identity-bound decision** (principal, tenant, agent, run) at the seam | B-2 | **NO** |
| **R-11** | **Egress audit record** with destination, scheme, port, resolved IP, hop count, byte count, status, deadline outcome | B-5 / F-7 | **NO** — closed field set lacks all of these |
| **R-12** | **Closed egress denial vocabulary** added to `A01DenialReason` | §10.1 (0 `EGRESS_*`) | **NO** |
| **R-13** | **Fail-closed on policy-store unavailability** (mirroring `AUDIT_UNAVAILABLE`) | K | **NO** for egress |
| **R-14** | **Credential scoping**: egress credential delivered from the governed P2 secret seam, not bare `process.env` | B-4 / TA-1 | **NO** — `SecretPurpose` has no egress purpose |
| **R-15** | **Rate/volume ceiling per destination** | T-10 unbounded repeat | **PARTIAL** — PDP has budget/rate checks, but not per-destination egress |
| **R-16** | **Static ban** on ungoverned `fetch` in product source, with test exemptions | Prevents regression | **NO** for `fetch`; precedent exists for storage (`eslint.config.mjs:63,:135,:140,:145`) |

### 10.3 Requirements that collide with existing tested invariants (must be designed around)

| Req | Collision | Owner decision |
|---|---|---|
| **R-01/R-02** if expressed as `allowedTargets` entries | **B-1** — adding targets is rejected at `:140` | **OD-1** |
| **R-10** | **B-2** — no identity exists to bind | **OD-3** |
| **R-02/R-03** if reusing `targetMatches` | **B-3** — matcher is unsafe | **OD-4** |
| **R-11** | **B-5** — audit field set is closed at `audit.ts:29` | **OD-6** |
| **R-14** | **B-4** — `SecretPurpose` is a closed 3-value set | **OD-7** |
| Correcting F-3's impact ceiling | **B-1** — raising `maxImpact` rejected at `:164-165` | **OD-5** |

**This table is the single most important output of the audit.** Five of seventeen egress requirements
cannot be implemented as scoped without either a new data model or a change to a tested P2 invariant.

### 10.4 Revocation and policy integrity (scope C)

| Property | Evidence | Class |
|---|---|---|
| Manifest versions immutable once registered | `capability-manifests.ts:196-215` | **VERIFIED / IMPLEMENTED** |
| Narrowing-only evolution | `:130-190`, enforced `:213` | **VERIFIED / IMPLEMENTED** |
| Static-token revocation ⇒ next authentication DENY | `P2_S1_VERIFICATION_REPORT.md:176` (A-03 gate) | **DOCUMENTED** — not executed here |
| Durable role revocation across two decisions | `P2_S1_VERIFICATION_REPORT.md:176` (A-11 gate) | **DOCUMENTED** — not executed here |
| Wrong `iss`/`aud` denies **before** any store read | `P2_S1_VERIFICATION_REPORT.md:176` (A-15, asserted with a store-read counter) | **DOCUMENTED** — not executed here |
| **Egress-credential revocation** | **no mechanism** | **ABSENT** — a P3-B requirement not yet enumerated in P3-A |

**New finding (F-13):** there is **no revocation path for an egress credential**. `OPENAI_API_KEY` is
read from `process.env` at construction (`openai.ts:41`, `embeddings.ts:91`) with no rotation,
revocation, or expiry hook. **Class: VERIFIED ABSENT. Severity: MEDIUM.** Consequence: P3-B cannot
claim governed credential lifecycle unless it adds one — and B-4 blocks using the P2 seam for it.

### 10.5 Four-layer authorization posture (as documented vs measured)

`docs/A01_AUTHORIZATION_BOUNDARY.md` describes the PDP, closed denial codes, `executeAuthorized`, and
the credential flow. **Measured reality matches for layers 1-4 as they concern capability execution.**
The layer that P3-B would add — **egress destination authorization** — **does not exist in either the
document or the code.** Class: **DOCUMENTED + IMPLEMENTED for existing layers; ABSENT for egress.**

### 10.6 DNS and address-family controls

**Measured absent.** 0 hits for `isPrivate`, `link-local`, `169.254`, `loopback`, `rfc1918`,
`192.168`, `10.0.0.0` in `packages/*/src`. No resolver wrapper, no `dns` module usage, no
address-family check. **Consequence:** R-07 and R-08 must be built from nothing, and any IP-based
check that resolves-then-connects non-atomically will be **rebinding-vulnerable** unless R-08's
pinning is implemented.

---

## 11. AGENT AND TOOL SECURITY (scope E)

### 11.1 Measured strengths

| Control | Evidence | Class |
|---|---|---|
| Tool-loop bound | `agent.ts:93` `this.maxIterations = cfg.maxIterations ?? 8`; applied `:203` | **VERIFIED / IMPLEMENTED** |
| Envelope built from verified principal + declaration only | `agent.ts` `renderToolEnvelope`; model output cannot author authority | **VERIFIED / IMPLEMENTED** |
| Fail-closed envelope defaults | `impact:'EXTERNAL_SIDE_EFFECT'`, `dataClassification:'INTERNAL'`; missing gate ⇒ throw | **VERIFIED / IMPLEMENTED** |
| No post-decision target substitution | `tools.ts:216-241` — the **same** derived `targetResource` is passed to both `assertEnvelope` and `executeAuthorized` | **VERIFIED / IMPLEMENTED** |
| Injected fetcher for hermetic tests | `openai.ts:42`, `embeddings.ts:93`, `jwt.ts:89` | **VERIFIED / IMPLEMENTED** |
| Missing credential fails closed | `openai.ts:48`, `embeddings.ts:104` throw rather than proceeding unauthenticated | **VERIFIED / IMPLEMENTED** |

### 11.2 Input validation — measured deficiency

`packages/agent-runtime/src/tools.ts` `validateInput` performs **required-key presence checking
only**. Measured absent: type validation, range validation, format validation, length bound, content
validation, encoding normalization.

| Field | Value |
|---|---|
| **Class** | **VERIFIED DEFECT** (new finding **F-14**) |
| Expected | Tool arguments validated against a schema before execution |
| Observed | Presence-only |
| Consequence | Model-supplied `query` (`builtins.ts:227`) reaches `embeddings.ts:109` **unvalidated and unbounded** — enabling oversized payloads, injection-shaped content, and unbounded repeat transmission (compounding F-3/T-10/T-11) |
| Severity | **MEDIUM-HIGH** in combination with F-3; **MEDIUM** alone |
| Remediation | **NOT performed** |

### 11.3 Tool-output handling

`agent.ts:261-265` pushes the tool result into the message history **verbatim**:
`content: JSON.stringify(res.error ? { error: res.error } : res.output)` with `role:'tool'`.
**No sanitization, no truncation, no markup neutralization.** This is the ingestion point for indirect
prompt injection (§13).

### 11.4 Egress-relevant tool inventory

Only **one** built-in tool causes external transmission as measured: **`vector.search`**
(`builtins.ts:210-229`) via the embedding model. The LLM completion path (N-1) is not a *tool* — it is
the runtime itself, which means **it is invoked on every agent turn regardless of tool
authorization**. **That is a material scoping fact for P3-B:** governing tools alone would leave N-1
ungoverned.

---

## 12. TENANT ISOLATION (scope F)

| Control | Evidence | Class |
|---|---|---|
| Tenant scoping at the **module** boundary | `vector-module.ts:139-155` `scopeOptions(indexName, op, opts)` — throws `TenantContextError` when `tenantId` is missing/blank/non-string; filters `metadata.tenantId !== tenantId` | **VERIFIED / IMPLEMENTED** |
| RLS setting name | `tenant-isolation.ts:55` `TENANT_RLS_SETTING = 'app.tenant_id'` | **VERIFIED** |
| RLS enabled per table | `tenant-isolation.ts:108` `ALTER TABLE … ENABLE ROW LEVEL SECURITY` | **VERIFIED** |
| **FORCE** RLS, fail-closed | `tenant-isolation.ts:138-140` `ALTER TABLE … FORCE ROW LEVEL SECURITY`, error message *"Failed to FORCE ROW LEVEL SECURITY on … (fail-closed)"* | **VERIFIED / IMPLEMENTED** |
| Per-transaction `SET LOCAL` | `tenant-isolation.ts` (per-tx setting) + `rls-probe.ts` | **VERIFIED** (source) — **UNVERIFIED at runtime** (no PostgreSQL available; §21.1) |
| Tenant derived server-side; forged claim ignored | `P2_S1_VERIFICATION_REPORT.md:176` (A-06 gate) | **DOCUMENTED** — not executed here |

### 12.1 Tenant-isolation finding on the egress path (new, **F-15**)

**Tenant scoping is enforced on the way IN to the vector index, but not on the way OUT to the network.**
`scopeOptions` correctly refuses a blank tenant (`vector-module.ts:141-143`) — yet the **embedding call
that precedes/follows scoping transmits the tenant's text to an external provider with no tenant
attribution in the request, no destination record, and no per-tenant egress policy** (B-2, F-3).

| Field | Value |
|---|---|
| **Class** | **VERIFIED DEFECT** |
| Consequence | **Cross-tenant data-egress attribution is impossible.** If two tenants' queries are embedded through the same process, the provider sees both under one credential; the audit trail distinguishes neither destination nor tenant for the transmission |
| Severity | **HIGH** for a multi-tenant product |
| P3-B implication | R-10/R-11 must carry **tenantId** into the egress decision and record, or multi-tenant egress governance is unachievable |
| Remediation | **NOT performed** |

### 12.2 Isolation of compute between tenants

**No process, container, or worker isolation exists between tenants** (§14). Isolation is **logical**
(RLS + application scoping) only. **Class: VERIFIED.** This is a legitimate design choice, but it means
**a single process compromise exposes every tenant's egress path** — which raises the value of R-01/R-11.

---

## 13. PROMPT-INJECTION RESISTANCE (scope G)

| Property | Measured status | Class |
|---|---|---|
| Model output can author authority | **NO** — envelope built from verified principal + tool declaration (`agent.ts`) | **VERIFIED (strong)** |
| Model output can influence **tool arguments** | **YES** — `builtins.ts:227` `String(input.query)` | **VERIFIED** |
| Tool arguments validated | **NO** — presence-only (§11.2) | **VERIFIED DEFECT (F-14)** |
| Tool output sanitized before re-entering context | **NO** — verbatim `agent.ts:261-265` | **VERIFIED DEFECT (F-16)** |
| Injection can cause **external transmission** | **YES** — via `vector.search` → `embeddings.ts:109` | **VERIFIED PATHWAY (T-14)** |
| Injection can cause **arbitrary-destination** transmission | **NOT today** — no destination is model-controllable; operator never sets an endpoint (§5.3) | **REFUTED for current state** |

**Balanced conclusion, stated to avoid inflation:** the **most dangerous** injection outcome —
model-chosen destination — is **not available today**, because the endpoint is not model-controllable
and is not even operator-configurable through `bootstrap.ts`. What **is** available is
**model-chosen payload content** reaching an external provider under an understated authorization
record (F-3 + F-14). **P3-B must not regress this:** if P3-B introduces any model- or tool-influenced
destination field, it converts a MEDIUM injection surface into a CRITICAL one. Recorded as design
constraint **DC-1** (§19).

---

## 14. SANDBOX AND EXECUTION ISOLATION (scope H)

**Measured: none exists, and none is claimed.**

Full sweep of `packages/*/src` (§5.4) returned **0 hits** for `docker`, `containerd`, `gVisor`,
`firecracker`, `seccomp`, `cgroup`, `child_process`, `worker_threads`, `node:vm`, `eval(`,
`new Function`, `chroot`, `unshare`. The **3** `namespace(` hits are the **storage** namespace API
(`knowledge-module.ts:41`, `storage-module.ts:69,:102`), **not** OS namespaces — recorded explicitly so
the count is not misread as partial sandboxing.

| Field | Value |
|---|---|
| **Class** | **VERIFIED ABSENT** |
| Positive finding | **No dynamic code execution** (`eval`, `new Function`, `node:vm`) exists in product source — **a genuinely strong property**; tool code cannot be synthesized at runtime |
| Consequence | All tenant workloads share one process and one credential (§12.2). **Egress allowlisting at the application layer is therefore the ONLY barrier** (§20.3 confirms no network-layer control) |
| P3-B implication | R-01/R-02/R-07/R-08 must be treated as **primary** controls, not defence-in-depth |
| Test-harness note | `child_process` (**19**), `spawn(` (**9**), `node:net` (**5**) appear in tests/scripts — **0 in `src`**. Harness-only; not a product isolation mechanism |

---

## 15. SECRETS MANAGEMENT (scope I)

### 15.1 The governed secret seam (strong)

| Property | Evidence | Class |
|---|---|---|
| Closed purpose vocabulary | `secret-material.ts:64` `SecretPurpose = 'totp' \| 'break-glass-seal' \| 'session-assertion'`; `:66-70` `RECOGNIZED_SECRET_PURPOSES` frozen | **VERIFIED / IMPLEMENTED** |
| Unknown purpose refused | `secret-material.ts:298-300` — `if (!isSecretPurpose(input.purpose)) throw new SecretMaterialError('SECRET_INVALID_ARGUMENT')` | **VERIFIED / IMPLEMENTED — fail-closed** |
| Secret status lifecycle | `secret-material.ts:72` `SecretStatus = 'ACTIVE' \| 'RETIRED' \| 'REVOKED'` | **VERIFIED** |
| Closed schema + material refusal + insert-once | `P2_S1_VERIFICATION_REPORT.md:176` (A-22 gate) | **DOCUMENTED** — not executed here |

### 15.2 The ungoverned provider credential (**B-4**, confirmed)

| Field | Value |
|---|---|
| **Class** | **VERIFIED DEFECT-BLOCKER for R-14** |
| Measured path | `config.ts:14` (type), `:99` (`process.env.OPENAI_API_KEY`) → `bootstrap.ts:574-575` (LLM), `:591-592` (embeddings) → `openai.ts:41` / `embeddings.ts:91` (`cfg.apiKey ?? process.env.OPENAI_API_KEY ?? ''`) → bearer header `openai.ts:76` / `embeddings.ts:113` |
| Expected | A production secret is delivered through the governed seam with a declared purpose, status lifecycle, and revocation |
| Observed | **Bare `process.env` read.** `SecretPurpose` has **no** provider/egress value, so the seam **cannot** carry it without extending a tested closed set |
| Consequence | The credential that authorizes **all** external transmission sits entirely outside P2's secret governance: **no purpose, no status, no rotation, no revocation** (compounds F-13) |
| Severity | **HIGH** |
| Remediation | **NOT performed.** Extending `SecretPurpose` is a P2-contract change requiring separate authorization |

---

## 16. AUDIT AND FORENSICS (scope J)

### 16.1 Measured audit architecture

| Property | Evidence | Class |
|---|---|---|
| Closed audit field set | `audit.ts:29` `ALLOWED_AUDIT_FIELDS: ReadonlySet<string>` | **VERIFIED / IMPLEMENTED** |
| Shape assertion | `audit.ts:87` `assertAllowedAuditShape(record, context)` | **VERIFIED / IMPLEMENTED** |
| Audit unavailable ⇒ decision denied | `AUDIT_UNAVAILABLE` denial reason | **DOCUMENTED + IMPLEMENTED** (not executed here) |
| Durable-write failure latches gate closed | A-01 §6 | **DOCUMENTED** |

**Strength recorded:** a closed field set with shape assertion is a **strong anti-tamper property** —
it prevents arbitrary field smuggling into the audit trail. **This is precisely why B-5 is a blocker
rather than a trivial addition.**

### 16.2 **B-5** — no egress-capable audit field exists (confirmed)

Field-by-field search of `A01AuditRecord` in `packages/authorization-boundary/src/types.ts`:

| Field | `readonly <field>` occurrences | Field | Occurrences |
|---|---|---|---|
| `destination` | **0** | `redirect` | **0** |
| `resolvedIp` | **0** | `hopCount` | **0** |
| `scheme` | **0** | `byteCount` | **0** |
| `port` | **0** | `deadline` | **0** |
| `method` | **0** | `status` | **0** |

The only resource-ish field is `targetResource?` (`types.ts:543`) — an **authorization target string**,
not a network destination, and **optional**.

| Field | Value |
|---|---|
| **Class** | **VERIFIED DEFECT-BLOCKER for R-11** |
| Consequence | **Even if P3-B implemented a perfect egress decision, it could not record the destination, the resolved IP, the hop count, the byte count, or the outcome.** R-11 is unimplementable without extending the closed field set at `audit.ts:29` — a tested P2 contract |
| Forensic impact | An exfiltration via T-01/T-02 would leave **no trace distinguishing it from normal operation** |
| Severity | **HIGH** |
| Remediation | **NOT performed** |

**Design note:** the correct resolution is likely a **separate egress-audit record type** rather than
widening `A01AuditRecord`, preserving the existing closed set's anti-smuggling property. Owner
decision **OD-6**.

---

## 17. FAIL-CLOSED BEHAVIOUR (scope K)

| Property | Evidence | Class |
|---|---|---|
| Unrecognized security posture ⇒ throw | `security-posture.ts:74` `resolveSecurityPosture`; `:80` *"`JATAQI_SECURITY_POSTURE="…" is not recognized; expected "production" or "development" (fail-closed)."* | **VERIFIED / IMPLEMENTED** |
| Invariant set | `security-posture.ts` — **INV-01…INV-12, INV-14, INV-15, INV-16** present (**INV-13 not present in this file**) | **VERIFIED (partial enumeration)** |
| Boot canary must render DENY | `security-posture.ts:186-199` — `P1_BOOT_CANARY_TENANT = 'p1-canary'` (:186), `P1_BOOT_CANARY_CAPABILITY = 'p1.boot-canary'` (:188), decision constructed :194-199 | **VERIFIED / IMPLEMENTED** |
| Unconfigured auth ⇒ all ingress denied | `.env.example:54-56` | **VERIFIED / DOCUMENTED** |
| Missing provider key ⇒ throw | `openai.ts:48`, `embeddings.ts:104` | **VERIFIED / IMPLEMENTED** |
| Missing tenant ⇒ throw | `vector-module.ts:141-143` | **VERIFIED / IMPLEMENTED** |
| RLS enforcement failure ⇒ fail-closed | `tenant-isolation.ts:138-140` | **VERIFIED / IMPLEMENTED** |
| **Egress policy unavailable ⇒ ?** | **no egress policy exists** | **ABSENT — R-13 required** |
| **Identity context absent ⇒ ?** | **no context mechanism exists** | **ABSENT — must be designed fail-closed (T-13)** |

**Assessment:** the codebase has a **consistently correct fail-closed polarity** across every
measured control. **This is the strongest overall property found in this audit** and materially raises
confidence that P3-B, if properly designed, would follow the same discipline. **The two absent rows
are exactly the two P3-B prerequisites.**

**Note on INV-13:** its absence from `security-posture.ts` is recorded as a **measurement
observation only**. This audit did **not** establish whether INV-13 is defined elsewhere, renumbered,
or intentionally absent, and makes **no claim** either way. Class: **UNKNOWN.**

---

## 18. SUPPLY CHAIN AND CI (scope L)

| Property | Evidence | Class |
|---|---|---|
| CI workflow | `.github/workflows/ci.yml` | **VERIFIED** |
| Least-privilege `permissions:` block | `ci.yml:21` | **VERIFIED — present** |
| Pinned actions | `actions/checkout@v4` (`:35`), `actions/setup-node@v4` (`:38`) — **tag-pinned, not SHA-pinned** | **PARTIAL** |
| Node version | `ci.yml:40` — `'20'` | **VERIFIED** (⇒ probe non-parity, §21.2) |
| Reproducible install | `ci.yml:44` — `npm ci --no-audit --no-fund` | **VERIFIED** |
| Workspace/lockfile integrity gate | `ci.yml:47` `npm run check:workspaces` → `scripts/check-workspace-lockfile.mjs` (`package.json:10`); also `prebuild` (`:11`) and `pretest` (`:13`) | **VERIFIED — strong: integrity checked before build AND test** |
| CI status on audited SHA | run **`35308789086`**, head `6b61256`, conclusion **`success`** | **VERIFIED** |
| Advisory audit | **disabled** (`--no-audit`) | **DEFECT (F-17), MEDIUM** |
| Dependency pinning depth | not measured beyond lockfile presence | **UNKNOWN** |
| SBOM / provenance attestation | not found in `ci.yml` | **UNVERIFIED / likely ABSENT** |

**F-17 detail:** `npm ci --no-audit` means **no advisory scanning occurs in CI**. Combined with 50
workspaces (§19.4), a vulnerable transitive dependency would not be flagged by the pipeline.
**Class: VERIFIED DEFECT. Severity: MEDIUM.** **Not remediated by this audit.**

### 18.1 Governance controls (read-only read-back, agent capability tested)

| Control | Observed | Class |
|---|---|---|
| Ruleset | id **`20134880`**, name *"Jata Qi"*, target `branch`, enforcement **`active`**, `current_user_can_bypass` = **`never`** | **VERIFIED** |
| Rules present | `deletion`, `pull_request`, `required_status_checks` | **VERIFIED** |
| **`non_fast_forward` (force-push protection)** | **ABSENT from the rule list** | **VERIFIED DEFECT (F-12), HIGH** — corroborates `PM-06` |
| Required check | context **`build · lint · test`**, integration `15368` | **VERIFIED** |
| Approvals required | **1** | **VERIFIED** |
| Review-thread resolution required | **true** | **VERIFIED** |
| **Stale-review dismissal** | **`false`** | **VERIFIED DEFECT (hardening)** — corroborates `PM-07` |
| **Last-push approval** | **`false`** | **VERIFIED DEFECT (hardening)** — corroborates `PM-07` |
| Code-owner review | **`false`** | **VERIFIED (hardening gap)** |
| Allowed merge methods | `merge`, `squash`, `rebase` — **all three** | **VERIFIED** |
| Classic branch-protection API | **HTTP 403 "Resource not accessible by integration"** | **VERIFIED — the agent cannot read or modify classic protection; ruleset API is the working path** |

**F-12 consequence for P3-B:** without `non_fast_forward`, history on a protected branch can be
rewritten, which undermines the **blob-SHA continuity method this very audit relies on** (§7.7).
**Class: VERIFIED DEFECT. Severity: HIGH (governance).** **Not remediated — ruleset changes are
explicitly out of scope.**

---

## 19. OWNER DECISIONS REQUIRED BEFORE P3-B CAN BE AUTHORIZED

### 19.1 Blocking decisions

| ID | Decision | Options | Consequence of deferral |
|---|---|---|---|
| **OD-1** | How are permitted egress destinations represented, given `isNarrowing` forbids adding `allowedTargets` (`:140`)? | (a) **new** destination-policy model outside manifests; (b) authorized change to `isNarrowing` | **P3-B cannot be implemented.** (b) weakens a tested P2 control |
| **OD-2** | Where does the destination value come from, given the operator never supplies an endpoint (§5.3)? | (a) add operator endpoint config; (b) hardcode per-provider allowlist; (c) derive from adapter default | Without (a) or (b), R-01 has nothing to enforce against |
| **OD-3** | Identity propagation architecture | (a) explicit threading through `LLMRequest`/embedding interfaces; (b) `AsyncLocalStorage` with **fail-closed on absent context** | **P3-B cannot decide per-principal.** (b) has zero codebase precedent |
| **OD-4** | Is B-3 remediated **before** P3-B or **inside** it? **[D-1]** The decision now covers **BOTH** `capability-manifests.ts:267` `targetMatches` **AND** `delegation-types.ts:385` `delegationTargetMatches`, whose regex bodies are byte-identical and which are documented as semantically equivalent (`:381` *"mirrors … exactly"*, `:408` *"MUST stay identical"*) | (a) separate change across **both** packages first; (b) inside P3-B with dedicated tests at **both** sites; (c) unify into one shared matcher and delete the duplicate | Bundling makes a P3 slice modify tested P2 matchers without separate review. **Fixing only one site leaves the other reachable AND silently breaks the declared identity invariant, diverging capability-path from delegation-path authorization behaviour** |
| **OD-5** | Is F-3 (impact-ceiling correction) a separate remediation? | (a) separate slice; (b) accept the mischaracterization | Collides with B-1 (`:164-165`) if attempted inside P3-B |
| **OD-6** | Egress audit record: widen the closed `ALLOWED_AUDIT_FIELDS` (`audit.ts:29`) or introduce a **separate** egress record type? | (a) widen; (b) separate type | (a) weakens the anti-smuggling property; (b) preserves it |
| **OD-7** | Is `SecretPurpose` (`secret-material.ts:64-70`) extended with an egress purpose? | (a) extend (P2 contract change); (b) leave provider key ungoverned and accept TA-1 | (b) leaves R-14 unsatisfied and F-13 open |

### 19.2 Design constraints this audit derives (not decisions — invariants P3-B must respect)

| ID | Constraint | Source |
|---|---|---|
| **DC-1** | **No destination may become model- or tool-influenced.** Today no destination is model-controllable (§13); introducing one converts a MEDIUM injection surface into CRITICAL | §13, T-14 |
| **DC-2** | **Fail-closed polarity must be preserved.** Every measured control denies on ambiguity; egress must do the same, including on **absent identity context** and **unavailable policy store** | §17, R-13, T-13 |
| **DC-3** | **`isNarrowing` must not be weakened** as a side effect of P3-B | §7.1 |
| **DC-4** | **The closed audit field set's anti-smuggling property must survive** | §16.1, OD-6 |
| **DC-5** | **N-3's precedent must be the floor, not the ceiling**: scheme restriction + `redirect:'error'` + fetch-once + injectable fetcher | §5.2 |
| **DC-6** | **N-1 must be governed even though it is not a tool** — it runs every agent turn (§11.4) | §11.4 |
| **DC-7** | **A static ban on ungoverned `fetch` in product source** should accompany P3-B, following the existing storage precedent (`eslint.config.mjs:63,:135,:140,:145`) | R-16 |

### 19.3 Requirements-to-blocker matrix (implementation-readiness view)

| Req | Blocked by | Resolvable without weakening a tested control? |
|---|---|---|
| R-01, R-02 | **B-1**, **B-3** | ✅ if a **new** destination model is used (OD-1a) and **both** matchers are fixed (OD-4, **[D-1]**) |
| R-17 | — | ✅ pure addition; **[D-1]** requires a test asserting the two matcher implementations stay equivalent (or an explicit, verified de-coupling) |
| R-03…R-09 | — | ✅ pure addition, no collision |
| **R-10** | **B-2** | ⚠️ requires architectural change (OD-3) |
| **R-11** | **B-5** | ✅ via a **separate** record type (OD-6b) |
| R-12, R-13, R-15, R-16 | — | ✅ pure addition |
| **R-14** | **B-4** | ⚠️ requires a P2 contract change (OD-7) |

**Read: 5 of 17 requirements are blocked (R-01, R-02, R-10, R-11, R-14); 12 are implementable
without collision.** **[D-1 correction side-effect]** The denominator rose from 16 to 17 because R-17
was added. The numerator is also corrected here: an earlier revision of this document said *"4 of 16"*
in this section while §10.3 said *"Five of sixteen"* — the matrix has always listed **five** blocked
requirements, so **"4" was an internal arithmetic error** and is now reconciled to **5 of 17**
throughout. This is the
quantified basis for recommending a **bounded P3-B₀ design phase** rather than either abandoning P3-B
or authorizing implementation as scoped.

### 19.4 Scale context (for effort realism)

| Metric | Measured |
|---|---|
| Workspaces | **50** (`packages/*/`) |
| Test files | **169** (`packages/**/test/*.test.ts`) |
| `authorization-boundary/src` lines | **8,005** |
| `A01DenialReason` codes | **80** |
| CI Node | **20**; local probe Node **22.22.3** |

**Implication:** OD-3 (identity threading) touches `agent-runtime`, `vector-search`, and `cli`
simultaneously, against 169 test files. **Any estimate that treats P3-B as a single-package change is
not supported by this measurement.**

---

## 20. BEHAVIOURAL PROBE METHODOLOGY AND VERBATIM RESULTS

**Location:** `/tmp/p3b-audit-probes/{probe-b3-glob.mjs, probe-f4-redirect.mjs, probe-ssrf-scheme.mjs}`
— **outside the tracked repository, ephemeral, NOT committed** (verified: `git ls-files --others
--exclude-standard` returned 0 at baseline, and no probe path is inside `/home/user/JATA-Qi`).

**Common properties:** runtime **Node v22.22.3**; **no repository mutation**; **no persistent secret
created**; **no external service contacted with a real credential**; no product code imported or
patched. Each probe **re-implements the measured semantics** rather than invoking product code —
necessary because `node_modules`/`dist` are absent (§21.1). **This is a fidelity limitation and is
disclosed as such:** probes demonstrate *what the measured semantics permit*, not *what the shipped
build did on this machine*.

### 20.1 `P3B-PROBE-01` — destination-matcher semantics (B-3)

- **Purpose:** determine whether `targetMatches`' pattern join respects hostname/segment boundaries.
- **Basis:** `capability-manifests.ts:267-284` — pieces joined with **unbounded `.*`**.
- **Method:** reproduce the join exactly; test 6 pattern/resource pairs covering intended allows and
  three bypass classes.
- **Result:** verbatim output reproduced at **§7.3**. **6/6 MATCH**, including
  `https://api.openai.com*` ⇒ `https://api.openai.com.evil.com/steal`.
- **Conclusion:** **hostname-boundary bypass, leading-wildcard host escape, and unnormalized
  dot-segment traversal are all confirmed.** Confidence **HIGH** (semantics directly transcribed).

### 20.2 `P3B-PROBE-02` — redirect and credential-forwarding behaviour (F-4)

- **Purpose:** determine what Node's default `fetch` does on each redirect status when the request
  carries an `Authorization` header and a JSON body — i.e. what N-1/N-2 inherit by setting **no**
  `redirect` option.
- **Method (original run):** local ephemeral listener on `127.0.0.1` (random port per case); origin
  responds with 301/302/303/307/308 pointing at the listener; listener records whether the request
  arrived, whether `Authorization` was present, and the body received. Marker payload
  `TENANT-A-CONFIDENTIAL-CONTEXT` used to detect body forwarding. **The redirect target was on a
  different port, i.e. a CROSS-ORIGIN target** — a property the original write-up did not state and
  which turns out to be decisive.
- **Result (original, cross-origin):** verbatim output reproduced at **§7.5**. All five **followed**;
  `Authorization` **ABSENT** in all five; body **EMPTY** on 301/302/303 and **FULLY FORWARDED** on
  307/308.
- **Methodological defect found during verification:** the original probe exercised **only one**
  origin relationship, so its `Authorization` result could not distinguish "Node strips this header on
  redirect" from "Node strips this header on **cross-origin** redirect." A **same-origin control** was
  therefore added.

**`P3B-PROBE-02b` — same-origin vs cross-origin control, verbatim output** (fresh run during the
D-6 correction, 2026-09-18T07:05:48Z, Node v22.22.3, `/tmp/d6-probe/d6.mjs`, outside the repository
and since deleted):

```
node v22.22.3 | D-6 correction probe | 2026-09-18T07:05:48.942Z

--- CROSS-ORIGIN (port A -> different port B) = attacker/internal-host case ---
  HTTP 301: followed=YES  Authorization=STRIPPED   request-body=empty
  HTTP 302: followed=YES  Authorization=STRIPPED   request-body=empty
  HTTP 303: followed=YES  Authorization=STRIPPED   request-body=empty
  HTTP 307: followed=YES  Authorization=STRIPPED   request-body=FORWARDED
  HTTP 308: followed=YES  Authorization=STRIPPED   request-body=FORWARDED

--- SAME-ORIGIN (path redirect on same host:port) = allowed-origin case ---
  HTTP 301: followed=YES  Authorization=FORWARDED  request-body=empty
  HTTP 302: followed=YES  Authorization=FORWARDED  request-body=empty
  HTTP 303: followed=YES  Authorization=FORWARDED  request-body=empty
  HTTP 307: followed=YES  Authorization=FORWARDED  request-body=FORWARDED
  HTTP 308: followed=YES  Authorization=FORWARDED  request-body=FORWARDED
```

- **Result (control):** the cross-origin arm **reproduces the original run exactly**, confirming the
  original observation was accurate. The same-origin arm shows `Authorization` **FORWARDED on all
  five statuses**. **Redirect-following and 307/308 body forwarding are origin-independent;
  `Authorization` stripping is origin-DEPENDENT.**
- **Conclusion:** traversal + 307/308 body exfiltration **confirmed** (both origin relationships);
  **cross-origin** credential theft **not demonstrated**; **same-origin** credential forwarding
  **demonstrated**. Confidence **HIGH** for observation, **MEDIUM-HIGH** for Node 20 parity (§21.2).
- **Corollary:** the loopback target **was reached**, independently corroborating §20.3.

### 20.3 `P3B-PROBE-03` — scheme and address reachability (T-07, T-08)

- **Purpose:** determine which URL schemes and which address classes are reachable from this process,
  to bound SSRF exploitability honestly.
- **Method:** `fetch` each target; classify outcome as transport failure, DNS failure, or HTTP response.
- **Result (verbatim):**

```
node v22.22.3
file:///etc/passwd
   -> TypeError: fetch failed
gopher://127.0.0.1:25/x
   -> TypeError: fetch failed
ftp://127.0.0.1/x
   -> TypeError: fetch failed
http://127.0.0.1:9/
   -> TypeError: fetch failed
http://169.254.169.254/latest/meta-data/
   -> HTTP 501 (REACHED NETWORK LAYER)
https://api.openai.com.evil.tld/v1
   -> TypeError: fetch failed
```

- **Interpretation, deliberately bounded:**

| Observation | Correct reading | Reading that must NOT be drawn |
|---|---|---|
| `file://`, `gopher://`, `ftp://` all `TypeError` | **Multi-protocol SSRF is NOT exploitable through this transport.** T-08 **refuted** | — |
| `127.0.0.1:9` failed | Discard port 9 had no listener — **not** evidence loopback is blocked | "Loopback is filtered" — **false**; §20.2 reached loopback successfully |
| `169.254.169.254` ⇒ **HTTP 501** | **The link-local metadata address REACHED THE NETWORK LAYER and an HTTP responder answered.** **No network-layer egress control is active in this environment** | ❌ **This was NOT a cloud metadata service.** The 501 came from the **sandbox egress path**. **No metadata credential theft is demonstrated or claimed** |
| `api.openai.com.evil.tld` `TypeError` | Non-existent domain ⇒ DNS failure (expected) | Not evidence of domain allowlisting |

- **Conclusion:** **TA-4 is resolved against the optimistic assumption.** Application-level allowlisting
  is the **only** barrier. Confidence **HIGH** for reachability, and the audit **explicitly declines**
  to escalate T-07 to a metadata-theft claim.

### 20.4 Probe fidelity limits (disclosed)

1. Probes re-implement semantics rather than executing product code (no build available).
2. Node **22** locally vs Node **20** in CI — transport behaviour **may** differ (§21.2).
3. Network observations reflect **this sandbox's** egress path, **not** a production deployment.
4. No probe contacted a real provider with a real credential; **no credential-handling behaviour of
   the shipped adapters was executed.**

---

## 21. LIMITATIONS, ENVIRONMENT DEPENDENCIES, AND EVIDENCE GAPS

### 21.1 No test suite was executed (**material limitation**)

| Item | Status |
|---|---|
| `node_modules` | **absent** — no installation performed |
| `packages/*/dist` | **absent** — no build performed |
| Suites executed | **0 of 169** |
| Reason | Installing dependencies and building would mutate the repository (even in gitignored paths) and was **not authorized**; this is a **documentation-only** task |
| Consequence | Every "IMPLEMENTED" classification in this document rests on **source reading**, not on **observed passing tests**. Documented test gates (A-01…A-26, PM-01…PM-08, INV-01…INV-16) are cited as **DOCUMENTED**, never as executed |
| CI corroboration | CI run **`35308789086`** on `6b61256` ⇒ **`success`** — provides **build/lint/test green** at the audited SHA, but this audit did **not** re-execute anything locally |

**This is recorded so no reader mistakes source-verified claims for execution-verified claims.**

### 21.2 Runtime non-parity (Node 22 vs Node 20)

All probe results were produced on **Node v22.22.3**; CI targets **Node 20** (`ci.yml:40`).
`fetch`/undici redirect and body-forwarding behaviour is **version-sensitive**. **Every transport
finding (§7.5, §20.2, §20.3) therefore carries a non-parity caveat and is NOT presented as
CI-observed behaviour.** The **source** findings (absence of a `redirect` option; absence of any
`signal` at N-2) are **version-independent and remain HIGH confidence** — the caveat applies to the
exact per-status transport outcomes, not to the absence of the control.

### 21.3 The prior external assessment is unavailable (**disclosed**)

A previous assessment existed outside the repository at
`/home/user/assessments/P3_B_PRE_IMPLEMENTATION_SECURITY_ASSESSMENT.md` (~2,777 lines /
~260,563 bytes). **That path no longer exists**; workspace locations outside `/home/user/JATA-Qi`
did not survive the turn boundary.

| Statement | Position |
|---|---|
| Was it reconstructed from memory? | **NO — explicitly refused.** Reconstruction would have manufactured line numbers, blob hashes, and probe output, violating the measurement discipline |
| Are its claims copied here? | **NO.** Prior findings (F-6, F-7, F-11, F-12, etc.) were **re-measured from source** before being restated; where re-measured they are cited with fresh evidence, and where not re-measured they are **omitted entirely** |
| Are the prior size metrics relied upon? | **NO.** They are recorded as **historical context only** and carry **no evidentiary weight** |
| Is this document canonical? | **YES, by construction** — it is committed **inside** the repository, which is the durable location |

**Consequence for continuity:** this document **supersedes** the unavailable external artifact and is
the **sole** canonical P3-B pre-implementation assessment. No prior version can be diffed against it.

### 21.4 Shallow clone

The repository is a **depth-1** clone (§7.7): `git rev-list --count HEAD` = **1**. Historical analysis
beyond the immediately prior baseline is **impossible locally**. `git fetch` was **deliberately not
used**. **Class: ENVIRONMENT LIMITATION.** Mitigation applied: read-only GitHub API blob comparison.

### 21.5 Read-only GitHub access limits

The classic branch-protection API returns **HTTP 403 "Resource not accessible by integration"** (§18.1).
Ruleset data **was** obtainable. **No ruleset or protection setting was modified** — modification is
explicitly unauthorized. **Class: ENVIRONMENT LIMITATION (read path partially restricted).**

### 21.6 Items classified UNKNOWN (no claim made)

| Item | Why unknown |
|---|---|
| **INV-13** | Not present in `security-posture.ts`; whether it is defined elsewhere, renumbered, or intentionally absent was **not established** |
| Dependency pinning depth beyond the lockfile | Not measured |
| SBOM / provenance attestation | Not found in `ci.yml`; **not** proven absent repository-wide |
| Runtime RLS behaviour | Requires PostgreSQL, which is unavailable (§21.1) |
| Node 20 exact redirect behaviour | Requires execution on Node 20 (§21.2) |

### 21.7 Findings from prior context **deliberately omitted**

Prior context referenced F-6, F-7, and F-11 as carried findings. **F-6 and F-7 were re-measured and
are restated here with fresh citations as B-4 (§15.2) and B-5 (§16.2) respectively.** Any prior
finding **not** re-measured in this session is **omitted rather than reproduced**, per the instruction
not to copy unverified claims.

---

## 22. ROLLBACK AND REVERSIBILITY BOUNDARY

**Not applicable to this artifact** — a documentation-only commit is trivially revertible and changes
no runtime behaviour. **But materially applicable to P3-B, and recorded here because it is a
governance risk the owner must accept explicitly:**

| Direction | Consequence |
|---|---|
| **Rolling P3-B FORWARD** | A fail-closed egress plane (R-01, R-13, DC-2) converts a **policy-store or identity-context outage into a total agent outage**: with deny-by-default and no ambient identity, every LLM turn and every embedding call fails. **Availability risk must be accepted deliberately, not discovered in production** |
| **Rolling P3-B BACK** | Reverting re-opens **exactly** the ungoverned paths measured in §5.2 — N-1 and N-2 return to no decision, no allowlist, no redirect policy, no deadline, no audit. **There is no partial state**: rollback restores the current, defect-bearing status quo |
| **Rolling back B-3's fix** | Restores the suffix-confusion bypass (T-04/T-05/T-06) in a matcher the PDP already consumes (`policy-engine.ts:304`) |
| **Rolling back an `isNarrowing` change (if OD-1b were chosen)** | Would leave any manifests registered under the weakened rule in an **inconsistent** state — a further reason to prefer OD-1a |

**Recommendation:** P3-B must be designed with an **explicit, tested degradation mode** and a
**documented rollback runbook** *before* authorization, because rollback is not behaviour-neutral.

---

## 23. DETERMINATION AND AUTHORIZATION GATE

### 23.1 Determination

> **P3-B (Governed Egress Control Plane) is NOT READY TO BE AUTHORIZED AS PREVIOUSLY SCOPED.**
>
> The objective is **sound and necessary**: two credentialed egress seams operate with **no decision,
> no allowlist, no redirect policy, no deadline, and no audit**, and both are **byte-identical to the
> prior baseline** — nothing has been remediated (§5.2, §7.7). The measured defects are real, and one
> (F-3 + T-10) permits **unbounded repeat external transmission of tenant data under an authorization
> record that misdescribes it as an internal READ**.
>
> But **5 of 17 derived egress requirements are blocked** by conditions that are themselves
> **correct, tested P2 controls**: the monotonic-narrowing invariant (**B-1**), the absence of any
> identity at the seam or any ambient-context mechanism (**B-2**), the closed audit field set
> (**B-5**), and the closed secret-purpose vocabulary (**B-4**) — plus an unsafe destination matcher
> (**B-3**) that P3-B would promote to security-critical, and which **[D-1]** exists as **two
> byte-identical implementations in two packages** (`capability-manifests.ts:267` and
> `delegation-types.ts:385`), coupled by a declared "MUST stay identical" invariant — so it cannot be
> fixed at one site alone.
>
> **Authorizing implementation now would force one of three unacceptable outcomes:** (i) the work
> fails its own manifest-registration step; (ii) tested P2 invariants are weakened inside a P3 slice
> without separate review; or (iii) an egress plane ships that cannot record what it decided, because
> the audit schema cannot hold a destination.

### 23.2 Gate conditions (all must be satisfied before P3-B implementation may be authorized)

| # | Gate | Status |
|---|---|---|
| G-1 | OD-1…OD-7 resolved by the owner in a committed design record | **OPEN** |
| G-2 | Identity-propagation architecture chosen and its fail-closed behaviour on absent context specified (DC-2, T-13) | **OPEN** |
| G-3 | B-3 disposition decided (OD-4) and, if remediated first, verified independently | **OPEN** |
| G-4 | Egress audit record design chosen so the closed field set's anti-smuggling property survives (DC-4, OD-6) | **OPEN** |
| G-5 | Degradation mode and rollback runbook documented (DC-2, §22) | **OPEN** |
| G-6 | F-3 disposition decided as a **separate** remediation (OD-5) | **OPEN** |
| G-7 | Independent verification (E4-class) of this document's blockers by a party other than the author | **OPEN — this document is SAME-AGENT and cannot satisfy it** |

### 23.3 Recommended next authorization (decision support only — grants nothing)

**A bounded, documentation-only P3-B₀ design-decision phase** resolving OD-1…OD-7 and DC-1…DC-7,
producing a committed design record with no production-code change. This is the **smallest** step that
unblocks P3-B without weakening any tested control. **It is not authorized by this document.**

### 23.4 Standing governance state (unchanged by this audit)

| Item | State |
|---|---|
| Audited baseline | `6b61256c6115a02da2d3ad6ba42771831b550f81` == `origin/main` |
| Frozen score | **9.484375%** — **unchanged, not recalculated** |
| **P2 E4** | **NOT ACHIEVED — permanently capped** |
| **P3-B implementation** | **NOT AUTHORIZED** |
| **P3-B₀** | **NOT AUTHORIZED** |
| **Production readiness** | **PRODUCTION NOT READY** |
| Remediation performed by this audit | **NONE — zero findings remediated** |
| Remediation performed by revision R2 | **NONE — documentation/evidence correction only (§24.2)** |
| Document revision | **R2** — D-1…D-6 corrected; register strictly **more adverse** than R1 (2 findings added, 1 scope broadened, 1 evidence strengthened, nothing closed) |
| Independent verification of R2 | **STILL REQUIRED** — same-agent correction does not satisfy the separate-party gate (§24.4) |
| Independence of this document | **SAME-AGENT. NOT E4. NOT INDEPENDENT VERIFICATION.** |

---

## 24. CORRECTION RECORD — REVISION R2 (D-1…D-6)

**Authorization:** DOCUMENTATION/EVIDENCE CORRECTION ONLY, granted by the owner 2026-09-18 following
read-only verification of PR #39 at head `30938f3b7b36e27ae72f9239dba93f2ac9b1d988`.

**Evidence discipline applied to this revision:** per the correction authorization, every correction
was **re-derived from repository source before incorporation** — the verification report was treated
as a *lead*, not as evidence. `delegation-types.ts`, `consumption-stores.ts`, `llm.ts`, `agent.ts`,
`capability-manifests.ts`, and both `*POSTMERGE*` records were re-read directly, and the redirect
behaviour was **re-probed** (`P3B-PROBE-02b`, §20.2) rather than quoted from the prior run.

### 24.1 Corrections applied

| ID | Defect | Correction | Class of change |
|---|---|---|---|
| **D-1** | **Material omission (HIGH).** B-3 recorded at one site only | Added **§7.3.1** establishing `delegation-types.ts:385-402` `delegationTargetMatches` as a **second, byte-identical** implementation (diff of the two regex bodies ⇒ identical; repo-wide `.join('.*')` ⇒ exactly 2 sites, 0 in tests), documenting its live consumer (`:439`→`:442-445`), public export (`index.ts:253`), the "mirrors exactly" (`:381`) and "MUST stay identical" (`:408`) invariants, and the four consequences for remediation. Propagated to §1.2, §8.2 (new **T-16**), §10.2 (**R-02/R-03** amended, new **R-17**), §19.1 (**OD-4**), §19.3, §7.8, Appendix A | **Scope correction** — defect already VERIFIED; extent was understated |
| **D-2** | **Omitted evidence.** F-3's repeatability cited two sites | Added **`consumption-stores.ts:75`** — the **durable** store's `if (input.impact === 'READ') return { consumed: false };`, documented as intentional at `:60-61` (*"READ envelopes are never consumed (R1 parity)"*). Recorded that correcting it is a **replay-policy change**, not a code fix. Propagated to §1.5, §7.4, §8.2 (T-10), Appendix A | **Strengthening** — evidence added; no claim weakened |
| **D-3** | **Citation error.** `isNarrowing` typed as returning `boolean` | Corrected to the actual signature `isNarrowing(previous: A01CapabilityManifest, next: A01CapabilityManifest): { ok: boolean; violation?: string }`, with the caller's use of `check.ok` / `check.violation` (`:213-217`) noted | **Precision fix** — substance unaffected |
| **D-4** | **Quantitative error.** `LLMRequest` asserted to have **6** fields including a non-existent *"model/type discriminant"* | Corrected to **5** fields with per-line citation (`llm.ts:18-24`); the invented field is **withdrawn**. All **five** occurrences reconciled (§1.2, §7.2, §7.8, §9.3, Appendix A). Added the required nuance: identity **does** exist upstream (`agent.ts:132-135`, fail-closed `MISSING_PRINCIPAL` at `:138-140`), so B-2 is a **seam/propagation gap**, not a system-wide identity absence | **Precision fix + nuance added** — B-2 conclusion unchanged |
| **D-5** | **Factual error.** `P2_S8_POSTMERGE_VERIFICATION.md` called the *"sole"* post-merge record | Corrected: **two** records exist. Added a table covering `P2_S8_POSTMERGE_VERIFICATION.md` (PR #37 / `08adbd9`) **and** `PR20_MERGE_POSTMERGE_VERIFICATION.md` (PR #20 / `700ae80`), with `grep -c -E '#38\|6b61256'` = **0** for **both**. **F-8 remains UNVERIFIED** — the correction *strengthens* it and does **not** resurrect the withdrawn "8/8 PASS" claim | **Precision fix** — F-8 conclusion unchanged and reinforced |
| **D-6** | **Over-generalization.** "`Authorization` not forwarded" / "stripped in every observed case" stated without an origin qualifier | Replaced with an origin-distinguished measurement table; added probe **`P3B-PROBE-02b`** (§20.2) with verbatim same-origin **and** cross-origin output. **Cross-origin**: `Authorization` STRIPPED on all 5 (T-03 remains **REFUTED**). **Same-origin**: `Authorization` **FORWARDED** on all 5 (new **T-15**). Body forwarding on 307/308 is **origin-independent** (T-02 remains **CONFIRMED**). Consequences restated as **three**, not two. Propagated to §7.5, §8.2, §20.2, Appendix A | **Qualification added** — neither inflated nor deflated |

**Incidental consistency fix (disclosed):** adding **R-17** raised the derived-requirement count from
16 to **17**, and reconciling it exposed a **pre-existing arithmetic inconsistency** — §19.3 and §23.1
said *"4 of 16"* while §10.3 said *"Five of sixteen"*, though the matrix has always listed **five**
blocked requirements (R-01, R-02, R-10, R-11, R-14). All occurrences are now **"5 of 17"**. This was
a documentation error, not a change in technical conclusion.

### 24.2 What this revision does NOT do

- **No security condition was remediated.** B-1, B-2, B-3, F-3, F-4, F-9, T-15, T-16 and every other
  finding remain **OPEN**. `delegation-types.ts` was **not** modified. `consumption-stores.ts` was
  **not** modified. No matcher, manifest, redirect handler, audit schema, secret purpose, or identity
  propagation path was changed.
- **No conclusion was weakened to remove a discrepancy.** D-1 and D-2 **broadened** findings; D-6
  **added** a residual (T-15) while keeping T-03 refuted; D-3/D-4/D-5 corrected precision without
  altering any determination.
- **The determination is unchanged:** P3-B is **NOT READY TO BE AUTHORIZED AS PREVIOUSLY SCOPED**.
- **No test suite was executed** in producing this revision (still 0 of 169). No production behaviour
  was verified. Probe observations are **not** presented as deployment claims (§21.2, §21.4).
- **No line number, SHA, test result, or historical evidence was fabricated.** The one previously
  fabricated element — the non-existent sixth `LLMRequest` field — is **withdrawn** under D-4.

### 24.3 Correction diff scope

**Exactly one tracked file changed** by this revision:
`docs/verification/P3_B_PRE_IMPLEMENTATION_SECURITY_ASSESSMENT.md`. Verified before commit by
`git status --short` and post-commit by `git show --name-only`; zero changes under `packages/`,
`.github/`, `scripts/`, or to any lockfile, config, or schema. The correction commit is a **normal
non-force commit appended to the existing PR #39 branch** — history was **not** rewritten and the PR
was **not** merged. Exact SHAs are recorded in the commit message and in the PR update comment.

### 24.4 Independence status of this revision — UNCHANGED

**This correction does NOT satisfy the independent-verification gate.** It was produced by the
**same agent** that authored the original assessment and that performed the verification identifying
D-1…D-6. That prior verification established **methodological** independence (it falsified three of
the artifact's own assertions and surfaced two omissions) but **not separate-party independence**.
A documentation correction by the same author cannot convert same-agent evidence into independent
evidence. **P2-E4 remains NOT ACHIEVED**, and `PM-04` remains **OPEN**.

**The next gate is a genuinely separate independent verification of the corrected PR.**

---

## APPENDIX A — COMPLETE FINDINGS REGISTER (fresh, at `6b61256`)

| ID | Finding | Class | Severity | Primary evidence | Remediated? |
|---|---|---|---|---|---|
| **B-1** | Monotonic-narrowing invariant forbids adding destinations and raising impact ceilings | VERIFIED DEFECT-BLOCKER | **BLOCKER** | `capability-manifests.ts:130,:140,:162,:164-165,:213` | **NO** |
| **B-2** | No identity at the egress seam; no ambient-context mechanism anywhere. **Seam/propagation gap** — identity exists upstream at `agent.ts:132-140` | VERIFIED DEFECT-BLOCKER | **BLOCKER** | `llm.ts:18-24` `LLMRequest` **5 fields**, 0 identity (**[D-4 corrected]**, previously misstated as 6); `AsyncLocalStorage`/`async_hooks` 0 hits in all of `packages/` | **NO** |
| **B-3** | **TWO** byte-identical matchers use unbounded `.*`; both contradict their "segment-delimited"/"simple segment glob" docs; 3 bypass classes proven | VERIFIED DEFECT (**[D-1] scope corrected from one site to two**) | **HIGH** (for P3-B) | Site 1: `capability-manifests.ts:262-265,:267-284` (`.join('.*')` `:281`), `types.ts:404`, consumed `policy-engine.ts:304`. Site 2: `delegation-types.ts:380-402` (`.join('.*')` `:399`), consumed `:439`→`:442-445`, exported `index.ts:253`. `diff` of the two regex bodies ⇒ **identical**. Probe §20.1 | **NO** |
| **T-16** | Delegation target-scope confusion via the duplicated matcher (**[D-1]** newly added). Consumer is **live today**, unlike the latent egress cases | VERIFIED DEFECT in matcher; **exploitability UNKNOWN** (no grant corpus inspected) | **MEDIUM-HIGH** | `delegation-types.ts:439`, `:442-445`, `:364-367` (*"authoritative per-decision resource check"*) | **NO** |
| **B-4** | `SecretPurpose` closed 3-value set has no egress purpose; provider key is bare `process.env` | VERIFIED DEFECT-BLOCKER | **HIGH** | `secret-material.ts:64-70,:298-300`; `config.ts:99`; `bootstrap.ts:574-575,:591-592`; `openai.ts:41,:76`; `embeddings.ts:91,:113` | **NO** |
| **B-5** | Closed audit field set holds no destination/scheme/port/IP/hop/byte/deadline/status field | VERIFIED DEFECT-BLOCKER | **HIGH** | `audit.ts:29,:87`; `types.ts:543` (`targetResource?` only); 0 occurrences of all 10 egress fields | **NO** |
| **F-3** | `vector.search` authorized `READ`/`INTERNAL`/`tenant-knowledge` yet causes credentialed external transmission; `READ` unboundedly repeatable at **three** sites | VERIFIED DEFECT (**[D-2]** third site added) | **HIGH** | `builtins.ts:63-68,:210-229,:227`; `vector-module.ts:111-118,:114`; `embeddings.ts:109,:113`; `gate.ts:12,:407-408,:453`; **`consumption-stores.ts:60-61,:75`** | **NO** |
| **F-4** | No redirect policy on N-1/N-2; all 5 statuses followed **regardless of origin relationship**; **body forwarded on 307/308** (both origin relationships); `Authorization` **STRIPPED cross-origin** but **FORWARDED same-origin** | VERIFIED DEFECT (refined; **[D-6 corrected]** — earlier text said unqualifiedly "`Authorization` not forwarded") | **HIGH** | 0 `redirect` occurrences on N-1/N-2 (all 5 in `jwt.ts`); probes §20.2 (`P3B-PROBE-02` + `P3B-PROBE-02b` control) | **NO** |
| **F-8** | "PR #38 — 8/8 PASS" **unsupported**; 0 references to PR #38; nearest record is PR #37/`08adbd9` with **3 PASS + 5 gaps** | **UNVERIFIED** | **GOVERNANCE** | `grep` 0 files; `P2_S8_POSTMERGE_VERIFICATION.md` header + PM-01…PM-08; `gh pr view 38`; `gh run list` | n/a — **claim withdrawn** |
| **F-9** | Depth-1 clone; `08adbd9` remote-only; **all 4 egress blobs byte-identical** ⇒ prior findings still live | VERIFIED | informational | `is-shallow=true`; `.git/shallow`; `rev-list --count`=1; `cat-file -t` fatal; remote blob comparison | n/a |
| **F-11** | `.env.example` omits `oidc` from the mode table and calls it future "P2 scope" though implemented and wired | DOCUMENTATION DEFECT | **MEDIUM** | `.env.example:54,:57,:60,:63,:105` vs `auth-config.ts:50`, `bootstrap.ts:336,:352` | **NO** |
| **F-12** | Ruleset lacks `non_fast_forward`; stale-review dismissal and last-push approval `false`; code-owner review `false` | VERIFIED DEFECT | **HIGH** (governance) | `gh api …/rulesets/20134880`: rules `[deletion, pull_request, required_status_checks]`; corroborates PM-06/PM-07 | **NO** |
| **F-13** | No revocation/rotation path for the egress credential | VERIFIED ABSENT | **MEDIUM** | `openai.ts:41`, `embeddings.ts:91` — construction-time `process.env` read, no lifecycle hook | **NO** |
| **F-14** | `validateInput` performs required-key presence checking only | VERIFIED DEFECT | **MEDIUM-HIGH** (with F-3) | `tools.ts` `validateInput` | **NO** |
| **F-15** | Tenant scoping enforced inbound but **no tenant attribution on outbound egress** | VERIFIED DEFECT | **HIGH** | `vector-module.ts:139-155` vs `embeddings.ts:109` (no tenant in request/record) | **NO** |
| **F-16** | Tool output re-enters model context verbatim (no sanitization/truncation) | VERIFIED DEFECT | **MEDIUM** | `agent.ts:261-265` | **NO** |
| **F-17** | CI runs `npm ci --no-audit` ⇒ no advisory scanning across 50 workspaces | VERIFIED DEFECT | **MEDIUM** | `ci.yml:44` | **NO** |
| **F-18** | Actions tag-pinned (`@v4`), not SHA-pinned | PARTIAL | **LOW-MEDIUM** | `ci.yml:35,:38` | **NO** |
| **T-03** | **Cross-origin** credential theft via redirect | **REFUTED** | — | probe §20.2: `Authorization=STRIPPED` on all 5 **cross-origin** | n/a |
| **T-15** | **Same-origin** credential forwarding via redirect | **VERIFIED residual** (**[D-6]** newly added) | **MEDIUM** | probe §20.2 `P3B-PROBE-02b`: `Authorization=FORWARDED` on all 5 **same-origin**; precondition = open redirect on a permitted origin | **NO** |
| **T-08** | Multi-protocol SSRF (`file://`/`gopher://`/`ftp://`) | **REFUTED** | — | probe §20.3: all `TypeError: fetch failed` | n/a |
| **T-07** | Cloud-metadata credential theft | **PARTIAL** — reachability only | **MEDIUM** | probe §20.3: `169.254.169.254` ⇒ HTTP 501 from the **sandbox egress path**, **not** a real metadata service | n/a |
| **TA-4** | Network-layer egress filtering present in deployment | **VERIFIED ABSENT (this environment)** | **HIGH** (raises design bar) | probe §20.3 + 0 private-range terms in source (§5.4) | n/a |
| **INV-13** | Presence/definition of invariant 13 | **UNKNOWN** | — | absent from `security-posture.ts`; not established elsewhere | n/a |

**Register totals (reconciled at revision R2):**

| Category | Count | Members |
|---|---|---|
| **Blockers** | **5** | B-1, B-2, B-3, B-4, B-5 |
| **Other open defects** | **10** | F-3, F-4, F-11, F-12, F-13, F-14, F-15, F-16, F-17, F-18 |
| **Open items added by this correction** | **2** | **T-15** (same-origin credential forwarding, D-6), **T-16** (delegation matcher confusion, D-1) |
| **Total OPEN** | **17** | 5 blockers + 10 defects + 2 new |
| **Refuted threats** | **2** | T-03 (cross-origin credential theft), T-08 (multi-protocol SSRF) |
| **Partial** | **2** | T-07 (metadata reachability only), F-18 (tag-pinned actions) |
| **Unverified claim** | **1** | F-8 (PR #38 "8/8 PASS" — **remains UNVERIFIED**) |
| **Verified-absent (environment)** | **1** | TA-4 (network-layer egress filtering) |
| **Unknown** | **2** | INV-13; **T-16 exploitability** (matcher defect verified; no grant corpus inspected) |
| **Informational** | **1** | F-9 (baseline continuity) |
| **Remediated by this audit or by this correction** | **0** | — |

**Direction of change at R2:** two items **added** (T-15, T-16), one blocker's **scope broadened**
(B-3: one site → two), one finding's **evidence strengthened** (F-3: two sites → three). **Nothing was
removed, downgraded, or closed.** Three precision errors were corrected (D-3, D-4, D-5) and one
over-generalization qualified (D-6). **The register is strictly more adverse than at R1.**

---

## APPENDIX B — SCOPE COVERAGE MATRIX (mandated areas A–L)

| Scope | Area | Section | Outcome |
|---|---|---|---|
| **A** | Boundary and trust | §6, §8.3 | 9 boundaries mapped; **TB-5/TB-6 ungoverned**; P3-B must *create* a boundary, not harden one |
| **B** | Authentication and identity propagation | §9 | OIDC **implemented and wired**; `none` fails closed; **identity does not reach the seam (B-2)**; SAML/ABAC/ReBAC/PAM **absent, correctly declared out of scope** |
| **C** | Authorization (RBAC/ABAC/ReBAC/capability/PAM/revocation/policy integrity) | §10.1, §10.4 | **Capability-based**; 80 closed denial codes, **0 egress**; manifests immutable + narrowing-only; **no egress-credential revocation (F-13)** |
| **D** | Egress controls (deny-by-default/destinations/redirects/DNS/private IPs/metadata/SSRF/rebinding) | §10.2, §10.6, §20 | **17 requirements derived (R-01…R-17); 0 currently satisfied for N-1/N-2**; N-3 is the only precedent; **no DNS/IP control exists** |
| **E** | Agent and tool security | §11 | Loop bounded (`?? 8`); envelope unforgeable by model output; **`validateInput` presence-only (F-14)**; **N-1 is not a tool and runs every turn** |
| **F** | Tenant isolation | §12 | RLS + **FORCE** RLS + module-level scoping **implemented**; **runtime proof unavailable**; **no outbound tenant attribution (F-15)**; **no compute isolation** |
| **G** | Prompt-injection resistance | §13 | Model output **cannot** author authority (**strong**); **can** influence payload; **cannot** influence destination today — **DC-1 forbids regressing this** |
| **H** | Sandbox and execution isolation | §14 | **None exists; none claimed**; **no dynamic code execution (strong)**; application allowlist is the **only** barrier |
| **I** | Secrets | §15 | Governed seam is **strong and fail-closed**; **provider credential entirely outside it (B-4)** |
| **J** | Audit and forensics | §16 | Closed field set + shape assertion (**strong anti-tamper**); **cannot record egress (B-5)** |
| **K** | Fail-closed behaviour | §17 | **Consistently correct polarity across every measured control — the strongest property found**; absent exactly at the two P3-B prerequisites |
| **L** | Supply chain | §18 | Lockfile integrity gate before build **and** test (**strong**); least-privilege `permissions:`; CI **green** on audited SHA; **`--no-audit` (F-17)**, tag-pinned actions (**F-18**), **no `non_fast_forward` (F-12)** |

**All twelve mandated scope areas are covered. No area was skipped or answered from assumption.**

---

## APPENDIX C — STATEMENT OF WHAT THIS DOCUMENT IS AND IS NOT

**This document IS:**
- A fresh, read-only security audit of `POWERBot-1/JATA-Qi` at `6b61256c6115a02da2d3ad6ba42771831b550f81`, performed 2026-09-18T06:30:28Z, **as corrected at revision R2** (2026-09-18) for defects **D-1…D-6** per **§24**. The correction was **documentation-only** and remediated **no** security condition.
- Decision support for an owner deciding whether to authorize P3-B.
- The canonical, committed record of the P3-B pre-implementation security position.
- An independent re-measurement of B-1, B-2, B-3, F-3, F-4, F-8, F-9 — all substantiated; F-8 reclassified to UNVERIFIED; F-4 refined.

**This document IS NOT:**
- Independent verification. It is **SAME-AGENT** and **cannot** satisfy the E4 acceptance item (`PM-04` remains open).
- Implementation, design, remediation, or a commitment to any of them. **Zero findings were remediated.**
- Evidence of production readiness. **PRODUCTION NOT READY** stands.
- A score change. **9.484375% is frozen and was not recalculated.**
- Authorization for P3-B, P3-B₀, or any merge.
- **Discharged by revision R2.** The D-1…D-6 correction was made by the **same agent** that authored the assessment and performed the verification that found those defects. **A same-author correction cannot convert same-agent evidence into independent evidence.** Independent verification of the corrected document is still required (§24.4).
- **Remediation of B-1, B-2, B-3, F-3, F-4, F-9, T-15, or T-16.** Describing a condition more accurately does not fix it.

**Merge of the accompanying pull request requires separate, explicit owner authorization, and
independent verification of this document's blockers is required before any P3-B authorization is
granted.**

*— End of assessment —*
