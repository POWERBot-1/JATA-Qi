// SecurityAutomationModule tests — cross-pillar security automation.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { JataQiClient } from '@jataqi/sdk';
import { SocModule } from '@jataqi/soc';
import { ActiveDefenseModule } from '@jataqi/active-defense';
import { SupplyChainSecurityModule } from '@jataqi/supply-chain-security';
import { InfrastructureGovernanceModule } from '@jataqi/infra-governance';
import { ResilienceEngineeringModule } from '@jataqi/resilience-engineering';
import { SecurityReviewModule } from '@jataqi/security-review';
import {
  SecurityAutomationModule, SecurityAutomationEvents, CorrelationEngine, mapSeverity,
  DEFAULT_CORRELATION_RULES, ComplianceReportBuilder,
} from '../src/index.js';

type CreateJataQi = (cfg?: Record<string, unknown>) => Promise<{ gateway?: { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> }; shutdown(): Promise<void> }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- correlation engine units -------------------------------------------------

describe('CorrelationEngine (cross-pillar incident correlation)', () => {
  function harness() {
    const incidents: Array<{ title: string; severity: string; status: string }> = [];
    const bans: Array<{ scope: string; value: string }> = [];
    const risks: Array<{ userId: string; type: string }> = [];
    const engine = new CorrelationEngine({
      openIncident: (input) => {
        const incident = { id: `inc-${incidents.length + 1}`, title: input.title, severity: input.severity, status: 'detected' as const };
        incidents.push(incident);
        return incident as never;
      },
      transitionIncident: (id, status) => {
        const inc = incidents.find((i) => `inc-${incidents.indexOf(i) + 1}` === id);
        if (inc) inc.status = status;
        return inc as never;
      },
      ban: (input) => { bans.push({ scope: input.scope, value: input.value }); return undefined; },
      riskSignal: (userId, signal) => { risks.push({ userId, type: signal.type }); },
    });
    return { engine, incidents, bans, risks };
  }

  it('maps severities onto the incident scale', () => {
    assert.equal(mapSeverity('critical'), 'sev1');
    assert.equal(mapSeverity('high'), 'sev2');
    assert.equal(mapSeverity('medium'), 'sev3');
    assert.equal(mapSeverity('low'), 'sev4');
  });

  it('opens a SOC incident from an active-defense finding with severity mapping', () => {
    const { engine, incidents } = harness();
    engine.ingest('defense.finding.created', { rule: 'honeytoken_touch', severity: 'critical' });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]!.title, 'Active defense finding: honeytoken_touch');
    // Severity override via payload.
    const { engine: e2, incidents: i2 } = harness();
    e2.ingest('defense.finding.created', { rule: 'login_burst', severity: 'high' });
    assert.equal(i2[0]!.severity, 'sev2');
  });

  it('dedupes while an incident is open and re-opens after auto-close', () => {
    const { engine, incidents } = harness();
    engine.ingest('defense.finding.created', { rule: 'integrity_mismatch', severity: 'high' });
    engine.ingest('defense.finding.created', { rule: 'integrity_mismatch', severity: 'high' });
    assert.equal(incidents.length, 1, 'deduped');
    // Remediation → auto-close.
    engine.ingest('defense.finding.resolved', { rule: 'integrity_mismatch' });
    assert.equal(incidents[0]!.status, 'closed', 'auto-closed on remediation');
    assert.equal(engine.openCount(), 0);
    // Re-trigger → new incident.
    engine.ingest('defense.finding.created', { rule: 'integrity_mismatch', severity: 'high' });
    assert.equal(incidents.length, 2);
  });

  it('correlates deployment integrity mismatch as sev1', () => {
    const { engine, incidents } = harness();
    engine.ingest('supplychain.deployment.mismatch', { artifactName: 'api.bin', environment: 'production' });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]!.severity, 'sev1');
    assert.match(incidents[0]!.title, /api\.bin/);
  });

  it('auto-closes failover incidents when the region recovers', () => {
    const { engine, incidents } = harness();
    engine.ingest('resilience.failover.completed', { workload: 'api', from: 'nbo-1', to: 'lon-1' });
    assert.equal(incidents.length, 1);
    engine.ingest('resilience.region.health', { region: 'lon-1', health: 'healthy', ok: true });
    assert.equal(incidents[0]!.status, 'closed');
  });

  it('auto-bans abuse actors/origins and risk-signals insiders', () => {
    const { engine, bans, risks } = harness();
    engine.ingest('soc.abuse.alert', { id: 'a1', rule: 'credential_stuffing', severity: 'high', actors: ['bot-1'], origins: ['203.0.113.9'] });
    assert.ok(bans.some((b) => b.scope === 'user' && b.value === 'bot-1'));
    assert.ok(bans.some((b) => b.scope === 'ip' && b.value === '203.0.113.9'));
    engine.ingest('soc.insider.alert', { id: 'i1', rule: 'privileged_burst', severity: 'high', actor: 'svc-acc' });
    assert.ok(risks.some((r) => r.userId === 'svc-acc' && r.type === 'insider_misuse'));
    // Low-severity abuse still correlates (rule-based) but ban is unconditional on the rule.
    assert.equal(DEFAULT_CORRELATION_RULES.length >= 11, true);
  });

  it('supports custom rules via upsert', () => {
    const { engine } = harness();
    engine.upsertRule({ id: 'correlate.custom', event: 'custom.event', severity: 'sev4', title: 'Custom ${thing}', key: 'custom:${thing}' });
    const result = engine.ingest('custom.event', { thing: 'x' });
    assert.ok(result);
    assert.equal(result!.severity, 'sev4');
    assert.equal(engine.rulesList().length, DEFAULT_CORRELATION_RULES.length + 1);
  });
});

