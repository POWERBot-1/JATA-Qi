import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CognitiveKernelModule } from '@jataqi/cognitive-kernel';
import type { CognitiveKernelService } from '@jataqi/cognitive-kernel';
import { MultiAgentCognitionModule } from '@jataqi/multi-agent-cognition';
import type { MultiAgentCognitionService, SynthesisStatus } from '@jataqi/multi-agent-cognition';
import type {
  CommercialActor,
  CommercialAutonomyLevel,
  CommercialEvidence,
  CommercialProvenance,
  ModelReference,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';
import {
  MetaReasoningEvents,
  type AssessDeliberationInput,
  type AutonomyReductionRecommendation,
  type CalibrationQuality,
  type CalibrationReport,
  type CalculateCalibrationInput,
  type CompareModelsInput,
  type ForecastEvaluation,
  type ForecastEvaluationOutcome,
  type MetaAssessmentRecommendation,
  type MetaAssessmentStatus,
  type MetaContradiction,
  type MetaForecast,
  type MetaReasoningAssessment,
  type MetaReasoningConfig,
  type ModelComparison,
  type RecordMetaForecastInput,
  type RecommendAutonomyReductionInput,
} from './types.js';

const FORECASTS_COLLECTION = 'meta-reasoning.forecasts';
const EVALUATIONS_COLLECTION = 'meta-reasoning.evaluations';
const CALIBRATIONS_COLLECTION = 'meta-reasoning.calibrations';
const COMPARISONS_COLLECTION = 'meta-reasoning.comparisons';
const CONTRADICTIONS_COLLECTION = 'meta-reasoning.contradictions';
const ASSESSMENTS_COLLECTION = 'meta-reasoning.assessments';
const AUTONOMY_RECOMMENDATIONS_COLLECTION = 'meta-reasoning.autonomy-recommendations';

const MIN_CALIBRATION_SAMPLE_SIZE = 3;
const MAX_CALIBRATION_SAMPLE_SIZE = 50;
const MAX_EVIDENCE = 100;
const MAX_TEXT_LIST = 20;
const EVIDENCE_STATUSES = new Set<CommercialEvidence['status']>([
  'UNVERIFIED',
  'PARTIAL',
  'OBSERVED',
  'MEASURED',
  'CUSTOMER_CONFIRMED',
  'DEMONSTRATED',
  'REPEATED',
  'VERIFIED',
  'ESTIMATED',
  'ASSUMPTION',
  'PREDICTION',
  'STALE',
  'CONFLICTING',
  'UNAVAILABLE',
]);
const STRONG_EVIDENCE = new Set<CommercialEvidence['status']>(['MEASURED', 'CUSTOMER_CONFIRMED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED']);
const PRIVACY_CLASSIFICATIONS = new Set<PrivacyClassification>(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'PERSONAL_DATA']);
const MODEL_EVALUATION_STATUSES = new Set<NonNullable<ModelReference['evaluationStatus']>>(['UNASSESSED', 'TESTED', 'MONITORED', 'DEGRADED', 'RETIRED']);
const FORECAST_OUTCOMES = new Set<ForecastEvaluationOutcome>(['SUPPORTED', 'NOT_SUPPORTED', 'INCONCLUSIVE']);

export class MetaReasoningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaReasoningError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * JQB's classical meta-reasoning registry. It records supplied forecasts and
 * evidence-backed evaluations, computes transparent historical calibration,
 * detects explicit-key contradictions, and emits advisory-only autonomy
 * reduction recommendations. It never invokes a model, changes CCP policy,
 * authorizes an action, or performs any external execution.
 */
export class MetaReasoningService {
  private api!: KernelApi;
  private cognitive!: CognitiveKernelService;
  private deliberation!: MultiAgentCognitionService;
  private forecasts!: ICollection<MetaForecast>;
  private evaluations!: ICollection<ForecastEvaluation>;
  private calibrations!: ICollection<CalibrationReport>;
  private comparisons!: ICollection<ModelComparison>;
  private contradictions!: ICollection<MetaContradiction>;
  private assessments!: ICollection<MetaReasoningAssessment>;
  private autonomyRecommendations!: ICollection<AutonomyReductionRecommendation>;
  private readonly minimumCalibrationSampleSize: number;

