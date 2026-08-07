# Customer Onboarding Runbook — First Paying Customers

Controlled pilot → production customer path. Use sandbox customers first
(`--sandbox`), then the same flow with real billing.

## 1. Pilot flow (verified end-to-end)

```
node examples/customer-pilot.mjs        # 17-step sandbox pilot → docs/CUSTOMER_PILOT_REPORT.md
```

Pilot steps: signup → tenant → subscription → billing → provisioning →
product install → usage → support → renewal/cancellation.

## 2. Production customer onboarding (operator)

```bash
# 1. Identity
jataqi register <customer-admin> <pw> --roles developer
jataqi login <customer-admin>

# 2. Guided onboarding (tenant + org + admin + invites)
jataqi onboard start "Acme Corp" ceo@acme.com --industry fintech --region KE
jataqi onboard profile <runId> "Acme Corp" acme
jataqi onboard admin <runId>
jataqi onboard tenant <runId> --region nbo-1 --driver postgres
jataqi onboard invite <runId> eng@acme.com developer
jataqi onboard sample <runId> marketplace,tanya
jataqi onboard complete <runId>

# 3. Customer account (billing identity binding)
jataqi customer create "Acme Corp" <principalUserId> --admin ceo@acme.com --plan business

# 4. Subscription + billing
#    (gateway binds to the principal id — see the API reference)
POST /commerce/subscribe        { customerId, planSlug }
POST /customers/accounts/subscription   { accountId, subscriptionId, planSlug }
POST /commerce/invoice          { customerId, planSlug }        # billing event
POST /commerce/invoice/pay      { id, paymentRef }              # payment status

# 5. Products
jataqi products install soma     # tanya → soma dependency order
jataqi products runtime soma running

# 6. Usage + metering
POST /commerce/meter   { customerId, metric, qty }
GET  /commerce/billing-state?customerId=...    # subscription + invoices + usage
```

## 3. Tenant lifecycle

| Stage | Action | Evidence |
| ----- | ------ | -------- |
| Active | `jataqi customer create` | account status active |
| Suspended | `jataqi customer suspend <id> "reason"` | reason recorded; subscription SUSPENDED |
| Reactivated | `jataqi customer reactivate <id>` | account active + subscription REACTIVATED |
| Offboarding | `jataqi customer offboard <id> --retention-days 90` | status offboarding, retention policy |
| Offboarded | `jataqi customer offboard-execute <id>` | SHA-256 deletion evidence |

Data-retention workflow: every offboarding produces an `OffboardingRecord`
with a content-hash evidence attestation (`retentionDays`, `deleteData`,
`tenantId`) — auditable and tenant-isolated.

## 4. Sandbox → production

1. Run `examples/customer-pilot.mjs` (sandbox) — must be 17/17.
2. Run `examples/phase5-validation.mjs` — acceptance gate must be 33/33.
3. Create the real customer with a billing provider (Stripe / M-Pesa /
   Flutterwave adapters in `@jataqi/payments`).
4. Issue the first invoice and verify `PAID` status with a real payment ref.
