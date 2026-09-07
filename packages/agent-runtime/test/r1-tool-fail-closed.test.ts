// R1 ADVERSARIAL SUITE — agent tool execution fails closed.
//
// INVARIANTS PROVEN HERE:
//   B  boundary absence is DENY
//   C  invalid principal is DENY
//   D  missing capability is DENY
//   E  tenant mismatch is DENY
//   F  malformed / tampered authorization context is DENY
//   G  expired authorization is DENY
//   H  replay is DENY
//   I  authorization failure occurs BEFORE the side effect
//   O  agent tools cannot execute without authorization
//
// Every DENY assertion is paired with a SIDE-EFFECT PROBE. It is not enough
// that an error is returned: the probe proves `tool.execute` was never
// entered, so the actual side effect never occurred.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthorizationGate,
  CapabilityManifestRegistry,
  InMemoryAuditSink,
  testCapabilityManifest,
  testPrincipal,
  withTestManifests,
  type A01AuthorizationEnvelope,
  type A01AuthorizationRequest,
  type A01PrincipalBinding,
} from '@jataqi/authorization-boundary';
import { ToolRegistry, NO_BOUNDARY_DENIAL, type Tool, type ToolContext } from '../src/index.js';

const T0 = 1_700_000_000_000;
const TENANT = 'acme';
const CAP = 'cap.r1.agent';
const TOOL = 'r1.side-effect';
const OP = 'write';
const SYSTEM = 'r1.system';

/**
 * A tool whose execute() records that the SIDE EFFECT ACTUALLY HAPPENED.
 * `calls` must stay 0 for every denial in this file.
 */
function probeTool(): { tool: Tool; calls: () => number } {
  let calls = 0;
  const tool: Tool = {
    name: TOOL,
    description: 'records that the real side effect executed',
    inputSchema: { type: 'object', properties: { resource: { type: 'string' } }, required: ['resource'] },
    authorization: {
      capabilityId: CAP,
      capabilityVersion: '1',
      operation: OP,
      impact: 'EXTERNAL_SIDE_EFFECT',
      dataClassification: 'INTERNAL',
      targetSystem: SYSTEM,
      targetFromInput: (input) => (input as { resource?: string })?.resource,
    },
    async execute() {
      calls += 1;
      return { performed: true };
    },
  };
  return { tool, calls: () => calls };
}

function ctx(envelope?: A01AuthorizationEnvelope): ToolContext {
  return {
    runId: 'run-1',
    logger: { info: () => {}, debug: () => {}, error: () => {} },
    metadata: {},
    ...(envelope ? { authorization: { envelope } } : {}),
  };
}

function buildGate(now: () => number = () => T0): AuthorizationGate {
  const manifests = withTestManifests(new CapabilityManifestRegistry(), [
    testCapabilityManifest({
      capabilityId: CAP,
      operations: [{ tool: TOOL, operation: OP }],
      targets: [{ system: SYSTEM, resourcePattern: 'doc/*' }],
      tenantScopes: [TENANT],
      createdAt: T0,
    }),
  ]);
  return new AuthorizationGate({ now, manifests, audit: new InMemoryAuditSink() });
}

function request(overrides: Partial<A01AuthorizationRequest> = {}, principal?: A01PrincipalBinding): A01AuthorizationRequest {
  const p = principal ?? testPrincipal({ id: 'user:alice', tenantId: TENANT, roles: ['operator'] });
  return {
    principal: p,
    tenantId: p.tenantId,
    agent: { agentId: 'agent-1' },
    run: { runId: 'run-1', correlationId: 'corr-1' },
    capability: { capabilityId: CAP, capabilityVersion: '1' },
    tool: TOOL,
    operation: OP,
    target: { system: SYSTEM, resource: 'doc/1' },
    dataClassification: 'INTERNAL',
    impact: 'EXTERNAL_SIDE_EFFECT',
    budgetCostUnits: 1,
    provenance: { source: 'r1-test' },
    ...overrides,
  } as A01AuthorizationRequest;
}

function assertDeniedWithoutSideEffect(result: { error?: string; output?: unknown }, calls: number, label: string): void {
  assert.ok(result.error, `${label}: expected a denial, got a successful result`);
  assert.equal(result.output, undefined, `${label}: a denied call must return no output`);
  assert.equal(calls, 0, `${label}: INVARIANT I VIOLATED — the tool side effect executed despite denial`);
}

