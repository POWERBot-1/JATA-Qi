# A-01 — Authoritative Agent Capability & Credential Boundary

Status: **implemented, tested (adversarial + regression), NOT a production-readiness claim.**
Baseline: `62f9400` · Branch: `arena/01a07b8c-jata-qi`

A-01 adds ONE authoritative, **fail-closed** policy decision point (PDP) and an
immutable authorization envelope to JATA Qi. Every agent-initiated, externally
consequential invocation is decided by the boundary and enforced at a
checkpoint **before the side effect**. The default is **DENY**. No model
output, prompt content, tool/plugin output, queue message, or caller-supplied
metadata can override a decision.

This document records the architecture, the credential flow, the replay
protection, the **A/B invocation-boundary inventory**, the worker-honesty
position, and the test evidence. It is deliberately not a claim that the
platform as a whole is production-ready; the standing gaps are listed at the
end.

---

## 1. Package: `@jataqi/authorization-boundary`

New workspace (monorepo is now **50** workspaces). Modules:

| File | Responsibility |
| --- | --- |
| `types.ts` | Closed-set types: `A01PrincipalBinding` (T-01/T-02 shape), `A01AuthorizationRequest`, `A01AuthorizationEnvelope`, `A01CapabilityManifest`, `A01ApprovalBinding`, `A01CredentialBinding`, `A01DenialReason` (closed enum), audit record schema. |
| `canonical.ts` | Canonical JSON + SHA-256 digest used for envelope integrity and approval/action binding. |
| `envelope.ts` | `sealEnvelope` (deep-freeze + digest), `assertEnvelopeIntegrity`, `envelopeAcceptance` (substitution/expiry checks). |
| `capability-manifests.ts` | `CapabilityManifestRegistry`: registration-time validation (rejects wildcards, empty allow-lists, unknown ceilings, malformed scope) and **monotonic narrowing** across versions (a new version may never widen operations, targets, tenants, classification, impact, rate, budget, lifetime, or drop approval/credential requirements). |
| `credential-broker.ts` | `CredentialBroker` abstraction + `InMemoryCredentialBroker`. Issuance is bound to principal/tenant/capability/tool/operation/audience/lifetime. `checkFor` (dry-run) and `acquireFor` (single-use per envelope) validate binding, audience, scope, expiry, revocation, and replay. **Secret material is returned only by `acquireFor`, at the enforcement point, for that envelope.** |
| `policy-engine.ts` | `decideA01`: the ordered, fail-closed decision pipeline (structure → principal → tenant → agent/run → capability → tool/operation → target → classification/impact → approval → credential → budget → rate → discretionary engine → audit). Any structural defect is a DENY, not a throw. A discretionary `A01PolicyEngine` that throws or is ambiguous fails closed (`POLICY_ENGINE_UNAVAILABLE` / `AMBIGUOUS_POLICY_RESULT`). |
| `audit.ts` | `A01AuditSink`, `InMemoryAuditSink`, `StorageAuditSink` (durable, privacy-safe: closed field set, credential **reference** only), `CompositeAuditSink`. |
| `gate.ts` | `AuthorizationGate`: the single PDP + enforcement point. `decide()` renders and seals the decision. `executeAuthorized()` re-verifies the sealed envelope, enforces replay/idempotency/budget/credential, then runs the side effect. |
| `worker-boundary.ts` | `runUnderEnvelope` / `WorkerTask`: the wrapper any worker must use before any future externally consequential task. |
| `module.ts` | `AuthorizationBoundaryModule`: installs the gate on container tokens (`authorization.gate`, `.manifests`, `.broker`, `.audit`); durable audit to the `authorization.decisions` storage collection (`durableAudit: false` to opt out). |

### Decision pipeline (fail-closed, closed-set reason codes)

1. **Structure** — non-object / malformed request → `ENVELOPE_MALFORMED`.
2. **Principal** — must be a recognized, server-verified identity (T-01
   `authenticationMethod` + non-blank `authenticationEventId`). Missing →
   `MISSING_PRINCIPAL`; unrecognized method / no auth event → `FORGED_PRINCIPAL`.
