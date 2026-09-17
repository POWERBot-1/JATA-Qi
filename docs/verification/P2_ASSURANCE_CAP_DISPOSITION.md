# P2 ASSURANCE CAP — DISPOSITION RECORD

| Field | Value |
|---|---|
| Record type | Governance disposition (human-authorized; permanent unless separately changed) |
| Exact canonical SHA | **`08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe`** |
| Date (UTC) | 2026-09-17 |
| Authorizing human | **Gitanya Kariuki (repository owner)** |
| Authorization text | *"P2 SHALL BE PERMANENTLY CAPPED WITHOUT E4 … The absence of genuine separate-party verification is now an accepted assurance limitation … Do not attempt to obtain, simulate, relabel, or manufacture separate-party E4 verification."* |
| Implementer of this record | Arena agent session `arena/01a0b08f-jata-qi` (documentation only) |
| Scope | Governance record. Implements no capability, remediates no defect, changes no score. |

---

## 1. Disposition

> **P2 E4: NOT ACHIEVED.**
>
> **Reason: genuine separate-party verification was unavailable.**
>
> **P2 is PERMANENTLY CAPPED WITHOUT E4.** The cap holds unless the owner
> explicitly authorizes a future change.

P2-S8 remains **operationally CLOSED** and was **legitimately merged** (PR #37 →
`08adbd9`). Operational closure and assurance class are different things: the
milestone closed; the E4 class was never obtained.

**`P2-E4: NOT ACHIEVED` must be read as the standing status in every future
record. The repository must never state that P2 achieved E4.**

## 2. Why the E4 gate was not established (recorded, not repaired)

P2's own normative exit rule (spec §19 rule 1 / §24 P2-S8) requires a
**separate-party** independent verification report on the exact artifact,
committed before merge authorization; §19 rule 4 defines E4 as separate-party
verification and §19 rule 2 excludes PR comments, chat, and uncommitted reports
from canonical evidence.

| Fact | Evidence |
|---|---|
| No `P2_S8_INDEPENDENT_VERIFICATION.md` exists in the tree | directory listing + repo-wide search at `08adbd9`; files present: `P2_S6_INDEPENDENT_VERIFICATION.md`, `S1_INDEPENDENT_VERIFICATION.md`, `T09_INDEPENDENT_VERIFICATION.md` only |
| The only committed S8 verification self-declares same-agent class | `P2_S8_WHOLE_TREE_VERIFICATION_PASS.md:6` — *"SAME-AGENT (PRIMARY at best) — explicitly NOT E4"*; `P2_S8_IMPLEMENTATION_REPORT.md` §8 |
| The pre-existing P2 IV record is explicitly not second-party | `P2_S6_INDEPENDENT_VERIFICATION.md:3` — *"EV-07: Same agent as the implementation … This is not a second-party review"* |
| No distinct verifier identity was available in the verification environment | P2-E4 session probe (2026-09-17): the only authenticated actor was the same App that authored PR #37 (`arena-ai-coding-agent[bot]`); the only git identity was the owner/merger account (`POWERBot-1`); PR #37's approval carried an empty review body |
| The program had already adjudicated same-agent passes as non-independent | `CROSS_MILESTONE_EVIDENCE_CLAIM_AUDIT.md` finding **EV-07**; remediation **BD-01** (adopt an explicit honest definition) was recommended but never adopted |

Because `§19 rule 2` excludes approval clicks and PR comments from canonical
evidence, **A-17…A-23 "PASS" remains PRIMARY / same-agent class**, notwithstanding
that CI on the exact artifact passed.

## 3. Assurance classification of existing P2 evidence (unchanged)

| Evidence | Class | May it be promoted? |
|---|---|---|
| A-17…A-23 suites, mutation-hygiene gate, P2-S7 disposable mutation, whole-tree pass | **PRIMARY (same-agent)** | **NO** |
| `P2_S8_WHOLE_TREE_VERIFICATION_PASS.md` | PRIMARY, self-labelled not-E4 | **NO** |
| Post-P2 v1.1 assessment records | PRIMARY (assessment) | **NO** |
| CI run `35252694561` on `08adbd9` | **CI-class** (workflow-reported; metadata observed; raw logs egress-blocked) | **NO** |
| PR #37 review/merge events | **PR-ATTESTATION** | **NO** |

