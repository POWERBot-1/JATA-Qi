// A-01 policy decision point (PDP).
//
// This is the SINGLE authoritative place where authorization decisions are
// rendered. DEFAULT = DENY: the outcome starts as a DENY with accumulated
// reason codes and is only upgraded to ALLOW when every mandatory check
// passes. Any exception, ambiguity, or unavailable dependency keeps the
// outcome DENY. The discretionary policy engine, when configured, can only
// ADD denials; it can never convert a mandatory denial into an allow.
//
// Identity inputs are the T-01/T-02 substrate (verified principals and their
// durable snapshots). Model output, prompts, and caller-supplied metadata are
// not inputs to this function at all — the gate constructs requests only from
// verified identities and declared tool/adapter metadata.

import { isAuthenticationMethod, classifyPrivilegedA01 } from '@jataqi/authentication';
import { targetMatches } from './capability-manifests.js';
import { a01ActionDigest } from './canonical.js';
import type { CapabilityManifestRegistry } from './capability-manifests.js';
import type {
  A01ApprovalBinding,
  A01AuthorizationRequest,
  A01CapabilityManifest,
  A01CredentialBinding,
  A01DecisionRecord,
  A01DenialReason,
  A01ProvenanceBinding,
  A01PolicyEngine,
  CredentialBroker,
} from './types.js';
import { A01_CLASSIFICATION_ORDER, A01_IMPACT_ORDER, PermissiveBaselinePolicyEngine } from './types.js';

export interface A01PolicyContext {
  /** Injectable clock (ms). */
  readonly now: number;
  readonly manifests: CapabilityManifestRegistry;
  readonly broker?: CredentialBroker;
  readonly engine?: A01PolicyEngine;
  readonly policyVersion: string;
  /**
   * Decisions already rendered inside this capability's rate window for the
   * (tenant, principal, capability) key. Provided by the gate's rate state.
   */
  readonly rateWindowUsage?: (key: { tenantId: string; principalId: string; capabilityId: string }) => number;
  /**
   * R1/D2: verifier for kernel-internal service principals. Supplied by the
   * gate from the process's `KernelInternalIdentity`. It returns true ONLY
   * for a principal this process actually minted, for the exact scope named.
   * A forged, foreign, or re-scoped kernel principal fails.
   *
   * Its ONLY effect is described at the tenant check below: it does not skip
   * any other check and never converts a DENY into an ALLOW on its own.
   */
  readonly verifyKernelPrincipal?: (principal: unknown, scope: string) => boolean;
  /**
   * P2-S3 privilege stage. When the request's (tool, operation) is a
   * registered privileged operation, the stage returns the elevation
   * denial codes (empty = a valid elevation was verified). The durable
   * decider pre-resolves the verdict inside its Phase-B transaction and
   * passes a producer that returns that verdict. Absent producer + a
   * privileged operation ⇒ `PRIVILEGE_CHECK_UNAVAILABLE` (fail-closed:
   * no ambient privilege authority exists).
   */
  readonly privilegeStage?: (tool: string, operation: string) => readonly A01DenialReason[];
}

