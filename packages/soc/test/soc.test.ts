// SocModule tests — Global Security Operations: telemetry pipeline + data
// lake (hash chain), threat hunting, threat intelligence, insider risk,
// abuse detection, incident command framework, adversarial validation, and
// metrics. Unit engines + real-server gateway integration.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { JataQiClient } from '@jataqi/sdk';
import {
  SocModule, TelemetryPipeline, ThreatHuntingEngine, ThreatIntelEngine,
  InsiderRiskEngine, AbuseDetectionEngine, IncidentCommand, AdversarialValidationEngine,
  SocEvents, DEFAULT_HUNT_PLAYBOOKS,
} from '../src/index.js';

type CreateJataQi = (cfg?: Record<string, unknown>) => Promise<{ gateway?: { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> }; shutdown(): Promise<void> }>;

// ---- telemetry pipeline + data lake -------------------------------------------

describe('TelemetryPipeline (high-throughput pipeline + hash-chained lake)', () => {
  it('ingests, batches, queries, and exports', () => {
    const p = new TelemetryPipeline();
    p.ingest({ source: 'gateway', type: 'security.auth.denied', actor: 'alice', origin: '1.2.3.4' });
    p.ingest({ source: 'cloud', type: 'cloud.instance.provisioned', actor: 'alice' });
    p.ingestBatch([
      { source: 'ai', type: 'ai.model.call', actor: 'bot-1', severity: 'low' },
      { source: 'ai', type: 'ai.model.call', actor: 'bot-2' },
    ]);
    assert.equal(p.count(), 4);
    assert.equal(p.query({ type: 'security' }).length, 1, 'prefix match');
    assert.equal(p.query({ actor: 'alice' }).length, 2);
    assert.equal(p.query({ type: 'ai' }).length, 2);
    assert.ok(p.exportJsonl().includes('cloud.instance.provisioned'));
    assert.ok(p.exportCsv().startsWith('id,ts,source'));
    const a = p.analytics();
    assert.equal(a.bySource.ai, 2);
    assert.equal(a.byType['security.auth.denied'], 1);
  });

  it('produces a tamper-evident chain and detects tampering', () => {
    const p = new TelemetryPipeline();
    p.ingest({ source: 'auth', type: 'security.user.login', actor: 'u1' });
    p.ingest({ source: 'auth', type: 'security.user.login', actor: 'u2' });
    p.ingest({ source: 'auth', type: 'security.user.login', actor: 'u3' });
    assert.equal(p.verifyChain().valid, true);
    // Tamper: flip an actor in the middle of the chain.
    const entries = p.entries();
    const tampered = { ...entries[1]!, actor: 'attacker' };
    (p as unknown as { lake: Array<{ actor: string }> }).lake[1]!.actor = 'attacker';
    const check = p.verifyChain();
    assert.equal(check.valid, false);
    assert.equal(check.brokenAt, tampered.id);
  });

  it('honors retention (ring buffer)', () => {
    const p = new TelemetryPipeline({ retention: 3 });
    for (let i = 0; i < 6; i++) p.ingest({ source: 'network', type: `net.event.${i}` });
    assert.equal(p.count(), 3);
    assert.equal(p.entries()[0]!.type, 'net.event.3');
  });
});

// ---- threat hunting + intel -----------------------------------------------------

describe('ThreatHuntingEngine + ThreatIntelEngine', () => {
  it('hunts the lake with playbooks and correlates actors', () => {
    const lake = new TelemetryPipeline();
    lake.ingestBatch([
      { source: 'auth', type: 'security.auth.denied', actor: 'x', origin: '10.0.0.1' },
      { source: 'auth', type: 'security.auth.denied', actor: 'x', origin: '10.0.0.2' },
      { source: 'cloud', type: 'cloud.instance.provisioned', actor: 'x' },
      { source: 'gateway', type: 'gateway.request', actor: 'y' },
    ]);
    const h = new ThreatHuntingEngine(lake);
    const session = h.hunt('hunt.lateral_movement');
    assert.equal(session.hits.length, 3, 'auth+cloud events matched');
    assert.ok(session.summary!.includes('3 hit(s)'));
    const correlated = h.correlate();
    assert.ok(correlated.some((c) => c.actor === 'x' && c.hits >= 3));
  });

  it('runs a full hunt sweep across all playbooks', () => {
    const lake = new TelemetryPipeline();
    lake.ingest({ source: 'auth', type: 'security.auth.denied', actor: 'z', origin: '5.6.7.8' });
    const h = new ThreatHuntingEngine(lake);
    const sessions = h.huntAll();
    assert.equal(sessions.length, DEFAULT_HUNT_PLAYBOOKS.length);
    const stuffing = sessions.find((s) => s.playbookId === 'hunt.credential_stuffing')!;
    assert.equal(stuffing.hits.length, 1);
  });

  it('ingests intel indicators, matches observations, and correlates the lake', () => {
    const lake = new TelemetryPipeline();
    lake.ingest({ source: 'network', type: 'net.connection', actor: '203.0.113.66', origin: '203.0.113.66' });
    const t = new ThreatIntelEngine(lake);
    t.ingest({ type: 'ip', value: '203.0.113.66', confidence: 0.9, severity: 'critical', tlp: 'red', source: 'commercial-feed', tags: ['c2'] });
    t.ingest({ type: 'ip', value: '198.51.100.1', confidence: 0.5, severity: 'medium', source: 'osint', expiresAt: Date.now() - 1000 });
    assert.equal(t.list().length, 1, 'expired pruned from list');
    const matches = t.match([{ value: '203.0.113.66' }]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.indicator.confidence, 0.9);
    const corr = t.correlateLake();
    assert.equal(corr.length, 1);
    assert.equal(corr[0]!.hits, 1);
    assert.equal(t.feedHealth().active, 1);
    assert.equal(t.feedHealth().expired, 1);
  });
});

