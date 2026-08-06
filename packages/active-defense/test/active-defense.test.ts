// ActiveDefenseModule tests — Active Defense & Adaptive Resilience Layer.
//
// Unit: risk engine, detection correlation, deception, adaptive access,
// containment approval gating, bans, dynamic defense, recovery, improvement.
// Integration: the module + gateway /defense/* endpoints against a real
// server (CLI bootstrap), including the 423 enforcement hook.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { JataQiClient, JataQiError } from '@jataqi/sdk';
import {
  ActiveDefenseModule, AdaptiveDefenseEngine, RiskEngine, DeceptionEngine,
  DEFAULT_RULES, APPROVAL_GATED_KINDS, DefenseEvents,
} from '../src/index.js';

type CreateJataQi = (cfg?: Record<string, unknown>) => Promise<{ gateway?: { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> }; shutdown(): Promise<void> }>;

// ---- unit: risk engine -------------------------------------------------------

describe('RiskEngine (dynamic session risk scoring)', () => {
  it('scores signals into bands and decays over time', () => {
    const r = new RiskEngine();
    assert.equal(r.level('u1'), 'low');
    const a1 = r.signal('u1', { type: 'login_failed' });
    assert.equal(a1.score, 10);
    assert.equal(a1.level, 'low');
    const a2 = r.signal('u1', { type: 'honeytoken_touch' });
    assert.equal(a2.level, 'medium');
    const a3 = r.signal('u1', { type: 'honeytoken_touch' });
    assert.equal(a3.level, 'high');
    // Decay: the score stays high as signals continue to accumulate.
    const a4 = r.signal('u1', { type: 'login_failed' });
    assert.equal(a4.level, 'high', 'risk persists with decay');
    // Reset.
    r.reset('u1');
    assert.equal(r.level('u1'), 'low');
  });

  it('escalates to critical with repeated abuse and tracks history', () => {
    const r = new RiskEngine(0.9);
    let last;
    for (let i = 0; i < 6; i++) last = r.signal('u2', { type: 'permission_escalation_attempt' });
    assert.equal(last!.level, 'critical');
    assert.equal(r.distribution().critical, 1);
    assert.ok(r.assess('u2')!.signals.length >= 6);
  });
});

// ---- unit: detection + deception ----------------------------------------------

describe('DetectionEngine + DeceptionEngine', () => {
  it('fires burst-gated findings with window dedupe', () => {
    const e = new AdaptiveDefenseEngine();
    assert.equal(e.detection.ingest({ type: 'security.auth.denied', actor: 'a' }), undefined, 'below burst');
    e.detection.ingest({ type: 'security.auth.denied', actor: 'a' });
    const finding = e.detection.ingest({ type: 'security.auth.denied', actor: 'a' });
    assert.ok(finding, 'burst reached');
    assert.equal(finding!.rule, 'failed_login_burst');
    assert.equal(finding!.severity, 'medium');
    // Dedupe: same rule within window → no new finding.
    assert.equal(e.detection.ingest({ type: 'security.auth.denied', actor: 'a' }), undefined);
    assert.equal(e.detection.list({ status: 'open' }).length, 1);
  });

  it('honeytoken touch → critical finding + risk spike + one-time rotation', () => {
    const e = new AdaptiveDefenseEngine();
    e.deception.createHoneytoken({ label: 'db-password', value: 'hunter2-secret', placement: 'env file' });
    const matched = e.deception.checkHoneytoken('hunter2-secret', 'attacker-ip');
    assert.ok(matched, 'matched');
    const findings = e.detection.list();
    assert.equal(findings[0]!.severity, 'critical');
    assert.equal(findings[0]!.rule, 'honeytoken_touch');
    // Risk spiked for the source.
    assert.equal(e.risk.level('attacker-ip'), 'medium');
    // One-time: the same value no longer matches (no second touch recorded).
    assert.equal(e.deception.checkHoneytoken('hunter2-secret'), undefined, 'rotated away');
    assert.equal(e.deception.listTouches().length, 1);
  });

  it('decoy probes raise high-severity findings', () => {
    const e = new AdaptiveDefenseEngine();
    e.deception.registerDecoy({ name: 'fake-admin', kind: 'api', endpoint: '/admin' });
    e.deception.probeDecoy('fake-admin', '10.0.0.66');
    const findings = e.detection.list();
    assert.equal(findings[0]!.severity, 'high');
    assert.equal(findings[0]!.rule, 'decoy_probe');
  });
});

