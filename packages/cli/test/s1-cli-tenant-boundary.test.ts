// S-1 (Tenant Boundary Hardening) — CLI adversarial tests.
//
// V-2: `entities` may not enumerate another tenant's graph. The authoritative
// protection is the graph module's tenant partitioning (a tenantless graph call
// fails closed there — proven in packages/knowledge-graph), and the CLI keeps a
// defense-in-depth re-attribution: every listed row is verified through the
// authoritative tenant-scoped `getEntity(id, tenantId)` lookup, and anything not
// attributable to the operator tenant (a foreign tenant marker, a poisoned
// listing, or a dependency without the lookup at all) is DROPPED with an
// auditable count instead of printed.
//
// B-4: `host:*` inspection resolves the operator tenant BEFORE the kernel boots.
// A missing, blank, or reserved-`default` operator tenant is refused with exit 1
// and nothing is booted, read, or reported.
//
// No fallback flag is set anywhere in this suite.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createJataQi } from '../src/bootstrap.js';
import { runHostInspectCommand, type HostInspectCommand } from '../src/host-inspect.js';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { AgentRuntimeModule } from '@jataqi/agent-runtime';
import {
  runKnowledgeCommand,
  type KnowledgeCommandDeps,
} from '../src/knowledge-command.js';
import type { Entity } from '@jataqi/knowledge-graph';

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';
const TEXT_A = 'Alpha Corp archives cobalt narwhal telemetry in Nairobi.';
const TEXT_B = 'Beta Ltd stores crimson otter ledgers in Mombasa.';

function envWith(tenantId?: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = { ...extra };
  if (tenantId !== undefined) env.JATAQI_OPERATOR_TENANT = tenantId;
  return env as NodeJS.ProcessEnv;
}

function entity(id: string, name: string, type = 'Concept', tenantId?: string): Entity {
  return { id, type, name, createdAt: 1, updatedAt: 1, ...(tenantId ? { tenantId } : {}) } as Entity;
}

interface RunResult { code: number; out: string[]; err: string[] }

/** Run `entities` against a hand-built (possibly poisoned) graph dependency. */
async function runEntities(
  graph: Partial<KnowledgeCommandDeps['graph']>,
  tenant: string | undefined,
): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const deps: KnowledgeCommandDeps = {
    knowledge: {
      ingestText: () => { throw new Error('unexpected ingestText'); },
      getChunk: () => { throw new Error('unexpected getChunk'); },
      stats: () => { throw new Error('unexpected stats'); },
      retrieve: () => { throw new Error('unexpected retrieve'); },
    } as unknown as KnowledgeCommandDeps['knowledge'],
    graph: {
      extractFromText: () => { throw new Error('unexpected extractFromText'); },
      linkMention: () => { throw new Error('unexpected linkMention'); },
      stats: () => ({ entities: 0, triples: 0, byType: {} }),
      ...graph,
    } as unknown as KnowledgeCommandDeps['graph'],
    runAgent: () => { throw new Error('unexpected runAgent'); },
    env: envWith(tenant),
  };
  const code = await runKnowledgeCommand('entities', [], deps, (l) => out.push(l), (l) => err.push(l));
  return { code, out, err };
}

