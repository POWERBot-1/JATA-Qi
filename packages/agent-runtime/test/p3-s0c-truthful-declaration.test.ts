// P3-B0 S0c (OD-5) — agent-runtime side: the truthful capability declaration.
//
// F-3 (VERIFIED DEFECT): `vector.search` was authorized as an internal READ
// (`internal-knowledge.read`, impact READ) while its effect is a CREDENTIALED
// EXTERNAL TRANSMISSION (the query is embedded at the N-2 seam,
// vector-search embeddings). S0c corrects the declaration via a NEW
// capabilityId with the truthful level from the closed impact enum
// (EXTERNAL_SIDE_EFFECT) and retires the false binding — per the P3-B0
// design record §4.5(i), U-3(α). The genuinely read-only knowledge/graph
// tools keep their READ declaration unchanged.
//
// The end-to-end section proves the whole chain through the real
// ToolRegistry + gate: under an egress-bound manifest the SAME envelope can
// drive exactly ONE transmission; a replay is refused before any data-plane
// work; and a composition still registering only the retired READ capability
// fails closed for the egress tool.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthorizationGate,
  CapabilityManifestRegistry,
  InMemoryAuditSink,
  testCapabilityManifest,
  testPrincipal,
  type A01AuthorizationRequest,
} from '@jataqi/authorization-boundary';
import type { VectorSearchModule } from '@jataqi/vector-search';
import {
  ToolRegistry,
  graphFindEntityTool,
  graphRetrieveTool,
  graphTraverseTool,
  knowledgeSearchTool,
  vectorSearchTool,
  type ToolContext,
} from '../src/index.js';

// The OD-5 capability ids named by the P3-B0 design record §4.5(i).
const EGRESS_CAPABILITY = 'internal-knowledge.vector-search-egress';
const FALSE_CAPABILITY = 'internal-knowledge.read';

const T0 = 1_700_000_000_000;
const silentLogger = { info() {}, debug() {}, error() {} };

function ctx(tenantId: string): ToolContext {
  return { runId: 's0c-run', logger: silentLogger, metadata: { tenantId } };
}

/** A recording stand-in for the vector module (authorization semantics under test). */
function recordingVectors(): { module: VectorSearchModule; calls: Array<{ index: string; text: string; tenantId?: string }> } {
  const calls: Array<{ index: string; text: string; tenantId?: string }> = [];
  const module = {
    async embedAndSearch(index: string, text: string, opts?: { tenantId?: string }) {
      calls.push({ index, text, ...(opts?.tenantId !== undefined ? { tenantId: opts.tenantId } : {}) });
      return [];
    },
  } as unknown as VectorSearchModule;
  return { module, calls };
}

/** The request the boundary renders for `vector.search` from its declaration. */
function vectorSearchRequest(tenantId: string): A01AuthorizationRequest {
  const decl = vectorSearchTool(() => recordingVectors().module).authorization!;
  return {
    principal: testPrincipal({ id: 'user:alice', tenantId, roles: ['operator'] }),
    tenantId,
    agent: { agentId: 's0c-agent' },
    run: { runId: 's0c-run', correlationId: 's0c-corr' },
    capability: { capabilityId: decl.capabilityId, capabilityVersion: decl.capabilityVersion },
    tool: 'vector.search',
    operation: decl.operation,
    target: { system: decl.targetSystem },
    dataClassification: decl.dataClassification,
    impact: decl.impact,
    budgetCostUnits: 1,
    provenance: { source: 'p3-s0c-test' },
  };
}

function egressGate(tenantId: string, manifestOverrides: Record<string, unknown> = {}): AuthorizationGate {
  const manifests = new CapabilityManifestRegistry();
  manifests.register({
    ...testCapabilityManifest({
      capabilityId: EGRESS_CAPABILITY,
      operations: [{ tool: 'vector.search', operation: 'search' }],
      targets: [{ system: 'tenant-knowledge' }],
      tenantScopes: [tenantId],
      maxImpact: 'EXTERNAL_SIDE_EFFECT',
      rateLimit: { windowMs: 60_000, max: 100_000 },
      budgetPerRunCostUnits: 100_000,
    }),
    // OD-5: the governance registration declares the egress binding.
    egressBound: true,
    ...manifestOverrides,
  });
  return new AuthorizationGate({ now: () => T0, manifests, audit: new InMemoryAuditSink() });
}

// ---------------------------------------------------------------------------
// 1. Declaration truthfulness (OD-5(i))
// ---------------------------------------------------------------------------

