import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { ExternalConnectorRegistry } from './registry.js';

/** Capability registry for external systems; no connector is active by default. */
export class ExternalConnectorModule implements IModule {
  readonly id = 'external-connectors';
  readonly tags = ['commercial', 'connectors', 'governance', 'integration'] as const;
  readonly dependsOn = ['commercial-control-plane', 'autonomous-action-runtime'] as const;
  private readonly registry = new ExternalConnectorRegistry();

  async init(kernel: KernelApi): Promise<void> {
    await this.registry.init(kernel);
    kernel.container.registerValue('external-connectors.registry', this.registry);
    kernel.container.registerValue('external-connectors', this.registry);
    kernel.logger.info('external connector fabric initialized (no connector active)');
  }

  async start(_kernel: KernelApi): Promise<void> {
    // Connectors require explicit activation; never connect at process startup.
  }

  async stop(_kernel: KernelApi): Promise<void> {
    // Registered in-process adapter handles are released with process shutdown.
  }

  getRegistry(): ExternalConnectorRegistry {
    return this.registry;
  }
}
