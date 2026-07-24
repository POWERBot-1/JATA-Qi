import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { AgentRuntimeModule, ScriptedLLM, EchoLLM } from '@jataqi/agent-runtime';
import { TeamCoordinatorModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

function bootKernel(llm = new EchoLLM()) {
  const k = createTestKernel();
  k.register(new StorageModule());
  k.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  k.register(new KnowledgeService());
  k.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
  k.register(new AgentRuntimeModule({ llm }));
  k.register(new TeamCoordinatorModule());
  return k;
}

describe('TeamCoordinatorModule (kernel integration)', () => {
  let kernel: Kernel;
  let teams: TeamCoordinatorModule;

  beforeEach(async () => {
    kernel = bootKernel();
    await kernel.boot();
    teams = kernel.getModule<TeamCoordinatorModule>('teams');
  });

  it('registers a team and auto-creates missing member agents', () => {
    teams.createTeam({ name: 'research', members: ['scout', 'analyst'] });
    const agents = kernel.getModule<AgentRuntimeModule>('agent-runtime');
    assert.doesNotThrow(() => agents.getAgent('scout'));
    assert.doesNotThrow(() => agents.getAgent('analyst'));
    assert.equal(teams.listTeams().length, 1);
    assert.throws(() => teams.createTeam({ name: 'research', members: [] }), /already exists/);
  });

  it('runs a parallel team and synthesizes contributions', async () => {
    teams.createTeam({ name: 'parallel-team', members: ['a', 'b', 'c'] });
    const result = await teams.execute('What is 2+2?', 'parallel-team');
    assert.equal(result.mode, 'parallel');
    assert.equal(result.contributions.length, 3);
    assert.ok(result.synthesis.length > 0);
  });

  it('runs a sequential team where each member builds on the last', async () => {
    // Scripted LLM so we can assert the pipeline threads outputs.
    const k = createTestKernel();
    k.register(new StorageModule());
    k.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    k.register(new KnowledgeService());
    k.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
    k.register(new AgentRuntimeModule({ llm: new ScriptedLLM([{ text: 'one' }, { text: 'two' }]) }));
    k.register(new TeamCoordinatorModule());
    await k.boot();
    const t = k.getModule<TeamCoordinatorModule>('teams');
    t.createTeam({ name: 'pipe', members: ['m1', 'm2'], mode: 'sequential' });
    const result = await t.execute('start', 'pipe');
    assert.equal(result.mode, 'sequential');
    assert.equal(result.contributions[0]!.output, 'one');
    assert.equal(result.contributions[1]!.output, 'two');
    assert.equal(result.synthesis, 'two'); // last member's output
    await k.shutdown();
  });

  it('runs a consensus team and flags agreeing members', async () => {
    const k = createTestKernel();
    k.register(new StorageModule());
    k.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    k.register(new KnowledgeService());
    k.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
    // Three agents each scripted to a fixed answer; two agree on "42".
    k.register(
      new AgentRuntimeModule({
        llm: new ScriptedLLM([
          { text: '42' }, { text: '42' }, { text: '7' }, { text: '42' }, { text: '42' }, { text: '7' },
        ]),
      }),
    );
    k.register(new TeamCoordinatorModule());
    await k.boot();
    const t = k.getModule<TeamCoordinatorModule>('teams');
    t.createTeam({ name: 'vote', members: ['v1', 'v2', 'v3'], mode: 'consensus' });
    const result = await t.execute('answer', 'vote');
    assert.equal(result.synthesis, '42'); // majority
    const agreeing = result.contributions.filter((c) => c.agrees).length;
    assert.equal(agreeing, 2); // v1 and v2 agreed
    await k.shutdown();
  });

  it('emits team run lifecycle events', async () => {
    let started = 0;
    let completed = 0;
    kernel.bus.on('teams.run.started', () => { started++; });
    kernel.bus.on('teams.run.completed', () => { completed++; });
    teams.createTeam({ name: 'evt', members: ['x'] });
    await teams.execute('hi', 'evt');
    assert.equal(started, 1);
    assert.equal(completed, 1);
  });
});
