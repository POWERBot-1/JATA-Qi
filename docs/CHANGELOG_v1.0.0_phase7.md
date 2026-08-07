# Change Log — v1.0.0 → Phase 7

Phase 7 activates the live infrastructure path and completes the commercial
payment rails. Backward compatible; the Phase-5/6 architecture is preserved.

## Live activation rehearsal (deploy.sh hardening, rounds 1 + 2)

- `deploy.sh` executed end-to-end for the first time under **real systemd**
  (root rehearsal on a systemd host). Two launch-blocking defects found and
  fixed:
  1. Unit failed with `226/NAMESPACE` — the hardened unit's
     `ReadWritePaths=/var/lib/jataqi/{storage,backups}` require those host
     dirs to exist before the mount namespace is set up; `deploy.sh` now
     creates + chowns them idempotently (standalone-safe, not just
     provision.sh-safe).
  2. Node crashed `SIGTRAP` under `MemoryDenyWriteExecute=true` (V8 commits
     its code range RWX; `--jitless` additionally breaks undici's llhttp
     WASM parser). The flag was removed **with documented rationale** and
     compensated by `SystemCallFilter=@system-service` seccomp allowlist,
     zero capabilities, `NoNewPrivileges`, and the read-only root FS —
     hardening is preserved, not weakened.
- Install step hardened: per-item install loop (no brace expansion, missing
  items skipped), `--delete` scoped to the `packages/` tree only
  (`production.env` can never be deleted), per-item `cp` fallback, friendly
  `APP_DIR` errors.
- Systemd detection container-safe: systemd mode requires root + PID-1
  systemd + `systemctl` + writable `/etc/systemd/system`; otherwise the
  background mode is used automatically. Unit templated to custom
  `APP_DIR`/`APP_USER`.
- Background mode: `production.env` sourced **inside the child**
  (quote-safe env values), `setsid` with `nohup` fallback, `runuser`
  privilege drop when root — the process survives script/session exit
  (verified across separate shell sessions).
- Safety gates: `CHANGE_ME` placeholders refused, Postgres/Redis TCP
  connectivity probed before start (`POSTGRES_URL`/`REDIS_URL`), missing
  `production.env` refused, `package-lock.json` guard before `npm ci`.
- Escapes: `SKIP_BUILD=1`, `FORCE_BACKGROUND=1`, `APP_DIR=…`, `APP_USER=…`.
- New `scripts/deploy-rehearsal.sh [auto|background|systemd]` — repeatable
  end-to-end rehearsal of both execution modes with automatic cleanup;
  wired into GitHub Actions CI.

## M-Pesa (Safaricom Daraja) payment rail (new gateway capability)

- `PaymentsModule` extended: `mpesa` provider config slot, registration,
  and a **pending-intent registry** (CheckoutRequestID → customer
  attribution, single-use) so callbacks are attributed without trusting any
  callback body field.
- `POST /payments/mpesa/stk-push` (auth: `payments:write`) — initiates an
  STK Push prompt (OAuth bearer, minor-unit conversion, amount/phone/
  reference), records the intent attribution, returns the intent.
- `POST /payments/webhook/mpesa` (public — authenticity via attribution +
  optional operator HMAC): when `MPESA_WEBHOOK_SECRET` is set, callbacks
  must carry `x-mpesa-signature` (sha256 over the exact raw body);
  tampered/missing signatures → 400. `payment_intent.succeeded` applies the
  same commercial side effects as Stripe (shared `applyPaymentSucceeded`:
  invoices → PAID, suspended/past-due subscription → reactivated).
  Callback metadata (MpesaReceiptNumber, PhoneNumber, TransactionDate) is
  flattened onto the webhook event for invoicing/audit.
- Bootstrap gates on `MPESA_CONSUMER_KEY` + `MPESA_CONSUMER_SECRET` +
  `MPESA_SHORTCODE` + `MPESA_PASSKEY` (production rail stays off otherwise);
  `MPESA_ENVIRONMENT`, `MPESA_CALLBACK_URL`, `MPESA_API_BASE`,
  `MPESA_WEBHOOK_SECRET` supported.
- Role policy: `payments:read` (analyst + developer), `payments:write`
  (developer).
- Verified end-to-end: STK Push → signed callback → invoice PAID; tampered
  HMAC 400; missing header 400; failed callback acked as `payment_failed`;
  unregistered intents acked but not attributed; no secrets in responses or
  logs (19/19 checks — `examples/mpesa-validation.mjs`).