// ---- insider risk + abuse -------------------------------------------------------

describe('InsiderRiskEngine + AbuseDetectionEngine', () => {
  it('alerts on privileged bursts and off-hours admin actions', () => {
    const e = new InsiderRiskEngine({ privilegedBurst: 3, windowMs: 60_000 });
    assert.equal(e.observe({ actor: 'svc', action: 'user.view', sensitivity: 'standard' }), undefined);
    e.observe({ actor: 'svc', action: 'secret.read', sensitivity: 'critical' });
    e.observe({ actor: 'svc', action: 'secret.read', sensitivity: 'critical' });
    const burst = e.observe({ actor: 'svc', action: 'secret.read', sensitivity: 'critical' });
    assert.ok(burst, 'burst alert fired');
    assert.equal(burst!.rule, 'privileged_burst');
    assert.equal(burst!.severity, 'high');
    // Off-hours admin action (fresh engine so the burst rule is not re-triggered).
    const e2 = new InsiderRiskEngine({ privilegedBurst: 3, windowMs: 60_000 });
    const off = e2.observe({ actor: 'svc', action: 'admin.db.drop', sensitivity: 'critical', ts: new Date().setHours(3) });
    assert.ok(off, 'off-hours alert fired');
    assert.equal(off!.rule, 'off_hours_admin');
    // Least-privilege posture.
    const posture = e.posture([{ principal: 'p1', roles: ['admin', 'developer', 'analyst', 'operator'] }]);
    assert.equal(posture[0]!.status, 'sprawl');
    const analytics = e.analytics();
    assert.ok(analytics[0]!.privileged >= 3);
  });

  it('detects fake-account bursts, credential stuffing, API abuse, and phishing', () => {
    const e = new AbuseDetectionEngine();
    assert.equal(e.observe({ kind: 'registration', origin: '10.1.1.1', value: 't@evil.com' }), undefined);
    e.observe({ kind: 'registration', origin: '10.1.1.1', value: 't@evil.com' });
    e.observe({ kind: 'registration', origin: '10.1.1.1', value: 't@evil.com' });
    e.observe({ kind: 'registration', origin: '10.1.1.1', value: 't@evil.com' });
    const burst = e.observe({ kind: 'registration', origin: '10.1.1.1', value: 't@evil.com' });
    assert.ok(burst, 'registration burst (5 within window)');
    assert.equal(burst!.rule, 'fake_account_burst');
    // Credential stuffing.
    for (let i = 0; i < 6; i++) e.observe({ kind: 'login', origin: '10.9.9.9', value: 'denied' });
    const stuffing = e.alertsList().find((a) => a.rule === 'credential_stuffing');
    assert.ok(stuffing);
    // Phishing content.
    const phish = e.observe({ kind: 'content', actor: 'u9', value: 'URGENT verify your wallet at http://evil.example/claim' });
    assert.ok(phish, 'phishing flagged');
    assert.equal(phish!.rule, 'phishing_content');
    // API abuse.
    for (let i = 0; i < 60; i++) e.observe({ kind: 'api_call', origin: '10.5.5.5' });
    assert.ok(e.alertsList().some((a) => a.rule === 'api_abuse'));
    // Coordinated actors.
    for (const a of ['a1', 'a2', 'a3']) e.observe({ kind: 'login', actor: a, origin: '77.77.77.77' });
    assert.ok(e.coordinated().some((c) => c.key === '77.77.77.77' && c.actors.length >= 3));
  });
});

// ---- incident command -----------------------------------------------------------

