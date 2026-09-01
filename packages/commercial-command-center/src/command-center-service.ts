import type { KernelApi } from '@jataqi/core-kernel';
import { AutonomousDeploymentModule } from '@jataqi/autonomous-deployment';
import { AutonomousTestRepairModule } from '@jataqi/autonomous-test-repair';
import { BillingModule } from '@jataqi/billing';
import { CommercialAnalyticsModule } from '@jataqi/commercial-analytics';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type { ApprovalRequest, ApprovalState, CommercialActor, CommercialControlPlaneService } from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import { CommercialHealthModule } from '@jataqi/commercial-health';
import { CommercialIntelligenceModule } from '@jataqi/commercial-intelligence';
import { CommercialMemoryModule } from '@jataqi/commercial-memory';
import { CommercialObservabilityModule } from '@jataqi/commercial-observability';
import { CopilotExecutionAdapterModule } from '@jataqi/copilot-execution-adapter';
import { ExternalConnectorModule } from '@jataqi/external-connectors';
import { GitHubExecutionModule } from '@jataqi/github-execution';
import { InfrastructureStateRegistryModule } from '@jataqi/infrastructure-state-registry';
import { PaymentsModule } from '@jataqi/payments';
import { PortfolioGovernorModule } from '@jataqi/portfolio-governor';
import { ReconciliationModule } from '@jataqi/reconciliation';
import { RevenueLedgerModule } from '@jataqi/revenue-ledger';
import { UniversalDistributionNervousSystemModule } from '@jataqi/universal-distribution-nervous-system';
import { UniversalVisibilityFabricModule } from '@jataqi/universal-visibility-fabric';
import type { ApprovalQueueItem, CommandCenterSnapshot } from './types.js';

/**
 * Read-only command-center projection over existing module APIs. It does not
 * use storage directly, invoke a connector, perform a deployment, or consume
 * a budget. Approval decisions are delegated unchanged to the control plane.
 */
export class CommercialCommandCenterService {
  private kernel!: KernelApi;
  private controlPlane!: CommercialControlPlaneService;

  async init(kernel: KernelApi): Promise<void> {
    this.kernel = kernel;
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  }

