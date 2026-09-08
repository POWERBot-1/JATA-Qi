# P1 REMEDIATION V1/V2 — verification-findings remediation record

| Field | Value |
| --- | --- |
| Authorization | Explicit P1 verification-remediation directive (2026-09-08): **V-1 and V-2 ONLY**; commit/push/PR-update authorized; merge NOT authorized; production NOT authorized; P2+ NOT authorized |
| Remediated branch | `arena/01a07f88-jata-qi` (implementation head before remediation: `cf232361a5b3da24441135f83f5ee1eae99b347e`) |
| Parent of implementation chain | `10fc9baffbc432eb1ec92cec9cd1f4c86d810a64` (= canonical `main`, verified unchanged) |
| Baseline verification before changes (§7) | HEAD = `cf23236`; merge-base with `main` = `10fc9ba`; working tree clean except the untracked independent-verification report `JATA_QI_P1_INDEPENDENT_VERIFICATION.md` (prior read-only verification deliverable, deliberately left uncommitted — committing it was not part of the V-1/V-2 authorization) |
| Environment | 2 vCPU sandbox, Node v22.22.3, Linux; embedded PostgreSQL via `embedded-postgres@18.4.0-beta.17` |
| Score | **FROZEN at 9.484375%** — no P1 credit claimed or awarded by this remediation |
| G10 / G19 | OPEN (unattributable) / UNRECOVERED — untouched by this remediation |

---

## V-1 — Evidence-document test-count correction — **RESOLVED**

### Original inconsistency

The implementation evidence reported, in four places, a full-suite result of
"1193/1193 pass" and "42 new P1 tests" (evidence doc summary row, §5 results
table, §1 sweep reference, §6 governance reference; adversarial-matrix header;
PR #25 body bullet list). The PR body's own per-file breakdown
(19 + 5 + 6 + 9 + 4) already summed to **43**, not 42.

### Authoritative observed count (evidence sources, all re-executed 2026-09-08)

1. **Per-file standalone counts** on the `cf23236` artifact:
   `node --test dist/test/<file>` → `p1-posture` 19, `p1-posture-pg` 5,
   `p1-rls-probe` 6, `p1-manifest-lifetime` 9, `p1-auth-factory` 4
   = **43 new P1 tests** (all green, 0 skipped).
2. **Clean-room baseline** at canonical `10fc9ba` (git archive + fresh
   `npm ci` + build): `npm test` ×2 → **242 suites / 1151 tests**, green both
   runs (recorded in the independent verification; not re-derived here).
3. **Full-sweep aggregation** on `cf23236` (fresh run 2026-09-08 10:20–10:25
   UTC, exit 0): `npm test` → 50/50 workspaces, **249 suites / 1194 tests /
   1194 pass / 0 fail / 0 skipped / 0 todo**.
4. Arithmetic: 1151 + 43 = **1194**.

**Authoritative count: 43 new P1 tests / 1194 total tests / 249 suites; a green
sweep is 1194/1194.** The original "1193/1193 with 42 new" was an undercount of
exactly one (the green-run status itself is reproducible; only the count was
wrong). No test was added, removed, or modified to make counts match (the V-2
stabilization below changes no test count — 1194 total before and after).

### Corrected references

| Location | Correction |
| --- | --- |
| `docs/verification/P1_IMPLEMENTATION_EVIDENCE.md` — summary row | 1194 tests / 1194/1194 / 43 new (with per-file breakdown) + V-1 correction note quoting the original figures |
| `docs/verification/P1_IMPLEMENTATION_EVIDENCE.md` — §1 sweep reference | 1194/1194 sweep |
| `docs/verification/P1_IMPLEMENTATION_EVIDENCE.md` — §S9 suite count | 43 tests (originally 42) |
| `docs/verification/P1_IMPLEMENTATION_EVIDENCE.md` — §5 results table | 1194 tests / 1194 pass + correction note |
| `docs/verification/P1_IMPLEMENTATION_EVIDENCE.md` — §6 governance note | 1194/1194 (V-1-corrected count) |
| `docs/verification/p1-adversarial-matrix.md` — header | 1194/1194, 0 skipped + V-1 note |
| PR #25 body | "43 tests" + "1194 tests — 1194/1194 … baseline 1151 + 43 new" + correction note |

Historical records that are correct as written were **not** touched
(`R2_IMPLEMENTATION_EVIDENCE.md` 1151/1151 at PR #24 head; the P1 evidence
doc's own baseline row; the readiness spec's 242/1151 reference). The original
"1193/1193" figures remain visible only inside the correction notes as quoted
history, per the no-retrospective-alteration requirement.

**Status: RESOLVED** (documentation corrected to the exact reproducible count;
provenance recorded above).

---

## V-2 — Pre-existing flaky 32-process rate-window test — **RESOLVED**

### Investigation (§3 — causation established before any code change)

Test: `packages/authorization-boundary/test/r2-multiprocess-restart.test.ts`,
subtest "shares one durable rate window across 32 separate processes (exactly
max ALLOW)". 32 real worker OS processes (`r2-two-process-worker.mjs`, execFile)
each render a durable decision with their own wall clock; the S-6 rate limiter
buckets each decision into the epoch-anchored fixed window
`floor(now / 60 000)`.

