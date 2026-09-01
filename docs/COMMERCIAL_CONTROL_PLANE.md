# JATA Qi Commercial Control Plane

## Status

| Status | Capability |
|---|---|
| **IMPLEMENTED** | Storage-backed commercial decisions, policy evaluation, approvals, resource budgets, state transitions, consent checks, connector capability/health checks, evidence-bound experiment measurements/conclusions with limit stops, versioned events, and a per-tenant hash-chained action ledger. |
| **IMPLEMENTED** | `@jataqi/autonomous-action-runtime`: explicit adapter registration, idempotent planning, bounded retry/timeout handling, dry-run isolation, independent verification, and confirmed rollback recording. |
| **IMPLEMENTED** | `@jataqi/external-connectors`: inactive-by-default connector registry with capability discovery, health activation, credential references, contract reports, and controlled runtime-adapter lifecycle. |
| **IMPLEMENTED** | `@jataqi/github-execution`: injected-client GitHub connector boundary. It models `BLOCKED_CREDENTIALS`, `BLOCKED_PERMISSION`, `READY_FOR_APPROVAL`, `CONNECTED`, and evidence-backed `LIVE_VERIFIED` states without bundling or reading GitHub credentials. |
| **IMPLEMENTED** | `@jataqi/copilot-execution-adapter`: persistent engineering task graph with dependency/capability checks, bounded injected workers, dry-run defaults, and action-runtime verification before task completion. |
| **IMPLEMENTED** | `@jataqi/autonomous-test-repair`: profile-governed test/repair runs that capture diagnostics and repair proposals but cannot apply code changes implicitly. |
| **IMPLEMENTED** | `@jataqi/autonomous-deployment`: adapter-only deployment records with pre-deployment evidence, environment gates, required health verification, and confirmed rollback recording. |
| **IMPLEMENTED** | `@jataqi/infrastructure-state-registry`: provider-neutral infrastructure records for VPS/cloud/DNS/TLS/etc., with expected-vs-observed state, health verification, drift classification, and no implicit remediation. |
| **IMPLEMENTED** | `@jataqi/payments` → `@jataqi/billing` → `@jataqi/revenue-ledger` → `@jataqi/reconciliation` → `@jataqi/commercial-analytics`: provider-neutral payment intents, invoices/subscriptions, verified-payment-only revenue recognition, refund reversals, external-state reconciliation, and evidence-classified economic observations. |
| **IMPLEMENTED** | `@jataqi/universal-visibility-fabric` → `@jataqi/universal-distribution-nervous-system`: claim/evidence/brand-governed creative assets and connector-aware distribution plans that distinguish JATA-controlled choices from external platform delivery/reach. |
| **IMPLEMENTED** | `@jataqi/commercial-intelligence`: evidence-bound opportunity scores/ranges, explicit `WAIT_FOR_EVIDENCE` / `DO_NOT_PURSUE` / `HUMAN_REVIEW` outcomes, and hard-blocker commercial readiness gates. |
| **IMPLEMENTED** | `@jataqi/autonomous-venture-factory`: persistent discovered→validated→approved→designed→building→testing→sandbox→staging→production lifecycle with explicit evidence, approved-decision, and GO-readiness gates; it does not claim actual build/deployment/customer completion. |
| **IMPLEMENTED** | `@jataqi/portfolio-governor`: configurable winner/promising/stable/pivot/retire classification and recommendation-only resource prioritization; any allocation still requires a separate control-plane action. |
| **IMPLEMENTED** | `@jataqi/commercial-memory`: tenant-isolated hash-chained institutional records, decision/outcome feedback, prohibited-strategy memory, and explicit correlation/causation links. |
| **IMPLEMENTED** | `@jataqi/commercial-health`: evidence-bound anomaly/drift detection and containment recommendations; pause/contain/escalate actions still require the Commercial Control Plane. |
| **IMPLEMENTED** | `@jataqi/commercial-observability`: privacy-minimized CCP event projections, correlation traces, evidence-classified metrics, local alert/incident records, and command-center projection; it has no external exporter or automatic remediation capability. |
| **IMPLEMENTED** | `@jataqi/commercial-event-stream`: explicit manual-pump processing of versioned commercial events with runtime contract validation, idempotent delivery records, bounded exponential retries, replay, and persisted dead-letter/schema-rejected states. |
| **IMPLEMENTED** | `@jataqi/commercial-command-center`: read-only tenant-filtered operational aggregation and approval facade; approval resolution delegates to the existing Commercial Control Plane rather than bypassing it. |
| **VERIFIED** | `docs/THREE_PRODUCT_SANDBOX_ACCEPTANCE.md` documents the controlled e-commerce, school-management, and restaurant-ordering lifecycle test; it is explicitly not a live product/deployment/payment/customer acceptance claim. |
| **VERIFIED** | Unit/integration tests cover default-deny behavior, approval flow, budget block, consent/connector gates, lifecycle transitions, durable ledger reload, tenant isolation, dry-run behavior, retries, timeouts, and adapter activation/deactivation. |
| **PENDING** | Real provider implementations, production secret management, distributed queues/DLQ workers, external metrics/traces/log exporters and alert delivery, payment/billing/revenue adapters, SEA/UVF/UDNS integrations, and an approval UI. |
| **PENDING_EXTERNAL_ACCESS** | GitHub, cloud, DNS/TLS, payment, advertising, messaging, marketplace, and other external operations require authorized credentials and provider-specific adapters. |

