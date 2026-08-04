// ActionRunner — executes automation actions against the platform modules.
// All module references are optional (soft dependencies): an action whose
// backing module is absent fails with a clear message, so the automation
// engine degrades gracefully on partial kernels.

import type {
  ActionRunner, ActionResult, AutomationAction, AutomationExecution, RunContext,
} from './types.js';
import { MAX_CHAIN_DEPTH } from './types.js';

/** Minimal structural types for the platform modules we call. */
export interface ActionDeps {
  memory?: {
    record(input: {
      category: string;
      summary: string;
      userId?: string;
      orgId?: string;
      tags?: string[];
      data?: Record<string, unknown>;
    }): Promise<{ recorded: boolean; event?: { id: string }; reason?: string }>;
  };
  notifications?: {
    notify(recipientId: string, payload: {
      type: string;
      title: string;
      body?: string;
      priority?: string;
      data?: Record<string, unknown>;
    }): Promise<unknown>;
  };
  knowledge?: {
    ingestText(text: string, opts?: {
      title?: string;
      contentType?: string;
      metadata?: Record<string, unknown>;
    }): Promise<{ id: string; chunkIds: string[] }>;
  };
  agents?: {
    run(message: string, opts?: Record<string, unknown>): Promise<{ answer: string; finishedReason: string }>;
  };
  tools?: {
    invoke(toolId: string, input: unknown): Promise<unknown>;
  };
  /** Chained automation runner (the owning module) with depth guard. */
  automation?: {
    run(input: { automationId: string; trigger: 'manual' | 'event' | 'schedule'; payload?: Record<string, unknown>; depth: number }): Promise<AutomationExecution>;
  };
}

export class PlatformActionRunner implements ActionRunner {
  constructor(private readonly deps: ActionDeps) {}

  async run(action: AutomationAction, ctx: RunContext): Promise<ActionResult> {
    const started = Date.now();
    const ok = (detail?: string): ActionResult => ({ action: action.name ?? action.type, status: 'ok', detail, durationMs: Date.now() - started });
    const fail = (detail: string): ActionResult => ({ action: action.name ?? action.type, status: 'error', detail, durationMs: Date.now() - started });
    const need = <T>(mod: T | undefined, name: string): T | never => {
      if (!mod) throw new Error(`${name} module not registered`);
      return mod;
    };
    try {
      switch (action.type) {
        case 'memory.record': {
          const memory = need(this.deps.memory, 'memory');
          const summary = str(action.params.summary);
          if (!summary) return fail('memory.record requires params.summary');
          const res = await memory.record({
            category: str(action.params.category) ?? 'command',
            summary,
            ...(str(action.params.userId) ? { userId: str(action.params.userId)! } : {}),
            ...(str(action.params.orgId) ? { orgId: str(action.params.orgId)! } : {}),
            ...(Array.isArray(action.params.tags) ? { tags: action.params.tags.map(String) } : {}),
            ...(action.params.data && typeof action.params.data === 'object'
              ? { data: action.params.data as Record<string, unknown> }
              : {}),
          });
          return res.recorded ? ok(`memory event ${res.event?.id ?? ''}`.trim()) : fail(`memory rejected: ${res.reason ?? 'unknown'}`);
        }
        case 'notification.send': {
          const notifications = need(this.deps.notifications, 'notifications');
          const recipientId = str(action.params.recipientId);
          const title = str(action.params.title);
          if (!recipientId || !title) return fail('notification.send requires params.recipientId and params.title');
          await notifications.notify(recipientId, {
            type: str(action.params.type) ?? 'automation',
            title,
            ...(str(action.params.body) ? { body: str(action.params.body)! } : {}),
            ...(str(action.params.priority) ? { priority: str(action.params.priority)! } : {}),
            ...(action.params.data && typeof action.params.data === 'object'
              ? { data: action.params.data as Record<string, unknown> }
              : {}),
          });
          return ok(`notification delivered to ${recipientId}`);
        }
        case 'knowledge.ingest': {
          const knowledge = need(this.deps.knowledge, 'knowledge');
          const text = str(action.params.text);
          if (!text) return fail('knowledge.ingest requires params.text');
          const doc = await knowledge.ingestText(text, {
            ...(str(action.params.title) ? { title: str(action.params.title)! } : {}),
            ...(str(action.params.contentType) ? { contentType: str(action.params.contentType)! } : {}),
            ...(action.params.metadata && typeof action.params.metadata === 'object'
              ? { metadata: action.params.metadata as Record<string, unknown> }
              : {}),
          });
          return ok(`ingested doc ${doc.id} (${doc.chunkIds.length} chunks)`);
        }
        case 'agent.run': {
          const agents = need(this.deps.agents, 'agent-runtime');
          const message = str(action.params.message);
          if (!message) return fail('agent.run requires params.message');
          const res = await agents.run(message, {
            ...(str(action.params.agent) ? { agent: str(action.params.agent)! } : {}),
            ...(typeof action.params.maxIterations === 'number' ? { maxIterations: action.params.maxIterations } : {}),
          });
          return ok(`agent ${res.finishedReason}: ${res.answer.slice(0, 120)}`);
        }
        case 'tool.invoke': {
          const tools = need(this.deps.tools, 'tool-intelligence');
          const toolId = str(action.params.toolId);
          if (!toolId) return fail('tool.invoke requires params.toolId');
          const input = action.params.input ?? {};
          await tools.invoke(toolId, input);
          return ok(`tool ${toolId} invoked`);
        }
        case 'automation.run': {
          const automation = need(this.deps.automation, 'automation');
          const automationId = str(action.params.automationId);
          if (!automationId) return fail('automation.run requires params.automationId');
          const depth = (ctx.depth ?? 0) + 1;
          if (depth > MAX_CHAIN_DEPTH) return fail(`max automation chain depth (${MAX_CHAIN_DEPTH}) reached`);
          const res = await automation.run({
            automationId,
            trigger: 'manual',
            ...(ctx.payload ? { payload: ctx.payload } : {}),
            depth,
          });
          return res.status === 'skipped' || res.status === 'failed' || res.status === 'timeout'
            ? fail(`chained run ${res.status}: ${res.error ?? 'no detail'}`)
            : ok(`chained run ${res.status} (${res.results.length} actions)`);
        }
        default:
          return fail(`unknown action type "${(action as { type: string }).type}"`);
      }
    } catch (err) {
      return fail((err as Error).message);
    }
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