  constructor(config: MetaReasoningConfig = {}) {
    this.minimumCalibrationSampleSize = calibrationSampleSize(config.minimumCalibrationSampleSize);
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.forecasts = await storage.collection<MetaForecast>(FORECASTS_COLLECTION);
    this.evaluations = await storage.collection<ForecastEvaluation>(EVALUATIONS_COLLECTION);
    this.calibrations = await storage.collection<CalibrationReport>(CALIBRATIONS_COLLECTION);
    this.comparisons = await storage.collection<ModelComparison>(COMPARISONS_COLLECTION);
    this.contradictions = await storage.collection<MetaContradiction>(CONTRADICTIONS_COLLECTION);
    this.assessments = await storage.collection<MetaReasoningAssessment>(ASSESSMENTS_COLLECTION);
    this.autonomyRecommendations = await storage.collection<AutonomyReductionRecommendation>(AUTONOMY_RECOMMENDATIONS_COLLECTION);
    this.cognitive = kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService();
    this.deliberation = kernel.getModule<MultiAgentCognitionModule>('multi-agent-cognition').getService();
  }

  /** Record a scoped forecast without interpreting it as a fact or collecting evidence. */
  async recordForecast(actor: CommercialActor, input: RecordMetaForecastInput): Promise<MetaForecast> {
    assertActor(actor);
    validateForecastInput(input);
    const state = await this.cognitive.getState(actor, input.cognitiveStateId);
    if (!state || state.tenantId !== actor.tenantId) {
      throw new MetaReasoningError('A cognitive state from the actor tenant is required for a meta-reasoning forecast.');
    }
    const now = Date.now();
    const forecast: MetaForecast = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      cognitiveStateId: state.id,
      claimKey: requiredText(input.claimKey, 'Forecast claim key', 180),
      claimSummary: requiredText(input.claimSummary, 'Forecast claim summary', 640),
      model: sanitizeModel(input.model),
      probability: probability(input.probability, 'Forecast probability'),
      confidence: percent(input.confidence, 'Forecast confidence'),
      evidence: sanitizeEvidenceList(input.evidence),
      assumptions: textList(input.assumptions, 'Forecast assumptions'),
      uncertainty: textList(input.uncertainty, 'Forecast uncertainty'),
      privacyClassification: privacyClassification(input.privacyClassification),
      status: 'OPEN',
      provenance: sanitizeProvenance(input.provenance),
      createdAt: now,
      updatedAt: now,
    };
    await this.forecasts.put(forecast);
    await this.detectForecastContradictions(forecast);
    await this.api.bus.emit(MetaReasoningEvents.ForecastRecorded, {
      forecastId: forecast.id,
      tenantId: forecast.tenantId,
      claimKey: forecast.claimKey,
      model: modelKey(forecast.model),
      probability: forecast.probability,
    });
    return copy(forecast);
  }

  /**
   * Persist one immutable, supplied evaluation. Binary outcomes require at
   * least one current strong evidence record and never constitute universal
   * proof of the underlying claim.
   */
  async evaluateForecast(actor: CommercialActor, forecastId: string, input: import('./types.js').EvaluateForecastInput): Promise<ForecastEvaluation> {
    assertActor(actor);
    validateEvaluationInput(input);
    const forecast = await this.requireForecast(actor, forecastId);
    if (forecast.status !== 'OPEN') throw new MetaReasoningError('A forecast has already received an immutable evaluation.');
    const evidence = sanitizeEvidenceList(input.evidence);
    if (input.outcome !== 'INCONCLUSIVE') assertBinaryEvaluationEvidence(evidence);
    const target = input.outcome === 'SUPPORTED' ? 1 : input.outcome === 'NOT_SUPPORTED' ? 0 : undefined;
    const brierError = target === undefined ? undefined : square(forecast.probability - target);
    const absoluteError = target === undefined ? undefined : Math.abs(forecast.probability - target);
    const evaluation: ForecastEvaluation = {
      id: randomUUID(),
      tenantId: forecast.tenantId,
      forecastId: forecast.id,
      outcome: input.outcome,
      method: requiredText(input.method, 'Evaluation method', 320),
      outcomeSummary: requiredText(input.outcomeSummary, 'Evaluation outcome summary', 640),
      evidence,
      provenance: sanitizeProvenance(input.provenance),
      scored: target !== undefined,
      brierError,
      absoluteError,
      createdAt: Date.now(),
    };
    await this.evaluations.put(evaluation);
    await this.forecasts.put({ ...forecast, status: evaluation.scored ? 'SCORED' : 'INCONCLUSIVE', updatedAt: evaluation.createdAt });
    await this.detectEvaluationContradictions(forecast, evaluation);
    await this.api.bus.emit(MetaReasoningEvents.ForecastEvaluated, {
      forecastId: forecast.id,
      evaluationId: evaluation.id,
      outcome: evaluation.outcome,
      scored: evaluation.scored,
      brierError: evaluation.brierError,
    });
    return copy(evaluation);
  }

  /** Calculate and persist transparent historical calibration for one exact model id/version. */
  async calculateCalibration(actor: CommercialActor, input: CalculateCalibrationInput): Promise<CalibrationReport> {
    assertActor(actor);
    const model = sanitizeModel(input.model);
    const report = await this.buildCalibration(actor.tenantId, model);
    await this.calibrations.put(report);
    await this.api.bus.emit(MetaReasoningEvents.CalibrationCalculated, {
      calibrationReportId: report.id,
      tenantId: report.tenantId,
      model: modelKey(report.model),
      sampleSize: report.sampleSize,
      quality: report.quality,
    });
    return copy(report);
  }

  /**
   * Compare supplied model histories by recorded Brier error only when every
   * model has enough scored data. The resulting ranking is advisory data, not
   * an automatic selection or deployment instruction.
   */
  async compareModels(actor: CommercialActor, input: CompareModelsInput): Promise<ModelComparison> {
    assertActor(actor);
    if (!input || !Array.isArray(input.models) || input.models.length < 2 || input.models.length > 10) {
      throw new MetaReasoningError('Model comparison requires two to ten model references.');
    }
    const models = input.models.map(sanitizeModel);
    if (new Set(models.map(modelKey)).size !== models.length) throw new MetaReasoningError('Model comparison references must be distinct id/version pairs.');
    // Keep filesystem-backed collection writes sequential; the current storage
    // driver intentionally has no multi-writer transaction/locking contract.
    const reports: CalibrationReport[] = [];
    for (const model of models) reports.push(await this.calculateCalibration(actor, { model }));
    const comparable = reports.every((report) => report.quality !== 'INSUFFICIENT_DATA' && report.brierScore !== undefined);
    const ranking = comparable
      ? [...reports].sort((first, second) => first.brierScore! - second.brierScore! || modelKey(first.model).localeCompare(modelKey(second.model))).map((report) => copy(report.model))
      : [];
    const comparison: ModelComparison = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      reports: reports.map(copy),
      status: comparable ? 'COMPARABLE' : 'INSUFFICIENT_DATA',
      ranking,
      caveats: comparable
        ? ['Ranking reflects only supplied scored evaluations and is not an automatic model selection, deployment, or authorization.']
        : ['At least one model lacks the minimum scored forecast sample; no historical ranking is emitted.'],
      automaticSelection: false,
      createdAt: Date.now(),
    };
    await this.comparisons.put(comparison);
    await this.api.bus.emit(MetaReasoningEvents.ModelsCompared, {
      comparisonId: comparison.id,
      tenantId: comparison.tenantId,
      status: comparison.status,
      modelCount: comparison.reports.length,
      automaticSelection: false,
    });
    return copy(comparison);
  }

  /**
   * Review a stored multi-agent synthesis at the meta level. This maps existing
   * uncertainty/safety/disagreement statuses into an explicit, non-authorizing
   * epistemic outcome; it never recomputes or rewrites the source synthesis.
   */
  async assessDeliberation(actor: CommercialActor, input: AssessDeliberationInput): Promise<MetaReasoningAssessment> {
    assertActor(actor);
    if (!input?.deliberationId?.trim()) throw new MetaReasoningError('A deliberation id is required for meta assessment.');
    const deliberation = await this.deliberation.getDeliberation(actor, input.deliberationId);
    if (!deliberation || deliberation.tenantId !== actor.tenantId) throw new MetaReasoningError('Multi-agent deliberation not found for this tenant.');
    const syntheses = await this.deliberation.listSyntheses(actor, deliberation.id);
    const synthesis = input.synthesisId
      ? syntheses.find((candidate) => candidate.id === input.synthesisId)
      : syntheses[syntheses.length - 1];
    if (!synthesis) throw new MetaReasoningError('A stored multi-agent synthesis is required before meta assessment.');
    const result = assessmentResult(synthesis.status);
    const assessment: MetaReasoningAssessment = {
      id: randomUUID(),
      tenantId: deliberation.tenantId,
      cognitiveStateId: deliberation.cognitiveStateId,
      deliberationId: deliberation.id,
      synthesisId: synthesis.id,
      sourceSynthesisStatus: synthesis.status,
      status: result.status,
      conclusionSummary: result.conclusionSummary,
      uncertaintySummary: `This assessment inherits the source synthesis's retained uncertainty and NOT_AUTHORIZED execution boundary. ${synthesis.uncertaintySummary}`,
      recommendation: result.recommendation,
      executionAuthorization: 'NOT_AUTHORIZED',
      createdAt: Date.now(),
    };
    await this.assessments.put(assessment);
    await this.api.bus.emit(MetaReasoningEvents.DeliberationAssessed, {
      assessmentId: assessment.id,
      deliberationId: assessment.deliberationId,
      synthesisId: assessment.synthesisId,
      status: assessment.status,
      executionAuthorization: assessment.executionAuthorization,
    });
    return copy(assessment);
  }

  /**
   * Generate a bounded, advisory-only autonomy reduction recommendation from
   * historical calibration. It only preserves or lowers the caller-provided
   * ceiling and has no reference to CCP policy mutation or action execution.
   */
  async recommendAutonomyReduction(actor: CommercialActor, input: RecommendAutonomyReductionInput): Promise<AutonomyReductionRecommendation> {
    assertActor(actor);
    const model = sanitizeModel(input.model);
    const currentAutonomyLevel = autonomyLevel(input.currentAutonomyLevel);
    const calibration = await this.calculateCalibration(actor, { model });
    let recommendedMaximumAutonomyLevel = currentAutonomyLevel;
    let reason: string;
    if (calibration.quality === 'INSUFFICIENT_DATA') {
      recommendedMaximumAutonomyLevel = Math.min(currentAutonomyLevel, 1) as CommercialAutonomyLevel;
      reason = `Only ${calibration.sampleSize} scored forecast(s) are available; retain at most recommendation-level autonomy pending human policy review.`;
    } else if (calibration.quality === 'OVERCONFIDENT' || calibration.quality === 'POORLY_CALIBRATED') {
      recommendedMaximumAutonomyLevel = Math.min(currentAutonomyLevel, 1) as CommercialAutonomyLevel;
      reason = `Historical calibration is ${calibration.quality}; reduce the ceiling to recommendation level pending independent review.`;
    } else {
      reason = `Historical calibration is ${calibration.quality}; this advisory does not recommend an autonomy increase or a policy change.`;
    }
    const recommendation: AutonomyReductionRecommendation = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      calibrationReportId: calibration.id,
      model,
      currentAutonomyLevel,
      recommendedMaximumAutonomyLevel,
      status: recommendedMaximumAutonomyLevel < currentAutonomyLevel ? 'REDUCTION_RECOMMENDED' : 'NO_CHANGE_RECOMMENDED',
      reason,
      requiresHumanPolicyReview: true,
      executionAuthorization: 'NOT_AUTHORIZED',
      createdAt: Date.now(),
    };
    await this.autonomyRecommendations.put(recommendation);
    await this.api.bus.emit(MetaReasoningEvents.AutonomyReductionRecommended, {
      recommendationId: recommendation.id,
      tenantId: recommendation.tenantId,
      calibrationReportId: recommendation.calibrationReportId,
      currentAutonomyLevel: recommendation.currentAutonomyLevel,
      recommendedMaximumAutonomyLevel: recommendation.recommendedMaximumAutonomyLevel,
      status: recommendation.status,
      executionAuthorization: recommendation.executionAuthorization,
    });
    return copy(recommendation);
  }

  async getForecast(actor: CommercialActor, forecastId: string): Promise<MetaForecast | undefined> {
    const forecast = await this.forecasts.get(forecastId);
    return forecast && canRead(actor, forecast.tenantId) ? copy(forecast) : undefined;
  }

  async listForecasts(actor: CommercialActor, claimKey?: string): Promise<MetaForecast[]> {
    const normalizedClaimKey = claimKey === undefined ? undefined : normalize(requiredText(claimKey, 'Claim key', 180));
    return sorted(await this.forecasts.query({ where: (forecast) => canRead(actor, forecast.tenantId) && (normalizedClaimKey === undefined || normalize(forecast.claimKey) === normalizedClaimKey) })).map(copy);
  }

  async listEvaluations(actor: CommercialActor, forecastId: string): Promise<ForecastEvaluation[]> {
    const forecast = await this.requireForecast(actor, forecastId);
    return sorted(await this.evaluations.query({ where: (evaluation) => evaluation.forecastId === forecast.id })).map(copy);
  }

  async listCalibrationReports(actor: CommercialActor, model?: ModelReference): Promise<CalibrationReport[]> {
    const key = model === undefined ? undefined : modelKey(sanitizeModel(model));
    return sorted(await this.calibrations.query({ where: (report) => canRead(actor, report.tenantId) && (key === undefined || modelKey(report.model) === key) })).map(copy);
  }

  async listComparisons(actor: CommercialActor): Promise<ModelComparison[]> {
    return sorted(await this.comparisons.query({ where: (comparison) => canRead(actor, comparison.tenantId) })).map(copy);
  }

  async listContradictions(actor: CommercialActor, claimKey?: string): Promise<MetaContradiction[]> {
    const key = claimKey === undefined ? undefined : normalize(requiredText(claimKey, 'Claim key', 180));
    return sorted(await this.contradictions.query({ where: (contradiction) => canRead(actor, contradiction.tenantId) && (key === undefined || normalize(contradiction.claimKey) === key) })).map(copy);
  }

  async listAssessments(actor: CommercialActor, deliberationId?: string): Promise<MetaReasoningAssessment[]> {
    return sorted(await this.assessments.query({ where: (assessment) => canRead(actor, assessment.tenantId) && (deliberationId === undefined || assessment.deliberationId === deliberationId) })).map(copy);
  }

  async listAutonomyRecommendations(actor: CommercialActor, model?: ModelReference): Promise<AutonomyReductionRecommendation[]> {
    const key = model === undefined ? undefined : modelKey(sanitizeModel(model));
    return sorted(await this.autonomyRecommendations.query({ where: (recommendation) => canRead(actor, recommendation.tenantId) && (key === undefined || modelKey(recommendation.model) === key) })).map(copy);
  }

  private async requireForecast(actor: CommercialActor, forecastId: string): Promise<MetaForecast> {
    const forecast = await this.getForecast(actor, forecastId);
    if (!forecast) throw new MetaReasoningError('Meta-reasoning forecast not found.');
    return forecast;
  }

  private async buildCalibration(tenantId: string, model: ModelReference): Promise<CalibrationReport> {
    const forecasts = await this.forecasts.query({ where: (forecast) => forecast.tenantId === tenantId && modelKey(forecast.model) === modelKey(model) });
    const forecastIds = new Set(forecasts.map((forecast) => forecast.id));
    const evaluations = sorted(await this.evaluations.query({ where: (evaluation) => evaluation.tenantId === tenantId && evaluation.scored && forecastIds.has(evaluation.forecastId) }));
    const scored = evaluations.map((evaluation) => ({
      evaluation,
      forecast: forecasts.find((forecast) => forecast.id === evaluation.forecastId),
    })).filter((item): item is { evaluation: ForecastEvaluation; forecast: MetaForecast } => item.forecast !== undefined);
    const sampleSize = scored.length;
    const caveats = [
      'Calibration reflects only supplied evidence-backed binary evaluations; it does not prove a model is generally reliable.',
      'No model selection, deployment, policy change, or external action is performed by this report.',
    ];
    if (sampleSize < this.minimumCalibrationSampleSize) {
      caveats.unshift(`Only ${sampleSize} scored forecast(s) are recorded; at least ${this.minimumCalibrationSampleSize} are required for a calibration-quality label.`);
      return {
        id: randomUUID(),
        tenantId,
        model: copy(model),
        scoredForecastIds: scored.map((item) => item.forecast.id),
        scoredEvaluationIds: scored.map((item) => item.evaluation.id),
        sampleSize,
        minimumSampleSize: this.minimumCalibrationSampleSize,
        quality: 'INSUFFICIENT_DATA',
        caveats,
        createdAt: Date.now(),
      };
    }

    const probabilities = scored.map((item) => item.forecast.probability);
    const outcomes = scored.map((item) => item.evaluation.outcome === 'SUPPORTED' ? 1 : 0);
    const errors = scored.map((item) => item.evaluation.brierError!);
    const absoluteErrors = scored.map((item) => item.evaluation.absoluteError!);
    const meanForecastProbability = average(probabilities);
    const observedSupportRate = average(outcomes);
    const brierScore = average(errors);
    const meanAbsoluteError = average(absoluteErrors);
    const expectedCalibrationError = calibrationError(probabilities, outcomes);
    const quality = calibrationQuality(meanForecastProbability, observedSupportRate, brierScore, expectedCalibrationError);
    return {
      id: randomUUID(),
      tenantId,
      model: copy(model),
      scoredForecastIds: scored.map((item) => item.forecast.id),
      scoredEvaluationIds: scored.map((item) => item.evaluation.id),
      sampleSize,
      minimumSampleSize: this.minimumCalibrationSampleSize,
      meanForecastProbability,
      observedSupportRate,
      brierScore,
      meanAbsoluteError,
      expectedCalibrationError,
      quality,
      caveats,
      createdAt: Date.now(),
    };
  }

  private async detectForecastContradictions(forecast: MetaForecast): Promise<void> {
    const related = await this.forecasts.query({ where: (candidate) => candidate.tenantId === forecast.tenantId && candidate.id !== forecast.id && normalize(candidate.claimKey) === normalize(forecast.claimKey) });
    for (const candidate of related) {
      if (opposingForecasts(forecast.probability, candidate.probability)) {
        await this.appendContradiction({
          tenantId: forecast.tenantId,
          claimKey: forecast.claimKey,
          forecastIds: [candidate.id, forecast.id],
          evaluationIds: [],
          kind: 'FORECAST_PROBABILITY_CONFLICT',
          summary: 'Recorded forecasts for the same caller-owned claim key fall on opposite probability sides with a material gap; the system retains uncertainty rather than choosing a position.',
        });
      }
    }
  }

  private async detectEvaluationContradictions(forecast: MetaForecast, evaluation: ForecastEvaluation): Promise<void> {
    if (!evaluation.scored) return;
    const relatedForecasts = await this.forecasts.query({ where: (candidate) => candidate.tenantId === forecast.tenantId && candidate.id !== forecast.id && normalize(candidate.claimKey) === normalize(forecast.claimKey) });
    const relatedIds = new Set(relatedForecasts.map((candidate) => candidate.id));
    const relatedEvaluations = await this.evaluations.query({ where: (candidate) => candidate.tenantId === forecast.tenantId && candidate.scored && relatedIds.has(candidate.forecastId) });
    for (const candidate of relatedEvaluations) {
      if (candidate.outcome !== evaluation.outcome) {
        await this.appendContradiction({
          tenantId: forecast.tenantId,
          claimKey: forecast.claimKey,
          forecastIds: [candidate.forecastId, forecast.id],
          evaluationIds: [candidate.id, evaluation.id],
          kind: 'EVALUATION_OUTCOME_CONFLICT',
          summary: 'Evidence-backed evaluations for the same caller-owned claim key disagree; the system retains the conflict and does not declare a final answer.',
        });
      }
    }
  }

  private async appendContradiction(input: Omit<MetaContradiction, 'id' | 'status' | 'createdAt'>): Promise<MetaContradiction> {
    const contradiction: MetaContradiction = {
      id: randomUUID(),
      ...input,
      forecastIds: unique(input.forecastIds),
      evaluationIds: unique(input.evaluationIds),
      summary: bounded(input.summary, 640),
      status: 'OPEN',
      createdAt: Date.now(),
    };
    await this.contradictions.put(contradiction);
    await this.api.bus.emit(MetaReasoningEvents.ContradictionDetected, {
      contradictionId: contradiction.id,
      tenantId: contradiction.tenantId,
      claimKey: contradiction.claimKey,
      kind: contradiction.kind,
      forecastIds: contradiction.forecastIds,
      evaluationIds: contradiction.evaluationIds,
    });
    return contradiction;
  }
}

