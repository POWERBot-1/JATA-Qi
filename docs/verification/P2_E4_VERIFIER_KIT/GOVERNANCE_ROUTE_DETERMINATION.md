# P2-E4 verification-route determination

**Class:** OWNER/BUILDER GOVERNANCE PREPARATION — not independent verification
**Date:** 2026-09-20 UTC
**Target:** `08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe`

## 1. Existing definition preserved

The governing P2 specification defines E4 as verification by a **separate
party** on the **exact artifact**, with a committed report. The report must
carry the verifier's identity, environment, roles, provider configuration,
SHA, commands, results, findings, and provenance. The rubric and the cap
record exclude same-agent evidence, CI evidence, PR attestation, chat, and
uncommitted reports from satisfying E4.

This preparation does not amend that wording. It treats the separate-party
condition as a substantive principal/independence condition, not a label that
can be assigned after the fact.

## 2. Path A — separate human verifier

**Disposition: AUTHORIZED TO PURSUE; NOT YET SATISFIED.**

A future verifier is eligible only if every item in `ELIGIBILITY_GATE.md` is
true and independently evidenced. In particular, the person must not be
Gitanya Kariuki, POWERBot-1, `arena-ai-coding-agent[bot]`, an owner-controlled
alternate identity, or anyone involved in PR #37 implementation, review,
approval, or merge. The person must use their own identity and credentials,
control their own environment, perform their own technical assessment, and be
free to issue FAIL or adverse findings.

The owner may supply the public repository, target SHA, acceptance criteria,
kit, and logistics. The owner may not supply the conclusion or rewrite the
technical report.

**Current result:** no verifier identity has been supplied or contacted by
this preparation. P2-E4 therefore remains NOT ACHIEVED.

## 3. Path B — human-directed AI/tooling assistance

**Governance determination: conditionally admissible only as a human-led
assessment; the AI/session is not the separate party.**

The existing wording supports a genuinely separate human as the accountable
party using tools under that human's control, provided that:

- the separate human's identity, credentials, environment, accountability,
  and ability to issue an adverse verdict are established;
- the AI model, tool, session, and provenance are disclosed;
- the human directs and owns the assessment and validates the findings;
- the human did not participate in PR #37 and is not owner-controlled;
- execution and evidence are independently generated and durable; and
- no output is accepted merely because a tool reproduced the owner-side
  expected result.

A second Arena session, another `arena-ai-coding-agent[bot]` run, or a
same-principal model invocation is expressly **not** independent. An AI-only
report with no accountable separate human is not accepted under this
interpretation.

**Unresolved operational question:** whether a real future human-led
engagement satisfies all of the gate cannot be answered until that human,
credentials, tooling provenance, and environment exist. This kit does not
pretend that condition has been met.

## 4. Path C — separate automated verifier

**Disposition: not admissible on the present wording without a legitimate
separate-principal determination; no reinterpretation is made.**

The existing P2 wording says “separate party” but does not define an automated
principal, its ownership, accountability, credentials, or authority to issue
an adverse verdict. A hypothetical pipeline is not evidence. An owner-
controlled runner, repository workflow, or credentials controlled by
POWERBot-1, Gitanya Kariuki, or the Arena owner is ineligible. Replaying the
same expected output is not independent assessment.

Therefore this preparation does not treat an automated process as an E4
party. The required feasibility questions remain recorded for any future
owner-authorized governance review:

1. Who independently owns the automated principal?
2. Who controls its credentials and runner, and can that control be audited?
3. How is non-participation in PR #37 established?
4. Can it inspect and expose findings rather than only reproduce a script?
5. Is its evidence provenance immutable from execution through report?
6. Does accepting it preserve, rather than redefine, the existing E4 gate?

Until those questions have a legitimate answer under the existing definition,
Path C is rejected. No automated verifier is created or contacted here.

## 5. Stop and standing status

The owner-side conclusion is a preparation boundary, not an E4 conclusion:

- Path A is the preferred route and may be pursued legitimately.
- Path B may be used only when a genuinely separate human is accountable.
- Path C is not accepted on the current record.
- P2-E4 remains **NOT ACHIEVED**.
- The score remains **9.484375% — FROZEN**.
- The production status remains **NOT READY**.