**Exact failure mode** (from the independent verification and reproduced below):
`AssertionError: Expected values to be strictly equal: 10 !== 5`
(`allows.length` 10 vs expected 5), subtest duration ~2.1–3.1 s.

**Measured burst geometry** (instrumented copies of the real test/worker placed
only in gitignored `dist/`, since deleted; plus a mirror harness):
launch → subtest-3 start ≈ 1.42 s; first decide ≈ subtest start + 1.2 s; last
decide ≈ subtest start + 2.6 s; decide spread 1.11–1.42 s idle; whole subtest
≤ 3.1 s under full-suite load. Straddle-eligible launch offsets: in-minute
~[56.0, 57.4] s (boundary at launch + 2.6…4.0 s).

**Reproduction record** (all 2026-09-08, 2 vCPU):

| Campaign | Condition | Result |
| --- | --- | --- |
| Full suite (verification pass, pre-fix) | natural timing | 2 FAIL / 4 PASS (`10 !== 5`); failures were consecutive runs |
| Standalone natural campaign (pre-fix) | 20 runs | 19 pass / 1 fail — failure at launch offset **56.64 s**, `10 !== 5` (exactly the predicted straddle zone) |
| Adversarial-timed launch (pre-fix, PR build) | offsets 56.58 / 56.88 | **2/2 FAIL `10 !== 5`** (deterministic on demand) |
| Adversarial-timed launch (pre-fix, instrumented copy) | same offsets | 2/2 FAIL with `distinctWindows: 2`, `allows: 10` — the 32 decisions split across two windows, **5 allows in each** |
| Adversarial-timed launch (**baseline `10fc9ba`** clean-room build) | same offsets | **2/2 FAIL `10 !== 5`** — pre-existence at canonical main proven on demand |
| Deterministic clock probe (independent verification) | anchored 1.5 s pre-boundary | window A: 5 allows (6th DENY); window B: 5 allows (6th DENY) — combined 10 in 2 s |

**Root-cause classification: D — timing-sensitive test instability**
(the test's implicit precondition — all 32 decisions in one fixed window — is
violated when the burst straddles an epoch-minute boundary; the limiter then
correctly admits max in EACH window), **pre-existing at canonical `10fc9ba`**
(entire execution path byte-identical to the PR: empty diff across
consumption-stores/durable-decider/gate/policy-engine/capability-manifests and
the test/worker/fixtures/harness files; plus the on-demand baseline
reproduction above), **aggravated by C — resource contention** in full-suite
runs on 2 vCPU (wider burst, and back-to-back ~5-minute suites can phase-lock
to minute boundaries). **NOT a product defect**: per-window enforcement is
exact in every experiment (CAS-convergent counters; 5 per window, never more);
the boundary reset is documented R2 fixed-window semantics.

### Remediation (test-only; smallest change that removes the false failure)

`packages/authorization-boundary/test/r2-multiprocess-restart.test.ts` —
immediately before spawning the 32 workers, align the burst to a fresh fixed
window: if the current 60 s window has less than `ALIGNMENT_MARGIN_MS`
(15 000 ms) remaining, wait until just past the boundary
(`setTimeout(remaining + 100)`).

Justification with measured evidence: worst observed burst/subtest duration is
3.1 s under load (median 2.4 s, p95 2.8 s, max 3.1 s across campaigns); the
15 s margin is ~5× the worst observed burst. A post-alignment straddle would
require a > 15 s burst — never observed under any condition. The wait occurs in
~25% of runs (in-minute offset < 15 s before a boundary when subtest 3 starts),
averaging ~7.5 s when it fires, bounded at 15.1 s.

What the stabilization does NOT do (per the remediation rules): no assertion
weakened or suppressed (still exactly 5 ALLOW / 27 DENY); no process-count
reduction (still 32 OS processes); no coverage reduction; no retry that could
mask a real failure; no arbitrary sleep as a correctness substitute (the sleep
enforces the test's own stated precondition — "shares ONE durable rate window"
— instead of hoping for it); no test disabling or flaky-marking; no production
code touched (rate limiting, fixed-window semantics, atomicity, PostgreSQL
authority, tenant isolation, replay, idempotency, durable state, fail-closed
behavior all unchanged — the entire `src/` tree is byte-identical to `cf23236`).

