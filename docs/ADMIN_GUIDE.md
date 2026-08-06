# JATA Qi — Administrator Guide

Covers day-0 onboarding, product management, and commercial operations for
platform administrators.

## 1. Guided onboarding (new tenants)

```
jataqi onboard start "Acme Corp" admin@acme.com --industry fintech --region KE
jataqi onboard profile <runId> "Acme Corp" acme
jataqi onboard admin <runId>
jataqi onboard tenant <runId> --region nbo-1 --driver postgres
jataqi onboard invite <runId> dev@acme.com developer
jataqi onboard sample <runId> marketplace,tanya
jataqi onboard complete <runId>
```

Every step is tracked (6-step checklist); tenant provisioning creates an
isolated namespace with quotas. The full flow is also available through the
gateway (`/onboarding/*`) for UI-driven onboarding.

## 2. Product marketplace (one-click provisioning)

```
jataqi products catalog          # TANYA, MAZA, SOMA, Moto X, Nyumbani + custom
jataqi products install soma     # auto-installs its tanya dependency
jataqi products runtime soma running
jataqi products upgrades         # newer versions available
jataqi products upgrade soma
jataqi products uninstall tanya  # blocked while soma depends on it
```

Dependency resolution is automatic (topological install order); uninstall is
blocked while dependents exist; version compatibility against the platform is
enforced.

## 3. Editions, plans, entitlements (via @jataqi/commerce)

- Editions: FREE · PERSONAL · DEVELOPER · TEAM · BUSINESS · ENTERPRISE ·
  GOVERNMENT (seeded catalog in `packages/commerce/src/catalog.ts`).
- Entitlements: `check(customerId, feature, qty)` evaluates plan limits;
  `meterUsage` records usage and returns the post-increment decision.
- Invoices + payments: Stripe / M-Pesa / Flutterwave adapters in
  `@jataqi/payments`; gateway `/commerce/*`.

## 4. Security operations (summary — see PRODUCTION_RUNBOOK.md)

- `jataqi soc report` — executive posture
- `jataqi defense posture` — active-defense state
- `jataqi secauto compliance` — ISO 27001 evidence report
- `jataqi ops health` — operational health
- `jataqi review schedule ...` — independent reviews

## 5. Deployment

- Kubernetes/Helm: `kubectl apply -k deploy/k8s` or
  `helm install jataqi deploy/helm/jataqi` (PSS-restricted namespace,
  per-pillar network policies, cert-manager TLS).
- Terraform: `terraform apply` (primary) + `deploy/terraform/dr-region.tf`
  for the multi-region DR site.
- Health: `GET /health`, `/livez`, `/readyz`; Prometheus `/metrics`.

## 6. Support escalation

1. Admin → on-call rotation (pager chain)
2. On-call → SOC lead (SEV2+)
3. SOC lead → CISO (SEV1 / breach)
4. Vendor support contract (production support tiers) — see SUPPORT.md
