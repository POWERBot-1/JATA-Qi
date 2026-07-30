import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { ResearchModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('ResearchModule', () => {
  let kernel: Kernel;
  let res: ResearchModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new ResearchModule());
    await kernel.boot();
    res = kernel.getModule<ResearchModule>('research');
  });

  it('creates research projects', async () => {
    const p = await res.createProject({ name: 'Climate Study', field: 'Environmental Science', ownerId: 'u1', description: 'Impact of urbanization' });
    assert.equal(p.field, 'Environmental Science');
    assert.equal(p.status, 'active');
  });

  it('creates experiments with methodology and tracks status', async () => {
    const p = await res.createProject({ name: 'Drug Trial', ownerId: 'u1' });
    const exp = await res.createExperiment({ projectId: p.id, name: 'Phase I', hypothesis: 'Drug X reduces symptoms', methodology: 'Double-blind RCT' });
    assert.equal(exp.status, 'planned');
    const updated = await res.updateExperiment(exp.id, { status: 'completed', results: 'p<0.05', reproducible: true });
    assert.equal(updated.status, 'completed');
    assert.equal(updated.results, 'p<0.05');
    assert.equal(updated.reproducible, true);
  });

  it('manages literature references with tags', async () => {
    const p = await res.createProject({ name: 'Lit Review', ownerId: 'u1' });
    await res.addLiterature({ projectId: p.id, title: 'Paper A', authors: ['Smith J'], year: 2024, doi: '10.1000/a', tags: ['review'], addedBy: 'u1' });
    await res.addLiterature({ projectId: p.id, title: 'Paper B', authors: ['Doe K'], year: 2023, tags: ['empirical'], addedBy: 'u1' });
    assert.equal((await res.listLiterature(p.id)).length, 2);
    assert.equal((await res.listLiterature(p.id, 'review')).length, 1);
  });

  it('tracks hypotheses and clearly labels AI-generated ones', async () => {
    const p = await res.createProject({ name: 'Hyp Project', ownerId: 'u1' });
    const human = await res.createHypothesis({ projectId: p.id, statement: 'X causes Y', createdBy: 'u1' });
    assert.equal(human.aiGenerated, false);
    assert.equal(human.status, 'proposed');

    const ai = await res.createHypothesis({ projectId: p.id, statement: 'Z mediates the X→Y effect', aiGenerated: true, createdBy: 'agent-1' });
    assert.equal(ai.aiGenerated, true); // clearly labelled

    const updated = await res.updateHypothesis(ai.id, 'supported', 'Experiment 3 confirmed');
    assert.equal(updated.status, 'supported');
    assert.equal(updated.evidence.length, 1);
  });

  it('lists experiments and hypotheses by project', async () => {
    const p1 = await res.createProject({ name: 'A', ownerId: 'u1' });
    const p2 = await res.createProject({ name: 'B', ownerId: 'u1' });
    await res.createExperiment({ projectId: p1.id, name: 'E1' });
    await res.createExperiment({ projectId: p2.id, name: 'E2' });
    await res.createHypothesis({ projectId: p1.id, statement: 'H1', createdBy: 'u1' });
    assert.equal((await res.listExperiments(p1.id)).length, 1);
    assert.equal((await res.listHypotheses(p1.id)).length, 1);
    assert.equal((await res.listExperiments(p2.id)).length, 1);
  });

  it('reports aggregate stats', async () => {
    const p = await res.createProject({ name: 'S', ownerId: 'u1' });
    await res.createExperiment({ projectId: p.id, name: 'E' });
    await res.addLiterature({ projectId: p.id, title: 'L', authors: ['A'], addedBy: 'u1' });
    await res.createHypothesis({ projectId: p.id, statement: 'H', createdBy: 'u1' });
    const s = await res.stats();
    assert.equal(s.projects, 1);
    assert.equal(s.experiments, 1);
    assert.equal(s.literature, 1);
    assert.equal(s.hypotheses, 1);
  });

  it('emits lifecycle events', async () => {
    let projectEvents = 0;
    let expEvents = 0;
    kernel.bus.on('research.project.created', () => { projectEvents++; });
    kernel.bus.on('research.experiment.created', () => { expEvents++; });
    const p = await res.createProject({ name: 'E', ownerId: 'u1' });
    await res.createExperiment({ projectId: p.id, name: 'E1' });
    assert.equal(projectEvents, 1);
    assert.equal(expEvents, 1);
  });
});