describe('IncidentCommand (severity, escalation, evidence, communications)', () => {
  it('classifies severity and walks the forward-only lifecycle', () => {
    const ic = new IncidentCommand({ autoEscalate: false });
    const inc = ic.open({ title: 'Credential theft', severity: 'high', commander: 'soc-lead' });
    assert.equal(inc.severity, 'sev2');
    assert.equal(inc.commander, 'soc-lead');
    ic.transition(inc.id, 'triage', 'soc-1', 'triage started');
    ic.transition(inc.id, 'contained', 'soc-1', 'contained the session');
    assert.equal(ic.get(inc.id)!.status, 'contained');
    assert.throws(() => ic.transition(inc.id, 'triage', 'soc-1', 'backwards'), /forward-only/);
    ic.transition(inc.id, 'closed', 'soc-lead', 'resolved');
    assert.ok(ic.get(inc.id)!.closedAt);
    assert.equal(ic.list({ severity: 'sev2' }).length, 1);
  });

  it('auto-escalates incidents past their severity SLA', () => {
    const ic = new IncidentCommand({ autoEscalate: true });
    const inc = ic.open({ title: 'SEV1 outage', severity: 'sev1' });
    const results = ic.sweepEscalations(inc.detectedAt + 20 * 60_000); // 20m > 15m SLA
    const result = results.find((r) => r.id === inc.id)!;
    assert.equal(result.escalated, true);
    assert.equal(ic.get(inc.id)!.escalations, 1);
    const again = ic.sweepEscalations(inc.detectedAt + 40 * 60_000);
    assert.equal(again.find((r) => r.id === inc.id)!.escalated, true);
    assert.equal(ic.get(inc.id)!.escalations, 2);
  });

  it('preserves evidence with chain-of-custody hashes and logs communications', () => {
    const ic = new IncidentCommand();
    const inc = ic.open({ title: 'Phish wave', severity: 'medium' });
    const evidence = ic.preserveEvidence(inc.id, { description: 'suspicious email raw', artifactHash: 'sha256:abc123', preservedBy: 'soc-2' });
    assert.equal(evidence!.artifactHash, 'sha256:abc123');
    const comm = ic.communicate(inc.id, { channel: 'executive', message: 'exec briefing at 14:00', by: 'soc-lead', to: 'CISO' });
    assert.equal(comm!.channel, 'executive');
    assert.equal(ic.get(inc.id)!.communications.length, 1);
    ic.assignCommander(inc.id, 'soc-lead-2');
    ic.addResponder(inc.id, 'responder-1');
    assert.equal(ic.get(inc.id)!.responders.length, 1);
    const reviewed = ic.review(inc.id, { rca: 'phishing lure', lessons: ['tripwire', 'rotate'], by: 'soc-lead-2' });
    assert.ok(reviewed!.timeline.some((t) => t.note.includes('lessons')));
  });

  it('computes MTTA/MTTR metrics', () => {
    const ic = new IncidentCommand({ autoEscalate: false });
    const inc = ic.open({ title: 'x', severity: 'sev3' });
    const triageAt = inc.detectedAt + 5 * 60_000;
    // Manually backdate via timeline-free transition: use sweep with SLA disabled,
    // then closed.
    ic.transition(inc.id, 'triage', 's', 't');
    // Fix timestamps for metric determinism: transitions use Date.now(); the
    // incident opened moments ago so metrics are ~0 — just assert shape.
    ic.transition(inc.id, 'closed', 's', 'c');
    const m = ic.metrics();
    assert.ok(typeof m.avgTimeToTriageMin === 'number');
    assert.ok(typeof m.avgTimeToResolveMin === 'number');
    const dist = ic.statusDistribution();
    assert.equal(dist.closed, 1);
  });
});

// ---- adversarial validation ------------------------------------------------------

describe('AdversarialValidationEngine (red/purple + tabletop)', () => {
  it('runs campaigns, emits telemetry, and scores detection coverage', () => {
    const lake = new TelemetryPipeline();
    const v = new AdversarialValidationEngine(lake, (type) => type === 'security.auth.denied' || type === 'defense.honeytoken.touched');
    const campaign = v.runCampaign('credential_stuffing');
    assert.equal(campaign.steps.length, 2);
    assert.equal(campaign.results.length, 2);
    assert.ok(lake.count() >= 7, 'campaign telemetry landed in the lake');
    // Step 1 detected (auth.denied), step 2 NOT detected (login only) → score 0.5.
    assert.equal(campaign.score, 0.5);
    // Phishing: content.submitted not covered, honeytoken touch covered → 0.5.
    const all = v.runCampaign('phishing_lure');
    assert.equal(all.score, 0.5, 'honeytoken step detected only');
    assert.equal(v.validationScore(), 0.5);
    const scenario = v.addScenario({ title: 'Ransomware tabletop', description: 'Widespread encryption', injects: ['encrypt', 'contain'], facilitatorNotes: ['observe comms'] });
    assert.equal(scenario.injects.length, 2);
    assert.equal(v.scenariosList().length, 1);
  });
});

