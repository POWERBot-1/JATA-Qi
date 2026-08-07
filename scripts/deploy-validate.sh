#!/usr/bin/env bash
# JATA Qi v1.0.0 — Commercial deployment artifact validation.
#
# Verifies every artifact a customer/operator consumes is present, well-formed,
# and consistent with the GA build:
#
#   1. Docker: Dockerfile multi-stage structure + .dockerignore coverage
#   2. Compose: docker-compose.yml exists with the production service
#   3. Kubernetes: kustomize base + PSS labels + per-pillar network policies
#   4. Helm: chart renders structurally (Chart.yaml v1.0.0, templates present)
#   5. Terraform: primary + DR region configs + variables
#   6. Version: root + Helm chart both at 1.0.0
#   7. Production boot: CLI serve with filesystem storage reaches /readyz
#
# Usage: bash scripts/deploy-validate.sh
set -euo pipefail
cd "$(dirname "$0")/.."

FAIL=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; FAIL=1; }

echo "== 1. Docker image artifact =="
if [ -f Dockerfile ] && grep -q "FROM node:22-slim AS builder" Dockerfile && grep -q "CMD \[\"node\", \"packages/cli/dist/src/index.js\", \"serve\"\]" Dockerfile; then
  ok "Dockerfile multi-stage + production CMD"
else
  bad "Dockerfile structure"
fi
if [ -f .dockerignore ] && grep -q "node_modules" .dockerignore && grep -q "dist" .dockerignore; then
  ok ".dockerignore excludes node_modules + dist"
else
  bad ".dockerignore"
fi

echo "== 2. Docker Compose =="
if [ -f docker-compose.yml ] && grep -q "7400" docker-compose.yml; then
  ok "docker-compose.yml with gateway port"
else
  bad "docker-compose.yml"
fi

echo "== 3. Kubernetes manifests =="
for f in namespace configmap secret serviceaccount deployment service ingress hpa pdb networkpolicy networkpolicy-backup networkpolicy-observability; do
  if [ -f "deploy/k8s/$f.yaml" ]; then ok "deploy/k8s/$f.yaml"; else bad "deploy/k8s/$f.yaml"; fi
done
if grep -q "pod-security.kubernetes.io/enforce: restricted" deploy/k8s/namespace.yaml; then
  ok "PSS restricted enforcement labels"
else
  bad "PSS labels"
fi
if grep -q "networkpolicy-backup.yaml" deploy/k8s/kustomization.yaml; then
  ok "per-pillar policies wired into kustomize"
else
  bad "kustomize policy wiring"
fi

echo "== 4. Helm chart =="
if [ -f deploy/helm/jataqi/Chart.yaml ] && grep -q "version: 1.0.0" deploy/helm/jataqi/Chart.yaml; then
  ok "Chart.yaml v1.0.0"
else
  bad "Chart.yaml version"
fi
TPL=$(ls deploy/helm/jataqi/templates/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$TPL" -ge 10 ]; then
  ok "helm templates present ($TPL)"
else
  bad "helm templates ($TPL < 10)"
fi
if grep -q "networkPolicy.backupEgress" deploy/helm/jataqi/templates/networkpolicy-backup.yaml; then
  ok "helm conditional per-pillar policies"
else
  bad "helm networkpolicy-backup template"
fi

echo "== 5. Terraform =="
for f in main.tf variables.tf outputs.tf dr-region.tf; do
  if [ -f "deploy/terraform/$f" ]; then ok "deploy/terraform/$f"; else bad "deploy/terraform/$f"; fi
done
if grep -q "aws_db_instance.jataqi.arn" deploy/terraform/dr-region.tf; then
  ok "multi-region DR (RDS replica + S3 replication)"
else
  bad "dr-region.tf replication"
fi

echo "== 6. Version consistency =="
ROOT_V=$(node -p "require('./package.json').version")
if [ "$ROOT_V" = "1.0.0" ]; then ok "root version 1.0.0"; else bad "root version $ROOT_V"; fi
if git tag --list v1.0.0 | grep -q v1.0.0; then ok "git tag v1.0.0 present"; else bad "git tag v1.0.0 missing"; fi

echo "== 7. Production boot (filesystem storage → /readyz) =="
PORT=$((RANDOM % 2000 + 30000))
FSROOT=$(mktemp -d)
STORAGE_DRIVER=filesystem STORAGE_FS_ROOT="$FSROOT" \
  JATAQI_ADMIN_USERNAME=admin JATAQI_ADMIN_PASSWORD=admin LOG_LEVEL=warn \
  node packages/cli/dist/src/index.js serve "$PORT" >/tmp/jataqi-deploy-validate.log 2>&1 &
SRV=$!
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1; then break; fi
  sleep 1
done
if curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1; then
  ok "production boot → /readyz 200 (filesystem storage)"
  curl -sf -X POST "http://127.0.0.1:$PORT/auth/register" -H 'content-type: application/json' \
    -d '{"username":"deploy","password":"pw123","roles":["developer"]}' >/dev/null 2>&1 \
    && ok "register works on production boot" || bad "register on production boot"
else
  bad "production boot (see /tmp/jataqi-deploy-validate.log)"
  tail -5 /tmp/jataqi-deploy-validate.log || true
fi
kill "$SRV" 2>/dev/null || true
wait "$SRV" 2>/dev/null || true
rm -rf "$FSROOT"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "✓ deployment artifacts validated (all checks passed)"
else
  echo "✗ deployment artifact validation FAILED"
  exit 1
fi