describe('S-1 CLI tenant boundary — V-2 entities re-attribution', () => {
  let qi: Awaited<ReturnType<typeof createJataQi>>;
  let knowledge: KnowledgeService;
  let graph: KnowledgeGraphModule;
  let realDeps: KnowledgeCommandDeps;

  before(async () => {
    assert.equal(process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK, undefined);
    assert.equal(process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK, undefined);
    qi = await createJataQi();
    knowledge = qi.kernel.getModule<KnowledgeService>('knowledge');
    graph = qi.kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    const agents = qi.kernel.getModule<AgentRuntimeModule>('agent-runtime');
    const a = await knowledge.ingestText(TEXT_A, { tenantId: TENANT_A, title: 'Alpha ledger' });
    const b = await knowledge.ingestText(TEXT_B, { tenantId: TENANT_B, title: 'Beta ledger' });
    graph.addOrGetEntity({ id: 'ent:alpha', type: 'Organization', name: 'Alpha Corp' }, TENANT_A);
    graph.addOrGetEntity({ id: 'ent:beta', type: 'Organization', name: 'Beta Ltd' }, TENANT_B);
    graph.linkMention(a.chunkIds[0]!, 'ent:alpha', 0.9, a.id, TENANT_A);
    graph.linkMention(b.chunkIds[0]!, 'ent:beta', 0.9, b.id, TENANT_B);
    realDeps = { knowledge, graph, runAgent: (message, opts) => agents.run(message, opts) };
  });

  after(async () => {
    await qi.shutdown();
  });

  async function runReal(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runKnowledgeCommand('entities', args, { ...realDeps, env }, (l) => out.push(l), (l) => err.push(l));
    return { code, out, err };
  }

  it('lists only the operator tenant entities (positive control)', async () => {
    const resA = await runReal([], envWith(TENANT_A));
    assert.equal(resA.code, 0);
    const printedA = resA.out.join('\n');
    assert.match(printedA, /ent:alpha/, 'A sees its own entity');
    assert.equal(printedA.includes('ent:beta'), false, 'A never sees B entity id');
    assert.equal(printedA.includes('Beta Ltd'), false, 'A never sees B entity name');
    assert.match(printedA, new RegExp(`entities shown \\[tenant ${TENANT_A}\\]`), 'the listing is labelled with the operator tenant');
    assert.deepEqual(resA.err, [], 'a clean listing audits nothing');

    const resB = await runReal([], envWith(TENANT_B));
    const printedB = resB.out.join('\n');
    assert.match(printedB, /ent:beta/);
    assert.equal(printedB.includes('ent:alpha'), false, 'B never sees A entity id');
    assert.equal(printedB.includes('Alpha Corp'), false, 'B never sees A entity name');
  });

  it('a type-filtered listing is scoped and re-attributed the same way', async () => {
    const res = await runReal(['Organization'], envWith(TENANT_A));
    assert.equal(res.code, 0);
    const printed = res.out.join('\n');
    assert.match(printed, /ent:alpha/);
    assert.equal(printed.includes('Beta Ltd'), false, 'the filtered listing still excludes the other tenant');
  });

  it('drops a poisoned listing that returns a foreign entity, and audits the drop', async () => {
    const foreign = entity('ent:beta', 'Beta Ltd', 'Organization', TENANT_B);
    const res = await runEntities(
      {
        // A compromised/buggy dependency hands the operator tenant a foreign row…
        allEntities: () => [entity('ent:alpha', 'Alpha Corp', 'Organization', TENANT_A), foreign],
        entitiesByType: () => [foreign],
        // …but the authoritative tenant-scoped lookup does not corroborate it.
        getEntity: (id: string, tenantId?: string) => graph.getEntity(id, tenantId),
      },
      TENANT_A,
    );
    assert.equal(res.code, 0, 'the command still succeeds for the operator own rows');
    const printed = res.out.join('\n');
    assert.equal(printed.includes('Beta Ltd'), false, 'the foreign entity was NOT printed');
    assert.equal(printed.includes('ent:beta'), false, 'the foreign entity id was NOT printed');
    assert.match(printed, /ent:alpha/, 'the operator own entity is still listed');
    assert.match(printed, /1 entities shown \[tenant tenant-alpha\]/, 'only the attributable row is counted');
    const audit = res.err.join('\n');
    assert.match(audit, /dropped 1 row\(s\) not attributable to tenant tenant-alpha/, 'the drop is audited on stderr');
    assert.match(audit, /defense-in-depth re-filter/, 'the audit names the control');
  });

  it('drops a foreign-marked row even when the lookup would corroborate the id', async () => {
    const res = await runEntities(
      {
        allEntities: () => [entity('ent:alpha', 'Alpha Corp', 'Organization', TENANT_B)],
        // Even a lookup that returns the id is not enough: the row itself carries
        // a foreign tenant marker, so it is dropped rather than re-labelled.
        getEntity: (id: string) => entity(id, 'Alpha Corp', 'Organization', TENANT_A),
      },
      TENANT_A,
    );
    assert.equal(res.out.join('\n').includes('Alpha Corp'), false, 'a foreign-marked row is never printed');
    assert.match(res.out.join('\n'), /0 entities shown \[tenant tenant-alpha\]/);
    assert.match(res.err.join('\n'), /dropped 1 row\(s\) not attributable to tenant tenant-alpha/);
  });

  it('fails closed when the dependency exposes no authoritative entity lookup', async () => {
    const legacy = {
      allEntities: () => [entity('ent:alpha', 'Alpha Corp', 'Organization', TENANT_A)],
      entitiesByType: () => [entity('ent:alpha', 'Alpha Corp', 'Organization', TENANT_A)],
      // no getEntity at all (pre-S-1 dependency shape)
    };
    const res = await runEntities(legacy, TENANT_A);
    assert.equal(res.out.join('\n').includes('Alpha Corp'), false, 'nothing is printed when attribution is impossible');
    assert.match(res.out.join('\n'), /0 entities shown \[tenant tenant-alpha\]/);
    assert.match(res.err.join('\n'), /no authoritative entity lookup available/, 'the fail-closed reason is audited');
  });

  it('refuses before any listing when the operator tenant is missing, blank, reserved, or contradicted', async () => {
    const poisoned = {
      allEntities: () => { throw new Error('data plane must not be touched'); },
      entitiesByType: () => { throw new Error('data plane must not be touched'); },
      getEntity: () => { throw new Error('data plane must not be touched'); },
    };
    for (const tenant of [undefined, '', '   ', 'default']) {
      const res = await runEntities(poisoned, tenant);
      assert.equal(res.code, 1, `entities must refuse for tenant ${JSON.stringify(tenant)}`);
      assert.deepEqual(res.out, [], 'nothing was printed');
      assert.match(res.err.join('\n'), /refused/i, 'the refusal is reported');
    }
    // --tenant may only agree with the deployment configuration.
    const out: string[] = [];
    const err: string[] = [];
    const code = await runKnowledgeCommand(
      'entities',
      ['--tenant', TENANT_B],
      { ...realDeps, env: envWith(TENANT_A) },
      (l) => out.push(l),
      (l) => err.push(l),
    );
    assert.equal(code, 1, 'a contradicting --tenant is refused');
    assert.deepEqual(out, [], 'no entity was listed for the contradicting tenant');
    assert.match(err.join('\n'), /does not equal the configured operator tenant/);
  });
});

