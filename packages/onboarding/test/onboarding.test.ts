// OnboardingModule tests — guided enterprise onboarding.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { JataQiClient } from '@jataqi/sdk';
import { OnboardingModule, OnboardingEvents, DEFAULT_SETUP_STEPS } from '../src/index.js';

type CreateJataQi = (cfg?: Record<string, unknown>) => Promise<{ gateway?: { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> }; shutdown(): Promise<void> }>;

describe('OnboardingEngine (guided setup)', () => {
  it('walks the full setup: profile → admin → tenant → invites → sample data → complete', () => {
    const mod = new OnboardingModule();
    const run = mod.startOnboarding({ orgName: 'Acme Corp', adminEmail: 'admin@acme.com', industry: 'fintech', region: 'KE' });
    assert.equal(run.steps.length, DEFAULT_SETUP_STEPS.length);
    assert.equal(run.steps[0]!.status, 'in_progress');

    mod.setOrgProfile(run.id, { name: 'Acme Corp', slug: 'acme', industry: 'fintech', region: 'KE', sizeBand: '50-200' });
    mod.completeAdmin(run.id, ['admin', 'developer']);
    const withTenant = mod.provisionTenant(run.id, { region: 'nbo-1', storageDriver: 'postgres', quotas: { users: 500 } });
    assert.equal(withTenant.tenant!.tenantId.startsWith('tenant-'), true);
    assert.equal(withTenant.tenant!.namespace, 'org_acme_corp');
    assert.equal(withTenant.tenant!.quotas.users, 500);

    const invite = mod.invite(run.id, { email: 'dev@acme.com', role: 'developer' });
    assert.equal(invite.status, 'pending');
    mod.acceptInvite(run.id, invite.id);
    assert.equal(mod.engine.getRun(run.id)!.invites[0]!.status, 'accepted');
    mod.completeInvitations(run.id);

    mod.generateSampleData(run.id, ['marketplace', 'tanya']);
    const done = mod.complete(run.id);
    assert.equal(done.completedAt !== undefined, true);
    assert.equal(done.steps.every((s) => s.status === 'done' || s.status === 'skipped'), true);
    assert.equal(mod.progress(run.id)!.pct, 100);
    assert.ok(done.sampleData!.generated.listings >= 8);
  });

  it('supports skipping sample data and validates inputs', () => {
    const mod = new OnboardingModule();
    assert.throws(() => mod.startOnboarding({ orgName: '', adminEmail: 'x@y.z' }), /orgName/);
    const run = mod.startOnboarding({ orgName: 'Skip Co', adminEmail: 's@skip.co' });
    mod.skipSampleData(run.id);
    const done = mod.complete(run.id);
    assert.equal(done.steps.find((s) => s.id === 'sample_data')!.status, 'skipped');
  });

  it('aggregates onboarding stats', () => {
    const mod = new OnboardingModule();
    const run = mod.startOnboarding({ orgName: 'Stats Co', adminEmail: 'st@co.io' });
    mod.setOrgProfile(run.id, { name: 'Stats Co', slug: 'stats' });
    mod.completeAdmin(run.id);
    mod.provisionTenant(run.id);
    mod.invite(run.id, { email: 'a@b.c', role: 'admin' });
    mod.completeInvitations(run.id);
    mod.generateSampleData(run.id, ['mobility']);
    mod.complete(run.id);
    const s = mod.stats();
    assert.equal(s.runs, 1);
    assert.equal(s.completed, 1);
    assert.equal(s.tenants, 1);
    assert.equal(s.invites, 1);
  });
});

describe('OnboardingModule (kernel wiring)', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new OnboardingModule());
    await kernel.boot();
  });

  after(async () => { await kernel.shutdown(); });

  it('emits onboarding events on the bus', async () => {
    const mod = kernel.getModule<OnboardingModule>('onboarding');
    const events: string[] = [];
    kernel.bus.on(OnboardingEvents.OnboardingStarted, () => { events.push(OnboardingEvents.OnboardingStarted); });
    kernel.bus.on(OnboardingEvents.TenantProvisioned, () => { events.push(OnboardingEvents.TenantProvisioned); });
    kernel.bus.on(OnboardingEvents.OnboardingCompleted, () => { events.push(OnboardingEvents.OnboardingCompleted); });
    const run = mod.startOnboarding({ orgName: 'Bus Co', adminEmail: 'b@c.d' });
    mod.setOrgProfile(run.id, { name: 'Bus Co', slug: 'bus' });
    mod.completeAdmin(run.id);
    mod.provisionTenant(run.id);
    mod.completeInvitations(run.id);
    mod.generateSampleData(run.id, ['restaurants']);
    mod.complete(run.id);
    assert.ok(events.includes(OnboardingEvents.OnboardingStarted));
    assert.ok(events.includes(OnboardingEvents.TenantProvisioned));
    assert.ok(events.includes(OnboardingEvents.OnboardingCompleted));
  });
});

