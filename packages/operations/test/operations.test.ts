// OperationsModule tests — production operations.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { JataQiClient } from '@jataqi/sdk';
import { OperationsModule, OperationsEvents } from '../src/index.js';

type CreateJataQi = (cfg?: Record<string, unknown>) => Promise<{ gateway?: { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> }; shutdown(): Promise<void> }>;

describe('OperationsEngine (on-call + escalation)', () => {
  it('creates rotations and determines the current on-call engineer deterministically', () => {
    const mod = new OperationsModule();
    mod.createRotation({ id: 'core', engineers: ['alice', 'bob', 'carol'], shiftMs: 86_400_000 });
    const onCall = mod.currentOnCall('core');
    assert.ok(['alice', 'bob', 'carol'].includes(onCall ?? ''));
    // Deterministic: same wall-clock → same engineer.
    assert.equal(mod.currentOnCall('core'), onCall);
  });

  it('builds escalation chains per severity', () => {
    const mod = new OperationsModule();
    mod.createRotation({ id: 'core', engineers: ['alice', 'bob', 'carol'], shiftMs: 86_400_000, escalations: [{ severity: 'sev1', depth: 3 }] });
    const chain = mod.escalationChain('core', 'sev1');
    assert.equal(chain.length, 3);
    assert.equal(chain[0], mod.currentOnCall('core'), 'primary on-call first');
  });

  it('evaluates escalation SLAs by elapsed time', () => {
    const mod = new OperationsModule();
    mod.addEscalationSla({ severity: 'sev2', minutes: 15, level: 1 });
    mod.addEscalationSla({ severity: 'sev2', minutes: 60, level: 2 });
    assert.equal(mod.escalationLevel('sev2', 5).due, false);
    const at30 = mod.escalationLevel('sev2', 30);
    assert.equal(at30.due, true);
    assert.equal(at30.level, 1);
    const at90 = mod.escalationLevel('sev2', 90);
    assert.equal(at90.level, 2);
  });
});

describe('OperationsEngine (backup verification + DR drills + health)', () => {
  it('verifies backups with content-hash matching and records failures', () => {
    const mod = new OperationsModule();
    const ok = mod.verifyBackup({ backupId: 'bk-1', namespace: 'payments', entries: 1200, recordedHash: 'abc', actualHash: 'abc' });
    assert.equal(ok.ok, true);
    assert.equal(ok.contentHashMatch, true);
    const bad = mod.verifyBackup({ backupId: 'bk-2', namespace: 'payments', entries: 1200, recordedHash: 'abc', actualHash: 'tampered' });
    assert.equal(bad.ok, false);
    assert.equal(mod.stats().backupsVerified, 1);
    assert.equal(mod.stats().backupFailures, 1);
  });

  it('runs a full DR drill lifecycle to passed', () => {
    const mod = new OperationsModule();
    const drill = mod.startDrill({ name: 'Q3 DR drill', scope: 'payments + api', executedBy: 'sre-lead' });
    assert.equal(drill.stage, 'plan');
    for (const stage of ['simulate', 'restore', 'validate', 'failover', 'recover', 'completed'] as const) {
      mod.advanceDrill(drill.id, stage, stage === 'failover' ? 'failover nbo-1→lon-1 verified' : undefined);
    }
    const done = mod.drills()[0]!;
    assert.equal(done.result, 'passed');
    assert.equal(mod.stats().drillsPassed, 1);
  });

  it('fails drills and reports the failure', () => {
    const mod = new OperationsModule();
    const drill = mod.startDrill({ name: 'Failed drill', scope: 'x', executedBy: 'sre' });
    mod.failDrill(drill.id, 'restore step exceeded RTO');
    assert.equal(mod.drills()[0]!.result, 'failed');
  });

  it('generates operational health reports with overall status and on-call', () => {
    const mod = new OperationsModule();
    mod.createRotation({ id: 'core', engineers: ['alice', 'bob'] });
    mod.verifyBackup({ backupId: 'bk-1', namespace: 'n', entries: 1, recordedHash: 'h', actualHash: 'h' });
    const report = mod.generateHealthReport({
      checks: [
        { name: 'gateway', status: 'healthy' },
        { name: 'database', status: 'degraded', detail: 'replica lag 5s' },
      ],
      uptimePct: 99.95, openIncidents: 2, rotationId: 'core',
    });
    assert.equal(report.overall, 'degraded');
    assert.equal(report.onCallEngineer, mod.currentOnCall('core'));
    assert.equal(report.backupsVerified, 1);
    assert.equal(mod.stats().overallHealth, 'degraded');
    // All healthy → healthy.
    const healthy = mod.generateHealthReport({ checks: [{ name: 'gateway', status: 'healthy' }] });
    assert.equal(healthy.overall, 'healthy');
  });
});