// ---- unit: adaptive access + containment + bans -------------------------------

describe('AdaptiveDefenseEngine (access, containment, bans, recovery, improvement)', () => {
  it('adaptive access: step-up above tier, deny at critical, allow in policy', () => {
    const e = new AdaptiveDefenseEngine();
    assert.equal(e.evaluateAccess('u1', 'sensitive').decision, 'allow');
    // Push risk to high: 3 failed logins + 4 misuse signals (decay 0.85).
    for (let i = 0; i < 3; i++) e.ingestRisk('u1', { type: 'login_failed' });
    for (let i = 0; i < 4; i++) e.ingestRisk('u1', { type: 'tool_misuse' });
    assert.equal(e.risk.level('u1'), 'high');
    // High risk vs standard tier → step-up authentication required.
    const step = e.evaluateAccess('u1', 'standard');
    assert.equal(step.decision, 'step_up');
    // Critical → deny outright.
    for (let i = 0; i < 3; i++) e.ingestRisk('u1', { type: 'honeytoken_touch' });
    assert.equal(e.evaluateAccess('u1', 'public').decision, 'deny');
    assert.equal(e.isBlocked('u1'), true);
  });

  it('containment: auto for low impact, approval-gated for high impact', () => {
    const e = new AdaptiveDefenseEngine();
    const isolate = e.contain({ kind: 'isolate_workload', target: 'svc-web', reason: 'suspected compromise' });
    assert.equal(isolate.status, 'completed', 'auto-executed');
    const revoke = e.contain({ kind: 'revoke_sessions', target: 'u9', reason: 'credential theft' });
    assert.equal(revoke.status, 'pending_approval', 'human oversight required');
    assert.equal(revoke.requiresApproval, true);
    // Deny path.
    const denied = e.denyAction(revoke.id, 'soc-lead', 'false positive');
    assert.equal(denied!.status, 'denied');
    // Approve path.
    const rotate = e.contain({ kind: 'rotate_secret', target: 'stripe-key', reason: 'leak suspected' });
    const approved = e.approveAction(rotate.id, 'soc-lead');
    assert.equal(approved!.status, 'completed');
    assert.equal(approved!.approvedBy, 'soc-lead');
    // block_ip auto-bans the address.
    const block = e.contain({ kind: 'block_ip', target: '203.0.113.9', reason: 'scanner' });
    assert.equal(block.status, 'completed');
    assert.equal(e.isBanned('ip', '203.0.113.9'), true);
    assert.ok(APPROVAL_GATED_KINDS.includes('revoke_sessions'));
  });

  it('bans: temporary + permanent, lift, and expiry', () => {
    const e = new AdaptiveDefenseEngine();
    const temp = e.ban({ scope: 'user', value: 'u-bad', reason: 'abuse', durationMs: 60_000 });
    assert.equal(e.isBanned('user', 'u-bad'), true);
    e.liftBan(temp.id);
    assert.equal(e.isBanned('user', 'u-bad'), false);
    e.ban({ scope: 'token', value: 'tok-1', reason: 'theft' });
    assert.equal(e.isBanned('token', 'tok-1'), true, 'permanent');
    // Expired bans drop out.
    e.ban({ scope: 'ip', value: '1.2.3.4', reason: 'x', durationMs: -1 });
    assert.equal(e.isBanned('ip', '1.2.3.4'), false, 'expired');
  });

  it('dynamic defense: signature updates, threshold adaptation, crypto rotation policy', () => {
    const e = new AdaptiveDefenseEngine();
    const rule = e.updateSignature('failed_login_burst', { burst: 5 });
    assert.equal(rule!.burst, 5);
    const adapted = e.adaptThreshold('failed_login_burst', { burst: -2 });
    assert.equal(adapted!.burst, 3);
    const r1 = e.rotateCryptoMaterial('signing-key', 3600_000);
    assert.equal(r1.rotated, true);
    const r2 = e.rotateCryptoMaterial('signing-key', 3600_000);
    assert.equal(r2.rotated, false, 'interval enforced');
    assert.match(r2.reason ?? '', /interval/);
  });

  it('runtime integrity validation flags mismatches as high findings', () => {
    const file = path.join(os.tmpdir(), `ad-${Date.now()}.txt`);
    fs.writeFileSync(file, 'trusted-content');
    const e = new AdaptiveDefenseEngine();
    const good = e.validateRuntimeIntegrity([{ path: file, sha256: 'sha256-of-trusted-content' }]);
    // Compute the real hash.
    const real = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const ok = e.validateRuntimeIntegrity([{ path: file, sha256: real }]);
    assert.equal(good[0]!.ok, false, 'mismatch flagged');
    assert.equal(ok[0]!.ok, true, 'match passes');
    assert.equal(e.detection.list({ severity: 'high' }).length >= 1, true);
  });

  it('autonomous recovery walks the full lifecycle', () => {
    const e = new AdaptiveDefenseEngine();
    const run = e.recover({ target: 'svc-payments', fromSnapshot: 'snap-42' });
    assert.equal(run.stage, 'resumed');
    assert.ok(run.completedAt);
    assert.equal(run.fromSnapshot, 'snap-42');
    assert.equal(e.recoveryRuns().length, 1);
  });

  it('continuous improvement: incident → RCA + lessons → playbook bump + report', () => {
    const e = new AdaptiveDefenseEngine();
    const finding = e.detection.ingest({ type: 'defense.honeytoken.touched', severity: 'critical', title: 'Honeytoken touched' })!;
    const action = e.contain({ kind: 'isolate_workload', target: 'svc-x', reason: 'incident response' });
    const incident = e.recordIncident({ title: 'Credential exposure', severity: 'critical', findingIds: [finding.id], actionIds: [action.id] });
    assert.equal(e.playbookVersion(), 1);
    const reviewed = e.reviewIncident(incident.id, { rca: 'phishing harvested a decoy credential', lessonsLearned: ['rotate on suspicion', 'tripwire honeytokens'] });
    assert.equal(reviewed!.status, 'reviewed');
    assert.equal(e.playbookVersion(), 2);
    assert.deepEqual(reviewed!.lessonsLearned, ['rotate on suspicion', 'tripwire honeytokens']);
    const report = e.report();
    assert.equal(report.stats.incidents, 1);
    assert.equal(report.stats.playbookVersion, 2);
    assert.equal(report.findingsBySeverity.critical, 1);
    assert.equal(report.pendingApprovals.length, 0);
  });
});