function validateForecastInput(input: RecordMetaForecastInput): void {
  if (!input || typeof input !== 'object') throw new MetaReasoningError('Forecast input is required.');
  requiredText(input.cognitiveStateId, 'Cognitive state id', 120);
  requiredText(input.claimKey, 'Forecast claim key', 180);
  requiredText(input.claimSummary, 'Forecast claim summary', 640);
  sanitizeModel(input.model);
  probability(input.probability, 'Forecast probability');
  percent(input.confidence, 'Forecast confidence');
  sanitizeEvidenceList(input.evidence);
  textList(input.assumptions, 'Forecast assumptions');
  textList(input.uncertainty, 'Forecast uncertainty');
  privacyClassification(input.privacyClassification);
  sanitizeProvenance(input.provenance);
}

function validateEvaluationInput(input: import('./types.js').EvaluateForecastInput): void {
  if (!input || typeof input !== 'object') throw new MetaReasoningError('Forecast evaluation input is required.');
  if (typeof input.outcome !== 'string' || !FORECAST_OUTCOMES.has(input.outcome as ForecastEvaluationOutcome)) throw new MetaReasoningError('Forecast evaluation outcome is invalid.');
  requiredText(input.method, 'Evaluation method', 320);
  requiredText(input.outcomeSummary, 'Evaluation outcome summary', 640);
  sanitizeEvidenceList(input.evidence);
  sanitizeProvenance(input.provenance);
}