### Post-fix verification (§9 — repetition campaigns)

| Campaign | Runs | Result |
| --- | --- | --- |
| Adversarial zone sweep (real test; offsets 56.0/56.3/56.6/56.9/57.2/57.5 — the entire previously-failing zone) | 6 | **6/6 PASS** (subtest durations 3.4–5.3 s show the alignment wait firing, burst completing inside the fresh window) |
| Adversarial mechanism proof (instrumented fixed copy; offsets 56.6/56.9) | 2 | **2/2 PASS** with `distinctWindows: 1`, `allows: 5` (previously `2`/`10` at the same offsets) |
| Natural standalone campaign | 30 | 29 pass + 1 failure that is **not** the straddle (see O-2 below: embedded-PG boot `ECONNREFUSED` in the before-hook; subtest never ran) — **0 straddle failures**; alignment wait observed in 6/30 runs (max subtest 17.1 s) |
| Diagnostic standalone campaign | 12 | 11 clean + 1 O-2 boot failure — **0 straddle failures** |
| Full suite | 4 | **0 straddle occurrences** (pre-fix: 2 in 4); results otherwise per O-1 below |
| r2mp file standalone (post-restore sanity) | 1 | 4/4 |

**Security impact: none.** The change is confined to one test file; the
production rate limiter and all durable security semantics are untouched
(byte-identical `src/`); the assertion now verifies the intended invariant
without a timing-dependent false-failure mode.

**Status: RESOLVED** (deterministic on-demand reproduction eliminated at the
same adversarial timings; 0 straddle failures across 55 post-fix real-test
executions: 30 + 12 + 6 + 2 instrumented + 4 full-suite + 1 sanity).

---

## New out-of-scope findings discovered during remediation (documented, NOT remediated)

These are **outside the V-1/V-2 authorization** and are recorded for a separate
authorization decision. Neither was caused by the P1 implementation or by this
remediation (execution paths byte-identical at `10fc9ba`; reproduced on the
baseline build).

- **O-1 (test-design race, pre-existing): `r2-enforcement.test.ts` subtest
  "conflicts a duplicate key while the first attempt holds a live lease" is
  order-sensitive.** It starts `executeAuthorized(first)` unawaited and
  immediately asserts that `executeAuthorized(second)` is rejected with
  `IDEMPOTENCY_CONFLICT`; under contention either transaction can win the
  lease. Two failure signatures, same root: `Missing expected rejection`
  (second won) or the awaited first rejecting with `IDEMPOTENCY_CONFLICT`
  (first lost). Reproductions (all 2026-09-08): standalone PR build 4/15 and
  4/10 (with 5 s spacing); **standalone baseline `10fc9ba` 8/15**; full-suite:
  green in all ~6 verification-era runs, but 2 of 4 post-fix full-suite runs
  and 1 of 2 pre-fix A/B full-suite runs under current machine state (a
  pre-fix A/B under identical conditions proves the remediation did not cause
  the shift). Compiled test + `gate.js` + `durable-decider.js` byte-identical
  between baseline and PR. **Recommended remediation (future authorization):**
  make the test deterministic — await positive evidence that the first attempt
  holds the lease (e.g., a side-effect-entered signal set before its await,
  proving the lease committed) before starting the second attempt.
  **Classification: ENVIRONMENTAL trigger of a pre-existing test race;
  REQUIRES FURTHER WORK (separate authorization). Not a P1 regression.**
- **O-2 (harness/environment flake, pre-existing): embedded-PostgreSQL boot
  `ECONNREFUSED`** in `before()` hooks (observed 2/42 rapid campaign runs;
  port 58602 = within the randomized range; all subtests cancelled with
  "test did not finish before its parent"). The harness code (`r2-pg.ts`,
  `p1-pg.ts`) is untouched by the PR and identical at `10fc9ba`. Benign pacing
  in full-suite and CI runs (no occurrence in any full-suite run). Causes a
  loudly failing suite (false-FAIL), never a false-PASS.
  **Classification: ENVIRONMENTAL; REQUIRES FURTHER WORK only if campaigns
  like these become routine (boot retry with backoff in the harness).**
- **O-3 (ops hygiene): `/tmp` accumulation of embedded-PG data directories**
  (~50 MB per PG-booting suite run; `persistent: true`, pid-based directory
  names, never cleaned). During this remediation, 439 accumulated dirs
  exhausted the 21 GB sandbox disk (100%), which initially produced 2 spurious
  campaign failures (classified ENVIRONMENT; re-run clean after cleanup).
  Recommend an ops note or harness cleanup for long-lived dev boxes; CI runners
  are unaffected (ephemeral). **Classification: ENVIRONMENTAL; no code change
  made (out of scope).**

