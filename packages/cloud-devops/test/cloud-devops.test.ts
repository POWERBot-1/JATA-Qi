import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { CloudDevopsModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('CloudDevopsModule', () => {
  let kernel: Kernel; let devops: CloudDevopsModule;
  beforeEach(async () => { kernel = createTestKernel(); kernel.register(new StorageModule()); kernel.register(new CloudDevopsModule()); await kernel.boot(); devops = kernel.getModule<CloudDevopsModule>('cloud-devops'); });

  it('creates, deploys, and rolls back deployments', async () => {
    const d = await devops.createDeployment({ name: 'api-v2', environment: 'staging', version: '2.1.0', createdBy: 'dev' });
    assert.equal(d.status, 'planned');
    const deployed = await devops.deploy(d.id);
    assert.equal(deployed.status, 'deployed');
    assert.ok(deployed.deployedAt);
    const rb = await devops.rollback(d.id, 'regression');
    assert.equal(rb.status, 'rolled_back');
    assert.ok(rb.rolledBackAt);
  });

  it('rejects deploying non-planned deployments', async () => {
    const d = await devops.createDeployment({ name: 'x', environment: 'dev', version: '1', createdBy: 'a' });
    await devops.deploy(d.id);
    await assert.rejects(() => devops.deploy(d.id), /status is deployed/);
  });

  it('registers infrastructure resources', async () => {
    await devops.registerResource({ name: 'pg-main', type: 'database', provider: 'aws', spec: { engine: 'postgres', size: 'm5.large' } });
    await devops.registerResource({ name: 'redis-cache', type: 'cache', provider: 'gcp' });
    assert.equal((await devops.listResources()).length, 2);
    assert.equal((await devops.listResources('database')).length, 1);
  });

  it('logs deployment activity', async () => {
    const d = await devops.createDeployment({ name: 'svc', environment: 'prod', version: '1.0', createdBy: 'ops' });
    await devops.deploy(d.id);
    const logs = await devops.getLogs(d.id);
    assert.ok(logs.length >= 2);
    assert.match(logs[0]!.message, /Deploying/);
    assert.match(logs[1]!.message, /completed/);
  });

  it('emits deployment lifecycle events', async () => {
    let started = 0; let completed = 0; let rb = 0;
    kernel.bus.on('cloud.deployment.started', () => { started++; });
    kernel.bus.on('cloud.deployment.completed', () => { completed++; });
    kernel.bus.on('cloud.deployment.rolled_back', () => { rb++; });
    const d = await devops.createDeployment({ name: 'e', environment: 'dev', version: '1', createdBy: 'a' });
    await devops.deploy(d.id);
    await devops.rollback(d.id);
    assert.equal(started, 1); assert.equal(completed, 1); assert.equal(rb, 1);
  });
});