## Boundary model

```text
signal/evidence
  -> commercial decision
  -> policy + risk + compliance + budget + consent + connector checks
  -> approval when required
  -> planned action
  -> explicit adapter execution or dry-run simulation
  -> reported response (VERIFYING, never automatically COMPLETE)
  -> independent verification
  -> completed/failed/rolled-back state
  -> durable event + hash-chained ledger + future learning input
```

The control plane deliberately owns the final state and authorization boundary. An
adapter cannot mark an action `COMPLETED` directly. A reported executor response
only advances an action to `VERIFYING`; `COMPLETED` requires verification evidence.

## Default safety posture

- No matching autonomy policy means no real autonomous execution.
- A dry run is the default action mode.
- A policy may cap autonomy level, action types, risk, compliance, evidence
  strength, per-action cost, and require simulation or approval.
- Budgets are evaluated before an action is planned and include reserved in-flight
  action requirements.
- Communication decisions require an active purpose/channel consent record.
- Connector-backed decisions require a registered, `HEALTHY` connector that
  explicitly declares the requested action capability.
- Product and campaign states transition only through explicit recorded state
  transitions.
- An active matching kill switch takes precedence over otherwise valid policy.
- The action ledger is hash-chained per tenant and can be checked for continuity
  and payload tampering.

## Commercial observability boundary

`@jataqi/commercial-observability` subscribes to the CCP's canonical stored-event
notification and stores only a privacy-minimized projection:

```text
event metadata
→ hashed correlation/entity references
→ payload field count (never payload values)
→ correlation trace
```

It separately accepts explicitly classified `OBSERVED`, `MEASURED`, and
`SIMULATED` metric samples. Simulated metrics do not raise an alert unless an
administrator explicitly opts a local alert rule into simulated inputs. Alerts
and incidents are local records only:

```text
metric → local alert → human-reviewed incident record
```

They do not pause a campaign, change a budget, execute a rollback, send a
notification, or claim external recovery. Any consequential containment action
must still be proposed and authorized through the CCP.

## Experiment registry and stopping boundary

The existing CCP experiment registry now retains explicit evidence-bound metric
measurements in addition to cost records. Measurements are classified as:

```text
OBSERVED
MEASURED
SIMULATED
```

Only non-simulated measurements can automatically stop a running experiment at
an explicitly configured audience-exposure, message-frequency, downside, or
unambiguously directed primary-metric threshold. A `SCALED` experiment is only
a stored experimental conclusion—never permission to increase spend, publish,
or execute. Any resulting commercial action must restart at the normal CCP
proposal, policy, authorization, budget, approval, and verification boundary.

## External connector contract

No live connector ships with JATA Qi. A connector must explicitly provide:

```ts
interface ExternalConnector {
  id: string;
  providerId: string;
  providerType: string;
  targetSystem: string;
  environment: 'sandbox' | 'production';
  credentialReference?: string; // Reference only, never the secret value.
  capabilities(context): Promise<ConnectorCapability>;
  health(context): Promise<ConnectorHealthReport>;
  execute(context): Promise<AdapterExecutionResult>;
  verify(context): Promise<AdapterVerificationResult>;
  rollback?(context): Promise<{ confirmed: boolean }>;
}
```

Registration does not connect, authenticate, publish, send, charge, provision, or
deploy anything. Activation is explicit and only makes an adapter executable after
connection/authentication (when supplied), capability discovery, and a healthy
result. In production, connector implementations must use a secret-management
reference and must not pass raw credentials to model prompts or ledger/event data.

## What is not claimed

This implementation does **not** claim live GitHub execution, deployment,
DNS/TLS success, payment success, advertising publication, customer acquisition,
or revenue. The local tests use controlled sandbox adapters only. Provider-side
success must remain `VERIFYING` until an adapter supplies independent evidence.

## Integration path

Future SEA, UVF, UDNS, billing, revenue-ledger, payment, portfolio, and learning
modules should exchange the versioned `CommercialEvent` contract and submit all
consequential actions through:

1. `CommercialControlPlaneService.proposeDecision()`
2. `CommercialControlPlaneService.authorizeDecision()`
3. approval resolution when required
4. `ActionRuntimeService.plan()`
5. `ActionRuntimeService.execute()`
6. `ActionRuntimeService.verify()`

No future connector or autonomous agent should bypass this sequence.
