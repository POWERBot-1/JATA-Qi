// Risk engine — dynamic, continuously reassessed per-session risk scoring.

import type { RiskAssessment, RiskLevel, RiskSignal } from './types.js';

export const SIGNAL_WEIGHTS: Record<string, number> = {
  login_failed: 10,
  login_new_device: 15,
  login_unusual_hour: 8,
  honeytoken_touch: 40,
  decoy_probe: 30,
  tool_misuse: 18,
  blocked_request: 12,
  permission_escalation_attempt: 25,
  api_abuse: 16,
  session_anomaly: 20,
};

export const RISK_BANDS: Array<{ level: RiskLevel; min: number }> = [
  { level: 'critical', min: 85 },
  { level: 'high', min: 60 },
  { level: 'medium', min: 30 },
  { level: 'low', min: 0 },
];

export function riskLevel(score: number): RiskLevel {
  for (const band of RISK_BANDS) if (score >= band.min) return band.level;
  return 'low';
}

/** Per-user risk engine: signals accumulate into a 0..100 score with decay. */
export class RiskEngine {
  private assessments = new Map<string, RiskAssessment>();
  /** Decay factor applied on each reassessment (older signals fade). */
  private readonly decay: number;

  constructor(decay = 0.85) {
    this.decay = decay;
  }

  /**
   * Add a signal for a user and reassess. Returns the updated assessment.
   * Scores decay on every reassessment, so a user returns to baseline once
   * the suspicious activity stops.
   */
  signal(userId: string, signal: RiskSignal): RiskAssessment {
    const prev = this.assessments.get(userId);
    const base = prev ? prev.score * this.decay : 0;
    const weight = signal.weight ?? SIGNAL_WEIGHTS[signal.type] ?? 5;
    const score = Math.min(100, Math.round(base + weight));
    const signals = [...(prev?.signals ?? []), { ...signal, ts: signal.ts ?? Date.now() }].slice(-25);
    const assessment: RiskAssessment = {
      userId, score, level: riskLevel(score), signals, updatedAt: Date.now(),
    };
    this.assessments.set(userId, assessment);
    return assessment;
  }

  assess(userId: string): RiskAssessment | undefined {
    return this.assessments.get(userId);
  }

  /** Current level for a user (low when unknown). */
  level(userId: string): RiskLevel {
    return this.assessments.get(userId)?.level ?? 'low';
  }

  reset(userId: string): void {
    this.assessments.delete(userId);
  }

  all(): RiskAssessment[] {
    return [...this.assessments.values()];
  }

  distribution(): Record<RiskLevel, number> {
    const out: Record<RiskLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const a of this.assessments.values()) out[a.level] += 1;
    return out;
  }
}
