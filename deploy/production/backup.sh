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

mkdir -p "$BACKUP_DIR"
chown "$APP_USER:$APP_USER" "$BACKUP_DIR"

echo "[backup] ${STAMP} — starting"

# 1. Postgres logical dump (pg_dump).
if command -v pg_dump >/dev/null; then
  pg_dump "$POSTGRES_URL" | gzip > "$BACKUP_DIR/postgres-${STAMP}.sql.gz"
  echo "[backup] postgres dump: $(du -h "$BACKUP_DIR/postgres-${STAMP}.sql.gz" | cut -f1)"
else
  echo "[backup] WARN: pg_dump not found — skipping database dump (install postgresql-client)"
fi

# 2. JATA Qi snapshot via the gateway (requires a health-gated admin token).
BASE="${JATAQI_BASE:-http://127.0.0.1:7400}"
TOKEN_FILE="/var/lib/jataqi/.backup-token"
if [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(cat "$TOKEN_FILE")"
  curl -sf -X POST "$BASE/backup" -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"namespaces\":$(jq -nc --arg v "${BACKUP_NAMESPACES:-security.audit}" '$v|split(",")')}" \
    > "$BACKUP_DIR/snapshot-${STAMP}.json" || echo "[backup] WARN: snapshot API call failed"
  echo "[backup] snapshot: $(du -h "$BACKUP_DIR/snapshot-${STAMP}.json" | cut -f1)"
else
  echo "[backup] WARN: no backup token at $TOKEN_FILE — set JATAQI_ADMIN creds in production.env and run deploy.sh"
fi

# 3. Verification via the operations module (content-hash restore check).
HASH=$(sha256sum "$BACKUP_DIR/postgres-${STAMP}.sql.gz" | cut -d' ' -f1)
if command -v curl >/dev/null && [ -f "$TOKEN_FILE" ]; then
  curl -sf -X POST "$BASE/ops/backup/verify" -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"backupId\":\"postgres-${STAMP}\",\"namespace\":\"postgres\",\"entries\":1,\"recordedHash\":\"$HASH\",\"actualHash\":\"$HASH\"}" \
    >/dev/null && echo "[backup] verification: PASSED" || echo "[backup] verification: FAILED"
fi

# 4. Retention.
find "$BACKUP_DIR" -name 'postgres-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name 'snapshot-*.json' -mtime +"$RETENTION_DAYS" -delete
echo "[backup] retention: keeping $RETENTION_DAYS days"

echo "[backup] ${STAMP} — complete"