function sanitizeModel(value: unknown): ModelReference {
  const model = record(value, 'Model reference');
  const evaluationStatus = model.evaluationStatus;
  if (evaluationStatus !== undefined && (typeof evaluationStatus !== 'string' || !MODEL_EVALUATION_STATUSES.has(evaluationStatus as NonNullable<ModelReference['evaluationStatus']>))) {
    throw new MetaReasoningError('Model evaluation status is invalid.');
  }
  return {
    id: requiredText(model.id, 'Model id', 180),
    version: requiredText(model.version, 'Model version', 120),
    evaluationStatus: evaluationStatus as ModelReference['evaluationStatus'],
  };
}

function sanitizeEvidenceList(value: unknown): CommercialEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) throw new MetaReasoningError(`Evidence must be an array with at most ${MAX_EVIDENCE} records.`);
  const ids = new Set<string>();
  return value.map((item) => {
    const evidence = record(item, 'Evidence record');
    const id = requiredText(evidence.id, 'Evidence id', 120);
    if (ids.has(id)) throw new MetaReasoningError(`Duplicate evidence id ${id}.`);
    ids.add(id);
    const status = evidence.status;
    if (typeof status !== 'string' || !EVIDENCE_STATUSES.has(status as CommercialEvidence['status'])) throw new MetaReasoningError('Evidence status is invalid.');
    return {
      id,
      status: status as CommercialEvidence['status'],
      source: requiredText(evidence.source, 'Evidence source', 180),
      observedAt: finite(evidence.observedAt, 'Evidence observation time'),
      confidence: percent(evidence.confidence, 'Evidence confidence'),
      summary: requiredText(evidence.summary, 'Evidence summary', 640),
      provenance: sanitizeProvenance(evidence.provenance),
      validUntil: optionalFinite(evidence.validUntil, 'Evidence validity time'),
      privacyClassification: privacyClassification(evidence.privacyClassification),
    };
  });
}

