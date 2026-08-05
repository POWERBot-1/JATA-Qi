#!/usr/bin/env bash
# Build every workspace in topological (dependency) order. The default
# `npm run build --workspaces` runs packages concurrently, which races when a
# package imports another package's not-yet-written dist typings.
set -euo pipefail
cd "$(dirname "$0")/.."

PKGS=(
  core-kernel storage vector-search
  qil security metrics simulation tracing realtime
  knowledge-service knowledge-graph agent-runtime
  model-registry scheduler plugins readiness commerce organizations notifications policies feature-flags privacy policy-governance payments messaging ai-safety model-runtime conversations
  compute teams robotics digital-twin tool-intelligence provenance
  design-system icons branding dashboard memory learning ai-learning search automation universal-wallet crypto fx pki mobility logistics agriculture circular energy border accreditation dns registry registrar game-engine game-world game-physics game-architect game-ai game-net game-economy game-audio game-esports game-publish game-liveops
  orchestrator multimedia evals finance communication research education health self-evolution link-intelligence multimodal-intelligence supply-chain environment cyberdefense iot smart-cities cloud-devops localization enterprise mfa disaster-recovery optimization synthetic-data business-intelligence api-gateway sdk web-ui multimodal sovereign llm-gateway cli
)

for p in "${PKGS[@]}"; do
  echo "▶ build @jataqi/$p"
  npm run build --workspace "@jataqi/$p"
done
echo "✓ all packages built"
