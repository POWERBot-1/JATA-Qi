# JATA Qi Capability Fabric — JQ-CAP / JQ-UCR Foundation

## Status

```text
IMPLEMENTED: tenant-bound capability registry, machine-readable ENGINE_GENOME
             metadata, lifecycle evidence gates, scoped capability grants,
             runtime-capability requirement checks against JQ-ID runtime
             authorizations, composition/dependency graph, hash-chained audit,
             tenant isolation, and filesystem persistence.

NOT IMPLEMENTED: autonomous capability discovery, package installation, model
                 procurement, engine code generation, deployment, marketplace
                 publication, engine execution, hardware allocation, physical
                 actuation, production certification, or unrestricted
                 self-modification.
```

## Boundary

`@jataqi/capability-fabric` is the local registry and governance layer for
JATA Qi's requested Universal Capability Registry and Engine Genome concepts.
It does not make a capability executable merely because its metadata is
registered.

```text
PROPOSED
→ DISCOVERED
→ REGISTERED
→ VERIFIED
→ SANDBOXED
→ CERTIFIED
→ AVAILABLE
→ ACTIVE
→ MONITORED
→ UPDATED / RETIRED / BLOCKED
```

Each transition is explicit. Verification-sensitive lifecycle states require
attached evidence. `CERTIFIED` only means a configured local registry lifecycle
state supported by supplied evidence; it is **not** a legal, safety, clinical,
security, or external certification claim.

## Capability versus authority

A capability contains its own lifecycle, safety class, risk score, required
permission IDs, required runtime capabilities, dependencies, verification
method, audit requirements, provenance, and authorization-policy summary.

Access is assessed separately:

```text
CAPABILITY EXISTS
≠
CAPABILITY AVAILABLE
≠
ACTOR HAS SCOPED GRANT
≠
AUTHORIZED RUNTIME EXISTS
≠
EXECUTION IS AUTHORIZED
```

The strongest local assessment is:

```text
AVAILABLE_AND_AUTHORIZED
```

and it always carries:

```text
doesNotAuthorizeExecution = true
```

A separate action/runtime/governance boundary must still authorize any actual
engine or tool execution.

## JQ-ID/runtime integration

A capability may link to an existing tenant-bound JQ-ID from
`@jataqi/permanence-fabric`. When it declares runtime requirements, access
assessment requires a current root-authorized runtime record whose declared
capabilities cover the request. The registry does not treat a runtime record as
proof of real compute availability, provider connectivity, or operational
health.

## ENGINE_GENOME

An engine genome is a machine-readable, non-executable specification with:

```text
engine identity / version / capabilities / composition
input and output schema references
state / memory / compute / data / tool / sensor / actuator requirements
model/API dependencies
security / resource / authorization policy summaries
latency / reliability / cost / energy profiles
validation / failure / observability requirements
owner / provenance / lifecycle state
```

Engine composition uses explicit graph links and rejects cycles. Engines cannot
become locally available or active until their referenced capabilities and
composed engines are locally available.

## Physical/high-impact boundary

`CLASS_3_PHYSICAL_OR_HIGH_IMPACT` capability and engine metadata may be
represented for planning and simulation governance, but the registry refuses
to activate it. Any engine declaring an actuator must use that class and cannot
activate here.

```text
CLASS_3 capability/engine
→ BLOCKED_SAFETY_REVIEW
→ separate safety, regulatory, human-approval, simulation,
  execution, verification, and physical interlock requirements
```

No physical-world, medical, laboratory, nuclear, aerospace, robotics,
industrial, security-sensitive, or financial action is created by this module.

## Next safe steps

```text
Capability/engine verification evidence adapters
Non-executing engine conception and capability-gap analysis
Sandbox-only engine validation plans
Cross-registry read-only capability projections
Explicit model/tool registry adapters with provider capability checks
```
