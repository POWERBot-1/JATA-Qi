#!/usr/bin/env bash
# JATA Qi v1.0.0 — Production deployment (bare-metal / VPS).
#
#   bash deploy/production/deploy.sh                          # root (recommended)
#   APP_DIR=/srv/jataqi APP_USER=jataqi bash deploy/production/deploy.sh  # non-root
#
# Builds the exact v1.0.0 tree, installs it to APP_DIR, sources production.env,
# runs safe migrations, probes DB/Redis connectivity, and health-gates startup.
# Idempotent (safe to re-run). Never run with sandbox credentials.
#
# Execution modes (auto-selected):
#   * systemd    — only when ALL hold: running as root, real systemd init,
#                  systemctl present, /etc/systemd/system writable. Installs
#                  the hardened unit (paths templated to APP_DIR) and starts
#                  the service. FORCE_BACKGROUND=1 always overrides to
#                  background mode.
#   * background — otherwise. Detached process (setsid, nohup fallback) that
#                  survives the script/session exit. Log goes to
#                  /var/log/jataqi.log (falls back to $APP_DIR/jataqi.log).
#
# Escapes: SKIP_BUILD=1 (reuse existing build), FORCE_BACKGROUND=1 (never
# touch systemd), APP_DIR=… APP_USER=… (non-root rehearsal/lab deploys).
set -euo pipefail

APP_USER="${APP_USER:-jataqi}"
APP_DIR="${APP_DIR:-/opt/jataqi}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
COMMIT="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
VERSION="$(node -p "require('$REPO/package.json').version")"
SERVER_JS="$APP_DIR/packages/cli/dist/src/index.js"

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

# 2. Install to the app dir (excludes dev/test artifacts). Each top-level item
#    is synced individually (no brace expansion, no whole-command failure when
#    an optional item is missing), and --delete is applied ONLY inside the
#    fully-managed packages/ tree — never to $APP_DIR itself, which holds
#    production.env, logs, and data.
echo "==> Install to ${APP_DIR}"
mkdir -p "$APP_DIR" 2>/dev/null || { echo "✗ cannot create $APP_DIR — run as root or set APP_DIR to a writable path"; exit 1; }
if [ ! -w "$APP_DIR" ]; then
  echo "✗ $APP_DIR is not writable — run as root or set APP_DIR to a writable path"
  exit 1
fi

INSTALL_ITEMS=(
  "package.json" "package-lock.json" "tsconfig.base.json"
  "scripts" "clients" "examples" "deploy"
  "provenance" "docs" ".env.example"
)
if command -v rsync >/dev/null 2>&1; then
  for item in "${INSTALL_ITEMS[@]}"; do
    [ -e "$REPO/$item" ] || { echo "  (skip missing: $item)"; continue; }
    rsync -a --exclude node_modules "$REPO/$item" "$APP_DIR/" \
      || { echo "✗ rsync failed for $item"; exit 1; }
  done
  # Managed tree: sync contents, prune stale package dirs — still never
  # touches anything outside packages/.
  mkdir -p "$APP_DIR/packages"
  rsync -a --delete --exclude node_modules --exclude '*/test' --exclude '*/dist/test' "$REPO/packages/" "$APP_DIR/packages/" || { echo "✗ rsync failed for packages/"; exit 1; }
  echo "  (rsync install complete)"
else
  echo "  (rsync not found — using cp fallback)"
  for item in "${INSTALL_ITEMS[@]}"; do
    [ -e "$REPO/$item" ] || { echo "  (skip missing: $item)"; continue; }
    cp -r "$REPO/$item" "$APP_DIR/" || { echo "✗ cp failed for $item"; exit 1; }
  done
  cp -r "$REPO/packages" "$APP_DIR/" || { echo "✗ cp failed for packages"; exit 1; }
  echo "  (cp fallback install complete)"
fi

# Ownership: only when root. Non-root operators keep their own ownership.
if [ "$(id -u)" = "0" ]; then
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
else
  echo "  (non-root — skipping chown; APP_DIR must be owned by the runtime user)"
fi

# 2b. Install production dependencies into the app tree (bare-metal path; the
#     Docker image already carries node_modules). Workspace links resolve
#     @jataqi/* imports at runtime. Runs for every deploy, including
#     SKIP_BUILD=1 — the runtime deps are what the server executes with.
echo "==> Install production dependencies"
[ -f "$APP_DIR/package-lock.json" ] || { echo "✗ $APP_DIR/package-lock.json missing — install incomplete"; exit 1; }
cd "$APP_DIR"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# 3. Environment + secrets (production.env must already exist, 0600, and be
#    free of CHANGE_ME placeholders).
ENV_FILE="$APP_DIR/production.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "✗ $ENV_FILE missing — copy deploy/production/production.env.example and fill REAL secrets"
  exit 1
fi
chmod 600 "$ENV_FILE"
[ "$(id -u)" = "0" ] && chown "$APP_USER:$APP_USER" "$ENV_FILE"
if grep -q 'CHANGE_ME' "$ENV_FILE"; then
  echo "✗ $ENV_FILE still contains CHANGE_ME placeholders — fill REAL secrets first"
  exit 1
fi
set -a; . "$ENV_FILE"; set +a