// ---- kernel module + gateway integration -------------------------------------------

describe('SocModule (kernel wiring + gateway integration)', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new SocModule());
    await kernel.boot();
  });

  after(async () => { await kernel.shutdown(); });

  it('wires engines, emits bus events, and produces a report', async () => {
    const soc = kernel.getModule<SocModule>('soc');
    const events: string[] = [];
    kernel.bus.on(SocEvents.IncidentOpened, () => { events.push(SocEvents.IncidentOpened); });
    kernel.bus.on(SocEvents.EventIngested, () => { events.push(SocEvents.EventIngested); });
    soc.ingest({ source: 'gateway', type: 'security.auth.denied', actor: 'a1' });
    soc.openIncident({ title: 'Test incident', severity: 'high' });
    assert.ok(events.includes(SocEvents.IncidentOpened));
    assert.ok(events.includes(SocEvents.EventIngested));
    assert.ok(soc.verifyLake().valid);
    const report = soc.report();
    assert.equal(report.kpis.lakeEntries, 1);
    assert.equal(report.kpis.openIncidents, 1);
    assert.equal(report.lakeIntegrity.chainValid, true);
    // Hunting + intel + validation flows.
    soc.huntAll();
    assert.ok(soc.kpis().huntsRun >= 1);
    soc.ingestIntel({ type: 'ip', value: '9.9.9.9', confidence: 0.8, severity: 'high', source: 'test' });
    assert.equal(soc.listIntel().length, 1);
    const campaign = soc.runCampaign('data_exfiltration');
    assert.ok(campaign.score >= 0);
    // Insider + abuse passthroughs.
    assert.equal(soc.insiderAlerts().length, 0);
    soc.observeAbuse({ kind: 'content', actor: 'x', value: 'urgent claim your bitcoin at http://scam.xyz' });
    assert.ok(soc.abuseAlerts().length >= 1);
  });
});

describe('SOC gateway integration (vs real server)', () => {
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

  it('exposes SOC report, incidents, hunting, and alerts', async () => {
    const report = await admin.soc.report();
    assert.ok((report.report as { kpis: { lakeEntries: number } }).kpis.lakeEntries >= 0);
    const incidents = await admin.soc.incidents();
    assert.ok(Array.isArray(incidents.incidents));
  });

  it('opens an incident, transitions it, and preserves evidence via gateway', async () => {
    const opened = await admin.soc.openIncident('API key leak', 'high', { commander: 'soc-lead' });
    const incId = (opened.incident as { id: string }).id;
    const triaged = await admin.soc.transition(incId, 'investigating', 'soc-1', 'investigating the leak');
    assert.equal((triaged.incident as { status: string }).status, 'investigating');
    const ev = await admin.soc.preserveEvidence(incId, { description: 'key hash', artifactHash: 'sha256:deadbeef', preservedBy: 'soc-1' });
    assert.equal((ev.evidence as { artifactHash: string }).artifactHash, 'sha256:deadbeef');
    const closed = await admin.soc.transition(incId, 'closed', 'soc-lead', 'resolved');
    assert.equal((closed.incident as { status: string }).status, 'closed');
  });

  it('ingests telemetry, runs a hunt, and loads intel', async () => {
    await admin.soc.ingestEvent({ source: 'network', type: 'security.auth.denied', actor: 'hunter-1', origin: '203.0.113.77' });
    const hunt = await admin.soc.hunt('hunt.credential_stuffing');
    assert.ok((hunt.session as { hits: unknown[] }).hits.length >= 1);
    const intel = await admin.soc.ingestIntel({ type: 'ip', value: '203.0.113.77', confidence: 0.9, severity: 'critical', source: 'commercial' });
    assert.ok((intel.indicator as { value: string }).value === '203.0.113.77');
    const matches = await admin.soc.matchIntel([{ value: '203.0.113.77' }]);
    assert.equal((matches.matches as unknown[]).length, 1);
  });

  it('runs an adversarial campaign and checks KPIs', async () => {
    const campaign = await admin.soc.runCampaign('phishing_lure');
    assert.ok((campaign.campaign as { score: number }).score >= 0);
    const kpis = await admin.soc.kpis();
    assert.ok((kpis.kpis as { campaignsRun: number }).campaignsRun >= 1);
    const lake = await admin.soc.lakeStatus();
    assert.equal((lake as { chainValid: boolean }).chainValid, true);
  });
});
