import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CapabilityFabricService } from './capability-fabric-service.js';

/**
 * JQ-CAP / JQ-UCR registry. It records capability and ENGINE_GENOME metadata,
 * lifecycle evidence, scoped grants, composition graph, and audit history. It
 * does not discover/install/deploy/execute engines or grant external authority.
 */
export class CapabilityFabricModule implements IModule {
  readonly id = 'capability-fabric';
  readonly tags = ['jqb', 'capabilities', 'engines', 'registry', 'governance', 'lineage'] as const;
  readonly dependsOn = ['storage', 'permanence-fabric'] as const;
  private readonly service = new CapabilityFabricService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('capability-fabric.service', this.service);
    kernel.container.registerValue('capability-fabric', this.service);
    kernel.logger.info('capability fabric initialized (metadata/grants/audit only; no engine execution active)');
  }

  getService(): CapabilityFabricService {
    return this.service;
  }
}