// ---- compliance report builder -------------------------------------------------

describe('ComplianceReportBuilder (ISO 27001 evidence)', () => {
  it('builds per-family evidence from the security lake', () => {
    const builder = new ComplianceReportBuilder();
    const report = builder.build({
      lake: [
        { id: '1', ts: Date.now(), source: 'auth', type: 'security.user.login', hash: '', prevHash: '' },
        { id: '2', ts: Date.now(), source: 'auth', type: 'security.auth.denied', hash: '', prevHash: '' },
        { id: '3', ts: Date.now(), source: 'tool', type: 'tool.invoked', hash: '', prevHash: '' },
        { id: '4', ts: Date.now(), source: 'soc', type: 'soc.incident.opened', hash: '', prevHash: '' },
      ],
      reviewEvidence: { 'A.5': true, 'A.17': true },
      availabilityHealthy: 2, availabilityTotal: 2, failovers: 3,
      supplyChainVulnerable: 1, supplyChainAudits: 4,
      infraComplianceRate: 83, incidentCount: 5, huntSweeps: 2,
    });
    assert.equal(report.families.length, 12);
    const a9 = report.families.find((f) => f.id === 'A.9')!;
    assert.equal(a9.evidenceCount, 2, 'login + denied events evidence access control');
    const a5 = report.families.find((f) => f.id === 'A.5')!;
    assert.equal(a5.satisfied, true, 'review scorecard satisfies');
    assert.equal(a5.coverage, 100);
    assert.ok(report.overall > 0);
    assert.ok(report.notes.some((n) => n.includes('Availability')));
    assert.ok(builder.toJson(report).includes('"overall"'));
    assert.ok(builder.toMarkdown(report).includes('| A.9'));
    assert.ok(report.sources.length >= 6);
  });
});

// ---- kernel wiring --------------------------------------------------------------

