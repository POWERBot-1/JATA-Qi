#!/usr/bin/env bash
# Test every workspace in topological order (each workspace's `pretest` rebuilds
# itself, but its dependencies are already built by build-all.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

PKGS=(
  core-kernel storage vector-search
  qil security metrics simulation tracing realtime
  knowledge-service knowledge-graph
  model-registry scheduler plugins readiness commerce organizations notifications policies feature-flags privacy policy-governance payments messaging ai-safety model-runtime conversations
  compute teams robotics digital-twin tool-intelligence provenance
  design-system icons branding dashboard memory learning ai-learning search automation universal-wallet crypto fx pki mobility logistics agriculture circular energy border restaurants accreditation marketplace cloud dns registry registrar game-engine game-world game-physics game-architect game-ai game-net game-economy game-audio game-esports game-publish game-liveops
  agent-runtime
  orchestrator multimedia evals finance communication research education health self-evolution link-intelligence multimodal-intelligence supply-chain environment cyberdefense iot smart-cities cloud-devops localization enterprise mfa disaster-recovery optimization synthetic-data business-intelligence api-gateway sdk web-ui multimodal sovereign llm-gateway cli
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
