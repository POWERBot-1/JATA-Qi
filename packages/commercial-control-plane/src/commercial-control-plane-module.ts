import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CommercialControlPlaneService, type CommercialControlPlaneServiceConfig } from './commercial-control-plane-service.js';

export interface CommercialControlPlaneConfig extends CommercialControlPlaneServiceConfig {}

/**
 * First-class Commercial Control Plane module. It depends only on the existing
 * storage abstraction and defaults to conservative, policy-required behavior.
 */
export class CommercialControlPlaneModule implements IModule {
  readonly id = 'commercial-control-plane';
  readonly tags = ['commercial', 'governance', 'control-plane'] as const;
  readonly dependsOn = ['storage'] as const;
  private readonly service: CommercialControlPlaneService;

  constructor(config: CommercialControlPlaneConfig = {}) {
    this.service = new CommercialControlPlaneService(config);
  }

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('commercial-control-plane.service', this.service);
    kernel.container.registerValue('commercial-control-plane', this.service);
    kernel.logger.info('commercial control plane initialized (default-deny execution)');
  }

  async start(_kernel: KernelApi): Promise<void> {
    // The control plane never starts an autonomous worker implicitly.
  }

  async stop(_kernel: KernelApi): Promise<void> {
    // State is durably stored through the configured storage module.
  }

  getService(): CommercialControlPlaneService {
    return this.service;
  }
}