describe('OperationsModule (kernel wiring)', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new OperationsModule());
    await kernel.boot();
  });

  after(async () => { await kernel.shutdown(); });

  it('emits operations events', async () => {
    const mod = kernel.getModule<OperationsModule>('operations');
    const events: string[] = [];
    kernel.bus.on(OperationsEvents.BackupVerified, () => { events.push(OperationsEvents.BackupVerified); });
    kernel.bus.on(OperationsEvents.BackupVerificationFailed, () => { events.push(OperationsEvents.BackupVerificationFailed); });
    kernel.bus.on(OperationsEvents.DrillCompleted, () => { events.push(OperationsEvents.DrillCompleted); });
    mod.verifyBackup({ backupId: 'a', namespace: 'n', entries: 1, recordedHash: 'h', actualHash: 'h' });
    mod.verifyBackup({ backupId: 'b', namespace: 'n', entries: 1, recordedHash: 'h', actualHash: 'x' });
    const drill = mod.startDrill({ name: 'Drill', scope: 's', executedBy: 'ops' });
    mod.advanceDrill(drill.id, 'completed');
    assert.ok(events.includes(OperationsEvents.BackupVerified));
    assert.ok(events.includes(OperationsEvents.BackupVerificationFailed));
    assert.ok(events.includes(OperationsEvents.DrillCompleted));
  });
});

describe('Operations gateway integration (vs real server)', () => {
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

  it('on-call rotation, backup verification, drill, and health report end-to-end', async () => {
    const rotation = await admin.ops.createRotation(['alice', 'bob', 'carol'], { shiftMs: 86_400_000 });
    const rotationId = (rotation.rotation as { id: string }).id;
    const onCall = await admin.ops.onCall(rotationId);
    assert.ok(['alice', 'bob', 'carol'].includes(onCall.onCall));
    const sla = await admin.ops.addEscalationSla('sev1', 15, 1);
    assert.equal((sla.sla as { minutes: number }).minutes, 15);

    const verification = await admin.ops.verifyBackup({ backupId: 'bk-live', namespace: 'payments', entries: 500, recordedHash: 'h1', actualHash: 'h1' });
    assert.equal((verification.verification as { ok: boolean }).ok, true);

    const drill = await admin.ops.startDrill('GA DR drill', 'full platform');
    const drillId = (drill.drill as { id: string }).id;
    await admin.ops.advanceDrill(drillId, 'completed');
    const drills = await admin.ops.drills();
    assert.equal((drills.drills as Array<{ result: string }>)[0]!.result, 'passed');

    const report = await admin.ops.healthReport({ checks: [{ name: 'gateway', status: 'healthy' }], rotationId });
    assert.equal((report.report as { overall: string }).overall, 'healthy');
    const stats = await admin.ops.stats();
    assert.equal((stats.stats as { backupsVerified: number }).backupsVerified, 1);
    assert.equal((stats.stats as { drillsPassed: number }).drillsPassed, 1);
  });
});
