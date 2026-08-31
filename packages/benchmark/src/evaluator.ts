// Continuous Evaluation Gates and Hallucination Error Engine.

import type { BenchmarkReport, EvaluationGateConfig } from './types.js';

export class ContinuousEvaluator {
  evaluateGate(report: BenchmarkReport, config: EvaluationGateConfig): { promoted: boolean; violations: string[] } {
    const violations: string[] = [];

    if (report.accuracyRate < config.minAccuracyRate) {
      violations.push(`Accuracy rate ${report.accuracyRate} is below required threshold ${config.minAccuracyRate}`);
    }

    if (report.avgLatencyMs > config.maxAvgLatencyMs) {
      violations.push(`Average latency ${report.avgLatencyMs}ms exceeds max threshold ${config.maxAvgLatencyMs}ms`);
    }

    const errorRate = 1.0 - report.accuracyRate;
    if (errorRate > config.maxErrorRate) {
      violations.push(`Error rate ${errorRate} exceeds max threshold ${config.maxErrorRate}`);
    }

    for (const cat of config.requiredCategories) {
      const catScore = report.categoryScores[cat];
      if (catScore && catScore.score < 0.8) {
        violations.push(`Category '${cat}' score ${catScore.score} is below required minimum 0.8`);
      }
    }

    return {
      promoted: violations.length === 0,
      violations,
    };
  }
}

export class HallucinationEngine {
  validateClaim(claim: string, evidenceContext: string[]): { supported: boolean; confidence: number; message: string } {
    if (!claim || claim.trim().length === 0) {
      return { supported: false, confidence: 0.0, message: 'I DON\'T KNOW. Insufficient input.' };
    }

    const lowerClaim = claim.toLowerCase();
    const matchingEvidence = evidenceContext.filter((ctx) => {
      const lowerCtx = ctx.toLowerCase();
      const words = lowerClaim.split(/\s+/).filter((w) => w.length > 3);
      if (words.length === 0) return false;
      const matched = words.filter((w) => lowerCtx.includes(w));
      return matched.length / words.length >= 0.4;
    });

    if (matchingEvidence.length === 0) {
      return {
        supported: false,
        confidence: 0.2,
        message: 'I DON\'T KNOW. The claim is unsupported by available evidence.',
      };
    }

    return {
      supported: true,
      confidence: 0.95,
      message: 'Claim verified and supported by source evidence.',
    };
  }
}
