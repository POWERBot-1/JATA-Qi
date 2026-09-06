// R-4 adversarial suite: the operator CLI must never be able to read or write
// another tenant's knowledge merely because tenant context was omitted,
// misspelled, or deliberately manipulated.
//
// Boundary under test (packages/cli/src/knowledge-command.ts):
//   * the operator tenant comes from JATAQI_OPERATOR_TENANT (deployment config);
//   * `--tenant` is a consistency check only — it can never establish,
//     override, or widen the tenant;
//   * no tenant ⇒ refusal BEFORE any data-plane call (no boot, no read, no
//     write, no search);
//   * the reserved test-only DEFAULT_TENANT_ID is never an operator tenant and
//     is never silently substituted;
//   * the T-08.1 K1 fallback guard stays armed (this suite never sets
//     JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK or
//     JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK, and asserts they stay unset).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createJataQi } from '../src/bootstrap.js';
import { DEFAULT_TENANT_ID, KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { AgentRuntimeModule } from '@jataqi/agent-runtime';
import {
  CliTenantRefusal,
  parseKnowledgeCommandArgs,
  resolveOperatorTenant,
  runKnowledgeCommand,
  type KnowledgeCommand,
  type KnowledgeCommandDeps,
} from '../src/knowledge-command.js';

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';
const TEXT_A = 'Alpha Corp archives cobalt narwhal telemetry in Nairobi.';
const TEXT_B = 'Beta Ltd stores crimson otter ledgers in Mombasa.';
const QUERY_A = 'cobalt narwhal telemetry';
const QUERY_B = 'crimson otter ledgers';

/** Refusal reasons must be distinguishable so a refusal cannot be faked. */
function envWith(tenantId?: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  if (tenantId !== undefined) env.JATAQI_OPERATOR_TENANT = tenantId;
  return env as NodeJS.ProcessEnv;
}

/** Deps whose every method fails the test if the data plane is touched at all. */
function poisonDeps(): { deps: KnowledgeCommandDeps; touched: string[] } {
  const touched: string[] = [];
  const boom = (op: string) => () => {
    touched.push(op);
    throw new Error(`data plane must not be touched: ${op}`);
  };
  const deps: KnowledgeCommandDeps = {
    knowledge: {
      ingestText: boom('ingestText'),
      getChunk: boom('getChunk'),
      stats: boom('stats'),
      retrieve: boom('retrieve'),
    } as unknown as KnowledgeCommandDeps['knowledge'],
    graph: {
      extractFromText: boom('extractFromText'),
      linkMention: boom('linkMention'),
      stats: boom('graph.stats'),
      allEntities: boom('allEntities'),
      entitiesByType: boom('entitiesByType'),
    } as unknown as KnowledgeCommandDeps['graph'],
    runAgent: boom('runAgent'),
    env: envWith(undefined),
  };
  return { deps, touched };
}

interface Harness {
  deps: KnowledgeCommandDeps;
  knowledge: KnowledgeService;
  graph: KnowledgeGraphModule;
  run(cmd: KnowledgeCommand, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string[]; err: string[] }>;
}

describe('R-4 CLI tenant boundary — resolution fails closed', () => {
  it('resolves the configured operator tenant and trims it', () => {
    assert.equal(resolveOperatorTenant(envWith(`  ${TENANT_A}  `)), TENANT_A);
  });

  it('accepts a --tenant that merely agrees with the configured tenant', () => {
    assert.equal(resolveOperatorTenant(envWith(TENANT_A), TENANT_A), TENANT_A);
    assert.equal(resolveOperatorTenant(envWith(TENANT_A), ` ${TENANT_A} `), TENANT_A);
  });

  it('refuses when no operator tenant is configured (no default substituted)', () => {
    assert.throws(
      () => resolveOperatorTenant(envWith(undefined)),
      (err: unknown) => {
        assert.ok(err instanceof CliTenantRefusal);
        assert.equal(err.reason, 'missing');
        assert.match(err.message, /JATAQI_OPERATOR_TENANT/);
        assert.match(err.message, /Failing closed/);
        return true;
      },
    );
  });

  it('refuses a blank or whitespace-only operator tenant', () => {
    for (const blank of ['', '   ', '\t']) {
      assert.throws(
        () => resolveOperatorTenant(envWith(blank)),
        (err: unknown) => {
          assert.ok(err instanceof CliTenantRefusal);
          assert.equal(err.reason, 'blank');
          return true;
        },
        `expected refusal for ${JSON.stringify(blank)}`,
      );
    }
  });

  it('refuses the reserved test-only DEFAULT_TENANT_ID as an operator tenant', () => {
    assert.throws(
      () => resolveOperatorTenant(envWith(DEFAULT_TENANT_ID)),
      (err: unknown) => {
        assert.ok(err instanceof CliTenantRefusal);
        assert.equal(err.reason, 'reserved-default');
        assert.match(err.message, /DEFAULT_TENANT_ID/);
        return true;
      },
    );
    // Same refusal when the caller also declares it on the command line.
    assert.throws(() => resolveOperatorTenant(envWith(DEFAULT_TENANT_ID), DEFAULT_TENANT_ID), CliTenantRefusal);
  });

  it('refuses a --tenant that disagrees with the configured tenant (never overrides)', () => {
    assert.throws(
      () => resolveOperatorTenant(envWith(TENANT_A), TENANT_B),
      (err: unknown) => {
        assert.ok(err instanceof CliTenantRefusal);
        assert.equal(err.reason, 'mismatch');
        assert.match(err.message, /consistency check only/i);
        return true;
      },
    );
    // Attempting to reach the shared default bucket through the flag is refused too.
    assert.throws(() => resolveOperatorTenant(envWith(TENANT_A), DEFAULT_TENANT_ID), CliTenantRefusal);
  });

  it('refuses a self-declared --tenant with no configured tenant (no argv authority)', () => {
    assert.throws(
      () => resolveOperatorTenant(envWith(undefined), TENANT_B),
      (err: unknown) => {
        assert.ok(err instanceof CliTenantRefusal);
        assert.equal(err.reason, 'self-declared');
        assert.match(err.message, /never from the command line/i);
        return true;
      },
    );
  });

  it('rejects unknown or malformed flags instead of ignoring them', () => {
    assert.deepEqual(parseKnowledgeCommandArgs(['--tenant', TENANT_A, 'some', 'query']), {
      tenantId: TENANT_A,
      positional: ['some', 'query'],
    });
    assert.throws(() => parseKnowledgeCommandArgs([`--tenant=${TENANT_B}`]), /Unknown option/);
    assert.throws(() => parseKnowledgeCommandArgs(['--admin']), /Unknown option/);
    assert.throws(() => parseKnowledgeCommandArgs(['--roles', 'global_admin']), /Unknown option/);
    assert.throws(() => parseKnowledgeCommandArgs(['--tenant']), /requires a value/);
    assert.throws(() => parseKnowledgeCommandArgs(['--tenant', '--tenant']), /requires a value/);
    assert.throws(() => parseKnowledgeCommandArgs(['--tenant', TENANT_A, '--tenant', TENANT_B]), /twice/);
  });
});

describe('R-4 CLI tenant boundary — command execution is tenant-scoped', () => {
  let qi: Awaited<ReturnType<typeof createJataQi>>;
  let harness: Harness;
  let docA: string;
  let docB: string;

  before(async () => {
    // Seeding uses the service API with EXPLICIT tenants: no fallback flag is
    // set anywhere in this suite, so the T-08.1 K1 guard stays armed.
    qi = await createJataQi();
    const knowledge = qi.kernel.getModule<KnowledgeService>('knowledge');
    const graph = qi.kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    const agents = qi.kernel.getModule<AgentRuntimeModule>('agent-runtime');
    const a = await knowledge.ingestText(TEXT_A, { tenantId: TENANT_A });
    const b = await knowledge.ingestText(TEXT_B, { tenantId: TENANT_B });
    docA = a.id;
    docB = b.id;
    for (const [doc, tenant] of [
      [a, TENANT_A],
      [b, TENANT_B],
    ] as const) {
      for (const cid of doc.chunkIds) {
        const chunk = await knowledge.getChunk(cid, { tenantId: tenant });
        if (!chunk) continue;
        const extracted = graph.extractFromText(chunk.text, { chunkId: cid, documentId: doc.id }, tenant);
        for (const t of extracted.triples) graph.linkMention(cid, t.object, 0.7, doc.id, tenant);
      }
    }
    harness = {
      knowledge,
      graph,
      deps: { knowledge, graph, runAgent: (message, opts) => agents.run(message, opts) },
      async run(cmd, args, env) {
        const out: string[] = [];
        const errs: string[] = [];
        const code = await runKnowledgeCommand(cmd, args, { ...this.deps, env }, (l) => out.push(l), (l) => errs.push(l));
        return { code, out, err: errs };
      },
    };
  });

  after(async () => {
    await qi.shutdown();
  });

  it('search as tenant A never surfaces tenant B knowledge (adversarial: query with B text)', async () => {
    const res = await harness.run('search', [QUERY_B], envWith(TENANT_A));
    assert.equal(res.code, 0, `expected a scoped search to succeed, got: ${res.err.join(' | ')}`);
    const printed = res.out.join('\n');
    for (const forbidden of ['crimson', 'otter', 'Mombasa', docB]) {
      assert.equal(printed.includes(forbidden), false, `tenant A saw tenant B content: ${forbidden}`);
    }
  });

  it('search as tenant B returns tenant B knowledge (the index is intact; scoping is what differs)', async () => {
    const res = await harness.run('search', [QUERY_B], envWith(TENANT_B));
    assert.equal(res.code, 0);
    const printed = res.out.join('\n');
    assert.match(printed, /crimson otter/i, 'tenant B must be able to retrieve its own knowledge');
    assert.equal(printed.includes(docA), false, 'tenant B saw tenant A content');
  });

  it('search as tenant A returns tenant A knowledge only', async () => {
    const res = await harness.run('search', [QUERY_A], envWith(TENANT_A));
    assert.equal(res.code, 0);
    const printed = res.out.join('\n');
    assert.match(printed, /cobalt narwhal/i);
    assert.equal(printed.includes(docB), false);
    for (const forbidden of ['crimson', 'otter', 'Mombasa']) {
      assert.equal(printed.includes(forbidden), false, `tenant A saw tenant B content: ${forbidden}`);
    }
  });

  it('stats reports only the operator tenant, never global cross-tenant totals', async () => {
    const res = await harness.run('stats', [], envWith(TENANT_A));
    assert.equal(res.code, 0);
    const scoped = JSON.parse(res.out.join('\n')) as { tenantId: string; knowledge: { documents: number; chunks: number } };
    assert.equal(scoped.tenantId, TENANT_A);
    assert.equal(scoped.knowledge.documents, 1, 'tenant A owns exactly one document');
    // The unscoped service call would report both tenants — proof that the CLI
    // path is genuinely narrowed rather than accidentally equal.
    const global = await harness.knowledge.stats();
    assert.equal(global.documents, 2, 'the store holds both tenants');
    assert.ok(scoped.knowledge.documents < global.documents);
  });

  it('entities lists only the operator tenant graph', async () => {
    const resA = await harness.run('entities', [], envWith(TENANT_A));
    assert.equal(resA.code, 0);
    const printedA = resA.out.join('\n');
    assert.match(printedA, /\[tenant tenant-alpha\]/);
    assert.equal(printedA.includes('Beta'), false, 'tenant A graph leaked tenant B entities');
    const resB = await harness.run('entities', [], envWith(TENANT_B));
    assert.equal(resB.code, 0);
    assert.equal(resB.out.join('\n').includes('Alpha'), false, 'tenant B graph leaked tenant A entities');
  });

  it('ask threads the resolved tenant into the agent run metadata (tool execution tenant)', async () => {
    const seen: Array<{ message: string; opts: { metadata: Record<string, unknown> } }> = [];
    const out: string[] = [];
    const code = await runKnowledgeCommand(
      'ask',
      ['what', 'does', 'Alpha', 'store'],
      {
        knowledge: harness.knowledge,
        graph: harness.graph,
        runAgent: async (message, opts) => {
          seen.push({ message, opts });
          return { answer: 'stub answer' };
        },
        env: envWith(TENANT_A),
      },
      (l) => out.push(l),
    );
    assert.equal(code, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.opts.metadata.tenantId, TENANT_A, 'the agent must run with the operator tenant');
    assert.equal(seen[0]?.message, 'what does Alpha store');
    assert.deepEqual(out, ['stub answer']);
  });

  it('missing tenant context fails closed for every command with NO data-plane call', async () => {
    const commands: Array<[KnowledgeCommand, string[]]> = [
      ['search', [QUERY_A]],
      ['stats', []],
      ['ingest', ['notes.txt']],
      ['entities', []],
      ['ask', ['hello']],
    ];
    for (const [cmd, args] of commands) {
      const { deps, touched } = poisonDeps();
      const out: string[] = [];
      const errs: string[] = [];
      const code = await runKnowledgeCommand(cmd, args, deps, (l) => out.push(l), (l) => errs.push(l));
      assert.equal(code, 1, `${cmd} must refuse without a tenant`);
      assert.deepEqual(touched, [], `${cmd} touched the data plane without a tenant: ${touched.join(', ')}`);
      assert.deepEqual(out, [], `${cmd} printed data without a tenant`);
      assert.match(errs.join('\n'), /refused/i, `${cmd} must state the refusal`);
      assert.match(errs.join('\n'), /JATAQI_OPERATOR_TENANT/, `${cmd} must name the missing configuration`);
    }
  });

  it('tenant manipulation fails closed with NO data-plane call', async () => {
    const cases: Array<{ name: string; cmd: KnowledgeCommand; args: string[]; env: NodeJS.ProcessEnv; reason: string }> = [
      { name: 'flag tries to switch tenant', cmd: 'search', args: ['--tenant', TENANT_B, QUERY_B], env: envWith(TENANT_A), reason: 'mismatch' },
      { name: 'flag self-declares a tenant', cmd: 'search', args: ['--tenant', TENANT_B, QUERY_B], env: envWith(undefined), reason: 'self-declared' },
      { name: 'flag targets the default bucket', cmd: 'search', args: ['--tenant', DEFAULT_TENANT_ID, QUERY_A], env: envWith(TENANT_A), reason: 'mismatch' },
      { name: 'configured tenant is the default bucket', cmd: 'search', args: [QUERY_A], env: envWith(DEFAULT_TENANT_ID), reason: 'reserved-default' },
      { name: 'inline flag form is rejected', cmd: 'search', args: [`--tenant=${TENANT_B}`, QUERY_B], env: envWith(TENANT_A), reason: 'parse' },
      { name: 'privilege flag is rejected', cmd: 'stats', args: ['--all-tenants'], env: envWith(TENANT_A), reason: 'parse' },
      { name: 'blank configured tenant', cmd: 'stats', args: [], env: envWith('   '), reason: 'blank' },
    ];
    for (const c of cases) {
      const { deps, touched } = poisonDeps();
      const out: string[] = [];
      const errs: string[] = [];
      const code = await runKnowledgeCommand(c.cmd, c.args, { ...deps, env: c.env }, (l) => out.push(l), (l) => errs.push(l));
      assert.equal(code, 1, `${c.name}: must refuse`);
      assert.deepEqual(touched, [], `${c.name}: touched the data plane: ${touched.join(', ')}`);
      assert.deepEqual(out, [], `${c.name}: printed data`);
      assert.match(errs.join('\n'), /refused|Unknown option/i, `${c.name}: must state the refusal`);
    }
  });

  it('an agreeing --tenant is allowed and still scoped to the configured tenant', async () => {
    const res = await harness.run('search', ['--tenant', TENANT_A, QUERY_A], envWith(TENANT_A));
    assert.equal(res.code, 0);
    assert.match(res.out.join('\n'), /cobalt narwhal/i);
    assert.equal(res.out.join('\n').includes(docB), false);
  });

  it('ingest writes only into the operator tenant; the default tenant is never used', async () => {
    // Fresh kernel so this write path cannot perturb the read-path assertions.
    const instance = await createJataQi();
    try {
      const knowledge = instance.kernel.getModule<KnowledgeService>('knowledge');
      const graph = instance.kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
      const out: string[] = [];
      const code = await runKnowledgeCommand(
        'ingest',
        ['alpha-notes.txt'],
        {
          knowledge,
          graph,
          runAgent: async () => ({ answer: '' }),
          readFile: async () => TEXT_A,
          env: envWith(TENANT_A),
        },
        (l) => out.push(l),
      );
      assert.equal(code, 0, `ingest must succeed with an explicit tenant: ${out.join(' | ')}`);
      const line = out[0] ?? '';
      const match = /doc ([0-9a-f-]{36})/.exec(line);
      assert.ok(match, `expected a document id in: ${line}`);
      const docId = match[1]!;
      assert.match(line, new RegExp(`\\[tenant ${TENANT_A}\\]`), 'the receipt must state the tenant');

      // Visible to its own tenant only.
      assert.ok(await knowledge.getDocument(docId, { tenantId: TENANT_A }));
      assert.equal(await knowledge.getDocument(docId, { tenantId: TENANT_B }), undefined, 'tenant B must not see it');
      assert.equal(await knowledge.getDocument(docId, { tenantId: DEFAULT_TENANT_ID }), undefined, 'the default bucket must not hold it');
      const doc = await knowledge.getDocument(docId, { tenantId: TENANT_A });
      assert.equal(doc?.tenantId, TENANT_A);
      for (const cid of doc?.chunkIds ?? []) {
        assert.equal(await knowledge.getChunk(cid, { tenantId: TENANT_B }), undefined, 'chunks must not leak to tenant B');
        const chunk = await knowledge.getChunk(cid, { tenantId: TENANT_A });
        assert.equal(chunk?.tenantId, TENANT_A, 'chunks must be stamped with the operator tenant');
      }
      // The graph write path created a store for the operator tenant only.
      // knowledge-graph registers a legacy, EMPTY DEFAULT_TENANT_ID store handle
      // at boot (`graph.store`), so the invariant that matters is that no DATA
      // was written into the reserved default bucket or into tenant B.
      assert.ok(graph.tenantKeys().includes(TENANT_A));
      assert.equal(graph.tenantKeys().includes(TENANT_B), false);
      const defaultStats = graph.stats(DEFAULT_TENANT_ID);
      assert.equal(defaultStats.entities, 0, 'no entity may be written to the default tenant');
      assert.equal(defaultStats.triples, 0, 'no triple may be written to the default tenant');
      // A tenant-B search cannot find the freshly ingested A document.
      const asB = await knowledge.retrieve(QUERY_A, { tenantId: TENANT_B, topK: 5 });
      assert.equal(asB.some((h) => h.document.id === docId), false, 'tenant B retrieved tenant A document');
      // Nothing at all was written into the reserved default tenant bucket.
      const defaultDocs = await knowledge.stats({ tenantId: DEFAULT_TENANT_ID });
      assert.equal(defaultDocs.documents, 0, 'no document may be written to the default tenant');
      assert.equal(defaultDocs.chunks, 0, 'no chunk may be written to the default tenant');
    } finally {
      await instance.shutdown();
    }
  });

  it('T-08.1 K1 stays intact: no fallback flag is set and tenant-less calls still fail closed', async () => {
    assert.equal(process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK, undefined, 'the CLI must never enable the fallback');
    assert.equal(process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK, undefined, 'the CLI must never enable the test-only fallback');
    await assert.rejects(
      () => harness.knowledge.ingestText('no tenant supplied'),
      /Failing closed/,
      'the service-level tenant fallback guard must still refuse a tenant-less ingest',
    );
    assert.throws(() => harness.graph.stats(), /Failing closed/, 'the graph tenant guard must still refuse a tenant-less call');
    // And a successful CLI run did not weaken either guard.
    const res = await harness.run('stats', [], envWith(TENANT_A));
    assert.equal(res.code, 0);
    assert.equal(process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK, undefined);
    assert.equal(process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK, undefined);
    await assert.rejects(() => harness.knowledge.ingestText('still no tenant'), /Failing closed/);
  });
});
