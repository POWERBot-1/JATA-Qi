// SecurityReviewModule tests — Independent Security Review.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { JataQiClient } from '@jataqi/sdk';
import {
  SecurityReviewModule, SecurityReviewEngine, SecurityReviewEvents,
  ARCHITECTURE_QUESTIONS, COMPLIANCE_FAMILIES, DEFAULT_CODE_CHECK_RULES,
} from '../src/index.js';

type CreateJataQi = (cfg?: Record<string, unknown>) => Promise<{ gateway?: { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> }; shutdown(): Promise<void> }>;

describe('SecurityReviewEngine (review lifecycle + sign-off gates)', () => {
  it('schedules, starts, completes, and signs off a review', () => {
    const e = new SecurityReviewEngine();
    const review = e.scheduleReview({ kind: 'architecture', target: 'api-gateway', reviewer: 'ext-auditor' });
    assert.equal(review.status, 'planned');
    assert.equal(review.independent, true, 'reviewer ≠ owner by construction');
    e.startReview(review.id);
    assert.equal(e.getReview(review.id)!.status, 'in_progress');
    e.completeReview(review.id, 'no critical findings');
    assert.equal(e.getReview(review.id)!.status, 'completed');
    e.signOff(review.id, 'ciso');
    assert.equal(e.getReview(review.id)!.status, 'signed_off');
    assert.equal(e.getReview(review.id)!.signedOffBy, 'ciso');
    assert.equal(e.listReviews({ status: 'signed_off' }).length, 1);
  });

  it('blocks sign-off while critical/high findings are open', () => {
    const e = new SecurityReviewEngine();
    const review = e.scheduleReview({ kind: 'code', target: 'auth-service', reviewer: 'sec-reviewer' });
    e.startReview(review.id);
    e.addFinding({ reviewId: review.id, severity: 'critical', title: 'Hardcoded signing key', createdBy: 'sec-reviewer' });
    e.completeReview(review.id, 'found issues');
    assert.equal(e.getReview(review.id)!.status, 'needs_remediation', 'auto status');
    assert.throws(() => e.signOff(review.id, 'ciso'), /cannot sign off/);
    // Remediate → sign-off allowed.
    const finding = e.listFindings({ reviewId: review.id })[0]!;
    e.updateFinding(finding.id, 'remediated', 'dev-lead', 'rotated key into vault');
    e.signOff(review.id, 'ciso');
    assert.equal(e.getReview(review.id)!.status, 'signed_off');
  });

  it('accepts findings as waived with justification (risk acceptance)', () => {
    const e = new SecurityReviewEngine();
    const review = e.scheduleReview({ kind: 'infrastructure', target: 'legacy-proxy', reviewer: 'auditor' });
    const finding = e.addFinding({ reviewId: review.id, severity: 'low', title: 'Deprecated TLS cipher offered', createdBy: 'auditor' });
    e.updateFinding(finding.id, 'waived', 'risk-owner', 'legacy client compatibility; mitigated by network ACL');
    assert.equal(e.listFindings({ status: 'waived' }).length, 1);
  });
});

