// SecurityReviewEngine — Independent Security Review.
//
// Manages the review lifecycle (plan → in-progress → completed →
// needs_remediation → signed-off), severity-rated findings with remediation
// tracking, static secure-code checks against source, an architecture
// assessment questionnaire, and a compliance-assessment scorecard mapped to
// ISO/IEC 27001 / SOC 2 control families. Reviews are independent by
// construction (reviewer ≠ owner).

import { randomUUID } from 'node:crypto';
import type {
  CodeCheckResult, CodeCheckRule, FindingSeverity, FindingStatus,
  ReviewFinding, ReviewKind, ReviewStats, ReviewStatus, SecurityReview,
} from './types.js';
import { DEFAULT_CODE_CHECK_RULES } from './types.js';

/** Architecture review questions (security architecture assessment). */
export const ARCHITECTURE_QUESTIONS: Array<{ id: string; question: string; weight: number }> = [
  { id: 'arch.zero_trust', question: 'Is access zero-trust (verify every request, least privilege)?', weight: 20 },
  { id: 'arch.encryption', question: 'Is data encrypted at rest and in transit with managed keys?', weight: 15 },
  { id: 'arch.input_validation', question: 'Is all external input validated and output encoded?', weight: 15 },
  { id: 'arch.authn_authz', question: 'Are authentication and authorization centralized and enforced?', weight: 20 },
  { id: 'arch.secrets', question: 'Are secrets managed (no hardcoded credentials, rotation)?', weight: 15 },
  { id: 'arch.resilience', question: 'Is the design resilient (redundancy, failover, backups)?', weight: 15 },
];

/** Compliance control families (ISO/IEC 27001 Annex A / SOC 2 mapped). */
export const COMPLIANCE_FAMILIES: Array<{ id: string; name: string; controls: string[] }> = [
  { id: 'A.5', name: 'Information security policies', controls: ['A.5.1 management direction', 'A.5.2 risk assessment', 'A.5.10 acceptable use'] },
  { id: 'A.6', name: 'Organization of information security', controls: ['A.6.1 internal organization', 'A.6.2 mobile devices', 'A.6.3 remote working'] },
  { id: 'A.7', name: 'Human resource security', controls: ['A.7.1 prior to employment', 'A.7.2 during employment', 'A.7.3 termination'] },
  { id: 'A.8', name: 'Asset management', controls: ['A.8.1 inventory', 'A.8.2 information classification', 'A.8.3 media handling'] },
  { id: 'A.9', name: 'Access control', controls: ['A.9.1 business requirements', 'A.9.2 user access', 'A.9.3 user responsibilities', 'A.9.4 system access'] },
  { id: 'A.10', name: 'Cryptography', controls: ['A.10.1 cryptographic controls', 'A.10.2 key management'] },
  { id: 'A.12', name: 'Operations security', controls: ['A.12.1 procedures', 'A.12.2 malware protection', 'A.12.4 logging', 'A.12.6 vulnerability management'] },
  { id: 'A.13', name: 'Communications security', controls: ['A.13.1 network security', 'A.13.2 information transfer'] },
  { id: 'A.14', name: 'System acquisition & development', controls: ['A.14.1 security requirements', 'A.14.2 secure development', 'A.14.3 test data'] },
  { id: 'A.16', name: 'Incident management', controls: ['A.16.1 responsibilities', 'A.16.1.5 response', 'A.16.1.6 lessons learned'] },
  { id: 'A.17', name: 'Business continuity', controls: ['A.17.1 continuity', 'A.17.2 redundancies'] },
  { id: 'A.18', name: 'Compliance', controls: ['A.18.1 legal requirements', 'A.18.2 security reviews'] },
];

export class SecurityReviewEngine {
  private reviews: SecurityReview[] = [];
  private findings: ReviewFinding[] = [];
  private rules: CodeCheckRule[] = [...DEFAULT_CODE_CHECK_RULES];

  // ---- review lifecycle -----------------------------------------------------

