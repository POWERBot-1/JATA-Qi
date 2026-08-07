# Production Launch Report — Phase 7 (Live Infrastructure Activation)

**Version:** JATA Qi v1.0.0 · **Commit:** 6e57b09 (+ Phase-7 hardening commit)
**Date:** 2026-08-07

> **Honest status per the Phase 7 mandate's strict-separation rule:** everything
> executable from this environment has been executed and verified. The four
> items requiring real external infrastructure (VPS, DNS + CA TLS, production
> payment keys, PostgreSQL/Redis daemons) are **operator-executed steps with
> exact runbooks** — this sandbox has no cloud/DNS/payment credentials
> (verified: no aws/gcloud/az/doctl CLIs, no SSH targets, no provider keys in
> env). The platform is **NOT declared LIVE** until those execute.

---

## A. LOCALLY EXECUTED & VERIFIED ✅

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| A1 | Production kit scripts syntax + structure | ✅ | `bash -n` on provision.sh / deploy.sh / backup.sh / deploy-validate.sh; compose structure (5 services, health gates, volumes); nginx (3 server blocks, 301 redirect, HSTS, /ws upgrade) |
| A2 | **Full deploy.sh rehearsal** (build → install → npm ci → env → start → /readyz gate) | ✅ | `/readyz 200` · `/health healthy` (68 modules) · `Deploy complete: v1.0.0 @ 6e57b09` |
| A3 | Persistent storage survives process restart | ✅ | Phase-6 harness 2.5 (auth write → restart → re-login) |
| A4 | Health/livez/readyz | ✅ | Phase-6 harness 2.1–2.3 |
| A5 | Security controls in production mode | ✅ | DLP redact, audit trail, defense posture, SOC surface, tenant isolation, no secrets in responses/logs (Phase-6 3.1–3.6) |
| A6 | Payment webhook signature verification | ✅ | Valid HMAC → 200 + invoice PAID; tampered → 400 (Phase-6 4.1–4.4) |
| A7 | Observability / operations | ✅ | On-call + escalation, backup verification, ops health, commerce analytics (Phase-6 5.1–5.4) |
| A8 | First-customer lifecycle + first commercial transaction | ✅ | signup→tenant→org→admin→subscription→billing→payment→provisioning→usage; invoice PAID via verified webhook; audit trail (Phase-6 6.1–6.6) |
| A9 | All acceptance gates re-run | ✅ | Phase 6: 29/29 · Phase 5: 33/33 · Pilot: 17/17 · GA: 31/31 · deploy-validate ✓ · self-audit **sign-off granted** |
| A10 | Full regression suite | ✅ | **2,134 tests · 120 suites · 0 failures** |
| A11 | Git state | ✅ | Clean working tree; commit pushed to `origin/arena/019fccab-jata-qi`; tag v1.0.0 on origin |

### Defects discovered in the rehearsal & remediated (Phase 7)

1. **deploy.sh: bare-metal path never installed production deps** → added
   `npm ci --omit=dev --ignore-scripts` in the app dir (Docker path unaffected).
2. **deploy.sh: broken rsync source list** (brace-expansion quoting made rsync
   always fail; the cp fallback omitted `deploy/`) → individual source args +
   complete fallback incl. `deploy/`.
3. **deploy.sh: unreliable systemd detection** (`/run/systemd/system` exists in
   containers where systemd is not PID 1) → PID-1 check + `FORCE_BACKGROUND=1`
   escape for systemd-less environments.
4. **deploy.sh: non-writable log path killed the fallback start** → writability
   fallback to `$APP_DIR/jataqi.log`; detached start via `setsid` + `disown`
   (process survives script exit).
5. Added operator escapes `SKIP_BUILD=1` (fast re-deploys).

All five are regression-protected in the deployment-artifacts suite (76 checks).

## B. EXTERNAL — OPERATOR-EXECUTED (this environment cannot execute) ⏳

| # | Requirement | Exact operator steps (deploy/production/README.md) | Evidence to capture |
|---|-------------|---------------------------------------------------|---------------------|
| B1 | Provision production VPS | `sudo bash deploy/production/provision.sh api.example.com ops@example.com` (UFW, fail2ban, Node 22, Docker, service user, persistent dirs) | provision output |
| B2 | DNS A records | `api.example.com` + `example.com` (+ optional `app.example.com`) → server public IP | `dig` output |
| B3 | CA-issued TLS (Certbot) | `docker compose -f deploy/production/docker-compose.prod.yml run --rm certbot certonly --webroot -w /var/www/certbot -d api.example.com -d example.com --email ops@example.com --agree-tos` | `curl -I https://api.example.com/health` (200 + HSTS) · `curl -I http://…` (301) |
| B4 | Production secrets + payment keys | copy `production.env.example` → `/opt/jataqi/production.env` (chmod 600) — real DB/Redis/admin/Stripe **live** keys, strictly separated from sandbox | `chmod 600` + `grep -c CHANGE_ME` = 0 |
| B5 | PostgreSQL 16 + Redis 7 stack | `docker compose -f deploy/production/docker-compose.prod.yml up -d` (health-gated) | `docker compose ps` healthy |
| B6 | Deploy + verify endpoints | `sudo bash deploy/production/deploy.sh` then `curl /health /livez /readyz` | 200s |
| B7 | Phase 6 suite vs live infra | `node examples/phase6-validation.mjs` with POSTGRES_URL/REDIS_URL set | 29/29 |
| B8 | HTTPS/redirect/HSTS/WS/tenant/billing/webhook/provisioning/metering/audit/backups/observability | per B6+B7 + deploy/production/backup.sh cron | check outputs |
| B9 | One genuine production commercial transaction | real Stripe/M-Pesa key + real webhook event | invoice PAID + audit trail |
| B10 | First external customer access | customer onboarding runbook (Phase 5 docs) | customer account + usage |

## C. Operator handoff checklist (sign-off boxes)

- [ ] VPS provisioned + hardened (B1)
- [ ] DNS resolves (B2) — `dig api.example.com`
- [ ] HTTPS valid + enforced (B3) — cert expiry + 301 + HSTS
- [ ] production.env real, 0600, zero CHANGE_ME (B4)
- [ ] PostgreSQL + Redis healthy (B5)
- [ ] deploy.sh → /readyz 200 (B6)
- [ ] Phase 6 suite 29/29 against live infra (B7)
- [ ] First production transaction recorded (B9)
- [ ] First external customer onboarded (B10)
- [ ] All gates re-run post-launch (A9)

---

**Decision rule (from the Phase 7 mandate):** LIVE is declared only when every
row in section B is executed and verified. Until then, the platform is
**deployment-ready and locally validated**, awaiting operator infrastructure
activation.
