# JATA Quantum Brain — v0.1 Cognitive Foundation

## Scientific-integrity status

```text
IMPLEMENTED: classical cognitive state and classical Bayesian probability.
SUPPORTED METADATA: QUANTUM_INSPIRED.
NOT IMPLEMENTED: quantum hardware execution, quantum-native cognition,
quantum advantage, artificial consciousness, AGI, or superintelligence.
```

## Implemented packages

### `@jataqi/cognitive-kernel`

A tenant-bound persistent cognitive-state service containing:

- observations with modality, epistemic status, confidence, and provenance;
- beliefs with probability, assumptions, dependencies, temporal validity, and
  contradiction status;
- goals and constraints;
- safe cognitive traces;
- deterministic evidence/uncertainty assessment;
- tenant isolation and filesystem persistence.

Safe traces contain only auditable summaries:

```text
input summary
→ observation references
→ belief references
→ assumptions
→ alternatives
→ conclusion summary
→ uncertainty summary
→ confidence
→ provenance
```

They do **not** contain hidden chain-of-thought or claim to expose an internal
reasoning trace.

### `@jataqi/probabilistic-engine`

A classical implementation of:

- normalized hypothesis sets;
- Bayesian update;
- Shannon entropy;
- expected information gain;
- deterministic top-hypothesis/beam selection;
- malformed/impossible-evidence rejection.

`QUANTUM_INSPIRED` is a mathematical metadata label only. This implementation
runs on classical JavaScript and makes no quantum-hardware or quantum-advantage
claim.

### `@jataqi/hypothesis-engine`

A persistent bridge between the two foundations:

```text
Cognitive state
→ competing hypothesis set
→ classical Bayesian evidence revision
→ linked cognitive belief update
→ safe uncertainty-aware assessment
```

It retains competing explanations, records revision provenance and entropy/
information-gain values, and ranks candidate information plans without collecting
information or executing an action. Posterior probabilities remain hypotheses,
not proof.

### `@jataqi/world-model`

A separate tenant-bound symbolic world model with explicit entities, relations,
events, provenance, temporal validity, uncertainty status, and bounded graph
traversal. Its relation contract differentiates:

```text
ASSOCIATION
CAUSAL_HYPOTHESIS
CAUSAL_EVIDENCE
```

Causal evidence requires an explicit method plus independent strong evidence;
association is never silently represented as proof of causation.

### `@jataqi/causal-engine`

A classical local-linear structural causal model layer that supports explicit
DAG edges and bounded intervention/counterfactual scenarios. Its output is always:

```text
SIMULATED
method = CLASSICAL_LINEAR_STRUCTURAL_CAUSAL_MODEL
```

It cannot perform causal discovery or real-world intervention. Causal edges
require declared assumptions, evidence, methodology, cycle-free topology, and
bounded variable values.

### `@jataqi/temporal-engine`

A tenant-bound event timeline with explicit occurrence time, validity intervals,
causation ordering, deterministic replay, and separate supplied future branches.
Every future branch is marked:

```text
simulated = true
method = EXPLICIT_SCENARIO_TIMELINE
```

The engine does not forecast the future or promote a scenario into an observed
fact.

### `@jataqi/reproducibility`

A versioned metadata and hash registry for experiments, simulations, benchmarks,
analyses, and model evaluations. It records dataset/algorithm/environment
references, parameters, deterministic/seed metadata, canonical input fingerprints,
and output hashes. A supplied comparison can be marked:

```text
RECORDED
REPRODUCIBLE
MISMATCH
INCOMPLETE
```

It does not execute a workload or claim a physical/independent replication.

### `@jataqi/multi-agent-cognition`

A tenant-bound, persistent structured-critique layer linked to an existing
cognitive state. It has an empty reviewer registry by default: reviewers are
application-injected and are called only through an explicit service method.
The service itself includes no LLM, external connector, credential, execution
adapter, background worker, or tool handle.

It retains concise structured reviewer messages with:

```text
hypothesis
→ evidence references
→ assumptions
→ confidence
→ non-executing proposed-action disposition
→ uncertainty
→ verdict and safe conclusion summary
```

The layer deterministically records evidence quality, role coverage,
claim/verdict/action disagreement, and advisory safety review before producing
a synthesis. A synthesis always states:

