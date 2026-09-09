# POST-INV-15 — NEXT MILESTONE GAP RECONNAISSANCE (READ-ONLY)

> **Mode:** STRICTLY READ-ONLY RECONNAISSANCE. **This report authorizes NOTHING.**
> No implementation, commit, push, PR, merge, deployment, CI rerun, scoring
> change, rubric change, G10 repair, G19 reconstruction, or milestone start is
> authorized by this document. No implementation authorization is implied. A
> separate explicit authorization is required before any implementation begins.
> This document is a decision-support artifact only.

| Field | Value |
| --- | --- |
| Record type | Post-INV-15 next-milestone reconnaissance (documentation-only deliverable; uncommitted) |
| Date of record | 2026-09-09 (UTC) |
| Canonical main (verified) | `5d12cc57353c4e7cce3af157f5e23efde2c74b28` (merge of PR #28, 2026-09-09T13:47:22Z) |
| Prior canonical (this recon's diff base) | `3e43dc664ee7156f5cfd0c0322e4a4bef209e07b` (merge of PR #27) |
| Adopted rubric | `JATA-P0-95-v1.1` (commit `36f0026573074466e701db722e7f1cd91333d667`, remote branch `arena/01a07e0c-jata-qi`, **UNMERGED — verified still so today**) |
| P0 score | **9.484375% — PRESERVED (Δ = 0.0000000 pp; §3)** |
| G10 | **OPEN / UNATTRIBUTABLE — PRESERVED** (retained server-side; content still egress-blocked; §4) |
| G19 | **UNRECOVERED — PRESERVED** (full-repo search extended to every remote ref; §5) |
| P1C-OBS-01 | **DOCUMENTED / NOT REMEDIATED — unchanged** (test/harness flake; §3.6) |
| INV-15 / GAP-07 | **CLOSED, MERGED, POST-MERGE VERIFIED** (PR #28; CI run `34359343572` SUCCESS; §2) |
| Working branch (this session) | `arena/01a08684-jata-qi` (fixed; no commits, no pushes made) |

---

## 1. Canonical provenance (verified this session)

### 1.1 Checks performed (all PRIMARY: git objects + GitHub API, read-only)

| Check | Method | Result |
| --- | --- | --- |
| Canonical main identity | `git rev-parse HEAD`, `origin/main`, `main` | All = `5d12cc57353c4e7cce3af157f5e23efde2c74b28` — **PASS** |
| INV-15 merge commit intact | `git cat-file -p HEAD`; `gh pr view 28` | Merge commit with parents `3e43dc6` (pre-merge main) + `9e7812b` (PR head, F1–F3 remediation); PR #28 `state: MERGED`, `mergedAt: 2026-09-09T13:47:22Z`, `mergeCommit.oid: 5d12cc5…` — **PASS** |
| Merged tree clean | `git status` before this file was written | `nothing to commit, working tree clean` — **PASS** |
| PR #28 merged | `gh pr view 28 --json state,mergedAt,mergeCommit` | MERGED; merge commit matches canonical main exactly — **PASS** |
| Post-merge CI green | `gh run list --branch main`; `gh api …/runs/34359343572/jobs` | Run `34359343572` (push, `5d12cc5`, created 2026-09-09T13:47:25Z) conclusion `success`; **all 9 steps green** incl. "Test (all workspaces)" and "PostgreSQL integration status" — **PASS** |
| No unapproved changes on main | Full history (clone deepened read-only: `git fetch --unshallow` + all remote refs); every main commit cross-checked against PR records | Main's commit sequence = pre-PR-era roots + merge commits of PRs #2–#28 (each merge message references a PR; all 27 corresponding PRs `state: MERGED` with matching merge SHAs). **PR #1 is the only OPEN PR** (`arena/019f94a7-jata-qi`, unmerged, pre-program). No unattributable commits on main — **PASS** |
| History availability | Shallow clone detected at session start (1 commit visible) | Deepened read-only to full history (85 commits on main lineage) + all 32 remote branch heads + tag `v1.0.0` + PR refs. No canonical state was modified by the fetch |
| Rubric branch state | `git ls-remote origin`; `gh api …/commits/36f0026…` | `refs/heads/arena/01a07e0c-jata-qi` @ `36f0026` **still exists and is NOT an ancestor of main** (verified via `merge-base --is-ancestor` = false). The normative v1.1 rubric text therefore remains off-main (referenced by canonical docs, stored on the remote branch) — unchanged, **NOT a rubric modification** |

### 1.2 New remote refs discovered since the prior recon (2026-09-09, at `bb2b2f5`)

| Ref | SHA | Content | Canonical? |
| --- | --- | --- | --- |
| Tag `v1.0.0` | `59aa6093fb82b9722d30d49e17283566b5112a16` | Points inside the dormant branch stream (§1.3) | NO — not on main |
| Branch `arena/019fccab-jata-qi` | `8348cec96a565874c59336259c3ec03ee7c1e0f3` | 167 commits; dormant parallel "JATA AI Alpha" stream (see §1.3) | NO — not on main |
| Branch `recovery/dormant-arena-patch` | `210f84d2d8c436ecb6246980c85e858e7faef969` | `5a3e47d` + "Add files via upload" | NO |
| Branch `arena/01a04e8b-jata-qi-recovery-preserved` | `0dc1405fe796275b4ae74ee844b38b0e14729262` | Preserved recovery branch | NO |
| `refs/pull/1/head`, `/merge` | `5610b8f…`, `532b27b…` | Open PR #1 head + synthetic merge | NO |

None of these entered `main`. Their existence is recorded for completeness and
because the dormant stream is material to gap-map cost estimates (§6.10, §11).

### 1.3 Material finding: the dormant parallel stream

`arena/019fccab-jata-qi` (head `8348cec`, base `5a3e47d` — the pre-recovery
"102/102 tests" commit) is a **167-commit parallel workstream** that was never
merged and was not part of the P0/P1/INV-15 canonical program. It contains, in
commit titles alone: HTTP gateway + WebSocket + rate limiting, LLM gateway with
routing/fallback/cost tracking, sovereign model runtime, MFA (TOTP RFC 6238),
PKI/IdP, Stripe/SendGrid/Twilio/Africa's Talking adapters, M-Pesa/Flutterwave/
Pesapal/Airtel/PayPal, universal wallet (double-entry), MAZA marketplace + 15-
product portfolio, TANYA mobile, NOVA game engine, Terraform EKS/RDS/S3,
VPS `deploy.sh`/`backup.sh` ("LIVE withheld pending real infrastructure"),
OpenTelemetry tracing, Kubernetes ops, chaos/scalability validation, and a tag
`v1.0.0` ("GA v1.0.0").

**Status: non-canonical, unverified, unassessed.** P0 scoring counts the
canonical tree only; none of these commits contribute to the 9.484375%
baseline. This recon makes **no claim about its correctness, security, or
production status** (its own reports say LIVE is withheld). It is recorded
because it (a) changes the cost/leverage picture for platform/commerce/AI gap
items (assets exist to evaluate or port), and (b) carries its own provenance
burden if the owner ever elects to integrate it.

### 1.4 Governance-adjacent CI fact (R-9 — verified still OPEN)

GitHub ruleset `20134880` ("Jata Qi", enforcement `active`, updated
2026-09-03) contains **only**: `deletion`, `non_fast_forward`, and `pull_request`
rules (`required_approving_review_count: 0`, review-thread resolution on). It
contains **no `required_status_checks` rule** — the CI check "build · lint ·
test" is **not a required merge gate** on `main`. This is the condition under
which the three red post-merge runs (§4.3) could occur. Recorded from
`docs/T09_F_REGISTER_RECONSTRUCTION.md` R-9 (High, governance, "Requires an
admin token"); re-verified live via API today. **No change made.**

---

## 2. INV-15 / GAP-07 — closure confirmation (basis for "post-INV-15")

| Item | State | Evidence (canonical) |
| --- | --- | --- |
| Definition | INV-15 / PG-5 / P1-GAP-07: no ambient session-level `'*'`; pooled sessions start blind; system scope only via explicit `SET LOCAL` transactions; exceptions enumerated | P1 spec §§8.3/12/14 (at `5d12cc5`) |
| Implementation | Ambient pool-`'connect'` `SET '*'` removed; unscoped pool-path ops fail closed; single labeled choke point (`withSystemScope`); frozen exception registry (`poolpath:` / `transaction:system` / `schema:isolation`); boot invariant `p1.production.ambient-scope-minimization`; live `hasAmbientConnectScope()` probe | PR #28 diff `3e43dc6..5d12cc5`: 12 files, +1219/−127 (`storage-postgres` driver/collection/audit/probe, `cli/security-posture.ts`, 474-line INV-15 suite, t06 strengthened); `INV-15_GAP-07_IMPLEMENTATION_EVIDENCE.md` |
| Independent verification | Verdict **B — VERIFIED WITH NON-BLOCKING FINDINGS** (F1 census, F2 inventory row, F3 stale comments) | Verdict record **not committed** (untracked per remediation doc §5); F1–F3 remediated in `9e7812b` (comment/doc-only, 0 non-comment lines); `INV-15_GAP-07_FINDINGS_REMEDIATION.md` committed; PR #28 comment attests remediation + fresh 50/50 regression |
| Merge | PR #28 merged 2026-09-09T13:47:22Z → `5d12cc5` | §1.1 |
| Post-merge verification | CI run `34359343572` SUCCESS, all steps green, incl. PG integration step | §1.1 |
| Residual (honest, from evidence doc §9) | Session-level ambient authority eliminated; per-op explicit `poolpath:` system scope retained for legacy consumers (minimized + enumerated, not removed — the broader per-consumer tenant migration remains excluded) | `INV-15_GAP-07_IMPLEMENTATION_EVIDENCE.md` §9.1 |
| Open thread (recorded, not re-derived) | PR #28 comment: "STOP for fresh independent re-verification (B is not self-upgraded)" — a fresh A-grade pass and the explicit GAP-07 closure record have not yet been committed | PR #28 comments (read today) |

**Determination: INV-15/GAP-07 is CLOSED / MERGED / POST-MERGE VERIFIED at the
governance level (explicit merge authorization exercised; canonical CI green).
The E4-report durability thread (§3.5) remains.**

---

## 3. Current P0 state (JATA-P0-95-v1.1)

### 3.1 Frozen posture — preserved

| Quantity | Value | Status after INV-15 |
| --- | --- | --- |
| Evidence-qualified baseline | **9.484375%** | **PRESERVED — Δ = 0.0000000 pp** |
| Capability index | 44.375% | carried frozen |
| Integration-adjusted capability | 36.6875% | carried frozen |
| Sensitivity range | 6.6484375%–14.875% | carried frozen |
| Stretch (120%) | 0/20 | unchanged — nothing 120%-class exists in the canonical tree |
| Production readiness | **NOT READY** | unchanged — no production deployment exists |

No post-freeze record (P1, V-1/V-2, O-1/O-2/O-3, O-3 cleanup, P1-CLOSURE,
INV-15) claims scoring credit; every one states the score is FROZEN and cites
rubric V2/V5 (no grade upgrading; evidence does not close gates; no credit for
planned or unassessed capabilities). **This recon invents no additional credit.**

### 3.2 Recalculation — only where canonical evidence supports an exact determination

1. **D07b (the only computable unit, 2.25 pts):** recomputed at `5d12cc5` under
   the v1.1 mean-of-modality-products rule. The INV-15 diff touches exactly the
   storage scope layer, CLI posture, and docs — **none of the nine D07
   modalities** (coding, architecture, website, image, video, copy, voice,
   marketing, general-agent). Every P1-CLOSURE §7.2 zero-factor ground remains
   true at `5d12cc5` (sandbox-only products; EchoLLM default; OpenAI
   adapter key-gated with no production-provider evidence; no PSP; no
   production side effects wired; `scan:r2` clean). All `P_m = 0` by X2
   (missing ⇒ zero factors, coefficient-agnostic) ⇒ **`q_07b = 0.0000000` of
   2.25 pts — exact, unchanged.**
2. **D07a/c/d:** unit specs are v1.0-only (absent, P0R-RUB-02) → unassessable;
   frozen carry.
3. **Remaining 97.75 points:** per-dimension recomputation is **not permitted
   by the evidence** (v1.0 dimension IDs/weights/unit specs/E0–E6 schedule/
   freshness model were never stored in-repo). Frozen contributions are carried
   with the per-group blockers exactly as in the first v1.1 assessment
   (`P1_CLOSURE_VERIFICATION.md` §7.3): P1/R2/INV-15 security implementation is
   present and integrated but credit is blocked by the **absence of committed
   E4+ independent-verification artifacts in the canonical record** (§3.5);
   identity dimensions are MISSING by design (P2); qualification dimensions
   open (P7); modalities zero.
4. **Net: 9.484375% PRESERVED.** No manipulation, no inference, no upgrading,
   no projection. The rubric was **not modified**.

### 3.3 Dimensions currently credited (as far as canonical evidence allows)

The 9.484375% baseline is the v1.0-era frozen evidence-qualified total. Its
exact per-dimension decomposition is **not reconstructable from canonical
artifacts** (v1.0 text absent — P0R-RUB-02). What is verifiable: the frozen
capability index (44.375%) reflects implemented-and-evidenced (pre-P1)
capability; the integration-adjusted index (36.6875%) reflects integration
discounts; the E-coefficient/freshness model produced the 9.484375% point
total under v1.0 rules. No dimension may be re-rated without the v1.0
specification or a further normative amendment (P0R-RUB-03 — separate
versioned review; **not authorized here**).

### 3.4 Zero / low-evidence dimensions (canonical, `5d12cc5`)

| Group | Evidence class | Why zero/low |
| --- | --- | --- |
| D07b all nine modalities | 0/9 (recomputed) | No production provider/execution evidence in canonical tree (sandbox-only; interface-without-provider) |
| D07a/c/d | Unassessable | v1.0 unit specs absent |
| Identity dimensions (P2 scope: OIDC/OAuth/SSO/SAML, MFA, lifecycle, recovery, deprovisioning, privileged plane) | MISSING by design | P1 shipped contracts only (`authentication/src/contracts.ts`); P1 spec §7.2: every item explicitly "MISSING … P2 scope by design" |
| Contained-execution dimensions (P3 scope) | MISSING | In-process workers; P1 spec threats T8/T9 |
| Production knowledge + Model Fabric dimensions (P4) | Dev-class at best | Brute-force vector index, dev-snapshot persistence, no ANN, no production provider evidence |
| Prompt-compiler dimensions (P5) | Absent in canonical | `unified-loop` is a deterministic 34-stage governed orchestrator, not an LLM prompt compiler |
| Product/economic integration dimensions (P6) | Adapter/intent-only | No real PSP; payments are provider-neutral intents; settlement/refunds evidence-classified only |
| Qualification dimensions (P7) | Open | No SBOM/provenance, no HA/PITR, no deployment, no kill-9 harness |

### 3.5 Evidence freshness (`5d12cc5`, 2026-09-09)

| Evidence | Class | Freshness |
| --- | --- | --- |
| Frozen P0 totals | FROZEN-CURRENT | Re-affirmed through PR #27's first v1.1 assessment; no superseding assessment exists |
| P1 implementation (S1–S10, 1194-test tree) | Implementer-produced, CURRENT artifact at merge; **no committed E4 report** (verdicts B→A survive as PR-ATTESTATION; reports LOST — `P1_CLOSURE_VERIFICATION.md` §6) | Caps P1 claims below E4 |
| INV-15 implementation + F1–F3 remediation | Implementer-produced; CI green at `5d12cc5`; **E4 report (B-grade) uncommitted**; fresh A-grade re-verification pending per PR #28 comment | Caps INV-15 claims below E4 — **the loss pattern has recurred a third time (T09 → S-1/R2 → P1 → INV-15)** |
| Canonical CI of `5d12cc5` | PRIMARY | GREEN (run `34359343572`, all steps) |
| R2/A-01/T09/S-1 historical evidence | HISTORICAL | Authoritative for their milestones; historical ≠ current E4 (rubric V4) |
| v1.0 base rubric | ABSENT | Blocks per-dimension worksheet (P0R-RUB-02) |
| Rubric v1.1 text | On unmerged remote branch `36f0026` | Authoritative as adopted successor; not durably in main |
| G10 logs | Retained server-side; **content egress-blocked** (two independent sessions) | INDICATED-RETAINED / DECAYING |
| G19 source | UNRECOVERED | No freshness |

### 3.6 Critical/high gates, floors, release blockers (current)

**Critical/high security gates (from the P1 spec §13 threat model, residuals at
`5d12cc5`):**

| Gate/threat | Residual | Closure path |
| --- | --- | --- |
| T1 Account takeover (bearer-only static tokens) | **HIGH until P2** | P2 (MFA/step-up, real IdP); D1 decision (outright refusal of static-token production is a one-line tightening) |
| T10 Database compromise | **HIGH** (acknowledged; out of P1) | P7 ops (role separation execution, least-privilege provisioning — D3) + KMS/HSM (D2) |
| T18 Supply-chain compromise | **HIGH** (accepted residual) | P7 (SBOM/provenance verification) |
| T9 Malicious internal code (in-process gate compromise) | MEDIUM-HIGH (accepted) | P3 (contained execution) |
| T4/T8 Credential theft / compromised worker | MEDIUM | P3 containment; D2 KMS |

**Dimension floors:** values are not present in any canonical artifact (v1.0
absent). They are release-mandatory per handoff §5 ("all required dimension
floors") and cannot be enumerated here without inventing rubric content. **This
is a recorded evidence gap, not a waiver.**

**Release blockers (handoff §5, all still mandatory):** ≥95% evidence-qualified
baseline; all required dimension floors; all critical security gates PASS; all
required high gates PASS; independent verification PASS (committed, E4+); **no
unexplained mandatory CI/test failure (G10 OPEN)**; exact tested
artifact/configuration promoted; production qualification satisfied.

**P1C-OBS-01 (carried, unchanged):** `packages/storage-postgres/test/pg-test-harness.ts`
lacks bounded readiness retry (O-2 defect class, pre-existing); triggered
7/7 `ECONNREFUSED`-at-`doInit` failures in one full-suite rerun on an
unmodified tree (P1-CLOSURE §9). Classified TEST/HARNESS + environmental, NOT
product. **Documented, NOT remediated** (separate authorization required).
Still present at `5d12cc5` (the INV-15 diff does not touch that file —
verified by diff stat).

---

## 4. G10 — reconstruction (OPEN / UNATTRIBUTABLE — PRESERVED)

### 4.1 Frozen instance record (unchanged; re-verified)

> **G10 — OPEN — UNATTRIBUTABLE CANONICAL CI FAILURE.** Run `34162894915`,
> job `101868167969`, step "Test (all workspaces)", command `npm test`. No
> authoritative assertion/package/root-cause evidence recovered.

Re-verified this session (metadata): push run on `main`, head `10fc9ba` (merge
of PR #24), created 2026-09-07T21:22:25Z (≈3 s after the PR #24 merge at
21:22:22Z — the post-merge push run), conclusion `failure`; steps 1–7 success
(checkout, Node, install, workspace check, **build**, **lint**), step 8
**"Test (all workspaces)" failure**, step 9 (PG status) success.

### 4.2 Answers to the eight mandated questions

1. **Exact originating event.** The `on: push: branches: [main]` CI run
   triggered by the PR #24 merge push to `main` (not a PR check run, not a
   manual rerun, not a concurrency cancellation — job conclusion is `failure`,
   not `cancelled`).
2. **Affected commit/run.** Commit `10fc9baffbc432eb1ec92cec9cd1f4c86d810a64`;
   run `34162894915`; job `101868167969` ("build · lint · test"); failed step
   "Test (all workspaces)" (`npm test` via `scripts/run-workspaces.mjs`, 50
   workspaces, real embedded PostgreSQL, 30-minute job timeout).
3. **Is the failure reproducible?** — **Step-level signature: yes, it recurred;
   cause-level: unknown.** Three consecutive post-merge push runs on `main`
   failed at exactly this one step with build/lint green (verified today via
   jobs API):
   - `34034524011` — PR #19 merge, head `82af3de` (2026-09-06T12:55:09Z)
   - `34162894915` — PR #24 merge, head `10fc9ba` (2026-09-07T21:22:25Z) = **G10**
   - `34255207381` — PR #26 merge, head `bb2b2f5` (2026-09-08T17:07:36Z) — governed by determination D (TRANSIENT/UNRESOLVED FLAKE) in the milestone authorization record; that determination is **not copied onto G10 by analogy**
   The next two post-merge push runs are fully green: `34323662869` (PR #27,
   `3e43dc6`) and `34359343572` (PR #28, `5d12cc5`). Pre-merge PR runs on the
   same trees passed (e.g. `34251023056` SUCCESS at `5becaa5`). Local
   same-tree reruns produced a classified flake of the same shape
   (P1C-OBS-01: `ECONNREFUSED` at driver init in the PG harness; green on
   rerun) — a same-**class** candidate on the later tree, but no
   assertion-level equivalence to the G10 run exists, and G10's tree
   (`10fc9ba`) predates the O-2 harness patch (merged in `bb2b2f5`) while the
   `bb2b2f5` run still failed. **No reproducible cause is established; the
   failure is characterized, not reproduced.**
4. **Are logs available?** — **Retained server-side; content-inaccessible from
   this environment.** Two fresh retrieval attempts this session (gh API +
   direct curl against the job-logs endpoint): both received a freshly signed
   SAS redirect to
   `productionresultssa19.blob.core.windows.net/…/job-logs.txt` (signature
   window 2026-09-09T14:30–14:31 UTC), proving the blob still exists; both
   then failed at the TLS layer (`SSL_ERROR_SYSCALL`; `gh`: 0 bytes) —
   **sandbox egress to Actions log storage is blocked at the network level**,
   identical in kind to the P1-CLOSURE session's failure (EOF on G10 and on a
   1-day-old control download). Retention setting not verified; decay risk
   stands.
5. **Is attribution technically possible?** — **Yes — from an
   egress-capable environment.** The log blob is retained, the SAS endpoint
   issues fresh signatures, and a read-only GET from any environment with
   normal egress (e.g. a human's machine, or a future sandbox with Azure-blob
   egress) should return the full job log, which names the failed
   workspace/suite/assertion. No code, CI, or admin access is needed for
   attribution itself — only network reach to the blob host. **Attribution has
   NOT been performed here** (content = 0 bytes transferred; nothing inferred).
6. **Exact evidence required for closure** (handoff §6 + §5, verbatim
   categories — none performed here):
   1. Attribution: the failed test assertion(s) and package(s), from
      retrievable job logs, authoritative test output, a later CI run that
      establishes the failure cause, or another authoritative source;
   2. Disposition under explicit authorization (fix, or evidenced flake
      determination) through the governance sequence;
   3. Canonical-CI determination on the dispositioned artifact;
   4. Independent verification where the disposition touches
      security/test-integrity semantics;
   5. Explicit governance record closing G10 (no silent closure).
   Precedent (PR #25 record): green canonical runs on other artifacts do not
   close G10.
7. **What closure requires.** **CI-access (egress) + governance disposition** —
   not code by default, not only documentation: attribution is a read from
   retained CI logs; disposition is a governance act; a code/harness fix is
   required **only if** attribution identifies a product or harness defect
   (P1C-OBS-01-style); an evidenced-flake determination would still require the
   explicit record and cannot be borrowed from the PR #26 D determination.
   No infrastructure or admin token is needed for the evidence track (the
   admin-token item belongs to R-9 branch protection, a separate gate).
8. **Does G10 block a future P0 gate?** — **Yes, at release level.** G10 is
   the "no unexplained mandatory CI/test failure" release gate (handoff §5).
   It does **not** block authorizing/merging implementation milestones
   (precedent: P1, O-remediations, and INV-15 were all authorized, merged, and
   verified with G10 OPEN). It **must close before any release claim**, and it
   is the one time-sensitive evidence item (log-retention decay).

### 4.3 Determination

**G10 = OPEN / UNATTRIBUTABLE — PRESERVED.** Original failure content could
not be recovered from this environment (0 attribution bytes). Nothing is
inferred from the recurrence pattern, the P1C-OBS-01 same-class local flake,
or the PR #26 D determination. The reconstruction above strengthens the
evidence plan (exact endpoint, freshness, environment requirement) without
altering the gate. **The defined next step is unchanged: evidence-only
authorization for log inspection from an egress-capable environment, with a
log-preservation decision (retention setting is unverified).**

---

## 5. G19 — reconstruction (UNRECOVERED — PRESERVED)

### 5.1 Definition (frozen, unchanged)

> **G19 — UNRECOVERED — HISTORICAL SOURCE UNAVAILABLE.** Original F3–F12
> definitions were not recovered. Do not reconstruct, infer, rename,
> substitute, or map unrelated historical findings into F3–F12. (Handoff §3;
> P1 spec §§1/22; rubric v1.1 §12.)

Revisit condition (handoff §6): only if the original F3–F12 source reappears
or an authoritative historical artifact containing the actual definitions
becomes available.

### 5.2 Search coverage executed THIS session (full remote-repo reach)

| # | Source | Method | Result |
| --- | --- | --- | --- |
| 1 | Full commit history (main, unshallowed; all merge lineages) | pickaxe `git log --all -S` for `F3–F12`, `F3-F12`, `G19`, `G10` | Status references only, in the 8 known commits (`80172a4` first introduction; `36f0026` rubric status; `cf23236`, `5f1f5c0`, `4456bcd`, `5becaa5` P1-era; `27853d1` P1-CLOSURE; `9e7812b` INV-15 remediation status line). **Zero definitions** |
| 2 | All 32 remote branch heads, **including refs new since the prior recon**: `arena/019fccab-jata-qi` (167-commit dormant stream — fully fetched and pickaxed), `arena/019f94a7-jata-qi` (PR #1 head, 109+ commits beyond it via the 019fccab lineage), `recovery/dormant-arena-patch`, `arena/01a04e8b-jata-qi-recovery-preserved`, rubric branch | fetched + tree grep per head | No F3–F12 definitions. The dormant stream contains its own finding numbering in commit titles (`#35`, `#36`, `#52`, `#53`, `#86`, P5/P6/P7 series) — **a different, non-canonical series; no identity asserted** (§5.3) |
| 3 | Tag `v1.0.0` (`59aa609`) and its lineage | pickaxe | No definitions |
| 4 | PR refs `refs/pull/1`, `/24`, `/27`, `/28` (head + merge) | fetched + grep | No definitions |
| 5 | PRs #24–#28 bodies, all comments, all reviews (mandated range) | `gh` read (full) | No F3–F12 content (R2 "No F3–F12 changes"; P1 V/O findings; P1-CLOSURE status; INV-15 F1–F3 — a distinct, dash-free, 3-item INV-15 verification series) |
| 6 | Every verification document ever committed (full-history `--diff-filter=A` listing, 15 files) + all current `docs/verification/` | full read of the relevant set | No definitions; the independent-verification reports that could have carried F3–F12 (R2/P1/INV-15) were **never committed** (loss pattern, §3.5) |
| 7 | T09 F-register (`docs/T09_F_REGISTER_RECONSTRUCTION.md`) | full read (prior milestone; re-verified present) | **Different series** (F-1..F-8, dash notation) — collision catalog in its §7; must not be conflated |

### 5.3 Classification: **C — definition remains unrecoverable**

- **A (recovered): NO.** No authoritative artifact containing the actual
  F3–F12 definitions exists in any accessible source — canonical history, any
  branch, any tag, any PR record, or any committed verification artifact.
- **B (partial evidence): NO.** The only adjacent facts are (i) the ID-range
  coincidence with the unrecorded remainder of the R2 independent-verification
  findings (F1–F12 minus recorded F1/F2 = "F3–F12") and (ii) the dormant
  stream's non-canonical finding numbering. Both are guarded: the P1 spec §22
  explicitly disclaims any relation between R2's F-IDs and G19's F3–F12, and
  the handoff forbids mapping unrelated findings into F3–F12. They are
  recorded as **unconfirmed candidates only**, with no identity conclusion.
- **C (unrecoverable): YES — confirmed by the broadest search yet performed
  (every remote ref of the repository, not just the 31 heads of the prior
  recon).**

**Limitation (exact):** the search covers everything reachable in the
canonical GitHub repository and its refs. It cannot reach
session-external/conversational sources (agent chat transcripts or external
stores where an F3–F12 register may have originally been drafted before the
recovery event that produced `JATA_QI_RECOVERY_MANIFEST.md`); such sources are
not authoritative accessible artifacts for this program. Until one reappears
in an authoritative form, **G19 remains UNRECOVERED, and no meaning is
invented for it.**

---

## 6. Current architectural gap map (canonical `5d12cc5`)

Statuses: **C-IMPL** = implemented in canonical tree (evidence class noted);
**CONTRACT** = contract/interface only; **MISSING** = absent; **EXT** =
external/owner dependency; **DORMANT** = exists only on the unmerged dormant
stream (§1.3), never counted.

### 6.1 SECURITY

| Item | Status | Canonical evidence / note |
| --- | --- | --- |
| Production authentication | C-IMPL (composition) + MISSING (real IdP) | P1 enforced production composition: `PrincipalBoundary` fail-closed, durable sessions (S-8), token registry (S-9) wired as the only production static-token path (opt-in `JATAQI_ALLOW_STATIC_TOKEN_PRODUCTION=true`); **OIDC/OAuth/SSO/SAML/MFA all MISSING (P2)**; T1 residual HIGH (bearer-only) |
| Identity lifecycle | MISSING (P2) | Enrollment/recovery/deprovisioning/rotation/step-up/privileged plane — P1 spec §7.2; P1 shipped `authentication/src/contracts.ts` interfaces only |
| OIDC/SSO/SAML/MFA | MISSING (P2) | same |
| Authorization durability | C-IMPL (strong) | A-01 authoritative fail-closed PDP; R2 PostgreSQL as SOLE authoritative SecurityStateStore; P1 INV-01…INV-16 kernel invariants; fail-closed `SECURITY_STATE_UNAVAILABLE`; 32-process + restart suites |
| ABAC/ReBAC/PAM | PARTIAL | Closed-set capability manifests + policy engine (tenant/classification/impact/rate/budget/approval/credential); no general ABAC language, no ReBAC graph, no PAM elevation (step-up contract exists as interface only) |
| Sandboxing | MISSING (P3) | In-process workers; T8 MEDIUM / T9 MEDIUM-HIGH accepted residuals |
| OS/container isolation | MISSING (P3) | none in canonical |
| SSRF protection | MISSING (canonical) | No network egress plane in canonical main; connectors inactive-by-default with credential references only (defense-by-absence, not protection) |
| Governed egress | MISSING (P3) | none |
| Production credential/key management | CONTRACT + EXT | KMP contract enforced (dev providers refused in production); **no KMS/HSM provider selected (D2)**; tests use honestly-labeled doubles |
| Audit integrity | C-IMPL | Digest-bound approvals, append-only invariants, hash-chained ledgers, S-1 sole durable audit channel (P1-DEF-01 double-write fixed); **envelope digest unkeyed** (P1-GAP-12, defense-in-depth, open) |
| Insider-threat controls | PARTIAL | T17 administrator abuse MEDIUM: approvals digest-bound, rotation attributed, sealed bindings; P2 privileged plane + P7 qualification improve |
| Ambient security scope (INV-15) | C-IMPL — CLOSED by PR #28 | §2; session-level ambient `'*'` eliminated; per-op enumerated grants; boot invariant + live probe; residual: legacy per-consumer tenant migration (broader redesign, excluded) |

### 6.2 AI / MODEL

| Item | Status | Canonical evidence / note |
| --- | --- | --- |
| Model Fabric | MISSING (P4) | No router/registry/cost-aware routing/fallback in canonical; DORMANT has `@jataqi/llm-gateway` (routing/fallback/cost) + sovereign model runtime — non-canonical |
| Model routing / cost-aware | MISSING (P4) | agent-runtime: Echo/Scripted/OpenAI adapters only; OpenAI key-gated, no production-provider evidence (D07b copy modality = 0) |
| Model evaluation | MISSING (P4) | DORMANT has `@jataqi/evals` — non-canonical |
| Fallback | MISSING (P4) | no chain semantics in canonical |
| Cross-model deliberation | MISSING (120%) | `multi-agent-cognition` is injected-reviewer structured critique (classical, non-executing) — a foundation, not deliberation |
| Knowledge extraction | C-IMPL (dev class) | knowledge-graph heuristic extractor |
| Governed memory | PARTIAL | agent session memory (local); commercial-memory (tenant-bound, hash-chained); DORMANT "Digital Memory Engine" — non-canonical |
| Semantic retrieval | C-IMPL (dev class) | knowledge-service semantic retrieval + vector-search brute-force flat index; dev snapshot persistence only |
| Hallucination controls | MISSING | none in canonical (DORMANT has prompt-injection/PII/toxicity screening — non-canonical) |
| Distillation / specialized models / proprietary evolution | MISSING (120%) | none |

### 6.3 AUTONOMOUS PROMPT COMPILER (P5)

| Item | Status |
| --- | --- |
| Intent understanding / requirement extraction / context construction / decomposition / model-tool routing / structured Prompt IR / engine-specific prompting / execution / evaluation / failure diagnosis / automatic refinement / retries / strategy learning / governed feedback | **ALL MISSING in canonical.** `unified-loop` is a deterministic 34-stage governed orchestrator over capability contracts (fails closed at policy/authority/verification gates) — real governance scaffolding, but not an LLM prompt-compilation pipeline. D07b general-agent modality = 0 (single-task, in-process, sandbox adapters only) |

### 6.4 AGENT / EXECUTION

| Item | Status | Canonical evidence / note |
| --- | --- | --- |
| Distributed execution | MISSING | Single-process unified-loop; DORMANT has orchestrator + workflow history + scheduler — non-canonical |
| Hard worker isolation | MISSING (P3) | `runUnderEnvelope` wrapper + worker-boundary tests; no hard isolation |
| Durable workflows | PARTIAL | T-05 canonical durable event delivery + transactional composition; security-state + commercial action runtime are durable; general durable workflow units absent |
| Cancellation / compensation | PARTIAL | autonomous-action-runtime: bounded retry/timeout, dry-run isolation, independent verification, confirmed-rollback recording (adapter-level; no general compensation framework) |
| Long-running jobs | PARTIAL | loop-host durable continuous-operation host + leases; R2 orphan-lease/GC/restart evidence |
| Node loss | PARTIAL | R2 restart/orphan evidence; **no kill-9 mid-transaction harness** (P1 evidence §4.6 — P7 qualification follow-up) |
| External-effect semantics | C-IMPL (gated) | A-01 envelope + pre-side-effect enforcement; `runUnderEnvelope` mandatory for externally consequential tasks |
| Execution budgets | C-IMPL | Budget + rate in the A-01 decision pipeline; per-tenant rate/budget (S-6/S-7) |
| Provenance | PARTIAL | capability-fabric lifecycle evidence + hash-chained audits; JQ-CIP creator provenance is DORMANT-only |

### 6.5 KNOWLEDGE

| Item | Status | Canonical evidence / note |
| --- | --- | --- |
| Distributed vector persistence | MISSING (P4) | dev-snapshot persistence only; no production vector store |
| ANN indexing | MISSING (P4) | brute-force flat index only |
| Graph consistency | PARTIAL | knowledge-graph triple store + BFS; no consistency service |
| Durable memory (production class) | MISSING (P4) | PG driver is authoritative for security state; knowledge/memory production evidence class absent |
| Cache isolation | MISSING (P4) | none documented |
| Retrieval poisoning defense | MISSING (P4) | none documented (DORMANT screening — non-canonical) |
| Cross-tenant RAG | PARTIAL | RLS tenant isolation is canonical and probe-verified at the storage layer; RAG-path production-class tenant evidence absent |

### 6.6 COMMERCE

| Item | Status | Canonical evidence / note |
| --- | --- | --- |
| Real PSP integration | MISSING (P6) | payments = provider-neutral intents gated by the action runtime; "cannot become real financial facts before independent verification"; **DORMANT has Stripe/M-Pesa/Flutterwave/Pesapal/Airtel/PayPal adapters — non-canonical** |
| Settlement / refunds / disputes | PARTIAL | revenue-ledger refund reversals; reconciliation read-only with pending-external/disputed outcomes; no real settlement |
| Marketplace economics | PARTIAL (governed, offline) | CCP + portfolio-governor + autonomous-venture-factory + commercial-intelligence (recommendation-only, evidence-gated); no live marketplace |
| Installation/update lifecycle | MISSING (P6) | DORMANT has 15-product portfolio — non-canonical |
| Metering / subscriptions | PARTIAL | billing plans/subscriptions/invoices (storage-backed, dev class); verified-payment-only activation |
| Universal wallet | MISSING (canonical) | T09 per-currency money/wallet/FX is canonical (implemented, F-6 register open); DORMANT universal-wallet double-entry — non-canonical |
| Revenue sharing | MISSING | none |

### 6.7 PLATFORM / UX

| Item | Status | Canonical evidence / note |
| --- | --- | --- |
| Production API gateway | MISSING (canonical) | CLI + embedded host only; **DORMANT has HTTP gateway, WebSocket streaming, /v1 versioning, TLS, CORS — non-canonical** |
| Adaptive dashboard | MISSING | DORMANT-only |
| Visual OS / marketplace | MISSING | DORMANT-only |
| Branding | MISSING | DORMANT-only |
| Multi-process/multi-node operation | PARTIAL | 32-process test evidence; single-host operation; no multi-node runtime |

### 6.8 PRODUCTION

| Item | Status | Canonical evidence / note |
| --- | --- | --- |
| VPS/cloud | MISSING | infrastructure-state-registry = adapter-only records; **no production deployment exists (NOT READY)**; DORMANT has Terraform EKS/RDS/S3 + deploy.sh/backup.sh with "LIVE withheld pending real infrastructure" — non-canonical |
| Orchestration | MISSING | none (DORMANT: K8s — non-canonical) |
| TLS/DNS | MISSING (canonical) | DORMANT-only (ACME flow) |
| KMS/HSM | CONTRACT + EXT (D2) | contract enforced; provider unselected |
| HA PostgreSQL | MISSING | single embedded/dev PG; no HA |
| Backup/PITR | MISSING (canonical) | DORMANT backup.sh/S3 — non-canonical |
| DR | MISSING | DORMANT claims multi-region DR — non-canonical |
| Observability | PARTIAL | structured logging; security-state health invariants; PG-status CI step; **no metrics/traces/logs exporters** (DORMANT: OTel/Prometheus — non-canonical) |
| Incident response / rollback | PARTIAL | adapter-level confirmed-rollback records; no IR process (P7) |
| Rollback | PARTIAL | deployment/CCP rollback recording only |
| Capacity | MISSING | R2-OBS-03/GAP-10 load characterization absent (operational) |
| Deployment automation | MISSING (P7) | DORMANT-only |
| CI as merge gate (R-9) | **OPEN — verified §1.4** | ruleset lacks `required_status_checks`; admin token required |

### 6.9 EXECUTION ACCELERATION (120% requirement assessment)

Every item of the mandated 120% acceleration list is **MISSING in the
canonical tree**: parallel DAG execution; speculative execution;
artifact/component caches; semantic/result caching; incremental builds/tests;
prewarmed workers; latency-aware Model Fabric routing; fast local-model
routing; automatic parallelization; streaming results; cancellation of losing
branches; failure-aware retries; deadline-aware routing; execution-time
prediction; continuous performance optimization. The canonical `unified-loop`
is deterministic and sequential by design (governance-first); the only
performance artifact is `r2-perf.json` (R2 security-state latency,
documentation-grade). This entire layer is 120%-stretch work (§10), sequenced
after the 95% path.

### 6.10 Cross-cutting evidence/governance gaps (affect every future milestone)

1. **E4 report durability** — the loss pattern has now recurred three times
   (T09, S-1/R2, P1, and again INV-15): independent-verification verdicts
   survive as PR-ATTESTATION; reports are uncommitted/lost. Until a
   report-durability rule is enforced, **every milestone's credit stays capped
   below E4 in the canonical record** — the single largest structural blocker
   to score movement.
2. **v1.0 rubric absence (P0R-RUB-02)** — blocks per-dimension worksheets.
3. **Rubric v1.1 unmerged** — normative text lives on remote branch `36f0026`
   (durable, but off-main).
4. **D1–D4 owner decisions pending** (static-token production admissibility;
   KMS/HSM provider; production DB role names/provisioning; slice granularity).
5. **G10 evidence track blocked on egress** (time-sensitive).
6. **G19 source watch** (passive).
7. **P1C-OBS-01 harness flake** (separate authorization).
8. **Dormant-stream disposition** — owner strategy decision: reference-only
   vs. selective port vs. integration program (each with its own
   verification/provenance burden). **Not recommended here; recorded.**
9. **PR #1 (OPEN, pre-program)** — governance housekeeping: close or advance;
   it is the dormant stream's original head lineage.

---

## 7. Prioritization & top-3 candidate milestones

Ranking per the eight mandated criteria (security criticality; P0 gate impact;
architectural dependency; implementation leverage; verification difficulty;
production-readiness impact; AI/product capability impact; risk of building on
unstable foundations).

### Candidate 1 — **P2: Production Identity & Privileged Plane** (Category B)

| Field | Value |
| --- | --- |
| Objective | Implement the P2 program against the canonical P1 contracts: provider-agnostic OIDC authenticator + production wiring; MFA (TOTP RFC 6238) + step-up enforcement; identity lifecycle (enrollment, recovery, deprovisioning, session/token rotation); privileged identity plane (attributed, least-privilege administration); production static-token policy finalized under D1 |
| Exact gaps addressed | T1 HIGH (bearer-only account takeover); identity-lifecycle MISSING set (P1 spec §7.2); ABAC/PAM partials; T17 insider-abuse improvement; D1 decision landing |
| Dependencies | Canonical: P1 S-8/S-9 substrate + `contracts.ts` (all present at `5d12cc5`). External: IdP vendor selection (mitigable: slice 1 is provider-agnostic OIDC; vendor wiring is a later slice) |
| Expected P0 impact | Identity dimensions move from MISSING; **the milestone's committed E4 report (covering the whole canonical tree incl. P1/R2/INV-15/P2) is what unblocks security-dimension credit** — magnitude unknown until assessed, none projected |
| Security impact | Closes the top-rated HIGH residual; converts secure-by-denial ingress into operated secure ingress |
| Complexity | LARGE (new authenticator plane, lifecycle stores, MFA, privileged surface) — but fully sliceable against existing contracts |
| Verification burden | HEAVY (adversarial campaign + E4+ independent verification of exact artifact; committed report) |
| Likely files/packages | `packages/authentication` (OIDC authenticator, TOTP, lifecycle, rotation), `packages/cli` (posture/invariants: static-token policy), `packages/authorization-boundary` (privileged principal handling), `packages/loop-host` (dispatch re-validation), `docs/verification/` (E4 report + assessment), new `packages/identity-*` if the owner prefers a new workspace |
| Bounded milestone? | YES — five slices, each independently verifiable; P3–P7 explicitly out of scope |
| Acceptance criteria | (per-slice, pre-fixed at authorization): OIDC verification (signature/issuer/audience/replay/clock) fail-closed suite; two-process revocation + MFA step-up live tests; lifecycle state machine (enroll/recover/deprovision) with durable evidence; privileged-plane tests (no non-privileged path can perform privileged ops); production static-token posture per D1; full 50/50 regression; committed E4+ report; explicit governance closure |
| Rollback boundary | P2 additions are additive over the P1 composition; rollback = revert P2 commits to the `5d12cc5`-line tree; P1/INV-15 invariants remain enforced; no P2 state is required by pre-P2 composition (contracts tolerate absence) |

### Candidate 2 — **E4-Durable Verification & v1.1 Re-Assessment of canonical `5d12cc5`** (Category K — evidence/verification work, explicit justification)

| Field | Value |
| --- | --- |
| Objective | One separate-party E4+ independent-verification pass over the entire canonical tree (A-01 + R2 + P1 + INV-15), report committed to `docs/verification/` under a report-durability rule; first **post-INV-15** v1.1 scoring assessment (expected: 9.484375% preserved, with the P1/INV-15 security group becoming assessable rather than credit-blocked); rubric v1.1 text promoted into main via a governance docs-PR (adoption, not modification) |
| Exact gaps addressed | §6.10 items 1–3 (E4 durability loss pattern; v1.1 off-main); the structural cap on all security-dimension credit |
| Dependencies | Separate verifier; no external infra |
| Expected P0 impact | **The only near-term lever for material, rule-legal score movement** — the largest built-and-integrated-but-uncredited body (P1+R2+INV-15) becomes assessable under V2–V5 with E4 evidence on the exact artifact. No magnitude projected (assessment-only) |
| Security impact | None directly (no code); high assurance value (re-verifies the INV-15 residual threads, incl. the pending A-grade re-verification of PR #28) |
| Complexity | SMALL–MEDIUM (verification + assessment + docs); possible small remediation slice if findings emerge (separately scoped) |
| Verification burden | It IS the verification |
| Likely files | `docs/verification/` (E4 report, assessment, report-durability rule), `docs/rubric/JATA-P0-95-v1.1.md` (promotion into main via docs-PR), findings-remediation docs if any |
| Bounded milestone? | YES — pure evidence/docs, zero product surface |
| Acceptance criteria | Committed E4 report on exact artifact `5d12cc5` (or successor); v1.1 worksheet with per-rule citations (V1–V5, X1–X3, R1–R4); score either preserved or moved strictly per rubric; rubric text in main (unmodified content); loss-pattern recurrence = 0 |
| Rollback boundary | Docs-only; revert deletes the reports; no product state touched |
| Why candidate and not recommendation | It is not an *implementation* milestone (the next explicit authorization sought is for implementation); it is **folded into Candidate 1's mandatory verification track** and additionally recommended as a standalone parallel authorization (it can start immediately and de-risks every later milestone) |

### Candidate 3 — **CI/G10 Governance & Evidence Track** (Category K — evidence + governance, parallel)

| Field | Value |
| --- | --- |
| Objective | (a) G10: retrieve job log `101868167969` from an egress-capable environment (or preserve it), attribute the failure, disposition under explicit authorization, canonical-CI determination, governance closure record; (b) R-9: add `required_status_checks` for "build · lint · test" to ruleset `20134880` (admin token); (c) P1C-OBS-01: O-2-pattern bounded readiness retry in `pg-test-harness.ts` (test/harness-only) |
| Exact gaps addressed | G10 release gate (time-sensitive: retention decay); R-9 (red merges possible today — verified §1.4); P1C-OBS-01 (CI/test reliability; same signature class as the 3 red post-merge runs) |
| Dependencies | Egress-capable environment for (a); admin token for (b); separate authorization for (c) |
| Expected P0 impact | Score-neutral (~0 pp by rubric class) but closes a mandatory release gate and reduces the recurrence probability of the exact signature that produced G10 |
| Security impact | Test-integrity/CI-integrity only; no product security surface |
| Complexity | SMALL |
| Verification burden | LIGHT (evidence + governance records; (c) gets normal test verification) |
| Likely files | `packages/storage-postgres/test/pg-test-harness.ts` (c); `.github`/ruleset (b, API-side); `docs/verification/G10_*.md` (a) |
| Bounded milestone? | YES (three tiny tracks, each independently authorized) |
| Acceptance criteria | (a) attributed failure + disposition + closure record; (b) ruleset contains required_status_checks, verified live; (c) 3 consecutive green post-merge runs + harness regression suite |
| Rollback boundary | (a) docs-only; (b) ruleset rule removal; (c) harness revert (test-only) |

### Ranking rationale (summary)

1. **Candidate 1 (P2)** ranks first on security criticality (top HIGH residual),
   P0 gate impact (identity dimensions + the E4-unblock attached to its
   verification), and leverage (successor program in the frozen handoff
   roadmap; builds on the most stable substrate the program has yet produced).
   Its verification burden is the highest, but the dependency surface is
   entirely canonical (no external block: IdP selection is deferrable behind a
   provider-agnostic first slice).
2. **Candidate 2** ranks second overall but **first in score leverage per unit
   of work**; it is recommended as a parallel standalone authorization and is
   structurally embedded in Candidate 1's exit criteria.
3. **Candidate 3** is the mandatory parallel evidence/governance track
   (release-gate + time-sensitive), not a substitute for an implementation
   milestone.

Not ranked as top-3: P3 (correctly sequenced after P2 — execution binds
verified principals), P4 (large; needs the P1–P3 substrate and is where D07
modalities and Model Fabric score credit come from — the #4 item), P5/P6/P7
(tail of the frozen roadmap), G19 (passive watch), dormant-stream integration
(owner strategy decision, unquantified, unverified asset).

---

## 8. Recommended next milestone

> **RECOMMENDED (not authorized): Candidate 1 — P2: PRODUCTION IDENTITY &
> PRIVILEGED PLANE.**
> **Classification: B — Identity and access.**

### Why it has the highest leverage at the current canonical state

1. **Highest remaining security criticality.** Every other HIGH residual is
   either P3/P7-dependent or operational (T10/T18); T1 (bearer-only account
   takeover, HIGH) is the only HIGH that a near-term implementation milestone
   can close, and it sits at the top of the threat model.
2. **Builds on the most stable foundation the program has produced.** P1's
   enforced composition, A-01's authoritative boundary, R2's durable state,
   and now INV-15's scope minimization are merged, green, and CI-verified at
   `5d12cc5`. P2 is the frozen handoff roadmap's designated successor (P2
   after P1), so it carries no roadmap-reordering risk. "Risk of building on
   unstable foundations" — the lowest of all implementation candidates.
3. **The score path, honestly.** The structural blocker to score movement is
   the missing committed E4 evidence (§6.10.1), not missing code. P2's
   mandatory exit verification is a **whole-canonical-tree E4 pass with the
   report committed** — one act that (a) verifies P2 and (b) retroactively
   converts the entire P1+R2+INV-15 security body from PR-ATTESTATION to
   assessable E4 evidence under v1.1. No point projection is offered; the
   magnitude is unknown until assessed (P1-CLOSURE §7 precedent).
4. **Externally minimally dependent.** The only external input (IdP vendor)
   is deferrable: slice 1 (provider-agnostic OIDC + MFA + lifecycle against
   the existing `contracts.ts`) is implementable and verifiable today; vendor
   wiring lands in a later slice. D1–D4 are owner decisions, not access
   blocks.
5. **Bounded and rollback-safe.** Five slices, additive over P1, contracts
   tolerate absence, rollback = revert to the P2 base without touching P1/
   INV-15 invariants.
6. **Precedent-consistent.** The program has moved exactly this way before:
   audit → authorization → implementation → E4 → merge (P1, INV-15). P2
   continues the sequence without expanding scope (P3–P7, production, 120%
   excluded).

### Mandatory pre-authorization prerequisites (enumerated, per prior-recon §10 discipline)

1. Scope text naming the five P2 slices and explicitly excluding P3+/production/120% (and the dormant stream).
2. D1–D4 resolutions recorded (D1: static-token production default; D2: KMS/HSM direction — contract-first acceptable; D3: role names/provisioning mechanism; D4: slice granularity).
3. G10/G19 handling stated (parallel evidence track per Candidate 3; passive G19 watch; no silent closure).
4. **Report-durability rule:** every independent-verification report committed under `docs/verification/` before merge (loss-pattern closure).
5. Verification criteria fixed before implementation (adversarial plan, E4+ by a separate party, exact artifact identification).
6. Scoring rules (v1.1 only; V2–V5 honored; no projection as achievement; E4 required on the exact artifact).
7. Governance sequence preserved (audit → authorization → implementation → test → commit/push → PR → independent verification → explicit merge authorization → merge → post-merge verification).

---

## 9. Dependency graph

```
 FROZEN BASE (5d12cc5, CI green, 9.484375% preserved)
        |
        +--[PARALLEL EVIDENCE TRACK — Candidate 3, own authorizations]
        |     G10 log retrieval (egress-capable env) -> attribution
        |         -> disposition -> canonical-CI determination -> closure record
        |     R-9 branch protection (admin token: required_status_checks)
        |     P1C-OBS-01 harness fix (test-only, O-2 pattern)
        |     G19 passive source watch (no active work)
        |
        +--[PARALLEL EVIDENCE — Candidate 2, own authorization]
        |     E4 whole-tree verification of 5d12cc5 (A-01+R2+P1+INV-15)
        |         -> committed report + first post-INV-15 v1.1 assessment
        |     Rubric v1.1 promotion into main (docs-PR; content unmodified)
        |
        +==[IMPLEMENTATION — Candidate 1 (RECOMMENDED): P2]=====================
              P2-S1 provider-agnostic OIDC authenticator + production wiring
                   (deps: canonical contracts.ts, S-8/S-9 substrate)
              P2-S2 MFA (TOTP RFC 6238) + step-up enforcement  (deps: S1)
              P2-S3 identity lifecycle: enroll/recover/deprovision/rotation  (deps: S1,S2)
              P2-S4 privileged identity plane (deps: S1-S3; D1-D4 recorded)
              P2-S5 production static-token policy per D1 + adversarial campaign
              P2-EXIT whole-tree E4+ verification (covers P1+R2+INV-15+P2)
                   -> COMMITTED report (durability rule) -> explicit merge
                   -> post-merge verification -> v1.1 assessment (no projection)
        =================================================================================
              |
              v
              P3 — Contained Execution & Governed Egress
                   (deps: P2 verified principals; closes T8/T9/T4 residuals)
              |
              v
              P4 — Production Knowledge + Model Fabric
                   (deps: P1-P3 substrate; D07 modalities + D2 KMS;
                    largest remaining capability-credit surface)
              |
              v
              P5 — Autonomous Prompt Compiler   (deps: P4 Model Fabric)
              |
              v
              P6 — Product & Economic Integration
                   (deps: P5; T09 L-series + PSP governance; D2/D3)
              |
              v
              P7 — Production Qualification
                   (deps: everything; SBOM/provenance [T18], HA/PITR, DR,
                    deployment automation, runbooks, kill-9 harness,
                    GAP-10/GAP-13 operational evidence, R-9 already closed)
              |
              v
              95% RELEASE THRESHOLD  (all floors + critical/high gates PASS
              + G10 CLOSED + G19 dispositioned-or-waived-by-source-reappearance
              + committed E4 chain + exact-artifact promotion)
              |
              v
              S1 — 120% STRETCH (forbidden until 95% + gates pass)
```

Cross-edges: the parallel evidence tracks must be CLOSED before any release
claim but do not gate P2 authorization (precedent: P1/INV-15 merged with G10
OPEN). The dormant stream is an off-graph asset: if the owner elects
integration, it enters as a separately audited program (its own E4 burden)
and must not be merged into the P1–P7 sequence without its own governance
record.

---

## 10. 95% roadmap (dependency-aware; no percentage claims without rubric support)

### Layer 0 — Foundational blockers (gates everything)

| # | Item | Type | Notes |
| --- | --- | --- | --- |
| 0.1 | G10 closure (evidence track, Candidate 3a) | EVIDENCE + GOVERNANCE | Time-sensitive (retention decay); score-neutral; release-mandatory |
| 0.2 | G19 source watch | PASSIVE | Close only on original-source reappearance; no invention |
| 0.3 | E4 report-durability rule + whole-tree E4 of `5d12cc5` (Candidate 2) | EVIDENCE | Structural unblock for security-dimension credit; kills the loss pattern |
| 0.4 | Rubric v1.1 promotion into main (docs-PR) | GOVERNANCE | Durable canonical text; content unmodified (not a rubric modification) |
| 0.5 | R-9 branch protection (CI = required merge gate) | GOVERNANCE (admin token) | Prevents recurrence of the G10-class red-merge condition (verified open today) |
| 0.6 | D1–D4 owner decisions recorded | GOVERNANCE | Prerequisite for P2/P7 scoping |

### Layer 1 — Critical security gates

| # | Item | Type | Closes |
| --- | --- | --- | --- |
| 1.1 | **P2 — Production Identity & Privileged Plane** (RECOMMENDED) | IMPLEMENTATION | T1 HIGH; identity-dimension zeros |
| 1.2 | P3 — Contained Execution & Governed Egress | IMPLEMENTATION | T8/T9 MEDIUM-HIGH; T4 MEDIUM; sandboxing/OS-isolation/SSRF/governed-egress gaps |
| 1.3 | D2 KMS/HSM production provider (external selection + wiring against the P1 KMP contract) | IMPLEMENTATION + EXT | T4 improvement; credential-at-rest |
| 1.4 | P1-GAP-12 optional keyed envelope digest (defense-in-depth; small) | IMPLEMENTATION | tamper-evidence → origin-authenticity upgrade (optional) |

### Layer 2 — Production gates

| # | Item | Type | Closes |
| --- | --- | --- | --- |
| 2.1 | P7 — Production Qualification: SBOM/provenance verification | IMPLEMENTATION + EVIDENCE | T18 HIGH |
| 2.2 | P7 — HA PostgreSQL, backup/PITR, DR, role provisioning (D3), capacity (GAP-10), retention/GC ops (GAP-13) | INFRASTRUCTURE + EVIDENCE | T10 HIGH (mitigated); operational gaps |
| 2.3 | P7 — deployment automation, runbooks, incident response, rollback, kill-9/node-loss harness, health/metrics exporters | INFRASTRUCTURE | release-mandatory qualification |
| 2.4 | P1C-OBS-01 harness remediation (Candidate 3c) | TEST/HARNESS | CI reliability (G10-signature class) |

### Layer 3 — AI intelligence capabilities (score-critical: D07 modalities)

| # | Item | Type | Notes |
| --- | --- | --- | --- |
| 3.1 | P4 — Production Knowledge + Model Fabric: production vector persistence/ANN, governed memory, semantic retrieval at production evidence class, hallucination/retrieval-poisoning controls, cross-tenant RAG evidence, Model Fabric (routing/cost/fallback/evaluation) | IMPLEMENTATION | Largest remaining capability-credit surface; D2 feeds it |
| 3.2 | P5 — Autonomous Prompt Compiler (intent → requirement extraction → context → decomposition → Prompt IR → engine prompting → execution → evaluation → diagnosis → refinement → strategy learning → governed feedback) | IMPLEMENTATION | D07 general-agent/coding modalities; builds on unified-loop governance |

### Layer 4 — Product/platform capabilities

| # | Item | Type | Notes |
| --- | --- | --- | --- |
| 4.1 | P6 — Product & Economic Integration: real PSP(s), settlement/refunds/disputes, metering/subscriptions at production class, revenue sharing, install/update lifecycle, marketplace | IMPLEMENTATION + EXT | T09 L-series (L-1..L-8) + F-6 register items land here |
| 4.2 | Platform surface (production API gateway, adaptive dashboard, Visual OS, branding, multi-node operation) | IMPLEMENTATION | **Strategy decision required first: canonical-build vs. selective port from the dormant stream vs. integration program** (§1.3, §6.10.8). Any port carries full E4 re-verification — dormant code is unverified |

### Layer 5 — Evidence/verification work (continuous, per-milestone)

- Every milestone: separate-party E4+ verification, **report committed before
  merge**, exact-artifact identification, post-merge verification.
- First post-INV-15 v1.1 assessment (Candidate 2) and one after each Layer-1/3
  milestone — assessments may only move the score per v1.1 rules (V1–V5,
  X1–X3, R1–R4); **no percentage increase is claimed anywhere in this roadmap
  except as a rubric-supported assessment outcome.**
- G10/G19 tracks run until closed (release-mandatory).
- The old informal ~35% architectural score is **not used** anywhere; P0
  scoring is v1.1-only.

**Explicit non-roadmap items:** rubric redesign (P0R-RUB-03, separate
versioned review); any 120% work; dormant-stream integration (owner strategy
decision); production deployment (P7 tail only).

---

## 11. 120% roadmap (stretch — strictly after 95% + all gates)

Prerequisite (handoff §12, verbatim conditions): 95% baseline achieved; all
mandatory release/security gates pass; each stretch capability implemented;
independent evidence demonstrates it. **Nothing below is authorized.**

| # | 120% stretch capability | Canonical foundation (what exists to build on) | Gap to stretch |
| --- | --- | --- | --- |
| 11.1 | Proprietary JATA model evolution | agent-runtime LLM interface; capability-fabric lifecycle evidence | Full absence in canonical (training/distillation/specialization pipeline) |
| 11.2 | Advanced Model Fabric | P4 (Layer 3.1) once delivered | Cost/latency-aware routing, cross-provider evaluation, fallback orchestration at production scale |
| 11.3 | Autonomous Prompt Compiler (full) | P5 (Layer 3.2) once delivered; unified-loop governance | Strategy learning + governed feedback loops + cross-run refinement |
| 11.4 | Cross-model deliberation | multi-agent-cognition (injected-reviewer critique, non-executing) | Executing multi-model debate panels with arbitration + evidence |
| 11.5 | Autonomous software construction | copilot-execution-adapter, autonomous-test-repair, autonomous-deployment, github-execution (all adapter-only, gated) | Production-grade autonomous build/test/deploy with real external effects under the A-01 boundary |
| 11.6 | **Execution Acceleration Layer** (the mandated 120% requirement) | Deterministic sequential unified-loop; r2-perf baseline | Parallel DAG execution; speculative execution; artifact/component caches; safe semantic/result caching; incremental builds/tests; prewarmed workers; latency-aware Model Fabric routing; fast local-model routing; automatic parallelization; streaming results; cancellation of losing branches; failure-aware retries; deadline-aware routing; execution-time prediction; continuous performance optimization |
| 11.7 | Advanced self-evaluation | meta-reasoning forecast/error/calibration registry; hypothesis-engine; research-evidence | Executing self-evaluation with calibrated confidence + drift-triggered behavior change (governed) |
| 11.8 | Governed self-improvement | capability-fabric (lifecycle evidence gates), autonomous-venture-factory, commercial-memory (prohibited-strategy records) | Closed-loop self-modification proposals → verification → gated activation; DORMANT has "self-evolution" modules — non-canonical, unverified, not a base |
| 11.9 | Ecosystem/marketplace autonomy | CCP + portfolio-governor + UVF (recommendation-only, evidence-gated) | Autonomous marketplace operations (listing/pricing/fulfillment) under human-governed economic gates |
| 11.10 | Advanced commercial intelligence | commercial-intelligence (WAIT_FOR_EVIDENCE/DO_NOT_PURSUE/HUMAN_REVIEW outcomes) | Autonomous pursuit decisions within budgeted, revocable authority + real provider economics |

**Strict separation:** rows 11.1–11.10 are 120% stretch. The 95% release
requirements are exclusively Layer 0–5 of §10 plus the handoff §5 gate list.
Nothing in §11 counts toward 95%; nothing in §10 claims 120%.

---

## 12. Unresolved evidence limitations (explicit register)

| # | Limitation | Consequence | Owner/action (NOT performed here) |
| --- | --- | --- | --- |
| L-1 | G10 job-log content unreachable from both sandbox sessions (Azure-blob egress blocked); retention setting unverified; decay risk | G10 stays OPEN/UNATTRIBUTABLE; release gate open | Evidence-only authorization + egress-capable environment (or human retrieval); optional log-preservation decision |
| L-2 | G19 F3–F12 source absent from the entire repository (all refs) and all GitHub records; session-external sources not reachable/authoritative | G19 stays UNRECOVERED | Passive watch; close only on authoritative source reappearance |
| L-3 | v1.0 base rubric text absent (P0R-RUB-02) | Per-dimension worksheets impossible; floors/gates values unenumerable | Separate versioned rubric governance (P0R-RUB-03) — not authorized |
| L-4 | Independent-verification reports uncommitted (T09/S-1/R2/P1/INV-15 pattern) | All P1+INV-15 claims capped at PR-ATTESTATION; security-dimension credit blocked | Report-durability rule + Candidate 2 whole-tree E4 |
| L-5 | Rubric v1.1 normative text on unmerged branch `36f0026` | Canonical main references an off-main spec | Docs-PR promotion (content unmodified) |
| L-6 | D1–D4 owner decisions pending | P2/P7 scope ambiguities | Owner record at next authorization |
| L-7 | P1C-OBS-01 documented-not-remediated | CI/test reliability exposure (G10-signature class) | Separate test-only authorization |
| L-8 | Dormant stream (167 commits, tag v1.0.0) unverified, unassessed, unmerged | Platform/commerce/AI cost estimates uncertain; integration decisions carry full E4 burden | Owner strategy decision (§6.10.8) |
| L-9 | PR #1 open (pre-program, dormant head lineage) | Governance hygiene | Close or advance under owner direction |
| L-10 | R-9: CI not a required merge gate (verified live today) | Red merges possible | Admin-token ruleset change |
| L-11 | Dimension floors / v1.0 gate values absent from canonical record | Release-gate enumeration incomplete | Subsumed by L-3 |
| L-12 | INV-15 fresh A-grade re-verification pending (B-grade verdict + remediated F1–F3; merge executed) | Closure record relies on merge authorization + CI green; E4 report uncommitted | Folded into Candidate 2 whole-tree E4 |

---

## 13. Explicit governance status

**This reconnaissance performed, and only:**

- read-only git operations (status/log/diff/cat-file/ls-remote; deepening
  fetch of history and refs — no canonical state modified; worktree clean at
  start and after all commands);
- read-only GitHub API reads (PR records, run/job metadata, branch/tag/ruleset
  state, commit metadata);
- two G10 job-log GET attempts that transferred **zero content bytes** (SAS
  redirects issued; blob egress blocked). No log content was retrieved in
  this session; no CI rerun was triggered.

**This reconnaissance did NOT, and this document does NOT:**

- authorize any implementation, milestone, or authorization;
- commit, push, open a PR, merge, or deploy anything (this file is the sole
  worktree addition and is UNCOMMITTED/UNPUSHED);
- authorize or perform G10 repair or disposition (G10 = OPEN / UNATTRIBUTABLE
  preserved);
- invent, rename, substitute, or map anything into F3–F12 (G19 = UNRECOVERED
  preserved);
- modify, extend, or re-adopt the rubric in any way (v1.1 unmodified; v1.0
  absence recorded, not repaired);
- remediate P1C-OBS-01;
- authorize P2/R3/production/120% or any dormant-stream action;
- award, project, or claim any score change (P0 = 9.484375% PRESERVED).

**Governance model (preserved verbatim for all future work):**

```
AUDIT → AUTHORIZATION → IMPLEMENTATION → TEST → COMMIT/PUSH → PR →
INDEPENDENT VERIFICATION → EXPLICIT MERGE AUTHORIZATION → MERGE →
POST-MERGE VERIFICATION
```

This recon occupied the AUDIT position only.

**STOP.**
