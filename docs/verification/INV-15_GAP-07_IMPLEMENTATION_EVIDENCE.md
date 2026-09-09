# INV-15 / GAP-07 — Ambient Security-Scope Minimization — Implementation Evidence

- **Repository:** POWERBot-1/JATA-Qi
- **Branch:** `arena/01a085d8-jata-qi`
- **Base (canonical main at implementation start):** `3e43dc664ee7156f5cfd0c0322e4a4bef209e07b`
- **Head commit:** recorded in the completion report (this document ships inside the commit; see §11)
- **Milestone:** INV-15/GAP-07 — reduce unnecessary ambient security authority represented by the broad system scope `'*'` across the affected storage/pool paths. Governance: implementation explicitly authorized; no P2/R3/production work included.
- **Tested artifact/configuration:** Node v22.22.3, npm 10.9.8, Linux (2 vCPU), real embedded PostgreSQL 18.x beta (`@embedded-postgres/linux-x64` 60 MB binaries), TypeScript 5.x, `node --test`. Full-suite wall evidence: `/tmp/full-test.log` captured during this session (2026-09-09, 50/50 workspaces passed).

---

## 1. Exact definition implemented (primary sources)

- **INV-15** (P1 spec §12): “Pooled sessions start unset (blind); system scope only via explicit `SET LOCAL` transactions; exceptions enumerated in boot audit.” Failure condition: none (unset GUC ⇒ see-nothing policy). Acceptance: “No-tenant-context session ⇒ zero rows; system-scope uses enumerable.”
- **PG-5** (P1 spec §8.3): “No ambient session-level `'*'`; pooled sessions start unset (blind); system scope only via explicit `SET LOCAL` transactions; the enumerated exceptions are documented in the boot audit.”
- **P1-GAP-07** (P1 spec §14; P1-CLOSURE §3.5 acceptance items 1–3): pool `connect` sets no tenant scope; all pool-path sites + standalone CAS/replaceAll + DDL/backfill migrated to explicit scopes; machine-readable boot-audit artifact asserting enumeration; probe matrix + full suites green.

## 2. PHASE 1 — complete inventory (before any code change)

Search basis: repo-wide `grep` for `'*'` scope construction, ambient scope creation/propagation, storage/pool scope defaults, tenant-scope inference, system-scope consumers, implicit `'*'` fallbacks for missing tenant context, and tests depending on ambient `'*'`. Census: **167** pool-path `.collection(…)` call sites in `src` + **84** in `test` across all packages; **44** transaction-bound `scope.collection(…)` uses; **11** packages boot embedded PostgreSQL (30 PG-booting test files).

### 2.1 Ambient / system-scope sites (engine)

