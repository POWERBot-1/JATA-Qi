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
| Amendment | **§7 (2026-09-27).** Records that §4.3 is satisfied for commit `08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe` / tree `5f2152ce0cd702b649b93bc23c165d36cb9b9dba` only. Does not replace §§1–6. Does not lift unrelated conditions. Canonical recognition record: `P2_E4_RECOGNITION_DISPOSITION.md`. |

---

**Amendment notice (2026-09-27).** Section 7 records satisfaction of the §4.3
condition for one historical artifact. Sections 1–6 remain the 2026-09-17
disposition and are not rewritten. Unrelated conditions are not removed or
weakened. Production readiness does not follow.

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

**Pointer (2026-09-27).** The standing-status sentences above, and the
statement that the E4 class was never obtained, remain the historical
disposition of 2026-09-17. They are qualified only by §7, and only for the
artifact named there. They are not deleted.

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

**Recorded satisfaction (2026-09-27).** For commit
`08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe` / tree
`5f2152ce0cd702b649b93bc23c165d36cb9b9dba` only, this §4.3 condition is
recorded as satisfied. The paragraph above is not rewritten. The record of
that satisfaction is §7 and `P2_E4_RECOGNITION_DISPOSITION.md`. No other
condition in this disposition is satisfied by that record.

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

## 7. Amendment — §4.3 satisfied for one historical artifact (2026-09-27)

| Field | Value |
|---|---|
| Authority | Owner authorization of 2026-09-27, recorded in `P2_E4_RECOGNITION_DISPOSITION.md` |
| Recorded by | Arena agent session `arena/01a0e26a-jata-qi` |
| Effect | The §4.3 condition is satisfied for one named historical artifact. Sections 1–6 historical text is not rewritten. Pointers mark this section. Unrelated conditions are unchanged in substance. |
| Canonical statement | `docs/verification/P2_E4_RECOGNITION_DISPOSITION.md` |

The owner explicitly authorized the future change that §1 said the cap holds
unless authorized. The authorization is narrow. It permits this disposition to
be updated solely to record that the §4.3 P2-E4 condition has been satisfied
for the specified historical artifact.

**Satisfied condition.** For commit `08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe`
/ tree `5f2152ce0cd702b649b93bc23c165d36cb9b9dba` only, the §4.3 condition is
satisfied. The basis is the committed Christine Kariuki report,
`docs/verification/P2_S8_INDEPENDENT_VERIFICATION.md`, delivered by PR #45
(head `aa7f4a6df4e512d43db77d48650d8ae78d51601d`, merge
`e82897bb14e375fb08b30bf0bfc6346252f18aaf`), together with the owner's
acceptance of the read-only adjudication disposition **A. FORMALLY
RECOGNIZABLE.** P2-E4 is formally recognized for that artifact. Recognition
is retrospective. The report was not in the artifact tree. Spec §19 rule 1's
pre-merge timing was not met at the PR #37 merge. That historical fact stands.
This section does not rewrite it. Section 2's statement that no separate-party
report existed at `08adbd9` remains true of that date. The later report does
not rewrite §2.

**Qualification of §1, and of nothing else.** The 2026-09-17 statements
"`P2 E4: NOT ACHIEVED`" and "the repository must never state that P2 achieved
E4" remain the true description of the 2026-09-17 disposition. They no longer
forbid recording the artifact-specific recognition in this section and in
`P2_E4_RECOGNITION_DISPOSITION.md`. They still forbid stating that E4 was
achieved at the 2026-09-17 cap, that any other commit is E4-recognized, that
the class was manufactured, or that production readiness follows.

**Unrelated conditions — not removed, not weakened, not rewritten.**

- §3 remains in force. The PRIMARY, CI-class, and PR-attestation rows in
  that section are not promoted and are not given retroactive E4 credit.
  This amendment does not infer independence from them.
- §4.1 remains in force. No E4 uplift is permitted. CI-class and same-agent
  evidence are not substituted for a scoring assessment. The published figure
  remains the frozen **9.484375%**. This amendment does not close a rubric
  gate and does not authorize a score change. The §4.1 sentence that a gate
  requiring E4 remains unsatisfied is qualified only for the §4.3 condition
  on the named artifact. Every other gate named in this disposition remains
  unsatisfied.
- §4.2 is not amended into a P3 authorization. Recognition does not authorize
  P3 entry or P3 implementation, and it is not a reason to relax P3's
  verification standard. The 2026-09-17 text of §4.2 is unchanged.
- §5 is unchanged. No limitation listed there is closed.
- §6 is unchanged as a record of what the 2026-09-17 act did and did not do.
- BD-01 is not adopted. IV-1 through IV-11 are not found to have been
  independently corroborated. The documented BD-01 evidence gaps remain
  preserved in the recognition record. They are not erased.
- Production remains **NOT READY**. This amendment is not production
  qualification and is not an E5 claim. Production readiness does not follow.

**Not authorized by this amendment:** score recalculation; score publication;
remediation; P3, S1, S2, or S3 implementation; PR #46 merge; rubric
modification; ruleset or settings changes; rewriting of historical evidence.

**STOP.**
