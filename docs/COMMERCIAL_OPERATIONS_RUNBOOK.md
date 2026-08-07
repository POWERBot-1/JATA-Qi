# Commercial Operations Runbook

## Editions & plans

All seven required editions are seeded in `packages/commerce/src/catalog.ts`
(FREE · PERSONAL · DEVELOPER · TEAM · BUSINESS · ENTERPRISE · GOVERNMENT +
STUDENT/EDUCATION/RESEARCH/OEM/WHITE_LABEL). Plans carry entitlements, quotas,
pricing by currency, billing cycles, and optional trials.

## Subscription lifecycle (state machine)

| Action | Endpoint | Result |
| ------ | -------- | ------ |
| Subscribe (incl. trial) | `POST /commerce/subscribe` | TRIAL / ACTIVE |
| Upgrade | `POST /commerce/subscription {action:upgrade, planSlug}` | plan change |
| Downgrade | `POST /commerce/subscription {action:downgrade, scheduleAtPeriodEnd}` | pending plan |
| Cancel | `POST /commerce/subscription {action:cancel, immediate}` | CANCELLED |
| Pause / Resume | `... {action:pause|resume}` | PAUSED / ACTIVE |
| Suspend | `... {action:suspend, reason}` | SUSPENDED (audited) |
| Reactivate | `... {action:reactivate}` | REACTIVATED (audited) |

Trials are explicit only — the platform never auto-charges or auto-trials.
Conversion is recorded when a trial upgrades.

## Billing

```
POST /commerce/invoice       { customerId, planSlug }   → invoice (DRAFT/ISSUED)
POST /commerce/invoice/pay   { id, paymentRef }         → PAID
GET  /commerce/invoices?customerId=...                  → list
GET  /commerce/billing-state?customerId=...             → composed state
```

Invoice states: DRAFT · ISSUED · PAID · OVERDUE · VOID · REFUNDED.

## Usage metering & entitlements

```
POST /commerce/meter   { customerId, metric, qty }   # records + returns decision
GET  /commerce/check?customerId=..&feature=..        # entitlement evaluation
```

Metered features are enforced per plan quota with optional admin overrides.

## Commercial KPIs (`GET /commerce/analytics`)

- `activePayingTenants` / `payingTenants`
- `mrr` (per currency) · `arr` (per currency) · `revenuePerTenantMinor`
- `trialStarts` / `trialConversions` / `conversionRate`
- `churnCount` (CANCELLED + EXPIRED)
- `byStatus` / `byPlan` distributions

## Dunning & suspension procedure

1. Invoice OVERDUE → grace period (subscription status GRACE_PERIOD).
2. Non-payment → suspend account + subscription with reason
   (`jataqi customer suspend` + `{action:suspend}`) — audited.
3. Payment received → reactivate both.
4. Persistent non-payment → cancel + offboard with data-retention policy.

## Tenancy & isolation

- Billing state, usage, invoices, entitlements are keyed by `customerId`
  (the principal userId on the gateway) — never shared across tenants.
- Customer accounts bind tenant ↔ org ↔ admin ↔ subscription with unique
  `tenantId` per customer.
