import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { AUTHORIZATION_GATE_TOKEN, type AuthorizationGate } from '@jataqi/authorization-boundary';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { ActionRuntimeService, type ActionRuntimeServiceOptions } from './action-runtime-service.js';

/**
 * Explicit action-runtime module. It starts no worker and registers no external
 * credentials or providers by default; adapters are opt-in capabilities.
 *
 * A-01: when the composition installs the authorization-boundary module,
 * every external adapter execution is enforced by the boundary (default
 * deny, fail-closed) — the module picks the gate up from the container.
 */
export class AutonomousActionRuntimeModule implements IModule {
  readonly id = 'autonomous-action-runtime';
  readonly tags = ['autonomy', 'execution', 'governance', 'commercial'] as const;
  readonly dependsOn = ['commercial-control-plane'] as const;
  private service!: ActionRuntimeService;
  private readonly options: ActionRuntimeServiceOptions;

  constructor(options: ActionRuntimeServiceOptions = {}) {
    this.options = options;
  }

  async init(kernel: KernelApi): Promise<void> {
    const controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
    const serviceOptions: ActionRuntimeServiceOptions = {
      ...this.options,
      // A-01: resolve the boundary lazily (post-boot). Module init order is
      // not guaranteed between this module and authorization-boundary, so we
      // must not read the container token at init time. By first execution all
      // modules are initialized, so the token is authoritative if present.
      resolveAuthorizationGate: this.options.authorizationGate
        ? undefined
        : () =>
            kernel.container.has(AUTHORIZATION_GATE_TOKEN)
              ? kernel.container.resolveSync<AuthorizationGate>(AUTHORIZATION_GATE_TOKEN)
              : undefined,
    };
    this.service = new ActionRuntimeService(controlPlane, serviceOptions);
    kernel.container.registerValue('autonomous-action-runtime.service', this.service);
    kernel.container.registerValue('autonomous-action-runtime', this.service);
    kernel.logger.info('autonomous action runtime initialized (no adapters registered; A-01 boundary enforced on external execution when installed)');
  }

  async start(_kernel: KernelApi): Promise<void> {
    // Action execution is explicit; no external work starts during boot.
  }

  async stop(_kernel: KernelApi): Promise<void> {
    // CommercialControlPlaneService owns durable action records.
  }

  getService(): ActionRuntimeService {
    return this.service;
  }
}
