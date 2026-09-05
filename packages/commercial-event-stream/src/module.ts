import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CommercialEventStreamService, type CommercialEventStreamConfig } from './commercial-event-stream-service.js';

export interface CommercialEventStreamModuleConfig extends CommercialEventStreamConfig {}

/**
 * T-05 canonical durable delivery module. Hosts invoke `pump()` explicitly
 * (the `jataqi host` runtime does so every supervised cycle); `start()`
 * subscribes the in-process post-commit wake-up and `stop()` drains it.
 */
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
    kernel.logger.info(`commercial event stream initialized (durable unified-outbox worker ${this.service.getWorkerId()}; explicit pump + post-commit wake-up)`);
  }

  async start(_kernel: KernelApi): Promise<void> {
    this.service.start();
  }

  async stop(_kernel: KernelApi): Promise<void> {
    await this.service.stop();
  }

  getService(): CommercialEventStreamService {
    return this.service;
  }
}
