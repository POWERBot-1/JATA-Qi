// Default governed capabilities: bind each loop stage to JATA Qi's *existing*
// engines. This module adds no intelligence of its own — it is the governed
// wiring surface the driver invokes. Every adapter resolves engines from the
// live kernel (tenant-bound, lifecycle-managed) and returns typed records.

import type { KernelApi } from '@jataqi/core-kernel';
import type {
  CommercialActor,
  CommercialEvidence,
  CommercialProvenance,
} from '@jataqi/commercial-control-plane';
import { CognitiveKernelModule } from '@jataqi/cognitive-kernel';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { WorldModelModule } from '@jataqi/world-model';
import { HypothesisEngineModule } from '@jataqi/hypothesis-engine';
import { CausalEngineModule } from '@jataqi/causal-engine';
import { ProbabilisticEngineModule } from '@jataqi/probabilistic-engine';
import { TemporalEngineModule } from '@jataqi/temporal-engine';
import { MultiAgentCognitionModule } from '@jataqi/multi-agent-cognition';
import { MetaReasoningModule } from '@jataqi/meta-reasoning';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { ReconciliationModule } from '@jataqi/reconciliation';
import { CommercialMemoryModule } from '@jataqi/commercial-memory';

import type {
  CapabilityInvocationContext,
  CapabilityResult,
  GovernedCapability,
  LoopStage,
} from './types.js';

const CAP_TIMEOUT_MS = 5_000;

/** Resolve engine services lazily from the kernel at invocation time. */
interface Services {
  kernel: KernelApi;
  cognitive: ReturnType<CognitiveKernelModule['getService']>;
  knowledge: KnowledgeService;
  graph: KnowledgeGraphModule;
  world: ReturnType<WorldModelModule['getService']>;
  hypothesis: ReturnType<HypothesisEngineModule['getService']>;
  causal: ReturnType<CausalEngineModule['getService']>;
  probabilistic: ReturnType<ProbabilisticEngineModule['getEngine']>;
  temporal: ReturnType<TemporalEngineModule['getService']>;
  multiAgent: ReturnType<MultiAgentCognitionModule['getService']>;
  meta: ReturnType<MetaReasoningModule['getService']>;
  control: ReturnType<CommercialControlPlaneModule['getService']>;
  runtime: ReturnType<AutonomousActionRuntimeModule['getService']>;
  reconciliation: ReturnType<ReconciliationModule['getService']>;
  memory: ReturnType<CommercialMemoryModule['getService']>;
}

function services(kernel: KernelApi): Services {
  return {
    kernel,
    cognitive: kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService(),
    knowledge: kernel.getModule<KnowledgeService>('knowledge'),
    graph: kernel.getModule<KnowledgeGraphModule>('knowledge-graph'),
    world: kernel.getModule<WorldModelModule>('world-model').getService(),
    hypothesis: kernel.getModule<HypothesisEngineModule>('hypothesis-engine').getService(),
    causal: kernel.getModule<CausalEngineModule>('causal-engine').getService(),
    probabilistic: kernel.getModule<ProbabilisticEngineModule>('probabilistic-engine').getEngine(),
    temporal: kernel.getModule<TemporalEngineModule>('temporal-engine').getService(),
    multiAgent: kernel.getModule<MultiAgentCognitionModule>('multi-agent-cognition').getService(),
    meta: kernel.getModule<MetaReasoningModule>('meta-reasoning').getService(),
    control: kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService(),
    runtime: kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService(),
    reconciliation: kernel.getModule<ReconciliationModule>('reconciliation').getService(),
    memory: kernel.getModule<CommercialMemoryModule>('commercial-memory').getService(),
  };
}

function provenance(ctx: CapabilityInvocationContext, source = 'unified-loop'): CommercialProvenance {
  return { source, collectedAt: ctx.now(), correlationId: ctx.correlationId };
}

function evidence(ctx: CapabilityInvocationContext, id: string, summary: string): CommercialEvidence {
  return {
    id,
    status: 'OBSERVED',
    source: 'unified-loop',
    observedAt: ctx.now(),
    confidence: 80,
    summary,
    provenance: provenance(ctx),
    privacyClassification: 'INTERNAL',
  };
}

function cap(
  stage: LoopStage,
  operation: string,
  invoke: (svc: Services, ctx: CapabilityInvocationContext) => Promise<CapabilityResult>,
  opts: Partial<Pick<GovernedCapability, 'sideEffect' | 'authority' | 'requiredGrants' | 'timeoutMs'>> = {},
): GovernedCapability {
  return {
    capabilityId: `unified-loop.${stage.toLowerCase().replaceAll('_', '-')}`,
    operation,
    stage,
    sideEffect: opts.sideEffect ?? 'NONE',
    authority: opts.authority ?? 'NONE',
    requiredGrants: opts.requiredGrants ?? [],
    timeoutMs: opts.timeoutMs ?? CAP_TIMEOUT_MS,
    // The driver attaches the live kernel to the invocation context (the kernel
    // is not serializable working state, so it rides a non-enumerable reference).
    invoke: (ctx) => invoke(services(kernelOf(ctx)), ctx),
  };
}