function assertBinaryEvaluationEvidence(evidence: readonly CommercialEvidence[]): void {
  const now = Date.now();
  if (evidence.some((item) => item.status === 'CONFLICTING')) {
    throw new MetaReasoningError('A binary forecast evaluation cannot be scored from explicitly conflicting evidence.');
  }
  const strong = evidence.some((item) => STRONG_EVIDENCE.has(item.status) && item.status !== 'STALE' && (item.validUntil === undefined || item.validUntil >= now));
  if (!strong) throw new MetaReasoningError('A binary forecast evaluation requires at least one current measured/customer-confirmed/demonstrated/repeated/verified evidence record.');
}

function assessmentResult(source: SynthesisStatus): Pick<MetaReasoningAssessment, 'status' | 'conclusionSummary' | 'recommendation'> {
  switch (source) {
    case 'SAFETY_ESCALATION':
      return { status: 'SAFETY_ESCALATED', recommendation: 'ESCALATE_SAFETY', conclusionSummary: 'The source synthesis records a safety escalation. Meta-reasoning preserves a no-action, human-safety-review posture.' };
    case 'INSUFFICIENT_EVIDENCE':
      return { status: 'INSUFFICIENT_EVIDENCE', recommendation: 'GATHER_EVIDENCE', conclusionSummary: 'The source synthesis has insufficient evidence or review coverage. The appropriate meta-level answer is not a factual conclusion.' };
    case 'REPRODUCIBILITY_REQUIRED':
      return { status: 'REPRODUCIBILITY_REQUIRED', recommendation: 'REQUEST_REPRODUCTION', conclusionSummary: 'The source synthesis requires reproducibility work. No replication outcome is invented by meta-reasoning.' };
    case 'DISAGREEMENT_UNRESOLVED':
      return { status: 'CONTRADICTION_DETECTED', recommendation: 'REQUEST_HUMAN_REVIEW', conclusionSummary: 'The source synthesis retains reviewer disagreement. Meta-reasoning does not collapse the disagreement or authorize an action.' };
    case 'HYPOTHESIS_CONDITIONALLY_SUPPORTED':
      return { status: 'CONDITIONALLY_SUPPORTED', recommendation: 'KEEP_SEPARATE_GOVERNANCE', conclusionSummary: 'The source synthesis conditionally supports a hypothesis. It remains conditional and subject to separate governance, not a fact or authorization.' };
    case 'HYPOTHESIS_CHALLENGED':
      return { status: 'HYPOTHESIS_CHALLENGED', recommendation: 'GATHER_EVIDENCE', conclusionSummary: 'The source synthesis challenges the hypothesis. Meta-reasoning retains uncertainty and requests evidence rather than inferring the opposite as fact.' };
    case 'INCONCLUSIVE':
      return { status: 'I_DO_NOT_KNOW', recommendation: 'NO_ACTION', conclusionSummary: 'The stored review is inconclusive. The explicit meta-level outcome is: I do not know from the available evidence.' };
  }
}

