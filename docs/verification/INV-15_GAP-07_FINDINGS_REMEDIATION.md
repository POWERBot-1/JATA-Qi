# INV-15 / GAP-07 — Non-Blocking Findings Remediation (F1–F3)

- **Repository:** POWERBot-1/JATA-Qi · **PR:** #28
- **Starting head (verified implementation head):** `a86c8252f30c11830392b51a520806c801a650e7`
- **Canonical base:** `3e43dc664ee7156f5cfd0c0322e4a4bef209e07b`
- **Trigger:** Independent verification result **B — INV-15 VERIFIED WITH NON-BLOCKING FINDINGS** (`INV-15_GAP-07_INDEPENDENT_VERIFICATION.md`)
- **Authorization:** documentation/comment/inventory correction ONLY (three enumerated findings). This commit performs nothing else.
- **Date:** 2026-09-09 (Node v22.22.3, embedded PostgreSQL 18-beta, Linux sandbox)

---

## 1. The three findings being remediated (verbatim scope)

| # | Finding | Class |
|---|---|---|
| F1 | Census figures in the implementation evidence doc ("167 src / 84 test `.collection(`", "44 tx-bound", "30 PG-booting files") do not reproduce; storage-postgres suite count "52/52" is one stale (9th test added pre-final commit); completion-report file/insertion stats ("11 files / 356 insertions") mismatch the shipped diff (10 files / +1,110 / −119) — the latter lived only in chat/PR narratives, the doc-cited figures are corrected here | reporting accuracy |
| F2 | Evidence doc §4 listed a `tenant-isolation.ts` change that the implementation commit did not make | false inventory row |
| F3 | `tenant-isolation.ts` carries three stale comments describing the REMOVED ambient model ("set on the driver's own pool via connection startup options", "the driver's own pool, unscoped transactions", "system scope is set by the driver's pool") | stale comment |

## 2. F1 — corrected census: methodology and values (derived from the repository, not estimated)

**Counting method.** A "consumer line" = a line of a tracked `packages/**/*.ts` file (excluding `dist/`) matching the extended regex `\.collection[<(]`. The `<` alternation is essential: product consumers overwhelmingly call the **generic** form `.collection<T>(…)`, which a plain `.collection(` pattern silently misses — this is exactly why the superseded draft numbers were wrong (they used the plain pattern). Reproduce:

```
git grep -E '\.collection[<(]' 3e43dc6 | grep '\.ts:' | grep -v '/dist/' | grep '/src/' | wc -l   # ⇒ 199
git grep -E '\.collection[<(]' 3e43dc6 | grep '\.ts:' | grep -v '/dist/' | grep '/test/' | wc -l  # ⇒ 130
# head (working tree): identical src command ⇒ 199; test ⇒ 147
# tx-bound split: same pipeline with pattern \b(tx|scope)\.collection[<(] ⇒ 45 (src, base)
```

**Corrected values.**

| Measure | base `3e43dc6` | head `a86c825` | Reconciliation |
|---|---|---|---|
| `src` consumer lines (all packages) | **199** | **199** | Identical because the PR diff touches **no consumer file** — only the authority layer under `storage-postgres`/`cli` |
| — inside storage-postgres `src` | 0 | 0 | Its own code routes via `openCollection`, which the pattern deliberately excludes |
| — transaction-bound `(tx|scope).collection` | **45** | 45 | Retained mechanism (unchanged semantics) |
| — pool-path / wrapper remainder | **154** | 154 | 199 = 45 + 154 ✓ totals reconcile |
| `test` lines (all packages) | **130** | **147** | Δ +17 = storage-postgres test edits only (t06 additions + the new 474-line INV-15 suite); non-storage-postgres test count **unchanged at 77** on both refs ✓ |
| packages booting embedded PostgreSQL | **11** (31 test files) | 12 files+… (32 test files) | The "11 packages" claim verified correct; "30 files" was an off-by-one → **31 at base, 32 at head** |
| storage-postgres package result | — | **53/53** | "52/52" was the pre-9th-test snapshot; 53 verified by fresh full-suite run (§5) |

**Historical figures** (the incorrect 167/84/44/30 set) are preserved inside the corrected doc sentence **only as clearly-labeled superseded history** — no other stale figure remains; the evidence doc §2 now embeds the methodology so any reviewer can recompute in one command.

## 3. F2 — corrected inventory row