describe('R1 INVARIANT B/O — agent tool execution with NO authorization boundary', () => {
  it('denies the call and never reaches the tool side effect', async () => {
    const { tool, calls } = probeTool();
    // A registry constructed exactly as an unwired composition would build it.
    const registry = new ToolRegistry();
    registry.register(tool);
    assert.equal(registry.getAuthorizationGate(), undefined, 'precondition: no boundary installed');

    const result = await registry.call(TOOL, { resource: 'doc/1' }, ctx());

    assert.equal(result.error, NO_BOUNDARY_DENIAL);
    assertDeniedWithoutSideEffect(result, calls(), 'absent boundary');
  });

  it('denies even when the caller presents a well-formed envelope from a foreign gate', async () => {
    const { tool, calls } = probeTool();
    // A second, non-authoritative gate cannot stand in for the boundary.
    const foreign = buildGate();
    const envelope = foreign.decide(request());
    assert.equal(envelope.decision.decision, 'ALLOW', 'precondition: the foreign gate would have allowed');

    const registry = new ToolRegistry();
    registry.register(tool);
    const result = await registry.call(TOOL, { resource: 'doc/1' }, ctx(envelope));

    assert.equal(result.error, NO_BOUNDARY_DENIAL);
    assertDeniedWithoutSideEffect(result, calls(), 'foreign envelope, absent boundary');
  });

  it('a lazily-resolved boundary that resolves to nothing is still a DENY', async () => {
    const { tool, calls } = probeTool();
    const registry = new ToolRegistry({ resolveAuthorizationGate: () => undefined });
    registry.register(tool);
    const result = await registry.call(TOOL, { resource: 'doc/1' }, ctx());
    assertDeniedWithoutSideEffect(result, calls(), 'unresolvable boundary');
  });

  it('an installed authoritative boundary cannot be swapped for another gate', () => {
    const registry = new ToolRegistry({ authorizationGate: buildGate() });
    assert.throws(() => registry.setAuthorizationGate(buildGate()), /cannot be replaced/);
  });
});

