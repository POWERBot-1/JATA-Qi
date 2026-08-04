// AutomationModule (Phase 6 — SOMA AI) — kernel module for the Intelligent
// Automation Engine. Registers the platform action runner, subscribes event
// triggers to the kernel bus, ticks schedule triggers, and exposes the
// automation API. All platform dependencies are soft — the engine runs on
// any kernel and actions fail gracefully when a module is absent.

import type { KernelApi, IModule, EventHandler } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import type { NotificationsModule } from '@jataqi/notifications';
import type { KnowledgeService } from '@jataqi/knowledge-service';
import type { AgentRuntimeModule } from '@jataqi/agent-runtime';
import type { ToolIntelligenceModule } from '@jataqi/tool-intelligence';
import { AutomationEngine, type RunAutomationInput } from './engine.js';
import { PlatformActionRunner } from './actions.js';
import type {
  Automation, AutomationExecution, AutomationStats, CreateAutomationInput, ExecutionStatus, TriggerType,
} from './types.js';

export const AutomationEvents = Object.freeze({
  AutomationCreated: 'automation.created',
  AutomationUpdated: 'automation.updated',
  AutomationRemoved: 'automation.removed',
  AutomationRun: 'automation.run',
  AutomationFinished: 'automation.finished',
} as const);

export interface AutomationModuleConfig {
  /** Schedule-trigger polling interval in ms (0 disables the ticker). */
  tickIntervalMs?: number;
}

export class AutomationModule implements IModule {
  readonly id = 'automation';
  readonly tags = ['core', 'automation'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private readonly cfg: Required<AutomationModuleConfig>;
  private engine!: AutomationEngine;
  private ticker: NodeJS.Timeout | undefined;
  /** event name → handlers (one per subscribed automation). */
  private subscriptions = new Map<string, Array<{ automationId: string; handler: EventHandler }>>();

  constructor(cfg: AutomationModuleConfig = {}) {
    this.cfg = { tickIntervalMs: cfg.tickIntervalMs ?? 1000 };
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    this.engine = new AutomationEngine(new PlatformActionRunner({
      memory: this.tryModule<DigitalMemoryModule>('memory'),
      notifications: this.tryModule<NotificationsModule>('notifications'),
      knowledge: this.tryModule<KnowledgeService>('knowledge'),
      agents: this.tryModule<AgentRuntimeModule>('agent-runtime'),
      tools: this.tryModule<ToolIntelligenceModule>('tool-intelligence'),
      automation: {
        run: (input) => this.engine.run({ ...input, trigger: 'manual' }),
      },
    }));
    kernel.container.registerValue('automation', this);
    kernel.logger.info('automation module initialized (SOMA AI engine)');
  }

  async start(_kernel: KernelApi): Promise<void> {
    if (this.cfg.tickIntervalMs > 0) {
      this.ticker = setInterval(() => void this.engine.tick(), this.cfg.tickIntervalMs);
    }
  }

  async stop(_kernel: KernelApi): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    for (const [event, subs] of this.subscriptions) {
      for (const sub of subs) this.api.bus.off(event, sub.handler);
    }
    this.subscriptions.clear();
  }

  // ---- registry ----------------------------------------------------------

  create(input: CreateAutomationInput): Automation {
    const automation = this.engine.register(input);
    void this.api.bus.emit(AutomationEvents.AutomationCreated, { id: automation.id, name: automation.name, trigger: automation.trigger.type });
    this.refreshSubscriptions(automation.id);
    return automation;
  }

  get(id: string): Automation | undefined { return this.engine.get(id); }

  list(filter?: { enabled?: boolean; trigger?: TriggerType }): Automation[] {
    return this.engine.list(filter);
  }

  remove(id: string): boolean {
    this.unsubscribe(id);
    const removed = this.engine.unregister(id);
    if (removed) void this.api.bus.emit(AutomationEvents.AutomationRemoved, { id });
    return removed;
  }

  setEnabled(id: string, enabled: boolean): Automation | undefined {
    const automation = this.engine.setEnabled(id, enabled);
    if (automation) {
      void this.api.bus.emit(AutomationEvents.AutomationUpdated, { id, enabled });
      this.refreshSubscriptions(id);
    }
    return automation;
  }

  // ---- execution ---------------------------------------------------------

  /** Run an automation now (manual trigger or chained). */
  async run(input: RunAutomationInput): Promise<AutomationExecution> {
    void this.api.bus.emit(AutomationEvents.AutomationRun, { automationId: input.automationId, trigger: input.trigger ?? 'manual' });
    const execution = await this.engine.run(input);
    void this.api.bus.emit(AutomationEvents.AutomationFinished, {
      automationId: execution.automationId, status: execution.status, durationMs: execution.durationMs,
    });
    return execution;
  }

  /** Advance schedule triggers (exposed for tests / manual tick). */
  async tick(now = Date.now()): Promise<AutomationExecution[]> {
    return this.engine.tick(now);
  }

  executions(filter?: { automationId?: string; status?: ExecutionStatus }): AutomationExecution[] {
    return this.engine.executionsList(filter);
  }

  stats(): AutomationStats { return this.engine.stats(); }

  // ---- internals ---------------------------------------------------------

  private refreshSubscriptions(automationId: string): void {
    const automation = this.engine.get(automationId);
    if (!automation) return;
    this.unsubscribe(automationId);
    if (!automation.enabled || automation.trigger.type !== 'event') return;
    const event = automation.trigger.event;
    const handler: EventHandler = (payload) => {
      void this.engine.handleEvent(event, payload);
    };
    const subs = this.subscriptions.get(event) ?? [];
    subs.push({ automationId, handler });
    this.subscriptions.set(event, subs);
    this.api.bus.on(event, handler);
  }

  private unsubscribe(automationId: string): void {
    for (const [event, subs] of this.subscriptions) {
      const remaining = subs.filter((s) => s.automationId !== automationId);
      for (const removed of subs.filter((s) => s.automationId === automationId)) {
        this.api.bus.off(event, removed.handler);
      }
      if (remaining.length > 0) this.subscriptions.set(event, remaining);
      else this.subscriptions.delete(event);
    }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
