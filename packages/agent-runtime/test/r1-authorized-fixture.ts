// R1 (§6 TEST FIXTURE REPAIR) — construct LEGITIMATE authorization for tests
// that exercise legitimate behaviour.
//
// This is not a bypass and not a mock. It builds a REAL `AuthorizationGate`
// with REAL, NARROW capability manifests and mints REAL sealed envelopes
// through the real decision point. A tool call that falls outside the
// manifest is still denied; the fixture simply stops legitimate tests from
// having to hand-roll the same wiring.

import {
  AuthorizationGate,
  CapabilityManifestRegistry,
  InMemoryAuditSink,
  testCapabilityManifest,
  testPrincipal,
  type A01AuthorizationEnvelope,
  type A01PrincipalBinding,
} from '@jataqi/authorization-boundary';
import type { Tool, ToolAuthorizationDeclaration, ToolContext } from '../src/index.js';

export const TEST_TENANT = 'acme';
export const TEST_CAPABILITY = 'cap.agent.fixture';

/** Attach a narrow A-01 declaration to a tool used by a legitimate test. */
export function declareTool(tool: Omit<Tool, 'authorization'>, overrides: Partial<ToolAuthorizationDeclaration> = {}): Tool {
  return {
    ...tool,
    authorization: {
      capabilityId: TEST_CAPABILITY,
      capabilityVersion: '1',
      operation: 'invoke',
      impact: 'REVERSIBLE_WRITE',
      dataClassification: 'INTERNAL',
      targetSystem: 'test.system',
      ...overrides,
    },
  } as Tool;
}

/**
 * A real gate whose manifest permits exactly the named tools, one operation
 * each, on one target system, for one tenant. Nothing else.
 */
export function authorizedGate(tools: readonly string[], options: { now?: () => number } = {}): AuthorizationGate {
  const manifests = new CapabilityManifestRegistry();
  // The boundary correctly REJECTS an empty operation allow-list (it would
  // grant nothing). A test with no tools therefore registers no manifest:
  // the gate is real and authoritative, and it grants nothing.
  if (tools.length > 0) manifests.register(
    testCapabilityManifest({
      capabilityId: TEST_CAPABILITY,
      operations: tools.map((tool) => ({ tool, operation: 'invoke' })),
      targets: [{ system: 'test.system' }],
      tenantScopes: [TEST_TENANT],
      maxImpact: 'REVERSIBLE_WRITE',
      // Generous limits so a legitimate multi-iteration agent run is not
      // rate/budget limited — the SECURITY checks are all still enforced.
      rateLimit: { windowMs: 60_000, max: 100_000 },
      budgetPerRunCostUnits: 100_000,
    }),
  );
  return new AuthorizationGate({
    ...(options.now ? { now: options.now } : {}),
    manifests,
    audit: new InMemoryAuditSink(),
  });
}

export function fixturePrincipal(overrides: Partial<A01PrincipalBinding> = {}): A01PrincipalBinding {
  return testPrincipal({ id: 'user:alice', tenantId: TEST_TENANT, roles: ['operator'], ...overrides });
}

/** Mint a real sealed envelope for one legitimate tool call. */
export function envelopeFor(
  gate: AuthorizationGate,
  toolName: string,
  options: { principal?: A01PrincipalBinding; runId?: string } = {},
): A01AuthorizationEnvelope {
  const principal = options.principal ?? fixturePrincipal();
  return gate.decide({
    principal,
    tenantId: principal.tenantId,
    agent: { agentId: 'fixture-agent' },
    run: { runId: options.runId ?? 'fixture-run', correlationId: options.runId ?? 'fixture-run' },
    capability: { capabilityId: TEST_CAPABILITY, capabilityVersion: '1' },
    tool: toolName,
    operation: 'invoke',
    target: { system: 'test.system' },
    dataClassification: 'INTERNAL',
    impact: 'REVERSIBLE_WRITE',
    budgetCostUnits: 1,
    provenance: { source: 'r1-fixture' },
  } as never);
}

/** A tool context carrying a real, legitimately-minted envelope. */
export function authorizedContext(
  gate: AuthorizationGate,
  toolName: string,
  options: { runId?: string; principal?: A01PrincipalBinding } = {},
): ToolContext {
  return {
    runId: options.runId ?? 'fixture-run',
    logger: { info: () => {}, debug: () => {}, error: () => {} },
    metadata: {},
    authorization: { envelope: envelopeFor(gate, toolName, options) },
  };
}

/** The legitimate authorization inputs for `Agent.run()`. */
export function agentAuthorization(principal: A01PrincipalBinding = fixturePrincipal()) {
  return { principal, agentId: 'fixture-agent' };
}