  async snapshot(actor: CommercialActor): Promise<CommandCenterSnapshot> {
    assertViewer(actor);
    const [approvals, decisions, authorizations, actions, budgets, killSwitches, connectors, experiments] = await Promise.all([
      this.controlPlane.listApprovals(actor),
      this.controlPlane.listDecisions(actor),
      this.controlPlane.listAuthorizations(actor),
      this.controlPlane.listActions(actor),
      this.controlPlane.listBudgets(actor),
      this.controlPlane.listKillSwitches(actor),
      this.controlPlane.listConnectors(actor),
      this.controlPlane.listExperiments(actor),
    ]);
    const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
    const approvalQueue: ApprovalQueueItem[] = approvals
      .filter((approval) => approval.state === 'PENDING')
      .map((approval) => ({ approval, decision: decisionById.get(approval.decisionId) }));
    const unavailable: string[] = [];
    const result: CommandCenterSnapshot = {
      tenantId: actor.tenantId,
      generatedAt: Date.now(),
      approvals: approvalQueue,
      decisions,
      authorizations,
      actions,
      budgets,
      activeKillSwitches: killSwitches.filter((killSwitch) => killSwitch.active),
      connectors,
      experiments,
      unavailable,
    };

    const payments = this.optional(PaymentsModule, 'payments', unavailable);
    const billing = this.optional(BillingModule, 'billing', unavailable);
    const analytics = this.optional(CommercialAnalyticsModule, 'commercial-analytics', unavailable);
    const reconciliation = this.optional(ReconciliationModule, 'reconciliation', unavailable);
    if (payments && billing && analytics && reconciliation) {
      const [analyticsSnapshot, paymentRecords, invoiceRecords, reconciliationRuns] = await Promise.all([
        analytics.getService().snapshot(actor),
        payments.getService().listPayments(actor),
        billing.getService().listInvoices(actor),
        reconciliation.getService().listRuns(actor),
      ]);
      result.financial = {
        analytics: analyticsSnapshot,
        reconciliation: reconciliationRuns,
        paymentStates: countBy(paymentRecords, (payment) => payment.status),
        invoiceStates: countBy(invoiceRecords, (invoice) => invoice.status),
      };
    }

    const health = this.optional(CommercialHealthModule, 'commercial-health', unavailable);
    if (health) {
      const [anomalies, drift] = await Promise.all([health.getService().listAnomalies(actor), health.getService().listDrift(actor)]);
      result.health = { anomalies, drift };
    }

    const observability = this.optional(CommercialObservabilityModule, 'commercial-observability', unavailable);
    if (observability) {
      const [snapshot, alerts, incidents] = await Promise.all([
        observability.getService().snapshot(actor),
        observability.getService().listAlerts(actor),
        observability.getService().listIncidents(actor),
      ]);
      result.observability = {
        snapshot,
        activeAlerts: alerts.filter((alert) => alert.status !== 'RESOLVED'),
        activeIncidents: incidents.filter((incident) => !['RESOLVED', 'CLOSED'].includes(incident.status)),
      };
    }

    const events = this.optional(CommercialEventStreamModule, 'commercial-event-stream', unavailable);
    if (events) {
      const [deadLetters, deliveries] = await Promise.all([events.getService().listDeadLetters(actor), events.getService().listDeliveries(actor)]);
      result.eventDelivery = { deadLetters, retrying: deliveries.filter((delivery) => delivery.state === 'RETRYING') };
    }

    const intelligence = this.optional(CommercialIntelligenceModule, 'commercial-intelligence', unavailable);
    if (intelligence) result.readiness = await intelligence.getService().listReadiness(actor);

    const portfolio = this.optional(PortfolioGovernorModule, 'portfolio-governor', unavailable);
    if (portfolio) {
      const [assessments, allocations] = await Promise.all([portfolio.getService().listAssessments(actor), portfolio.getService().listAllocations(actor)]);
      result.portfolio = { assessments, allocations };
    }

    const memory = this.optional(CommercialMemoryModule, 'commercial-memory', unavailable);
    if (memory) {
      const [learning, failures, prohibited] = await Promise.all([
        memory.getService().query(actor, { kind: 'LEARNING' }),
        memory.getService().query(actor, { kind: 'FAILURE' }),
        memory.getService().query(actor, { kind: 'PROHIBITED_STRATEGY' }),
      ]);
      result.memory = { learningCount: learning.length, failureCount: failures.length, prohibitedStrategyCount: prohibited.length };
    }

    // These checks make unconfigured or missing operational planes visible to
    // callers without fabricating health or availability values.
    const optionalModules: Array<[new (...args: never[]) => { id: string }, string]> = [
      [ExternalConnectorModule, 'external-connectors'],
      [GitHubExecutionModule, 'github-execution'],
      [CopilotExecutionAdapterModule, 'copilot-execution-adapter'],
      [AutonomousTestRepairModule, 'autonomous-test-repair'],
      [AutonomousDeploymentModule, 'autonomous-deployment'],
      [InfrastructureStateRegistryModule, 'infrastructure-state-registry'],
      [RevenueLedgerModule, 'revenue-ledger'],
      [UniversalVisibilityFabricModule, 'universal-visibility-fabric'],
      [UniversalDistributionNervousSystemModule, 'universal-distribution-nervous-system'],
    ];
    for (const [moduleType, name] of optionalModules) {
      if (!this.optional(moduleType, name, [])) unavailable.push(name);
    }
    return result;
  }

  /** Approval facade; all authorization checks remain in CommercialControlPlaneService. */
  async resolveApproval(actor: CommercialActor, approvalId: string, state: Extract<ApprovalState, 'APPROVED' | 'REJECTED' | 'DEFERRED'>, reason: string): Promise<ApprovalRequest> {
    return this.controlPlane.resolveApproval(actor, approvalId, state, reason);
  }

  private optional<T extends { id: string }>(moduleType: new (...args: never[]) => T, id: string, unavailable: string[]): T | undefined {
    try {
      return this.kernel.getModule<T>(id);
    } catch {
      unavailable.push(id);
      return undefined;
    }
  }
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function assertViewer(actor: CommercialActor): void {
  if (!actor.roles.some((role) => ['observer', 'agent', 'operator', 'approver', 'admin', 'global_admin', 'system'].includes(role))) {
    throw new Error('A commercial viewer role is required.');
  }
}
