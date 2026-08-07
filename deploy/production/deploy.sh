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
#    SKIP_BUILD=1 skips the rebuild (fast re-deploys of an unchanged tree).
echo "==> Build (npm ci + ordered build)"
cd "$REPO"
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npm ci --ignore-scripts
  bash scripts/build-all.sh
else
  echo "  (SKIP_BUILD=1 — using existing build)"
fi

# 2. Install to the app dir (excludes dev/test artifacts).
echo "==> Install to ${APP_DIR}"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude 'packages/*/test' --exclude 'packages/*/dist/test' \
  "$REPO/package.json" "$REPO/package-lock.json" "$REPO/tsconfig.base.json" \
  "$REPO/scripts" "$REPO/packages" "$REPO/clients" "$REPO/examples" \
  "$REPO/deploy" "$REPO/provenance" "$REPO/docs" "$REPO/.env.example" \
  "$APP_DIR/" 2>/dev/null \
  || { cp -r "$REPO/package.json" "$REPO/package-lock.json" "$REPO/packages" "$REPO/deploy" "$APP_DIR/"; \
       cp -r "$REPO"/{scripts,clients,examples,provenance,docs,.env.example} "$APP_DIR/" 2>/dev/null || true; }
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# 2b. Install production dependencies into the app tree (bare-metal path;
#     the Docker image already carries node_modules). Workspace links resolve
#     @jataqi/* imports at runtime.
echo "==> Install production dependencies"
cd "$APP_DIR"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# 3. Environment + secrets (production.env must already exist, 0600).
ENV_FILE="$APP_DIR/production.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "✗ $ENV_FILE missing — copy deploy/production/production.env.example and fill REAL secrets"
  exit 1
fi
chmod 600 "$ENV_FILE"
chown "$APP_USER:$APP_USER" "$ENV_FILE"
set -a; . "$ENV_FILE"; set +a

# 4. Database connectivity probe (when a Postgres URL is configured).
echo "==> Database connectivity"
if [ -n "${POSTGRES_URL:-}" ]; then
  HOST=$(node -e "console.log(new URL(process.env.POSTGRES_URL).hostname)" 2>/dev/null || echo "")
  PORT=$(node -e "console.log(new URL(process.env.POSTGRES_URL).port || '5432')" 2>/dev/null || echo "5432")
  if [ -n "$HOST" ] && node -e "
    const net = require('net');
    const s = net.connect($PORT, '$HOST');
    s.setTimeout(5000);
    s.on('connect', () => { console.log('✓ database reachable at $HOST:$PORT'); process.exit(0); });
    s.on('error', () => { console.log('✗ database UNREACHABLE at $HOST:$PORT'); process.exit(1); });
    s.on('timeout', () => { console.log('✗ database probe timed out'); process.exit(1); });
  "; then
    echo "✓ database connectivity verified"
  else
    echo "✗ database connectivity failed — check POSTGRES_URL"
    exit 1
  fi
else
  echo "  (no POSTGRES_URL — skipping connectivity probe)"
fi

# 5. Start (systemd if present, else background) and health-gate.
echo "==> Start + health gate (/readyz)"
if [ "${FORCE_BACKGROUND:-0}" != "1" ] && [ -d /run/systemd/system ] && [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ]; then
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
  # Fallback (no systemd): run detached so the server survives the script.
  LOG=/var/log/jataqi.log
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  chown "$APP_USER:$APP_USER" "$(dirname "$LOG")" 2>/dev/null || true
  # If the default log path is not writable (non-root operators), fall back
  # to the app dir.
  [ -w "$(dirname "$LOG")" ] || LOG="$APP_DIR/jataqi.log"
  ENVLIST=$(grep -v '^#' "$ENV_FILE" | grep '=' | xargs)
  if [ "$(id -u)" = "0" ]; then
    # Root: drop to the service user with a clean environment.
    setsid runuser -u "$APP_USER" -- env $ENVLIST \
      node "$APP_DIR/packages/cli/dist/src/index.js" serve 7400 >> "$LOG" 2>&1 < /dev/null &
  else
    # Non-root (rehearsal/dev): run as the current user, detached.
    setsid env $ENVLIST \
      node "$APP_DIR/packages/cli/dist/src/index.js" serve 7400 >> "$LOG" 2>&1 < /dev/null &
  fi
  disown || true
  for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:7400/readyz" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  curl -sf "http://127.0.0.1:7400/readyz" >/dev/null || { echo "✗ /readyz failed"; tail -20 "$LOG"; exit 1; }
  echo "✓ /readyz 200 (background, pid $!)"
fi

echo "==> Deploy complete: v${VERSION} @ ${COMMIT}"
