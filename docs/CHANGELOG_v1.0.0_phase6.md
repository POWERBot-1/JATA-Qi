# Change Log — v1.0.0 → Phase 6

Phase 6 deploys v1.0.0 into a production environment and prepares the first
paying customer. Backward compatible; the Phase-5 architecture is preserved.

## Production infrastructure kit (new: deploy/production/)

- `provision.sh` — VPS hardening (UFW deny-by-default + 22/80/443, fail2ban,
  unattended-upgrades, sysctl hardening, swap), Node 22, Docker + compose,
  non-root service user, persistent storage dirs.
- `docker-compose.prod.yml` — PostgreSQL 16 + Redis 7 (health-gated,
  password-protected) + JATA Qi (ghcr.io/powerbot-1/jataqi:1.0.0) + nginx +
  certbot (auto-renew).
- `nginx.conf` — HTTP→HTTPS redirect (301), TLS 1.2/1.3, HSTS + security
  headers, /ws upgrade proxying, api + app subdomains.
- `jataqi.service` — hardened systemd unit: non-root, NoNewPrivileges,
  ProtectSystem=strict, private /tmp, bounded capabilities, memory limit.
- `production.env.example` — all production env vars with placeholders
  (strict separation from sandbox credentials; chmod 600).
- `backup.sh` — pg_dump + namespace snapshot + content-hash verification +
  retention (cron-ready).
- `deploy.sh` — builds the exact v1.0.0 tree, installs to /opt/jataqi,
  sources production.env, starts + health-gates /readyz.
- `README.md` — full operator runbook (DNS records, certbot, secrets,
  deploy, backups).

## Payment webhook (new gateway capability)

- `POST /payments/webhook/stripe` (public — the signature IS the auth):
  HMAC-SHA256 signature verification over the exact raw payload
  (Stripe `constructWebhookEvent`), 5-minute timestamp tolerance,
  constant-time comparison; invalid signatures → 400 with no detail leak.
- Side effects on `payment_intent.succeeded`: mark the customer's outstanding
  invoices PAID and reactivate a suspended/past-due subscription
  (payment → invoice → subscription → entitlement flow).
- Gateway `GatewayRequest.rawBody` added (exact request body text) for
  signature verification — additive, no behavior change for other routes.
- Verified: valid signature → 200 + invoice PAID; tampered signature → 400.

## Validation

- `examples/phase6-validation.mjs` — 29/29 executable checks in
  production-mode: boot/version, health/livez/readyz, **persistent storage
  survives restart**, DLP/audit/defense/SOC active, no secrets in responses
  or logs, webhook verify + reject + billing side effects, on-call/backup
  verification/ops health/analytics, full first-customer lifecycle with the
  first commercial transaction + audit trail.
- Reports: `docs/PHASE6_PRODUCTION_DEPLOYMENT_REPORT.md`,
  `docs/FIRST_CUSTOMER_PRODUCTION_REPORT.md`.
- External items (real DNS records, CA-issued TLS, production payment keys,
  PostgreSQL/Redis daemons) are operator-executed on the VPS with exact
  runbooks — the harness marks them EXTERNAL and provides the local
  equivalent checks.

## Regression

Full suite green; Phase 5 acceptance gate (33/33), customer pilot (17/17),
GA validation (31/31), deploy-validate, and self-audit sign-off remain green.