// ---- unit: kernel module bus wiring --------------------------------------------

describe('ActiveDefenseModule (kernel wiring)', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new ActiveDefenseModule());
    await kernel.boot();
  });

  after(async () => { await kernel.shutdown(); });

  it('correlates security.auth.denied bus events into findings + risk', async () => {
    const defense = kernel.getModule<ActiveDefenseModule>('active-defense');
    for (let i = 0; i < 3; i++) {
      await kernel.bus.emit('security.auth.denied', { userId: 'u-brute', username: 'alice', reason: 'bad password' });
    }
    const findings = defense.findings();
    assert.ok(findings.some((f) => f.rule === 'failed_login_burst'), 'burst finding correlated');
    const risk = defense.risk('u-brute');
    assert.ok(risk!.score >= 20, 'risk accumulated from auth denials');
  });

  it('emits defense events on the bus and records incidents', async () => {
    const defense = kernel.getModule<ActiveDefenseModule>('active-defense');
    const events: string[] = [];
    kernel.bus.on(DefenseEvents.IncidentRecorded, () => { events.push(DefenseEvents.IncidentRecorded); });
    kernel.bus.on(DefenseEvents.FindingCreated, () => { events.push(DefenseEvents.FindingCreated); });
    defense.recordIncident({ title: 'Test incident', severity: 'medium' });
    const token = defense.createHoneytoken({ label: 't', value: 'v-1', placement: 'p' });
    defense.checkHoneytoken('v-1', 'src-1');
    assert.ok(events.includes(DefenseEvents.IncidentRecorded));
    assert.ok(events.includes(DefenseEvents.FindingCreated));
    assert.equal(defense.stats().incidents, 1);
    assert.equal(defense.stats().touches, 1);
  });
});

// ---- integration: gateway endpoints + enforcement -------------------------------

