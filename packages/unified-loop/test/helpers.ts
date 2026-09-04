// Test harness: build a fully-wired, in-memory, deterministic JATA Qi kernel
// with the native unified loop and (optionally) a governed sandbox action
// adapter. No network, no providers, no external effects.

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { CommercialControlPlaneModule, type CommercialActor } from '@jataqi/commercial-control-plane';
import { AutonomousActionRuntimeModule, type ActionExecutionAdapter } from '@jataqi/autonomous-action-runtime';
import { ExternalConnectorModule } from '@jataqi/external-connectors';
import { PaymentsModule } from '@jataqi/payments';
import { BillingModule } from '@jataqi/billing';
import { RevenueLedgerModule } from '@jataqi/revenue-ledger';
import { ReconciliationModule } from '@jataqi/reconciliation';
import { CommercialAnalyticsModule } from '@jataqi/commercial-analytics';
import { CommercialIntelligenceModule } from '@jataqi/commercial-intelligence';
import { PortfolioGovernorModule } from '@jataqi/portfolio-governor';
import { CommercialMemoryModule } from '@jataqi/commercial-memory';
import { CommercialHealthModule } from '@jataqi/commercial-health';
import { CommercialObservabilityModule } from '@jataqi/commercial-observability';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import { CommercialCommandCenterModule } from '@jataqi/commercial-command-center';
import { AutonomousVentureFactoryModule } from '@jataqi/autonomous-venture-factory';
import { CognitiveKernelModule } from '@jataqi/cognitive-kernel';
import { MultiAgentCognitionModule } from '@jataqi/multi-agent-cognition';
import { MetaReasoningModule } from '@jataqi/meta-reasoning';
import { ProbabilisticEngineModule } from '@jataqi/probabilistic-engine';
import { HypothesisEngineModule } from '@jataqi/hypothesis-engine';
import { WorldModelModule } from '@jataqi/world-model';
import { CausalEngineModule } from '@jataqi/causal-engine';
import { TemporalEngineModule } from '@jataqi/temporal-engine';
import { ReproducibilityModule } from '@jataqi/reproducibility';
import { ResearchEvidenceModule } from '@jataqi/research-evidence';
import { HumanApprovalModule } from '@jataqi/human-approval';
import { RegulatoryGateModule } from '@jataqi/regulatory-gates';
import { PermanenceFabricModule } from '@jataqi/permanence-fabric';
import { CapabilityFabricModule } from '@jataqi/capability-fabric';
import { UnifiedLoopModule } from '../src/index.js';

export interface Harness {
  kernel: ReturnType<typeof createTestKernel>;
  actor: CommercialActor;
  admin: CommercialActor;
  other: CommercialActor;
  now: () => number;
  registerAdapter(adapter: ActionExecutionAdapter): void;
  createPolicy(admin: CommercialActor, opts: { actionType: string; allowExecution?: boolean; maxAutonomy?: 1 | 2 | 3; maxRisk?: number }): Promise<void>;
}

export async function buildHarness(): Promise<Harness> {
  // Deterministic monotonic clock.
  let t = 1_700_000_000_000;
  const now = (): number => t;
  const advance = (ms: number): void => { t += ms; };
  void advance;

  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now }));
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new ExternalConnectorModule());
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 128 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule({}));
  kernel.register(new PaymentsModule());
  kernel.register(new BillingModule());
  kernel.register(new RevenueLedgerModule());
  kernel.register(new ReconciliationModule());
  kernel.register(new CommercialAnalyticsModule());
  kernel.register(new CommercialIntelligenceModule());
  kernel.register(new PortfolioGovernorModule());
  kernel.register(new CommercialMemoryModule());
  kernel.register(new CommercialHealthModule());
  kernel.register(new CommercialObservabilityModule());
  kernel.register(new CommercialEventStreamModule());
  kernel.register(new CommercialCommandCenterModule());
  kernel.register(new AutonomousVentureFactoryModule());
  kernel.register(new CognitiveKernelModule());
  kernel.register(new ProbabilisticEngineModule());
  kernel.register(new WorldModelModule());
  kernel.register(new HypothesisEngineModule());
  kernel.register(new CausalEngineModule());
  kernel.register(new TemporalEngineModule());
  kernel.register(new MultiAgentCognitionModule());
  kernel.register(new MetaReasoningModule());
  kernel.register(new ReproducibilityModule());
  kernel.register(new ResearchEvidenceModule());
  kernel.register(new HumanApprovalModule());
  kernel.register(new RegulatoryGateModule());
  kernel.register(new PermanenceFabricModule());
  kernel.register(new CapabilityFabricModule());
  kernel.register(new UnifiedLoopModule());
  await kernel.boot();

  const actor: CommercialActor = { id: 'loop-agent', tenantId: 'acme', roles: ['agent', 'operator'] };
  const admin: CommercialActor = { id: 'loop-admin', tenantId: 'acme', roles: ['admin'] };
  const other: CommercialActor = { id: 'loop-other', tenantId: 'other', roles: ['agent', 'operator'] };

  const runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
  const control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();

  return {
    kernel,
    actor,
    admin,
    other,
    now,
    registerAdapter(adapter: ActionExecutionAdapter): void { runtime.registerAdapter(adapter); },
    async createPolicy(adminActor, opts): Promise<void> {
      await control.createPolicy(adminActor, {
        version: `loop-policy:${opts.actionType}`,
        scope: { tenantId: 'acme' },
        maximumAutonomyLevel: opts.maxAutonomy ?? 2,
        allowExecution: opts.allowExecution ?? true,
        allowedActionTypes: [opts.actionType],
        maximumRiskScore: opts.maxRisk ?? 60,
        minimumComplianceScore: 80,
        minimumEvidenceStrength: 70,
      });
    },
  };
}

/** A deterministic sandbox action adapter for tests. */
export function sandboxAdapter(
  actionType: string,
  targetSystem: string,
  opts: { executeFails?: boolean; verifyFails?: boolean } = {},
): ActionExecutionAdapter {
  return {
    id: `sandbox:${targetSystem}`,
    targetSystem,
    actionTypes: [actionType],
    environment: 'sandbox',
    maxAttempts: 1,
    defaultTimeoutMs: 500,
    async execute() {
      if (opts.executeFails) {
        return { reportedSuccess: false, summary: 'Sandbox adapter forced execution failure.', externalResponse: { ok: false } };
      }
      return { reportedSuccess: true, summary: 'Sandbox adapter executed (no external side effect).', externalResponse: { ok: true, sandbox: true } };
    },
    async verify() {
      if (opts.verifyFails) {
        return { verified: false, evidence: [], summary: 'Sandbox verification forced to fail.' };
      }
      return {
        verified: true,
        summary: 'Sandbox adapter independently verified.',
        evidence: [{
          id: `verify:${targetSystem}`, status: 'DEMONSTRATED', source: 'sandbox-adapter', observedAt: Date.now(),
          confidence: 95, summary: 'Sandbox verification evidence.', provenance: { source: 'sandbox-adapter', collectedAt: Date.now() },
        }],
        externalState: { verified: true },
      };
    },
  };
}

export const OBSERVATIONS = [
  'Acme Corporation launched a subscription product in the Kenya market in Q2 with measurable activation growth.',
  'Customer churn declined after onboarding improvements; support tickets dropped month over month.',
  'The proposed campaign targets existing users with a bounded, low-risk re-engagement action.',
];
