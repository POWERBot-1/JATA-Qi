# P2-E4 — VERIFICATION PREPARATION (sequence step 3)

| Field | Value |
|---|---|
| Document class | **VERIFICATION-PREPARATION ARTIFACT — documentation-only.** Identifies the artifact and the protocol a genuinely separate party must follow. **This record performs no verification, reports no result, files no finding, and asserts no evidence class.** |
| Authority | Owner authorization of 2026-09-20 (`P2_E4_RECONSIDERATION_OWNER_AUTHORIZATION.md` §2), which authorizes *pursuing* E4 — not performing it here |
| Spec basis | `docs/P2_PRODUCTION_IDENTITY_PRIVILEGED_PLANE_SPECIFICATION.md` §19 rules 1–5 (E4 durability) and §24 P2-S8 (acceptance) |
| Prepared by | Arena agent session `arena/01a0bdb0-jata-qi`, 2026-09-20 (same-agent, documentation only) |
| Class of this record | **PRIMARY (same-agent) — explicitly NOT E4** |
| Verifier engaged | **NONE.** No separate party has been engaged; no report exists |
| **P2-E4 status** | **NOT ACHIEVED — unchanged** |
| Product code / tests / workflows / rubric / ruleset modified | **0** |

> **Read this first.** Nothing below is a verification result. Every
> "expected" column reproduces a *historical PRIMARY claim* that the separate
> party must **re-establish independently**, not accept. Where the separate
> party's observation differs from a historical claim, **the observation wins
> and the difference is a FINDING** (per
> `P2_S8_WHOLE_TREE_VERIFICATION_PASS.md` §4).

---

## 1. Artifact under assessment (identified, as the owner's authorization requires)

The owner's authorization names the historical P2 baseline as the target if it
is selected. It is selected here, because it is the artifact whose E4 class was
never obtained and the one the standing cap describes.

