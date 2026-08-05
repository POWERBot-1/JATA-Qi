// PRX Part E — Cloud Platform tests: regions/capacity, compute lifecycle,
// volumes + snapshots, networking, hosting plans, autoscaling, and memory
// integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CloudEngine } from '../src/index.js';
import { CloudModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

/** Seed a standard catalog (region + flavors + images). */
function seedCatalog(c: CloudEngine) {
  const region = c.registerRegion({ name: 'Nairobi', code: 'NBO', country: 'KE', zones: ['nbo-1', 'nbo-2'], capacitySlots: 4 });
  const vps = c.registerFlavor({ name: 'vps-2', tier: 'vps', vcpu: 2, ramGb: 4, diskGb: 80, pricePerHourMinor: 500 });
  const shared = c.registerFlavor({ name: 'shared-1', tier: 'shared', vcpu: 1, ramGb: 1, diskGb: 25, pricePerHourMinor: 120 });
  const gpu = c.registerFlavor({ name: 'gpu-1', tier: 'gpu', vcpu: 8, ramGb: 32, diskGb: 200, gpu: 1, pricePerHourMinor: 4000 });
  const ubuntu = c.registerImage({ name: 'Ubuntu 24.04', os: 'ubuntu', version: '24.04' });
  return { region, vps, shared, gpu, ubuntu };
}

describe('CloudEngine', () => {
  it('registers regions, flavors, and images', () => {
    const c = new CloudEngine();
    const { region, vps, gpu, ubuntu } = seedCatalog(c);
    assert.equal(region.code, 'NBO');
    assert.equal(c.listRegions().length, 1);
    c.setRegionStatus(region.id, 'degraded');
    assert.equal(c.listRegions('degraded').length, 1);
    assert.equal(c.listFlavors('gpu').length, 1);
    assert.equal(vps.tier, 'vps');
    assert.equal(gpu.gpu, 1);
    assert.equal(ubuntu.arch, 'x86_64');
    assert.throws(() => c.registerRegion({ name: 'X', code: 'X', country: 'KE', zones: [] }), /zone/);
    assert.throws(() => c.registerFlavor({ name: 'X', tier: 'vps', vcpu: 0, ramGb: 1, diskGb: 1, pricePerHourMinor: 1 }), /vcpu/);
  });

  it('provisions instances through the lifecycle and enforces capacity', () => {
    const c = new CloudEngine();
    const { region, vps, ubuntu } = seedCatalog(c);
    const i1 = c.provisionInstance({ name: 'web-1', regionId: region.id, flavorId: vps.id, imageId: ubuntu.id });
    assert.equal(i1.status, 'provisioning');
    assert.equal(region.usedSlots, 1);

    c.setInstanceStatus(i1.id, 'running');
    assert.equal(i1.status, 'running');
    assert.ok(i1.publicIp);
    assert.ok(i1.privateIp);

    c.rebootInstance(i1.id);
    assert.equal(i1.status, 'stopped');

    c.setInstanceStatus(i1.id, 'running');
    c.terminateInstance(i1.id);
    assert.equal(i1.status, 'terminated');
    assert.equal(region.usedSlots, 0);

    assert.throws(() => c.setInstanceStatus(i1.id, 'running'), /terminated/);
    // Capacity: provision 4 (fills the region) then fail the 5th.
    for (let i = 0; i < 4; i++) {
      c.provisionInstance({ name: `fill-${i}`, regionId: region.id, flavorId: vps.id, imageId: ubuntu.id });
    }
    assert.throws(() => c.provisionInstance({ name: 'overflow', regionId: region.id, flavorId: vps.id, imageId: ubuntu.id }), /capacity/);
  });

  it('creates volumes, snapshots, and attaches them to instances', () => {
    const c = new CloudEngine();
    const { region, vps, ubuntu } = seedCatalog(c);
    const instance = c.provisionInstance({ name: 'db-1', regionId: region.id, flavorId: vps.id, imageId: ubuntu.id });
    const volume = c.createVolume({ name: 'data', sizeGb: 100, regionId: region.id });
    assert.equal(volume.status, 'available');

    c.attachVolume(volume.id, instance.id);
    assert.equal(volume.status, 'attached');
    assert.deepEqual(instance.volumeIds, [volume.id]);
    assert.throws(() => c.attachVolume(volume.id, instance.id), /already attached/);

    const snapshot = c.createSnapshot(volume.id);
    assert.equal(snapshot.sizeGb, 100);
    assert.equal(c.listSnapshots(volume.id).length, 1);

    c.detachVolume(volume.id);
    assert.equal(volume.status, 'available');
    assert.equal(instance.volumeIds.length, 0);
    // Terminating an instance detaches its volumes.
    c.attachVolume(volume.id, instance.id);
    c.terminateInstance(instance.id);
    assert.equal(volume.status, 'available');
  });

  it('builds VPCs, firewall rules, and load balancers', () => {
    const c = new CloudEngine();
    const { region, vps, ubuntu } = seedCatalog(c);
    const vpc = c.createVpc({ name: 'prod', regionId: region.id, cidr: '10.0.0.0/16', subnetCidrs: ['10.0.1.0/24'] });
    const rule = c.addFirewallRule({ vpcId: vpc.id, name: 'allow-https', direction: 'ingress', protocol: 'tcp', portRange: '443', sourceCidr: '0.0.0.0/0', action: 'allow' });
    assert.equal(rule.action, 'allow');
    assert.equal(c.listFirewallRules(vpc.id).length, 1);

    const lb = c.createLoadBalancer({ name: 'web-lb', regionId: region.id, protocol: 'tcp', port: 443 });
    const web = c.provisionInstance({ name: 'web-1', regionId: region.id, flavorId: vps.id, imageId: ubuntu.id, vpcId: vpc.id });
    c.addLoadBalancerTarget(lb.id, web.id);
    assert.deepEqual(lb.targetInstanceIds, [web.id]);
  });

  it('provisions hosting plans (vps + managed) and autoscales', () => {
    const c = new CloudEngine();
    const { vps, shared, ubuntu } = seedCatalog(c);
    // Dedicated region with enough slots for hosting + autoscaling.
    const region = c.registerRegion({ name: 'Nairobi', code: 'NBO', country: 'KE', zones: ['nbo-1', 'nbo-2'], capacitySlots: 10 });
    const plan = c.createHostingPlan({ name: 'Starter VPS', tier: 'vps', monthlyPriceMinor: 150000, flavorId: vps.id, sslAutomation: true, cdnIncluded: true, backupIncluded: true, databasesIncluded: 1 });
    const site = c.provisionHosting({ planId: plan.id, regionId: region.id, siteName: 'acme.com', imageId: ubuntu.id });
    assert.equal(site.hostingPlanId, plan.id);
    assert.equal(site.flavorId, vps.id);
    assert.equal(c.listHostingPlans('vps').length, 1);

    // Managed plan with shared flavor.
    const managed = c.createHostingPlan({ name: 'Managed Shared', tier: 'managed', monthlyPriceMinor: 80000, flavorId: shared.id });
    const mSite = c.provisionHosting({ planId: managed.id, regionId: region.id, siteName: 'blog.io', imageId: ubuntu.id });
    assert.equal(mSite.flavorId, shared.id);

    // Autoscaling: template + group, scale out on high load, in on low.
    const template = c.provisionInstance({ name: 'api-tpl', regionId: region.id, flavorId: vps.id, imageId: ubuntu.id });
    const group = c.createAutoscalingGroup({ name: 'api', regionId: region.id, templateInstanceId: template.id, min: 1, max: 3, cpuHighThreshold: 0.7, cpuLowThreshold: 0.2 });
    assert.equal(group.min, 1);
    // High load → scale out.
    const out = c.evaluateAutoscaling(group.id, 0.9);
    assert.equal(out.action, 'scale_out');
    assert.equal(c.listInstances({ status: 'provisioning' }).filter((i) => i.autoscalingGroupId === group.id).length, 1);
    // Another high-load tick → scale out again.
    assert.equal(c.evaluateAutoscaling(group.id, 0.95).action, 'scale_out');
    // Low load → scale in.
    const inResult = c.evaluateAutoscaling(group.id, 0.1);
    assert.equal(inResult.action, 'scale_in');
    // Mid load → none.
    assert.equal(c.evaluateAutoscaling(group.id, 0.5).action, 'none');
  });

  it('computes aggregate stats with capacity and revenue', () => {
    const c = new CloudEngine();
    const { region, vps, ubuntu } = seedCatalog(c);
    const instance = c.provisionInstance({ name: 'web-1', regionId: region.id, flavorId: vps.id, imageId: ubuntu.id });
    c.setInstanceStatus(instance.id, 'running');
    const stats = c.stats();
    assert.equal(stats.regions, 1);
    assert.equal(stats.instances, 1);
    assert.equal(stats.runningInstances, 1);
    assert.equal(stats.capacityUsedPct, 25); // 1 of 4 slots
    // Running vps-2 at 500 minor units/hour × 730 hours.
    assert.equal(stats.estimatedMonthlyRevenueMinor, 500 * 730);
  });
});

describe('CloudModule', () => {
  it('integrates with memory and emits lifecycle events', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    kernel.register(new CloudModule());
    await kernel.boot();
    try {
      const mod = kernel.getModule<CloudModule>('cloud');
      const provisioned: string[] = [];
      kernel.bus.on('cloud.instance.provisioned', (p: { id: string }) => { provisioned.push(p.id); });

      const region = mod.registerRegion({ name: 'Nairobi', code: 'NBO', country: 'KE', zones: ['nbo-1'], capacitySlots: 10 });
      const flavor = mod.registerFlavor({ name: 'vps-2', tier: 'vps', vcpu: 2, ramGb: 4, diskGb: 80, pricePerHourMinor: 500 });
      const image = mod.registerImage({ name: 'Ubuntu', os: 'ubuntu', version: '24.04' });
      const instance = await mod.provisionInstance({ name: 'web-1', regionId: region.id, flavorId: flavor.id, imageId: image.id });
      assert.equal(provisioned.length, 1);
      assert.equal(provisioned[0], instance.id);
      await mod.setInstanceStatus(instance.id, 'running');

      // Instance events recorded in the DME (order-independent).
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const recs = memory.query({ category: 'cloud_instance' });
      assert.equal(recs.length, 2);
      assert.ok(recs.some((r) => /provisioned web-1/.test(r.summary)));
      assert.ok(recs.some((r) => /→ running/.test(r.summary)));

      assert.ok(mod.stats().instances >= 1);
    } finally {
      await kernel.shutdown();
    }
  });
});
