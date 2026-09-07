// S-1 (Tenant Boundary Hardening) — adversarial tests for the agent tool layer.
//
// Contract under test: authorization lives OUTSIDE the model. Every built-in
// tool resolves its execution tenant from the run context (`metadata.tenantId`)
// BEFORE touching any data plane, refuses with `TenantContextError` when the
// context carries no unambiguous tenant, and can never be steered into another
// tenant by the model (no tool input schema accepts a tenant).
//
// No fallback flag is set anywhere in this suite.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { Kernel } from '@jataqi/core-kernel';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService, TenantContextError, TENANT_CONTEXT_REQUIRED } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import {
  Agent,
  ScriptedLLM,
  graphFindEntityTool,
  graphRetrieveTool,
  graphTraverseTool,
  knowledgeSearchTool,
  vectorSearchTool,
} from '../src/index.js';
import type { Tool, ToolContext } from '../src/index.js';
// R1 (§6): the agent loop now runs behind the REAL mandatory boundary. These
// fixtures construct LEGITIMATE per-tenant authorization; nothing is mocked
// or bypassed. The tenant on a call comes from the SEALED ENVELOPE, which is
// strictly stronger than the caller-supplied metadata this suite used before.
import {
  AuthorizationGate,
  CapabilityManifestRegistry,
  InMemoryAuditSink,
  testCapabilityManifest,
  testPrincipal,
} from '@jataqi/authorization-boundary';

/** A real gate granting `internal-knowledge.read` to exactly one tenant. */
function knowledgeGate(tenantId: string): AuthorizationGate {
  const manifests = new CapabilityManifestRegistry();
  manifests.register(
    testCapabilityManifest({
      capabilityId: 'internal-knowledge.read',
      operations: [
        { tool: 'knowledge.search', operation: 'search' },
        { tool: 'graph.traverse', operation: 'traverse' },
      ],
      targets: [{ system: 'tenant-knowledge' }],
      tenantScopes: [tenantId],
      maxImpact: 'READ',
      rateLimit: { windowMs: 60_000, max: 100_000 },
      budgetPerRunCostUnits: 100_000,
    }),
  );
  return new AuthorizationGate({ manifests, audit: new InMemoryAuditSink() });
}

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';
const ATTACKER = 'tenant-attacker';
const SECRET_A = 'alpha-only-clearance-9f31';
const TEXT_A = 'Alpha Corp archives cobalt narwhal telemetry from a Nairobi data centre.';
const TEXT_B = 'Beta Ltd stores crimson otter ledgers in a Mombasa warehouse.';

const silentLogger = { info() {}, debug() {}, error() {} };

function ctx(metadata: Record<string, unknown>): ToolContext {
  return { runId: 's1-run', logger: silentLogger, metadata };
}

/** Deps whose every data-plane method records the call and then fails the test. */
function poisonedDeps() {
  const calls: string[] = [];
  const poison = (name: string): never => {
    calls.push(name);
    throw new Error(`data-plane call ${name} must never happen without a tenant`);
  };
  const svc = {
    retrieve: (...args: unknown[]) => poison(`knowledge.retrieve(${JSON.stringify(args)})`),
    getDocument: (...args: unknown[]) => poison(`knowledge.getDocument(${JSON.stringify(args)})`),
    getChunk: (...args: unknown[]) => poison(`knowledge.getChunk(${JSON.stringify(args)})`),
    deleteDocument: (...args: unknown[]) => poison(`knowledge.deleteDocument(${JSON.stringify(args)})`),
    stats: () => poison('knowledge.stats()'),
    ingestText: () => poison('knowledge.ingestText()'),
  };
  const graph = {
    traverse: (...args: unknown[]) => poison(`graph.traverse(${JSON.stringify(args)})`),
    findEntities: (...args: unknown[]) => poison(`graph.findEntities(${JSON.stringify(args)})`),
    graphRetrieve: (...args: unknown[]) => poison(`graph.graphRetrieve(${JSON.stringify(args)})`),
    allEntities: () => poison('graph.allEntities()'),
    getEntity: (...args: unknown[]) => poison(`graph.getEntity(${JSON.stringify(args)})`),
    stats: () => poison('graph.stats()'),
  };
  const vectors = {
    embedAndSearch: (...args: unknown[]) => poison(`vectors.embedAndSearch(${JSON.stringify(args)})`),
    search: (...args: unknown[]) => poison(`vectors.search(${JSON.stringify(args)})`),
    index: (...args: unknown[]) => poison(`vectors.index(${JSON.stringify(args)})`),
  };
  return { calls, svc, graph, vectors };
}

