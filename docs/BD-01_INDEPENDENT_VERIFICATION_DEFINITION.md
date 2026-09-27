# BD-01 — DEFINITION OF "INDEPENDENT VERIFICATION"

| Field | Value |
|---|---|
| Record type | Governance definition (normative once adopted) |
| Identifier | **BD-01** (blocking dependency, process — `docs/verification/CROSS_MILESTONE_EVIDENCE_CLAIM_AUDIT.md` §10) |
| Status | **PREPARED — NOT ADOPTED. STOP BEFORE MERGE.** |
| Adoption authority | Repository owner (Gitanya Kariuki), by separate explicit authorization |
| Prepared by | Arena agent session `arena/01a0e22c-jata-qi` (owner-authorized preparation only) |
| Prepared (UTC) | 2026-09-27 |
| Scope | Definition and evidence rules only. No code change. No score change. No cap change. |
| Effect on standing state | **None.** P2-E4 remains NOT ACHIEVED; `9.484375%` remains FROZEN; assurance cap remains IN FORCE; production remains NOT READY. |

> **Adoption block (to be completed only by separate owner authorization)**
>
> | Field | Value |
> |---|---|
> | Adopted (UTC) | `NOT_ADOPTED` |
> | Authorizing human | `NOT_RECORDED` |
> | Authorization text | `NOT_RECORDED` |
> | Merged in | `NOT_MERGED` |
>
> Until every field above is populated by an owner authorization, this document
> is a **proposal**. It has no normative force and may not be cited as the
> definition of "independent verification." The operative wording in the
> meantime remains the honest-limit disclosure at
> `docs/verification/P2_S7_IMPLEMENTATION_REPORT.md` §12 and the cap
> disposition at `docs/verification/P2_ASSURANCE_CAP_DISPOSITION.md`.

---

## 1. Why this definition exists

`CROSS_MILESTONE_EVIDENCE_CLAIM_AUDIT.md` finding **EV-07** established that the
phrase "independently verified," as attached to S1, T09, S2, S3, S4 (and later
slices), denoted **a separate read-only pass by the same agent** — never review
by a different person or system. The audit named the remedy as **BD-01**: adopt
an explicit, honest definition of "independent verification" as a standing
prerequisite. `P2_ASSURANCE_CAP_DISPOSITION.md` §2 records that BD-01 *"was
recommended but never adopted."*

The absence of a definition has two concrete consequences that this document
removes:

1. A same-agent pass can be **read** as separate-party verification, because
   nothing in the governance record says it is not.
2. A separate-party claim cannot be **tested**, because no evidence standard
   says what would corroborate it.

BD-01 fixes both: it states what the term means, and it states what must be
shown before the term may be used.

---

## 2. Normative definition

**Independent verification** is a verification of a named exact artifact
(commit SHA and tree SHA), performed by a **separate party**, in which **all
eleven** of the following conditions hold. The list is conjunctive: failure of
any one condition means the verification is **not** independent, regardless of
how strong the remaining conditions are.

