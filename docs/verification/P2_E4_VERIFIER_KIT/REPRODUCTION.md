# Exact-artifact reproduction instructions

**All expected results must be recorded before execution.** The values in
`EXPECTED_RESULTS.json` are owner-side declared expectations derived from the
existing PRIMARY milestone record. They are not observations and do not
satisfy E4.

## 1. Target and clean checkout

Use a clean clone or a separate detached worktree. Do not run against the
later `main` tree or against this preparation commit as a substitute for the
target.

```sh
TARGET=08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe
TARGET_TREE=5f2152ce0cd702b649b93bc23c165d36cb9b9dba

git fetch --no-tags origin "$TARGET"
git worktree add --detach /path/to/p2-e4-worktree "$TARGET"
cd /path/to/p2-e4-worktree

test "$(git rev-parse HEAD)" = "$TARGET"
test "$(git rev-parse HEAD^{tree})" = "$TARGET_TREE"
test -z "$(git status --porcelain)"
```

If the remote does not expose the SHA to `git fetch`, obtain the public commit
through an independently controlled clone or archive, then verify the commit
and tree IDs before continuing. Never silently substitute a later commit.

Record:

```sh
git show -s --format=fuller "$TARGET"
git status --porcelain=v1
node --version
npm --version
uname -a
```

## 2. Ordered deterministic sequence

The verifier records the expected result before each step and preserves the
complete stdout/stderr and exit code.

1. clean checkout and exact SHA/tree verification;
2. Node/npm version and host/environment manifest;
3. `npm ci --no-audit --no-fund`;
4. `npm run check:workspaces`;
5. `npm run build`;
6. `npm run lint`;
7. whole-tree `npm test`;
8. focused P2-S8 suites A-17 through A-23;
9. mutation-hygiene gate;
10. disposable P2-S7 mutation suite;
11. negative/failure-injection assertions described in the matrix;
12. final tracked-tree, commit, tree, and hash verification;
13. machine-readable result/evidence manifest generation.

A command failure, unexpected pass/fail count, skip, missing log, changed
expectation, or target-tree mutation is a FINDING. Do not edit the expectation
to manufacture a PASS.

## 3. Focused commands

Run each from the owning package after the clean whole-tree build. The
commands below use generated `dist` output and are intentionally explicit.

```sh
(
  cd packages/authentication &&
  node --test dist/test/p2-s8-restart-recovery.test.js
)
(
  cd packages/authentication &&
  node --test dist/test/p2-s8-fanout-contention.test.js
)
(
  cd packages/authentication &&
  node --test dist/test/p2-s8-outage-matrix.test.js
)
(
  cd packages/authorization-boundary &&
  node --test dist/test/p2-s8-decision-outage.test.js
)
(
  cd packages/authentication &&
  node --test dist/test/p2-s8-failover.test.js
)
(
  cd packages/authentication &&
  node --test dist/test/p2-s8-skew-matrix.test.js
)
(
  cd packages/authentication &&
  node --test dist/test/p2-s8-tamper-duplicates.test.js
)
(
  cd packages/authentication &&
  node --test dist/test/p2-s8-mutation-hygiene.test.js
)
(
  cd packages/authentication &&
  node --test dist/test/p2-s7-mutation.test.js
)
```

The repository CI workflow's order and PostgreSQL skip detector remain
applicable. A green process exit is not sufficient if a suite reports SKIP or
if PostgreSQL integration did not execute.

## 4. Exact artifact/hash checks after execution

After all commands, from the target worktree:

```sh
test "$(git rev-parse HEAD)" = "$TARGET"
test "$(git rev-parse HEAD^{tree})" = "$TARGET_TREE"
test -z "$(git status --porcelain)"
git diff --exit-code -- .
git ls-tree -r "$TARGET" > artifact-tree-observed.txt
sha256sum artifact-tree-observed.txt
```

The verifier must compare the observed inventory to
`artifact-tree-manifest.json`, record the comparison method and hashes, and
retain the raw command output. Build products and `node_modules` are expected
working artifacts and must not be confused with tracked-tree changes.

## 5. No unsafe mutation

The P2-S7 mutation suite is expected to stage disposable copies under a
 temporary directory. It must not mutate the tracked source tree. The
mutation-hygiene suite and final tree/hash check are required controls. Do not
run an ad-hoc mutation against the target worktree. If the disposable-stage
contract fails, retain the failure and report it.

## 6. Evidence boundaries

Existing `P2_S8_IMPLEMENTATION_REPORT.md` and
`P2_S8_WHOLE_TREE_VERIFICATION_PASS.md` are owner/implementer PRIMARY
baseline material. They may guide reproduction, but they are not the future
verifier's findings and cannot be copied as a verdict. The owner-side kit,
its expected-results file, CI metadata, and any owner-side execution are also
not E4.