describe('S-1 agent tool tenant boundary (authorization outside the model)', () => {
  let kernel: Kernel;
  let svc: KnowledgeService;
  let graph: KnowledgeGraphModule;
  let vectors: VectorSearchModule;
  let docAId: string;
  let docBId: string;
  let chunkAId: string;

  beforeEach(async () => {
    assert.equal(process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK, undefined);
    assert.equal(process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK, undefined);
    kernel = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    kernel.register(new StorageModule());
    kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    kernel.register(new KnowledgeService());
    kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: true }));
    await kernel.boot();
    svc = kernel.getModule<KnowledgeService>('knowledge');
    graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    vectors = kernel.getModule<VectorSearchModule>('vector-search');
    const docA = await svc.ingestText(TEXT_A, { tenantId: TENANT_A, title: 'Alpha secret ledger', metadata: { clearance: SECRET_A } });
    const docB = await svc.ingestText(TEXT_B, { tenantId: TENANT_B, title: 'Beta otter ledger', metadata: { clearance: 'beta-only' } });
    docAId = docA.id;
    docBId = docB.id;
    chunkAId = docA.chunkIds[0]!;
    graph.addOrGetEntity({ id: 'ent:alpha', type: 'Organization', name: 'Alpha Corp', properties: { clearance: SECRET_A } }, TENANT_A);
    graph.addOrGetEntity({ id: 'ent:beta', type: 'Organization', name: 'Beta Ltd', properties: { clearance: 'beta-only' } }, TENANT_B);
    graph.linkMention(chunkAId, 'ent:alpha', 0.95, docAId, TENANT_A);
  });

  afterEach(async () => {
    try { await kernel.shutdown(); } catch { /* ignore */ }
  });

  describe('tenantless tool execution is refused with zero data-plane work', () => {
    const cases: Array<{ tool: string; build: (d: ReturnType<typeof poisonedDeps>) => Tool; input: Record<string, unknown> }> = [
      { tool: 'knowledge.search', build: (d) => knowledgeSearchTool(() => d.svc as unknown as KnowledgeService), input: { query: 'cobalt narwhal', topK: 5 } },
      { tool: 'graph.traverse', build: (d) => graphTraverseTool(() => d.graph as unknown as KnowledgeGraphModule), input: { entityId: 'ent:alpha' } },
      { tool: 'graph.findEntity', build: (d) => graphFindEntityTool(() => d.graph as unknown as KnowledgeGraphModule), input: { query: 'Alpha Corp' } },
      { tool: 'graph.retrieve', build: (d) => graphRetrieveTool(() => d.graph as unknown as KnowledgeGraphModule), input: { query: 'cobalt narwhal' } },
      { tool: 'vector.search', build: (d) => vectorSearchTool(() => d.vectors as unknown as VectorSearchModule), input: { query: 'cobalt narwhal', index: 'knowledge.chunks' } },
    ];

    for (const badMetadata of [
      { label: 'no tenant key', metadata: {} as Record<string, unknown> },
      { label: 'empty tenant', metadata: { tenantId: '' } },
      { label: 'whitespace tenant', metadata: { tenantId: '   ' } },
      { label: 'null tenant', metadata: { tenantId: null } },
      { label: 'non-string tenant', metadata: { tenantId: 42 } },
      { label: 'object tenant', metadata: { tenantId: { id: TENANT_A } } },
    ]) {
      for (const c of cases) {
        it(`${c.tool} refuses (${badMetadata.label}) without calling any data plane`, async () => {
          const deps = poisonedDeps();
          const tool = c.build(deps);
          let caught: unknown;
          try {
            await tool.execute(c.input, ctx(badMetadata.metadata));
          } catch (error) {
            caught = error;
          }
          assert.ok(caught instanceof TenantContextError, `${c.tool}: expected TenantContextError, got ${String(caught)}`);
          assert.equal((caught as TenantContextError).code, TENANT_CONTEXT_REQUIRED);
          assert.equal((caught as TenantContextError).operation, c.tool, 'the refusal names the tool');
          assert.match((caught as Error).message, /Failing closed/);
          assert.match((caught as Error).message, /no default tenant/, 'the refusal states no default tenant is substituted');
          assert.deepEqual(deps.calls, [], `${c.tool}: no data-plane call happened`);
        });
      }
    }

    it('no tool input schema accepts a tenant (the model cannot name one)', () => {
      const deps = poisonedDeps();
      for (const c of cases) {
        const schema = JSON.stringify(c.build(deps).inputSchema);
        assert.equal(schema.includes('tenant'), false, `${c.tool} input schema must not expose a tenant field`);
        assert.deepEqual(deps.calls, [], 'schema inspection performed no data-plane work');
      }
    });
  });

  describe('a tenant-bound tool run can never be steered into another tenant', () => {
    it('knowledge.search returns only the execution tenant chunks, even when the input names a foreign tenant or ids', async () => {
      const tool = knowledgeSearchTool(() => svc);
      const out = await tool.execute(
        // The model tries to name another tenant and to point at foreign ids.
        { query: 'crimson otter ledgers Mombasa', topK: 10, tenantId: TENANT_B, documentId: docBId, chunkId: docBId },
        ctx({ tenantId: TENANT_A }),
      ) as Array<{ documentId: string; text: string; metadata?: Record<string, unknown> }>;
      assert.ok(out.every((h) => h.documentId !== docBId), 'the foreign document id in the input changed nothing');
      assert.equal(JSON.stringify(out).includes('crimson otter'), false, 'B chunk text not disclosed to A');
      assert.equal(JSON.stringify(out).includes('beta-only'), false, 'B metadata not disclosed to A');

      const own = await tool.execute({ query: 'cobalt narwhal telemetry', topK: 10 }, ctx({ tenantId: TENANT_A })) as Array<{ documentId: string; text: string }>;
      assert.ok(own.some((h) => h.documentId === docAId), 'positive control: A retrieves its own chunks');
      assert.ok(own.every((h) => h.text.length > 0));

      const empty = await tool.execute({ query: 'cobalt narwhal telemetry crimson otter', topK: 10 }, ctx({ tenantId: ATTACKER }));
      assert.deepEqual(empty, [], 'a tenant with no data gets nothing, not someone else data');
    });

    it('graph tools (traverse/findEntity/retrieve) stay inside the execution tenant', async () => {
      const traverse = graphTraverseTool(() => graph);
      const findEntity = graphFindEntityTool(() => graph);
      const retrieve = graphRetrieveTool(() => graph);

      const pathsA = await traverse.execute({ entityId: `chunk:${chunkAId}`, maxDepth: 2 }, ctx({ tenantId: TENANT_A })) as Array<{ entities: Array<{ id: string; name: string }> }>;
      assert.ok(pathsA.length > 0, 'A can traverse its own mention link');
      assert.ok(pathsA.every((p) => p.entities.every((e) => e.id !== 'ent:beta')), 'B entity never appears in A traversal');
      assert.equal(JSON.stringify(pathsA).includes('Beta Ltd'), false, 'B entity name not disclosed');

      const pathsB = await traverse.execute({ entityId: 'ent:beta', maxDepth: 2, tenantId: TENANT_B }, ctx({ tenantId: TENANT_A }));
      assert.deepEqual(pathsB, [], 'traversing a foreign entity id from A yields nothing');

      const foundA = await findEntity.execute({ query: 'Beta Ltd crimson otter', topK: 10, tenantId: TENANT_B }, ctx({ tenantId: TENANT_A })) as Array<{ id: string; name: string }>;
      assert.ok(foundA.every((e) => e.id !== 'ent:beta'), 'semantic entity search cannot surface B entity to A');
      assert.equal(JSON.stringify(foundA).includes('beta-only'), false);

      const foundB = await findEntity.execute({ query: 'Alpha Corp cobalt narwhal', topK: 10 }, ctx({ tenantId: TENANT_B })) as Array<{ id: string }>;
      assert.ok(foundB.every((e) => e.id !== 'ent:alpha'), 'A entity invisible to B entity search');

      const ragA = await retrieve.execute({ query: 'crimson otter ledgers', topK: 10, tenantId: TENANT_B }, ctx({ tenantId: TENANT_A })) as Array<{ documentId: string; entities: Array<{ id: string }> }>;
      assert.ok(ragA.every((h) => h.documentId !== docBId), 'graph-RAG cannot pull B document into A run');
      assert.equal(JSON.stringify(ragA).includes('Beta otter ledger'), false, 'B document title not disclosed to A graph-RAG run');

      const ragAttacker = await retrieve.execute({ query: 'cobalt narwhal crimson otter', topK: 10 }, ctx({ tenantId: ATTACKER }));
      assert.deepEqual(ragAttacker, [], 'an empty tenant retrieves nothing through graph-RAG');
    });

    it('vector.search stays inside the execution tenant index scope', async () => {
      const tool = vectorSearchTool(() => vectors);
      const hitsA = await tool.execute({ query: 'crimson otter ledgers', index: 'knowledge.chunks', topK: 10, tenantId: TENANT_B }, ctx({ tenantId: TENANT_A })) as Array<{ id: string; metadata?: Record<string, unknown> }>;
      assert.ok(hitsA.every((h) => h.metadata?.tenantId === TENANT_A), 'every hit is A-tagged');
      assert.equal(hitsA.some((h) => h.id === docBId), false);
      const hitsB = await tool.execute({ query: 'cobalt narwhal telemetry', index: 'knowledge.chunks', topK: 10 }, ctx({ tenantId: TENANT_B })) as Array<{ metadata?: Record<string, unknown> }>;
      assert.ok(hitsB.every((h) => h.metadata?.tenantId === TENANT_B), 'every hit is B-tagged');
      assert.equal(JSON.stringify(hitsB).includes(SECRET_A), false, 'A metadata not disclosed through raw vector search');
    });
  });

  describe('agent loop: a run without tenant context gets a refusal, not data', () => {
    function agentWithSearch(gate?: AuthorizationGate) {
      return new Agent({
        name: 's1-agent',
        llm: new ScriptedLLM([
          { toolCalls: [{ id: 'call-1', name: 'knowledge.search', input: { query: 'cobalt narwhal telemetry crimson otter ledgers', topK: 10 } }] },
          { text: 'done' },
        ]),
        tools: [knowledgeSearchTool(() => svc)],
        ...(gate ? { authorizationGate: gate } : {}),
      });
    }

    // R1: a run with NO authorization context is now denied by the mandatory
    // boundary itself, which is strictly stronger than the previous
    // tenant-context refusal: the tool is never entered at all.
    it('surfaces the refusal to the model and discloses nothing', async () => {
      const agent = agentWithSearch();
      const res = await agent.run({ message: 'What do we know about narwhals and otters?' });
      assert.equal(res.toolCalls.length, 1, 'the tool was attempted');
      const call = res.toolCalls[0]!;
      assert.ok(call.error, 'the tool call failed closed');
      assert.match(call.error!, /AUTHORIZATION_DENIED|Failing closed/, 'the refusal reason reaches the loop');
      assert.equal(call.output, undefined, 'a denied call discloses no data');
      assert.equal(JSON.stringify(res.messages).includes(SECRET_A), false, 'no A data entered the conversation');
      assert.equal(JSON.stringify(res.messages).includes('crimson otter ledgers in a Mombasa'), false, 'no B data entered the conversation');
      // The victim tenants' data is untouched and still only visible to them.
      assert.ok(await svc.getDocument(docAId, { tenantId: TENANT_A }));
      assert.ok(await svc.getDocument(docBId, { tenantId: TENANT_B }));
    });

    it('returns only the run tenant data when the SEALED ENVELOPE carries the tenant', async () => {
      const agent = agentWithSearch(knowledgeGate(TENANT_A));
      const res = await agent.run({
        message: 'What do we know about narwhals?',
        authorization: { principal: testPrincipal({ id: 'user:a', tenantId: TENANT_A, roles: ['operator'] }), agentId: 's1-agent' },
      });
      const call = res.toolCalls[0]!;
      assert.equal(call.error, undefined, 'the tenant-bound call succeeds');
      const output = JSON.stringify(call.output);
      assert.ok(output.includes(docAId), 'A own document is returned to A run');
      assert.equal(output.includes(docBId), false, 'B document is not returned to A run');
      assert.equal(output.includes('crimson otter'), false, 'B chunk text is not returned to A run');
      assert.equal(JSON.stringify(res.messages).includes('beta-only'), false, 'B metadata never reaches the model');
    });

    it('a run authorized for another tenant is scoped to that tenant only (no mixing)', async () => {
      const agent = agentWithSearch(knowledgeGate(TENANT_B));
      const res = await agent.run({
        message: 'otter ledgers?',
        authorization: { principal: testPrincipal({ id: 'user:b', tenantId: TENANT_B, roles: ['operator'] }), agentId: 's1-agent' },
      });
      const output = JSON.stringify(res.toolCalls[0]!.output);
      assert.ok(output.includes(docBId), 'B run sees B data');
      assert.equal(output.includes(docAId), false, 'B run never sees A data');
      assert.equal(output.includes(SECRET_A), false, 'A clearance metadata never reaches a B run');
    });
  });
});
