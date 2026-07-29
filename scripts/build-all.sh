#!/usr/bin/env bash
# Build every workspace in topological (dependency) order. The default
# `npm run build --workspaces` runs packages concurrently, which races when a
# package imports another package's not-yet-written dist typings.
set -euo pipefail
cd "$(dirname "$0")/.."

PKGS=(
  core-kernel storage vector-search
  qil security metrics simulation
  knowledge-service knowledge-graph
  model-registry scheduler plugins readiness commerce organizations notifications
  agent-runtime compute teams robotics digital-twin tool-intelligence provenance
  orchestrator api-gateway cli
)

for p in "${PKGS[@]}"; do
  echo "▶ build @jataqi/$p"
  npm run build --workspace "@jataqi/$p"
done
echo "✓ all packages built"