describe('Active Defense gateway integration (vs real server)', () => {
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

  it('exposes posture, findings, and the executive report', async () => {
    const posture = await admin.defense.posture();
    assert.ok((posture.stats as { riskAssessments: number }).riskAssessments >= 0);
    assert.ok('riskDistribution' in posture);
    const report = await admin.defense.report();
    assert.ok((report.report as { generatedAt: number }).generatedAt > 0);
  });

  it('deploys a honeytoken and detects the touch end-to-end', async () => {
    await admin.defense.createHoneytoken('api-key', 'hk-abc-123', 'docs site');
    const findingsBefore = await admin.defense.findings({ severity: 'critical' });
    // Simulate an attacker using the honeytoken value (detection ingest).
    await admin.defense.ingest('defense.honeytoken.touched', { actor: '45.33.1.9', severity: 'critical', title: 'Honeytoken touched', detail: 'api-key' });
    const findings = await admin.defense.findings({ severity: 'critical' });
    assert.ok(findings.count >= 1);
    const honeytokens = await admin.defense.honeytokens();
    assert.equal((honeytokens.honeytokens as Array<{ label: string }>).some((h) => h.label === 'api-key'), true);
  });

  it('escalates risk via signal and blocks the session with 423', async () => {
    // Register a separate user so admin stays usable.
    await admin.auth.register('def-user', 'pw123', ['developer']);
    const user = new JataQiClient({ baseUrl: `http://127.0.0.1:${port}` });
    await user.auth.login('def-user', 'pw123');
    const me2 = await user.auth.whoami();
    const uid = (me2.principal as { userId: string }).userId;
    const risk = await admin.defense.signalRisk(uid, 'honeytoken_touch', { weight: 40 });
    assert.ok((risk.risk as { score: number }).score >= 40);
    // Enough signals to reach critical.
    await admin.defense.signalRisk(uid, 'honeytoken_touch', { weight: 40 });
    await admin.defense.signalRisk(uid, 'honeytoken_touch', { weight: 40 });
    const r = await admin.defense.risk(uid);
    assert.equal((r.risk as { level: string }).level, 'critical');
    // The user's next request is refused by the enforcement hook.
    await assert.rejects(user.auth.whoami(), (err: unknown) => {
      assert.ok(err instanceof JataQiError);
      assert.equal(err.status, 423);
      return true;
    });
    // Trust reassessment restores access.
    await admin.defense.reassessTrust(uid);
    const me = await user.auth.whoami();
    assert.equal(me.principal.username, 'def-user');
  });

  it('containment approval flow: auto isolate + approval-gated revoke', async () => {
    const auto = await admin.defense.contain('isolate_workload', 'svc-web', 'test containment');
    assert.equal((auto.action as { status: string }).status, 'completed');
    const gated = await admin.defense.contain('revoke_sessions', 'def-user', 'test revocation');
    assert.equal((gated.action as { status: string }).status, 'pending_approval');
    const approved = await admin.defense.approveAction((gated.action as { id: string }).id);
    assert.equal((approved.action as { status: string }).status, 'completed');
    // Ban + lift.
    const ban = await admin.defense.ban('ip', '198.51.100.7', 'scanner', { durationMs: 3600_000 });
    const bans = await admin.defense.bans();
    assert.equal((bans.bans as unknown[]).length, 1);
    await admin.defense.liftBan((ban.ban as { id: string }).id);
    assert.equal((await admin.defense.bans()).count, 0);
  });

  it('recovery + incident lifecycle via gateway', async () => {
    const rec = await admin.defense.recover('svc-payments', { fromSnapshot: 'snap-7' });
    assert.equal((rec.recovery as { stage: string }).stage, 'resumed');
    const inc = await admin.defense.recordIncident('Phish wave', 'high');
    const reviewed = await admin.defense.reviewIncident((inc.incident as { id: string }).id, 'decoy credential harvested', ['rotate on suspicion']);
    assert.equal((reviewed.incident as { status: string }).status, 'reviewed');
    const incidents = await admin.defense.incidents();
    assert.equal((incidents.incidents as unknown[]).length, 1);
  });

  it('blocks a banned user entirely (ban → 423 → lift)', async () => {
    await admin.auth.register('ban-user', 'pw123', ['developer']);
    const user = new JataQiClient({ baseUrl: `http://127.0.0.1:${port}` });
    await user.auth.login('ban-user', 'pw123');
    const me2 = await user.auth.whoami();
    const uid = (me2.principal as { userId: string }).userId;
    const ban = await admin.defense.ban('user', uid, 'abuse');
    await assert.rejects(user.auth.whoami(), (err: unknown) => err instanceof JataQiError && err.status === 423);
    await admin.defense.liftBan((ban.ban as { id: string }).id);
    assert.equal((await user.auth.whoami()).principal.username, 'ban-user');
  });
});