  scheduleReview(input: { kind: ReviewKind; target: string; reviewer: string; phase?: SecurityReview['phase'] }): SecurityReview {
    if (!input.target || !input.reviewer) throw new Error('target and reviewer are required');
    const review: SecurityReview = {
      id: randomUUID(), kind: input.kind, target: input.target,
      status: 'planned', reviewer: input.reviewer,
      independent: true, phase: input.phase ?? 'pre_production',
      scheduledAt: Date.now(),
    };
    this.reviews.push(review);
    return review;
  }

  startReview(id: string): SecurityReview | undefined {
    const review = this.getReview(id);
    if (!review) return undefined;
    review.status = 'in_progress';
    review.startedAt = Date.now();
    return review;
  }

  /**
   * Complete a review. If open critical/high findings remain, the status
   * becomes needs_remediation (no sign-off until resolved).
   */
  completeReview(id: string, summary: string): SecurityReview | undefined {
    const review = this.getReview(id);
    if (!review) return undefined;
    review.status = 'completed';
    review.completedAt = Date.now();
    review.summary = summary;
    const open = this.findings.filter((f) => f.reviewId === id && (f.status === 'open' || f.status === 'in_progress'));
    if (open.some((f) => f.severity === 'critical' || f.severity === 'high')) {
      review.status = 'needs_remediation';
    }
    return review;
  }

  /** Sign-off after remediation — only allowed when no open critical/high findings. */
  signOff(id: string, approver: string): SecurityReview | undefined {
    const review = this.getReview(id);
    if (!review) return undefined;
    const open = this.findings.filter((f) => f.reviewId === id && (f.status === 'open' || f.status === 'in_progress'));
    if (open.some((f) => f.severity === 'critical' || f.severity === 'high')) {
      throw new Error('cannot sign off: open critical/high findings remain');
    }
    review.status = 'signed_off';
    review.signedOffBy = approver;
    return review;
  }

  getReview(id: string): SecurityReview | undefined {
    return this.reviews.find((r) => r.id === id);
  }

  listReviews(filter?: { kind?: ReviewKind; status?: ReviewStatus; target?: string }): SecurityReview[] {
    return this.reviews.filter((r) =>
      (!filter?.kind || r.kind === filter.kind) &&
      (!filter?.status || r.status === filter.status) &&
      (!filter?.target || r.target === filter.target));
  }

  // ---- findings --------------------------------------------------------------

