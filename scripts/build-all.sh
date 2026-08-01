#!/usr/bin/env bash
# Build every workspace in topological (dependency) order. The default
# `npm run build --workspaces` runs packages concurrently, which races when a
# package imports another package's not-yet-written dist typings.
set -euo pipefail
cd "$(dirname "$0")/.."

PKGS=(
  core-kernel storage vector-search
  qil security metrics simulation tracing realtime
  knowledge-service knowledge-graph
  model-registry scheduler plugins readiness commerce organizations notifications policies feature-flags privacy policy-governance payments messaging ai-safety model-runtime conversations
  agent-runtime compute teams robotics digital-twin tool-intelligence provenance
  orchestrator multimedia evals finance communication research education health self-evolution supply-chain environment cyberdefense iot smart-cities cloud-devops localization enterprise mfa disaster-recovery optimization synthetic-data business-intelligence api-gateway sdk web-ui multimodal sovereign llm-gateway cli
)

for p in "${PKGS[@]}"; do
  echo "▶ build @jataqi/$p"
  npm run build --workspace "@jataqi/$p"
done
echo "✓ all packages built"
