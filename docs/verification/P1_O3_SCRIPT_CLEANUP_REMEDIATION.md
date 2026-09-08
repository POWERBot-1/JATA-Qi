# P1 O-3 script-cleanup follow-up remediation record

| Field | Value |
| --- | --- |
| Authorization | Explicit **O-3 follow-up ONLY** implementation directive (PR #26). P2+/production/120% not authorized. Merge NOT authorized. |
| PR | #26 |
| Base (canonical main) | `ac8926cc88dce4949b3a30f63bc349ad4d50251b` |
| Prior PR head | `870d507935d80bc1cb75a5f266532ffb55aab958` |
| Independent-verification trigger | Verdict **B** — 2 of 18 embedded-PG allocation sites (`scripts/r2-secret-scan.mjs`, `scripts/r2-perf.mjs`) remained uncovered |
| Working branch | `arena/01a08164-jata-qi` |

---

## 1. Original finding

Independent verification of PR #26 established that the repo-wide embedded-PostgreSQL
allocation inventory was **18 sites**, of which the PR covered the 16 under
`packages/*/test` but **not** two under `scripts/`. `npm run scan:r2` independently
left a persistent `jataqi-r2scan-<pid>` data directory (~39 MB) behind. Classification:
operations/test-harness hygiene, not security or fail-closed.

## 2. Exact two uncovered allocation sites

| Site | Cluster-dir prefix | Before |
| --- | --- | --- |
| `scripts/r2-secret-scan.mjs` | `jataqi-r2scan-<pid>` | `persistent:true` dir; `server.stop()` but no dir removal; no cleanup on failure |
| `scripts/r2-perf.mjs` | `jataqi-r2perf-<pid>` | same |

## 3. Root cause

Both scripts allocate an embedded-PostgreSQL cluster into
`path.join(os.tmpdir(), 'jataqi-<label>-<pid>')` with `persistent: true`, which tells
embedded-postgres never to delete the data directory. Each script only called
`server.stop()` (which with `persistent:true` does **not** remove the directory) on the
happy path, and had **no** data-directory removal and **no** failure-path cleanup at all.

## 4. Cleanup design

Confirmed the primitive used by the 16 already-covered test sites (best-effort
`fs.rm(dir, { recursive: true, force: true })` on the harness-owned dir), and reused the
**same pattern** rather than introducing a new mechanism. Because these are single-run
CLI scripts (not test suites with `after()` hooks), the whole PostgreSQL lifecycle is
wrapped in a module-level `try { … } finally { … }`:

- Normal completion → `finally` runs → `driver.close()`, `server.dropDatabase()`,
  `server.stop()`, then `rmSync(databaseDir, { recursive, force })`.
- Boot/runtime failure (any throw inside `try`) → `finally` still runs the same cleanup,
  then the exception propagates → nonzero exit, original error observable.
- No changes to PG config, ports, flags, auth, or any durable/security logic.

## 5. Ownership / safety guarantees

- `databaseDir` is the fully-qualified constant
  `path.join(os.tmpdir(), 'jataqi-r2scan-<pid>')` / `'jataqi-r2perf-<pid>'` — fixed
  prefix + `process.pid`. No user/path input reaches the delete target.
- Delete is scoped exclusively to that single pid-named directory. **No wildcard,
  no parent-directory recursion, no broad `/tmp` cleanup.**
- Guards: no empty path, no `/`, no `/tmp`, no traversal (fixed absolute path),
  no symlink dereference into unrelated trees.
- Concurrency: each invocation owns a pid-unique directory; a concurrent
  `scan`/`perf`/test uses a different `process.pid`, so no process can delete another's
  allocation. Cleanup is tied to the actual allocation owned by the process.

## 6. Normal-shutdown behavior

`scan:r2` and `r2-perf` each: run to completion → `finally` stops the server, drops the
database, and removes the owned data directory. Empirically **0 residual** `jataqi-r2*`
directory after success (see §10).

## 7. Failure-path behavior

Verified with a temporary throwaway copy injecting `throw` immediately after
`server.start()`: both scripts exited **1** (the injected error remained observable on
stderr) and left **0 residual** directory — the partial cluster created before the throw
was removed by `finally`. No silent retry, no skip, no suppression, no `|| true`, no
exit-code weakening: a genuine boot/startup/runtime failure still fails.

## 8. Concurrency / isolation

Unchanged isolation preserved: each process binds a random port in its own range and
owns a `process.pid`-named data dir. Cleanup only ever removes that own pid dir.
No cross-process deletion possible.

## 9. 18-site inventory (independently re-enumerated)

`git grep 'new EmbeddedPostgres('` over tracked `*.ts|*.mjs|*.js` = **18** files:
16 under `packages/*/test` (all covered since PR #26) + **2 under `scripts/`
(`r2-secret-scan.mjs`, `r2-perf.mjs`) now covered by this follow-up.**

Coverage check on the working tree (`rmSync|fs.rm|removeClusterDir|removeOwnedDataDir`
present): **18 / 18 sites covered.**

## 10. Test results / repeated cleanup campaign / disk residue

| Check | Result |
| --- | --- |
| `scan:r2` success | PASS (exit 0), 0 residual |
| `scan:r2` injected boot-failure | exit 1, 0 residual (error observable) |
| `r2-perf` success (reduced + default counts exercised) | exit 0, 0 residual |
| `r2-perf` injected boot-failure | exit 1, 0 residual |
| Repeated campaign (scan ×4 + perf ×4) | **0 residual** `jataqi-r2*` dirs |
| Unrelated `/tmp` safety | decoy `/tmp` file + a foreign `somebody-elses-postgres-data` dir **untouched** |
| Full monorepo suite | **50/50 PASS · 0 fail · 0 skip**, aggregate **1194 tests** |
| Lint | **0 errors, 62 warnings** (baseline) |
| `scan:r2` (final, post-fix) | PASS (0 findings) |

Before this follow-up, a single `scan:r2` left ~39 MB; after, repeated runs leave **0
bytes** of harness-owned PG directory.

## 11. Full regression

Full `npm test` = **50/50 workspaces PASSED · Failed 0 · Skipped 0**; aggregate **1194
tests**, 0 skipped, 0 TODO. No new tests added (test count unchanged from baseline).

## 12. Security preservation

No production `src/` change. No AuthorizationBoundary / RLS / fail-closed / credential /
session / idempotency / rate-limiting / PostgreSQL-authority change. This is purely
filesystem lifecycle hygiene in two command scripts.

## 13. Diff discipline / scope audit

Changed files (this follow-up, base..worktree):

- `scripts/r2-secret-scan.mjs`
- `scripts/r2-perf.mjs`
- `docs/verification/P1_O3_SCRIPT_CLEANUP_REMEDIATION.md` (this record)

No configuration, environment, dependency, lockfile, or production change. The two
script diffs are a structural `try/finally` wrap + an owned-dir removal helper +
`rmSync` import — logic otherwise preserved. No unrelated modification.

## 14. Final remediation status

Both remaining O-3 allocation sites now clean their owned PG directory on success and
on failure; all **18** embedded-PG sites repo-wide are covered; repeated execution
leaves **0** harness-owned orphan PG directories; unrelated `/tmp` content is never
touched; full regression and lint remain green; no production/security semantics change.

**Merge remains NOT authorized.** Committed and pushed to PR #26; next action is a fresh
independent verification of the final PR #26 head. P0 score frozen (9.484375%);
G10/G19 untouched.
