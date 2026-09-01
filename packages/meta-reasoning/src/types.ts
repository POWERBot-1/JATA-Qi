import type {
  CommercialActor,
  CommercialAutonomyLevel,
  CommercialEvidence,
  CommercialProvenance,
  ModelReference,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';
import type { SynthesisStatus } from '@jataqi/multi-agent-cognition';

/** A supplied forecast stays a hypothesis until an evidence-backed evaluation is recorded. */
export type MetaForecastStatus = 'OPEN' | 'SCORED' | 'INCONCLUSIVE';

export interface MetaForecast {
  id: string;
  tenantId: string;
  cognitiveStateId: string;
  /** Caller-owned stable identifier; contradictions are only checked within an exact key. */
  claimKey: string;
  claimSummary: string;
  model: ModelReference;
  probability: number;
  confidence: number;
  evidence: CommercialEvidence[];
  assumptions: string[];
  uncertainty: string[];
  privacyClassification: PrivacyClassification;
  status: MetaForecastStatus;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface RecordMetaForecastInput {
  cognitiveStateId: string;
  claimKey: string;
  claimSummary: string;
  model: ModelReference;
  /** Probability that the precisely scoped claim will be supported by later evaluation. */
  probability: number;
  confidence: number;
  evidence: CommercialEvidence[];
  assumptions: string[];
  uncertainty: string[];
  privacyClassification?: PrivacyClassification;
  provenance: CommercialProvenance;
}

/** Evaluation of a forecast, not a blanket proof or refutation of the underlying claim. */
export type ForecastEvaluationOutcome = 'SUPPORTED' | 'NOT_SUPPORTED' | 'INCONCLUSIVE';

export interface ForecastEvaluation {
  id: string;
  tenantId: string;
  forecastId: string;
  outcome: ForecastEvaluationOutcome;
  method: string;
  outcomeSummary: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  scored: boolean;
  /** Squared probability error only when outcome is evidence-backed and binary. */
  brierError?: number;
  absoluteError?: number;
  createdAt: number;
}

export interface EvaluateForecastInput {
  outcome: ForecastEvaluationOutcome;
  method: string;
  outcomeSummary: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export type CalibrationQuality =
  | 'INSUFFICIENT_DATA'
  | 'WELL_CALIBRATED'
  | 'OVERCONFIDENT'
  | 'UNDERCONFIDENT'
  | 'POORLY_CALIBRATED';

/** Historical calibration measured only against supplied scored evaluations. */
export interface CalibrationReport {
  id: string;
  tenantId: string;
  model: ModelReference;
  scoredForecastIds: string[];
  scoredEvaluationIds: string[];
  sampleSize: number;
  minimumSampleSize: number;
  meanForecastProbability?: number;
  observedSupportRate?: number;
  brierScore?: number;
  meanAbsoluteError?: number;
  expectedCalibrationError?: number;
  quality: CalibrationQuality;
  caveats: string[];
  createdAt: number;
}

export interface CalculateCalibrationInput {
  model: ModelReference;
}

export type ModelComparisonStatus = 'INSUFFICIENT_DATA' | 'COMPARABLE';

/** Historical score comparison; it never auto-selects or deploys a model. */
export interface ModelComparison {
  id: string;
  tenantId: string;
  reports: CalibrationReport[];
  status: ModelComparisonStatus;
  ranking: ModelReference[];
  caveats: string[];
  automaticSelection: false;
  createdAt: number;
}

export interface CompareModelsInput {
  models: ModelReference[];
}

export type MetaContradictionKind = 'FORECAST_PROBABILITY_CONFLICT' | 'EVALUATION_OUTCOME_CONFLICT';

/** A retained inconsistency signal; no outcome is silently overwritten. */
export interface MetaContradiction {
  id: string;
  tenantId: string;
  claimKey: string;
  forecastIds: string[];
  evaluationIds: string[];
  kind: MetaContradictionKind;
  summary: string;
  status: 'OPEN';
  createdAt: number;
}

export type MetaAssessmentStatus =
  | 'I_DO_NOT_KNOW'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CONTRADICTION_DETECTED'
  | 'REPRODUCIBILITY_REQUIRED'
  | 'SAFETY_ESCALATED'
  | 'CONDITIONALLY_SUPPORTED'
  | 'HYPOTHESIS_CHALLENGED';

export type MetaAssessmentRecommendation =
  | 'NO_ACTION'
  | 'GATHER_EVIDENCE'
  | 'REQUEST_HUMAN_REVIEW'
  | 'REQUEST_REPRODUCTION'
  | 'ESCALATE_SAFETY'
  | 'KEEP_SEPARATE_GOVERNANCE';

/**
 * Meta-level assessment of a stored multi-agent synthesis. It preserves the
 * source synthesis status and cannot authorize a decision or action.
 */
export interface MetaReasoningAssessment {
  id: string;
  tenantId: string;
  cognitiveStateId: string;
  deliberationId: string;
  synthesisId: string;
  sourceSynthesisStatus: SynthesisStatus;
  status: MetaAssessmentStatus;
  conclusionSummary: string;
  uncertaintySummary: string;
  recommendation: MetaAssessmentRecommendation;
  executionAuthorization: 'NOT_AUTHORIZED';
  createdAt: number;
}

export interface AssessDeliberationInput {
  deliberationId: string;
  /** Optional explicit synthesis; otherwise the latest stored synthesis is assessed. */
  synthesisId?: string;
}

export type AutonomyReductionStatus = 'NO_CHANGE_RECOMMENDED' | 'REDUCTION_RECOMMENDED';

/**
 * Advisory-only calibration response. It can only retain or lower the supplied
 * current autonomy ceiling; it never changes CCP policy or authorizes action.
 */
export interface AutonomyReductionRecommendation {
  id: string;
  tenantId: string;
  calibrationReportId: string;
  model: ModelReference;
  currentAutonomyLevel: CommercialAutonomyLevel;
  recommendedMaximumAutonomyLevel: CommercialAutonomyLevel;
  status: AutonomyReductionStatus;
  reason: string;
  requiresHumanPolicyReview: true;
  executionAuthorization: 'NOT_AUTHORIZED';
  createdAt: number;
}

export interface RecommendAutonomyReductionInput {
  model: ModelReference;
  currentAutonomyLevel: CommercialAutonomyLevel;
}

export interface MetaReasoningConfig {
  /** Minimum scored forecasts before a calibration quality label is available. Default 5; bounded 3–50. */
  minimumCalibrationSampleSize?: number;
}

export const MetaReasoningEvents = Object.freeze({
  ForecastRecorded: 'jqb.meta_reasoning.forecast.recorded',
  ForecastEvaluated: 'jqb.meta_reasoning.forecast.evaluated',
  ContradictionDetected: 'jqb.meta_reasoning.contradiction.detected',
  CalibrationCalculated: 'jqb.meta_reasoning.calibration.calculated',
  ModelsCompared: 'jqb.meta_reasoning.models.compared',
  DeliberationAssessed: 'jqb.meta_reasoning.deliberation.assessed',
  AutonomyReductionRecommended: 'jqb.meta_reasoning.autonomy_reduction.recommended',
} as const);

export type { CommercialActor };
