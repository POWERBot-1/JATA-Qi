# Production Deployment Kit — JATA Qi v1.0.0

Deploy the exact validated v1.0.0 release to a production VPS with hardened
OS, PostgreSQL + Redis, TLS via Let's Encrypt, persistent storage, backups
with verification, and monitoring.

## Files

| File | Purpose |
| ---- | ------- |
| `provision.sh` | Server hardening (UFW, fail2ban, unattended-upgrades, sysctl, swap), Node 22, Docker, service user, persistent dirs |
| `docker-compose.prod.yml` | PostgreSQL 16 + Redis 7 + JATA Qi (ghcr.io/powerbot-1/jataqi:1.0.0) + nginx + certbot |
| `nginx.conf` | HTTP→HTTPS redirect, TLS 1.2/1.3, security headers, /ws upgrade, api + app subdomains |
| `jataqi.service` | Hardened systemd unit (non-root, NoNewPrivileges, ProtectSystem=strict, private /tmp, bounded caps) |
| `production.env.example` | All env vars with placeholders — fill with REAL secrets, chmod 600 |
| `backup.sh` | pg_dump + namespace snapshot + content-hash verification + retention (cron-ready) |
| `deploy.sh` | Build v1.0.0 → install → env → DB/Redis probes → start → /readyz health gate |
| `../../scripts/deploy-rehearsal.sh` | Repeatable end-to-end rehearsal of deploy.sh (both execution modes) |

## Deployment steps

```bash
# 1. Provision + harden the VPS (Ubuntu 22.04/24.04).
sudo bash deploy/production/provision.sh api.example.com ops@example.com

# 2. DNS (at your registrar): A records →
#      api.example.com   → <server IP>
#      example.com       → <server IP>     (admin console)
#      app.example.com   → <server IP>     (optional alias)

# 3. Secrets — strictly production, separate from sandbox keys.
sudo cp deploy/production/production.env.example /opt/jataqi/production.env
sudo nano /opt/jataqi/production.env          # REAL passwords/keys
sudo chmod 600 /opt/jataqi/production.env

# 4. TLS via Let's Encrypt (trusted CA, auto-renew via certbot container).
docker compose -f deploy/production/docker-compose.prod.yml run --rm certbot \
  certonly --webroot -w /var/www/certbot -d api.example.com -d example.com \
  --email ops@example.com --agree-tos --no-eff-email

# 5. Deploy the exact release + health gate.
sudo bash deploy/production/deploy.sh     # root → hardened systemd unit
curl -I https://api.example.com/health     # 200, HSTS header
curl -I http://api.example.com/health      # 301 → https

# 5b. Optional: rehearse the full deploy flow first (isolated APP_DIR,
#     filesystem storage, automatic cleanup). Same script the CI rehearsal
#     uses; run on the VPS or any Linux box with node 22.
SKIP_BUILD=1 bash scripts/deploy-rehearsal.sh            # background mode
sudo SKIP_BUILD=1 bash scripts/deploy-rehearsal.sh       # systemd mode

# 6. Backups (cron).
crontab -e   # 0 2 * * * /opt/jataqi/deploy/production/backup.sh
```

## deploy.sh execution modes

`deploy.sh` auto-selects between two start modes and prints the choice
(`(mode: systemd)` / `(mode: background)`):

| Mode | When | Behaviour |
| ---- | ---- | --------- |
| **systemd** | root + real systemd init (`/run/systemd/system`, PID 1 = systemd) + `systemctl` + writable `/etc/systemd/system` | Installs the hardened unit (paths templated to `APP_DIR`/`APP_USER`), creates `/var/lib/jataqi/{storage,backups}` (the unit's `ReadWritePaths` — required or the unit dies with `226/NAMESPACE`), `systemctl enable --now`, health-gates `/readyz` |
| **background** | everything else (non-root, containers, no systemd) | Detached `setsid` process (nohup fallback) that survives the script/session exit; `production.env` is sourced inside the child so values with spaces/quotes can never break startup; log to `/var/log/jataqi.log`, falling back to `$APP_DIR/jataqi.log` |

Operator escapes: `FORCE_BACKGROUND=1` (never touch systemd),
`SKIP_BUILD=1` (reuse the existing build), `APP_DIR=…` / `APP_USER=…`
(non-root rehearsal/lab deploys). `production.env` must already exist in
`APP_DIR` (0600, no `CHANGE_ME` placeholders — deploy.sh refuses to start
otherwise) and Postgres connectivity is probed before start when
`POSTGRES_URL` is set (`REDIS_URL` likewise). The systemd unit intentionally
does **not** set `MemoryDenyWriteExecute` — Node 22 cannot run under it (V8
RWX code range + undici llhttp WASM; verified by rehearsal); the unit
documents this and compensates with a `SystemCallFilter=@system-service`
seccomp allowlist, zero capabilities, `NoNewPrivileges`, and a read-only
root filesystem.

## Security posture (inherited, verified in Phase 6)

- RBAC + authentication + tenant isolation + DLP + audit + security middleware
  all enabled in production mode (no weakening).
- Containers/processes run non-root with dropped capabilities, read-only root
  FS, seccomp/NoNewPrivileges (PSS-restricted on Kubernetes).
- Secrets: production.env 0600, never committed; Stripe webhook signatures
  verified server-side; sandbox and production credentials strictly separate.
- Re-run after deploy: `node examples/self-audit.mjs`,
  `node examples/phase6-validation.mjs`.