**No retroactive E4 credit. No inferred independence. No score inflation. No
rewriting of historical verification reports to manufacture independence.** No
existing historical record is altered by this disposition.

## 4. Consequences

### 4.1 For scoring

- P2 security/identity evidence stays at its supported class; **no E4 uplift is
  permitted** for any P2 unit or dimension.
- Where the rubric or a gate requires E4, **that gate remains UNSATISFIED**.
  CI-class or same-agent evidence must never be substituted for E4 — silently or
  otherwise.
- The published evidence-qualified baseline remains the frozen **9.484375%**
  (v1.1 §10); this disposition changes no figure. Any future change requires a
  separately authorized assessment and a rubric-legal basis.
- Assessments must state the cap explicitly so that no reader infers an
  assurance level the program does not hold.

### 4.2 For P3 entry

- P3 may proceed (separately authorized and separately bounded), but **only**
  on the honest basis that the P2 identity/privilege plane is
  **PRIMARY-verified, not E4-verified**.
- P3's own evidence plan must not assume P2 E4 exists, and must not treat the
  cap as a reason to relax P3's verification standard. This cap **lowers the
  assurance claim, never the engineering standard**.

### 4.3 For future verifiers

If a genuinely separate party becomes available, they may verify P2
retrospectively under their own identity and record; this disposition does not
forbid that. It forbids *manufacturing* the class. Any such future report must
be produced by that separate party and must state its own identity, environment,
and independence basis.

## 5. Known limitations carried forward verbatim (not closed by this record)

- **xproc-MFA race** remains unproven; the `xproc-mfa` probe fails closed by design.
- **P1-GAP-12** — envelope integrity is an **unkeyed SHA-256** digest
  (`packages/authorization-boundary/src/canonical.ts:42`): tamper-evidence, not
  origin authenticity.
- **Issuance idempotency key remains absent** for P2-S8 A-23; prevention lives at
  use time (one-shot CAS + consumed-envelope dedup).
- **A-20 failover is test-class** — the plane's contract is pinned; no production
  HA/DR exists or is claimed.
- **G10 remains OPEN** (log egress blocked; re-confirmed 2026-09-17, 0 bytes).
- **G19 remains UNRECOVERED.**
- **Force-push / `non_fast_forward` protection remains ABSENT** in ruleset
  `20134880`; stale-review dismissal and last-push approval remain **disabled**;
  no committed ruleset read-back existed before this task (see
  `P2_S8_POSTMERGE_VERIFICATION.md` §5 for the read-back recorded today).
- **EV-01 / EV-02 / EV-08 remain outstanding** (unremediated; not authorized).
- **F1–F4 remain OPEN / NON-BLOCKING**; F5 closed on cited evidence.
- **D02 / D03 / D14 remain UNSCORABLE**; **D07b remains 0.0000000 / 2.25**.
- **Production HA/DR, KMS/HSM provider (D2), ABAC/ReBAC/PAM, SAML, PSP, UI, and
  the entire P4–P7 surface remain unimplemented.**

## 6. Governance status

**Performed:** documentation only — this record, the post-merge verification
record, the post-P2 v1.1 assessment, and the P3-A baseline/plan.
**NOT performed:** no production-code change; no remediation of EV-01/02/08; no
ruleset modification; no force-push or stale-review change; no G10 disposition;
no G19 reconstruction; no rubric modification; no score recalculation beyond a
rubric-compliant assessment; no P3 implementation; no P4+ work; no
dormant-stream integration; no deployment.

**Authorization boundary:** this disposition records an owner decision. It does
not modify any historical verification report, and it grants no implementation
authority of any kind.

**STOP.**
