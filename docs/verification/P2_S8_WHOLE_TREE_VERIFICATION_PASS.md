# P2-S8 — Whole-tree verification pass (SAME-AGENT; genuine E4 pending)

| Field | Value |
|---|---|
| Artifact | S8 tree on base `2c1cad0` (exact final SHA: see `P2_S8_IMPLEMENTATION_REPORT.md` §9) |
| Pass class | **SAME-AGENT (PRIMARY at best) — explicitly NOT E4** |
| Spec | §24 P2-S8 ("whole-tree E4 report committed"); §18/§19 (E4 durability) |
| Date | 2026-09-17 (UTC) |

**Read this first.** Per spec §19 rule 4, E4 requires a SEPARATE party on
the EXACT artifact. This pass was performed by the implementing agent in
the implementation session, so it CANNOT be E4 and claims NO E4/E5
credit. It is committed as PRIMARY evidence (exact commands, exact
results, exact artifact) so that (a) nothing is lost to chat transcripts
(the §19 governance defect), and (b) the separate party's genuine
`P2_S8_INDEPENDENT_VERIFICATION.md` has a complete, checkable baseline
to re-execute. **A separate-party independent verification on the exact
final SHA is still REQUIRED before any merge authorization.**

---

## 1. Ordered testing (CI order: build → lint → test)

From the repo root, on the exact artifact:

| Step | Command | Result |
|---|---|---|
| Build (whole tree) | `npm run build` | exit 0, zero `error TS` |
| Lint (whole tree) | `npm run lint` | 0 errors; 61 pre-existing warnings; ZERO in any S8-touched file |
| Test (whole tree, all workspaces) | `npm test` | **Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0** |

## 2. Per-suite assertion table (S8 program on the exact artifact)

Each row re-executed as `node --test dist/test/<file>.js` from the
owning package after a clean build (except the mutation suite, timed
below). "Result" is pass count / total; all suites fail-hard (zero
skips tolerated — any `SKIP` would fail this table).

| Case | Suite | Result |
|---|---|---|
| A-17 restart + kill-9 in tx | `authentication/test/p2-s8-restart-recovery.test.ts` | 4/4 |
| A-18 fan-out contention | `authentication/test/p2-s8-fanout-contention.test.ts` | 5/5 |
| A-19 outage matrix (stores) | `authentication/test/p2-s8-outage-matrix.test.ts` | 3/3 |
| A-19 outage matrix (decisions) | `authorization-boundary/test/p2-s8-decision-outage.test.ts` | 3/3 |
| A-20 failover | `authentication/test/p2-s8-failover.test.ts` | 3/3 |
| A-21 skew matrix | `authentication/test/p2-s8-skew-matrix.test.ts` | 6/6 |
| A-22/A-23 tamper + duplicates | `authentication/test/p2-s8-tamper-duplicates.test.ts` | 11/11 |
| Mutation hygiene gate | `authentication/test/p2-s8-mutation-hygiene.test.ts` | 4/4 |
| P2-S7 mutation (disposable stages) | `authentication/test/p2-s7-mutation.test.ts` | 17/17 (~135 s; 15/15 mutants killed, tracked tree byte-identical after) |

Whole-tree `npm test` result: **Total: 50 · Passed: 50 · Failed: 0 ·
Skipped: 0** (runner's own summary; the nine S8 rows above were
additionally re-executed focused on this exact tree — 4/4, 5/5, 3/3,
3/3, 3/3, 6/6, 11/11, 4/4, 17/17 — all zero-fail, zero-cancelled,
zero-skipped).

## 3. Environment

Linux sandbox; Node (CI-pinned); real PostgreSQL per suite via
embedded-postgres with the merged PR #34 readiness protection and the PR
#36 `r2-pg.ts` remediation (the branch base IS the PR #36 merge).
Fixed suite ports: 61100 (A-17), 61150+ (A-19 stores), 61200+ (A-19
decisions), 61250/61300 (A-20), 61350+ (A-18), 61400 (A-21), 61450
(A-22/A-23).

## 4. Handoff to the separate party

To reproduce: check out the exact final SHA, `npm run build` (expect
exit 0, zero `error TS`), `npm run lint` (expect 0 errors), `npm test`
(expect fully green, zero skips), then the nine focused commands in §2.
Any divergence from the table above is a FINDING — file it against this
pass with observed output; do not adjust expectations to match.
