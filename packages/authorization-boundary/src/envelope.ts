// Sealed authorization envelope: creation, freezing, and integrity checks.

import {
  deepFreeze,
  sha256Hex,
  canonicalize,
} from './canonical.js';
import type {
  A01AuthorizationEnvelope,
  A01AuthorizationRequest,
  A01CredentialBinding,
  A01DecisionRecord,
  A01DenialReason,
  A01ProvenanceBinding,
} from './types.js';
import { EnvelopeIntegrityError } from './types.js';

/** The envelope's digest covers every field except `integrity` itself. */
export function envelopeDigestValue(envelope: Omit<A01AuthorizationEnvelope, 'integrity'>): string {
  return sha256Hex(canonicalize({ ...envelope }));
}

export interface BuildEnvelopeInput {
  readonly request: A01AuthorizationRequest;
  readonly decision: A01DecisionRecord;
  readonly envelopeId: string;
  readonly provenance: A01ProvenanceBinding;
  readonly credential?: A01CredentialBinding;
  /**
   * R2 durable citations (`decideAsync` only; covered by the integrity
   * digest). Absent on R1 sync-path envelopes.
   */
  readonly durableCitations?: {
    readonly manifestId?: string;
    readonly manifestDigest?: string;
    readonly sessionEventId?: string;
    readonly sessionStatus?: A01AuthorizationEnvelope['sessionStatus'];
    readonly securityStoreTxId?: string;
    readonly privilegeElevationId?: string;
    readonly privilegeOperationClass?: string;
    readonly privilegeStatus?: string;
  };
}

/**
 * Seal one decision into a tamper-resistant envelope. Only the policy
 * decision point (via the gate) calls this; downstream code can verify but
 * never mint.
 */
export function sealEnvelope(input: BuildEnvelopeInput): A01AuthorizationEnvelope {
  const { request, decision, envelopeId, provenance, credential, durableCitations } = input;
  const body: Omit<A01AuthorizationEnvelope, 'integrity'> = {
    envelopeId,
    version: 1,
    principal: {
      id: request.principal.id,
      tenantId: request.principal.tenantId,
      roles: [...request.principal.roles],
      authenticationMethod: request.principal.authenticationMethod,
      authenticationEventId: request.principal.authenticationEventId,
    },
    tenantId: request.tenantId,
    agent: {
      agentId: request.agent.agentId,
      ...(request.agent.agentVersion !== undefined ? { agentVersion: request.agent.agentVersion } : {}),
    },
    run: {
      runId: request.run.runId,
      correlationId: request.run.correlationId,
      ...(request.run.causationId !== undefined ? { causationId: request.run.causationId } : {}),
    },
    capability: {
      capabilityId: request.capability.capabilityId,
      capabilityVersion: request.capability.capabilityVersion,
    },
    tool: request.tool,
    operation: request.operation,
    target: {
      system: request.target.system,
      ...(request.target.resource !== undefined ? { resource: request.target.resource } : {}),
      ...(request.target.audience !== undefined ? { audience: request.target.audience } : {}),
    },
    dataClassification: request.dataClassification,
    impact: request.impact,
    ...(request.approval !== undefined ? { approval: { ...request.approval } } : {}),
    ...(credential !== undefined ? { credential: { ...credential, scopes: [...credential.scopes] } } : {}),
    provenance,
    decision: {
      ...decision,
      reasonCodes: [...decision.reasonCodes],
    },
    ...(durableCitations?.manifestId !== undefined ? { manifestId: durableCitations.manifestId } : {}),
    ...(durableCitations?.manifestDigest !== undefined ? { manifestDigest: durableCitations.manifestDigest } : {}),
    ...(durableCitations?.sessionEventId !== undefined ? { sessionEventId: durableCitations.sessionEventId } : {}),
    ...(durableCitations?.sessionStatus !== undefined ? { sessionStatus: durableCitations.sessionStatus } : {}),
    ...(durableCitations?.securityStoreTxId !== undefined ? { securityStoreTxId: durableCitations.securityStoreTxId } : {}),
    ...(durableCitations?.privilegeElevationId !== undefined ? { privilegeElevationId: durableCitations.privilegeElevationId } : {}),
    ...(durableCitations?.privilegeOperationClass !== undefined ? { privilegeOperationClass: durableCitations.privilegeOperationClass } : {}),
    ...(durableCitations?.privilegeStatus !== undefined ? { privilegeStatus: durableCitations.privilegeStatus } : {}),
  };
  const digest = envelopeDigestValue(body);
  return deepFreeze({ ...body, integrity: { algorithm: 'sha256' as const, digest } });
}

