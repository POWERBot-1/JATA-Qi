import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CommercialEventStreamService, type CommercialEventStreamConfig } from './commercial-event-stream-service.js';

export interface CommercialEventStreamModuleConfig extends CommercialEventStreamConfig {}

/** Durable event delivery module. Hosts must invoke pump() explicitly or wire an approved worker. */
export class CommercialEventStreamModule implements IModule {
  readonly id = 'commercial-event-stream';
  readonly tags = ['commercial', 'events', 'delivery', 'replay', 'governance'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane'] as const;
  private readonly service: CommercialEventStreamService;

  constructor(config: CommercialEventStreamModuleConfig = {}) {
    this.service = new CommercialEventStreamService(config);
  }

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('commercial-event-stream.service', this.service);
    kernel.container.registerValue('commercial-event-stream', this.service);
    kernel.logger.info('commercial event stream initialized (manual pump; no handler registered)');
  }

  getService(): CommercialEventStreamService {
    return this.service;
  }
}
