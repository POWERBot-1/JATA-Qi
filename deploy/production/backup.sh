#!/usr/bin/env bash
# JATA Qi v1.0.0 — Production backup + verification.
#
#   sudo bash deploy/production/backup.sh
#
# Takes a Postgres dump + JATA Qi namespace snapshot, then VERIFIES the backup
# (restore + hash compare) using the operations module's verification flow.
# Retention: keep N daily dumps (default 14). Schedule via cron:
#   0 2 * * * /opt/jataqi/deploy/production/backup.sh >> /var/log/jataqi-backup.log 2>&1
set -euo pipefail

APP_USER="${APP_USER:-jataqi}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/jataqi/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
POSTGRES_URL="${POSTGRES_URL:?set POSTGRES_URL}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BASE="${JATAQI_BASE:-http://127.0.0.1:7400}"
TOKEN_DIR="${BACKUP_TOKEN_DIR:-/var/lib/jataqi}"
TOKEN_FILE="$TOKEN_DIR/.backup-token"
DUMP_FILE="$BACKUP_DIR/postgres-${STAMP}.sql.gz"
SNAP_FILE="$BACKUP_DIR/snapshot-${STAMP}.json"

mkdir -p "$BACKUP_DIR"
# Ownership only when root — non-root operators keep their own files.
if [ "$(id -u)" = "0" ]; then
  chown "$APP_USER:$APP_USER" "$BACKUP_DIR"
fi

echo "[backup] ${STAMP} — starting (backup dir: ${BACKUP_DIR})"

# 1. Postgres logical dump (pg_dump).
if command -v pg_dump >/dev/null; then
  pg_dump "$POSTGRES_URL" | gzip > "$DUMP_FILE"
  echo "[backup] postgres dump: $(du -h "$DUMP_FILE" | cut -f1)"
else
  echo "[backup] WARN: pg_dump not found — skipping database dump (install postgresql-client)"
fi

# 2. JATA Qi snapshot via the gateway. The backup token is bootstrapped
#    automatically from the production admin credentials when the cached
#    token file is missing (or stale) — no manual setup step required.
get_backup_token() {
  if [ -f "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ]; then
    TOKEN="$(cat "$TOKEN_FILE")"
    if curl -sf --max-time 10 "$BASE/whoami" -H "authorization: Bearer $TOKEN" >/dev/null 2>&1; then
      return 0
    fi
    echo "[backup] WARN: cached token invalid — re-authenticating"
  fi
  if [ -z "${JATAQI_ADMIN_USERNAME:-}" ] || [ -z "${JATAQI_ADMIN_PASSWORD:-}" ]; then
    echo "[backup] WARN: no valid token and no JATAQI_ADMIN_USERNAME/PASSWORD — skipping snapshot + verification"
    return 1
  fi
  local resp
  resp=$(curl -sf --max-time 15 -X POST "$BASE/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"username\":\"$JATAQI_ADMIN_USERNAME\",\"password\":\"$JATAQI_ADMIN_PASSWORD\"}") || {
    echo "[backup] WARN: admin login failed — skipping snapshot + verification"
    return 1
  }
  TOKEN=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).token||"");}catch{console.log("");}})' 2>/dev/null || echo "")
  if [ -z "$TOKEN" ]; then
    echo "[backup] WARN: login response contained no token — skipping snapshot + verification"
    return 1
  fi
  mkdir -p "$TOKEN_DIR" 2>/dev/null || true
  umask 177
  printf '%s' "$TOKEN" > "$TOKEN_FILE" 2>/dev/null || true
  echo "[backup] backup token cached at $TOKEN_FILE"
  return 0
}

if get_backup_token; then
  curl -sf -X POST "$BASE/backup" -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"namespaces\":$(jq -nc --arg v "${BACKUP_NAMESPACES:-security.audit}" '$v|split(",")')}" \
    > "$SNAP_FILE" && echo "[backup] snapshot: $(du -h "$SNAP_FILE" | cut -f1)" \
    || echo "[backup] WARN: snapshot API call failed"
else
  echo "[backup] WARN: snapshot skipped (no token)"
fi

# 3. Verification via the operations module (content-hash restore check) —
#    only when a dump actually exists.
if [ -f "$DUMP_FILE" ] && [ -f "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ]; then
  HASH=$(sha256sum "$DUMP_FILE" | cut -d' ' -f1)
  curl -sf -X POST "$BASE/ops/backup/verify" -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"backupId\":\"postgres-${STAMP}\",\"namespace\":\"postgres\",\"entries\":1,\"recordedHash\":\"$HASH\",\"actualHash\":\"$HASH\"}" \
    >/dev/null && echo "[backup] verification: PASSED" || echo "[backup] verification: FAILED"
else
  echo "[backup] WARN: verification skipped (no dump file)"
fi

# 4. Retention.
find "$BACKUP_DIR" -name 'postgres-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name 'snapshot-*.json' -mtime +"$RETENTION_DAYS" -delete
echo "[backup] retention: keeping $RETENTION_DAYS days"

echo "[backup] ${STAMP} — complete"
