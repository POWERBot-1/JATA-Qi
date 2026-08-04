import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { SecurityModule } from '@jataqi/security';
import { NotificationsModule } from '@jataqi/notifications';
import { PolicyGovernanceModule } from '@jataqi/policy-governance';
import { MultimediaModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

function boot(full = false) {
  const k = createTestKernel();
  k.register(new StorageModule());
  if (full) {
    k.register(new SecurityModule());
    k.register(new NotificationsModule());
    k.register(new PolicyGovernanceModule());
  }
  k.register(new MultimediaModule());
  return k;
}

describe('MultimediaModule (foundation)', () => {
  let kernel: Kernel;
  let media: MultimediaModule;

  beforeEach(async () => {
    kernel = boot();
    await kernel.boot();
    media = kernel.getModule<MultimediaModule>('multimedia');
  });

  it('creates projects with metadata', async () => {
    const p = await media.createProject({ name: 'Afrobeat Single', kind: 'music', ownerId: 'u1', genre: 'Afrobeat', description: 'Debut track' });
    assert.equal(p.kind, 'music');
    assert.equal(p.genre, 'Afrobeat');
    assert.equal(p.version, 1);
    assert.ok(p.id);
  });

  it('lists and filters projects by owner/org', async () => {
    await media.createProject({ name: 'P1', kind: 'story', ownerId: 'u1', organizationId: 'org-a' });
    await media.createProject({ name: 'P2', kind: 'image', ownerId: 'u2', organizationId: 'org-b' });
    assert.equal((await media.listProjects('u1')).length, 1);
    assert.equal((await media.listProjects(undefined, 'org-b')).length, 1);
  });

  it('creates jobs, processes the queue, and produces assets', async () => {
    const p = await media.createProject({ name: 'Novel', kind: 'story', ownerId: 'u1' });
    const job = await media.createJob('u1', { projectId: p.id, kind: 'story', title: 'Chapter 1', prompt: 'A girl discovers a map.' });
    assert.equal(job.status, 'queued');
    assert.equal(job.governanceDecision, undefined); // no governance module → gate skipped

    const processed = await media.processQueue();
    assert.equal(processed.length, 1);
    assert.equal(processed[0]!.status, 'completed');
    assert.ok(processed[0]!.resultAssetId);

    const asset = await media.getAsset(processed[0]!.resultAssetId!);
    assert.ok(asset);
    assert.equal(asset!.kind, 'story');
    assert.ok(asset!.aiGenerated);
    assert.match(asset!.content, /A girl discovers a map/);
  });

  it('handles lyrics and screenplay text rendering', async () => {
    const p = await media.createProject({ name: 'Song', kind: 'lyrics', ownerId: 'u1' });
    const j1 = await media.createJob('u1', { projectId: p.id, kind: 'lyrics', title: 'Verse', prompt: 'Nairobi nights' });
    await media.processQueue();
    const lyrics = await media.getAsset(j1.resultAssetId!);
    assert.match(lyrics!.content, /\[Verse 1\]/);

    const p2 = await media.createProject({ name: 'Film', kind: 'screenplay', ownerId: 'u1' });
    const j2 = await media.createJob('u1', { projectId: p2.id, kind: 'screenplay', title: 'Scene 1', prompt: 'The heist begins' });
    await media.processQueue();
    const script = await media.getAsset(j2.resultAssetId!);
    assert.match(script!.content, /FADE IN/);
  });

  it('handles music jobs with genre/tempo params', async () => {
    // Register a music renderer (the built-in is kind 'story'; music needs one).
    media.registerRenderer({
      kind: 'music',
      async render(job) {
        return { content: `Track: ${job.title}\nGenre: ${job.params?.genre}\nTempo: ${job.params?.tempo} BPM` };
      },
    });
    const p = await media.createProject({ name: 'Beat', kind: 'music', ownerId: 'u1' });
    const job = await media.createJob('u1', { projectId: p.id, kind: 'music', title: 'Amapiano Groove', prompt: 'Deep bass', params: { genre: 'Amapiano', tempo: 112 } });
    await media.processQueue();
    const asset = await media.getAsset(job.resultAssetId!);
    assert.match(asset!.content, /Amapiano/);
    assert.match(asset!.content, /112/);
  });

  it('fails gracefully when no renderer is registered', async () => {
    const p = await media.createProject({ name: 'Video', kind: 'video', ownerId: 'u1' });
    const job = await media.createJob('u1', { projectId: p.id, kind: 'video', title: 'Intro', prompt: 'Drone shot' });
    await media.processQueue();
    const failed = await media.getJob(job.id);
    assert.equal(failed!.status, 'failed');
    assert.match(failed!.error!, /no renderer/);
  });

  it('sets license, watermark and creates new versions', async () => {
    const p = await media.createProject({ name: 'Cover', kind: 'image', ownerId: 'u1' });
    // Register image renderer.
    media.registerRenderer({ kind: 'image', async render(j) { return { content: `[image:${j.title}]` }; } });
    const job = await media.createJob('u1', { projectId: p.id, kind: 'image', title: 'Album Cover', prompt: 'Neon city' });
    await media.processQueue();
    const asset = await media.getAsset(job.resultAssetId!);

    const licensed = await media.setLicense(asset!.id, 'cc-by', 'Artist X');
    assert.equal(licensed.license, 'cc-by');
    assert.equal(licensed.attribution, 'Artist X');

    const marked = await media.setWatermark(asset!.id, true);
    assert.equal(marked.watermark, true);

    const v2 = await media.newVersion(asset!.id, '[image: edited version]');
    assert.equal(v2.version, 2);
    assert.equal(v2.parentId, asset!.id);
  });

  it('publishes an asset to the marketplace', async () => {
    media.registerRenderer({ kind: 'image', async render(j) { return { content: `[image:${j.title}]` }; } });
    const p = await media.createProject({ name: 'Stock', kind: 'image', ownerId: 'u1' });
    const job = await media.createJob('u1', { projectId: p.id, kind: 'image', title: 'Sunset', prompt: 'Golden hour' });
    await media.processQueue();
    const { marketplaceItem } = await media.publishToMarketplace(job.resultAssetId!, 25, 'USD', 15);
    const item = marketplaceItem as { price: { amount: number }; platformCommissionPct: number };
    assert.equal(item.price.amount, 25);
    assert.equal(item.platformCommissionPct, 15);
  });

  it('emits lifecycle events', async () => {
    let queued = 0; let completed = 0;
    kernel.bus.on('media.job.queued', () => { queued++; });
    kernel.bus.on('media.job.completed', () => { completed++; });
    const p = await media.createProject({ name: 'Story', kind: 'story', ownerId: 'u1' });
    await media.createJob('u1', { projectId: p.id, kind: 'story', title: 'T', prompt: 'P' });
    await media.processQueue();
    assert.equal(queued, 1);
    assert.equal(completed, 1);
  });
});

describe('MultimediaModule — governance + consent integration', () => {
  let kernel: Kernel;
  let media: MultimediaModule;
  let gov: PolicyGovernanceModule;

  beforeEach(async () => {
    kernel = boot(true);
    await kernel.boot();
    media = kernel.getModule<MultimediaModule>('multimedia');
    gov = kernel.getModule<PolicyGovernanceModule>('policy-governance');
  });

  it('passes governance when allowed and records the decision on the job', async () => {
    const p = await media.createProject({ name: 'Story', kind: 'story', ownerId: 'u1' });
    const job = await media.createJob('u1', { projectId: p.id, kind: 'story', title: 'T', prompt: 'P' });
    assert.ok(job.governanceDecision);
    assert.equal(job.governanceDecision, 'ALLOW');
    assert.ok(job.governanceEvaluationId);
  });

  it('blocks job creation when governance denies media.create', async () => {
    await gov.createPolicy({ name: 'block media', category: 'GOVERNANCE', scope: 'GLOBAL', effect: 'DENY', action: 'media.create' }, 'admin');
    const p = await media.createProject({ name: 'Story', kind: 'story', ownerId: 'u1' });
    await assert.rejects(
      () => media.createJob('u1', { projectId: p.id, kind: 'story', title: 'T', prompt: 'P' }),
      /governance DENY/,
    );
  });

  it('requires explicit consent for vocal/voice-clone jobs', async () => {
    const p = await media.createProject({ name: 'Song', kind: 'vocal', ownerId: 'u1' });
    // Without consent → rejected.
    await assert.rejects(
      () => media.createJob('u1', { projectId: p.id, kind: 'vocal', title: 'Lead', prompt: 'Sing' }),
      /consent required/,
    );
    // Grant consent → succeeds.
    await media.grantConsent({ subjectType: 'voice-clone', subjectId: 'u1', grantedBy: 'u1', purpose: 'vocal performance' });
    const job = await media.createJob('u1', { projectId: p.id, kind: 'vocal', title: 'Lead', prompt: 'Sing' });
    assert.equal(job.consentGranted, true);
  });

  it('blocks vocal job when governance denies media.voiceclone', async () => {
    await gov.createPolicy({ name: 'block voiceclone', category: 'SAFETY', scope: 'GLOBAL', effect: 'DENY', action: 'media.voiceclone' }, 'admin');
    await media.grantConsent({ subjectType: 'voice-clone', subjectId: 'u1', grantedBy: 'u1', purpose: 'test' });
    const p = await media.createProject({ name: 'Song', kind: 'vocal', ownerId: 'u1' });
    await assert.rejects(
      () => media.createJob('u1', { projectId: p.id, kind: 'vocal', title: 'Lead', prompt: 'Sing' }),
      /governance DENY/,
    );
  });
});
