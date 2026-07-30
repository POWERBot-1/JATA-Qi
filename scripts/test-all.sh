#!/usr/bin/env bash
# Test every workspace in topological order (each workspace's `pretest` rebuilds
# itself, but its dependencies are already built by build-all.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

PKGS=(
  core-kernel storage vector-search
  qil security metrics simulation
  knowledge-service knowledge-graph
  model-registry scheduler plugins readiness commerce organizations notifications policies feature-flags privacy policy-governance
  agent-runtime compute teams robotics digital-twin tool-intelligence provenance
  orchestrator multimedia evals finance communication research education health self-evolution supply-chain environment cyberdefense iot smart-cities cloud-devops localization enterprise mfa disaster-recovery optimization synthetic-data business-intelligence api-gateway sdk cli
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
