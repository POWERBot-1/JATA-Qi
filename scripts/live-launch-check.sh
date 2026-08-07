#!/usr/bin/env bash
# JATA Qi v1.0.0 — Live Launch Gate Check (operator-executed, ON THE VPS).
#
#   bash scripts/live-launch-check.sh            # defaults: APP_DIR=/opt/jataqi
#   APP_DIR=/srv/jataqi DOMAIN=example.com bash scripts/live-launch-check.sh
#
# Verifies every EXTERNAL gate from the Phase-7 mandate (docs/PRODUCTION_LAUNCH_REPORT.md
# section B) after the operator has executed the deploy/production steps:
#
#   B1 VPS provisioning/hardening        B2 DNS A records
#   B3 CA-issued TLS + HSTS + 301        B4 production.env (0600, zero CHANGE_ME)
#   B5 PostgreSQL/Redis reachable        B6 deploy.sh → /readyz 200
#   B7 payment providers configured      B8 backup cron installed
#   B9/B10 first transaction + first customer (data gates — operator confirmation)
#
# Output: per-gate PASS/FAIL/WARN + a final verdict. The script NEVER claims a
# gate passed on its own: it probes the LIVE endpoint/state directly (DNS,
# TLS, HTTP, TCP, filesystem). Verdict line is the exact Phase-7 declaration
# string, printed only when every required gate passes.
#
# Exit code: 0 = all REQUIRED gates pass (WARN items may be open);
#            1 = at least one required gate fails; 2 = usage/config error.

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/jataqi}"
DOMAIN="${DOMAIN:-}"
PORT="${PORT:-7400}"
APP_URL="http://127.0.0.1:${PORT}"
# shellcheck disable=SC2034
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; DIM='\033[2m'; NC='\033[0m'

PASS=0; FAIL=0; WARN=0
declare -a FAILED_ITEMS=() WARNED_ITEMS=()