function calibrationQuality(meanForecastProbability: number, observedSupportRate: number, brierScore: number, expectedCalibrationError: number): CalibrationQuality {
  const signedGap = meanForecastProbability - observedSupportRate;
  if (brierScore <= 0.1 && expectedCalibrationError <= 0.1) return 'WELL_CALIBRATED';
  if (signedGap >= 0.15) return 'OVERCONFIDENT';
  if (signedGap <= -0.15) return 'UNDERCONFIDENT';
  return 'POORLY_CALIBRATED';
}

function calibrationError(probabilities: readonly number[], outcomes: readonly number[]): number {
  const buckets = new Map<number, Array<{ probability: number; outcome: number }>>();
  for (let index = 0; index < probabilities.length; index += 1) {
    const probabilityValue = probabilities[index]!;
    const outcome = outcomes[index]!;
    const bucket = Math.min(4, Math.floor(probabilityValue * 5));
    const values = buckets.get(bucket) ?? [];
    values.push({ probability: probabilityValue, outcome });
    buckets.set(bucket, values);
  }
  return [...buckets.values()].reduce((sum, values) => sum + values.length / probabilities.length * Math.abs(average(values.map((item) => item.probability)) - average(values.map((item) => item.outcome))), 0);
}

function opposingForecasts(first: number, second: number): boolean {
  return Math.abs(first - second) >= 0.5 && ((first >= 0.5 && second < 0.5) || (first < 0.5 && second >= 0.5));
}

