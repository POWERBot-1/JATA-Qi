# T-09 Finding Register (F-1 … F-8) — Evidence Reconstruction

**Document type:** audit record / evidence reconstruction. **No product behaviour is changed by this
document, and no F-finding is fixed by it.**

| Field | Value |
| --- | --- |
| Authorized by | Operator directive "AUTHORIZE — RECONSTRUCT T-09 F-REGISTER ONLY" (2026-09-07) |
| Scope | Reconstruct the lost **T-09 independent-verification finding register (F-1 … F-8)** from recoverable evidence only |
| Branch | `arena/01a076d2-jata-qi` |
| Verified HEAD at reconstruction time | `121eaa425c698ffa725fbc26df7a6e685dc45796` (S-1) |
| Canonical `main` | `82af3def9b8b26989b3f686369d17f03bb62ad9c` — **unmodified** |
| PR #20 | **OPEN · UNMERGED** (MERGEABLE / CLEAN) at the time of writing |
| Related milestone docs | [`T09_PER_CURRENCY_MONEY_AND_WALLET_FX.md`](T09_PER_CURRENCY_MONEY_AND_WALLET_FX.md), [`S01_TENANT_BOUNDARY_HARDENING.md`](S01_TENANT_BOUNDARY_HARDENING.md) |
| Outcome | **1 of 8 register items reconstructed (F-6). 7 of 8 declared UNRECOVERABLE.** No merge-blocking item among the recoverable evidence. |

> **Provenance rule applied.** An item is reconstructed only where a committed or remotely
> recoverable artifact states it. Where the register's wording, severity, or status cannot be
> evidenced, the item is marked **UNRECOVERABLE** and nothing is inferred in its place. Recoverable
> T-09-era open items that are *not* evidenced as F-register entries are listed separately
> (§5) and are explicitly **not** claimed to be F-1 … F-8.

---

## 1. What was lost, and when

The T-09 finding register was produced by the **independent read-only verification of the T-09
milestone** (commit `0cb6b6b`, 2026-09-06T14:22:03Z). It was recorded only in an agent-side scratch
file, `t09-independent-verification.md`, held **outside** the repository working tree. It was never
committed, never pushed, and never posted to PR #20.

That file was destroyed when the execution sandbox was recreated between milestone cycles (the
sandbox preserves the repository worktree but not files outside it, and not git objects). The same
event destroyed the original S-1 commit object (`c2d13e4` → recreated as `121eaa4`), which is
already disclosed in the S-1 verification report.

Consequence: the register's **IDs, wording, severities and statuses** survive only where they were
quoted into an artifact that *was* committed or pushed.

---

## 2. Exhaustive search of recoverable evidence

Every source authorized by the directive was searched. Results are recorded verbatim so the search
itself is auditable and repeatable.

