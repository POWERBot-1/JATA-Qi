import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { SecurityModule } from '@jataqi/security';
import { SovereignModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('SovereignModule', () => {
  let kernel: Kernel;
  let sov: SovereignModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new SecurityModule());
    kernel.register(new SovereignModule());
    await kernel.boot();
    sov = kernel.getModule<SovereignModule>('sovereign');
  });

  // --- jurisdiction profiles ------------------------------------------------

  it('seeds built-in jurisdiction profiles', async () => {
    const profiles = await sov.listProfiles();
    assert.ok(profiles.length >= 9);
    const ke = await sov.getProfile('kenya');
    assert.equal(ke!.countryCode, 'KE');
    assert.equal(ke!.currency, 'KES');
    assert.ok(ke!.complianceFrameworks.includes('Kenya-DPA-2019'));
  });

  it('lists profiles by region', async () => {
    const africa = await sov.listProfiles('East Africa');
    assert.ok(africa.some((p) => p.countryCode === 'KE'));
    const eu = await sov.listProfiles('EU');
    assert.ok(eu.some((p) => p.countryCode === 'EU'));
  });

  it('creates custom jurisdiction profiles', async () => {
    const custom = await sov.createProfile({
      countryCode: 'RW', countryName: 'Rwanda', region: 'East Africa',
      dataResidency: 'preferred', allowedDataRegions: ['RW', '*'],
      encryptionStandard: 'AES-256-GCM', keyManagementLocation: 'any',
      complianceFrameworks: ['Law-N°058/2021'], authenticationRequirements: ['MFA-recommended'],
      crossBorderTransferAllowed: true, governmentCloudRequired: false,
      auditLogRetentionDays: 2555, language: 'en', currency: 'RWF',
    });
    assert.ok(custom.id);
    const found = await sov.getProfile(custom.id);
    assert.equal(found!.countryName, 'Rwanda');
  });

  // --- regions --------------------------------------------------------------

  it('adds regions with failover priority', async () => {
    const primary = await sov.addRegion({ name: 'Nairobi DC', countryCode: 'KE', provider: 'private', isPrimary: true, failoverPriority: 1 });
    const standby = await sov.addRegion({ name: 'Mombas DR', countryCode: 'KE', provider: 'aws', failoverPriority: 2 });
    assert.equal(primary.isPrimary, true);
    assert.equal(standby.status, 'active');
    const found = await sov.getPrimaryRegion();
    assert.equal(found!.id, primary.id);
  });

  it('lists regions by country', async () => {
    await sov.addRegion({ name: 'Frankfurt', countryCode: 'EU' });
    await sov.addRegion({ name: 'Nairobi', countryCode: 'KE' });
    assert.equal((await sov.listRegions('EU')).length, 1);
    assert.equal((await sov.listRegions('KE')).length, 1);
  });

  it('triggers failover: demotes primary, promotes next', async () => {
    const r1 = await sov.addRegion({ name: 'Primary', countryCode: 'KE', isPrimary: true, failoverPriority: 1 });
    const r2 = await sov.addRegion({ name: 'Standby', countryCode: 'KE', failoverPriority: 2 });
    const result = await sov.failover('maintenance');
    assert.equal(result.from!.id, r1.id);
    assert.equal(result.to.id, r2.id);
    assert.equal(result.to.isPrimary, true);
    // Old primary is offline.
    const old = await sov.getRegion(r1.id);
    assert.equal(old!.status, 'offline');
  });

  it('throws when no regions available for failover', async () => {
    await assert.rejects(() => sov.failover('test'), /no standby regions/);
  });

  // --- sovereign policies ---------------------------------------------------

  it('creates sovereign policies linked to jurisdiction profiles', async () => {
    const policy = await sov.createPolicy({
      jurisdictionProfileId: 'eu', deploymentMode: 'private-cloud', createdBy: 'admin',
    });
    assert.equal(policy.jurisdictionProfileId, 'eu');
    assert.equal(policy.deploymentMode, 'private-cloud');
    assert.ok(policy.requiredFrameworks.includes('GDPR'));
  });

  it('creates organization-specific policies', async () => {
    const policy = await sov.createPolicy({
      organizationId: 'org-1', jurisdictionProfileId: 'kenya', deploymentMode: 'cloud', createdBy: 'admin',
    });
    assert.equal(policy.organizationId, 'org-1');
    const orgPolicies = await sov.listPolicies('org-1');
    assert.equal(orgPolicies.length, 1);
  });

  // --- compliance checks ----------------------------------------------------

  it('checks data residency compliance (allowed region)', async () => {
    const policy = await sov.createPolicy({ jurisdictionProfileId: 'eu', deploymentMode: 'cloud', createdBy: 'admin' });
    const result = await sov.checkCompliance(policy.id, { targetRegion: 'EU' });
    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
  });

  it('detects data residency violations (denied region)', async () => {
    const policy = await sov.createPolicy({
      jurisdictionProfileId: 'eu', deploymentMode: 'cloud', createdBy: 'admin',
      allowedRegions: ['EU'], deniedRegions: ['CN'],
    });
    const result = await sov.checkCompliance(policy.id, { targetRegion: 'CN' });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.includes('CN')));
  });

  it('blocks cross-border transfer for strict jurisdictions', async () => {
    const policy = await sov.createPolicy({ jurisdictionProfileId: 'china', deploymentMode: 'on-premise', createdBy: 'admin' });
    const result = await sov.checkCompliance(policy.id, { crossBorder: true });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.includes('Cross-border')));
  });

  it('allows cross-border for unrestricted jurisdictions', async () => {
    const policy = await sov.createPolicy({ jurisdictionProfileId: 'usa', deploymentMode: 'cloud', createdBy: 'admin' });
    const result = await sov.checkCompliance(policy.id, { crossBorder: true });
    assert.equal(result.passed, true);
  });

  it('flags sensitive data in strict residency jurisdictions', async () => {
    const policy = await sov.createPolicy({ jurisdictionProfileId: 'eu', deploymentMode: 'private-cloud', createdBy: 'admin' });
    const result = await sov.checkCompliance(policy.id, { dataClassification: 'restricted', targetRegion: 'US' });
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.includes('Sensitive data')));
  });

  // --- events & audit -------------------------------------------------------

  it('emits policy creation events', async () => {
    let events = 0;
    kernel.bus.on('sovereign.policy.created', () => { events++; });
    await sov.createPolicy({ jurisdictionProfileId: 'kenya', deploymentMode: 'cloud', createdBy: 'admin' });
    assert.equal(events, 1);
  });

  it('emits failover events', async () => {
    let events = 0;
    kernel.bus.on('sovereign.failover.triggered', () => { events++; });
    await sov.addRegion({ name: 'R1', countryCode: 'KE', isPrimary: true, failoverPriority: 1 });
    await sov.addRegion({ name: 'R2', countryCode: 'KE', failoverPriority: 2 });
    await sov.failover('test');
    assert.equal(events, 1);
  });

  it('emits compliance violation events', async () => {
    let violations = 0;
    kernel.bus.on('sovereign.compliance.violation', () => { violations++; });
    const policy = await sov.createPolicy({
      jurisdictionProfileId: 'eu', deploymentMode: 'cloud', createdBy: 'admin',
      allowedRegions: ['EU'], deniedRegions: ['CN'],
    });
    await sov.checkCompliance(policy.id, { targetRegion: 'CN' });
    assert.equal(violations, 1);
  });

  it('records audit entries', async () => {
    const sec = kernel.getModule<SecurityModule>('security');
    await sov.createPolicy({ jurisdictionProfileId: 'kenya', deploymentMode: 'cloud', createdBy: 'admin' });
    const audit = await sec.getAuditLog().query({ action: 'sovereign.policy_created' });
    assert.ok(audit.length >= 1);
  });

  // --- stats ----------------------------------------------------------------

  it('reports aggregate stats', async () => {
    await sov.addRegion({ name: 'R1', countryCode: 'KE' });
    await sov.createPolicy({ jurisdictionProfileId: 'kenya', deploymentMode: 'cloud', createdBy: 'admin' });
    const s = await sov.stats();
    assert.ok(s.profiles >= 9);
    assert.ok(s.regions >= 1);
    assert.ok(s.policies >= 1);
  });
});
