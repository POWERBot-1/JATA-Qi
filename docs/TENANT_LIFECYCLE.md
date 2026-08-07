# Tenant Lifecycle Documentation

The tenant lifecycle is owned by `@jataqi/onboarding` (customer accounts) +
`@jataqi/commerce` (subscriptions) + `@jataqi/product-marketplace` (products).

## Lifecycle states

```
provisioning ──► active ──► suspended ──► offboarding ──► offboarded
                    ▲            │
                    └────────────┘ (reactivate)
```

### 1. Provisioning

- Guided onboarding run creates the org profile, admin account, tenant
  (isolated namespace + region + storage driver + quotas), invites, and
  optional sample data.
- `createCustomerAccount` binds the tenant to a billing identity
  (`customerId`) and plan.

### 2. Active

- Subscription ACTIVE / REACTIVATED; products installed and running;
  usage metered against plan entitlements; invoices issued and paid.

### 3. Suspended

- Account + subscription suspended with a recorded reason (non-payment,
  abuse, policy). Entitlement checks still return decisions but billing
  state shows SUSPENDED.

### 4. Offboarding

- Retention policy captured: `retentionDays` (default 30) + `deleteData`
  flag (default true). Status `offboarding` blocks new provisioning.

### 5. Offboarded

- `executeOffboarding` produces a SHA-256 evidence record
  (`OffboardingRecord`: tenantId, retentionDays, deleteData, evidenceHash,
  completedAt) — the auditable data-retention/deletion workflow.

## API surface

```
POST /customers/accounts                    create
GET  /customers/accounts?status=            list
GET  /customers/account?id=|customerId=     get
POST /customers/accounts/subscription       assign subscription
POST /customers/accounts/suspend            suspend (reason)
POST /customers/accounts/reactivate         reactivate
POST /customers/accounts/offboard           start offboarding (retention)
POST /customers/accounts/offboard/execute   execute + deletion evidence
GET  /customers/offboardings                audit records
GET  /customers/stats                       lifecycle counts
```

## Isolation guarantees (tested)

- Unique `tenantId` per customer account.
- Billing state / usage / invoices keyed by `customerId` — cross-tenant
  reads return empty.
- Evidence records include the tenant id for audit traceability.