function modelKey(model: ModelReference): string {
  return `${model.id}\u0000${model.version}`;
}

function autonomyLevel(value: unknown): CommercialAutonomyLevel {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 7) throw new MetaReasoningError('Autonomy level must be an integer from 0 to 7.');
  return value as CommercialAutonomyLevel;
}

function calibrationSampleSize(value: number | undefined): number {
  const sampleSize = value ?? 5;
  if (!Number.isInteger(sampleSize) || sampleSize < MIN_CALIBRATION_SAMPLE_SIZE || sampleSize > MAX_CALIBRATION_SAMPLE_SIZE) {
    throw new MetaReasoningError(`Minimum calibration sample size must be an integer from ${MIN_CALIBRATION_SAMPLE_SIZE} to ${MAX_CALIBRATION_SAMPLE_SIZE}.`);
  }
  return sampleSize;
}

function sanitizeProvenance(value: unknown): CommercialProvenance {
  const provenance = record(value, 'Provenance');
  return {
    source: requiredText(provenance.source, 'Provenance source', 180),
    collectedAt: finite(provenance.collectedAt, 'Provenance collection time'),
    correlationId: optionalText(provenance.correlationId, 'Provenance correlation id', 180),
    causationId: optionalText(provenance.causationId, 'Provenance causation id', 180),
    sourceReference: optionalText(provenance.sourceReference, 'Provenance source reference', 320),
    contentHash: optionalText(provenance.contentHash, 'Provenance content hash', 180),
  };
}

