# Frontier Research Safety Foundation

## Status

```text
IMPLEMENTED: tenant-bound research-claim and evidence metadata registry,
             reproducibility-reference checks, evidence hash-chain integrity,
             deterministic uncertainty-aware assessment, regulated-domain
             routing signals, competency-aware human-review quorum records, and
             local configured regulatory-gate requirement evaluation.

NOT IMPLEMENTED: autonomous physical experiments, wet-lab work, fabrication,
                 clinical diagnosis/treatment, aircraft/nuclear/semiconductor
                 operational control, hazardous-material handling, or any
                 safety-critical physical deployment.
```

## `@jataqi/research-evidence`

The current foundation is a governance and provenance registry, not an
experimental execution system. It retains only bounded, high-level metadata:

```text
Research Claim
→ Evidence Record
→ Evidence / Provenance References
→ Reproducibility Record Reference
→ Deterministic Claim Assessment
→ Human Attestation / Competency-Aware Review Quorum
→ Local Configured Regulatory-Gate Evaluation
→ Qualified Human / Regulatory Gate Signal
```

Evidence records are tenant-bound and hash-chained per tenant for local
integrity checking. They contain concise evidence and methodology summaries,
limitations, provenance, and references to existing reproducibility records.
They do not collect evidence, run a workload, access laboratory instruments,
control fabrication equipment, or create an external action.

## Epistemic and reproducibility rules

- A claim remains a hypothesis; `CONDITIONALLY_SUPPORTED` is **not** a
  discovery, universal fact, physical result, or validation claim.
- Simulations must be recorded as `SIMULATED`; simulation-only evidence remains
  `REPRODUCIBILITY_REQUIRED` and is never treated as a physical result.
- Explicitly conflicting evidence remains `CONFLICTING_EVIDENCE`; the service
  does not choose a winner or manufacture a conclusion.
- Conditional support requires at least two current strong evidence records from
  independent sources and a linked `REPRODUCIBLE` reproducibility record.
- Customer confirmation is deliberately not counted as scientific evidence
  strength in this registry.
- The registry stores high-level summaries and references, not raw datasets,
  unrestricted wet-lab synthesis protocols, or executable physical procedures.

## Regulated / hazardous boundary

The following high-level domain labels require
`REGULATED_OR_HAZARDOUS` classification when a claim is created:

```text
LIFE_SCIENCES
MEDICAL
AEROSPACE
NUCLEAR
SEMICONDUCTOR
```

Their assessments always carry:

```text
regulatedWorkRequiresHumanReview = true
nextStep = REQUEST_HUMAN_REVIEW_AND_REGULATORY_GATE
physicalExecutionAuthorization = NOT_AUTHORIZED
```

These are routing signals only. They do not substitute for qualified domain
professionals, institutional safety review, regulatory approval, lab/fab
procedures, equipment interlocks, certification, or legal obligations.

## `@jataqi/human-approval`

The human-approval module provides a separate research-review boundary rather
than reusing the Commercial Control Plane's decision-specific approval flow. It
records tenant-bound, upstream reviewer attestations, competency/review-type
coverage, request expiry, immutable hash-chained votes, rejection, and quorum
progress. It has no identity provider, credential store, external regulatory
integration, policy-write capability, or action executor.

`ORGANIZATION_ASSERTED` is recorded as an upstream attestation; JATA Qi does
not independently verify a reviewer identity, professional license,
qualification, employer, or authority. A regulated/hazardous request requires:

```text
linked regulated research assessment
SAFETY review type
REGULATORY review type
at least two distinct human approvals
ORGANIZATION_ASSERTED reviewer attestations
current measured/demonstrated/repeated/verified evidence for an APPROVE vote
```

Even after the configured quorum is recorded, all approval progress carries:

```text
doesNotAuthorizePhysicalExecution = true
```

so it cannot be used as a physical-execution, clinical, certification, or
regulatory-clearance claim.

## `@jataqi/regulatory-gates`

The regulatory-gates module evaluates **tenant-configured local metadata
requirements** against the existing research-evidence and human-approval
records. It intentionally does not contain jurisdiction-specific legal rules,
provide legal advice, contact an authority, validate an external filing, or
issue a compliance certificate.

A gate is created in `DRAFT` and must be explicitly activated by an
administrator. Its permitted requirement categories are:

```text
RESEARCH_ASSESSMENT
INDEPENDENT_EVIDENCE
REPRODUCIBILITY
HUMAN_APPROVAL
DOCUMENTATION_REFERENCE
EXTERNAL_REGULATORY_CONFIRMATION
```

`EXTERNAL_REGULATORY_CONFIRMATION` is always recorded as:

```text
PENDING_EXTERNAL_VERIFICATION
```

because this checkout has no authority connector or independently verified
external clearance. Even when all configured local checks are satisfied, the
highest local outcome is:

```text
SATISFIED_FOR_REVIEW
isComplianceCertification = false
physicalExecutionAuthorization = NOT_AUTHORIZED
```

It means only that the configured local metadata checklist passed; it is not a
regulatory approval, legal conclusion, safety certification, or permission to
operate a physical system.

## Pending prerequisites before any sensitive-domain expansion

```text
Experiment registry with non-executing plans
Design verification and formal-verification evidence
Risk/incident governance and audit export
Approved, sandboxed simulation orchestration
```

No future module may use this registry as permission to independently execute a
hazardous physical experiment or safety-critical control operation.