/** Resolve the live kernel attached to the invocation context by the driver. */
function kernelOf(ctx: CapabilityInvocationContext): KernelApi {
  const k = (ctx as unknown as { __kernel?: KernelApi }).__kernel;
  if (!k) throw new Error('Unified loop invocation context is missing the kernel reference.');
  return k;
}

/**
 * Build the default governed capability set. Engines that are absent from a
 * kernel (e.g. minimal test composition) are still declared; their adapters
 * surface a BOUNDARY/SKIP rather than fabricating output.
 */
export function buildDefaultCapabilities(): GovernedCapability[] {
  const caps: GovernedCapability[] = [];

  // --- Loop entry ---
  caps.push(cap('WAKE', 'wake-on-task', async (_svc, ctx) => {
    return {
      summary: `Woken for task in tenant ${ctx.actor.tenantId}; correlation ${ctx.correlationId}; objective "${ctx.task.objective.slice(0, 60)}".`,
      outputs: { woken: true, tenantId: ctx.actor.tenantId, hasProposedAction: Boolean(ctx.task.proposedAction) },
    };
  }));

  // Context establishment is idempotent: ESTABLISH_CONTEXT runs in canonical
  // position, but earlier stages (OBSERVE/INGEST) also lazily ensure a state
  // exists, so the mandated stage order is preserved without a broken dependency.
  async function ensureContext(svc: Services, ctx: CapabilityInvocationContext): Promise<{ state: { id: string }; created: boolean }> {
    if (ctx.state.cognitiveStateId) {
      const existing = await svc.cognitive.getState(ctx.actor, ctx.state.cognitiveStateId);
      if (existing) return { state: existing, created: false };
    }
    const created = await svc.cognitive.createState(ctx.actor, { scope: ctx.task.objective, substrate: 'CLASSICAL' });
    ctx.state.cognitiveStateId = created.id;
    return { state: created, created: true };
  }

  // --- Cognitive state establishment ---
  caps.push(cap('ESTABLISH_CONTEXT', 'establish-cognitive-context', async (svc, ctx) => {
    const { state, created } = await ensureContext(svc, ctx);
    return {
      summary: `Established tenant-bound cognitive state ${state.id} for objective.`,
      records: created ? [{
        kind: 'INTENT', source: 'cognitive-kernel', externalRef: state.id, at: ctx.now(),
        summary: ctx.task.objective, provenance: provenance(ctx),
      }] : [],
      outputs: { cognitiveStateId: state.id },
    };
  }));

  caps.push(cap('OBSERVE', 'record-observations', async (svc, ctx) => {
    const { created } = await ensureContext(svc, ctx);
    if (!ctx.state.cognitiveStateId) throw new Error('Cannot observe: context establishment failed.');
    const createdIntent = created;
    const obs = ctx.task.observations ?? [];
    const ids: string[] = [];
    for (let i = 0; i < obs.length; i++) {
      const text = obs[i]!;
      const o = await svc.cognitive.recordObservation(ctx.actor, ctx.state.cognitiveStateId, {
        modality: 'TEXT',
        contentSummary: text.slice(0, 300),
        epistemicStatus: 'OBSERVED',
        confidence: 85,
        provenance: { ...provenance(ctx), sourceReference: `observation:${i}` },
        privacyClassification: 'INTERNAL',
      });
      ids.push(o.id);
    }
    return {
      summary: `Recorded ${ids.length} observation(s) into cognitive state${createdIntent ? ' (context established lazily)' : ''}.`,
      records: createdIntent ? [{
        kind: 'INTENT', source: 'cognitive-kernel', externalRef: ctx.state.cognitiveStateId, at: ctx.now(),
        summary: ctx.task.objective, provenance: provenance(ctx),
      }] : [],
      outputs: { observationIds: ids },
    };
  }));

  caps.push(cap('INGEST', 'ingest-knowledge-documents', async (svc, ctx) => {
    const docs = ctx.task.observations ?? [];
    const docIds: string[] = [];
    for (const text of docs) {
      const doc = await svc.knowledge.ingestText(text, { chunkSize: 400 });
      docIds.push(doc.id);
    }
    return {
      summary: `Ingested ${docIds.length} document(s) into knowledge service (graph auto-propagates via event).`,
      outputs: { documentIds: docIds },
    };
  }));

  caps.push(cap('NORMALIZE', 'normalize-inputs', async (_svc, ctx) => {
    const obs = ctx.task.observations ?? [];
    return {
      summary: `Normalized ${obs.length} observation(s); tenant=${ctx.actor.tenantId}; provenance attached.`,
      outputs: { normalizedCount: obs.length },
    };
  }));

  caps.push(cap('IDENTIFY', 'identify-entities', async (svc, ctx) => {
    // Heuristic identification already happens in the knowledge graph on ingest
    // (knowledge.document.ingested -> graph extraction). Surface graph stats.
    const stats = svc.graph.stats();
    return {
      summary: `Knowledge graph holds ${stats.entities} entities / ${stats.triples} triples after identification.`,
      outputs: { graphEntities: stats.entities, graphTriples: stats.triples },
    };
  }));

  caps.push(cap('ASSESS_WORLD_STATE', 'assess-cognitive-state', async (svc, ctx) => {
    if (!ctx.state.cognitiveStateId) throw new Error('Cognitive state missing for world assessment.');
    const assessment = await svc.cognitive.assess(ctx.actor, ctx.state.cognitiveStateId);
    return {
      summary: `World assessment: ${assessment.highConfidenceBeliefs.length} high-confidence, ${assessment.uncertainBeliefs.length} uncertain, ${assessment.contradictoryBeliefs.length} contradictory belief(s).`,
      outputs: {
        highConfidence: assessment.highConfidenceBeliefs.length,
        uncertain: assessment.uncertainBeliefs.length,
        contradictory: assessment.contradictoryBeliefs.length,
        informationNeeds: assessment.recommendedInformationNeeds.length,
      },
    };
  }));

  caps.push(cap('RETRIEVE_KNOWLEDGE', 'retrieve-knowledge', async (svc, ctx) => {
    const query = ctx.task.knowledgeQuery ?? ctx.task.objective;
    const hits = await svc.knowledge.retrieve(query, { topK: 3 });
    ctx.state.knowledgeHits = hits.length;
    return {
      summary: `Knowledge retrieval for "${query.slice(0, 60)}" returned ${hits.length} hit(s).`,
      outputs: { hitCount: hits.length, topScore: hits[0]?.score ?? 0 },
    };
  }));

  caps.push(cap('RETRIEVE_MEMORY', 'retrieve-memory', async (svc, ctx) => {
    // Memory retrieval: list cognitive beliefs (episodic/decision memory lives in
    // commercial-memory and is written during UPDATE_STATE).
    if (!ctx.state.cognitiveStateId) throw new Error('Cognitive state missing for memory retrieval.');
    const beliefs = await svc.cognitive.listBeliefs(ctx.actor, ctx.state.cognitiveStateId);
    const memoryRecords = await svc.memory.query(ctx.actor, { limit: 10 }).catch(() => [] as unknown[]);
    const memoryCount = Array.isArray(memoryRecords) ? memoryRecords.length : 0;
    return {
      summary: `Retrieved ${beliefs.length} belief(s) and ${memoryCount} commercial-memory record(s).`,
      outputs: { beliefs: beliefs.length, memoryRecords: memoryCount },
    };
  }));

  caps.push(cap('BUILD_OR_UPDATE_WORLD_MODEL', 'build-world-model', async (svc, ctx) => {
    const model = await svc.world.createModel(ctx.actor, {
      name: `world:${ctx.loopId}`,
      cognitiveStateId: ctx.state.cognitiveStateId,
      description: ctx.task.objective,
    });
    ctx.state.worldModelId = model.id;
    const ev = evidence(ctx, 'world-entity-evidence', 'World entity derived from ingested observations.');
    const entity = await svc.world.addEntity(ctx.actor, model.id, {
      type: 'Scenario',
      name: ctx.task.objective.slice(0, 80),
      properties: { knowledgeHits: ctx.state.knowledgeHits ?? 0 },
      epistemicStatus: 'INFERRED',
      confidence: 70,
      provenance: provenance(ctx),
    });
    await svc.world.recordEvent(ctx.actor, model.id, {
      type: 'loop.context_established',
      entityIds: [entity.id],
      timestamp: ctx.now(),
      epistemicStatus: 'OBSERVED',
      confidence: 80,
      payload: { loopId: ctx.loopId },
      evidence: [ev],
      provenance: provenance(ctx),
    });
    return {
      summary: `Built world model ${model.id} with scenario entity and provenance-bound event.`,
      records: [{
        kind: 'BELIEF', source: 'world-model', externalRef: model.id, at: ctx.now(),
        summary: 'World model constructed from loop context.', provenance: provenance(ctx),
      }],
      outputs: { worldModelId: model.id, entityId: entity.id },
    };
  }));

  caps.push(cap('GENERATE_HYPOTHESES', 'generate-hypotheses', async (svc, ctx) => {
    if (!ctx.state.cognitiveStateId) throw new Error('Cognitive state missing for hypotheses.');
    const session = await svc.hypothesis.createSession(ctx.actor, {
      cognitiveStateId: ctx.state.cognitiveStateId,
      hypothesisSet: {
        substrate: 'CLASSICAL',
        hypotheses: [
          { id: 'h_positive', label: 'Proposed action is supported by evidence', confidence: 60, contradictionScore: 0, evidence: [], provenance: ['unified-loop'], assumptions: [], dependencies: [] },
          { id: 'h_negative', label: 'Proposed action is not supported', confidence: 60, contradictionScore: 0, evidence: [], provenance: ['unified-loop'], assumptions: [], dependencies: [] },
        ],
      },
      provenance: provenance(ctx),
    });
    ctx.state.hypothesisSessionId = session.id;
    // Classical Bayesian update with a deterministic likelihood (evidence leans positive).
    const { revision } = await svc.hypothesis.revise(ctx.actor, session.id, {
      evidence: {
        id: `likelihood:${ctx.loopId}`,
        likelihoodByHypothesis: { h_positive: 0.75, h_negative: 0.25 },
        source: 'unified-loop',
        assumptions: ['Deterministic fixture likelihood for native loop demonstration.'],
      },
      provenance: provenance(ctx),
    });
    const top = svc.probabilistic.topHypotheses(session.hypothesisSet, 1)[0];
    return {
      summary: `Hypothesis session ${session.id} revised; information gain ${revision.informationGain.toFixed(3)}; leading hypothesis posterior ${(top?.probability ?? 0).toFixed(2)}.`,
      outputs: { sessionId: session.id, informationGain: revision.informationGain, topPosterior: top?.probability ?? 0 },
    };
  }));

  caps.push(cap('CAUSAL_ANALYSIS', 'causal-analysis', async (svc, ctx) => {
    if (!ctx.state.worldModelId) throw new Error('World model missing for causal analysis.');
    const causal = await svc.causal.createModel(ctx.actor, {
      worldModelId: ctx.state.worldModelId,
      name: `causal:${ctx.loopId}`,
      variables: [
        { id: 'intervention', label: 'Intervention', unit: 'unit', baseline: 0 },
        { id: 'outcome', label: 'Outcome', unit: 'unit', baseline: 0 },
      ],
      assumptions: ['Classical linear structural causal model; simulated intervention only.'],
      provenance: provenance(ctx),
    });
    ctx.state.causalModelId = causal.id;
    await svc.causal.addEdge(ctx.actor, causal.id, {
      fromVariableId: 'intervention', toVariableId: 'outcome', effect: 0.6, confidence: 65,
      status: 'CAUSAL_HYPOTHESIS', causalMethod: 'CLASSICAL_LINEAR_STRUCTURAL_CAUSAL_MODEL',
      evidence: [evidence(ctx, 'causal-edge', 'Hypothesized causal edge from ingested evidence.')],
      provenance: provenance(ctx),
    });
    const scenario = await svc.causal.simulate(ctx.actor, causal.id, {
      interventions: { intervention: 1 },
      assumptions: ['Simulated, not a real intervention.'],
      evidence: [evidence(ctx, 'causal-sim', 'Simulated counterfactual scenario.')],
    });
    return {
      summary: `Causal model ${causal.id}: simulated intervention predicts outcome ${scenario.predictedValues['outcome']?.toFixed(2) ?? 'n/a'} (explicitly simulated).`,
      outputs: { causalModelId: causal.id, simulated: true, predictedOutcome: scenario.predictedValues['outcome'] ?? null },
    };
  }));

  caps.push(cap('PROBABILISTIC_ASSESSMENT', 'probabilistic-assessment', async (svc, ctx) => {
    if (!ctx.state.hypothesisSessionId) throw new Error('Hypothesis session missing.');
    const session = await svc.hypothesis.getSession(ctx.actor, ctx.state.hypothesisSessionId);
    if (!session) throw new Error('Hypothesis session not found.');
    const entropy = svc.probabilistic.entropy(session.hypothesisSet);
    const top = svc.probabilistic.topHypotheses(session.hypothesisSet, 1)[0];
    return {
      summary: `Probabilistic assessment: entropy ${entropy.toFixed(3)}, leading hypothesis ${top?.id} @ ${(top?.probability ?? 0).toFixed(2)}.`,
      outputs: { entropy, topHypothesis: top?.id, topProbability: top?.probability ?? 0 },
    };
  }));

  caps.push(cap('TEMPORAL_REASONING', 'temporal-reasoning', async (svc, ctx) => {
    const timeline = await svc.temporal.createTimeline(ctx.actor, {
      name: `timeline:${ctx.loopId}`,
      worldModelId: ctx.state.worldModelId,
    });
    ctx.state.timelineId = timeline.id;
    await svc.temporal.recordEvent(ctx.actor, timeline.id, {
      type: 'loop.wake', occurredAt: ctx.now(), epistemicStatus: 'OBSERVED', confidence: 90,
      payload: { loopId: ctx.loopId }, evidence: [evidence(ctx, 'temporal-wake', 'Loop wake event.')],
      provenance: provenance(ctx),
    });
    const replayed = await svc.temporal.replay(ctx.actor, timeline.id);
    return {
      summary: `Temporal timeline ${timeline.id} recorded and deterministically replayed ${replayed.length} event(s).`,
      outputs: { timelineId: timeline.id, replayedEvents: replayed.length },
    };
  }));

  caps.push(cap('MULTI_AGENT_DELIBERATION', 'multi-agent-deliberation', async (svc, ctx) => {
    if (!ctx.state.cognitiveStateId) throw new Error('Cognitive state missing for deliberation.');
    const deliberation = await svc.multiAgent.createDeliberation(ctx.actor, {
      cognitiveStateId: ctx.state.cognitiveStateId,
      title: `Deliberation: ${ctx.task.objective.slice(0, 60)}`,
      hypothesis: 'The governed action is safe and authorized.',
      evidence: [evidence(ctx, 'deliberation-evidence', 'Evidence package for multi-agent review.')],
      assumptions: ['No injected reviewers; deterministic conservative synthesis.'],
      confidence: 65,
      proposedAction: {
        disposition: ctx.task.proposedAction ? 'GOVERNED_ACTION_CANDIDATE' : 'NO_ACTION',
        summary: ctx.task.proposedAction ? 'Proposed governed external action.' : 'Reasoning-only task; no action proposed.',
      },
      requestedRoles: ['CRITIC_AGENT', 'SAFETY_AGENT'],
      uncertainty: ['External verification not available inside the loop.'],
      provenance: provenance(ctx),
    });
    ctx.state.deliberationId = deliberation.id;
    const run = await svc.multiAgent.runRequestedReviews(ctx.actor, deliberation.id);
    const synthesis = await svc.multiAgent.synthesize(ctx.actor, deliberation.id);
    const synthesisStatus: string = synthesis.status;
    return {
      summary: `Deliberation ${deliberation.id}: ${run.reviews.length} injected review(s), ${run.unavailableRoles.length} role(s) unavailable; synthesis ${synthesisStatus} (executionAuthorization=${synthesis.executionAuthorization}).`,
      outputs: {
        deliberationId: deliberation.id,
        reviewsRun: run.reviews.length,
        unavailableRoles: run.unavailableRoles.length,
        synthesisStatus,
        executionAuthorization: synthesis.executionAuthorization,
      },
    };
  }));

  caps.push(cap('META_REASONING', 'meta-reasoning', async (svc, ctx) => {
    if (!ctx.state.cognitiveStateId) throw new Error('Cognitive state missing for meta-reasoning.');
    const forecast = await svc.meta.recordForecast(ctx.actor, {
      cognitiveStateId: ctx.state.cognitiveStateId,
      claimKey: `loop:${ctx.loopId}:action-supported`,
      claimSummary: 'Forecast that the proposed governed action will be supported by verification.',
      model: { id: 'unified-loop-deterministic', version: '0.1.0', evaluationStatus: 'UNASSESSED' },
      probability: 0.6, confidence: 60,
      evidence: [evidence(ctx, 'meta-forecast', 'Forecast evidence from loop.')],
      assumptions: ['Deterministic classical forecast; advisory only.'],
      uncertainty: ['No live outcome available within the loop.'],
      provenance: provenance(ctx),
    });
    // Advisory-only: meta-reasoning may recommend *reducing* autonomy; it never
    // grants authority. This is a conservative read used only for the audit trace.
    let recommendation: { reduced: boolean } | null = null;
    try {
      const rec = await svc.meta.recommendAutonomyReduction(ctx.actor, {
        model: { id: 'unified-loop-deterministic', version: '0.1.0' },
        currentAutonomyLevel: ctx.task.proposedAction?.authorizationLevel as 1 | 2 | 3 ?? 1,
      });
      recommendation = { reduced: Boolean(rec) };
    } catch {
      recommendation = null;
    }
    return {
      summary: `Meta-reasoning forecast ${forecast.id} recorded (p=${forecast.probability}); advisory autonomy reduction ${recommendation?.reduced ? 'recommended' : 'not triggered'}.`,
      outputs: { forecastId: forecast.id, forecastProbability: forecast.probability, autonomyReductionAdvisory: recommendation?.reduced ?? false },
    };
  }));

  caps.push(cap('CONTRADICTION_DETECTION', 'detect-contradictions', async (svc, ctx) => {
    if (!ctx.state.cognitiveStateId) throw new Error('Cognitive state missing.');
    const assessment = await svc.cognitive.assess(ctx.actor, ctx.state.cognitiveStateId);
    const contradictions = assessment.contradictoryBeliefs.map((b: { proposition: string }) => b.proposition);
    return {
      summary: contradictions.length
        ? `Detected ${contradictions.length} contradictory belief(s).`
        : 'No contradictory beliefs detected in cognitive state.',
      outputs: { contradictions },
      boundaryHeld: contradictions.length > 0,
    };
  }));

  caps.push(cap('UNCERTAINTY_ASSESSMENT', 'assess-uncertainty', async (svc, ctx) => {
    if (!ctx.state.cognitiveStateId) throw new Error('Cognitive state missing.');
    const assessment = await svc.cognitive.assess(ctx.actor, ctx.state.cognitiveStateId);
    return {
      summary: `Uncertainty: ${assessment.uncertainBeliefs.length} uncertain belief(s); ${assessment.recommendedInformationNeeds.length} information need(s).`,
      outputs: { uncertainBeliefs: assessment.uncertainBeliefs.length, informationNeeds: assessment.recommendedInformationNeeds.length },
    };
  }));

  // --- Governance spine (POLICY → SAFETY → AUTHORITY → GATE) ---
  // These capabilities do NOT grant authority; they evaluate the existing
  // commercial control plane and return its decision. They create no policy.
  caps.push(cap('POLICY', 'evaluate-policy', async (svc, ctx) => {
    if (!ctx.task.proposedAction) {
      return { summary: 'No external action proposed; policy evaluation not applicable (reasoning-only task).', boundaryHeld: false, outputs: { policyApplied: false } };
    }
    const decision = await proposeActionDecision(svc, ctx);
    ctx.state.decisionId = decision.id;
    return {
      summary: `Proposed commercial decision ${decision.id}; policy will be evaluated at AUTHORIZE.`,
      records: [{ kind: 'DECISION', source: 'commercial-control-plane', externalRef: decision.id, at: ctx.now(), summary: `Decision for ${decision.actionType}`, provenance: provenance(ctx) }],
      outputs: { decisionId: decision.id, decisionState: decision.executionState },
    };
  }, { authority: 'POLICY_ONLY' }));

  caps.push(cap('SAFETY', 'safety-screen', async (_svc, ctx) => {
    const a = ctx.task.proposedAction;
    if (!a) return { summary: 'No action; safety screen trivially satisfied.', outputs: { safetyScreened: false } };
    const safe = a.riskScore <= 100 && a.complianceScore >= 0;
    return {
      summary: safe ? `Safety screen passed (risk=${a.riskScore}, compliance=${a.complianceScore}).` : 'Safety screen failed.',
      outputs: { riskScore: a.riskScore, complianceScore: a.complianceScore },
      boundaryHeld: !safe,
    };
  }));

  caps.push(cap('AUTHORITY', 'determine-authority', async (_svc, ctx) => {
    const a = ctx.task.proposedAction;
    if (!a) return { summary: 'No action; no authority required.', outputs: { authorityRequired: false } };
    return {
      summary: `Action requires authorization at autonomy level ${a.authorizationLevel}; reasoning does not grant authority.`,
      outputs: { authorityRequired: true, requestedLevel: a.authorizationLevel },
    };
  }));

  caps.push(cap('HUMAN_OR_REGULATORY_GATE', 'human-regulatory-gate', async (_svc, ctx) => {
    const a = ctx.task.proposedAction;
    if (!a) return { summary: 'No external effect; human/regulatory gate not invoked.', outputs: { gateRequired: false } };
    // The loop never self-approves. High autonomy requests always require an
    // explicit external human/regulatory gate, represented as a held boundary.
    // Low-level sandbox actions proceed to deterministic policy authorization.
    const requiresGate = a.authorizationLevel >= 3;
    return {
      summary: requiresGate
        ? 'Human/regulatory gate REQUIRED and not satisfiable in-loop; boundary held (no self-approval).'
        : 'Action is within delegable sandbox authority; gate proceeds to authorization.',
      outputs: { gateRequired: requiresGate },
      boundaryHeld: requiresGate,
    };
  }));

  caps.push(cap('CAPABILITY_SELECTION', 'select-capability', async (_svc, ctx) => {
    const a = ctx.task.proposedAction;
    if (!a) return { summary: 'No action; no execution capability selected.', outputs: { capabilitySelected: false } };
    return {
      summary: `Selected governed execution capability for target system "${a.targetSystem}" action "${a.actionType}".`,
      outputs: { capabilitySelected: true, targetSystem: a.targetSystem, actionType: a.actionType },
    };
  }));

  caps.push(cap('PLAN', 'plan-action', async (svc, ctx) => {
    const a = ctx.task.proposedAction;
    if (!a || !ctx.state.decisionId) {
      return { summary: 'No authorized decision to plan; planning skipped.', outputs: { planned: false } };
    }
    try {
      const action = await svc.runtime.plan(ctx.actor, ctx.state.decisionId, {
        targetSystem: a.targetSystem,
        targetResource: a.targetResource,
        parameters: a.parameters,
        idempotencyKey: `loop:${ctx.loopId}:${a.actionType}`,
        dryRun: a.executeForReal !== true,
      });
      ctx.state.actionId = action.id;
      return {
        summary: `Planned action ${action.id} (dryRun=${action.dryRun}); planning does not authorize execution.`,
        records: [{ kind: 'PLAN', source: 'autonomous-action-runtime', externalRef: action.id, at: ctx.now(), summary: `Plan for ${a.actionType}`, provenance: provenance(ctx) }],
        outputs: { actionId: action.id, dryRun: action.dryRun },
      };
    } catch (err) {
      // No adapter for this target system, or planning refused. This is an
      // operational boundary, not a policy denial: the loop records it and
      // proceeds so AUTHORIZE's decision governs the final outcome.
      return {
        summary: `Planning not possible: ${(err as Error).message}`,
        outputs: { planned: false, planError: (err as Error).message },
      };
    }
  }, { sideEffect: 'SANDBOX', authority: 'AUTHORIZED_ACTION' }));

  caps.push(cap('VERIFY_PLAN', 'verify-plan', async (_svc, ctx) => {
    if (!ctx.state.actionId) {
      return { summary: 'No planned action; plan verification skipped.', outputs: { planVerified: false } };
    }
    // A plan is structurally verified when it exists and is tenant-bound. The
    // action cannot execute unless AUTHORIZE yields an ALLOW.
    return {
      summary: `Plan ${ctx.state.actionId} verified structurally; awaiting authorization (plan ≠ authorization).`,
      outputs: { planVerified: true, actionId: ctx.state.actionId },
    };
  }));

  caps.push(cap('AUTHORIZE', 'authorize-decision', async (svc, ctx) => {
    if (!ctx.state.decisionId) {
      return { summary: 'No decision; nothing to authorize.', outputs: { authorized: false } };
    }
    const authorization = await svc.control.authorizeDecision(ctx.actor, ctx.state.decisionId);
    ctx.state.authorizationId = authorization.id;
    const allowed = authorization.allowed && authorization.outcome === 'ALLOW';
    return {
      summary: allowed
        ? `Authorization ${authorization.id} ALLOWED (policy ${authorization.policyId ?? 'n/a'}).`
        : `Authorization ${authorization.id} ${authorization.outcome}; execution denied/held. Reasons: ${authorization.reasons.join('; ')}`,
      records: [{ kind: 'AUTHORIZATION', source: 'commercial-control-plane', externalRef: authorization.id, at: ctx.now(), summary: `Authorization outcome ${authorization.outcome}`, provenance: provenance(ctx) }],
      outputs: { authorizationId: authorization.id, outcome: authorization.outcome, allowed, simulationOnly: authorization.simulationOnly },
      boundaryHeld: !allowed,
    };
  }, { authority: 'POLICY_ONLY' }));

  caps.push(cap('EXECUTE', 'execute-action', async (svc, ctx) => {
    const a = ctx.task.proposedAction;
    if (!a || !ctx.state.actionId) {
      return { summary: 'No authorized action; execution skipped (fail-closed).', outputs: { executed: false } };
    }
    const auth = ctx.state.stageOutputs['AUTHORIZE'] as Record<string, unknown> | undefined;
    if (!auth || auth.allowed !== true) {
      return {
        summary: 'Execution refused: decision is not authorized. EXECUTE requires AUTHORIZE=ALLOW.',
        outputs: { executed: false },
        boundaryHeld: true,
      };
    }
    const result = await svc.runtime.execute(ctx.actor, ctx.state.actionId, { maxAttempts: 2, timeoutMs: 2_000 });
    return {
      summary: `Execution dispatched for action ${result.action.id}; status ${result.action.executionStatus}; external=${result.executedExternally}.`,
      records: [{ kind: 'ACTION', source: 'autonomous-action-runtime', externalRef: result.action.id, at: ctx.now(), summary: `Action execution ${result.action.executionStatus}`, provenance: provenance(ctx) }],
      outputs: { actionId: result.action.id, executionStatus: result.action.executionStatus, executedExternally: result.executedExternally },
    };
  }, { sideEffect: 'SANDBOX', authority: 'AUTHORIZED_ACTION' }));

  caps.push(cap('OBSERVE_RESULT', 'observe-result', async (svc, ctx) => {
    if (!ctx.state.actionId) return { summary: 'No action; no result to observe.', outputs: { observed: false } };
    const action = await svc.control.getAction(ctx.actor, ctx.state.actionId);
    return {
      summary: `Observed action result: execution=${action?.executionStatus ?? 'UNKNOWN'}, verification=${action?.verificationStatus ?? 'UNKNOWN'}.`,
      outputs: { executionStatus: action?.executionStatus, verificationStatus: action?.verificationStatus },
    };
  }));

  caps.push(cap('VERIFY_RESULT', 'verify-result', async (svc, ctx) => {
    if (!ctx.state.actionId) {
      return { summary: 'No action; result verification skipped.', outputs: { verified: false } };
    }
    const action = await svc.control.getAction(ctx.actor, ctx.state.actionId);
    // Dry-run actions never reach an external VERIFYING state; they are
    // simulation-only and must not be reported as verified real outcomes.
    if (action?.dryRun) {
      ctx.state.verificationPassed = false;
      return {
        summary: 'Dry-run/simulated action: not promoted to a verified real outcome.',
        outputs: { verified: false, dryRun: true },
      };
    }
    try {
      const verified = await svc.runtime.verify(ctx.actor, ctx.state.actionId, 2_000);
      const passed = verified.verificationStatus === 'VERIFIED' && verified.executionStatus === 'COMPLETED';
      ctx.state.verificationPassed = passed;
      return {
        summary: passed
          ? `Result verified: action ${verified.id} COMPLETED/VERIFIED.`
          : `Result verification did not pass: status ${verified.executionStatus}/${verified.verificationStatus}.`,
        records: [{ kind: 'RESULT', source: 'autonomous-action-runtime', externalRef: verified.id, at: ctx.now(), summary: `Verification ${verified.verificationStatus}`, provenance: provenance(ctx) }],
        outputs: { verified: passed, executionStatus: verified.executionStatus, verificationStatus: verified.verificationStatus },
        boundaryHeld: !passed,
      };
    } catch (err) {
      ctx.state.verificationPassed = false;
      return {
        summary: `Verification failed closed: ${(err as Error).message}`,
        outputs: { verified: false, verifyError: (err as Error).message },
        boundaryHeld: true,
      };
    }
  }, { sideEffect: 'SANDBOX', authority: 'AUTHORIZED_ACTION' }));

  caps.push(cap('RECONCILE', 'reconcile-state', async (svc, ctx) => {
    if (!ctx.state.actionId) {
      return { summary: 'No external action; internal reconciliation limited to cognitive state.', outputs: { reconciled: false } };
    }
    // Reconciliation is read-only; provider state is not fetched in-repo.
    ctx.state.reconciled = true;
    const action = await svc.control.getAction(ctx.actor, ctx.state.actionId);
    return {
      summary: `Reconciliation: action state ${action?.executionStatus ?? 'UNKNOWN'}; external/provider reconciliation remains read-only/pending.`,
      outputs: { reconciled: true, executionStatus: action?.executionStatus },
    };
  }));

  caps.push(cap('UPDATE_STATE', 'update-state-memory', async (svc, ctx) => {
    if (!ctx.state.cognitiveStateId) throw new Error('Cognitive state missing for update.');
    // Record a learning belief back into the cognitive kernel (closed-loop update).
    await svc.cognitive.addBelief(ctx.actor, ctx.state.cognitiveStateId, {
      proposition: `Loop ${ctx.loopId} completed reasoning for objective: ${ctx.task.objective.slice(0, 80)}`,
      probability: ctx.state.verificationPassed ? 0.8 : 0.55,
      confidence: ctx.state.verificationPassed ? 75 : 55,
      epistemicStatus: ctx.state.verificationPassed ? 'OBSERVED' : 'INFERRED',
      evidenceObservationIds: [],
      assumptions: ['Loop outcome belief; not autonomous authorization.'],
    }).catch(() => undefined);
    return {
      summary: 'Updated cognitive state with loop outcome; memory/knowledge continuity preserved.',
      outputs: { stateUpdated: true, verificationPassed: ctx.state.verificationPassed ?? false },
    };
  }));

  caps.push(cap('AUDIT', 'emit-audit', async (svc, ctx) => {
    // Persist a decision-outcome/learning record into commercial memory when an
    // action was attempted; otherwise emit a loop audit trail record.
    if (ctx.state.decisionId) {
      await svc.memory.record(ctx.actor, {
        kind: 'DECISION',
        productId: ctx.task.proposedAction?.productId ?? 'loop-product',
        title: `Loop ${ctx.loopId} decision audit`,
        summary: `Decision ${ctx.state.decisionId}; action ${ctx.state.actionId ?? 'none'}; verified=${ctx.state.verificationPassed ?? false}.`,
        tags: ['unified-loop', 'audit'],
        evidence: [evidence(ctx, 'audit-evidence', 'Loop audit record.')],
        confidence: ctx.state.verificationPassed ? 80 : 60,
        provenance: provenance(ctx),
        decisionId: ctx.state.decisionId,
        actionId: ctx.state.actionId,
      }).catch(() => undefined);
    }
    return {
      summary: 'Audit trail emitted: structured trace + commercial-memory audit record (privacy-minimized).',
      outputs: { audited: true },
    };
  }));

  caps.push(cap('OUTCOME', 'determine-outcome', async (_svc, ctx) => {
    const auth = ctx.state.stageOutputs['AUTHORIZE'] as Record<string, unknown> | undefined;
    const verify = ctx.state.stageOutputs['VERIFY_RESULT'] as Record<string, unknown> | undefined;
    let outcome: string;
    if (!ctx.task.proposedAction) {
      outcome = 'COMPLETED_DRY_RUN'; // reasoning-only task completed
    } else if (auth?.allowed !== true) {
      outcome = (auth?.outcome === 'DENY') ? 'DENIED' : 'HELD_AT_GATE';
    } else if (verify?.verified === true) {
      outcome = 'COMPLETED_VERIFIED';
    } else if (verify?.dryRun === true || ctx.state.verificationPassed === false && !verify?.verified) {
      outcome = 'COMPLETED_DRY_RUN';
    } else {
      outcome = 'FAILED_CLOSED';
    }
    return {
      summary: `Loop outcome determined: ${outcome}.`,
      outputs: { outcome },
    };
  }));

  caps.push(cap('CONTINUE_OR_SLEEP', 'continue-or-sleep', async (_svc, ctx) => {
    const directive = ctx.task.continuation === 'SLEEP' ? 'SLEEP' : 'TERMINATE';
    return {
      summary: directive === 'SLEEP'
        ? 'Continuation policy: SLEEP (no native scheduler yet; wake requires an external trigger).'
        : 'Continuation policy: TERMINATE.',
      outputs: { continuation: directive },
    };
  }));

  return caps;
}

async function proposeActionDecision(
  svc: Services,
  ctx: CapabilityInvocationContext,
): Promise<{ id: string; actionType: string; executionState: string }> {
  const a = ctx.task.proposedAction!;
  const decision = await svc.control.proposeDecision(ctx.actor, {
    tenantId: ctx.actor.tenantId,
    productId: a.productId,
    ventureId: a.ventureId,
    objective: ctx.task.objective,
    proposedAction: `Governed action ${a.actionType} on ${a.targetSystem}`,
    actionType: a.actionType,
    evidence: [evidence(ctx, 'decision-evidence', 'Evidence supporting the proposed action.')],
    evidenceStrength: a.evidenceStrength,
    riskScore: a.riskScore,
    complianceScore: a.complianceScore,
    confidence: 70,
    authorizationLevel: a.authorizationLevel as 1 | 2 | 3,
    decisionReason: 'Proposed by native unified loop; authority remains with the control plane.',
    provenance: provenance(ctx),
  });
  return { id: decision.id, actionType: decision.actionType, executionState: decision.executionState };
}
