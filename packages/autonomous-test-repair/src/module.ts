import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { TestRepairLoop } from './test-repair-loop.js';

/** Test/repair orchestration module with no default runner or patch application capability. */
export class AutonomousTestRepairModule implements IModule {
  readonly id = 'autonomous-test-repair';
  readonly tags = ['engineering', 'testing', 'repair', 'governance'] as const;
  readonly dependsOn = ['storage', 'autonomous-action-runtime'] as const;
  private readonly loop = new TestRepairLoop();

  async init(kernel: KernelApi): Promise<void> {
    const runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
    await this.loop.init(kernel, runtime);
    kernel.container.registerValue('autonomous-test-repair.loop', this.loop);
    kernel.container.registerValue('autonomous-test-repair', this.loop);
    kernel.logger.info('autonomous test/repair initialized (no runner or patch application configured)');
  }

  async start(_kernel: KernelApi): Promise<void> {
    // No test runner is launched until an authorized caller registers and invokes one.
  }

  async stop(_kernel: KernelApi): Promise<void> {
    // Persisted run metadata remains with the storage provider.
  }

  getLoop(): TestRepairLoop {
    return this.loop;
  }
}
