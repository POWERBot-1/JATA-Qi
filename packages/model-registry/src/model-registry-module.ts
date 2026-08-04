// ModelRegistryModule — kernel module exposing the model catalog and selector.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { ModelRegistryEvents } from './types.js';
import type { ModelDescriptor, SelectionRequest, SelectionResult } from './types.js';
import { select as selectModels } from './selector.js';

export interface ModelRegistryConfig {
  /** Models to seed the catalog with at init. */
  models?: ModelDescriptor[];
}

export class ModelRegistryModule implements IModule {
  readonly id = 'model-registry';
  readonly tags = ['intelligence', 'model'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private models = new Map<string, ModelDescriptor>();

  constructor(private readonly cfg: ModelRegistryConfig = {}) {}

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('model-registry', this);
    for (const m of this.cfg.models ?? []) this.register(m);
    kernel.logger.info(`model registry initialized (${this.models.size} model(s))`);
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { this.models.clear(); }

  register(model: ModelDescriptor): void {
    this.models.set(model.id, model);
    void this.api.bus.emit(ModelRegistryEvents.ModelRegistered, { id: model.id });
  }

  unregister(id: string): boolean {
    const removed = this.models.delete(id);
    if (removed) void this.api.bus.emit(ModelRegistryEvents.ModelUnregistered, { id });
    return removed;
  }

  get(id: string): ModelDescriptor | undefined {
    return this.models.get(id);
  }

  list(): ModelDescriptor[] {
    return [...this.models.values()];
  }

  byCapability(capability: string): ModelDescriptor[] {
    return this.list().filter((m) => m.capabilities.includes(capability));
  }

  /** Select the best model for a request (emits a selection event). */
  async select(req: SelectionRequest = {}): Promise<SelectionResult> {
    const result = selectModels(this.list(), req);
    if (result.model) {
      await this.api.bus.emit(ModelRegistryEvents.ModelSelected, {
        id: result.model.id,
        candidates: result.candidates,
        prefer: req.prefer ?? 'quality',
      });
    }
    return { model: result.model, candidates: result.candidates, ...(result.score !== undefined ? { score: result.score } : {}), rationale: result.rationale };
  }
}