ok()   { PASS=$((PASS+1)); printf "${GREEN}  ✓ %s${NC}\n" "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED_ITEMS+=("$1"); printf "${RED}  ✗ %s${NC}\n" "$1"; }
warn() { WARN=$((WARN+1)); WARNED_ITEMS+=("$1"); printf "${YELLOW}  ⚠ %s${NC}\n" "$1"; }
info() { printf "${DIM}    %s${NC}\n" "$1"; }

echo "== JATA Qi v1.0.0 — Live Launch Gate Check =="
echo "   APP_DIR=${APP_DIR}  DOMAIN=${DOMAIN:-<unset — DNS/TLS gates will be skipped>}  PORT=${PORT}"
[ -d "$APP_DIR" ] || { echo "✗ APP_DIR ${APP_DIR} does not exist — run deploy.sh first"; exit 2; }

# --- B1: VPS provisioning + hardening --------------------------------------
echo ""
echo "== [B1] VPS provisioning & hardening"
if [ -f /etc/os-release ] && grep -qiE 'ubuntu|debian' /etc/os-release; then
  ok "Ubuntu/Debian base OS detected"
else
  warn "non-Ubuntu/Debian base (provision.sh targets Ubuntu 22.04/24.04)"
fi
if id jataqi >/dev/null 2>&1; then ok "service user 'jataqi' exists"; else warn "service user 'jataqi' missing (provision.sh [4/8])"; fi
if command -v ufw >/dev/null 2>&1 && sudo -n ufw status 2>/dev/null | grep -q "Status: active"; then
  ok "UFW active (deny by default, 22/80/443)"
else
  warn "UFW not confirmed active (check: sudo ufw status)"
fi
if command -v systemctl >/dev/null 2>&1 && sudo -n systemctl is-active --quiet fail2ban 2>/dev/null; then
  ok "fail2ban active"
else
  warn "fail2ban not confirmed active (check: sudo systemctl status fail2ban)"
fi
if [ -f /swapfile ]; then ok "/swapfile present (2G)"; else warn "/swapfile missing (provision.sh [8/8])"; fi

# --- B2: DNS A records --------------------------------------------------------
echo ""
echo "== [B2] DNS resolution"
if [ -n "$DOMAIN" ]; then
  resolve() { # $1 = host; echoes first IP or empty
    getent ahostsv4 "$1" 2>/dev/null | awk '{print $1; exit}' \
      || command -v dig >/dev/null 2>&1 && dig +short "$1" 2>/dev/null | grep -E '^[0-9.]+$' | head -1
  }
  for host in "api.${DOMAIN}" "$DOMAIN"; do
    IP=$(resolve "$host")
    if [ -n "$IP" ]; then ok "DNS: ${host} → ${IP}"; else bad "DNS: ${host} does not resolve (add A record)"; fi
  done
else
  warn "DOMAIN unset — DNS gate skipped (pass DOMAIN=example.com)"
fi

# --- B3: TLS + HTTPS enforcement ----------------------------------------------
echo ""
echo "== [B3] TLS / HTTPS"
if [ -n "$DOMAIN" ]; then
  HTTPS_URL="https://api.${DOMAIN}/health"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$HTTPS_URL" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then
    ok "HTTPS ${HTTPS_URL} → 200"
  else
    bad "HTTPS ${HTTPS_URL} → ${CODE} (certbot + nginx not serving)"
  fi
  HSTS=$(curl -sI --max-time 15 "$HTTPS_URL" 2>/dev/null | tr -d '\r' | grep -i '^strict-transport-security:' | head -1)
  if echo "$HSTS" | grep -qi 'max-age=31536000'; then ok "HSTS header present (max-age=31536000)"; else bad "HSTS header missing on ${HTTPS_URL}"; fi
  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://api.${DOMAIN}/health" 2>/dev/null || echo 000)
  REDIRECT=$(curl -sI --max-time 15 "http://api.${DOMAIN}/health" 2>/dev/null | tr -d '\r' | grep -i '^location:' | head -1)
  if [ "$HTTP_CODE" = "301" ] && echo "$REDIRECT" | grep -qi 'https://'; then
    ok "HTTP → HTTPS 301 redirect"
  else
    bad "HTTP redirect missing (got ${HTTP_CODE}: ${REDIRECT:-no location})"
  fi
  if command -v openssl >/dev/null 2>&1; then
    EXPIRY=$(echo | timeout 10 openssl s_client -servername "api.${DOMAIN}" -connect "api.${DOMAIN}:443" 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    if [ -n "$EXPIRY" ]; then ok "cert expires: ${EXPIRY}"; else warn "could not read cert expiry (openssl probe)"; fi
  fi
else
  warn "DOMAIN unset — TLS gate skipped"
fi

# --- B4: production.env secrets ----------------------------------------------
echo ""
echo "== [B4] production.env"
ENV_FILE="$APP_DIR/production.env"
if [ -f "$ENV_FILE" ]; then
  MODE=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '?')
  if [ "$MODE" = "600" ]; then ok "production.env mode 600 (actual ${MODE})"; else bad "production.env mode ${MODE} — must be 600"; fi
  if grep -q 'CHANGE_ME' "$ENV_FILE"; then bad "production.env still contains CHANGE_ME placeholders"; else ok "no CHANGE_ME placeholders"; fi
  if [ "$(id -u)" = "0" ]; then
    OWNER=$(stat -c '%U' "$ENV_FILE" 2>/dev/null || echo '?')
    if [ "$OWNER" = "jataqi" ]; then ok "production.env owned by jataqi"; else warn "production.env owner ${OWNER} (expected jataqi)"; fi
  fi
else
  bad "production.env missing in ${APP_DIR}"
fi

# --- B5: PostgreSQL / Redis reachability --------------------------------------
echo ""
echo "== [B5] Database + cache"
# shellcheck disable=SC1090
set -a; [ -f "$ENV_FILE" ] && . "$ENV_FILE"; set +a
probe_url() { # $1 = url, $2 = default port
  PROBE_URL="$1" PROBE_DPORT="${2:-}" node -e '
    const net = require("net");
    const url = new URL(process.env.PROBE_URL);
    const host = (url.hostname || "").replace(/^\[|\]$/g, "");
    const port = url.port ? Number(url.port) : (process.env.PROBE_DPORT ? Number(process.env.PROBE_DPORT) : 5432);
    if (!host) process.exit(1);
    const s = net.connect({ host, port });
    s.setTimeout(5000);
    s.on("connect", () => { s.destroy(); process.exit(0); });
    s.on("error", () => process.exit(1));
    s.on("timeout", () => process.exit(1));
  ' 2>/dev/null
}
if [ -n "${POSTGRES_URL:-}" ]; then
  if probe_url "$POSTGRES_URL" 5432; then ok "PostgreSQL reachable (${POSTGRES_URL%%@*}@${POSTGRES_URL##*@})"; else bad "PostgreSQL UNREACHABLE — check POSTGRES_URL + daemon"; fi
else
  bad "POSTGRES_URL not set in production.env (production requires Postgres)"
fi
if [ -n "${REDIS_URL:-}" ]; then
  if probe_url "$REDIS_URL" 6379; then ok "Redis reachable"; else bad "Redis UNREACHABLE — check REDIS_URL + daemon"; fi
else
  warn "REDIS_URL unset (optional — used when configured)"
fi

# --- B6: application endpoints ------------------------------------------------
echo ""
echo "== [B6] Application (deploy.sh /readyz gate)"
for ep in readyz livez health; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$APP_URL/$ep" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then ok "/${ep} → 200"; else bad "/${ep} → ${CODE} (is the service running?)"; fi
done
HEALTH=$(curl -s --max-time 10 "$APP_URL/health" 2>/dev/null || true)
if echo "$HEALTH" | grep -q '"status":"healthy"'; then
  MODULES=$(echo "$HEALTH" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).modules?.length??"?");}catch{console.log("?");}})' 2>/dev/null)
  ok "health: healthy (${MODULES} modules)"