3. **Tenant** — must be a non-blank string equal to the principal's tenant.
   Missing → `MISSING_TENANT`; non-string → `NON_STRING_TENANT`; blank →
   `BLANK_TENANT`; mismatch → `TENANT_SUBSTITUTION`. The tenant is **never**
   taken from caller metadata.
4. **Agent / Run** — `MISSING_AGENT`, `MISSING_RUN`.
5. **Capability** — must be registered at the exact version. `UNKNOWN_CAPABILITY`,
   `CAPABILITY_VERSION_MISMATCH`, `MISSING_CAPABILITY`.
6. **Tool / Operation** — must be in the manifest allow-list. `UNKNOWN_TOOL`,
   `OPERATION_NOT_ALLOWED`, `MISSING_OPERATION`.
7. **Target** — system must be allowed; if the manifest demands specific
   resources, an omitted resource is `WILDCARD_ESCALATION` ("no resource" is
   never "all resources"); otherwise `TARGET_NOT_ALLOWED`.
8. **Tenant scope** — outside the manifest's `tenantScopes` (and not an explicit
   wildcard) → `TENANT_OUT_OF_SCOPE`.
9. **Classification / Impact** — above the manifest ceilings →
   `CLASSIFICATION_EXCEEDED`, `IMPACT_EXCEEDED`; unknown values →
   `ENVELOPE_MALFORMED`.
10. **Approval** — when required, an exact-bound, unexpired approval whose
    SHA-256 digest matches the exact action (tenant, principal, agent, run,
    capability, tool, operation, target, classification, impact). Missing →
    `APPROVAL_MISSING`; digest mismatch → `APPROVAL_MISMATCH`; expired →
    `APPROVAL_EXPIRED`.
