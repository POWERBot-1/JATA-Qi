# Production Launch Report — Phase 7 (Live Infrastructure Activation)

**Version:** JATA Qi v1.0.0 · **Commit:** 867477c (Phase 7) + hardening round 2
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
| A2 | **Full deploy.sh rehearsal, both execution modes** (build → install → npm ci → env → probes → start → /readyz gate) | ✅ | **systemd mode**: real unit installed + `systemctl enable --now` → `/readyz 200` · service active after script exit · `/health healthy` (68 modules) · `Deploy complete: v1.0.0 @ 867477c`. **background mode**: detached `setsid` process, `/readyz 200`, alive after script exit |
| A3 | Persistent storage survives process restart | ✅ | Phase-6 harness 2.5 (auth write → restart → re-login) |
| A4 | Health/livez/readyz | ✅ | Phase-6 harness 2.1–2.3 |
| A5 | Security controls in production mode | ✅ | DLP redact, audit trail, defense posture, SOC surface, tenant isolation, no secrets in responses/logs (Phase-6 3.1–3.6) |
| A6 | Payment webhook signature verification | ✅ | Valid HMAC → 200 + invoice PAID; tampered → 400 (Phase-6 4.1–4.4) |
| A7 | Observability / operations | ✅ | On-call + escalation, backup verification, ops health, commerce analytics (Phase-6 5.1–5.4) |
| A8 | First-customer lifecycle + first commercial transaction | ✅ | signup→tenant→org→admin→subscription→billing→payment→provisioning→usage; invoice PAID via verified webhook; audit trail (Phase-6 6.1–6.6) |
| A9 | All acceptance gates re-run | ✅ | Phase 6: 29/29 · Phase 5: 33/33 · Pilot: 17/17 · GA: 31/31 · deploy-validate ✓ · self-audit **sign-off granted** (556 files, 0 blocking) |
| A10 | Full regression suite | ✅ | **2,143 tests · 120 suites · 0 failures** |
| A11 | Git state | ✅ | Clean working tree; `867477c` + hardening round 2 pushed to `origin/arena/019fccab-jata-qi`; tag v1.0.0 on origin |

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

All five are regression-protected in the deployment-artifacts suite.

### Defects discovered in hardening round 2 & remediated (this report)

Round 2 executed the deploy flow **for the first time under real systemd**
(`sudo` rehearsal on a systemd host) and found defects that static review
cannot see. Each is fixed, and the fixes are regression-protected in the
deployment-artifacts suite (85 checks) + `scripts/deploy-rehearsal.sh`.

| # | Defect (found by) | Root cause | Remediation |
|---|-------------------|-----------|-------------|
| 6 | **systemd start failed `226/NAMESPACE`** (live systemd rehearsal) | The hardened unit pins `ReadWritePaths=/var/lib/jataqi/{storage,backups}`; those host dirs must exist before systemd sets up the mount namespace. Only `provision.sh` created them — `deploy.sh` standalone crashed at start | `deploy.sh` systemd branch now creates + chowns `/var/lib/jataqi/{storage,backups}` idempotently (mirrors provision.sh) |
| 7 | **node crashed `SIGTRAP` under the unit** (live systemd rehearsal) | `MemoryDenyWriteExecute=true` is incompatible with Node 22: V8 commits its code range RWX (fatal in `SetPermissionsOnExecutableMemoryChunk`); `--jitless` also breaks undici's llhttp WASM parser. The unit had never actually been executed — the flag would crash on any platform | Flag removed **with documented rationale** in the unit; compensated by `SystemCallFilter=@system-service` + `SystemCallErrorNumber=EPERM` seccomp allowlist, zero capabilities, `NoNewPrivileges`, read-only root FS — hardening is preserved, not weakened |
| 8 | **install step fragile** (code review of round-1 fix) | Round-1 rsync used multiple sources + a global `--delete` (risk: deleting `production.env` from `$APP_DIR`); the cp fallback used brace expansion and failed wholesale if any one item was missing | Per-item install loop (no brace expansion, missing items skipped); `--delete` scoped to the `packages/` tree only; per-item cp fallback with skip-missing |
| 9 | **systemd detection not container-safe enough** (review) | Round-1 check (dir + PID-1) would attempt systemd as non-root or where `systemctl`/unit dir are unavailable → hard failure | Systemd mode requires **root + PID-1 systemd + `systemctl` present + writable `/etc/systemd/system`**; otherwise automatic background fallback; unit templated to `APP_DIR`/`APP_USER` when customized |
| 10 | **background start not quote-safe / no nohup fallback** (review) | Env vars were flattened with `grep | xargs` (breaks values with spaces/quotes); `setsid` assumed present | `production.env` sourced **inside the child** (`set -a; . "$1"; exec node …`); `nohup` fallback when `setsid` is absent; `runuser` privilege drop when root; log-dir writability fallback retained |
| 11 | **placeholder secrets could reach production** (review) | No guard against an operator copying `production.env.example` and forgetting a value | `deploy.sh` refuses to start while `production.env` contains `CHANGE_ME`; `APP_DIR` writability failure now reports a clear operator message (previously a raw `mkdir` error) |

**Verification matrix (round 2, all executed in this environment):**

| Check | Result |
|-------|--------|
| Systemd-mode rehearsal (clean build → install → env → probes → start → /readyz) | ✅ `/readyz 200`, service active after script exit, `/health` healthy (68 modules), `Deploy complete: v1.0.0 @ 867477c` |
| Background-mode rehearsal (non-root) | ✅ `/readyz 200`, server alive after script exit |
| Cross-session survival (background) | ✅ new shell session → `/readyz` 200; process reparented to PID 1, own session (SID) |
| Negative gate: `CHANGE_ME` env | ✅ refused with clear error |
| Negative gate: unreachable `POSTGRES_URL` | ✅ `UNREACHABLE (ECONNREFUSED)` → deploy aborted |
| Negative gate: missing `production.env` | ✅ refused with copy instructions |
| Negative gate: unwritable `APP_DIR` | ✅ refused with operator message |
| Docker/Compose path | ✅ `docker-compose.prod.yml` + root `docker-compose.yml` parse clean (js-yaml); 5 services, pinned image, healthchecks, volumes unchanged; zero diffs to compose/nginx/provision files |
| Repeatable harness | ✅ `scripts/deploy-rehearsal.sh [auto|background|systemd]` — same flow as above, auto-cleans service/server/APP_DIR even on failure |
| Deployment-artifacts suite | ✅ **85/85 checks** (was 76) |
| Full regression suite | ✅ **2,143 tests · 120 suites · 0 failures** |
| Acceptance harnesses re-run | ✅ Phase 6: 29/29 · Phase 5: 33/33 · Pilot: 17/17 · GA: 31/31 · deploy-validate ✓ · self-audit sign-off granted |

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
