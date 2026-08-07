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
| `deploy.sh` | Build v1.0.0 → install → env → start → /readyz health gate |

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
sudo bash deploy/production/deploy.sh
curl -I https://api.example.com/health     # 200, HSTS header
curl -I http://api.example.com/health      # 301 → https

# 6. Backups (cron).
crontab -e   # 0 2 * * * /opt/jataqi/deploy/production/backup.sh
```

## Security posture (inherited, verified in Phase 6)

- RBAC + authentication + tenant isolation + DLP + audit + security middleware
  all enabled in production mode (no weakening).
- Containers/processes run non-root with dropped capabilities, read-only root
  FS, seccomp/NoNewPrivileges (PSS-restricted on Kubernetes).
- Secrets: production.env 0600, never committed; Stripe webhook signatures
  verified server-side; sandbox and production credentials strictly separate.
- Re-run after deploy: `node examples/self-audit.mjs`,
  `node examples/phase6-validation.mjs`.