describe('Onboarding gateway integration (vs real server)', () => {
  let qi: Awaited<ReturnType<CreateJataQi>>;
  let admin: JataQiClient;
  let port: number;
  let closeHandle: () => Promise<void>;

  before(async () => {
    const bootstrapPath = new URL('../../../cli/dist/src/bootstrap.js', import.meta.url).href;
    const mod = await import(bootstrapPath) as unknown as { createJataQi: CreateJataQi };
    qi = await mod.createJataQi({ security: { bootstrapAdmin: { username: 'admin', password: 'admin' } } });
    const handle = await qi.gateway!.listen({ port: 0 });
    port = handle.port;
    closeHandle = handle.close;
    admin = new JataQiClient({ baseUrl: `http://127.0.0.1:${port}` });
    await admin.auth.login('admin', 'admin');
  });

  after(async () => {
    if (closeHandle) await closeHandle();
    if (qi) await qi.shutdown();
  });

  it('completes a full onboarding run end-to-end via the gateway', async () => {
    const started = await admin.onboarding.start('Gateway Org', 'admin@gateway.org', { industry: 'health' });
    const runId = (started.run as { id: string }).id;
    await admin.onboarding.setProfile(runId, { name: 'Gateway Org', slug: 'gateway', industry: 'health', region: 'KE' });
    await admin.onboarding.completeAdmin(runId, ['admin']);
    const tenant = await admin.onboarding.provisionTenant(runId, { region: 'nbo-1', storageDriver: 'sqlite' });
    assert.ok((tenant.run as { tenant: { tenantId: string } }).tenant.tenantId.startsWith('tenant-'));
    const invite = await admin.onboarding.invite(runId, 'eng@gateway.org', 'developer');
    await admin.onboarding.acceptInvite(runId, (invite.invite as { id: string }).id);
    await admin.onboarding.completeInvitations(runId);
    await admin.onboarding.generateSampleData(runId, ['marketplace']);
    const done = await admin.onboarding.complete(runId);
    assert.equal((done.run as { completedAt: number }).completedAt !== undefined, true);
    const stats = await admin.onboarding.stats();
    assert.equal((stats.stats as { completed: number }).completed, 1);
    const run = await admin.onboarding.getRun(runId);
    assert.equal((run.progress as { pct: number }).pct, 100);
  });
});


describe('Phase 5 — customer account lifecycle + tenant isolation', () => {
  let kernel: Kernel;
  let mod: OnboardingModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new OnboardingModule());
    await kernel.boot();
    mod = kernel.getModule<OnboardingModule>('onboarding');
  });

  it('creates a customer account bound to a billing identity', () => {
    const account = mod.createCustomerAccount({ orgName: 'Acme Inc', slug: 'acme', adminEmail: 'admin@acme.io', customerId: 'cust-100', planSlug: 'business' });
    assert.equal(account.status, 'active');
    assert.ok(account.tenantId.startsWith('tenant-'));
    assert.equal(mod.accountByCustomer('cust-100')!.id, account.id);
    // Duplicate customer → rejected.
    assert.throws(() => mod.createCustomerAccount({ orgName: 'Acme2', slug: 'acme2', adminEmail: 'x@y.z', customerId: 'cust-100' }), /already has an account/);
  });

  it('assigns a subscription and enforces edition through the plan binding', () => {
    const account = mod.createCustomerAccount({ orgName: 'B', slug: 'b', adminEmail: 'b@b.io', customerId: 'cust-101' });
    const updated = mod.assignSubscription(account.id, 'sub-9000', 'enterprise');
    assert.equal(updated.subscriptionId, 'sub-9000');
    assert.equal(updated.planSlug, 'enterprise');
    assert.equal(mod.getAccount(account.id)!.planSlug, 'enterprise');
  });

  it('suspends and reactivates an account with the reason recorded', () => {
    const account = mod.createCustomerAccount({ orgName: 'C', slug: 'c', adminEmail: 'c@c.io', customerId: 'cust-102' });
    mod.suspendAccount(account.id, 'non-payment');
    assert.equal(mod.getAccount(account.id)!.status, 'suspended');
    assert.equal(mod.getAccount(account.id)!.suspension!.reason, 'non-payment');
    mod.reactivateAccount(account.id);
    assert.equal(mod.getAccount(account.id)!.status, 'active');
    assert.equal(mod.getAccount(account.id)!.suspension, undefined);
  });

  it('offboards a tenant with a data-retention policy and deletion evidence', () => {
    const account = mod.createCustomerAccount({ orgName: 'D', slug: 'd', adminEmail: 'd@d.io', customerId: 'cust-103' });
    mod.startOffboarding(account.id, { retentionDays: 90, deleteData: true });
    assert.equal(mod.getAccount(account.id)!.status, 'offboarding');
    assert.equal(mod.getAccount(account.id)!.offboarding!.retentionDays, 90);
    const record = mod.executeOffboarding(account.id);
    assert.equal(record.status, 'completed');
    assert.equal(record.evidenceHash!.length, 64, 'sha-256 evidence');
    assert.equal(record.tenantId, account.tenantId);
    assert.equal(mod.getAccount(account.id)!.status, 'offboarded');
    assert.equal(mod.offboardings().length, 1);
    const stats = mod.accountStats();
    assert.equal(stats.offboarded, 1);
    assert.equal(stats.offboardingRecords, 1);
  });

  it('tenant isolation: two customers never share accounts or tenants', () => {
    const a1 = mod.createCustomerAccount({ orgName: 'Isolate A', slug: 'a', adminEmail: 'a@a.io', customerId: 'cust-200' });
    const a2 = mod.createCustomerAccount({ orgName: 'Isolate B', slug: 'b', adminEmail: 'b@b.io', customerId: 'cust-201' });
    assert.notEqual(a1.tenantId, a2.tenantId);
    assert.equal(mod.accountByCustomer('cust-200')!.id, a1.id);
    assert.equal(mod.accountByCustomer('cust-201')!.id, a2.id);
    assert.equal(mod.listAccounts({ status: 'active' }).length, 2);
  });
});
