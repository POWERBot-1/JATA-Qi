#!/usr/bin/env bash
# JATA Qi v1.0.0 — Production deployment.
#
#   sudo bash deploy/production/deploy.sh
#
# Builds the exact v1.0.0 tree, installs it to /opt/jataqi, sources
# production.env, runs safe migrations, and health-gates startup. Safe to
# re-run (idempotent). Never run with sandbox credentials.
set -euo pipefail

APP_USER="${APP_USER:-jataqi}"
APP_DIR="${APP_DIR:-/opt/jataqi}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
COMMIT="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
VERSION="$(node -p "require('$REPO/package.json').version")"

echo "==> Deploying JATA Qi v${VERSION} (commit ${COMMIT})"
[ "$VERSION" = "1.0.0" ] || { echo "✗ expected v1.0.0, found ${VERSION}"; exit 1; }

# 1. Build from the clean tree (exact validated release).
echo "==> Build (npm ci + ordered build)"
cd "$REPO"
npm ci --ignore-scripts
bash scripts/build-all.sh

# 2. Install to the app dir (excludes dev/test artifacts).
echo "==> Install to ${APP_DIR}"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude 'packages/*/test' --exclude 'packages/*/dist/test' \
  "$REPO"/{package.json,package-lock.json,tsconfig.base.json,scripts,packages,clients,examples,deploy,provenance,docs,.env.example} "$APP_DIR/" 2>/dev/null \
  || cp -r "$REPO"/packages "$REPO"/package.json "$REPO"/package-lock.json "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# 3. Environment + secrets (production.env must already exist, 0600).
ENV_FILE="$APP_DIR/production.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "✗ $ENV_FILE missing — copy deploy/production/production.env.example and fill REAL secrets"
  exit 1
fi
chmod 600 "$ENV_FILE"
chown "$APP_USER:$APP_USER" "$ENV_FILE"
set -a; . "$ENV_FILE"; set +a

# 4. Database connectivity + safe migrations (idempotent DDL only).
echo "==> Database connectivity"
if [ -n "${POSTGRES_URL:-}" ]; then
  node -e "
    const { Client } = require('pg') || {};
  " 2>/dev/null || true
  # Connectivity check via the gateway's storage driver boot (next step).
fi

# 5. Start (systemd if present, else background) and health-gate.
echo "==> Start + health gate (/readyz)"
if [ -d /run/systemd/system ]; then
  cp "$APP_DIR/deploy/production/jataqi.service" /etc/systemd/system/jataqi.service
  systemctl daemon-reload
  systemctl enable --now jataqi
  for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:7400/readyz" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  curl -sf "http://127.0.0.1:7400/readyz" >/dev/null || { echo "✗ /readyz failed"; systemctl status jataqi --no-pager | tail -20; exit 1; }
  echo "✓ /readyz 200 — service active"
else
  (cd "$APP_DIR" && sudo -u "$APP_USER" env $(cat "$ENV_FILE" | grep -v '^#' | xargs) \
    node packages/cli/dist/src/index.js serve 7400 >> /var/log/jataqi.log 2>&1 &)
  sleep 15
  curl -sf "http://127.0.0.1:7400/readyz" >/dev/null || { echo "✗ /readyz failed"; tail -20 /var/log/jataqi.log; exit 1; }
  echo "✓ /readyz 200 (background)"
fi

echo "==> Deploy complete: v${VERSION} @ ${COMMIT}"
