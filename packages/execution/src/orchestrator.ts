// PLAN → EXECUTE → VERIFY → ROLLBACK Workflow Orchestrator with Human Governance and Checkpoints.

import type { ExecutionPlan, WorkflowCheckpoint, WorkflowStatus, RiskLevel } from './types.js';
import type { UniversalToolFabric } from './tool-fabric.js';

export class WorkflowOrchestrator {
  private readonly checkpoints = new Map<string, WorkflowCheckpoint>();
  private approvalCallback?: (plan: ExecutionPlan) => Promise<boolean>;

  constructor(private readonly toolFabric: UniversalToolFabric) {}

  setApprovalCallback(cb: (plan: ExecutionPlan) => Promise<boolean>): void {
    this.approvalCallback = cb;
  }

  async executeWorkflow(
    plan: ExecutionPlan,
    userPermissions: string[] = []
  ): Promise<{ status: WorkflowStatus; results: unknown[]; error?: string }> {
    const results: unknown[] = [];
    let status: WorkflowStatus = 'PLANNED';

    // 1. Human Governance Check for High/Critical Risk
    if (plan.riskLevel === 'high' || plan.riskLevel === 'critical' || plan.requiresApproval) {
      status = 'REQUIRES_HUMAN_APPROVAL';
      if (!this.approvalCallback) {
        return { status, results: [], error: 'Workflow requires human approval, but no approval callback is registered.' };
      }
      const approved = await this.approvalCallback(plan);
      if (!approved) {
        return { status: 'ABORTED', results: [], error: 'Workflow aborted: human approval denied.' };
      }
    }

    // 2. Create Checkpoint
    status = 'CHECKPOINTED';
    const checkpointId = `chk-${Math.random().toString(36).substring(2, 8)}`;
    this.checkpoints.set(checkpointId, {
      checkpointId,
      planId: plan.planId,
      stateSnapshot: { stepCount: plan.steps.length, timestamp: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });

    // 3. Execute Steps
    status = 'EXECUTING';
    const executedSteps: Array<{ toolName: string; input: Record<string, unknown>; output: unknown; compensatingAction?: { toolName: string; input: Record<string, unknown> } }> = [];

    try {
      for (const step of plan.steps) {
        const output = await this.toolFabric.executeTool(step.toolName, step.input, userPermissions);
        results.push(output);
        executedSteps.push({
          toolName: step.toolName,
          input: step.input,
          output,
          compensatingAction: step.compensatingAction,
        });
      }

      // 4. Verify
      status = 'VERIFYING';
      const verificationPassed = results.every((r) => r !== undefined && r !== null);
      if (!verificationPassed) {
        throw new Error('Verification failed: one or more workflow steps returned invalid/null output.');
      }

      status = 'COMPLETED';
      return { status, results };
    } catch (err) {
      status = 'VERIFICATION_FAILED';
      // 5. Rollback / Compensating Actions
      status = 'ROLLING_BACK';
      const rollbackErrors: string[] = [];
      // execute compensating actions in reverse order
      for (let i = executedSteps.length - 1; i >= 0; i--) {
        const step = executedSteps[i]!;
        if (step.compensatingAction) {
          try {
            await this.toolFabric.executeTool(step.compensatingAction.toolName, step.compensatingAction.input, userPermissions);
          } catch (rbErr) {
            rollbackErrors.push(String(rbErr));
          }
        }
      }
      status = 'ROLLED_BACK';
      return {
        status,
        results,
        error: `Workflow failed and rolled back. Error: ${String(err)}. Rollback errors: ${rollbackErrors.join(', ')}`,
      };
    }
  }

  getCheckpoint(checkpointId: string): WorkflowCheckpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }
}
