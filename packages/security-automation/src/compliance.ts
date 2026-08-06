// Compliance evidence reporting — ISO/IEC 27001 / SOC 2.
//
// Builds a per-control-family evidence report by combining the SOC security
// data lake (telemetry evidence), the security-review compliance scorecard,
// resilience availability/failover records, supply-chain audits, and
// infrastructure compliance baselines. Produces JSON + Markdown exports for
// audit readiness.

import { COMPLIANCE_FAMILIES } from '@jataqi/security-review';
import type { LakeEntry } from '@jataqi/soc';

export interface ComplianceFamilyReport {
  id: string;
  name: string;
  controls: string[];
  /** Auto-derived evidence items from the security lake (max 5 shown). */
  evidenceItems: string[];
  evidenceCount: number;
  /** Satisfied via review scorecard or strong lake evidence. */
  satisfied: boolean;
  /** 0..100 per-family evidence coverage. */
  coverage: number;
}

export interface ComplianceReportResult {
  generatedAt: number;
  standard: string;
  overall: number;
  families: ComplianceFamilyReport[];
  /** Source systems that contributed evidence. */
  sources: string[];
  /** Free-text notes for the audit file. */
  notes: string[];
}

export interface ComplianceInputs {
  lake: LakeEntry[];
  /** review.assessCompliance-style evidence flags per family id. */
  reviewEvidence?: Record<string, boolean>;
  /** True if a security review compliance assessment was run. */
  reviewRun?: boolean;
  availabilityHealthy?: number;
  availabilityTotal?: number;
  failovers?: number;
  supplyChainVulnerable?: number;
  supplyChainAudits?: number;
  infraComplianceRate?: number;
  incidentCount?: number;
  huntSweeps?: number;
}

/** Map ISO families to the lake event types that evidence them. */
const FAMILY_EVIDENCE_PATTERNS: Record<string, string[]> = {
  'A.5': ['security.audit', 'security.user.registered'],
  'A.6': ['security.session', 'audit.action'],
  'A.7': ['security.user.registered'],
  'A.8': ['audit.export'],
  'A.9': ['security.user.login', 'security.auth.denied', 'security.permission.denied'],
  'A.10': ['defense.crypto.rotated'],
  'A.12': ['tool.invoked', 'tool.failed', 'supplychain.dependency.vulnerable'],
  'A.13': ['network.connection'],
  'A.14': ['review.scheduled', 'code_scan'],
  'A.16': ['soc.incident', 'defense.finding.created'],
  'A.17': ['resilience.failover', 'resilience.availability'],
  'A.18': ['compliance', 'review.completed'],
};

export class ComplianceReportBuilder {
  build(input: ComplianceInputs): ComplianceReportResult {
    const families: ComplianceFamilyReport[] = [];
    let totalCoverage = 0;
    for (const family of COMPLIANCE_FAMILIES) {
      const patterns = FAMILY_EVIDENCE_PATTERNS[family.id] ?? [];
      const matched = input.lake.filter((e) => patterns.some((p) => e.type.includes(p)));
      const evidenceItems = [...new Set(matched.map((e) => `${e.type}@${new Date(e.ts).toISOString()}`))].slice(0, 5);
      const evidenceCount = matched.length;
      const reviewSatisfied = input.reviewEvidence?.[family.id] === true;
      // Coverage: review scorecard counts 100%; otherwise lake evidence scaled.
      let coverage = reviewSatisfied ? 100 : 0;
      if (!reviewSatisfied && evidenceCount > 0) coverage = Math.min(90, 30 + evidenceCount * 15);
      const satisfied = reviewSatisfied || evidenceCount >= 3;
      families.push({
        id: family.id, name: family.name, controls: family.controls,
        evidenceItems, evidenceCount, satisfied, coverage,
      });
      totalCoverage += coverage;
    }
    const overall = Math.round(totalCoverage / Math.max(1, families.length));
    const notes: string[] = [];
    if (input.reviewRun) notes.push('Independent compliance assessment executed (security-review scorecard).');
    if (input.availabilityTotal) notes.push(`Availability: ${input.availabilityHealthy}/${input.availabilityTotal} workloads within SLO; ${input.failovers ?? 0} automated failover(s) exercised.`);
    if (input.supplyChainAudits) notes.push(`Supply chain: ${input.supplyChainAudits} lockfile audit(s); ${input.supplyChainVulnerable ?? 0} vulnerable dependencies currently open.`);
    if (input.infraComplianceRate !== undefined) notes.push(`Infrastructure hardening baseline: ${input.infraComplianceRate}% pass rate.`);
    if (input.incidentCount !== undefined) notes.push(`Incident management: ${input.incidentCount} incident(s) recorded in the SOC command framework.`);
    if (input.huntSweeps !== undefined) notes.push(`Threat hunting: ${input.huntSweeps} continuous hunt sweep(s) executed.`);
    return {
      generatedAt: Date.now(),
      standard: 'ISO/IEC 27001 Annex A (SOC 2 mapped)',
      overall,
      families,
      sources: ['security data lake', 'security-review assessments', 'resilience availability', 'supply-chain audits', 'infrastructure compliance', 'SOC incidents', 'threat hunts'],
      notes,
    };
  }

  /** JSON export for audit files. */
  toJson(report: ComplianceReportResult): string {
    return JSON.stringify(report, null, 2);
  }

  /** Markdown export for the audit package / executive summary. */
  toMarkdown(report: ComplianceReportResult): string {
    const lines: string[] = [
      `# Compliance Evidence Report — ${report.standard}`,
      '',
      `Generated: ${new Date(report.generatedAt).toISOString()}`,
      `Overall readiness: **${report.overall}/100**`,
      '',
      '| Family | Controls | Evidence | Coverage | Status |',
      '| ------ | -------- | -------- | -------- | ------ |',
    ];
    for (const f of report.families) {
      lines.push(`| ${f.id} ${f.name} | ${f.controls.length} | ${f.evidenceCount} | ${f.coverage}% | ${f.satisfied ? '✅' : '⬜'} |`);
    }
    lines.push('', '## Evidence notes', '');
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push('', '## Sources', '');
    for (const s of report.sources) lines.push(`- ${s}`);
    return lines.join('\n');
  }
}