The §4 change table's `tenant-isolation.ts` row previously claimed an implementation-commit documentation update that never happened. It is now **truthful in both directions**: it states the implementation commit did not change the file (correcting the false claim explicitly), and describes the comment refresh that **this** remediation commit actually ships, with a pointer to this document. No new unsupported claim is introduced — every sentence in the row is verifiable against the two commit diffs. The F3 edits made the row's second half real rather than merely deleting text; the §2.1 inventory row for `tenant-isolation.ts` (class B) remains accurate independently of either commit.

## 4. F3 — refreshed comments (exact current text locations)

`packages/storage-postgres/src/tenant-isolation.ts`, three blocks, comment lines only:

1. **Header contract (~L27):** SYSTEM-marker bullet now reads: marker exists "ONLY inside explicit per-transaction `SET LOCAL` grants acquired by the driver (never a session-level ambient, never pool startup options — pooled sessions start UNSET, i.e. blind)".
2. **`TENANT_SYSTEM_SCOPE` doc (~L56):** replaced "(the driver's own pool, unscoped transactions)" with the exact grant sites: `withSystemScope`, the unscoped `beginTransaction` branch, the schema-isolation path — "never ambient session state (INV-15/GAP-07)".
3. **`setTenantContext` doc (~L141):** "system scope is acquired ONLY through the driver's explicit system-scope transactions (`setSystemTenantContext` inside `SET LOCAL` transactions), never via session state and never through the tenant API."

**Technical precision check.** The new wording matches the verified authority model: pooled sessions blind; grants transaction-local (`SET LOCAL`, `set_config(…, true)`); enumerated labels `poolpath:` / `transaction:system` / `schema:isolation`; the `'*'`-refused-as-tenant-identity regex untouched. Diff audit: **0 non-comment lines changed** (every added/removed line begins with `//` or `*`).

## 5. Proof that no security implementation changed + regression results

- `git diff a86c825..HEAD` = **3 files**: this document, the corrected evidence doc, the comment-refreshed `tenant-isolation.ts`. Zero lines changed in: driver, collection, audit module, rls-probe, CLI posture invariant, any test, any config, any dependency (full `--stat` recorded in §6). The verifier's independent artifact remains untracked/uncommitted exactly as its own directive required.
- **Fresh verification on the remediated tree:** root `npm run build` exit 0 (0 TS errors); storage-postgres package **53/53** (0 skip — re-ran inv15 + t06 focused first: 18/18); authorization-boundary **126/126** (0 skip); cli **117/117** (0 skip); full monorepo `npm test`: **Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0**, 0 `not ok` lines, exit 0; `npm run lint`: **0 errors / 60 pre-existing warnings** (base-identical); `npm run scan:r2`: **PASS** (0 findings; tool-regenerated artifact restored to committed state — the only "change" was the scan tool's own timestamped output, reverted).
- No assertion touched (test diffs: none). No suppressions (eslint-disable/ts-ignore greps on the diff: none). No configuration/CI changes.

## 6. Final diff (scope-purity review)

| File | Δ | Nature |
|---|---|---|
| `docs/verification/INV-15_GAP-07_IMPLEMENTATION_EVIDENCE.md` | +18 / −7 | F1 census correction w/ methodology, labeled-history clause, 53/53, F2 row rewrite, §11 remediation addendum, cross-ref renumber |
| `packages/storage-postgres/src/tenant-isolation.ts` | +15 / −8 | F3 comment refresh only (0 non-comment lines) |
| `docs/verification/INV-15_GAP-07_FINDINGS_REMEDIATION.md` | new | this document |

Nothing else in the commit. Out-of-scope improvements noticed in passing (e.g., the scan tool's artifact rewrite-on-run behavior, README wording in other docs) were **deliberately not touched** per directive.

## 7. Remaining limitations / notes

- The "154 pool-path-or-wrapper" split is line-count based (methodology in §2); it includes module-internal wrapper lines and counts lines, not distinct call targets — intentional, since the load-bearing claim remains the **structural** one already independently verified (single handle-construction path through the enumerated choke point), which no counting method can strengthen or weaken.
- Evidence-doc style keeps prior section numbering (Provenance is now §12 due to the inserted §11 addendum); no other document's cross-references point into this file's section numbers.
- This remediation does **not** self-upgrade the determination: whether B becomes A is for a fresh independent verifier.

## 8. Disposition

Pushed to PR #28 (head → remediation commit). **No merge. No P0 score change (frozen 9.484375%). G10 OPEN / G19 UNRECOVERED / P1C-OBS-01 documented-not-remediated — untouched.** STOP pending fresh independent re-verification.
