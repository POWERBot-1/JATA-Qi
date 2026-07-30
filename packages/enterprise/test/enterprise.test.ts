import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { EnterpriseModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('EnterpriseModule', () => {
  let kernel: Kernel; let ent: EnterpriseModule;
  beforeEach(async () => { kernel = createTestKernel(); kernel.register(new StorageModule()); kernel.register(new EnterpriseModule()); await kernel.boot(); ent = kernel.getModule<EnterpriseModule>('enterprise'); });

  it('creates org units by module type', async () => {
    await ent.createOrgUnit({ name: 'Sales Team', module: 'crm' });
    await ent.createOrgUnit({ name: 'HR Dept', module: 'hr' });
    assert.equal((await ent.listOrgUnits()).length, 2);
    assert.equal((await ent.listOrgUnits('crm')).length, 1);
  });

  it('creates and queries records by module/type', async () => {
    const ou = await ent.createOrgUnit({ name: 'Sales', module: 'crm' });
    await ent.createRecord({ orgUnitId: ou.id, module: 'crm', type: 'customer', data: { name: 'Acme Corp', email: 'x@y.com' }, createdBy: 'rep1' });
    await ent.createRecord({ orgUnitId: ou.id, module: 'crm', type: 'lead', data: { company: 'Globex' }, createdBy: 'rep1' });
    assert.equal((await ent.listRecords({ module: 'crm' })).length, 2);
    assert.equal((await ent.listRecords({ type: 'customer' })).length, 1);
  });

  it('creates and activates workflows', async () => {
    const ou = await ent.createOrgUnit({ name: 'Procurement', module: 'procurement' });
    const w = await ent.createWorkflow({ orgUnitId: ou.id, name: 'PO Approval', steps: ['submit', 'review', 'approve', 'fulfill'], createdBy: 'mgr' });
    assert.equal(w.status, 'draft');
    const active = await ent.activateWorkflow(w.id);
    assert.equal(active.status, 'active');
  });

  it('emits record creation events', async () => {
    let events = 0; kernel.bus.on('enterprise.record.created', () => { events++; });
    const ou = await ent.createOrgUnit({ name: 'Finance', module: 'finance' });
    await ent.createRecord({ orgUnitId: ou.id, module: 'finance', type: 'invoice', data: { amount: 500 }, createdBy: 'a' });
    assert.equal(events, 1);
  });
});
