// Shared fixtures for the A-01 test suites: deterministic clock, verified
// principals (T-01 shape), valid base requests, manifests, brokers, gates.

import assert from 'node:assert/strict';
import {
  AuthorizationGate,
  CapabilityManifestRegistry,
  InMemoryAuditSink,
  InMemoryCredentialBroker,
  a01ActionDigest,
  type A01ApprovalBinding,
  type A01AuthorizationEnvelope,
  type A01AuthorizationRequest,
  type A01CapabilityManifest,
  type A01PrincipalBinding,
  type A01DenialReason,
  type ScopedExecutionContext,
} from '../src/index.js';

export const T0 = 1_700_000_000_000; // deterministic epoch (ms)

export function principal(overrides: Partial<A01PrincipalBinding> = {}): A01PrincipalBinding {
  return {
    id: 'user:alice',
    tenantId: 'acme',
    roles: ['operator'],
    authenticationMethod: 'STATIC_TOKEN',
    authenticationEventId: 'auth-event-1',
    ...overrides,
  };
}

export function baseRequest(overrides: Record<string, unknown> = {}): A01AuthorizationRequest {
  const base: Record<string, unknown> = {
    principal: principal(),
    tenantId: 'acme',
    agent: { agentId: 'agent-research' },
    run: { runId: 'run-1', correlationId: 'corr-1' },
    capability: { capabilityId: 'cap.test', capabilityVersion: '1' },
    tool: 'test-tool',
    operation: 'do',
    target: { system: 'test-system', resource: 'res-1' },
    dataClassification: 'INTERNAL',
    impact: 'EXTERNAL_SIDE_EFFECT',
    budgetCostUnits: 1,
    provenance: { source: 'a01-test' },
  };
  return { ...base, ...overrides } as unknown as A01AuthorizationRequest;
}

export function manifest(overrides: Record<string, unknown> = {}): A01CapabilityManifest {
  const base: Record<string, unknown> = {
    capabilityId: 'cap.test',
    version: '1',
    description: 'Test capability',
    allowedOperations: [{ tool: 'test-tool', operation: 'do' }],
    allowedTargets: [{ system: 'test-system', resourcePattern: 'res-*' }],
    tenantScopes: ['acme'],
    allowTenantWildcard: false,
    maxDataClassification: 'INTERNAL',
    maxImpact: 'EXTERNAL_SIDE_EFFECT',
    requiredCredentialScopes: [],
    requiresApproval: false,
    rateLimit: { windowMs: 60_000, max: 100 },
    budgetPerRunCostUnits: 100,
    maxLifetimeMs: 60_000,
    registeredBy: { principalId: 'user:admin', tenantId: 'acme' },
    policyVersion: 'test-policy',
    createdAt: T0,
  };
  return { ...base, ...overrides } as unknown as A01CapabilityManifest;
}

export interface TestGate {
  gate: AuthorizationGate;
  manifests: CapabilityManifestRegistry;
  broker: InMemoryCredentialBroker;
  audit: InMemoryAuditSink;
  /** Advance the deterministic clock. */
  advance(ms: number): void;
  now(): number;
  /** Register the default test manifest (idempotent per capability/version). */
  registerTestManifest(overrides?: Record<string, unknown>): void;
}

export function makeGate(options: { broker?: InMemoryCredentialBroker; audit?: InMemoryAuditSink; now?: () => number } = {}): TestGate {
  let clock = T0;
  const clockFn = options.now ?? ((): number => clock);
  const manifests = new CapabilityManifestRegistry();
  const broker = options.broker ?? new InMemoryCredentialBroker({ now: () => clock });
  const audit = options.audit ?? new InMemoryAuditSink();
  const gate = new AuthorizationGate({
    now: clockFn,
    manifests,
    broker,
    audit,
    policyVersion: 'test-policy',
  });
  return {
    gate,
    manifests,
    broker,
    audit,
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,
    registerTestManifest: (overrides = {}) => {
      const m = manifest(overrides);
      if (!manifests.has(m.capabilityId) || !manifests.get(m.capabilityId, m.version)) {
        manifests.register(m);
      }
    },
  };
}

export function makeApproval(
  fields: {
    tenantId: string;
    principalId: string;
    agentId: string;
    runId: string;
    capabilityId: string;
    tool: string;
    operation: string;
    targetSystem: string;
    targetResource: string;
    dataClassification: string;
    impact: string;
  },
  options: { approvalId?: string; approverId?: string; approvedAt?: number; expiresAt?: number; digestOverride?: string } = {},
): A01ApprovalBinding {
  return {
    approvalId: options.approvalId ?? 'approval-1',
    approverId: options.approverId ?? 'user:approver',
    approvedAt: options.approvedAt ?? T0,
    expiresAt: options.expiresAt ?? T0 + 3_600_000,
    approvedActionDigest: options.digestOverride ?? a01ActionDigest(fields),
  };
}

/** Spy side effect: counts invocations; returns a sentinel payload. */
export function spySideEffect(payload: unknown = 'side-effect-ran') {
  const state = { calls: 0, sawCredential: undefined as ScopedExecutionContext | undefined };
  const fn = (scoped: ScopedExecutionContext): Promise<unknown> => {
    state.calls += 1;
    state.sawCredential = scoped;
    return Promise.resolve(payload);
  };
  return { fn, state };
}

export function reasonsOf(envelope: A01AuthorizationEnvelope): readonly A01DenialReason[] {
  return envelope.decision.reasonCodes;
}

export function assertDenied(envelope: A01AuthorizationEnvelope, ...expected: A01DenialReason[]): void {
  assert.equal(envelope.decision.decision, 'DENY', `expected DENY, got reasons ${[...envelope.decision.reasonCodes].join(',')}`);
  for (const code of expected) {
    assert.ok(
      envelope.decision.reasonCodes.includes(code),
      `expected reason ${code}; got [${[...envelope.decision.reasonCodes].join(', ')}]`,
    );
  }
}

export function assertAllowed(envelope: A01AuthorizationEnvelope): void {
  assert.equal(envelope.decision.decision, 'ALLOW', `expected ALLOW, got reasons ${[...envelope.decision.reasonCodes].join(',')}`);
  assert.equal(envelope.decision.reasonCodes.length, 0);
}