/**
 * Structural + integrity verification. Throws `EnvelopeIntegrityError` when
 * the digest does not match (tamper detection) or the envelope is malformed.
 * This is the check every enforcement point runs BEFORE trusting the
 * envelope or invoking a protected side effect.
 */
export function assertEnvelopeIntegrity(envelope: unknown): asserts envelope is A01AuthorizationEnvelope {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new EnvelopeIntegrityError('envelope is not an object (malformed)');
  }
  const candidate = envelope as Record<string, unknown>;
  if (candidate.version !== 1) throw new EnvelopeIntegrityError('envelope version must be 1 (malformed)');
  const required: readonly (keyof A01AuthorizationEnvelope)[] = [
    'envelopeId',
    'principal',
    'tenantId',
    'agent',
    'run',
    'capability',
    'tool',
    'operation',
    'target',
    'dataClassification',
    'impact',
    'provenance',
    'decision',
    'integrity',
  ];
  for (const key of required) {
    if (candidate[key] === undefined) {
      throw new EnvelopeIntegrityError(`envelope is missing "${String(key)}" (malformed)`);
    }
  }
  const integrity = candidate.integrity as { algorithm?: unknown; digest?: unknown };
  if (integrity.algorithm !== 'sha256' || typeof integrity.digest !== 'string' || integrity.digest.length !== 64) {
    throw new EnvelopeIntegrityError('envelope integrity header is malformed');
  }
  const { integrity: _excluded, ...rest } = candidate;
  const recomputed = sha256Hex(canonicalize(rest));
  if (recomputed !== integrity.digest) {
    throw new EnvelopeIntegrityError(
      'envelope integrity digest mismatch — the envelope was tampered with after sealing (ENVELOPE_TAMPERED)',
    );
  }
}