export interface A01DecisionResult {
  readonly decision: A01DecisionRecord;
  readonly provenance: A01ProvenanceBinding;
  /** Set only when the manifest requires credentials and the request presented a binding. */
  readonly credential?: A01CredentialBinding;
  readonly manifest: A01CapabilityManifest;
  /** The budget cost units this decision consumes (default 1). */
  readonly budgetCostUnits: number;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Render the authoritative decision for one invocation. Never throws on a
 * rejectable condition: a structural defect is a DENY, and an internal
 * defect (e.g. a broken registry) is a DENY with POLICY_ENGINE_UNAVAILABLE.
 */
export function decideA01(request: unknown, ctx: A01PolicyContext): A01DecisionResult {
  try {
    return renderDecision(request, ctx);
  } catch {
    // A real internal defect is an unavailable policy engine, not a pass.
    const now = ctx.now;
    return {
      decision: {
        decisionId: `dec-${now}-${Math.random().toString(36).slice(2, 10)}`,
        decision: 'DENY',
        reasonCodes: Object.freeze(['POLICY_ENGINE_UNAVAILABLE'] as const),
        policyVersion: ctx.policyVersion,
        decidedAt: now,
        expiresAt: now,
        budgetCostUnits: 1,
      },
      provenance: Object.freeze({ source: 'authorization-boundary', correlationId: '', createdAt: now }),
      manifest: FALLBACK_MANIFEST,
      budgetCostUnits: 1,
    };
  }
}

function renderDecision(request: unknown, ctx: A01PolicyContext): A01DecisionResult {
  const now = ctx.now;
  const reasons = new Set<A01DenialReason>();
  const engine = ctx.engine ?? new PermissiveBaselinePolicyEngine();
  /** Set only when a VERIFIED kernel worker principal acts for another tenant. */
  let kernelWorkerTenancy = false;

  // 1. Structural request validity ------------------------------------------------
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return denyAll(reasons, 'ENVELOPE_MALFORMED', ctx, now, 1);
  }
  const req = request as Record<string, unknown>;
  const principalRaw = req.principal;
  const tenantRaw = req.tenantId;
  const agentRaw = req.agent as { agentId?: unknown } | undefined;
  const runRaw = req.run as { runId?: unknown; correlationId?: unknown; causationId?: unknown } | undefined;
  const capabilityRaw = req.capability as { capabilityId?: unknown; capabilityVersion?: unknown } | undefined;
  const toolRaw = req.tool;
  const operationRaw = req.operation;
  const targetRaw = req.target as { system?: unknown; resource?: unknown; audience?: unknown } | undefined;
  const costRaw = req.budgetCostUnits === undefined ? 1 : req.budgetCostUnits;

  const requestOk =
    principalRaw !== undefined &&
    typeof principalRaw === 'object' &&
    !Array.isArray(principalRaw) &&
    agentRaw !== undefined &&
    typeof agentRaw === 'object' &&
    runRaw !== undefined &&
    typeof runRaw === 'object' &&
    capabilityRaw !== undefined &&
    typeof capabilityRaw === 'object';
  if (!requestOk) {
    reasons.add('ENVELOPE_MALFORMED');
  }

  // 2. Principal (T-01/T-02 substrate) -------------------------------------------
  let principal: { id: string; tenantId: string; roles: string[]; authenticationMethod: string; authenticationEventId: string } | undefined;
  if (!requestOk || !principalRaw || typeof principalRaw !== 'object') {
    reasons.add('MISSING_PRINCIPAL');
  } else {
    const p = principalRaw as Record<string, unknown>;
    if (!nonBlank(p.id) || !nonBlank(p.tenantId)) {
      reasons.add('MISSING_PRINCIPAL');
    } else if (
      !isAuthenticationMethod(p.authenticationMethod) ||
      !nonBlank(p.authenticationEventId) ||
      !Array.isArray(p.roles)
    ) {
      // Present but not a recognized server-verified principal: forged.
      reasons.add('FORGED_PRINCIPAL');
    } else {
      principal = {
        id: p.id,
        tenantId: p.tenantId,
        roles: p.roles.filter((role): role is string => typeof role === 'string'),
        authenticationMethod: p.authenticationMethod,
        authenticationEventId: p.authenticationEventId,
      };
    }
  }

  // 3. Tenant ----------------------------------------------------------------------
  if (tenantRaw === undefined || tenantRaw === null) {
    reasons.add('MISSING_TENANT');
  } else if (typeof tenantRaw !== 'string') {
    reasons.add('NON_STRING_TENANT');
  } else if (tenantRaw.trim().length === 0) {
    reasons.add('BLANK_TENANT');
  } else if (principal && tenantRaw !== principal.tenantId) {
    // R1/D2 — PLATFORM WORKER TENANCY.
    //
    // Normally this is tenant substitution and is denied outright. There is
    // exactly ONE narrow exception, and it is a VERIFIED one, not a claim:
    // a kernel-internal service principal that this process actually minted,
    // for the `kernel:internal-execution` scope, acting under a capability
    // whose manifest is DELIBERATELY system-scoped (allowTenantWildcard).
    //
    // Platform workers (payments settlement, billing, deployment, …) act for
    // every tenant on the instance by design; the tenant on each decision
    // comes from the durable action record, not from caller metadata.
    //
    // This is NOT a bypass: the principal must verify cryptographically
    // against the process authority, the capability must exist, the manifest
    // must be explicitly system-scoped, and every other check below
    // (operation allow-list, target, classification, impact, rate, budget,
    // replay, audit) still applies in full. A kernel principal without a
    // matching manifest is denied exactly like any other principal.
    const kernelWorkerVerified =
      principal.authenticationMethod === 'KERNEL_INTERNAL' &&
      ctx.verifyKernelPrincipal?.(principalRaw, 'kernel:internal-execution') === true;
    if (!kernelWorkerVerified) {
      reasons.add('TENANT_SUBSTITUTION');
    } else {
      kernelWorkerTenancy = true;
    }
  }
  const tenantId = typeof tenantRaw === 'string' ? tenantRaw : '';

