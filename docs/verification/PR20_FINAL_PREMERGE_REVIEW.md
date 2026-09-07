# PR #20 — Final Pre-Merge Review (Evidence Record)

Durable evidence record of the final pre-merge review of **PR #20** ("T-09: per-currency money,
per-currency wallet, injected FX", branch `arena/01a076d2-jata-qi`) against canonical `main`, and
of the merge decision that produced canonical `main` `700ae80`. Created by the **R-2**
evidence-durability execution (2026-09-07, documentation-only). The review-time checklist of the
merging session is only partially preserved; this record reconstructs the verifiable state from git
history, the preserved GitHub PR record, and the preserved CI records, and labels each fact.

| Field | Value |
| --- | --- |
| Document type | Final pre-merge review evidence record (reconstruction) |
| Pull request | [POWERBot-1/JATA-Qi#20](https://github.com/POWERBot-1/JATA-Qi/pull/20) |
| Repository | `POWERBot-1/JATA-Qi` |
| Head branch / head SHA (at merge) | `arena/01a076d2-jata-qi` · `8fc13eee5e36db0bd5a6549881829c68bc0dc2ab` |
| Base branch / base SHA | `main` · `82af3def9b8b26989b3f686369d17f03bb62ad9c` |
| Merge commit | `700ae8000ee9303bf1ea6289d0eab90085ffb597` |
| Pre-merge CI | Run **`34068205157`** — success at head `8fc13ee` |
| R-2 record branch / HEAD | `arena/01a07b19-jata-qi` · `700ae8000ee9303bf1ea6289d0eab90085ffb597` |
| Outcome preserved | Merged 2026-09-07T01:23:53Z by `app/arena-ai-coding-agent`; no merge-blocking item recorded |

---

## 1. Provenance classification vocabulary

Material facts below carry one of: **CONTEMPORANEOUS** (directly preserved original evidence — git
history, GitHub PR/Actions records), **INDEPENDENTLY RE-EXECUTED** (freshly reproduced during R-2),
**RECONSTRUCTED** (derived from surviving records; source stated), **SESSION-RECORDED** (present in
the preserved session record), **UNAVAILABLE/LOST** (not recoverable).

## 2. Object under review

PR #20 contained exactly **four commits** (in order): `0cb6b6b` (T-09), `c45cfc1` (R-1+R-4),
`121eaa4` (S-1), `8fc13ee` (F-register reconstruction, documentation-only). **(CONTEMPORANEOUS —
git history and `gh pr view 20 --json commits`.)** Aggregate diff versus base `82af3de`: **51
files, +7676 / −382** (GitHub API and git agree). **(CONTEMPORANEOUS.)**

## 3. Pre-merge verification state (as reconstructed)

| # | Evidence item | Recorded state at final review | Provenance |
| --- | --- | --- | --- |
| 1 | **CI on the final head** `8fc13ee` | Run `34068205157` — **success** | CONTEMPORANEOUS — Actions API (read during R-2: `head_sha` = `8fc13ee`, conclusion `success`); run id also SESSION-RECORDED |
| 2 | **Product-content identity with the independently verified S-1 head** | `git diff 121eaa4 8fc13ee` = **1 file** (`docs/T09_F_REGISTER_RECONSTRUCTION.md`, +419) — i.e. the final head's product code is byte-identical to `121eaa4`, the S-1 commit whose independent verification passed 82/82 probes and 924/924 tests | CONTEMPORANEOUS — git diff computed during R-2; the S-1 verification result per `S1_INDEPENDENT_VERIFICATION.md` |
| 3 | **S-1 verification (prior, at `121eaa4`)** | 82/82 adversarial probes, 924/924 tests; CI run `34065442942` success | RECONSTRUCTED — committed F-register §9 + Actions API (see `S1_INDEPENDENT_VERIFICATION.md`) |
| 4 | **CI on the S-1 head** | Run `34065442942` — success | CONTEMPORANEOUS — Actions API |
| 5 | **R-1/R-4 CI-gate health** | Run `34048251273` — success at `c45cfc1`; 840/840 tests | CONTEMPORANEOUS — Actions API + PR comments (see `R1_R4_REMEDIATION_VERIFICATION.md`) |
| 6 | **Mergeability** | Committed F-register header (written at `8fc13ee`, 2026-09-06T23:54:51Z): PR #20 "OPEN · UNMERGED (MERGEABLE / CLEAN)"; no conflicts with base `82af3de` | RECONSTRUCTED — committed `docs/T09_F_REGISTER_RECONSTRUCTION.md` header |
| 7 | **Merge-blocking findings** | None evidenced: the only reconstructed F-register item (F-6) is non-blocking with compensating controls; L-9 (the two red tests) fixed at `c45cfc1`; L-1…L-8 are documented non-blocking scope limitations | RECONSTRUCTED — committed F-register §4/§5/§9 |
| 8 | **Governance gate** | Ruleset `20134880` on `main` requires changes via a PR with resolved review threads; status checks are **advisory** (B-7) — so the merge decision is an explicit authorization act, not an automated gate | CONTEMPORANEOUS — committed S-1 doc §8.3 (rules API response quoted); ruleset state at the R-2 date not re-read |
| 9 | **Known-open items at merge** | Standing security programme, production gates (L-8), F-1…F-5/F-7/F-8 unrecoverable — none blocking, all recorded | RECONSTRUCTED — see `T09_INDEPENDENT_VERIFICATION.md` §5–§6 |

**UNAVAILABLE/LOST:** the merging session's own final pre-merge checklist document (if one existed
beyond the above) is not committed; the items above are the maximum verifiable reconstruction. The
R-2 directive records that "the previous recovery check established … R-2 has not been completed"
and that PR #20's merge produced canonical `main` `700ae80` — **(SESSION-RECORDED)** consistent
with the git/GitHub record.

## 4. The merge and its verification properties

- Merged at **2026-09-07T01:23:53Z** by **`app/arena-ai-coding-agent`** (GitHub: `state=MERGED`,
  `mergeCommit.oid=700ae80`). **(CONTEMPORANEOUS — GitHub API.)**
- Merge commit `700ae80` has parents **`82af3de` (main) + `8fc13ee` (PR head)** — a clean merge
  with **no merge-conflict resolution**: `tree(700ae80) == tree(8fc13ee)` (`165e6c36…`, verified
  with `git rev-parse <rev>^{tree}`). **(CONTEMPORANEOUS — git, computed during R-2.)**
- Consequence recorded for the post-merge record: canonical `main`'s product content is identical
  to the final pre-merge head, which itself differs from the S-1-verified commit only by one
  documentation file. **(RECONSTRUCTED — from the tree-equality and diff evidence above.)**

## 5. Post-merge re-verification

The post-merge verification is recorded in `PR20_MERGE_POSTMERGE_VERIFICATION.md` (post-merge CI
run `34072884374` and the R-2 independent re-execution of the gates on the merged tree).

## 6. Sources (exact)

1. GitHub API: `gh pr view 20` (state, head/base, mergeCommit, mergedAt, mergedBy, additions/deletions/changedFiles, commits).
2. GitHub Actions API: runs `34068205157`, `34065442942`, `34048251273`, `34072884374`.
3. Git history: commit metadata, `git rev-parse <rev>^{tree}`, `git diff 121eaa4 8fc13ee`.
4. Committed records: `docs/T09_F_REGISTER_RECONSTRUCTION.md` (header, §9); `docs/S01_TENANT_BOUNDARY_HARDENING.md` (§8.3).
