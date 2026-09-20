# Twelve-item separate-verifier eligibility gate

**This is an owner-side gate template. A future verifier must complete it in
its own report with evidence. A checked box in this template is not evidence
that the condition currently holds.**

All twelve items are mandatory. Any `NO`, `UNKNOWN`, or unverifiable answer is
a STOP condition; it is not converted to PASS by inference.

| # | Eligibility condition | Required evidence from the verifier | Status before a verifier exists |
|---:|---|---|---|
| 1 | Verifier is not Gitanya Kariuki | Own identity basis and declaration | NOT ESTABLISHED |
| 2 | Verifier is not POWERBot-1 | Account/identity basis | NOT ESTABLISHED |
| 3 | Verifier is not `arena-ai-coding-agent[bot]` | Provider/account identity and provenance | NOT ESTABLISHED |
| 4 | Verifier did not implement PR #37 | Identity and role-history declaration | NOT ESTABLISHED |
| 5 | Verifier did not review PR #37 | Review/role-history declaration | NOT ESTABLISHED |
| 6 | Verifier did not approve PR #37 | Review/role-history declaration | NOT ESTABLISHED |
| 7 | Verifier did not merge PR #37 | Merge/role-history declaration | NOT ESTABLISHED |
| 8 | Verifier is not an owner-controlled alternate identity | Control and conflict declaration | NOT ESTABLISHED |
| 9 | Verifier uses their own identity, credentials, and environment | Credential basis, environment provenance, and custody declaration | NOT ESTABLISHED |
| 10 | Verifier performs an independent technical assessment and can issue FAIL | Method, raw observations, findings register, and adverse-verdict statement | NOT ESTABLISHED |
| 11 | Verifier controls and preserves the evidence trail | Immutable/hash records, timestamps, commands, logs, and report provenance | NOT ESTABLISHED |
| 12 | No pre-authored PASS, pressure, or owner-directed conclusion | Independence declaration, disclosed assistance, and report authorship trail | NOT ESTABLISHED |

## Required stop conditions

Stop immediately and report the blocker if:

- identity or credential control is ambiguous;
- the verifier is involved in PR #37 in any role;
- the verifier is only another session of the same principal;
- exact SHA or tree identity cannot be established;
- evidence provenance cannot be established;
- the route requires weakening or redefining E4;
- PRIMARY or CI evidence is proposed as E4;
- a PASS was authored before independent execution;
- a mutation changes the tracked target tree and cannot be fully explained;
- a test skips, diverges from the declared expectation, or loses output.

## Human-directed AI disclosure

If a separate human uses AI or other tooling, the verifier must additionally
record the tool/model identity, session or job provenance, prompts or
instructions material to findings, what the human independently checked, and
where the tool could have influenced the result. The human remains the
accountable verifier; the tool is not silently relabeled as the separate
party.