  // 4. Privilege stage (P2-S3) — ordered AFTER principal/tenant validation and
  // BEFORE capability evaluation (spec §7.2). Classification is register-driven
  // (data in code) — never caller-controlled. A registered privileged operation
  // requires a valid durable elevation; without a configured privilege stage the
  // decision is PRIVILEGE_CHECK_UNAVAILABLE (fail-closed, no ambient authority).
  const tool = typeof toolRaw === 'string' ? toolRaw : '';
  const operation = typeof operationRaw === 'string' ? operationRaw : '';
  if (classifyPrivilegedA01(tool, operation) !== undefined) {
    if (!ctx.privilegeStage) {
      reasons.add('PRIVILEGE_CHECK_UNAVAILABLE');
    } else {
      for (const code of ctx.privilegeStage(tool, operation)) reasons.add(code);
    }
  }

  // 5. Agent + run -----------------------------------------------------------------
  if (!agentRaw || typeof agentRaw.agentId !== 'string' || agentRaw.agentId.trim().length === 0) {
    reasons.add('MISSING_AGENT');
  }
  if (!runRaw || typeof runRaw.runId !== 'string' || runRaw.runId.trim().length === 0) {
    reasons.add('MISSING_RUN');
  } else if (typeof runRaw.correlationId !== 'string' || runRaw.correlationId.trim().length === 0) {
    reasons.add('MISSING_RUN');
  }
  const agentId = agentRaw && typeof agentRaw.agentId === 'string' ? agentRaw.agentId : '';
  const runId = runRaw && typeof runRaw.runId === 'string' ? runRaw.runId : '';
  const correlationId = runRaw && typeof runRaw.correlationId === 'string' ? runRaw.correlationId : '';

  // 5. Capability identity -----------------------------------------------------------
  let capabilityId = '';
  let capabilityVersion = '';
  if (!capabilityRaw || typeof capabilityRaw.capabilityId !== 'string' || capabilityRaw.capabilityId.trim().length === 0) {
    reasons.add('MISSING_CAPABILITY');
  } else {
    capabilityId = capabilityRaw.capabilityId;
    if (typeof capabilityRaw.capabilityVersion !== 'string' || capabilityRaw.capabilityVersion.trim().length === 0) {
      reasons.add('MISSING_CAPABILITY');
    } else {
      capabilityVersion = capabilityRaw.capabilityVersion;
    }
  }

  // 6. Manifest lookup ----------------------------------------------------------------
  let manifest: A01CapabilityManifest | undefined;
  if (capabilityId && capabilityVersion) {
    if (ctx.manifests.has(capabilityId)) {
      manifest = ctx.manifests.get(capabilityId, capabilityVersion);
      if (!manifest) reasons.add('CAPABILITY_VERSION_MISMATCH');
    } else {
      reasons.add('UNKNOWN_CAPABILITY');
    }
  }

  // 7. Tool / operation ----------------------------------------------------------------
  if (tool.trim().length === 0) {
    reasons.add('MISSING_TOOL');
  } else if (manifest) {
    const forTool = manifest.allowedOperations.filter((entry) => entry.tool === tool);
    if (forTool.length === 0) {
      reasons.add('UNKNOWN_TOOL');
    } else if (!forTool.some((entry) => entry.operation === operation)) {
      if (operation.trim().length === 0) reasons.add('MISSING_OPERATION');
      else reasons.add('OPERATION_NOT_ALLOWED');
    }
  }

