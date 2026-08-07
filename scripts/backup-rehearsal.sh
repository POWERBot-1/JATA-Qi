#!/usr/bin/env bash
# JATA Qi v1.0.0 — backup.sh end-to-end rehearsal.
#
# Boots a real gateway (filesystem storage, admin bootstrap) and runs the
# REAL deploy/production/backup.sh against an isolated BACKUP_DIR, covering:
#   1. pg_dump-absent path  (WARN, must NOT crash — regression for the
#      unguarded sha256sum defect)
#   2. automatic backup-token bootstrap from JATAQI_ADMIN_USERNAME/PASSWORD
#      (no manual token file — regression for the missing-token defect)
#   3. namespace snapshot via POST /backup (non-empty, valid JSON)
#   4. verification flow with a real dump file → "verification: PASSED"
#   5. retention + clean completion
#
#   bash scripts/backup-rehearsal.sh   (exit 0 = all checks pass)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT=$((30000 + RANDOM % 2000))
FS_ROOT=$(mktemp -d /tmp/jataqi-backup-fs-XXXXXX)
BACKUP_DIR=$(mktemp -d /tmp/jataqi-backup-bak-XXXXXX)
TOKEN_DIR=$(mktemp -d /tmp/jataqi-backup-tok-XXXXXX)
LOG=$(mktemp /tmp/jataqi-backup-srv-XXXX.log)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "== [1/5] Boot gateway (filesystem storage, admin bootstrap)"
STORAGE_DRIVER=filesystem STORAGE_FS_ROOT="$FS_ROOT" \
  JATAQI_ADMIN_USERNAME=admin JATAQI_ADMIN_PASSWORD=admin LOG_LEVEL=warn \
  node "$REPO/packages/cli/dist/src/index.js" serve "$PORT" > "$LOG" 2>&1 &
SRV=$!
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1 || { echo "✗ gateway failed to boot"; tail -5 "$LOG"; exit 1; }
ok "gateway healthy on :$PORT"

echo "== [2/5] Run backup.sh (pg_dump absent → WARN path, token auto-bootstrap)"
OUT=$(POSTGRES_URL=postgres://jataqi:pw@127.0.0.1:5432/jataqi \
  BACKUP_DIR="$BACKUP_DIR" BACKUP_TOKEN_DIR="$TOKEN_DIR" \
  JATAQI_BASE="http://127.0.0.1:$PORT" \
  JATAQI_ADMIN_USERNAME=admin JATAQI_ADMIN_PASSWORD=admin \
  bash "$REPO/deploy/production/backup.sh" 2>&1) && RC=$? || RC=$?
[ "$RC" = "0" ] && ok "backup.sh exited 0 (was exit 1 pre-fix on pg_dump-absent path)" || bad "backup.sh exited ${RC}"
echo "$OUT" | grep -q "WARN: pg_dump not found" && ok "pg_dump-absent WARN emitted" || bad "pg_dump-absent WARN missing"
echo "$OUT" | grep -q "backup token cached" && ok "token auto-bootstrapped from admin creds" || bad "token bootstrap missing"

echo "== [3/5] Snapshot artifact"
SNAP=$(ls "$BACKUP_DIR"/snapshot-*.json 2>/dev/null | head -1 || true)
if [ -n "$SNAP" ] && [ -s "$SNAP" ]; then
  node -e "JSON.parse(require('fs').readFileSync('$SNAP','utf8'));" 2>/dev/null \
    && ok "snapshot written + valid JSON ($(du -h "$SNAP" | cut -f1))" || bad "snapshot invalid JSON"
else
  bad "no snapshot artifact produced"
fi

echo "== [4/5] Verification with a real dump file (fake pg_dump shim)"
FAKEBIN=$(mktemp -d /tmp/jataqi-backup-bin-XXXXXX)
cat > "$FAKEBIN/pg_dump" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '-- JATA Qi rehearsal fake postgres dump' 'CREATE TABLE probe(id int);'
EOF
chmod +x "$FAKEBIN/pg_dump"
OUT2=$(PATH="$FAKEBIN:$PATH" POSTGRES_URL=postgres://jataqi:pw@127.0.0.1:5432/jataqi \
  BACKUP_DIR="$BACKUP_DIR" BACKUP_TOKEN_DIR="$TOKEN_DIR" \
  JATAQI_BASE="http://127.0.0.1:$PORT" \
  JATAQI_ADMIN_USERNAME=admin JATAQI_ADMIN_PASSWORD=admin \
  bash "$REPO/deploy/production/backup.sh" 2>&1) && RC2=$? || RC2=$?
[ "$RC2" = "0" ] && ok "second run exited 0" || bad "second run exited ${RC2}"
echo "$OUT2" | grep -q "postgres dump:" && ok "dump produced via pg_dump shim" || bad "dump step missing"
echo "$OUT2" | grep -q "verification: PASSED" && ok "ops backup verification PASSED (content-hash flow)" || bad "verification not PASSED"
echo "$OUT2" | grep -q "retention: keeping 14 days" && ok "retention step ran" || bad "retention step missing"
echo "$OUT2" | grep -q "complete" && ok "clean completion" || bad "no completion line"
rm -rf "$FAKEBIN"

echo "== [5/5] Cleanup"
kill "$SRV" 2>/dev/null || true
wait "$SRV" 2>/dev/null || true
rm -rf "$FS_ROOT" "$BACKUP_DIR" "$TOKEN_DIR" "$LOG"

echo ""
echo "backup rehearsal: PASS=${PASS} FAIL=${FAIL}"
[ "$FAIL" = "0" ] && echo "✓ BACKUP REHEARSAL PASSED" || { echo "✗ BACKUP REHEARSAL FAILED"; exit 1; }
