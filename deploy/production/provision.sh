# JATA Qi v1.0.0 — Production Server Provisioning
#
# Run as root on a fresh Ubuntu 22.04/24.04 VPS. Hardens the OS, installs the
# runtime + container tooling, creates the non-root service user, and prepares
# persistent storage. No secrets are created here — they come from
# production.env (see production.env.example).
#
#   sudo bash deploy/production/provision.sh <app_domain> <admin_email>
#
set -euo pipefail

APP_DOMAIN="${1:?usage: provision.sh <app_domain> <admin_email>}"
ADMIN_EMAIL="${2:?usage: provision.sh <app_domain> <admin_email>}"
APP_USER="jataqi"
APP_DIR="/opt/jataqi"
DATA_DIR="/var/lib/jataqi"

echo "==> [1/8] Base packages + security updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl gnupg ca-certificates ufw fail2ban unattended-upgrades nginx htop jq

echo "==> [2/8] Node.js 22 (LTS) — the validated JATA Qi runtime"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node --version

echo "==> [3/8] Docker + compose plugin (optional but recommended)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

echo "==> [4/8] Service user + persistent storage"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR/storage" "$DATA_DIR/postgres" "$DATA_DIR/redis" "$DATA_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

echo "==> [5/8] Firewall (UFW)"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'ssh'
ufw allow 80/tcp comment 'http'
ufw allow 443/tcp comment 'https'
ufw --force enable

echo "==> [6/8] fail2ban (ssh brute-force)"
cat > /etc/fail2ban/jail.local << 'EOF'
[sshd]
enabled = true
maxretry = 5
bantime = 3600
EOF
systemctl enable --now fail2ban

echo "==> [7/8] Unattended security upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo "==> [8/8] Swap + sysctl hardening (production defaults)"
[ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile; }
cat >> /etc/sysctl.d/99-jataqi.conf << 'EOF'
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
kernel.randomize_va_space = 2
EOF
sysctl -p /etc/sysctl.d/99-jataqi.conf || true

echo "==> Done. Next steps:"
echo "  1. Point DNS A record  ${APP_DOMAIN}  → this server's public IP"
echo "  2. Add A records for api.${APP_DOMAIN} and app.${APP_DOMAIN} (or CNAMEs)"
echo "  3. cp deploy/production/production.env.example /opt/jataqi/production.env  (fill secrets)"
echo "  4. Run certbot for TLS:  sudo certbot --nginx -d ${APP_DOMAIN} -d api.${APP_DOMAIN} -m ${ADMIN_EMAIL} --agree-tos --redirect"
echo "  5. Deploy:  bash deploy/production/deploy.sh ${APP_DOMAIN}"