| # | Source searched | Command / method | Result |
| --- | --- | --- | --- |
| S1 | Entire committed tree at **all four** revisions (`82af3de`, `0cb6b6b`, `c45cfc1`, `121eaa4`) | `git grep -nE "\bF-[1-8]\b" <rev>` | **Exactly one hit in the whole repository history**: `121eaa4:docs/S01_TENANT_BOUNDARY_HARDENING.md:49` → *"…`atomically(fn,{tenantId})` performs no tenant filtering (T-09 finding **F-6**)…"*. Zero hits at `82af3de`, `0cb6b6b`, `c45cfc1`. |
| S2 | Dangling / unreachable git objects | `git fsck --unreachable --dangling`, then `git cat-file -p` each blob | One dangling blob `3e48b0c7c999e5e061e5b9b4bff3ba3b7c157591` (41,783 B) = the **pre-implementation S-1 root-cause/impact map** draft. It contains **1** F-register hit — the same F-6 sentence (line 49). No other F-item. |
| S3 | PR #20 body (remotely recoverable) | `gh pr view 20 --json body` (23,930 B) | No `F-[1-8]` occurrence. Contains a "Known limitations" section (§5 below) and the R-1/R-4 classification `B-1…B-7 / V-1…V-4` (a *different* register, from the later cycle). |
| S4 | PR #20 issue comments, review comments, reviews | `gh api repos/POWERBot-1/JATA-Qi/issues/20/comments`, `…/pulls/20/comments` | 2 comments (`5560777167`, `5560923476`), 0 review comments. No `F-[1-8]` occurrence. |
| S5 | All other PRs and all issues | `gh pr list --state all`, `gh issue list --state all` | 20 PRs, **0 issues**. Every PR other than #20 was created and closed **before** the T-09 commit (PR #19 merged 2026-09-06T12:55:06Z; T-09 committed 14:22:03Z), so none can contain a T-09 finding. |
| S6 | Committed T-09 milestone documentation | `docs/T09_PER_CURRENCY_MONEY_AND_WALLET_FX.md` (438 lines, added by `0cb6b6b`) | No `F-n` labels at all (the register post-dates the document). Contains D-1…D-8 design decisions, AC-1…AC-10 status, invariants, evidence, and a 9-item **"Known limitations"** section → recovered as §5. |
| S7 | Committed S-1 milestone documentation | `docs/S01_TENANT_BOUNDARY_HARDENING.md` (449 lines, added by `121eaa4`) | The single F-6 citation (S1) plus a statement that S-1 changed "every T-09 monetary file" **not at all** (lines 187, 428) → used in §6. |
| S8 | Source and test files at the relevant revisions | `git grep -nE "\bF-[0-9]+[a-z]?\b" 121eaa4 -- packages` | Only **earlier** registers: `F-01a…F-01f` (event-schema unification, PR #11) and `T-08 F-1b` (`packages/payments/src/payments-service.ts:435,490`). No T-09 F-item. |
| S9 | CI logs / results for every T-09-era run | Runs `34040029489` (`0cb6b6b`, failure), `34047326569` (cancelled), `34047371586`, `34048251273`, `34065442942` (success) | CI logs contain build/lint/test output only — no finding register. The `0cb6b6b` red run is fully explained by the two pre-existing knowledge-service tenant-fallback failures (see §5, L-9). |
| S10 | Agent-side filesystem outside the repository | `ls -la /home/user` | Survivors: `JATA-Qi/`, `verify-s1/` (fresh clone), `verification-s1/` (S-1 verification artifacts), `s1-pr-body-update.md`. **No T-09 verification report exists.** |
| S11 | Repository reflog / stash | `git reflog --all`, `git stash list` | Reflog contains only this cycle's recovery entries; stash empty. No lost commit carrying the register. |

**Conclusion of the search:** the only F-register entry recoverable by ID is **F-6**. The mapping of
IDs F-1 … F-5, F-7 and F-8 to technical issues, and their original wording, severity and status, are
**not present in any committed, pushed, or otherwise recoverable artifact.**

---

## 3. Status vocabulary used in this document

Per the directive, these categories are kept strictly distinct and are never merged:

| Term | Meaning here |
| --- | --- |
| **confirmed** | The issue is evidenced and still true at HEAD `121eaa4` (independently re-verified). |
| **disproven** | The reported issue was tested and does not hold. *(No item in this reconstruction is disproven.)* |
| **fixed** | The issue no longer exists at HEAD because code changed, with test evidence. |
| **unchanged** | The code implicated by the issue is byte-identical to the earlier revision (git object hash proof). |
| **unreachable** | The issue exists in code but no boundary can reach it in the shipped configuration. |
| **non-blocking** | Does not prevent merging PR #20. |
| **blocking** | Would prevent merging PR #20. |
| **UNRECOVERABLE** | The register item cannot be reconstructed from recoverable evidence; nothing is asserted about it. |

---

## 4. The reconstructed register

### 4.1 Summary table

| ID | Reconstructable? | One-line subject (only where evidenced) | Status | Blocks merge? |
| --- | --- | --- | --- | --- |
| **F-1** | **UNRECOVERABLE** | — (no evidence; not inferred) | UNRECOVERABLE | Unknown — cannot be assessed |
| **F-2** | **UNRECOVERABLE** | — | UNRECOVERABLE | Unknown — cannot be assessed |
| **F-3** | **UNRECOVERABLE** | — | UNRECOVERABLE | Unknown — cannot be assessed |
| **F-4** | **UNRECOVERABLE** | — | UNRECOVERABLE | Unknown — cannot be assessed |
| **F-5** | **UNRECOVERABLE** | — | UNRECOVERABLE | Unknown — cannot be assessed |
| **F-6** | **YES — reconstructed** | `StorageModule.atomically(fn,{tenantId})` performs no tenant filtering on memory/filesystem dev drivers | **confirmed · unchanged · reachable (dev drivers only) · non-blocking** | **No** |
| **F-7** | **UNRECOVERABLE** | — | UNRECOVERABLE | Unknown — cannot be assessed |
| **F-8** | **UNRECOVERABLE** | — | UNRECOVERABLE | Unknown — cannot be assessed |

> **Register-completeness caveat (material for the merge decision).** Because seven of eight entries
> are UNRECOVERABLE, this document **cannot** certify that the T-09 register contained no
> merge-blocking finding. What it *can* certify, from independent evidence (§6), is that the T-09
> monetary code is **byte-identical** at HEAD to the code the T-09 verification examined, that all
> T-09 acceptance suites pass at HEAD, and that the S-1 milestone independently verified green
> (82/82 adversarial probes, 924/924 tests, CI run `34065442942` success). A register whose subject
> code is unchanged and whose suites pass cannot have acquired a *new* blocking defect since it was
> written — but the original severities of F-1…F-5, F-7 and F-8 remain unknown, and the operator
> should treat that as an open audit gap (§8, R-1).

### 4.2 F-6 — full reconstruction (10 required fields)

**1. Finding ID.** `F-6` (T-09 independent-verification register).

**2. Original technical issue.** The recoverable statement of the issue, quoted verbatim from the
committed S-1 milestone document (`docs/S01_TENANT_BOUNDARY_HARDENING.md:48-50`):

> "Aggravating factor: on memory/filesystem dev drivers `atomically(fn,{tenantId})` performs no
> tenant filtering (T-09 finding **F-6**), so the service filter is the *only* boundary in
> development."

*Provenance of the wording:* this is the S-1 cycle's citation of F-6, written while the register was
still available. The register's own original sentence is lost, so the wording above is a **quotation
of a quotation** and is labelled as such. No severity or priority value for F-6 survives.

**3. Affected component / path.**

- `packages/storage/src/storage-module.ts` → `StorageModule.atomically()` (at HEAD: lines 201-227).
- Affected drivers: **memory** and **filesystem** (development drivers, i.e. any driver without
  `beginTransaction`).
- Not affected: **PostgreSQL** (`packages/storage-postgres`), whose transaction path receives the
  tenant and sets the tenant context (RLS).
- Consumer surface: every `storage.atomically(...)` caller — 20+ call sites at HEAD, including
  `packages/payments/src/wallet-service.ts:203, 281, 334`, `packages/payments/src/payments-service.ts:228, 308, 553`,
  `packages/billing/src/billing-service.ts:212, 251`, `packages/revenue-ledger/src/revenue-ledger-service.ts:126`,
  `packages/commercial-memory/src/commercial-memory-service.ts:98, 224`,
  `packages/commercial-control-plane/src/commercial-control-plane-service.ts:1276`,
  `packages/loop-host/src/host-service.ts:170`.

**4. Evidence** (all independently re-derived at HEAD during this reconstruction):

- *Committed citation:* `docs/S01_TENANT_BOUNDARY_HARDENING.md:49`; identical sentence in dangling
  blob `3e48b0c7` line 49 (pre-implementation S-1 draft).
- *Source proof at HEAD* — the non-transactional branch hands out **unscoped** collections:

  ```ts
  const begin = this.driver.beginTransaction?.bind(this.driver);
  if (!begin) {
    const scope: StorageWriteScope = {
      atomic: false,
      tenantId,                                  // carried, but NOT enforced
      collection: (name) => this.collection(name),   // ← module-wide collection, no tenant filter
      ...
  ```
  (`packages/storage/src/storage-module.ts:209-217`). The transactional branch instead calls
  `await begin({ tenantId })` and serves `tx.collection(name)` (`:228-241`), i.e. the tenant **is**
  enforced there.
- *Contrast evidence (PostgreSQL enforces it):* fresh-clone test run at HEAD —
  `ok 1 - atomically({tenantId}) sets the tenant context inside the transaction (statement-level)`
  (suite "T-06 production-path RLS (real PostgreSQL)"), plus
  `ok 2 - tenant A cannot read tenant B data through the production path` and
  `ok 3 - tenant A cannot mutate or delete tenant B data (driver + RLS fail closed)`.
- *Compensating-control evidence in the monetary surface:* `wallet-service.ts:337` passes
  `{ tenantId: actor.tenantId }` into `atomically`, and the service re-checks ownership on every
  read — e.g. `wallet-service.ts:285`:
  `if (current.tenantId !== actor.tenantId) throw new WalletError('Cross-tenant wallet access is not authorized.')`.
- *Tenant-id shape validation still applies on every driver:*
  `StorageModule.validateTenantId` (`storage-module.ts:167-174`) rejects blank and unsafe tenant ids
  before any write is attempted.

**5. Pre-existing / introduced by T-09 / modified by S-1.**

| Question | Answer | Proof |
| --- | --- | --- |
| Pre-existing? | **YES** — predates T-09 | `git rev-parse <rev>:packages/storage` = `edf0265f4ee98a5a57dd2015963a65184e92e1cb` at **all** of `82af3de`, `0cb6b6b`, `c45cfc1`, `121eaa4`; `storage-module.ts` blob = `c5c631f5e79f27aa2214fb129ddaa5d6015a200b` at all of them |
| Introduced by T-09? | **NO** | T-09 changed no file under `packages/storage` (`git diff --name-status 82af3de 0cb6b6b -- packages/storage` is empty) |
| Modified by S-1? | **NO** | `git diff --name-status c45cfc1 121eaa4 -- packages/storage` is empty; identical tree hash |

**6. Current status.** **Confirmed · unchanged · OPEN** at HEAD `121eaa4`. The behaviour described by
F-6 is still exactly as cited. S-1 did not fix it and did not worsen it; S-1 **reduced its blast
radius** for the knowledge plane by moving tenant enforcement to the authoritative service and vector
boundaries (fail-closed `TenantContextError`) and adding a CLI re-filter, so on dev drivers the
knowledge services no longer depend on `atomically` for isolation.

**7. Reachable?** **Yes, conditionally.**

- **Reachable** in any deployment whose storage driver is `memory` or `filesystem` (the development
  default and the driver used by `npm test` outside the PostgreSQL suites): a composed write scope
  obtained with `{tenantId}` returns collections that are not tenant-filtered, so isolation depends
  entirely on each calling service's own tenant checks.
- **Not reachable** on the PostgreSQL production path: `beginTransaction({tenantId})` sets the
  tenant context and RLS enforces isolation (test evidence above).
- No shipped caller was found that relies on `atomically` alone for tenant isolation: the monetary
  services re-check `tenantId` on every read (e.g. `wallet-service.ts:285`), and the knowledge
  services now fail closed before any data-plane call (S-1, verified by 82/82 probes).

**8. Security impact.** **Defence-in-depth gap; LOW–MODERATE in dev-driver configurations; NONE on the
PostgreSQL production path.** No monetary-value integrity impact and no demonstrated cross-tenant
disclosure: the gap removes a *second* independent barrier, leaving service-level checks as the only
barrier in development. The risk is future-facing — a new consumer written against
`atomically(fn,{tenantId})` on a dev driver would inherit no storage-level isolation (the same
"fail-open authoritative boundary" hazard S-1 was chartered to remove for knowledge).

**9. Blocks merge?** **NO.** Non-blocking, with three independent compensating controls evidenced
above (PostgreSQL RLS on the production path; per-service tenant re-checks in every monetary caller;
S-1 fail-closed knowledge/vector/tool/CLI boundaries).

**10. Recommended follow-up milestone.** A storage-layer hardening milestone (proposed id
**ST-1 — tenant-scoped write scope on non-transactional drivers**), separately authorized:
either (a) make `scope.collection(name)` on memory/filesystem drivers return a tenant-filtered view
keyed by `scope.tenantId`, or (b) refuse `{tenantId}` scopes on drivers that cannot enforce them
(fail closed, matching the S-1 doctrine), plus a lint/test guard that no caller treats `atomically`
as an isolation boundary. **Not started here** — this document changes no product behaviour.

### 4.3 F-1 … F-5, F-7, F-8 — UNRECOVERABLE

For each of these seven IDs the following is the complete, honest statement:

| Field | Value |
| --- | --- |
| 1. Finding ID | F-1 / F-2 / F-3 / F-4 / F-5 / F-7 / F-8 (IDs known to have existed from the S-1 authorization record, which instructed that F-1…F-8 be preserved) |
| 2. Original technical issue | **UNRECOVERABLE** — no committed, pushed, or dangling artifact states it |
| 3. Affected component / path | **UNRECOVERABLE** |
| 4. Evidence | **None exists.** Search S1–S11 (§2) returned zero occurrences of these IDs anywhere in repository history, in PR #20's body/comments/reviews, in any other PR or issue, in CI output, or on disk |
| 5. Pre-existing / introduced by T-09 / modified by S-1 | **UNRECOVERABLE** (though see §6: whatever code they concerned in the monetary surface is byte-identical at HEAD to what the T-09 verification examined) |
| 6. Current status | **UNRECOVERABLE** — cannot be stated as confirmed, disproven, fixed, or unchanged |
| 7. Reachable? | **UNRECOVERABLE** |
| 8. Security impact | **UNRECOVERABLE** — no severity is asserted |
| 9. Blocks merge? | **Cannot be assessed from the register.** The merge decision must therefore rest on the independent evidence in §6 (unchanged code, passing T-09 suites, green S-1 verification) rather than on this register |
| 10. Recommended follow-up | **R-1 (§8): re-derive the register** by a fresh, separately authorized read-only verification of the T-09 scope, and commit the result under `docs/` so it can never be lost again (R-2) |

**Nothing is invented for these seven items.** In particular, the T-09 "Known limitations" (§5) are
*not* asserted to be F-1…F-8: they are a committed milestone-document section written **before** the
verification, and mapping them onto register IDs would be manufacture.

---

## 5. Recoverable T-09-era open items (separate inventory — **not** the F-register)

These items *are* fully evidenced (committed T-09 document, committed code comments, committed test
names, and independent re-verification at HEAD). They are recorded so the audit trail preserves the
substance of T-09's open scope even though the register's own numbering is lost. IDs below are
**local to this document** (`L-n`, `D-n`) and deliberately do not reuse the `F-n` namespace.

Source: `docs/T09_PER_CURRENCY_MONEY_AND_WALLET_FX.md`, "Known limitations (honest scope statement)",
items 1-9 (lines 381-418), added by commit `0cb6b6b`.

| ID | Item (as committed) | Component / path | Origin | Status at HEAD `121eaa4` | Reachable? | Security / correctness impact | Blocks merge? | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **L-1** | Scale table is a curated list, not the full ISO-4217 registry; unlisted 0-dp (VND, PYG) and 3-dp (IQD, LYD, TND) currencies resolve to the 2-dp default | `commercial-control-plane/src/money.ts` (`MINOR_SCALE_BY_CURRENCY`, `scaleOf`) | T-09 documented scope | **confirmed · unchanged** (blob `6cd9748…` identical `0cb6b6b`→`121eaa4`) | Yes — using an unlisted currency | Wrong minor-unit scale → quantization/rounding error for that currency; no cross-tenant or auth impact | No | Extend the table (expand-only) in a currency-registry milestone |
| **L-2** | Legacy payment/billing boundaries accept non-ISO currency labels (validate "non-empty" only, unchanged from T-07); the **wallet** is strict (3-letter ISO) | `payments`, `billing` validation paths | **Pre-existing (T-07)**, explicitly preserved for compatibility | **confirmed · unchanged** (payments/billing trees identical `0cb6b6b`→`121eaa4`) | Yes — any legacy integration passing a non-ISO label | Unknown label silently resolves to 2-dp default (interacts with L-1); no integrity break for existing 2-dp flows | No | Strict currency validation at legacy boundaries, with its own compatibility governance |
| **L-3** | FX rates are host-supplied and static per call: no freshness, validity window, spread, or rate-source attestation | `commercial-control-plane/src/fx.ts` (new in T-09) | Introduced by T-09 as documented scope | **confirmed · unchanged** (blob `09b4208…` identical) | Yes — a host injecting a stale rate | Deterministic conversion at a stale rate; **no** rate governance/attestation. Financial-risk gap, not a code defect | No | FX rate-governance milestone (signed feeds, validity windows, spread policy) |
| **L-4** | No rate inversion: a provider knowing only `USD/JPY` cannot serve `JPY/USD`; conversion fails closed | `fx.ts` (`convertMoney`) | Introduced by T-09 (deliberate fail-closed choice) | **confirmed · unchanged**; asserted by `ok 10 - T-09 AC-5 — injected FX conversion (deterministic, target-scale, half-up)` | Yes — missing pair | Availability only (refusal, never a derived reciprocal); fail-closed is the safer behaviour | No | Optional governed inversion if a business need appears |
| **L-5** | Wallet is not connected to verified provider payments (no auto-credit on `payment.verified`, no auto-debit on refund) | `payments/src/wallet-service.ts` (new in T-09) | Introduced by T-09 as an explicit scope boundary | **confirmed · unchanged** (blob `23e50d0…` identical) | N/A — the integration does not exist | Functional gap; deposits remain explicit governed operations with idempotency keys | No | A separately governed wallet↔payments integration milestone (**not** T-10, which remains forbidden) |
| **L-6** | Analytics averages (`arpu`, `cac`, `roas`, `ltv`) keep 4-decimal reporting; quantizing them at currency scale would change existing 2-dp results (forbidden by AC-3) | `commercial-analytics/src/commercial-analytics-service.ts` | Pre-existing reporting convention, preserved by T-09 | **confirmed · unchanged** (tree identical) | Yes — analytics output | Ratios are statistical, not payable amounts; no monetary-movement impact | No | Revisit only if a ratio becomes a payable amount |
| **L-7** | `Number` remains the storage type for amounts; minor units above 2^53 cannot be represented exactly as a JSON number (pre-existing T-07 limitation). The wallet additionally persists the exact minor-unit string | `commercial-control-plane` money types; `payments` wallet rows | **Pre-existing (T-07)**; mitigated (not removed) by T-09 | **confirmed · unchanged**, mitigation present | Only above 2^53 minor units (≈9×10^15 KES) | Precision ceiling for extreme values; wallet authoritative value is never lossy | No | String/BigInt amount storage milestone |
| **L-8** | Pre-existing PostgreSQL production gates untouched: no HA/PITR, Redis production deployment, PSP integration, M-Pesa activation, ABAC/ReBAC/PAM, OIDC/SAML, Maps activation | Repository-wide production programme | **Pre-existing**, out of T-09 scope | **confirmed · unchanged** | N/A | Production-readiness gap; explicitly "not solved by this milestone" | No (for PR #20) | The standing production-gate / security programme (remains OPEN, ≈73% verified vs ≥95% target) |
| **L-9** | Two unrelated pre-existing test failures remained at T-09 (`agent-runtime` "knowledge.search tool hits the knowledge service"; `cli` "ingests text, extracts entities, and retrieves"), both from the T-08.1 K1 tenant-fallback guard | `agent-runtime`, `cli` test suites | **Pre-existing at `82af3de`** (T-09 baseline: 821 tests / 819 pass / **2 fail**) | **FIXED** by the R-1/R-4 remediation commit `c45cfc1` (test-only: both now declare an explicit tenant and assert scoping) | N/A | None outstanding | No | Closed. Evidence: fresh clone at HEAD → `# tests 924 # pass 924 # fail 0 # skipped 0`; CI run `34065442942` → `Total: 49 · Passed: 49 · Failed: 0 · Skipped: 0`; PR comment `5560777167` |

### Implementation defects found *during* T-09 (committed evidence)

| ID | Defect | Evidence | Origin | Status | Reachable? | Impact | Blocks merge? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **D-1** | Negative-amount sign bug: the T-07 `minorUnitsAtScale` returned the **magnitude** for negative amounts, so `moneyEquals({-1,KES},{1,KES})` was `true` | Committed code comment `packages/commercial-control-plane/src/money.ts:168-174` ("**T-09 fix (found by the per-currency suite)**…"); regression test `money.per-currency.test.ts:220` (`assert.ok(!moneyEquals({amount:-1,currency:'KES'},{amount:1,currency:'KES'}))`); T-09 commit message ("Sign fix: minorUnitsAtScale re-applied the sign…") | **Pre-existing (T-07)**, discovered by T-09's own new suite | **FIXED** by T-09 (`0cb6b6b`); unchanged since (blob identical at HEAD) | **Effectively unreachable** — "Every JATA Qi boundary rejects negative monetary amounts, so no persisted record or existing assertion changes" (committed comment) | Would have made canonical comparison unsound for refunds/adjustments and signed wallet deltas; no persisted value changed | No |
| **D-2** | Non-invertibility of a terminating decimal rate (an FX provider cannot serve the reciprocal pair) | `docs/T09_…md:299-302` ("Two of them caught real defects during implementation… the non-invertibility of a terminating decimal rate"); fail-closed behaviour asserted by the AC-5 suites | T-09 design surface | **Confirmed by design** — resolved as a fail-closed refusal, recorded as limitation **L-4** | Yes — missing/irreversible rate pair | Refusal rather than a derived reciprocal (safer); availability only | No |

---

## 6. Cross-check: did S-1 alter money / wallet / FX / reconciliation / payments / billing / commercial analytics / revenue-ledger?

**Answer: NO — proven by git object identity, independently re-verified in a fresh clone, and
confirmed by passing T-09 suites.**

### 6.1 Diff evidence (git object hashes — the strongest available form)

`git diff --name-status c45cfc1 121eaa4 -- <paths>` (the S-1 commit) is **empty** for every monetary
path, and the *tree objects* are identical, meaning byte-for-byte equality of every file in each
package:

| Package | Tree at T-09 `0cb6b6b` | Tree at HEAD `121eaa4` | Verdict |
| --- | --- | --- | --- |
| `packages/commercial-control-plane` (money, **FX**, migration, budgets) | `49764c903251924143e4cc63f7efca84f87e2654` | `49764c903251924143e4cc63f7efca84f87e2654` | **IDENTICAL** |
| `packages/payments` (**wallet**, payments service) | `fea4ee8b06215b2951d839384e88aeb6a5d88ab4` | `fea4ee8b06215b2951d839384e88aeb6a5d88ab4` | **IDENTICAL** |
| `packages/reconciliation` | `5092b9cf4c30dc18cc24a47ba500533820df66bd` | `5092b9cf4c30dc18cc24a47ba500533820df66bd` | **IDENTICAL** |
| `packages/revenue-ledger` | `b0b78c938cd8fc9285a6240bf0f1d5b9c810450f` | `b0b78c938cd8fc9285a6240bf0f1d5b9c810450f` | **IDENTICAL** |
| `packages/billing` | `4c3e29136e3eb4068603a999fcb566d8bded1bc7` | `4c3e29136e3eb4068603a999fcb566d8bded1bc7` | **IDENTICAL** |
| `packages/commercial-analytics` | `1eefe15485fc56ca7c3f40a89c15078622e43b6f` | `1eefe15485fc56ca7c3f40a89c15078622e43b6f` | **IDENTICAL** |
| `packages/commercial-command-center` (cross-domain T-09 suite) | `2dbe995013c46d281e797c3bb51aac783739bccf` | `2dbe995013c46d281e797c3bb51aac783739bccf` | **IDENTICAL** |
| `packages/storage` (F-6 subject) | `edf0265f4ee98a5a57dd2015963a65184e92e1cb` | `edf0265f4ee98a5a57dd2015963a65184e92e1cb` | **IDENTICAL** (also identical at `82af3de`) |

Key monetary blobs, `0cb6b6b` → `121eaa4`:

```
IDENTICAL  commercial-control-plane/src/money.ts              6cd97481342991dd5bc966a644fada0d9ae98c07
IDENTICAL  commercial-control-plane/src/fx.ts                 09b4208bbf2d34e47aec10124eabd0db6df7903f
IDENTICAL  commercial-control-plane/src/money-migration.ts    c1754b586999000f4fb2d3dbb737e704c26c32e5
IDENTICAL  payments/src/wallet-service.ts                     23e50d0a705a06881be6a21960c08596a2fed133
IDENTICAL  payments/src/types.ts                              4e7621214628bcf017dd651f4aba47b9f91634dd
IDENTICAL  reconciliation/src/reconciliation-service.ts       a72484ad4456708dd30f20d3ec812abc67b476e8
IDENTICAL  revenue-ledger/src/revenue-ledger-service.ts       e3da18b550ffff595083ea449b05ce1673465a04
IDENTICAL  billing/src/billing-service.ts                     78126a7f4ac506a55441a57f7672a166f4cd9348
```

The R-1/R-4 commit (`0cb6b6b..c45cfc1`) likewise touched **no** monetary path (it changed 5 files in
`packages/cli`, one `agent-runtime` test file, `README.md` and `.env.example`). The S-1 commit's 25
files are confined to `knowledge-service`, `knowledge-graph`, `vector-search`, `agent-runtime`, `cli`,
`docs/`, `README.md`, `.env.example`.

This corroborates the committed S-1 statements: "`.github/workflows/ci.yml`, lint config, **every T-09
monetary file**, and the R-1/R-4 test [files were untouched]" (`docs/S01_…md:187`) and "`git status`
then listed exactly the 25 S-1 paths — which simultaneously proves every T-09 [file unchanged]"
(`docs/S01_…md:428`).

### 6.2 Independent test evidence at HEAD (fresh clone from GitHub, Node v22.22.3)

Per-workspace results measured in `/home/user/verify-s1` (cloned from GitHub, checked out at
`121eaa4`, `npm ci && npm run build && npm test`) versus the counts the T-09 document recorded for
its own commit (`docs/T09_…md:335-336`):

| Workspace | T-09 doc (at `0cb6b6b`) | Fresh clone (at `121eaa4`) | Match |
| --- | --- | --- | --- |
| commercial-control-plane | 65 | tests 65 · pass 65 · fail 0 · skipped 0 | **YES** |
| payments | 42 | tests 42 · pass 42 · fail 0 · skipped 0 | **YES** |
| commercial-command-center | 16 | tests 16 · pass 16 · fail 0 · skipped 0 | **YES** |
| revenue-ledger | 20 | tests 20 · pass 20 · fail 0 · skipped 0 | **YES** |
| commercial-analytics | 9 | tests 9 · pass 9 · fail 0 · skipped 0 | **YES** |
| reconciliation | 6 | tests 6 · pass 6 · fail 0 · skipped 0 | **YES** |
| billing | 6 | tests 6 · pass 6 · fail 0 · skipped 0 | **YES** |

T-09 acceptance suites, as executed at HEAD (fresh clone):

```
ok 7  - T-09 AC-1 — JPY and other zero-decimal currencies
ok 8  - T-09 AC-2 — KWD/BHD/OMR three-decimal currencies
ok 9  - T-09 AC-3 — KES/default two-decimal behaviour is unchanged
ok 10 - T-09 AC-5 — injected FX conversion (deterministic, target-scale, half-up)
ok 12 - T-09 migration — expand-only, non-destructive, bit-identical for 2dp rows
ok 4  - T-09 AC-4 — per-currency wallet balances
ok 5  - T-09 AC-4 — fail-closed withdrawals
ok 6  - T-09 AC-5 — wallet FX conversion with an injected provider
ok 2  - T-09 AC-7 — billing calculations use the product currency scale
ok 3  - T-09 AC-1/AC-6 — JPY end-to-end payment, ledger, and reconciliation
ok 4  - T-09 AC-8 — per-currency analytics and MRR
ok 5  - T-09 AC-4/AC-5 — wallet inside the full commercial composition
```

Whole-repository result at HEAD: **924 tests · 924 pass · 0 fail · 0 skipped · 0 todo**, 49/49
workspaces; `npm run build` exit 0; `npm run lint` exit 0 (0 errors / 60 warnings — the same count
T-09 recorded). GitHub CI at the same commit: run `34065442942` **success**, all 9 steps,
`Total: 49 · Passed: 49 · Failed: 0 · Skipped: 0`, PostgreSQL integration executed (no SKIP),
Node v20.20.2.

**Conclusion:** T-09's monetary behaviour is unchanged by R-1/R-4 and by S-1, and every T-09
acceptance criterion still passes at HEAD — verified independently of the implementation workspace.

---

## 7. Audit observation: F-register label collision

Three different registers in this project's history use an `F-n` notation, which is how a lost
register becomes hard to distinguish from a surviving one:

| Notation | Register | Where it survives |
| --- | --- | --- |
| `F-01` … `F-07` (two-digit, incl. `F-01a`…`F-01f`) | JATA Qi **unification audit** (event-schema two-plane split, runner fail-fast, publish-only events, snapshot overlap) | Committed: `docs/JATA_QI_UNIFICATION_AUDIT_SUMMARY.md`, `docs/JATA_QI_RECOVERY_MANIFEST.md`, `docs/EVENT_SURFACE_CONTRACT.md`, `docs/O01_OPERATION_HOST.md`, plus code comments (`core-kernel/src/canonical.ts:1`, `commercial-control-plane-service.ts:152-157`, …). PR #11 was titled "F-01 EVENT-SCHEMA UNIFICATION (F-01a-f)". The `F-05..F-07` "risk register in the audit dossier" is referenced but the dossier itself is **not committed** |
| `T-08 F-1b` | T-08 verification finding (bounded payment retry + admin recovery) | Committed code comments: `packages/payments/src/payments-service.ts:435, 490` |
| `F-1` … `F-8` (single digit) | **T-09 independent verification** — the register this document reconstructs | Only `F-6`, via `docs/S01_…md:49` |

**Recommendation (R-3, §8):** namespace finding IDs by milestone (`T09-F6`, `T08-F1b`, `AUD-F01`)
and commit every verification register under `docs/verification/` at the time it is produced.

---

## 8. Recommended follow-up milestones

| Ref | Recommendation | Priority | Notes |
| --- | --- | --- | --- |
| **R-1** | Re-derive the T-09 register: a fresh, separately authorized **read-only** verification of the T-09 scope (money scale table & quantization, per-currency wallet, injected FX, expand-only migration, currency-aware billing/payments/ledger/reconciliation/analytics), producing F-1…F-8-equivalent findings with severities | **High** — closes the audit gap created by the loss | Must not modify product code; must not be folded into another milestone |
| **R-2** | Commit verification registers and independent-verification reports into the repository (`docs/verification/<milestone>-<date>.md`) so they survive sandbox loss and are reviewable in PRs | **High** — process fix; this document is the first instance | Documentation-only commits |
| **R-3** | Namespace finding IDs per milestone and retire bare `F-n` labels | Medium | Prevents future conflation (§7) |
| **R-4** | **ST-1** storage-layer hardening for **F-6**: tenant-filtered write scopes on memory/filesystem drivers, or fail-closed refusal of `{tenantId}` scopes on drivers that cannot enforce them; plus a guard that no caller treats `atomically` as an isolation boundary | Medium | Non-blocking for PR #20; dev-driver defence-in-depth |
| **R-5** | Currency-registry completion (**L-1**) and strict ISO-4217 validation at legacy payment/billing boundaries (**L-2**) | Medium | Expand-only; needs compatibility governance |
| **R-6** | FX rate governance (**L-3**): signed/attested rate feeds, validity windows, spread policy | Medium | Financial-risk control, outside the model |
| **R-7** | Wallet ↔ verified-payment integration (**L-5**) | Low | Separate milestone; **T-10 remains forbidden and is not this** |
| **R-8** | Amount representation beyond 2^53 minor units (**L-7**) | Low | String/BigInt storage |
| **R-9** | Add a `required_status_checks` rule for `build · lint · test` to ruleset `20134880` on `main` | **High** (governance) | From the S-1 verification, B-7: CI is currently **not** a merge gate; PR #19 merged while red; canonical `main` `82af3de` is itself red (run `34034524011`). Requires an admin token |

---

## 9. Merge-blocking assessment

| Question | Answer | Basis |
| --- | --- | --- |
| Does any **reconstructed** register item block merging PR #20? | **No** | F-6 is non-blocking with three evidenced compensating controls (§4.2, field 9) |
| Does any recoverable T-09-era item (L-1…L-9, D-1, D-2) block merging? | **No** | §5: all are documented scope limitations or fixed defects; L-9 and D-1 are **fixed** and evidenced by passing suites |
| Can this document certify the register contained no blocking finding? | **No — and it says so explicitly** | 7 of 8 entries are UNRECOVERABLE (§4.1 caveat, §4.3) |
| What *is* certified independently? | The T-09 monetary surface is **byte-identical** at HEAD to the code the T-09 verification examined; all T-09 AC suites pass at HEAD in a fresh clone and in CI; S-1's own verification passed 82/82 adversarial probes and 924/924 tests | §6, plus the agent-side S-1 independent verification report (`verification-s1/S1-INDEPENDENT-VERIFICATION-REPORT.md`, 16 items + 82-probe results). That report is **not committed** — exactly the process gap recommendation **R-2** addresses |

The merge decision therefore rests on that independent evidence and on operator authorization — not
on a register that is only 1/8 recoverable.

---

## 10. Governance attestation

- **No product code was changed** by this reconstruction. The commit carrying this document adds
  exactly one file, `docs/T09_F_REGISTER_RECONSTRUCTION.md`; `git diff --stat` between the previous
  HEAD (`121eaa4`) and this commit lists no other path, and every monetary package tree hash is
  unchanged (§6.1).
- **No F-finding was fixed**, mitigated, re-worded in product source, or closed by assertion.
- **No product behaviour was modified**; no test was added, removed, skipped, suppressed, or weakened.
- **T-10 was not started.** No milestone work of any kind was performed.
- **Canonical `main` was not modified**: `82af3def9b8b26989b3f686369d17f03bb62ad9c`.
- **PR #20 was not merged** and no merge was proposed. It remains OPEN/UNMERGED; this document is
  delivered as a documentation-only commit on the same branch, which advances the PR head SHA while
  leaving `121eaa4` (the S-1 verified HEAD) as its direct parent.
- **No unrecoverable item was manufactured.** F-1…F-5, F-7 and F-8 are recorded as UNRECOVERABLE
  with the complete search evidence that justifies that classification.

**STOP.** This reconstruction is complete. The next action is an explicit operator merge decision
based on the recovered audit record.