describe('S-1 CLI tenant boundary — B-4 host inspection fails closed before boot', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ['JATAQI_OPERATOR_TENANT', 'STORAGE_DRIVER', 'JATAQI_OPERATOR_ID', 'JATAQI_OPERATOR_GLOBAL_ADMIN'];

  before(() => {
    assert.equal(process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK, undefined);
    for (const k of keys) saved[k] = process.env[k];
  });

  after(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** Capture everything the command prints (stdout log lines + stderr). */
  async function capture(cmd: HostInspectCommand, args: string[] = []): Promise<{ code: number; out: string[]; stderr: string }> {
    const out: string[] = [];
    const errLines: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => { errLines.push(parts.map(String).join(' ')); };
    try {
      const code = await runHostInspectCommand(cmd, args, (line) => out.push(line));
      return { code, out, stderr: errLines.join('\n') };
    } finally {
      console.error = originalError;
    }
  }

  it('refuses with no operator tenant configured — and proves nothing was booted', async () => {
    delete process.env.JATAQI_OPERATOR_TENANT;
    // A driver name that cannot exist: if the command tried to boot first, the
    // output would be a boot failure instead of the tenant refusal.
    process.env.STORAGE_DRIVER = 'definitely-not-a-real-driver';
    try {
      const res = await capture('host:health');
      assert.equal(res.code, 1, 'exit code 1 on refusal');
      assert.match(res.stderr, /refused \(no tenant context; nothing was booted or read\)/, 'the refusal states nothing was booted or read');
      assert.match(res.stderr, /No operator tenant is configured/);
      assert.equal(/failed to boot/.test(res.stderr), false, 'the kernel boot was never attempted');
      assert.equal(/unknown driver/.test(res.stderr), false, 'no driver was resolved');
      assert.deepEqual(res.out, [], 'nothing was reported');
    } finally {
      delete process.env.STORAGE_DRIVER;
    }
  });

  it('refuses a blank operator tenant and the reserved default tenant', async () => {
    process.env.STORAGE_DRIVER = 'definitely-not-a-real-driver';
    try {
      for (const tenant of ['', '   ']) {
        process.env.JATAQI_OPERATOR_TENANT = tenant;
        const res = await capture('host:work');
        assert.equal(res.code, 1, `blank tenant ${JSON.stringify(tenant)} must be refused`);
        assert.match(res.stderr, /nothing was booted or read/);
        assert.match(res.stderr, /is set but empty/);
        assert.deepEqual(res.out, []);
      }
      process.env.JATAQI_OPERATOR_TENANT = 'default';
      const reserved = await capture('host:dlq');
      assert.equal(reserved.code, 1, 'the reserved default tenant must be refused');
      assert.match(reserved.stderr, /reserved test-only DEFAULT_TENANT_ID/);
      assert.match(reserved.stderr, /nothing was booted or read/);
      assert.equal(/failed to boot/.test(reserved.stderr), false, 'still no boot attempt');
      assert.deepEqual(reserved.out, []);
    } finally {
      delete process.env.STORAGE_DRIVER;
      delete process.env.JATAQI_OPERATOR_TENANT;
    }
  });

  it('reports the configured operator tenant (never "default") once one is set', async () => {
    process.env.STORAGE_DRIVER = 'memory';
    process.env.JATAQI_OPERATOR_TENANT = TENANT_A;
    try {
      const res = await capture('host:health');
      assert.equal(res.code, 0, `expected a healthy read-only inspection, got: ${res.stderr}`);
      const report = JSON.parse(res.out.join('\n')) as { delivery: { tenantId: string }; storageDriver: string };
      assert.equal(report.delivery.tenantId, TENANT_A, 'the delivery-health report names the configured tenant');
      assert.notEqual(report.delivery.tenantId, 'default', 'the report never silently claims the default tenant');
      assert.equal(report.storageDriver, 'memory');

      const outbox = await capture('host:outbox');
      assert.equal(outbox.code, 0);
      assert.match(outbox.out.join('\n'), new RegExp(`outbox record\\(s\\) shown for tenant ${TENANT_A}`), 'outbox listing is tenant-labelled');
      assert.match(outbox.out.join('\n'), /Read-only: nothing was claimed, acked, or released\./, 'the read-only contract is still stated');
    } finally {
      delete process.env.STORAGE_DRIVER;
      delete process.env.JATAQI_OPERATOR_TENANT;
    }
  });

  it('keeps least privilege: global_admin is granted only by explicit opt-in', async () => {
    process.env.STORAGE_DRIVER = 'memory';
    process.env.JATAQI_OPERATOR_TENANT = TENANT_B;
    try {
      delete process.env.JATAQI_OPERATOR_GLOBAL_ADMIN;
      const plain = await capture('host:inbox');
      assert.equal(plain.code, 0, `inbox inspection failed: ${plain.stderr}`);
      assert.match(plain.out.join('\n'), new RegExp(TENANT_B), 'the operator tenant is reported');
      process.env.JATAQI_OPERATOR_GLOBAL_ADMIN = 'true';
      const elevated = await capture('host:inbox');
      assert.equal(elevated.code, 0, `elevated inbox inspection failed: ${elevated.stderr}`);
      assert.match(elevated.out.join('\n'), new RegExp(TENANT_B), 'elevation does not change the reported tenant scope');
    } finally {
      delete process.env.JATAQI_OPERATOR_GLOBAL_ADMIN;
      delete process.env.STORAGE_DRIVER;
      delete process.env.JATAQI_OPERATOR_TENANT;
    }
  });
});
