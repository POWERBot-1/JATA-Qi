# R0 — EXECUTABLE BASELINE EVIDENCE RECORD

**Purpose.** Make the canonical baseline MEASURABLE before any R1 change. Every
metric below was produced by ACTUALLY EXECUTING the recorded command in this
environment. No historical claim has been inherited or restated as current
evidence. In particular the historical figure "924/924" is **NOT** reproduced
or asserted here — the executed figure is recorded instead.

R0 modified **no product source code**. This file is verification/evidence
documentation only.

---

## 1. Repository and baseline identity

| Item | Value | Status |
| --- | --- | --- |
| Repository | `POWERBot-1/JATA-Qi` | EXECUTED |
| Canonical baseline SHA | `2b79bdc0183d21d009f79be1fff0722b2ede11ca` | EXECUTED |
| HEAD at R0 time | `2b79bdc0183d21d009f79be1fff0722b2ede11ca` (exact match) | EXECUTED |
| Branch | `arena/01a07ca8-jata-qi` | EXECUTED |
| Working tree at R0 start | clean (`git status --porcelain` produced no output) | EXECUTED |
| Shallow clone | NO — `.git/shallow` is absent | EXECUTED |

Commands:

```
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
git status --porcelain
cat .git/shallow      # absent
```

---

## 2. Environment inventory

| Facility | Result | Status |
| --- | --- | --- |
| Node | `v22.22.3` (repo requires `>=20.0.0`) | EXECUTED |
| npm | `10.9.8` | EXECUTED |
| `node_modules` present before R0 | NO (empty) | EXECUTED |
| Package registry / network | reachable (`npm ping` → PONG, 85 ms) | EXECUTED |
| PostgreSQL — system binaries (`psql`, `pg_ctl`, `postgres`) | NOT PRESENT on PATH | EXECUTED |
| PostgreSQL — **embedded** (`embedded-postgres`, `@embedded-postgres/*`) | PRESENT in `node_modules`, and it is what the suite actually uses | EXECUTED |
| Redis (`redis-server`, `redis-cli`) | NOT PRESENT | ENVIRONMENT-BLOCKED |
| Docker | NOT PRESENT | ENVIRONMENT-BLOCKED |
| Podman | NOT PRESENT | ENVIRONMENT-BLOCKED |

**Redis is explicitly NOT verified.** Per decision D3, Redis is not
authoritative, is not part of R1, and no Redis verification is claimed or
fabricated here. Its unavailability is recorded as ENVIRONMENT-BLOCKED.

---

## 3. Dependency installation

| Item | Value | Status |
| --- | --- | --- |
| Command | `npm ci` (declared lockfile: `package-lock.json`) | EXECUTED |
| Result | SUCCESS — 178 packages added, 229 audited, **0 vulnerabilities** | EXECUTED |
| Duration | ~4 s | EXECUTED |
| Notes | one deprecation warning (`eslint@9.39.5`); npm itself reports a newer major is available | EXECUTED |

---

## 4. PostgreSQL smoke test (run BEFORE the full suite)

The documented embedded-postgres hazard is a **missing `'error'` handler on the
child process**, which can turn a startup failure into an unhandled error event
or an indefinite hang instead of a clean failure.

Handling applied in R0: the baseline run was executed **under an external
timeout guard** (`timeout 2400 …`) in a supervised background process, and the
PostgreSQL-backed workspace (`@jataqi/storage-postgres`) was allowed to run
FIRST in dependency order ahead of the downstream PostgreSQL-dependent suites,
so a hang or a startup fault would surface as a bounded, attributable failure
rather than a stalled run. No product code was modified to achieve this.

| Item | Result | Status |
| --- | --- | --- |
| `@jataqi/storage-postgres` suite | **38 tests / 38 passed / 0 failed / 0 skipped** | EXECUTED |
| Real-PostgreSQL sub-suites observed | `storage-postgres (real PostgreSQL)`, `T-01 tenant isolation (RLS)`, `T-04 transaction/CAS ownership`, `T-05 atomically()`, `T-06 production-path RLS` | EXECUTED |
| Hang / unhandled `'error'` event observed | NONE | EXECUTED |

The embedded PostgreSQL server therefore started, served real SQL, and shut
down cleanly in this environment.

---

## 5. Baseline execution results

All commands run from the repository root at the canonical SHA.

| Metric | Command | Result | Status |
| --- | --- | --- | --- |
| Cold build | `npm run build` | **PASS** (exit 0) | EXECUTED |
| Full test suite | `npm test` | **PASS** (exit 0) | EXECUTED |
| Total tests | aggregated across all 50 workspace suites | **1021** | EXECUTED |
| Passed | — | **1021** | EXECUTED |
| Failed | — | **0** | EXECUTED |
| Skipped | — | **0** | EXECUTED |
| Todo | — | **0** | EXECUTED |
| `not ok` lines in TAP output | — | **0** | EXECUTED |
| Lint | `npm run lint` (eslint) | **PASS** (exit 0) — **0 errors, 60 warnings** | EXECUTED |
| Typecheck | performed by `tsc -p tsconfig.json && tsc -p tsconfig.test.json` in every workspace `build` | **PASS** (exit 0) | EXECUTED |
| PostgreSQL-backed tests | included in `npm test` (embedded PostgreSQL) | **PASS** — 28 distinct "real PostgreSQL" suite executions observed | EXECUTED |
| Integration tests | included in `npm test` (cross-package durable chains, e.g. `T-05 payment → billing → revenue-ledger over real PostgreSQL`, `T-06 multi-process sequence integrity`) | **PASS** | EXECUTED |
| Security / adversarial tests | included in `npm test` (`a01-*`, `s1-*`, `t03-*` boundary suites) | **PASS** | EXECUTED |
| Secret scan | no `gitleaks`/`trufflehog` binary available; no repo-declared secret-scan script exists | **NOT EXECUTED (tooling unavailable)** | ENVIRONMENT-BLOCKED |
| Workspace/lockfile integrity | `npm run check:workspaces` (runs automatically as `prebuild`/`pretest`) | **PASS** | EXECUTED |

**Baseline count note.** The executed total is **1021**, not the historical
"924/924". The historical figure has not been reproduced and is not claimed.

Timestamp of the R0 baseline run: **2026-09-07T16:21–16:24Z**.

---

## 6. Environment limitations (carried into R1)

1. **No system PostgreSQL, Redis, Docker or Podman.** PostgreSQL coverage is
   real but comes from the embedded server bundled in `node_modules`.
2. **Redis: ENVIRONMENT-BLOCKED and out of scope.** Nothing about Redis is
   verified; per D3 it must never become authoritative security state.
3. **Secret scanning: ENVIRONMENT-BLOCKED.** No scanner binary is installed and
   the repository declares no secret-scan script, so no secret-scan result is
   claimed. This remains an open item for the CI/supply-chain milestone.
4. Lint reports **60 warnings** (all `@typescript-eslint/no-unused-vars`). They
   are reported separately from errors and are not gating.

---

## 7. Exact commands used

```
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
git status --porcelain
node -v ; npm -v
command -v psql pg_ctl postgres redis-server redis-cli docker podman
npm ping
timeout 600 npm ci
timeout 2400 npm run build
timeout 2400 npm test
timeout 900  npm run lint
```