describe('SecurityAutomationModule (kernel wiring + real bus)', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new SocModule());
    kernel.register(new ActiveDefenseModule());
    kernel.register(new SupplyChainSecurityModule());
    kernel.register(new InfrastructureGovernanceModule());
    kernel.register(new ResilienceEngineeringModule());
    kernel.register(new SecurityReviewModule());
    kernel.register(new SecurityAutomationModule());
    await kernel.boot();
  });

  after(async () => { await kernel.shutdown(); });

  it('auto-opens a SOC incident from a live defense finding', async () => {
    const mod = kernel.getModule<SecurityAutomationModule>('security-automation');
    const soc = kernel.getModule<SocModule>('soc');
    const defense = kernel.getModule<ActiveDefenseModule>('active-defense');
    const before = soc.listIncidents().length;
    // Create a finding through the active-defense module → bus → correlation.
    defense.ingest({ type: 'defense.honeytoken.touched', severity: 'critical', title: 'Honeytoken touched', actor: 'x' });
    await sleep(50);
    const incidents = soc.listIncidents();
    assert.ok(incidents.length > before, 'incident auto-opened');
    const correlated = mod.correlations();
    assert.ok(correlated.some((c) => c.ruleId === 'correlate.defense.finding'));
    // Auto-close on finding resolve.
    const finding = defense.findings({ severity: 'critical' })[0]!;
    defense.resolveFinding(finding.id);
    await sleep(50);
    assert.ok(mod.correlatedOpenCount() === 0 || mod.correlations().some((c) => c.closedAt), 'auto-closed on remediation');
  });

  it('runs scheduled threat hunts and records sweeps', async () => {
    const mod = kernel.getModule<SecurityAutomationModule>('security-automation');
    mod.configureHunts({ intervalMs: 0, playbooks: ['hunt.credential_stuffing'] });
    const result = await mod.runHuntSweep();
    assert.ok(result.sessions.length >= 1);
    assert.equal(result.totalHits >= 0, true);
    assert.equal(mod.huntSweeps().length, 1);
    assert.equal(mod.huntsRunning(), false, 'interval 0 → not running');
    // Interval scheduling.
    mod.configureHunts({ intervalMs: 20_000 });
    assert.equal(mod.huntsRunning(), true);
    mod.configureHunts({ intervalMs: 0 });
    assert.equal(mod.huntsRunning(), false);
  });

  it('emits secauto events on the bus', async () => {
    const mod = kernel.getModule<SecurityAutomationModule>('security-automation');
    const events: string[] = [];
    kernel.bus.on(SecurityAutomationEvents.HuntSweepCompleted, () => { events.push(SecurityAutomationEvents.HuntSweepCompleted); });
    kernel.bus.on(SecurityAutomationEvents.ComplianceReportGenerated, () => { events.push(SecurityAutomationEvents.ComplianceReportGenerated); });
    await mod.runHuntSweep();
    mod.buildComplianceReport();
    assert.ok(events.includes(SecurityAutomationEvents.HuntSweepCompleted));
    assert.ok(events.includes(SecurityAutomationEvents.ComplianceReportGenerated));
  });

  it('builds a live compliance report from the platform state', () => {
    const mod = kernel.getModule<SecurityAutomationModule>('security-automation');
    const report = mod.buildComplianceReport();
    assert.equal(report.families.length, 12);
    assert.ok(report.overall >= 0 && report.overall <= 100);
    assert.ok(report.sources.length >= 6);
  });
});

// ---- gateway integration -----------------------------------------------------------

describe('Security automation gateway integration (vs real server)', () => {
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

  it('exposes correlation rules, posture, and hunts', async () => {
    const rules = await admin.secauto.rules();
    assert.ok((rules.rules as unknown[]).length >= 11);
    const posture = await admin.secauto.posture();
    assert.ok((posture as { correlations: unknown[] }).correlations);
    const sweeps = await admin.secauto.hunts();
    assert.ok(Array.isArray(sweeps.sweeps));
  });

  it('auto-opens an incident when a defense finding fires (end-to-end)', async () => {
    await admin.defense.ingest('defense.honeytoken.touched', { severity: 'critical', title: 'Honeytoken touched', actor: 'auto-test' });
    await sleep(100);
    const correlations = await admin.secauto.correlations();
    const hit = (correlations.correlations as Array<{ ruleId: string }>).find((c) => c.ruleId === 'correlate.defense.finding');
    assert.ok(hit, 'correlated incident recorded');
    const incidents = await admin.soc.incidents();
    assert.ok((incidents.incidents as unknown[]).length >= 1);
  });

  it('runs a hunt sweep and generates a compliance report via gateway', async () => {
    const run = await admin.secauto.runHunts();
    assert.ok((run as { result: { totalHits: number } }).result.totalHits >= 0);
    const report = await admin.secauto.complianceReport();
    assert.equal(((report as { report: { families: unknown[] } }).report).families.length, 12);
    const exportResult = await admin.secauto.complianceExport();
    assert.ok((exportResult as string).includes('"overall"'));
  });
});
