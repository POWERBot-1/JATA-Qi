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
}

/**
 * Seal one decision into a tamper-resistant envelope. Only the policy
 * decision point (via the gate) calls this; downstream code can verify but
 * never mint.
 */
export function sealEnvelope(input: BuildEnvelopeInput): A01AuthorizationEnvelope {
  const { request, decision, envelopeId, provenance, credential } = input;
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