describe('S0c OD-5(i): truthful external-side-effect declaration', () => {
  it('vector.search declares the NEW egress capability with the truthful impact level', () => {
    const decl = vectorSearchTool(() => recordingVectors().module).authorization!;
    assert.equal(decl.capabilityId, EGRESS_CAPABILITY, 'the design-record capabilityId');
    assert.notEqual(decl.capabilityId, FALSE_CAPABILITY, 'distinct from the false capability');
    assert.equal(decl.capabilityVersion, '1');
    assert.equal(decl.operation, 'search');
    assert.equal(decl.impact, 'EXTERNAL_SIDE_EFFECT', 'the truthful level from the closed impact enum (F-3 correction)');
    assert.equal(decl.dataClassification, 'INTERNAL', 'tenant knowledge text remains INTERNAL-classified');
    assert.equal(decl.targetSystem, 'tenant-knowledge');
  });

  it('the false capability is retired for vector.search but untouched for genuine reads', () => {
    for (const build of [knowledgeSearchTool, graphTraverseTool, graphFindEntityTool, graphRetrieveTool]) {
      const decl = build(() => ({} as never)).authorization!;
      assert.equal(decl.capabilityId, FALSE_CAPABILITY, `${build(() => ({} as never)).name} stays on the internal READ capability`);
      assert.equal(decl.impact, 'READ', `${build(() => ({} as never)).name} stays a genuine READ`);
    }
    assert.equal(
      vectorSearchTool(() => recordingVectors().module).authorization!.capabilityId,
      EGRESS_CAPABILITY,
      'vector.search no longer runs under the internal READ capability',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end through the real ToolRegistry + gate
// ---------------------------------------------------------------------------

describe('S0c OD-5(ii): vector.search consume-once end-to-end behind the boundary', () => {
  it('valid S0c authorization succeeds; ONE envelope drives exactly ONE transmission', async () => {
    const vectors = recordingVectors();
    const gate = egressGate('acme');
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(vectorSearchTool(() => vectors.module));
    const envelope = gate.decide(vectorSearchRequest('acme'));
    assert.equal(envelope.decision.decision, 'ALLOW');
    assert.equal(envelope.egressBound, true, 'the sealed decision carries the egress binding');

    const first = await registry.call('vector.search', { query: 'cobalt narwhal', index: 'knowledge.chunks' }, { ...ctx('acme'), authorization: { envelope } });
    assert.equal(first.error, undefined, `expected success, got: ${first.error}`);
    assert.equal(vectors.calls.length, 1, 'one transmission reached the seam');
    assert.equal(vectors.calls[0]!.tenantId, 'acme');

    const replay = await registry.call('vector.search', { query: 'cobalt narwhal', index: 'knowledge.chunks' }, { ...ctx('acme'), authorization: { envelope } });
    assert.ok(replay.error, 'the replay of the same envelope is refused');
    assert.match(replay.error!, /REPLAYED_AUTHORIZATION/);
    assert.equal(vectors.calls.length, 1, 'no second transmission — consume-once held end-to-end');
  });

  it('fails closed when only the retired READ capability is registered (UNKNOWN_CAPABILITY)', async () => {
    const vectors = recordingVectors();
    const manifests = new CapabilityManifestRegistry();
    manifests.register(
      testCapabilityManifest({
        capabilityId: FALSE_CAPABILITY,
        operations: [{ tool: 'vector.search', operation: 'search' }],
        targets: [{ system: 'tenant-knowledge' }],
        tenantScopes: ['acme'],
        maxImpact: 'READ',
        rateLimit: { windowMs: 60_000, max: 100_000 },
        budgetPerRunCostUnits: 100_000,
      }),
    );
    const gate = new AuthorizationGate({ now: () => T0, manifests, audit: new InMemoryAuditSink() });
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(vectorSearchTool(() => vectors.module));
    const envelope = gate.decide(vectorSearchRequest('acme'));
    assert.equal(envelope.decision.decision, 'DENY', 'the truthful declaration cannot be granted by the retired capability');
    assert.ok(envelope.decision.reasonCodes.includes('UNKNOWN_CAPABILITY'));
    const res = await registry.call('vector.search', { query: 'cobalt narwhal' }, { ...ctx('acme'), authorization: { envelope } });
    assert.ok(res.error, 'the call is refused');
    assert.match(res.error!, /ENVELOPE_NOT_ALLOWED|UNKNOWN_CAPABILITY/);
    assert.equal(vectors.calls.length, 0, 'no data-plane work happened');
  });

  it('fails closed when an egress manifest lacks the truthful impact ceiling (IMPACT_EXCEEDED)', async () => {
    const vectors = recordingVectors();
    // A mis-governed registration: the egress capability id with a READ
    // ceiling and no binding. The truthful EXTERNAL_SIDE_EFFECT declaration
    // must NOT pass under it.
    const gate = egressGate('acme', { maxImpact: 'READ', egressBound: undefined });
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(vectorSearchTool(() => vectors.module));
    const envelope = gate.decide(vectorSearchRequest('acme'));
    assert.equal(envelope.decision.decision, 'DENY');
    assert.ok(envelope.decision.reasonCodes.includes('IMPACT_EXCEEDED'), 'the READ ceiling refuses the external side effect');
    const res = await registry.call('vector.search', { query: 'cobalt narwhal' }, { ...ctx('acme'), authorization: { envelope } });
    assert.ok(res.error);
    assert.equal(vectors.calls.length, 0);
  });

  it('no envelope at all still fails closed (AUTHORIZATION_ENVELOPE_MISSING)', async () => {
    const vectors = recordingVectors();
    const gate = egressGate('acme');
    const registry = new ToolRegistry({ authorizationGate: gate });
    registry.register(vectorSearchTool(() => vectors.module));
    const res = await registry.call('vector.search', { query: 'cobalt narwhal' }, ctx('acme'));
    assert.match(res.error ?? '', /AUTHORIZATION_ENVELOPE_MISSING/);
    assert.equal(vectors.calls.length, 0);
  });
});
