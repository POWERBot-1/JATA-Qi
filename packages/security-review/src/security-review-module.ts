// SecurityReviewModule — kernel module for Independent Security Review.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { SecurityReviewEngine } from './engine.js';
import type {
  CodeCheckResult, CodeCheckRule, FindingSeverity, FindingStatus,
  ReviewFinding, ReviewKind, ReviewStats, ReviewStatus, SecurityReview,
} from './types.js';

export const SecurityReviewEvents = Object.freeze({
  ReviewScheduled: 'review.scheduled',
  ReviewCompleted: 'review.completed',
  ReviewSignedOff: 'review.signed_off',
  FindingAdded: 'review.finding.added',
  FindingRemediated: 'review.finding.remediated',
  CriticalFinding: 'review.finding.critical',
  CodeScanHit: 'review.code_scan.hit',
} as const);

export class SecurityReviewModule implements IModule {
  readonly id = 'security-review';
  readonly tags = ['core', 'security', 'governance'] as const;
  readonly dependsOn = [] as const;

  readonly engine = new SecurityReviewEngine();
  private api!: KernelApi;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('security-review', this);
    kernel.logger.info('security-review module initialized (independent security review)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* stateless */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  scheduleReview(input: { kind: ReviewKind; target: string; reviewer: string; phase?: SecurityReview['phase'] }): SecurityReview {
    const review = this.engine.scheduleReview(input);
    void this.api?.bus.emit(SecurityReviewEvents.ReviewScheduled, { id: review.id, kind: review.kind, target: review.target });
    return review;
  }
  startReview(id: string) { return this.engine.startReview(id); }
  completeReview(id: string, summary: string): SecurityReview | undefined {
    const review = this.engine.completeReview(id, summary);
    if (review) void this.api?.bus.emit(SecurityReviewEvents.ReviewCompleted, { id: review.id, status: review.status });
    return review;
  }
  signOff(id: string, approver: string): SecurityReview | undefined {
    const review = this.engine.signOff(id, approver);
    if (review) void this.api?.bus.emit(SecurityReviewEvents.ReviewSignedOff, { id: review.id, approver });
    return review;
  }
  getReview(id: string) { return this.engine.getReview(id); }
  listReviews(filter?: { kind?: ReviewKind; status?: ReviewStatus; target?: string }) { return this.engine.listReviews(filter); }

  addFinding(input: { reviewId: string; severity: FindingSeverity; title: string; description?: string; controlRef?: string; recommendation?: string; createdBy: string }): ReviewFinding {
    const finding = this.engine.addFinding(input);
    void this.api?.bus.emit(SecurityReviewEvents.FindingAdded, { id: finding.id, reviewId: finding.reviewId, severity: finding.severity });
    if (finding.severity === 'critical') void this.api?.bus.emit(SecurityReviewEvents.CriticalFinding, { id: finding.id, title: finding.title });
    return finding;
  }
  listFindings(filter?: { reviewId?: string; severity?: FindingSeverity; status?: FindingStatus }) { return this.engine.listFindings(filter); }
  updateFinding(id: string, status: FindingStatus, by: string, note?: string): ReviewFinding | undefined {
    const finding = this.engine.updateFinding(id, status, by, note);
    if (finding && status === 'remediated') void this.api?.bus.emit(SecurityReviewEvents.FindingRemediated, { id: finding.id });
    return finding;
  }

  addCodeRule(rule: CodeCheckRule): void { this.engine.addCodeRule(rule); }
  listCodeRules() { return this.engine.listCodeRules(); }
  scanCode(files: Array<{ path: string; content: string }>): CodeCheckResult[] {
    const hits = this.engine.scanCode(files);
    for (const h of hits) void this.api?.bus.emit(SecurityReviewEvents.CodeScanHit, { file: h.file, line: h.line, severity: h.severity });
    return hits;
  }
  scanAndFind(reviewId: string, files: Array<{ path: string; content: string }>, reviewer: string): CodeCheckResult[] {
    return this.engine.scanAndFind(reviewId, files, reviewer);
  }

  assessArchitecture(answers: Array<{ questionId: string; score: number }>) { return this.engine.assessArchitecture(answers); }
  assessCompliance(evidence: Record<string, boolean>) { return this.engine.assessCompliance(evidence); }

  stats(): ReviewStats { return this.engine.stats(); }
}