describe('SecurityReviewEngine (secure code review + architecture + compliance)', () => {
  it('scans source for insecure patterns with severity ratings', () => {
    const e = new SecurityReviewEngine();
    const hits = e.scanCode([
      { path: 'src/auth.ts', content: 'const apiKey = "sk_live_1234567890123456";\nfunction run() { eval(userInput); }' },
      { path: 'src/db.ts', content: 'const q = "SELECT * FROM users WHERE id = " + userId;' },
      { path: 'src/ok.ts', content: 'const x = 1;' },
      { path: '.env', content: "DB_PASSWORD='supersecretvalue12345'" },
    ]);
    assert.ok(hits.some((h) => h.ruleId === 'code.hardcoded_secret' && h.severity === 'critical'));
    assert.ok(hits.some((h) => h.ruleId === 'code.eval' && h.severity === 'high'));
    assert.ok(hits.some((h) => h.ruleId === 'code.sql_concat'));
    assert.ok(hits.some((h) => h.file === '.env'));
    assert.equal(hits.some((h) => h.file.includes('ok.ts')), false);
    assert.ok(DEFAULT_CODE_CHECK_RULES.length >= 6);
  });

  it('auto-creates findings from a code scan on a review', () => {
    const e = new SecurityReviewEngine();
    const review = e.scheduleReview({ kind: 'code', target: 'worker', reviewer: 'sec' });
    e.startReview(review.id);
    const hits = e.scanAndFind(review.id, [
      { path: 'src/worker.ts', content: 'const secret = "abcd1234wxyz5678";\nchild_process.execSync("curl http://x");' },
    ], 'sec');
    assert.ok(hits.length >= 2);
    const findings = e.listFindings({ reviewId: review.id });
    assert.ok(findings.some((f) => f.severity === 'critical'));
    assert.ok(findings.some((f) => f.severity === 'high'));
    assert.ok(findings.every((f) => f.status === 'open'));
  });

  it('scores architecture assessments against the questionnaire', () => {
    const e = new SecurityReviewEngine();
    const good = e.assessArchitecture([
      { questionId: 'arch.zero_trust', score: 1 }, { questionId: 'arch.encryption', score: 1 },
      { questionId: 'arch.input_validation', score: 1 }, { questionId: 'arch.authn_authz', score: 1 },
      { questionId: 'arch.secrets', score: 1 }, { questionId: 'arch.resilience', score: 1 },
    ]);
    assert.equal(good.score, 100);
    assert.deepEqual(good.gaps, []);
    const weak = e.assessArchitecture([
      { questionId: 'arch.zero_trust', score: 0.2 }, { questionId: 'arch.encryption', score: 0.9 },
      { questionId: 'arch.input_validation', score: 0.5 }, { questionId: 'arch.authn_authz', score: 1 },
      { questionId: 'arch.secrets', score: 0.1 }, { questionId: 'arch.resilience', score: 1 },
    ]);
    assert.ok(weak.score < 70);
    assert.ok(weak.gaps.some((g) => g.includes('zero-trust')));
    assert.ok(weak.gaps.some((g) => g.includes('secrets')));
    assert.equal(ARCHITECTURE_QUESTIONS.length, 6);
  });

  it('produces a compliance scorecard mapped to ISO 27001 control families', () => {
    const e = new SecurityReviewEngine();
    const evidence: Record<string, boolean> = {};
    for (const family of COMPLIANCE_FAMILIES) evidence[family.id] = true;
    // Drop A.16 (incident management) → gap.
    delete evidence['A.16'];
    const result = e.assessCompliance(evidence);
    assert.ok(result.overall > 85 && result.overall < 100);
    const incident = result.families.find((f) => f.id === 'A.16')!;
    assert.equal(incident.passed, false);
    assert.equal(result.families.length, COMPLIANCE_FAMILIES.length);
    // Full evidence → 100.
    const full = e.assessCompliance(Object.fromEntries(COMPLIANCE_FAMILIES.map((f) => [f.id, true])));
    assert.equal(full.overall, 100);
  });

  it('aggregates review stats', () => {
    const e = new SecurityReviewEngine();
    const r = e.scheduleReview({ kind: 'independent_audit', target: 'platform', reviewer: 'ext' });
    e.startReview(r.id);
    e.addFinding({ reviewId: r.id, severity: 'high', title: 'X', createdBy: 'ext' });
    e.completeReview(r.id, 'audit done');
    const s = e.stats();
    assert.equal(s.total, 1);
    assert.equal(s.needsRemediation, 1);
    assert.equal(s.openFindings, 1);
    assert.equal(s.highFindings, 1);
  });
});

describe('SecurityReviewModule (kernel wiring)', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new SecurityReviewModule());
    await kernel.boot();
  });

  after(async () => { await kernel.shutdown(); });

  it('emits review events and wires the full surface', async () => {
    const mod = kernel.getModule<SecurityReviewModule>('security-review');
    const events: string[] = [];
    kernel.bus.on(SecurityReviewEvents.ReviewScheduled, () => { events.push(SecurityReviewEvents.ReviewScheduled); });
    kernel.bus.on(SecurityReviewEvents.CriticalFinding, () => { events.push(SecurityReviewEvents.CriticalFinding); });
    const review = mod.scheduleReview({ kind: 'ai_safety', target: 'tanya', reviewer: 'ai-auditor' });
    mod.startReview(review.id);
    mod.addFinding({ reviewId: review.id, severity: 'critical', title: 'Prompt injection escape', createdBy: 'ai-auditor' });
    assert.ok(events.includes(SecurityReviewEvents.ReviewScheduled));
    assert.ok(events.includes(SecurityReviewEvents.CriticalFinding));
    assert.equal(mod.stats().criticalFindings, 1);
    // Code scan bus events.
    const hits = mod.scanCode([{ path: 'x.ts', content: 'eval(x)' }]);
    assert.ok(hits.length >= 1);
  });
});

describe('Security review gateway integration (vs real server)', () => {
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

  it('schedules a review, finds an issue, remediates, and signs off end-to-end', async () => {
    const review = await admin.review.schedule('code', 'payments-svc', 'ext-auditor');
    const reviewId = (review.review as { id: string }).id;
    await admin.review.start(reviewId);
    const finding = await admin.review.addFinding(reviewId, 'high', 'Hardcoded DB password', { createdBy: 'ext-auditor', recommendation: 'use vault' });
    const findingId = (finding.finding as { id: string }).id;
    const completed = await admin.review.complete(reviewId, 'pre-production code review');
    assert.equal((completed.review as { status: string }).status, 'needs_remediation');
    // Sign-off blocked.
    await assert.rejects(admin.review.signOff(reviewId, 'ciso'));
    await admin.review.updateFinding(findingId, 'remediated', 'dev-lead', 'moved to vault');
    const signed = await admin.review.signOff(reviewId, 'ciso');
    assert.equal((signed.review as { status: string }).status, 'signed_off');
    const stats = await admin.review.stats();
    assert.equal((stats.stats as { remediatedFindings: number }).remediatedFindings, 1);
  });

  it('runs a code scan and compliance assessment via the gateway', async () => {
    const scan = await admin.review.scanCode([{ path: 'src/app.ts', content: 'const token = "abc123def456ghi789";' }]);
    assert.ok((scan.hits as unknown[]).length >= 1);
    const compliance = await admin.review.compliance({ 'A.5': true, 'A.6': true });
    assert.ok(((compliance as { assessment: { overall: number } }).assessment).overall > 0);
  });
});
