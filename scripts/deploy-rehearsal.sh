#!/usr/bin/env bash
# JATA Qi v1.0.0 — deploy.sh end-to-end rehearsal (repeatable production-flow
# dry run). Runs the REAL deploy/production/deploy.sh against an isolated
# APP_DIR with filesystem storage, asserts the chosen execution mode, the
# /readyz health gate, and — critically — that the server SURVIVES the deploy
# script's exit. Cleans up afterwards.
#
#   bash scripts/deploy-rehearsal.sh                 # auto mode (deploy.sh's own pick)
#   bash scripts/deploy-rehearsal.sh background      # force non-systemd fallback
#   sudo bash scripts/deploy-rehearsal.sh systemd    # force real systemd unit
#   SKIP_BUILD=1 bash scripts/deploy-rehearsal.sh    # reuse existing build
#
# Requirements: port 7400 free; root for the systemd mode; node + npm in PATH.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-auto}"
SKIP="${SKIP_BUILD:-0}"

case "$MODE" in
  auto|background|systemd) ;;
  *) echo "✗ usage: deploy-rehearsal.sh [auto|background|systemd]"; exit 2 ;;
esac

# Safety net: a failed rehearsal must never leave the systemd unit installed
# (Restart=always would loop forever) or a background server running.
cleanup() {
  local rc=$?
  if [ -f /etc/systemd/system/jataqi.service ]; then
    systemctl stop jataqi 2>/dev/null || true
    systemctl disable jataqi 2>/dev/null || true
    rm -f /etc/systemd/system/jataqi.service
    systemctl daemon-reload 2>/dev/null || true
  fi
  if [ -n "${APP_DIR:-}" ]; then
    pkill -f "$APP_DIR/packages/cli/dist/src/index.js" 2>/dev/null || true
    rm -rf "$APP_DIR" 2>/dev/null || true
  fi
  exit $rc
}
trap cleanup EXIT

echo "== Rehearsal: deploy.sh mode=${MODE} (SKIP_BUILD=${SKIP})"

# Port 7400 must be free before we start.
if curl -sf http://127.0.0.1:7400/readyz >/dev/null 2>&1; then
  echo "✗ port 7400 already serving — stop the existing instance first"
  exit 1
fi

if [ "$SKIP" != "1" ]; then
  echo "== [1/6] Full build from clean tree (npm ci + ordered build)"
  (cd "$REPO" && npm ci --ignore-scripts && bash scripts/build-all.sh)
else
  echo "== [1/6] SKIP_BUILD=1 — reusing existing build"
fi

# Isolated APP_DIR. Root runs must avoid /tmp (the hardened unit sets
# PrivateTmp=true, so the app dir must live outside /tmp).
if [ "$(id -u)" = "0" ]; then
  APP_DIR="/opt/jataqi-rehearsal-$$"
  APP_USER="${APP_USER:-jataqi}"
  id -u "$APP_USER" >/dev/null 2>&1 \
    || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
  rm -rf "$APP_DIR"; mkdir -p "$APP_DIR"
else
  APP_DIR="$(mktemp -d /tmp/jataqi-rehearsal-XXXXXX)"
  APP_USER="${APP_USER:-$(id -un)}"
fi

echo "== [2/6] Write rehearsal production.env (filesystem storage, no CHANGE_ME)"
cat > "$APP_DIR/production.env" <<EOF
NODE_ENV=production
LOG_LEVEL=warn
JATAQI_GATEWAY_HOST=127.0.0.1
JATAQI_GATEWAY_PORT=7400
JATAQI_ADMIN_USERNAME=rehearsal
JATAQI_ADMIN_PASSWORD=rehearsal-strong-pass-2026!
STORAGE_DRIVER=filesystem
STORAGE_FS_ROOT=$APP_DIR/storage
EOF
chmod 600 "$APP_DIR/production.env"

echo "== [3/6] Run deploy.sh (this is the real production script)"
DEPLOY_LOG=$(mktemp /tmp/jataqi-rehearsal-deploy-XXXX.log)
FORCE_BACKGROUND=0
[ "$MODE" = "background" ] && FORCE_BACKGROUND=1
set +e
APP_DIR="$APP_DIR" APP_USER="$APP_USER" SKIP_BUILD="$SKIP" FORCE_BACKGROUND="$FORCE_BACKGROUND" \
  bash "$REPO/deploy/production/deploy.sh" 2>&1 | tee "$DEPLOY_LOG"
RC=${PIPESTATUS[0]}
set -e
if [ "$RC" != "0" ]; then
  echo "✗ deploy.sh exited ${RC} — log: $DEPLOY_LOG"
  exit 1
fi

echo "== [4/6] Assert mode selection"
EXPECTED="background"
if [ "$MODE" = "systemd" ] && [ "$(id -u)" = "0" ]; then EXPECTED="systemd"; fi
if [ "$MODE" = "auto" ] && [ "$(id -u)" = "0" ] && [ -d /run/systemd/system ]; then EXPECTED="systemd"; fi
GOT=$(grep -o '(mode: [a-z]*)' "$DEPLOY_LOG" | tail -1 | sed 's/(mode: //; s/)//')
[ -n "$GOT" ] || { echo "✗ deploy.sh printed no mode line"; exit 1; }
[ "$GOT" = "$EXPECTED" ] || { echo "✗ expected mode ${EXPECTED}, got ${GOT}"; exit 1; }
echo "✓ mode: ${GOT} (expected ${EXPECTED})"
grep -q '/readyz 200' "$DEPLOY_LOG" || { echo "✗ /readyz 200 not confirmed in deploy output"; exit 1; }
grep -q 'Deploy complete: v1.0.0' "$DEPLOY_LOG" || { echo "✗ deploy completion line missing"; exit 1; }
echo "✓ /readyz 200 + 'Deploy complete: v1.0.0' in output"

echo "== [5/6] Survival + health after deploy.sh has exited"
sleep 2
if [ "$GOT" = "systemd" ]; then
  systemctl is-active --quiet jataqi || {
    echo "✗ service jataqi not active:"
    systemctl status jataqi --no-pager | tail -25 || true
    journalctl -u jataqi --no-pager -n 40 2>/dev/null | tail -40 || true
    exit 1
  }
  echo "✓ systemd: service active after deploy.sh exit"
else
  if ! curl -sf http://127.0.0.1:7400/readyz >/dev/null; then
    echo "✗ server died with the script — survival check failed"
    tail -20 "$DEPLOY_LOG" || true
    exit 1
  fi
  echo "✓ background: server alive after deploy.sh exit (survived session)"
fi
HEALTH=$(curl -sf http://127.0.0.1:7400/health || true)
[ -n "$HEALTH" ] && echo "✓ /health: ${HEALTH}" || { echo "✗ /health failed"; exit 1; }

echo "== [6/6] Cleanup (trap removes service/server + APP_DIR on exit)"

echo "✓ REHEARSAL PASSED (mode=${GOT})"
