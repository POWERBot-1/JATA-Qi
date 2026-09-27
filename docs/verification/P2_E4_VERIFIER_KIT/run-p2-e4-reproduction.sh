#!/usr/bin/env bash
# P2-E4 owner-side reproduction runner.
#
# This runner is preparation tooling only. It creates a disposable detached
# worktree, runs the declared commands, preserves raw logs and a machine
# readable observation record, and never authors the required independent
# verification report or changes the target worktree.
set -u -o pipefail

TARGET="08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe"
TARGET_TREE="5f2152ce0cd702b649b93bc23c165d36cb9b9dba"
SOURCE_REPO="${P2_E4_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
KIT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -n "${P2_E4_RUN_ROOT:-}" ]; then
  RUN_ROOT="$P2_E4_RUN_ROOT"
else
  RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jataqi-p2-e4.XXXXXX")"
fi
WORKTREE="$RUN_ROOT/worktree"
LOG_DIR="$RUN_ROOT/logs"
RESULTS="$RUN_ROOT/result-record.json"
mkdir -p "$LOG_DIR"

cleanup() {
  if [ -d "$WORKTREE" ]; then
    git -C "$SOURCE_REPO" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

printf 'P2-E4 owner-side reproduction runner\n' | tee "$LOG_DIR/runner.txt"
printf 'target=%s\ntree=%s\nsource_repo=%s\nrun_root=%s\n' \
  "$TARGET" "$TARGET_TREE" "$SOURCE_REPO" "$RUN_ROOT" | tee -a "$LOG_DIR/runner.txt"

# Resolve the target object without switching the session branch.
if ! git -C "$SOURCE_REPO" cat-file -e "$TARGET^{commit}" 2>/dev/null; then
  git -C "$SOURCE_REPO" fetch --no-tags origin "$TARGET" >"$LOG_DIR/fetch.log" 2>&1 || {
    echo "TARGET_FETCH_FAILED" | tee -a "$LOG_DIR/runner.txt"
    exit 2
  }
fi

git -C "$SOURCE_REPO" worktree add --detach "$WORKTREE" "$TARGET" >"$LOG_DIR/worktree.log" 2>&1 || {
  echo "WORKTREE_CREATE_FAILED" | tee -a "$LOG_DIR/runner.txt"
  exit 2
}

# Never execute from a later tree: establish the exact commit and tree first.
ACTUAL_COMMIT="$(git -C "$WORKTREE" rev-parse HEAD 2>/dev/null || true)"
ACTUAL_TREE="$(git -C "$WORKTREE" rev-parse HEAD^{tree} 2>/dev/null || true)"
STATUS_BEFORE="$(git -C "$WORKTREE" status --porcelain=v1 2>/dev/null || true)"
printf 'actual_commit=%s\nactual_tree=%s\nstatus_before=%q\n' \
  "$ACTUAL_COMMIT" "$ACTUAL_TREE" "$STATUS_BEFORE" | tee -a "$LOG_DIR/runner.txt"

if [ "$ACTUAL_COMMIT" != "$TARGET" ] || [ "$ACTUAL_TREE" != "$TARGET_TREE" ] || [ -n "$STATUS_BEFORE" ]; then
  echo "EXACT_CHECKOUT_FAILED" | tee -a "$LOG_DIR/runner.txt"
  exit 3
fi

: > "$LOG_DIR/steps.tsv"
OVERALL=0
run_step() {
  local id="$1" dir="$2"; shift 2
  local log="$LOG_DIR/${id}.log"
  printf '[%s] ' "$id" | tee -a "$LOG_DIR/runner.txt"
  (
    cd "$dir" &&
    "$@"
  ) >"$log" 2>&1
  local code=$?
  printf '%s\t%s\t%s\n' "$id" "$code" "$log" >> "$LOG_DIR/steps.tsv"
  printf 'exit=%s log=%s\n' "$code" "$log" | tee -a "$LOG_DIR/runner.txt"
  if [ "$code" -ne 0 ]; then OVERALL=1; fi
}

# Environment is recorded before dependency installation and execution.
{
  printf 'timestamp_utc='; date -u +%Y-%m-%dT%H:%M:%SZ
  printf 'node='; node --version 2>&1 || true
  printf 'npm='; npm --version 2>&1 || true
  printf 'uname='; uname -a 2>&1 || true
  printf 'commit=%s\ntree=%s\n' "$ACTUAL_COMMIT" "$ACTUAL_TREE"
} > "$LOG_DIR/environment.log"

run_step install "$WORKTREE" npm ci --no-audit --no-fund
run_step workspace-integrity "$WORKTREE" npm run check:workspaces
run_step build "$WORKTREE" npm run build
run_step lint "$WORKTREE" npm run lint
run_step whole-tree-test "$WORKTREE" npm test

run_step A-17 "$WORKTREE/packages/authentication" node --test dist/test/p2-s8-restart-recovery.test.js
run_step A-18 "$WORKTREE/packages/authentication" node --test dist/test/p2-s8-fanout-contention.test.js
run_step A-19-authentication "$WORKTREE/packages/authentication" node --test dist/test/p2-s8-outage-matrix.test.js
run_step A-19-authorization "$WORKTREE/packages/authorization-boundary" node --test dist/test/p2-s8-decision-outage.test.js
run_step A-20 "$WORKTREE/packages/authentication" node --test dist/test/p2-s8-failover.test.js
run_step A-21 "$WORKTREE/packages/authentication" node --test dist/test/p2-s8-skew-matrix.test.js
run_step A-22-A-23 "$WORKTREE/packages/authentication" node --test dist/test/p2-s8-tamper-duplicates.test.js
run_step mutation-hygiene "$WORKTREE/packages/authentication" node --test dist/test/p2-s8-mutation-hygiene.test.js
run_step disposable-mutation "$WORKTREE/packages/authentication" node --test dist/test/p2-s7-mutation.test.js

# Integrity is checked after all commands. Build products/node_modules may be
# untracked or ignored; tracked changes and untracked evidence are both shown.
{
  printf 'commit='; git -C "$WORKTREE" rev-parse HEAD
  printf 'tree='; git -C "$WORKTREE" rev-parse HEAD^{tree}
  printf '%s\n' 'status:'
  FINAL_STATUS="$(git -C "$WORKTREE" status --porcelain=v1 --untracked-files=all)"
  printf '%s\n' "$FINAL_STATUS"
  printf '%s\n' 'tracked-diff:'
  git -C "$WORKTREE" diff --exit-code -- .
  printf '%s\n' 'tree-list-sha256:'
  git -C "$WORKTREE" ls-tree -r "$TARGET" | sha256sum
  if [ -n "$FINAL_STATUS" ]; then
    printf '%s\n' 'UNEXPECTED_WORKTREE_STATUS'
    exit 1
  fi
} > "$LOG_DIR/final-integrity.log" 2>&1
FINAL_CODE=$?
printf 'final-integrity\t%s\t%s\n' "$FINAL_CODE" "$LOG_DIR/final-integrity.log" >> "$LOG_DIR/steps.tsv"
if [ "$FINAL_CODE" -ne 0 ]; then OVERALL=1; fi

# Generate observations only. The required verifier report is never generated.
python3 - "$LOG_DIR/steps.tsv" "$RESULTS" "$ACTUAL_COMMIT" "$ACTUAL_TREE" "$OVERALL" <<'PY'
import json
import pathlib
import sys

steps_path, result_path, commit, tree, overall = sys.argv[1:]
steps = []
for line in pathlib.Path(steps_path).read_text().splitlines():
    if not line:
        continue
    ident, code, log = line.split("\t", 2)
    steps.append({"id": ident, "exitCode": int(code), "log": log})
record = {
    "schema": "jataqi.p2-e4.result-record.v1",
    "status": "OBSERVED_RESULTS_UNDER_REVIEW",
    "evidenceClass": "OWNER_BUILDER_EXECUTION_UNLESS_AUTHORED_AND_ATTESTED_BY_ELIGIBLE_VERIFIER",
    "artifactSha": "08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe",
    "artifactTreeSha": "5f2152ce0cd702b649b93bc23c165d36cb9b9dba",
    "observedCommit": commit,
    "observedTree": tree,
    "overallExitCode": int(overall),
    "steps": steps,
    "report": "NOT_GENERATED_BY_THIS_RUNNER",
    "warning": "Execution output is not independent verification. A separate verifier must establish identity, provenance, findings, and author the required report."
}
pathlib.Path(result_path).write_text(json.dumps(record, indent=2) + "\n")
PY

printf 'results=%s\noverall=%s\n' "$RESULTS" "$OVERALL" | tee -a "$LOG_DIR/runner.txt"
exit "$OVERALL"
