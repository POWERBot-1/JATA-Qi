# Change Log — v1.0.0 → Phase 5

All changes are backward compatible; the v1.0.0 baseline is intact.

## Strengthened (no duplicates created)

### @jataqi/commerce
- `suspend(id, reason?)` / `reactivate(id)` — audited subscription states
  (SUSPENDED / REACTIVATED were already modeled; now exposed + audited).
- `customerBillingState(customerId)` — composed billing state
  (subscription + invoices by status + in-period usage) for billing UIs and
  dunning.
- `analytics()` commercial KPIs: `activePayingTenants`, `payingTenants`,
  `arr` (per currency), `revenuePerTenantMinor`, `churnCount`,
  `conversionRate` (trial → paid). KPI filters treat REACTIVATED and
  GRACE_PERIOD as active (billing truth).

### @jataqi/onboarding (customer account lifecycle)
- `createCustomerAccount` — binds onboarding run / tenant / org / admin to a
  commerce billing identity + plan.
- `assignSubscription` — edition enforcement binding.
- `suspendAccount` / `reactivateAccount` — lifecycle with recorded reason.
- `startOffboarding` / `executeOffboarding` — data-retention policy +
  SHA-256 deletion evidence records (`OffboardingRecord`).
- `listAccounts` / `accountByCustomer` / `accountStats` — tenant-scoped
  management.

### API gateway
- `/customers/accounts*` lifecycle routes (create/list/get/subscription/
  suspend/reactivate/offboard/offboard-execute/offboardings/stats).
- `/commerce/billing-state`, `/commerce/invoice` (issue), `/commerce/
  invoice/pay` (payment status), `/commerce/invoices` (list).
- `/commerce/subscription` action now supports `suspend` + `reactivate`.

### SDK / CLI
- SDK: `onboarding.*` customer methods, `commerceStats.billingState /
  createInvoice / payInvoice / invoices`.
- CLI: `jataqi customer create|accounts|account|assign|suspend|reactivate|
  offboard|offboard-execute|stats`.

## New artifacts

- `examples/customer-pilot.mjs` — 17-step sandbox pilot
  (docs/CUSTOMER_PILOT_REPORT.md).
- `examples/phase5-validation.mjs` — 33-check acceptance gate
  (docs/PHASE5_VALIDATION_REPORT.md).
- Tests: commerce 12 → 16 (commercial lifecycle, billing state, isolation,
  KPIs); onboarding 5 → 10 (customer lifecycle + isolation);
  `packages/cli/test/phase5.test.ts` — 4 gateway E2E tests.

## Docs

- CUSTOMER_ONBOARDING_RUNBOOK.md · COMMERCIAL_OPERATIONS_RUNBOOK.md ·
  TENANT_LIFECYCLE.md · MARKETPLACE_PROVISIONING.md ·
  BACKUP_RESTORE_RUNBOOK.md · PRODUCTION_RUNBOOK.md (updated) ·
  ADMIN_GUIDE.md (updated) · API_REFERENCE.md (updated).

## Regression

Full suite green; v1.0.0 GA validation (31/31) and deploy validation remain
green.