/** Convenience: true when the envelope passes structural + integrity checks. */
export function isEnvelopeIntact(envelope: unknown): boolean {
  try {
    assertEnvelopeIntegrity(envelope);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that an envelope is a valid, fresh, ALLOW decision for exactly the
 * (tool, operation, targetResource) the enforcement point is about to
 * execute. Returns the denial reason codes; empty means the envelope is
 * acceptable for this invocation.
 */
export function envelopeAcceptance(
  envelope: A01AuthorizationEnvelope,
  expected: { readonly tool: string; readonly operation: string; readonly targetResource?: string },
  now: number,
): A01DenialReason[] {
  const reasons: A01DenialReason[] = [];
  assertEnvelopeIntegrity(envelope);
  if (envelope.decision.decision !== 'ALLOW') {
    reasons.push('ENVELOPE_NOT_ALLOWED', ...envelope.decision.reasonCodes.filter((code) => code !== 'ENVELOPE_NOT_ALLOWED'));
  }
  if (now >= envelope.decision.expiresAt) reasons.push('AUTHORIZATION_EXPIRED');
  if (envelope.tool !== expected.tool) reasons.push('OPERATION_SUBSTITUTION');
  else if (envelope.operation !== expected.operation) reasons.push('OPERATION_SUBSTITUTION');
  if (expected.targetResource !== undefined && envelope.target.resource !== expected.targetResource) {
    reasons.push('TARGET_SUBSTITUTION');
  }
  return [...new Set(reasons)];
}

/**
 * Sanitize a request for envelope mirroring: the envelope carries only the
 * authoritative fields; structurally broken requests yield sanitized (empty)
 * identity fields. Shared by the R1 sync path and the R2 durable path
 * (single implementation — no drift).
 */
export function sanitizeRequestForEnvelope(request: A01AuthorizationRequest | null | undefined): A01AuthorizationRequest {
  // The envelope mirrors only the authoritative fields; if the request was
  // structurally broken the decision is a DENY and the envelope carries the
  // sanitized (empty) identity fields rather than garbage.
  const base: A01AuthorizationRequest = {
    principal: {
      id: '',
      tenantId: '',
      roles: [],
      authenticationMethod: 'KERNEL_INTERNAL',
      authenticationEventId: '',
    },
    tenantId: '',
    agent: { agentId: '' },
    run: { runId: '', correlationId: '' },
    capability: { capabilityId: '', capabilityVersion: '' },
    tool: '',
    operation: '',
    target: { system: '' },
    dataClassification: 'INTERNAL',
    impact: 'EXTERNAL_SIDE_EFFECT',
    budgetCostUnits: 1,
  };
  if (!request || typeof request !== 'object') return base;
  const r = request as unknown as Record<string, unknown>;
  const principal = r.principal as Record<string, unknown> | undefined;
  return {
    ...base,
    ...(principal && typeof principal.id === 'string'
      ? {
          principal: {
            id: principal.id,
            tenantId: typeof principal.tenantId === 'string' ? principal.tenantId : '',
            roles: Array.isArray(principal.roles) ? principal.roles.filter((x): x is string => typeof x === 'string') : [],
            authenticationMethod: typeof principal.authenticationMethod === 'string' ? principal.authenticationMethod : 'KERNEL_INTERNAL',
            authenticationEventId: typeof principal.authenticationEventId === 'string' ? principal.authenticationEventId : '',
          },
        }
      : {}),
    ...(typeof r.tenantId === 'string' ? { tenantId: r.tenantId } : {}),
    ...(r.agent && typeof (r.agent as { agentId?: unknown }).agentId === 'string'
      ? { agent: { agentId: (r.agent as { agentId: string }).agentId } }
      : {}),
    ...(r.run && typeof (r.run as { runId?: unknown }).runId === 'string'
      ? {
          run: {
            runId: (r.run as { runId: string }).runId,
            correlationId: typeof (r.run as { correlationId?: unknown }).correlationId === 'string'
              ? (r.run as { correlationId: string }).correlationId
              : (r.run as { runId: string }).runId,
          },
        }
      : {}),
    ...(r.capability && typeof (r.capability as { capabilityId?: unknown }).capabilityId === 'string'
      ? {
          capability: {
            capabilityId: (r.capability as { capabilityId: string }).capabilityId,
            capabilityVersion: typeof (r.capability as { capabilityVersion?: unknown }).capabilityVersion === 'string'
              ? (r.capability as { capabilityVersion: string }).capabilityVersion
              : '',
          },
        }
      : {}),
    ...(typeof r.tool === 'string' ? { tool: r.tool } : {}),
    ...(typeof r.operation === 'string' ? { operation: r.operation } : {}),
    ...(r.target && typeof (r.target as { system?: unknown }).system === 'string'
      ? {
          target: {
            system: (r.target as { system: string }).system,
            ...(typeof (r.target as { resource?: unknown }).resource === 'string'
              ? { resource: (r.target as { resource: string }).resource }
              : {}),
            ...(typeof (r.target as { audience?: unknown }).audience === 'string'
              ? { audience: (r.target as { audience: string }).audience }
              : {}),
          },
        }
      : {}),
    ...(typeof r.dataClassification === 'string' ? { dataClassification: r.dataClassification as A01AuthorizationRequest['dataClassification'] } : {}),
    ...(typeof r.impact === 'string' ? { impact: r.impact as A01AuthorizationRequest['impact'] } : {}),
    ...(typeof r.idempotencyKey === 'string' ? { idempotencyKey: r.idempotencyKey } : {}),
    ...(typeof r.budgetCostUnits === 'number' ? { budgetCostUnits: r.budgetCostUnits } : {}),
    ...(r.approval && typeof (r.approval as { approvalId?: unknown }).approvalId === 'string'
      ? {
          approval: {
            approvalId: (r.approval as { approvalId: string }).approvalId,
            approverId: typeof (r.approval as { approverId?: unknown }).approverId === 'string'
              ? (r.approval as { approverId: string }).approverId
              : '',
            approvedAt: typeof (r.approval as { approvedAt?: unknown }).approvedAt === 'number'
              ? (r.approval as { approvedAt: number }).approvedAt
              : 0,
            expiresAt: typeof (r.approval as { expiresAt?: unknown }).expiresAt === 'number'
              ? (r.approval as { expiresAt: number }).expiresAt
              : Number.MAX_SAFE_INTEGER,
            approvedActionDigest: typeof (r.approval as { approvedActionDigest?: unknown }).approvedActionDigest === 'string'
              ? (r.approval as { approvedActionDigest: string }).approvedActionDigest
              : '',
          },
        }
      : {}),
    ...(r.credential && typeof (r.credential as { credentialId?: unknown }).credentialId === 'string'
      ? {
          credential: {
            credentialId: (r.credential as { credentialId: string }).credentialId,
            audience: typeof (r.credential as { audience?: unknown }).audience === 'string'
              ? (r.credential as { audience: string }).audience
              : null,
            scopes: Array.isArray((r.credential as { scopes?: unknown }).scopes)
              ? ((r.credential as { scopes: unknown[] }).scopes).filter((x): x is string => typeof x === 'string')
              : [],
          },
        }
      : {}),
  };
}
