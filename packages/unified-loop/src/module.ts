import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { UnifiedLoopService } from './unified-loop-service.js';

/**
 * W22 (C-1) native unified-loop module.
 *
 * This is the in-repo orchestration driver. It owns the canonical
 * cognitive/execution state machine and invokes JATA Qi's existing engines
 * through governed capability contracts. It adds no intelligence engine, no
 * provider, and no external side effect of its own: all authority stays with
 * the commercial control plane and all reasoning stays with the existing
 * engines. Boot performs no action.
 */
export class UnifiedLoopModule implements IModule {
  readonly id = 'unified-loop';
  readonly tags = ['jqb', 'orchestration', 'loop', 'governance'] as const;
  // Consumes the existing fabric; ordering places it after the engines it drives.
  readonly dependsOn = [
    'storage',
    'commercial-control-plane',
    'autonomous-action-runtime',
    'cognitive-kernel',
    'world-model',
    'knowledge',
    'knowledge-graph',
    'hypothesis-engine',
    'probabilistic-engine',
    'causal-engine',
    'temporal-engine',
    'multi-agent-cognition',
    'meta-reasoning',
    'reconciliation',
    'commercial-memory',
  ] as const;

  private service: UnifiedLoopService | undefined;

  async init(kernel: KernelApi): Promise<void> {
    this.service = new UnifiedLoopService(kernel);
    kernel.container.registerValue('unified-loop.service', this.service);
    kernel.container.registerValue('unified-loop', this.service);
    kernel.logger.info('unified loop initialized (native C-1 orchestration driver; no action taken at boot)');
  }

  getService(): UnifiedLoopService {
    if (!this.service) throw new Error('Unified loop module is not initialized.');
    return this.service;
  }
}
