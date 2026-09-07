# PR #20 Merge — Post-Merge Verification (Evidence Record)

Durable evidence record of the post-merge verification of canonical `main` **`700ae80`** (merge of
PR #20). Created by the **R-2** evidence-durability execution (2026-09-07, documentation-only). It
preserves (a) the contemporary post-merge CI record, (b) the session-recorded post-merge results,
and (c) the R-2 **independent re-execution** of the full gates on the identical merged tree.

| Field | Value |
| --- | --- |
| Document type | Post-merge verification evidence record |
| Subject | Canonical `main` after merging PR #20 |
| Verified SHA | `700ae8000ee9303bf1ea6289d0eab90085ffb597` (merge of PR #20; parents `82af3de` + `8fc13ee`) |
| Merged at | 2026-09-07T01:23:53Z (GitHub) |
| Post-merge CI | Run **`34072884374`** — success (push event, head `700ae80`) |
| R-2 record branch / HEAD | `arena/01a07b19-jata-qi` · `700ae8000ee9303bf1ea6289d0eab90085ffb597` |
| R-2 execution node | Node `v22.22.3`, npm `10.9.8` |

---

## 1. Provenance classification vocabulary

Material facts below carry one of: **CONTEMPORANEOUS** (directly preserved original evidence),
**INDEPENDENTLY RE-EXECUTED** (freshly reproduced in this repository during R-2),
**RECONSTRUCTED** (derived from surviving records; source stated), **SESSION-RECORDED** (present in
the preserved session record), **UNAVAILABLE/LOST** (not recoverable).

## 2. The merged tree is the verified tree

- `tree(700ae80) == tree(8fc13ee)` (both `165e6c36…`) — the merge introduced **no** conflict
  resolution; canonical `main`'s content is byte-identical to the final PR #20 head.
  **(CONTEMPORANEOUS — git tree hashes, computed during R-2.)**
- The final PR #20 head differs from the S-1-verified commit `121eaa4` by exactly one
  documentation file (`docs/T09_F_REGISTER_RECONSTRUCTION.md`). Hence the product code merged into
  `main` is byte-identical to the code that passed the S-1 independent verification (82/82 probes,
  924/924 tests), with the F-register documentation as the only addition. (The earlier R-1/R-4
  fixes are proper ancestors of that code — S-1 subsequently modified some of the same files — so
  their 840/840 record applies to `c45cfc1`, not to the merged tree.) **(RECONSTRUCTED — from
  `PR20_FINAL_PREMERGE_REVIEW.md` §3 items 2–3 and git diffs.)**

## 3. Contemporary post-merge evidence

| Evidence | Value | Provenance |
| --- | --- | --- |
| GitHub Actions run `34072884374` | **conclusion `success`**, event `push`, head `700ae80` | CONTEMPORANEOUS — Actions API (read during R-2); run id also given in the R-2 directive (SESSION-RECORDED) |
| Post-merge full-suite result | **924/924 tests passed** | SESSION-RECORDED — stated in the R-2 directive; independently corroborated by the R-2 re-execution below and by the committed 924/924 record at the product-identical S-1 head `121eaa4` (the only difference at `8fc13ee`/`700ae80` is documentation) |
| Post-merge adversarial probes | **83/83 adversarial probes passed** | SESSION-RECORDED — stated in the R-2 directive only; the probe enumeration is **UNAVAILABLE/LOST** in-repo and is not mechanically reconcilable from committed evidence (the S-1 independent cycle recorded 82/82 at `121eaa4`; the in-repo S-1 adversarial suites number 84 cases across 6 suites — a different, committed enumeration; do not conflate the three) |

## 4. R-2 independent re-execution (fresh, on this checkout)

Run by the R-2 execution on **2026-09-07** in a fresh install of the identical tree at HEAD
`700ae80` (working tree clean apart from the as-yet-uncommitted `docs/verification/*` records —
markdown under `docs/` is not an input to any gate: `check:workspaces` compares package manifests
and the lockfile, `build` compiles `packages/*`, `lint` targets `packages scripts
eslint.config.mjs`, and `test` executes workspace test suites). Executed results are recorded in
§5.

## 5. Executed gate results (this R-2 run)

Executed 2026-09-07 by the R-2 session on the identical merged tree (HEAD `700ae80`, clean
worktree apart from the uncommitted `docs/verification/*` records; Node `v22.22.3`, npm `10.9.8`).
Markdown under `docs/` is not an input to any gate (`check:workspaces` compares package manifests
and the lockfile; `build` compiles `packages/*`; `lint` targets `packages scripts
eslint.config.mjs`; `test` executes workspace suites), so the recorded results hold for the
committed tree unchanged.

| Gate | Result |
| --- | --- |
| `npm ci` | exit 0 |
| `npm run build` | exit 0 — 49 workspaces compile, 0 TypeScript errors |
| `npm run lint` | exit 0 — 0 errors, 60 warnings (all pre-existing style warnings) |
| `npm test` | exit 0 — `Total: 49 · Passed: 49 · Failed: 0 · Skipped: 0`; aggregate **924 tests · 924 pass · 0 fail · 0 skipped · 0 todo** |
| PostgreSQL honesty gate | `SKIPPED: PostgreSQL integration` count = **0** — PostgreSQL suites genuinely executed (embedded PostgreSQL) |

The 924/924 result **independently corroborates** the session-recorded post-merge 924/924 and the
committed 924/924 record at the product-identical S-1 head `121eaa4`. The 83/83 adversarial-probe
figure remains SESSION-RECORDED only (see §3).

## 6. Standing context (explicitly preserved)

Post-merge verification does **not** change the standing posture: the security programme and
production gates (L-8) remain open; F-1…F-5, F-7 and F-8 of the lost T-09 register remain
**unrecoverable**; CI remains advisory on `main` (B-7) unless a ruleset change is separately
authorized. **(RECONSTRUCTED — sources: `T09_INDEPENDENT_VERIFICATION.md` §5–§6,
`R1_R4_REMEDIATION_VERIFICATION.md` §5, committed F-register.)** This record does **not** assert
that the merge — or R-2 — proves JATA Qi production-ready or fully hardened.

## 7. Sources (exact)

1. GitHub Actions API: run `34072884374` (post-merge push).
2. Git: `git rev-parse 700ae80^{tree}` vs `8fc13ee^{tree}`; commit metadata.
3. R-2 session record (R-2 directive: post-merge 924/924, 83/83, CI green).
4. Committed sibling records: `PR20_FINAL_PREMERGE_REVIEW.md`, `S1_INDEPENDENT_VERIFICATION.md`,
   `R1_R4_REMEDIATION_VERIFICATION.md`, `T09_INDEPENDENT_VERIFICATION.md`, F-register, S-1 doc.
