# JATA Qi Commercial & Product Packaging Engine

`@jataqi/commerce` — a configurable commercial-engineering layer: product
catalogue, editions, plans, entitlements, subscriptions/trials, usage metering
with quota enforcement, credits, licensing, invoicing (tax/discount), marketplace
economy with commission splits, analytics, admin overrides, and audit.

## Design principles (per the master directive)

- **Nothing is hard-coded.** Products, plans, editions, prices, entitlements,
  billing cycles, currencies and commission rates are all admin-defined data.
  The seeded plans (Free, Personal, Developer, Team, Business, Enterprise,
  Student, Education, Research, Government, OEM, White Label) are editable
  templates, not immutable logic.
- **One source of truth for access:** the Entitlement Engine. Application code
  calls `commerce.check(customerId, feature)`; it never sprinkles plan checks.
- **Money is explicit.** `Money = { amount, currency }`. The engine never
  silently converts across currencies — MRR and revenue are reported
  **per-currency**.
- **Credits ≠ currency.** JATA Qi Credits are a separate ledger from
  KES/USD/GBP/EUR.
- **Trials are explicit.** The platform never auto-charges or auto-trials; a
  trial starts only when requested.
- **Payments are abstracted.** A `PaymentProvider` adapter must be supplied
  (`setPaymentProvider`). No real money movement or provider is wired by default.

## What is real & tested

Configurable catalogue/plans; subscribe / upgrade / downgrade (immediate &
scheduled) / cancel (immediate & at-period-end) / pause / resume; trials (no
auto-charge) + trial-conversion counting; metered usage + quota enforcement +
threshold events; credits (grant / FIFO consume / expiry / low-credit events);
licenses (issue / verify active|expired|revoked); invoices with configurable tax
& discount; payment abstraction (charge/refund via adapter, with failure
handling); marketplace purchase with configurable platform-commission split +
seller payouts; admin entitlement overrides (audited, temporary); analytics
(MRR per currency, by-status/by-plan counts, trial funnel, order/invoice counts);
commercial audit events (routed to the security audit ledger when present).

## What is NOT done (honest)

- No real payment provider is integrated (cards/mobile money/wallets) — only the
  adapter contract exists.
- No customer billing portal or admin commercial console UI (HTTP API only).
- No dunning/retry schedule engine, no tax-jurisdiction database, no coupon
  engine, no partner/referral program, no procurement/quote/PO flow.
- No real marketplace storefront, discovery, ratings, or real payout execution.
- Multi-tenancy/organization billing is modelled (`organizationId`) but full
  tenant isolation is not yet enforced platform-wide.

These are tracked as `PARTIALLY_IMPLEMENTED` in `GET /readiness`.

## API (representative; all under `commerce:read` unless noted)

```
GET  /commerce/plans                  # configurable plan catalogue
POST /commerce/subscribe              # {planSlug, currency?, seats?, trial?}
POST /commerce/subscription           # {id, action: upgrade|downgrade|cancel|pause|resume, planSlug?}
GET  /commerce/check?feature=          # entitlement decision for the caller
POST /commerce/meter                  # {customerId?, metric, qty}
GET  /commerce/credits?customerId=     # credit balance
POST /commerce/credits                # {customerId, amount, source}  (grant)
GET  /commerce/analytics              # MRR, counts, funnel
POST /commerce/marketplace            # {item, currency?}  → order + payout
```

The engine is exposed programmatically via `@jataqi/commerce` (`CommerceModule`)
and is wired into `createJataQi`.