  // 8. Target ----------------------------------------------------------------------------
  const system = targetRaw && typeof targetRaw.system === 'string' ? targetRaw.system : '';
  const resource = targetRaw && typeof targetRaw.resource === 'string' && targetRaw.resource.length > 0 ? targetRaw.resource : undefined;
  const audience = targetRaw && typeof targetRaw.audience === 'string' && targetRaw.audience.length > 0 ? targetRaw.audience : undefined;
  if (system.trim().length === 0) {
    reasons.add('TARGET_NOT_ALLOWED');
  } else if (manifest) {
    const entriesForSystem = manifest.allowedTargets.filter((entry) => entry.system === system);
    const matched = entriesForSystem.some((entry) => targetMatches(entry, system, resource));
    if (!matched) {
      if (entriesForSystem.length > 0 && entriesForSystem.every((entry) => entry.resourcePattern !== undefined) && resource === undefined) {
        // A specific resource is required but the caller omitted it: "no
        // resource" must not be treated as "all resources".
        reasons.add('WILDCARD_ESCALATION');
      } else {
        reasons.add('TARGET_NOT_ALLOWED');
      }
    }
  }

  // 9. Tenant scope -----------------------------------------------------------------------
  if (manifest && tenantId) {
    if (!manifest.allowTenantWildcard && !manifest.tenantScopes.includes(tenantId)) {
      reasons.add('TENANT_OUT_OF_SCOPE');
    }
    // R1/D2: the verified-kernel-worker tenancy above is only honoured under
    // a capability that is DELIBERATELY system-scoped. A kernel worker acting
    // cross-tenant under a tenant-pinned capability is still substitution.
    if (kernelWorkerTenancy && !manifest.allowTenantWildcard) {
      reasons.add('TENANT_SUBSTITUTION');
    }
  } else if (kernelWorkerTenancy) {
    // No manifest resolved: the cross-tenant claim has nothing authorising it.
    reasons.add('TENANT_SUBSTITUTION');
  }

  // 10. Classification / impact ceilings -----------------------------------------------------
  const classification = typeof req.dataClassification === 'string' ? req.dataClassification : undefined;
  if (manifest && classification !== undefined && classification in A01_CLASSIFICATION_ORDER) {
    if (A01_CLASSIFICATION_ORDER[classification as keyof typeof A01_CLASSIFICATION_ORDER] > A01_CLASSIFICATION_ORDER[manifest.maxDataClassification]) {
      reasons.add('CLASSIFICATION_EXCEEDED');
    }
  } else if (!A01_CLASSIFICATION_ORDER_KEY_SET.has(String(req.dataClassification))) {
    reasons.add('ENVELOPE_MALFORMED');
  }
  const impact = typeof req.impact === 'string' ? req.impact : undefined;
  if (manifest && impact !== undefined && impact in A01_IMPACT_ORDER) {
    if (A01_IMPACT_ORDER[impact as keyof typeof A01_IMPACT_ORDER] > A01_IMPACT_ORDER[manifest.maxImpact]) {
      reasons.add('IMPACT_EXCEEDED');
    }
  } else if (!A01_IMPACT_KEY_SET.has(String(req.impact))) {
    reasons.add('ENVELOPE_MALFORMED');
  }
  const dataClassification = (A01_CLASSIFICATION_ORDER_KEY_SET.has(String(req.dataClassification)) ? req.dataClassification : 'INTERNAL') as A01CapabilityManifest['maxDataClassification'];
  const impactLevel = (A01_IMPACT_KEY_SET.has(String(req.impact)) ? req.impact : 'EXTERNAL_SIDE_EFFECT') as A01CapabilityManifest['maxImpact'];

  // 11. Approval binding ----------------------------------------------------------------------
  validateApproval(req.approval, reasons, manifest, {
    tenantId,
    principalId: principal?.id ?? '',
    agentId,
    runId,
    capabilityId,
    tool,
    operation,
    targetSystem: system,
    targetResource: resource ?? '',
    dataClassification,
    impact: impactLevel,
  });

