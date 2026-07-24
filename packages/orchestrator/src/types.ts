// JATA Qi Orchestrator — workflow execution types.
//
// The orchestrator is the runtime's Workflow Engine and Mission Coordinator
// (Step 3 #4 Orchestration Engine, Step 6 MAIF, Step 15 Workflow Engine). It
// takes a compiled QiL ExecutionPlan and runs its steps in dependency order,
// fusing retrieval, agent reasoning and reporting into a single audited result.

import type { StepKind } from '@jataqi/qil';
import type { Principal } from '@jataqi/security';

export interface StepResult {
  stepId: string;
  kind: StepKind;
  keyword: string;
  status: 'success' | 'skipped' | 'error';
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface ExecutionResult {
  id: string;
  planId?: string;
  mission?: string;
  goals: string[];
  status: 'completed' | 'failed' | 'stopped';
  steps: StepResult[];
  /** Human-readable structured response (produced by REPORT or synthesized). */
  finalReport: string;
  /** Knowledge snippets accumulated by RETRIEVE steps. */
  retrieved: string[];
  startedAt: number;
  finishedAt: number;
  /** Id of the audit record written for this execution, when security is present. */
  auditRecordId?: string;
}

export interface ExecuteOptions {
  /** Authenticated principal, used for audit attribution. */
  principal?: Principal;
  /** Default agent name to route reasoning steps to (default "main"). */
  agent?: string;
  /** Number of chunks each RETRIEVE pulls (default 4). */
  topK?: number;
}

export const OrchestratorEvents = Object.freeze({
  ExecutionStarted: 'orchestrator.execution.started',
  StepStarted: 'orchestrator.step.started',
  StepCompleted: 'orchestrator.step.completed',
  ExecutionCompleted: 'orchestrator.execution.completed',
} as const);