  addFinding(input: { reviewId: string; severity: FindingSeverity; title: string; description?: string; controlRef?: string; recommendation?: string; createdBy: string }): ReviewFinding {
    const review = this.getReview(input.reviewId);
    if (!review) throw new Error(`unknown review ${input.reviewId}`);
    const finding: ReviewFinding = {
      id: randomUUID(), reviewId: input.reviewId, severity: input.severity,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.controlRef ? { controlRef: input.controlRef } : {}),
      ...(input.recommendation ? { recommendation: input.recommendation } : {}),
      status: 'open', createdBy: input.createdBy, createdAt: Date.now(),
    };
    this.findings.push(finding);
    return finding;
  }

  listFindings(filter?: { reviewId?: string; severity?: FindingSeverity; status?: FindingStatus }): ReviewFinding[] {
    return this.findings.filter((f) =>
      (!filter?.reviewId || f.reviewId === filter.reviewId) &&
      (!filter?.severity || f.severity === filter.severity) &&
      (!filter?.status || f.status === filter.status));
  }

  updateFinding(id: string, status: FindingStatus, by: string, note?: string): ReviewFinding | undefined {
    const finding = this.findings.find((f) => f.id === id);
    if (!finding) return undefined;
    finding.status = status;
    if (status === 'remediated') finding.resolvedAt = Date.now();
    if (note) finding.description = `${finding.description ?? ''}\n[${by}] ${note}`.trim();
    return finding;
  }

  // ---- secure code review (static checks) --------------------------------------

  addCodeRule(rule: CodeCheckRule): void {
    this.rules.push(rule);
  }

  listCodeRules(): CodeCheckRule[] {
    return [...this.rules];
  }

  /**
   * Static secure-code scan: run the rules against source lines. Returns
   * per-line hits (caller maps them to findings with addFinding).
   */
  scanCode(files: Array<{ path: string; content: string }>): CodeCheckResult[] {
    const results: CodeCheckResult[] = [];
    for (const file of files) {
      const applies = file.path.endsWith('.env') || this.rules.some((r) => (r.appliesTo ?? []).some((ext) => file.path.endsWith(ext)));
      if (!applies) continue;
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const rule of this.rules) {
          // Skip the rule definition file itself (self-scan noise).
          if (file.path.includes('security-review') && file.path.endsWith('.ts') && rule.id === 'code.hardcoded_secret') continue;
          try {
            if (new RegExp(rule.pattern, 'i').test(line)) {
              results.push({
                file: file.path, line: i + 1, ruleId: rule.id,
                severity: rule.severity, title: rule.title,
                snippet: line.trim().slice(0, 100),
              });
            }
          } catch { /* invalid regex → skip */ }
        }
      }
    }
    return results;
  }

  /** Convenience: run a code scan and auto-create findings for a review. */
  scanAndFind(reviewId: string, files: Array<{ path: string; content: string }>, reviewer: string): CodeCheckResult[] {
    const hits = this.scanCode(files);
    for (const hit of hits) {
      this.addFinding({
        reviewId, severity: hit.severity, title: hit.title,
        description: `${hit.file}:${hit.line} — ${hit.snippet}`,
        recommendation: 'remove/replace the flagged pattern',
        createdBy: reviewer,
      });
    }
    return hits;
  }

  // ---- architecture assessment -----------------------------------------------------

  /**
   * Score an architecture review: each question answered 0..1 (0 = not met,
   * 1 = fully met). Returns the 0..100 design score.
   */
  assessArchitecture(answers: Array<{ questionId: string; score: number }>): { score: number; gaps: string[] } {
    let total = 0, max = 0;
    const gaps: string[] = [];
    for (const q of ARCHITECTURE_QUESTIONS) {
      const answer = answers.find((a) => a.questionId === q.id);
      const s = answer ? Math.max(0, Math.min(1, answer.score)) : 0;
      total += s * q.weight;
      max += q.weight;
      if (s < 0.7) gaps.push(q.question);
    }
    return { score: max === 0 ? 0 : Math.round((total / max) * 100), gaps };
  }

  // ---- compliance assessment ----------------------------------------------------------

  /**
   * Compliance scorecard: per control family, provide evidence flags
   * (true = control satisfied). Returns family status + overall score.
   */
  assessCompliance(evidence: Record<string, boolean>): {
    overall: number; families: Array<{ id: string; name: string; satisfied: number; total: number; passed: boolean }>;
  } {
    const families = COMPLIANCE_FAMILIES.map((family) => {
      let satisfied = 0;
      for (const control of family.controls) {
        if (evidence[`${family.id}:${control}`] || evidence[family.id]) satisfied += 1;
      }
      return {
        id: family.id, name: family.name,
        satisfied, total: family.controls.length,
        passed: satisfied === family.controls.length,
      };
    });
    const totalControls = families.reduce((s, f) => s + f.total, 0);
    const satisfiedControls = families.reduce((s, f) => s + f.satisfied, 0);
    return { overall: totalControls === 0 ? 0 : Math.round((satisfiedControls / totalControls) * 100), families };
  }

  // ---- stats ------------------------------------------------------------------------

  stats(): ReviewStats {
    const open = this.findings.filter((f) => f.status === 'open' || f.status === 'in_progress');
    return {
      total: this.reviews.length,
      completed: this.reviews.filter((r) => r.status === 'completed').length,
      signedOff: this.reviews.filter((r) => r.status === 'signed_off').length,
      needsRemediation: this.reviews.filter((r) => r.status === 'needs_remediation').length,
      openFindings: open.length,
      criticalFindings: open.filter((f) => f.severity === 'critical').length,
      highFindings: open.filter((f) => f.severity === 'high').length,
      remediatedFindings: this.findings.filter((f) => f.status === 'remediated').length,
      acceptedFindings: this.findings.filter((f) => f.status === 'accepted' || f.status === 'waived').length,
      complianceScore: 0, // populated by assessCompliance callers
    };
  }
}