  // 12. Credential requirement ---------------------------------------------------------------
  let credentialBinding: A01CredentialBinding | undefined;
  const requiredScopes = manifest?.requiredCredentialScopes ?? [];
  if (manifest && requiredScopes.length > 0) {
    if (manifest.credentialAudience && audience !== manifest.credentialAudience) {
      reasons.add('CREDENTIAL_AUDIENCE_MISMATCH');
    }
    const presented = req.credential as A01CredentialBinding | undefined;
    if (!presented || typeof presented.credentialId !== 'string' || presented.credentialId.trim().length === 0) {
      reasons.add('CREDENTIAL_REQUIRED');
      reasons.add('CREDENTIAL_MISSING');
    } else {
      credentialBinding = {
        credentialId: presented.credentialId,
        audience: typeof presented.audience === 'string' ? presented.audience : '',
        scopes: Array.isArray(presented.scopes) ? presented.scopes.filter((s): s is string => typeof s === 'string') : [],
      };
      const view = {
        envelopeId: `decision:${correlationId}:${capabilityId}:${tool}:${operation}:${now}`,
        principal: { id: principal?.id ?? '' },
        tenantId,
        capability: { capabilityId },
        tool,
        operation,
        target: { audience },
        credential: credentialBinding,
      };
      if (!ctx.broker || !ctx.broker.available()) {
        reasons.add('CREDENTIAL_BROKER_UNAVAILABLE');
      } else {
        for (const code of ctx.broker.checkFor(view, requiredScopes)) {
          reasons.add(code);
        }
      }
    }
  }

  // 13. Budget (per-invocation ceiling) --------------------------------------------------------
  const cost = typeof costRaw === 'number' && Number.isFinite(costRaw) && costRaw > 0 ? costRaw : 0;
  if (cost <= 0) {
    reasons.add('ENVELOPE_MALFORMED');
  } else if (manifest && cost > manifest.budgetPerRunCostUnits) {
    reasons.add('BUDGET_EXHAUSTED');
  }

  // 14. Rate (window usage reported by the gate) ---------------------------------------------------
  if (manifest && tenantId && principal && capabilityId && ctx.rateWindowUsage) {
    const usage = ctx.rateWindowUsage({ tenantId, principalId: principal.id, capabilityId });
    if (usage >= manifest.rateLimit.max) {
      reasons.add('RATE_LIMIT_EXCEEDED');
    }
  }

  // 15. Discretionary policy engine (can only add denials) --------------------------------------------
  if (manifest) {
    let verdict: { outcome: string; reasons: readonly A01DenialReason[] } | undefined;
    try {
      verdict = engine.evaluate(request as A01AuthorizationRequest, manifest);
    } catch {
      reasons.add('POLICY_ENGINE_UNAVAILABLE');
    }
    if (verdict !== undefined) {
      if (verdict.outcome === 'DENY') {
        if (Array.isArray(verdict.reasons) && verdict.reasons.length > 0) {
          for (const code of verdict.reasons) reasons.add(code);
        } else {
          reasons.add('AMBIGUOUS_POLICY_RESULT');
        }
      } else if (verdict.outcome !== 'ALLOW') {
        reasons.add('AMBIGUOUS_POLICY_RESULT');
      }
    }
  }

  // 16. Render ------------------------------------------------------------------------------------
  const reasonList = [...reasons];
  const decision: A01DecisionRecord = {
    decisionId: `dec-${now}-${Math.random().toString(36).slice(2, 10)}`,
    decision: reasonList.length === 0 ? 'ALLOW' : 'DENY',
    reasonCodes: Object.freeze(reasonList),
    policyVersion: ctx.policyVersion,
    decidedAt: now,
    expiresAt: now + (manifest ? manifest.maxLifetimeMs : 0),
    budgetCostUnits: cost > 0 ? cost : 1,
  };
  const provenance: A01ProvenanceBinding = Object.freeze({
    source: typeof req.provenance === 'object' && req.provenance && typeof (req.provenance as { source?: unknown }).source === 'string'
      ? (req.provenance as { source: string }).source
      : 'authorization-boundary',
    correlationId: correlationId || runId,
    ...(typeof runRaw?.causationId === 'string' && runRaw.causationId
      ? { causationId: runRaw.causationId }
      : typeof (req.provenance as { causationId?: unknown } | undefined)?.causationId === 'string'
        ? { causationId: (req.provenance as { causationId: string }).causationId }
        : {}),
    createdAt: now,
    ...(typeof req.idempotencyKey === 'string' && req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}),
  });
  return {
    decision,
    provenance,
    ...(credentialBinding && decision.decision === 'ALLOW' ? { credential: Object.freeze(credentialBinding) } : {}),
    manifest: manifest ?? FALLBACK_MANIFEST,
    budgetCostUnits: cost > 0 ? cost : 1,
  };
}

