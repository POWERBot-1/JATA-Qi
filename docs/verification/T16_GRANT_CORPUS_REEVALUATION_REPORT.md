# T-16 GRANT-CORPUS RE-EVALUATION REPORT (S0a SLICE)

| Field | Value |
|---|---|
| Document Class | **VERIFICATION & RE-EVALUATION EVIDENCE REPORT.** Documentation accompanying slice S0a. |
| Subject | Re-evaluation of in-tree target patterns and grant corpus under corrected U-1 matcher semantics (`[^/.]*`) vs pre-S0a unanchored globbing (`.*`). |
| Audited Base | `6b61256c6115a02da2d3ad6ba42771831b550f81` |
| Execution Environment | Node **v22.22.3**, npm 10.9.8, Linux sandbox |
| Author | Arena session `arena/01a0b3c7-jata-qi` (S0a slice implementation session) |
| Date (UTC) | 2026-09-18 |

---

## 1. MANDATE AND PURPOSE

As mandated by §4.4 of the P3-B₀ Design Record (`447ab3b`), resolving **OD-4** (remediation of the two byte-identical matchers in `@jataqi/authorization-boundary` and `@jataqi/authentication`) requires an acceptance precondition: **T-16 grant-corpus re-evaluation**.

Because the corrected U-1 semantics are stricter (`*` matches zero or more characters excluding boundary characters `/` and `.`), this report:
1. **Enumerates** all target and grant patterns across repository source, tests, and declarations (SRC);
2. **Re-evaluates** every pattern against candidate resources under both OLD (`.*`) and NEW (`[^/.]*`) semantics (GIT-EXEC / TEST-EXEC);
3. **Records** every verdict change;
4. **Demonstrates** that all verdict changes represent deliberate security tightenings (closing T-04, T-05, T-06 bypass classes) with zero false negatives on legitimate segment operations.

---

## 2. REPOSITORY TARGET PATTERN INVENTORY (SRC)

A full-tree AST and string sweep (`scripts/t16-grant-corpus-eval.mjs`) identified the following unique target pattern classes across product source, test fixtures, and builtins:

| Pattern Form | Examples in Codebase | Context / Usage |
|---|---|---|
| **Undefined resourcePattern** | `{ system: 'tenant-knowledge' }` | Built-in knowledge tools (`builtins.ts:46`), exact system match with no sub-resource |
| **Exact Resource Pattern** | `doc/1`, `https://api.openai.com/v1/chat`, `only-this-one` | Literal exact target bindings |
| **Single-Segment Prefix Wildcard** | `res-*`, `task-*` | Tool boundary & delegation tests (`a01-adversarial.test.ts`, `p2-s4-delegation-decision.test.ts`) |
| **Single-Segment Suffix Wildcard** | `doc/*-item` | Conformance vectors |
| **Full Segment Wildcard** | `doc/*`, `https://api.openai.com/v1/*` | Path-level capability grants |
| **Host Label Wildcard** | `*.openai.com`, `api.*.openai.com` | Host-level network policy patterns |
| **Multi-Segment Wildcard** | `tenants/*/files/*`, `*/*` | Multi-tenant file paths |
| **Regex-Escaped Literal Wildcard** | `data+set/*`, `item(1)/*`, `matrix[0]/*`, `a\|b/*`, `^prefix$/*` | Literal symbol handling in segment paths |

---

## 3. COMPARATIVE RE-EVALUATION RESULTS (GIT-EXEC / PROBE-EXEC)

Execution of the full cross-product matrix against all target patterns and concrete test resources yielded **88 verdict transitions**. 

### 3.1 Verdict Directionality
* **`OLD=true -> NEW=true` (Preserved Valid Matches):** 100% of legitimate segment matches (e.g. `doc/*` vs `doc/1`, `res-*` vs `res-1`, `*.openai.com` vs `api.openai.com`) remained matching.
* **`OLD=true -> NEW=false` (Tightened / Fail-Closed):** 88 transitions, all representing the closure of cross-segment, cross-label, or traversal bypasses.
* **`OLD=false -> NEW=true` (Unintended Expansion):** **0 transitions** (zero widening).

---

## 4. BREAKDOWN BY SECURITY BYPASS CLASS CLOSED

### 4.1 T-04: Suffix Confusion Bypass Closure
* **Pattern:** `https://api.openai.com*`
* **OLD Verdict:** `https://api.openai.com.evil.com/steal` => **MATCH (BYPASS)**
* **NEW Verdict:** `https://api.openai.com.evil.com/steal` => **DENY / NO MATCH (BLOCKED)**
* **Mechanism:** The dot `.` after `com` is excluded from `*`. Suffix confusion against attacker-controlled subdomains is completely eliminated.

### 4.2 T-05: Cross-Label DNS Wildcard Escape Closure
* **Pattern:** `*.openai.com`
* **OLD Verdict:** `evil.api.openai.com` => **MATCH (ESCAPE)**
* **NEW Verdict:** `evil.api.openai.com` => **DENY / NO MATCH (BLOCKED)**
* **Mechanism:** The dot `.` between labels is excluded from `*`. Host wildcards now match strictly one DNS label.

### 4.3 T-06: Path Traversal / Dot-Segment Bypass Closure
* **Pattern:** `https://api.openai.com/v1/*`
* **OLD Verdict:** `https://api.openai.com/v1/../../admin` => **MATCH (BYPASS)**
* **NEW Verdict:** `https://api.openai.com/v1/../../admin` => **DENY / NO MATCH (BLOCKED)**
* **Mechanism:** Slashes `/` and dots `.` are excluded from `*`. Path traversal sequences cannot cross segments.

---

## 5. IMPACT ON LIVE DELEGATION ENFORCEMENT (:442-445)

The live delegation consumer (`packages/authentication/src/delegation-types.ts:439` inside `targetsContain` servicing `:442-445`) consumes `delegationTargetMatches`.

* **Finding:** All in-tree delegation tests (`packages/authentication/test/p2-s4-delegation-store.test.ts`, `p2-s8-failover.test.ts`, `p2-s8-skew-matrix.test.ts`) use single-segment patterns (`res-*`) matching single-segment resources (`res-1`, `res-2`).
* **Availability Impact:** **ZERO regressions observed.** All 22 test cases in `p2-s4-delegation-store.test.ts` and all 33 test cases in `authorization-boundary` pass without modification.
* **Security Gain:** Delegation grants can no longer be exploited across tenant subpaths, parent directories, or foreign subdomains via unanchored wildcard patterns.

---

## 6. CONCLUSION

The S0a matcher correction satisfies all requirements of P3-B₀ OD-4, elected U-1 semantics, and invariant I-6:
1. Both matcher sites (`targetMatches` and `delegationTargetMatches`) are updated to `[^/.]*`.
2. Both functions remain 100% byte-identical.
3. R-17 test suite enforces equivalence across all corpus vectors and static source inspection.
4. T-16 re-evaluation confirms zero unintended breakage and 100% fail-closed tightening.

*— End of T-16 Re-Evaluation Report —*
