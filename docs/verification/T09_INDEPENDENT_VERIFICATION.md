# T-09 Independent Verification — Evidence Record

**RECONSTRUCTION — ORIGINAL REPORT NOT RECOVERABLE**

Durable evidence record for the independent read-only verification of milestone **T-09**
(per-currency money, per-currency wallet, injected FX). The original verification report existed
only as an agent-side scratch file and was destroyed with its sandbox; this record preserves every
fact that survives in committed repository records, the preserved PR #20 record, and the committed
F-register reconstruction. It is created by the **R-2** evidence-durability execution
(2026-09-07, documentation-only).

| Field | Value |
| --- | --- |
| Document type | Independent-verification evidence record (reconstruction) |
| Scope | Read-only independent verification of T-09: per-currency minor-unit scale table, currency-required money helpers, per-currency wallet, injected FX, expand-only migration, currency-aware call sites |
| Repository / branch (subject) | `POWERBot-1/JATA-Qi` · `arena/01a076d2-jata-qi` (PR #20) |
| Baseline SHA | `82af3def9b8b26989b3f686369d17f03bb62ad9c` (pre-T-09 canonical `main`, merge of PR #19 / T-08.1) |
| Tested/verified SHA | `0cb6b6bd0aaf98e75cf1d71d7adb7f2564f65786` (T-09 commit) |
| R-2 record branch / HEAD | `arena/01a07b19-jata-qi` · `700ae8000ee9303bf1ea6289d0eab90085ffb597` (post-merge canonical `main`) |
| Surviving sibling records | `docs/T09_F_REGISTER_RECONSTRUCTION.md` (committed `8fc13ee`), `docs/T09_PER_CURRENCY_MONEY_AND_WALLET_FX.md` (committed `0cb6b6b`), PR #20 body/comments on GitHub, GitHub Actions run records |
| Outcome preserved | No merge-blocking item is evidenced among the recoverable record; 7 of 8 F-register entries remain UNRECOVERABLE (see sibling record). T-09's two pre-existing test failures were later fixed by the R-1 remediation (`c45cfc1`) |

---

## 1. Provenance classification vocabulary

Every material fact below carries one of these labels (per the R-2 evidence-integrity mandate):

| Label | Meaning |
| --- | --- |
| **CONTEMPORANEOUS** | Directly preserved from the original verification/report evidence — committed milestone documents, the preserved PR #20 body/comments, GitHub Actions run records, or git history itself. |
| **INDEPENDENTLY RE-EXECUTED** | Freshly reproduced in the current repository during the R-2 execution. |
| **RECONSTRUCTED** | Derived from surviving session evidence or committed repository records; the source used is stated. |
| **SESSION-RECORDED** | Explicitly present in the preserved conversation/session record (the R-2 directive and prior session reporting). |
| **UNAVAILABLE/LOST** | Evidence that cannot now be recovered. |

## 2. What is being recorded, and why it is a reconstruction

Milestone T-09 was implemented at `0cb6b6b` (author `POWERBot-1`, 2026-09-06T14:22:03Z, parent
`82af3de`). **(CONTEMPORANEOUS — git history.)** An independent read-only verification of that
commit was subsequently performed; its report was written only to an agent-side scratch file,
`t09-independent-verification.md`, **outside** the repository working tree. That file — and the
finding register (F-1 … F-8) it contained — was destroyed when the execution sandbox was recreated
between milestone cycles. **(UNAVAILABLE/LOST — established by the exhaustive S1–S11 search
recorded in `docs/T09_F_REGISTER_RECONSTRUCTION.md` §1–§2, committed at `8fc13ee`.)**

Consequently the *original full report text, its per-item wording, severities, and the mapping of
F-1…F-5, F-7, F-8 to technical issues* are not recoverable. What follows is every material result
that survives in primary or committed sources.

## 3. Scope verified (from the committed milestone document and PR #20 body)

**(CONTEMPORANEOUS — `docs/T09_PER_CURRENCY_MONEY_AND_WALLET_FX.md` committed at `0cb6b6b`; PR #20
body, preserved on GitHub.)** The T-09 verification scope covered acceptance criteria AC-1…AC-10:

| AC | Requirement |
| --- | --- |
| AC-1 | JPY 0dp rounding, half-up ties |
| AC-2 | KWD/BHD/OMR 3dp rounding, half-up ties |
| AC-3 | KES/default 2dp behaviour unchanged (regression suites bit-identical) |
| AC-4 | Wallet isolation, fail-closed withdrawal, mismatch fails closed |
| AC-5 | Injected FX, deterministic, target-scale, half-up, no PSP dependency |
| AC-6 | Reconciliation uses currency-aware canonical money semantics |
| AC-7 | Billing uses product currency scale, never assumes 2dp |
| AC-8 | Per-currency MRR and annual billing use correct minor units |
| AC-9 | No unsafe `===` on money, no hard-coded `100`, no unconditional `.toFixed(2)` |
| AC-10 | Build + lint + all regression suites pass (at T-09: subject to the 2 pre-existing failures below) |

## 4. Preserved results for the verified SHA `0cb6b6b`

**(CONTEMPORANEOUS — quoted from the committed T-09 milestone document and the preserved PR #20
body; both were written while the code at `0cb6b6b` was the subject. The R-2 directive repeats the
same figures — SESSION-RECORDED agreement.)**

| Gate | Result at `0cb6b6b` |
| --- | --- |
| Build | `npm run build` — exit 0, 49 workspaces compile |
| Lint | `npm run lint` — 0 errors, 60 warnings (base `82af3de`: 0 errors, 61 warnings; net −1 warning) |
| Tests | `npm test` — **821 tests, 819 pass, 2 fail, 0 skipped** (base `82af3de`: 754 / 752 / 2 / 0 → **+67 tests, +0 new failures, +0 skips**) |
| New T-09 suites | `money.per-currency` 22 · `t09-money-migration` 6 · `t09-wallet` 26 · `t09-per-currency` 13 |
| Per-package (touched) | commercial-control-plane 65 · payments 42 · commercial-command-center 16 · billing 6 · revenue-ledger 20 · reconciliation 6 · commercial-analytics 9 — all 0 failures |
| CI (GitHub Actions) | Run `34040029489` at `0cb6b6b` — **conclusion `failure`** **(CONTEMPORANEOUS — Actions API + F-register S9 + PR comment `5560923476`)** |

### 4.1 The two failures (pre-existing, unrelated to money)

**(CONTEMPORANEOUS — committed T-09 doc; PR comment `5560777167`.)** The 2 failures were
pre-existing on the base commit `82af3de` and unrelated to monetary code:

- `@jataqi/agent-runtime` — "knowledge.search tool hits the knowledge service"
- `@jataqi/cli` — "ingests text, extracts entities, and retrieves"

Both failed with `KnowledgeService: ingestText tenantId missing — falling back to
DEFAULT_TENANT_ID="default" ... Failing closed.` — a transitive consequence of the T-08.1 "K1
explicit allow only" tightening (`d221f65`, merged via PR #19). The red CI run `34040029489` is
fully explained by these two failures (F-register §S9). **(RECONSTRUCTED — source: F-register
`docs/T09_F_REGISTER_RECONSTRUCTION.md` L-9 row and §S9.)** They were later fixed — without touching
product monetary code — by the R-1/R-4 remediation commit `c45cfc1` (see
`R1_R4_REMEDIATION_VERIFICATION.md`).

## 5. Verification-cycle findings register (F-1 … F-8)

The register produced by the lost report is reconstructed in
`docs/T09_F_REGISTER_RECONSTRUCTION.md` (committed `8fc13ee`, 419 lines, exactly one file added by
that commit — **(CONTEMPORANEOUS — git history)**). Preserved outcome, quoted with its source:

- **F-6** is the only register entry reconstructable by ID: `StorageModule.atomically(fn,
  {tenantId})` performs no tenant filtering on the memory/filesystem development drivers. Status at
  the reconstructed HEAD: **confirmed · unchanged · reachable (dev drivers only) · non-blocking**
  for the PR #20 merge, with three evidenced compensating controls (PostgreSQL RLS on the
  production path; per-service tenant re-checks in every monetary caller; S-1 fail-closed
  knowledge/vector/tool/CLI boundaries). **(RECONSTRUCTED — source: committed F-register §4.2,
  itself quoting `docs/S01_TENANT_BOUNDARY_HARDENING.md:49`.)**
- **F-1 … F-5, F-7, F-8: UNRECOVERABLE.** Their wording, severity, and status are not present in any
  committed, pushed, or otherwise recoverable artifact; nothing is inferred in their place. Because
  7 of 8 entries are unrecoverable, the surviving record **cannot** certify that the original
  register contained no merge-blocking finding. **(RECONSTRUCTED — source: committed F-register
  §4.1/§4.3; original evidence UNAVAILABLE/LOST.)**

The F-register additionally preserves the recoverable T-09-era open items as a separate inventory
(L-1 … L-9, D-1, D-2) — deliberately **not** asserted to be F-1…F-8. Summary for this record:

| Item | Subject | Preserved status |
| --- | --- | --- |
| L-1 | Scale table is curated, not full ISO-4217 | Open (confirmed unchanged at HEAD) |
| L-2 | Legacy payment/billing boundaries accept non-ISO currency labels | Open (pre-existing T-07, preserved by design) |
| L-3 | FX rates host-supplied, static per call; no rate governance | Open (T-09 documented scope) |
| L-4 | No rate inversion (fail-closed refusal) | Open by design |
| L-5 | Wallet not connected to verified provider payments | Open (explicit scope boundary) |
| L-6 | Analytics averages keep 4-decimal reporting | Open (preserved 2dp compatibility) |
| L-7 | `Number` storage ceiling > 2^53 minor units | Open (pre-existing T-07; wallet mitigates via exact minor-unit string) |
| L-8 | Production gates untouched (HA/PITR, Redis, PSP, M-Pesa, ABAC/ReBAC/PAM, OIDC/SAML, Maps) | Open — standing programme, not solved by T-09 |
| L-9 | Two pre-existing test failures (agent-runtime, cli) | **Fixed** by R-1/R-4 at `c45cfc1` |
| D-1 | T-07 negative-amount sign bug in `minorUnitsAtScale` | Fixed by T-09 (`0cb6b6b`), found by T-09's own new suite |
| D-2 | Non-invertibility of a terminating decimal rate | Resolved as fail-closed refusal (limitation L-4) |

**(All rows RECONSTRUCTED — source: committed F-register §5, which cites the committed T-09
document's "Known limitations" section and committed code comments/test names.)**

## 6. Standing security context (explicitly preserved, not silently omitted)

T-09 and its verification do **not** close JATA Qi's security programme. The following remain open
as recorded in PR comment `5560777167` and the T-09 milestone document — **(CONTEMPORANEOUS)**: agent/tool
authorization, prompt-injection resistance, sandbox containment, cross-tenant AI/RAG/vector/cache
isolation, ATO resistance, SSO/OIDC/SAML, ABAC/ReBAC/PAM, secrets isolation, supply chain, network
boundaries, autonomous-action controls, abuse/rate limiting, auditability, incident response,
production hardening, and the external production gates of L-8. None of these was weakened by T-09.

## 7. Limitations of this record / unrecoverable evidence

- **UNAVAILABLE/LOST:** the original `t09-independent-verification.md` report file; the original
  F-register wording, severities, and statuses for F-1…F-5, F-7, F-8; any per-item finding prose
  that was not quoted into a committed artifact.
- **RECONSTRUCTED:** all synthesis above; exact source is stated at each point.
- **INDEPENDENTLY RE-EXECUTED (none applicable):** the T-09 commit `0cb6b6b` is not the current
  HEAD; its code is preserved *within* canonical `main` via the PR #20 merge, and the merged tree is
  re-executed in `PR20_MERGE_POSTMERGE_VERIFICATION.md`.
- This record does **not** assert that T-09 (or R-2) proves JATA Qi production-ready or fully
  hardened, and it does not assert that the F-register contained no blocking item.

## 8. Sources of reconstruction (exact)

1. `docs/T09_PER_CURRENCY_MONEY_AND_WALLET_FX.md` @ `0cb6b6b` (milestone document: results, ACs, limitations).
2. `docs/T09_F_REGISTER_RECONSTRUCTION.md` @ `8fc13ee` (finding-register reconstruction and search log S1–S11).
3. PR #20 body and issue comments `5560777167`, `5560923476` (preserved on GitHub, read via API).
4. GitHub Actions run records: `34040029489` (failure @ `0cb6b6b`), `34047326569` (cancelled @ `0f8b831`), `34047371586` (success @ `c1f9e47`) — read via API.
5. Git history of `POWERBot-1/JATA-Qi` (commit metadata and diffs).
