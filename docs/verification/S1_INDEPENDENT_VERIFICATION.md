# S-1 Independent Verification — Evidence Record

**RECONSTRUCTION — ORIGINAL REPORT NOT RECOVERABLE**

Durable evidence record for the independent read-only verification of milestone **S-1** (tenant
boundary hardening — fail-closed tenant context at the data plane). The S-1 verification report was
written to an agent-side directory (`verification-s1/S1-INDEPENDENT-VERIFICATION-REPORT.md`, 16
items + 82-probe results) and was **never committed**. Its contents now survive only as citations in
committed records and in the preserved session record; the report file itself is not recoverable in
the current environment. This record is created by the **R-2** evidence-durability execution
(2026-09-07, documentation-only).

| Field | Value |
| --- | --- |
| Document type | Independent-verification evidence record (reconstruction) |
| Scope | Read-only verification of S-1 tenant-boundary hardening at the authoritative service/vector/graph/tool/CLI boundaries (B-1…B-4, V-1/V-2, B-5/V-4 fixes; B-6/B-7 determinations) |
| Repository / branch (subject) | `POWERBot-1/JATA-Qi` · `arena/01a076d2-jata-qi` (PR #20) |
| Baseline SHA | `c45cfc1e32dca28916a5c343dc457bfc3b379ea5` (R-1+R-4 verified head) |
| Tested/verified SHA | `121eaa425c698ffa725fbc26df7a6e685dc45796` (S-1; original commit object `c2d13e4` lost to sandbox recreation, recreated content-identical as `121eaa4`) |
| Verified result (preserved) | **924/924 tests pass · 82/82 adversarial probes pass** · CI run `34065442942` success |
| R-2 record branch / HEAD | `arena/01a07b19-jata-qi` · `700ae8000ee9303bf1ea6289d0eab90085ffb597` |
| Surviving sibling records | `docs/S01_TENANT_BOUNDARY_HARDENING.md` (committed `121eaa4`), `docs/T09_F_REGISTER_RECONSTRUCTION.md` §9 (committed `8fc13ee`), PR #20 body (S-1 section), GitHub Actions records |

---

## 1. Provenance classification vocabulary

Material facts below carry one of: **CONTEMPORANEOUS** (directly preserved original evidence —
committed milestone documents, PR #20 body/comments, git history, Actions run records),
**INDEPENDENTLY RE-EXECUTED** (freshly reproduced in this repository during R-2),
**RECONSTRUCTED** (derived from surviving records; source stated), **SESSION-RECORDED** (present in
the preserved session record), **UNAVAILABLE/LOST** (not recoverable).

## 2. The verified commit and its content

Milestone S-1 was implemented at `121eaa4` (author `POWERBot-1`, 2026-09-06T22:55:59Z, parent
`c45cfc1`). **(CONTEMPORANEOUS — git history.)** Its commit diff (`c45cfc1..121eaa4`) is **25
files, +2752 / −149** confined to `packages/{knowledge-service,vector-search,knowledge-graph,
agent-runtime,cli}`, `docs/S01_TENANT_BOUNDARY_HARDENING.md`, `README.md`, and `.env.example`
**(CONTEMPORANEOUS — git diffstat)**. Content highlights (from the committed milestone document and
PR #20 body):

- B-1: new `knowledge-service/src/tenant-context.ts` guard applied to all six tenant-bound
  operations; the tenantless global `stats()` branch deleted; `retrieve()` pushes the tenant into
  the vector layer; `deleteDocument` mutates nothing across tenants; `vector-search` strict local
  guard on both search paths; all five `agent-runtime` tenant-bound tools fail closed.
- B-2: `get store()` getter and the ambient `graph.store` container registration removed.
- B-3: `row.tenantId ?? DEFAULT_TENANT_ID` removed; untagged durable rows quarantined
  (non-destructive, verbatim re-emit), with explicit operator attribution option.
- V-1: exported `authorizeDocumentIngestedEvent(envelope)`; forged/mismatched/tenantless/`system`
  /foreign-`docId`/replayed events refused and audited; graph-RAG resolves the tenant before any
  vector lookup.
- V-2, B-4, B-5/V-4: CLI re-attribute-and-drop defence-in-depth; `host-inspect` operator-tenant
  resolution before kernel boot (`?? 'default'` deleted); README contract section and `.env.example`
  no longer ship the refused `JATAQI_OPERATOR_TENANT=default`.
- **6 new adversarial suites, 84 cases** in `packages/*/test/s1-*.test.ts` (knowledge-service 9,
  vector-search 6, knowledge-graph B-2/B-3 9, knowledge-graph V-1 13, agent-runtime 37, cli 10).
- **No test case deleted** (`it()` counts identical 19/19, 19/19, 4/4); assertion counts rose
  (CLI 92→95, PG T-06 110→113). No fallback flag restored or added. No storage-postgres/RLS,
  authentication, core-kernel, CI, manifest, or lockfile change.

**(All CONTEMPORANEOUS — committed `docs/S01_TENANT_BOUNDARY_HARDENING.md` and preserved PR #20
body, S-1 section.)**

## 3. Preserved S-1 regression evidence (delivery session, run twice)

**(CONTEMPORANEOUS — committed `docs/S01_TENANT_BOUNDARY_HARDENING.md` §8.1/§8.4; identical results
before and after a sandbox recreation.)**

| Gate | Result |
| --- | --- |
| Build (clean, all `packages/*/dist` removed) | `npm run build` — exit 0, 0 TypeScript errors |
| Lint | `npm run lint` — exit 0, 0 errors, 60 warnings (all pre-existing style warnings) |
| Tests | `npm test` — exit 0; `Total: 49 · Passed: 49 · Failed: 0 · Skipped: 0`; **924 tests · 924 pass · 0 fail · 0 skipped** |
| PostgreSQL honesty gate | `grep -ci 'SKIPPED: PostgreSQL integration'` = **0** — the PostgreSQL suites genuinely executed (embedded PostgreSQL really started) |

**CI evidence (CONTEMPORANEOUS — GitHub Actions API, read during R-2):** run **`34065442942`** at
head `121eaa4` — conclusion **success** (all 9 steps; `Total: 49 · Passed: 49 · Failed: 0 ·
Skipped: 0`; PostgreSQL executed, no SKIP — per the committed F-register §6.2).

## 4. The independent verification cycle (the subject of this record)

**(RECONSTRUCTED — the only surviving citations are the committed F-register §9 and the session
record; the report itself is UNAVAILABLE/LOST.)** After S-1 was pushed, a fresh independent
read-only verification was performed (fresh clone, independently derived evidence, per the stop
condition recorded in the S-1 milestone document §8.5). The preserved citations state:

- The agent-side report was `verification-s1/S1-INDEPENDENT-VERIFICATION-REPORT.md`, containing
  **16 items + 82-probe results** (F-register §9). **(RECONSTRUCTED — source: `docs/
  T09_F_REGISTER_RECONSTRUCTION.md` §9, committed `8fc13ee`.)**
- The verification passed **82/82 adversarial probes and 924/924 tests** (F-register §4.1 caveat,
  §9). **(RECONSTRUCTED — same source; the R-2 directive states the same figures —
  SESSION-RECORDED agreement.)**
- The S-1 commit object `c2d13e4` was destroyed by a sandbox recreation and recreated with
  identical content as `121eaa4`; the full clean regression was re-run on the restored tree with
  identical results, and the diffstat of the restored staging (25 files) matched. **(CONTEMPORANEOUS —
  committed S-1 doc §8.4.)**

**What the reconstruction certifies and what it cannot:** the S-1 *verification's* passing result
is preserved only by citation; the probe enumeration (82 items) and the 16-item checklist are
**UNAVAILABLE/LOST** and are not mechanically reconcilable from committed evidence. Separately, the
S-1 *implementation* evidence (924/924, PostgreSQL-executed, CI green, suite-by-suite) is fully
committed and remains re-runnable — and the merged tree containing the identical code is
re-executed in `PR20_MERGE_POSTMERGE_VERIFICATION.md`.

## 5. B-6 / B-7 determinations (report-only findings from the same cycle)

**(CONTEMPORANEOUS — committed S-1 doc §8.2/§8.3, quoting the primary evidence.)**

- **B-6 resolved:** the "Node 24 in CI" banner is GitHub's *platform* action runtime; the
  repository's own build/lint/test steps ran on Node v20.20.2 (setup-node pinned `20`), verified
  from the CI job log of run `34048251273` (job `101527091000`). No repository-side mismatch.
- **B-7 determined:** the active ruleset (`20134880`, "Jata Qi", targeting `refs/heads/main`) has
  **no** `required_status_checks` rule — CI is advisory, never a gate; merging while red is
  technically possible (PR #19 merged 13 minutes after a red run). Merge decisions must therefore
  be explicit and authorized. **Governance consequence preserved for the merge record.** (Current
  ruleset state at the R-2 date was not re-read during R-2.)

## 6. Standing context (explicitly preserved)

S-1 fixed the B-1…B-4 / V-1 / V-2 / B-5(V-4) classes it was chartered to fix and reduced the F-6
blast radius (see `T09_INDEPENDENT_VERIFICATION.md` §5), but it did **not** close the standing
security programme: agent/tool authorization beyond the tenant boundary, prompt-injection
resistance, sandbox containment, full cross-tenant AI/RAG/vector/cache isolation, ATO resistance,
SSO/OIDC/SAML, ABAC/ReBAC/PAM, secrets isolation, supply chain, network boundaries,
autonomous-action controls, abuse/rate limiting, auditability, incident response, production
hardening, and the production gates of L-8 remain open. F-1…F-5, F-7 and F-8 of the lost T-09
register remain **unrecoverable**. **(RECONSTRUCTED — sources: PR comment `5560777167`; committed
F-register; committed S-1 doc.)** This record does not assert that S-1 (or R-2) proves JATA Qi
production-ready or fully hardened.

## 7. Limitations of this record / unrecoverable evidence

- **UNAVAILABLE/LOST:** `verification-s1/S1-INDEPENDENT-VERIFICATION-REPORT.md` (agent-side,
  uncommitted; not present in the current environment); the 16-item checklist; the 82-probe
  enumeration and per-probe evidence.
- **RECONSTRUCTED:** the independent-cycle results above, from the citations in the committed
  F-register and the session record.
- **INDEPENDENTLY RE-EXECUTED (none for this record):** `121eaa4` is not the current HEAD; its
  product code is preserved verbatim in canonical `main` (tree `121eaa4` + one documentation file =
  merged tree; see `PR20_MERGE_POSTMERGE_VERIFICATION.md` §2), where the current R-2 execution
  re-runs the gates.

## 8. Sources of reconstruction (exact)

1. `docs/S01_TENANT_BOUNDARY_HARDENING.md` @ `121eaa4` (implementation record, §8 regression, B-6/B-7, §8.4 provenance).
2. `docs/T09_F_REGISTER_RECONSTRUCTION.md` @ `8fc13ee` (§4.1 caveat, §6.2, §9).
3. PR #20 body (S-1 section) — preserved on GitHub, read via API.
4. GitHub Actions run `34065442942` — read via API.
5. Git history: `git diff --stat c45cfc1 121eaa4`; commit metadata.