| # | Condition | Meaning | Failure example |
|---:|---|---|---|
| IV-1 | **Separate legal / personal identity** | The verifier is a natural or legal person distinct from the person(s) who own, direct, fund, or are accountable for the implementation. | Verifier is the owner, an employee, contractor, or agent of the owner. |
| IV-2 | **Separate GitHub identity** | The verifier's GitHub account is distinct from the owner account and from any account that authored, reviewed, approved, or merged the implementation PR; the account is not a bot or integration acting for the owner. | A second account operated by the same principal; `arena-ai-coding-agent[bot]`; the owner's own account. |
| IV-3 | **Non-owner control** | Neither the repository owner nor the implementation team controls the verifier's account, credentials, execution environment, or employment. The verifier can say **no** without the owner's permission. | Owner holds the verifier's credentials, hosts their environment, or can revoke their access at will. |
| IV-4 | **No participation in the implementation under verification** | The verifier did not author, co-author, generate, review, approve, merge, or direct any part of the implementation, its tests, or its verification criteria for the artifact under test. | Implementer verifies their own PR; the agent that wrote the code re-reads it. |
| IV-5 | **No owner direction over the PASS/FAIL judgment** | The owner may supply the target SHA, acceptance criteria, public repository access, and logistical support. The owner may **not** supply, pre-author, request, or influence the conclusion, nor condition anything on a PASS. | Expected results handed to the verifier as the answer; "please confirm E4 PASS." |
| IV-6 | **Independent execution environment** | The verifier executes the verification on hardware/infrastructure they control, not the owner's build farm, sandbox, or CI runner, and not a session spawned by the owner's tooling. | Verification run inside the owner's agent sandbox and reported as independent. |
| IV-7 | **Independent credentials** | Authentication to the repository and to every system touched during verification is the verifier's own; no owner-issued token, deploy key, app installation, or shared secret is used. | Owner-issued PAT used to clone and push the report. |
| IV-8 | **Independent technical judgment** | The verifier decides what to inspect, which commands to run, how to interpret output, and what constitutes a finding. They must be able and willing to record FAIL. | Verifier executes an owner-authored script and transcribes its verdict. |
| IV-9 | **Required provenance / evidence** | The verifier retains, and the report cites, the evidence in §4 for every claimed step. | Report asserts "all tests passed" with no command, exit code, or log. |
| IV-10 | **Disclosure** | The verifier discloses the relationships, assistance, and tooling in §5. | Undisclosed familial relationship; undisclosed AI assistance. |
| IV-11 | **Conflict treatment** | Any relationship in §6 has been disclosed and dispositioned before the verification, not after. | Conflict surfaced post-hoc and quietly dropped. |

**Target identity is part of the definition.** Independent verification is
always *of a named artifact*: exact commit SHA **and** tree SHA, plus the
environment and configuration actually used. Verification of a later tree, of
current `main`, or of a re-created equivalent does **not** verify the named
artifact and may not be recorded as though it did.

---

## 3. Verification classes (what is *not* independent)

The program's existing class vocabulary is retained and made explicit:

| Class | Definition | Satisfies "independent verification"? |
|---|---|---|
| **E4 — separate-party** | Meets IV-1 … IV-11 in full, on the exact artifact. | **Yes** — the only class that does. |
| **PRIMARY / same-agent** | Performed by the implementer or by the same agent/session/principal that produced the artifact, however rigorously. | **No** |
| **Same-principal second pass** | A different session, worktree, account, or agent run controlled by the same principal. | **No** |
| **CI-class** | Reported by a workflow the owner configures and can re-run. | **No** |
| **PR-ATTESTATION** | PR comments, bodies, approvals, reviews, screenshots, chat. Excluded by spec §19 rule 2. | **No** |
| **Inspection** | Reading code or records. Graded per rubric **V3**, never as runtime verification. | **No** |
| **Owner-side preparation** | Kits, harnesses, manifests, dry-runs, and expected-results files built by the owner side. | **No** |

Non-inferable corollaries:

- A **PASS produced by a non-independent run is not a weaker PASS**. It is a
  PRIMARY result and must be labelled PRIMARY.
- **Rigor does not convert class.** A same-agent run that executes every step
  and retains every log is still PRIMARY.
- **A separate identity is not the same as a separate principal.** IV-1 … IV-3
  are about control, not about naming.

---

## 4. Required evidence (burden of proof)

The verifier — not the owner, and not the reader — carries the burden. Each
element below is required in the canonical report; "not recorded" is a finding,
not a blank to be filled by inference.

1. **Identity and independence basis** for IV-1 … IV-3, sufficient for a third
   party to check the separation claim (§5).
2. **Role-history statement** for IV-4: did not author / review / approve /
   merge / direct the implementation, with the PR number named.
