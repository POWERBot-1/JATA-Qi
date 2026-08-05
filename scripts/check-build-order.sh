#!/usr/bin/env bash
# Verify scripts/build-all.sh (and test-all.sh) lists every workspace exactly
# once and in topological order: if package A's src imports '@jataqi/B', then B
# must appear before A in the PKGS array.
set -euo pipefail
cd "$(dirname "$0")/.."

fatal=0
for script in scripts/build-all.sh scripts/test-all.sh; do
  # Extract the PKGS array contents (one package name per token).
  pkg_line=$(sed -n '/^PKGS=(/,/^)/p' "$script")
  pkgs=()
  for tok in $pkg_line; do
    case "$tok" in
      PKGS=|'('|')') ;;
      *) pkgs+=("$tok") ;;
    esac
  done

  # Every workspace must be present exactly once.
  for d in packages/*; do
    p=$(basename "$d")
    n=$(printf '%s\n' "${pkgs[@]}" | grep -cx "$p" || true)
    if [ "$n" -ne 1 ]; then
      echo "✗ $script: package '$p' listed $n times (expected 1)"
      fatal=1
    fi
  done

  # Topological order: importer's index must be > imported package's index.
  for d in packages/*; do
    imp=$(basename "$d")
    imp_idx=-1
    for i in "${!pkgs[@]}"; do [ "${pkgs[$i]}" = "$imp" ] && imp_idx=$i; done
    for dep in $(grep -rhoE "from '@jataqi/[a-z0-9-]+'" "packages/$imp/src" 2>/dev/null | sed -E "s/from '@jataqi\/([a-z0-9-]+)'/\1/" | sort -u); do
      if [ "$dep" = "$imp" ]; then continue; fi
      dep_idx=-1
      for i in "${!pkgs[@]}"; do [ "${pkgs[$i]}" = "$dep" ] && dep_idx=$i; done
      if [ "$dep_idx" -eq -1 ]; then
        echo "✗ $script: package '$dep' (imported by '$imp') is not in the build order"
        fatal=1
      elif [ "$dep_idx" -ge "$imp_idx" ]; then
        echo "✗ $script: '$dep' must build before '$imp' (imported in packages/$imp/src)"
        fatal=1
      fi
    done
  done
done

if [ "$fatal" -ne 0 ]; then
  echo "✗ build order invalid"; exit 1
fi
echo "✓ build order valid (topological, all packages covered)"