# 4. Connectivity probes: Postgres (required for production) and Redis when
#    configured. TCP-level reachability, 5s timeout. The application-level
#    readiness gate follows in step 5 (/readyz).
probe_url() { # $1 = url, $2 = default port (postgres 5432 / redis 6379)
  PROBE_URL="$1" PROBE_DPORT="${2:-}" node -e '
    const net = require("net");
    const url = new URL(process.env.PROBE_URL);
    const host = (url.hostname || "").replace(/^\[|\]$/g, "");   // strip IPv6 brackets
    const port = url.port ? Number(url.port)
                          : (process.env.PROBE_DPORT ? Number(process.env.PROBE_DPORT) : 5432);
    if (!host) { console.log("✗ cannot parse URL"); process.exit(1); }
    const s = net.connect({ host, port });
    s.setTimeout(5000);
    s.on("connect", () => { console.log(`  ✓ reachable ${host}:${port}`); s.destroy(); process.exit(0); });
    s.on("error", (e) => { console.log(`  ✗ UNREACHABLE ${host}:${port} (${e.code})`); process.exit(1); });
    s.on("timeout", () => { console.log(`  ✗ probe timed out ${host}:${port}`); process.exit(1); });
  '
}
echo "==> Connectivity probes"
if [ -n "${POSTGRES_URL:-}" ]; then
  probe_url "$POSTGRES_URL" 5432 \
    || { echo "✗ database connectivity failed — check POSTGRES_URL"; exit 1; }
else
  echo "  (no POSTGRES_URL — skipping database probe; production requires Postgres)"
fi
if [ -n "${REDIS_URL:-}" ]; then
  probe_url "$REDIS_URL" 6379 \
    || { echo "✗ redis connectivity failed — check REDIS_URL"; exit 1; }
fi

# 5. Start + health gate (/readyz).
wait_ready() { # $1 = attempts, 2s apart
  local n="${1:-60}"
  for _ in $(seq 1 "$n"); do
    if curl -sf "http://127.0.0.1:7400/readyz" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# Detached start that survives script/session exit: new session via setsid
# (nohup fallback), stdio redirected, env sourced inside the child so quoting
# in production.env can never break the command line. Root drops to the
# service user when runuser is available.
start_detached() {
  local wrapper="setsid"
  command -v setsid >/dev/null 2>&1 || wrapper="nohup"
  if [ "$(id -u)" = "0" ] && command -v runuser >/dev/null 2>&1 \
     && id -u "$APP_USER" >/dev/null 2>&1; then
    wrapper="$wrapper runuser -u $APP_USER --"
  elif [ "$(id -u)" = "0" ]; then
    echo "  (root without runuser — running as root; prefer provision.sh's service user)"
  fi
  # shellcheck disable=SC2086  # wrapper word-splitting is intentional
  $wrapper bash -c 'set -a; . "$1"; set +a; exec node "$2" serve 7400' \
    _ "$ENV_FILE" "$SERVER_JS" >> "$LOG" 2>&1 < /dev/null &
  disown 2>/dev/null || true
}

echo "==> Start + health gate (/readyz)"
MODE="background"
if [ "${FORCE_BACKGROUND:-0}" != "1" ] && [ "$(id -u)" = "0" ] \
   && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 \
   && [ -w /etc/systemd/system ] \
   && [ "$(ps -p 1 -o comm= 2>/dev/null || true)" = "systemd" ]; then
  MODE="systemd"
fi
echo "  (mode: ${MODE})"

if [ "$MODE" = "systemd" ]; then
  id -u "$APP_USER" >/dev/null 2>&1 \
    || { echo "✗ service user $APP_USER missing — run provision.sh first"; exit 1; }
  [ -f "$SERVER_JS" ] || { echo "✗ $SERVER_JS missing — install incomplete"; exit 1; }
  # The hardened unit pins ReadWritePaths=/var/lib/jataqi/{storage,backups};
  # those host dirs must exist BEFORE the service's mount namespace is set
  # up, or systemd aborts the unit with status 226/NAMESPACE. Create them
  # idempotently (mirrors provision.sh so deploy.sh also works standalone).
  for d in /var/lib/jataqi/storage /var/lib/jataqi/backups; do
    mkdir -p "$d"
    chown "$APP_USER:$APP_USER" "$d"
  done
  # Template the hardened unit to APP_DIR (default /opt/jataqi is the
  # template's built-in value, so only re-render when customized).
  if [ "$APP_DIR" != "/opt/jataqi" ] || [ "$APP_USER" != "jataqi" ]; then
    sed -e "s#/opt/jataqi#$APP_DIR#g" \
        -e "s/^User=jataqi/User=$APP_USER/" \
        -e "s/^Group=jataqi/Group=$APP_USER/" \
        "$APP_DIR/deploy/production/jataqi.service" > /etc/systemd/system/jataqi.service
  else
    cp "$APP_DIR/deploy/production/jataqi.service" /etc/systemd/system/jataqi.service
  fi
  systemctl daemon-reload
  systemctl enable --now jataqi
  if ! wait_ready 60; then
    echo "✗ /readyz failed — unit status:"
    systemctl status jataqi --no-pager | tail -20 || true
    journalctl -u jataqi --no-pager -n 30 2>/dev/null | tail -30 || true
    exit 1
  fi
  echo "✓ /readyz 200 — service active (systemd)"
else
  # Background mode: detached process that survives the script/session exit.
  [ -f "$SERVER_JS" ] || { echo "✗ $SERVER_JS missing — install incomplete"; exit 1; }
  LOG=/var/log/jataqi.log
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  [ -w "$(dirname "$LOG")" ] || LOG="$APP_DIR/jataqi.log"
  touch "$LOG" 2>/dev/null || LOG="$APP_DIR/jataqi.log"
  echo "  (log: $LOG)"
  start_detached
  BG_PID=$!
  if ! wait_ready 60; then
    echo "✗ /readyz failed — last log lines:"
    tail -20 "$LOG" || true
    exit 1
  fi
  echo "✓ /readyz 200 — background mode (pid ${BG_PID})"
fi

echo "==> Deploy complete: v${VERSION} @ ${COMMIT}"