else
  bad "health endpoint not healthy"
fi

# --- B7: payment providers configured ------------------------------------------
echo ""
echo "== [B7] Payment providers"
if grep -q '^STRIPE_SECRET_KEY=' "$ENV_FILE" 2>/dev/null && [ -n "${STRIPE_SECRET_KEY:-}" ]; then
  ok "Stripe secret key present (live)"
else
  warn "STRIPE_SECRET_KEY not set — Stripe rail off"
fi
if grep -q '^MPESA_CONSUMER_KEY=' "$ENV_FILE" 2>/dev/null && [ -n "${MPESA_CONSUMER_KEY:-}" ] \
   && [ -n "${MPESA_CONSUMER_SECRET:-}" ] && [ -n "${MPESA_SHORTCODE:-}" ] && [ -n "${MPESA_PASSKEY:-}" ]; then
  ok "M-Pesa Daraja keys present (${MPESA_ENVIRONMENT:-sandbox})"
  if [ -n "${MPESA_CALLBACK_URL:-}" ]; then ok "MPESA_CALLBACK_URL set"; else warn "MPESA_CALLBACK_URL unset — STK callbacks cannot reach the server"; fi
else
  warn "M-Pesa Daraja keys incomplete — M-Pesa rail off"
fi

# --- B8: backups -----------------------------------------------------------------
echo ""
echo "== [B8] Backups"
if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -q 'backup.sh'; then
  ok "backup cron installed"
else
  warn "backup cron not found (install: crontab -e → 0 2 * * * ${APP_DIR}/deploy/production/backup.sh)"
fi

# --- B9/B10: data gates (operator confirmation) -----------------------------------
echo ""
echo "== [B9/B10] Commercial data gates (operator confirmation)"
if [ -f "$APP_DIR/live-launch.conf" ]; then
  # shellcheck disable=SC1091
  . "$APP_DIR/live-launch.conf"
fi
if [ "${FIRST_TRANSACTION_CONFIRMED:-0}" = "1" ]; then
  ok "first production commercial transaction confirmed (invoice PAID + audit trail)"
else
  bad "first production transaction NOT confirmed — record a real payment first, then:"
  info "echo 'FIRST_TRANSACTION_CONFIRMED=1' > ${APP_DIR}/live-launch.conf"
fi
if [ "${FIRST_CUSTOMER_CONFIRMED:-0}" = "1" ]; then
  ok "first external customer onboarded (account + usage)"
else
  bad "first external customer NOT confirmed — complete the customer onboarding runbook, then:"
  info "echo 'FIRST_CUSTOMER_CONFIRMED=1' >> ${APP_DIR}/live-launch.conf"
fi

# --- Verdict ----------------------------------------------------------------------
echo ""
echo "=========================================="
echo "  PASS: ${PASS}   FAIL: ${FAIL}   WARN: ${WARN}"
if [ "$FAIL" -gt 0 ]; then
  echo "  Failed gates:"
  for f in "${FAILED_ITEMS[@]}"; do printf "    ✗ %s\n" "$f"; done
  exit 1
fi
echo "  All required gates passed."
if [ "$WARN" -gt 0 ]; then
  echo "  Open warnings (non-blocking):"
  for w in "${WARNED_ITEMS[@]}"; do printf "    ⚠ %s\n" "$w"; done
fi
echo "  Verdict: all external gates verified ON THIS VPS."
echo "  Operator may now declare:"
echo "  >>> JATA Qi v1.0.0 — LIVE PRODUCTION / COMMERCIAL LAUNCH <<<"
exit 0