| Property | Value | How established (2026-09-20, this session) |
|---|---|---|
| **Exact artifact SHA** | **`08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe`** | `git cat-file -t` / `git rev-parse` in a scratch clone after `git fetch --depth=4 origin 08adbd9a…` |
| Object type | `commit` (merge commit) | `git cat-file -t 08adbd9…` |
| **Tree** | **`5f2152ce0cd702b649b93bc23c165d36cb9b9dba`** | `git rev-parse 08adbd9^{tree}` |
| Parent 1 (pre-merge `main`) | `2c1cad0ae9edbcc6ef13a241e120d3bb8de22415` (merge of PR #36) | `git rev-parse 08adbd9^1` |
| Parent 2 (PR #37 head) | `0a25b7ebc9eb464c1332044b8ea24a5c640920a1` | `git rev-parse 08adbd9^2` |
| PR #37 branch commits on top of `2c1cad0` | `c1df39c` (S8 suites/runbook/records) → `0a25b7e` (completion report) | `git log --graph 08adbd9` |
| Author / date | `POWERBot-1 <256624909+POWERBot-1@users.noreply.github.com>`, `1789665952 -0700` (2026-09-17T17:25:52Z) | `git cat-file -p 08adbd9` |
| Committer | `GitHub <noreply@github.com>` — GitHub-web merge, `gpgsig` present (GitHub web-flow signature) | `git cat-file -p 08adbd9` |
| Tree equality: `08adbd9` vs PR #37 head `0a25b7e` | **IDENTICAL** (both `5f2152ce0cd702b649b93bc23c165d36cb9b9dba`) | `git rev-parse` on both |
| Tree of pre-merge `main` (`2c1cad0`) | `dddbf48f05b5e96ccb378f6c3852d668b9f16bf3` (**different**) | `git rev-parse 2c1cad0^{tree}` |
| PR #37 state | `MERGED`, `mergedAt 2026-09-17T17:25:53Z`, author `app/arena-ai-coding-agent` | `gh pr view 37 --json …` |
| CI on this exact SHA | run **`35252694561`** — name `CI`, run_number `84`, event `push`, `head_sha 08adbd9a…`, status `completed`, conclusion **`success`**, created `2026-09-17T17:25:56Z` | `gh api repos/POWERBot-1/JATA-Qi/actions/runs/35252694561` |

**Why the tree equality matters.** The same-agent whole-tree pass
(`P2_S8_WHOLE_TREE_VERIFICATION_PASS.md`) was executed on the S8 branch tree.
That tree is **byte-identical in hash** to the tree of `08adbd9`, so re-executing
on `08adbd9` assesses exactly the same content — the historical PRIMARY baseline
is directly comparable to a fresh pass, and no drift can hide between them.

### 1.1 Working state of the repository at the time of preparation

| Property | Value |
|---|---|
| Preparation branch | `arena/01a0bdb0-jata-qi` |
| HEAD | `477aedb374580b0fe95d7c1f6f820ff68304b814` (merge of PR #43, `2026-09-20T06:14:04+00:00`) |
| HEAD tree | `4b267261f5ce6a7a91f07b260ffce96ee848c767` |
| Working tree | **clean** (`git status --porcelain` → empty) |
| **Clone depth caveat** | this sandbox clone is **shallow, depth 1** (`git rev-parse --is-shallow-repository` → `true`; `git rev-list --count HEAD` → `1`). `08adbd9` was **absent** locally (`git cat-file -t 08adbd9…` → `fatal: could not get object info`) and had to be fetched. **A verifier must not assume its checkout is complete** — see §2 |

### 1.2 How to obtain and pin the artifact (commands verified to work, 2026-09-20)

```bash
# Verified this session in a scratch clone. Depth 1 fetches the commit but
# NOT its parents; depth 4 was required before `^1`/`^2` resolved.
git init -q && git remote add origin https://github.com/POWERBot-1/JATA-Qi.git
git fetch --depth=4 --no-tags origin 08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe
git checkout 08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe

# Pin the artifact before running anything. Both must match §1 or STOP:
git rev-parse HEAD            # -> 08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe
git rev-parse HEAD^{tree}     # -> 5f2152ce0cd702b649b93bc23c165d36cb9b9dba
```

**Stop rule:** if either value differs, the verifier is not on the assessed
artifact. Record the divergence and stop; do not "correct" the SHA to whatever
the checkout happens to hold.

---

## 2. Post-P2 modification disclosure (required by the owner's authorization)

`main` has advanced since the assessed artifact. Any later artifact selected
instead of `08adbd9` **must** disclose these changes; they are disclosed here
regardless, because several touch the very packages P2 built.

| Property | Value |
|---|---|
| `main` ahead of `08adbd9` by | **12 commits**, **31 files** |
| Command | `gh api "repos/POWERBot-1/JATA-Qi/compare/08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe...main"` |

**Production-code files changed after `08adbd9`** (P3-B₀ S0a/S0b/S0c, R-17, T-16):

| File | Change |
|---|---|
| `packages/agent-runtime/src/builtins.ts` | modified +46/−2 |
| `packages/authentication/src/delegation-types.ts` | modified +1/−1 |
| `packages/authentication/src/egress-credential.ts` | **added** +303 |
| `packages/authentication/src/index.ts` | modified +16 |
| `packages/authentication/src/secret-material.ts` | modified +5/−2 |
| `packages/authorization-boundary/src/capability-manifests.ts` | modified +11/−1 |
| `packages/authorization-boundary/src/consumption-stores.ts` | modified +22/−4 |
| `packages/authorization-boundary/src/durable-decider.ts` | modified +7/−1 |
| `packages/authorization-boundary/src/envelope.ts` | modified +40 |
| `packages/authorization-boundary/src/gate.ts` | modified +23/−6 |
| `packages/authorization-boundary/src/index.ts` | modified +4 |
| `packages/authorization-boundary/src/types.ts` | modified +24 |

**Test/tooling added after `08adbd9`:** `packages/agent-runtime/test/p3-s0c-truthful-declaration.test.ts` (+206), `packages/authentication/test/p3-s0b-egress-credential.test.ts` (+687), `packages/authorization-boundary/test/p3-s0c-egress-consume-once.test.ts` (+559), `packages/authorization-boundary/test/r17-matcher-conformance.test.ts` (+468), `scripts/t16-grant-corpus-eval.mjs` (+102).

**Documentation added after `08adbd9`:** 12 new `docs/verification/*` records (including `P2_ASSURANCE_CAP_DISPOSITION.md`, `P0_V11_ASSESSMENT_AT_08ADBD9.md`, `P2_S8_POSTMERGE_VERIFICATION.md`, the P3-A/P3-B₀ set, `T16_GRANT_CORPUS_REEVALUATION_REPORT.md`), 2 new `docs/*` records (`P3_B0_GOVERNANCE_AND_AUTHORIZATION_RECORD.md`, `P3_B0_GOVERNED_EGRESS_DESIGN_RECORD.md`), and `docs/rubric/P0R-95_SCORECARD.md` modified +28/−8.

**Consequence for the verifier:** a verification of `08adbd9` establishes
**nothing** about the current `main`, and vice versa. If the assessment is
extended to a later SHA, that SHA must be named and these deltas re-assessed;
the P2-E4 claim covers only the artifact named in the report.

---

## 3. Scope the separate party must cover

### 3.1 §19 rule 1 — artifacts that must exist and be checked

| # | Required artifact | Status at `08adbd9` [REPO] |
|---|---|---|
| a | Implementation evidence doc (diff, commands, results, adversarial matrix, environment, artifact SHA) | `P2_S8_IMPLEMENTATION_REPORT.md` (PRIMARY) |
| b | **Independent-verification report of a SEPARATE party (E4)** on the exact artifact | **ABSENT** — no `P2_S8_INDEPENDENT_VERIFICATION.md` exists (post-merge finding PM-04) |
| c | Acceptance-criteria results as assertion-level table (case → command → result) | `P2_S8_IMPLEMENTATION_REPORT.md` §1 (PRIMARY), `P2_S8_WHOLE_TREE_VERIFICATION_PASS.md` §2 (PRIMARY) |
| d | Post-merge verification record (post-merge CI run id + steps) | `P2_S8_POSTMERGE_VERIFICATION.md` (added after `08adbd9`) |

### 3.2 §24 P2-S8 — acceptance items

> "A-17…A-23 green on the exact final artifact; runbook committed; whole-tree
> E4 report committed; first post-P2 v1.1 scoring assessment (assessment-only;
> no projection) recorded." (spec §24, P2-S8)

Three of four exist at PRIMARY class. **The whole-tree E4 report is the missing
item and is the sole subject of this pursuit.**

### 3.3 Re-execution protocol (commands; expected values are HISTORICAL PRIMARY CLAIMS)

Whole-tree, from the repo root, on the pinned artifact:

| Step | Command | Historical PRIMARY claim (re-establish; do not assume) |
|---|---|---|
| 1 | `npm ci --no-audit --no-fund` | (CI step; not separately claimed) |
| 2 | `npm run build` | exit 0, zero `error TS` |
| 3 | `npm run lint` | 0 errors; 61 pre-existing warnings; zero in S8-touched files |
| 4 | `npm test` | `Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0` |

Focused S8 suites — run as `node --test dist/test/<file>.test.js` from the
owning package after a clean build (the packages' own `test` script is
`node --test dist/test/*.test.js`):

| Case | Package / suite | Historical PRIMARY claim |
|---|---|---|
| A-17 restart + kill-9 in tx | `packages/authentication` · `dist/test/p2-s8-restart-recovery.test.js` | 4/4 |
| A-18 32-process fan-out contention | `packages/authentication` · `dist/test/p2-s8-fanout-contention.test.js` | 5/5 |
| A-19 outage matrix (stores) | `packages/authentication` · `dist/test/p2-s8-outage-matrix.test.js` | 3/3 |
| A-19 outage matrix (decisions) | `packages/authorization-boundary` · `dist/test/p2-s8-decision-outage.test.js` | 3/3 |
| A-20 failover (test-double) | `packages/authentication` · `dist/test/p2-s8-failover.test.js` | 3/3 |
| A-21 skew matrix | `packages/authentication` · `dist/test/p2-s8-skew-matrix.test.js` | 6/6 |
| A-22/A-23 tamper + duplicates | `packages/authentication` · `dist/test/p2-s8-tamper-duplicates.test.js` | 11/11 |
| Mutation-hygiene gate | `packages/authentication` · `dist/test/p2-s8-mutation-hygiene.test.js` | 4/4 |
| P2-S7 disposable mutation | `packages/authentication` · `dist/test/p2-s7-mutation.test.js` | 17/17 (~135 s) |

All **nine** suite files in that table were confirmed present **at `08adbd9`**:
the eight under `packages/authentication/test/` via
`gh api "repos/POWERBot-1/JATA-Qi/contents/packages/authentication/test?ref=08adbd9…"`,
and `p2-s8-decision-outage.test.ts` under
`packages/authorization-boundary/test/` via the same call against that path
(both returned `200` on 2026-09-20).

**Environment the verifier must document (and not inherit):** OS/kernel, Node
version, PostgreSQL provisioning (suites boot real embedded PostgreSQL
fail-hard; a SKIP is a failure, never a pass — see `.github/workflows/ci.yml`),
fixed suite ports (61100, 61150+, 61200+, 61250/61300, 61350+, 61400, 61450),
and any deviation.

### 3.4 Known limitations the verifier must RE-CONFIRM, not assume closed

Carried verbatim from `P2_ASSURANCE_CAP_DISPOSITION.md` §5 and
`P2_S8_IMPLEMENTATION_REPORT.md` §1.1:

- **xproc-MFA cross-process race remains UNPROVEN**; the `xproc-mfa` probe
  fails closed by design (A-18 limitation 3).
- **P1-GAP-12** — envelope integrity is an **unkeyed SHA-256** digest
  (`packages/authorization-boundary/src/canonical.ts:42`): tamper-evidence, not
  origin authenticity. A-22 shape-valid direct DB mutation is **not**
  cryptographically detectable.
- **Issuance idempotency key absent** for A-23; prevention lives at use time
  (one-shot CAS + consumed-envelope dedup).
- **A-20 failover is test-class**; no production HA/DR exists or is claimed.
- **A-17 "memory snapshot diff = empty"** is proven for the properties the suite
  pins, not for arbitrary process memory.
- **A-18 "32 processes"** exercises the 32-process *class*, not a production
  topology.
- **G10 OPEN** (log egress blocked), **G19 UNRECOVERED**, **EV-01/EV-02/EV-08
  outstanding**, **F1–F4 OPEN / NON-BLOCKING**.

---

## 4. Evidence-class rules binding on the separate party

| Rule | Source |
|---|---|
| **E4 = separate-party verification of the exact artifact.** Same-agent work is PRIMARY at best, forever | spec §19 rule 4; `CROSS_MILESTONE_EVIDENCE_CLAIM_AUDIT.md` EV-07 |
| **Not canonical evidence:** chat messages, PR comments/bodies, uncommitted local reports, sandbox transcripts, screenshots | spec §19 rule 2 |
| **PR approval clicks, same-agent attestations, and relabelled historical evidence are NOT E4 substitutes** | owner authorization §2 (2026-09-20) |
| **Referencing historical PRIMARY evidence does not verify it.** The report must state, per claim, whether the verifier *re-executed* it or merely *cited* it | owner authorization §2; this record §3.3 |
| **No retroactive credit, no inferred independence, no score inflation, no rewriting of historical reports** | `P2_ASSURANCE_CAP_DISPOSITION.md` §3 |
| **Canonical file name:** `docs/verification/P2_S8_INDEPENDENT_VERIFICATION.md`, committed **before** any merge authorization | spec §19 rules 1 & 3 |

### 4.1 Mandatory contents of the eventual E4 report

1. **Verifier identity** — the distinct human or organizational party, named.
2. **Environment** — host, OS, Node, PostgreSQL provisioning, ports, clock.
3. **Independence basis** — *why* this party is separate from the implementer,
   stated explicitly and falsifiably (not "a different session of the same
   agent"; that is same-agent).
4. **Exact artifact SHA + tree** — independently established per §1.2, with the
   pinning commands and their output.
5. **Commands and observed results** — verbatim, per case, including failures
   and skips.
6. **Findings register** — every divergence from any historical PRIMARY claim,
   filed as a finding with observed output.
7. **Remediation status** — per finding: remediated (with evidence) or OPEN.
8. **Limitations** — what the verification does **not** establish (production
   HA/DR, KMS/HSM, real IdP, G10, G19, P4–P7 surface).
9. **Explicit class statement** — the report's own class, and an explicit
   statement that referenced PRIMARY evidence was not thereby promoted.

### 4.2 What the report must NOT do

- claim E4 for A-17…A-23, the mutation-hygiene gate, the S7 disposable
  mutation, or the whole-tree same-agent pass;
- treat CI run `35252694561` as E4 (it is **CI-class**: workflow-reported
  metadata; raw logs egress-blocked);
- treat PR #37's `APPROVED` review (body length **0**, author `POWERBot-1`) as
  E4 — it is **PR-ATTESTATION**;
- award, compute, or imply any score change (a completed E4 does **not** move a
  number while the v1.0 numeric schedule remains unrecovered);
- assert production readiness (P2-E5 territory; spec §19 rule 4).

---

## 5. Governance context the verifier inherits (read back 2026-09-20)

| Item | Observed |
|---|---|
| Ruleset `20134880` ("Jata Qi", `refs/heads/main`) | enforcement `active`; `updated_at 2026-09-18T17:24:09.815Z` |
| Required status checks | `build · lint · test` (GitHub Actions, `integration_id 15368`), `strict: true` — **present** |
| Required approvals | **`required_approving_review_count: 0`** — contradicts the 2026-09-17 committed record `P0_V11_ASSESSMENT_AT_08ADBD9.md:133` ("1 required approval"). **Flagged for owner decision; not remediated** (see authorization record §7) |
| Force-push protection | **no `non_fast_forward` rule** |
| Stale-review dismissal / last-push approval | both **disabled** |
| Bypass | `current_user_can_bypass: "never"` for the agent token; `bypass_actors` not returned by this endpoint → **[UNVERIFIED]**, not asserted |
| Open PRs | **#39 OPEN, unmerged** (P3-B pre-implementation security audit) |

**Merge authorization is not granted by this preparation record and is not
requested by it.**

---

## 6. Status statement

> **No separate party has been engaged. No verification has been performed. No
> finding has been filed. `P2_S8_INDEPENDENT_VERIFICATION.md` does not exist in
> the tree.**
>
> **P2-E4: NOT ACHIEVED.**
>
> This record is preparation only. It becomes obsolete the moment a genuine E4
> report is committed, at which point that report — not this one — governs.

**STOP.**