3. **Non-direction statement** for IV-5, listing every input received from the
   owner side and confirming no conclusion was supplied.
4. **Environment manifest** for IV-6: OS, kernel, Node/npm/toolchain versions,
   CPU/memory available, hostname or environment identifier, and the fact that
   the environment is verifier-controlled.
5. **Credential basis** for IV-7: which account and authentication path was
   used; no owner-issued credential.
6. **Per-step evidence** for IV-8/IV-9, for every claimed step: the exact
   command, its verbatim output (retained), its **exit status**, UTC start and
   end timestamps, the commit/tree under test at that moment, and relevant
   configuration (provider, seams, database, ports, feature flags).
7. **Machine-readable records** where the step produces them: result records,
   manifests, and the hash of each retained artifact.
8. **Negative assertions**, stated as such: what was asserted *not* to have
   happened (no ALLOW during outage, no duplicate accept, no secret in durable
   rows, no tracked-tree mutation), and how that was checked.
9. **Failures, skips, and limitations** — recorded as observed, with no
   expectation edited to remove them.
10. **Post-execution integrity check** that the named commit/tree are unchanged
    and the tracked working tree is clean, with hashes.
11. **Expected-before-observed separation**: expectations declared before
    execution must be visibly distinct from observations, and divergences must
    be reported rather than reconciled silently.

**Not evidence:** an assertion of independence; a different username; a fork;
read permission; a surname; account age; absence of repository history; a
green CI badge; a screenshot; a PR comment; a chat transcript.

---

## 5. Disclosure requirements

Every verifier report must disclose, whether or not it is adverse:

| Item | Why |
|---|---|
| Any relationship to the owner, the implementation team, or the funding entity — including familial, household, employment, contractual, financial, or organizational ties | A relationship does not by itself disqualify; **concealing** one does. See §6. |
| Any compensation, benefit, or expectation of benefit connected to the outcome | Bears directly on IV-5. |
| Any assistance received from the owner side, itemised (target SHA, criteria, logistics, tooling, scripts) | Distinguishes legitimate logistics from directed conclusions. |
| Any AI, model, agent, or automation used, with tool/model identity, session or job provenance, the instructions material to findings, what the human independently checked, and where the tool could have influenced the result | The accountable verifier remains the human; tooling is never silently relabeled as the separate party. |
| Any deviation from the declared sequence, any skipped step, any environment limitation, any evidence that could not be retained | A gap disclosed is a limitation; a gap concealed is a defect in the verification. |
| Any prior involvement with the program in any role | Bears on IV-4 and on perceived independence. |

---

## 6. Conflicts, and familial / organizational relationships

1. **Disclosure first, disposition second.** A relationship is disclosed before
   the verification begins. It is then dispositioned by the owner of record in
   a written decision that states whether the relationship is compatible with
   IV-1 … IV-3 and on what basis.
2. **Familial or household relationship with the owner.** Not automatically
   disqualifying, and **not** automatically qualifying. It is disqualifying
   where the relationship carries owner control (IV-3) or owner direction
   (IV-5) — for example shared household devices, shared credentials, financial
   dependence on the outcome, or the owner having asked for the result. Where
   it is to be relied upon, the report must show the separation concretely:
   separate device, separate credentials, separate network, no access to the
   implementation environment, and no conclusion supplied.
3. **Organizational relationship** (employer, client, subsidiary, investor,
   contractor, or anyone whose income depends on the program) is treated as a
   presumption **against** independence, rebuttable only by evidence addressing
   control and direction, not by assertion.
4. **Self-declaration is necessary and never sufficient.** A declaration is
   required in every case; it corroborates nothing on its own.
5. **Doubt resolves against the claim.** Where separation cannot be
   corroborated, the verification is recorded at its actual class — PRIMARY,
   same-principal, or "unclassified" — and the gate stays UNSATISFIED. The
   burden is never shifted onto the reviewer to disprove independence.