function privacyClassification(value: unknown): PrivacyClassification {
  if (value === undefined) return 'INTERNAL';
  if (typeof value !== 'string' || !PRIVACY_CLASSIFICATIONS.has(value as PrivacyClassification)) throw new MetaReasoningError('Privacy classification is invalid.');
  return value as PrivacyClassification;
}

function textList(value: unknown, name: string, maximumItems = MAX_TEXT_LIST, maximumLength = 320): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new MetaReasoningError(`${name} must be an array with at most ${maximumItems} item(s).`);
  return unique(value.map((item) => requiredText(item, name, maximumLength)));
}

function requiredText(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new MetaReasoningError(`${name} must be a string.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean) throw new MetaReasoningError(`${name} is required.`);
  return bounded(clean, maximumLength);
}

function optionalText(value: unknown, name: string, maximumLength: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, name, maximumLength);
}

function probability(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new MetaReasoningError(`${name} must be a finite number from 0 to 1.`);
  return value;
}

function percent(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new MetaReasoningError(`${name} must be a finite number from 0 to 100.`);
  return value;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MetaReasoningError(`${name} must be finite.`);
  return value;
}

function optionalFinite(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : finite(value, name);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MetaReasoningError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function square(value: number): number {
  return value * value;
}

function assertActor(actor: CommercialActor): void {
  if (!actor || !actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new MetaReasoningError('A tenant-bound cognitive actor is required.');
}

function canRead(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function sorted<T extends { id: string; createdAt: number }>(items: readonly T[]): T[] {
  return [...items].sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id));
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
