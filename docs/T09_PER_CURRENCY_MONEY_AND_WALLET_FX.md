# T-09 — Per-currency money and wallet FX

**Milestone:** T-09 · **Base:** `main` @ `82af3def9b8b26989b3f686369d17f03bb62ad9c` (merge of PR #19 / T-08.1) · **Branch:** `arena/01a076d2-jata-qi`
**Authorization:** explicit written authorization to implement T-09 only (per-currency minor units, wallet, injected FX). T-08 and T-08.1 are canonical in the base commit.
**Status:** IMPLEMENTED — awaiting independent read-only verification. **Not merged.** T-10 not started.

## Objective

Generalize JATA Qi's monetary model from a fixed 2-decimal assumption to
currency-aware minor-unit precision, add per-currency internal wallet balances
with fail-closed withdrawals, and add deterministic FX conversion through an
**injected** rate source — while keeping every existing 2-decimal behaviour
bit-identical.

Out of the milestone (unchanged, still separate gates): PSP integrations,
M-Pesa activation, ABAC/ReBAC/PAM, OIDC/SAML, production PostgreSQL HA/PITR,
Redis production deployment, Maps activation, and any other unrelated
architectural work.

## Design decisions (recorded)

### D-1 — Per-currency minor-unit scale table (R-MONEY-03 closed)
`packages/commercial-control-plane/src/money.ts` now owns an explicit scale
table:

| Scale | Currencies | Meaning |
| --- | --- | --- |
| 0 | `JPY`, `KRW`, `CLP` | the minor unit IS the major unit |
| 3 | `BHD`, `KWD`, `OMR` | fils/baisa |
| 2 | every other currency | the documented T-07 default |

- `MINOR_SCALE_BY_CURRENCY` is `Object.freeze`n; `scaleOf(currency)` resolves
  it and falls back to `DEFAULT_MONETARY_SCALE = 2`.
- Scale lookup normalizes case/whitespace (`scaleOf('jpy') === 0`). Currency
  **identity** is unchanged: `moneyEquals` still requires an exact currency
  string match, so `KES` vs `kes` and `KES` vs `USD` remain unequal. A
  case-only alias can therefore never make two different monies compare equal.
- Adding a currency to the table is an expand-only change: it alters how
  amounts are *derived*, never what is *stored*.

### D-2 — Currency is a REQUIRED argument (AC-9, fail-closed at compile time)
`minorUnitsOf(amount, currency)`, `fromMinorUnits(minor, currency)`,
`quantizeAmount(amount, currency)`, `isQuantizedAmount(amount, currency)`, and
`sumMonetaryAmounts(amounts, currency)` all require the currency. There is
deliberately **no** default-currency overload: a call site that does not know
the currency cannot compile, so it cannot silently quantize a 0-decimal or
3-decimal amount at 2 decimals.

This is an intentional, compile-time-enforced signature change to the shared
money helpers. Every in-repo call site was updated in the same commit
(commercial-control-plane budgets, payments, billing, revenue-ledger,
commercial-analytics, reconciliation) and the three pre-existing money
regression suites (`money.test.ts`, `t08-1-mrr.test.ts`, `t08-1-money.test.ts`)
now pass `'KES'` explicitly, keeping every asserted value identical to the
T-07/T-08.1 baseline. Scale-explicit escape hatches remain available for code
that genuinely works in scales rather than currencies
(`minorUnitsAtScale`, `quantizeAmountAtScale`, `fromMinorUnitsAtScale`,
`roundHalfUpToScale`).

### D-3 — One rounding primitive, half-up, applied once
`roundHalfUpToScale(magnitude, fromScale, toScale)` is the single rounding rule
(`MONEY_ROUNDING_RULE = 'half-up'`, ties away from zero on the exact decimal
value). It is used by quantization, minor-unit derivation, the product rule,
FX conversion, and recurring allocation — so no path rounds twice and no path
rounds on a binary float.

`decimalParts` returns a sign-free magnitude plus a `negative` flag. **Bug
found and fixed by the T-09 suite:** the T-07 `minorUnitsOf` did not re-apply
that sign, so a negative amount produced *positive* minor units and
`moneyEquals({-1, KES}, {1, KES})` returned `true`. Minor units are now signed
and ties round away from zero on the magnitude. No JATA Qi boundary accepts a
negative monetary amount (payments, billing, ledger, and wallet all validate
`amount >= 0`), so no persisted row, fixture, or existing assertion changes
value; the fix makes the canonical comparison sound for refunds/adjustments and
for signed wallet deltas.

### D-4 — Generalized recurring allocation (AC-8)
`divideMinorUnitsHalfUp(minor, divisor)` and `annualToMonthly(value)` replace
the 2dp-specific `(minor + 6n) / 12n` in commercial analytics. `(minor + 6n)
/ 12n` is exactly `divideMinorUnitsHalfUp(minor, 12n)` for a positive dividend,
so the T-08.1 results are preserved bit-for-bit (KES 12.00 → 1.00, KES 0.06 →
0.01 tie, KES 100.00 → 8.33) while JPY and KWD now allocate at their own
scale (JPY 100 annual → 8 yen MRR; JPY 6 annual → 1 yen tie; KWD 1.000 annual
→ 0.083 KWD MRR).

Analytics ratio metrics (`arpu`, `cac`, `roas`, `ltv`, churn/retention) keep
their existing 4-decimal reporting rounding: they are statistical averages, not
payable amounts, and re-quantizing them at the currency scale would change
existing 2dp results (which AC-3 forbids). Recorded as a known limitation.

### D-5 — Per-currency wallet (AC-4)
`packages/payments/src/wallet-service.ts` (+ wallet types in
`packages/payments/src/types.ts`) implements internal balances. It lives in the
payments workspace — the existing provider-neutral money-movement bounded
context — and is constructed by `PaymentsModule` (`getWalletService()`,
container key `payments.wallet`), so no host wiring, workspace, lockfile, or
module-registry change was needed.

- **Identity:** `wallet:<sha256(tenantId \0 ownerReference \0 currency)>`. The
  currency is part of the account identity, so there is no such thing as "the
  balance" of an owner — only the balance of an (owner, currency) pair, and no
  code path adds minor units of two currencies.
- **State:** `balance: MonetaryValue` (canonical, quantized at the currency
  scale) plus `minorUnits: string` (exact minor units as a decimal string —
  JSON-safe, so the authoritative value survives jsonb/JSONL persistence) and
  `scale: number` (additive metadata recording the scale that produced it).
- **Movements:** append-only `payments.wallet-entries` records with a
  deterministic id per (wallet, idempotencyKey, leg), signed minor units, and
  the balance snapshot after the movement.
- **Fail-closed refusals:** insufficient exact minor-unit balance (no partial
  debit, never negative), currency mismatch (an explicit `currency` that
  disagrees with `amount.currency`), a currency the owner does not hold (a JPY
  withdrawal can never be funded from a KES balance), frozen accounts,
  non-positive/non-finite amounts, non-ISO currency labels, missing tenant
  identity, missing idempotency key, insufficient role, and a lost
  compare-and-set after a bounded 8-attempt election.
- **Concurrency:** every movement is a CAS on the account row inside a
  tenant-bound `storage.atomically` composed write (RLS context on a
  transactional driver). Verified by test: three concurrent 400-yen withdrawals
  against a 1000-yen balance admit exactly two and refuse the third; five
  concurrent first deposits converge on one account with no lost update.
- **Tenant isolation:** ids derive from the actor's tenant, every read
  re-checks the stored `tenantId`, and a foreign tenant sees a genuine
  `exists: false` zero — never another tenant's balance.
- **Auditability:** `wallet.credited`, `wallet.debited`,
  `wallet.conversion.completed` (one per leg, paired by `conversionId`),
  `wallet.status.changed`, and `wallet.withdrawal.rejected` are published
  through the Commercial Control Plane with replay-stable idempotency keys,
  composed with the state change. A rejection event is best-effort and can
  never mask the thrown refusal.
- **Scope boundary:** the wallet holds *internal* balances. It is not a payment
  provider and cannot move money outside JATA Qi. Crediting wallets from
  verified provider payments is a separately governed milestone, not T-09.

### D-6 — Injected FX, deterministic, rounded once at the target scale (AC-5)
`packages/commercial-control-plane/src/fx.ts`:

- `FxRateProvider` (object with `id` + `getRate`) or a bare `FxRateResolver`
  function must be injected. **Nothing is bundled:** no rate table, no HTTP
  client, no PSP, no environment-variable rate source. Without an injected
  source, conversion is impossible.
- `createStaticFxProvider(table)` builds a deterministic table provider
  (`'FROM/TO'` keys, positive finite rates validated at construction, duplicate
  pairs rejected). It performs **no inversion**: the reciprocal of a terminating
  decimal is generally not terminating, so deriving `TO/FROM` from `FROM/TO`
  would add an undocumented second rounding. A missing pair fails closed.
- `convertMoney(value, targetCurrency, fx)` multiplies exact decimal parts
  (amount and rate decomposed independently) and rounds the true product ONCE,
  half-up, at the **target** currency's scale. Same-currency conversion is an
  exact identity (rate 1) that still quantizes at its own scale.
- Deterministic: a pure function of (amount, currencies, rate) — no clock, no
  randomness, no I/O, no cache mutation.
- Fail-closed on a missing, zero, negative, or non-finite rate, and on a
  non-finite amount. A conversion whose target amount is zero at the target
  scale (1 JPY → KWD at 0.0001) is refused rather than destroying value.
- The returned `FxConversion` records rate, both scales, both exact minor-unit
  strings, the rounding rule, and the provider id, so a conversion is auditable
  without recomputation.
- The wallet's conversion commits both legs (debit source, credit target) in
  ONE tenant-bound composed write. On a non-transactional development driver
  (`scope.atomic === false`) a failed credit leg explicitly compensates the
  debit and rethrows the original error; on a transactional driver the scope
  rolls back. A partially recorded conversion (one leg only) is refused on
  replay and flagged for operator repair instead of being silently completed.

### D-7 — Currency-aware billing, payments, ledger, reconciliation (AC-3/6/7)
No new call patterns were invented; the existing canonical helpers became
currency-aware and every boundary kept its T-07/T-08 shape:

- **Payments:** intent/refund amounts quantize at the payment currency's scale
  (a 100.5 JPY intent stores 101 JPY); verification compares observed vs
  expected amounts in exact minor units of that currency.
- **Billing:** plan prices, invoice line unit prices and totals quantize at
  their own currency's scale; the line product rule rounds once at that scale
  (JPY `0.5 x 3` → the only valid total is `2`; KWD `19.999 x 3` → `59.997`);
  the invoice total is the exact minor-unit sum in ONE currency (mixed-currency
  invoices are rejected as before).
- **Revenue ledger:** entries quantize per currency; summaries accumulate exact
  minor units per currency and convert once at that currency's scale.
- **Reconciliation:** internal and provider comparisons use the canonical
  currency-aware `moneyEquals`. An `AMOUNT_MISMATCH` now carries a scale
  diagnostic when either side is not representable at its currency's scale
  (e.g. a provider reporting `100.5 JPY`), which turns a silent 2dp assumption
  into an explicit, disputable finding. The stale "T-09 follow-up (R-MONEY-03)"
  note is replaced by the implemented behaviour.
- **Commercial Control Plane budgets:** monetary budget consumption is resolved
  in ONE currency (`budget.currency`, else the single distinct currency of the
  matching MONEY resources, else the budget unit). A monetary budget whose
  matching resources span more than one currency can no longer sum incomparable
  minor units: the check fails closed (`allowed: false`) instead of mixing
  scales. Non-monetary budgets (COMPUTE / API_CALLS quantities) keep their
  existing float accumulation deliberately — those amounts are not money, and
  rewriting them is explicitly outside this authorization.

### D-8 — Migration is expand-only and non-destructive
JATA Qi persists documents (jsonb bodies on PostgreSQL, JSONL on the
development drivers), so there is no monetary column type to alter and no
destructive DDL exists to run. Concretely:

1. **No stored value is rewritten.** `MonetaryValue.amount` keeps its shape and
   value. `money-migration.ts` exposes the pre-T-09 fixed-2dp computations
   (`legacyMinorUnits`, `legacyQuantizeAmount`) purely as an equivalence oracle,
   a read-only `auditMonetaryValue(s)` inspector, and
   `planMonetaryScaleMigration`, whose `rewrites` array is always empty and
   whose `destructive` flag is always `false` — the planner is structurally
   incapable of proposing a rewrite.
2. **2-decimal rows are provably bit-identical.** For every 2dp-currency value,
   `minorUnitsOf(amount, currency) === legacyMinorUnits(amount)` and
   `Object.is(quantizeAmount(amount, currency), legacyQuantizeAmount(amount))`.
   Proved over the persisted-shape corpus (including the IEEE-754 artifacts
   `0.1+0.2`, `1.005`, `2.675`, `19.99x3`) and over a deterministic exhaustive
   enumeration of every 7th cent up to 500.00.
3. **New surfaces are additive.** The wallet collections (`payments.wallets`,
   `payments.wallet-entries`) are created on first use by the storage driver
   (`CREATE TABLE IF NOT EXISTS` + tenant column + RLS policy, exactly as every
   other collection), and wallet rows carry their scale and exact minor-unit
   string alongside the canonical amount. No existing collection, index, RLS
   policy, sequence counter, hash chain, or event schema changed.
4. **Out-of-scale legacy rows are reported, never repaired.** A legacy row such
   as `100.5 JPY` is surfaced as an audit advisory (with what quantization
   *would* produce) for a separately governed decision. T-09 performs no broad
   rewrite of historical monetary data.

## Invariants preserved (verified by the suites below)

- **T-06 tenant isolation / RLS / CAS / sequence integrity:** wallet writes run
  inside tenant-bound composed writes; wallet ids are tenant-derived; every
  read re-checks the stored tenant; no new unscoped namespace/blob open (the
  T-08.1 D-4 lint guard still passes with zero errors).
- **T-06 security invariants and T-07 money semantics:** canonical quantized
  comparison/summation/product rules remain the only money path; the float traps
  (`0.1 + 0.2`, `19.99 x 3`, `1.005`, `2.675`, `1.15 x 0.3`) still resolve
  exactly as documented for 2dp currencies.
- **T-07 B-1 idempotency / reservation release:** payments execution, refund,
  verification, and reservation-recovery paths are untouched apart from the
  currency-aware quantization they already called.
- **T-08 reservation recovery and T-08.1 retry/event/idempotency semantics:**
  unchanged; their regression suites pass unmodified in behaviour (only the
  now-required currency argument was added to their money-helper calls).
- **Existing API compatibility:** module ids, container keys, event types,
  collection names, and every service method signature outside the shared money
  helpers are unchanged. `PaymentsModule.getService()` still returns the same
  `PaymentsService`; the wallet is additive (`getWalletService()`).

## Acceptance criteria status

| AC | Requirement | Status | Primary evidence |
| --- | --- | --- | --- |
| AC-1 | JPY 0-decimal rounding incl. half-up ties | PASS | `money.per-currency.test.ts` (AC-1 suite); `t09-wallet.test.ts` (tie deposits, sub-unit refusal); `t09-per-currency.test.ts` (plan/intent quantization, product rule, end-to-end collection) |
| AC-2 | KWD/BHD/OMR 3-decimal rounding incl. ties | PASS | `money.per-currency.test.ts` (AC-2 suite); `t09-wallet.test.ts` (fils ledger); `t09-per-currency.test.ts` (3dp invoice, one-fils reconciliation dispute) |
| AC-3 | KES/default 2dp behaviour unchanged | PASS | `money.test.ts` (T-07 suite, values unchanged), `t09-money-migration.test.ts` (bit-identity incl. exhaustive enumeration), `t08-1-mrr.test.ts`, `t08-1-money.test.ts`, KES float-trap reconciliation |
| AC-4 | Per-currency wallet, no mixing, currency-aware + fail-closed withdrawals | PASS | `t09-wallet.test.ts` (26 tests: isolation, mismatch, insufficiency, frozen, idempotency, concurrency, tenant isolation) |
| AC-5 | Injected FX, deterministic, target-scale, half-up, no hidden PSP/FX dependency | PASS | `money.per-currency.test.ts` (AC-5 suite, incl. the 1.005 trap where naive float gives 1.00), `t09-wallet.test.ts` (conversion legs, missing/zero/negative rate, dust refusal, replay), `t09-per-currency.test.ts` (conversion in the full composition) |
| AC-6 | Currency-aware reconciliation incl. float traps | PASS | `t09-per-currency.test.ts` (0dp equality, one-yen dispute + scale diagnostic, one-fils dispute, KES `0.1+0.2` still RECONCILED), `t08-1-money.test.ts` |
| AC-7 | Billing/product calculations use the product currency scale | PASS | `t09-per-currency.test.ts` (AC-7 suite: plan prices, 0dp/3dp product rules, exact multi-line sums, mixed-currency rejection) |
| AC-8 | Per-currency analytics/MRR with correct minor units | PASS | `t09-per-currency.test.ts` (JPY 1008 MRR / 12100 ARR, KWD 0.083 MRR, KES 1 MRR unchanged, per-currency observations, no mixed bucket) |
| AC-9 | Source-level safety sweep | PASS | See "AC-9 sweep" below |
| AC-10 | Build, lint, regressions, new deterministic tests | PASS | See "Evidence" below |

### AC-9 sweep (performed over `packages/*/src`)

- **Unsafe `===` on monetary amounts:** none remain. Every hit for
  `amount ===`/`=== ...amount` in `src` is a `typeof` / `Number.isFinite`
  guard, not a value comparison; all monetary value comparisons go through
  `moneyEquals` / `moneyWithin` / `moneyLessThan` / `moneyAtLeast` /
  `moneyProductEquals` on exact minor units.
- **Hard-coded 100 minor-unit conversions:** none in any monetary path. The
  remaining `* 100` / `/ 100` occurrences are confidence percentages and scores
  (`cognitive-kernel`, `probabilistic-engine`, `commercial-health`,
  `commercial-intelligence`, `commercial-memory`, `commercial-observability`,
  `world-model`, `orbital-intelligence`) and were deliberately left untouched.
- **Unconditional `.toFixed(2)`:** none on money. The four `toFixed` call sites
  (`cli` search scores, `unified-loop` hypothesis/causal/probability summaries)
  format probabilities and scores, not amounts.
- **Fixed 2dp quantization:** removed. `DEFAULT_MONETARY_SCALE` survives only as
  the documented fallback for currencies outside the table and as the legacy
  equivalence oracle in `money-migration.ts`.
- **Float accumulation of money:** none remains. The two surviving float
  `reduce`s in the Commercial Control Plane (`sumMatchingResources`, and the
  COMPUTE/API_CALLS totals in `experimentBudgetExceeded`) are explicitly
  non-monetary resource quantities and are now annotated as such; every monetary
  accumulation uses exact minor units.
- Unrelated numeric logic was **not** mechanically changed.

## Evidence

### New deterministic tests (67)

| Suite | Package | Tests | Covers |
| --- | --- | --- | --- |
| `test/money.per-currency.test.ts` | commercial-control-plane | 22 | AC-1, AC-2, AC-3, AC-5, AC-8 primitives: scales, half-up ties at 0/2/3dp, comparisons, sums, products, annual allocation, FX (target-scale rounding, determinism, fail-closed rates, no inversion) |
| `test/t09-money-migration.test.ts` | commercial-control-plane | 6 | expand-only/non-destructive migration: bit-identity vs the legacy oracle, exhaustive 2dp enumeration, read-only audit, rewrite-free plan, out-of-scale reporting |
| `test/t09-wallet.test.ts` | payments | 26 | AC-4, AC-5 at the service boundary: per-currency balances, quantized deposits, case normalization, idempotency, insufficiency, sub-unit rounding trap, cross-currency refusal, currency mismatch, frozen accounts, tenant isolation, append-only entries, events, concurrency (no double spend / no lost update), FX conversions and every refusal |
| `test/t09-per-currency.test.ts` | commercial-command-center | 13 | AC-1, AC-2, AC-3, AC-6, AC-7, AC-8 across the real composition: billing → payments → revenue ledger → reconciliation → analytics, plus the wallet inside the full stack |

These tests assert computed values against the documented rule (not constants),
assert that refused operations moved nothing, and include boundary/tie cases for
JPY 0dp, KES 2dp, KWD 3dp, FX conversion, wallet currency isolation,
reconciliation, MRR, and floating-point traps. Two of them caught real defects
during implementation (the negative-amount sign bug in `minorUnitsOf`, and the
non-invertibility of a terminating decimal rate), which is the intended
failure-capable property.

### Regression suites (unchanged behaviour)

`money.test.ts` (T-07 AC-5 float traps), `control-plane.test.ts`,
`f01-event-fabric*.test.ts`, `payments.test.ts`, `t08-1-reservation.test.ts`,
`b1-plan-failure-reservation.test.ts` (T-07 B-1 / T-08 / T-08.1),
`billing.test.ts`, `revenue-ledger` suites (incl. the PostgreSQL finalization
concurrency suite), `reconciliation.test.ts`, `t08-1-money.test.ts`,
`commercial-analytics.test.ts`, `t08-1-mrr.test.ts`, `command-center.test.ts`,
`storage`/`storage-postgres` T-01/T-04/T-05/T-06/T-08.1 suites, `loop-host`,
`unified-loop`, and every other workspace suite.

### Results on this branch

- **Build:** `npm run build` — all 49 workspaces compile (`tsc -p tsconfig.json`
  + `tsc -p tsconfig.test.json`), exit 0.
- **Lint:** `npm run lint` — **0 errors, 60 warnings**. Baseline on
  `82af3de` was 0 errors, 61 warnings; T-09 adds no warning and removes one
  (a previously unused `MonetaryValue` import in reconciliation is now used by
  the scale diagnostic). All remaining warnings are the pre-existing categories
  documented in `eslint.config.mjs`.
- **Tests:** `npm test` — **821 tests, 819 pass, 2 fail, 0 skipped**
  (baseline `82af3de`: 754 tests, 752 pass, 2 fail, 0 skipped → **+67 tests,
  +0 failures, +0 skips**).
  - The 2 failures are **pre-existing on the base commit and unrelated to
    money**: `@jataqi/agent-runtime` → "knowledge.search tool hits the knowledge
    service" and `@jataqi/cli` → "ingests text, extracts entities, and
    retrieves", both failing with
    `KnowledgeService: ingestText tenantId missing — falling back to
    DEFAULT_TENANT_ID="default" ... Failing closed.` They fail identically
    before and after this change; fixing them is outside the T-09 authorization
    (it is knowledge-service tenant plumbing, not monetary code).
  - Per-suite counts for the touched workspaces: commercial-control-plane 65,
    payments 42, commercial-command-center 16, revenue-ledger 20,
    commercial-analytics 9, reconciliation 6, billing 6 — all 0 failures.
  - PostgreSQL-backed suites execute against the embedded instance when the
    binaries are available in the environment and report an explicit skip
    otherwise (harness behaviour, unchanged); this run reported **0 skipped**.

### Changed files

New (8) — none of these paths existed in canonical `main`:
`packages/commercial-control-plane/src/fx.ts`,
`packages/commercial-control-plane/src/money-migration.ts`,
`packages/commercial-control-plane/test/money.per-currency.test.ts`,
`packages/commercial-control-plane/test/t09-money-migration.test.ts`,
`packages/payments/src/wallet-service.ts`,
`packages/payments/test/t09-wallet.test.ts`,
`packages/commercial-command-center/test/t09-per-currency.test.ts`,
`docs/T09_PER_CURRENCY_MONEY_AND_WALLET_FX.md` (this document).

Modified (14):
`packages/commercial-control-plane/src/money.ts` (currency-aware core),
`packages/commercial-control-plane/src/index.ts` (exports),
`packages/commercial-control-plane/src/commercial-control-plane-service.ts`
(currency-aware budget minor units + fail-closed ambiguous budget currency),
`packages/commercial-control-plane/test/money.test.ts` (explicit currency arg),
`packages/payments/src/types.ts` (wallet types/events),
`packages/payments/src/module.ts` (wallet wiring),
`packages/payments/src/index.ts` (exports),
`packages/payments/src/payments-service.ts` (comment: per-currency boundary),
`packages/billing/src/billing-service.ts` (comments: per-currency scale),
`packages/reconciliation/src/reconciliation-service.ts` (scale diagnostics),
`packages/reconciliation/test/t08-1-money.test.ts` (explicit currency arg),
`packages/revenue-ledger/src/revenue-ledger-service.ts` (currency-aware minor units),
`packages/commercial-analytics/src/commercial-analytics-service.ts`
(currency-aware minor units + generalized annual allocation),
`packages/commercial-analytics/test/t08-1-mrr.test.ts` (explicit currency arg).

No `package.json`, `package-lock.json`, workspace, tsconfig, storage-driver,
RLS, or schema-version change was required.

**Disclosure (documentation, not code):** this file path previously held an
untracked T-09 *proposal* that was supplied as specification input and was never
committed to canonical `main`. It has been replaced in place by this
implementation/milestone document. No tracked or canonical content was
overwritten; the proposal's requirements are reflected in the AC table above.

## Known limitations (honest scope statement)

1. **The scale table is a curated list, not the full ISO-4217 registry.** Only
   the currencies whose minor unit differs from 2 are listed (JPY/KRW/CLP at 0;
   BHD/KWD/OMR at 3). Other real 0-decimal currencies (e.g. VND, PYG) and
   3-decimal currencies (e.g. IQD, LYD, TND) resolve to the documented 2dp
   default until they are added. Adding an entry is expand-only.
2. **Legacy payment/billing boundaries still accept non-ISO currency labels.**
   `payments`/`billing` validate only "non-empty currency" (unchanged from
   T-07) so no existing integration breaks; an unknown label resolves to the
   2dp default. The **wallet** is stricter and requires a 3-letter ISO-4217
   code, because it is a new surface with no compatibility constraint.
3. **FX rates are host-supplied and static per call.** No rate freshness,
   validity window, spread, or rate-source attestation is modelled; a host that
   injects a stale rate converts at that stale rate deterministically. Rate
   governance (signed rate feeds, validity windows) is future work.
4. **No rate inversion.** A provider that only knows `USD/JPY` cannot serve
   `JPY/USD`; the conversion fails closed instead of deriving a reciprocal.
5. **The wallet is not connected to verified provider payments.** Deposits are
   explicit governed operations with an idempotency key and reason; automatically
   crediting a wallet from a `payment.verified` event (and debiting on refund)
   is a separately governed milestone.
6. **Analytics averages keep 4-decimal reporting.** `arpu`, `cac`, `roas`, and
   `ltv` are statistical ratios, not payable amounts; quantizing them at the
   currency scale would change existing 2dp results (forbidden by AC-3).
7. **`Number` is still the storage type for amounts.** Exact integer minor
   units are authoritative for every comparison and movement, but a stored
   amount whose minor units exceed 2^53 cannot be represented exactly as a
   JSON number (pre-existing T-07 limitation; the wallet additionally persists
   the exact minor-unit string so its authoritative value is never lossy).
8. **Pre-existing PostgreSQL production gates are untouched.** T-09 does not
   deliver HA/PITR, Redis production deployment, PSP integration, M-Pesa
   activation, ABAC/ReBAC/PAM, OIDC/SAML, or Maps activation. Production
   infrastructure remains a separate deployment gate and is **not** solved by
   this milestone.
9. **Two unrelated pre-existing test failures remain** (knowledge-service
   tenant fallback in `agent-runtime` and `cli`), documented above.

## Rollback considerations

Rolling back this commit restores the fixed-2dp money helpers and removes the
wallet surface. Because T-09 rewrites no stored value, no data rollback is
required: wallet collections simply stop being read (they can be dropped
without affecting any other collection). Money semantics for 2dp currencies are
identical before and after, so no downstream consumer observes a value change.
The one behavioural difference on rollback is the negative-amount sign fix
(D-3), which no boundary can currently reach.

## Verification request / stop condition

Implementation is complete and the branch is pushed. Per the authorization:

- **The T-09 PR is NOT merged.** Independent read-only verification is
  requested before any merge decision.
- T-10 has **not** been started.
- Canonical `main` is unmodified; it changes only through the separately
  governed merge process after an independent PASS and explicit merge
  authorization.
