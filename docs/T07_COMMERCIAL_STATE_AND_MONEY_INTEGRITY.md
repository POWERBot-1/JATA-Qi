# T-07 — Commercial state-transition and money-math integrity hardening

**Milestone:** T-07 · **Base:** `main` @ `b4a79054a80db4d042cf7a4948be0e1881f7e85d` (merge of PR #16 / T-06) · **Branch:** `arena/01a07352-jata-qi`
**Approved proposal (authoritative):** `/home/user/T07_PROPOSAL_AND_GAP_ASSESSMENT.md` (risk register R-01/R-02, AC-1..AC-10, invariants I-1..I-7).

## Objective

Eliminate the two highest-ranked code-level integrity risks remaining after T-06:

1. **R-01 — race-unsafe commercial state transitions**: payments verify/refund finalization was
   read-check-then-blind-write with `updatedAt`-dependent idempotency keys, so two concurrent
   finalizations could double-publish and double-append downstream revenue.
2. **R-02 — float money math**: `MonetaryValue.amount` arithmetic ran on raw IEEE-754 floats with
   strict float equality (`0.1 + 0.2` could false-mismatch a valid invoice; sums drift; no rounding
   policy existed).

No T-06 tenant/RLS/sequence control is weakened; no storage-format migration is introduced.

## Design decisions (recorded)

### D-1 — Money policy: 2-dp minor-unit quantization (default per currency), no migration
- Monetary values carry an implicit minor-unit scale of **2 decimal places for every currency**
  (no per-currency table in this milestone; documented limitation).
- **Boundary treatment is quantization**: amounts that are not exactly representable at the scale
  are rounded **half-up on the exact decimal value** (ties away from zero) at the boundary
  (payment intents/refunds, billing plan prices, invoice lines/totals, ledger cost records).
  Amounts already at or under the scale pass through bit-identical, so **all existing persisted
  records and fixtures keep their exact values** (verified: no test fixture uses >2 dp).
- **Comparisons** (`moneyEquals`, `moneyWithin`, policy/budget limit checks) compare exact integer
  minor units derived from the decimal (shortest round-trip) representation.
- **Sums** (billing `sumLines`, revenue-ledger summaries, commercial-analytics totals, CCP budget
  consumption) accumulate exact minor units per currency and convert once at the end.
- **Product rule** (invoice line `unitPrice x quantity === total`) multiplies exact decimal parts
  and rounds the true product once (float artifacts can never reject a valid line).
- Persisted `amount: number` fields are unchanged in shape (float), but every value is now
  quantized at the boundary and every comparison/sum is scale-exact; a float value with more than
  2 dp can only exist in pre-existing legacy rows, where it is quantized on comparison/sum.
- Implementation: shared module `packages/commercial-control-plane/src/money.ts` (exported from
  the package index) consumed by payments/billing/revenue-ledger/commercial-analytics/CCP.

### D-2 — Single-finalization anchors (I-1/I-6): stable keys + row-level CAS guards
- Payment finalization events use **stable per-(payment, transition) idempotency keys**
  (`payment-verified:<id>`, `refund-verified:<id>`, `payment-failed:<id>:create|refund:<actionId>`)
  — `updatedAt` is never key material.
- The transition itself is an **expected-status compare-and-set inside the composed write**
  (storage `ICollection.cas`, PostgreSQL `SELECT … FOR UPDATE` row lock):
  - `verifyPayment`: `SUCCEEDED_UNVERIFIED -> VERIFIED|FAILED` — concurrent losers read and return
    the winner's final state without emitting (AC-1/I-3/I-7).
  - `verifyRefund`: `REFUND_UNVERIFIED -> REFUNDED|FAILED` — same semantics.
  - `executePayment`/`requestRefund` reserve `-> PROCESSING` / `-> REFUND_PROCESSING` with CAS
    **before planning**, so two concurrent first-time executions/refund requests cannot both plan
    (AC-2); planning failure rolls the reservation back.
- Billing finalization is an invoice-row CAS (`ISSUED|PAYMENT_PENDING -> PAID`, `PAID -> REFUNDED`)
  with replay-stable event keys (`<invoiceId>:<paymentId>`) — duplicate deliveries cannot re-emit.
- Revenue-ledger appends are guarded by a **first-write-wins anchor row** per
  (tenant, entryType, invoiceId, paymentId) inside the same composed write as the entry itself;
  the anchor's row id is the uniqueness constraint, so two *different* duplicate events can never
  create two entries, and replay after success is a no-op (AC-4/I-6).

### D-3 — Execution-time provider precondition (I-2/AC-3)
- The payments provider adapter re-reads the current payment state on every execution attempt:
  - `REFUND_PAYMENT` executes only while the payment is `REFUND_PROCESSING`; a stale refund action
    (payment already `REFUNDED`, `REFUND_UNVERIFIED`, `FAILED`, …) fails closed **before any
    provider call** with an explicit summary.
  - `CREATE_PAYMENT` executes only from pre-execution states (`PROCESSING`, `DRAFT`,
    `REQUIRES_ACTION`, `FAILED` for provider-decline retry parity); a replay after
    `SUCCEEDED_UNVERIFIED`/`VERIFIED`/`REFUNDED`/… fails closed.

### D-4 — Namespace/blob stores are IN-BOUNDARY for JATA Qi (F-01/R-06 decision, recorded)
The `openNamespace`/`openBlobStore` storage surfaces are part of the tenant-data trust boundary of
JATA Qi, even though they currently have **zero production callers** (interface + storage layer +
tests only) and are not RLS-scoped. Decision: treat them as in-boundary; **hardening them
(scoped/Rls-aware variants or explicit removal) is a future milestone** — they are deliberately
NOT implemented in T-07 (out of the approved scope). Any future caller must not be added before
that hardening milestone lands.

## In scope (implemented)

1. Shared quantized money utilities + boundary quantization + exact sums/products (D-1);
2. Payments state-transition CAS + stable single-finalization anchors (D-2);
3. Billing invoice/subscription finalization CAS + replay-stable keys (D-2);
4. Revenue-ledger single-effect anchor rows (D-2);
5. Execution-time provider precondition (D-3);
6. CCP policy/budget/experiment monetary comparisons and consumption moved to scale-exact math;
7. Regression + adversarial tests (AC-1..AC-5) over real PostgreSQL with real OS processes;
8. Documentation corrections (F-02: inventory header 25→24) + this design doc + D-4 paragraph.

## Out of scope (unchanged from the approved proposal)
OIDC/mTLS activation, secret manager, real provider/connector adapters, encryption host
implementations, backups/PITR/HA, namespace/blob RLS (D-4), knowledge `DEFAULT_TENANT_ID`
fallback removal, revocation re-check at dispatch, CI SHA pinning, lint debt/pg@9, ABAC resource
conditions, HTTP/API server, LLM integration, unrelated refactors, storage-format migrations.

## Security invariants (must hold before/after; verified by the T-07 suite)
- I-1: A commercial finalization is publishable at most once per (payment, transition) — CAS +
  stable anchor, not caller discipline.
- I-2: No provider invocation by an action whose current state no longer authorizes it.
- I-3: Concurrent finalizations serialize to exactly one state change; losers observe the winner's
  state.
- I-4: No strict float equality/comparison on amounts in commercial `src` (grep-enforced).
- I-5: All T-06 tenant/RLS/sequence guarantees unchanged; every new write stays inside the
  existing composed, tenant-bound scope (new ledger anchor rows carry `tenantId` and are written
  under the event-tenant RLS context).
- I-6: Duplicate or replayed events can never create a second ledger/billing effect.
- I-7: Redelivery of a finalization event after success returns the recorded result, never a
  second mutation.

## Acceptance criteria status
| AC | Outcome |
| --- | --- |
| AC-1 two concurrent OS-process verifyPayment → 1 finalization, 1 event, 1 ledger entry | PASS (real PG) |
| AC-2 two concurrent OS-process requestRefund → ≤1 provider execution, loser fail-closed | PASS (real PG) |
| AC-3 stale refund action executes fail-closed with no provider call | PASS (real PG) |
| AC-4 duplicate/replayed finalization events → no second ledger entry, no re-emit | PASS (real PG) |
| AC-5 float traps (0.1+0.2; 0.1×3; 19.99×3; 1.005; 1.15×0.3) deterministic & correct | PASS (unit + real PG + analytics) |
| AC-6 zero strict float equality on `amount` in the five in-scope commercial packages | PASS (grep) |
| AC-7 T-05/T-06 real-PG regression green, 0 skips | PASS (full suite) |
| AC-8 build RC 0; lint 0 errors, no new warnings; full committed-tree run 0 fail / 0 skip | PASS |
| AC-9 diff limited to the declared packages + docs | PASS |
| AC-10 independent read-only verification | pending by design |

## Known limitations (honest scope statement)
- **Reconciliation matcher (post-T-07 backlog, R-02b):** `packages/reconciliation/src/reconciliation-service.ts`
  keeps an informational strict-float `moneyEquals` when comparing provider-reported amounts with
  internal payment amounts (discrepancy *reporting*, not revenue math). It is outside the AC-9
  declared packages, so it was deliberately not migrated in T-07; it is registered for the
  follow-up money-policy sweep.
- No per-currency minor-unit table exists (D-1): the default 2-dp scale applies to every currency.
- Anchor rows (`revenue-ledger.settlement-anchors`) protect effect duplication going forward;
  entries appended before T-07 remain deduplicated by the retained `sourceEventId` query guard.
- The money boundary quantization rounds >2-dp inputs at entry; callers that require rejection
  instead of rounding can add a strict-scale validator on top of the shared helpers.

## Rollback considerations
- Single-commit changeset; rollback = revert the commit. No schema/data migration; the only new
  persistent objects are rows in new/behavioural collections created through the existing
  driver `ensureResource` path (`revenue-ledger.settlement-anchors`) — removing the code removes
  the tables' usage (tables may remain, empty, harmless).
- The pre-change merge commit `b4a79054…` is the rollback target; T-05/T-06 suites are the
  rollback gate.

## Evidence index
- Money module + unit tests: `packages/commercial-control-plane/src/money.ts`,
  `packages/commercial-control-plane/test/money.test.ts`.
- Payments CAS/anchors/precondition: `packages/payments/src/payments-service.ts`.
- Billing CAS finalization: `packages/billing/src/billing-service.ts`.
- Ledger anchors + exact summaries: `packages/revenue-ledger/src/revenue-ledger-service.ts`.
- Analytics exact totals: `packages/commercial-analytics/src/commercial-analytics-service.ts`.
- CCP scale-exact comparisons/budgets: `packages/commercial-control-plane/src/commercial-control-plane-service.ts`.
- Adversarial real-PG suites (AC-1..AC-5): `packages/revenue-ledger/test/t07-finalization-concurrency-pg.test.ts`,
  worker `packages/revenue-ledger/test/t07-finalize-worker.mjs`.
- F-02: `docs/T06_CHANGED_FILE_INVENTORY.md` header correction.