function denyAll(
  reasons: Set<A01DenialReason>,
  code: A01DenialReason,
  ctx: A01PolicyContext,
  now: number,
  cost: number,
): A01DecisionResult {
  reasons.add(code);
  const decision: A01DecisionRecord = {
    decisionId: `dec-${now}-${Math.random().toString(36).slice(2, 10)}`,
    decision: 'DENY',
    reasonCodes: Object.freeze([...reasons]),
    policyVersion: ctx.policyVersion,
    decidedAt: now,
    expiresAt: now,
    budgetCostUnits: cost,
  };
  return {
    decision,
    provenance: Object.freeze({ source: 'authorization-boundary', correlationId: '', createdAt: now }),
    manifest: FALLBACK_MANIFEST,
    budgetCostUnits: cost,
  };
}

const A01_CLASSIFICATION_ORDER_KEY_SET = new Set(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);
const A01_IMPACT_KEY_SET = new Set(['READ', 'REVERSIBLE_WRITE', 'CONSEQUENTIAL_WRITE', 'EXTERNAL_SIDE_EFFECT']);

/** Never used for a real decision; only shapes the result when the request is structurally broken. */
const FALLBACK_MANIFEST: A01CapabilityManifest = Object.freeze({
  capabilityId: '',
  version: '',
  allowedOperations: [],
  allowedTargets: [],
  tenantScopes: [],
  allowTenantWildcard: false,
  maxDataClassification: 'PUBLIC',
  maxImpact: 'READ',
  requiredCredentialScopes: [],
  requiresApproval: false,
  rateLimit: { windowMs: 1, max: 1 },
  budgetPerRunCostUnits: 0,
  maxLifetimeMs: 0,
  registeredBy: { principalId: '', tenantId: '' },
  policyVersion: '',
  createdAt: 0,
});

function validateApproval(
  raw: unknown,
  reasons: Set<A01DenialReason>,
  manifest: A01CapabilityManifest | undefined,
  fields: Parameters<typeof a01ActionDigest>[0],
): A01ApprovalBinding | undefined {
  if (raw === undefined) {
    if (manifest?.requiresApproval) reasons.add('APPROVAL_MISSING');
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    reasons.add('APPROVAL_MISMATCH');
    return undefined;
  }
  const a = raw as Record<string, unknown>;
  if (
    typeof a.approvalId !== 'string' || a.approvalId.trim().length === 0 ||
    typeof a.approverId !== 'string' || a.approverId.trim().length === 0 ||
    typeof a.approvedAt !== 'number' || !Number.isFinite(a.approvedAt) ||
    typeof a.expiresAt !== 'number' || !Number.isFinite(a.expiresAt) ||
    typeof a.approvedActionDigest !== 'string' || a.approvedActionDigest.trim().length === 0
  ) {
    reasons.add('APPROVAL_MISMATCH');
    return undefined;
  }
  if (a.approvedAt >= a.expiresAt) {
    reasons.add('APPROVAL_EXPIRED');
    return undefined;
  }
  if (a.approvedActionDigest !== a01ActionDigest(fields)) {
    // The approval was rendered for a different action: different operation,
    // target, tenant, principal, capability, classification, or impact.
    reasons.add('APPROVAL_MISMATCH');
    return undefined;
  }
  return {
    approvalId: a.approvalId,
    approverId: a.approverId,
    approvedAt: a.approvedAt,
    expiresAt: a.expiresAt,
    approvedActionDigest: a.approvedActionDigest,
  };
}
