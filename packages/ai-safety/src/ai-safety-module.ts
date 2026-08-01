// AiSafetyModule — kernel module that owns a PromptGuard and provides guardrails
// for the agent runtime. The gateway and orchestrator can call scan() before
// any LLM invocation to block injection attempts and redact PII.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { PromptGuard, type GuardConfig, type GuardResult } from './prompt-guard.js';

export interface AiSafetyConfig {
  guard?: GuardConfig;
}

export class AiSafetyModule implements IModule {
  readonly id = 'ai-safety';
  readonly tags = ['core', 'governance'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly guard: PromptGuard;

  constructor(cfg: AiSafetyConfig = {}) {
    this.guard = new PromptGuard(cfg.guard);
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('ai-safety', this);
    kernel.logger.info('ai-safety module initialized (prompt injection guard)');
  }

  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {}

  /** Scan input for safety violations; returns the guard result. */
  scan(input: string): GuardResult {
    const result = this.guard.scan(input);
    if (result.violations.length > 0) {
      void this.api.bus.emit('ai-safety.violation', {
        risk: result.risk,
        blocked: result.blocked,
        count: result.violations.length,
        types: result.violations.map((v) => v.type),
      });
    }
    return result;
  }

  /** Quick boolean: should this input be blocked? */
  isBlocked(input: string): boolean { return this.guard.isBlocked(input); }
}
