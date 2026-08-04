# JATA Qi Policy & Governance Registry (`@jataqi/policy-governance`)

The centralized, versioned, tenant-aware governance control plane. It sits
**after** authorization and **before** domain modules:

```
SECURITY POLICY → AUTHORIZATION → POLICY & GOVERNANCE → ENTITLEMENTS / ORG / COMMERCE / AGENTS / ...
```

It does **not** replace `@jataqi/security` (RBAC) — it layers declarative,
composable governance on top of it.

## Policy model

A policy carries: `category`, `scope`, `subjectType`, `resourceType`, `action`,
`effect`, declarative `conditions`, `priority`, `version`, `status`,
`createdBy/approvedBy`, `organizationId` (tenant), `effectiveAt/expiresAt`.

**Effects:** `ALLOW`, `DENY`, `REQUIRE_APPROVAL`, `REQUIRE_ROLE`,
`REQUIRE_ENTITLEMENT`, `REQUIRE_CONSENT`, `REQUIRE_HUMAN_REVIEW`.

**Categories (extensible):** SECURITY, ACCESS, ORGANIZATION, COMMERCE, AI, AGENT,
TOOL, DATA, PRIVACY, RETENTION, SAFETY, FINANCE, APPROVAL, USAGE, CREDIT, API,
MARKETPLACE, DEPLOYMENT, AUDIT, GOVERNANCE.

**Scopes (extensible):** GLOBAL, PLATFORM, ORGANIZATION, TEAM, USER, PROJECT,
WORKSPACE, AGENT, WORKFLOW, TOOL, RESOURCE, TRANSACTION, SESSION.

**Conditions (no hard-coded thresholds):** `amountGte/Lte`, `riskMin/Max`,
`dataClassificationIn`, `toolIn/toolNotIn`, `requiredRoles`, `requiredEntitlements`.

## Precedence (deterministic)

```
EXPLICIT DENY  >  MANDATORY SAFETY POLICY  >  LEGAL/COMPLIANCE  >
ORGANIZATION  >  ROLE  >  ENTITLEMENT  >  DEFAULT
```

- Any matched `DENY` denies (safety denies are **not overridable**).
- Among requirements, the strongest is reported: `HUMAN_REVIEW > APPROVAL >
  CONSENT > ENTITLEMENT > ROLE`.
- `ALLOW` permits only when no deny and all requirements are satisfied.
- **Sensitive actions default to DENY** (`finance.*`, `commerce.refund`,
  `deploy.*`, `data.delete`, `agent.autonomous`, `policy.*`, `governance.*`);
  everything else defaults to ALLOW.

## Tenant isolation

`ORGANIZATION`-scoped policies only apply to subjects in that organization. A
user in Org B can never be allowed/denied by Org A's policy, and Org A's deny
cannot affect Org B.

## Integrations

- **Organizations** — evaluation subject includes `organizationId` + org role.
- **Roles** — `REQUIRE_ROLE` checks the subject's platform + org roles.
- **Commerce/entitlements** — `REQUIRE_ENTITLEMENT` checks entitlement keys
  (the gateway builds the subject's entitlements from the active subscription).
- **Approvals** — `REQUIRE_APPROVAL`/`REQUIRE_HUMAN_REVIEW` surface as
  `REQUIRES_APPROVAL` decisions for the existing approval workflows.
- **Notifications** — denials and approval requirements notify the subject
  (non-spammy; only on non-ALLOW enforced decisions).
- **Audit** — every enforced evaluation + override is written to the security
  audit ledger and the `gov.evaluations` history.

## Agent governance & autonomy

`setAgentGovernance` defines per-agent boundaries: allowed/blocked tools &
actions, `maximumBudget`, `maximumIterations`, `allowedDataScopes`,
`humanApprovalRequired`, and a `maxAutonomy` level (L0 information → L5
autonomous). `checkAgent` enforces tool allow/block-lists, autonomy caps,
iteration and budget limits. **Agents never inherit unrestricted permissions
merely because an authorized user created them.** No agent may alter the Creator
Root, disable audit, bypass mandatory policies, or forge approvals.

## Versioning, simulation, overrides

- **Versioning:** updating a policy archives the prior version and writes a new
  one; `GET /gov/policy/versions?id=` returns the full history. Historical
  evaluations record the policy version used.
- **Simulation:** `POST /gov/policies/simulate` (`mode=SIMULATE`) reports the
  decision without side effects (no audit/notify/persistence).
- **Overrides:** temporary, approved, expiring overrides can permit a denied
  action — except mandatory safety denies, which cannot be overridden. Every
  override is audited (`policy.overridden`).

## API (behind `policy:*` permissions)

```
GET    /gov/policies            POST /gov/policies
GET    /gov/policy?id=          POST /gov/policy (update/deactivate by id)
POST   /gov/policies/evaluate   POST /gov/policies/simulate
GET    /gov/policy/versions?id= GET  /gov/evaluations
POST   /gov/agent               POST /gov/agent/check
```

## Honest status

Engine + registry + integrations are **real and tested (14 unit + gateway
tests)**, recorded as `PARTIALLY_IMPLEMENTED` in `GET /readiness` because it is
not yet wired as a *mandatory* enforcement gate on every action across all
runtime modules (tool-intelligence and the orchestrator still enforce their own
gates), and there is no admin UI.