---

## Required test battery (§8) — exact results, honestly reported

| Check | Command / method | Result (2026-09-08) |
| --- | --- | --- |
| Build | `npm run build` (full, after remediation) | 50/50 workspaces, 0 TS errors |
| Full test suite | `npm test` ×4 post-fix | **Run 1: 49/50 — 249 suites, 1194 tests, 1193 pass / 1 fail (O-1 r2-enforcement)**; **Run 2: 50/50 — 249 suites, 1194 tests, 1194/1194, 0 fail/skipped/todo (exit 0)**; Runs 3–4: 49/50, single O-1 failure each. **Zero rate-window (V-2) occurrences in all four runs.** Pre-fix A/B under identical machine state: 1× O-1 failure, 1× green (1194/1194) — attribution: O-1 is the pre-existing race of a different, unmodified test; see O-1 for the byte-identity and baseline-reproduction proofs |
| P1 security suites standalone | `node --test` per file | posture 19/19 · posture-pg 5/5 · rls-probe 6/6 · manifest-lifetime 9/9 · auth-factory 4/4 (43/43, 0 skipped) |
| V-2 affected test | campaigns above | adversarial zone 6/6; mechanism 2/2; 0 straddle failures in 55 executions |
| Concurrency tests | r2mp file + full-suite sweeps | r2mp 4/4 standalone; 8-process exactly-once and all other R2 concurrency subtests green in every full-suite run |
| Lint | `npm run lint` | **0 errors, 62 warnings** (identical to pre-remediation baseline) |
| R2 security scan | `npm run scan:r2` | **PASS — 8 static files, 13 dump rows, 0 findings** (tracked `r2-secret-scan.json` restored to its committed state afterward; the re-run result is recorded here instead of committing a timestamp-only artifact change, keeping the remediation diff scoped) |
| Diff discipline | `git diff cf23236..HEAD` inspected in full | only authorized files changed (see below); no secrets; no test suppression; no lint suppression; no configuration weakening; no security bypass; no hidden fallback; no unrelated refactor |

### Full-suite distribution summary (this box, 2026-09-08)

- Pre-fix full-suite (same machine state, A/B): 1 green (1194/1194) + 1 O-1 failure.
- Post-fix full-suite: 1 green (1194/1194) + 3 O-1 failures; **0 V-2 failures**.
- Verification-era full-suite (pre-fix, earlier machine state): 2 V-2 failures + 4 green (incl. 1 green at 1194/1194 counted fresh); r2-enforcement green in all.
- Canonical CI: PR #25 head `cf23236` run 34204484319 SUCCESS (pre-remediation). The remediation push triggers a new canonical CI run on the new head; that result is the canonical determination for the remediation commit (and does not close G10).

---

## Diff summary (§10)

Authorized changes only:

| File | Change | Commit |
| --- | --- | --- |
| `packages/authorization-boundary/test/r2-multiprocess-restart.test.ts` | V-2 stabilization: window-alignment of the 32-worker burst (+24 lines incl. rationale comment; 0 deletions; assertions/process count unchanged) | V-2 commit |
| `docs/verification/P1_IMPLEMENTATION_EVIDENCE.md` | V-1: four count corrections + two correction notes (historical figures preserved as quoted history) | V-1 commit |
| `docs/verification/p1-adversarial-matrix.md` | V-1: header count correction + note | V-1 commit |
| `docs/verification/P1_REMEDIATION_V1_V2.md` | this record | report commit |

No other files changed. The untracked `JATA_QI_P1_INDEPENDENT_VERIFICATION.md`
(prior verification deliverable) remains uncommitted by design.

## Governance state after remediation (§13/§14)

- Governance position: REMEDIATION COMPLETE → **INDEPENDENT RE-VERIFICATION
  (required next, by a separate verifier determination)** → STOP → AWAIT
  EXPLICIT MERGE AUTHORIZATION. **Merge NOT authorized.**
- History preserved: `80172a4` → `071cb74` → `cf23236` → remediation commits
  (no squash, no rebase, no force-push; canonical `main` untouched at `10fc9ba`).
- Score frozen at 9.484375%; no credit claimed. G10 OPEN (unattributable);
  G19 UNRECOVERED. Local results (including the green 1194/1194 sweeps) are
  not canonical-CI determinations.
- For the independent re-verifier: V-1 and V-2 statuses above are
  self-reported and require independent confirmation; O-1/O-2/O-3 are
  newly documented out-of-scope findings that did not exist in the
  verification report and warrant fresh classification.