describe('R1 INVARIANTS C–H — adversarial denials at the agent tool boundary', () => {
  it('INVARIANT C — an invalid/forged principal is DENY and the tool never runs', async () => {
    const { tool, calls } = probeTool();
    const gate = buildGate();
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(tool);

    // Forged: an unrecognized authentication method and no authentication event.
    const forged = { id: 'user:mallory', tenantId: TENANT, roles: [], authenticationMethod: 'SELF_ASSERTED', authenticationEventId: '' } as unknown as A01PrincipalBinding;
    const envelope = gate.decide(request({}, forged));
    assert.equal(envelope.decision.decision, 'DENY');
    assert.ok(envelope.decision.reasonCodes.includes('FORGED_PRINCIPAL') || envelope.decision.reasonCodes.includes('MISSING_PRINCIPAL'));

    const result = await registry.call(TOOL, { resource: 'doc/1' }, ctx(envelope));
    assertDeniedWithoutSideEffect(result, calls(), 'forged principal');
  });

  it('INVARIANT C — a missing principal is DENY and the tool never runs', async () => {
    const { tool, calls } = probeTool();
    const gate = buildGate();
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(tool);

    const envelope = gate.decide(request({ principal: undefined as never, tenantId: TENANT }));
    assert.equal(envelope.decision.decision, 'DENY');
    const result = await registry.call(TOOL, { resource: 'doc/1' }, ctx(envelope));
    assertDeniedWithoutSideEffect(result, calls(), 'missing principal');
  });

  it('INVARIANT D — a capability with no manifest is DENY and the tool never runs', async () => {
    const { tool, calls } = probeTool();
    const gate = buildGate();
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(tool);

    const envelope = gate.decide(request({ capability: { capabilityId: 'cap.not.registered', capabilityVersion: '1' } }));
    assert.equal(envelope.decision.decision, 'DENY');
    assert.ok(envelope.decision.reasonCodes.includes('UNKNOWN_CAPABILITY'));
    const result = await registry.call(TOOL, { resource: 'doc/1' }, ctx(envelope));
    assertDeniedWithoutSideEffect(result, calls(), 'missing capability');
  });

  it('INVARIANT D — an operation outside the manifest allow-list is DENY', async () => {
    const { tool, calls } = probeTool();
    const gate = buildGate();
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(tool);

    const envelope = gate.decide(request({ operation: 'delete' }));
    assert.equal(envelope.decision.decision, 'DENY');
    const result = await registry.call(TOOL, { resource: 'doc/1' }, ctx(envelope));
    assertDeniedWithoutSideEffect(result, calls(), 'operation not allowed');
  });

  it('INVARIANT E — a tenant mismatch is DENY and the tool never runs', async () => {
    const { tool, calls } = probeTool();
    const gate = buildGate();
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(tool);

    // The verified principal belongs to `acme`; the request claims `evilcorp`.
    const envelope = gate.decide(request({ tenantId: 'evilcorp' }));
    assert.equal(envelope.decision.decision, 'DENY');
    assert.ok(envelope.decision.reasonCodes.includes('TENANT_SUBSTITUTION'));
    const result = await registry.call(TOOL, { resource: 'doc/1' }, ctx(envelope));
    assertDeniedWithoutSideEffect(result, calls(), 'tenant substitution');

    // And a principal from an out-of-scope tenant is denied too.
    const outsider = testPrincipal({ id: 'user:bob', tenantId: 'evilcorp' });
    const envelope2 = gate.decide(request({ tenantId: 'evilcorp' }, outsider));
    assert.equal(envelope2.decision.decision, 'DENY');
    const result2 = await registry.call(TOOL, { resource: 'doc/1' }, ctx(envelope2));
    assertDeniedWithoutSideEffect(result2, calls(), 'tenant out of scope');
  });

  it('INVARIANT F — a malformed authorization context is DENY and the tool never runs', async () => {
    const { tool, calls } = probeTool();
    const gate = buildGate();
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(tool);

    for (const [label, bogus] of [
      ['null envelope', null],
      ['string envelope', 'ALLOW'],
      ['empty object', {}],
      ['hand-rolled allow', { decision: { decision: 'ALLOW' }, tool: TOOL, operation: OP }],
    ] as const) {
      const result = await registry.call(TOOL, { resource: 'doc/1' }, ctx(bogus as never));
      assertDeniedWithoutSideEffect(result, calls(), `malformed context: ${label}`);
    }
  });

  it('INVARIANT F — a TAMPERED envelope is DENY and the tool never runs', async () => {
    const { tool, calls } = probeTool();
    const gate = buildGate();
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(tool);

    const good = gate.decide(request());
    assert.equal(good.decision.decision, 'ALLOW');
    // Flip the target resource after sealing: the digest no longer matches.
    const tampered = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    (tampered.target as { resource: string }).resource = 'doc/999';

    const result = await registry.call(TOOL, { resource: 'doc/999' }, ctx(tampered as never));
    assertDeniedWithoutSideEffect(result, calls(), 'tampered envelope');
  });

  it('INVARIANT F — an upgraded DENY envelope is DENY and the tool never runs', async () => {
    const { tool, calls } = probeTool();
    const gate = buildGate();
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(tool);

    const denied = gate.decide(request({ operation: 'delete' }));
    assert.equal(denied.decision.decision, 'DENY');
    const forged = JSON.parse(JSON.stringify(denied)) as Record<string, unknown>;
    (forged.decision as { decision: string }).decision = 'ALLOW';

    const result = await registry.call(TOOL, { resource: 'doc/1' }, ctx(forged as never));
    assertDeniedWithoutSideEffect(result, calls(), 'DENY upgraded to ALLOW');
  });

  it('INVARIANT G — an EXPIRED authorization is DENY and the tool never runs', async () => {
    const { tool, calls } = probeTool();
    let now = T0;
    const gate = buildGate(() => now);
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(tool);

    const envelope = gate.decide(request());
    assert.equal(envelope.decision.decision, 'ALLOW');
    now = T0 + 10 * 60_000; // well past the manifest lifetime

    const result = await registry.call(TOOL, { resource: 'doc/1' }, ctx(envelope));
    assertDeniedWithoutSideEffect(result, calls(), 'expired authorization');
  });

  it('INVARIANT H — a REPLAYED envelope is DENY and the side effect runs exactly once', async () => {
    const { tool, calls } = probeTool();
    const gate = buildGate();
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(tool);

    const envelope = gate.decide(request());
    const first = await registry.call(TOOL, { resource: 'doc/1' }, ctx(envelope));
    assert.equal(first.error, undefined, 'a legitimate authorized call must succeed');
    assert.equal(calls(), 1, 'the legitimate call executes exactly once');

    const replay = await registry.call(TOOL, { resource: 'doc/1' }, ctx(envelope));
    assert.ok(replay.error, 'the replayed envelope must be denied');
    assert.equal(calls(), 1, 'INVARIANT H VIOLATED — the replay re-executed the side effect');
  });

  it('INVARIANT D — an undeclared tool cannot execute behind the boundary', async () => {
    let ran = 0;
    const undeclared: Tool = {
      name: 'r1.undeclared',
      description: 'no A-01 declaration',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        ran += 1;
        return {};
      },
    };
    const gate = buildGate();
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(undeclared);

    const result = await registry.call('r1.undeclared', {}, ctx());
    assert.match(result.error ?? '', /UNDECLARED_TOOL_AUTHORIZATION/);
    assert.equal(ran, 0, 'an undeclared tool must never execute');
  });

  it('INVARIANT I — the LEGITIMATE authorized path still works (the boundary is not a blanket denial)', async () => {
    const { tool, calls } = probeTool();
    const gate = buildGate();
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(tool);

    const envelope = gate.decide(request());
    assert.equal(envelope.decision.decision, 'ALLOW');
    const result = await registry.call(TOOL, { resource: 'doc/1' }, ctx(envelope));

    assert.equal(result.error, undefined);
    assert.deepEqual(result.output, { performed: true });
    assert.equal(calls(), 1);
  });
});