| # | Location | Mechanism | Class |
|---|---|---|---|
| 1 | `storage-postgres/postgres-driver.ts` `doInit()` — `pool.on('connect')` → `SET app.tenant_id = '*'` (error swallowed) | **THE GAP-07 ambient grant**: every pooled session (including caller-supplied external pools) started cross-tenant-visible at the RLS layer | **D — unnecessary ambient authority (removed)** |
| 2 | `storage-postgres/postgres-driver.ts` `beginTransaction()` unscoped branch → `setSystemTenantContext` (`SET LOCAL '*'`) | Explicit per-transaction system scope for legitimate system compositions (R2 S-1 seed/read, reachability, retention/GC, mirror; loop-host lease composition) | **B — genuinely system-wide (retained, now counted/enumerated)** |
| 3 | `storage-postgres/postgres-collection.ts` unscoped pool-path ops (`get/put/all/count/delete/has/query/cas/replaceAll/clear`) | Rode on site #1’s ambient scope; `tenantGuard` on unscoped handles stamps `body->>'tenantId'` | **D — ambient dependency (migrated to explicit per-op scope)** |
| 4 | `postgres-collection.ts` standalone `cas`/`replaceAll` (`BEGIN` on pooled client, autocommit outside) | Inherited ambient #1 | **D (migrated)** |
| 5 | `postgres-driver.ts` `ensureResource` → `ensureTenantIsolation` on pool exec (incl. legacy backfill `UPDATE … SET tenant_id = body->>'tenantId'`, which requires cross-tenant visibility) | Inherited ambient #1 | **D (migrated to labeled explicit grant)** |
| 6 | `rls-probe.ts` canary seeding `set_config('app.tenant_id','*',true)` inside `inTransaction` | Explicit SET LOCAL in a self-contained probe | **B (retained)** |
| 7 | `rls-probe.ts` finally-cleanup `set_config(…,'*',false)` (SESSION-level, on a pooled client, then RESET) | Session-scope grant pattern (residue risk on release) | **D — removed (DROP TABLE needs no row scope)** |
| 8 | `tenant-isolation.ts` `TENANT_SYSTEM_SCOPE = '*'`; policy predicate `… OR current_setting('app.tenant_id', true) = '*'`; `setSystemTenantContext` | Marker definition + RLS policy mechanism + explicit helper (not themselves grants) | **B (retained — the mechanism that makes explicit scope auditable)** |
| 9 | `authentication/token-registry.ts:147`, `authentication-event-store.ts:195` — cached pool-path handles for pre-tenant reads (S-9 fingerprint lookup, S-8 session reads) | Listed PG-5 exceptions; previously ran in ambient scope | **C→B (compatibility/pre-tenant lookups; now run through the enumerated, counted explicit scope)** |
| 10 | `authorization-boundary/module.ts:183` R1 `StorageAuditSink` over pool-path handle | R1-only legacy durable path in ambient scope | **C (migrated through explicit scope; behavior preserved)** |
| 11 | `security-state-store.ts` `verifyReachability`/`transact` system branch (atomically without tenantId) | Already explicit `SET LOCAL` form | **B (now counted `transaction:system`)** |
| 12 | `loop-host` event payloads `tenantId: '*'` (host lifecycle event tags) | Event-metadata tag on the bus, not a database security scope | **C — inventory only; untouched (out of GAP-07; changing event payloads = unrelated refactor)** |
| 13 | `core-kernel/event-bus` wildcard listeners (`'*'` topic subscriptions) | Event-routing wildcard, F01 subscription-governed; no durable authority | **B — inventory only; untouched** |
| 14 | `authorization-boundary/capability-manifests.ts` / `policy-engine.ts` `tenantScopes: ['*']`, `allowTenantWildcard` | Declared capability authority (registration REJECTS ambiguous empty-scope manifests; rotation narrows-only; policy engine enforces per tenant) | **B — explicit, not ambient; untouched** |
| 15 | `capability-manifests.ts` `resourcePattern` `'*'` glob | Pattern syntax for target matching (no security scope) | **B — untouched** |
| 16 | `authorization-boundary/src/test-kernel.ts`, `@jataqi/core-kernel/testing` | Test-only manifest registration; test manifests may NOT silently become tenant-wildcards (explicit tenantScopes required) | **E — test/dev only; untouched** |
| 17 | Helpers substituting `'*'` for missing tenant context | **None found** (repo-wide `?? '*'` / fallback greps: zero engine sites) | — |
| 18 | Tests depending on ambient `'*'`: `storage-postgres/t06` (asserts session reverts to `'*'` after COMMIT; session-level `set_config(…,'*'/tenant,false)` patterns); `t01` (own pool, explicit set_config — unaffected); `p1-rls-probe` (own admin pool — unaffected); `postgres.test.ts` (schema-registry admin SQL, no RLS — unaffected); `cli/p1-posture-pg` (app-role production boot — re-verified) | E-class dependencies on the ambient behavior | **E — migrated where behavior legitimately changed (t06); assertions STRENGTHENED, none weakened** |

## 3. Design decisions

