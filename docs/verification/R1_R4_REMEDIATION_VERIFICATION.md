# R-1 + R-4 Remediation — Verification Evidence Record

Durable evidence record for the verification of the **R-1 (CI-gate remediation, test-only)** and
**R-4 (CLI tenant boundary, production)** work delivered on PR #20. Unlike the T-09 and S-1
verification reports, the R-1/R-4 verification results were posted to the PR #20 body and issue
comments on GitHub and therefore survive as primary preserved evidence; this record makes them
durable in-repository. Created by the **R-2** evidence-durability execution (2026-09-07,
documentation-only).

| Field | Value |
| --- | --- |
| Document type | Remediation verification evidence record |
| Scope | R-1: fix the two red workspaces caused by the T-08.1 K1 tightening (test-only). R-4: tenant isolation at the CLI boundary (production defect, pre-existing) |
| Repository / branch (subject) | `POWERBot-1/JATA-Qi` · `arena/01a076d2-jata-qi` (PR #20) |
| Baseline SHA | `0cb6b6bd0aaf98e75cf1d71d7adb7f2564f65786` (T-09; 821 tests / 819 pass / 2 fail) |
| Tested/verified SHA | `c45cfc1e32dca28916a5c343dc457bfc3b379ea5` (R-1+R-4 commit; first version `c1f9e47`, amended) |
| Verified result | **840 tests · 840 pass · 0 fail · 0 skipped**; independent read-only verdict **PASS WITH NON-BLOCKING FINDINGS** |
| R-2 record branch / HEAD | `arena/01a07b19-jata-qi` · `700ae8000ee9303bf1ea6289d0eab90085ffb597` |
| Primary surviving sources | PR #20 body; PR issue comments `5560777167` (2026-09-06T17:03:54Z) and `5560923476` (2026-09-06T17:29:38Z); git history; GitHub Actions run records |

---

## 1. Provenance classification vocabulary

Material facts below carry one of: **CONTEMPORANEOUS** (directly preserved original evidence —
PR #20 body/comments, git history, Actions run records), **INDEPENDENTLY RE-EXECUTED** (freshly
reproduced in this repository during R-2), **RECONSTRUCTED** (derived from surviving records;
source stated), **SESSION-RECORDED** (present in the preserved session record), **UNAVAILABLE/LOST**
(not recoverable).

## 2. What R-1 + R-4 were, and what was verified

**(CONTEMPORANEOUS — PR issue comment `5560777167`; git history.)** After the T-09 CI-gate
investigation, the two red workspaces (`@jataqi/agent-runtime`, `@jataqi/cli`) were traced to the
T-08.1 "K1 explicit allow only" change (`d221f65`, merged in PR #19): two **transitive consumer
tests** still called `ingestText()` with no `tenantId` and were correctly failed closed. The
remediation was delivered as one isolated, self-contained commit on the PR #20 branch (first
version `c1f9e47`, then amended — documentation added — to `c45cfc1`):

- **R-1 (test-only):** the two tests now declare an explicit tenant and assert the tenant really
  scoped the write/read path. No fallback env flag is set anywhere; assertions were added, none
  removed; the T-08.1 K1 guard stays armed.
- **R-4 (production, `packages/cli`):** new `packages/cli/src/knowledge-command.ts` boundary —
  operator tenant from `JATAQI_OPERATOR_TENANT` (deployment configuration, never argv alone);
  `--tenant` is a consistency check only; no tenant ⇒ refusal **before any data-plane call** with
  distinguishable reasons (`missing`, `blank`, `reserved-default`, `mismatch`, `self-declared`);
  the reserved test-only `DEFAULT_TENANT_ID` is refused as an operator tenant; retrieval is
  re-narrowed at the boundary. **19 new adversarial cases** in
  `packages/cli/test/cli-tenant-isolation.test.ts`.

Files changed by the committed remediation `0cb6b6b..c45cfc1` **(CONTEMPORANEOUS — git diff)**:

| File | Change |
| --- | --- |
| `packages/agent-runtime/test/agent.test.ts` | M (R-1: tenant-explicit test) |
| `packages/cli/src/index.ts` | M (R-4: route through the new boundary) |
| `packages/cli/src/knowledge-command.ts` | A (R-4: new boundary) |
| `packages/cli/test/cli-tenant-isolation.test.ts` | A (R-4: 19 adversarial cases) |
| `packages/cli/test/cli.test.ts` | M (R-1: tenant-explicit test) |
| `README.md`, `.env.example` | M (documentation of the new contract) |

No monetary path, no storage/RLS, no authentication/authorization code, no CI configuration, no
package manifest or lockfile was touched. **(CONTEMPORANEOUS — git diff `0cb6b6b..c45cfc1`; the
diff is limited to the 7 files above.)**

## 3. Verified results for `c45cfc1`

**(CONTEMPORANEOUS — recorded in PR issue comment `5560777167` (posted 17:03:54Z for `c1f9e47`) and
comment `5560923476` (posted 17:29:38Z for the amended `c45cfc1`); both preserved on GitHub. The
R-2 directive's "R-1/R-4 remediation: 840/840 tests passed" matches — SESSION-RECORDED agreement.)**

| Gate | Result |
| --- | --- |
| Build | `npm run build` — exit 0 (49 workspaces) |
| Lint | `npm run lint` — exit 0, 0 errors / 60 warnings (same count as before; none introduced) |
| Tests | `npm test` — exit 0; **Total: 49 · Passed: 49 · Failed: 0 · Skipped: 0**; aggregate **840 tests · 840 pass · 0 fail · 0 skipped** (was 821 / 819 / 2) |
| Previously failing tests | `ok 4 - knowledge.search tool hits the knowledge service`; `ok 4 - ingests text, extracts entities, and retrieves` |
| Tenant/security suites | agent-runtime 10/10 · cli 67/67 · knowledge-service 18/18 · knowledge-graph 25/25 (incl. T-08.1 K1-guard suites) · storage-postgres 38/38 with real PostgreSQL (T-06 cross-tenant isolation over PG passes) |

**CI evidence (CONTEMPORANEOUS — GitHub Actions API, read during R-2):**

| CI run | Head SHA | Conclusion |
| --- | --- | --- |
| `34047371586` | `c1f9e47` (first remediation version) | success |
| `34047326569` | `0f8b831` (intermediate state, superseded by the amend) | cancelled |
| **`34048251273`** | **`c45cfc1` (final)** | **success** — all 9 steps, including `Test (all workspaces)` and `PostgreSQL integration status` (per comment `5560923476`) |

## 4. Independent verification verdict

**(CONTEMPORANEOUS — PR #20 body, preserved on GitHub.)** The R-1+R-4 remediation was verified
**PASS WITH NON-BLOCKING FINDINGS** by an independent read-only cycle, with findings classified
**B-1 … B-7 / V-1 … V-4**. Those classifications later became the charter of milestone S-1:
B-1 (service-level tenant widening, incl. the destructive delete path), B-2 (latent `graph.store`
default-tenant handle), B-3 (untagged durable rows funnelled into `default`), V-1 (forged
`knowledge.document.ingested` ⇒ foreign metadata disclosure), V-2 (CLI re-attribute/drop
defence-in-depth), B-4 (`host-inspect` operator-tenant fallback), B-5/V-4 (README/`.env.example`
tenant contract), and B-6/B-7 (Node-24-in-CI and CI-gate determinations — report only, no code
change). **The standalone detailed per-finding report of that read-only cycle is not committed**
**(UNAVAILABLE/LOST beyond the classification summary and the S-1 root-cause map that later quoted
it).**

## 5. Standing gaps reported at that time (explicitly preserved)

At remediation time the following were **reported, not improvised** (each needing its own
authorized cycle) **(CONTEMPORANEOUS — comment `5560777167`)**:

1. `KnowledgeService.retrieve()/stats()/getChunk()/getDocument()` still widened when
   `opts.tenantId` was `undefined` (legacy unscoped path) — reachable by other callers such as the
   agent `knowledge.search` tool when no ctx tenant was seeded.
2. `knowledge-graph` registered a legacy `graph.store` container value bound to
   `DEFAULT_TENANT_ID` at boot (unconsumed by any module), and `loadFromStorage` mapped untagged
   rows into that bucket.
3. `host-inspect.ts` still substituted `JATAQI_OPERATOR_TENANT ?? 'default'` for the read-only host
   inspection actor.

Items 1–3 were subsequently addressed by S-1 (`121eaa4`; see `S1_INDEPENDENT_VERIFICATION.md`).
The broader standing security programme also remains open (see §6 of
`T09_INDEPENDENT_VERIFICATION.md`): agent/tool authorization, prompt-injection resistance, sandbox
containment, cross-tenant AI/RAG/vector/cache isolation, ATO resistance, SSO/OIDC/SAML,
ABAC/ReBAC/PAM, secrets isolation, supply chain, network boundaries, autonomous-action controls,
abuse/rate limiting, auditability, incident response, production hardening, and the external
production gates. None of these was weakened by R-1/R-4.

## 6. Limitations of this record / unrecoverable evidence

- The remediation verification totals (840/840 etc.) are preserved as **contemporary primary
  reports** (PR comments) — they were fresh runs by the delivery session against `c1f9e47`/
  `c45cfc1`. The current R-2 execution does **not** re-run `c45cfc1` in isolation (it is not HEAD);
  the same code is exercised at the merged tree in `PR20_MERGE_POSTMERGE_VERIFICATION.md`.
- **UNAVAILABLE/LOST:** the standalone per-finding report of the R-1/R-4 independent read-only
  cycle beyond the B-1…B-7 / V-1…V-4 classification and the later S-1 root-cause citations.
- This record does not assert that R-1/R-4 (or R-2) proves JATA Qi production-ready or fully
  hardened.

## 7. Sources of reconstruction (exact)

1. PR #20 body (R-1 + R-4 section) — preserved on GitHub, read via API.
2. PR #20 issue comments `5560777167` and `5560923476` — preserved on GitHub, read via API.
3. Git history: `git diff --name-status 0cb6b6b c45cfc1`; commit metadata for `c1f9e47`, `c45cfc1`.
4. GitHub Actions run records `34047371586`, `34047326569`, `34048251273` — read via API.
5. `docs/S01_TENANT_BOUNDARY_HARDENING.md` @ `121eaa4` and `docs/T09_F_REGISTER_RECONSTRUCTION.md` @ `8fc13ee` (cross-references for B/V classifications and L-9 closure).