6. **No accusation is required or permitted.** Failing to corroborate
   independence is not a finding that a person is owner-controlled. It is a
   finding that the evidence is insufficient. Reports must state the evidence
   gap, not an imputation.

---

## 7. Consequences of the definition

1. Any record that uses "independent verification" for a PRIMARY or
   same-principal pass must carry an explicit same-agent disclosure, in the
   form already used by `P2_S7_IMPLEMENTATION_REPORT.md` §12 and
   `P2_S6_INDEPENDENT_VERIFICATION.md` line 3.
2. **E4 credit is receivable only on a report meeting IV-1 … IV-11.** No E4
   credit is inferred from CI success, from a merged PR, from an approval, or
   from the volume of PRIMARY evidence.
3. **A successful independent verification is a technical result, not a
   governance act.** It does not by itself change P2-E4 status, any score, the
   assurance cap, or production readiness; each of those requires separate
   governance action.
4. **Rubric V3/V4/V5 remain in force unchanged.** Inspection is not runtime
   verification; a historical report is not a current artifact; no evidence
   value closes a gate.
5. **No retroactive re-labelling.** This definition does not upgrade any
   existing record. Historical reports keep the class they self-declared, and
   are not rewritten to manufacture independence.

---

## 8. Stop conditions

Stop and report the exact blocker when any of the following is true:

- the verifier's identity or credential control is ambiguous, or cannot be
  corroborated;
- the verifier participated in the implementation in any role (IV-4);
- the verifier is another session, worktree, account, or agent of the same
  principal (IV-2/IV-3);
- the owner supplied, pre-authored, or requested the conclusion (IV-5);
- the execution environment is owner-controlled (IV-6);
- the exact artifact SHA/tree cannot be obtained or established;
- required evidence cannot be retained;
- any required step fails, skips, or diverges from its declared expectation;
- the environment cannot reproduce the required execution;
- a route to PASS requires weakening or redefining E4;
- PRIMARY or CI evidence is offered as E4.

---

## 9. Relationship to existing governance

| Document | Relationship |
|---|---|
| `docs/verification/CROSS_MILESTONE_EVIDENCE_CLAIM_AUDIT.md` §10 (EV-07 / BD-01) | Source of this requirement. This document **answers** it; it does not alter it. |
| `docs/verification/P2_S7_IMPLEMENTATION_REPORT.md` §12 | Provides the honest-limit disclosure wording this definition generalizes. Unchanged. |
| `docs/verification/P2_ASSURANCE_CAP_DISPOSITION.md` | Remains in force. §4.3 (genuine retrospective verification permitted; manufacturing the class forbidden) is fully consistent with IV-1 … IV-11. |
| `docs/P2_PRODUCTION_IDENTITY_PRIVILEGED_PLANE_SPECIFICATION.md` §19 rules 1–5 | Supplies E4/E5 vocabulary and the canonical-evidence rules. This definition refines "separate party"; it does not change §19. |
| `docs/rubric/JATA-P0-95-v1.1.md` V1–V5 | Untouched. V3/V4/V5 continue to govern grading. |
| `docs/verification/P2_S8_INDEPENDENT_VERIFICATION.md` (PR #45) | A separate-party **claim** that predates this definition. This document makes no finding about that report; assessing it against IV-1 … IV-11 is separate work requiring separate authorization. |

---

## 10. STOP

**This document is prepared, not adopted.** It is submitted as a separate,
reviewable governance change and must not be merged without separate explicit
owner authorization.

Merging it would not, by itself:

- recognize P2-E4;
- amend or lift the assurance cap;
- recalculate or republish the `9.484375%` score;
- modify the rubric beyond this definition;
- qualify anything for production;
- authorize P3/S1/S2/S3 implementation.

It would establish the definition against which future independence claims —
including any claim already present in the tree — are to be tested.
