import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { CyberdefenseModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('CyberdefenseModule', () => {
  let kernel: Kernel; let cyber: CyberdefenseModule;
  beforeEach(async () => { kernel = createTestKernel(); kernel.register(new StorageModule()); kernel.register(new CyberdefenseModule()); await kernel.boot(); cyber = kernel.getModule<CyberdefenseModule>('cyberdefense'); });

  it('adds threat indicators and checks values against them', async () => {
    let detected = 0; kernel.bus.on('cyber.threat.detected', () => { detected++; });
    await cyber.addThreat({ type: 'ip', value: '203.0.113.66', severity: 'high', source: 'feed-a' });
    const clean = await cyber.checkValue('192.168.1.1');
    assert.equal(clean.matched, false);
    const hit = await cyber.checkValue('203.0.113.66');
    assert.equal(hit.matched, true);
    assert.equal(hit.indicators.length, 1);
    assert.equal(detected, 1);
  });

  it('reports and tracks vulnerabilities through remediation', async () => {
    const v = await cyber.reportVulnerability({ cveId: 'CVE-2026-1234', title: 'SQL Injection in /api', severity: 'critical', affectedSystem: 'api-gateway', reportedBy: 'scanner' });
    assert.equal(v.status, 'open');
    assert.equal(v.severity, 'critical');
    const remediated = await cyber.updateVulnerability(v.id, 'remediated', 'dev-team');
    assert.equal(remediated.status, 'remediated');
    assert.equal((await cyber.listVulnerabilities(undefined, 'open')).length, 0);
    assert.equal((await cyber.listVulnerabilities('critical')).length, 1);
  });

  it('creates, assigns, and resolves security incidents', async () => {
    let created = 0; let resolved = 0;
    kernel.bus.on('cyber.incident.created', () => { created++; });
    kernel.bus.on('cyber.incident.resolved', () => { resolved++; });
    const inc = await cyber.createIncident({ title: 'Brute force attempt', severity: 'high', createdBy: 'soc-analyst', description: 'Multiple failed logins from 203.0.113.66' });
    assert.equal(inc.status, 'open');
    assert.equal(created, 1);
    const assigned = await cyber.updateIncident(inc.id, { assignee: 'responder-1', status: 'investigating' }, 'lead');
    assert.equal(assigned.assignee, 'responder-1');
    const done = await cyber.updateIncident(inc.id, { status: 'resolved' }, 'lead');
    assert.equal(done.status, 'resolved');
    assert.ok(done.resolvedAt);
    assert.equal(resolved, 1);
  });

  it('logs and lists security events', async () => {
    await cyber.recordEvent({ type: 'auth.failure', source: 'api-gateway', severity: 'medium', detail: '5 failed logins' });
    await cyber.recordEvent({ type: 'rate.exceeded', source: 'api-gateway', severity: 'low' });
    await cyber.recordEvent({ type: 'intrusion.attempt', source: 'waf', severity: 'critical' });
    assert.equal((await cyber.listEvents()).length, 3);
    assert.equal((await cyber.listEvents('critical')).length, 1);
  });
});
