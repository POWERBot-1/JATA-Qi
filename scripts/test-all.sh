#!/usr/bin/env bash
# Test every workspace in topological order (each workspace's `pretest` rebuilds
# itself, but its dependencies are already built by build-all.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

PKGS=(
  core-kernel storage vector-search
  qil security metrics simulation
  knowledge-service knowledge-graph
  model-registry scheduler plugins readiness
  agent-runtime compute teams robotics digital-twin tool-intelligence provenance
  orchestrator api-gateway cli
)

failed=0
for p in "${PKGS[@]}"; do
  echo "▶ test @jataqi/$p"
  if ! npm test --workspace "@jataqi/$p"; then
    failed=1
  fi
done
if [ "$failed" -ne 0 ]; then
  echo "✗ some tests failed"; exit 1
fi
echo "✓ all packages tested"