11. **Credential** — when the manifest requires scopes, a matching credential
    binding is mandatory; the broker validates audience/scope/expiry/binding.
    `CREDENTIAL_REQUIRED/MISSING`, `CREDENTIAL_AUDIENCE_MISMATCH`,
    `CREDENTIAL_SCOPE_INSUFFICIENT`, `CREDENTIAL_EXPIRED`,
    `CREDENTIAL_REVOKED`, `CREDENTIAL_BINDING_MISMATCH`,
    `CREDENTIAL_BROKER_UNAVAILABLE` (an unavailable broker is never "no
    credential required").
12. **Budget / Rate** — per-run budget ceiling (`BUDGET_EXHAUSTED`) and
    per-capability rate window (`RATE_LIMIT_EXCEEDED`).
13. **Discretionary engine** — optional; throws or is ambiguous → fail closed.
14. **Audit** — every decision (ALLOW and DENY) is recorded. A durable sink
    that fails makes the boundary fail closed (see §6).

A DENY is returned as a **sealed DENY envelope** (audited), so a caller can
present the decision without re-querying; a DENY envelope can never be executed.

### Enforcement point (`executeAuthorized`)

For a side effect, the gate:
1. Re-asserts envelope **integrity** (digest) and **acceptance** (ALLOW, not
   expired, tool/operation/target match the expected call). Tamper →
   `ENVELOPE_TAMPERED`/`ENVELOPE_MALFORMED`; substitution →
   `OPERATION_SUBSTITUTION`/`TARGET_SUBSTITUTION`; stale →
   `AUTHORIZATION_EXPIRED`.
2. **Replay**: non-READ decisions are consumed exactly once
   (`REPLAYED_AUTHORIZATION`). READ decisions are idempotent and may repeat.
3. **Idempotency**: a key already consumed by a successful side effect returns
   the cached result without re-execution.
4. **Budget**: per-run consumption within the capability budget
   (`BUDGET_EXHAUSTED`).
5. **Credential**: re-acquired at the enforcement point (single-use per
   envelope); any broker refusal denies before the side effect.
6. Consumes **before** `await` (so concurrent duplicates see the consumption
   synchronously), runs the side effect, then records a `CONSUMED` audit event.

**No fail-open path exists.** Every rejectable condition throws
`AuthorizationDeniedError` (or returns a DENY envelope) before the side effect.

---

## 2. Invocation-boundary inventory (A/B rule)

For every applicable invocation path: **(A)** the central boundary is enforced,
or **(B)** the path is proven unable to perform an externally consequential
operation and documented why. No implicit trust.

### (A) Enforced paths

| Path | Enforced at | Notes |
| --- | --- | --- |
| Agent tool calls (all tools, incl. built-ins) | `ToolRegistry.call` under an installed gate | Undeclared tool → `UNDECLARED_TOOL_AUTHORIZATION`; no envelope → `AUTHORIZATION_ENVELOPE_MISSING`; else `assertEnvelope` + `executeAuthorized` before `tool.execute`. Denial is returned as a model-visible tool error. |
| Agent run loop | `Agent.run` → `renderToolEnvelope` | The envelope request is built **only** from the verified run principal + the tool's declared authorization metadata. No verified principal → fail-closed principal → DENY. |
| Agent built-ins (knowledge/graph/vector/storage read) | `ToolRegistry.call` + `ctxTenantId` | Envelope tenant is authoritative; a conflicting `metadata.tenantId` is `IDENTITY_CONFLICT`. No envelope (legacy) → S-1 metadata tenant (unchanged). |
| Autonomous action execution | `ActionRuntimeService.execute` → `invokeAdapter` | Every external adapter attempt is decided + enforced. **Each retry re-decides** (fresh envelope); a DENY stops the run before external I/O. |
| External connector registration | `ExternalConnectorRegistry.register` → `assertCapabilityBinding` | Installed boundary REQUIRES a capability binding (`UNBOUND_CONNECTOR`); over-privileged action list vs. manifest → `OVER_PRIVILEGED_CONNECTOR`. |
| External connector execution | Via the action-runtime runtime adapter (`connector:<registrationId>`) | Decided/enforced like any action; tool is the concrete adapter id. |
| GitHub execution | Via the action-runtime runtime adapter | `capabilityId`/`capabilityVersion` pass through `ConfigureGitHubExecutionInput` → connection → connector → manifest binding. |
| Test/repair, deployment, copilot loops (external execution) | Via `ActionRuntimeService.execute` | These register adapters and call `runtime.execute`; with a boundary installed their external execution is decided/enforced and **fails closed without a verified principal** (see §4). |
| Queued / retried / replayed action work | Action state machine + per-attempt decision | A successful action is `VERIFYING`; re-execution is refused by the control plane (`cannot start from VERIFYING`). The per-attempt gate decision + per-attempt idempotency key keep a redelivered duplicate from re-executing. |

### (B) Proven non-consequential paths (documented)

| Path | Why it cannot be externally consequential today |
| --- | --- |
| `capability-fabric` | In-repo capability/state service; no external I/O primitives (no fetch/http/spawn). |
| `loop-host`, `unified-loop` | Orchestrates in-process loops and principal snapshots; no direct external I/O; external effects go through the enforced action runtime. |
| `autonomous-venture-factory` | Coordinates state and evidence only; it starts no build/deploy worker and performs no external I/O. |
| Knowledge/graph/vector/storage **data planes** (read) | Tenant-bound, read-only retrieval; the execution tenant is authoritative (envelope or S-1 metadata) and a missing tenant is refused. No write side effect. |
| Commercial control plane, ledger, event stream, memory | Durable **internal** state/ledger writes; not externally consequential I/O. They are the source of the durable action record + idempotency keys that A-01 consumes. |

---

## 3. Credential-flow architecture

- **Abstraction, not a secret provider.** `CredentialBroker` is an interface;
  the repo ships `InMemoryCredentialBroker` (a testable, fail-closed reference).
  A production secret-provider integration is intentionally **not** invented;
  it would implement the same fail-closed contract.
- **No material in the decision.** The request and the sealed envelope carry a
  credential **binding only** (id, audience, scopes) — never material.
- **Material delivered once, at the enforcement point.** `acquireFor(envelope)`
  validates binding/audience/scope/expiry/revocation/replay and returns the
  material to the side effect's scoped context for that envelope only.
- **Never in model context, tool output, audit, or durable state.**
  - Agent tool context exposes the **envelope**, not a credential (a tool cannot
    read `ctx.authorization.credential` — it is `undefined`).
  - Action/connector adapter contexts receive the scoped credential only when
    the decision bound one; the adapter never stores it.
  - Audit records carry a credential **reference** (id/audience/scopes) and are
    schema-restricted; a test asserts no material appears in durable records.
- **Fail-closed.** Unavailable/under-scoped/audience-mismatched/expired/revoked/
  replayed credentials all deny before the side effect.

---

## 4. Worker honesty (no false enforcement claims)

The test/repair workers, copilot task graph, venture factory, and deployment
service currently perform **deterministic in-repo behavior**. They do not
themselves perform raw external I/O.

- Their **externally consequential** executions (where a worker registers an
  adapter and calls `ActionRuntimeService.execute`) are enforced by the A-01
  boundary once it is installed. **Honest consequence:** those `execute` calls
  currently do **not** pass a verified principal, so under an installed boundary
  their external execution **fails closed** (`MISSING_PRINCIPAL`) until the
  wiring supplies a server-verified identity. That is the intended secure
  posture — not a silent allow.
- The **wrapper they must use before any future external I/O** is
  `runUnderEnvelope` / `WorkerTask` (worker-boundary.ts): the gate re-verifies
  and consumes a sealed envelope before the task runs. A worker that calls its
  task body directly (bypassing the wrapper) obtains no envelope and no
  credential, and any credential-bound external call fails closed.
- We do **not** claim the current workers enforce external I/O; we claim the
  boundary exists and is enforced on the paths that do perform external I/O.

---

## 5. Replay / idempotency protection

- **Envelope single-use:** non-READ sealed envelopes are consumed exactly once
  at the gate (`REPLAYED_AUTHORIZATION`); concurrent duplicates see the
  consumption synchronously (consume-before-await).
- **Credential single-use:** a credential is consumed per envelope by the
  broker; a second acquire for the same envelope is `CREDENTIAL_REPLAY`.
- **Idempotency:** a stable key whose side effect already succeeded returns the
  cached result without re-execution. In the action runtime the key is scoped
  **per attempt** (`<actionKey>::attempt-<n>`) so a genuine retry (a fresh
  attempt) re-executes while a redelivered duplicate of the same attempt does
  not.
- **Queue redelivery:** the commercial control plane state machine refuses to
  re-start an action that is already `VERIFYING`; combined with the per-attempt
  decision, a redelivered command cannot re-run the external effect.

---

## 6. Audit (durable, privacy-safe, fail-closed)

- Every **decision** (ALLOW and DENY) and every **consumption** is recorded with
  who/tenant/agent/run/capability/operation/target/decision/policy version/
  impact/approval reference/credential reference/correlation ids/timestamp — and
  **never** raw secrets.
- The durable `StorageAuditSink` enforces a **closed field set** (any unknown
  field is rejected before persistence) and stores only a credential reference.
- **Fail-closed on audit failure:** a synchronously-throwing sink makes the
  decision itself deny (`AUDIT_UNAVAILABLE`). An async-rejecting durable sink
  is tracked **per envelope** and `executeAuthorized` **awaits** that write
  before running the side effect — a failed durable audit rejects the execution
  and latches the gate closed for everything after. There is no window where a
  side effect runs without its durable provenance.

---

## 7. Adversarial + positive test evidence

Gate-level suite: `packages/authorization-boundary/test/a01-adversarial.test.ts`
(plus `a01-core.test.ts`, `a01-module.test.ts`). Wiring suites live in each
enforcing package so the test graph stays acyclic:
- `packages/agent-runtime/test/a01-tool-boundary.test.ts`
- `packages/autonomous-action-runtime/test/a01-action-boundary.test.ts`
- `packages/external-connectors/test/a01-connector-boundary.test.ts`

The ≥42 named cases and where each is proven (every negative asserts the side
effect never ran):

| # | Case | Proven in |
| --- | --- | --- |
| 01 | missing principal | adversarial 01; action-runtime (no principal) |
| 02 | forged principal (unrecognized method / no auth event) | adversarial 02; core (principal substrate) |
| 03 | principal substitution after sealing (tamper) | adversarial 03; core (per-field tamper) |
| 04 | missing tenant | adversarial 04 |
| 05 | blank tenant / non-string tenant | adversarial 05 |
| 06 | tenant substitution (request vs principal) | adversarial 06, 38 |
| 07 | cross-tenant resource (out of scope) | adversarial 07; action-runtime; connector |
| 08 | forged tenant metadata (envelope authoritative) | agent-runtime (envelope tenant, IDENTITY_CONFLICT) |
| 09 | capability version mismatch / unknown capability | adversarial 08 |
| 10 | wildcard / target abuse (omitted resource) | adversarial 10 |
| 11 | operation substitution at enforcement | adversarial 11; agent-runtime |
| 12 | target substitution at enforcement | adversarial 12; agent-runtime |
| 13 | data-classification escalation | adversarial 13 |
| 14 | impact escalation | adversarial 14 |
| 15 | malicious capability manifest (registration) | adversarial 15; core (registry) |
| 16 | plugin permission escalation (manifest widening) | adversarial 16; core (narrowing) |
| 17 | malicious plugin/tool output → authority | agent-runtime (poisoned output grants nothing) |
| 18 | prompt-injection → authority | agent-runtime (model call denied when ungranted) |
| 19 | prompt-injection → secrets | agent-runtime (no credential in tool context/output) |
| 20 | approval replay (different action) | core (approval binding) |
| 21 | expired approval | core (approval binding) |
| 22 | approval/action mismatch | core (approval binding) |
| 23 | credential audience mismatch | adversarial 23; core (broker) |
| 24 | expired credential | adversarial 24; core (broker) |
| 25 | over/under-scoped credential | adversarial 25; action-runtime (under-scoped) |
| 26 | credential replay | adversarial 26; core (broker single-use) |
| 27 | direct-adapter bypass | action-runtime (direct adapter = no authority) |
| 28 | connector bypass | connector (direct connector.execute = no authority) |
| 29 | worker bypass (no sealed envelope) | adversarial 29/29b/29c (worker boundary) |
| 30 | queue replay (redelivery) | adversarial 30; action-runtime (redelivery refused) |
| 31 | retry replay (idempotency) | adversarial 31; action-runtime (per-attempt) |
| 32 | concurrent invocation | adversarial 32; action-runtime (parallel distinct actions) |
| 33 | budget exhaustion | adversarial 33 |
| 34 | rate-limit exhaustion | adversarial 34 |
| 35 | policy-engine failure | adversarial 35 (throwing engine → DENY) |
| 36 | credential-broker failure | adversarial 36 (unavailable broker → DENY) |
| 37 | malformed envelope | adversarial 37; core (integrity) |
| 38 | conflicting authorization metadata | adversarial 38; agent-runtime (IDENTITY_CONFLICT) |
| 39 | model-generated unauthorized action | agent-runtime (ungranted tool denied) |
| 40 | cross-tenant cache/state | agent-runtime built-ins (envelope tenant authoritative; no unscoped read) |
| 41 | unauthorized marketplace extension | connector 41a/41b/41c (unbound / ungranted / over-privileged) |
| 42 | unauthorized external side effect (no grant) | adversarial 42; action-runtime (no manifest → no I/O) |

Positive controls: granted invocation runs exactly once with audit
DECISION+CONSUMED and no material in audit; READ envelopes are idempotent;
expired envelopes are refused at enforcement; healthy module path works end to
end; legacy no-boundary paths are byte-for-byte unchanged.

---

## 8. Remaining limitations (honest, production not claimed)

- A-01 enforces **agent-initiated, externally consequential** invocations at the
  checkpoint. It is **not** a full prompt-injection defense program, and we do
  not claim one.
- No production secret-provider is integrated; the broker is a fail-closed
  abstraction with an in-memory reference implementation.
- Worker external-execution paths (test/repair, deployment, copilot) currently
  do not supply a verified principal, so they fail closed under an installed
  boundary; wiring a verified identity end to end is follow-up work.
- The boundary is **composition-opt-in at the root**: a composition that does
  not install `AuthorizationBoundaryModule` has no boundary, and its
  externally consequential paths are the documented, blocked set. Installing
  the module is the composition-root obligation for any system performing
  externally consequential operations.
- Standing platform gaps (sandboxing, SSRF, SAML/MFA, backups, red-team
  platform, JATA models, marketplace trust) are **out of scope**; the boundary
  is where they will attach.

**This is not a production-readiness claim.**