## Operator surface for payments (new)

- `GET /payments/providers` (auth `payments:read`) — operator view of the
  payment rail: Stripe/M-Pesa configured flags, M-Pesa environment
  (sandbox/production/custom), configured callback URL.
- CLI: `jataqi payments status|stk-push|invoice|invoice-pay|billing-state` —
  in-process provider status, M-Pesa STK Push initiation (with
  pending-intent registration), invoice create/pay, and billing-state
  inspection.
- Web UI Commerce view: payment provider status panel, M-Pesa STK Push form
  (customerId/amount/phone/reference) with live result, and a billing-state
  inspector.
- Python SDK: `commerce_plans/analytics/subscribe/invoice/invoice_pay/
  invoices/billing_state` + `payments_providers/mpesa_stk_push` (+ 4 client
  tests against a live gateway; suite 20/20).
- `docker-compose.prod.yml`: the app service now receives the full M-Pesa
  env block (consumer key/secret, shortcode, passkey, environment, callback
  URL, webhook secret) — the container path is M-Pesa-capable like the
  bare-metal path.

## backup.sh hardening (rehearsal fixes)

- **Fixed: pg_dump-absent crash.** `sha256sum` ran unconditionally on a dump
  that does not exist when `pg_dump` is missing → `set -e` aborted the whole
  backup job (exit 1, zero artifacts). Hash + verification are now guarded on
  dump existence; the absent path completes with WARNs.
- **Fixed: no backup token existed anywhere.** `/var/lib/jataqi/.backup-token`
  was never created by any kit script, so the snapshot + verification steps
  could never run on a real VPS. `backup.sh` now bootstraps the token
  automatically from `JATAQI_ADMIN_USERNAME`/`JATAQI_ADMIN_PASSWORD` via
  `POST /auth/login` (validates cached tokens first, re-auths on staleness,
  caches 0600).
- **Fixed: non-root crash.** `chown` now runs only when root.
- New `scripts/backup-rehearsal.sh` — boots a real gateway and runs the real
  backup script end-to-end (absent path, token bootstrap, snapshot JSON,
  dump + `verification: PASSED`, retention): **10/10**.
- Deployment-artifacts suite: 96 → **100 checks**.

## Live launch gate check (new: scripts/live-launch-check.sh)

- Operator-executed ON THE VPS: probes every external gate from the Phase-7
  mandate (B1 VPS hardening, B2 DNS, B3 HTTPS/HSTS/301 + cert expiry, B4
  production.env 0600 + zero CHANGE_ME, B5 PostgreSQL/Redis TCP, B6
  /readyz + /livez + /health, B7 payment providers incl. MPESA_CALLBACK_URL,
  B8 backup cron) plus the B9/B10 data gates via `live-launch.conf`.
- Prints per-gate PASS/FAIL/WARN and exits 0 only when all required gates
  pass; the exact declaration string "JATA Qi v1.0.0 — LIVE PRODUCTION /
  COMMERCIAL LAUNCH" is printed only then. It never asserts a gate on its
  own — it probes the live endpoint/state directly.

## CI (new: .github/workflows/ci.yml)

- Every push: clean install → ordered build → full regression suite →
  `deploy-validate.sh` → acceptance harnesses (GA, pilot, phase-5,
  M-Pesa) → deploy.sh rehearsals in **both** modes (background as user,
  systemd as root).

## Validation

- Full regression suite: **2,168 tests · 120 suites · 0 failures**
  (deployment-artifacts suite: 90 checks).
- Acceptance harnesses: Phase 6 29/29 · Phase 5 33/33 · Pilot 17/17 ·
  GA 31/31 · M-Pesa 20/20 · Python SDK 20/20 · deploy-validate ✓ ·
  self-audit sign-off granted.
- Deployment rehearsals: systemd mode ✓ (unit active, `/readyz` 200,
  `/health` healthy, 68 modules) · background mode ✓ (detached process
  survives script exit) · cross-session survival ✓ (PPID 1, own SID) ·
  negative gates ✓ (CHANGE_ME / unreachable DB / missing env / unwritable
  APP_DIR).

## Still operator-executed (not claimed by this environment)

VPS provisioning, DNS + CA TLS, production payment keys, PostgreSQL 16 +
Redis 7 daemons, first real commercial transaction, first external customer
— runbooks in `deploy/production/README.md` + `docs/PRODUCTION_LAUNCH_REPORT.md`.
The platform is **NOT declared LIVE** until those gates execute.
