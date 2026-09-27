# P2-E4 owner-side verifier kit

**Preparation status:** OWNER/BUILDER PREPARATION ONLY
**Evidence class:** PRIMARY preparation material; not independent verification
**Prepared:** 2026-09-20 UTC
**Target:** P2-E4
**Exact artifact:** `08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe`
**Exact tree:** `5f2152ce0cd702b649b93bc23c165d36cb9b9dba`

## Governing boundary

This kit implements no product behavior and makes no E4 determination. It is a
reproducibility and logistics package for a future genuinely separate verifier.
It must not be relabeled as independent evidence, and it must not be used to
pre-author a PASS. The owner-side preparer may provide this kit, the public
repository, the exact SHA, acceptance criteria, and logistical assistance; the
future verifier must perform the assessment, record findings, and author the
final report in their own identity and environment.

The required report path remains:

`docs/verification/P2_S8_INDEPENDENT_VERIFICATION.md`

That file is deliberately **not** created by this preparation. A future
verifier must author it. A FAIL, a finding, or an unresolved limitation must
remain exactly that; this kit contains no PASS conversion mechanism.

The standing governance state is preserved:

- P2-E4: **NOT ACHIEVED**
- score: **9.484375% — FROZEN**
- production: **NOT READY**
- no score recalculation, rubric change, cap weakening, production change,
  unrelated remediation, or merge authorization is made here

## Contents

| File | Purpose |
|---|---|
| `GOVERNANCE_ROUTE_DETERMINATION.md` | Owner-side disposition of Paths A, B, and C; not a verifier verdict |
| `ELIGIBILITY_GATE.md` | Twelve-item separate-verifier gate and stop conditions |
| `REPRODUCTION.md` | Exact-SHA checkout, environment, ordered commands, hash checks, and retention rules |
| `ASSERTION_MATRIX.md` | Assertion-level A-17 through A-23 and mutation/negative-control plan |
| `EXPECTED_RESULTS.json` | Results declared before execution; these are expectations, not observations |
| `ENVIRONMENT_MANIFEST.json` | Required and recorded environment fields; values are `NOT_RECORDED` until a verifier runs |
| `EVIDENCE_MANIFEST_TEMPLATE.json` | Machine-readable evidence/provenance record template |
| `RESULT_RECORD_TEMPLATE.json` | Empty result record; it cannot be mistaken for an executed PASS |
| `INDEPENDENCE_DECLARATION_TEMPLATE.md` | Verifier-authored declaration scaffold; must be completed by the verifier |
| `PR_DELIVERY_AND_RETENTION.md` | Fork/PR, authorship, merge boundary, and durable-evidence instructions |
| `TARGET_INPUT_INVENTORY.md` | Human-readable exact-target input inventory and later-tree context boundary |
| `artifact-tree-manifest.json` | Git tree/blob hash inventory for the exact target, generated from the target object |
| `run-p2-e4-reproduction.sh` | Optional owner-provided runner; it only executes the declared sequence and emits observations; it does not author the required report |

## Read-only governance check recorded before preparation

| Check | Result |
|---|---|
| Current session branch | `arena/01a0be34-jata-qi` |
| Working tree | clean before preparation; preparation changes are confined to this kit and its runner |
| Current `HEAD` | `477aedb374580b0fe95d7c1f6f820ff68304b814` |
| Target object | resolved from GitHub and fetched as a read-only Git object; not checked out as the session `HEAD` |
| Target commit | merge PR #37; parents `2c1cad0ae9edbcc6ef13a241e120d3bb8de22415` and `0a25b7ebc9eb464c1332044b8ea24a5c640920a1` |
| Target tree | `5f2152ce0cd702b649b93bc23c165d36cb9b9dba`; 725 tracked paths |
| Current-tree relationship | current `HEAD` is later and contains post-target material; it is not an acceptable substitute |
| Score | `9.484375% — FROZEN` |
| Cap disposition | current standing record says P2-E4 **NOT ACHIEVED**; its §4.3 preserves only genuine retrospective verification |
| PR #39 | `OPEN`, `UNMERGED`, head `608a6ead7e6a018c29b872afa982ba99dcb9afcf`; CI check reported success; it is unrelated to P2-E4 verification |
| Independent report | `docs/verification/P2_S8_INDEPENDENT_VERIFICATION.md` absent by design and remains future-verifier work |

## Use order

1. Read `GOVERNANCE_ROUTE_DETERMINATION.md` and `ELIGIBILITY_GATE.md`.
2. Establish the verifier's identity and independence **before** execution.
3. Make a clean, detached checkout of the exact SHA; never substitute current
   `main` or a later commit.
4. Record the environment and expected results before running commands.
5. Run the ordered and focused suites in `REPRODUCTION.md`.
6. Run the negative/failure-injection and disposable-mutation checks without
   modifying the tracked target tree.
7. Record every observed result, including failures, skips, divergences, and
   limitations, in verifier-controlled records.
8. The verifier authors the required report, commits it from their own fork or
   identity, opens the PR, and stops before merge authorization.

If any stop condition in the gate is met, stop and report the blocker. Do not
contact, impersonate, create, or relabel a verifier from the owner side.