```text
hypothesisStatus = RETAINED_AS_HYPOTHESIS
executionAuthorization = NOT_AUTHORIZED
```

`NO_CONCERN_RECORDED` in a safety review is not a safety approval, operational
authorization, physical-world clearance, or certification. Host applications
must constrain and sandbox any injected reviewer implementation; this package
cannot turn an untrusted in-process reviewer into a safe sandbox.

### `@jataqi/meta-reasoning`

A persistent, tenant-bound classical meta-reasoning layer that records supplied
forecasts, immutable evidence-backed forecast evaluations, Brier/absolute error,
historical calibration, exact-key contradiction signals, and historical model
comparisons. It does not invoke a model, collect evidence, select a model,
change a policy, or execute an action.

An inconclusive multi-agent synthesis is mapped to the explicit outcome:

```text
I_DO_NOT_KNOW
```

rather than an invented answer. Calibration requires a configured minimum number
of scored, supplied binary evaluations; otherwise it is explicitly labelled:

```text
INSUFFICIENT_DATA
```

Autonomy output is advisory-only and can only retain or lower the caller-supplied
ceiling. Every recommendation carries:

```text
requiresHumanPolicyReview = true
executionAuthorization = NOT_AUTHORIZED
```

It cannot mutate the Commercial Control Plane or bypass separate policy,
permission, budget, consent, approval, or verification gates.

## JATA Qi permanence fabric

`@jataqi/permanence-fabric` adds a separate, classical public-key continuity
foundation for the requested JQ-ID/JQ-UIP architecture. It records public keys,
signed opaque state references, bounded runtime authorizations/attestations,
lineage, and non-executing handover plans without treating domains, VPSs, cloud
providers, or interfaces as identity authority. It does not store private keys,
perform runtime migration, or claim quantum computation or guaranteed
permanence. See [`docs/PERMANENCE_FABRIC.md`](PERMANENCE_FABRIC.md) for the
trust-anchor, state-conflict, key-rotation, and resolver boundaries.

## JQ capability fabric

`@jataqi/capability-fabric` now provides a tenant-bound, non-executing
JQ-CAP/JQ-UCR registry for separately governed capabilities and
machine-readable ENGINE_GENOME records. It distinguishes capability existence,
lifecycle availability, scoped actor grants, root-authorized runtime
requirements, and actual execution authorization. It does not generate,
install, deploy, or execute engines; physical/high-impact capability activation
is blocked. See [`docs/CAPABILITY_FABRIC.md`](CAPABILITY_FABRIC.md) for the
lifecycle, composition, audit, and safety boundaries.

## Orbital intelligence foundation

`@jataqi/orbital-intelligence` is a separate provider-neutral, authorized-reference
observation metadata layer linked to the tenant-bound World Model and Temporal
Engine. It has no live provider, imagery, tasking, computer-vision, target
selection, or physical-control capability and makes no claim of satellite or
restricted-data access. See [`docs/ORBITAL_INTELLIGENCE.md`](ORBITAL_INTELLIGENCE.md)
for data-provenance, epistemic, and safety boundaries.

## Frontier research safety foundation

`@jataqi/research-evidence` is now a separate tenant-bound provenance and
assessment registry for future research workflows. It stores high-level,
evidence-backed claim metadata and reproducibility references only; it does not
perform or authorize physical experiments. See
[`docs/FRONTIER_RESEARCH_SAFETY.md`](FRONTIER_RESEARCH_SAFETY.md) for its explicit
regulated-domain, human-review, and physical-execution boundaries.

## Epistemic discipline

Every cognitive observation/belief remains explicitly classified:

```text
OBSERVED
INFERRED
HYPOTHESIZED
SIMULATED
UNKNOWN
```

No simulated or hypothesized item is automatically promoted to an observed fact.
Conflicting versions of the same proposition are retained and marked rather than
overwritten.

## Pending JQB phases

```text
Quantum backend abstraction/simulation
Benchmark harness
Controlled evolution sandbox
```

Any future physical quantum integration must retain a classical baseline,
reproducibility metadata, cost/latency accounting, and independent measurement
before any claim of quantum advantage.