1. **Centralize the migration in the storage scope layer** rather than editing 167+84 call sites across ~20 packages (the “broad architectural redesign” the P1-CLOSURE §3.6 declined). The engine’s ambient mechanism (#1) is deleted; every consumer of `StorageModule.collection()` / the driver’s pool-path handles transparently receives its system scope through ONE labeled choke point — the behavior each consumer needs, the authority shape INV-15 demands (per-transaction `SET LOCAL`, never session state).
2. **Fail-closed on the removed path.** A pool-path unscoped handle constructed without the driver’s `SystemScopeRunner` (the shape that used to inherit ambient `'*'`) now REJECTS every operation — proving “former ambient `'*'` path requires explicit authority” structurally, not by convention.
3. **Enumeration is mechanical.** Every grant counts a label (`poolpath:<collection>`, `transaction:system`, `schema:isolation`) in a per-driver ledger; `undeclaredLabels` computes registry violations; the production posture invariant (`p1.production.ambient-scope-minimization`) fails boot on (a) any ambient scope observed on a fresh checkout (LIVE probe: `hasAmbientConnectScope()` executes a real pooled-session read of `current_setting`, so a re-introduced ambient is caught behaviorally, not via a flag) or (b) any observed label outside `ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS`. New broad-scope patterns cannot appear silently.
4. **System-scope grants remain available, explicitly** — legitimate system operations were NOT eliminated: unscoped `beginTransaction()` keeps its `SET LOCAL '*'`; the canary probe keeps its form; S-8/S-9/R1 pre-tenant lookups keep their visibility through the counted runner. Multi-statement legacy flows (`put` guard+insert, `replaceAll`, standalone `cas`) moved from “several autocommit statements riding session state” into one explicit transaction per operation — atomicity strictly improved (a side benefit; the guard-race window is narrowed to one transaction, the documented first-create election is unchanged).
5. **Outage/fail-closed parity.** The runner uses the same pool; every statement can still fail (57P01/ECONNREFUSED ⇒ error propagates; no memory fallback; `SECURITY_STATE_UNAVAILABLE` mapping untouched). `notePoolHealthy()` parity with `beginTransaction`. No retries added anywhere; no timeouts added to the per-op runner (parity with previous autocommit behavior; the R2 tx timeouts on `beginTransaction` are unchanged).
6. **External pools are no longer touched at all.** Previously, `new PostgresDriver({ pool })` attached an ambient `'connect'` listener to the CALLER’s pool. Now the driver registers no listeners anywhere; a caller-supplied pool with a legacy ambient handler is *detected* (positive-control test proves the probe catches exactly that regression shape).

## 4. Exact implementation changes

| File | Change |
|---|---|
| `packages/storage-postgres/src/postgres-driver.ts` | **Removed** the ambient `pool.on('connect')` → `SET app.tenant_id='*'` (the GAP-07 site). **Added** `withSystemScope(label, fn)` (BEGIN + fail-closed `SET LOCAL '*'` + work + COMMIT/ROLLBACK/release + pool-health parity), `getSystemScopeAudit()`, `hasAmbientConnectScope()`, per-driver `SystemScopeCounter`; `openCollection` hands unscoped handles the labeled runner; `beginTransaction()` unscoped branch counts `transaction:system`; `ensureResource` runs `ensureTenantIsolation` (backfill included) via `schema:isolation` when on the pool, inline (inheriting the tx’s explicit scope) when transaction-bound; comments record the new contract; unused `TENANT_SYSTEM_SCOPE` import dropped. |
| `packages/storage-postgres/src/postgres-collection.ts` | Optional 6th constructor parameter `systemScope?: SystemScopeRunner`. All ops route through `scoped()`: tx-bound handles unchanged (run on the caller’s scoped transaction); pool-path handles run inside the explicit labeled transaction; **unscoped pool-path without authority fails closed** (reject, count nothing, write nothing). `put` guard+insert, `replaceAll`, `cas`, `clear` execute their full multi-statement sequence inside one explicit transaction. Header contract updated. |
| `packages/storage-postgres/src/system-scope-audit.ts` | **New.** `SystemScopeException`, frozen `ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS` (3 entries with justifications), `isDeclaredSystemScopeLabel`, `SystemScopeAudit` (machine-readable, JSON-stable), `SystemScopeCounter`, `SystemScopeRunner`. |
| `packages/storage-postgres/src/tenant-isolation.ts` | Documentation contract updated (no ambient state; marker only inside explicit `SET LOCAL`; pointer to the audit). No behavioral change to the policy, charset rules, `setTenantContext` validation (`'*'`/blank/whitespace remain refused), `assertTenantId`, or the fail-closed FORCE RLS DDL. |
| `packages/storage-postgres/src/rls-probe.ts` | **Removed** the session-level `set_config(…,'*',false)` + `RESET` cleanup; scratch DROP is scopeless (DDL is not row-filtered). Canary logic (cross-tenant read/write refusal, no-context blindness, owner+FORCE) unchanged. |
| `packages/storage-postgres/src/index.ts` | Exports the audit surface (`ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS`, `isDeclaredSystemScopeLabel`, types) and `PostgresCollection` (already exported) for the adversarial authority test. |
| `packages/cli/src/security-posture.ts` | **New production invariant `p1.production.ambient-scope-minimization` (INV-15):** non-PG/no-audit driver ⇒ fail-closed; `hasAmbientConnectScope()` true ⇒ boot failure; `undeclaredLabels` non-empty ⇒ boot failure with the offending labels. |
| `packages/storage-postgres/test/t06-rls-production-path.test.ts` | Ambient-reverting assertion INVERTED to the stronger blind default (`after COMMIT: GUC empty — neither 'acme' nor '*'`); raw session-level `'*'` block migrated to the explicit `SET LOCAL` form + no-residue check + new `hasAmbientConnectScope()` assertion; statement capture now tags the issuing pooled client (`cid`) and the T-01/T-04 ownership proof asserts BEGIN/COMMIT/ROLLBACK **on the composed transaction’s own client**, asserts the composed tx never touches system scope (`values[0] !== '*'`), and cross-checks every non-tx BEGIN against the audit ledger (`grants == uses['schema:isolation']`) — an end-to-end “enumeration ≡ reality” proof. Header contract updated. All prior assertions retained or strengthened. |
| `packages/cli/test/p1-posture-pg.test.ts` | SECURE PRODUCTION BOOT asserts the new invariant id is declared, the production driver hands out blind sessions, and the real production boot (R2 seed/mirror/reachability, S-8/S-9 lookups, R1 sink, isolation DDL) produces a fully-declared, non-empty enumeration. |

## 5. Authority-reduction proof (before → after)

| Location | Previous scope | Previous authority | New scope | New authority | Reason | System authority remains? | Justification |
|---|---|---|---|---|---|---|---|
| driver pool `'connect'` | session `'*'` on EVERY pooled session (incl. external pools) | cross-tenant read/write for ANY pooled statement, any idle session, forever | **removed — sessions start unset (blind)** | none | GAP-07 core: ambient authority eliminated | N/A (grant removed) | Blind-by-default is the INV-15 fail-closed direction |
| unscoped pool-path ops (`#3`) | inherited ambient session `'*'` | implicit, uncounted, unbounded | per-op `BEGIN + SET LOCAL '*' + COMMIT` via runner | explicit, per-operation, counted per collection (`poolpath:<name>`) | preserve consumer behavior while removing the ambient carrier | YES (explicit) | legacy/dev paths + PG-5-enumerated pre-tenant lookups |
| standalone `cas`/`replaceAll` (`#4`) | BEGIN on pool client inheriting `'*'` | implicit; guard/write split across autocommit statements | same statements inside one explicit system transaction | counted | atomicity parity+ | YES (explicit) | maintenance-style whole-collection writes |
| `ensureResource` isolation DDL/backfill (`#5`) | inherited ambient | needed cross-tenant visibility silently | `schema:isolation` labeled grant | counted, catalog-guarded, one-time per table | backfill legitimately spans tenants | YES (explicit) | migration correctness only; skipped once isolation exists |
| `beginTransaction` unscoped (`#2`) | SET LOCAL `'*'` (already explicit) | unbounded by count | unchanged + counted | `transaction:system` ledger | enumeration requirement | YES | R2 durable system flows (S-1/reachability/GC/mirror) |
| RLS probe canary seed (`#6`) | SET LOCAL `'*'` in probe tx | self-contained scratch table | unchanged | probe-only | legitimate explicit grant | YES | negative-test mechanism itself |
| RLS probe cleanup (`#7`) | **session-level `set_config(…,'*',false)`** on a pooled client | leaked broad scope until RESET (masked pre-INV-15) | removed — scopeless DROP | none | session-level grants are the ambient pattern | NO | DROP is DDL, not row-filtered |
| handle without authority (`#3` shape) | worked silently (ambient) | — | **fails closed** (rejection writes nothing, counts nothing) | none required | prevents future ambient bypass | NO | by design |
| manifest wildcards / bus wildcards / loop-host tags (`#12–15`) | declared patterns, not DB scope | — | untouched | — | out of GAP-07 (inventory documented) | YES (as before) | declared, validated, governed; not ambient |

**Counts (ambient `'*'` occurrence census, session-level grants):**

| Metric | Before | After |
|---|---|---|
| Ambient session-scope `'*'` grants in engine src (`SET`/`set_config(…, false)`) | **2** (driver `connect` handler; probe cleanup) | **0** |
| Ambient grants asserted/used by tests | 1 (t06 session-level block) | **0** (migrated to explicit `SET LOCAL` form) |
| Explicit SET LOCAL system-scope grant SITES | 3 (beginTransaction, probe seed, helper) | **4** (added the single labeled `withSystemScope` choke point — the only pool-path grant mechanism) |
| Sessions starting with cross-tenant visibility | every pooled session, unbounded | **zero** (live-probed; regression ⇒ boot failure) |
| Machine-readable enumeration of system-scope uses | absent | `getSystemScopeAudit()` + frozen registry + boot invariant + test cross-checks |
| Pooled statements NOT covered by any explicit grant that could still see tenant rows | all pool-path statements | none (unscoped pool-path handle without runner fails closed; direct `pool.query` is blind) |

Removed: **3** ambient grant sites (2 engine + 1 test usage). Retained system-scope mechanisms: **4** explicit sites, each justified in §5 and enumerated in `ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS` (3 label families covering all consumers). **No occurrence required guessing; none left unclassified.**

## 6. Adversarial / focused test mapping (directive items 1–16)

New suite `packages/storage-postgres/test/inv15-system-scope-minimization.test.ts` (real PostgreSQL, fail-hard — FAILS loudly if PG cannot run; 0 skips):

1. **valid explicit tenant scope → ALLOW** — tenant tx reads/writes only own rows (tests 2, 6).
2. **missing tenant (no context) → DENY** — blind session sees zero rows and is refused INSERT by WITH CHECK (test 2; t06 inversion).
3. **blank tenant → DENY** before any write: `' '`, `''`, `'\t'` rejected by `atomically` + `beginTransaction` (test 5).
4. **forged tenant metadata → DENY** — body `tenantId` conflicting with binding → `cross-tenant write refused` (test 5).
5. **cross-tenant substitution → DENY**, victim row byte-intact (test 5; t06 same-id proof retained).
6. **unauthorized system operation → DENY** — rogue unscoped handle (no runner): every op rejects, ledger does not advance, nothing is written (test 4).
7. **explicitly authorized legitimate system operation → ALLOW** — SET LOCAL `'*'` tx spans tenants and leaves no residue after COMMIT (tests 2, 3).
8. **former ambient path now requires explicit authority** — test 4 (structurally fail-closed) + positive-control legacy-pool detection in test 1 (probe catches a re-installed ambient `connect` handler; the boot invariant consumes the same signal).
9. **tenant isolation under concurrency** — 8 concurrent tenant transactions interleaved with pool-path system-scope traffic (test 6).
10. **tenant isolation across independent OS processes** — inherited proof: `authorization-boundary/r2-multiprocess-restart` (32-process) + `cli/p1-posture-pg` MULTI-PROCESS case — re-run green on this artifact (§7).
11. **tenant isolation after persistence/restart** — driver close/reopen: blindness survives, rows survive, scoped reads see exactly their tenant (test 7).
12. **RLS/FORCE remains effective** — `relrowsecurity`/`relforcerowsecurity` asserted on tables created through the NEW path, app-role enforcement proofs re-run (t01/t06/p1-rls-probe green, §7).
13. **outage stays fail-closed** — `r2-pool-outage` (mutation-checked) + `cli` POSTGRES OUTAGE case re-run green.
14. **replay denial** — full `a01-adversarial` + r2 suites re-run green (mechanisms untouched).
15. **idempotency** — R2 durable suites green.
16. **retained system-scope exceptions explicitly enumerated** — frozen registry asserted: exactly `poolpath:` / `transaction:system` / `schema:isolation`, each with justification; undeclared label detection proven (test 8); t06 asserts statement-led ≡ audit-led; p1-posture-pg asserts the real production boot is fully enumerated.

No assertion was weakened: the only migrated assertion (t06 revert-to-`'*'`) was replaced by a strictly stronger one (no leak of tenant AND no ambient default AND live ambient probe).

## 7. Evidence

- **Focused INV-15 suite:** 9/9 pass (`inv15-system-scope-minimization.test.js`, this session).
- **storage-postgres package:** 52/52 pass (t01/t04/t05/t06/p1-rls-probe/postgres/inv15 — includes real-PostgreSQL app-role enforcement).
- **authorization-boundary:** **126/126** pass (52.2 s) — R2 durable paths, multiprocess restart, pool outage, retention GC, credentials, manifest authority — unchanged behavior over the migrated scope layer.
- **authentication 51/51** (S-8/S-9 stores over the enumerated pool-path labels), **agent-runtime 80/80**, **autonomous-action-runtime 26/26**, **knowledge-graph 47/47** (incl. T-06 two-kernel + OS-process isolation), **cli 117/117** (incl. production-posture PG boot with the new invariant), **loop-host 170/170**, **revenue-ledger 20/20**, **commercial-control-plane 69/69**, **commercial-memory 10/10**, **human-approval 8/8**, **storage 26/26**.
- **Full monorepo:** `npm test` (aggregate runner) — **50/50 workspaces PASSED; 1,203 test cases; 0 fail; 0 skipped; 0 `not ok`; 0 “DATABASE INTEGRATION NOT EXECUTED”**; exit 0; captured with `tee` (protocol from the closed investigation).
- **Build:** `npm run build` all workspaces — clean (0 TS errors) before and after test migration.
- **Lint:** `npm run lint` — **0 errors**; 60 pre-existing warnings (byte-identical to base `3e43dc6`; two temporary errors introduced mid-session were fixed, verified by base comparison).
- **Secret scan:** `npm run scan:r2` — **PASS** (8 static files, 13 dump rows, 0 findings).
- **CI:** see completion report (§11) — Actions result for the PR head.
- **Reproducibility:** every failure mode addressed by the closed investigation is absent here: the suites were re-run on this artifact at commit state “working tree + these changes” only, with the environment freshly provisioned.

## 8. Security invariants preserved (explicit checklist)

AuthorizationBoundaryModule enforcement, verified principal identity, tenant isolation (driver predicates + RLS), PostgreSQL RLS **and FORCE RLS** (policy text and fail-closed DDL untouched; probe green), transaction-local tenant scope (`SET LOCAL` semantics), durable SecurityStateStore, replay protection, idempotency, rate limiting, budgets, capability manifests, credential protection, session revocation, CAS/concurrency guarantees (first-create election, 8-process contention suites re-run), outage fail-closed (`r2-pool-outage`, mutation-checked), process isolation, restart isolation, cross-process isolation — all re-verified green on the implemented artifact (§7). **No security invariant was weakened to obtain a passing test** (the single test-behavior delta — t06 ownership counting — was re-scoped to the composed transaction’s own client and STRENGTHENED with an audit cross-check).

## 9. Limitations (honest)

1. **Ambient authority is eliminated at the SESSION level; system scope still exists by design.** The `poolpath:` family means unscoped legacy/dev-path collection operations still obtain full cross-tenant visibility — now explicitly, per operation, counted and boot-enumerated. Closing the LAST step (converting each legacy consumer to tenant-scoped transactions across ~20 packages) is the broader redesign P1 explicitly excluded; it is NOT claimed here. **Complete elimination of ambient authority: PROVEN for the session-level mechanism defined by GAP-07; broader legacy usage is minimized-and-enumerated, not removed.**
2. **Superuser test roles** (embedded `postgres`) bypass RLS enforcement; visibility proofs for the app-role path are covered where suites create non-superuser roles (t01/t06/inv15/p1-rls-probe). On superuser sessions the `SET LOCAL` grants are behaviorally invisible — parity is what those suites keep green.
3. **Namespaces/blobs have no RLS** (pre-existing T-06 design; tenant separation there is table-name scoping). GAP-07 scoped to the pool `'*'` mechanism; unchanged and re-verified.
4. The audit ledger is **per driver instance** (counts reset on restart by design; the enumeration of exception FAMILIES is static/registry-based, so restart isolation is proven — persistent-row access needs explicit scope every time).
5. `hasAmbientConnectScope()` checks a checked-out session — a hypothetical ambient injected *after* checkout would not be seen by it; the canary + ledger (t06 statement-level cross-check) cover statement-time scope assertions.
6. In-process compromise of the gate itself remains out of scope (P3 accepted residual, unchanged).

## 10. Commands (reproduction)

- `npm ci && npm run build`
- `npm run lint`
- `cd packages/storage-postgres && node --test dist/test/inv15-system-scope-minimization.test.js`
- `npm run scan:r2`
- `npm test` (aggregate; expect `Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0`)

## 11. Provenance

- Base: `3e43dc664ee7156f5cfd0c0322e4a4bef209e07b` (canonical main; INV-15 branch had zero code delta at start).
- Commit SHA / branch / PR: recorded in the completion report and PR description (git-native provenance; the pre-commit tree is exactly §4 + this file — verified via `git status`/`git diff --stat`).
