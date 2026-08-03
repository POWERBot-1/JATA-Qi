// Publishing tests — versioning, deterministic signed builds, submission
// lifecycle, and one-click build+submit.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import {
  PublishModule, PublishEvents, BuildPipeline, parseSemVer, bump, compareSemVer, PLATFORM_STORE,
} from '../src/index.js';
import type { BuildSpec } from '../src/index.js';

const SPEC: BuildSpec = {
  projectId: 'game-1', title: 'Demo', version: '1.0.0', channel: 'beta',
  targets: [
    { platform: 'android', bundleId: 'com.nova.demo' },
    { platform: 'ios', bundleId: 'com.nova.demo' },
    { platform: 'web', bundleId: 'com.nova.demo' },
  ],
  contents: { entrypoint: 'main.js', assetCount: 42, seed: 'nova-1' },
};

describe('versioning', () => {
  it('parses and formats semver', () => {
    assert.deepEqual(parseSemVer('1.2.3'), { major: 1, minor: 2, patch: 3 });
    assert.equal(parseSemVer('0.1.0-beta.1').pre, 'beta.1');
  });

  it('bumps major/minor/patch', () => {
    assert.equal(bump('1.2.3', 'patch'), '1.2.4');
    assert.equal(bump('1.2.3', 'minor'), '1.3.0');
    assert.equal(bump('1.2.3', 'major'), '2.0.0');
  });

  it('compares semver', () => {
    assert.equal(compareSemVer('1.0.0', '1.0.1'), -1);
    assert.equal(compareSemVer('2.0.0', '1.9.9'), 1);
    assert.equal(compareSemVer('1.0.0', '1.0.0'), 0);
  });
});

describe('BuildPipeline — deterministic signed artifacts', () => {
  it('produces one artifact per target with a valid signature', () => {
    const p = new BuildPipeline();
    const r = p.run(SPEC);
    assert.equal(r.artifacts.length, 3);
    assert.equal(r.artifacts[0]!.platform, 'android');
    assert.equal(r.artifacts[0]!.store, PLATFORM_STORE.android);
    assert.equal(r.artifacts[0]!.checksum.length, 64);
    for (const a of r.artifacts) assert.equal(p.verifyArtifact(a), true);
  });

  it('is deterministic: same spec -> identical checksums', () => {
    const p = new BuildPipeline();
    const a = p.run(SPEC).artifacts.map((x) => x.checksum);
    const b = p.run(SPEC).artifacts.map((x) => x.checksum);
    assert.deepEqual(a, b);
  });

  it('records the build stage log', () => {
    const p = new BuildPipeline();
    const r = p.run(SPEC);
    assert.ok(r.stages.some((s) => s.stage === 'scaffold' && s.status === 'ok'));
    assert.ok(r.stages.some((s) => s.stage.startsWith('sign:')));
  });
});

describe('PublishModule — build + submit lifecycle', () => {
  let kernel: Kernel;
  let mod: PublishModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new PublishModule();
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('one-click build + submit creates submissions', () => {
    const { build, submissions } = mod.buildAndSubmit(SPEC);
    assert.equal(submissions.length, 3);
    assert.equal(submissions[0]!.status, 'submitted');
    assert.ok(build.fingerprint.length > 0);
  });

  it('advances submissions through review to published', () => {
    const { submissions } = mod.buildAndSubmit(SPEC);
    const s = submissions[0]!;
    mod.advance(s.id, 'in-review');
    mod.advance(s.id, 'approved');
    mod.advance(s.id, 'published');
    assert.equal(mod.store.get(s.id)!.status, 'published');
    assert.ok(mod.store.isPublished(SPEC.projectId, s.platform));
  });

  it('rejects invalid transitions', () => {
    const { submissions } = mod.buildAndSubmit(SPEC);
    const s = submissions[0]!;
    assert.throws(() => mod.advance(s.id, 'published')); // can't skip review
  });

  it('emits build-completed events', async () => {
    let fired = false;
    kernel.bus.on(PublishEvents.BuildCompleted, () => { fired = true; });
    mod.build(SPEC);
    await new Promise((r) => setImmediate(r));
    assert.equal(fired, true);
  });

  it('verifies artifacts via the module', () => {
    const r = mod.build(SPEC);
    for (const a of r.artifacts) assert.equal(mod.verify(a), true);
  });
});
