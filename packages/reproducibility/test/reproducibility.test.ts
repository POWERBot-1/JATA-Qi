import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import { ReproducibilityError, ReproducibilityModule, type ReproducibilityService } from '../src/index.js';

let actor: CommercialActor;
let other: CommercialActor;
let service: ReproducibilityService;

function base(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1', kind: 'SIMULATION' as const,
    datasetReferences: [{ id: 'dataset-a', version: 'v1', contentHash: 'abc' }],
    algorithm: { id: 'linear-model', version: '1.0.0', contentHash: 'def' },
    environment: { id: 'node', version: '22', contentHash: 'ghi' },
    parameters: { alpha: 0.5, iterations: 10 }, deterministic: true,
    output: { result: 42, metadata: { stable: true } }, provenance: { source: 'reproducibility-test', collectedAt: Date.now(), correlationId: 'repro-correlation' },
    ...overrides,
  };
}

beforeEach(async () => {
  actor = { id: 'researcher', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new ReproducibilityModule());
  await kernel.boot();
  service = kernel.getModule<ReproducibilityModule>('reproducibility').getService();
});

describe('Reproducibility registry', () => {
  it('records versioned metadata and verifies canonical-equivalent output as reproducible', async () => {
    const record = await service.record(actor, base());
    const attempt = await service.verify(actor, record.id, {
      datasetReferences: [{ contentHash: 'abc', version: 'v1', id: 'dataset-a' }],
      algorithm: { version: '1.0.0', id: 'linear-model', contentHash: 'def' },
      environment: { id: 'node', version: '22', contentHash: 'ghi' },
      parameters: { iterations: 10, alpha: 0.5 }, deterministic: true,
      output: { metadata: { stable: true }, result: 42 }, provenance: { source: 'reexecution-test', collectedAt: Date.now() },
    });
    assert.equal(record.status, 'RECORDED');
    assert.equal(attempt.status, 'REPRODUCIBLE');
    assert.equal((await service.getRecord(actor, record.id))?.status, 'REPRODUCIBLE');
  });

  it('records parameter/output mismatches rather than declaring reproduction', async () => {
    const record = await service.record(actor, base());
    const parameterMismatch = await service.verify(actor, record.id, {
      datasetReferences: [{ id: 'dataset-a', version: 'v1', contentHash: 'abc' }], algorithm: { id: 'linear-model', version: '1.0.0', contentHash: 'def' }, environment: { id: 'node', version: '22', contentHash: 'ghi' },
      parameters: { alpha: 0.6, iterations: 10 }, deterministic: true, output: { result: 42, metadata: { stable: true } }, provenance: { source: 'test', collectedAt: Date.now() },
    });
    assert.equal(parameterMismatch.status, 'MISMATCH');
    assert.match(parameterMismatch.reason ?? '', /fingerprint differs/);
  });

  it('does not permit a no-seed nondeterministic run to be labeled reproducible', async () => {
    const record = await service.record(actor, base({ deterministic: false }));
    assert.equal(record.status, 'INCOMPLETE');
    const attempt = await service.verify(actor, record.id, {
      datasetReferences: [{ id: 'dataset-a', version: 'v1', contentHash: 'abc' }], algorithm: { id: 'linear-model', version: '1.0.0', contentHash: 'def' }, environment: { id: 'node', version: '22', contentHash: 'ghi' },
      parameters: { alpha: 0.5, iterations: 10 }, deterministic: false, output: { result: 42, metadata: { stable: true } }, provenance: { source: 'test', collectedAt: Date.now() },
    });
    assert.equal(attempt.status, 'INCOMPLETE');
  });

  it('keeps records tenant-isolated and persists them across filesystem restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-reproducibility-'));
    try {
      const first = createTestKernel();
      first.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      first.register(new ReproducibilityModule());
      await first.boot();
      const firstService = first.getModule<ReproducibilityModule>('reproducibility').getService();
      const record = await firstService.record(actor, base());
      await first.shutdown();
      const second = createTestKernel();
      second.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      second.register(new ReproducibilityModule());
      await second.boot();
      const secondService = second.getModule<ReproducibilityModule>('reproducibility').getService();
      assert.equal((await secondService.getRecord(actor, record.id))?.inputFingerprint, record.inputFingerprint);
      assert.equal(await secondService.getRecord(other, record.id), undefined);
      await assert.rejects(() => secondService.listAttempts(other, record.id), ReproducibilityError);
      await second.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
